#import <Cocoa/Cocoa.h>
#import "rain.h"
#import "rainview.h"
static int failures;
static void Check(BOOL ok, NSString *why) { if (!ok) { fprintf(stderr,"FAIL %s\n",why.UTF8String); failures++; } }
static void CheckGraphOrientation(NSBitmapImageRep *rep, CGFloat scale) {
    // A dry hour still has a baseline near the bottom. A vertically inverted
    // cache instead puts that long line near the top, beneath inverted labels.
    NSInteger bottomRow=(NSInteger)(81*scale)-1, topRow=(NSInteger)(25*scale);
    NSInteger bottom=0, top=0, samples=0;
    for (NSInteger x=(NSInteger)(200*scale); x<(NSInteger)(900*scale); x+=(NSInteger)scale) {
        bottom += [rep colorAtX:x y:bottomRow].alphaComponent>.15;
        top += [rep colorAtX:x y:topRow].alphaComponent>.15;
        samples++;
    }
    fprintf(stderr,"rain baseline %.0fx: bottom %ld, top %ld, samples %ld\n",scale,(long)bottom,(long)top,(long)samples);
    Check(bottom>samples*.8 && top<samples*.2,@"rain bitmap baseline is below the bars at each backing scale");
}
static NSUInteger RenderDigestInWindow(RainForecastView *view, NSWindow *renderWindow) {
    (void)renderWindow;
    NSUInteger checksum=0;
    NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view setNeedsDisplay:YES];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    const unsigned char *bytes=rep.bitmapData;
    NSUInteger count=(NSUInteger)rep.bytesPerRow*(NSUInteger)rep.pixelsHigh;
    for (NSUInteger i=0; i<count; i+=17) checksum=(checksum*131u)+bytes[i];
    return checksum;
}
static NSUInteger RenderDigest(RainForecastView *view) {
    CGFloat requestedScale = view.wantsLayer ? view.layer.contentsScale : 0;
    NSWindow *renderWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,NSWidth(view.bounds),NSHeight(view.bounds))
                                                        styleMask:NSWindowStyleMaskBorderless
                                                          backing:NSBackingStoreBuffered defer:YES];
    renderWindow.releasedWhenClosed=NO;
    renderWindow.contentView=view;
    [renderWindow display];
    [renderWindow orderOut:nil];
    if (requestedScale > 0) view.layer.contentsScale = requestedScale;
    NSUInteger checksum=0;
    @try { checksum=RenderDigestInWindow(view,renderWindow); }
    @finally { [renderWindow orderOut:nil]; [renderWindow close]; }
    return checksum;
}
static void RenderWarm(RainForecastView *view, NSInteger count) {
    for (NSInteger i=0; i<count; i++) (void)RenderDigest(view);
}
static NSEvent *Key(unsigned short code) {
    return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:code];
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSDate *now=[[NSISO8601DateFormatter new] dateFromString:@"2026-09-26T22:30:00Z"];
        NSDate *start=[now dateByAddingTimeInterval:-1800];
        NSMutableArray *rows=[NSMutableArray array];
        for (NSInteger i=0; i<48; i++) [rows addObject:@{
            @"time":[start dateByAddingTimeInterval:(i+1)*3600], @"rainMm":i==5?@0.7:@0,
            @"weatherCode":i==5?@61:@3}];
        RainForecastView *view=[[RainForecastView alloc] initWithFrame:NSMakeRect(0,0,956,106)];
        view.now=now; view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
        view.outlook=RainOutlook(rows,now,view.timeZone);
        __block NSString *reading=nil;
        view.onInspect=^(NSString *value){reading=value;};
        NSDate *wet=[start dateByAddingTimeInterval:5*3600+600];
        [view inspectDate:wet];
        Check([reading containsString:@"0.7 mm"] && [reading containsString:@"Light rain"],@"inspect actual preceding-hour amount and type");
        Check([[view summaryAtDate:start] containsString:@"0.0 mm"],@"known dry interval");
        [view inspectDate:nil]; Check(!reading,@"exit restores headline");
        [view keyDown:Key(123)];
        Check([reading isEqual:[view summaryAtDate:start]],@"left clamps to visible beginning");
        for (NSInteger i=0;i<60;i++) [view keyDown:Key(124)];
        Check([reading isEqual:[view summaryAtDate:[start dateByAddingTimeInterval:23*3600]]],@"right stays inside visible 24 hours");
        Check([view summaryAtDate:[start dateByAddingTimeInterval:24*3600]]==nil,@"hidden next day is not inspectable");
        [view keyDown:Key(53)]; Check(!reading,@"escape clears inspection");
        view.horizonHours=72;
        NSDate *nextDay=[start dateByAddingTimeInterval:30*3600];
        Check([view summaryAtDate:nextDay]!=nil,@"extended horizon exposes available later hours");
        view.selectedDate=nextDay; [view inspectDate:wet]; [view inspectDate:nil];
        Check([view.selectedDate isEqual:nextDay],@"local inspection preserves the shared map selection");
        Check([view summaryAtDate:[start dateByAddingTimeInterval:60*3600]]==nil,@"extended graph never invents missing rain data");
        view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
        view.outlook=RainOutlook(rows,now,view.timeZone);
        view.frameSize=NSMakeSize(956,106);
        view.wantsLayer=YES;
        [view setValue:@1.0 forKey:@"renderScaleOverride"];
        view.selectedDate=nil;
        NSWindow *cursorWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,NSWidth(view.bounds),NSHeight(view.bounds)) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
        cursorWindow.releasedWhenClosed=NO;
        cursorWindow.contentView=view;
        [cursorWindow display];
        [cursorWindow orderOut:nil];
        NSUInteger baseDigest=0, cursorDigest=0;
        id staticImage=nil, cursorStaticImage=nil;
        @try {
            baseDigest=RenderDigestInWindow(view,cursorWindow);
            staticImage=[view valueForKey:@"cachedGraphImage"];
            view.selectedDate=nextDay;
            cursorDigest=RenderDigestInWindow(view,cursorWindow);
            cursorStaticImage=[view valueForKey:@"cachedGraphImage"];
        } @finally {
            [cursorWindow orderOut:nil];
            [cursorWindow close];
        }
        NSBitmapImageRep *oneX=(NSBitmapImageRep *)[staticImage representations].firstObject;
        Check(oneX.pixelsWide==956 && oneX.pixelsHigh==106,@"1x cache uses point-sized bitmap");
        CheckGraphOrientation(oneX,1);
        NSWindow *scaleWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,NSWidth(view.bounds),NSHeight(view.bounds)) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
        scaleWindow.releasedWhenClosed=NO;
        scaleWindow.contentView=view;
        [scaleWindow display];
        [scaleWindow orderOut:nil];
        [view setValue:@2.0 forKey:@"renderScaleOverride"];
        (void)RenderDigestInWindow(view,scaleWindow);
        NSBitmapImageRep *twoX=(NSBitmapImageRep *)[[view valueForKey:@"cachedGraphImage"] representations].firstObject;
        Check(twoX.pixelsWide==1912 && twoX.pixelsHigh==212,@"2x cache uses backing-pixel bitmap");
        CheckGraphOrientation(twoX,2);
        [scaleWindow orderOut:nil];
        [scaleWindow close];
        [view setValue:@1.0 forKey:@"renderScaleOverride"];
        (void)RenderDigest(view);
        Check(cursorDigest!=baseDigest,@"selected cursor changes rendered pixels");
        Check(staticImage==cursorStaticImage,@"cursor changes reuse cached static graph");
        view.selectedDate=nil;
        view.outlook=RainOutlook(@[],now,view.timeZone);
        NSUInteger emptyDigest=RenderDigest(view);
        Check(emptyDigest!=baseDigest,@"outlook changes rebuild rendered graph");
        NSDictionary *wideHour=@{@"start":start,@"end":[start dateByAddingTimeInterval:7200],@"known":@YES,@"mm":@1.2,@"kind":@"Rain"};
        view.outlook=@{@"hours":@[wideHour]};
        Check(RenderDigest(view)!=emptyDigest,@"offset or wide forecast intervals still render");
        view.outlook=RainOutlook(rows,now,view.timeZone);
        NSUInteger aquaDigest=RenderDigest(view);
        view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        NSUInteger darkDigest=RenderDigest(view);
        Check(darkDigest!=aquaDigest,@"appearance changes rebuild rendered graph");
        view.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
        RenderWarm(view, 20);
        fprintf(stderr,"rain warm render: 20 cached draws completed\n");
        NSString *perthSummary = [view summaryAtDate:wet];
        view.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
        Check(![perthSummary isEqual:[view summaryAtDate:wet]],@"timezone invalidates cached dates and summary formatter");
        view.timeZone = [NSTimeZone timeZoneWithName:@"Australia/Perth"];
        for (NSString *appearance in @[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]) {
            view.appearance=[NSAppearance appearanceNamed:appearance];
            for (NSDictionary *outlook in @[view.outlook,RainOutlook(@[],now,view.timeZone),
                @{@"hours":@[@{@"start":start,@"end":[start dateByAddingTimeInterval:3600],@"known":@YES,@"mm":NSNull.null}]}]) {
                view.outlook=outlook; [view updateTrackingAreas];
                NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
                [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
                Check(rep.pixelsWide>0,@"offscreen rain rendering");
                [view setFrameSize:NSMakeSize(640, 92)];
                NSBitmapImageRep *resized=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
                [view cacheDisplayInRect:view.bounds toBitmapImageRep:resized];
                NSBitmapImageRep *cached=(NSBitmapImageRep *)[[view valueForKey:@"cachedGraphImage"] representations].firstObject;
                Check(cached.pixelsWide==640 && cached.pixelsHigh==92 &&
                    NSEqualSizes([[view valueForKey:@"cachedGraphSize"] sizeValue],NSMakeSize(640,92)),
                    @"resize invalidates the cached graph image");
            }
        }
    }
    return failures?1:0;
}
