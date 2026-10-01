// Native acceptance against a real store, without windows, network or preferences.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"

#define FAIL() do { failures++; fprintf(stderr, "FAIL acceptance line %d\n", __LINE__); } while (0)
#undef main
#pragma clang diagnostic pop

@interface AcceptanceController : Controller
@property NSSize budget;
@end
@implementation AcceptanceController
- (NSSize)screenBudget { return self.budget; }
- (double)backingScale { return 1; }
- (NSUserDefaults *)chartPreferences { return nil; }
@end

// Simulate a shown popover without opening a window or generating a movie.
@interface ShownAcceptancePopover : NSPopover
@end
@implementation ShownAcceptancePopover
- (BOOL)isShown { return YES; }
@end
@interface EvolutionIntentController : AcceptanceController
@property NSInteger preparationCount;
@property BOOL reduceMotion;
@end
@implementation EvolutionIntentController
- (void)prepareMotion { self.preparationCount++; }
- (BOOL)allowsAutomaticEvolution { return !self.reduceMotion; }
@end

static NSView *Find(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) { NSView *found = Find(child, identifier); if (found) return found; }
    return nil;
}
static NSView *Visible(NSView *view, NSString *identifier) {
    NSView *found = Find(view, identifier);
    return found && !found.isHiddenOrHasHiddenAncestor ? found : nil;
}
static BOOL MapsLeadDetails(NSView *view) {
    NSView *map = Find(view, @"popover.chart");
    NSView *right = Find(view, @"popover.chart.right");
    NSView *modes = Find(view, @"popover.forecastMode");
    NSView *layers = Find(view, @"popover.layers");
    NSView *legend = Find(view, @"chart.legend");
    NSView *timeline = Find(view, @"popover.timeline");
    if (!map || map.hidden || !modes || !layers || !timeline || timeline.hidden || Find(view, @"forecast.back")) return NO;
    CGFloat mapBottom = right ? MAX(NSMaxY(map.frame), NSMaxY(right.frame)) : NSMaxY(map.frame);
    if (legend) {
        if (NSIntersectsRect(legend.frame, modes.frame) || NSIntersectsRect(legend.frame, layers.frame)) return NO;
        for (NSView *label in legend.subviews)
            if (!NSContainsRect(legend.bounds, label.frame)) return NO;
    }
    return mapBottom <= NSMinY(timeline.frame) + 1 &&
        NSMaxY(timeline.frame) <= MIN(NSMinY(modes.frame), NSMinY(layers.frame)) + 1 &&
        !NSIntersectsRect(modes.frame, layers.frame);
}

static BOOL DetailFollowsMaps(NSView *view, NSString *identifier) {
    NSView *map = Find(view, @"popover.chart");
    NSView *detail = Find(view, identifier);
    NSView *inspector = Find(view, @"forecast.inspector");
    NSView *modes = Find(view, @"popover.forecastMode");
    NSView *timeline = Find(view, @"popover.timeline");
    if (!detail || !map || map.hidden || !inspector || !modes || !timeline || timeline.hidden || Find(view, @"forecast.back")) return NO;
    NSRect mapRect = [map convertRect:map.bounds toView:view];
    NSRect inspectorRect = [inspector convertRect:inspector.bounds toView:view];
    NSRect detailRect = [detail convertRect:detail.bounds toView:view];
    NSRect timelineRect = [timeline convertRect:timeline.bounds toView:view];
    NSRect modesRect = [modes convertRect:modes.bounds toView:view];
    if (!NSContainsRect(NSInsetRect(view.bounds, -1, -1), inspectorRect) ||
        !NSContainsRect(NSInsetRect(inspectorRect, -1, -1), detailRect)) return NO;
    if (NSMinY(timelineRect) + 1 < NSMaxY(mapRect) || NSMaxY(modesRect) + 20 < NSHeight(view.bounds)) return NO;
    BOOL beside = NSMinX(inspectorRect) + 1 >= NSMaxX(mapRect) && !NSIntersectsRect(inspectorRect, mapRect);
    if (beside) return NSMinX(inspectorRect) >= NSMaxX(mapRect) + 9;
    NSRect overlap = NSIntersectionRect(inspectorRect, mapRect);
    return !NSIsEmptyRect(overlap) && NSHeight(overlap) <= NSHeight(mapRect) * 0.55 + 1;
}
static void Save(NSView *view, NSString *path) {
    [view layoutSubtreeIfNeeded];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (![png writeToFile:path atomically:YES]) @throw [NSException exceptionWithName:@"capture" reason:path userInfo:nil];
}

static void SaveImage(NSImage *image, NSString *path) {
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (![png writeToFile:path atomically:YES]) @throw [NSException exceptionWithName:@"capture" reason:path userInfo:nil];
}

static void PumpMainRunLoop(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

static uint64_t ImageDigest(NSImage *image) {
    CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cg) return 0;
    CFDataRef data = CGDataProviderCopyData(CGImageGetDataProvider(cg));
    const UInt8 *bytes = CFDataGetBytePtr(data);
    uint64_t digest = 1469598103934665603ULL;
    for (CFIndex i=0; i<CFDataGetLength(data); i+=64) digest=(digest^bytes[i])*1099511628211ULL;
    CFRelease(data);
    return digest;
}

static NSEvent *TimelineMouseEvent(NSEventType type, TimelineStrip *timeline, CGFloat fraction, NSUInteger number) {
    NSRect track = [timeline trackRect];
    NSPoint point = [timeline convertPoint:NSMakePoint(NSMinX(track) + NSWidth(track) * fraction, 8) toView:nil];
    // mouseExited: does not inspect the event type; AppKit cannot synthesize
    // an NSEventTypeMouseExited through its public constructors.
    NSEventType constructedType = type == NSEventTypeMouseExited ? NSEventTypeMouseMoved : type;
    return [NSEvent mouseEventWithType:constructedType location:point
        modifierFlags:0 timestamp:NSDate.timeIntervalSinceReferenceDate windowNumber:timeline.window.windowNumber
        context:nil eventNumber:number clickCount:type == NSEventTypeLeftMouseDown ? 1 : 0 pressure:0];
}

