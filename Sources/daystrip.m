#import "daystrip.h"
#import "pure.h"

static id Finite(id value) {
    return [value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]) ? value : nil;
}

static NSString *TempText(id value) {
    NSNumber *number = Finite(value);
    return number ? [NSString stringWithFormat:@"%.0f°", round(number.doubleValue)] : @"—";
}

static void AnnouncePolite(NSView *view, NSString *text) {
    if (!text.length || !view.window) return;
    NSAccessibilityPostNotificationWithUserInfo(view, NSAccessibilityAnnouncementRequestedNotification, @{
        NSAccessibilityAnnouncementKey: text,
        NSAccessibilityPriorityKey: @(NSAccessibilityPriorityLow),
    });
}

double DayStripTemperatureAtDate(NSArray<NSDictionary *> *series, NSDate *date) {
    if (![date isKindOfClass:NSDate.class] || ![series isKindOfClass:NSArray.class]) return NAN;
    NSDate *prevTime = nil, *nextTime = nil;
    double prev = NAN, next = NAN;
    for (NSDictionary *row in series) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSDate *time = [row[@"time"] isKindOfClass:NSDate.class] ? row[@"time"] : nil;
        NSNumber *value = Finite(row[@"temp"]);
        if (!time || !value) continue;
        NSComparisonResult order = [time compare:date];
        if (order == NSOrderedSame) return value.doubleValue;
        if (order == NSOrderedAscending) {
            if (!prevTime || [time compare:prevTime] == NSOrderedDescending) {
                prevTime = time;
                prev = value.doubleValue;
            }
        } else if (!nextTime || [time compare:nextTime] == NSOrderedAscending) {
            nextTime = time;
            next = value.doubleValue;
        }
    }
    if (!prevTime || !nextTime) return NAN;
    double span = [nextTime timeIntervalSinceDate:prevTime];
    if (!(span > 0)) return next;
    double u = [date timeIntervalSinceDate:prevTime] / span;
    return prev + (next - prev) * u;
}

NSDictionary *DayStripSampleAtDate(NSArray<NSDictionary *> *series, NSDate *date, NSTimeInterval limit) {
    if (![date isKindOfClass:NSDate.class] || ![series isKindOfClass:NSArray.class] || !(limit > 0)) return nil;
    NSDictionary *best = nil;
    NSTimeInterval bestGap = limit;
    for (NSDictionary *row in series) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSDate *time = [row[@"time"] isKindOfClass:NSDate.class] ? row[@"time"] : nil;
        if (!time) continue;
        NSTimeInterval gap = fabs([time timeIntervalSinceDate:date]);
        if (gap < bestGap || (best && gap == bestGap && [time compare:best[@"time"]] == NSOrderedAscending)) {
            bestGap = gap;
            best = row;
        }
    }
    return best;
}

static CGFloat TemperatureX(NSRect track, double temp, double weekMin, double weekMax) {
    if (!(weekMax > weekMin) || !isfinite(temp)) return NSMidX(track);
    double u = (temp - weekMin) / (weekMax - weekMin);
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    return NSMinX(track) + NSWidth(track) * u;
}

static NSColor *RangeColour(double t, double lo, double hi) {
    double u = hi > lo ? (t - lo) / (hi - lo) : .5;
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    // Cool stays blue-green so a dry day's range does not read as rain text.
    return [NSColor colorWithSRGBRed:.42 + (.94 - .42) * u green:.68 + (.52 - .68) * u blue:.78 + (.30 - .78) * u alpha:1];
}

// A template symbol drawn with -drawInRect: is black in every appearance.
static NSImageSymbolConfiguration *SymbolInk(void) {
    return [NSImageSymbolConfiguration configurationWithHierarchicalColor:NSColor.labelColor];
}

static const CGFloat kRangeThickness = 3;

