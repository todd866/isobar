#import "terrainmap.h"
#import <math.h>

static const double kLimit = 85.05112878;
static double Wrap(double x) { return x-360*floor((x+180)/360); }
static BOOL BoxOK(TerrainBox b) {
    return isfinite(b.west) && isfinite(b.east) && isfinite(b.south) && isfinite(b.north)
        && b.east>b.west && b.east-b.west<=360 && b.north>b.south && b.north<=kLimit && b.south>=-kLimit;
}
static BOOL Contains(TerrainBox outer,TerrainBox inner) {
    double shift=360*round(((outer.west+outer.east)-(inner.west+inner.east))/720);
    return inner.west+shift>=outer.west && inner.east+shift<=outer.east && inner.south>=outer.south && inner.north<=outer.north;
}
double TerrainReliefStrength(double span) {
    if (!isfinite(span) || span<=0) return 0;
    double t=MAX(0,MIN(1,(75-span)/(75-12))); return t*t*(3-2*t);
}
BOOL TerrainViewForCamera(IsobarCamera cam,TerrainBox *box,double *density) {
    if (!(cam.zoom>=2) || !isfinite(cam.zoom) || cam.viewportW<2 || cam.viewportH<2) return NO;
    TerrainBox b={INFINITY,INFINITY,-INFINITY,-INFINITY};
    for (int i=0;i<=8;i++) for (int side=0;side<4;side++) {
        double t=i/8.0,x=side<2?t*cam.viewportW:(side==2?0:cam.viewportW);
        double y=side>=2?t*cam.viewportH:(side==0?0:cam.viewportH),lat,lon;
        if (!IsobarCameraUnproject(cam,x,y,&lat,&lon)) continue;
        lon=Wrap(cam.centreLon)+Wrap(lon-cam.centreLon);
        b.west=MIN(b.west,lon); b.east=MAX(b.east,lon);
        b.south=MIN(b.south,lat); b.north=MAX(b.north,lat);
    }
    b.south=MAX(-kLimit,b.south); b.north=MIN(kLimit,b.north);
    if (!BoxOK(b) || TerrainReliefStrength(b.north-b.south)<.001) return NO;
    if (box) *box=b;
    if (density) *density=cam.viewportW/(b.east-b.west);
    return YES;
}
static void Range(TerrainBox b,int z,int *x0,int *x1,int *y0,int *y1) {
    int n=1<<z;
    *x0=(int)floor(TerrainLonToTileX(b.west,z)); *x1=(int)ceil(TerrainLonToTileX(b.east,z))-1;
    *y0=MAX(0,(int)floor(TerrainLatToTileY(b.north,z))); *y1=MIN(n-1,(int)ceil(TerrainLatToTileY(b.south,z))-1);
}
TerrainPlan TerrainPlanForView(TerrainBox b,double density) {
    if (!BoxOK(b) || !isfinite(density) || density<=0) return (TerrainPlan){0};
    double span=b.east-b.west; b.west=Wrap(b.west); b.east=b.west+span;
    double dx=span*.20,dy=(b.north-b.south)*.20;
    b.west-=dx; b.east+=dx; b.south=MAX(-kLimit,b.south-dy); b.north=MIN(kLimit,b.north+dy);
    if (b.east-b.west>360) { double mid=(b.east+b.west)*.5; b.west=mid-180; b.east=mid+180; }
    double zoom=ceil(log2(density)+log2(360.0/512));
    int z=(int)MAX(0,MIN(kTerrainMaxZoom,zoom));
    int x0,x1,y0,y1;
    for (;;) { Range(b,z,&x0,&x1,&y0,&y1); if (z==0 || (int64_t)(x1-x0+1)*(y1-y0+1)<=kTerrainMaxViewTiles) break; z--; }
    double d=MIN(density,512*(double)(1<<z)/360),w=MAX(2,ceil((b.east-b.west)*d)),h=MAX(2,ceil((b.north-b.south)*d));
    double scale=MIN(1,sqrt(kTerrainMaxTexels/(w*h)));
    return (TerrainPlan){b,z,MAX(2,(int)floor(w*scale)),MAX(2,(int)floor(h*scale))};
}
@interface IsobarTerrainMosaic ()
@property(nonatomic) TerrainBox box;
@property(nonatomic) int zoom,width,height;
@property(nonatomic) NSUInteger covered;
@property(nonatomic,strong) NSData *samples;
@property(nonatomic,strong) id<MTLTexture> texture;
@end
@implementation IsobarTerrainMosaic
+ (instancetype)mosaicWithBox:(TerrainBox)box width:(int)width height:(int)height samples:(NSData *)samples device:(id<MTLDevice>)device {
    if (!BoxOK(box) || width<2 || height<2 || samples.length!=(NSUInteger)width*height*2*sizeof(float)) return nil;
    IsobarTerrainMosaic *m=[IsobarTerrainMosaic new]; m.box=box; m.width=width; m.height=height; m.samples=[samples copy];
    const float *p=m.samples.bytes; NSUInteger covered=0;
    for (NSUInteger i=0;i<(NSUInteger)width*height;i++) if (p[i*2+1]>=1) covered++;
    m.covered=covered;
    if (device) {
        MTLTextureDescriptor *desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRG32Float width:width height:height mipmapped:NO];
        desc.usage=MTLTextureUsageShaderRead; desc.storageMode=MTLStorageModeShared;
        m.texture=[device newTextureWithDescriptor:desc];
        [m.texture replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:p bytesPerRow:width*2*sizeof(float)];
    }
    return m;
}
- (double)elevationAtLatitude:(double)lat longitude:(double)lon {
    if (!isfinite(lat)||!isfinite(lon)||!_samples.length) return NAN;
    lon=(_box.west+_box.east)/2+Wrap(lon-(_box.west+_box.east)/2);
    if (lat<_box.south||lat>_box.north||lon<_box.west||lon>_box.east) return NAN;
    double x=MAX(0,MIN(_width-1,(lon-_box.west)/(_box.east-_box.west)*_width-.5));
    double y=MAX(0,MIN(_height-1,(lat-_box.south)/(_box.north-_box.south)*_height-.5));
    int x0=(int)floor(x),y0=(int)floor(y),x1=MIN(_width-1,x0+1),y1=MIN(_height-1,y0+1);
    const float *p=_samples.bytes; int at[]={y0*_width+x0,y0*_width+x1,y1*_width+x0,y1*_width+x1};
    for(int i=0;i<4;i++) if(p[at[i]*2+1]<1) return NAN;
    double a=x-x0,b=y-y0;
    return (1-b)*((1-a)*p[at[0]*2]+a*p[at[1]*2])+b*((1-a)*p[at[2]*2]+a*p[at[3]*2]);
}
@end

