#import "trainingdata.h"
#import "archive.h"
#import "aviation.h"
#import "ownrender.h"
#import <math.h>

static id OrNull(id value) { return value ?: (id)NSNull.null; }

static NSString *ISO(NSDate *date) {
    if (!date) return nil;
    NSISO8601DateFormatter *fmt = [NSISO8601DateFormatter new];
    fmt.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    fmt.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    return [fmt stringFromDate:date];
}

static NSDate *DateValue(id value) {
    if ([value isKindOfClass:NSDate.class]) return value;
    if ([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]))
        return [NSDate dateWithTimeIntervalSince1970:[value doubleValue]];
    if (![value isKindOfClass:NSString.class] || ![value length]) return nil;
    NSISO8601DateFormatter *fmt = [NSISO8601DateFormatter new];
    fmt.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    fmt.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSDate *date = [fmt dateFromString:value];
    if (!date) {
        fmt.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        date = [fmt dateFromString:value];
    }
    return date;
}

static id JsonNum(double value, int decimals) {
    if (!isfinite(value)) return NSNull.null;
    double scale = pow(10.0, decimals);
    return @(round(value * scale) / scale);
}

static float DecodeF16(uint16_t bits) {
    int sign = (bits >> 15) & 1;
    int exponent = (bits >> 10) & 0x1f;
    int fraction = bits & 0x3ff;
    float value;
    if (exponent == 0) value = fraction == 0 ? 0.0f : ldexpf((float)fraction, -24);
    else if (exponent == 31) value = fraction ? NAN : INFINITY;
    else value = ldexpf(1.0f + (float)fraction / 1024.0f, exponent - 15);
    return sign ? -value : value;
}

static BOOL SafeID(NSString *value) {
    return value.length && ![value hasPrefix:@"."] && [value rangeOfString:@"/"].location == NSNotFound &&
        [value rangeOfString:@"\\"].location == NSNotFound && [value rangeOfString:@".."].location == NSNotFound;
}

static NSString *ValidID(NSDate *date) {
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    fmt.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    fmt.dateFormat = @"yyyyMMdd'T'HH'Z'";
    return [fmt stringFromDate:date];
}

static double Bilinear(double v00, double v10, double v01, double v11, double tx, double ty) {
    if (!isfinite(v00) || !isfinite(v10) || !isfinite(v01) || !isfinite(v11)) return NAN;
    double a = v00 * (1.0 - tx) + v10 * tx;
    double b = v01 * (1.0 - tx) + v11 * tx;
    return a * (1.0 - ty) + b * ty;
}

static double SampleScalar(OwnRun *run, NSInteger hour, OwnRunField field, double lat, double lon) {
    OwnRunGeo geo = run.geo;
    if (!(geo.step > 0) || geo.nLon < 2 || geo.nLat < 2) return NAN;
    double fx = (lon - geo.west) / geo.step;
    double fy = (geo.north - lat) / geo.step;
    int i0 = (int)floor(fx), j0 = (int)floor(fy);
    if (i0 < 0 || j0 < 0 || i0 + 1 >= geo.nLon || j0 + 1 >= geo.nLat) return NAN;
    double tx = fx - i0, ty = fy - j0;
    return Bilinear(
        [run valueAtPointIndex:(NSInteger)j0 * geo.nLon + i0 field:field hour:hour],
        [run valueAtPointIndex:(NSInteger)j0 * geo.nLon + i0 + 1 field:field hour:hour],
        [run valueAtPointIndex:((NSInteger)j0 + 1) * geo.nLon + i0 field:field hour:hour],
        [run valueAtPointIndex:((NSInteger)j0 + 1) * geo.nLon + i0 + 1 field:field hour:hour],
        tx, ty);
}