// separatorColor is near-black at a low alpha. Forcing that alpha toward 1
// paints a solid black rail. Composite the separator over the paper instead.
static NSColor *RangeTrackColour(void) {
    NSColor *paper = [NSColor.windowBackgroundColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    NSColor *ink = [NSColor.separatorColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    CGFloat pr = 1, pg = 1, pb = 1, ir = 0, ig = 0, ib = 0, ia = 1;
    if (paper) [paper getRed:&pr green:&pg blue:&pb alpha:NULL];
    if (ink) [ink getRed:&ir green:&ig blue:&ib alpha:&ia];
    double mix = ia > 0 && ia < 0.95 ? MIN(0.45, ia) : 0.22;
    return [NSColor colorWithSRGBRed:pr + (ir - pr) * mix green:pg + (ig - pg) * mix blue:pb + (ib - pb) * mix alpha:1];
}

static void DrawTemperatureRange(NSRect track, BOOL hasWeek, double weekMin, double weekMax, id dayMin, id dayMax) {
    CGFloat thickness = NSHeight(track) >= kRangeThickness ? kRangeThickness : NSHeight(track);
    track = NSMakeRect(NSMinX(track), NSMinY(track), NSWidth(track), thickness);
    [RangeTrackColour() setFill];
    [[NSBezierPath bezierPathWithRoundedRect:track xRadius:thickness / 2 yRadius:thickness / 2] fill];
    NSNumber *min = Finite(dayMin), *max = Finite(dayMax);
    if (!hasWeek || !min || !max || !(weekMax > weekMin)) return;
    double lo = (min.doubleValue - weekMin) / (weekMax - weekMin);
    double hi = (max.doubleValue - weekMin) / (weekMax - weekMin);
    if (lo < 0) lo = 0;
    if (hi > 1) hi = 1;
    CGFloat x0 = NSMinX(track) + NSWidth(track) * lo;
    CGFloat x1 = NSMinX(track) + NSWidth(track) * hi;
    if (x1 - x0 < 4) { CGFloat mid = (x0 + x1) / 2; x0 = mid - 2; x1 = mid + 2; }
    if (x0 < NSMinX(track)) x0 = NSMinX(track);
    if (x1 > NSMaxX(track)) x1 = NSMaxX(track);
    NSRect segment = NSMakeRect(x0, NSMinY(track), MAX(4, x1 - x0), thickness);
    NSGradient *gradient = [[NSGradient alloc] initWithStartingColor:RangeColour(min.doubleValue, weekMin, weekMax)
        endingColor:RangeColour(max.doubleValue, weekMin, weekMax)];
    [gradient drawInBezierPath:[NSBezierPath bezierPathWithRoundedRect:segment xRadius:thickness / 2 yRadius:thickness / 2] angle:0];
}

@interface DayCell : NSButton
@property (nonatomic, copy) NSDictionary *day;
@property (nonatomic) double weekMin;
@property (nonatomic) double weekMax;
@property (nonatomic) BOOL hasWeek;
@end

@implementation DayCell
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (BOOL)canBecomeKeyView { return YES; }
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
- (void)drawWash {
    NSString *weekday = [self.day[@"weekday"] isKindOfClass:NSString.class] ? self.day[@"weekday"] : @"";
    BOOL today = [weekday isEqual:@"Today"];
    if (self.state != NSControlStateValueOn && !today) return;
    // Opaque blend. A translucent accent un-premultiplies to pure blue and
    // the rain-ink check would count the whole of today.
    CGFloat amount = self.state == NSControlStateValueOn ? .14 : .07;
    NSColor *paper = [NSColor.windowBackgroundColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    NSColor *accent = [NSColor.controlAccentColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    CGFloat pr = 1, pg = 1, pb = 1, ar = .2, ag = .45, ab = .95;
    if (paper) [paper getRed:&pr green:&pg blue:&pb alpha:NULL];
    if (accent) [accent getRed:&ar green:&ag blue:&ab alpha:NULL];
    [[NSColor colorWithSRGBRed:pr + (ar - pr) * amount green:pg + (ag - pg) * amount blue:pb + (ab - pb) * amount alpha:1] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 1, 1) xRadius:6 yRadius:6] fill];
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    // A tall cell is a narrow column. A short cell is one day of the horizontal strip.
    if (NSHeight(self.bounds) > NSWidth(self.bounds) * 1.2) { [self drawStacked]; return; }
    [self drawWash];
    NSDictionary *day = self.day ?: @{};
    NSFont *small = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
    NSFont *temp = [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium];
    NSDictionary *weekdayStyle = @{NSFontAttributeName: small, NSForegroundColorAttributeName: NSColor.secondaryLabelColor};
    NSString *weekday = [day[@"weekday"] isKindOfClass:NSString.class] ? day[@"weekday"] : @"";
    CGFloat width = NSWidth(self.bounds);
    CGFloat labelW = ceil([weekday sizeWithAttributes:weekdayStyle].width);
    [weekday drawAtPoint:NSMakePoint(MAX(0, (width - labelW) / 2), 1) withAttributes:weekdayStyle];
    NSNumber *code = Finite(day[@"weatherCode"]);
    NSString *symbol = code ? WeatherCodeSymbol(code.integerValue, YES) : nil;
    NSImage *icon = symbol ? [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:WeatherCodeLabel(code.integerValue)] : nil;
    if (icon) {
        NSImageSymbolConfiguration *style = [[NSImageSymbolConfiguration configurationWithPointSize:15 weight:NSFontWeightRegular]
            configurationByApplyingConfiguration:SymbolInk()];
        icon = [icon imageWithSymbolConfiguration:style] ?: icon;
        BOOL snug = NSHeight(self.bounds) < 58;
        CGFloat side = snug ? 14 : 16;
        [icon drawInRect:NSMakeRect((width - side) / 2, snug ? 12 : 14, side, side)];
    }
    NSString *temps = [NSString stringWithFormat:@"%@ %@", TempText(day[@"max"]), TempText(day[@"min"])];
    NSNumber *rain = Finite(day[@"rainMm"]);
    NSString *rainText = (rain && rain.doubleValue >= 1) ? (rain.doubleValue < 10 ? [NSString stringWithFormat:@"%.1f", rain.doubleValue] : [NSString stringWithFormat:@"%.0f", round(rain.doubleValue)]) : nil;
    NSDictionary *tempStyle = @{NSFontAttributeName: temp, NSForegroundColorAttributeName: NSColor.labelColor};
    NSDictionary *rainStyle = @{NSFontAttributeName: temp, NSForegroundColorAttributeName: NSColor.systemBlueColor};
    CGFloat tempW = ceil([temps sizeWithAttributes:tempStyle].width);
    CGFloat rainW = rainText ? ceil([rainText sizeWithAttributes:rainStyle].width) + 4 : 0;
    BOOL rainInline = rainText && tempW + rainW <= width - 4;
    CGFloat lineW = tempW + (rainInline ? rainW : 0);
    CGFloat lineX = MAX(0, (width - lineW) / 2);
    CGFloat tempY = NSHeight(self.bounds) < 58 ? 26 : 30;
    [temps drawAtPoint:NSMakePoint(lineX, tempY) withAttributes:tempStyle];
    if (rainInline) [rainText drawAtPoint:NSMakePoint(lineX + tempW + 4, tempY) withAttributes:rainStyle];
    else if (rainText && NSHeight(self.bounds) >= 58) {
        CGFloat alone = ceil([rainText sizeWithAttributes:rainStyle].width);
        [rainText drawAtPoint:NSMakePoint(MAX(0, (width - alone) / 2), 44) withAttributes:rainStyle];
    }
    CGFloat barY = NSHeight(self.bounds) - 8;
    if (barY < 34) { [self drawFocusRing]; return; }
    DrawTemperatureRange(NSMakeRect(6, barY, MAX(4, width - 12), kRangeThickness), self.hasWeek, self.weekMin, self.weekMax, day[@"min"], day[@"max"]);
    [self drawFocusRing];
}

- (void)drawFocusRing {
    if (self.window.firstResponder != self) return;
    [NSColor.keyboardFocusIndicatorColor setStroke];
    NSBezierPath *ring = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 1.5, 1.5) xRadius:6 yRadius:6];
    ring.lineWidth = 2;
    [ring stroke];
}

