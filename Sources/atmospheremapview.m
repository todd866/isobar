// Isobar — layered synthetic teaching atmosphere overlay.
#import "atmospheremapview.h"
#import "atmosphere.h"
#import <math.h>
#import <QuartzCore/QuartzCore.h>

static BOOL AMNumber(id v) { return [v isKindOfClass:NSNumber.class] && isfinite([v doubleValue]); }
static CGFloat AMY(NSRect r,double h,double top) { return NSMaxY(r)-(CGFloat)(MIN(top,MAX(0,h))/top)*NSHeight(r); }
static void AMText(NSString *s,NSRect r,CGFloat size,NSColor *c,BOOL bold) {
    [s drawInRect:r withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size weight:bold?NSFontWeightSemibold:NSFontWeightRegular],NSForegroundColorAttributeName:c}];
}
static void AMLine(NSPoint a,NSPoint b,NSColor *c,CGFloat width) {
    NSBezierPath *p=[NSBezierPath bezierPath]; p.lineWidth=width; [p moveToPoint:a]; [p lineToPoint:b]; [c setStroke]; [p stroke];
}
static void AMGeographicCentre(double *lat, double *lon) {
    *lat=fmod(fmod(*lat+180,360)+360,360)-180;
    if (*lat>90) { *lat=180-*lat; *lon+=180; }
    else if (*lat< -90) { *lat=-180-*lat; *lon+=180; }
    *lon=fmod(fmod(*lon+180,360)+360,360)-180;
}
typedef struct { double eastMS; double northMS; double verticalMS; } AMSyntheticWind;

// A closed, divergence-free illustrative overturning cell.  The horizontal
// partners are derived from the same streamfunction as w, so the lower and
// upper branches return in opposite directions and w is zero at both bounds.
static AMSyntheticWind AMWindAt(ATTeachingContext context, double latitude, double longitude, double heightM) {
    ATTeachingSample s=at_teaching_sample(context,latitude,longitude,heightM);
    return (AMSyntheticWind){s.u,s.v,s.w};
}

typedef struct { double lat, lon, heightM, time; } AMTrajectoryPoint;
static const double AMTrajectoryMinTime=-1200.0, AMTrajectoryMaxTime=1200.0, AMTrajectoryStep=30.0;
static NSCache *AMTrajectoryCache(void) {
    static NSCache *cache; static dispatch_once_t once;
    dispatch_once(&once, ^{ cache=[NSCache new]; cache.countLimit=1500; });
    return cache;
}
static AMTrajectoryPoint AMAdvanceTrajectory(AMTrajectoryPoint point, double dt, ATTeachingContext context) {
    AMSyntheticWind wind=AMWindAt(context,point.lat,point.lon,point.heightM);
    AMTrajectoryPoint middle={point.lat+wind.northMS/111132.0*dt*.5,
        point.lon+wind.eastMS/(111320.0*MAX(.1,cos(point.lat*M_PI/180.0)))*dt*.5,
        point.heightM+wind.verticalMS*dt*.5,point.time+dt*.5};
    wind=AMWindAt(context,middle.lat,middle.lon,middle.heightM);
    return (AMTrajectoryPoint){point.lat+wind.northMS/111132.0*dt,
        point.lon+wind.eastMS/(111320.0*MAX(.1,cos(middle.lat*M_PI/180.0)))*dt,
        point.heightM+wind.verticalMS*dt,middle.time+dt*.5};
}
static NSString *AMTrajectoryKey(double lat,double lon,double heightM,ATTeachingContext context) {
    long long bin=(long long)floor(context.timeMs/300000.0);
    return [NSString stringWithFormat:@"%lld:%d:%.5f:%.5f:%.8f:%.8f:%.0f:%.0f",bin,(int)context.kind,context.lat,context.lon,lat,lon,heightM,context.groundM];
}
static NSArray<NSValue *> *AMFullTrajectory(double lat,double lon,double heightM,ATTeachingContext context) {
    NSCache *cache=AMTrajectoryCache(); NSString *key=AMTrajectoryKey(lat,lon,heightM,context);
    NSArray<NSValue *> *cached=[cache objectForKey:key]; if (cached) return cached;
    AMTrajectoryPoint point={lat,lon,heightM,0}; NSMutableArray<NSValue *> *back=[NSMutableArray array]; [back addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]];
    for (double time=0;time>AMTrajectoryMinTime;time-=AMTrajectoryStep) { point=AMAdvanceTrajectory(point,-AMTrajectoryStep,context); [back addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]]; }
    NSMutableArray<NSValue *> *result=[NSMutableArray arrayWithCapacity:32]; for (NSValue *value in back.reverseObjectEnumerator) [result addObject:value];
    point=(AMTrajectoryPoint){lat,lon,heightM,0}; [result removeLastObject];
    for (double time=0;time<=AMTrajectoryMaxTime;time+=AMTrajectoryStep) { if (time>0) point=AMAdvanceTrajectory(point,AMTrajectoryStep,context); [result addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]]; }
    [cache setObject:result forKey:key]; return result;
}
static AMTrajectoryPoint AMTrajectoryAt(NSArray<NSValue *> *path,double time) {
    double clamped=MAX(AMTrajectoryMinTime,MIN(AMTrajectoryMaxTime,time));
    NSUInteger index=(NSUInteger)MAX(0,MIN((NSInteger)path.count-2,(NSInteger)floor((clamped-AMTrajectoryMinTime)/AMTrajectoryStep)));
    AMTrajectoryPoint a,b; [path[index] getValue:&a]; [path[index+1] getValue:&b]; double fraction=(clamped-a.time)/(b.time-a.time);
    return (AMTrajectoryPoint){a.lat+(b.lat-a.lat)*fraction,a.lon+(b.lon-a.lon)*fraction,a.heightM+(b.heightM-a.heightM)*fraction,clamped};
}

