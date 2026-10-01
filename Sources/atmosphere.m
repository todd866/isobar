#import "atmosphere.h"
#import <math.h>

static const double kStandardGravity = 9.80665;
static const double kDryAirGasConstant = 287.05287;

static BOOL finiteNumber(id value, double *out) {
    if (![value isKindOfClass:NSNumber.class]) return NO;
    double n = [value doubleValue];
    if (!isfinite(n)) return NO;
    if (out) *out = n;
    return YES;
}

static NSDate *ParseTime(id value) {
    if (![value isKindOfClass:NSString.class] || ![(NSString *)value length]) return nil;
    static NSISO8601DateFormatter *f; static dispatch_once_t once;
    dispatch_once(&once,^{ f=[NSISO8601DateFormatter new]; f.formatOptions=NSISO8601DateFormatWithInternetDateTime; });
    NSString *text = value;
    NSDate *date = [f dateFromString:text];
    if (!date && [text rangeOfString:@"T"].location != NSNotFound) {
        if ([text hasSuffix:@"Z"] == NO && [text rangeOfString:@"+"].location == NSNotFound)
            text = [text stringByAppendingString:@"Z"];
        if (text.length == 17 || (text.length == 18 && [text hasSuffix:@"Z"]))
            text = [text stringByReplacingOccurrencesOfString:@"Z" withString:@":00Z"];
        date = [f dateFromString:text];
    }
    return date;
}

static BOOL ValidPressure(double p) { return isfinite(p) && p >= 50.0 && p <= 1100.0; }
static BOOL ValidHeight(double h) { return isfinite(h) && h >= -1000.0 && h <= 50000.0; }
static BOOL ValidTemperature(double t) { return isfinite(t) && t >= -120.0 && t <= 80.0; }
static BOOL ValidHumidity(double h) { return isfinite(h) && h >= 0.0 && h <= 100.0; }
static BOOL ValidCloud(double c) { return isfinite(c) && c >= 0.0 && c <= 100.0; }
static BOOL ValidWind(double w) { return isfinite(w) && w >= 0.0 && w <= 300.0; }
static BOOL ValidDirection(double d) { return isfinite(d) && d >= 0.0 && d <= 360.0; }
static BOOL ValidVerticalVelocity(double w) { return isfinite(w) && fabs(w) <= 100.0; }

NSDictionary *StandardAtmosphereAtHeight(double heightM) {
    if (!isfinite(heightM) || heightM < 0.0 || heightM > 20000.0) return nil;
    const double seaLevelPressure = 1013.25;
    const double seaLevelTemperature = 288.15;
    const double lapseRate = 0.0065;
    double temperatureK, pressureHpa;
    if (heightM <= 11000.0) {
        temperatureK = seaLevelTemperature - lapseRate * heightM;
        pressureHpa = seaLevelPressure * pow(temperatureK / seaLevelTemperature,
                                             kStandardGravity / (kDryAirGasConstant * lapseRate));
    } else {
        temperatureK = 216.65;
        double tropopausePressure = seaLevelPressure * pow(temperatureK / seaLevelTemperature,
                                                           kStandardGravity / (kDryAirGasConstant * lapseRate));
        pressureHpa = tropopausePressure * exp(-kStandardGravity * (heightM - 11000.0) /
                                                (kDryAirGasConstant * temperatureK));
    }
    double density = (pressureHpa * 100.0) / (kDryAirGasConstant * temperatureK);
    return @{ @"temperatureC": @(temperatureK - 273.15),
              @"pressureHpa": @(pressureHpa),
              @"densityKgM3": @(density) };
}

typedef BOOL (*AtmosphereValidator)(double);
static NSNumber *ValidValue(NSDictionary *field, NSString *key, NSUInteger index, AtmosphereValidator valid) {
    id values = field[key];
    if (![values isKindOfClass:NSArray.class] || index >= [values count]) return nil;
    double n = 0;
    return finiteNumber(values[index], &n) && valid(n) ? @(n) : nil;
}

static NSNumber *Interpolated(NSDictionary *field, NSString *key, NSUInteger left, NSUInteger right,
                              double fraction, AtmosphereValidator valid) {
    NSNumber *a = ValidValue(field, key, left, valid), *b = ValidValue(field, key, right, valid);
    if (!a || !b) return nil;
    return @([a doubleValue] + ([b doubleValue] - [a doubleValue]) * fraction);
}

static NSNumber *InterpolatedDirection(NSDictionary *field, NSString *key, NSUInteger left,
                                       NSUInteger right, double fraction) {
    NSNumber *a = ValidValue(field, key, left, ValidDirection), *b = ValidValue(field, key, right, ValidDirection);
    if (!a || !b) return nil;
    double x = [a doubleValue], y = [b doubleValue], delta = fmod(y - x + 540.0, 360.0) - 180.0;
    double result = fmod(x + delta * fraction, 360.0);
    if (result < 0) result += 360.0;
    return @(result);
}

