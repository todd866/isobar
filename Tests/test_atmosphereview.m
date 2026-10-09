#import <Cocoa/Cocoa.h>
#import "atmosphere.h"
#import "atmosphereview.h"
#import "aircraft.h"
#import "test_accessibility.h"
#include <math.h>
#include <stdio.h>

static int failures;
static void Check(BOOL ok, NSString *message) { if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); failures++; } }
static NSDate *UTC(NSString *s) {
    NSDateFormatter *f=[NSDateFormatter new]; f.locale=[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    f.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0]; f.dateFormat=@"yyyy-MM-dd'T'HH:mm:ssXXXXX";
    return [f dateFromString:s];
}
static NSDictionary *LoadProduct(void) {
    return @{@"id":@"TEST",@"model":@"fixture",@"run":@"2026-09-27T00:00:00Z",
             @"latitude":@(-32.0),@"longitude":@(116.0),@"elevation":@100,
             @"time":@[@"2026-09-27T12:00",@"2026-09-27T15:00",@"2026-09-27T18:00"],
             @"levels":@{
               @"1000":@{@"height_m":@[@150,@160,@170],@"temperature_c":@[@18,@17,@15],@"relative_humidity_pct":@[@40,@55,@70],@"cloud_cover_pct":@[@0,@10,@80],@"wind_speed_kt":@[@8,@12,@16],@"wind_direction_deg":@[@350,@5,@20],@"vertical_velocity_ms":@[@-.1,@0,@.1]},
               @"900":@{@"height_m":@[@1000,@1010,@1020],@"temperature_c":@[@10,@9,@7],@"relative_humidity_pct":@[@50,@75,@95],@"cloud_cover_pct":@[@0,@35,@90],@"wind_speed_kt":@[@18,@20,@25],@"wind_direction_deg":@[@20,@30,@45]},
               @"700":@{@"height_m":@[@3000,@3010,@3020],@"temperature_c":@[@-5,@-6,@-8],@"relative_humidity_pct":@[@20,@25,@30],@"cloud_cover_pct":@[@0,@0,@5],@"wind_speed_kt":@[@30,@35,@40],@"wind_direction_deg":@[@250,@260,@270],@"vertical_velocity_ms":@[@-.2,@-.1,@.3]}}};
}
static NSBitmapImageRep *BitmapForView(AtmosphereView *view, NSInteger width, NSInteger height) {
    [view setFrameSize:NSMakeSize(width,height)];
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,width,height)
                                                  styleMask:NSWindowStyleMaskBorderless
                                                    backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    NSBitmapImageRep *bitmap=nil;
    @try {
        [window.contentView addSubview:view];
        [window displayIfNeeded];
        bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
        [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    } @finally { [view removeFromSuperview]; [window close]; }
    return bitmap;
}
static NSUInteger PixelDifference(NSBitmapImageRep *a, NSBitmapImageRep *b, NSRect rect, CGFloat width, CGFloat height) {
    CGFloat sx=a.pixelsWide/width, sy=a.pixelsHigh/height; NSUInteger count=0;
    BOOL packed=!a.isPlanar && !b.isPlanar && a.bitsPerSample==8 && b.bitsPerSample==8 && a.samplesPerPixel==b.samplesPerPixel && a.pixelsWide==b.pixelsWide && a.pixelsHigh==b.pixelsHigh;
    Check(packed,@"captures use matching packed 8-bit pixels"); if (!packed) return 0;
    NSInteger channels=a.samplesPerPixel;
    for (NSInteger y=MAX(0,(NSInteger)floor(NSMinY(rect)*sy)); y<MIN(a.pixelsHigh,(NSInteger)ceil(NSMaxY(rect)*sy)); y++)
        for (NSInteger x=MAX(0,(NSInteger)floor(NSMinX(rect)*sx)); x<MIN(a.pixelsWide,(NSInteger)ceil(NSMaxX(rect)*sx)); x++) {
            const unsigned char *ca=a.bitmapData+y*a.bytesPerRow+x*channels,*cb=b.bitmapData+y*b.bytesPerRow+x*channels;
            NSInteger delta=0; for (NSInteger channel=0;channel<channels;channel++) delta+=labs(ca[channel]-cb[channel]);
            if (delta>25) count++;
        }
    return count;
}
static void WriteScreenshot(NSBitmapImageRep *bitmap, NSString *name) {
    NSString *dir=NSProcessInfo.processInfo.environment[@"ISOBAR_ATMOSPHERE_SCREENSHOTS"];
    if (!dir.length) return;
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:[dir stringByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]] atomically:YES];
}
@interface FakeWindow : NSWindow
@property(nonatomic) BOOL fakeVisible;
@property(nonatomic) NSWindowOcclusionState fakeOcclusionState;
@end
@implementation FakeWindow
- (BOOL)isVisible { return _fakeVisible; }
- (NSWindowOcclusionState)occlusionState { return _fakeOcclusionState; }
@end
static NSEvent *MouseEvent(NSEventType type, NSPoint point, NSWindow *window) {
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
}
static void Move(AtmosphereView *view, NSWindow *window, NSPoint viewPoint) {
    [view mouseMoved:MouseEvent(NSEventTypeMouseMoved,[view convertPoint:viewPoint toView:nil],window)];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    IsobarTestSetReduceMotion(NO);
    @try {
    NSDictionary *product=LoadProduct(); Check(product!=nil, @"upper-air fixture loads");
    if (!product) return failures?1:0;
    NSDate *dry=UTC(@"2026-09-27T12:00:00Z"), *cloudy=UTC(@"2026-09-27T18:00:00Z");
    Check(dry != nil && cloudy != nil, @"test dates parse");
    NSDictionary *sample=AtmosphereAtDate(product, cloudy);
    Check([sample[@"levels"] isKindOfClass:NSArray.class] && [(NSArray *)sample[@"levels"] count]>=3, @"fixture product produces AMSL levels");
    Check(sample[@"featureAvailability"][@"cloudCover"] != nil, @"fixture product feature metadata");

    AtmosphereView *view=[[AtmosphereView alloc] initWithFrame:NSMakeRect(0,0,900,620)];
    view.product=product; view.now=dry; view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
    view.latitude=[product[@"latitude"] doubleValue]; view.longitude=[product[@"longitude"] doubleValue];
    [view setValue:@150 forKey:@"selectedHeightM"];
    Check([view.accessibilityValue containsString:@"350/8"],@"inspected level gives wind as direction/speed (350/8)");
    [view inspectDate:cloudy];
    [view advanceAnimationAtTime:[[view valueForKey:@"animationTime"] doubleValue]+.6];
    Check([view.accessibilityValue containsString:@"020/16"],@"wind direction/speed follows the next forecast (020/16)");
    [view inspectDate:dry];
    [view advanceAnimationAtTime:[[view valueForKey:@"animationTime"] doubleValue]+.6];
    [view setValue:@1500 forKey:@"selectedHeightM"];
    CGFloat y1=[view yForHeight:1000], y20=[view yForHeight:20000];
    Check(y20<y1, @"fixed 20 km scale places high atmosphere above low atmosphere");
    Check(fabs(y20-[view yForHeight:20000])<.001, @"fixed y scale is deterministic");
    NSArray<NSValue *> *markers=[view aircraftMarkerRects]; Check(markers.count==7, @"seven aircraft reference markers");
    for (NSValue *value in markers) { NSRect rect=value.rectValue; Check(fabs(rect.size.width-32)<.01 && fabs(rect.size.height-16)<.01, @"aircraft marker is compact"); }
    Check(fabs([markers[0] rectValue].origin.x-[markers[1] rectValue].origin.x)>.01, @"aircraft markers occupy distinct horizontal positions");
    [view advanceAnimationAtTime:0.0]; [view inspectDate:cloudy]; [view advanceAnimationAtTime:.5];
    NSArray *later=[view aircraftMarkerRects]; BOOL moved=NO;
    for (NSUInteger i=0;i<markers.count;i++) if (fabs([markers[i] rectValue].origin.x-[later[i] rectValue].origin.x)>.01) moved=YES;
    Check(moved, @"aircraft positions evolve with forecast time");
    [view inspectDate:dry]; [view advanceAnimationAtTime:1.0];
    NSBitmapImageRep *dryImage=BitmapForView(view,900,620); WriteScreenshot(dryImage,@"dry");
    [view inspectDate:cloudy]; [view advanceAnimationAtTime:1.5];
    NSBitmapImageRep *cloudImage=BitmapForView(view,900,620); WriteScreenshot(cloudImage,@"cloudy");
    Check(PixelDifference(dryImage,cloudImage,view.plotRect,900,620)>1200, @"forecast weather changes visibly across model times");
    [view inspectDate:dry]; [view advanceAnimationAtTime:3.0]; [view inspectDate:cloudy];
    NSBitmapImageRep *previousFrame=nil; NSUInteger distinctFrames=0;
    for (NSUInteger frame=0; frame<60; frame++) {
        [view advanceAnimationAtTime:3.0+(double)frame/60.0];
        NSBitmapImageRep *image=BitmapForView(view,900,620);
        if (previousFrame && PixelDifference(previousFrame,image,view.plotRect,900,620)>0) distinctFrames++;
        previousFrame=image;
    }
    Check(distinctFrames>=25, @"60 rendered transition frames contain smooth in-between motion");
    fprintf(stderr,"atmosphere transition: %lu distinct frames across a 0.5 s move at 60 fps\n",(unsigned long)distinctFrames);
    for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(900,620)],[NSValue valueWithSize:NSMakeSize(988,540)],[NSValue valueWithSize:NSMakeSize(600,340)]]) {
        NSSize s=size.sizeValue; NSBitmapImageRep *image=BitmapForView(view,s.width,s.height);
        Check(image.pixelsWide>0 && image.pixelsHigh>0, @"offscreen viewport renders");
        WriteScreenshot(image,[NSString stringWithFormat:@"viewport-%.0fx%.0f",s.width,s.height]);
    }
    [view setFrameSize:NSMakeSize(600,340)];
    [view inspectDate:dry]; [view advanceAnimationAtTime:[[view valueForKey:@"animationTime"] doubleValue]+.5]; NSArray *smallBefore=view.aircraftMarkerRects;
    [view inspectDate:cloudy]; [view advanceAnimationAtTime:[[view valueForKey:@"animationTime"] doubleValue]+.5]; NSArray *smallAfter=view.aircraftMarkerRects;
    CGFloat largestMove=0;
    for (NSUInteger i=0;i<smallBefore.count;i++) {
        NSRect a=[smallBefore[i] rectValue],b=[smallAfter[i] rectValue];
        largestMove=MAX(largestMove,fabs(NSMidX(a)-NSMidX(b)));
        Check(fabs(NSMidY(a)-NSMidY(b))<.001,@"reference aircraft keep their standard flight heights while scrubbing");
    }
    Check(largestMove>20,@"aircraft movement is visible even in the smallest sky viewport");
    NSString *livePath=NSProcessInfo.processInfo.environment[@"ISOBAR_ATMOSPHERE_LIVE_FIXTURE"];
    if (livePath.length) {
        NSDictionary *live=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:livePath] options:0 error:NULL];
        view.product=live;
        NSString *stamp=[live[@"time"][0] stringByAppendingString:@":00Z"];
        view.now=UTC(stamp); [view inspectDate:view.now]; [view advanceAnimationAtTime:[[view valueForKey:@"animationTime"] doubleValue]+.5];
        WriteScreenshot(BitmapForView(view,900,620),@"live-profile");
        WriteScreenshot(BitmapForView(view,600,340),@"live-profile-small");
        view.product=product; view.now=dry; [view inspectDate:dry]; [view advanceAnimationAtTime:[[view valueForKey:@"animationTime"] doubleValue]+.5];
    }
    NSAppearance *old=view.appearance; view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    NSBitmapImageRep *dark=BitmapForView(view,900,620); WriteScreenshot(dark,@"dark"); Check(dark!=nil, @"dark appearance renders"); view.appearance=old;

    __block NSString *inspected=nil; view.onInspect=^(NSString *summary){ inspected=summary; };
    FakeWindow *window=[[FakeWindow alloc] initWithContentRect:NSMakeRect(0,0,900,620) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO; window.fakeVisible=YES; window.fakeOcclusionState=NSWindowOcclusionStateVisible;
    [view setFrameSize:NSMakeSize(900,620)]; [window.contentView addSubview:view]; [view inspectDate:dry]; [view advanceAnimationAtTime:5.0]; NSString *before=inspected;
    Check(NSHeight(view.timelineRect)>=72,@"whole 72-point band accepts atmosphere scrubbing");
    for (NSUInteger i=0;i<60;i++) {
        [view advanceAnimationAtTime:5+(i+1)/60.0];
        [view inspectDate:[dry dateByAddingTimeInterval:21600*(i+1)/60.0]];
    }
    NSDate *displayed=[view valueForKey:@"displayDate"];
    Check([displayed timeIntervalSinceDate:dry]>18000,@"sustained pointer updates keep sky moving instead of restarting a stalled ease-in");
    [view inspectDate:dry]; [view advanceAnimationAtTime:7]; before=inspected;
    Move(view,window,NSMakePoint(440,100)); Check([inspected isEqual:before], @"scene hover does not scrub time");
    Move(view,window,NSMakePoint(440,590)); Check(![inspected isEqual:before], @"timeline hover changes inspected time");
    NSPoint scrubStart=NSMakePoint(NSMidX(view.timelineRect),NSMinY(view.timelineRect)+2);
    [view mouseDown:MouseEvent(NSEventTypeLeftMouseDown,[view convertPoint:scrubStart toView:nil],window)];
    [view mouseDragged:MouseEvent(NSEventTypeLeftMouseDragged,[view convertPoint:NSMakePoint(1000,0) toView:nil],window)];
    Check([view.selectedDate isEqual:cloudy],@"dragging outside the scrub strip still reaches the clamped final hour");
    [view mouseUp:MouseEvent(NSEventTypeLeftMouseUp,[view convertPoint:NSMakePoint(-50,0) toView:nil],window)];
    Check([view.selectedDate isEqual:dry],@"outside release commits the exact first hour");
    [view mouseDown:MouseEvent(NSEventTypeLeftMouseDown,[view convertPoint:NSMakePoint(440,250) toView:nil],window)]; Check([view.accessibilityValue containsString:@"hPa"] || [view.accessibilityValue containsString:@"Standard"], @"scene click exposes selected height");

    for (NSUInteger i=0;i<7;i++) {
        NSRect marker=[view.aircraftMarkerRects[i] rectValue];
        Move(view,window,NSMakePoint(0,0));
        Move(view,window,NSMakePoint(NSMidX(marker),NSMidY(marker)));
        Check([view.hoverCardSummary containsString:AircraftRecognitionCards()[i][@"title"]],@"each aircraft opens its recognition lesson");
        Check(NSContainsRect(view.plotRect,view.hoverCardRect),@"recognition card fits inside sky");
    }
    NSRect kingAir=[view.aircraftMarkerRects[3] rectValue];
    Move(view,window,NSMakePoint(0,0)); Move(view,window,NSMakePoint(NSMidX(kingAir),NSMidY(kingAir)));
    NSRect cardRect=view.hoverCardRect;
    Move(view,window,NSMakePoint(NSMidX(cardRect),NSMidY(cardRect)));
    Check([view.hoverCardSummary containsString:@"King Air"],@"card stays open while pointer moves onto story link");
    WriteScreenshot(BitmapForView(view,900,620),@"kingair-card");
    [window.contentView addSubview:view];
    [view setFrameSize:NSMakeSize(600,340)];
    kingAir=[view.aircraftMarkerRects[3] rectValue]; Move(view,window,NSMakePoint(0,0)); Move(view,window,NSMakePoint(NSMidX(kingAir),NSMidY(kingAir)));
    Check(NSContainsRect(view.plotRect,view.hoverCardRect),@"recognition card fits smallest supported window");
    WriteScreenshot(BitmapForView(view,600,340),@"small-card");
    [window.contentView addSubview:view]; [view setFrameSize:NSMakeSize(900,620)];
    view.now=NSDate.date; [view inspectDate:view.now]; [view advanceAnimationAtTime:6]; view.trafficEnabled=YES;
    view.trafficSnapshot=TrafficSnapshot(@{@"now":@(NSDate.date.timeIntervalSince1970*1000),@"ac":@[
        @{@"hex":@"7c1234",@"flight":@"TEST123",@"t":@"BE20",@"lat":@-32,@"lon":@116,@"alt_baro":@12000,@"gs":@180,@"seen_pos":@1}]},NSDate.date,-32,116);
    Check(view.liveAircraft.count==1,@"live mode shows fresh airborne feed");
    NSRect liveRect=[view.liveAircraftRects[0] rectValue];
    Move(view,window,NSMakePoint(0,0)); Move(view,window,NSMakePoint(NSMidX(liveRect),NSMidY(liveRect)));
    Check([view.hoverCardSummary containsString:@"TEST123"] && [view.hoverCardSummary containsString:@"Pressure altitude 12000 ft"] && [view.hoverCardSummary containsString:@"180 kt"],@"live card identifies aircraft, pressure altitude and knots");
    WriteScreenshot(BitmapForView(view,900,620),@"live-card");
    [window.contentView addSubview:view];
    [view inspectDate:[view.now dateByAddingTimeInterval:3600]];
    Check(view.liveAircraft.count==0 && view.hoverCardSummary==nil,@"future scrub never presents live positions as forecast aircraft");
    view.trafficEnabled=NO;
    [view removeFromSuperview]; [window close];

    FakeWindow *fake=[[FakeWindow alloc] initWithContentRect:NSMakeRect(0,0,900,620) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    fake.releasedWhenClosed=NO; fake.fakeVisible=NO; fake.fakeOcclusionState=0; [fake.contentView addSubview:view]; [view viewDidMoveToWindow];
    Check(!view.animationRunning, @"hidden view does not animate");
    IsobarTestSetReduceMotion(YES); fake.fakeVisible=YES; fake.fakeOcclusionState=NSWindowOcclusionStateVisible; [view viewDidMoveToWindow]; Check(!view.animationRunning, @"reduce-motion visible view stays stopped");
    NSBitmapImageRep *staticBefore=BitmapForView(view,900,620); [view advanceAnimationAtTime:100]; NSBitmapImageRep *staticAfter=BitmapForView(view,900,620); [fake.contentView addSubview:view]; [view viewDidMoveToWindow];
    Check(PixelDifference(staticBefore,staticAfter,view.plotRect,900,620)==0, @"reduce-motion advance leaves the rendered atmosphere static");
    IsobarTestSetReduceMotion(NO); [view viewDidMoveToWindow]; Check(view.animationRunning, @"visible view animates at 60 Hz");
    fake.fakeOcclusionState=0; [view viewDidMoveToWindow]; Check(!view.animationRunning, @"occluded view stops animating"); [view removeFromSuperview]; [fake close];
    if (failures) fprintf(stderr," %d atmosphere view test(s) failed\n",failures);
    } @finally { IsobarTestRestoreReduceMotion(); }
  }
  return failures?1:0;
}
