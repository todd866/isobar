#import "ownchart.h"
#import <Accelerate/Accelerate.h>
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

OwnView OwnWorldViewMake(double west, double east, double south, double north,
    double pixelX, double pixelY, double pixelW, double pixelH) {
    OwnView view = {0};
    if (!(east > west) || !(north > south) || pixelW <= 1 || pixelH <= 1) return view;
    view.west = west; view.east = east; view.south = south; view.north = north;
    view.pixelX = pixelX; view.pixelY = pixelY; view.pixelW = pixelW; view.pixelH = pixelH;
    view.equirectangular = YES;
    view.scale = fmin(pixelW / (east - west), pixelH / (north - south));
    view.minX = west; view.maxX = east; view.minY = south; view.maxY = north;
    view.offsetX = pixelX + (pixelW - (east - west) * view.scale) * 0.5;
    view.offsetY = pixelY + (pixelH - (north - south) * view.scale) * 0.5;
    view.valid = isfinite(view.scale) && view.scale > 0;
    return view;
}

BOOL OwnViewProject(OwnView view, double latitude, double longitude, double *x, double *y) {
    if (!view.valid || !x || !y) return NO;
    if (view.equirectangular) {
        if (!isfinite(latitude) || !isfinite(longitude)) return NO;
        double lon = longitude;
        while (lon < view.west) lon += 360;
        while (lon > view.east) lon -= 360;
        if (latitude < view.south || latitude > view.north) return NO;
        *x = view.offsetX + (lon - view.west) * view.scale;
        *y = view.offsetY + (view.north - latitude) * view.scale;
        return isfinite(*x) && isfinite(*y);
    }
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
    size_t cells = (size_t)nLon * (size_t)nLat;
    if (nLon > 1000 || nLat > 1000 || cells > 300000) return set;
    size_t strideS = (size_t)nLon + 1;
    size_t keyMaxS = ((size_t)nLat + 1) * strideS * 2;
    size_t segCapS = cells * 2;
    if (keyMaxS > INT_MAX || segCapS > INT_MAX) return set;
    int stride = (int)strideS;
    int keyMax = (int)keyMaxS;
    int segCap = (int)segCapS;
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
                    field[(size_t)j * (size_t)nLon + (size_t)i],
                    field[(size_t)j * (size_t)nLon + (size_t)i + 1],
                    field[(size_t)(j + 1) * (size_t)nLon + (size_t)i + 1],
                    field[(size_t)(j + 1) * (size_t)nLon + (size_t)i],
                };
                if (!isfinite(v[0]) || !isfinite(v[1]) || !isfinite(v[2]) || !isfinite(v[3])) continue;
                // A node on the level counts as above it. Interpolation and smoothing
                // leave a flat field a few ulps either side of its value; reading that
                // noise as crossings would trace contours across the plateau.
                double onLevel = 1e-9 * fmax(1, fabs(level));
                for (int c = 0; c < 4; c++) if (fabs(v[c] - level) <= onLevel) v[c] = level + onLevel;
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
                        // The bilinear saddle decides which diagonal connects.
                        // A corner average flips at the wrong instant; the old
                        // pairing also reversed the connected and isolated sides.
                        // Negating the field must leave the zero contour unchanged.
                        double a = v[0] - level, b = v[1] - level;
                        double c = v[2] - level, d = v[3] - level;
                        double scale = fmax(fmax(fabs(a), fabs(b)), fmax(fabs(c), fabs(d)));
                        double saddle = (a / scale) * (c / scale) - (b / scale) * (d / scale);
                        if (saddle >= 0) { OWN_LINK(0, 1); OWN_LINK(3, 2); }
                        else { OWN_LINK(3, 0); OWN_LINK(1, 2); }
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

static double SegLen(OwnVec a, OwnVec b) { return hypot(b.x - a.x, b.y - a.y); }

static double RingLength(const OwnVec *pts, int n, int closed) {
    if (!pts || n < 2) return 0;
    double total = 0;
    int edges = closed ? n : n - 1;
    for (int i = 0; i < edges; i++) total += SegLen(pts[i], pts[(i + 1) % n]);
    return total;
}

static double RingArea(const OwnVec *pts, int n) {
    if (!pts || n < 3) return 0;
    double area = 0;
    for (int i = 0; i < n; i++) {
        OwnVec p = pts[i], q = pts[(i + 1) % n];
        area += p.x * q.y - q.x * p.y;
    }
    return 0.5 * area;
}

// Drop the `step` vertices after `i` (the detour), wrapping on a closed ring.
static int CutDetour(OwnVec **pts, int n, int closed, int i, int step) {
    if (!pts || !*pts || step < 2 || n - step < (closed ? 3 : 2)) return n;
    int keep = n - step;
    OwnVec *out = malloc((size_t)keep * sizeof(OwnVec));
    if (!out) return n;
    int w = 0;
    for (int k = 0; k < n; k++) {
        int rel = closed ? (k - i + n) % n : k - i;
        if (!closed && (k <= i || k > i + step)) out[w++] = (*pts)[k];
        if (closed && (rel == 0 || rel > step)) out[w++] = (*pts)[k];
    }
    if (w != keep) { free(out); return n; }
    free(*pts);
    *pts = out;
    return keep;
}

static int ExciseLoops(OwnVec **pts, int n, int closed, double minArea, double pinch, double maxAlong) {
    if (!pts || !*pts || n < 4 || !(pinch > 0) || !(minArea > 0)) return n;
    for (int guard = 0; guard < 8; guard++) {
        int span = closed ? 2 * n : n;
        double *cum = malloc((size_t)(span + 1) * 2 * sizeof(double));
        if (!cum) break;
        double *cross = cum + span + 1;
        cum[0] = cross[0] = 0;
        for (int k = 1; k < (closed ? span + 1 : n); k++) {
            OwnVec a = (*pts)[(k - 1) % n], b = (*pts)[k % n];
            cum[k] = cum[k - 1] + SegLen(a, b);
            cross[k] = cross[k - 1] + a.x * b.y - b.x * a.y;
        }
        int cutI = -1, cutStep = 0;
        for (int i = 0; i < n && cutI < 0; i++) {
            int limit = closed ? n / 2 : n - 1 - i;
            for (int step = 2; step <= limit; step++) {
                int j = closed ? (i + step) % n : i + step;
                double along = cum[i + step] - cum[i + 1];
                if (along > maxAlong) break;
                if (!closed && j == n - 1) continue;
                OwnVec pi = (*pts)[i], pj = (*pts)[j];
                double chord = sqrt((pj.x - pi.x) * (pj.x - pi.x) + (pj.y - pi.y) * (pj.y - pi.y));
                // After a further run d the chord is at least chord − d. No
                // vertex can pass both tests until d reaches `skip`.
                double skip = chord > pinch ? chord - pinch : 0;
                if (chord > 1e-3 && along < chord * 2.5) skip = fmax(skip, (chord * 2.5 - along) / 3.5);
                if (skip > 0) {
                    double need = cum[i + step] + skip;
                    while (step < limit && cum[i + step + 1] < need) step++;
                    continue;
                }
                if (chord > 1e-4 && along < chord * 2.5) continue;
                double area = cross[i + step] - cross[i] + pj.x * pi.y - pi.x * pj.y;
                if (fabs(0.5 * area) >= minArea) continue;
                cutI = i;
                cutStep = step;
                break;
            }
        }
        free(cum);
        if (cutI < 0) break;
        int next = CutDetour(pts, n, closed, cutI, cutStep);
        if (next == n) break;
        n = next;
    }
    return n;
}

