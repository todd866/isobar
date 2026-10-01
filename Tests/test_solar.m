#import <Cocoa/Cocoa.h>
#import "solar.h"
#include <math.h>
#include <stdio.h>

static int failures;
static void Check(BOOL ok, NSString *message) {
    if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); failures++; }
}
static NSDate *UTC(NSString *value) {
    return [[NSISO8601DateFormatter new] dateFromString:value];
}
static double MinutesBetween(NSDate *a, NSDate *b) {
    return fabs([a timeIntervalSinceDate:b]) / 60.0;
}

int main(void) {
    @autoreleasepool {
        NSDate *noon = UTC(@"2026-09-27T04:00:00Z"); // noon in Perth
        NSDate *midnight = UTC(@"2026-09-26T16:00:00Z");
        double noonElevation = SolarElevation(-31.994, 115.75, noon);
        Check(noonElevation > 50.0 && noonElevation < 60.0, @"Perth noon elevation");
        Check(SolarElevation(-31.994, 115.75, midnight) < -20.0, @"Perth midnight elevation");
        Check(isnan(SolarElevation(91.0, 115.75, noon)), @"invalid latitude");
        Check(isnan(SolarElevation(-31.994, NAN, noon)), @"invalid longitude");

        NSTimeZone *perth = [NSTimeZone timeZoneWithName:@"Australia/Perth"];
        NSDictionary *day = SolarDaylight(-31.994, 115.75, noon, perth);
        Check([day[@"state"] isEqual:@"day"], @"Perth noon state");
        Check(day[@"civilDawn"] && day[@"civilDusk"], @"Perth civil events");
        Check(MinutesBetween(day[@"civilDawn"], UTC(@"2026-09-26T21:36:00Z")) < 1.0, @"Perth civil dawn");
        Check(MinutesBetween(day[@"civilDusk"], UTC(@"2026-09-27T10:41:00Z")) < 1.0, @"Perth civil dusk");
        Check(day[@"sunrise"] && day[@"sunset"], @"Perth solar events");
        Check([day[@"civilDawn"] compare:day[@"civilDusk"]] == NSOrderedAscending, @"dawn before dusk");
        NSDictionary *beforeDawn = SolarDaylight(-31.994, 115.75, UTC(@"2026-09-26T21:35:00Z"), perth);
        NSDictionary *afterDawn = SolarDaylight(-31.994, 115.75, UTC(@"2026-09-26T21:37:00Z"), perth);
        Check([beforeDawn[@"state"] isEqual:@"night"] && ![afterDawn[@"state"] isEqual:@"night"], @"civil dawn state boundary");
        // Independent US Naval Observatory reference, retrieved 2026-09-27:
        // https://aa.usno.navy.mil/api/rstt/oneday?date=2026-09-27&coords=-31.9403,115.967003&tz=8
        // YPPH, local +08: BCT 05:35, sunrise 06:00, sunset 18:15, ECT 18:40.
        NSDictionary *airport=SolarDaylight(-31.9403,115.967003,noon,perth);
        Check(MinutesBetween(airport[@"civilDawn"],UTC(@"2026-09-26T21:35:00Z"))<1,@"USNO independent YPPH civil dawn");
        Check(MinutesBetween(airport[@"civilDusk"],UTC(@"2026-09-27T10:40:00Z"))<1,@"USNO independent YPPH civil dusk");
        Check(MinutesBetween(airport[@"sunrise"],UTC(@"2026-09-26T22:00:00Z"))<1,@"USNO independent YPPH sunrise");
        Check(MinutesBetween(airport[@"sunset"],UTC(@"2026-09-27T10:15:00Z"))<1,@"USNO independent YPPH sunset");
        Check([airport[@"civilEvents"] count]==2,@"directional civil event list is retained");
        NSDictionary *night = SolarDaylight(-31.994, 115.75, midnight, perth);
        Check([night[@"state"] isEqual:@"night"], @"Perth night state");

        // Same absolute instant, different longitude: timezone must not alter elevation.
        NSDate *instant = UTC(@"2026-06-21T06:00:00Z");
        double west = SolarElevation(0.0, -75.0, instant);
        double east = SolarElevation(0.0, 75.0, instant);
        Check(west < 0.0 && east > 0.0, @"longitude changes solar time");

        // The instant's state is independent of the display timezone, while event
        // dates follow the requested local civil date (including DST-length days).
        NSDate *sydneyInstant = UTC(@"2026-10-03T16:00:00Z");
        NSDictionary *sydneyDST = SolarDaylight(-33.86, 151.20, sydneyInstant,
                                                  [NSTimeZone timeZoneWithName:@"Australia/Sydney"]);
        NSDictionary *sydneyUTC = SolarDaylight(-33.86, 151.20, sydneyInstant,
                                                 [NSTimeZone timeZoneForSecondsFromGMT:0]);
        Check(sydneyDST[@"civilDawn"] && sydneyDST[@"civilDusk"], @"Sydney DST civil events");
        Check([sydneyDST[@"state"] isEqual:sydneyUTC[@"state"]], @"timezone independent state");
        Check([sydneyDST[@"civilDawn"] compare:sydneyDST[@"civilDusk"]] == NSOrderedAscending, @"Sydney DST dawn before dusk");

        // A timezone/date boundary must retain the event direction even when the
        // chosen local date begins after the day's sunset in UTC.
        NSDictionary *eastDate = SolarDaylight(0.0, 170.0, UTC(@"2026-06-21T00:00:00Z"),
                                                [NSTimeZone timeZoneForSecondsFromGMT:0]);
        Check(eastDate[@"civilDawn"] && eastDate[@"civilDusk"], @"date boundary events");
        NSDate *eastDawn = eastDate[@"civilDawn"], *eastDusk = eastDate[@"civilDusk"];
        Check(SolarElevation(0.0, 170.0, [eastDawn dateByAddingTimeInterval:-120]) < -6.0 &&
              SolarElevation(0.0, 170.0, [eastDawn dateByAddingTimeInterval:120]) > -6.0 &&
              SolarElevation(0.0, 170.0, [eastDusk dateByAddingTimeInterval:-120]) > -6.0 &&
              SolarElevation(0.0, 170.0, [eastDusk dateByAddingTimeInterval:120]) < -6.0,
              @"directional event labels");

        // Polar day and polar night have no civil events on their local date.
        NSDictionary *polarDay = SolarDaylight(89.0, 0.0, UTC(@"2026-06-21T12:00:00Z"), [NSTimeZone timeZoneForSecondsFromGMT:0]);
        NSDictionary *polarNight = SolarDaylight(89.0, 0.0, UTC(@"2026-12-21T12:00:00Z"), [NSTimeZone timeZoneForSecondsFromGMT:0]);
        Check(!polarDay[@"civilDawn"] && !polarDay[@"civilDusk"], @"polar day omits events");
        Check([polarNight[@"state"] isEqual:@"night"] && !polarNight[@"civilDawn"], @"polar night state");
        Check(SolarDaylight(91.0, 0.0, noon, perth).count == 0, @"invalid daylight input");
    }
    if (failures) fprintf(stderr, "%d solar test(s) failed\n", failures);
    return failures ? 1 : 0;
}
