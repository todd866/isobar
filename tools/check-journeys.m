// User journeys, offscreen, against a real or fixture archive. Each journey is
// what a person does (docs/design/user-journeys.md); after every step the view
// and the forecast time must be what they expect. Never orders a window,
// activates the app or writes preferences.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wunused-function"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

#import <objc/runtime.h>

@interface JourneyController : Controller
@end
@implementation JourneyController
- (NSSize)screenBudget { return NSMakeSize(1512, 982); }
- (double)backingScale { return 1; }
- (NSUserDefaults *)chartPreferences { return nil; }
- (void)saveLocations {}
- (void)refreshAll {}
@end

static void NoWindowOrder(id self, SEL cmd, id sender) { (void)self; (void)cmd; (void)sender; }
static void NoOrderWindow(id self, SEL cmd, NSInteger place, NSInteger relative) { (void)self; (void)cmd; (void)place; (void)relative; }
static void NoPopoverShow(id self, SEL cmd, NSRect rect, NSView *view, NSUInteger edge) { (void)self; (void)cmd; (void)rect; (void)view; (void)edge; }
static void NoActivate(id self, SEL cmd, BOOL flag) { (void)self; (void)cmd; (void)flag; }

static NSView *Find(NSView *view, BOOL (^match)(NSView *)) {
    if (match(view)) return view;
    for (NSView *child in view.subviews) { NSView *hit = Find(child, match); if (hit) return hit; }
    return nil;
}

static void Pump(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}

static int failures = 0;
static NSString *journey = @"";
#define EXPECT(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s: ", journey.UTF8String); \
    fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static GPUMapView *Map(Controller *c) { return [c valueForKey:@"gpuMap"]; }

static NSSegmentedControl *LensControl(NSView *root) {
    return (NSSegmentedControl *)Find(root, ^BOOL(NSView *v) {
        return [v isKindOfClass:NSSegmentedControl.class] && [v.accessibilityIdentifier hasSuffix:@".lens"] && !v.hiddenOrHasHiddenAncestor;
    });
}

// What a click on a lens does: select the segment and send its action.
static BOOL ClickLens(NSView *root, NSString *title) {
    NSSegmentedControl *lens = LensControl(root);
    for (NSInteger i = 0; i < lens.segmentCount; i++) {
        NSString *tip = [lens toolTipForSegment:i] ?: @"";
        NSString *label = [lens labelForSegment:i] ?: @"";
        if ([label isEqual:title] || [tip hasPrefix:title]) {
            lens.selectedSegment = i;
            [lens sendAction:lens.action to:lens.target];
            Pump(.15);
            return YES;
        }
    }
    return NO;
}

static BOOL SameView(IsobarCamera a, IsobarCamera b) {
    double dLon = fabs(fmod(a.centreLon - b.centreLon + 540.0, 360.0) - 180.0);
    return fabs(a.centreLat - b.centreLat) < 0.05 && dLon < 0.05 && fabs(log(a.zoom / b.zoom)) < 0.01;
}

static NSString *Describe(IsobarCamera c) {
    return [NSString stringWithFormat:@"%.2f,%.2f z%.2f", c.centreLat, c.centreLon, c.zoom];
}

static BOOL PlaceOnScreen(GPUMapView *map) {
    NSRect marker = map.placeMarkerFrame;
    return !NSIsEmptyRect(marker) && NSContainsRect(NSInsetRect(map.bounds, -2, -2), marker);
}

// The user's trackpad: pinch in at the place marker.
static void ZoomInOnPlace(GPUMapView *map, double factor) {
    NSRect marker = map.placeMarkerFrame;
    NSPoint at = NSMakePoint(NSMidX(marker), NSMidY(marker));
    for (int i = 0; i < 8; i++) [map pinchFactor:pow(factor, 1.0 / 8) atPoint:at];
    Pump(.1);
}

static void Drag(GPUMapView *map, double dx, double dy) {
    NSPoint start = NSMakePoint(NSMidX(map.bounds), NSMidY(map.bounds));
    [map pointerDown:start];
    for (int i = 1; i <= 6; i++) [map pointerDrag:NSMakePoint(start.x + dx * i / 6, start.y + dy * i / 6)];
    [map pointerUp:NSMakePoint(start.x + dx, start.y + dy)];
    Pump(.1);
}

static NSArray<NSString *> *Lenses(void) { return @[@"Rain", @"Wind", @"Temp", @"Kite", @"Surf", @"Fly", @"Pressure"]; }

