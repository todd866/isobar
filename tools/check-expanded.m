// Offscreen acceptance and screenshots for the expanded weather surface.
// This harness imports the controller so it exercises the real layout. It never
// orders a window, activates the app, or writes user preferences.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wunused-function"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

#import <objc/runtime.h>

@interface ExpandedAcceptanceController : Controller
@property NSSize budget;
@property NSRect requestedMapFrame;
@property NSUInteger saves;
@property NSUInteger refreshes;
@end
@implementation ExpandedAcceptanceController
- (NSSize)screenBudget { return self.budget; }
- (double)backingScale { return 1; }
- (NSUserDefaults *)chartPreferences { return nil; }
- (void)saveLocations { self.saves++; }
- (void)refreshAll { self.refreshes++; }
- (void)attachGPUMapIn:(NSView *)root frame:(NSRect)frame popover:(BOOL)popover {
    if (!popover) self.requestedMapFrame = frame;
    [super attachGPUMapIn:root frame:frame popover:popover];
}
@end

// Local delegate probes: no system pasteboard or UI dragging session.
@interface AcceptancePasteboard : NSObject
@property NSString *value;
@end
@implementation AcceptancePasteboard
- (NSString *)stringForType:(NSPasteboardType)type { return [type isEqual:@"au.isobar.place-row"] ? self.value : nil; }
@end
@interface AcceptanceDrag : NSObject
@property id draggingSource;
@property AcceptancePasteboard *draggingPasteboard;
@end
@implementation AcceptanceDrag
@end

static void NoWindowOrder(id self, SEL cmd, id sender) { (void)self; (void)cmd; (void)sender; }
static void NoOrderWindow(id self, SEL cmd, NSInteger place, NSInteger relative) {
    (void)self; (void)cmd; (void)place; (void)relative;
}
static void NoPopoverShow(id self, SEL cmd, NSRect rect, NSView *view, NSUInteger edge) {
    (void)self; (void)cmd; (void)rect; (void)view; (void)edge;
}
static void NoActivate(id self, SEL cmd, BOOL flag) { (void)self; (void)cmd; (void)flag; }

static NSView *Find(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) {
        NSView *found = Find(child, identifier);
        if (found) return found;
    }
    return nil;
}

static void Pump(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}

static BOOL IsClippedText(NSView *view, NSString **hit) {
    if (view.hiddenOrHasHiddenAncestor) return NO;
    if ([view isKindOfClass:NSTextField.class]) {
        NSTextField *field = (NSTextField *)view;
        NSString *value = field.attributedStringValue.string ?: field.stringValue ?: @"";
        if ([value containsString:@"…"] || [value containsString:@"..."]) {
            if (hit) *hit = value;
            return YES;
        }
        if (value.length && field.font) {
            CGFloat need = ceil([value sizeWithAttributes:@{NSFontAttributeName: field.font}].width);
            if (need > NSWidth(field.bounds) + 1.0 && field.lineBreakMode == NSLineBreakByClipping) {
                if (hit) *hit = value;
                return YES;
            }
        }
    }
    if ([view isKindOfClass:NSButton.class]) {
        NSButton *button = (NSButton *)view;
        NSString *value = button.attributedTitle.string ?: button.title ?: @"";
        if ([value containsString:@"…"] || [value containsString:@"..."]) {
            if (hit) *hit = value;
            return YES;
        }
        if (value.length && button.font) {
            CGFloat need = ceil(button.attributedTitle.size.width);
            if (need > NSWidth(button.bounds) + 1.0 && button.lineBreakMode == NSLineBreakByClipping) {
                if (hit) *hit = value;
                return YES;
            }
        }
    }
    for (NSView *child in view.subviews) if (IsClippedText(child, hit)) return YES;
    return NO;
}

