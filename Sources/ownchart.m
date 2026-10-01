#import "ownchart.h"
#import <math.h>
#import <stdlib.h>
#import <string.h>

static const double kStep = 0.25;
static const double kWest = 95.0;
static const double kNorth = 0.0;
static const int kNLon = 301;
static const int kNLat = 201;

double OwnGridStep(void) { return kStep; }
double OwnGridWest(void) { return kWest; }
double OwnGridNorth(void) { return kNorth; }
int OwnGridNLon(void) { return kNLon; }
int OwnGridNLat(void) { return kNLat; }
NSInteger OwnGridCount(void) { return (NSInteger)kNLon * kNLat; }
double OwnGridEast(void) { return kWest + (kNLon - 1) * kStep; }
double OwnGridSouth(void) { return kNorth - (kNLat - 1) * kStep; }

void OwnGridCoord(NSInteger index, double *latitude, double *longitude) {
    if (index < 0 || index >= OwnGridCount()) {
        if (latitude) *latitude = NAN;
        if (longitude) *longitude = NAN;
        return;
    }
    NSInteger col = index % kNLon;
    NSInteger row = index / kNLon;
    if (longitude) *longitude = kWest + col * kStep;
    if (latitude) *latitude = kNorth - row * kStep;
}

NSInteger OwnBatchCount(void) {
    NSInteger n = OwnGridCount();
    return (n + OwnBatchLimit - 1) / OwnBatchLimit;
}

void OwnBatchRange(NSInteger batch, NSInteger *start, NSInteger *length) {
    NSInteger n = OwnGridCount();
    NSInteger s = batch * OwnBatchLimit;
    if (batch < 0 || s >= n) {
        if (start) *start = 0;
        if (length) *length = 0;
        return;
    }
    NSInteger len = OwnBatchLimit;
    if (s + len > n) len = n - s;
    if (start) *start = s;
    if (length) *length = len;
}

static void AppendCoord(NSMutableString *out, double value) {
    NSString *text = [NSString stringWithFormat:@"%.4f", value];
    while (text.length > 1 && [text hasSuffix:@"0"]) text = [text substringToIndex:text.length - 1];
    if ([text hasSuffix:@"."]) text = [text substringToIndex:text.length - 1];
    [out appendString:text];
}

NSString *OwnForecastURLWithPast(const double *latitudes, const double *longitudes,
    NSInteger count, NSInteger forecastDays, NSInteger pastDays) {
    if (!latitudes || !longitudes || count <= 0) return nil;
    if (forecastDays < 1) forecastDays = 1;
    if (pastDays < 0) pastDays = 0;
    NSMutableString *lats = [NSMutableString string];
    NSMutableString *lons = [NSMutableString string];
    for (NSInteger i = 0; i < count; i++) {
        if (i) {
            [lats appendString:@","];
            [lons appendString:@","];
        }
        AppendCoord(lats, latitudes[i]);
        AppendCoord(lons, longitudes[i]);
    }
    NSString *past = pastDays > 0
        ? [NSString stringWithFormat:@"&past_days=%ld", (long)pastDays] : @"";
    return [NSString stringWithFormat:
        @"https://api.open-meteo.com/v1/forecast?latitude=%@&longitude=%@"
        @"&hourly=pressure_msl,temperature_850hPa,temperature_2m,wind_speed_10m,wind_direction_10m,precipitation"
        @"&models=ecmwf_ifs025&timezone=UTC&forecast_days=%ld&wind_speed_unit=kn%@",
        lats, lons, (long)forecastDays, past];
}

NSString *OwnForecastURL(const double *latitudes, const double *longitudes,
    NSInteger count, NSInteger forecastDays) {
    return OwnForecastURLWithPast(latitudes, longitudes, count, forecastDays, 0);
}

static NSArray *NumArray(id value) {
    if (![value isKindOfClass:NSArray.class]) return nil;
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:[value count]];
    for (id item in value) {
        if ([item isKindOfClass:NSNumber.class]) [out addObject:item];
        else if (item == NSNull.null || item == nil) [out addObject:NSNull.null];
        else return nil;
    }
    return out;
}

NSArray<NSDictionary *> *OwnParseForecast(NSData *json) {
    if (!json.length) return nil;
    id root = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
    if ([root isKindOfClass:NSDictionary.class]) {
        if ([root[@"error"] boolValue]) return nil;
        root = @[root];
    }
    if (![root isKindOfClass:NSArray.class] || [root count] == 0) return nil;
    NSArray *keys = @[@"pressure_msl", @"temperature_850hPa", @"temperature_2m",
        @"wind_speed_10m", @"wind_direction_10m", @"precipitation"];
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:[root count]];
    for (id item in root) {
        if (![item isKindOfClass:NSDictionary.class]) return nil;
        NSDictionary *hourly = item[@"hourly"];
        if (![hourly isKindOfClass:NSDictionary.class]) return nil;
        NSArray *times = hourly[@"time"];
        if (![times isKindOfClass:NSArray.class] || times.count == 0) return nil;
        NSMutableDictionary *row = [@{
            @"latitude": item[@"latitude"] ?: NSNull.null,
            @"longitude": item[@"longitude"] ?: NSNull.null,
            @"time": times,
        } mutableCopy];
        for (NSString *key in keys) {
            NSArray *series = NumArray(hourly[key]);
            if (series.count != times.count) return nil;
            row[key] = series;
        }
        [out addObject:row];
    }
    return out;
}

NSInteger OwnTimeIndex(NSArray<NSString *> *times, NSDate *instant) {
    if (!times.count || !instant) return -1;
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    fmt.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    fmt.dateFormat = @"yyyy-MM-dd'T'HH:mm";
    NSString *key = [fmt stringFromDate:instant];
    NSUInteger idx = [times indexOfObject:key];
    return idx == NSNotFound ? -1 : (NSInteger)idx;
}

double OwnTrailingSum(NSArray *values, NSInteger index, NSInteger hours) {
    if (![values isKindOfClass:NSArray.class] || index < 0 || hours <= 0) return NAN;
    if (index >= (NSInteger)values.count) return NAN;
    NSInteger start = index - hours + 1;
    if (start < 0) start = 0;
    double sum = 0;
    for (NSInteger i = start; i <= index; i++) {
        id item = values[i];
        if ([item isKindOfClass:NSNumber.class]) sum += [item doubleValue];
    }
    return sum;
}