- (void)drawStacked {
    [self drawWash];
    NSDictionary *day = self.day ?: @{};
    CGFloat width = NSWidth(self.bounds);
    NSFont *small = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
    NSFont *temp = [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium];
    NSDictionary *weekdayStyle = @{NSFontAttributeName: small, NSForegroundColorAttributeName: NSColor.secondaryLabelColor};
    NSDictionary *tempStyle = @{NSFontAttributeName: temp, NSForegroundColorAttributeName: NSColor.labelColor};
    NSString *weekday = [day[@"weekday"] isKindOfClass:NSString.class] ? day[@"weekday"] : @"";
    CGFloat labelW = ceil([weekday sizeWithAttributes:weekdayStyle].width);
    [weekday drawAtPoint:NSMakePoint(MAX(0, (width - labelW) / 2), 4) withAttributes:weekdayStyle];
    NSNumber *code = Finite(day[@"weatherCode"]);
    NSString *symbol = code ? WeatherCodeSymbol(code.integerValue, YES) : nil;
    NSImage *icon = symbol ? [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:WeatherCodeLabel(code.integerValue)] : nil;
    if (icon) {
        NSImageSymbolConfiguration *style = [[NSImageSymbolConfiguration configurationWithPointSize:14 weight:NSFontWeightRegular]
            configurationByApplyingConfiguration:SymbolInk()];
        icon = [icon imageWithSymbolConfiguration:style] ?: icon;
        [icon drawInRect:NSMakeRect((width - 16) / 2, 18, 16, 16)];
    }
    NSString *maxText = TempText(day[@"max"]), *minText = TempText(day[@"min"]);
    CGFloat maxW = ceil([maxText sizeWithAttributes:tempStyle].width);
    CGFloat minW = ceil([minText sizeWithAttributes:tempStyle].width);
    [maxText drawAtPoint:NSMakePoint(MAX(0, (width - maxW) / 2), 36) withAttributes:tempStyle];
    [minText drawAtPoint:NSMakePoint(MAX(0, (width - minW) / 2), 50) withAttributes:@{NSFontAttributeName: temp, NSForegroundColorAttributeName: NSColor.secondaryLabelColor}];
    NSNumber *rain = Finite(day[@"rainMm"]);
    if (rain && rain.doubleValue >= 1 && NSHeight(self.bounds) > 78) {
        NSString *rainText = rain.doubleValue < 10 ? [NSString stringWithFormat:@"%.1f", rain.doubleValue] : [NSString stringWithFormat:@"%.0f", round(rain.doubleValue)];
        NSDictionary *rainStyle = @{NSFontAttributeName: temp, NSForegroundColorAttributeName: NSColor.systemBlueColor};
        CGFloat rainW = ceil([rainText sizeWithAttributes:rainStyle].width);
        [rainText drawAtPoint:NSMakePoint(MAX(0, (width - rainW) / 2), 66) withAttributes:rainStyle];
    }
    if (NSHeight(self.bounds) > 72 && self.hasWeek)
        DrawTemperatureRange(NSMakeRect(8, NSHeight(self.bounds) - 10, MAX(4, width - 16), kRangeThickness), self.hasWeek, self.weekMin, self.weekMax, day[@"min"], day[@"max"]);
    [self drawFocusRing];
}
@end

