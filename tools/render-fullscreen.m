// Render the single-map fullscreen window offscreen from fixtures. Does not fetch.
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

static BOOL LegendFits(NSView *legend) {
    if (!legend) return NO;
    for (NSView *child in legend.subviews) {
        if (![child isKindOfClass:NSTextField.class]) continue;
        NSTextField *field = (NSTextField *)child;
        if (!field.stringValue.length || !field.font) continue;
        CGFloat need = ceil([field.stringValue sizeWithAttributes:@{NSFontAttributeName: field.font}].width);
        if (field.frame.size.width + 0.5 < need) return NO;
    }
    return YES;
}

static NSData *PNG(NSView *root) {
    NSRect bounds = root.bounds;
    NSInteger wide = (NSInteger)llround(bounds.size.width * 2);
    NSInteger high = (NSInteger)llround(bounds.size.height * 2);
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:wide pixelsHigh:high bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    rep.size = bounds.size;
    [root cacheDisplayInRect:bounds toBitmapImageRep:rep];
    return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "usage: render-fullscreen fullscreen.png [legacy-output.png]\n");
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
        NSView *map = FindID(root, @"window.chart");
        BOOL singleMap = map && !map.hidden && map.frame.size.width > 900 && map.frame.size.height > 400;
        BOOL timeline = FindID(root, @"fullscreen.timeline") != nil;
        BOOL play = FindID(root, @"fullscreen.play") != nil;
        BOOL now = FindID(root, @"fullscreen.now") != nil;
        NSView *header = FindID(root, @"fullscreen.header");
        BOOL headerGone = !header || header.hidden;
        NSView *statusField = FindID(root, @"fullscreen.status");
        NSView *legend = FindID(root, @"chart.legend");
        NSView *statusBar = FindID(root, @"fullscreen.statusBar");
        NSInteger observationButtons = 0;
        for (NSView *child in statusBar.subviews)
            if ([child isKindOfClass:NSButton.class] && child.frame.size.height >= 30) observationButtons++;
        BOOL statusFits = statusField && statusField.frame.origin.x >= 16
            && NSMaxY(statusField.frame) <= NSHeight(statusBar.bounds)
            && HasText(root, @"Perth") && HasText(root, @"Sydney")
            && HasText(root, @"ECMWF 18Z · 6 h ago") && observationButtons >= 2
            && !HasText(root, @"AWST") && !HasText(root, @"+12");
        NSRect legendFrame = legend ? [legend convertRect:legend.bounds toView:statusBar] : NSZeroRect;
        BOOL legendBar = !legend || legend.hidden || NSIsEmptyRect(legend.frame) || (legend.superview == statusBar
            && NSContainsRect(statusBar.bounds, legendFrame)
            && LegendFits(legend)
            && !HasText(root, @"situational awareness")
            && !HasText(root, @"analysis"));
        if (!singleMap || !timeline || !play || !now || !headerGone || !statusFits || !legendBar) {
            fprintf(stderr, "singleMap=%d timeline=%d play=%d now=%d headerGone=%d status=%d buttons=%ld legend=%d map %.0fx%.0f statusX=%.1f legendY=%.1f\n",
                singleMap, timeline, play, now, headerGone, statusFits, (long)observationButtons, legendBar,
                map.frame.size.width, map.frame.size.height, statusField.frame.origin.x, legendFrame.origin.y);
            return 1;
        }
        NSData *fullscreen = PNG(root);
        if (fullscreen.length < 1000 || ![fullscreen writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]) return 1;
        // Keep the optional second path for callers that used the old two-capture
        // harness, but both captures now represent the same single-map surface.
        if (argc >= 3 && ![fullscreen writeToFile:[NSString stringWithUTF8String:argv[2]] atomically:YES]) return 1;

        [c focusFullscreenPanel:-1];
        [root layoutSubtreeIfNeeded];
        [root display];
        NSView *single = FindID(root, @"window.chart");
        NSTextField *timeTitle = (NSTextField *)FindID(root, @"fullscreen.timeTitle");
        BOOL big = single && !single.hidden && single.frame.size.width > 900 && single.frame.size.height > 400;
        BOOL titled = timeTitle.stringValue.length > 0;
        NSView *singleLegend = FindID(root, @"chart.legend");
        NSRect legendInRoot = singleLegend ? [singleLegend convertRect:singleLegend.bounds toView:root] : NSZeroRect;
        NSRect chartInRoot = single ? [single convertRect:single.bounds toView:root] : NSZeroRect;
        BOOL legendStays = singleLegend && singleLegend.superview == FindID(root, @"fullscreen.statusBar")
            && !NSIntersectsRect(legendInRoot, chartInRoot);
        BOOL stillStatus = HasText(root, @"Perth") && HasText(root, @"Sydney");
        if (!big || !titled || !stillStatus || !legendStays || HasText(root, @"analysis")
            || HasText(root, @"AWST") || HasText(root, @"+12")) {
            fprintf(stderr, "single %.0fx%.0f big=%d titled=%d mapOnly=%d status=%d legend=%d title=%s\n",
                single.frame.size.width, single.frame.size.height, big, titled, YES, stillStatus, legendStays,
                timeTitle.stringValue.UTF8String ?: "(nil)");
            return 1;
        }
        NSData *one = PNG(root);
        if (one.length < 1000) return 1;
        printf("wrote %s (%ld bytes), single map %.0fx%.0f; timeline/play/now=%d/%d/%d\n",
            argv[1], (long)fullscreen.length, single.frame.size.width, single.frame.size.height,
            timeline, play, now);
    }
    return 0;
}
