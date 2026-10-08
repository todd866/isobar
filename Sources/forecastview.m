#import "forecastview.h"
#import "playheadcursor.h"
#import "pure.h"

static CGFloat clampf(CGFloat x, CGFloat lo, CGFloat hi) {
    return MIN(hi, MAX(lo, x));
}

NSBezierPath *KiteWindArrowPath(NSPoint centre, double from, CGFloat length) {
    if (!isfinite(from) || !isfinite(length) || length <= 0 ||
        !isfinite(centre.x) || !isfinite(centre.y)) return nil;
    double angle = WindToDegrees(from) * M_PI / 180.0;
    NSPoint direction = NSMakePoint(sin(angle), -cos(angle));
    NSPoint across = NSMakePoint(-direction.y, direction.x);
    // Equal reach ahead/behind keeps the centre on the actual speed reading.
    CGFloat xy[][2] = {{.5,0}, {.04,.26}, {.04,.10}, {-.5,.10},
        {-.5,-.10}, {.04,-.10}, {.04,-.26}};
    NSBezierPath *path = [NSBezierPath bezierPath];
    for (NSUInteger i=0; i<7; i++) {
        NSPoint point = NSMakePoint(centre.x + length*(xy[i][0]*direction.x + xy[i][1]*across.x),
            centre.y + length*(xy[i][0]*direction.y + xy[i][1]*across.y));
        if (i == 0) [path moveToPoint:point]; else [path lineToPoint:point];
    }
    [path closePath];
    return path;
}

NSColor *KiteWindSpeedColour(double kt, double minKt, double maxKt) {
    if (!isfinite(kt) || kt < 0 || !isfinite(minKt) || !isfinite(maxKt) || maxKt < minKt)
        return NSColor.secondaryLabelColor;
    if (kt < minKt) return [NSColor colorWithSRGBRed:1 green:.62 blue:.08 alpha:1];
    if (kt > maxKt) return [NSColor colorWithSRGBRed:.92 green:.17 blue:.12 alpha:1];
    return [NSColor colorWithSRGBRed:.23 green:.80 blue:.18 alpha:1];
}

static BOOL Direction(NSDictionary *row, double *from) {
    id value = row[@"windFrom"];
    if ([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]) &&
        [value doubleValue] >= 0 && [value doubleValue] <= 360) {
        *from = [value doubleValue];
        return YES;
    }
    return WindFromDegrees([row[@"windDir"] isKindOfClass:NSString.class] ? row[@"windDir"] : nil, from);
}

static NSDate *FloorHour(NSDate *date, NSTimeZone *tz) {
    NSCalendar *cal = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: NSTimeZone.localTimeZone;
    NSDateComponents *c = [cal components:(NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay|NSCalendarUnitHour)
                                  fromDate:date ?: NSDate.date];
    return [cal dateFromComponents:c] ?: (date ?: NSDate.date);
}

static NSString *ShortDayTime(NSDate *date, NSTimeZone *tz, NSDate *now) {
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU"];
    f.timeZone = tz ?: NSTimeZone.localTimeZone;
    NSDateFormatter *day = [NSDateFormatter new];
    day.locale = f.locale; day.timeZone = f.timeZone; day.dateFormat = @"EEE";
    f.dateFormat = @"HH:mm";
    NSCalendar *cal = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = f.timeZone;
    if (now && [cal isDate:date inSameDayAsDate:now]) return [f stringFromDate:date];
    return [NSString stringWithFormat:@"%@ %@", [day stringFromDate:date], [f stringFromDate:date]];
}

static CGFloat XForDate(NSDate *date, NSDate *start, CGFloat left, CGFloat plotW, double horizon) {
    return left + plotW * clampf([date timeIntervalSinceDate:start] / (horizon * 3600.0), 0, 1);
}

static CGFloat YForSpeed(double kt, CGFloat windTop, CGFloat windBottom, double maxSpeed) {
    return windBottom - (windBottom - windTop) * clampf(kt / maxSpeed, 0, 1);
}

@interface HourlyForecastView ()
@property(nonatomic, strong) NSView *playheadCursor;
@end

@implementation HourlyForecastView

