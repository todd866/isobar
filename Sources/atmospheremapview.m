// Isobar — representative forecast profile overlay. Cloud geometry is an
// illustrative vertical envelope; it is never presented as an exact footprint.
#import "atmospheremapview.h"
#import "atmosphere.h"
#import <math.h>

static BOOL AMNumber(id v) { return [v isKindOfClass:NSNumber.class] && isfinite([v doubleValue]); }
static CGFloat AMY(NSRect r,double h,double top) { return NSMaxY(r)-(CGFloat)(MIN(top,MAX(0,h))/top)*NSHeight(r); }
static void AMText(NSString *s,NSRect r,CGFloat size,NSColor *c,BOOL bold) {
    [s drawInRect:r withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size weight:bold?NSFontWeightSemibold:NSFontWeightRegular],NSForegroundColorAttributeName:c}];
}
static void AMLine(NSPoint a,NSPoint b,NSColor *c,CGFloat width) {
    NSBezierPath *p=[NSBezierPath bezierPath]; p.lineWidth=width; [p moveToPoint:a]; [p lineToPoint:b]; [c setStroke]; [p stroke];
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
        _disclosureButton.toolTip=@"Representative forecast column; horizontal cloud extent is illustrative";
        _disclosureButton.frame=[self disclosureRect];
        [self addSubview:_disclosureButton];
    }
    return self;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (NSRect)disclosureRect { return NSMakeRect(8,40,126,24); }
