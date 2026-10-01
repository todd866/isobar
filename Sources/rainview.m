#import "rainview.h"
#import "playheadcursor.h"
#import <math.h>

static NSDate *RVDate(id value) { return [value isKindOfClass:NSDate.class] ? value : nil; }
static NSNumber *RVNumber(id value) {
    return [value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]) && [value doubleValue] >= 0 ? value : nil;
}
static void RVText(NSString *text, NSRect rect, CGFloat size, NSColor *colour, BOOL bold, NSTextAlignment align) {
    if (!text.length) return;
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
    style.alignment = align;
    style.lineBreakMode = NSLineBreakByTruncatingTail;
    [text drawInRect:rect withAttributes:@{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:size weight:bold ? NSFontWeightSemibold : NSFontWeightRegular],
        NSForegroundColorAttributeName: colour,
        NSParagraphStyleAttributeName: style
    }];
}
static void RVLine(NSPoint a, NSPoint b, NSColor *colour, CGFloat width, BOOL dashed) {
    NSBezierPath *path = [NSBezierPath bezierPath];
    path.lineWidth = width;
    if (dashed) { CGFloat dash[] = {3, 3}; [path setLineDash:dash count:2 phase:0]; }
    [colour setStroke]; [path moveToPoint:a]; [path lineToPoint:b]; [path stroke];
}

static void RVGap(CGFloat x0, CGFloat x1, CGFloat top, CGFloat height) {
    if (x1<=x0) return;
    [[NSColor.secondaryLabelColor colorWithAlphaComponent:.07] setFill];
    NSRectFillUsingOperation(NSMakeRect(x0,top,x1-x0,height),NSCompositingOperationSourceOver);
    if (x1-x0>=48) RVText(@"No data",NSMakeRect(x0,top+height*.45,x1-x0,16),10,NSColor.secondaryLabelColor,NO,NSTextAlignmentCenter);
}

@interface RainForecastView ()
@property(nonatomic, strong) NSDate *inspectedDate;
@property(nonatomic, strong) NSArray<NSDictionary *> *cachedHours;
@property(nonatomic, strong) NSDictionary<NSNumber *, NSDictionary *> *cachedHoursByStart;
@property(nonatomic, strong) NSDate *cachedStartDate;
@property(nonatomic, strong) NSDate *cachedEndDate;
@property(nonatomic, strong) NSImage *cachedGraphImage;
@property(nonatomic) NSSize cachedGraphSize;
@property(nonatomic) CGFloat cachedBackingScale;
// Kept private so offscreen QA can exercise Retina-sized rendering deterministically.
@property(nonatomic) CGFloat renderScaleOverride;
@property(nonatomic, copy) NSString *cachedAppearanceName;
@property(nonatomic, strong) NSDateFormatter *summaryFormatter;
@property(nonatomic, strong) NSCalendar *summaryCalendar;
@property(nonatomic, strong) NSView *playheadCursor;
- (void)invalidateRenderCache;
- (void)prepareCachedData;
- (void)rebuildTracking;
@end

@implementation RainForecastView

