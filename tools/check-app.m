// Native acceptance against a real store, without windows, network or preferences.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#import <WebKit/WebKit.h>
#import "trainingdata.h"

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
static BOOL ClickLens(Controller *controller, NSInteger segment) {
    NSSegmentedControl *row = (NSSegmentedControl *)Find(controller.popover.contentViewController.view, @"popover.lens");
    if (![row isKindOfClass:NSSegmentedControl.class] || row.segmentCount != 7) return NO;
    row.selectedSegment = segment;
    return [NSApp sendAction:row.action to:row.target from:row];
}
static BOOL SelectLens(Controller *controller, NSInteger segment) {
    NSSegmentedControl *row = (NSSegmentedControl *)Find(controller.popover.contentViewController.view, @"popover.lens");
    if (![row isKindOfClass:NSSegmentedControl.class]) return NO;
    return row.selectedSegment == segment || ClickLens(controller, segment);
}
static NSView *Visible(NSView *view, NSString *identifier) {
    NSView *found = Find(view, identifier);
    return found && !found.isHiddenOrHasHiddenAncestor ? found : nil;
}
static BOOL MapsLeadDetails(NSView *view) {
    NSView *map = Find(view, @"popover.chart");
    NSView *right = Find(view, @"popover.chart.right");
    NSView *modes = Find(view, @"popover.lensRow");
    NSView *legend = Find(view, @"chart.legend");
    NSView *timeline = Find(view, @"popover.timeline");
    NSView *days = Find(view, @"hub.days");
    if (!map || map.hidden || !days || !modes || !timeline || timeline.hidden || Find(view, @"forecast.back")) return NO;
    CGFloat mapBottom = right ? MAX(NSMaxY(map.frame), NSMaxY(right.frame)) : NSMaxY(map.frame);
    if (legend) {
        if (NSIntersectsRect(legend.frame, modes.frame)) {
            fprintf(stderr, "legend intersects lens row legend %s row %s\n",
                NSStringFromRect(legend.frame).UTF8String, NSStringFromRect(modes.frame).UTF8String);
            return NO;
        }
        for (NSView *label in legend.subviews)
            if (!NSContainsRect(legend.bounds, label.frame)) {
                fprintf(stderr, "legend label %s outside %s\n",
                    NSStringFromRect(label.frame).UTF8String, NSStringFromRect(legend.bounds).UTF8String);
                return NO;
            }
    }
    BOOL fits = NSMaxY(days.frame) <= NSMinY(timeline.frame) + 1 &&
        NSMaxY(timeline.frame) <= NSMinY(map.frame) + 1 &&
        mapBottom <= NSMinY(modes.frame) + 1;
    if (!fits) fprintf(stderr, "stack days %s time %s map %s lenses %s\n",
        NSStringFromRect(days.frame).UTF8String, NSStringFromRect(timeline.frame).UTF8String,
        NSStringFromRect(map.frame).UTF8String, NSStringFromRect(modes.frame).UTF8String);
    return fits;
}

static BOOL DetailFollowsMaps(NSView *view, NSString *identifier) {
    NSView *map = Find(view, @"popover.chart");
    NSView *detail = Find(view, identifier);
    NSView *inspector = Find(view, @"forecast.inspector");
    NSView *modes = Find(view, @"popover.lensRow");
    NSView *timeline = Find(view, @"popover.timeline");
    if (!detail || !map || map.hidden || !inspector || !modes || !timeline || timeline.hidden || Find(view, @"forecast.back")) return NO;
    NSRect mapRect = [map convertRect:map.bounds toView:view];
    NSRect inspectorRect = [inspector convertRect:inspector.bounds toView:view];
    NSRect detailRect = [detail convertRect:detail.bounds toView:view];
    NSRect timelineRect = [timeline convertRect:timeline.bounds toView:view];
    NSRect modesRect = [modes convertRect:modes.bounds toView:view];
    if (!NSContainsRect(NSInsetRect(view.bounds, -1, -1), inspectorRect) ||
        !NSContainsRect(NSInsetRect(inspectorRect, -1, -1), detailRect)) return NO;
    if (NSMaxY(timelineRect) > NSMinY(mapRect) + 1 || NSMaxY(modesRect) + 20 < NSHeight(view.bounds)) return NO;
    BOOL beside = NSMinX(inspectorRect) + 1 >= NSMaxX(mapRect) && !NSIntersectsRect(inspectorRect, mapRect);
    if (beside) return NSMinX(inspectorRect) >= NSMaxX(mapRect) + 9;
    NSRect overlap = NSIntersectionRect(inspectorRect, mapRect);
    return !NSIsEmptyRect(overlap) && NSWidth(overlap)*NSHeight(overlap) <= NSWidth(mapRect)*NSHeight(mapRect) * 0.55 + 1;
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
    CGFloat x = timeline.bandDates.count ? [timeline cursorXForFraction:fraction]
        : NSMinX(track) + NSWidth(track) * fraction;
    NSPoint point = [timeline convertPoint:NSMakePoint(x, 8) toView:nil];
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

#import <objc/runtime.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <unistd.h>

static CGFloat gPinchMagnification = 0;
static BOOL gPinchOverride = NO;
static CGFloat (*gOriginalMagnification)(id, SEL);
static CGFloat HarnessMagnification(id self, SEL cmd) {
    if (gPinchOverride && [(NSEvent *)self type] == NSEventTypeMagnify) return gPinchMagnification;
    return gOriginalMagnification(self, cmd);
}
static void (*gOriginalSendEvent)(id, SEL, NSEvent *);
static void HarnessSendEvent(id self, SEL cmd, NSEvent *event) {
    // AppKit drops a synthetic magnify CGEvent as an unrecognized type. Mouse
    // and scroll keep the real sendEvent path. A magnify is hit-tested here
    // and delivered to the view the window would call.
    if (event.type == NSEventTypeMagnify) {
        NSView *content = [self contentView];
        NSPoint local = [content convertPoint:event.locationInWindow fromView:nil];
        NSView *hit = [content hitTest:local];
        while (hit && ![hit isKindOfClass:GPUMapView.class]) hit = hit.superview;
        if ([hit respondsToSelector:@selector(magnifyWithEvent:)]) [hit magnifyWithEvent:event];
        return;
    }
    gOriginalSendEvent(self, cmd, event);
}
static void InstallHarnessEvents(void) {
    static BOOL installed = NO;
    if (installed) return;
    installed = YES;
    Method mag = class_getInstanceMethod([NSEvent class], @selector(magnification));
    gOriginalMagnification = (void *)method_getImplementation(mag);
    method_setImplementation(mag, (IMP)HarnessMagnification);
    Method send = class_getInstanceMethod([NSWindow class], @selector(sendEvent:));
    gOriginalSendEvent = (void *)method_getImplementation(send);
    method_setImplementation(send, (IMP)HarnessSendEvent);
}
@interface NSEvent (IsobarPopoverHarness)
- (NSEvent *)_currentEventWithLocationInWindow:(NSPoint)point modifiers:(NSEventModifierFlags)flags;
@end

static BOOL ColorNear(NSColor *c, double r, double g, double b, double tol) {
    if (!c) return NO;
    c = [c colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    return c && fabs(c.redComponent - r) < tol && fabs(c.greenComponent - g) < tol && fabs(c.blueComponent - b) < tol;
}

// The no-coverage plate is sRGB (228, 221, 210). Bureau land is yellow and
// the sea is paler blue-grey, so neither fill matches this beige. A cache of
// a flipped view uses the view's y.
static BOOL IsNoCoverageColour(NSColor *c) {
    if (!c) return NO;
    NSColor *spaces[] = {
        c,
        [c colorUsingColorSpace:NSColorSpace.sRGBColorSpace],
        [c colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace],
    };
    for (int i = 0; i < 3; i++) {
        NSColor *sample = spaces[i];
        if (!sample) continue;
        if (fabs(sample.redComponent - 0xE4 / 255.0) <= 4.0 / 255.0 &&
            fabs(sample.greenComponent - 0xDD / 255.0) <= 4.0 / 255.0 &&
            fabs(sample.blueComponent - 0xD2 / 255.0) <= 4.0 / 255.0)
            return YES;
    }
    return NO;
}

static BOOL MapBottomHasNoCoverage(NSBitmapImageRep *rep, NSRect mapFrame, CGFloat scale, int *hitX, int *hitY) {
    if (hitX) *hitX = -1;
    if (hitY) *hitY = -1;
    if (!rep) return NO;
    NSRect pixels = NSMakeRect(mapFrame.origin.x * scale, mapFrame.origin.y * scale,
        mapFrame.size.width * scale, mapFrame.size.height * scale);
    NSInteger x0 = MAX(0, (NSInteger)floor(pixels.origin.x));
    NSInteger x1 = MIN(rep.pixelsWide, (NSInteger)ceil(NSMaxX(pixels)));
    NSInteger bottom = MIN(rep.pixelsHigh, (NSInteger)ceil(NSMaxY(pixels)));
    NSInteger top = MAX(0, bottom - 12);
    // A plate band is many pixels wide. One antialiased isobar sample can
    // land on the same beige as the light uncovered colour; a run cannot.
    for (NSInteger y = top; y < bottom; y++) {
        NSInteger run = 0;
        for (NSInteger x = x0; x < x1; x++) {
            if (!IsNoCoverageColour([rep colorAtX:x y:y])) { run = 0; continue; }
            if (++run < 8) continue;
            if (hitX) *hitX = (int)x;
            if (hitY) *hitY = (int)y;
            return YES;
        }
    }
    return NO;
}

static void CountInk(NSBitmapImageRep *rep, NSRect pixelRect, NSUInteger *ink, NSUInteger *coast) {
    *ink = 0; *coast = 0;
    OwnChartPalette light = OwnChartPaletteFor(NO);
    OwnChartPalette dark = OwnChartPaletteFor(YES);
    NSInteger minX = MAX(0, (NSInteger)floor(pixelRect.origin.x));
    NSInteger minY = MAX(0, (NSInteger)floor(pixelRect.origin.y));
    NSInteger maxX = MIN(rep.pixelsWide, (NSInteger)ceil(NSMaxX(pixelRect)));
    NSInteger maxY = MIN(rep.pixelsHigh, (NSInteger)ceil(NSMaxY(pixelRect)));
    for (NSInteger y = minY; y < maxY; y += 2) {
        for (NSInteger x = minX; x < maxX; x += 2) {
            NSColor *c = [rep colorAtX:x y:y];
            if (ColorNear(c, light.isobar.r, light.isobar.g, light.isobar.b, 0.09) ||
                ColorNear(c, dark.isobar.r, dark.isobar.g, dark.isobar.b, 0.09)) (*ink)++;
            if (ColorNear(c, light.coast.r, light.coast.g, light.coast.b, 0.08) ||
                ColorNear(c, dark.coast.r, dark.coast.g, dark.coast.b, 0.06)) (*coast)++;
        }
    }
}

static void BlitRep(NSBitmapImageRep *src, NSBitmapImageRep *dst, NSRect viewRect, CGFloat scale) {
    if (!src || !dst || src.bitsPerPixel != dst.bitsPerPixel || dst.bitsPerPixel < 24) return;
    unsigned char *sbase = src.bitmapData, *dbase = dst.bitmapData;
    if (!sbase || !dbase) return;
    NSInteger spp = dst.bitsPerPixel / 8;
    NSInteger x0 = (NSInteger)llround(NSMinX(viewRect) * scale);
    NSInteger y0 = (NSInteger)llround(NSMinY(viewRect) * scale);
    NSInteger w = MIN((NSInteger)src.pixelsWide, (NSInteger)llround(NSWidth(viewRect) * scale));
    NSInteger h = MIN((NSInteger)src.pixelsHigh, (NSInteger)llround(NSHeight(viewRect) * scale));
    for (NSInteger row = 0; row < h; row++) {
        NSInteger dy = y0 + row;
        if (dy < 0 || dy >= dst.pixelsHigh) continue;
        NSInteger copyW = w;
        NSInteger dx = x0;
        if (dx < 0) { copyW += dx; dx = 0; }
        if (dx + copyW > dst.pixelsWide) copyW = dst.pixelsWide - dx;
        if (copyW < 1) continue;
        memcpy(dbase + dy * dst.bytesPerRow + dx * spp, sbase + row * src.bytesPerRow, (size_t)copyW * (size_t)spp);
    }
}

static NSEvent *Mouse(NSEventType type, NSWindow *window, NSPoint loc, NSInteger number) {
    return [NSEvent mouseEventWithType:type location:loc modifierFlags:0
        timestamp:NSDate.timeIntervalSinceReferenceDate windowNumber:window.windowNumber
        context:nil eventNumber:number clickCount:type == NSEventTypeLeftMouseDown ? 1 : 0 pressure:1];
}

static NSEvent *Scroll(NSWindow *window, NSPoint loc, NSEventPhase phase, CGFloat dy) {
    (void)window;
    CGScrollPhase cg = kCGScrollPhaseChanged;
    if (phase == NSEventPhaseBegan) cg = kCGScrollPhaseBegan;
    else if (phase == NSEventPhaseEnded) cg = kCGScrollPhaseEnded;
    int wheel = (int)llround(dy);
    CGEventRef cgEvent = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, wheel, 0);
    CGEventSetIntegerValueField(cgEvent, kCGScrollWheelEventScrollPhase, cg);
    CGEventSetIntegerValueField(cgEvent, kCGScrollWheelEventIsContinuous, 1);
    NSEvent *event = [NSEvent eventWithCGEvent:cgEvent];
    CFRelease(cgEvent);
    return [event _currentEventWithLocationInWindow:loc modifiers:0];
}

static NSEvent *Magnify(NSWindow *window, NSPoint loc, CGFloat amount) {
    (void)window;
    CGEventRef cgEvent = CGEventCreate(NULL);
    CGEventSetType(cgEvent, (CGEventType)NSEventTypeMagnify);
    NSEvent *event = [[NSEvent eventWithCGEvent:cgEvent] _currentEventWithLocationInWindow:loc modifiers:0];
    CFRelease(cgEvent);
    gPinchMagnification = amount;
    return event;
}

static BOOL WriteMovie(NSArray *images, NSString *path, int fps) {
    CGImageRef sample = (__bridge CGImageRef)images.firstObject;
    if (!sample) return NO;
    int width = (int)CGImageGetWidth(sample), height = (int)CGImageGetHeight(sample);
    NSURL *url = [NSURL fileURLWithPath:path];
    [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager removeItemAtURL:url error:nil];
    NSError *failure = nil;
    AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeQuickTimeMovie error:&failure];
    NSDictionary *settings = @{
        AVVideoCodecKey: AVVideoCodecTypeAppleProRes4444,
        AVVideoWidthKey: @(width), AVVideoHeightKey: @(height),
    };
    AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    input.expectsMediaDataInRealTime = NO;
    AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor
        assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input sourcePixelBufferAttributes:@{
            (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
            (NSString *)kCVPixelBufferWidthKey: @(width), (NSString *)kCVPixelBufferHeightKey: @(height),
        }];
    if (!writer || ![writer canAddInput:input]) return NO;
    [writer addInput:input];
    if (![writer startWriting]) return NO;
    [writer startSessionAtSourceTime:kCMTimeZero];
    BOOL okay = YES;
    for (NSInteger i = 0; i < (NSInteger)images.count && okay; i++) {
        CGImageRef cg = (__bridge CGImageRef)images[i];
        NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 10;
        while (!input.readyForMoreMediaData && writer.status == AVAssetWriterStatusWriting &&
            NSProcessInfo.processInfo.systemUptime < deadline) usleep(2000);
        CVPixelBufferRef buffer = NULL;
        if (!cg || !input.readyForMoreMediaData ||
            CVPixelBufferPoolCreatePixelBuffer(NULL, adaptor.pixelBufferPool, &buffer) != kCVReturnSuccess) {
            okay = NO; break;
        }
        CVPixelBufferLockBaseAddress(buffer, 0);
        CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(buffer), width, height,
            8, CVPixelBufferGetBytesPerRow(buffer), colors, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
        CGColorSpaceRelease(colors);
        if (context) {
            CGContextDrawImage(context, CGRectMake(0, 0, width, height), cg);
            CGContextRelease(context);
        } else okay = NO;
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        if (okay && ![adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMake(i, fps)]) okay = NO;
        CVPixelBufferRelease(buffer);
    }
    if (okay) {
        [input markAsFinished];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC))) okay = NO;
        else okay = writer.status == AVAssetWriterStatusCompleted;
    }
    if (!okay) [writer cancelWriting];
    return okay;
}

