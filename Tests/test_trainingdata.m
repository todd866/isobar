#import <Cocoa/Cocoa.h>
#import "trainingdata.h"

static int failures;
static void Check(BOOL ok, NSString *why) {
    if (!ok) { fprintf(stderr, "FAIL %s\n", why.UTF8String); failures++; }
}

static NSString *GridStamp(NSDate *date, NSString *format) {
    NSDateFormatter *formatter = [NSDateFormatter new];
    formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    formatter.dateFormat = format;
    return [formatter stringFromDate:date];
}

static NSString *GridRunID(NSDate *date) { return GridStamp(date, @"yyyyMMdd'T'HH'Z'"); }

static uint16_t HalfFloat(float value) {
    uint32_t bits;
    memcpy(&bits, &value, sizeof bits);
    uint32_t sign = (bits >> 16) & 0x8000;
    int32_t exponent = (int32_t)((bits >> 23) & 0xff) - 127 + 15;
    uint32_t mantissa = bits & 0x7fffff;
    if (exponent <= 0) return (uint16_t)sign;
    if (exponent >= 31) return (uint16_t)(sign | 0x7c00);
    return (uint16_t)(sign | ((uint32_t)exponent << 10) | (mantissa >> 13));
}

// A small, valid published regional run keeps the fail-closed test independent
// of the repository's legacy fixture while exercising the AU coast path.
static void WritePublishedAU(NSString *root, NSDate *run) {
    const int nx = 24, ny = 16, frames = 33;
    NSArray *variables = @[
        @[ @"mslp", @"msl", @"hPa", @1012 ], @[ @"t850", @"t", @"degC", @14 ],
        @[ @"t2m", @"2t", @"degC", @14 ], @[ @"u10", @"10u", @"m/s", @3 ],
        @[ @"v10", @"10v", @"m/s", @2 ], @[ @"tp", @"tp", @"mm", @0 ]
    ];
    NSFileManager *fm = NSFileManager.defaultManager;
    size_t points = (size_t)nx * (size_t)ny;
    NSMutableData *payload = [NSMutableData dataWithLength:points * sizeof(uint16_t)];
    NSString *runID = GridRunID(run);
    for (NSArray *variable in variables) {
        NSString *name = variable[0];
        NSString *dir = [root stringByAppendingFormat:@"/products/grids/ecmwf_ifs025/runs/%@/%@", runID, name];
        [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        uint16_t encoded = HalfFloat([variable[3] floatValue]);
        for (int frame = 0; frame < frames; frame++) {
            uint16_t *values = payload.mutableBytes;
            for (size_t i = 0; i < points; i++) values[i] = encoded;
            NSDate *valid = [run dateByAddingTimeInterval:frame * 3 * 3600.0];
            NSString *stem = [dir stringByAppendingPathComponent:GridRunID(valid)];
            [payload writeToFile:[stem stringByAppendingPathExtension:@"f16"] atomically:YES];
            NSDictionary *sidecar = @{
                @"lat0": @0, @"lon0": @95, @"dlat": @-0.25, @"dlon": @0.25,
                @"ny": @(ny), @"nx": @(nx), @"units": variable[2],
                @"run": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"valid_time": GridStamp(valid, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"model": @"ecmwf-ifs-0p25-open-data", @"fill": @-32768,
                @"native_step_hours": @3, @"order": @"north-to-south, west-to-east",
                @"dtype": @"float16", @"endian": @"little", @"param": variable[1]
            };
            NSData *json = [NSJSONSerialization dataWithJSONObject:sidecar options:0 error:nil];
            [json writeToFile:[stem stringByAppendingPathExtension:@"json"] atomically:YES];
        }
    }
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [fm createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
    NSDictionary *pointer = @{@"latest": runID, @"runs": @[runID]};
    NSData *json = [NSJSONSerialization dataWithJSONObject:pointer options:0 error:nil];
    [json writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
}

static NSDictionary *Airport(NSDictionary *snapshot, NSString *icao) {
    for (NSDictionary *item in snapshot[@"airports"])
        if ([item[@"icao"] isEqual:icao]) return item;
    return nil;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *root = [[[NSFileManager.defaultManager currentDirectoryPath]
            stringByAppendingPathComponent:@"Tests/fixtures/store"] stringByStandardizingPath];
        NSString *coast = [[[NSFileManager.defaultManager currentDirectoryPath]
            stringByAppendingPathComponent:@"Resources/ownchart-coast.bin"] stringByStandardizingPath];
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        NSDate *now = [iso dateFromString:@"2026-09-26T00:30:00Z"];
        NSDictionary *snapshot = TrainingSnapshot(root, now, coast);
        Check([snapshot[@"now"] isEqual:@"2026-09-26T00:30:00Z"], @"snapshot now");
        Check([snapshot[@"runTime"] isEqual:@"2026-09-25T18:00:00Z"],
            [NSString stringWithFormat:@"run time %@", snapshot[@"runTime"]]);
        Check([snapshot[@"gridSource"] isEqual:@"legacy"], @"fixture uses the legacy grid");
        Check([snapshot[@"sampleTime"] isEqual:@"2026-09-26T00:00:00Z"],
            [NSString stringWithFormat:@"sample time %@", snapshot[@"sampleTime"]]);
        Check(snapshot[@"sigmets"] == NSNull.null, @"fixture has no SIGMET product");
        Check(snapshot[@"notamCount"] == NSNull.null, @"fixture has no NOTAM product");
        NSDictionary *sydney = Airport(snapshot, @"YSSY");
        NSDictionary *perth = Airport(snapshot, @"YPPH");
        NSDictionary *adelaide = Airport(snapshot, @"YPAD");
        Check([sydney[@"metar"][@"raw"] containsString:@"METAR YSSY"], @"Sydney METAR");
        Check([perth[@"metar"][@"raw"] containsString:@"METAR YPPH"], @"Perth METAR");
        Check(adelaide[@"metar"] == NSNull.null && adelaide[@"taf"] == NSNull.null, @"Adelaide stays missing");
        Check([sydney[@"taf"][@"raw"] containsString:@"TAF YSSY"], @"Sydney TAF");
        Check([sydney[@"taf"][@"lines"] count] > 0, @"Sydney TAF lines");
        NSDictionary *sample = sydney[@"sample"];
        double mslp = [sample[@"mslpHpa"] doubleValue];
        Check([sample[@"mslpHpa"] isKindOfClass:NSNumber.class] && mslp > 900 && mslp < 1050,
            [NSString stringWithFormat:@"Sydney MSLP %@", sample[@"mslpHpa"]]);
        Check(sample[@"cloudCoverPct"] == NSNull.null && sample[@"mucapeJkg"] == NSNull.null,
            @"legacy grid has no cloud or MUCAPE");
        Check([sample[@"windKt"] isKindOfClass:NSNumber.class], @"Sydney wind");
        NSDictionary *gradient = snapshot[@"gradient"];
        Check([gradient isKindOfClass:NSDictionary.class], @"gradient");
        double glat = [gradient[@"lat"] doubleValue];
        double glon = [gradient[@"lon"] doubleValue];
        Check(glat <= -30.0 && glat >= -43.0 && glon >= 112.0 && glon <= 155.0,
            [NSString stringWithFormat:@"gradient window %@ %@", gradient[@"lat"], gradient[@"lon"]]);
        double gkt = [gradient[@"geostrophicKt"] doubleValue];
        Check([gradient[@"geostrophicKt"] isKindOfClass:NSNumber.class] && gkt > 0 && gkt < 250,
            [NSString stringWithFormat:@"screened geostrophic %@", gradient[@"geostrophicKt"]]);
        Check(snapshot[@"artefact"] == NSNull.null || [snapshot[@"artefact"] isKindOfClass:NSDictionary.class], @"artefact");
        Check([snapshot[@"points"] count] == 3, @"route samples");
        NSString *png = snapshot[@"chartPng"];
        NSData *chart = [png isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:png options:0] : nil;
        Check(chart.length > 1000, @"chart PNG");

        NSString *globalRoot = [[[NSFileManager.defaultManager currentDirectoryPath]
            stringByAppendingPathComponent:@"build/global-archive"] stringByStandardizingPath];
        if ([NSFileManager.defaultManager fileExistsAtPath:globalRoot isDirectory:nil]) {
            NSDictionary *world = TrainingSnapshot(globalRoot, now, coast);
            Check([world[@"gridSource"] isEqual:@"published"], @"global archive selects published cycle");
            NSData *pointerData = [NSData dataWithContentsOfFile:[globalRoot stringByAppendingPathComponent:@"products/grids/ecmwf_ifs_global/current.json"]];
            NSDictionary *pointer = [NSJSONSerialization JSONObjectWithData:pointerData ?: [NSData data] options:0 error:nil];
            NSDateFormatter *runFormatter = [NSDateFormatter new];
            runFormatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
            runFormatter.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
            runFormatter.dateFormat = @"yyyyMMdd'T'HH'Z'";
            NSString *expectedRunTime = [iso stringFromDate:[runFormatter dateFromString:pointer[@"latest"]]];
            Check([world[@"runTime"] isEqual:expectedRunTime], [NSString stringWithFormat:@"global archive follows authoritative cycle (%@ vs %@)", world[@"runTime"], expectedRunTime]);
            NSDictionary *worldSydney = Airport(world, @"YSSY");
            Check([worldSydney[@"sample"][ @"mslpHpa"] isKindOfClass:NSNumber.class], @"global archive samples AU lesson airport");
            for (NSDictionary *airport in world[@"airports"]) {
                for (NSString *key in @[ @"cloudCoverPct", @"mucapeJkg" ]) {
                    id value = airport[@"sample"][key];
                    if ([value isKindOfClass:NSNumber.class]) Check(isfinite([value doubleValue]), [NSString stringWithFormat:@"global %@ is finite", key]);
                }
            }
        }

        NSString *invalidRoot = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"isobar-training-invalid-global-%@", NSUUID.UUID.UUIDString]];
        [NSFileManager.defaultManager removeItemAtPath:invalidRoot error:nil];
        [NSFileManager.defaultManager createDirectoryAtPath:invalidRoot withIntermediateDirectories:YES attributes:nil error:nil];
        NSDate *publishedRun = [iso dateFromString:@"2026-09-25T18:00:00Z"];
        WritePublishedAU(invalidRoot, publishedRun);
        NSDictionary *workingPublished = TrainingSnapshot(invalidRoot, now, coast);
        Check([workingPublished[@"gridSource"] isEqual:@"published"] &&
              [workingPublished[@"runTime"] isEqual:@"2026-09-25T18:00:00Z"],
              @"temporary published AU fixture works");
        NSString *globalDir = [invalidRoot stringByAppendingPathComponent:@"products/grids/ecmwf_ifs_global"];
        [NSFileManager.defaultManager createDirectoryAtPath:globalDir withIntermediateDirectories:YES attributes:nil error:nil];
        NSData *invalidPointer = [NSJSONSerialization dataWithJSONObject:@{ @"latest": @"not-a-real-run" } options:0 error:nil];
        [invalidPointer writeToFile:[globalDir stringByAppendingPathComponent:@"current.json"] atomically:YES];
        NSDictionary *invalid = TrainingSnapshot(invalidRoot, now, coast);
        Check(invalid[@"gridSource"] == NSNull.null && invalid[@"runError"] != NSNull.null,
            @"invalid global pointer fails closed without regional fallback");
        [NSFileManager.defaultManager removeItemAtPath:invalidRoot error:nil];

        NSString *progress = [NSTemporaryDirectory() stringByAppendingPathComponent:@"isobar-training-test.json"];
        [NSFileManager.defaultManager removeItemAtPath:progress error:nil];
        NSData *good = [NSJSONSerialization dataWithJSONObject:@{@"version": @1, @"cards": @{}, @"streak": @{@"count": @0, @"lastDay": NSNull.null}} options:0 error:nil];
        NSString *writeError = nil;
        Check(TrainingProgressWrite(progress, good, &writeError), writeError ?: @"progress write");
        NSData *read = TrainingProgressRead(progress);
        id decoded = [NSJSONSerialization JSONObjectWithData:read ?: [NSData data] options:0 error:nil];
        Check([decoded[@"version"] isEqual:@1] && [decoded[@"cards"] isKindOfClass:NSDictionary.class], @"progress round trip");
        NSData *bad = [@"[]" dataUsingEncoding:NSUTF8StringEncoding];
        Check(!TrainingProgressWrite(progress, bad, &writeError), @"reject a non-object");
        Check(!TrainingProgressWrite(progress, [NSJSONSerialization dataWithJSONObject:@{@"version": @2, @"cards": @{}} options:0 error:nil], &writeError),
            @"reject another version");
        [NSFileManager.defaultManager removeItemAtPath:progress error:nil];
        Check(TrainingProgressRead(progress) == nil, @"missing progress reads as nothing");
        if (failures) return 1;
        printf("trainingdata ok\n");
        return 0;
    }
}
