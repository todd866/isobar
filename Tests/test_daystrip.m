// The day strip's range is a hairline and a temperature gradient. Offscreen.
#import <Cocoa/Cocoa.h>
#import "../Sources/daystrip.h"

static int failures;
static void Check(BOOL ok, const char *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message);
    if (!ok) failures++;
}
static void Pump(NSTimeInterval seconds) {
    NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while ([end timeIntervalSinceNow] > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:end];
}

@interface StripBackdrop : NSView
@end
@implementation StripBackdrop
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [NSColor.windowBackgroundColor setFill];
    NSRectFill(self.bounds);
}
@end

static double Luma(NSColor *c) {
    return .2126 * c.redComponent + .7152 * c.greenComponent + .0722 * c.blueComponent;
}

static BOOL Cool(NSColor *c) { return c.blueComponent > .55 && c.blueComponent > c.redComponent + .08; }
static BOOL Warm(NSColor *c) { return c.redComponent > .7 && c.redComponent > c.blueComponent + .25; }

// Draw a two-day strip offscreen in one appearance and read its range bar,
// track and icons back from the pixels.
static void CheckStripAppearance(NSAppearanceName name, const char *label, CGFloat width, CGFloat height) {
    StripBackdrop *backdrop = [[StripBackdrop alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
    backdrop.appearance = [NSAppearance appearanceNamed:name];
    DayStripView *strip = [[DayStripView alloc] initWithFrame:backdrop.bounds];
    strip.days = @[
        @{@"weekday": @"Today", @"max": @12, @"min": @8, @"weatherCode": @3},
        @{@"weekday": @"Fri", @"max": @32, @"min": @28, @"weatherCode": @3, @"rainMm": @3},
    ];
    [backdrop addSubview:strip];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:backdrop.frame
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.appearance = backdrop.appearance;
    window.contentView = backdrop;
    [backdrop layoutSubtreeIfNeeded];
    [backdrop display];
    NSBitmapImageRep *rep = [backdrop bitmapImageRepForCachingDisplayInRect:backdrop.bounds];
    [backdrop cacheDisplayInRect:backdrop.bounds toBitmapImageRep:rep];
    NSInteger wide = (NSInteger)rep.pixelsWide, high = MIN((NSInteger)rep.pixelsHigh, 512);
    double scale = (double)wide / NSWidth(backdrop.bounds);
    NSColor *(^at)(NSInteger, NSInteger) = ^NSColor *(NSInteger x, NSInteger y) {
        return [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    };
    // The second cell is not highlighted, so its background is the paper.
    NSInteger cellX0 = wide / 2 + (NSInteger)(8 * scale), cellX1 = wide - (NSInteger)(8 * scale);
    double paperLuma = Luma(at((cellX0 + cellX1) / 2, 2));
    NSInteger bar = -1, best = 0;
    for (NSInteger y = 0; y < high; y++) {
        NSInteger cool = 0, warm = 0;
        for (NSInteger x = 0; x < wide; x++) {
            NSColor *color = at(x, y);
            if (Cool(color)) cool++;
            if (Warm(color)) warm++;
        }
        if (MIN(cool, warm) > best) { best = MIN(cool, warm); bar = y; }
    }
    double coolX = 0, warmX = 0, trackContrast = 0;
    NSInteger coolN = 0, warmN = 0, trackN = 0, trackRows = 0;
    for (NSInteger y = MAX(0, bar - (NSInteger)(4 * scale)); bar >= 0 && y <= MIN(high - 1, bar + (NSInteger)(4 * scale)); y++) {
        NSInteger rowTrack = 0;
        for (NSInteger x = 0; x < wide; x++) {
            NSColor *color = at(x, y);
            BOOL cool = Cool(color), warm = Warm(color);
            if (y == bar && cool) { coolX += x; coolN++; }
            if (y == bar && warm) { warmX += x; warmN++; }
            if (x < cellX0 || x > cellX1) continue;
            double hi = MAX(color.redComponent, MAX(color.greenComponent, color.blueComponent));
            double lo = MIN(color.redComponent, MIN(color.greenComponent, color.blueComponent));
            double contrast = fabs(Luma(color) - paperLuma);
            if (cool || warm || hi - lo > .12 || contrast < .02) continue;
            rowTrack++;
            if (y == bar) { trackN++; trackContrast = MAX(trackContrast, contrast); }
        }
        if (rowTrack > 20) trackRows++;
    }
    // The icon sits between the weekday and the temperatures, 12–28 pt down.
    NSInteger iconInk = 0;
    for (NSInteger y = (NSInteger)(12 * scale); y < (NSInteger)(28 * scale); y++)
        for (NSInteger x = cellX0; x < cellX1; x++)
            if (fabs(Luma(at(x, y)) - paperLuma) > .35) iconInk++;
    fprintf(stderr, "%s day strip cool %ld warm %ld track %ld contrast %.2f rows %ld (scale %.0f) icon %ld\n", label,
        (long)coolN, (long)warmN, (long)trackN, trackContrast, (long)trackRows, scale, (long)iconInk);
    char message[160];
    snprintf(message, sizeof message, "%s: the range runs cool to warm", label);
    Check(coolN > 4 && warmN > 4 && coolX / coolN < warmX / warmN, message);
    snprintf(message, sizeof message, "%s: the track is a low-contrast hairline about 3 pt thick", label);
    Check(trackN > 12 && trackContrast < .2 && trackRows >= 2 * scale && trackRows <= 4 * scale, message);
    snprintf(message, sizeof message, "%s: weather icons stand out from the strip", label);
    Check(iconInk > 20 * scale * scale, message);
    Check([[strip accessibilityLabelForDay:0] containsString:@"Today"], "today stays labelled");
    BOOL rainUnit = NO;
    for (NSView *cell in strip.subviews)
        if ([cell respondsToSelector:NSSelectorFromString(@"rainText")] &&
            [[cell valueForKey:@"rainText"] isEqual:@"3.0 mm"]) rainUnit = YES;
    Check(rainUnit, "drawn day rain includes mm");
    Check([[strip accessibilityLabelForDay:1] containsString:@"millimetres of rain"], "spoken day rain includes its unit");
    (void)window;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        CheckStripAppearance(NSAppearanceNameAqua, "light", 320, 64);
        CheckStripAppearance(NSAppearanceNameAqua, "compact light", 160, 52);
        CheckStripAppearance(NSAppearanceNameDarkAqua, "dark", 320, 64);
        CheckStripAppearance(NSAppearanceNameDarkAqua, "compact dark", 160, 52);

        NSDate *t0 = [NSDate dateWithTimeIntervalSince1970:100000];
        NSDate *mid = [t0 dateByAddingTimeInterval:3600];
        NSArray *series = @[
            @{@"time": t0, @"temp": @10, @"windDir": @"SW", @"windKt": @14, @"weatherCode": @2},
            @{@"time": [t0 dateByAddingTimeInterval:7200], @"temp": @20, @"windDir": @"SW", @"windKt": @14},
        ];
        double sample = DayStripTemperatureAtDate(series, mid);
        Check(fabs(sample - 15) < 1e-6, "temperature is the midpoint between hours");
        Check(isnan(DayStripTemperatureAtDate(series, [t0 dateByAddingTimeInterval:-60])),
            "temperature stays missing outside the series");
        Check(DayStripSampleAtDate(series, mid, 90 * 60) == series[0] ||
              [DayStripSampleAtDate(series, mid, 90 * 60)[@"temp"] isEqual:@10] ||
              [DayStripSampleAtDate(series, mid, 90 * 60)[@"temp"] isEqual:@20],
            "a nearby hour supplies the icon and wind");

        NSTimeZone *sydney = [NSTimeZone timeZoneWithName:@"Australia/Sydney"];
        NSTimeZone *perth = [NSTimeZone timeZoneWithName:@"Australia/Perth"];
        NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
        NSDate *(^day)(NSTimeZone *, NSInteger, NSInteger, NSInteger) = ^NSDate *(NSTimeZone *zone, NSInteger year, NSInteger month, NSInteger d) {
            NSDateComponents *parts = [NSDateComponents new];
            parts.timeZone = zone; parts.year = year; parts.month = month; parts.day = d;
            return [calendar dateFromComponents:parts];
        };
        NSDate *oct3 = day(sydney, 2026, 10, 3);
        NSDate *oct4 = day(sydney, 2026, 10, 4);
        NSDate *oct5 = day(sydney, 2026, 10, 5);
        calendar.timeZone = sydney;
        NSDate *late = [calendar dateBySettingHour:23 minute:30 second:0 ofDate:oct3 options:0];
        NSDate *early = [calendar dateBySettingHour:0 minute:30 second:0 ofDate:oct4 options:0];
        NSDate *jumped = [calendar dateBySettingHour:3 minute:30 second:0 ofDate:oct4 options:0];
        DayStripView *logic = [[DayStripView alloc] initWithFrame:NSMakeRect(0, 0, 700, 64)];
        logic.timeZone = sydney;
        logic.days = @[
            @{@"date": oct3, @"weekday": @"Sat", @"min": @12, @"max": @22},
            @{@"date": oct4, @"weekday": @"Sun", @"min": @13, @"max": @24},
            @{@"date": oct5, @"weekday": @"Mon", @"min": @14, @"max": @21},
        ];
        logic.series = series;
        NSWindow *logicWindow = [[NSWindow alloc] initWithContentRect:logic.frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        logicWindow.contentView = logic;
        NSView *kept = nil;
        for (NSView *sub in logic.subviews)
            if ([sub.accessibilityIdentifier isEqual:@"hub.day.0"]) kept = sub;
        logic.playhead = late;
        Check(logic.highlightedDayIndex == 0, "23:30 stays on the day before the clock change");
        logic.playhead = early;
        Check(logic.highlightedDayIndex == 1, "00:30 is the new local day, before clocks jump");
        logic.playhead = jumped;
        Check(logic.highlightedDayIndex == 1, "03:30 after the jump is still that day");
        NSView *again = nil;
        for (NSView *sub in logic.subviews)
            if ([sub.accessibilityIdentifier isEqual:@"hub.day.0"]) again = sub;
        Check(kept && kept == again, "moving the playhead does not rebuild the day cells");
        DayStripView *west = [[DayStripView alloc] initWithFrame:logic.frame];
        west.timeZone = perth;
        west.days = @[
            @{@"date": day(perth, 2026, 10, 3), @"weekday": @"Sat", @"min": @12, @"max": @22},
            @{@"date": day(perth, 2026, 10, 4), @"weekday": @"Sun", @"min": @13, @"max": @24},
        ];
        west.playhead = early;
        Check(west.highlightedDayIndex == 0, "the same instant is the previous day in Perth");
        __block NSInteger hovered = -2;
        logic.onHover = ^(NSInteger index) { hovered = index; };
        NSView *second = nil;
        for (NSView *sub in logic.subviews)
            if ([sub.accessibilityIdentifier isEqual:@"hub.day.1"]) second = sub;
        NSPoint where = [logic convertPoint:NSMakePoint(NSMidX(second.frame), NSMidY(second.frame)) toView:nil];
        NSEvent *moved = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:where
            modifierFlags:0 timestamp:0 windowNumber:logicWindow.windowNumber context:nil
            eventNumber:1 clickCount:0 pressure:0];
        [logic mouseMoved:moved];
        Check(hovered == -2 && logic.hoverIndex == -1, "a fast day hover does not change the shared time");
        Pump(.35);
        Check(hovered == 1 && logic.hoverIndex == 1, "a stationary day hover reports that day");
        [logic mouseExited:moved];
        Check(hovered == -1 && logic.hoverIndex == -1, "leaving the strip clears the hover");
        logic.series = @[
            @{@"time": late, @"temp": @10},
            @{@"time": [late dateByAddingTimeInterval:6 * 3600], @"temp": @20},
        ];
        logic.playhead = late;
        NSView *dot = nil;
        for (NSView *sub in logic.subviews)
            if ([sub.accessibilityIdentifier isEqual:@"hub.playheadDot"]) dot = sub;
        CGFloat coolXDot = NSMidX(dot.frame);
        logic.playhead = [late dateByAddingTimeInterval:6 * 3600];
        Check(fabs(logic.playheadTemperature - 20) < 1e-6 && NSMidX(dot.frame) > coolXDot + 2,
            "the dot sits on the hourly temperature and slides as it rises");
    }
    return failures ? 1 : 0;
}
