// 3D terrain scene: the one height transform shared by the Metal mesh, the
// draped field, isobars, AppKit overlays, picking and the relief readout.
//
// A scene is an immutable pair of DEM mosaics (fine near the focus, coarse
// out to the horizon) registered under a token. A camera carrying that token
// (IsobarCamera.terrain) and a perspective tilt sees the displayed surface:
// an analytic triangle mesh whose vertices sample the blended DEM, every
// height multiplied by one display relief that depends only on the view's
// angular size. Readouts stay physical; only drawing is exaggerated.
// Missing tiles are sea level, never invented relief.
#import "terrainmap.h"

NS_ASSUME_NONNULL_BEGIN

enum { kTerrainMeshInner = 128, kTerrainMeshOuter = 64 };

// Display relief for a view `spanKm` tall at its focus: 1 at or below 25 km,
// rising smoothly to 4 at 500 km, then fading out between about 30° and 70°
// of latitude where relief is sub-pixel. Zero turns the mesh off.
FOUNDATION_EXPORT double TerrainReliefFactor(double spanKm);
// "relief ×4", "relief ×1.6"; nil when the camera shows no terrain mesh.
FOUNDATION_EXPORT NSString * _Nullable TerrainReliefLabel(IsobarCamera camera);

@interface IsobarTerrainScene : NSObject
- (instancetype)initWithNear:(nullable IsobarTerrainMosaic *)near far:(nullable IsobarTerrainMosaic *)far;
@property(nonatomic, readonly, nullable) IsobarTerrainMosaic *near, *far;
@property(nonatomic, readonly) double maxHeightM;
// Registers the scene (the registry keeps the eight newest) and returns its
// token. Retired scenes are released a few seconds later, never mid-frame.
- (uint64_t)registerScene;
@property(nonatomic, readonly) uint64_t token;
@end

// Fills the terrain view for a camera; NO when it shows no mesh. Exposed for
// tests; the renderer and projections use IsobarCameraTerrain.
FOUNDATION_EXPORT BOOL TerrainSceneResolve(IsobarCamera camera, IsobarTerrainView *view);
// Physical metres of the drawn mesh surface (clamped at sea level), and of
// the blended DEM under it.
FOUNDATION_EXPORT double TerrainSceneDisplayedHeight(const IsobarTerrainView *view, double latitude, double longitude);
FOUNDATION_EXPORT double TerrainSceneGroundHeight(const IsobarTerrainView *view, double latitude, double longitude);

// Owns the near and far tile maps behind the GPU map. Never blocks on tiles.
@interface IsobarTerrainSceneController : NSObject
- (instancetype)initWithDevice:(id<MTLDevice>)device;
// Requests tiles for this camera and returns the current scene's token, or 0
// while the camera is overhead (2D relief stays in IsobarTerrainMap).
- (uint64_t)updateCamera:(IsobarCamera)camera;
@property(nonatomic, readonly, nullable) IsobarTerrainScene *scene;
// Offscreen harness only.
- (BOOL)waitUntilSettled:(NSTimeInterval)timeout;
- (void)cancel;
@end

NS_ASSUME_NONNULL_END