static void SampleWind(OwnRun *run, NSInteger hour, double lat, double lon, double *knots, double *fromDeg) {
    *knots = NAN;
    *fromDeg = NAN;
    OwnRunGeo geo = run.geo;
    if (!(geo.step > 0) || geo.nLon < 2 || geo.nLat < 2) return;
    double fx = (lon - geo.west) / geo.step;
    double fy = (geo.north - lat) / geo.step;
    int i0 = (int)floor(fx), j0 = (int)floor(fy);
    if (i0 < 0 || j0 < 0 || i0 + 1 >= geo.nLon || j0 + 1 >= geo.nLat) return;
    int cols[4] = {i0, i0 + 1, i0, i0 + 1};
    int rows[4] = {j0, j0, j0 + 1, j0 + 1};
    double u[4], v[4];
    for (int corner = 0; corner < 4; corner++) {
        NSInteger index = (NSInteger)rows[corner] * geo.nLon + cols[corner];
        double speed = [run valueAtPointIndex:index field:OwnRunFieldWindSpeed hour:hour];
        double from = [run valueAtPointIndex:index field:OwnRunFieldWindDirection hour:hour];
        if (!isfinite(speed) || !isfinite(from)) return;
        double rad = from * M_PI / 180.0;
        u[corner] = -sin(rad) * speed;
        v[corner] = -cos(rad) * speed;
    }
    double tx = fx - i0, ty = fy - j0;
    double ue = Bilinear(u[0], u[1], u[2], u[3], tx, ty);
    double vn = Bilinear(v[0], v[1], v[2], v[3], tx, ty);
    *knots = hypot(ue, vn);
    double deg = atan2(-ue, -vn) * 180.0 / M_PI;
    if (deg < 0) deg += 360.0;
    *fromDeg = deg;
}

static double SampleField(const float *field, int nLon, int nLat, double north, double west, double step,
    double lat, double lon) {
    if (!field || !(step > 0)) return NAN;
    double fx = (lon - west) / step;
    double fy = (north - lat) / step;
    int i0 = (int)floor(fx), j0 = (int)floor(fy);
    if (i0 < 0 || j0 < 0 || i0 + 1 >= nLon || j0 + 1 >= nLat) return NAN;
    return Bilinear(field[j0 * nLon + i0], field[j0 * nLon + i0 + 1],
        field[(j0 + 1) * nLon + i0], field[(j0 + 1) * nLon + i0 + 1], fx - i0, fy - j0);
}