@interface AtmosphereMapView ()
@property(nonatomic) BOOL disclosureOpen;
@property(nonatomic,strong) NSSlider *altitudeSlider;
@property(nonatomic,strong) NSButton *disclosureButton;
@property(nonatomic,strong) NSPopUpButton *teachingSelector;
@property(nonatomic,strong) NSButton *frameButton;
@property(nonatomic) double anchorLat;
@property(nonatomic) double anchorLon;
@property(nonatomic) double anchorGroundM;
@property(nonatomic) BOOL anchorReady;
@end

@implementation AtmosphereMapView
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        _aircraftAltitudeM=1524;
        _teachingKind=ATTeachingCirculation;
        _disclosureButton=[NSButton buttonWithTitle:@"Atmosphere ≈" target:self action:@selector(toggleDisclosure:)];
        _disclosureButton.bezelStyle=NSBezelStyleRounded;
        _disclosureButton.accessibilityLabel=@"Atmospheric section";
        _disclosureButton.toolTip=@"Synthetic atmospheric data; vertical separation adapts to map scale";
        _disclosureButton.frame=[self disclosureRect];
        [self addSubview:_disclosureButton];
        _teachingSelector=[[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
        [_teachingSelector addItemsWithTitles:@[@"Convection",@"Sea breeze",@"Thunderstorm",@"Mountain wave"]];
        _teachingSelector.target=self; _teachingSelector.action=@selector(teachingChanged:); [_teachingSelector selectItemAtIndex:0]; _teachingSelector.hidden=YES;
        _teachingSelector.toolTip=@"Choose a synthetic teaching scenario";
        [self addSubview:_teachingSelector];
        _frameButton=[NSButton buttonWithTitle:@"↕" target:self action:@selector(frameAtmosphere:)]; _frameButton.bezelStyle=NSBezelStyleRounded; _frameButton.toolTip=@"Fit the active atmosphere column in the map"; _frameButton.accessibilityLabel=@"Frame atmosphere"; _frameButton.hidden=YES; [self addSubview:_frameButton];
    }
    return self;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (NSRect)disclosureRect { return NSMakeRect(8,40,126,24); }
- (NSRect)panelRect { CGFloat h=MIN(270,MAX(0,NSHeight(self.bounds)-76)); return NSMakeRect(8,68,MIN(260,MAX(0,NSWidth(self.bounds)-56)),h); }
- (double)displayHeight:(double)height {
    if (self.teachingKind!=ATTeachingSeaBreeze) return height;
    double ground=self.anchorReady?self.anchorGroundM:[self groundHeight];
    return ground+(height-ground)*3.0;
}
- (void)establishTeachingAnchorAtCameraCentre {
    double lat=self.camera.centreLat, lon=self.camera.centreLon;
    if (!isfinite(lat) || !isfinite(lon)) return;
    AMGeographicCentre(&lat,&lon); self.anchorLat=lat; self.anchorLon=lon; self.anchorGroundM=AMNumber(self.product[@"elevation"])?[self.product[@"elevation"] doubleValue]:0; self.anchorReady=YES;
}
- (void)setCamera:(IsobarCamera)camera {
    BOOL entering3D=fabs(_camera.pitch)<1e-6 && fabs(camera.pitch)>1e-6;
    _camera=camera;
    if (entering3D) [self establishTeachingAnchorAtCameraCentre];
}
- (void)setLatitude:(double)latitude { _latitude=latitude; }
- (void)setLongitude:(double)longitude { _longitude=longitude; }
- (void)setTeachingKind:(ATTeachingKind)teachingKind {
    _teachingKind=teachingKind;
    [self establishTeachingAnchorAtCameraCentre];
}
- (ATTeachingContext)teachingContext {
    double lat=self.anchorReady?self.anchorLat:self.latitude,lon=self.anchorReady?self.anchorLon:self.longitude;
    if (!isfinite(lat)||!isfinite(lon)) { lat=self.camera.centreLat; lon=self.camera.centreLon; }
    AMGeographicCentre(&lat,&lon); self.anchorLat=lat; self.anchorLon=lon; if (!self.anchorReady) self.anchorGroundM=[self groundHeight]; self.anchorReady=YES;
    double timeMs=floor(self.date.timeIntervalSince1970*1000.0/300000.0)*300000.0;
    return (ATTeachingContext){self.teachingKind,lat,lon,self.anchorGroundM,timeMs};
}
- (NSArray<NSNumber *> *)teachingHeights { return self.teachingKind==ATTeachingSeaBreeze?@[@150,@450,@800,@1200,@1600,@2050,@2350]:@[@300,@900,@1800,@3000,@4500,@6500,@8500,@9500]; }
- (double)teachingTopM { return self.teachingKind==ATTeachingSeaBreeze?2500.0:(self.teachingKind==ATTeachingMountainWave?12000.0:10000.0); }
- (void)drawHeightGuide {
    ATTeachingContext context=[self teachingContext]; double top=[self teachingTopM];
    double x0,y0,x1,y1;
    if (![self projectLat:context.lat lon:context.lon height:context.groundM x:&x0 y:&y0] || ![self projectLat:context.lat lon:context.lon height:context.groundM+top x:&x1 y:&y1] || hypot(x1-x0,y1-y0)<55) return;
    NSColor *ink=[NSColor.secondaryLabelColor colorWithAlphaComponent:.7];
    AMLine(NSMakePoint(x0,y0),NSMakePoint(x1,y1),ink,.8);
    for (int i=0;i<=4;i++) {
        double h=context.groundM+top*i/4,x,y;
        if (![self projectLat:context.lat lon:context.lon height:h x:&x y:&y] || x<10 || x>NSWidth(self.bounds)-55 || y<40 || y>NSHeight(self.bounds)-20) continue;
        if (self.disclosureOpen && NSPointInRect(NSMakePoint(x,y),[self panelRect])) continue;
        AMLine(NSMakePoint(x-3,y),NSMakePoint(x+4,y),ink,.8);
        AMText(i?[NSString stringWithFormat:@"%.1fk ft",h/.3048/1000]:@"SFC",NSMakeRect(x+6,y-6,54,12),8,ink,NO);
    }
}
- (NSDictionary *)sample {
    if (!self.date) return nil;
    NSMutableArray *levels=[NSMutableArray array]; ATTeachingContext context=[self teachingContext];
    double lat=self.camera.centreLat,lon=self.camera.centreLon; AMGeographicCentre(&lat,&lon);
    for (NSNumber *height in [self teachingHeights]) {
        double h=context.groundM+height.doubleValue; ATTeachingSample sample=at_teaching_sample(context,lat,lon,h);
        [levels addObject:@{ @"pressureHpa":@(sample.pressureHPa), @"heightM":@(h), @"cloudPct":@(sample.cloudPct), @"windEastKt":@(sample.u/.514444), @"windNorthKt":@(sample.v/.514444), @"verticalVelocityMS":@(sample.w), @"temperatureC":@(sample.temperatureC), @"rhPct":@(sample.rhPct) }];
    }
    return @{ @"model":@"Teaching synthetic", @"run":self.date, @"levels":levels, @"featureAvailability":@{ @"verticalVelocity":@YES } };
}
- (BOOL)pointIsInteractive:(NSPoint)p {
    if (fabs(self.camera.pitch)<1e-6 || !self.date || ![self sample]) return NO;
    if (self.disclosureOpen && self.altitudeSlider && NSPointInRect(p,self.altitudeSlider.frame)) return YES;
    if (self.disclosureOpen && self.teachingSelector && NSPointInRect(p,self.teachingSelector.frame)) return YES;
    if (self.disclosureOpen && self.frameButton && NSPointInRect(p,self.frameButton.frame)) return YES;
    return NSPointInRect(p,[self disclosureRect]);
}
- (NSView *)hitTest:(NSPoint)p {
    if (! [self pointIsInteractive:p]) return nil;
    if (self.altitudeSlider && NSPointInRect(p,self.altitudeSlider.frame)) return self.altitudeSlider;
    if (self.teachingSelector && !self.teachingSelector.hidden && NSPointInRect(p,self.teachingSelector.frame)) return self.teachingSelector;
    if (self.frameButton && !self.frameButton.hidden && NSPointInRect(p,self.frameButton.frame)) return self.frameButton;
    return self.disclosureButton;
}

- (BOOL)projectLat:(double)lat lon:(double)lon height:(double)height x:(double *)x y:(double *)y {
    return IsobarCameraProjectAltitude(self.camera,lat,lon,[self displayHeight:height],x,y);
}
- (double)groundHeight {
    if (self.anchorReady) return self.anchorGroundM;
    return AMNumber(self.product[@"elevation"])?[self.product[@"elevation"] doubleValue]:0;
}
- (NSDictionary *)syntheticWindAtHeight:(double)height latitude:(double)latitude longitude:(double)longitude {
    if (!self.date) return nil;
    AMSyntheticWind wind=AMWindAt([self teachingContext],latitude,longitude,height);
    return @{ @"eastMS":@(wind.eastMS), @"northMS":@(wind.northMS), @"verticalMS":@(wind.verticalMS) };
}
- (BOOL)knownGround { return AMNumber(self.product[@"elevation"]); }

- (void)drawSeaBreezeContours {
    ATTeachingContext c=[self teachingContext]; const double contours[]={.18,.42,.7};
    double animation=NSProcessInfo.processInfo.systemUptime*16;
    for(int row=-1;row<=1;row++)for(int k=0;k<3;k++) {
        double extent=6000*sqrt(-log(contours[k])),times[129]={0}; NSPoint points[129]; BOOL visible[129]; double winds[129];
        double prevX=0,prevZ=0,prevSpeed=1;
        for(int i=0;i<=128;i++) {
            double angle=2*M_PI*i/128,x=-extent*cos(angle),lower=2500/M_PI*asin(sqrt(MIN(1,contours[k]*exp(x*x/36000000))));
            double z=i%64==0?1250:(i<=64?lower:2500-lower),lat=c.lat+row*3000/111320.0,lon=c.lon+x/(111320*MAX(.2,cos(c.lat*M_PI/180)));
            ATTeachingSample f=at_teaching_sample(c,lat,lon,c.groundM+z); double speed=hypot(f.u,f.w);
            if(i)times[i]=times[i-1]+hypot(x-prevX,z-prevZ)/MAX(.1,(speed+prevSpeed)/2);
            prevX=x;prevZ=z;prevSpeed=speed;winds[i]=f.w;
            double sx=0,sy=0;visible[i]=[self projectLat:lat lon:lon height:c.groundM+z x:&sx y:&sy];points[i]=NSMakePoint(sx,sy);
            if(i&&visible[i]&&visible[i-1])AMLine(points[i-1],points[i],[(f.w>.15?NSColor.systemOrangeColor:f.w<-.15?NSColor.systemTealColor:NSColor.secondaryLabelColor) colorWithAlphaComponent:.3],.8);
        }
        if(times[128]<=0)continue;
        for(int particle=0;particle<3;particle++) {
            double t=fmod(animation+(particle/3.0+(row+1)*.13+k*.23)*times[128],times[128]);
            for(int i=1;i<=128;i++)if(times[i]>=t) {
                if(!visible[i]||!visible[i-1])break;
                double f=(t-times[i-1])/MAX(.001,times[i]-times[i-1]);NSPoint a=points[i-1],b=points[i],tip=NSMakePoint(a.x+(b.x-a.x)*f,a.y+(b.y-a.y)*f);double angle=atan2(b.y-a.y,b.x-a.x);
                NSColor *ink=winds[i]>.15?NSColor.systemOrangeColor:winds[i]<-.15?NSColor.systemTealColor:NSColor.secondaryLabelColor;
                AMLine(NSMakePoint(tip.x-12*cos(angle),tip.y-12*sin(angle)),tip,ink,1.5);
                AMLine(NSMakePoint(tip.x-3*cos(angle-.55),tip.y-3*sin(angle-.55)),tip,ink,1.1);
                AMLine(tip,NSMakePoint(tip.x-3*cos(angle+.55),tip.y-3*sin(angle+.55)),ink,1.1);break;
            }
        }
    }
}
- (void)drawSyntheticFlows {
    if(self.teachingKind==ATTeachingSeaBreeze){[self drawSeaBreezeContours];return;}
    if (!(self.camera.viewportW>1 && self.camera.viewportH>1)) return;
    double animation=CACurrentMediaTime()*16.0/2310.0;
    double fit=MIN(self.camera.viewportW/360.0,self.camera.viewportH/180.0), halfHeight=self.camera.viewportH*.5/(self.camera.zoom*MAX(1e-6,fit));
    if (!(halfHeight>0 && halfHeight<6) || !isfinite(halfHeight)) return;
    ATTeachingContext context=[self teachingContext]; double centreLat=context.lat, centreLon=context.lon;
    double gridStep=self.teachingKind==ATTeachingSeaBreeze?1500.0:2000.0;
    double separation=1;
    NSArray<NSNumber *> *heights=[self teachingHeights];
    for (NSUInteger level=0; level<heights.count; level++) {
        double h=context.groundM+heights[level].doubleValue;
        NSUInteger count=0;
        for (int gy=-1;gy<=1 && count<1800;gy++) for (int gx=-5;gx<=5 && count<1800;gx++) {
            double lat=centreLat+gy*gridStep/111132.0;
            double lon=centreLon+gx*gridStep/(111320.0*MAX(.2,cos(centreLat*M_PI/180.0)));
            if (lat < -90 || lat > 90) continue;
            double seed=fmod(fmod(sin(lat*57+lon*31+(level+1)*137)*43758.5,1.0)+1.0,1.0);
            double travel=fmod(animation+seed,1.0), advance=AMTrajectoryMinTime+90+travel*2310;
            NSArray<NSValue *> *full=AMFullTrajectory(lat,lon,h,context);
            if(gy==0 && gx%2==0 && level%2==0) {
                BOOL connected=NO;NSPoint previous=NSZeroPoint;double budget=450;
                for(NSValue *value in full) {
                    AMTrajectoryPoint q;[value getValue:&q];double x=0,y=0;
                    if(![self projectLat:q.lat lon:q.lon height:q.heightM x:&x y:&y] || x<0 || y<0 || x>NSWidth(self.bounds) || y>NSHeight(self.bounds)){connected=NO;continue;}
                    NSPoint current=NSMakePoint(x,y);
                    if(connected && budget>0){double length=hypot(x-previous.x,y-previous.y);if(length<=budget){AMSyntheticWind wind=AMWindAt(context,q.lat,q.lon,q.heightM);AMLine(previous,current,[(wind.verticalMS>.15?NSColor.systemOrangeColor:wind.verticalMS<-.15?NSColor.systemTealColor:NSColor.secondaryLabelColor) colorWithAlphaComponent:.25],.8);budget-=length;}}
                    previous=current;connected=YES;
                }
            }
            NSMutableArray<NSValue *> *path=[NSMutableArray arrayWithCapacity:7];
            for (NSUInteger i=0;i<7;i++) { AMTrajectoryPoint point=AMTrajectoryAt(full,advance-90.0+15.0*i); [path addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]]; }
            NSMutableArray<NSValue *> *screen=[NSMutableArray arrayWithCapacity:path.count]; BOOL valid=YES;
            for (NSValue *value in path) { AMTrajectoryPoint point; [value getValue:&point]; double x=0,y=0; if (![self projectLat:point.lat lon:point.lon height:point.heightM*separation x:&x y:&y]) { valid=NO; break; } [screen addObject:[NSValue valueWithPoint:NSMakePoint(x,y)]]; }
            if (!valid || screen.count<2) continue; count++;
            CGFloat alpha=.15+.45*sin(M_PI*travel), width=.85+.75*MIN(1.0,h/9000.0), remaining=48; NSPoint headPoint=NSZeroPoint,previous=NSZeroPoint; BOOL drew=NO;
            for (NSInteger segment=(NSInteger)screen.count-1; segment>0 && remaining>0; segment--) {
                NSPoint end=[screen[segment] pointValue], start=[screen[segment-1] pointValue]; CGFloat length=hypot(end.x-start.x,end.y-start.y); if (length<.01) continue;
                CGFloat fraction=MIN(1.0,remaining/length); NSPoint clipped=NSMakePoint(end.x+(start.x-end.x)*fraction,end.y+(start.y-end.y)*fraction);
                AMTrajectoryPoint endpoint; [path[segment] getValue:&endpoint]; AMSyntheticWind local=AMWindAt(context,endpoint.lat,endpoint.lon,endpoint.heightM);
                NSColor *ink=local.verticalMS>.05?NSColor.systemOrangeColor:(local.verticalMS<-.05?NSColor.systemTealColor:[NSColor.labelColor colorWithAlphaComponent:.62]); ink=[ink colorWithAlphaComponent:alpha];
                NSBezierPath *line=[NSBezierPath bezierPath]; line.lineWidth=width; line.lineCapStyle=NSLineCapStyleRound; [line moveToPoint:clipped]; [line lineToPoint:end]; [ink setStroke]; [line stroke];
                remaining-=length*fraction; if (!drew) { headPoint=end; previous=start; drew=YES; }
            }
            if (!drew || headPoint.x<-24 || headPoint.x>self.bounds.size.width+24 || headPoint.y<-24 || headPoint.y>self.bounds.size.height+24) continue;
            CGFloat n=hypot(headPoint.x-previous.x,headPoint.y-previous.y); if (48-remaining<1 || n<.001) continue;
            AMTrajectoryPoint endpoint; [path.lastObject getValue:&endpoint]; AMSyntheticWind local=AMWindAt(context,endpoint.lat,endpoint.lon,endpoint.heightM);
            NSColor *ink=local.verticalMS>.05?NSColor.systemOrangeColor:(local.verticalMS<-.05?NSColor.systemTealColor:[NSColor.labelColor colorWithAlphaComponent:.62]); ink=[ink colorWithAlphaComponent:alpha]; CGFloat angle=atan2(headPoint.y-previous.y,headPoint.x-previous.x),head=MIN(3.0,(48-remaining)/3.0);
            AMLine(NSMakePoint(headPoint.x-head*cos(angle-.55),headPoint.y-head*sin(angle-.55)),headPoint,ink,width); AMLine(headPoint,NSMakePoint(headPoint.x-head*cos(angle+.55),headPoint.y-head*sin(angle+.55)),ink,width);
        }
    }
}