static void Journeys(JourneyController *c, NSView *(^root)(void), NSString *surface) {
    GPUMapView *map = Map(c);
    if (!map) { fprintf(stderr, "SKIP %s journeys: no Metal map\n", surface.UTF8String); return; }

    journey = [surface stringByAppendingString:@" J1 glance"];
    EXPECT(PlaceOnScreen(map), "selected place is off screen after open (%s)", Describe(map.camera).UTF8String);
    NSDate *opened = [c selectedForecastDate];
    EXPECT(opened && fabs([opened timeIntervalSinceDate:[c valueForKey:@"chartNow"] ?: NSDate.date]) < 3 * 3600,
        "open is not at now");

    journey = [surface stringByAppendingString:@" J2 look closer, change lens"];
    ZoomInOnPlace(map, 6);
    IsobarCamera zoomed = map.camera;
    printf("%s zoomed %s lines %ld\n", surface.UTF8String, Describe(zoomed).UTF8String, (long)map.contourLineCount);
    EXPECT(PlaceOnScreen(map), "place left the screen while zooming on it");
    for (NSString *lens in Lenses()) {
        NSDate *before = [c selectedForecastDate];
        CFTimeInterval t0 = CACurrentMediaTime();
        EXPECT(ClickLens(root(), lens), "no %s lens control", lens.UTF8String);
        double ms = (CACurrentMediaTime() - t0 - 0.15) * 1000.0;  // ClickLens pumps 150 ms
        printf("  %s click blocked %.0f ms\n", lens.UTF8String, ms);
        // Fly builds its aviation panel on main (~300-500 ms): known slow, tracked in HANDOFF.
        EXPECT(ms < ([lens isEqual:@"Fly"] ? 600 : 400), "%s blocked the main thread %.0f ms", lens.UTF8String, ms);
        map = Map(c);
        printf("  %s -> %s fill %d\n", lens.UTF8String, Describe(map.camera).UTF8String, (int)map.fill);
        EXPECT(SameView(map.camera, zoomed), "%s moved the view: %s -> %s", lens.UTF8String,
            Describe(zoomed).UTF8String, Describe(map.camera).UTF8String);
        NSDate *after = [c selectedForecastDate];
        EXPECT(before && after && fabs([after timeIntervalSinceDate:before]) < 3 * 3600,
            "%s jumped the forecast time", lens.UTF8String);
    }

    journey = [surface stringByAppendingString:@" J4 elsewhere"];
    Drag(map, -260, 120);
    IsobarCamera panned = map.camera;
    EXPECT(!SameView(panned, zoomed), "drag did not pan");
    EXPECT(ClickLens(root(), @"Wind") && SameView(Map(c).camera, panned), "lens after pan moved the view: %s",
        Describe(Map(c).camera).UTF8String);
    ClickLens(root(), @"Pressure");

    journey = [surface stringByAppendingString:@" J7 zoomed in is useful"];
    [map recenter]; Pump(.1);
    ZoomInOnPlace(map, 6);
    [map advanceDisplay:0.05];
    CGImageRef shot = [map copySnapshot];
    if (shot) CGImageRelease(shot);
    NSInteger lines = map.contourLineCount;
    printf("%s J7 %s lines %ld\n", surface.UTF8String, Describe(map.camera).UTF8String, (long)lines);
    EXPECT(lines >= 6, "zoomed-in Pressure view shows %ld isobars", (long)lines);
    NSArray *names = map.snapshotPlaceNames;
    printf("%s J7 places: %s\n", surface.UTF8String, [names componentsJoinedByString:@", "].UTF8String);
    EXPECT(names.count >= 3, "zoomed-in view names %lu places", (unsigned long)names.count);
    NSString *home = [c hubPlace][@"name"] ?: @"";
    BOOL nearby = NO;
    for (NSString *name in names) if ([home localizedCaseInsensitiveContainsString:name]) nearby = YES;
    EXPECT(nearby, "zoomed-in view on %s does not name it", home.UTF8String);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2) { fprintf(stderr, "usage: check-journeys STORE\n"); return 64; }
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(makeKeyAndOrderFront:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderFront:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderBack:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderWindow:relativeTo:)), (IMP)NoOrderWindow);
        method_setImplementation(class_getInstanceMethod(NSPopover.class, @selector(showRelativeToRect:ofView:preferredEdge:)), (IMP)NoPopoverShow);
        method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:)), (IMP)NoActivate);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        JourneyController *c = [JourneyController new];
        [c useManualLiveClock];
        [c replaceLocations:DefaultLocations()];
        [c reloadStoreAtPath:@(argv[1])];
        if (![c chartsReady]) { fprintf(stderr, "chart unavailable\n"); return 1; }
        [c rebuildContent]; Pump(.3);
        Journeys(c, ^NSView *{ return c.popover.contentViewController.view; }, @"popover");
        [c presentChartWindowInFrame:NSMakeRect(-30000, -30000, 1512, 982)];
        Pump(.3);
        Journeys(c, ^NSView *{ return c.chartWindow.contentView; }, @"expanded");
        [c closeChartWindow];
        [c stopPopoverPlayback];
        [Map(c) stopRendering];
        printf("journey failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