double OwnPrecedingSum(NSArray *values, NSInteger index, NSInteger hours) {
    if (![values isKindOfClass:NSArray.class] || index < 0 || hours <= 0) return NAN;
    if (index >= (NSInteger)values.count) return NAN;
    NSInteger start = index - hours + 1;
    if (start < 0) return NAN;
    double sum = 0;
    for (NSInteger i = start; i <= index; i++) {
        id item = values[i];
        if ([item isKindOfClass:NSNumber.class]) sum += [item doubleValue];
    }
    return sum;
}

double OwnAccumulationWindow(double endMm, double startMm) {
    if (!isfinite(endMm) || !isfinite(startMm)) return NAN;
    double diff = endMm - startMm;
    if (diff < -0.05) return NAN;
    if (diff < 0) return 0;
    return diff;
}

BOOL OwnRefreshDue(NSDate *lastFetch, NSDate *now) {
    if (!lastFetch || !now) return YES;
    return [now timeIntervalSinceDate:lastFetch] >= 12.0 * 3600.0;
}

static NSTimeZone *EasternStandard(void) {
    return [NSTimeZone timeZoneForSecondsFromGMT:10 * 3600];
}

static NSDate *DateAt(NSInteger year, NSInteger month, NSInteger day, NSInteger hour, NSTimeZone *zone) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = zone;
    NSDateComponents *c = [NSDateComponents new];
    c.year = year;
    c.month = month;
    c.day = day;
    c.hour = hour;
    c.minute = 0;
    c.second = 0;
    c.timeZone = zone;
    return [cal dateFromComponents:c];
}

NSArray<NSDate *> *OwnPrognosisTimes(NSDate *now) {
    if (!now) return @[];
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = EasternStandard();
    NSDateComponents *day = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay fromDate:now];
    NSDate *issueDay = DateAt(day.year, day.month, day.day, 0, EasternStandard());
    NSDate *first = [cal dateByAddingUnit:NSCalendarUnitDay value:1 toDate:issueDay options:0];
    NSDateComponents *start = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay fromDate:first];
    NSDate *cursor = DateAt(start.year, start.month, start.day, 10, EasternStandard());
    if (!cursor) return @[];
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:8];
    for (int i = 0; i < 8; i++) {
        [out addObject:cursor];
        cursor = [cursor dateByAddingTimeInterval:12 * 3600];
    }
    return out;
}

NSInteger OwnForecastDayCount(NSDate *now, NSDate *lastValid) {
    if (!now || !lastValid) return 4;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSDate *start = [cal startOfDayForDate:now];
    NSTimeInterval span = [lastValid timeIntervalSinceDate:start];
    if (span < 0) return 4;
    double hours = span / 3600.0 + 1.0;
    NSInteger days = (NSInteger)ceil(hours / 24.0 - 1e-9);
    if (days < 4) days = 4;
    if (days > 16) days = 16;
    return days;
}

NSDate *OwnNearestHour(NSDate *now) {
    if (!now) return nil;
    NSTimeInterval t = now.timeIntervalSince1970;
    NSTimeInterval hour = 3600.0;
    NSTimeInterval rounded = floor(t / hour + 0.5) * hour;
    return [NSDate dateWithTimeIntervalSince1970:rounded];
}

NSString *OwnValidTitle(NSDate *valid, BOOL now) {
    if (!valid) return now ? @"Now" : @"Forecast";
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = EasternStandard();
    NSDateComponents *c = [cal components:NSCalendarUnitHour | NSCalendarUnitMinute fromDate:valid];
    NSInteger hour = c.hour;
    NSString *suffix = hour >= 12 ? @"pm" : @"am";
    NSInteger h12 = hour % 12;
    if (h12 == 0) h12 = 12;
    NSString *clock = c.minute == 0
        ? [NSString stringWithFormat:@"%ld%@", (long)h12, suffix]
        : [NSString stringWithFormat:@"%ld:%02ld%@", (long)h12, (long)c.minute, suffix];
    NSDateFormatter *day = [NSDateFormatter new];
    day.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    day.timeZone = EasternStandard();
    day.dateFormat = @"EEE d MMM";
    NSString *title = [NSString stringWithFormat:@"%@ EST %@", clock, [day stringFromDate:valid] ?: @""];
    return now ? [@"Now · " stringByAppendingString:title] : title;
}

static double Deg(double radians) { return radians * 180.0 / M_PI; }
static double Rad(double degrees) { return degrees * M_PI / 180.0; }

OwnLambert OwnLambertMake(double centralMeridianDeg, double parallelDeg) {
    OwnLambert geo = {0};
    double phi = Rad(parallelDeg);
    double n = sin(phi);
    if (fabs(n) < 1e-8) return geo;
    double t1 = tan(M_PI_4 + phi / 2.0);
    if (!(t1 > 0)) return geo;
    double F = cos(phi) * pow(t1, n) / n;
    double rho0 = F / pow(t1, n);
    if (!isfinite(F) || !isfinite(rho0)) return geo;
    geo.lon0 = centralMeridianDeg;
    geo.parallel = parallelDeg;
    geo.n = n;
    geo.F = F;
    geo.rho0 = rho0;
    geo.valid = YES;
    return geo;
}

OwnLambert OwnAustraliaLambert(void) {
    return OwnLambertMake(130.0, -30.0);
}

static double RhoAt(OwnLambert geo, double latitudeDeg) {
    double t = tan(M_PI_4 + Rad(latitudeDeg) / 2.0);
    if (!(t > 0)) return NAN;
    return geo.F / pow(t, geo.n);
}

BOOL OwnProject(OwnLambert geo, double latitude, double longitude, double *x, double *y) {
    if (!geo.valid || !x || !y) return NO;
    if (latitude <= -89.0 || latitude >= 89.0) return NO;
    double rho = RhoAt(geo, latitude);
    if (!isfinite(rho)) return NO;
    double theta = geo.n * Rad(longitude - geo.lon0);
    *x = rho * sin(theta);
    *y = geo.rho0 - rho * cos(theta);
    return isfinite(*x) && isfinite(*y);
}

