#import "aviationview.h"
#import "playheadcursor.h"
#import "solar.h"
#import <math.h>

static NSNumber *AVNumber(id x) {
    return [x isKindOfClass:NSNumber.class] && isfinite([x doubleValue]) && [x doubleValue]>=0 ? x : nil;
}
static NSArray *AVLayers(NSDictionary *period) {
    NSArray *source=[period[@"cloudLayers"] isKindOfClass:NSArray.class]?period[@"cloudLayers"]:@[];
    NSMutableArray *layers=[NSMutableArray array];
    for (id layer in source) if ([layer isKindOfClass:NSDictionary.class]) [layers addObject:layer];
    if (!layers.count && AVNumber(period[@"ceilingFt"]))
        [layers addObject:@{@"amount":@"Ceiling",@"baseFt":period[@"ceilingFt"],@"type":@""}];
    return layers;
}
static NSString *AVAircraft(double feet) {
    return feet>=50000?@"sr71":feet>=25000?@"jumbo":feet>=10000?@"pc9":@"plane";
}
static NSString *AVPeriodKey(NSDictionary *period) {
    return [NSString stringWithFormat:@"%@/%@/%@",period[@"start"],period[@"change"],period[@"raw"]];
}
static double AVEase(double progress) {
    progress=MIN(1,MAX(0,progress)); return progress*progress*(3-2*progress);
}
static CGFloat AVCloudLeft(NSRect rect) { return NSMinX(rect)+MIN(104,MAX(68,NSWidth(rect)*.28)); }
static BOOL AVConditional(NSDictionary *p) {
    NSString *kind=p[@"change"];
    return [kind hasPrefix:@"PROB"] || [@[@"INTER",@"TEMPO",@"BECMG"] containsObject:kind];
}
static NSString *AVBadge(NSDictionary *p) {
    NSString *kind=p[@"change"];
    if (!AVConditional(p)) return @"Prevailing";
    return [[kind stringByReplacingOccurrencesOfString:@"PROB30" withString:@"30%"]
        stringByReplacingOccurrencesOfString:@"PROB40" withString:@"40%"];
}
static NSString *AVTime(NSDate *date, NSTimeZone *zone, BOOL day) {
    NSDateFormatter *f=[NSDateFormatter new];
    f.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone=zone; f.dateFormat=day?@"EEE HH:mm":@"HH:mm";
    return [f stringFromDate:date];
}
static NSString *AVFeet(NSNumber *feet) {
    NSNumberFormatter *f=[NSNumberFormatter new]; f.numberStyle=NSNumberFormatterDecimalStyle;
    f.maximumFractionDigits=0; f.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU"];
    return [[f stringFromNumber:feet] stringByAppendingString:@" ft"];
}
static void AVText(NSString *text, NSRect rect, CGFloat size, NSColor *colour, BOOL bold, NSTextAlignment align) {
    NSMutableParagraphStyle *style=[NSMutableParagraphStyle new];
    style.alignment=align; style.lineBreakMode=NSLineBreakByTruncatingTail;
    [text drawInRect:rect withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size
        weight:bold?NSFontWeightSemibold:NSFontWeightRegular],NSForegroundColorAttributeName:colour,NSParagraphStyleAttributeName:style}];
}
static void AVLine(NSPoint a, NSPoint b, NSColor *colour, CGFloat width, BOOL dashed) {
    NSBezierPath *path=[NSBezierPath bezierPath]; path.lineWidth=width;
    if (dashed) { CGFloat pattern[]={4,3}; [path setLineDash:pattern count:2 phase:0]; }
    [colour setStroke]; [path moveToPoint:a]; [path lineToPoint:b]; [path stroke];
}
static CGFloat AVLayerY(NSRect rect, double feet, double maximumFeet) {
    CGFloat ground=NSMaxY(rect)-31, top=NSMinY(rect)+61;
    // Fixed schematic scale; lower levels are expanded for approach weather.
    double fraction=log1p(MAX(0,feet)/3000)/log1p(MAX(1,maximumFeet)/3000);
    return ground-MAX(1,ground-top)*MIN(1,fraction);
}
AviationSceneGeometry AviationSceneLayout(NSRect rect, NSDictionary *period, double maximumFeet) {
    NSNumber *ceiling=AVNumber(period[@"ceilingFt"]), *visibility=AVNumber(period[@"visibilityM"]);
    CGFloat start=AVCloudLeft(rect);
    CGFloat end=MAX(start,NSMaxX(rect)-14), y=NSMaxY(rect)-13;
    return (AviationSceneGeometry){NSMaxY(rect)-31,
        ceiling?AVLayerY(rect,ceiling.doubleValue,maximumFeet):NAN,
        NSMakePoint(start,y), NSMakePoint(visibility?start+(end-start)*MIN(1,visibility.doubleValue/10000):NAN,y), end};
}
static NSImage *AVAsset(NSString *name) {
    static NSMutableDictionary *assets; static dispatch_once_t once;
    dispatch_once(&once,^{ assets=[NSMutableDictionary dictionary]; });
    if (assets[name]) return assets[name];
    NSString *path=[NSBundle.mainBundle pathForResource:name ofType:@"png" inDirectory:@"Aviation"];
    if (!path) {
        NSString *directory=NSProcessInfo.processInfo.environment[@"ISOBAR_AVIATION_ASSETS"] ?: @"Resources/Aviation";
        path=[directory stringByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]];
    }
    NSImage *image=[[NSImage alloc] initWithContentsOfFile:path];
    if (!image || image.size.width<=0 || image.size.height<=0) return nil;
    // Decode this small, fixed collection once, before starting its animation.
    NSSize size=NSMakeSize(384,384*image.size.height/image.size.width);
    NSImage *prepared=[[NSImage alloc] initWithSize:size];
    [prepared lockFocus];
    [image drawInRect:NSMakeRect(0,0,size.width,size.height) fromRect:NSZeroRect
        operation:NSCompositingOperationSourceOver fraction:1];
    [prepared unlockFocus];
    assets[name]=prepared;
    return prepared;
}
static void AVImageBlend(NSImage *image, NSRect rect, CGFloat opacity, NSCompositingOperation operation) {
    if (!image || NSWidth(rect)<=0 || NSHeight(rect)<=0) return;
    CGFloat ratio=image.size.width/image.size.height;
    if (NSWidth(rect)/NSHeight(rect)>ratio) {
        CGFloat width=NSHeight(rect)*ratio; rect.origin.x+=(NSWidth(rect)-width)/2; rect.size.width=width;
    } else {
        CGFloat height=NSWidth(rect)/ratio; rect.origin.y+=NSHeight(rect)-height; rect.size.height=height;
    }
    [image drawInRect:rect fromRect:NSZeroRect operation:operation
        fraction:opacity respectFlipped:YES hints:@{NSImageHintInterpolation:@(NSImageInterpolationHigh)}];
}
static void AVImage(NSImage *image, NSRect rect, CGFloat opacity) {
    AVImageBlend(image,rect,opacity,NSCompositingOperationSourceOver);
}

