#import "windmapview.h"
#import <QuartzCore/QuartzCore.h>
#import "ownchart.h"
#import <math.h>
#import <time.h>

static const double kKnotsToMS=.514444, kLife=12, kFade=1.5, kVisual=3600, kMinSpeed=2.5;
static const NSUInteger kCapacity=1800;
// Eight alpha buckets of butt-capped straight pieces: one CGContextStrokeLineSegments
// call each. Round-capped Bézier paths in 64 buckets cost 40-300 ms per frame.
enum { kBuckets=8 };
static const double kMaxAlpha=.8,kMinInterval=1.0/30;
static double Now(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW)/1e9; }
typedef struct { double lon,lat,age,heading,turn,retireAge; BOOL hasHeading; } WindParticle;
typedef struct { double u,v; } WindVector;
static double Hash01(NSUInteger n) {
    uint32_t x=(uint32_t)n*0x45d9f3bU;
    x=(x^(x>>16))*0x45d9f3bU; x^=x>>16;
    return (double)x/4294967296.0;
}
static double Smooth(double x) { x=fmax(0,fmin(1,x)); return x*x*(3-2*x); }
static double Fade(double age) { return Smooth(age/kFade)*Smooth((kLife-age)/kFade); }
static double Delta(double a,double b) { return remainder(b-a,2*M_PI); }
static void Advect(WindParticle *p,WindVector w,double seconds) {
    p->lon+=w.u*seconds/fmax(111320*cos(p->lat*M_PI/180),1);
    p->lat+=w.v*seconds/111132;
    // Reflect across a pole rather than producing a singular longitude or a stuck tracer.
    if(p->lat>90){p->lat=180-p->lat;p->lon+=180;}
    if(p->lat< -90){p->lat=-180-p->lat;p->lon+=180;}
    p->lon=remainder(p->lon,360);
}
BOOL WindMapProjectOffset(IsobarCamera c,double lat,double lon,double east,double north,NSPoint *p) {
    double d=hypot(east,north)/6371000,b=atan2(east,north),phi=lat*M_PI/180;
    double target=asin(fmax(-1,fmin(1,sin(phi)*cos(d)+cos(phi)*sin(d)*cos(b))));
    double lambda=lon*M_PI/180+atan2(sin(b)*sin(d)*cos(phi),cos(d)-sin(phi)*sin(target)),x=0,y=0;
    if(!IsobarCameraProjectAboveGround(c,target*180/M_PI,lambda*180/M_PI,10,&x,&y)||!isfinite(x)||!isfinite(y))return NO;
    if(p)*p=NSMakePoint(x,y); return YES;
}
static BOOL Screen(IsobarCamera c,WindParticle p,NSPoint *point) {
    return WindMapProjectOffset(c,p.lat,p.lon,0,0,point);
}

