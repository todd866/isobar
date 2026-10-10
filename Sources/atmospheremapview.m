// Isobar — layered illustrative upper-air wind overlay. Vectors are synthetic
// spatial motion; the adjacent section uses the same synthetic profile.
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
static const double AMAltitudesM[] = {750,1500,3000,5500,9000};
static const int AMPressures[] = {925,850,700,500,300};
static const double AMCellTopM = 10000.0;
static const double AMCellVerticalMaxMS = 2.5;

typedef struct { double eastMS; double northMS; double verticalMS; } AMSyntheticWind;

// A closed, divergence-free illustrative overturning cell.  The horizontal
// partners are derived from the same streamfunction as w, so the lower and
// upper branches return in opposite directions and w is zero at both bounds.
static AMSyntheticWind AMWindAt(double latitude, double longitude, double heightM, NSDate *date) {
    AMGeographicCentre(&latitude, &longitude);
    double minutes=floor(date.timeIntervalSince1970/300.0)*300.0;
    double phase=minutes/3600.0*.12;
    double z=MIN(1.0,MAX(0.0,heightM/AMCellTopM));
    double cellX=longitude*M_PI*6.0+phase, cellY=latitude*M_PI*6.0-phase*.4;
    double shape=cos(M_PI*z);
    double kx=6.0*M_PI/(111320.0*MAX(.1,cos(latitude*M_PI/180.0)));
    double ky=6.0*M_PI/111132.0;
    double eastCell=-AMCellVerticalMaxMS*M_PI/(2.0*AMCellTopM*kx)*shape*sin(cellX)*cos(cellY);
    double northCell=-AMCellVerticalMaxMS*M_PI/(2.0*AMCellTopM*ky)*shape*cos(cellX)*sin(cellY);
    double vertical=AMCellVerticalMaxMS*sin(M_PI*z)*cos(cellX)*cos(cellY);
    return (AMSyntheticWind){8.0+20.0*z+eastCell,-5.0+16.0*z+northCell,vertical};
}

typedef struct { double lat, lon, heightM, time; } AMTrajectoryPoint;
static const double AMTrajectoryMinTime=-270.0, AMTrajectoryMaxTime=180.0, AMTrajectoryStep=15.0;
static NSCache *AMTrajectoryCache(void) {
    static NSCache *cache; static dispatch_once_t once;
    dispatch_once(&once, ^{ cache=[NSCache new]; cache.countLimit=12000; });
    return cache;
}
static AMTrajectoryPoint AMAdvanceTrajectory(AMTrajectoryPoint point, double dt, NSDate *date) {
    AMSyntheticWind wind=AMWindAt(point.lat,point.lon,point.heightM,date);
    AMTrajectoryPoint middle={point.lat+wind.northMS/111132.0*dt*.5,
        point.lon+wind.eastMS/(111320.0*MAX(.1,cos(point.lat*M_PI/180.0)))*dt*.5,
        point.heightM+wind.verticalMS*dt*.5,point.time+dt*.5};
    wind=AMWindAt(middle.lat,middle.lon,middle.heightM,date);
    return (AMTrajectoryPoint){point.lat+wind.northMS/111132.0*dt,
        point.lon+wind.eastMS/(111320.0*MAX(.1,cos(middle.lat*M_PI/180.0)))*dt,
        point.heightM+wind.verticalMS*dt,middle.time+dt*.5};
}
static NSString *AMTrajectoryKey(double lat,double lon,double heightM,NSDate *date) {
    long long bin=(long long)floor(date.timeIntervalSince1970/300.0);
    return [NSString stringWithFormat:@"%lld:%.5f:%.5f:%.0f",bin,lat,lon,heightM];
}
static NSArray<NSValue *> *AMFullTrajectory(double lat,double lon,double heightM,NSDate *date) {
    NSCache *cache=AMTrajectoryCache(); NSString *key=AMTrajectoryKey(lat,lon,heightM,date);
    NSArray<NSValue *> *cached=[cache objectForKey:key]; if (cached) return cached;
    AMTrajectoryPoint point={lat,lon,heightM,0}; NSMutableArray<NSValue *> *back=[NSMutableArray array]; [back addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]];
    for (double time=0;time>AMTrajectoryMinTime;time-=AMTrajectoryStep) { point=AMAdvanceTrajectory(point,-AMTrajectoryStep,date); [back addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]]; }
    NSMutableArray<NSValue *> *result=[NSMutableArray arrayWithCapacity:32]; for (NSValue *value in back.reverseObjectEnumerator) [result addObject:value];
    point=(AMTrajectoryPoint){lat,lon,heightM,0}; [result removeLastObject];
    for (double time=0;time<=AMTrajectoryMaxTime;time+=AMTrajectoryStep) { if (time>0) point=AMAdvanceTrajectory(point,AMTrajectoryStep,date); [result addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]]; }
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
@end