@interface AviationForecastView ()
@property(nonatomic,strong) NSDate *inspectedDate;
@property(nonatomic,copy) NSArray<NSString *> *tips;
@property(nonatomic,strong) NSTimer *animationTimer;
@property(nonatomic,strong) id windowObserver;
@property(nonatomic,strong) id motionObserver;
@property(nonatomic) NSTimeInterval animationPhase;
@property(nonatomic,copy) NSArray<NSValue *> *sceneRects;
@property(nonatomic) double maximumFeet;
@property(nonatomic,copy) NSString *focusedPeriodKey;
@property(nonatomic,strong) NSMutableDictionary<NSString *,NSNumber *> *cloudSelections;
@property(nonatomic,strong) NSMutableDictionary<NSString *,NSDictionary *> *aircraftTransitions;
@property(nonatomic) NSTimeInterval animationTime;
@property(nonatomic,strong) NSImage *skySnapshot;
@property(nonatomic) NSTimeInterval skyTransitionStart;
@property(nonatomic,strong) NSMutableDictionary<NSString *,NSDictionary *> *solarDays;
@property(nonatomic) double lightFromElevation, lightToElevation;
@property(nonatomic) NSTimeInterval lightTransitionStart;
@property(nonatomic) BOOL draggingTimeline;
@property(nonatomic, strong) NSView *playheadCursor;
@end