void OwnPruneContours(OwnLineSet *set, double minLength, double minArea, double pinch) {
    if (!set || !set->lines || !(minLength > 0) || !(minArea > 0)) return;
    int w = 0;
    for (int i = 0; i < set->count; i++) {
        OwnLine line = set->lines[i];
        int n = ExciseLoops(&line.pts, line.count, line.closed, minArea, pinch, minLength * 4.0);
        line.count = n;
        double length = RingLength(line.pts, n, line.closed);
        double area = line.closed ? fabs(RingArea(line.pts, n)) : 0;
        BOOL drop = n < (line.closed ? 3 : 2) || length < minLength || (line.closed && area < minArea);
        if (drop) { free(line.pts); continue; }
        set->lines[w++] = line;
    }
    set->count = w;
}

static BOOL NearMapEdge(OwnVec p, double minX, double minY, double maxX, double maxY, double edge) {
    return p.x <= minX + edge || p.x >= maxX - edge || p.y <= minY + edge || p.y >= maxY - edge;
}

BOOL OwnIsOpenFragment(const OwnLine *line, double minLength, double edgeLength,
    double minX, double minY, double maxX, double maxY, double edge) {
    if (!line || line->closed) return NO;
    if (!line->pts || line->count < 2 || !(minLength > 0)) return YES;
    double length = RingLength(line->pts, line->count, 0);
    if (length >= minLength) return NO;
    if (!(edgeLength > 0)) edgeLength = minLength;
    if (!(edge > 0)) edge = 0;
    OwnVec head = line->pts[0], tail = line->pts[line->count - 1];
    BOOL crosses = NearMapEdge(head, minX, minY, maxX, maxY, edge)
        || NearMapEdge(tail, minX, minY, maxX, maxY, edge);
    if (crosses && length >= edgeLength) return NO;
    return YES;
}

