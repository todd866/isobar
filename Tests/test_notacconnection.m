#import "notacconnection.h"
#import <Foundation/Foundation.h>
#import <sys/stat.h>

static int failures = 0;
static void check(BOOL ok, NSString *message) { fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String); if (!ok) failures++; }

@interface FakeKeychain : NSObject <IsobarNotacKeychain>
@property(nonatomic, copy) NSString *token;
@end
@implementation FakeKeychain
- (BOOL)saveToken:(NSString *)token error:(NSError **)error { if (!IsobarNotacTokenIsValid(token)) { if (error) *error = [NSError errorWithDomain:@"test" code:1 userInfo:nil]; return NO; } self.token = token; return YES; }
- (NSString *)loadToken:(NSError **)error { if (!self.token && error) *error = [NSError errorWithDomain:@"test" code:2 userInfo:nil]; return self.token; }
- (BOOL)removeToken:(NSError **)error { self.token = nil; return YES; }
@end

int main(void) {
    @autoreleasepool {
        check(IsobarNotacTokenIsValid(@"lb_0123456789abcdef0123456789ABCDEF01234567"), @"accepts a NOTAC key");
        check(!IsobarNotacTokenIsValid(@"lb_0123456789abcdef"), @"rejects a short key");
        check(!IsobarNotacTokenIsValid(@"lb_0123456789abcdef0123456789abcdef0123456g"), @"rejects non-hex key");
        FakeKeychain *fake = [FakeKeychain new];
        IsobarNotacConnection *connection = [[IsobarNotacConnection alloc] initWithService:@"test" account:@"test" keychain:fake];
        NSError *error = nil;
        NSString *token = @"lb_0123456789abcdef0123456789ABCDEF01234567";
        check([connection saveToken:token error:&error] && [[connection loadToken:&error] isEqual:token], @"stores and reads through injected keychain");
        check([connection removeToken:&error] && [connection loadToken:&error] == nil, @"deletes through injected keychain");

        NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        [[NSFileManager defaultManager] createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *script = [root stringByAppendingPathComponent:@"collector.sh"];
        NSString *source = @"#!/bin/sh\nread token\n[ \"$1\" = fetch-notams ] || exit 10\n[ \"$2\" = --token-stdin ] || exit 11\n[ \"$3\" = --data-dir ] || exit 12\n[ -n \"$token\" ] || exit 13\nprintf '%s' \"$token\" > \"$4/token.txt\"\nprintf '%s\\n' \"$@\" > \"$4/args.txt\"\nenv > \"$4/env.txt\"\n";
        [source writeToFile:script atomically:YES encoding:NSUTF8StringEncoding error:nil]; chmod(script.fileSystemRepresentation, 0700);
        check([connection saveToken:token error:&error], @"saves token for collector test");
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block BOOL success = NO; __block NSString *message = nil;
        [connection fetchWithDataDirectory:root executableURL:[NSURL fileURLWithPath:script] completion:^(BOOL ok, NSString *status) { success = ok; message = status; dispatch_semaphore_signal(done); }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        NSData *captured = [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:@"token.txt"]];
        check(success && [message isEqual:@"NOTAMs updated"] && [[NSString alloc] initWithData:captured encoding:NSUTF8StringEncoding].length > 0, @"collector receives key on stdin with fixed arguments");
        NSString *args=[NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"args.txt"] encoding:NSUTF8StringEncoding error:nil];
        NSString *env=[NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"env.txt"] encoding:NSUTF8StringEncoding error:nil];
        check(![args containsString:token] && ![env containsString:token], @"key is absent from collector arguments and environment");
        check(![message containsString:token], @"collector status does not expose the key");
        NSString *errorScript=[root stringByAppendingPathComponent:@"failed.sh"];
        [@"#!/bin/sh\nread token\nprintf 'NOTAC bad key (HTTP 401): %s\\n' \"$token\" >&2\nexit 2\n" writeToFile:errorScript atomically:YES encoding:NSUTF8StringEncoding error:nil];
        chmod(errorScript.fileSystemRepresentation, 0700);
        done=dispatch_semaphore_create(0); success=YES; message=nil;
        [connection fetchWithDataDirectory:root executableURL:[NSURL fileURLWithPath:errorScript] completion:^(BOOL ok, NSString *status) { success=ok; message=status; dispatch_semaphore_signal(done); }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        check(!success && [message isEqual:@"NOTAC rejected this key"] && ![message containsString:token], @"invalid-key diagnostic is useful without echoing credentials");
        [[NSFileManager defaultManager] removeItemAtPath:root error:nil];
    }
    return failures ? 1 : 0;
}