- (NSRect)panelRect { CGFloat h=MIN(270,MAX(0,NSHeight(self.bounds)-76)); return NSMakeRect(8,68,MIN(260,MAX(0,NSWidth(self.bounds)-56)),h); }
- (NSDictionary *)sample { return self.product && self.date ? AtmosphereAtDate(self.product,self.date) : nil; }
- (BOOL)pointIsInteractive:(NSPoint)p {
    if (fabs(self.camera.pitch)<1e-6 || !self.product || !self.date || ![self sample]) return NO;
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

- (void)drawCloudEnvelopeFor:(NSDictionary *)level previous:(NSDictionary *)previous next:(NSDictionary *)next sample:(NSArray *)levels {
    if (!AMNumber(level[@"cloudPct"]) || [level[@"cloudPct"] doubleValue]<20 || !AMNumber(level[@"heightM"])) return;
    double h=[level[@"heightM"] doubleValue], below=previous&&AMNumber(previous[@"heightM"])?([previous[@"heightM"] doubleValue]+h)*.5:h;
    double above=next&&AMNumber(next[@"heightM"])?([next[@"heightM"] doubleValue]+h)*.5:h;
    if ([self knownGround]) below=MAX(below,[self groundHeight]);
    if (!(above>below)) return;
    (void)levels;
    NSPoint base[32], cap[32];
    for (int i=0;i<32;i++) {
        double angle=i*M_PI*2/32.0, east=cos(angle)*4500, north=sin(angle)*2700;
        double lon=self.longitude+east/(111320*MAX(.1,cos(self.latitude*M_PI/180))), lat=self.latitude+north/111132;
        double x=0,y=0;
        if (![self projectLat:lat lon:lon height:below x:&x y:&y]) return;
        base[i]=NSMakePoint(x,y);
        if (![self projectLat:self.latitude+(lat-self.latitude)*.85 lon:self.longitude+(lon-self.longitude)*.85 height:above x:&x y:&y]) return;
        cap[i]=NSMakePoint(x,y);
    }
    NSColor *fill=[NSColor.controlBackgroundColor colorWithAlphaComponent:.75], *edge=[NSColor.systemTealColor colorWithAlphaComponent:.45];
    // The tilted eye is south of the column; draw its near wall.
    for (int i=16;i<32;i++) {
        int next=(i+1)%32;
        NSBezierPath *face=[NSBezierPath bezierPath]; [face moveToPoint:base[i]]; [face lineToPoint:base[next]]; [face lineToPoint:cap[next]]; [face lineToPoint:cap[i]]; [face closePath]; [fill setFill]; [face fill];
    }
    NSBezierPath *top=[NSBezierPath bezierPath]; [top moveToPoint:cap[0]];
    for (int i=1;i<32;i++) [top lineToPoint:cap[i]];
    [top closePath]; [fill setFill]; [top fill]; [edge setStroke]; top.lineWidth=.8; [top stroke];

}

- (void)drawFlowFor:(NSDictionary *)level {
    if (!AMNumber(level[@"heightM"])) return;
    double h=[level[@"heightM"] doubleValue], x0=0,y0=0,x1=0,y1=0;
    if (![self projectLat:self.latitude lon:self.longitude height:h x:&x0 y:&y0]) return;
    BOOL horizontal=AMNumber(level[@"windEastKt"])&&AMNumber(level[@"windNorthKt"]);
    if (!horizontal) { AMText(@"?",NSMakeRect(x0-4,y0-7,12,14),10,[NSColor.secondaryLabelColor colorWithAlphaComponent:.8],YES); return; }
    double seconds=180, east=[level[@"windEastKt"] doubleValue]*.514444*seconds, north=[level[@"windNorthKt"] doubleValue]*.514444*seconds;
    double lat=self.latitude+north/6371000.0*180/M_PI, lon=self.longitude+east/(6371000.0*MAX(.1,cos(self.latitude*M_PI/180.0)))*180/M_PI;
    double vertical=AMNumber(level[@"verticalVelocityMS"])?[level[@"verticalVelocityMS"] doubleValue]*seconds:0;
    if (![self projectLat:lat lon:lon height:h+vertical x:&x1 y:&y1]) return;
    NSColor *ink=AMNumber(level[@"verticalVelocityMS"])?(vertical>0?NSColor.systemOrangeColor:NSColor.systemTealColor):[NSColor.secondaryLabelColor colorWithAlphaComponent:.72];
    AMLine(NSMakePoint(x0,y0),NSMakePoint(x1,y1),ink,1.1);
    double dx=x1-x0,dy=y1-y0,n=hypot(dx,dy); if (n>2) { dx/=n;dy/=n; AMLine(NSMakePoint(x1,y1),NSMakePoint(x1-dx*5+dy*3,y1-dy*5-dx*3),ink,1.1); AMLine(NSMakePoint(x1,y1),NSMakePoint(x1-dx*5-dy*3,y1-dy*5+dx*3),ink,1.1); }
}

- (void)drawAircraft {
    double x=0,y=0; if (![self projectLat:self.latitude lon:self.longitude height:self.aircraftAltitudeM x:&x y:&y]) return;
    double xNear=0,yNear=0; [self projectLat:self.latitude lon:self.longitude+11/(111320*MAX(.1,cos(self.latitude*M_PI/180))) height:self.aircraftAltitudeM x:&xNear y:&yNear];
    CGFloat size=MAX(12,hypot(xNear-x,yNear-y)); NSColor *ink=NSColor.systemOrangeColor; [ink setStroke]; [ink setFill];
    NSBezierPath *plane=[NSBezierPath bezierPath];
    const double xy[][2]={{0,-.5},{.07,-.1},{.5,.07},{.5,.15},{.08,.1},{.05,.4},{.22,.48},{-.22,.48},{-.05,.4},{-.08,.1},{-.5,.15},{-.5,.07},{-.07,-.1}};
    [plane moveToPoint:NSMakePoint(x+xy[0][0]*size,y+xy[0][1]*size)];
    for(int i=1;i<13;i++) [plane lineToPoint:NSMakePoint(x+xy[i][0]*size,y+xy[i][1]*size)];
    [plane closePath]; [plane fill];
    AMText([NSString stringWithFormat:@"%.0f ft AMSL",self.aircraftAltitudeM/0.3048],NSMakeRect(x+8,y-9,86,16),9,NSColor.labelColor,YES);
}

- (void)drawSection:(NSDictionary *)sample levels:(NSArray *)levels {
    if (!self.disclosureOpen) return; NSRect panel=[self panelRect]; if (NSHeight(panel)<120) return;
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:.96] setFill]; [[NSBezierPath bezierPathWithRoundedRect:panel xRadius:8 yRadius:8] fill];
    AMText(@"Representative profile",NSMakeRect(panel.origin.x+12,panel.origin.y+9,180,16),11,NSColor.labelColor,YES);
    AMText(@"ft AMSL · pressure levels",NSMakeRect(panel.origin.x+12,panel.origin.y+26,180,14),9,NSColor.secondaryLabelColor,NO);
    NSRect plot=NSMakeRect(panel.origin.x+42,panel.origin.y+47,NSWidth(panel)-54,MAX(1,NSHeight(panel)-91)); double top=14000;
    for (double feet=0;feet<=40000;feet+=10000) { CGFloat y=AMY(plot,feet*.3048,top); AMLine(NSMakePoint(NSMinX(plot),y),NSMakePoint(NSMaxX(plot),y),[NSColor.separatorColor colorWithAlphaComponent:.25],.5); AMText([NSString stringWithFormat:@"%.0fk",feet/1000],NSMakeRect(panel.origin.x+7,y-7,32,14),9,NSColor.secondaryLabelColor,NO); }
    NSDictionary *previous=nil; for (NSUInteger i=0;i<levels.count;i++) { NSDictionary *level=levels[i],*next=i+1<levels.count?levels[i+1]:nil; if (AMNumber(level[@"heightM"])) { double h=[level[@"heightM"] doubleValue]; double below=previous&&AMNumber(previous[@"heightM"])?([previous[@"heightM"] doubleValue]+h)*.5:h,above=next&&AMNumber(next[@"heightM"])?([next[@"heightM"] doubleValue]+h)*.5:h; if (AMNumber(level[@"cloudPct"])&&[level[@"cloudPct"] doubleValue]>=20&&above>below) { CGFloat y=AMY(plot,above,top),height=MAX(5,AMY(plot,below,top)-y); [[NSColor.systemBlueColor colorWithAlphaComponent:.18] setFill]; [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(NSMinX(plot),y,NSWidth(plot),height) xRadius:6 yRadius:6] fill]; } previous=level; } }
    CGFloat line=AMY(plot,self.aircraftAltitudeM,top); AMLine(NSMakePoint(NSMinX(plot),line),NSMakePoint(NSMaxX(plot),line),NSColor.systemOrangeColor,1); AMText([NSString stringWithFormat:@"%.0f ft",self.aircraftAltitudeM/.3048],NSMakeRect(NSMinX(plot),line-16,70,14),9,NSColor.systemOrangeColor,YES);
    BOOL hasVertical=[sample[@"featureAvailability"][@"verticalVelocity"] boolValue];
    NSDateFormatter *f=[NSDateFormatter new]; f.dateFormat=@"HH:mm'Z'"; f.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0];
    AMText([NSString stringWithFormat:@"%@ · %@ · %@",sample[@"model"] ?: @"—",[f stringFromDate:self.date],hasVertical?@"↕ m/s":@"w —"],NSMakeRect(panel.origin.x+12,NSMaxY(panel)-27,NSWidth(panel)-24,17),9,NSColor.secondaryLabelColor,NO);

}

