// Unit tests for the own-chart geometry (Sources/ownchart.m). Run via ./tests.sh.
#import "ownchart.h"
#import <math.h>
#import <stdlib.h>

static int failures = 0;

static void check(BOOL cond, NSString *msg) {
    fprintf(stderr, "%s %s\n", cond ? "ok  " : "FAIL", msg.UTF8String);
    if (!cond) failures++;
}

static NSDate *UTC(int year, int month, int day, int hour, int minute) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSDateComponents *c = [NSDateComponents new];
    c.year = year;
    c.month = month;
    c.day = day;
    c.hour = hour;
    c.minute = minute;
    c.timeZone = cal.timeZone;
    return [cal dateFromComponents:c];
}

static double FixedHalf(double level, void *ctx) {
    (void)level;
    return *(double *)ctx;
}

static BOOL Near(double a, double b, double tol) { return fabs(a - b) < tol; }

static void TestGrid(void) {
    check(OwnGridNLon() == 301 && OwnGridNLat() == 201, @"0.25° window is 301 by 201");
    check(OwnGridCount() == 301 * 201, @"grid is 60,501 points");
    check(Near(OwnGridWest(), 95, 1e-9) && Near(OwnGridEast(), 170, 1e-9), @"longitudes run 95E to 170E");
    check(Near(OwnGridNorth(), 0, 1e-9) && Near(OwnGridSouth(), -50, 1e-9), @"latitudes run the equator to 50S");
    check(Near(OwnGridStep(), 0.25, 1e-12), @"grid step is 0.25 degrees");
    double lat = 0, lon = 0;
    OwnGridCoord(0, &lat, &lon);
    check(Near(lat, 0, 1e-9) && Near(lon, 95, 1e-9), @"first point is the equator at 95E");
    OwnGridCoord(300, &lat, &lon);
    check(Near(lat, 0, 1e-9) && Near(lon, 170, 1e-9), @"end of the first row is 170E");
    OwnGridCoord(301, &lat, &lon);
    check(Near(lat, -0.25, 1e-9) && Near(lon, 95, 1e-9), @"second row steps south by a quarter degree");
    OwnGridCoord(OwnGridCount() - 1, &lat, &lon);
    check(Near(lat, -50, 1e-9) && Near(lon, 170, 1e-9), @"last point is the south-east corner");
    BOOL inside = YES;
    for (NSInteger i = 0; i < OwnGridCount(); i++) {
        OwnGridCoord(i, &lat, &lon);
        if (lon < 95 - 1e-9 || lon > 170 + 1e-9 || lat > 1e-9 || lat < -50 - 1e-9) inside = NO;
    }
    check(inside, @"every grid point stays inside the window");
    check(OwnBatchCount() == 303, @"60,501 points make 303 batches of at most 200");
    NSInteger covered = 0;
    BOOL sized = YES;
    for (NSInteger b = 0; b < OwnBatchCount(); b++) {
        NSInteger start = 0, len = 0;
        OwnBatchRange(b, &start, &len);
        if (len <= 0 || len > OwnBatchLimit) sized = NO;
        if (start != covered) sized = NO;
        covered += len;
    }
    check(sized && covered == OwnGridCount(), @"batches cover the grid without overlap");
    NSInteger start = 0, len = 0;
    OwnBatchRange(302, &start, &len);
    check(start == 60400 && len == 101, @"the last batch is the remainder");
}