@implementation AtmosphereMapView
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        _aircraftAltitudeM=1524;
        _disclosureButton=[NSButton buttonWithTitle:@"Atmosphere ≈" target:self action:@selector(toggleDisclosure:)];
        _disclosureButton.bezelStyle=NSBezelStyleRounded;
        _disclosureButton.accessibilityLabel=@"Atmospheric section";
        _disclosureButton.toolTip=@"Synthetic atmospheric data; vertical separation adapts to map scale";
        _disclosureButton.frame=[self disclosureRect];
        [self addSubview:_disclosureButton];
    }
    return self;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (NSRect)disclosureRect { return NSMakeRect(8,40,126,24); }
- (NSRect)panelRect { CGFloat h=MIN(270,MAX(0,NSHeight(self.bounds)-76)); return NSMakeRect(8,68,MIN(260,MAX(0,NSWidth(self.bounds)-56)),h); }
- (NSDictionary *)sample {
    if (!self.date) return nil;
    NSMutableArray *levels=[NSMutableArray arrayWithCapacity:5];
    double lat=self.camera.centreLat, lon=self.camera.centreLon; AMGeographicCentre(&lat,&lon);
    for (NSUInteger i=0;i<5;i++) {
        double h=AMAltitudesM[i]; AMSyntheticWind wind=AMWindAt(lat,lon,h,self.date);
        [levels addObject:@{ @"pressureHpa":@(AMPressures[i]), @"heightM":@(h), @"cloudPct":@(i==1||i==2?65:0), @"windEastKt":@(wind.eastMS/.514444), @"windNorthKt":@(wind.northMS/.514444), @"verticalVelocityMS":@(wind.verticalMS) }];
    }
    return @{ @"model":@"Illustrative", @"run":self.date, @"levels":levels, @"featureAvailability":@{ @"verticalVelocity":@YES } };
}
- (BOOL)pointIsInteractive:(NSPoint)p {
    if (fabs(self.camera.pitch)<1e-6 || !self.date || ![self sample]) return NO;
    if (self.disclosureOpen && self.altitudeSlider && NSPointInRect(p,self.altitudeSlider.frame)) return YES;
    return NSPointInRect(p,[self disclosureRect]);
}
- (NSView *)hitTest:(NSPoint)p {
    if (! [self pointIsInteractive:p]) return nil;
    if (self.altitudeSlider && NSPointInRect(p,self.altitudeSlider.frame)) return self.altitudeSlider;
    return self.disclosureButton;
}

- (BOOL)projectLat:(double)lat lon:(double)lon height:(double)height x:(double *)x y:(double *)y {
    return IsobarCameraProjectAltitude(self.camera,lat,lon,height,x,y);
}
- (double)groundHeight {
    return AMNumber(self.product[@"elevation"])?[self.product[@"elevation"] doubleValue]:0;
}
- (NSDictionary *)syntheticWindAtHeight:(double)height latitude:(double)latitude longitude:(double)longitude {
    if (!self.date) return nil;
    AMSyntheticWind wind=AMWindAt(latitude,longitude,height,self.date);
    return @{ @"eastMS":@(wind.eastMS), @"northMS":@(wind.northMS), @"verticalMS":@(wind.verticalMS) };
}
- (BOOL)knownGround { return AMNumber(self.product[@"elevation"]); }

