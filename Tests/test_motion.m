#import <AppKit/AppKit.h>
#import "../Sources/motion.h"

static NSImage *TestImage(NSPoint objectOrigin) {
    const size_t width = getenv("ISOBAR_MOTION_LARGE") ? 580 : 256;
    const size_t height = getenv("ISOBAR_MOTION_LARGE") ? 435 : 128;
    CGFloat scale = (CGFloat)width / 256.0;
    size_t bytes = width * height * 4;
    uint8_t *pixels = calloc(1, bytes);
    for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
        uint8_t *p = pixels + (y * width + x) * 4;
        p[0] = 20; p[1] = 28; p[2] = 36; p[3] = 255;
    }
    NSInteger ox = (NSInteger)llround(objectOrigin.x * scale), oy = (NSInteger)llround(objectOrigin.y * scale);
    NSInteger objectWidth = (NSInteger)llround(30 * scale), objectHeight = (NSInteger)llround(24 * scale);
    for (NSInteger y = oy; y < oy + objectHeight; y++) for (NSInteger x = ox; x < ox + objectWidth; x++) {
        if (x < 0 || y < 0 || x >= (NSInteger)width || y >= (NSInteger)height) continue;
        uint8_t *p = pixels + (y * width + x) * 4;
        p[0] = 235; p[1] = (uint8_t)(40 + (x - ox) * 4); p[2] = (uint8_t)(45 + (y - oy) * 5); p[3] = 255;
        if ((x - ox) % MAX(1, (NSInteger)llround(7 * scale)) == 0 || (y - oy) % MAX(1, (NSInteger)llround(6 * scale)) == 0) { p[0] = 250; p[1] = 220; p[2] = 55; }
    }
    // A stationary landmark exercises the static geography path while the red
    // feature moves between endpoints.
    NSInteger landmarkLeft = (NSInteger)llround(150 * scale), landmarkTop = (NSInteger)llround(16 * scale);
    for (NSInteger y = landmarkTop; y < landmarkTop + (NSInteger)llround(14 * scale); y++) for (NSInteger x = landmarkLeft; x < landmarkLeft + (NSInteger)llround(16 * scale); x++) {
        uint8_t *p = pixels + (y * width + x) * 4;
        p[0] = 35; p[1] = 220; p[2] = 95; p[3] = 255;
    }
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels, width, height, 8, width * 4, space,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(space);
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    free(pixels);
    NSImage *result = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(width, height)];
    CGImageRelease(image);
    return result;
}

static NSBitmapImageRep *Bitmap(NSImage *image) {
    CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cg) return nil;
    return [[NSBitmapImageRep alloc] initWithCGImage:cg];
}

static NSInteger RedCentroid(NSImage *image) {
    NSBitmapImageRep *rep = Bitmap(image);
    double weighted = 0, total = 0;
    for (NSInteger y = 0; y < rep.pixelsHigh; y++) for (NSInteger x = 0; x < rep.pixelsWide; x++) {
        NSColor *c = [rep colorAtX:x y:y];
        double weight = MAX(0, c.redComponent - c.blueComponent);
        weighted += x * weight; total += weight;
    }
    return total > 0 ? (NSInteger)llround(weighted / total) : -1;
}

static double RedMassIn(NSImage *image, NSInteger left, NSInteger right) {
    NSBitmapImageRep *rep = Bitmap(image);
    double mass = 0;
    CGFloat scale = getenv("ISOBAR_MOTION_LARGE") ? 580.0 / 256.0 : 1.0;
    for (NSInteger y = 30 * scale; y < MIN(rep.pixelsHigh, 75 * scale); y++) for (NSInteger x = MAX(0, left); x < MIN(rep.pixelsWide, right); x++) {
        NSColor *c = [rep colorAtX:x y:y];
        mass += MAX(0, c.redComponent - c.blueComponent);
    }
    return mass;
}

typedef struct { double x, y, r, g, b, weight; } GreenStats;
static GreenStats LandmarkStats(NSImage *image) {
    NSBitmapImageRep *rep = Bitmap(image);
    GreenStats stats = {0};
    CGFloat scale = getenv("ISOBAR_MOTION_LARGE") ? 580.0 / 256.0 : 1.0;
    for (NSInteger y = 0; y < rep.pixelsHigh; y++) for (NSInteger x = 0; x < rep.pixelsWide; x++) {
        if (x < 140 * scale) continue;
        NSColor *c = [rep colorAtX:x y:y];
        double weight = MAX(0, c.greenComponent - MAX(c.redComponent, c.blueComponent));
        stats.x += x * weight; stats.y += y * weight;
        stats.r += c.redComponent * weight; stats.g += c.greenComponent * weight; stats.b += c.blueComponent * weight;
        stats.weight += weight;
    }
    if (stats.weight > 0) { stats.x /= stats.weight; stats.y /= stats.weight; stats.r /= stats.weight; stats.g /= stats.weight; stats.b /= stats.weight; }
    return stats;
}

