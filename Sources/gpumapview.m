// GPU map for the popover and the expanded window. Forecast time is sampled
// from the shared player. The view does not keep a second clock.
#import "gpumapview.h"
#import "ownchart.h"
#import "mapcamera.h"
#import "atmospheremapview.h"
#import "hazard.h"
#import <QuartzCore/QuartzCore.h>
#import <math.h>
#import <string.h>

NSString *const GPUMapEnabledKey = @"gpuMapEnabled";
static const double kGPUZoom = 6.0;
static const double kClickPoints = 4.0;
static const double kMaxMapPitch = 1.30;
static const double kFullTiltPitch = 1.30;
static const double kKeyboardTiltStep = 15.0 * M_PI / 180.0;

BOOL GPUMapEnabledInDefaults(NSUserDefaults *defaults) {
    if (!defaults || ![defaults objectForKey:GPUMapEnabledKey]) return YES;
    return [defaults boolForKey:GPUMapEnabledKey];
}

void GPUMapSetEnabled(NSUserDefaults *defaults, BOOL enabled) {
    [defaults setBool:enabled forKey:GPUMapEnabledKey];
}

GPUMapSurface GPUMapSurfaceFor(BOOL newMapEnabled, BOOL chartsReady) {
    if (!chartsReady) return GPUMapSurfaceUnavailable;
    return newMapEnabled ? GPUMapSurfaceNew : GPUMapSurfaceClassic;
}

BOOL GPUMapTagIsClassicOnly(NSInteger tag) {
    return tag >= 10 && tag <= 14;
}

NSString *GPUMapMenuTitle(NSString *title, BOOL classicOnly, BOOL note) {
    if (!note || !classicOnly || !title.length) return title ?: @"";
    if ([title containsString:@"Classic map only"]) return title;
    return [title stringByAppendingString:@" — Classic map only"];
}

@interface GPUMapDot : NSView
@end
@implementation GPUMapDot
- (BOOL)isOpaque { return NO; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect box = NSInsetRect(self.bounds, 1.5, 1.5);
    NSBezierPath *dot = [NSBezierPath bezierPathWithOvalInRect:box];
    [[NSColor colorWithSRGBRed:0.12 green:0.35 blue:0.78 alpha:1] setFill];
    [dot fill];
    [[NSColor whiteColor] setStroke];
    dot.lineWidth = 1.5;
    [dot stroke];
}
@end

@class GPUMapView;
@interface GPUMapView (PointerHoldPrivate)
- (void)cancelPointerHold;
@end
static NSColor *GMTrafficColour(NSInteger index) {
    static NSArray<NSColor *> *colours; static dispatch_once_t once;
    dispatch_once(&once, ^{ colours=@[
        [NSColor colorWithSRGBRed:.08 green:.48 blue:.72 alpha:1], [NSColor colorWithSRGBRed:.72 green:.28 blue:.15 alpha:1],
        [NSColor colorWithSRGBRed:.18 green:.56 blue:.30 alpha:1], [NSColor colorWithSRGBRed:.55 green:.25 blue:.67 alpha:1],
        [NSColor colorWithSRGBRed:.78 green:.47 blue:.08 alpha:1], [NSColor colorWithSRGBRed:.10 green:.55 blue:.55 alpha:1],
        [NSColor colorWithSRGBRed:.60 green:.20 blue:.36 alpha:1], [NSColor colorWithSRGBRed:.35 green:.35 blue:.68 alpha:1]]; });
    NSColor *base=colours[(NSUInteger)MAX(0,index)%colours.count];
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        BOOL dark=[[appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]] isEqual:NSAppearanceNameDarkAqua];
        return dark?[base blendedColorWithFraction:.38 ofColor:NSColor.whiteColor]:base;
    }];
}
static void GMText(NSString *text, NSRect rect, CGFloat size, NSColor *colour) {
    NSMutableParagraphStyle *style=[NSMutableParagraphStyle new]; style.lineBreakMode=NSLineBreakByTruncatingTail;
    [text drawInRect:rect withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size weight:NSFontWeightSemibold],NSForegroundColorAttributeName:colour,NSParagraphStyleAttributeName:style}];
}
static void GMGreatCircle(double aLat,double aLon,double bLat,double bLon,double fraction,double *lat,double *lon) {
    double r=M_PI/180, ax=cos(aLat*r)*cos(aLon*r),ay=cos(aLat*r)*sin(aLon*r),az=sin(aLat*r);
    double bx=cos(bLat*r)*cos(bLon*r),by=cos(bLat*r)*sin(bLon*r),bz=sin(bLat*r),dot=MIN(1,MAX(-1,ax*bx+ay*by+az*bz));
    double angle=acos(dot),s=sin(angle); double x,y,z;
    if (fabs(s)<1e-6) { x=ax*(1-fraction)+bx*fraction; y=ay*(1-fraction)+by*fraction; z=az*(1-fraction)+bz*fraction; }
    else { double p=sin((1-fraction)*angle)/s,q=sin(fraction*angle)/s; x=p*ax+q*bx; y=p*ay+q*by; z=p*az+q*bz; }
    *lat=atan2(z,hypot(x,y))/r; *lon=atan2(y,x)/r;
}
@interface GMTrafficContent : NSView
@end
@implementation GMTrafficContent
- (BOOL)isFlipped { return YES; }
@end
// Keep native button input/accessibility, with deterministic compact rendering
// in both the Metal subview and offscreen captures.
@interface GMTrafficChip : NSButton
@end
@implementation GMTrafficChip
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSBezierPath *shape=[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds,1,2) xRadius:5 yRadius:5];
    [(self.highlighted?NSColor.selectedControlColor:NSColor.controlBackgroundColor) setFill]; [shape fill];
    [NSColor.separatorColor setStroke]; shape.lineWidth=.5; [shape stroke];
    NSDictionary *attrs=@{NSFontAttributeName:self.font,NSForegroundColorAttributeName:self.contentTintColor?:NSColor.labelColor};
    NSSize size=[self.title sizeWithAttributes:attrs];
    [self.title drawAtPoint:NSMakePoint((NSWidth(self.bounds)-size.width)/2,(NSHeight(self.bounds)-size.height)/2) withAttributes:attrs];
    if (self.window.firstResponder==self) { [NSColor.keyboardFocusIndicatorColor setStroke]; shape.lineWidth=2; [shape stroke]; }
}
@end
@interface GPUMapTrafficOverlay : NSView
@property(nonatomic,weak) GPUMapView *owner;
@property(nonatomic) NSPoint downPoint;
@property(nonatomic,strong) NSScrollView *chips,*cards;
@property(nonatomic,strong) NSTextField *noticeLabel;
@property(nonatomic,strong) NSTimer *noticeTimer;
- (void)rebuildControls;
- (void)showTrafficNotice:(NSString *)notice;
@property(nonatomic,copy) NSString *notice;
@property(nonatomic,strong) NSDate *noticeUntil;
@property(nonatomic) NSTimeInterval lastControlsRebuild;
- (void)refreshControlsIfDue;
@end

@implementation GPUMapTrafficOverlay
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self rebuildControls]; }
- (NSView *)hitTest:(NSPoint)point {
    if (!self.owner.trafficEnabled) return nil;
    return [super hitTest:point];
}
- (CGFloat)scale { CGFloat scale=self.window.backingScaleFactor; return scale>1?scale:1; }
- (NSArray<NSDictionary *> *)displayAircraft {
    GPUMapView *owner=self.owner;
    if (owner.trafficIsNow) return TrafficVisibleAircraft(owner.trafficSnapshot,NSDate.date);
    if (owner.trafficHolding && owner.trafficHoldSnapshot && owner.trafficHoldDate && owner.trafficDate &&
        fabs([owner.trafficDate timeIntervalSinceDate:owner.trafficHoldDate])<.001)
        return TrafficVisibleAircraft(owner.trafficHoldSnapshot,owner.trafficHoldDate);
    return [owner.trafficSession aircraftAtDate:owner.trafficDate];
}
- (BOOL)projectAircraft:(NSDictionary *)aircraft point:(NSPoint *)point {
    GPUMapView *owner=self.owner; if (!owner) return NO;
    double x=0,y=0;
    if (!IsobarCameraProject(owner.camera,[aircraft[@"latitude"] doubleValue],[aircraft[@"longitude"] doubleValue],&x,&y)) return NO;
    if (point) *point=NSMakePoint(x/[self scale],y/[self scale]); return YES;
}
- (NSDictionary *)aircraftAtPoint:(NSPoint)point {
    NSArray *aircraftRows=[self displayAircraft];
    for (NSDictionary *aircraft in aircraftRows) {
        NSPoint projected; if ([self projectAircraft:aircraft point:&projected] &&
            NSPointInRect(point,NSInsetRect(NSMakeRect(projected.x-12,projected.y-12,24,24),-4,-4))) return aircraft;
    }
    return nil;
}
- (void)rebuildControls {
    self.lastControlsRebuild=NSDate.date.timeIntervalSinceReferenceDate;
    [self.chips removeFromSuperview]; [self.cards removeFromSuperview]; self.chips=nil; self.cards=nil;
    GPUMapView *owner=self.owner; NSArray *selected=owner.trafficSession.selectedHexes;
    if (!owner.trafficEnabled || !selected.count) return;
    CGFloat width=MIN(310,MAX(120,NSWidth(self.bounds)-64));
    self.chips=[[NSScrollView alloc] initWithFrame:NSMakeRect(10,8,width,30)];
    self.chips.drawsBackground=NO; self.chips.hasHorizontalScroller=YES; self.chips.autohidesScrollers=YES;
    GMTrafficContent *chips=[[GMTrafficContent alloc] initWithFrame:NSMakeRect(0,0,width,28)];
    CGFloat x=0;
    NSDateFormatter *clock=[NSDateFormatter new]; clock.timeZone=owner.trafficZone?:NSTimeZone.localTimeZone; clock.dateFormat=@"HH:mm";
    CGFloat cardsHeight=MIN(selected.count*72,MAX(48,MIN(230,NSHeight(self.bounds)*.45)));
    self.cards=[[NSScrollView alloc] initWithFrame:NSMakeRect(10,40,width,cardsHeight)];
    self.cards.hasVerticalScroller=YES; self.cards.autohidesScrollers=YES; self.cards.drawsBackground=YES;
    self.cards.backgroundColor=NSColor.controlBackgroundColor;
    GMTrafficContent *cards=[[GMTrafficContent alloc] initWithFrame:NSMakeRect(0,0,width,selected.count*72)];
    CGFloat y=0;
    for (NSString *hex in selected) {
        NSDictionary *a=[owner.trafficSession aircraftForHex:hex]?:@{};
        if (!owner.trafficIsNow) {
            a=@{};
            for (NSDictionary *sample in [self displayAircraft])
                if ([sample[@"hex"] isEqual:hex]) { a=sample; break; }
        }
        NSString *name=[a[@"callsign"] length]?a[@"callsign"]:hex;
        NSColor *colour=GMTrafficColour([owner.trafficSession colourIndexForHex:hex]);
        NSButton *chip=[GMTrafficChip buttonWithTitle:[name stringByAppendingString:@" ×"] target:self action:@selector(removeChip:)];
        chip.identifier=hex; chip.accessibilityLabel=[@"Remove " stringByAppendingString:name]; chip.font=[NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
        chip.bezelStyle=NSBezelStyleRounded; chip.contentTintColor=colour;
        CGFloat chipWidth=MAX(72,MIN(132,name.length*8+30)); chip.frame=NSMakeRect(x,0,chipWidth,28); [chips addSubview:chip]; x+=chipWidth+4;
        NSString *type=[a[@"type"] length]?a[@"type"]:@"—", *reg=[a[@"registration"] length]?a[@"registration"]:@"—";
        NSString *alt=a[@"pressureAltitudeFt"]?[NSString stringWithFormat:@"FL%03ld",lround([a[@"pressureAltitudeFt"] doubleValue]/100)]:@"—";
        NSString *trend=[a[@"verticalTrend"] isEqual:@"climb"]?@" ↑":[a[@"verticalTrend"] isEqual:@"descend"]?@" ↓":[a[@"verticalTrend"] isEqual:@"level"]?@" →":@"";
        NSString *speed=a[@"groundSpeedKt"]?[NSString stringWithFormat:@"%.0f kt",[a[@"groundSpeedKt"] doubleValue]]:@"— kt";
        NSString *squawk=[a[@"squawk"] length]?[@" · SQ " stringByAppendingString:a[@"squawk"]]:@"";
        NSDictionary *route=owner.trafficIsNow ? (owner.trafficRoutes[hex]?:owner.trafficRoutes[name]) : nil;
        NSString *origin=route[@"origin"][@"name"]?:route[@"origin"][@"icao"], *dest=route[@"destination"][@"name"]?:route[@"destination"][@"icao"];
        NSArray *points=[owner.trafficSession trackForHex:hex];
        NSString *span=owner.trafficIsNow && points.count?[NSString stringWithFormat:@"PAST %@–%@",[clock stringFromDate:points.firstObject[@"time"]],[clock stringFromDate:points.lastObject[@"time"]]]:(!owner.trafficIsNow && a.count)?[NSString stringWithFormat:@"REPLAY %@",[clock stringFromDate:owner.trafficDate]]:@"No recorded position";
        NSArray *lines=@[[NSString stringWithFormat:@"%@ · %@ · %@",name,type,reg],origin&&dest?[NSString stringWithFormat:@"%@ → %@",origin,dest]:@"Route —",[NSString stringWithFormat:@"%@%@ · %@%@",alt,trend,speed,squawk],span];
        for (NSUInteger i=0;i<lines.count;i++) {
            NSTextField *label=[NSTextField labelWithString:lines[i]];
            label.font=[NSFont monospacedDigitSystemFontOfSize:i==3?10:11 weight:i==0?NSFontWeightSemibold:NSFontWeightRegular];
            label.textColor=i==0?colour:NSColor.labelColor; label.frame=NSMakeRect(7,y+3+i*16,width-22,16);
            label.lineBreakMode=NSLineBreakByTruncatingTail; label.toolTip=lines[i]; [cards addSubview:label];
        }
        y+=72;
    }
    chips.frame=NSMakeRect(0,0,MAX(x,width),28); self.chips.documentView=chips; self.cards.documentView=cards;
    [self addSubview:self.chips]; [self addSubview:self.cards];
}
- (void)refreshControlsIfDue {
    NSTimeInterval now=NSDate.date.timeIntervalSinceReferenceDate;
    if (now-self.lastControlsRebuild>=0.2) [self rebuildControls];
}
- (void)removeChip:(NSButton *)sender {
    NSString *hex=sender.identifier; NSString *name=[self.owner.trafficSession aircraftForHex:hex][@"callsign"]?:hex;
    [self.owner.trafficSession removeSelectionForHex:hex]; [self rebuildControls];
    [self showTrafficNotice:[@"Removed " stringByAppendingString:name]];
    if (self.owner.onTrafficSelection) self.owner.onTrafficSelection(hex,NO);
    [self setNeedsDisplay:YES];
}
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect; GPUMapView *owner=self.owner; if (!owner || !owner.trafficEnabled) return;
    TrafficTrackSession *session=owner.trafficSession; CGFloat scale=[self scale];
    for (NSString *hex in session.selectedHexes) {
        NSArray *points=[session trackForHex:hex]; if (!points.count) continue;
        NSColor *colour=GMTrafficColour([session colourIndexForHex:hex]);
        NSDictionary *last=points.lastObject;
        NSDictionary *previous=nil; NSPoint previousPoint=NSZeroPoint;
        for (NSDictionary *point in points) {
            if (!owner.trafficIsNow && owner.trafficDate && [point[@"time"] compare:owner.trafficDate]==NSOrderedDescending) break;
            NSPoint projected; NSDictionary *geo=@{@"latitude":point[@"latitude"],@"longitude":point[@"longitude"]};
            if (![self projectAircraft:geo point:&projected]) { previous=nil; continue; }
            if (previous) {
                double gap=fabs([point[@"time"] timeIntervalSinceDate:previous[@"time"]]); double dlon=fabs([point[@"longitude"] doubleValue]-[previous[@"longitude"] doubleValue]);
                if (gap<=300 && dlon<180) { NSBezierPath *segment=[NSBezierPath bezierPath]; [segment moveToPoint:previousPoint]; [segment lineToPoint:projected]; [[colour colorWithAlphaComponent:.80] setStroke]; segment.lineWidth=1.5+MIN(45000,MAX(0,[point[@"pressureAltitudeFt"] doubleValue]))/15000; [segment stroke]; }
            }
            previous=point; previousPoint=projected;
        }
        NSDictionary *aircraft=[session aircraftForHex:hex]; NSDictionary *route=owner.trafficRoutes[hex]?:owner.trafficRoutes[aircraft[@"callsign"]]; NSDictionary *destination=owner.trafficIsNow && [route[@"destination"] isKindOfClass:NSDictionary.class]?route[@"destination"]:nil;
        if (destination[@"latitude"] && destination[@"longitude"] && last[@"latitude"] && last[@"longitude"]) {
            NSBezierPath *projection=[NSBezierPath bezierPath]; BOOL routeMoved=NO; NSPoint routePrevious=NSZeroPoint;
            for (NSUInteger i=0;i<=64;i++) {
                double lat=0,lon=0;
                GMGreatCircle([last[@"latitude"] doubleValue],[last[@"longitude"] doubleValue],[destination[@"latitude"] doubleValue],[destination[@"longitude"] doubleValue],i/64.0,&lat,&lon);
                NSPoint point; NSDictionary *geo=@{@"latitude":@(lat),@"longitude":@(lon)};
                if (![self projectAircraft:geo point:&point]) { routeMoved=NO; continue; }
                if (!routeMoved || fabs(point.x-routePrevious.x)>NSWidth(self.bounds)*.75) [projection moveToPoint:point];
                else [projection lineToPoint:point];
                routeMoved=YES; routePrevious=point;
            }
            CGFloat dash[]={5,4}; [projection setLineDash:dash count:2 phase:0]; [[colour colorWithAlphaComponent:.35] setStroke]; projection.lineWidth=1/scale; [projection stroke];
            NSPoint endpoint; NSDictionary *geo=@{@"latitude":destination[@"latitude"],@"longitude":destination[@"longitude"]}; if ([self projectAircraft:geo point:&endpoint]) { [[colour colorWithAlphaComponent:.7] setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(endpoint.x-3,endpoint.y-3,6,6)] fill]; GMText(destination[@"icao"]?:@"",NSMakeRect(endpoint.x+6,endpoint.y-12,48,14),10,colour); }
        }
    }
    NSArray *marks=[self displayAircraft];
    for (NSDictionary *aircraft in marks) {
            NSPoint point; if (![self projectAircraft:aircraft point:&point]) continue;
            BOOL selected=[session.selectedHexes containsObject:aircraft[@"hex"]];
            NSColor *colour=selected?GMTrafficColour([session colourIndexForHex:aircraft[@"hex"]]):[NSColor colorWithSRGBRed:.35 green:.40 blue:.45 alpha:.8];
            if (!aircraft[@"trackDegrees"]) { [colour setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(point.x-4,point.y-4,8,8)] fill]; continue; }
            NSBezierPath *glyph=[NSBezierPath bezierPath]; [glyph moveToPoint:NSMakePoint(point.x+9,point.y)];
            [glyph lineToPoint:NSMakePoint(point.x-7,point.y-6)]; [glyph lineToPoint:NSMakePoint(point.x-4,point.y)];
            [glyph lineToPoint:NSMakePoint(point.x-7,point.y+6)]; [glyph closePath];
            NSAffineTransform *rotation=[NSAffineTransform transform]; [rotation translateXBy:point.x yBy:point.y]; [rotation rotateByDegrees:[aircraft[@"trackDegrees"] doubleValue]-90]; [rotation translateXBy:-point.x yBy:-point.y]; [rotation concat]; [colour setFill]; [glyph fill]; [rotation invert]; [rotation concat];
    }
    if (owner.trafficEnabled && !owner.trafficIsNow)
        GMText(marks.count?@"Replay · captured traffic":@"Replay · No recorded traffic",NSMakeRect(10,NSHeight(self.bounds)-30,260,18),11,NSColor.secondaryLabelColor);
}
- (void)showTrafficNotice:(NSString *)notice {
    [self.noticeTimer invalidate];
    if (!self.noticeLabel) { self.noticeLabel=[NSTextField labelWithString:@""]; self.noticeLabel.font=[NSFont systemFontOfSize:11 weight:NSFontWeightMedium]; self.noticeLabel.backgroundColor=NSColor.controlBackgroundColor; self.noticeLabel.drawsBackground=YES; [self addSubview:self.noticeLabel]; }
    self.noticeLabel.stringValue=notice; self.noticeLabel.hidden=NO;
    self.noticeLabel.frame=NSMakeRect(10,MAX(8,NSHeight(self.bounds)-30),MIN(320,NSWidth(self.bounds)-20),22);
    __weak GPUMapTrafficOverlay *weak=self;
    self.noticeTimer=[NSTimer scheduledTimerWithTimeInterval:2.5 repeats:NO block:^(NSTimer *timer) { (void)timer; weak.noticeLabel.hidden=YES; }];
}
- (void)mouseDown:(NSEvent *)event { [self.owner.window makeFirstResponder:self.owner]; self.downPoint=[self convertPoint:event.locationInWindow fromView:nil]; [self.owner pointerDown:self.downPoint]; }
- (void)mouseDragged:(NSEvent *)event { [self.owner pointerDrag:[self convertPoint:event.locationInWindow fromView:nil]]; }
- (void)mouseUp:(NSEvent *)event {
    NSPoint point=[self convertPoint:event.locationInWindow fromView:nil];
    if (hypot(point.x-self.downPoint.x,point.y-self.downPoint.y)<=4) {
        NSDictionary *aircraft=[self aircraftAtPoint:point];
        if (aircraft) {
            NSString *hex=aircraft[@"hex"];
            if (![self.owner.trafficSession.selectedHexes containsObject:hex] && self.owner.trafficSession.selectedHexes.count>=8) {
                [self showTrafficNotice:@"8 aircraft selected"];
                [self.owner cancelPointerHold];
                return;
            }
            BOOL selected=[self.owner.trafficSession toggleSelectionForHex:hex];
            [self rebuildControls];
            [self showTrafficNotice:[NSString stringWithFormat:@"%@ %@",selected?@"Tracking":@"Removed",aircraft[@"callsign"]?:hex]];
            if (self.owner.onTrafficSelection) self.owner.onTrafficSelection(hex,selected);
            [self.owner cancelPointerHold];
            [self setNeedsDisplay:YES]; return;
        }
    }
    [self.owner pointerUp:point];
}
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode==53) { [self.owner.trafficSession clearSelections]; [self rebuildControls]; [self showTrafficNotice:@"Tracks cleared"]; return; }
    [self.owner keyDown:event];
}
@end