- (instancetype)initWithFrame:(NSRect)frame {
    if ((self = [super initWithFrame:frame])) {
        _windRows = @[]; _rainRows = @[]; _minKt = 15; _maxKt = 30; _horizonHours = 48;
        self.toolTip = nil;
    }
    return self;
}

- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSSize)intrinsicContentSize { return NSMakeSize(600, 158); }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }

- (void)setWindRows:(NSArray<NSDictionary *> *)rows { _windRows = [rows copy] ?: @[]; [self setNeedsDisplay:YES]; }
- (void)setRainRows:(NSArray<NSDictionary *> *)rows { _rainRows = [rows copy] ?: @[]; [self setNeedsDisplay:YES]; }
- (void)setNow:(NSDate *)now { _now = now; [self setNeedsDisplay:YES]; }
- (void)setSelectedDate:(NSDate *)date {
    if (date != _selectedDate && ![date isEqualToDate:_selectedDate]) _selectedDate = date;
    [self placeCursor];
}
- (void)layout { [super layout]; [self placeCursor]; }
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self placeCursor]; [self setNeedsDisplay:YES]; }
- (CGFloat)cursorXForDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class]) return NAN;
    NSDate *start = FloorHour(self.now ?: NSDate.date, self.timeZone);
    double horizon = self.horizonHours > 0 ? self.horizonHours : 48;
    NSTimeInterval offset = [date timeIntervalSinceDate:start];
    if (offset < 0 || offset > horizon * 3600) return NAN;
    NSRect plot = [self windPlotRect];
    return XForDate(date, start, NSMinX(plot), NSWidth(plot), horizon);
}
- (void)placeCursor {
    NSRect plot = [self windPlotRect];
    CGFloat top = NSMinY(plot), bottom = NSHeight(self.bounds) - 17;
    PlaceVerticalCursor(self, &_playheadCursor, [self cursorXForDate:self.selectedDate], top, MAX(1, bottom - top));
}
- (void)setHorizonHours:(double)hours { _horizonHours = (isfinite(hours) && hours > 0) ? hours : 48; [self setNeedsDisplay:YES]; }
- (void)setTimeZone:(NSTimeZone *)tz { _timeZone = tz; [self setNeedsDisplay:YES]; }

- (NSRect)windPlotRect {
    // Half an arrow fits beyond both time endpoints and above the speed scale.
    return NSMakeRect(54, 14, MAX(1, NSWidth(self.bounds)-70), MAX(1, NSHeight(self.bounds)-43));
}

- (NSString *)summaryAtPoint:(NSPoint)point {
    NSRect plot = [self windPlotRect];
    if (point.x < NSMinX(plot) || point.x > NSMaxX(plot) ||
        point.y < 0 || point.y > NSHeight(self.bounds)-12) return nil;
    double horizon = self.horizonHours > 0 ? self.horizonHours : 48;
    double position = horizon * (point.x-NSMinX(plot))/NSWidth(plot);
    NSInteger hour = (NSInteger)llround(position), rainHour = (NSInteger)floor(position);
    NSDate *start = FloorHour(self.now ?: NSDate.date, self.timeZone);
    NSDate *date = [start dateByAddingTimeInterval:hour*3600];
    NSDate *rainStart = [start dateByAddingTimeInterval:rainHour*3600];
    NSDate *rainEnd = [rainStart dateByAddingTimeInterval:3600];
    NSDictionary *wind = nil, *rain = nil;
    for (NSDictionary *row in self.windRows)
        if ([row[@"time"] isKindOfClass:NSDate.class] && fabs([row[@"time"] timeIntervalSinceDate:date]) < 1800) { wind=row; break; }
    if (rainHour < horizon) for (NSDictionary *row in self.rainRows)
        if ([row[@"time"] isKindOfClass:NSDate.class] && fabs([row[@"time"] timeIntervalSinceDate:rainEnd]) < 1800) { rain=row; break; }
    double speed=0, gust=0, from=0, mm=0;
    BOOL hasWind = [self row:wind number:@"windKt" value:&speed] && speed >= 0;
    BOOL hasRain = [self row:rain number:@"rainMm" value:&mm] && mm >= 0;
    if (!hasWind && !hasRain) return nil;
    NSMutableString *text = [NSMutableString stringWithString:ShortDayTime(hasWind?date:rainStart,self.timeZone,self.now)];
    if (hasWind) {
        if (speed < .5) [text appendString:@"\nCalm"];
        else {
            [text appendFormat:@"\nWind %.0f kt",speed];
            if (Direction(wind,&from)) [text appendFormat:@" from %03.0f°",from];
            if ([self row:wind number:@"gustKt" value:&gust] && gust > speed+.5)
                [text appendFormat:@" · gusts %.0f",gust];
            if (self.hasShore && Direction(wind,&from) && WindIsOffshore(WindToDegrees(from),self.shoreNormal,YES))
                [text appendString:@" · offshore"];
        }
    }
    if (hasRain) [text appendFormat:@"\nRain %@–%@ %.1f mm", ShortDayTime(rainStart,self.timeZone,self.now),
        ShortDayTime(rainEnd,self.timeZone,self.now),mm];
    return text;
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    [self removeAllToolTips];
    [self addToolTipRect:self.bounds owner:self userData:NULL];
}

