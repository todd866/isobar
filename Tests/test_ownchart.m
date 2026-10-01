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
    double level = 1012;
    OwnLineSet huge = OwnContours((const double *)1, 100000, 100000, 0, 0, 1, 1, &level, 1);
    check(huge.count == 0 && huge.lines == NULL, @"an oversized field is refused before it is read");
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

    OwnVec corner[5] = {{0, 0}, {1, 1}, {2, 0}, {3, 1}, {4, 0}};
    OwnVec cut[10];
    int nCut = OwnChaikin(corner, 5, 0, cut, 10);
    check(nCut == 10 && Near(cut[0].x, 0, 1e-12) && Near(cut[0].y, 0, 1e-12)
        && Near(cut[9].x, 4, 1e-12) && Near(cut[9].y, 0, 1e-12), @"Chaikin keeps the ends of an open line");
    double peak = 0;
    for (int i = 1; i < nCut - 1; i++) if (cut[i].y > peak) peak = cut[i].y;
    check(nCut == 10 && peak < 0.9, @"Chaikin lowers a zigzag peak");
    check(OwnChaikin(corner, 5, 0, cut, 4) == -1, @"Chaikin refuses a short buffer");
    OwnVec ring[4] = {{0, 0}, {2, 0}, {2, 2}, {0, 2}};
    OwnVec rounded[8];
    int nRing = OwnChaikin(ring, 4, 1, rounded, 8);
    BOOL boxed = nRing == 8;
    for (int i = 0; i < nRing; i++) {
        if (rounded[i].x < -1e-9 || rounded[i].x > 2 + 1e-9 || rounded[i].y < -1e-9 || rounded[i].y > 2 + 1e-9)
            boxed = NO;
    }
    check(boxed, @"a closed ring doubles and stays inside its box");

    OwnLabel crowded[3] = {
        {.x = 0, .y = 0, .halfW = 12, .halfH = 6, .level = 1016},
        {.x = 10, .y = 0, .halfW = 12, .halfH = 6, .level = 1016},
        {.x = 80, .y = 0, .halfW = 12, .halfH = 6, .level = 1012},
    };
    int kept = OwnKeepSeparated(crowded, 3, 4);
    check(kept == 2 && Near(crowded[0].x, 0, 1e-9) && Near(crowded[1].x, 80, 1e-9),
          @"an overlapping pressure label is dropped and a distant one stays");

    OwnVec upright[2] = {{0, 0}, {0, 200}};
    OwnLabel tall = {.x = 0, .y = 100, .angle = 0, .halfW = 20, .halfH = 6, .arc = 100, .gap = 40, .level = 1008, .line = 0};
    OwnLineSet sliced = OwnCutGaps(upright, 2, 0, &tall, 1);
    double lowerTop = -1, upperBottom = 1e9;
    BOOL hasFoot = NO, hasHead = NO, throughCentre = NO;
    for (int p = 0; p < sliced.count; p++) {
        double minY = 1e9, maxY = -1e9;
        for (int i = 0; i < sliced.lines[p].count; i++) {
            double y = sliced.lines[p].pts[i].y;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (y < 1) hasFoot = YES;
            if (y > 190) hasHead = YES;
            if (y > 97 && y < 103) throughCentre = YES;
        }
        if (maxY < 100 && maxY > lowerTop) lowerTop = maxY;
        if (minY > 100 && minY < upperBottom) upperBottom = minY;
    }
    double removed = upperBottom - lowerTop;
    check(sliced.count == 2 && hasFoot && hasHead && !throughCentre && removed > 12 && removed < 22,
          [NSString stringWithFormat:@"a vertical isobar loses the label height, not its width (gap %.1f)", removed]);
    OwnLineSetFree(sliced);

    OwnVec square[4] = {{0, 0}, {100, 0}, {100, 100}, {0, 100}};
    OwnLabel east = {.x = 100, .y = 50, .angle = 0, .halfW = 18, .halfH = 6, .gap = 80, .level = 1020, .line = 0};
    OwnLineSet opened = OwnCutGaps(square, 4, 1, &east, 1);
    double keptLen = 0, endGap = 0;
    BOOL sawCorner = NO;
    if (opened.count == 1) {
        OwnLine part = opened.lines[0];
        for (int i = 1; i < part.count; i++)
            keptLen += hypot(part.pts[i].x - part.pts[i - 1].x, part.pts[i].y - part.pts[i - 1].y);
        endGap = hypot(part.pts[0].x - part.pts[part.count - 1].x, part.pts[0].y - part.pts[part.count - 1].y);
        for (int i = 0; i < part.count; i++)
            if (fabs(part.pts[i].x) < 1e-6 && fabs(part.pts[i].y) < 1e-6) sawCorner = YES;
    }
    check(opened.count == 1 && !opened.lines[0].closed && sawCorner && keptLen > 360 && endGap > 10 && endGap < 20,
          [NSString stringWithFormat:@"a ring opens only across the label box (kept %.0f, mouth %.1f)", keptLen, endGap]);
    OwnLineSetFree(opened);

    OwnVec circle[64];
    for (int i = 0; i < 64; i++) {
        double t = i * (2 * M_PI / 64);
        circle[i] = (OwnVec){50 * cos(t), 50 * sin(t)};
    }
    OwnLabel side = {.x = 50, .y = 0, .angle = 0, .halfW = 22, .halfH = 6, .gap = 100, .level = 1020, .line = 0};
    OwnLineSet coast = OwnCutGaps(circle, 64, 1, &side, 1);
    double coastLen = 0, mouth = 1e9;
    if (coast.count == 1) {
        OwnLine part = coast.lines[0];
        for (int i = 1; i < part.count; i++)
            coastLen += hypot(part.pts[i].x - part.pts[i - 1].x, part.pts[i].y - part.pts[i - 1].y);
        mouth = hypot(part.pts[0].x - part.pts[part.count - 1].x, part.pts[0].y - part.pts[part.count - 1].y);
    }
    check(coast.count == 1 && coastLen > 280 && mouth > 8 && mouth < 24,
          [NSString stringWithFormat:@"a round isobar is not cut into a C (mouth %.1f, kept %.0f)", mouth, coastLen]);
    OwnLineSetFree(coast);

    OwnVec flat[2] = {{0, 0}, {100, 0}};
    double ax = 0, ay = 0, aarc = 0, atang = 0, adist = 0;
    check(OwnContourAnchor(40, 4, &(OwnLine){flat, 2, 0, 1012}, 10, 0, -10, -10, 200, 200,
            &ax, &ay, &aarc, &atang, &adist) && Near(ax, 40, 0.2) && Near(ay, 0, 0.2) && adist < 5,
          @"a label snaps onto the isobar under it");
    check(!OwnContourAnchor(40, 30, &(OwnLine){flat, 2, 0, 1012}, 10, 0, -10, -10, 200, 200,
            &ax, &ay, &aarc, &atang, &adist),
          @"a label too far from every isobar is not placed");
    OwnVec kink[5] = {{0, 0}, {20, 0}, {28, 12}, {36, 0}, {70, 0}};
    check(OwnContourAnchor(28, 12, &(OwnLine){kink, 5, 0, 1016}, 8, 30, -10, -10, 200, 200,
            &ax, &ay, &aarc, &atang, &adist) && ay < 2,
          @"a label slides off a kink onto a straighter stretch");
    double againX = 0, againY = 0;
    OwnContourAnchor(28, 12, &(OwnLine){kink, 5, 0, 1016}, 8, 30, -10, -10, 200, 200,
        &againX, &againY, &aarc, &atang, &adist);
    check(Near(ax, againX, 1e-9) && Near(ay, againY, 1e-9), @"the same isobar anchors a label in the same place");
    check(OwnContourAnchor(5, 1, &(OwnLine){flat, 2, 0, 1012}, 8, 40, 20, -10, 200, 200,
            &ax, &ay, &aarc, &atang, &adist) && ax >= 20 && Near(ay, 0, 0.2),
          @"a label stays inside the map rather than on the edge");

    OwnVec box[4] = {{0, 0}, {80, 0}, {80, 80}, {0, 80}};
    OwnLine border = {box, 4, 1, 1016};
    double edgeHalf = 8;
    OwnLabel edgeLabels[4];
    int nEdge = OwnPlaceLabels(&border, 1, FixedHalf, &edgeHalf, 6, 4, -30, -30, 200, 200, edgeLabels, 4);
    BOOL offEdge = nEdge > 0;
    for (int i = 0; i < nEdge; i++) if (edgeLabels[i].x < 25) offEdge = NO;
    check(offEdge, @"labels prefer a straight span away from the map edge");

    OwnVec grazePts[2] = {{0, 12}, {220, 12}};
    OwnLine graze = {grazePts, 2, 0, 1024};
    double grazeHalf = 16;
    int nGraze = OwnPlaceLabels(&graze, 1, FixedHalf, &grazeHalf, 8, 4, 0, 0, 400, 220, labels, 4);
    check(nGraze == 0, @"a contour that only grazes the map edge stays unlabelled");
    nGraze = OwnCoverLabels(&graze, 1, FixedHalf, &grazeHalf, 8, 4, 0, 0, 400, 220, 40, 400, labels, 0, 4);
    check(nGraze == 0, @"coverage does not put a label on a contour that only grazes the edge");

    OwnVec inlandPts[] = {
        {30, 48}, {110, 48}, {150, 80}, {200, 150}, {280, 150}, {360, 150},
    };
    OwnLine inland = {inlandPts, 6, 0, 1020};
    double inlandHalf = 10;
    OwnLabel inlandLabels[4];
    int nInland = OwnPlaceLabels(&inland, 1, FixedHalf, &inlandHalf, 8, 4, 0, 0, 400, 300, inlandLabels, 4);
    BOOL onRim = NO, deep = NO;
    for (int i = 0; i < nInland; i++) {
        if (inlandLabels[i].y < 90) onRim = YES;
        if (inlandLabels[i].y > 120 && inlandLabels[i].x >= 190) deep = YES;
    }
    check(nInland >= 1 && !onRim && deep,
          [NSString stringWithFormat:@"a label prefers the interior of its contour (%d at %.0f,%.0f)",
              nInland, nInland ? inlandLabels[0].x : -1, nInland ? inlandLabels[0].y : -1]);

    OwnLine stack[4];
    OwnVec stackPts[4][2];
    for (int i = 0; i < 4; i++) {
        stackPts[i][0] = (OwnVec){0, 40.0 + i * 22.0};
        stackPts[i][1] = (OwnVec){520, 40.0 + i * 22.0};
        stack[i] = (OwnLine){stackPts[i], 2, 0, 1008 + i * 4};
    }
    double stackHalf = 14;
    OwnLabel stackLabels[8];
    int nStack = OwnPlaceLabels(stack, 4, FixedHalf, &stackHalf, 7, 4, 0, 0, 520, 200, stackLabels, 8);
    double minSep = 1e9;
    BOOL inMargin = nStack > 0;
    double margin = 1.5 * 14.0;
    for (int i = 0; i < nStack; i++) {
        if (stackLabels[i].x - stackLabels[i].halfW < margin) inMargin = NO;
        if (stackLabels[i].y - stackLabels[i].halfH < margin) inMargin = NO;
        if (520 - (stackLabels[i].x + stackLabels[i].halfW) < margin) inMargin = NO;
        if (200 - (stackLabels[i].y + stackLabels[i].halfH) < margin) inMargin = NO;
        for (int j = i + 1; j < nStack; j++) {
            double d = hypot(stackLabels[i].x - stackLabels[j].x, stackLabels[i].y - stackLabels[j].y);
            if (d < minSep) minSep = d;
        }
    }
    double need = 3.0 * 28.0;
    check(nStack >= 1 && inMargin && (nStack < 2 || minSep >= need - 0.5),
          [NSString stringWithFormat:@"stacked isobars keep labels %.0f apart and inside the margin (got %d, sep %.0f)",
              need, nStack, nStack < 2 ? -1 : minSep]);

    OwnLabel column[2] = {
        {.x = 40, .y = 50, .halfW = 16, .halfH = 8, .level = 1024, .line = 0},
        {.x = 44, .y = 88, .halfW = 16, .halfH = 8, .level = 1024, .line = 1},
    };
    int nColumn = OwnKeepSeparated(column, 2, 0);
    check(nColumn == 1, @"two labels closer than three widths are not both kept");
}

