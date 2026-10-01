#import <AppKit/AppKit.h>
#import "ownrender.h"
#import "archive.h"
#import "pure.h"
#import "surfview.h"
#import "rawmovie.h"

// Explicit public export: model maps plus the configured surface points.
// Maps stay on the published grid horizon (nine frames, 12 h apart, 96 h).
// Each point keeps hourly values through seven days and its daily summary.
// Never walk/copy the archive, its observations, briefings or user settings.
static BOOL PNG(NSImage *image, NSString *path) {
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
    return [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
}
static id Number(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID() && isfinite([value doubleValue]) ? value : NSNull.null;
}
static const NSTimeInterval kPointPast = 3600;
static const NSTimeInterval kPointHorizon = 168 * 3600;
// Place names and zones match config/isobar.toml. A product without an IANA
// timezone falls back to this table; unknown ids are not published.
static NSDictionary *PlaceTable(void) {
    return @{
        @"cottesloe": @{@"name": @"Perth", @"timezone": @"Australia/Perth"},
        @"yssy": @{@"name": @"Sydney", @"timezone": @"Australia/Sydney"},
        @"safety-bay": @{@"name": @"Safety Bay", @"timezone": @"Australia/Perth"},
        @"rottnest": @{@"name": @"Rottnest", @"timezone": @"Australia/Perth"},
        @"perth-airport": @{@"name": @"Perth Airport", @"timezone": @"Australia/Perth"},
        @"garden-island": @{@"name": @"Garden Island", @"timezone": @"Australia/Perth"},
    };
}
static NSDictionary *JSONDict(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    id value = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![value isKindOfClass:NSDictionary.class]) return nil;
    id contract = value[@"contract"], version = value[@"schema_version"];
    if (contract && (![contract isKindOfClass:NSString.class] || ![contract isEqual:@"isobar-data"])) return nil;
    if (version && (![version isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID() || [version integerValue] != 1)) return nil;
    return value;
}
static BOOL SafeID(NSString *value) {
    return [value isKindOfClass:NSString.class] && value.length && ![value containsString:@"/"] && ![value containsString:@".."] && ![value hasPrefix:@"."];
}
static NSDate *GMTDate(NSString *text) {
    if (![text isKindOfClass:NSString.class] || text.length < 16) return nil;
    NSString *stamp = text;
    if ([text length] == 16) stamp = [text stringByAppendingString:@":00Z"];
    else if ([text length] == 19 && [text characterAtIndex:10] == 'T') stamp = [text stringByAppendingString:@"Z"];
    NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithColonSeparatorInTimeZone;
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    return [formatter dateFromString:stamp];
}
static NSString *PlaceZone(NSString *pointID, NSDictionary *product) {
    id zone = product[@"timezone"];
    if ([zone isKindOfClass:NSString.class] && [zone containsString:@"/"] && ![zone hasPrefix:@"Etc/"]) return zone;
    return PlaceTable()[pointID][@"timezone"] ?: @"Australia/Perth";
}
static id At(NSArray *values, NSUInteger index) {
    return [values isKindOfClass:NSArray.class] && index < values.count ? values[index] : nil;
}
static BOOL UnitIs(NSDictionary *units, NSString *key, NSArray *allowed) {
    id value = units[key];
    return [value isKindOfClass:NSString.class] && [allowed containsObject:value];
}
static NSArray *DailyRows(NSDictionary *product) {
    NSDictionary *daily = [product[@"daily"] isKindOfClass:NSDictionary.class] ? product[@"daily"] : nil;
    NSArray *dates = [daily[@"time"] isKindOfClass:NSArray.class] ? daily[@"time"] : nil;
    if (!dates.count || dates.count > 8) return @[];
    NSMutableArray *rows = [NSMutableArray array];
    for (NSUInteger i = 0; i < dates.count; i++) {
        if (![dates[i] isKindOfClass:NSString.class] || [dates[i] length] != 10) continue;
        id (^clock)(NSString *) = ^id(NSString *key) {
            id value = At(daily[key], i);
            if (![value isKindOfClass:NSString.class] || ![value length]) return NSNull.null;
            return [value length] == 16 ? [value stringByAppendingString:@":00Z"] : value;
        };
        [rows addObject:@{
            @"time": dates[i],
            @"tempMax": Number(At(daily[@"temperature_2m_max"], i)),
            @"tempMin": Number(At(daily[@"temperature_2m_min"], i)),
            @"rain": Number(At(daily[@"precipitation_sum"], i)),
            @"rainHours": Number(At(daily[@"precipitation_hours"], i)),
            @"weatherCode": Number(At(daily[@"weather_code"], i)),
            @"windMax": Number(At(daily[@"wind_speed_10m_max"], i)),
            @"gustMax": Number(At(daily[@"wind_gusts_10m_max"], i)),
            @"windFrom": Number(At(daily[@"wind_direction_10m_dominant"], i)),
            @"sunrise": clock(@"sunrise"),
            @"sunset": clock(@"sunset"),
        }];
    }
    return rows;
}
static NSDictionary *PlacePayload(NSString *root, NSString *pointID, NSDictionary *product, NSDate *now, NSISO8601DateFormatter *iso) {
    NSDictionary *known = PlaceTable()[pointID];
    if (!known) return nil;
    NSDictionary *units = [product[@"units"] isKindOfClass:NSDictionary.class] ? product[@"units"] : @{};
    NSDictionary *hourly = [product[@"hourly"] isKindOfClass:NSDictionary.class] ? product[@"hourly"] : nil;
    NSArray *times = [product[@"time"] isKindOfClass:NSArray.class] ? product[@"time"] : nil;
    if (!hourly || !times.count) return nil;
    if (!UnitIs(units, @"wind_speed_10m", @[@"kn", @"knots"])) return nil;
    if (hourly[@"wind_gusts_10m"] && !UnitIs(units, @"wind_gusts_10m", @[@"kn", @"knots"])) return nil;
    if (hourly[@"temperature_2m"] && units[@"temperature_2m"] && !UnitIs(units, @"temperature_2m", @[@"°C"])) return nil;
    if (hourly[@"precipitation"] && units[@"precipitation"] && !UnitIs(units, @"precipitation", @[@"mm"])) return nil;
    NSDictionary *marine = SurfOutlook(ArchiveMarineProduct(root, pointID), now);
    NSMutableDictionary *seaByTime = [NSMutableDictionary dictionary];
    for (NSDictionary *row in marine[@"rows"]) if ([row[@"time"] isKindOfClass:NSDate.class]) seaByTime[row[@"time"]] = row;
    NSMutableArray *hours = [NSMutableArray array];
    for (NSUInteger i = 0; i < times.count; i++) {
        NSDate *time = GMTDate(times[i]);
        if (!time || [time timeIntervalSinceDate:now] < -kPointPast || [time timeIntervalSinceDate:now] > kPointHorizon) continue;
        NSDictionary *sea = nil;
        for (NSDate *key in seaByTime) if (fabs([key timeIntervalSinceDate:time]) < 1) { sea = seaByTime[key]; break; }
        sea = sea ?: @{};
        [hours addObject:@{
            @"time": [iso stringFromDate:time],
            @"temp": Number(At(hourly[@"temperature_2m"], i)),
            @"rain": Number(At(hourly[@"precipitation"], i)),
            @"windKt": Number(At(hourly[@"wind_speed_10m"], i)),
            @"gustKt": Number(At(hourly[@"wind_gusts_10m"], i)),
            @"windFrom": Number(At(hourly[@"wind_direction_10m"], i)),
            @"weatherCode": Number(At(hourly[@"weather_code"], i)),
            @"waveHeight": Number(sea[@"waveHeight"]),
            @"swellPeriod": Number(sea[@"swellPeriod"]),
            @"swellFrom": Number(sea[@"swellFrom"]),
        }];
    }
    return @{@"id": pointID, @"name": known[@"name"], @"timezone": PlaceZone(pointID, product),
        @"latitude": Number(product[@"latitude"]), @"longitude": Number(product[@"longitude"]),
        @"hours": hours, @"daily": DailyRows(product)};
}
static NSUInteger FiniteCount(NSArray *hours, NSString *field) {
    NSUInteger count = 0;
    for (NSDictionary *hour in hours) if (Number(hour[field]) != NSNull.null) count++;
    return count;
}
int main(int argc, const char *argv[]) { @autoreleasepool {
    if(argc!=4) { fprintf(stderr,"usage: export-site ARCHIVE OUTPUT COAST\n"); return 2; }
    NSString *root=[NSString stringWithUTF8String:argv[1]], *out=[NSString stringWithUTF8String:argv[2]];
    NSString *error=nil;
    OwnRun *run=OwnRunLoadPublished(root,NO,[NSString stringWithUTF8String:argv[3]],&error);
    if(!run || run.hours<2) { fprintf(stderr,"No complete model run: %s\n",error.UTF8String); return 1; }
    NSISO8601DateFormatter *iso=[NSISO8601DateFormatter new];
    NSDate *now=NSDate.date;
    NSString *generation=[NSString stringWithFormat:@"frames-%lld",(long long)now.timeIntervalSince1970];
    NSString *framesDir=[out stringByAppendingPathComponent:generation];
    NSError *failure=nil;
    if(![NSFileManager.defaultManager createDirectoryAtPath:framesDir withIntermediateDirectories:YES attributes:nil error:&failure]) return 1;
    NSMutableArray *frames=[NSMutableArray array];
    NSInteger start=0;
    for(NSInteger i=1;i<run.hours;i++) if([[run timeAtIndex:i] compare:now] != NSOrderedDescending) start=i;
    NSDate *previous=nil;
    for(NSInteger i=start;i<run.hours && frames.count<9;i++) { @autoreleasepool {
        NSDate *valid=[run timeAtIndex:i];
        if(previous && [valid timeIntervalSinceDate:previous]<12*3600 && i != run.hours-1) continue;
        if([valid timeIntervalSinceDate:now]>96*3600) break;
        NSMutableDictionary *maps=[NSMutableDictionary dictionary];
        for(NSString *kind in @[@"pressure",@"temperature",@"rain",@"wind"]) {
            if([kind isEqual:@"rain"] && ![run hasRainAtIndex:i]) continue;
            OwnLayerOptions layer={.bare=1,.temperature=[kind isEqual:@"temperature"]?2:0,.barbs=[kind isEqual:@"wind"],.rain=[kind isEqual:@"rain"]};
            NSString *name=[NSString stringWithFormat:@"%lu-%@.png",(unsigned long)frames.count,kind];
            NSImage *image=OwnRunRender(run,i,@"",layer,@[],2);
            if(!image || !PNG(image,[framesDir stringByAppendingPathComponent:name])) return 1;
            maps[kind]=[generation stringByAppendingPathComponent:name];
        }
        [frames addObject:@{@"time":[iso stringFromDate:valid],@"maps":maps}]; previous=valid;
    }}
    if(frames.count<2) { fprintf(stderr,"Insufficient forecast coverage\n"); return 1; }
    // Perth (cottesloe) and Sydney (yssy) are required. Other configured surface
    // points are included when the latest run published them.
    NSString *pointRoot=[root stringByAppendingPathComponent:@"products/points/ecmwf_ifs"];
    NSDictionary *pointer=JSONDict([pointRoot stringByAppendingPathComponent:@"current.json"]);
    NSString *pointRun=[pointer[@"latest"] isKindOfClass:NSString.class] && SafeID(pointer[@"latest"]) ? pointer[@"latest"] : nil;
    NSString *pointDir=pointRun ? [[pointRoot stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:pointRun] : nil;
    NSArray *pointNames=pointDir ? [NSFileManager.defaultManager contentsOfDirectoryAtPath:pointDir error:nil] : @[];
    NSMutableArray *places=[NSMutableArray array];
    for (NSString *name in pointNames) {
        if (![name.pathExtension.lowercaseString isEqual:@"json"]) continue;
        NSString *pointID=name.stringByDeletingPathExtension;
        if (!PlaceTable()[pointID] || !SafeID(pointID)) continue;
        NSDictionary *product=JSONDict([pointDir stringByAppendingPathComponent:name]);
        id family=product[@"family"];
        if (family && ![family isEqual:@"points/ecmwf_ifs"]) continue;
        if (product[@"id"] && ![product[@"id"] isEqual:pointID]) continue;
        NSDictionary *place=PlacePayload(root, pointID, product, now, iso);
        if (!place) { fprintf(stderr,"Unusable surface point %s\n", pointID.UTF8String); return 1; }
        [places addObject:place];
    }
    [places sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        NSDictionary *rank=@{@"cottesloe": @0, @"yssy": @1};
        NSNumber *ar=rank[a[@"id"]] ?: @9, *br=rank[b[@"id"]] ?: @9;
        NSComparisonResult order=[ar compare:br];
        return order == NSOrderedSame ? [a[@"name"] compare:b[@"name"]] : order;
    }];
    NSDictionary *perth=nil, *sydney=nil;
    for (NSDictionary *place in places) {
        if ([place[@"id"] isEqual:@"cottesloe"]) perth=place;
        if ([place[@"id"] isEqual:@"yssy"]) sydney=place;
    }
    if (!perth || !sydney) { fprintf(stderr,"Perth and Sydney surface points are required\n"); return 1; }
    // A refresh must keep the public views usable. A missing series must not
    // replace the previous site with an apparently healthy empty graph.
    for (NSDictionary *place in places) {
        for (NSString *field in @[@"temp", @"rain", @"windKt"]) {
            NSUInteger available=FiniteCount(place[@"hours"], field);
            if (available < 24) { fprintf(stderr,"Insufficient coverage for %s %s (%lu hours)\n", [place[@"id"] UTF8String], field.UTF8String, (unsigned long)available); return 1; }
        }
        if ([place[@"id"] isEqual:@"cottesloe"] && FiniteCount(place[@"hours"], @"waveHeight") < 24) {
            fprintf(stderr,"Insufficient coastal coverage for waveHeight (%lu hours)\n", (unsigned long)FiniteCount(place[@"hours"], @"waveHeight")); return 1;
        }
        if ([place[@"daily"] count] < 7) { fprintf(stderr,"Surface point %s is missing its 7-day summary\n", [place[@"id"] UTF8String]); return 1; }
    }
    NSMutableDictionary *manifest=[@{@"schemaVersion":@2,@"updatedAt":[iso stringFromDate:now],@"runAt":[iso stringFromDate:run.runDate],
        @"source":@"ECMWF",@"frames":frames,@"places":places,
        @"points":@{@"place":@"Perth",@"id":@"cottesloe",@"timezone":perth[@"timezone"],@"hours":perth[@"hours"],@"daily":perth[@"daily"]},
        @"units":@{@"temp":@"°C",@"rain":@"mm / preceding hour",@"windKt":@"kt",@"gustKt":@"kt",@"windFrom":@"degrees from north",@"waveHeight":@"m",@"swellPeriod":@"s",@"swellFrom":@"degrees from north",@"mapRain":@"mm / preceding 24 hours"},
        @"attribution":@[@{@"label":@"ECMWF · CC BY 4.0",@"url":@"https://www.ecmwf.int/en/forecasts/datasets/open-data"},
            @{@"label":@"Open-Meteo · CC BY 4.0",@"url":@"https://open-meteo.com/"},
            @{@"label":@"Natural Earth",@"url":@"https://www.naturalearthdata.com/"}]} mutableCopy];
    // Playback of the published grid (about four days) in 24 s. Quality is
    // VideoToolbox's 0–1 scale. 0.42 stays under 6 MB at 1160×888; the checker
    // rejects anything over 10 MB.
    const NSInteger movieFPS = 24;
    const double movieSeconds = 24;
    IsobarMovieEncode encode = {.quality = 0.42, .keyframeInterval = movieFPS, .highProfile = YES};
    NSMutableDictionary *animations=[NSMutableDictionary dictionary];
    for(NSString *kind in @[@"pressure",@"temperature",@"rain",@"wind"]) { @autoreleasepool {
        OwnLayerOptions layer={.bare=1,.temperature=[kind isEqual:@"temperature"]?2:0,.barbs=[kind isEqual:@"wind"],.rain=[kind isEqual:@"rain"]};
        NSString *name=[kind stringByAppendingPathExtension:@"mp4"];
        NSURL *movie=[NSURL fileURLWithPath:[framesDir stringByAppendingPathComponent:name]];
        NSInteger frames=(NSInteger)llround(movieSeconds * movieFPS);
        NSProgress *progress=[NSProgress progressWithTotalUnitCount:frames];
        fprintf(stderr,"Preparing %s animation…\n",kind.UTF8String);
        if(!IsobarWriteRawMovieWithEncode(run,movie,start,run.hours-1,movieFPS,movieSeconds,layer,encode,progress,&error)) {
            fprintf(stderr,"Animation export failed: %s\n",error.UTF8String); return 1;
        }
        unsigned long long bytes=[[[NSFileManager.defaultManager attributesOfItemAtPath:movie.path error:nil] objectForKey:NSFileSize] unsignedLongLongValue];
        fprintf(stderr,"%s animation %llu bytes\n",kind.UTF8String,bytes);
        animations[kind]=@{@"src":[generation stringByAppendingPathComponent:name],@"layer":kind,
            @"durationSeconds":@(movieSeconds),@"fps":@(movieFPS),@"validFrom":[iso stringFromDate:[run timeAtIndex:start]],
            @"validTo":[iso stringFromDate:[run timeAtIndex:run.hours-1]],@"forecastRun":[iso stringFromDate:run.runDate]};
    }}
    manifest[@"animations"]=animations;
    // Release information is authored separately, never guessed from a tag.
    NSData *releaseData=[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"release.json"]];
    id release=releaseData?[NSJSONSerialization JSONObjectWithData:releaseData options:0 error:nil]:nil;
    if([release isKindOfClass:NSDictionary.class]) manifest[@"release"]=release;
    NSData *json=[NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:&failure];
    if(!json || ![json writeToFile:[out stringByAppendingPathComponent:@"current.json"] options:NSDataWritingAtomic error:&failure]) return 1;
    printf("Exported %lu maps and %lu places (%lu Perth hours)\n",(unsigned long)frames.count,(unsigned long)places.count,(unsigned long)[perth[@"hours"] count]);
    return 0;
}}
