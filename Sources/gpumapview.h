// GPU map surface for the popover and the expanded window. One CAMetalLayer,
// one field renderer, the shared playhead. This view does not keep a second
// forecast timer: a display tick samples the player's anchor and rate.
#import <AppKit/AppKit.h>
#import "fieldrender.h"
#import "ownrender.h"
#import "playback.h"
#import "traffic.h"
#import "windmapview.h"

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

// Place readings remain classic-only; existing wind barbs project in 3D.
BOOL GPUMapTagIsClassicOnly(NSInteger tag);
// When `note` is set and the item is classic-only, append "Classic map only".
NSString *GPUMapMenuTitle(NSString *title, BOOL classicOnly, BOOL note);

@interface GPUMapView : NSView
@property (nonatomic, copy) NSDictionary *trafficSnapshot;
@property (nonatomic, strong) TrafficTrackSession *trafficSession;
@property (nonatomic) BOOL trafficEnabled;
@property (nonatomic) BOOL trafficIsNow;
// Selected forecast/live timestamp used to sample locally captured traffic.
@property (nonatomic, strong) NSDate *trafficDate;
// A held Now frame stays visible while the playhead is paused; later polls
// cannot move that picture until live playback is explicitly resumed.
@property (nonatomic, copy) NSDictionary *trafficHoldSnapshot;
@property (nonatomic, strong) NSDate *trafficHoldDate;
@property (nonatomic) BOOL trafficHolding;
@property (nonatomic, strong) NSTimeZone *trafficZone;
@property (nonatomic, copy) NSDictionary *trafficRoutes;
@property (nonatomic, copy) void (^onTrafficSelection)(NSString *hex, BOOL selected);
@property (nonatomic, copy) void (^onPlainClick)(double latitude, double longitude);
// Clicked-point selection is independent of the home place and forecast clock.
- (void)selectPointLatitude:(double)latitude longitude:(double)longitude;
- (BOOL)closePointDetail;
@property(nonatomic, readonly, copy) NSDictionary *pointSample;
// Floating controller chrome in this view's coordinates; refreshed on layout.
@property(nonatomic, copy) NSArray<NSValue *> *pointCardReservedRects;
// Pointer ownership for the shared clock. YES is emitted on mouse-down and
// NO on mouse-up, cancellation, or window teardown; dragging remains camera-only.
@property (nonatomic, copy) void (^onHoldChanged)(BOOL held);
@property (nonatomic, copy) void (^onCameraChanged)(IsobarCamera camera);
// Optional, dependency-free diagnostics seam. The controller owns the
// recorder; this view only reports meaningful map events and a cheap snapshot
// of its current camera/mode/GPU state.
@property (nonatomic, copy) void (^onFeedbackEvent)(NSString *category, NSDictionary *details);
@property (nonatomic, readonly, copy) NSDictionary *feedbackDiagnosticState;
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
// Draws, as AppKit would before the next commit, every visible overlay subview
// that this frame marked for display (wind trails, atmosphere, hazards, names)
// and returns that main-thread cost in milliseconds. Frame-time gates add it
// to lastFrameMilliseconds, which covers only displayAtTime:.
- (double)drawPendingOverlays;
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
- (void)showTrafficNotice:(NSString *)notice;
// The popover hides the 2D/3D control. Recenter appears only after a move.
@property (nonatomic) BOOL popoverChrome;
// Suspends the display link and animated overlays while a feedback note is
// being entered. Camera, morph target, and playhead state remain untouched;
// copySnapshot remains available for the frozen capture.
@property (nonatomic) BOOL feedbackSuspended;
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
@property (nonatomic) BOOL windBarbs;
// Animated surface trails. adoptRun turns them on for the wind-speed field
// (Wind and Kite lenses) and off otherwise; the trail view is hidden and
// stops advancing when neither trails nor barbs are wanted.
@property (nonatomic) BOOL windFlow;
// Optional atmospheric profile supplied by the shared controller. This view
// only stores the profile and its focus; atmospheric drawing is a later layer.
@property (nonatomic, copy) NSDictionary *atmosphereProduct;
@property (nonatomic) double atmosphereLatitude;
@property (nonatomic) double atmosphereLongitude;
@property (nonatomic, strong) NSDate *atmosphereDate;
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
// Starlink lens (Sources/starlink.h): every satellite over the map as
// StarlinkSkyPoint records, at the wall clock rather than the forecast
// playhead (the panel and the dish are live). Satellites high enough for the
// dish (≥25° from home) are darker; `starlinkServing` (a catalogue index, or
// -1) is ringed in the link accent while current, muted once its slot ends.
// Nil hides the layer. Drawn over the field like hazards, GPU map only.
@property (nonatomic, copy) NSData *starlinkSky;
@property (nonatomic) NSInteger starlinkServing;
@property (nonatomic) BOOL starlinkServingCurrent;
// Satellites the last on-screen or snapshot draw placed in view.
@property (nonatomic, readonly) NSUInteger starlinkDrawn;
+ (instancetype)mapView;
- (void)stopRendering;
- (void)adoptRun:(OwnRun *)run temperature:(int)temperature windFill:(BOOL)windFill rain:(BOOL)rain;
- (void)installGrid:(IsobarGeoGrid)grid steps:(NSInteger)steps;
- (BOOL)uploadStep:(NSInteger)step kind:(IsobarFieldKind)kind values:(const float *)values
             error:(NSError **)error;
- (void)waitForUploads;
// Offscreen QA only; production rendering never blocks on terrain.
- (BOOL)waitForTerrain;
@property(nonatomic,readonly) NSUInteger terrainCoveredTexels;
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
// Keyboard navigation is active only while the view is explicitly in 3D.
// Modifiers remain available to AppKit and text controls.
- (BOOL)handle3DKeyEvent:(NSEvent *)event;
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
