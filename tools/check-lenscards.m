// Read-only audit renderer. Offscreen only; never orders a window front.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#import <objc/runtime.h>
#undef main
#pragma clang diagnostic pop

@interface AuditController : Controller
@property NSSize budget;
@end
@implementation AuditController
- (NSSize)screenBudget { return self.budget; }
- (NSUserDefaults *)chartPreferences { return nil; }
@end
@interface AuditPopover : NSPopover
@end
@implementation AuditPopover
- (BOOL)isShown { return YES; }
// The host window owns this view; AppKit has no presented popover to close.
- (void)performClose:(id)sender { (void)sender; }
- (void)close {}
@end

static void NoFront(id self, SEL cmd, id sender) {
    (void)cmd; (void)sender;
    NSWindow *w = self;
    [w setFrameOrigin:NSMakePoint(-30000, -30000)];
}
static void NoActivate(id self, SEL cmd, BOOL flag) { (void)self; (void)cmd; (void)flag; }

static NSView *Find(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) { NSView *found = Find(child, identifier); if (found) return found; }
    return nil;
}
static void FindGPU(NSView *view, NSMutableArray *out) {
    if ([view isKindOfClass:GPUMapView.class] && !view.isHiddenOrHasHiddenAncestor) [out addObject:view];
    for (NSView *child in view.subviews) FindGPU(child, out);
}
static void Pump(NSTimeInterval s) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:s];
    while (until.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}
