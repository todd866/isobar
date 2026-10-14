#import "terrainmap.h"
#import "mapcamera.h"
#import <stdio.h>
static int bad;
static void Check(BOOL yes,const char *name) { fprintf(stderr,"%s %s\n",yes?"ok":"FAIL",name); if(!yes)bad++; }
static NSData *Pixels(CGImageRef image) { return image ? CFBridgingRelease(CGDataProviderCopyData(CGImageGetDataProvider(image))) : nil; }
static NSUInteger Difference(NSData *a,NSData *b) {
    if(!a || !b || a.length!=b.length) return NSUIntegerMax;
    const uint8_t *x=a.bytes,*y=b.bytes;NSUInteger n=0;
    for(NSUInteger i=0;i<a.length;i++) if(abs(x[i]-y[i])>2)n++;
    return n;
}
int main(void) { @autoreleasepool {
    setenv("ISOBAR_TERRAIN_TILES","Tests/fixtures/terrain",1);
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    IsobarTerrainMap *terrain=[[IsobarTerrainMap alloc] initWithDevice:device];
    IsobarCamera camera=MapCameraMake(27.9881,86.925,256,0,512,512);
    [terrain updateCamera:camera]; Check([terrain waitUntilSettled:10],"terrain prepared off-thread");
    IsobarFieldRenderer *r=[[IsobarFieldRenderer alloc] initWithDevice:device]; Check(r!=nil,"relief shader compiles");
    if(!r) return 1;
    IsobarGeoGrid grid={.west=-180,.north=90,.step=2,.nLon=180,.nLat=91,.wrapsLongitude=YES};
    [r setGrid:grid];r.pressureSmoothDegrees=0;
    float *values=malloc(180*91*sizeof(float));for(int i=0;i<180*91;i++)values[i]=1008;
    Check([r uploadStep:0 kind:IsobarFieldPressure values:values error:nil],"weather fixture uploads");
    for(int i=0;i<180*91;i++)values[i]=20;
    Check([r uploadStep:0 kind:IsobarFieldTemperature values:values error:nil],"temperature fixture uploads");free(values);
    for(int dark=0;dark<2;dark++) {
        r.chartDark=dark;
        [r setTerrainMosaic:nil relief:0];
        CGImageRef a=[r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:camera error:nil];NSData *flat=Pixels(a);if(a)CGImageRelease(a);
        [r setTerrainMosaic:terrain.mosaic relief:1];
        CGImageRef b=[r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:camera error:nil];NSData *relief=Pixels(b);if(b)CGImageRelease(b);
        NSUInteger changed=Difference(flat,relief);Check(changed!=NSUIntegerMax && changed>1000,"measured relief changes light/dark land pixels");
        [r setTerrainMosaic:terrain.mosaic relief:0];
        CGImageRef c=[r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:camera error:nil];NSData *faded=Pixels(c);if(c)CGImageRelease(c);
        Check(Difference(flat,faded)==0,"zero-strength relief preserves synoptic plate");
        [r setTerrainMosaic:terrain.mosaic relief:1];
        CGImageRef d=[r renderTime:0 fill:IsobarFieldTemperature isobars:NO camera:camera error:nil];NSData *weather=Pixels(d);if(d)CGImageRelease(d);
        Check(Difference(relief,weather)>1000,"weather colour remains above relief");
        Check(fabs([r pickValueAtX:256 y:256 camera:camera time:0 kind:IsobarFieldTemperature]-20)<.01,"terrain does not change physical weather readout");
    }
    IsobarCamera empty=camera;empty.centreLon=10;empty.centreLat=30;[terrain updateCamera:empty];[terrain waitUntilSettled:10];
    [r setTerrainMosaic:nil relief:0];CGImageRef a=[r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:empty error:nil];NSData *flat=Pixels(a);if(a)CGImageRelease(a);
    [r setTerrainMosaic:terrain.mosaic relief:1];CGImageRef b=[r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:empty error:nil];NSData *missing=Pixels(b);if(b)CGImageRelease(b);
    Check(Difference(flat,missing)==0,"missing tiles preserve flat tint exactly");
    return bad?1:0;
} }
