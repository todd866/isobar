#import "archive.h"
#import <sqlite3.h>
#import <math.h>

static NSDictionary *JSON(NSData *data) {
    id value = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![value isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *product = value;
    // Older archives have no marker. A newer contract must fail closed instead
    // of being interpreted with today's units, coordinates or time semantics.
    id contract = product[@"contract"], version = product[@"schema_version"];
    if (contract && (![contract isKindOfClass:NSString.class] || ![contract isEqual:@"isobar-data"])) return nil;
    if (version && (![version isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID() || [version integerValue] != 1 ||
                    [version doubleValue] != 1.0)) return nil;
    return product;
}

static NSDictionary *JSONForFamily(NSData *data, NSString *expected) {
    NSDictionary *product = JSON(data);
    id family = product[@"family"];
    if (family && (![family isKindOfClass:NSString.class] || ![family isEqual:expected])) return nil;
    return product;
}

static NSData *Encode(id object) {
    return [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
}

static BOOL SafeComponent(NSString *value) {
    return value.length && ![value hasPrefix:@"/"] && ![value hasPrefix:@"~"] &&
        ![value containsString:@".."] && ![value containsString:@"/"] && ![value containsString:@"\\"];
}

static NSString *StoreRoot(NSString *root) {
    return [root stringByExpandingTildeInPath];
}

static NSDictionary *PublishedPointer(NSString *base, NSString *family, BOOL *exists) {
    NSString *path = [base stringByAppendingPathComponent:@"current.json"];
    BOOL present = [NSFileManager.defaultManager fileExistsAtPath:path];
    if (exists) *exists = present;
    return present ? JSONForFamily([NSData dataWithContentsOfFile:path], family) : nil;
}

NSString *ArchiveChartPath(NSString *root, BOOL previous) {
    NSString *base = [StoreRoot(root) stringByAppendingPathComponent:@"products/charts"];
    BOOL pointerExists = NO;
    NSDictionary *pointer = PublishedPointer(base, @"charts", &pointerExists);
    if (!pointerExists) {
        NSString *relative = previous ? @"previous/IDG00073.pdf" : @"IDG00073.pdf";
        NSString *legacy = [base stringByAppendingPathComponent:relative];
        return [NSFileManager.defaultManager isReadableFileAtPath:legacy] ? legacy : nil;
    }
    if (![pointer isKindOfClass:NSDictionary.class]) return nil;
    NSString *latest = [pointer[@"latest"] isKindOfClass:NSString.class] ? pointer[@"latest"] : nil;
    if (!SafeComponent(latest)) return nil;
    NSString *runs = [base stringByAppendingPathComponent:@"runs"];
    NSString *current = [[runs stringByAppendingPathComponent:latest] stringByAppendingPathComponent:@"IDG00073.pdf"];
    if (![NSFileManager.defaultManager isReadableFileAtPath:current]) return nil;
    if (!previous) return current;
    NSData *currentData = [NSData dataWithContentsOfFile:current];
    NSArray *published = [pointer[@"runs"] isKindOfClass:NSArray.class] ? pointer[@"runs"] : @[];
    // publish_run(keep=previous) orders this as [older, latest]. Walk back
    // from latest, skipping same-PDF generations caused by GIF-only updates.
    for (NSInteger i = (NSInteger)published.count - 1; i >= 0; i--) {
        NSString *run = [published[(NSUInteger)i] isKindOfClass:NSString.class] ? published[(NSUInteger)i] : nil;
        if (!SafeComponent(run) || [run isEqual:latest]) continue;
        NSString *candidate = [[runs stringByAppendingPathComponent:run] stringByAppendingPathComponent:@"IDG00073.pdf"];
        if (![NSFileManager.defaultManager isReadableFileAtPath:candidate]) continue;
        NSData *candidateData = [NSData dataWithContentsOfFile:candidate];
        if (candidateData && ![candidateData isEqual:currentData]) return candidate;
    }
    return nil;
}

NSString *ArchiveWarningDirectory(NSString *root) {
    NSString *base = [StoreRoot(root) stringByAppendingPathComponent:@"products/warnings"];
    BOOL pointerExists = NO;
    NSDictionary *pointer = PublishedPointer(base, @"warnings", &pointerExists);
    if (!pointerExists) return [NSFileManager.defaultManager fileExistsAtPath:base] ? base : nil;
    if (![pointer isKindOfClass:NSDictionary.class]) return nil;
    NSString *latest = [pointer[@"latest"] isKindOfClass:NSString.class] ? pointer[@"latest"] : nil;
    if (!SafeComponent(latest)) return nil;
    NSString *directory = [[base stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:latest];
    return [NSFileManager.defaultManager fileExistsAtPath:directory] ? directory : nil;
}

static NSString *LocalStamp(NSString *utc, NSString *state) {
    if (utc.length < 14) return nil;
    static NSDateFormatter *in;
    static NSMutableDictionary *outputs;
    if (!in) {
        in = [NSDateFormatter new];
        in.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        in.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
        in.dateFormat = @"yyyyMMddHHmmss";
        outputs = [NSMutableDictionary dictionary];
    }
    NSDate *date = [in dateFromString:utc];
    if (!date) return nil;
    NSDictionary *zones = @{@"WA": @"Australia/Perth", @"NSW": @"Australia/Sydney", @"VIC": @"Australia/Melbourne",
        @"QLD": @"Australia/Brisbane", @"SA": @"Australia/Adelaide", @"TAS": @"Australia/Hobart",
        @"NT": @"Australia/Darwin"};
    NSDateFormatter *out = outputs[state];
    if (!out) {
        out = [NSDateFormatter new];
        out.locale = in.locale;
        out.timeZone = [NSTimeZone timeZoneWithName:zones[state] ?: @"Australia/Perth"];
        out.dateFormat = @"yyyyMMddHHmmss";
        outputs[state] = out;
    }
    return [out stringFromDate:date];
}

NSDictionary<NSString *, NSData *> *ArchiveObservationFiles(NSString *root) {
    return ArchiveObservationFilesAtDate(root, NSDate.date);
}

NSDictionary<NSString *, NSData *> *ArchiveObservationFilesAtDate(NSString *root, NSDate *now) {
    NSString *path = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:@"products/obs/obs.sqlite"];
    sqlite3 *db = NULL;
    NSString *uri = [NSString stringWithFormat:@"file:%@?mode=ro", path];
    int openRC = sqlite3_open_v2(uri.UTF8String, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, NULL);
    if (db) sqlite3_busy_timeout(db, 750);
    const char *sql = "SELECT wmo,aifstime_utc,product_id,name,lat,lon,air_temp,wind_dir,wind_dir_deg,wind_spd_kmh,gust_kmh,wind_spd_kt,gust_kt,press_msl,press_tend,rain_trace,cloud_base_m,vis_km FROM obs WHERE aifstime_utc >= ? ORDER BY wmo,aifstime_utc DESC";
    sqlite3_stmt *stmt = NULL;
    if (openRC == SQLITE_OK) openRC = sqlite3_prepare_v2(db, sql, -1, &stmt, NULL);
    if (openRC != SQLITE_OK) {
        if (stmt) sqlite3_finalize(stmt);
        stmt = NULL;
        if (db) sqlite3_close(db);
        db = NULL;
        if ((openRC & 0xff) != SQLITE_CANTOPEN && (openRC & 0xff) != SQLITE_READONLY) return @{};
        // macOS may require a writable handle to recreate idle WAL sidecars.
        // Disallow SQL writes and close-time checkpoints before reading.
        NSString *rwURI = [NSString stringWithFormat:@"file:%@?mode=rw", path];
        openRC = sqlite3_open_v2(rwURI.UTF8String, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_URI, NULL);
        if (openRC != SQLITE_OK || !db) { if (db) sqlite3_close(db); return @{}; }
        sqlite3_busy_timeout(db, 750);
        int oldCheckpoint = 0;
        if (sqlite3_db_config(db, SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, 1, &oldCheckpoint) != SQLITE_OK ||
            sqlite3_exec(db, "PRAGMA query_only=ON", NULL, NULL, NULL) != SQLITE_OK) {
            sqlite3_close(db);
            return @{};
        }
        sqlite3_stmt *guard = NULL;
        if (sqlite3_prepare_v2(db, "PRAGMA query_only", -1, &guard, NULL) != SQLITE_OK ||
            sqlite3_step(guard) != SQLITE_ROW || sqlite3_column_int(guard, 0) != 1) {
            if (guard) sqlite3_finalize(guard);
            sqlite3_close(db);
            return @{};
        }
        sqlite3_finalize(guard);
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) {
            if (stmt) sqlite3_finalize(stmt);
            sqlite3_close(db);
            return @{};
        }
    }
    NSMutableDictionary *rowsByWMO = [NSMutableDictionary dictionary];
    if (sqlite3_exec(db, "BEGIN", NULL, NULL, NULL) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        sqlite3_close(db);
        return @{};
    }
    if (stmt) {
        NSDateFormatter *stampFormat = [NSDateFormatter new];
        stampFormat.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        stampFormat.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
        stampFormat.dateFormat = @"yyyyMMddHHmmss";
        NSString *cutoff = [stampFormat stringFromDate:[now dateByAddingTimeInterval:-48 * 3600]];
        sqlite3_bind_text(stmt, 1, cutoff.UTF8String, -1, SQLITE_TRANSIENT);
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            NSString *wmo = [NSString stringWithFormat:@"%d", sqlite3_column_int(stmt, 0)];
            NSString *product = [NSString stringWithUTF8String:(const char *)sqlite3_column_text(stmt, 2) ?: ""];
            NSString *state = [product hasPrefix:@"IDN"] ? @"NSW" : [product hasPrefix:@"IDV"] ? @"VIC" : [product hasPrefix:@"IDQ"] ? @"QLD" : [product hasPrefix:@"IDS"] ? @"SA" : [product hasPrefix:@"IDT"] ? @"TAS" : [product hasPrefix:@"IDD"] ? @"NT" : @"WA";
            NSMutableDictionary *row = [NSMutableDictionary dictionary];
            NSString *stamp = [NSString stringWithUTF8String:(const char *)sqlite3_column_text(stmt, 1) ?: ""];
            row[@"local_date_time_full"] = LocalStamp(stamp, state) ?: stamp;
            NSString *keys[] = {@"name", @"wind_dir", @"press_tend", @"rain_trace"};
            int textColumns[] = {3, 7, 14, 15};
            for (int i = 0; i < 4; i++) if (sqlite3_column_type(stmt, textColumns[i]) != SQLITE_NULL)
                row[keys[i]] = [NSString stringWithUTF8String:(const char *)sqlite3_column_text(stmt, textColumns[i]) ?: ""];
            row[@"aifstime_utc"] = stamp;
            row[@"product_id"] = product;
            int numericColumns[] = {0, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17};
            NSString *numericKeys[] = {@"wmo", @"lat", @"lon", @"air_temp", @"wind_dir_deg", @"wind_spd_kmh", @"gust_kmh", @"wind_spd_kt", @"gust_kt", @"press_msl", @"cloud_base_m", @"vis_km"};
            for (int i = 0; i < 12; i++) if (sqlite3_column_type(stmt, numericColumns[i]) != SQLITE_NULL)
                row[numericKeys[i]] = @(sqlite3_column_double(stmt, numericColumns[i]));
            NSMutableArray *rows = rowsByWMO[wmo] ?: [NSMutableArray array];
            [rows addObject:row];
            rowsByWMO[wmo] = rows;
        }
    }
    sqlite3_finalize(stmt);
    sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    sqlite3_close(db);
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    [rowsByWMO enumerateKeysAndObjectsUsingBlock:^(NSString *wmo, NSArray *rows, BOOL *stop) {
        (void)stop;
        NSString *product = rows.firstObject[@"product_id"] ?: @"";
        NSString *state = [product hasPrefix:@"IDN"] ? @"NSW" : [product hasPrefix:@"IDV"] ? @"VIC" : [product hasPrefix:@"IDQ"] ? @"QLD" : [product hasPrefix:@"IDS"] ? @"SA" : [product hasPrefix:@"IDT"] ? @"TAS" : [product hasPrefix:@"IDD"] ? @"NT" : @"WA";
        out[wmo] = Encode(@{@"observations": @{@"header": @[@{@"state_time_zone": state}], @"data": rows}});
    }];
    return out;
}

static double DistanceKM(double lat1, double lon1, double lat2, double lon2) {
    double r = M_PI / 180.0, a = sin((lat2-lat1)*r/2)*sin((lat2-lat1)*r/2) + cos(lat1*r)*cos(lat2*r)*sin((lon2-lon1)*r/2)*sin((lon2-lon1)*r/2);
    return 6371.0 * 2.0 * asin(sqrt(a));
}

static BOOL ValidCoordinate(double lat, double lon) {
    return isfinite(lat) && isfinite(lon) && lat >= -90.0 && lat <= 90.0 && lon >= -180.0 && lon <= 180.0;
}

static NSString *LatestRun(NSString *root, NSString *family, NSString *fallback) {
    NSString *base = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:family];
    NSString *expected = [family hasPrefix:@"products/"] ? [family substringFromIndex:[@"products/" length]] : family;
    NSDictionary *pointer = JSONForFamily([NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:@"current.json"]], expected);
    NSString *latest = [pointer[@"latest"] isKindOfClass:NSString.class] ? pointer[@"latest"] : nil;
    return SafeComponent(latest) ? latest : fallback;
}

