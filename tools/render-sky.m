// Offscreen renders of the Fly card (popover and expanded map) and the
// Atmosphere window with the sky section, light and dark, against an archive.
// The web view's picture is composited onto the native capture, which cannot
// see it. No visible windows, no activation, no preferences written.
//   tools/render-sky.sh STORE OUTDIR
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wunused-function"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop
#import <objc/runtime.h>

@interface RenderController : Controller
@end
@implementation RenderController
- (NSSize)screenBudget { return NSMakeSize(1512, 982); }
- (double)backingScale { return 2; }
- (NSUserDefaults *)chartPreferences { return nil; }
- (void)saveLocations {}
- (void)refreshAll {}
@end

static void NoWindowOrder(id self, SEL cmd, id sender) { (void)self; (void)cmd; (void)sender; }
static void NoPopoverShow(id self, SEL cmd, NSRect rect, NSView *view, NSUInteger edge) { (void)self; (void)cmd; (void)rect; (void)view; (void)edge; }
static void NoActivate(id self, SEL cmd, BOOL flag) { (void)self; (void)cmd; (void)flag; }

static void Pump(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}

static NSView *Find(NSView *view, BOOL (^match)(NSView *)) {
    if (match(view)) return view;
    for (NSView *child in view.subviews) { NSView *hit = Find(child, match); if (hit) return hit; }
    return nil;
}

static BOOL ClickLens(NSView *root, NSString *title) {
    NSSegmentedControl *lens = (NSSegmentedControl *)Find(root, ^BOOL(NSView *v) {
        return [v isKindOfClass:NSSegmentedControl.class] && [v.accessibilityIdentifier hasSuffix:@".lens"] && !v.hiddenOrHasHiddenAncestor;
    });
    for (NSInteger i = 0; i < lens.segmentCount; i++) {
        if ([[lens labelForSegment:i] isEqual:title] || [[lens toolTipForSegment:i] hasPrefix:title]) {
            lens.selectedSegment = i;
            [lens sendAction:lens.action to:lens.target];
            Pump(.2);
            return YES;
        }
    }
    return NO;
}

static NSArray<SkySectionView *> *Skies(NSView *root) {
    NSMutableArray *out = [NSMutableArray array];
    void (^__block walk)(NSView *) = nil;
    void (^visit)(NSView *) = ^(NSView *view) {
        if ([view isKindOfClass:SkySectionView.class] && !view.hiddenOrHasHiddenAncestor) [out addObject:view];
        for (NSView *child in view.subviews) walk(child);
    };
    walk = visit;
    visit(root);
    walk = nil;
    return out;
}