static void TestURLAndParse(void) {
    double lats[] = {-33.86, -5.0};
    double lons[] = {151.21, 100.0};
    NSString *url = OwnForecastURL(lats, lons, 2, 4);
    check([url containsString:@"models=ecmwf_ifs025"], @"url asks for ECMWF IFS 0.25");
    check([url containsString:@"hourly=pressure_msl,temperature_850hPa,temperature_2m,wind_speed_10m,wind_direction_10m,precipitation"],
          @"url asks for pressure, both temperatures, wind and rain");
    check([url containsString:@"timezone=UTC"], @"url is UTC");
    check([url containsString:@"forecast_days=4"], @"forecast_days is written through");
    check([url containsString:@"wind_speed_unit=kn"], @"wind is requested in knots");
    check([url containsString:@"latitude=-33.86,-5&"] && [url containsString:@"longitude=151.21,100&"],
          @"coordinates are comma-separated with no spaces");
    check(OwnForecastURL(NULL, lons, 2, 4) == nil, @"a missing coordinate list is not a url");

    NSString *json =
        @"[{\"latitude\":-5,\"longitude\":100,\"hourly\":{"
        @"\"time\":[\"2026-09-26T00:00\",\"2026-09-26T01:00\",\"2026-09-27T00:00\"],"
        @"\"pressure_msl\":[1010.5,1011,1004],"
        @"\"temperature_850hPa\":[12,12.5,8],"
        @"\"temperature_2m\":[20,21,18],"
        @"\"wind_speed_10m\":[5,6,12],"
        @"\"wind_direction_10m\":[180,190,270],"
        @"\"precipitation\":[0,0.2,1.5]}},"
        @"{\"latitude\":-6.5,\"longitude\":101.5,\"hourly\":{"
        @"\"time\":[\"2026-09-26T00:00\",\"2026-09-26T01:00\",\"2026-09-27T00:00\"],"
        @"\"pressure_msl\":[1008,1009,1002],"
        @"\"temperature_850hPa\":[14,14,9],"
        @"\"temperature_2m\":[25,24,19],"
        @"\"wind_speed_10m\":[8,8,15],"
        @"\"wind_direction_10m\":[90,100,140],"
        @"\"precipitation\":[0.1,null,0.4]}}]";
    NSArray *rows = OwnParseForecast([json dataUsingEncoding:NSUTF8StringEncoding]);
    check(rows.count == 2, @"two locations parse");
    check(fabs([rows[0][@"pressure_msl"][0] doubleValue] - 1010.5) < 1e-6, @"pressure is kept");
    check([rows[1][@"precipitation"][1] isKindOfClass:NSNull.class], @"a null rain hour stays null");
    NSInteger at = OwnTimeIndex(rows[0][@"time"], UTC(2026, 9, 27, 0, 0));
    check(at == 2, @"Sunday 00Z is the third hour");
    check(OwnTimeIndex(rows[0][@"time"], UTC(2026, 9, 27, 3, 0)) == -1, @"a missing hour is not invented");
    double sum = OwnTrailingSum(rows[1][@"precipitation"], 2, 3);
    check(Near(sum, 0.5, 1e-9), @"trailing rain treats a null as zero");
    check(isnan(OwnTrailingSum(rows[0][@"precipitation"], 9, 12)), @"a time index past the series is not a sum");
    check(isnan(OwnPrecedingSum(rows[0][@"precipitation"], 2, 24)),
          @"a 24 h hatch is refused when the series does not cover the day");
    NSMutableArray *day = [NSMutableArray array];
    for (int i = 0; i < 48; i++) [day addObject:@(0.05)];
    double nowRain = OwnPrecedingSum(day, 23, 24);
    double laterRain = OwnPrecedingSum(day, 35, 24);
    check(Near(nowRain, 1.2, 1e-9) && Near(laterRain, 1.2, 1e-9),
          @"Now and the frame 12 h later both sum a full preceding day");
    check(isnan(OwnPrecedingSum(day, 10, 24)), @"twelve hours of history is not a 24 h total");
    check(Near(OwnAccumulationWindow(3.2, 1.1), 2.1, 1e-9), @"a 24 h accumulation is the difference of two totals");
    check(OwnAccumulationWindow(1.0, 1.02) == 0, @"packing noise below zero is not a reset");
    check(isnan(OwnAccumulationWindow(0.2, 5.0)), @"a reset accumulation is not a rainfall total");
    check(isnan(OwnAccumulationWindow(NAN, 1)), @"a missing total is not rainfall");
    NSString *past = OwnForecastURLWithPast(lats, lons, 2, 2, 1);
    check([past containsString:@"past_days=1"] && [past containsString:@"models=ecmwf_ifs025"],
          @"the Now fallback asks Open-Meteo for the previous day of the same model");
    check(![url containsString:@"past_days="], @"the plain forecast url does not invent a past day");
    NSData *bad = [@ "{\"error\":true,\"reason\":\"no\"}" dataUsingEncoding:NSUTF8StringEncoding];
    check(OwnParseForecast(bad) == nil, @"an API error does not parse as a grid");
    NSData *single = [@ "{\"latitude\":1,\"longitude\":2,\"hourly\":{"
        @"\"time\":[\"2026-09-26T00:00\"],"
        @"\"pressure_msl\":[1000],\"temperature_850hPa\":[10],\"temperature_2m\":[15],"
        @"\"wind_speed_10m\":[1],\"wind_direction_10m\":[2],\"precipitation\":[0]}}"
        dataUsingEncoding:NSUTF8StringEncoding];
    check(OwnParseForecast(single).count == 1, @"a single-location object is accepted");
}

