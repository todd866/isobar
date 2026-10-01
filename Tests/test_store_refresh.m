// Exercise the real controller against disposable disk snapshots. No app launch,
// network request, status item, visible window, or preference write.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

static int failures;
static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static BOOL HasText(NSView *view, NSString *text) {
    if ([view isKindOfClass:NSTextField.class] &&
        [((NSTextField *)view).stringValue containsString:text]) return YES;
    for (NSView *child in view.subviews) if (HasText(child, text)) return YES;
    return NO;
}

static NSView *FindView(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) {
        NSView *found = FindView(child, identifier);
        if (found) return found;
    }
    return nil;
}

static NSView *Visible(NSView *view, NSString *identifier) {
    NSView *found = FindView(view, identifier);
    return found && !found.isHiddenOrHasHiddenAncestor ? found : nil;
}
static BOOL MapsLeadDetails(NSView *view) {
    NSView *map = FindView(view, @"popover.chart");
    NSView *right = FindView(view, @"popover.chart.right");
    NSView *modes = FindView(view, @"popover.forecastMode");
    NSView *layers = FindView(view, @"popover.layers");
    NSView *legend = FindView(view, @"chart.legend");
    NSView *inspector = FindView(view, @"forecast.inspector");
    NSView *back = FindView(view, @"forecast.back");
    // At the narrow breakpoint the inspector deliberately becomes the whole
    // surface. The map is hidden, so the normal map-before-controls test must
    // recognise the explicit back affordance instead of accepting a tiny map.
    if (inspector && (!map || map.hidden) && back && modes && !modes.hidden && !Visible(view, @"popover.timeline"))
        return !Visible(view, @"popover.timeline");
    if (!map || !modes || !layers) return NO;
    CGFloat mapBottom = right ? MAX(NSMaxY(map.frame), NSMaxY(right.frame)) : NSMaxY(map.frame);
    if (legend) {
        if (NSIntersectsRect(legend.frame, modes.frame) || NSIntersectsRect(legend.frame, layers.frame)) return NO;
        for (NSView *label in legend.subviews)
            if (!NSContainsRect(legend.bounds, label.frame)) return NO;
    }
    BOOL fits = mapBottom <= MIN(NSMinY(modes.frame), NSMinY(layers.frame)) + 1 &&
        !NSIntersectsRect(modes.frame, layers.frame);
    if (!fits) fprintf(stderr, "layout map %.1f modes %.1f layers %.1f legend=%p rain=%p close=%p\\n",
        mapBottom, NSMinY(modes.frame), NSMinY(layers.frame), legend, FindView(view, @"popover.rain"), FindView(view, @"forecast.close"));
    return fits;
}

static BOOL DetailFollowsMaps(NSView *view, NSString *identifier) {
    NSView *map = FindView(view, @"popover.chart");
    NSView *right = FindView(view, @"popover.chart.right");
    NSView *detail = FindView(view, identifier);
    NSView *root = view;
    NSView *inspector = FindView(view, @"forecast.inspector");
    NSView *back = FindView(view, @"forecast.back");
    NSView *modes = FindView(view, @"popover.forecastMode");
    if (!detail) return NO;
    // In a focused inspector the map is intentionally absent and the
    // timeline is hidden. Require the back path and keep the assertion about
    // the detail's own bounds useful without treating a hidden map as a
    // miniature map.
    if (inspector && (!map || map.hidden) && back && modes && !modes.hidden) {
        NSRect detailRect = [detail convertRect:detail.bounds toView:root];
        NSRect inspectorRect = [inspector convertRect:inspector.bounds toView:root];
        return NSContainsRect(inspectorRect, detailRect) && !Visible(view, @"popover.timeline");
    }
    if (!map || !inspector) return NO;
    NSRect mapRect = [map convertRect:map.bounds toView:root];
    NSRect inspectorRect = [inspector convertRect:inspector.bounds toView:root];
    NSRect detailRect = [detail convertRect:detail.bounds toView:root];
    if (!NSContainsRect(root.bounds, inspectorRect) || !NSContainsRect(inspectorRect, detailRect) ||
        NSMinX(inspectorRect) < NSMaxX(mapRect) + 9 || NSIntersectsRect(inspectorRect, mapRect)) return NO;
    CGFloat mapBottom = NSMaxY(mapRect);
    if (right) mapBottom = MAX(mapBottom, NSMaxY([right convertRect:right.bounds toView:root]));
    NSView *timeline = FindView(view, @"popover.timeline");
    if (!timeline) return NO;
    NSRect timelineRect = [timeline convertRect:timeline.bounds toView:root];
    return NSMinY(timelineRect) >= mapBottom - 1 &&
        NSMaxY(timelineRect) >= NSHeight(view.bounds) - 16;
}

// Observe the close request without showing a real popover during tests.
@interface CloseProbePopover : NSPopover
@property NSInteger closeRequests;
@end
@implementation CloseProbePopover
- (void)performClose:(id)sender { (void)sender; self.closeRequests++; }
@end

@interface TestController : Controller
@property NSSize availableSize;
@end
@implementation TestController
- (NSSize)screenBudget { return self.availableSize; }
- (double)backingScale { return 1; }
- (NSUserDefaults *)chartPreferences { return nil; }
@end

