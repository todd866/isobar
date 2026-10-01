#import "motion.h"
#import <CoreVideo/CoreVideo.h>

static const size_t kMotionMaxWidth = 580;
static const size_t kMotionMaxHeight = 444;

static NSError *MotionError(NSString *description) {
    return [NSError errorWithDomain:@"IsobarMotion" code:1 userInfo:@{NSLocalizedDescriptionKey: description}];
}

static void MotionSetError(NSString **error, NSError *value) {
    if (error) *error = value.localizedDescription ?: @"Motion interpolation failed";
}

static NSSize MotionSize(NSImage *image) {
    NSSize size = image.size;
    if (size.width < 1 || size.height < 1) {
        NSImageRep *rep = image.representations.firstObject;
        size = NSMakeSize(rep.pixelsWide, rep.pixelsHigh);
    }
    return size;
}

static NSSize BoundedSize(NSSize size) {
    CGFloat scale = MIN(1, MIN((CGFloat)kMotionMaxWidth / size.width,
                               (CGFloat)kMotionMaxHeight / size.height));
    size_t width = MAX((size_t)2, (size_t)floor(size.width * scale + 0.5));
    size_t height = MAX((size_t)2, (size_t)floor(size.height * scale + 0.5));
    return NSMakeSize(width, height);
}

static CVPixelBufferRef MotionPixelBuffer(NSImage *image, NSSize requested, NSError **error) {
    NSSize size = BoundedSize(requested);
    NSDictionary *attributes = @{(id)kCVPixelBufferCGImageCompatibilityKey: @YES,
                                  (id)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES};
    CVPixelBufferRef buffer = NULL;
    CVReturn result = CVPixelBufferCreate(kCFAllocatorDefault, (size_t)size.width, (size_t)size.height,
        kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attributes, &buffer);
    if (result != kCVReturnSuccess || !buffer) {
        if (error) *error = MotionError(@"Could not allocate motion frame buffer");
        return NULL;
    }
    CVPixelBufferLockBaseAddress(buffer, 0);
    void *base = CVPixelBufferGetBaseAddress(buffer);
    size_t rowBytes = CVPixelBufferGetBytesPerRow(buffer);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(base, (size_t)size.width, (size_t)size.height,
        8, rowBytes, colorSpace, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(colorSpace);
    if (!context) {
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        CVPixelBufferRelease(buffer);
        if (error) *error = MotionError(@"Could not create motion frame context");
        return NULL;
    }
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGImageRef source = [image CGImageForProposedRect:NULL context:nil hints:nil];
    if (!source) {
        CGContextRelease(context);
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        CVPixelBufferRelease(buffer);
        if (error) *error = MotionError(@"Could not obtain a CGImage for motion frame");
        return NULL;
    }
    CGContextDrawImage(context, CGRectMake(0, 0, size.width, size.height), source);
    CGContextRelease(context);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    return buffer;
}

static BOOL EqualPixels(CVPixelBufferRef a, CVPixelBufferRef b) {
    if (!a || !b || CVPixelBufferGetWidth(a) != CVPixelBufferGetWidth(b) ||
        CVPixelBufferGetHeight(a) != CVPixelBufferGetHeight(b)) return NO;
    CVPixelBufferLockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferLockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    size_t rows = CVPixelBufferGetHeight(a);
    size_t rowBytes = CVPixelBufferGetWidth(a) * 4;
    BOOL equal = YES;
    for (size_t y = 0; y < rows && equal; y++) {
        const uint8_t *pa = CVPixelBufferGetBaseAddress(a) + y * CVPixelBufferGetBytesPerRow(a);
        const uint8_t *pb = CVPixelBufferGetBaseAddress(b) + y * CVPixelBufferGetBytesPerRow(b);
        equal = memcmp(pa, pb, rowBytes) == 0;
    }
    CVPixelBufferUnlockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferUnlockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    return equal;
}


// The charts have very large jumps between forecast times. Native Vision flow
// often reports zero for these jumps, so use a coarse-to-fine patch search. The
// coarsest level searches up to 192px at chart size; subsequent levels refine
// it. Matching both directions keeps the interpolation symmetric.
typedef struct { int width, height; float *rgb; } MotionLevel;
typedef struct { int columns, rows, step; float *xy; } MotionField;

static MotionLevel MakeLevel(const uint8_t *pixels, size_t stride, int width, int height) {
    MotionLevel level = {width, height, calloc((size_t)width * height * 3, sizeof(float))};
    if (level.rgb) for (int y = 0; y < height; y++) for (int x = 0; x < width; x++)
        for (int c = 0; c < 3; c++) level.rgb[((size_t)y * width + x) * 3 + c] = pixels[(size_t)y * stride + x * 4 + c] / 255.f;
    return level;
}

static MotionLevel HalfLevel(MotionLevel input) {
    int width = (input.width + 1) / 2, height = (input.height + 1) / 2;
    MotionLevel level = {width, height, calloc((size_t)width * height * 3, sizeof(float))};
    if (level.rgb) for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) for (int c = 0; c < 3; c++) {
        float sum = 0;
        for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++)
            sum += input.rgb[((size_t)MIN(input.height - 1, 2 * y + dy) * input.width + MIN(input.width - 1, 2 * x + dx)) * 3 + c];
        level.rgb[((size_t)y * width + x) * 3 + c] = sum / 4;
    }
    return level;
}