@interface OcclusionHarnessWindow : NSWindow
@property BOOL scriptOcclusion;
@property NSWindowOcclusionState scriptedOcclusion;
@end
@implementation OcclusionHarnessWindow
- (NSWindowOcclusionState)occlusionState {
    if (self.scriptOcclusion) return self.scriptedOcclusion;
    return [super occlusionState];
}
@end

static void PostOcclusion(NSWindow *window) {
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeOcclusionStateNotification object:window];
}

static BOOL BannedChromeWord(NSView *view, NSString **hit) {
    if ([view isKindOfClass:NSTextField.class]) {
        NSString *text = ((NSTextField *)view).stringValue ?: @"";
        if ([text rangeOfString:@"stale" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [text rangeOfString:@"Forecast"].location != NSNotFound) {
            if (hit) *hit = text;
            return YES;
        }
    }
    if ([view isKindOfClass:NSButton.class]) {
        NSString *text = ((NSButton *)view).attributedTitle.string ?: ((NSButton *)view).title ?: @"";
        if ([text rangeOfString:@"stale" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [text rangeOfString:@"Forecast"].location != NSNotFound) {
            if (hit) *hit = text;
            return YES;
        }
    }
    for (NSView *child in view.subviews) if (BannedChromeWord(child, hit)) return YES;
    return NO;
}

static int SliderAligned(NSView *content) {
    NSView *days = Find(content, @"hub.days");
    TimelineStrip *timeline = (TimelineStrip *)Find(content, @"popover.timeline");
    NSView *play = Find(content, @"popover.play");
    NSView *clock = Find(content, @"popover.clock");
    NSView *now = Find(content, @"popover.now");
    if (![timeline isKindOfClass:TimelineStrip.class] || !days || !play || !now || !clock || clock.superview != timeline ||
        Find(content, @"popover.prev") || Find(content, @"popover.next")) {
        fprintf(stderr, "FAIL popover slider row\n");
        return 1;
    }
    NSRect dayFrame = [days convertRect:days.bounds toView:content];
    NSRect timeFrame = [timeline convertRect:timeline.bounds toView:content];
    NSRect playFrame = [play convertRect:play.bounds toView:content];
    NSRect nowFrame = [now convertRect:now.bounds toView:content];
    CGFloat gap = NSMinY(timeFrame) - NSMaxY(dayFrame);
    int bad = 0;
    if (gap < -1 || gap > 12) {
        fprintf(stderr, "FAIL popover slider gap %.1f\n", gap);
        bad++;
    }
    if (fabs(NSMinX(dayFrame) - NSMinX(timeFrame)) > 2 || fabs(NSWidth(dayFrame) - NSWidth(timeFrame)) > 2 ||
        NSMaxX(playFrame) > NSMinX(dayFrame) + 2 || NSMaxX(nowFrame) > NSMinX(dayFrame) + 2) {
        fprintf(stderr, "FAIL popover columns days %.1f track %.1f play %.1f\n",
            NSMinX(dayFrame), NSMinX(timeFrame), NSMaxX(playFrame));
        bad++;
    }
    if (!NSContainsRect(NSInsetRect(timeline.bounds, -1, -1), clock.frame)) {
        fprintf(stderr, "FAIL popover clock outside the track %s\n", NSStringFromRect(clock.frame).UTF8String);
        bad++;
    } else {
        CGFloat cursor = [timeline cursorXForFraction:timeline.progress];
        BOOL rides = fabs(NSMidX(clock.frame) - cursor) <= 1.5 ||
            (NSMinX(clock.frame) <= 1 && cursor <= NSMidX(clock.frame)) ||
            (NSMaxX(clock.frame) >= NSWidth(timeline.bounds) - 1 && cursor >= NSMidX(clock.frame));
        if (!rides) {
            fprintf(stderr, "FAIL popover clock %.1f is not on the playhead %.1f\n", NSMidX(clock.frame), cursor);
            bad++;
        }
    }
    NSUInteger tiles = 0;
    while (Find(content, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)tiles])) tiles++;
    if (!tiles || timeline.daySpanCount != tiles) {
        fprintf(stderr, "FAIL popover day span count %lu tiles %lu\n",
            (unsigned long)timeline.daySpanCount, (unsigned long)tiles);
        return bad + 1;
    }
    for (NSUInteger i = 0; i < tiles; i++) {
        NSView *tile = Find(content, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)i]);
        NSRect tileRect = [tile convertRect:tile.bounds toView:content];
        NSRect span = [timeline convertRect:[timeline daySpanFrameAtIndex:i] toView:content];
        if (fabs(NSMinX(tileRect) - NSMinX(span)) > 2 || fabs(NSMaxX(tileRect) - NSMaxX(span)) > 2) {
            fprintf(stderr, "FAIL popover day %lu tile %.1f–%.1f span %.1f–%.1f\n", (unsigned long)i,
                NSMinX(tileRect), NSMaxX(tileRect), NSMinX(span), NSMaxX(span));
            bad++;
            break;
        }
    }
    return bad;
}

static id EvalTrainingJS(WKWebView *web, NSString *script) {
    __block id value = nil;
    __block BOOL done = NO;
    [web evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        value = result ?: error.localizedDescription;
        done = YES;
    }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!done && deadline.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    return done ? value : nil;
}