BOOL OwnUnproject(OwnLambert geo, double x, double y, double *latitude, double *longitude) {
    if (!geo.valid || !latitude || !longitude) return NO;
    double dx = x;
    double dy = geo.rho0 - y;
    double theta = geo.n < 0 ? atan2(-dx, -dy) : atan2(dx, dy);
    double rho = (geo.n < 0 ? -1.0 : 1.0) * hypot(dx, dy);
    if (!(fabs(rho) > 1e-15) || !isfinite(geo.F / rho)) return NO;
    double base = geo.F / rho;
    if (!(base > 0)) return NO;
    double t = pow(base, 1.0 / geo.n);
    if (!(t > 0) || !isfinite(t)) return NO;
    *latitude = Deg(2.0 * atan(t) - M_PI_2);
    *longitude = geo.lon0 + Deg(theta / geo.n);
    return isfinite(*latitude) && isfinite(*longitude);
}

OwnView OwnViewMake(OwnLambert geo, double west, double east, double south, double north,
    double pixelX, double pixelY, double pixelW, double pixelH) {
    OwnView view = {0};
    view.geo = geo;
    if (!geo.valid || !(east > west) || !(north > south) || pixelW <= 1 || pixelH <= 1) return view;
    view.west = west;
    view.east = east;
    view.south = south;
    view.north = north;
    view.pixelX = pixelX;
    view.pixelY = pixelY;
    view.pixelW = pixelW;
    view.pixelH = pixelH;
    int samples = 24;
    BOOL any = NO;
    double minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (int i = 0; i <= samples; i++) {
        double u = (double)i / (double)samples;
        double lons[2] = {west + (east - west) * u, west + (east - west) * u};
        double lats[2] = {south, north};
        double edgeLon[2] = {west, east};
        double edgeLat[2] = {south + (north - south) * u, south + (north - south) * u};
        double xs[4] = {lons[0], lons[1], edgeLon[0], edgeLon[1]};
        double ys[4] = {lats[0], lats[1], edgeLat[0], edgeLat[1]};
        for (int k = 0; k < 4; k++) {
            double px, py;
            if (!OwnProject(geo, ys[k], xs[k], &px, &py)) continue;
            if (!any) {
                minX = maxX = px;
                minY = maxY = py;
                any = YES;
            } else {
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }
        }
    }
    if (!any || !(maxX > minX) || !(maxY > minY)) return view;
    double scale = pixelW / (maxX - minX);
    double scaleY = pixelH / (maxY - minY);
    if (scaleY < scale) scale = scaleY;
    double usedW = (maxX - minX) * scale;
    double usedH = (maxY - minY) * scale;
    view.scale = scale;
    view.minX = minX;
    view.maxX = maxX;
    view.minY = minY;
    view.maxY = maxY;
    view.offsetX = pixelX + (pixelW - usedW) / 2.0;
    view.offsetY = pixelY + (pixelH - usedH) / 2.0;
    view.valid = YES;
    return view;
}

BOOL OwnViewProject(OwnView view, double latitude, double longitude, double *x, double *y) {
    if (!view.valid || !x || !y) return NO;
    double px, py;
    if (!OwnProject(view.geo, latitude, longitude, &px, &py)) return NO;
    *x = view.offsetX + (px - view.minX) * view.scale;
    *y = view.offsetY + (view.maxY - py) * view.scale;
    return isfinite(*x) && isfinite(*y);
}

void OwnLineSetFree(OwnLineSet set) {
    for (int i = 0; i < set.count; i++) free(set.lines[i].pts);
    free(set.lines);
}

static int PushLine(OwnLineSet *set, OwnVec *pts, int count, int closed, double level) {
    if (count < 2 || !pts) {
        free(pts);
        return 0;
    }
    OwnLine *grown = realloc(set->lines, (size_t)(set->count + 1) * sizeof(OwnLine));
    if (!grown) {
        free(pts);
        return 0;
    }
    set->lines = grown;
    set->lines[set->count++] = (OwnLine){pts, count, closed, level};
    return 1;
}

static double LerpT(double a, double b, double level) {
    double d = b - a;
    if (fabs(d) < 1e-15) return 0;
    double t = (level - a) / d;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t;
}

static OwnVec LerpVec(OwnVec a, OwnVec b, double t) {
    return (OwnVec){a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t};
}

typedef struct {
    OwnVec p[2];
    int edge[2];
} Seg;

typedef struct {
    int seg, which;
} Adj;