// One published float16 frame. A sidecar that does not match the grid contract
// fails that field closed; it does not blank the rest of the snapshot.
static double SamplePublished(NSString *root, NSString *runID, BOOL global, NSString *variable, NSString *param,
    NSString *units, NSDate *valid, double lat, double lon) {
    if (!SafeID(runID) || !SafeID(variable) || !valid) return NAN;
    NSString *family = global ? @"ecmwf_ifs_global" : @"ecmwf_ifs025";
    NSString *familyRoot = [[root stringByAppendingPathComponent:@"products/grids"] stringByAppendingPathComponent:family];
    NSString *stem = [[[[familyRoot stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:runID]
        stringByAppendingPathComponent:variable] stringByAppendingPathComponent:ValidID(valid)];
    NSData *sideData = [NSData dataWithContentsOfFile:[stem stringByAppendingPathExtension:@"json"]];
    NSDictionary *side = [NSJSONSerialization JSONObjectWithData:sideData ?: [NSData data] options:0 error:nil];
    if (![side isKindOfClass:NSDictionary.class]) return NAN;
    int nLon = [side[@"nx"] intValue], nLat = [side[@"ny"] intValue];
    if (nLon < 2 || nLat < 2 || nLon > 1000 || nLat > 1000) return NAN;
    double north = global ? 90.0 : 0.0;
    double west = global ? -180.0 : 95.0;
    double step = global ? 0.5 : 0.25;
    if (global && (nLon != 720 || nLat != 361)) return NAN;
    if (fabs([side[@"lat0"] doubleValue] - north) > 1e-6 || fabs([side[@"lon0"] doubleValue] - west) > 1e-6) return NAN;
    if (fabs([side[@"dlat"] doubleValue] + step) > 1e-6 || fabs([side[@"dlon"] doubleValue] - step) > 1e-6) return NAN;
    if (global && ![side[@"wraps_longitude"] boolValue]) return NAN;
    if (![side[@"units"] isEqual:units] || ![side[@"param"] isEqual:param]) return NAN;
    if (![side[@"dtype"] isEqual:@"float16"] || ![side[@"endian"] isEqual:@"little"]) return NAN;
    if (![side[@"order"] isEqual:@"north-to-south, west-to-east"]) return NAN;
    NSDate *sideValid = DateValue(side[@"valid_time"]);
    if (!sideValid || fabs([sideValid timeIntervalSinceDate:valid]) > 1) return NAN;
    NSData *file = [NSData dataWithContentsOfFile:[stem stringByAppendingPathExtension:@"f16"]];
    if (file.length != (NSUInteger)nLon * (NSUInteger)nLat * sizeof(uint16_t)) return NAN;
    float *values = malloc((size_t)nLon * (size_t)nLat * sizeof(float));
    if (!values) return NAN;
    const uint8_t *bytes = file.bytes;
    for (int i = 0; i < nLon * nLat; i++) {
        uint16_t bits = (uint16_t)bytes[i * 2] | ((uint16_t)bytes[i * 2 + 1] << 8);
        values[i] = bits == 0xf800 ? NAN : DecodeF16(bits);
        if (isinf(values[i])) values[i] = NAN;
    }
    double sample = SampleField(values, nLon, nLat, north, west, step, lat, lon);
    free(values);
    return sample;
}

// Geostrophic sample on one MSLP field. The box is the ATPL template:
// 30–43°S, 112–155°E, outer two cells dropped, 3×3 span at most 6 hPa.
// f keeps its sign, so a southern-hemisphere gradient points the right way.
typedef struct {
    double knots, fromDeg, hpaPer100km, lat, lon;
    int i, j;
    BOOL ok;
} GeoSample;

static double FieldAt(const double *field, int nLon, int i, int j) {
    return field[(NSInteger)j * nLon + i];
}

static BOOL StencilSpan(const double *field, int nLon, int i, int j, double *span) {
    double lo = INFINITY, hi = -INFINITY;
    for (int dj = -1; dj <= 1; dj++) {
        for (int di = -1; di <= 1; di++) {
            double value = FieldAt(field, nLon, i + di, j + dj);
            if (!isfinite(value)) return NO;
            if (value < lo) lo = value;
            if (value > hi) hi = value;
        }
    }
    *span = hi - lo;
    return YES;
}

static GeoSample GeoAt(const double *field, OwnRunGeo geo, int i, int j) {
    GeoSample sample = {0};
    sample.i = i;
    sample.j = j;
    double lat = geo.north - j * geo.step;
    double lon = geo.west + i * geo.step;
    if (lat > -30.0 || lat < -43.0 || lon < 112.0 || lon > 155.0) return sample;
    double span = 0;
    if (!StencilSpan(field, geo.nLon, i, j, &span) || span > 6.0) return sample;
    double east = FieldAt(field, geo.nLon, i + 1, j);
    double west = FieldAt(field, geo.nLon, i - 1, j);
    double north = FieldAt(field, geo.nLon, i, j - 1);
    double south = FieldAt(field, geo.nLon, i, j + 1);
    double kmLat = geo.step * 110.574;
    double kmLon = geo.step * 111.320 * cos(lat * M_PI / 180.0);
    if (!(kmLon > 1)) return sample;
    double dpdx = (east - west) * 100.0 / (2.0 * kmLon * 1000.0);
    double dpdy = (north - south) * 100.0 / (2.0 * kmLat * 1000.0);
    double f = 2.0 * 7.292115e-5 * sin(lat * M_PI / 180.0);
    if (!(fabs(f) > 1e-5)) return sample;
    double eastward = -(1.0 / (1.225 * f)) * dpdy;
    double northward = (1.0 / (1.225 * f)) * dpdx;
    double from = atan2(-eastward, -northward) * 180.0 / M_PI;
    if (from < 0) from += 360.0;
    sample.knots = hypot(eastward, northward) * 1.943844;
    sample.fromDeg = from;
    sample.hpaPer100km = hypot(dpdx, dpdy) * 1000.0;
    sample.lat = lat;
    sample.lon = lon;
    sample.ok = isfinite(sample.knots);
    return sample;
}

static BOOL RoughNear(const uint8_t *rough, int nLon, int i, int j) {
    if (!rough) return NO;
    for (int dj = -1; dj <= 1; dj++)
        for (int di = -1; di <= 1; di++)
            if (rough[j * nLon + i + (NSInteger)dj * nLon + di]) return YES;
    return NO;
}

static GeoSample GeoMax(const double *field, OwnRunGeo geo, const uint8_t *skip) {
    GeoSample best = {0};
    if (!field || geo.nLon < 5 || geo.nLat < 5) return best;
    for (int j = 2; j < geo.nLat - 2; j++) {
        for (int i = 2; i < geo.nLon - 2; i++) {
            if (skip && RoughNear(skip, geo.nLon, i, j)) continue;
            GeoSample sample = GeoAt(field, geo, i, j);
            if (sample.ok && sample.knots > best.knots) best = sample;
        }
    }
    return best;
}

static NSDictionary *GeoJSON(OwnRun *run, NSInteger hour, GeoSample sample) {
    if (!sample.ok) return nil;
    double x = 0, y = 0, wind = NAN, from = NAN;
    SampleWind(run, hour, sample.lat, sample.lon, &wind, &from);
    NSMutableDictionary *json = [@{
        @"lat": JsonNum(sample.lat, 2),
        @"lon": JsonNum(sample.lon, 2),
        @"hpaPer100km": JsonNum(sample.hpaPer100km, 1),
        @"geostrophicKt": JsonNum(sample.knots, 0),
        @"fromDeg": JsonNum(sample.fromDeg, 0),
        @"windKt": JsonNum(wind, 0),
    } mutableCopy];
    if (OwnChartImagePoint(sample.lat, sample.lon, &x, &y)) {
        json[@"mapX"] = JsonNum(x, 4);
        json[@"mapY"] = JsonNum(y, 4);
    }
    return json;
}

// Scored maximum is the land-mixed field, with rough cells left out. The raw
// maximum is kept only when that cell is the high-terrain spike the mix removed.
static void GradientPair(OwnRun *run, NSInteger hour, NSDictionary **screened, NSDictionary **artefact) {
    *screened = nil;
    *artefact = nil;
    OwnRunGeo geo = run.geo;
    if (!(geo.step > 0) || geo.nLon < 5 || geo.nLat < 5) return;
    NSInteger n = (NSInteger)geo.nLon * geo.nLat;
    double *raw = malloc((size_t)n * sizeof(double));
    if (!raw) return;
    for (NSInteger p = 0; p < n; p++)
        raw[p] = [run valueAtPointIndex:p field:OwnRunFieldMSLP hour:hour];
    uint8_t *rough = NULL;
    double *mixed = [run screenedMslpAtHour:hour rough:&rough];
    GeoSample shown = GeoMax(mixed ?: raw, geo, rough);
    GeoSample rawMax = GeoMax(raw, geo, NULL);
    *screened = GeoJSON(run, hour, shown);
    BOOL spike = rawMax.ok && RoughNear(rough, geo.nLon, rawMax.i, rawMax.j);
    BOOL moved = shown.ok && rawMax.ok && (fabs(shown.lat - rawMax.lat) > 0.4 || fabs(shown.lon - rawMax.lon) > 0.4);
    if (spike && moved) *artefact = GeoJSON(run, hour, rawMax);
    free(raw);
    free(mixed);
    free(rough);
}

static NSString *ChartPNG(OwnRun *run, NSInteger hour, NSDate *valid) {
    OwnLayerOptions layers = {0};
    NSImage *image = OwnRunRender(run, hour, ISO(valid) ?: @"", layers, nil, 1);
    NSData *tiff = [image TIFFRepresentation];
    NSBitmapImageRep *rep = tiff.length ? [[NSBitmapImageRep alloc] initWithData:tiff] : nil;
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return png.length ? [png base64EncodedStringWithOptions:0] : nil;
}

static NSDictionary *SampleAt(OwnRun *run, NSInteger hour, NSString *root, NSString *runID, BOOL global, NSDate *valid,
    NSString *identity, double lat, double lon) {
    double wind = NAN, from = NAN;
    SampleWind(run, hour, lat, lon, &wind, &from);
    double cloud = runID.length ? SamplePublished(root, runID, global, @"cloud_cover", @"tcc", @"%", valid, lat, lon) : NAN;
    double cape = runID.length ? SamplePublished(root, runID, global, @"mucape", @"mucape", @"J/kg", valid, lat, lon) : NAN;
    NSMutableDictionary *sample = [NSMutableDictionary dictionary];
    if (identity) sample[@"id"] = identity;
    sample[@"lat"] = @(lat);
    sample[@"lon"] = @(lon);
    sample[@"mslpHpa"] = JsonNum(SampleScalar(run, hour, OwnRunFieldMSLP, lat, lon), 1);
    sample[@"windFromDeg"] = JsonNum(from, 0);
    sample[@"windKt"] = JsonNum(wind, 0);
    sample[@"t2mC"] = JsonNum(SampleScalar(run, hour, OwnRunFieldT2M, lat, lon), 1);
    sample[@"cloudCoverPct"] = JsonNum(cloud, 0);
    sample[@"mucapeJkg"] = JsonNum(cape, 0);
    return sample;
}

static NSDictionary *MetarJSON(NSDictionary *product, __unused NSString *icao, NSDate *now, NSTimeZone *zone) {
    NSDictionary *metar = [product[@"metar"] isKindOfClass:NSDictionary.class] ? product[@"metar"] : nil;
    NSString *raw = [metar[@"raw"] isKindOfClass:NSString.class] ? metar[@"raw"] : nil;
    if (!raw.length) return nil;
    NSDate *time = DateValue(metar[@"time"]);
    NSDictionary *instrument = FlyMetarInstrument(raw, time, now, zone);
    return @{
        @"raw": raw,
        @"time": OrNull(ISO(time)),
        @"cloud": instrument[@"cloud"] ?: @"—",
        @"vis": instrument[@"vis"] ?: @"—",
        @"wind": instrument[@"wind"] ?: @"—",
        @"clock": instrument[@"clock"] ?: @"—",
        @"age": instrument[@"age"] ?: @"—",
        @"aged": instrument[@"aged"] ?: @NO,
        @"tip": instrument[@"tip"] ?: raw,
        @"hazard": instrument[@"hazard"] ?: @"",
        @"hazardTip": instrument[@"hazardTip"] ?: @"",
    };
}

static NSDictionary *TafJSON(NSDictionary *product, NSString *icao, NSDate *now, NSTimeZone *zone) {
    NSDictionary *taf = [product[@"taf"] isKindOfClass:NSDictionary.class] ? product[@"taf"] : nil;
    NSString *raw = [taf[@"raw"] isKindOfClass:NSString.class] ? taf[@"raw"] : nil;
    if (!raw.length) return nil;
    NSDate *issue = DateValue(taf[@"issue_time"]);
    NSDate *from = DateValue(taf[@"valid_from"]);
    NSDate *to = DateValue(taf[@"valid_to"]);
    NSDictionary *bulletin = AviationBulletin(product, icao, now, zone);
    NSMutableArray *lines = [NSMutableArray array];
    for (NSDictionary *line in bulletin[@"lines"]) {
        if (![line isKindOfClass:NSDictionary.class] || ![line[@"text"] isKindOfClass:NSString.class]) continue;
        [lines addObject:@{@"text": line[@"text"], @"active": line[@"active"] ?: @NO}];
    }
    return @{
        @"raw": raw,
        @"issue": OrNull(ISO(issue)),
        @"from": OrNull(ISO(from)),
        @"to": OrNull(ISO(to)),
        @"header": FlyValidityRow(from, to, zone) ?: @"TAF",
        @"headerUtc": FlyValidityUTC(from, to) ?: @"",
        @"lines": lines,
    };
}

static id Sigmets(NSString *root) {
    NSDictionary *product = ArchiveAviationProduct(root, @"sigmet.json");
    if (!product) return NSNull.null;
    NSArray *features = [product[@"features"] isKindOfClass:NSArray.class] ? product[@"features"] : @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *feature in features) {
        if (![feature isKindOfClass:NSDictionary.class]) continue;
        [out addObject:@{
            @"fir": [feature[@"firId"] isKindOfClass:NSString.class] ? feature[@"firId"] : @"",
            @"hazard": [feature[@"hazard"] isKindOfClass:NSString.class] ? feature[@"hazard"] : @"",
            @"qualifier": [feature[@"qualifier"] isKindOfClass:NSString.class] ? feature[@"qualifier"] : @"",
            @"base": [feature[@"base"] isKindOfClass:NSNumber.class] ? feature[@"base"] : NSNull.null,
            @"top": [feature[@"top"] isKindOfClass:NSNumber.class] ? feature[@"top"] : NSNull.null,
            @"raw": [feature[@"raw"] isKindOfClass:NSString.class] ? feature[@"raw"] : @"",
            @"from": OrNull(ISO(DateValue(feature[@"valid_from"]))),
            @"to": OrNull(ISO(DateValue(feature[@"valid_to"]))),
        }];
    }
    return out;
}

