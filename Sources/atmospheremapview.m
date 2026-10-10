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
    NSMutableArray *levels=[NSMutableArray arrayWithCapacity:5]; double phase=self.date.timeIntervalSince1970/3600.0*.12;
    double lat=self.camera.centreLat, lon=self.camera.centreLon; AMGeographicCentre(&lat,&lon);
    for (NSUInteger i=0;i<5;i++) {
        double h=AMAltitudesM[i], z=MIN(1.0,h/10000.0), xx=lon*M_PI*6, yy=lat*M_PI*6;
        double u=8+20*z+3*sin(xx+phase)*cos(M_PI*z), v=-5+16*z+3*sin(yy-phase*.4)*cos(M_PI*z), w=2.5*cos(xx+phase)*cos(yy-phase*.4)*sin(M_PI*z);
        [levels addObject:@{ @"pressureHpa":@(AMPressures[i]), @"heightM":@(h), @"cloudPct":@(i==1||i==2?65:0), @"windEastKt":@(u/.514444), @"windNorthKt":@(v/.514444), @"verticalVelocityMS":@(w) }];
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
- (BOOL)knownGround { return AMNumber(self.product[@"elevation"]); }

- (void)drawSyntheticFlows {
    if (!(self.camera.viewportW>1 && self.camera.viewportH>1)) return;
    double phase=self.date.timeIntervalSince1970/3600.0*.12;
    double animation=CACurrentMediaTime()/5.0;
    double fit=MIN(self.camera.viewportW/360.0,self.camera.viewportH/180.0), halfHeight=self.camera.viewportH*.5/(self.camera.zoom*MAX(1e-6,fit));
    double aspect=self.camera.viewportW/MAX(1.0,self.camera.viewportH), spacing=pow(2.0,ceil(log2(halfHeight/1.5)));
    if (!(halfHeight>0 && halfHeight<6) || !isfinite(spacing)) return;
    double centreLat=self.camera.centreLat, centreLon=self.camera.centreLon; AMGeographicCentre(&centreLat,&centreLon);
    double lonSpacing=spacing/MAX(.2,cos(centreLat*M_PI/180.0));
    double south=MAX(-90,floor((centreLat-halfHeight*2)/spacing)*spacing), north=MIN(90,centreLat+halfHeight*2);
    double west=floor((centreLon-halfHeight*aspect*2)/lonSpacing)*lonSpacing, east=centreLon+halfHeight*aspect*2;
    double separation=1+(MIN(8.0,MAX(1.0,halfHeight/.15))-1)*sin(MAX(0.0,self.camera.pitch));
    double lift=1+5*sin(MAX(0.0,self.camera.pitch));
    for (NSUInteger level=0; level<5; level++) {
        double h=AMAltitudesM[level], z=MIN(1.0,h/10000.0);
        NSUInteger count=0;
        for (double lat=south;lat<=north && count<1800;lat+=spacing) for (double lon=west;lon<=east && count<1800;lon+=lonSpacing) {
            double xx=lon*M_PI*6, yy=lat*M_PI*6, cell=cos(xx+phase)*cos(yy-phase*.4);
            double u=8+20*z+3*sin(xx+phase)*cos(M_PI*z), v=-5+16*z+3*sin(yy-phase*.4)*cos(M_PI*z), w=2.5*cell*sin(M_PI*z);
            double seed=fmod(fmod(sin(lat*57+lon*31+AMPressures[level])*43758.5,1.0)+1.0,1.0);
            double travel=fmod(animation+seed,1.0), seconds=(travel-.5)*360.0;
            double x0=0,y0=0,x1=0,y1=0;
            double startLat=lat+v*(seconds-90.0)/111132.0;
            double startLon=lon+u*(seconds-90.0)/(111320.0*MAX(.1,cos(lat*M_PI/180.0)));
            double endLat=lat+v*seconds/111132.0;
            double endLon=lon+u*seconds/(111320.0*MAX(.1,cos(lat*M_PI/180.0)));
            if (![self projectLat:startLat lon:startLon height:(h+w*(seconds-90.0)*lift)*separation x:&x0 y:&y0]
                || ![self projectLat:endLat lon:endLon height:(h+w*seconds*lift)*separation x:&x1 y:&y1]) continue;
            count++; double dx=x1-x0,dy=y1-y0,n=hypot(dx,dy);
            if (!(n>=1 && x1>-24 && x1<self.bounds.size.width+24 && y1>-24 && y1<self.bounds.size.height+24)) continue;
            if (n>34) { x0=x1+(x0-x1)*34/n; y0=y1+(y0-y1)*34/n; n=34; }
            NSColor *ink=w>.05?NSColor.systemOrangeColor:(w<-.05?NSColor.systemTealColor:[NSColor.labelColor colorWithAlphaComponent:.62]);
            ink=[ink colorWithAlphaComponent:.15+.45*sin(M_PI*travel)];
            [ink setStroke]; NSBezierPath *line=[NSBezierPath bezierPath]; line.lineWidth=.85+.75*MIN(1.0,h/9000.0); line.lineCapStyle=NSLineCapStyleRound; [line moveToPoint:NSMakePoint(x0,y0)]; [line lineToPoint:NSMakePoint(x1,y1)]; [line stroke];
            double angle=atan2(y1-y0,x1-x0),head=MIN(3.0,n/3.0); AMLine(NSMakePoint(x1,y1),NSMakePoint(x1-head*cos(angle-.55),y1-head*sin(angle-.55)),ink,line.lineWidth); AMLine(NSMakePoint(x1,y1),NSMakePoint(x1-head*cos(angle+.55),y1-head*sin(angle+.55)),ink,line.lineWidth);
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
