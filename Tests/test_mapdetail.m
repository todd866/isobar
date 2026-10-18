#import <Cocoa/Cocoa.h>
#import "mapdetail.h"
static int failures;
static void Check(BOOL ok, NSString *why) { if(!ok){fprintf(stderr,"FAIL %s\n",why.UTF8String);failures++;} }
int main(void) { @autoreleasepool {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(314,234)],
        [NSValue valueWithSize:NSMakeSize(640,400)],[NSValue valueWithSize:NSMakeSize(1024,600)]]) {
        NSRect bounds = {NSZeroPoint,size.sizeValue};
        NSRect timeline = NSMakeRect(10,NSHeight(bounds)-50,NSWidth(bounds)-20,40);
        NSRect header = NSMakeRect(10,10,MIN(360,NSWidth(bounds)-20),40);
        NSArray *reserved = @[[NSValue valueWithRect:timeline],[NSValue valueWithRect:header]];
        NSRect old = NSMakeRect(8,NSHeight(bounds)-90,MIN(304,NSWidth(bounds)-16),82);
        Check(NSIntersectsRect(old,timeline), @"regression fixture reproduces the old card covering the timeline");
        NSRect placed = MapPointCardRect(bounds,old,NSZeroRect,reserved);
        Check(NSContainsRect(bounds,placed) && NSHeight(placed)==82 &&
            !NSIntersectsRect(placed,NSInsetRect(timeline,-8,-8)) && !NSIntersectsRect(placed,NSInsetRect(header,-8,-8)),
            @"point card clears floating header and timeline at narrow, popover and expanded sizes");
        Check(NSEqualRects(placed,MapPointCardRect(bounds,placed,NSZeroRect,reserved)),
            @"forecast ticks preserve an unobstructed card position");
    }
    NSRect mapBounds = NSMakeRect(0,0,640,400), initial = NSMakeRect(8,310,304,82);
    NSRect point = NSMakeRect(145,340,14,14);
    NSRect moved = MapPointCardRect(mapBounds,initial,point,@[]);
    Check(!NSIntersectsRect(moved,NSInsetRect(point,-8,-8)) && NSContainsRect(mapBounds,moved),
        @"selected point is exposed by moving the card within the viewport");
    Check(NSEqualRects(moved,MapPointCardRect(mapBounds,moved,NSMakeRect(-100,-100,14,14),@[])),
        @"panning the point offscreen does not snap the card back");
    NSRect tiny = NSMakeRect(0,0,100,60);
    Check(NSContainsRect(tiny,MapPointCardRect(tiny,moved,point,@[])), @"undersized viewport keeps the card within bounds");
    MapPointCard *card = [[MapPointCard alloc] initWithFrame:NSMakeRect(0,0,304,82)];
    card.sample = @{@"title":@"Point",@"temperature":@0,@"direction":@230,@"wind":@12,@"pressure":@1013};
    Check([card.accessibilityLabel containsString:@"230/12 kt"] && [card.accessibilityLabel containsString:@"0.0 °C"], @"point wind is direction then speed; zero is real");
    card.sample = @{@"title":@"Point",@"temperature":NSNull.null,@"direction":@(NAN),@"wind":@YES,@"pressure":NSNull.null};
    Check([card.accessibilityLabel containsString:@"—/— kt"] && [card.accessibilityLabel containsString:@"MSLP — hPa"], @"point missing and invalid readings stay missing");
    for (id rain in @[@0, @12.3, NSNull.null, @(NAN), @YES, @-1]) {
        card.sample = @{@"title":@"33.90°S  151.20°E", @"temperature":@18.5,
            @"direction":@230, @"wind":@12, @"pressure":@1013, @"rain24h":rain};
        NSString *expected = [rain isEqual:@0] ? @"Rain 24h 0.0 mm" :
            [rain isEqual:@12.3] ? @"Rain 24h 12.3 mm" : @"Rain 24h — mm";
        Check([card.accessibilityLabel containsString:expected], @"rain distinguishes dry, wet and invalid samples");
        Check([card.accessibilityLabel containsString:@"ending at map time"], @"rain window is accessible");
        if ([rain isEqual:@12.3]) for (NSNumber *dark in @[@NO,@YES]) {
            card.dark = dark.boolValue;
            card.appearance = [NSAppearance appearanceNamed:card.dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
            NSBitmapImageRep *rep = [card bitmapImageRepForCachingDisplayInRect:card.bounds];
            [card cacheDisplayInRect:card.bounds toBitmapImageRep:rep];
            [NSFileManager.defaultManager createDirectoryAtPath:@"build/qa" withIntermediateDirectories:YES attributes:nil error:nil];
            NSString *path = [NSString stringWithFormat:@"build/qa/native-parity-point-rain-%@.png",card.dark ? @"dark" : @"light"];
            Check([[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES], @"point card offscreen capture saved");
        }
    }
    NSDictionary *font = @{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:13 weight:NSFontWeightMedium]};
    Check([@"MSLP 1060 hPa" sizeWithAttributes:font].width + [@"Rain 24h 999.9 mm" sizeWithAttributes:font].width + 30 <= 298,
        @"pressure and heavy rain retain a gap in a 314 pt map's 298 pt card");
    __block BOOL closed = NO; card.onClose = ^{ closed = YES; };
    [card.closeButton performClick:nil]; Check(closed, @"rain card retains native close action");
    NSDate *start=[NSDate dateWithTimeIntervalSince1970:1800000000];
    NSDictionary *(^row)(double,id)=^NSDictionary *(double h,id v){return @{@"time":[start dateByAddingTimeInterval:h*3600],@"temp":v};};
    NSArray *rows=@[row(0,@-5),row(1,@0),row(2,NSNull.null),row(3,@5),row(5,@8),row(6,@YES),row(60,@50)];
    Check([MapDetailSample(rows,[start dateByAddingTimeInterval:1800])[@"temp"] isEqual:@-5],@"half-hour sample has bounded tie handling");
    Check(!MapDetailSample(rows,[start dateByAddingTimeInterval:9*3600]),@"missing future sample never reuses now");
    Check(!MapDetailSample(@[@{@"time":@"bad"}],start),@"invalid date skipped");
    TemperatureForecastView *view=[[TemperatureForecastView alloc] initWithFrame:NSMakeRect(0,0,420,136)];
    view.now=start; view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"]; view.rows=rows;
    NSArray *segments=[view segments];
    Check(segments.count==3 && [segments[0] count]==2 && [segments[1] count]==1 && [segments[2] count]==1,@"gap and null split temperature line; boolean and offscreen samples excluded");
    view.horizonHours=72;
    Check([view segments].count==4 && [[view accessibilityLabel] containsString:@"72 hour"],@"temperature horizon extends the plotted window and accessibility label");
    for (NSString *appearance in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) {
        view.appearance=[NSAppearance appearanceNamed:appearance];
        NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds]; [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
        Check(rep.pixelsWide>0,@"offscreen temperature render");
    }
    view.rows=@[row(0,@0),row(1,@0)];
    NSRect plot=[view plotRect];
    Check([[view summaryAtPoint:NSMakePoint(NSMinX(plot)+NSWidth(plot)/48,NSMidY(plot))] containsString:@"0.0°C"],@"zero Celsius is a valid reading");
    view.rows=@[row(0,@(NAN))]; Check([view segments].count==0,@"NaN remains unavailable");
    view.rows=@[row(0,@18),row(24,@19),row(48,@20),row(72,@21),row(96,@22)];
    view.horizonHours=120;
    view.frame=NSMakeRect(0,0,900,136);
    NSArray *wide=[view dayLabels];
    view.frame=NSMakeRect(0,0,180,136);
    NSArray *narrow=[view dayLabels];
    BOOL spaced=YES, weekdays=YES;
    CGFloat previous=-1e9;
    for (NSDictionary *label in wide) {
        NSString *text=label[@"text"];
        if (text.length<2 || [text containsString:@" "] ||
            [text rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet].location!=NSNotFound) weekdays=NO;
        CGFloat x=[label[@"x"] doubleValue], w=[label[@"width"] doubleValue];
        if (previous>-1e8 && x<previous+8) spaced=NO;
        previous=x+w;
    }
    previous=-1e9;
    for (NSDictionary *label in narrow) {
        CGFloat x=[label[@"x"] doubleValue], w=[label[@"width"] doubleValue];
        if (previous>-1e8 && x<previous+8) spaced=NO;
        previous=x+w;
    }
    Check(weekdays && wide.count>=3 && narrow.count>=1 && narrow.count<wide.count && spaced,
        [NSString stringWithFormat:@"noon labels skip when closer than the label plus 8 px (wide %lu narrow %lu)",
            (unsigned long)wide.count,(unsigned long)narrow.count]);
    for (NSNumber *height in @[@150,@175,@234,@400]) {
        NSRect bounds=NSMakeRect(0,0,314,height.doubleValue), card=MapDetailsRect(5,bounds);
        Check(!NSIsEmptyRect(card) && NSContainsRect(bounds,card),@"all five layer readings fit the smallest supported chart");
    }
    fprintf(stderr,"map detail failures: %d\n",failures);
    return failures?1:0;
} }
