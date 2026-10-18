#import "mapdetail.h"
#import "playheadcursor.h"
#import <math.h>

static BOOL Number(id n) {
    return [n isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)n) != CFBooleanGetTypeID() && isfinite([n doubleValue]);
}

NSDictionary *MapDetailSample(NSArray<NSDictionary *> *rows, NSDate *valid) {
    if (![valid isKindOfClass:NSDate.class]) return nil;
    NSDictionary *nearest = nil;
    NSTimeInterval distance = 30 * 60 + .001;
    for (id row in rows) {
        if (![row isKindOfClass:NSDictionary.class] || ![row[@"time"] isKindOfClass:NSDate.class]) continue;
        NSTimeInterval delta = fabs([row[@"time"] timeIntervalSinceDate:valid]);
        if (delta < distance) { nearest = row; distance = delta; }
    }
    return nearest;
}

static NSColor *DetailColour(NSString *kind) {
    if ([kind isEqual:@"Temperature"]) return [NSColor colorWithSRGBRed:.76 green:.30 blue:.14 alpha:1];
    if ([kind isEqual:@"Surf"]) return [NSColor colorWithSRGBRed:.04 green:.46 blue:.43 alpha:1];
    if ([kind isEqual:@"Fly"]) return [NSColor colorWithSRGBRed:.42 green:.28 blue:.62 alpha:1];
    return [NSColor colorWithSRGBRed:.05 green:.38 blue:.59 alpha:1];
}

NSRect MapDetailsRect(NSUInteger count, NSRect bounds) {
    if (!count || bounds.size.width < 220 || bounds.size.height < 150) return NSZeroRect;
    CGFloat height=8+count*35;
    if (height>NSHeight(bounds)-16) height=8+count*22;
    if (height>NSHeight(bounds)-16) return NSZeroRect;
    return NSMakeRect(8,8,MIN(206,NSWidth(bounds)-20),height);
}

static CGFloat OverlapArea(NSRect a, NSRect b) {
    NSRect overlap = NSIntersectionRect(a, b);
    return NSWidth(overlap) * NSHeight(overlap);
}

NSRect MapPointCardRect(NSRect bounds, NSRect previous, NSRect point, NSArray<NSValue *> *reserved) {
    CGFloat margin = MIN(8, MIN(NSWidth(bounds), NSHeight(bounds))/2);
    NSRect room = NSInsetRect(bounds, margin, margin);
    CGFloat width = MIN(304, NSWidth(room)), height = MIN(82, NSHeight(room));
    if (width <= 0 || height <= 0) return NSZeroRect;
    NSRect preferred = NSMakeRect(NSMinX(room), NSMaxY(room)-height, width, height);
    BOOL sameSize = NSEqualSizes(previous.size, preferred.size) && NSContainsRect(room, previous);
    NSMutableArray<NSValue *> *obstacles = [NSMutableArray array];
    for (NSValue *value in reserved) {
        NSRect rect = NSIntersectionRect(bounds, value.rectValue);
        if (!NSIsEmptyRect(rect)) [obstacles addObject:[NSValue valueWithRect:NSInsetRect(rect,-8,-8)]];
    }
    NSRect keepPoint = NSIsEmptyRect(point) ? NSZeroRect : NSInsetRect(point,-8,-8);
    CGFloat (^chromeOverlap)(NSRect) = ^CGFloat(NSRect card) {
        CGFloat area = 0;
        for (NSValue *value in obstacles) area += OverlapArea(card, value.rectValue);
        return area;
    };
    // Avoid chasing the point or snapping back on every forecast tick.
    if (sameSize && chromeOverlap(previous) == 0 && !NSIntersectsRect(previous,keepPoint)) return previous;
    NSMutableArray<NSNumber *> *xs = [NSMutableArray arrayWithObjects:@(NSMinX(room)),@(NSMaxX(room)-width),nil];
    NSMutableArray<NSNumber *> *ys = [NSMutableArray arrayWithObjects:@(NSMaxY(room)-height),@(NSMinY(room)),nil];
    if (sameSize) { [xs addObject:@(NSMinX(previous))]; [ys addObject:@(NSMinY(previous))]; }
    NSMutableArray<NSValue *> *edges = [obstacles mutableCopy];
    if (!NSIsEmptyRect(keepPoint)) [edges addObject:[NSValue valueWithRect:keepPoint]];
    for (NSValue *value in edges) {
        NSRect rect = value.rectValue;
        [xs addObjectsFromArray:@[@(NSMinX(rect)-width),@(NSMaxX(rect))]];
        [ys addObjectsFromArray:@[@(NSMinY(rect)-height),@(NSMaxY(rect))]];
    }
    NSRect anchor = sameSize ? previous : preferred, best = preferred;
    CGFloat bestChrome = CGFLOAT_MAX, bestPoint = CGFLOAT_MAX, bestDistance = CGFLOAT_MAX;
    for (NSNumber *x in xs) for (NSNumber *y in ys) {
        NSRect candidate = NSMakeRect(MAX(NSMinX(room),MIN(NSMaxX(room)-width,x.doubleValue)),
            MAX(NSMinY(room),MIN(NSMaxY(room)-height,y.doubleValue)),width,height);
        CGFloat chrome = chromeOverlap(candidate), coveredPoint = OverlapArea(candidate,keepPoint);
        CGFloat dx = NSMinX(candidate)-NSMinX(anchor), dy = NSMinY(candidate)-NSMinY(anchor);
        CGFloat distance = dx*dx+dy*dy;
        if (chrome < bestChrome || (chrome == bestChrome && (coveredPoint < bestPoint ||
            (coveredPoint == bestPoint && distance < bestDistance)))) {
            best = candidate; bestChrome = chrome; bestPoint = coveredPoint; bestDistance = distance;
        }
    }
    return best;
}

