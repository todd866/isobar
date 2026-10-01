#import "collector.h"

@implementation IsobarCollector {
    NSURL *_executable, *_store;
    NSTask *_task;
    NSTimer *_poll;
    NSFileHandle *_log;
    NSDate *_lastStarted, *_lastPublished;
    NSString *_lastError;
}
- (instancetype)initWithExecutable:(NSURL *)executable store:(NSURL *)store {
    if ((self=[super init])) { _executable=executable; _store=store; }
    return self;
}
- (BOOL)running { return _task.running; }
- (NSString *)lastError { return _lastError; }
- (void)refresh {
    if (_task || (_lastStarted && -_lastStarted.timeIntervalSinceNow<300)) return;
    if (![NSFileManager.defaultManager isExecutableFileAtPath:_executable.path]) { _lastError=@"The collector is missing from this build"; return; }
    NSError *error=nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:_store withIntermediateDirectories:YES attributes:nil error:&error]) { _lastError=error.localizedDescription; return; }
    NSURL *logURL=[_store URLByAppendingPathComponent:@"collector.log"];
    NSDictionary *attributes=[NSFileManager.defaultManager attributesOfItemAtPath:logURL.path error:nil];
    if ([attributes[NSFileSize] unsignedLongLongValue]>4*1024*1024) [NSData.data writeToURL:logURL atomically:YES];
    if (![NSFileManager.defaultManager fileExistsAtPath:logURL.path]) [NSData.data writeToURL:logURL atomically:YES];
    _log=[NSFileHandle fileHandleForWritingToURL:logURL error:nil]; [_log seekToEndOfFile];
    NSTask *task=[NSTask new]; task.executableURL=_executable;
    task.arguments=@[@"run", @"--data-dir", _store.path];
    task.currentDirectoryURL=_store;
    NSMutableDictionary *env=[NSProcessInfo.processInfo.environment mutableCopy];
    [env removeObjectForKey:@"PYTHONPATH"]; [env removeObjectForKey:@"PYTHONHOME"];
    env[@"PATH"]=@"/usr/bin:/bin:/usr/sbin:/sbin";
    task.environment=env;
    task.standardInput=NSFileHandle.fileHandleWithNullDevice;
    task.standardOutput=_log ?: NSFileHandle.fileHandleWithNullDevice;
    task.standardError=task.standardOutput;
    __weak IsobarCollector *weak=self;
    task.terminationHandler=^(NSTask *ended) {
        dispatch_async(dispatch_get_main_queue(), ^{
            IsobarCollector *strong=weak;
            if (!strong || strong->_task!=ended) return;
            strong->_lastError=ended.terminationStatus ? @"Weather refresh failed" : nil;
            strong->_task=nil; [strong->_poll invalidate]; strong->_poll=nil;
            [strong->_log closeFile]; strong->_log=nil;
            if (strong.onUpdate) strong.onUpdate();
        });
    };
    _task=task; _lastError=nil;
    if (![task launchAndReturnError:&error]) { _task=nil; [_log closeFile]; _log=nil; _lastError=error.localizedDescription; return; }
    _lastStarted=NSDate.date;
    // Cold start: show the first chart as soon as it is published, while the
    // larger model grid continues downloading in the background.
    _poll=[NSTimer scheduledTimerWithTimeInterval:5 repeats:YES block:^(NSTimer *timer) {
        IsobarCollector *strong=weak;
        if (!strong) { [timer invalidate]; return; }
        NSURL *chart=[strong->_store URLByAppendingPathComponent:@"products/charts/current.json"];
        NSDate *date=nil; [chart getResourceValue:&date forKey:NSURLContentModificationDateKey error:nil];
        if (date && ![date isEqual:strong->_lastPublished]) { strong->_lastPublished=date; if(strong.onUpdate)strong.onUpdate(); }
        if (-strong->_lastStarted.timeIntervalSinceNow>20*60) [strong stop];
    }];
}
- (void)stop {
    [_poll invalidate]; _poll=nil;
    NSTask *task=_task;
    task.terminationHandler=nil;
    if (task.running) {
        [task terminate];
        // Reap asynchronously so quitting never stalls the UI. The one-folder
        // collector runs in one process; it does not spawn shell workers.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{ [task waitUntilExit]; });
    }
    _task=nil;
    [_log closeFile]; _log=nil;
}
- (void)dealloc { [self stop]; }
@end
