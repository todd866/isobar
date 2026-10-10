// Offscreen checks for the expanded-map GPU surface. No window is ordered front.
#import "gpumapview.h"
#import "hazard.h"
#import "mapcamera.h"
#import "playback.h"
#import <math.h>
#import <stdio.h>
#import <stdlib.h>

@interface SnapshotScaleMapView : GPUMapView
@property(nonatomic) CGFloat testScale;
@end
@implementation SnapshotScaleMapView
- (CGFloat)pixelScale { return _testScale > 0 ? _testScale : 1; }
@end

static int failures = 0;

@interface GPUMapView (GestureTestEvents)
- (void)magnifyWithEvent:(NSEvent *)event;
@end

@interface SyntheticMagnifyEvent : NSEvent
@property(nonatomic) CGFloat testMagnification;
@property(nonatomic) NSPoint testLocation;
@property(nonatomic) NSEventPhase testPhase;
@end

@implementation SyntheticMagnifyEvent
- (CGFloat)magnification { return self.testMagnification; }
- (NSPoint)locationInWindow { return self.testLocation; }
- (NSEventPhase)phase { return self.testPhase; }
@end

static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static NSView *FindID(NSView *root, NSString *ident);

static float HalfFloat(uint16_t bits) {
    int sign = bits >> 15;
    int exp = (bits >> 10) & 31;
    int frac = bits & 1023;
    float value;
    if (exp == 31) value = NAN;
    else if (exp == 0) value = ldexpf((float)frac, -24);
    else value = ldexpf(1.0f + (float)frac / 1024.0f, exp - 15);
    return sign ? -value : value;
}

static BOOL LoadFixture(NSString *dir, IsobarGeoGrid *grid, NSArray<NSData *> **steps) {
    NSData *headerData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"header.json"]];
    NSDictionary *header = [NSJSONSerialization JSONObjectWithData:headerData ?: [NSData data] options:0 error:nil];
    NSDictionary *g = [header[@"grid"] isKindOfClass:NSDictionary.class] ? header[@"grid"] : nil;
    NSArray *listed = [header[@"steps"] isKindOfClass:NSArray.class] ? header[@"steps"] : nil;
    if (!g || !listed.count) return NO;
    *grid = (IsobarGeoGrid){
        .west = [g[@"west"] doubleValue], .north = [g[@"north"] doubleValue],
        .step = [g[@"step"] doubleValue], .nLon = [g[@"nLon"] intValue],
        .nLat = [g[@"nLat"] intValue], .wrapsLongitude = [g[@"wrapsLongitude"] boolValue]
    };
    size_t n = (size_t)grid->nLon * (size_t)grid->nLat;
    NSMutableArray *fields = [NSMutableArray array];
    for (NSDictionary *item in listed) {
        NSData *raw = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:item[@"file"]]];
        if (raw.length != n * 2) return NO;
        NSMutableData *values = [NSMutableData dataWithLength:n * sizeof(float)];
        float *out = values.mutableBytes;
        const uint8_t *bytes = raw.bytes;
        for (size_t i = 0; i < n; i++) {
            uint16_t bits = (uint16_t)(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
            float sample = HalfFloat(bits);
            out[i] = isfinite(sample) ? sample : NAN;
        }
        [fields addObject:values];
    }
    *steps = fields;
    return YES;
}

static void CheckPlayhead(GPUMapView *view) {
    view.fractionalStep = 0.25;
    double held = view.fractionalStep;
    NSUInteger before = view.renderCount;
    [view advanceDisplay:1.0];
    [view advanceDisplay:10.0];
    Check(!view.ownsForecastTimer, @"the GPU map has no forecast timer");
    Check(view.fractionalStep == held, @"a display tick does not move the shared playhead");
    Check(fabs(view.renderedStep - 0.25) < 1e-9, @"the frame is the playhead the host supplied");
    Check(view.renderCount > before, @"a display tick redraws that instant");
    view.fractionalStep = 1.5;
    [view advanceDisplay:1.0 / 60.0];
    Check(fabs(view.renderedStep - 1.5) < 1e-9 && fabs(view.fractionalStep - 1.5) < 1e-9,
        @"the next host instant is what the field blends");
}

