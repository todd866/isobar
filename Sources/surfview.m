#import "surfview.h"
#import "forecastview.h"
#import "pure.h"
#import <math.h>

static NSNumber *SFNumber(id v, BOOL positive) {
    if (![v isKindOfClass:NSNumber.class] || !isfinite([v doubleValue])) return nil;
    if (positive && [v doubleValue] < 0) return nil;
    return v;
}
static NSDate *SFDate(id value) {
    if (![value isKindOfClass:NSString.class] || ![(NSString *)value length]) return nil;
    NSString *s = [(NSString *)value hasSuffix:@"Z"] ? value : [value stringByAppendingString:@"Z"];
    NSISO8601DateFormatter *f = [NSISO8601DateFormatter new];
    f.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    NSDate *date=[f dateFromString:s];
    if (!date) { NSDateFormatter *fallback=[NSDateFormatter new]; fallback.locale=[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]; fallback.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0]; fallback.dateFormat=@"yyyy-MM-dd'T'HH:mm:ss'Z'"; date=[fallback dateFromString:s]; if (!date) { fallback.dateFormat=@"yyyy-MM-dd'T'HH:mm'Z'"; date=[fallback dateFromString:s]; } }
    return date;
}
static BOOL SFUnit(NSDictionary *units, NSString *key, NSArray<NSString *> *allowed) {
    id value = units[key];
    return [value isKindOfClass:NSString.class] && [allowed containsObject:value];
}

NSColor *SurfWindInk(void) { return NSColor.labelColor; }

NSDictionary *SurfOutlook(NSDictionary *product, NSDate *now) {
    NSDate *reference = now ?: NSDate.date;
    if (![product isKindOfClass:NSDictionary.class]) return @{
        @"rows": @[], @"status": @"unavailable", @"available": @NO,
        @"source": @"Open-Meteo", @"run": NSNull.null
    };
    NSDictionary *hourly = [product[@"hourly"] isKindOfClass:NSDictionary.class] ? product[@"hourly"] : nil;
    NSDictionary *units = [product[@"units"] isKindOfClass:NSDictionary.class] ? product[@"units"] : nil;
    NSArray *times = [product[@"time"] isKindOfClass:NSArray.class] ? product[@"time"] :
        ([hourly[@"time"] isKindOfClass:NSArray.class] ? hourly[@"time"] : @[]);
    BOOL unitsOK = units != nil;
    NSString *unitKeys[] = {@"wave_height", @"swell_wave_height", @"swell_wave_period", @"swell_wave_direction", @"sea_surface_temperature"};
    NSArray *unitValues[] = {@[ @"m" ], @[ @"m" ], @[ @"s" ], @[ @"°", @"degrees" ], @[ @"°C", @"C" ]};
    NSArray *fieldArrays[] = {hourly[@"wave_height"], hourly[@"swell_wave_height"], hourly[@"swell_wave_period"], hourly[@"swell_wave_direction"], hourly[@"sea_surface_temperature"]};
    for (NSUInteger j=0; j<5; j++) if (fieldArrays[j] && ![fieldArrays[j] isKindOfClass:NSArray.class]) fieldArrays[j]=nil;
    for (NSUInteger j=0; j<5; j++) if (fieldArrays[j] && !SFUnit(units,unitKeys[j],unitValues[j])) unitsOK=NO;
    NSMutableArray *rows = [NSMutableArray array];
    BOOL anyValue = NO;
    for (NSUInteger i=0; i<times.count; i++) {
        NSDate *date = SFDate(times[i]); if (!date) continue;
        NSMutableDictionary *row = [@{@"time":date} mutableCopy];
        NSArray * const *arrays = fieldArrays;
        NSString *keys[] = {@"waveHeight",@"swellHeight",@"swellPeriod",@"swellFrom",@"seaTemp"};
        BOOL has = NO;
        for (NSUInteger j=0; j<5; j++) if (i < arrays[j].count) {
            id value = arrays[j][i];
            NSNumber *n = SFNumber(value, j < 3);
            if (n && (j != 3 || (n.doubleValue >= 0 && n.doubleValue <= 360))) { row[keys[j]]=n; has=YES; anyValue=YES; }
        }
        (void)has;
        [rows addObject:row];
    }
    [rows sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"time"] compare:b[@"time"]]; }];
    NSDate *last = rows.count ? rows.lastObject[@"time"] : nil;
    if (!rows.count || !anyValue || !unitsOK) return @{
        @"rows":@[], @"status":@"unavailable", @"available":@NO,
        @"source": product[@"source"] ?: @"Open-Meteo", @"run": product[@"run"] ?: NSNull.null,
        @"unitsValid": @(unitsOK)
    };
    NSDate *runDate = SFDate(product[@"run"]);
    BOOL stale = (last && [reference timeIntervalSinceDate:last] >= 3600) ||
        (runDate && [reference timeIntervalSinceDate:runDate] > 36*3600);
    return @{
        @"rows": rows, @"status": stale ? @"stale" : @"available", @"available":@YES,
        @"stale":@(stale), @"source": product[@"source"] ?: @"Open-Meteo",
        @"run": product[@"run"] ?: NSNull.null, @"unitsValid":@(unitsOK), @"latest":last
    };
}

