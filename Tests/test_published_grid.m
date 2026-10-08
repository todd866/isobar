#import "ownrender.h"
#import <Foundation/Foundation.h>
#import <math.h>

static int failures = 0;
static void check(BOOL value, NSString *message) {
    fprintf(stderr, "%s %s\n", value ? "ok  " : "FAIL", message.UTF8String);
    if (!value) failures++;
}
static NSString *RunDateString(NSString *runID, int lead) {
    NSDateFormatter *in = [NSDateFormatter new];
    in.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    in.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    in.dateFormat = @"yyyyMMdd'T'HH'Z'";
    NSDate *date = [in dateFromString:runID];
    NSDateFormatter *out = [NSDateFormatter new];
    out.locale = in.locale; out.timeZone = in.timeZone; out.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss'Z'";
    return [out stringFromDate:[date dateByAddingTimeInterval:lead * 3600]];
}
static NSString *RunID(NSString *runID, int lead) {
    NSDateFormatter *in = [NSDateFormatter new];
    in.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    in.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0]; in.dateFormat = @"yyyyMMdd'T'HH'Z'";
    NSDate *date = [in dateFromString:runID];
    NSDateFormatter *out = [NSDateFormatter new];
    out.locale = in.locale; out.timeZone = in.timeZone; out.dateFormat = @"yyyyMMdd'T'HH'Z'";
    return [out stringFromDate:[date dateByAddingTimeInterval:lead * 3600]];
}
static void WriteField(NSString *root, NSString *run, NSString *var, NSString *param,
    NSString *units, int lead, float base, NSArray<NSNumber *> *values, BOOL corrupt) {
    NSString *valid = RunID(run, lead);
    NSString *dir = [[[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
        stringByAppendingPathComponent:run] stringByAppendingPathComponent:var] stringByAppendingPathComponent:valid];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    uint16_t bits[4];
    for (int i = 0; i < 4; i++) {
        float value = values ? values[i].floatValue : base + i;
        int sign = value < 0 ? 0x8000 : 0;
        int exponent = value == 0 ? 0 : (int)floorf(log2f(fabsf(value))) + 15;
        int fraction = exponent > 0 ? (int)lrintf((fabsf(value) / ldexpf(1, exponent - 15) - 1) * 1024) : 0;
        bits[i] = (uint16_t)(sign | (exponent << 10) | (fraction & 1023));
    }
    NSMutableData *data = [NSMutableData data];
    for (int i = 0; i < 4; i++) { uint8_t b[2] = {(uint8_t)bits[i], bits[i] >> 8}; [data appendBytes:b length:2]; }
    if (corrupt) data = [NSMutableData dataWithBytes:"x" length:1];
    [data writeToFile:[dir stringByAppendingPathExtension:@"f16"] atomically:YES];
    NSDictionary *side = @{@"lat0":@0, @"lon0":@95, @"dlat":@-0.25, @"dlon":@0.25,
        @"ny":@2, @"nx":@2, @"units":units, @"run":RunDateString(run, 0),
        @"valid_time":RunDateString(run, lead), @"model":@"ecmwf-ifs-0p25-open-data",
        @"fill":@-32768, @"native_step_hours":@3, @"order":@"north-to-south, west-to-east",
        @"dtype":@"float16", @"endian":@"little", @"param":param};
    NSData *json = [NSJSONSerialization dataWithJSONObject:side options:0 error:nil];
    [json writeToFile:[dir stringByAppendingPathExtension:@"json"] atomically:YES];
}
static void WriteCustomField(NSString *root, NSString *run, NSString *var, NSString *param,
    NSString *units, int lead, NSArray<NSNumber *> *values) {
    WriteField(root, run, var, param, units, lead, 0, values, NO);
}
static void MakeRun(NSString *root, NSString *run, int count, BOOL corrupt) {
    NSArray *vars = @[@[@"mslp",@"msl",@"hPa"], @[@"t850",@"t",@"degC"], @[@"t2m",@"2t",@"degC"],
        @[@"u10",@"10u",@"m/s"], @[@"v10",@"10v",@"m/s"], @[@"tp",@"tp",@"mm"]];
    for (int h = 0; h < count; h++) for (NSArray *item in vars)
        WriteField(root, run, item[0], item[1], item[2], h * 3,
            [item[0] isEqual:@"tp"] ? 100 + h * 3 : ([item[0] isEqual:@"t850"] ? -2 : 1000 + h),
            nil, corrupt && h == 0 && [item[0] isEqual:@"mslp"]);
}