- (NSString *)view:(NSView *)view stringForToolTip:(NSToolTipTag)tag point:(NSPoint)point userData:(void *)data {
    (void)view; (void)tag; (void)data;
    return [self summaryAtPoint:point] ?: @"";
}

- (BOOL)row:(NSDictionary *)row number:(NSString *)key value:(double *)value {
    id n = row[key];
    if (![n isKindOfClass:NSNumber.class] || !isfinite([n doubleValue])) return NO;
    if (value) *value = [n doubleValue];
    return YES;
}

- (NSArray<NSDictionary *> *)dayLabels {
    NSDate *start = FloorHour(self.now ?: NSDate.date, self.timeZone);
    double horizon = self.horizonHours > 0 ? self.horizonHours : 48;
    NSDate *end = [start dateByAddingTimeInterval:horizon*3600];
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = self.timeZone ?: NSTimeZone.localTimeZone;
    NSDateFormatter *formatter = [NSDateFormatter new];
    formatter.timeZone = calendar.timeZone; formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    formatter.dateFormat = @"EEE";
    NSRect plot = [self windPlotRect];
    NSMutableArray *labels = [NSMutableArray array];
    CGFloat previousRight = -CGFLOAT_MAX;
    NSDictionary *attrs = @{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular]};
    for (NSDate *day = [calendar startOfDayForDate:start]; [day compare:end] != NSOrderedDescending;
         day = [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:day options:0]) {
        NSDate *noon = [calendar dateBySettingHour:12 minute:0 second:0 ofDate:day options:0];
        if (!noon || [noon compare:start] == NSOrderedAscending || [noon compare:end] == NSOrderedDescending) continue;
        NSString *text = [formatter stringFromDate:noon];
        CGFloat width = ceil([text sizeWithAttributes:attrs].width);
        CGFloat x = clampf(XForDate(noon,start,NSMinX(plot),NSWidth(plot),horizon)-width/2,NSMinX(plot),NSMaxX(plot)-width);
        if (x < previousRight+8) continue;
        [labels addObject:@{@"text":text,@"date":noon,@"width":@(width),@"origin":[NSValue valueWithPoint:NSMakePoint(x,NSHeight(self.bounds)-14)]}];
        previousRight = x+width;
    }
    return labels;
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    [NSGraphicsContext saveGraphicsState];
    [[NSBezierPath bezierPathWithRect:self.bounds] addClip];
    CGFloat w = NSWidth(self.bounds), h = NSHeight(self.bounds);
    NSRect plot = [self windPlotRect];
    CGFloat left = NSMinX(plot), right = w-NSMaxX(plot), bottom = h-23;
    CGFloat plotW = NSWidth(plot), windBottom = NSMaxY(plot), windTop = NSMinY(plot);
    NSColor *secondary = NSColor.secondaryLabelColor;
    NSColor *grid = [secondary colorWithAlphaComponent:0.16];
    NSColor *night = [secondary colorWithAlphaComponent:0.07];
    NSDate *start = FloorHour(self.now ?: NSDate.date, self.timeZone);
    double horizon = self.horizonHours > 0 ? self.horizonHours : 48;
    NSDate *end = [start dateByAddingTimeInterval:horizon*3600];
    double maxSpeed = 30;
    for (NSDictionary *row in self.windRows) {
        NSDate *date = row[@"time"];
        if (![date isKindOfClass:NSDate.class] || [date compare:start] == NSOrderedAscending || [date compare:end] == NSOrderedDescending) continue;
        double speed = 0;
        if ([self row:row number:@"windKt" value:&speed]) maxSpeed = MAX(maxSpeed, ceil(speed/10)*10);
        if ([self row:row number:@"gustKt" value:&speed]) maxSpeed = MAX(maxSpeed, ceil(speed/10)*10);
    }
    NSCalendar *axisCal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    axisCal.timeZone = self.timeZone ?: NSTimeZone.localTimeZone;
    // The configured wind band stays separate from speed colours.
    if (isfinite(self.minKt) && isfinite(self.maxKt) && self.maxKt >= self.minKt && self.minKt >= 0) {
        CGFloat y0=YForSpeed(self.maxKt,windTop,windBottom,maxSpeed), y1=YForSpeed(self.minKt,windTop,windBottom,maxSpeed);
        [[NSColor.systemGreenColor colorWithAlphaComponent:.07] setFill];
        NSRectFillUsingOperation(NSMakeRect(left,y0,plotW,MAX(0,y1-y0)), NSCompositingOperationSourceOver);
    }
    // Known night is shaded only when rows explicitly identify it.
    for (NSInteger i = 0; i < ceil(horizon); i++) {
        NSDate *d = [start dateByAddingTimeInterval:i*3600];
        NSDictionary *row = nil;
        for (NSDictionary *r in self.windRows) if ([r[@"time"] isKindOfClass:NSDate.class] && fabs([r[@"time"] timeIntervalSinceDate:d]) < 1800) { row=r; break; }
        BOOL known = row[@"isDay"] != nil && row[@"isDay"] != NSNull.null;
        BOOL day = known ? [row[@"isDay"] boolValue] : YES;
        if (known && !day) {
            NSRect band = NSMakeRect(left + plotW*i/horizon, windTop, plotW/horizon, bottom-windTop);
            [night set]; NSRectFillUsingOperation(band, NSCompositingOperationSourceOver);
        }
    }

    // Grid, speed ticks and day boundaries.
    [grid set]; NSBezierPath *g = [NSBezierPath bezierPath]; g.lineWidth = 0.5;
    for (NSInteger kt = 10; kt <= maxSpeed; kt += maxSpeed > 60 ? 20 : 10) { CGFloat y = YForSpeed(kt, windTop, windBottom, maxSpeed); [g moveToPoint:NSMakePoint(left,y)]; [g lineToPoint:NSMakePoint(w-right,y)]; }
    NSInteger gridStep = horizon > 72 ? 12 : 6;
    for (NSInteger i = 0; i <= ceil(horizon); i++) {
        if ([axisCal component:NSCalendarUnitHour fromDate:[start dateByAddingTimeInterval:i*3600]] % gridStep) continue;
        CGFloat x = left + plotW*i/horizon; [g moveToPoint:NSMakePoint(x,windTop)]; [g lineToPoint:NSMakePoint(x,bottom)];
    }
    [g stroke];
    NSDictionary *attrs = @{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular], NSForegroundColorAttributeName:secondary};
    for (NSInteger kt = 10; kt < maxSpeed; kt += maxSpeed > 60 ? 20 : 10) [[NSString stringWithFormat:@"%ld",(long)kt] drawAtPoint:NSMakePoint(4, YForSpeed(kt, windTop, windBottom, maxSpeed)-6) withAttributes:attrs];
    [[NSString stringWithFormat:@"kt"] drawAtPoint:NSMakePoint(4, windTop-1) withAttributes:attrs];
    for (NSDictionary *label in [self dayLabels]) {
        [label[@"text"] drawAtPoint:[label[@"origin"] pointValue] withAttributes:attrs];
    }

    // Quiet traces underneath the direction marks; gaps remain gaps.
    NSDictionary *last = nil; NSDate *lastDate = nil;
    double lastGust=0; BOOL hasLastGust=NO;
    for (NSDictionary *row in self.windRows) {
        NSDate *date=row[@"time"]; double kt=0, gust=0;
        if (![date isKindOfClass:NSDate.class] || [date compare:start] == NSOrderedAscending ||
            [date compare:end] == NSOrderedDescending || ![self row:row number:@"windKt" value:&kt] || kt < 0) {
            last=nil; lastDate=nil; hasLastGust=NO; continue;
        }
        BOOL hasGust=[self row:row number:@"gustKt" value:&gust] && gust >= kt;
        CGFloat x=XForDate(date,start,left,plotW,horizon), y=YForSpeed(kt,windTop,windBottom,maxSpeed);
        if (last && [date timeIntervalSinceDate:lastDate] > 0 && [date timeIntervalSinceDate:lastDate] <= 4500) {
            double old=0; [self row:last number:@"windKt" value:&old];
            [[secondary colorWithAlphaComponent:.26] setStroke];
            NSBezierPath *line=[NSBezierPath bezierPath]; line.lineWidth=1;
            [line moveToPoint:NSMakePoint(XForDate(lastDate,start,left,plotW,horizon),YForSpeed(old,windTop,windBottom,maxSpeed))];
            [line lineToPoint:NSMakePoint(x,y)]; [line stroke];
            if (hasGust && hasLastGust) {
                CGFloat dash[]={3,3};
                NSBezierPath *gustLine=[NSBezierPath bezierPath]; gustLine.lineWidth=1;
                [gustLine setLineDash:dash count:2 phase:0];
                [[secondary colorWithAlphaComponent:.55] setStroke];
                [gustLine moveToPoint:NSMakePoint(XForDate(lastDate,start,left,plotW,horizon),YForSpeed(lastGust,windTop,windBottom,maxSpeed))];
                [gustLine lineToPoint:NSMakePoint(x,YForSpeed(gust,windTop,windBottom,maxSpeed))]; [gustLine stroke];
            }
        }
        last=row; lastDate=date; lastGust=gust; hasLastGust=hasGust;
    }
    CGFloat hourWidth=plotW/horizon;
    NSInteger stride=MAX(1,(NSInteger)ceil(18.0/hourWidth));
    CGFloat length=clampf(hourWidth*stride*.92,20,25);
    CGFloat lastArrowX=-CGFLOAT_MAX;
    NSDate *lastArrowDate=nil;
    for (NSDictionary *row in self.windRows) {
        NSDate *date=row[@"time"]; double kt=0, from=0;
        if (![date isKindOfClass:NSDate.class] || [date compare:start] == NSOrderedAscending ||
            [date compare:end] == NSOrderedDescending || ![self row:row number:@"windKt" value:&kt] || kt < 0) continue;
        NSPoint centre=NSMakePoint(XForDate(date,start,left,plotW,horizon),YForSpeed(kt,windTop,windBottom,maxSpeed));
        NSColor *colour=KiteWindSpeedColour(kt, self.minKt, self.maxKt);
        if (kt < .5) {
            [secondary setStroke];
            NSBezierPath *calm=[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(centre.x-3,centre.y-3,6,6)];
            calm.lineWidth=1.2; [calm stroke];
        } else if (!Direction(row,&from) || centre.x-lastArrowX < 27 || (lastArrowDate && [date timeIntervalSinceDate:lastArrowDate] < 3*3600)) {
            [colour setFill];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(centre.x-1.8,centre.y-1.8,3.6,3.6)] fill];
        } else {
            lastArrowX=centre.x; lastArrowDate=date;
            NSBezierPath *arrow=KiteWindArrowPath(centre,from,length);
            [colour setFill]; [arrow fill];
            [[NSColor colorWithSRGBRed:.15 green:.17 blue:.14 alpha:.8] setStroke];
            arrow.lineWidth=.75; arrow.lineJoinStyle=NSLineJoinStyleRound; [arrow stroke];
        }
    }
    [self placeCursor];
    [NSGraphicsContext restoreGraphicsState];
}

- (NSString *)accessibilityRoleDescription { return @"wind forecast"; }
- (NSString *)accessibilityLabel {
    return [NSString stringWithFormat:@"%.0f hour wind forecast. Arrows point downwind. Amber is lighter than the chosen kite range, green is inside it, red is stronger. Dashed lines show gusts.", self.horizonHours > 0 ? self.horizonHours : 48];
}

@end