- (void)drawSection:(NSDictionary *)sample levels:(NSArray *)levels {
    if (!self.disclosureOpen) return; NSRect panel=[self panelRect]; if (NSHeight(panel)<120) return;
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:.96] setFill]; [[NSBezierPath bezierPathWithRoundedRect:panel xRadius:8 yRadius:8] fill];
    AMText(@"ft AMSL · pressure levels",NSMakeRect(panel.origin.x+12,panel.origin.y+32,180,14),9,NSColor.secondaryLabelColor,NO);
    NSRect plot=NSMakeRect(panel.origin.x+42,panel.origin.y+53,NSWidth(panel)-54,MAX(1,NSHeight(panel)-97)); double top=[self groundHeight]+[self teachingTopM];
    double tickFeet=top/.3048/4.0; for (int tick=0;tick<=4;tick++) { double feet=tick* tickFeet; CGFloat y=AMY(plot,feet*.3048,top); AMLine(NSMakePoint(NSMinX(plot),y),NSMakePoint(NSMaxX(plot),y),[NSColor.separatorColor colorWithAlphaComponent:.25],.5); AMText([NSString stringWithFormat:@"%.0fk",feet/1000],NSMakeRect(panel.origin.x+7,y-7,32,14),9,NSColor.secondaryLabelColor,NO); }
    NSDictionary *previous=nil; for (NSUInteger i=0;i<levels.count;i++) { NSDictionary *level=levels[i],*next=i+1<levels.count?levels[i+1]:nil; if (AMNumber(level[@"heightM"])) { double h=[level[@"heightM"] doubleValue]; double below=previous&&AMNumber(previous[@"heightM"])?([previous[@"heightM"] doubleValue]+h)*.5:h,above=next&&AMNumber(next[@"heightM"])?([next[@"heightM"] doubleValue]+h)*.5:h; if (AMNumber(level[@"cloudPct"])&&[level[@"cloudPct"] doubleValue]>=20&&above>below) { CGFloat y=AMY(plot,above,top),height=MAX(5,AMY(plot,below,top)-y); [[NSColor.systemBlueColor colorWithAlphaComponent:.18] setFill]; [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(NSMinX(plot),y,NSWidth(plot),height) xRadius:6 yRadius:6] fill]; } previous=level; } }
    CGFloat line=AMY(plot,self.aircraftAltitudeM,top); AMLine(NSMakePoint(NSMinX(plot),line),NSMakePoint(NSMaxX(plot),line),NSColor.systemOrangeColor,1); CGFloat labelY=NSMaxY(panel)-40; AMText([NSString stringWithFormat:@"%.0f ft",self.aircraftAltitudeM/.3048],NSMakeRect(NSMinX(plot),labelY,70,14),9,NSColor.systemOrangeColor,YES);
    for(NSDictionary *level in levels) {
        double y=AMY(plot,[level[@"heightM"] doubleValue],top),w=[level[@"verticalVelocityMS"] doubleValue],u=[level[@"windEastKt"] doubleValue],v=[level[@"windNorthKt"] doubleValue];
        AMText([NSString stringWithFormat:@"%@%.1f",w>=0?@"↑":@"↓",fabs(w)],NSMakeRect(NSMinX(plot)+4,y-6,47,12),9,w>=0?NSColor.systemOrangeColor:NSColor.systemTealColor,NO);
        AMText([NSString stringWithFormat:@"%.0f kt",hypot(u,v)],NSMakeRect(NSMaxX(plot)-57,y-6,42,12),9,NSColor.labelColor,NO);
    }
    BOOL hasVertical=[sample[@"featureAvailability"][@"verticalVelocity"] boolValue];
    NSDateFormatter *f=[NSDateFormatter new]; f.dateFormat=@"HH:mm'Z'"; f.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0];
    AMText([NSString stringWithFormat:@"%@ · %@",[f stringFromDate:self.date],hasVertical?@"↕ m/s":@"w —"],NSMakeRect(panel.origin.x+12,NSMaxY(panel)-27,NSWidth(panel)-24,17),9,NSColor.secondaryLabelColor,NO);

}