static void Blit(NSBitmapImageRep *src, NSBitmapImageRep *dst, NSRect r, CGFloat scale) {
    NSInteger ox = lround(r.origin.x * scale), oy = lround(r.origin.y * scale);
    for (NSInteger y = 0; y < src.pixelsHigh; y++) for (NSInteger x = 0; x < src.pixelsWide; x++) {
        NSInteger dx = ox + x, dy = oy + y;
        if (dx < 0 || dy < 0 || dx >= dst.pixelsWide || dy >= dst.pixelsHigh) continue;
        NSUInteger p[4]; [src getPixel:p atX:x y:y];
        if (p[3] == 0) continue;
        [dst setPixel:p atX:dx y:dy];
    }
}
static void Capture(NSView *root, NSString *path) {
    [root layoutSubtreeIfNeeded];
    NSMutableArray *gpus = [NSMutableArray array]; FindGPU(root, gpus);
    NSMutableArray *standins = [NSMutableArray array];
    for (GPUMapView *gpu in gpus) {
        [gpu waitForUploads];
        CGImageRef shot = [gpu copySnapshot];
        if (!shot) continue;
        NSImageView *pic = [NSImageView imageViewWithImage:[[NSImage alloc] initWithCGImage:shot size:gpu.bounds.size]];
        pic.frame = gpu.frame; pic.imageScaling = NSImageScaleAxesIndependently;
        // Directly above the GPU view: later siblings (legend, controls) stay on top.
        [gpu.superview addSubview:pic positioned:NSWindowAbove relativeTo:gpu];
        [standins addObject:pic];
        CGImageRelease(shot);
    }
    NSView *inspector = Find(root, @"forecast.inspector");
    BOOL restore = inspector && !inspector.hidden;
    if (restore) inspector.hidden = YES;
    NSRect b = root.bounds;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:lround(b.size.width*2)
        pixelsHigh:lround(b.size.height*2) bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    rep.size = b.size;
    [root cacheDisplayInRect:b toBitmapImageRep:rep];
    if (restore) {
        inspector.hidden = NO; [inspector layoutSubtreeIfNeeded];
        NSRect ib = inspector.bounds;
        NSBitmapImageRep *lr = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:lround(ib.size.width*2)
            pixelsHigh:lround(ib.size.height*2) bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
            colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        lr.size = ib.size;
        [inspector cacheDisplayInRect:ib toBitmapImageRep:lr];
        NSRect r = [inspector convertRect:ib toView:root];
        if (!root.isFlipped) r.origin.y = NSHeight(b) - NSMaxY(r);
        Blit(lr, rep, r, 2);
        NSString *cardPath=[[path stringByDeletingPathExtension] stringByAppendingString:@"-card.png"];
        [[lr representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:cardPath atomically:YES];
    }
    for (NSView *pic in standins) [pic removeFromSuperview];
    [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
    printf("wrote %s %.0fx%.0f\n", path.UTF8String, b.size.width, b.size.height);
}

static int failures;
static void Check(BOOL ok, NSString *message) {
    fprintf(stderr,"%s %s\n",ok?"ok  ":"FAIL",message.UTF8String);
    if (!ok) failures++;
}
static void CheckCard(NSView *root, NSInteger mode, Controller *controller) {
    NSView *card=Find(root,@"forecast.inspector");
    Check(card && NSContainsRect(root.bounds,[card convertRect:card.bounds toView:root]),@"card contained in viewport");
    Check(!Find(card,@"forecast.selectedTime") || Find(card,@"forecast.selectedTime").isHiddenOrHasHiddenAncestor,@"map owns the selected time readout");
    NSTextField *reading=(NSTextField *)Find(card,@"forecast.reading");
    if (reading) {
        CGFloat need=[reading.stringValue sizeWithAttributes:@{NSFontAttributeName:reading.font}].width;
        Check(need<=NSWidth(reading.frame)-4 && ![reading.stringValue containsString:@"…"],@"value row fits without truncation");
    }
    id graph=[controller valueForKey:@"forecastGraph"];
    Check([graph isDescendantOf:card],@"shared playhead targets the visible card");
    if (mode!=1) {
        Check(fabs([[graph valueForKey:@"horizonHours"] doubleValue]-[controller detailHorizonHours])<.001,@"card horizon equals map horizon");
        Check([[graph valueForKey:@"now"] isEqualToDate:[controller detailStartDate]],@"card axis starts with map axis");
        Check(NSContainsRect(card.bounds,[graph convertRect:[graph bounds] toView:card]),@"graph fits inside card");
    }
    if (mode==2) {
        Check(!Find(card,@"rain.headline") && [reading.stringValue containsString:@"mm/h"] && [reading.stringValue containsString:@"24 h"],@"rain has one amount row and explicit units");
        RainForecastView *rain=graph; NSDictionary *original=rain.outlook;
        NSDate *selected=[controller selectedForecastDate];
        NSMutableArray *hours=[NSMutableArray array];
        for (NSInteger i=0;i<24;i++) [hours addObject:@{@"start":[selected dateByAddingTimeInterval:i*3600],@"end":[selected dateByAddingTimeInterval:(i+1)*3600],@"known":@YES,@"mm":@1}];
        rain.outlook=@{@"hours":hours}; [controller updateForecastInspection:selected];
        Check([reading.stringValue isEqual:@"1.0 mm/h · 24 mm / 24 h"],@"rain total uses a complete selected 24-hour window");
        [hours removeLastObject]; rain.outlook=@{@"hours":hours}; [controller updateForecastInspection:selected];
        Check([reading.stringValue isEqual:@"1.0 mm/h · — mm / 24 h"],@"rain never fills a missing hour with zero");
        rain.outlook=original; [controller updateForecastInspection:selected];
    }
    if (mode==4) {
        Check([reading.stringValue containsString:@"ECMWF"] && [reading.stringValue containsString:@"°C"],@"temperature identifies model source and units");
        NSArray *series=[controller packFor:[controller rainPlace]][@"series"];
        Check([[graph valueForKey:@"rows"] isEqual:series],@"temperature card uses model series, with observations kept in the header");
        NSDate *selected=[controller selectedForecastDate];
        for (NSDate *instant in @[[controller valueForKey:@"chartNow"],[[controller valueForKey:@"chartNow"] dateByAddingTimeInterval:24*3600]]) {
            NSDictionary *sample=MapDetailSample(series,instant);
            [controller updateForecastInspection:instant];
            if ([sample[@"temp"] isKindOfClass:NSNumber.class])
                Check([reading.stringValue isEqual:[NSString stringWithFormat:@"%.0f °C · ECMWF",[sample[@"temp"] doubleValue]]],@"current and future card values both identify their model source");
        }
        [controller updateForecastInspection:selected];
    }
    if (mode==3) {
        Check(!reading,@"surf has only its wave/swell instrument row");
        Check(NSHeight([graph bounds])>=150,@"surf plot has room for three wave gridlines and wind");
    }
    if (mode==1) {
        AviationLensView *lens=(AviationLensView *)Find(card,@"popover.aviation");
        NSView *close=Find(card,@"forecast.close");
        for (NSView *control in @[lens.airportButton,lens.nearestButton])
            Check(control.hidden || !NSIntersectsRect([control convertRect:control.bounds toView:card],close.frame),@"airport control and close do not overlap");
        NSTextField *metar=(NSTextField *)Find(card,@"aviation.metar");
        Check(ceil(metar.attributedStringValue.size.width)<=NSWidth(metar.frame),@"METAR instrument stays on one untruncated row");
        for (NSString *identifier in @[@"aviation.metar",@"aviation.source",@"aviation.timeline"]) {
            NSView *view=Find(card,identifier);
            Check(view && !view.isHiddenOrHasHiddenAncestor,[identifier stringByAppendingString:@" present in both surfaces"]);
        }
        for (NSString *identifier in @[@"aviation.notams",@"aviation.sigmets"]) {
            NSButton *button=(NSButton *)Find(card,identifier);
            Check(button && ( [button.title rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet].location!=NSNotFound || [button.title containsString:@"—"]),@"notice link shows count or unknown");
            Check([button.title sizeWithAttributes:@{NSFontAttributeName:button.font}].width+4<=NSWidth(button.frame),@"notice count is untruncated");
        }
    }
}
int main(int argc, const char **argv) {
    setvbuf(stdout,NULL,_IONBF,0);
    if(argc!=3) return 2;
    @autoreleasepool {
        NSString *store=@(argv[1]), *out=@(argv[2]);
        [NSFileManager.defaultManager createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:nil];
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        for (NSString *selector in @[@"makeKeyAndOrderFront:",@"orderFront:",@"orderBack:",@"orderFrontRegardless"])
            method_setImplementation(class_getInstanceMethod(NSWindow.class,NSSelectorFromString(selector)),(IMP)NoFront);
        method_setImplementation(class_getInstanceMethod(NSApplication.class,@selector(activateIgnoringOtherApps:)),(IMP)NoActivate);
        AuditController *c=[AuditController new]; [c useManualLiveClock];
        [c setValue:@NO forKey:@"newMap"];
        c.budget=NSMakeSize(1512,982); [c replaceLocations:DefaultLocations()];
        c.popover=[AuditPopover new]; c.popover.animates=NO; c.popover.contentViewController=[NSViewController new];
        [c reloadStoreAtPath:store];
        [c setForecastPaused:YES];
        Check([c chartsReady],@"archive chart loads read-only");
        NSWindow *host=[[NSWindow alloc] initWithContentRect:NSMakeRect(-30000,-30000,1600,1200) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        host.releasedWhenClosed=NO;
        NSArray *lenses=@[@[@"rain",@2],@[@"temp",@4],@[@"kite",@0],@[@"surf",@3],@[@"fly",@1]];
        NSArray *looks=@[@[@"light",NSAppearanceNameAqua],@[@"dark",NSAppearanceNameDarkAqua]];
        @try {
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1512,982)],[NSValue valueWithSize:NSMakeSize(1280,720)]]) {
                c.budget=size.sizeValue; [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
                CGFloat closedWidth=c.popover.contentSize.width;
                for (NSArray *look in looks) for (NSArray *lens in lenses) {
                    NSApp.appearance=[NSAppearance appearanceNamed:look[1]];
                    [c applyLens:[lens[1] integerValue] rebuild:YES]; Pump(.03);
                    NSView *root=c.popover.contentViewController.view; [host setContentSize:c.popover.contentSize]; host.contentView=root;
                    root.appearance=[NSAppearance appearanceNamed:look[1]];
                    Check(fabs(c.popover.contentSize.width-closedWidth)<.5,@"popover width stays fixed when lens opens");
                    CheckCard(root,[lens[1] integerValue],c);
                    NSString *name=[NSString stringWithFormat:@"lenscards-pop-%.0fx%.0f-%@-%@.png",c.budget.width,c.budget.height,look[0],lens[0]];
                    Capture(root,[out stringByAppendingPathComponent:name]);
                }
            }
            [c setValue:@-1 forKey:@"forecastMode"];
            [c presentChartWindowInFrame:NSMakeRect(-30000,-30000,1512,982)];
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1512,982)],[NSValue valueWithSize:NSMakeSize(1024,768)]]) {
                NSSize sz=size.sizeValue; [c.chartWindow setFrame:NSMakeRect(-30000,-30000,sz.width,sz.height) display:NO];
                for (NSArray *look in looks) for (NSArray *lens in lenses) {
                    NSApp.appearance=[NSAppearance appearanceNamed:look[1]];
                    [c applyLens:[lens[1] integerValue] rebuild:YES]; Pump(.03);
                    NSView *root=c.chartWindow.contentView; root.appearance=[NSAppearance appearanceNamed:look[1]];
                    CheckCard(root,[lens[1] integerValue],c);
                    NSString *name=[NSString stringWithFormat:@"lenscards-exp-%.0fx%.0f-%@-%@.png",sz.width,sz.height,look[0],lens[0]];
                    Capture(root,[out stringByAppendingPathComponent:name]);
                }
            }
        } @finally { [c closeChartWindow]; [host orderOut:nil]; [host close]; }
        fprintf(stderr,"lens card failures: %d\n",failures);
    }
    return failures?1:0;
}