static id NotamCount(NSString *root) {
    NSDictionary *product = ArchiveAviationProduct(root, @"notams.json");
    if (!product) return NSNull.null;
    NSArray *notices = [product[@"notices"] isKindOfClass:NSArray.class] ? product[@"notices"] : nil;
    return notices ? @(notices.count) : NSNull.null;
}

static OwnRun *LoadRun(NSString *root, NSString *coast, BOOL *published, BOOL *global, NSString **runID, NSString **error) {
    NSString *globalPointerPath = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs_global/current.json"];
    NSString *pointerPath = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/current.json"];
    *global = [NSFileManager.defaultManager fileExistsAtPath:globalPointerPath];
    *published = *global || [NSFileManager.defaultManager fileExistsAtPath:pointerPath];
    *runID = nil;
    if (*published) {
        NSData *data = [NSData dataWithContentsOfFile:*global ? globalPointerPath : pointerPath];
        id parsed = [NSJSONSerialization JSONObjectWithData:data ?: [NSData data] options:0 error:nil];
        NSDictionary *pointer = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
        if ([pointer[@"latest"] isKindOfClass:NSString.class]) *runID = pointer[@"latest"];
        return OwnRunLoadPublished(root, NO, coast, error);
    }
    NSData *data = [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:@"ecmwf/latest.json"]];
    id parsed = [NSJSONSerialization JSONObjectWithData:data ?: [NSData data] options:0 error:nil];
    NSDictionary *pointer = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
    NSString *path = [pointer[@"path"] isKindOfClass:NSString.class] ? pointer[@"path"] : nil;
    if (!SafeID(path)) {
        if (error) *error = @"legacy ECMWF pointer is missing";
        return nil;
    }
    return OwnRunLoad([[root stringByAppendingPathComponent:@"ecmwf"] stringByAppendingPathComponent:path], coast, error);
}