@interface DayPlayheadMark : NSView
@end
@implementation DayPlayheadMark
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    CGFloat amount = .16;
    NSColor *paper = [NSColor.windowBackgroundColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    NSColor *accent = [NSColor.controlAccentColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    CGFloat pr = 1, pg = 1, pb = 1, ar = .2, ag = .45, ab = .95;
    if (paper) [paper getRed:&pr green:&pg blue:&pb alpha:NULL];
    if (accent) [accent getRed:&ar green:&ag blue:&ab alpha:NULL];
    [[NSColor colorWithSRGBRed:pr + (ar - pr) * amount green:pg + (ag - pg) * amount blue:pb + (ab - pb) * amount alpha:1] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 1, 1) xRadius:6 yRadius:6] fill];
}
@end

@interface DayTempDot : NSView
@end
@implementation DayTempDot
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect mark = NSInsetRect(self.bounds, 1, 1);
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:.95] setFill];
    [[NSBezierPath bezierPathWithOvalInRect:self.bounds] fill];
    [NSColor.labelColor setFill];
    [[NSBezierPath bezierPathWithOvalInRect:mark] fill];
}
@end

@implementation DayStripView {
    NSMutableArray<DayCell *> *_cells;
    NSTextField *_hourLine;
    DayPlayheadMark *_highlight;
    DayTempDot *_dot;
    double _weekMin, _weekMax;
    BOOL _hasWeek;
    NSInteger _highlightedDayIndex;
    double _playheadTemperature;
    NSInteger _hoverIndex;
    NSCalendar *_calendar;
}

- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    _selectedIndex = -1;
    _highlightedDayIndex = -1;
    _hoverIndex = -1;
    _playheadTemperature = NAN;
    _cells = [NSMutableArray array];
    self.accessibilityIdentifier = @"hub.days";
    self.accessibilityLabel = @"Seven day forecast";
    return self;
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
    _highlight.needsDisplay = YES;
    _dot.needsDisplay = YES;
}