static float PatchCost(MotionLevel a, MotionLevel b, int x, int y, int dx, int dy, float stop) {
    float cost = 0;
    // A 9px patch gives thin pressure contours enough context to distinguish
    // their direction while keeping matching local around nearby fronts.
    for (int py = -4; py <= 4; py++) for (int px = -4; px <= 4; px++) {
        int ax = x + px, ay = y + py, bx = ax + dx, by = ay + dy;
        if (ax < 0 || ay < 0 || ax >= a.width || ay >= a.height) continue;
        if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) { cost += 3.f; continue; }
        const float *ap = a.rgb + ((size_t)ay * a.width + ax) * 3;
        const float *bp = b.rgb + ((size_t)by * b.width + bx) * 3;
        for (int c = 0; c < 3; c++) { float d = ap[c] - bp[c]; cost += d * d; }
        if (cost > stop) return cost;
    }
    return cost;
}

static void FieldAt(MotionField field, float x, float y, float *dx, float *dy) {
    float gx = fminf(field.columns - 1, fmaxf(0, x / field.step));
    float gy = fminf(field.rows - 1, fmaxf(0, y / field.step));
    int ix = (int)gx, iy = (int)gy;
    float fx = gx - ix, fy = gy - iy;
    *dx = *dy = 0;
    for (int oy = 0; oy < 2; oy++) for (int ox = 0; ox < 2; ox++) {
        float w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
        const float *p = field.xy + ((size_t)MIN(field.rows - 1, iy + oy) * field.columns + MIN(field.columns - 1, ix + ox)) * 2;
        *dx += w * p[0]; *dy += w * p[1];
    }
}

