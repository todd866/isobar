#import "daystrip.h"
#import "pure.h"

static id Finite(id value) { return [value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]) ? value : nil; }
static NSString *TempText(id value) { NSNumber *n=Finite(value); return n ? [NSString stringWithFormat:@"%.0f°",round(n.doubleValue)] : @"—"; }
static void AnnouncePolite(NSView *view, NSString *text) {
    if (!text.length || !view.window) return;
    NSAccessibilityPostNotificationWithUserInfo(view, NSAccessibilityAnnouncementRequestedNotification,
        @{NSAccessibilityAnnouncementKey:text, NSAccessibilityPriorityKey:@(NSAccessibilityPriorityLow)});
}
double DayStripTemperatureAtDate(NSArray<NSDictionary *> *series, NSDate *date) {
    if (![date isKindOfClass:NSDate.class] || ![series isKindOfClass:NSArray.class]) return NAN;
    NSDate *before=nil,*after=nil; double a=NAN,b=NAN;
    for (NSDictionary *row in series) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSDate *time=[row[@"time"] isKindOfClass:NSDate.class]?row[@"time"]:nil; NSNumber *temp=Finite(row[@"temp"]);
        if (!time || !temp) continue;
        if ([time compare:date]==NSOrderedSame) return temp.doubleValue;
        if ([time compare:date]==NSOrderedAscending) { if (!before || [time compare:before]==NSOrderedDescending) { before=time; a=temp.doubleValue; } }
        else if (!after || [time compare:after]==NSOrderedAscending) { after=time; b=temp.doubleValue; }
    }
    if (!before || !after) return NAN; double span=[after timeIntervalSinceDate:before];
    return span>0 ? a+(b-a)*([date timeIntervalSinceDate:before]/span) : b;
}
NSDictionary *DayStripSampleAtDate(NSArray<NSDictionary *> *series, NSDate *date, NSTimeInterval limit) {
    if (![date isKindOfClass:NSDate.class] || ![series isKindOfClass:NSArray.class] || !(limit>0)) return nil;
    NSDictionary *best=nil; NSTimeInterval gap=limit;
    for (NSDictionary *row in series) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSDate *time=[row[@"time"] isKindOfClass:NSDate.class]?row[@"time"]:nil; if (!time) continue;
        NSTimeInterval d=fabs([time timeIntervalSinceDate:date]);
        if (d<gap || (best && d==gap && [time compare:best[@"time"]]==NSOrderedAscending)) { gap=d; best=row; }
    }
    return best;
}
@interface DayStripView () { NSTimer *_hoverArmTimer; double _hoverPendingFraction; NSInteger _hoverPendingIndex; NSInteger _highlightedDayIndex; double _playheadTemperature; NSInteger _hoverIndex; BOOL _dragging; NSCalendar *_calendar; } @end
@interface DayDayElement : NSView
@property(nonatomic,copy) NSString *dayAccessibilityLabel;
@property(nonatomic,copy) NSString *dayAccessibilityIdentifier;
@property(nonatomic,copy) void (^onPress)(void);
@end
@implementation DayDayElement
- (BOOL)isFlipped { return YES; }
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityButtonRole; }
- (NSString *)accessibilityLabel { return _dayAccessibilityLabel ?: @""; }
- (NSString *)accessibilityIdentifier { return _dayAccessibilityIdentifier ?: @""; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (BOOL)accessibilityPerformPress { if (!self.onPress) return NO; self.onPress(); return YES; }
@end
@implementation DayStripView
- (instancetype)initWithFrame:(NSRect)frame { self=[super initWithFrame:frame]; if (!self) return nil; _selectedIndex=-1; _highlightedDayIndex=-1; _hoverIndex=-1; _hoverPendingIndex=-1; _hoverPendingFraction=NAN; _playheadTemperature=NAN; self.accessibilityIdentifier=@"hub.days"; self.accessibilityLabel=@"Seven day forecast timeline"; return self; }
- (BOOL)isFlipped { return YES; } - (BOOL)acceptsFirstResponder { return YES; }
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; self.needsDisplay=YES; }
- (void)removeFromSuperview { [_hoverArmTimer invalidate]; _hoverArmTimer=nil; [super removeFromSuperview]; }
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; if (!self.window) { [_hoverArmTimer invalidate]; _hoverArmTimer=nil; _hoverIndex=-1; } }
- (NSInteger)highlightedDayIndex { return _highlightedDayIndex; } - (double)playheadTemperature { return _playheadTemperature; } - (NSInteger)hoverIndex { return _hoverIndex; }
- (NSCalendar *)dayCalendar { if (!_calendar) { _calendar=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; _calendar.timeZone=self.timeZone?:NSTimeZone.localTimeZone; } return _calendar; }
- (void)setTimeZone:(NSTimeZone *)zone { _timeZone=zone; _calendar=nil; [self setNeedsDisplay:YES]; }
- (void)setDays:(NSArray<NSDictionary *> *)days {
    _days=[days copy]?:@[];
    for (NSView *view in [self.subviews copy]) if ([view isKindOfClass:DayDayElement.class]) [view removeFromSuperview];
    CGFloat width = NSWidth(self.bounds) / MAX(1, _days.count);
    for (NSUInteger i=0; i<_days.count; i++) {
        DayDayElement *element=[DayDayElement new];
        element.dayAccessibilityIdentifier=[NSString stringWithFormat:@"hub.day.%lu",(unsigned long)i];
        element.dayAccessibilityLabel=[self accessibilityLabelForDay:(NSInteger)i];
        element.frame=NSMakeRect(i*width,0,width,NSHeight(self.bounds));
        __weak DayStripView *weak=self;
        element.onPress=^{
            DayStripView *strip=weak;
            if (!strip) return;
            [strip emitFraction:[strip fractionAtPoint:NSMakePoint((i+.5)*NSWidth(strip.bounds)/MAX(1,strip.days.count),0)] preview:NO];
        };
        [self addSubview:element];
    }
    [self setNeedsDisplay:YES]; [self updatePlayheadState];
}
- (void)setSeries:(NSArray<NSDictionary *> *)series { _series=[series copy]?:@[]; [self updatePlayheadState]; }
- (void)setHours:(NSArray<NSDictionary *> *)hours { _hours=[hours copy]; [self setNeedsDisplay:YES]; }
- (void)setPlayhead:(NSDate *)playhead { if ([_playhead isEqualToDate:playhead]) return; _playhead=playhead; [self updatePlayheadState]; }
- (void)setSelectedIndex:(NSInteger)index { _selectedIndex=index; [self setNeedsDisplay:YES]; }
- (void)setTimelineStart:(NSDate *)date { _timelineStart=date; [self setNeedsDisplay:YES]; } - (void)setTimelineEnd:(NSDate *)date { _timelineEnd=date; [self setNeedsDisplay:YES]; }
- (NSInteger)dayIndexForDate:(NSDate *)date { if (![date isKindOfClass:NSDate.class]) return -1; for (NSInteger i=0;i<(NSInteger)self.days.count;i++) { NSDate *d=[self.days[i][@"date"] isKindOfClass:NSDate.class]?self.days[i][@"date"]:nil; if (d&&[self.dayCalendar isDate:date inSameDayAsDate:d]) return i; } return -1; }
- (void)updatePlayheadState { _highlightedDayIndex=[self dayIndexForDate:self.playhead]; _playheadTemperature=DayStripTemperatureAtDate(self.series,self.playhead); [self setNeedsDisplay:YES]; }
- (NSString *)accessibilityLabelForDay:(NSInteger)index { if (index<0||index>=(NSInteger)self.days.count) return @""; NSDictionary *day=self.days[index]; NSNumber *code=Finite(day[@"weatherCode"]); NSString *sky=code?(WeatherCodeLabel(code.integerValue)?:@"Forecast"):@"Forecast"; NSMutableString *s=[NSMutableString stringWithFormat:@"%@, %@",day[@"weekday"]?:@"Day",sky]; if (Finite(day[@"max"])) [s appendFormat:@", maximum %.0f degrees",[day[@"max"] doubleValue]]; if (Finite(day[@"min"])) [s appendFormat:@", minimum %.0f degrees",[day[@"min"] doubleValue]]; NSNumber *rain=Finite(day[@"rainMm"]); if (rain&&rain.doubleValue>0) [s appendFormat:@", %.1f millimetres of rain",rain.doubleValue]; return s; }
// Equal day segments keep all seven labels readable. Each segment maps its
// local midnight-to-midnight interval onto the model's actual time horizon.
- (double)fractionAtPoint:(NSPoint)point {
    double u=MIN(1,MAX(0,point.x/MAX(1,NSWidth(self.bounds))));
    if (!self.days.count || !self.timelineStart || !self.timelineEnd) return u;
    NSInteger index=MIN((NSInteger)self.days.count-1,(NSInteger)floor(u*self.days.count));
    NSDate *start=self.days[index][@"date"];
    if (![start isKindOfClass:NSDate.class]) return u;
    NSDate *end=[self.dayCalendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:start options:0];
    NSDate *date=[start dateByAddingTimeInterval:(u*self.days.count-index)*[end timeIntervalSinceDate:start]];
    double span=[self.timelineEnd timeIntervalSinceDate:self.timelineStart];
    return span>0?MIN(1,MAX(0,[date timeIntervalSinceDate:self.timelineStart]/span)):u;
}
- (double)positionForDate:(NSDate *)date {
    if (!date || !self.days.count) return NAN;
    NSInteger index=[self dayIndexForDate:date];
    if (index<0) return [date compare:self.days.firstObject[@"date"]]==NSOrderedAscending?0:1;
    NSDate *start=self.days[index][@"date"];
    NSDate *end=[self.dayCalendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:start options:0];
    return (index+[date timeIntervalSinceDate:start]/[end timeIntervalSinceDate:start])/self.days.count;
}
- (NSInteger)indexAtFraction:(double)fraction {
    if (!self.days.count) return -1;
    if (self.timelineStart && self.timelineEnd) {
        double span=[self.timelineEnd timeIntervalSinceDate:self.timelineStart];
        if (span>0) return [self dayIndexForDate:[self.timelineStart dateByAddingTimeInterval:fraction*span]];
    }
    return MIN((NSInteger)self.days.count-1,MAX(0,(NSInteger)floor(fraction*self.days.count)));
}
- (void)layout {
    [super layout];
    CGFloat width=NSWidth(self.bounds)/MAX(1,self.days.count);
    for (NSUInteger i=0;i<self.subviews.count;i++) {
        NSView *view=self.subviews[i];
        view.frame=NSMakeRect(i*width,0,width,NSHeight(self.bounds));
        view.toolTip=[self accessibilityLabelForDay:(NSInteger)i];
    }
}
- (void)emitFraction:(double)f preview:(BOOL)preview {
    NSInteger i=[self indexAtFraction:f];
    if (preview) {
        if (self.onPreviewFraction) self.onPreviewFraction(f); else if (self.onHover) self.onHover(i);
    } else {
        self.selectedIndex=i;
        if (self.onSelectFraction) self.onSelectFraction(f); else if (self.onSelect) self.onSelect(i);
    }
}
- (void)armHoverAtFraction:(double)f {
    _hoverPendingFraction=f; _hoverPendingIndex=[self indexAtFraction:f];
    if (_hoverPendingIndex<0) return;
    if (_hoverArmTimer) return;
    __weak DayStripView *weakSelf=self;
    _hoverArmTimer=[NSTimer timerWithTimeInterval:.3 repeats:NO block:^(NSTimer *timer) {
        DayStripView *s=weakSelf; if (!s||s->_hoverArmTimer!=timer) return; s->_hoverArmTimer=nil; s->_hoverIndex=s->_hoverPendingIndex;
        [s emitFraction:s->_hoverPendingFraction preview:YES]; AnnouncePolite(s,[s accessibilityLabelForDay:s->_hoverIndex]);
    }];
    [[NSRunLoop mainRunLoop] addTimer:_hoverArmTimer forMode:NSRunLoopCommonModes];
}
- (void)mouseMoved:(NSEvent *)event {
    double fraction=[self fractionAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
    if (_hoverIndex>=0) {
        _hoverIndex=[self indexAtFraction:fraction];
        [self emitFraction:fraction preview:YES];
    } else [self armHoverAtFraction:fraction];
}
- (void)mouseEntered:(NSEvent *)event { [self mouseMoved:event]; }
- (void)mouseExited:(NSEvent *)event {
    (void)event;
    if (_dragging) return;
    [_hoverArmTimer invalidate]; _hoverArmTimer=nil; _hoverPendingIndex=-1;
    BOOL previewed=_hoverIndex>=0; _hoverIndex=-1;
    if (previewed) {
        if (self.onPreviewFraction) self.onPreviewFraction(NAN);
        else if (self.onHover) self.onHover(-1);
    }
}
- (void)mouseDown:(NSEvent *)event {
    [_hoverArmTimer invalidate]; _hoverArmTimer=nil;
    [self.window makeFirstResponder:self];
    _dragging=YES;
    double fraction=[self fractionAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
    // Preview holds the shared clock during the drag and remembers playback.
    if (self.onPreviewFraction) {
        _hoverIndex=[self indexAtFraction:fraction];
        [self emitFraction:fraction preview:YES];
    } else [self emitFraction:fraction preview:NO];
}
- (void)mouseDragged:(NSEvent *)event {
    if (_dragging) [self emitFraction:[self fractionAtPoint:[self convertPoint:event.locationInWindow fromView:nil]] preview:self.onPreviewFraction!=nil];
}
- (void)mouseUp:(NSEvent *)event {
    if (!_dragging) return;
    double fraction=[self fractionAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
    [self emitFraction:fraction preview:self.onPreviewFraction!=nil];
    _dragging=NO; _hoverIndex=-1;
    if (self.onPreviewFraction) self.onPreviewFraction(NAN);
}
- (void)keyDown:(NSEvent *)event {
    NSInteger next=self.selectedIndex<0?MAX(0,self.highlightedDayIndex):self.selectedIndex;
    if (event.keyCode==123) next=MAX(0,next-1);
    else if (event.keyCode==124) next=MIN((NSInteger)self.days.count-1,next+1);
    else if (event.keyCode!=36) { [super keyDown:event]; return; }
    if (next<0 || next>=(NSInteger)self.days.count) return;
    self.selectedIndex=next;
    [self emitFraction:[self fractionAtPoint:NSMakePoint((next+.5)*NSWidth(self.bounds)/self.days.count,0)] preview:NO];
}
- (void)updateTrackingAreas { [super updateTrackingAreas]; for (NSTrackingArea *a in self.trackingAreas) [self removeTrackingArea:a]; [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveAlways|NSTrackingInVisibleRect owner:self userInfo:nil]]; }
// Select one detail level for the whole strip, measured with the drawing font.
- (NSArray<NSDictionary *> *)displayRows {
    CGFloat cellW=NSWidth(self.bounds)/MAX(1,self.days.count);
    NSFont *font=[NSFont monospacedDigitSystemFontOfSize:cellW<92?10:11 weight:NSFontWeightMedium];
    NSDictionary *style=@{NSFontAttributeName:font};
    NSDateFormatter *format=[NSDateFormatter new];
    format.locale=[[NSLocale alloc] initWithLocaleIdentifier:@"en_AU_POSIX"];
    format.timeZone=self.timeZone?:NSTimeZone.localTimeZone; format.dateFormat=@"EEE";
    NSMutableArray *rows=[NSMutableArray array];
    for (NSUInteger level=0;level<4;level++) {
        [rows removeAllObjects]; BOOL fits=YES;
        for (NSDictionary *day in self.days) {
            NSString *weekday=[day[@"date"] isKindOfClass:NSDate.class]?[format stringFromDate:day[@"date"]]:@"—";
            NSString *temps=[NSString stringWithFormat:@"%@/%@",TempText(day[@"max"]),TempText(day[@"min"])];
            if (level==3) temps=[temps stringByReplacingOccurrencesOfString:@"°" withString:@""];
            NSNumber *rain=Finite(day[@"rainMm"]);
            NSString *rainText=level==0 && rain.doubleValue>0?(rain.doubleValue<.1?@"<.1":[NSString stringWithFormat:@"%.1f",rain.doubleValue]):@"";
            BOOL icon=level<2 && Finite(day[@"weatherCode"])!=nil;
            CGFloat width=3+[weekday sizeWithAttributes:style].width+2+[temps sizeWithAttributes:style].width;
            if (icon) width+=16;
            if (rainText.length) width+=2+[rainText sizeWithAttributes:style].width;
            if (width>cellW) fits=NO;
            [rows addObject:@{@"weekday":weekday,@"temps":temps,@"rain":rainText,@"icon":@(icon),@"width":@(width),@"level":@(level)}];
        }
        if (fits) break;
    }
    return rows;
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty; CGFloat w=NSWidth(self.bounds),h=NSHeight(self.bounds); NSUInteger count=self.days.count; if (!(w>0&&h>0&&count)) return; CGFloat trackY=h-5,cellW=w/count;
    [[NSColor.separatorColor colorWithAlphaComponent:.55] setStroke]; NSBezierPath *track=[NSBezierPath bezierPath]; [track moveToPoint:NSMakePoint(self.timelineStart?[self positionForDate:self.timelineStart]*w:0,trackY)]; [track lineToPoint:NSMakePoint(self.timelineEnd?[self positionForDate:self.timelineEnd]*w:w,trackY)]; track.lineWidth=1; [track stroke];
    NSFont *temp=[NSFont monospacedDigitSystemFontOfSize:cellW<92?10:11 weight:NSFontWeightMedium];
    NSArray *rows=[self displayRows];
    for (NSUInteger i=0;i<count;i++) {
        NSDictionary *day=self.days[i], *row=rows[i];
        NSRect cell=NSMakeRect(i*cellW,0,cellW,h);
        if ([day[@"weekday"] isEqual:@"Today"] || (NSInteger)i==_highlightedDayIndex) {
            [[NSColor.controlAccentColor colorWithAlphaComponent:.13] setFill];
            [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(cell,2,1) xRadius:4 yRadius:4] fill];
        }
        NSString *weekday=row[@"weekday"], *temps=row[@"temps"], *rainText=row[@"rain"];
        NSDictionary *style=@{NSFontAttributeName:temp,NSForegroundColorAttributeName:NSColor.labelColor};
        CGFloat x=NSMinX(cell)+1.5;
        [weekday drawAtPoint:NSMakePoint(x,9) withAttributes:style]; x+=[weekday sizeWithAttributes:style].width+2;
        NSNumber *code=Finite(day[@"weatherCode"]);
        if ([row[@"icon"] boolValue] && code) {
            NSImage *image=[NSImage imageWithSystemSymbolName:WeatherCodeSymbol(code.integerValue,YES) accessibilityDescription:nil];
            image=[image imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithHierarchicalColor:NSColor.labelColor]];
            [image drawInRect:NSMakeRect(x,8,14,14)]; x+=16;
        }
        [temps drawAtPoint:NSMakePoint(x,9) withAttributes:style]; x+=[temps sizeWithAttributes:style].width+2;
        if (rainText.length) [rainText drawAtPoint:NSMakePoint(x,9) withAttributes:@{NSFontAttributeName:temp,NSForegroundColorAttributeName:NSColor.systemBlueColor}];

    }
    if (self.playhead&&self.timelineStart&&self.timelineEnd) { double f=[self positionForDate:self.playhead]; if (isfinite(f)) { f=MIN(1,MAX(0,f)); CGFloat x=f*w; [NSColor.controlAccentColor setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x-4,trackY-4,8,8)] fill]; } }
}
@end