@interface WindMapView () {
    WindParticle _particles[1800],_outgoing[1800];
    NSUInteger _count,_outgoingCount,_serial;
    double _pending,_appearance;
    IsobarCamera _lastCamera;
    BOOL _haveCamera,_densityChanged,_deferred;
    CGPoint *_segments[kBuckets];
    NSUInteger _segmentCount[kBuckets],_segmentCapacity;
    double _lastDisplayRequest;
    CAShapeLayer *_trailLayers[kBuckets];
    BOOL _snapshotDrawing;
}
@end
@implementation WindMapView
- (instancetype)initWithFrame:(NSRect)frame {
    if(!(self=[super initWithFrame:frame]))return nil;
    _flow=YES; return self;
}
- (void)dealloc { for(int i=0;i<kBuckets;i++)free(_segments[i]); }
- (void)drawSnapshotInCurrentContext { _snapshotDrawing=YES; [self drawRect:self.bounds]; _snapshotDrawing=NO; }
- (void)setFrameSize:(NSSize)size {
    [super setFrameSize:size];
    [CATransaction begin];[CATransaction setDisableActions:YES];
    for(int i=0;i<kBuckets;i++)_trailLayers[i].frame=self.bounds;
    [CATransaction commit];
}
- (void)clearTrailLayers {
    if(!_trailLayers[0])return;
    [CATransaction begin];[CATransaction setDisableActions:YES];
    for(int i=0;i<kBuckets;i++)_trailLayers[i].path=NULL;
    [CATransaction commit];
    _layerSegments=0;
}
// One shape layer per alpha bucket over the view's own (barb) content.
- (BOOL)updateTrailLayers {
    if(!self.wantsLayer)self.wantsLayer=YES;
    CALayer *host=self.layer; if(!host)return NO;
    double r=_chartDark?228/255.:26/255.,gr=_chartDark?220/255.:51/255.,b=_chartDark?203/255.:64/255.;
    [CATransaction begin];[CATransaction setDisableActions:YES];
    NSUInteger total=0;
    for(int i=0;i<kBuckets;i++) {
        CAShapeLayer *layer=_trailLayers[i];
        if(!layer) {
            layer=[CAShapeLayer layer];layer.fillColor=NULL;layer.lineCap=kCALineCapButt;
            layer.actions=@{@"path":NSNull.null,@"strokeColor":NSNull.null,@"lineWidth":NSNull.null,@"bounds":NSNull.null,@"position":NSNull.null};
            _trailLayers[i]=layer;
        }
        if(layer.superlayer!=host)[host addSublayer:layer];
        layer.frame=host.bounds;
        layer.lineWidth=_windLens?1.35:1.15;
        CGColorRef ink=CGColorCreateSRGB(r,gr,b,(i+.5)/kBuckets*kMaxAlpha);
        layer.strokeColor=ink;CGColorRelease(ink);
        CGMutablePathRef path=NULL;
        if(_segmentCount[i]) {
            path=CGPathCreateMutable();
            for(NSUInteger k=0;k<_segmentCount[i];k++) {
                CGPathMoveToPoint(path,NULL,_segments[i][2*k].x,_segments[i][2*k].y);
                CGPathAddLineToPoint(path,NULL,_segments[i][2*k+1].x,_segments[i][2*k+1].y);
            }
            total+=_segmentCount[i];
        }
        layer.path=path; if(path)CGPathRelease(path);
    }
    [CATransaction commit];
    _layerSegments=total;
    return YES;
}
- (BOOL)reserveSegments:(NSUInteger)pairs {
    if(pairs<=_segmentCapacity)return YES;
    for(int i=0;i<kBuckets;i++) {
        CGPoint *grown=realloc(_segments[i],pairs*2*sizeof(CGPoint));
        if(!grown)return NO;
        _segments[i]=grown;
    }
    _segmentCapacity=pairs;return YES;
}
- (void)requestDisplay {
    if(self.hidden)return;
    double now=Now(),wait=_lastDisplayRequest+kMinInterval-now;
    if(_lastDisplayRequest<=0||wait<=.002){_lastDisplayRequest=now;_displayPending=YES;[self setNeedsDisplay:YES];return;}
    if(_deferred)return;
    _deferred=YES;
    __weak WindMapView *weak=self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)(wait*NSEC_PER_SEC)),dispatch_get_main_queue(),^{
        WindMapView *view=weak; if(!view)return;
        view->_deferred=NO;[view requestDisplay];
    });
}
- (void)setFlow:(BOOL)flow {
    if(_flow==flow)return;
    _flow=flow;_pending=0;
    // A returning flow fades in rather than resuming stale trails.
    if(flow){_count=0;_outgoingCount=0;_appearance=0;}
    [self requestDisplay];
}
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)p { (void)p; return nil; }
- (void)setRun:(OwnRun *)run {
    if(_run==run)return;
    _run=run;_count=0;_outgoingCount=0;_serial=0;_appearance=0;
}
- (void)advanceBy:(double)seconds {
    if(!(seconds>0)||!isfinite(seconds)||!_flow)return;
    _pending=fmin(.05,_pending+seconds);_time+=seconds;
    [self requestDisplay];
}
- (BOOL)sampleAtLon:(double)lon lat:(double)lat vector:(WindVector *)out {
    OwnRunGeo g=_run.geo;
    if(g.nLon<2||g.nLat<2||!(g.step>0)||!isfinite(lon)||!isfinite(lat))return NO;
    double x=(lon-g.west)/g.step,y=(g.north-lat)/g.step;
    if(y<0||y>g.nLat-1)return NO;
    if(g.wrapsLongitude)x=fmod(fmod(x,g.nLon)+g.nLon,g.nLon);
    else if(x<0||x>g.nLon-1)return NO;
    int x0=(int)floor(x),y0=MIN(g.nLat-2,(int)floor(y));
    if(!g.wrapsLongitude)x0=MIN(g.nLon-2,x0);
    double tx=x-x0,ty=y-y0,u=0,v=0;
    for(int dy=0;dy<2;dy++)for(int dx=0;dx<2;dx++) {
        double weight=(dx?tx:1-tx)*(dy?ty:1-ty);
        if(weight<=0)continue; // An exact valid cell does not depend on its missing neighbour.
        NSInteger cell=(y0+dy)*g.nLon+(g.wrapsLongitude?(x0+dx)%g.nLon:x0+dx);
        NSInteger lower=(NSInteger)floor(_fractionalStep),upper=lower+1;double mix=_fractionalStep-lower;
        double s0=[_run valueAtPointIndex:cell field:OwnRunFieldWindSpeed hour:lower],d0=[_run valueAtPointIndex:cell field:OwnRunFieldWindDirection hour:lower];
        double s1=[_run valueAtPointIndex:cell field:OwnRunFieldWindSpeed hour:upper],d1=[_run valueAtPointIndex:cell field:OwnRunFieldWindDirection hour:upper];
        if(!isfinite(s0)||!isfinite(d0)||s0<0)return NO;
        if(mix>0&&(!isfinite(s1)||!isfinite(d1)||s1<0))return NO;
        double r0=d0*M_PI/180,r1=d1*M_PI/180,u0=-s0*kKnotsToMS*sin(r0),v0=-s0*kKnotsToMS*cos(r0),u1=u0,v1=v0;
        if(mix>0){u1=-s1*kKnotsToMS*sin(r1);v1=-s1*kKnotsToMS*cos(r1);}
        u+=weight*(u0*(1-mix)+u1*mix);v+=weight*(v0*(1-mix)+v1*mix);
    }
    *out=(WindVector){u,v};return YES;
}
- (WindParticle)spawn:(IsobarCamera)c occupancy:(NSUInteger *)occupancy columns:(NSUInteger)cols rows:(NSUInteger)rows age:(double)age {
    NSUInteger id=_serial++,cells=cols*rows,cell=id%cells;
    for(NSUInteger j=1;j<cells;j++){NSUInteger next=(id+j)%cells;if(occupancy[next]<occupancy[cell])cell=next;}
    occupancy[cell]++;
    double x=((cell%cols)+Hash01(id*2+1))/cols*c.viewportW;
    double y=((cell/cols)+Hash01(id*2+2))/rows*c.viewportH,lat=NAN,lon=NAN;
    IsobarCameraUnproject(c,x,y,&lat,&lon);
    return (WindParticle){lon,lat,age,0,0,0,NO};
}
- (NSInteger)cellOf:(WindParticle)p camera:(IsobarCamera)c columns:(NSUInteger)cols rows:(NSUInteger)rows {
    NSPoint s;
    if(!Screen(c,p,&s)||s.x<0||s.y<0||s.x>=c.viewportW||s.y>=c.viewportH)return -1;
    return (NSInteger)(s.y/c.viewportH*rows)*cols+(NSInteger)(s.x/c.viewportW*cols);
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    double began=Now();
    _drawnCount=0;_maxSegmentPixels=0;
    if(!_flow&&!_snapshotDrawing)[self clearTrailLayers];
    if(_flow)[self drawFlow];
    else if(_barbs&&_run&&isfinite(_fractionalStep)) {
        IsobarCamera c=_camera;c.viewportW=NSWidth(self.bounds);c.viewportH=NSHeight(self.bounds);
        if(c.viewportW>=2&&c.viewportH>=2&&c.zoom>0)[self drawBarbs:c];
    }
    _lastDrawMilliseconds=(Now()-began)*1000;_drawSerial++;_displayPending=NO;
}
- (void)drawFlow {
    if(!_run||!isfinite(_fractionalStep)){if(!_snapshotDrawing)[self clearTrailLayers];return;}
    IsobarCamera c=_camera;c.viewportW=NSWidth(self.bounds);c.viewportH=NSHeight(self.bounds);
    if(c.viewportW<2||c.viewportH<2||!(c.zoom>0)){if(!_snapshotDrawing)[self clearTrailLayers];return;}
    NSUInteger count=(NSUInteger)llround(fmin(1000,fmax(96,c.viewportW*c.viewportH/1100)));
    if(_windLens)count=MIN(kCapacity,count*2);
    if(_maxParticles>0)count=MIN(count,MAX(1,_maxParticles));
    BOOL cameraChanged=!_haveCamera||fabs(c.centreLat-_lastCamera.centreLat)>1e-9||fabs(c.centreLon-_lastCamera.centreLon)>1e-9||fabs(c.zoom-_lastCamera.zoom)>1e-9||fabs(c.globe-_lastCamera.globe)>1e-9||fabs(c.pitch-_lastCamera.pitch)>1e-9||fabs(c.bearing-_lastCamera.bearing)>1e-9||c.viewportW!=_lastCamera.viewportW||c.viewportH!=_lastCamera.viewportH;
    if(cameraChanged||count!=_count)_densityChanged=YES;
    _lastCamera=c;_haveCamera=YES;
    NSUInteger cols=MAX(1,(NSUInteger)llround(sqrt(count/4.0*c.viewportW/c.viewportH)));
    NSUInteger rows=MAX(1,(NSUInteger)llround(count/4.0/cols)),cells=cols*rows;
    NSUInteger occupancy[2048]={0};if(cells>2048)return;
    for(NSUInteger i=0;i<_count;i++){NSInteger cell=[self cellOf:_particles[i] camera:c columns:cols rows:rows];if(cell>=0)occupancy[cell]++;}
    NSUInteger previousCount=_count;
    BOOL initial=_count==0;
    if(!_reducedMotion&&previousCount>count){
        for(NSUInteger i=count;i<previousCount&&_outgoingCount<count;i++){
            _outgoing[_outgoingCount]=_particles[i];_outgoing[_outgoingCount++].retireAge=0;
        }
    }
    while(_count<count){double age=initial?Hash01(_serial+71)*kLife:0;_particles[_count++]=[self spawn:c occupancy:occupancy columns:cols rows:rows age:age];}
    _count=count;
    double dt=_pending;_pending=0;
    if(_reducedMotion)_outgoingCount=0;
    for(NSUInteger i=0;i<_outgoingCount;i++)_outgoing[i].retireAge+=dt;
    NSUInteger kept=0;
    for(NSUInteger i=0;i<_outgoingCount;i++)if(_outgoing[i].retireAge<kFade&&_outgoing[i].age<kLife)_outgoing[kept++]=_outgoing[i];
    _outgoingCount=MIN(kept,count);
    _appearance=fmin(kFade,_appearance+dt);
    NSUInteger redistribute=MAX(1,(NSUInteger)ceil(count*dt)),cap=(NSUInteger)ceil(count/(double)cells*1.5);
    BOOL crowded=NO;
    for(NSUInteger i=0;i<count;i++) {
        WindParticle *p=&_particles[i];NSInteger cell=[self cellOf:*p camera:c columns:cols rows:rows];
        BOOL excess=_densityChanged&&cell>=0&&occupancy[cell]>cap;
        if(excess)crowded=YES;
        if(cell<0||(!_reducedMotion&&p->age+dt>=kLife)||(excess&&redistribute>0)) {
            if(cell>=0)occupancy[cell]--;
            if(excess){
                redistribute--;
                if(!_reducedMotion&&p->age+dt<kLife&&_outgoingCount<count){
                    _outgoing[_outgoingCount]=*p;_outgoing[_outgoingCount++].retireAge=0;
                }
            }
            *p=[self spawn:c occupancy:occupancy columns:cols rows:rows age:0];
        }
    }
    if(!crowded)_densityChanged=NO;
    for(int i=0;i<kBuckets;i++)_segmentCount[i]=0;
    double span=c.viewportH/(c.zoom*fmin(c.viewportW/360,c.viewportH/180));
    double overview=fmax(.5,fmin(1,sqrt(24/fmax(24,span))));
    NSUInteger renderCount=count+_outgoingCount;
    if(![self reserveSegments:renderCount*3])return;
    for(NSUInteger i=0;i<renderCount;i++) {
        BOOL outgoing=i>=count; WindParticle *p=outgoing?&_outgoing[i-count]:&_particles[i];WindVector w;
        if(![self sampleAtLon:p->lon lat:p->lat vector:&w]){p->age=kLife;continue;}
        NSPoint origin,probePoint;WindParticle probe=*p;Advect(&probe,w,1);
        double rate=0;
        if(Screen(c,*p,&origin)&&Screen(c,probe,&probePoint))rate=hypot(probePoint.x-origin.x,probePoint.y-origin.y)*kVisual;
        if(!_reducedMotion&&dt>0) {
            double heading=atan2(w.v,w.u);
            if(hypot(w.u,w.v)>=kMinSpeed) {
                if(p->hasHeading)p->turn+=fabs(Delta(p->heading,heading));
                p->heading=heading;p->hasHeading=YES;
                if(p->turn>M_PI/2){p->age=kLife;continue;}
            }
            Advect(p,w,dt*kVisual*(rate>60?60/rate:1));p->age+=dt;
        }
        if(![self sampleAtLon:p->lon lat:p->lat vector:&w])continue;
        double speed=hypot(w.u,w.v);if(speed<kMinSpeed)continue;
        NSPoint here;if(!Screen(c,*p,&here))continue;
        double fade=_reducedMotion?1:Fade(p->age)*Smooth(_appearance/kFade)*(outgoing?Smooth((kFade-p->retireAge)/kFade):1);
        double edge=Smooth(fmin(fmin(here.x,c.viewportW-here.x),fmin(here.y,c.viewportH-here.y))/24);
        double alpha=fmin(_windLens?.85:.75,speed*(_windLens?.06:.048))*fade*edge;
        double length=fmin(_windLens?40:34,speed*(_windLens?2.8:2.4))*overview;
        if(_reducedMotion)length=fmin(length,9*overview);
        WindParticle tail=*p;double tailHeading=atan2(w.v,w.u),turn=0;BOOL emitted=NO;
        for(int part=0;part<3;part++) {
            probe=tail;Advect(&probe,w,60);NSPoint tip;
            if(!Screen(c,probe,&tip))break;
            double projected=hypot(tip.x-here.x,tip.y-here.y);
            if(!(projected>0)||projected>c.viewportW*.4)break;
            double seconds=60*length/3/projected;
            // A common physical length retains perspective foreshortening in 3D.
            if(c.pitch>0)seconds=fmin(seconds,fmax(.25,length/3*111195.08/(c.zoom*fmin(c.viewportW/360,c.viewportH/180))/fmax(kMinSpeed,hypot(w.u,w.v))));
            Advect(&tail,w,-seconds);NSPoint end;
            if(!Screen(c,tail,&end)||fabs(end.x-here.x)>c.viewportW*.4)break;
            WindVector next;if(![self sampleAtLon:tail.lon lat:tail.lat vector:&next]||hypot(next.u,next.v)<kMinSpeed)break;
            double heading=atan2(next.v,next.u),delta=Delta(tailHeading,heading);turn+=fabs(delta);
            if(fabs(delta)>M_PI/8||turn>M_PI/4)break;
            tailHeading=heading;probe=tail;Advect(&probe,next,60);NSPoint endTip;
            if(!Screen(c,probe,&endTip))break;
            double endSpeed=hypot(endTip.x-end.x,endTip.y-end.y);if(!(endSpeed>0)||endSpeed>c.viewportW*.4)break;
            double segment=hypot(end.x-here.x,end.y-here.y),pieceAlpha=alpha*(1-part*.3);
            // Each piece spans at most a sixteenth-turn, so a chord stays
            // within a fraction of a pixel of the old tangent curve.
            if(pieceAlpha>=.02) {
                NSInteger bucket=MIN(kBuckets-1,(NSInteger)floor(pieceAlpha/kMaxAlpha*kBuckets));
                CGPoint *pair=_segments[bucket]+2*_segmentCount[bucket]++;
                pair[0]=NSPointToCGPoint(here);pair[1]=NSPointToCGPoint(end);
                _maxSegmentPixels=fmax(_maxSegmentPixels,segment);emitted=YES;
            }
            here=end;w=next;
        }
        if(emitted)_drawnCount++;
    }
    CGContextRef g=_snapshotDrawing||![self updateTrailLayers]?NSGraphicsContext.currentContext.CGContext:NULL;
    if(g) {
        double r=_chartDark?228/255.:26/255.,gr=_chartDark?220/255.:51/255.,b=_chartDark?203/255.:64/255.;
        CGContextSaveGState(g);
        CGContextSetLineWidth(g,_windLens?1.35:1.15);CGContextSetLineCap(g,kCGLineCapButt);
        for(int i=0;i<kBuckets;i++)if(_segmentCount[i]) {
            CGColorRef ink=CGColorCreateSRGB(r,gr,b,(i+.5)/kBuckets*kMaxAlpha);
            CGContextSetStrokeColorWithColor(g,ink);CGColorRelease(ink);
            CGContextStrokeLineSegments(g,_segments[i],_segmentCount[i]*2);
        }
        CGContextRestoreGState(g);
    }
    if(_barbs)[self drawBarbs:c];
}