static void CheckDragAndPinch(GPUMapView *view) {
    view.frame = NSMakeRect(0, 0, 480, 360);
    view.camera = MapCameraMake(-35, 140, 6, 0, 480, 360);
    __block NSInteger clicks = 0;
    __block NSInteger holds = 0, releases = 0;
    view.onPlainClick = ^{ clicks++; };
    view.onHoldChanged = ^(BOOL held) { held ? holds++ : releases++; };
    IsobarCamera start = view.camera;
    [view pointerDown:NSMakePoint(200, 160)];
    [view pointerDrag:NSMakePoint(260, 120)];
    [view pointerUp:NSMakePoint(260, 120)];
    Check(clicks == 0, @"a drag does not emit a plain-click callback");
    Check(fabs(view.camera.centreLat - start.centreLat) > 0.01 ||
        fabs(view.camera.centreLon - start.centreLon) > 0.01, @"a drag pans the map");
    IsobarCamera dragged = view.camera;
    [view pointerDown:NSMakePoint(80, 80)];
    [view pointerUp:NSMakePoint(82, 81)];
    Check(clicks == 1, @"a plain click emits the optional selection callback");
    Check(holds == 2 && releases == 2, @"pointer hold emits balanced ownership callbacks");
    Check(fabs(view.camera.centreLat - dragged.centreLat) < 1e-6 &&
        fabs(view.camera.centreLon - dragged.centreLon) < 1e-6, @"a click does not pan");

    view.camera = MapCameraMake(-35, 140, 6, 0, 480, 360);
    NSPoint at = NSMakePoint(300, 150);
    double lat = 0, lon = 0, px = 0, py = 0;
    Check(IsobarCameraUnproject(view.camera, at.x, at.y, &lat, &lon), @"pinch point is on the map");
    Check([view pinchFactor:1.35 atPoint:at], @"pinch zooms about the pointer");
    Check(IsobarCameraProject(view.camera, lat, lon, &px, &py) && hypot(px - at.x, py - at.y) <= 1.0,
        @"the geographic point under the pinch stays under the pointer");
    Check(view.camera.zoom > 6.0, @"pinch changes zoom");
    IsobarCamera clamped = IsobarCameraClamp(view.camera);
    Check(fabs(view.camera.zoom - clamped.zoom) < 1e-6 &&
        fabs(view.camera.centreLat - clamped.centreLat) < 1e-6, @"pinch stays inside the camera clamp");

    NSButton *sphere = (NSButton *)FindID(view, @"gpumap.sphere");
    Check(sphere != nil, @"the 3D mode control is present");
    [sphere performClick:nil];
    Check(sphere.state == NSControlStateValueOn, @"selecting 3D marks the mode selected");
    Check(((NSSlider *)FindID(view, @"gpumap.globe")).enabled, @"the tilt slider is enabled in 3D");
    // Exercise a partial tilt regardless of the runner's Reduce Motion setting.
    IsobarCamera tiltStart = view.camera; tiltStart.pitch = 0; tiltStart.globe = 0;
    view.camera = tiltStart;
    IsobarCamera beforeScroll = view.camera;
    [view scrollByX:0 y:-40 atPoint:at precise:YES command:NO];
    Check(view.camera.pitch > beforeScroll.pitch && view.camera.globe > beforeScroll.globe,
        @"two-finger scroll tilts into the globe");
    double saved3DGlobe = view.camera.globe;
    Check(fabs(view.camera.centreLat - beforeScroll.centreLat) < 1e-9 &&
        fabs(view.camera.centreLon - beforeScroll.centreLon) < 1e-9, @"tilt keeps the geographic focus");
    Check(IsobarCameraUnproject(view.camera,at.x,at.y,&lat,&lon),@"tilted pinch starts on Earth");
    double pitch=view.camera.pitch;
    Check([view pinchFactor:1.2 atPoint:at],@"pinch works while tilted");
    Check(IsobarCameraProject(view.camera,lat,lon,&px,&py) && hypot(px-at.x,py-at.y)<1,@"tilted pinch preserves geographic pointer anchor");
    Check(fabs(view.camera.pitch-pitch)<1e-9,@"pinch leaves tilt unchanged");
    [view pointerDown:at]; [view pointerDrag:NSMakePoint(at.x+20,at.y+10)]; [view pointerUp:NSMakePoint(at.x+20,at.y+10)];
    IsobarCamera panned=view.camera;
    [view scrollByX:0 y:1000 atPoint:at precise:YES command:NO];
    Check(view.camera.pitch==0 && fabs(view.camera.centreLat-panned.centreLat)<1e-9 && fabs(view.camera.centreLon-panned.centreLon)<1e-9,@"return overhead retains the place reached by tilted pan");
    Check(sphere.state == NSControlStateValueOn, @"returning overhead keeps 3D mode selected");
    [view scrollByX:0 y:-40 atPoint:at precise:YES command:NO];
    saved3DGlobe = view.camera.globe;
    NSButton *flat = (NSButton *)FindID(view, @"gpumap.flat");
    [flat performClick:nil];
    [view advanceDisplay:1.0];
    Check(view.camera.globe == 0 && view.camera.pitch == 0, @"switching to 2D reaches the flat camera");
    IsobarCamera flatBeforeSwipe = view.camera;
    double flatZoomBeforeSwipe = view.camera.zoom;
    [view scrollByX:0 y:-1000 atPoint:at precise:YES command:NO];
    Check(flat.state == NSControlStateValueOn && sphere.state == NSControlStateValueOff,
        @"selecting 2D updates the mutually exclusive mode controls");
    Check(fabs(view.camera.pitch - flatBeforeSwipe.pitch) < 1e-9 && fabs(view.camera.globe - flatBeforeSwipe.globe) < 1e-9 &&
        view.camera.zoom > flatZoomBeforeSwipe, @"a two-finger swipe in 2D zooms without activating 3D");
    Check(!((NSSlider *)FindID(view, @"gpumap.globe")).enabled, @"the tilt slider is disabled in 2D");
    double flatZoom = view.camera.zoom;
    [view scrollByX:0 y:-40 atPoint:at precise:NO command:NO];
    Check(view.camera.zoom > flatZoom, @"a non-precise wheel event still zooms in 2D");
    [sphere performClick:nil];
    [view advanceDisplay:1.0];
    Check(fabs(view.camera.globe - saved3DGlobe) < 1e-9, @"switching back to 3D restores the last tilt");
    [flat performClick:nil];
    [view scrollByX:0 y:-1000 atPoint:at precise:YES command:NO];
    Check(flat.state == NSControlStateValueOn && fabs(view.camera.globe) < 1e-9 && fabs(view.camera.pitch) < 1e-9,
        @"2D input during the mode transition settles the camera overhead");
    // A pinch at either zoom limit keeps its geographic anchor even when the
    // requested factor is clamped. Non-finite gesture input is ignored.
    IsobarCamera limitCamera = view.camera;
    limitCamera.zoom = 18000;
    view.camera = limitCamera;
    double boundLat = 0, boundLon = 0, boundX = 0, boundY = 0;
    Check(IsobarCameraUnproject(view.camera, at.x, at.y, &boundLat, &boundLon),
        @"the zoom-limit pinch point is on the map");
    Check([view pinchFactor:2.0 atPoint:at], @"an outward pinch at max zoom is accepted");
    Check(view.camera.zoom <= 18000.0 + 1e-9 &&
        IsobarCameraProject(view.camera, boundLat, boundLon, &boundX, &boundY) &&
        hypot(boundX - at.x, boundY - at.y) <= 1.0,
        @"a clamped max-zoom pinch keeps its anchor");
    IsobarCamera finiteGuard = view.camera;
    [view scrollByX:NAN y:0 atPoint:at precise:YES command:NO];
    Check(fabs(view.camera.centreLat - finiteGuard.centreLat) < 1e-9 &&
        fabs(view.camera.centreLon - finiteGuard.centreLon) < 1e-9,
        @"non-finite scroll input is ignored");

    view.camera = MapCameraMake(-35, 140, 6, 0, 480, 360);
    IsobarCamera beforeMagnify = view.camera;
    SyntheticMagnifyEvent *changed = [SyntheticMagnifyEvent new];
    changed.testLocation = at;
    changed.testMagnification = 0.2;
    changed.testPhase = NSEventPhaseChanged;
    [view magnifyWithEvent:changed];
    Check(view.camera.zoom > beforeMagnify.zoom, @"a changed magnify event reaches the map gesture handler");
    // Native magnification over the sky still zooms the focused map.
    IsobarCamera skyCamera = MapCameraMake(-33, 151, 3, 1, 480, 360);
    skyCamera.pitch = 1.3;
    view.camera = skyCamera;
    changed.testLocation = [view convertPoint:NSMakePoint(240, 0) toView:nil];
    Check(!IsobarCameraUnproject(view.camera, 240, 0, &lat, &lon), @"sky pinch regression starts off the Earth");
    [view magnifyWithEvent:changed];
    Check(fabs(view.camera.zoom - 3.6) < 1e-9 && fabs(view.camera.centreLat + 33) < 1e-9,
        [NSString stringWithFormat:@"magnification over sky zooms without moving the focus (zoom %.4f lat %.4f)",view.camera.zoom,view.camera.centreLat]);

    // Lowering the view makes vertical detail larger; reversing it preserves
    // the independent zoom chosen by a pinch in the tilted view.
    [sphere performClick:nil];
    view.camera = MapCameraMake(-33, 151, 30, 0, 480, 360);
    [view scrollByX:0 y:-150 atPoint:NSMakePoint(240,180) precise:YES command:NO];
    Check(view.camera.zoom > 45 && view.camera.zoom < 240, @"tilt progressively moves closer to the atmosphere");
    [view pinchFactor:1.2 atPoint:NSMakePoint(240,180)];
    [view scrollByX:0 y:150 atPoint:NSMakePoint(240,180) precise:YES command:NO];
    Check(fabs(view.camera.zoom - 36) < 1e-6, @"untilt removes the dolly and retains manual pinch zoom");

    view.camera = MapCameraMake(-33,151,18000,0,480,360);
    [view scrollByX:0 y:-150 atPoint:NSMakePoint(240,180) precise:YES command:NO];
    [view scrollByX:0 y:150 atPoint:NSMakePoint(240,180) precise:YES command:NO];
    Check(fabs(view.camera.zoom - 18000) < 1e-6, @"tilt at the zoom limit returns to the original scale");

    for (int sign = -1; sign <= 1; sign += 2) {
        IsobarCamera orbit = MapCameraMake(sign * 89, 17, 6, 1, 480, 360);
        orbit.pitch = .6;
        IsobarCamera beyond = orbit; beyond.centreLat = sign * 93;
        Check(IsobarCameraProject(beyond, sign * 89, 17, &px, &py), @"a point projects across a pole");
        Check(MapCameraAnchor(&orbit, sign * 89, 17, px, py), @"drag can anchor across a pole");
        orbit = IsobarCameraClamp(orbit);
        Check(sign * orbit.centreLat > 90, @"globe rotation crosses the pole without clamping");
        Check(IsobarCameraUnproject(orbit, 240, 180, &lat, &lon) && fabs(lat - sign * 87) < .01,
            @"post-pole picking returns the correct physical latitude");
    }
    IsobarCamera beforeCancel = view.camera;
    SyntheticMagnifyEvent *cancelled = [SyntheticMagnifyEvent new];
    cancelled.testLocation = at;
    cancelled.testMagnification = 0.2;
    cancelled.testPhase = NSEventPhaseCancelled;
    [view magnifyWithEvent:cancelled];
    Check(fabs(view.camera.zoom - beforeCancel.zoom) < 1e-9, @"a cancelled magnify event does not zoom");
}