static void TestTimes(void) {
    NSDate *saturday = UTC(2026, 9, 26, 4, 21);
    NSArray<NSDate *> *times = OwnPrognosisTimes(saturday);
    check(times.count == 8, @"a four-day issue has eight panels");
    BOOL step = times.count == 8;
    for (NSUInteger i = 1; i < times.count; i++) {
        if (fabs([times[i] timeIntervalSinceDate:times[i - 1]] - 12 * 3600) > 1) step = NO;
    }
    check(step, @"panels are 12 hours apart");
    check(fabs([times.firstObject timeIntervalSinceDate:UTC(2026, 9, 27, 0, 0)]) < 1,
          @"Saturday's issue opens at 10am EST Sunday");
    check(fabs([times.lastObject timeIntervalSinceDate:UTC(2026, 9, 30, 12, 0)]) < 1,
          @"the eighth panel is 10pm EST Wednesday");
    check([OwnValidTitle(times[0], NO) isEqual:@"10am EST Sun 27 Sep"], @"first panel title");
    check([OwnValidTitle(times[1], NO) isEqual:@"10pm EST Sun 27 Sep"], @"second panel title");
    check(OwnForecastDayCount(saturday, times.lastObject) == 5,
          @"Wednesday 12Z needs five forecast days from Saturday");
    check(OwnForecastDayCount(saturday, UTC(2026, 9, 27, 0, 0)) == 4,
          @"a nearer panel still requests at least four days");
    NSDate *nearest = OwnNearestHour(saturday);
    check(fabs([nearest timeIntervalSinceDate:UTC(2026, 9, 26, 4, 0)]) < 1, @"04:21Z rounds to 04:00Z");
    check(fabs([OwnNearestHour(UTC(2026, 9, 26, 4, 30)) timeIntervalSinceDate:UTC(2026, 9, 26, 5, 0)]) < 1,
          @"04:30Z rounds up to 05:00Z");
    check([OwnValidTitle(nearest, YES) isEqual:@"Now · 2pm EST Sat 26 Sep"], @"now title uses Eastern Standard");
    NSDate *fetched = [saturday dateByAddingTimeInterval:-11 * 3600];
    check(!OwnRefreshDue(fetched, saturday), @"eleven hours is inside the twice-a-day limit");
    check(OwnRefreshDue([saturday dateByAddingTimeInterval:-12 * 3600], saturday), @"twelve hours is due");
    check(OwnRefreshDue(nil, saturday), @"a missing cache is due");
}