NSDictionary *ArchiveAviationProduct(NSString *root, NSString *name) {
    if (!SafeComponent(name) || ![name.pathExtension isEqual:@"json"]) return nil;
    NSString *base = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:@"products/aviation"];
    NSString *pointerPath = [base stringByAppendingPathComponent:@"current.json"];
    if ([NSFileManager.defaultManager fileExistsAtPath:pointerPath]) {
        id latest = JSONForFamily([NSData dataWithContentsOfFile:pointerPath], @"aviation")[@"latest"];
        if (![latest isKindOfClass:NSString.class] || !SafeComponent(latest)) return nil;
        base = [[base stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:latest];
    }
    NSString *path = [base stringByAppendingPathComponent:name];
    NSMutableDictionary *product = [JSONForFamily([NSData dataWithContentsOfFile:path], @"aviation") mutableCopy];
    return product;
}

NSDictionary *ArchiveMarineProduct(NSString *root, NSString *spotID) {
    if (![spotID isKindOfClass:NSString.class] || !SafeComponent(spotID)) return nil;
    NSString *base = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:@"products/points/marine"];
    id run = JSONForFamily([NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:@"current.json"]], @"points/marine")[@"latest"];
    if (![run isKindOfClass:NSString.class] || !SafeComponent(run)) return nil;
    NSString *path = [[[base stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:run]
        stringByAppendingPathComponent:[spotID stringByAppendingString:@".json"]];
    NSDictionary *product = JSONForFamily([NSData dataWithContentsOfFile:path], @"points/marine");
    return [product[@"id"] isEqual:spotID] ? product : nil;
}

