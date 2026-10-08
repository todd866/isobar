// Render the popover with the hazard layer on, offscreen, for review.
// usage: render-hazards STORE OUTPUT_DIRECTORY NAME [PLACE]
// ISOBAR_CHECK_NOW fixes the clock (the playhead opens at now). The window is
// borderless at -20000,-20000 and only ordered back, as in check-app.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

@interface HazardController : Controller
@end
@implementation HazardController
- (NSSize)screenBudget { return NSMakeSize(1440, 900); }
- (NSUserDefaults *)chartPreferences { return nil; }
@end

@interface HazardPopover : NSPopover
@end
@implementation HazardPopover
- (BOOL)isShown { return YES; }
@end

static NSView *Find(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) { NSView *found = Find(child, identifier); if (found) return found; }
    return nil;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 4) {
            fprintf(stderr, "usage: render-hazards STORE OUTPUT_DIRECTORY NAME [PLACE]\n");
            return 64;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *store = [NSString stringWithUTF8String:argv[1]];
        NSString *out = [NSString stringWithUTF8String:argv[2]];
        NSString *name = [NSString stringWithUTF8String:argv[3]];
        NSString *placeName = argc > 4 ? [NSString stringWithUTF8String:argv[4]] : @"Sydney";
        [NSFileManager.defaultManager createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:nil];
        HazardController *c = [HazardController new];
        [c useManualLiveClock];
        [c replaceLocations:DefaultLocations()];
        const char *clock = getenv("ISOBAR_CHECK_NOW");
        NSDate *now = clock ? [[NSISO8601DateFormatter new] dateFromString:@(clock)] : nil;
        if (now) [c setChartNow:now];
        c.hazardLayer = YES;
        c.popover = [HazardPopover new];
        c.popover.animates = NO;
        c.popover.contentViewController = [NSViewController new];
        [c reloadStoreAtPath:store];
        if (![c chartsReady]) { fprintf(stderr, "no chart in %s\n", store.UTF8String); return 1; }
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 1600, 1200)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        [c rebuildContent];
        NSView *content = c.popover.contentViewController.view;
        NSPopUpButton *popup = (NSPopUpButton *)Find(content, @"hub.place");
        for (NSInteger i = 0; i < popup.numberOfItems; i++) {
            if (![popup.itemArray[i].title containsString:placeName]) continue;
            [popup selectItemAtIndex:i];
            [popup sendAction:popup.action to:popup.target];
            break;
        }
        const char *layer = getenv("ISOBAR_HAZARD_LAYER");
        if (layer) [c selectChartLayer:atoi(layer)];
        int failures = 0;
        for (NSString *look in @[@"light", @"dark"]) {
            [c rebuildContent];
            content = c.popover.contentViewController.view;
            NSSize size = content.frame.size;
            [window setContentSize:size];
            window.contentView = content;
            [window orderBack:nil];
            content.appearance = [NSAppearance appearanceNamed:[look isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
            [content layoutSubtreeIfNeeded];
            GPUMapView *gpu = (GPUMapView *)Find(content, @"popover.gpu");
            if (![gpu isKindOfClass:GPUMapView.class]) { fprintf(stderr, "no GPU map\n"); return 1; }
            [gpu waitForUploads];
            // The playhead at ISOBAR_HAZARD_AT, through the popover's own scrub.
            const char *atText = getenv("ISOBAR_HAZARD_AT");
            NSDate *at = atText ? [[NSISO8601DateFormatter new] dateFromString:@(atText)] : nil;
            NSArray<NSDate *> *times = [c valueForKey:@"sequenceTimes"];
            if (at && times.count > 1) {
                double span = [times.lastObject timeIntervalSinceDate:times.firstObject];
                [c inspectPopoverMovieFraction:[at timeIntervalSinceDate:times.firstObject] / span];
                [content layoutSubtreeIfNeeded];
            }
            [gpu waitForHazards];
            CGImageRef shot = [gpu copySnapshot];
            if (!shot) { fprintf(stderr, "no snapshot\n"); return 1; }
            NSImageView *picture = [NSImageView imageViewWithImage:[[NSImage alloc] initWithCGImage:shot size:gpu.bounds.size]];
            picture.frame = gpu.frame;
            picture.imageScaling = NSImageScaleAxesIndependently;
            [gpu.superview addSubview:picture positioned:NSWindowAbove relativeTo:gpu];
            NSView *legend = Find(content, @"chart.legend");
            if (legend) [legend.superview addSubview:legend positioned:NSWindowAbove relativeTo:picture];
            CGImageRelease(shot);
            NSBitmapImageRep *rep = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
            [content cacheDisplayInRect:content.bounds toBitmapImageRep:rep];
            [picture removeFromSuperview];
            NSString *path = [out stringByAppendingPathComponent:
                [NSString stringWithFormat:@"hazards-%@-%@.png", name, look]];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            if (![png writeToFile:path atomically:YES]) failures++;
            const char *hover = getenv("ISOBAR_HAZARD_HOVER");
            double hLat = 0, hLon = 0, hx = 0, hy = 0;
            if (hover && sscanf(hover, "%lf,%lf", &hLat, &hLon) == 2 && IsobarCameraProject(gpu.camera, hLat, hLon, &hx, &hy)) {
                CGFloat s = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
                printf("hover %.2f,%.2f:\n%s\n", hLat, hLon, [[gpu hazardTooltipAtPoint:NSMakePoint(hx / s, hy / s)] UTF8String] ?: "(none)");
            }
            NSArray *labels = gpu.hazardLabels;
            printf("wrote %s (%ldx%ld) step %.2f ready %d root %s labels: %s\n", path.UTF8String, (long)rep.pixelsWide,
                (long)rep.pixelsHigh, gpu.renderedStep, gpu.hazardsReady, gpu.hazardStoreRoot.UTF8String,
                [[labels componentsJoinedByString:@" | "] UTF8String]);
        }
        [window orderOut:nil];
        [window close];
        return failures ? 1 : 0;
    }
}
