#import <Foundation/Foundation.h>
#import "atmosphere.h"
#include <math.h>
#include <stdio.h>

static int failures;
static void Check(BOOL ok, NSString *message) { if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); failures++; } }
static NSDate *UTC(NSString *s) { return [[NSISO8601DateFormatter new] dateFromString:s]; }
static NSDictionary *Fixture(void) {
    return @{ @"id": @"YPPH", @"model": @"test", @"run": @"2026-09-27T00:00:00Z", @"elevation": @100,
      @"time": @[@"2026-09-27T00:00:00Z", @"2026-09-27T03:00:00Z"], @"levels": @{
        @"1000": @{ @"height_m": @[@50,@60], @"temperature_c": @[@2,@6], @"wind_speed_kt": @[@10,@20], @"wind_direction_deg": @[@350,@10] },
        @"900": @{ @"height_m": @[@1000,@1100], @"temperature_c": @[@-2,@2], @"relative_humidity_pct": @[@50,@70] },
        @"800": @{ @"height_m": @[@2100,@2200], @"temperature_c": @[@3,@4] }
      }};
}
int main(void) { @autoreleasepool {
    NSDictionary *isa0 = StandardAtmosphereAtHeight(0.0);
    NSDictionary *isa11 = StandardAtmosphereAtHeight(11000.0);
    NSDictionary *isa20 = StandardAtmosphereAtHeight(20000.0);
    Check(fabs([isa0[@"temperatureC"] doubleValue] - 15.0) < .001, @"ISA sea-level temperature");
    Check(fabs([isa0[@"pressureHpa"] doubleValue] - 1013.25) < .01, @"ISA sea-level pressure");
    Check(fabs([isa11[@"temperatureC"] doubleValue] + 56.5) < .001, @"ISA tropopause temperature");
    Check(fabs([isa11[@"pressureHpa"] doubleValue] - 226.321) < .1, @"ISA tropopause pressure");
    Check(fabs([isa20[@"temperatureC"] doubleValue] + 56.5) < .001, @"ISA lower stratosphere temperature");
    Check(fabs([isa20[@"pressureHpa"] doubleValue] - 54.749) < .1, @"ISA 20 km pressure");
    Check(StandardAtmosphereAtHeight(-1.0) == nil && StandardAtmosphereAtHeight(20000.1) == nil &&
          StandardAtmosphereAtHeight(NAN) == nil, @"ISA bounds");
    NSDictionary *r = AtmosphereAtDate(Fixture(), UTC(@"2026-09-27T01:30:00Z"));
    Check(r != nil, @"sample exists"); Check([r[@"levels"] count] == 2, @"below terrain excluded");
    NSDictionary *l = r[@"levels"][0]; Check(fabs([l[@"heightM"] doubleValue]-1050) < .01, @"height interpolation");
    Check(fabs([l[@"temperatureC"] doubleValue]) < .01, @"temperature interpolation");
    NSMutableDictionary *windFixture=[Fixture() mutableCopy]; windFixture[@"elevation"]=@0;
    NSDictionary *wind=AtmosphereAtDate(windFixture,UTC(@"2026-09-27T01:30:00Z"))[@"levels"][0];
    Check(wind[@"windDegrees"] && fabs([wind[@"windDegrees"] doubleValue]-3.363727) < .01, @"vector wind interpolation weights the stronger easterly component");
    NSMutableDictionary *flow=[windFixture mutableCopy];
    flow[@"levels"]=@{@"500":@{@"height_m":@[@5500,@5500],@"wind_speed_kt":@[@20,@20],@"wind_direction_deg":@[@90,@270],@"vertical_velocity_ms":@[@-.2,@.4]}};
    flow[@"units"]=@{@"vertical_velocity_500hPa":@"m/s"};
    NSDictionary *motion=AtmosphereAtDate(flow,UTC(@"2026-09-27T01:30:00Z"))[@"levels"][0];
    Check([motion[@"windKt"] doubleValue]<.001 && !motion[@"windDegrees"],@"opposing winds interpolate through calm without an invented direction");
    Check(fabs([motion[@"verticalVelocityMS"] doubleValue]-.1)<.0001,@"vertical air velocity interpolates with its sign intact");
    flow[@"units"]=@{@"vertical_velocity_500hPa":@"Pa/s"};
    Check(!AtmosphereAtDate(flow,UTC(@"2026-09-27T01:30:00Z"))[@"levels"][0][@"verticalVelocityMS"],@"pressure velocity cannot masquerade as geometric vertical velocity");
    Check([r[@"featureAvailability"][@"relativeHumidity"] boolValue], @"humidity available");
    Check(![r[@"featureAvailability"][@"cloudCover"] boolValue], @"cloud missing explicit");
    Check([r[@"missingFeatures"] containsObject:@"cloudCover"], @"missing cloud metadata");
    Check([r[@"freezingHeightsM"] count] == 1, @"freezing crossing"); Check([r[@"inversions"] count] == 1, @"inversion");
    Check(AtmosphereAtDate(Fixture(), UTC(@"2026-09-26T23:00:00Z")) == nil, @"before range nil");
    NSDictionary *gap = @{ @"time": @[@"2026-09-27T00:00:00Z", @"2026-09-27T09:00:00Z"], @"levels": @{@"900":@{@"height_m":@[@1000,@1000], @"temperature_c":@[@1,@2]}}};
    Check(AtmosphereAtDate(gap, UTC(@"2026-09-27T03:00:00Z")) == nil, @"large gap nil");
    NSDictionary *missing = @{ @"time": @[@"2026-09-27T00:00:00Z", @"2026-09-27T03:00:00Z"], @"levels": @{@"900":@{@"height_m":@[@1000,@1000], @"temperature_c":@[@1,[NSNull null]]}}};
    NSDictionary *mr = AtmosphereAtDate(missing, UTC(@"2026-09-27T01:00:00Z")); Check(!mr[@"levels"][0][@"temperatureC"], @"missing endpoint not bridged");
    NSDictionary *atEndpoint=AtmosphereAtDate(missing,UTC(@"2026-09-27T00:00:00Z"));
    Check([atEndpoint[@"levels"][0][@"temperatureC"] doubleValue]==1,@"exact sample does not need another endpoint");
    NSMutableDictionary *gapExact=[gap mutableCopy];
    Check(AtmosphereAtDate(gapExact,UTC(@"2026-09-27T09:00:00Z"))!=nil,@"exact sample after a gap remains usable");
    gapExact[@"time"]=@[@"2026-09-27T09:00:00Z",@"2026-09-27T00:00:00Z"];
    Check(!AtmosphereAtDate(gapExact,UTC(@"2026-09-27T01:00:00Z")),@"unsorted times rejected");
    NSMutableDictionary *wrongUnits=[Fixture() mutableCopy]; wrongUnits[@"units"]=@{@"temperature_900hPa":@"°F",@"relative_humidity_900hPa":@"fraction"};
    NSDictionary *wrong=AtmosphereAtDate(wrongUnits,UTC(@"2026-09-27T01:00:00Z"));
    Check(!wrong[@"levels"][0][@"temperatureC"] && !wrong[@"levels"][0][@"humidityPct"],@"incompatible units remain unknown");
    NSDictionary *heightGap=@{@"time":@[@"2026-09-27T00:00"],@"levels":@{
        @"1000":@{@"height_m":@[@100],@"temperature_c":@[@10]},
        @"850":@{@"height_m":@[NSNull.null],@"temperature_c":@[@4]},
        @"700":@{@"height_m":@[@3000],@"temperature_c":@[@-5]}}};
    Check(!AtmosphereAtDate(heightGap,UTC(@"2026-09-27T00:00:00Z"))[@"freezingHeightsM"],@"freezing level does not bridge a missing intermediate height");
    NSDictionary *bad = @{ @"time": @[@"2026-09-27T00:00:00Z"], @"levels": @{@"900":@{@"height_m":@[[NSNumber numberWithDouble:NAN]]}}};
    Check(AtmosphereAtDate(bad, UTC(@"2026-09-27T00:00:00Z")) == nil, @"nonfinite rejected");
  } return failures ? 1 : 0; }