static void TestProjection(void) {
    OwnLambert geo = OwnAustraliaLambert();
    check(geo.valid && Near(geo.lon0, 130, 1e-9) && Near(geo.parallel, -30, 1e-9), @"Australia uses 130E and 30S");
    double x = 1, y = 1;
    check(OwnProject(geo, -30, 130, &x, &y) && Near(x, 0, 1e-9) && Near(y, 0, 1e-8),
          @"the standard parallel on the central meridian is the origin");
    double northX, northY, southX, southY, eastX, eastY;
    OwnProject(geo, -20, 130, &northX, &northY);
    OwnProject(geo, -40, 130, &southX, &southY);
    OwnProject(geo, -30, 140, &eastX, &eastY);
    check(northY > 0 && southY < 0, @"north is up");
    check(eastX > 0, @"east is to the right");
    double westX = 0;
    OwnProject(geo, -30, 120, &westX, &y);
    check(Near(westX, -eastX, 1e-6), @"the cone is symmetric about 130E");
    double lat = 0, lon = 0;
    BOOL back = OwnUnproject(geo, eastX, eastY, &lat, &lon);
    check(back && Near(lat, -30, 1e-6) && Near(lon, 140, 1e-6), @"unproject returns the point");
    double samples[][2] = {{-12.5, 130.8}, {-31.95, 115.86}, {-33.87, 151.21}, {-42.9, 147.3}, {-25, 135}};
    BOOL roundtrip = YES;
    for (int i = 0; i < 5; i++) {
        double px, py, la, lo;
        if (!OwnProject(geo, samples[i][0], samples[i][1], &px, &py)) roundtrip = NO;
        if (!OwnUnproject(geo, px, py, &la, &lo)) roundtrip = NO;
        if (!Near(la, samples[i][0], 1e-6) || !Near(lo, samples[i][1], 1e-6)) roundtrip = NO;
    }
    check(roundtrip, @"Darwin, Perth, Sydney and Hobart round-trip");
    OwnView view = OwnViewMake(geo, 100, 164.5, -45.5, -5, 0, 0, 580, 444);
    check(view.valid, @"the chart window fits a panel");
    double darwinX, darwinY, hobartX, hobartY, perthX, perthY, sydneyX, sydneyY;
    OwnViewProject(view, -12.4, 130.8, &darwinX, &darwinY);
    OwnViewProject(view, -42.9, 147.3, &hobartX, &hobartY);
    OwnViewProject(view, -31.95, 115.86, &perthX, &perthY);
    OwnViewProject(view, -33.87, 151.21, &sydneyX, &sydneyY);
    check(darwinY < hobartY, @"Darwin sits above Hobart");
    check(perthX < sydneyX, @"Perth sits left of Sydney");
    check(darwinX > 0 && darwinX < 580 && hobartY > 0 && hobartY < 444, @"the continent lands inside the panel");
}

static void TestContours(void) {
    const int n = 31;
    double *bowl = calloc((size_t)(n * n), sizeof(double));
    for (int j = 0; j < n; j++) {
        for (int i = 0; i < n; i++) {
            double di = i - 15, dj = j - 15;
            bowl[j * n + i] = di * di + dj * dj;
        }
    }
    double levels[] = {18, 40, 80};
    OwnLineSet rings = OwnContours(bowl, n, n, 0, 0, 1, 1, levels, 3);
    check(rings.count == 3, [NSString stringWithFormat:@"a bowl draws three closed isobars, got %d", rings.count]);
    BOOL closed = rings.count == 3;
    BOOL sized = YES;
    for (int i = 0; i < rings.count; i++) {
        if (!rings.lines[i].closed || rings.lines[i].count < 8) closed = NO;
        if (rings.lines[i].count < 8) sized = NO;
    }
    check(closed && sized, @"each bowl isobar is one closed ring");
    OwnLineSetFree(rings);

    double *plane = calloc((size_t)(21 * 11), sizeof(double));
    for (int j = 0; j < 11; j++) for (int i = 0; i < 21; i++) plane[j * 21 + i] = i;
    double cut = 10.5;
    OwnLineSet open = OwnContours(plane, 21, 11, 0, 0, 1, 1, &cut, 1);
    check(open.count == 1 && !open.lines[0].closed, [NSString stringWithFormat:@"a ramp is one open line, got %d", open.count]);
    BOOL onLine = open.count == 1;
    for (int i = 0; onLine && i < open.lines[0].count; i++) {
        if (fabs(open.lines[0].pts[i].x - 10.5) > 0.05) onLine = NO;
    }
    check(onLine && open.lines[0].count > 5, @"the ramp contour sits on x = 10.5");
    OwnLineSetFree(open);

    for (int i = 0; i < n * n; i++) bowl[i] = 1013;
    double flatLevel = 1012;
    OwnLineSet none = OwnContours(bowl, n, n, 0, 0, 1, 1, &flatLevel, 1);
    check(none.count == 0, @"a flat field has no isobar");
    OwnLineSetFree(none);
    free(bowl);
    free(plane);

    double stepLevels[8];
    int nLevel = OwnInteriorLevels(1000, 1020, 4, stepLevels, 8);
    BOOL steps = nLevel == 4 && Near(stepLevels[0], 1004, 1e-9) && Near(stepLevels[3], 1016, 1e-9);
    check(steps, @"4 hPa levels are the multiples strictly inside the range");
}