static NSData *PNGRegion(NSView *view, NSRect bounds) {
    [view layoutSubtreeIfNeeded];
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:MAX(1, lround(NSWidth(bounds) * 2)) pixelsHigh:MAX(1, lround(NSHeight(bounds) * 2))
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    rep.size = bounds.size;
    [view cacheDisplayInRect:bounds toBitmapImageRep:rep];
    return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

static int CheckExpandedGeometry(NSView *root, NSSize size, NSRect intendedMap) {
    int failures = 0;
    NSView *gpu = Find(root, @"fullscreen.gpu");
    NSString *clipped = nil;
    NSPopUpButton *speed = (NSPopUpButton *)Find(root, @"fullscreen.speed");
    for (NSMenuItem *item in speed.itemArray) {
        CGFloat needed = [item.title sizeWithAttributes:@{NSFontAttributeName:speed.font}].width + 26;
        if (needed > NSWidth(speed.frame) || [item.title containsString:@"…"]) failures++;
    }
    NSButton *reading = (NSButton *)Find(root, @"fullscreen.temperature");
    if ([reading.attributedTitle.string.lowercaseString containsString:@"now"] ||
        [reading.attributedTitle attribute:NSAttachmentAttributeName atIndex:0 effectiveRange:NULL]) failures++;
    for (NSString *identifier in @[@"fullscreen.newMap", @"fullscreen.zoomIn", @"fullscreen.zoomOut",
        @"fullscreen.zoomReset", @"fullscreen.zoom"])
        if (Find(root, identifier)) { fprintf(stderr, "forbidden expanded control %s\n", identifier.UTF8String); failures++; }
    // Map-first contract: the map owns the entire content rect and chrome floats
    // above it. The old deck/column assertions intentionally disappeared here.
    NSView *mapView = gpu ?: Find(root, @"window.chart");
    if (!mapView && intendedMap.size.width > 0) mapView = root;
    NSRect map = mapView ? [mapView convertRect:mapView.bounds toView:root] : intendedMap;
    NSRect content = root.bounds;
    NSRect hit = NSIntersectionRect(map, content);
    CGFloat fill = NSWidth(hit) * NSHeight(hit) / MAX(1, NSWidth(content) * NSHeight(content));
    if (!mapView || fill < .99) {
        fprintf(stderr, "map-first expanded map fill %.3f rect=%s content=%s\n", fill,
            NSStringFromRect(map).UTF8String, NSStringFromRect(content).UTF8String); failures++;
    }
    NSArray *chips = @[@"mapfirst.place", @"fullscreen.lensRow", @"mapfirst.bottom", @"mapfirst.actions"];
    NSMutableArray *chipViews = [NSMutableArray array];
    for (NSString *identifier in chips) {
        NSView *chip = Find(root, identifier);
        if (!chip) { fprintf(stderr, "missing expanded chip %s\n", identifier.UTF8String); failures++; continue; }
        [chipViews addObject:chip];
        NSArray *appearances=@[NSAppearanceNameAqua,NSAppearanceNameDarkAqua];
        if (chip.appearance || ![[chip.effectiveAppearance bestMatchFromAppearancesWithNames:appearances]
                isEqual:[root.window.effectiveAppearance bestMatchFromAppearancesWithNames:appearances]]) {
            fprintf(stderr, "chip does not inherit window appearance: %s\n", identifier.UTF8String); failures++;
        }
        if (IsClippedText(chip, &clipped)) { fprintf(stderr, "chip %s truncates %s\n", identifier.UTF8String, clipped.UTF8String); failures++; }
    }
    for (NSUInteger i = 0; i < chipViews.count; i++) for (NSUInteger j = i + 1; j < chipViews.count; j++) {
        NSView *first = chipViews[i], *second = chipViews[j];
        NSRect a = [first convertRect:first.bounds toView:root];
        NSRect b = [second convertRect:second.bounds toView:root];
        if (NSIntersectsRect(a, b)) { fprintf(stderr, "chips overlap: %s / %s\n", first.accessibilityIdentifier.UTF8String, second.accessibilityIdentifier.UTF8String); failures++; }
    }
    for (NSView *chip in chipViews) for (NSString *identifier in @[@"gpumap.flat", @"gpumap.sphere", @"gpumap.recenter", @"gpumap.north"]) {
        NSView *control = Find(root, identifier);
        if (!control || control.hiddenOrHasHiddenAncestor) continue;
        NSRect a = [chip convertRect:chip.bounds toView:root];
        NSRect b = [control convertRect:control.bounds toView:root];
        if (NSIntersectsRect(a, b)) { fprintf(stderr, "chip %s overlaps map control %s\n", chip.accessibilityIdentifier.UTF8String, identifier.UTF8String); failures++; }
    }
    NSUInteger dayCount = 0;
    for (NSUInteger i = 0; i < 7; i++) {
        NSView *day = Find(root, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)i]);
        if (!day || day.hiddenOrHasHiddenAncestor || NSWidth(day.bounds) < 1) { fprintf(stderr, "missing visible expanded day %lu\n", (unsigned long)i); failures++; }
        else dayCount++;
    }
    if (dayCount != 7) failures++;
    NSView *lensColumn = Find(root, @"fullscreen.lensRow");
    if (!lensColumn) { fprintf(stderr, "missing expanded floating lens column\n"); failures++; }
    for (NSUInteger i = 0; i < 8; i++) {
        NSString *identifier = [NSString stringWithFormat:@"fullscreen.lens.%lu", (unsigned long)i];
        NSView *button = Find(root, identifier);
        if (!button || button.hiddenOrHasHiddenAncestor || NSWidth(button.bounds) < 1) {
            fprintf(stderr, "missing visible lens button %s\n", identifier.UTF8String); failures++;
        }
    }
    if (Find(root, @"hub.playheadDot") || Find(root, @"fullscreen.range") || Find(root, @"hub.range")) {
        fprintf(stderr, "obsolete day range/dot element remains\n"); failures++;
    }
    printf("layout %.0fx%.0f: map %.2f%%, chips %lu, days %lu\n", size.width, size.height, fill*100,
        (unsigned long)chipViews.count, (unsigned long)dayCount);
    return failures;
}