// Header is one row. Train is a 22 pt symbol left of Expand, fully inside the popover.
static int TrainButtonLayout(NSView *content) {
    NSButton *train = (NSButton *)Find(content, @"popover.train");
    NSView *expand = Find(content, @"popover.expand");
    NSView *settings = Find(content, @"popover.settings");
    NSView *issued = Find(content, @"popover.issued");
    NSView *place = Find(content, @"hub.place");
    NSView *header = Find(content, @"popover.obs");
    if (![train isKindOfClass:NSButton.class] || train.isHiddenOrHasHiddenAncestor || !train.image) {
        fprintf(stderr, "missing train button\n");
        return 1;
    }
    int bad = 0;
    if (![train.accessibilityLabel isEqual:@"Training"] || ![train.toolTip isEqual:@"ATPL training"]) {
        fprintf(stderr, "train label '%s' tip '%s'\n",
            train.accessibilityLabel.UTF8String ?: "", train.toolTip.UTF8String ?: "");
        bad++;
    }
    if (![train.keyEquivalent.lowercaseString isEqual:@"t"] ||
        (train.keyEquivalentModifierMask & NSEventModifierFlagCommand) == 0) {
        fprintf(stderr, "train shortcut missing\n");
        bad++;
    }
    NSRect frame = [train convertRect:train.bounds toView:content];
    if (!NSContainsRect(NSInsetRect(content.bounds, -0.5, -0.5), frame) || NSWidth(frame) < 18 || NSHeight(frame) < 18) {
        fprintf(stderr, "train clipped %s in %s\n",
            NSStringFromRect(frame).UTF8String, NSStringFromRect(content.bounds).UTF8String);
        bad++;
    }
    for (NSView *peer in @[expand, settings, issued]) {
        if (!peer) continue;
        NSRect peerFrame = [peer convertRect:peer.bounds toView:content];
        if (NSIntersectsRect(NSInsetRect(frame, 1, 1), NSInsetRect(peerFrame, 1, 1))) {
            fprintf(stderr, "train overlaps %s\n", peer.accessibilityIdentifier.UTF8String ?: "");
            bad++;
        }
    }
    if (expand && settings) {
        NSRect expandFrame = [expand convertRect:expand.bounds toView:content];
        NSRect settingsFrame = [settings convertRect:settings.bounds toView:content];
        if (fabs(NSMidY(frame) - NSMidY(settingsFrame)) > 2 || NSMaxX(frame) > NSMinX(expandFrame) + 0.5 ||
            NSMaxX(expandFrame) > NSMinX(settingsFrame) + 0.5) {
            fprintf(stderr, "train row %s expand %s settings %s\n",
                NSStringFromRect(frame).UTF8String, NSStringFromRect(expandFrame).UTF8String,
                NSStringFromRect(settingsFrame).UTF8String);
            bad++;
        }
    }
    if (place && header) {
        NSRect placeFrame = [place convertRect:place.bounds toView:content];
        NSRect headerFrame = [header convertRect:header.bounds toView:content];
        if (fabs(NSMidY(placeFrame) - NSMidY(frame)) > 8 || fabs(NSMidY(headerFrame) - NSMidY(frame)) > 8) {
            fprintf(stderr, "train is off the header row\n");
            bad++;
        }
    }
    return bad;
}

static int TrainButtonOpens(AcceptanceController *c, NSWindow *popoverWindow) {
    NSString *progress = TrainingProgressPath();
    NSDate *before = [NSFileManager.defaultManager attributesOfItemAtPath:progress error:nil][NSFileModificationDate];
    [c rebuildContent];
    NSView *content = c.popover.contentViewController.view;
    popoverWindow.contentView = content;
    [popoverWindow orderBack:nil];
    int bad = TrainButtonLayout(content);
    NSButton *train = (NSButton *)Find(content, @"popover.train");
    if (![train isKindOfClass:NSButton.class]) return bad + 1;
    [popoverWindow makeKeyWindow];
    NSEvent *key = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:NSEventModifierFlagCommand timestamp:NSDate.timeIntervalSinceReferenceDate
        windowNumber:popoverWindow.windowNumber context:nil characters:@"t" charactersIgnoringModifiers:@"t"
        isARepeat:NO keyCode:17];
    // Command-T is the button's key equivalent. A prohibited harness may not
    // become key, so a missed equivalent still takes the button's action.
    BOOL keyed = [popoverWindow performKeyEquivalent:key];
    if (!keyed) [train performClick:nil];
    NSWindow *training = nil;
    for (NSWindow *candidate in NSApp.windows)
        if ([candidate.title isEqualToString:@"Training"]) training = candidate;
    if (!training) {
        fprintf(stderr, "Train did not create a window\n");
        return bad + 1;
    }
    if (NSMinX(training.frame) > -10000 || NSMinY(training.frame) > -10000) {
        fprintf(stderr, "training window is on the desktop %s\n", NSStringFromRect(training.frame).UTF8String);
        bad++;
    }
    for (NSScreen *screen in NSScreen.screens) {
        if (NSIntersectsRect(training.frame, screen.frame)) {
            fprintf(stderr, "training window intersects %s\n", NSStringFromRect(screen.frame).UTF8String);
            bad++;
        }
    }
    WKWebView *web = [training.contentView isKindOfClass:WKWebView.class] ? (WKWebView *)training.contentView : nil;
    NSString *body = nil;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
    while (web && deadline.timeIntervalSinceNow > 0) {
        id value = EvalTrainingJS(web, @"(function(){if(window.__TRAINING_READY!==true)return '';"
            "var s=window.isobar&&window.isobar.snapshot;if(!s)return 'missing';"
            "var metar='';(s.airports||[]).forEach(function(a){if(a.icao==='YSSY'&&a.metar&&a.metar.raw)metar=a.metar.raw;});"
            "return [(s.now||''),(s.runTime||''),metar].join('\\n');})()");
        if ([value isKindOfClass:NSString.class] && [(NSString *)value length] > 0) { body = value; break; }
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    NSArray *lines = [body componentsSeparatedByString:@"\n"];
    NSString *now = lines.count > 0 ? lines[0] : @"";
    NSString *run = lines.count > 1 ? lines[1] : @"";
    NSString *metar = lines.count > 2 ? lines[2] : @"";
    const char *clock = getenv("ISOBAR_CHECK_NOW");
    if (clock && clock[0] && ![now isEqual:[NSString stringWithUTF8String:clock]]) {
        fprintf(stderr, "training snapshot now '%s'\n", now.UTF8String ?: "");
        bad++;
    }
    if (run.length < 10 || ![metar containsString:@"YSSY"]) {
        fprintf(stderr, "training snapshot is not the store run '%s' metar '%s'\n",
            run.UTF8String ?: "", metar.UTF8String ?: "");
        bad++;
    }
    NSDate *after = [NSFileManager.defaultManager attributesOfItemAtPath:progress error:nil][NSFileModificationDate];
    if ((before && ![before isEqual:after]) || (!before && after)) {
        fprintf(stderr, "Train wrote the pilot progress file\n");
        bad++;
    }
    TrainingWindowDismiss();
    return bad;
}