- (void)drawSyntheticFlows {
    if (!(self.camera.viewportW>1 && self.camera.viewportH>1)) return;
    double animation=CACurrentMediaTime()/5.0;
    double fit=MIN(self.camera.viewportW/360.0,self.camera.viewportH/180.0), halfHeight=self.camera.viewportH*.5/(self.camera.zoom*MAX(1e-6,fit));
    double aspect=self.camera.viewportW/MAX(1.0,self.camera.viewportH), spacing=pow(2.0,ceil(log2(halfHeight/1.5)));
    if (!(halfHeight>0 && halfHeight<6) || !isfinite(spacing)) return;
    double centreLat=self.camera.centreLat, centreLon=self.camera.centreLon; AMGeographicCentre(&centreLat,&centreLon);
    double lonSpacing=spacing/MAX(.2,cos(centreLat*M_PI/180.0));
    double south=MAX(-90,floor((centreLat-halfHeight*2)/spacing)*spacing), north=MIN(90,centreLat+halfHeight*2);
    double west=floor((centreLon-halfHeight*aspect*2)/lonSpacing)*lonSpacing, east=centreLon+halfHeight*aspect*2;
    double separation=1+(MIN(8.0,MAX(1.0,halfHeight/.15))-1)*sin(MAX(0.0,self.camera.pitch));
    for (NSUInteger level=0; level<5; level++) {
        double h=AMAltitudesM[level];
        NSUInteger count=0;
        for (double lat=south;lat<=north && count<1800;lat+=spacing) for (double lon=west;lon<=east && count<1800;lon+=lonSpacing) {
            double seed=fmod(fmod(sin(lat*57+lon*31+AMPressures[level])*43758.5,1.0)+1.0,1.0);
            double travel=fmod(animation+seed,1.0), advance=(travel-.5)*360.0;
            NSArray<NSValue *> *full=AMFullTrajectory(lat,lon,h,self.date); NSMutableArray<NSValue *> *path=[NSMutableArray arrayWithCapacity:7];
            for (NSUInteger i=0;i<7;i++) { AMTrajectoryPoint point=AMTrajectoryAt(full,advance-90.0+15.0*i); [path addObject:[NSValue valueWithBytes:&point objCType:@encode(AMTrajectoryPoint)]]; }
            NSMutableArray<NSValue *> *screen=[NSMutableArray arrayWithCapacity:path.count]; BOOL valid=YES;
            for (NSValue *value in path) { AMTrajectoryPoint point; [value getValue:&point]; double x=0,y=0; if (![self projectLat:point.lat lon:point.lon height:point.heightM*separation x:&x y:&y]) { valid=NO; break; } [screen addObject:[NSValue valueWithPoint:NSMakePoint(x,y)]]; }
            if (!valid || screen.count<2) continue; count++;
            CGFloat alpha=.15+.45*sin(M_PI*travel), width=.85+.75*MIN(1.0,h/9000.0), remaining=48; NSPoint headPoint=NSZeroPoint,previous=NSZeroPoint; BOOL drew=NO;
            for (NSInteger segment=(NSInteger)screen.count-1; segment>0 && remaining>0; segment--) {
                NSPoint end=[screen[segment] pointValue], start=[screen[segment-1] pointValue]; CGFloat length=hypot(end.x-start.x,end.y-start.y); if (length<.01) continue;
                CGFloat fraction=MIN(1.0,remaining/length); NSPoint clipped=NSMakePoint(end.x+(start.x-end.x)*fraction,end.y+(start.y-end.y)*fraction);
                AMTrajectoryPoint endpoint; [path[segment] getValue:&endpoint]; AMSyntheticWind local=AMWindAt(endpoint.lat,endpoint.lon,endpoint.heightM,self.date);
                NSColor *ink=local.verticalMS>.05?NSColor.systemOrangeColor:(local.verticalMS<-.05?NSColor.systemTealColor:[NSColor.labelColor colorWithAlphaComponent:.62]); ink=[ink colorWithAlphaComponent:alpha];
                NSBezierPath *line=[NSBezierPath bezierPath]; line.lineWidth=width; line.lineCapStyle=NSLineCapStyleRound; [line moveToPoint:clipped]; [line lineToPoint:end]; [ink setStroke]; [line stroke];
                remaining-=length*fraction; if (!drew) { headPoint=end; previous=start; drew=YES; }
            }
            if (!drew || headPoint.x<-24 || headPoint.x>self.bounds.size.width+24 || headPoint.y<-24 || headPoint.y>self.bounds.size.height+24) continue;
            CGFloat n=hypot(headPoint.x-previous.x,headPoint.y-previous.y); if (48-remaining<1 || n<.001) continue;
            AMTrajectoryPoint endpoint; [path.lastObject getValue:&endpoint]; AMSyntheticWind local=AMWindAt(endpoint.lat,endpoint.lon,endpoint.heightM,self.date);
            NSColor *ink=local.verticalMS>.05?NSColor.systemOrangeColor:(local.verticalMS<-.05?NSColor.systemTealColor:[NSColor.labelColor colorWithAlphaComponent:.62]); ink=[ink colorWithAlphaComponent:alpha]; CGFloat angle=atan2(headPoint.y-previous.y,headPoint.x-previous.x),head=MIN(3.0,(48-remaining)/3.0);
            AMLine(NSMakePoint(headPoint.x-head*cos(angle-.55),headPoint.y-head*sin(angle-.55)),headPoint,ink,width); AMLine(headPoint,NSMakePoint(headPoint.x-head*cos(angle+.55),headPoint.y-head*sin(angle+.55)),ink,width);
        }
    }
}