NSDictionary *ArchiveAtmosphereProduct(NSString *root, NSString *airportCode) {
    if (![airportCode isKindOfClass:NSString.class] || !SafeComponent(airportCode)) return nil;
    NSString *base = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:@"products/points/ecmwf_ifs025_upper"];
    id run = JSONForFamily([NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:@"current.json"]], @"points/ecmwf_ifs025_upper")[@"latest"];
    if (![run isKindOfClass:NSString.class] || !SafeComponent(run)) return nil;
    NSString *path = [[[base stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:run]
        stringByAppendingPathComponent:[airportCode stringByAppendingString:@".json"]];
    NSDictionary *product = JSONForFamily([NSData dataWithContentsOfFile:path], @"points/ecmwf_ifs025_upper");
    return [product[@"id"] isEqual:airportCode] ? product : nil;
}

NSData *ArchivePointFile(NSString *root, NSDictionary *place) {
    NSNumber *lat = place[@"latitude"], *lon = place[@"longitude"];
    if (![lat isKindOfClass:NSNumber.class] || ![lon isKindOfClass:NSNumber.class] || !ValidCoordinate(lat.doubleValue, lon.doubleValue)) return nil;
    NSString *family = @"products/points/ecmwf_ifs";
    NSString *run = LatestRun(root, family, nil);
    if (!run) return nil;
    NSString *dir = [[[root stringByExpandingTildeInPath] stringByAppendingPathComponent:family] stringByAppendingPathComponent:[@"runs" stringByAppendingPathComponent:run]];
    NSArray *names = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil];
    NSDictionary *best = nil;
    NSString *bestID = nil;
    double bestDistance = 30.0;
    for (NSString *name in names) {
        if (![name.pathExtension.lowercaseString isEqual:@"json"] || !SafeComponent(name.stringByDeletingPathExtension)) continue;
        NSDictionary *item = JSONForFamily([NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:name]], @"points/ecmwf_ifs");
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSNumber *a = item[@"latitude"], *b = item[@"longitude"];
        if (![a isKindOfClass:NSNumber.class] || ![b isKindOfClass:NSNumber.class] || !ValidCoordinate(a.doubleValue, b.doubleValue)) continue;
        double distance = DistanceKM(lat.doubleValue, lon.doubleValue, a.doubleValue, b.doubleValue);
        if (distance < bestDistance) { bestDistance = distance; best = item; bestID = name.stringByDeletingPathExtension; }
    }
    NSDictionary *units = [best[@"units"] isKindOfClass:NSDictionary.class] ? best[@"units"] : @{};
    NSString *speedUnit = units[@"wind_speed_10m"];
    if (![speedUnit isEqual:@"kn"] && ![speedUnit isEqual:@"knots"]) return nil;
    NSDictionary *hourly = [best[@"hourly"] isKindOfClass:NSDictionary.class] ? best[@"hourly"] : nil;
    NSDictionary *daily = [best[@"daily"] isKindOfClass:NSDictionary.class] ? best[@"daily"] : nil;
    NSArray *sunrise = daily[@"sunrise"], *sunset = daily[@"sunset"];
    NSArray *times = best[@"time"], *speed = hourly[@"wind_speed_10m"], *direction = hourly[@"wind_direction_10m"], *gust = hourly[@"wind_gusts_10m"];
    if (![times isKindOfClass:NSArray.class] || !times.count || ![speed isKindOfClass:NSArray.class] ||
        (direction && ![direction isKindOfClass:NSArray.class]) || (gust && ![gust isKindOfClass:NSArray.class])) return nil;
    NSString *gustUnit = units[@"wind_gusts_10m"];
    if (gust.count && ![gustUnit isEqual:@"kn"] && ![gustUnit isEqual:@"knots"]) return nil;
    NSMutableArray *hours = [NSMutableArray array];
    for (NSUInteger i = 0; i < times.count; i++) {
        if (![times[i] isKindOfClass:NSString.class]) continue;
        NSString *time = times[i];
        if (time.length < 16) continue;
        if ([time length] == 16) time = [time stringByAppendingString:@":00Z"];
        else if (![time hasSuffix:@"Z"] && ![time containsString:@"+"]) time = [time stringByAppendingString:@"Z"];
        NSMutableDictionary *row = [@{@"time": time} mutableCopy];
        BOOL isDay = NO;
        if ([sunrise isKindOfClass:NSArray.class] && [sunset isKindOfClass:NSArray.class]) {
            for (NSUInteger d = 0; d < sunrise.count && d < sunset.count; d++) {
                NSString *rise = sunrise[d], *set = sunset[d];
                if ([rise isKindOfClass:NSString.class] && [set isKindOfClass:NSString.class]) {
                    if (rise.length == 16) rise = [rise stringByAppendingString:@":00Z"];
                    if (set.length == 16) set = [set stringByAppendingString:@":00Z"];
                    isDay = [time compare:rise] != NSOrderedAscending && [time compare:set] != NSOrderedDescending;
                    if (isDay) break;
                }
            }
        }
        row[@"is_day"] = @(isDay);
        if (i < speed.count && [speed[i] isKindOfClass:NSNumber.class]) {
            double knots = [speed[i] doubleValue];
            if (!isfinite(knots) || knots < 0) return nil;
            row[@"wind_speed_kmh"] = @(knots * 1.852);
        }
        if (i < direction.count && [direction[i] isKindOfClass:NSNumber.class]) {
            double from = [direction[i] doubleValue];
            if (!isfinite(from) || from < 0 || from > 360) return nil;
            double degrees = fmod(from + 360.0, 360.0);
            NSArray *names = @[@"N", @"NNE", @"NE", @"ENE", @"E", @"ESE", @"SE", @"SSE", @"S", @"SSW", @"SW", @"WSW", @"W", @"WNW", @"NW", @"NNW"];
            row[@"wind_direction"] = names[(NSUInteger)llround(degrees / 22.5) % names.count];
            row[@"wind_from"] = @(from);
        }
        if (i < gust.count && [gust[i] isKindOfClass:NSNumber.class]) {
            double knots = [gust[i] doubleValue];
            if (!isfinite(knots) || knots < 0) return nil;
            row[@"wind_gust_kmh"] = @(knots * 1.852);
        }
        NSDictionary *legacyKeys = @{@"temperature_2m": @"temp", @"precipitation": @"rain_mm", @"weather_code": @"weather_code", @"temperature_850hPa": @"t850", @"pressure_msl": @"pressure_msl", @"visibility": @"visibility_m", @"cloud_base_ft": @"cloud_base_ft"};
        for (NSString *key in legacyKeys) {
            NSArray *values = hourly[key];
            if ([values isKindOfClass:NSArray.class] && i < values.count && [values[i] isKindOfClass:NSNumber.class]) row[legacyKeys[key]] = values[i];
        }
        [hours addObject:row];
    }
    return Encode(@{@"hourly": hours, @"_archive": @{@"run": run, @"distance_km": @(bestDistance), @"point": bestID ?: NSNull.null}});
}

