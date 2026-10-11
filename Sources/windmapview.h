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
@property(nonatomic) BOOL reducedMotion;
// Host display time in seconds. `advanceBy:` is deterministic and is used by
// both the display link and offscreen tests; changing it does not reseed.
@property(nonatomic) double time;
- (void)advanceBy:(double)seconds;
@property(nonatomic,readonly) NSUInteger drawnCount;
@property(nonatomic,readonly) double maxSegmentPixels;
@end
