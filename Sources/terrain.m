#import "terrain.h"
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <math.h>
#import <string.h>

static const NSUInteger kMemoryLimit = 32, kRequestLimit = 40, kWaiterLimit = 32;
static const NSUInteger kTileBytes = 512u * 512u * sizeof(uint16_t);
static const NSUInteger kEncodedLimit = 8u << 20;
static const unsigned long long kDiskLimit = 200ull << 20;
static const double kMercatorLimit = 85.05112878;

double TerrainElevation(int r, int g, int b) { return r * 256.0 + g + b / 256.0 - 32768.0; }
static double Pow2(int z) { return ldexp(1.0, MAX(0, MIN(30, z))); }
double TerrainLonToTileX(double lon, int z) { return (lon + 180.0) * Pow2(z) / 360.0; }
double TerrainLatToTileY(double lat, int z) {
    if (!isfinite(lat)) return NAN;
    double p = MAX(-kMercatorLimit, MIN(kMercatorLimit, lat)) * M_PI / 180;
    return (1 - asinh(tan(p)) / M_PI) * Pow2(z) / 2;
}
int TerrainWrapTileX(int x, int z) { int n = (int)Pow2(z), r = x % n; return r < 0 ? r + n : r; }
uint16_t TerrainToHalf(float value) { _Float16 h = (_Float16)value; uint16_t bits; memcpy(&bits, &h, 2); return bits; }
float TerrainHalfToFloat(uint16_t bits) { _Float16 h; memcpy(&h, &bits, 2); return (float)h; }
void TerrainDecodeTerrarium(const uint8_t *rgba, int count, uint16_t *out) {
    if (!rgba || !out || count < 1) return;
    for (int i = 0; i < count; i++) out[i] = TerrainToHalf(rgba[(size_t)i*4+3] == 255
        ? (float)TerrainElevation(rgba[(size_t)i*4], rgba[(size_t)i*4+1], rgba[(size_t)i*4+2]) : NAN);
}
int TerrainElevationsFromWebP(NSData *webp, uint16_t *out, int capacity, int *width, int *height) {
    if (width) *width = 0;
    if (height) *height = 0;
    if (webp.length < 12 || webp.length > kEncodedLimit || !out || capacity < 512*512) return 0;
    const char *header = webp.bytes;
    if (memcmp(header,"RIFF",4) || memcmp(header+8,"WEBP",4)) return 0;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)webp, NULL);
    if (!source) return 0;
    NSDictionary *props = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    // Bound decode allocation before ImageIO expands the encoded image.
    if ([props[(__bridge NSString *)kCGImagePropertyPixelWidth] intValue] != 512 ||
        [props[(__bridge NSString *)kCGImagePropertyPixelHeight] intValue] != 512) { CFRelease(source); return 0; }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (!image) return 0;
    CGColorSpaceRef space = CGImageGetColorSpace(image);
    if (!space || CGColorSpaceGetModel(space) != kCGColorSpaceModelRGB || CGImageGetBitsPerComponent(image) != 8) {
        CGImageRelease(image); return 0;
    }
    uint8_t *rgba = calloc(512u*512u,4);
    // Use the image's own colour space: encoded channel values are data, never
    // converted to a display profile or linear light. No resize/interpolation.
    CGContextRef context = rgba ? CGBitmapContextCreate(rgba,512,512,8,512*4,space,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
    if (!context) { free(rgba); CGImageRelease(image); return 0; }
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0,0,512,512), image);
    TerrainDecodeTerrarium(rgba,512*512,out);
    CGContextRelease(context); CGImageRelease(image); free(rgba);
    if (width) *width = 512;
    if (height) *height = 512;
    return 512*512;
}
NSString *IsobarTerrainAttribution(void) {
    return @"ECMWF Open Data (CC BY 4.0). Terrain: Mapterhorn (https://mapterhorn.com/attribution/), "
        "Copernicus GLO-30 (© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018; "
        "provided under COPERNICUS by the European Union and ESA), and national elevation models "
        "including Geoscience Australia (CC BY 4.0). Source-specific licences: https://download.mapterhorn.com/attribution.json.";
}
NSString *IsobarTerrainCredit(void) { return @"Mapterhorn"; }