OwnLineSet OwnContours(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy,
    const double *levels, int nLevels) {
    OwnLineSet set = {0};
    if (!field || nLon < 2 || nLat < 2 || !levels || nLevels <= 0) return set;
    if (!(dx != 0) || !(dy != 0)) return set;
    int stride = nLon + 1;
    int keyMax = (nLat + 1) * stride * 2;
    int segCap = nLon * nLat * 2;
    Seg *segs = malloc((size_t)segCap * sizeof(Seg));
    Adj *adj = malloc((size_t)keyMax * 2 * sizeof(Adj));
    int *nAdj = malloc((size_t)keyMax * sizeof(int));
    unsigned char *used = malloc((size_t)segCap);
    if (!segs || !adj || !nAdj || !used) {
        free(segs); free(adj); free(nAdj); free(used);
        return set;
    }
    for (int L = 0; L < nLevels; L++) {
        double level = levels[L];
        if (!isfinite(level)) continue;
        int nSeg = 0;
        memset(nAdj, 0, (size_t)keyMax * sizeof(int));

        for (int j = 0; j < nLat - 1; j++) {
            for (int i = 0; i < nLon - 1; i++) {
                double v[4] = {
                    field[j * nLon + i],
                    field[j * nLon + i + 1],
                    field[(j + 1) * nLon + i + 1],
                    field[(j + 1) * nLon + i],
                };
                if (!isfinite(v[0]) || !isfinite(v[1]) || !isfinite(v[2]) || !isfinite(v[3])) continue;
                // Nudge a node that sits on the level so the edge still has a crossing.
                for (int c = 0; c < 4; c++) if (v[c] == level) v[c] = nextafter(v[c], INFINITY);
                int mask = 0;
                if (v[0] >= level) mask |= 1;
                if (v[1] >= level) mask |= 2;
                if (v[2] >= level) mask |= 4;
                if (v[3] >= level) mask |= 8;
                if (mask == 0 || mask == 15) continue;
                OwnVec corner[4] = {
                    {originX + i * dx, originY + j * dy},
                    {originX + (i + 1) * dx, originY + j * dy},
                    {originX + (i + 1) * dx, originY + (j + 1) * dy},
                    {originX + i * dx, originY + (j + 1) * dy},
                };
                int edgeId[4] = {
                    (j * stride + i) * 2,             // bottom, bl-br
                    (j * stride + (i + 1)) * 2 + 1,   // right, br-tr
                    ((j + 1) * stride + i) * 2,       // top, tl-tr
                    (j * stride + i) * 2 + 1,         // left, bl-tl
                };
                // Crossings: 0 bottom, 1 right, 2 top, 3 left.
                OwnVec cross[4];
                int have[4] = {0, 0, 0, 0};
                int pairA[4] = {0, 1, 3, 0};
                int pairB[4] = {1, 2, 2, 3};
                for (int e = 0; e < 4; e++) {
                    int aboveA = (v[pairA[e]] >= level);
                    int aboveB = (v[pairB[e]] >= level);
                    if (aboveA == aboveB) continue;
                    double t = LerpT(v[pairA[e]], v[pairB[e]], level);
                    cross[e] = LerpVec(corner[pairA[e]], corner[pairB[e]], t);
                    have[e] = 1;
                }
                int links[4][2];
                int nLink = 0;
#define OWN_LINK(a, b) do { \
                    if (have[(a)] && have[(b)] && nLink < 2) { \
                        links[nLink][0] = (a); \
                        links[nLink][1] = (b); \
                        nLink++; \
                    } \
                } while (0)
                switch (mask) {
                    case 1: case 14: OWN_LINK(3, 0); break;
                    case 2: case 13: OWN_LINK(0, 1); break;
                    case 3: case 12: OWN_LINK(3, 1); break;
                    case 4: case 11: OWN_LINK(1, 2); break;
                    case 6: case 9: OWN_LINK(0, 2); break;
                    case 7: case 8: OWN_LINK(3, 2); break;
                    case 5: case 10: {
                        double avg = 0.25 * (v[0] + v[1] + v[2] + v[3]);
                        BOOL through = (mask == 5) ? (avg >= level) : (avg < level);
                        if (through) { OWN_LINK(3, 0); OWN_LINK(1, 2); }
                        else { OWN_LINK(0, 1); OWN_LINK(3, 2); }
                        break;
                    }
                    default: break;
                }
#undef OWN_LINK
                for (int s = 0; s < nLink; s++) {
                    if (nSeg >= segCap) break;
                    int a = links[s][0], b = links[s][1];
                    if (edgeId[a] < 0 || edgeId[a] >= keyMax || edgeId[b] < 0 || edgeId[b] >= keyMax) continue;
                    segs[nSeg] = (Seg){.p = {cross[a], cross[b]}, .edge = {edgeId[a], edgeId[b]}};
                    nSeg++;
                }
            }
        }
        for (int s = 0; s < nSeg; s++) {
            for (int w = 0; w < 2; w++) {
                int key = segs[s].edge[w];
                if (key < 0 || key >= keyMax || nAdj[key] >= 2) continue;
                adj[key * 2 + nAdj[key]] = (Adj){s, w};
                nAdj[key]++;
            }
        }
        memset(used, 0, (size_t)nSeg);
        for (;;) {
            int start = -1, which = 0, closed = 1;
            for (int s = 0; s < nSeg; s++) {
                if (used[s]) continue;
                if (start < 0) start = s;
                for (int w = 0; w < 2; w++) {
                    int key = segs[s].edge[w];
                    if (nAdj[key] == 1) {
                        start = s;
                        which = w;
                        closed = 0;
                        s = nSeg;
                        break;
                    }
                }
            }
            if (start < 0) break;
            int capPts = 16;
            int nPts = 0;
            OwnVec *pts = malloc((size_t)capPts * sizeof(OwnVec));
            if (!pts) break;
            int cur = start;
            int arrived = which;
            used[cur] = 1;
            pts[nPts++] = segs[cur].p[arrived];
            for (;;) {
                int leave = 1 - arrived;
                OwnVec next = segs[cur].p[leave];
                if (nPts >= capPts) {
                    capPts *= 2;
                    OwnVec *grown = realloc(pts, (size_t)capPts * sizeof(OwnVec));
                    if (!grown) break;
                    pts = grown;
                }
                if (!(nPts > 0 && fabs(pts[nPts - 1].x - next.x) < 1e-12 && fabs(pts[nPts - 1].y - next.y) < 1e-12))
                    pts[nPts++] = next;
                int key = segs[cur].edge[leave];
                int found = -1, foundWhich = 0;
                for (int a = 0; a < nAdj[key] && a < 2; a++) {
                    if (adj[key * 2 + a].seg != cur) {
                        found = adj[key * 2 + a].seg;
                        foundWhich = adj[key * 2 + a].which;
                        break;
                    }
                }
                if (found < 0 || used[found]) {
                    if (found == start) closed = 1;
                    else if (found < 0) closed = 0;
                    break;
                }
                used[found] = 1;
                cur = found;
                arrived = foundWhich;
            }
            if (nPts >= 2 && closed) {
                // Drop a repeated closing vertex if the walk added one.
                if (fabs(pts[0].x - pts[nPts - 1].x) < 1e-9 && fabs(pts[0].y - pts[nPts - 1].y) < 1e-9 && nPts > 2)
                    nPts--;
            }
            if (closed && nPts < 4) {
                free(pts);
                continue;
            }
            PushLine(&set, pts, nPts, closed, level);
        }
    }
    free(segs);
    free(adj);
    free(nAdj);
    free(used);
    return set;
}

void OwnSmoothLine(OwnVec *pts, int count, int closed, int passes) {
    if (!pts || count < 3 || passes <= 0) return;
    OwnVec *tmp = malloc((size_t)count * sizeof(OwnVec));
    if (!tmp) return;
    for (int pass = 0; pass < passes; pass++) {
        if (closed) {
            for (int i = 0; i < count; i++) {
                OwnVec a = pts[(i - 1 + count) % count];
                OwnVec b = pts[i];
                OwnVec c = pts[(i + 1) % count];
                tmp[i] = (OwnVec){0.2 * a.x + 0.6 * b.x + 0.2 * c.x, 0.2 * a.y + 0.6 * b.y + 0.2 * c.y};
            }
        } else {
            tmp[0] = pts[0];
            tmp[count - 1] = pts[count - 1];
            for (int i = 1; i < count - 1; i++) {
                tmp[i] = (OwnVec){
                    0.2 * pts[i - 1].x + 0.6 * pts[i].x + 0.2 * pts[i + 1].x,
                    0.2 * pts[i - 1].y + 0.6 * pts[i].y + 0.2 * pts[i + 1].y,
                };
            }
        }
        memcpy(pts, tmp, (size_t)count * sizeof(OwnVec));
    }
    free(tmp);
}