void DrawMapDetails(NSArray<NSDictionary *> *records, NSRect bounds) {
    NSRect box=MapDetailsRect(records.count,bounds);
    if (NSIsEmptyRect(box)) return;
    // Named local readings in a corner card, not invented pins on a PDF whose
    // forecast projection is different from the analysed chart's projection.
    CGFloat width = NSWidth(box), rowH = (NSHeight(box)-8)/records.count;
    BOOL compact=rowH<35;
    [[NSColor colorWithWhite:1 alpha:.92] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:box xRadius:6 yRadius:6] fill];
    NSColor *ink = [NSColor colorWithWhite:.15 alpha:1], *secondary = [NSColor colorWithWhite:.40 alpha:1];
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new]; style.lineBreakMode = NSLineBreakByTruncatingTail;
    NSUInteger i = 0;
    for (NSDictionary *record in records) {
        CGFloat y = 12 + i++ * rowH;
        NSColor *colour = DetailColour(record[@"kind"]);
        NSString *value=[record[@"value"] isKindOfClass:NSString.class] ? record[@"value"] : @"—";
        if (compact) {
            NSString *text=[NSString stringWithFormat:@"%@: %@",record[@"kind"] ?: @"",value];
            [text drawInRect:NSMakeRect(15,y,width-14,18) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:11 weight:NSFontWeightMedium],NSForegroundColorAttributeName:colour,NSParagraphStyleAttributeName:style}];
            continue;
        }
        [colour setFill];
        [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(14,y+2,3,26) xRadius:1 yRadius:1] fill];
        NSString *heading = [NSString stringWithFormat:@"%@ · %@", record[@"place"] ?: @"", record[@"kind"] ?: @""];
        [heading drawInRect:NSMakeRect(23,y,width-24,13) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:10 weight:NSFontWeightMedium],NSForegroundColorAttributeName:secondary,NSParagraphStyleAttributeName:style}];
        CGFloat inset = 0;
        if (Number(record[@"to"])) {
            double r = [record[@"to"] doubleValue] * M_PI / 180;
            NSPoint centre=NSMakePoint(30,y+22), tip=NSMakePoint(centre.x+8*sin(r),centre.y-8*cos(r));
            NSBezierPath *arrow=[NSBezierPath bezierPath];
            [arrow moveToPoint:NSMakePoint(centre.x-6*sin(r),centre.y+6*cos(r))]; [arrow lineToPoint:tip];
            [arrow moveToPoint:NSMakePoint(tip.x-5*sin(r)+4*cos(r),tip.y+5*cos(r)+4*sin(r))];
            [arrow lineToPoint:tip]; [arrow lineToPoint:NSMakePoint(tip.x-5*sin(r)-4*cos(r),tip.y+5*cos(r)-4*sin(r))];
            [colour setStroke]; arrow.lineWidth=2.2; [arrow stroke]; inset=22;
        }
        [value drawInRect:NSMakeRect(23+inset,y+13,width-24-inset,18) withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightSemibold],NSForegroundColorAttributeName:ink,NSParagraphStyleAttributeName:style}];
    }
}