static MotionField MatchLevels(MotionLevel a, MotionLevel b, MotionField parent, BOOL coarse) {
    int step = coarse ? 1 : 2;
    MotionField field = {(a.width + step - 1) / step, (a.height + step - 1) / step, step, NULL};
    field.xy = calloc((size_t)field.columns * field.rows * 2, sizeof(float));
    if (!field.xy) return field;
    for (int gy = 0; gy < field.rows; gy++) for (int gx = 0; gx < field.columns; gx++) {
        int x = gx * step, y = gy * step;
        float best = PatchCost(a, b, x, y, 0, 0, INFINITY), bestX = 0, bestY = 0;
        // Exact stationary patches stay exact, even beside moving weather ink.
        if (best > 0.00001f) {
            float predX = 0, predY = 0;
            if (!coarse) FieldAt(parent, x / 2.f, y / 2.f, &predX, &predY);
            int cx = (int)lrintf(2 * predX), cy = (int)lrintf(2 * predY);
            int radius = coarse ? 12 : 4;
            for (int dy = cy - radius; dy <= cy + radius; dy++) for (int dx = cx - radius; dx <= cx + radius; dx++) {
                if (x + dx < 0 || x + dx >= b.width || y + dy < 0 || y + dy >= b.height) continue;
                float penalty = 0.000005f * (dx * dx + dy * dy);
                float cost = PatchCost(a, b, x, y, dx, dy, best) + penalty;
                if (cost < best) { best = cost; bestX = dx; bestY = dy; }
            }
        }
        size_t index = ((size_t)gy * field.columns + gx) * 2;
        field.xy[index] = bestX; field.xy[index + 1] = bestY;
    }
    return field;
}

static MotionField DenseMotion(MotionLevel a, MotionLevel b) {
    MotionLevel pa[6] = {a}, pb[6] = {b};
    int count = 1;
    while (count < 6 && (pa[count - 1].width > 40 || pa[count - 1].height > 32)) {
        pa[count] = HalfLevel(pa[count - 1]); pb[count] = HalfLevel(pb[count - 1]);
        if (!pa[count].rgb || !pb[count].rgb) { free(pa[count].rgb); free(pb[count].rgb); break; }
        count++;
    }
    MotionField field = {0};
    for (int level = count - 1; level >= 0; level--) {
        MotionField refined = MatchLevels(pa[level], pb[level], field, level == count - 1);
        free(field.xy); field = refined;
        if (!field.xy) break;
    }
    for (int level = 1; level < count; level++) { free(pa[level].rgb); free(pb[level].rgb); }
    return field;
}

// Bureau charts are ink over a fixed geographical plate. Recover that plate
// from the less inked endpoint at each pixel, then move the changing ink only.
// This avoids warping coastlines or diluting thin lines with splatted background.
static uint8_t *StaticPlate(const uint8_t *a, const uint8_t *b, size_t strideA, size_t strideB, size_t width, size_t height) {
    uint8_t *plate = malloc(width * height * 4);
    if (!plate) return NULL;
    unsigned histogram[256] = {0};
    for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
        const uint8_t *p = a + y * strideA + x * 4;
        histogram[(p[0] + p[1] + p[2]) / 3]++;
    }
    size_t count = 0; int median = 0;
    for (; median < 255; median++) { count += histogram[median]; if (count >= width * height / 2) break; }
    BOOL lightPlate = median >= 128;
    for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
        const uint8_t *ap = a + y * strideA + x * 4, *bp = b + y * strideB + x * 4;
        int al = ap[0] + ap[1] + ap[2], bl = bp[0] + bp[1] + bp[2];
        memcpy(plate + (y * width + x) * 4, ((al > bl) == lightPlate) ? ap : bp, 4);
    }
    return plate;
}