static int CheckPopover(NSView *root) {
    NSString *clipped = nil;
    int failures = 0;
    if (IsClippedText(root, &clipped)) { fprintf(stderr, "popover compact readout clipped: %s\n", clipped.UTF8String ?: "unknown"); failures++; }
    if (Find(root, @"popover.windDirectionText") && Find(root, @"popover.windArrow")) failures++;
    if (Find(root, @"popover.nowFiller")) failures++;
    NSView *map = Find(root, @"popover.gpu") ?: Find(root, @"popover.chart");
    NSRect content = root.bounds;
    NSRect mapRect = map ? [map convertRect:map.bounds toView:root] : NSZeroRect;
    NSRect hit = NSIntersectionRect(content, mapRect);
    CGFloat fill = NSWidth(hit) * NSHeight(hit) / MAX(1, NSWidth(content) * NSHeight(content));
    if (!map || fill < .99) { fprintf(stderr, "popover map-first fill %.3f\n", fill); failures++; }
    NSMutableArray *chips = [NSMutableArray array];
    for (NSString *identifier in @[@"mapfirst.place", @"popover.lensRow", @"mapfirst.bottom", @"mapfirst.actions"]) {
        NSView *chip = Find(root, identifier);
        if (!chip) { fprintf(stderr, "missing popover chip %s\n", identifier.UTF8String); failures++; }
        else [chips addObject:chip];
    }
    for (NSUInteger i = 0; i < chips.count; i++) for (NSUInteger j = i + 1; j < chips.count; j++) {
        NSView *aView = chips[i], *bView = chips[j];
        if (NSIntersectsRect([aView convertRect:aView.bounds toView:root], [bView convertRect:bView.bounds toView:root])) failures++;
    }
    for (NSUInteger i = 0; i < 7; i++) {
        NSView *day = Find(root, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)i]);
        if (!day || day.hiddenOrHasHiddenAncestor || NSWidth(day.bounds) < 1) failures++;
    }
    if (!Find(root, @"popover.lensRow")) failures++;
    for (NSUInteger i = 0; i < 8; i++) {
        NSView *button = Find(root, [NSString stringWithFormat:@"popover.lens.%lu", (unsigned long)i]);
        if (!button || button.hiddenOrHasHiddenAncestor || NSWidth(button.bounds) < 1) failures++;
    }
    if (Find(root, @"hub.playheadDot") || Find(root, @"popover.range") || Find(root, @"hub.range")) failures++;
    return failures;
}

