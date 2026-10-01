#import "atmosphereview.h"
#import "atmosphere.h"
#import "solar.h"
#import "aircraft.h"
#import <math.h>

static double AFEase(double x) { x=MIN(1,MAX(0,x)); return x*x*(3-2*x); }
static BOOL AFNumber(id x) { return [x isKindOfClass:NSNumber.class] && isfinite([x doubleValue]); }
static NSString *AFWindFrom(double degrees) {
    static NSArray<NSString *> *points;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ points=@[@"N",@"NNE",@"NE",@"ENE",@"E",@"ESE",@"SE",@"SSE",@"S",@"SSW",@"SW",@"WSW",@"W",@"WNW",@"NW",@"NNW"]; });
    return points[((NSInteger)llround(fmod(degrees+360.0,360.0)/22.5))%16];
}
static NSDate *AFDate(id value) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSString *s=value;
    if (s.length==16) s=[s stringByAppendingString:@":00Z"];
    static NSISO8601DateFormatter *f; static dispatch_once_t once;
    dispatch_once(&once,^{ f=[NSISO8601DateFormatter new]; }); return [f dateFromString:s];
}
static void AFText(NSString *text, NSRect rect, CGFloat size, NSColor *colour, BOOL bold) {
    NSMutableParagraphStyle *style=[NSMutableParagraphStyle new]; style.lineBreakMode=NSLineBreakByWordWrapping;
    [text drawInRect:rect withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size weight:bold?NSFontWeightSemibold:NSFontWeightRegular],NSForegroundColorAttributeName:colour,NSParagraphStyleAttributeName:style}];
}
static void AFLine(NSPoint a,NSPoint b,NSColor *colour,CGFloat width,BOOL dashed) {
    NSBezierPath *p=[NSBezierPath bezierPath]; p.lineWidth=width;
    if (dashed) { CGFloat d[]={4,4}; [p setLineDash:d count:2 phase:0]; }
    [p moveToPoint:a]; [p lineToPoint:b]; [colour setStroke]; [p stroke];
}
static void AFArrow(NSPoint centre,double dx,double dy,CGFloat length,NSColor *colour) {
    double magnitude=hypot(dx,dy); if (magnitude<.0001) return;
    dx/=magnitude; dy/=magnitude;
    NSPoint a=NSMakePoint(centre.x-dx*length/2,centre.y-dy*length/2), b=NSMakePoint(centre.x+dx*length/2,centre.y+dy*length/2);
    AFLine(a,b,colour,1.4,NO);
    AFLine(b,NSMakePoint(b.x-dx*4+dy*3,b.y-dy*4-dx*3),colour,1.4,NO);
    AFLine(b,NSMakePoint(b.x-dx*4-dy*3,b.y-dy*4+dx*3),colour,1.4,NO);
}
static NSImage *AFAsset(NSString *name) {
    static NSMutableDictionary *cache; static dispatch_once_t once;
    dispatch_once(&once,^{cache=[NSMutableDictionary dictionary];});
    if (cache[name]) return cache[name];
    NSString *path=[NSBundle.mainBundle pathForResource:name ofType:@"png" inDirectory:@"Aviation"];
    if (!path) path=[(NSProcessInfo.processInfo.environment[@"ISOBAR_AVIATION_ASSETS"]?:@"Resources/Aviation") stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    NSImage *source=[[NSImage alloc] initWithContentsOfFile:path]; if (!source || source.size.width<=0) return nil;
    NSSize size=NSMakeSize(384,384*source.size.height/source.size.width);
    NSImage *image=[[NSImage alloc] initWithSize:size]; [image lockFocus];
    [source drawInRect:(NSRect){NSZeroPoint,size} fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1]; [image unlockFocus];
    cache[name]=image; return image;
}
static void AFImage(NSString *name,NSRect rect,CGFloat alpha) {
    NSImage *image=AFAsset(name); if (!image) return;
    CGFloat ratio=image.size.width/image.size.height;
    CGFloat h=MIN(NSHeight(rect),NSWidth(rect)/ratio),w=h*ratio;
    rect=NSMakeRect(NSMidX(rect)-w/2,NSMidY(rect)-h/2,w,h);
    [image drawInRect:rect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:alpha respectFlipped:YES hints:@{NSImageHintInterpolation:@(NSImageInterpolationHigh)}];
}
static NSArray *AFMarkers(void) { return AircraftRecognitionCards(); }

@interface AtmosphereView ()
@property(nonatomic,strong) NSTimer *timer;
@property(nonatomic,strong) id occlusionObserver,motionObserver;
@property(nonatomic,strong) NSDate *selectedDate;
@property(nonatomic) NSInteger selectedLevelIndex;
@property(nonatomic) double selectedHeightM;
@property(nonatomic) NSTimeInterval animationTime,transitionStart,fromTime,toTime;
@property(nonatomic,copy) NSArray<NSNumber *> *markerFrom,*markerTo;
@property(nonatomic,strong) NSDictionary *sample;
@property(nonatomic,strong) NSDate *sampleDate;
@property(nonatomic,strong) NSButton *trafficButton;
@property(nonatomic,copy) NSString *trafficStatus;
@property(nonatomic) NSPoint hoverPoint,hoverAnchor;
@property(nonatomic,copy) NSDictionary *hoveredAircraft;
@property(nonatomic) BOOL hovering;
@property(nonatomic) BOOL draggingTimeline;
@property(nonatomic,copy) NSArray<NSDate *> *cachedTimes;
@property(nonatomic,strong) NSDateFormatter *dayClock,*hourClock;
@property(nonatomic,strong) NSMutableDictionary<NSNumber *,NSNumber *> *flowOffsets;
@end

@interface AtmosphereView (Drawing)
- (void)drawAircraftCard;
- (void)refreshAnimation;
@end

@implementation AtmosphereView
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        _product=@{}; _now=NSDate.date; _selectedDate=_now; _timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0];
        _latitude=NAN; _longitude=NAN; _selectedHeightM=1500; _animationTime=NSProcessInfo.processInfo.systemUptime;
        _fromTime=_toTime=_now.timeIntervalSince1970;
        _flowOffsets=[NSMutableDictionary dictionary];
        (void)AFAsset(@"cloud");
        for (NSDictionary *card in AFMarkers()) (void)AFAsset(card[@"name"]);
        _trafficButton=[NSButton checkboxWithTitle:@"Airborne now" target:self action:@selector(toggleTraffic:)];
        _trafficButton.frame=NSMakeRect(205,8,130,24); _trafficButton.font=[NSFont systemFontOfSize:12];
        _trafficButton.accessibilityIdentifier=@"atmosphere.traffic";
        _trafficButton.toolTip=@"Live ADS-B within 80 nautical miles of this airport. Returns the forecast to now.";
        [self addSubview:_trafficButton];
        __weak AtmosphereView *weak=self;
        _motionObserver=[NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { (void)n; [weak refreshAnimation]; weak.needsDisplay=YES; }];
    } return self;
}
- (void)dealloc {
    [_timer invalidate]; [_trafficClient stop];
    if (_occlusionObserver) [NSNotificationCenter.defaultCenter removeObserver:_occlusionObserver];
    if (_motionObserver) [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:_motionObserver];
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityImageRole; }
- (NSString *)accessibilityLabel { return @"Atmosphere: model weather and standard reference"; }
- (NSString *)accessibilityHelp { return @"Hover the time strip to change time. Click a height to inspect it. Aircraft mark typical flying levels. Arrow keys change time and height. Escape returns to now."; }
- (NSString *)accessibilityValue { return [self selectionSummary]; }
- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    if (_occlusionObserver) [NSNotificationCenter.defaultCenter removeObserver:_occlusionObserver]; _occlusionObserver=nil;
    if (self.window) {
        __weak AtmosphereView *weak=self;
        _occlusionObserver=[NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification object:self.window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { (void)n; [weak refreshAnimation]; }];
    } [self refreshAnimation];
}
- (void)viewDidHide { [super viewDidHide]; [self refreshAnimation]; }
- (void)viewDidUnhide { [super viewDidUnhide]; [self refreshAnimation]; }
- (void)refreshAnimation {
    BOOL visible=self.window.isVisible && !self.isHiddenOrHasHiddenAncestor && (self.window.occlusionState&NSWindowOcclusionStateVisible);
    if (visible && self.trafficEnabled && [self isLiveTime]) [self.trafficClient start]; else [self.trafficClient stop];
    visible=visible && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    if (!visible) { [_timer invalidate]; _timer=nil; return; }
    if (_timer) return;
    __weak AtmosphereView *weak=self;
    _timer=[NSTimer timerWithTimeInterval:1.0/60 repeats:YES block:^(NSTimer *t) { AtmosphereView *v=weak; if (!v) { [t invalidate]; return; } [v advanceAnimationAtTime:NSProcessInfo.processInfo.systemUptime]; }];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
}
- (BOOL)animationRunning { return _timer.valid; }
- (NSRect)timelineRect { return NSMakeRect(12,NSHeight(self.bounds)-76,NSWidth(self.bounds)-24,72); }
- (NSRect)plotRect { return NSMakeRect(62,55,MAX(1,NSWidth(self.bounds)-80),MAX(1,NSHeight(self.bounds)-196)); }
- (CGFloat)yForHeight:(double)height { NSRect p=self.plotRect; return NSMaxY(p)-NSHeight(p)*MIN(1,MAX(0,height/20000)); }
- (CGFloat)skyRight { return NSMaxX(self.plotRect)-MAX(156,NSWidth(self.plotRect)*.29); }
- (CGFloat)cloudRight { return self.skyRight-138; }
- (CGFloat)temperatureX:(double)temperature {
    CGFloat left=self.skyRight+24,right=NSMaxX(self.plotRect)-12;
    return left+(right-left)*MIN(1,MAX(0,(temperature+80)/110));
}
- (double)transitionProgress {
    double x=MIN(1,MAX(0,(self.animationTime-self.transitionStart)/.5));
    // Ease out immediately: restarting a zero-slope ease-in on every mouse
    // event leaves the sky almost frozen during a continuous sweep.
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?1:1-pow(1-x,4);
}
- (NSDate *)displayDate { double f=self.transitionProgress; return [NSDate dateWithTimeIntervalSince1970:self.fromTime*(1-f)+self.toTime*f]; }
- (NSArray *)markerTargets:(NSDate *)date {
    double hours=date.timeIntervalSince1970/3600;
    NSMutableArray *result=[NSMutableArray array];
    for (NSUInteger i=0;i<AFMarkers().count;i++) [result addObject:@(.18+.64*(.5+.5*sin(hours*.12+i*1.8)))];
    return result;
}
- (NSArray<NSValue *> *)aircraftMarkerRects {
    NSArray *target=self.markerTo?:[self markerTargets:self.selectedDate]; NSArray *from=self.markerFrom?:target;
    CGFloat left=NSMinX(self.plotRect)+12,width=MAX(1,self.cloudRight-left-42); double mix=self.transitionProgress;
    NSMutableArray *rects=[NSMutableArray array];
    for (NSUInteger i=0;i<AFMarkers().count;i++) {
        double fraction=[from[i] doubleValue]*(1-mix)+[target[i] doubleValue]*mix;
        CGFloat y=[self yForHeight:[AFMarkers()[i][@"height"] doubleValue]];
        [rects addObject:[NSValue valueWithRect:NSMakeRect(left+fraction*width,MAX(NSMinY(self.plotRect)+2,y-8),32,16)]];
    } return rects;
}
- (void)setNow:(NSDate *)now {
    BOOL atNow=[_selectedDate isEqual:_now]; _now=now?:NSDate.date;
    if (atNow) { _selectedDate=_now; _fromTime=_toTime=_now.timeIntervalSince1970; _markerFrom=_markerTo=[self markerTargets:_now]; }
    self.needsDisplay=YES;
}
- (void)setProduct:(NSDictionary *)product { _product=[product isKindOfClass:NSDictionary.class]?[product copy]:@{}; _sampleDate=nil; _cachedTimes=nil; self.needsDisplay=YES; }
- (void)inspectDate:(NSDate *)date {
    date=date?:self.now;
    if (!isfinite(date.timeIntervalSince1970)) return;
    NSArray *target=self.markerTo?:[self markerTargets:self.selectedDate],*from=self.markerFrom?:target;
    double f=self.transitionProgress; NSMutableArray *display=[NSMutableArray array];
    for (NSUInteger i=0;i<AFMarkers().count;i++) [display addObject:@([from[i] doubleValue]*(1-f)+[target[i] doubleValue]*f)];
    self.fromTime=self.displayDate.timeIntervalSince1970; self.toTime=date.timeIntervalSince1970;
    self.markerFrom=display; self.markerTo=[self markerTargets:date]; self.transitionStart=self.animationTime;
    self.selectedDate=date; self.hoveredAircraft=nil; [self refreshAnimation]; self.needsDisplay=YES;
    if (self.onInspect) self.onInspect([self selectionSummary]);
}
- (void)advanceAnimationAtTime:(NSTimeInterval)time {
    if (!isfinite(time)) return;
    double elapsed=MIN(.1,MAX(0,time-self.animationTime));
    if (time<self.animationTime) self.transitionStart+=time-self.animationTime;
    self.animationTime=time; self.needsDisplay=YES;
    if (!NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) for (NSDictionary *level in self.currentSample[@"levels"]) {
        NSNumber *key=level[@"pressureHpa"];
        double offset=[self.flowOffsets[key] doubleValue]+[level[@"windEastKt"] doubleValue]*elapsed*.20;
        self.flowOffsets[key]=@(fmod(offset,10000));
    }
    if (self.trafficEnabled && [self.selectedDate isEqual:self.now] && fabs(self.now.timeIntervalSinceNow)>=1) self.now=NSDate.date;
}
- (NSDictionary *)currentSample {
    NSDate *date=self.displayDate;
    if (![self.sampleDate isEqual:date]) { self.sample=AtmosphereAtDate(self.product,date); self.sampleDate=date; }
    return self.sample;
}
- (NSDictionary *)selectedLevel {
    NSArray *levels=self.currentSample[@"levels"]; double distance=INFINITY; NSDictionary *selected=nil;
    _selectedLevelIndex=-1;
    for (NSUInteger i=0;i<levels.count;i++) {
        NSDictionary *level=levels[i]; double delta=fabs([level[@"heightM"] doubleValue]-self.selectedHeightM);
        if (delta<distance && delta<1000) { distance=delta; selected=level; _selectedLevelIndex=(NSInteger)i; }
    } return selected;
}
- (NSString *)selectionSummary {
    NSDictionary *level=self.selectedLevel;
    if (!level) {
        NSDictionary *standard=StandardAtmosphereAtHeight(self.selectedHeightM);
        return [NSString stringWithFormat:@"Standard · %.0f ft · %.1f°C · %.0f hPa",self.selectedHeightM/0.3048,[standard[@"temperatureC"] doubleValue],[standard[@"pressureHpa"] doubleValue]];
    }
    NSString *(^value)(NSString *,NSString *)=^NSString *(NSString *key,NSString *format) { return AFNumber(level[key])?[NSString stringWithFormat:format,[level[key] doubleValue]]:@"—"; };
    double vertical=[level[@"verticalVelocityMS"] doubleValue];
    NSString *motion=AFNumber(level[@"verticalVelocityMS"])?[NSString stringWithFormat:@" · %@%.2f m/s",fabs(vertical)<.005?@"":vertical>0?@"↑ ":@"↓ ",fabs(vertical)]:@"";
    NSString *wind=AFNumber(level[@"windKt"])?[NSString stringWithFormat:@"%@ %.0f kt",AFNumber(level[@"windDegrees"])?AFWindFrom([level[@"windDegrees"] doubleValue]):@"Wind",[level[@"windKt"] doubleValue]]:@"—";
    return [NSString stringWithFormat:@"%.0f hPa · %.0f ft · %@ · RH %@ · %@%@",[level[@"pressureHpa"] doubleValue],[level[@"heightM"] doubleValue]/.3048,value(@"temperatureC",@"%.1f°C"),value(@"humidityPct",@"%.0f%%"),wind,motion];
}
- (NSString *)explanation {
    NSDictionary *level=self.selectedLevel;
    if (!level) return self.selectedHeightM>=11000?@"Standard reference: temperature stays near −56.5°C in the lower stratosphere. Model coverage ends below this height.":@"Standard reference: temperature falls 6.5°C per kilometre up to 11 km. No model sample at this height.";
    for (NSDictionary *inversion in self.currentSample[@"inversions"])
        if ([level[@"heightM"] doubleValue]>=[inversion[@"fromM"] doubleValue] && [level[@"heightM"] doubleValue]<=[inversion[@"toM"] doubleValue])
            return @"Inversion · warmer air above limits vertical mixing.";
    if (AFNumber(level[@"verticalVelocityMS"])) {
        double w=[level[@"verticalVelocityMS"] doubleValue];
        if (w>=.005) return @"Rising air expands and cools toward saturation.";
        if (w<=-.005) return @"Sinking air compresses and warms, lowering relative humidity.";
    }
    if (AFNumber(level[@"humidityPct"])) {
        double humidity=[level[@"humidityPct"] doubleValue];
        if (humidity<35) return @"Dry air · ascent cools it toward saturation.";
        if (humidity>=90) return @"Near saturation · further cooling favours cloud.";
        return @"Cooling raises relative humidity toward cloud formation.";
    }
    return @"Temperature and height come from the model. Moisture is not available for this sample.";
}
- (NSArray<NSDate *> *)forecastTimes {
    if (self.cachedTimes) return self.cachedTimes;
    NSMutableArray *dates=[NSMutableArray array];
    for (id value in self.product[@"time"]) { NSDate *d=AFDate(value); if (d) [dates addObject:d]; }
    self.cachedTimes=dates; return self.cachedTimes;
}
- (NSString *)clock:(NSDate *)date day:(BOOL)day {
    NSDateFormatter *f=day?self.dayClock:self.hourClock;
    if (!f) { f=[NSDateFormatter new]; f.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"]; f.dateFormat=day?@"EEE HH:mm":@"HH:mm"; if (day) self.dayClock=f; else self.hourClock=f; }
    f.timeZone=self.timeZone; return [f stringFromDate:date];
}
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect; [self refreshAnimation];
    [NSColor.windowBackgroundColor setFill]; NSRectFill(self.bounds);
    NSRect p=self.plotRect; NSColor *ink=[NSColor colorWithSRGBRed:.18 green:.25 blue:.33 alpha:1],*muted=[NSColor colorWithSRGBRed:.40 green:.46 blue:.53 alpha:1];
    NSDate *date=self.displayDate; double sun=SolarElevation(self.latitude,self.longitude,date);
    double night=isfinite(sun)?1-AFEase((sun+8)/10):0;
    NSColor *sky=[[NSColor colorWithSRGBRed:.85 green:.93 blue:.96 alpha:1] blendedColorWithFraction:night*.65 ofColor:[NSColor colorWithSRGBRed:.67 green:.73 blue:.85 alpha:1]];
    NSGradient *gradient=[[NSGradient alloc] initWithStartingColor:[sky blendedColorWithFraction:.18 ofColor:NSColor.whiteColor] endingColor:sky];
    [gradient drawInRect:p angle:90];
    // Keep the three reading lanes distinct without turning the column into
    // a dashboard: moisture/clouds, wind and temperature each get a quiet
    // tint and a hairline boundary.
    [[NSColor.systemTealColor colorWithAlphaComponent:.045] setFill];
    NSRectFillUsingOperation(NSMakeRect(NSMinX(p),NSMinY(p),self.cloudRight-NSMinX(p),NSHeight(p)),NSCompositingOperationSourceOver);
    [[NSColor.systemBlueColor colorWithAlphaComponent:.035] setFill];
    NSRectFillUsingOperation(NSMakeRect(self.cloudRight,NSMinY(p),self.skyRight-self.cloudRight,NSHeight(p)),NSCompositingOperationSourceOver);
    [[NSColor.systemOrangeColor colorWithAlphaComponent:.035] setFill];
    NSRectFillUsingOperation(NSMakeRect(self.skyRight,NSMinY(p),NSMaxX(p)-self.skyRight,NSHeight(p)),NSCompositingOperationSourceOver);
    AFLine(NSMakePoint(self.cloudRight,NSMinY(p)),NSMakePoint(self.cloudRight,NSMaxY(p)),[NSColor.separatorColor colorWithAlphaComponent:.28],.5,NO);
    AFLine(NSMakePoint(self.skyRight,NSMinY(p)),NSMakePoint(self.skyRight,NSMaxY(p)),[NSColor.separatorColor colorWithAlphaComponent:.28],.5,NO);
    CGFloat tropopause=[self yForHeight:11000];
    [[NSColor colorWithSRGBRed:.53 green:.64 blue:.81 alpha:.10] setFill]; NSRectFillUsingOperation(NSMakeRect(NSMinX(p),NSMinY(p),NSWidth(p),tropopause-NSMinY(p)),NSCompositingOperationSourceOver);
    AFText([NSString stringWithFormat:@"%@ · Atmosphere",self.product[@"id"]?:@"Airport"],NSMakeRect(18,10,182,22),16,NSColor.labelColor,YES);
    NSString *phase=!isfinite(sun)?@"":sun< -6?@"Civil night":sun< -50.0/60?@"Civil twilight":@"Day";
    AFText([NSString stringWithFormat:@"%@ · %@",[self clock:date day:YES],phase],NSMakeRect(NSWidth(self.bounds)-240,13,225,20),12,NSColor.secondaryLabelColor,NO);
    AFText(@"ft AMSL",NSMakeRect(6,36,60,16),10,NSColor.secondaryLabelColor,NO);
    AFText(@"Cloud · RH · W–E",NSMakeRect(NSMinX(p)+8,35,160,16),11,NSColor.secondaryLabelColor,NO);
    AFText(@"ECMWF",NSMakeRect(self.cloudRight-48,35,48,16),10,NSColor.secondaryLabelColor,NO);
    AFText(@"Wind → · kt",NSMakeRect(self.skyRight-127,35,82,16),10,NSColor.secondaryLabelColor,NO);
    AFText(@"Vertical · m/s",NSMakeRect(self.skyRight-58,35,65,16),10,NSColor.secondaryLabelColor,NO);
    AFText(@"Temp · °C",NSMakeRect(self.skyRight+16,35,NSMaxX(p)-self.skyRight-16,16),11,NSColor.secondaryLabelColor,NO);
    for (double feet=0;feet<=60000;feet+=10000) {
        CGFloat y=[self yForHeight:feet*.3048];
        AFLine(NSMakePoint(NSMinX(p),y),NSMakePoint(NSMaxX(p),y),[muted colorWithAlphaComponent:.15],.5,NO);
        AFText(feet==0?@"0":[NSString stringWithFormat:@"%.0fk",feet/1000],NSMakeRect(20,y-7,40,15),10,NSColor.secondaryLabelColor,NO);
    }
    AFLine(NSMakePoint(NSMinX(p),tropopause),NSMakePoint(NSMaxX(p),tropopause),[muted colorWithAlphaComponent:.55],1,YES);
    // Keep the labels in the left side of the cloud lane, away from the wind
    // and temperature values; the ruler remains sparse without extra cards.
    NSRect tropoLabel=NSMakeRect(NSMinX(p)+4,tropopause+5,120,18);
    NSRect stratoLabel=NSMakeRect(NSMinX(p)+4,NSMinY(p)+7,150,18);
    NSRect tropopauseLabel=NSMakeRect(NSMinX(p)+4,tropopause-19,MAX(1,MIN(180,self.cloudRight-NSMinX(p)-8)),18);
    AFText(@"ISA tropopause · 36,100 ft",tropopauseLabel,10,muted,NO);
    AFText(@"Lower stratosphere",stratoLabel,11,muted,NO);
    AFText(@"Troposphere",tropoLabel,11,muted,NO);
    NSBezierPath *standard=[NSBezierPath bezierPath]; CGFloat dash[]={4,4}; [standard setLineDash:dash count:2 phase:0]; standard.lineWidth=1;
    for (NSUInteger i=0;i<=40;i++) {
        double h=i*500; NSPoint point=NSMakePoint([self temperatureX:[StandardAtmosphereAtHeight(h)[@"temperatureC"] doubleValue]],[self yForHeight:h]);
        if (!i) [standard moveToPoint:point]; else [standard lineToPoint:point];
    }
    [[muted colorWithAlphaComponent:.75] setStroke]; [standard stroke];
    for (double temp=-60;temp<=20;temp+=40) AFText([NSString stringWithFormat:@"%.0f",temp],NSMakeRect([self temperatureX:temp]-12,NSMaxY(p)+3,30,14),9,NSColor.secondaryLabelColor,NO);
    NSDictionary *sample=self.currentSample; NSArray *levels=sample[@"levels"];
    [NSGraphicsContext saveGraphicsState]; [[NSBezierPath bezierPathWithRect:p] addClip];
    for (NSDictionary *inversion in sample[@"inversions"]) {
        CGFloat a=[self yForHeight:[inversion[@"toM"] doubleValue]],b=[self yForHeight:[inversion[@"fromM"] doubleValue]];
        [[NSColor.systemOrangeColor colorWithAlphaComponent:.12] setFill]; NSRectFillUsingOperation(NSMakeRect(NSMinX(p),a,self.skyRight-NSMinX(p),MAX(1,b-a)),NSCompositingOperationSourceOver);
    }
    NSDictionary *previous=nil;
    for (NSDictionary *level in levels) {
        double height=[level[@"heightM"] doubleValue]; if (height<0 || height>20000) continue;
        CGFloat y=[self yForHeight:height],left=NSMinX(p)+6,width=MAX(1,self.cloudRight-left-8);
        if (AFNumber(level[@"humidityPct"])) {
            [[NSColor colorWithSRGBRed:.27 green:.58 blue:.75 alpha:.11] setFill];
            NSRectFillUsingOperation(NSMakeRect(left,y-5,width*[level[@"humidityPct"] doubleValue]/100,10),NSCompositingOperationSourceOver);
        }
        if (AFNumber(level[@"cloudPct"]) && [level[@"cloudPct"] doubleValue]>0) {
            double cover=[level[@"cloudPct"] doubleValue]/100;
            CGFloat cloudW=MIN(170,width*.5),spread=MAX(1,width-cloudW);
            for (NSUInteger j=0;j<3;j++) AFImage(@"cloud",NSMakeRect(left+spread*j/2,y-24,cloudW,36),cover*.8);
        }
        if (AFNumber(level[@"windEastKt"])) {
            double east=[level[@"windEastKt"] doubleValue];
            // This is the west/east component only. The compass column carries
            // the full horizontal direction; vertical motion has its own lane.
            CGFloat phase=fmod([self.flowOffsets[level[@"pressureHpa"]] doubleValue],width/3); if (phase<0) phase+=width/3;
            for (NSUInteger j=0;j<3;j++) AFArrow(NSMakePoint(left+fmod(j*width/3+phase,width),y+4),east,0,9,[muted colorWithAlphaComponent:.38]);
        }
        if (AFNumber(level[@"temperatureC"])) {
            NSPoint point=NSMakePoint([self temperatureX:[level[@"temperatureC"] doubleValue]],y);
            if (previous && AFNumber(previous[@"temperatureC"])) AFLine(NSMakePoint([self temperatureX:[previous[@"temperatureC"] doubleValue]],[self yForHeight:[previous[@"heightM"] doubleValue]]),point,NSColor.systemOrangeColor,2,NO);
            [NSColor.systemOrangeColor setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(point.x-2,point.y-2,4,4)] fill];
        }
        previous=level;
    }
    CGFloat lastLabelY=-CGFLOAT_MAX;
    for (NSDictionary *level in [levels reverseObjectEnumerator]) {
        double height=[level[@"heightM"] doubleValue]; if (height<0 || height>20000) continue;
        CGFloat y=[self yForHeight:height];
        if (y<NSMinY(p)+9 || y>NSMaxY(p)-9) continue;
        if (y-lastLabelY<22) continue;
        lastLabelY=y;
        double u=[level[@"windEastKt"] doubleValue],v=[level[@"windNorthKt"] doubleValue];
        if (AFNumber(level[@"windKt"])) {
            NSColor *windInk=[NSColor colorWithSRGBRed:.16 green:.38 blue:.49 alpha:.82];
            if (AFNumber(level[@"windDegrees"])) AFArrow(NSMakePoint(self.skyRight-116,y),u,-v,16,windInk);
            AFText([NSString stringWithFormat:@"%.0f",[level[@"windKt"] doubleValue]],NSMakeRect(self.skyRight-103,y-7,39,16),11,windInk,YES);
        }
        if (AFNumber(level[@"verticalVelocityMS"])) {
            double w=[level[@"verticalVelocityMS"] doubleValue];
            NSColor *colour=fabs(w)<.005?muted:w>=0?[NSColor colorWithSRGBRed:.08 green:.43 blue:.51 alpha:1]:[NSColor colorWithSRGBRed:.62 green:.36 blue:.19 alpha:1];
            if (fabs(w)>=.005) AFArrow(NSMakePoint(self.skyRight-53,y),0,-w,MIN(17,8+fabs(w)*15),colour);
            AFText([NSString stringWithFormat:@"%.2f",fabs(w)],NSMakeRect(self.skyRight-43,y-7,42,16),9,colour,YES);
        } else AFText(@"—",NSMakeRect(self.skyRight-40,y-7,36,16),10,muted,NO);
    }
    for (NSNumber *height in sample[@"freezingHeightsM"]) {
        CGFloat y=[self yForHeight:height.doubleValue];
        AFLine(NSMakePoint(NSMinX(p),y),NSMakePoint(self.cloudRight,y),[NSColor.systemBlueColor colorWithAlphaComponent:.6],1,YES);
        AFText([NSString stringWithFormat:@"0°C · %.0f ft",height.doubleValue/.3048],NSMakeRect(self.cloudRight-111,y-17,109,15),10,ink,YES);
    }
    NSDictionary *level=self.selectedLevel; double inspected=level?[level[@"heightM"] doubleValue]:self.selectedHeightM;
    CGFloat selectedY=[self yForHeight:inspected];
    [[NSColor.controlAccentColor colorWithAlphaComponent:.10] setFill];
    NSRectFillUsingOperation(NSMakeRect(NSMinX(p),MAX(NSMinY(p),selectedY-4),NSWidth(p),8),NSCompositingOperationSourceOver);
    AFLine(NSMakePoint(NSMinX(p),selectedY),NSMakePoint(NSMaxX(p),selectedY),[NSColor.controlAccentColor colorWithAlphaComponent:.60],1,NO);
    [[NSColor.controlAccentColor colorWithAlphaComponent:.85] setFill];
    NSRectFill(NSMakeRect(NSMinX(p),selectedY-3,4,6));
    NSArray *markers=self.aircraftMarkerRects;
    BOOL liveMode=self.trafficEnabled && [self isLiveTime];
    for (NSUInteger i=0;i<markers.count;i++) AFImage(AFMarkers()[i][@"name"],[markers[i] rectValue],liveMode?.5:.9);
    if (!liveMode) {
        if (self.trafficEnabled) AFText(@"Illustrated · forecast time",NSMakeRect(NSMinX(p)+8,NSMinY(p)+30,210,16),10,ink,NO);
    } else {
        NSArray *live=self.liveAircraft,*rects=self.liveAircraftRects;
        for (NSUInteger i=0;i<live.count;i++) {
            NSRect r=[rects[i] rectValue]; CGFloat x=NSMidX(r),y=NSMidY(r);
            NSBezierPath *icon=[NSBezierPath bezierPath];
            [icon moveToPoint:NSMakePoint(x+12,y)]; [icon lineToPoint:NSMakePoint(x-10,y-8)];
            [icon lineToPoint:NSMakePoint(x-6,y)]; [icon lineToPoint:NSMakePoint(x-10,y+8)]; [icon closePath];
            [[NSColor colorWithSRGBRed:0 green:.43 blue:.58 alpha:1] setFill]; [icon fill];
            AFText(live[i][@"type"],NSMakeRect(x-19,y+10,45,13),9,ink,YES);
        }
        NSString *status=self.trafficStatus.length?self.trafficStatus:!self.trafficSnapshot?@"Finding nearby aircraft…":live.count?[NSString stringWithFormat:@"%lu live · pressure ft · ADSB.lol · 80 nm",(unsigned long)live.count]:@"No recent airborne signals · ADSB.lol";
        AFText(status,NSMakeRect(NSMinX(p)+8,NSMinY(p)+30,self.skyRight-NSMinX(p)-16,28),10,ink,NO);
    }
    [NSGraphicsContext restoreGraphicsState];
    CGFloat footer=NSMaxY(p)+19;
    AFText([self selectionSummary],NSMakeRect(18,footer,NSWidth(self.bounds)-36,18),11,NSColor.labelColor,YES);
    AFText([self explanation],NSMakeRect(18,footer+19,NSWidth(self.bounds)-36,28),11,NSColor.secondaryLabelColor,NO);
    AFText(@"Solid: model  ·  Dashed: standard",NSMakeRect(self.skyRight+4,NSMinY(p)+10,NSMaxX(p)-self.skyRight-8,30),9,muted,NO);
    if (!sample) AFText(@"No model profile for this time",NSMakeRect(NSMinX(p)+8,NSMaxY(p)-40,260,18),11,muted,YES);
    [self drawTimeline];
    [self drawAircraftCard];
}
- (void)drawTimeline {
    NSRect r=self.timelineRect; NSArray *times=self.forecastTimes;
    if (!times.count) { AFText(@"Model hours unavailable",r,11,NSColor.secondaryLabelColor,NO); return; }
    NSDate *first=times.firstObject,*last=times.lastObject; double span=MAX(1,[last timeIntervalSinceDate:first]);
    [[NSColor.labelColor colorWithAlphaComponent:.045] setFill]; [[NSBezierPath bezierPathWithRoundedRect:r xRadius:8 yRadius:8] fill];
    CGFloat left=NSMinX(r)+12,width=NSWidth(r)-24,y=NSMinY(r)+22;
    AFLine(NSMakePoint(left,y),NSMakePoint(left+width,y),[NSColor.secondaryLabelColor colorWithAlphaComponent:.2],5,NO);
    for (NSUInteger i=0;i<times.count;i+=MAX(1,times.count/5)) {
        CGFloat x=left+width*[times[i] timeIntervalSinceDate:first]/span;
        AFText([self clock:times[i] day:YES],NSMakeRect(MIN(NSMaxX(r)-75,MAX(NSMinX(r),x-35)),y+9,75,15),9,NSColor.secondaryLabelColor,NO);
    }
    CGFloat x=left+width*MIN(1,MAX(0,[self.selectedDate timeIntervalSinceDate:first]/span));
    [NSColor.controlAccentColor setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x-7,y-7,14,14)] fill];
}
- (void)inspectPoint:(NSPoint)point {
    if (self.draggingTimeline || NSPointInRect(point,self.timelineRect)) {
        NSArray *times=self.forecastTimes; if (!times.count) return;
        double f=MIN(1,MAX(0,(point.x-NSMinX(self.timelineRect)-12)/MAX(1,NSWidth(self.timelineRect)-24)));
        [self inspectDate:[times.firstObject dateByAddingTimeInterval:[times.lastObject timeIntervalSinceDate:times.firstObject]*f]];
    }
}
- (void)mouseMoved:(NSEvent *)event {
    NSPoint point=[self convertPoint:event.locationInWindow fromView:nil];
    NSRect oldCard=self.hoverCardRect;
    NSRect transit=NSUnionRect(oldCard,NSMakeRect(self.hoverAnchor.x-18,self.hoverAnchor.y-12,36,24));
    BOOL keep=self.hoveredAircraft && NSPointInRect(point,transit);
    self.hoverPoint=point; self.hovering=YES;
    if (!keep) {
        self.hoveredAircraft=nil;
        NSArray *rects=[self.liveAircraftRects arrayByAddingObjectsFromArray:self.aircraftMarkerRects];
        NSArray *cards=[self.liveAircraft arrayByAddingObjectsFromArray:AFMarkers()];
        for (NSUInteger i=0;i<rects.count;i++) if (NSPointInRect(point,NSInsetRect([rects[i] rectValue],-10,-8))) { self.hoveredAircraft=cards[i]; self.hoverAnchor=point; break; }
    }
    [self inspectPoint:point]; self.needsDisplay=YES;
}
- (void)mouseExited:(NSEvent *)event { (void)event; self.hovering=NO; self.hoveredAircraft=nil; self.needsDisplay=YES; }
- (void)mouseDragged:(NSEvent *)event { if (self.draggingTimeline) [self inspectPoint:[self convertPoint:event.locationInWindow fromView:nil]]; }
- (void)mouseUp:(NSEvent *)event { if (self.draggingTimeline) [self mouseDragged:event]; self.draggingTimeline=NO; }
- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self]; NSPoint p=[self convertPoint:event.locationInWindow fromView:nil];
    NSDictionary *card=[self hoveredCard];
    if (card && NSPointInRect(p,self.hoverCardRect) && [card[@"source"] length]) {
        [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:card[@"source"]]]; return;
    }
    if (NSPointInRect(p,self.timelineRect)) { self.draggingTimeline=YES; [self inspectPoint:p]; return; }
    if (!NSPointInRect(p,self.plotRect)) return;
    self.selectedHeightM=MIN(20000,MAX(0,(NSMaxY(self.plotRect)-p.y)/NSHeight(self.plotRect)*20000));
    self.needsDisplay=YES; if (self.onInspect) self.onInspect(self.selectionSummary);
}
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode==53) { [self inspectDate:self.now]; return; }
    if (event.keyCode==123 || event.keyCode==124) {
        NSArray *times=self.forecastTimes; if (!times.count) return;
        NSDate *date=[self.selectedDate dateByAddingTimeInterval:event.keyCode==123?-3600:3600];
        if ([date compare:times.firstObject]==NSOrderedAscending) date=times.firstObject;
        if ([date compare:times.lastObject]==NSOrderedDescending) date=times.lastObject;
        [self inspectDate:date]; return;
    }
    if (event.keyCode==126 || event.keyCode==125) { self.selectedHeightM=MIN(20000,MAX(0,self.selectedHeightM+(event.keyCode==126?1000:-1000))); self.needsDisplay=YES; return; }
    [super keyDown:event];
}
- (void)updateTrackingAreas {
    [super updateTrackingAreas]; for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
    [self removeAllToolTips]; [self addToolTipRect:self.plotRect owner:self userData:NULL];
    [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveAlways|NSTrackingInVisibleRect owner:self userInfo:nil]];
}
- (NSString *)view:(NSView *)view stringForToolTip:(NSToolTipTag)tag point:(NSPoint)point userData:(void *)data {
    (void)view; (void)tag; (void)data;
    (void)point; // Recognition cards are rendered immediately, without a tooltip delay.
    return @"Fixed 0–20 km AMSL. Sky trails show west–east wind. Wind arrows use north-up compass direction; speed is in knots. Lift arrows show model ascent or descent in m/s. Animation speed is schematic. Click a height to inspect.";
}
- (void)resetCursorRects { [self addCursorRect:self.timelineRect cursor:NSCursor.pointingHandCursor]; [self addCursorRect:self.plotRect cursor:NSCursor.crosshairCursor]; }