// Patch searches are deliberately local. Average their displacements over
// nearby changing ink before rendering, otherwise each pixel on a thin contour
// can choose a different, equally plausible point along that contour.
static void RegularizeInk(MotionField field, const uint8_t *pixels, size_t stride,
    const uint8_t *plate, size_t width, size_t height) {
    size_t count = width * height;
    float *values = calloc(count * 3, sizeof(float)), *horizontal = calloc(count * 3, sizeof(float));
    if (!values || !horizontal) { free(values); free(horizontal); return; }
    for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
        const uint8_t *p = pixels + y * stride + x * 4, *base = plate + (y * width + x) * 4;
        float weight = MAX(abs(p[0] - base[0]), MAX(abs(p[1] - base[1]), abs(p[2] - base[2]))) / 255.f;
        float dx, dy; FieldAt(field, x, y, &dx, &dy);
        float *v = values + (y * width + x) * 3;
        v[0] = dx * weight; v[1] = dy * weight; v[2] = weight;
    }
    const int radius = 24;
    float kernel[49];
    for (int k = -radius; k <= radius; k++) kernel[k + radius] = expf(-k * k / 200.f);
    for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) for (int k = -radius; k <= radius; k++) {
        NSInteger sx = (NSInteger)x + k;
        if (sx < 0 || sx >= (NSInteger)width) continue;
        for (int c = 0; c < 3; c++) horizontal[(y * width + x) * 3 + c] += values[(y * width + sx) * 3 + c] * kernel[k + radius];
    }
    for (int gy = 0; gy < field.rows; gy++) for (int gx = 0; gx < field.columns; gx++) {
        size_t x = gx * field.step, y = gy * field.step;
        float total[3] = {0};
        for (int k = -radius; k <= radius; k++) {
            NSInteger sy = (NSInteger)y + k;
            if (sy < 0 || sy >= (NSInteger)height) continue;
            for (int c = 0; c < 3; c++) total[c] += horizontal[(sy * width + x) * 3 + c] * kernel[k + radius];
        }
        if (total[2] > 0.01f) {
            size_t i = ((size_t)gy * field.columns + gx) * 2;
            field.xy[i] = total[0] / total[2]; field.xy[i + 1] = total[1] / total[2];
        }
    }
    free(values); free(horizontal);
}

static void MotionReleasePixels(void *info, const void *data, size_t size) {
    (void)info; (void)size; free((void *)data);
}

static NSImage *WarpInk(const uint8_t *a, const uint8_t *b, size_t strideA, size_t strideB,
    const uint8_t *plate, size_t width, size_t height, MotionField forward, MotionField backward, float fraction) {
    float *accum = calloc(width * height * 5, sizeof(float));
    uint8_t *pixels = malloc(width * height * 4);
    if (!accum || !pixels) { free(accum); free(pixels); return nil; }
    for (int source = 0; source < 2; source++) {
        const uint8_t *input = source ? b : a;
        size_t stride = source ? strideB : strideA;
        MotionField flow = source ? backward : forward;
        float blend = source ? fraction : 1 - fraction;
        float travel = source ? 1 - fraction : fraction;
        for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
            const uint8_t *in = input + y * stride + x * 4;
            const uint8_t *base = plate + (y * width + x) * 4;
            int contrast = MAX(abs(in[0] - base[0]), MAX(abs(in[1] - base[1]), abs(in[2] - base[2])));
            if (contrast < 2) continue;
            float dx, dy; FieldAt(flow, x, y, &dx, &dy);
            float px = x + travel * dx, py = y + travel * dy;
            int ix = (int)floorf(px), iy = (int)floorf(py);
            float fx = px - ix, fy = py - iy;
            for (int oy = 0; oy < 2; oy++) for (int ox = 0; ox < 2; ox++) {
                int tx = ix + ox, ty = iy + oy;
                if (tx < 0 || ty < 0 || tx >= (int)width || ty >= (int)height) continue;
                float weight = blend * (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
                float *cell = accum + ((size_t)ty * width + tx) * 5;
                for (int c = 0; c < 4; c++) cell[c] += weight * in[c];
                cell[4] += weight;
            }
        }
    }
    for (size_t i = 0; i < width * height; i++) {
        float *cell = accum + i * 5;
        float alpha = fminf(1, cell[4]);
        for (int c = 0; c < 3; c++) pixels[i * 4 + c] = (uint8_t)lrintf(plate[i * 4 + c] * (1 - alpha) + (cell[4] > 0 ? cell[c] / cell[4] * alpha : 0));
        pixels[i * 4 + 3] = 255;
    }
    free(accum);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, pixels, width * height * 4, MotionReleasePixels);
    if (!provider) { CGColorSpaceRelease(space); free(pixels); return nil; }
    CGImageRef cg = CGImageCreate(width, height, 8, 32, width * 4, space,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false, kCGRenderingIntentDefault);
    CGDataProviderRelease(provider); CGColorSpaceRelease(space);
    if (!cg) return nil;
    NSImage *image = [[NSImage alloc] initWithCGImage:cg size:NSMakeSize(width, height)];
    CGImageRelease(cg);
    return image;
}