static int CheckWarningBadge(NSView *root, NSArray *warnings) {
    NSDictionary *model = WarningBadgeModel(warnings);
    NSButton *badge = (NSButton *)Find(root, @"hub.warning");
    if (!badge) badge = (NSButton *)Find(root, @"fullscreen.warning");
    if (![model[@"text"] length]) return badge ? 1 : 0;
    if (![badge isKindOfClass:NSButton.class]) return 1;
    NSColor *tint = [badge.contentTintColor colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    BOOL amber = tint && tint.greenComponent > tint.redComponent * .45 && tint.redComponent > tint.blueComponent * 1.5;
    if (![badge.title isEqual:model[@"text"]] || ![badge.toolTip isEqual:model[@"tooltip"]] ||
        ([model[@"severity"] isEqual:@"advisory"] && !amber)) {
        fprintf(stderr, "warning badge text/tint/tooltip failed: %s / %s\n",
            badge.title.UTF8String ?: "", badge.toolTip.UTF8String ?: "");
        return 1;
    }
    NSColor *textColor = [badge.attributedTitle attribute:NSForegroundColorAttributeName atIndex:0 effectiveRange:NULL];
    return textColor && [textColor isEqual:badge.contentTintColor] ? 0 : 1;
}

static int CheckSettings(ExpandedAcceptanceController *c) {
    int failed = 0;
    NSWindow *window = [c valueForKey:@"settingsWindow"];
    NSView *form = window.contentView;
    NSString *hit = nil;
    if (NSHeight(form.frame) > 400 || IsClippedText(form, &hit)) failed++;
    for (NSView *view in form.subviews) if (!NSContainsRect(form.bounds, view.frame)) failed++;
    NSTableView *table = (NSTableView *)Find(form, @"settings.places");
    NSArray *before = [[c valueForKey:@"locations"] copy];
    AcceptanceDrag *drag = [AcceptanceDrag new]; drag.draggingSource = table;
    drag.draggingPasteboard = [AcceptancePasteboard new]; drag.draggingPasteboard.value = @"0";
    id writer = [c tableView:table pasteboardWriterForRow:0];
    if (![[writer stringForType:@"au.isobar.place-row"] isEqual:@"0"]) failed++;
    if ([c tableView:table validateDrop:(id)drag proposedRow:2 proposedDropOperation:NSTableViewDropOn] != NSDragOperationMove) failed++;
    if (![c tableView:table acceptDrop:(id)drag row:2 dropOperation:NSTableViewDropAbove] ||
        ![[c valueForKey:@"locations"][1] isEqual:before[0]] || c.saves != 1) failed++;
    drag.draggingPasteboard.value = @"1";
    if (![c tableView:table acceptDrop:(id)drag row:0 dropOperation:NSTableViewDropAbove] ||
        ![[c valueForKey:@"locations"] isEqual:before] || c.saves != 2) failed++;
    drag.draggingPasteboard.value = @"garbage";
    if ([c tableView:table acceptDrop:(id)drag row:1 dropOperation:NSTableViewDropAbove]) failed++;
    drag.draggingSource = [NSView new];
    if ([c tableView:table validateDrop:(id)drag proposedRow:1 proposedDropOperation:NSTableViewDropAbove] != NSDragOperationNone) failed++;
    NSPopover *search = [c valueForKey:@"placesSearchPopover"];
    NSTextField *field = (NSTextField *)Find(search.contentViewController.view, @"settings.search");
    field.stringValue = @"Sydney"; [c searchLocations:field];
    if (![[c valueForKey:@"searchResults"] count]) failed++;
    field.stringValue = @""; [c searchLocations:field];
    if ([[c valueForKey:@"searchResults"] count]) failed++;
    NSTableView *results = [c valueForKey:@"searchTable"];
    NSDictionary *extra = @{ @"name": @"Test coast", @"state": @"WA", @"geohash": @"qa-place", @"latitude": @-31.5, @"longitude": @115.8 };
    [c setValue:@[extra] forKey:@"searchResults"]; [results reloadData];
    [results selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO];
    [c addLocation:nil];
    if ([[c valueForKey:@"locations"] count] != before.count + 1 || c.refreshes != 1) failed++;
    [table selectRowIndexes:[NSIndexSet indexSetWithIndex:before.count] byExtendingSelection:NO];
    [c removeLocation:nil];
    if (![[c valueForKey:@"locations"] isEqual:before] || c.refreshes != 2) failed++;
    printf("settings drag/add/remove/search failures: %d\n", failed);
    return failed;
}

static int Capture(NSView *view, NSString *path) {
    GPUMapView *gpu = (GPUMapView *)Find(view, @"fullscreen.gpu");
    if (!gpu) gpu = (GPUMapView *)Find(view, @"popover.gpu");
    if ([gpu isKindOfClass:GPUMapView.class]) [gpu waitForUploads];
    // Use the production feedback compositor so a full-bleed Metal map and
    // every native chip/control are captured in their real z-order.
    NSData *png = FeedbackViewPNG(view, [gpu isKindOfClass:GPUMapView.class] ? gpu : nil);
    if (!png) png = PNGRegion(view, view.bounds);
    if (!png.length || ![png writeToFile:path atomically:YES]) return 1;
    printf("wrote %s\n", path.UTF8String);
    return 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 3) { fprintf(stderr, "usage: check-expanded STORE OUTPUT\n"); return 64; }
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(makeKeyAndOrderFront:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderFront:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderBack:)), (IMP)NoWindowOrder);
        method_setImplementation(class_getInstanceMethod(NSWindow.class, @selector(orderWindow:relativeTo:)), (IMP)NoOrderWindow);
        method_setImplementation(class_getInstanceMethod(NSPopover.class, @selector(showRelativeToRect:ofView:preferredEdge:)), (IMP)NoPopoverShow);
        method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:)), (IMP)NoActivate);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *store = @(argv[1]), *output = @(argv[2]);
        [NSFileManager.defaultManager createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:nil];
        ExpandedAcceptanceController *c = [ExpandedAcceptanceController new];
        c.budget = NSMakeSize(1512, 982);
        [c useManualLiveClock];
        [c replaceLocations:DefaultLocations()];
        [c reloadStoreAtPath:store];
        if (![c chartsReady]) { fprintf(stderr, "chart unavailable\n"); return 1; }
        int failures = 0;
        NSString *hub = [c hubPlace][@"geohash"] ?: @"";
        NSArray *realWarnings = [c packFor:[c hubPlace]][@"warnings"] ?: @[];
        [c noteWeatherForGeohash:hub obs:nil daily:nil hourly:nil warnings:@[
            @{ @"shortTitle": @"Sheep Graziers Warning", @"title": @"Sheep Graziers Warning", @"text": @"Cold conditions" },
            @{ @"shortTitle": @"Frost Warning", @"title": @"Frost Warning", @"text": @"Frost likely" },
        ]];
        [c rebuildContent]; Pump(.2);
        NSView *popover = c.popover.contentViewController.view;
        popover.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        failures += CheckPopover(popover) + CheckWarningBadge(popover, [c packFor:[c hubPlace]][@"warnings"]);
        [c noteWeatherForGeohash:hub obs:nil daily:nil hourly:nil warnings:realWarnings];
        [c rebuildContent]; popover = c.popover.contentViewController.view;
        popover.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        failures += Capture(popover, [output stringByAppendingPathComponent:@"popover-light.png"]);
        [PNGRegion(popover, NSMakeRect(0, 0, NSWidth(popover.bounds), 50)) writeToFile:[output stringByAppendingPathComponent:@"popover-header-light.png"] atomically:YES];
        popover.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        [PNGRegion(popover, NSMakeRect(0, 0, NSWidth(popover.bounds), 50)) writeToFile:[output stringByAppendingPathComponent:@"popover-header-dark.png"] atomically:YES];
        failures += Capture(popover, [output stringByAppendingPathComponent:@"popover-dark.png"]);
        [c openSettings:nil]; Pump(.1);
        NSWindow *settings = [c valueForKey:@"settingsWindow"];
        NSArray *settingIDs = @[@"settings.places", @"settings.add", @"settings.remove",
            @"settings.newMap", @"settings.playbackSpeed"];
        for (NSString *identifier in settingIDs) if (!Find(settings.contentView, identifier)) {
            fprintf(stderr, "settings identifier missing: %s\n", identifier.UTF8String); failures++;
        }
        NSButton *addPlace = (NSButton *)Find(settings.contentView, @"settings.add");
        if ([addPlace isKindOfClass:NSButton.class]) {
            [c openPlaceSearch:addPlace];
            NSPopover *searchPopover = [c valueForKey:@"placesSearchPopover"];
            if (!searchPopover || !Find(searchPopover.contentViewController.view, @"settings.search")) {
                fprintf(stderr, "settings identifier missing: settings.search\n"); failures++;
            }
        }
        failures += CheckSettings(c);
        settings.contentView.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        failures += Capture(settings.contentView, [output stringByAppendingPathComponent:@"settings-light.png"]);
        settings.contentView.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        failures += Capture(settings.contentView, [output stringByAppendingPathComponent:@"settings-dark.png"]);
        [c presentChartWindowInFrame:NSMakeRect(-30000, -30000, 1600, 1000)];
        for (NSValue *value in @[[NSValue valueWithSize:NSMakeSize(1600, 1000)], [NSValue valueWithSize:NSMakeSize(1280, 720)], [NSValue valueWithSize:NSMakeSize(1512, 982)], [NSValue valueWithSize:NSMakeSize(1024, 768)]]) {
            NSSize size = value.sizeValue;
            [c.chartWindow setFrame:NSMakeRect(-30000, -30000, size.width, size.height) display:NO];
            for (NSArray *look in @[@[NSAppearanceNameAqua, @"light"], @[NSAppearanceNameDarkAqua, @"dark"]]) {
                c.chartWindow.appearance = [NSAppearance appearanceNamed:look[0]];
                c.chartWindow.contentView.appearance = nil;
                for (NSArray *mode in @[@[@(-1), @"pressure"], @[@1, @"fly"], @[@2, @"rain"], @[@4, @"temp"]]) {
                    [c applyLens:[mode[0] integerValue] rebuild:YES];
                    [c layoutChartWindow]; Pump(.15);
                    // The offscreen clock has no display timer. Wait for the
                    // selected field's new frame, then explicitly present it;
                    // a fixed sleep can capture the previous lens's bitmap.
                    [c startLivePlaybackFromDate:[c selectedForecastDate]];
                    IsobarLivePlayer *live = [c valueForKey:@"live"];
                    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
                    // A clock-only player (GPU map on screen) renders no classic frame.
                    while (!live.baseImage && !live.clockOnly && deadline.timeIntervalSinceNow > 0) {
                        Pump(.02);
                        [c advanceLiveTicks:1];
                    }
                    if (!live.baseImage && !live.clockOnly) { fprintf(stderr, "selected field frame timed out\n"); failures++; }
                    [c applyLiveFrame];
                    NSView *root = c.chartWindow.contentView;
                    failures += CheckExpandedGeometry(root, size, c.requestedMapFrame) + CheckWarningBadge(root, [c packFor:[c hubPlace]][@"warnings"]);
                    NSString *name = [NSString stringWithFormat:@"expanded-%.0fx%.0f-%@-%@.png", size.width, size.height, look[1], mode[1]];
                    failures += Capture(root, [output stringByAppendingPathComponent:name]);
                }
            }
        }
        [c closeChartWindow];
        [c stopPopoverPlayback];
        [[c valueForKey:@"gpuMap"] stopRendering];
        [c applicationWillTerminate:[NSNotification notificationWithName:NSApplicationWillTerminateNotification object:NSApp]];
        [settings close];
        if (![c valueForKey:@"gpuMap"]) fprintf(stderr, "SKIP GPU pixel snapshots and live map fill: Metal unavailable; layout frame checks passed independently\n");
        printf("expanded acceptance failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
