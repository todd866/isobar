#import "../Sources/rain.h"
#include <stdio.h>

static int failures = 0;
static NSDate *D(NSString *s) {
    NSISO8601DateFormatter *f = [NSISO8601DateFormatter new];
    return [f dateFromString:s];
}
static NSDictionary *R(NSString *end, double mm) {
    return @{@"time": D(end), @"rainMm": @(mm)};
}
static NSDictionary *W(NSString *end, double mm, NSInteger code) {
    return @{@"time": D(end), @"rainMm": @(mm), @"weatherCode": @(code)};
}
static void Check(BOOL ok, NSString *message) {
    if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); failures++; }
}

int main(void) {
    NSTimeZone *tz = [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSDate *now = D(@"2026-09-26T04:30:00Z");
    NSDictionary *rain = RainOutlook(@[
        W(@"2026-09-26T05:00:00Z", 0.7, 61),
        W(@"2026-09-26T06:00:00Z", 1.1, 61),
        R(@"2026-09-26T07:00:00Z", 0),
    ], now, tz);
    Check([rain[@"line"] isEqual:@"Now–2 pm · 1.8 mm"], @"current bucket and amount");
    Check([rain[@"headline"] isEqual:@"Light rain now"], @"weather code headline");
    Check([rain[@"amount24"] isEqual:@"≥1.8 mm · 24h"], @"incomplete total shows only the known minimum");
    Check([rain[@"hours"] count] == 48 && [rain[@"hours"][0][@"known"] boolValue], @"hour bar keeps known state");
    Check([rain[@"eventStart"] isEqual:D(@"2026-09-26T04:00:00Z")] &&
        [rain[@"eventEnd"] isEqual:D(@"2026-09-26T06:00:00Z")], @"event boundaries");
    NSDictionary *duplicate = RainOutlook(@[
        R(@"2026-09-26T05:00:00Z", 0),
        R(@"2026-09-26T05:00:00Z", 1),
    ], now, tz);
    Check([duplicate[@"line"] containsString:@"1.0+ mm"], @"duplicate timestamps collapse");

    NSDictionary *midnight = RainOutlook(@[
        W(@"2026-09-26T16:00:00Z", 0.5, 80),
        W(@"2026-09-26T17:00:00Z", 0.5, 80),
        R(@"2026-09-26T18:00:00Z", 0),
    ], D(@"2026-09-26T15:30:00Z"), tz);
    Check([midnight[@"line"] isEqual:@"Now–1 am · 1.0 mm"], @"midnight range uses exclusive end");
    Check([midnight[@"headline"] hasPrefix:@"Light showers "], @"showers code maps to headline");

    NSDictionary *ampm = RainOutlook(@[
        W(@"2026-09-26T04:00:00Z", 0.5, 95),
        W(@"2026-09-26T05:00:00Z", 0.5, 95),
        R(@"2026-09-26T06:00:00Z", 0),
    ], D(@"2026-09-26T03:30:00Z"), tz);
    Check([ampm[@"line"] isEqual:@"Now–1 pm · 1.0 mm"], @"fractional now and afternoon boundary");
    Check([ampm[@"headline"] hasPrefix:@"Thunderstorms "], @"thunderstorm code maps to headline");
    NSDictionary *snow = RainOutlook(@[
        W(@"2026-09-26T05:00:00Z", 0.4, 73),
        R(@"2026-09-26T06:00:00Z", 0),
    ], now, tz);
    Check([snow[@"headline"] hasPrefix:@"Snow "], @"snow code maps to headline");
    NSDictionary *codedDry = RainOutlook(@[
        W(@"2026-09-26T05:00:00Z", 0.4, 0),
        R(@"2026-09-26T06:00:00Z", 0),
    ], now, tz);
    Check([codedDry[@"headline"] hasPrefix:@"Rain "], @"non-rain code cannot mislabel positive rain");

    NSDictionary *gap = RainOutlook(@[
        R(@"2026-09-26T06:00:00Z", 0),
        R(@"2026-09-26T08:00:00Z", 0),
        R(@"2026-09-26T09:00:00Z", 2),
    ], now, tz);
    Check([gap[@"line"] hasPrefix:@"Forecast incomplete"], @"missing prefix");
    NSDictionary *truncated = RainOutlook(@[
        R(@"2026-09-26T05:00:00Z", 0.7),
        R(@"2026-09-26T07:00:00Z", 0.7),
    ], now, tz);
    Check([truncated[@"line"] containsString:@"0.7+ mm"] &&
        !truncated[@"totalMm"], @"a gap during rain marks the event incomplete");

    NSDictionary *dry = RainOutlook(@[
        R(@"2026-09-26T05:00:00Z", 0),
        R(@"2026-09-26T06:00:00Z", 0),
    ], now, tz);
    Check([dry[@"line"] hasPrefix:@"Dry through"], @"known dry prefix");

    NSMutableArray *full = [NSMutableArray array];
    NSDate *fullStart = D(@"2026-09-26T05:00:00Z");
    for (NSInteger i = 0; i < 24; i++)
        [full addObject:@{@"time": [fullStart dateByAddingTimeInterval:i * 3600], @"rainMm": @0}];
    NSDictionary *total = RainOutlook(full, now, tz);
    Check([total[@"totalMm"] doubleValue] == 0, @"complete 24 hour total");
    NSMutableArray *roundedRows = [NSMutableArray array];
    for (NSInteger i = 0; i < 24; i++)
        [roundedRows addObject:@{@"time": [fullStart dateByAddingTimeInterval:i * 3600],
            @"rainMm": i == 0 ? @2.7 : @0}];
    NSDictionary *rounded = RainOutlook(roundedRows, now, tz);
    Check([rounded[@"amount24"] isEqual:@"~3 mm · 24h"], @"24 hour amount is rounded for the glance");

    NSDictionary *bad = RainOutlook(@[
        R(@"2026-09-26T05:00:00Z", -1),
        @{@"time": D(@"2026-09-26T06:00:00Z"), @"rainMm": NSNull.null},
    ], now, tz);
    Check([bad[@"line"] isEqual:@"Rain unavailable"] && [bad[@"amount24"] isEqual:@"— · 24h"], @"invalid values unknown");
    NSDictionary *fraction = RainOutlook(@[R(@"2026-09-26T05:00:00Z", 1), R(@"2026-09-26T06:00:00Z", 0)], [now dateByAddingTimeInterval:0.375], tz);
    Check([fraction[@"line"] isEqual:@"Now–1 pm · 1.0 mm"], @"fractional seconds retain hourly lookup");
    NSDictionary *tail = RainOutlook(@[R(@"2026-09-26T05:00:00Z", 0.7)], now, tz);
    Check([tail[@"line"] isEqual:@"Now · 0.7+ mm"], @"forecast ending during rain cannot claim cessation");
    NSDictionary *trace = RainOutlook(@[R(@"2026-09-26T05:00:00Z", 0.01), R(@"2026-09-26T06:00:00Z", 0)], now, tz);
    Check([trace[@"line"] containsString:@"<0.1 mm"], @"positive trace never rounds to zero");
    Check([fraction[@"detail"] containsString:@"\n"], @"rain details use readable rows");
    NSMutableArray *longDry=[full mutableCopy];
    [longDry addObject:@{@"time":[fullStart dateByAddingTimeInterval:30*3600],@"rainMm":@5,@"weatherCode":@65}];
    Check([RainOutlook(longDry,now,tz)[@"headline"] isEqual:@"Dry for 24h"],@"headline shares visible 24 hour horizon");
    NSMutableArray *laterStorm=[roundedRows mutableCopy];
    laterStorm[0]=@{@"time":fullStart,@"rainMm":@0.2,@"weatherCode":@51};
    laterStorm[8]=@{@"time":[fullStart dateByAddingTimeInterval:8*3600],@"rainMm":@3,@"weatherCode":@95};
    Check([RainOutlook(laterStorm,now,tz)[@"headline"] containsString:@"Storms tonight"],@"later thunderstorm is visible in headline");
    NSMutableArray *continuous=[NSMutableArray array];
    for (NSInteger i=0;i<48;i++) [continuous addObject:@{@"time":[fullStart dateByAddingTimeInterval:i*3600],@"rainMm":@0.1}];
    Check([RainOutlook(continuous,now,tz)[@"amount24"] isEqual:@"~2 mm · 24h"],@"complete first day total survives open ended event");
    NSDictionary *predawn=RainOutlook(@[W(@"2026-09-26T21:00:00Z",0.4,61)],D(@"2026-09-26T18:30:00Z"),tz);
    Check([predawn[@"headline"] isEqual:@"Light rain this morning"],@"pre dawn rain does not mean tonight");
    Check([truncated[@"amount24"] isEqual:@"≥1.4 mm · 24h"],@"separate known intervals contribute to partial day minimum");
    Check([RainOutlook(@[R(@"2026-09-26T08:00:00Z",0)],now,tz)[@"headline"] isEqual:@"Forecast gaps"],@"later dry data is not labelled entirely unavailable");
    return failures ? 1 : 0;
}
