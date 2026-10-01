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
        @"grid":@{@"dtype":@"float32", @"nx":@(nx), @"ny":@(ny), @"step":@0.25, @"west":@95, @"north":@0},
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

static NSData *RenderedBytes(OwnRun *run, CGFloat scale, int temperature) {
    OwnLayerOptions layers = {.bare = 1, .barbs = 1, .temperature = temperature};
    NSImage *image = OwnRunRender(run, 0, @"", layers, @[], scale);
    return [image TIFFRepresentation];
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
                                        @"schema_version":@2, @"contract":@"isobar-data"};
        [[NSJSONSerialization dataWithJSONObject:futurePointer options:0 error:nil]
            writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
        error = nil;
        check(OwnRunLoadPublished(root, NO, coast, &error) == nil && [error containsString:@"unsupported contract"],
            @"future grid contract fails before cached weather is reused");
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
    } @finally { [[NSFileManager defaultManager] removeItemAtPath:root error:nil]; }
    TestConcurrentDifferentGrids();
    return failures ? 1 : 0;
}
