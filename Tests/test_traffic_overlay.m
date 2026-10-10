// Offscreen traffic controls remain testable on a runner without a Metal device.
#import <Cocoa/Cocoa.h>
#import "gpumapview.h"
#import "mapcamera.h"
#import "traffic.h"
@interface NSView (TrafficOverlayTest)
- (void)rebuildControls;
@end
@interface TrafficOverlayOwner : GPUMapView
@property(nonatomic) IsobarCamera fixtureCamera;
@property(nonatomic) NSUInteger pointerDowns,pointerDrags,pointerUps;
@property(nonatomic) NSPoint lastPointer;
@end
@implementation TrafficOverlayOwner
- (IsobarCamera)camera { return _fixtureCamera; }
- (void)pointerDown:(NSPoint)point { self.pointerDowns++; self.lastPointer=point; }
- (void)pointerDrag:(NSPoint)point { self.pointerDrags++; self.lastPointer=point; }
- (void)pointerUp:(NSPoint)point { self.pointerUps++; self.lastPointer=point; }
@end
@interface GPUMapTrafficOverlay : NSView
- (NSDictionary *)aircraftAtPoint:(NSPoint)point;
@end
static int failures;
static void Check(BOOL value,NSString *label) { if (!value) { fprintf(stderr,"FAIL %s\n",label.UTF8String); failures++; } }
static void Capture(NSView *view,NSString *file) {
    NSView *parent=view.superview;
    NSWindow *window=[[NSWindow alloc] initWithContentRect:view.bounds styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    [window.contentView addSubview:view]; [window displayIfNeeded];
    NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSData *png=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    Check([png writeToFile:file atomically:YES],@"overlay PNG saved");
    [view removeFromSuperview]; [parent addSubview:view]; [window close];
}
static BOOL MapRegionChanged(NSView *view,NSRect region,NSData **before) {
    NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds]; [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSData *after=[NSData dataWithBytes:rep.bitmapData length:rep.bytesPerRow*rep.pixelsHigh];
    if (!*before) { *before=after; return NO; }
    const unsigned char *a=after.bytes,*b=(*before).bytes; NSUInteger length=MIN(after.length,(*before).length); BOOL changed=NO;
    // Regions are view points; bitmap captures can use Retina backing pixels.
    double sx=rep.pixelsWide/NSWidth(view.bounds), sy=rep.pixelsHigh/NSHeight(view.bounds);
    NSInteger left=MAX(0,(NSInteger)floor(NSMinX(region)*sx)), right=MIN(rep.pixelsWide,(NSInteger)ceil(NSMaxX(region)*sx));
    NSInteger top=MAX(0,(NSInteger)floor(NSMinY(region)*sy)), bottom=MIN(rep.pixelsHigh,(NSInteger)ceil(NSMaxY(region)*sy));
    for (NSInteger y=top;y<bottom && !changed;y++) for (NSInteger x=left;x<right;x++) { NSUInteger offset=(NSUInteger)y*rep.bytesPerRow+(NSUInteger)x*4; if (offset+3<length && memcmp(a+offset,b+offset,4)!=0) { changed=YES; break; } }
    return changed;
}
int main(void) { @autoreleasepool {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSString *out=NSProcessInfo.processInfo.environment[@"ISOBAR_TRAFFIC_QA"];
    if (!out.length) out=@"build/traffic-qa/native";
    [NSFileManager.defaultManager createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:NULL];
    TrafficOverlayOwner *owner=[[TrafficOverlayOwner alloc] initWithFrame:NSMakeRect(0,0,640,440)];
    owner.fixtureCamera=MapCameraMake(-32,116,8,0,640,440);
    owner.trafficEnabled=YES; owner.trafficIsNow=YES; owner.trafficZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
    owner.trafficSession=[TrafficTrackSession new]; NSDate *now=NSDate.date;
    NSMutableArray *rows=[NSMutableArray array];
    for (NSUInteger i=0;i<8;i++) {
        NSString *hex=[NSString stringWithFormat:@"abc%03lu",(unsigned long)i];
        NSDictionary *row=@{@"hex":hex,@"callsign":[NSString stringWithFormat:@"QFA%lu",(unsigned long)(642+i)],@"registration":@"VH-TEST",@"type":@"B738",@"latitude":@(-32+i*.12),@"longitude":@(115.5+i*.12),@"pressureAltitudeFt":@(18000+i*1000),@"positionTime":now,@"groundSpeedKt":@420,@"trackDegrees":@95,@"verticalTrend":@"climb",@"squawk":@"1200"};
        [rows addObject:row];
    }
    owner.trafficSnapshot=@{@"time":now,@"aircraft":rows};
    for (NSDictionary *row in rows) [owner.trafficSession toggleSelectionForHex:row[@"hex"]];
    NSView *overlay=[[NSClassFromString(@"GPUMapTrafficOverlay") alloc] initWithFrame:owner.bounds];
    [overlay setValue:owner forKey:@"owner"]; [owner addSubview:overlay];
    [overlay rebuildControls];
    NSScrollView *chips=[overlay valueForKey:@"chips"],*cards=[overlay valueForKey:@"cards"];
    Check(chips.documentView.subviews.count==8,@"all eight chips are accessible controls");
    Check(cards.documentView.subviews.count==32,@"all eight compact cards remain reachable by scrolling");
    Check(NSMaxY(cards.frame)<NSHeight(overlay.bounds),@"cards bounded to viewport");

    owner.trafficIsNow=NO;
    Check([(GPUMapTrafficOverlay *)overlay aircraftAtPoint:NSMakePoint(320,220)]==nil,@"forecast traffic hit is suppressed");
    NSWindow *eventWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,640,440) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
    eventWindow.releasedWhenClosed=NO;
    [eventWindow.contentView addSubview:owner];
    NSPoint eventPoint=NSMakePoint(600,400); NSInteger windowNumber=eventWindow.windowNumber;
    NSEvent *down=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:eventPoint modifierFlags:0 timestamp:0 windowNumber:windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
    NSEvent *drag=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:NSMakePoint(610,410) modifierFlags:0 timestamp:.01 windowNumber:windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
    NSEvent *up=[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:NSMakePoint(610,410) modifierFlags:0 timestamp:.02 windowNumber:windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
    [(GPUMapTrafficOverlay *)overlay mouseDown:down]; [(GPUMapTrafficOverlay *)overlay mouseDragged:drag]; [(GPUMapTrafficOverlay *)overlay mouseUp:up];
    Check(owner.pointerDowns==1 && owner.pointerDrags==1 && owner.pointerUps==1,@"normal map pointer events remain forwarded");
    owner.trafficIsNow=YES; [owner removeFromSuperview]; [eventWindow close];
    for (NSString *appearance in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) {
        overlay.appearance=[NSAppearance appearanceNamed:appearance];
        Capture(overlay,[out stringByAppendingPathComponent:[appearance isEqual:NSAppearanceNameAqua]?@"overlay-light.png":@"overlay-dark.png"]);
    }
    NSButton *remove=(NSButton *)chips.documentView.subviews[3]; [remove performClick:nil];
    Check(owner.trafficSession.selectedHexes.count==7,@"chip removes its aircraft");
    owner.trafficEnabled=NO;
    Check([overlay hitTest:NSMakePoint(20,20)]==nil,@"disabled overlay lets map input through");

    // Three-aircraft Perth fixture with five-minute-bounded history and a visible route projection.
    owner.trafficEnabled=YES; owner.trafficIsNow=YES; owner.trafficSession=[TrafficTrackSession new];
    NSMutableArray *three=[NSMutableArray array]; NSMutableDictionary *routes=[NSMutableDictionary dictionary];
    for (NSUInteger i=0;i<3;i++) {
        NSString *hex=[NSString stringWithFormat:@"per%03lu",(unsigned long)i]; NSString *callsign=@[@"QFA642",@"VOZ771",@"TEST123"][i];
        NSMutableArray *history=[NSMutableArray array];
        for (NSUInteger j=0;j<4;j++) [history addObject:@{ @"latitude":@(-31.95+i*.25+j*.01), @"longitude":@(115.9+i*.28+j*.01), @"pressureAltitudeFt":@(18000+i*2000+j*100), @"time":[now dateByAddingTimeInterval:-((NSInteger)(3-j)*60)] }];
        NSDictionary *latest=history.lastObject; NSDictionary *aircraft=@{ @"hex":hex,@"callsign":callsign,@"registration":@"VH-TEST",@"type":@"B738",@"latitude":latest[@"latitude"],@"longitude":latest[@"longitude"],@"pressureAltitudeFt":latest[@"pressureAltitudeFt"],@"positionTime":latest[@"time"],@"groundSpeedKt":@420,@"trackDegrees":@95 };
        [three addObject:aircraft]; NSMutableArray *historyRows=[NSMutableArray array]; for (NSDictionary *point in history) [historyRows addObject:@{ @"hex":hex,@"callsign":callsign,@"registration":@"VH-TEST",@"type":@"B738",@"latitude":point[@"latitude"],@"longitude":point[@"longitude"],@"pressureAltitudeFt":point[@"pressureAltitudeFt"],@"positionTime":point[@"time"] }];
        [owner.trafficSession mergeSnapshot:@{ @"time":history.lastObject[@"time"], @"aircraft":historyRows }];
        routes[hex]=@{ @"origin":@{ @"icao":@"YPPH", @"name":@"Perth", @"latitude":@-31.94, @"longitude":@115.97 }, @"destination":@{ @"icao":@"YPAD", @"name":@"Adelaide", @"latitude":@-34.95, @"longitude":@138.53 } };
        [owner.trafficSession toggleSelectionForHex:hex];
    }
    owner.trafficSnapshot=@{@"time":now,@"aircraft":three}; owner.trafficRoutes=routes; [overlay rebuildControls];
    Check(owner.trafficSession.selectedHexes.count==3 && [owner.trafficSession trackForHex:@"per000"].count==4,@"three aircraft retain bounded multi-point history");
    // Pausing while live must hold the displayed observation even as a newer
    // poll arrives. The clock/controller marks this state separately from
    // trafficIsNow so a held live map does not jump to the new feed.
    owner.trafficIsNow=YES; owner.trafficDate=now; owner.trafficSnapshot=@{@"time":now,@"aircraft":three}; [overlay rebuildControls];
    owner.trafficHolding=YES; owner.trafficIsNow=NO; [overlay rebuildControls];
    NSScrollView *heldCards=[overlay valueForKey:@"cards"];
    NSMutableString *heldBefore=[NSMutableString string];
    for (NSView *view in heldCards.documentView.subviews) if ([view isKindOfClass:NSTextField.class]) [heldBefore appendString:((NSTextField *)view).stringValue];
    NSArray *moved=[three copy];
    NSMutableArray *newRows=[NSMutableArray array];
    for (NSDictionary *row in moved) { NSMutableDictionary *copy=[row mutableCopy]; copy[@"longitude"]=@([[row valueForKey:@"longitude"] doubleValue]+1.0); copy[@"pressureAltitudeFt"]=@([[row valueForKey:@"pressureAltitudeFt"] doubleValue]+5000); [newRows addObject:copy]; }
    owner.trafficSnapshot=@{@"time":[now dateByAddingTimeInterval:10],@"aircraft":newRows}; [overlay rebuildControls];
    heldCards=[overlay valueForKey:@"cards"]; NSMutableString *heldAfter=[NSMutableString string];
    for (NSView *view in heldCards.documentView.subviews) if ([view isKindOfClass:NSTextField.class]) [heldAfter appendString:((NSTextField *)view).stringValue];
    Check(owner.trafficHoldSnapshot != nil && owner.trafficHoldDate != nil,@"live pause captures a traffic snapshot and date");
    Check([heldBefore isEqualToString:heldAfter],@"held live cards stay frozen across a newer traffic poll");
    owner.trafficHolding=NO; owner.trafficIsNow=YES; [overlay rebuildControls];
    heldCards=[overlay valueForKey:@"cards"]; NSMutableString *released=[NSMutableString string];
    for (NSView *view in heldCards.documentView.subviews) if ([view isKindOfClass:NSTextField.class]) [released appendString:((NSTextField *)view).stringValue];
    Check(![heldBefore isEqualToString:released],@"releasing traffic hold adopts the newer live snapshot");
    owner.trafficDate=[now dateByAddingTimeInterval:-60]; owner.trafficIsNow=NO; [overlay rebuildControls];
    NSScrollView *replayCards=[overlay valueForKey:@"cards"]; BOOL replayAltitude=NO;
    for (NSView *view in replayCards.documentView.subviews)
        if ([view isKindOfClass:NSTextField.class] && [((NSTextField *)view).stringValue containsString:@"FL182"]) replayAltitude=YES;
    Check(replayAltitude,@"a recent rewind uses sampled historical altitude");
    NSDictionary *replayAircraft=[owner.trafficSession aircraftAtDate:owner.trafficDate].firstObject; double rx=0,ry=0;
    IsobarCameraProject(owner.camera,[replayAircraft[@"latitude"] doubleValue],[replayAircraft[@"longitude"] doubleValue],&rx,&ry);
    Check([(GPUMapTrafficOverlay *)overlay aircraftAtPoint:NSMakePoint(rx,ry)]!=nil,@"replay aircraft remain hittable at the playhead");
    owner.trafficDate=[now dateByAddingTimeInterval:120]; [overlay rebuildControls]; replayCards=[overlay valueForKey:@"cards"];
    BOOL noRecorded=NO;
    for (NSView *view in replayCards.documentView.subviews)
        if ([view isKindOfClass:NSTextField.class] && [((NSTextField *)view).stringValue containsString:@"No recorded position"]) noRecorded=YES;
    Check(noRecorded,@"replay cards identify missing captured coverage");
    owner.trafficIsNow=YES;
    overlay.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua]; Capture(overlay,[out stringByAppendingPathComponent:@"perth-3-light.png"]);
    overlay.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]; Capture(overlay,[out stringByAppendingPathComponent:@"perth-3-dark.png"]);
    overlay.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua]; NSData *routePixels=nil;
    (void)MapRegionChanged(overlay,NSMakeRect(320,0,320,440),&routePixels);
    owner.trafficRoutes=@{};
    Check(MapRegionChanged(overlay,NSMakeRect(320,0,320,440),&routePixels),@"valid route changes map pixels outside cards");
    fprintf(stderr,"traffic overlay failures: %d\n",failures); return failures?1:0;
} }
