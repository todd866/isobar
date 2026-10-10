#import <AppKit/AppKit.h>
#import "windmapview.h"
#import <math.h>
@interface TestWindRun : OwnRun
@property(nonatomic) double speed;
@end
@implementation TestWindRun
- (OwnRunGeo)geo { return (OwnRunGeo){.west=-180,.north=90,.step=.5,.nLon=720,.nLat=361,.wrapsLongitude=YES}; }
- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field fractionalHour:(double)hour {
    (void)point;(void)hour;return field==OwnRunFieldWindSpeed?self.speed:315;
}
@end
static NSUInteger Render(WindMapView *view, NSString *name) {
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:640 pixelsHigh:420 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
    [view drawRect:view.bounds];
    [NSGraphicsContext restoreGraphicsState];
    NSUInteger ink=0;
    for(NSInteger y=0;y<rep.pixelsHigh;y++)for(NSInteger x=0;x<rep.pixelsWide;x++) {
        NSUInteger pixel[4];[rep getPixel:pixel atX:x y:y];if(pixel[3]>15)ink++;
    }
    [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa/wind" withIntermediateDirectories:YES attributes:nil error:NULL];
    [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[@"build/qa/wind" stringByAppendingPathComponent:name] atomically:YES];
    return ink;
}
int main(void) { @autoreleasepool {
    IsobarCamera c={.centreLat=-32,.centreLon=116,.zoom=30,.viewportW=1000,.viewportH=700};
    NSPoint a,b; int failures=0;
    BOOL flat=WindMapProjectOffset(c,-32,116,0,0,&a)&&WindMapProjectOffset(c,-32,116,0,10000,&b);
    double overhead=hypot(b.x-a.x,b.y-a.y);
    c.pitch=1.05;c.globe=1;
    BOOL tilted=WindMapProjectOffset(c,-32,116,0,0,&a)&&WindMapProjectOffset(c,-32,116,0,10000,&b);
    if(!flat||!tilted||!(hypot(b.x-a.x,b.y-a.y)<overhead*.85)){fprintf(stderr,"FAIL wind geometry must foreshorten\n");failures++;}
    c.centreLat=89.9;c.centreLon=179.9;
    if(!WindMapProjectOffset(c,89.9,179.9,1000,0,&a)||!isfinite(a.x)){fprintf(stderr,"FAIL polar vector\n");failures++;}
    c.centreLat=0;c.centreLon=0;
    if(WindMapProjectOffset(c,0,180,1000,0,&a)){fprintf(stderr,"FAIL far-side vector must be hidden\n");failures++;}
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    WindMapView *view=[[WindMapView alloc] initWithFrame:NSMakeRect(0,0,640,420)];
    TestWindRun *run=[TestWindRun new];view.run=run;
    c.centreLat=-32;c.centreLon=116;c.zoom=30;view.camera=c;
    for(NSNumber *speed in @[@15,@65,@125]) {
        run.speed=speed.doubleValue;
        NSUInteger ink=Render(view,[NSString stringWithFormat:@"tilted-%@.png",speed]);
        if(view.drawnCount<10||ink<150){fprintf(stderr,"FAIL real wind barbs not visible at %.0f kt (%lu, %lu pixels)\n",run.speed,(unsigned long)view.drawnCount,(unsigned long)ink);failures++;}
    }
    run.speed=NAN;
    if(Render(view,@"missing.png")!=0||view.drawnCount){fprintf(stderr,"FAIL missing wind must stay blank\n");failures++;}
    printf("wind map geometry failures: %d\n",failures); return failures?1:0;
} }