NSArray<NSImage *> * _Nullable IsobarMotionFrames(NSImage *from, NSImage *to, NSUInteger intervals, NSString **error) {
    if (error) *error = nil;
    if (!from || !to || intervals < 1) { MotionSetError(error, MotionError(@"Motion frames require two images and at least one interval")); return nil; }
    NSMutableArray<NSImage *> *frames = [NSMutableArray arrayWithCapacity:intervals + 1];
    if (from == to) {
        for (NSUInteger i = 0; i <= intervals; i++) [frames addObject:from];
        return frames;
    }
    NSSize input = MotionSize(from);
    if (input.width < 1 || input.height < 1 || MotionSize(to).width < 1 || MotionSize(to).height < 1) {
        MotionSetError(error, MotionError(@"Motion frame images have no pixels")); return nil;
    }
    NSSize other = MotionSize(to);
    if (fabs(input.width - other.width) > 0.5 || fabs(input.height - other.height) > 0.5) {
        MotionSetError(error, MotionError(@"Motion endpoints must have matching dimensions")); return nil;
    }
    if (intervals == 1) return @[from, to];
    NSError *localError = nil;
    CVPixelBufferRef a = MotionPixelBuffer(from, input, &localError), b = MotionPixelBuffer(to, input, &localError);
    if (!a || !b) { MotionSetError(error, localError); if (a) CVPixelBufferRelease(a); if (b) CVPixelBufferRelease(b); return nil; }
    [frames addObject:from];
    if (EqualPixels(a, b)) {
        for (NSUInteger i = 1; i < intervals; i++) [frames addObject:from];
    } else {
        CVPixelBufferLockBaseAddress(a, kCVPixelBufferLock_ReadOnly); CVPixelBufferLockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
        size_t width = CVPixelBufferGetWidth(a), height = CVPixelBufferGetHeight(a);
        size_t strideA = CVPixelBufferGetBytesPerRow(a), strideB = CVPixelBufferGetBytesPerRow(b);
        const uint8_t *pixelsA = CVPixelBufferGetBaseAddress(a), *pixelsB = CVPixelBufferGetBaseAddress(b);
        MotionLevel la = MakeLevel(pixelsA, strideA, (int)width, (int)height), lb = MakeLevel(pixelsB, strideB, (int)width, (int)height);
        MotionField forward = {0}, backward = {0};
        uint8_t *plate = NULL;
        if (la.rgb && lb.rgb) { forward = DenseMotion(la, lb); backward = DenseMotion(lb, la); plate = StaticPlate(pixelsA, pixelsB, strideA, strideB, width, height); }
        if (forward.xy && backward.xy && plate) {
            RegularizeInk(forward, pixelsA, strideA, plate, width, height);
            RegularizeInk(backward, pixelsB, strideB, plate, width, height);
        }
        if (forward.xy && backward.xy && plate) for (NSUInteger i = 1; i < intervals; i++) {
            NSImage *frame = WarpInk(pixelsA, pixelsB, strideA, strideB, plate, width, height, forward, backward, (float)i / intervals);
            if (!frame) break;
            [frames addObject:frame];
        }
        free(plate); free(forward.xy); free(backward.xy); free(la.rgb); free(lb.rgb);
        CVPixelBufferUnlockBaseAddress(b, kCVPixelBufferLock_ReadOnly); CVPixelBufferUnlockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    }
    CVPixelBufferRelease(a); CVPixelBufferRelease(b);
    if (frames.count != intervals) { MotionSetError(error, MotionError(@"Could not prepare motion frames")); return nil; }
    [frames addObject:to];
    return frames;
}