static NSDate *TrainingClock(NSDate *now) {
    if (now) return now;
    const char *clock = getenv("ISOBAR_CHECK_NOW");
    if (clock && clock[0]) {
        NSISO8601DateFormatter *fmt = [NSISO8601DateFormatter new];
        fmt.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        fmt.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        NSDate *fixed = [fmt dateFromString:[NSString stringWithUTF8String:clock]];
        if (fixed) return fixed;
    }
    return [NSDate date];
}

NSDictionary *TrainingSnapshot(NSString *storeRoot, NSDate *now, NSString *coastPath) {
    now = TrainingClock(now);
    NSString *root = [storeRoot stringByExpandingTildeInPath];
    NSString *error = nil;
    BOOL published = NO;
    BOOL global = NO;
    NSString *runID = nil;
    OwnRun *run = root.length ? LoadRun(root, coastPath, &published, &global, &runID, &error) : nil;
    if (!root.length) error = @"no store";
    NSInteger hour = -1;
    NSDate *sampleTime = nil;
    if (run) {
        NSTimeInterval best = INFINITY;
        for (NSInteger i = 0; i < run.hours; i++) {
            NSDate *time = [run timeAtIndex:i];
            if (!time) continue;
            NSTimeInterval dt = fabs([time timeIntervalSinceDate:now]);
            if (dt < best) { best = dt; hour = i; sampleTime = time; }
        }
    }
    static const struct { const char *icao, *name, *zone; double lat, lon; } airports[] = {
        {"YPPH", "Perth", "Australia/Perth", -31.9403, 115.9669},
        {"YPAD", "Adelaide", "Australia/Adelaide", -34.9450, 138.5306},
        {"YMML", "Melbourne", "Australia/Melbourne", -37.6733, 144.8433},
        {"YSCB", "Canberra", "Australia/Sydney", -35.3069, 149.1950},
        {"YSSY", "Sydney", "Australia/Sydney", -33.9461, 151.1772},
    };
    NSMutableArray *airportJSON = [NSMutableArray array];
    for (NSUInteger i = 0; i < sizeof airports / sizeof airports[0]; i++) {
        NSString *icao = @(airports[i].icao);
        NSTimeZone *zone = [NSTimeZone timeZoneWithName:@(airports[i].zone)] ?: [NSTimeZone timeZoneWithName:@"Australia/Sydney"];
        NSDictionary *product = root.length ? ArchiveAviationProduct(root, [icao stringByAppendingPathExtension:@"json"]) : nil;
        NSMutableDictionary *item = [@{
            @"icao": icao,
            @"name": @(airports[i].name),
            @"zone": @(airports[i].zone),
            @"lat": @(airports[i].lat),
            @"lon": @(airports[i].lon),
            @"metar": OrNull(product ? MetarJSON(product, icao, now, zone) : nil),
            @"taf": OrNull(product ? TafJSON(product, icao, now, zone) : nil),
        } mutableCopy];
        item[@"sample"] = (run && hour >= 0)
            ? SampleAt(run, hour, root, published ? runID : nil, global, sampleTime, nil, airports[i].lat, airports[i].lon)
            : NSNull.null;
        [airportJSON addObject:item];
    }
    static const struct { const char *name; double lat, lon; } route[] = {
        {"route-west", -33.0, 125.0}, {"route-mid", -35.2, 135.0}, {"route-east", -34.8, 145.0},
    };
    NSMutableArray *points = [NSMutableArray array];
    if (run && hour >= 0) {
        for (NSUInteger i = 0; i < sizeof route / sizeof route[0]; i++)
            [points addObject:SampleAt(run, hour, root, published ? runID : nil, global, sampleTime, @(route[i].name), route[i].lat, route[i].lon)];
    }
    NSDictionary *gradient = nil, *artefact = nil;
    if (run && hour >= 0) GradientPair(run, hour, &gradient, &artefact);
    return @{
        @"now": ISO(now) ?: @"",
        @"runTime": OrNull(ISO(run.runDate)),
        @"runError": OrNull(run ? nil : error),
        @"gridSource": run ? (published ? @"published" : @"legacy") : NSNull.null,
        @"sampleTime": OrNull(ISO(sampleTime)),
        @"chartPng": OrNull((run && hour >= 0) ? ChartPNG(run, hour, sampleTime) : nil),
        @"gradient": OrNull(gradient),
        @"artefact": OrNull(artefact),
        @"sigmets": root.length ? Sigmets(root) : NSNull.null,
        @"notamCount": root.length ? NotamCount(root) : NSNull.null,
        @"airports": airportJSON,
        @"points": points,
    };
}

