#import "feedback.h"
#import <mach/mach_time.h>
#import <dispatch/dispatch.h>

static NSMutableArray<NSDictionary *> *sEvents;
static NSObject *sLock;
static double sSecondsPerTick;
#ifdef ISOBAR_FEEDBACK_TESTING
static double sTestUptime = -1;
void FeedbackTestSetUptime(double value) { sTestUptime = value; }
#endif
static double FeedbackUptime(void) {
#ifdef ISOBAR_FEEDBACK_TESTING
    if (sTestUptime >= 0) return sTestUptime;
#endif
    return (double)mach_absolute_time() * sSecondsPerTick;
}
static void EnsureLog(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{ sLock = [NSObject new]; sEvents = [NSMutableArray array]; mach_timebase_info_data_t info; mach_timebase_info(&info); sSecondsPerTick = 1e-9 * (double)info.numer / (double)info.denom; });
}
static id JSONCopy(id value) {
    if (!value) return [NSNull null];
    if (![NSJSONSerialization isValidJSONObject:value]) return [NSNull null];
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    id copy = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : value;
    return [copy copy];
}

static NSString *ISODate(NSDate *date) {
    if (!date) return nil;
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    return [formatter stringFromDate:date];
}

void FeedbackLog(NSString *category, NSDictionary *details) {
    EnsureLog();
    if (!category.length) return;
    @synchronized (sLock) {
        NSDate *now = [NSDate date];
        NSDictionary *event = @{ @"category": [category copy], @"at": ISODate(now) ?: [NSNull null], @"data": JSONCopy(details ?: @{}), @"_mono": @(FeedbackUptime()) };
        [sEvents addObject:event];
        double cutoff = FeedbackUptime() - 60.0;
        while (sEvents.count > 500) [sEvents removeObjectAtIndex:0];
        while (sEvents.count && [sEvents[0][@"_mono"] doubleValue] < cutoff) {
            [sEvents removeObjectAtIndex:0];
        }
    }
}

NSArray<NSDictionary *> *FeedbackRecent(void) {
    EnsureLog();
    @synchronized (sLock) {
        double cutoff = FeedbackUptime() - 60.0;
        while (sEvents.count && [sEvents[0][@"_mono"] doubleValue] < cutoff) [sEvents removeObjectAtIndex:0];
        NSMutableArray *result = [NSMutableArray arrayWithCapacity:sEvents.count];
        for (NSDictionary *event in sEvents) { NSMutableDictionary *copy = [event mutableCopy]; [copy removeObjectForKey:@"_mono"]; [result addObject:[copy copy]]; }
        return [result copy];
    }
}

NSURL *FeedbackDefaultInbox(void) {
    NSString *root = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    return [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"Isobar/feedback"] isDirectory:YES];
}

NSDictionary *FeedbackRecord(NSDictionary *state, NSDictionary *app, NSDate *capturedAt,
                             NSTimeZone *timezone, NSArray<NSDictionary *> *recent,
                             NSString *note, NSArray<NSString *> *files, NSString *surface) {
    NSDate *date = capturedAt ?: [NSDate date];
    NSTimeZone *zone = timezone ?: [NSTimeZone localTimeZone];
    NSDateFormatter *local = [[NSDateFormatter alloc] init];
    local.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    local.dateFormat = @"yyyy-MM-dd'T'HH:mm:ssZZZZZ";
    local.timeZone = zone;
    id appCopy = JSONCopy(app ?: @{}); id stateCopy = JSONCopy(state ?: @{}); id recentCopy = JSONCopy(recent ?: @[]); id filesCopy = JSONCopy(files ?: @[]);
    return @{ @"schema": @"isobar-feedback/1",
              @"surface": surface ?: @"mac",
              @"captured_at": ISODate(date) ?: [NSNull null],
              @"local_time": [local stringFromDate:date] ?: [NSNull null],
              @"note": note.length ? [note copy] : [NSNull null],
              @"app": [appCopy isKindOfClass:[NSDictionary class]] ? appCopy : @{},
              @"state": [stateCopy isKindOfClass:[NSDictionary class]] ? stateCopy : @{},
              @"recent": [recentCopy isKindOfClass:[NSArray class]] ? recentCopy : @[],
              @"files": [filesCopy isKindOfClass:[NSArray class]] ? filesCopy : @[] };
}

