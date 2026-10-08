// Hazard layer: CB gates, SIGMET parsing on real samples, frames and drawing.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import "hazard.h"
#import <math.h>

static int failures = 0;

static void check(BOOL ok, NSString *what) {
    if (!ok) {
        failures++;
        fprintf(stderr, "FAIL %s\n", what.UTF8String);
    }
}

static NSDate *Z(NSString *iso) {
    return [[NSISO8601DateFormatter new] dateFromString:iso];
}

static void TestGates(void) {
    // Each floor exactly, and a hair under each input.
    check(IsobarCBClassify(500, 1.0, 50) == IsobarCBPossible, @"possible at its floors");
    check(IsobarCBClassify(499, 1.0, 50) == IsobarCBNone, @"MUCAPE 499 is not possible");
    check(IsobarCBClassify(500, 0.99, 50) == IsobarCBNone, @"rain 0.99 mm/3 h is not possible");
    check(IsobarCBClassify(500, 1.0, 49.9) == IsobarCBNone, @"cloud 49.9 % is not possible");
    check(IsobarCBClassify(1000, 2.0, 70) == IsobarCBLikely, @"likely at its floors");
    check(IsobarCBClassify(1000, 1.99, 70) == IsobarCBPossible, @"rain under 2 mm stays possible");
    check(IsobarCBClassify(1000, 2.0, 69) == IsobarCBPossible, @"cloud under 70 % stays possible");
    check(IsobarCBClassify(1500, 2.0, 70) == IsobarCBSevere, @"severe risk at MUCAPE 1500");
    check(IsobarCBClassify(1499, 5.0, 100) == IsobarCBLikely, @"MUCAPE 1499 is likely, not severe");
    check(IsobarCBClassify(4000, 0.2, 100) == IsobarCBNone, @"dry high CAPE stays off");
    check(IsobarCBClassify(NAN, 3, 80) == IsobarCBMissing, @"missing MUCAPE is missing, not none");
    check(IsobarCBClassify(800, NAN, 80) == IsobarCBMissing, @"missing rain is missing");
    check(isnan(IsobarCBMargin(IsobarCBLikely, 800, 2, NAN)), @"margin is NAN when cloud is missing");
    check(fabs(IsobarCBMargin(IsobarCBPossible, 1000, 0.5, 100) - 0.5) < 1e-9, @"margin is the weakest ratio");
    check(isnan(IsobarRainWindow(5.0, 4.9)), @"a tp drop over 0.05 mm is a reset");
    check(IsobarRainWindow(5.0, 4.97) == 0, @"a small negative clamps to zero");
    check(fabs(IsobarRainWindow(5.0, 7.5) - 2.5) < 1e-9, @"rain window is the difference");
    check([IsobarCBCoverageWord(0.2) isEqual:@"ISOL"], @"20 % is ISOL");
    check([IsobarCBCoverageWord(0.5) isEqual:@"OCNL"], @"50 % is OCNL");
    check([IsobarCBCoverageWord(0.75) isEqual:@"FRQ"], @"75 % is FRQ");
    check([IsobarCBClassName(IsobarCBSevere) isEqual:@"severe risk"], @"severe risk in words");
    NSString *hint = IsobarCBCauseHint(0.6, 0, 0, 0, 0, 1812);
    check([hint isEqual:@"trough + MUCAPE 1,800 J/kg"], [NSString stringWithFormat:@"trough hint (%@)", hint]);
    hint = IsobarCBCauseHint(0.1, 0, 0.5, 0.4, 0, 950);
    check([hint isEqual:@"cold front + MUCAPE 1,000 J/kg"], [NSString stringWithFormat:@"cold front hint (%@)", hint]);
    hint = IsobarCBCauseHint(0.1, 0, 0.1, 0, 0, 640);
    check([hint isEqual:@"instability + moisture + MUCAPE 600 J/kg"], [NSString stringWithFormat:@"fallback hint (%@)", hint]);
    hint = IsobarCBCauseHint(0.9, 0.05, 0, 0, 0.5, 2000);
    check([hint hasPrefix:@"low + surface heating"], [NSString stringWithFormat:@"a low outranks a trough (%@)", hint]);
    check([IsobarCBCauseLesson(@"trough + MUCAPE 1,800 J/kg") containsString:@"converge"], @"trough lesson explains lift");
}