int OwnDensify(const OwnVec *in, int n, int closed, OwnVec *out, int outCap) {
    if (!in || !out || n < 2) return -1;
    int need = closed ? n * 2 : n * 2 - 1;
    if (outCap < need) return -1;
    int w = 0;
    int edges = closed ? n : n - 1;
    for (int i = 0; i < edges; i++) {
        OwnVec a = in[i];
        OwnVec b = in[(i + 1) % n];
        out[w++] = a;
        out[w++] = (OwnVec){0.5 * (a.x + b.x), 0.5 * (a.y + b.y)};
    }
    if (!closed) out[w++] = in[n - 1];
    return w;
}

int OwnInteriorLevels(double minV, double maxV, double step, double *out, int cap) {
    if (!out || cap <= 0 || !(step > 0) || !(maxV > minV)) return 0;
    long first = (long)floor(minV / step + 1e-9) + 1;
    long last = (long)ceil(maxV / step - 1e-9) - 1;
    int n = 0;
    for (long k = first; k <= last && n < cap; k++) out[n++] = (double)k * step;
    return n;
}

static double Sample(const double *field, int nLon, int nLat, int i, int j) {
    if (i < 0 || j < 0 || i >= nLon || j >= nLat) return NAN;
    return field[j * nLon + i];
}

typedef struct {
    int i, j;
    double value, relief, ox, oy;
    int high;
} ExtCand;

int OwnExtrema(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy,
    double minSeparation, double minRelief,
    OwnExtremum *out, int cap) {
    if (!field || !out || cap <= 0 || nLon < 3 || nLat < 3) return 0;
    int maxCand = (nLon - 2) * (nLat - 2);
    if (maxCand <= 0) return 0;
    ExtCand *cands = malloc((size_t)maxCand * sizeof(ExtCand));
    if (!cands) return 0;
    int n = 0;
    for (int j = 1; j < nLat - 1; j++) {
        for (int i = 1; i < nLon - 1; i++) {
            double z = Sample(field, nLon, nLat, i, j);
            if (!isfinite(z)) continue;
            double neigh[8];
            int k = 0;
            BOOL finite = YES;
            for (int dj = -1; dj <= 1; dj++) {
                for (int di = -1; di <= 1; di++) {
                    if (!di && !dj) continue;
                    neigh[k] = Sample(field, nLon, nLat, i + di, j + dj);
                    if (!isfinite(neigh[k])) finite = NO;
                    k++;
                }
            }
            if (!finite) continue;
            BOOL low = YES, high = YES;
            double sum = 0;
            for (int t = 0; t < 8; t++) {
                if (neigh[t] < z - 1e-9) low = NO;
                if (neigh[t] > z + 1e-9) high = NO;
                sum += neigh[t];
            }
            double mean = sum / 8.0;
            double relief = low ? (mean - z) : (z - mean);
            if ((!low && !high) || low == high || relief < minRelief) continue;
            double ox = 0, oy = 0;
            double zm = Sample(field, nLon, nLat, i - 1, j);
            double zp = Sample(field, nLon, nLat, i + 1, j);
            double denom = zm - 2.0 * z + zp;
            if (isfinite(denom) && fabs(denom) > 1e-9) {
                ox = 0.5 * (zm - zp) / denom;
                if (ox > 0.75) ox = 0.75;
                if (ox < -0.75) ox = -0.75;
            }
            zm = Sample(field, nLon, nLat, i, j - 1);
            zp = Sample(field, nLon, nLat, i, j + 1);
            denom = zm - 2.0 * z + zp;
            if (isfinite(denom) && fabs(denom) > 1e-9) {
                oy = 0.5 * (zm - zp) / denom;
                if (oy > 0.75) oy = 0.75;
                if (oy < -0.75) oy = -0.75;
            }
            cands[n++] = (ExtCand){i, j, z, relief, ox, oy, high ? 1 : 0};
        }
    }
    for (int a = 1; a < n; a++) {
        ExtCand c = cands[a];
        int b = a;
        while (b > 0 && cands[b - 1].relief < c.relief) {
            cands[b] = cands[b - 1];
            b--;
        }
        cands[b] = c;
    }
    int kept = 0;
    for (int a = 0; a < n && kept < cap; a++) {
        double x = originX + (cands[a].i + cands[a].ox) * dx;
        double y = originY + (cands[a].j + cands[a].oy) * dy;
        BOOL near = NO;
        for (int b = 0; b < kept; b++) {
            double dxp = x - out[b].x, dyp = y - out[b].y;
            if (hypot(dxp, dyp) < minSeparation) { near = YES; break; }
        }
        if (near) continue;
        out[kept++] = (OwnExtremum){x, y, cands[a].value, cands[a].high};
    }
    free(cands);
    return kept;
}

static double Dist(OwnVec a, OwnVec b) { return hypot(b.x - a.x, b.y - a.y); }

static double *ArcLengths(const OwnVec *pts, int n, int closed, double *total) {
    if (n < 2) return NULL;
    double *s = malloc((size_t)n * sizeof(double));
    if (!s) return NULL;
    s[0] = 0;
    for (int i = 1; i < n; i++) s[i] = s[i - 1] + Dist(pts[i - 1], pts[i]);
    *total = s[n - 1];
    if (closed) *total += Dist(pts[n - 1], pts[0]);
    return s;
}