// Draws the hazard layer over the Metal map. Clicks and drags pass through.
@interface GPUMapHazardView : NSView
@property (nonatomic, strong) IsobarHazardFrame *hazardFrame;
@property (nonatomic, copy) NSArray<IsobarSigmet *> *sigmets;
@property (nonatomic, strong) NSDate *time;
@property (nonatomic) IsobarCamera camera;
@property (nonatomic) double pixelScale;
@property (nonatomic) BOOL dark;
@property (nonatomic, copy) NSArray<NSString *> *labels;
@property (nonatomic, copy) NSArray<NSValue *> *reserved;
@end
@implementation GPUMapHazardView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    CGContextRef c = NSGraphicsContext.currentContext.CGContext;
    double scale = self.pixelScale > 0 ? self.pixelScale : 1;
    CGContextSaveGState(c);
    CGContextScaleCTM(c, 1.0 / scale, 1.0 / scale);
    IsobarHazardDraw(c, self.hazardFrame, self.sigmets, self.time, self.camera, scale, self.dark, YES, self.reserved);
    self.labels = IsobarHazardLastLabels();
    CGContextRestoreGState(c);
}
@end

// ---- Place names --------------------------------------------------------
// Natural Earth populated places (Resources/world-places.json, public domain),
// most important first. A regional view names the towns around it, so a
// zoomed-in map says where it is (owner, 8 Oct: "zoomed in on Perth, it's a
// blank map").
static NSArray<NSArray *> *WorldPlaces(void) {
    static NSArray *places;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = NSProcessInfo.processInfo.environment[@"ISOBAR_WORLD_PLACES"];
        if (!path.length) path = [NSBundle.mainBundle pathForResource:@"world-places" ofType:@"json"];
        if (!path.length) path = @"Resources/world-places.json";
        NSData *data = [NSData dataWithContentsOfFile:path];
        id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        places = [json isKindOfClass:NSArray.class] ? json : @[];
    });
    return places;
}

typedef NSString *(^PlaceReading)(double latitude, double longitude);

// Draws into a y-down pixel context. `reading`, when set, is the active lens's
// value at each town ("16°", "SW 12 kt", "3 mm"); nil draws names only.
static NSArray<NSString *> *DrawPlaceNames(CGContextRef c, IsobarCamera cam, double scale, BOOL dark,
    NSArray<NSValue *> *avoid, PlaceReading reading) {
    double w = cam.viewportW, h = cam.viewportH;
    double lat0 = 0, lonL = 0, lat1 = 0, lonR = 0;
    if (!IsobarCameraUnproject(cam, 0, h * 0.5, &lat0, &lonL) ||
        !IsobarCameraUnproject(cam, w, h * 0.5, &lat1, &lonR)) return @[];
    double span = lonR - lonL;
    if (span <= 0) span += 360;
    if (!(span > 0) || span > 45) return @[];
    double rankLimit = log2(360.0 / span) + 1.5;
    NSMutableArray<NSValue *> *taken = [avoid mutableCopy] ?: [NSMutableArray array];
    NSMutableArray<NSString *> *drawn = [NSMutableArray array];
    NSMutableSet<NSString *> *shownNames = [NSMutableSet set];
    NSFont *major = [NSFont systemFontOfSize:12 * scale weight:NSFontWeightSemibold];
    NSFont *minor = [NSFont systemFontOfSize:11 * scale weight:NSFontWeightRegular];
    NSColor *ink = dark ? [NSColor colorWithWhite:.9 alpha:1] : [NSColor colorWithWhite:.16 alpha:1];
    NSColor *halo = dark ? [NSColor colorWithSRGBRed:.11 green:.14 blue:.2 alpha:.85] : [NSColor colorWithWhite:1 alpha:.85];
    NSGraphicsContext *previous = NSGraphicsContext.currentContext;
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithCGContext:c flipped:YES];
    for (NSArray *place in WorldPlaces()) {
        if (drawn.count >= 28) break;
        if (place.count < 4) continue;
        double rank = [place[3] doubleValue];
        if (rank > rankLimit) break;   // sorted by rank
        double x = 0, y = 0;
        if (!IsobarCameraProject(cam, [place[1] doubleValue], [place[2] doubleValue], &x, &y)) continue;
        if (x < 4 * scale || y < 4 * scale || x > w - 4 * scale || y > h - 4 * scale) continue;
        BOOL big = rank <= rankLimit - 1.5;
        NSDictionary *attrs = @{NSFontAttributeName: big ? major : minor, NSForegroundColorAttributeName: ink};
        NSString *name = place[0];
        // One label per name in view: places are ranked, so the first is the
        // better known (Vancouver BC over Vancouver WA beside Portland).
        if ([shownNames containsObject:name]) continue;
        NSString *value = reading ? reading([place[1] doubleValue], [place[2] doubleValue]) : nil;
        if (value.length) name = [NSString stringWithFormat:@"%@  %@", name, value];
        NSSize size = [name sizeWithAttributes:attrs];
        double r = (big ? 2.6 : 2.0) * scale;
        // The label tries the right, then the left. Only the label must be
        // clear: a town under the selected place's marker still gets its name.
        NSRect box = NSZeroRect, label = NSZeroRect;
        BOOL placed = NO;
        for (int side = 0; side < 4 && !placed; side++) {
            double lx = side == 1 ? x - r - 3 * scale - size.width : side == 0 ? x + r + 3 * scale : x - size.width * 0.5;
            double ly = side == 2 ? y - r - 2 * scale - size.height : side == 3 ? y + r + 2 * scale : y - size.height * 0.5;
            label = NSMakeRect(lx, ly, size.width, size.height);
            if (NSMinY(label) < 2 * scale || NSMaxY(label) > h - 2 * scale) continue;
            if (NSMinX(label) < 2 * scale || NSMaxX(label) > w - 2 * scale) continue;
            box = NSInsetRect(label, -4 * scale, -2 * scale);
            BOOL clash = NO;
            for (NSValue *v in taken) if (NSIntersectsRect(v.rectValue, box)) { clash = YES; break; }
            placed = !clash;
        }
        if (!placed) continue;
        [taken addObject:[NSValue valueWithRect:NSUnionRect(box, NSMakeRect(x - r, y - r, 2 * r, 2 * r))]];
        CGContextSetFillColorWithColor(c, halo.CGColor);
        CGContextFillEllipseInRect(c, CGRectMake(x - r - scale, y - r - scale, 2 * (r + scale), 2 * (r + scale)));
        CGContextSetFillColorWithColor(c, ink.CGColor);
        CGContextFillEllipseInRect(c, CGRectMake(x - r, y - r, 2 * r, 2 * r));
        NSMutableDictionary *haloAttrs = [attrs mutableCopy];
        haloAttrs[NSForegroundColorAttributeName] = halo;
        haloAttrs[NSStrokeColorAttributeName] = halo;
        haloAttrs[NSStrokeWidthAttributeName] = @(5.0);
        [name drawAtPoint:label.origin withAttributes:haloAttrs];
        [name drawAtPoint:label.origin withAttributes:attrs];
        [drawn addObject:name];
        [shownNames addObject:place[0]];
    }
    NSGraphicsContext.currentContext = previous;
    return drawn;
}

@interface GPUMapPlacesView : NSView
@property (nonatomic) IsobarCamera camera;
@property (nonatomic) double pixelScale;
@property (nonatomic) BOOL dark;
@property (nonatomic, copy) NSArray<NSValue *> *reserved;
@property (nonatomic, copy) NSArray<NSString *> *drawnNames;
@property (nonatomic, copy) PlaceReading reading;
@end
@implementation GPUMapPlacesView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    CGContextRef c = NSGraphicsContext.currentContext.CGContext;
    double scale = self.pixelScale > 0 ? self.pixelScale : 1;
    CGContextSaveGState(c);
    CGContextScaleCTM(c, 1.0 / scale, 1.0 / scale);
    self.drawnNames = DrawPlaceNames(c, self.camera, scale, self.dark, self.reserved, self.reading);
    CGContextRestoreGState(c);
}
@end