@implementation TerrainTileSnapshot
- (instancetype)initWithZoom:(int)z x:(int)x y:(int)y samples:(NSData *)samples {
    if (!(self = [super init]) || z<0 || z>kTerrainMaxZoom || y<0 || y>=(int)Pow2(z) || samples.length!=kTileBytes) return nil;
    _zoom=z; _x=TerrainWrapTileX(x,z); _y=y; _width=512; _height=512; _samples=[samples copy]; return self;
}
- (float)elevationAtColumn:(int)c row:(int)r {
    if (c<0 || r<0 || c>=512 || r>=512) return NAN;
    return TerrainHalfToFloat(((const uint16_t *)_samples.bytes)[r*512+c]);
}
@end

@interface TerrainRequest : NSObject
@property(nonatomic) int zoom, x, y;
@property(nonatomic) NSUInteger generation;
@property(nonatomic,copy) NSString *key;
@property(nonatomic,strong) NSMutableArray<TerrainTileCompletion> *waiters;
@property(nonatomic,strong) NSURLSessionTask *task;
@end
@implementation TerrainRequest
@end

@interface IsobarTerrainTileStore () {
    NSLock *_lock, *_diskLock;
    NSOperationQueue *_workers;
    NSURLSession *_session;
    BOOL _ownsSession, _offline;
    NSString *_root, *_fixture;
    NSMutableDictionary<NSString *, TerrainTileSnapshot *> *_memory;
    NSMutableArray<NSString *> *_order;
    NSMutableDictionary<NSString *, TerrainRequest *> *_requests;
    NSUInteger _generation;
}
@end
@implementation IsobarTerrainTileStore
- (instancetype)init { return [self initWithCacheDirectory:nil URLSession:nil]; }
- (instancetype)initWithCacheDirectory:(NSString *)directory URLSession:(NSURLSession *)session {
    if (!(self=[super init])) return nil;
    _lock=[NSLock new]; _diskLock=[NSLock new];
    _memory=[NSMutableDictionary dictionary]; _order=[NSMutableArray array]; _requests=[NSMutableDictionary dictionary];
    _workers=[NSOperationQueue new]; _workers.maxConcurrentOperationCount=4; _workers.qualityOfService=NSQualityOfServiceUtility;
    _root=[directory copy] ?: [NSSearchPathForDirectoriesInDomains(NSCachesDirectory,NSUserDomainMask,YES).firstObject stringByAppendingPathComponent:@"Isobar/terrain"];
    _fixture=[NSProcessInfo.processInfo.environment[@"ISOBAR_TERRAIN_TILES"] copy];
    _offline=[NSProcessInfo.processInfo.environment[@"ISOBAR_TERRAIN_OFFLINE"] isEqual:@"1"];
    NSURLSessionConfiguration *cfg=NSURLSessionConfiguration.ephemeralSessionConfiguration;
    cfg.HTTPMaximumConnectionsPerHost=4; cfg.timeoutIntervalForRequest=12; cfg.timeoutIntervalForResource=15; cfg.URLCache=nil;
    _session=session ?: [NSURLSession sessionWithConfiguration:cfg]; _ownsSession=!session;
    return self;
}
- (void)dealloc { [_workers cancelAllOperations]; if (_ownsSession) [_session invalidateAndCancel]; }
- (NSString *)key:(int)z x:(int)x y:(int)y { return [NSString stringWithFormat:@"%d/%d/%d",z,TerrainWrapTileX(x,z),y]; }
- (TerrainTileSnapshot *)cachedZoom:(int)z x:(int)x y:(int)y {
    [_lock lock]; TerrainTileSnapshot *tile=_memory[[self key:z x:x y:y]]; [_lock unlock]; return tile;
}
- (NSUInteger)memoryTileCount { [_lock lock]; NSUInteger n=_memory.count; [_lock unlock]; return n; }
- (NSUInteger)activeRequestCount { [_lock lock]; NSUInteger n=_requests.count; [_lock unlock]; return n; }
- (void)deliver:(TerrainTileCompletion)callback result:(TerrainTileResult)result tile:(TerrainTileSnapshot *)tile code:(NSInteger)code generation:(NSUInteger)generation {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{
        [self->_lock lock]; BOOL current=generation==self->_generation; [self->_lock unlock];
        if (current) callback(result,tile,result==TerrainTileResultFailed ? [NSError errorWithDomain:@"IsobarTerrain" code:code userInfo:nil] : nil);
    });
}
- (void)requestZoom:(int)z x:(int)x y:(int)y completion:(TerrainTileCompletion)completion {
    [self admitZoom:z x:x y:y generation:NSUIntegerMax completion:completion];
}
- (BOOL)requestZoom:(int)z x:(int)x y:(int)y generation:(NSUInteger)batch completion:(TerrainTileCompletion)completion {
    return [self admitZoom:z x:x y:y generation:batch completion:completion];
}
// NSUIntegerMax admits under whatever generation is current.
- (BOOL)admitZoom:(int)z x:(int)x y:(int)y generation:(NSUInteger)batch completion:(TerrainTileCompletion)completion {
    if (!completion) return NO;
    [_lock lock]; NSUInteger generation=_generation;
    if (batch!=NSUIntegerMax && batch!=generation) { [_lock unlock]; return NO; }
    if (z<0 || z>kTerrainMaxZoom || y<0 || y>=(int)Pow2(z)) {
        [_lock unlock]; [self deliver:completion result:TerrainTileResultFailed tile:nil code:400 generation:generation]; return YES;
    }
    NSString *key=[self key:z x:x y:y]; TerrainTileSnapshot *cached=_memory[key];
    if (cached) {
        [_order removeObject:key]; [_order addObject:key]; [_lock unlock];
        [self deliver:completion result:TerrainTileResultReady tile:cached code:0 generation:generation]; return YES;
    }
    TerrainRequest *existing=_requests[key];
    if (existing && existing.waiters.count<kWaiterLimit) { [existing.waiters addObject:[completion copy]]; [_lock unlock]; return YES; }
    if (existing || _requests.count>=kRequestLimit) {
        [_lock unlock]; [self deliver:completion result:TerrainTileResultFailed tile:nil code:429 generation:generation]; return YES;
    }
    TerrainRequest *request=[TerrainRequest new]; request.zoom=z; request.x=TerrainWrapTileX(x,z); request.y=y;
    request.key=key; request.generation=generation; request.waiters=[NSMutableArray arrayWithObject:[completion copy]];
    _requests[key]=request; [_lock unlock];
    __weak IsobarTerrainTileStore *weak=self;
    [_workers addOperationWithBlock:^{ @autoreleasepool { [weak load:request]; } }];
    return YES;
}
- (TerrainTileSnapshot *)decode:(NSData *)data request:(TerrainRequest *)request {
    if (!data || data.length>kEncodedLimit) return nil;
    NSMutableData *samples=[NSMutableData dataWithLength:kTileBytes];
    if (TerrainElevationsFromWebP(data,samples.mutableBytes,512*512,NULL,NULL)!=512*512) return nil;
    return [[TerrainTileSnapshot alloc] initWithZoom:request.zoom x:request.x y:request.y samples:samples];
}
- (BOOL)current:(TerrainRequest *)request {
    [_lock lock]; BOOL yes=_requests[request.key]==request && request.generation==_generation; [_lock unlock]; return yes;
}
- (void)finish:(TerrainRequest *)request tile:(TerrainTileSnapshot *)tile status:(NSInteger)status {
    [_lock lock];
    if (_requests[request.key]!=request || request.generation!=_generation) { [_lock unlock]; return; }
    [_requests removeObjectForKey:request.key];
    if (tile) {
        _memory[request.key]=tile; [_order removeObject:request.key]; [_order addObject:request.key];
        while (_order.count>kMemoryLimit) { [_memory removeObjectForKey:_order.firstObject]; [_order removeObjectAtIndex:0]; }
    }
    NSArray *waiters=[request.waiters copy]; [_lock unlock];
    TerrainTileResult result=tile ? TerrainTileResultReady : (status==404 || status==204 ? TerrainTileResultMissing : TerrainTileResultFailed);
    for (TerrainTileCompletion callback in waiters) [self deliver:callback result:result tile:tile code:status generation:request.generation];
}
- (void)store:(NSData *)data path:(NSString *)path request:(TerrainRequest *)request {
    [_diskLock lock];
    if (![self current:request]) { [_diskLock unlock]; return; }
    NSFileManager *fm=NSFileManager.defaultManager;
    [fm createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    [data writeToFile:path atomically:YES];
    // The directory is private to terrain. Prune only its own encoded tiles.
    NSMutableArray *files=[NSMutableArray array]; unsigned long long total=0;
    for (NSString *relative in [fm enumeratorAtPath:_root]) {
        if (![relative.pathExtension isEqual:@"webp"]) continue;
        NSString *p=[_root stringByAppendingPathComponent:relative]; NSDictionary *a=[fm attributesOfItemAtPath:p error:nil];
        if (![a.fileType isEqual:NSFileTypeRegular]) continue;
        total+=a.fileSize; [files addObject:@{@"path":p,@"date":a.fileModificationDate ?: NSDate.distantPast,@"size":@(a.fileSize)}];
    }
    if (total>kDiskLimit) {
        [files sortUsingComparator:^NSComparisonResult(NSDictionary *a,NSDictionary *b) { return [a[@"date"] compare:b[@"date"]]; }];
        for (NSDictionary *file in files) { if (total<=kDiskLimit*4/5) break;
            if ([fm removeItemAtPath:file[@"path"] error:nil]) total-=[file[@"size"] unsignedLongLongValue];
        }
    }
    [_diskLock unlock];
}
- (void)load:(TerrainRequest *)request {
    if (![self current:request]) return;
    NSString *relative=[request.key stringByAppendingPathExtension:@"webp"];
    NSString *path=[(_fixture.length ? _fixture : _root) stringByAppendingPathComponent:relative];
    NSDictionary *attributes=[NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    NSData *data=attributes.fileSize<=kEncodedLimit ? [NSData dataWithContentsOfFile:path] : nil;
    TerrainTileSnapshot *tile=[self decode:data request:request];
    if (tile) { [self finish:request tile:tile status:200]; return; }
    if (_fixture.length || _offline) { [self finish:request tile:nil status:data ? 422 : 404]; return; }
    if (attributes) {
        [_diskLock lock];
        NSDictionary *latest=[NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
        if ([self current:request] && [latest.fileModificationDate isEqual:attributes.fileModificationDate])
            [NSFileManager.defaultManager removeItemAtPath:path error:nil];
        [_diskLock unlock];
    }
    NSURL *url=[NSURL URLWithString:[@"https://tiles.mapterhorn.com/" stringByAppendingString:relative]];
    // Download to a system temporary file so an oversized response cannot grow
    // the application's heap. Four workers bound both downloads and decodes.
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block NSData *body=nil; __block NSInteger status=0;
    NSURLSessionDownloadTask *task=[_session downloadTaskWithURL:url completionHandler:^(NSURL *location,NSURLResponse *response,NSError *error) {
        if (!error && [response isKindOfClass:NSHTTPURLResponse.class]) status=((NSHTTPURLResponse *)response).statusCode;
        if (status==200 && location) {
            NSDictionary *a=[NSFileManager.defaultManager attributesOfItemAtPath:location.path error:nil];
            if (a.fileSize<=kEncodedLimit) body=[NSData dataWithContentsOfURL:location];
        }
        dispatch_semaphore_signal(done);
    }];
    [_lock lock]; BOOL current=_requests[request.key]==request && request.generation==_generation;
    if (current) request.task=task; [_lock unlock];
    if (!current) { [task cancel]; return; }
    [task resume];
    NSTimeInterval deadline=NSDate.timeIntervalSinceReferenceDate+16;
    long waiting=1;
    while ([self current:request] && NSDate.timeIntervalSinceReferenceDate<deadline) {
        waiting=dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC));
        if (!waiting) break;
    }
    if (waiting) {
        [task cancel]; [self finish:request tile:nil status:408]; return;
    }
    if (![self current:request]) return;
    tile=status==200 ? [self decode:body request:request] : nil;
    if (tile) [self store:body path:path request:request];
    [self finish:request tile:tile status:status];
}
- (NSUInteger)generation { [_lock lock]; NSUInteger g=_generation; [_lock unlock]; return g; }
- (void)cancelAll {
    [_lock lock]; _generation++; NSArray *requests=_requests.allValues; [_requests removeAllObjects]; [_lock unlock];
    for (TerrainRequest *request in requests) [request.task cancel];
}
@end
