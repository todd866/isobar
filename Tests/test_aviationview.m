#import <Cocoa/Cocoa.h>
#import <math.h>
#import "aviation.h"
#import "aviationview.h"
#import "solar.h"
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
static BOOL LineHighlighted(NSTextView *view, NSString *fragment) {
    NSRange range=[view.string rangeOfString:fragment];
    if (range.location==NSNotFound || !range.length) return NO;
    return [view.textStorage attribute:NSBackgroundColorAttributeName atIndex:range.location effectiveRange:NULL] != nil;
}
static NSView *LensControl(NSView *root, NSString *identifier) {
    if ([root.accessibilityIdentifier isEqual:identifier]) return root;
    for (NSView *child in root.subviews) {
        NSView *found=LensControl(child, identifier);
        if (found) return found;
    }
    return nil;
}
static void CheckNoEllipsis(NSView *view) {
    if (!view || view.hidden || view.isHiddenOrHasHiddenAncestor) return;
    NSString *ident=view.accessibilityIdentifier;
    if (ident.length) {
        NSString *text=@"";
        if ([view isKindOfClass:NSButton.class]) text=((NSButton *)view).title?:@"";
        else if ([view isKindOfClass:NSTextField.class]) text=((NSTextField *)view).stringValue?:@"";
        else if ([view isKindOfClass:NSTextView.class]) text=((NSTextView *)view).string?:@"";
        Check([text containsString:@"…"]==NO, [NSString stringWithFormat:@"%@ label ellipsizes: %@", ident, text]);
        if ([view isKindOfClass:NSTextField.class]) {
            NSTextField *field=(NSTextField *)view;
            Check(field.lineBreakMode!=NSLineBreakByTruncatingTail && field.lineBreakMode!=NSLineBreakByTruncatingHead
                && field.lineBreakMode!=NSLineBreakByTruncatingMiddle,
                [NSString stringWithFormat:@"%@ clips with an ellipsis", ident]);
        }
    }
    for (NSView *child in view.subviews) CheckNoEllipsis(child);
}
static CGFloat ControlBaseline(NSView *root, NSControl *control) {
    if (!control) return NAN;
    return [control convertPoint:NSMakePoint(0, control.baselineOffsetFromBottom) toView:root].y;
}
static NSBitmapImageRep *BitmapForLens(AviationLensView *lens, NSInteger width, NSInteger height, NSAppearance *appearance) {
    [lens setFrameSize:NSMakeSize(width,height)];
    if (appearance) lens.appearance=appearance;
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,width,height) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    if (appearance) window.appearance=appearance;
    NSBitmapImageRep *bitmap=nil;
    @try {
        [window.contentView addSubview:lens];
        [lens reload];
        [lens layoutSubtreeIfNeeded];
        [window displayIfNeeded];
        bitmap=[lens bitmapImageRepForCachingDisplayInRect:lens.bounds];
        [lens cacheDisplayInRect:lens.bounds toBitmapImageRep:bitmap];
    } @finally {
        [lens removeFromSuperview];
        [window close];
    }
    return bitmap;
}
static void RenderLens(AviationLensView *lens, NSString *name, NSInteger width, NSInteger height, NSAppearance *appearance) {
    NSBitmapImageRep *bitmap=BitmapForLens(lens,width,height,appearance);
    NSString *directory=@"build/qa/fly";
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSString *path=[directory stringByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]];
    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
    fprintf(stderr,"fly panel %s\n",path.UTF8String);
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
static BOOL SaturatedRed(NSColor *colour) {
    CGFloat r=colour.redComponent, g=colour.greenComponent, b=colour.blueComponent;
    return r>0.55 && g<0.35 && b<0.35 && colour.alphaComponent>0.4;
}
static NSUInteger RedPixels(NSBitmapImageRep *bitmap, NSRect viewRect, CGFloat viewWidth, CGFloat viewHeight) {
    CGFloat sx=bitmap.pixelsWide/viewWidth, sy=bitmap.pixelsHigh/viewHeight;
    NSUInteger count=0;
    for (NSInteger y=MAX(0,(NSInteger)floor(NSMinY(viewRect)*sy)); y<MIN(bitmap.pixelsHigh,(NSInteger)ceil(NSMaxY(viewRect)*sy)); y++)
        for (NSInteger x=MAX(0,(NSInteger)floor(NSMinX(viewRect)*sx)); x<MIN(bitmap.pixelsWide,(NSInteger)ceil(NSMaxX(viewRect)*sx)); x++)
            if (SaturatedRed([bitmap colorAtX:x y:y])) count++;
    return count;
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
static void RGB(NSBitmapImageRep *bitmap, NSInteger x, NSInteger y, double rgb[3]) {
    if (bitmap.bitsPerSample==8 && !bitmap.isPlanar) {
        unsigned char *p=bitmap.bitmapData+y*bitmap.bytesPerRow+x*bitmap.samplesPerPixel+((bitmap.bitmapFormat & NSBitmapFormatAlphaFirst)?1:0);
        for (int c=0;c<3;c++) rgb[c]=p[c]/255.0;
        return;
    }
    NSColor *c=[bitmap colorAtX:x y:y]; rgb[0]=c.redComponent; rgb[1]=c.greenComponent; rgb[2]=c.blueComponent;
}
static int CompareDoubles(const void *a, const void *b) {
    double x=*(const double *)a, y=*(const double *)b; return x<y?-1:x>y;
}
// Deck lines crossing a band free of cloud artwork: runs of rows whose blue
// excess stands above the local sky gradient. Returns centroids in view points.
static NSArray<NSNumber *> *DeckLines(NSBitmapImageRep *bitmap, NSRect band, CGFloat width, CGFloat height) {
    CGFloat sx=bitmap.pixelsWide/width, sy=bitmap.pixelsHigh/height;
    NSInteger x0=(NSInteger)ceil(NSMinX(band)*sx), x1=(NSInteger)floor(NSMaxX(band)*sx);
    NSInteger y0=(NSInteger)floor(NSMinY(band)*sy), rows=(NSInteger)ceil(NSMaxY(band)*sy)-y0;
    NSInteger radius=(NSInteger)ceil(10*sy), core=(NSInteger)ceil(2*sy);
    double value[rows], excess[rows], window[2*radius+1], rgb[3];
    for (NSInteger y=0;y<rows;y++) {
        double sum=0;
        for (NSInteger x=x0;x<x1;x++) { RGB(bitmap,x,y0+y,rgb); sum+=rgb[2]-rgb[0]; }
        value[y]=sum/MAX(1,x1-x0);
    }
    for (NSInteger y=0;y<rows;y++) {
        NSInteger n=0;
        for (NSInteger k=MAX(0,y-radius);k<=MIN(rows-1,y+radius);k++) if (labs(k-y)>core) window[n++]=value[k];
        qsort(window,(size_t)n,sizeof(double),CompareDoubles);
        excess[y]=n?value[y]-window[n/2]:0;
    }
    NSMutableArray *lines=[NSMutableArray array]; double mass=0, moment=0;
    for (NSInteger y=0;y<=rows;y++) {
        if (y<rows && excess[y]>.03) { mass+=excess[y]; moment+=excess[y]*(y0+y+.5); continue; }
        if (mass>.06) [lines addObject:@(moment/mass/sy)];
        mass=moment=0;
    }
    return lines;
}
static NSBitmapImageRep *Capture(NSView *view) {
    NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap]; return bitmap;
}
// Frames stacked top to bottom, for a person to compare transitions.
static void SaveSheet(NSArray<NSBitmapImageRep *> *frames, NSString *name) {
    NSString *directory=NSProcessInfo.processInfo.environment[@"ISOBAR_AVIATION_SHEETS"];
    if (!directory.length || !frames.count) return;
    NSInteger w=frames[0].pixelsWide, h=frames[0].pixelsHigh, gap=8, total=(NSInteger)frames.count*(h+gap)-gap;
    NSBitmapImageRep *sheet=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:w pixelsHigh:total bitsPerSample:8
        samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext=[NSGraphicsContext graphicsContextWithBitmapImageRep:sheet];
    [NSColor.whiteColor setFill]; NSRectFill(NSMakeRect(0,0,w,total));
    for (NSUInteger i=0;i<frames.count;i++) [frames[i] drawInRect:NSMakeRect(0,total-(NSInteger)(i+1)*h-(NSInteger)i*gap,w,h) fromRect:NSZeroRect
        operation:NSCompositingOperationSourceOver fraction:1 respectFlipped:NO hints:nil];
    [NSGraphicsContext restoreGraphicsState];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    [[sheet representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
        writeToFile:[directory stringByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]] atomically:YES];
}
// Counts whole-view renders the view makes of itself while a date changes.
@interface SnapshotCountingView : AviationForecastView
@property(nonatomic) BOOL counting;
@property(nonatomic) NSUInteger snapshots;
@end
@implementation SnapshotCountingView
- (void)cacheDisplayInRect:(NSRect)rect toBitmapImageRep:(NSBitmapImageRep *)bitmap {
    if (self.counting) self.snapshots++;
    [super cacheDisplayInRect:rect toBitmapImageRep:bitmap];
}
@end
// Drives the view like the playing map: one forecast minute per 60 fps frame.
// Returns the main-thread milliseconds of the date change that changed the TAF.
static double Replay(SnapshotCountingView *view, NSDate *first, NSTimeInterval clock, NSUInteger count,
                     void (^each)(NSUInteger frame, NSBitmapImageRep *bitmap)) {
    double startMs=NAN;
    for (NSUInteger frame=0;frame<count;frame++) { @autoreleasepool {
        [view advanceAnimationAtTime:clock+frame/60.0];
        NSDate *date=[first dateByAddingTimeInterval:60.0*frame];
        BOOL change=view.selectedDate && ![[view activePeriodsAtDate:view.selectedDate] isEqualToArray:[view activePeriodsAtDate:date]];
        view.counting=YES; NSTimeInterval began=NSProcessInfo.processInfo.systemUptime;
        view.selectedDate=date;
        if (change) startMs=(NSProcessInfo.processInfo.systemUptime-began)*1000;
        view.counting=NO;
        each(frame,Capture(view));
    } }
    return startMs;
}
static double Median(NSMutableArray<NSNumber *> *values) {
    [values sortUsingSelector:@selector(compare:)]; return values.count?[values[values.count/2] doubleValue]:NAN;
}
@interface KeyableWindow : NSWindow
@end
@implementation KeyableWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end
@interface TestVisibleWindow : NSWindow
@property(nonatomic) BOOL fakeVisible;
@property(nonatomic) NSWindowOcclusionState fakeOcclusionState;
@end
@implementation TestVisibleWindow
- (BOOL)isVisible { return self.fakeVisible; }
- (NSWindowOcclusionState)occlusionState { return self.fakeOcclusionState; }
@end