- (void)drawRect:(NSRect)dirtyRect {
    self.disclosureButton.hidden = fabs(self.camera.pitch)<1e-6 || !self.product || ![self sample];
    self.disclosureButton.title = self.disclosureOpen?@"Atmosphere ×":@"Atmosphere ≈";
    self.altitudeSlider.hidden = !self.disclosureOpen || fabs(self.camera.pitch)<1e-6 || !self.product || ![self sample];
    (void)dirtyRect; // AppKit clears the transparent backing; preserve the map when compositing snapshots.
    if (fabs(self.camera.pitch)<1e-6 || !self.product || !self.date) return;
    NSDictionary *sample=[self sample]; NSArray *levels=[sample[@"levels"] isKindOfClass:NSArray.class]?sample[@"levels"]:nil; if (!levels.count) return;
    for (NSUInteger i=0;i<levels.count;i++) { NSDictionary *previous=i?levels[i-1]:nil,*next=i+1<levels.count?levels[i+1]:nil; [self drawCloudEnvelopeFor:levels[i] previous:previous next:next sample:levels]; [self drawFlowFor:levels[i]]; }
    if ([self knownGround]) self.aircraftAltitudeM=MAX(self.aircraftAltitudeM,[self groundHeight]+100);
    [self drawAircraft];
    [self drawSection:sample levels:levels];
}

- (void)showSlider { if (self.altitudeSlider) return; self.altitudeSlider=[NSSlider sliderWithValue:self.aircraftAltitudeM minValue:[self knownGround]?[self groundHeight]+100:0 maxValue:14000 target:self action:@selector(altitudeChanged:)]; self.altitudeSlider.vertical=YES; self.altitudeSlider.accessibilityLabel=@"Reference aircraft altitude"; [self addSubview:self.altitudeSlider]; [self layout]; }
- (void)layout { [super layout]; if (self.altitudeSlider) { NSRect p=[self panelRect]; self.altitudeSlider.frame=NSMakeRect(NSMaxX(p)-28,p.origin.y+45,20,MAX(1,NSHeight(p)-65)); } }
- (void)altitudeChanged:(NSSlider *)sender { self.aircraftAltitudeM=MAX([self knownGround]?[self groundHeight]+100:0,sender.doubleValue); [self setNeedsDisplay:YES]; }
- (void)toggleDisclosure:(id)sender { (void)sender; self.disclosureOpen=!self.disclosureOpen; if (self.disclosureOpen) [self showSlider]; else { [self.altitudeSlider removeFromSuperview]; self.altitudeSlider=nil; } [self.window makeFirstResponder:self]; [self setNeedsDisplay:YES]; }
- (void)keyDown:(NSEvent *)event { if (event.keyCode==53&&self.disclosureOpen) { self.disclosureOpen=NO; [self.altitudeSlider removeFromSuperview]; self.altitudeSlider=nil; [self setNeedsDisplay:YES]; [self.window makeFirstResponder:self.superview ?: self]; return; } [super keyDown:event]; }
@end
