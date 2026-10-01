#import <Foundation/Foundation.h>
#import "collector.h"

static int failures;
static void Check(BOOL ok, NSString *message) { if(!ok) { failures++; fprintf(stderr,"FAIL: %s\n",message.UTF8String); } }
static BOOL Until(BOOL (^done)(void), NSTimeInterval seconds) {
    NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while(!done() && end.timeIntervalSinceNow>0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    return done();
}
int main(void) { @autoreleasepool {
    NSString *base=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSURL *store=[NSURL fileURLWithPath:[base stringByAppendingPathComponent:@"Weather with spaces"]];
    NSURL *exe=[NSURL fileURLWithPath:[base stringByAppendingPathComponent:@"isobar-data"]];
    [NSFileManager.defaultManager createDirectoryAtPath:base withIntermediateDirectories:YES attributes:nil error:nil];
    @try {
        IsobarCollector *missing=[[IsobarCollector alloc] initWithExecutable:exe store:store];
        [missing refresh]; Check(!missing.running,@"Missing helper does not launch");
        // Real subprocess, no weather requests. Check isolation and argument boundaries.
        setenv("ISOBAR_PARENT_SENTINEL","secret",1);
        NSString *script=@"#!/bin/sh\n[ \"$1\" = run ] && [ \"$2\" = --data-dir ] && [ \"$(cd \"$3\" && /bin/pwd -P)\" = \"$(/bin/pwd -P)\" ] || exit 11\n[ -z \"${PYTHONPATH:-}\" ] && [ -z \"${PYTHONHOME:-}\" ] || exit 12\n[ \"$PATH\" = /usr/bin:/bin:/usr/sbin:/sbin ] || exit 13\n[ -z \"${ISOBAR_PARENT_SENTINEL:-}\" ] || exit 14\n[ -n \"${HOME:-}\" ] || exit 15\nprintf 'run\\n' >> runs.txt\n/bin/sleep 0.1\nprintf 'done\\n'\n";
        [script writeToURL:exe atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0755} ofItemAtPath:exe.path error:nil];
        setenv("PYTHONPATH","/unrelated/development/environment",1);
        IsobarCollector *collector=[[IsobarCollector alloc] initWithExecutable:exe store:store];
        __block int updates=0; collector.onUpdate=^{ updates++; };
        [collector refresh]; [collector refresh];
        Check(Until(^BOOL{ return updates>0; },5),@"Completion delivered without blocking main thread");
        Check(!collector.running && !collector.lastError,@"Bundled helper arguments and isolated environment");
        [collector refresh];
        NSString *runs=[NSString stringWithContentsOfURL:[store URLByAppendingPathComponent:@"runs.txt"] encoding:NSUTF8StringEncoding error:nil];
        Check([runs isEqual:@"run\n"] && updates==1,@"Repeated refresh is bounded and deduplicated");
        NSString *log=[NSString stringWithContentsOfURL:[store URLByAppendingPathComponent:@"collector.log"] encoding:NSUTF8StringEncoding error:nil];
        Check([log containsString:@"done"],@"Helper output goes to local log");
        [collector stop];
        [@"#!/bin/sh\nexit 7\n" writeToURL:exe atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0755} ofItemAtPath:exe.path error:nil];
        IsobarCollector *failed=[[IsobarCollector alloc] initWithExecutable:exe store:store];
        failed.onUpdate=^{updates++;}; [failed refresh];
        Check(Until(^BOOL{ return updates==2; },5) && failed.lastError.length,@"Failed refresh is reported while keeping archive intact");
        [failed stop];
        NSURL *hangStore=[NSURL fileURLWithPath:[base stringByAppendingPathComponent:@"hang"]];
        NSString *hang=@"#!/bin/sh\ntrap '' TERM\n[ -z \"${ISOBAR_PARENT_SENTINEL:-}\" ] || exit 14\n[ -n \"${HOME:-}\" ] || exit 15\n[ \"$PATH\" = /usr/bin:/bin:/usr/sbin:/sbin ] || exit 13\nprintf 'run\\n' >> runs.txt\n/bin/sleep 30\n";
        [hang writeToURL:exe atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0755} ofItemAtPath:exe.path error:nil];
        IsobarCollector *hung=[[IsobarCollector alloc] initWithExecutable:exe store:hangStore];
        [hung refresh];
        Check(Until(^BOOL{ NSString *line=[NSString stringWithContentsOfURL:[hangStore URLByAppendingPathComponent:@"runs.txt"] encoding:NSUTF8StringEncoding error:nil]; return [line containsString:@"run"]; },3),@"helper starts before it is stopped");
        [hung stop];
        Check(hung.running,@"stop keeps the task until it exits");
        [hung refresh];
        Check(Until(^BOOL{ return !hung.running; },6),@"SIGKILL follows the grace period");
        NSString *hangRuns=[NSString stringWithContentsOfURL:[hangStore URLByAppendingPathComponent:@"runs.txt"] encoding:NSUTF8StringEncoding error:nil];
        Check([hangRuns isEqual:@"run\n"],@"a new run waits until the old one exits");
        unsetenv("PYTHONPATH"); unsetenv("ISOBAR_PARENT_SENTINEL");
    } @finally { [NSFileManager.defaultManager removeItemAtPath:base error:nil]; }
    printf("collector test failures: %d\n",failures); return failures ? 1 : 0;
}}
