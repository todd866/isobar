#import <Cocoa/Cocoa.h>
#import "mapdetail.h"
static int failures;
static void Check(BOOL ok, NSString *why) { if(!ok){fprintf(stderr,"FAIL %s\n",why.UTF8String);failures++;} }
int main(void) { @autoreleasepool {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
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
    for (NSNumber *height in @[@150,@175,@234,@400]) {
        NSRect bounds=NSMakeRect(0,0,314,height.doubleValue), card=MapDetailsRect(5,bounds);
        Check(!NSIsEmptyRect(card) && NSContainsRect(bounds,card),@"all five layer readings fit the smallest supported chart");
    }
    fprintf(stderr,"map detail failures: %d\n",failures);
    return failures?1:0;
} }