- (instancetype)initWithFrame:(NSRect)frame {
    if ((self = [super initWithFrame:frame])) {
        _outlook = @{};
        _horizonHours=24;
        _now = NSDate.date;
        _timeZone = [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    }
    return self;
}
- (void)invalidateRenderCache {
    self.cachedHours = nil;
    self.cachedHoursByStart = nil;
    self.cachedStartDate = nil;
    self.cachedEndDate = nil;
    self.cachedGraphImage = nil;
    self.cachedAppearanceName = nil;
    self.cachedGraphSize = NSZeroSize;
    self.cachedBackingScale = 0;
    self.summaryFormatter = nil;
    self.summaryCalendar = nil;
}
- (void)prepareCachedData {
    if (self.cachedHours && self.cachedStartDate && self.cachedEndDate) return;
    NSArray *source = [self.outlook[@"hours"] isKindOfClass:NSArray.class] ? self.outlook[@"hours"] : @[];
    NSMutableArray *valid = [NSMutableArray array];
    for (NSDictionary *hour in source) {
        if (![hour isKindOfClass:NSDictionary.class] || !RVDate(hour[@"start"]) || !RVDate(hour[@"end"])) continue;
        if ([hour[@"end"] compare:hour[@"start"]] != NSOrderedDescending) continue;
        [valid addObject:hour];
    }
    [valid sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"start"] compare:b[@"start"]];
    }];
    NSMutableDictionary *byStart = [NSMutableDictionary dictionaryWithCapacity:valid.count];
    for (NSDictionary *hour in valid) byStart[@([hour[@"start"] timeIntervalSinceReferenceDate])] = hour;
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = self.timeZone ?: NSTimeZone.localTimeZone;
    NSDate *start = nil;
    [calendar rangeOfUnit:NSCalendarUnitHour startDate:&start interval:NULL forDate:self.now ?: NSDate.date];
    self.cachedStartDate = start ?: self.now ?: NSDate.date;
    self.cachedEndDate = [self.cachedStartDate dateByAddingTimeInterval:self.horizonHours * 3600];
    self.cachedHours = valid.copy;
    self.cachedHoursByStart = byStart.copy;
}
- (void)setHorizonHours:(double)hours { _horizonHours=isfinite(hours)?MIN(120,MAX(6,hours)):24; [self invalidateRenderCache]; self.needsDisplay=YES; [self rebuildTracking]; }
- (void)setSelectedDate:(NSDate *)date {
    if (date != _selectedDate && ![date isEqualToDate:_selectedDate]) _selectedDate = date;
    [self placeCursor];
}
- (void)layout { [super layout]; [self placeCursor]; }
- (CGFloat)cursorXForDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class]) return NAN;
    if ([date compare:[self startDate]] == NSOrderedAscending || [date compare:[self endDate]] == NSOrderedDescending) return NAN;
    return [self xForDate:date];
}
- (void)placeCursor {
    CGFloat x = [self cursorXForDate:self.selectedDate];
    CGFloat top = 12, baseline = MAX(top + 20, NSHeight(self.bounds) - 25);
    PlaceVerticalCursor(self, &_playheadCursor, x, top, baseline - top);
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return YES; }
- (void)setOutlook:(NSDictionary *)outlook { _outlook = [outlook isKindOfClass:NSDictionary.class] ? [outlook copy] : @{}; [self invalidateRenderCache]; [self setNeedsDisplay:YES]; [self rebuildTracking]; }
- (void)setNow:(NSDate *)now { _now = now ?: NSDate.date; [self invalidateRenderCache]; [self setNeedsDisplay:YES]; [self rebuildTracking]; }
- (void)setTimeZone:(NSTimeZone *)timeZone { _timeZone = timeZone ?: NSTimeZone.localTimeZone; [self invalidateRenderCache]; [self setNeedsDisplay:YES]; [self rebuildTracking]; }
- (void)setReferenceNow:(NSDate *)referenceNow { _referenceNow = referenceNow; self.cachedGraphImage=nil; self.cachedAppearanceName=nil; [self setNeedsDisplay:YES]; }
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.cachedGraphImage=nil; self.cachedAppearanceName=nil; [self setNeedsDisplay:YES];
    [self placeCursor];
}
- (CGFloat)renderBackingScale {
    if (self.renderScaleOverride > 0) return self.renderScaleOverride;
    CGFloat scale = self.window ? self.window.backingScaleFactor : 1.0;
    if (self.layer && self.layer.contentsScale > 0) scale = self.layer.contentsScale;
    return MAX(1.0, scale);
}
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; self.cachedGraphImage=nil; self.cachedBackingScale=0; [self setNeedsDisplay:YES]; }
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; self.cachedGraphImage=nil; self.cachedBackingScale=0; [self setNeedsDisplay:YES]; }
- (NSString *)accessibilityRole { return NSAccessibilityImageRole; }
- (NSString *)accessibilityLabel { return @"Hourly rain forecast"; }
- (NSString *)accessibilityValue {
    if (self.inspectedDate) return [self summaryAtDate:self.inspectedDate];
    NSMutableArray *parts = [NSMutableArray array];
    for (NSDictionary *hour in [self hours]) if ([hour[@"start"] compare:[self endDate]] == NSOrderedAscending && [hour[@"end"] compare:[self startDate]] == NSOrderedDescending) {
        NSString *summary = [self summaryForHour:hour];
        if (summary.length) [parts addObject:summary];
    }
    return parts.count ? [parts componentsJoinedByString:@". "] : @"Rain forecast unavailable";
}