@implementation GPUMapView {
    id<MTLDevice> _device;
    id<MTLCommandQueue> _queue;
    IsobarFieldRenderer *_renderer;
    NSLock *_lock;
    dispatch_queue_t _uploads;
    CADisplayLink *_link;
    CFTimeInterval _lastStamp;
    IsobarGeoGrid _grid;
    NSInteger _steps;
    BOOL _gridReady;
    BOOL _hasField;
    NSInteger _generation;
    double _smoothDegrees;
    OwnRun *_run;
    OwnRunField _source;
    IsobarFieldKind _fill;
    double _downX, _downY, _dragLastX, _dragLastY, _grabLat, _grabLon;
    IsobarCamera _dragStartCamera, _dragLastCamera;
    BOOL _haveDragLastCamera;
    BOOL _autoNorthArmed, _autoNorthAnimating;
    double _autoNorthQuiet, _autoNorthElapsed, _autoNorthFrom;
    BOOL _grabbed, _dragging;
    BOOL _pointerHeld;
    BOOL _morphing;
    double _morphFrom, _morphTo, _morphT;
    double _tiltBaseZoom, _tiltAppliedZoom, _tiltAppliedPitch, _tiltGain;
    NSButton *_flatButton;
    NSSlider *_globeSlider;
    NSButton *_globeButton;
    NSButton *_northButton;
    NSButton *_recenterButton;
    NSVisualEffectView *_recenterBack;
    NSTextField *_plate;
    GPUMapDot *_marker;
    id<MTLTexture> _scratch;
    id<MTLCommandBuffer> _scratchBuffer;
    NSUInteger _timelineEpoch;
    double _stepFloor;
    float _dissolveMix;
    double _dissolveFrom, _dissolveTo;
    NSTimeInterval _lastSample;
    double _lastFrameMilliseconds;
    double _lastQueueWaitMilliseconds;
    BOOL _popoverChrome;
    BOOL _userMoved;
    BOOL _threeDMode;
    double _last3DGlobe;
    double _last3DBearing;
    double _fitW, _fitH;
    CAMetalLayer *_metal;
    NSUInteger _presentedCount;
    BOOL _presentedFrameBlank;
    BOOL _suppressPresentation;
    BOOL _sawOcclusionVisible;
    BOOL _inPresent;
    BOOL _watchdogArmed;
    GPUMapTrafficOverlay *_trafficOverlay;
    AtmosphereMapView *_atmosphereView;
    WindMapView *_windView;
    // Hazard layer.
    BOOL _hazards;
    NSString *_hazardStoreRoot;
    NSDictionary *_sigmetProduct;
    NSArray<IsobarSigmet *> *_sigmets;
    GPUMapHazardView *_hazardView;
    GPUMapPlacesView *_placesView;
    NSArray<NSString *> *_snapshotPlaceNames;
    double _namesStep;
    dispatch_queue_t _hazardQueue;
    IsobarHazardRun *_hazardRun;
    OwnRun *_hazardSource;
    NSArray<NSDate *> *_runTimes;
    NSUInteger _hazardGeneration;
    BOOL _hazardsReady;
    NSMutableDictionary<NSNumber *, IsobarHazardFrame *> *_hazardFrames;
    NSMutableArray<NSNumber *> *_hazardOrder;
    NSMutableSet<NSNumber *> *_hazardPending;
    long _hazardShownKey;
    IsobarCamera _hazardShownCamera;
    BOOL _hazardShownDark;
    NSString *_hazardShownValidity;
    double _lastHazardMilliseconds;
    NSTrackingArea *_hazardTracking;
    NSArray<NSString *> *_snapshotHazardLabels;
    long _hazardLastKey;
}

static const NSUInteger kGPUSyncContourCells = 160000;
static const double kKeyboardYawStep = 3.0 * M_PI / 180.0;
static const double kKeyboardArrowTiltStep = 3.0 * M_PI / 180.0;

static BOOL GridContoursOnMain(IsobarGeoGrid grid) {
    NSUInteger n = (NSUInteger)grid.nLon * (NSUInteger)grid.nLat;
    return n > 0 && n <= kGPUSyncContourCells;
}

+ (instancetype)mapView {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) return nil;
    GPUMapView *view = [[self alloc] initWithFrame:NSMakeRect(0, 0, 640, 480) device:device];
    return view;
}

- (instancetype)initWithFrame:(NSRect)frame device:(id<MTLDevice>)device {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    _device = device;
    _renderer = [[IsobarFieldRenderer alloc] initWithDevice:device];
    if (!_renderer) return nil;
    _smoothDegrees = _renderer.pressureSmoothDegrees;
    if (!(_smoothDegrees > 0)) _smoothDegrees = 0.3125;
    _renderer.pressureSmoothDegrees = 0;
    _renderer.synchronousContours = NO;
    _stepFloor = -INFINITY;
    _presentedFrameBlank = YES;
    _renderer.motion = [IsobarFieldMotion new];
    _queue = [device newCommandQueue];
    _lock = [NSLock new];
    _uploads = dispatch_queue_create("isobar.gpumap.uploads", DISPATCH_QUEUE_SERIAL);
    _hazardQueue = dispatch_queue_create("isobar.gpumap.hazards",
        dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0));
    _hazardFrames = [NSMutableDictionary dictionary];
    _hazardOrder = [NSMutableArray array];
    _hazardPending = [NSMutableSet set];
    _hazardShownKey = LONG_MIN;
    _fill = IsobarFieldPressure;
    _source = OwnRunFieldMSLP;
    _placeLatitude = NAN;
    _placeLongitude = NAN;
    _trafficSession = [TrafficTrackSession new];
    _camera = MapCameraMake(-33.87, 151.21, kGPUZoom, 0, 640, 480);
    _threeDMode = NO;
    _last3DGlobe = 1.0;
    _last3DBearing = 0;
    _metal = [CAMetalLayer layer];
    _metal.device = device;
    _metal.pixelFormat = MTLPixelFormatBGRA8Unorm;
    _metal.framebufferOnly = YES;
    // A blocking nextDrawable stalls the main thread and leaves the layer at
    // the window's white background. Nil means "skip this frame".
    _metal.allowsNextDrawableTimeout = YES;
    _metal.opaque = YES;
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (space) {
        _metal.colorspace = space;
        CGColorSpaceRelease(space);
    }
    OwnRGB sea = OwnChartSea();
    CGColorRef ocean = CGColorCreateSRGB(sea.r, sea.g, sea.b, 1);
    _metal.backgroundColor = ocean;
    CGColorRelease(ocean);
    self.wantsLayer = YES;
    // AppKit's default redraw copies the layer into a bitmap. A drawable-only
    // Metal layer has nothing to copy, so the on-screen map goes white while
    // renderTime snapshots still look fine.
    self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;
    self.accessibilityIdentifier = @"gpumap.surface";
    _trafficOverlay=[GPUMapTrafficOverlay new]; _trafficOverlay.owner=self;
    _trafficOverlay.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    _trafficOverlay.frame=self.bounds; [self addSubview:_trafficOverlay];
    _atmosphereView=[AtmosphereMapView new];
    _atmosphereView.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    _atmosphereView.frame=self.bounds; [self addSubview:_atmosphereView];
    _windView = [[WindMapView alloc] initWithFrame:self.bounds];
    _windView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    _windView.hidden = YES;
    [self addSubview:_windView];
    [self buildChrome];
    return self;
}

- (CALayer *)makeBackingLayer {
    return _metal ?: [CALayer layer];
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)ownsForecastTimer { return NO; }
- (void)setTrafficSnapshot:(NSDictionary *)trafficSnapshot {
    _trafficSnapshot=[trafficSnapshot copy];
    [self.trafficSession mergeSnapshot:_trafficSnapshot];
    [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES];
}
- (void)setTrafficSession:(TrafficTrackSession *)trafficSession { _trafficSession=trafficSession?:[TrafficTrackSession new]; [_trafficSession mergeSnapshot:_trafficSnapshot]; [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES]; }
- (void)setTrafficEnabled:(BOOL)trafficEnabled { if (_trafficEnabled==trafficEnabled) return; _trafficEnabled=trafficEnabled; _trafficOverlay.hidden=!trafficEnabled; [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES]; }
- (void)setTrafficIsNow:(BOOL)trafficIsNow {
    if (_trafficIsNow==trafficIsNow) return;
    if (trafficIsNow) {
        _trafficHoldSnapshot=nil; _trafficHoldDate=nil;
        if (_trafficSnapshot) [self.trafficSession mergeSnapshot:_trafficSnapshot];
    }
    _trafficIsNow=trafficIsNow;
    if (!trafficIsNow && _trafficEnabled) [_trafficOverlay showTrafficNotice:@"Traffic replay · recorded this session"];
    [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES];
}
- (void)setTrafficHolding:(BOOL)trafficHolding {
    if (_trafficHolding==trafficHolding) return;
    if (trafficHolding && _trafficIsNow && _trafficDate) {
        _trafficHoldSnapshot=[_trafficSnapshot copy]; _trafficHoldDate=[_trafficDate copy];
    } else { _trafficHoldSnapshot=nil; _trafficHoldDate=nil; }
    _trafficHolding=trafficHolding;
    [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES];
}
- (void)setTrafficDate:(NSDate *)trafficDate { if ([_trafficDate isEqualToDate:trafficDate]) return; _trafficDate=[trafficDate copy]; if (_trafficEnabled && !_trafficIsNow) [_trafficOverlay refreshControlsIfDue]; [_trafficOverlay setNeedsDisplay:YES]; }
- (void)setTrafficZone:(NSTimeZone *)trafficZone { if ([_trafficZone isEqual:trafficZone]) return; _trafficZone=trafficZone; [_trafficOverlay rebuildControls]; }
- (void)setTrafficRoutes:(NSDictionary *)trafficRoutes { _trafficRoutes=[trafficRoutes copy]; [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES]; }
- (void)showTrafficNotice:(NSString *)notice { [_trafficOverlay showTrafficNotice:notice]; }

- (CAMetalLayer *)metalLayer { return _metal; }

- (CGFloat)pixelScale {
    CGFloat scale = self.window.backingScaleFactor;
    return scale > 1 ? scale : 1;
}

- (BOOL)mapIsDark {
    NSAppearance *appearance = self.effectiveAppearance ?: NSApp.effectiveAppearance;
    NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[
        NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
    return [match isEqualToString:NSAppearanceNameDarkAqua];
}

- (void)syncChartAppearance {
    BOOL dark = [self mapIsDark];
    _renderer.chartDark = dark;
    if (!_metal) return;
    OwnRGB sea = OwnChartPaletteFor(dark).sea;
    CGColorRef ocean = CGColorCreateSRGB(sea.r, sea.g, sea.b, 1);
    _metal.backgroundColor = ocean;
    CGColorRelease(ocean);
}

- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    BOOL wasDark = _renderer.chartDark;
    [self syncChartAppearance];
    // A paused map draws no frames; repaint now so the plate follows the new appearance.
    if (_renderer.chartDark != wasDark) [self presentNow];
}

- (BOOL)reducedNow {
    if (self.reducedMotionOverride) return self.reducedMotionOverride.boolValue;
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}

- (NSPoint)pixels:(NSPoint)point {
    CGFloat scale = [self pixelScale];
    return NSMakePoint(point.x * scale, point.y * scale);
}

- (void)syncDrawable {
    CAMetalLayer *metal = self.metalLayer;
    CGFloat scale = [self pixelScale];
    metal.contentsScale = scale;
    CGSize size = CGSizeMake(round(self.bounds.size.width * scale), round(self.bounds.size.height * scale));
    if (size.width < 2) size.width = 2;
    if (size.height < 2) size.height = 2;
    if (size.width > 8192) size.width = 8192;
    if (size.height > 8192) size.height = 8192;
    metal.drawableSize = size;
    _renderer.pixelsPerPoint = scale;
}

- (void)syncViewport {
    [self syncDrawable];
    _camera.viewportW = self.metalLayer.drawableSize.width;
    _camera.viewportH = self.metalLayer.drawableSize.height;
    [self syncVectorOverlays];
}

- (void)stopRendering {
    [self cancelPointerHold];
    [_link invalidate];
    _link = nil;
    _lastStamp = 0;
    [self cancelPresentWatchdog];
}

// The Visible bit is often still clear on the first show of a menu-bar
// window, and for an ordered-in window that is simply off the desktop. Pausing
// on that bit meant the display link never started, so the layer stayed at the
// window background. Pause only after a window that has been on screen is
// covered. Snapshots never go through this path.
- (BOOL)windowWantsFrames {
    if (!self.window || self.hidden || self.isHiddenOrHasHiddenAncestor) return NO;
    if (!self.window.isVisible) return NO;
    BOOL occlusionVisible = (self.window.occlusionState & NSWindowOcclusionStateVisible) != 0;
    if (occlusionVisible) _sawOcclusionVisible = YES;
    if (_sawOcclusionVisible && !occlusionVisible) return NO;
    return YES;
}

- (void)cancelPresentWatchdog {
    _watchdogArmed = NO;
}

- (void)armPresentWatchdog {
    if (_watchdogArmed || !_gridReady || !_hasField || self.unavailable) return;
    if (!self.suppressPresentation && ![self windowWantsFrames]) return;
    _watchdogArmed = YES;
    NSUInteger ticket = _presentedCount;
    CFTimeInterval armed = CACurrentMediaTime();
    __weak GPUMapView *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        GPUMapView *strong = weak;
        if (!strong || !strong->_watchdogArmed || strong->_presentedCount != ticket) return;
        if (!strong.suppressPresentation && ![strong windowWantsFrames]) return;
        strong->_watchdogArmed = NO;
        // A late timer means the main thread was busy (a world field being
        // prepared), not that Metal failed. The display link had no chance to
        // present, so give it one before giving up on the GPU map.
        if (CACurrentMediaTime() - armed > 0.75) { [strong armPresentWatchdog]; return; }
        if (strong.onPresentFailed) strong.onPresentFailed();
    });
}

- (NSUInteger)presentedCount { return _presentedCount; }
- (BOOL)presentedFrameBlank { return _presentedFrameBlank; }
- (BOOL)suppressPresentation { return _suppressPresentation; }
- (void)setSuppressPresentation:(BOOL)suppressPresentation {
    _suppressPresentation = suppressPresentation;
    if (suppressPresentation) [self armPresentWatchdog];
}

- (void)presentNow {
    if (_inPresent || self.suppressPresentation) {
        if (self.suppressPresentation) [self armPresentWatchdog];
        return;
    }
    if (![self windowWantsFrames]) return;
    _inPresent = YES;
    NSTimeInterval now = self.timeline ? [self.timeline clockNow] : CACurrentMediaTime();
    [self displayAtTime:now];
    _inPresent = NO;
}

- (void)dealloc {
    [self cancelPointerHold];
    [_link invalidate];
}

- (void)updateLink {
    BOOL attached = self.window && !self.isHiddenOrHasHiddenAncestor;
    if (!attached) {
        [self stopRendering];
        return;
    }
    if (!_link) {
        _link = [self displayLinkWithTarget:self selector:@selector(onDisplay:)];
        [_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    }
    BOOL draw = [self windowWantsFrames];
    _link.paused = !draw;
    if (draw) [self presentNow];
    else [self cancelPresentWatchdog];
}

- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    [NSNotificationCenter.defaultCenter removeObserver:self name:NSWindowDidChangeOcclusionStateNotification object:nil];
    if (self.window) {
        [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(updateLink)
            name:NSWindowDidChangeOcclusionStateNotification object:self.window];
    }
    [self updateLink];
    [self syncDrawable];
    if (!self.window) [self cancelPointerHold];
}

- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    [self syncDrawable];
    [self presentNow];
}

- (void)setHidden:(BOOL)hidden {
    [super setHidden:hidden];
    [self updateLink];
}

- (void)setFrameSize:(NSSize)newSize {
    [super setFrameSize:newSize];
    [self layoutChrome];
    [self syncDrawable];
    [self placeMarker];
    // A drawableSize change discards the presented image. Draw now, or the
    // map is white until the next display callback — which does not come
    // while the link is paused.
    [self presentNow];
}

- (void)setCamera:(IsobarCamera)camera {
    _camera = camera;
    if (self.onCameraChanged) self.onCameraChanged(_camera);
    IsobarCamera overlayCamera = camera;
    overlayCamera.viewportW = NSWidth(self.bounds);
    overlayCamera.viewportH = NSHeight(self.bounds);
    _atmosphereView.camera = overlayCamera;
    [_atmosphereView setNeedsDisplay:YES];
    [self syncVectorOverlays];
}