- (void)drawBarbs:(IsobarCamera)camera {
    OwnRunGeo grid=_run.geo;
    // One world length at the focus; foreshortening survives instead of re-normalising each glyph.
    double metresPerPoint=111195.08/(camera.zoom*fmin(camera.viewportW/360.0,camera.viewportH/180.0));
    double staff=23*metresPerPoint;
    NSColor *ink=[(_chartDark?[NSColor colorWithWhite:.9 alpha:1]:[NSColor colorWithSRGBRed:.12 green:.18 blue:.22 alpha:1]) colorWithAlphaComponent:.68];
    [ink setStroke]; [ink setFill];
    if(grid.nLon<2||grid.nLat<2||!(grid.step>0))return;
    // Barbs sit on model grid points, so they travel with the map when it pans.
    // Every k-th point in both axes, k a power of two from the zoom: zooming in
    // adds barbs between the ones already shown instead of moving them.
    double spacingDeg=58*metresPerPoint/111195.08;
    NSInteger k=1; while(k*grid.step<spacingDeg*.75&&k<4096)k*=2;
    // The visible box, from points around the viewport edge (tilt and globe safe).
    double south=90,north=-90,west=0,east=0; BOOL any=NO; double ref=camera.centreLon;
    for(int e=0;e<=40;e++) {
        double t=e/40.0, pts[4][2]={{t*camera.viewportW,0},{t*camera.viewportW,camera.viewportH},{0,t*camera.viewportH},{camera.viewportW,t*camera.viewportH}};
        for(int q=0;q<4;q++) {
            double la=0,lo=0; if(!IsobarCameraUnproject(camera,pts[q][0],pts[q][1],&la,&lo))continue;
            double d=remainder(lo-ref,360);
            if(!any){south=north=la;west=east=d;any=YES;} else {south=fmin(south,la);north=fmax(north,la);west=fmin(west,d);east=fmax(east,d);}
        }
    }
    double cla=0,clo=0;
    if(IsobarCameraUnproject(camera,camera.viewportW/2,camera.viewportH/2,&cla,&clo)&&!any){south=north=cla;west=east=remainder(clo-ref,360);any=YES;}
    if(!any||east-west>359)west=-180,east=180;
    south=fmax(-90,south-spacingDeg);north=fmin(90,north+spacingDeg);west-=spacingDeg;east+=spacingDeg;
    NSInteger j0=MAX(0,(NSInteger)floor((grid.north-north)/grid.step)),j1=MIN(grid.nLat-1,(NSInteger)ceil((grid.north-south)/grid.step));
    j0=j0/k*k;
    // Near the horizon a tilted view squeezes many points together; keep one per 40 pt cell.
    NSMutableSet<NSNumber *> *taken=[NSMutableSet set];
    NSMutableSet<NSString *> *cells=[NSMutableSet set];
    NSUInteger considered=0;
    for(NSInteger j=j0;j<=j1;j+=k) {
        double lat=grid.north-j*grid.step;
        double c0=(ref+west-grid.west)/grid.step,c1=(ref+east-grid.west)/grid.step;
        NSInteger i0=(NSInteger)floor(c0/k)*k,i1=(NSInteger)ceil(c1);
        for(NSInteger raw=i0;raw<=i1;raw+=k) {
            if(++considered>6000)break;
            NSInteger i=raw;
            if(grid.wrapsLongitude) i=((i%grid.nLon)+grid.nLon)%grid.nLon;
            if(i<0||i>=grid.nLon) continue;
            double lon=grid.west+raw*grid.step;
            NSPoint at; if(!WindMapProjectOffset(camera,lat,lon,0,0,&at)) continue;
            if(at.x<-20||at.y<-20||at.x>camera.viewportW+20||at.y>camera.viewportH+20) continue;
            NSNumber *slot=@((NSInteger)floor(at.y/40)*100000+(NSInteger)floor(at.x/40));
            if([taken containsObject:slot]) continue;
            [taken addObject:slot];
        NSInteger cell=j*grid.nLon+i;
        double speed=[_run valueAtPointIndex:cell field:OwnRunFieldWindSpeed fractionalHour:_fractionalStep];
        double from=[_run valueAtPointIndex:cell field:OwnRunFieldWindDirection fractionalHour:_fractionalStep];
        if(!isfinite(speed)||!isfinite(from)||speed<0) continue;
        OwnBarb barb=OwnWindBarb(from,speed,staff,lat<0);
        NSBezierPath *path=[NSBezierPath bezierPath]; path.lineWidth=1;
        if(barb.calm) {
            BOOL valid=YES;
            for(int k=0;k<=12;k++) { NSPoint p; double a=k*M_PI/6;
                if(!WindMapProjectOffset(camera,lat,lon,2*metresPerPoint*cos(a),2*metresPerPoint*sin(a),&p)){valid=NO;break;}
                if(k==0)[path moveToPoint:p];else[path lineToPoint:p];
            }
            if(valid){[path stroke];_drawnCount++;} continue;
        }
        BOOL drawn=NO;
        for(int k=0;k<barb.nSeg;k++) {
            NSPoint a,b;
            if(!WindMapProjectOffset(camera,lat,lon,barb.segs[k].a.x,barb.segs[k].a.y,&a)||
               !WindMapProjectOffset(camera,lat,lon,barb.segs[k].b.x,barb.segs[k].b.y,&b))continue;
            if(hypot(b.x-a.x,b.y-a.y)>camera.viewportW*.5) continue;
            [path moveToPoint:a];[path lineToPoint:b];drawn=YES;
        }
        [path stroke];
        for(int k=0;k<barb.nTri;k++) {
            NSPoint p[3];BOOL valid=YES;
            for(int v=0;v<3;v++) if(!WindMapProjectOffset(camera,lat,lon,barb.tri[k][v].x,barb.tri[k][v].y,&p[v]))valid=NO;
            if(!valid)continue;
            NSBezierPath *flag=[NSBezierPath bezierPath];[flag moveToPoint:p[0]];[flag lineToPoint:p[1]];[flag lineToPoint:p[2]];[flag closePath];[flag fill];drawn=YES;
        }
        if(drawn){_drawnCount++;[cells addObject:[NSString stringWithFormat:@"%ld,%ld",(long)j,(long)i]];}
        }
    }
    _barbCells=cells;
}
@end