static void TestExtrema(void) {
    const int n = 31;
    double *field = calloc((size_t)(n * n), sizeof(double));
    for (int j = 0; j < n; j++) {
        for (int i = 0; i < n; i++) {
            double di = i - 10.4, dj = j - 14.2;
            field[j * n + i] = di * di + dj * dj;
        }
    }
    OwnExtremum found[8];
    int nFound = OwnExtrema(field, n, n, 0, 0, 1, 1, 4, 0.5, found, 8);
    check(nFound == 1 && found[0].high == 0, @"a bowl has one low");
    check(nFound == 1 && Near(found[0].x, 10.4, 1e-6) && Near(found[0].y, 14.2, 1e-6),
          @"the low is recovered between grid nodes");

    for (int j = 0; j < n; j++) {
        for (int i = 0; i < n; i++) {
            double di = i - 8, dj = j - 9;
            field[j * n + i] = -(di * di + dj * dj);
        }
    }
    nFound = OwnExtrema(field, n, n, 0, 0, 1, 1, 4, 0.5, found, 8);
    check(nFound == 1 && found[0].high == 1 && Near(found[0].x, 8, 1e-6) && Near(found[0].y, 9, 1e-6),
          @"an inverted bowl has one high");

    const int w = 40;
    double *wells = calloc((size_t)(w * w), sizeof(double));
    for (int j = 0; j < w; j++) {
        for (int i = 0; i < w; i++) {
            double r1 = (i - 8) * (i - 8) + (j - 10) * (j - 10);
            double r2 = (i - 20) * (i - 20) + (j - 10) * (j - 10);
            wells[j * w + i] = 100 - 5 * exp(-r1 / 2.0) - 3 * exp(-r2 / 2.0);
        }
    }
    nFound = OwnExtrema(wells, w, w, 0, 0, 1, 1, 14, 0.05, found, 8);
    int lows = 0;
    for (int i = 0; i < nFound; i++) if (!found[i].high) lows++;
    check(lows == 1, [NSString stringWithFormat:@"a wide separation keeps the deeper low, got %d", lows]);
    nFound = OwnExtrema(wells, w, w, 0, 0, 1, 1, 6, 0.05, found, 8);
    lows = 0;
    double deep = 1e9;
    for (int i = 0; i < nFound; i++) if (!found[i].high) {
        lows++;
        if (found[i].value < deep) deep = found[i].value;
    }
    check(lows == 2 && deep < 96, [NSString stringWithFormat:@"a narrow separation keeps both lows, got %d", lows]);
    free(field);
    free(wells);
}