- (BOOL)isLiveTime { return [self.selectedDate isEqual:self.now]; }
- (void)setTrafficClient:(AirborneTraffic *)client {
    [_trafficClient stop]; _trafficClient.onUpdate=nil; _trafficClient=client;
    _trafficSnapshot=nil; _trafficStatus=nil;
    __weak AtmosphereView *weak=self;
    client.onUpdate=^(NSDictionary *snapshot,NSString *status) {
        AtmosphereView *view=weak; if (!view) return;
        view.trafficSnapshot=snapshot;
        view.trafficStatus=status; view.needsDisplay=YES;
    };
    [self refreshAnimation];
}
- (void)setTrafficSnapshot:(NSDictionary *)snapshot {
    _trafficSnapshot=[snapshot copy];
    NSString *hoveredAddress=self.hoveredAircraft[@"hex"];
    if (hoveredAddress) {
        self.hoveredAircraft=nil;
        for (NSDictionary *aircraft in TrafficVisibleAircraft(snapshot,NSDate.date)) if ([aircraft[@"hex"] isEqual:hoveredAddress]) { self.hoveredAircraft=aircraft; break; }
    }
    self.needsDisplay=YES;
}
- (void)setTrafficEnabled:(BOOL)enabled {
    self.hoveredAircraft=nil; _trafficEnabled=enabled; _trafficButton.state=enabled?NSControlStateValueOn:NSControlStateValueOff;
    [self refreshAnimation]; self.needsDisplay=YES;
}
- (void)toggleTraffic:(NSButton *)sender {
    if (sender.state==NSControlStateValueOn) { self.now=NSDate.date; [self inspectDate:self.now]; }
    self.trafficEnabled=sender.state==NSControlStateValueOn;
}
- (NSArray<NSDictionary *> *)liveAircraft {
    return self.trafficEnabled && [self isLiveTime]?TrafficVisibleAircraft(self.trafficSnapshot,NSDate.date):@[];
}
- (NSArray<NSValue *> *)liveAircraftRects {
    NSMutableArray *result=[NSMutableArray array];
    CGFloat left=NSMinX(self.plotRect)+24,width=self.skyRight-left-38;
    for (NSDictionary *aircraft in self.liveAircraft) {
        // Start west-to-east, then spread nearby symbols horizontally so every
        // aircraft can be hovered. This is a vertical schematic, not a map.
        double east=([aircraft[@"longitude"] doubleValue]-self.longitude)*60*cos(self.latitude*M_PI/180);
        double fraction=MIN(1,MAX(0,.5+east/160));
        CGFloat y=[self yForHeight:[aircraft[@"pressureAltitudeFt"] doubleValue]*.3048];
        NSRect rect=NSMakeRect(left+width*fraction-14,MAX(NSMinY(self.plotRect)+2,y-9),28,18);
        for (NSUInteger attempt=0;attempt<20;attempt++) {
            BOOL collision=NO;
            for (NSValue *previous in result) if (NSIntersectsRect(NSInsetRect(previous.rectValue,-4,-7),rect)) { collision=YES; break; }
            if (!collision) break;
            double offset=(attempt/2+1)*36*(attempt%2?-1:1);
            rect.origin.x=MIN(self.skyRight-30,MAX(left-14,left+width*fraction-14+offset));
        }
        [result addObject:[NSValue valueWithRect:rect]];
    } return result;
}
- (NSDictionary *)hoveredCard {
    if (!self.hovering) return nil;
    if (self.hoveredAircraft[@"hex"] && (![self isLiveTime] || [NSDate.date timeIntervalSinceDate:self.hoveredAircraft[@"positionTime"]]>90)) return nil;
    return self.hoveredAircraft;
}
- (NSString *)hoverCardSummary {
    NSDictionary *card=self.hoveredCard; if (!card) return nil;
    if (card[@"hex"]) {
        NSString *speed=card[@"groundSpeedKt"]?[NSString stringWithFormat:@"%.0f kt ground speed",[card[@"groundSpeedKt"] doubleValue]]:@"Speed unavailable";
        NSString *track=card[@"trackDegrees"]?[NSString stringWithFormat:@" · %03.0f° track",[card[@"trackDegrees"] doubleValue]]:@"";
        double age=MAX(0,[NSDate.date timeIntervalSinceDate:card[@"positionTime"]]);
        return [NSString stringWithFormat:@"%@ · %@\nPressure altitude %.0f ft\n%@%@\n%.0f nm from %@ · %.0f s ago\nADSB.lol · ODbL",card[@"callsign"],[card[@"type"] length]?card[@"type"]:@"Type unknown",[card[@"pressureAltitudeFt"] doubleValue],speed,track,[card[@"distanceNm"] doubleValue],self.product[@"id"]?:@"airport",age];
    }
    return [NSString stringWithFormat:@"%@ · %@\n%@\n%@\n%.0f ft standard reference",card[@"title"],card[@"nickname"],card[@"recognition"],card[@"history"],[card[@"height"] doubleValue]/.3048];
}
- (NSRect)hoverCardRect {
    if (!self.hoveredCard) return NSZeroRect;
    NSRect p=self.plotRect; CGFloat width=MIN(310,NSWidth(p)-16),height=MIN(148,NSHeight(p)-8);
    CGFloat x=self.hoverAnchor.x+20;
    if (x+width>NSMaxX(p)-4) x=self.hoverAnchor.x-width-20;
    return NSMakeRect(MAX(NSMinX(p)+4,x),MIN(NSMaxY(p)-height-4,MAX(NSMinY(p)+4,self.hoverAnchor.y-height/2)),width,height);
}
- (void)drawAircraftCard {
    NSDictionary *card=self.hoveredCard; if (!card) return;
    NSRect r=self.hoverCardRect;
    NSBezierPath *box=[NSBezierPath bezierPathWithRoundedRect:r xRadius:9 yRadius:9];
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:.98] setFill]; [box fill];
    [[NSColor.separatorColor colorWithAlphaComponent:.8] setStroke]; box.lineWidth=1; [box stroke];
    if (card[@"hex"]) {
        AFText(self.hoverCardSummary,NSInsetRect(r,12,10),12,NSColor.labelColor,NO); return;
    }
    AFImage(card[@"name"],NSMakeRect(NSMaxX(r)-96,NSMinY(r)+4,88,44),1);
    AFText(card[@"title"],NSMakeRect(NSMinX(r)+12,NSMinY(r)+10,NSWidth(r)-110,19),13,NSColor.labelColor,YES);
    AFText(card[@"nickname"],NSMakeRect(NSMinX(r)+12,NSMinY(r)+29,NSWidth(r)-110,18),11,NSColor.secondaryLabelColor,NO);
    AFText(card[@"recognition"],NSMakeRect(NSMinX(r)+12,NSMinY(r)+52,NSWidth(r)-24,31),11,NSColor.labelColor,NO);
    AFText(card[@"history"],NSMakeRect(NSMinX(r)+12,NSMinY(r)+85,NSWidth(r)-24,31),11,NSColor.secondaryLabelColor,NO);
    AFText([NSString stringWithFormat:@"%.0f ft · standard reference",[card[@"height"] doubleValue]/.3048],NSMakeRect(NSMinX(r)+12,NSMaxY(r)-22,NSWidth(r)-85,16),10,NSColor.secondaryLabelColor,NO);
    AFText(@"Story ↗",NSMakeRect(NSMaxX(r)-65,NSMaxY(r)-22,55,16),11,NSColor.linkColor,NO);
}
@end