- (void)syncVectorOverlays {
    IsobarCamera points = _camera;
    points.viewportW = NSWidth(self.bounds);
    points.viewportH = NSHeight(self.bounds);
    _atmosphereView.camera = points;
    _atmosphereView.date = self.atmosphereDate ?: self.timeline.playhead;
    _windView.camera = _camera;
    _windView.fractionalStep = _fractionalStep;
    _windView.chartDark = [self mapIsDark];
    [_windView setNeedsDisplay:YES];
    [_atmosphereView setNeedsDisplay:YES];
}

- (void)setWindBarbs:(BOOL)value {
    _windBarbs = value;
    _windView.hidden = !value;
    [self syncVectorOverlays];
}

- (void)setAtmosphereProduct:(NSDictionary *)product {
    _atmosphereProduct = [product copy];
    _atmosphereView.product = _atmosphereProduct;
    [_atmosphereView setNeedsDisplay:YES];
}

- (void)setAtmosphereLatitude:(double)latitude {
    _atmosphereLatitude = latitude;
    _atmosphereView.latitude = latitude;
    [_atmosphereView setNeedsDisplay:YES];
}

- (void)setAtmosphereLongitude:(double)longitude {
    _atmosphereLongitude = longitude;
    _atmosphereView.longitude = longitude;
    [_atmosphereView setNeedsDisplay:YES];
}

- (void)setAtmosphereDate:(NSDate *)date {
    _atmosphereDate = date;
    _atmosphereView.date = date;
    [_atmosphereView setNeedsDisplay:YES];
}

- (NSButton *)textButton:(NSString *)title action:(SEL)action identifier:(NSString *)identifier {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bordered = NO;
    button.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    button.accessibilityIdentifier = identifier;
    return button;
}

- (void)syncModeControls {
    if (!_flatButton || !_globeButton) return;
    _flatButton.state = _threeDMode ? NSControlStateValueOff : NSControlStateValueOn;
    _globeButton.state = _threeDMode ? NSControlStateValueOn : NSControlStateValueOff;
    _flatButton.contentTintColor = _threeDMode ? NSColor.labelColor : NSColor.controlAccentColor;
    _globeButton.contentTintColor = _threeDMode ? NSColor.controlAccentColor : NSColor.labelColor;
    _globeSlider.enabled = _threeDMode;
    _northButton.hidden = !_threeDMode;
}

- (void)buildChrome {
    _flatButton = [self textButton:@"2D" action:@selector(goFlat:) identifier:@"gpumap.flat"];
    [_flatButton setButtonType:NSButtonTypeToggle];
    _flatButton.accessibilityLabel = @"2D map";
    _flatButton.toolTip = @"2D map (2)";
    _globeSlider = [NSSlider sliderWithValue:0 minValue:0 maxValue:1 target:self action:@selector(globeSlid:)];
    _globeSlider.continuous = YES;
    _globeSlider.accessibilityIdentifier = @"gpumap.globe";
    _globeSlider.accessibilityLabel = @"Map tilt";
    _globeSlider.toolTip = @"Map tilt between overhead and globe";
    _globeButton = [self textButton:@"3D" action:@selector(goGlobe:) identifier:@"gpumap.sphere"];
    [_globeButton setButtonType:NSButtonTypeToggle];
    _globeButton.accessibilityLabel = @"3D map";
    _globeButton.toolTip = @"3D map (3) — two-finger swipe tilts";
    _northButton = [self textButton:@"N" action:@selector(northUp:) identifier:@"gpumap.northup"];
    _northButton.image = [NSImage imageWithSystemSymbolName:@"location.north.fill" accessibilityDescription:@"North up"];
    _northButton.symbolConfiguration = [NSImageSymbolConfiguration configurationWithPointSize:13 weight:NSFontWeightMedium];
    _northButton.imagePosition = NSImageLeading;
    _northButton.imageScaling = NSImageScaleProportionallyDown;
    _northButton.accessibilityLabel = @"North up";
    _northButton.toolTip = @"North up (N)";
    // The map's own control: a location glyph on a material tile, top right,
    // as in Maps. The words live in the tooltip and accessibility label.
    _recenterButton = [self textButton:@"" action:@selector(recenter) identifier:@"gpumap.recenter"];
    _recenterButton.image = [NSImage imageWithSystemSymbolName:@"location.fill" accessibilityDescription:@"Recenter"];
    _recenterButton.symbolConfiguration = [NSImageSymbolConfiguration configurationWithPointSize:14 weight:NSFontWeightMedium];
    _recenterButton.imagePosition = NSImageOnly;
    _recenterButton.contentTintColor = NSColor.controlAccentColor;
    _recenterButton.accessibilityLabel = @"Recenter";
    _recenterButton.toolTip = @"Recenter";
    _recenterBack = [NSVisualEffectView new];
    _recenterBack.material = NSVisualEffectMaterialMenu;
    _recenterBack.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    _recenterBack.state = NSVisualEffectStateActive;
    _recenterBack.wantsLayer = YES;
    _recenterBack.layer.cornerRadius = 6;
    _recenterBack.layer.masksToBounds = YES;
    _plate = [NSTextField labelWithString:@"Chart unavailable"];
    _plate.alignment = NSTextAlignmentCenter;
    _plate.font = [NSFont systemFontOfSize:15 weight:NSFontWeightMedium];
    _plate.textColor = NSColor.secondaryLabelColor;
    _plate.drawsBackground = YES;
    _plate.backgroundColor = NSColor.windowBackgroundColor;
    _plate.hidden = YES;
    _plate.accessibilityIdentifier = @"gpumap.unavailable";
    _placesView = [[GPUMapPlacesView alloc] initWithFrame:self.bounds];
    _placesView.wantsLayer = YES;
    _placesView.accessibilityIdentifier = @"gpumap.places";
    [self addSubview:_placesView];
    _hazardView = [[GPUMapHazardView alloc] initWithFrame:self.bounds];
    _hazardView.hidden = YES;
    _hazardView.wantsLayer = YES;
    _hazardView.accessibilityIdentifier = @"gpumap.hazards";
    [self addSubview:_hazardView];
    _marker = [GPUMapDot new];
    _marker.accessibilityIdentifier = @"gpumap.marker";
    _marker.hidden = YES;
    for (NSView *view in @[_plate, _marker, _flatButton, _globeSlider, _globeButton, _northButton, _recenterBack, _recenterButton])
        [self addSubview:view];
    [self syncModeControls];
    [self layoutChrome];
}

- (void)bringChromeFront {
    for (NSView *view in @[_windView, _hazardView, _placesView, _trafficOverlay, _atmosphereView, _marker, _flatButton, _globeSlider, _globeButton, _northButton, _recenterBack, _recenterButton])
        [self addSubview:view];
}

- (void)layoutChrome {
    NSRect bounds = self.bounds;
    if (!NSEqualSizes(_trafficOverlay.frame.size,bounds.size)) { _trafficOverlay.frame=bounds; [_trafficOverlay rebuildControls]; }
    _atmosphereView.frame = bounds;
    _windView.frame = bounds;
    _plate.frame = bounds;
    _hazardView.frame = bounds;
    _placesView.frame = bounds;
    CGFloat y = 8;
    BOOL globe = YES;
    _flatButton.hidden = !globe;
    _globeSlider.hidden = !globe || _popoverChrome;
    _globeButton.hidden = !globe;
    _flatButton.frame = NSMakeRect(8, y, 32, 24);
    _globeSlider.frame = NSMakeRect(44, y, MIN(140, MAX(60, NSWidth(bounds) - 280)), 24);
    _globeButton.frame = NSMakeRect(NSMaxX(_globeSlider.frame) + 4, y, 32, 24);
    _northButton.frame = NSMakeRect(NSMaxX(_globeButton.frame) + 4, y, 38, 24);
    if (_popoverChrome) {
        _flatButton.frame = NSMakeRect(8, y, 32, 24);
        _globeButton.frame = NSMakeRect(44, y, 32, 24);
        _northButton.frame = NSMakeRect(80, y, 38, 24);
    }
    _recenterButton.hidden = _popoverChrome && !_userMoved;
    _recenterButton.frame = NSMakeRect(NSWidth(bounds) - 8 - 28, y, 28, 28);
    _recenterBack.frame = _recenterButton.frame;
    _recenterBack.hidden = _recenterButton.hidden;
    [self syncModeControls];
    [self bringChromeFront];
}

- (void)setPopoverChrome:(BOOL)popoverChrome {
    _popoverChrome = popoverChrome;
    _metal.cornerRadius = popoverChrome ? 10 : 0;
    _metal.masksToBounds = popoverChrome;
    [self layoutChrome];
}

- (BOOL)popoverChrome { return _popoverChrome; }
- (BOOL)userMovedMap { return _userMoved; }

- (void)noteUserMoved {
    // The expanded window's zoom and pan share this view. They must not block
    // the popover from framing Australia when it opens.
    if (!_popoverChrome || _userMoved) return;
    _userMoved = YES;
    [self layoutChrome];
}

- (void)noteGridContours {
    _renderer.synchronousContours = GridContoursOnMain(_grid);
}

- (BOOL)contoursAreSynchronous { return _renderer.synchronousContours; }

// Mainland Australia, Cape York and Tasmania, with a modest margin of sea.
// A box that reached the equator left New Guinea and Indonesia filling the
// popover. Extra space from the view's aspect is split around that box. A
// frame taller than the grid zooms in and keeps Perth and Cape York on screen.
// The visible window stays inside the data grid. Called with the viewport set.
- (void)fitAustraliaCoverage {
    double south = -45.6, north = -9.0, west = 111.0, east = 156.0;
    if (isfinite(_placeLatitude) && isfinite(_placeLongitude)) {
        if (_placeLatitude < south) south = _placeLatitude - 0.6;
        if (_placeLatitude > north) north = _placeLatitude + 0.6;
        if (_placeLongitude < west) west = _placeLongitude - 0.8;
        if (_placeLongitude > east) east = _placeLongitude + 0.8;
    }
    double covW = 95, covE = 170, covN = 0, covS = -50;
    BOOL global = NO;
    [_lock lock];
    global = _gridReady && _grid.wrapsLongitude && _grid.nLon > 1 && _grid.nLat > 1 && _grid.step > 0;
    if (_gridReady && !global && _grid.nLon > 1 && _grid.nLat > 1 && _grid.step > 0) {
        covW = _grid.west;
        covN = _grid.north;
        covE = _grid.west + (_grid.nLon - 1) * _grid.step;
        covS = _grid.north - (_grid.nLat - 1) * _grid.step;
    }
    [_lock unlock];
    if (south < covS) south = covS;
    if (north > covN) north = covN;
    if (west < covW) west = covW;
    if (east > covE) east = covE;
    if (!(north > south + 0.5)) { south = covS; north = covN; }
    if (!(east > west + 0.5)) { west = covW; east = covE; }
    double boxLat = north - south, boxLon = east - west;
    if (boxLat < 1) boxLat = 1;
    if (boxLon < 1) boxLon = 1;
    double lat = (south + north) * 0.5;
    double lon = (west + east) * 0.5;
    double vw = _camera.viewportW, vh = _camera.viewportH;
    if (!(vw >= 2) || !(vh >= 2)) return;
    if (global) {
        // A wrapping grid covers the whole earth. The regional fitting rules
        // below deliberately clamp to Australia, which would push London,
        // New York, or a dateline place out of frame.
        double placeLat = isfinite(_placeLatitude) ? _placeLatitude : 0;
        double placeLon = isfinite(_placeLongitude) ? _placeLongitude : 0;
        if (placeLat < -82) placeLat = -82;
        if (placeLat > 82) placeLat = 82;
        double boxLat = 50, boxLon = 90;
        double cosLat = cos(placeLat * 0.017453292519943295);
        if (cosLat < 0.2) cosLat = 0.2;
        double lonPerLat = (vw / vh) / cosLat;
        if (boxLon / boxLat < lonPerLat) boxLon = boxLat * lonPerLat;
        else boxLat = boxLon / lonPerLat;
        double fit = fmin(vw / 360.0, vh / 180.0);
        double zoom = fit > 0 ? (vh / boxLat) / fit : 1;
        _camera = MapCameraMake(placeLat, placeLon, zoom, _camera.globe, vw, vh);
        _camera = IsobarCameraClamp(_camera);
        return;
    }
    double cosLat = cos(lat * 0.017453292519943295);
    if (cosLat < 0.2) cosLat = 0.2;
    double lonPerLat = (vw / vh) / cosLat;
    if (lonPerLat < 0.05) lonPerLat = 0.05;
    double winLat = boxLat, winLon = boxLon;
    if (boxLon / boxLat < lonPerLat) winLon = boxLat * lonPerLat;
    else winLat = boxLon / lonPerLat;
    double roomLat = covN - covS, roomLon = covE - covW;
    if (roomLat < 1) roomLat = 1;
    if (roomLon < 1) roomLon = 1;
    if (winLat > roomLat) {
        winLat = roomLat;
        winLon = winLat * lonPerLat;
    }
    if (winLon > roomLon) {
        winLon = roomLon;
        winLat = winLon / lonPerLat;
        if (winLat > roomLat) winLat = roomLat;
    }
    double winS = lat - winLat * 0.5;
    double winW = lon - winLon * 0.5;
    if (winS < covS) winS = covS;
    if (winS + winLat > covN) winS = covN - winLat;
    if (winS < covS) winS = covS;
    if (winW < covW) winW = covW;
    if (winW + winLon > covE) winW = covE - winLon;
    if (winW < covW) winW = covW;
    // A cropped window still holds Perth and Cape York when both fit.
    double perth = 115.86, cape = 142.53, margin = 1.2;
    if (winLon > (cape - perth) + margin * 2.0) {
        if (winW > perth - margin) winW = perth - margin;
        if (winW + winLon < cape + margin) winW = cape + margin - winLon;
        if (winW < covW) winW = covW;
        if (winW + winLon > covE) winW = covE - winLon;
        if (winW < covW) winW = covW;
    }
    double centreLat = winS + winLat * 0.5;
    double centreLon = winW + winLon * 0.5;
    double fit = fmin(vw / 360.0, vh / 180.0);
    double zoom = fit > 0 ? (vh / winLat) / fit : 1;
    double pitch = _camera.pitch;
    _camera = MapCameraMake(centreLat, centreLon, zoom, _camera.globe, vw, vh);
    _camera.pitch = pitch;
    _camera = IsobarCameraClamp(_camera);
    double edgeLat = 0, edgeLon = 0, topLat = 0, topLon = 0;
    if (IsobarCameraUnproject(_camera, vw * 0.5, vh - 0.5, &edgeLat, &edgeLon) &&
        IsobarCameraUnproject(_camera, vw * 0.5, 0.5, &topLat, &topLon) &&
        (edgeLat < covS || topLat > covN)) {
        double span = covN - covS;
        double vis = topLat - edgeLat;
        if (span > 1 && vis > span) {
            _camera.zoom *= vis / span;
            _camera = IsobarCameraClamp(_camera);
            IsobarCameraUnproject(_camera, vw * 0.5, vh - 0.5, &edgeLat, &edgeLon);
            IsobarCameraUnproject(_camera, vw * 0.5, 0.5, &topLat, &topLon);
        }
        if (edgeLat < covS) _camera.centreLat += covS - edgeLat;
        if (topLat > covN) _camera.centreLat -= topLat - covN;
        _camera = IsobarCameraClamp(_camera);
    }
}

// The bottom 12 viewport rows are the band that read as a beige plate when the
// camera was left on an earlier zoom. Latitude there has to stay on the grid.
- (BOOL)southBandOutsideCoverage {
    [_lock lock];
    BOOL ready = _gridReady && !_grid.wrapsLongitude && _grid.nLat >= 2 && _grid.step > 0;
    double covS = ready ? _grid.north - (_grid.nLat - 1) * _grid.step : 0;
    double covN = ready ? _grid.north : 0;
    [_lock unlock];
    if (!ready) return NO;
    if (!(_camera.viewportW >= 2) || !(_camera.viewportH >= 2)) return NO;
    double y = _camera.viewportH - 12.0;
    if (y < 0.5) y = 0.5;
    double bandLat = 0, bandLon = 0, edgeLat = 0, edgeLon = 0;
    if (!IsobarCameraUnproject(_camera, _camera.viewportW * 0.5, y, &bandLat, &bandLon)) return YES;
    if (!IsobarCameraUnproject(_camera, _camera.viewportW * 0.5, _camera.viewportH - 0.5, &edgeLat, &edgeLon))
        return YES;
    return bandLat < covS + 0.02 || edgeLat < covS - 0.02 || bandLat > covN + 0.02;
}

