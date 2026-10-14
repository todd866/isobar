#import "terrain.h"
#import <Foundation/Foundation.h>
#import <stdio.h>
#import <stdlib.h>

static int failures;
static void check(BOOL value, const char *message) { fprintf(stderr, "%s %s\n", value ? "ok  " : "FAIL", message); if (!value) failures++; }

@interface TerrainProtocol : NSURLProtocol
@property(atomic) BOOL stopped;
@end
static NSData *gBody;
static NSInteger gStatus;
static BOOL gDelayFirst;
static BOOL gDelayAll;
static NSUInteger gRequests;
static NSLock *gLock;
static NSMutableArray *gCaches, *gSessions;
static dispatch_semaphore_t gStarted;

@implementation TerrainProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return [request.URL.host isEqualToString:@"tiles.mapterhorn.com"]; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
    [gLock lock]; NSUInteger ordinal=++gRequests; NSInteger status=gStatus; NSData *body=gBody; BOOL delayed=gDelayAll || (gDelayFirst && ordinal==1); [gLock unlock];
    dispatch_semaphore_signal(gStarted);
    void (^send)(void)=^{
        if (self.stopped || !self.client) return;
        NSHTTPURLResponse *response=[[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type":@"image/webp",@"Content-Length":[NSString stringWithFormat:@"%lu",(unsigned long)body.length]}];
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        if (body.length) [self.client URLProtocol:self didLoadData:body];
        [self.client URLProtocolDidFinishLoading:self];
    };
    if (delayed) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500*NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_UTILITY,0), send);
    else dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), send);
}
- (void)stopLoading { self.stopped=YES; }
@end

static NSURLSession *TestSession(void) {
    NSURLSessionConfiguration *configuration=NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.protocolClasses=@[[TerrainProtocol class]];
    configuration.HTTPMaximumConnectionsPerHost=8;
    NSURLSession *session=[NSURLSession sessionWithConfiguration:configuration]; [gSessions addObject:session]; return session;
}
static NSString *TempCache(void) { NSString *path=[NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString]; [gCaches addObject:path]; return path; }
static void ResetProtocol(NSData *body, NSInteger status, BOOL delay) { [gLock lock]; gBody=body; gStatus=status; gDelayFirst=delay; gDelayAll=NO; gRequests=0; gStarted=dispatch_semaphore_create(0); [gLock unlock]; }
static BOOL Wait(dispatch_semaphore_t semaphore) { return dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 8*NSEC_PER_SEC))==0; }
static NSData *Fixture(void) { return [NSData dataWithContentsOfFile:@"Tests/fixtures/terrain/8/189/107.webp"]; }

static void TestStatuses(void) {
    NSData *body=Fixture();
    ResetProtocol(body,500,NO); IsobarTerrainTileStore *store=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:TempCache() URLSession:TestSession()];
    dispatch_semaphore_t done=dispatch_semaphore_create(0); __block TerrainTileResult result=TerrainTileResultReady;
    [store requestZoom:8 x:190 y:107 completion:^(TerrainTileResult r, TerrainTileSnapshot *tile, NSError *error) { (void)tile; (void)error; result=r; dispatch_semaphore_signal(done); }];
    check(Wait(done) && result==TerrainTileResultFailed, "HTTP 500 fails"); check(store.memoryTileCount==0, "HTTP 500 does not enter memory cache");
    ResetProtocol(nil,404,NO); done=dispatch_semaphore_create(0); result=TerrainTileResultReady;
    [store requestZoom:8 x:191 y:107 completion:^(TerrainTileResult r, TerrainTileSnapshot *tile, NSError *error) { (void)tile; (void)error; result=r; dispatch_semaphore_signal(done); }];
    check(Wait(done) && result==TerrainTileResultMissing, "HTTP 404 reports missing");
}

static void TestCoalescing(void) {
    ResetProtocol(Fixture(),200,NO); IsobarTerrainTileStore *store=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:TempCache() URLSession:TestSession()];
    dispatch_semaphore_t done=dispatch_semaphore_create(0); __block int callbacks=0;
    TerrainTileCompletion completion=^(TerrainTileResult result, TerrainTileSnapshot *tile, NSError *error) { [gLock lock]; if (result==TerrainTileResultReady && tile && !error) callbacks++; [gLock unlock]; dispatch_semaphore_signal(done); };
    [store requestZoom:8 x:192 y:107 completion:completion]; [store requestZoom:8 x:192 y:107 completion:completion];
    check(Wait(done) && Wait(done) && callbacks==2, "duplicate requests coalesce and deliver twice");
    [gLock lock]; NSUInteger requests=gRequests; [gLock unlock]; check(requests==1, "coalesced requests use one HTTP task");
}

