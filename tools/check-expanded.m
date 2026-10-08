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

static NSUInteger CountID(NSView *view, NSString *identifier) {
    NSUInteger count = [view.accessibilityIdentifier isEqual:identifier] ? 1 : 0;
    for (NSView *child in view.subviews) count += CountID(child, identifier);
    return count;
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
    NSView *toolbar = Find(root, @"fullscreen.toolbar");
    NSView *transport = Find(root, @"fullscreen.transport");
    NSView *days = Find(root, @"fullscreen.days");
    TimelineStrip *timeline = (TimelineStrip *)Find(root, @"fullscreen.timeline");
    NSView *status = Find(root, @"fullscreen.statusBar");
    NSView *lens = Find(root, @"fullscreen.lensRow");
    NSView *gpu = Find(root, @"fullscreen.gpu");
    NSString *clipped = nil;
    if (!toolbar || NSHeight(toolbar.frame) > 44 || IsClippedText(toolbar, &clipped)) {
        fprintf(stderr, "expanded header row/truncation failed (%s)\n", clipped.UTF8String ?: "missing"); failures++;
    }
    NSMutableArray *headerControls = [NSMutableArray array];
    for (NSView *v in toolbar.subviews) {
        if (v.hidden || NSIsEmptyRect(v.frame)) continue;
        if (!NSContainsRect(toolbar.bounds, v.frame) || fabs(NSMidY(v.frame) - NSMidY(toolbar.bounds)) > 2) {
            fprintf(stderr, "header control is outside its single row: %s\n", v.accessibilityIdentifier.UTF8String); failures++;
        }
        for (NSView *other in headerControls) if (NSIntersectsRect(v.frame, other.frame)) {
            fprintf(stderr, "header controls overlap: %s / %s\n", v.accessibilityIdentifier.UTF8String, other.accessibilityIdentifier.UTF8String); failures++;
        }
        [headerControls addObject:v];
    }
    NSPopUpButton *speed = (NSPopUpButton *)Find(root, @"fullscreen.speed");
    for (NSMenuItem *item in speed.itemArray) {
        CGFloat needed = [item.title sizeWithAttributes:@{NSFontAttributeName:speed.font}].width + 26;
        if (needed > NSWidth(speed.frame) || [item.title containsString:@"…"]) failures++;
    }
    NSButton *reading = (NSButton *)Find(toolbar, @"fullscreen.temperature");
    if ([reading.attributedTitle.string.lowercaseString containsString:@"now"] ||
        [reading.attributedTitle attribute:NSAttachmentAttributeName atIndex:0 effectiveRange:NULL]) failures++;
    for (NSString *identifier in @[@"fullscreen.newMap", @"fullscreen.zoomIn", @"fullscreen.zoomOut",
        @"fullscreen.zoomReset", @"fullscreen.zoom", @"fullscreen.timeTitle"])
        if (Find(root, identifier)) { fprintf(stderr, "forbidden expanded control %s\n", identifier.UTF8String); failures++; }
    if (!transport || !days || !timeline || !status || !lens || CountID(status, @"fullscreen.lensRow") != 1) {
        fprintf(stderr, "expanded deck/transport/lens row missing\n"); failures++;
    } else {
        NSRect dayRect = [days convertRect:days.bounds toView:root];
        NSRect trackRect = [timeline convertRect:timeline.bounds toView:root];
        if (fabs(NSMinX(dayRect) - NSMinX(trackRect)) > 2 || fabs(NSWidth(dayRect) - NSWidth(trackRect)) > 2) {
            fprintf(stderr, "days and track misaligned %.1f %.1f\n", NSMinX(dayRect), NSMinX(trackRect)); failures++;
        }
        for (NSUInteger i = 0; i < timeline.daySpanCount; i++) {
            NSView *tile = Find(root, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)i]);
            if (!tile) { fprintf(stderr, "missing expanded day tile %lu\n", (unsigned long)i); failures++; break; }
            NSRect tileRect = [tile convertRect:tile.bounds toView:root];
            NSRect spanRect = [timeline convertRect:[timeline daySpanFrameAtIndex:i] toView:root];
            if (fabs(NSMinX(tileRect) - NSMinX(spanRect)) > 2 || fabs(NSMaxX(tileRect) - NSMaxX(spanRect)) > 2) {
                fprintf(stderr, "expanded day %lu misaligned\n", (unsigned long)i); failures++; break;
            }
        }
        if (timeline.daySpanCount && fabs(NSMaxX([timeline trackRect]) - [timeline cursorXForFraction:1]) > 2) {
            fprintf(stderr, "timeline does not end at final frame\n"); failures++;
        }
        NSRect lensRect = [lens convertRect:lens.bounds toView:root];
        if (NSMinY(lensRect) < NSMinY(status.frame) || NSMaxY(lensRect) > NSMaxY(status.frame) + 1) {
            fprintf(stderr, "lens row is not docked in footer\n"); failures++;
        }
    }
    NSRect map = intendedMap;
    if (gpu) map = [gpu convertRect:gpu.bounds toView:root];
    CGFloat expectedTop = NSMaxY(transport.frame) + 2;
    NSRect work = NSMakeRect(0, expectedTop, size.width, NSMinY(status.frame) - expectedTop);
    NSView *dock = Find(root, @"fullscreen.lensDock");
    CGFloat availableWidth = dock ? NSMinX(dock.frame) - 8 : NSWidth(work);
    if (NSIsEmptyRect(map) || fabs(NSMinX(map)) > 1 || fabs(NSMinY(map) - NSMinY(work)) > 1 ||
        fabs(NSWidth(map) - availableWidth) > 1 || fabs(NSHeight(map) - NSHeight(work)) > 1) {
        fprintf(stderr, "map does not fill allocated column: %s\n", NSStringFromRect(map).UTF8String); failures++;
    }
    CGFloat fill = NSWidth(map) * NSHeight(map) / MAX(1, size.width * size.height);
    if (!dock && size.width == 1512 && fill < .85) { fprintf(stderr, "map fill %.3f below .85\n", fill); failures++; }
    if (dock && (NSIntersectsRect(map, dock.frame) || NSMaxX(dock.frame) > size.width ||
        fabs(NSMinY(dock.frame) - NSMinY(work)) > 1 || fabs(NSMaxY(dock.frame) - NSMaxY(work)) > 1)) {
        fprintf(stderr, "lens dock overlaps map or escapes work area\n"); failures++;
    }
    NSView *card = Find(dock, @"forecast.inspector");
    if (dock && (!card || !NSContainsRect(dock.bounds, card.frame))) {
        fprintf(stderr, "lens card escapes dock\n"); failures++;
    }
    if (NSHeight(timeline.frame) != 28 || NSHeight(days.frame) != 50 ||
        fabs(NSMinY(timeline.frame) + NSMinY(transport.frame) - NSMaxY(days.frame)) > 1) failures++;
    printf("layout %.0fx%.0f: header 1 row, deck 2 rows, map %.2f%%, dock %s\n", size.width, size.height, fill*100, dock ? "yes" : "no");
    return failures;
}

