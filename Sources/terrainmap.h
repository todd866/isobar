// Immutable DEM mosaic shared by Metal shading and geographic height samples.
#import "terrain.h"
#import "fieldrender.h"

enum { kTerrainMaxViewTiles = 36, kTerrainMaxTexels = 1500000 };
typedef struct { TerrainBox box; int zoom, width, height; } TerrainPlan;
BOOL TerrainViewForCamera(IsobarCamera camera, TerrainBox *box, double *density);
TerrainPlan TerrainPlanForView(TerrainBox box, double pixelsPerDegree);
double TerrainReliefStrength(double latitudeSpan);

@interface IsobarTerrainMosaic : NSObject
@property(nonatomic,readonly) TerrainBox box;
@property(nonatomic,readonly) int zoom, width, height;
@property(nonatomic,readonly) NSUInteger covered;
// RG32Float, south-first, texel centres: physical metres and coverage (0 or 1).
@property(nonatomic,readonly) NSData *samples;
@property(nonatomic,readonly) id<MTLTexture> texture;
- (double)elevationAtLatitude:(double)latitude longitude:(double)longitude;
// Fixtures and tests. samples is RG32Float, south-first, width*height pairs.
+ (instancetype)mosaicWithBox:(TerrainBox)box width:(int)width height:(int)height
                      samples:(NSData *)samples device:(id<MTLDevice>)device;
@end

@interface IsobarTerrainMap : NSObject
- (instancetype)initWithDevice:(id<MTLDevice>)device;
- (void)updateCamera:(IsobarCamera)camera;
// Explicit geographic request, for the 3D terrain scene. density is texels
// per degree; the same tile and texel budgets apply as updateCamera:.
- (void)updateBox:(TerrainBox)box density:(double)density;
@property(nonatomic,readonly) IsobarTerrainMosaic *mosaic;
// Offscreen harness only. Production never waits for terrain.
- (BOOL)waitUntilSettled:(NSTimeInterval)timeout;
- (void)cancel;
@end
