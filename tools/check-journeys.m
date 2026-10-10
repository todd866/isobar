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
        EXPECT(before && after && fabs([after timeIntervalSinceDate:before]) < 10 * 60,
            "%s jumped the forecast time", lens.UTF8String);
    }

    // Fly zoomed in: the sky section is the card's picture, and it shows the
    // fixture's cloud at the aerodrome's height when the playhead is in the TAF.
    NSDate *before2 = [c selectedForecastDate];
    journey = [surface stringByAppendingString:@" J8 Fly sky"];
    ClickLens(root(), @"Fly");
    AviationLensView *fly = [c valueForKey:@"flyLens"];
    SkySectionView *sky = fly.sky;
    EXPECT(sky && !sky.hiddenOrHasHiddenAncestor && NSHeight(sky.frame) >= 96, "no sky section on the Fly card");
    NSDictionary *aviation = [c valueForKey:@"aviation"];
    BOOL fixture = [[aviation[@"taf"][@"raw"] description] containsString:@"2612/2712 14012KT 9999 SCT030"];
    if (sky.window && fixture) {
        NSDate *taf = [[NSISO8601DateFormatter new] dateFromString:@"2026-09-26T12:00:00Z"];
        [c inspectPopoverMovieFraction:[c motionFractionForDate:taf]];
        NSDate *until = [NSDate dateWithTimeIntervalSinceNow:15];
        BOOL done = NO;
        while (!done && until.timeIntervalSinceNow > 0) {
            Pump(.05);
            // A scrub can rebuild the card: follow the current one.
            sky = ((AviationLensView *)[c valueForKey:@"flyLens"]).sky ?: sky;
            NSDictionary *drawn = sky.drawnState;
            done = [drawn[@"source"] isEqual:@"TAF"] && [drawn[@"layers"] count];
        }
        NSDictionary *drawn = sky.drawnState;
        NSMutableArray *bases = [NSMutableArray array];
        for (NSDictionary *layer in drawn[@"layers"]) [bases addObject:@(llround([layer[@"baseFtAmsl"] doubleValue]))];
        printf("%s J8 sky %s %s bases %s\n", surface.UTF8String, [drawn[@"icao"] description].UTF8String,
            [drawn[@"source"] description].UTF8String, [bases componentsJoinedByString:@","].UTF8String);
        EXPECT([drawn[@"source"] isEqual:@"TAF"] && [bases containsObject:@3067],
            "Fly sky at 12Z does not show the TAF's SCT030 at 3,067 ft AMSL (%s)", [bases componentsJoinedByString:@","].UTF8String);
        [c inspectPopoverMovieFraction:[c motionFractionForDate:before2]];
        Pump(.1);
    } else if (!sky.window) printf("%s J8 sky not in a window (popover not shown offscreen)\n", surface.UTF8String);
    ClickLens(root(), @"Pressure");

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

    // The towns read out the lens: Temp in degrees, Wind in knots.
    journey = [surface stringByAppendingString:@" J7b towns read the lens"];
    for (NSArray *pair in @[@[@"Temp", @"°"], @[@"Wind", @" kt"]]) {
        ClickLens(root(), pair[0]);
        map = Map(c);
        [map advanceDisplay:0.05];
        CGImageRef lensShot = [map copySnapshot];
        if (lensShot) CGImageRelease(lensShot);
        NSArray *read = map.snapshotPlaceNames;
        NSUInteger with = 0;
        for (NSString *name in read) if ([name containsString:pair[1]]) with++;
        printf("%s %s: %s\n", surface.UTF8String, [pair[0] UTF8String], [[read subarrayWithRange:NSMakeRange(0, MIN(4u, read.count))] componentsJoinedByString:@" | "].UTF8String);
        EXPECT(read.count && with * 2 >= read.count, "%s lens: %lu of %lu towns show a reading", [pair[0] UTF8String],
            (unsigned long)with, (unsigned long)read.count);
    }
    ClickLens(root(), @"Pressure");
    journey = [surface stringByAppendingString:@" J9 tilted wind vectors"];
    map = Map(c);
    NSButton *mode3D = (NSButton *)Find(root(), ^BOOL(NSView *v) {
        return [v isKindOfClass:NSButton.class] && [v.accessibilityIdentifier hasSuffix:@".sphere"] && !v.hiddenOrHasHiddenAncestor;
    });
    EXPECT(mode3D && mode3D.enabled, "3D mode control is available");
    if (mode3D) [mode3D performClick:nil];
    NSDate *vectorTime = [c selectedForecastDate];
    IsobarCamera vectorCamera = map.camera;
    NSButton *barbs = (NSButton *)Find(root(), ^BOOL(NSView *v) {
        return [v isKindOfClass:NSButton.class] && [v.accessibilityIdentifier hasSuffix:@".barbs"] && !v.hiddenOrHasHiddenAncestor;
    });
    EXPECT(barbs && barbs.enabled, "wind toggle is available on the GPU map");
    if (barbs.state != NSControlStateValueOn) [barbs performClick:nil];
    map = Map(c);
    [map scrollByX:0 y:-150 atPoint:NSMakePoint(NSMidX(map.bounds),NSMidY(map.bounds)) precise:YES command:NO];
    EXPECT(map.camera.pitch > .2 && SameView(map.camera,vectorCamera), "tilting wind changed the geographic view");
    EXPECT(fabs([[c selectedForecastDate] timeIntervalSinceDate:vectorTime])<1, "tilting wind changed forecast time");
    [map waitForUploads];
    NSString *dir = @"build/qa/journeys";
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    OwnRun *windRun = [map valueForKey:@"run"];
    NSString *coverage = windRun.geo.wrapsLongitude ? @"global" : @"regional";
    for (NSString *theme in @[@"light",@"dark"]) {
        map.appearance = [NSAppearance appearanceNamed:[theme isEqual:@"dark"]?NSAppearanceNameDarkAqua:NSAppearanceNameAqua];
        CGImageRef windShot = [map copySnapshot];
        NSUInteger count = [[[map valueForKey:@"windView"] valueForKey:@"drawnCount"] unsignedIntegerValue];
        EXPECT(windShot && map.windBarbs && count>5, "tilted wind map has no useful vectors (%lu)",(unsigned long)count);
        if (windShot) {
            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:windShot];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            [png writeToFile:[dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@-wind-%@-%@.png",surface,coverage,theme]] atomically:YES];
            CGImageRelease(windShot);
        }
    }
    map.appearance = nil;
    NSButton *mode2D = (NSButton *)Find(root(), ^BOOL(NSView *v) {
        return [v isKindOfClass:NSButton.class] && [v.accessibilityIdentifier hasSuffix:@".flat"] && !v.hiddenOrHasHiddenAncestor;
    });
    EXPECT(mode2D && mode2D.enabled, "2D mode control is available");
    if (mode2D) [mode2D performClick:nil];
    [map advanceDisplay:1.0];
    [map scrollByX:0 y:150 atPoint:NSMakePoint(NSMidX(map.bounds),NSMidY(map.bounds)) precise:YES command:NO];
    EXPECT(fabs(map.camera.pitch)<1e-9 && SameView(map.camera,vectorCamera), "returning flat lost the wind view");
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
