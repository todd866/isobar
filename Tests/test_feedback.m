#import <Foundation/Foundation.h>
#import "feedback.h"
extern void FeedbackTestSetUptime(double value);

static int checks;
static void Check(BOOL condition, NSString *message) {
    checks++;
    if (!condition) { NSLog(@"FAIL: %@", message); exit(1); }
}

int main(void) {
    @autoreleasepool {
        FeedbackTestSetUptime(0);
        Check(FeedbackRecent().count == 0, @"recent before first event");
        for (NSUInteger i = 0; i < 510; i++) FeedbackLog(@"test", @{@"n": @(i)});
        NSArray *events = FeedbackRecent();
        Check(events.count == 500, @"ring buffer bound");
        Check([events.firstObject[@"data"][@"n"] integerValue] == 10 &&
              [events.lastObject[@"data"][@"n"] integerValue] == 509, @"ring chronological order");
        NSMutableDictionary *nested = [@{@"value": @1} mutableCopy];
        FeedbackLog(@"immutable", @{@"nested": nested});
        nested[@"value"] = @2;
        Check([FeedbackRecent().lastObject[@"data"][@"nested"][@"value"] isEqual:@1], @"deep immutable event snapshot");
        FeedbackTestSetUptime(61);
        Check(FeedbackRecent().count == 0, @"idle events expire at read after sixty seconds");
        FeedbackLog(@"fresh", @{@"missing": NSNull.null});
        Check(FeedbackRecent().count == 1, @"log accepts events after idle expiry");
        NSDate *captured = [[NSISO8601DateFormatter new] dateFromString:@"2026-10-15T01:02:03Z"];
        NSDictionary *record = FeedbackRecord(@{@"missing": NSNull.null}, @{}, captured,
            [NSTimeZone timeZoneWithName:@"Australia/Perth"], events, @"", @[@"screen.png"], @"mac");
        Check(record[@"note"] == NSNull.null && [record[@"local_time"] hasSuffix:@"+08:00"], @"empty note null and local offset");
        Check([NSJSONSerialization isValidJSONObject:record], @"record is valid JSON");
        NSURL *root = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString] isDirectory:YES];
        NSFileManager *fm = NSFileManager.defaultManager;
        @try {
            NSError *error = nil;
            NSData *image = [@"png" dataUsingEncoding:NSUTF8StringEncoding];
            NSURL *written = FeedbackWrite(root, record, @{@"screen.png": image}, &error);
            Check(written && !error, @"atomic writer succeeds");
            Check([written.lastPathComponent hasPrefix:@"20261015T010203Z-mac-"] && written.lastPathComponent.length == 27,
                @"directory follows shared timestamp-surface-six-hex format");
            NSData *json = [NSData dataWithContentsOfURL:[written URLByAppendingPathComponent:@"feedback.json"]];
            NSDictionary *saved = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
            Check([saved[@"schema"] isEqual:@"isobar-feedback/1"] && saved[@"state"][@"missing"] == NSNull.null && saved[@"note"] == NSNull.null,
                @"on-disk schema and nulls survive round trip");
            Check([[NSData dataWithContentsOfURL:[written URLByAppendingPathComponent:@"screen.png"]] isEqual:image], @"attachment bytes preserved");
            for (NSString *bad in @[@"../escape.png", @"feedback.json"]) {
                NSMutableDictionary *invalid = [record mutableCopy]; invalid[@"files"] = @[bad]; error = nil;
                Check(!FeedbackWrite(root, invalid, @{bad:image}, &error) && error, @"unsafe attachment rejected");
            }
            NSMutableDictionary *invalid = [record mutableCopy]; invalid[@"state"] = @{@"date": NSDate.date}; error = nil;
            Check(!FeedbackWrite(root, invalid, @{@"screen.png":image}, &error) && error, @"non-JSON payload rejected without exception");
            invalid = [record mutableCopy]; invalid[@"captured_at"] = @"not a date";
            Check(!FeedbackWrite(root, invalid, @{@"screen.png":image}, nil), @"invalid timestamp rejected");
            Check(!FeedbackWrite(root, record, @{}, nil), @"attachment mismatch rejected");
            Check([fm contentsOfDirectoryAtURL:root includingPropertiesForKeys:nil options:0 error:nil].count == 1,
                @"failed writes leave neither final nor staging directories");
            NSDictionary *web = FeedbackRecord(@{}, @{}, captured, nil, nil, @"  verbatim  ", @[], @"web");
            Check(FeedbackWrite(root, web, @{}, nil) != nil, @"shared envelope permits web records without screenshots");
            NSDictionary *attributes = [fm attributesOfItemAtPath:written.path error:nil];
            Check([attributes[NSFilePosixPermissions] unsignedIntegerValue] == 0700, @"complaint directory is owner-only");
        } @finally { [fm removeItemAtURL:root error:nil]; }
        FeedbackTestSetUptime(-1);
    }
    printf("feedback: %d checks passed\n", checks);
    return 0;
}
