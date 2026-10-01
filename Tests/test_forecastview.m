#import <Cocoa/Cocoa.h>
#import "../Sources/forecastview.h"

static int failures;

static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static BOOL Near(CGFloat a, CGFloat b, CGFloat tolerance) {
    return fabs(a - b) <= tolerance;
}

static NSPoint FirstPoint(NSBezierPath *path) {
    NSPoint points[3] = { NSZeroPoint, NSZeroPoint, NSZeroPoint };
    [path elementAtIndex:0 associatedPoints:points];
    return points[0];
}

static NSInteger PathElementCount(NSBezierPath *path) {
    NSInteger count = 0;
    for (NSInteger i = 0; i < path.elementCount; i++) {
        if ([path elementAtIndex:i] == NSBezierPathElementClosePath) continue;
        count++;
    }
    return count;
}

static NSArray<NSDictionary *> *SyntheticWindRows(NSDate *start) {
    NSArray<NSNumber *> *hours = @[ @3, @12, @21, @30, @39 ];
    NSArray<NSNumber *> *speeds = @[ @0, @10, @15, @22, @18 ];
    NSArray<NSNumber *> *directions = @[ @0, @90, @180, @270, @45 ];
    NSMutableArray *rows = [NSMutableArray array];
    for (NSUInteger i = 0; i < hours.count; i++) {
        NSDate *time = [start dateByAddingTimeInterval:hours[i].doubleValue * 3600];
        [rows addObject:@{
            @"time": time,
            @"windKt": speeds[i],
            @"gustKt": @(speeds[i].doubleValue + 3),
            @"windFrom": directions[i],
            @"isDay": @YES,
        }];
    }
    return rows;
}

@interface ForecastTestBackdrop : NSView
@end
@implementation ForecastTestBackdrop
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)rect {
    (void)rect;
    BOOL dark=[[self.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]] isEqual:NSAppearanceNameDarkAqua];
    [[NSColor colorWithWhite:dark?.1:1 alpha:1] setFill];
    NSRectFill(self.bounds);
}
@end

static NSBitmapImageRep *RenderedView(HourlyForecastView *view) {
    [view setFrameSize:view.frame.size];
    [view layoutSubtreeIfNeeded];
    ForecastTestBackdrop *host=[[ForecastTestBackdrop alloc] initWithFrame:view.bounds];
    host.appearance=view.appearance;
    [host addSubview:view];
    NSBitmapImageRep *rep = [host bitmapImageRepForCachingDisplayInRect:host.bounds];
    [view.effectiveAppearance performAsCurrentDrawingAppearance:^{
        [host cacheDisplayInRect:host.bounds toBitmapImageRep:rep];
    }];
    [view removeFromSuperview];
    return rep;
}