@implementation AviationForecastView
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        _latitude=NAN; _longitude=NAN; _lightFromElevation=NAN; _lightToElevation=NAN;
        _solarDays=[NSMutableDictionary dictionary];
        _periods=@[]; _showsTimeline=YES; _now=NSDate.date; _timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
        _cloudSelections=[NSMutableDictionary dictionary];
        _aircraftTransitions=[NSMutableDictionary dictionary];
        _animationTime=NSProcessInfo.processInfo.systemUptime;
        for (NSString *name in @[@"plane",@"pc9",@"jumbo",@"sr71",@"cloud",@"tower",@"storm"]) (void)AVAsset(name);
        __weak AviationForecastView *weakSelf=self;
        _motionObserver=[NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification
            object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [weakSelf refreshAnimation]; weakSelf.needsDisplay=YES; }];
    }
    return self;
}
- (void)dealloc {
    [_animationTimer invalidate];
    if (_windowObserver) [NSNotificationCenter.defaultCenter removeObserver:_windowObserver];
    if (_motionObserver) [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:_motionObserver];
}
- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    if (_windowObserver) [NSNotificationCenter.defaultCenter removeObserver:_windowObserver];
    _windowObserver=nil;
    if (self.window) {
        __weak AviationForecastView *weakSelf=self;
        _windowObserver=[NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification
            object:self.window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [weakSelf refreshAnimation]; }];
    }
    [self refreshAnimation];
}
- (void)viewDidHide { [super viewDidHide]; [self refreshAnimation]; }
- (void)viewDidUnhide { [super viewDidUnhide]; [self refreshAnimation]; }
- (void)refreshAnimation {
    BOOL visible=self.window.isVisible && !self.isHiddenOrHasHiddenAncestor &&
        (self.window.occlusionState & NSWindowOcclusionStateVisible) && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    if (!visible) { [_animationTimer invalidate]; _animationTimer=nil; return; }
    if (_animationTimer) return;
    __weak AviationForecastView *weakSelf=self;
    _animationTimer=[NSTimer timerWithTimeInterval:1.0/60 repeats:YES block:^(NSTimer *timer) {
        AviationForecastView *view=weakSelf;
        if (!view) { [timer invalidate]; return; }
        [view advanceAnimationAtTime:NSProcessInfo.processInfo.systemUptime];
    }];
    [NSRunLoop.mainRunLoop addTimer:_animationTimer forMode:NSRunLoopCommonModes];
}
- (BOOL)animationRunning { return _animationTimer.valid; }
- (void)advanceAnimationAtTime:(NSTimeInterval)time {
    if (!isfinite(time) || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return;
    time=MAX(0,time);
    // Rebase a replaced clock without jumping an in-progress transition. The
    // live clock is monotonic; offscreen replay supplies explicit frame times.
    if (time<_animationTime) {
        NSTimeInterval offset=time-_animationTime;
        for (NSString *key in _aircraftTransitions.allKeys) {
            NSMutableDictionary *transition=[_aircraftTransitions[key] mutableCopy];
            transition[@"start"]=@([transition[@"start"] doubleValue]+offset); _aircraftTransitions[key]=transition;
        }
        _skyTransitionStart+=offset; _lightTransitionStart+=offset;
    }
    _animationTime=time;
    _animationPhase=fmod(MAX(0,time),120);
    for (NSString *key in _aircraftTransitions.allKeys)
        if (time-[_aircraftTransitions[key][@"start"] doubleValue]>=.7) [_aircraftTransitions removeObjectForKey:key];
    if (time-_skyTransitionStart>=.4) _skySnapshot=nil;
    [self setNeedsDisplayInRect:NSMakeRect(0,0,NSWidth(self.bounds),NSMinY(self.timelineRect))];
}
- (void)setSelectedDate:(NSDate *)date {
    BOOL same = date == _selectedDate || [date isEqualToDate:_selectedDate];
    if (!same) {
        NSDate *old = _selectedDate;
        NSArray *before = [self activePeriodsAtDate:old ?: self.now];
        NSArray *after = [self activePeriodsAtDate:date ?: self.now];
        if (![before isEqualToArray:after]) {
            // Same sky transition as a pointer move between TAF periods.
            self.inspectedDate = old;
            _selectedDate = date;
            [self inspectDate:nil];
        } else {
            _selectedDate = date;
            if (NSHeight(self.timelineRect) > 1) [self setNeedsDisplayInRect:self.timelineRect];
        }
    }
    [self placeCursor];
}
- (void)layout { [super layout]; [self placeCursor]; }
- (CGFloat)cursorXForDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class] || !self.start || !self.end) return NAN;
    if ([date compare:self.start] == NSOrderedAscending || [date compare:self.end] == NSOrderedDescending) return NAN;
    return [self x:date];
}
- (void)placeCursor {
    NSRect band = self.timelineRect;
    if (NSHeight(band) < 8)
        band = NSMakeRect(0, MAX(0, NSHeight(self.bounds) - 20), NSWidth(self.bounds), MIN(20, NSHeight(self.bounds)));
    PlaceVerticalCursor(self, &_playheadCursor, [self cursorXForDate:self.selectedDate], NSMinY(band), NSHeight(band));
}
- (void)setNow:(NSDate *)now {
    _now=now; self.lightToElevation=NAN; self.needsDisplay=YES;
}
- (void)setLatitude:(double)latitude {
    _latitude=latitude; [self.solarDays removeAllObjects]; self.lightToElevation=NAN; self.needsDisplay=YES;
}
- (void)setLongitude:(double)longitude {
    _longitude=longitude; [self.solarDays removeAllObjects]; self.lightToElevation=NAN; self.needsDisplay=YES;
}
- (void)setTimeZone:(NSTimeZone *)timeZone {
    _timeZone=timeZone ?: [NSTimeZone timeZoneForSecondsFromGMT:0];
    [self.solarDays removeAllObjects]; self.needsDisplay=YES;
}
- (NSDictionary *)daylightAtDate:(NSDate *)date {
    double elevation=SolarElevation(self.latitude,self.longitude,date);
    if (!isfinite(elevation)) return nil;
    NSCalendar *calendar=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; calendar.timeZone=self.timeZone;
    NSString *key=[NSString stringWithFormat:@"%.0f",[calendar startOfDayForDate:date].timeIntervalSince1970];
    NSDictionary *events=self.solarDays[key];
    if (!events) {
        events=SolarDaylight(self.latitude,self.longitude,date,self.timeZone);
        if (self.solarDays.count>=4) [self.solarDays removeAllObjects];
        if (events) self.solarDays[key]=events;
    }
    NSMutableDictionary *day=[events mutableCopy];
    day[@"altitudeDegrees"]=@(elevation);
    day[@"state"]=elevation < -6 ? @"night" : elevation < -50.0/60.0 ? @"civilTwilight" : @"day";
    return day;
}
- (double)displayedSolarElevation {
    double elevation=SolarElevation(self.latitude,self.longitude,self.inspectedDate?:self.selectedDate?:self.now);
    if (isfinite(elevation)) elevation=MAX(-8,MIN(2,elevation));
    if (!isfinite(self.lightToElevation) || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return elevation;
    double mix=AVEase((self.animationTime-self.lightTransitionStart)/.4);
    return self.lightFromElevation*(1-mix)+self.lightToElevation*mix;
}
- (NSString *)daylightLabelAtDate:(NSDate *)date includeEvent:(BOOL)includeEvent {
    NSDictionary *day=[self daylightAtDate:date];
    if (!day) return @"";
    NSString *state=day[@"state"],*label=[state isEqual:@"night"]?@"Civil night":[state isEqual:@"civilTwilight"]?@"Civil twilight":@"Day";
    NSDate *dawn=day[@"civilDawn"],*dusk=day[@"civilDusk"];
    if (!includeEvent) return label;
    BOOL beforeDawn=dawn && [date compare:dawn]==NSOrderedAscending;
    NSDate *event=beforeDawn?dawn:dusk;
    NSString *name=beforeDawn?@"BCT":@"ECT";
    if (!beforeDawn && dusk && [date compare:dusk]==NSOrderedDescending) {
        NSCalendar *calendar=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; calendar.timeZone=self.timeZone;
        NSDate *tomorrow=[calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:date options:0];
        event=[self daylightAtDate:tomorrow][@"civilDawn"]; name=@"BCT";
    }
    if (event && [date compare:event]!=NSOrderedDescending)
        label=[label stringByAppendingFormat:@" · %@ %@",name,AVTime(event,self.timeZone,NO)];
    return label;
}
- (NSDictionary *)focusedPeriod {
    NSArray *active=[self activePeriodsAtDate:self.inspectedDate?:self.selectedDate?:self.now];
    for (NSDictionary *p in active) if ([AVPeriodKey(p) isEqual:self.focusedPeriodKey]) return p;
    return active.firstObject;
}
- (NSInteger)selectedIndexForPeriod:(NSDictionary *)period { return [self.cloudSelections[AVPeriodKey(period)] integerValue]; }
- (NSInteger)selectedCloudIndex { return [self selectedIndexForPeriod:[self focusedPeriod]]; }
- (NSDictionary *)aircraftPresentationForPeriod:(NSDictionary *)period {
    NSArray *layers=AVLayers(period);
    NSNumber *base=layers.count?AVNumber(layers[MIN((NSUInteger)[self selectedIndexForPeriod:period],layers.count-1)][@"baseFt"]):nil;
    NSString *asset=layers.count?(base?AVAircraft(base.doubleValue):nil):@"plane";
    NSDictionary *target=@{@"feet":base?:@0,@"weights":asset?@{asset:@1}:@{}};
    NSDictionary *transition=self.aircraftTransitions[AVPeriodKey(period)];
    if (!transition || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return target;
    double mix=AVEase((self.animationTime-[transition[@"start"] doubleValue])/.7);
    NSMutableDictionary *weights=[NSMutableDictionary dictionary];
    for (NSString *name in @[@"plane",@"pc9",@"jumbo",@"sr71"])
        weights[name]=@([transition[@"fromWeights"][name] doubleValue]*(1-mix)+[transition[@"toWeights"][name] doubleValue]*mix);
    return @{@"feet":@([transition[@"fromFeet"] doubleValue]*(1-mix)+[transition[@"toFeet"] doubleValue]*mix),@"weights":weights};
}
- (void)setSelectedCloudIndex:(NSInteger)index {
    NSDictionary *period=[self focusedPeriod];
    if (!period || index==self.selectedCloudIndex) return;
    NSDictionary *presentation=[self aircraftPresentationForPeriod:period];
    NSString *key=AVPeriodKey(period);
    self.cloudSelections[key]=@(MAX(0,index));
    [self.aircraftTransitions removeObjectForKey:key];
    NSDictionary *target=[self aircraftPresentationForPeriod:period];
    if (!NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        // Retarget from the displayed mixture, so rapid changes never snap back
        // to the previous source aircraft or its original position.
        BOOL hadAircraft=[presentation[@"weights"] count]>0, hasAircraft=[target[@"weights"] count]>0;
        self.aircraftTransitions[key]=@{@"start":@(self.animationTime),
            @"fromFeet":hadAircraft?presentation[@"feet"]:target[@"feet"],
            @"toFeet":hasAircraft?target[@"feet"]:presentation[@"feet"],
            @"fromWeights":presentation[@"weights"],@"toWeights":target[@"weights"]};
    }
    self.needsDisplay=YES;
}
- (void)setPeriods:(NSArray<NSDictionary *> *)periods {
    _periods=[periods copy]; [self.cloudSelections removeAllObjects]; [self.aircraftTransitions removeAllObjects];
    self.skySnapshot=nil; self.focusedPeriodKey=nil; self.needsDisplay=YES;
}
- (NSString *)aircraftAssetName {
    NSDictionary *p=[self focusedPeriod];
    NSArray *layers=AVLayers(p);
    if (!layers.count) return @"plane";
    NSNumber *base=AVNumber(layers[MIN((NSUInteger)self.selectedCloudIndex,layers.count-1)][@"baseFt"]);
    return base?AVAircraft(base.doubleValue):nil;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityImageRole; }
- (NSString *)accessibilityLabel { return @"TAF cloud layers and horizontal visibility"; }
- (NSString *)accessibilityHelp { return @"Left and right change time. Up and down select a cloud layer."; }
- (NSString *)accessibilityValue { return [self summaryAtDate:self.inspectedDate?:self.selectedDate?:self.now]; }
- (NSDate *)start {
    NSDate *date=self.windowStart?:self.now?:NSDate.date, *start=nil;
    NSCalendar *cal=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; cal.timeZone=self.timeZone;
    [cal rangeOfUnit:NSCalendarUnitHour startDate:&start interval:NULL forDate:date]; return start?:date;
}
- (NSDate *)end {
    NSDate *last=nil;
    for (NSDictionary *p in self.periods)
        if ([p[@"end"] isKindOfClass:NSDate.class] && (!last || [p[@"end"] compare:last]==NSOrderedDescending)) last=p[@"end"];
    NSDate *start=self.start;
    return [start dateByAddingTimeInterval:MAX(6*3600,MIN(48*3600,last?[last timeIntervalSinceDate:start]:24*3600))];
}
- (NSRect)timelineRect { CGFloat height=self.showsTimeline?(NSHeight(self.bounds)>=230?72:56):0; return NSMakeRect(0,MAX(0,NSHeight(self.bounds)-height),NSWidth(self.bounds),height); }
- (CGFloat)x:(NSDate *)date {
    double fraction=[date timeIntervalSinceDate:self.start]/[self.end timeIntervalSinceDate:self.start];
    return 12+MAX(1,NSWidth(self.bounds)-24)*MIN(1,MAX(0,fraction));
}
- (NSDate *)dateAtX:(CGFloat)x {
    double fraction=MIN(1,MAX(0,(x-12)/MAX(1,NSWidth(self.bounds)-24)));
    NSTimeInterval span=[self.end timeIntervalSinceDate:self.start];
    return [self.start dateByAddingTimeInterval:MIN(span-1,span*fraction)];
}
- (NSArray<NSDictionary *> *)activePeriodsAtDate:(NSDate *)date {
    NSMutableArray *active=[NSMutableArray array];
    for (NSDictionary *p in self.periods) {
        NSDate *a=p[@"start"],*b=p[@"end"];
        if (![a isKindOfClass:NSDate.class] || ![b isKindOfClass:NSDate.class]) continue;
        if ([date compare:a]!=NSOrderedAscending && [date compare:b]==NSOrderedAscending) [active addObject:p];
    }
    NSArray *ordered=[active sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return AVConditional(a)==AVConditional(b)?NSOrderedSame:AVConditional(a)?NSOrderedDescending:NSOrderedAscending;
    }];
    NSDictionary *prevailing=nil;
    for (NSDictionary *p in ordered) if (!AVConditional(p) || [p[@"change"] isEqual:@"BECMG"]) { prevailing=p; break; }
    if (!prevailing) return ordered;
    NSMutableArray *resolved=[NSMutableArray array];
    for (NSDictionary *p in ordered) {
        if (!AVConditional(p) || p==prevailing) { [resolved addObject:p]; continue; }
        // Change groups only repeat changed elements. Resolve the unchanged
        // elements at the inspected time, including across an FM boundary.
        NSMutableDictionary *values=[p mutableCopy];
        if (![p[@"cloudLayers"] isKindOfClass:NSArray.class] &&
            (!p[@"ceilingState"] || [p[@"ceilingState"] isEqual:@"missing"]) &&
            (!p[@"ceiling"] || [p[@"ceiling"] isEqual:@"—"])) {
            for (NSString *key in @[@"cloudLayers",@"ceilingFt",@"ceilingState",@"ceiling"])
                if (prevailing[key]) values[key]=prevailing[key];
        }
        if (!AVNumber(p[@"visibilityM"]) && (!p[@"visibility"] || [p[@"visibility"] isEqual:@"—"]))
            for (NSString *key in @[@"visibilityM",@"visibilityAtLeast",@"visibility"])
                if (prevailing[key]) values[key]=prevailing[key];
        if (!p[@"weather"] || [p[@"weather"] isEqual:@"—"]) values[@"weather"]=prevailing[@"weather"]?:@"—";
        [resolved addObject:values];
    }
    return resolved;
}
- (NSString *)summaryAtDate:(NSDate *)date {
    NSMutableArray *parts=[NSMutableArray arrayWithObject:AVTime(date,self.timeZone,YES)];
    NSString *light=[self daylightLabelAtDate:date includeEvent:YES];
    if (light.length) [parts addObject:light];
    for (NSDictionary *p in [self activePeriodsAtDate:date]) {
        NSString *wx=p[@"weather"], *change=AVConditional(p)?[p[@"change"] stringByAppendingString:@" · "]:@"";
        [parts addObject:[NSString stringWithFormat:@"%@%@ / %@%@",change,p[@"ceiling"]?:@"—",p[@"visibility"]?:@"—",
            wx.length && ![wx isEqual:@"—"]?[@" · " stringByAppendingString:wx]:@""]];
        for (NSDictionary *layer in AVLayers(p)) {
            NSString *base=AVNumber(layer[@"baseFt"])?AVFeet(layer[@"baseFt"]):@"Unknown base";
            [parts addObject:[NSString stringWithFormat:@"%@ %@ %@",layer[@"amount"]?:@"Cloud",base,layer[@"type"]?:@""]];
        }
    }
    if (![self activePeriodsAtDate:date].count) [parts addObject:@"No TAF period"];
    return [parts componentsJoinedByString:@"   |   "];
}
- (void)inspectDate:(NSDate *)date {
    NSArray *before=[self activePeriodsAtDate:self.inspectedDate?:self.selectedDate?:self.now];
    NSArray *after=[self activePeriodsAtDate:date?:self.selectedDate?:self.now];
    if (self.window && ![before isEqualToArray:after] && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        NSRect sky=NSMakeRect(0,0,NSWidth(self.bounds),MAX(0,NSMinY(self.timelineRect)-6));
        if (NSWidth(sky)>0 && NSHeight(sky)>0) {
            NSBitmapImageRep *bitmap=[self bitmapImageRepForCachingDisplayInRect:sky];
            [self cacheDisplayInRect:sky toBitmapImageRep:bitmap];
            self.skySnapshot=[[NSImage alloc] initWithCGImage:bitmap.CGImage size:sky.size];
            self.skyTransitionStart=self.animationTime;
        }
    }
    double beforeElevation=[self displayedSolarElevation];
    double afterElevation=SolarElevation(self.latitude,self.longitude,date?:self.selectedDate?:self.now);
    if (isfinite(afterElevation)) afterElevation=MAX(-8,MIN(2,afterElevation));
    self.lightFromElevation=isfinite(beforeElevation)?beforeElevation:afterElevation;
    self.lightToElevation=afterElevation; self.lightTransitionStart=self.animationTime;
    self.inspectedDate=date;
    if (self.onInspect) self.onInspect(date?[self summaryAtDate:date]:nil);
    self.needsDisplay=YES;
}
- (void)setFrameSize:(NSSize)size {
    if (!NSEqualSizes(size,self.frame.size)) self.skySnapshot=nil;
    [super setFrameSize:size];
}
- (void)mouseMoved:(NSEvent *)event {
    NSPoint point=[self convertPoint:event.locationInWindow fromView:nil];
    if (NSPointInRect(point,self.timelineRect)) {
        NSDate *date=[self dateAtX:point.x];
        if (self.draggingTimeline && self.onSelectDate) self.onSelectDate(date);
        else if (self.onPreviewDate) self.onPreviewDate(date);
        else [self inspectDate:date];
    }
}
- (void)mouseExited:(NSEvent *)event { (void)event; if (!self.draggingTimeline) { if (self.onPreviewDate) self.onPreviewDate(nil); else [self inspectDate:nil]; } }
- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
    NSPoint point=[self convertPoint:event.locationInWindow fromView:nil];
    if (NSPointInRect(point,self.timelineRect)) { self.draggingTimeline=YES; [self mouseMoved:event]; return; }
    NSArray *active=[self activePeriodsAtDate:self.inspectedDate?:self.selectedDate?:self.now];
    for (NSUInteger i=0;i<MIN(active.count,self.sceneRects.count);i++) {
        NSRect rect=self.sceneRects[i].rectValue;
        if (!NSPointInRect(point,rect)) continue;
        self.focusedPeriodKey=AVPeriodKey(active[i]);
        NSArray *layers=AVLayers(active[i]); CGFloat nearest=CGFLOAT_MAX; NSInteger selected=0;
        for (NSUInteger j=0;j<layers.count;j++) {
            NSNumber *base=AVNumber(layers[j][@"baseFt"]); if (!base) continue;
            CGFloat distance=fabs(point.y-AVLayerY(rect,base.doubleValue,self.maximumFeet));
            if (distance<nearest) { nearest=distance; selected=j; }
        }
        self.selectedCloudIndex=selected;
    }
}
- (void)mouseDragged:(NSEvent *)event {
    if (self.draggingTimeline) {
        NSDate *date=[self dateAtX:[self convertPoint:event.locationInWindow fromView:nil].x];
        if (self.onSelectDate) self.onSelectDate(date); else [self inspectDate:date];
    }
}
- (void)mouseUp:(NSEvent *)event { [self mouseDragged:event]; self.draggingTimeline=NO; }
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode==53) { [self inspectDate:nil]; return; }
    if (event.keyCode==125 || event.keyCode==126) {
        NSArray *layers=AVLayers([self focusedPeriod]);
        if (!layers.count) return;
        NSUInteger selected=MIN((NSUInteger)self.selectedCloudIndex,layers.count-1);
        double current=[AVNumber(layers[selected][@"baseFt"]) doubleValue],distance=INFINITY;
        for (NSUInteger i=0;i<layers.count;i++) {
            NSNumber *base=AVNumber(layers[i][@"baseFt"]); if (!base) continue;
            double delta=(base.doubleValue-current)*(event.keyCode==126?1:-1);
            if (delta>0 && delta<distance) { distance=delta; selected=i; }
        }
        self.selectedCloudIndex=(NSInteger)selected;
        return;
    }
    if (event.keyCode!=123 && event.keyCode!=124) { [super keyDown:event]; return; }
    NSDate *date=[(self.inspectedDate?:self.selectedDate?:self.now?:self.start) dateByAddingTimeInterval:event.keyCode==123?-3600:3600];
    if ([date compare:self.start]==NSOrderedAscending) date=self.start;
    if ([date compare:self.end]!=NSOrderedAscending) date=[self.end dateByAddingTimeInterval:-1];
    if (self.onSelectDate) self.onSelectDate(date); else [self inspectDate:date];
}
- (void)resetCursorRects {
    [self addCursorRect:self.timelineRect cursor:NSCursor.pointingHandCursor];
    if (AVLayers([self focusedPeriod]).count)
        [self addCursorRect:NSMakeRect(0,0,NSWidth(self.bounds),NSMinY(self.timelineRect)-6) cursor:NSCursor.pointingHandCursor];
}
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
    [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveAlways|NSTrackingInVisibleRect owner:self userInfo:nil]];
    [self removeAllToolTips];
    NSMutableArray *tips=[NSMutableArray array];
    for (NSDate *date=self.start;[date compare:self.end]==NSOrderedAscending;date=[date dateByAddingTimeInterval:3600]) {
        NSString *tip=[self summaryAtDate:date]; [tips addObject:tip];
        CGFloat x=[self x:date], end=[self x:[date dateByAddingTimeInterval:3600]];
        [self addToolTipRect:NSMakeRect(x,NSMinY(self.timelineRect),MAX(1,end-x),NSHeight(self.timelineRect)) owner:self userData:(__bridge void *)tip];
    }
    self.tips=tips;
}
- (NSString *)view:(NSView *)view stringForToolTip:(NSToolTipTag)tag point:(NSPoint)point userData:(void *)data {
    (void)view;(void)tag;(void)data; return [self summaryAtDate:[self dateAtX:point.x]];
}