static int CheckPopover(NSView *root) {
    NSString *clipped = nil;
    int failures = IsClippedText(root, &clipped) ? 1 : 0;
    if (failures) fprintf(stderr, "popover truncation: %s\n", clipped.UTF8String ?: "unknown");
    if (Find(root, @"popover.windDirectionText") && Find(root, @"popover.windArrow")) failures++;
    if (Find(root, @"popover.nowFiller")) failures++;
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
    NSMutableArray *standins = [NSMutableArray array];
    for (NSView *child in view.subviews.copy) if ([child isKindOfClass:GPUMapView.class] && !child.hidden) {
        GPUMapView *gpu = (GPUMapView *)child;
        [gpu waitForUploads];
        CGImageRef shot = [gpu copySnapshot];
        if (!shot) { fprintf(stderr, "GPU snapshot failed\n"); return 1; }
        NSImageView *image = [NSImageView imageViewWithImage:[[NSImage alloc] initWithCGImage:shot size:gpu.bounds.size]];
        CGImageRelease(shot);
        image.frame = gpu.frame; image.imageScaling = NSImageScaleAxesIndependently;
        [view addSubview:image positioned:NSWindowAbove relativeTo:gpu];
        [standins addObject:image];
    }
    NSData *png = PNGRegion(view, view.bounds);
    for (NSView *standin in standins) [standin removeFromSuperview];
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
        [c presentChartWindowInFrame:NSMakeRect(-30000, -30000, 1512, 982)];
        for (NSValue *value in @[[NSValue valueWithSize:NSMakeSize(1512, 982)], [NSValue valueWithSize:NSMakeSize(1280, 720)], [NSValue valueWithSize:NSMakeSize(1024, 768)]]) {
            NSSize size = value.sizeValue;
            [c.chartWindow setFrame:NSMakeRect(-30000, -30000, size.width, size.height) display:NO];
            for (NSArray *look in @[@[NSAppearanceNameAqua, @"light"], @[NSAppearanceNameDarkAqua, @"dark"]]) {
                c.chartWindow.contentView.appearance = [NSAppearance appearanceNamed:look[0]];
                for (NSArray *mode in @[@[@(-1), @"pressure"], @[@1, @"fly"], @[@2, @"rain"], @[@4, @"temp"]]) {
                    [c applyLens:[mode[0] integerValue] rebuild:YES];
                    [c layoutChartWindow]; Pump(.15);
                    // The offscreen clock has no display timer. Wait for the
                    // selected field's new frame, then explicitly present it;
                    // a fixed sleep can capture the previous lens's bitmap.
                    [c startLivePlaybackFromDate:[c selectedForecastDate]];
                    IsobarLivePlayer *live = [c valueForKey:@"live"];
                    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
                    while (!live.baseImage && deadline.timeIntervalSinceNow > 0) {
                        Pump(.02);
                        [c advanceLiveTicks:1];
                    }
                    if (!live.baseImage) { fprintf(stderr, "selected field frame timed out\n"); failures++; }
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