- (void)refitPopoverIfNeeded {
    if (!_popoverChrome || _userMoved) return;
    BOOL sizeChanged = fabs(_camera.viewportW - _fitW) > 0.5 || fabs(_camera.viewportH - _fitH) > 0.5;
    if (!sizeChanged && ![self southBandOutsideCoverage]) return;
    [self fitAustraliaCoverage];
    _fitW = _camera.viewportW;
    _fitH = _camera.viewportH;
}

- (void)frameAustralia {
    [self syncViewport];
    [self fitAustraliaCoverage];
    _fitW = _camera.viewportW;
    _fitH = _camera.viewportH;
    [self syncSlider];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
    [self layoutChrome];
}

- (void)setStale:(BOOL)stale {
    _stale = stale;
}

- (void)setUnavailable:(BOOL)unavailable {
    _unavailable = unavailable;
    _plate.hidden = !unavailable;
    // A hidden plate must not keep the failure words, or a readable chart
    // still looks unavailable to the popover's text search.
    _plate.stringValue = unavailable ? @"Chart unavailable" : @"";
    if (unavailable) _hazardView.hidden = YES;
    if (unavailable) [self bringChromeFront];
}

- (void)syncSlider {
    if (!_globeSlider) return;
    _globeSlider.doubleValue = _camera.globe;
}

- (NSArray<NSValue *> *)placeReservedRects {
    // The selected place's marker and the map's own controls, in pixels.
    double scale = [self pixelScale];
    NSMutableArray *rects = [NSMutableArray array];
    for (NSView *view in @[_marker, _recenterButton, _flatButton, _globeSlider, _globeButton, _northButton]) {
        if (!view || view.hidden) continue;
        NSRect f = view == _marker ? NSInsetRect(view.frame, 2, 2) : NSInsetRect(view.frame, -4, -4);
        [rects addObject:[NSValue valueWithRect:NSMakeRect(f.origin.x * scale, f.origin.y * scale,
            f.size.width * scale, f.size.height * scale)]];
    }
    return rects;
}

// The active lens's value at a town, sampled from the run at the playhead:
// Temp → "16°", Wind (Kite, Surf) → "SW 12 kt", Rain → "3 mm" (dry shows
// nothing). Pressure and Fly name the towns only.
- (PlaceReading)placeReading {
    OwnRun *run = _run;
    OwnRunField field = _source;
    double hour = _fractionalStep;
    if (!run || field == OwnRunFieldMSLP || !isfinite(hour)) return nil;
    OwnRunGeo g = [run geo];
    if (!(g.step > 0) || g.nLon < 1 || g.nLat < 1) return nil;
    return ^NSString *(double lat, double lon) {
        int i = (int)llround((lon - g.west) / g.step), j = (int)llround((g.north - lat) / g.step);
        if (g.wrapsLongitude) i = ((i % g.nLon) + g.nLon) % g.nLon;
        if (i < 0 || j < 0 || i >= g.nLon || j >= g.nLat) return nil;
        NSInteger index = (NSInteger)j * g.nLon + i;
        double v = [run valueAtPointIndex:index field:field fractionalHour:hour];
        if (!isfinite(v)) return nil;
        if (field == OwnRunFieldRain) return v >= 0.2 ? [NSString stringWithFormat:@"%.0f mm", fmax(1, round(v))] : nil;
        if (field == OwnRunFieldWindSpeed) {
            double from = [run valueAtPointIndex:index field:OwnRunFieldWindDirection fractionalHour:hour];
            static NSString *const points[] = {@"N", @"NE", @"E", @"SE", @"S", @"SW", @"W", @"NW"};
            NSString *dir = isfinite(from) ? points[((int)llround(fmod(from + 360.0, 360.0) / 45.0)) % 8] : @"";
            return [NSString stringWithFormat:@"%@ %.0f kt", dir, v];
        }
        return [NSString stringWithFormat:@"%.0f°", v];
    };
}

- (void)setFractionalStep:(double)fractionalStep {
    _fractionalStep = fractionalStep;
    [self syncVectorOverlays];
    _dissolveMix = 0;
    // Scrubbing and paused seeks set the step here, not through the timeline.
    if (_source != OwnRunFieldMSLP && _placesView && !_placesView.hidden && fabs(fractionalStep - _namesStep) > 0.06)
        [self updatePlaceNames];
}

- (void)updatePlaceNames {
    if (!_placesView) return;
    _placesView.reading = [self placeReading];
    _namesStep = _fractionalStep;
    _placesView.hidden = self.unavailable;
    _placesView.camera = _camera;
    _placesView.pixelScale = [self pixelScale];
    _placesView.dark = [self mapIsDark];
    _placesView.reserved = [self placeReservedRects];
    [_placesView setNeedsDisplay:YES];
}

- (NSArray<NSString *> *)placeNamesShown { return _placesView.drawnNames ?: @[]; }

- (void)placeMarker {
    [self updatePlaceNames];
    if (!isfinite(_placeLatitude) || !isfinite(_placeLongitude)) {
        _marker.hidden = YES;
        return;
    }
    [self syncViewport];
    double x = 0, y = 0;
    if (!IsobarCameraProject(_camera, _placeLatitude, _placeLongitude, &x, &y)) {
        _marker.hidden = YES;
        return;
    }
    CGFloat scale = [self pixelScale];
    _marker.hidden = NO;
    _marker.frame = NSMakeRect(x / scale - 7, y / scale - 7, 14, 14);
    [_trafficOverlay setNeedsDisplay:YES];
    [self updatePlaceNames];
}


- (NSRect)placeMarkerFrame { return _marker.frame; }

- (void)setPlaceLatitude:(double)latitude longitude:(double)longitude {
    _placeLatitude = latitude;
    _placeLongitude = longitude;
    [self placeMarker];
}

- (void)recenter {
    if (_popoverChrome) {
        _userMoved = NO;
        self.didPlaceCamera = YES;
        [self frameAustralia];
        return;
    }
    if (!isfinite(_placeLatitude) || !isfinite(_placeLongitude)) return;
    _camera.centreLat = _placeLatitude;
    _camera.centreLon = _placeLongitude;
    _camera.zoom = kGPUZoom;
    [self syncViewport];
    _camera = IsobarCameraClamp(_camera);
    self.didPlaceCamera = YES;
    _userMoved = NO;
    [self syncSlider];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
    [self layoutChrome];
}

- (void)resetZoom {
    _camera.zoom = kGPUZoom;
    [self syncViewport];
    _camera = IsobarCameraClamp(_camera);
    [self noteUserMoved];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
}

- (void)applyBudget {
    NSUInteger n = (NSUInteger)_grid.nLon * (NSUInteger)_grid.nLat;
    if (n == 0 || _steps < 1) return;
    NSUInteger sample = n * sizeof(float);
    NSUInteger pressure = sample * 2;
    NSUInteger colour = _fill == IsobarFieldRain ? sample * 2 : sample;
    NSUInteger extra = _fill == IsobarFieldPressure ? 0 : colour;
    _renderer.residentByteBudget = (pressure + extra) * (NSUInteger)_steps;
}

- (void)installGrid:(IsobarGeoGrid)grid steps:(NSInteger)steps {
    [_lock lock];
    [_renderer setGrid:grid];
    _grid = grid;
    _steps = steps;
    _gridReady = YES;
    _fill = IsobarFieldPressure;
    [self applyBudget];
    [self noteGridContours];
    [_lock unlock];
}

// The classic chart smooths pressure by 1.25 grid cells. A fixed 0.3125° is
// that width on the 0.25° Australian grid and a no-op on the 1° fixture.
- (double)pressureSmoothSigma {
    if (_grid.step > 0) return 1.25 * _grid.step;
    return _smoothDegrees > 0 ? _smoothDegrees : 0.3125;
}

- (BOOL)uploadStep:(NSInteger)step kind:(IsobarFieldKind)kind values:(const float *)values error:(NSError **)error {
    if (!_gridReady || !values || step < 0) return NO;
    size_t n = (size_t)_grid.nLon * (size_t)_grid.nLat;
    float *copy = malloc(n * sizeof(float));
    if (!copy) return NO;
    memcpy(copy, values, n * sizeof(float));
    if (kind == IsobarFieldPressure && _smoothDegrees > 0)
        IsobarSmoothPressure(copy, _grid, [self pressureSmoothSigma]);
    [_lock lock];
    BOOL ok = [_renderer uploadStep:step kind:kind values:copy error:error];
    if (ok) _hasField = YES;
    [_lock unlock];
    free(copy);
    return ok;
}

- (void)waitForUploads {
    if (!_uploads) return;
    dispatch_sync(_uploads, ^{});
}

- (void)copySamples:(float *)values count:(size_t)n run:(OwnRun *)run field:(OwnRunField)field step:(NSInteger)step {
    for (size_t i = 0; i < n; i++) {
        double sample = [run valueAtPointIndex:(NSInteger)i field:field hour:step];
        values[i] = isfinite(sample) ? (float)sample : NAN;
    }
}

- (void)uploadRun:(OwnRun *)run grid:(IsobarGeoGrid)grid steps:(NSInteger)steps
           source:(OwnRunField)source fill:(IsobarFieldKind)fill generation:(NSInteger)generation {
    [_lock lock];
    BOOL current = generation == _generation;
    if (current) {
        [_renderer setGrid:grid];
        _grid = grid;
        _steps = steps;
        _fill = fill;
        _gridReady = YES;
        _fitW = 0;
        _fitH = 0;
        [self applyBudget];
        [self noteGridContours];
    }
    [_lock unlock];
    if (!current) return;
    size_t n = (size_t)grid.nLon * (size_t)grid.nLat;
    for (NSInteger step = 0; step < steps; step++) {
        [_lock lock];
        current = generation == _generation;
        [_lock unlock];
        if (!current) return;
        float *pressure = malloc(n * sizeof(float));
        if (!pressure) return;
        [self copySamples:pressure count:n run:run field:OwnRunFieldMSLP step:step];
        if (_smoothDegrees > 0) IsobarSmoothPressure(pressure, grid, [self pressureSmoothSigma]);
        [_lock lock];
        NSError *error = nil;
        BOOL ok = generation == _generation &&
            [_renderer uploadStep:step kind:IsobarFieldPressure values:pressure error:&error];
        [_lock unlock];
        free(pressure);
        if (!ok) return;
        if (fill == IsobarFieldPressure) continue;
        float *colour = malloc(n * sizeof(float));
        if (!colour) return;
        [self copySamples:colour count:n run:run field:source step:step];
        [_lock lock];
        ok = generation == _generation &&
            [_renderer uploadStep:step kind:fill values:colour error:&error];
        [_lock unlock];
        free(colour);
        if (!ok) return;
    }
    [_lock lock];
    if (generation == _generation) _hasField = YES;
    [_lock unlock];
}

- (void)adoptRun:(OwnRun *)run temperature:(int)temperature windFill:(BOOL)windFill rain:(BOOL)rain {
    IsobarFieldKind fill = IsobarFieldPressure;
    OwnRunField source = OwnRunFieldMSLP;
    if (rain) {
        fill = IsobarFieldRain;
        source = OwnRunFieldRain;
    } else if (windFill) {
        fill = IsobarFieldWindSpeed;
        source = OwnRunFieldWindSpeed;
    } else if (temperature == 1) {
        fill = IsobarFieldTemperature;
        source = OwnRunFieldT850;
    } else if (temperature == 2) {
        fill = IsobarFieldTemperature;
        source = OwnRunFieldT2M;
    }
    if (run && run == _run && source == _source && fill == _fill && _gridReady) return;
    _run = run;
    _windView.run = run;
    [self syncVectorOverlays];
    _source = source;
    _fill = fill;
    [self loadHazardsIfNeeded];
    if (!run || run.hours < 1) {
        if (!_hasField) self.unavailable = YES;
        return;
    }
    OwnRunGeo geo = [run geo];
    if (geo.nLon < 2 || geo.nLat < 2 || !(geo.step > 0)) {
        if (_hasField) self.stale = YES;
        else self.unavailable = YES;
        return;
    }
    self.unavailable = NO;
    IsobarGeoGrid grid = {
        .west = geo.west, .north = geo.north, .step = geo.step,
        .nLon = geo.nLon, .nLat = geo.nLat, .wrapsLongitude = geo.wrapsLongitude
    };
    [_lock lock];
    NSInteger generation = ++_generation;
    [_lock unlock];
    OwnRun *kept = run;
    NSInteger steps = run.hours;
    dispatch_async(_uploads, ^{
        [self uploadRun:kept grid:grid steps:steps source:source fill:fill generation:generation];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (generation != self->_generation) return;
            [self presentNow];
        });
    });
}

// Dolly toward the atmospheric detail as the view lowers. Ratios preserve an
// independent pinch zoom, and reversing tilt removes only the automatic dolly.
- (void)applyPitch:(double)pitch globe:(double)globe {
    if (!(_tiltBaseZoom > 0) || _camera.pitch <= 1e-7) {
        _tiltBaseZoom = _camera.zoom;
        double fit = fmin(_camera.viewportW / 360.0, _camera.viewportH / 180.0);
        double halfLat = fit > 0 ? _camera.viewportH * .5 / (_tiltBaseZoom * fit) : 90;
        _tiltGain = 1.0 + (fmin(8.0, fmax(1.0, halfLat / .12)) - 1.0) / (1.0 + pow(halfLat / 6.0, 2.0));
    } else if (_camera.zoom != _tiltAppliedZoom || _camera.pitch != _tiltAppliedPitch) {
        double oldScale = 1.0 + (_tiltGain - 1.0) * pow(sin(_camera.pitch), 2.0);
        _tiltBaseZoom = _camera.zoom / oldScale;
    }
    double newScale = 1.0 + (_tiltGain - 1.0) * pow(sin(pitch), 2.0);
    _camera.zoom = _tiltBaseZoom * newScale;
    _camera.pitch = pitch;
    _camera.globe = globe;
    _tiltAppliedZoom = IsobarCameraClamp(_camera).zoom;
    _tiltAppliedPitch = pitch;
}

- (void)animateGlobeTo:(double)target reducedMotion:(BOOL)reduced {
    if (target < 0) target = 0;
    if (target > 1) target = 1;
    if (reduced || fabs(target - _camera.globe) < 1e-6) {
        [self applyPitch:target * kFullTiltPitch globe:target];
        _morphing = NO;
        [self syncViewport];
        _camera = IsobarCameraClamp(_camera);
        [self syncSlider];
        [self syncModeControls];
        [self placeMarker];
        if (self.onCameraChanged) self.onCameraChanged(_camera);
        return;
    }
    _morphFrom = _camera.globe;
    _morphTo = target;
    _morphT = 0;
    _morphing = YES;
}

- (BOOL)handleGlobeKey:(NSString *)characters repeat:(BOOL)repeat {
    if (characters.length != 1) return NO;
    unichar ch = [characters characterAtIndex:0];
    if (ch != '2' && ch != '3') return NO;
    if (repeat) return NO;
    if (ch == '3') [self goGlobe:nil];
    else [self goFlat:nil];
    return YES;
}

- (void)northUp:(id)sender {
    (void)sender;
    if (!_threeDMode) return;
    [self cancelAutoNorth];
    _morphing = NO;
    IsobarCamera next = _camera;
    next.bearing = 0;
    _last3DBearing = 0;
    _dragStartCamera = next;
    _dragLastCamera = next;
    _downX = _dragLastX;
    _downY = _dragLastY;
    _haveDragLastCamera = YES;
    [self commitKeyboardCamera:next];
}

