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
#import "../Sources/windmapview.h"

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

static void CheckPointSamples(GPUMapView *map, OwnRun *run) {
    NSDictionary *sample = map.pointSample;
    OwnRunGeo g = run.geo;
    NSInteger x = llround(([sample[@"longitude"] doubleValue]-g.west)/g.step);
    NSInteger y = llround((g.north-[sample[@"latitude"] doubleValue])/g.step);
    if (g.wrapsLongitude) x = (x%g.nLon+g.nLon)%g.nLon;
    NSInteger index = y*g.nLon+x;
    NSArray *keys = @[@"temperature",@"direction",@"wind",@"pressure"];
    OwnRunField fields[] = {OwnRunFieldT2M,OwnRunFieldWindDirection,OwnRunFieldWindSpeed,OwnRunFieldMSLP};
    EXPECT(sample != nil, "click did not open point card");
    for (NSUInteger i=0;i<keys.count;i++) {
        double direct = [run valueAtPointIndex:index field:fields[i] fractionalHour:map.fractionalStep];
        id shown = sample[keys[i]];
        EXPECT(isfinite(direct) ? ([shown isKindOfClass:NSNumber.class] && fabs([shown doubleValue]-direct)<1e-8) : shown==NSNull.null,
            "%s differs from direct grid sample", [keys[i] UTF8String]);
    }
}

static void ArrowJourney(JourneyController *c) {
    journey = @"popover shared-player arrows";
    GPUMapView *map = Map(c);
    NSArray<NSDate *> *times = [c valueForKey:@"sequenceTimes"];
    for (NSNumber *playing in @[@YES,@NO]) {
        [c startLivePlaybackFromDate:times[3]];
        if (!playing.boolValue) [c pauseLivePlayback];
        for (NSNumber *delta in @[@1,@-1]) {
            NSInteger wanted = delta.integerValue>0 ? 4 : 3;
            [c stepPopoverPair:delta.integerValue];
            [map displayAtTime:[map.timeline clockNow]];
            EXPECT(fabs([map.timeline.playhead timeIntervalSinceDate:times[wanted]])<.01,
                "arrow %+ld did not move shared playhead while %s",(long)delta.integerValue,playing.boolValue?"playing":"paused");
            EXPECT(fabs(map.fractionalStep-[c liveModelIndexForDate:times[wanted]])<1e-6,
                "arrow did not update GPU playhead");
            EXPECT(map.timeline.playing==playing.boolValue, "arrow changed prior playback state");
        }
    }
    [c startLivePlaybackFromDate:times[3]];
    [c previewPopoverMovieFraction:[c motionFractionForDate:times[7]]];
    [c stepPopoverPair:1];
    EXPECT(fabs([map.timeline.playhead timeIntervalSinceDate:times[8]])<.01 && map.timeline.playing,
        "hover to arrow did not seek from inspected time and restore playback");
    [c previewPopoverMovieFraction:NAN];
    EXPECT(fabs([[c selectedForecastDate] timeIntervalSinceDate:times[8]])<.01,
        "leaving hover restored stale time after arrow");
    [c startLivePlaybackFromDate:times.lastObject]; [c pauseLivePlayback];
    [map.timeline setValue:nil forKey:@"baseImage"];
    [c stepPopoverPair:1];
    EXPECT(fabs([map.timeline.playhead timeIntervalSinceDate:times.lastObject])<.01,"right arrow passed last frame: player %s expected %s selected %s", map.timeline.playhead.description.UTF8String,times.lastObject.description.UTF8String,[c selectedForecastDate].description.UTF8String);
    [c startLivePlaybackFromDate:times.firstObject]; [c pauseLivePlayback];
    [c stepPopoverPair:-1];
    EXPECT(fabs([map.timeline.playhead timeIntervalSinceDate:times.firstObject])<.01,"left arrow passed first frame");
    [c toggleChartSource];
    EXPECT(![c livePlaybackAvailable],"fixture Bureau fallback unavailable");
    [c stepPopoverPair:1];
    ChartPair pair; [[c valueForKey:@"pair"] getValue:&pair size:sizeof(pair)];
    NSArray *bureauTimes = [c valueForKey:@"sequenceTimes"];
    EXPECT(pair.valid && [[c selectedForecastDate] isEqual:bureauTimes[pair.left]],"Bureau pair stepping changed");
    [c toggleChartSource];
    [c startLivePlaybackFromDate:[c currentPlaybackNow]];
}