static void CheckPlaceAndGlobe(GPUMapView *view) {
    view.popoverChrome = NO;
    view.frame = NSMakeRect(0, 0, 480, 360);
    [view setPlaceLatitude:-33.87 longitude:151.21];
    [view recenter];
    IsobarCamera sydney = view.camera;
    NSRect marker = view.placeMarkerFrame;
    [view setPlaceLatitude:-31.95 longitude:115.86];
    Check(fabs(view.camera.centreLat - sydney.centreLat) < 1e-9 &&
        fabs(view.camera.centreLon - sydney.centreLon) < 1e-9, @"a location update leaves the camera where it is");
    Check(!NSEqualRects(marker, view.placeMarkerFrame), @"the place marker follows the selected place");
    [view recenter];
    Check(fabs(view.camera.centreLon - 115.86) < 0.02, @"recenter uses the selected place");

    GPUMapView *globeView = [GPUMapView mapView];
    Check(globeView != nil, @"a fresh view is available for the globe morph fixture");
    globeView.frame = NSMakeRect(0, 0, 480, 360);
    globeView.fractionalStep = 1.5;
    globeView.reducedMotionOverride = @NO;
    globeView.camera = MapCameraMake(view.camera.centreLat, view.camera.centreLon, view.camera.zoom, 0, 480, 360);
    Check([globeView handleGlobeKey:@"3" repeat:NO], @"3 starts the globe morph");
    [globeView advanceDisplay:0.3];
    Check(fabs(globeView.camera.globe - 0.5) < 1e-9, @"the 2D/3D morph is halfway at 0.3 s");
    Check(fabs(globeView.camera.pitch - 0.5 * 1.30) < 1e-9, @"the globe morph carries continuous tilt");
    Check(globeView.fractionalStep == 1.5, @"the morph does not touch the playhead");
    globeView.reducedMotionOverride = @YES;
    Check([globeView handleGlobeKey:@"2" repeat:NO], @"2 returns to the flat map");
    Check(fabs(globeView.camera.globe) < 1e-9, @"reduced motion reaches the flat map immediately");
    Check(fabs(globeView.camera.pitch) < 1e-9, @"returning overhead clears tilt");
    Check(![globeView handleGlobeKey:@"3" repeat:YES], @"a key repeat does not restart the morph");

    NSSlider *slider = nil;
    for (NSView *child in globeView.subviews)
        if ([child.accessibilityIdentifier isEqual:@"gpumap.globe"]) slider = (NSSlider *)child;
    Check(slider != nil, @"the 2D/3D slider is on the map");
    Check(!slider.enabled, @"the 2D/3D slider is disabled in 2D");
    Check([globeView handleGlobeKey:@"3" repeat:NO], @"selecting 3D enables the tilt slider");
    slider.doubleValue = 0.5;
    [slider sendAction:slider.action to:slider.target];
    Check(fabs(globeView.camera.globe - 0.5) < 1e-9, @"the slider sets an intermediate globe");
    Check(fabs(globeView.camera.pitch - 0.5 * 1.30) < 1e-9, @"the slider sets matching tilt");
}

static void CheckStates(GPUMapView *view) {
    view.stale = YES;
    view.unavailable = NO;
    NSTextField *stale = nil, *missing = nil;
    for (NSView *child in view.subviews) {
        if ([child.accessibilityIdentifier isEqual:@"gpumap.stale"]) stale = (NSTextField *)child;
        if ([child.accessibilityIdentifier isEqual:@"gpumap.unavailable"]) missing = (NSTextField *)child;
    }
    Check(view.stale && !stale, @"age stays off the map; the header carries it");
    Check(missing.hidden, @"a stale run is still the map");
    view.unavailable = YES;
    Check(missing && !missing.hidden && [missing.stringValue isEqual:@"Chart unavailable"],
        @"a cold failure shows Chart unavailable");
    NSUInteger renders = view.renderCount;
    [view advanceDisplay:0.1];
    Check(view.renderCount == renders, @"unavailable does not invent a field");
}

static void CheckToggleAndLayers(void) {
    NSString *suite = [@"com.isobar.gpumap." stringByAppendingString:NSUUID.UUID.UUIDString];
    NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:suite];
    [defaults removeObjectForKey:GPUMapEnabledKey];
    Check(GPUMapEnabledInDefaults(defaults), @"a new install opens on the new map");
    Check(GPUMapSurfaceFor(YES, YES) == GPUMapSurfaceNew, @"the expanded window uses the new map");
    GPUMapSetEnabled(defaults, NO);
    Check(!GPUMapEnabledInDefaults(defaults), @"the switch turns the new map off");
    Check(GPUMapSurfaceFor(NO, YES) == GPUMapSurfaceClassic, @"off restores the classic chart");
    GPUMapSetEnabled(defaults, YES);
    Check(GPUMapEnabledInDefaults(defaults) && GPUMapSurfaceFor(YES, YES) == GPUMapSurfaceNew,
        @"turning the new map back on restores it");
    Check(GPUMapSurfaceFor(YES, NO) == GPUMapSurfaceUnavailable &&
        GPUMapSurfaceFor(NO, NO) == GPUMapSurfaceUnavailable,
        @"no chart is Chart unavailable on either surface");
    [defaults removePersistentDomainForName:suite];

    Check([GPUMapMenuTitle(@"Wind direction", NO, YES) isEqual:@"Wind direction"],
        @"wind barbs are available on the GPU map");
    Check([GPUMapMenuTitle(@"Place readings", YES, YES) isEqual:@"Place readings — Classic map only"],
        @"place readings say Classic map only");
    Check([GPUMapMenuTitle(@"Wind direction", YES, NO) isEqual:@"Wind direction"],
        @"the classic map keeps the plain layer name");
    Check([GPUMapMenuTitle(@"Rain · 24-hour total", NO, YES) isEqual:@"Rain · 24-hour total"],
        @"a GPU colour field is not marked classic-only");
    Check(!GPUMapTagIsClassicOnly(3) && GPUMapTagIsClassicOnly(10) && GPUMapTagIsClassicOnly(14),
        @"wind barbs are available and place readings remain classic-only");
    Check(!GPUMapTagIsClassicOnly(0) && !GPUMapTagIsClassicOnly(1) && !GPUMapTagIsClassicOnly(2) &&
        !GPUMapTagIsClassicOnly(5) && !GPUMapTagIsClassicOnly(6),
        @"pressure, rain, wind speed and both temperatures are on the new map");
}