static void TestLabelsAndSmooth(void) {
    OwnVec zig[7] = {{0, 0}, {1, 1}, {2, 0}, {3, 1}, {4, 0}, {5, 1}, {6, 0}};
    OwnVec copy[7];
    memcpy(copy, zig, sizeof zig);
    OwnSmoothLine(copy, 7, 0, 4);
    check(Near(copy[0].x, 0, 1e-12) && Near(copy[6].x, 6, 1e-12) && Near(copy[0].y, 0, 1e-12),
          @"smoothing keeps the ends of an open line");
    double before = 0, after = 0;
    for (int i = 1; i < 6; i++) {
        before += fabs((zig[i + 1].y - zig[i].y) - (zig[i].y - zig[i - 1].y));
        after += fabs((copy[i + 1].y - copy[i].y) - (copy[i].y - copy[i - 1].y));
    }
    check(after < before, @"smoothing reduces the zigzag");

    OwnVec dense[16];
    int nd = OwnDensify(zig, 7, 0, dense, 16);
    check(nd == 13 && Near(dense[0].x, 0, 1e-12) && Near(dense[12].x, 6, 1e-12), @"an open line gains a midpoint per edge");
    check(OwnDensify(zig, 7, 0, dense, 4) == -1, @"densify refuses a short buffer");

    OwnLine lines[3];
    OwnVec rows[3][2] = {
        {{0, 0}, {400, 0}},
        {{0, 40}, {400, 40}},
        {{0, 80}, {400, 80}},
    };
    for (int i = 0; i < 3; i++) lines[i] = (OwnLine){rows[i], 2, 0, 1000 + i * 4};
    double half = 18;
    OwnLabel labels[24];
    int nLab = OwnPlaceLabels(lines, 3, FixedHalf, &half, 6, 4, -1000, -1000, 5000, 5000, labels, 24);
    check(nLab >= 3, [NSString stringWithFormat:@"each long isobar gets a label, got %d", nLab]);
    BOOL apart = YES;
    for (int i = 0; i < nLab; i++) {
        for (int j = i + 1; j < nLab; j++) if (OwnLabelsOverlap(labels[i], labels[j], 4)) apart = NO;
    }
    check(apart, @"isobar labels do not overlap");
    int seen[3] = {0, 0, 0};
    for (int i = 0; i < nLab; i++) if (labels[i].line >= 0 && labels[i].line < 3) seen[labels[i].line]++;
    check(seen[0] && seen[1] && seen[2], @"every line is labelled");

    OwnVec shortLine[2] = {{0, 0}, {10, 0}};
    OwnLine brief = {shortLine, 2, 0, 1012};
    double wide = 20;
    int nShort = OwnPlaceLabels(&brief, 1, FixedHalf, &wide, 6, 2, -100, -100, 100, 100, labels, 4);
    check(nShort == 0, @"a line shorter than its label is left bare");

    OwnVec span[2] = {{0, 0}, {200, 0}};
    OwnLabel gap = {.x = 100, .y = 0, .angle = 0, .halfW = 15, .halfH = 6, .arc = 100, .gap = 15, .level = 1020, .line = 0};
    OwnLineSet parts = OwnCutGaps(span, 2, 0, &gap, 1);
    check(parts.count == 2, [NSString stringWithFormat:@"a label cuts one line into two, got %d", parts.count]);
    BOOL clear = parts.count == 2;
    BOOL coversEnds = NO, coversRight = NO;
    for (int p = 0; p < parts.count; p++) {
        for (int i = 0; i < parts.lines[p].count; i++) {
            double x = parts.lines[p].pts[i].x;
            if (x > 87 && x < 113) clear = NO;
            if (x < 20) coversEnds = YES;
            if (x > 180) coversRight = YES;
        }
    }
    check(clear && coversEnds && coversRight, @"the gap sits under the number and the line continues either side");
    OwnLineSetFree(parts);

    OwnLabel same = gap;
    OwnLabel other = gap;
    other.x = 140;
    other.arc = 140;
    check(OwnLabelsOverlap(gap, same, 0), @"a label overlaps itself");
    check(!OwnLabelsOverlap(gap, other, 0), @"labels forty units apart stay clear");
    check(Near(OwnReadableAngle(M_PI), 0, 1e-9), @"a leftward baseline flips upright");
}

static void TestBarbsAndColour(void) {
    OwnVec flow = {0};
    check(OwnWindFlow(0, &flow) && Near(flow.x, 0, 1e-9) && Near(flow.y, -1, 1e-9),
        @"north wind arrow points south");
    check(OwnWindFlow(90, &flow) && Near(flow.x, -1, 1e-9) && Near(flow.y, 0, 1e-9),
        @"east wind arrow points west");
    check(OwnWindFlow(270, &flow) && Near(flow.x, 1, 1e-9) && Near(flow.y, 0, 1e-9),
        @"west wind arrow points east");
    check(!OwnWindFlow(NAN, &flow), @"missing wind direction draws no arrow");
    OwnBarb calm = OwnWindBarb(0, 2.4, 40, YES);
    check(calm.calm && calm.nFull == 0 && calm.nPenn == 0, @"under 2.5 kt is a calm circle");
    OwnBarb light = OwnWindBarb(0, 3, 40, YES);
    check(!light.calm && light.nHalf == 1, @"3 kt rounds to a half feather");
    OwnBarb half = OwnWindBarb(0, 5, 40, YES);
    check(!half.calm && half.nHalf == 1 && half.nFull == 0 && half.nPenn == 0, @"5 kt is a half feather");
    OwnBarb full = OwnWindBarb(270, 10, 40, NO);
    check(full.nFull == 1 && full.nHalf == 0 && full.tip.x < -30, @"10 kt from the west puts the staff to the west");
    double maxY = -1e9, minY = 1e9;
    for (int i = 0; i < full.nSeg; i++) {
        if (full.segs[i].b.y > maxY) maxY = full.segs[i].b.y;
        if (full.segs[i].b.y < minY) minY = full.segs[i].b.y;
    }
    check(maxY > 8, @"a northern-hemisphere feather points north of a westerly");
    OwnBarb south = OwnWindBarb(270, 10, 40, YES);
    minY = 1e9;
    for (int i = 0; i < south.nSeg; i++) if (south.segs[i].b.y < minY) minY = south.segs[i].b.y;
    check(minY < -8, @"an Australian feather points south of a westerly");
    OwnBarb both = OwnWindBarb(180, 15, 40, YES);
    check(both.nFull == 1 && both.nHalf == 1, @"15 kt is a full feather and a half");
    OwnBarb flag = OwnWindBarb(90, 50, 40, YES);
    check(flag.nPenn == 1 && flag.nFull == 0 && flag.nTri == 1, @"50 kt is one pennant");
    OwnBarb storm = OwnWindBarb(45, 65, 40, YES);
    check(storm.nPenn == 1 && storm.nFull == 1 && storm.nHalf == 1, @"65 kt is a pennant, a full feather and a half");

    OwnRGB cold = OwnTemperatureRGB(-20);
    OwnRGB warm = OwnTemperatureRGB(30);
    OwnRGB mid = OwnTemperatureRGB(10);
    check(cold.b > cold.r + 0.1, @"cold air is blue");
    check(warm.r > warm.b + 0.15, @"warm air is orange");
    double sat = fmax(mid.r, fmax(mid.g, mid.b)) - fmin(mid.r, fmin(mid.g, mid.b));
    check(sat < 0.2, @"the middle of the ramp stays quiet");
    check(OwnTemperatureRGB(0).b > OwnTemperatureRGB(20).b, @"the ramp warms as temperature rises");
}

