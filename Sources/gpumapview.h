// GPU map surface for the popover and the expanded window. One CAMetalLayer,
// one field renderer, the shared playhead. This view does not keep a second
// forecast timer: a display tick samples the player's anchor and rate.
#import <AppKit/AppKit.h>
#import "fieldrender.h"
#import "ownrender.h"
#import "playback.h"

// Absent key is on, so this build opens on the new map. The classic chart
// stays one switch away.
extern NSString *const GPUMapEnabledKey;
BOOL GPUMapEnabledInDefaults(NSUserDefaults *defaults);
void GPUMapSetEnabled(NSUserDefaults *defaults, BOOL enabled);

typedef NS_ENUM(NSInteger, GPUMapSurface) {
    GPUMapSurfaceUnavailable = 0, // no chart: the existing "Chart unavailable" cue
    GPUMapSurfaceClassic,         // Core Graphics chart
    GPUMapSurfaceNew              // this view
};
// A failed cold start is unavailable either way. A kept run stays on screen.
GPUMapSurface GPUMapSurfaceFor(BOOL newMapEnabled, BOOL chartsReady);

// Wind barbs and place readings have no GPU drawing yet. Colour fields do.
BOOL GPUMapTagIsClassicOnly(NSInteger tag);
// When `note` is set and the item is classic-only, append "Classic map only".
NSString *GPUMapMenuTitle(NSString *title, BOOL classicOnly, BOOL note);

@interface GPUMapView : NSView
@property (nonatomic, copy) void (^onPlainClick)(void);
// The controller freezes forecast time for the full pointer hold, including
// a drag that becomes a map pan.
@property (nonatomic, copy) void (^onHoldChanged)(BOOL held);
@property (nonatomic, weak) IsobarLivePlayer *timeline;
@property (nonatomic) double fractionalStep;
@property (nonatomic, readonly) double renderedStep;
@property (nonatomic, readonly) NSUInteger renderCount;
// Milliseconds of the last display sample, contour build included.
@property (nonatomic, readonly) double lastFrameMilliseconds;
@property (nonatomic, readonly) double lastContourMilliseconds;
@property (nonatomic, readonly) double lastLabelMilliseconds;
@property (nonatomic, readonly) double lastProjectMilliseconds;
@property (nonatomic, readonly) double lastGeometryMilliseconds;
// Display ticks redraw the shared playhead. They do not own a forecast timer.
@property (nonatomic, readonly) BOOL ownsForecastTimer;
// Drawable presents. A snapshot does not count: the on-screen layer stays
// blank until one of these lands. `presentedFrameBlank` is YES until a present
// draws isobars. `onPresentFailed` runs if a frame was wanted and none was
// presented within 0.5 s. `suppressPresentation` is the test seam for that.
@property (nonatomic, readonly) NSUInteger presentedCount;
@property (nonatomic, readonly) BOOL presentedFrameBlank;
@property (nonatomic, copy) void (^onPresentFailed)(void);
@property (nonatomic) BOOL suppressPresentation;
- (void)presentNow;
// The popover hides the 2D/3D control. Recenter appears only after a move.
@property (nonatomic) BOOL popoverChrome;
@property (nonatomic, readonly) BOOL userMovedMap;
// The same geographic window as the classic popover chart.
- (void)frameAustralia;
@property (nonatomic) IsobarCamera camera;
@property (nonatomic) BOOL didPlaceCamera;
@property (nonatomic) double placeLatitude;
@property (nonatomic) double placeLongitude;
- (void)setPlaceLatitude:(double)latitude longitude:(double)longitude;
@property (nonatomic, readonly) NSRect placeMarkerFrame;
// Natural Earth place names around a regional view (under ~45° across); the
// last on-screen draw and the last copySnapshot.
@property (nonatomic, readonly, copy) NSArray<NSString *> *placeNamesShown;
@property (nonatomic, readonly, copy) NSArray<NSString *> *snapshotPlaceNames;
@property (nonatomic) BOOL stale;
@property (nonatomic) BOOL unavailable;
// Nil follows the system setting. Tests pin YES or NO.
@property (nonatomic, strong) NSNumber *reducedMotionOverride;
@property (nonatomic, readonly) IsobarFieldKind fill;
// Aviation hazard layer (Sources/hazard.h): model CB potential and SIGMETs
// valid at the playhead, over the field and isobars. Off by default and not
// persisted here; the owner's control decides. The CB inputs load from the
// published grids under `hazardStoreRoot` for the adopted run, off the main
// thread; frames build on a background queue, cached by step/0.02.
@property (nonatomic) BOOL hazards;
@property (nonatomic, copy) NSString *hazardStoreRoot;
// The stored SIGMET product (StoreSnapshot.sigmets).
@property (nonatomic, copy) NSDictionary *sigmetProduct;
// YES once the CB inputs for the adopted run are loaded (or failed closed).
@property (nonatomic, readonly) BOOL hazardsReady;
// Blocks until the hazard load and any queued frame build finish (tests).
- (void)waitForHazards;
// Hover text at a view point (points, y down), or nil.
- (NSString *)hazardTooltipAtPoint:(NSPoint)point;
// Labels the last copySnapshot drew for hazards ("CB OCNL", "SIGMET …", key).
@property (nonatomic, readonly, copy) NSArray<NSString *> *hazardLabels;
// Milliseconds the main thread spent on the hazard overlay in the last frame.
@property (nonatomic, readonly) double lastHazardMilliseconds;
+ (instancetype)mapView;
- (void)stopRendering;
- (void)adoptRun:(OwnRun *)run temperature:(int)temperature windFill:(BOOL)windFill rain:(BOOL)rain;
- (void)installGrid:(IsobarGeoGrid)grid steps:(NSInteger)steps;
- (BOOL)uploadStep:(NSInteger)step kind:(IsobarFieldKind)kind values:(const float *)values
             error:(NSError **)error;