static BOOL PointOnLine(const OwnVec *pts, int n, int closed, const double *s, double total,
    double arc, OwnVec *point, double *angle) {
    if (n < 2 || total <= 0) return NO;
    if (closed) {
        while (arc < 0) arc += total;
        while (arc >= total) arc -= total;
    } else {
        if (arc < 0) arc = 0;
        if (arc > total) arc = total;
    }
    int edges = closed ? n : n - 1;
    for (int i = 0; i < edges; i++) {
        double a0 = s[i];
        double a1 = (i + 1 == n) ? total : s[i + 1];
        if (arc > a1 && !(i == edges - 1)) continue;
        if (arc > a1 + 1e-9 && i != edges - 1) continue;
        OwnVec p = pts[i];
        OwnVec q = pts[(i + 1) % n];
        double span = a1 - a0;
        double t = span > 1e-12 ? (arc - a0) / span : 0;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        if (point) *point = LerpVec(p, q, t);
        if (angle) *angle = atan2(q.y - p.y, q.x - p.x);
        return YES;
    }
    return NO;
}

double OwnReadableAngle(double radians) {
    double a = radians;
    while (a > M_PI) a -= 2.0 * M_PI;
    while (a <= -M_PI) a += 2.0 * M_PI;
    if (a > M_PI_2) a -= M_PI;
    if (a <= -M_PI_2) a += M_PI;
    return a;
}

static void RectAxes(OwnLabel lab, double pad, OwnVec *c, OwnVec *ax, OwnVec *ay) {
    double hw = lab.halfW + pad;
    double hh = lab.halfH + pad;
    double co = cos(lab.angle), si = sin(lab.angle);
    *c = (OwnVec){lab.x, lab.y};
    *ax = (OwnVec){co * hw, si * hw};
    *ay = (OwnVec){-si * hh, co * hh};
}

BOOL OwnLabelsOverlap(OwnLabel a, OwnLabel b, double padding) {
    OwnVec ca, ax, ay, cb, bx, by;
    RectAxes(a, padding * 0.5, &ca, &ax, &ay);
    RectAxes(b, padding * 0.5, &cb, &bx, &by);
    OwnVec axes[4] = {ax, ay, bx, by};
    OwnVec delta = {cb.x - ca.x, cb.y - ca.y};
    for (int i = 0; i < 4; i++) {
        double len = hypot(axes[i].x, axes[i].y);
        if (len < 1e-12) continue;
        OwnVec n = {axes[i].x / len, axes[i].y / len};
        double ra = fabs(ax.x * n.x + ax.y * n.y) + fabs(ay.x * n.x + ay.y * n.y);
        double rb = fabs(bx.x * n.x + bx.y * n.y) + fabs(by.x * n.x + by.y * n.y);
        double dist = fabs(delta.x * n.x + delta.y * n.y);
        if (dist > ra + rb) return NO;
    }
    return YES;
}

static BOOL LabelInside(OwnLabel lab, double minX, double minY, double maxX, double maxY) {
    OwnVec c, ax, ay;
    RectAxes(lab, 0, &c, &ax, &ay);
    OwnVec corners[4] = {
        {c.x + ax.x + ay.x, c.y + ax.y + ay.y},
        {c.x + ax.x - ay.x, c.y + ax.y - ay.y},
        {c.x - ax.x + ay.x, c.y - ax.y + ay.y},
        {c.x - ax.x - ay.x, c.y - ax.y - ay.y},
    };
    for (int i = 0; i < 4; i++) {
        if (corners[i].x < minX || corners[i].x > maxX || corners[i].y < minY || corners[i].y > maxY)
            return NO;
    }
    return YES;
}

int OwnPlaceLabels(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight, double padding,
    double minX, double minY, double maxX, double maxY,
    OwnLabel *out, int cap) {
    if (!lines || !halfWidth || !out || cap <= 0 || halfHeight <= 0) return 0;
    int placed = 0;
    for (int li = 0; li < nLines; li++) {
        const OwnLine *line = &lines[li];
        if (line->count < 2) continue;
        double total = 0;
        double *s = ArcLengths(line->pts, line->count, line->closed, &total);
        if (!s || total < 1) { free(s); continue; }
        double halfW = halfWidth(line->level, context);
        if (!(halfW > 0)) { free(s); continue; }
        double margin = line->closed ? 0 : halfW + 2.0;
        if (!line->closed && total < margin * 2.0 + halfW) { free(s); continue; }
        // Two labels are enough on a panel this size; a third piles up on the
        // straight stretch of a long isobar.
        int budget = 2;
        int got = 0;
        double step = fmax(halfW * 0.85, 4.0);
        // Score candidates: straighter and closer to the middle first.
        typedef struct { double arc, score; } Cand;
        int maxCand = (int)(total / step) + 3;
        if (maxCand < 1) maxCand = 1;
        if (maxCand > 400) maxCand = 400;
        Cand *cands = malloc((size_t)maxCand * sizeof(Cand));
        if (!cands) { free(s); continue; }
        int nc = 0;
        double begin = line->closed ? 0 : margin;
        double end = line->closed ? total : total - margin;
        for (double arc = begin; arc <= end + 1e-6 && nc < maxCand; arc += step) {
            double before = arc - fmin(12.0, total * 0.08);
            double after = arc + fmin(12.0, total * 0.08);
            OwnVec pb, pa;
            double ab, aa;
            if (!PointOnLine(line->pts, line->count, line->closed, s, total, before, &pb, &ab)) continue;
            if (!PointOnLine(line->pts, line->count, line->closed, s, total, after, &pa, &aa)) continue;
            double turn = aa - ab;
            while (turn > M_PI) turn -= 2 * M_PI;
            while (turn < -M_PI) turn += 2 * M_PI;
            double mid = line->closed ? 0 : fabs(arc - total * 0.5) / total;
            cands[nc++] = (Cand){arc, -fabs(turn) - mid};
        }
        for (int a = 1; a < nc; a++) {
            Cand c = cands[a];
            int b = a;
            while (b > 0 && cands[b - 1].score < c.score) {
                cands[b] = cands[b - 1];
                b--;
            }
            cands[b] = c;
        }
        for (int c = 0; c < nc && got < budget && placed < cap; c++) {
            OwnVec p;
            double ang;
            if (!PointOnLine(line->pts, line->count, line->closed, s, total, cands[c].arc, &p, &ang)) continue;
            OwnLabel lab = {
                p.x, p.y, OwnReadableAngle(ang), halfW, halfHeight,
                cands[c].arc, halfW + 6.0, line->level, li,
            };
            if (!LabelInside(lab, minX, minY, maxX, maxY)) continue;
            BOOL hit = NO;
            for (int k = 0; k < placed; k++) {
                if (OwnLabelsOverlap(lab, out[k], padding)) { hit = YES; break; }
            }
            if (hit) continue;
            out[placed++] = lab;
            got++;
        }
        free(cands);
        free(s);
    }
    return placed;
}

