// Unit test for the native E6-B wind triangle against the shared JSON fixture.
#import <Foundation/Foundation.h>
#import "e6b.h"
#include <math.h>

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s %s\n", condition ? "ok  " : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static BOOL Close(double actual, id expected, double tolerance) {
    if (expected == [NSNull null]) return isnan(actual);
    return isfinite(actual) && fabs(actual - [expected doubleValue]) <= tolerance;
}

int main(void) {
    @autoreleasepool {
        NSString *root = [NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] stringByExpandingTildeInPath];
        NSString *path = [root stringByAppendingPathComponent:@"e6b/wind.json"];
        NSData *data = [NSData dataWithContentsOfFile:path];
        check(data.length > 0, @"shared E6-B wind fixture loads");
        NSError *error = nil;
        NSDictionary *document = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        check(document != nil && error == nil, @"shared E6-B wind fixture parses");
        NSArray *cases = document[@"cases"];
        check(cases.count >= 20, @"fixture has at least twenty cases");
        for (NSDictionary *item in cases) {
            NSDictionary *input = item[@"input"];
            NSDictionary *expected = item[@"expected"];
            NSString *label = item[@"id"];
            NSString *kind = item[@"kind"];
            if ([kind isEqualToString:@"heading"]) {
                E6BHeadingResult actual;
                BOOL valid = E6BSolveHeading([input[@"tc"] doubleValue], [input[@"tas"] doubleValue],
                                              [input[@"windFrom"] doubleValue], [input[@"windKt"] doubleValue], &actual);
                BOOL expectedValid = expected[@"wca"] != [NSNull null];
                check(valid == expectedValid, [label stringByAppendingString:@" heading validity"]);
                check(Close(actual.wca, expected[@"wca"], 0.5), [label stringByAppendingString:@" WCA"]);
                check(Close(actual.th, expected[@"th"], 0.5), [label stringByAppendingString:@" TH"]);
                check(Close(actual.gs, expected[@"gs"], 0.5), [label stringByAppendingString:@" GS"]);
            } else {
                E6BWindResult actual;
                BOOL valid = E6BSolveWind([input[@"th"] doubleValue], [input[@"tc"] doubleValue],
                                           [input[@"tas"] doubleValue], [input[@"gs"] doubleValue], &actual);
                BOOL expectedValid = expected[@"from"] != [NSNull null];
                check(valid == expectedValid, [label stringByAppendingString:@" wind validity"]);
                check(Close(actual.from, expected[@"from"], 0.5), [label stringByAppendingString:@" wind direction"]);
                check(Close(actual.kt, expected[@"kt"], 0.5), [label stringByAppendingString:@" wind speed"]);
            }
        }

        check(E6BWrap360(0.0) == 0.0, @"wrap 0");
        check(E6BWrap360(360.0) == 0.0, @"wrap 360");
        check(fabs(E6BWrap360(-1.0) - 359.0) < 1e-12, @"wrap negative");
        check(fabs(E6BWrap360(721.0) - 1.0) < 1e-12, @"wrap above two turns");
        check(E6BSigned180(180.0) == 180.0, @"signed 180 positive bound");
        check(E6BSigned180(-180.0) == 180.0, @"signed 180 negative bound");
        check(fabs(E6BSigned180(181.0) + 179.0) < 1e-12, @"signed wraps positive");
        check(fabs(E6BSigned180(-181.0) - 179.0) < 1e-12, @"signed wraps negative");

        E6BHeadingResult heading;
        check(!E6BSolveHeading(NAN, 100.0, 0.0, 10.0, &heading), @"heading rejects NaN");
        check(isnan(heading.wca) && isnan(heading.th) && isnan(heading.gs), @"heading NaN outputs");
        E6BWindResult wind;
        check(!E6BSolveWind(0.0, 0.0, INFINITY, 100.0, &wind), @"wind rejects infinity");
        check(isnan(wind.from) && isnan(wind.kt), @"wind NaN outputs");
    }
    return failures ? 1 : 0;
}