static NSView *FindID(NSView *root, NSString *ident) {
    if ([root.accessibilityIdentifier isEqualToString:ident]) return root;
    for (NSView *sub in root.subviews) {
        NSView *found = FindID(sub, ident);
        if (found) return found;
    }
    return nil;
}

static int CompareDouble(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static double Percentile(const double *values, int count, double p) {
    if (count < 1) return NAN;
    double *sorted = malloc((size_t)count * sizeof(double));
    if (!sorted) return NAN;
    memcpy(sorted, values, (size_t)count * sizeof(double));
    qsort(sorted, (size_t)count, sizeof(double), CompareDouble);
    int index = (int)llround((count - 1) * p);
    if (index < 0) index = 0;
    if (index >= count) index = count - 1;
    double value = sorted[index];
    free(sorted);
    return value;
}

typedef struct { double lat, lon, level; int n; } LineMark;

static void CollectLines(GPUMapView *view, LineMark **out, int *count) {
    NSInteger lines = view.contourLineCount;
    LineMark *marks = lines > 0 ? calloc((size_t)lines, sizeof(LineMark)) : NULL;
    int n = 0;
    for (NSInteger i = 0; i < lines; i++) {
        NSInteger verts = [view contourVertexCountForLine:i];
        if (verts < 2) continue;
        double latSum = 0, lonSum = 0;
        int kept = 0;
        for (NSInteger j = 0; j < verts; j++) {
            double lat = 0, lon = 0;
            if (![view contourVertexForLine:i index:j latitude:&lat longitude:&lon]) continue;
            latSum += lat;
            lonSum += lon;
            kept++;
        }
        if (kept < 2) continue;
        marks[n++] = (LineMark){latSum / kept, lonSum / kept, 0, kept};
    }
    *out = marks;
    *count = n;
}

// Mean geographic shift of each isobar that continues from the previous frame,
// measured at its vertex centroid. A rigid translation moves every vertex by
// this much. A line that has just entered the grid has no previous position.
static double MeanLineShift(LineMark *prev, int nPrev, LineMark *now, int nNow) {
    if (nPrev < 1 || nNow < 1) return -1;
    double sum = 0, worst = 0;
    int matched = 0;
    for (int i = 0; i < nNow; i++) {
        double best = 1e9;
        for (int j = 0; j < nPrev; j++) {
            double d = hypot(now[i].lat - prev[j].lat, MapWrap180(now[i].lon - prev[j].lon));
            if (d < best) best = d;
        }
        if (best > worst) worst = best;
        if (best < 0.5) {
            sum += best;
            matched++;
        }
    }
    if (matched < 1 || matched < nNow - 1) return worst;
    return sum / matched;
}

static void CheckSmoothClock(GPUMapView *view, IsobarLivePlayer *player, IsobarLiveClock *clock,
    double hz, double speed) {
    [player pause];
    player.hoursPerSecond = speed / 60.0;
    NSDate *start = [NSDate dateWithTimeIntervalSince1970:1700000000];
    [player configureRun:nil start:start end:[start dateByAddingTimeInterval:48 * 3600]
        now:start modelIndex:^double(NSDate *date) {
            return [date timeIntervalSinceDate:start] / (3.0 * 3600.0);
        }];
    [player playFromDate:start];
    NSTimeInterval origin = [clock now];
    view.fractionalStep = 0;
    int frames = (int)llround(hz * 5.0);
    int tickEvery = (int)llround(hz / 30.0);
    if (tickEvery < 1) tickEvery = 1;
    double *steps = calloc((size_t)frames, sizeof(double));
    double *shift = calloc((size_t)(frames > 1 ? frames - 1 : 1), sizeof(double));
    double *ms = calloc((size_t)frames, sizeof(double));
    LineMark *previous = NULL;
    int nPrevious = 0;
    int shifts = 0;
    int plateaus = 0;
    BOOL drew = NO;
    for (int i = 0; i < frames; i++) {
        @autoreleasepool {
            if (i > 0 && i % tickEvery == 0) {
                [clock advance:1.0 / 30.0];
                [player tick:1.0 / 30.0];
                // The installed build pushes the playhead from this 30 Hz tick.
                view.fractionalStep = [player modelIndexAtTime:[clock now]];
            }
            [view displayAtTime:origin + (NSTimeInterval)i / hz];
            steps[i] = view.renderedStep;
            ms[i] = view.lastFrameMilliseconds;
            if (i > 0 && !(steps[i] > steps[i - 1])) plateaus++;
            LineMark *lines = NULL;
            int nLines = 0;
            CollectLines(view, &lines, &nLines);
            if (nLines > 0) drew = YES;
            if (i > 0) shift[shifts++] = MeanLineShift(previous, nPrevious, lines, nLines);
            free(previous);
            previous = lines;
            nPrevious = nLines;
        }
    }
    free(previous);
    double median = Percentile(shift, shifts, 0.5);
    double peak = Percentile(shift, shifts, 1);
    double mean = 0, var = 0;
    int finite = 0;
    for (int i = 0; i < shifts; i++) {
        if (!(shift[i] >= 0)) continue;
        mean += shift[i];
        finite++;
    }
    if (finite) mean /= finite;
    for (int i = 0; i < shifts; i++) {
        if (!(shift[i] >= 0)) continue;
        double d = shift[i] - mean;
        var += d * d;
    }
    double cv = finite && mean > 0 ? sqrt(var / finite) / mean : INFINITY;
    double p95 = Percentile(ms, frames, 0.95);
    double timeMedian = Percentile(ms, frames, 0.5);
    BOOL increasing = plateaus == 0 && steps[frames - 1] > steps[0];
    BOOL smooth = isfinite(cv) && cv < 0.15 && median > 0 && peak <= median * 2.0;
    NSString *label = [NSString stringWithFormat:@"%.0f Hz %.0fx", hz, speed];
    fprintf(stderr, "    %s step %.5f→%.5f plateaus %d cv %.3f peak/median %.2f frame ms median %.2f p95 %.2f\n",
        label.UTF8String, steps[0], steps[frames - 1], plateaus,
        cv, median > 0 ? peak / median : INFINITY, timeMedian, p95);
    Check(drew, [label stringByAppendingString:@" draws isobars"]);
    Check(increasing, [label stringByAppendingString:@" fractional step increases every frame"]);
    Check(smooth, [label stringByAppendingString:@" isobar motion stays even"]);
    Check(p95 < 4, [label stringByAppendingString:@" main-thread p95 stays under 4 ms"]);
    free(steps);
    free(shift);
    free(ms);
}

static void CheckSmoothIsobars(void) {
    GPUMapView *view = [GPUMapView mapView];
    Check(view != nil, @"smoothness view is available");
    if (!view) return;
    view.frame = NSMakeRect(0, 0, 400, 300);
    IsobarGeoGrid grid = {
        .west = 110, .north = -10, .step = 0.5, .nLon = 40, .nLat = 50, .wrapsLongitude = NO
    };
    const int steps = 6;
    [view installGrid:grid steps:steps];
    Check(view.contoursAreSynchronous, @"the Australian-sized grid contours on the frame");
    size_t n = (size_t)grid.nLon * (size_t)grid.nLat;
    for (int step = 0; step < steps; step++) {
        float *values = calloc(n, sizeof(float));
        double front = -18.0 - 2.0 * step;
        for (int j = 0; j < grid.nLat; j++) {
            double lat = grid.north - j * grid.step;
            for (int i = 0; i < grid.nLon; i++)
                values[(size_t)j * (size_t)grid.nLon + (size_t)i] = (float)(1012.0 + 2.0 * (lat - front));
        }
        NSError *error = nil;
        Check([view uploadStep:step kind:IsobarFieldPressure values:values error:&error],
            error.localizedDescription ?: @"front upload");
        free(values);
    }
    [view waitForUploads];
    view.camera = MapCameraMake(-24, 120, 8, 0, 400, 300);
    IsobarLiveClock *clock = [IsobarLiveClock manualClock];
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    player.clock = clock;
    view.timeline = player;
    CheckSmoothClock(view, player, clock, 120, 8);
    CheckSmoothClock(view, player, clock, 120, 64);
    CheckSmoothClock(view, player, clock, 60, 8);
    CheckSmoothClock(view, player, clock, 60, 64);
    IsobarGeoGrid world = {
        .west = -180, .north = 90, .step = 0.25, .nLon = 1440, .nLat = 721, .wrapsLongitude = YES
    };
    [view installGrid:world steps:1];
    Check(!view.contoursAreSynchronous, @"a world grid stays on the async contour path");
}

static void CheckPopoverChrome(GPUMapView *view) {
    view.frame = NSMakeRect(0, 0, 762, 584);
    view.popoverChrome = YES;
    [view frameAustralia];
    NSView *flat = FindID(view, @"gpumap.flat");
    NSView *sphere = FindID(view, @"gpumap.sphere");
    NSView *recenter = FindID(view, @"gpumap.recenter");
    Check(!flat.hidden && !sphere.hidden, @"the popover exposes compact tilt controls");
    Check([flat.accessibilityLabel isEqual:@"2D map"] &&
        [sphere.accessibilityLabel isEqual:@"3D map"], @"mode controls have map accessibility labels");
    Check(recenter.hidden && !view.userMovedMap, @"Recenter stays hidden until the map moves");
    IsobarCamera framed = view.camera;
    struct { double lat, lon; const char *name; } corners[] = {
        {-10.68, 142.53, "Cape York"},
        {-43.64, 146.83, "Tasmania"},
        {-26.15, 113.16, "Steep Point"},
        {-28.63, 153.64, "Cape Byron"},
        {-31.95, 115.86, "Perth"},
        {-33.87, 151.21, "Sydney"},
    };
    BOOL framedOK = YES;
    for (int i = 0; i < 6; i++) {
        double x = 0, y = 0;
        double insetX = framed.viewportW * 0.02, insetY = framed.viewportH * 0.02;
        if (!IsobarCameraProject(framed, corners[i].lat, corners[i].lon, &x, &y) ||
            x < insetX || y < insetY || x > framed.viewportW - insetX || y > framed.viewportH - insetY) {
            fprintf(stderr, "frame %s at %.1f,%.1f\n", corners[i].name, x, y);
            framedOK = NO;
        }
    }
    Check(framedOK, @"the popover frames mainland Australia and Tasmania with a margin");
    IsobarCamera held = view.camera;
    [view setPlaceLatitude:-31.95 longitude:115.86];
    Check(fabs(view.camera.centreLat - held.centreLat) < 1e-9 &&
        fabs(view.camera.centreLon - held.centreLon) < 1e-9 &&
        fabs(view.camera.zoom - held.zoom) < 1e-9,
        @"a location update leaves the camera where the user put it");
    __block NSInteger clicks = 0;
    view.onPlainClick = ^{ clicks++; };
    [view pointerDown:NSMakePoint(300, 240)];
    [view pointerDrag:NSMakePoint(360, 180)];
    [view pointerUp:NSMakePoint(360, 180)];
    Check(clicks == 0 && view.userMovedMap, @"a drag pans and does not return to now");
    Check(!FindID(view, @"gpumap.recenter").hidden, @"Recenter appears after the drag");
    double lat = 0, lon = 0;
    Check(IsobarCameraUnproject(view.camera, 300 * view.camera.viewportW / 762.0,
        240 * view.camera.viewportH / 584.0, &lat, &lon), @"the dragged map still unprojects");
    [view recenter];
    Check(!view.userMovedMap && FindID(view, @"gpumap.recenter").hidden,
        @"Recenter puts the camera back and hides itself");
    double capeX = 0, capeY = 0;
    Check(IsobarCameraProject(view.camera, -10.68, 142.53, &capeX, &capeY) &&
        capeX > 0 && capeY > 0 && capeX < view.camera.viewportW && capeY < view.camera.viewportH &&
        IsobarCameraProject(view.camera, -43.64, 146.83, &capeX, &capeY) &&
        capeX > 0 && capeY > 0 && capeX < view.camera.viewportW && capeY < view.camera.viewportH,
        @"popover Recenter frames Australia again");
    double zoom = view.camera.zoom;
    NSEvent *key = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:NSEventModifierFlagCommand timestamp:0 windowNumber:0 context:nil
        characters:@"=" charactersIgnoringModifiers:@"=" isARepeat:NO keyCode:24];
    [view keyDown:key];
    Check(view.camera.zoom > zoom * 1.2 && view.userMovedMap, @"command-plus zooms the popover map");
    view.frame = NSMakeRect(0, 0, 420, 760);
    view.popoverChrome = YES;
    [view recenter];
    double southLat = 0, southLon = 0, northLat = 0, northLon = 0, westLat = 0, westLon = 0;
    IsobarCamera tall = view.camera;
    Check(IsobarCameraUnproject(tall, tall.viewportW * 0.5, tall.viewportH - 0.5, &southLat, &southLon)
        && southLat >= -50.05 && southLat <= -42.0,
        [NSString stringWithFormat:@"a tall popover stays inside southern coverage (%.2f)", southLat]);
    double bandLat = 0, bandLon = 0;
    Check(IsobarCameraUnproject(tall, tall.viewportW * 0.5, tall.viewportH - 12.0, &bandLat, &bandLon)
        && bandLat >= -50.0,
        [NSString stringWithFormat:@"a tall popover keeps the bottom 12 px on the grid (%.2f)", bandLat]);
    Check(IsobarCameraUnproject(tall, tall.viewportW * 0.5, 0.5, &northLat, &northLon) && northLat <= 0.15,
        [NSString stringWithFormat:@"a tall popover stays inside northern coverage (%.2f)", northLat]);
    Check(IsobarCameraUnproject(tall, 0.5, tall.viewportH * 0.5, &westLat, &westLon) && westLon >= 94.9,
        [NSString stringWithFormat:@"a tall popover stays inside western coverage (%.2f)", westLon]);
    double tx = 0, ty = 0;
    Check(IsobarCameraProject(tall, -43.64, 146.83, &tx, &ty) && ty > 0 && ty < tall.viewportH &&
        IsobarCameraProject(tall, -10.68, 142.53, &tx, &ty) && ty > 0 && ty < tall.viewportH,
        @"Tasmania and Cape York stay in a tall frame");
    IsobarGeoGrid australia = {
        .west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO
    };
    [view installGrid:australia steps:1];
    view.frame = NSMakeRect(0, 0, 794, 680);
    view.popoverChrome = YES;
    [view frameAustralia];
    IsobarCamera stale = view.camera;
    stale.centreLat = -33.87;
    stale.centreLon = 151.21;
    stale.zoom = 6;
    view.camera = stale;
    double before = 0, beforeLon = 0, after = 0, afterLon = 0;
    IsobarCameraUnproject(stale, stale.viewportW * 0.5, stale.viewportH - 12.0, &before, &beforeLon);
    CGImageRef shot = [view copySnapshot];
    if (shot) CGImageRelease(shot);
    IsobarCamera fixed = view.camera;
    Check(before < -50.0 &&
        IsobarCameraUnproject(fixed, fixed.viewportW * 0.5, fixed.viewportH - 12.0, &after, &afterLon) &&
        after >= -50.0,
        [NSString stringWithFormat:@"a stale popover camera refits the bottom 12 px inside coverage (%.2f -> %.2f)",
            before, after]);
    view.popoverChrome = NO;
    [view resetZoom];
    [view zoomBy:1.25];
    Check(!view.userMovedMap, @"expanded zoom does not count as a popover move");
    view.popoverChrome = YES;
    [view frameAustralia];
    IsobarCamera opened = view.camera;
    double openedLat = 0, openedLon = 0;
    Check(IsobarCameraUnproject(opened, opened.viewportW * 0.5, opened.viewportH - 12.0, &openedLat, &openedLon)
        && openedLat >= -50.0,
        [NSString stringWithFormat:@"opening the popover frames inside coverage after an expanded zoom (%.2f)",
            openedLat]);
}