- (void)waitForUploads;
- (void)pointerDown:(NSPoint)point;
- (void)pointerDrag:(NSPoint)point;
- (void)pointerUp:(NSPoint)point;
- (BOOL)pinchFactor:(double)factor atPoint:(NSPoint)point;
- (void)scrollByX:(double)dx y:(double)dy atPoint:(NSPoint)point precise:(BOOL)precise command:(BOOL)command;
- (void)zoomBy:(double)factor;
- (void)resetZoom;
- (void)recenter;
- (void)animateGlobeTo:(double)target reducedMotion:(BOOL)reduced;
- (BOOL)handleGlobeKey:(NSString *)characters repeat:(BOOL)repeat;
// Morphs the globe and redraws. Does not change `fractionalStep` unless a
// playing timeline is attached, in which case `displayAtTime:` samples it first.
- (void)advanceDisplay:(double)dt;
// Samples the shared player at `time` (a display-link target, in the player's
// clock) and redraws. With no playing timeline, the host's fractional step stays.
- (void)displayAtTime:(NSTimeInterval)time;
- (CGImageRef)copySnapshot CF_RETURNS_RETAINED;
// Isobars from the last render. The Australian crop is contoured on this
// thread; a larger grid stays on the async path.
@property (nonatomic, readonly) BOOL contoursAreSynchronous;
@property (nonatomic, readonly) NSInteger contourLineCount;
// Isobar labels from the last presented frame, in viewport pixels.
- (NSInteger)presentedLabelCount;
- (BOOL)presentedLabelAtIndex:(NSInteger)index x:(double *)x y:(double *)y level:(double *)level halfW:(double *)halfW;
- (uint32_t)presentedLabelIdentAtIndex:(NSInteger)index;
- (NSInteger)contourVertexCountForLine:(NSInteger)line;
- (BOOL)contourVertexForLine:(NSInteger)line
                        index:(NSInteger)index
                     latitude:(double *)latitude
                    longitude:(double *)longitude;
@end