- (void)drawRect:(NSRect)dirtyRect {
    self.disclosureButton.hidden = fabs(self.camera.pitch)<1e-6 || !self.date || ![self sample];
    self.disclosureButton.title = self.disclosureOpen?@"Atmosphere ×":@"Atmosphere ≈";
    self.disclosureButton.toolTip = self.teachingKind==ATTeachingSeaBreeze ? @"Sea-breeze height shown at 3×" : @"Synthetic atmospheric data; vertical separation adapts to map scale";
    self.altitudeSlider.hidden = !self.disclosureOpen || fabs(self.camera.pitch)<1e-6 || !self.date || ![self sample];
    (void)dirtyRect; // AppKit clears the transparent backing; preserve the map when compositing snapshots.
    if (fabs(self.camera.pitch)<1e-6 || !self.date) return;
    NSDictionary *sample=[self sample]; NSArray *levels=[sample[@"levels"] isKindOfClass:NSArray.class]?sample[@"levels"]:nil; if (!levels.count) return;
    [self drawSyntheticFlows];
    [self drawHeightGuide];
    [self drawSection:sample levels:levels];
}

- (void)showSlider { if (self.altitudeSlider) return; self.altitudeSlider=[NSSlider sliderWithValue:self.aircraftAltitudeM minValue:[self knownGround]?[self groundHeight]+100:0 maxValue:[self groundHeight]+[self teachingTopM] target:self action:@selector(altitudeChanged:)]; self.altitudeSlider.vertical=YES; self.altitudeSlider.accessibilityLabel=@"Reference aircraft altitude"; [self addSubview:self.altitudeSlider]; [self layout]; }
- (void)layout { [super layout]; NSRect p=[self panelRect]; self.teachingSelector.frame=NSMakeRect(p.origin.x+12,p.origin.y+7,MIN(180,NSWidth(p)-58),22); self.frameButton.frame=NSMakeRect(NSMaxX(p)-42,p.origin.y+7,32,22); self.teachingSelector.hidden=!self.disclosureOpen || fabs(self.camera.pitch)<1e-6 || !self.date; self.frameButton.hidden=self.teachingSelector.hidden; if (self.altitudeSlider) self.altitudeSlider.frame=NSMakeRect(NSMaxX(p)-28,p.origin.y+45,20,MAX(1,NSHeight(p)-65)); }
- (void)altitudeChanged:(NSSlider *)sender { self.aircraftAltitudeM=MAX([self knownGround]?[self groundHeight]+100:0,sender.doubleValue); [self setNeedsDisplay:YES]; }
- (void)frameAtmosphere:(id)sender {
    (void)sender; ATTeachingContext context=[self teachingContext]; double top=[self teachingTopM];
    IsobarCamera next=self.camera; next.centreLat=context.lat; next.centreLon=context.lon;
    next.pitch=MAX(.8,next.pitch); next.globe=MIN(1,next.pitch/1.3);
    // Fit the actual projected column, including perspective, rather than
    // changing only the wind height or the overlay's private camera.
    double low=1,high=10000;
    for(int i=0;i<28;i++) {
        next.zoom=(low+high)/2; double x0,y0,x1,y1;
        double displayTop=[self displayHeight:context.groundM+top];
        BOOL fits=IsobarCameraProjectAltitude(next,context.lat,context.lon,context.groundM,&x0,&y0) && IsobarCameraProjectAltitude(next,context.lat,context.lon,displayTop,&x1,&y1) && y1>=next.viewportH*.15 && y0<=next.viewportH*.85;
        if (fits && self.teachingKind==ATTeachingSeaBreeze) {
            double lateral=8000.0/(111320.0*MAX(.2,cos(context.lat*M_PI/180.0))),westX=0,westY=0,eastX=0,eastY=0;
            fits=IsobarCameraProjectAltitude(next,context.lat,context.lon-lateral,context.groundM+1250*3.0,&westX,&westY) && IsobarCameraProjectAltitude(next,context.lat,context.lon+lateral,context.groundM+1250*3.0,&eastX,&eastY) && westX>=next.viewportW*.08 && eastX<=next.viewportW*.92 && westY>=next.viewportH*.12 && westY<=next.viewportH*.88 && eastY>=next.viewportH*.12 && eastY<=next.viewportH*.88;
        }
        if(fits)low=next.zoom;else high=next.zoom;
    }
    next.zoom=low;
    if (!isfinite(next.zoom) || !isfinite(next.centreLat) || !isfinite(next.centreLon) || next.viewportW<=0 || next.viewportH<=0) return;
    if(self.onFrameCamera)self.onFrameCamera(next);else self.camera=next;
    [self setNeedsDisplay:YES];
}
- (void)teachingChanged:(NSPopUpButton *)sender { self.teachingKind=(ATTeachingKind)MAX(0,MIN(3,sender.indexOfSelectedItem)); self.aircraftAltitudeM=MIN(self.aircraftAltitudeM,[self groundHeight]+[self teachingTopM]); self.altitudeSlider.maxValue=[self groundHeight]+[self teachingTopM]; [self frameAtmosphere:nil]; [self setNeedsDisplay:YES]; }
- (void)toggleDisclosure:(id)sender { (void)sender; self.disclosureOpen=!self.disclosureOpen; self.teachingSelector.hidden=!self.disclosureOpen; self.frameButton.hidden=!self.disclosureOpen; if (self.disclosureOpen) [self showSlider]; else { [self.altitudeSlider removeFromSuperview]; self.altitudeSlider=nil; } [self.window makeFirstResponder:self]; [self setNeedsDisplay:YES]; }
- (void)keyDown:(NSEvent *)event { if (event.keyCode==53&&self.disclosureOpen) { self.disclosureOpen=NO; self.teachingSelector.hidden=YES; self.frameButton.hidden=YES; [self.altitudeSlider removeFromSuperview]; self.altitudeSlider=nil; [self setNeedsDisplay:YES]; [self.window makeFirstResponder:self.superview ?: self]; return; } [super keyDown:event]; }
@end