static BOOL ArcInGap(double arc, double total, int closed, const OwnLabel *labels, int nLabels) {
    for (int i = 0; i < nLabels; i++) {
        double d = fabs(arc - labels[i].arc);
        if (closed && total > 0) {
            double wrap = total - d;
            if (wrap < d) d = wrap;
        }
        if (d < labels[i].gap) return YES;
    }
    return NO;
}

static OwnVec ArcPoint(const OwnVec *pts, int n, int closed, const double *s, double total, double arc) {
    OwnVec p = pts[0];
    PointOnLine(pts, n, closed, s, total, arc, &p, NULL);
    return p;
}

OwnLineSet OwnCutGaps(const OwnVec *pts, int count, int closed,
    const OwnLabel *labels, int nLabels) {
    OwnLineSet set = {0};
    if (!pts || count < 2) return set;
    double total = 0;
    double *s = ArcLengths(pts, count, closed, &total);
    if (!s || total <= 0) { free(s); return set; }
    BOOL any = NO;
    if (labels && nLabels > 0) {
        for (int i = 0; i < count; i++) if (ArcInGap(s[i], total, closed, labels, nLabels)) any = YES;
        if (!any) {
            // A gap can sit between vertices.
            int edges = closed ? count : count - 1;
            for (int e = 0; e < edges && !any; e++) {
                double a0 = s[e];
                double a1 = (e + 1 == count) ? total : s[e + 1];
                if (ArcInGap(0.5 * (a0 + a1), total, closed, labels, nLabels)) any = YES;
            }
        }
    }
    if (!any) {
        OwnVec *copy = malloc((size_t)count * sizeof(OwnVec));
        if (copy) {
            memcpy(copy, pts, (size_t)count * sizeof(OwnVec));
            PushLine(&set, copy, count, closed, 0);
        }
        free(s);
        return set;
    }
    int edges = closed ? count : count - 1;
    OwnVec *cur = NULL;
    int nCur = 0, cap = 0;
    OwnVec *first = NULL;
    int nFirst = 0;
    BOOL firstOpen = YES;
    BOOL lastKept = NO;
    for (int e = 0; e < edges; e++) {
        double a0 = s[e];
        double a1 = (e + 1 == count) ? total : s[e + 1];
        if (!(a1 > a0)) continue;
        double marks[8];
        int nm = 0;
        marks[nm++] = a0;
        marks[nm++] = a1;
        for (int g = 0; g < nLabels; g++) {
            double bounds[2] = {labels[g].arc - labels[g].gap, labels[g].arc + labels[g].gap};
            for (int b = 0; b < 2; b++) {
                double m = bounds[b];
                if (closed) {
                    if (m < 0) m += total;
                    if (m >= total) m -= total;
                }
                if (m > a0 + 1e-8 && m < a1 - 1e-8 && nm < 8) marks[nm++] = m;
            }
        }
        for (int a = 1; a < nm; a++) {
            double v = marks[a];
            int b = a;
            while (b > 0 && marks[b - 1] > v) { marks[b] = marks[b - 1]; b--; }
            marks[b] = v;
        }
        for (int m = 0; m < nm - 1; m++) {
            if (marks[m + 1] - marks[m] < 1e-8) continue;
            double mid = 0.5 * (marks[m] + marks[m + 1]);
            BOOL gap = ArcInGap(mid, total, closed, labels, nLabels);
            if (gap) {
                if (nCur >= 2) {
                    if (closed && firstOpen && e == 0 && m == 0) {
                        // The opening of a closed ring is handled by merging later.
                    }
                    if (firstOpen && closed) {
                        first = cur;
                        nFirst = nCur;
                        firstOpen = NO;
                        cur = NULL;
                        nCur = 0;
                        cap = 0;
                    } else {
                        PushLine(&set, cur, nCur, 0, 0);
                        cur = NULL;
                        nCur = 0;
                        cap = 0;
                    }
                } else {
                    free(cur);
                    cur = NULL;
                    nCur = 0;
                    cap = 0;
                }
                lastKept = NO;
                continue;
            }
            OwnVec p0 = ArcPoint(pts, count, closed, s, total, marks[m]);
            OwnVec p1 = ArcPoint(pts, count, closed, s, total, marks[m + 1]);
            if (nCur + 2 > cap) {
                cap = cap ? cap * 2 : 16;
                if (cap < nCur + 2) cap = nCur + 2;
                OwnVec *grown = realloc(cur, (size_t)cap * sizeof(OwnVec));
                if (!grown) { free(cur); cur = NULL; nCur = 0; break; }
                cur = grown;
            }
            if (nCur == 0) cur[nCur++] = p0;
            else if (fabs(cur[nCur - 1].x - p0.x) > 1e-7 || fabs(cur[nCur - 1].y - p0.y) > 1e-7)
                cur[nCur++] = p0;
            cur[nCur++] = p1;
            lastKept = YES;
        }
    }
    if (closed && first && nCur >= 2 && lastKept) {
        // The walk started inside a kept span and the ring joins the saved prefix.
        int merged = nCur + nFirst;
        OwnVec *join = malloc((size_t)merged * sizeof(OwnVec));
        if (join) {
            memcpy(join, cur, (size_t)nCur * sizeof(OwnVec));
            memcpy(join + nCur, first, (size_t)nFirst * sizeof(OwnVec));
            // Drop a duplicate joint.
            PushLine(&set, join, merged, 0, 0);
        }
        free(cur);
        free(first);
    } else {
        if (nCur >= 2) PushLine(&set, cur, nCur, 0, 0);
        else free(cur);
        if (nFirst >= 2) PushLine(&set, first, nFirst, 0, 0);
        else free(first);
    }
    free(s);
    return set;
}

BOOL OwnWindFlow(double fromDegrees, OwnVec *vector) {
    if (!vector || !isfinite(fromDegrees)) return NO;
    double radians = fromDegrees * M_PI / 180.0;
    *vector = (OwnVec){-sin(radians), -cos(radians)};
    return YES;
}