- (void)drawSection:(NSDictionary *)sample levels:(NSArray *)levels {
    if (!self.disclosureOpen) return; NSRect panel=[self panelRect]; if (NSHeight(panel)<120) return;
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:.96] setFill]; [[NSBezierPath bezierPathWithRoundedRect:panel xRadius:8 yRadius:8] fill];
    AMText(@"Illustrative profile",NSMakeRect(panel.origin.x+12,panel.origin.y+9,180,16),11,NSColor.labelColor,YES);
    AMText(@"ft AMSL · pressure levels",NSMakeRect(panel.origin.x+12,panel.origin.y+26,180,14),9,NSColor.secondaryLabelColor,NO);
    NSRect plot=NSMakeRect(panel.origin.x+42,panel.origin.y+47,NSWidth(panel)-54,MAX(1,NSHeight(panel)-91)); double top=14000;
    for (double feet=0;feet<=40000;feet+=10000) { CGFloat y=AMY(plot,feet*.3048,top); AMLine(NSMakePoint(NSMinX(plot),y),NSMakePoint(NSMaxX(plot),y),[NSColor.separatorColor colorWithAlphaComponent:.25],.5); AMText([NSString stringWithFormat:@"%.0fk",feet/1000],NSMakeRect(panel.origin.x+7,y-7,32,14),9,NSColor.secondaryLabelColor,NO); }
    NSDictionary *previous=nil; for (NSUInteger i=0;i<levels.count;i++) { NSDictionary *level=levels[i],*next=i+1<levels.count?levels[i+1]:nil; if (AMNumber(level[@"heightM"])) { double h=[level[@"heightM"] doubleValue]; double below=previous&&AMNumber(previous[@"heightM"])?([previous[@"heightM"] doubleValue]+h)*.5:h,above=next&&AMNumber(next[@"heightM"])?([next[@"heightM"] doubleValue]+h)*.5:h; if (AMNumber(level[@"cloudPct"])&&[level[@"cloudPct"] doubleValue]>=20&&above>below) { CGFloat y=AMY(plot,above,top),height=MAX(5,AMY(plot,below,top)-y); [[NSColor.systemBlueColor colorWithAlphaComponent:.18] setFill]; [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(NSMinX(plot),y,NSWidth(plot),height) xRadius:6 yRadius:6] fill]; } previous=level; } }
    CGFloat line=AMY(plot,self.aircraftAltitudeM,top); AMLine(NSMakePoint(NSMinX(plot),line),NSMakePoint(NSMaxX(plot),line),NSColor.systemOrangeColor,1); AMText([NSString stringWithFormat:@"%.0f ft",self.aircraftAltitudeM/.3048],NSMakeRect(NSMinX(plot),line-16,70,14),9,NSColor.systemOrangeColor,YES);
    BOOL hasVertical=[sample[@"featureAvailability"][@"verticalVelocity"] boolValue];
    NSDateFormatter *f=[NSDateFormatter new]; f.dateFormat=@"HH:mm'Z'"; f.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0];
    AMText([NSString stringWithFormat:@"%@ · %@",[f stringFromDate:self.date],hasVertical?@"↕ m/s":@"w —"],NSMakeRect(panel.origin.x+12,NSMaxY(panel)-27,NSWidth(panel)-24,17),9,NSColor.secondaryLabelColor,NO);

}