- (NSInteger)highlightedDayIndex { return _highlightedDayIndex; }
- (double)playheadTemperature { return _playheadTemperature; }
- (NSInteger)hoverIndex { return _hoverIndex; }

- (void)setSeries:(NSArray<NSDictionary *> *)series {
    _series = [series copy] ?: @[];
    [self placePlayhead];
}

- (void)setPlayhead:(NSDate *)playhead {
    if (playhead == _playhead || [playhead isEqualToDate:_playhead]) return;
    _playhead = playhead;
    [self placePlayhead];
}

- (void)setDays:(NSArray<NSDictionary *> *)days {
    _days = [days copy] ?: @[];
    [self rebuild];
}

- (void)setHours:(NSArray<NSDictionary *> *)hours {
    _hours = [hours copy];
    [self rebuild];
}

- (void)setTimeZone:(NSTimeZone *)timeZone {
    _timeZone = timeZone;
    _calendar = nil;
    if (_cells.count || self.hours) [self rebuild];
}

- (NSCalendar *)dayCalendar {
    if (!_calendar) {
        _calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
        _calendar.timeZone = self.timeZone ?: [NSTimeZone timeZoneWithName:@"GMT"];
    }
    return _calendar;
}

- (void)setSelectedIndex:(NSInteger)selectedIndex {
    _selectedIndex = selectedIndex;
    for (NSUInteger i = 0; i < _cells.count; i++) {
        _cells[i].state = (NSInteger)i == selectedIndex ? NSControlStateValueOn : NSControlStateValueOff;
        [_cells[i] setNeedsDisplay:YES];
    }
    [self setNeedsDisplay:YES];
}

- (NSString *)accessibilityLabelForDay:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)self.days.count) return @"";
    NSDictionary *day = self.days[index];
    NSNumber *code = Finite(day[@"weatherCode"]);
    NSString *sky = code ? (WeatherCodeLabel(code.integerValue) ?: @"Forecast") : @"Forecast";
    NSMutableString *label = [NSMutableString stringWithFormat:@"%@, %@", day[@"weekday"] ?: @"Day", sky];
    if (Finite(day[@"max"])) [label appendFormat:@", maximum %.0f degrees", round([day[@"max"] doubleValue])];
    if (Finite(day[@"min"])) [label appendFormat:@", minimum %.0f degrees", round([day[@"min"] doubleValue])];
    NSNumber *rain = Finite(day[@"rainMm"]);
    if (rain && rain.doubleValue >= 1) [label appendFormat:@", %.1f millimetres of rain", rain.doubleValue];
    return label;
}

- (void)choose:(DayCell *)sender {
    self.selectedIndex = sender.tag;
    if (self.onSelect) self.onSelect(sender.tag);
}

- (void)keyDown:(NSEvent *)event {
    NSInteger next = self.selectedIndex;
    if (event.keyCode == 123) next = MAX(0, (next < 0 ? 0 : next) - 1);
    else if (event.keyCode == 124) next = MIN((NSInteger)self.days.count - 1, (next < 0 ? 0 : next) + 1);
    else if (event.keyCode == 36 || event.keyCode == 49) {
        if (next >= 0 && self.onSelect) self.onSelect(next);
        return;
    } else { [super keyDown:event]; return; }
    if (next >= 0 && next < (NSInteger)_cells.count) {
        self.selectedIndex = next;
        [self.window makeFirstResponder:_cells[next]];
        if (self.onSelect) self.onSelect(next);
    }
}