- (void)cancelAutoNorth {
    _autoNorthArmed = NO;
    _autoNorthAnimating = NO;
    _autoNorthQuiet = 0;
    _autoNorthElapsed = 0;
}

- (void)armAutoNorth {
    if (!_threeDMode || fabs(_camera.bearing) < 1e-9) {
        [self cancelAutoNorth];
        return;
    }
    _autoNorthArmed = YES;
    _autoNorthAnimating = NO;
    _autoNorthQuiet = 0;
    _autoNorthElapsed = 0;
}

- (void)advanceAutoNorth:(double)dt {
    if (!_autoNorthArmed || !_threeDMode || !(dt > 0) || !isfinite(dt)) return;
    if (_pointerHeld) { _autoNorthQuiet = 0; return; }
    _autoNorthQuiet += dt;
    if (!_autoNorthAnimating && _autoNorthQuiet >= 0.45) {
        if ([self reducedNow]) {
            [self northUp:nil];
            return;
        }
        _autoNorthAnimating = YES;
        _autoNorthElapsed = 0;
        _autoNorthFrom = _camera.bearing;
    }
    if (!_autoNorthAnimating) return;
    _autoNorthElapsed += dt;
    double t = fmin(1.0, _autoNorthElapsed / 0.6);
    double eased = t * t * (3.0 - 2.0 * t);
    IsobarCamera next = _camera;
    next.bearing = _autoNorthFrom * (1.0 - eased);
    [self commitKeyboardCamera:next];
    if (t >= 1.0) {
        _autoNorthArmed = NO;
        _autoNorthAnimating = NO;
        _autoNorthQuiet = 0;
        _autoNorthElapsed = 0;
        _last3DBearing = 0;
    }
}

- (void)commitKeyboardCamera:(IsobarCamera)camera {
    _morphing = NO;
    _camera = IsobarCameraClamp(camera);
    self.didPlaceCamera = YES;
    [self noteUserMoved];
    [self syncViewport];
    [self syncSlider];
    [self syncModeControls];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
}

- (void)moveGroundByForward:(double)forward right:(double)right {
    if (!_threeDMode || !isfinite(forward) || !isfinite(right)) return;
    [self cancelAutoNorth];
    double zoom = fmax(1.0, _camera.zoom);
    double step = fmin(10.0, 6.0 / zoom);
    double bearing = _camera.bearing;
    double east = sin(bearing) * forward + cos(bearing) * right;
    double north = cos(bearing) * forward - sin(bearing) * right;
    double lat = _camera.centreLat + north * step;
    double c = cos(lat * M_PI / 180.0);
    if (fabs(c) < 1e-5) c = c < 0 ? -1e-5 : 1e-5;
    IsobarCamera next = _camera;
    next.centreLat = lat;
    next.centreLon = MapWrap180(_camera.centreLon + east * step / c);
    [self commitKeyboardCamera:next];
    [self armAutoNorth];
}

- (void)stepBearingBy:(double)delta {
    if (!_threeDMode || !isfinite(delta)) return;
    [self cancelAutoNorth];
    IsobarCamera next = _camera;
    if (next.pitch <= 1e-7) next.pitch = kKeyboardArrowTiltStep;
    next.globe = MIN(1.0, MAX(0.0, next.pitch / kFullTiltPitch));
    next.bearing += delta;
    [self commitKeyboardCamera:next];
}

- (void)stepEyeHeightBy:(double)delta {
    if (!_threeDMode || !isfinite(delta)) return;
    [self cancelAutoNorth];
    IsobarCamera next = _camera;
    if (!MapCameraAdjustEyeHeight(&next, delta)) return;
    [self commitKeyboardCamera:next];
}

- (BOOL)handle3DKeyEvent:(NSEvent *)event {
    if (!_threeDMode || !event) return NO;
    NSEventModifierFlags mods = event.modifierFlags & (NSEventModifierFlagCommand |
        NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift);
    if (mods != 0) return NO;
    switch (event.keyCode) {
        case 123: [self stepBearingBy:-kKeyboardYawStep]; return YES;
        case 124: [self stepBearingBy:kKeyboardYawStep]; return YES;
        case 125: [self stepTiltBy:-kKeyboardArrowTiltStep]; return YES;
        case 126: [self stepTiltBy:kKeyboardArrowTiltStep]; return YES;
        default: break;
    }
    NSString *ch = event.charactersIgnoringModifiers.lowercaseString ?: @"";
    if ([ch isEqualToString:@"n"] && !event.isARepeat) { [self northUp:nil]; return YES; }
    if ([ch isEqualToString:@"w"]) { [self moveGroundByForward:1 right:0]; return YES; }
    if ([ch isEqualToString:@"s"]) { [self moveGroundByForward:-1 right:0]; return YES; }
    if ([ch isEqualToString:@"a"]) { [self moveGroundByForward:0 right:-1]; return YES; }
    if ([ch isEqualToString:@"d"]) { [self moveGroundByForward:0 right:1]; return YES; }
    if ([ch isEqualToString:@"e"]) { [self stepEyeHeightBy:0.1]; return YES; }
    if ([ch isEqualToString:@"q"]) { [self stepEyeHeightBy:-0.1]; return YES; }
    return NO;
}

- (void)goFlat:(id)sender {
    (void)sender;
    [self cancelAutoNorth];
    if (!_threeDMode) {
        if (fabs(_camera.globe) > 1e-9 || fabs(_camera.pitch) > 1e-9) {
            _morphing = NO;
            [self applyPitch:0 globe:0];
            [self syncViewport];
            _camera = IsobarCameraClamp(_camera);
            [self syncSlider];
            [self placeMarker];
            if (self.onCameraChanged) self.onCameraChanged(_camera);
        }
        [self syncModeControls];
        return;
    }
    _last3DGlobe = MIN(1.0, MAX(0.0, _camera.globe));
    _last3DBearing = _camera.bearing;
    _threeDMode = NO;
    _camera.bearing = 0;
    [self syncModeControls];
    [self animateGlobeTo:0 reducedMotion:[self reducedNow]];
}

- (void)goGlobe:(id)sender {
    (void)sender;
    [self cancelAutoNorth];
    if (_threeDMode) {
        [self syncModeControls];
        return;
    }
    _threeDMode = YES;
    _camera.bearing = _last3DBearing;
    [self syncModeControls];
    [self animateGlobeTo:_last3DGlobe reducedMotion:[self reducedNow]];
}

- (void)globeSlid:(NSSlider *)slider {
    if (!_threeDMode) {
        [self syncSlider];
        return;
    }
    _morphing = NO;
    [self applyPitch:slider.doubleValue * kFullTiltPitch globe:slider.doubleValue];
    _last3DGlobe = _camera.globe;
    [self syncViewport];
    _camera = IsobarCameraClamp(_camera);
    [self syncSlider];
    [self syncModeControls];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
}

- (void)stepTiltBy:(double)delta {
    if (!_threeDMode || !isfinite(delta) || fabs(delta) < 1e-12) return;
    [self cancelAutoNorth];
    IsobarCamera next = _camera;
    next.pitch = MIN(kMaxMapPitch, MAX(0.0, next.pitch + delta));
    next.globe = MIN(1.0, MAX(0.0, next.pitch / kFullTiltPitch));
    _morphing = NO;
    [self applyPitch:next.pitch globe:next.globe];
    _camera = IsobarCameraClamp(_camera);
    _last3DGlobe = _camera.globe;
    [self syncViewport];
    [self syncSlider];
    [self syncModeControls];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
}

- (BOOL)anchorLat:(double)lat lon:(double)lon toX:(double)x y:(double)y {
    IsobarCamera next = _camera;
    if (!MapCameraAnchor(&next, lat, lon, x, y)) return NO;
    _camera = IsobarCameraClamp(next);
    self.didPlaceCamera = YES;
    [self noteUserMoved];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
    return YES;
}

- (void)cancelPointerHold {
    if (!_pointerHeld) return;
    _pointerHeld = NO;
    if (self.onHoldChanged) self.onHoldChanged(NO);
}

- (void)pointerDown:(NSPoint)point {
    [self cancelAutoNorth];
    [self syncViewport];
    NSPoint p = [self pixels:point];
    _downX = p.x;
    _downY = p.y;
    _dragLastX = p.x;
    _dragLastY = p.y;
    _dragStartCamera = _camera;
    _dragLastCamera = _camera;
    _haveDragLastCamera = YES;
    _dragging = NO;
    _grabbed = IsobarCameraUnproject(_camera, p.x, p.y, &_grabLat, &_grabLon);
    if (!_pointerHeld) {
        _pointerHeld = YES;
        if (self.onHoldChanged) self.onHoldChanged(YES);
    }
}

- (void)pointerDrag:(NSPoint)point {
    [self syncViewport];
    NSPoint p = [self pixels:point];
    _dragLastX = p.x;
    _dragLastY = p.y;
    CGFloat slop = kClickPoints * [self pixelScale];
    if (!_dragging && MapPointerIsClick(p.x - _downX, p.y - _downY, slop)) return;
    _dragging = YES;

    // At a steep view angle the ground under the pointer approaches the
    // horizon. Solving that point again against the already-mutated camera
    // makes a drag amplify and then snap as it crosses the horizon. Use one
    // drag-start camera and move its local focal plane instead. The vertical
    // component needs a small perspective compensation at the maximum tilt;
    // cap it so a near-polar camera cannot turn a few pixels into an enormous
    // longitude step. This path is deliberately 3D-only; overhead dragging
    // retains the exact existing anchor behaviour.
    if (_threeDMode) {
        // A pinch/key update can arrive between drag samples. Rebase at the
        // current sample so the next total displacement cannot undo it.
        if (_haveDragLastCamera && memcmp(&_camera, &_dragLastCamera, sizeof(IsobarCamera)) != 0) {
            _dragStartCamera = _camera;
            _downX = p.x;
            _downY = p.y;
        }
        IsobarCamera next = _dragStartCamera;
        double fit = fmin(next.viewportW / 360.0, next.viewportH / 180.0);
        double radius = next.zoom * fit / (M_PI / 180.0);
        if (radius > 0 && isfinite(radius)) {
            double dx = p.x - _downX;
            double dy = p.y - _downY;
            double pitchCos = fabs(cos(next.pitch));
            double gain = 1.0 / fmax(cos(75.0 * M_PI / 180.0), pitchCos);
            double eastScreen = -dx / radius;
            double northScreen = dy / radius * gain;
            double bearing = next.bearing;
            double east = eastScreen * cos(bearing) + northScreen * sin(bearing);
            double north = -eastScreen * sin(bearing) + northScreen * cos(bearing);
            double lat = next.centreLat + north / (M_PI / 180.0);
            double morph = next.pitch / (20.0 * M_PI / 180.0);
            if (morph <= 0) morph = 0;
            else if (morph >= 1) morph = 1;
            else morph = morph * morph * (3.0 - 2.0 * morph);
            double metricLat = next.centreLat * morph;
            double metric = fmax(0.15, fabs(cos(metricLat * M_PI / 180.0)));
            next.centreLat = lat;
            next.centreLon = MapWrap180(next.centreLon + east / metric / (M_PI / 180.0));
            _camera = IsobarCameraClamp(next);
            _dragLastCamera = _camera;
            _haveDragLastCamera = YES;
            self.didPlaceCamera = YES;
            [self noteUserMoved];
            [self placeMarker];
            if (self.onCameraChanged) self.onCameraChanged(_camera);
            return;
        }
    }
    double lat = _grabLat, lon = _grabLon, ax = p.x, ay = p.y;
    if (!_grabbed) {
        double cx = _camera.viewportW * 0.5, cy = _camera.viewportH * 0.5;
        if (!IsobarCameraUnproject(_camera, cx, cy, &lat, &lon)) return;
        ax = cx + (p.x - _downX);
        ay = cy + (p.y - _downY);
    }
    [self anchorLat:lat lon:lon toX:ax y:ay];
}

- (void)pointerUp:(NSPoint)point {
    NSPoint p = [self pixels:point];
    CGFloat slop = kClickPoints * [self pixelScale];
    BOOL click = !_dragging && MapPointerIsClick(p.x - _downX, p.y - _downY, slop);
    BOOL dragged = _dragging;
    _dragging = NO;
    [self cancelPointerHold];
    if (dragged && !_pointerHeld) [self armAutoNorth];
    if (click && self.onPlainClick) self.onPlainClick();
}

- (void)cancelOperation:(id)sender {
    (void)sender;
    _dragging = NO;
    [self cancelAutoNorth];
    [self cancelPointerHold];
}

- (BOOL)pinchFactor:(double)factor atPoint:(NSPoint)point {
    [self cancelAutoNorth];
    if (!isfinite(factor) || factor <= 0 || !isfinite(point.x) || !isfinite(point.y) ||
        !isfinite(_camera.zoom) || !(_camera.zoom > 0)) return NO;
    [self syncViewport];
    NSPoint p = [self pixels:point];
    double lat = 0, lon = 0;
    BOOL anchored = IsobarCameraUnproject(_camera, p.x, p.y, &lat, &lon);
    IsobarCamera next = _camera;
    next.zoom = _camera.zoom * factor;
    if (!isfinite(next.zoom) || !(next.zoom > 0)) return NO;
    // Clamp the requested zoom before solving the anchor.  Clamping after the
    // solve changes the projection around the pointer at both zoom limits.
    next = IsobarCameraClamp(next);
    if (anchored) {
        IsobarCamera candidate = next;
        if (MapCameraAnchor(&candidate, lat, lon, p.x, p.y)) next = candidate;
    }
    // Sky and unreachable horizon anchors zoom around the current focus.
    // Never discard an otherwise valid magnification gesture.
    _morphing = NO;
    // The anchor solve can move the centre toward a pole. Keep the camera in
    // the viewport-dependent legal range after that solve as well.
    _camera = IsobarCameraClamp(next);
    self.didPlaceCamera = YES;
    [self noteUserMoved];
    [self placeMarker];
    if (self.onCameraChanged) self.onCameraChanged(_camera);
    if (_threeDMode && !_pointerHeld) [self armAutoNorth];
    return YES;
}

- (void)scrollByX:(double)dx y:(double)dy atPoint:(NSPoint)point precise:(BOOL)precise command:(BOOL)command {
    [self cancelAutoNorth];
    if (!isfinite(dx) || !isfinite(dy) || !isfinite(point.x) || !isfinite(point.y)) return;
    if (!_threeDMode && _morphing) {
        _morphing = NO;
        [self applyPitch:0 globe:0];
        [self syncViewport];
        _camera = IsobarCameraClamp(_camera);
        [self syncSlider];
    }
    if (!precise || command) {
        _morphing = NO;
        double notches = dy / 40.0;
        [self pinchFactor:exp(-notches * 0.12) atPoint:point];
        return;
    }
    if (!_threeDMode) {
        [self pinchFactor:exp(-dy / 40.0 * 0.12) atPoint:point];
        return;
    }
    _morphing = NO;
    [self syncViewport];
    // A precise two-finger scroll orbits horizontally and tilts vertically.
    // Natural-scroll deltas are used directly: swiping right increases the
    // bearing, while swiping up increases the tilt. Both axes are applied in
    // one camera update so a diagonal gesture cannot briefly lose its anchor.
    double bearingDelta = dx * 0.004;
    double pitchDelta = -dy * 0.004;
    if (!isfinite(bearingDelta) || !isfinite(pitchDelta) ||
        (fabs(bearingDelta) < 1e-10 && fabs(pitchDelta) < 1e-10)) return;

    // Keep the selected place pinned to its current screen position when one
    // is available. Without a place, pin the existing geographic centre at
    // the viewport centre, which gives an unpinned orbit its stable focus.
    double focusLat = _camera.centreLat;
    double focusLon = _camera.centreLon;
    double anchorX = _camera.viewportW * 0.5;
    double anchorY = _camera.viewportH * 0.5;
    BOOL haveSelectedFocus = isfinite(_placeLatitude) && isfinite(_placeLongitude);
    if (haveSelectedFocus) {
        double selectedX = 0, selectedY = 0;
        if (IsobarCameraProject(_camera, _placeLatitude, _placeLongitude,
                                &selectedX, &selectedY) &&
            selectedX >= 0 && selectedX <= _camera.viewportW &&
            selectedY >= 0 && selectedY <= _camera.viewportH) {
            focusLat = _placeLatitude;
            focusLon = _placeLongitude;
            anchorX = selectedX;
            anchorY = selectedY;
        } else {
            haveSelectedFocus = NO;
        }
    }

    IsobarCamera next = _camera;
    next.bearing += bearingDelta;
    next.pitch += pitchDelta;
    if (next.pitch < 0) next.pitch = 0;
    if (next.pitch > kMaxMapPitch) next.pitch = kMaxMapPitch;
    next.globe = next.pitch / kFullTiltPitch;
    if (next.globe < 0) next.globe = 0;
    if (next.globe > 1) next.globe = 1;

    // Reuse the established tilt framing/dolly calculation before solving
    // the geographic anchor. This preserves pinch zoom while changing pitch.
    // Keep the pre-gesture pitch visible to applyPitch: so it can establish
    // or update the automatic tilt dolly baseline correctly. Only bearing is
    // installed before that helper runs.
    _camera.bearing = next.bearing;
    [self applyPitch:next.pitch globe:next.globe];
    next = _camera;
    IsobarCamera anchored = next;
    if (MapCameraAnchor(&anchored, focusLat, focusLon, anchorX, anchorY)) {
        next = anchored;
    } else if (haveSelectedFocus) {
        // A selected point can be beyond the visible globe horizon. Keep the
        // valid orbit/tilt update and let marker visibility update below.
    }
    [self commitKeyboardCamera:next];
}