static NSUInteger BureauLandPixels(NSView *view) {
    NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSUInteger count=0;
    for(NSInteger y=0;y<rep.pixelsHigh;y+=3) for(NSInteger x=0;x<rep.pixelsWide;x+=3) {
        NSColor *c=[[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
        if(fabs(c.redComponent-244.0/255)<.035 && fabs(c.greenComponent-238.0/255)<.035 && fabs(c.blueComponent-175.0/255)<.035) count++;
    }
    return count;
}

static CGFloat ImageInkMeanY(NSImage *image) {
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
    if (!rep) return -1;
    CGFloat weighted = 0, total = 0;
    for (NSInteger y = 0; y < rep.pixelsHigh; y++) {
        for (NSInteger x = 0; x < rep.pixelsWide; x++) {
            NSColor *pixel = [rep colorAtX:x y:y];
            CGFloat alpha = pixel.alphaComponent;
            if (alpha < 0.1) continue;
            weighted += y * alpha;
            total += alpha;
        }
    }
    return total > 0 ? weighted / total : -1;
}

static BOOL HasAttachment(NSAttributedString *title) {
    __block BOOL found = NO;
    [title enumerateAttribute:NSAttachmentAttributeName inRange:NSMakeRange(0, title.length)
        options:0 usingBlock:^(id value, NSRange range, BOOL *stop) {
            (void)range;
            if (value) { found = YES; *stop = YES; }
        }];
    return found;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) { fprintf(stderr, "usage: check-app STORE OUTPUT_DIRECTORY\n"); return 64; }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *root = [NSString stringWithUTF8String:argv[1]], *output = [NSString stringWithUTF8String:argv[2]];
        [NSFileManager.defaultManager createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:nil];
        AcceptanceController *c = [AcceptanceController new];
        [c useManualLiveClock];
        c.budget = NSMakeSize(1440, 900);
        [c replaceLocations:DefaultLocations()];
        const char *source = getenv("ISOBAR_CHECK_SOURCE");
        if (source) [c setValue:@(strcmp(source, "ecmwf") == 0) forKey:@"sourceECMWF"];
        BOOL modelSource = [[c valueForKey:@"sourceECMWF"] boolValue];
        printf("chart source: %s\n", modelSource ? "ECMWF model" : "Bureau");
        NSTimeInterval start = NSDate.timeIntervalSinceReferenceDate;
        [c reloadStoreAtPath:root];
        int failures = [c chartsReady] ? 0 : 1;
        EvolutionIntentController *intent = [EvolutionIntentController new];
        [intent useManualLiveClock];
        intent.budget = NSMakeSize(1280,720);
        intent.popover = [ShownAcceptancePopover new];
        intent.popover.contentViewController = [NSViewController new];
        [intent replaceLocations:DefaultLocations()];
        intent.reduceMotion = YES;
        [intent beginPopoverEvolution];
        if ([[intent valueForKey:@"evolutionOnOpenPending"] boolValue] || intent.preparationCount) FAIL();
        // An explicit map click still starts playback with reduced motion.
        [intent resetPopoverToNow];
        if (![[intent valueForKey:@"evolutionOnOpenPending"] boolValue] || intent.preparationCount != 0) FAIL();
        [intent reloadStoreAtPath:root];
        if ([[intent valueForKey:@"evolutionOnOpenPending"] boolValue] || intent.preparationCount != 0 || ![[intent valueForKey:@"popoverPlaying"] boolValue]) FAIL();
        NSProgress *pendingEncode = [NSProgress progressWithTotalUnitCount:7200];
        [intent setValue:pendingEncode forKey:@"motionPreparation"];
        [intent setValue:@YES forKey:@"motionPreparing"];
        [intent reloadStoreAtPath:root];
        if (intent.preparationCount != 0 || pendingEncode.cancelled || ![[intent valueForKey:@"popoverPlaying"] boolValue]) FAIL();
        [intent stopPopoverPlayback];
        [intent reloadStoreAtPath:root];
        if (intent.preparationCount != 0 || [[intent valueForKey:@"popoverPlaying"] boolValue]) FAIL();
        NSDictionary *originalWeather = [[c valueForKey:@"weather"] copy];
        // Keep footer acceptance deterministic even when the archive has no
        // fresh observation: exercise a real WSW reading and km/h conversion.
        NSDictionary *footerPlace = DefaultLocations().firstObject;
        NSMutableDictionary *footerWeather = [[c valueForKey:@"weather"] mutableCopy] ?: [NSMutableDictionary dictionary];
        NSMutableDictionary *footerPack = [footerWeather[footerPlace[@"geohash"]] mutableCopy] ?: [NSMutableDictionary dictionary];
        footerPack[@"obs"] = @{@"airTemp": @17, @"windDir": @"WSW", @"windKmh": @11.112};
        footerWeather[footerPlace[@"geohash"]] = footerPack;
        [c setValue:footerWeather forKey:@"weather"];
        [c rebuildContent];
        NSView *defaultView = c.popover.contentViewController.view;
        NSDictionary *north = FooterWindModel(@{@"windDir": @"N", @"windKt": @12});
        NSDictionary *south = FooterWindModel(@{@"windDir": @"S", @"windKt": @12});
        NSDictionary *calm = FooterWindModel(@{@"windDir": @"N", @"windKt": @0});
        NSDictionary *variable = FooterWindModel(@{@"windKt": @6});
        NSDictionary *missing = FooterWindModel(@{});
        NSDictionary *negative = FooterWindModel(@{@"windKt": @-5});
        NSDictionary *nan = FooterWindModel(@{@"windKt": @(NAN)});
        NSDictionary *converted = FooterWindModel(@{@"windDir": @"WSW", @"windKmh": @11.112});
        NSImage *northImage = FooterWindImage(north);
        NSImage *southImage = FooterWindImage(south);
        printf("footer wind pixels north %.2f south %.2f\n", ImageInkMeanY(northImage), ImageInkMeanY(southImage));
        SaveImage(northImage, [output stringByAppendingPathComponent:@"footer-north.png"]);
        SaveImage(southImage, [output stringByAppendingPathComponent:@"footer-south.png"]);
        NSView *windKey = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 120, 54)];
        windKey.wantsLayer = YES;
        windKey.layer.backgroundColor = NSColor.whiteColor.CGColor;
        for (NSArray *item in @[@[@"N", northImage, @10], @[@"S", southImage, @70]]) {
            NSTextField *label = [NSTextField labelWithString:item[0]];
            label.frame = NSMakeRect([item[2] doubleValue], 8, 20, 18);
            label.textColor = NSColor.blackColor;
            [windKey addSubview:label];
            NSImageView *mark = [[NSImageView alloc] initWithFrame:NSMakeRect([item[2] doubleValue], 28, 18, 18)];
            mark.image = item[1];
            [windKey addSubview:mark];
        }
        Save(windKey, [output stringByAppendingPathComponent:@"footer-wind-key.png"]);
        if (![north[@"hasDirection"] boolValue] || ![north[@"hasSpeed"] boolValue] ||
            [north[@"calm"] boolValue] || ![southImage TIFFRepresentation] ||
            [calm[@"calm"] boolValue] == NO || ![variable[@"hasSpeed"] boolValue] ||
            [variable[@"hasDirection"] boolValue] || [missing[@"hasSpeed"] boolValue] ||
            [missing[@"hasDirection"] boolValue] || [negative[@"hasSpeed"] boolValue] ||
            [nan[@"hasSpeed"] boolValue] ||
            ![FooterWindSpeedLabel(north) isEqual:@"12 kt"] ||
            ![FooterWindSpeedLabel(calm) isEqual:@"0 kt"] ||
            ![FooterWindSpeedLabel(variable) isEqual:@"6 kt"] ||
            ![FooterWindSpeedLabel(missing) isEqual:@"—"] ||
            ![FooterWindSpeedLabel(converted) isEqual:@"6 kt"] ||
            ![converted[@"direction"] isEqual:@"WSW"] ||
            fabs([converted[@"toDeg"] doubleValue] - 67.5) > 0.01 ||
            ImageInkMeanY(northImage) <= ImageInkMeanY(southImage)) {
            FAIL();
        }
        NSButton *footer = (NSButton *)Find(defaultView, @"popover.obs");
        if (!footer || ![footer.attributedTitle.string containsString:@"17°"] ||
            ![footer.attributedTitle.string containsString:@"6 kt"] ||
            !HasAttachment(footer.attributedTitle) ||
            ![footer.accessibilityLabel containsString:@"WSW 6 kt"] ||
            footer.target != c ||
            footer.action != @selector(showObservation:)) {
            FAIL();
        }
        Save(defaultView, [output stringByAppendingPathComponent:@"footer.png"]);
        defaultView.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        Save(defaultView, [output stringByAppendingPathComponent:@"footer-dark.png"]);
        defaultView.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        [c setValue:[originalWeather mutableCopy] forKey:@"weather"];
        [c rebuildContent];
        if ([[c valueForKey:@"forecastMode"] integerValue] != -1 ||
            Find(defaultView, @"popover.rain") || Find(defaultView, @"popover.aviation") ||
            Find(defaultView, @"popover.windForecast") || !MapsLeadDetails(defaultView)) FAIL();
        // A detail inspector may sit beside the map, but opening it must not
        // shrink the map. At 800px the focused inspector intentionally takes
        // over and exposes an explicit back path.
        for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1440,900)],
                                [NSValue valueWithSize:NSMakeSize(1280,720)],
                                [NSValue valueWithSize:NSMakeSize(1024,600)],
                                [NSValue valueWithSize:NSMakeSize(800,600)],
                                [NSValue valueWithSize:NSMakeSize(600,340)]]) {
            c.budget = size.sizeValue;
            [c setValue:@-1 forKey:@"forecastMode"];
            [c rebuildContent];
            NSView *closed = c.popover.contentViewController.view;
            NSView *closedMap = Find(closed, @"popover.chart");
            NSRect closedMapRect = [closedMap convertRect:closedMap.bounds toView:closed];
            CGFloat closedWidth = NSWidth(closedMapRect);
            NSNumber *selectedBefore = [[c valueForKey:@"shownLeft"] copy];
            for (NSNumber *mode in @[@0,@1,@2,@3,@4]) {
                [c setValue:mode forKey:@"forecastMode"];
                [c rebuildContent];
                NSView *open = c.popover.contentViewController.view;
                NSView *openMap = Find(open, @"popover.chart");
                NSView *inspector = Find(open, @"forecast.inspector");
                if (NSWidth(open.frame)>c.budget.width || NSHeight(open.frame)>c.budget.height) FAIL();
                if (!openMap || openMap.hidden || !inspector || !MapsLeadDetails(open)) FAIL();
                if (openMap && !openMap.hidden) {
                    NSRect openMapRect = [openMap convertRect:openMap.bounds toView:open];
                    if (fabs(NSWidth(openMapRect)-closedWidth)>1 ||
                        fabs(NSHeight(openMapRect)-NSHeight(closedMapRect))>1 ||
                        fabs(NSMinX(openMapRect)-NSMinX(closedMapRect))>1 ||
                        fabs(NSMinY(openMapRect)-NSMinY(closedMapRect))>1) FAIL();
                    if (c.budget.width >= 800 && c.budget.height >= 600 && c.budget.width <= 1024 && NSWidth(openMapRect) < 500) FAIL();
                }
            }
            NSButton *back = (NSButton *)Find(c.popover.contentViewController.view, @"forecast.back");
            if (back) [back performClick:nil];
            else { [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent]; }
            NSView *restored = c.popover.contentViewController.view;
            NSView *restoredMap = Find(restored, @"popover.chart");
            if (!restoredMap || restoredMap.hidden ||
                fabs(NSWidth([restoredMap convertRect:restoredMap.bounds toView:restored])-closedWidth)>1 ||
                Find(restored,@"forecast.back") || ![[c valueForKey:@"shownLeft"] isEqual:selectedBefore]) FAIL();
        }
        c.budget = NSMakeSize(1440,900);
        printf("load %.3fs, chart %s, run %s\n", NSDate.timeIntervalSinceReferenceDate - start,
            [c chartsReady] ? "ready" : "unavailable", [[c valueForKey:@"runDate"] description].UTF8String);
        if(!modelSource) {
            NSUInteger land=BureauLandPixels(Find(c.popover.contentViewController.view,@"popover.chart"));
            printf("Bureau coloured land samples: %lu\n",(unsigned long)land);
            if(land<100) FAIL();
        }
        for (NSDictionary *place in DefaultLocations()) {
            NSDictionary *pack = [c packFor:place];
            printf("%s: %s; forecast %lu h; warnings %lu; source %s\n", [place[@"name"] UTF8String],
                MenuBarReading(pack[@"obs"]).UTF8String, (unsigned long)[pack[@"series"] count],
                (unsigned long)[pack[@"warnings"] count], [pack[@"pointSource"] description].UTF8String);
            if (![pack[@"series"] count]) FAIL();
            // Expired observations are deliberately absent. A saved archive
            // must still pass offline acceptance when the observation ages.
            if (!pack[@"obs"] && ![MenuBarReading(nil) isEqual:@"—"]) FAIL();
        }
        NSDictionary *rain = RainOutlook([c packFor:DefaultLocations().firstObject][@"series"], NSDate.date, [c placeZone]);
        NSDictionary *aviation = AviationOutlook([c valueForKey:@"aviation"], NSDate.date, [c placeZone]);
        printf("rain: %s · %s\n", [rain[@"line"] UTF8String], [rain[@"total24"] UTF8String]);
        printf("aviation: %s; %lu TAF periods\n", [aviation[@"observation"] UTF8String], (unsigned long)[aviation[@"periods"] count]);
        for (NSDictionary *p in aviation[@"periods"]) printf("%s %s %s %s %s\n", [p[@"when"] UTF8String], [p[@"change"] UTF8String], [p[@"ceiling"] UTF8String], [p[@"visibility"] UTF8String], [p[@"weather"] UTF8String]);
        start = NSDate.timeIntervalSinceReferenceDate;
        [c prepareChartImages];
        double preparationDispatch=NSDate.timeIntervalSinceReferenceDate-start;
        printf("prepare dispatch %.3fs, %lu cached images\n", preparationDispatch,
            (unsigned long)[[c valueForKey:@"chartCache"] count]);
        if (preparationDispatch>.10) FAIL();
        NSOperationQueue *preparation=[c valueForKey:@"chartPreparationQueue"];
        NSDate *preparationDeadline=[NSDate dateWithTimeIntervalSinceNow:180];
        double worstWarmHeartbeat=0;
        NSView *preparingView=c.popover.contentViewController.view;
        NSBitmapImageRep *preparingBitmap=[preparingView bitmapImageRepForCachingDisplayInRect:preparingView.bounds];
        NSUInteger paintedDuringPreparation=0;
        while (preparation.operationCount && preparationDeadline.timeIntervalSinceNow>0) {
            NSTimeInterval pulse=NSDate.timeIntervalSinceReferenceDate;
            [preparingView cacheDisplayInRect:preparingView.bounds toBitmapImageRep:preparingBitmap];
            paintedDuringPreparation++;
            PumpMainRunLoop(.01);
            worstWarmHeartbeat=MAX(worstWarmHeartbeat,NSDate.timeIntervalSinceReferenceDate-pulse);
        }
        PumpMainRunLoop(.02);
        printf("prepare responsive heartbeat max %.4fs, %lu cached images\n",worstWarmHeartbeat,
            (unsigned long)[[c valueForKey:@"chartCache"] count]);
        printf("main-thread painted %lu times during background preparation\n",(unsigned long)paintedDuringPreparation);
        if (preparation.operationCount || worstWarmHeartbeat>.15) FAIL();
        NSArray *times = [c valueForKey:@"sequenceTimes"];
        double worst = 0;
        for (NSInteger i = 0; modelSource && i < (NSInteger)times.count; i++) {
            start = NSDate.timeIntervalSinceReferenceDate;
            NSImage *image = [c ecmwfImageForIndex:i bare:YES comparison:NO];
            worst = MAX(worst, NSDate.timeIntervalSinceReferenceDate - start);
            if (!image) FAIL();
        }
        printf("warm navigation max %.4fs\n", worst);

        // The static path must still make a hover useful immediately from
        // already rendered maps. Playback is paused so leaving the strip
        // commits the time instead of drifting.
        [intent setValue:@YES forKey:@"forecastPaused"];
        [intent stopPopoverPlayback];
        [intent rebuildContent];
        TimelineStrip *staticTimeline = [intent valueForKey:@"popoverTimeline"];
        if (!staticTimeline || !staticTimeline.onPreview || [[intent valueForKey:@"sequenceTimes"] count] < 2) FAIL();
        NSString *staticTitle = [[intent valueForKey:@"leftTitle"] stringValue];
        double staticProgressBeforeHover = staticTimeline.progress;
        NSProgress *staticPreparation = [NSProgress progressWithTotalUnitCount:7200];
        [intent setValue:staticPreparation forKey:@"motionPreparation"];
        [intent setValue:@YES forKey:@"motionPreparing"];
        NSInteger preparationsBeforeHover = intent.preparationCount;
        [intent previewPopoverMovieFraction:.72];
        if (intent.preparationCount != preparationsBeforeHover ||
            [staticTitle isEqual:[[intent valueForKey:@"leftTitle"] stringValue]] ||
            fabs(staticTimeline.progress - staticProgressBeforeHover) < .04) FAIL();
        NSString *hoveredTitle = [[intent valueForKey:@"leftTitle"] stringValue];
        [intent previewPopoverMovieFraction:NAN];
        if (intent.preparationCount != preparationsBeforeHover ||
            ![hoveredTitle isEqual:[[intent valueForKey:@"leftTitle"] stringValue]]) FAIL();
        // With no encoded movie, nearby times must still change real map
        // pixels. This catches the old nearest-keyframe fallback.
        [intent previewPopoverMovieFraction:.7212]; PumpMainRunLoop(.4);
        NSImage *coldA = [[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"];
        uint64_t coldDigestA = ImageDigest(coldA);
        [intent previewPopoverMovieFraction:.7224]; PumpMainRunLoop(.4);
        NSImage *coldB = [[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"];
        if (!coldDigestA || coldDigestA == ImageDigest(coldB)) FAIL();
        SaveImage(coldA,[output stringByAppendingPathComponent:@"cold-scrub-a.png"]);
        SaveImage(coldB,[output stringByAppendingPathComponent:@"cold-scrub-b.png"]);
        [intent previewPopoverMovieFraction:.3]; PumpMainRunLoop(.3);
        NSUInteger coldFrames=0; uint64_t lastColdDigest=0;
        double coldStart=NSProcessInfo.processInfo.systemUptime, lastColdWall=0, coldGap=0;
        for (NSUInteger tick=0; tick<120; tick++) {
            [intent previewPopoverMovieFraction:.3+.34*tick/119.0];
            PumpMainRunLoop(.016);
            uint64_t digest=ImageDigest([[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"]);
            if (digest && digest!=lastColdDigest) {
                double wall=NSProcessInfo.processInfo.systemUptime;
                if (lastColdWall>0) coldGap=MAX(coldGap,wall-lastColdWall);
                lastColdWall=wall; lastColdDigest=digest; coldFrames++;
            }
        }
        PumpMainRunLoop(.4);
        fprintf(stderr,"cold scrub frames: %lu wall %.3fs largest gap %.3fs\n",(unsigned long)coldFrames,
            NSProcessInfo.processInfo.systemUptime-coldStart-.4,coldGap);
        // One slow frame while the rest of the suite is also rendering is not a
        // stalled scrub. Fewer than 90 distinct frames still fails.
        if (coldFrames<90 || coldGap>.20 || fabs([[intent valueForKey:@"scrubDisplayedFraction"] doubleValue]-.64)>.00001) FAIL();
        [intent previewPopoverMovieFraction:NAN]; PumpMainRunLoop(.3);
        if (fabs([(TimelineStrip *)[intent valueForKey:@"popoverTimeline"] progress]-.64)>.001) FAIL();
        NSInteger originalTemperature=[[intent valueForKey:@"tempLayer"] integerValue];
        for (NSNumber *temperature in @[@0,@1]) {
            [intent setValue:temperature forKey:@"tempLayer"]; [intent rebuildContent];
            TimelineStrip *strip=[intent valueForKey:@"popoverTimeline"];
            strip.onPreview(.18); PumpMainRunLoop(.4);
            NSUInteger frames=0,forward=0,backward=0; uint64_t prior=0;
            double priorFraction=NAN,lastWall=0,maxGap=0;
            for (NSUInteger tick=0;tick<120;tick++) {
                NSUInteger leg=tick/40; double phase=(tick%40)/39.0;
                double fraction=.18+.64*(leg%2?1-phase:phase);
                [strip mouseMoved:TimelineMouseEvent(NSEventTypeMouseMoved,strip,fraction,500+tick)];
                PumpMainRunLoop(.016);
                uint64_t digest=ImageDigest([[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"]);
                if (digest && digest!=prior) {
                    double wall=NSProcessInfo.processInfo.systemUptime;
                    double displayed=[[intent valueForKey:@"scrubDisplayedFraction"] doubleValue];
                    if (lastWall>0) maxGap=MAX(maxGap,wall-lastWall);
                    if (isfinite(priorFraction)) { forward+=displayed>priorFraction; backward+=displayed<priorFraction; }
                    frames++; prior=digest; priorFraction=displayed; lastWall=wall;
                }
            }
            PumpMainRunLoop(.4);
            fprintf(stderr,"cold bidirectional temperature %ld: %lu/120 frames, forward %lu backward %lu, max gap %.3fs\n",temperature.integerValue,(unsigned long)frames,(unsigned long)forward,(unsigned long)backward,maxGap);
            if (frames<90 || forward<40 || backward<20 || maxGap>.20 ||
                fabs([[intent valueForKey:@"scrubDisplayedFraction"] doubleValue]-.82)>.002) FAIL();
            [strip mouseExited:TimelineMouseEvent(NSEventTypeMouseExited,strip,.82,620)]; PumpMainRunLoop(.3);
        }
        [intent setValue:@(originalTemperature) forKey:@"tempLayer"]; [intent rebuildContent];
        // A committed sub-hour target survives a view rebuild; closing or
        // changing source cannot receive a late raw frame afterwards.
        [intent inspectPopoverMovieFraction:.6137]; PumpMainRunLoop(.3);
        uint64_t committedCold=ImageDigest([[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"]);
        [intent rebuildContent]; PumpMainRunLoop(.3);
        if (ImageDigest([[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"])!=committedCold ||
            fabs([(TimelineStrip *)[intent valueForKey:@"popoverTimeline"] progress]-.6137)>.00001) FAIL();
        [intent previewPopoverMovieFraction:.81]; [intent stopPopoverPlayback];
        NSImage *beforeStop=[[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"];
        PumpMainRunLoop(.3);
        if ([[intent valueForKey:@"leftChart"] valueForKey:@"chartImage"]!=beforeStop) FAIL();
        [intent setValue:@NO forKey:@"motionPreparing"];
        [intent setValue:nil forKey:@"motionPreparation"];
        // Viewport captures open at the real current time, independently of
        // the earlier seek tests' deliberately far-future endpoint.
        [c invalidateMotion]; [c rebuildContent];
        [c showStaticTimelineFraction:[c motionFractionForDate:NSDate.date]]; PumpMainRunLoop(.4);
        for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1440,900)],
             [NSValue valueWithSize:NSMakeSize(1280,720)], [NSValue valueWithSize:NSMakeSize(1024,600)],
             [NSValue valueWithSize:NSMakeSize(800,600)], [NSValue valueWithSize:NSMakeSize(600,340)]]) {
            c.budget = size.sizeValue;
            for (NSString *appearance in @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) {
                for (NSInteger mode = -1; mode <= 4; mode++) {
                [c setValue:@(mode) forKey:@"forecastMode"];
                [c setValue:mode<0 ? [NSMutableSet set] : [NSMutableSet setWithObject:@(mode)] forKey:@"mapDetailModes"];
                [[c valueForKey:@"mapDetailCache"] removeAllObjects];
                [c rebuildContent];
                NSView *view = c.popover.contentViewController.view;
                view.appearance = [NSAppearance appearanceNamed:appearance];
                if (NSWidth(view.frame)>c.budget.width || NSHeight(view.frame)>c.budget.height ||
                    !Find(view,@"popover.next") || !Find(view,@"popover.play") || !Find(view,@"popover.settings") ||
                    Find(view,@"forecast.back") || !Visible(view,@"popover.timeline") || !MapsLeadDetails(view) ||
                    Find(view,@"popover.headline") || Find(view,@"popover.note")) FAIL();
                NSString *panelID = mode == 0 ? @"popover.windForecast" : (mode == 1 ? @"popover.aviation" : (mode == 3 ? @"popover.surf" : (mode == 4 ? @"popover.temperature" : @"popover.rain")));
                if (mode >= 0 && !Find(view,panelID)) FAIL();
                if (mode >= 0 && (!Find(view,@"forecast.close") || !DetailFollowsMaps(view,panelID))) FAIL();
                if (mode < 0 && (Find(view,@"popover.rain") || Find(view,@"popover.aviation") || Find(view,@"popover.windForecast") || Find(view,@"popover.surf"))) FAIL();
                for (NSString *name in @[@"rain",@"temperature",@"kite",@"surf",@"fly"]) {
                    NSButton *button=(NSButton *)Find(view,[@"forecast.toggle." stringByAppendingString:name]);
                    if (!button || (button.state == NSControlStateValueOn) != (button.tag == mode)) FAIL();
                }
                if (mode == 0) [(HourlyForecastView *)Find(view,@"popover.windForecast") updateTrackingAreas];
                else if (mode == 1) {
                    AviationForecastView *timeline=(AviationForecastView *)Find(view,@"aviation.timeline");
                    if (!Find(view,@"aviation.notams") || !Find(view,@"aviation.sigmets")) FAIL();
                    if (!timeline || timeline.periods.count != [aviation[@"periods"] count]) FAIL();
                    [timeline updateTrackingAreas];
                } else if (mode == 2) {
                    RainForecastView *timeline=(RainForecastView *)Find(view,@"rain.timeline");
                    NSArray *expectedHours=RainOutlook([c packFor:[c rainPlace]][@"series"],[c detailStartDate],ZoneForPlace([c rainPlace]))[@"hours"];
                    if (!timeline || [timeline.outlook[@"hours"] count] < expectedHours.count ||
                        ![[timeline.outlook[@"hours"] subarrayWithRange:NSMakeRange(0,expectedHours.count)] isEqual:expectedHours]) FAIL();
                    [timeline updateTrackingAreas];
                    NSString *headline=[(NSTextField *)Find(view,@"rain.headline") stringValue];
                    [timeline inspectDate:[timeline.outlook[@"hours"] firstObject][@"start"]];
                    [timeline inspectDate:nil];
                    if (![[(NSTextField *)Find(view,@"rain.headline") stringValue] isEqual:headline]) FAIL();
                } else if (mode == 3) {
                    SurfForecastView *surf = (SurfForecastView *)Find(view, @"popover.surf");
                    if (!Find(view,@"surf.spot") || !Find(view,@"surf.source")) FAIL();
                    NSDictionary *expected = SurfOutlook([c packFor:[c windPlace]][@"marine"], NSDate.date);
                    if ([surf.outlook[@"rows"] count] != [expected[@"rows"] count]) FAIL();
                    [surf updateTrackingAreas];
                }
                NSString *modeName=mode<0?@"closed":(mode==0?@"kite":(mode==1?@"fly":(mode==3?@"surf":(mode==4?@"temperature":@"rain"))));
                NSString *name = [NSString stringWithFormat:@"live-%.0fx%.0f-%@-%@.png",c.budget.width,c.budget.height,appearance,modeName];
                Save(view,[output stringByAppendingPathComponent:name]);
                printf("%s %.0fx%.0f\n",name.UTF8String,NSWidth(view.frame),NSHeight(view.frame));
                }
            }
        }
        // Exercise preparation, actual intermediate map frames and cache reuse
        // when explicitly running with host GPU access. No windows are shown.
        if (getenv("ISOBAR_CHECK_MOTION")) {
            [c prepareMotion];
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:90];
            while ([[c valueForKey:@"motionPreparing"] boolValue] && deadline.timeIntervalSinceNow > 0)
                [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            NSArray *frames = [c valueForKey:@"motionFrames"];
            NSUInteger generation = [[c valueForKey:@"motionGeneration"] unsignedIntegerValue];
            printf("motion prepared: %lu frames, error %s\n", (unsigned long)frames.count, [[c valueForKey:@"motionError"] UTF8String] ?: "none");
            if (frames.count < kMotionIntervals + 1) FAIL();
            else {
                SaveImage(frames[0], [output stringByAppendingPathComponent:@"motion-start.png"]);
                SaveImage(frames[kMotionIntervals/2], [output stringByAppendingPathComponent:@"motion-mid.png"]);
                SaveImage(frames[kMotionIntervals], [output stringByAppendingPathComponent:@"motion-end.png"]);
                [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
                [(NSButton *)Find(c.popover.contentViewController.view,@"popover.play") performClick:nil];
                [c setValue:@0 forKey:@"motionOffset"];
                [c setValue:@(NSProcessInfo.processInfo.systemUptime - .5) forKey:@"motionEpoch"];
                [c advancePopoverPlayback];
                NSImage *middle = [[c valueForKey:@"leftChart"] valueForKey:@"chartImage"];
                if (middle != frames[kMotionIntervals/2] || [[c valueForKey:@"motionGeneration"] unsignedIntegerValue] != generation) FAIL();
                Save(c.popover.contentViewController.view,[output stringByAppendingPathComponent:@"motion-playing.png"]);
                [(NSButton *)Find(c.popover.contentViewController.view,@"popover.play") performClick:nil];
                if ([[c valueForKey:@"popoverPlaying"] boolValue] || [c valueForKey:@"popoverLoopTimer"] ||
                    [[c valueForKey:@"leftChart"] valueForKey:@"chartImage"] != middle) FAIL();
            }
        }
        [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
        NSButton *popoverPlay = (NSButton *)Find(c.popover.contentViewController.view,@"popover.play");
        BOOL popoverCanPlay = popoverPlay && !popoverPlay.hidden && popoverPlay.enabled;
        if (!popoverPlay || popoverPlay.hidden != !popoverCanPlay) FAIL();
        if (MotionEnabled()) {
            [popoverPlay performClick:nil];
            if (![[c valueForKey:@"popoverPlaying"] boolValue]) FAIL();
        } else if ([[c valueForKey:@"popoverPlaying"] boolValue]) FAIL();
        BOOL playingBeforeStep = [[c valueForKey:@"popoverPlaying"] boolValue];
        [c stepPopoverPair:1];
        if ([[c valueForKey:@"popoverPlaying"] boolValue] != playingBeforeStep || [c valueForKey:@"popoverLoopTimer"] ||
            [[c valueForKey:@"motionPreparing"] boolValue]) FAIL();
        [c setValue:[NSMutableSet setWithArray:@[@0,@1,@2,@3,@4]] forKey:@"mapDetailModes"];
        [[c valueForKey:@"mapDetailCache"] removeAllObjects];
        [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
        Save(c.popover.contentViewController.view,[output stringByAppendingPathComponent:@"all-layers.png"]);
        [c hideMapLayers];
        if ([[c valueForKey:@"mapDetailModes"] count] || [(PDFCropView *)Find(c.popover.contentViewController.view,@"popover.chart") mapDetails].count) FAIL();
        // Exercise actual buttons through AppKit, including switching and closing each panel.
        for (NSString *name in @[@"rain",@"temperature",@"kite",@"surf",@"fly"]) {
            [c setValue:@-1 forKey:@"forecastMode"];
            [c rebuildContent];
            NSString *identifier=[@"forecast.toggle." stringByAppendingString:name];
            NSButton *button=(NSButton *)Find(c.popover.contentViewController.view,identifier);
            NSInteger mode=button.tag;
            [button performClick:nil];
            if ([[c valueForKey:@"forecastMode"] integerValue] != mode) FAIL();
            button=(NSButton *)Find(c.popover.contentViewController.view,identifier);
            [button performClick:nil];
            if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        }
        [c setValue:@2 forKey:@"forecastMode"];
        [c rebuildContent];
        NSButton *close = (NSButton *)Find(c.popover.contentViewController.view, @"forecast.close");
        if (!close) FAIL();
        if (close) {
            [close performClick:nil];
            if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        }
        [c setValue:@0 forKey:@"forecastMode"];
        [c rebuildContent];
        [c escapePopover];
        if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        NSButton *reopen = (NSButton *)Find(c.popover.contentViewController.view, @"forecast.toggle.kite");
        if (reopen) [reopen performClick:nil];
        if ([[c valueForKey:@"forecastMode"] integerValue] != 0) FAIL();
        [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:c.popover]];
        if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        [c setValue:@2 forKey:@"forecastMode"];
        [c rebuildContent];
        [(NSButton *)Find(c.popover.contentViewController.view,@"forecast.toggle.fly") performClick:nil];
        if ([[c valueForKey:@"forecastMode"] integerValue] != 1 ||
            Find(c.popover.contentViewController.view,@"rain.timeline")) FAIL();
        [c setValue:@0 forKey:@"forecastMode"];
        [c rebuildContent];
        NSPopUpButton *spots = (NSPopUpButton *)Find(c.popover.contentViewController.view,@"popover.windSpot");
        if (spots.numberOfItems > 1) {
            [spots selectItemAtIndex:1];
            // Set the selection in memory: acceptance never changes owner defaults.
            [c setValue:spots.selectedItem.representedObject forKey:@"windSpotHash"];
            [c rebuildContent];
            HourlyForecastView *v=(HourlyForecastView *)Find(c.popover.contentViewController.view,@"popover.windForecast");
            if (![v.windRows isEqual:[c packFor:[c windPlace]][@"series"]]) FAIL();
        }
        // A missing/null forecast is exercised through the actual AppKit renderer.
        HourlyForecastView *empty=[[HourlyForecastView alloc] initWithFrame:NSMakeRect(0,0,700,132)];
        empty.now=NSDate.date;
        empty.windRows=@[@{@"time":NSDate.date,@"windKt":NSNull.null,@"gustKt":NSNull.null}];
        empty.rainRows=@[@{@"time":[NSDate.date dateByAddingTimeInterval:3600],@"rainMm":NSNull.null}];
        [empty updateTrackingAreas];
        Save(empty,[output stringByAppendingPathComponent:@"missing-forecast.png"]);
        NSView *observation=[c glanceCardForPlace:DefaultLocations().firstObject frame:NSMakeRect(0,0,420,128)
            identifier:@"observation.detail" warningID:@"observation.warning"];
        Save(observation,[output stringByAppendingPathComponent:@"observation-detail.png"]);
        // Expand is the same selected forecast in a single map, with a full
        // continuous timeline. These native windows never order front.
        @try {
            [c setValue:@NO forKey:@"popoverPlaying"];
            [c showStaticTimelineFraction:.375]; PumpMainRunLoop(.3);
            NSDate *selectedBefore=[c selectedForecastDate];
            [c presentChartWindowInFrame:NSMakeRect(0,0,1280,720)]; PumpMainRunLoop(.3);
            NSView *fullscreen=c.chartWindow.contentView;
            if (!Find(fullscreen,@"window.chart") || Find(fullscreen,@"fullscreen.maps") ||
                Find(fullscreen,@"fullscreen.panel.1") || [c fullscreenPanelIndex]<0 ||
                fabs([[c selectedForecastDate] timeIntervalSinceDate:selectedBefore])>7200) FAIL();
            for (NSString *identifier in @[@"fullscreen.timeline",@"fullscreen.now",@"fullscreen.play",
                @"fullscreen.prev",@"fullscreen.next",@"fullscreen.zoomOut",@"fullscreen.zoomReset",
                @"fullscreen.zoomIn",@"fullscreen.compare",@"fullscreen.close",@"fullscreen.layers"])
                if (!Find(fullscreen,identifier)) FAIL();
            PDFCropView *singleMap=(PDFCropView *)Find(fullscreen,@"window.chart");
            TimelineStrip *windowTimeline=(TimelineStrip *)Find(fullscreen,@"fullscreen.timeline");
            if (NSHeight(windowTimeline.frame)<80 || windowTimeline.labels.count<2 ||
                windowTimeline.labels.count!=windowTimeline.times.count) FAIL();
            [(NSButton *)Find(fullscreen,@"fullscreen.zoomIn") performClick:nil];
            if ([[c valueForKey:@"panelZoom"] doubleValue]<=1 || Find(fullscreen,@"window.chart")!=singleMap) FAIL();
            [(NSButton *)Find(fullscreen,@"fullscreen.zoomReset") performClick:nil];
            if ([[c valueForKey:@"panelZoom"] doubleValue]!=1) FAIL();
            [c focusFullscreenPanel:1];
            NSButton *compare=(NSButton *)Find(fullscreen,@"fullscreen.compare");
            if (compare.enabled!=([c earlierIssueForIndex:1]>=0)) FAIL();
            [c toggleIssueCompare];
            if ([c earlierIssueForIndex:1]>=0 && ![[c valueForKey:@"comparing"] boolValue]) FAIL();
            [c toggleIssueCompare];
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1280,720)],
                                    [NSValue valueWithSize:NSMakeSize(1024,600)],
                                    [NSValue valueWithSize:NSMakeSize(640,480)]]) {
                NSSize budget=size.sizeValue;
                [c.chartWindow setFrame:NSMakeRect(0,0,budget.width,budget.height) display:NO]; [c layoutChartWindow];
                NSView *surface=c.chartWindow.contentView;
                NSView *bar=Find(surface,@"fullscreen.toolbar"), *transport=Find(surface,@"fullscreen.transport");
                NSView *mapArea=Find(surface,@"fullscreen.chartScroll"), *footer=Find(surface,@"fullscreen.statusBar");
                if (!bar || !transport || !mapArea || !footer || Find(surface,@"window.chart")!=singleMap ||
                    Find(surface,@"fullscreen.timeline")!=windowTimeline || NSMinY(mapArea.frame)<NSMaxY(bar.frame) ||
                    NSMaxY(mapArea.frame)>NSMinY(transport.frame) || NSMaxY(transport.frame)>NSMinY(footer.frame)) FAIL();
                for (NSView *group in @[bar,transport,footer]) {
                    if (!NSContainsRect(surface.bounds,group.frame)) FAIL();
                    for (NSView *control in group.subviews) if (!NSContainsRect(group.bounds,control.frame)) {
                        fprintf(stderr,"clipped %s in %s: %s\n",control.accessibilityIdentifier.UTF8String,
                            group.accessibilityIdentifier.UTF8String,NSStringFromRect(control.frame).UTF8String);
                        FAIL();
                    }
                }
                Save(surface,[output stringByAppendingPathComponent:[NSString stringWithFormat:@"single-map-%.0fx%.0f.png",budget.width,budget.height]]);
            }
            [c escapeFullscreen];
            if (c.chartWindow.isVisible || [[c valueForKey:@"expandedMap"] boolValue] || [[c valueForKey:@"looping"] boolValue] || [c valueForKey:@"loopTimer"]) FAIL();
        } @finally { [c closeChartWindow]; }
        @try {
            for (NSNumber *sigmet in @[@NO,@YES]) {
                AviationNoticesView *notices=[c prepareAviationNotices:sigmet.boolValue];
                Save(notices,[output stringByAppendingPathComponent:sigmet.boolValue?@"sigmets-live.png":@"notams-empty.png"]);
                if (!Find(notices,@"notices.close") || !Find(notices,@"notices.kind")) FAIL();
                if (sigmet.boolValue && ![(NSButton *)Find(notices,@"notices.import") isHidden]) FAIL();
            }
        } @finally { [[c valueForKey:@"noticesWindow"] close]; }
        @try {
            c.budget=NSMakeSize(1024,600);
            AtmosphereView *profile=[c prepareAtmosphere];
            NSWindow *profileWindow=[c valueForKey:@"atmosphereWindow"];
            if (profileWindow.visible || NSWidth(profile.bounds)>c.budget.width || NSHeight(profile.bounds)>c.budget.height) FAIL();
            if (profile.aircraftMarkerRects.count!=7 || [profile yForHeight:20000]>=[profile yForHeight:1000]) FAIL();
            if (![profile.timeZone.name isEqual:[c aviationTimeZone].name]) FAIL();
            Save(profile,[output stringByAppendingPathComponent:@"atmosphere-1024x600.png"]);
            profile.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
            Save(profile,[output stringByAppendingPathComponent:@"atmosphere-dark-1024x600.png"]);
        } @finally { [[c valueForKey:@"atmosphereWindow"] close]; }
        printf("acceptance failures: %d\n",failures);
        return failures ? 1 : 0;
    }
}
