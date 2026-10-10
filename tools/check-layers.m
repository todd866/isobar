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
- (BOOL)allowsAutomaticEvolution { return NO; }
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
// One lens row owns the map field and specialist panel; barbs remain a toggle.
static NSSegmentedControl *Field(Controller *c) {
    return (NSSegmentedControl *)Find(c.popover.contentViewController.view, @"popover.lens");
}
static NSButton *Barbs(Controller *c) { return (NSButton *)Find(c.popover.contentViewController.view, @"popover.barbs"); }
static NSInteger Segment(Controller *c, NSInteger tag) {
    NSSegmentedControl *field = Field(c);
    for (NSInteger i = 0; i < field.segmentCount; i++) if ([field tagForSegment:i] == tag) return i;
    return -1;
}
static BOOL Enabled(Controller *c, NSInteger tag) {
    if (tag == 3) return Barbs(c).enabled;
    if (tag == 4) return YES;
    return Field(c).enabled && (tag == -1 ? Segment(c, -1) >= 0 :
        (tag == 0 || tag == 1 || tag == 2 || tag == 5 || tag == 6));
}
static BOOL On(Controller *c, NSInteger tag) {
    if (tag == 3) return Barbs(c).state == NSControlStateValueOn;
    if (tag == 4) return NO;
    NSInteger field = [[c valueForKey:@"mapField"] integerValue];
    if (tag == 0) return field == 0;
    if (tag == 5) return field == 1;
    if (tag == 6) return field == 2;
    if (tag == 2) return field == 3 && ![[c valueForKey:@"tempAloft"] boolValue];
    if (tag == 1) return field == 3 && [[c valueForKey:@"tempAloft"] boolValue];
    return NO;
}
static void Select(Controller *c, NSInteger tag) {
    Check(Enabled(c, tag), [NSString stringWithFormat:@"layer %ld is available", (long)tag]);
    if (!Enabled(c, tag)) return;
    if (tag == 3) { [Barbs(c) performClick:nil]; return; }
    if (tag == 4) {
        NSButton *box = [NSButton checkboxWithTitle:@"Bureau chart" target:c action:@selector(toggleBureauChart:)];
        box.state = [[c valueForKey:@"sourceECMWF"] boolValue] ? NSControlStateValueOn : NSControlStateValueOff;
        [c toggleBureauChart:box];
        return;
    }
    NSSegmentedControl *field = Field(c);
    if (tag == 1 || tag == 2) {
        field.selectedSegment = Segment(c, 4);
        [NSApp sendAction:field.action to:field.target from:field];
        NSMenu *menu = [field menuForSegment:Segment(c, 4)];
        NSInteger index = [menu indexOfItemWithTag:tag];
        Check(index >= 0, @"Temp segment offers surface and 850 hPa");
        if (index >= 0) [menu performActionForItemAtIndex:index];
        Check([[c valueForKey:@"forecastMode"] integerValue] == 4 && Field(c).selectedSegment == 3,
            @"Temp menu retains the Temp lens and panel");
        return;
    }
    NSInteger lensTag = tag == 0 ? -1 : tag == 5 ? 2 : tag == 6 ? 5 : tag;
    NSInteger segment = Segment(c, lensTag);
    if (field.selectedSegment != segment || ![[c valueForKey:@"sourceECMWF"] boolValue]) {
        field.selectedSegment = segment;
        [NSApp sendAction:field.action to:field.target from:field];
    }
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
    OwnLayerOptions options = {.temperature=temperature <= 2 ? (int)temperature : 0,
        .windFill=temperature == 6, .rain=temperature == 5, .barbs=wind, .bare=bare};
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

static NSUserDefaults *SeededDefaults;
@interface SeededLayerController : Controller
@end
@implementation SeededLayerController
- (NSUserDefaults *)chartPreferences { return SeededDefaults; }
- (NSSize)screenBudget { return NSMakeSize(1024, 600); }
- (double)backingScale { return 1; }
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) { fprintf(stderr, "usage: check-layers STORE OUTPUT_DIRECTORY\n"); return 64; }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *store = [NSString stringWithUTF8String:argv[1]], *output = [NSString stringWithUTF8String:argv[2]];
        [NSFileManager.defaultManager createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *seedSuite = [@"com.isobar.layer-seed." stringByAppendingString:NSUUID.UUID.UUIDString];
        SeededDefaults = [[NSUserDefaults alloc] initWithSuiteName:seedSuite];
        [SeededDefaults setInteger:2 forKey:@"playbackSpeed"];
        [SeededDefaults setObject:@[@2, @0] forKey:@"mapDetailModes"];
        SeededLayerController *seeded = [SeededLayerController new];
        Check([[seeded valueForKey:@"liveSpeed"] integerValue] == 8 && [SeededDefaults objectForKey:@"playbackSpeed"] == nil,
            @"legacy speed ordinals cannot override the new 8x default");
        [SeededDefaults setInteger:256 forKey:kPlaybackSpeedKey];
        seeded = [SeededLayerController new];
        Check([[seeded valueForKey:@"liveSpeed"] integerValue] == 256, @"saved 256x is restored on launch");
        [SeededDefaults setInteger:3 forKey:kPlaybackSpeedKey];
        seeded = [SeededLayerController new];
        Check([[seeded valueForKey:@"liveSpeed"] integerValue] == 8, @"invalid speed falls back to 8x");
        Check([[seeded valueForKey:@"mapDetailModes"] count] == 0 && [SeededDefaults objectForKey:@"mapDetailModes"] == nil,
              @"a new launch does not restore lens chips");
        [SeededDefaults setInteger:2 forKey:@"chartTemperature"];
        [SeededDefaults setBool:YES forKey:@"chartRain"];
        [SeededDefaults setBool:YES forKey:@"chartWindFill"];
        seeded = [SeededLayerController new];
            Check([[seeded valueForKey:@"tempLayer"] integerValue] == 0 && ![[seeded valueForKey:@"rainLayer"] boolValue] &&
              ![[seeded valueForKey:@"windFill"] boolValue] && [[seeded valueForKey:@"mapField"] integerValue] == 0,
              @"launch opens on Pressure even with old saved fields");
        [SeededDefaults removePersistentDomainForName:seedSuite];
        NSString *suite = [@"com.isobar.layer-test." stringByAppendingString:NSUUID.UUID.UUIDString];
        LayerController *c = [LayerController new];
        [c useManualLiveClock];
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
            // Barbs draw on the classic map; this acceptance reads that map's pixels.
            [c setValue:@NO forKey:@"newMap"];
            [c reloadStoreAtPath:store];
            [c rebuildContent];
            [c useManualLiveClock];
            Check([c chartsReady] && !Model(c), @"starts with a readable Bureau map");
            NSBitmapImageRep *bureau = Bitmap(PopoverMap(c));
            for (NSInteger tag = 0; tag < 4; tag++) Check(!On(c,tag), @"Bureau has no selected model layer");
            Check(Field(c).selectedSegment == 0, @"Bureau opens in the map-only Pressure lens");
            Save(c.popover.contentViewController.view, output, @"bureau");

            // One segmented lens row and one barb toggle replace the old field row.
            NSSegmentedControl *field = Field(c);
            Check(field && field.segmentCount == 7 && field.trackingMode == NSSegmentSwitchTrackingSelectOne,
                @"map and panel choices are one seven-segment lens control");
            NSMutableArray *labels = [NSMutableArray array];
            for (NSInteger i = 0; i < field.segmentCount; i++) {
                [labels addObject:[field labelForSegment:i] ?: @""];
                Check([field imageForSegment:i] != nil && [field toolTipForSegment:i].length > 0,
                    @"each field segment has a symbol and a tooltip");
            }
            BOOL labelled = [Find(c.popover.contentViewController.view, @"popover.lensRow").identifier isEqual:@"labels"];
            fprintf(stderr, "      popover %.0f wide; field segments %s\n", NSWidth(c.popover.contentViewController.view.frame),
                labelled ? "labelled" : "symbols only");
            Check(labelled ? [labels isEqual:@[@"Pressure", @"Rain", @"Wind", @"Temp", @"Kite", @"Surf", @"Fly"]] : [labels isEqual:@[@"", @"", @"", @"", @"", @"", @""]],
                @"lens row reads Pressure · Rain · Wind · Temp · Kite · Surf · Fly, or symbols only when narrow");
            Check(Barbs(c) && Barbs(c).accessibilityLabel.length && Barbs(c).image, @"wind barbs are a labelled symbol toggle");
            NSMenu *temperature = [field menuForSegment:Segment(c, 4)];
            Check(temperature.numberOfItems == 2 && [temperature itemAtIndex:1].tag == 1,
                @"850 hPa is an option on Temp, not a top-level field");
            Check(![Find(c.popover.contentViewController.view, @"popover.lensRow") isKindOfClass:NSPopUpButton.class],
                @"the lens row is not a Layers pull-down");
            Check(NSWidth(field.frame) + 0.5 >= field.intrinsicContentSize.width, @"field segments are not truncated");

            NSMutableArray *pixels = [NSMutableArray array];
            for (NSNumber *layer in @[@2, @1, @0]) {
                Select(c, layer.integerValue);
                Check(Model(c) && On(c,layer.integerValue), @"field selection displays model layer");
                Check([c.testPreferences objectForKey:@"chartTemperature"] == nil &&
                    [[c.testPreferences stringForKey:@"chartSource"] isEqual:@"ecmwf"], @"source persists; the field stays in the session");
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
            NSPopUpButton *speedControl = (NSPopUpButton *)Find(c.popover.contentViewController.view,@"popover.speed");
            Check(speedControl && !speedControl.hidden && speedControl.enabled,
                @"speed is visible beside the map playback controls");
            NSMutableArray *multipliers = [NSMutableArray array];
            NSDate *playheadBefore = [[c valueForKey:@"live"] playhead];
            for (NSMenuItem *item in speedControl.itemArray) {
                [multipliers addObject:@(item.tag)];
                [speedControl selectItem:item];
                [NSApp sendAction:speedControl.action to:speedControl.target from:speedControl];
                Check([c.testPreferences integerForKey:kPlaybackSpeedKey] == item.tag &&
                    fabs([[c valueForKey:@"live"] hoursPerSecond]-(item.tag == 0 ? 1.0/3600.0 : item.tag/60.0))<1e-9,
                    @"visible speed control applies and saves real time or forecast minutes per second");
            }
            Check([multipliers isEqual:@[@0,@1,@2,@4,@8,@16,@32,@64,@128,@256]],
                @"visible speed control offers real time and all nine accelerated rates");
            Check([[speedControl.menu itemWithTag:0].title isEqual:@"Real time"] &&
                [[speedControl.menu itemWithTag:1].title isEqual:@"1 min/s"],
                @"real time is distinct from one forecast minute per second");
            Check(!playheadBefore || [playheadBefore isEqual:[[c valueForKey:@"live"] playhead]],
                @"changing visible speed preserves the playhead");
            Save(c.popover.contentViewController.view,output,@"speed-256-compact");
            [c applyPlaybackSpeed:8];
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

            Select(c,6);
            MatchesLayer(c,PopoverMap(c),shown,6,NO,YES,NO,@"wind colour");
            Check(Difference(withoutWind,Bitmap(PopoverMap(c))) > .01, @"wind speed colour visibly changes the map");
            Check(Find(c.popover.contentViewController.view,@"chart.legend.wind") != nil, @"wind scale stays visible on the map");
            Save(c.popover.contentViewController.view,output,@"wind-colour");
            Select(c,5);
            Check(![[c valueForKey:@"windFill"] boolValue] && [[c valueForKey:@"tempLayer"] integerValue] == 0,
                @"rain replaces the other colour fields");
            MatchesLayer(c,PopoverMap(c),shown,5,NO,YES,NO,@"rain colour");
            Check(Find(c.popover.contentViewController.view,@"chart.legend.rain") != nil,
                @"rain has a visible scale or unavailable cue");
            Save(c.popover.contentViewController.view,output,@"rain-colour");
            Select(c,0);

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
            NSSegmentedControl *expandedLens = (NSSegmentedControl *)Find(window.contentView, @"fullscreen.lens");
            Check(expandedLens && expandedLens.segmentCount == 7 && Find(window.contentView, @"fullscreen.barbs"),
                @"expanded map keeps the same seven-lens row and barb toggle");
            expandedLens.selectedSegment = 1;
            [NSApp sendAction:expandedLens.action to:expandedLens.target from:expandedLens];
            Check([c mapField] == 1 && [[c valueForKey:@"forecastMode"] integerValue] == 2 && Field(c).selectedSegment == 1,
                @"expanded Rain action couples the field, panel and popover selection");
            NSView *rainGraph = Find(window.contentView, @"rain.timeline");
            // UX-044: Rain has one amount row and no separate summary; its header controls sit clear of the graph.
            NSView *rainPlace = Find(window.contentView, @"rain.place");
            NSView *rainSource = Find(window.contentView, @"rain.source");
            BOOL rainClear = rainGraph && !Find(window.contentView, @"rain.headline");
            for (NSView *header in @[rainPlace ?: NSNull.null, rainSource ?: NSNull.null]) {
                if (![header isKindOfClass:NSView.class] || header.hidden) continue;
                NSRect a = [header convertRect:header.bounds toView:nil], b = [rainGraph convertRect:rainGraph.bounds toView:nil];
                if (NSIntersectsRect(a, b)) rainClear = NO;
            }
            Check(rainClear, [NSString stringWithFormat:@"expanded Rain graph stays clear of its header controls (graph %@)",
                rainGraph ? NSStringFromRect(rainGraph.frame) : @"missing"]);
            expandedLens = (NSSegmentedControl *)Find(window.contentView, @"fullscreen.lens");
            expandedLens.selectedSegment = 1;
            [NSApp sendAction:expandedLens.action to:expandedLens.target from:expandedLens];
            Check([c mapField] == 0 && [[c valueForKey:@"forecastMode"] integerValue] == -1 && Field(c).selectedSegment == 0,
                @"expanded Rain reselect returns both surfaces to Pressure");
            Check(Barbs(c).enabled && ((NSButton *)Find(window.contentView, @"fullscreen.barbs")).enabled,
                @"classic model surfaces enable wind barbs");
            [c setValue:@YES forKey:@"newMap"]; [c setValue:@NO forKey:@"gpuPresentFailed"];
            [c refreshMapFieldControls];
            Check(Barbs(c).enabled && ((NSButton *)Find(window.contentView, @"fullscreen.barbs")).enabled,
                @"both GPU surfaces enable projected wind vectors");
            [c setValue:@YES forKey:@"gpuPresentFailed"]; [c refreshMapFieldControls];
            Check(Barbs(c).enabled && ((NSButton *)Find(window.contentView, @"fullscreen.barbs")).enabled,
                @"both fallback surfaces restore wind barbs");
            [c setValue:@NO forKey:@"newMap"]; [c setValue:@NO forKey:@"gpuPresentFailed"];
            [c refreshMapFieldControls];
            NSPopUpButton *expandedSpeed = (NSPopUpButton *)Find(window.contentView,@"fullscreen.speed");
            Check(expandedSpeed && !expandedSpeed.hidden && expandedSpeed.enabled,
                @"expanded playback has a visible speed control");
            [expandedSpeed selectItemWithTag:256];
            [NSApp sendAction:expandedSpeed.action to:expandedSpeed.target from:expandedSpeed];
            NSPopUpButton *compactSpeed = (NSPopUpButton *)Find(c.popover.contentViewController.view,@"popover.speed");
            Check(expandedSpeed.selectedTag == 256 && compactSpeed.selectedTag == 256,
                @"expanded and compact speed controls stay synchronized");
            NSButton *reading = (NSButton *)Find(window.contentView, @"fullscreen.temperature");
            Check(reading && reading.attributedTitle.size.width <= NSWidth(reading.frame) + 1,
                @"expanded header reading fits beside the lens row without truncation");
            NSView *lensBox = Find(window.contentView, @"fullscreen.lensRow");
            Check(NSContainsRect(lensBox.superview.bounds, lensBox.frame), @"expanded lens row fits its toolbar");
            Save(window.contentView,output,@"speed-256-expanded");
            [c applyPlaybackSpeed:8];
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
            NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:180];
            while (preparation.operationCount>0 && deadline.timeIntervalSinceNow>0)
                [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.05]];
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.2]];
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
            for (NSInteger tag=0;tag<4;tag++) Check(!On(c,tag),@"Bureau clears active layer checks");
            // A saved ON wind preference is not an active layer on Bureau.
            [c setValue:@YES forKey:@"barbs"];
            [c rebuildContent];
            Check(!Barbs(c).enabled, @"barbs are disabled on the Bureau chart");
            [c toggleWindBarbs:nil];
            Check(!Model(c), @"disabled barbs do not switch chart source");

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
            Check(Find(c.popover.contentViewController.view, @"hub.days") != nil, @"popover keeps the seven-day strip");
            Check(Find(window.contentView, @"fullscreen.days") != nil, @"fullscreen keeps the seven-day strip"); // UX-046 deck
            NSInteger (^fieldNow)(void) = ^NSInteger { return [[c valueForKey:@"mapField"] integerValue]; };
            void (^lens)(NSInteger) = ^(NSInteger tag) {
                NSSegmentedControl *row = Field(c);
                NSInteger segment = Segment(c, tag);
                Check(segment >= 0, [NSString stringWithFormat:@"lens tag %ld exists", (long)tag]);
                if (segment < 0) return;
                row.selectedSegment = segment;
                [NSApp sendAction:row.action to:row.target from:row];
            };
            Select(c,0);
            Check(fieldNow() == 0, @"Pressure clears the previous field");
            lens(2);
            Check([[c valueForKey:@"forecastMode"] integerValue] == 2 && fieldNow() == 1 && On(c,5) &&
                  Find(c.popover.contentViewController.view, @"rain.place") != nil,
                  @"Rain couples the rain field to the rain panel");
            lens(2);
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 && fieldNow() == 0 && On(c,0),
                @"clicking the selected Rain lens returns to Pressure");
            lens(5);
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 && fieldNow() == 2 && On(c,6),
                @"Wind selects the wind-speed field and keeps the map-only panel");
            lens(0);
            Check([[c valueForKey:@"forecastMode"] integerValue] == 0 && fieldNow() == 2 &&
                  Find(c.popover.contentViewController.view, @"popover.windSpot") != nil,
                  @"Kite shares wind speed and opens the kite panel");
            lens(0);
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 && fieldNow() == 0,
                @"clicking the selected Kite lens returns to Pressure");
            lens(4);
            Check([[c valueForKey:@"forecastMode"] integerValue] == 4 && fieldNow() == 3 && On(c,2) &&
                  Find(c.popover.contentViewController.view, @"temperature.place") != nil,
                  @"Temp couples the surface field to the temperature panel");
            lens(4);
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 && fieldNow() == 0,
                @"clicking the selected Temp lens returns to Pressure");
            lens(3);
            Check([[c valueForKey:@"forecastMode"] integerValue] == 3 && fieldNow() == 0 &&
                  Find(c.popover.contentViewController.view, @"surf.spot") != nil,
                  @"Surf keeps pressure and opens the surf panel");
            lens(3);
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 && fieldNow() == 0,
                @"clicking the selected Surf lens returns to Pressure");
            lens(1);
            Check([[c valueForKey:@"forecastMode"] integerValue] == 1 && fieldNow() == 0 &&
                  Find(c.popover.contentViewController.view, @"aviation.bulletin") != nil,
                  @"Fly keeps pressure and opens the aviation panel");
            lens(1);
            Select(c,4);

            [c setValue:nil forKey:@"ownRun"];
            [c setValue:@[] forKey:@"frameIndices"];
            [c rebuildContent];
            NSBitmapImageRep *beforeMissing = Bitmap(PopoverMap(c));
            NSDictionary *prefs = [c.testPreferences persistentDomainForName:suite];
            for (NSInteger tag=0;tag<=3;tag++) Check(!Enabled(c,tag),@"unavailable model action disabled");
            // Even stale dispatched events cannot discard the working PDF.
            [c applyLens:2 rebuild:YES]; [c toggleWindBarbs:nil]; [c selectChartLayer:2];
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