- (NSArray<NSDictionary *> *)hours {
    [self prepareCachedData];
    return self.cachedHours ?: @[];
}
- (NSDate *)startDate {
    [self prepareCachedData];
    return self.cachedStartDate ?: self.now ?: NSDate.date;
}
- (NSDate *)endDate { [self prepareCachedData]; return self.cachedEndDate ?: [[self startDate] dateByAddingTimeInterval:self.horizonHours * 3600]; }
- (CGFloat)leftInset { return 38; }
- (CGFloat)rightInset { return 8; }
- (CGFloat)xForDate:(NSDate *)date {
    NSTimeInterval span = [[self endDate] timeIntervalSinceDate:[self startDate]];
    CGFloat usable = NSWidth(self.bounds) - [self leftInset] - [self rightInset];
    CGFloat f = [date timeIntervalSinceDate:[self startDate]] / MAX(1, span);
    return [self leftInset] + usable * MIN(1, MAX(0, f));
}
- (NSDate *)dateForX:(CGFloat)x {
    CGFloat usable = MAX(1, NSWidth(self.bounds) - [self leftInset] - [self rightInset]);
    CGFloat f = MIN(1, MAX(0, (x - [self leftInset]) / usable));
    return [[self startDate] dateByAddingTimeInterval:MIN((self.horizonHours-1) * 3600, floor(f * self.horizonHours) * 3600)];
}
- (NSDictionary *)hourAtDate:(NSDate *)date {
    [self prepareCachedData];
    NSTimeInterval offset = [date timeIntervalSinceDate:self.cachedStartDate];
    if (offset >= 0) {
        NSDate *hourStart = [self.cachedStartDate dateByAddingTimeInterval:floor(offset / 3600.0) * 3600.0];
        NSDictionary *candidate = self.cachedHoursByStart[@([hourStart timeIntervalSinceReferenceDate])];
        if (candidate && [date compare:candidate[@"start"]] != NSOrderedAscending && [date compare:candidate[@"end"]] == NSOrderedAscending) return candidate;
    }
    for (NSDictionary *hour in [self hours]) {
        NSDate *start = hour[@"start"], *end = hour[@"end"];
        if ([date compare:start] != NSOrderedAscending && [date compare:end] == NSOrderedAscending) return hour;
    }
    return nil;
}
- (NSString *)summaryForHour:(NSDictionary *)hour {
    NSDate *start = RVDate(hour[@"start"]), *end = RVDate(hour[@"end"]);
    if (!start || !end) return nil;
    NSDateFormatter *formatter = self.summaryFormatter;
    if (!formatter) {
        formatter = [NSDateFormatter new];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
        formatter.timeZone = self.timeZone ?: NSTimeZone.localTimeZone;
        self.summaryFormatter = formatter;
    }
    NSCalendar *calendar = self.summaryCalendar;
    if (!calendar) {
        calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
        calendar.timeZone = self.timeZone ?: NSTimeZone.localTimeZone;
        self.summaryCalendar = calendar;
    }
    NSDateComponents *startParts = [calendar components:NSCalendarUnitDay|NSCalendarUnitHour fromDate:start];
    NSDateComponents *endParts = [calendar components:NSCalendarUnitDay|NSCalendarUnitHour fromDate:end];
    formatter.dateFormat = @"EEE h";
    NSString *time = [formatter stringFromDate:start];
    formatter.dateFormat = @"h a";
    NSString *endTime = [[formatter stringFromDate:end] lowercaseString];
    BOOL sameDay = startParts.day == endParts.day;
    BOOL sameHalf = (startParts.hour < 12) == (endParts.hour < 12);
    if (sameDay && sameHalf) time = [NSString stringWithFormat:@"%@–%@", time, endTime];
    else {
        formatter.dateFormat = @"EEE h a";
        time = [[formatter stringFromDate:start] stringByReplacingOccurrencesOfString:@"AM" withString:@"am"];
        time = [time stringByReplacingOccurrencesOfString:@"PM" withString:@"pm"];
        time = [NSString stringWithFormat:@"%@–%@", time, endTime];
    }
    if (![hour[@"known"] boolValue] || !RVNumber(hour[@"mm"])) return [NSString stringWithFormat:@"%@ · Forecast unavailable", time];
    NSNumber *amount = RVNumber(hour[@"mm"]);
    NSString *kind = [hour[@"kind"] isKindOfClass:NSString.class] && [hour[@"kind"] length] ? hour[@"kind"] : @"Rain";
    if (!amount) return [NSString stringWithFormat:@"%@ · %@", time, kind];
    NSString *amountText = amount.doubleValue < 0.1 && amount.doubleValue > 0 ? @"<0.1 mm" : [NSString stringWithFormat:@"%.1f mm", amount.doubleValue];
    return [NSString stringWithFormat:@"%@ · %@ · %@", time, kind, amountText];
}
- (NSString *)summaryAtDate:(NSDate *)date {
    if (!date || [date compare:[self startDate]] == NSOrderedAscending || [date compare:[self endDate]] != NSOrderedAscending) return nil;
    NSDictionary *hour = [self hourAtDate:date];
    return hour ? [self summaryForHour:hour] : nil;
}
- (void)inspectDate:(NSDate *)date {
    self.inspectedDate = date;
    if (self.onInspect) self.onInspect(date ? [self summaryAtDate:date] : nil);
    [self setNeedsDisplay:YES];
}
- (void)mouseMoved:(NSEvent *)event {
    NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
    [self inspectDate:(point.x >= [self leftInset] && point.x <= NSWidth(self.bounds) - [self rightInset]) ? [self dateForX:point.x] : nil];
}
- (void)mouseExited:(NSEvent *)event { (void)event; [self inspectDate:nil]; }
- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
    [self mouseMoved:event];
}
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode == 53) { [self inspectDate:nil]; return; }
    if (event.keyCode != 123 && event.keyCode != 124) { [super keyDown:event]; return; }
    NSDate *date = self.inspectedDate ?: [self startDate];
    date = [date dateByAddingTimeInterval:event.keyCode == 123 ? -3600 : 3600];
    if ([date compare:[self startDate]] == NSOrderedAscending) date = [self startDate];
    NSDate *last = [[self endDate] dateByAddingTimeInterval:-1];
    if ([date compare:last] == NSOrderedDescending) date = last;
    [self inspectDate:date];
}
- (void)rebuildTracking {
    for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
    if (!self.window) return;
    [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveAlways owner:self userInfo:nil]];
    [self removeAllToolTips];
    NSDate *start = [self startDate];
    for (NSInteger i = 0; i < self.horizonHours; i++) {
        CGFloat x0 = [self xForDate:[start dateByAddingTimeInterval:i * 3600]];
        CGFloat x1 = [self xForDate:[start dateByAddingTimeInterval:(i + 1) * 3600]];
        [self addToolTipRect:NSMakeRect(x0, 0, MAX(1, x1 - x0), NSHeight(self.bounds)) owner:self userData:NULL];
    }
}
- (void)updateTrackingAreas { [super updateTrackingAreas]; [self rebuildTracking]; }
- (NSString *)view:(NSView *)view stringForToolTip:(NSToolTipTag)tag point:(NSPoint)point userData:(void *)data {
    (void)view; (void)tag; (void)data;
    return [self summaryAtDate:[self dateForX:point.x]] ?: @"Forecast unavailable";
}

