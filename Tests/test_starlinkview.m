#import "../Sources/starlinkview.h"

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static NSString *const kTLE =
    @"STARLINK-6285           \n"
    @"1 56405U 23061AH  26286.61286548 -.00001431  00000+0 -42482-4 0  9990\n"
    @"2 56405  43.0058  36.2811 0001512 271.3807  88.6871 15.27572128190200\n"
    @"STARLINK-35964          \n"
    @"1 66796U 25278F   26286.33652369  .00035575  00000+0  12950-2 0  9992\n"
    @"2 66796  43.0021 310.3178 0001915 301.2798  58.7866 15.27606406 48666\n";

static void Render(NSView *view, NSString *appearance) {
    view.appearance = [NSAppearance appearanceNamed:appearance];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view.appearance performAsCurrentDrawingAppearance:^{ [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep]; }];
    NSString *dir = NSProcessInfo.processInfo.environment[@"ISOBAR_QA_DIR"];
    if (dir.length) {
        NSString *name = [NSString stringWithFormat:@"starlink-lens-%@.png", appearance == NSAppearanceNameDarkAqua ? @"dark" : @"light"];
        [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES];
    }
}

int main(void) {
    @autoreleasepool {
        StarlinkCatalog *catalog = [StarlinkCatalog catalogWithText:kTLE];
        const StarlinkOrbit *orbit = [catalog orbitAtIndex:[catalog indexOfName:@"STARLINK-6285"]];
        double lat = -31.95, lon = 115.86;
        // A moment STARLINK-6285 is high over Perth.
        NSDate *now = nil;
        for (int k = 0; k < 2 * 86400 && !now; k += 5) {
            StarlinkLook look;
            NSDate *at = [NSDate dateWithTimeIntervalSince1970:(orbit->epochJD - 2440587.5) * 86400 + k];
            if (StarlinkLookAt(orbit, StarlinkJulianDate(at), lat, lon, 0, &look) && look.elevation > 50) now = at;
        }
        CHECK(now != nil, "no pass");
        StarlinkLensView *view = [[StarlinkLensView alloc] initWithFrame:NSMakeRect(0, 0, 320, 10)];
        CHECK([view fittingHeightForWidth:320] > 300 && [view fittingHeightForWidth:320] < 360, "height %.0f", [view fittingHeightForWidth:320]);
        [view setFrameSize:NSMakeSize(320, [view fittingHeightForWidth:320])];
        view.latitude = lat; view.longitude = lon; view.now = now;

        // Nothing yet: the reasons are short, numbers are dashes.
        Render(view, NSAppearanceNameAqua);
        CHECK([view.readings[@"serving"] isEqual:@"—"] && [view.readings[@"servingDatum"] isEqual:@"loading orbits"], "%s", view.readings.description.UTF8String);
        view.catalog = catalog;
        view.dishError = @"Dish not reachable";
        Render(view, NSAppearanceNameAqua);
        CHECK([view.readings[@"ping"] isEqual:@"—"] && [view.readings[@"pingDatum"] isEqual:@"no dish"], "%s", view.readings.description.UTF8String);
        CHECK(view.drawnSatellites >= 1, "satellites drawn %lu", (unsigned long)view.drawnSatellites);
        CHECK([view.toolTip containsString:@"Dish not reachable"], "tooltip");

        // Live: current serving satellite and link numbers.
        view.dishError = nil;
        view.status = @{@"pingMs": @24.6, @"downBps": @2.4e6, @"upBps": @8e5, @"azimuth": @-173.9, @"elevation": @64.1};
        NSTimeInterval slot = StarlinkSlotStart(now.timeIntervalSince1970);
        view.serving = @{@"name": @"STARLINK-6285", @"slot": @(slot), @"errorDeg": @1.2};
        Render(view, NSAppearanceNameAqua);
        Render(view, NSAppearanceNameDarkAqua);
        CHECK([view.readings[@"serving"] isEqual:@"6285"], "serving %s", view.readings.description.UTF8String);
        CHECK([view.readings[@"servingDatum"] hasPrefix:@"el "] && [view.readings[@"servingDatum"] hasSuffix:@" km"], "datum");
        CHECK([view.readings[@"ping"] isEqual:@"25 ms"] && [view.readings[@"pingDatum"] isEqual:@"↓2.4  ↑0.8 Mb/s"], "ping %s", view.readings.description.UTF8String);
        CHECK([view.readings[@"clock"] hasSuffix:@" s"], "clock");

        // An earlier slot's satellite is history, not the link.
        view.now = [now dateByAddingTimeInterval:40];
        Render(view, NSAppearanceNameAqua);
        CHECK([view.readings[@"servingDatum"] hasSuffix:@"s ago"], "stale %s", view.readings.description.UTF8String);
        NSDictionary *state = StarlinkServingState(catalog, view.serving, view.now, lat, lon);
        CHECK(![state[@"current"] boolValue] && [state[@"age"] doubleValue] > 20, "state");
    }
    if (failures) { fprintf(stderr, "%d starlink view failure(s)\n", failures); return 1; }
    puts("starlink view tests passed");
    return 0;
}
