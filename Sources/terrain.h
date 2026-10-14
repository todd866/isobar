// Mapterhorn terrarium terrain tiles.
// Elevation is metres: R * 256 + G + B / 256 - 32768.
// Missing tiles remain missing; callers must keep their flat tint.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

enum { kTerrainTileSize = 512, kTerrainMaxZoom = 14 };

typedef struct { double west, south, east, north; } TerrainBox;

FOUNDATION_EXPORT double TerrainElevation(int r, int g, int b);
FOUNDATION_EXPORT double TerrainLonToTileX(double longitude, int zoom);
FOUNDATION_EXPORT double TerrainLatToTileY(double latitude, int zoom);
FOUNDATION_EXPORT int TerrainWrapTileX(int x, int zoom);
FOUNDATION_EXPORT uint16_t TerrainToHalf(float value);
FOUNDATION_EXPORT float TerrainHalfToFloat(uint16_t value);
FOUNDATION_EXPORT void TerrainDecodeTerrarium(const uint8_t * _Nullable rgba, int count, uint16_t * _Nullable out);
// Returns count on success, or zero for malformed/non-512px input.
FOUNDATION_EXPORT int TerrainElevationsFromWebP(NSData *webp, uint16_t *out, int capacity,
                                                  int * _Nullable width, int * _Nullable height);
FOUNDATION_EXPORT NSString *IsobarTerrainAttribution(void);
FOUNDATION_EXPORT NSString *IsobarTerrainCredit(void);

typedef NS_ENUM(NSInteger, TerrainTileResult) {
    TerrainTileResultReady,
    TerrainTileResultMissing,
    TerrainTileResultFailed
};

// Immutable, row-major (north to south), binary16 elevation samples.
@interface TerrainTileSnapshot : NSObject
@property(nonatomic, readonly) int zoom, x, y, width, height;
@property(nonatomic, readonly) NSData *samples;
- (instancetype)initWithZoom:(int)zoom x:(int)x y:(int)y samples:(NSData *)samples;
- (float)elevationAtColumn:(int)column row:(int)row;
@end

typedef void (^TerrainTileCompletion)(TerrainTileResult result, TerrainTileSnapshot * _Nullable tile,
                                      NSError * _Nullable error);

// Thread-safe tile cache: 32 resident tiles, 40 queued jobs, four workers.
// Completion is asynchronous on a utility queue; callbacks may call this API.
// Fixture/offline settings are captured at init and never write cache files.
// HTTP failures are retryable; no negative response is persisted.
@interface IsobarTerrainTileStore : NSObject
- (instancetype)init;
- (instancetype)initWithCacheDirectory:(nullable NSString *)directory
                              URLSession:(nullable NSURLSession *)session;
- (void)requestZoom:(int)zoom x:(int)x y:(int)y completion:(TerrainTileCompletion)completion;
- (nullable TerrainTileSnapshot *)cachedZoom:(int)zoom x:(int)x y:(int)y;
- (void)cancelAll; // cancels pending fetches and suppresses undelivered results
// Batch generation. cancelAll advances it. A batch captures it once and
// passes it with each request, so a superseded batch is rejected under the
// same lock as cancellation: it never occupies a slot or calls back (NO).
@property(nonatomic, readonly) NSUInteger generation;
- (BOOL)requestZoom:(int)zoom x:(int)x y:(int)y generation:(NSUInteger)generation
         completion:(TerrainTileCompletion)completion;
@property(nonatomic, readonly) NSUInteger memoryTileCount;
@property(nonatomic, readonly) NSUInteger activeRequestCount;
@end

NS_ASSUME_NONNULL_END
