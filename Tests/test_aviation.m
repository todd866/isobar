#import <Foundation/Foundation.h>
#import "aviation.h"

static int failures;
static void ck(BOOL condition, NSString *message) {
    fprintf(stderr, "%s %s\n", condition ? "ok  " : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static NSDate *utc(NSString *text) {
    NSDateFormatter *f = [NSDateFormatter new]; f.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    f.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0]; f.dateFormat = @"yyyy-MM-dd HH:mm";
    return [f dateFromString:text];
}
static NSDictionary *taf(NSString *raw, NSString *from, NSString *to) {
    return @{ @"raw": raw, @"valid_from": utc(from), @"valid_to": utc(to), @"issue_time": utc(from) };
}
static NSDictionary *aviation(NSDictionary *metar, NSDictionary *tafValue) {
    return @{ @"metar": metar ?: [NSNull null], @"taf": tafValue ?: [NSNull null] };
}
static BOOL around(NSDate *actual, NSString *expected);
static NSDictionary *period(NSArray *periods, NSString *change) {
    for (NSDictionary *p in periods) if ([p[@"change"] isEqual:change]) return p;
    return nil;
}
static NSDictionary *periodStarting(NSArray *periods, NSString *change, NSString *start) {
    for (NSDictionary *p in periods) if ([p[@"change"] isEqual:change] && around(p[@"start"], start)) return p;
    return nil;
}
static BOOL around(NSDate *actual, NSString *expected) {
    return actual && fabs([actual timeIntervalSinceDate:utc(expected)]) < 1.0;
}

int main(void) { @autoreleasepool {
    NSTimeZone *perth = [NSTimeZone timeZoneForSecondsFromGMT:8 * 3600];
    NSDate *now = utc(@"2026-09-26 13:00");
    NSDictionary *metar = @{ @"raw": @"METAR YPPH 261200Z 14012KT 9999 SCT034 BKN073",
                             @"time": utc(@"2026-09-26 12:00"), @"ceiling_ft": @7300, @"visibility_m": @9999 };
    NSDictionary *liveTAF = taf(@"TAF AMD YPPH 261127Z 2612/2718 14011KT 9999 SCT030 "
                                @"FM261505 14008KT 9999 SCT020 "
                                @"FM262200 14008KT 9999 -SHRA SCT015 BKN020 "
                                @"FM270400 24008KT 9999 -SHRA SCT030 "
                                @"PROB30 INTER 2622/2704 VRB15G25KT 4000 TSRA BKN012 "
                                @"PROB30 TEMPO 2704/2707 VRB20G30KT 2000 TSRA SCT012",
                                @"2026-09-26 12:00", @"2026-09-27 18:00");
    NSDictionary *out = AviationOutlook(aviation(metar, liveTAF), now, perth);
    ck([out[@"observation"] containsString:@"7,300 ft"], @"METAR ceiling");
    ck([out[@"observation"] containsString:@"10+ km"], @"9999 visibility is 10+ km");
    NSArray *periods = out[@"periods"];
    NSDictionary *base = period(periods, @"Base");
    NSDictionary *fm = period(periods, @"FM");
    NSDictionary *probInter = period(periods, @"PROB30 INTER");
    NSDictionary *probTempo = period(periods, @"PROB30 TEMPO");
    ck(base && around(base[@"start"], @"2026-09-26 12:00") && around(base[@"end"], @"2026-09-26 15:05"), @"base uses UTC validity and ends at FM");
    ck(fm && around(fm[@"start"], @"2026-09-26 15:05"), @"FM preserves minutes");
    ck(probInter && around(probInter[@"start"], @"2026-09-26 22:00") && around(probInter[@"end"], @"2026-09-27 04:00"), @"PROB30 INTER has actual UTC window");
    ck(probTempo && [probTempo[@"change"] isEqual:@"PROB30 TEMPO"], @"PROB30 TEMPO is preserved");
    ck([probInter[@"weather"] containsString:@"TSRA"] && [probInter[@"visibility"] containsString:@"4"], @"conditional weather and visibility parse");
    ck([probInter[@"ceilingFt"] doubleValue] == 1200 && [probInter[@"ceilingState"] isEqual:@"value"], @"conditional ceiling is numeric");
    ck([probInter[@"visibilityM"] doubleValue] == 4000 && ![probInter[@"visibilityAtLeast"] boolValue], @"conditional visibility is numeric");
    ck([base[@"ceilingFt"] isKindOfClass:NSNull.class] && [base[@"ceilingState"] isEqual:@"none"], @"SCT-only ceiling is explicit none");
    NSArray *baseClouds = base[@"cloudLayers"];
    ck(baseClouds.count == 1 && [baseClouds[0][@"amount"] isEqual:@"SCT"] && [baseClouds[0][@"baseFt"] doubleValue] == 3000 && [baseClouds[0][@"type"] isEqual:@""], @"SCT cloud layer is retained without becoming a ceiling");
    ck([base[@"visibilityM"] doubleValue] == 9999 && [base[@"visibilityAtLeast"] boolValue], @"9999 metadata keeps lower-bound flag");
    ck([periodStarting(periods, @"FM", @"2026-09-26 22:00")[@"weather"] containsString:@"-SHRA"], @"weather codes without digits parse");

    NSDictionary *minimum = @{ @"raw": @"METAR YPPH 261300Z 00000KT 0000 SCT010 OVC020 BKN008",
                               @"time": utc(@"2026-09-26 13:00"), @"visibility_m": @0 };
    NSDictionary *minimumOut = AviationOutlook(aviation(minimum, nil), now, perth);
    ck([minimumOut[@"observation"] containsString:@"50"], @"0000 visibility remains <=50m");
    ck([minimumOut[@"observation"] containsString:@"800 ft"], @"lowest BKN/OVC ceiling is selected");
    NSDictionary *unknownCeiling = @{ @"raw": @"METAR YPPH 261300Z 00000KT 9999 VV///",
                                      @"time": utc(@"2026-09-26 13:00"), @"visibility_m": @9999 };
    NSDictionary *unknownOut = AviationOutlook(aviation(unknownCeiling, nil), now, perth);
    ck([unknownOut[@"observation"] containsString:@"Unknown"], @"unknown VV/// ceiling is explicit");

    NSDictionary *rollover = taf(@"TAF YPPH 3112/0112 9999 SCT030 FM312300 9999 BKN020 FM010100 4000 -RA BKN008",
                                 @"2026-12-31 12:00", @"2027-01-01 12:00");
    NSArray *rolloverPeriods = AviationOutlook(aviation(nil, rollover), utc(@"2026-12-31 13:00"), perth)[@"periods"];
    NSDictionary *newYearFM = periodStarting(rolloverPeriods, @"FM", @"2027-01-01 01:00");
    ck(newYearFM && around(newYearFM[@"start"], @"2027-01-01 01:00"), @"FM day rolls into next month/year");

    NSDictionary *becmg = taf(@"TAF YPPH 2612/2712 9999 SCT030 BECMG 2620/2622 4000 -RA BKN010 FM270400 9999 CAVOK",
                              @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSArray *becmgPeriods = AviationOutlook(aviation(nil, becmg), now, perth)[@"periods"];
    NSDictionary *transition = period(becmgPeriods, @"BECMG");
    ck(transition && around(transition[@"start"], @"2026-09-26 20:00") && around(transition[@"end"], @"2026-09-26 22:00"), @"BECMG transition keeps its window");
    ck([transition[@"ceilingFt"] doubleValue] == 1000 && [transition[@"visibilityM"] doubleValue] == 4000, @"BECMG inherits and replaces numeric conditions");
    NSDictionary *cavokPeriod = periodStarting(becmgPeriods, @"FM", @"2026-09-27 04:00");
    ck([cavokPeriod[@"ceilingState"] isEqual:@"cavok"] && [cavokPeriod[@"ceilingFt"] isKindOfClass:NSNull.class], @"CAVOK ceiling stays distinct from numeric ceiling");
    ck([cavokPeriod[@"visibilityM"] doubleValue] == 9999 && [cavokPeriod[@"visibilityAtLeast"] boolValue], @"CAVOK visibility is a lower bound");
    ck(period(becmgPeriods, @"After BECMG") != nil, @"forecast after BECMG remains visible");

    NSDictionary *becomingClear = taf(@"TAF YPPH 2612/2712 4000 BKN008 BECMG 2620/2622 CAVOK", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *clear = period(AviationOutlook(aviation(nil,becomingClear),now,perth)[@"periods"],@"After BECMG");
    ck([clear[@"ceilingState"] isEqual:@"cavok"] && [clear[@"ceilingFt"] isKindOfClass:NSNull.class], @"BECMG CAVOK clears inherited numeric ceiling");
    NSDictionary *unknownCloud = taf(@"TAF YPPH 2612/2712 4000 BKN008 VV///", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *unknownPeriod = period(AviationOutlook(aviation(nil,unknownCloud),now,perth)[@"periods"],@"Base");
    ck([unknownPeriod[@"ceilingState"] isEqual:@"unknown"] && [unknownPeriod[@"ceilingFt"] isKindOfClass:NSNull.class], @"unknown vertical visibility cannot plot a definite ceiling");
    NSDictionary *unknownLayer = nil; for (NSDictionary *layer in unknownPeriod[@"cloudLayers"]) if ([layer[@"amount"] isEqual:@"VV"]) unknownLayer = layer;
    ck(unknownLayer && [unknownLayer[@"baseFt"] isKindOfClass:NSNull.class], @"unknown VV layer keeps its unknown base");
    NSDictionary *layersTAF = taf(@"TAF YPPH 2612/2712 9999 FEW020CB SCT030TCU BKN050 OVC080", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *layersPeriod = period(AviationOutlook(aviation(nil,layersTAF),now,perth)[@"periods"], @"Base");
    NSArray *layers = layersPeriod[@"cloudLayers"];
    ck(layers.count == 4 && [layers[0][@"amount"] isEqual:@"FEW"] && [layers[0][@"type"] isEqual:@"CB"] && [layers[1][@"type"] isEqual:@"TCU"] && [layers[2][@"amount"] isEqual:@"BKN"] && [layersPeriod[@"ceilingFt"] doubleValue] == 5000, @"multiple cloud layers retain amount, type and ceiling distinction");
    NSDictionary *replaceClouds = taf(@"TAF YPPH 2612/2712 9999 BKN008 OVC020 BECMG 2620/2622 9999 FEW030", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSArray *replacePeriods = AviationOutlook(aviation(nil,replaceClouds),now,perth)[@"periods"];
    NSDictionary *replace = period(replacePeriods, @"BECMG");
    ck(replace[@"cloudLayers"] && [replace[@"cloudLayers"] count] == 1 && [replace[@"cloudLayers"][0][@"amount"] isEqual:@"FEW"], @"BECMG cloud layers replace inherited layers when supplied");
    NSDictionary *clearClouds = taf(@"TAF YPPH 2612/2712 9999 BKN008 BECMG 2620/2622 CAVOK", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *clearPeriod = period(AviationOutlook(aviation(nil,clearClouds),now,perth)[@"periods"], @"After BECMG");
    ck([clearPeriod[@"cloudLayers"] isEqual:@[]], @"CAVOK explicitly clears inherited cloud layers");
    NSDictionary *missing = AviationOutlook(aviation(nil, nil), now, perth);
    ck([missing[@"observation"] containsString:@"unavailable"], @"missing METAR is explicit");
    ck([missing[@"status"] containsString:@"unavailable"], @"missing TAF is explicit");
    NSDictionary *cancelled = taf(@"TAF AMD YPPH 2612/2712 CNL", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *cancelledOut = AviationOutlook(aviation(nil, cancelled), now, perth);
    ck([cancelledOut[@"periods"] count] == 0 && [cancelledOut[@"status"] containsString:@"cancelled"], @"cancelled TAF is unavailable");
    NSDictionary *nullFields = @{ @"raw": @"METAR YPPH 261300Z 00000KT 9999 SCT020",
                                  @"time": utc(@"2026-09-26 13:00"), @"ceiling_ft": [NSNull null], @"visibility_m": [NSNull null] };
    NSDictionary *nullOut = AviationOutlook(aviation(nullFields, nil), now, perth);
    ck([nullOut[@"observation"] isKindOfClass:NSString.class], @"NSNull METAR numeric fields do not crash");
    NSDictionary *unknownMarker = taf(@"TAF YPPH 2612/2712 9999 SCT030 XYZ 4000 BKN010", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *unknownMarkerOut = AviationOutlook(aviation(nil, unknownMarker), now, perth);
    BOOL rawExposed = NO; for (NSDictionary *p in unknownMarkerOut[@"periods"]) if ([p[@"raw"] containsString:@"XYZ"]) rawExposed = YES;
    ck(rawExposed || [unknownMarkerOut[@"detail"] containsString:@"XYZ"], @"unknown TAF marker remains exposed");
    NSDictionary *invalidFM = taf(@"TAF YPPH 2612/2718 9999 SCT030 FM262400 4000 BKN010", @"2026-09-26 12:00", @"2026-09-27 18:00");
    NSDictionary *invalidOut = AviationOutlook(aviation(nil, invalidFM), now, perth);
    ck([invalidOut[@"periods"] count] == 0 && [invalidOut[@"status"] containsString:@"source"], @"FM hour 24 is rejected, source remains available");
    NSDictionary *expired = taf(@"TAF YPPH 2612/2618 9999 CAVOK", @"2026-09-26 12:00", @"2026-09-26 18:00");
    NSDictionary *expiredOut = AviationOutlook(aviation(nil, expired), utc(@"2026-09-26 18:00"), perth);
    ck([expiredOut[@"status"] containsString:@"expired"], @"TAF expires at valid_to boundary");
    ck([expiredOut[@"periods"] count] == 0, @"expired TAF has no forecast periods");

    NSDictionary *remarks = taf(@"TAF YSSY 010500Z 0106/0212 18015KT 9999 FEW040 "
        @"FM011200 16012KT 9999 SCT025 "
        @"RMK T 18 22 24 21 Q 1018 1017 1016 1017",
        @"2026-10-01 06:00", @"2026-10-02 12:00");
    NSArray *remarkPeriods = AviationOutlook(aviation(nil, remarks), utc(@"2026-10-01 06:30"),
        [NSTimeZone timeZoneWithName:@"Australia/Sydney"])[@"periods"];
    NSDictionary *remarkBase = period(remarkPeriods, @"Base");
    ck([remarkBase[@"visibilityM"] doubleValue] == 9999 && [remarkBase[@"visibility"] isEqual:@"10+ km"],
        @"Australian TAF remarks do not replace 9999 visibility");
    BOOL qnh = NO;
    for (NSDictionary *p in remarkPeriods) {
        double metres = [p[@"visibilityM"] doubleValue];
        if (metres == 1018 || metres == 1017 || metres == 1016) qnh = YES;
    }
    ck(!qnh && remarkPeriods.count >= 2, @"QNH groups after RMK are not visibility");
    NSDictionary *second = taf(@"TAF YPPH 2612/2712 9999 4000 SCT030", @"2026-09-26 12:00", @"2026-09-27 12:00");
    NSDictionary *secondBase = period(AviationOutlook(aviation(nil, second), now, perth)[@"periods"], @"Base");
    ck([secondBase[@"visibilityM"] doubleValue] == 9999 && [secondBase[@"visibilityAtLeast"] boolValue],
        @"a group keeps only its first visibility token");
}
return failures ? 1 : 0;
}