@implementation MapPointCard
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self = [super initWithFrame:frame])) {
        _closeButton = [NSButton buttonWithTitle:@"×" target:self action:@selector(close:)];
        _closeButton.bordered = NO;
        _closeButton.transparent = YES; // glyph is included in offscreen drawing below
        _closeButton.accessibilityLabel = @"Close point weather";
        _closeButton.accessibilityIdentifier = @"map.point.close";
        _closeButton.frame = NSMakeRect(NSWidth(frame)-28, 2, 26, 26);
        _closeButton.autoresizingMask = NSViewMinXMargin;
        [self addSubview:_closeButton];
        self.accessibilityIdentifier = @"map.point.card";
    }
    return self;
}
- (BOOL)isFlipped { return YES; }
- (void)close:(id)sender { (void)sender; if (self.onClose) self.onClose(); }
- (void)setSample:(NSDictionary *)sample { _sample = [sample copy]; self.needsDisplay = YES; }
- (NSString *)readings {
    NSString *(^number)(NSString *, NSString *) = ^NSString *(NSString *key, NSString *format) {
        return Number(self.sample[key]) ? [NSString stringWithFormat:format, [self.sample[key] doubleValue]] : @"—";
    };
    return [NSString stringWithFormat:@"%@ °C    %@/%@ kt", number(@"temperature", @"%.1f"),
        number(@"direction", @"%03.0f"), number(@"wind", @"%.0f")];
}
- (NSString *)pressure {
    return [NSString stringWithFormat:@"MSLP %@ hPa", Number(self.sample[@"pressure"]) ?
        [NSString stringWithFormat:@"%.0f", [self.sample[@"pressure"] doubleValue]] : @"—"];
}
- (NSString *)rain {
    id value = self.sample[@"rain24h"];
    return [NSString stringWithFormat:@"Rain 24h %@ mm", Number(value) && [value doubleValue] >= 0 ?
        [NSString stringWithFormat:@"%.1f", [value doubleValue]] : @"—"];
}
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityGroupRole; }
- (NSString *)accessibilityLabel {
    return [NSString stringWithFormat:@"%@, %@, %@, %@ (24 hours ending at map time)", self.sample[@"title"] ?: @"", self.readings, self.pressure, self.rain];
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [[NSColor colorWithWhite:self.dark ? .12 : .98 alpha:.96] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:7 yRadius:7] fill];
    NSColor *ink = [NSColor colorWithWhite:self.dark ? .94 : .12 alpha:1];
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new]; style.lineBreakMode = NSLineBreakByTruncatingTail;
    NSDictionary *heading = @{NSFontAttributeName:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName:ink, NSParagraphStyleAttributeName:style};
    NSDictionary *value = @{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:13 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName:ink};
    [self.sample[@"title"] drawInRect:NSMakeRect(10,8,NSWidth(self.bounds)-42,18) withAttributes:heading];
    [@"×" drawAtPoint:NSMakePoint(NSWidth(self.bounds)-21,6) withAttributes:value];
    [self.readings drawAtPoint:NSMakePoint(10,31) withAttributes:value];
    [self.pressure drawAtPoint:NSMakePoint(10,54) withAttributes:value];
    [self.rain drawAtPoint:NSMakePoint(NSWidth(self.bounds)-10-[self.rain sizeWithAttributes:value].width,54) withAttributes:value];
}
@end

@interface TemperatureForecastView ()
@property(nonatomic, strong) NSView *playheadCursor;
@end