- (void)zoomBy:(double)factor {
    [self pinchFactor:factor atPoint:NSMakePoint(NSMidX(self.bounds), NSMidY(self.bounds))];
}

- (id<MTLTexture>)scratchTextureWidth:(NSUInteger)width height:(NSUInteger)height {
    if (width < 2) width = 2;
    if (height < 2) height = 2;
    if (width > 8192) width = 8192;
    if (height > 8192) height = 8192;
    if (_scratch && _scratch.width == width && _scratch.height == height) return _scratch;
    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:width height:height mipmapped:NO];
    desc.usage = MTLTextureUsageRenderTarget;
    desc.storageMode = MTLStorageModePrivate;
    _scratch = [_device newTextureWithDescriptor:desc];
    return _scratch;
}

- (void)encodeFrame {
    [self syncChartAppearance];
    _lastQueueWaitMilliseconds = 0;
    if (!_gridReady || !_hasField || self.unavailable) return;
    // A headless clock submits frames faster than the GPU. Drain the previous
    // one first, and keep that wait out of this frame's time: on a display
    // link the previous frame finished during the vsync gap.
    if (!self.window && _scratchBuffer && _scratchBuffer.status != MTLCommandBufferStatusCompleted) {
        NSTimeInterval waitBegan = CACurrentMediaTime();
        [_scratchBuffer waitUntilCompleted];
        _lastQueueWaitMilliseconds = (CACurrentMediaTime() - waitBegan) * 1000.0;
        _scratchBuffer = nil;
    }
    if (self.suppressPresentation) {
        [self armPresentWatchdog];
        return;
    }
    [self syncDrawable];
    BOOL wantDrawable = [self windowWantsFrames];
    // A tight test loop asks for a drawable before the display has released
    // the previous one. That wait is the vsync gap on a real link, not this
    // frame's contour and encode work.
    id<CAMetalDrawable> drawable = nil;
    if (wantDrawable) {
        NSTimeInterval waited = CACurrentMediaTime();
        drawable = [self.metalLayer nextDrawable];
        _lastQueueWaitMilliseconds += (CACurrentMediaTime() - waited) * 1000.0;
    }
    id<MTLTexture> target = drawable.texture;
    if (!target) {
        // Headless clocks have no window. A window that wanted a drawable and
        // got nil is the white layer: do not pretend a scratch encode was presented.
        if (wantDrawable) {
            [self armPresentWatchdog];
            return;
        }
        target = [self scratchTextureWidth:(NSUInteger)_camera.viewportW height:(NSUInteger)_camera.viewportH];
    }
    if (!target) return;
    _camera.viewportW = target.width;
    _camera.viewportH = target.height;
    // The fit is in drawable pixels. A later retina scale or resize changes
    // the viewport and recomputes it, so the same zoom cannot crop the north.
    [self refitPopoverIfNeeded];
    id<MTLCommandBuffer> buffer = [_queue commandBuffer];
    if (!buffer) {
        if (wantDrawable) [self armPresentWatchdog];
        return;
    }
    [_lock lock];
    _renderer.pixelsPerPoint = [self pixelScale];
    NSError *error = nil;
    [self applyEndpointMix];
    BOOL ok = [_renderer encodeTime:_fractionalStep fill:_fill isobars:YES camera:_camera
        intoCommandBuffer:buffer target:target error:&error];
    _lastQueueWaitMilliseconds += _renderer.lastSyncWaitMilliseconds;
    BOOL blank = !ok || _renderer.contourLineCount < 1;
    [_lock unlock];
    if (!ok) {
        if (wantDrawable) [self armPresentWatchdog];
        return;
    }
    if (drawable) {
        [buffer presentDrawable:drawable];
        [buffer commit];
        _presentedCount++;
        _presentedFrameBlank = blank;
        [self cancelPresentWatchdog];
        return;
    }
    // The previous headless encode was drained above, before this frame's work.
    _scratchBuffer = buffer;
    [buffer commit];
}

- (void)applyEndpointMix {
    if (!_renderer) return;
    if (_dissolveMix > 0.001)
        [_renderer setEndpointMixFrom:_dissolveFrom to:_dissolveTo mix:_dissolveMix];
    else
        [_renderer setEndpointMixFrom:0 to:0 mix:0];
}

- (void)sampleTimelineAtTime:(NSTimeInterval)time {
    IsobarLivePlayer *player = self.timeline;
    if (!player || (!player.playing && !player.seaming)) {
        _dissolveMix = 0;
        return;
    }
    if (player.playheadEpoch != _timelineEpoch) {
        _timelineEpoch = player.playheadEpoch;
        _stepFloor = -INFINITY;
    }
    if (player.seaming) {
        double endStep = [player seamFromModelIndex];
        if (!isfinite(endStep)) return;
        _fractionalStep = endStep;
        _dissolveFrom = endStep;
        _dissolveTo = [player seamToModelIndex];
        _dissolveMix = (float)player.seamMix;
        if (_source != OwnRunFieldMSLP && !_placesView.hidden && fabs(endStep - _namesStep) > 0.06)
            [self updatePlaceNames];
        return;
    }
    _dissolveMix = 0;
    double step = [player modelIndexAtTime:time];
    if (!isfinite(step)) return;
    if (player.playheadRate > 0 && step < _stepFloor) step = _stepFloor;
    else if (player.playheadRate > 0) _stepFloor = step;
    _fractionalStep = step;
    if (_source != OwnRunFieldMSLP && !_placesView.hidden && fabs(step - _namesStep) > 0.06) [self updatePlaceNames];
}

- (void)displayAtTime:(NSTimeInterval)time {
    NSTimeInterval began = CACurrentMediaTime();
    [self sampleTimelineAtTime:time];
    double dt = 1.0 / 60.0;
    if (_lastSample > 0) {
        double elapsed = time - _lastSample;
        if (elapsed > 0 && elapsed < 1) dt = elapsed;
    }
    _lastSample = time;
    [self advanceDisplay:dt];
    double elapsed = (CACurrentMediaTime() - began) * 1000.0 - _lastQueueWaitMilliseconds;
    _lastFrameMilliseconds = elapsed > 0 ? elapsed : 0;
}

- (double)lastFrameMilliseconds { return _lastFrameMilliseconds; }
- (double)lastContourMilliseconds { return _renderer.lastContourMilliseconds; }
- (double)lastLabelMilliseconds { return _renderer.lastLabelMilliseconds; }
- (double)lastProjectMilliseconds { return _renderer.lastProjectMilliseconds; }
- (double)lastGeometryMilliseconds { return _renderer.lastGeometryMilliseconds; }

- (NSInteger)contourLineCount { return _renderer.contourLineCount; }

- (NSInteger)presentedLabelCount { return _renderer.labelCount; }

- (BOOL)presentedLabelAtIndex:(NSInteger)index x:(double *)x y:(double *)y level:(double *)level halfW:(double *)halfW {
    return [_renderer labelAtIndex:index x:x y:y angle:NULL level:level halfW:halfW halfH:NULL];
}

- (uint32_t)presentedLabelIdentAtIndex:(NSInteger)index {
    return [_renderer labelIdentAtIndex:index];
}

- (NSInteger)contourVertexCountForLine:(NSInteger)line {
    return [_renderer contourVertexCountForLine:line];
}

- (BOOL)contourVertexForLine:(NSInteger)line index:(NSInteger)index latitude:(double *)latitude longitude:(double *)longitude {
    return [_renderer contourVertexForLine:line index:index latitude:latitude longitude:longitude];
}

- (void)advanceDisplay:(double)dt {
    if (!(dt > 0) || !isfinite(dt)) dt = 1.0 / 60.0;
    if (dt > 1) dt = 1;
    if (_morphing) {
        _morphT += dt;
        double globe = MapGlobeAt(_morphFrom, _morphTo, _morphT, kMapMorphSeconds, [self reducedNow]);
        [self applyPitch:globe * kFullTiltPitch globe:globe];
        if (_morphT >= kMapMorphSeconds) {
            _camera.globe = _morphTo;
            _morphing = NO;
        }
        [self syncViewport];
        _camera = IsobarCameraClamp(_camera);
        [self syncSlider];
        [self syncModeControls];
        [self placeMarker];
    }
    [self advanceAutoNorth:dt];
    if (self.unavailable) return;
    IsobarCamera overlayCamera = _camera;
    overlayCamera.viewportW = NSWidth(self.bounds); overlayCamera.viewportH = NSHeight(self.bounds);
    _atmosphereView.camera = overlayCamera;
    _atmosphereView.date = self.atmosphereDate ?: self.timeline.playhead;
    [self syncVectorOverlays];
    [_atmosphereView setNeedsDisplay:YES];
    _renderedStep = _fractionalStep;
    _renderCount++;
    [self encodeFrame];
    [self updateHazardOverlay];
}

- (void)onDisplay:(CADisplayLink *)link {
    if (![self windowWantsFrames]) return;
    NSTimeInterval sample = link.targetTimestamp;
    if (self.timeline) {
        double lead = link.targetTimestamp - link.timestamp;
        if (lead < 0) lead = 0;
        if (lead > 0.05) lead = 0.05;
        sample = [self.timeline clockNow] + lead;
    }
    _lastStamp = link.timestamp;
    [self displayAtTime:sample];
}

- (CGImageRef)copySnapshot {
    if (!_renderer || !_gridReady || self.unavailable) return nil;
    [self syncChartAppearance];
    [self syncViewport];
    [self refitPopoverIfNeeded];
    [_lock lock];
    BOOL sync = _renderer.synchronousContours;
    _renderer.synchronousContours = YES;
    _renderer.pixelsPerPoint = [self pixelScale];
    NSError *error = nil;
    [self applyEndpointMix];
    CGImageRef image = [_renderer renderTime:_fractionalStep fill:_fill isobars:YES camera:_camera error:&error];
    _renderer.synchronousContours = sync;
    [_lock unlock];
    if (image) _renderedStep = _fractionalStep;
    if (image && _windBarbs) {
        CGImageRef vectors = [self copyImageWithVectorOverlays:image wind:YES atmosphere:NO];
        if (vectors) { CGImageRelease(image); image = vectors; }
    }
    if (image) {
        CGImageRef named = [self copyImageWithPlaces:image];
        if (named) { CGImageRelease(image); image = named; }
    }
    if (image && _hazards) {
        CGImageRef composed = [self copyImageWithHazards:image];
        if (composed) {
            CGImageRelease(image);
            image = composed;
        }
    }
    if (image) {
        CGImageRef vectors = [self copyImageWithVectorOverlays:image wind:NO atmosphere:YES];
        if (vectors) { CGImageRelease(image); image = vectors; }
    }
    return image;
}

- (CGImageRef)copyImageWithVectorOverlays:(CGImageRef)image wind:(BOOL)wind atmosphere:(BOOL)atmosphere {
    if (!image || (!(wind && _windBarbs) && !(atmosphere && (self.atmosphereDate || self.timeline.playhead)))) return nil;
    [self syncVectorOverlays];
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    if (!(NSWidth(self.bounds) > 0) || !(NSHeight(self.bounds) > 0)) return nil;
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextTranslateCTM(context, 0, height);
    CGContextScaleCTM(context, width / NSWidth(self.bounds), -(double)height / NSHeight(self.bounds));
    NSGraphicsContext *previous = NSGraphicsContext.currentContext;
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithCGContext:context flipped:YES];
    if (wind && _windBarbs) [_windView drawRect:_windView.bounds];
    if (atmosphere && (self.atmosphereDate || self.timeline.playhead)) [_atmosphereView drawRect:_atmosphereView.bounds];
    NSGraphicsContext.currentContext = previous;
    CGImageRef output = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return output;
}


#pragma mark - Hazard layer

- (BOOL)hazards { return _hazards; }
- (BOOL)hazardsReady { return _hazardsReady; }
- (NSString *)hazardStoreRoot { return _hazardStoreRoot; }
- (NSDictionary *)sigmetProduct { return _sigmetProduct; }
- (double)lastHazardMilliseconds { return _lastHazardMilliseconds; }
- (NSArray<NSString *> *)hazardLabels { return _snapshotHazardLabels ?: @[]; }

- (void)setHazards:(BOOL)hazards {
    if (_hazards == hazards) return;
    _hazards = hazards;
    _hazardShownKey = LONG_MIN;
    if (!hazards) {
        _hazardView.hidden = YES;
        _hazardView.hazardFrame = nil;
        _lastHazardMilliseconds = 0;
        self.toolTip = nil;
    }
    [self loadHazardsIfNeeded];
    [self updateTrackingAreas];
    [self presentNow];
}

- (void)setHazardStoreRoot:(NSString *)root {
    if (root == _hazardStoreRoot || [root isEqualToString:_hazardStoreRoot]) return;
    _hazardStoreRoot = [root copy];
    _hazardSource = nil;
    [self loadHazardsIfNeeded];
}

- (void)setSigmetProduct:(NSDictionary *)product {
    if (product == _sigmetProduct || [product isEqual:_sigmetProduct]) return;
    _sigmetProduct = [product copy];
    _sigmets = IsobarSigmetsFromProduct(product);
    _hazardShownValidity = nil;
}

- (NSArray<NSDate *> *)timesForRun:(OwnRun *)run {
    NSMutableArray *times = [NSMutableArray array];
    for (NSInteger i = 0; i < run.hours; i++) {
        NSDate *t = [run timeAtIndex:i];
        if (!t) return @[];
        [times addObject:t];
    }
    return times;
}