static void TestCoast(void) {
    uint8_t blob[8 + 2 + 4 * 4];
    memcpy(blob, "OCST", 4);
    blob[4] = 1; blob[5] = 0;
    blob[6] = 1; blob[7] = 0;
    blob[8] = 4; blob[9] = 0;
    int16_t pts[] = {11500, -3200, 11600, -3300, 11550, -3400, 11450, -3300};
    memcpy(blob + 10, pts, sizeof pts);
    NSData *data = [NSData dataWithBytes:blob length:sizeof blob];
    OwnCoast coast = OwnCoastParse(data);
    check(coast.rings == 1 && coast.points == 4, @"a hand-built coastline parses");
    check(coast.points == 4 && Near(coast.lon[0], 115, 1e-9) && Near(coast.lat[0], -32, 1e-9),
          @"hundredths of a degree come back as degrees");
    OwnCoastFree(coast);
    check(OwnCoastParse([@"nope" dataUsingEncoding:NSUTF8StringEncoding]).rings == 0, @"a bad blob is empty");

    NSString *path = NSProcessInfo.processInfo.environment[@"ISOBAR_COAST"];
    NSData *file = [NSData dataWithContentsOfFile:path];
    check(file.length > 100, @"Natural Earth coastline is bundled");
    OwnCoast ne = OwnCoastParse(file);
    check(ne.rings > 20 && ne.points > 1000 && ne.points < 100000, @"the crop is a modest set of rings");
    BOOL west = NO, tas = NO, york = NO;
    for (int i = 0; i < ne.points; i++) {
        if (ne.lon[i] > 114 && ne.lon[i] < 116 && ne.lat[i] < -31 && ne.lat[i] > -35) west = YES;
        if (ne.lon[i] > 145 && ne.lon[i] < 148.5 && ne.lat[i] < -40.5 && ne.lat[i] > -43.8) tas = YES;
        if (ne.lon[i] > 142 && ne.lon[i] < 144 && ne.lat[i] < -10.5 && ne.lat[i] > -12.5) york = YES;
    }
    check(west && tas && york, @"the crop includes the west coast, Tasmania and Cape York");
    OwnCoastFree(ne);
}

int main(void) {
    @autoreleasepool {
        TestGrid();
        TestURLAndParse();
        TestTimes();
        TestProjection();
        TestContours();
        TestExtrema();
        TestLabelsAndSmooth();
        TestBarbsAndColour();
        TestCoast();
        fprintf(stderr, "%s\n", failures ? "FAILED" : "OK");
        return failures ? 1 : 0;
    }
}