- (void)drawStaticGraph {
    CGFloat width = NSWidth(self.bounds), height = NSHeight(self.bounds);
    CGFloat left = [self leftInset], right = width - [self rightInset];
    CGFloat top = 12, baseline = MAX(top + 20, height - 25), plotHeight = MAX(12, baseline - top);
    NSColor *muted = NSColor.secondaryLabelColor, *blue = NSColor.systemBlueColor;
    NSColor *grid = [muted colorWithAlphaComponent:.16];
    [self prepareCachedData];
    NSArray *hours = self.cachedHours ?: @[];
    NSDate *graphStart = self.cachedStartDate ?: self.now ?: NSDate.date;
    NSDate *graphEnd = self.cachedEndDate ?: [graphStart dateByAddingTimeInterval:self.horizonHours * 3600];
    double maximum = .5;
    for (NSDictionary *hour in hours) if ([hour[@"known"] boolValue]) {
        NSDate *hourStart = RVDate(hour[@"start"]), *hourEnd = RVDate(hour[@"end"]);
        if (hourStart && hourEnd && [hourStart compare:graphEnd] == NSOrderedAscending && [hourEnd compare:graphStart] == NSOrderedDescending) {
            NSNumber *amount = RVNumber(hour[@"mm"]); if (amount) maximum = MAX(maximum, amount.doubleValue);
        }
    }
    if (maximum>2) maximum=ceil(maximum);
    else if (maximum>1) maximum=2;
    else if (maximum>.5) maximum=1;
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = self.timeZone ?: NSTimeZone.localTimeZone;
    NSInteger stride=MAX(3,(NSInteger)ceil(self.horizonHours/MAX(2,floor((right-left)/65))/3)*3);
    for (NSInteger i = 0; i <= self.horizonHours; i += stride) {
        NSDate *date = [graphStart dateByAddingTimeInterval:i * 3600];
        CGFloat x = [self xForDate:date];
        RVLine(NSMakePoint(x, top), NSMakePoint(x, baseline), grid, .6, NO);
        BOOL isNow=i==0 && fabs([date timeIntervalSinceDate:self.referenceNow ?: self.now])<3600;
        NSString *label = isNow ? @"Now" : [NSString stringWithFormat:@"%02ld:00", (long)[calendar component:NSCalendarUnitHour fromDate:date]];
        if (i > 0 && (self.horizonHours>36 || [calendar component:NSCalendarUnitHour fromDate:date] == 0)) {
            NSDateFormatter *day=[NSDateFormatter new]; day.timeZone=calendar.timeZone;
            day.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"]; day.dateFormat=self.horizonHours>36?@"EEE HH":@"EEE";
            label=[day stringFromDate:date];
        }
        RVText(label, NSMakeRect(MIN(right - 34, MAX(left - 18, x - 20)), baseline + 5, 42, 14), 11, muted, NO, NSTextAlignmentCenter);
    }
    RVLine(NSMakePoint(left, baseline), NSMakePoint(right, baseline), [blue colorWithAlphaComponent:.48], 1, NO);
    CGFloat mid = baseline - plotHeight * 0.5;
    if (maximum >= 2) RVLine(NSMakePoint(left, mid), NSMakePoint(right, mid), grid, .5, NO);
    RVText((maximum<1?[NSString stringWithFormat:@"%.1f",maximum]:[NSString stringWithFormat:@"%.0f",maximum]), NSMakeRect(0, top - 5, left - 7, 15), 11, muted, NO, NSTextAlignmentRight);
    RVText(@"mm/h", NSMakeRect(0, top + 9, left - 7, 15), 11, muted, NO, NSTextAlignmentRight);
    if (maximum >= 2) RVText(maximum < 10 ? [NSString stringWithFormat:@"%.1f", maximum * .5] : [NSString stringWithFormat:@"%.0f", maximum * .5], NSMakeRect(0, mid - 7, left - 7, 15), 11, muted, NO, NSTextAlignmentRight);
    CGFloat gapStart=NAN;
    for (NSInteger i = 0; i < self.horizonHours; i++) {
        NSDate *start = [graphStart dateByAddingTimeInterval:i * 3600];
        NSDate *end = [start dateByAddingTimeInterval:3600];
        NSDictionary *hour = self.cachedHoursByStart[@([start timeIntervalSinceReferenceDate])];
        if (hour && ([hour[@"start"] compare:start] != NSOrderedSame || [hour[@"end"] compare:end] != NSOrderedSame)) hour = nil;
        if (!hour) {
            // Forecast providers occasionally return wider or offset intervals.
            // Keep the old covering-interval behavior for those rows.
            for (NSDictionary *candidate in hours) {
                if ([candidate[@"start"] compare:start] != NSOrderedDescending && [candidate[@"end"] compare:end] != NSOrderedAscending) {
                    hour = candidate;
                    break;
                }
            }
        }
        CGFloat x0 = [self xForDate:start] + 1, x1 = [self xForDate:end] - 1, barWidth = MAX(1, x1 - x0);
        if (![hour[@"known"] boolValue] || !RVNumber(hour[@"mm"])) {
            if (!isfinite(gapStart)) gapStart=x0-1;
            continue;
        }
        if (isfinite(gapStart)) { RVGap(gapStart,x0-1,top,plotHeight); gapStart=NAN; }
        NSNumber *amount = RVNumber(hour[@"mm"]); if (!amount) continue;
        CGFloat barHeight = amount.doubleValue > 0 ? MAX(2, plotHeight * amount.doubleValue / maximum) : 0;
        if (barHeight > 0) {
            [[blue colorWithAlphaComponent:.78] setFill];
            NSRect barRect = NSMakeRect(x0, baseline - barHeight, barWidth, barHeight);
            CGFloat radius = MIN(4, MIN(NSWidth(barRect), NSHeight(barRect)) * .5);
            [[NSBezierPath bezierPathWithRoundedRect:barRect xRadius:radius yRadius:radius] fill];
            [[blue colorWithAlphaComponent:.18] setStroke];
            NSBezierPath *edge = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(barRect, .25, .25) xRadius:MAX(0, radius - .25) yRadius:MAX(0, radius - .25)];
            edge.lineWidth = .5;
            [edge stroke];
            if (barWidth >= 28) RVText(amount.doubleValue < 0.1 ? @"<0.1" : [NSString stringWithFormat:@"%.1f", amount.doubleValue], NSMakeRect(x0, baseline - barHeight - 16, barWidth, 14), 11, blue, YES, NSTextAlignmentCenter);
        }
    }
    if (isfinite(gapStart)) RVGap(gapStart,right,top,plotHeight);
}
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    if (NSWidth(self.bounds) <= 0 || NSHeight(self.bounds) <= 0) return;
    NSString *appearanceName = self.effectiveAppearance.name ?: @"";
    CGFloat backingScale = [self renderBackingScale];
    if (!self.cachedGraphImage || !NSEqualSizes(self.cachedGraphSize, self.bounds.size) || self.cachedBackingScale != backingScale || ![self.cachedAppearanceName isEqualToString:appearanceName]) {
        NSInteger pixelWidth = MAX(1, (NSInteger)ceil(NSWidth(self.bounds) * backingScale));
        NSInteger pixelHeight = MAX(1, (NSInteger)ceil(NSHeight(self.bounds) * backingScale));
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:pixelWidth pixelsHigh:pixelHeight bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bitmapFormat:NSBitmapFormatAlphaFirst bytesPerRow:0 bitsPerPixel:0];
        NSGraphicsContext *bitmapContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
        NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithCGContext:bitmapContext.CGContext flipped:YES];
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:context];
        // The bitmap starts bottom-left; the graph uses the view's top-left origin.
        // flipped:YES also keeps AppKit text upright in that transformed context.
        CGContextTranslateCTM(context.CGContext, 0, pixelHeight);
        CGContextScaleCTM(context.CGContext, backingScale, -backingScale);
        [self drawStaticGraph];
        [context flushGraphics];
        [NSGraphicsContext restoreGraphicsState];
        // Set the logical size only after drawing, otherwise AppKit adds a
        // second backing-scale transform to the bitmap context on Retina.
        [rep setSize:self.bounds.size];
        NSImage *image = [[NSImage alloc] initWithSize:self.bounds.size];
        [image addRepresentation:rep];
        self.cachedGraphImage = image;
        self.cachedGraphSize = self.bounds.size;
        self.cachedBackingScale = backingScale;
        self.cachedAppearanceName = appearanceName;
    }
    [self.cachedGraphImage drawInRect:self.bounds fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1.0 respectFlipped:YES hints:nil];
    CGFloat top = 12, baseline = MAX(top + 20, NSHeight(self.bounds) - 25);
    if (self.inspectedDate && [self summaryAtDate:self.inspectedDate]) RVLine(NSMakePoint([self xForDate:self.inspectedDate], top), NSMakePoint([self xForDate:self.inspectedDate], baseline), [NSColor.labelColor colorWithAlphaComponent:.7], 1, YES);
    [self placeCursor];
}
@end