static NSArray *FixtureFeatures(void) {
    NSString *dir = [NSString stringWithUTF8String:getenv("ISOBAR_FIXTURES") ?: "Tests/fixtures"];
    NSData *data = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"hazard/sigmets.json"]];
    NSDictionary *product = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    return product[@"features"];
}

static IsobarSigmet *FindSigmet(NSArray<IsobarSigmet *> *all, NSString *sequence, NSString *fir) {
    for (IsobarSigmet *s in all)
        if ([s.sequence isEqual:sequence] && (!fir || [s.firName hasPrefix:fir])) return s;
    return nil;
}

static void TestSigmets(void) {
    NSArray *features = FixtureFeatures();
    check(features.count >= 10, @"SIGMET fixture loads");
    NSMutableArray<IsobarSigmet *> *all = [NSMutableArray array];
    for (NSDictionary *f in features) {
        IsobarSigmet *s = IsobarSigmetParse(f);
        check(s != nil, [NSString stringWithFormat:@"parses %@", [f[@"raw"] substringToIndex:MIN(40u, [f[@"raw"] length])]]);
        if (!s) continue;
        [all addObject:s];
        // Validity agrees with the product's own epoch seconds.
        check(fabs(s.validFrom.timeIntervalSince1970 - [f[@"valid_from"] doubleValue]) < 1 &&
              fabs(s.validTo.timeIntervalSince1970 - [f[@"valid_to"] doubleValue]) < 1,
            [NSString stringWithFormat:@"%@ validity matches the product (%@–%@)", s.sequence, s.validFrom, s.validTo]);
        // The polygon is in Australian FIR space and has the raw point count.
        NSString *raw = [[f[@"raw"] componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
            componentsJoinedByString:@" "];
        NSUInteger points = [[NSRegularExpression regularExpressionWithPattern:@"[NS]\\d{4} [EW]\\d{5}" options:0 error:nil]
            numberOfMatchesInString:raw options:0 range:NSMakeRange(0, raw.length)];
        check((NSUInteger)s.pointCount == points, [NSString stringWithFormat:@"%@ keeps all %lu points (%ld)",
            s.sequence, (unsigned long)points, (long)s.pointCount]);
        // Levels are a verbatim substring of the raw text.
        check(s.levels.length > 0 && [raw containsString:[NSString stringWithFormat:@" %@ ", s.levels]],
            [NSString stringWithFormat:@"%@ levels as written (%@)", s.sequence, s.levels]);
    }
    IsobarSigmet *ts = FindSigmet(all, @"M01", @"YBBB");
    check(ts != nil, @"the Brisbane thunderstorm SIGMET parses");
    if (ts) {
        check([ts.phenomenon isEqual:@"FRQ TSGR"], [NSString stringWithFormat:@"phenomenon as written (%@)", ts.phenomenon]);
        check([ts.status isEqual:@"OBS"], @"observed");
        check([ts.levels isEqual:@"TOP FL370"] && [ts.levelsLabel isEqual:@"TOP FL370"], @"TOP FL370 kept");
        check([ts.movement isEqual:@"MOV NE 10KT"] && [ts.change isEqual:@"INTSF"], @"movement and change");
        check(ts.pointCount == 6 && fabs([ts latitudeAtIndex:0] + (24 + 50 / 60.0)) < 1e-9 &&
              fabs([ts longitudeAtIndex:0] - (150 + 20 / 60.0)) < 1e-9, @"S2450 E15020 is 24°50'S 150°20'E");
        check([ts.validFrom isEqual:Z(@"2026-10-07T03:13:00Z")] && [ts.validTo isEqual:Z(@"2026-10-07T05:15:00Z")],
            @"VALID 070313/070515");
        check([[ts label] isEqual:@"SIGMET FRQ TSGR TOP FL370 until 0515Z"], [NSString stringWithFormat:@"label (%@)", [ts label]]);
        check([ts isValidAt:Z(@"2026-10-07T04:00:00Z")] && ![ts isValidAt:Z(@"2026-10-07T05:15:00Z")] &&
              ![ts isValidAt:Z(@"2026-10-07T03:12:00Z")], @"valid inside its window only");
        check([[ts tooltip] containsString:@"Frequent thunderstorms with hail, observed"] &&
              [[ts tooltip] containsString:@"Tops FL370"] && [[ts tooltip] containsString:ts.raw],
            @"tooltip decodes and keeps the raw text");
    }
    IsobarSigmet *turb = FindSigmet(all, @"W06", nil);
    check(turb && [turb.levels isEqual:@"FL200/400"] && [turb.levelsLabel isEqual:@"FL200–FL400"] &&
          [[turb label] isEqual:@"SIGMET SEV TURB FL200–FL400 until 0645Z"],
        [NSString stringWithFormat:@"FL200/400 reads FL200–FL400 (%@)", [turb label]]);
    IsobarSigmet *ice = FindSigmet(all, @"P01", @"YMMM MELBOURNE");
    for (IsobarSigmet *s in all) if ([s.phenomenon isEqual:@"SEV ICE"]) ice = s;
    check(ice && [ice.levels isEqual:@"7500FT/FL190"] && [ice.levelsLabel isEqual:@"7500FT–FL190"],
        [NSString stringWithFormat:@"FT stays FT (%@)", ice.levelsLabel]);
    check(ice && [ice.validTo timeIntervalSinceDate:ice.validFrom] == 4 * 3600 &&
          [ice.validTo isEqual:Z(@"2026-10-01T02:42:00Z")], @"validity across the month end");
    IsobarSigmet *sfc = nil;
    for (IsobarSigmet *s in all) if ([s.levels hasPrefix:@"SFC/"]) sfc = s;
    check(sfc && [sfc.levels isEqual:@"SFC/6000FT"] && [sfc.levelsLabel isEqual:@"SFC–6000FT"] &&
          [sfc.movement isEqual:@"STNR"] && [sfc.change isEqual:@"NC"], @"SFC/6000FT STNR NC");
    IsobarSigmet *embd = nil;
    for (IsobarSigmet *s in all) if ([s.phenomenon isEqual:@"EMBD TS"]) embd = s;
    check(embd && [embd.levels isEqual:@"TOP FL510"], @"EMBD TS TOP FL510");
    // The same polygon issued for two FIRs draws once.
    NSArray *product = IsobarSigmetsFromProduct(@{@"features": features});
    check(product.count == all.count - 1, [NSString stringWithFormat:@"duplicate FIR copy dropped (%lu of %lu)",
        (unsigned long)product.count, (unsigned long)all.count]);
    check(IsobarSigmetParse(@{@"raw": @"WSAU21 YMMC 070239 YMMM SIGMET W06 VALID 070245/070645 YMMC- SEV TURB"}) == nil,
        @"no polygon, no SIGMET");
}

static IsobarGeoGrid TestGrid(void) {
    return (IsobarGeoGrid){.west = 140, .north = -20, .step = 0.25, .nLon = 41, .nLat = 41, .wrapsLongitude = NO};
}

// Signed area of a lat/lon ring, positive anticlockwise seen north-up.
static double RingArea(IsobarHazardFrame *f, NSInteger ring, NSInteger level) {
    NSInteger n = [f vertexCountForRing:ring level:level];
    double a = 0;
    for (NSInteger i = 0; i < n; i++) {
        double la0, lo0, la1, lo1;
        [f vertexForRing:ring level:level index:i latitude:&la0 longitude:&lo0];
        [f vertexForRing:ring level:level index:(i + 1) % n latitude:&la1 longitude:&lo1];
        a += lo0 * la1 - lo1 * la0;
    }
    return a * 0.5;
}

static IsobarHazardRun *BlockRun(double cape, double rain, double cloud, int i0, int i1, int j0, int j1, BOOL sparse) {
    IsobarGeoGrid g = TestGrid();
    NSArray *times = @[Z(@"2026-10-06T00:00:00Z"), Z(@"2026-10-06T03:00:00Z"), Z(@"2026-10-06T06:00:00Z")];
    IsobarHazardRun *run = [[IsobarHazardRun alloc] initWithGrid:g times:times];
    size_t n = (size_t)g.nLon * g.nLat;
    float *c = malloc(n * 4), *r = malloc(n * 4), *k = malloc(n * 4), *zero = calloc(n, 4);
    for (int s = 0; s < 3; s++) {
        for (size_t i = 0; i < n; i++) { c[i] = 100; r[i] = 0; k[i] = 20; }
        if (s >= 1) {
            for (int j = j0; j < j1; j++)
                for (int i = i0; i < i1; i++) {
                    if (sparse && ((i + j) % 3 != 0)) continue;
                    size_t at = (size_t)j * g.nLon + i;
                    c[at] = (float)cape; r[at] = (float)rain; k[at] = (float)cloud;
                }
        }
        [run setStep:s mucape:c rain3h:r cloud:k gust:zero mslp:NULL t850:NULL t2m:NULL u10:NULL v10:NULL];
    }
    free(c); free(r); free(k); free(zero);
    return run;
}

static void TestFrames(void) {
    IsobarHazardRun *run = BlockRun(1800, 4, 90, 10, 20, 12, 22, NO);
    check(run.hasCBInputs, @"synthetic run has CB inputs");
    IsobarHazardFrame *none = [run frameAtStep:0];
    check(none.areas.count == 0 && [none ringCountForLevel:0] == 0, @"no area where nothing meets a gate");
    IsobarHazardFrame *f = [run frameAtStep:1];
    check(f.areas.count == 1, [NSString stringWithFormat:@"one solid block is one area (%lu)", (unsigned long)f.areas.count]);
    IsobarHazardArea *a = f.areas.firstObject;
    check(a.peakClass == IsobarCBSevere, @"MUCAPE 1800, 4 mm, 90 % is severe risk");
    check(a.possibleCells == 100 && a.areaCells == 144, [NSString stringWithFormat:@"10×10 cells, outline 12×12 (%ld, %ld)",
        (long)a.possibleCells, (long)a.areaCells]);
    check([a.coverageWord isEqual:@"OCNL"] && [[a label] isEqual:@"CB OCNL"], [NSString stringWithFormat:@"%@", [a label]]);
    check([f ringCountForLevel:0] == 1 && [f ringCountForLevel:1] == 1 && [f ringCountForLevel:2] == 1,
        @"one outline, one likely core, one severe core");
    check(RingArea(f, 0, 0) > 0, @"the outline runs with the area on its left (anticlockwise north-up)");
    // The outline sits between the dilated block and the next cell out.
    double area = fabs(RingArea(f, 0, 0)) / (0.25 * 0.25);
    check(area > 100 && area < 196, [NSString stringWithFormat:@"outline area %.0f cells", area]);
    check([f areaAtLatitude:-20 - 15 * 0.25 longitude:140 + 15 * 0.25] == a, @"area under its centre");
    check([f areaAtLatitude:-20 - 35 * 0.25 longitude:140 + 35 * 0.25] == nil, @"no area far away");
    check([a.causeHint isEqual:@"instability + moisture + MUCAPE 1,800 J/kg"], a.causeHint ?: @"nil hint");
    check([[a tooltip] containsString:@"model guidance, not a forecast or SIGMET"] &&
          [[a tooltip] containsString:@"Why: instability + moisture"], @"area tooltip names guidance and cause");
    // Time interpolation: halfway in, the block is half strength and the outline is smaller.
    IsobarHazardFrame *half = [run frameAtStep:0.75];
    double halfArea = [half ringCountForLevel:0] ? fabs(RingArea(half, 0, 0)) : 0;
    check(halfArea > 0 && halfArea < fabs(RingArea(f, 0, 0)), @"the outline grows continuously in time");
    // MUCAPE 100 + 0.75 × 1700 = 1375: likely, not yet severe.
    check(half.areas.count == 1 && half.areas.firstObject.peakClass == IsobarCBLikely,
        @"at 0.75 the interpolated block meets likely");
    IsobarHazardFrame *early = [run frameAtStep:0.2];
    check(early.areas.count == 0, @"at 0.2 the interpolated inputs meet no gate");
    // Sparse cells inside the same window: ISOL coverage.
    IsobarHazardRun *sparse = BlockRun(900, 1.5, 60, 8, 30, 8, 30, YES);
    IsobarHazardFrame *sf = [sparse frameAtStep:2];
    check(sf.areas.count == 1 && [sf.areas.firstObject.coverageWord isEqual:@"ISOL"] &&
          sf.areas.firstObject.peakClass == IsobarCBPossible,
        [NSString stringWithFormat:@"a third of the cells is ISOL, possible (%@)", [sf.areas.firstObject label]]);
    // Speckle: two lone cells are not an area.
    IsobarHazardRun *speck = BlockRun(900, 1.5, 60, 5, 7, 5, 6, NO);
    check([speck frameAtStep:2].areas.count == 0, @"two possible cells are speckle");
    // Missing input: missing stays missing, never drawn as an area.
    IsobarGeoGrid g = TestGrid();
    IsobarHazardRun *missing = [[IsobarHazardRun alloc] initWithGrid:g times:@[Z(@"2026-10-06T00:00:00Z")]];
    size_t n = (size_t)g.nLon * g.nLat;
    float *c = malloc(n * 4), *k = malloc(n * 4);
    for (size_t i = 0; i < n; i++) { c[i] = 3000; k[i] = 100; }
    [missing setStep:0 mucape:c rain3h:NULL cloud:k gust:NULL mslp:NULL t850:NULL t2m:NULL u10:NULL v10:NULL];
    check(!missing.hasCBInputs && [missing frameAtStep:0].areas.count == 0, @"no rain field, no CB");
    free(c); free(k);
}

static void TestDrawnLowAreaOwnership(void) {
    IsobarGeoGrid g = {.west=130, .north=-10, .step=.5, .nLon=81, .nLat=81};
    size_t n = (size_t)g.nLon * g.nLat;
    float *cape = calloc(n, sizeof(float)), *rain = calloc(n, sizeof(float)), *cloud = calloc(n, sizeof(float));
    for (int j = 0; j < g.nLat; j++) for (int i = 0; i < g.nLon; i++) {
        double lon = g.west + i * g.step, lat = g.north - j * g.step;
        double d = hypot(lon - 140, lat + 25);
        BOOL in = (d >= 4 && d <= 8) || hypot(lon - 157, lat + 25) <= 2;
        size_t at = (size_t)j * g.nLon + i;
        cape[at] = in ? 1200 : 0; rain[at] = in ? 3 : 0; cloud[at] = in ? 80 : 0;
    }
    IsobarHazardRun *run = [[IsobarHazardRun alloc] initWithGrid:g times:@[Z(@"2026-10-06T00:00:00Z")]];
    [run setStep:0 mucape:cape rain3h:rain cloud:cloud gust:NULL mslp:NULL t850:NULL t2m:NULL u10:NULL v10:NULL];
    free(cape); free(rain); free(cloud);
    IsobarHazardFrame *frame = [run frameAtStep:0];
    IsobarHazardArea *ring = [frame areaAtLatitude:-25 longitude:146];
    IsobarHazardArea *island = [frame areaAtLatitude:-25 longitude:157];
    check(frame.areas.count == 2 && ring && island && ring != island && [frame ringCountForLevel:0] == 3,
        @"two areas keep their exterior rings and the large area's hole");
    [frame updateDrawnLowCentres:@[[NSValue valueWithPoint:NSMakePoint(157, -25)]]];
    check([island.causeHint hasPrefix:@"low"] && ![ring.causeHint hasPrefix:@"low"],
        @"a drawn L belongs only to the nearby separate area");
    [frame updateDrawnLowCentres:@[[NSValue valueWithPoint:NSMakePoint(140, -25)]]];
    check(![island.causeHint hasPrefix:@"low"] && ![ring.causeHint hasPrefix:@"low"],
        @"a drawn L deep inside a hole is outside the CB area and its 2-degree margin");
    [frame updateDrawnLowCentres:@[[NSValue valueWithPoint:NSMakePoint(146, -25)]]];
    check([ring.causeHint hasPrefix:@"low"] && ![island.causeHint hasPrefix:@"low"],
        @"the holed area's exterior still accepts its own drawn L");
}

static void TestCauses(void) {
    // A north–south trough through the block: pressure rises 1 hPa per (0.5°)² away from it.
    IsobarGeoGrid g = TestGrid();
    NSArray *times = @[Z(@"2026-10-06T00:00:00Z")];
    IsobarHazardRun *run = [[IsobarHazardRun alloc] initWithGrid:g times:times];
    size_t n = (size_t)g.nLon * g.nLat;
    float *c = malloc(n * 4), *r = malloc(n * 4), *k = malloc(n * 4), *p = malloc(n * 4);
    for (int j = 0; j < g.nLat; j++)
        for (int i = 0; i < g.nLon; i++) {
            size_t at = (size_t)j * g.nLon + i;
            BOOL in = i >= 16 && i < 24 && j >= 10 && j < 30;
            c[at] = in ? 1200 : 0; r[at] = in ? 3 : 0; k[at] = in ? 80 : 10;
            double dx = (i - 20) * 0.25;
            p[at] = (float)(1008 + 1.0 * dx * dx); // Laplacian 2 hPa/deg²
        }
    [run setStep:0 mucape:c rain3h:r cloud:k gust:NULL mslp:p t850:NULL t2m:NULL u10:NULL v10:NULL];
    IsobarHazardFrame *f = [run frameAtStep:0];
    check(f.areas.count == 1 && [f.areas.firstObject.causeHint isEqual:@"trough + MUCAPE 1,200 J/kg"],
        [NSString stringWithFormat:@"trough cause (%@)", f.areas.firstObject.causeHint]);
    // Pressure minima stay troughs until the renderer supplies a drawn L.
    for (int j = 0; j < g.nLat; j++)
        for (int i = 0; i < g.nLon; i++) {
            size_t at = (size_t)j * g.nLon + i;
            double di = i - 20, dj = j - 20;
            p[at] = (float)(1000 + 0.2 * (di * di + dj * dj));
        }
    [run setStep:0 mucape:c rain3h:r cloud:k gust:NULL mslp:p t850:NULL t2m:NULL u10:NULL v10:NULL];
    f = [run frameAtStep:0];
    check(f.areas.count == 1 && [f.areas.firstObject.causeHint hasPrefix:@"trough"],
        [NSString stringWithFormat:@"undrawn minimum stays trough (%@)", f.areas.firstObject.causeHint]);
    [f updateDrawnLowCentres:@[[NSValue valueWithPoint:NSMakePoint(145, -24)]]];
    check([f.areas.firstObject.causeHint hasPrefix:@"low"],
        [NSString stringWithFormat:@"drawn L in area says low (%@)", f.areas.firstObject.causeHint]);
    [f updateDrawnLowCentres:@[]];
    check([f.areas.firstObject.causeHint hasPrefix:@"trough"], @"empty drawn-L list clears a previous low");
    // Measure the actual eastern outline, including its dilated margin.
    double east = -INFINITY, edgeLat = 0;
    for (NSInteger i = 0; i < [f vertexCountForRing:0 level:0]; i++) {
        double lat = 0, lon = 0;
        [f vertexForRing:0 level:0 index:i latitude:&lat longitude:&lon];
        if (lon > east) { east = lon; edgeLat = lat; }
    }
    for (NSNumber *distance in @[@1.99, @2.0, @2.01]) {
        [f updateDrawnLowCentres:@[[NSValue valueWithPoint:NSMakePoint(east + distance.doubleValue, edgeLat)]]];
        BOOL low = [f.areas.firstObject.causeHint hasPrefix:@"low"];
        check(low == (distance.doubleValue <= 2.0),
            [NSString stringWithFormat:@"drawn L %.2f degrees from the outline: %@", distance.doubleValue,
                f.areas.firstObject.causeHint]);
    }
    // A drawn flat-terrace centre is still an L; raw pressure shape is not a
    // second classifier that can contradict the renderer's chosen mark.
    for (size_t at = 0; at < n; at++) p[at] = 1000;
    [run setStep:0 mucape:c rain3h:r cloud:k gust:NULL mslp:p t850:NULL t2m:NULL u10:NULL v10:NULL];
    IsobarHazardFrame *flat = [run frameAtStep:0];
    [flat updateDrawnLowCentres:@[[NSValue valueWithPoint:NSMakePoint(145, -24)]]];
    check([flat.areas.firstObject.causeHint hasPrefix:@"low"], @"a renderer-supplied terrace L also says low");
    [flat updateDrawnLowCentres:@[]];
    check(![flat.areas.firstObject.causeHint hasPrefix:@"low"], @"no drawn centre means no low on a terrace");
    // A cold front: 850 hPa temperature falls 3 K per 100 km southward, wind from the south.
    float *t = malloc(n * 4), *u = malloc(n * 4), *v = malloc(n * 4);
    for (int j = 0; j < g.nLat; j++)
        for (int i = 0; i < g.nLon; i++) {
            size_t at = (size_t)j * g.nLon + i;
            t[at] = (float)(15 - 3.0 * j * 0.25 * 111.2 / 100.0);
            u[at] = 0; v[at] = 10; // blowing north, from the cold side
            p[at] = 1010;
        }
    [run setStep:0 mucape:c rain3h:r cloud:k gust:NULL mslp:p t850:t t2m:NULL u10:u v10:v];
    f = [run frameAtStep:0];
    check([f.areas.firstObject.causeHint hasPrefix:@"cold front"],
        [NSString stringWithFormat:@"cold front cause (%@)", f.areas.firstObject.causeHint]);
    free(c); free(r); free(k); free(p); free(t); free(u); free(v);
}

static void TestDrawing(void) {
    IsobarHazardRun *run = BlockRun(1800, 4, 90, 10, 20, 12, 22, NO);
    IsobarHazardFrame *f = [run frameAtStep:1];
    IsobarCamera cam = {.centreLat = -25, .centreLon = 145, .zoom = 40, .globe = 0, .viewportW = 800, .viewportH = 600};
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, 800, 600, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextTranslateCTM(ctx, 0, 600);
    CGContextScaleCTM(ctx, 1, -1);
    NSArray *sig = IsobarSigmetsFromProduct(@{@"features": FixtureFeatures() ?: @[]});
    IsobarHazardDraw(ctx, f, sig, Z(@"2026-10-07T04:00:00Z"), cam, 1, NO, YES, nil);
    NSArray *labels = IsobarHazardLastLabels();
    check([labels containsObject:@"CB OCNL"], [NSString stringWithFormat:@"CB label drawn (%@)", labels]);
    check([labels containsObject:@"CB potential (model)"], @"key names the model");
    check([labels containsObject:@"SIGMET (official)"], @"key names the SIGMET when one is valid");
    check([labels containsObject:@"SIGMET FRQ TSGR TOP FL370 until 0515Z"], @"valid SIGMET labelled");
    check(![labels containsObject:@"SIGMET SEV TURB FL200–FL400 until 0645Z"], @"a SIGMET off the map has no label");
    // Hatch, not a flood: mean ink coverage in the core, away from the label.
    const uint8_t *px = CGBitmapContextGetData(ctx);
    size_t row = CGBitmapContextGetBytesPerRow(ctx);
    double x0, y0;
    IsobarCameraProject(cam, -20 - 15 * 0.25, 140 + 15 * 0.25, &x0, &y0);
    double alpha = 0;
    int total = 0;
    for (int y = (int)y0 + 30; y < (int)y0 + 70; y++)
        for (int x = (int)x0 - 20; x < (int)x0 + 20; x++) {
            alpha += px[(size_t)y * row + (size_t)x * 4 + 3] / 255.0;
            total++;
        }
    alpha /= total;
    check(alpha > 0.03 && alpha < 0.2, [NSString stringWithFormat:@"severe core is hatched, not filled (ink %.2f)", alpha]);
    NSString *tip = IsobarHazardTooltip(f, sig, Z(@"2026-10-07T04:00:00Z"), cam, x0, y0);
    check([tip containsString:@"CB potential: severe risk"], @"hover names the class");
    double sx, sy;
    IsobarCameraProject(cam, -25.0, 148.8, &sx, &sy);
    tip = IsobarHazardTooltip(nil, sig, Z(@"2026-10-07T04:00:00Z"), cam, sx, sy);
    check([tip containsString:@"SIGMET M01"] && [tip containsString:@"FRQ TSGR OBS"],
        [NSString stringWithFormat:@"hover inside the SIGMET gives its text (%@)", tip]);
    check(IsobarHazardTooltip(nil, sig, Z(@"2026-10-07T06:00:00Z"), cam, sx, sy) == nil, @"no hover text once it expires");
    IsobarHazardDraw(ctx, f, sig, Z(@"2026-10-07T06:00:00Z"), cam, 1, YES, YES, nil);
    labels = IsobarHazardLastLabels();
    check(![labels containsObject:@"SIGMET (official)"] && [labels containsObject:@"CB potential (model)"],
        @"the key drops the SIGMET entry when none is valid");
    const char *out = getenv("ISOBAR_HAZARD_OUT");
    if (out) {
        CGImageRef image = CGBitmapContextCreateImage(ctx);
        NSString *path = [[NSString stringWithUTF8String:out] stringByAppendingPathComponent:@"hazard-unit.png"];
        CFURLRef url = (__bridge CFURLRef)[NSURL fileURLWithPath:path];
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL(url, CFSTR("public.png"), 1, NULL);
        if (dest) { CGImageDestinationAddImage(dest, image, NULL); CGImageDestinationFinalize(dest); CFRelease(dest); }
        CGImageRelease(image);
    }
    CGContextRelease(ctx);
}

// Optional: a real run from the store, read only.
static void TestRealRun(void) {
    const char *store = getenv("ISOBAR_HAZARD_STORE");
    const char *runID = getenv("ISOBAR_HAZARD_RUN");
    if (!store || !runID) return;
    NSString *root = [NSString stringWithUTF8String:store];
    NSString *rid = [NSString stringWithUTF8String:runID];
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.dateFormat = @"yyyyMMdd'T'HH'Z'";
    fmt.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    NSDate *runDate = [fmt dateFromString:rid];
    NSMutableArray *times = [NSMutableArray array];
    for (int s = 0; s < 33; s++) [times addObject:[runDate dateByAddingTimeInterval:s * 3 * 3600]];
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201};
    NSTimeInterval began = [NSDate timeIntervalSinceReferenceDate];
    NSString *error = nil;
    IsobarHazardRun *run = [IsobarHazardRun runFromStoreRoot:root runDate:runDate times:times grid:g error:&error];
    double loadMs = ([NSDate timeIntervalSinceReferenceDate] - began) * 1000;
    check(run.hasCBInputs, [NSString stringWithFormat:@"real run loads (%@)", error]);
    double worst = 0;
    for (double t = 0; t <= 32; t += 0.37) {
        began = [NSDate timeIntervalSinceReferenceDate];
        IsobarHazardFrame *f = [run frameAtStep:t];
        double ms = ([NSDate timeIntervalSinceReferenceDate] - began) * 1000;
        if (ms > worst) worst = ms;
        (void)f;
    }
    fprintf(stderr, "real run %s: load %.0f ms, frame build worst %.2f ms\n", runID, loadMs, worst);
    for (int s = 1; s <= 8; s++) {
        IsobarHazardFrame *f = [run frameAtStep:s];
        fprintf(stderr, "  step %d %s: %lu areas, rings %ld/%ld/%ld\n", s,
            [[times[s] description] UTF8String], (unsigned long)f.areas.count, (long)[f ringCountForLevel:0],
            (long)[f ringCountForLevel:1], (long)[f ringCountForLevel:2]);
        NSInteger shown = 0;
        for (IsobarHazardArea *a in f.areas) {
            if (shown++ >= 4) break;
            fprintf(stderr, "    %s %s %.1f,%.1f cells %ld/%ld — %s\n", [a label].UTF8String,
                IsobarCBClassName(a.peakClass).UTF8String, a.labelLatitude, a.labelLongitude,
                (long)a.possibleCells, (long)a.areaCells, a.causeHint.UTF8String);
        }
    }
}

int main(void) {
    @autoreleasepool {
        TestGates();
        TestSigmets();
        TestFrames();
        TestCauses();
        TestDrawnLowAreaOwnership();
        TestDrawing();
        TestRealRun();
        fprintf(stderr, "%s\n", failures ? "FAILED" : "hazard ok");
        return failures ? 1 : 0;
    }
}
