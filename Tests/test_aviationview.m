#import <Cocoa/Cocoa.h>
#import <math.h>
#import "aviation.h"
#import "aviationview.h"
#import "test_accessibility.h"

static int failures;
static void Check(BOOL ok, NSString *message) {
    if (!ok) { fprintf(stderr,"FAIL %s\n",message.UTF8String); failures++; }
}
static NSDate *UTC(NSString *text) {
    NSISO8601DateFormatter *f=[NSISO8601DateFormatter new]; return [f dateFromString:text];
}
static NSBitmapImageRep *BitmapForView(AviationForecastView *view, NSInteger width, NSInteger height) {
    [view setFrameSize:NSMakeSize(width,height)];
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,width,height) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    NSBitmapImageRep *bitmap=nil;
    @try {
        [window.contentView addSubview:view];
        [window displayIfNeeded];
        bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
        [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    } @finally {
        [view removeFromSuperview];
        [window close];
    }
    return bitmap;
}
static void Render(AviationForecastView *view, NSString *name, NSInteger width, NSInteger height) {
    NSBitmapImageRep *bitmap=BitmapForView(view,width,height);
    NSString *directory=[[[NSProcessInfo processInfo] environment] objectForKey:@"ISOBAR_AVIATION_SCREENSHOTS"];
    if (!directory.length) return;
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:[directory stringByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]] atomically:YES];
}
static NSUInteger Ink(NSBitmapImageRep *bitmap) {
    NSUInteger count=0;
    for (NSInteger y=0;y<bitmap.pixelsHigh;y++) for (NSInteger x=0;x<bitmap.pixelsWide;x++) {
        NSColor *c=[bitmap colorAtX:x y:y];
        if (c.redComponent<.92 || c.greenComponent<.92 || c.blueComponent<.92) count++;
    }
    return count;
}
static void Move(AviationForecastView *view, NSWindow *window, NSPoint point) {
    NSPoint windowPoint=[view convertPoint:point toView:nil];
    NSEvent *event=[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:windowPoint modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:0 pressure:0];
    [view mouseMoved:event];
}
static BOOL AccentPixel(NSColor *colour) {
    CGFloat r=colour.redComponent,g=colour.greenComponent,b=colour.blueComponent;
    return b-r>.28 && b-g>.12;
}
static NSUInteger AccentPixelsNearViewY(NSBitmapImageRep *bitmap, CGFloat viewY, CGFloat left, CGFloat right, CGFloat viewWidth, CGFloat viewHeight) {
    CGFloat sx=bitmap.pixelsWide/viewWidth, sy=bitmap.pixelsHigh/viewHeight;
    NSInteger row=(NSInteger)lround(viewY*sy), count=0, x0=(NSInteger)floor(left*sx), x1=(NSInteger)ceil(right*sx);
    NSInteger radius=MAX(1,(NSInteger)ceil(2*sy));
    for (NSInteger y=MAX(0,row-radius);y<=MIN(bitmap.pixelsHigh-1,row+radius);y++)
        for (NSInteger x=MAX(0,x0);x<=MIN(bitmap.pixelsWide-1,x1);x++)
            if (AccentPixel([bitmap colorAtX:x y:y])) count++;
    return count;
}
static NSUInteger PixelDifference(NSBitmapImageRep *a, NSBitmapImageRep *b, NSRect viewRect, CGFloat viewWidth, CGFloat viewHeight) {
    CGFloat sx=a.pixelsWide/viewWidth, sy=a.pixelsHigh/viewHeight;
    NSInteger top=(NSInteger)floor(NSMinY(viewRect)*sy), bottom=(NSInteger)ceil(NSMaxY(viewRect)*sy), count=0;
    for (NSInteger y=MAX(0,top);y<=MIN(a.pixelsHigh-1,bottom);y++) for (NSInteger x=MAX(0,(NSInteger)floor(NSMinX(viewRect)*sx));x<=MIN(a.pixelsWide-1,(NSInteger)ceil(NSMaxX(viewRect)*sx));x++) {
        NSColor *ca=[a colorAtX:x y:y], *cb=[b colorAtX:x y:y];
        if (fabs(ca.redComponent-cb.redComponent)+fabs(ca.greenComponent-cb.greenComponent)+fabs(ca.blueComponent-cb.blueComponent)>.08) count++;
    }
    return count;
}
static double PixelDelta(NSBitmapImageRep *a, NSBitmapImageRep *b, NSRect rect, CGFloat width, CGFloat height) {
    CGFloat sx=a.pixelsWide/width,sy=a.pixelsHigh/height; double total=0;
    BOOL bytes=a.bitsPerSample==8 && b.bitsPerSample==8 && !a.isPlanar && !b.isPlanar;
    NSUInteger ai=(a.bitmapFormat & NSBitmapFormatAlphaFirst)?1:0, bi=(b.bitmapFormat & NSBitmapFormatAlphaFirst)?1:0;
    for (NSInteger y=MAX(0,(NSInteger)floor(NSMinY(rect)*sy));y<MIN(a.pixelsHigh,(NSInteger)ceil(NSMaxY(rect)*sy));y++)
        for (NSInteger x=MAX(0,(NSInteger)floor(NSMinX(rect)*sx));x<MIN(a.pixelsWide,(NSInteger)ceil(NSMaxX(rect)*sx));x++) {
            if (bytes) {
                unsigned char *pa=a.bitmapData+y*a.bytesPerRow+x*a.samplesPerPixel+ai;
                unsigned char *pb=b.bitmapData+y*b.bytesPerRow+x*b.samplesPerPixel+bi;
                for (NSUInteger channel=0;channel<3;channel++) total+=abs((int)pa[channel]-pb[channel])/255.0;
                continue;
            }
            NSColor *ca=[a colorAtX:x y:y],*cb=[b colorAtX:x y:y];
            total+=fabs(ca.redComponent-cb.redComponent)+fabs(ca.greenComponent-cb.greenComponent)+fabs(ca.blueComponent-cb.blueComponent);
        }
    return total;
}
@interface TestVisibleWindow : NSWindow
@property(nonatomic) BOOL fakeVisible;
@property(nonatomic) NSWindowOcclusionState fakeOcclusionState;
@end
@implementation TestVisibleWindow
- (BOOL)isVisible { return self.fakeVisible; }
- (NSWindowOcclusionState)occlusionState { return self.fakeOcclusionState; }
@end

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    IsobarTestSetReduceMotion(NO);
    @try {
    NSDate *start=UTC(@"2026-09-26T12:00:00Z"), *end=UTC(@"2026-09-27T04:00:00Z");
    NSDictionary *taf=@{@"raw":@"TAF YPPH 2612/2704 9999 SCT030 FM261505 4000 -SHRA BKN012 FM262200 9999 BKN020 PROB30 INTER 2622/2704 4000 TSRA BKN012", @"valid_from":start,@"valid_to":end,@"issue_time":start};
    NSDictionary *outlook=AviationOutlook(@{@"taf":taf},start,[NSTimeZone timeZoneWithName:@"Australia/Perth"]);
    AviationForecastView *view=[[AviationForecastView alloc] initWithFrame:NSMakeRect(0,0,900,136)];
    view.periods=outlook[@"periods"]; view.now=start;
    NSString *before=[view summaryAtDate:UTC(@"2026-09-26T15:04:00Z")];
    NSString *after=[view summaryAtDate:UTC(@"2026-09-26T15:05:00Z")];
    Check([before containsString:@"None / 10+ km"] && [after containsString:@"1,200 ft / 4 km"],@"inspection changes exactly at FM minute");
    NSString *overlap=[view summaryAtDate:UTC(@"2026-09-26T23:00:00Z")];
    Check([overlap containsString:@"2,000 ft / 10+ km"] && [overlap containsString:@"PROB30 INTER · 1,200 ft / 4 km"] && [overlap containsString:@"TSRA"],@"conditional values retain the prevailing values");
    view.periods=[outlook[@"periods"] arrayByAddingObject:@{ @"change":@"BECMG", @"start":UTC(@"2026-09-26T23:00:00Z"), @"end":end, @"ceiling":@"1,500 ft", @"visibility":@"5 km", @"weather":@"SHRA" }];
    NSString *withBecmg=[view summaryAtDate:UTC(@"2026-09-26T23:30:00Z")];
    Check([withBecmg containsString:@"BECMG · 1,500 ft / 5 km"],@"BECMG remains visible alongside active conditions");
    view.periods=outlook[@"periods"];
    Check([[view summaryAtDate:end] containsString:@"No TAF period"],@"TAF end is exclusive");
    __block NSString *inspected=nil;
    view.onInspect=^(NSString *s) { inspected=s; };
    [view inspectDate:UTC(@"2026-09-26T23:00:00Z")];
    Check([inspected isEqual:overlap],@"inspection callback exposes the plotted time");
    [view inspectDate:nil]; Check(!inspected,@"clearing inspection restores the observation");
    NSEvent *(^key)(unsigned short)=^NSEvent *(unsigned short code) {
        return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:code];
    };
    [view inspectDate:start]; [view keyDown:key(123)];
    Check([inspected isEqual:[view summaryAtDate:start]],@"left keyboard step clamps to visible start");
    for (int i=0;i<60;i++) [view keyDown:key(124)];
    Check([inspected isEqual:[view summaryAtDate:[end dateByAddingTimeInterval:-1]]],@"right keyboard step clamps inside the last period");
    [view updateTrackingAreas]; Render(view,@"regular",900,200);
    Render(view,@"compact",900,178);
    Render(view,@"narrow",320,178);
    Render(view,@"wide-656",656,200);
    NSAppearance *appearance=view.appearance;
    view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    Render(view,@"dark-regular",900,200);
    Render(view,@"dark-wide-656",656,200);
    view.appearance=appearance;
    [view setFrameSize:NSMakeSize(900,200)];
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,200) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    @try {
    [window.contentView addSubview:view];
    __block NSString *hover=nil; view.onInspect=^(NSString *s) { hover=s; };
    [view inspectDate:start];
    NSString *selectedSummary=hover;
    Move(view,window,NSMakePoint(420,45));
    Check([hover isEqual:selectedSummary], @"moving over a condition scene does not scrub the timeline");
    Move(view,window,NSMakePoint(420,190));
    Check(hover.length>0 && [hover containsString:@" / "], @"moving over the bottom time strip previews the selected hour");
    Check(NSHeight(view.timelineRect)>=56,@"compact TAF has a full-height scrub target");
    Move(view,window,NSMakePoint(420,NSMinY(view.timelineRect)+1));
    NSDate *fineA=[view valueForKey:@"inspectedDate"];
    Move(view,window,NSMakePoint(420.05,NSMaxY(view.timelineRect)-1));
    NSDate *fineB=[view valueForKey:@"inspectedDate"];
    Check([fineB timeIntervalSinceDate:fineA]>0 && [fineB timeIntervalSinceDate:fineA]<60,@"top and bottom of scrub band resolve sub-minute intermediate times");
    } @finally { [view removeFromSuperview]; [window close]; }

    view.selectedDate=[start dateByAddingTimeInterval:3600];
    [view inspectDate:[start dateByAddingTimeInterval:7200]];
    [view inspectDate:nil];
    Check([[view accessibilityValue] isEqual:[view summaryAtDate:view.selectedDate]],@"hover exit returns to the map-selected time, not now");
    view.selectedDate=[end dateByAddingTimeInterval:3600];
    Check([[view accessibilityValue] containsString:@"No TAF period"],@"selected date beyond TAF coverage has no invented conditions");
    view.selectedDate=nil;

    // Keep the cases that matter to an instrument approach inspectable in the
    // visual fixtures even when the compact graph uses little text.
    NSArray *sceneCases=@[
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":@1200, @"ceiling":@"1,200 ft", @"ceilingState":@"value", @"visibilityM":@9999, @"visibility":@"10+ km", @"weather":@"—" },
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":@3000, @"ceiling":@"3,000 ft", @"ceilingState":@"value", @"visibilityM":@9999, @"visibility":@"10+ km", @"weather":@"—" },
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":@1200, @"ceiling":@"1,200 ft", @"ceilingState":@"value", @"visibilityM":@2000, @"visibility":@"2 km", @"weather":@"—" },
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":@1200, @"ceiling":@"1,200 ft", @"ceilingState":@"value", @"visibilityM":@8000, @"visibility":@"8 km", @"weather":@"—" },
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":[NSNull null], @"ceiling":@"CAVOK", @"ceilingState":@"cavok", @"visibilityM":@9999, @"visibility":@"10+ km", @"weather":@"CAVOK" },
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":[NSNull null], @"ceiling":@"None", @"ceilingState":@"none", @"visibilityM":[NSNull null], @"visibility":@"—", @"weather":@"NSW" },
        @{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":[NSNull null], @"ceiling":@"Unknown", @"ceilingState":@"unknown", @"visibilityM":@9999, @"visibility":@"10+ km", @"weather":@"—" }
    ];
    for (NSUInteger i=0;i<sceneCases.count;i++) {
        view.periods=@[sceneCases[i]];
        NSBitmapImageRep *caseBitmap=BitmapForView(view,900,200);
        Check(Ink(caseBitmap)>300, [NSString stringWithFormat:@"scene fixture %lu renders visible aviation content",(unsigned long)i]);
        Render(view,[NSString stringWithFormat:@"scene-%lu",(unsigned long)i],900,200);
    }
    NSRect sceneRect=NSMakeRect(0,0,900,NSMinY(view.timelineRect)-6);
    AviationSceneGeometry low=AviationSceneLayout(sceneRect,sceneCases[0],60000), high=AviationSceneLayout(sceneRect,sceneCases[1],60000), shortVis=AviationSceneLayout(sceneRect,sceneCases[2],60000), longVis=AviationSceneLayout(sceneRect,sceneCases[3],60000);
    Check(high.ceilingY<low.ceilingY, @"higher ceiling is drawn higher in the vertical scene");
    Check(fabs(shortVis.visibilityStart.y-shortVis.visibilityEnd.y)<.01 && fabs(longVis.visibilityStart.y-longVis.visibilityEnd.y)<.01, @"visibility stays horizontal");
    Check(longVis.visibilityEnd.x>shortVis.visibilityEnd.x+20 && fabs(longVis.visibilityStart.x-shortVis.visibilityStart.x)<.01, @"visibility distance grows horizontally on the same scale");
    view.periods=@[sceneCases[0]]; NSBitmapImageRep *lowBitmap=BitmapForView(view,900,200);
    view.periods=@[sceneCases[1]]; NSBitmapImageRep *highBitmap=BitmapForView(view,900,200);
    view.periods=@[sceneCases[2]]; NSBitmapImageRep *shortBitmap=BitmapForView(view,900,200);
    view.periods=@[sceneCases[3]]; NSBitmapImageRep *longBitmap=BitmapForView(view,900,200);
    NSUInteger lowCeilingPixels=AccentPixelsNearViewY(lowBitmap,low.ceilingY,876,886,900,200), highCeilingPixels=AccentPixelsNearViewY(highBitmap,high.ceilingY,876,886,900,200);
    NSUInteger shortVisibilityPixels=AccentPixelsNearViewY(shortBitmap,shortVis.visibilityStart.y,104,886,900,200), longVisibilityPixels=AccentPixelsNearViewY(longBitmap,longVis.visibilityStart.y,104,886,900,200);
    Check(lowCeilingPixels>5 && highCeilingPixels>5, @"ceiling lines are painted at their calculated heights");
    Check(AccentPixelsNearViewY(highBitmap,low.ceilingY,876,886,900,200)<lowCeilingPixels*.15 &&
          AccentPixelsNearViewY(lowBitmap,high.ceilingY,876,886,900,200)<highCeilingPixels*.15,
          @"changing ceiling moves the actual line, not just its geometry metadata");
    Check(longVisibilityPixels>shortVisibilityPixels*3 && longVisibilityPixels<shortVisibilityPixels*5,
          @"four times the visibility paints four times the horizontal distance");
    view.periods=@[@{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":@3000, @"ceiling":@"3,000 ft", @"ceilingState":@"value", @"visibilityM":@8000, @"visibility":@"8 km", @"weather":@"—", @"cloudLayers":[NSNull null] }];
    NSBitmapImageRep *nullClouds=nil; BOOL nullCloudsCrashed=NO;
    @try { nullClouds=BitmapForView(view,900,200); } @catch (NSException *exception) { (void)exception; nullCloudsCrashed=YES; }
    Check(!nullCloudsCrashed && Ink(nullClouds)>300, @"NSNull cloud-layer data falls back without crashing");
    if (nullClouds) Render(view,@"null-cloud-layers",900,200);
    view.periods=@[@{ @"change":@"FM", @"start":start, @"end":end, @"ceilingFt":@1200, @"ceiling":@"1,200 ft", @"ceilingState":@"value", @"visibilityM":@8000, @"visibility":@"8 km", @"weather":@"—", @"cloudLayers":@[
        @{ @"baseFt":@1200, @"amount":@"BKN", @"type":@"CB" },
        @{ @"baseFt":@3000, @"amount":@"SCT", @"type":@"TCU" },
        @{ @"baseFt":@12000, @"amount":@"OVC", @"type":@"" }
    ] }];
    Render(view,@"all-cloud-layers",900,200);
    view.selectedCloudIndex=0;
    Check([view.aircraftAssetName isEqual:@"plane"], @"low cloud layer selects the small aircraft");
    view.selectedCloudIndex=1;
    Check([view.aircraftAssetName isEqual:@"plane"], @"mid cloud layer keeps the small aircraft");
    view.selectedCloudIndex=2;
    Check([view.aircraftAssetName isEqual:@"pc9"], @"high cloud layer selects the PC-9");
    view.selectedCloudIndex=99;
    Check([view.aircraftAssetName isEqual:@"pc9"], @"cloud selection clamps to the highest available layer");
    view.selectedCloudIndex=0; [view keyDown:key(125)];
    Check(view.selectedCloudIndex==0, @"down clamps at the lowest cloud layer");
    [view keyDown:key(126)];
    Check(view.selectedCloudIndex==1, @"up selects the next cloud layer");
    view.selectedCloudIndex=0;
    [view advanceAnimationAtTime:0.0]; NSBitmapImageRep *motion0=BitmapForView(view,900,200);
    [view advanceAnimationAtTime:1.0]; NSBitmapImageRep *motion1=BitmapForView(view,900,200);
    Check(PixelDifference(motion0,motion1,NSMakeRect(10,8,880,130),900,200)>10, @"cloud and aircraft animation changes rendered pixels");
    Check(PixelDifference(motion0,motion1,NSMakeRect(10,130,880,69),900,200)==0, @"animation leaves visibility measurements and time strip fixed");
    Check(isfinite(view.animationPhase), @"animation phase advances from deterministic time");
    [view advanceAnimationAtTime:0.0];
    view.selectedCloudIndex=0; NSBitmapImageRep *transitionStart=BitmapForView(view,900,200);
    view.selectedCloudIndex=2; Check([view.aircraftAssetName isEqual:@"pc9"], @"transition target selects the high-cloud aircraft");
    NSBitmapImageRep *previous=transitionStart, *transitionMid=nil, *transitionEnd=nil;
    NSUInteger distinctFrames=0, movingFrames=0, maximumStepFrame=0; double maximumStep=0;
    NSRect aircraftRegion=NSMakeRect(108,24,99,103);
    for (NSUInteger frame=0;frame<60;frame++) { @autoreleasepool {
        [view advanceAnimationAtTime:(NSTimeInterval)frame/60.0];
        NSBitmapImageRep *sample=BitmapForView(view,900,200);
        double step=PixelDelta(previous,sample,aircraftRegion,900,200);
        if (PixelDelta(previous,sample,NSMakeRect(10,8,880,130),900,200)>.001) {
            distinctFrames++; if (frame<=42) movingFrames++;
        }
        if (step>maximumStep) { maximumStep=step; maximumStepFrame=frame; }
        if (frame==29) transitionMid=sample;
        if (frame==59) transitionEnd=sample;
        previous=sample;
    } }
    double fullTransition=PixelDelta(transitionStart,transitionEnd,aircraftRegion,900,200);
    fprintf(stderr,"sky transition: %lu/60 changing frames, %lu/43 during the glide, largest step %.1f at frame %lu / full change %.1f\n",(unsigned long)distinctFrames,(unsigned long)movingFrames,maximumStep,(unsigned long)maximumStepFrame,fullTransition);
    // Once the glide has finished, subpixel cloud drift may quantize to the
    // same 8-bit pixels. The moving portion must contain the intermediate frames.
    Check(movingFrames>=40, @"sixty-fps sampling captures the intermediate aircraft positions");
    Check(fullTransition>20 && maximumStep<fullTransition*.40, @"selected-aircraft transition is spread across frames");
    Check(PixelDifference(transitionStart,transitionMid,NSMakeRect(10,8,880,130),900,200)>0 && PixelDifference(transitionMid,transitionEnd,NSMakeRect(10,8,880,130),900,200)>0, @"selected-aircraft transition has an intermediate frame");
    Render(view,@"overlay-periods",900,200);
    TestVisibleWindow *timerWindow=[[TestVisibleWindow alloc] initWithContentRect:NSMakeRect(0,0,900,200) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    timerWindow.releasedWhenClosed=NO; timerWindow.fakeVisible=YES; timerWindow.fakeOcclusionState=NSWindowOcclusionStateVisible;
    @try {
    [timerWindow.contentView addSubview:view];
    IsobarTestSetReduceMotion(YES);
    [view viewDidMoveToWindow];
    Check(!view.animationRunning, @"reduce-motion visible aviation view stays stopped");
    IsobarTestSetReduceMotion(NO);
    [view viewDidMoveToWindow];
    Check(view.animationRunning, @"visible unoccluded aviation view starts its animation timer");
    Check(fabs([[view valueForKey:@"animationTimer"] timeInterval]-1.0/60)<.00001, @"live sky timer targets sixty frames per second");
    timerWindow.fakeVisible=NO; [view viewDidMoveToWindow];
    Check(!view.animationRunning, @"hidden aviation view stops its animation timer");
    timerWindow.fakeVisible=YES; [view viewDidMoveToWindow];
    Check(view.animationRunning, @"visible aviation view restarts its animation timer");
    [view removeFromSuperview];
    Check(!view.animationRunning, @"detached aviation view stops its animation timer");
    TestVisibleWindow *releaseWindow=[[TestVisibleWindow alloc] initWithContentRect:NSMakeRect(0,0,320,178) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    releaseWindow.releasedWhenClosed=NO; releaseWindow.fakeVisible=YES; releaseWindow.fakeOcclusionState=NSWindowOcclusionStateVisible;
    __weak AviationForecastView *weakTemporary=nil;
    @autoreleasepool {
        AviationForecastView *temporary=[[AviationForecastView alloc] initWithFrame:NSMakeRect(0,0,320,178)];
        weakTemporary=temporary;
        [releaseWindow.contentView addSubview:temporary]; [temporary viewDidMoveToWindow]; [temporary viewDidHide]; [temporary removeFromSuperview]; [temporary viewDidMoveToWindow];
    }
    [releaseWindow close]; releaseWindow=nil;
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
    Check(!weakTemporary, @"detached aviation view can be released with its animation timer");
    } @finally { [view removeFromSuperview]; [timerWindow close]; }
    // A visibility-only conditional spans two prevailing cloud forecasts.
    NSMutableDictionary *inheritedTAF=[taf mutableCopy];
    inheritedTAF[@"raw"]=@"TAF YPPH 2612/2704 9999 BKN030 TEMPO 2613/2618 2000 RA FM261500 9999 BKN010";
    view.periods=AviationOutlook(@{@"taf":inheritedTAF},start,view.timeZone)[@"periods"];
    NSArray *early=[view activePeriodsAtDate:UTC(@"2026-09-26T14:00:00Z")], *late=[view activePeriodsAtDate:UTC(@"2026-09-26T16:00:00Z")];
    Check([early.lastObject[@"cloudLayers"][0][@"baseFt"] intValue]==3000 &&
          [late.lastObject[@"cloudLayers"][0][@"baseFt"] intValue]==1000 &&
          [late.lastObject[@"visibilityM"] intValue]==2000, @"conditional clouds inherit across FM without replacing its visibility");
    NSWindow *fadeWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,200) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    fadeWindow.releasedWhenClosed=NO;
    @try {
        [fadeWindow.contentView addSubview:view];
        NSBitmapImageRep *(^capture)(void)=^NSBitmapImageRep *{
            NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
            [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap]; return bitmap;
        };
        [view advanceAnimationAtTime:10]; [view inspectDate:UTC(@"2026-09-26T14:00:00Z")];
        [view advanceAnimationAtTime:11]; NSBitmapImageRep *beforeFade=capture();
        [view inspectDate:UTC(@"2026-09-26T16:00:00Z")]; NSBitmapImageRep *firstFade=capture();
        [view advanceAnimationAtTime:11.2]; NSBitmapImageRep *midFade=capture();
        [view inspectDate:UTC(@"2026-09-26T14:00:00Z")]; NSBitmapImageRep *retargetedFade=capture();
        NSRect sky=NSMakeRect(0,0,900,154);
        double initialDelta=PixelDelta(beforeFade,firstFade,sky,900,200),midDelta=PixelDelta(firstFade,midFade,sky,900,200);
        Check(midDelta>50 && initialDelta<midDelta*.05, @"forecast crossfade starts at the displayed picture and advances through intermediate frames");
        Check(PixelDelta(midFade,retargetedFade,sky,900,200)<midDelta*.05, @"rapid time changes retain the current blend without a flash");
        [view advanceAnimationAtTime:11.7];
        Check([view valueForKey:@"skySnapshot"]==nil, @"completed sky transitions release the cached frame");
    } @finally { [view removeFromSuperview]; [fadeWindow close]; }
    for (NSArray *sample in @[@[@18000,@"pc9"],@[@35000,@"jumbo"],@[@65000,@"sr71"],@[NSNull.null,NSNull.null]]) {
        NSMutableDictionary *p=[sceneCases[6] mutableCopy];
        p[@"cloudLayers"]=@[@{@"amount":@"BKN",@"baseFt":sample[0],@"type":@""}];
        view.periods=@[p]; [view inspectDate:start];
        Check(sample[1]==NSNull.null?view.aircraftAssetName==nil:[view.aircraftAssetName isEqual:sample[1]], @"aircraft uses the selected known height and hides for unknown bases");
    }
    // Forecast light follows airport coordinates and the inspected instant,
    // with civil night starting at -6°, independently of desktop appearance.
    view.latitude=-31.9403; view.longitude=115.967003;
    view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSDate *dayDate=UTC(@"2026-09-27T04:00:00Z"),*nightDate=UTC(@"2026-09-27T14:00:00Z");
    NSDictionary *light=[view daylightAtDate:dayDate];
    Check([light[@"state"] isEqual:@"day"], @"airport noon is day");
    NSDate *dusk=light[@"civilDusk"],*dawn=light[@"civilDawn"];
    Check(dawn && dusk, @"selected airport has exact civil event instants");
    Check([[[view daylightAtDate:[dusk dateByAddingTimeInterval:-1]] objectForKey:@"state"] isEqual:@"civilTwilight"] &&
          [[[view daylightAtDate:[dusk dateByAddingTimeInterval:1]] objectForKey:@"state"] isEqual:@"night"], @"civil night starts at civil dusk, not sunset");
    Check([[[view daylightAtDate:[dawn dateByAddingTimeInterval:-1]] objectForKey:@"state"] isEqual:@"night"] &&
          [[[view daylightAtDate:[dawn dateByAddingTimeInterval:1]] objectForKey:@"state"] isEqual:@"civilTwilight"], @"civil dawn ends night");
    NSMutableDictionary *allDay=[sceneCases[0] mutableCopy];
    allDay[@"start"]=UTC(@"2026-09-26T16:00:00Z"); allDay[@"end"]=UTC(@"2026-09-27T16:00:00Z");
    view.periods=@[allDay]; view.now=dayDate;
    [view inspectDate:dayDate]; [view advanceAnimationAtTime:20];
    NSBitmapImageRep *dayImage=BitmapForView(view,900,200);
    [view inspectDate:nightDate]; [view advanceAnimationAtTime:20.2];
    NSBitmapImageRep *twilightBlend=BitmapForView(view,900,200);
    [view advanceAnimationAtTime:20.5]; NSBitmapImageRep *nightImage=BitmapForView(view,900,200);
    NSRect emptySky=NSMakeRect(140,25,600,12);
    Check(PixelDelta(dayImage,nightImage,emptySky,900,200)>100, @"changing selected time changes rendered sky within one unchanged TAF group");
    Check(PixelDelta(dayImage,twilightBlend,emptySky,900,200)>5 && PixelDelta(twilightBlend,nightImage,emptySky,900,200)>5, @"day-night light has intermediate frames");
    NSColor *nightPixel=[nightImage colorAtX:nightImage.pixelsWide/2 y:(NSInteger)(30*nightImage.pixelsHigh/200.0)];
    Check(nightPixel.redComponent>.60 && nightPixel.greenComponent>.65, @"civil-night weather stays softly lit and readable");
    Check([[view summaryAtDate:nightDate] containsString:@"Civil night"] && [[view summaryAtDate:nightDate] containsString:@"BCT"], @"night summary exposes next morning civil twilight");
    view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    NSBitmapImageRep *darkTheme=BitmapForView(view,900,200);
    Check(PixelDelta(nightImage,darkTheme,emptySky,900,200)<1, @"desktop dark mode does not change astronomical light");
    Render(view,@"civil-night-dark-theme",900,200);
    view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
    Render(view,@"civil-night",900,200); Render(view,@"civil-night-narrow",320,178);
    [view inspectDate:[dusk dateByAddingTimeInterval:-600]]; [view advanceAnimationAtTime:21.0];
    Render(view,@"civil-twilight",900,200);
    [view inspectDate:dayDate]; [view advanceAnimationAtTime:22.0]; Render(view,@"civil-day",900,200);
    view.longitude=-75;
    Check([[[view daylightAtDate:dayDate] objectForKey:@"state"] isEqual:@"night"], @"same instant uses changed longitude, not a fixed Perth clock");
    view.latitude=NAN;
    Check([view daylightAtDate:dayDate]==nil && ![[view summaryAtDate:dayDate] containsString:@"Civil night"], @"unknown airport location does not invent night or twilight times");
    view.now=start;
    for (NSString *name in @[@"plane",@"pc9",@"jumbo",@"sr71",@"cloud",@"tower",@"storm"]) {
        NSBitmapImageRep *asset=(NSBitmapImageRep *)[NSBitmapImageRep imageRepWithContentsOfFile:[NSString stringWithFormat:@"Resources/Aviation/%@.png",name]];
        Check(asset.pixelsWide>0 && asset.hasAlpha, [NSString stringWithFormat:@"%@ artwork is available with alpha",name]);
    }
    view.periods=@[@{@"change":@"FM",@"start":NSNull.null,@"end":NSNull.null,@"ceilingFt":NSNull.null,@"visibilityM":NSNull.null}];
    [view inspectDate:nil]; [view updateTrackingAreas]; Render(view,@"empty-period",900,200);
    view.periods=@[]; view.status=@"TAF unavailable"; Render(view,@"empty",900,200);
    fprintf(stderr,"aviation graph failures: %d\n",failures);
    } @finally { IsobarTestRestoreReduceMotion(); }
} return failures?1:0; }