static NSDictionary *LevelAtDate(NSDictionary *field, NSNumber *pressure, NSUInteger left, NSUInteger right,
                                  double fraction, double elevation) {
    double p = [pressure doubleValue];
    if (!ValidPressure(p)) return nil;
    NSNumber *height = Interpolated(field, @"height_m", left, right, fraction, ValidHeight);
    if (!height || [height doubleValue] <= elevation) return nil;
    NSMutableDictionary *row = [@{ @"pressureHpa": pressure, @"heightM": height } mutableCopy];
    NSNumber *temperature = Interpolated(field, @"temperature_c", left, right, fraction, ValidTemperature);
    NSNumber *humidity = Interpolated(field, @"relative_humidity_pct", left, right, fraction, ValidHumidity);
    NSNumber *cloud = Interpolated(field, @"cloud_cover_pct", left, right, fraction, ValidCloud);
    NSNumber *wind = Interpolated(field, @"wind_speed_kt", left, right, fraction, ValidWind);
    NSNumber *direction = InterpolatedDirection(field, @"wind_direction_deg", left, right, fraction);
    // Interpolate the air's velocity, not a compass angle and speed separately.
    // Opposing winds pass through calm rather than rotating at full speed.
    NSNumber *wa=ValidValue(field,@"wind_speed_kt",left,ValidWind), *wb=ValidValue(field,@"wind_speed_kt",right,ValidWind);
    NSNumber *da=ValidValue(field,@"wind_direction_deg",left,ValidDirection), *db=ValidValue(field,@"wind_direction_deg",right,ValidDirection);
    if (wa && wb && da && db) {
        double u=-wa.doubleValue*sin(da.doubleValue*M_PI/180)*(1-fraction)-wb.doubleValue*sin(db.doubleValue*M_PI/180)*fraction;
        double v=-wa.doubleValue*cos(da.doubleValue*M_PI/180)*(1-fraction)-wb.doubleValue*cos(db.doubleValue*M_PI/180)*fraction;
        wind=@(hypot(u,v)); direction=wind.doubleValue>.001?@(fmod(atan2(-u,-v)*180/M_PI+360,360)):nil;
        row[@"windEastKt"]=@(u); row[@"windNorthKt"]=@(v);
    }
    NSNumber *vertical=Interpolated(field,@"vertical_velocity_ms",left,right,fraction,ValidVerticalVelocity);
    if (vertical) row[@"verticalVelocityMS"]=vertical;
    if (temperature) row[@"temperatureC"] = temperature;
    if (humidity) row[@"humidityPct"] = humidity;
    if (cloud) row[@"cloudPct"] = cloud;
    if (wind) row[@"windKt"] = wind;
    if (direction) row[@"windDegrees"] = direction;
    return row;
}

static void AddThermalFeatures(NSMutableDictionary *result, NSArray<NSDictionary *> *levels) {
    NSMutableOrderedSet *freezing = [NSMutableOrderedSet orderedSet];
    NSMutableArray *inversions = [NSMutableArray array];
    for (NSUInteger i = 1; i < levels.count; i++) {
        NSDictionary *lower = levels[i - 1], *upper = levels[i];
        if ([upper[@"_ordinal"] integerValue]-[lower[@"_ordinal"] integerValue]!=1) continue;
        NSNumber *t0 = lower[@"temperatureC"], *t1 = upper[@"temperatureC"];
        NSNumber *h0 = lower[@"heightM"], *h1 = upper[@"heightM"];
        if (!t0 || !t1 || !h0 || !h1) continue;
        double a = t0.doubleValue, b = t1.doubleValue, ha = h0.doubleValue, hb = h1.doubleValue;
        if (a == 0) [freezing addObject:@(ha)];
        if ((a < 0 && b > 0) || (a > 0 && b < 0) || b == 0) {
            double f = (b == a) ? 0 : -a / (b - a);
            [freezing addObject:@(ha + (hb - ha) * f)];
        }
        if (b > a) [inversions addObject:@{ @"fromM": @(ha), @"toM": @(hb), @"temperatureDeltaC": @(b - a) }];
    }
    if (freezing.count) result[@"freezingHeightsM"] = freezing.array;
    if (inversions.count) result[@"inversions"] = inversions;
}