static NSString *GeoHash(double lat, double lon) {
    static NSString *alphabet = @"0123456789bcdefghjkmnpqrstuvwxyz";
    NSMutableString *out = [NSMutableString string]; BOOL even = YES; int bit = 0, ch = 0; double latLo=-90,latHi=90,lonLo=-180,lonHi=180;
    while (out.length < 7) { double mid = even ? (lonLo+lonHi)/2 : (latLo+latHi)/2; double value = even ? lon : lat; if (value >= mid) { ch = (ch<<1)|1; if (even) lonLo=mid; else latLo=mid; } else { ch <<= 1; if (even) lonHi=mid; else latHi=mid; } even=!even; if (++bit==5) { [out appendFormat:@"%@", [alphabet substringWithRange:NSMakeRange(ch,1)]]; bit=0; ch=0; } }
    return out;
}

NSData *ArchiveKiteFile(NSString *root) {
    NSString *family = @"products/kite"; NSString *run = LatestRun(root, family, nil); if (!run) return nil;
    NSString *base = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:family];
    NSString *dir = [base stringByAppendingPathComponent:[@"runs" stringByAppendingPathComponent:run]];
    NSString *pointRun = LatestRun(root, @"products/points/ecmwf_ifs", nil);
    if (!pointRun) return nil;
    NSString *pointDir = [[[[root stringByExpandingTildeInPath] stringByAppendingPathComponent:@"products/points/ecmwf_ifs"] stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:pointRun];
    NSMutableArray *spots = [NSMutableArray array];
    NSNumber *rootMin = nil, *rootMax = nil;
    for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
        if (![name.pathExtension.lowercaseString isEqual:@"json"] || !SafeComponent(name.stringByDeletingPathExtension)) continue;
        NSDictionary *item = JSONForFamily([NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:name]], @"kite"); if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *id = [item[@"id"] isKindOfClass:NSString.class] ? item[@"id"] : name.stringByDeletingPathExtension;
        if (!SafeComponent(id)) continue;
        NSString *pointPath = [pointDir stringByAppendingPathComponent:[id stringByAppendingString:@".json"]];
        NSDictionary *point = JSONForFamily([NSData dataWithContentsOfFile:pointPath], @"points/ecmwf_ifs"); NSNumber *lat = point[@"latitude"], *lon = point[@"longitude"];
        NSDictionary *thresholds = [item[@"thresholds"] isKindOfClass:NSDictionary.class] ? item[@"thresholds"] : @{};
        NSNumber *shore = item[@"onshore_from_deg"]; if (![lat isKindOfClass:NSNumber.class] || ![lon isKindOfClass:NSNumber.class] || !ValidCoordinate(lat.doubleValue, lon.doubleValue) || ![shore isKindOfClass:NSNumber.class] || shore.doubleValue < 0 || shore.doubleValue > 360) continue;
        NSString *friendly = [id isEqual:@"cottesloe"] ? @"Cottesloe" : [id isEqual:@"safety-bay"] ? @"Safety Bay" : id.capitalizedString;
        NSMutableDictionary *spot = [@{@"archiveID": id, @"name": friendly, @"geohash": GeoHash(lat.doubleValue, lon.doubleValue), @"latitude": lat, @"longitude": lon, @"shoreNormal": shore, @"stationName": friendly, @"state": @"WA", @"timezone": @"Australia/Perth"} mutableCopy];
        spot[@"minKt"] = thresholds[@"speed_min_kt"] ?: @15; spot[@"maxKt"] = thresholds[@"speed_max_kt"] ?: @30;
        if (!rootMin) rootMin = spot[@"minKt"];
        if (!rootMax) rootMax = spot[@"maxKt"];
        [spots addObject:spot];
    }
    return Encode(@{@"minKt": rootMin ?: @15, @"maxKt": rootMax ?: @30, @"spots": spots, @"_archive": @{@"run": run, @"point_run": pointRun}});
}
