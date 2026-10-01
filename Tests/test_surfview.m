#import <Cocoa/Cocoa.h>
#import "../Sources/surfview.h"

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
        SurfForecastView *view=[[SurfForecastView alloc] initWithFrame:NSMakeRect(0,0,420,160)]; view.now=now; view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"]; view.outlook=out; view.windRows=@[@{@"time":now,@"windKt":@12,@"windFrom":@270}];
        Check(NSWidth(view.plotRect)>350 && NSHeight(view.plotRect)>120,@"compact plot uses the available wall-display surface");
        Check([[view summaryAtPoint:NSMakePoint(NSMinX(view.plotRect)+1,NSMidY(view.plotRect))] containsString:@"Swell"],@"point summary includes surf readings");
        view.windRows=@[@{ @"time":now, @"windKt":@-4, @"windFrom":@270 }];
        Check(![[view summaryAtPoint:NSMakePoint(NSMinX(view.plotRect)+1,NSMidY(view.plotRect))] containsString:@"Wind"],@"invalid wind does not create a zero-knot tooltip");
        for (NSString *appearance in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) for (NSNumber *width in @[@420,@360]) {
            view.appearance=[NSAppearance appearanceNamed:appearance]; [view setFrameSize:NSMakeSize(width.doubleValue,160)]; NSBitmapImageRep *rep=Render(view);
            // Offscreen caching adopts the attached display's 1x/2x scale.
            CGFloat scale=rep.pixelsWide/width.doubleValue;
            Check(scale>=1 && rep.pixelsHigh==160*scale,[NSString stringWithFormat:@"%@ %.0fpt offscreen surf render",appearance,width.doubleValue]);
            Capture(view,[NSString stringWithFormat:@"surf-%.0fx160-%@.png",width.doubleValue,appearance]);
        }
        view.outlook=SurfOutlook(@{},now); Check([[view summaryAtPoint:NSMakePoint(200,80)] containsString:@"unavailable"],@"empty graph exposes a useful short state");
    }
    return failures?1:0;
}