NSData *TrainingSnapshotJSON(NSString *storeRoot, NSDate *now, NSString *coastPath) {
    return [NSJSONSerialization dataWithJSONObject:TrainingSnapshot(storeRoot, now, coastPath) options:0 error:nil];
}

NSString *TrainingProgressPath(void) {
    NSString *base = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    return [[base stringByAppendingPathComponent:@"Isobar"] stringByAppendingPathComponent:@"training.json"];
}

BOOL TrainingProgressWrite(NSString *path, NSData *json, NSString **error) {
    if (!path.length || json.length == 0 || json.length > 1000000) {
        if (error) *error = @"progress was empty or too large";
        return NO;
    }
    id object = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
    if (![object isKindOfClass:NSDictionary.class] || ![object[@"version"] isEqual:@1] ||
        ![object[@"cards"] isKindOfClass:NSDictionary.class]) {
        if (error) *error = @"progress is not a version 1 object";
        return NO;
    }
    NSData *clean = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingPrettyPrinted error:nil];
    if (!clean.length) {
        if (error) *error = @"progress could not be encoded";
        return NO;
    }
    NSString *dir = path.stringByDeletingLastPathComponent;
    if (![NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil]) {
        if (error) *error = @"progress directory was not created";
        return NO;
    }
    if (![clean writeToFile:path atomically:YES]) {
        if (error) *error = @"progress was not written";
        return NO;
    }
    return YES;
}

NSData *TrainingProgressRead(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    id object = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![object isKindOfClass:NSDictionary.class] || ![object[@"version"] isEqual:@1]) return nil;
    return data;
}