static BOOL WriteWindow(NSString *path, NSString *switchTitle, CGImageRef field) {
    NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 1280, 720)];
    root.wantsLayer = YES;
    root.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    NSTextField *toggle = [NSTextField labelWithString:switchTitle];
    toggle.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    toggle.frame = NSMakeRect(24, 16, 280, 22);
    [root addSubview:toggle];
    NSView *well = [[NSView alloc] initWithFrame:NSMakeRect(16, 150, 1248, 500)];
    well.wantsLayer = YES;
    if (field) {
        NSImage *image = [[NSImage alloc] initWithCGImage:field size:NSMakeSize(1248, 500)];
        NSImageView *picture = [NSImageView imageViewWithImage:image];
        picture.frame = well.bounds;
        picture.imageScaling = NSImageScaleAxesIndependently;
        [well addSubview:picture];
    } else {
        well.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    }
    [root addSubview:well];
    NSBitmapImageRep *rep = [root bitmapImageRepForCachingDisplayInRect:root.bounds];
    [root cacheDisplayInRect:root.bounds toBitmapImageRep:rep];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return [png writeToFile:path atomically:YES];
}

static void WriteShots(GPUMapView *view, NSString *fixture) {
    view.unavailable = NO;
    view.stale = NO;
    IsobarGeoGrid grid = {0};
    NSArray<NSData *> *steps = nil;
    if (!LoadFixture(fixture, &grid, &steps) || steps.count < 2) {
        Check(NO, @"field fixture loads");
        return;
    }
    [view installGrid:grid steps:steps.count];
    NSError *error = nil;
    for (NSUInteger i = 0; i < steps.count; i++) {
        const float *values = ((NSData *)steps[i]).bytes;
        if (![view uploadStep:(NSInteger)i kind:IsobarFieldPressure values:values error:&error]) {
            Check(NO, error.localizedDescription ?: @"pressure upload");
            return;
        }
    }
    [view waitForUploads];
    view.frame = NSMakeRect(0, 0, 960, 600);
    view.fractionalStep = 0.5;
    NSString *dir = @"build/qa/gpumap";
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    NSArray *shots = @[
        @[@"new-flat.png", @0.0],
        @[@"new-halfway.png", @0.5],
        @[@"new-globe.png", @1.0],
        @[@"tilted-regional.png", @1.0, @0.6],
        @[@"tilted-globe.png", @1.0, @1.3],
    ];
    for (NSArray *shot in shots) {
        double globe = [shot[1] doubleValue];
        IsobarCamera camera = MapCameraMake(-33.5, 138, 4.5, globe, 960, 600);
        camera.pitch = shot.count > 2 ? [shot[2] doubleValue] : 0;
        view.camera = IsobarCameraClamp(camera);
        CGImageRef image = [view copySnapshot];
        NSString *path = [dir stringByAppendingPathComponent:shot[0]];
        BOOL wrote = image && WriteWindow(path, @"New map on", image);
        CGImageRelease(image);
        Check(wrote, [@"wrote " stringByAppendingString:shot[0]]);
    }
    // Classic chart stays the Core Graphics view. This frame is the expanded
    // window with that surface selected, so the GPU field is not drawn.
    Check(WriteWindow([dir stringByAppendingPathComponent:@"classic-off.png"], @"New map off", NULL),
        @"wrote classic-off.png");
}

