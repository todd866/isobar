// End-to-end layer regression: native menu -> controller -> displayed map pixels.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

// Exercise visible-surface refresh branches without ordering a window onscreen.
@interface TestLayerPopover : NSPopover
@property BOOL testShown;
@end
@implementation TestLayerPopover
- (BOOL)isShown { return self.testShown; }
@end
@interface TestLayerWindow : FullscreenWindow
@end
@implementation TestLayerWindow
- (BOOL)isVisible { return YES; }
@end
@interface LayerController : Controller
@property (nonatomic, strong) NSUserDefaults *testPreferences;
@end
@implementation LayerController
- (NSSize)screenBudget { return NSMakeSize(1024, 600); }
- (double)backingScale { return 1; }
- (NSUserDefaults *)chartPreferences { return self.testPreferences; }
@end

static int failures;
static void Check(BOOL ok, NSString *name) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", name.UTF8String);
    if (!ok) failures++;
}
static NSView *Find(NSView *root, NSString *identifier) {
    if ([root.accessibilityIdentifier isEqual:identifier]) return root;
    for (NSView *child in root.subviews) { NSView *found = Find(child, identifier); if (found) return found; }
    return nil;
}
static NSBitmapImageRep *Bitmap(NSView *view) {
    if (!view || NSIsEmptyRect(view.bounds)) return nil;
    [view layoutSubtreeIfNeeded];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    return rep;
}
static void Save(NSView *view, NSString *output, NSString *name) {
    NSData *png = [Bitmap(view) representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    Check([png writeToFile:[output stringByAppendingPathComponent:[name stringByAppendingString:@".png"]] atomically:YES],
          [@"capture " stringByAppendingString:name]);
}
// Sample the map interior; controls, text headings and borders cannot satisfy it.
static double Difference(NSBitmapImageRep *a, NSBitmapImageRep *b) {
    if (!a || !b || a.pixelsWide != b.pixelsWide || a.pixelsHigh != b.pixelsHigh) return NAN;
    NSUInteger count = 0, changed = 0;
    for (NSInteger y = 4; y < a.pixelsHigh - 4; y += 4) {
        for (NSInteger x = 4; x < a.pixelsWide - 4; x += 4) {
            NSColor *ca = [[a colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            NSColor *cb = [[b colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (fabs(ca.redComponent - cb.redComponent) > .025 ||
                fabs(ca.greenComponent - cb.greenComponent) > .025 ||
                fabs(ca.blueComponent - cb.blueComponent) > .025) changed++;
            count++;
        }
    }
    return count ? (double)changed / count : NAN;
}
static NSMenuItem *Item(Controller *c, NSInteger tag) {
    NSPopUpButton *popup = (NSPopUpButton *)Find(c.popover.contentViewController.view, @"popover.layers");
    for (NSMenuItem *item in popup.menu.itemArray)
        if (item.tag == tag && item.action == @selector(chooseLayerItem:)) return item;
    return nil;
}
static void Select(Controller *c, NSInteger tag) {
    NSPopUpButton *popup = (NSPopUpButton *)Find(c.popover.contentViewController.view, @"popover.layers");
    NSMenuItem *item = Item(c, tag);
    Check(item && item.enabled, [NSString stringWithFormat:@"layer %ld is available", (long)tag]);
    if (item && item.enabled) [popup.menu performActionForItemAtIndex:[popup.menu indexOfItem:item]];
}
static BOOL Model(Controller *c) { return [[c valueForKey:@"sourceECMWF"] boolValue]; }
static PDFCropView *PopoverMap(Controller *c) { return (PDFCropView *)Find(c.popover.contentViewController.view, @"popover.chart"); }

// Render explicit expected options, independently of controller layer state and
// its cache. A field mix-up, stale cached image or unchanged Bureau PDF must fail.
static void MatchesLayer(Controller *c, PDFCropView *actual, NSInteger index, NSInteger temperature,
                         BOOL wind, BOOL bare, BOOL previous, NSString *name) {
    OwnRun *run = [c valueForKey:previous ? @"previousRun" : @"ownRun"];
    NSArray *times = [c valueForKey:@"sequenceTimes"];
    NSInteger hour = previous && index < (NSInteger)times.count ? [c hourInRun:run matching:times[index]] : [c hourForSequenceIndex:index];
    OwnLayerOptions options = {.temperature=(int)temperature, .barbs=wind, .rain=1, .bare=bare};
    NSImage *expectedImage = OwnRunRender(run, hour, bare ? @"" : [c ecmwfPanelTitleForIndex:index], options, nil, 2);
    PDFCropView *expected = [[PDFCropView alloc] initWithFrame:actual.bounds];
    expected.drawsFrame = actual.drawsFrame;
    [expected setChartImage:expectedImage comparison:nil alpha:0];
    // AppKit applies a window's display colour profile while capturing. Give
    // the expected view the same profile; otherwise identical source images
    // differ merely because one view is attached to a window.
    NSWindow *reference = nil;
    if (actual.window) {
        reference = [[NSWindow alloc] initWithContentRect:actual.bounds
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        reference.releasedWhenClosed = NO;
        reference.colorSpace = actual.window.colorSpace;
        [reference.contentView addSubview:expected];
    }
    double diff = NAN;
    @try { diff = Difference(Bitmap(actual), Bitmap(expected)); }
    @finally { [reference close]; }
    fprintf(stderr, "      %s differs from expected by %.3f%%\n", name.UTF8String, diff * 100);
    Check(expectedImage && isfinite(diff) && diff < .002, [name stringByAppendingString:@" shows requested field"]);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) { fprintf(stderr, "usage: check-layers STORE OUTPUT_DIRECTORY\n"); return 64; }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *store = [NSString stringWithUTF8String:argv[1]], *output = [NSString stringWithUTF8String:argv[2]];
        [NSFileManager.defaultManager createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *suite = [@"com.isobar.layer-test." stringByAppendingString:NSUUID.UUID.UUIDString];
        LayerController *c = [LayerController new];
        Check([[c valueForKey:@"barbs"] boolValue], @"new installation starts with quiet wind hints on the model map");
        c.testPreferences = [[NSUserDefaults alloc] initWithSuiteName:suite];
        TestLayerPopover *popover = [TestLayerPopover new];
        popover.contentViewController = [NSViewController new];
        popover.testShown = YES;
        c.popover = popover;
        TestLayerWindow *window = nil;
        @try {
            NSString *clock = NSProcessInfo.processInfo.environment[@"ISOBAR_CHECK_NOW"];
            NSDate *now = clock ? [[NSISO8601DateFormatter new] dateFromString:clock] : NSDate.date;
            Check(now != nil, @"test clock is valid");
            [c setChartNow:now];
            [c replaceLocations:DefaultLocations()];
            [c setValue:@NO forKey:@"sourceECMWF"];
            [c setValue:@1 forKey:@"tempLayer"];
            [c setValue:@NO forKey:@"barbs"];
            [c reloadStoreAtPath:store];
            [c rebuildContent];
            Check([c chartsReady] && !Model(c), @"starts with a readable Bureau map");
            NSBitmapImageRep *bureau = Bitmap(PopoverMap(c));
            for (NSInteger tag = 0; tag < 4; tag++) Check(Item(c,tag).state == NSControlStateValueOff, @"Bureau has no selected model layer");
            Check(!Item(c,0).enabled, @"colour-off is disabled on uncoloured Bureau map");
            Save(c.popover.contentViewController.view, output, @"bureau");

            NSMutableArray *pixels = [NSMutableArray array];
            for (NSNumber *layer in @[@2, @1, @0]) {
                Select(c, layer.integerValue);
                Check(Model(c) && Item(c,layer.integerValue).state == NSControlStateValueOn, @"menu selection displays model layer");
                Check([c.testPreferences integerForKey:@"chartTemperature"] == layer.integerValue &&
                    [[c.testPreferences stringForKey:@"chartSource"] isEqual:@"ecmwf"], @"layer and source persisted to isolated preferences");
                PDFCropView *map = PopoverMap(c);
                MatchesLayer(c,map,map.sequenceIndex,layer.integerValue,NO,YES,NO, @"popover");
                NSBitmapImageRep *bitmap = Bitmap(map);
                if (bitmap) [pixels addObject:bitmap];
                Save(c.popover.contentViewController.view,output, [NSString stringWithFormat:@"temperature-%@",layer]);
            }
            if (pixels.count == 3) {
                double surface = Difference(pixels[0],pixels[1]), off = Difference(pixels[1],pixels[2]);
                fprintf(stderr,"      surface/aloft changed %.2f%%; aloft/off %.2f%%\n",surface*100,off*100);
                Check(surface > .01 && off > .01, @"temperature visibly changes map pixels");
            } else Check(NO,@"three layer captures exist");
            PDFCropView *map = PopoverMap(c);
            NSInteger shown = map.sequenceIndex;
            OwnRun *run = [c valueForKey:@"ownRun"];
            NSInteger hour = [c hourForSequenceIndex:shown];
            BOOL distinctFields = NO;
            for (NSInteger point=0; point<100; point++) {
                double t2m = [run valueAtPointIndex:point field:OwnRunFieldT2M hour:hour];
                double t850 = [run valueAtPointIndex:point field:OwnRunFieldT850 hour:hour];
                if (isfinite(t2m) && isfinite(t850) && fabs(t2m-t850)>.25) distinctFields=YES;
            }
            Check(distinctFields,@"surface and aloft use distinct finite data");
            NSBitmapImageRep *withoutWind = Bitmap(map);
            Select(c,3);
            map = PopoverMap(c);
            MatchesLayer(c,map,map.sequenceIndex,0,YES,YES,NO,@"wind");
            Check(Difference(withoutWind,Bitmap(map)) > .0005,@"wind feathers visibly change the map");
            Save(c.popover.contentViewController.view,output,@"wind");
            Select(c,3);
            Check(Difference(withoutWind,Bitmap(PopoverMap(c))) < .002,@"wind-off restores unfeathered map");

            // The fullscreen surface is one persistent map. Keep it offscreen,
            // and make sure layer actions refresh that same view without falling
            // back to the old overview/focused two-surface path.
            window = [[TestLayerWindow alloc] initWithContentRect:NSMakeRect(0,0,1024,600)
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            window.releasedWhenClosed = NO;
            window.contentView = [[ChartRoot alloc] initWithFrame:NSMakeRect(0,0,1024,600)];
            [c setValue:window forKey:@"chartWindow"];
            [c presentChartWindowInFrame:NSMakeRect(0,0,1024,600)];
            [c focusFullscreenPanel:shown];
            PDFCropView *fullscreenMap = [c panelViewAt:shown];
            Check(fullscreenMap != nil, @"fullscreen exposes one active map");
            for (NSNumber *layer in @[@2, @1, @0]) {
                Select(c,layer.integerValue);
                PDFCropView *active = [c panelViewAt:shown];
                Check(active == fullscreenMap, @"fullscreen keeps the same map view");
                MatchesLayer(c,active,shown,layer.integerValue,NO,YES,NO,@"fullscreen map after menu action");
                Save(window.contentView,output,[NSString stringWithFormat:@"focused-%@",layer]);
                [c focusFullscreenPanel:-1];
                Check([c panelViewAt:shown] == fullscreenMap, @"refocusing keeps the active map");
                MatchesLayer(c,[c panelViewAt:shown],shown,layer.integerValue,NO,YES,NO,@"map after refocusing current forecast");
                [c focusFullscreenPanel:shown];
            }
            Select(c,2);
            NSMutableDictionary *imageCache=[c valueForKey:@"chartCache"];
            [imageCache removeAllObjects];
            [c prepareChartImages];
            Check(!imageCache[[c chartImageKeyForIndex:shown bare:YES comparison:NO]],@"foreground request starts with a cold map during preparation");
            NSImage *cached = [c ecmwfImageForIndex:shown bare:YES comparison:NO];
            // Preparation now runs off the UI thread. Let it publish before
            // checking warm navigation, and ensure it keeps any image that an
            // immediate foreground request has already rendered.
            NSOperationQueue *preparation=[c valueForKey:@"chartPreparationQueue"];
            NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:15];
            while (preparation.operationCount>0 && deadline.timeIntervalSinceNow>0)
                [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
            Check(preparation.operationCount==0,@"bounded layer images finish background preparation");
            Check([c ecmwfImageForIndex:shown bare:YES comparison:NO]==cached,@"background preparation preserves an already displayed image");
            NSUInteger count = [[c valueForKey:@"chartCache"] count];
            [c stepFullscreenPanel:1];
            [c stepFullscreenPanel:-1];
            Check([c ecmwfImageForIndex:shown bare:YES comparison:NO] == cached && [[c valueForKey:@"chartCache"] count] == count,
                @"stepping reuses prepared layer images");
            MatchesLayer(c,[c panelViewAt:shown],shown,2,NO,YES,NO,@"returned frame");
            if ([c earlierIssueForIndex:shown] >= 0) {
                [c toggleIssueCompare];
                NSImage *comparison = [[c panelViewAt:shown] valueForKey:@"compareImage"];
                PDFCropView *previous = [[PDFCropView alloc] initWithFrame:NSMakeRect(0,0,640,480)];
                [previous setChartImage:comparison comparison:nil alpha:0];
                Check(comparison != nil,@"comparison image exists");
                MatchesLayer(c,previous,shown,2,NO,YES,YES,@"previous run");
                [c toggleIssueCompare];
            }
            Select(c,4);
            Check(!Model(c) && [c chartsReady],@"explicit source action returns to Bureau");
            Check(Difference(bureau,Bitmap(PopoverMap(c))) < .002,@"returning to Bureau restores original map");
            for (NSInteger tag=0;tag<4;tag++) Check(Item(c,tag).state == NSControlStateValueOff,@"Bureau clears active layer checks");
            // A saved ON wind preference is not an active layer on Bureau.
            [c setValue:@YES forKey:@"barbs"];
            [c rebuildContent];
            Select(c,3);
            Check(Model(c) && [[c valueForKey:@"barbs"] boolValue],@"wind from Bureau opens model with feathers on");
            Select(c,4);

            // End-of-range source switches must not jump back to the opening pair.
            NSDate *far = [now dateByAddingTimeInterval:30*86400];
            [c setValue:@[far,[far dateByAddingTimeInterval:43200]] forKey:@"sequenceTimes"];
            ChartPair pair = {0,1,YES};
            [c setValue:[NSValue value:&pair withObjCType:@encode(ChartPair)] forKey:@"pair"];
            [c setValue:@YES forKey:@"pairPinned"];
            Select(c,2);
            [[c valueForKey:@"pair"] getValue:&pair size:sizeof(pair)];
            NSInteger frames = [[c valueForKey:@"sequenceTimes"] count];
            Check(pair.valid && pair.left == frames-2 && pair.right == frames-1,@"colliding nearest times retain last adjacent pair");
            Select(c,4);

            [c setValue:nil forKey:@"ownRun"];
            [c setValue:@[] forKey:@"frameIndices"];
            [c rebuildContent];
            NSBitmapImageRep *beforeMissing = Bitmap(PopoverMap(c));
            NSDictionary *prefs = [c.testPreferences persistentDomainForName:suite];
            for (NSInteger tag=0;tag<=4;tag++) {
                NSMenuItem *item = Item(c,tag);
                Check(item && !item.enabled,@"unavailable model action disabled");
                // Even a stale dispatched event cannot discard the working PDF.
                [NSApp sendAction:item.action to:item.target from:item];
            }
            Check(!Model(c) && [c chartsReady] && Difference(beforeMissing,Bitmap(PopoverMap(c)))<.002,
                @"missing model data preserves working Bureau map");
            Check([prefs isEqual:[c.testPreferences persistentDomainForName:suite]],@"unavailable layers do not mutate preferences");
        } @catch (NSException *error) {
            Check(NO,[NSString stringWithFormat:@"exception: %@",error.reason]);
        } @finally {
            popover.testShown = NO;
            [c closeChartWindow];
            [window close];
            [c.testPreferences removePersistentDomainForName:suite];
        }
        fprintf(stderr,"layer acceptance failures: %d\n",failures);
        return failures ? 1 : 0;
    }
}