- (void)rebuild {
    for (NSView *cell in _cells) [cell removeFromSuperview];
    [_cells removeAllObjects];
    [_hourLine removeFromSuperview];
    _hourLine = nil;
    _weekMin = 0; _weekMax = 0; _hasWeek = NO;
    for (NSDictionary *day in self.days) {
        NSNumber *min = Finite(day[@"min"]), *max = Finite(day[@"max"]);
        if (!min && !max) continue;
        double lo = min ? min.doubleValue : max.doubleValue;
        double hi = max ? max.doubleValue : min.doubleValue;
        if (!_hasWeek) { _weekMin = lo; _weekMax = hi; _hasWeek = YES; }
        else { _weekMin = MIN(_weekMin, lo); _weekMax = MAX(_weekMax, hi); }
    }
    double weekMin = _weekMin, weekMax = _weekMax; BOOL hasWeek = _hasWeek;
    NSUInteger count = self.days.count;
    for (NSUInteger i = 0; i < count; i++) {
        DayCell *cell = [DayCell new];
        cell.bordered = NO;
        cell.title = @"";
        cell.day = self.days[i];
        cell.weekMin = weekMin;
        cell.weekMax = weekMax;
        cell.hasWeek = hasWeek;
        cell.tag = (NSInteger)i;
        cell.target = self;
        cell.action = @selector(choose:);
        cell.state = (NSInteger)i == self.selectedIndex ? NSControlStateValueOn : NSControlStateValueOff;
        cell.accessibilityIdentifier = [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)i];
        cell.accessibilityLabel = [self accessibilityLabelForDay:(NSInteger)i];
        if ([cell.cell isKindOfClass:NSButtonCell.class]) ((NSButtonCell *)cell.cell).highlightsBy = NSNoCellMask;
        [_cells addObject:cell];
        [self addSubview:cell];
    }
    if (self.hours) {
        NSMutableArray *parts = [NSMutableArray array];
        NSDateFormatter *clock = [NSDateFormatter new];
        clock.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
        clock.timeZone = self.timeZone ?: [NSTimeZone timeZoneWithName:@"GMT"];
        clock.dateFormat = @"ha";
        for (NSDictionary *hour in self.hours) {
            NSDate *time = [hour[@"time"] isKindOfClass:NSDate.class] ? hour[@"time"] : nil;
            if (!time || !Finite(hour[@"temp"])) continue;
            [parts addObject:[NSString stringWithFormat:@"%@ %@", [clock stringFromDate:time].lowercaseString, TempText(hour[@"temp"])]];
        }
        NSString *text = parts.count ? [parts componentsJoinedByString:@"   "] : @"Hourly forecast unavailable";
        _hourLine = [NSTextField labelWithString:text];
        _hourLine.translatesAutoresizingMaskIntoConstraints = YES;
        _hourLine.font = [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular];
        _hourLine.textColor = NSColor.secondaryLabelColor;
        _hourLine.lineBreakMode = NSLineBreakByTruncatingTail;
        _hourLine.accessibilityIdentifier = @"hub.hourly";
        _hourLine.accessibilityLabel = parts.count ? [NSString stringWithFormat:@"Hourly forecast, %@", text] : text;
        [self addSubview:_hourLine];
    }
    [self ensureChrome];
    [self layoutCells];
    if (_highlight) [self addSubview:_highlight positioned:NSWindowBelow relativeTo:nil];
    if (_dot) [self addSubview:_dot positioned:NSWindowAbove relativeTo:nil];
}

- (void)layout { [super layout]; [self layoutCells]; }

- (void)layoutCells {
    NSUInteger count = _cells.count;
    if (!count) return;
    BOOL detail = _hourLine != nil;
    BOOL vertical = NSHeight(self.bounds) > NSWidth(self.bounds) * 1.2;
    if (vertical) {
        CGFloat rowH = NSHeight(self.bounds) / count;
        for (NSUInteger i = 0; i < count; i++)
            _cells[i].frame = NSMakeRect(0, round(i * rowH), NSWidth(self.bounds), floor(rowH));
    } else {
        CGFloat rowH = detail ? MAX(36, NSHeight(self.bounds) - 22) : NSHeight(self.bounds);
        CGFloat width = NSWidth(self.bounds) / count;
        for (NSUInteger i = 0; i < count; i++)
            _cells[i].frame = NSMakeRect(round(i * width), 0, floor(width), rowH);
        if (_hourLine) _hourLine.frame = NSMakeRect(4, rowH, MAX(0, NSWidth(self.bounds) - 8), 18);
    }
    [self placePlayhead];
}

- (void)ensureChrome {
    if (!_highlight) {
        _highlight = [DayPlayheadMark new];
        _highlight.hidden = YES;
        _highlight.accessibilityElement = NO;
        [self addSubview:_highlight positioned:NSWindowBelow relativeTo:nil];
    }
    if (!_dot) {
        _dot = [DayTempDot new];
        _dot.hidden = YES;
        _dot.accessibilityElement = NO;
        _dot.accessibilityIdentifier = @"hub.playheadDot";
        [self addSubview:_dot positioned:NSWindowAbove relativeTo:nil];
    }
}