@interface OcclusionProbeWindow : NSWindow
@property BOOL scriptOcclusion;
@property NSWindowOcclusionState scriptedOcclusion;
@end
@implementation OcclusionProbeWindow
- (NSWindowOcclusionState)occlusionState {
    if (self.scriptOcclusion) return self.scriptedOcclusion;
    return [super occlusionState];
}
@end

static void PostOcclusion(NSWindow *window) {
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeOcclusionStateNotification object:window];
}

static void CheckPresentSurvives(void) {
    GPUMapView *view = [GPUMapView mapView];
    Check(view != nil, @"presentation view is available");
    if (!view) return;
    view.frame = NSMakeRect(0, 0, 400, 300);
    IsobarGeoGrid grid = {
        .west = 110, .north = -10, .step = 0.5, .nLon = 40, .nLat = 50, .wrapsLongitude = NO
    };
    [view installGrid:grid steps:2];
    size_t n = (size_t)grid.nLon * (size_t)grid.nLat;
    for (int step = 0; step < 2; step++) {
        float *values = calloc(n, sizeof(float));
        double front = -18.0 - 2.0 * step;
        for (int j = 0; j < grid.nLat; j++) {
            double lat = grid.north - j * grid.step;
            for (int i = 0; i < grid.nLon; i++)
                values[(size_t)j * (size_t)grid.nLon + (size_t)i] = (float)(1012.0 + 2.0 * (lat - front));
        }
        NSError *error = nil;
        Check([view uploadStep:step kind:IsobarFieldPressure values:values error:&error], @"presentation upload");
        free(values);
    }
    view.camera = MapCameraMake(-24, 120, 8, 0, 400, 300);
    view.fractionalStep = 0.4;
    OcclusionProbeWindow *window = [[OcclusionProbeWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 420, 320)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    [window orderBack:nil];
    [window.contentView addSubview:view];
    Check(view.presentedCount >= 1 && !view.presentedFrameBlank,
        @"an ordered window presents a frame without waiting for occlusion");
    window.scriptOcclusion = YES;
    window.scriptedOcclusion = NSWindowOcclusionStateVisible;
    PostOcclusion(window);
    window.scriptedOcclusion = 0;
    PostOcclusion(window);
    NSUInteger covered = view.presentedCount;
    window.scriptedOcclusion = NSWindowOcclusionStateVisible;
    PostOcclusion(window);
    Check(view.presentedCount > covered && !view.presentedFrameBlank, @"becoming visible presents again");
    covered = view.presentedCount;
    view.hidden = YES;
    view.hidden = NO;
    Check(view.presentedCount > covered && !view.presentedFrameBlank, @"unhide presents a frame");
    covered = view.presentedCount;
    [view setFrameSize:NSMakeSize(360, 260)];
    Check(view.presentedCount > covered && !view.presentedFrameBlank, @"resize presents a frame");
    __block BOOL failed = NO;
    view.onPresentFailed = ^{ failed = YES; };
    view.suppressPresentation = YES;
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.7]];
    Check(failed, @"no presented frame within 0.5 s reports failure");
    // A busy main thread (a world rain field being prepared after a lens
    // click) delays the timer. That is not a Metal failure: re-arm, so the
    // map does not fall back to the classic whole-earth chart (8 Oct).
    failed = NO;
    view.suppressPresentation = NO;
    view.suppressPresentation = YES;
    usleep(1100000);
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    Check(!failed, @"a late watchdog after a busy main thread re-arms instead of failing");
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.7]];
    Check(failed, @"the re-armed watchdog still reports a real failure");
    [window orderOut:nil];
    [window close];
}