static OwnVec *HeapLine(const OwnVec *src, int n) {
    OwnVec *pts = malloc((size_t)n * sizeof(OwnVec));
    if (pts) memcpy(pts, src, (size_t)n * sizeof(OwnVec));
    return pts;
}

static void TestCentresAndCoverage(void) {
    const int n = 21;
    double *flat = calloc((size_t)(n * n), sizeof(double));
    double *bump = calloc((size_t)(n * n), sizeof(double));
    for (int i = 0; i < n * n; i++) { flat[i] = 1010; bump[i] = 1010; }
    bump[10 * n + 10] = 1011;
    check(Near(OwnRingProminence(flat, n, n, 0, 0, 1, 1, 10, 10, 4), 0, 1e-6),
          @"a flat field has no prominence");
    double shallow = OwnRingProminence(bump, n, n, 0, 0, 1, 1, 10, 10, 4);
    check(Near(shallow, 1, 0.05), [NSString stringWithFormat:@"a 1 hPa bump stands 1 hPa off its ring, got %.2f", shallow]);
    bump[10 * n + 10] = 1013;
    double deep = OwnRingProminence(bump, n, n, 0, 0, 1, 1, 10, 10, 4);
    check(Near(deep, 3, 0.05), [NSString stringWithFormat:@"a 3 hPa bump stands 3 hPa off its ring, got %.2f", deep]);
    for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) {
        double di = i - 10, dj = j - 10;
        bump[j * n + i] = 1000 + di * di + dj * dj;
    }
    double bowl = OwnRingProminence(bump, n, n, 0, 0, 1, 1, 10, 10, 4);
    check(bowl < -15, [NSString stringWithFormat:@"a bowl is a low against its ring, got %.1f", bowl]);
    free(flat);
    free(bump);

    OwnExtremum cands[4] = {
        {0, 0, 1018, 0},
        {30, 0, 1004, 0},
        {0, 20, 1028, 1},
        {3, 20, 1032, 1},
    };
    double prom[4] = {-1.0, -4.0, 3.0, 5.0};
    OwnExtremum out[4];
    int nKept = OwnSettleCentres(cands, prom, NULL, 4, 2.0, 1.0, 5.0, 3.0, 0, NULL, 0, out, 4);
    int lows = 0, highs = 0;
    BOOL deepLow = NO, strongHigh = NO;
    for (int i = 0; i < nKept; i++) {
        if (!out[i].high) { lows++; if (out[i].value < 1010) deepLow = YES; }
        else { highs++; if (out[i].value > 1030) strongHigh = YES; }
    }
    check(lows == 1 && deepLow, @"a 1 hPa dimple is dropped and the deep low stays");
    check(highs == 1 && strongHigh, @"same-type highs inside the merge distance collapse to the stronger");

    cands[3].x = 12;
    nKept = OwnSettleCentres(cands, prom, NULL, 4, 2.0, 1.0, 5.0, 3.0, 0, NULL, 0, out, 4);
    highs = 0;
    for (int i = 0; i < nKept; i++) if (out[i].high) highs++;
    check(highs == 2, @"highs outside the merge distance both stay");

    OwnExtremum weak = {0, 0, 1019, 0};
    double weakProm = -1.2;
    nKept = OwnSettleCentres(&weak, &weakProm, NULL, 1, 2.0, 1.0, 10.0, 3.0, 0, NULL, 0, out, 2);
    check(nKept == 0, @"a new centre below the appear threshold stays unmarked");
    OwnExtremum prior = {2, 0, 1018, 0};
    nKept = OwnSettleCentres(&weak, &weakProm, NULL, 1, 2.0, 1.0, 10.0, 3.0, 0, &prior, 1, out, 2);
    check(nKept == 1 && !out[0].high, @"a centre already shown is held at the lower threshold");
    prior.x = 20;
    nKept = OwnSettleCentres(&weak, &weakProm, NULL, 1, 2.0, 1.0, 10.0, 3.0, 0, &prior, 1, out, 2);
    check(nKept == 0, @"a held centre does not keep a different system");

    OwnExtremum pair[2] = {{115, -38, 1029, 1}, {119, -38, 1031, 1}};
    double pairProm[2] = {3.0, 4.0};
    nKept = OwnSettleCentres(pair, pairProm, NULL, 2, 2.0, 1.0, 500.0, 280.0, 1, NULL, 0, out, 2);
    check(nKept == 1 && out[0].value > 1030, @"highs about 350 km apart merge, keeping the stronger");
    pair[1].x = 130;
    nKept = OwnSettleCentres(pair, pairProm, NULL, 2, 2.0, 1.0, 500.0, 280.0, 1, NULL, 0, out, 2);
    check(nKept == 2, @"highs far past 500 km both stay");

    OwnVec ring[4] = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
    OwnLine box = {ring, 4, 1, 1016};
    OwnExtremum inside[2] = {{4, 4, 1012, 0}, {7, 6, 1008, 0}};
    int enclosed[2] = {0, 0};
    OwnMarkEnclosedCentres(inside, 2, &box, 1, 2.0, -INFINITY, -INFINITY, INFINITY, INFINITY, enclosed);
    check(enclosed[1] == 1 && enclosed[0] == 0, @"only the deeper low inside a closed isobar is enclosed");
    check(!OwnLineContains(&box, 12, 4), @"a point outside a closed isobar is not inside it");
    double mild[2] = {-0.8, -0.8};
    nKept = OwnSettleCentres(inside, mild, enclosed, 2, 2.0, 1.0, 3.0, 2.0, 0, NULL, 0, out, 2);
    check(nKept == 1 && Near(out[0].value, 1008, 1e-6),
          @"enclosure keeps a shallow low that a closed isobar surrounds");

    OwnExtremum vic = {4, 4, 1019, 0};
    double vicProm = -3.0;
    int vicEnclosed = 0;
    nKept = OwnSettleCentres(&vic, &vicProm, &vicEnclosed, 1, kOwnIsobarInterval, 1.0, 10.0, 3.0, 0,
        NULL, 0, out, 2);
    check(nKept == 0, @"a low under one contour interval and outside every ring is unmarked");
    vicProm = -kOwnIsobarInterval;
    nKept = OwnSettleCentres(&vic, &vicProm, &vicEnclosed, 1, kOwnIsobarInterval, 1.0, 10.0, 3.0, 0,
        NULL, 0, out, 2);
    check(nKept == 1 && !out[0].high, @"a low standing one contour interval is marked without a ring");
    vicProm = -3.0;
    vicEnclosed = 1;
    nKept = OwnSettleCentres(&vic, &vicProm, &vicEnclosed, 1, kOwnIsobarInterval, 1.0, 10.0, 3.0, 0,
        NULL, 0, out, 2);
    check(nKept == 1, @"a closed isobar keeps a low that has not reached the contour interval");
    vicEnclosed = 0;
    OwnExtremum vicPrior = {5, 4, 1018, 0};
    nKept = OwnSettleCentres(&vic, &vicProm, &vicEnclosed, 1, kOwnIsobarInterval, 1.0, 10.0, 3.0, 0,
        &vicPrior, 1, out, 2);
    check(nKept == 1, @"hysteresis holds a centre below the contour interval");

    OwnVec offRing[4] = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
    OwnLine offBox = {offRing, 4, 1, 1024};
    int offEnc[1] = {1};
    OwnMarkEnclosedCentres(&vic, 1, &offBox, 1, 2.0, 2, 2, 12, 12, offEnc);
    check(offEnc[0] == 0, @"a ring that leaves the map does not enclose its low");
    OwnMarkEnclosedCentres(&vic, 1, &offBox, 1, 2.0, -1, -1, 11, 11, offEnc);
    check(offEnc[0] == 1, @"a closed isobar inside the map encloses its low");

    OwnVec through[2] = {{0, 100}, {400, 100}};
    OwnLine throughLine = {through, 2, 0, 1020};
    OwnLabel onMark = {.x = 200, .y = 100, .halfW = 16, .halfH = 8, .arc = 200, .level = 1020, .line = 0};
    OwnVec mark = {200, 100};
    int nClear = OwnClearCentreLabels(&onMark, 1, &throughLine, 1, &mark, 1, 0, 0, 400, 220);
    double clearD = hypot(onMark.x - mark.x, onMark.y - mark.y);
    check(nClear == 1 && clearD >= 3.0 * 32.0 - 0.5,
          [NSString stringWithFormat:@"a label slides until it is three widths from an H or L (%.0f)", clearD]);
    OwnVec stubPts[2] = {{170, 100}, {230, 100}};
    OwnLine stubLine = {stubPts, 2, 0, 1020};
    OwnLabel stuck = {.x = 200, .y = 100, .halfW = 16, .halfH = 8, .arc = 30, .level = 1020, .line = 0};
    nClear = OwnClearCentreLabels(&stuck, 1, &stubLine, 1, &mark, 1, 0, 0, 400, 220);
    check(nClear == 0, @"a label that cannot clear an H or L is dropped");

    OwnVec ringPts[4] = {{100, 100}, {180, 100}, {180, 180}, {100, 180}};
    OwnLine ringLine = {ringPts, 4, 1, 1008};
    OwnVec ringCentre = {140, 140};
    double ringHalf = 12;
    OwnLabel ringLabels[4];
    int nRing = OwnCoverClosedRings(&ringLine, 1, FixedHalf, &ringHalf, 8, 0, 0, 400, 400, 28,
        &ringCentre, 1, ringLabels, 0, 4);
    double ringAway = nRing == 1 ? hypot(ringLabels[0].x - 140, ringLabels[0].y - 140) : 0;
    check(nRing == 1 && ringAway > 36,
        [NSString stringWithFormat:@"a closed ring keeps one label off the centre (%.0f)", ringAway]);
    nRing = OwnCoverClosedRings(&ringLine, 1, FixedHalf, &ringHalf, 8, 0, 0, 400, 400, 28,
        &ringCentre, 1, ringLabels, 1, 4);
    check(nRing == 1, @"a ring that already has a label does not gain a second");
    OwnVec openOnly[2] = {{0, 0}, {200, 0}};
    OwnLine openLine = {openOnly, 2, 0, 1016};
    int nOpen = OwnCoverClosedRings(&openLine, 1, FixedHalf, &ringHalf, 8, 0, 0, 400, 400, 28,
        NULL, 0, ringLabels, 0, 4);
    check(nOpen == 0, @"an open isobar is not given a ring label");
    OwnVec tinyPts[4] = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
    OwnLine tinyLine = {tinyPts, 4, 1, 1004};
    int nTiny = OwnCoverClosedRings(&tinyLine, 1, FixedHalf, &ringHalf, 8, 0, 0, 400, 400, 28,
        NULL, 0, ringLabels, 0, 4);
    check(nTiny == 0, @"a ring smaller than the span threshold stays bare");
    OwnVec crowdOpen[2] = {{0, 0}, {200, 0}};
    OwnVec crowdRing[4] = {{0, 0}, {40, 0}, {40, 40}, {0, 40}};
    OwnLine crowdLines[2] = {
        {crowdOpen, 2, 0, 1020},
        {crowdRing, 4, 1, 1016},
    };
    OwnLabel crowded[2] = {
        {.x = 100, .y = 100, .halfW = 16, .halfH = 8, .level = 1020, .line = 0},
        {.x = 180, .y = 100, .halfW = 16, .halfH = 8, .level = 1016, .line = 1},
    };
    OwnLabel separated[2] = {crowded[0], crowded[1]};
    int nCrowd = OwnKeepSeparated(separated, 2, 4);
    check(nCrowd == 1, @"the crowd radius drops a label eighty points from another");
    int nRingKept = OwnKeepRingLabels(crowded, 2, crowdLines, 2, 4);
    check(nRingKept == 2 && crowded[1].level == 1016, @"a closed ring keeps its label inside the crowd radius");
    OwnLabel overlap[2] = {
        {.x = 100, .y = 100, .halfW = 16, .halfH = 8, .level = 1020, .line = 0},
        {.x = 110, .y = 100, .halfW = 16, .halfH = 8, .level = 1016, .line = 1},
    };
    int nOverlap = OwnKeepRingLabels(overlap, 2, crowdLines, 2, 4);
    check(nOverlap == 1, @"a closed ring label that overlaps another glyph is dropped");
    crowdLines[1].closed = 0;
    OwnLabel openCrowded[2] = {
        {.x = 100, .y = 100, .halfW = 16, .halfH = 8, .level = 1020, .line = 0},
        {.x = 180, .y = 100, .halfW = 16, .halfH = 8, .level = 1016, .line = 1},
    };
    int nOpenCrowd = OwnKeepRingLabels(openCrowded, 2, crowdLines, 2, 4);
    check(nOpenCrowd == 1, @"an open isobar still loses a crowded label");

    OwnVec tinyRing[4] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
    OwnVec bigRing[4] = {{0, 0}, {8, 0}, {8, 8}, {0, 8}};
    OwnVec openPts[2] = {{0, 0}, {6, 0}};
    OwnLine *lines = calloc(3, sizeof(OwnLine));
    lines[0] = (OwnLine){HeapLine(tinyRing, 4), 4, 1, 1020};
    lines[1] = (OwnLine){HeapLine(bigRing, 4), 4, 1, 1024};
    lines[2] = (OwnLine){HeapLine(openPts, 2), 2, 0, 1012};
    OwnLineSet set = {lines, 3};
    OwnExtremum centre = {4, 4, 1028, 1};
    OwnDropStrayRings(&set, &centre, 1, 3.0);
    int tiny = 0, big = 0, open = 0;
    for (int i = 0; i < set.count; i++) {
        if (!set.lines[i].closed) { open++; continue; }
        double minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (int p = 0; p < set.lines[i].count; p++) {
            if (set.lines[i].pts[p].x < minX) minX = set.lines[i].pts[p].x;
            if (set.lines[i].pts[p].x > maxX) maxX = set.lines[i].pts[p].x;
            if (set.lines[i].pts[p].y < minY) minY = set.lines[i].pts[p].y;
            if (set.lines[i].pts[p].y > maxY) maxY = set.lines[i].pts[p].y;
        }
        if (fmax(maxX - minX, maxY - minY) < 2) tiny++;
        else big++;
    }
    check(tiny == 0 && big == 1 && open == 1, @"a small ring with no centre is dropped and a ring around a centre stays");
    OwnLineSetFree(set);

    OwnVec longPts[2] = {{0, 10}, {600, 10}};
    OwnVec midPts[2] = {{0, 40}, {140, 40}};
    OwnVec shortPts[2] = {{0, 70}, {40, 70}};
    OwnLine coverLines[3] = {
        {longPts, 2, 0, 1008},
        {midPts, 2, 0, 1012},
        {shortPts, 2, 0, 1016},
    };
    double half = 16;
    OwnLabel labels[8];
    int nLab = OwnCoverLabels(coverLines, 3, FixedHalf, &half, 6, 4, -20, -20, 700, 120, 80, 280, labels, 0, 8);
    int onLong = 0, onMid = 0, onShort = 0;
    for (int i = 0; i < nLab; i++) {
        if (labels[i].line == 0) onLong++;
        else if (labels[i].line == 1) onMid++;
        else if (labels[i].line == 2) onShort++;
    }
    check(onLong == 2 && onMid == 1 && onShort == 0,
          [NSString stringWithFormat:@"every long contour is labelled and a very long one twice (got %d %d %d)",
              onLong, onMid, onShort]);
    BOOL apart = YES;
    for (int i = 0; i < nLab; i++) for (int j = i + 1; j < nLab; j++)
        if (OwnLabelsOverlap(labels[i], labels[j], 4)) apart = NO;
    check(apart, @"covered labels do not overlap");
}

