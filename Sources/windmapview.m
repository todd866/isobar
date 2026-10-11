#import "windmapview.h"
#import "ownchart.h"
#import <math.h>

static const double kKnotsToMS=.514444, kLife=12, kFade=1.5, kVisual=3600, kMinSpeed=2.5;
static const NSUInteger kCapacity=1800;
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
    if(!IsobarCameraProjectAltitude(c,target*180/M_PI,lambda*180/M_PI,10,&x,&y)||!isfinite(x)||!isfinite(y))return NO;
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
    BOOL _haveCamera,_densityChanged;
}
@end
@implementation WindMapView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)p { (void)p; return nil; }
- (void)setRun:(OwnRun *)run {
    if(_run==run)return;
    _run=run;_count=0;_outgoingCount=0;_serial=0;_appearance=0;
}
- (void)advanceBy:(double)seconds {
    if(!(seconds>0)||!isfinite(seconds))return;
    _pending=fmin(.05,_pending+seconds);_time+=seconds;
    [self setNeedsDisplay:YES];
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
    (void)dirty;_drawnCount=0;_maxSegmentPixels=0;
    if(!_run||!isfinite(_fractionalStep))return;
    IsobarCamera c=_camera;c.viewportW=NSWidth(self.bounds);c.viewportH=NSHeight(self.bounds);
    if(c.viewportW<2||c.viewportH<2||!(c.zoom>0))return;
    NSUInteger count=(NSUInteger)llround(fmin(1000,fmax(96,c.viewportW*c.viewportH/1100)));
    if(_windLens)count=MIN(kCapacity,count*2);
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
    NSBezierPath *buckets[64];for(int i=0;i<64;i++)buckets[i]=[NSBezierPath bezierPath];
    double span=c.viewportH/(c.zoom*fmin(c.viewportW/360,c.viewportH/180));
    double overview=fmax(.5,fmin(1,sqrt(24/fmax(24,span))));
    NSUInteger renderCount=count+_outgoingCount;
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
            double segment=hypot(end.x-here.x,end.y-here.y),arm=segment/3;
            NSInteger bucket=(NSInteger)llround(alpha*(1-part*.3)/.8*64)-1;
            if(bucket>=0) {
                NSBezierPath *path=buckets[MIN(63,bucket)];[path moveToPoint:here];
                [path curveToPoint:end controlPoint1:NSMakePoint(here.x-(tip.x-here.x)/projected*arm,here.y-(tip.y-here.y)/projected*arm)
                    controlPoint2:NSMakePoint(end.x+(endTip.x-end.x)/endSpeed*arm,end.y+(endTip.y-end.y)/endSpeed*arm)];
                _maxSegmentPixels=fmax(_maxSegmentPixels,segment);emitted=YES;
            }
            here=end;w=next;
        }
        if(emitted)_drawnCount++;
    }
    NSColor *ink=_chartDark?[NSColor colorWithSRGBRed:228/255. green:220/255. blue:203/255. alpha:1]:[NSColor colorWithSRGBRed:26/255. green:51/255. blue:64/255. alpha:1];
    for(int i=0;i<64;i++)if(!buckets[i].empty) {
        buckets[i].lineWidth=_windLens?1.35:1.15;buckets[i].lineCapStyle=NSLineCapStyleRound;
        [[ink colorWithAlphaComponent:(i+1)/64.0*.8]setStroke];[buckets[i]stroke];
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
    for(double y=40;y<camera.viewportH-20;y+=58) for(double x=28;x<camera.viewportW-20;x+=58) {
        double lat=0,lon=0;
        if(!IsobarCameraUnproject(camera,x,y,&lat,&lon)) continue;
        double col=(lon-grid.west)/grid.step;
        if(grid.wrapsLongitude) col=fmod(fmod(col,grid.nLon)+grid.nLon,grid.nLon);
        NSInteger i=llround(col),j=llround((grid.north-lat)/grid.step);
        if(grid.wrapsLongitude) i%=grid.nLon;
        if(i<0||i>=grid.nLon||j<0||j>=grid.nLat) continue;
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
        if(drawn)_drawnCount++;
    }
}
@end