- (NSInteger)dayIndexForDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class]) return -1;
    NSCalendar *calendar = [self dayCalendar];
    for (NSInteger i = 0; i < (NSInteger)self.days.count; i++) {
        NSDate *day = [self.days[i][@"date"] isKindOfClass:NSDate.class] ? self.days[i][@"date"] : nil;
        if (day && [calendar isDate:date inSameDayAsDate:day]) return i;
    }
    return -1;
}

- (NSRect)dotFrameForCell:(DayCell *)cell temperature:(double)temp {
    if (!cell || !isfinite(temp) || !_hasWeek) return NSZeroRect;
    BOOL stacked = NSHeight(cell.bounds) > NSWidth(cell.bounds) * 1.2;
    NSRect track;
    if (stacked) {
        if (NSHeight(cell.bounds) <= 72) return NSZeroRect;
        track = NSMakeRect(8, NSHeight(cell.bounds) - 10, MAX(4, NSWidth(cell.bounds) - 16), kRangeThickness);
    } else {
        CGFloat barY = NSHeight(cell.bounds) - 8;
        if (barY < 34) return NSZeroRect;
        track = NSMakeRect(6, barY, MAX(4, NSWidth(cell.bounds) - 12), kRangeThickness);
    }
    CGFloat x = NSMinX(cell.frame) + TemperatureX(track, temp, _weekMin, _weekMax);
    CGFloat y = NSMinY(cell.frame) + NSMidY(track);
    return NSMakeRect(x - 3.5, y - 3.5, 7, 7);
}

- (void)placePlayhead {
    [self ensureChrome];
    NSInteger index = [self dayIndexForDate:_playhead];
    double temp = DayStripTemperatureAtDate(self.series, _playhead);
    BOOL dayChanged = index != _highlightedDayIndex;
    BOOL wasShown = !_highlight.hidden && _highlightedDayIndex >= 0;
    _highlightedDayIndex = index;
    _playheadTemperature = temp;
    if (index < 0 || index >= (NSInteger)_cells.count) {
        _highlight.hidden = YES;
        _dot.hidden = YES;
        return;
    }
    NSRect target = _cells[index].frame;
    static NSTimeInterval reduceChecked;
    static BOOL reduceMotion;
    NSTimeInterval reduceNow = NSProcessInfo.processInfo.systemUptime;
    if (reduceNow - reduceChecked > 0.5) {
        reduceChecked = reduceNow;
        reduceMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    }
    BOOL reduce = reduceMotion;
    BOOL slide = dayChanged && wasShown && self.window && !reduce;
    _highlight.hidden = NO;
    if (slide) {
        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
            context.duration = 0.35;
            context.allowsImplicitAnimation = YES;
            self->_highlight.animator.frame = target;
        } completionHandler:nil];
    } else if (dayChanged || !NSEqualRects(_highlight.frame, target)) {
        _highlight.frame = target;
    }
    NSRect dot = [self dotFrameForCell:_cells[index] temperature:temp];
    _dot.hidden = NSIsEmptyRect(dot);
    if (!_dot.hidden) _dot.frame = dot;
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
    NSTrackingArea *area = [[NSTrackingArea alloc] initWithRect:self.bounds
        options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect
        owner:self userInfo:nil];
    [self addTrackingArea:area];
}

- (NSInteger)dayIndexAtPoint:(NSPoint)point {
    for (NSUInteger i = 0; i < _cells.count; i++)
        if (NSPointInRect(point, _cells[i].frame)) return (NSInteger)i;
    return -1;
}

- (void)hoverAtPoint:(NSPoint)point {
    NSInteger index = [self dayIndexAtPoint:point];
    if (index == _hoverIndex) return;
    _hoverIndex = index;
    if (self.onHover) self.onHover(index);
    if (index >= 0) AnnouncePolite(self, [self accessibilityLabelForDay:index]);
}

- (void)mouseMoved:(NSEvent *)event {
    [self hoverAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
}

- (void)mouseEntered:(NSEvent *)event { [self mouseMoved:event]; }

- (void)mouseExited:(NSEvent *)event {
    (void)event;
    if (_hoverIndex < 0) return;
    _hoverIndex = -1;
    if (self.onHover) self.onHover(-1);
}

@end