static void TestOpenFragments(void) {
    OwnVec stub[] = {{80, 40}, {130, 42}};
    OwnLine stubLine = {stub, 2, 0, 1012};
    check(OwnIsOpenFragment(&stubLine, 96, 48, 0, 0, 580, 444, 2),
        @"a short open stub inside the map is a fragment");
    OwnVec edge[] = {{0, 180}, {70, 190}};
    OwnLine edgeLine = {edge, 2, 0, 1016};
    check(!OwnIsOpenFragment(&edgeLine, 96, 48, 0, 0, 580, 444, 2),
        @"the visible end of a contour that leaves the map stays");
    OwnVec tick[] = {{578, 20}, {580, 28}};
    OwnLine tickLine = {tick, 2, 0, 1020};
    check(OwnIsOpenFragment(&tickLine, 96, 48, 0, 0, 580, 444, 2),
        @"a tick on the map edge is still a fragment");
    OwnVec longPts[] = {{40, 40}, {220, 80}, {360, 60}};
    OwnLine longLine = {longPts, 3, 0, 1024};
    check(!OwnIsOpenFragment(&longLine, 96, 48, 0, 0, 580, 444, 2),
        @"a long open isobar stays");
    OwnVec ring[] = {{10, 10}, {30, 10}, {30, 30}, {10, 30}};
    OwnLine ringLine = {ring, 4, 1, 1008};
    check(!OwnIsOpenFragment(&ringLine, 96, 48, 0, 0, 580, 444, 2),
        @"a closed ring is not an open fragment");
}