- (void)drawScene:(NSDictionary *)period rect:(NSRect)rect maximumFeet:(double)maximumFeet {
    [NSGraphicsContext saveGraphicsState];
    NSBezierPath *card=[NSBezierPath bezierPathWithRoundedRect:rect xRadius:8 yRadius:8];
    [card addClip];
    // Forecast illumination follows the airport's sun, independently of the
    // desktop theme. Night is deliberately pale enough to read the weather.
    double elevation=[self displayedSolarElevation];
    CGFloat night=isfinite(elevation)?1-AVEase((elevation+8)/10):0;
    CGFloat twilight=isfinite(elevation)?MAX(0,1-fabs(elevation+3)/7):0;
    NSColor *daySky=[NSColor colorWithSRGBRed:.80 green:.90 blue:.95 alpha:1];
    NSColor *nightSky=[NSColor colorWithSRGBRed:.70 green:.75 blue:.85 alpha:1];
    NSColor *sky=[daySky blendedColorWithFraction:night ofColor:nightSky];
    NSColor *horizon=[[NSColor colorWithSRGBRed:.94 green:.96 blue:.96 alpha:1]
        blendedColorWithFraction:night*.6 ofColor:nightSky];
    horizon=[horizon blendedColorWithFraction:twilight*.25 ofColor:[NSColor colorWithSRGBRed:1 green:.81 blue:.65 alpha:1]];
    NSColor *ink=[NSColor colorWithSRGBRed:.18 green:.25 blue:.32 alpha:1];
    NSColor *muted=[NSColor colorWithSRGBRed:.35 green:.42 blue:.49 alpha:1];
    NSColor *accent=AVConditional(period)?[NSColor colorWithSRGBRed:.64 green:.34 blue:.10 alpha:1]:[NSColor colorWithSRGBRed:.13 green:.39 blue:.64 alpha:1];
    [sky setFill]; [card fill];
    AviationSceneGeometry g=AviationSceneLayout(rect,period,maximumFeet);
    NSGradient *skyGradient=[[NSGradient alloc] initWithStartingColor:sky endingColor:horizon];
    [skyGradient drawInRect:rect angle:90];
    [[muted colorWithAlphaComponent:.065] setFill];
    NSRectFillUsingOperation(NSMakeRect(NSMinX(rect),g.groundY,NSWidth(rect),NSMaxY(rect)-g.groundY),NSCompositingOperationSourceOver);
    NSString *heading=AVConditional(period)?AVBadge(period):@"TAF";
    if (!AVConditional(period)) {
        NSString *light=[self daylightLabelAtDate:self.inspectedDate?:self.selectedDate?:self.now includeEvent:NSWidth(rect)>330];
        if (light.length) heading=[heading stringByAppendingFormat:@" · %@",light];
    }
    AVText(heading,NSMakeRect(NSMinX(rect)+10,NSMinY(rect)+5,NSWidth(rect)-107,16),10,ink,YES,NSTextAlignmentLeft);
    AVText(@"0–60k ft AGL",NSMakeRect(NSMaxX(rect)-96,NSMinY(rect)+6,86,14),9,muted,NO,NSTextAlignmentRight);
    NSString *weather=[period[@"weather"] isKindOfClass:NSString.class]?period[@"weather"]:@"";
    if (weather.length && ![@[@"—",@"NSW",@"CAVOK"] containsObject:weather])
        AVText(weather,NSMakeRect(NSMinX(rect)+10,NSMinY(rect)+21,NSWidth(rect)-20,14),9,muted,NO,NSTextAlignmentRight);

    NSArray *layers=AVLayers(period);
    CGFloat cloudLeft=AVCloudLeft(rect), cloudRight=NSMaxX(rect)-12;
    if (NSHeight(rect)>140) for (NSNumber *tick in @[@3000,@10000,@30000,@60000]) {
        CGFloat y=AVLayerY(rect,tick.doubleValue,maximumFeet);
        AVLine(NSMakePoint(cloudLeft,y),NSMakePoint(cloudRight,y),[muted colorWithAlphaComponent:.14],.5,YES);
        AVText([NSString stringWithFormat:@"%.0fk",tick.doubleValue/1000],NSMakeRect(cloudRight-26,y-13,24,12),8,muted,NO,NSTextAlignmentRight);
    }
    NSDictionary *selected=layers.count?layers[MIN((NSUInteger)[self selectedIndexForPeriod:period],layers.count-1)]:nil;
    NSDictionary *presentation=[self aircraftPresentationForPeriod:period];
    double selectedFeet=[presentation[@"feet"] doubleValue];
    CGFloat planeY=layers.count?AVLayerY(rect,selectedFeet,maximumFeet):g.groundY-16;
    // Cloud textures drift independently of their measured base. Neither cloud
    // tops nor drift speed are measurements in a TAF.
    NSArray *ordered=[layers sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a,NSDictionary *b) {
        return [AVNumber(b[@"baseFt"])?:@0 compare:AVNumber(a[@"baseFt"])?:@0];
    }];
    CGFloat labelBottom=NSMinY(rect)+24;
    for (NSUInteger layerIndex=0;layerIndex<ordered.count;layerIndex++) {
        NSDictionary *layer=ordered[layerIndex];
        NSNumber *base=AVNumber(layer[@"baseFt"]);
        NSString *amount=layer[@"amount"]?:@"Cloud", *type=layer[@"type"]?:@"";
        if (!base) {
            AVText([NSString stringWithFormat:@"%@ · base unknown",amount],NSMakeRect(NSMinX(rect)+10,labelBottom,NSWidth(rect)-20,15),10,muted,NO,NSTextAlignmentLeft);
            labelBottom+=15; continue;
        }
        CGFloat y=AVLayerY(rect,base.doubleValue,maximumFeet);
        CGFloat labelY=MAX(labelBottom,MIN(g.groundY-15*(ordered.count-layerIndex),y-9));
        NSString *height=[AVFeet(base) stringByReplacingOccurrencesOfString:@" ft" withString:@""];
        NSString *label=cloudLeft-NSMinX(rect)<90?height:[NSString stringWithFormat:@"%@ %@",amount,height];
        AVText(label,NSMakeRect(NSMinX(rect)+8,labelY,cloudLeft-NSMinX(rect)-12,14),10,ink,layer==selected,NSTextAlignmentLeft);
        labelBottom=labelY+15;
        if (fabs(labelY+7-y)>5) AVLine(NSMakePoint(cloudLeft-10,labelY+7),NSMakePoint(cloudLeft-3,y),[muted colorWithAlphaComponent:.35],.5,NO);
        AVLine(NSMakePoint(cloudLeft-3,y),NSMakePoint(cloudRight,y),[accent colorWithAlphaComponent:layer==selected?.85:.35],1,AVConditional(period));
        BOOL storm=[type isEqual:@"CB"], tower=[type isEqual:@"TCU"];
        NSImage *cloud=AVAsset(storm?@"storm":tower?@"tower":@"cloud");
        NSInteger count=[amount isEqual:@"FEW"]?1:[amount isEqual:@"SCT"]?2:[amount isEqual:@"BKN"]?3:4;
        CGFloat coverage=[amount isEqual:@"FEW"]?.20:[amount isEqual:@"SCT"]?.55:[amount isEqual:@"BKN"]?.95:1.25;
        CGFloat cloudW=MIN(210,MAX(70,(cloudRight-cloudLeft)*coverage/count));
        CGFloat cloudH=MAX(18,MIN(storm?100:tower?84:cloudW*.5,y-NSMinY(rect)-21));
        // TAFs report bases, not tops. The artwork fills the weather field;
        // the anchored line and number carry the measured height.
        if (storm || tower) cloudW=MIN(cloudW,cloudH*1.1);
        CGFloat drift=sin(self.animationPhase*2*M_PI/30+base.doubleValue*.001)*5;
        for (NSInteger i=0;i<count;i++) {
            CGFloat x=cloudLeft+(cloudRight-cloudLeft-cloudW)*(count==1?.35:(double)i/(count-1));
            AVImage(cloud,NSMakeRect(x+drift,y-cloudH,cloudW,cloudH),.95);
        }
        if (type.length) AVText(type,NSMakeRect(cloudRight-27,y-15,25,13),9,ink,YES,NSTextAlignmentRight);
    }
    BOOL rain=[weather containsString:@"RA"], snow=[weather containsString:@"SN"];
    if (rain || snow) {
        CGFloat precipitationTop=g.groundY-35;
        for (NSDictionary *layer in layers) if (AVNumber(layer[@"baseFt"]))
            precipitationTop=MIN(precipitationTop,AVLayerY(rect,[layer[@"baseFt"] doubleValue],maximumFeet));
        [NSGraphicsContext saveGraphicsState];
        NSRect precipitation=NSMakeRect(cloudLeft,precipitationTop,MAX(0,cloudRight-cloudLeft),MAX(0,g.groundY-precipitationTop));
        [[NSBezierPath bezierPathWithRect:precipitation] addClip];
        CGFloat phase=fmod(self.animationPhase*(snow?9:28),20);
        for (CGFloat x=cloudLeft+8;x<cloudRight;x+=17) for (CGFloat y=precipitationTop-20+phase;y<g.groundY;y+=20) {
            if (snow) { [[ink colorWithAlphaComponent:.24] setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x,y,2,2)] fill]; }
            else AVLine(NSMakePoint(x,y),NSMakePoint(x-2,y+5),[NSColor.systemBlueColor colorWithAlphaComponent:.27],1,NO);
        }
        [NSGraphicsContext restoreGraphicsState];
    }
    NSNumber *visibility=AVNumber(period[@"visibilityM"]);
    if (visibility && visibility.doubleValue<8000) {
        CGFloat strength=.38*(1-visibility.doubleValue/10000);
        NSGradient *haze=[[NSGradient alloc] initWithStartingColor:[sky colorWithAlphaComponent:0]
            endingColor:[sky colorWithAlphaComponent:strength]];
        [haze drawInRect:NSMakeRect(cloudLeft,NSMinY(rect)+24,MAX(0,cloudRight-cloudLeft),MAX(0,g.groundY-NSMinY(rect)-24)) angle:0];
    }
    if (!layers.count) {
        NSString *state=period[@"ceilingState"];
        NSString *label=[state isEqual:@"cavok"]?@"CAVOK":[state isEqual:@"none"]?@"No ceiling":@"Cloud unavailable";
        AVText(label,NSMakeRect(NSMinX(rect)+10,NSMinY(rect)+32,NSWidth(rect)-20,18),11,muted,NO,NSTextAlignmentLeft);
    }
    // The illustrative aircraft follows the selected weather feature. Its
    // silhouette changes with height; it is not traffic or an approach path.
    CGFloat planeW=MIN(44,MAX(30,NSWidth(rect)*.12)), planeH=planeW*.5;
    CGFloat planeX=cloudLeft+8+sin(self.animationPhase*2*M_PI/24)*5;
    CGFloat bob=sin(self.animationPhase*2*M_PI/6)*.7;
    CGFloat planeTop=MAX(NSMinY(rect)+21,MIN(g.groundY-planeH-2,planeY-planeH*.55+bob));
    NSDictionary *weights=presentation[@"weights"];
    NSRect planeRect=NSMakeRect(planeX,planeTop,planeW,planeH);
    [NSGraphicsContext saveGraphicsState]; [[NSBezierPath bezierPathWithRect:planeRect] addClip];
    CGContextRef context=NSGraphicsContext.currentContext.CGContext;
    CGContextBeginTransparencyLayer(context,NULL);
    for (NSString *name in @[@"plane",@"pc9",@"jumbo",@"sr71"]) {
        CGFloat opacity=[weights[name] doubleValue];
        if (opacity>.001) AVImageBlend(AVAsset(name),planeRect,opacity,NSCompositingOperationPlusLighter);
    }
    CGContextEndTransparencyLayer(context); [NSGraphicsContext restoreGraphicsState];
    AVLine(NSMakePoint(NSMinX(rect)+8,g.groundY),NSMakePoint(NSMaxX(rect)-8,g.groundY),[muted colorWithAlphaComponent:.3],1,NO);

    // Visibility is a horizontal distance ahead of the airplane, never height.
    AVText(@"Visibility",NSMakeRect(NSMinX(rect)+8,g.groundY+2,85,12),9,muted,NO,NSTextAlignmentLeft);
    AVText(period[@"visibility"]?:@"—",NSMakeRect(NSMinX(rect)+8,g.groundY+14,85,15),11,ink,YES,NSTextAlignmentLeft);
    AVLine(g.visibilityStart,NSMakePoint(g.visibilityMaxX,g.visibilityStart.y),[muted colorWithAlphaComponent:.2],3,NO);
    if (isfinite(g.visibilityEnd.x)) {
        AVLine(g.visibilityStart,g.visibilityEnd,accent,3,AVConditional(period));
        AVLine(NSMakePoint(g.visibilityEnd.x-3,g.visibilityEnd.y-3),g.visibilityEnd,accent,1.5,NO);
        AVLine(NSMakePoint(g.visibilityEnd.x-3,g.visibilityEnd.y+3),g.visibilityEnd,accent,1.5,NO);
    }
    AVText(@"10 km",NSMakeRect(g.visibilityMaxX-32,g.visibilityStart.y-13,34,11),8,muted,NO,NSTextAlignmentRight);
    [NSGraphicsContext restoreGraphicsState];
    if (AVConditional(period)) {
        [[NSColor.systemOrangeColor colorWithAlphaComponent:.3] setStroke]; card.lineWidth=1; [card stroke];
    }
}

