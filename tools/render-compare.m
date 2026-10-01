// Palette check on the single fullscreen map, then the previous-issue crossfade.
// usage: render-compare compare.png
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

static NSView *FindID(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) {
        NSView *hit = FindID(child, identifier);
        if (hit) return hit;
    }
    return nil;
}

static BOOL HasText(NSView *view, NSString *text) {
    if ([view isKindOfClass:NSTextField.class] && [((NSTextField *)view).stringValue containsString:text]) return YES;
    for (NSView *child in view.subviews) if (HasText(child, text)) return YES;
    return NO;
}

static NSBitmapImageRep *BitmapOf(NSView *view) {
    NSRect bounds = view.bounds;
    NSInteger wide = (NSInteger)MAX(1, llround(bounds.size.width * 2.0));
    NSInteger high = (NSInteger)MAX(1, llround(bounds.size.height * 2.0));
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:wide pixelsHigh:high bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    rep.size = bounds.size;
    [view cacheDisplayInRect:bounds toBitmapImageRep:rep];
    CGImageRef image = rep.CGImage;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, (size_t)wide, (size_t)high, 8, (size_t)wide * 4, cs,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(cs);
    CGContextDrawImage(ctx, CGRectMake(0, 0, wide, high), image);
    CGImageRef converted = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    NSBitmapImageRep *srgb = [[NSBitmapImageRep alloc] initWithCGImage:converted];
    CGImageRelease(converted);
    srgb.size = bounds.size;
    return srgb;
}

static int ChannelNear(const uint8_t *p, int r, int g, int b) {
    return abs(p[0] - r) <= 8 && abs(p[1] - g) <= 8 && abs(p[2] - b) <= 8;
}

static BOOL PaletteOK(NSBitmapImageRep *rep) {
    const uint8_t *bytes = rep.bitmapData;
    if (!bytes) return NO;
    NSInteger wide = rep.pixelsWide, high = rep.pixelsHigh, row = rep.bytesPerRow;
    NSInteger sea = 0, land = 0, title = 0, dark = 0, samples = 0;
    for (NSInteger y = 0; y < high; y += 2) {
        for (NSInteger x = 0; x < wide; x += 2) {
            const uint8_t *p = bytes + y * row + x * 4;
            samples++;
            if (ChannelNear(p, 0xeb, 0xf1, 0xf7)) sea++;
            else if (ChannelNear(p, 0xf4, 0xee, 0xaf)) land++;
            else if (ChannelNear(p, 0x03, 0x6d, 0x9b)) title++;
            else if (ChannelNear(p, 0x0e, 0x14, 0x1c) || ChannelNear(p, 0x9e, 0x80, 0x3d)
                || ChannelNear(p, 0xed, 0xe8, 0xd4) || ChannelNear(p, 0x4d, 0xc7, 0x6b))
                dark++;
        }
    }
    printf("panel samples=%ld sea=%ld land=%ld title=%ld dark-theme=%ld\n",
        (long)samples, (long)sea, (long)land, (long)title, (long)dark);
    // The single-map surface has no prognosis title bar. Temperature shading
    // still needs to expose both land and sea regions in the rendered map.
    (void)title;
    return sea > samples / 20 && land > samples / 40 && dark * 20 < samples;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "usage: render-compare compare.png\n");
            return 64;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *dir = [NSString stringWithUTF8String:getenv("ISOBAR_FIXTURES") ?: "Tests/fixtures"];
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        Controller *c = [Controller new];
        [c replaceLocations:DefaultLocations()];
        [c setChartNow:[iso dateFromString:@"2026-09-26T00:30:00Z"]];
        [c reloadStoreAtPath:[dir stringByAppendingPathComponent:@"store"]];
        [c presentChartWindowInFrame:NSMakeRect(0, 0, 1470, 956)];
        NSView *root = c.chartWindow.contentView;
        [root layoutSubtreeIfNeeded];
        [root display];
        NSView *prognosis = FindID(root, @"window.chart");
        if (!prognosis || prognosis.hidden || prognosis.frame.size.width < 900) {
            fprintf(stderr, "single fullscreen map missing\n");
            return 1;
        }
        if (!PaletteOK(BitmapOf(prognosis))) {
            fprintf(stderr, "chart colours do not match the ECMWF panel\n");
            return 1;
        }

        [c toggleIssueCompare];
        [root layoutSubtreeIfNeeded];
        [root display];
        if (!HasText(root, @"vs previous") || HasText(root, @"no earlier issue")) {
            fprintf(stderr, "the opening frame should compare with the previous run\n");
            return 1;
        }

        // Keep the unavailable-frame regression without assuming that a
        // particular forecast index is uncovered by the previous issue.
        [c toggleIssueCompare];
        NSArray *times = [c valueForKey:@"sequenceTimes"];
        NSInteger available = -1, unavailable = -1;
        for (NSInteger i = 0; i < (NSInteger)times.count; i++) {
            if ([c earlierIssueForIndex:i] >= 0 && available < 0) available = i;
            if ([c earlierIssueForIndex:i] < 0 && unavailable < 0) unavailable = i;
        }
        if (unavailable >= 0) {
            [c focusFullscreenPanel:unavailable];
            [c toggleIssueCompare];
            [root layoutSubtreeIfNeeded];
            [root display];
            if (!HasText(root, @"no earlier issue")) {
                fprintf(stderr, "an uncovered frame should say that no earlier issue exists\n");
                return 1;
            }
            [c toggleIssueCompare];
        }

        NSView *single = FindID(root, @"window.chart");
        if (available >= 0) [c focusFullscreenPanel:available];
        [c toggleIssueCompare];
        if (!single || single.frame.size.width < 900 || !HasText(root, @"vs previous") || HasText(root, @"no earlier issue")) {
            fprintf(stderr, "compare frame missing (%.0fx%.0f)\n", single.frame.size.width, single.frame.size.height);
            return 1;
        }
        NSBitmapImageRep *frame = BitmapOf(root);
        NSData *png = [frame representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (png.length < 1000 || ![png writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]) return 1;
        printf("wrote %s (%ld x %ld)\n", argv[1], (long)frame.pixelsWide, (long)frame.pixelsHigh);
    }
    return 0;
}
