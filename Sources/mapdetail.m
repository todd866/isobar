#import "mapdetail.h"
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

@implementation TemperatureForecastView
- (BOOL)isFlipped { return YES; }
- (NSRect)plotRect { return NSMakeRect(34,18,MAX(1,NSWidth(self.bounds)-46),MAX(1,NSHeight(self.bounds)-42)); }
- (NSDate *)startDate { NSDate *date=self.now ?: NSDate.date; return [NSDate dateWithTimeIntervalSince1970:floor(date.timeIntervalSince1970/3600)*3600]; }
- (void)setSelectedDate:(NSDate *)date { _selectedDate=date; self.needsDisplay=YES; }
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
    NSDateFormatter *f=[NSDateFormatter new]; f.timeZone=self.timeZone ?: NSTimeZone.localTimeZone; f.dateFormat=@"EEE HH:mm";
    NSInteger labelStep = (NSWidth(plot) < 420 && horizon > 72) ? 18 : 12;
    for (int h=0; h<=ceil(horizon); h+=labelStep) {
        NSDate *date=[[self startDate] dateByAddingTimeInterval:h*3600]; NSString *text=[f stringFromDate:date]; CGFloat w=[text sizeWithAttributes:attrs].width;
        if (NSWidth(plot)<460) { f.dateFormat=@"EEE ha"; text=[f stringFromDate:date]; w=[text sizeWithAttributes:attrs].width; }
        [text drawAtPoint:NSMakePoint(MIN(NSMaxX(plot)-w,MAX(NSMinX(plot),x(date)-w/2)),NSMaxY(plot)+6) withAttributes:attrs];
    }
    if ([self.selectedDate isKindOfClass:NSDate.class] && [self.selectedDate timeIntervalSinceDate:start] >= 0 && [self.selectedDate timeIntervalSinceDate:start] <= horizon*3600) {
        CGFloat cursorX=x(self.selectedDate);
        [[[NSColor systemBlueColor] colorWithAlphaComponent:.55] setStroke];
        NSBezierPath *cursor=[NSBezierPath bezierPath]; cursor.lineWidth=1.5;
        [cursor moveToPoint:NSMakePoint(cursorX,NSMinY(plot))]; [cursor lineToPoint:NSMakePoint(cursorX,NSMaxY(plot))]; [cursor stroke];
    }
    NSColor *colour=NSColor.systemOrangeColor;
    for (NSArray *segment in segments) {
        NSBezierPath *line=[NSBezierPath bezierPath]; BOOL first=YES;
        for (NSDictionary *row in segment) { NSPoint p=NSMakePoint(x(row[@"time"]),y([row[@"temp"] doubleValue])); if(first)[line moveToPoint:p]; else [line lineToPoint:p]; first=NO; }
        [colour setStroke]; line.lineWidth=2.5; line.lineJoinStyle=NSLineJoinStyleRound; [line stroke];
        if (segment.count==1) { NSDictionary *row=segment[0]; [colour setFill]; [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x(row[@"time"])-2,y([row[@"temp"] doubleValue])-2,4,4)] fill]; }
    }
}
@end