- (void)drawDaylightStrip:(NSRect)rect {
    if (!isfinite(SolarElevation(self.latitude,self.longitude,self.start))) return;
    NSCalendar *calendar=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; calendar.timeZone=self.timeZone;
    NSMutableArray<NSDate *> *edges=[NSMutableArray arrayWithArray:@[self.start,self.end]];
    NSDate *first=[calendar startOfDayForDate:self.start];
    for (NSDate *day=first; [day compare:self.end]==NSOrderedAscending;
         day=[calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:day options:0]) {
        NSDictionary *events=[self daylightAtDate:day];
        for (NSString *name in @[@"civilDawn",@"civilDusk",@"sunrise",@"sunset"]) {
            NSDate *event=events[name];
            if (event && [event compare:self.start]==NSOrderedDescending && [event compare:self.end]==NSOrderedAscending)
                [edges addObject:event];
        }
    }
    [edges sortUsingSelector:@selector(compare:)];
    [NSGraphicsContext saveGraphicsState];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:6 yRadius:6] addClip];
    for (NSUInteger i=1;i<edges.count;i++) {
        NSDate *a=edges[i-1],*b=edges[i];
        double elevation=SolarElevation(self.latitude,self.longitude,[a dateByAddingTimeInterval:[b timeIntervalSinceDate:a]/2]);
        NSColor *colour=elevation < -6 ? [NSColor colorWithSRGBRed:.43 green:.48 blue:.66 alpha:.16] :
            elevation < -50.0/60.0 ? [NSColor colorWithSRGBRed:.91 green:.61 blue:.32 alpha:.17] : NSColor.clearColor;
        [colour setFill];
        NSRectFillUsingOperation(NSMakeRect([self x:a],NSMinY(rect),[self x:b]-[self x:a],NSHeight(rect)),NSCompositingOperationSourceOver);
    }
    [NSGraphicsContext restoreGraphicsState];
}
- (void)drawTimeStrip {
    NSRect rect=self.timelineRect;
    CGFloat left=12,right=NSWidth(self.bounds)-12,y=NSMinY(rect)+20;
    NSColor *muted=NSColor.secondaryLabelColor,*accent=NSColor.controlAccentColor;
    [[NSColor.labelColor colorWithAlphaComponent:.04] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:6 yRadius:6] fill];
    [self drawDaylightStrip:rect];
    AVLine(NSMakePoint(left,y),NSMakePoint(right,y),[muted colorWithAlphaComponent:.3],4,NO);
    for (NSDictionary *p in self.periods) {
        if (![p[@"start"] isKindOfClass:NSDate.class] || ![p[@"end"] isKindOfClass:NSDate.class]) continue;
        CGFloat a=[self x:p[@"start"]],b=[self x:p[@"end"]];
        if (b<=a) continue;
        AVLine(NSMakePoint(a,y+(AVConditional(p)?4:0)),NSMakePoint(b,y+(AVConditional(p)?4:0)),
            AVConditional(p)?NSColor.systemOrangeColor:[accent colorWithAlphaComponent:.45],2,AVConditional(p));
    }
    NSDate *selected=self.inspectedDate?:self.selectedDate?:self.now?:self.start;
    CGFloat x=[self x:selected];
    BOOL inRange=[selected compare:self.start]!=NSOrderedAscending && [selected compare:self.end]!=NSOrderedDescending;
    NSRect selectedLabel=NSMakeRect(MAX(6,MIN(right-82,x-41)),y+10,82,16);
    [self placeCursor];
    CGFloat previous=-CGFLOAT_MAX;
    for (NSDate *date=self.start;[date compare:self.end]!=NSOrderedDescending;date=[date dateByAddingTimeInterval:3*3600]) {
        CGFloat tx=[self x:date]; NSRect label=NSMakeRect(MAX(left,MIN(right-54,tx-27)),y+10,54,16);
        if (NSIntersectsRect(NSInsetRect(selectedLabel,-4,0),label) || NSMinX(label)<previous+6) continue;
        AVText(AVTime(date,self.timeZone,NO),label,10,muted,NO,NSTextAlignmentCenter); previous=NSMaxX(label);
    }
    if (inRange) AVText((self.inspectedDate || self.selectedDate)?AVTime(selected,self.timeZone,YES):@"Now",selectedLabel,10,NSColor.labelColor,YES,NSTextAlignmentCenter);
}
- (void)drawRect:(NSRect)dirtyRect {
    [self refreshAnimation];
    [NSGraphicsContext saveGraphicsState]; [[NSBezierPath bezierPathWithRect:self.bounds] addClip];
    NSArray *active=[self activePeriodsAtDate:self.inspectedDate?:self.selectedDate?:self.now?:self.start];
    CGFloat height=MAX(0,NSMinY(self.timelineRect)-6),gap=8;
    if (active.count) {
        double maximumFeet=60000;
        self.maximumFeet=maximumFeet;
        CGFloat available=MAX(0,NSWidth(self.bounds)-gap*(active.count-1));
        CGFloat weight=active.count>1 && !AVConditional(active[0])?1.18:1;
        CGFloat unit=available/(active.count-1+weight),x=0;
        NSMutableArray *rects=[NSMutableArray array];
        for (NSUInteger i=0;i<active.count;i++) {
            CGFloat width=unit*(i==0?weight:1);
            NSRect rect=NSMakeRect(x,0,width,height); [rects addObject:[NSValue valueWithRect:rect]];
            if (NSIntersectsRect(dirtyRect,rect)) [self drawScene:active[i] rect:rect maximumFeet:maximumFeet]; x+=width+gap;
        }
        self.sceneRects=rects;
    } else AVText(self.periods.count?@"No TAF for this time":@"TAF unavailable",NSMakeRect(12,MAX(0,height/2-10),NSWidth(self.bounds)-24,22),13,NSColor.secondaryLabelColor,NO,NSTextAlignmentCenter);
    if (self.skySnapshot && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        CGFloat opacity=1-AVEase((self.animationTime-self.skyTransitionStart)/.4);
        [self.skySnapshot drawInRect:NSMakeRect(0,0,NSWidth(self.bounds),height) fromRect:NSZeroRect
            operation:NSCompositingOperationSourceOver fraction:opacity respectFlipped:YES hints:nil];
    }
    if (NSIntersectsRect(dirtyRect,self.timelineRect)) [self drawTimeStrip]; [NSGraphicsContext restoreGraphicsState];
}
@end