@interface LocationTestController : TestController
@property NSInteger refreshCalls;
@end
@implementation LocationTestController
- (void)refreshAll { self.refreshCalls++; }
@end

static void WriteStatus(NSString *root, BOOL ok) {
    NSDictionary *status = @{@"sources": @[
        @{@"id": @"bom-obs", @"ok": @YES, @"label": @"Observations just now"},
        @{@"id": @"ecmwf-open-data", @"ok": @(ok),
          @"run": @"2026-09-26T00:00:00Z", @"label": @"ECMWF 00Z · just now"},
    ]};
    NSData *data = [NSJSONSerialization dataWithJSONObject:status options:0 error:nil];
    Check([data writeToFile:[root stringByAppendingPathComponent:@"status.json"] atomically:YES],
        @"write a disposable status snapshot");
}

static void Capture(NSView *root, NSString *name) {
    const char *output = getenv("ISOBAR_TEST_SHOTS");
    if (!output) return;
    [root layoutSubtreeIfNeeded];
    [root display];
    NSBitmapImageRep *rep = [root bitmapImageRepForCachingDisplayInRect:root.bounds];
    [root cacheDisplayInRect:root.bounds toBitmapImageRep:rep];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *path = [[NSString stringWithUTF8String:output] stringByAppendingPathComponent:name];
    Check([png writeToFile:path atomically:YES], @"write offscreen verification image");
}

static void Pump(NSTimeInterval seconds) {
    NSDate *until=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow>0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}

static BOOL SameDate(NSDate *a, NSDate *b) {
    return a && b && fabs([a timeIntervalSinceDate:b]) < .001;
}

static NSEvent *TimelineEvent(TimelineStrip *timeline, CGFloat fraction, NSEventType type, NSUInteger number) {
    NSRect track=[timeline trackRect];
    NSPoint point=[timeline convertPoint:NSMakePoint(NSMinX(track)+NSWidth(track)*fraction,8) toView:nil];
    NSEventType constructed=type==NSEventTypeMouseExited?NSEventTypeMouseMoved:type;
    return [NSEvent mouseEventWithType:constructed location:point modifierFlags:0
        timestamp:NSDate.timeIntervalSinceReferenceDate windowNumber:timeline.window.windowNumber
        context:nil eventNumber:number clickCount:0 pressure:0];
}

