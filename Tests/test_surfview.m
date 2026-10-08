#import <Cocoa/Cocoa.h>
#import "../Sources/surfview.h"

@interface SurfForecastView (LensCardTests)
- (BOOL)marineReadingIsDimmed;
@end
@interface SurfPaintProbe : SurfForecastView
@property(nonatomic) NSUInteger invalidations;
@end
@implementation SurfPaintProbe
- (void)setNeedsDisplay:(BOOL)flag { if(flag) self.invalidations++; [super setNeedsDisplay:flag]; }
@end
static int failures;
static void Check(BOOL ok, NSString *message) { fprintf(stderr,"%s %s\n",ok?"ok  ":"FAIL",message.UTF8String); if(!ok) failures++; }
static NSDate *Date(NSString *s) { return [[NSISO8601DateFormatter new] dateFromString:[s hasSuffix:@"Z"]?s:[s stringByAppendingString:@"Z"]]; }
static NSDictionary *Product(void) {
    return @{@"id":@"surf-test",@"run":@"2026-09-27T00:00",
      @"time":@[@"2026-09-27T00:00",@"2026-09-27T01:00",@"2026-09-27T02:00"],
      @"units":@{@"wave_height":@"m",@"swell_wave_height":@"m",@"swell_wave_period":@"s",@"swell_wave_direction":@"°",@"sea_surface_temperature":@"°C"},
      @"hourly":@{
        @"wave_height":@[@1.2,@1.4,@1.0],@"swell_wave_height":@[@.8,[NSNull null],@1.1],
        @"swell_wave_period":@[@12,@13,@14],@"swell_wave_direction":@[@0,@90,@360],
        @"sea_surface_temperature":@[@19,@19,@20]}};
}
static NSBitmapImageRep *Render(SurfForecastView *view) {
    NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view.effectiveAppearance performAsCurrentDrawingAppearance:^{ [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep]; }];
    return rep;
}
static void Capture(SurfForecastView *view, NSString *name) {
    const char *root=getenv("ISOBAR_SURF_QA"); if (!root) return;
    NSData *png=[Render(view) representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *path=[[NSString stringWithUTF8String:root] stringByAppendingPathComponent:name];
    Check([png writeToFile:path atomically:YES],[NSString stringWithFormat:@"write %@",name]);
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSDate *now=Date(@"2026-09-27T00:30:00Z"); NSDictionary *out=SurfOutlook(Product(),now);
        Check([out[@"status"] isEqual:@"available"] && [out[@"rows"] count]==3,@"normal product keeps all valid timestamps");
        Check([out[@"rows"][0][@"time"] timeIntervalSinceDate:Date(@"2026-09-27T00:00:00Z")]==0,@"UTC timestamps parse without local-time drift");
        Check(!out[@"rows"][1][@"swellHeight"] && [out[@"rows"][2][@"swellFrom"] doubleValue]==360,@"null remains missing and zero/360 directions remain valid");
        Check([out[@"rows"][2][@"seaTemp"] doubleValue]==20,@"sea temperature is retained as a finite value");
        NSMutableDictionary *negativeTemp=[Product() mutableCopy]; negativeTemp[@"hourly"]=[negativeTemp[@"hourly"] mutableCopy]; negativeTemp[@"hourly"][@"sea_surface_temperature"]=@[@-2,@-1,@0];
        Check([SurfOutlook(negativeTemp,now)[@"rows"][0][@"seaTemp"] doubleValue]==-2,@"negative sea temperature is retained");
        NSMutableDictionary *nullField=[Product() mutableCopy]; nullField[@"hourly"]=[nullField[@"hourly"] mutableCopy]; nullField[@"hourly"][@"wave_height"]=[NSNull null];
        NSDictionary *nullFieldOut=SurfOutlook(nullField,now);
        Check([nullFieldOut[@"status"] isEqual:@"available"] && !nullFieldOut[@"rows"][0][@"waveHeight"],@"a whole null field is ignored without crashing");
        NSMutableDictionary *missingTime=[Product() mutableCopy]; missingTime[@"time"]=@[@"2026-09-27T00:00",@"not-a-time",@"2026-09-27T02:00"];
        NSDictionary *missingTimeOut=SurfOutlook(missingTime,now);
        Check([missingTimeOut[@"rows"] count]==2,@"invalid timestamp is dropped without inventing a time");
        NSMutableDictionary *bad=[Product() mutableCopy]; bad[@"units"]=[bad[@"units"] mutableCopy]; bad[@"units"][@"wave_height"]=@"ft";
        Check([SurfOutlook(bad,now)[@"status"] isEqual:@"unavailable"],@"unexpected units make the product unavailable");
        Check([SurfOutlook(@{},now)[@"status"] isEqual:@"unavailable"] && [SurfOutlook(nil,now)[@"rows"] count]==0,@"missing products are compactly unavailable");
        NSMutableDictionary *stale=[Product() mutableCopy]; stale[@"time"]=@[@"2026-09-26T00:00"]; stale[@"hourly"]=[stale[@"hourly"] mutableCopy]; stale[@"hourly"][@"wave_height"]=@[@1]; stale[@"hourly"][@"swell_wave_height"]=@[@.5]; stale[@"hourly"][@"swell_wave_period"]=@[@10]; stale[@"hourly"][@"swell_wave_direction"]=@[@0]; stale[@"hourly"][@"sea_surface_temperature"]=@[@20];
        Check([SurfOutlook(stale,now)[@"status"] isEqual:@"stale"],@"old forecast is marked stale");
        SurfPaintProbe *view=[[SurfPaintProbe alloc] initWithFrame:NSMakeRect(0,0,420,160)]; view.now=now; view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"]; view.outlook=out; view.windRows=@[@{@"time":now,@"windKt":@12,@"windFrom":@270}];
        Check(NSWidth(view.plotRect)>350 && NSHeight(view.plotRect)>120,@"compact plot uses the available wall-display surface");
        Check([[view summaryAtPoint:NSMakePoint(NSMinX(view.plotRect)+1,NSMidY(view.plotRect))] containsString:@"Swell"],@"point summary includes surf readings");
        Check(fabs([[view marineDataEndDate] timeIntervalSinceDate:Date(@"2026-09-27T02:00:00Z")])<1,@"marine data end is the last actual wave timestamp");
        view.selectedDate=Date(@"2026-09-28T00:00:00Z");
        Check(fabs([[view nearestMarineDateForSelection] timeIntervalSinceDate:Date(@"2026-09-27T02:00:00Z")])<1,@"selection outside marine coverage uses the nearest actual reading");
        Check(![[view summaryAtPoint:NSMakePoint(NSMinX(view.plotRect)+1,NSMidY(view.plotRect))] containsString:@"No forecast"],@"marine reading remains available outside its end");
        Check(NSHeight(view.plotRect)>=118 && NSHeight(view.bounds)>=160,@"plot reserves a useful wave lane and separate wind/axis lanes");
        Check(NSMaxY(view.wavePlotRect)<=NSMinY(view.windLaneRect) && NSMaxY(view.windLaneRect)<=NSMinY(view.timeLaneRect),@"wave, wind, and time lanes do not overlap");
        Check([view.accessibilityLabel containsString:@"10:00"],@"accessibility exposes the exact nearest marine reading time");
        Check([view marineReadingIsDimmed] && [[view summaryAtPoint:NSMakePoint(50,5)] containsString:@"Nearest marine reading"],@"out-of-range legend is dimmed and names the actual reading time");
        view.selectedDate=[view marineDataEndDate]; NSUInteger invalidations=view.invalidations;
        view.selectedDate=[[view marineDataEndDate] dateByAddingTimeInterval:3600];
        Check(view.invalidations>invalidations && [view marineReadingIsDimmed],@"crossing coverage repaints even when the nearest sample is unchanged");
        for (NSNumber *height in @[@160,@180,@230]) {
            [view setFrameSize:NSMakeSize(420,height.doubleValue)];
            CGFloat numberBottom=NSMinY(view.windLaneRect)+20+14;
            Check(numberBottom+4<=NSMinY(view.timeLaneRect)+4,@"painted wind numbers fit above painted weekday labels");
        }
        view.selectedDate=now;
        view.windRows=@[@{ @"time":now, @"windKt":@-4, @"windFrom":@270 }];
        Check(![[view summaryAtPoint:NSMakePoint(NSMinX(view.plotRect)+1,NSMidY(view.plotRect))] containsString:@"Wind"],@"invalid wind does not create a zero-knot tooltip");
        for (NSString *appearance in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) for (NSNumber *width in @[@420,@360]) {
            view.appearance=[NSAppearance appearanceNamed:appearance]; [view setFrameSize:NSMakeSize(width.doubleValue,160)]; NSBitmapImageRep *rep=Render(view);
            // Offscreen caching adopts the attached display's 1x/2x scale.
            CGFloat scale=rep.pixelsWide/width.doubleValue;
            Check(scale>=1 && rep.pixelsHigh==160*scale,[NSString stringWithFormat:@"%@ %.0fpt offscreen surf render",appearance,width.doubleValue]);
            CGFloat endX=NSMinX(view.plotRect)+NSWidth(view.plotRect)*2/48;
            NSRect waves=view.wavePlotRect; NSInteger endInk=0, stretchedInk=0;
            for (NSInteger py=ceil((NSMinY(waves)+18)*scale);py<floor((NSMaxY(waves)-4)*scale);py++) {
                for (NSInteger px=floor((endX-1)*scale);px<=ceil((endX+1)*scale);px++) {
                    NSColor *colour=[[rep colorAtX:px y:py] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
                    if (colour.alphaComponent>.1 && fabs(colour.redComponent-colour.greenComponent)<.1 && fabs(colour.greenComponent-colour.blueComponent)<.1) endInk++;
                }
                for (NSInteger px=ceil((endX+8)*scale);px<floor(NSMaxX(waves)*scale);px++) {
                    NSColor *colour=[[rep colorAtX:px y:py] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
                    if (colour.alphaComponent>.4 && colour.blueComponent-colour.redComponent>.25) stretchedInk++;
                }
            }
            Check(endInk>10 && stretchedInk==0,@"rendered marine endpoint is marked and blue waves never stretch beyond it");
            Capture(view,[NSString stringWithFormat:@"surf-%.0fx160-%@.png",width.doubleValue,appearance]);
        }
        view.outlook=SurfOutlook(@{},now); Check([[view summaryAtPoint:NSMakePoint(200,80)] containsString:@"unavailable"],@"empty graph exposes a useful short state");
        view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
        __block BOOL neutral=NO;
        [view.effectiveAppearance performAsCurrentDrawingAppearance:^{
            NSColor *ink=[SurfWindInk() colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
            NSColor *label=[NSColor.labelColor colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
            neutral=ink && label && fabs(ink.redComponent-label.redComponent)<0.02 &&
                fabs(ink.greenComponent-label.greenComponent)<0.02 && fabs(ink.blueComponent-label.blueComponent)<0.02;
        }];
        Check(neutral, @"surf wind uses neutral label ink");
    }
    return failures?1:0;
}
