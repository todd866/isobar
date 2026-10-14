#import "terrainmap.h"
#import "mapcamera.h"
#import <stdio.h>
#import <float.h>
static int bad;
static void Check(BOOL yes,const char *name) { fprintf(stderr,"%s %s\n",yes?"ok":"FAIL",name); if(!yes)bad++; }
int main(void) { @autoreleasepool {
    setenv("ISOBAR_TERRAIN_TILES",[[@"Tests/fixtures/terrain" stringByStandardizingPath] UTF8String],1);
    id<MTLDevice> device=MTLCreateSystemDefaultDevice(); Check(device!=nil,"Metal available");
    TerrainPlan plan=TerrainPlanForView((TerrainBox){86,27,88,29},350);
    Check(plan.width>0 && plan.height>0 && plan.width*plan.height<=kTerrainMaxTexels,"mosaic texel budget");
    Check(TerrainPlanForView((TerrainBox){NAN,0,2,3},350).width==0,"invalid plan fails closed");
    TerrainBox dateline;double density;
    Check(TerrainViewForCamera(MapCameraMake(0,179.9,256,0,512,512),&dateline,&density) && dateline.east-dateline.west<3 && dateline.east>180,"dateline view remains continuous and local");
    Check(TerrainPlanForView((TerrainBox){86,27,88,29},DBL_MAX).width>0,"extreme finite density stays bounded");
    Check(TerrainReliefStrength(120)==0 && TerrainReliefStrength(10)==1,"relief fades with scale");
    IsobarTerrainMap *map=[[IsobarTerrainMap alloc] initWithDevice:device];
    IsobarCamera camera=MapCameraMake(27.9881,86.925,256,0,512,512);
    [map updateCamera:camera]; Check([map waitUntilSettled:10],"offline mosaic settles");
    IsobarTerrainMosaic *m=map.mosaic;
    Check(m.covered>0 && m.texture!=nil && m.zoom==8,"fixture contributes a Metal mosaic");
    double h=[m elevationAtLatitude:27.9881 longitude:86.925];
    Check(isfinite(h)&&h>8300&&h<8800,"geographic sample agrees with coarse summit tile");
    Check(isnan([m elevationAtLatitude:0 longitude:0]),"outside mosaic is missing");
    Check(isnan([m elevationAtLatitude:m.box.north+1e-6 longitude:(m.box.east+m.box.west)/2]),"point immediately beyond mosaic edge stays missing");
    Check(m.covered<(NSUInteger)m.width*m.height,"partly covered mosaic retains gaps");
    Check(isnan([m elevationAtLatitude:m.box.south longitude:m.box.west]),"missing neighbour is not filled across a tile gap");
    camera.centreLat=-33;camera.centreLon=150; [map updateCamera:camera];
    camera.centreLat=30;camera.centreLon=10; [map updateCamera:camera];
    Check([map waitUntilSettled:10],"latest request settles after superseded view");
    Check(map.mosaic.covered==0 && isnan([map.mosaic elevationAtLatitude:30 longitude:10]),"missing tile never invents a height");
    Check(map.mosaic.box.west<10 && map.mosaic.box.east>10,"superseded result cannot overwrite newest view");
    [map cancel]; Check([map waitUntilSettled:1],"cancel settles without main-thread deadlock");
    return bad?1:0;
} }