@implementation TemperatureForecastView
- (BOOL)isFlipped { return YES; }
- (NSRect)plotRect { return NSMakeRect(34,18,MAX(1,NSWidth(self.bounds)-46),MAX(1,NSHeight(self.bounds)-42)); }
- (NSDate *)startDate { NSDate *date=self.now ?: NSDate.date; return [NSDate dateWithTimeIntervalSince1970:floor(date.timeIntervalSince1970/3600)*3600]; }
- (void)setSelectedDate:(NSDate *)date {
    if (date != _selectedDate && ![date isEqualToDate:_selectedDate]) _selectedDate = date;
    [self placeCursor];
}
- (void)layout { [super layout]; [self placeCursor]; }
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self placeCursor]; self.needsDisplay = YES; }
- (NSDate *)plotStart { NSDate *date = self.now ?: NSDate.date; return [NSDate dateWithTimeIntervalSince1970:floor(date.timeIntervalSince1970 / 3600) * 3600]; }
- (CGFloat)cursorXForDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class]) return NAN;
    double horizon = self.horizonHours > 0 ? self.horizonHours : 48;
    NSDate *start = [self plotStart];
    NSTimeInterval offset = [date timeIntervalSinceDate:start];
    if (offset < 0 || offset > horizon * 3600) return NAN;
    NSRect plot = [self plotRect];
    return NSMinX(plot) + offset / (horizon * 3600) * NSWidth(plot);
}
- (void)placeCursor {
    NSRect plot = [self plotRect];
    PlaceVerticalCursor(self, &_playheadCursor, [self cursorXForDate:self.selectedDate], NSMinY(plot), NSHeight(plot));
}
- (void)setHorizonHours:(double)hours { _horizonHours=(isfinite(hours)&&hours>0)?hours:48; self.needsDisplay=YES; }
- (NSArray<NSArray<NSDictionary *> *> *)segments {
    double horizon=self.horizonHours>0?self.horizonHours:48; NSDate *start=[self startDate], *end=[start dateByAddingTimeInterval:horizon*3600];
    NSMutableArray *valid=[NSMutableArray array];
    for (id row in self.rows) if ([row isKindOfClass:NSDictionary.class] && [row[@"time"] isKindOfClass:NSDate.class] &&
        [row[@"time"] compare:start]!=NSOrderedAscending && [row[@"time"] compare:end]!=NSOrderedDescending) [valid addObject:row];
    [valid sortUsingComparator:^NSComparisonResult(NSDictionary *a,NSDictionary *b){return [a[@"time"] compare:b[@"time"]];}];
    NSMutableArray *segments=[NSMutableArray array], *segment=nil; NSDate *previous=nil;
    for (NSDictionary *row in valid) {
        if (!Number(row[@"temp"])) { segment=nil; previous=nil; continue; }
        double gap=previous ? [row[@"time"] timeIntervalSinceDate:previous] : INFINITY;
        if (gap<=0) continue;
        if (!segment || gap>3601) { segment=[NSMutableArray array]; [segments addObject:segment]; }
        [segment addObject:row]; previous=row[@"time"];
    }
    return segments;
}
- (NSString *)summaryAtPoint:(NSPoint)point {
    NSRect p=[self plotRect]; if (!NSPointInRect(point,p)) return nil;
    double horizon=self.horizonHours>0?self.horizonHours:48;
    NSDate *date=[[self startDate] dateByAddingTimeInterval:(point.x-NSMinX(p))/NSWidth(p)*horizon*3600];
    NSDictionary *row=MapDetailSample(self.rows,date); if (!Number(row[@"temp"])) return nil;
    NSDateFormatter *f=[NSDateFormatter new]; f.timeZone=self.timeZone ?: NSTimeZone.localTimeZone; f.dateFormat=@"EEE h a";
    return [NSString stringWithFormat:@"%@ · %.1f°C",[f stringFromDate:row[@"time"]],[row[@"temp"] doubleValue]];
}
- (void)setRows:(NSArray *)rows { _rows=[rows copy]; self.needsDisplay=YES; }
- (void)updateTrackingAreas { [super updateTrackingAreas]; [self removeAllToolTips]; [self addToolTipRect:self.bounds owner:self userData:NULL]; }
- (NSString *)view:(NSView *)view stringForToolTip:(NSToolTipTag)tag point:(NSPoint)point userData:(void *)data {
    (void)view; (void)tag; (void)data; return [self summaryAtPoint:point];
}
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityLabel { return [NSString stringWithFormat:@"%.0f hour temperature forecast in degrees Celsius", self.horizonHours > 0 ? self.horizonHours : 48]; }
- (NSArray<NSDictionary<NSString *, id> *> *)dayLabels {
    NSRect plot = [self plotRect];
    double horizon = self.horizonHours > 0 ? self.horizonHours : 48;
    NSDate *start = [self startDate];
    NSDate *end = [start dateByAddingTimeInterval:horizon * 3600];
    NSTimeZone *zone = self.timeZone ?: NSTimeZone.localTimeZone;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = zone;
    NSDictionary *attrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:11],
        NSForegroundColorAttributeName: NSColor.secondaryLabelColor
    };
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.timeZone = zone;
    fmt.dateFormat = @"EEE";
    NSMutableArray *out = [NSMutableArray array];
    NSDate *day = [cal dateByAddingUnit:NSCalendarUnitDay value:-1 toDate:start options:0] ?: start;
    CGFloat lastRight = -1e9;
    for (int guard = 0; guard < 16; guard++) {
        if ([day compare:end] == NSOrderedDescending) break;
        NSDateComponents *parts = [cal components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay fromDate:day];
        parts.hour = 12;
        parts.minute = 0;
        parts.second = 0;
        NSDate *noon = [cal dateFromComponents:parts];
        day = [cal dateByAddingUnit:NSCalendarUnitDay value:1 toDate:day options:0];
        if (![noon isKindOfClass:NSDate.class]) continue;
        if ([noon compare:start] == NSOrderedAscending || [noon compare:end] == NSOrderedDescending) continue;
        NSString *text = [fmt stringFromDate:noon] ?: @"";
        CGFloat w = ceil([text sizeWithAttributes:attrs].width);
        NSTimeInterval offset = [noon timeIntervalSinceDate:start];
        CGFloat cx = NSMinX(plot) + offset / (horizon * 3600) * NSWidth(plot);
        CGFloat x = MIN(NSMaxX(plot) - w, MAX(NSMinX(plot), cx - w / 2));
        if (lastRight > -1e8 && x < lastRight + 8) continue;
        lastRight = x + w;
        [out addObject:@{@"text": text, @"x": @(x), @"y": @(NSMaxY(plot) + 6), @"width": @(w)}];
    }
    return out;
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty; NSRect plot=[self plotRect]; NSArray *segments=[self segments];
    NSDictionary *attrs=@{NSFontAttributeName:[NSFont systemFontOfSize:11],NSForegroundColorAttributeName:NSColor.secondaryLabelColor};
    if (!segments.count) { [@"Temperature unavailable" drawAtPoint:NSMakePoint(34,38) withAttributes:attrs]; return; }
    double lo=INFINITY,hi=-INFINITY;
    for (NSArray *segment in segments) for (NSDictionary *row in segment) { double t=[row[@"temp"] doubleValue]; lo=MIN(lo,t); hi=MAX(hi,t); }
    lo=floor((lo-1)/5)*5; hi=ceil((hi+1)/5)*5; hi=MAX(hi,lo+5);
    double horizon=self.horizonHours>0?self.horizonHours:48; NSDate *start=[self startDate];
    CGFloat (^x)(NSDate *)=^CGFloat(NSDate *t){return NSMinX(plot)+[t timeIntervalSinceDate:start]/(horizon*3600)*NSWidth(plot);};
    CGFloat (^y)(double)=^CGFloat(double t){return NSMaxY(plot)-(t-lo)/(hi-lo)*NSHeight(plot);};
    for (double t=lo; t<=hi; t+=(hi-lo)/2) {
        [NSColor.separatorColor setStroke]; NSBezierPath *line=[NSBezierPath bezierPath];
        [line moveToPoint:NSMakePoint(NSMinX(plot),y(t))]; [line lineToPoint:NSMakePoint(NSMaxX(plot),y(t))]; line.lineWidth=.5; [line stroke];
        [[NSString stringWithFormat:@"%.0f°",t] drawAtPoint:NSMakePoint(2,y(t)-7) withAttributes:attrs];
    }
    for (NSDictionary *label in [self dayLabels]) {
        NSString *text = label[@"text"];
        [text drawAtPoint:NSMakePoint([label[@"x"] doubleValue], [label[@"y"] doubleValue]) withAttributes:attrs];
    }
    [self placeCursor];
    NSColor *colour=NSColor.systemOrangeColor;
    for (NSArray *segment in segments) {
        NSBezierPath *line=[NSBezierPath bezierPath]; BOOL first=YES;
        for (NSDictionary *row in segment) { NSPoint p=NSMakePoint(x(row[@"time"]),y([row[@"temp"] doubleValue])); if(first)[line moveToPoint:p]; else [line lineToPoint:p]; first=NO; }
        [colour setStroke]; line.lineWidth=2.5; line.lineJoinStyle=NSLineJoinStyleRound; [line stroke];
        if (segment.count==1) { NSDictionary *row=segment[0]; [colour setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x(row[@"time"])-2,y([row[@"temp"] doubleValue])-2,4,4)] fill]; }
    }
}
@end