@implementation IsobarTerrainMap {
    id<MTLDevice> _device;
    IsobarTerrainTileStore *_tiles;
    NSCondition *_state;
    dispatch_queue_t _queue;
    TerrainPlan _plan;
    BOOL _requested, _building;
    NSUInteger _generation,_settled,_tileGeneration;
    IsobarTerrainMosaic *_mosaic;
    NSTimeInterval _retryAfter;
}
- (instancetype)initWithDevice:(id<MTLDevice>)device {
    if (!(self=[super init])) return nil;
    _device=device; _tiles=[IsobarTerrainTileStore new]; _state=[NSCondition new];
    _queue=dispatch_queue_create("isobar.terrain.mosaic",DISPATCH_QUEUE_SERIAL); return self;
}
- (IsobarTerrainMosaic *)mosaic { [_state lock]; IsobarTerrainMosaic *m=_mosaic; [_state unlock]; return m; }
- (BOOL)current:(NSUInteger)generation { [_state lock]; BOOL yes=_generation==generation; [_state unlock]; return yes; }
- (void)cancel { [_state lock]; _generation++; _settled=_generation; _requested=NO; [_state broadcast]; [_state unlock]; [_tiles cancelAll]; }
- (void)updateCamera:(IsobarCamera)camera {
    TerrainBox view; double density;
    if (!TerrainViewForCamera(camera,&view,&density)) return;
    [self updateBox:view density:density];
}
- (void)updateBox:(TerrainBox)view density:(double)density {
    view.south=MAX(-kLimit+1e-6,view.south); view.north=MIN(kLimit-1e-6,view.north);
    if (!BoxOK(view)) return;
    TerrainPlan plan=TerrainPlanForView(view,density);
    if (plan.width<2) return;
    [_state lock];
    BOOL stale=!_requested || plan.zoom!=_plan.zoom || !Contains(_plan.box,view)
        || _plan.box.east-_plan.box.west>4*(plan.box.east-plan.box.west)
        || (_settled==_generation && _retryAfter>0 && NSDate.timeIntervalSinceReferenceDate>=_retryAfter);
    if (!stale) { [_state unlock]; return; }
    _plan=plan; _requested=YES; ++_generation;
    // The newest camera owns the bounded request slots. Do not leave an old
    // continent queued ahead of a pan's tiles. Fence while holding _state so
    // the drain cannot start newer requests until cancellation is complete.
    [_tiles cancelAll]; _tileGeneration=_tiles.generation;
    BOOL start=!_building; _building=YES; [_state unlock];
    if (!start) return;
    __weak IsobarTerrainMap *weak=self;
    dispatch_async(_queue,^{ @autoreleasepool { [weak drain]; } });
}
- (void)drain {
    for (;;) {
        [_state lock]; TerrainPlan plan=_plan; NSUInteger generation=_generation,batch=_tileGeneration; BOOL requested=_requested; [_state unlock];
        if(requested) [self build:plan generation:generation batch:batch];
        [_state lock]; BOOL finished=generation==_generation || !_requested;
        if(finished) _building=NO; [_state unlock];
        if(finished) return;
    }
}
- (BOOL)waitUntilSettled:(NSTimeInterval)timeout {
    [_state lock]; NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:timeout];
    while (_settled<_generation && deadline.timeIntervalSinceNow>0) [_state waitUntilDate:deadline];
    BOOL done=_settled==_generation; [_state unlock]; return done;
}
- (void)build:(TerrainPlan)plan generation:(NSUInteger)generation batch:(NSUInteger)batch {
    if (![self current:generation]) return;
    int x0,x1,y0,y1; Range(plan.box,plan.zoom,&x0,&x1,&y0,&y1);
    NSMutableDictionary<NSString *,TerrainTileSnapshot *> *tiles=[NSMutableDictionary dictionary];
    // Cancelled tile requests intentionally suppress their callbacks. A GCD
    // group would therefore retain an unmatched enter forever. The condition
    // and counter are ordinary ARC-owned batch state, safe to abandon.
    NSCondition *tileLock=[NSCondition new];
    __block NSInteger remaining=(x1-x0+1)*(y1-y0+1);
    // The store admits each request only while this batch's generation is
    // current, atomically with cancelAll: a camera change mid-loop cannot
    // leave this obsolete batch holding the new view's download slots.
    BOOL superseded=NO;
    for(int y=y0;y<=y1 && !superseded;y++) for(int x=x0;x<=x1 && !superseded;x++) {
        superseded=![_tiles requestZoom:plan.zoom x:x y:y generation:batch completion:^(TerrainTileResult result,TerrainTileSnapshot *tile,NSError *error) {
            (void)result; (void)error;
            [tileLock lock];
            if(tile) tiles[[NSString stringWithFormat:@"%d/%d",tile.x,tile.y]]=tile;
            remaining--; [tileLock broadcast]; [tileLock unlock];
        }];
    }
    if (superseded) return;
    // A cancellation never publishes partial stale work. Late callbacks own
    // only their small local dictionary and cannot mutate a newer mosaic.
    NSTimeInterval deadline=NSDate.timeIntervalSinceReferenceDate+25;
    [tileLock lock];
    while (remaining>0 && [self current:generation] && NSDate.timeIntervalSinceReferenceDate<deadline) {
        [tileLock waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:.1]];
    }
    BOOL timedOut=remaining>0;
    NSDictionary *ready=[tiles copy]; [tileLock unlock];
    if (![self current:generation]) return;
    int columns=x1-x0+1,rows=y1-y0+1;
    const uint16_t *tileSamples[kTerrainMaxViewTiles+4]={0};
    if(columns*rows>kTerrainMaxViewTiles+4) return;
    for(int y=y0;y<=y1;y++) for(int x=x0;x<=x1;x++) {
        TerrainTileSnapshot *tile=ready[[NSString stringWithFormat:@"%d/%d",TerrainWrapTileX(x,plan.zoom),y]];
        tileSamples[(y-y0)*columns+x-x0]=tile.samples.bytes;
    }
    NSUInteger count=(NSUInteger)plan.width*plan.height,covered=0;
    NSMutableData *data=[NSMutableData dataWithLength:count*2*sizeof(float)]; float *p=data.mutableBytes;
    for(int row=0;row<plan.height;row++) {
        double lat=plan.box.south+(row+.5)*(plan.box.north-plan.box.south)/plan.height;
        double ty=TerrainLatToTileY(lat,plan.zoom)*512-.5;
        int iy=(int)floor(ty),n=(1<<plan.zoom)*512;
        for(int col=0;col<plan.width;col++) {
            double lon=plan.box.west+(col+.5)*(plan.box.east-plan.box.west)/plan.width;
            double tx=TerrainLonToTileX(lon,plan.zoom)*512-.5; int ix=(int)floor(tx);
            double value=0; BOOL valid=YES;
            for(int dy=0;dy<2;dy++) for(int dx=0;dx<2;dx++) {
                int sx=ix+dx,sy=MAX(0,MIN(n-1,iy+dy));
                int tileX=(int)floor(sx/512.0),tileY=sy/512;
                int cx=tileX-x0,cy=tileY-y0;
                const uint16_t *tile=(cx>=0 && cx<columns && cy>=0 && cy<rows) ? tileSamples[cy*columns+cx] : NULL;
                float h=tile ? TerrainHalfToFloat(tile[(sy%512)*512+((sx%512+512)%512)]) : NAN;
                if(!isfinite(h)) valid=NO;
                else value+=h*(dx?tx-ix:1-(tx-ix))*(dy?ty-iy:1-(ty-iy));
            }
            NSUInteger at=((NSUInteger)row*plan.width+col)*2;
            if(valid) { p[at]=(float)value;p[at+1]=1;covered++; }
        }
    }
    if (![self current:generation]) return;
    IsobarTerrainMosaic *m=[IsobarTerrainMosaic new]; m.box=plan.box; m.zoom=plan.zoom;
    m.width=plan.width; m.height=plan.height; m.samples=data; m.covered=covered;
    MTLTextureDescriptor *desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRG32Float width:plan.width height:plan.height mipmapped:NO];
    desc.usage=MTLTextureUsageShaderRead;desc.storageMode=MTLStorageModeShared;
    m.texture=[_device newTextureWithDescriptor:desc];
    if(m.texture) [m.texture replaceRegion:MTLRegionMake2D(0,0,plan.width,plan.height) mipmapLevel:0 withBytes:p bytesPerRow:plan.width*2*sizeof(float)];
    [_state lock];
    if(_generation==generation) { _mosaic=m;_settled=generation;_retryAfter=(timedOut || ready.count<(NSUInteger)((x1-x0+1)*(y1-y0+1))) ? NSDate.timeIntervalSinceReferenceDate+60 : 0; [_state broadcast]; }
    [_state unlock];
}
@end