NSDictionary *AtmosphereAtDate(NSDictionary *product, NSDate *date) {
    if (![product isKindOfClass:NSDictionary.class] || !date || !isfinite(date.timeIntervalSince1970)) return nil;
    NSArray *rawTimes = [product[@"time"] isKindOfClass:NSArray.class] ? product[@"time"] : nil;
    if (!rawTimes.count) return nil;
    static NSCache<NSArray *,NSArray<NSDate *> *> *timeCache; static dispatch_once_t once;
    dispatch_once(&once,^{ timeCache=[NSCache new]; timeCache.countLimit=8; });
    NSArray<NSDate *> *times=[timeCache objectForKey:rawTimes];
    if (!times) {
        NSMutableArray<NSDate *> *parsed=[NSMutableArray array];
        for (id raw in rawTimes) {
            NSDate *t = ParseTime(raw);
            if (!t || (parsed.count && [t compare:parsed.lastObject]!=NSOrderedDescending)) return nil;
            [parsed addObject:t];
        }
        times=[parsed copy]; [timeCache setObject:times forKey:[rawTimes copy]];
    }
    NSUInteger right = NSNotFound;
    for (NSUInteger i = 0; i < times.count; i++) if ([times[i] compare:date] != NSOrderedAscending) { right = i; break; }
    if (right == NSNotFound || (right == 0 && [times[0] compare:date] == NSOrderedDescending)) return nil;
    NSUInteger left = [times[right] isEqualToDate:date] ? right : right - 1;
    if ([times[left] compare:date] == NSOrderedDescending || [times[right] compare:date] == NSOrderedAscending) return nil;
    NSTimeInterval span = [times[right] timeIntervalSinceDate:times[left]];
    if (span < 0 || span > 4.0 * 3600.0) return nil;
    double fraction = span == 0 ? 0 : [date timeIntervalSinceDate:times[left]] / span;
    double elevation = 0;
    if (!finiteNumber(product[@"elevation"], &elevation)) elevation = -INFINITY;
    NSDictionary *rawLevels = [product[@"levels"] isKindOfClass:NSDictionary.class] ? product[@"levels"] : nil;
    if (!rawLevels.count) return nil;
    NSArray *pressures = [[rawLevels allKeys] sortedArrayUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
        return [a doubleValue] > [b doubleValue] ? NSOrderedAscending : ([a doubleValue] < [b doubleValue] ? NSOrderedDescending : NSOrderedSame);
    }];
    NSMutableArray *levels = [NSMutableArray array];
    NSDictionary *units=[product[@"units"] isKindOfClass:NSDictionary.class]?product[@"units"]:@{};
    NSDictionary *fieldNames=@{@"height_m":@"geopotential_height",@"temperature_c":@"temperature",
        @"relative_humidity_pct":@"relative_humidity",@"cloud_cover_pct":@"cloud_cover",
        @"wind_speed_kt":@"wind_speed",@"wind_direction_deg":@"wind_direction",@"vertical_velocity_ms":@"vertical_velocity"};
    NSDictionary *allowedUnits=@{@"height_m":@[@"m"],@"temperature_c":@[@"°C",@"celsius"],
        @"relative_humidity_pct":@[@"%"],@"cloud_cover_pct":@[@"%"],
        @"wind_speed_kt":@[@"kn",@"knots"],@"wind_direction_deg":@[@"°"],@"vertical_velocity_ms":@[@"m/s"]};
    NSUInteger ordinal=0;
    for (NSString *key in pressures) {
        if (![key isKindOfClass:NSString.class]) continue;
        NSScanner *scanner=[NSScanner scannerWithString:key]; double pressure=0;
        if (![scanner scanDouble:&pressure] || !scanner.isAtEnd || !ValidPressure(pressure)) continue;
        NSMutableDictionary *field = [rawLevels[key] isKindOfClass:NSDictionary.class] ? [rawLevels[key] mutableCopy] : nil;
        for (NSString *name in fieldNames) {
            id unit=units[[NSString stringWithFormat:@"%@_%@hPa",fieldNames[name],key]];
            if (unit && ![allowedUnits[name] containsObject:unit]) [field removeObjectForKey:name];
        }
        NSMutableDictionary *row = field ? [LevelAtDate(field, @(pressure), left, right, fraction, elevation) mutableCopy] : nil;
        if (row) { row[@"_ordinal"]=@(ordinal); [levels addObject:row]; }
        ordinal++;
    }
    [levels sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"heightM"] compare:b[@"heightM"]];
    }];
    if (!levels.count) return nil;
    NSMutableDictionary *result = [@{ @"sampleTime": date, @"date": date,
        @"source": product[@"id"] ?: product[@"source"] ?: @"upper-air",
        @"model": product[@"model"] ?: @"unknown", @"run": product[@"run"] ?: [NSNull null],
        @"levels": levels } mutableCopy];
    BOOL hasHumidity = NO, hasCloud = NO, hasVertical = NO;
    for (NSDictionary *row in levels) { hasHumidity |= row[@"humidityPct"] != nil; hasCloud |= row[@"cloudPct"] != nil; hasVertical |= row[@"verticalVelocityMS"] != nil; }
    result[@"featureAvailability"] = @{ @"relativeHumidity": @(hasHumidity), @"cloudCover": @(hasCloud), @"verticalVelocity": @(hasVertical) };
    if (!hasHumidity) result[@"missingFeatures"] = @[@"relativeHumidity"];
    if (!hasCloud) {
        NSMutableArray *missing = [result[@"missingFeatures"] mutableCopy] ?: [NSMutableArray array];
        [missing addObject:@"cloudCover"]; result[@"missingFeatures"] = missing;
    }
    AddThermalFeatures(result, levels);
    for (NSMutableDictionary *row in levels) [row removeObjectForKey:@"_ordinal"];
    return result;
}