// The native capture, then each sky's web picture drawn over its frame.
static BOOL Save(NSView *view, NSString *path) {
    NSArray<SkySectionView *> *skies = Skies(view);
    for (SkySectionView *sky in skies) {
        NSDate *until = [NSDate dateWithTimeIntervalSinceNow:15];
        while (![sky.drawnState count] && until.timeIntervalSinceNow > 0) Pump(.05);
    }
    [view layoutSubtreeIfNeeded];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSGraphicsContext *gc = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    for (SkySectionView *sky in skies) {
        __block NSImage *shot = nil; __block BOOL done = NO;
        [sky snapshotWithCompletion:^(NSImage *image) { shot = image; done = YES; }];
        NSDate *until = [NSDate dateWithTimeIntervalSinceNow:10];
        while (!done && until.timeIntervalSinceNow > 0) Pump(.02);
        if (!shot) { fprintf(stderr, "no sky picture for %s\n", path.UTF8String); continue; }
        NSRect r = [view convertRect:sky.bounds fromView:sky];
        if (view.isFlipped) r.origin.y = NSHeight(view.bounds) - NSMaxY(r);
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext.currentContext = gc;
        [shot drawInRect:r fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
        [NSGraphicsContext restoreGraphicsState];
        printf("%s sky %s %s layers %lu: %s\n", path.lastPathComponent.UTF8String, [sky.drawnState[@"icao"] description].UTF8String,
            [sky.drawnState[@"source"] description].UTF8String, (unsigned long)[sky.drawnState[@"layers"] count], [sky.accessibilityValue description].UTF8String);
    }
    [gc flushGraphics];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return [png writeToFile:path atomically:YES];
}

static NSWindow *Offscreen(NSView *content, NSSize size) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-30000, -30000, size.width, size.height)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.sharingType = NSWindowSharingNone;
    window.ignoresMouseEvents = YES;
    window.contentView = content;
    return window;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 3) { fprintf(stderr, "usage: render-sky STORE OUTDIR\n"); return 64; }
        NSString *out = @(argv[2]);
        [NSFileManager.defaultManager createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:nil];
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(makeKeyAndOrderFront:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSPopover.class, @selector(showRelativeToRect:ofView:preferredEdge:)), (IMP)NoPopoverShow);
        method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:)), (IMP)NoActivate);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        RenderController *c = [RenderController new];
        [c useManualLiveClock];
        [c replaceLocations:DefaultLocations()];
        [c reloadStoreAtPath:@(argv[1])];
        if (![c chartsReady]) { fprintf(stderr, "chart unavailable\n"); return 1; }
        [c rebuildContent]; Pump(.3);
        int failures = 0;
        for (NSString *appearance in @[@"light", @"dark"]) {
            NSAppearance *look = [NSAppearance appearanceNamed:[appearance isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
            NSApp.appearance = look;
            // The popover, hosted in an offscreen window so its web view loads.
            [c rebuildContent]; Pump(.2);
            NSView *popover = c.popover.contentViewController.view;
            ClickLens(popover, @"Fly"); Pump(.2);
            popover = c.popover.contentViewController.view;
            NSWindow *host = Offscreen(popover, popover.frame.size);
            host.appearance = look;
            [host orderFrontRegardless];
            Pump(.5);
            if (!Save(popover, [out stringByAppendingPathComponent:[NSString stringWithFormat:@"fly-popover-%@.png", appearance]])) failures++;
            ClickLens(popover, @"Pressure");
            [host orderOut:nil];
            host.contentView = [NSView new];
            [c rebuildContent]; Pump(.2);
            // The expanded map's Fly card.
            [c presentChartWindowInFrame:NSMakeRect(-30000, -30000, 1512, 982)];
            c.chartWindow.appearance = look;
            Pump(.3);
            ClickLens(c.chartWindow.contentView, @"Fly"); Pump(.5);
            NSView *card = Find(c.chartWindow.contentView, ^BOOL(NSView *v) { return [v isKindOfClass:AviationLensView.class] && !v.hiddenOrHasHiddenAncestor; });
            NSView *surface = card.superview ?: c.chartWindow.contentView;
            if (!card || !Save(surface, [out stringByAppendingPathComponent:[NSString stringWithFormat:@"fly-expanded-card-%@.png", appearance]]))
                failures++;
            if (!Save(c.chartWindow.contentView, [out stringByAppendingPathComponent:[NSString stringWithFormat:@"fly-expanded-%@.png", appearance]])) failures++;
            ClickLens(c.chartWindow.contentView, @"Pressure");
            [c closeChartWindow];
            // The Atmosphere window.
            AtmosphereView *atmosphere = [c prepareAtmosphere];
            NSWindow *window = [c valueForKey:@"atmosphereWindow"];
            [window setFrame:NSMakeRect(-30000, -30000, 980, 620) display:NO];
            window.appearance = look;
            [window orderFrontRegardless];
            Pump(.5);
            if (!Save(atmosphere, [out stringByAppendingPathComponent:[NSString stringWithFormat:@"atmosphere-%@.png", appearance]])) failures++;
            [window orderOut:nil];
        }
        [c stopPopoverPlayback];
        printf("render failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