static BOOL PixelIsRed(NSBitmapImageRep *rep, NSInteger x, NSInteger y) {
    NSColor *color=[[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    return color && color.redComponent>0.85 && color.greenComponent<0.15 && color.blueComponent<0.15;
}
// AppKit calls this with a dirty rect in the lens's own coordinates that covers
// the popover window (negative origin, window-sized) when clipsToBounds is off.
// Filling that rect paints the map, the day strip and the lens bar white.
static void CheckLensFillStaysInsideBounds(void) {
    const NSInteger width=400, height=200;
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:width pixelsHigh:height
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace
        bytesPerRow:0 bitsPerPixel:0];
    NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:context];
    [[NSColor redColor] setFill];
    NSRectFill(NSMakeRect(0,0,width,height));
    NSAffineTransform *shift=[NSAffineTransform transform];
    [shift translateXBy:200 yBy:40];
    [shift concat];
    AviationLensView *lens=[[AviationLensView alloc] initWithFrame:NSMakeRect(0,0,120,80)];
    [lens drawRect:NSMakeRect(-200,-40,width,height)];
    [NSGraphicsContext restoreGraphicsState];
    NSInteger minX=width, minY=height, maxX=0, maxY=0, painted=0;
    for (NSInteger y=0; y<height; y++) {
        for (NSInteger x=0; x<width; x++) {
            if (PixelIsRed(rep,x,y)) continue;
            painted++;
            minX=MIN(minX,x); minY=MIN(minY,y); maxX=MAX(maxX,x); maxY=MAX(maxY,y);
        }
    }
    Check(PixelIsRed(rep,10,10) && PixelIsRed(rep,390,10) && PixelIsRed(rep,10,190),
        @"Fly lens drawRect paints outside its bounds");
    Check(painted>100 && minX>=190 && maxX<=330 && (maxX-minX)<=130 && (maxY-minY)<=90,
        @"Fly lens still fills its own bounds");
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    IsobarTestSetReduceMotion(NO);
    @try {
    CheckLensFillStaysInsideBounds();
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
    view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
    Check([view activePeriodsAtDate:end].count==0,@"TAF end is exclusive");
    NSString *pastEnd=[view summaryAtDate:end];
    Check([pastEnd containsString:@"TAF ends Sun 12 pm — showing last period"] && [pastEnd containsString:@"2,000 ft"] &&
        [pastEnd containsString:@"No TAF period"]==NO,@"past the TAF the last period stays, with a note");
    NSString *beforeStart=[view summaryAtDate:[start dateByAddingTimeInterval:-3600]];
    Check([beforeStart containsString:@"TAF starts Sat 8 pm — showing first period"] && [beforeStart containsString:@"10+ km"],
        @"before the TAF the first period stays, with a note");
    view.periods=@[
        @{@"start":start, @"end":[start dateByAddingTimeInterval:3600], @"ceiling":@"3,000 ft", @"visibility":@"10+ km"},
        @{@"start":[start dateByAddingTimeInterval:3*3600], @"end":end, @"ceiling":@"1,000 ft", @"visibility":@"5 km"}
    ];
    NSString *gap=[view summaryAtDate:[start dateByAddingTimeInterval:2*3600]];
    Check([gap containsString:@"No TAF period"] && [gap containsString:@"showing"]==NO,
        @"a gap inside the TAF still says there is no period");
    view.periods=outlook[@"periods"];
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
    Check([[view accessibilityValue] containsString:@"TAF ends Sun 12 pm — showing last period"] &&
        [[view accessibilityValue] containsString:@"2,000 ft"] && [[view valueForKey:@"panels"] count] > 0,
        @"a selected time past the TAF keeps the last period on the graphic");
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
        [view advanceAnimationAtTime:12.5]; NSBitmapImageRep *settledFade=capture();
        AviationForecastView *plain=[[AviationForecastView alloc] initWithFrame:view.frame];
        plain.periods=view.periods; plain.now=view.now;
        [plain inspectDate:UTC(@"2026-09-26T14:00:00Z")]; [plain advanceAnimationAtTime:12.5];
        Check(PixelDelta(settledFade,BitmapForView(plain,900,200),sky,900,200)<1, @"completed sky transitions settle on the plain forecast picture");
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
    Check([[view summaryAtDate:nightDate] containsString:@"Civil night"] && [[view summaryAtDate:nightDate] containsString:@"civil twilight start"], @"night summary exposes next morning civil twilight");
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

    // TAF changes while the map plays. A cut puts all of a change into one
    // frame and the former 0.4 s dissolve about 6% (smoothstep peaks at 1.5x
    // its mean rate: 1.5/24 frames). A 0.9 s ease puts at most 1.5/54 = 2.8%
    // into a frame, so 4% is the bound for a change the eye follows.
    NSMutableDictionary *changeTAF=[taf mutableCopy];
    NSSet *sheetFrames=[NSSet setWithArray:@[@14,@15,@21,@27,@33,@42,@51,@69]];
    NSMutableArray<NSNumber *> *startTimes=[NSMutableArray array], *frameTimes=[NSMutableArray array];
    for (NSArray *change in @[@[@"fly-fm",@"FM change",@"TAF YPPH 2612/2704 9999 BKN015 FM261500 9999 SCT030",@"2026-09-26T14:45:00Z"],
                              @[@"fly-tempo",@"TEMPO arrives",@"TAF YPPH 2612/2704 9999 BKN015 TEMPO 2615/2618 4000 BKN008",@"2026-09-26T14:45:00Z"],
                              @[@"fly-tempo-end",@"TEMPO ends",@"TAF YPPH 2612/2704 9999 BKN015 TEMPO 2615/2618 4000 BKN008",@"2026-09-26T17:45:00Z"]]) {
        BOOL tempo=[change[1] hasPrefix:@"TEMPO"];
        changeTAF[@"raw"]=change[2];
        SnapshotCountingView *fly=[[SnapshotCountingView alloc] initWithFrame:NSMakeRect(0,0,900,320)];
        NSWindow *flyWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,320) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        flyWindow.releasedWhenClosed=NO;
        @try {
            // Configured before it joins the window, as the app does, so the
            // replay starts from a settled sky.
            fly.periods=AviationOutlook(@{@"taf":changeTAF},start,fly.timeZone)[@"periods"]; fly.now=start;
            NSDate *first=UTC(change[3]);
            fly.selectedDate=[first dateByAddingTimeInterval:-60];
            [flyWindow.contentView addSubview:fly];
            NSRect sky=NSMakeRect(0,0,900,NSMinY(fly.timelineRect)-6);
            __block NSBitmapImageRep *previous=nil; __block double total=0, largest=0, widthStep=0;
            __block NSUInteger doubled=0, partialWidths=0;
            NSMutableArray<NSNumber *> *decks=[NSMutableArray array];
            NSMutableArray *sheet=[NSMutableArray array];
            __block CGFloat lastWidth=NAN;
            double startMs=Replay(fly,first,30,90,^(NSUInteger frame, NSBitmapImageRep *bitmap) {
                if (previous) { double step=PixelDelta(previous,bitmap,sky,900,320); total+=step; largest=MAX(largest,step); }
                previous=bitmap;
                if ([sheetFrames containsObject:@(frame)]) [sheet addObject:bitmap];
                CGFloat width=NSWidth([[[fly valueForKey:@"sceneRects"] firstObject] rectValue]);
                if (isfinite(lastWidth)) widthStep=MAX(widthStep,fabs(width-lastWidth));
                if (width<899 && width>500) partialWidths++;
                lastWidth=width;
                // BKN015 and SCT030 both leave x 322-383 clear of cloud artwork.
                NSArray *lines=DeckLines(bitmap,NSMakeRect(322,150,61,55),900,320);
                if (lines.count>1) doubled++;
                if (lines.count==1) [decks addObject:lines[0]];
            });
            SaveSheet(sheet,change[0]);
            NSString *line=[NSString stringWithFormat:@"fly %@: largest frame %.1f%% of the change, start %.2f ms, %lu snapshots",
                change[1],100*largest/MAX(1,total),startMs,(unsigned long)fly.snapshots];
            if (tempo) {
                fprintf(stderr,"%s, widest layout step %.1f pt over %lu partial frames\n",line.UTF8String,widthStep,(unsigned long)partialWidths);
                Check(widthStep<20 && partialWidths>20, @"panels re-lay out through intermediate widths, never an instant reflow");
            } else {
                BOOL monotonic=YES, between=NO;
                double from=decks.firstObject.doubleValue, to=decks.lastObject.doubleValue;
                for (NSUInteger i=0;i<decks.count;i++) {
                    double y=decks[i].doubleValue, part=(from-y)/MAX(1e-6,from-to);
                    if (i && y>decks[i-1].doubleValue+.3) monotonic=NO;
                    if (part>.25 && part<.75) between=YES;
                }
                fprintf(stderr,"%s, deck %.1f->%.1f pt, %lu double-deck frames\n",line.UTF8String,from,to,(unsigned long)doubled);
                Check(doubled==0 && monotonic && between && from-to>8, @"one cloud deck glides from BKN015 up to SCT030 instead of two decks overlaid");
                // Main-thread time of the date change that starts a transition,
                // and of the next frame, over settled alternations.
                NSDate *early=UTC(@"2026-09-26T14:50:00Z"), *late=UTC(@"2026-09-26T15:10:00Z");
                for (NSUInteger i=0;i<20;i++) { @autoreleasepool {
                    [fly advanceAnimationAtTime:40+2.0*i];
                    NSTimeInterval began=NSProcessInfo.processInfo.systemUptime;
                    fly.selectedDate=i%2?early:late;
                    NSTimeInterval changed=NSProcessInfo.processInfo.systemUptime;
                    (void)Capture(fly);
                    [startTimes addObject:@((changed-began)*1000)];
                    [frameTimes addObject:@((NSProcessInfo.processInfo.systemUptime-changed)*1000)];
                } }
            }
            Check(fly.snapshots==0, @"a TAF change starts without a synchronous whole-sky snapshot");
            Check(largest<total*.04, @"no frame of a TAF change carries a visible jump");
        } @finally { [fly removeFromSuperview]; [flyWindow close]; }
    }
    fprintf(stderr,"fly transition start: median %.2f ms main thread, next frame %.2f ms\n",Median(startTimes),Median(frameTimes));

    // Rapid back-and-forth between two TAF groups before the sky has moved:
    // however many blends are held, each change starts from the picture on
    // screen, so with no time elapsed nothing on screen changes.
    changeTAF[@"raw"]=@"TAF YPPH 2612/2704 9999 BKN015 FM261500 9999 SCT030";
    AviationForecastView *rapid=[[AviationForecastView alloc] initWithFrame:NSMakeRect(0,0,900,320)];
    rapid.periods=AviationOutlook(@{@"taf":changeTAF},start,rapid.timeZone)[@"periods"]; rapid.now=start;
    rapid.selectedDate=UTC(@"2026-09-26T14:50:00Z");
    NSWindow *rapidWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,320) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    rapidWindow.releasedWhenClosed=NO;
    @try {
        [rapidWindow.contentView addSubview:rapid]; [rapid advanceAnimationAtTime:80];
        NSBitmapImageRep *held=Capture(rapid); double flip=0;
        for (NSUInteger i=1;i<=6;i++) {
            rapid.selectedDate=UTC(i%2?@"2026-09-26T15:10:00Z":@"2026-09-26T14:50:00Z");
            flip=MAX(flip,PixelDelta(held,Capture(rapid),NSMakeRect(0,0,900,242),900,320));
        }
        fprintf(stderr,"fly rapid retargets: largest change with no time elapsed %.1f\n",flip);
        Check(flip<1, @"rapid retargets between frames leave the picture on screen unchanged");
    } @finally { [rapid removeFromSuperview]; [rapidWindow close]; }

    // A TEMPO that ends while its panel is still opening: the panel turns
    // back without reflowing its clouds, labels and visibility.
    changeTAF[@"raw"]=@"TAF YPPH 2612/2704 9999 BKN015 TEMPO 2615/2618 4000 BKN008";
    NSMutableArray *brief=[NSMutableArray array];
    for (NSDictionary *p in AviationOutlook(@{@"taf":changeTAF},start,view.timeZone)[@"periods"]) {
        NSMutableDictionary *copy=[p mutableCopy];
        if ([p[@"change"] isEqual:@"TEMPO"]) copy[@"end"]=UTC(@"2026-09-26T15:30:00Z");
        [brief addObject:copy];
    }
    SnapshotCountingView *turning=[[SnapshotCountingView alloc] initWithFrame:NSMakeRect(0,0,900,320)];
    turning.periods=brief; turning.now=start; turning.selectedDate=UTC(@"2026-09-26T14:44:00Z");
    NSWindow *turningWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,320) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    turningWindow.releasedWhenClosed=NO;
    @try {
        [turningWindow.contentView addSubview:turning];
        __block CGFloat lastWidth=NAN, reflow=0; __block NSUInteger tracked=0;
        Replay(turning,UTC(@"2026-09-26T14:45:00Z"),90,105,^(NSUInteger frame, NSBitmapImageRep *bitmap) {
            (void)frame; (void)bitmap;
            NSArray *frames=[turning valueForKey:@"panelFrames"];
            CGFloat width=frames.count>1?NSWidth([frames[1][@"content"] rectValue]):NAN;
            if (isfinite(width) && isfinite(lastWidth)) { reflow=MAX(reflow,fabs(width-lastWidth)); tracked++; }
            lastWidth=width;
        });
        fprintf(stderr,"fly TEMPO turns back mid-opening: content width moves %.1f pt in a frame over %lu frames\n",reflow,(unsigned long)tracked);
        Check(tracked>60 && reflow<1, @"a panel turning back mid-opening keeps its layout");
    } @finally { [turning removeFromSuperview]; [turningWindow close]; }

    // Forecast light follows the playing time itself, through dusk and across
    // a TAF change, rather than restarting short eases.
    AviationForecastView *twilightView=[[AviationForecastView alloc] initWithFrame:NSMakeRect(0,0,900,200)];
    NSWindow *duskWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,200) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    duskWindow.releasedWhenClosed=NO;
    @try {
        [duskWindow.contentView addSubview:twilightView];
        twilightView.latitude=-31.9403; twilightView.longitude=115.967003; twilightView.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
        NSDate *evening=[twilightView daylightAtDate:UTC(@"2026-09-26T04:00:00Z")][@"civilDusk"], *change=[evening dateByAddingTimeInterval:-50*60];
        NSMutableDictionary *before=[sceneCases[0] mutableCopy], *after=[sceneCases[1] mutableCopy];
        before[@"start"]=[evening dateByAddingTimeInterval:-3*3600]; before[@"end"]=change;
        after[@"start"]=change; after[@"end"]=[evening dateByAddingTimeInterval:3*3600];
        twilightView.periods=@[before,after];
        // The map plays one forecast hour a second; the playhead reaches a lens
        // on every frame or, from the time-lens chrome, five times a second
        // (2.5 degrees of Perth dusk apart). At 60 fps the sun sinks about
        // 0.21 degrees a frame: the light must stay within 0.3 degrees of the
        // playhead and never move more than 0.5 degrees in one frame.
        for (NSNumber *every in @[@1,@12]) {
            twilightView.now=before[@"start"];
            double worst=0, step=0, last=INFINITY; BOOL darkening=YES;
            for (NSUInteger frame=0;frame<90;frame++) {
                NSDate *date=[evening dateByAddingTimeInterval:(frame-60.0)*60];
                [twilightView advanceAnimationAtTime:60+10*every.doubleValue+frame/60.0];
                if (frame%every.unsignedIntegerValue==0) twilightView.selectedDate=date;
                double shown=[[twilightView valueForKey:@"displayedSolarElevation"] doubleValue];
                double exact=MAX(-8,MIN(2,SolarElevation(twilightView.latitude,twilightView.longitude,date)));
                if (frame) { worst=MAX(worst,fabs(shown-exact)); step=MAX(step,fabs(shown-last)); }
                if (shown>last+.01) darkening=NO;
                last=shown;
            }
            fprintf(stderr,"fly dusk replay, playhead every %lu frames: light within %.2f deg of the playing time, largest step %.2f deg\n",
                every.unsignedLongValue,worst,step);
            Check(worst<.3 && step<.5 && darkening, @"forecast light tracks the playing time continuously");
            // Pausing stops the playhead's updates: the light settles on the
            // last time sent, without a jump.
            double sent=MAX(-8,MIN(2,SolarElevation(twilightView.latitude,twilightView.longitude,twilightView.selectedDate))), settle=0;
            for (NSUInteger frame=90;frame<150;frame++) {
                [twilightView advanceAnimationAtTime:60+10*every.doubleValue+frame/60.0];
                double shown=[[twilightView valueForKey:@"displayedSolarElevation"] doubleValue];
                settle=MAX(settle,fabs(shown-last)); last=shown;
            }
            Check(settle<.5 && fabs(last-sent)<.05, @"a paused playhead leaves the light on the last time sent");
        }
    } @finally { [twilightView removeFromSuperview]; [duskWindow close]; }

    // Reduce Motion: the new TAF state is drawn at once.
    changeTAF[@"raw"]=@"TAF YPPH 2612/2704 9999 BKN015 FM261500 9999 SCT030";
    NSArray *changePeriods=AviationOutlook(@{@"taf":changeTAF},start,view.timeZone)[@"periods"];
    AviationForecastView *instant=[[AviationForecastView alloc] initWithFrame:NSMakeRect(0,0,900,320)];
    AviationForecastView *settledView=[[AviationForecastView alloc] initWithFrame:NSMakeRect(0,0,900,320)];
    for (AviationForecastView *v in @[instant,settledView]) { v.periods=changePeriods; v.now=start; [v advanceAnimationAtTime:50]; }
    instant.selectedDate=UTC(@"2026-09-26T14:50:00Z"); settledView.selectedDate=UTC(@"2026-09-26T15:10:00Z");
    NSWindow *instantWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,320) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    instantWindow.releasedWhenClosed=NO;
    @try {
        [instantWindow.contentView addSubview:instant]; (void)Capture(instant);
        IsobarTestSetReduceMotion(YES);
        instant.selectedDate=UTC(@"2026-09-26T15:10:00Z");
        NSBitmapImageRep *immediate=Capture(instant);
        Check(PixelDelta(immediate,BitmapForView(settledView,900,320),NSMakeRect(0,0,900,242),900,320)<1, @"Reduce Motion draws the new TAF state at once");
    } @finally { IsobarTestSetReduceMotion(NO); [instant removeFromSuperview]; [instantWindow close]; }
    NSDictionary *perthPlace=@{@"name":@"Perth coast",@"geohash":@"qd63czw",@"latitude":@(-31.994),@"longitude":@(115.75)};
    NSDictionary *sydneyPlace=@{@"name":@"Sydney",@"geohash":@"r3gx2sp",@"latitude":@(-33.85917663574219),@"longitude":@(151.2041473388672)};
    NSDictionary *ypph=@{@"code":@"YPPH",@"name":@"Perth Airport",@"latitude":@(-31.9403),@"longitude":@(115.967003),@"timeZone":@"Australia/Perth"};
    NSDictionary *yssy=@{@"code":@"YSSY",@"name":@"Sydney Airport",@"latitude":@(-33.946),@"longitude":@(151.177),@"timeZone":@"Australia/Sydney"};
    NSArray *fields=@[ypph,yssy];
    Check([FlyIdentityTitle(yssy) isEqual:@"Sydney Airport · YSSY"], @"the tooltip names the aerodrome and its ICAO");
    Check([FlyIdentityRow(perthPlace,ypph) isEqual:@"YPPH  21 km E"], @"the row is the ICAO and a compact distance");
    Check([FlyDistancePhrase(perthPlace,yssy) isEqual:@"3,296 km E of Perth coast"], @"distance and direction use the place");
    Check([FlyDistancePhrase(perthPlace,ypph) isEqual:@"21 km E of Perth coast"], @"Perth Airport is a short hop from Perth coast");
    Check([FlyDistanceCompact(perthPlace,ypph) isEqual:@"21 km E"], @"the row distance drops the place name");
    Check(FlyAerodromeCue(perthPlace,ypph,fields)==nil, @"Perth Airport needs no mismatch cue");
    NSDictionary *mismatch=FlyAerodromeCue(perthPlace,yssy,fields);
    Check(mismatch[@"text"]==nil && [mismatch[@"action"] isEqual:@"Nearest: YPPH"] && [mismatch[@"code"] isEqual:@"YPPH"],
        @"Sydney shown for Perth coast offers the nearest airport");
    Check(FlyAerodromeCue(sydneyPlace,yssy,fields)==nil, @"Sydney Airport is the nearest field to Sydney");
    NSDictionary *followed=FlyAerodromeForPlace(perthPlace,fields,@{});
    Check([followed[@"code"] isEqual:@"YPPH"], @"a place with no pin uses the nearest TAF aerodrome");
    followed=FlyAerodromeForPlace(perthPlace,fields,@{@"qd63czw":@"YSSY"});
    Check([followed[@"code"] isEqual:@"YSSY"], @"a session pin keeps the airport chosen for this place");
    followed=FlyAerodromeForPlace(sydneyPlace,fields,@{@"qd63czw":@"YSSY"});
    Check([followed[@"code"] isEqual:@"YSSY"], @"a pin for Perth does not follow the user to Sydney");
    followed=FlyAerodromeForPlace(sydneyPlace,fields,@{@"r3gx2sp":@"YPPH"});
    Check([followed[@"code"] isEqual:@"YPPH"], @"Sydney can pin a farther airport for this session");
    NSString *sample=@"TAF YPPH 261200Z 2612/2704 9999 SCT030 FM261505 4000 -SHRA BKN012 BECMG 2618/2620 BKN008 TEMPO 2612/2618 2000 RA PROB30 INTER 2622/2704 4000 TSRA BKN012";
    NSString *wrapped=AviationTAFWrapped(sample);
    Check([wrapped isEqual:@"TAF YPPH 261200Z 2612/2704 9999 SCT030\nFM261505 4000 -SHRA BKN012\nBECMG 2618/2620 BKN008\nTEMPO 2612/2618 2000 RA\nPROB30 INTER 2622/2704 4000 TSRA BKN012"],
        @"TAF groups break before FM, BECMG, TEMPO and PROB");
    Check(![AviationTAFWrapped(@"TAF YSSY 2612/2706 PROB40 TEMPO 2618/2622 4000") containsString:@"\nTEMPO"], @"PROB40 TEMPO stays one group");
    NSString *issued=@"TAF YPPH 261200Z 2612/2704 9999 SCT030 FM261505 4000 -SHRA BKN012 FM262200 9999 BKN020 PROB30 INTER 2622/2704 4000 TSRA BKN012";
    NSDictionary *product=@{@"metar":@{@"raw":@"METAR YPPH 261200Z 14012KT 9999 SCT034 BKN073",@"time":start},
        @"taf":@{@"raw":issued,@"valid_from":start,@"valid_to":end,@"issue_time":start}};
    NSTimeZone *perthZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSDictionary *beforeFM=AviationBulletin(product,@"YPPH",UTC(@"2026-09-26T15:04:00Z"),perthZone);
    NSDictionary *atFM=AviationBulletin(product,@"YPPH",UTC(@"2026-09-26T15:05:00Z"),perthZone);
    BOOL (^active)(NSDictionary *, NSString *)=^BOOL(NSDictionary *bulletin, NSString *fragment) {
        for (NSDictionary *line in bulletin[@"lines"]) if ([line[@"text"] containsString:fragment] && [line[@"active"] boolValue]) return YES;
        return NO;
    };
    Check(active(beforeFM,@"SCT030") && !active(beforeFM,@"FM261505"), @"the playhead highlights the base group before FM");
    Check(active(atFM,@"FM261505") && !active(atFM,@"SCT030"), @"the highlight moves to FM at the map playhead");
    Check([beforeFM[@"issued"] containsString:@"AWST"] && [beforeFM[@"issued"] containsString:@"UTC"] && [beforeFM[@"valid"] containsString:@"UTC"],
        @"issue and validity show the place's time and UTC");
    NSDictionary *missing=AviationBulletin(@{},@"YSSY",start,perthZone);
    Check([missing[@"metar"] isEqual:@"METAR unavailable"] && [missing[@"taf"] isEqual:@"No TAF issued for YSSY"], @"missing METAR and TAF are explicit");
    view.airportCode=@"YSSY"; view.latitude=-33.946; view.longitude=151.177;
    view.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Sydney"];
    NSDate *night=UTC(@"2026-09-27T14:00:00Z");
    NSString *graphicTitle=[view graphicTitleAtDate:night];
    Check([graphicTitle hasPrefix:@"YSSY TAF · Civil night · civil twilight start "] && ![graphicTitle containsString:@"BCT"], @"the graphic title carries the ICAO, night and plain civil twilight");
    NSFont *skyFont=[NSFont monospacedDigitSystemFontOfSize:10 weight:NSFontWeightSemibold];
    NSString *narrowSky=[view skyTitleAtDate:night width:120];
    CGFloat skyNeed=ceil([narrowSky sizeWithAttributes:@{NSFontAttributeName:skyFont}].width);
    Check(skyNeed<=120.5 && ![narrowSky containsString:@"…"] && ![narrowSky containsString:@"BCT"] && [narrowSky hasPrefix:@"TAF · night"],
        @"a 120 pt sky keeps night and plain twilight without ellipsis");
    NSString *tightSky=[view skyTitleAtDate:night width:80];
    CGFloat tightNeed=ceil([tightSky sizeWithAttributes:@{NSFontAttributeName:skyFont}].width);
    Check([tightSky isEqual:@"TAF · night"] && tightNeed<=80.5 && ![tightSky containsString:@"…"],
        @"a tighter sky shortens to TAF · night");
    Check([[view skyTitleAtDate:night width:420] containsString:@"civil twilight start"] && ![[view skyTitleAtDate:night width:420] containsString:@"YPPH"], @"wide sky names twilight without repeating the airport");
    view.airportCode=nil;
    AviationLensView *lens=[[AviationLensView alloc] initWithFrame:NSMakeRect(0,0,400,460)];
    lens.place=perthPlace; lens.aerodrome=yssy; lens.aerodromes=fields; lens.aviation=product;
    lens.notams=@{@"notices":@[@{@"id":@"N1",@"raw":@"NOTAM N1"},@{@"id":@"N2",@"raw":@"NOTAM N2"}]};
    lens.sigmets=@{@"features":@[@{@"id":@"S1",@"raw":@"SIGMET S1"}]};
    lens.now=start; lens.playhead=UTC(@"2026-09-26T15:05:00Z"); lens.placeZone=perthZone;
    NSWindow *lensWindow=[[KeyableWindow alloc] initWithContentRect:NSMakeRect(0,0,400,460) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    lensWindow.releasedWhenClosed=NO;
    @try {
        [lensWindow.contentView addSubview:lens];
        [lens reload]; [lens layoutSubtreeIfNeeded];
        Check([lens.airportButton.title isEqual:@"YSSY  3,296 km E"], @"the airport row is the ICAO and the distance");
        Check([lens.airportButton.toolTip containsString:@"Sydney Airport"] && [lens.airportButton.accessibilityLabel containsString:@"kilometres east of Perth coast"],
            @"the name and the spoken distance stay off the row");
        NSTextField *distanceField=nil;
        for (NSView *child in lens.subviews) if ([child.accessibilityIdentifier isEqual:@"aviation.distance"]) distanceField=(NSTextField *)child;
        Check(distanceField.hidden, @"the distance is on the airport row");
        Check([lens.nearestButton.title isEqual:@"Nearest: YPPH"] && !lens.nearestButton.hidden, @"a farther airport offers the nearest ICAO");
        NSButton *noticeCount=(NSButton *)LensControl(lens,@"aviation.notams");
        NSButton *sigmetCount=(NSButton *)LensControl(lens,@"aviation.sigmets");
        Check([noticeCount.title containsString:@"▣ 2"] && [sigmetCount.title containsString:@"⚠ 1"] &&
            ![noticeCount.title containsString:@"…"] && ![sigmetCount.title containsString:@"…"],
            @"NOTAM and SIGMET links show untruncated counts");
        NSDictionary *savedNotams=lens.notams, *savedSigmets=lens.sigmets;
        lens.notams=@{@"notices":@[
            @{@"raw":@"expired",@"effective_to":[start dateByAddingTimeInterval:-1]},
            @{@"raw":@"future",@"effective_from":[start dateByAddingTimeInterval:24*3600]},
            @{@"raw":@"cancelled",@"cancelled":@YES},
            @{@"raw":@"other airport",@"locations":@[@"YPPH"]},
            @{@"raw":@"estimated end",@"effective_to":[start dateByAddingTimeInterval:-1],@"estimated":@YES},
            @{@"raw":@"unknown validity",@"superseded":NSNull.null},
            @{@"raw":@"local",@"locations":@[@"yssy"],@"effective_from":start},
            @{@"id":@"no raw"}, @"malformed"]};
        lens.sigmets=@{@"features":NSNull.null}; [lens reload];
        Check([noticeCount.title isEqual:@"▣ 3"] && [sigmetCount.title isEqual:@"⚠ —"],@"counts match date, location, estimated and unknown-validity notice filtering");
        Check([noticeCount.toolTip containsString:@"NOTAM"] && [noticeCount.accessibilityLabel containsString:@"3"],@"symbol links name the product and count accessibly");
        lens.notams=savedNotams; lens.sigmets=savedSigmets; [lens reload]; [lens layoutSubtreeIfNeeded];
        Check(lens.bulletin.selectable && [lens.bulletin.accessibilityLabel isEqual:@"METAR and TAF"], @"the issued text is labelled for VoiceOver and can be copied");
        NSButton *source=(NSButton *)LensControl(lens,@"aviation.source");
        NSTextField *metarLine=(NSTextField *)LensControl(lens,@"aviation.metar");
        Check([lens.bulletin.string containsString:@"YPPH"]==NO && [lens.bulletin.string containsString:@"SCT030"]==NO &&
            [lens.bulletin.string containsString:@"METAR for YSSY unavailable"] && [lens.bulletin.string containsString:@"No TAF for YSSY yet"] &&
            lens.forecast.periods.count==0 && [lens.forecast.status isEqual:@"No TAF for YSSY yet"] &&
            source.hidden && [metarLine.stringValue isEqual:@"METAR for YSSY unavailable"] &&
            [metarLine.stringValue containsString:@"Vis"]==NO,
            @"YSSY selected with a YPPH product shows no Perth text, clouds or visibility");
        Check(!lens.airportButton.refusesFirstResponder && lens.airportButton.acceptsFirstResponder
            && !lens.nearestButton.refusesFirstResponder && lens.nearestButton.acceptsFirstResponder
            && lens.bulletin.selectable && lens.bulletin.acceptsFirstResponder,
            @"airport, nearest and text accept keyboard focus");
        NSTextField *cue=(NSTextField *)LensControl(lens,@"aviation.cue");
        NSButton *notams=(NSButton *)LensControl(lens,@"aviation.notams");
        NSButton *sigmets=(NSButton *)LensControl(lens,@"aviation.sigmets");
        CGFloat shared=MIN(NSMaxY(lens.airportButton.frame),NSMaxY(lens.nearestButton.frame))-MAX(NSMinY(lens.airportButton.frame),NSMinY(lens.nearestButton.frame));
        Check(cue.hidden && shared>14 && !lens.nearestButton.hidden,
            @"Nearest sits on the airport row and no mismatch sentence is drawn");
        lens.aerodrome=ypph; [lens reload]; [lens layoutSubtreeIfNeeded];
        source=(NSButton *)LensControl(lens,@"aviation.source");
        metarLine=(NSTextField *)LensControl(lens,@"aviation.metar");
        notams=(NSButton *)LensControl(lens,@"aviation.notams");
        sigmets=(NSButton *)LensControl(lens,@"aviation.sigmets");
        Check(lens.nearestButton.hidden, @"Perth Airport at Perth coast has no mismatch cue");
        Check([lens.bulletin.string containsString:@"METAR YPPH 261200Z"] && [lens.bulletin.string containsString:@"No TAF issued"]==NO &&
            [lens.bulletin.string containsString:@"\nFM261505"] && [lens.bulletin.string containsString:@"Ceiling"]==NO &&
            [lens.bulletin.string containsString:@"TAF Sat"]==NO,
            @"the panel shows the issued METAR and the TAF on group lines, once");
        Check([metarLine.stringValue containsString:@"☁"] && [metarLine.stringValue containsString:@"👁︎ 10+ km"] &&
            [metarLine.stringValue containsString:@"➝ 140/12"] && [metarLine.stringValue containsString:@"SCT034/BKN073"] &&
            [metarLine.stringValue containsString:@"140/12"] && [metarLine.stringValue containsString:@"20:00"] &&
            [metarLine.stringValue containsString:@"0 min"] &&
            !source.hidden && [source.title containsString:@"TAF 26 20:00"] && [source.title containsString:@"27 12:00"] &&
            [source.toolTip containsString:@"UTC"] && [source.title containsString:@"›"]==NO,
            @"METAR is one instrument row and the TAF span is one row");
        lens.playhead=[start dateByAddingTimeInterval:5*3600];
        [lens reload]; [lens layoutSubtreeIfNeeded];
        metarLine=(NSTextField *)LensControl(lens,@"aviation.metar");
        Check([metarLine.stringValue containsString:@"0 min"], @"METAR age stays on the observation clock when the playhead moves");
        lens.now=[start dateByAddingTimeInterval:27*60]; [lens reload]; [lens layoutSubtreeIfNeeded];
        Check([metarLine.stringValue containsString:@"27 min"] && ![metarLine.stringValue containsString:@"27 m "],@"27 minutes cannot be read as metres");
        lens.now=[start dateByAddingTimeInterval:3*3600];
        [lens reload]; [lens layoutSubtreeIfNeeded];
        metarLine=(NSTextField *)LensControl(lens,@"aviation.metar");
        Check([metarLine.stringValue containsString:@"3 h"] && [metarLine.stringValue containsString:@"0 min"]==NO,
            @"METAR age is now minus the METAR time");
        NSColor *ageColour=[metarLine.attributedStringValue attribute:NSForegroundColorAttributeName
            atIndex:metarLine.attributedStringValue.length-1 effectiveRange:NULL];
        ageColour=[ageColour colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        Check(ageColour && ageColour.redComponent>ageColour.greenComponent,
            @"an old METAR age is visibly tinted");
        lens.now=start; lens.playhead=UTC(@"2026-09-26T15:05:00Z");
        [lens reload]; [lens layoutSubtreeIfNeeded];
        source=(NSButton *)LensControl(lens,@"aviation.source");
        metarLine=(NSTextField *)LensControl(lens,@"aviation.metar");
        Check([metarLine.stringValue containsString:@"140/12"] &&
            !source.hidden && [source.title containsString:@"TAF 26 20:00"] && [source.title containsString:@"27 12:00"] &&
            [source.toolTip containsString:@"UTC"] && [source.title containsString:@"›"]==NO,
            @"METAR is one instrument row and the TAF span is one row");
        CGFloat fit420=[lens fittingHeightForWidth:420], fit900=[lens fittingHeightForWidth:900];
        Check(fit420>fit900 && fit420>220, @"fitting height remeasures bulletin wrapping at each width");
        lens.frame=NSMakeRect(0,0,420,260); [lens layoutSubtreeIfNeeded];
        Check(!lens.forecast.hidden && !metarLine.hidden && !source.hidden && NSHeight(lens.forecast.frame)>=110,
            @"a 260 pt narrow card keeps METAR, TAF and sky at the sky minimum");
        lens.headerTrailingInset=28; [lens layoutSubtreeIfNeeded];
        Check(NSMaxX(lens.airportButton.frame)<=NSWidth(lens.bounds)-28, @"close reservation relayouts an unchanged card size");
        lens.frame=NSMakeRect(0,0,640,260); [lens layoutSubtreeIfNeeded];
        Check(NSWidth(metarLine.frame)==640, @"medium card keeps the METAR on one full-width row");
        lens.frame=NSMakeRect(0,0,900,260); [lens layoutSubtreeIfNeeded];
        NSScrollView *shortScroll=nil; for (NSView *child in lens.subviews) if ([child isKindOfClass:NSScrollView.class]) shortScroll=(NSScrollView *)child;
        Check(!lens.forecast.hidden && !metarLine.hidden && !source.hidden && shortScroll && NSMinX(shortScroll.frame)>0,
            @"a wide short card keeps the instruments beside the issued text");
        lens.frame=NSMakeRect(0,0,400,460); [lens layoutSubtreeIfNeeded];
        NSButton *atmosphere=(NSButton *)LensControl(lens,@"aviation.atmosphere.open");
        Check(fabs(ControlBaseline(lens,notams)-ControlBaseline(lens,sigmets))<1 &&
            fabs(ControlBaseline(lens,notams)-ControlBaseline(lens,atmosphere))<1,
            @"NOTAMs, SIGMETs and Atmosphere share a baseline");
        Check(LineHighlighted(lens.bulletin,@"FM261505") && !LineHighlighted(lens.bulletin,@"9999 SCT030"), @"the text highlight follows the playhead");
        lens.playhead=UTC(@"2026-09-26T15:04:00Z");
        Check(LineHighlighted(lens.bulletin,@"9999 SCT030") && !LineHighlighted(lens.bulletin,@"FM261505"), @"moving the playhead moves the highlighted group");
        NSDate *pastTaf=[end dateByAddingTimeInterval:6*3600];
        lens.playhead=pastTaf;
        lens.forecast.timeZone=[NSTimeZone timeZoneWithName:@"Australia/Perth"];
        lens.forecast.selectedDate=pastTaf;
        Check([lens.bulletin.string containsString:@"SCT030"] && [lens.bulletin.string containsString:@"TSRA"] &&
            [lens.bulletin.string containsString:@"showing last period"]==NO,
            @"the issued TAF text is unchanged when the map is past the TAF");
        Check([[lens.forecast summaryAtDate:pastTaf] containsString:@"TAF ends Sun 12 pm — showing last period"] &&
            [[lens.forecast summaryAtDate:pastTaf] containsString:@"2,000 ft"],
            @"the graphic notes that it is showing the last TAF period");
    } @finally { [lens removeFromSuperview]; [lensWindow close]; }
    NSAppearance *aqua=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
    NSAppearance *dark=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    void (^paint)(NSDictionary *, NSDictionary *, NSDictionary *, NSString *)=^(NSDictionary *place, NSDictionary *field, NSDictionary *weather, NSString *name) {
        AviationLensView *panel=[[AviationLensView alloc] initWithFrame:NSZeroRect];
        panel.place=place; panel.aerodrome=field; panel.aerodromes=fields; panel.aviation=weather?:@{};
        panel.now=start; panel.playhead=start; panel.placeZone=perthZone;
        RenderLens(panel,[name stringByAppendingString:@"-light"],400,460,aqua);
        RenderLens(panel,[name stringByAppendingString:@"-dark"],400,460,dark);
        RenderLens(panel,[name stringByAppendingString:@"-compact-light"],640,210,aqua);
        RenderLens(panel,[name stringByAppendingString:@"-compact-dark"],640,210,dark);
    };
    NSString *sydneyIssued=@"TAF YSSY 261200Z 2612/2712 18015KT 9999 FEW040";
    NSDictionary *sydneyProduct=@{@"icao":@"YSSY",
        @"metar":@{@"icao":@"YSSY",@"raw":@"METAR YSSY 261200Z 18015KT 9999 FEW040 22/14 Q1018",@"time":start},
        @"taf":@{@"raw":sydneyIssued,@"valid_from":start,@"valid_to":end,@"issue_time":start}};
    paint(perthPlace,ypph,product,@"perth-ypph");
    paint(perthPlace,yssy,sydneyProduct,@"perth-yssy");
    paint(sydneyPlace,yssy,sydneyProduct,@"sydney-yssy");
    paint(perthPlace,yssy,@{},@"missing-taf");

    NSDate *stormStart=UTC(@"2026-10-06T12:00:00Z"), *stormEnd=UTC(@"2026-10-07T18:00:00Z");
    NSString *stormIssued=@"TAF AMD YPPH 061121Z 0612/0718 20010KT 9999 -SHRA NSC "
        @"INTER 0612/0614 VRB20G30KT 4000 TSRA SCT100CB "
        @"FM061500 20008KT CAVOK";
    NSString *stormMetar=@"METAR SPECI YPPH 061141Z 12007KT 9999 VCTS FEW035CB SCT069 BKN115 20/17 Q1015 RETS RESHRA";
    NSDictionary *stormProduct=@{@"metar":@{@"raw":stormMetar, @"time":UTC(@"2026-10-06T11:41:00Z")},
        @"taf":@{@"raw":stormIssued, @"valid_from":stormStart, @"valid_to":stormEnd, @"issue_time":UTC(@"2026-10-06T11:21:00Z")}};
    AviationLensView *stormLens=[[AviationLensView alloc] initWithFrame:NSMakeRect(0,0,400,460)];
    stormLens.place=perthPlace; stormLens.aerodrome=ypph; stormLens.aerodromes=fields; stormLens.aviation=stormProduct;
    stormLens.now=UTC(@"2026-10-06T12:30:00Z"); stormLens.playhead=stormLens.now; stormLens.placeZone=perthZone;
    NSWindow *stormWindow=[[KeyableWindow alloc] initWithContentRect:NSMakeRect(0,0,400,460) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    stormWindow.releasedWhenClosed=NO;
    @try {
        [stormWindow.contentView addSubview:stormLens];
        [stormLens reload]; [stormLens layoutSubtreeIfNeeded];
        Check([stormLens.airportButton.title isEqual:@"YPPH  21 km E"] && ![stormLens.airportButton.title containsString:@"CB"] &&
            ![stormLens.airportButton.title containsString:@"Thunder"],
            @"a convective aerodrome stays off the airport row");
        NSTextField *stormMetarLine=(NSTextField *)LensControl(stormLens, @"aviation.metar");
        NSString *stormText=stormMetarLine.attributedStringValue.string ?: @"";
        NSRange cbLead=[stormText rangeOfString:@"CB 3,500"];
        __block BOOL attachment=NO;
        [stormMetarLine.attributedStringValue enumerateAttribute:NSAttachmentAttributeName inRange:NSMakeRange(0, stormMetarLine.attributedStringValue.length) options:0 usingBlock:^(id value, NSRange range, BOOL *stop) {
            (void)range; if (value) { attachment=YES; *stop=YES; }
        }];
        NSColor *leadColour=cbLead.location==NSNotFound?nil:[stormMetarLine.attributedStringValue attribute:NSForegroundColorAttributeName atIndex:cbLead.location effectiveRange:NULL];
        leadColour=[leadColour colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        Check(!attachment && cbLead.location!=NSNotFound && ![stormText hasPrefix:@"FEW"] && ![stormText containsString:@"…"] &&
            [stormText containsString:@"VCTS"] && leadColour.redComponent>0.55 && leadColour.greenComponent<0.4 &&
            stormMetarLine.lineBreakMode!=NSLineBreakByTruncatingTail &&
            [stormMetarLine.toolTip containsString:@"Thunderstorm in vicinity"] && [stormMetarLine.toolTip containsString:@"CB base 3,500 ft"],
            @"the METAR row leads with VCTS and a red CB 3,500, with instrument glyphs or an ellipsis");
        CheckNoEllipsis(stormLens);
        Check([stormLens.forecast.toolTip containsString:@"Thunderstorm"] && [stormLens.forecast.toolTip containsString:@"CB base 10,000 ft"],
            @"the sky tooltip explains the INTER thunderstorm");
    } @finally { [stormLens removeFromSuperview]; [stormWindow close]; }

    view.showsTimeline=YES; view.now=stormStart; view.airportCode=@"YPPH";
    view.periods=@[@{@"change":@"FM", @"start":stormStart, @"end":stormEnd, @"ceilingFt":@2500, @"ceiling":@"2,500 ft",
        @"ceilingState":@"value", @"visibilityM":@8000, @"visibility":@"8 km", @"weather":@"—",
        @"cloudLayers":@[@{@"amount":@"BKN", @"baseFt":@2500, @"type":@""}]}];
    [view inspectDate:stormStart]; [view advanceAnimationAtTime:30];
    NSBitmapImageRep *fluffy=BitmapForView(view,900,220);
    view.periods=@[@{@"change":@"INTER", @"start":stormStart, @"end":[stormStart dateByAddingTimeInterval:2*3600],
        @"ceilingFt":@10000, @"ceiling":@"10,000 ft", @"ceilingState":@"value", @"visibilityM":@4000, @"visibility":@"4 km",
        @"weather":@"TSRA · CB", @"cloudLayers":@[@{@"amount":@"SCT", @"baseFt":@10000, @"type":@"CB"}]}];
    [view inspectDate:stormStart]; [view advanceAnimationAtTime:31];
    NSBitmapImageRep *anvil=BitmapForView(view,900,220);
    Check([[view summaryAtDate:stormStart] containsString:@"Thunderstorm"] && [[view summaryAtDate:stormStart] containsString:@"CB base 10,000 ft"] &&
        [[view summaryAtDate:stormStart] containsString:@"CB 10,000"],
        @"the sky names the cumulonimbus and the thunderstorm");
    Check(PixelDifference(fluffy, anvil, NSMakeRect(80,40,740,100), 900, 220)>400, @"a CB layer is not the fair-weather cumulus");
    NSUInteger fluffyRed=RedPixels(fluffy, NSMakeRect(0,0,900,220), 900, 220);
    NSUInteger anvilRed=RedPixels(anvil, NSMakeRect(0,0,900,220), 900, 220);
    Check(anvilRed>fluffyRed+30, @"a red TS tag is drawn with the CB");
    view.periods=@[@{@"change":@"FM", @"start":stormStart, @"end":stormEnd, @"ceilingFt":@3500, @"ceiling":@"3,500 ft",
        @"ceilingState":@"value", @"visibilityM":@9999, @"visibility":@"10+ km", @"weather":@"VCTS",
        @"cloudLayers":@[@{@"amount":@"FEW", @"baseFt":@3500, @"type":@""}]}];
    [view inspectDate:stormStart]; [view advanceAnimationAtTime:32];
    NSBitmapImageRep *vicinity=BitmapForView(view,900,220);
    Check([[view summaryAtDate:stormStart] containsString:@"Thunderstorm in vicinity"], @"VCTS is named as vicinity");
    Check(RedPixels(vicinity, NSMakeRect(820,20,70,120), 900, 220)>8 &&
        RedPixels(vicinity, NSMakeRect(200,40,400,80), 900, 220)<RedPixels(vicinity, NSMakeRect(820,20,70,120), 900, 220),
        @"VCTS sits at the edge of the sky, not over the field");
    fprintf(stderr,"aviation graph failures: %d\n",failures);
    } @finally { IsobarTestRestoreReduceMotion(); }
} return failures?1:0; }