static double PerpDist(OwnVec a, OwnVec b, OwnVec p) {
    double dx = b.x - a.x, dy = b.y - a.y;
    double len = hypot(dx, dy);
    if (len < 1e-12) return hypot(p.x - a.x, p.y - a.y);
    return fabs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

static void SimplifyMark(const OwnVec *pts, int i0, int i1, double epsilon, char *keep) {
    if (i1 <= i0 + 1) return;
    int stackN = 0;
    int cap = (i1 - i0 + 1) * 2;
    if (cap < 4) cap = 4;
    int *stack = malloc((size_t)cap * sizeof(int));
    if (!stack) return;
    stack[stackN++] = i0;
    stack[stackN++] = i1;
    while (stackN >= 2) {
        int b = stack[--stackN];
        int a = stack[--stackN];
        if (b <= a + 1) continue;
        double best = 0;
        int at = -1;
        for (int i = a + 1; i < b; i++) {
            double d = PerpDist(pts[a], pts[b], pts[i]);
            if (d > best) { best = d; at = i; }
        }
        if (at < 0 || !(best > epsilon)) continue;
        keep[at] = 1;
        if (stackN + 4 > cap) {
            int next = cap * 2;
            int *grown = realloc(stack, (size_t)next * sizeof(int));
            if (!grown) break;
            stack = grown;
            cap = next;
        }
        stack[stackN++] = a;
        stack[stackN++] = at;
        stack[stackN++] = at;
        stack[stackN++] = b;
    }
    free(stack);
}

static int SimplifyOpen(OwnVec **pts, int n, double epsilon) {
    char *keep = calloc((size_t)n, 1);
    if (!keep) return n;
    keep[0] = keep[n - 1] = 1;
    SimplifyMark(*pts, 0, n - 1, epsilon, keep);
    int w = 0;
    for (int i = 0; i < n; i++) if (keep[i]) w++;
    OwnVec *out = malloc((size_t)w * sizeof(OwnVec));
    if (!out) { free(keep); return n; }
    int k = 0;
    for (int i = 0; i < n; i++) if (keep[i]) out[k++] = (*pts)[i];
    free(keep);
    free(*pts);
    *pts = out;
    return w;
}

void OwnSimplifyContours(OwnLineSet *set, double epsilon) {
    if (!set || !set->lines || !(epsilon > 0)) return;
    for (int i = 0; i < set->count; i++) {
        OwnLine *line = &set->lines[i];
        if (!line->pts || line->count < 3) continue;
        if (!line->closed) {
            line->count = SimplifyOpen(&line->pts, line->count, epsilon);
            continue;
        }
        int n = line->count;
        int pivot = 0;
        for (int p = 1; p < n; p++) {
            if (line->pts[p].x < line->pts[pivot].x
                || (line->pts[p].x == line->pts[pivot].x && line->pts[p].y < line->pts[pivot].y))
                pivot = p;
        }
        OwnVec *rot = malloc((size_t)(n + 1) * sizeof(OwnVec));
        if (!rot) continue;
        for (int p = 0; p < n; p++) rot[p] = line->pts[(pivot + p) % n];
        rot[n] = rot[0];
        int m = SimplifyOpen(&rot, n + 1, epsilon);
        if (m < 5) { free(rot); continue; }
        if (fabs(rot[0].x - rot[m - 1].x) < 1e-9 && fabs(rot[0].y - rot[m - 1].y) < 1e-9) m--;
        if (m < 4) { free(rot); continue; }
        free(line->pts);
        line->pts = rot;
        line->count = m;
    }
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

int OwnChaikin(const OwnVec *in, int n, int closed, OwnVec *out, int outCap) {
    if (!in || !out || n < 2 || (closed && n < 3)) return -1;
    int need = n * 2;
    if (outCap < need) return -1;
    if (closed) {
        int w = 0;
        for (int i = 0; i < n; i++) {
            OwnVec a = in[i], b = in[(i + 1) % n];
            out[w++] = (OwnVec){0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y};
            out[w++] = (OwnVec){0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y};
        }
        return w;
    }
    int w = 0;
    out[w++] = in[0];
    for (int i = 0; i < n - 1; i++) {
        OwnVec a = in[i], b = in[i + 1];
        out[w++] = (OwnVec){0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y};
        out[w++] = (OwnVec){0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y};
    }
    out[w++] = in[n - 1];
    return w;
}

// numpy 'reflect': the sample just outside an edge is the sample just inside it.
static int ReflectIndex(int i, int n) {
    if (n <= 1) return 0;
    int period = 2 * (n - 1);
    i %= period;
    if (i < 0) i += period;
    if (i >= n) i = period - i;
    return i;
}

static BOOL ConvSeparable(const double *src, double *dst, int nLon, int nLat,
    const double *kernel, int rad, int reflect) {
    int flen = rad * 2 + 1;
    size_t n = (size_t)nLon * (size_t)nLat;
    int span = (nLon > nLat ? nLon : nLat) + flen;
    double *tmp = malloc(n * sizeof(double));
    double *pad = malloc((size_t)span * sizeof(double));
    if (!tmp || !pad) { free(tmp); free(pad); return NO; }
    for (int j = 0; j < nLat; j++) {
        for (int i = -rad; i < nLon + rad; i++) {
            int ii = i;
            if (reflect) ii = ReflectIndex(i, nLon);
            else { if (ii < 0) ii = 0; if (ii >= nLon) ii = nLon - 1; }
            pad[i + rad] = src[(size_t)j * (size_t)nLon + (size_t)ii];
        }
        vDSP_convD(pad, 1, kernel, 1, tmp + (size_t)j * (size_t)nLon, 1,
            (vDSP_Length)nLon, (vDSP_Length)flen);
    }
    for (int i = 0; i < nLon; i++) {
        for (int j = -rad; j < nLat + rad; j++) {
            int jj = j;
            if (reflect) jj = ReflectIndex(j, nLat);
            else { if (jj < 0) jj = 0; if (jj >= nLat) jj = nLat - 1; }
            pad[j + rad] = tmp[(size_t)jj * (size_t)nLon + (size_t)i];
        }
        vDSP_convD(pad, 1, kernel, 1, dst + i, (vDSP_Stride)nLon,
            (vDSP_Length)nLat, (vDSP_Length)flen);
    }
    free(tmp);
    free(pad);
    return YES;
}

void OwnGaussianSmooth(double *field, int nLon, int nLat, double sigma) {
    if (!field || nLon < 1 || nLat < 1 || !(sigma >= 0.4)) return;
    int rad = (int)ceil(3.0 * sigma);
    if (rad < 1) rad = 1;
    if (rad > 8) rad = 8;
    double kernel[17];
    double norm = 0;
    for (int i = -rad; i <= rad; i++) {
        double w = exp(-0.5 * (double)(i * i) / (sigma * sigma));
        kernel[i + rad] = w;
        norm += w;
    }
    for (int i = 0; i <= rad * 2; i++) kernel[i] /= norm;
    size_t n = (size_t)nLon * (size_t)nLat;
    BOOL finite = YES;
    for (size_t i = 0; i < n && finite; i++) if (!isfinite(field[i])) finite = NO;
    if (finite && ConvSeparable(field, field, nLon, nLat, kernel, rad, 1)) return;
    double *val = malloc(n * sizeof(double));
    double *wgt = malloc(n * sizeof(double));
    double *tmpV = malloc(n * sizeof(double));
    double *tmpW = malloc(n * sizeof(double));
    if (!val || !wgt || !tmpV || !tmpW) {
        free(val); free(wgt); free(tmpV); free(tmpW);
        return;
    }
    for (size_t i = 0; i < n; i++) {
        if (isfinite(field[i])) { val[i] = field[i]; wgt[i] = 1; }
        else { val[i] = 0; wgt[i] = 0; }
    }
    for (int j = 0; j < nLat; j++) {
        for (int i = 0; i < nLon; i++) {
            double accV = 0, accW = 0;
            for (int di = -rad; di <= rad; di++) {
                int ii = ReflectIndex(i + di, nLon);
                double w = kernel[di + rad];
                size_t k = (size_t)j * (size_t)nLon + (size_t)ii;
                accV += w * val[k];
                accW += w * wgt[k];
            }
            size_t o = (size_t)j * (size_t)nLon + (size_t)i;
            tmpV[o] = accV;
            tmpW[o] = accW;
        }
    }
    for (int i = 0; i < nLon; i++) {
        for (int j = 0; j < nLat; j++) {
            double accV = 0, accW = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                int jj = ReflectIndex(j + dj, nLat);
                double w = kernel[dj + rad];
                size_t k = (size_t)jj * (size_t)nLon + (size_t)i;
                accV += w * tmpV[k];
                accW += w * tmpW[k];
            }
            size_t o = (size_t)j * (size_t)nLon + (size_t)i;
            field[o] = isfinite(field[o]) && accW > 1e-9 ? accV / accW : NAN;
        }
    }
    free(val); free(wgt); free(tmpV); free(tmpW);
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

static double FieldAt(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy, double x, double y) {
    if (!(dx != 0) || !(dy != 0)) return NAN;
    double fi = (x - originX) / dx;
    double fj = (y - originY) / dy;
    int i0 = (int)floor(fi);
    int j0 = (int)floor(fj);
    double tx = fi - i0, ty = fj - j0;
    double a = Sample(field, nLon, nLat, i0, j0);
    double b = Sample(field, nLon, nLat, i0 + 1, j0);
    double c = Sample(field, nLon, nLat, i0, j0 + 1);
    double d = Sample(field, nLon, nLat, i0 + 1, j0 + 1);
    if (!isfinite(a) || !isfinite(b) || !isfinite(c) || !isfinite(d)) return NAN;
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

double OwnRingProminence(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy,
    double x, double y, double radius) {
    if (!field || !(radius > 0)) return 0;
    double centre = FieldAt(field, nLon, nLat, originX, originY, dx, dy, x, y);
    if (!isfinite(centre)) return 0;
    double sum = 0;
    int n = 0;
    for (int k = 0; k < 16; k++) {
        double ang = k * (M_PI / 8.0);
        double value = FieldAt(field, nLon, nLat, originX, originY, dx, dy,
            x + radius * cos(ang), y + radius * sin(ang));
        if (!isfinite(value)) continue;
        sum += value;
        n++;
    }
    if (n < 8) return 0;
    return centre - sum / n;
}

static double CentreKilometres(OwnExtremum a, OwnExtremum b) {
    double mid = (a.y + b.y) * 0.5 * (M_PI / 180.0);
    double dx = (b.x - a.x) * 111.32 * cos(mid);
    double dy = (b.y - a.y) * 110.57;
    return hypot(dx, dy);
}

static double CentreDistance(OwnExtremum a, OwnExtremum b, int geographic) {
    if (geographic) return CentreKilometres(a, b);
    return hypot(a.x - b.x, a.y - b.y);
}

// YES when a should be kept ahead of b. Different types do not compete.
static BOOL CentreStronger(OwnExtremum a, double pa, OwnExtremum b, double pb) {
    if (a.high != b.high) return NO;
    if (a.high) {
        if (a.value != b.value) return a.value > b.value;
    } else if (a.value != b.value) return a.value < b.value;
    return fabs(pa) > fabs(pb);
}

int OwnSettleCentres(const OwnExtremum *candidates, const double *prominence,
    const int *enclosed, int n,
    double appear, double hold, double mergeDistance, double holdDistance,
    int geographic,
    const OwnExtremum *previous, int nPrevious,
    OwnExtremum *out, int cap) {
    if (!candidates || !prominence || !out || cap <= 0 || n <= 0) return 0;
    if (nPrevious < 0) nPrevious = 0;
    if (!previous) nPrevious = 0;
    int *order = malloc((size_t)n * sizeof(int));
    if (!order) return 0;
    int nOrder = 0;
    for (int i = 0; i < n; i++) {
        double need = appear;
        for (int p = 0; p < nPrevious; p++) {
            if (previous[p].high != candidates[i].high) continue;
            if (CentreDistance(previous[p], candidates[i], geographic) <= holdDistance) {
                need = hold;
                break;
            }
        }
        double p = prominence[i];
        BOOL deep = candidates[i].high ? p >= need : p <= -need;
        if (!deep && enclosed && enclosed[i])
            deep = candidates[i].high ? p >= 0.5 : p <= -0.5;
        if (deep) order[nOrder++] = i;
    }
    for (int a = 1; a < nOrder; a++) {
        int key = order[a];
        int b = a;
        while (b > 0 && !CentreStronger(candidates[order[b - 1]], prominence[order[b - 1]],
                candidates[key], prominence[key])) {
            order[b] = order[b - 1];
            b--;
        }
        order[b] = key;
    }
    int kept = 0;
    for (int a = 0; a < nOrder && kept < cap; a++) {
        OwnExtremum c = candidates[order[a]];
        BOOL near = NO;
        for (int k = 0; k < kept && !near; k++) {
            if (out[k].high != c.high) continue;
            if (CentreDistance(out[k], c, geographic) <= mergeDistance) near = YES;
        }
        if (!near) out[kept++] = c;
    }
    free(order);
    return kept;
}

BOOL OwnLineContains(const OwnLine *line, double x, double y) {
    if (!line || !line->closed || !line->pts || line->count < 3) return NO;
    BOOL inside = NO;
    int n = line->count;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        double yi = line->pts[i].y, yj = line->pts[j].y;
        double xi = line->pts[i].x, xj = line->pts[j].x;
        if ((yi > y) != (yj > y)) {
            double cross = xi + (xj - xi) * (y - yi) / (yj - yi);
            if (x < cross) inside = !inside;
        }
    }
    return inside;
}

static double LineSpan(const OwnLine *line) {
    if (!line || line->count < 1 || !line->pts) return 0;
    double minX = INFINITY, maxX = -INFINITY, minY = INFINITY, maxY = -INFINITY;
    for (int i = 0; i < line->count; i++) {
        if (line->pts[i].x < minX) minX = line->pts[i].x;
        if (line->pts[i].x > maxX) maxX = line->pts[i].x;
        if (line->pts[i].y < minY) minY = line->pts[i].y;
        if (line->pts[i].y > maxY) maxY = line->pts[i].y;
    }
    return fmax(maxX - minX, maxY - minY);
}

void OwnMarkEnclosedCentres(const OwnExtremum *candidates, int n,
    const OwnLine *lines, int nLines, double minSpan,
    double minX, double minY, double maxX, double maxY, int *enclosed) {
    if (!enclosed) return;
    for (int i = 0; i < n; i++) enclosed[i] = 0;
    if (!candidates || !lines || n <= 0 || nLines <= 0) return;
    for (int i = 0; i < n; i++) {
        for (int li = 0; li < nLines; li++) {
            const OwnLine *line = &lines[li];
            if (!line->closed || line->count < 3) continue;
            if (LineSpan(line) < minSpan) continue;
            BOOL onMap = YES;
            for (int p = 0; p < line->count && onMap; p++) {
                double x = line->pts[p].x, y = line->pts[p].y;
                if (!isfinite(x) || !isfinite(y) || x < minX || x > maxX || y < minY || y > maxY)
                    onMap = NO;
            }
            if (!onMap) continue;
            if (!OwnLineContains(line, candidates[i].x, candidates[i].y)) continue;
            if (candidates[i].high) {
                if (!(line->level < candidates[i].value)) continue;
            } else if (!(line->level > candidates[i].value)) continue;
            BOOL best = YES;
            for (int k = 0; k < n && best; k++) {
                if (k == i || candidates[k].high != candidates[i].high) continue;
                if (!OwnLineContains(line, candidates[k].x, candidates[k].y)) continue;
                if (candidates[i].high ? candidates[k].value > candidates[i].value + 1e-3
                                        : candidates[k].value < candidates[i].value - 1e-3)
                    best = NO;
            }
            if (best) { enclosed[i] = 1; break; }
        }
    }
}

void OwnDropStrayRings(OwnLineSet *set, const OwnExtremum *centres, int nCentres, double maxSpan) {
    if (!set || !set->lines || !(maxSpan > 0)) return;
    int w = 0;
    for (int i = 0; i < set->count; i++) {
        OwnLine line = set->lines[i];
        BOOL stray = NO;
        if (line.closed && line.count >= 3 && LineSpan(&line) < maxSpan) {
            stray = YES;
            for (int c = 0; c < nCentres && stray; c++) {
                if (OwnLineContains(&line, centres[c].x, centres[c].y)) stray = NO;
            }
        }
        if (stray) { free(line.pts); continue; }
        set->lines[w++] = line;
    }
    set->count = w;
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

static BOOL LabelsCrowded(OwnLabel a, OwnLabel b) {
    double width = 2.0 * fmax(a.halfW, b.halfW);
    if (!(width > 0)) return YES;
    // Chart space stays on the three-width rule. A 140 px same-level gap is a
    // viewport rule and is applied where labels are drawn in screen pixels.
    return hypot(a.x - b.x, a.y - b.y) < 3.0 * width;
}

int OwnKeepSeparated(OwnLabel *labels, int n, double padding) {
    if (!labels || n <= 0) return 0;
    int w = 0;
    for (int i = 0; i < n; i++) {
        BOOL hit = NO;
        for (int k = 0; k < w && !hit; k++)
            hit = OwnLabelsOverlap(labels[i], labels[k], padding) || LabelsCrowded(labels[i], labels[k]);
        if (!hit) labels[w++] = labels[i];
    }
    return w;
}

int OwnKeepRingLabels(OwnLabel *labels, int n, const OwnLine *lines, int nLines, double padding) {
    if (!labels || n <= 0) return 0;
    if (nLines < 0 || !lines) nLines = 0;
    int w = 0;
    for (int i = 0; i < n; i++) {
        BOOL ring = NO;
        int line = labels[i].line;
        if (line >= 0 && line < nLines && lines[line].closed) {
            int others = 0;
            for (int k = 0; k < n; k++) if (k != i && labels[k].line == line) others++;
            ring = others == 0;
        }
        BOOL hit = NO;
        for (int k = 0; k < w && !hit; k++) {
            hit = OwnLabelsOverlap(labels[i], labels[k], padding);
            if (!hit && !ring) hit = LabelsCrowded(labels[i], labels[k]);
        }
        if (!hit) labels[w++] = labels[i];
    }
    return w;
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

static double EdgeMargin(double halfHeight) {
    return 1.5 * halfHeight * 2.0;
}

static BOOL LabelOnMap(OwnLabel lab, double minX, double minY, double maxX, double maxY) {
    double m = EdgeMargin(lab.halfH);
    return LabelInside(lab, minX + m, minY + m, maxX - m, maxY - m);
}

static double LabelSiteScore(double turn, double arc, double total, int closed,
    double x, double y, double minX, double minY, double maxX, double maxY) {
    double mid = (!closed && total > 0) ? fabs(arc - total * 0.5) / total : 0;
    double clearance = fmin(fmin(x - minX, maxX - x), fmin(y - minY, maxY - y));
    double reach = 0.5 * fmin(maxX - minX, maxY - minY);
    double interior = reach > 1.0 ? clearance / reach : 1.0;
    if (interior < 0) interior = 0;
    if (interior > 1) interior = 1;
    return -fabs(turn) + 1.25 * interior - 0.35 * mid;
}

static BOOL LabelHits(OwnLabel lab, const OwnLabel *labels, int n, double padding) {
    for (int i = 0; i < n; i++) {
        if (OwnLabelsOverlap(lab, labels[i], padding) || LabelsCrowded(lab, labels[i])) return YES;
    }
    return NO;
}

int OwnClearCentreLabels(OwnLabel *labels, int nLabels,
    const OwnLine *lines, int nLines, const OwnVec *centres, int nCentres,
    double minX, double minY, double maxX, double maxY) {
    if (!labels || nLabels <= 0) return 0;
    if (nCentres < 0) nCentres = 0;
    if (!centres) nCentres = 0;
    int w = 0;
    for (int i = 0; i < nLabels; i++) {
        OwnLabel lab = labels[i];
        double gap = 6.0 * lab.halfW;
        if (!(gap > 0)) gap = 0;
        BOOL close = NO;
        for (int c = 0; c < nCentres && !close; c++)
            close = hypot(lab.x - centres[c].x, lab.y - centres[c].y) < gap;
        if (!close && LabelOnMap(lab, minX, minY, maxX, maxY) && !LabelHits(lab, labels, w, 0)) {
            labels[w++] = lab;
            continue;
        }
        const OwnLine *line = (lines && lab.line >= 0 && lab.line < nLines) ? &lines[lab.line] : NULL;
        if (!line || line->count < 2) continue;
        double total = 0;
        double *s = ArcLengths(line->pts, line->count, line->closed, &total);
        if (!s || !(total > 0)) { free(s); continue; }
        BOOL found = NO;
        OwnLabel best = lab;
        double bestD = 1e9;
        double step = fmax(lab.halfW * 0.5, 4.0);
        for (double arc = 0; arc <= total + 1e-6; arc += step) {
            OwnVec p;
            if (!PointOnLine(line->pts, line->count, line->closed, s, total, arc, &p, NULL)) continue;
            BOOL ok = YES;
            for (int c = 0; c < nCentres && ok; c++)
                ok = hypot(p.x - centres[c].x, p.y - centres[c].y) >= gap;
            if (!ok) continue;
            OwnLabel trial = lab;
            trial.x = p.x;
            trial.y = p.y;
            trial.arc = arc;
            if (!LabelOnMap(trial, minX, minY, maxX, maxY)) continue;
            if (LabelHits(trial, labels, w, 0)) continue;
            BOOL later = NO;
            for (int k = i + 1; k < nLabels && !later; k++)
                later = OwnLabelsOverlap(trial, labels[k], 0) || LabelsCrowded(trial, labels[k]);
            if (later) continue;
            double d = hypot(trial.x - lab.x, trial.y - lab.y);
            if (!found || d < bestD) { found = YES; bestD = d; best = trial; }
        }
        free(s);
        if (found) labels[w++] = best;
    }
    return w;
}

int OwnPlaceLabels(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight, double padding,
    double minX, double minY, double maxX, double maxY,
    OwnLabel *out, int cap) {
    if (!lines || !halfWidth || !out || cap <= 0 || halfHeight <= 0) return 0;
    int placed = 0;
    // One label on every line first. A second label, on the next pass, must
    // not take the only clear site of a neighbouring isobar.
    for (int pass = 0; pass < 2; pass++) {
        for (int li = 0; li < nLines; li++) {
            int have = 0;
            for (int k = 0; k < placed; k++) if (out[k].line == li) have++;
            if (have != pass) continue;
            const OwnLine *line = &lines[li];
            if (line->count < 2) continue;
            double total = 0;
            double *s = ArcLengths(line->pts, line->count, line->closed, &total);
            if (!s || total < 1) { free(s); continue; }
            double halfW = halfWidth(line->level, context);
            if (!(halfW > 0)) { free(s); continue; }
            double margin = line->closed ? 0 : halfW + 2.0;
            if (!line->closed && total < margin * 2.0 + halfW) { free(s); continue; }
            int got = 0;
            double step = fmax(halfW * 0.85, 4.0);
            // Straighter spans nearer the middle of the map come first.
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
                OwnVec pb, pa, here;
                double ab, aa;
                if (!PointOnLine(line->pts, line->count, line->closed, s, total, before, &pb, &ab)) continue;
                if (!PointOnLine(line->pts, line->count, line->closed, s, total, after, &pa, &aa)) continue;
                if (!PointOnLine(line->pts, line->count, line->closed, s, total, arc, &here, NULL)) continue;
                double turn = aa - ab;
                while (turn > M_PI) turn -= 2 * M_PI;
                while (turn < -M_PI) turn += 2 * M_PI;
                cands[nc++] = (Cand){arc, LabelSiteScore(turn, arc, total, line->closed,
                    here.x, here.y, minX, minY, maxX, maxY)};
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
            for (int c = 0; c < nc && got < 1 && placed < cap; c++) {
                OwnVec p;
                double ang;
                if (!PointOnLine(line->pts, line->count, line->closed, s, total, cands[c].arc, &p, &ang)) continue;
                double support = fabs(halfW * cos(ang)) + fabs(halfHeight * sin(ang));
                OwnLabel lab = {
                    p.x, p.y, 0, halfW, halfHeight,
                    cands[c].arc, support + 2.5, line->level, li,
                };
                if (!LabelOnMap(lab, minX, minY, maxX, maxY)) continue;
                if (LabelHits(lab, out, placed, padding)) continue;
                out[placed++] = lab;
                got++;
            }
            free(cands);
            free(s);
        }
    }
    return placed;
}

static double HeadingChange(const OwnVec *pts, int n, int closed, const double *s, double total, double arc) {
    double window = fmin(12.0, total * 0.08);
    if (window < 1.0) window = 1.0;
    double ab = 0, aa = 0;
    if (!PointOnLine(pts, n, closed, s, total, arc - window, NULL, &ab)) return 0;
    if (!PointOnLine(pts, n, closed, s, total, arc + window, NULL, &aa)) return 0;
    double turn = aa - ab;
    while (turn > M_PI) turn -= 2 * M_PI;
    while (turn < -M_PI) turn += 2 * M_PI;
    return fabs(turn);
}

BOOL OwnContourAnchor(double x, double y, const OwnLine *line,
    double maxDist, double slide,
    double minX, double minY, double maxX, double maxY,
    double *outX, double *outY, double *outArc, double *outTangent, double *distance) {
    if (!line || line->count < 2 || !(maxDist > 0)) return NO;
    double total = 0;
    double *s = ArcLengths(line->pts, line->count, line->closed, &total);
    if (!s || !(total > 0)) { free(s); return NO; }
    double footArc = 0, footDist = 1e9, acc = 0;
    int edges = line->closed ? line->count : line->count - 1;
    for (int i = 0; i < edges; i++) {
        OwnVec a = line->pts[i];
        OwnVec b = line->pts[(i + 1) % line->count];
        double vx = b.x - a.x, vy = b.y - a.y;
        double denom = vx * vx + vy * vy;
        double t = denom > 1e-12 ? ((x - a.x) * vx + (y - a.y) * vy) / denom : 0;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        double d = hypot(a.x + t * vx - x, a.y + t * vy - y);
        double edge = hypot(vx, vy);
        if (d < footDist) { footDist = d; footArc = acc + t * edge; }
        acc += edge;
    }
    if (distance) *distance = footDist;
    if (footDist > maxDist) { free(s); return NO; }
    if (!(slide > 0)) slide = 0;
    double bestArc = footArc, bestScore = 1e9;
    BOOL found = NO;
    double step = 2.0;
    if (step > slide && slide > 0) step = slide;
    int samples = slide > 0 ? (int)(slide / step) : 0;
    for (int k = -samples; k <= samples; k++) {
        double arc = footArc + k * step;
        OwnVec p;
        double tangent = 0;
        if (!PointOnLine(line->pts, line->count, line->closed, s, total, arc, &p, &tangent)) continue;
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
        double dArc = fabs(arc - footArc);
        if (line->closed && total > 0) {
            double wrap = fabs(fmod(arc - footArc, total));
            if (wrap > total * 0.5) wrap = total - wrap;
            dArc = wrap;
        }
        double score = HeadingChange(line->pts, line->count, line->closed, s, total, arc) + 0.02 * dArc;
        if (!found || score < bestScore) {
            found = YES;
            bestScore = score;
            bestArc = arc;
        }
    }
    if (!found) { free(s); return NO; }
    OwnVec p;
    double tangent = 0;
    if (!PointOnLine(line->pts, line->count, line->closed, s, total, bestArc, &p, &tangent)) {
        free(s);
        return NO;
    }
    if (outX) *outX = p.x;
    if (outY) *outY = p.y;
    if (outArc) *outArc = bestArc < 0 ? bestArc + total : bestArc;
    if (outTangent) *outTangent = tangent;
    free(s);
    return YES;
}

static double ArcGap(double a, double b, double total, int closed) {
    double d = fabs(a - b);
    if (closed && total > 0 && d > total * 0.5) d = total - d;
    return d;
}

int OwnCoverLabels(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight, double padding,
    double minX, double minY, double maxX, double maxY,
    double minLength, double longLength,
    OwnLabel *labels, int nLabels, int cap) {
    if (!lines || !halfWidth || !labels || cap <= 0) return 0;
    if (nLabels < 0) nLabels = 0;
    if (nLabels > cap) nLabels = cap;
    for (int li = 0; li < nLines; li++) {
        const OwnLine *line = &lines[li];
        if (line->count < 2) continue;
        double total = 0;
        double *s = ArcLengths(line->pts, line->count, line->closed, &total);
        if (!s || total < minLength) { free(s); continue; }
        int need = (longLength > 0 && total >= longLength) ? 2 : 1;
        int have = 0;
        for (int i = 0; i < nLabels; i++) if (labels[i].line == li) have++;
        double halfW = halfWidth(line->level, context);
        if (!(halfW > 0)) { free(s); continue; }
        double margin = line->closed ? 0 : halfW + 2.0;
        double begin = line->closed ? 0 : margin;
        double end = line->closed ? total : total - margin;
        while (have < need && nLabels < cap && end > begin) {
            double bestScore = -1e9, bestArc = -1, bestAng = 0;
            OwnVec bestP = {0, 0};
            double step = fmax(halfW * 0.5, 8.0);
            for (double arc = begin; arc <= end + 1e-6; arc += step) {
                BOOL spaced = YES;
                for (int i = 0; i < nLabels && spaced; i++) {
                    if (labels[i].line != li) continue;
                    if (ArcGap(labels[i].arc, arc, total, line->closed) < fmax(80.0, total * 0.22))
                        spaced = NO;
                }
                if (!spaced) continue;
                OwnVec p;
                double ang = 0;
                if (!PointOnLine(line->pts, line->count, line->closed, s, total, arc, &p, &ang)) continue;
                double support = fabs(halfW * cos(ang)) + fabs(halfHeight * sin(ang));
                OwnLabel lab = {p.x, p.y, 0, halfW, halfHeight, arc, support + 2.5, line->level, li};
                if (!LabelOnMap(lab, minX, minY, maxX, maxY)) continue;
                if (LabelHits(lab, labels, nLabels, padding)) continue;
                double score = LabelSiteScore(
                    HeadingChange(line->pts, line->count, line->closed, s, total, arc),
                    arc, total, line->closed, p.x, p.y, minX, minY, maxX, maxY);
                if (bestArc < 0 || score > bestScore) {
                    bestScore = score;
                    bestArc = arc;
                    bestP = p;
                    bestAng = ang;
                }
            }
            if (bestArc < 0) break;
            double support = fabs(halfW * cos(bestAng)) + fabs(halfHeight * sin(bestAng));
            labels[nLabels++] = (OwnLabel){
                bestP.x, bestP.y, 0, halfW, halfHeight, bestArc, support + 2.5, line->level, li
            };
            have++;
        }
        free(s);
    }
    return nLabels;
}

int OwnCoverClosedRings(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight,
    double minX, double minY, double maxX, double maxY, double minSpan,
    const OwnVec *centres, int nCentres,
    OwnLabel *labels, int nLabels, int cap) {
    if (!lines || !halfWidth || !labels || cap <= 0 || !(halfHeight > 0)) return nLabels > 0 ? nLabels : 0;
    if (nLabels < 0) nLabels = 0;
    if (nLabels > cap) nLabels = cap;
    if (nCentres < 0 || !centres) nCentres = 0;
    if (!(minSpan > 0)) minSpan = 0;
    for (int li = 0; li < nLines; li++) {
        const OwnLine *line = &lines[li];
        if (!line->closed || line->count < 4 || nLabels >= cap) continue;
        BOOL labelled = NO;
        for (int i = 0; i < nLabels && !labelled; i++) labelled = labels[i].line == li;
        if (labelled) continue;
        double loX = INFINITY, hiX = -INFINITY, loY = INFINITY, hiY = -INFINITY;
        for (int p = 0; p < line->count; p++) {
            if (line->pts[p].x < loX) loX = line->pts[p].x;
            if (line->pts[p].x > hiX) hiX = line->pts[p].x;
            if (line->pts[p].y < loY) loY = line->pts[p].y;
            if (line->pts[p].y > hiY) hiY = line->pts[p].y;
        }
        if (fmax(hiX - loX, hiY - loY) < minSpan) continue;
        double total = 0;
        double *s = ArcLengths(line->pts, line->count, 1, &total);
        if (!s || !(total > 1)) { free(s); continue; }
        double halfW = halfWidth(line->level, context);
        if (!(halfW > 0)) { free(s); continue; }
        double step = fmax(halfW * 0.5, 6.0);
        BOOL found = NO;
        double bestAway = -1;
        OwnLabel best = {0};
        for (double arc = 0; arc <= total + 1e-6; arc += step) {
            OwnVec p;
            double ang = 0;
            if (!PointOnLine(line->pts, line->count, 1, s, total, arc, &p, &ang)) continue;
            double support = fabs(halfW * cos(ang)) + fabs(halfHeight * sin(ang));
            OwnLabel lab = {p.x, p.y, 0, halfW, halfHeight, arc, support + 2.5, line->level, li};
            if (!LabelOnMap(lab, minX, minY, maxX, maxY)) continue;
            if (LabelHits(lab, labels, nLabels, 4)) continue;
            double away = 1e9;
            for (int c = 0; c < nCentres; c++) {
                double d = hypot(p.x - centres[c].x, p.y - centres[c].y);
                if (d < away) away = d;
            }
            if (nCentres == 0) away = 0;
            if (!found || away > bestAway) { found = YES; bestAway = away; best = lab; }
        }
        free(s);
        if (found) labels[nLabels++] = best;
    }
    return nLabels;
}

static const double kLabelGapPad = 2.5;

static void LabelLocal(OwnLabel lab, double x, double y, double *lx, double *ly) {
    double dx = x - lab.x, dy = y - lab.y;
    double co = cos(lab.angle), si = sin(lab.angle);
    *lx = dx * co + dy * si;
    *ly = -dx * si + dy * co;
}

static BOOL SegmentInBox(OwnLabel lab, double x0, double y0, double x1, double y1, double *t0, double *t1) {
    double ax, ay, bx, by;
    LabelLocal(lab, x0, y0, &ax, &ay);
    LabelLocal(lab, x1, y1, &bx, &by);
    double hw = lab.halfW + kLabelGapPad, hh = lab.halfH + kLabelGapPad;
    double dx = bx - ax, dy = by - ay;
    double enter = 0, exit = 1;
    double p[4] = {-dx, dx, -dy, dy};
    double q[4] = {ax + hw, hw - ax, ay + hh, hh - ay};
    for (int i = 0; i < 4; i++) {
        if (fabs(p[i]) < 1e-12) {
            if (q[i] < -1e-9) return NO;
        } else {
            double t = q[i] / p[i];
            if (p[i] < 0) { if (t > enter) enter = t; }
            else if (t < exit) exit = t;
            if (enter > exit + 1e-12) return NO;
        }
    }
    if (exit < 0 || enter > 1) return NO;
    if (enter < 0) enter = 0;
    if (exit > 1) exit = 1;
    if (exit - enter < 1e-8) return NO;
    *t0 = enter;
    *t1 = exit;
    return YES;
}

static void GapAppend(OwnVec **cur, int *nCur, int *cap, OwnVec p) {
    if (*nCur > 0 && fabs((*cur)[*nCur - 1].x - p.x) < 1e-6 && fabs((*cur)[*nCur - 1].y - p.y) < 1e-6) return;
    if (*nCur + 1 > *cap) {
        int next = *cap ? *cap * 2 : 16;
        OwnVec *grown = realloc(*cur, (size_t)next * sizeof(OwnVec));
        if (!grown) return;
        *cur = grown;
        *cap = next;
    }
    (*cur)[(*nCur)++] = p;
}

OwnLineSet OwnCutGaps(const OwnVec *pts, int count, int closed,
    const OwnLabel *labels, int nLabels) {
    OwnLineSet set = {0};
    if (!pts || count < 2) return set;
    BOOL labelled = labels && nLabels > 0;
    BOOL startKept = YES;
    if (labelled) {
        for (int g = 0; g < nLabels && startKept; g++) {
            double t0, t1;
            if (SegmentInBox(labels[g], pts[0].x, pts[0].y, pts[0].x, pts[0].y, &t0, &t1)) startKept = NO;
        }
    }
    int edges = closed ? count : count - 1;
    OwnVec *cur = NULL;
    int nCur = 0, cap = 0;
    OwnVec *head = NULL;
    int nHead = 0;
    BOOL savedHead = NO;
    BOOL anyGap = NO;
    for (int e = 0; e < edges; e++) {
        OwnVec a = pts[e];
        OwnVec b = pts[(e + 1) % count];
        double gaps[32];
        int nGap = 0;
        if (labelled) {
            for (int g = 0; g < nLabels && nGap + 2 <= 32; g++) {
                double t0, t1;
                if (!SegmentInBox(labels[g], a.x, a.y, b.x, b.y, &t0, &t1)) continue;
                gaps[nGap++] = t0;
                gaps[nGap++] = t1;
            }
        }
        for (int i = 2; i < nGap; i += 2) {
            double t0 = gaps[i], t1 = gaps[i + 1];
            int j = i;
            while (j > 0 && gaps[j - 2] > t0) {
                gaps[j] = gaps[j - 2];
                gaps[j + 1] = gaps[j - 1];
                j -= 2;
            }
            gaps[j] = t0;
            gaps[j + 1] = t1;
        }
        double merged[32];
        int nMerged = 0;
        for (int i = 0; i < nGap; i += 2) {
            double t0 = gaps[i], t1 = gaps[i + 1];
            if (nMerged && t0 <= merged[nMerged - 1] + 1e-8) {
                if (t1 > merged[nMerged - 1]) merged[nMerged - 1] = t1;
            } else if (nMerged + 2 <= 32) {
                merged[nMerged++] = t0;
                merged[nMerged++] = t1;
            }
        }
        double kept[34];
        int nKept = 0;
        double cursor = 0;
        for (int i = 0; i < nMerged; i += 2) {
            if (merged[i] > cursor + 1e-7) {
                kept[nKept++] = cursor;
                kept[nKept++] = merged[i];
            }
            if (merged[i + 1] > cursor) cursor = merged[i + 1];
        }
        if (cursor < 1 - 1e-7) {
            kept[nKept++] = cursor;
            kept[nKept++] = 1;
        }
        for (int i = 0; i < nKept; i += 2) {
            if (kept[i] > 1e-7) {
                if (nCur >= 2 && closed && startKept && !savedHead) {
                    head = cur; nHead = nCur; savedHead = YES;
                } else if (nCur >= 2) {
                    PushLine(&set, cur, nCur, 0, 0);
                } else free(cur);
                cur = NULL; nCur = 0; cap = 0;
                anyGap = YES;
            }
            GapAppend(&cur, &nCur, &cap, LerpVec(a, b, kept[i]));
            GapAppend(&cur, &nCur, &cap, LerpVec(a, b, kept[i + 1]));
            if (kept[i + 1] < 1 - 1e-7) {
                if (nCur >= 2 && closed && startKept && !savedHead) {
                    head = cur; nHead = nCur; savedHead = YES;
                } else if (nCur >= 2) {
                    PushLine(&set, cur, nCur, 0, 0);
                } else free(cur);
                cur = NULL; nCur = 0; cap = 0;
                anyGap = YES;
            }
        }
        if (nKept == 0) {
            if (nCur >= 2 && closed && startKept && !savedHead) {
                head = cur; nHead = nCur; savedHead = YES;
            } else if (nCur >= 2) {
                PushLine(&set, cur, nCur, 0, 0);
            } else free(cur);
            cur = NULL; nCur = 0; cap = 0;
            anyGap = YES;
        }
    }
    if (!anyGap && closed && nCur >= 3) {
        if (fabs(cur[0].x - cur[nCur - 1].x) < 1e-6 && fabs(cur[0].y - cur[nCur - 1].y) < 1e-6) nCur--;
        PushLine(&set, cur, nCur, 1, 0);
        free(head);
        return set;
    }
    if (savedHead && nCur >= 2) {
        int skip = 0;
        if (nHead > 0 && fabs(cur[nCur - 1].x - head[0].x) < 1e-6 && fabs(cur[nCur - 1].y - head[0].y) < 1e-6)
            skip = 1;
        int mergedN = nCur + nHead - skip;
        OwnVec *join = malloc((size_t)mergedN * sizeof(OwnVec));
        if (join) {
            memcpy(join, cur, (size_t)nCur * sizeof(OwnVec));
            if (nHead - skip > 0) memcpy(join + nCur, head + skip, (size_t)(nHead - skip) * sizeof(OwnVec));
            PushLine(&set, join, mergedN, 0, 0);
        }
        free(cur);
        free(head);
        return set;
    }
    if (nCur >= 2) PushLine(&set, cur, nCur, 0, 0);
    else free(cur);
    if (nHead >= 2) PushLine(&set, head, nHead, 0, 0);
    else free(head);
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

// Classic chart and its key (tools/own-chart.m): muted blue through amber,
// red from 35 °C. The classic renderer applies its own opacity and ocean
// wash; these tables are its look and are not the GPU map overlay below.
static const double kClassicTempStops[] = {0, 10, 20, 25, 30, 35, 40};
static const OwnRGB kClassicTempCols[] = {
    {0.42, 0.55, 0.70}, {0.62, 0.66, 0.70}, {0.78, 0.74, 0.62}, {0.86, 0.72, 0.42},
    {0.84, 0.52, 0.28}, {0.74, 0.24, 0.20}, {0.55, 0.16, 0.16},
};
// Quiet overlays with separate dark ink: the plate and hairline coast remain
// legible. Rain is one teal-blue, wind one slate, temperature cool to warm.
// The low-temperature stops carry real contrast for 850 hPa as well as 2 m.
static const double kTempStops[] = {-10, 0, 10, 20, 27, 35, 42};
static const OwnRGB kTempCols[] = {
    {0.24, 0.37, 0.54}, {0.34, 0.45, 0.56}, {0.40, 0.48, 0.56}, {0.58, 0.49, 0.40},
    {0.80, 0.62, 0.44}, {0.74, 0.48, 0.34}, {0.64, 0.32, 0.28},
};
static const OwnRGB kTempDarkCols[] = {
    {0.47, 0.65, 0.82}, {0.54, 0.69, 0.82}, {0.63, 0.68, 0.73}, {0.79, 0.69, 0.59},
    {0.88, 0.69, 0.48}, {0.88, 0.59, 0.44}, {0.85, 0.47, 0.39},
};
static const double kTempAlpha[] = {0.34, 0.34, 0.34, 0.34, 0.26, 0.32, 0.34};
// Trailing 24-hour millimetres, not an hourly rate. Dry below 0.1 mm.
static const double kRainStops[] = {0.1, 1, 5, 20, 50};
static const OwnRGB kRainCols[] = {
    {0.26, 0.55, 0.65}, {0.12, 0.41, 0.53}, {0.06, 0.29, 0.42},
    {0.04, 0.22, 0.34}, {0.03, 0.16, 0.27},
};
static const OwnRGB kRainDarkCols[] = {
    {0.22, 0.54, 0.63}, {0.22, 0.61, 0.71}, {0.25, 0.72, 0.80},
    {0.30, 0.74, 0.82}, {0.34, 0.76, 0.84},
};
static const double kRainAlpha[] = {0.20, 0.32, 0.40, 0.42, 0.44};
// Most of the wind scale belongs to ordinary 10–40 kt, saturating at 60.
static const double kWindStops[] = {0, 10, 20, 30, 40, 50, 60};
static const OwnRGB kWindCols[] = {
    {0.64, 0.66, 0.73}, {0.43, 0.46, 0.57}, {0.29, 0.34, 0.47},
    {0.21, 0.27, 0.41}, {0.16, 0.22, 0.36}, {0.13, 0.19, 0.32}, {0.11, 0.16, 0.29},
};
static const OwnRGB kWindDarkCols[] = {
    {0.50, 0.53, 0.65}, {0.56, 0.58, 0.71}, {0.62, 0.64, 0.77},
    {0.66, 0.67, 0.79}, {0.68, 0.68, 0.80}, {0.69, 0.69, 0.81}, {0.70, 0.70, 0.82},
};
static const double kWindAlpha[] = {0, 0.20, 0.32, 0.37, 0.40, 0.40, 0.40};
// Pressure fill for a grid with no land plate. The Australian chart does not
// paint this; it uses the land and sea tokens.
static const double kPresStops[] = {960, 990, 1008, 1020, 1036};
static const OwnRGB kPresCols[] = {
    {0.55, 0.64, 0.72}, {0.73, 0.78, 0.80}, {0.86, 0.84, 0.78},
    {0.84, 0.78, 0.70}, {0.70, 0.60, 0.54},
};
static const double kPresAlpha[] = {1, 1, 1, 1, 1};

static OwnRGB ByteRGB(int red, int green, int blue) {
    return (OwnRGB){red / 255.0, green / 255.0, blue / 255.0};
}

void OwnFieldRampForAppearance(int kind, BOOL dark, const double **stops, const OwnRGB **cols, const double **alphas,
    int *count, double *cutoff) {
    const double *s = kPresStops, *a = kPresAlpha;
    const OwnRGB *c = kPresCols;
    int n = 5;
    double cut = -1e30;
    if (kind == 1) { s = kTempStops; c = dark ? kTempDarkCols : kTempCols; a = kTempAlpha; n = 7; }
    else if (kind == 2) { s = kWindStops; c = dark ? kWindDarkCols : kWindCols; a = kWindAlpha; n = 7; }
    else if (kind == 3) { s = kRainStops; c = dark ? kRainDarkCols : kRainCols; a = kRainAlpha; n = 5; cut = 0.1; }
    if (stops) *stops = s;
    if (cols) *cols = c;
    if (alphas) *alphas = a;
    if (count) *count = n;
    if (cutoff) *cutoff = cut;
}

void OwnFieldRamp(int kind, const double **stops, const OwnRGB **cols, const double **alphas,
    int *count, double *cutoff) {
    OwnFieldRampForAppearance(kind, NO, stops, cols, alphas, count, cutoff);
}

static OwnRGB RampLerp(const double *stops, const OwnRGB *cols, int count, double value) {
    if (count < 1 || !cols) return (OwnRGB){0, 0, 0};
    if (!isfinite(value) || value <= stops[0]) return cols[0];
    if (value >= stops[count - 1]) return cols[count - 1];
    for (int i = 0; i < count - 1; i++) {
        if (value <= stops[i + 1]) {
            double t = (value - stops[i]) / (stops[i + 1] - stops[i]);
            return (OwnRGB){
                cols[i].r + (cols[i + 1].r - cols[i].r) * t,
                cols[i].g + (cols[i + 1].g - cols[i].g) * t,
                cols[i].b + (cols[i + 1].b - cols[i].b) * t,
            };
        }
    }
    return cols[count - 1];
}

OwnRGB OwnFieldRGBForAppearance(int kind, double value, BOOL dark) {
    const double *stops = NULL;
    const OwnRGB *cols = NULL;
    int count = 0;
    OwnFieldRampForAppearance(kind, dark, &stops, &cols, NULL, &count, NULL);
    return RampLerp(stops, cols, count, value);
}

OwnRGB OwnFieldRGB(int kind, double value) { return OwnFieldRGBForAppearance(kind, value, NO); }

double OwnFieldSeaAlphaScale(int kind) { return kind == 1 ? 0.8 : 1.0; }

double OwnFieldOverlayAlpha(int kind, double value) {
    const double *stops = NULL, *alphas = NULL;
    int count = 0;
    double cutoff = -1e30;
    OwnFieldRamp(kind, &stops, NULL, &alphas, &count, &cutoff);
    if (!isfinite(value) || count < 1 || !alphas) return 0;
    if (value < cutoff) return 0;
    if (value <= stops[0]) return alphas[0];
    if (value >= stops[count - 1]) return alphas[count - 1];
    for (int i = 0; i < count - 1; i++) {
        if (value <= stops[i + 1]) {
            double t = (value - stops[i]) / (stops[i + 1] - stops[i]);
            return alphas[i] + (alphas[i + 1] - alphas[i]) * t;
        }
    }
    return alphas[count - 1];
}

OwnRGB OwnTemperatureRGB(double celsius) { return RampLerp(kClassicTempStops, kClassicTempCols, 7, celsius); }

OwnRGB OwnOceanWash(OwnRGB colour) {
    colour.r *= 0.88 * 0.92;
    colour.g *= 0.88;
    colour.b = fmin(1.0, colour.b * 0.88 + 0.045);
    return colour;
}

OwnRGB OwnRainRGB(double millimetres) { return OwnFieldRGB(3, millimetres); }

OwnRGB OwnWindRGB(double knots) { return OwnFieldRGB(2, knots); }

static OwnRGB ChartByte(int red, int green, int blue) {
    return (OwnRGB){red / 255.0, green / 255.0, blue / 255.0};
}

// Pale blue-grey sea, pale yellow land, charcoal ink — the Bureau plate in
// docs/design/own-chart/b-mslp.png. Contrast is part of the contract in
// test_ownchart: ink on both fills stays above 4.5:1, including at the
// small size of the menu-bar popover.
OwnRGB OwnChartSea(void) { return ChartByte(0xEB, 0xF1, 0xF7); }
OwnRGB OwnChartLand(void) { return ChartByte(0xF4, 0xEE, 0xAF); }
OwnRGB OwnChartInk(void) { return ChartByte(0x1B, 0x28, 0x30); }
OwnRGB OwnChartTitle(void) { return ChartByte(0x2E, 0x4C, 0x5C); }

OwnChartPalette OwnChartPaletteFor(BOOL dark) {
    if (!dark) {
        OwnRGB ink = OwnChartInk();
        return (OwnChartPalette){
            .land = OwnChartLand(),
            .sea = OwnChartSea(),
            .coast = ByteRGB(0x12, 0x10, 0x0D),
            .isobar = ink,
            .label = ink,
            .centre = ink,
            .uncovered = ByteRGB(0xE4, 0xDD, 0xD2),
            .missing = ByteRGB(0x8E, 0x8A, 0x84),
            .edge = ByteRGB(0x5E, 0x6A, 0x74),
        };
    }
    // Same chart, inverted: warm land lighter than cool sea, light ink.
    // Clear of the light no-coverage beige, and of the coast token, so a
    // dark isobar is not counted as the uncovered plate.
    OwnRGB ink = ByteRGB(0xF3, 0xED, 0xD8);
    return (OwnChartPalette){
        .land = ByteRGB(0x6A, 0x5C, 0x32),
        .sea = ByteRGB(0x24, 0x32, 0x42),
        .coast = ByteRGB(0xF7, 0xF4, 0xEE),
        .isobar = ink,
        .label = ink,
        .centre = ink,
        .uncovered = ByteRGB(0x14, 0x16, 0x1C),
        .missing = ByteRGB(0x7A, 0x76, 0x70),
        .edge = ByteRGB(0x9A, 0xA4, 0xAE),
    };
}

double OwnIsobarWidth(double levelHPa) {
    (void)levelHPa;
    return 1.25;
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

NSString *OwnCoastPath(void) {
    const char *env = getenv("ISOBAR_COAST");
    if (env && env[0]) return [[NSString stringWithUTF8String:env] stringByExpandingTildeInPath];
    NSString *bundled = [NSBundle.mainBundle pathForResource:@"ownchart-coast" ofType:@"bin"];
    return bundled.length ? bundled : @"Resources/ownchart-coast.bin";
}

NSString *OwnWorldCoastPath(void) {
    const char *env = getenv("ISOBAR_WORLD_COAST");
    if (env && env[0]) return [[NSString stringWithUTF8String:env] stringByExpandingTildeInPath];
    NSString *bundled = [NSBundle.mainBundle pathForResource:@"world-coast" ofType:@"bin"];
    return bundled.length ? bundled : @"Resources/world-coast.bin";
}
