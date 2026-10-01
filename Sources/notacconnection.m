#import "notacconnection.h"
#import <Security/Security.h>
#import <signal.h>

NSString * const IsobarNotacErrorDomain = @"com.iantodd.isobar.notac";

static NSError *NotacError(NSString *message) {
    return [NSError errorWithDomain:IsobarNotacErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

BOOL IsobarNotacTokenIsValid(NSString *token) {
    if (![token isKindOfClass:NSString.class] || token.length != 43 || ![token hasPrefix:@"lb_"]) return NO;
    NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF"];
    NSString *body = [token substringFromIndex:3];
    return body.length == 40 && [body rangeOfCharacterFromSet:[hex invertedSet]].location == NSNotFound;
}

@interface IsobarNotacSystemKeychain : NSObject <IsobarNotacKeychain>
- (instancetype)initWithService:(NSString *)service account:(NSString *)account;
@end

@implementation IsobarNotacSystemKeychain {
    NSString *_service;
    NSString *_account;
}
- (instancetype)initWithService:(NSString *)service account:(NSString *)account {
    if ((self = [super init])) { _service = [service copy]; _account = [account copy]; }
    return self;
}
- (NSDictionary *)query {
    // The login Keychain works for both self-built and Developer ID copies.
    // Data Protection Keychain requires an app-identifier entitlement that
    // command-line/FOSS builds do not have by default.
    return @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
             (__bridge id)kSecAttrService: _service,
             (__bridge id)kSecAttrAccount: _account};
}
- (BOOL)saveToken:(NSString *)token error:(NSError **)error {
    if (!IsobarNotacTokenIsValid(token)) { if (error) *error = NotacError(@"The NOTAC key is invalid"); return NO; }
    NSDictionary *query = [self query];
    OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
                                    (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: [token dataUsingEncoding:NSUTF8StringEncoding]});
    if (status == errSecItemNotFound) {
        NSMutableDictionary *item = [query mutableCopy];
        item[(__bridge id)kSecValueData] = [token dataUsingEncoding:NSUTF8StringEncoding];
        status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
    }
    if (status != errSecSuccess) { if (error) *error = NotacError(@"The NOTAC key could not be saved"); return NO; }
    return YES;
}
- (NSString *)loadToken:(NSError **)error {
    NSMutableDictionary *query = [[self query] mutableCopy];
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef value = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &value);
    if (status == errSecItemNotFound) { if (error) *error = NotacError(@"No NOTAC key is saved"); return nil; }
    if (status != errSecSuccess || !value) { if (error) *error = NotacError(@"The NOTAC key could not be read"); if (value) CFRelease(value); return nil; }
    NSData *data = CFBridgingRelease(value);
    NSString *token = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!IsobarNotacTokenIsValid(token)) { if (error) *error = NotacError(@"The saved NOTAC key is invalid"); return nil; }
    return token;
}
- (BOOL)removeToken:(NSError **)error {
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)[self query]);
    if (status != errSecSuccess && status != errSecItemNotFound) { if (error) *error = NotacError(@"The NOTAC key could not be removed"); return NO; }
    return YES;
}
@end

@implementation IsobarNotacConnection {
    id<IsobarNotacKeychain> _keychain;
}
static NSString *FetchFailure(NSData *diagnostics, BOOL timedOut) {
    if (timedOut) return @"NOTAC timed out; try again";
    NSString *text=[[NSString alloc] initWithData:diagnostics encoding:NSUTF8StringEncoding] ?: @"";
    if ([text containsString:@"HTTP 401"]) return @"NOTAC rejected this key";
    if ([text containsString:@"HTTP 402"]) return @"NOTAC credits are exhausted";
    if ([text containsString:@"HTTP 403"]) return @"NOTAC access was refused";
    if ([text containsString:@"HTTP 429"]) return @"NOTAC is busy; try later";
    if ([text containsString:@"connection failed"]) return @"NOTAC could not be reached";
    if ([text containsString:@"request limit reached"]) return @"Too many notices for one refresh";
    return @"NOTAMs could not update";
}
- (instancetype)init { return [self initWithService:@"com.iantodd.isobar.notac" account:@"api-token" keychain:nil]; }
- (instancetype)initWithService:(NSString *)service account:(NSString *)account keychain:(id<IsobarNotacKeychain>)keychain {
    if ((self = [super init])) {
        _keychain = keychain ?: [[IsobarNotacSystemKeychain alloc] initWithService:service account:account];
    }
    return self;
}
- (BOOL)saveToken:(NSString *)token error:(NSError **)error { return [_keychain saveToken:token error:error]; }
- (NSString *)loadToken:(NSError **)error { return [_keychain loadToken:error]; }
- (BOOL)removeToken:(NSError **)error { return [_keychain removeToken:error]; }

- (void)fetchWithDataDirectory:(NSString *)dataDirectory executableURL:(NSURL *)executableURL completion:(void (^)(BOOL, NSString *))completion {
    NSString *root = [dataDirectory copy];
    NSURL *executable = [executableURL copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *keyError = nil;
        NSString *token = [self loadToken:&keyError];
        if (!token) { if (completion) completion(NO, @"No NOTAC key is saved"); return; }
        if (!root.length || !executable.isFileURL || ![NSFileManager.defaultManager isExecutableFileAtPath:executable.path]) {
            if (completion) completion(NO, @"The NOTAC collector is unavailable"); return;
        }
        if (![NSFileManager.defaultManager createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil]) {
            if (completion) completion(NO, @"The weather archive is unavailable"); return;
        }
        NSTask *task = [NSTask new];
        task.executableURL = executable;
        task.arguments = @[@"fetch-notams", @"--token-stdin", @"--data-dir", root];
        task.currentDirectoryURL = [NSURL fileURLWithPath:root isDirectory:YES];
        NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
        [environment removeObjectForKey:@"PYTHONPATH"]; [environment removeObjectForKey:@"PYTHONHOME"];
        environment[@"PATH"] = @"/usr/bin:/bin:/usr/sbin:/sbin";
        task.environment = environment;
        NSPipe *input = [NSPipe pipe];
        NSPipe *diagnostics = [NSPipe pipe];
        task.standardInput = input;
        // Only inspect bounded diagnostics for known status codes. No provider
        // text or token is returned to the UI or written to the app log.
        task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
        task.standardError = diagnostics;
        NSError *launchError = nil;
        if (![task launchAndReturnError:&launchError]) { if (completion) completion(NO, @"The NOTAC collector could not start"); return; }
        @try {
            [input.fileHandleForWriting writeData:[[token stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
            [input.fileHandleForWriting closeFile];
        } @catch (__unused NSException *exception) {
            [task terminate];
            if (completion) completion(NO, @"The NOTAC collector could not receive its key");
            return;
        }
        __block BOOL timedOut=NO;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,180*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
            @synchronized(task) { if (task.running) { timedOut=YES; [task terminate]; } }
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,190*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
            @synchronized(task) { if (task.running) kill(task.processIdentifier,SIGKILL); }
        });
        NSMutableData *bounded=[NSMutableData data];
        while (YES) {
            NSData *chunk=[diagnostics.fileHandleForReading readDataOfLength:2048];
            if (!chunk.length) break;
            if (bounded.length<4096) [bounded appendData:[chunk subdataWithRange:NSMakeRange(0,MIN(chunk.length,4096-bounded.length))]];
        }
        [task waitUntilExit];
        BOOL expired=NO; @synchronized(task) { expired=timedOut; }
        if (completion) completion(task.terminationStatus == 0,
                                   task.terminationStatus == 0 ? @"NOTAMs updated" : FetchFailure(bounded,expired));
    });
}
@end