static CGFloat SFClamp(CGFloat n, CGFloat a, CGFloat b) { return MIN(b,MAX(a,n)); }
static NSString *SFTime(NSDate *date, NSTimeZone *zone, NSDate *now) {
    NSDateFormatter *f=[NSDateFormatter new]; f.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"]; f.timeZone=zone ?: NSTimeZone.localTimeZone;
    NSCalendar *c=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; c.timeZone=f.timeZone;
    f.dateFormat=([c isDate:date inSameDayAsDate:now ?: NSDate.date]) ? @"HH:mm" : @"EEE HH:mm";
    return [f stringFromDate:date];
}
static CGFloat SFX(NSDate *date, NSDate *start, NSRect plot, double horizon) { return NSMinX(plot)+NSWidth(plot)*SFClamp([date timeIntervalSinceDate:start]/(horizon*3600),0,1); }
static CGFloat SFWaveY(double h, NSRect lane, double max) { return NSMaxY(lane)-NSHeight(lane)*SFClamp(h/MAX(0.1,max),0,1); }

@implementation SurfForecastView
- (instancetype)initWithFrame:(NSRect)frame { if ((self=[super initWithFrame:frame])) { _outlook=@{}; _windRows=@[]; _timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"]; _horizonHours=48; } return self; }
- (BOOL)isFlipped { return YES; }
- (NSDate *)startDate {
    NSDate *date = self.now ?: [self.outlook[@"rows"] firstObject][@"time"] ?: NSDate.date;
    return [NSDate dateWithTimeIntervalSince1970:floor(date.timeIntervalSince1970/3600)*3600];
}
- (BOOL)isOpaque { return NO; }
- (BOOL)isAccessibilityElement { return YES; }
- (NSSize)intrinsicContentSize { return NSMakeSize(600,160); }
- (NSRect)plotRect { return NSMakeRect(34,12,MAX(1,NSWidth(self.bounds)-42),MAX(1,NSHeight(self.bounds)-30)); }
- (void)setOutlook:(NSDictionary *)v { _outlook=[v isKindOfClass:NSDictionary.class]?[v copy]:@{}; [self setNeedsDisplay:YES]; }
- (void)setWindRows:(NSArray *)v { _windRows=[v isKindOfClass:NSArray.class]?[v copy]:@[]; [self setNeedsDisplay:YES]; }
- (void)setSelectedDate:(NSDate *)date { _selectedDate=date; [self setNeedsDisplay:YES]; }
- (void)setHorizonHours:(double)hours { _horizonHours=(isfinite(hours)&&hours>0)?hours:48; [self setNeedsDisplay:YES]; }
- (NSString *)accessibilityRoleDescription { return @"surf forecast"; }
- (NSString *)accessibilityLabel { return [NSString stringWithFormat:@"%.0f hour surf forecast with wave height, swell direction, period and wind", self.horizonHours > 0 ? self.horizonHours : 48]; }
- (NSString *)summaryAtPoint:(NSPoint)point {
    NSRect p=[self plotRect]; if (!NSPointInRect(point,p)) return nil;
    NSArray *rows=self.outlook[@"rows"]; if (![rows isKindOfClass:NSArray.class]||!rows.count) return @"Surf forecast unavailable";
    NSDate *start=[self startDate]; double horizon=self.horizonHours>0?self.horizonHours:48; NSDate *date=[start dateByAddingTimeInterval:round(horizon*(point.x-NSMinX(p))/NSWidth(p))*3600]; NSDictionary *best=nil;
    for (NSDictionary *r in rows) if (fabs([r[@"time"] timeIntervalSinceDate:date])<1801) { best=r; break; }
    if (!best) return @"Surf forecast unavailable";
    NSMutableArray *parts=[NSMutableArray arrayWithObject:SFTime(best[@"time"],self.timeZone,self.now)];
    if (best[@"waveHeight"]) [parts addObject:[NSString stringWithFormat:@"Waves %.1f m",[best[@"waveHeight"] doubleValue]]];
    if (best[@"swellHeight"]) [parts addObject:[NSString stringWithFormat:@"Swell %.1f m",[best[@"swellHeight"] doubleValue]]];
    if (best[@"swellPeriod"]) [parts addObject:[NSString stringWithFormat:@"%.0f s",[best[@"swellPeriod"] doubleValue]]];
    if (best[@"swellFrom"]) [parts addObject:[NSString stringWithFormat:@"from %03.0f°",[best[@"swellFrom"] doubleValue]]];
    for (NSDictionary *wind in self.windRows) if ([wind[@"time"] isKindOfClass:NSDate.class] && fabs([wind[@"time"] timeIntervalSinceDate:best[@"time"]]) < 1801) {
        NSNumber *kt=wind[@"windKt"]; if ([kt isKindOfClass:NSNumber.class] && isfinite(kt.doubleValue) && kt.doubleValue >= 0) [parts addObject:[NSString stringWithFormat:@"Wind %.0f kt",kt.doubleValue]]; break;
    }
    if (best[@"seaTemp"]) [parts addObject:[NSString stringWithFormat:@"Sea %.0f°",[best[@"seaTemp"] doubleValue]]];
    return [parts componentsJoinedByString:@" · "];
}
- (void)updateTrackingAreas { [super updateTrackingAreas]; [self removeAllToolTips]; [self addToolTipRect:self.bounds owner:self userData:NULL]; }
- (NSString *)view:(NSView *)view stringForToolTip:(NSToolTipTag)tag point:(NSPoint)p userData:(void *)data { (void)view;(void)tag;(void)data; return [self summaryAtPoint:p] ?: @""; }
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSRect plot=[self plotRect];
    NSColor *muted=NSColor.secondaryLabelColor;
    NSDictionary *small=@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular],NSForegroundColorAttributeName:muted};
    NSArray *all=self.outlook[@"rows"];
    NSDate *start=[self startDate]; double horizon=self.horizonHours>0?self.horizonHours:48;
    NSMutableArray *rows=[NSMutableArray array];
    for (NSDictionary *row in all) {
        NSTimeInterval offset=[row[@"time"] timeIntervalSinceDate:start];
        if (offset>=0 && offset<=horizon*3600) [rows addObject:row];
    }
    if (!rows.count) {
        NSString *message=[self.outlook[@"stale"] boolValue]?@"Surf forecast expired":@"Surf forecast unavailable";
        [message drawAtPoint:NSMakePoint(NSMinX(plot),NSMidY(plot)-7) withAttributes:small];
        return;
    }
    NSRect waves=NSMakeRect(NSMinX(plot),24,NSWidth(plot),MAX(20,NSHeight(self.bounds)-94));
    CGFloat windY=NSMaxY(waves)+22;
    CGFloat timeY=NSHeight(self.bounds)-16;
    double peak=1;
    for (NSDictionary *row in rows) for (NSString *key in @[@"waveHeight",@"swellHeight"])
        if (row[key]) peak=MAX(peak,ceil([row[key] doubleValue]));
    NSBezierPath *grid=[NSBezierPath bezierPath]; grid.lineWidth=.5;
    for (NSInteger i=0;i<=2;i++) {
        CGFloat y=NSMinY(waves)+i*NSHeight(waves)/2;
        [grid moveToPoint:NSMakePoint(NSMinX(waves),y)];
        [grid lineToPoint:NSMakePoint(NSMaxX(waves),y)];
        [[NSString stringWithFormat:@"%.1f",peak*(1-i/2.0)] drawAtPoint:NSMakePoint(1,y-6) withAttributes:small];
    }
    [[muted colorWithAlphaComponent:.2] setStroke]; [grid stroke];
    [@"m" drawAtPoint:NSMakePoint(4,1) withAttributes:small];
    NSDictionary *first=rows.firstObject;
    NSDictionary *headline=first;
    if ([self.selectedDate isKindOfClass:NSDate.class]) {
        for (NSDictionary *candidate in rows) if ([candidate[@"time"] isKindOfClass:NSDate.class] && fabs([candidate[@"time"] timeIntervalSinceDate:self.selectedDate]) < 1801) { headline=candidate; break; }
    }
    NSString *period=headline[@"swellPeriod"]?[NSString stringWithFormat:@" · %.0f s",[headline[@"swellPeriod"] doubleValue]]:@"";
    NSString *waveTitle=headline[@"waveHeight"]?[NSString stringWithFormat:@"Waves %.1f",[headline[@"waveHeight"] doubleValue]]:@"Waves";
    NSString *swellTitle=headline[@"swellHeight"]?[NSString stringWithFormat:@"Swell %.1f%@",[headline[@"swellHeight"] doubleValue],period]:@"Swell";
    [waveTitle drawAtPoint:NSMakePoint(NSMinX(plot),1) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium],NSForegroundColorAttributeName:NSColor.systemBlueColor}];
    [swellTitle drawAtPoint:NSMakePoint(NSMinX(plot)+110,1) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium],NSForegroundColorAttributeName:NSColor.systemTealColor}];
    NSString *right=[self.outlook[@"stale"] boolValue]?@"Model stale":(headline[@"seaTemp"]?[NSString stringWithFormat:@"Sea %.0f°",[headline[@"seaTemp"] doubleValue]]:@"");
    [right drawAtPoint:NSMakePoint(NSMaxX(plot)-[right sizeWithAttributes:small].width,1) withAttributes:small];
    [NSGraphicsContext saveGraphicsState];
    NSRectClip(NSInsetRect(waves,-1,-4));
    for (NSString *key in @[@"waveHeight",@"swellHeight"]) {
        NSBezierPath *line=[NSBezierPath bezierPath]; BOOL linked=NO; NSDate *last=nil;
        for (NSDictionary *row in rows) {
            NSNumber *value=row[key]; NSDate *time=row[@"time"];
            if (!value) { linked=NO; last=nil; continue; }
            NSPoint point=NSMakePoint(SFX(time,start,plot,horizon),SFWaveY(value.doubleValue,waves,peak));
            if (!linked || [time timeIntervalSinceDate:last]>5400) [line moveToPoint:point];
            else [line lineToPoint:point];
            linked=YES; last=time;
        }
        [[key isEqual:@"waveHeight"]?NSColor.systemBlueColor:NSColor.systemTealColor setStroke];
        line.lineWidth=2; [line stroke];
    }
    CGFloat previous=-1000;
    for (NSDictionary *row in rows) {
        NSNumber *from=row[@"swellFrom"], *height=row[@"swellHeight"];
        CGFloat x=SFX(row[@"time"],start,plot,horizon);
        if (!from || !height || x-previous<40) continue;
        previous=x;
        NSPoint centre=NSMakePoint(SFClamp(x,NSMinX(plot)+8,NSMaxX(plot)-8),SFWaveY(height.doubleValue,waves,peak));
        [NSColor.systemTealColor setFill]; [KiteWindArrowPath(centre,from.doubleValue,14) fill];
    }
    [NSGraphicsContext restoreGraphicsState];
    [@"kt" drawAtPoint:NSMakePoint(1,windY-6) withAttributes:small];
    previous=-1000;
    for (NSDictionary *row in self.windRows) {
        NSDate *date=row[@"time"]; NSNumber *speed=SFNumber(row[@"windKt"],YES);
        if (![date isKindOfClass:NSDate.class] || !speed) continue;
        NSTimeInterval offset=[date timeIntervalSinceDate:start];
        CGFloat x=SFX(date,start,plot,horizon);
        if (offset<0 || offset>horizon*3600 || x-previous<44) continue;
        previous=x; x=SFClamp(x,NSMinX(plot)+9,NSMaxX(plot)-9);
        NSNumber *from=SFNumber(row[@"windFrom"],YES);
        [SurfWindInk() setFill];
        if (speed.doubleValue<.5) {
            [muted setStroke]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x-3,windY-3,6,6)] stroke];
        } else if (from && from.doubleValue<=360) [KiteWindArrowPath(NSMakePoint(x,windY),from.doubleValue,16) fill];
        else [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x-2,windY-2,4,4)] fill];
        NSString *label=[NSString stringWithFormat:@"%.0f",speed.doubleValue];
        [label drawAtPoint:NSMakePoint(x-[label sizeWithAttributes:small].width/2,windY+10) withAttributes:small];
    }
    NSInteger spacing=NSWidth(plot)<420?18:12;
    for (NSInteger h=0;h<=ceil(horizon);h+=spacing) {
        NSDate *date=[start dateByAddingTimeInterval:h*3600];
        NSString *text=SFTime(date,self.timeZone,self.now);
        CGFloat textWidth=[text sizeWithAttributes:small].width;
        CGFloat x=SFClamp(SFX(date,start,plot,horizon)-textWidth/2,NSMinX(plot),NSMaxX(plot)-textWidth);
        [text drawAtPoint:NSMakePoint(x,timeY) withAttributes:small];
    }
    if ([self.selectedDate isKindOfClass:NSDate.class] && [self.selectedDate timeIntervalSinceDate:start] >= 0 && [self.selectedDate timeIntervalSinceDate:start] <= horizon*3600) {
        CGFloat x=SFX(self.selectedDate,start,plot,horizon);
        [[[NSColor systemBlueColor] colorWithAlphaComponent:.55] setStroke];
        NSBezierPath *cursor=[NSBezierPath bezierPath]; cursor.lineWidth=1.5;
        [cursor moveToPoint:NSMakePoint(x,NSMinY(plot))]; [cursor lineToPoint:NSMakePoint(x,NSMaxY(plot))]; [cursor stroke];
    }
}

@end