static BOOL SavePNG(NSImage *image, NSString *path) {
    NSBitmapImageRep *rep = Bitmap(image);
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return [png writeToFile:path atomically:YES];
}

static void Check(BOOL condition, NSString *message, int *failures) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); (*failures)++; }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        int failures = 0;
        if (argc == 3) {
            NSImage *start = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]];
            NSImage *end = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
            NSString *message = nil;
            NSDate *time = [NSDate date];
            NSArray<NSImage *> *result = IsobarMotionFrames(start, end, 24, &message);
            if (!result) { fprintf(stderr, "real-pair motion failed: %s\n", message.UTF8String); return 1; }
            NSString *directory = @"/private/tmp/isobar-real-motion-qa";
            [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
            for (NSUInteger i = 0; i < result.count; i++) SavePNG(result[i], [directory stringByAppendingPathComponent:[NSString stringWithFormat:@"%02lu.png", (unsigned long)i]]);
            printf("real-pair frames=%lu seconds=%.2f output=%s\n", (unsigned long)result.count, -time.timeIntervalSinceNow, directory.UTF8String);
            return 0;
        }
        NSImage *from = TestImage(NSMakePoint(38, 38));
        NSImage *to = TestImage(NSMakePoint(98, 38));
        NSString *error = nil;
        NSArray<NSImage *> *frames = IsobarMotionFrames(from, to, 24, &error);
        if (!frames) {
            fprintf(stderr, "motion unavailable: %s\n", error.UTF8String ?: "unknown error");
            NSArray<NSImage *> *staticFrames = IsobarMotionFrames(from, from, 8, &error);
            Check(staticFrames.count == 9, @"static sequence must preserve interval count", &failures);
            for (NSImage *frame in staticFrames) Check(frame == from, @"static geography must reuse exact endpoint pixels", &failures);
            error = nil;
            Check(IsobarMotionFrames(from, to, 0, &error) == nil && error.length > 0, @"zero intervals must fail clearly", &failures);
            error = nil;
            Check(IsobarMotionFrames(nil, to, 4, &error) == nil && error.length > 0, @"missing input must fail clearly", &failures);
            printf("motion test blocked translated-shape assertions; failures: %d\n", failures);
            return 1;
        }
        Check(frames.count == 25, @"24 intervals must produce 25 frames", &failures);
        Check(frames.firstObject == from && frames.lastObject == to, @"endpoints must be returned unchanged", &failures);
        CGFloat scale = getenv("ISOBAR_MOTION_LARGE") ? 580.0 / 256.0 : 1.0;
        NSInteger startX = RedCentroid(from), endX = RedCentroid(to), midX = RedCentroid(frames[12]);
        NSBitmapImageRep *initial = Bitmap(from);
        double previousCenter = startX;
        for (NSUInteger frameIndex = 1; frameIndex < frames.count; frameIndex++) {
            NSBitmapImageRep *frame = Bitmap(frames[frameIndex]);
            Check(frame.pixelsWide == initial.pixelsWide && frame.pixelsHigh == initial.pixelsHigh, @"frame dimensions changed", &failures);
            double center = RedCentroid(frames[frameIndex]);
            double expectedCenter = startX + (endX - startX) * (double)frameIndex / 24;
            Check(center >= previousCenter && fabs(center - expectedCenter) <= 1.5, @"motion is not uniformly spaced and monotonic", &failures);
            previousCenter = center;
            BOOL landmarkExact = YES;
            for (NSInteger y = 15 * scale; y < 31 * scale; y++) for (NSInteger x = 149 * scale; x < 167 * scale; x++) {
                NSColor *original = [initial colorAtX:x y:y], *actualColor = [frame colorAtX:x y:y];
                if (fabs(original.redComponent - actualColor.redComponent) > 0.005 || fabs(original.greenComponent - actualColor.greenComponent) > 0.005 || fabs(original.blueComponent - actualColor.blueComponent) > 0.005) landmarkExact = NO;
            }
            Check(landmarkExact, @"stationary landmark pixels changed", &failures);
        }
        printf("object centroid start=%ld mid=%ld end=%ld\n", (long)startX, (long)midX, (long)endX);
        Check(midX > startX + 15 * scale && midX < endX - 15 * scale, @"middle frame did not move the object between endpoints", &failures);
        Check(abs((int)(midX - (startX + endX) / 2)) < 15 * scale, @"middle frame is not near the midpoint", &failures);
        double startMass = RedMassIn(frames[12], 30 * scale, 70 * scale);
        double middleMass = RedMassIn(frames[12], 65 * scale, 105 * scale);
        double endMass = RedMassIn(frames[12], 95 * scale, 135 * scale);
        double totalMass = RedMassIn(from, 20 * scale, 145 * scale);
        printf("red mass start=%.1f middle=%.1f end=%.1f total=%.1f\n", startMass, middleMass, endMass, totalMass);
        Check(middleMass > totalMass * 0.75, @"middle frame has insufficient mass at the interpolated object", &failures);
        Check(startMass < totalMass * 0.12 && endMass < totalMass * 0.12, @"middle frame retains endpoint ghost objects", &failures);
        GreenStats landmark = LandmarkStats(frames[12]), landmarkStart = LandmarkStats(from);
        printf("landmark start=(%.1f,%.1f %.2f,%.2f,%.2f) mid=(%.1f,%.1f %.2f,%.2f,%.2f)\n", landmarkStart.x, landmarkStart.y, landmarkStart.r, landmarkStart.g, landmarkStart.b, landmark.x, landmark.y, landmark.r, landmark.g, landmark.b);
        Check(fabs(landmark.x - landmarkStart.x) < 0.5 && fabs(landmark.y - landmarkStart.y) < 0.5 &&
            fabs(landmark.g - landmarkStart.g) < 0.02 && landmark.weight > landmarkStart.weight * 0.95, @"stationary landmark changed during interpolation", &failures);
        NSImage *expectedMid = TestImage(NSMakePoint(68, 38));
        NSBitmapImageRep *actual = Bitmap(frames[12]), *expected = Bitmap(expectedMid);
        double shapeError = 0; NSUInteger shapePixels = 0;
        for (NSInteger y = 38 * scale; y < 62 * scale; y++) for (NSInteger x = 68 * scale; x < 98 * scale; x++) {
            NSColor *ac = [actual colorAtX:x y:y], *ec = [expected colorAtX:x y:y];
            shapeError += fabs(ac.redComponent - ec.redComponent) + fabs(ac.greenComponent - ec.greenComponent) + fabs(ac.blueComponent - ec.blueComponent);
            shapePixels++;
        }
        shapeError /= 3 * shapePixels;
        printf("translated rectangle mean channel error %.4f\n", shapeError);
        Check(shapeError < 0.08, @"translated rectangle lost its shape, texture or color", &failures);
        NSString *qa = @"/private/tmp/isobar-motion-qa";
        [NSFileManager.defaultManager createDirectoryAtPath:qa withIntermediateDirectories:YES attributes:nil error:nil];
        SavePNG(from, [qa stringByAppendingPathComponent:@"from.png"]);
        SavePNG(frames[12], [qa stringByAppendingPathComponent:@"mid.png"]);
        SavePNG(to, [qa stringByAppendingPathComponent:@"to.png"]);

        NSArray<NSImage *> *staticFrames = IsobarMotionFrames(from, from, 8, &error);
        Check(staticFrames.count == 9, @"static sequence must preserve interval count", &failures);
        for (NSImage *frame in staticFrames) Check(frame == from, @"static geography must reuse exact endpoint pixels", &failures);

        NSImage *samePixels = TestImage(NSMakePoint(38, 38));
        NSArray<NSImage *> *sameFrames = IsobarMotionFrames(from, samePixels, 4, &error);
        Check(sameFrames.count == 5 && sameFrames.firstObject == from && sameFrames.lastObject == samePixels, @"distinct identical endpoints must preserve identity", &failures);
        NSArray<NSImage *> *single = IsobarMotionFrames(from, to, 1, &error);
        Check(single.count == 2 && single[0] == from && single[1] == to, @"one interval must return the exact endpoints", &failures);
        error = nil;
        Check(IsobarMotionFrames(from, to, 0, &error) == nil && error.length > 0, @"zero intervals must fail clearly", &failures);
        error = nil;
        Check(IsobarMotionFrames(nil, to, 4, &error) == nil && error.length > 0, @"missing input must fail clearly", &failures);
        printf("motion test failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
