#import "aviationview.h"
#import "skyview.h"
#import "aviation.h"
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
    style.alignment=align; style.lineBreakMode=NSLineBreakByWordWrapping;
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
// Thunderstorms are the word TS on a red tag. TCU keeps the turret sprite.
static NSColor *AVHazardColour(NSString *kind) {
    if ([kind isEqual:@"TCU"]) return [NSColor colorWithSRGBRed:0.62 green:0.36 blue:0.04 alpha:1];
    return [NSColor colorWithSRGBRed:0.74 green:0.12 blue:0.10 alpha:1];
}
static void AVPaintTag(NSString *word, NSRect rect, NSColor *fill, NSColor *ink) {
    if (!word.length || NSWidth(rect)<16 || NSHeight(rect)<10) return;
    [[fill colorWithAlphaComponent:1] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:3 yRadius:3] fill];
    AVText(word, NSInsetRect(rect, 2, 1), MIN(12, MAX(9, NSHeight(rect)-3)), ink, YES, NSTextAlignmentCenter);
}
static BOOL AVHazardSpan(NSDictionary *period) {
    NSString *kind=period[@"change"]?:@"";
    return [kind containsString:@"INTER"] || [kind containsString:@"TEMPO"];
}
// A line solid for prevailing weather and dashed for a conditional group; a
// panel changing kind crossfades the two styles.
static void AVStyledLine(NSPoint a, NSPoint b, NSColor *colour, CGFloat alpha, CGFloat width, double conditional) {
    CGFloat solid=alpha*(1-conditional), dashed=alpha*conditional;
    if (solid>.001) AVLine(a,b,solid>=1?colour:[colour colorWithAlphaComponent:solid],width,NO);
    if (dashed>.001) AVLine(a,b,dashed>=1?colour:[colour colorWithAlphaComponent:dashed],width,YES);
}

// Sky transitions animate the forecast scene itself. A scene is the drawable
// state of one panel for its current rect; two scenes blend into a third, so
// a change of TAF group can start from whatever is on screen.
static const NSTimeInterval AVSkySeconds=.9;
static double AVMix(double a, double b, double p) { return a+(b-a)*p; }
static NSRect AVMixRect(NSRect a, NSRect b, double p) {
    return NSMakeRect(AVMix(NSMinX(a),NSMinX(b),p),AVMix(NSMinY(a),NSMinY(b),p),AVMix(NSWidth(a),NSWidth(b),p),AVMix(NSHeight(a),NSHeight(b),p));
}
static NSDictionary *AVWith(NSDictionary *item, NSDictionary *changes) {
    NSMutableDictionary *copy=[item mutableCopy]; [copy addEntriesFromDictionary:changes]; return copy;
}
static NSDictionary *AVTextItem(NSString *role, NSString *text, NSRect rect, CGFloat size, BOOL ink, BOOL bold, NSTextAlignment align) {
    return @{@"role":role,@"text":text,@"rect":[NSValue valueWithRect:rect],@"size":@(size),@"ink":@(ink),@"bold":@(bold),@"align":@(align),@"alpha":@1};
}
static void AVPaintTexts(NSArray *items, NSString *prefix, NSColor *ink, NSColor *muted, CGFloat alpha) {
    for (NSDictionary *item in items) {
        if (prefix && ![item[@"role"] hasPrefix:prefix]) continue;
        CGFloat opacity=[item[@"alpha"] doubleValue]*alpha; NSColor *colour=[item[@"ink"] boolValue]?ink:muted;
        if (opacity>.001) AVText(item[@"text"],[item[@"rect"] rectValue],[item[@"size"] doubleValue],
            opacity>=1?colour:[colour colorWithAlphaComponent:opacity],[item[@"bold"] boolValue],[item[@"align"] integerValue]);
    }
}
// Texts in one role move together. A changed text clears in the first half of
// a transition and its replacement arrives in the second, so two strings never
// share a place.
static NSArray *AVBlendTexts(NSArray *from, NSArray *to, double p) {
    NSMutableArray *result=[NSMutableArray array]; NSMutableIndexSet *kept=[NSMutableIndexSet indexSet];
    double leaving=1-AVEase(2*p), arriving=AVEase(2*p-1);
    for (NSDictionary *item in from) {
        NSDictionary *a=item;
        NSUInteger same=[to indexOfObjectPassingTest:^BOOL(NSDictionary *b, NSUInteger i, BOOL *stop) {
            (void)stop; return ![kept containsIndex:i] && [a[@"role"] isEqual:b[@"role"]] && [a[@"text"] isEqual:b[@"text"]]; }];
        NSUInteger partner=same!=NSNotFound?same:[to indexOfObjectPassingTest:^BOOL(NSDictionary *b, NSUInteger i, BOOL *stop) {
            (void)i; (void)stop; return [a[@"role"] isEqual:b[@"role"]]; }];
        NSRect rect=[a[@"rect"] rectValue];
        if (partner!=NSNotFound) rect=AVMixRect(rect,[to[partner][@"rect"] rectValue],p);
        double alpha=[a[@"alpha"] doubleValue]*leaving;
        if (same!=NSNotFound) {
            [kept addIndex:same]; alpha=AVMix([a[@"alpha"] doubleValue],[to[same][@"alpha"] doubleValue],p);
            a=AVWith(a,@{@"bold":p<.5?a[@"bold"]:to[same][@"bold"]});
        }
        if (alpha>.001) [result addObject:AVWith(a,@{@"rect":[NSValue valueWithRect:rect],@"alpha":@(alpha)})];
    }
    for (NSUInteger i=0;i<to.count;i++) {
        NSDictionary *b=to[i];
        if ([kept containsIndex:i] || arriving<=.001) continue;
        NSUInteger partner=[from indexOfObjectPassingTest:^BOOL(NSDictionary *a, NSUInteger j, BOOL *stop) {
            (void)j; (void)stop; return [a[@"role"] isEqual:b[@"role"]]; }];
        NSRect rect=[b[@"rect"] rectValue];
        if (partner!=NSNotFound) rect=AVMixRect([from[partner][@"rect"] rectValue],rect,p);
        [result addObject:AVWith(b,@{@"rect":[NSValue valueWithRect:rect],@"alpha":@([b[@"alpha"] doubleValue]*arriving)})];
    }
    return result;
}
static NSDictionary *AVBlendSprite(NSDictionary *a, NSDictionary *b, double p, NSString *image, double alpha) {
    return @{@"x":@(AVMix([a[@"x"] doubleValue],[b[@"x"] doubleValue],p)),@"w":@(AVMix([a[@"w"] doubleValue],[b[@"w"] doubleValue],p)),
        @"h":@(AVMix([a[@"h"] doubleValue],[b[@"h"] doubleValue],p)),@"image":image,@"alpha":@(alpha)};
}
// Cloud artwork pairs in order with its nearest counterpart and spare artwork
// fades where it is, so cover thickens or thins without a jump.
static NSArray *AVBlendSprites(NSArray *from, NSArray *to, double p) {
    BOOL grows=from.count<=to.count; NSArray *few=grows?from:to, *many=grows?to:from;
    NSMutableArray *partners=[NSMutableArray arrayWithCapacity:many.count];
    for (NSUInteger j=0;j<many.count;j++) [partners addObject:NSNull.null];
    NSInteger last=-1;
    for (NSUInteger i=0;i<few.count;i++) {
        double centre=[few[i][@"x"] doubleValue]+[few[i][@"w"] doubleValue]/2, best=INFINITY; NSInteger chosen=last+1;
        for (NSInteger j=last+1;j<=(NSInteger)(many.count-(few.count-i));j++) {
            double distance=fabs([many[j][@"x"] doubleValue]+[many[j][@"w"] doubleValue]/2-centre);
            if (distance<best) { best=distance; chosen=j; }
        }
        partners[(NSUInteger)chosen]=few[i]; last=chosen;
    }
    NSMutableArray *result=[NSMutableArray array];
    for (NSUInteger j=0;j<many.count;j++) {
        NSDictionary *a=grows?partners[j]:many[j], *b=grows?many[j]:partners[j];
        if ((id)a==NSNull.null || (id)b==NSNull.null) {
            NSDictionary *only=(id)a==NSNull.null?b:a;
            double alpha=[only[@"alpha"] doubleValue]*((id)a==NSNull.null?p:1-p);
            if (alpha>.001) [result addObject:AVWith(only,@{@"alpha":@(alpha)})];
        } else if ([a[@"image"] isEqual:b[@"image"]]) {
            [result addObject:AVBlendSprite(a,b,p,a[@"image"],AVMix([a[@"alpha"] doubleValue],[b[@"alpha"] doubleValue],p))];
        } else {
            [result addObject:AVBlendSprite(a,b,p,a[@"image"],[a[@"alpha"] doubleValue]*(1-p))];
            [result addObject:AVBlendSprite(a,b,p,b[@"image"],[b[@"alpha"] doubleValue]*p)];
        }
    }
    return result;
}
static NSDictionary *AVBlendDeck(NSDictionary *a, NSDictionary *b, double p) {
    if (!b) return AVWith(a,@{@"alpha":@([a[@"alpha"] doubleValue]*(1-p))});
    if (!a) return AVWith(b,@{@"alpha":@([b[@"alpha"] doubleValue]*p)});
    NSMutableDictionary *deck=[NSMutableDictionary dictionary];
    for (NSString *key in @[@"y",@"feet",@"alpha",@"line",@"labelY",@"leader"]) deck[key]=@(AVMix([a[key] doubleValue],[b[key] doubleValue],p));
    deck[@"labels"]=AVBlendTexts(a[@"labels"],b[@"labels"],p);
    deck[@"types"]=AVBlendTexts(a[@"types"],b[@"types"],p);
    deck[@"sprites"]=AVBlendSprites(a[@"sprites"],b[@"sprites"],p);
    deck[@"mark"]=p<.5?(a[@"mark"]?:@""):(b[@"mark"]?:@"");
    return deck;
}
// A held scene keeps its layout proportionally when its panel's width has
// changed since it was drawn.
static id AVRescaled(id value, NSString *key, NSRect from, NSRect to) {
    double k=NSWidth(to)/MAX(1e-9,NSWidth(from));
    if ([value isKindOfClass:NSDictionary.class]) {
        NSMutableDictionary *copy=[NSMutableDictionary dictionary];
        [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id name, id item, BOOL *stop) { (void)stop; copy[name]=AVRescaled(item,name,from,to); }];
        return copy;
    }
    if ([value isKindOfClass:NSArray.class]) {
        NSMutableArray *copy=[NSMutableArray array];
        for (id item in value) [copy addObject:AVRescaled(item,nil,from,to)];
        return copy;
    }
    if ([key isEqual:@"x"] || [key isEqual:@"visibilityX"]) return @(NSMinX(to)+([value doubleValue]-NSMinX(from))*k);
    if ([key isEqual:@"w"]) return @([value doubleValue]*k);
    if ([key isEqual:@"rect"]) {
        NSRect r=[value rectValue];
        return [NSValue valueWithRect:NSMakeRect(NSMinX(to)+(NSMinX(r)-NSMinX(from))*k,NSMinY(r),NSWidth(r)*k,NSHeight(r))];
    }
    return value;
}
// A value without a counterpart holds still while its feature fades.
static double AVMixPresent(double a, double b, BOOL hasA, BOOL hasB, double p) {
    return hasA && hasB?AVMix(a,b,p):hasA?a:b;
}
static double AVWeightSum(NSDictionary *weights) {
    double sum=0; for (NSNumber *weight in weights.allValues) sum+=weight.doubleValue; return sum;
}
static NSDictionary *AVBlendScene(NSDictionary *a, NSDictionary *b, double p) {
    NSMutableDictionary *scene=[NSMutableDictionary dictionary];
    // Decks pair lowest to lowest and glide in the drawn (log-scaled) height;
    // spare decks fade at their own height.
    NSArray *(^lowest)(NSArray *)=^NSArray *(NSArray *decks) {
        return [decks sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) { return [x[@"feet"] compare:y[@"feet"]]; }];
    };
    NSArray *fromDecks=lowest(a[@"decks"]), *toDecks=lowest(b[@"decks"]);
    NSMutableArray *decks=[NSMutableArray array];
    for (NSUInteger i=0;i<MAX(fromDecks.count,toDecks.count);i++)
        [decks addObject:AVBlendDeck(i<fromDecks.count?fromDecks[i]:nil,i<toDecks.count?toDecks[i]:nil,p)];
    scene[@"decks"]=decks;
    scene[@"texts"]=AVBlendTexts(a[@"texts"],b[@"texts"],p);
    for (NSString *key in @[@"rain",@"snow",@"haze",@"conditional",@"visibilityAlpha",@"hazardBand",@"hazardAmber",@"vicinity"])
        scene[key]=@(AVMix([a[key] doubleValue],[b[key] doubleValue],p));
    BOOL fallA=[a[@"rain"] doubleValue]+[a[@"snow"] doubleValue]>0, fallB=[b[@"rain"] doubleValue]+[b[@"snow"] doubleValue]>0;
    scene[@"precipitationTop"]=@(AVMixPresent([a[@"precipitationTop"] doubleValue],[b[@"precipitationTop"] doubleValue],fallA,fallB,p));
    double visibilityA=[a[@"visibilityX"] doubleValue], visibilityB=[b[@"visibilityX"] doubleValue];
    scene[@"visibilityX"]=@(AVMixPresent(visibilityA,visibilityB,isfinite(visibilityA),isfinite(visibilityB),p));
    // The aircraft rides its deck: both move in drawn height with one ease.
    scene[@"planeY"]=@(AVMixPresent([a[@"planeY"] doubleValue],[b[@"planeY"] doubleValue],AVWeightSum(a[@"weights"])>0,AVWeightSum(b[@"weights"])>0,p));
    NSMutableDictionary *weights=[NSMutableDictionary dictionary];
    for (NSString *name in @[@"plane",@"pc9",@"jumbo",@"sr71"])
        weights[name]=@(AVMix([a[@"weights"][name] doubleValue],[b[@"weights"][name] doubleValue],p));
    scene[@"weights"]=weights;
    return scene;
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
// One record per drawn panel: its TAF group, the scene source (a group, or a
// held blend morphing into one), and its animated layout weight and presence.
@property(nonatomic,strong) NSMutableArray<NSMutableDictionary *> *panels;
@property(nonatomic,strong) NSMutableDictionary<NSString *,NSDictionary *> *solarDays;
// The light's clock: the last displayed time (anchor) carried on at the rate
// the playhead moves, plus an elevation offset that settles after a jump.
@property(nonatomic) double lightAnchor, lightRate, lightOffset, lightVelocity;
@property(nonatomic) NSTimeInterval lightStamp, lightLead;
@property(nonatomic) BOOL draggingTimeline;
@property(nonatomic, strong) NSView *playheadCursor;
@end