// A new run or root drops every frame and loads the inputs on the hazard
// queue. Until they arrive the map draws SIGMETs only.
- (void)loadHazardsIfNeeded {
    OwnRun *run = _run;
    if (!_hazards || !run || run == _hazardSource) return;
    _hazardSource = run;
    _hazardRun = nil;
    _hazardsReady = NO;
    [_hazardFrames removeAllObjects];
    [_hazardOrder removeAllObjects];
    [_hazardPending removeAllObjects];
    _hazardView.hazardFrame = nil;
    _hazardShownKey = LONG_MIN;
    NSUInteger generation = ++_hazardGeneration;
    NSArray<NSDate *> *times = [self timesForRun:run];
    _runTimes = times;
    OwnRunGeo geo = [run geo];
    IsobarGeoGrid grid = {.west = geo.west, .north = geo.north, .step = geo.step,
        .nLon = geo.nLon, .nLat = geo.nLat, .wrapsLongitude = geo.wrapsLongitude};
    NSString *root = [_hazardStoreRoot copy];
    NSDate *runDate = run.runDate;
    __weak GPUMapView *weak = self;
    dispatch_async(_hazardQueue, ^{
        NSString *error = nil;
        IsobarHazardRun *loaded = root.length && times.count
            ? [IsobarHazardRun runFromStoreRoot:root runDate:runDate times:times grid:grid error:&error] : nil;
        dispatch_async(dispatch_get_main_queue(), ^{
            GPUMapView *strong = weak;
            if (!strong || generation != strong->_hazardGeneration) return;
            strong->_hazardRun = loaded.hasCBInputs ? loaded : nil;
            strong->_hazardsReady = YES;
            strong->_hazardShownKey = LONG_MIN;
            [strong presentNow];
        });
    });
}

- (void)waitForHazards {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
    do {
        dispatch_sync(_hazardQueue, ^{});
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    } while ((!_hazardsReady || _hazardPending.count) && _hazards && _hazardSource &&
             [deadline timeIntervalSinceNow] > 0);
}

- (NSDate *)hazardTime {
    NSArray<NSDate *> *times = _runTimes.count ? _runTimes : (_run ? [self timesForRun:_run] : nil);
    if (!times.count || !isfinite(_fractionalStep)) return nil;
    double t = _fractionalStep;
    if (t <= 0) return times.firstObject;
    if (t >= times.count - 1) return times.lastObject;
    NSInteger s0 = (NSInteger)floor(t);
    NSTimeInterval a = times[(NSUInteger)s0].timeIntervalSince1970, b = times[(NSUInteger)s0 + 1].timeIntervalSince1970;
    return [NSDate dateWithTimeIntervalSince1970:a + (b - a) * (t - s0)];
}

static const double kHazardKeysPerStep = 50.0;
static const NSUInteger kHazardFrameCache = 24;

- (void)cacheHazardFrame:(IsobarHazardFrame *)frame key:(NSNumber *)key {
    if (!frame) return;
    if (!_hazardFrames[key]) [_hazardOrder addObject:key];
    _hazardFrames[key] = frame;
    while (_hazardOrder.count > kHazardFrameCache) {
        [_hazardFrames removeObjectForKey:_hazardOrder.firstObject];
        [_hazardOrder removeObjectAtIndex:0];
    }
}

- (void)requestHazardKey:(long)key {
    IsobarHazardRun *run = _hazardRun;
    if (!run || key < 0 || key > (long)((run.steps - 1) * kHazardKeysPerStep)) return;
    NSNumber *k = @(key);
    if (_hazardFrames[k] || [_hazardPending containsObject:k]) return;
    [_hazardPending addObject:k];
    NSUInteger generation = _hazardGeneration;
    __weak GPUMapView *weak = self;
    dispatch_async(_hazardQueue, ^{
        IsobarHazardFrame *frame = [run frameAtStep:key / kHazardKeysPerStep];
        dispatch_async(dispatch_get_main_queue(), ^{
            GPUMapView *strong = weak;
            if (!strong || generation != strong->_hazardGeneration) return;
            [strong->_hazardPending removeObject:k];
            [strong cacheHazardFrame:frame key:k];
        });
    });
}

// The frame for this step from the cache. Off the cache: built here when
// `synchronous`; otherwise the key is queued (unless two builds are already
// waiting, so a fast scrub never piles up stale work) and the nearest cached
// frame within half a model step stands in until it lands.
- (IsobarHazardFrame *)hazardFrameForStep:(double)step synchronous:(BOOL)synchronous {
    if (!_hazardRun || !isfinite(step)) return nil;
    long key = lround(step * kHazardKeysPerStep);
    NSNumber *k = @(key);
    IsobarHazardFrame *frame = _hazardFrames[k];
    long ahead = key >= _hazardLastKey ? 1 : -1;
    _hazardLastKey = key;
    if (frame) {
        [self requestHazardKey:key + ahead];
        return frame;
    }
    if (synchronous) {
        frame = [_hazardRun frameAtStep:key / kHazardKeysPerStep];
        [self cacheHazardFrame:frame key:k];
        return frame;
    }
    if (_hazardPending.count < 2) [self requestHazardKey:key];
    if (_hazardPending.count < 2) [self requestHazardKey:key + ahead];
    long best = LONG_MAX;
    for (NSNumber *cached in _hazardFrames) {
        long d = labs(cached.longValue - key);
        if (d < best && d <= (long)(kHazardKeysPerStep / 2)) { best = d; frame = _hazardFrames[cached]; }
    }
    return frame;
}

- (NSString *)validSigmetSignatureAt:(NSDate *)time {
    NSMutableString *sig = [NSMutableString string];
    [_sigmets enumerateObjectsUsingBlock:^(IsobarSigmet *s, NSUInteger i, BOOL *stop) {
        (void)stop;
        if ([s isValidAt:time]) [sig appendFormat:@"%lu,", (unsigned long)i];
    }];
    return sig;
}

// Use only the L marks the renderer placed on this map, after its smoothing,
// centre settling, coverage and viewport checks. A raw pressure minimum is
// not evidence of a drawn low. Points are geographic (longitude, latitude).
- (void)updateHazardCauses:(IsobarHazardFrame *)frame {
    if (!frame.areas.count) return;
    NSMutableArray<NSValue *> *lows = [NSMutableArray array];
    for (NSInteger i = 0; i < _renderer.centreCount; i++) {
        double x = 0, y = 0, lat = 0, lon = 0;
        BOOL high = YES;
        if ([_renderer centreAtIndex:i x:&x y:&y value:NULL high:&high] && !high &&
            IsobarCameraUnproject(_camera, x, y, &lat, &lon))
            [lows addObject:[NSValue valueWithPoint:NSMakePoint(lon, lat)]];
    }
    [frame updateDrawnLowCentres:lows];
}

// Redraws the overlay only when its frame, the camera, the appearance or the
// set of valid SIGMETs changed. The draw happens here, inside the frame's
// timed work, not later at commit.
- (void)updateHazardOverlay {
    if (!_hazards || self.unavailable || !_gridReady) {
        _hazardView.hidden = YES;
        _lastHazardMilliseconds = 0;
        return;
    }
    NSTimeInterval began = CACurrentMediaTime();
    _hazardView.hidden = NO;
    long key = lround(_fractionalStep * kHazardKeysPerStep);
    IsobarHazardFrame *frame = [self hazardFrameForStep:_fractionalStep synchronous:NO];
    // While a build is in flight the previous frame stays: no blank flash.
    if (!frame) frame = _hazardView.hazardFrame;
    [self updateHazardCauses:frame];
    NSDate *time = [self hazardTime];
    NSString *validity = [self validSigmetSignatureAt:time];
    BOOL dark = [self mapIsDark];
    BOOL sameCamera = memcmp(&_camera, &_hazardShownCamera, sizeof(IsobarCamera)) == 0;
    BOOL forced = _hazardShownKey == LONG_MIN;
    if (!forced && frame == _hazardView.hazardFrame && sameCamera && dark == _hazardShownDark &&
        [validity isEqualToString:_hazardShownValidity ?: @""]) {
        _lastHazardMilliseconds = (CACurrentMediaTime() - began) * 1000.0;
        return;
    }
    _hazardView.hazardFrame = frame;
    _hazardView.sigmets = _sigmets;
    _hazardView.time = time;
    _hazardView.camera = _camera;
    _hazardView.pixelScale = [self pixelScale];
    _hazardView.dark = dark;
    _hazardView.reserved = [self hazardReservedRects];
    _hazardShownKey = key;
    _hazardShownCamera = _camera;
    _hazardShownDark = dark;
    _hazardShownValidity = validity;
    _hazardView.needsDisplay = YES;
    [_hazardView displayIfNeeded];
    _lastHazardMilliseconds = (CACurrentMediaTime() - began) * 1000.0;
}

// Viewport-pixel rects hazard labels keep clear of: the field key the host
// lays over the bottom-left corner, and the map's own visible buttons.
- (NSArray<NSValue *> *)hazardReservedRects {
    CGFloat scale = [self pixelScale];
    NSMutableArray *rects = [NSMutableArray array];
    NSRect key = NSMakeRect(0, NSHeight(self.bounds) - 40, 196, 40);
    [rects addObject:[NSValue valueWithRect:NSMakeRect(key.origin.x * scale, key.origin.y * scale,
        key.size.width * scale, key.size.height * scale)]];
    // Isobar labels and H/L marks from the last render: hazard words move off them.
    for (NSInteger i = 0; i < _renderer.labelCount; i++) {
        double x = 0, y = 0, angle = 0, hw = 0, hh = 0;
        if (![_renderer labelAtIndex:i x:&x y:&y angle:&angle level:NULL halfW:&hw halfH:&hh]) continue;
        double ex = fabs(cos(angle)) * hw + fabs(sin(angle)) * hh, ey = fabs(sin(angle)) * hw + fabs(cos(angle)) * hh;
        [rects addObject:[NSValue valueWithRect:NSMakeRect(x - ex, y - ey, ex * 2, ey * 2)]];
    }
    for (NSInteger i = 0; i < _renderer.centreCount; i++) {
        double x = 0, y = 0;
        if (![_renderer centreAtIndex:i x:&x y:&y value:NULL high:NULL]) continue;
        [rects addObject:[NSValue valueWithRect:NSMakeRect(x - 16 * scale, y - 26 * scale, 32 * scale, 50 * scale)]];
    }
    for (NSView *view in @[_recenterButton, _flatButton, _globeSlider, _globeButton, _northButton]) {
        if (view.hidden) continue;
        NSRect f = NSInsetRect(view.frame, -4, -4);
        [rects addObject:[NSValue valueWithRect:NSMakeRect(f.origin.x * scale, f.origin.y * scale,
            f.size.width * scale, f.size.height * scale)]];
    }
    return rects;
}

- (CGImageRef)copyImageWithPlaces:(CGImageRef)image CF_RETURNS_RETAINED {
    size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    if (w < 2 || h < 2) return NULL;
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef c = CGBitmapContextCreate(NULL, w, h, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!c) return NULL;
    CGContextDrawImage(c, CGRectMake(0, 0, w, h), image);
    CGContextTranslateCTM(c, 0, h);
    CGContextScaleCTM(c, 1, -1);
    IsobarCamera camera = _camera;
    camera.viewportW = w;
    camera.viewportH = h;
    _snapshotPlaceNames = DrawPlaceNames(c, camera, [self pixelScale], [self mapIsDark], [self placeReservedRects],
        [self placeReading]);
    CGImageRef out = _snapshotPlaceNames.count ? CGBitmapContextCreateImage(c) : NULL;
    CGContextRelease(c);
    return out;
}

- (NSArray<NSString *> *)snapshotPlaceNames { return _snapshotPlaceNames ?: @[]; }

- (CGImageRef)copyImageWithHazards:(CGImageRef)image CF_RETURNS_RETAINED {
    size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    if (w < 2 || h < 2) return NULL;
    IsobarHazardFrame *frame = [self hazardFrameForStep:_fractionalStep synchronous:YES];
    [self updateHazardCauses:frame];
    NSDate *time = [self hazardTime];
    // Nothing to draw leaves the renderer's image as it is.
    if (!frame.areas.count && ![self validSigmetSignatureAt:time].length) {
        _snapshotHazardLabels = @[];
        return NULL;
    }
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef c = CGBitmapContextCreate(NULL, w, h, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!c) return NULL;
    CGContextDrawImage(c, CGRectMake(0, 0, w, h), image);
    CGContextTranslateCTM(c, 0, h);
    CGContextScaleCTM(c, 1, -1);
    IsobarCamera camera = _camera;
    camera.viewportW = w;
    camera.viewportH = h;
    IsobarHazardDraw(c, frame, _sigmets, time, camera, [self pixelScale], [self mapIsDark], YES,
        [self hazardReservedRects]);
    _snapshotHazardLabels = IsobarHazardLastLabels();
    CGImageRef out = CGBitmapContextCreateImage(c);
    CGContextRelease(c);
    return out;
}

- (NSString *)hazardTooltipAtPoint:(NSPoint)point {
    if (!_hazards || self.unavailable) return nil;
    [self syncViewport];
    NSPoint p = [self pixels:point];
    IsobarHazardFrame *frame = [self hazardFrameForStep:_fractionalStep synchronous:YES];
    [self updateHazardCauses:frame];
    return IsobarHazardTooltip(frame, _sigmets, [self hazardTime], _camera, p.x, p.y);
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if (_hazardTracking) {
        [self removeTrackingArea:_hazardTracking];
        _hazardTracking = nil;
    }
    if (!_hazards) return;
    _hazardTracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
        options:NSTrackingMouseMoved | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:_hazardTracking];
}

- (void)mouseMoved:(NSEvent *)event {
    [super mouseMoved:event];
    if (!_hazards) return;
    NSString *tip = [self hazardTooltipAtPoint:[self pointFromEvent:event]];
    if (tip != self.toolTip && ![tip isEqualToString:self.toolTip]) self.toolTip = tip;
}

- (NSPoint)pointFromEvent:(NSEvent *)event {
    return [self convertPoint:event.locationInWindow fromView:nil];
}

- (void)mouseDown:(NSEvent *)event {
    if (self.window) [self.window makeFirstResponder:self];
    [self pointerDown:[self pointFromEvent:event]];
}

- (void)mouseDragged:(NSEvent *)event {
    [self pointerDrag:[self pointFromEvent:event]];
}

- (void)mouseUp:(NSEvent *)event {
    [self pointerUp:[self pointFromEvent:event]];
}

- (void)magnifyWithEvent:(NSEvent *)event {
    if (event.phase == NSEventPhaseCancelled || !isfinite(event.magnification)) return;
    [self pinchFactor:1.0 + event.magnification atPoint:[self pointFromEvent:event]];
}

- (void)scrollWheel:(NSEvent *)event {
    NSPoint point = [self pointFromEvent:event];
    BOOL command = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
    [self scrollByX:event.scrollingDeltaX y:event.scrollingDeltaY atPoint:point
        precise:event.hasPreciseScrollingDeltas command:command];
}

- (void)keyDown:(NSEvent *)event {
    if (event.keyCode==53 && self.trafficSession.selectedHexes.count) {
        [self.trafficSession clearSelections]; [_trafficOverlay rebuildControls]; [_trafficOverlay setNeedsDisplay:YES];
        [_trafficOverlay showTrafficNotice:@"Tracks cleared"];
        if (self.onTrafficSelection) self.onTrafficSelection(@"", NO);
        return;
    }
    if ((event.modifierFlags & NSEventModifierFlagCommand) && !event.isARepeat) {
        NSString *ch = event.charactersIgnoringModifiers;
        if ([ch isEqualToString:@"="] || [ch isEqualToString:@"+"]) { [self zoomBy:1.25]; return; }
        if ([ch isEqualToString:@"-"] || [ch isEqualToString:@"_"]) { [self zoomBy:1.0 / 1.25]; return; }
    }
    if ([self handle3DKeyEvent:event]) return;
    if (!event.isARepeat) {
        NSString *characters = event.charactersIgnoringModifiers ?: @"";
        if ([characters rangeOfString:[NSString stringWithFormat:@"%C", (unichar)NSPageUpFunctionKey]].location != NSNotFound) {
            [self stepTiltBy:-kKeyboardTiltStep];
            return;
        }
        if ([characters rangeOfString:[NSString stringWithFormat:@"%C", (unichar)NSPageDownFunctionKey]].location != NSNotFound) {
            [self stepTiltBy:kKeyboardTiltStep];
            return;
        }
    }
    if ([self handleGlobeKey:event.charactersIgnoringModifiers repeat:event.isARepeat]) return;
    [super keyDown:event];
}

@end
