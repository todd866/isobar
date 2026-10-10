// Existing 10 m model wind barbs, projected as tangent geometry in the map camera.
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
@property(nonatomic,readonly) NSUInteger drawnCount;
@end
