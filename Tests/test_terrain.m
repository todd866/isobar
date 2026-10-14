#import "terrain.h"
#import <math.h>
#import <stdio.h>
#import <stdlib.h>
static int bad;
static void ok(int condition, const char *message) { fprintf(stderr, "%s %s\n", condition ? "ok  " : "FAIL", message); if (!condition) bad++; }
int main(void) {
    @autoreleasepool {
        ok(fabs(TerrainElevation(136,176,128)-2224.5)<.01, "terrarium Kosciuszko sample");
        ok(fabs(TerrainElevation(162,145,0)-8849)<.01, "terrarium Everest sample");
        ok(TerrainWrapTileX(-1,3)==7, "tile x wraps");
        uint8_t rgba[16]={162,145,0,255,136,176,128,255,128,0,0,255,127,255,128,255}; uint16_t out[4]; TerrainDecodeTerrarium(rgba,4,out);
        ok(fabs(TerrainHalfToFloat(out[0])-8849)<2, "binary16 retains Everest"); ok(fabs(TerrainHalfToFloat(out[1])-2224.5)<2, "binary16 retains Kosciuszko"); ok(TerrainHalfToFloat(out[3])<0, "sea remains below zero");
        ok(fabs(TerrainHalfToFloat(TerrainToHalf(-432.25f))+432.25)<0.5, "negative metres retain sign");
        int badW=99,badH=99; uint16_t badOut[4];
        ok(TerrainElevationsFromWebP([NSData dataWithBytes:"not-webp" length:8],badOut,4,&badW,&badH)==0 && badW==0 && badH==0, "malformed WebP fails closed");
        ok([IsobarTerrainCredit() isEqualToString:@"Mapterhorn"], "credit names Mapterhorn");
        NSString *fixture=[[[NSFileManager defaultManager] currentDirectoryPath] stringByAppendingPathComponent:@"Tests/fixtures/terrain"];
        setenv("ISOBAR_TERRAIN_TILES", fixture.UTF8String, 1);
        NSString *cachePath=[NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString];
        IsobarTerrainTileStore *store=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:cachePath URLSession:nil];
        dispatch_semaphore_t done=dispatch_semaphore_create(0); __block TerrainTileResult result=TerrainTileResultFailed; __block TerrainTileSnapshot *tile; __block NSUInteger callbackCount=0; __block NSUInteger callbackMemory=0;
        [store requestZoom:8 x:189 y:107 completion:^(TerrainTileResult r, TerrainTileSnapshot *t, NSError *error) { (void)error; result=r; tile=t; callbackCount++; callbackMemory=store.memoryTileCount; (void)[store cachedZoom:8 x:189 y:107]; dispatch_semaphore_signal(done); }];
        ok(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5*NSEC_PER_SEC))==0, "fixture request completes off main");
        ok(result==TerrainTileResultReady && tile.width==512, "fixture WebP becomes immutable tile");
        ok(callbackCount==1 && callbackMemory==1, "cached callback can query store without deadlock");
        if (tile) ok(fabs([tile elevationAtColumn:416 row:131]-8568.0)<1, "fixture contains exact Everest sample");
        NSData *kosData=[NSData dataWithContentsOfFile:[fixture stringByAppendingPathComponent:@"8/233/155.webp"]]; uint16_t *kos=calloc(512*512,2); int kw=0,kh=0; int kn=TerrainElevationsFromWebP(kosData,kos,512*512,&kw,&kh);
        ok(kn==512*512 && fabs(TerrainHalfToFloat(kos[447*512+221])-2193.0)<2, "fixture contains exact Kosciuszko sample"); free(kos);
        __block TerrainTileResult missing=TerrainTileResultReady; dispatch_semaphore_t missingDone=dispatch_semaphore_create(0);
        [store requestZoom:8 x:188 y:107 completion:^(TerrainTileResult r, TerrainTileSnapshot *t, NSError *error) { (void)t; (void)error; missing=r; dispatch_semaphore_signal(missingDone); }];
        ok(dispatch_semaphore_wait(missingDone, dispatch_time(DISPATCH_TIME_NOW, 5*NSEC_PER_SEC))==0 && missing==TerrainTileResultMissing, "missing fixture remains nil");
        NSArray *cacheFiles=[[NSFileManager defaultManager] subpathsAtPath:cachePath];
        ok(cacheFiles.count==0, "fixture and missing requests do not write production cache");
        [[NSFileManager defaultManager] removeItemAtPath:cachePath error:nil];
        __block BOOL cachedOffMain=NO; dispatch_semaphore_t hit=dispatch_semaphore_create(0);
        [store requestZoom:8 x:189 y:107 completion:^(TerrainTileResult r,TerrainTileSnapshot *t,NSError *error) {
            (void)error; cachedOffMain=!NSThread.isMainThread && r==TerrainTileResultReady && t==[store cachedZoom:8 x:189 y:107] && store.memoryTileCount==1;
            dispatch_semaphore_signal(hit);
        }];
        ok(dispatch_semaphore_wait(hit,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))==0 && cachedOffMain, "memory-hit callback is reentrant and off main");
        for (NSArray *sample in @[@[@"12/3037/1716.webp",@6,@41,@8718], @[@"12/3734/2493.webp",@462,@500,@2206]]) {
            NSData *body=[NSData dataWithContentsOfFile:[fixture stringByAppendingPathComponent:sample[0]]];
            uint16_t *pixels=calloc(512*512,2);
            int n=TerrainElevationsFromWebP(body,pixels,512*512,NULL,NULL);
            ok(n==512*512 && TerrainHalfToFloat(pixels[[sample[2] intValue]*512+[sample[1] intValue]])==TerrainHalfToFloat(TerrainToHalf([sample[3] floatValue])), "z12 summit-coordinate fixture matches independent RGB oracle");
            free(pixels);
        }
        uint8_t transparent[]={162,145,0,0};uint16_t missingPixel;
        TerrainDecodeTerrarium(transparent,1,&missingPixel);ok(isnan(TerrainHalfToFloat(missingPixel)),"transparent terrain remains missing");
        ok(TerrainHalfToFloat(TerrainToHalf(4095.9f))==4096 && isnan(TerrainHalfToFloat(TerrainToHalf(NAN))),"half rounding carry and NaN");
        unsetenv("ISOBAR_TERRAIN_TILES");
        setenv("ISOBAR_TERRAIN_OFFLINE","1",1);
        NSString *diskTile=[cachePath stringByAppendingPathComponent:@"8/189/107.webp"];
        [[NSFileManager defaultManager] createDirectoryAtPath:diskTile.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
        [[NSFileManager defaultManager] copyItemAtPath:[fixture stringByAppendingPathComponent:@"8/189/107.webp"] toPath:diskTile error:nil];
        NSDictionary *before=[[NSFileManager defaultManager] attributesOfItemAtPath:diskTile error:nil];
        IsobarTerrainTileStore *offline=[[IsobarTerrainTileStore alloc] initWithCacheDirectory:cachePath URLSession:nil];
        dispatch_semaphore_t diskDone=dispatch_semaphore_create(0);__block BOOL diskOK=NO;
        [offline requestZoom:8 x:189 y:107 completion:^(TerrainTileResult r,TerrainTileSnapshot *t,NSError *error) {
            (void)error;diskOK=r==TerrainTileResultReady && [t elevationAtColumn:416 row:131]==8568;dispatch_semaphore_signal(diskDone);
        }];
        ok(dispatch_semaphore_wait(diskDone,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))==0 && diskOK,"offline store reads saved tile without fixture mode");
        NSDictionary *after=[[NSFileManager defaultManager] attributesOfItemAtPath:diskTile error:nil];
        ok([before.fileModificationDate isEqual:after.fileModificationDate],"offline read never rewrites cache");
        dispatch_semaphore_t invalid=dispatch_semaphore_create(0);__block BOOL rejected=NO;
        [offline requestZoom:100 x:0 y:0 completion:^(TerrainTileResult r,TerrainTileSnapshot *t,NSError *error) {
            rejected=r==TerrainTileResultFailed && !t && error!=nil;dispatch_semaphore_signal(invalid);
        }];
        ok(dispatch_semaphore_wait(invalid,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))==0 && rejected,"invalid request completes with failure");
        [[NSFileManager defaultManager] removeItemAtPath:cachePath error:nil];

        fprintf(stderr, "%s\n", bad ? "FAIL terrain" : "ok  terrain"); return bad ? 1 : 0;
    }
}
