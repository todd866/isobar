// Render the hub popover offscreen. Does not create a status item or a window.
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

static NSBitmapImageRep *RetinaRep(NSView *root) {
    [root layoutSubtreeIfNeeded];
    [root display];
    NSRect bounds = root.bounds;
    NSInteger wide = (NSInteger)llround(bounds.size.width * 2);
    NSInteger high = (NSInteger)llround(bounds.size.height * 2);
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:wide pixelsHigh:high bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    rep.size = bounds.size;
    [root cacheDisplayInRect:bounds toBitmapImageRep:rep];
    return rep;
}

static BOOL WritePNG(NSView *root, NSString *path) {
    NSData *png = [RetinaRep(root) representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return png.length > 1000 && [png writeToFile:path atomically:YES];
}

static double CornerLuma(NSView *root) {
    NSBitmapImageRep *rep = RetinaRep(root);
    NSColor *color = [[rep colorAtX:8 y:(NSInteger)rep.pixelsHigh - 12] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    if (!color) return 1;
    return 0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "usage: render-popover OUTPUT_DIRECTORY\n");
            return 64;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *dir = [NSString stringWithUTF8String:getenv("ISOBAR_FIXTURES") ?: "Tests/fixtures"];
        NSString *out = [NSString stringWithUTF8String:argv[1]];
        [NSFileManager.defaultManager createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:nil];
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        NSDate *now = [iso dateFromString:@"2026-09-26T00:30:00Z"];
        Controller *c = [Controller new];
        [c replaceLocations:DefaultLocations()];
        [c setChartNow:now];
        [c reloadStoreAtPath:[dir stringByAppendingPathComponent:@"store"]];
        NSArray *places = @[@"Perth", @"Sydney"];
        NSArray *appearances = @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua];
        NSArray *labels = @[@"light", @"dark"];
        for (NSString *placeName in places) {
            [c rebuildContent];
            NSPopUpButton *popup = (NSPopUpButton *)FindID(c.popover.contentViewController.view, @"hub.place");
            NSInteger index = -1;
            for (NSInteger i = 0; i < popup.numberOfItems; i++)
                if ([popup.itemArray[i].title containsString:placeName]) index = i;
            if (index < 0) { fprintf(stderr, "missing place %s\n", placeName.UTF8String); return 1; }
            [popup selectItemAtIndex:index];
            [popup sendAction:popup.action to:popup.target];
            NSView *root = c.popover.contentViewController.view;
            NSView *map = FindID(root, @"popover.chart");
            NSView *days = FindID(root, @"hub.days");
            NSView *timeline = FindID(root, @"popover.timeline");
            NSView *lenses = FindID(root, @"popover.forecastMode");
            NSButton *temp = (NSButton *)FindID(root, @"popover.obs");
            BOOL hub = map && !map.hidden && map.frame.size.width >= 400 && days && timeline && lenses &&
                temp && [temp.attributedTitle.string containsString:@"°"] &&
                !FindID(root, @"forecast.back") && FindID(root, @"hub.day.0");
            if (!hub) {
                fprintf(stderr, "%s map %.0fx%.0f days=%d timeline=%d lenses=%d temp=%s\n",
                    placeName.UTF8String, map.frame.size.width, map.frame.size.height,
                    days != nil, timeline != nil, lenses != nil, temp.attributedTitle.string.UTF8String ?: "");
                return 1;
            }
            for (NSUInteger i = 0; i < appearances.count; i++) {
                root.appearance = [NSAppearance appearanceNamed:appearances[i]];
                NSString *path = [out stringByAppendingPathComponent:
                    [NSString stringWithFormat:@"popover-%@-%@.png", placeName.lowercaseString, labels[i]]];
                if (!WritePNG(root, path)) return 1;
                printf("wrote %s (%.0fx%.0f, map %.0fx%.0f)\n", path.UTF8String,
                    root.bounds.size.width, root.bounds.size.height, map.frame.size.width, map.frame.size.height);
            }
        }
        [c presentChartWindowInFrame:NSMakeRect(0, 0, 1470, 956)];
        for (NSString *placeName in places) {
            NSPopUpButton *popup = (NSPopUpButton *)FindID(c.popover.contentViewController.view, @"hub.place");
            for (NSInteger i = 0; i < popup.numberOfItems; i++) {
                if (![popup.itemArray[i].title containsString:placeName]) continue;
                [popup selectItemAtIndex:i];
                [popup sendAction:popup.action to:popup.target];
            }
            [c layoutChartWindow];
            NSView *surface = c.chartWindow.contentView;
            NSView *map = FindID(surface, @"window.chart");
            NSView *days = FindID(surface, @"hub.days");
            NSPopUpButton *fullPlace = (NSPopUpButton *)FindID(surface, @"fullscreen.place");
            NSButton *temperature = (NSButton *)FindID(surface, @"fullscreen.temperature");
            BOOL ok = map && map.frame.size.width > 900 && map.frame.size.height > 400 &&
                days && days.frame.size.width > days.frame.size.height &&
                FindID(surface, @"fullscreen.timeline") && FindID(surface, @"fullscreen.lens.rain") &&
                (!FindID(surface, @"fullscreen.header") || FindID(surface, @"fullscreen.header").hidden) &&
                [fullPlace.titleOfSelectedItem containsString:placeName] &&
                [temperature.attributedTitle.string containsString:@"°"];
            if (!ok) {
                fprintf(stderr, "fullscreen %s map %.0fx%.0f strip=%d place=%s temp=%s\n", placeName.UTF8String,
                    map.frame.size.width, map.frame.size.height, days != nil,
                    fullPlace.titleOfSelectedItem.UTF8String ?: "",
                    temperature.attributedTitle.string.UTF8String ?: "");
                return 1;
            }
            for (NSUInteger i = 0; i < appearances.count; i++) {
                surface.appearance = [NSAppearance appearanceNamed:appearances[i]];
                if ([labels[i] isEqual:@"dark"] && CornerLuma(surface) > 0.45) {
                    fprintf(stderr, "fullscreen %s dark backdrop is still light\n", placeName.UTF8String);
                    return 1;
                }
                NSString *path = [out stringByAppendingPathComponent:
                    [NSString stringWithFormat:@"fullscreen-%@-%@.png", placeName.lowercaseString, labels[i]]];
                if (!WritePNG(surface, path)) return 1;
                printf("wrote %s map %.0fx%.0f\n", path.UTF8String, map.frame.size.width, map.frame.size.height);
            }
        }
        [c closeChartWindow];
    }
    return 0;
}
