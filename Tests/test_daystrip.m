#import <Cocoa/Cocoa.h>
#import "../Sources/daystrip.h"

@interface DayStripView (FormattingChecks)
- (NSArray<NSDictionary *> *)displayRows;
@end

static int failures;
static void Check(BOOL ok, const char *message) { fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message); if (!ok) failures++; }
static void Pump(NSTimeInterval seconds) { NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds]; while ([end timeIntervalSinceNow]>0) [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:end]; }

static DayStripView *Strip(NSSize size) {
    DayStripView *strip=[[DayStripView alloc] initWithFrame:NSMakeRect(0,0,size.width,size.height)];
    NSDate *start=[NSDate dateWithTimeIntervalSince1970:100000];
    NSMutableArray *days=[NSMutableArray array];
    NSArray *names=@[@"Today",@"Fri",@"Sat",@"Sun",@"Mon",@"Tue",@"Wed"];
    for (NSUInteger i=0;i<names.count;i++) [days addObject:@{@"date":[start dateByAddingTimeInterval:i*86400], @"weekday":names[i], @"max":@(20+i), @"min":@(10+i), @"weatherCode":@3, @"rainMm":i==1?@1.7:@0}];
    strip.days=days; strip.timelineStart=start; strip.timelineEnd=[start dateByAddingTimeInterval:7*86400]; strip.playhead=start;
    return strip;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        DayStripView *strip=Strip(NSMakeSize(1280,34));
        Check(strip.days.count==7, "seven days are present");
        Check(strip.subviews.count==7, "seven accessible day elements have no range or dot subviews");
        Check([[strip accessibilityLabelForDay:1] containsString:@"millimetres of rain"], "rain unit is spoken only through accessibility");
        Check(![[strip accessibilityLabelForDay:2] containsString:@"millimetres"], "dry days do not announce zero rain");
        Check([strip accessibilityLabelForDay:1].length>0, "day accessibility label is present");

        NSMutableSet *levels=[NSMutableSet set];
        for (NSNumber *width in @[@1400,@850,@700,@560,@490,@455]) {
            strip.frame=NSMakeRect(0,0,width.doubleValue,34);
            NSArray *rows=[strip displayRows]; NSNumber *level=rows[0][@"level"];
            [levels addObject:level];
            BOOL consistent=YES, fits=YES, names=YES, detail=YES;
            for (NSDictionary *row in rows) {
                consistent &= [row[@"level"] isEqual:level];
                fits &= [row[@"width"] doubleValue]<=width.doubleValue/7;
                names &= [row[@"weekday"] length]==3;
                detail &= (level.intValue<1 || ![row[@"rain"] length]) && (level.intValue<2 || ![row[@"icon"] boolValue]) && (level.intValue<3 || ![row[@"temps"] containsString:@"°"]);
            }
            Check(consistent && detail, "all days share ordered rain/icon/degrees degradation");
            Check(names && fits, "three-letter weekdays and values fit every segment");
        }
        Check(levels.count==4, "width matrix exercises all four detail levels");
        strip.frame=NSMakeRect(0,0,758,34);
        NSArray *originalDays=strip.days;
        NSMutableArray *wetWeek=[NSMutableArray array];
        for (NSDictionary *day in originalDays) {
            NSMutableDictionary *wet=[day mutableCopy]; wet[@"rainMm"]=@1.7; [wetWeek addObject:wet];
        }
        strip.days=wetWeek;
        BOOL allRain=YES;
        for (NSDictionary *row in [strip displayRows]) allRain &= [row[@"rain"] isEqual:@"1.7"];
        Check(allRain, "normal popover width retains rain for every weekday without shrinking text");
        strip.days=originalDays;
        strip.frame=NSMakeRect(0,0,1280,34);

        NSDate *t0=[NSDate dateWithTimeIntervalSince1970:100000], *mid=[t0 dateByAddingTimeInterval:3600];
        NSArray *series=@[@{@"time":t0,@"temp":@10},@{@"time":[t0 dateByAddingTimeInterval:7200],@"temp":@20}];
        Check(fabs(DayStripTemperatureAtDate(series,mid)-15)<1e-6, "temperature interpolates between hours");
        Check(isnan(DayStripTemperatureAtDate(series,[t0 dateByAddingTimeInterval:-60])), "temperature stays missing outside the series");

        __block double preview=NAN, selected=NAN; __block NSInteger oldHover=-2, oldSelect=-2;
        strip.onPreviewFraction=^(double f){ preview=f; }; strip.onSelectFraction=^(double f){ selected=f; };
        strip.onHover=^(NSInteger i){ oldHover=i; }; strip.onSelect=^(NSInteger i){ oldSelect=i; };
        NSWindow *window=[[NSWindow alloc] initWithContentRect:strip.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO]; window.contentView=strip;
        NSPoint p=[strip convertPoint:NSMakePoint(640,30) toView:nil];
        NSEvent *move=[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:p modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:0 pressure:0];
        [strip mouseMoved:move]; Check(isnan(preview)&&oldHover==-2, "hover waits before previewing");
        Pump(.35); Check(fabs(preview-.5)<.01&&oldHover==-2, "hover previews the linear timeline after 300 ms");
        NSPoint next=[strip convertPoint:NSMakePoint(650,16) toView:nil];
        NSEvent *moveWithin=[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:next modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:3 clickCount:0 pressure:0];
        [strip mouseMoved:moveWithin]; Check(preview>.5, "armed hover follows motion inside the same day");
        [strip mouseExited:move]; Check(isnan(preview), "leaving cancels preview");
        NSEvent *down=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:p modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:1];
        [strip mouseDown:down]; Check(fabs(preview-.5)<.01&&isnan(selected)&&oldSelect==-2, "click holds fraction immediately without legacy seek");
        [strip mouseUp:down]; Check(isnan(preview), "release ends hold and lets shared clock resume");
        strip.playhead=[t0 dateByAddingTimeInterval:3*86400]; Check(strip.highlightedDayIndex==3, "playhead highlights the local day");
        [strip.subviews[1] accessibilityPerformPress];
        Check(strip.selectedIndex==1 && fabs(selected-1.5/7)<.001, "accessible day press selects local midday and records selected day");

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
        [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa" withIntermediateDirectories:YES attributes:nil error:NULL];
        for (NSNumber *width in @[@490,@560,@700,@1000]) for (NSString *look in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) {
            strip.frame=NSMakeRect(0,0,width.doubleValue,34);
            strip.appearance=[NSAppearance appearanceNamed:look];
            [strip layoutSubtreeIfNeeded];
            Check(NSWidth(strip.subviews.lastObject.frame)>0 && NSMaxX(strip.subviews.lastObject.frame)<=NSWidth(strip.bounds), "day accessibility geometry follows resize");
            NSBitmapImageRep *rep=[strip bitmapImageRepForCachingDisplayInRect:strip.bounds];
            [strip cacheDisplayInRect:strip.bounds toBitmapImageRep:rep];
            NSString *path=[NSString stringWithFormat:@"build/qa/mapfirst-days-%@-%@.png",width,[look isEqual:NSAppearanceNameAqua]?@"light":@"dark"];
            [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
        }

    }
    return failures ? 1 : 0;
}
