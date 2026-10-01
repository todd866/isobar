#import <Foundation/Foundation.h>
#import "pure.h"

static int failures = 0;
static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s %s\n", condition ? "ok  " : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSData *XML(NSString *text) {
    return [text dataUsingEncoding:NSUTF8StringEncoding];
}

int main(void) {
    @autoreleasepool {
        NSString *active =
        @"<?xml version=\"1.0\"?><product><amoc>"
        @"<source><region>New South Wales</region></source><identifier>IDN21033</identifier>"
        @"<issue-time-utc>2026-09-26T11:22:18Z</issue-time-utc>"
        @"<expiry-time>2026-09-26T16:22:15Z</expiry-time><status>O</status><phase>NEW</phase>"
        @"</amoc><warning><warning-info>"
        @"<text type=\"warning_title\"><p>Severe Thunderstorm Warning</p></text>"
        @"<text type=\"warning_area_summary\"><p>parts of Central Tablelands.</p></text>"
        @"<text type=\"warning_phenomena_summary\">for DAMAGING WINDS and HAIL.</text>"
        @"</warning-info><forecast-period><warning-summary><p>Other warnings may be current.</p></warning-summary></forecast-period>"
        @"</warning></product>";
        NSArray *warnings = ParseWarningXML(XML(active));
        NSDictionary *warning = warnings.firstObject;
        check(warnings.count == 1, @"real Bureau product is parsed");
        check([warning[@"id"] isEqual:@"IDN21033"] && [warning[@"state"] isEqual:@"NSW"], @"identifier and region normalize state");
        check([warning[@"title"] isEqual:@"Severe Thunderstorm Warning for New South Wales"], @"title includes broad region");
        check([warning[@"shortTitle"] isEqual:@"Severe Thunderstorm Warning"], @"short title removes summary suffix only");
        check([warning[@"text"] containsString:@"DAMAGING WINDS"], @"warning body keeps phenomena");
        check([warning[@"expires"] isKindOfClass:NSDate.class], @"expiry metadata is an NSDate");
        check([warning[@"issue"] isKindOfClass:NSDate.class], @"issue metadata is an NSDate");

        NSString *marine =
        @"<product><amoc><source><region>New South Wales</region></source><identifier>IDN20400</identifier>"
        @"<expiry-time>2026-09-27T14:00:00Z</expiry-time><status>O</status><phase>UPD</phase></amoc>"
        @"<warning><warning-info><text type=\"warning_title\">Marine Wind Warning Summary for New South Wales</text></warning-info>"
        @"<forecast-period><warning-summary><p>Gale Warning for Sydney Coast</p></warning-summary>"
        @"<hazard phase=\"CAN\"><text type=\"warning_phenomena\">Cancellation</text></hazard>"
        @"<hazard phase=\"UPD\"><text type=\"warning_phenomena\">Strong Wind Warning</text></hazard></forecast-period></warning></product>";
        NSDictionary *marineWarning = ParseWarningXML(XML(marine)).firstObject;
        check(marineWarning != nil && [marineWarning[@"text"] containsString:@"Gale Warning"], @"active product survives a cancelled hazard");

        NSString *cancelled =
        @"<product><amoc><identifier>IDW20100</identifier><status>C</status><phase>CAN</phase></amoc>"
        @"<warning><warning-info><text type=\"warning_title\">Cancelled warning</text></warning-info></warning></product>";
        check(ParseWarningXML(XML(cancelled)).count == 0, @"cancelled product is inactive");
        check(ParseWarningXML(XML(@"<product><amoc><phase>NEW</phase></amoc>")).count == 0, @"malformed product is ignored");
        check(ParseWarningXML(XML(@"<!DOCTYPE product SYSTEM \"https://example.invalid/warning.dtd\"><product/>" )).count == 0,
              @"external entity declarations are rejected");
        NSString *legacy = @"<warnings><warning><id>IDW20100</id><title>Marine Wind Warning</title><phase>active</phase><text>Strong wind.</text></warning></warnings>";
        check(ParseWarningXML(XML(legacy)).count == 1, @"legacy fixture schema remains supported");
    }
    return failures ? 1 : 0;
}