NSURL *FeedbackWrite(NSURL *inbox, NSDictionary *record,
                     NSDictionary<NSString *, NSData *> *images, NSError **error) {
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new]; iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    NSDate *captured = [record[@"captured_at"] isKindOfClass:[NSString class]] ? [iso dateFromString:record[@"captured_at"]] : nil;
    if (!captured && [record[@"captured_at"] isKindOfClass:NSString.class]) {
        iso.formatOptions |= NSISO8601DateFormatWithFractionalSeconds;
        captured = [iso dateFromString:record[@"captured_at"]];
    }
    if (!inbox || !record || ![record[@"schema"] isEqual:@"isobar-feedback/1"] || ![@[@"mac", @"web"] containsObject:record[@"surface"] ?: NSNull.null] || !captured || ![NSJSONSerialization isValidJSONObject:record]) { if (error) *error = [NSError errorWithDomain:@"IsobarFeedback" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Invalid feedback record"}]; return nil; }
    NSArray *files = [record[@"files"] isKindOfClass:[NSArray class]] ? record[@"files"] : @[];
    NSSet *fileSet = [NSSet setWithArray:files];
    NSSet *imageSet = [NSSet setWithArray:images.allKeys ?: @[]];
    if (![fileSet isEqualToSet:imageSet]) { if (error) *error = [NSError errorWithDomain:@"IsobarFeedback" code:3 userInfo:@{NSLocalizedDescriptionKey: @"Record files do not match attachments"}]; return nil; }
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm createDirectoryAtURL:inbox withIntermediateDirectories:YES attributes:nil error:error]) return nil;
    NSDateFormatter *dirnameFormatter = [NSDateFormatter new]; dirnameFormatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]; dirnameFormatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0]; dirnameFormatter.dateFormat = @"yyyyMMdd'T'HHmmss'Z'";
    NSString *compact = [dirnameFormatter stringFromDate:captured];
    NSString *surface = [record[@"surface"] isKindOfClass:[NSString class]] ? record[@"surface"] : @"mac";
    NSString *name = [NSString stringWithFormat:@"%@-%@-%06x", compact, surface, arc4random_uniform(0x1000000)];
    NSURL *finalURL = [inbox URLByAppendingPathComponent:name isDirectory:YES];
    NSURL *tempURL = [inbox URLByAppendingPathComponent:[NSString stringWithFormat:@".feedback-%@-%u", name, arc4random()]
                                                   isDirectory:YES];
    if (![fm createDirectoryAtURL:tempURL withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:error]) return nil;
    BOOL ok = YES;
    NSError *writeError = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingPrettyPrinted error:&writeError];
    ok = json && [json writeToURL:[tempURL URLByAppendingPathComponent:@"feedback.json"] options:NSDataWritingAtomic error:&writeError];
    for (id key in images) {
        NSData *data = [key isKindOfClass:[NSString class]] ? images[key] : nil;
        if (!ok) break;
        if (![key isKindOfClass:[NSString class]] || ![key length] || [key isEqualToString:@"feedback.json"] || [key containsString:@"/"] || [key containsString:@".."] || ![data isKindOfClass:[NSData class]]) {
            ok = NO; writeError = [NSError errorWithDomain:@"IsobarFeedback" code:2 userInfo:@{NSLocalizedDescriptionKey: @"Invalid feedback attachment"}]; break;
        }
        ok = [data writeToURL:[tempURL URLByAppendingPathComponent:key] options:NSDataWritingAtomic error:&writeError];
    }
    if (!ok && error) *error = writeError;
    if (ok) { [fm setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:[tempURL.path stringByAppendingPathComponent:@"feedback.json"] error:NULL]; for (id key in images) if ([key isKindOfClass:[NSString class]]) [fm setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:[tempURL.path stringByAppendingPathComponent:key] error:NULL]; ok = [fm moveItemAtURL:tempURL toURL:finalURL error:error]; }
    if (!ok) [fm removeItemAtURL:tempURL error:NULL];
    return ok ? finalURL : nil;
}