static NSEvent *TimelineEventAtY(TimelineStrip *timeline, CGFloat fraction, CGFloat y, NSEventType type, NSUInteger number) {
    NSRect track=[timeline trackRect];
    NSPoint point=[timeline convertPoint:NSMakePoint(NSMinX(track)+NSWidth(track)*fraction,y) toView:nil];
    NSEventType constructed=type==NSEventTypeMouseExited?NSEventTypeMouseMoved:type;
    return [NSEvent mouseEventWithType:constructed location:point modifierFlags:0
        timestamp:NSDate.timeIntervalSinceReferenceDate windowNumber:timeline.window.windowNumber
        context:nil eventNumber:number clickCount:0 pressure:0];
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSMutableString *linearized=[NSMutableString stringWithString:@"%PDF-1.5\ntrailer << /Root 5 0 R >>\n"];
        [linearized appendString:[@" " stringByPaddingToLength:2000 withString:@" " startingAtIndex:0]];
        Check(PDFTrailerRoot([linearized dataUsingEncoding:NSASCIIStringEncoding])==5,
            @"linearized PDF root near the header is preserved");
        [linearized appendString:@"\ntrailer << /Root 9 0 R >>\n"];
        Check(PDFTrailerRoot([linearized dataUsingEncoding:NSASCIIStringEncoding])==9,
            @"the newest incremental PDF trailer chooses the root");
        NSString *fixtures = [NSString stringWithUTF8String:getenv("ISOBAR_FIXTURES") ?: "Tests/fixtures"];
        NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [@"isobar-refresh-" stringByAppendingString:NSUUID.UUID.UUIDString]];
        NSFileManager *fm = NSFileManager.defaultManager;
        if (![fm copyItemAtPath:[fixtures stringByAppendingPathComponent:@"store"] toPath:root error:nil]) return 1;
        @try {
            NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
            TestController *c = [TestController new];
            c.availableSize = NSMakeSize(1440, 900);
            [c replaceLocations:DefaultLocations()];
            LocationTestController *travel = [LocationTestController new];
            [travel replaceLocations:DefaultLocations()];
            Check([SavedPlaceForTimeZone(DefaultLocations(), @"Australia/Sydney")[@"name"] isEqual:@"Sydney"],
                  @"timezone selects a nearby saved place while Core Location is pending");
            CLLocationManager *locationProbe = [CLLocationManager new];
            [travel locationManager:locationProbe didUpdateLocations:@[[[CLLocation alloc] initWithLatitude:-31.994 longitude:115.75]]];
            Check([[travel shownLocations].firstObject[@"state"] isEqual:@"WA"], @"Perth fix uses WA observations");
            [travel locationManager:locationProbe didUpdateLocations:@[[[CLLocation alloc] initWithLatitude:-33.86 longitude:151.20]]];
            NSDictionary *sydneyFix = [travel shownLocations].firstObject;
            Check([sydneyFix[@"state"] isEqual:@"NSW"] && [sydneyFix[@"timezone"] isEqual:@"Australia/Sydney"] &&
                  travel.refreshCalls >= 2, @"travel to Sydney refreshes location and uses NSW data");
            Check([travel shownLocations].count == DefaultLocations().count &&
                  [[travel shownLocations].lastObject[@"state"] isEqual:@"WA"],
                  @"Sydney fix replaces the saved Sydney card and comes first");
            [travel noteWeatherForGeohash:DefaultLocations()[1][@"geohash"] obs:@{@"airTemp":@18} daily:nil hourly:nil warnings:nil];
            Check([[travel menubarPlace][@"name"] isEqual:@"Sydney"],
                  @"menubar uses a nearby saved observation when the precise fix has none");
            [travel locationManager:locationProbe didUpdateLocations:@[[[CLLocation alloc] initWithLatitude:35.68 longitude:139.76]]];
            NSDictionary *japanFix = [travel shownLocations].firstObject;
            Check(![japanFix[@"state"] length] && [japanFix[@"timezone"] isEqual:NSTimeZone.localTimeZone.name],
                  @"an overseas fix never inherits Perth station metadata");
            [c setChartNow:[iso dateFromString:@"2026-09-26T00:30:00Z"]];
            WriteStatus(root, YES);
            [c reloadStoreAtPath:root];
            [c rebuildContent];
            // Context layers use the same valid instant as each map. The menu
            // can remove them independently of the open forecast graph.
            {
                TestController *layers=[TestController new]; layers.availableSize=NSMakeSize(1024,600);
                [layers replaceLocations:DefaultLocations()]; [layers setChartNow:[iso dateFromString:@"2026-09-26T00:30:00Z"]];
                [layers reloadStoreAtPath:root]; [layers setValue:@NO forKey:@"sourceECMWF"]; [layers rebuildContent];
                NSButton *temperature=(NSButton *)FindView(layers.popover.contentViewController.view,@"forecast.toggle.temperature");
                [temperature performClick:nil];
                PDFCropView *map=(PDFCropView *)FindView(layers.popover.contentViewController.view,@"popover.chart");
                Check(map.mapDetails.count==1 && [map.mapDetails[0][@"kind"] isEqual:@"Temperature"] &&
                    ![[layers valueForKey:@"sourceECMWF"] boolValue],@"Temperature adds detail while preserving Bureau map source");
                Check(FindView(layers.popover.contentViewController.view,@"popover.temperature")!=nil,@"Temperature graph is available");
                NSPopUpButton *menu=(NSPopUpButton *)FindView(layers.popover.contentViewController.view,@"popover.layers");
                NSMenuItem *item=[menu.menu itemWithTag:14];
                Check(item.state==NSControlStateValueOn,@"Layers reflects automatically enabled temperature detail");
                [menu.menu performActionForItemAtIndex:[menu.menu indexOfItem:item]];
                map=(PDFCropView *)FindView(layers.popover.contentViewController.view,@"popover.chart");
                Check(!map.mapDetails.count && FindView(layers.popover.contentViewController.view,@"popover.temperature"),@"Layer can be hidden without closing its graph");
                [layers toggleMapDetail:2]; [layers toggleMapDetail:4];
                NSDate *future=[NSDate dateWithTimeIntervalSince1970:2000000000];
                NSArray *missing=[layers mapDetailsAtTime:future];
                Check(missing.count==2 && [missing[0][@"value"] isEqual:@"—"] && [missing[1][@"value"] isEqual:@"—"],@"uncovered future map never borrows a current reading");
                [layers setValue:@YES forKey:@"barbs"]; [layers setValue:@2 forKey:@"tempLayer"];
                menu=(NSPopUpButton *)FindView(layers.popover.contentViewController.view,@"popover.layers");
                item=[menu.menu itemWithTag:99]; [menu.menu performActionForItemAtIndex:[menu.menu indexOfItem:item]];
                Check([[layers valueForKey:@"mapDetailModes"] count]==0 && ![[layers valueForKey:@"barbs"] boolValue] &&
                    ![[layers valueForKey:@"rainLayer"] boolValue] && [[layers valueForKey:@"tempLayer"] integerValue]==0,@"Hide all clears context, rain shading, wind and temperature colour");
                [layers stopPopoverPlayback];
            }
            NSView *view = c.popover.contentViewController.view;
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 &&
                  !FindView(view, @"popover.rain") && !FindView(view, @"popover.windForecast") &&
                  !FindView(view, @"popover.aviation") && MapsLeadDetails(view),
                @"the default popover is map-first with forecast details closed");
            [c selectPopoverIndex:2];
            [c rebuildContent];
            view = c.popover.contentViewController.view;
            NSNumber *leftBefore = [c valueForKey:@"shownLeft"];
            NSNumber *rightBefore = [c valueForKey:@"shownRight"];
            NSButton *rainToggle = (NSButton *)FindView(view, @"forecast.toggle.rain");
            [rainToggle performClick:nil];
            view = c.popover.contentViewController.view;
            Check([[c valueForKey:@"forecastMode"] integerValue] == 2 &&
                  FindView(view, @"popover.rain") && FindView(view, @"rain.timeline") &&
                  FindView(view, @"forecast.close") && MapsLeadDetails(view),
                @"opening Rain keeps the maps first and adds a close control");
            NSArray *rainPlaces = [c shownLocations];
            NSPopUpButton *rainPlace = (NSPopUpButton *)FindView(view, @"rain.place");
            Check(rainPlace && rainPlace.numberOfItems == (NSInteger)rainPlaces.count,
                @"Rain exposes every shown place in its selector");
            if (rainPlace && rainPlaces.count > 1) {
                NSDictionary *selectedPlace = rainPlaces[1];
                [rainPlace selectItemAtIndex:1];
                [rainPlace sendAction:rainPlace.action to:rainPlace.target];
                view = c.popover.contentViewController.view;
                RainForecastView *rainGraph = (RainForecastView *)FindView(view, @"rain.timeline");
                NSPopUpButton *selectedPopup = (NSPopUpButton *)FindView(view, @"rain.place");
                NSDictionary *expectedRain = RainOutlook([c packFor:selectedPlace][@"series"],
                    [c valueForKey:@"chartNow"] ?: NSDate.date, ZoneForPlace(selectedPlace));
                NSArray *expectedHours=RainOutlook([c packFor:selectedPlace][@"series"],[c detailStartDate],ZoneForPlace(selectedPlace))[@"hours"], *actualHours=rainGraph.outlook[@"hours"];
                NSUInteger prefix=MIN((NSUInteger)48,expectedHours.count);
                BOOL rainPrefix=actualHours.count>=prefix &&
                    [[actualHours subarrayWithRange:NSMakeRange(0,prefix)]
                        isEqual:[expectedHours subarrayWithRange:NSMakeRange(0,prefix)]];
                Check([selectedPopup.selectedItem.representedObject isEqual:selectedPlace[@"geohash"]] &&
                      [rainGraph.timeZone isEqual:ZoneForPlace(selectedPlace)] &&
                      [rainGraph.outlook[@"headline"] isEqual:expectedRain[@"headline"]] &&
                      [rainGraph.outlook[@"amount24"] isEqual:expectedRain[@"amount24"]] && rainPrefix,
                    @"Rain follows the selected place and its timezone");
                [c rebuildContent];
                selectedPopup = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"rain.place");
                Check([selectedPopup.selectedItem.representedObject isEqual:selectedPlace[@"geohash"]],
                    @"the Rain place survives a detail refresh");
                [(NSButton *)FindView(c.popover.contentViewController.view, @"forecast.toggle.rain") performClick:nil];
                [(NSButton *)FindView(c.popover.contentViewController.view, @"forecast.toggle.rain") performClick:nil];
                selectedPopup = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"rain.place");
                Check([selectedPopup.selectedItem.representedObject isEqual:selectedPlace[@"geohash"]],
                    @"the Rain place survives closing and reopening its detail");
                [c replaceLocations:@[rainPlaces.firstObject]];
                [c rebuildContent];
                selectedPopup = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"rain.place");
                Check([selectedPopup.selectedItem.representedObject isEqual:rainPlaces.firstObject[@"geohash"]],
                    @"Rain falls back to the first place when its selection is removed");
                [c replaceLocations:rainPlaces];
                [c reloadStoreAtPath:root];
                [c rebuildContent];
            }
            view = c.popover.contentViewController.view;
            Check([[c valueForKey:@"shownLeft"] isEqual:leftBefore] &&
                  [[c valueForKey:@"shownRight"] isEqual:rightBefore],
                @"opening a detail preserves the selected map while retaining stepping state");
            [(NSButton *)FindView(view, @"forecast.close") performClick:nil];
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 &&
                  !FindView(c.popover.contentViewController.view, @"popover.rain"),
                @"the forecast close button returns to maps");
            rainToggle = (NSButton *)FindView(c.popover.contentViewController.view, @"forecast.toggle.rain");
            [rainToggle performClick:nil];
            [c escapePopover];
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 &&
                  !FindView(c.popover.contentViewController.view, @"popover.rain"),
                @"Escape closes the selected detail before the popover");
            NSPopover *realPopover = c.popover;
            CloseProbePopover *closeProbe = [CloseProbePopover new];
            c.popover = closeProbe;
            [c escapePopover];
            Check(closeProbe.closeRequests == 1, @"a second Escape closes the map popover");
            c.popover = realPopover;
            NSButton *kiteToggle = (NSButton *)FindView(c.popover.contentViewController.view, @"forecast.toggle.kite");
            [kiteToggle performClick:nil];
            Check([[c valueForKey:@"forecastMode"] integerValue] == 0,
                @"a second detail can be opened before closing the popover");
            [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:c.popover]];
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1,
                @"closing the popover resets the selected detail");
            [c rebuildContent];
            view = c.popover.contentViewController.view;
            for (NSNumber *mode in @[@0, @1, @2, @3, @4]) {
                [c setValue:mode forKey:@"forecastMode"];
                [c rebuildContent];
                view = c.popover.contentViewController.view;
                NSString *identifier = mode.integerValue == 0 ? @"popover.windForecast" :
                    (mode.integerValue == 1 ? @"popover.aviation" : (mode.integerValue == 3 ? @"popover.surf" : (mode.integerValue == 4 ? @"popover.temperature" : @"popover.rain")));
                Check(FindView(view, @"popover.chart") && !FindView(view, @"popover.chart.right") &&
                      DetailFollowsMaps(view, identifier),
                    [NSString stringWithFormat:@"detail mode %ld follows the selected map", (long)mode.integerValue]);
            }
            // Forecast panels follow the same selected instant as the map,
            // including after a mode is closed and opened again. Use the
            // Bureau path here so this integration check is synchronous and
            // exercises the shared controller state rather than raw rendering.
            [c setValue:@NO forKey:@"sourceECMWF"];
            [c rebuildSequence]; [c ensurePair]; [c rebuildContent];
            [c selectPopoverIndex:2]; [c rebuildContent];
            NSDate *mapDate=[c valueForKey:@"selectedForecastDate"];
            for (NSNumber *mode in @[@0,@1,@2,@3,@4]) {
                [c setValue:mode forKey:@"forecastMode"]; [c rebuildContent];
                id graph=[c valueForKey:@"forecastGraph"];
                Check(SameDate(mapDate,[graph valueForKey:@"selectedDate"]) &&
                      SameDate(mapDate,[c valueForKey:@"selectedForecastDate"]),
                    [NSString stringWithFormat:@"mode %ld opens at the map time",(long)mode.integerValue]);
            }
            [c inspectPopoverMovieFraction:.72];
            [c rebuildContent];
            NSDate *changedDate=[c valueForKey:@"selectedForecastDate"];
            Check(!SameDate(mapDate,changedDate) &&
                  SameDate(changedDate,[[c valueForKey:@"forecastGraph"] valueForKey:@"selectedDate"]),
                @"changing the map time updates the open graph");
            [c closeForecast:nil]; [c rebuildContent];
            [c setValue:@3 forKey:@"forecastMode"]; [c rebuildContent];
            Check(SameDate(changedDate,[[c valueForKey:@"forecastGraph"] valueForKey:@"selectedDate"]),
                @"closing and reopening preserves the selected time");
            [c setValue:@1 forKey:@"forecastMode"]; [c rebuildContent];
            [c selectPopoverIndex:(NSInteger)[[c valueForKey:@"sequenceTimes"] count]-1]; [c rebuildContent];
            NSTextField *flyTime=(NSTextField *)FindView(c.popover.contentViewController.view, @"forecast.selectedTime");
            Check(flyTime && ![flyTime.stringValue containsString:@"Now"],
                @"Fly outside the TAF window does not relabel the panel Now");
            AviationForecastView *retiredFly=(AviationForecastView *)[c valueForKey:@"forecastGraph"];
            [c setValue:@0 forKey:@"forecastMode"]; [c rebuildContent];
            NSDate *newSelection=[c selectedForecastDate];
            retiredFly.onPreviewDate([newSelection dateByAddingTimeInterval:-3600]);
            Check(![[c valueForKey:@"timelinePreviewing"] boolValue] && SameDate(newSelection,[c selectedForecastDate]),
                @"retired Fly view cannot preview or restore over its replacement");
            NSDate *hoverRestore=[c valueForKey:@"selectedForecastDate"];
            TimelineStrip *timeline=(TimelineStrip *)[c valueForKey:@"popoverTimeline"];
            NSWindow *timelineWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,720,100)
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            timelineWindow.releasedWhenClosed=NO;
            [timeline removeFromSuperview]; timeline.frame=timelineWindow.contentView.bounds;
            [timelineWindow.contentView addSubview:timeline];
            [timeline mouseMoved:TimelineEvent(timeline,.78,NSEventTypeMouseMoved,501)]; Pump(.25);
            [timeline mouseExited:TimelineEvent(timeline,.78,NSEventTypeMouseExited,502)]; Pump(.25);
            Check(!SameDate(hoverRestore,[c selectedForecastDate]) &&
                SameDate([c selectedForecastDate],[[c valueForKey:@"forecastGraph"] valueForKey:@"selectedDate"]) &&
                fabs(timeline.progress-.78)<.001,
                @"leaving the timeline keeps the inspected map, graph and thumb time");
            NSDate *heldDate=[c selectedForecastDate];
            [timeline mouseMoved:TimelineEvent(timeline,.82,NSEventTypeMouseMoved,503)]; Pump(.25);
            [timeline mouseExited:TimelineEvent(timeline,.82,NSEventTypeMouseExited,504)]; Pump(.25);
            Check([c selectedForecastDate].timeIntervalSince1970 > heldDate.timeIntervalSince1970 &&
                SameDate([c selectedForecastDate],[[c valueForKey:@"forecastGraph"] valueForKey:@"selectedDate"]) &&
                fabs(timeline.progress-.82)<.001,
                @"re-entering the strip continues from the held time without resetting the map");
            [timelineWindow close];
            TimelineStrip *scrub=[TimelineStrip new];
            NSWindow *scrubWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,720,120)
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            scrubWindow.releasedWhenClosed=NO;
            scrub.frame=scrubWindow.contentView.bounds;
            scrub.times=@[hoverRestore,[hoverRestore dateByAddingTimeInterval:3600]];
            scrub.labels=@[@"Now",@"Later"];
            [scrubWindow.contentView addSubview:scrub];
            NSMutableArray<NSNumber *> *hoverFrames=[NSMutableArray array];
            NSMutableArray<NSNumber *> *dragFrames=[NSMutableArray array];
            scrub.onPreview=^(double fraction) { if (isfinite(fraction)) [hoverFrames addObject:@(fraction)]; };
            scrub.onSeek=^(double fraction) { [dragFrames addObject:@(fraction)]; };
            for (NSInteger i=0;i<5;i++)
                [scrub mouseMoved:TimelineEventAtY(scrub,.2+i*.1,116,NSEventTypeMouseMoved,600+i)];
            Check(fabs(scrub.progress-.6)<.001,
                @"tall scrub thumb follows the latest pointer event immediately");
            Pump(.04);
            Check(hoverFrames.count>=1 && hoverFrames.count<=5 &&
                fabs(hoverFrames.firstObject.doubleValue-.2)<.001 &&
                fabs(hoverFrames.lastObject.doubleValue-.6)<.001,
                @"tall scrub target keeps the final frame during a pointer burst");
            [scrub mouseMoved:TimelineEventAtY(scrub,.7,-24,NSEventTypeMouseMoved,608)];
            Pump(.04);
            Check(fabs(scrub.progress-.7)<.001 &&
                fabs(hoverFrames.lastObject.doubleValue-.7)<.001 &&
                NSMinY(scrub.trackingAreas.firstObject.rect)<=-24,
                @"an active scrub tracks time beyond the bottom edge");
            [scrub mouseExited:TimelineEventAtY(scrub,.6,116,NSEventTypeMouseExited,609)];
            Check(fabs(scrub.progress-.7)<.001,
                @"leaving hover keeps the scrub thumb at the selected time");
            [scrub mouseDown:TimelineEventAtY(scrub,.3,116,NSEventTypeLeftMouseDown,610)];
            [scrub mouseDragged:TimelineEventAtY(scrub,.4,116,NSEventTypeLeftMouseDragged,611)];
            [scrub mouseDragged:TimelineEventAtY(scrub,.5,116,NSEventTypeLeftMouseDragged,612)];
            Check(fabs(scrub.progress-.5)<.001 && dragFrames.count>0,
                @"dragging across the full scrub height moves the thumb and seeks before mouse-up");
            Pump(.04);
            Check(fabs(dragFrames.lastObject.doubleValue-.5)<.001,
                @"dragging delivers its final frame while the pointer is still down");
            [scrub mouseUp:TimelineEventAtY(scrub,.5,116,NSEventTypeLeftMouseUp,613)];
            __weak TimelineStrip *weakScrub=scrub;
            scrub.onPreview=^(double fraction) {
                if (isfinite(fraction)) [weakScrub removeFromSuperview];
            };
            [scrub mouseMoved:TimelineEventAtY(scrub,.7,8,NSEventTypeMouseMoved,614)];
            Check(!scrub.superview && !scrub.pointerScrubbing,
                @"a preview callback may replace its timeline during pointer movement");
            scrub.onPreview=nil;
            [scrubWindow close];
            NSArray *savedSpots=[c valueForKey:@"kiteList"];
            NSString *savedSpot=[c valueForKey:@"windSpotHash"];
            NSDictionary *otherPlace=[c shownLocations].lastObject;
            [c setValue:@[] forKey:@"kiteList"];
            [c setValue:otherPlace[@"geohash"] forKey:@"windSpotHash"];
            [c rebuildContent];
            Check([((HourlyForecastView *)[c valueForKey:@"forecastGraph"]).timeZone isEqual:ZoneForPlace(otherPlace)],
                @"Kite axis and selected reading share the spot timezone");
            [c setValue:savedSpots forKey:@"kiteList"]; [c setValue:savedSpot forKey:@"windSpotHash"];
            [c setValue:@YES forKey:@"sourceECMWF"];
            [c rebuildSequence]; [c ensurePair]; [c rebuildContent];
            OwnRun *scrubRun=[c valueForKey:@"ownRun"];
            Check(scrubRun.hours>=2,@"scrub fixture has consecutive model frames");
            if (scrubRun.hours>=2) {
                // A ready movie must not take the pointer-preview path back to
                // repeated decoder seeks. Use a disposable URL as a branch
                // marker; no video file or player is opened by this test.
                [c setValue:[NSURL fileURLWithPath:@"/private/tmp/isobar-scrub-branch.mp4"] forKey:@"motionMovieURL"];
                [c previewPopoverMovieFraction:.37];
                IsobarScrubRenderer *renderer=[c valueForKey:@"scrubRenderer"];
                Check(renderer && renderer.renderCount>0 && [[c valueForKey:@"scrubHasFraction"] boolValue],
                    @"pointer hover renders model frames even with a prepared movie");
                double lastPresented=NAN;
                NSUInteger presentedDuringMove=0;
                for (NSInteger i=0;i<30;i++) {
                    [c previewPopoverMovieFraction:.1+.8*i/29.0];
                    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                        beforeDate:[NSDate dateWithTimeIntervalSinceNow:1.0/60.0]];
                    double shown=[[c valueForKey:@"scrubDisplayedFraction"] doubleValue];
                    if (isfinite(shown) && (!isfinite(lastPresented) || fabs(shown-lastPresented)>1e-5)) {
                        if (i<25) presentedDuringMove++;
                        lastPresented=shown;
                    }
                }
                Check(presentedDuringMove>=5,
                    @"complete map preview presents multiple frames during continuous movement");
                [c setValue:nil forKey:@"motionMovieURL"];
                [c previewPopoverMovieFraction:NAN];
                Check(fabs(((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress-.9)<.001,
                    @"leaving a rapid hover keeps its last selected time");
                const char *moviePath=getenv("ISOBAR_TEST_MOVIE_PATH");
                if (moviePath && [fm fileExistsAtPath:[NSString stringWithUTF8String:moviePath]]) {
                    NSURL *movieURL=[NSURL fileURLWithPath:[NSString stringWithUTF8String:moviePath]];
                    AVPlayer *player=[AVPlayer playerWithURL:movieURL];
                    PDFCropView *chart=[c timelineChart];
                    [c setValue:movieURL forKey:@"motionMovieURL"];
                    [c setValue:player forKey:@"motionPlayer"];
                    [chart attachMoviePlayer:player];
                    [c setTimelinePlaying:YES];
                    [c previewPopoverMovieFraction:.4]; Pump(.2);
                    Check([chart valueForKey:@"movieLayer"]==nil,
                        @"real prepared movie yields its surface to live raw scrubbing");
                    [c previewPopoverMovieFraction:NAN]; Pump(.2);
                    Check([chart valueForKey:@"movieLayer"]!=nil,
                        @"playing movie resumes at the inspected time after pointer leaves");
                    [chart removeMoviePlayer];
                    [c setValue:nil forKey:@"motionMovieURL"];
                    [c setValue:nil forKey:@"motionPlayer"];
                }
            }
            // Keep this regression check in the disposable store harness too:
            // ordinary detail modes preserve the map geometry, while the
            // narrow surface deliberately switches to focused inspector.
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1440,900)],
                                    [NSValue valueWithSize:NSMakeSize(1280,720)],
                                    [NSValue valueWithSize:NSMakeSize(1024,600)],
                                    [NSValue valueWithSize:NSMakeSize(800,600)],
                                    [NSValue valueWithSize:NSMakeSize(600,340)]]) {
                c.availableSize = size.sizeValue;
                [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
                NSView *closed = c.popover.contentViewController.view;
                NSView *closedMap = FindView(closed,@"popover.chart");
                NSView *closedStrip=FindView(closed,@"popover.timeline");
                NSRect closedRect = [closedMap convertRect:closedMap.bounds toView:closed];
                NSNumber *selectedBefore = [[c valueForKey:@"shownLeft"] copy];
                for (NSNumber *mode in @[@0,@1,@2,@3,@4]) {
                    [c setValue:mode forKey:@"forecastMode"]; [c rebuildContent];
                    NSView *open = c.popover.contentViewController.view;
                    NSView *map = FindView(open,@"popover.chart");
                    Check(open==closed && map==closedMap && FindView(open,@"popover.timeline")==closedStrip,
                        @"non-movie mode changes retain root, map and scrub target at every breakpoint");
                    if (map && !map.hidden) {
                        NSRect openRect = [map convertRect:map.bounds toView:open];
                        Check(fabs(NSWidth(openRect)-NSWidth(closedRect)) < 1 &&
                              fabs(NSHeight(openRect)-NSHeight(closedRect)) < 1 &&
                              fabs(NSMinX(openRect)-NSMinX(closedRect)) < 1 &&
                              fabs(NSMinY(openRect)-NSMinY(closedRect)) < 1 &&
                              (c.availableSize.width > 1024 || NSWidth(openRect) >= 500) &&
                              DetailFollowsMaps(open, mode.integerValue == 0 ? @"popover.windForecast" :
                                  (mode.integerValue == 1 ? @"popover.aviation" : (mode.integerValue == 3 ? @"popover.surf" : (mode.integerValue == 4 ? @"popover.temperature" : @"popover.rain")))),
                            @"map geometry survives an ordinary detail mode");
                    } else {
                        Check(c.availableSize.width < 900 && FindView(open,@"forecast.back") &&
                              !Visible(open, @"popover.timeline"), @"narrow detail is focused and reversible");
                    }
                }
                NSButton *back = (NSButton *)FindView(c.popover.contentViewController.view, @"forecast.back");
                if (back) [back performClick:nil];
                else { [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent]; }
                NSView *restored = c.popover.contentViewController.view;
                NSView *restoredMap = FindView(restored,@"popover.chart");
                Check(restoredMap && !restoredMap.hidden &&
                      fabs(NSWidth([restoredMap convertRect:restoredMap.bounds toView:restored])-NSWidth(closedRect)) < 1 &&
                      [[c valueForKey:@"shownLeft"] isEqual:selectedBefore],
                    @"closing detail restores the map geometry");
            }
            c.availableSize = NSMakeSize(1440,900);
            [c setValue:@-1 forKey:@"forecastMode"];
            [c rebuildContent];
            view = c.popover.contentViewController.view;
            Check(HasText(view, @"ECMWF 18Z · 6 h ago") && !HasText(view, @"updated just now"),
                @"a new daemon status cannot relabel an older loaded chart");
            NSDictionary *primary = DefaultLocations().firstObject;
            Check([c packFor:primary][@"obs"] != nil && [[c packFor:primary][@"hourly"] count] > 0,
                @"the initial snapshot has observations and a point forecast");

            NSString *pointPointer = [root stringByAppendingPathComponent:@"products/points/ecmwf_ifs/current.json"];
            [fm createDirectoryAtPath:pointPointer.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
            [@"{\"latest\":\"20260926T00Z\"}" writeToFile:pointPointer atomically:YES encoding:NSUTF8StringEncoding error:nil];
            [c reloadStoreAtPath:root];
            Check([c chartsReady], @"a points-only archive retains the available legacy chart");
            [fm removeItemAtPath:pointPointer error:nil];
            [c reloadStoreAtPath:root];

            WriteStatus(root, NO);
            [c reloadStoreAtPath:root];
            [c rebuildContent];
            Check(HasText(c.popover.contentViewController.view, @"ECMWF 18Z · 6 h ago · stale"),
                @"a failed chart source has a visible stale cue");
            Check([c chartsReady] && !HasText(c.popover.contentViewController.view, @"Chart unavailable"),
                @"a failed source keeps its readable chart available");
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1440, 900)],
                                    [NSValue valueWithSize:NSMakeSize(1280, 720)],
                                    [NSValue valueWithSize:NSMakeSize(1024, 600)]]) {
                c.availableSize = size.sizeValue;
                for (NSString *appearance in @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) {
                    [c rebuildContent];
                    view = c.popover.contentViewController.view;
                    view.appearance = [NSAppearance appearanceNamed:appearance];
                    Check(view.frame.size.width <= c.availableSize.width && view.frame.size.height <= c.availableSize.height,
                        [NSString stringWithFormat:@"stale popover fits %.0fx%.0f", c.availableSize.width, c.availableSize.height]);
                    Capture(view, [NSString stringWithFormat:@"stale-%.0fx%.0f-%@.png",
                        c.availableSize.width, c.availableSize.height, appearance]);
                }
            }
            [c stopPopoverPlayback];
            [c presentChartWindowInFrame:NSMakeRect(0,0,1280,720)];
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1280,720)],
                                    [NSValue valueWithSize:NSMakeSize(1024,600)]]) {
                NSSize dimensions=size.sizeValue;
                [c.chartWindow setFrame:NSMakeRect(0,0,dimensions.width,dimensions.height) display:NO];
                [c layoutChartWindow];
                NSView *fullscreen=c.chartWindow.contentView;
                NSView *transport=FindView(fullscreen,@"fullscreen.timeline");
                NSScrollView *map=[c valueForKey:@"singleScroll"];
                NSRect transportRect=transport?[transport convertRect:transport.bounds toView:fullscreen]:NSZeroRect;
                Check(transport && NSHeight(transport.frame)==112 &&
                    NSContainsRect(fullscreen.bounds,transportRect) &&
                    NSWidth(map.frame)>=400 && NSMaxY(map.frame)<=NSMinY(transportRect)+1,
                    [NSString stringWithFormat:@"expanded map and tall scrubber fit %.0fx%.0f",
                        dimensions.width,dimensions.height]);
                Capture(fullscreen,[NSString stringWithFormat:@"expanded-%.0fx%.0f.png",
                    dimensions.width,dimensions.height]);
            }
            [c closeChartWindow];
            c.availableSize = NSMakeSize(1440, 900);
            WriteStatus(root, YES);
            [c reloadStoreAtPath:root];
            [c setChartNow:[iso dateFromString:@"2026-09-26T13:00:00Z"]];
            [c rebuildContent];
            Check(HasText(c.popover.contentViewController.view, @"ECMWF 18Z · 19 h ago · stale"),
                @"an open surface ages into stale without waiting for another disk refresh");

            Check([fm removeItemAtPath:[root stringByAppendingPathComponent:@"products/obs"] error:nil],
                @"remove observations from the disposable snapshot");
            Check([fm removeItemAtPath:[root stringByAppendingPathComponent:@"products/points"] error:nil],
                @"remove point forecasts from the disposable snapshot");
            [c reloadStoreAtPath:root];
            for (NSDictionary *place in DefaultLocations()) {
                NSDictionary *pack = [c packFor:place];
                Check(!pack[@"obs"] && ![pack[@"hourly"] count] && ![pack[@"history"] count] && ![pack[@"series"] count],
                    [NSString stringWithFormat:@"removed data cannot survive for %@", place[@"name"]]);
            }

            NSString *field = [root stringByAppendingPathComponent:@"ecmwf/20260925T18Z/msl.f32"];
            Check([[NSData data] writeToFile:field atomically:YES], @"truncate a disposable chart field");
            [c reloadStoreAtPath:root];
            [c rebuildContent];
            Check(HasText(c.popover.contentViewController.view, @"Chart unavailable") &&
                  !HasText(c.popover.contentViewController.view, @"ECMWF 18Z"),
                @"a manifest without readable chart data cannot advertise a fresh forecast");
            [c setValue:@NO forKey:@"sourceECMWF"];
            [c rebuildContent];
            Check([c chartsReady] && HasText(c.popover.contentViewController.view, @"Bureau chart") &&
                  !HasText(c.popover.contentViewController.view, @"Chart unavailable") &&
                  !HasText(c.popover.contentViewController.view, @"ECMWF 18Z"),
                @"the Bureau alternate remains available without borrowing an ECMWF timestamp");
        } @finally {
            [fm removeItemAtPath:root error:nil];
        }
    }
    return failures ? 1 : 0;
}
