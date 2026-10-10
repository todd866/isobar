// The sky section page in an offscreen WKWebView with the fixture store:
// the feed is built natively, the bundled renderer draws it, and what it drew
// (window.skyState) is read back. Needs ISOBAR_TRAINING_DIST=training/dist.
#import <Cocoa/Cocoa.h>
#import "skyview.h"
#import <math.h>

static int failures;
static void Check(BOOL ok, NSString *why) {
    if (!ok) { fprintf(stderr, "FAIL %s\n", why.UTF8String); failures++; }
}

static NSDictionary *ReadJSON(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    return [json isKindOfClass:NSDictionary.class] ? json : nil;
}

static BOOL PumpUntil(BOOL (^done)(void), NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && deadline.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    return done();
}

static id Evaluate(WKWebView *web, NSString *script) {
    __block id value = nil;
    __block BOOL done = NO;
    [web evaluateJavaScript:script completionHandler:^(id result, __unused NSError *error) { value = result; done = YES; }];
    PumpUntil(^BOOL { return done; }, 10);
    return value;
}

static NSDate *UTC(NSString *text) { return [[NSISO8601DateFormatter new] dateFromString:text]; }

// render.ts yForFt: log-like axis from the sea line (height − 16) to 4 px, FL450 at the top.
static double YForFt(double ft, double height) {
    double sea = height - (height < 80 ? 4 : 16);
    double f = log1p(fmax(0, ft) / 5000) / log1p(45000.0 / 5000);
    return sea - (sea - 4) * fmin(1.02, f);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        NSString *store = argc > 1 ? @(argv[1]) : @"Tests/fixtures/store";
        NSDictionary *aviation = ReadJSON([store stringByAppendingPathComponent:@"products/aviation/YPPH.json"]);
        NSDictionary *upper = ReadJSON([store stringByAppendingPathComponent:
            @"products/points/ecmwf_ifs025_upper/runs/2026-09-26T060000Z/YPPH.json"]);
        NSDictionary *ypph = @{@"code": @"YPPH", @"latitude": @(-31.9403), @"longitude": @115.967003};
        NSDate *metarTime = UTC(@"2026-09-26T12:00:00Z");
        Check(aviation && upper, @"fixture aviation and upper-air products load");

        // The feed, natively.
        NSDictionary *feed = SkySectionFeed(aviation, upper, ypph, metarTime);
        Check([feed[@"elevationFt"] isEqual:@67] && [feed[@"coastKm"] isEqual:@(-19)], @"YPPH elevation and coast");
        Check([feed[@"report"][@"metar"][@"raw"] hasPrefix:@"METAR YPPH"] && [feed[@"name"] isEqual:@"YPPH"], @"the METAR is fed");
        Check([feed[@"report"][@"taf"][@"from"] isEqual:@"2026-09-26T12:00:00Z"], @"the TAF validity is fed");
        NSArray *times = feed[@"profile"][@"time"];
        Check(times.count == 12 && [times[0] longLongValue] == 1790434800000LL, @"upper-air times are ms UTC");
        Check([feed[@"profile"][@"levels"] count] == 13 && [feed[@"profile"][@"levels"][0][@"hPa"] isEqual:@1000],
            @"13 levels, surface first");
        NSDictionary *other = SkySectionFeed(aviation, upper, @{@"code": @"YSSY", @"latitude": @(-33.9), @"longitude": @151.2}, metarTime);
        Check(other[@"report"] == NSNull.null && other[@"profile"] == NSNull.null, @"another aerodrome's products are not borrowed");
        NSMutableDictionary *gappy = [upper mutableCopy];
        NSMutableDictionary *levels = [upper[@"levels"] mutableCopy];
        NSMutableDictionary *low = [levels[@"1000"] mutableCopy];
        low[@"temperature_c"] = @[NSNull.null];
        levels[@"1000"] = low; gappy[@"levels"] = levels;
        NSDictionary *gapFeed = SkySectionFeed(aviation, gappy, ypph, metarTime);
        Check(gapFeed[@"profile"][@"levels"][0][@"t"][0] == NSNull.null && gapFeed[@"profile"][@"levels"][0][@"t"][11] == NSNull.null,
            @"missing values stay null");
        Check(SkySectionFeed(aviation, upper, @{}, metarTime) == nil, @"no aerodrome, no feed");
        // Any point: a profile and no report.
        NSDictionary *point = SkyPointFeed(-31.5, 116.5, @"Northam", 558, nil, upper, nil, metarTime);
        Check(point[@"report"] == NSNull.null && [point[@"profile"][@"levels"] count] == 13 && point[@"coastKm"] == NSNull.null,
            @"a plain point feeds its profile without a report");

        NSDictionary *unknown = SkyPointFeed(-31.5, 116.5, @"Unknown", NAN, nil, upper, aviation, metarTime);
        Check(unknown[@"elevationFt"] == NSNull.null && unknown[@"profile"][@"elevationFt"] == NSNull.null,
            @"unknown ground stays null through feed and profile");
        Check([NSJSONSerialization isValidJSONObject:unknown], @"unknown ground is valid JSON");
        NSMutableDictionary *lowercase = [aviation mutableCopy]; lowercase[@"icao"] = @"ypph";
        Check([SkySectionFeed(lowercase, upper, ypph, metarTime)[@"report"] isKindOfClass:NSDictionary.class],
            @"the primary report ICAO is case insensitive");
        [lowercase removeObjectForKey:@"icao"];
        NSMutableDictionary *lowerMetar = [aviation[@"metar"] mutableCopy]; lowerMetar[@"icao"] = @"ypph";
        lowercase[@"metar"] = lowerMetar;
        Check([SkySectionFeed(lowercase, upper, ypph, metarTime)[@"report"] isKindOfClass:NSDictionary.class],
            @"the fallback METAR ICAO is case insensitive");
        // Feed checks can run without WKWebView; the default still runs every page check.
        if (argc > 2 && [@(argv[2]) isEqual:@"--feed-only"]) {
            printf("sky feed failures: %d\n", failures); return failures ? 1 : 0;
        }

        NSString *root = SkySectionWebRoot();
        Check(root.length > 0, @"sky page is built (ISOBAR_TRAINING_DIST)");
        if (!root.length) { fprintf(stderr, "sky view failures: %d\n", failures); return 1; }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-24000, -24000, 420, 240)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.sharingType = NSWindowSharingNone;
        window.ignoresMouseEvents = YES;
        SkySectionView *sky = [[SkySectionView alloc] initWithFrame:NSMakeRect(0, 0, 420, 240)];
        Check(sky.webView == nil, @"no web view outside a window");
        [sky setAviation:aviation upper:upper aerodrome:ypph now:metarTime];
        sky.time = metarTime;
        window.contentView = sky;
        [window orderFrontRegardless];
        Check(sky.webView != nil, @"a web view in a window");
        CFTimeInterval t0 = CACurrentMediaTime();
        BOOL drew = PumpUntil(^BOOL { return [sky.drawnState[@"layers"] count] > 0; }, 20);
        printf("sky first state %.0f ms\n", (CACurrentMediaTime() - t0) * 1000);
        Check(drew, @"the page reported layers");
        NSDictionary *state = sky.drawnState;
        Check([state[@"source"] isEqual:@"METAR"], [NSString stringWithFormat:@"source %@", state[@"source"]]);
        Check([state[@"hasProfile"] boolValue], @"a profile 3 h after the time is used (nearest within 3 h)");
        NSMutableArray *bases = [NSMutableArray array];
        NSDictionary *sct = nil;
        for (NSDictionary *layer in state[@"layers"]) {
            if ([layer[@"source"] isEqual:@"model"]) continue;
            [bases addObject:@(llround([layer[@"baseFtAmsl"] doubleValue]))];
            if ([layer[@"cover"] isEqual:@"SCT"]) sct = layer;
        }
        Check([bases containsObject:@3467] && [bases containsObject:@7367],
            [NSString stringWithFormat:@"METAR SCT034 BKN073 at 67 ft: bases %@", [bases componentsJoinedByString:@","]]);
        double height = [state[@"height"] doubleValue];
        Check(height == 240 && [state[@"width"] doubleValue] == 420, @"the page fills the view");
        Check(sct && fabs([sct[@"baseY"] doubleValue] - YForFt(3467, height)) < 0.5,
            [NSString stringWithFormat:@"SCT base at y %.1f, axis says %.1f", [sct[@"baseY"] doubleValue], YForFt(3467, height)]);
        Check([state[@"freezingFt"] doubleValue] > 8000 && [state[@"freezingFt"] doubleValue] < 12000,
            [NSString stringWithFormat:@"freezing level %@ ft from the profile", state[@"freezingFt"]]);
        Check(PumpUntil(^BOOL { return [Evaluate(sky.webView, @"window.isobarSky.flush(), window.isobarSky.pictures()") integerValue] > 0; }, 10),
            @"the renderer built a picture");
        __block NSImage *shot = nil; __block BOOL shotDone = NO;
        [sky snapshotWithCompletion:^(NSImage *image) { shot = image; shotDone = YES; }];
        PumpUntil(^BOOL { return shotDone; }, 10);
        Check(shot.size.width >= 400, @"the page can be captured");
        if (argc > 2 && shot) {
            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:shot.TIFFRepresentation];
            [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@(argv[2]) atomically:YES];
        }

        // Before the first sample by more than 3 h: no model profile, one line.
        sky.time = UTC(@"2026-09-26T08:00:00Z");
        PumpUntil(^BOOL { return [sky.drawnState[@"timeMs"] doubleValue] == 1790409600000.0; }, 10);
        Check(![sky.drawnState[@"hasProfile"] boolValue] && [sky.drawnState[@"notes"] containsObject:@"No model profile at this time"],
            @"no profile beyond 3 h says so");
        Check([Evaluate(sky.webView, @"document.getElementById('note').hidden") boolValue] == NO, @"the note is shown");

        // A later time takes the TAF.
        sky.time = UTC(@"2026-09-26T18:00:00Z");
        PumpUntil(^BOOL { return [sky.drawnState[@"source"] isEqual:@"TAF"]; }, 10);
        Check([sky.drawnState[@"source"] isEqual:@"TAF"], @"later times use the TAF");

        // Scrubbing: 240 time changes coalesce; the page keeps up.
        NSDate *start = UTC(@"2026-09-26T12:00:00Z");
        t0 = CACurrentMediaTime();
        for (int i = 0; i < 240; i++) {
            sky.time = [start dateByAddingTimeInterval:i * 360];
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:1.0 / 120]];
        }
        double expected = round([start dateByAddingTimeInterval:239 * 360].timeIntervalSince1970 * 1000);
        PumpUntil(^BOOL { return [sky.drawnState[@"timeMs"] doubleValue] == expected; }, 10);
        printf("sky scrub 240 steps %.0f ms\n", (CACurrentMediaTime() - t0) * 1000);
        Check([sky.drawnState[@"timeMs"] doubleValue] == expected, @"the last scrub time is drawn");

        // Appearance.
        window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        PumpUntil(^BOOL { return [[Evaluate(sky.webView, @"document.documentElement.dataset.theme") description] isEqual:@"dark"]; }, 5);
        Check([[Evaluate(sky.webView, @"document.documentElement.dataset.theme") description] isEqual:@"dark"], @"dark follows the app");

        // Hidden: the web view goes.
        sky.hidden = YES;
        Check(sky.webView == nil, @"no web view while hidden");
        sky.hidden = NO;
        Check(sky.webView != nil, @"the web view returns when shown");
        [window orderOut:nil];
        window.contentView = [NSView new];
        Check(sky.webView == nil, @"no web view outside a window");
        [window close];
        printf("sky view failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