- (void)drawRect:(NSRect)dirtyRect {
    self.disclosureButton.hidden = fabs(self.camera.pitch)<1e-6 || !self.date || ![self sample];
    self.disclosureButton.title = self.disclosureOpen?@"Atmosphere ×":@"Atmosphere ≈";
    self.altitudeSlider.hidden = !self.disclosureOpen || fabs(self.camera.pitch)<1e-6 || !self.date || ![self sample];
    (void)dirtyRect; // AppKit clears the transparent backing; preserve the map when compositing snapshots.
    if (fabs(self.camera.pitch)<1e-6 || !self.date) return;
    NSDictionary *sample=[self sample]; NSArray *levels=[sample[@"levels"] isKindOfClass:NSArray.class]?sample[@"levels"]:nil; if (!levels.count) return;
    [self drawSyntheticFlows];
    [self drawSection:sample levels:levels];
}

- (void)showSlider { if (self.altitudeSlider) return; self.altitudeSlider=[NSSlider sliderWithValue:self.aircraftAltitudeM minValue:[self knownGround]?[self groundHeight]+100:0 maxValue:14000 target:self action:@selector(altitudeChanged:)]; self.altitudeSlider.vertical=YES; self.altitudeSlider.accessibilityLabel=@"Reference aircraft altitude"; [self addSubview:self.altitudeSlider]; [self layout]; }
- (void)layout { [super layout]; if (self.altitudeSlider) { NSRect p=[self panelRect]; self.altitudeSlider.frame=NSMakeRect(NSMaxX(p)-28,p.origin.y+45,20,MAX(1,NSHeight(p)-65)); } }
- (void)altitudeChanged:(NSSlider *)sender { self.aircraftAltitudeM=MAX([self knownGround]?[self groundHeight]+100:0,sender.doubleValue); [self setNeedsDisplay:YES]; }
- (void)toggleDisclosure:(id)sender { (void)sender; self.disclosureOpen=!self.disclosureOpen; if (self.disclosureOpen) [self showSlider]; else { [self.altitudeSlider removeFromSuperview]; self.altitudeSlider=nil; } [self.window makeFirstResponder:self]; [self setNeedsDisplay:YES]; }
- (void)keyDown:(NSEvent *)event { if (event.keyCode==53&&self.disclosureOpen) { self.disclosureOpen=NO; [self.altitudeSlider removeFromSuperview]; self.altitudeSlider=nil; [self setNeedsDisplay:YES]; [self.window makeFirstResponder:self.superview ?: self]; return; } [super keyDown:event]; }
@end