static void CheckTrafficOverlay(GPUMapView *view) {
    view.frame=NSMakeRect(0,0,480,360); view.camera=MapCameraMake(-33,135,6,0,480,360);
    view.trafficSession=[TrafficTrackSession new]; view.trafficEnabled=YES; view.trafficIsNow=YES;
    NSDate *stamp=[NSDate date];
    view.trafficSnapshot=@{@"aircraft":@[
        @{@"hex":@"7c1234",@"callsign":@"TEST123",@"type":@"BE20",@"latitude":@-32.0,@"longitude":@116.0,@"pressureAltitudeFt":@12000,@"groundSpeedKt":@180,@"positionTime":stamp}]};
    Check(view.trafficSession.selectedHexes.count==0, @"map traffic feed starts with no selected aircraft");
    Check([view.trafficSession toggleSelectionForHex:@"7c1234"], @"map traffic session accepts a selection");
    double x=0,y=0; Check(IsobarCameraProject(view.camera,-32,116,&x,&y) && x>0 && y>0, @"traffic aircraft projects into the map camera");
    view.trafficIsNow=NO; Check(view.trafficSession.selectedHexes.count==1, @"selected history remains while forecast is shown");
    [view.trafficSession clearSelections]; Check(view.trafficSession.selectedHexes.count==0, @"map traffic clear removes every selection");
}

// A CB area says "low" only while the renderer draws an L near it. The low
// sits over open sea (40S 120E): inland, the chart's land mixing treats a
// tight low as a terrain reduction spike and places no L, so "trough" would
// be the right answer there.
static void CheckHazardLowFollowsDrawnCentre(void) {
    GPUMapView *view = [GPUMapView mapView];
    if (!view) { fprintf(stderr, "SKIP drawn-low integration: Metal unavailable\n"); return; }
    view.frame = NSMakeRect(0, 0, 640, 480);
    IsobarGeoGrid grid = {.west=100, .north=-10, .step=.5, .nLon=81, .nLat=81};
    size_t n = (size_t)grid.nLon * grid.nLat;
    NSMutableData *pressure = [NSMutableData dataWithLength:n * sizeof(float)];
    NSMutableData *cape = [NSMutableData dataWithLength:n * sizeof(float)];
    NSMutableData *rain = [NSMutableData dataWithLength:n * sizeof(float)];
    NSMutableData *cloud = [NSMutableData dataWithLength:n * sizeof(float)];
    float *p = pressure.mutableBytes, *c = cape.mutableBytes, *r = rain.mutableBytes, *k = cloud.mutableBytes;
    for (int j = 0; j < grid.nLat; j++) for (int i = 0; i < grid.nLon; i++) {
        size_t at = (size_t)j * grid.nLon + i;
        double dx = (i - 40) * grid.step, dy = (j - 60) * grid.step;
        p[at] = (float)(1016 - 16 * exp(-(dx * dx + dy * dy) / 36));
        c[at] = 1200; r[at] = 3; k[at] = 80;
    }
    NSArray *times = @[[NSDate dateWithTimeIntervalSince1970:1791244800]];
    IsobarHazardRun *hazard = [[IsobarHazardRun alloc] initWithGrid:grid times:times];
    [hazard setStep:0 mucape:c rain3h:r cloud:k gust:NULL mslp:p t850:NULL t2m:NULL u10:NULL v10:NULL];
    [view installGrid:grid steps:1];
    Check([view uploadStep:0 kind:IsobarFieldPressure values:p error:nil], @"closed-low pressure fixture uploads");
    [view waitForUploads];
    view.hazards = YES;
    [view setValue:hazard forKey:@"hazardRun"];
    [view setValue:times forKey:@"runTimes"];
    view.camera = MapCameraMake(-40, 120, 8, 0, 640, 480);
    CGImageRef shot = [view copySnapshot];
    IsobarHazardFrame *frame = [[view valueForKey:@"hazardFrames"] objectForKey:@0];
    Check(shot && frame.areas.count == 1 && [frame.areas.firstObject.causeHint hasPrefix:@"low"],
        @"a snapshot uses the renderer's visible L for the CB cause");
    if (shot) CGImageRelease(shot);
    NSString *tip = [view hazardTooltipAtPoint:NSMakePoint(320, 240)];
    Check([tip containsString:@"Why: low"], @"hover shares the drawn L cause");
    // Keep the CB area visible while taking its low centre out of the viewport.
    view.camera = MapCameraMake(-30, 136, 30, 0, 640, 480);
    shot = [view copySnapshot];
    Check(shot && [frame.areas.firstObject.causeHint hasPrefix:@"trough"],
        @"the same cached CB frame says trough once the L is no longer drawn");
    if (shot) CGImageRelease(shot);
    tip = [view hazardTooltipAtPoint:NSMakePoint(320, 240)];
    Check([tip containsString:@"Why: trough"], @"hover clears the previous low after panning");
    [view stopRendering];
}