static int CheckPopoverMap(AcceptanceController *c, NSString *store) {
    int failures = 0;
#define POPFAIL(message) do { failures++; fprintf(stderr, "FAIL popover %s\n", message); } while (0)
    if (![c chartsReady]) { POPFAIL("store has a chart"); return failures; }
    InstallHarnessEvents();
    c.budget = NSMakeSize(1440, 900);
    c.popover = [ShownAcceptancePopover new];
    c.popover.behavior = NSPopoverBehaviorTransient;
    c.popover.animates = NO;
    c.popover.delegate = (id)c;
    c.popover.contentViewController = [NSViewController new];
    NSString *dir = @"build/qa/popover";
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    OcclusionHarnessWindow *window = [[OcclusionHarnessWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 1600, 1200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    NSArray *looks = @[@"light", @"dark"];
    NSArray *maps = @[@"new", @"classic"];
    NSArray *lenses = @[@"pressure", @"rain", @"wind", @"temp", @"kite", @"surf", @"fly"];
    NSDictionary *lensID = @{@"rain": @"popover.rain", @"temp": @"popover.temperature", @"kite": @"popover.windForecast",
        @"surf": @"popover.surf", @"fly": @"popover.aviation"};
    @try {
        failures += TrainButtonOpens(c, window);
        BOOL timingOnly = getenv("ISOBAR_POPOVER_TIMING") != NULL;
        if (!timingOnly) for (NSString *look in looks) {
            for (NSString *mapName in maps) {
                NSButton *toggle = [NSButton checkboxWithTitle:@"New map" target:nil action:nil];
                toggle.state = [mapName isEqual:@"new"] ? NSControlStateValueOn : NSControlStateValueOff;
                [c toggleNewMap:toggle];
                for (NSString *lens in lenses) {
                    [c rebuildContent];
                    NSView *content = c.popover.contentViewController.view;
                    window.contentView = content;
                    [window orderBack:nil];
                    if (!SelectLens(c, [lenses indexOfObject:lens])) { POPFAIL("lens segment"); continue; }
                    content = c.popover.contentViewController.view;
                    window.contentView = content;
                    NSSegmentedControl *lensRow = (NSSegmentedControl *)Find(content, @"popover.lens");
                    NSInteger expectedFields[] = {0, 1, 2, 3, 2, 0, 0};
                    if ([c mapField] != expectedFields[[lenses indexOfObject:lens]] ||
                        lensRow.selectedSegment != (NSInteger)[lenses indexOfObject:lens]) POPFAIL("lens field coupling");
                    if (NSWidth(lensRow.frame) + .5 < lensRow.intrinsicContentSize.width) POPFAIL("lens labels fit");
                    NSButton *hazards = (NSButton *)Find(content, @"popover.hazards");
                    NSView *lensBox = Find(content, @"popover.lensRow");
                    if (!hazards || !NSContainsRect(content.bounds, lensBox.frame) ||
                        !NSContainsRect(lensBox.bounds, hazards.frame) ||
                        hazards.enabled != [mapName isEqual:@"new"] ||
                        (hazards.state == NSControlStateValueOn) != [lens isEqual:@"fly"] ||
                        [hazards.title containsString:@"…"] ||
                        (hazards.title.length && NSWidth(hazards.frame) < hazards.intrinsicContentSize.width))
                        POPFAIL("Hazards toggle defaults and viewport fit");
                    content.appearance = [NSAppearance appearanceNamed:[look isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
                    [content layoutSubtreeIfNeeded];
                    GPUMapView *gpu = (GPUMapView *)Find(content, @"popover.gpu");
                    NSView *chart = Find(content, @"popover.chart");
                    BOOL wantGPU = [mapName isEqual:@"new"];
                    if (wantGPU) {
                        if (![gpu isKindOfClass:GPUMapView.class] || gpu.hidden) POPFAIL("new map is the popover surface");
                        else {
                            [gpu waitForUploads];
                            if (gpu.hazards != [lens isEqual:@"fly"]) POPFAIL("Fly enables GPU hazards");
                            if (gpu.hazards) [gpu waitForHazards];
                        }
                    } else if (gpu && !gpu.hidden) POPFAIL("classic map removes the GPU surface");
                    if (!chart || chart.hidden) POPFAIL("classic chart stays in the popover");
                    NSArray *transport = @[@"popover.play", @"popover.speed", @"popover.now", @"popover.timeline"];
                    for (NSString *ident in transport) {
                        NSView *control = Visible(content, ident);
                        if (!control) { fprintf(stderr, "missing %s\n", ident.UTF8String); POPFAIL("transport control"); continue; }
                        NSRect frame = [control convertRect:control.bounds toView:content];
                        if (!NSContainsRect(NSInsetRect(content.bounds, -1, -1), frame) || NSWidth(frame) < 8 || NSHeight(frame) < 8)
                            POPFAIL("transport control is clipped");
                    }
                    failures += SliderAligned(content);
                    NSString *banned = nil;
                    if (BannedChromeWord(content, &banned)) {
                        fprintf(stderr, "banned word '%s'\n", banned.UTF8String);
                        POPFAIL("stale or Forecast on screen");
                    }
                    NSButton *header = (NSButton *)Find(content, @"popover.obs");
                    NSView *issued = Find(content, @"popover.issued");
                    NSView *place = Find(content, @"hub.place");
                    if (!header || NSHeight(header.frame) > 36 || header.attributedTitle.size.width > NSWidth(header.frame) + 1) {
                        fprintf(stderr, "header h %.1f text %.1f box %.1f\n",
                            header ? NSHeight(header.frame) : -1,
                            header.attributedTitle.size.width, header ? NSWidth(header.frame) : -1);
                        POPFAIL("header is one row");
                    }
                    if (place && issued) {
                        NSRect placeFrame = [place convertRect:place.bounds toView:content];
                        NSRect issuedFrame = [issued convertRect:issued.bounds toView:content];
                        NSRect headerFrame = [header convertRect:header.bounds toView:content];
                        if (fabs(NSMidY(placeFrame) - NSMidY(headerFrame)) > 8 ||
                            fabs(NSMidY(issuedFrame) - NSMidY(headerFrame)) > 8)
                            POPFAIL("header controls share one row");
                    }
                    if (TrainButtonLayout(content)) POPFAIL("Train button");
                    NSTextField *mark = (NSTextField *)Find(content, @"hub.forecastMark");
                    if (!mark || !mark.hidden || mark.stringValue.length) POPFAIL("forecast word stays hidden");
                    if (wantGPU && gpu && !gpu.userMovedMap && !Find(gpu, @"gpumap.recenter").hidden)
                        POPFAIL("recenter stays hidden until the map moves");
                    if (lensID[lens]) {
                        if (!DetailFollowsMaps(content, lensID[lens])) POPFAIL("lens covers the map");
                    } else if (!MapsLeadDetails(content)) POPFAIL("map leads the popover");
                    if ([lens isEqual:@"fly"]) {
                        NSButton *airport = (NSButton *)Find(content, @"aviation.airport");
                        NSTextView *bulletin = (NSTextView *)Find(content, @"aviation.bulletin");
                        NSString *title = airport.title ?: @"";
                        NSString *code = nil;
                        for (NSString *word in [title componentsSeparatedByCharactersInSet:[[NSCharacterSet alphanumericCharacterSet] invertedSet]])
                            if (word.length == 4 && [word rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet].location == NSNotFound)
                                code = word;
                        if (title.length < 4 || !code || ![bulletin.string containsString:code]) {
                            fprintf(stderr, "fly title '%s'\n", title.UTF8String);
                            POPFAIL("fly shows the selected airport");
                        }
                    }
                    [content layoutSubtreeIfNeeded];
                    // The Fly bulletin is an NSTextView. Capturing it in the same
                    // bitmap as the map clears the map and the header. Draw the
                    // lens into its own bitmap and copy those pixels across.
                    NSView *inspector = Find(content, @"forecast.inspector");
                    BOOL restoreInspector = inspector && !inspector.hidden;
                    if (restoreInspector) inspector.hidden = YES;
                    NSImageView *picture = nil;
                    if (wantGPU && gpu) {
                        CGImageRef shot = [gpu copySnapshot];
                        if (!shot) POPFAIL("gpu snapshot");
                        else {
                            NSBitmapImageRep *shotRep = [[NSBitmapImageRep alloc] initWithCGImage:shot];
                            NSUInteger shotInk = 0, shotCoast = 0;
                            CountInk(shotRep, NSMakeRect(0, 0, shotRep.pixelsWide, shotRep.pixelsHigh), &shotInk, &shotCoast);
                            if (shotInk < 20 || shotCoast < 20) POPFAIL("gpu isobars and coastline");
                            IsobarCamera cam = gpu.camera;
                            struct { double lat, lon; const char *name; } coverage[] = {
                                {-10.68, 142.53, "cape york"},
                                {-43.64, 146.82, "tasmania"},
                                {-26.15, 113.15, "steep point"},
                                {-28.64, 153.64, "cape byron"},
                            };
                            for (NSUInteger i = 0; i < 4; i++) {
                                double x = 0, y = 0;
                                if (!IsobarCameraProject(cam, coverage[i].lat, coverage[i].lon, &x, &y) ||
                                    x < 0 || y < 0 || x > cam.viewportW || y > cam.viewportH) {
                                    fprintf(stderr, "coverage %s -> %.1f,%.1f in %.0fx%.0f\n",
                                        coverage[i].name, x, y, cam.viewportW, cam.viewportH);
                                    POPFAIL("australia coverage is in frame");
                                }
                            }
                            if (NSWidth(gpu.placeMarkerFrame) < 1) POPFAIL("place marker stays visible");
                            NSInteger labels = gpu.presentedLabelCount;
                            for (NSInteger i = 0; i < labels; i++) {
                                double ax = 0, ay = 0, aLevel = 0, aHalf = 0;
                                if (![gpu presentedLabelAtIndex:i x:&ax y:&ay level:&aLevel halfW:&aHalf]) continue;
                                uint32_t aIdent = [gpu presentedLabelIdentAtIndex:i];
                                for (NSInteger j = i + 1; j < labels; j++) {
                                    double bx = 0, by = 0, bLevel = 0, bHalf = 0;
                                    if (![gpu presentedLabelAtIndex:j x:&bx y:&by level:&bLevel halfW:&bHalf]) continue;
                                    double width = 2.0 * fmax(aHalf, bHalf);
                                    double need = fmax(3.0 * width, width + 24.0);
                                    uint32_t bIdent = [gpu presentedLabelIdentAtIndex:j];
                                    if (aIdent && aIdent == bIdent) need = fmax(need, 140.0);
                                    if (hypot(ax - bx, ay - by) < need - 0.5) {
                                        fprintf(stderr, "labels %.0f and %.0f gap %.1f need %.1f\n",
                                            aLevel, bLevel, hypot(ax - bx, ay - by), need);
                                        POPFAIL("isobar labels are spaced");
                                        i = labels;
                                        break;
                                    }
                                }
                            }
                            NSImage *image = [[NSImage alloc] initWithCGImage:shot size:gpu.bounds.size];
                            picture = [NSImageView imageViewWithImage:image];
                            picture.frame = gpu.frame;
                            picture.imageScaling = NSImageScaleAxesIndependently;
                            [gpu.superview addSubview:picture positioned:NSWindowAbove relativeTo:gpu];
                            // The Metal view does not cache, so the snapshot stands in for it.
                            // The legend is a sibling and must stay above that stand-in.
                            NSView *legend = Find(content, @"chart.legend");
                            if (legend) [legend.superview addSubview:legend positioned:NSWindowAbove relativeTo:picture];
                            CGImageRelease(shot);
                        }
                    }
                    NSBitmapImageRep *rep = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
                    [content cacheDisplayInRect:content.bounds toBitmapImageRep:rep];
                    [picture removeFromSuperview];
                    CGFloat scale = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
                    if (restoreInspector) {
                        inspector.hidden = NO;
                        [inspector layoutSubtreeIfNeeded];
                        NSBitmapImageRep *lensRep = [inspector bitmapImageRepForCachingDisplayInRect:inspector.bounds];
                        [inspector cacheDisplayInRect:inspector.bounds toBitmapImageRep:lensRep];
                        BlitRep(lensRep, rep, [inspector convertRect:inspector.bounds toView:content], scale);
                    }
                    NSView *mapView = wantGPU && gpu ? gpu : chart;
                    NSRect mapFrame = [mapView convertRect:mapView.bounds toView:content];
                    NSString *name = [NSString stringWithFormat:@"%@-%@-%@.png", look, mapName, lens];
                    NSUInteger ink = 0, coast = 0;
                    CountInk(rep, NSMakeRect(mapFrame.origin.x * scale, mapFrame.origin.y * scale,
                        mapFrame.size.width * scale, mapFrame.size.height * scale), &ink, &coast);
                    if (ink < 20 || coast < 20) {
                        fprintf(stderr, "ink %s bounds %s map %s ink %lu coast %lu\n", name.UTF8String,
                            NSStringFromRect(content.bounds).UTF8String, NSStringFromRect(mapFrame).UTF8String,
                            (unsigned long)ink, (unsigned long)coast);
                        POPFAIL("map ink and coastline");
                    }
                    if (llabs((long)rep.pixelsWide - lround(content.bounds.size.width * scale)) > 2 ||
                        llabs((long)rep.pixelsHigh - lround(content.bounds.size.height * scale)) > 2 || scale < 2)
                        POPFAIL("popover is captured at 2x");
                    if (wantGPU && [lens isEqual:@"pressure"] && [store containsString:@"/Data/isobar"]) {
                        int hx = -1, hy = -1;
                        if (MapBottomHasNoCoverage(rep, mapFrame, scale, &hx, &hy)) {
                            fprintf(stderr, "no-coverage %s at %d,%d map %s\n", name.UTF8String, hx, hy,
                                NSStringFromRect(mapFrame).UTF8String);
                            POPFAIL("bottom 12 px stay inside coverage");
                        }
                    }
                    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                    if (![png writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES]) POPFAIL("png write");
                    // Capture each coupled lens once more to check field pixels and coverage.
                    if (wantGPU && [lens isEqual:@"pressure"]) {
                        SelectLens(c, 3);
                        [c rebuildContent];
                        content = c.popover.contentViewController.view;
                        window.contentView = content;
                        content.appearance = [NSAppearance appearanceNamed:[look isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
                        [content layoutSubtreeIfNeeded];
                        gpu = (GPUMapView *)Find(content, @"popover.gpu");
                        if (![gpu isKindOfClass:GPUMapView.class]) POPFAIL("temperature field keeps the new map");
                        else {
                            [gpu waitForUploads];
                            CGImageRef fieldShot = [gpu copySnapshot];
                            if (!fieldShot) POPFAIL("temperature field snapshot");
                            else {
                                NSImage *fieldImage = [[NSImage alloc] initWithCGImage:fieldShot size:gpu.bounds.size];
                                NSImageView *fieldPicture = [NSImageView imageViewWithImage:fieldImage];
                                fieldPicture.frame = gpu.frame;
                                fieldPicture.imageScaling = NSImageScaleAxesIndependently;
                                [gpu.superview addSubview:fieldPicture positioned:NSWindowAbove relativeTo:gpu];
                                NSView *legend = Find(content, @"chart.legend");
                                if (!legend || legend.hidden || NSWidth(legend.frame) < 24)
                                    POPFAIL("temperature legend");
                                else [legend.superview addSubview:legend positioned:NSWindowAbove relativeTo:fieldPicture];
                                CGImageRelease(fieldShot);
                                NSBitmapImageRep *fieldRep = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
                                [content cacheDisplayInRect:content.bounds toBitmapImageRep:fieldRep];
                                [fieldPicture removeFromSuperview];
                                NSData *fieldPng = [fieldRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                                NSString *fieldName = [NSString stringWithFormat:@"%@-new-surfacetemp.png", look];
                                if (![fieldPng writeToFile:[dir stringByAppendingPathComponent:fieldName] atomically:YES])
                                    POPFAIL("png write");
                                if ([store containsString:@"/Data/isobar"]) {
                                    int hx = -1, hy = -1;
                                    NSRect fieldMap = [gpu convertRect:gpu.bounds toView:content];
                                    CGFloat fieldScale = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
                                    if (MapBottomHasNoCoverage(fieldRep, fieldMap, fieldScale, &hx, &hy)) {
                                        fprintf(stderr, "no-coverage %s at %d,%d\n", fieldName.UTF8String, hx, hy);
                                        POPFAIL("bottom 12 px stay inside coverage");
                                    }
                                }
                            }
                        }
                        SelectLens(c, 1);
                        [c rebuildContent];
                        content = c.popover.contentViewController.view;
                        window.contentView = content;
                        content.appearance = [NSAppearance appearanceNamed:[look isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
                        [content layoutSubtreeIfNeeded];
                        gpu = (GPUMapView *)Find(content, @"popover.gpu");
                        if (![gpu isKindOfClass:GPUMapView.class]) POPFAIL("rain field keeps the new map");
                        else {
                            [gpu waitForUploads];
                            CGImageRef rainShot = [gpu copySnapshot];
                            if (!rainShot) POPFAIL("rain field snapshot");
                            else {
                                NSImage *rainImage = [[NSImage alloc] initWithCGImage:rainShot size:gpu.bounds.size];
                                NSImageView *rainPicture = [NSImageView imageViewWithImage:rainImage];
                                rainPicture.frame = gpu.frame;
                                rainPicture.imageScaling = NSImageScaleAxesIndependently;
                                [gpu.superview addSubview:rainPicture positioned:NSWindowAbove relativeTo:gpu];
                                NSView *rainLegend = Find(content, @"chart.legend");
                                if (rainLegend) [rainLegend.superview addSubview:rainLegend positioned:NSWindowAbove relativeTo:rainPicture];
                                CGImageRelease(rainShot);
                                NSBitmapImageRep *rainRep = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
                                [content cacheDisplayInRect:content.bounds toBitmapImageRep:rainRep];
                                [rainPicture removeFromSuperview];
                                NSData *rainPng = [rainRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                                NSString *rainName = [NSString stringWithFormat:@"%@-new-rainlayer.png", look];
                                if (![rainPng writeToFile:[dir stringByAppendingPathComponent:rainName] atomically:YES])
                                    POPFAIL("png write");
                                if ([store containsString:@"/Data/isobar"]) {
                                    int hx = -1, hy = -1;
                                    NSRect rainMap = [gpu convertRect:gpu.bounds toView:content];
                                    CGFloat rainScale = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
                                    if (MapBottomHasNoCoverage(rainRep, rainMap, rainScale, &hx, &hy)) {
                                        fprintf(stderr, "no-coverage %s at %d,%d\n", rainName.UTF8String, hx, hy);
                                        POPFAIL("bottom 12 px stay inside coverage");
                                    }
                                }
                            }
                        }
                        SelectLens(c, 2);
                        [c rebuildContent];
                        content = c.popover.contentViewController.view;
                        window.contentView = content;
                        content.appearance = [NSAppearance appearanceNamed:[look isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
                        [content layoutSubtreeIfNeeded];
                        gpu = (GPUMapView *)Find(content, @"popover.gpu");
                        if (![gpu isKindOfClass:GPUMapView.class]) POPFAIL("wind field keeps the new map");
                        else {
                            [gpu waitForUploads];
                            CGImageRef windShot = [gpu copySnapshot];
                            if (!windShot) POPFAIL("wind field snapshot");
                            else {
                                NSImage *windImage = [[NSImage alloc] initWithCGImage:windShot size:gpu.bounds.size];
                                NSImageView *windPicture = [NSImageView imageViewWithImage:windImage];
                                windPicture.frame = gpu.frame;
                                windPicture.imageScaling = NSImageScaleAxesIndependently;
                                [gpu.superview addSubview:windPicture positioned:NSWindowAbove relativeTo:gpu];
                                CGImageRelease(windShot);
                                NSBitmapImageRep *windRep = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
                                [content cacheDisplayInRect:content.bounds toBitmapImageRep:windRep];
                                [windPicture removeFromSuperview];
                                NSData *windPng = [windRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                                NSString *windName = [NSString stringWithFormat:@"%@-new-wind.png", look];
                                if (![windPng writeToFile:[dir stringByAppendingPathComponent:windName] atomically:YES])
                                    POPFAIL("png write");
                                if ([store containsString:@"/Data/isobar"]) {
                                    int hx = -1, hy = -1;
                                    NSRect windMap = [gpu convertRect:gpu.bounds toView:content];
                                    CGFloat windScale = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
                                    if (MapBottomHasNoCoverage(windRep, windMap, windScale, &hx, &hy)) {
                                        fprintf(stderr, "no-coverage %s at %d,%d\n", windName.UTF8String, hx, hy);
                                        POPFAIL("bottom 12 px stay inside coverage");
                                    }
                                }
                            }
                        }
                        SelectLens(c, 0);
                        [c rebuildContent];
                        content = c.popover.contentViewController.view;
                        window.contentView = content;
                        content.appearance = [NSAppearance appearanceNamed:[look isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
                        [content layoutSubtreeIfNeeded];
                        gpu = (GPUMapView *)Find(content, @"popover.gpu");
                        if (![gpu isKindOfClass:GPUMapView.class]) POPFAIL("pressure plate keeps the new map");
                        else {
                            [gpu waitForUploads];
                            CGImageRef plateShot = [gpu copySnapshot];
                            if (!plateShot) POPFAIL("pressure plate snapshot");
                            else {
                                NSImage *plateImage = [[NSImage alloc] initWithCGImage:plateShot size:gpu.bounds.size];
                                NSImageView *platePicture = [NSImageView imageViewWithImage:plateImage];
                                platePicture.frame = gpu.frame;
                                platePicture.imageScaling = NSImageScaleAxesIndependently;
                                [gpu.superview addSubview:platePicture positioned:NSWindowAbove relativeTo:gpu];
                                CGImageRelease(plateShot);
                                NSBitmapImageRep *plateRep = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
                                [content cacheDisplayInRect:content.bounds toBitmapImageRep:plateRep];
                                [platePicture removeFromSuperview];
                                NSData *platePng = [plateRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                                NSString *plateName = [NSString stringWithFormat:@"%@-new-plate.png", look];
                                if (![platePng writeToFile:[dir stringByAppendingPathComponent:plateName] atomically:YES])
                                    POPFAIL("png write");
                                if ([store containsString:@"/Data/isobar"]) {
                                    int hx = -1, hy = -1;
                                    NSRect plateMap = [gpu convertRect:gpu.bounds toView:content];
                                    CGFloat plateScale = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
                                    if (MapBottomHasNoCoverage(plateRep, plateMap, plateScale, &hx, &hy)) {
                                        fprintf(stderr, "no-coverage %s at %d,%d\n", plateName.UTF8String, hx, hy);
                                        POPFAIL("bottom 12 px stay inside coverage");
                                    }
                                }
                            }
                        }
                        SelectLens(c, 1);
                    }
                }
            }
        }
        NSButton *on = [NSButton checkboxWithTitle:@"New map" target:nil action:nil];
        on.state = NSControlStateValueOn;
        [c toggleNewMap:on];
        [c rebuildContent];
        NSView *content = c.popover.contentViewController.view;
        window.contentView = content;
        [window orderBack:nil];
        [NSNotificationCenter.defaultCenter postNotificationName:NSPopoverDidShowNotification object:c.popover];
        GPUMapView *gpu = (GPUMapView *)Find(content, @"popover.gpu");
        if ([gpu isKindOfClass:GPUMapView.class]) {
            [gpu waitForUploads];
            CGFloat scale = window.backingScaleFactor > 1 ? window.backingScaleFactor : 1;
            NSPoint mid = NSMakePoint(NSMidX(gpu.bounds), NSMidY(gpu.bounds));
            NSPoint loc = [gpu convertPoint:mid toView:nil];
            NSDate *before = [c selectedForecastDate];
            [c inspectPopoverMovieFraction:0.82];
            NSDate *scrubbed = [c selectedForecastDate];
            if (!(fabs([scrubbed timeIntervalSinceDate:before]) > 3600)) POPFAIL("scrub leaves now");
            [window sendEvent:Mouse(NSEventTypeLeftMouseDown, window, loc, 1)];
            IsobarCamera cam = gpu.camera;
            double lat = 0, lon = 0;
            if (!IsobarCameraUnproject(cam, mid.x * scale, mid.y * scale, &lat, &lon)) POPFAIL("unproject");
            NSPoint dragged = NSMakePoint(mid.x + 90, mid.y - 50);
            NSPoint draggedLoc = [gpu convertPoint:dragged toView:nil];
            [window sendEvent:Mouse(NSEventTypeLeftMouseDragged, window, draggedLoc, 2)];
            [window sendEvent:Mouse(NSEventTypeLeftMouseUp, window, draggedLoc, 3)];
            double x = 0, y = 0;
            IsobarCameraProject(gpu.camera, lat, lon, &x, &y);
            double miss = hypot(x - dragged.x * scale, y - dragged.y * scale);
            if (miss > 1 || !gpu.userMovedMap) {
                fprintf(stderr, "drag miss %.2f px\n", miss);
                POPFAIL("drag keeps the geographic point under the pointer");
            }
            if (fabs([[c selectedForecastDate] timeIntervalSinceDate:scrubbed]) > 60) POPFAIL("drag does not return to now");
            if (Find(gpu, @"gpumap.recenter").hidden) POPFAIL("recenter appears after a drag");
            [gpu frameAustralia];
            mid = NSMakePoint(NSMidX(gpu.bounds), NSMidY(gpu.bounds));
            loc = [gpu convertPoint:mid toView:nil];
            cam = gpu.camera;
            IsobarCameraUnproject(cam, mid.x * scale, mid.y * scale, &lat, &lon);
            double zoom = cam.zoom;
            gPinchOverride = YES;
            [window sendEvent:Magnify(window, loc, 0.8)];
            gPinchOverride = NO;
            IsobarCameraProject(gpu.camera, lat, lon, &x, &y);
            miss = hypot(x - mid.x * scale, y - mid.y * scale);
            if (miss > 1 || !(gpu.camera.zoom > zoom * 1.4)) {
                fprintf(stderr, "pinch miss %.2f px zoom %.2f -> %.2f\n", miss, zoom, gpu.camera.zoom);
                POPFAIL("pinch zooms about the pointer");
            }
            [gpu frameAustralia];
            [(NSButton *)Find(gpu, @"gpumap.flat") performClick:nil];
            cam = gpu.camera;
            IsobarCameraUnproject(cam, mid.x * scale, mid.y * scale, &lat, &lon);
            [window sendEvent:Scroll(window, loc, NSEventPhaseBegan, 0)];
            [window sendEvent:Scroll(window, loc, NSEventPhaseChanged, -36)];
            [window sendEvent:Scroll(window, loc, NSEventPhaseEnded, 0)];
            if (!(gpu.camera.zoom > cam.zoom) || gpu.camera.pitch != 0 || gpu.camera.globe != 0)
                POPFAIL("two-finger scroll zooms in 2D without tilting");
            [gpu frameAustralia];
            [(NSButton *)Find(gpu, @"gpumap.sphere") performClick:nil];
            cam = gpu.camera;
            [window sendEvent:Scroll(window, loc, NSEventPhaseBegan, 0)];
            [window sendEvent:Scroll(window, loc, NSEventPhaseChanged, -36)];
            [window sendEvent:Scroll(window, loc, NSEventPhaseEnded, 0)];
            IsobarCamera tilted = gpu.camera;
            if (!(tilted.pitch > cam.pitch + .05) || fabs(tilted.zoom - cam.zoom) > 1e-8 ||
                fabs(tilted.centreLat - cam.centreLat) > 1e-8 || fabs(tilted.centreLon - cam.centreLon) > 1e-8)
                POPFAIL("two-finger scroll tilts in selected 3D while retaining focus and scale");
            if (fabs([[c selectedForecastDate] timeIntervalSinceDate:scrubbed]) > 1)
                POPFAIL("tilt preserves forecast time");
            [gpu frameAustralia];
            loc = [gpu convertPoint:NSMakePoint(NSMidX(gpu.bounds), NSMidY(gpu.bounds)) toView:nil];
            [c inspectPopoverMovieFraction:0.7];
            NSDate *held = [c selectedForecastDate];
            [window sendEvent:Mouse(NSEventTypeLeftMouseDown, window, loc, 4)];
            NSDate *holdStart = [c selectedForecastDate];
            [c advanceLiveTicks:1];
            if (fabs([[c selectedForecastDate] timeIntervalSinceDate:holdStart]) > 0.01)
                POPFAIL("click-and-hold freezes the selected forecast time");
            [window sendEvent:Mouse(NSEventTypeLeftMouseUp, window, loc, 5)];
            if (fabs([[c selectedForecastDate] timeIntervalSinceDate:held]) > 1)
                POPFAIL("click preserves the selected forecast time");
            [c startLivePlaybackFromDate:held];
            [window sendEvent:Mouse(NSEventTypeLeftMouseDown, window, loc, 6)];
            NSDate *pointerHeld = [c selectedForecastDate];
            [c advanceLiveTicks:8];
            if (gpu.timeline.playing || fabs([[c selectedForecastDate] timeIntervalSinceDate:pointerHeld]) > .01)
                POPFAIL("pointer hold freezes the real controller clock");
            [window sendEvent:Mouse(NSEventTypeLeftMouseUp, window, loc, 7)];
            if (!gpu.timeline.playing) POPFAIL("pointer release restores playing state");
            // A seek can need one asynchronously prepared frame before advancing.
            for (int tick = 0; tick < 60 && [[c selectedForecastDate] timeIntervalSinceDate:pointerHeld] <= 0; tick++) {
                PumpMainRunLoop(.02);
                [c advanceLiveTicks:1];
            }
            if ([[c selectedForecastDate] timeIntervalSinceDate:pointerHeld] <= 0) {
                fprintf(stderr, "hold release playing=%d holding=%d advance=%.3f\n", gpu.timeline.playing,
                    gpu.timeline.holding, [[c selectedForecastDate] timeIntervalSinceDate:pointerHeld]);
                POPFAIL("pointer release resumes from the held forecast time");
            }
            double samples[120], contours[120], labels[120], projects[120], geoms[120];
            NSTimeInterval origin = [gpu.timeline clockNow];
            for (int i = 0; i < 24; i++) [gpu displayAtTime:origin + i / 120.0];
            for (int i = 0; i < 120; i++) {
                [gpu displayAtTime:origin + (24 + i) / 120.0];
                samples[i] = gpu.lastFrameMilliseconds;
                contours[i] = gpu.lastContourMilliseconds;
                labels[i] = gpu.lastLabelMilliseconds;
                projects[i] = gpu.lastProjectMilliseconds;
                geoms[i] = gpu.lastGeometryMilliseconds;
            }
            // insertion sort for p95
            for (int i = 1; i < 120; i++) {
                double v = samples[i]; int j = i;
                while (j > 0 && samples[j - 1] > v) { samples[j] = samples[j - 1]; j--; }
                samples[j] = v;
            }
            double p50 = samples[60];
            double p95 = samples[(int)llround(119 * 0.95)];
            double cpy[120], lpy[120], ppy[120], gpy[120];
            memcpy(cpy, contours, sizeof cpy);
            memcpy(lpy, labels, sizeof lpy);
            memcpy(ppy, projects, sizeof ppy);
            memcpy(gpy, geoms, sizeof gpy);
            for (int i = 1; i < 120; i++) {
                double v = cpy[i]; int j = i;
                while (j > 0 && cpy[j - 1] > v) { cpy[j] = cpy[j - 1]; j--; }
                cpy[j] = v;
                v = lpy[i]; j = i;
                while (j > 0 && lpy[j - 1] > v) { lpy[j] = lpy[j - 1]; j--; }
                lpy[j] = v;
                v = ppy[i]; j = i;
                while (j > 0 && ppy[j - 1] > v) { ppy[j] = ppy[j - 1]; j--; }
                ppy[j] = v;
                v = gpy[i]; j = i;
                while (j > 0 && gpy[j - 1] > v) { gpy[j] = gpy[j - 1]; j--; }
                gpy[j] = v;
            }
            int i95 = (int)llround(119 * 0.95);
            fprintf(stderr, "popover frame p50 %.2f p95 %.2f ms contour p50 %.2f p95 %.2f label p50 %.2f p95 %.2f project p50 %.2f p95 %.2f geom p50 %.2f p95 %.2f lines %ld\n",
                p50, p95, cpy[60], cpy[i95], lpy[60], lpy[i95], ppy[60], ppy[i95], gpy[60], gpy[i95],
                (long)gpu.contourLineCount);
            if ([store containsString:@"/Data/isobar"] && !(p95 < 8)) POPFAIL("real-data frame p95 under 8 ms (one 120 Hz frame)");
            // The hazard layer on: a new CB frame key every display (a fast
            // sweep), then a pan every display (the overlay redraws each time).
            {
                IsobarLivePlayer *held = gpu.timeline;
                double baseStep = gpu.fractionalStep;
                // Pause the shared player so display callbacks cannot
                // override this benchmark's manually supplied frame index.
                BOOL resumeHazardPlayback = held.playing;
                if (resumeHazardPlayback) [held pause];
                gpu.timeline = held;
                // This section drives the renderer faster than a real
                // drawable can be released.  Put the map off-window while
                // measuring the scratch path so the production present
                // watchdog does not mistake a deliberately unavailable
                // CAMetalDrawable for a failed popover.
                NSView *hazardContent = window.contentView;
                NSView *hazardHost = [[NSView alloc] initWithFrame:window.contentView.bounds];
                window.contentView = hazardHost;
                gpu.hazardStoreRoot = store;
                gpu.hazards = YES;
                [gpu waitForHazards];
                double hz[240], hzOverlay[240];
                for (int i = 0; i < 24; i++) {
                    gpu.fractionalStep = baseStep + i * 0.021;
                    [gpu displayAtTime:origin + (144 + i) / 120.0];
                }
                for (int i = 0; i < 240; i++) {
                    // Let queued CB frames land, as the display link's run loop would.
                    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.004]];
                    if (i < 120) gpu.fractionalStep = baseStep + (24 + i) * 0.021;
                    else {
                        NSPoint start = NSMakePoint(NSMidX(gpu.bounds), NSMidY(gpu.bounds));
                        if (i == 120) [gpu pointerDown:start];
                        [gpu pointerDrag:NSMakePoint(start.x + i - 119, start.y)];
                    }
                    [gpu displayAtTime:origin + (168 + i) / 120.0];
                    hz[i] = gpu.lastFrameMilliseconds;
                    hzOverlay[i] = gpu.lastHazardMilliseconds;
                }
                [gpu pointerUp:NSMakePoint(NSMidX(gpu.bounds) + 120, NSMidY(gpu.bounds))];
                for (int part = 0; part < 2; part++) {
                    double *f = hz + part * 120, *o = hzOverlay + part * 120;
                    for (int i = 1; i < 120; i++) {
                        double v = f[i], w = o[i]; int j = i;
                        while (j > 0 && f[j - 1] > v) { f[j] = f[j - 1]; j--; }
                        f[j] = v;
                        j = i;
                        while (j > 0 && o[j - 1] > w) { o[j] = o[j - 1]; j--; }
                        o[j] = w;
                    }
                    fprintf(stderr, "popover hazards %s frame p50 %.2f p95 %.2f ms overlay p50 %.2f p95 %.2f\n",
                        part ? "pan" : "sweep", f[60], f[i95], o[60], o[i95]);
                    if ([store containsString:@"/Data/isobar"] && !(f[i95] < 8))
                        POPFAIL("real-data frame p95 under 8 ms with the hazard layer");
                }
                if ([store containsString:@"/Data/isobar"] && gpu.hazardsReady) {
                    CGImageRef hazardShot = [gpu copySnapshot];
                    if (!hazardShot || (gpu.hazardLabels.count && ![gpu.hazardLabels containsObject:@"CB potential (model)"]))
                        POPFAIL("hazard snapshot draws its key");
                    if (hazardShot) CGImageRelease(hazardShot);
                }
                gpu.hazards = NO;
                [gpu frameAustralia];
                gpu.fractionalStep = baseStep;
                gpu.timeline = held;
                if (held && resumeHazardPlayback)
                    [held playFromDate:held.playhead ?: [c selectedForecastDate]];
                window.contentView = hazardContent;
                // Hazard preparation may rebuild the popover content while
                // the map keeps its controller identity. Reattach the current
                // content before exercising drawable presentation transitions.
                content = c.popover.contentViewController.view;
                window.contentView = content;
                gpu = (GPUMapView *)Find(content, @"popover.gpu");
            }
            NSMutableArray *frames = [NSMutableArray array];
            IsobarLivePlayer *player = gpu.timeline;
            if (player) {
                // A map click preserves pause. Start this playback recording
                // explicitly instead of relying on the old click-to-Now action.
                [c startLivePlaybackFromDate:[c selectedForecastDate]];
                NSTimeInterval movieOrigin = [player clockNow];
                for (int i = 0; i < 180; i++) {
                    if (i > 0 && i % 2 == 0) [c advanceLiveTicks:1];
                    [gpu displayAtTime:movieOrigin + i / 60.0];
                    CGImageRef shot = [gpu copySnapshot];
                    if (shot) [frames addObject:CFBridgingRelease(shot)];
                }
            }
            if (frames.count == 180 && !WriteMovie(frames, [dir stringByAppendingPathComponent:@"playback.mov"], 60))
                POPFAIL("popover playback movie");
            window.scriptOcclusion = YES;
            window.scriptedOcclusion = NSWindowOcclusionStateVisible;
            PostOcclusion(window);
            [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.08]];
            window.scriptedOcclusion = 0;
            PostOcclusion(window);
            NSUInteger covered = gpu.presentedCount;
            window.scriptedOcclusion = NSWindowOcclusionStateVisible;
            PostOcclusion(window);
            if (!(gpu.presentedCount > covered) || gpu.presentedFrameBlank)
                POPFAIL("occlusion keeps presenting");
            covered = gpu.presentedCount;
            gpu.hidden = YES;
            gpu.hidden = NO;
            [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.08]];
            if (!(gpu.presentedCount > covered) || gpu.presentedFrameBlank)
                POPFAIL("unhide keeps presenting");
            covered = gpu.presentedCount;
            [gpu setFrameSize:NSMakeSize(MAX(120, NSWidth(gpu.frame) - 40), MAX(80, NSHeight(gpu.frame) - 24))];
            [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.08]];
            if (!(gpu.presentedCount > covered) || gpu.presentedFrameBlank)
                POPFAIL("resize keeps presenting");
            if (!SelectLens(c, 0) || !ClickLens(c, 6)) POPFAIL("Fly segment action");
            content = c.popover.contentViewController.view;
            window.contentView = content;
            gpu = (GPUMapView *)Find(content, @"popover.gpu");
            if ([gpu isKindOfClass:GPUMapView.class]) {
                [gpu waitForUploads];
                [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.08]];
                covered = gpu.presentedCount;
                [gpu presentNow];
                if (!(gpu.presentedCount > covered) || gpu.presentedFrameBlank)
                    POPFAIL("opening Fly keeps presenting");
                if (!ClickLens(c, 6)) POPFAIL("Fly reselect action");
                content = c.popover.contentViewController.view;
                window.contentView = content;
                gpu = (GPUMapView *)Find(content, @"popover.gpu");
                if ([gpu isKindOfClass:GPUMapView.class]) {
                    [gpu waitForUploads];
                    covered = gpu.presentedCount;
                    [gpu presentNow];
                    if (!(gpu.presentedCount > covered) || gpu.presentedFrameBlank)
                        POPFAIL("closing Fly keeps presenting");
                } else POPFAIL("closing Fly keeps the new map");
            } else POPFAIL("opening Fly keeps the new map");
            if ([gpu isKindOfClass:GPUMapView.class]) {
                gpu.suppressPresentation = YES;
                NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.8];
                while (Find(c.popover.contentViewController.view, @"popover.gpu") && deadline.timeIntervalSinceNow > 0)
                    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
                content = c.popover.contentViewController.view;
                window.contentView = content;
                if (Find(content, @"popover.gpu")) POPFAIL("a map that never presents falls back to the classic chart");
                NSView *chartBack = Find(content, @"popover.chart");
                if (!chartBack || chartBack.hidden) POPFAIL("the classic chart replaces the blank map");
            }
        } else POPFAIL("new map accepts drag and pinch");
        NSButton *classic = [NSButton checkboxWithTitle:@"New map" target:nil action:nil];
        classic.state = NSControlStateValueOff;
        [c toggleNewMap:classic];
        [c rebuildContent];
        content = c.popover.contentViewController.view;
        window.contentView = content;
        if (Find(content, @"popover.gpu")) POPFAIL("classic popover has no gpu map");
        NSView *chart = Find(content, @"popover.chart");
        if (!chart || chart.hidden) POPFAIL("classic chart remains");
        [c inspectPopoverMovieFraction:0.75];
        NSDate *classicHeld = [c selectedForecastDate];
        NSPoint chartLoc = [chart convertPoint:NSMakePoint(NSMidX(chart.bounds), NSMidY(chart.bounds)) toView:nil];
        [window sendEvent:Mouse(NSEventTypeLeftMouseDown, window, chartLoc, 6)];
        [window sendEvent:Mouse(NSEventTypeLeftMouseUp, window, chartLoc, 7)];
        if (fabs([[c selectedForecastDate] timeIntervalSinceDate:classicHeld]) > 60) POPFAIL("classic click leaves the selected forecast time");
    } @finally {
        TrainingWindowDismiss();
        [window orderOut:nil];
        [window close];
    }
    fprintf(stderr, "popover failures: %d\n", failures);
    return failures;
#undef POPFAIL
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
        if (getenv("ISOBAR_POPOVER_TIMING")) {
            int failures = [c chartsReady] ? 0 : 1;
            failures += CheckPopoverMap(c, root);
            printf("acceptance failures: %d\n", failures);
            printf("popover failures: %d\n", failures);
            return failures ? 1 : 0;
        }
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
        // The explicit Now action still starts playback with reduced motion.
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
        NSDictionary *calm = FooterWindModel(@{@"windDir": @"N", @"windKt": @0});
        NSDictionary *variable = FooterWindModel(@{@"windKt": @6});
        NSDictionary *missing = FooterWindModel(@{});
        NSDictionary *negative = FooterWindModel(@{@"windKt": @-5});
        NSDictionary *nan = FooterWindModel(@{@"windKt": @(NAN)});
        NSDictionary *converted = FooterWindModel(@{@"windDir": @"WSW", @"windKmh": @11.112});
        if (![north[@"hasDirection"] boolValue] || ![north[@"hasSpeed"] boolValue] ||
            [north[@"calm"] boolValue] ||
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
            fabs([converted[@"toDeg"] doubleValue] - 67.5) > 0.01) {
            FAIL();
        }
        NSButton *footer = (NSButton *)Find(defaultView, @"popover.obs");
        if (!footer || ![footer.attributedTitle.string containsString:@"17°"] ||
            ![footer.attributedTitle.string containsString:@"6 kt"] ||
            HasAttachment(footer.attributedTitle) ||
            [footer.attributedTitle.string.lowercaseString containsString:@"now"] ||
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
            [c setValue:@-1 forKey:@"selectedLens"]; [c setValue:@-1 forKey:@"forecastMode"];
            [c rebuildContent];
            NSView *closed = c.popover.contentViewController.view;
            NSView *closedMap = Find(closed, @"popover.chart");
            NSRect closedMapRect = [closedMap convertRect:closedMap.bounds toView:closed];
            CGFloat closedWidth = NSWidth(closedMapRect);
            CGFloat closedPopoverWidth = NSWidth(closed.frame);
            NSNumber *selectedBefore = [[c valueForKey:@"shownLeft"] copy];
            for (NSNumber *mode in @[@0,@1,@2,@3,@4]) {
                [c setValue:mode forKey:@"selectedLens"]; [c setValue:mode forKey:@"forecastMode"];
                [c rebuildContent];
                NSView *open = c.popover.contentViewController.view;
                NSView *openMap = Find(open, @"popover.chart");
                NSView *inspector = Find(open, @"forecast.inspector");
                // UX-045: the popover keeps its width or gains exactly a side column that does not cover the map.
                NSRect inspectorRect = inspector ? [inspector convertRect:inspector.bounds toView:open] : NSZeroRect;
                NSRect openMapRect0 = openMap ? [openMap convertRect:openMap.bounds toView:open] : NSZeroRect;
                BOOL sameWidth = fabs(NSWidth(open.frame)-closedPopoverWidth)<=.5;
                BOOL sideColumn = NSWidth(open.frame)>closedPopoverWidth && NSMinX(inspectorRect)>=closedPopoverWidth &&
                    !NSIntersectsRect(inspectorRect, openMapRect0);
                if (NSWidth(open.frame)>c.budget.width || NSHeight(open.frame)>c.budget.height ||
                    !(sameWidth || sideColumn)) FAIL();
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
            else { [c setValue:@-1 forKey:@"selectedLens"]; [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent]; }
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
        // The Fly lens parses TAF periods at the chart clock. This harness
        // freezes that clock with ISOBAR_CHECK_NOW; a real-format TAF in the
        // archive has expired on the wall clock, so the count has to use the
        // same instant the lens draws.
        NSString *frozen = NSProcessInfo.processInfo.environment[@"ISOBAR_CHECK_NOW"];
        NSDate *chartNow = frozen.length ? [[NSISO8601DateFormatter new] dateFromString:frozen] : nil;
        NSDictionary *aviation = AviationOutlook([c valueForKey:@"aviation"], chartNow ?: NSDate.date, [c placeZone]);
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
        NSMutableArray<NSNumber *> *heartbeats=[NSMutableArray array];
        NSView *preparingView=c.popover.contentViewController.view;
        NSBitmapImageRep *preparingBitmap=[preparingView bitmapImageRepForCachingDisplayInRect:preparingView.bounds];
        NSUInteger paintedDuringPreparation=0;
        while (preparation.operationCount && preparationDeadline.timeIntervalSinceNow>0) {
            NSTimeInterval pulse=NSDate.timeIntervalSinceReferenceDate;
            [preparingView cacheDisplayInRect:preparingView.bounds toBitmapImageRep:preparingBitmap];
            paintedDuringPreparation++;
            PumpMainRunLoop(.01);
            double beat=NSDate.timeIntervalSinceReferenceDate-pulse;
            worstWarmHeartbeat=MAX(worstWarmHeartbeat,beat);
            [heartbeats addObject:@(beat)];
        }
        PumpMainRunLoop(.02);
        // Baseline: the same main-thread paint once preparation has finished, so the
        // check measures what preparation adds, not how fast this machine is today.
        NSMutableArray<NSNumber *> *idleBeats=[NSMutableArray array];
        {
            NSView *idleView=c.popover.contentViewController.view;
            NSBitmapImageRep *idleBitmap=[idleView bitmapImageRepForCachingDisplayInRect:idleView.bounds];
            for (int i=0; i<12; i++) {
                NSTimeInterval pulse=NSDate.timeIntervalSinceReferenceDate;
                [idleView cacheDisplayInRect:idleView.bounds toBitmapImageRep:idleBitmap];
                PumpMainRunLoop(.01);
                [idleBeats addObject:@(NSDate.timeIntervalSinceReferenceDate-pulse)];
            }
            [idleBeats sortUsingSelector:@selector(compare:)];
        }
        double idleHeartbeat=idleBeats[(NSUInteger)ceil(idleBeats.count*.95)-1].doubleValue;
        // The first paint may draw the visible frame itself before its prepared copy lands; that
        // one draw is the visible map, not background work. Judge every later paint: preparation
        // must not stall the main thread. The 95th percentile ignores a single scheduler hiccup.
        double firstBeat=heartbeats.count ? heartbeats.firstObject.doubleValue : 0;
        if (heartbeats.count > 1) [heartbeats removeObjectAtIndex:0];
        else if (heartbeats.count == 1 && firstBeat <= .5) [heartbeats removeAllObjects];
        [heartbeats sortUsingSelector:@selector(compare:)];
        double p95Heartbeat=heartbeats.count ? heartbeats[MIN(heartbeats.count-1,(NSUInteger)ceil(heartbeats.count*.95)-1)].doubleValue : 0;
        double p95Limit=MAX(.15,idleHeartbeat*1.5+.05), maxLimit=MAX(.5,idleHeartbeat*3);
        double laterMax=heartbeats.count ? heartbeats.lastObject.doubleValue : 0;
        printf("prepare responsive heartbeat first %.4fs, later p95 %.4fs max %.4fs (idle p95 %.4fs; limits %.3f/%.3f), %lu cached images\n",
            firstBeat,p95Heartbeat,laterMax,idleHeartbeat,p95Limit,maxLimit,
            (unsigned long)[[c valueForKey:@"chartCache"] count]);
        printf("main-thread painted %lu times during background preparation\n",(unsigned long)paintedDuringPreparation);
        if (preparation.operationCount || p95Heartbeat>p95Limit || laterMax>maxLimit || worstWarmHeartbeat>MAX(.5,maxLimit)) FAIL();
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
            // Arm the intentional hover before measuring continuous scrubbing.
            // The 300 ms entry dwell is a control contract, not a dropped frame.
            [strip mouseMoved:TimelineMouseEvent(NSEventTypeMouseMoved,strip,.18,499)];
            PumpMainRunLoop(.4);
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
                [c setValue:@(mode) forKey:@"selectedLens"]; [c setValue:@(mode) forKey:@"forecastMode"];
                [c setValue:mode<0 ? [NSMutableSet set] : [NSMutableSet setWithObject:@(mode)] forKey:@"mapDetailModes"];
                [[c valueForKey:@"mapDetailCache"] removeAllObjects];
                [c rebuildContent];
                NSView *view = c.popover.contentViewController.view;
                view.appearance = [NSAppearance appearanceNamed:appearance];
                if (NSWidth(view.frame)>c.budget.width || NSHeight(view.frame)>c.budget.height ||
                    Find(view,@"popover.next") || Find(view,@"popover.prev") || !Find(view,@"popover.play") || !Find(view,@"popover.settings") ||
                    TrainButtonLayout(view) ||
                    Find(view,@"forecast.back") || !Visible(view,@"popover.timeline") || !MapsLeadDetails(view) ||
                    Find(view,@"popover.headline") || Find(view,@"popover.note")) FAIL();
                NSString *panelID = mode == 0 ? @"popover.windForecast" : (mode == 1 ? @"popover.aviation" : (mode == 3 ? @"popover.surf" : (mode == 4 ? @"popover.temperature" : @"popover.rain")));
                if (mode >= 0 && !Find(view,panelID)) FAIL();
                if (mode >= 0 && (!Find(view,@"forecast.close") || !DetailFollowsMaps(view,panelID))) FAIL();
                if (mode < 0 && (Find(view,@"popover.rain") || Find(view,@"popover.aviation") || Find(view,@"popover.windForecast") || Find(view,@"popover.surf"))) FAIL();
                NSSegmentedControl *lensRow = (NSSegmentedControl *)Find(view, @"popover.lens");
                if (!lensRow || lensRow.segmentCount != 7 || NSWidth(lensRow.frame) + .5 < lensRow.intrinsicContentSize.width) FAIL();
                NSInteger selectedMode = [lensRow tagForSegment:lensRow.selectedSegment];
                if (mode >= 0 && selectedMode != mode) FAIL();
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
                    NSString *reading=[(NSTextField *)Find(view,@"forecast.reading") stringValue];
                    if (Find(view,@"rain.headline") || ![reading containsString:@"mm/h"] || ![reading containsString:@"24 h"]) FAIL();
                    [timeline inspectDate:[timeline.outlook[@"hours"] firstObject][@"start"]];
                    [timeline inspectDate:nil];
                    if (![[(NSTextField *)Find(view,@"forecast.reading") stringValue] isEqual:reading]) FAIL();
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
                [c setValue:@-1 forKey:@"selectedLens"]; [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
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
        [c setValue:@-1 forKey:@"selectedLens"]; [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
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
        [c setValue:@-1 forKey:@"selectedLens"]; [c setValue:@-1 forKey:@"forecastMode"]; [c rebuildContent];
        Save(c.popover.contentViewController.view,[output stringByAppendingPathComponent:@"all-layers.png"]);
        // Place readings have no menu now; the lenses carry them. Clear the seeded set.
        [[c valueForKey:@"mapDetailModes"] removeAllObjects]; [c saveMapDetails]; [c rebuildContent];
        if ([[c valueForKey:@"mapDetailModes"] count] || [(PDFCropView *)Find(c.popover.contentViewController.view,@"popover.chart") mapDetails].count) FAIL();
        // Exercise every actual segment, its field/panel coupling, and repeat-click reset.
        NSInteger panelModes[] = {-1, 2, -1, 4, 0, 3, 1};
        NSInteger fields[] = {0, 1, 2, 3, 2, 0, 0};
        for (NSInteger segment = 0; segment < 7; segment++) {
            if (!SelectLens(c, 0) || !ClickLens(c, segment)) FAIL();
            if ([[c valueForKey:@"forecastMode"] integerValue] != panelModes[segment] || [c mapField] != fields[segment]) FAIL();
            if (!ClickLens(c, segment)) FAIL();
            if ([[c valueForKey:@"forecastMode"] integerValue] != -1 || [c mapField] != 0) FAIL();
        }
        [c setValue:@2 forKey:@"selectedLens"]; [c setValue:@2 forKey:@"forecastMode"];
        [c rebuildContent];
        NSButton *close = (NSButton *)Find(c.popover.contentViewController.view, @"forecast.close");
        if (!close) FAIL();
        if (close) {
            [close performClick:nil];
            if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        }
        [c setValue:@0 forKey:@"selectedLens"]; [c setValue:@0 forKey:@"forecastMode"];
        [c rebuildContent];
        [c escapePopover];
        if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        if (!ClickLens(c, 4)) FAIL();
        if ([[c valueForKey:@"forecastMode"] integerValue] != 0) FAIL();
        [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:c.popover]];
        if ([[c valueForKey:@"forecastMode"] integerValue] != -1) FAIL();
        [c setValue:@2 forKey:@"selectedLens"]; [c setValue:@2 forKey:@"forecastMode"];
        [c rebuildContent];
        if (!ClickLens(c, 6)) FAIL();
        if ([[c valueForKey:@"forecastMode"] integerValue] != 1 ||
            Find(c.popover.contentViewController.view,@"rain.timeline")) FAIL();
        [c setValue:@0 forKey:@"selectedLens"]; [c setValue:@0 forKey:@"forecastMode"];
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
                @"fullscreen.days",@"fullscreen.issued",@"fullscreen.compare",@"fullscreen.close",@"fullscreen.lensRow",@"fullscreen.lens",@"fullscreen.barbs",@"fullscreen.hazards"])
                if (!Find(fullscreen,identifier)) FAIL();
            PDFCropView *singleMap=(PDFCropView *)Find(fullscreen,@"window.chart");
            TimelineStrip *windowTimeline=(TimelineStrip *)Find(fullscreen,@"fullscreen.timeline");
            if (NSHeight(windowTimeline.frame)!=28 || !windowTimeline.bandDates.count || windowTimeline.labels.count<2 ||
                windowTimeline.labels.count!=windowTimeline.times.count) FAIL();
            [c zoomChart:1];
            if ([[c valueForKey:@"panelZoom"] doubleValue]<=1 || Find(fullscreen,@"window.chart")!=singleMap) FAIL();
            [c zoomChart:0];
            if ([[c valueForKey:@"panelZoom"] doubleValue]!=1) FAIL();
            [c focusFullscreenPanel:1];
            NSButton *compare=(NSButton *)Find(fullscreen,@"fullscreen.compare");
            if (compare.enabled!=([c earlierIssueForIndex:1]>=0)) FAIL();
            [c toggleIssueCompare];
            if ([c earlierIssueForIndex:1]>=0 && ![[c valueForKey:@"comparing"] boolValue]) FAIL();
            [c toggleIssueCompare];
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1280,720)],
                                    [NSValue valueWithSize:NSMakeSize(1024,600)],
                                    [NSValue valueWithSize:NSMakeSize(640,480)],
                                    [NSValue valueWithSize:NSMakeSize(1512,982)]]) {
                NSSize budget=size.sizeValue;
                [c.chartWindow setFrame:NSMakeRect(0,0,budget.width,budget.height) display:NO]; [c layoutChartWindow];
                NSView *surface=c.chartWindow.contentView;
                NSView *bar=Find(surface,@"fullscreen.toolbar"), *transport=Find(surface,@"fullscreen.transport");
                NSView *mapArea=Find(surface,@"fullscreen.chartScroll"), *footer=Find(surface,@"fullscreen.statusBar");
                if (!bar || !transport || !mapArea || !footer || Find(surface,@"window.chart")!=singleMap ||
                    Find(surface,@"fullscreen.timeline")!=windowTimeline || NSMinY(mapArea.frame)<NSMaxY(bar.frame) ||
                    NSMinY(mapArea.frame)<NSMaxY(transport.frame) || NSMaxY(mapArea.frame)>NSMinY(footer.frame)) FAIL();
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
            if (profile.aircraftMarkerRects.count!=(profile.sectionView?0:7) || [profile yForHeight:20000]>=[profile yForHeight:1000]) FAIL();
            if (profile.sectionView && !NSEqualRects(profile.sectionView.frame,profile.sectionRect)) FAIL();
            if (![profile.timeZone.name isEqual:[c aviationTimeZone].name]) FAIL();
            Save(profile,[output stringByAppendingPathComponent:@"atmosphere-1024x600.png"]);
            profile.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
            Save(profile,[output stringByAppendingPathComponent:@"atmosphere-dark-1024x600.png"]);
        } @finally { [[c valueForKey:@"atmosphereWindow"] close]; }
        failures += CheckPopoverMap(c, root);
        printf("acceptance failures: %d\n",failures);
        return failures ? 1 : 0;
    }
}