static void SavePointTrafficShot(GPUMapView *map, NSString *path) {
    CGImageRef shot = [map copySnapshot];
    EXPECT(shot != NULL, "point/traffic snapshot unavailable");
    if (!shot) return;
    NSImageView *picture = [NSImageView imageViewWithImage:[[NSImage alloc] initWithCGImage:shot size:map.bounds.size]];
    CGImageRelease(shot);
    picture.frame = map.bounds;
    picture.imageScaling = NSImageScaleAxesIndependently;
    // Metal does not cache. Put its snapshot below the real AppKit overlays,
    // preserving their actual stacking order in the viewport capture.
    [map addSubview:picture positioned:NSWindowBelow relativeTo:map.subviews.firstObject];
    @try {
        NSBitmapImageRep *rep = [map bitmapImageRepForCachingDisplayInRect:map.bounds];
        [map cacheDisplayInRect:map.bounds toBitmapImageRep:rep];
        EXPECT([[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES],
            "could not save %s",path.UTF8String);
    } @finally { [picture removeFromSuperview]; }
}

static void PointCloseTrafficJourney(JourneyController *c, NSString *surface, NSString *dir) {
    BOOL expanded = [surface isEqual:@"expanded"];
    NSView *(^root)(void) = ^{ return expanded ? c.chartWindow.contentView : c.popover.contentViewController.view; };
    EXPECT(ClickLens(root(), @"Fly"), "Fly lens unavailable for point close journey");
    GPUMapView *map = Map(c);
    EXPECT(map.trafficEnabled, "Fly traffic overlay is disabled");
    NSRect originalFrame = expanded ? c.chartWindow.frame : map.frame;
    for (NSString *theme in @[@"light",@"dark"]) for (NSString *operation in @[@"resize",@"pan"]) {
        map.appearance = [NSAppearance appearanceNamed:[theme isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
        [map recenter];
        [map selectPointLatitude:-33.9 longitude:151.2];
        if ([operation isEqual:@"resize"]) {
            NSRect frame = originalFrame; frame.size.width -= 80; frame.size.height -= 40;
            if (expanded) { [c.chartWindow setFrame:frame display:NO]; [c layoutChartWindow]; }
            else [map setFrame:frame];
        } else Drag(map,30,20);
        [map displayAtTime:[map.timeline clockNow]];
        MapPointCard *card = (MapPointCard *)Find(map, ^BOOL(NSView *v) { return [v isKindOfClass:MapPointCard.class]; });
        NSButton *close = card.closeButton;
        NSPoint at = [close convertPoint:NSMakePoint(NSMidX(close.bounds),NSMidY(close.bounds)) toView:map.superview];
        NSView *hit = [map hitTest:at];
        EXPECT(card && NSContainsRect(map.bounds,card.frame), "point card clipped after %s",operation.UTF8String);
        EXPECT(close && hit == close, "%s %s: traffic intercepted point close (%s)",theme.UTF8String,operation.UTF8String,NSStringFromClass(hit.class).UTF8String);
        NSString *name = [NSString stringWithFormat:@"%@-traffic-%@-%@",surface,operation,theme];
        SavePointTrafficShot(map,[dir stringByAppendingPathComponent:[name stringByAppendingString:@"-before-close.png"]]);
        if (close && hit == close) [(NSButton *)hit performClick:nil];
        EXPECT(!map.pointSample, "%s: hit-tested close did not remove point",name.UTF8String);
        SavePointTrafficShot(map,[dir stringByAppendingPathComponent:[name stringByAppendingString:@"-after-close.png"]]);
        [map closePointDetail];
        if (expanded) { [c.chartWindow setFrame:originalFrame display:NO]; [c layoutChartWindow]; }
        else map.frame = originalFrame;
    }
    map.appearance = nil;
    EXPECT(ClickLens(root(), @"Pressure"), "could not restore Pressure after point close journey");
    [Map(c) recenter];
}

static void PointJourney(JourneyController *c, NSString *surface) {
    journey = [surface stringByAppendingString:@" J10 point card"];
    GPUMapView *map = Map(c);
    OwnRun *run = [c valueForKey:@"ownRun"];
    NSDate *before = [c selectedForecastDate];
    [c startLivePlaybackFromDate:[run timeAtIndex:3]];
    [map displayAtTime:[map.timeline clockNow]];
    NSDate *clicked = map.timeline.playhead;
    NSPoint at = NSMakePoint(NSMidX(map.placeMarkerFrame),NSMidY(map.placeMarkerFrame));
    [map pointerDown:at]; [map pointerUp:at];
    EXPECT(map.timeline.playing && fabs([map.timeline.playhead timeIntervalSinceDate:clicked])<1,
        "point selection paused or reset playback");
    CheckPointSamples(map,run);
    NSDictionary *first = map.pointSample;
    [c advanceLiveTicks:30]; [map displayAtTime:[map.timeline clockNow]];
    EXPECT([map.pointSample[@"step"] doubleValue]>[first[@"step"] doubleValue], "point card did not follow playback: before %.6f after %.6f live %s playing %d scrub %d", [first[@"step"] doubleValue],[map.pointSample[@"step"] doubleValue],map.timeline.playhead.description.UTF8String,map.timeline.playing,[[c valueForKey:@"scrubHasFraction"] boolValue]);
    CheckPointSamples(map,run);
    NSPoint next = NSMakePoint(at.x+20,at.y+15);
    [map pointerDown:next]; [map pointerUp:next];
    EXPECT(fabs([map.pointSample[@"longitude"] doubleValue]-[first[@"longitude"] doubleValue])>.01,
        "second click did not move point");
    CheckPointSamples(map,run);
    NSString *dir = NSProcessInfo.processInfo.environment[@"ISOBAR_JOURNEY_SHOTS"] ?: @"build/qa/journeys";
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    for (NSString *theme in @[@"light",@"dark"]) {
        map.appearance = [NSAppearance appearanceNamed:[theme isEqual:@"dark"]?NSAppearanceNameDarkAqua:NSAppearanceNameAqua];
        CGImageRef shot = [map copySnapshot];
        EXPECT(shot != NULL, "point snapshot unavailable");
        if (shot) {
            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:shot];
            [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
                writeToFile:[dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@-point-%@.png",surface,theme]] atomically:YES];
            CGImageRelease(shot);
        }
        MapPointCard *card = (MapPointCard *)Find(map, ^BOOL(NSView *v) { return [v isKindOfClass:MapPointCard.class]; });
        EXPECT(card && NSContainsRect(map.bounds,card.frame), "point card does not fit viewport");
    }
    map.appearance = nil;
    if ([surface isEqual:@"popover"]) [c escapePopover]; else [c escapeFullscreen];
    EXPECT(!map.pointSample && map.superview, "Escape did not close only the point card");
    [map pointerDown:at]; [map pointerUp:at];
    MapPointCard *card = (MapPointCard *)Find(map, ^BOOL(NSView *v) { return [v isKindOfClass:MapPointCard.class]; });
    [card.closeButton performClick:nil];
    EXPECT(!map.pointSample, "close button did not remove point");
    PointCloseTrafficJourney(c,surface,dir);
    map = Map(c);
    // Outside the published coverage is explicitly unavailable.
    [map selectPointLatitude:89 longitude:0];
    EXPECT(map.pointSample[@"temperature"] == NSNull.null, "outside coverage invented a temperature");
    [map closePointDetail];
    [c inspectPopoverMovieFraction:[c motionFractionForDate:before]];
    printf("%s point journey complete (%d failures so far)\n",surface.UTF8String,failures);
}

static void Journeys(JourneyController *c, NSView *(^root)(void), NSString *surface) {
    GPUMapView *map = Map(c);
    if (!map) { fprintf(stderr, "SKIP %s journeys: no Metal map\n", surface.UTF8String); return; }

    journey = [surface stringByAppendingString:@" J1 glance"];
    EXPECT(PlaceOnScreen(map), "selected place is off screen after open (%s)", Describe(map.camera).UTF8String);
    NSDate *opened = [c selectedForecastDate];
    EXPECT(opened && fabs([opened timeIntervalSinceDate:[c valueForKey:@"chartNow"] ?: NSDate.date]) < 3 * 3600,
        "open is not at now");

    if ([surface isEqual:@"popover"]) ArrowJourney(c);
    PointJourney(c,surface);
    if (getenv("ISOBAR_POINT_JOURNEY_ONLY") || getenv("ISOBAR_NATIVE_SYNC_ONLY")) return;

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
        if (!([drawn[@"source"] isEqual:@"TAF"] && [bases containsObject:@3067])) {
            fprintf(stderr, "Fly sky diagnostics: selected=%s skyTime=%s ready=%d drawnTime=%s source=%s\n",
                [[c selectedForecastDate] description].UTF8String, [sky.time description].UTF8String,
                sky.pageReady, [drawn[@"timeMs"] description].UTF8String, [drawn[@"source"] description].UTF8String);
        }
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
    IsobarCamera tiltStart = map.camera; tiltStart.pitch=0; tiltStart.globe=0;
    map.camera=tiltStart;
    NSDate *vectorTime = [c selectedForecastDate];
    IsobarCamera vectorCamera = map.camera;
    // Surface flow belongs to the Wind and Kite lenses; Pressure neither
    // advances nor draws trails (their CPU cost was 40-300 ms a frame).
    WindMapView *surfaceWind=[map valueForKey:@"windView"];
    EXPECT(surfaceWind.hidden&&!map.windFlow,"Pressure lens keeps wind trails hidden");
    double pressureWindTime=surfaceWind.time;
    for(int frame=0;frame<10;frame++) [map advanceDisplay:1.0/60.0];
    EXPECT(surfaceWind.time==pressureWindTime,"hidden wind trails still advance on Pressure");
    EXPECT(ClickLens(root(), @"Wind"), "no Wind lens for surface flow");
    map = Map(c);
    vectorTime = [c selectedForecastDate];
    surfaceWind=[map valueForKey:@"windView"];
    EXPECT(!surfaceWind.hidden&&map.windFlow&&!surfaceWind.barbs,"Wind lens shows surface flow without barbs");
    for(int frame=0;frame<100;frame++) { @autoreleasepool {
        [map advanceDisplay:1.0/60.0];
        CGImageRef shot=[map copySnapshot];if(shot)CGImageRelease(shot);
    }}
    EXPECT(surfaceWind.drawnCount>10,"Wind lens rendered no trails");
    EXPECT(surfaceWind.time>1,"map display link did not advance wind independently of forecast");
    EXPECT(fabs([[c selectedForecastDate] timeIntervalSinceDate:vectorTime])<1,"wind animation changed held forecast time");
    EXPECT(ClickLens(root(), @"Pressure"), "could not return to Pressure after the wind flow check");
    map = Map(c);
    map.camera = vectorCamera;
    vectorTime = [c selectedForecastDate];
    NSButton *barbs = (NSButton *)Find(root(), ^BOOL(NSView *v) {
        return [v isKindOfClass:NSButton.class] && [v.accessibilityIdentifier hasSuffix:@".barbs"] && !v.hiddenOrHasHiddenAncestor;
    });
    EXPECT(barbs && barbs.enabled, "wind toggle is available on the GPU map");
    if (barbs.state != NSControlStateValueOn) [barbs performClick:nil];
    map = Map(c);
    // Warmup finishes the mode-transition animation. Restore the known
    // overhead starting view before testing a new tilt gesture; the snapshot
    // taken before warmup is otherwise stale. Use renderer pixels consistently.
    map.camera = vectorCamera;
    double focusLat=map.placeLatitude, focusLon=map.placeLongitude, focusX=0, focusY=0;
    if (!IsobarCameraProject(vectorCamera,focusLat,focusLon,&focusX,&focusY) || focusX<0 || focusY<0 || focusX>vectorCamera.viewportW || focusY>vectorCamera.viewportH) {
        focusLat=vectorCamera.centreLat; focusLon=vectorCamera.centreLon;
        focusX=vectorCamera.viewportW*.5; focusY=vectorCamera.viewportH*.5;
    }
    [map scrollByX:0 y:-150 atPoint:NSMakePoint(NSMidX(map.bounds),NSMidY(map.bounds)) precise:YES command:NO];
    double afterX=0, afterY=0;
    EXPECT(map.camera.pitch > .2 && map.camera.zoom > vectorCamera.zoom &&
        IsobarCameraProject(map.camera,focusLat,focusLon,&afterX,&afterY) && hypot(afterX-focusX,afterY-focusY)<=1,
        "tilting wind must dolly closer while retaining the visible geographic anchor");
    EXPECT(fabs([[c selectedForecastDate] timeIntervalSinceDate:vectorTime])<1, "tilting wind changed forecast time");
    [map waitForUploads];
    NSString *dir = NSProcessInfo.processInfo.environment[@"ISOBAR_JOURNEY_SHOTS"] ?: @"build/qa/journeys";
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
    IsobarCamera beforeFlat=map.camera;
    if (mode2D) [mode2D performClick:nil];
    [map advanceDisplay:1.0];
    EXPECT(fabs(map.camera.pitch)<1e-9 && fabs(map.camera.centreLat-beforeFlat.centreLat)<1e-6 &&
        fabs(map.camera.centreLon-beforeFlat.centreLon)<1e-6 && fabs(log(map.camera.zoom/vectorCamera.zoom))<.01,
        "returning flat must retain the current focus and remove only the tilt dolly");
    EXPECT(fabs([[c selectedForecastDate] timeIntervalSinceDate:vectorTime])<1, "returning flat changed forecast time");
    double flatZoom = map.camera.zoom;
    [map scrollByX:0 y:-150 atPoint:NSMakePoint(NSMidX(map.bounds),NSMidY(map.bounds)) precise:YES command:NO];
    EXPECT(fabs(map.camera.pitch)<1e-9 && map.camera.zoom < flatZoom,
        "two-finger scroll in 2D should zoom out without tilting");
}

static void AttributionJourney(JourneyController *c) {
    journey = @"native data attribution";
    NSString *credit = @"ECMWF open data, CC BY 4.0";
    for (NSView *root in @[c.popover.contentViewController.view,c.chartWindow.contentView]) {
        NSView *issued = Find(root, ^BOOL(NSView *v) { return [v.accessibilityIdentifier hasSuffix:@".issued"]; });
        EXPECT([issued.toolTip containsString:credit], "run-age tooltip lacks ECMWF attribution");
    }
    [c openSettings:nil]; // Window ordering and activation are blocked in main.
    NSWindow *settings = [c valueForKey:@"settingsWindow"];
    NSTextField *footer = (NSTextField *)Find(settings.contentView, ^BOOL(NSView *v) {
        return [v.accessibilityIdentifier isEqual:@"settings.attribution"];
    });
    EXPECT([footer.stringValue isEqual:credit] && NSContainsRect(settings.contentView.bounds,footer.frame),
        "Settings attribution is missing or outside its viewport");
    NSString *dir = NSProcessInfo.processInfo.environment[@"ISOBAR_JOURNEY_SHOTS"] ?: @"build/qa/journeys";
    for (NSString *theme in @[@"light",@"dark"]) {
        settings.contentView.appearance = [NSAppearance appearanceNamed:[theme isEqual:@"dark"]?NSAppearanceNameDarkAqua:NSAppearanceNameAqua];
        NSView *root = settings.contentView;
        NSBitmapImageRep *rep = [root bitmapImageRepForCachingDisplayInRect:root.bounds];
        [root cacheDisplayInRect:root.bounds toBitmapImageRep:rep];
        EXPECT(rep != nil, "Settings offscreen capture missing");
        [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
            writeToFile:[dir stringByAppendingPathComponent:[NSString stringWithFormat:@"settings-%@.png",theme]] atomically:YES];
    }
    [settings close];
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
        AttributionJourney(c);
        [c closeChartWindow];
        [c stopPopoverPlayback];
        [Map(c) stopRendering];
        printf("journey failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