static BOOL IsStrongArrowColour(NSColor *color) {
    NSColor *rgb = [color colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    if (!rgb || rgb.alphaComponent < 0.7) return NO;
    CGFloat r = rgb.redComponent, g = rgb.greenComponent, b = rgb.blueComponent;
    return (r > 0.65 && g < 0.55 && b < 0.45) ||
           (r > 0.65 && g > 0.55 && b < 0.3) ||
           (g > 0.45 && g > r * 1.1 && g > b * 1.1);
}

static NSRect StrongColourBoundsInRect(NSBitmapImageRep *rep, NSSize size, NSRect region) {
    NSRect bounds = NSZeroRect;
    BOOL found = NO;
    for (NSInteger y = 0; y < rep.pixelsHigh; y++) {
        for (NSInteger x = 0; x < rep.pixelsWide; x++) {
            if (!NSPointInRect(NSMakePoint((x+.5)*size.width/rep.pixelsWide,(y+.5)*size.height/rep.pixelsHigh),region)) continue;
            NSColor *color = [rep colorAtX:x y:y];
            if (!IsStrongArrowColour(color)) continue;
            if (!found) { bounds = NSMakeRect(x, y, 1, 1); found = YES; }
            else bounds = NSUnionRect(bounds, NSMakeRect(x, y, 1, 1));
        }
    }
    CGFloat sx=size.width/rep.pixelsWide, sy=size.height/rep.pixelsHigh;
    return found ? NSMakeRect(bounds.origin.x*sx,bounds.origin.y*sy,bounds.size.width*sx,bounds.size.height*sy) : NSZeroRect;
}

static NSRect StrongColourBounds(NSBitmapImageRep *rep, NSSize size) {
    return StrongColourBoundsInRect(rep,size,(NSRect){NSZeroPoint,size});
}

static void Capture(HourlyForecastView *view, NSString *name) {
    const char *output = getenv("ISOBAR_TEST_SHOTS");
    if (!output) return;
    NSBitmapImageRep *rep = RenderedView(view);
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *path = [[NSString stringWithUTF8String:output] stringByAppendingPathComponent:name];
    Check([png writeToFile:path atomically:YES], [NSString stringWithFormat:@"write %@", name]);
}

static void TestArrowGeometry(void) {
    NSPoint centre = NSMakePoint(80, 80);
    struct { double from; NSPoint expected; } cases[] = {
        { 0,   NSMakePoint(80, 94) },
        { 90,  NSMakePoint(66, 80) },
        { 180, NSMakePoint(80, 66) },
        { 270, NSMakePoint(94, 80) },
        { 45,  NSMakePoint(70, 90) },
    };
    for (NSUInteger i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        NSBezierPath *path = KiteWindArrowPath(centre, cases[i].from, 28);
        NSPoint tip = path ? FirstPoint(path) : NSZeroPoint;
        Check(path != nil && Near(tip.x, cases[i].expected.x, 0.5) && Near(tip.y, cases[i].expected.y, 0.5),
              [NSString stringWithFormat:@"arrow %.0f° points downwind", cases[i].from]);
        Check(PathElementCount(path) >= 6, [NSString stringWithFormat:@"arrow %.0f° has a shaft and head polygon", cases[i].from]);
    }
    Check(KiteWindArrowPath(centre, NAN, 14) == nil &&
          KiteWindArrowPath(centre, 90, NAN) == nil &&
          KiteWindArrowPath(centre, 90, -2) == nil,
          @"invalid arrow input produces no path");

    NSColor *under = [KiteWindSpeedColour(14, 15, 30) colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    NSColor *inside = [KiteWindSpeedColour(20, 15, 30) colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    NSColor *over = [KiteWindSpeedColour(35, 15, 30) colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    Check(under && under.redComponent > under.blueComponent && under.greenComponent > 0.3 &&
          inside && inside.greenComponent > inside.redComponent &&
          over && over.redComponent > over.greenComponent &&
          over.greenComponent < inside.greenComponent,
          @"kite colours follow the saved band: amber under, green inside, red over");
}

static HourlyForecastView *Forecast(NSSize size, NSString *appearance) {
    HourlyForecastView *view=[[HourlyForecastView alloc] initWithFrame:(NSRect){NSZeroPoint,size}];
    view.now=[NSDate dateWithTimeIntervalSince1970:1790467200];
    view.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0];
    view.appearance=[NSAppearance appearanceNamed:appearance];
    return view;
}

static NSDictionary *Wind(HourlyForecastView *view, NSInteger hour, double speed, id direction) {
    return @{ @"time":[view.now dateByAddingTimeInterval:hour*3600], @"windKt":@(speed),
        @"windFrom":direction ?: NSNull.null, @"isDay":@YES };
}

static void TestRenderedForecast(void) {
    for (NSString *appearance in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) {
        for (NSNumber *width in @[@956,@420]) {
            HourlyForecastView *view=Forecast(NSMakeSize(width.doubleValue,132),appearance);
            NSRect plot=view.windPlotRect;
            NSBitmapImageRep *background=RenderedView(view);
            NSColor *band=[[background colorAtX:(NSInteger)((NSMinX(plot)+10)*background.pixelsWide/NSWidth(view.bounds))
                y:(NSInteger)((NSMinY(plot)+4)*background.pixelsHigh/NSHeight(view.bounds))] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
            Check(band.alphaComponent>.99 && ([appearance isEqual:NSAppearanceNameAqua] ? band.redComponent>.85 : band.greenComponent<.3),
                @"wind range is a faint tint over the chart background");
            Check(NSMinX(plot)>12 && NSWidth(view.bounds)-NSMaxX(plot)>12 && NSMinY(plot)>12,
                @"plot reserves room for endpoint arrows");
            for (NSNumber *from in @[@0,@90,@180,@270]) {
                view.windRows=@[Wind(view,24,18,from)];
                NSBitmapImageRep *rep=RenderedView(view);
                NSRect b=StrongColourBounds(rep,view.bounds.size);
                BOOL vertical=(from.intValue%180)==0;
                CGFloat along=vertical?b.size.height:b.size.width;
                CGFloat across=vertical?b.size.width:b.size.height;
                Check(along>=17 && along<=26 && across>=7 && across<=14,
                    [NSString stringWithFormat:@"%@ %@pt %.0f° renders a full arrow",appearance,width,from.doubleValue]);
                NSPoint anchor=NSMakePoint(NSMidX(plot),NSMaxY(plot)-NSHeight(plot)*.6);
                // Independently inspect the painted head versus shaft on the downwind side.
                double dx=from.intValue==90?-1:(from.intValue==270?1:0);
                double dy=from.intValue==0?1:(from.intValue==180?-1:0);
                NSInteger head=0,tail=0;
                for (NSInteger y=0;y<rep.pixelsHigh;y++) for (NSInteger x=0;x<rep.pixelsWide;x++) {
                    if (!IsStrongArrowColour([rep colorAtX:x y:y])) continue;
                    double px=(x+.5)*NSWidth(view.bounds)/rep.pixelsWide-anchor.x;
                    double py=(y+.5)*NSHeight(view.bounds)/rep.pixelsHigh-anchor.y;
                    double forward=px*dx+py*dy;
                    if (forward>.5 && forward<4.5) head++;
                    if (forward<-.5 && forward>-4.5) tail++;
                }
                Check(tail>0 && head>tail*1.2,@"painted head points downwind and shaft remains visible");
            }
            // Both extreme hours, low and high speeds must remain visible, not clipped.
            view.windRows=@[Wind(view,0,30,@180),Wind(view,48,.5,@0)];
            NSRect b=StrongColourBounds(RenderedView(view),view.bounds.size);
            Check(NSMinX(b)>=1 && NSMaxX(b)<NSWidth(view.bounds)-1 && NSMinY(b)>=1 &&
                NSMaxY(b)<NSHeight(view.bounds)-35,@"endpoint arrows fit above the rain strip");
            view.windRows=SyntheticWindRows(view.now);
            view.rainRows=@[@{@"time":[view.now dateByAddingTimeInterval:13*3600],@"rainMm":@.4}];
            Capture(view,[NSString stringWithFormat:@"kite-%@-%@.png",width,appearance]);
            NSString *summary=[view summaryAtPoint:NSMakePoint(NSMinX(plot)+NSWidth(plot)*.25,NSMidY(plot))];
            Check([summary containsString:@"Wind 10 kt from 090° · gusts 13"] &&
                [summary containsString:@"0.4 mm"],@"hover uses matching wind and preceding-hour rain interval");
            summary=[view summaryAtPoint:NSMakePoint(NSMinX(plot)+NSWidth(plot)*12.75/48,NSHeight(view.bounds)-25)];
            Check([summary containsString:@"Rain 12:00–13:00 0.4 mm"],@"right half of a rain bar keeps its own interval");
            Check([view summaryAtPoint:NSMakePoint(2,NSMidY(plot))]==nil,@"hover outside time plot is empty");

            view.rainRows=@[];
            view.windRows=@[Wind(view,24,18,NSNull.null)];
            b=StrongColourBounds(RenderedView(view),view.bounds.size);
            Check(b.size.width>1 && b.size.width<=5 && b.size.height<=5,@"missing direction is a small dot, never an arrow");
            view.windRows=@[@{@"time":[view.now dateByAddingTimeInterval:24*3600],@"windKt":@18,@"windDir":@"SSE"}];
            b=StrongColourBounds(RenderedView(view),view.bounds.size);
            Check(b.size.height>=16,@"compass-only wind paints an arrow");
            for (NSNumber *speed in @[@-1,@(NAN)]) {
                view.windRows=@[Wind(view,24,speed.doubleValue,@0)];
                Check(NSIsEmptyRect(StrongColourBounds(RenderedView(view),view.bounds.size)),@"invalid wind speed paints no arrow");
                Check([view summaryAtPoint:NSMakePoint(NSMidX(plot),NSMidY(plot))]==nil,@"invalid wind has no invented tooltip");
            }
            // Calm adds a neutral hollow circle; compare against an empty chart.
            view.windRows=@[];
            NSBitmapImageRep *empty=RenderedView(view);
            view.windRows=@[Wind(view,24,0,@90)];
            NSBitmapImageRep *calm=RenderedView(view);
            NSInteger changed=0,escaped=0;
            for (NSInteger y=0;y<calm.pixelsHigh;y++) for (NSInteger x=0;x<calm.pixelsWide;x++) {
                NSColor *a=[[empty colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
                NSColor *c=[[calm colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
                if (fabs(a.redComponent-c.redComponent)+fabs(a.greenComponent-c.greenComponent)+
                    fabs(a.blueComponent-c.blueComponent)+fabs(a.alphaComponent-c.alphaComponent)<.3) continue;
                changed++;
                CGFloat px=(x+.5)*NSWidth(view.bounds)/calm.pixelsWide;
                CGFloat py=(y+.5)*NSHeight(view.bounds)/calm.pixelsHigh;
                if (hypot(px-NSMidX(plot),py-NSMaxY(plot))>4.5) escaped++;
            }
            Check(changed>8 && escaped==0 && NSIsEmptyRect(StrongColourBounds(calm,view.bounds.size)),
                @"calm paints only a small neutral circle");
            Check([[view summaryAtPoint:NSMakePoint(NSMidX(plot),NSMidY(plot))] containsString:@"Calm"],
                @"calm hover replaces the previous reading");
        }
    }
}

static void TestDensityAndColours(void) {
    HourlyForecastView *view=Forecast(NSMakeSize(420,132),NSAppearanceNameAqua);
    NSRect plot=view.windPlotRect;
    view.windRows=@[Wind(view,1,10,@0),Wind(view,2,10,@0),Wind(view,4,15,@0),Wind(view,7,22,@0)];
    NSBitmapImageRep *rep=RenderedView(view);
    NSArray *hours=@[@1,@2,@4,@7], *speeds=@[@10,@10,@15,@22];
    for (NSUInteger i=0;i<hours.count;i++) {
        NSPoint anchor=NSMakePoint(NSMinX(plot)+NSWidth(plot)*[hours[i] doubleValue]/48,
            NSMaxY(plot)-NSHeight(plot)*[speeds[i] doubleValue]/30);
        NSRect bounds=StrongColourBoundsInRect(rep,view.bounds.size,NSMakeRect(anchor.x-3,anchor.y-13,6,26));
        Check(i==1 ? bounds.size.height<=5 : bounds.size.height>=17,
            i==1?@"crowded hours retain a dot":@"sparse off-grid hours keep full direction arrows");
        NSColor *colour=[[rep colorAtX:(NSInteger)(anchor.x*rep.pixelsWide/NSWidth(view.bounds))
            y:(NSInteger)(anchor.y*rep.pixelsHigh/NSHeight(view.bounds))] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
        BOOL amber=colour.redComponent>.8 && colour.greenComponent>.5 && colour.blueComponent<.3;
        BOOL green=colour.greenComponent>.6 && colour.redComponent<.5;
        // The saved kite band is 15–30 kt. Under it is amber; inside it is green.
        Check([speeds[i] doubleValue] < view.minKt ? amber : green, @"painted wind mark uses the expected strength colour");
    }
    Capture(view,@"kite-sparse.png");
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        TestArrowGeometry();
        TestRenderedForecast();
        TestDensityAndColours();
    }
    return failures ? 1 : 0;
}