static void TestPruneAndReflect(void) {
    OwnVec spurSrc[] = {
        {0, 0}, {3, 0}, {6, 0}, {6.1, 1.0}, {7.0, 1.0}, {7.0, 0.05}, {6.05, 0}, {9, 0}, {12, 0},
    };
    OwnVec stubSrc[] = {{0, 0}, {0.2, 0.1}, {0.35, 0}};
    OwnVec openSrc[] = {{0, 0}, {5, 0}};
    OwnVec tinySrc[] = {{0, 0}, {2, 0}, {1, 0.02}};
    OwnVec bigSrc[] = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
    OwnLineSet set = {0};
    OwnLine *lines = calloc(5, sizeof(OwnLine));
    lines[0] = (OwnLine){HeapLine(spurSrc, 9), 9, 0, 1016};
    lines[1] = (OwnLine){HeapLine(stubSrc, 3), 3, 0, 1020};
    lines[2] = (OwnLine){HeapLine(openSrc, 2), 2, 0, 1012};
    lines[3] = (OwnLine){HeapLine(tinySrc, 3), 3, 1, 1008};
    lines[4] = (OwnLine){HeapLine(bigSrc, 4), 4, 1, 1024};
    set.lines = lines;
    set.count = 5;
    OwnPruneContours(&set, 1.2, 2.0, 0.3);
    int spur = 0, stub = 0, open = 0, tiny = 0, big = 0;
    double spurTop = 0;
    for (int i = 0; i < set.count; i++) {
        OwnLine line = set.lines[i];
        if (Near(line.level, 1016, 0.1)) {
            spur++;
            for (int p = 0; p < line.count; p++) if (line.pts[p].y > spurTop) spurTop = line.pts[p].y;
            check(Near(line.pts[0].x, 0, 1e-6) && Near(line.pts[line.count - 1].x, 12, 1e-6),
                  @"cutting a squiggle keeps the rest of the isobar");
        } else if (Near(line.level, 1020, 0.1)) stub++;
        else if (Near(line.level, 1012, 0.1)) open++;
        else if (Near(line.level, 1008, 0.1)) tiny++;
        else if (Near(line.level, 1024, 0.1)) {
            big++;
            check(line.closed, @"a large closed isobar stays a ring");
        }
    }
    check(spur == 1 && spurTop < 0.2, @"a tight loop is cut out of its isobar");

    // A hairpin copied from the northwest 1016: it leaves the line and returns
    // within a degree, enclosing under half a square degree. A 0.35° pinch
    // misses the mouth. A bow whose length stays near its chord stays.
    OwnVec hookSrc[] = {
        {116.0, -10.0}, {117.0, -10.584}, {117.099, -10.750}, {117.250, -10.978},
        {117.262, -11.000}, {117.414, -11.250}, {117.468, -11.500}, {117.442, -11.750},
        {117.428, -12.000}, {117.431, -12.250}, {117.484, -12.500}, {117.500, -12.529},
        {117.750, -12.539}, {117.773, -12.500}, {117.817, -12.250}, {117.825, -12.000},
        {117.848, -11.750}, {118.000, -11.547}, {119.0, -13.0}, {120.0, -14.0},
    };
    OwnVec bowSrc[] = {{0, 0}, {1, 0.08}, {2, 0.14}, {3, 0.16}, {4, 0.14}, {5, 0.08}, {6, 0}};
    OwnLineSet wide = {0};
    OwnLine *wideLines = calloc(2, sizeof(OwnLine));
    wideLines[0] = (OwnLine){HeapLine(hookSrc, 20), 20, 0, 1016};
    wideLines[1] = (OwnLine){HeapLine(bowSrc, 7), 7, 0, 1020};
    wide.lines = wideLines;
    wide.count = 2;
    OwnPruneContours(&wide, 1.2, 0.45, 0.85);
    double bowTop = 0;
    int nHook = 0, nBow = 0;
    BOOL bulge = NO;
    for (int i = 0; i < wide.count; i++) {
        if (Near(wide.lines[i].level, 1016, 0.1)) {
            nHook++;
            for (int p = 0; p < wide.lines[i].count; p++)
                if (wide.lines[i].pts[p].x < 118.2 && wide.lines[i].pts[p].y < -12.1) bulge = YES;
            check(wide.lines[i].count >= 2
                    && Near(wide.lines[i].pts[0].x, 116, 1e-6)
                    && Near(wide.lines[i].pts[wide.lines[i].count - 1].x, 120, 1e-6),
                @"cutting the hairpin keeps the rest of the isobar");
        } else if (Near(wide.lines[i].level, 1020, 0.1)) {
            nBow++;
            for (int p = 0; p < wide.lines[i].count; p++)
                if (wide.lines[i].pts[p].y > bowTop) bowTop = wide.lines[i].pts[p].y;
        }
    }
    check(nHook == 1 && !bulge, @"a hairpin under a degree is cut out of the isobar");
    check(nBow == 1 && bowTop > 0.1, @"a shallow bow is not treated as a squiggle");
    OwnLineSetFree(wide);

    OwnVec waveSrc[] = {{0, 0}, {1, 0.05}, {2, -0.2}, {2.4, 0.35}, {3, -0.1}, {4, 0}, {8, 0}};
    OwnVec bendSrc[] = {{0, 0}, {2, 0}, {4, 2.5}, {6, 0}, {8, 0}};
    OwnVec squareSrc[] = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
    OwnLineSet simple = {0};
    OwnLine *simpleLines = calloc(3, sizeof(OwnLine));
    simpleLines[0] = (OwnLine){HeapLine(waveSrc, 7), 7, 0, 1016};
    simpleLines[1] = (OwnLine){HeapLine(bendSrc, 5), 5, 0, 1020};
    simpleLines[2] = (OwnLine){HeapLine(squareSrc, 4), 4, 1, 1024};
    simple.lines = simpleLines;
    simple.count = 3;
    OwnSimplifyContours(&simple, 0.6);
    double waveOff = 0, bendOff = 0;
    int nWave = 0, nBend = 0, nSquare = 0;
    for (int i = 0; i < simple.count; i++) {
        OwnLine line = simple.lines[i];
        if (Near(line.level, 1016, 0.1)) {
            nWave++;
            for (int p = 0; p < line.count; p++) waveOff = fmax(waveOff, fabs(line.pts[p].y));
            check(Near(line.pts[0].x, 0, 1e-9) && Near(line.pts[line.count - 1].x, 8, 1e-9),
                @"simplifying a wiggle keeps the ends of the isobar");
        } else if (Near(line.level, 1020, 0.1)) {
            nBend++;
            for (int p = 0; p < line.count; p++) bendOff = fmax(bendOff, line.pts[p].y);
        } else if (Near(line.level, 1024, 0.1)) {
            nSquare++;
            check(line.closed && line.count == 4, @"a square ring keeps its corners");
        }
    }
    check(nWave == 1 && waveOff < 0.05, @"a half-degree wiggle is straightened");
    check(nBend == 1 && bendOff > 2.0, @"a deep bend is not simplified away");
    check(nSquare == 1, @"a closed ring is still there after simplifying");
    OwnLineSetFree(simple);
    check(stub == 0 && tiny == 0, @"a fragment and a tiny ring are dropped");
    check(open == 1 && big == 1, @"a long open line and a large ring stay");
    OwnLineSetFree(set);

    const int n = 8;
    double *ramp = malloc((size_t)n * n * sizeof(double));
    for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) ramp[j * n + i] = 1000 + 3.0 * i + 2.0 * j;
    OwnGaussianSmooth(ramp, n, n, 1.0);
    check(Near(ramp[0], 1003.633, 2e-3), @"the Gaussian reflects the field at the border");
    check(Near(ramp[3 * n + 3], 1015, 1e-3), @"reflection leaves the interior of a linear field unchanged");
    free(ramp);
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

    const int n = 31;
    double *field = calloc((size_t)(n * n), sizeof(double));
    for (int i = 0; i < n * n; i++) field[i] = 1010;
    OwnGaussianSmooth(field, n, n, 1.25);
    BOOL flat = YES;
    for (int i = 0; i < n * n; i++) if (fabs(field[i] - 1010) > 1e-6) flat = NO;
    check(flat, @"a constant pressure field is unchanged at the border and the middle");
    for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) field[j * n + i] = 3.0 * i + 2.0 * j;
    OwnGaussianSmooth(field, n, n, 1.25);
    BOOL linear = YES;
    for (int j = 6; j < n - 6; j++) for (int i = 6; i < n - 6; i++)
        if (fabs(field[j * n + i] - (3.0 * i + 2.0 * j)) > 1e-4) linear = NO;
    check(linear, @"the Gaussian keeps a linear field away from the border");
    for (int i = 0; i < n * n; i++) field[i] = 1000;
    field[15 * n + 15] = NAN;
    OwnGaussianSmooth(field, n, n, 1.25);
    check(isnan(field[15 * n + 15]), @"a missing pressure cell stays missing");
    check(isfinite(field[15 * n + 16]) && fabs(field[15 * n + 16] - 1000) < 0.05,
          @"a neighbour of a missing cell is not pulled toward zero");
    for (int i = 0; i < n * n; i++) field[i] = 0;
    field[15 * n + 15] = 1;
    OwnGaussianSmooth(field, n, n, 1.25);
    double mass = 0;
    for (int i = 0; i < n * n; i++) mass += field[i];
    check(fabs(mass - 1) < 1e-6 && field[15 * n + 15] < 0.25, @"a spike spreads and keeps its mass");
    double before = 0, after = 0;
    for (int i = 0; i < n; i++) {
        double wave = sin(i * (2.0 * M_PI / 3.0));
        field[15 * n + i] = wave;
        if (i >= 8 && i < n - 8) before += fabs(wave);
    }
    for (int j = 0; j < n; j++) if (j != 15) for (int i = 0; i < n; i++) field[j * n + i] = 0;
    for (int i = 0; i < n; i++) field[15 * n + i] = sin(i * (2.0 * M_PI / 3.0));
    OwnGaussianSmooth(field, n, n, 1.25);
    for (int i = 8; i < n - 8; i++) after += fabs(field[15 * n + i]);
    check(before > 1 && after < before * 0.25, @"a three-cell wiggle is smoothed away");
    free(field);

    BOOL (^nearByte)(OwnRGB, int, int, int) = ^BOOL(OwnRGB colour, int r, int g, int b) {
        return fabs(colour.r - r / 255.0) < 1e-12 && fabs(colour.g - g / 255.0) < 1e-12
            && fabs(colour.b - b / 255.0) < 1e-12;
    };
    check(nearByte(OwnChartSea(), 0xC5, 0xD6, 0xE4), @"sea is the soft chart blue");
    check(nearByte(OwnChartLand(), 0xE4, 0xD8, 0xC4), @"land is warm stone");
    check(nearByte(OwnChartInk(), 0x1B, 0x28, 0x30), @"isobar ink is charcoal");
    check(nearByte(OwnChartTitle(), 0x2E, 0x4C, 0x5C), @"the title bar is a calm slate");
    double (^lum)(OwnRGB) = ^double(OwnRGB colour) {
        double c[3] = {colour.r, colour.g, colour.b}, y = 0;
        double w[3] = {0.2126, 0.7152, 0.0722};
        for (int i = 0; i < 3; i++) {
            double v = c[i] <= 0.04045 ? c[i] / 12.92 : pow((c[i] + 0.055) / 1.055, 2.4);
            y += w[i] * v;
        }
        return y;
    };
    double (^contrast)(OwnRGB, OwnRGB) = ^double(OwnRGB a, OwnRGB b) {
        double L1 = lum(a), L2 = lum(b);
        if (L1 < L2) { double t = L1; L1 = L2; L2 = t; }
        return (L1 + 0.05) / (L2 + 0.05);
    };
    OwnRGB white = {1, 1, 1};
    check(contrast(OwnChartInk(), OwnChartSea()) >= 4.5 && contrast(OwnChartInk(), OwnChartLand()) >= 4.5,
          @"ink stays legible on sea and on land");
    check(contrast(white, OwnChartTitle()) >= 4.5, @"white title text stays legible on the bar");
    check(OwnIsobarWidth(1020) > OwnIsobarWidth(1016) && OwnIsobarWidth(1000) == OwnIsobarWidth(1040),
          @"1000 and 1020 lines are heavier than the 4 hPa lines");
    check(OwnIsobarWidth(1012) == OwnIsobarWidth(1004) && OwnIsobarWidth(1012) < 1.4,
          @"ordinary isobars stay the lighter weight");
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
        TestCentresAndCoverage();
        TestOpenFragments();
        TestPruneAndReflect();
        TestBarbsAndColour();
        TestCoast();
        fprintf(stderr, "%s\n", failures ? "FAILED" : "OK");
        return failures ? 1 : 0;
    }
}
