// Animated 10 m model wind flow, projected as tangent geometry in the map camera.
#import <AppKit/AppKit.h>
#import "ownrender.h"
#import "fieldrender.h"

BOOL WindMapProjectOffset(IsobarCamera camera, double latitude, double longitude,
                         double eastM, double northM, NSPoint *point);
@interface WindMapView : NSView
@property(nonatomic,strong) OwnRun *run;
@property(nonatomic) IsobarCamera camera;
@property(nonatomic) double fractionalStep;
@property(nonatomic) BOOL chartDark;
// The optional legacy overlay. Flow trails are the default surface rendering.
@property(nonatomic) BOOL barbs;
@property(nonatomic) BOOL windLens;
// Animated trails. Off draws only barbs (if any) and leaves the particle state
// untouched; the host hides the view when neither is wanted. Default YES.
@property(nonatomic) BOOL flow;
// Upper bound on live particles (0 = only the area-based density).
@property(nonatomic) NSUInteger maxParticles;
@property(nonatomic) BOOL reducedMotion;
// Host display time in seconds. `advanceBy:` is deterministic and is used by
// both the display link and offscreen tests; changing it does not reseed.
@property(nonatomic) double time;
- (void)advanceBy:(double)seconds;
// Marks the view for display at most 30 times per second of `time`; a skipped
// request is honoured by the next advance or a short deferred redraw.
- (void)requestDisplay;
// Main-thread cost of the most recent drawRect, and a counter of draws.
@property(nonatomic,readonly) double lastDrawMilliseconds;
@property(nonatomic,readonly) NSUInteger drawSerial;
// A display was requested and has not been drawn yet (tracked here because a
// view outside a window does not keep needsDisplay).
@property(nonatomic,readonly) BOOL displayPending;
@property(nonatomic,readonly) NSUInteger drawnCount;
// Model grid points (as "j,i") that carried a barb on the last draw. Barbs are
// anchored to the grid, so a pan keeps the same points under the same barbs.
@property(nonatomic,readonly,copy) NSSet<NSString *> *barbCells;
// On screen the trails are one CAShapeLayer per alpha bucket, rasterised by
// the window server, so drawRect spends main-thread time only on the
// particles. A snapshot strokes the same pieces into the current context.
- (void)drawSnapshotInCurrentContext;
// Trail pieces handed to the shape layers on the last live draw.
@property(nonatomic,readonly) NSUInteger layerSegments;
@property(nonatomic,readonly) double maxSegmentPixels;
@end