// The hazard switch: fails closed without the CB grids, draws a SIGMET only
// while it is valid, and hover gives its text.
static void CheckHazards(void) {
    NSString *fixtures = NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] ?: @"Tests/fixtures";
    NSString *store = [fixtures stringByAppendingPathComponent:@"store"];
    NSString *error = nil;
    OwnRun *run = OwnRunLoad([store stringByAppendingPathComponent:@"ecmwf/20260925T18Z"],
        NSProcessInfo.processInfo.environment[@"ISOBAR_COAST"], &error);
    Check(run != nil, [NSString stringWithFormat:@"hazard fixture run loads (%@)", error]);
    if (!run) return;
    GPUMapView *view = [GPUMapView mapView];
    view.frame = NSMakeRect(0, 0, 640, 480);
    view.popoverChrome = YES;
    Check(!view.hazards, @"hazards are off by default");
    [view adoptRun:run temperature:0 windFill:NO rain:NO];
    [view waitForUploads];
    [view frameAustralia];
    view.fractionalStep = 0; // 26 Sep 00Z
    CGImageRef plain = [view copySnapshot];
    NSDictionary *feature = @{
        @"firName": @"YMMM MELBOURNE",
        @"raw": @"WSAU21 YMMC 252150\nYMMM SIGMET T01 VALID 252200/260400 YMMC-\nYMMM MELBOURNE FIR SEV TURB FCST WI "
                @"S3000 E13800 - S3600 E14600 - S3600 E13800 FL200/300 MOV E 20KT NC=",
        @"valid_from": @1790373600, @"valid_to": @1790395200,
    };
    view.hazardStoreRoot = store;
    view.sigmetProduct = @{@"features": @[]};
    view.hazards = YES;
    [view waitForHazards];
    Check(view.hazardsReady, @"the hazard load finishes on a store without CB grids");
    CGImageRef empty = [view copySnapshot];
    Check(view.hazardLabels.count == 0, @"no CB inputs and no SIGMET: nothing is drawn, not even the key");
    Check(plain && empty && CGImageGetWidth(plain) == CGImageGetWidth(empty), @"snapshots match in size");
    if (plain && empty) {
        CFDataRef a = CGDataProviderCopyData(CGImageGetDataProvider(plain));
        CFDataRef b = CGDataProviderCopyData(CGImageGetDataProvider(empty));
        size_t n = MIN(CFDataGetLength(a), CFDataGetLength(b));
        const uint8_t *pa = CFDataGetBytePtr(a), *pb = CFDataGetBytePtr(b);
        size_t diff = 0;
        for (size_t i = 0; i < n; i++) if (abs((int)pa[i] - (int)pb[i]) > 2) diff++;
        Check(diff == 0, [NSString stringWithFormat:@"an empty hazard layer leaves the map untouched (%zu bytes differ)", diff]);
        CFRelease(a); CFRelease(b);
    }
    if (plain) CGImageRelease(plain);
    if (empty) CGImageRelease(empty);
    view.sigmetProduct = @{@"features": @[feature]};
    CGImageRef shot = [view copySnapshot];
    Check([view.hazardLabels containsObject:@"SIGMET SEV TURB FL200–FL300 until 0400Z"],
        [NSString stringWithFormat:@"a valid SIGMET is labelled (%@)", view.hazardLabels]);
    Check([view.hazardLabels containsObject:@"SIGMET (official)"] && ![view.hazardLabels containsObject:@"CB potential (model)"],
        @"the key lists only what is drawn");
    if (shot) CGImageRelease(shot);
    double x = 0, y = 0;
    IsobarCameraProject(view.camera, -34.5, 140.0, &x, &y);
    CGFloat scale = view.window.backingScaleFactor > 1 ? view.window.backingScaleFactor : 1;
    NSString *tip = [view hazardTooltipAtPoint:NSMakePoint(x / scale, y / scale)];
    Check([tip containsString:@"SIGMET T01"] && [tip containsString:@"Severe turbulence, forecast"],
        [NSString stringWithFormat:@"hover inside the SIGMET gives its words (%@)", tip]);
    view.fractionalStep = 1; // 26 Sep 12Z: expired
    shot = [view copySnapshot];
    Check(view.hazardLabels.count == 0, @"an expired SIGMET is not drawn");
    if (shot) CGImageRelease(shot);
    view.hazards = NO;
    Check([view hazardTooltipAtPoint:NSMakePoint(x / scale, y / scale)] == nil, @"no hover text with the layer off");
}

// Snapshots use the same vector layers as the live surface, at either backing scale.
static NSUInteger SnapshotDifference(CGImageRef a, CGImageRef b) {
    if (!a || !b || CGImageGetWidth(a) != CGImageGetWidth(b) || CGImageGetHeight(a) != CGImageGetHeight(b)) return 0;
    CFDataRef x = CGDataProviderCopyData(CGImageGetDataProvider(a));
    CFDataRef y = CGDataProviderCopyData(CGImageGetDataProvider(b));
    NSUInteger changed = 0;
    const UInt8 *xp = CFDataGetBytePtr(x), *yp = CFDataGetBytePtr(y);
    for (CFIndex i = 0; i < MIN(CFDataGetLength(x), CFDataGetLength(y)); i++)
        if (abs(xp[i] - yp[i]) > 10) changed++;
    CFRelease(x); CFRelease(y);
    return changed;
}

static void CheckVectorSnapshots(void) {
    NSString *fixture = NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] ?: @"Tests/fixtures";
    OwnRun *run = OwnRunLoad([fixture stringByAppendingPathComponent:@"store/ecmwf/20260925T18Z"],
        NSProcessInfo.processInfo.environment[@"ISOBAR_COAST"], nil);
    Check(run != nil, @"vector snapshot fixture loads");
    if (!run) return;
    for (int scale = 1; scale <= 2; scale++) {
        SnapshotScaleMapView *view = [SnapshotScaleMapView mapView];
        view.testScale = scale;
        view.frame = NSMakeRect(0, 0, 480, 360);
        [view adoptRun:run temperature:0 windFill:NO rain:NO]; [view waitForUploads];
        IsobarCamera camera = MapCameraMake(-31.94, 115.97, 48, 1, 480 * scale, 360 * scale);
        camera.pitch = .6; view.camera = camera;
        CGImageRef plain = [view copySnapshot];
        view.windBarbs = YES;
        CGImageRef wind = [view copySnapshot];
        WindMapView *vectors = [view valueForKey:@"windView"];
        Check(plain && wind && CGImageGetWidth(wind) == (size_t)(480 * scale) &&
            CGImageGetHeight(wind) == (size_t)(360 * scale), @"vector snapshot preserves backing dimensions");
        Check(vectors.drawnCount > 0 && SnapshotDifference(plain, wind) > 30,
            [NSString stringWithFormat:@"%dx snapshot contains the actual wind vectors", scale]);
        view.windBarbs = NO;
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        view.atmosphereDate = [iso dateFromString:@"2026-09-27T12:00:00Z"];
        view.atmosphereLatitude = -31.94; view.atmosphereLongitude = 115.97;
        view.atmosphereProduct = @{@"model":@"fixture", @"elevation":@20,
            @"time":@[@"2026-09-27T12:00:00Z"],
            @"levels":@{@"850":@{@"height_m":@[@1500], @"wind_speed_kt":@[@22],
                @"wind_direction_deg":@[@250], @"vertical_velocity_ms":@[@.2]}}};
        CGImageRef atmosphere = [view copySnapshot];
        Check(SnapshotDifference(plain, atmosphere) > 30,
            [NSString stringWithFormat:@"%dx regional snapshot contains layered atmospheric vectors", scale]);
        Check(atmosphere && SnapshotDifference(plain, atmosphere) < CGImageGetWidth(atmosphere)*CGImageGetHeight(atmosphere)*.4,
            @"atmospheric overlay preserves the underlying map plate");
        if (plain) CGImageRelease(plain); if (wind) CGImageRelease(wind);
        if (atmosphere) CGImageRelease(atmosphere);
        [view stopRendering];
    }
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        CheckToggleAndLayers();
        CheckHazardLowFollowsDrawnCentre();
        GPUMapView *view = [GPUMapView mapView];
        Check(view != nil, @"Metal field view is available");
        if (!view) return 1;
        CheckTrafficOverlay(view);
        CheckPlayhead(view);
        CheckPopoverChrome(view);
        CheckSmoothIsobars();
        CheckPresentSurvives();
        CheckDragAndPinch(view);
        CheckPlaceAndGlobe(view);
        CheckStates(view);
        CheckHazards();
        CheckVectorSnapshots();
        NSString *fixture = NSProcessInfo.processInfo.environment[@"ISOBAR_FIELD_FIXTURE"] ?: @"Tests/fixtures/fieldrender";
        WriteShots(view, fixture);
        fprintf(stderr, "%s\n", failures ? "FAIL gpumap" : "ok  gpumap");
        return failures ? 1 : 0;
    }
}