static void MakeFloatRun(NSString *root, int nx, int ny, float offset) {
    NSString *dir = [root stringByAppendingPathComponent:@"run"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    NSMutableArray *times = [NSMutableArray array];
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    fmt.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    fmt.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss'Z'";
    NSDate *start = [NSDate dateWithTimeIntervalSince1970:1780099200];
    for (int h = 0; h < 3; h++) [times addObject:[fmt stringFromDate:[start dateByAddingTimeInterval:h * 3 * 3600]]];
    NSDictionary *manifest = @{
        @"grid":@{@"dtype":@"float32", @"endian":@"little", @"nx":@(nx), @"ny":@(ny), @"step":@0.25, @"west":@95, @"north":@0},
        @"times":times, @"generated":times[0], @"run":times[0], @"attribution":@"test"};
    NSData *manifestData = [NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil];
    [manifestData writeToFile:[dir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
    NSArray *names = @[@"msl.f32", @"t850.f32", @"t2m.f32", @"u10.f32", @"v10.f32", @"rain24.f32"];
    NSUInteger count = (NSUInteger)nx * (NSUInteger)ny * times.count;
    NSMutableData *values = [NSMutableData dataWithLength:count * sizeof(float)];
    float *buffer = values.mutableBytes;
    for (NSUInteger i = 0; i < count; i++) buffer[i] = offset + (float)(i % (NSUInteger)(nx * ny));
    for (NSString *name in names) [values writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES];
}

static void MarkSchema2Sidecar(NSString *root, NSString *run, NSString *var, int lead) {
    NSString *path = [[[[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
        stringByAppendingPathComponent:run] stringByAppendingPathComponent:var]
        stringByAppendingPathComponent:RunID(run, lead)] stringByAppendingPathExtension:@"json"];
    NSMutableDictionary *side = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:0 error:nil] mutableCopy];
    [side removeObjectForKey:@"native_step_hours"];
    side[@"lead_hours"] = @(lead);
    [[NSJSONSerialization dataWithJSONObject:side options:0 error:nil] writeToFile:path atomically:YES];
}

static NSArray<NSNumber *> *WeekHours(void) {
    NSMutableArray *hours = [NSMutableArray array];
    for (int lead = 0; lead <= 144; lead += 3) [hours addObject:@(lead)];
    for (int lead = 150; lead <= 168; lead += 6) [hours addObject:@(lead)];
    return hours;
}

static void WriteWeekRun(NSString *root, NSString *run, NSArray<NSNumber *> *hours) {
    NSArray *vars = @[@[@"mslp",@"msl",@"hPa"], @[@"t850",@"t",@"degC"], @[@"t2m",@"2t",@"degC"],
        @[@"u10",@"10u",@"m/s"], @[@"v10",@"10v",@"m/s"], @[@"tp",@"tp",@"mm"]];
    double rainScale = [[run substringWithRange:NSMakeRange(9, 2)] intValue] == 12 ? 1.1 : 1.0;
    for (NSNumber *lead in hours) for (NSArray *item in vars) {
        float base = 1;
        if ([item[0] isEqual:@"mslp"]) base = 1000 + lead.floatValue;
        else if ([item[0] isEqual:@"tp"]) base = lead.floatValue * rainScale;
        else if ([item[0] isEqual:@"t850"]) base = 10;
        WriteField(root, run, item[0], item[1], item[2], lead.intValue, base, nil, NO);
        MarkSchema2Sidecar(root, run, item[0], lead.intValue);
    }
    NSDictionary *manifest = @{
        @"schema_version": @2, @"schema": @2, @"contract": @"isobar-data",
        @"family": @"grids/ecmwf_ifs025", @"forecast_hours": hours,
        @"horizon_hours": hours.lastObject, @"uniform_step_hours": NSNull.null,
        @"run": RunDateString(run, 0),
    };
    NSString *dir = [[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"] stringByAppendingPathComponent:run];
    [[NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil]
        writeToFile:[dir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
}

static void WriteWeekPointer(NSString *root, NSArray<NSString *> *runs, NSArray<NSNumber *> *hours) {
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [[NSFileManager defaultManager] createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
    NSDictionary *pointer = @{
        @"latest": runs.lastObject, @"runs": runs, @"schema_version": @2,
        @"contract": @"isobar-data", @"family": @"grids/ecmwf_ifs025",
        @"forecast_hours": hours, @"horizon_hours": hours.lastObject,
        @"uniform_step_hours": NSNull.null,
    };
    [[NSJSONSerialization dataWithJSONObject:pointer options:0 error:nil]
        writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
}

static NSInteger LeadIndex(OwnRun *run, NSString *runID, int lead) {
    NSDateFormatter *in = [NSDateFormatter new];
    in.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    in.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    in.dateFormat = @"yyyyMMdd'T'HH'Z'";
    NSDate *when = [[in dateFromString:runID] dateByAddingTimeInterval:lead * 3600.0];
    for (NSInteger i = 0; i < run.hours; i++) {
        NSDate *time = [run timeAtIndex:i];
        if (time && fabs([time timeIntervalSinceDate:when]) < 1) return i;
    }
    return -1;
}

static void TestWeekLadder(NSString *coast) {
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    @try {
        NSArray<NSNumber *> *hours = WeekHours();
        // The adjacent -12 h cycle cannot cover the complete window ending at
        // the new run's first frame. The -24 h cycle can, and must be selected.
        WriteWeekRun(root, @"20261006T00Z", hours);
        WriteWeekRun(root, @"20261006T12Z", hours);
        WriteWeekRun(root, @"20261007T00Z", hours);
        WriteField(root, @"20261007T00Z", @"mslp", @"msl", @"hPa", 147, 1147, nil, NO);
        MarkSchema2Sidecar(root, @"20261007T00Z", @"mslp", 147);
        WriteWeekPointer(root, @[@"20261006T00Z", @"20261006T12Z", @"20261007T00Z"], hours);
        NSString *error = nil;
        OwnRun *run = OwnRunLoadPublished(root, NO, coast, &error);
        check(run != nil && run.hours == 53, [NSString stringWithFormat:@"schema 2 loads 53 frames (%ld, %@)", (long)run.hours, error ?: @""]);
        NSInteger at144 = LeadIndex(run, @"20261007T00Z", 144);
        NSInteger at150 = LeadIndex(run, @"20261007T00Z", 150);
        NSInteger at168 = LeadIndex(run, @"20261007T00Z", 168);
        NSInteger at147 = LeadIndex(run, @"20261007T00Z", 147);
        check(at144 >= 0 && at150 == at144 + 1 && at168 == 52 && at147 < 0,
            @"150 h follows 144 h and an unlisted 147 h file is not a frame");
        NSDate *end = [run timeAtIndex:run.hours - 1];
        NSDateFormatter *in = [NSDateFormatter new];
        in.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        in.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
        in.dateFormat = @"yyyyMMdd'T'HH'Z'";
        NSDate *issued = [in dateFromString:@"20261007T00Z"];
        check(end && fabs([end timeIntervalSinceDate:issued] - 168 * 3600) < 1, @"the last frame is +168 h");
        double mid = [run valueAtPointIndex:0 field:OwnRunFieldMSLP fractionalHour:at144 + 0.5];
        double left = [run valueAtPointIndex:0 field:OwnRunFieldMSLP hour:at144];
        double right = [run valueAtPointIndex:0 field:OwnRunFieldMSLP hour:at150];
        check(fabs(mid - (left + right) / 2) < 0.2, [NSString stringWithFormat:@"the 144–150 h midpoint blends the listed frames (%.2f)", mid]);
        double rain = [run valueAtPointIndex:0 field:OwnRunFieldRain hour:at150];
        check([run hasRainAtIndex:at150] && fabs(rain - 24) < 0.2 && fabs(rain - 27) > 1,
            [NSString stringWithFormat:@"150 h rain pairs with 126 h, not eight frames back (%.2f mm)", rain]);
        NSInteger at12 = LeadIndex(run, @"20261007T00Z", 12);
        NSInteger at0 = LeadIndex(run, @"20261007T00Z", 0);
        check(at12 >= 0 && [run hasRainAtIndex:at12] && fabs([run valueAtPointIndex:0 field:OwnRunFieldRain hour:at12] - 26.4) < 0.2,
            @"an early lead uses the newest complete older cycle's 24 h window");
        check(at0 >= 0 && [run hasRainAtIndex:at0] && fabs([run valueAtPointIndex:0 field:OwnRunFieldRain hour:at0] - 24) < 0.2,
            @"the newest earlier cycle with a complete 24 h window supplies the first frame");
        NSInteger at21 = LeadIndex(run, @"20261007T00Z", 21);
        NSInteger at24 = LeadIndex(run, @"20261007T00Z", 24);
        double rain21 = [run valueAtPointIndex:0 field:OwnRunFieldRain hour:at21];
        double rain24 = [run valueAtPointIndex:0 field:OwnRunFieldRain hour:at24];
        double rainMid = [run valueAtPointIndex:0 field:OwnRunFieldRain fractionalHour:at21 + 0.5];
        check(at21 >= 0 && at24 == at21 + 1 && fabs(rain21 - 26.4) < 0.2 && fabs(rain24 - 24) < 0.2,
            @"the fallback rain meets the current run at the first paired frame");
        check(fabs(rainMid - (rain21 + rain24) / 2) < 0.2,
            [NSString stringWithFormat:@"fractional rain blends across the fallback seam (%.2f)", rainMid]);
        double justBefore = [run valueAtPointIndex:0 field:OwnRunFieldRain fractionalHour:at24 - 1e-5];
        double justAfter = [run valueAtPointIndex:0 field:OwnRunFieldRain fractionalHour:at24 + 1e-5];
        check(isfinite(justBefore) && isfinite(justAfter) && fabs(justBefore - justAfter) < 0.001,
            @"different cycles meet continuously at 24 h without a field jump");
        WriteField(root, @"20261006T12Z", @"tp", @"tp", @"mm", 24, 0, @[@-32768, @-32768, @-32768, @-32768], NO);
        MarkSchema2Sidecar(root, @"20261006T12Z", @"tp", 24);
        OwnRun *emptyNewer = OwnRunLoadPublished(root, NO, coast, &error);
        check(emptyNewer && fabs([emptyNewer valueAtPointIndex:0 field:OwnRunFieldRain hour:at12] - 24) < 0.2,
            @"an entirely missing newer window falls back to the older valid cycle");
        WriteField(root, @"20261006T12Z", @"tp", @"tp", @"mm", 24, 26.4, nil, NO);
        MarkSchema2Sidecar(root, @"20261006T12Z", @"tp", 24);
        NSString *adjacentManifest = [[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
            stringByAppendingPathComponent:@"20261006T12Z"] stringByAppendingPathComponent:@"manifest.json"];
        NSMutableDictionary *malformed = [[NSJSONSerialization JSONObjectWithData:
            [NSData dataWithContentsOfFile:adjacentManifest] options:NSJSONReadingMutableContainers error:nil] mutableCopy];
        malformed[@"schema_version"] = @3;
        [[NSJSONSerialization dataWithJSONObject:malformed options:0 error:nil]
            writeToFile:adjacentManifest atomically:YES];
        error = nil;
        OwnRun *skippingMalformed = OwnRunLoadPublished(root, NO, coast, &error);
        NSInteger skippingMalformedAt12 = LeadIndex(skippingMalformed, @"20261007T00Z", 12);
        check(skippingMalformed && skippingMalformedAt12 >= 0 &&
              fabs([skippingMalformed valueAtPointIndex:0 field:OwnRunFieldRain hour:skippingMalformedAt12] - 24) < 0.2,
            @"malformed newer fallback is skipped in favour of the older valid window");
        NSString *oldStart = [[[[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
            stringByAppendingPathComponent:@"20261006T00Z"] stringByAppendingPathComponent:@"tp"]
            stringByAppendingPathComponent:@"20261006T00Z"] stringByAppendingPathExtension:@"f16"];
        [[NSFileManager defaultManager] removeItemAtPath:oldStart error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:[oldStart.stringByDeletingPathExtension stringByAppendingPathExtension:@"json"] error:nil];
        error = nil;
        OwnRun *withoutWindow = OwnRunLoadPublished(root, NO, coast, &error);
        NSInteger withoutWindowAt0 = LeadIndex(withoutWindow, @"20261007T00Z", 0);
        check(withoutWindow && withoutWindowAt0 >= 0 && ![withoutWindow hasRainAtIndex:withoutWindowAt0],
            @"an early frame stays missing when no retained run covers the complete window");
        NSString *missing = [[[[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
            stringByAppendingPathComponent:@"20261007T00Z"] stringByAppendingPathComponent:@"mslp"]
            stringByAppendingPathComponent:@"20261014T00Z"] stringByAppendingPathExtension:@"f16"];
        [[NSFileManager defaultManager] removeItemAtPath:missing error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:[missing.stringByDeletingPathExtension stringByAppendingPathExtension:@"json"] error:nil];
        error = nil;
        check(OwnRunLoadPublished(root, NO, coast, &error) == nil && [error containsString:@"168"],
            [NSString stringWithFormat:@"a missing listed hour fails closed (%@)", error ?: @""]);
    } @finally { [[NSFileManager defaultManager] removeItemAtPath:root error:nil]; }
}

static NSData *RenderedBytes(OwnRun *run, CGFloat scale, int temperature) {
    OwnLayerOptions layers = {.bare = 1, .barbs = 1, .temperature = temperature};
    NSImage *image = OwnRunRender(run, 0, @"", layers, @[], scale);
    return [image TIFFRepresentation];
}

// Labelled renders share the isobar label caches across render threads.
static void TestConcurrentLabelledRenders(void) {
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    @try {
        MakeFloatRun(root, 40, 30, 1203);
        NSString *error = nil;
        OwnRun *run = OwnRunLoad([root stringByAppendingPathComponent:@"run"], @"Resources/ownchart-coast.bin", &error);
        OwnLayerOptions layers = {0};
        NSData *(^render)(CGFloat) = ^NSData *(CGFloat scale) { return [OwnRunRender(run, 0, @"", layers, @[], scale) TIFFRepresentation]; };
        // Concurrent renders first, so they are the first to fill the label caches.
        NSMutableArray *concurrent = [NSMutableArray array];
        for (int i = 0; i < 16; i++) [concurrent addObject:NSNull.null];
        NSLock *lock = [NSLock new];
        dispatch_apply(16, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t i) {
            NSData *bytes = render(i % 2 ? 2 : 1) ?: [NSData data];
            [lock lock]; concurrent[i] = bytes; [lock unlock];
        });
        NSData *serial1 = render(1), *serial2 = render(2);
        NSUInteger mismatches = 0;
        for (NSUInteger i = 0; i < concurrent.count; i++) if (![concurrent[i] isEqual:i % 2 ? serial2 : serial1]) mismatches++;
        check(run != nil && serial1.length && mismatches == 0,
            [NSString stringWithFormat:@"concurrent labelled renders match serial renders (%lu differ%@)", (unsigned long)mismatches, error ? [@"; " stringByAppendingString:error] : @""]);
    } @finally { [[NSFileManager defaultManager] removeItemAtPath:root error:nil]; }
}

static void TestConcurrentDifferentGrids(void) {
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString *aPath = [root stringByAppendingPathComponent:@"a"];
    NSString *bPath = [root stringByAppendingPathComponent:@"b"];
    @try {
        MakeFloatRun(aPath, 2, 2, 1000);
        MakeFloatRun(bPath, 3, 2, 2000);
        NSString *aError = nil, *bError = nil;
        OwnRun *a = OwnRunLoad([aPath stringByAppendingPathComponent:@"run"], @"Resources/ownchart-coast.bin", &aError);
        OwnRun *b = OwnRunLoad([bPath stringByAppendingPathComponent:@"run"], @"Resources/ownchart-coast.bin", &bError);
        NSData *serialA = RenderedBytes(a, 1, 1), *serialB = RenderedBytes(b, 2, 2);
        __block NSData *concurrentA = nil, *concurrentB = nil;
        dispatch_group_t group = dispatch_group_create();
        dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ concurrentA = RenderedBytes(a, 1, 1); });
        dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ concurrentB = RenderedBytes(b, 2, 2); });
        dispatch_group_wait(group, DISPATCH_TIME_FOREVER);
        check(a != nil && b != nil, [NSString stringWithFormat:@"different grid fixtures load (%@ / %@)", aError ?: @"", bError ?: @""]);
        check([serialA isEqual:concurrentA] && [serialB isEqual:concurrentB],
            @"concurrent renders with different grids match serial renders");
    } @finally { [[NSFileManager defaultManager] removeItemAtPath:root error:nil]; }
}

int main(void) {
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString *coast = @"Resources/ownchart-coast.bin";
    @try {
        MakeRun(root, @"20260925T12Z", 12, NO); MakeRun(root, @"20260926T00Z", 33, NO);
        NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
        [[NSFileManager defaultManager] createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
        NSDictionary *pointer = @{@"latest":@"20260926T00Z", @"runs":@[@"20260925T12Z",@"20260926T00Z"]};
        for (int lead = 0; lead <= 3; lead += 3) {
            double direction = lead == 0 ? 350.0 : 10.0, rad = direction * M_PI / 180.0;
            float u = (float)(-10.0 * sin(rad)), v = (float)(-10.0 * cos(rad));
            NSArray *uValues = @[@(u), @(u), @(u), @(u)], *vValues = @[@(v), @(v), @(v), @(v)];
            WriteCustomField(root, @"20260926T00Z", @"u10", @"10u", @"m/s", lead, uValues);
            WriteCustomField(root, @"20260926T00Z", @"v10", @"10v", @"m/s", lead, vValues);
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:pointer options:0 error:nil];
        [data writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
        NSString *error = nil; OwnRun *run = OwnRunLoadPublished(root, NO, coast, &error);
        check(run != nil, [NSString stringWithFormat:@"published run loads (%@)", error ?: @""]);
        OwnRun *sameRun = OwnRunLoadPublished(root, NO, coast, &error);
        check(sameRun == run, @"unchanged published run reuses the parsed cube");
        NSDictionary *futurePointer = @{@"latest":@"20260926T00Z", @"runs":@[@"20260925T12Z",@"20260926T00Z"],
                                        @"schema_version":@3, @"contract":@"isobar-data"};
        [[NSJSONSerialization dataWithJSONObject:futurePointer options:0 error:nil]
            writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
        error = nil;
        check(OwnRunLoadPublished(root, NO, coast, &error) == nil && [error containsString:@"unsupported contract"],
            @"schema 3 fails before cached weather is reused");
        NSDictionary *bareSchema2 = @{@"latest":@"20260926T00Z", @"runs":@[@"20260925T12Z",@"20260926T00Z"],
                                      @"schema_version":@2, @"contract":@"isobar-data", @"family":@"grids/ecmwf_ifs025"};
        [[NSJSONSerialization dataWithJSONObject:bareSchema2 options:0 error:nil]
            writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
        error = nil;
        OwnRun *withoutHours = OwnRunLoadPublished(root, NO, coast, &error);
        check(withoutHours == nil && withoutHours != run && [error containsString:@"forecast_hours"],
            [NSString stringWithFormat:@"schema 2 without forecast_hours fails closed (%@)", error ?: @""]);
        NSDictionary *wrongFamily = @{@"latest":@"20260926T00Z", @"runs":@[@"20260925T12Z",@"20260926T00Z"],
                                      @"schema_version":@1, @"contract":@"isobar-data", @"family":@"points/marine"};
        [[NSJSONSerialization dataWithJSONObject:wrongFamily options:0 error:nil]
            writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
        error = nil;
        check(OwnRunLoadPublished(root, NO, coast, &error) == nil && [error containsString:@"unsupported contract"],
            @"wrong grid family cannot select a cached run");
        [data writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
        check(run.hours == 33 && run.runDate != nil, @"run date and hours are published values");
        check(fabs([run valueAtPointIndex:0 field:OwnRunFieldMSLP hour:0] - 1000) < 1,
            @"float16 pressure values decode");
        check(fabs([run valueAtPointIndex:0 field:OwnRunFieldT850 hour:0] + 2) < 0.01,
            @"negative float16 temperature values decode");
        check([run hasRainAtIndex:8] && ![run hasRainAtIndex:0], @"rain has same-cycle totals and missing early totals");
        check([run hasRainAtIndex:7], @"rain pairs an early frame with the previous published cycle");
        double midpoint = [run valueAtPointIndex:0 field:OwnRunFieldMSLP fractionalHour:0.5];
        check(fabs(midpoint - 1000.5) < 0.1, @"scalar fields interpolate at the midpoint");
        check(fabs([run valueAtPointIndex:0 field:OwnRunFieldMSLP fractionalHour:1.0] -
            [run valueAtPointIndex:0 field:OwnRunFieldMSLP hour:1]) < 1e-6, @"fractional endpoint equals stored sample");
        check(isnan([run valueAtPointIndex:0 field:OwnRunFieldRain fractionalHour:0.5]), @"missing rain is not fabricated");
        double speed = [run valueAtPointIndex:0 field:OwnRunFieldWindSpeed fractionalHour:0.5];
        double direction = [run valueAtPointIndex:0 field:OwnRunFieldWindDirection fractionalHour:0.5];
        check(fabs(speed - 19.4) < 0.4 && (direction < 1 || direction > 359),
            [NSString stringWithFormat:@"wind blends vectors across 350/10 degrees (%.3f kt %.3f°)", speed, direction]);
        OwnLayerOptions bare = {.bare = 1, .barbs = 1};
        NSImage *floorImage = OwnRunRender(run, 0, @"", bare, @[], 1);
        NSImage *midImage = OwnRunRenderFraction(run, 0.5, @"", bare, @[], 1);
        check(floorImage != nil && midImage != nil, @"fractional rendering accepts a midpoint slice");
        check(isnan([run valueAtPointIndex:0 field:OwnRunFieldMSLP fractionalHour:-0.1]) &&
            isnan([run valueAtPointIndex:0 field:OwnRunFieldMSLP fractionalHour:33]), @"invalid fractional indices return missing");
        NSString *changedField = [[[[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
            stringByAppendingPathComponent:@"20260926T00Z"] stringByAppendingPathComponent:@"mslp"]
            stringByAppendingPathComponent:@"20260926T00Z"] stringByAppendingPathExtension:@"f16"];
        NSMutableData *changedBytes = [[NSData dataWithContentsOfFile:changedField] mutableCopy];
        uint8_t changedByte = 0;
        [changedBytes replaceBytesInRange:NSMakeRange(0, 1) withBytes:&changedByte];
        check([changedBytes writeToFile:changedField atomically:YES], @"test rewrites one published payload byte");
        [[NSFileManager defaultManager] setAttributes:@{NSFileModificationDate:[NSDate dateWithTimeIntervalSinceNow:5]}
            ofItemAtPath:changedField error:nil];
        OwnRun *correctedRun = OwnRunLoadPublished(root, NO, coast, &error);
        check(correctedRun != nil && correctedRun != run, @"changed published payload invalidates the parsed cube");
        [[NSFileManager defaultManager] removeItemAtPath:changedField error:nil];
        check(OwnRunLoadPublished(root, NO, coast, &error) == nil,
            @"removing a published payload invalidates the cached cube");
        NSString *bad = [root stringByAppendingPathComponent:@"bad"]; MakeRun(bad, @"20260926T00Z", 33, YES);
        NSString *bf = [bad stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
        [[NSFileManager defaultManager] createDirectoryAtPath:bf withIntermediateDirectories:YES attributes:nil error:nil];
        data = [NSJSONSerialization dataWithJSONObject:@{@"latest":@"20260926T00Z",@"runs":@[@"20260926T00Z"]} options:0 error:nil];
        [data writeToFile:[bf stringByAppendingPathComponent:@"current.json"] atomically:YES];
        check(OwnRunLoadPublished(bad, NO, coast, &error) == nil, @"corrupt published field is rejected");
        NSString *partial = [root stringByAppendingPathComponent:@"partial"]; MakeRun(partial, @"20260926T00Z", 32, NO);
        NSString *pf = [partial stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
        [[NSFileManager defaultManager] createDirectoryAtPath:pf withIntermediateDirectories:YES attributes:nil error:nil];
        [data writeToFile:[pf stringByAppendingPathComponent:@"current.json"] atomically:YES];
        check(OwnRunLoadPublished(partial, NO, coast, &error) == nil, @"partial published run is rejected");
        NSString *pointerBad = [root stringByAppendingPathComponent:@"pointer-bad"];
        NSString *pointerFamily = [pointerBad stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
        [[NSFileManager defaultManager] createDirectoryAtPath:pointerFamily withIntermediateDirectories:YES attributes:nil error:nil];
        NSData *arrayData = [NSJSONSerialization dataWithJSONObject:@[] options:0 error:nil];
        [arrayData writeToFile:[pointerFamily stringByAppendingPathComponent:@"current.json"] atomically:YES];
        check(OwnRunLoadPublished(pointerBad, NO, coast, &error) == nil, @"malformed published pointer is rejected");
        NSString *hugeDir = [root stringByAppendingPathComponent:@"huge-run"];
        [[NSFileManager defaultManager] createDirectoryAtPath:hugeDir withIntermediateDirectories:YES attributes:nil error:nil];
        NSDictionary *grid = @{@"dtype": @"float32", @"nx": @100000, @"ny": @100000, @"step": @1,
            @"west": @0, @"east": @1, @"north": @0, @"south": @-1};
        NSDictionary *base = @{@"schema": @1, @"run": @"2026-09-25T18:00:00Z",
            @"times": @[@"2026-09-26T00:00:00Z"], @"grid": [grid mutableCopy]};
        NSMutableDictionary *huge = [base mutableCopy];
        huge[@"grid"] = [grid mutableCopy];
        ((NSMutableDictionary *)huge[@"grid"])[@"endian"] = @"little";
        NSData *hugeJSON = [NSJSONSerialization dataWithJSONObject:huge options:0 error:nil];
        [hugeJSON writeToFile:[hugeDir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
        check(OwnRunLoad(hugeDir, coast, &error) == nil, @"an oversized run grid is refused");
        ((NSMutableDictionary *)huge[@"grid"])[@"nx"] = @4;
        ((NSMutableDictionary *)huge[@"grid"])[@"ny"] = @4;
        [(NSMutableDictionary *)huge[@"grid"] removeObjectForKey:@"endian"];
        [[NSJSONSerialization dataWithJSONObject:huge options:0 error:nil] writeToFile:[hugeDir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
        check(OwnRunLoad(hugeDir, coast, &error) == nil, @"a run grid without endian is refused");
        ((NSMutableDictionary *)huge[@"grid"])[@"endian"] = @"big";
        [[NSJSONSerialization dataWithJSONObject:huge options:0 error:nil] writeToFile:[hugeDir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
        check(OwnRunLoad(hugeDir, coast, &error) == nil, @"a big-endian run grid is refused");
    } @finally { [[NSFileManager defaultManager] removeItemAtPath:root error:nil]; }
    TestConcurrentDifferentGrids();
    TestConcurrentLabelledRenders();
    TestWeekLadder(coast);
    return failures ? 1 : 0;
}