@implementation AviationForecastView
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        _latitude=NAN; _longitude=NAN; _lightAnchor=NAN; _maximumFeet=60000;
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
        _lightStamp+=offset;
        for (NSMutableDictionary *panel in _panels) {
            panel[@"start"]=@([panel[@"start"] doubleValue]+offset);
            if (panel[@"source"][@"start"]) panel[@"source"]=AVWith(panel[@"source"],@{@"start":@([panel[@"source"][@"start"] doubleValue]+offset)});
        }
    }
    NSTimeInterval elapsed=time-_animationTime;
    _animationTime=time;
    _animationPhase=fmod(MAX(0,time),120);
    for (NSString *key in _aircraftTransitions.allKeys)
        if (time-[_aircraftTransitions[key][@"start"] doubleValue]>=.7) [_aircraftTransitions removeObjectForKey:key];
    [self settleLight:MAX(0,elapsed)];
    // Finished transitions collapse to their TAF group; closed panels go.
    NSMutableArray *panels=_panels?[NSMutableArray array]:nil;
    for (NSMutableDictionary *panel in _panels) {
        if ([self progressSince:[panel[@"start"] doubleValue]]>=1) {
            if ([panel[@"q1"] doubleValue]<=0) continue;
            panel[@"w0"]=panel[@"w1"]; panel[@"q0"]=panel[@"q1"];
        }
        if (panel[@"source"][@"start"] && [self progressSince:[panel[@"source"][@"start"] doubleValue]]>=1)
            panel[@"source"]=@{@"period":panel[@"period"]};
        [panels addObject:panel];
    }
    _panels=panels;
    [self setNeedsDisplayInRect:NSMakeRect(0,0,NSWidth(self.bounds),NSMinY(self.timelineRect))];
}
- (double)progressSince:(NSTimeInterval)start {
    if (NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return 1;
    return MIN(1,MAX(0,(self.animationTime-start)/AVSkySeconds));
}
- (void)setSelectedDate:(NSDate *)date {
    BOOL same = date == _selectedDate || [date isEqualToDate:_selectedDate];
    if (!same) {
        NSDate *old = _selectedDate;
        NSArray *before = [self displayedPeriodsAtDate:old ?: self.now];
        NSArray *after = [self displayedPeriodsAtDate:date ?: self.now];
        _selectedDate = date;
        if (![before isEqualToArray:after]) {
            // Same sky transition as a pointer move between TAF periods.
            [self inspectDate:nil];
        } else {
            [self followLight];
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
    _now=now; [self resetLight]; [self updateScenesAnimated:NO]; self.needsDisplay=YES;
}
- (void)setLatitude:(double)latitude {
    _latitude=latitude; [self.solarDays removeAllObjects]; [self resetLight]; self.needsDisplay=YES;
}
- (void)setLongitude:(double)longitude {
    _longitude=longitude; [self.solarDays removeAllObjects]; [self resetLight]; self.needsDisplay=YES;
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
- (double)lightTargetElevation {
    double elevation=SolarElevation(self.latitude,self.longitude,self.inspectedDate?:self.selectedDate?:self.now);
    return isfinite(elevation)?MAX(-8,MIN(2,elevation)):elevation;
}
- (double)elevationAt:(NSTimeInterval)seconds {
    if (!isfinite(seconds)) return NAN;
    double elevation=SolarElevation(self.latitude,self.longitude,[NSDate dateWithTimeIntervalSinceReferenceDate:seconds]);
    return isfinite(elevation)?MAX(-8,MIN(2,elevation)):elevation;
}
- (void)resetLight { _lightAnchor=NAN; _lightRate=_lightLead=_lightOffset=_lightVelocity=0; }
- (NSTimeInterval)lightSeconds {
    return _lightAnchor+_lightRate*MIN(MAX(0,self.animationTime-_lightStamp),_lightLead);
}
// Light follows the displayed time. A playing map sends its time a few to
// sixty times a second in small regular steps; the light carries each one on
// at that rate until the next, so the sky moves every frame without lagging.
// Anything else (hover, a click back to now, a seek) is a jump: the light
// leaves from what is on screen and settles on a critically damped spring.
- (void)followLight {
    double shown=[self displayedSolarElevation], previous=[self elevationAt:_lightAnchor];
    double seconds=(self.inspectedDate?:self.selectedDate?:self.now).timeIntervalSinceReferenceDate;
    double step=seconds-_lightAnchor, interval=self.animationTime-_lightStamp;
    BOOL playing=fabs(step)>0 && fabs(step)<=1800 && interval>0 && interval<=.5;
    _lightRate=playing?step/interval:0; _lightLead=playing?interval*1.25:0;
    _lightAnchor=seconds; _lightStamp=self.animationTime;
    double target=[self elevationAt:seconds];
    if (!isfinite(shown) || !isfinite(target) || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) _lightOffset=_lightVelocity=0;
    else _lightOffset=shown-target;
    if (isfinite(previous)!=isfinite(target) || fabs(previous-target)>.01)
        [self setNeedsDisplayInRect:NSMakeRect(0,0,NSWidth(self.bounds),NSMinY(self.timelineRect))];
}
- (void)settleLight:(NSTimeInterval)elapsed {
    // A playhead that stops sending its time leaves the light where it got
    // to; it settles back to the last time sent.
    if (_lightRate && self.animationTime-_lightStamp>_lightLead) {
        double reached=[self elevationAt:[self lightSeconds]], sent=[self elevationAt:_lightAnchor];
        if (isfinite(reached) && isfinite(sent)) _lightOffset+=reached-sent;
        _lightRate=_lightLead=0;
    }
    if (!_lightOffset && !_lightVelocity) return;
    double w=8, decay=exp(-w*elapsed), offset=_lightOffset, velocity=_lightVelocity;
    _lightOffset=(offset+(velocity+w*offset)*elapsed)*decay;
    _lightVelocity=(velocity-w*(velocity+w*offset)*elapsed)*decay;
    if (fabs(_lightOffset)<.001 && fabs(_lightVelocity)<.001) _lightOffset=_lightVelocity=0;
}
- (double)displayedSolarElevation {
    if (!isfinite(_lightAnchor) || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return [self lightTargetElevation];
    double elevation=[self elevationAt:[self lightSeconds]];
    return isfinite(elevation)?elevation+_lightOffset:elevation;
}
- (NSString *)daylightLabelAtDate:(NSDate *)date includeEvent:(BOOL)includeEvent {
    NSDictionary *day=[self daylightAtDate:date];
    if (!day) return @"";
    NSString *state=day[@"state"],*label=[state isEqual:@"night"]?@"Civil night":[state isEqual:@"civilTwilight"]?@"Civil twilight":@"Day";
    NSDate *dawn=day[@"civilDawn"],*dusk=day[@"civilDusk"];
    if (!includeEvent) return label;
    BOOL beforeDawn=dawn && [date compare:dawn]==NSOrderedAscending;
    NSDate *event=beforeDawn?dawn:dusk;
    NSString *name=beforeDawn?@"civil twilight start":@"civil twilight end";
    if (!beforeDawn && dusk && [date compare:dusk]==NSOrderedDescending) {
        NSCalendar *calendar=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; calendar.timeZone=self.timeZone;
        NSDate *tomorrow=[calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:date options:0];
        event=[self daylightAtDate:tomorrow][@"civilDawn"]; name=@"civil twilight start";
    }
    if (event && [date compare:event]!=NSOrderedDescending)
        label=[label stringByAppendingFormat:@" · %@ %@",name,AVTime(event,self.timeZone,NO)];
    return label;
}
- (NSDictionary *)focusedPeriod {
    NSArray *active=[self displayedPeriodsAtDate:self.inspectedDate?:self.selectedDate?:self.now];
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
- (void)refreshHazardTip {
    NSString *clamped=[self coverageNoteAtDate:self.displayDate];
    NSMutableArray *explain=[NSMutableArray array];
    for (NSDictionary *period in [self displayedPeriodsAtDate:self.displayDate]) {
        NSString *tip=FlyConvectiveTip(period[@"weather"], AVLayers(period));
        if (tip.length && ![explain containsObject:tip]) [explain addObject:tip];
    }
    if (clamped.length) [explain addObject:clamped];
    self.toolTip=explain.count?[explain componentsJoinedByString:@"\n"]:nil;
}
- (void)setPeriods:(NSArray<NSDictionary *> *)periods {
    _periods=[periods copy]; [self.cloudSelections removeAllObjects]; [self.aircraftTransitions removeAllObjects];
    self.panels=nil; self.focusedPeriodKey=nil; [self refreshHazardTip]; self.needsDisplay=YES;
}
- (void)setAirportCode:(NSString *)code {
    NSString *next=code.length?[code uppercaseString]:nil;
    if (_airportCode==next || [_airportCode isEqual:next]) return;
    _airportCode=[next copy]; self.panels=nil; self.needsDisplay=YES;
}
- (NSString *)graphicTitleAtDate:(NSDate *)date {
    NSString *heading=self.airportCode.length?[NSString stringWithFormat:@"%@ TAF",self.airportCode]:@"TAF";
    NSString *light=[self daylightLabelAtDate:date includeEvent:YES];
    if (light.length) heading=[heading stringByAppendingFormat:@" · %@",light];
    return heading;
}
- (NSString *)skyTitleAtDate:(NSDate *)date width:(CGFloat)width {
    NSFont *font=[NSFont monospacedDigitSystemFontOfSize:10 weight:NSFontWeightSemibold];
    NSDictionary *attrs=@{NSFontAttributeName:font};
    BOOL (^fits)(NSString *)=^BOOL(NSString *text) {
        return ceil([text sizeWithAttributes:attrs].width)<=width+0.5;
    };
    NSString *light=[self daylightLabelAtDate:date includeEvent:YES];
    light=[light stringByReplacingOccurrencesOfString:@"Civil night" withString:@"night"];
    light=[light stringByReplacingOccurrencesOfString:@"Civil twilight" withString:@"twilight"];
    NSString *withEvent=light.length?[@"TAF · " stringByAppendingString:light]:@"TAF";
    if (fits(withEvent)) return withEvent;
    NSString *state=[self daylightLabelAtDate:date includeEvent:NO];
    state=[state stringByReplacingOccurrencesOfString:@"Civil night" withString:@"night"];
    state=[state stringByReplacingOccurrencesOfString:@"Civil twilight" withString:@"twilight"];
    if ([state isEqual:@"Day"]) state=@"day";
    return state.length?[@"TAF · " stringByAppendingString:state]:@"TAF";
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
- (NSString *)accessibilityLabel {
    return self.airportCode.length?[NSString stringWithFormat:@"%@ TAF cloud layers and horizontal visibility",self.airportCode]:@"TAF cloud layers and horizontal visibility";
}
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
- (NSString *)coverageClock:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class]) return @"";
    NSTimeZone *zone = self.timeZone ?: [NSTimeZone localTimeZone];
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone;
    NSInteger minute = [calendar component:NSCalendarUnitMinute fromDate:date];
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU"];
    fmt.timeZone = zone;
    fmt.dateFormat = minute ? @"EEE h:mm a" : @"EEE h a";
    NSString *text = [[fmt stringFromDate:date] lowercaseString];
    // The weekday stays capitalised: "Wed 8 am".
    if (text.length) text = [[[text substringToIndex:1] uppercaseString] stringByAppendingString:[text substringFromIndex:1]];
    return text ?: @"";
}

- (void)coverageBoundsFirst:(NSDate **)first last:(NSDate **)last {
    NSDate *start = nil, *end = nil;
    for (NSDictionary *p in self.periods) {
        NSDate *a = p[@"start"], *b = p[@"end"];
        if (![a isKindOfClass:NSDate.class] || ![b isKindOfClass:NSDate.class]) continue;
        if (!start || [a compare:start] == NSOrderedAscending) start = a;
        if (!end || [b compare:end] == NSOrderedDescending) end = b;
    }
    if (first) *first = start;
    if (last) *last = end;
}

- (NSString *)coverageNoteAtDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class] || [self activePeriodsAtDate:date].count) return nil;
    NSDate *first = nil, *last = nil;
    [self coverageBoundsFirst:&first last:&last];
    if (!first || !last) return nil;
    if ([date compare:last] != NSOrderedAscending)
        return [NSString stringWithFormat:@"TAF ends %@ \u2014 showing last period", [self coverageClock:last]];
    if ([date compare:first] == NSOrderedAscending)
        return [NSString stringWithFormat:@"TAF starts %@ \u2014 showing first period", [self coverageClock:first]];
    return nil;
}

- (NSArray<NSDictionary *> *)displayedPeriodsAtDate:(NSDate *)date {
    NSArray *active = [self activePeriodsAtDate:date];
    if (active.count || ![date isKindOfClass:NSDate.class]) return active;
    NSDate *first = nil, *last = nil;
    [self coverageBoundsFirst:&first last:&last];
    if (last && [date compare:last] != NSOrderedAscending)
        return [self activePeriodsAtDate:[last dateByAddingTimeInterval:-1]];
    if (first && [date compare:first] == NSOrderedAscending)
        return [self activePeriodsAtDate:first];
    return active;
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
    NSMutableArray *parts=[NSMutableArray array];
    if (self.airportCode.length) [parts addObject:[self graphicTitleAtDate:date]];
    [parts addObject:AVTime(date,self.timeZone,YES)];
    NSString *light=[self daylightLabelAtDate:date includeEvent:YES];
    if (light.length) [parts addObject:light];
    NSString *note = [self coverageNoteAtDate:date];
    NSArray *shown = [self displayedPeriodsAtDate:date];
    for (NSDictionary *p in shown) {
        NSString *wx=p[@"weather"], *change=AVConditional(p)?[p[@"change"] stringByAppendingString:@" · "]:@"";
        [parts addObject:[NSString stringWithFormat:@"%@%@ / %@%@",change,p[@"ceiling"]?:@"—",p[@"visibility"]?:@"—",
            wx.length && ![wx isEqual:@"—"]?[@" · " stringByAppendingString:wx]:@""]];
        for (NSDictionary *layer in AVLayers(p)) {
            NSString *base=AVNumber(layer[@"baseFt"])?AVFeet(layer[@"baseFt"]):@"Unknown base";
            NSString *type=layer[@"type"]?:@"";
            if ([type isEqual:@"CB"] || [type isEqual:@"TCU"]) [parts addObject:[NSString stringWithFormat:@"%@ %@", type, base]];
            else [parts addObject:[NSString stringWithFormat:@"%@ %@ %@",layer[@"amount"]?:@"Cloud",base,type]];
        }
        NSString *hazardTip=FlyConvectiveTip(wx, AVLayers(p));
        if (hazardTip.length) [parts addObject:hazardTip];
    }
    if (note.length) [parts addObject:note];
    else if (!shown.count) [parts addObject:@"No TAF period"];
    return [parts componentsJoinedByString:@"   |   "];
}
- (void)inspectDate:(NSDate *)date {
    self.inspectedDate=date;
    [self updateScenesAnimated:YES]; [self followLight];
    if (self.onInspect) self.onInspect(date?[self summaryAtDate:date]:nil);
    self.needsDisplay=YES;
}
- (NSDate *)displayDate { return self.inspectedDate?:self.selectedDate?:self.now?:self.start; }
- (double)panelWeightAtIndex:(NSUInteger)index of:(NSArray *)active {
    return index==0 && active.count>1 && !AVConditional(active[0])?1.18:1;
}
// Brings the panels to the TAF groups active at the displayed time. A changed
// group morphs its panel from whatever is on screen; a new group's panel opens
// beside the others and a finished one closes while the rest re-lay out. With
// Reduce Motion, offscreen, or before the first draw, the state is set at once.
- (void)updateScenesAnimated:(BOOL)animated {
    NSArray *active=[self displayedPeriodsAtDate:self.displayDate];
    NSMutableArray *shown=[NSMutableArray array];
    for (NSDictionary *panel in self.panels) if ([panel[@"q1"] doubleValue]>0) [shown addObject:panel[@"period"]];
    if (self.panels && [shown isEqualToArray:active]) return;
    NSTimeInterval now=self.animationTime;
    if (!animated || !self.panels || !self.window || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        self.panels=[NSMutableArray array];
        for (NSUInteger i=0;i<active.count;i++) {
            double weight=[self panelWeightAtIndex:i of:active];
            [self.panels addObject:[@{@"key":AVPeriodKey(active[i]),@"period":active[i],@"source":@{@"period":active[i]},
                @"w0":@(weight),@"w1":@(weight),@"q0":@1,@"q1":@1,@"n0":@(NAN),@"start":@(now)} mutableCopy]];
        }
        return;
    }
    NSArray *previous=self.panels, *frames=[self panelFrames];
    NSMutableArray *next=[NSMutableArray array]; NSMutableIndexSet *used=[NSMutableIndexSet indexSet];
    for (NSUInteger i=0;i<active.count;i++) [next addObject:NSNull.null];
    // The same TAF group keeps its panel, even one that was closing; the
    // remaining open panels take the remaining groups in order.
    for (NSUInteger i=0;i<active.count;i++) {
        NSUInteger j=[previous indexOfObjectPassingTest:^BOOL(NSDictionary *panel, NSUInteger k, BOOL *stop) {
            (void)stop; return ![used containsIndex:k] && [panel[@"key"] isEqual:AVPeriodKey(active[i])]; }];
        if (j!=NSNotFound) { [used addIndex:j]; next[i]=previous[j]; }
    }
    NSUInteger j=0;
    for (NSUInteger i=0;i<active.count;i++) {
        if (next[i]!=NSNull.null) continue;
        while (j<previous.count && ([used containsIndex:j] || [previous[j][@"q1"] doubleValue]<=0)) j++;
        if (j<previous.count) { [used addIndex:j]; next[i]=previous[j]; }
    }
    double (^tween)(NSDictionary *, NSString *, NSString *)=^double(NSDictionary *panel, NSString *from, NSString *to) {
        return AVMix([panel[from] doubleValue],[panel[to] doubleValue],AVEase([self progressSince:[panel[@"start"] doubleValue]]));
    };
    // Where a panel's content is laid out now; a retarget starts from it.
    NSRect (^content)(NSDictionary *)=^NSRect(NSDictionary *panel) {
        NSUInteger f=[frames indexOfObjectPassingTest:^BOOL(NSDictionary *frame, NSUInteger index, BOOL *stop) { (void)index; (void)stop; return frame[@"panel"]==panel; }];
        return f==NSNotFound?NSMakeRect(0,0,NSWidth(self.bounds),MAX(0,NSMinY(self.timelineRect)-6)):[frames[f][@"content"] rectValue];
    };
    for (NSUInteger i=0;i<active.count;i++) {
        double weight=[self panelWeightAtIndex:i of:active];
        if (next[i]==NSNull.null) {
            next[i]=[@{@"key":AVPeriodKey(active[i]),@"period":active[i],@"source":@{@"period":active[i]},
                @"w0":@(weight),@"w1":@(weight),@"q0":@0,@"q1":@1,@"n0":@(NAN),@"start":@(now)} mutableCopy];
            continue;
        }
        NSMutableDictionary *panel=next[i]; NSRect laid=content(panel);
        if (![panel[@"period"] isEqual:active[i]]) {
            panel[@"source"]=@{@"from":[self heldSource:panel[@"source"] rect:laid depth:0],@"period":active[i],@"start":@(now)};
            panel[@"period"]=active[i]; panel[@"key"]=AVPeriodKey(active[i]);
        }
        double w=tween(panel,@"w0",@"w1"), q=tween(panel,@"q0",@"q1");
        [panel addEntriesFromDictionary:@{@"w0":@(w),@"w1":@(weight),@"q0":@(q),@"q1":@1,@"n0":@(NSWidth(laid)),@"start":@(now)}];
    }
    // Closing panels keep their place and their content's current layout.
    for (NSUInteger k=0;k<previous.count;k++) {
        if ([used containsIndex:k]) continue;
        NSMutableDictionary *panel=previous[k];
        if ([panel[@"q1"] doubleValue]>0) {
            double w=tween(panel,@"w0",@"w1"), q=tween(panel,@"q0",@"q1");
            [panel addEntriesFromDictionary:@{@"w0":@(w),@"w1":@(w),@"q0":@(q),@"q1":@0,@"n0":@(NSWidth(content(panel))),@"start":@(now)}];
        }
        [next insertObject:panel atIndex:MIN(k,next.count)];
    }
    self.panels=next;
}
// The displayed state of a source, held still: a blend keeps its current
// progress. Under fast scrubbing the third held blend is flattened into the
// scene it shows in `rect`, never replaced by a group, so a hold cannot jump.
- (NSDictionary *)heldSource:(NSDictionary *)source rect:(NSRect)rect depth:(NSUInteger)depth {
    if (!source[@"from"]) return source;
    double progress=source[@"progress"]?[source[@"progress"] doubleValue]:[self progressSince:[source[@"start"] doubleValue]];
    if (progress>=1) return @{@"period":source[@"period"]};
    NSDictionary *held=@{@"period":source[@"period"],@"from":source[@"from"],@"progress":@(progress)};
    if (depth>=2) return @{@"scene":[self sceneForSource:held rect:rect],@"rect":[NSValue valueWithRect:rect]};
    return @{@"period":source[@"period"],@"from":[self heldSource:source[@"from"] rect:rect depth:depth+1],@"progress":@(progress)};
}
// Each panel's rect now. Widths follow animated weights; an opening or closing
// panel's share and leading gap scale with its presence, and its content keeps
// its full-size layout, revealed or covered by the moving edge.
- (NSArray<NSDictionary *> *)panelFrames {
    NSUInteger count=self.panels.count;
    CGFloat height=MAX(0,NSMinY(self.timelineRect)-6), gap=8, width=NSWidth(self.bounds);
    double presence[count?count:1], weight[count?count:1], top=0, share=0, gaps=0, seen=0, target=0;
    NSUInteger open=0;
    for (NSUInteger i=0;i<count;i++) {
        NSDictionary *panel=self.panels[i]; double e=AVEase([self progressSince:[panel[@"start"] doubleValue]]);
        presence[i]=AVMix([panel[@"q0"] doubleValue],[panel[@"q1"] doubleValue],e);
        weight[i]=AVMix([panel[@"w0"] doubleValue],[panel[@"w1"] doubleValue],e);
        top=MAX(top,presence[i]);
        if ([panel[@"q1"] doubleValue]>0) { target+=[panel[@"w1"] doubleValue]; open++; }
    }
    if (top<=0) return @[];
    for (NSUInteger i=0;i<count;i++) {
        double r=presence[i]/top; share+=weight[i]*r;
        if (i) gaps+=gap*r*seen;
        seen=MAX(seen,r);
    }
    CGFloat unit=MAX(0,width-gaps)/MAX(1e-9,share), targetUnit=MAX(0,width-gap*(open?open-1:0))/MAX(1e-9,target), x=0;
    NSMutableArray *frames=[NSMutableArray array]; seen=0;
    for (NSUInteger i=0;i<count;i++) {
        NSDictionary *panel=self.panels[i]; double r=presence[i]/top;
        if (i) x+=gap*r*seen;
        seen=MAX(seen,r);
        CGFloat panelWidth=weight[i]*r*unit;
        // Full-size content width: an open panel's final width, a closing
        // panel's width when it began to close, interpolated from the width
        // laid out when it last changed direction.
        double e=AVEase([self progressSince:[panel[@"start"] doubleValue]]), held=[panel[@"n0"] doubleValue];
        CGFloat goal=[panel[@"q1"] doubleValue]>0?[panel[@"w1"] doubleValue]*targetUnit:held;
        CGFloat natural=isfinite(held)?AVMix(held,goal,e):goal;
        [frames addObject:@{@"panel":panel,@"card":[NSValue valueWithRect:NSMakeRect(x,0,panelWidth,height)],
            @"content":[NSValue valueWithRect:NSMakeRect(x,0,presence[i]<1?MAX(panelWidth,natural):panelWidth,height)],@"alpha":@(presence[i])}];
        x+=panelWidth;
    }
    return frames;
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
    NSArray *active=[self displayedPeriodsAtDate:self.inspectedDate?:self.selectedDate?:self.now];
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

// The drawable state of one TAF group in a panel rect. Heights are drawn
// heights (AVLayerY), so blending two scenes glides decks on the log scale.
- (NSDictionary *)sceneForPeriod:(NSDictionary *)period rect:(NSRect)rect {
    double maximumFeet=self.maximumFeet;
    AviationSceneGeometry g=AviationSceneLayout(rect,period,maximumFeet);
    NSMutableArray *texts=[NSMutableArray array];
    CGFloat headingWidth=MAX(48, NSWidth(rect)-117);
    NSString *heading=AVConditional(period)?AVBadge(period):[self skyTitleAtDate:self.inspectedDate?:self.selectedDate?:self.now width:headingWidth];
    [texts addObject:AVTextItem(@"heading",heading,NSMakeRect(NSMinX(rect)+10,NSMinY(rect)+5,headingWidth,16),10,YES,YES,NSTextAlignmentLeft)];
    NSString *weather=[period[@"weather"] isKindOfClass:NSString.class]?period[@"weather"]:@"";
    if (weather.length && ![@[@"—",@"NSW",@"CAVOK"] containsObject:weather])
        [texts addObject:AVTextItem(@"weather",weather,NSMakeRect(NSMinX(rect)+10,NSMinY(rect)+21,NSWidth(rect)-20,14),9,NO,NO,NSTextAlignmentRight)];

    NSArray *layers=AVLayers(period);
    CGFloat cloudLeft=AVCloudLeft(rect), cloudRight=NSMaxX(rect)-12;
    NSDictionary *selected=layers.count?layers[MIN((NSUInteger)[self selectedIndexForPeriod:period],layers.count-1)]:nil;
    NSDictionary *presentation=[self aircraftPresentationForPeriod:period];
    // Cloud textures drift independently of their measured base. Neither cloud
    // tops nor drift speed are measurements in a TAF.
    NSArray *ordered=[layers sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a,NSDictionary *b) {
        return [AVNumber(b[@"baseFt"])?:@0 compare:AVNumber(a[@"baseFt"])?:@0];
    }];
    CGFloat labelBottom=NSMinY(rect)+24;
    NSMutableArray *decks=[NSMutableArray array];
    for (NSUInteger layerIndex=0;layerIndex<ordered.count;layerIndex++) {
        NSDictionary *layer=ordered[layerIndex];
        NSNumber *base=AVNumber(layer[@"baseFt"]);
        NSString *amount=layer[@"amount"]?:@"Cloud", *type=layer[@"type"]?:@"";
        if (!base) {
            [texts addObject:AVTextItem([NSString stringWithFormat:@"note%lu",(unsigned long)layerIndex],[NSString stringWithFormat:@"%@ · base unknown",amount],
                NSMakeRect(NSMinX(rect)+10,labelBottom,NSWidth(rect)-20,15),10,NO,NO,NSTextAlignmentLeft)];
            labelBottom+=15; continue;
        }
        CGFloat y=AVLayerY(rect,base.doubleValue,maximumFeet);
        CGFloat labelY=MAX(labelBottom,MIN(g.groundY-15*(ordered.count-layerIndex),y-9));
        NSString *height=[AVFeet(base) stringByReplacingOccurrencesOfString:@" ft" withString:@""];
        BOOL storm=[type isEqual:@"CB"], tower=[type isEqual:@"TCU"];
        NSString *label=storm?[NSString stringWithFormat:@"CB %@",height]:tower?[NSString stringWithFormat:@"TCU %@",height]:
            (cloudLeft-NSMinX(rect)<90?height:[NSString stringWithFormat:@"%@ %@",amount,height]);
        labelBottom=labelY+15;
        NSInteger count=storm||tower?1:[amount isEqual:@"FEW"]?1:[amount isEqual:@"SCT"]?2:[amount isEqual:@"BKN"]?3:4;
        CGFloat coverage=[amount isEqual:@"FEW"]?.20:[amount isEqual:@"SCT"]?.55:[amount isEqual:@"BKN"]?.95:1.25;
        CGFloat cloudW=MIN(210,MAX(70,(cloudRight-cloudLeft)*coverage/count));
        CGFloat cloudH=MAX(18,MIN(storm?100:tower?84:cloudW*.5,y-NSMinY(rect)-21));
        // TAFs report bases, not tops. The artwork fills the weather field;
        // the anchored line and number carry the measured height.
        if (storm || tower) cloudW=MIN(cloudW,cloudH*1.1);
        NSMutableArray *sprites=[NSMutableArray array];
        for (NSInteger i=0;i<count;i++)
            [sprites addObject:@{@"x":@(cloudLeft+(cloudRight-cloudLeft-cloudW)*(count==1?.35:(double)i/(count-1))),@"w":@(cloudW),@"h":@(cloudH),
                @"image":storm?@"storm":tower?@"tower":@"cloud",@"alpha":@1}];
        [decks addObject:@{@"y":@(y),@"feet":base,@"alpha":@1,@"line":@(layer==selected?.85:.35),@"labelY":@(labelY),@"leader":@(fabs(labelY+7-y)>5?1:0),
            @"labels":@[AVTextItem(@"label",label,NSMakeRect(NSMinX(rect)+8,labelY,cloudLeft-NSMinX(rect)-12,14),10,YES,layer==selected,NSTextAlignmentLeft)],
            @"types":(!storm && !tower && type.length)?@[AVTextItem(@"type",type,NSMakeRect(cloudRight-27,y-15,25,13),9,YES,YES,NSTextAlignmentRight)]:@[],
            @"mark":storm?@"TS":tower?@"TCU":@"",@"sprites":sprites}];
    }
    BOOL rain=[weather containsString:@"RA"], snow=[weather containsString:@"SN"];
    CGFloat precipitationTop=g.groundY-35;
    for (NSDictionary *layer in layers) if (AVNumber(layer[@"baseFt"]))
        precipitationTop=MIN(precipitationTop,AVLayerY(rect,[layer[@"baseFt"] doubleValue],maximumFeet));
    NSNumber *visibility=AVNumber(period[@"visibilityM"]);
    if (!layers.count) {
        NSString *state=period[@"ceilingState"];
        [texts addObject:AVTextItem(@"cloudless",[state isEqual:@"cavok"]?@"CAVOK":[state isEqual:@"none"]?@"No ceiling":@"Cloud unavailable",
            NSMakeRect(NSMinX(rect)+10,NSMinY(rect)+32,NSWidth(rect)-20,18),11,NO,NO,NSTextAlignmentLeft)];
    }
    [texts addObject:AVTextItem(@"visibility",period[@"visibility"]?:@"—",NSMakeRect(NSMinX(rect)+8,g.groundY+14,85,15),11,YES,YES,NSTextAlignmentLeft)];
    // The illustrative aircraft follows the selected weather feature. Its
    // silhouette changes with height; it is not traffic or an approach path.
    double selectedFeet=[presentation[@"feet"] doubleValue];
    NSString *hazard=FlyConvectiveHazard(weather, layers);
    BOOL span=AVHazardSpan(period);
    return @{@"decks":decks,@"texts":texts,@"rain":@(rain && !snow?1:0),@"snow":@(snow?1:0),@"precipitationTop":@(precipitationTop),
        @"haze":@(visibility && visibility.doubleValue<8000?.38*(1-visibility.doubleValue/10000):0),
        @"visibilityX":@(g.visibilityEnd.x),@"visibilityAlpha":@(isfinite(g.visibilityEnd.x)?1:0),@"conditional":@(AVConditional(period)?1:0),
        @"hazardBand":@(span && [hazard isEqual:@"TS"]?1:0),
        @"hazardAmber":@([period[@"change"] hasPrefix:@"PROB"]?1:0),
        @"vicinity":@([hazard isEqual:@"VCTS"]?1:0),
        @"planeY":@(layers.count?AVLayerY(rect,selectedFeet,maximumFeet):g.groundY-16),@"weights":presentation[@"weights"]?:@{}};
}
- (NSDictionary *)sceneForSource:(NSDictionary *)source rect:(NSRect)rect {
    if (source[@"scene"]) {
        NSRect drawn=[source[@"rect"] rectValue];
        return NSEqualRects(drawn,rect)?source[@"scene"]:AVRescaled(source[@"scene"],nil,drawn,rect);
    }
    NSDictionary *scene=[self sceneForPeriod:source[@"period"] rect:rect];
    if (!source[@"from"]) return scene;
    double progress=source[@"progress"]?[source[@"progress"] doubleValue]:[self progressSince:[source[@"start"] doubleValue]];
    return progress>=1?scene:AVBlendScene([self sceneForSource:source[@"from"] rect:rect],scene,AVEase(progress));
}
- (void)paintScene:(NSDictionary *)scene rect:(NSRect)rect card:(NSRect)cardRect {
    [NSGraphicsContext saveGraphicsState];
    NSBezierPath *card=[NSBezierPath bezierPathWithRoundedRect:cardRect xRadius:8 yRadius:8];
    [card addClip];
    // Forecast illumination follows the airport's sun, independently of the
    // desktop theme. Night is deliberately pale enough to read the weather.
    double elevation=[self displayedSolarElevation], conditional=[scene[@"conditional"] doubleValue];
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
    NSColor *prevailing=[NSColor colorWithSRGBRed:.13 green:.39 blue:.64 alpha:1], *changing=[NSColor colorWithSRGBRed:.64 green:.34 blue:.10 alpha:1];
    NSColor *accent=conditional<=0?prevailing:conditional>=1?changing:[prevailing blendedColorWithFraction:conditional ofColor:changing];
    [sky setFill]; [card fill];
    AviationSceneGeometry g=AviationSceneLayout(rect,@{},self.maximumFeet);
    NSGradient *skyGradient=[[NSGradient alloc] initWithStartingColor:sky endingColor:horizon];
    [skyGradient drawInRect:cardRect angle:90];
    [[muted colorWithAlphaComponent:.065] setFill];
    NSRectFillUsingOperation(NSMakeRect(NSMinX(rect),g.groundY,NSWidth(rect),NSMaxY(rect)-g.groundY),NSCompositingOperationSourceOver);
    AVPaintTexts(scene[@"texts"],@"heading",ink,muted,1);
    AVText(@"0–60k ft AGL",NSMakeRect(NSMaxX(rect)-96,NSMinY(rect)+6,86,14),9,muted,NO,NSTextAlignmentRight);
    AVPaintTexts(scene[@"texts"],@"weather",ink,muted,1);

    CGFloat cloudLeft=AVCloudLeft(rect), cloudRight=NSMaxX(rect)-12;
    if (NSHeight(rect)>140) for (NSNumber *tick in @[@3000,@10000,@30000,@60000]) {
        CGFloat y=AVLayerY(rect,tick.doubleValue,self.maximumFeet);
        AVLine(NSMakePoint(cloudLeft,y),NSMakePoint(cloudRight,y),[muted colorWithAlphaComponent:.14],.5,YES);
        AVText([NSString stringWithFormat:@"%.0fk",tick.doubleValue/1000],NSMakeRect(cloudRight-26,y-13,24,12),8,muted,NO,NSTextAlignmentRight);
    }
    NSArray *decks=[scene[@"decks"] sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [b[@"feet"] compare:a[@"feet"]]; }];
    for (NSDictionary *deck in decks) {
        CGFloat y=[deck[@"y"] doubleValue], labelY=[deck[@"labelY"] doubleValue], alpha=[deck[@"alpha"] doubleValue];
        if (alpha<=.001) continue;
        AVPaintTexts(deck[@"labels"],nil,ink,muted,alpha);
        CGFloat leader=[deck[@"leader"] doubleValue]*alpha;
        if (leader>.001) AVLine(NSMakePoint(cloudLeft-10,labelY+7),NSMakePoint(cloudLeft-3,y),[muted colorWithAlphaComponent:.35*leader],.5,NO);
        AVStyledLine(NSMakePoint(cloudLeft-3,y),NSMakePoint(cloudRight,y),accent,[deck[@"line"] doubleValue]*alpha,1,conditional);
        CGFloat drift=sin(self.animationPhase*2*M_PI/30+[deck[@"feet"] doubleValue]*.001)*5;
        for (NSDictionary *sprite in deck[@"sprites"]) {
            CGFloat h=[sprite[@"h"] doubleValue];
            AVImage(AVAsset(sprite[@"image"]),NSMakeRect([sprite[@"x"] doubleValue]+drift,y-h,[sprite[@"w"] doubleValue],h),.95*[sprite[@"alpha"] doubleValue]*alpha);
        }
        AVPaintTexts(deck[@"types"],nil,ink,muted,alpha);
        NSString *mark=deck[@"mark"];
        // The turret sprite is the TCU mark. Thunder is the word TS, in red, beside the anvil.
        if ([mark isEqual:@"TS"] && alpha>.05 && [scene[@"vicinity"] doubleValue]<.2)
            AVPaintTag(@"TS", NSMakeRect(cloudRight-78, y-18, 34, 16), AVHazardColour(@"TS"), NSColor.whiteColor);
    }
    AVPaintTexts(scene[@"texts"],@"note",ink,muted,1);
    double rain=[scene[@"rain"] doubleValue], snow=[scene[@"snow"] doubleValue];
    if (rain>.001 || snow>.001) {
        CGFloat precipitationTop=[scene[@"precipitationTop"] doubleValue];
        [NSGraphicsContext saveGraphicsState];
        NSRect precipitation=NSMakeRect(cloudLeft,precipitationTop,MAX(0,cloudRight-cloudLeft),MAX(0,g.groundY-precipitationTop));
        [[NSBezierPath bezierPathWithRect:precipitation] addClip];
        if (snow>.001) {
            CGFloat phase=fmod(self.animationPhase*9,20);
            [[ink colorWithAlphaComponent:.24*snow] setFill];
            for (CGFloat x=cloudLeft+8;x<cloudRight;x+=17) for (CGFloat y=precipitationTop-20+phase;y<g.groundY;y+=20)
                [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x,y,2,2)] fill];
        }
        if (rain>.001) {
            CGFloat phase=fmod(self.animationPhase*28,20);
            for (CGFloat x=cloudLeft+8;x<cloudRight;x+=17) for (CGFloat y=precipitationTop-20+phase;y<g.groundY;y+=20)
                AVLine(NSMakePoint(x,y),NSMakePoint(x-2,y+5),[NSColor.systemBlueColor colorWithAlphaComponent:.27*rain],1,NO);
        }
        [NSGraphicsContext restoreGraphicsState];
    }
    CGFloat strength=[scene[@"haze"] doubleValue];
    if (strength>0) {
        NSGradient *haze=[[NSGradient alloc] initWithStartingColor:[sky colorWithAlphaComponent:0]
            endingColor:[sky colorWithAlphaComponent:strength]];
        [haze drawInRect:NSMakeRect(cloudLeft,NSMinY(rect)+24,MAX(0,cloudRight-cloudLeft),MAX(0,g.groundY-NSMinY(rect)-24)) angle:0];
    }
    AVPaintTexts(scene[@"texts"],@"cloudless",ink,muted,1);
    CGFloat planeW=MIN(44,MAX(30,NSWidth(rect)*.12)), planeH=planeW*.5;
    CGFloat planeX=cloudLeft+8+sin(self.animationPhase*2*M_PI/24)*5;
    CGFloat bob=sin(self.animationPhase*2*M_PI/6)*.7;
    CGFloat planeTop=MAX(NSMinY(rect)+21,MIN(g.groundY-planeH-2,[scene[@"planeY"] doubleValue]-planeH*.55+bob));
    NSDictionary *weights=scene[@"weights"];
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
    AVPaintTexts(scene[@"texts"],@"visibility",ink,muted,1);
    AVLine(g.visibilityStart,NSMakePoint(g.visibilityMaxX,g.visibilityStart.y),[muted colorWithAlphaComponent:.2],3,NO);
    CGFloat end=[scene[@"visibilityX"] doubleValue], shown=[scene[@"visibilityAlpha"] doubleValue];
    if (isfinite(end) && shown>.001) {
        NSPoint tip=NSMakePoint(end,g.visibilityStart.y);
        NSColor *arrow=shown>=1?accent:[accent colorWithAlphaComponent:shown];
        AVStyledLine(g.visibilityStart,tip,accent,shown,3,conditional);
        AVLine(NSMakePoint(tip.x-3,tip.y-3),tip,arrow,1.5,NO);
        AVLine(NSMakePoint(tip.x-3,tip.y+3),tip,arrow,1.5,NO);
    }
    double band=[scene[@"hazardBand"] doubleValue];
    if (band>.02) {
        NSColor *tint=AVHazardColour([scene[@"hazardAmber"] doubleValue]>.5?@"TCU":@"TS");
        [[tint colorWithAlphaComponent:.42*band] setFill];
        NSRect bandRect=NSMakeRect(NSMinX(cardRect)+8, NSMinY(rect)+22, MAX(0,NSWidth(cardRect)-16), 18);
        [[NSBezierPath bezierPathWithRoundedRect:bandRect xRadius:3 yRadius:3] fill];
        AVPaintTag(@"TS", NSMakeRect(NSMinX(bandRect)+3, NSMinY(bandRect)+1, 32, 16), AVHazardColour(@"TS"), NSColor.whiteColor);
    }
    if ([scene[@"vicinity"] doubleValue]>.02 && band<.2)
        AVPaintTag(@"VCTS", NSMakeRect(NSMaxX(rect)-70, NSMinY(rect)+20, 58, 16), AVHazardColour(@"TS"), NSColor.whiteColor);
    [NSGraphicsContext restoreGraphicsState];
    if (conditional>0) {
        [[NSColor.systemOrangeColor colorWithAlphaComponent:.3*conditional] setStroke]; card.lineWidth=1; [card stroke];
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
        NSString *hazard=FlyConvectiveHazard(p[@"weather"], p[@"cloudLayers"]);
        BOOL stormSpan=AVHazardSpan(p) && [hazard isEqual:@"TS"];
        if (stormSpan) {
            NSColor *tint=AVHazardColour([p[@"change"] hasPrefix:@"PROB"]?@"TCU":@"TS");
            NSRect span=NSMakeRect(a, y-5, MAX(2,b-a), 10);
            [[tint colorWithAlphaComponent:.85] setFill];
            [[NSBezierPath bezierPathWithRoundedRect:span xRadius:2 yRadius:2] fill];
            if (b-a>=36) AVPaintTag(@"TS", NSMakeRect(a+2, y-8, MIN(34, b-a-4), 14), tint, NSColor.whiteColor);
        } else AVLine(NSMakePoint(a,y+(AVConditional(p)?4:0)),NSMakePoint(b,y+(AVConditional(p)?4:0)),
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
    if (!self.panels) [self updateScenesAnimated:NO];
    CGFloat height=MAX(0,NSMinY(self.timelineRect)-6), present=0;
    CGContextRef context=NSGraphicsContext.currentContext.CGContext;
    [self refreshHazardTip];
    NSString *clamped=[self coverageNoteAtDate:self.displayDate];
    NSMutableArray *rects=[NSMutableArray array];
    if (clamped.length) CGContextSetAlpha(context, 0.4);
    for (NSDictionary *frame in [self panelFrames]) {
        NSRect card=[frame[@"card"] rectValue]; CGFloat alpha=[frame[@"alpha"] doubleValue];
        if ([frame[@"panel"][@"q1"] doubleValue]>0) [rects addObject:frame[@"card"]];
        present=MAX(present,alpha);
        if (alpha<=.001 || NSWidth(card)<.5 || !NSIntersectsRect(dirtyRect,card)) continue;
        // An opening or closing panel fades as one picture.
        if (alpha<1) { CGContextSaveGState(context); CGContextSetAlpha(context,alpha); CGContextBeginTransparencyLayerWithRect(context,card,NULL); }
        NSRect content=[frame[@"content"] rectValue];
        [self paintScene:[self sceneForSource:frame[@"panel"][@"source"] rect:content] rect:content card:card];
        if (alpha<1) { CGContextEndTransparencyLayer(context); CGContextRestoreGState(context); }
    }
    if (clamped.length) CGContextSetAlpha(context, 1);
    self.sceneRects=rects;
    if (present<1 && !clamped.length) {
        CGContextSaveGState(context); CGContextSetAlpha(context,1-present);
        NSString *empty=self.periods.count?@"No TAF period":(self.status.length?self.status:@"TAF unavailable");
        AVText(empty,NSMakeRect(12,MAX(0,height/2-10),NSWidth(self.bounds)-24,22),13,NSColor.secondaryLabelColor,NO,NSTextAlignmentCenter);
        CGContextRestoreGState(context);
    }
    if (NSIntersectsRect(dirtyRect,self.timelineRect)) [self drawTimeStrip]; [NSGraphicsContext restoreGraphicsState];
}
@end

@implementation AviationLensView {
    NSPopUpButton *_airport;
    NSTextField *_distance, *_cue, *_metar;
    NSButton *_nearest, *_notamButton, *_sigmetButton, *_source, *_atmosphere;
    NSTextField *_time;
    NSScrollView *_scroll;
    NSTextView *_bulletin;
    AviationForecastView *_forecast;
    SkySectionView *_sky;
    NSString *_nearestCode;
    BOOL _loading;
}

static NSUInteger AVNoticeCountUncached(NSDictionary *product, BOOL sigmet, NSString *airport, NSDate *date);

// Counts change only with the archive, the aerodrome or the minute; a Fly
// rebuild asks again for the same answer, and parsing every notice's dates
// each time cost ~100 ms on the main thread.
static NSUInteger AVNoticeCount(NSDictionary *product, BOOL sigmet, NSString *airport, NSDate *date) {
    if (![product isKindOfClass:NSDictionary.class]) return 0;
    static NSMapTable<NSDictionary *, NSMutableDictionary *> *cache;
    if (!cache) cache = [NSMapTable weakToStrongObjectsMapTable];
    NSString *key = [NSString stringWithFormat:@"%d|%@|%.0f", sigmet, airport.uppercaseString ?: @"",
        floor(date.timeIntervalSince1970 / 60.0)];
    NSMutableDictionary *answers = [cache objectForKey:product];
    NSNumber *hit = answers[key];
    if (hit) return hit.unsignedIntegerValue;
    NSUInteger count = AVNoticeCountUncached(product, sigmet, airport, date);
    if (!answers) { answers = [NSMutableDictionary dictionary]; [cache setObject:answers forKey:product]; }
    if (answers.count > 64) [answers removeAllObjects];
    answers[key] = @(count);
    return count;
}

static NSUInteger AVNoticeCountUncached(NSDictionary *product, BOOL sigmet, NSString *airport, NSDate *date) {
    if (![product isKindOfClass:NSDictionary.class]) return 0;
    id records=product[sigmet?@"features":@"notices"];
    if (![records isKindOfClass:NSArray.class]) return 0;
    NSDate *end=[date dateByAddingTimeInterval:24*3600]; NSUInteger count=0;
    for (NSDictionary *row in records) {
        if (![row isKindOfClass:NSDictionary.class] || ![row[@"raw"] isKindOfClass:NSString.class] || ![row[@"raw"] length]) continue;
        BOOL superseded=[row[@"superseded"] isKindOfClass:NSNumber.class] && [row[@"superseded"] boolValue];
        BOOL cancelled=[row[@"cancelled"] isKindOfClass:NSNumber.class] && [row[@"cancelled"] boolValue];
        BOOL estimated=[row[@"estimated"] isKindOfClass:NSNumber.class] && [row[@"estimated"] boolValue];
        if (superseded || cancelled ||
            ([row[@"kind"] isKindOfClass:NSString.class] && [row[@"kind"] hasSuffix:@"C"])) continue;
        NSDate *from=FlyDate(row[sigmet?@"valid_from":@"effective_from"]), *to=FlyDate(row[sigmet?@"valid_to":@"effective_to"]);
        if ((to && !estimated && [to compare:date]!=NSOrderedDescending) || (from && [from compare:end]!=NSOrderedAscending)) continue;
        NSMutableArray *locations=[NSMutableArray array];
        if ([row[@"locations"] isKindOfClass:NSArray.class])
            for (id location in row[@"locations"]) if ([location isKindOfClass:NSString.class] && [location length]) [locations addObject:[location uppercaseString]];
        if (!sigmet && airport.length && locations.count && ![locations containsObject:airport.uppercaseString]) continue;
        count++;
    }
    return count;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return YES; }
- (void)setHeaderTrailingInset:(CGFloat)inset {
    _headerTrailingInset=inset;
    self.needsLayout=YES;
}
- (void)drawRect:(NSRect)dirty {
    // AppKit can pass a dirty rect in this view's coordinates that covers the
    // whole popover when clipsToBounds is off. Filling that rect paints the map
    // and the lens bar with the window background.
    [NSColor.windowBackgroundColor setFill];
    NSRectFill(NSIntersectionRect(dirty, self.bounds));
}
- (void)resizeSubviewsWithOldSize:(NSSize)oldSize {
    [super resizeSubviewsWithOldSize:oldSize];
    if (_airport) [self layout];
}
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        self.clipsToBounds = YES;
        self.accessibilityIdentifier=@"popover.aviation";
        _airport=[[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
        _airport.bordered=NO; _airport.font=[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
        _airport.refusesFirstResponder=NO;
        _airport.target=self; _airport.action=@selector(chooseAirport:);
        _airport.accessibilityIdentifier=@"aviation.airport";
        [self addSubview:_airport];
        _distance=[NSTextField labelWithString:@""];
        _distance.translatesAutoresizingMaskIntoConstraints=YES;
        _distance.font=[NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        _distance.textColor=NSColor.secondaryLabelColor;
        _distance.accessibilityIdentifier=@"aviation.distance";
        _distance.accessibilityElement=NO;
        [self addSubview:_distance];
        _cue=[NSTextField labelWithString:@""];
        _cue.translatesAutoresizingMaskIntoConstraints=YES;
        _cue.font=[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
        _cue.textColor=NSColor.labelColor;
        _cue.accessibilityIdentifier=@"aviation.cue";
        [self addSubview:_cue];
        _nearest=[NSButton buttonWithTitle:@"" target:self action:@selector(showNearest:)];
        _nearest.bordered=NO; _nearest.font=[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
        _nearest.contentTintColor=NSColor.controlAccentColor;
        _nearest.refusesFirstResponder=NO;
        _nearest.accessibilityIdentifier=@"aviation.nearest";
        [self addSubview:_nearest];
        _notamButton=[NSButton buttonWithTitle:@"▣ NOTAM 0" target:self action:@selector(openNotices:)];
        _notamButton.tag=0; _notamButton.bordered=NO; _notamButton.font=[NSFont systemFontOfSize:11];
        _notamButton.refusesFirstResponder=NO;
        _notamButton.lineBreakMode=NSLineBreakByClipping;
        _notamButton.accessibilityLabel=@"NOTAMs";
        _notamButton.accessibilityIdentifier=@"aviation.notams"; [self addSubview:_notamButton];
        _sigmetButton=[NSButton buttonWithTitle:@"⚠ SIGMET 0" target:self action:@selector(openNotices:)];
        _sigmetButton.tag=1; _sigmetButton.bordered=NO; _sigmetButton.font=[NSFont systemFontOfSize:11];
        _sigmetButton.refusesFirstResponder=NO;
        _sigmetButton.lineBreakMode=NSLineBreakByClipping;
        _sigmetButton.accessibilityLabel=@"SIGMETs";
        _sigmetButton.accessibilityIdentifier=@"aviation.sigmets"; [self addSubview:_sigmetButton];
        _source=[NSButton buttonWithTitle:@"TAF / METAR  ›" target:self action:@selector(openSource:)];
        _source.bordered=NO; _source.font=[NSFont systemFontOfSize:11];
        _source.refusesFirstResponder=NO;
        _source.accessibilityIdentifier=@"aviation.source";
        _source.lineBreakMode=NSLineBreakByWordWrapping;
        _source.toolTip=@"TAF and METAR"; [self addSubview:_source];
        _atmosphere=[NSButton buttonWithTitle:@"Atmosphere ›" target:self action:@selector(openAtmosphere:)];
        _atmosphere.bordered=NO; _atmosphere.font=[NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        _atmosphere.refusesFirstResponder=NO;
        _atmosphere.accessibilityIdentifier=@"aviation.atmosphere.open";
        _atmosphere.toolTip=@"Cloud, moisture and temperature through height"; [self addSubview:_atmosphere];
        _metar=[NSTextField labelWithString:@"METAR unavailable"];
        _metar.translatesAutoresizingMaskIntoConstraints=YES;
        _metar.font=[NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        _metar.textColor=NSColor.labelColor;
        _metar.accessibilityIdentifier=@"aviation.metar";
        _metar.lineBreakMode=NSLineBreakByWordWrapping;
        _metar.maximumNumberOfLines=0;
        if ([_metar.cell isKindOfClass:NSTextFieldCell.class]) ((NSTextFieldCell *)_metar.cell).truncatesLastVisibleLine=NO;
        [self addSubview:_metar];
        _time=[NSTextField labelWithString:@""];
        _time.translatesAutoresizingMaskIntoConstraints=YES;
        _time.font=[NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        _time.textColor=NSColor.secondaryLabelColor;
        _time.accessibilityIdentifier=@"forecast.selectedTime"; [self addSubview:_time];
        _forecast=[[AviationForecastView alloc] initWithFrame:NSZeroRect];
        _forecast.accessibilityIdentifier=@"aviation.timeline";
        _forecast.showsTimeline=NO;
        _forecast.latitude=NAN; _forecast.longitude=NAN; [self addSubview:_forecast];
        if (SkySectionWebRoot().length) {
            _sky=[[SkySectionView alloc] initWithFrame:NSZeroRect];
            _sky.accessibilityIdentifier=@"aviation.sky";
            _sky.hidden=YES;
            [self addSubview:_sky];
        }
        _bulletin=[[NSTextView alloc] initWithFrame:NSZeroRect];
        _bulletin.editable=NO; _bulletin.selectable=YES; _bulletin.richText=YES;
        _bulletin.drawsBackground=YES; _bulletin.backgroundColor=NSColor.textBackgroundColor;
        _bulletin.font=[NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
        _bulletin.textContainerInset=NSMakeSize(8,6);
        _bulletin.textContainer.widthTracksTextView=YES;
        _bulletin.horizontallyResizable=NO; _bulletin.verticallyResizable=YES;
        _bulletin.autoresizingMask=NSViewWidthSizable;
        _bulletin.maxSize=NSMakeSize(CGFLOAT_MAX,CGFLOAT_MAX);
        _bulletin.accessibilityIdentifier=@"aviation.bulletin";
        _bulletin.accessibilityLabel=@"METAR and TAF";
        _scroll=[[NSScrollView alloc] initWithFrame:NSZeroRect];
        _scroll.drawsBackground=NO; _scroll.hasVerticalScroller=YES; _scroll.borderType=NSBezelBorder;
        _scroll.documentView=_bulletin; [self addSubview:_scroll];
    }
    return self;
}
- (AviationForecastView *)forecast { return _forecast; }
- (SkySectionView *)sky { return _sky; }
- (NSTextView *)bulletin { return _bulletin; }
- (NSTextField *)timeField { return _time; }
- (NSPopUpButton *)airportButton { return _airport; }
- (NSButton *)nearestButton { return _nearest; }
- (void)chooseAirport:(NSPopUpButton *)sender {
    if (_loading) return;
    NSString *code=sender.selectedItem.representedObject;
    if ([code isKindOfClass:NSString.class] && self.onChooseAerodrome) self.onChooseAerodrome(code);
}
- (void)showNearest:(id)sender { (void)sender; if (_nearestCode.length && self.onShowNearest) self.onShowNearest(_nearestCode); }
- (void)openNotices:(NSButton *)sender { if (self.onNotices) self.onNotices(sender.tag); }
- (void)openSource:(id)sender { if (self.onSource) self.onSource(sender); }
- (void)openAtmosphere:(id)sender { if (self.onAtmosphere) self.onAtmosphere(sender); }
- (void)setPlayhead:(NSDate *)date {
    if (_playhead==date || [_playhead isEqualToDate:date]) return;
    _playhead=date;
    _sky.time=date;
    if (_loading || !self.aerodrome) return;
    NSString *code=[self.aerodrome[@"code"] isKindOfClass:NSString.class]?[self.aerodrome[@"code"] uppercaseString]:@"";
    [self applyBulletin:AviationBulletin(self.aviation,code,_playhead,self.placeZone?:NSTimeZone.localTimeZone)];
    [self refreshInstruments];
}
- (void)reload {
    _loading=YES;
    NSString *code=[self.aerodrome[@"code"] isKindOfClass:NSString.class]?[self.aerodrome[@"code"] uppercaseString]:@"";
    NSString *title=FlyIdentityTitle(self.aerodrome);
    NSString *distance=FlyDistancePhrase(self.place,self.aerodrome);
    NSString *speech=FlyDistanceSpeech(self.place,self.aerodrome);
    NSString *row=FlyIdentityRow(self.place,self.aerodrome);
    [_airport removeAllItems];
    NSArray *fields=self.aerodromes.count?self.aerodromes:@[];
    if (!fields.count && code.length) fields=@[self.aerodrome];
    for (NSDictionary *field in fields) {
        if (![field isKindOfClass:NSDictionary.class]) continue;
        NSString *itemCode=[field[@"code"] isKindOfClass:NSString.class]?[field[@"code"] uppercaseString]:@"";
        if (!itemCode.length) continue;
        [_airport addItemWithTitle:[itemCode isEqual:code]?row:itemCode];
        _airport.lastItem.representedObject=itemCode;
        if ([itemCode isEqual:code]) [_airport selectItem:_airport.lastItem];
    }
    if (!_airport.selectedItem && _airport.numberOfItems) [_airport selectItemAtIndex:0];
    _airport.toolTip=distance.length?[NSString stringWithFormat:@"%@\n%@",title,distance]:title;
    _airport.accessibilityLabel=speech.length?[NSString stringWithFormat:@"%@, %@",title,speech]:title;
    _distance.stringValue=FlyDistanceCompact(self.place,self.aerodrome)?:@"";
    _distance.hidden=YES;
    NSDictionary *cue=FlyAerodromeCue(self.place,self.aerodrome,self.aerodromes);
    _cue.stringValue=@"";
    _cue.hidden=YES;
    _nearestCode=cue[@"code"];
    _nearest.title=cue[@"action"]?:@"";
    _nearest.hidden=!_nearest.title.length;
    _nearest.accessibilityLabel=_nearest.title;
    _airport.contentTintColor=_nearest.hidden?NSColor.labelColor:NSColor.systemOrangeColor;
    NSTimeZone *zone=self.placeZone?:NSTimeZone.localTimeZone;
    NSDate *clock=self.now?:self.playhead?:NSDate.date;
    NSDictionary *bulletin=AviationBulletin(self.aviation,code,self.playhead,zone);
    BOOL tafForeign=[bulletin[@"tafForeign"] boolValue];
    BOOL tafMatches=[bulletin[@"tafMatches"] boolValue];
    _source.hidden=tafForeign;
    _source.tag=tafForeign?1:0;
    NSTimeZone *fieldZone=[NSTimeZone timeZoneWithName:self.aerodrome[@"timeZone"]];
    _forecast.airportCode=code;
    _forecast.timeZone=fieldZone?:zone;
    _forecast.now=clock;
    id lat=self.aerodrome[@"latitude"], lon=self.aerodrome[@"longitude"];
    _forecast.latitude=[lat isKindOfClass:NSNumber.class]?[lat doubleValue]:NAN;
    _forecast.longitude=[lon isKindOfClass:NSNumber.class]?[lon doubleValue]:NAN;
    if (tafMatches) {
        NSDictionary *outlook=AviationOutlook(self.aviation,clock,_forecast.timeZone);
        _forecast.periods=outlook[@"periods"]?:@[];
        _forecast.status=nil;
    } else if (tafForeign) {
        _forecast.periods=@[];
        _forecast.status=bulletin[@"taf"];
    } else {
        NSDictionary *outlook=AviationOutlook(self.aviation,clock,_forecast.timeZone);
        _forecast.periods=outlook[@"periods"]?:@[];
        _forecast.status=nil;
    }
    [_sky setAviation:self.aviation upper:self.upper aerodrome:self.aerodrome now:clock];
    _sky.time=self.playhead?:clock;
    [self applyBulletin:bulletin];
    [self refreshInstruments];
    NSUInteger notamCount=AVNoticeCount(self.notams,NO,code,clock), sigmetCount=AVNoticeCount(self.sigmets,YES,code,clock);
    _notamButton.title=[self.notams[@"notices"] isKindOfClass:NSArray.class]?[NSString stringWithFormat:@"▣ %lu",(unsigned long)notamCount]:@"▣ —";
    _sigmetButton.title=[self.sigmets[@"features"] isKindOfClass:NSArray.class]?[NSString stringWithFormat:@"⚠ %lu",(unsigned long)sigmetCount]:@"⚠ —";
    _notamButton.toolTip=[NSString stringWithFormat:@"NOTAMs · %@ · %@ · next 24 h; downloaded notices with unknown validity remain included",code,[_notamButton.title substringFromIndex:2]];
    _sigmetButton.toolTip=[NSString stringWithFormat:@"SIGMETs · Australia · %@ · next 24 h; downloaded notices with unknown validity remain included",[_sigmetButton.title substringFromIndex:2]];
    _notamButton.accessibilityLabel=_notamButton.toolTip;
    _sigmetButton.accessibilityLabel=_sigmetButton.toolTip;
    _loading=NO;
    self.needsLayout=YES;
}
- (void)paintMetar:(NSDictionary *)instrument {
    NSFont *mono=[NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium];
    NSColor *ink=NSColor.labelColor, *quiet=NSColor.secondaryLabelColor;
    NSDictionary *base=@{NSFontAttributeName:mono, NSForegroundColorAttributeName:ink};
    NSMutableAttributedString *line=[NSMutableAttributedString new];
    void (^add)(NSString *, NSColor *)=^(NSString *text, NSColor *color) {
        if (!text.length) return;
        NSMutableDictionary *attrs=[base mutableCopy];
        if (color) attrs[NSForegroundColorAttributeName]=color;
        [line appendAttributedString:[[NSAttributedString alloc] initWithString:text attributes:attrs]];
    };
    NSString *hazard=instrument[@"hazard"]?:@"";
    NSString *cloud=instrument[@"cloud"]?:@"—";
    NSColor *hot=hazard.length?AVHazardColour(hazard):nil;
    BOOL named=[cloud hasPrefix:@"CB "] || [cloud hasPrefix:@"TCU "];
    // Fixed instrument columns: cloud, visibility and wind each carry a
    // compact glyph so their values remain unambiguous at a glance.
    add(@"☁ ", nil);
    if ([hazard isEqual:@"TS"] || [hazard isEqual:@"VCTS"]) {
        add(hazard, hot);
        add(@"  ", nil);
    }
    if (hot && named) {
        NSRange sep=[cloud rangeOfString:@" · "];
        if (sep.location==NSNotFound) add(cloud, hot);
        else {
            add([cloud substringToIndex:sep.location], hot);
            add([cloud substringFromIndex:sep.location], nil);
        }
    } else add(cloud, nil);
    add(@"   ", nil);
    add(@"👁︎ ", nil);
    add(instrument[@"vis"]?:@"—", nil);
    add(@"   ", nil);
    add(@"➝ ", nil);
    add(instrument[@"wind"]?:@"—", nil);
    add(@" kt", nil);
    add(@"   ·   ", quiet);
    add(instrument[@"clock"]?:@"—", nil);
    add(@"   ·   ", quiet);
    BOOL aged=[instrument[@"aged"] boolValue];
    if (aged) add(@"▲ ", NSColor.systemOrangeColor);
    NSString *age=instrument[@"age"]?:@"—";
    age=[age stringByReplacingOccurrencesOfString:@" m" withString:@" min"];
    add(age, aged?NSColor.systemOrangeColor:nil);
    _metar.attributedStringValue=line;
    _metar.toolTip=instrument[@"tip"]?:@"";
}
- (void)paintValidity:(NSString *)row endTinted:(BOOL)tinted {
    NSFont *font=[NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium];
    NSMutableAttributedString *title=[[NSMutableAttributedString alloc] initWithString:row?:@"TAF" attributes:@{
        NSFontAttributeName:font, NSForegroundColorAttributeName:NSColor.labelColor}];
    if (tinted) {
        NSRange mark=[title.string rangeOfString:@" → "];
        if (mark.location!=NSNotFound) {
            NSRange end=NSMakeRange(NSMaxRange(mark), title.length-NSMaxRange(mark));
            [title addAttribute:NSForegroundColorAttributeName value:NSColor.systemOrangeColor range:end];
        }
    }
    _source.attributedTitle=title;
}
- (void)refreshInstruments {
    NSString *code=[self.aerodrome[@"code"] isKindOfClass:NSString.class]?[self.aerodrome[@"code"] uppercaseString]:@"";
    NSTimeZone *zone=self.placeZone?:NSTimeZone.localTimeZone;
    NSDate *at=self.playhead?:self.now?:NSDate.date;
    NSDictionary *metar=[self.aviation[@"metar"] isKindOfClass:NSDictionary.class]?self.aviation[@"metar"]:@{};
    NSDictionary *taf=[self.aviation[@"taf"] isKindOfClass:NSDictionary.class]?self.aviation[@"taf"]:@{};
    NSDictionary *bulletin=AviationBulletin(self.aviation, code, at, zone);
    NSDate *obs=FlyDate(metar[@"time"]);
    // Age is wall-clock time since the observation. The playhead only chooses
    // which TAF group is in force.
    if ([bulletin[@"metarMatches"] boolValue])
        [self paintMetar:FlyMetarInstrument(metar[@"raw"], obs, self.now ?: NSDate.date, zone)];
    else {
        _metar.stringValue=bulletin[@"metar"]?:@"METAR unavailable";
        _metar.toolTip=_metar.stringValue;
    }
    if (_source.hidden) return;
    NSDate *from=FlyDate(taf[@"valid_from"]);
    NSDate *to=FlyDate(taf[@"valid_to"]);
    BOOL outside=(to && [at compare:to]!=NSOrderedAscending) || (from && [at compare:from]==NSOrderedAscending);
    [self paintValidity:FlyValidityRow(from, to, zone) endTinted:outside];
    NSString *utc=FlyValidityUTC(from, to);
    NSString *note=[_forecast coverageNoteAtDate:at];
    _source.toolTip=note.length?[NSString stringWithFormat:@"%@\n%@", utc, note]:utc;
    (void)code;
}
- (void)applyBulletin:(NSDictionary *)bulletin {
    NSFont *mono=[NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    NSFont *monoBold=[NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightSemibold];
    NSColor *ink=NSColor.labelColor;
    NSColor *wash=[[NSColor controlAccentColor] colorWithAlphaComponent:0.22];
    NSMutableParagraphStyle *style=[NSMutableParagraphStyle new];
    style.lineBreakMode=NSLineBreakByWordWrapping;
    NSMutableAttributedString *text=[NSMutableAttributedString new];
    void (^add)(NSString *, NSFont *, NSColor *, NSColor *)=^(NSString *line, NSFont *font, NSColor *color, NSColor *background) {
        if (!line.length) return;
        NSMutableDictionary *attrs=[@{NSFontAttributeName:font, NSForegroundColorAttributeName:color, NSParagraphStyleAttributeName:style} mutableCopy];
        if (background) attrs[NSBackgroundColorAttributeName]=background;
        if (text.length) [text appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n" attributes:@{NSFontAttributeName:font}]];
        [text appendAttributedString:[[NSAttributedString alloc] initWithString:line attributes:attrs]];
    };
    add(bulletin[@"metar"]?:@"METAR unavailable", mono, ink, nil);
    add(@"", mono, ink, nil);
    NSArray *lines=bulletin[@"lines"];
    if (![lines count]) add(bulletin[@"taf"]?:@"No TAF issued", mono, ink, nil);
    for (NSDictionary *line in lines) add(line[@"text"], [line[@"active"] boolValue]?monoBold:mono, ink, [line[@"active"] boolValue]?wash:nil);
    [_bulletin.textStorage setAttributedString:text];
    _bulletin.accessibilityValue=text.string;
}
- (void)layout {
    [super layout];
    CGFloat width=NSWidth(self.bounds), height=NSHeight(self.bounds), y=0;
    BOOL compactWide=width>=800;
    CGFloat contentWidth=compactWide?floor(width*.60):width;
    BOOL tall=height>=320;
    _distance.hidden=YES; _cue.hidden=YES; _time.hidden=YES;
    _airport.font=[NSFont monospacedDigitSystemFontOfSize:tall?15:13 weight:NSFontWeightSemibold];
    CGFloat identity=22;
    CGFloat nearestW=_nearest.hidden?0:MIN(120, MAX(88, width*0.34));
    _airport.frame=NSMakeRect(0,y,MAX(0,contentWidth-nearestW-4-self.headerTrailingInset),identity);
    if (!_nearest.hidden) _nearest.frame=NSMakeRect(contentWidth-nearestW-self.headerTrailingInset,y,nearestW,identity);
    y+=identity;
    _notamButton.hidden=_sigmetButton.hidden=_atmosphere.hidden=NO;
    CGFloat notamW=ceil([_notamButton.title sizeWithAttributes:@{NSFontAttributeName:_notamButton.font}].width)+8;
    CGFloat sigmetW=ceil([_sigmetButton.title sizeWithAttributes:@{NSFontAttributeName:_sigmetButton.font}].width)+8;
    CGFloat gap=8;
    _notamButton.frame=NSMakeRect(0,y,notamW,20);
    _sigmetButton.frame=NSMakeRect(notamW+gap,y,sigmetW,20);
    CGFloat atmosphereX=notamW+gap+sigmetW+gap;
    _atmosphere.frame=NSMakeRect(atmosphereX,y,MAX(0,contentWidth-atmosphereX),20);
    y+=20;
    // The compact expanded card still keeps the instrument stack: identity,
    // hazard links, METAR, TAF and sky. Raw issued text can yield the remaining
    // space to the scroll view instead of hiding the live instruments.
    BOOL showMetar=height-y>70;
    _metar.hidden=!showMetar;
    _source.hidden=_source.tag==1 || !showMetar;
    if (showMetar) {
        CGFloat metarH=20;
        if (_metar.attributedStringValue.length) {
            NSRect need=[_metar.attributedStringValue boundingRectWithSize:NSMakeSize(MAX(1,contentWidth), 80)
                options:NSStringDrawingUsesLineFragmentOrigin|NSStringDrawingUsesFontLeading];
            metarH=MIN(52, MAX(20, ceil(need.size.height)+2));
        }
        _metar.frame=NSMakeRect(0,y,contentWidth,metarH);
        y+=metarH;
        if (!_source.hidden) { _source.frame=NSMakeRect(0,y,contentWidth,20); y+=20; }
    }
    CGFloat remain=MAX(0,height-y);
    // A short overlay cannot hold the cloud scene without stacking its labels.
    // The issued text takes that space; the side panel still draws the graphic.
    // The sky section holds its labels down to phone widths; the older
    // forecast graphic needs 360 pt.
    BOOL showGraphic=contentWidth>=(_sky?240:360) && height>=180;
    _forecast.hidden=!showGraphic || _sky!=nil;
    _sky.hidden=!showGraphic;
    if (showGraphic) {
        // The sky section needs about 140 pt for its height labels not to touch.
        CGFloat least=_sky?140:110;
        CGFloat textFloor=tall?88:56, graphicFloor=_sky?least:96;
        CGFloat textH=MIN(tall?200:120, MAX(textFloor, remain-graphicFloor));
        if (textH>remain-40) textH=MAX(36,remain*0.46);
        CGFloat graphicH=compactWide?MAX(least,remain-4):MAX(least,remain-textH-4);
        _forecast.frame=NSMakeRect(0,y,contentWidth,graphicH);
        _sky.frame=_forecast.frame; y+=graphicH+4;
    }
    NSRect scrollFrame=compactWide?NSMakeRect(contentWidth+8,0,MAX(1,width-contentWidth-8),height):NSMakeRect(0,y,width,MAX(0,height-y));
    _scroll.frame=scrollFrame;
    CGFloat textWidth=MAX(1,NSWidth(_scroll.contentView.bounds));
    [_bulletin.textContainer setContainerSize:NSMakeSize(textWidth-_bulletin.textContainerInset.width*2,CGFLOAT_MAX)];
    [_bulletin.layoutManager ensureLayoutForTextContainer:_bulletin.textContainer];
    CGFloat used=[_bulletin.layoutManager usedRectForTextContainer:_bulletin.textContainer].size.height;
    _bulletin.frame=NSMakeRect(0,0,textWidth,MAX(12,used+12));
}
- (CGFloat)fittingHeightForWidth:(CGFloat)width {
    width=MAX(1,width);
    NSFont *font=[NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    CGFloat contentWidth=width>=800?floor(width*.60):width;
    CGFloat textWidth=MAX(1,(width>=800?width-contentWidth-8:width)-16);
    [self.bulletin.textContainer setContainerSize:NSMakeSize(textWidth,CGFLOAT_MAX)];
    [self.bulletin.layoutManager ensureLayoutForTextContainer:self.bulletin.textContainer];
    NSRect used=[self.bulletin.layoutManager usedRectForTextContainer:self.bulletin.textContainer];
    if (used.size.height<=0 && self.bulletin.string.length) {
        used=[self.bulletin.string boundingRectWithSize:NSMakeSize(textWidth,CGFLOAT_MAX)
            options:NSStringDrawingUsesLineFragmentOrigin|NSStringDrawingUsesFontLeading attributes:@{NSFontAttributeName:font}];
    }
    CGFloat metarHeight=20;
    if (_metar.attributedStringValue.length) {
        NSRect need=[_metar.attributedStringValue boundingRectWithSize:NSMakeSize(MAX(1,contentWidth),80)
            options:NSStringDrawingUsesLineFragmentOrigin|NSStringDrawingUsesFontLeading];
        metarHeight=MAX(20,ceil(need.size.height)+2);
    }
    CGFloat bulletinHeight=MAX(12,ceil(used.size.height)+12);
    CGFloat instrumentHeight=22+20+metarHeight+20+(_sky?140:110)+4;
    if (width>=800) return MAX(instrumentHeight,MIN(280,bulletinHeight));
    return instrumentHeight+bulletinHeight;
}
@end