OwnBarb OwnWindBarb(double fromDegrees, double knots, double staff, BOOL southernHemisphere) {
    OwnBarb barb = {0};
    if (!(staff > 0)) return barb;
    double rad = Rad(fromDegrees);
    double ux = sin(rad);
    double uy = cos(rad);
    barb.tip = (OwnBarbPoint){ux * staff, uy * staff};
    // Round to the nearest five knots: 0–2 calm, 3–7 a half-feather.
    if (!(knots >= 2.5)) {
        barb.calm = 1;
        return barb;
    }
    int rounded = (int)floor(knots / 5.0 + 0.5) * 5;
    if (rounded < 5) rounded = 5;
    int units = rounded / 5;
    barb.nPenn = units / 10;
    int rem = units % 10;
    barb.nFull = rem / 2;
    barb.nHalf = rem % 2;
    if (barb.nPenn > 4) barb.nPenn = 4;
    double spacing = staff * 0.13;
    double blen = staff * 0.40;
    double pennW = spacing * 1.65;
    int marks = barb.nPenn + barb.nFull + barb.nHalf;
    double need = barb.nPenn * pennW + (barb.nFull + barb.nHalf) * spacing + spacing;
    if (marks > 0 && need > staff * 0.92) {
        double scale = (staff * 0.92) / need;
        spacing *= scale;
        pennW *= scale;
        blen *= fmin(1.0, scale + 0.35);
    }
    double nx = uy;
    double ny = -ux;
    if (southernHemisphere) { nx = -nx; ny = -ny; }
    barb.nSeg = 1;
    barb.segs[0].a = (OwnBarbPoint){0, 0};
    barb.segs[0].b = barb.tip;
    double s = staff - spacing * 0.25;
    for (int p = 0; p < barb.nPenn; p++) {
        double inner = s - pennW;
        OwnBarbPoint A = {ux * s, uy * s};
        OwnBarbPoint B = {ux * inner, uy * inner};
        OwnBarbPoint C = {B.x + nx * blen * 0.95, B.y + ny * blen * 0.95};
        barb.tri[barb.nTri][0] = A;
        barb.tri[barb.nTri][1] = C;
        barb.tri[barb.nTri][2] = B;
        barb.nTri++;
        s = inner - spacing * 0.25;
    }
    for (int f = 0; f < barb.nFull && barb.nSeg < 16; f++) {
        OwnBarbPoint A = {ux * s, uy * s};
        OwnBarbPoint B = {A.x + nx * blen + ux * blen * 0.42, A.y + ny * blen + uy * blen * 0.42};
        barb.segs[barb.nSeg++] = (OwnBarbSeg){A, B};
        s -= spacing;
    }
    if (barb.nHalf && barb.nSeg < 16) {
        double half = blen * 0.5;
        OwnBarbPoint A = {ux * s, uy * s};
        OwnBarbPoint B = {A.x + nx * half + ux * half * 0.42, A.y + ny * half + uy * half * 0.42};
        barb.segs[barb.nSeg++] = (OwnBarbSeg){A, B};
    }
    return barb;
}

OwnRGB OwnTemperatureRGB(double celsius) {
    // Diverging, centred on a quiet 10 °C so a front (a short run of the ramp)
    // reads as blue against orange. The middle stays dull on purpose: the
    // isobars are still the chart, and the land colour should not be dyed.
    static const double stops[] = {-12, 0, 10, 20, 28};
    static const OwnRGB cols[] = {
        {0.10, 0.34, 0.78},
        {0.30, 0.55, 0.88},
        {0.78, 0.76, 0.70},
        {0.93, 0.50, 0.16},
        {0.84, 0.28, 0.08},
    };
    if (celsius <= stops[0]) return cols[0];
    if (celsius >= stops[4]) return cols[4];
    for (int i = 0; i < 4; i++) {
        if (celsius <= stops[i + 1]) {
            double t = (celsius - stops[i]) / (stops[i + 1] - stops[i]);
            return (OwnRGB){
                cols[i].r + (cols[i + 1].r - cols[i].r) * t,
                cols[i].g + (cols[i + 1].g - cols[i].g) * t,
                cols[i].b + (cols[i + 1].b - cols[i].b) * t,
            };
        }
    }
    return cols[4];
}

static uint16_t ReadU16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static int16_t ReadI16(const uint8_t *p) { return (int16_t)ReadU16(p); }

OwnCoast OwnCoastParse(NSData *data) {
    OwnCoast coast = {0};
    if (data.length < 8) return coast;
    const uint8_t *b = data.bytes;
    if (memcmp(b, "OCST", 4) != 0) return coast;
    uint16_t version = ReadU16(b + 4);
    uint16_t rings = ReadU16(b + 6);
    if (version != 1 || rings == 0) return coast;
    NSUInteger cursor = 8;
    int *starts = calloc(rings, sizeof(int));
    int *counts = calloc(rings, sizeof(int));
    int total = 0;
    BOOL ok = starts && counts;
    for (uint16_t r = 0; ok && r < rings; r++) {
        if (cursor + 2 > data.length) { ok = NO; break; }
        uint16_t n = ReadU16(b + cursor);
        cursor += 2;
        if (n < 3 || cursor + (NSUInteger)n * 4 > data.length) { ok = NO; break; }
        starts[r] = total;
        counts[r] = n;
        total += n;
        cursor += (NSUInteger)n * 4;
    }
    if (!ok || cursor != data.length) {
        free(starts);
        free(counts);
        return coast;
    }
    double *lon = malloc((size_t)total * sizeof(double));
    double *lat = malloc((size_t)total * sizeof(double));
    if (!lon || !lat) {
        free(starts); free(counts); free(lon); free(lat);
        return coast;
    }
    cursor = 8;
    int w = 0;
    for (uint16_t r = 0; r < rings; r++) {
        uint16_t n = ReadU16(b + cursor);
        cursor += 2;
        for (uint16_t i = 0; i < n; i++) {
            lon[w] = ReadI16(b + cursor) / 100.0;
            lat[w] = ReadI16(b + cursor + 2) / 100.0;
            cursor += 4;
            w++;
        }
    }
    coast.lon = lon;
    coast.lat = lat;
    coast.ringStart = starts;
    coast.ringCount = counts;
    coast.rings = rings;
    coast.points = total;
    return coast;
}

void OwnCoastFree(OwnCoast coast) {
    free(coast.lon);
    free(coast.lat);
    free(coast.ringStart);
    free(coast.ringCount);
}