// Codex review, stage 1-2: a batch that started before cancelAll kept
// submitting afterwards and took the new view's download slots.
static void TestSupersededBatch(void) {
    ResetProtocol(Fixture(),200,NO); [gLock lock]; gDelayAll=YES; [gLock unlock];
    IsobarTerrainTileStore *store=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:TempCache() URLSession:TestSession()];
    NSUInteger batch=store.generation;
    [store cancelAll];
    __block int stale=0; BOOL admitted=NO;
    for (int x=0;x<35;x++) admitted |= [store requestZoom:8 x:150+x y:100 generation:batch completion:^(TerrainTileResult r, TerrainTileSnapshot *tile, NSError *error) { (void)r; (void)tile; (void)error; [gLock lock]; stale++; [gLock unlock]; }];
    check(!admitted && store.activeRequestCount==0, "superseded batch is rejected and holds no download slots");
    dispatch_semaphore_t done=dispatch_semaphore_create(0); __block TerrainTileResult result=TerrainTileResultFailed;
    BOOL current=[store requestZoom:8 x:194 y:107 generation:store.generation completion:^(TerrainTileResult r, TerrainTileSnapshot *tile, NSError *error) { (void)tile; (void)error; result=r; dispatch_semaphore_signal(done); }];
    check(current && Wait(done) && result==TerrainTileResultReady, "current batch is admitted");
    usleep(700000); [gLock lock]; int late=stale; gDelayAll=NO; [gLock unlock];
    check(late==0, "superseded batch never calls back");
}

static void TestCancellation(void) {
    ResetProtocol(Fixture(),200,YES); IsobarTerrainTileStore *store=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:TempCache() URLSession:TestSession()];
    dispatch_semaphore_t oldDone=dispatch_semaphore_create(0), newDone=dispatch_semaphore_create(0); __block int oldCallbacks=0; __block TerrainTileResult newResult=TerrainTileResultFailed;
    [store requestZoom:8 x:193 y:107 completion:^(TerrainTileResult result, TerrainTileSnapshot *tile, NSError *error) { (void)result; (void)tile; (void)error; [gLock lock];oldCallbacks++;[gLock unlock]; dispatch_semaphore_signal(oldDone); }];
    check(Wait(gStarted), "old network task really started before cancellation");
    [store cancelAll];
    [store requestZoom:8 x:193 y:107 completion:^(TerrainTileResult result, TerrainTileSnapshot *tile, NSError *error) { (void)tile; (void)error; newResult=result; dispatch_semaphore_signal(newDone); }];
    check(Wait(newDone) && newResult==TerrainTileResultReady, "new request succeeds after cancellation");
    check(dispatch_semaphore_wait(oldDone, dispatch_time(DISPATCH_TIME_NOW, 700*NSEC_PER_MSEC))!=0 && oldCallbacks==0, "cancelled request cannot overwrite new request");
}

static void TestLimits(void) {
    ResetProtocol(Fixture(),200,YES); IsobarTerrainTileStore *store=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:TempCache() URLSession:TestSession()];
    dispatch_semaphore_t done=dispatch_semaphore_create(0); __block int finished=0, failed=0;
    for (int i=0;i<50;i++) [store requestZoom:8 x:194 y:107 completion:^(TerrainTileResult result, TerrainTileSnapshot *tile, NSError *error) { (void)tile; (void)error; [gLock lock];if(result==TerrainTileResultFailed) failed++; finished++;[gLock unlock]; dispatch_semaphore_signal(done); }];
    for(int i=0;i<50;i++) if(!Wait(done)) break;
    check(finished==50, "waiter limit returns every completion"); check(failed>0, "waiter limit reports bounded failures");
}

int main(void) { @autoreleasepool { unsetenv("ISOBAR_TERRAIN_OFFLINE"); unsetenv("ISOBAR_TERRAIN_TILES"); gCaches=[NSMutableArray array];gSessions=[NSMutableArray array];gLock=[NSLock new]; check(Fixture()!=nil,"real WebP fixture exists"); TestStatuses(); TestCoalescing(); TestCancellation(); TestSupersededBatch(); TestLimits(); for(NSURLSession *session in gSessions) [session invalidateAndCancel]; for(NSString *path in gCaches) [NSFileManager.defaultManager removeItemAtPath:path error:nil]; fprintf(stderr,"%s\n",failures?"FAIL terrain transport":"ok  terrain transport"); return failures?1:0; } }
