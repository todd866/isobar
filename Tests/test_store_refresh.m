// Exercise the real controller against disposable disk snapshots. No app launch,
// network request, status item, visible window, or preference write.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop
#include <sys/resource.h>
#include <mach/mach_time.h>
#import <sqlite3.h>
#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreVideo/CoreVideo.h>
#import "test_accessibility.h"

static int failures;

@interface FallbackGestureEvent : NSEvent
@property(nonatomic) CGFloat gestureMagnification;
@property(nonatomic) NSPoint gestureLocation;
@property(nonatomic) NSEventPhase gesturePhase;
@property(nonatomic) CGFloat gestureDX;
@property(nonatomic) CGFloat gestureDY;
@property(nonatomic) NSEventModifierFlags gestureFlags;
@property(nonatomic) BOOL gesturePrecise;
@end
@implementation FallbackGestureEvent
- (CGFloat)magnification { return _gestureMagnification; }
- (NSPoint)locationInWindow { return _gestureLocation; }
- (NSEventPhase)phase { return _gesturePhase; }
- (CGFloat)scrollingDeltaX { return _gestureDX; }
- (CGFloat)scrollingDeltaY { return _gestureDY; }
- (NSEventModifierFlags)modifierFlags { return _gestureFlags; }
- (BOOL)hasPreciseScrollingDeltas { return _gesturePrecise; }
@end
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

static NSSegmentedControl *LensControl(Controller *c) {
    return (NSSegmentedControl *)FindView(c.popover.contentViewController.view, @"popover.lens");
}

static void ClickLens(Controller *c, NSInteger tag) {
    NSSegmentedControl *row = LensControl(c);
    for (NSInteger i = 0; i < row.segmentCount; i++) {
        if ([row tagForSegment:i] != tag) continue;
        row.selectedSegment = i;
        [NSApp sendAction:row.action to:row.target from:row];
        return;
    }
}

// Keep fixture-only mode seeding coherent with the shared lens selector.
static void SeedForecastMode(Controller *c, NSInteger mode) {
    NSInteger lens = mode < 0 ? -1 : mode == 2 ? 2 : mode == 4 ? 4 : mode == 0 ? 0 : mode == 3 ? 3 : 1;
    [c setValue:@(lens) forKey:@"selectedLens"];
    [c setValue:@(mode) forKey:@"forecastMode"];
}

static BOOL MapsLeadDetails(NSView *view) {
    NSView *map = FindView(view, @"popover.chart");
    NSView *right = FindView(view, @"popover.chart.right");
    NSView *layers = FindView(view, @"popover.lensRow");
    NSView *legend = FindView(view, @"chart.legend");
    NSView *timeline = FindView(view, @"popover.timeline");
    // Header, day tiles, one slider row, map, then the lens bar.
    NSView *days = FindView(view, @"hub.days");
    if (!map || map.hidden || !days || !layers || !timeline || timeline.hidden || FindView(view, @"forecast.back")) return NO;
    CGFloat mapBottom = right ? MAX(NSMaxY(map.frame), NSMaxY(right.frame)) : NSMaxY(map.frame);
    if (legend) {
        if (NSIntersectsRect(legend.frame, layers.frame)) return NO;
        for (NSView *label in legend.subviews)
            if (!NSContainsRect(legend.bounds, label.frame)) return NO;
    }
    BOOL fits = NSMaxY(days.frame) <= NSMinY(timeline.frame) + 1 &&
        NSMaxY(timeline.frame) <= NSMinY(map.frame) + 1 &&
        mapBottom <= NSMinY(layers.frame) + 1;
    if (!fits) fprintf(stderr, "layout map %.1f timeline %.1f lens %.1f\\n",
        mapBottom, NSMinY(timeline.frame), NSMinY(layers.frame));
    return fits;
}

static BOOL DetailFollowsMaps(NSView *view, NSString *identifier) {
    NSView *map = FindView(view, @"popover.chart");
    NSView *detail = FindView(view, identifier);
    NSView *inspector = FindView(view, @"forecast.inspector");
    NSView *lens = FindView(view, @"popover.lensRow");
    NSView *timeline = FindView(view, @"popover.timeline");
    if (!detail || !map || map.hidden || !inspector || !lens || !timeline || timeline.hidden || FindView(view, @"forecast.back")) return NO;
    NSRect mapRect = [map convertRect:map.bounds toView:view];
    NSRect inspectorRect = [inspector convertRect:inspector.bounds toView:view];
    NSRect detailRect = [detail convertRect:detail.bounds toView:view];
    NSRect timelineRect = [timeline convertRect:timeline.bounds toView:view];
    NSRect lensRect = [lens convertRect:lens.bounds toView:view];
    if (!NSContainsRect(NSInsetRect(view.bounds, -1, -1), inspectorRect) ||
        !NSContainsRect(NSInsetRect(inspectorRect, -1, -1), detailRect)) return NO;
    if (NSMaxY(timelineRect) > NSMinY(mapRect) + 1 || NSMaxY(lensRect) + 20 < NSHeight(view.bounds)) return NO;
    BOOL beside = NSMinX(inspectorRect) + 1 >= NSMaxX(mapRect) && !NSIntersectsRect(inspectorRect, mapRect);
    if (beside) return NSMinX(inspectorRect) >= NSMaxX(mapRect) + 9;
    NSRect overlap = NSIntersectionRect(inspectorRect, mapRect);
    return !NSIsEmptyRect(overlap) && NSHeight(overlap) <= NSHeight(mapRect) * 0.55 + 1;
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

static NSUserDefaults *HubDefaults;
@interface HubDefaultsController : TestController
@end
@implementation HubDefaultsController
- (NSUserDefaults *)chartPreferences { return HubDefaults; }
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

static NSUInteger BlueInk(NSView *view) {
    [view display];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    if (!rep) return 0;
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSUInteger count = 0;
    for (NSInteger y = 0; y < (NSInteger)rep.pixelsHigh; y++) {
        for (NSInteger x = 0; x < (NSInteger)rep.pixelsWide; x++) {
            NSColor *color = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (color && color.blueComponent > .45 && color.blueComponent > color.redComponent + .2 &&
                color.blueComponent > color.greenComponent + .15) count++;
        }
    }
    return count;
}

static void Pump(NSTimeInterval seconds) {
    NSDate *until=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow>0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}

// Speed ceilings (CPU, time-to-first-frame, frame milliseconds) are reports.
// ISOBAR_CI_SLOW=1 keeps the measurement and drops only the hard limit.
static BOOL IsobarCISlow(void) {
    const char *value = getenv("ISOBAR_CI_SLOW");
    return value && value[0] && !(value[0] == '0' && value[1] == '\0');
}

static const NSTimeInterval kLiveRenderCeiling = 30;

static BOOL WaitUntil(BOOL (^ready)(void), NSTimeInterval ceiling) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:ceiling];
    while (deadline.timeIntervalSinceNow > 0) {
        if (ready()) return YES;
        Pump(0.01);
    }
    return ready();
}

static BOOL SettlePlayer(IsobarLivePlayer *player) {
    return WaitUntil(^BOOL { return player.rendersInFlight == 0; }, kLiveRenderCeiling);
}

// One display step, then the frames that step asked for. The playhead moves
// by kIsobarLiveDisplayTick, not by how long the render took.
static void TickPlayer(IsobarLivePlayer *player, NSUInteger ticks) {
    if (!player.clock.manual) player.clock = [IsobarLiveClock manualClock];
    for (NSUInteger i = 0; i < ticks; i++) {
        [player.clock advance:kIsobarLiveDisplayTick];
        [player tick:kIsobarLiveDisplayTick];
        SettlePlayer(player);
    }
}

static BOOL SettleController(TestController *c) {
    return WaitUntil(^BOOL {
        IsobarLivePlayer *live = [c valueForKey:@"live"];
        return live.rendersInFlight == 0;
    }, kLiveRenderCeiling);
}

static BOOL SameDate(NSDate *a, NSDate *b) {
    return a && b && fabs([a timeIntervalSinceDate:b]) < .001;
}

static NSEvent *TimelineEvent(TimelineStrip *timeline, CGFloat fraction, NSEventType type, NSUInteger number) {
    NSRect track=[timeline trackRect];
    CGFloat x=timeline.bandDates.count ? [timeline cursorXForFraction:fraction]
        : NSMinX(track)+NSWidth(track)*fraction;
    NSPoint point=[timeline convertPoint:NSMakePoint(x,8) toView:nil];
    NSEventType constructed=type==NSEventTypeMouseExited?NSEventTypeMouseMoved:type;
    return [NSEvent mouseEventWithType:constructed location:point modifierFlags:0
        timestamp:NSDate.timeIntervalSinceReferenceDate windowNumber:timeline.window.windowNumber
        context:nil eventNumber:number clickCount:0 pressure:0];
}

@interface ShownPlaybackPopover : NSPopover
@end
@implementation ShownPlaybackPopover
- (BOOL)isShown { return YES; }
@end

@interface HiddenMapWindow : FullscreenWindow
@property BOOL forceHidden;
@property BOOL forceOccluded;
@end
@implementation HiddenMapWindow
- (BOOL)isVisible { return !self.forceHidden; }
- (NSWindowOcclusionState)occlusionState {
    return self.forceOccluded ? 0 : NSWindowOcclusionStateVisible;
}
- (NSScreen *)screen { return NSScreen.mainScreen; }
@end

static NSUserDefaults *PlaybackSuite;
@interface PlaybackPrefsController : TestController
@end
@implementation PlaybackPrefsController
- (NSUserDefaults *)chartPreferences { return PlaybackSuite; }
@end

static uint64_t DigestImage(NSImage *image) {
    if (!image || image.size.width < 2 || image.size.height < 2) return 0;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
    if (!rep || rep.pixelsWide < 2) return 0;
    uint64_t value = 1469598103934665603ULL;
    for (NSInteger y = 0; y < (NSInteger)rep.pixelsHigh; y += 8) {
        for (NSInteger x = 0; x < (NSInteger)rep.pixelsWide; x += 8) {
            NSColor *color = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
            value ^= (uint64_t)(color.redComponent * 255) & 255; value *= 1099511628211ULL;
            value ^= (uint64_t)(color.greenComponent * 255) & 255; value *= 1099511628211ULL;
            value ^= (uint64_t)(color.blueComponent * 255) & 255; value *= 1099511628211ULL;
        }
    }
    return value;
}

static void SavePlaybackFrame(NSImage *image, NSString *name) {
    if (!image) return;
    NSString *directory = @"build/render-review/playback";
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES];
}

static double CpuSeconds(struct rusage usage) {
    return usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6 +
        usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
}

static BOOL LockIntendedFrameSpacing(IsobarLivePlayer *player);

// CPU to perform `ticks` display steps, as the share of one core those steps
// would use at the real display cadence. Waiting out a busy machine is not
// part of the share: the clock advances by one display tick per step.
static double AmbientCorePercent(NSUInteger ticks, void (^step)(void)) {
    struct rusage beforeUsage, afterUsage;
    getrusage(RUSAGE_SELF, &beforeUsage);
    for (NSUInteger i = 0; i < ticks; i++) step();
    getrusage(RUSAGE_SELF, &afterUsage);
    double realSeconds = (double)ticks * kIsobarLiveDisplayTick;
    return (CpuSeconds(afterUsage) - CpuSeconds(beforeUsage)) / MAX(realSeconds, 0.001) * 100.0;
}

// One window can include a spacing rebuild or a quiet stretch, and on a shared
// machine one window can also absorb contention. The mean over all three
// fixed-work windows (total CPU / total ticks) is the steady cost: a frame that
// does three times the work triples it, while one noisy window is diluted
// rather than decisive.
static double MeanAmbientCorePercent(NSUInteger ticks, void (^step)(void)) {
    double total = 0;
    for (int window = 0; window < 3; window++) {
        double sample = AmbientCorePercent(ticks, step);
        fprintf(stderr, "  work window %d: %.2f%% over %lu ticks\n", window + 1, sample, (unsigned long)ticks);
        total += sample;
    }
    return total / 3.0;
}

static BOOL InkPixel(const uint8_t *p) {
    if (p[3] < 200) return NO;
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 0.35 * 255.0;
}

static int CountInk(const uint8_t *bytes, int w, int h) {
    int count = 0;
    for (int i = 0; i < w * h; i++) if (InkPixel(bytes + i * 4)) count++;
    return count;
}

static uint8_t *CopyRGBA(NSImage *image, int *wOut, int *hOut) {
    CGImageRef cg = LiveCGImage(image);
    if (!cg) return NULL;
    int w = (int)CGImageGetWidth(cg), h = (int)CGImageGetHeight(cg);
    if (w < 32 || h < 32 || (w % 2) || (h % 2)) return NULL;
    uint8_t *bytes = calloc((size_t)w * h, 4);
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(bytes, w, h, 8, w * 4, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(cs);
    if (!ctx) { free(bytes); return NULL; }
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), cg);
    CGContextRelease(ctx);
    *wOut = w;
    *hOut = h;
    return bytes;
}

static double PercentileBin(const int *hist, int bins, int samples, double pct) {
    if (samples < 1) return 0;
    int need = (int)ceil(samples * pct);
    int seen = 0;
    for (int bin = 0; bin <= bins; bin++) {
        seen += hist[bin];
        // The histogram spans four chart pixels.
        if (seen >= need) return MIN(4, (bin + 0.5) * 4.0 / bins);
    }
    return 4;
}

// Motion of the thin isobar stroke. Filled glyphs are labels. Ink with no
// neighbour within 4px has appeared or vanished; it is not a glide.
static void IsobarMotion(const uint8_t *a, const uint8_t *b, int w, int h,
    double *p95, double *p99, double *unmatched) {
    *p95 = 0;
    *p99 = 0;
    *unmatched = 0;
    if (!memcmp(a, b, (size_t)w * h * 4)) return;
    enum { bins = 40 };
    int hist[bins + 1] = {0};
    int matched = 0, lost = 0;
    // Four chart pixels. At scale 1 that is the historical 4px window.
    double chart = 580.0 / w;
    double window = 4.0 / chart;
    if (window < 4) window = 4;
    int rad = (int)ceil(window);
    for (int y = 1; y < h - 1; y += 2) {
        for (int x = 1; x < w - 1; x += 2) {
            if (!InkPixel(a + ((size_t)y * w + x) * 4)) continue;
            int dark = 0;
            for (int dy = -1; dy <= 1; dy++)
                for (int dx = -1; dx <= 1; dx++)
                    if (InkPixel(a + ((size_t)(y + dy) * w + (x + dx)) * 4)) dark++;
            if (dark >= 8) continue;
            double best = window;
            for (int dy = -rad; dy <= rad; dy++) {
                int yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (int dx = -rad; dx <= rad; dx++) {
                    int xx = x + dx;
                    if (xx < 0 || xx >= w || !InkPixel(b + ((size_t)yy * w + xx) * 4)) continue;
                    double dist = hypot(dx, dy);
                    if (dist < best) best = dist;
                }
            }
            if (best >= window) { lost++; continue; }
            hist[(int)(best / window * bins)]++;
            matched++;
        }
    }
    int samples = matched + lost;
    *unmatched = samples ? (double)lost / samples : 0;
    *p95 = PercentileBin(hist, bins, matched, 0.95);
    *p99 = PercentileBin(hist, bins, matched, 0.99);
}

static double MaxGlide(NSArray<NSValue *> *before, NSArray<NSValue *> *after) {
    if (!before.count || !after.count) return 0;
    double worst = 0;
    for (NSValue *value in after) {
        NSPoint point = value.pointValue;
        double nearest = 1e9;
        for (NSValue *other in before) {
            NSPoint previous = other.pointValue;
            nearest = MIN(nearest, hypot(point.x - previous.x, point.y - previous.y));
        }
        if (nearest <= 8) worst = MAX(worst, nearest);
    }
    return worst;
}

static BOOL WritePlaybackMovie(NSArray<NSImage *> *frames, NSString *path) {
    NSImage *first = frames.firstObject;
    CGImageRef sample = first ? LiveCGImage(first) : NULL;
    if (!sample) return NO;
    int width = (int)CGImageGetWidth(sample), height = (int)CGImageGetHeight(sample);
    if (width < 32 || height < 32) return NO;
    NSURL *url = [NSURL fileURLWithPath:path];
    [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager removeItemAtURL:url error:nil];
    NSError *failure = nil;
    // A .mov is written as ProRes 4444 for measurement: H.264 keyframes
    // re-encode the whole picture once a second and read as jumps.
    BOOL lossless = [path.pathExtension isEqualToString:@"mov"];
    AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:url
        fileType:lossless ? AVFileTypeQuickTimeMovie : AVFileTypeMPEG4 error:&failure];
    NSDictionary *settings = lossless ? @{
        AVVideoCodecKey: AVVideoCodecTypeAppleProRes4444,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
    } : @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @2500000,
            AVVideoExpectedSourceFrameRateKey: @30,
            AVVideoMaxKeyFrameIntervalKey: @30,
            AVVideoAllowFrameReorderingKey: @NO,
        },
    };
    AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    input.expectsMediaDataInRealTime = NO;
    AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor
        assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input sourcePixelBufferAttributes:@{
            (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
            (NSString *)kCVPixelBufferWidthKey: @(width),
            (NSString *)kCVPixelBufferHeightKey: @(height),
        }];
    if (!writer || ![writer canAddInput:input]) return NO;
    [writer addInput:input];
    if (![writer startWriting]) return NO;
    [writer startSessionAtSourceTime:kCMTimeZero];
    BOOL okay = YES;
    for (NSInteger i = 0; i < (NSInteger)frames.count && okay; i++) {
        CGImageRef cg = LiveCGImage(frames[i]);
        NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 10;
        while (!input.readyForMoreMediaData && writer.status == AVAssetWriterStatusWriting &&
            NSProcessInfo.processInfo.systemUptime < deadline) usleep(2000);
        CVPixelBufferRef buffer = NULL;
        if (!cg || !input.readyForMoreMediaData ||
            CVPixelBufferPoolCreatePixelBuffer(NULL, adaptor.pixelBufferPool, &buffer) != kCVReturnSuccess) {
            okay = NO;
            break;
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
        if (okay && ![adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMake(i, 30)]) okay = NO;
        CVPixelBufferRelease(buffer);
    }
    if (okay) {
        [input markAsFinished];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC))) okay = NO;
        else okay = writer.status == AVAssetWriterStatusCompleted;
    }
    if (!okay) [writer cancelWriting];
    return okay;
}

// One ProRes frame at a time, so a two-loop 256x recording does not retain
// every bitmap. Same codec as WritePlaybackMovie: H.264 keyframes read as jumps.
@interface SeamMovie : NSObject
- (BOOL)openPath:(NSString *)path image:(NSImage *)first;
- (BOOL)add:(NSImage *)image;
- (BOOL)close;
@property (nonatomic, readonly) NSInteger frames;
@end
@implementation SeamMovie {
    AVAssetWriter *_writer;
    AVAssetWriterInput *_input;
    AVAssetWriterInputPixelBufferAdaptor *_adaptor;
    int _width, _height;
    NSInteger _frames;
}
- (BOOL)openPath:(NSString *)path image:(NSImage *)first {
    CGImageRef sample = LiveCGImage(first);
    if (!sample) return NO;
    _width = (int)CGImageGetWidth(sample);
    _height = (int)CGImageGetHeight(sample);
    if (_width < 32 || _height < 32) return NO;
    NSURL *url = [NSURL fileURLWithPath:path];
    [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager removeItemAtURL:url error:nil];
    NSError *failure = nil;
    _writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeQuickTimeMovie error:&failure];
    _input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
        AVVideoCodecKey: AVVideoCodecTypeAppleProRes4444,
        AVVideoWidthKey: @(_width),
        AVVideoHeightKey: @(_height),
    }];
    _input.expectsMediaDataInRealTime = NO;
    _adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:_input
        sourcePixelBufferAttributes:@{
            (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
            (NSString *)kCVPixelBufferWidthKey: @(_width),
            (NSString *)kCVPixelBufferHeightKey: @(_height),
        }];
    if (!_writer || ![_writer canAddInput:_input]) return NO;
    [_writer addInput:_input];
    if (![_writer startWriting]) return NO;
    [_writer startSessionAtSourceTime:kCMTimeZero];
    return [self add:first];
}
- (BOOL)add:(NSImage *)image {
    CGImageRef cg = LiveCGImage(image);
    if (!cg || (int)CGImageGetWidth(cg) != _width || (int)CGImageGetHeight(cg) != _height) return NO;
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 10;
    while (!_input.readyForMoreMediaData && _writer.status == AVAssetWriterStatusWriting &&
        NSProcessInfo.processInfo.systemUptime < deadline) usleep(2000);
    CVPixelBufferRef buffer = NULL;
    if (!_input.readyForMoreMediaData ||
        CVPixelBufferPoolCreatePixelBuffer(NULL, _adaptor.pixelBufferPool, &buffer) != kCVReturnSuccess) return NO;
    CVPixelBufferLockBaseAddress(buffer, 0);
    CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(buffer), _width, _height,
        8, CVPixelBufferGetBytesPerRow(buffer), colors, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
    CGColorSpaceRelease(colors);
    BOOL drew = context != NULL;
    if (drew) {
        CGContextDrawImage(context, CGRectMake(0, 0, _width, _height), cg);
        CGContextRelease(context);
    }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    BOOL appended = drew && [_adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMake(_frames, 30)];
    CVPixelBufferRelease(buffer);
    if (!appended) return NO;
    _frames++;
    return YES;
}
- (BOOL)close {
    if (!_writer) return NO;
    [_input markAsFinished];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [_writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
    BOOL finished = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC)) == 0
        && _writer.status == AVAssetWriterStatusCompleted;
    if (!finished) [_writer cancelWriting];
    return finished;
}
- (NSInteger)frames { return _frames; }
@end

static void CheckSmoothPlayback(TestController *c) {
    OwnRun *run = [c valueForKey:@"ownRun"];
    NSArray *times = [c valueForKey:@"sequenceTimes"];
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    player.pixelSize = NSMakeSize(580, 444);
    player.scale = 1;
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed8x);
    OwnLayerOptions layers = {0};
    layers.bare = 1;
    player.layers = layers;
    [player configureRun:run start:times.firstObject end:times.lastObject now:[c valueForKey:@"chartNow"]
        modelIndex:^double(NSDate *date) { return [c liveModelIndexForDate:date]; }];
    player.clock = [IsobarLiveClock manualClock];
    [player playFromDate:[c valueForKey:@"chartNow"]];
    NSDate *warm = [NSDate dateWithTimeIntervalSinceNow:kLiveRenderCeiling];
    while (warm.timeIntervalSinceNow > 0 && player.completedRenders < 2) {
        TickPlayer(player, 1);
    }
    Check(player.completedRenders >= 2, @"playback renders the frames a tick asks for");
    NSDate *origin = player.playhead;
    NSMutableArray<NSImage *> *shown = [NSMutableArray array];
    double maxMove = 0, maxTail = 0, maxLost = 0, maxLabel = 0, maxCentre = 0, maxInk = 0;
    NSArray *labels = player.labelPositions, *centres = player.centrePositions;
    uint8_t *previous = NULL;
    int width = 0, height = 0;
    int compared = 0;
    for (NSInteger i = 0; i < 300; i++) {
        TickPlayer(player, 1);
        NSImage *image = player.displayedImage;
        if (!image) continue;
        if (shown.count < 300) [shown addObject:image];
        int w = 0, h = 0;
        uint8_t *bytes = CopyRGBA(image, &w, &h);
        if (!bytes) continue;
        if (previous && w == width && h == height) {
            double p95 = 0, p99 = 0, lost = 0;
            IsobarMotion(previous, bytes, w, h, &p95, &p99, &lost);
            maxMove = MAX(maxMove, p95);
            maxTail = MAX(maxTail, p99);
            maxLost = MAX(maxLost, lost);
            compared++;
            if (p95 > 0.01 || p99 > 0.01) {
                OwnMotionState *once = [OwnMotionState new];
                once.immediateAnnotations = YES;
                NSImage *single = OwnRunRenderMotion(run, [c liveModelIndexForDate:player.playhead], @"", layers, nil, 1, once);
                int sw = 0, sh = 0;
                uint8_t *solo = single ? CopyRGBA(single, &sw, &sh) : NULL;
                if (solo && sw == w && sh == h) {
                    int shownInk = CountInk(bytes, w, h), oneInk = CountInk(solo, sw, sh);
                    if (oneInk > 0) maxInk = MAX(maxInk, (double)shownInk / oneInk);
                }
                free(solo);
            }
        }
        free(previous);
        previous = bytes;
        width = w;
        height = h;
        maxLabel = MAX(maxLabel, MaxGlide(labels, player.labelPositions));
        maxCentre = MAX(maxCentre, MaxGlide(centres, player.centrePositions));
        labels = player.labelPositions;
        centres = player.centrePositions;
    }
    free(previous);
    double elapsed = 300.0 / 30.0;
    double advanced = origin && player.playhead ? [player.playhead timeIntervalSinceDate:origin] / 3600.0 : 0;
    double expected = player.hoursPerSecond * elapsed;
    NSString *movie = @"build/render-review/final/playback.mp4";
    BOOL wrote = shown.count >= 300 && WritePlaybackMovie(shown, movie);
    fprintf(stderr, "smooth move %.2fpx tail %.2fpx lost %.1f%% label %.2fpx centre %.2fpx ink %.2f advance %.2fh expected %.2fh frames %lu\n",
        maxMove, maxTail, maxLost * 100, maxLabel, maxCentre, maxInk, advanced, expected, (unsigned long)shown.count);
    Check(compared > 20 && maxMove <= 1.5 && maxTail <= 1.5 && maxLost < .05,
        @"isobars move at most 1.5px between displayed frames");
    Check(maxInk > 0 && maxInk <= 1.25, @"displayed frames are single isobar renders");
    double worstInset = -INFINITY;
    for (double index = 0; index < run.hours - 1; index += 0.37) { @autoreleasepool {
        OwnRunRenderFraction(run, index, @"", layers, nil, 1);
        worstInset = fmax(worstInset, OwnRenderLastOpenInset());
    } }
    Check(worstInset <= 2, [NSString stringWithFormat:@"open isobars end at the map edge or where the data stops (%.1f pt)", worstInset]);
    Check(maxLabel <= 0.5 && maxCentre <= 0.5, @"labels and centres stay still on screen during play");
    Check(advanced > expected * 0.8 && advanced < expected * 1.2, @"the playhead advances at the slow rate");
    Check(wrote && [[NSFileManager.defaultManager attributesOfItemAtPath:movie error:nil] fileSize] > 1000,
        @"a 10s playback review was written");
    [player stopRendering];
}

static double LuminanceAt(NSView *view, NSInteger x, NSInteger y) {
    [view layoutSubtreeIfNeeded];
    [view display];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    if (!rep) return 1;
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSInteger px = MIN(MAX(0, x), (NSInteger)rep.pixelsWide - 1);
    NSInteger py = MIN(MAX(0, (NSInteger)rep.pixelsHigh - 1 - y), (NSInteger)rep.pixelsHigh - 1);
    NSColor *color = [[rep colorAtX:px y:py] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    if (!color) return 1;
    return 0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent;
}


// What the viewer sees: the map view's composited layer tree, including the
// two live frame layers and their blend, at 1x.
static NSImage *SnapshotDisplayedMap(NSView *view) {
    if (!view || NSIsEmptyRect(view.bounds)) return nil;
    [view displayIfNeeded];
    NSInteger w = (NSInteger)ceil(view.bounds.size.width), h = (NSInteger)ceil(view.bounds.size.height);
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(NULL, (size_t)w, (size_t)h, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!ctx) return nil;
    CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
    CGContextFillRect(ctx, CGRectMake(0, 0, w, h));
    if (view.layer) [view.layer renderInContext:ctx];
    CGImageRef cg = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!cg) return nil;
    NSImage *image = [[NSImage alloc] initWithCGImage:cg size:NSMakeSize(w, h)];
    CGImageRelease(cg);
    return image;
}

// Scope only this process's accessibility getter, preserving an outer test's
// override as well as the real host preference, including on an exception.
static void WithTestReduceMotion(BOOL reduceMotion, void (^body)(void)) {
    BOOL hadOverride = IsobarTestReduceMotionOverrideActive;
    BOOL previousValue = IsobarTestReduceMotionValue;
    IsobarTestSetReduceMotion(reduceMotion);
    @try {
        body();
    } @finally {
        if (hadOverride) IsobarTestSetReduceMotion(previousValue);
        else IsobarTestRestoreReduceMotion();
    }
}

static BOOL LockIntendedFrameSpacing(IsobarLivePlayer *player);

// On-screen smoothness: drive a real popover open with no input, record the
// displayed map for ten seconds of ambient play, then a hover sweep, and
// write both as movies for tools/measure-jank.py (run by tests.sh). Set
// ISOBAR_QA_STORE to score a real archive instead of the fixture.
static void RecordDisplayedPlayback(TestController *c, NSString *root) {
    WithTestReduceMotion(NO, ^{
    const char *qa = getenv("ISOBAR_QA_STORE");
    if (qa && qa[0]) [c reloadStoreAtPath:[NSString stringWithUTF8String:qa]];
    NSString *dir = getenv("ISOBAR_QA_DIR") ? [NSString stringWithUTF8String:getenv("ISOBAR_QA_DIR")] : @"build/qa";
    [c useManualLiveClock];
    NSPopover *original = c.popover;
    ShownPlaybackPopover *shown = [ShownPlaybackPopover new];
    shown.contentViewController = original.contentViewController;
    c.popover = shown;
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    [c popoverDidShow:[NSNotification notificationWithName:NSPopoverDidShowNotification object:shown]];
    __block IsobarLivePlayer *live = [c valueForKey:@"live"];
    WaitUntil(^BOOL { return live.baseImage != nil && live.rendersInFlight == 0; }, kLiveRenderCeiling);
    Check([[c valueForKey:@"timelinePlaying"] boolValue], @"opening the popover starts ambient play with no input");
    NSMutableArray<NSImage *> *frames = [NSMutableArray array];
    for (NSInteger i = 0; i < 300; i++) { @autoreleasepool {
        [c advanceLiveTicks:1];
        WaitUntil(^BOOL { return live.rendersInFlight == 0; }, kLiveRenderCeiling);
        SettleController(c);
        NSImage *frame = SnapshotDisplayedMap([c timelineChart]);
        if (frame) [frames addObject:frame];
        if (getenv("ISOBAR_QA_TRACE")) {
            NSImage *b = live.baseImage, *n = live.nextImage;
                        fprintf(stderr, "qa tick %ld playhead %.1f base %p %.0fx%.0f next %p op %.3f spacing %.0f renders %lu playing %d hold %d seam %d\n",
                (long)i, live.playhead.timeIntervalSinceReferenceDate, (__bridge void *)b, b.size.width, b.size.height,
                (__bridge void *)n, live.nextOpacity, live.frameSpacing, (unsigned long)live.completedRenders,
                live.playing, live.holding, live.seaming);
        }
    }}
    Check(frames.count == 300 && WritePlaybackMovie(frames, [dir stringByAppendingPathComponent:@"autoplay.mov"]),
        @"ten seconds of displayed autoplay are recorded for the jank score");
    [frames removeAllObjects];
    for (NSInteger i = 0; i < 120; i++) { @autoreleasepool {
        [c previewPopoverMovieFraction:.30 + .10 * i / 119.0];
        WaitUntil(^BOOL { return [[c valueForKey:@"scrubRenderer"] renderCount] > 0; }, 2);
        SettleController(c);
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:1.0/30.0]];
        NSImage *frame = SnapshotDisplayedMap([c timelineChart]);
        if (frame) [frames addObject:frame];
    }}
    [c previewPopoverMovieFraction:NAN];
    NSDate *sweepStart = [(id)c dateForMotionFraction:.30], *sweepEnd = [(id)c dateForMotionFraction:.40];
    double sweepHours = sweepStart && sweepEnd ? [sweepEnd timeIntervalSinceDate:sweepStart] / 3600.0 : 0;
    [[NSString stringWithFormat:@"%.3f\n", sweepHours] writeToFile:[dir stringByAppendingPathComponent:@"hover.hours"]
        atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    Check(frames.count == 120 && WritePlaybackMovie(frames, [dir stringByAppendingPathComponent:@"hover.mov"]),
        @"a displayed hover sweep is recorded for the jank score");
    [frames removeAllObjects];
    live = [c valueForKey:@"live"];
    NSInteger savedSpeed = [[c valueForKey:@"liveSpeed"] integerValue];
    [c setValue:@(IsobarLiveSpeed256x) forKey:@"liveSpeed"];
    live.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed256x);
    Check(LockIntendedFrameSpacing(live), @"256x autoplay uses the prompt frame spacing");
    [c startLivePlaybackFromDate:[c valueForKey:@"chartNow"]];
    live = [c valueForKey:@"live"];
    Check(fabs(live.hoursPerSecond - IsobarLiveHoursPerSecond(IsobarLiveSpeed256x)) < 1e-9,
        @"256x autoplay keeps the fast rate");
    WaitUntil(^BOOL { return live.baseImage != nil && live.rendersInFlight == 0; }, kLiveRenderCeiling);
    NSArray *loopTimes = [c valueForKey:@"sequenceTimes"];
    double spanHours = loopTimes.count >= 2
        ? [loopTimes.lastObject timeIntervalSinceDate:loopTimes.firstObject] / 3600.0 : 0;
    double loopSeconds = (spanHours > 0 && live.hoursPerSecond > 0)
        ? spanHours / live.hoursPerSecond + kIsobarLiveSeamDuration + 1 : 30;
    NSInteger loopCap = (NSInteger)ceil(3 * loopSeconds / kIsobarLiveDisplayTick);
    SeamMovie *fast = [SeamMovie new];
    NSImage *firstFast = SnapshotDisplayedMap([c timelineChart]);
    BOOL fastOpen = firstFast && [fast openPath:[dir stringByAppendingPathComponent:@"fastplay.mov"] image:firstFast];
    double previousHours = [live forecastHoursAtTime:[live clockNow]];
    int fastSeams = 0, fastDrops = 0;
    BOOL fastForward = YES, wasSeaming = live.seaming;
    NSMutableString *seamLog = [NSMutableString string];
    for (NSInteger i = 0; fastOpen && fastSeams < 2 && i < loopCap; i++) { @autoreleasepool {
        [c advanceLiveTicks:1];
        WaitUntil(^BOOL { return live.rendersInFlight == 0; }, kLiveRenderCeiling);
        SettleController(c);
        if (live.playheadRate < -1e-9) fastForward = NO;
        double hours = [live forecastHoursAtTime:[live clockNow]];
        if (hours + 0.02 < previousHours) fastDrops++;
        else if (hours + 1e-3 < previousHours) fastForward = NO;
        previousHours = hours;
        // The frame about to be appended is timestamped at the current count.
        if (live.seaming && !wasSeaming)
            [seamLog appendFormat:@"%.3f,%.3f\n", fast.frames / 30.0, kIsobarLiveSeamDuration];
        if (live.seaming) wasSeaming = YES;
        else if (wasSeaming) { wasSeaming = NO; fastSeams++; }
        NSImage *frame = SnapshotDisplayedMap([c timelineChart]);
        if (!frame || ![fast add:frame]) fastOpen = NO;
        if (i > 0 && i % 200 == 0)
            fprintf(stderr, "fastplay tick %ld seams %d hours %.2f\n", (long)i, fastSeams, hours);
    }}
    BOOL fastClosed = fastOpen && [fast close];
    [seamLog writeToFile:[dir stringByAppendingPathComponent:@"fastplay.seams"]
        atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    fprintf(stderr, "fastplay frames %ld seams %d drops %d span %.1fh\n",
        (long)fast.frames, fastSeams, fastDrops, spanHours);
    Check(fastClosed && fast.frames > 60 && fastSeams >= 2 && fastDrops == fastSeams && fastForward,
        @"256x autoplay spanning two loops dissolves back to now without playing backwards");
    [c setValue:@(savedSpeed) forKey:@"liveSpeed"];
    live.hoursPerSecond = IsobarLiveHoursPerSecond((IsobarLiveSpeed)savedSpeed);
    [c stopPopoverPlayback];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    c.popover = original;
    if (qa && qa[0]) [c reloadStoreAtPath:root];
    });
}

static void CheckDisplayedPlaybackUnderReduceMotion(TestController *c, NSString *root) {
    BOOL originalValue = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    WithTestReduceMotion(YES, ^{
        Check(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion,
            @"displayed playback regression starts with Reduce Motion enabled");
        BOOL caught = NO;
        @try {
            WithTestReduceMotion(NO, ^{
                @throw [NSException exceptionWithName:@"IsobarRecordingScopeProbe" reason:nil userInfo:nil];
            });
        } @catch (NSException *exception) {
            if (![exception.name isEqual:@"IsobarRecordingScopeProbe"]) @throw;
            caught = YES;
        }
        Check(caught && NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion,
            @"a failed recording scope restores the previous Reduce Motion override");
        RecordDisplayedPlayback(c, root);
        Check(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion,
            @"displayed playback restores the previous Reduce Motion override");
    });
    Check(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion == originalValue,
        @"displayed playback regression restores the original accessibility getter");
}

static void CheckLivePlayback(TestController *c, NSString *root, NSFileManager *fm) {
    Check(fabs(IsobarLiveHoursPerSecond(IsobarLiveSpeed1x) - 1.0/60) < 1e-9 &&
        fabs(IsobarLiveHoursPerSecond(IsobarLiveSpeed8x) - 8.0/60) < 1e-9 &&
        fabs(IsobarLiveHoursPerSecond(IsobarLiveSpeed64x) - 64.0/60) < 1e-9 &&
        fabs(kIsobarLiveFrameStep - 18) < 1e-9 &&
        fabs(kIsobarLiveSeamHold - 0.2) < 1e-9 &&
        fabs(kIsobarLiveSeamDissolve - 0.6) < 1e-9 &&
        fabs(kIsobarLiveSeamDuration - (kIsobarLiveSeamHold + kIsobarLiveSeamDissolve)) < 1e-9,
        @"playback multipliers are anchored at one forecast minute per second");
    Check(fabs(IsobarLiveFrameSpacing(0.003, 8.0/60) - 16) < 1e-6 &&
        fabs(IsobarLiveFrameSpacing(0.040, 8.0/60) - 24) < 1e-6 &&
        fabs(IsobarLiveFrameSpacing(0.010, 16.0/60) - 32) < 1e-6 &&
        fabs(IsobarLiveFrameSpacing(0.040, 1.0/60) - 6) < 1e-6,
        @"single-field playback renders at least 10/20/30 frames per second by speed");
    IsobarLiveClock *manual = [IsobarLiveClock manualClock];
    NSTimeInterval stayed = manual.now;
    [manual advance:kIsobarLiveDisplayTick];
    Check(manual.manual && fabs(manual.now - stayed - kIsobarLiveDisplayTick) < 1e-9,
        @"a manual clock advances only when the harness steps it");
    IsobarLiveClock *wall = [IsobarLiveClock wallClock];
    NSTimeInterval wallNow = wall.now;
    [wall advance:5];
    Check(!wall.manual && wallNow > 0 && fabs(wall.now - wallNow) < 1,
        @"the wall clock is process uptime and ignores harness steps");
    IsobarTestSetReduceMotion(NO);
    [c useManualLiveClock];
    NSPopover *original = c.popover;
    ShownPlaybackPopover *shown = [ShownPlaybackPopover new];
    shown.contentViewController = original.contentViewController;
    c.popover = shown;
    [c setValue:@NO forKey:@"forecastPaused"];
    [c stopPopoverPlayback];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    NSTimeInterval began = NSProcessInfo.processInfo.systemUptime;
    [c popoverDidShow:[NSNotification notificationWithName:NSPopoverDidShowNotification object:shown]];
    __block IsobarLivePlayer *live = [c valueForKey:@"live"];
    BOOL firstReady = WaitUntil(^BOOL { return live.baseImage != nil && live.rendersInFlight == 0; }, kLiveRenderCeiling);
    NSDate *origin = live.playhead;
    uint64_t firstDigest = DigestImage(live.baseImage);
    BOOL imageChanged = NO, timeAdvanced = NO;
    NSDate *advanceDeadline = [NSDate dateWithTimeIntervalSinceNow:kLiveRenderCeiling];
    while (advanceDeadline.timeIntervalSinceNow > 0 && !(imageChanged && timeAdvanced)) {
        [c advanceLiveTicks:1];
        SettleController(c);
        live = [c valueForKey:@"live"];
        uint64_t digest = DigestImage(live.baseImage);
        if (digest && firstDigest && digest != firstDigest) imageChanged = YES;
        if (origin && live.playhead && [live.playhead timeIntervalSinceDate:origin] >= 60) timeAdvanced = YES;
    }
    double firstAdvance = NSProcessInfo.processInfo.systemUptime - began;
    fprintf(stderr, "time-to-first-advance %.3fs\n", firstAdvance);
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && firstReady && imageChanged && timeAdvanced &&
        (IsobarCISlow() || firstAdvance <= 1.0),
        @"autoplay advances the map and the timeline within 1s of showing the popover");
    IsobarLivePlayer *sharpLive = [c valueForKey:@"live"];
    PDFCropView *sharpChart = [c valueForKey:@"leftChart"];
    CGImageRef sharpImage = LiveCGImage(sharpLive.baseImage);
    CGFloat expectPixels = sharpChart.bounds.size.width * [c backingScale];
    if (expectPixels > 580 * 4) expectPixels = 580 * 4;
    fprintf(stderr, "live pixels %zu view %.0f expected %.0f\n",
        sharpImage ? CGImageGetWidth(sharpImage) : 0, sharpChart.bounds.size.width, expectPixels);
    Check(sharpImage && CGImageGetWidth(sharpImage) + 1 >= expectPixels * 0.9,
        @"live frames use the view's pixel size");

    live = [c valueForKey:@"live"];
    NSUInteger ticks = live.displayTicks;
    [c advanceLiveTicks:30];
    SettleController(c);
    fprintf(stderr, "display ticks %lu\n", (unsigned long)(live.displayTicks - ticks));
    Check(live.displayTicks >= ticks + 30, @"ambient playback applies every display tick");

    NSDate *held = live.playhead;
    [c togglePopoverPlayback:nil];
    Check(![[c valueForKey:@"popoverPlaying"] boolValue] && [[c valueForKey:@"forecastPaused"] boolValue],
        @"pause is an explicit remembered stop");
    [c togglePopoverPlayback:nil];
    live = [c valueForKey:@"live"];
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && live.playhead &&
        fabs([live.playhead timeIntervalSinceDate:held]) < 5,
        @"play resumes from the paused time");

    [c previewPopoverMovieFraction:.55];
    Check(![[c valueForKey:@"popoverPlaying"] boolValue], @"scrubbing holds the playhead");
    [c previewPopoverMovieFraction:NAN];
    SettleController(c);
    live = [c valueForKey:@"live"];
    double progress = ((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress;
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && fabs(progress - .55) < .03,
        @"releasing a scrub resumes ambient play from that time");

    PDFCropView *chart = [c valueForKey:@"leftChart"];
    Check(chart.onClick == nil && chart.onHoldChanged != nil, @"map holds time without a click-to-Now action");
    if (chart.onHoldChanged) chart.onHoldChanged(YES);
    NSDate *heldOnMap = [c selectedForecastDate];
    [c advanceLiveTicks:60];
    Check(![c timelinePlaying] && SameDate(heldOnMap, [c selectedForecastDate]),
        @"holding the map freezes the shared clock");
    if (chart.onHoldChanged) chart.onHoldChanged(NO);
    Check([c timelinePlaying] && SameDate(heldOnMap, [c selectedForecastDate]),
        @"releasing the map resumes from the held time");
    [c togglePopoverPlayback:nil];
    if (chart.onHoldChanged) { chart.onHoldChanged(YES); chart.onHoldChanged(NO); }
    Check(![c timelinePlaying], @"holding a paused map does not start playback on release");
    __block NSUInteger holdStarts = 0, holdEnds = 0;
    void (^holdCallback)(BOOL) = chart.onHoldChanged;
    chart.onHoldChanged = ^(BOOL held) {
        if (held) holdStarts++; else holdEnds++;
        if (holdCallback) holdCallback(held);
    };
    FallbackGestureEvent *heldPointer = [FallbackGestureEvent new];
    [chart mouseDown:heldPointer];
    [chart viewWillMoveToWindow:nil];
    [chart viewWillMoveToWindow:nil];
    [chart mouseUp:heldPointer];
    Check(holdStarts == 1 && holdEnds == 1 && ![c timelinePlaying],
        @"view teardown releases a held pointer once and preserves a prior pause");
    chart.onHoldChanged = holdCallback;
    [c resetPopoverToNow];
    Check([[c valueForKey:@"liveSpeed"] integerValue] == IsobarLiveSpeedRealTime &&
        fabs(((IsobarLivePlayer *)[c valueForKey:@"live"]).hoursPerSecond - 1.0/3600.0)<1e-10,
        @"Now selects one second per second on the shared native clock");
    SettleController(c);
    double nowFraction = [c motionFractionForDate:[c valueForKey:@"chartNow"]];
    progress = ((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress;
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && fabs(progress - nowFraction) < .05,
        @"the explicit Now control returns playback to now");

    live = [c valueForKey:@"live"];
    uint64_t beforeLayer = DigestImage(live.baseImage);
    NSUInteger renderedBefore = live.completedRenders;
    [c selectChartLayer:2];
    WaitUntil(^BOOL {
        live = [c valueForKey:@"live"];
        return live.baseImage && DigestImage(live.baseImage) != beforeLayer && live.rendersInFlight == 0;
    }, kLiveRenderCeiling);
    live = [c valueForKey:@"live"];
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && live.baseImage &&
        DigestImage(live.baseImage) != beforeLayer && live.completedRenders > renderedBefore,
        @"a layer change keeps playing and the next frames include it");
    [c selectChartLayer:0];
    SettleController(c);

    NSString *latestPath = [root stringByAppendingPathComponent:@"ecmwf/latest.json"];
    NSData *savedLatest = [NSData dataWithContentsOfFile:latestPath];
    NSData *alternate = [NSJSONSerialization dataWithJSONObject:@{@"run": @"20260925T06Z", @"path": @"20260925T06Z"}
        options:0 error:nil];
    Check([alternate writeToFile:latestPath atomically:YES], @"point the disposable store at the earlier run");
    NSDate *runBefore = [c valueForKey:@"runDate"];
    [c reloadStoreAtPath:root];
    SettleController(c);
    NSDate *runAfter = [c valueForKey:@"runDate"];
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && runAfter && ![runAfter isEqual:runBefore],
        @"a new model run keeps playback going");
    Check([savedLatest writeToFile:latestPath atomically:YES], @"restore the disposable latest run");
    [c reloadStoreAtPath:root];
    SettleController(c);

    NSTimeInterval keyStamp = 0;
    ChartKeyAction pressed = ChartKeyActionFor(49, @" ", 0, NO, 0, &keyStamp);
    NSUInteger drops = 0;
    for (NSInteger i = 0; i < 8; i++)
        if (ChartKeyActionFor(49, @" ", 0, YES, 0, &keyStamp) == ChartKeyDrop) drops++;
    BOOL playingBeforeRepeat = [[c valueForKey:@"popoverPlaying"] boolValue];
    Check(pressed == ChartKeyPlay && drops == 8, @"a held Space key does not repeat Play");
    if (pressed == ChartKeyPlay) [c togglePopoverPlayback:nil];
    Check([[c valueForKey:@"popoverPlaying"] boolValue] != playingBeforeRepeat,
        @"one Space press changes playback once");
    if (![[c valueForKey:@"popoverPlaying"] boolValue]) [c togglePopoverPlayback:nil];

    NSArray *times = [c valueForKey:@"sequenceTimes"];
    NSDate *end = times.lastObject;
    [c startLivePlaybackFromDate:[end dateByAddingTimeInterval:-0.5 * 3600]];
    SettleController(c);
    double maxProgress = 0;
    BOOL sawSeam = NO;
    // The tick that opens the seam does not spend seam time. The hold and the
    // dissolve run on the following ticks, and the tick after that is now.
    NSUInteger seamTicks = (NSUInteger)ceil(kIsobarLiveSeamDuration / kIsobarLiveDisplayTick) + 1;
    NSDate *loopDeadline = [NSDate dateWithTimeIntervalSinceNow:60];
    while (loopDeadline.timeIntervalSinceNow > 0 && !sawSeam) {
        [c advanceLiveTicks:1];
        SettleController(c);
        live = [c valueForKey:@"live"];
        if (live.seaming) sawSeam = YES;
        maxProgress = MAX(maxProgress, ((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress);
    }
    if (sawSeam) {
        [c advanceLiveTicks:seamTicks];
        SettleController(c);
    }
    nowFraction = [c motionFractionForDate:[c valueForKey:@"chartNow"]];
    progress = ((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress;
    fprintf(stderr, "loop max progress %.3f landed %.3f now %.3f seam %d\n", maxProgress, progress, nowFraction, sawSeam);
    Check(maxProgress > 0.9 && fabs(progress - nowFraction) < 0.2 && sawSeam,
        @"playback loops from the end of the run back to now");

    [c useWallLiveClock];
    live = [c valueForKey:@"live"];
    live.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed8x);
    [c startLivePlaybackFromDate:[c valueForKey:@"chartNow"]];
    for (NSInteger i = 0; i < 5; i++) {
        Pump(0.4);
        SavePlaybackFrame(live.baseImage, [NSString stringWithFormat:@"frame-%02ld.png", (long)i]);
    }
    Pump(2);
    // Same 20s of forecast playback as the old wall window, stepped on the
    // manual clock. Finish spacing calibration and still-chart preparation
    // first, so the sample is steady playback at the prompt cadence.
    [c useManualLiveClock];
    live = [c valueForKey:@"live"];
    [c startLivePlaybackFromDate:[c valueForKey:@"chartNow"]];
    live.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed8x);
    LockIntendedFrameSpacing(live);
    NSOperationQueue *chartPreparation = [c valueForKey:@"chartPreparationQueue"];
    BOOL prepIdle = WaitUntil(^BOOL {
        return live.baseImage != nil && live.rendersInFlight == 0 &&
            (!chartPreparation || chartPreparation.operationCount == 0);
    }, kLiveRenderCeiling);
    for (int i = 0; i < 30; i++) {
        [c advanceLiveTicks:1];
        SettleController(c);
    }
    NSUInteger ambientTicks = (NSUInteger)llround(20.0 / kIsobarLiveDisplayTick / 3.0);
    NSUInteger rendersBefore = live.completedRenders;
    double cpuPercent = MeanAmbientCorePercent(ambientTicks, ^{
        [c advanceLiveTicks:1];
        SettleController(c);
    });
    fprintf(stderr, "ambient cpu %.2f%% of one core, spacing %.0fs, renders %lu, prep idle %d\n",
        cpuPercent, live.frameSpacing, (unsigned long)(live.completedRenders - rendersBefore), prepIdle);
    if (!IsobarCISlow()) Check(cpuPercent < 25.0, @"ambient playback stays under 25% of one core");
    else fprintf(stderr, "ambient cpu ceiling skipped (ISOBAR_CI_SLOW)\n");
    CheckSmoothPlayback(c);

    [c stopPopoverPlayback];
    OwnRun *run = [c valueForKey:@"ownRun"];
    IsobarLivePlayer *budget = [IsobarLivePlayer new];
    // Three protected frames, each charged for both pressure map and flat plate.
    budget.byteBudget = 6 * 1024 * 1024;
    budget.scale = 1;
    budget.hoursPerSecond = 40;
    OwnLayerOptions layers = {0};
    layers.bare = 1;
    budget.layers = layers;
    NSDate *start = times.firstObject;
    [budget configureRun:run start:start end:end now:[c valueForKey:@"chartNow"] modelIndex:^double(NSDate *date) {
        return [c liveModelIndexForDate:date];
    }];
    [budget playFromDate:start];
    NSDate *budgetDeadline = [NSDate dateWithTimeIntervalSinceNow:kLiveRenderCeiling];
    while (budgetDeadline.timeIntervalSinceNow > 0 && budget.completedRenders < 4) {
        TickPlayer(budget, 1);
    }
    fprintf(stderr, "cache bytes %lu budget %lu renders %lu\n",
        (unsigned long)budget.cacheBytes, (unsigned long)budget.byteBudget, (unsigned long)budget.completedRenders);
    Check(budget.completedRenders >= 4 && budget.cacheBytes <= budget.byteBudget,
        @"the frame cache stays inside its byte budget");
    [budget stopRendering];

    live = [c valueForKey:@"live"];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    NSUInteger completedAtClose = live.completedRenders;
    WaitUntil(^BOOL { return live.rendersInFlight == 0; }, kLiveRenderCeiling);
    Check(![[c valueForKey:@"popoverPlaying"] boolValue] && live.rendersInFlight == 0 &&
        live.completedRenders == completedAtClose &&
        [[live valueForKey:@"frames"] count] <= 1 && [[live valueForKey:@"framePlates"] count] <= 1 &&
        live.cacheBytes <= live.byteBudget,
        @"closing the popover stops rendering and releases the cache");

    [c setValue:@NO forKey:@"forecastPaused"];
    HiddenMapWindow *window = [[HiddenMapWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 600)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = [[ChartRoot alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)];
    [c setValue:window forKey:@"chartWindow"];
    [c presentChartWindowInFrame:NSMakeRect(0, 0, 800, 600)];
    Check(WaitUntil(^BOOL { return [[c valueForKey:@"looping"] boolValue]; }, kLiveRenderCeiling),
        @"a visible map is playing");
    window.forceHidden = YES;
    [c noteMapVisibility];
    WaitUntil(^BOOL {
        live = [c valueForKey:@"live"];
        return live.rendersInFlight == 0;
    }, kLiveRenderCeiling);
    live = [c valueForKey:@"live"];
    Check(![[c valueForKey:@"looping"] boolValue] && live.rendersInFlight == 0,
        @"hiding the window stops rendering");
    if (window.screen) {
        window.forceHidden = NO;
        [c setValue:@NO forKey:@"forecastPaused"];
        [c presentChartWindowInFrame:NSMakeRect(0, 0, 800, 600)];
        SettleController(c);
        window.forceOccluded = YES;
        [c noteMapVisibility];
        WaitUntil(^BOOL {
            IsobarLivePlayer *stopped = [c valueForKey:@"live"];
            return stopped.rendersInFlight == 0;
        }, kLiveRenderCeiling);
        Check(![[c valueForKey:@"looping"] boolValue], @"an occluded window stops rendering");
    }
    [c closeChartWindow];

    [c setValue:@YES forKey:@"forecastPaused"];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    [c popoverDidShow:[NSNotification notificationWithName:NSPopoverDidShowNotification object:shown]];
    {
        IsobarLivePlayer *reopened = [c valueForKey:@"live"];
        NSDate *now = [c valueForKey:@"chartNow"] ?: NSDate.date;
        double offset = reopened.playhead ? fabs([reopened.playhead timeIntervalSinceDate:now]) : INFINITY;
        Check(![[c valueForKey:@"forecastPaused"] boolValue] && [[c valueForKey:@"timelinePlaying"] boolValue] && offset < 600,
            @"reopening the map clears a pause and plays from now");
    }
    NSString *suite = [@"com.isobar.playback." stringByAppendingString:NSUUID.UUID.UUIDString];
    PlaybackSuite = [[NSUserDefaults alloc] initWithSuiteName:suite];
    [PlaybackSuite setBool:YES forKey:@"forecastPaused"];
    PlaybackPrefsController *remembered = [PlaybackPrefsController new];
    Check(![[remembered valueForKey:@"forecastPaused"] boolValue],
        @"a pause saved by an older build does not stop the next launch");
    [PlaybackSuite removePersistentDomainForName:suite];
    PlaybackSuite = nil;

    [c setValue:@NO forKey:@"forecastPaused"];
    [c stopPopoverPlayback];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    original.contentViewController = shown.contentViewController;
    c.popover = original;
    [c setValue:@0 forKey:@"tempLayer"];
    IsobarTestRestoreReduceMotion();
    (void)fm;
}

static NSEvent *TimelineEventAtY(TimelineStrip *timeline, CGFloat fraction, CGFloat y, NSEventType type, NSUInteger number) {
    NSRect track=[timeline trackRect];
    NSPoint point=[timeline convertPoint:NSMakePoint(NSMinX(track)+NSWidth(track)*fraction,y) toView:nil];
    NSEventType constructed=type==NSEventTypeMouseExited?NSEventTypeMouseMoved:type;
    return [NSEvent mouseEventWithType:constructed location:point modifierFlags:0
        timestamp:NSDate.timeIntervalSinceReferenceDate windowNumber:timeline.window.windowNumber
        context:nil eventNumber:number clickCount:0 pressure:0];
}

// One display tick of the tighter Australia frame changes about 0.003 of the
// map: the same geographic glide covers more pixels. A reload that only
// continues that glide is not a jump. A new run's reset still counts as a
// jump past 0.01.
static const double kGlidePixelShare = 0.004;

static double FractionChanged(NSImage *a, NSImage *b) {
    int aw = 0, ah = 0, bw = 0, bh = 0;
    uint8_t *left = CopyRGBA(a, &aw, &ah);
    uint8_t *right = CopyRGBA(b, &bw, &bh);
    if (!left || !right || aw != bw || ah != bh || aw < 2) { free(left); free(right); return 1; }
    int changed = 0;
    int n = aw * ah;
    for (int i = 0; i < n; i++) {
        const uint8_t *p = left + i * 4, *q = right + i * 4;
        if (abs(p[0] - q[0]) + abs(p[1] - q[1]) + abs(p[2] - q[2]) > 24) changed++;
    }
    free(left);
    free(right);
    return n ? (double)changed / n : 1;
}

static double ModelIndex(OwnRun *run, NSDate *date) {
    if (!run || run.hours < 1 || !date) return 0;
    if (run.hours == 1) return 0;
    for (NSInteger i = 1; i < run.hours; i++) {
        NSDate *end = [run timeAtIndex:i];
        NSDate *start = [run timeAtIndex:i - 1];
        if (!end || !start) continue;
        if ([date compare:end] != NSOrderedDescending) {
            NSTimeInterval span = [end timeIntervalSinceDate:start];
            double fraction = span > 0 ? MIN(1, MAX(0, [date timeIntervalSinceDate:start] / span)) : 0;
            return (i - 1) + fraction;
        }
    }
    return run.hours - 1;
}

// Real-resolution chart window. Backing scale 2 at the popover's point size.
static void CheckQuarterDegree(NSString *fixtures) {
    NSString *directory = [fixtures stringByAppendingPathComponent:@"grid025"];
    NSString *coast = [NSString stringWithUTF8String:getenv("ISOBAR_COAST") ?: "Resources/ownchart-coast.bin"];
    NSString *error = nil;
    OwnRun *run = OwnRunLoad(directory, coast, &error);
    Check(run.hours >= 3, [NSString stringWithFormat:@"0.25° fixture loads (%@)", error ?: @""]);
    if (run.hours < 3) return;
    OwnLayerOptions layers = {0};
    layers.bare = 1;
    CGFloat scale = 1468.0 / 580.0;
    OwnMotionState *state = [OwnMotionState new];
    state.immediateAnnotations = YES;
    double samples[7];
    for (int i = 0; i < 7; i++) {
        @autoreleasepool {
            NSImage *image = OwnRunRenderMotion(run, i * 0.2, @"", layers, nil, scale, state);
            OwnRenderProfile profile = OwnRenderProfileLast();
            samples[i] = profile.totalMs;
            fprintf(stderr, "grid025 field %.1f smooth %.1f contour %.1f chaikin %.1f label %.1f centre %.1f draw %.1f plate %.1f total %.1f\n",
                profile.fieldMs, profile.smoothMs, profile.contourMs, profile.chaikinMs, profile.labelMs,
                profile.centreMs, profile.drawMs, profile.plateMs, profile.totalMs);
            Check(image != nil, @"0.25° motion frame renders");
        }
    }
    double ordered[7];
    memcpy(ordered, samples, sizeof ordered);
    for (int i = 1; i < 7; i++) {
        double key = ordered[i];
        int j = i;
        while (j > 0 && ordered[j - 1] > key) { ordered[j] = ordered[j - 1]; j--; }
        ordered[j] = key;
    }
    fprintf(stderr, "grid025 median frame %.1f ms\n", ordered[3]);
    if (!IsobarCISlow()) Check(ordered[3] <= 60.0, @"0.25° isobar frames stay under 60 ms");
    else fprintf(stderr, "grid025 median ceiling skipped (ISOBAR_CI_SLOW)\n");

    NSImage *still = OwnRunRender(run, 1, @"", layers, nil, scale);
    OwnMotionState *once = [OwnMotionState new];
    once.immediateAnnotations = YES;
    NSImage *moved = OwnRunRenderMotion(run, 1, @"", layers, nil, scale, once);
    OwnMotionState *again = [OwnMotionState new];
    again.immediateAnnotations = YES;
    NSImage *repeat = OwnRunRenderMotion(run, 1, @"", layers, nil, scale, again);
    double drift = FractionChanged(still, moved);
    double repeatDrift = FractionChanged(moved, repeat);
    fprintf(stderr, "grid025 still-vs-motion %.4f repeat %.4f\n", drift, repeatDrift);
    Check(repeatDrift < 0.002, @"the same 0.25° frame is stable");
    Check(drift < 0.04, @"motion and a still of the same hour stay within 4% of pixels");
    CGPoint labelPoints[80], centrePoints[24];
    NSInteger nLabels = [once copyLabelPoints:labelPoints max:80];
    NSInteger nCentres = [once copyCentrePoints:centrePoints max:24];
    int offCentre = 0;
    for (NSInteger i = 0; i < nLabels; i++) {
        double nearest = 1e9;
        for (NSInteger c = 0; c < nCentres; c++)
            nearest = MIN(nearest, hypot(labelPoints[i].x - centrePoints[c].x, labelPoints[i].y - centrePoints[c].y));
        if (nCentres == 0 || nearest > 28) offCentre++;
    }
    fprintf(stderr, "grid025 labels %ld centres %ld off-centre %d\n", (long)nLabels, (long)nCentres, offCentre);
    Check(nLabels >= 4 && offCentre >= 1, @"closed rings and long isobars both carry labels");

    IsobarLivePlayer *player = [IsobarLivePlayer new];
    player.pixelSize = NSMakeSize(1468, 1124);
    player.scale = 2;
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed8x);
    player.layers = layers;
    NSDate *start = [run timeAtIndex:0];
    NSDate *end = [run timeAtIndex:run.hours - 1];
    [player configureRun:run start:start end:end now:start modelIndex:^double(NSDate *date) {
        return ModelIndex(run, date);
    }];
    [player playFromDate:start];
    // The third completed frame locks spacing from render wall time and may
    // rebuild the cache. Sample after that. Leave the locked step alone:
    // a slow render widens it, down to the 20 fps floor, and that is the
    // cadence playback actually keeps.
    NSDate *warm = [NSDate dateWithTimeIntervalSinceNow:kLiveRenderCeiling];
    NSTimeInterval warmedSpacing = -1;
    while (warm.timeIntervalSinceNow > 0 &&
           !(player.completedRenders >= 4 && player.rendersInFlight == 0 &&
             fabs(player.frameSpacing - warmedSpacing) < 0.25)) {
        warmedSpacing = player.frameSpacing;
        TickPlayer(player, 1);
    }
    Check(player.completedRenders >= 4, @"0.25° playback renders the frames a tick asks for");
    NSUInteger quarterTicks = (NSUInteger)llround(12.0 / kIsobarLiveDisplayTick / 3.0);
    double cpuPercent = MeanAmbientCorePercent(quarterTicks, ^{ TickPlayer(player, 1); });
    fprintf(stderr, "grid025 ambient cpu %.2f%% of one core, spacing %.0fs\n", cpuPercent, player.frameSpacing);
    if (!IsobarCISlow()) Check(cpuPercent < 30.0, @"0.25° ambient playback stays under 30% of one core");
    else fprintf(stderr, "grid025 cpu ceiling skipped (ISOBAR_CI_SLOW)\n");

    // The pixel glide is a fresh player at the prompt cadence. Reusing the
    // CPU player would keep the coarser step its renders just locked.
    [player stopRendering];
    player = [IsobarLivePlayer new];
    player.pixelSize = NSMakeSize(1468, 1124);
    player.scale = 2;
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed8x);
    player.layers = layers;
    [player configureRun:run start:start end:end now:start modelIndex:^double(NSDate *date) {
        return ModelIndex(run, date);
    }];
    LockIntendedFrameSpacing(player);
    [player playFromDate:start];
    NSDate *glideWarm = [NSDate dateWithTimeIntervalSinceNow:kLiveRenderCeiling];
    while (glideWarm.timeIntervalSinceNow > 0 &&
           !(player.baseImage != nil && player.rendersInFlight == 0 && player.completedRenders >= 2)) {
        TickPlayer(player, 1);
    }
    NSDate *origin = player.playhead;
    double maxMove = 0, maxTail = 0, maxLost = 0, maxLabel = 0, maxCentre = 0;
    NSArray *labels = player.labelPositions, *centres = player.centrePositions;
    uint8_t *previous = NULL;
    int width = 0, height = 0, compared = 0;
    for (NSInteger i = 0; i < 300; i++) {
        TickPlayer(player, 1);
        NSImage *image = player.displayedImage;
        int w = 0, h = 0;
        uint8_t *bytes = CopyRGBA(image, &w, &h);
        if (!bytes) continue;
        if (previous && w == width && h == height) {
            double p95 = 0, p99 = 0, lost = 0;
            IsobarMotion(previous, bytes, w, h, &p95, &p99, &lost);
            maxMove = MAX(maxMove, p95);
            maxTail = MAX(maxTail, p99);
            maxLost = MAX(maxLost, lost);
            compared++;
        }
        free(previous);
        previous = bytes;
        width = w;
        height = h;
        maxLabel = MAX(maxLabel, MaxGlide(labels, player.labelPositions));
        maxCentre = MAX(maxCentre, MaxGlide(centres, player.centrePositions));
        labels = player.labelPositions;
        centres = player.centrePositions;
    }
    free(previous);
    double advanced = origin && player.playhead ? [player.playhead timeIntervalSinceDate:origin] / 3600.0 : 0;
    double expected = player.hoursPerSecond * (300.0 / 30.0);
    fprintf(stderr, "grid025 smooth move %.2fpx tail %.2fpx lost %.1f%% label %.6fpx centre %.6fpx advance %.2fh\n",
        maxMove, maxTail, maxLost * 100, maxLabel, maxCentre, advanced);
    Check(compared > 20 && maxLost < .10, @"0.25° isobars stay continuous across frames");
    // The denser single-field renders must still meet the visual glide bound.
    if (!IsobarCISlow()) Check(maxMove <= 1.5 && maxTail <= 1.5, @"0.25° isobars stay inside a 1.5px glide");
    else fprintf(stderr, "grid025 glide ceiling skipped (ISOBAR_CI_SLOW)\n");
    Check(maxLabel <= 0.5 && maxCentre <= 0.5, @"0.25° labels and centres stay still on screen during play");
    Check(advanced > expected * 0.8 && advanced < expected * 1.2, @"0.25° playback keeps the slow rate");
    [player stopRendering];
}

// Each place's hours follow its own daily forecast: the minimum at 5 am and
// the maximum at 3 pm local time, so the header, the dot and the day bar can
// be checked against one another.
static NSArray *TimeLensHours(NSDate *origin, NSArray *days, NSTimeZone *zone, NSString *windDir, NSInteger windKt) {
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone;
    NSMutableArray *rows = [NSMutableArray array];
    for (NSInteger hour = 0; hour <= 96; hour++) {
        NSDate *time = [origin dateByAddingTimeInterval:hour * 3600.0];
        NSDictionary *day = nil;
        for (NSDictionary *candidate in days)
            if ([candidate[@"date"] isKindOfClass:NSDate.class] && [calendar isDate:time inSameDayAsDate:candidate[@"date"]]) day = candidate;
        if (![day[@"min"] isKindOfClass:NSNumber.class] || ![day[@"max"] isKindOfClass:NSNumber.class]) continue;
        double low = [day[@"min"] doubleValue], high = [day[@"max"] doubleValue];
        NSDateComponents *parts = [calendar components:NSCalendarUnitHour | NSCalendarUnitMinute fromDate:time];
        double local = parts.hour + parts.minute / 60.0;
        double warmth = local >= 5 && local <= 15 ? 0.5 - 0.5 * cos(M_PI * (local - 5) / 10)
            : 0.5 + 0.5 * cos(M_PI * fmod(local - 15 + 24, 24) / 14);
        [rows addObject:@{
            @"time": time,
            @"temp": @(low + (high - low) * warmth),
            @"windDir": windDir,
            @"windKt": @(windKt),
            @"weatherCode": @2,
        }];
    }
    return rows;
}

static void SeekTimeLens(TestController *controller, NSDate *date) {
    NSArray *times = [controller valueForKey:@"sequenceTimes"];
    NSDate *first = times.firstObject, *last = times.lastObject;
    double span = [last timeIntervalSinceDate:first];
    double fraction = span > 0 ? [date timeIntervalSinceDate:first] / span : 0;
    [controller inspectPopoverMovieFraction:fraction];
}

static NSString *ObservationSentence(NSDictionary *obs) {
    id temp = [obs isKindOfClass:NSDictionary.class] ? obs[@"airTemp"] : nil;
    NSString *base = ([temp isKindOfClass:NSNumber.class] && isfinite([temp doubleValue]))
        ? [NSString stringWithFormat:@"%.0f°", round([temp doubleValue])] : @"—";
    NSDictionary *wind = FooterWindModel(obs);
    if (![wind[@"hasSpeed"] boolValue]) return base;
    if ([wind[@"calm"] boolValue]) return [base stringByAppendingString:@" · Calm"];
    NSString *speed = FooterWindSpeedLabel(wind);
    NSString *direction = [wind[@"direction"] length] ? wind[@"direction"] : @"";
    if (direction.length) return [NSString stringWithFormat:@"%@ · %@ %@", base, direction, speed];
    return [NSString stringWithFormat:@"%@ · %@", base, speed];
}

static NSString *ForecastSentence(NSDate *date, NSTimeZone *zone, NSArray *series) {
    NSDateFormatter *weekday = [NSDateFormatter new];
    weekday.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    weekday.timeZone = zone;
    weekday.dateFormat = @"EEE";
    double temp = DayStripTemperatureAtDate(series, date);
    NSString *degrees = isfinite(temp) ? [NSString stringWithFormat:@"%.0f°", round(temp)] : @"—";
    NSDictionary *row = series.firstObject;
    return [NSString stringWithFormat:@"%@ · %@ %@ kt", degrees, row[@"windDir"], row[@"windKt"]];
}

// Time-lens titles begin with a small NOW/FORECAST badge. Reading assertions
// must inspect the attributed run after that badge.
static NSUInteger ReadingAttributeIndex(NSAttributedString *title) {
    if (!title.length) return NSNotFound;
    NSRange separator = [title.string rangeOfString:@"  "];
    NSUInteger index = separator.location == NSNotFound ? 0 : NSMaxRange(separator);
    return MIN(index, title.length - 1);
}

static NSInteger LocalDayIndex(NSArray *days, NSDate *date, NSTimeZone *zone) {
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone;
    for (NSInteger i = 0; i < (NSInteger)days.count; i++) {
        NSDate *day = [days[i][@"date"] isKindOfClass:NSDate.class] ? days[i][@"date"] : nil;
        if (day && [calendar isDate:date inSameDayAsDate:day]) return i;
    }
    return -1;
}

static void SaveTimeLensFrame(TestController *controller, NSView *view, NSString *name) {
    NSString *directory = [NSString stringWithUTF8String:getenv("ISOBAR_TIMELENS_DIR") ?: "build/render-review/timelens2"];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    // The scrub frame is delivered on the main queue after the seek.
    for (NSInteger i = 0; i < 20; i++)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.03]];
    [view layoutSubtreeIfNeeded];
    NSView *parent = view.superview;
    NSRect oldFrame = view.frame;
    NSSize oldContentSize = controller.popover.contentSize;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-2000, -2000,
        NSWidth(oldFrame), NSHeight(oldFrame)) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    [view removeFromSuperview];
    view.frame = window.contentView.bounds;
    [window.contentView addSubview:view];
    [window displayIfNeeded];
    NSRect bounds = view.bounds;
    NSInteger wide = (NSInteger)llround(NSWidth(bounds) * 2.0);
    NSInteger high = (NSInteger)llround(NSHeight(bounds) * 2.0);
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:wide pixelsHigh:high bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    // Without a point size the rep is 1 pt per pixel and the view lands in one quarter.
    rep.size = bounds.size;
    // CAMetalLayer does not participate in AppKit bitmap drawing. Insert the
    // renderer's current snapshot at the bottom of the GPU view's child stack
    // for this capture only: native map controls and all root siblings remain
    // above it, and AppKit applies their flipped/Retina transforms together.
    GPUMapView *gpu = (GPUMapView *)FindView(view, @"popover.gpu");
    NSImageView *mapPicture = nil;
    NSRect mapRect = NSZeroRect;
    if ([gpu isKindOfClass:GPUMapView.class] && !gpu.isHiddenOrHasHiddenAncestor) {
        [gpu waitForUploads];
        CGImageRef snapshot = [gpu copySnapshot];
        Check(snapshot != NULL, [NSString stringWithFormat:@"%@ captures the Metal map", name]);
        if (snapshot) {
            NSImage *image = [[NSImage alloc] initWithCGImage:snapshot size:gpu.bounds.size];
            mapPicture = [NSImageView imageViewWithImage:image];
            mapPicture.frame = gpu.bounds;
            mapPicture.imageScaling = NSImageScaleAxesIndependently;
            [gpu addSubview:mapPicture positioned:NSWindowBelow relativeTo:nil];
            mapRect = [gpu convertRect:gpu.bounds toView:view];
            CGImageRelease(snapshot);
        }
    }
    NSGraphicsContext *context = rep ? [NSGraphicsContext graphicsContextWithBitmapImageRep:rep] : nil;
    if (context) {
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:context];
        [window.contentView displayRectIgnoringOpacity:window.contentView.bounds inContext:context];
        [NSGraphicsContext restoreGraphicsState];
    }
    [mapPicture removeFromSuperview];
    if (mapPicture) {
        // A fully opaque plate is not evidence of map content. The map's
        // interior must contain varied weather/coast/annotation pixels.
        NSMutableSet<NSNumber *> *colours = [NSMutableSet set];
        for (NSInteger y = (NSInteger)(NSMinY(mapRect) * 2 + 24); y < NSMaxY(mapRect) * 2 - 24; y += 5)
            for (NSInteger x = (NSInteger)(NSMinX(mapRect) * 2 + 24); x < NSMaxX(mapRect) * 2 - 24; x += 5) {
                if (x < 0 || y < 0 || x >= wide || y >= high) continue;
                const uint8_t *pixel = rep.bitmapData + y * rep.bytesPerRow + x * 4;
                unsigned colour = ((pixel[0] >> 3) << 10) | ((pixel[1] >> 3) << 5) | (pixel[2] >> 3);
                [colours addObject:@(colour)];
            }
        Check(colours.count > 12, [NSString stringWithFormat:@"%@ map contains rendered detail (%lu colour bins)",
            name, (unsigned long)colours.count]);
    }
    NSInteger inked[4] = {0}, cells[4] = {0};
    const uint8_t *bytes = rep.bitmapData;
    for (NSInteger y = 0; bytes && y < high; y += 4)
        for (NSInteger x = 0; x < wide; x += 4) {
            const uint8_t *p = bytes + y * rep.bytesPerRow + x * 4;
            NSInteger quadrant = (y < high / 2 ? 0 : 2) + (x < wide / 2 ? 0 : 1);
            cells[quadrant]++;
            if (p[3] > 0) inked[quadrant]++;
        }
    double least = 1;
    for (int q = 0; q < 4; q++) least = MIN(least, cells[q] ? (double)inked[q] / cells[q] : 0);
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    BOOL wrote = [png writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES];
    Check(png.length > 1000 && least > 0.5 && wrote,
        [NSString stringWithFormat:@"Retina time lens %@ renders its %ldx%ld canvas (emptiest quarter %.0f%% drawn)",
            name, (long)wide, (long)high, least * 100]);
    [view removeFromSuperview];
    if (parent) [parent addSubview:view];
    [window close];
    // NSWindow rounds its content bounds to whole points (899.820689... ->
    // 900 here). The original root may have no superview, but still belongs
    // to the popover controller: always restore its fractional frame, or the
    // next capture leaves it mismatched with popover.contentSize.
    view.frame = oldFrame;
    controller.popover.contentSize = oldContentSize;
}

static void CheckLensCursor(TestController *controller, NSInteger tag, NSDate *date) {
    ClickLens(controller, tag);
    NSView *graph = [controller valueForKey:@"forecastGraph"];
    [graph layoutSubtreeIfNeeded];
    CGFloat expected = [graph respondsToSelector:@selector(cursorXForDate:)] ? [(id)graph cursorXForDate:date] : NAN;
    NSView *cursor = FindView(graph, @"playhead.cursor");
    BOOL shown = cursor && !cursor.hidden && isfinite(expected) && fabs(NSMidX(cursor.frame) - expected) < 0.8;
    BOOL outside = !isfinite(expected) && (!cursor || cursor.hidden);
    Check(shown || outside, [NSString stringWithFormat:@"lens %ld cursor follows the playhead (x %.1f)", (long)tag, expected]);
}

static void CheckTimeLens(NSString *root) {
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    NSDate *now = [iso dateFromString:@"2026-09-26T00:30:00Z"];
    TestController *controller = [TestController new];
    controller.availableSize = NSMakeSize(1440, 900);
    [controller replaceLocations:DefaultLocations()];
    [controller setChartNow:now];
    [controller reloadStoreAtPath:root];
    for (NSDictionary *place in DefaultLocations()) {
        BOOL perth = [place[@"name"] hasPrefix:@"Perth"];
        NSArray *days = [controller packFor:place][@"daily"];
        [controller noteGlanceForGeohash:place[@"geohash"] history:nil
            series:TimeLensHours(now, days, ZoneForPlace(place), perth ? @"SW" : @"NE", perth ? 14 : 9)];
    }
    NSMutableDictionary *aheadHeaders = [NSMutableDictionary dictionary];
    [controller setValue:@YES forKey:@"forecastPaused"];
    [controller rebuildContent];
    // The first seek moves the chart onto the model run and rebuilds once.
    NSDate *primed = [now dateByAddingTimeInterval:30 * 3600.0];
    SeekTimeLens(controller, primed);
    NSArray *runTimes = [controller valueForKey:@"sequenceTimes"];
    double primedFraction = [primed timeIntervalSinceDate:runTimes.firstObject] /
        [runTimes.lastObject timeIntervalSinceDate:runTimes.firstObject];
    Check([[controller valueForKey:@"sourceECMWF"] boolValue] &&
        fabs([[controller valueForKey:@"scrubFraction"] doubleValue] - primedFraction) < 1e-6,
        @"a seek that moves onto the model run keeps the chosen time");
    for (NSString *placeName in @[@"Perth", @"Sydney"]) {
        NSPopUpButton *places = (NSPopUpButton *)FindView(controller.popover.contentViewController.view, @"hub.place");
        for (NSMenuItem *item in places.itemArray)
            if ([item.title hasPrefix:placeName]) { [places selectItem:item]; break; }
        [controller chooseHubPlace:places];
        [controller setValue:@YES forKey:@"forecastPaused"];
        NSTimeZone *zone = [controller placeZone];
        NSArray *series = [controller packFor:[controller hubPlace]][@"series"];
        NSArray *days = [controller packFor:[controller hubPlace]][@"daily"];
        NSDictionary *obs = [controller packFor:[controller hubPlace]][@"obs"];
        NSString *observation = ObservationSentence(obs);
        NSView *rootView = controller.popover.contentViewController.view;
        DayStripView *strip = (DayStripView *)FindView(rootView, @"hub.days");
        NSButton *header = (NSButton *)FindView(rootView, @"popover.obs");
        NSTextField *mark = (NSTextField *)FindView(rootView, @"hub.forecastMark");
        NSView *keptCell = FindView(strip, @"hub.day.0");
        NSRect headerFrame = header.frame, markFrame = mark.frame;
        NSArray *offsets = @[
            @[@0, @"now"],
            @[@(30 * 3600.0), @"+30 h"],
            @[@(72 * 3600.0), @"+3 d"],
        ];
        for (NSArray *step in offsets) {
            NSDate *date = [now dateByAddingTimeInterval:[step[0] doubleValue]];
            SeekTimeLens(controller, date);
            rootView = controller.popover.contentViewController.view;
            strip = (DayStripView *)FindView(rootView, @"hub.days");
            header = (NSButton *)FindView(rootView, @"popover.obs");
            mark = (NSTextField *)FindView(rootView, @"hub.forecastMark");
            BOOL atNow = [step[0] doubleValue] < 1;
            NSInteger day = LocalDayIndex(days, date, zone);
            NSString *expected = atNow ? observation : ForecastSentence(date, zone, series);
            double temp = DayStripTemperatureAtDate(series, date);
            NSString *label = header.accessibilityLabel ?: @"";
            Check(strip.highlightedDayIndex == day, [NSString stringWithFormat:@"%@ %@ highlights day %ld (got %ld)",
                placeName, step[1], (long)day, (long)strip.highlightedDayIndex]);
            Check(isfinite(temp) && fabs(strip.playheadTemperature - temp) < 1e-6,
                [NSString stringWithFormat:@"%@ %@ dot is the hourly temperature %.1f (got %.1f)",
                    placeName, step[1], temp, strip.playheadTemperature]);
            Check([label isEqual:expected], [NSString stringWithFormat:@"%@ %@ header “%@” matches “%@”",
                placeName, step[1], label, expected]);
            if (!atNow) {
                NSDictionary *today = day >= 0 && day < (NSInteger)days.count ? days[day] : nil;
                double low = [today[@"min"] doubleValue], high = [today[@"max"] doubleValue];
                NSString *degrees = [NSString stringWithFormat:@"%.0f° · ", round(temp)];
                Check(today && [label containsString:degrees] && temp >= low - 1e-9 && temp <= high + 1e-9,
                    [NSString stringWithFormat:@"%@ %@ header temperature %.1f is the hourly value inside %.1f–%.1f",
                        placeName, step[1], temp, low, high]);
                aheadHeaders[[placeName stringByAppendingString:step[1]]] = label;
            }
            Check(mark.hidden && !mark.stringValue.length,
                [NSString stringWithFormat:@"%@ %@ keeps the forecast word off the header", placeName, step[1]]);
            NSUInteger readingIndex = ReadingAttributeIndex(header.attributedTitle);
            NSColor *ink = readingIndex != NSNotFound ?
                [header.attributedTitle attribute:NSForegroundColorAttributeName atIndex:readingIndex effectiveRange:NULL] : nil;
            NSColor *treatment = atNow ? NSColor.labelColor : NSColor.secondaryLabelColor;
            Check([ink isEqual:treatment], [NSString stringWithFormat:@"%@ %@ header uses the %@ treatment",
                placeName, step[1], atNow ? @"observation" : @"forecast"]);
        }
        Check(FindView(strip, @"hub.day.0") == keptCell, @"seeking does not rebuild the day cells");
        Check(NSEqualPoints(header.frame.origin, headerFrame.origin) && NSEqualRects(mark.frame, markFrame) &&
            header.attributedTitle.size.width <= NSWidth(header.frame),
            @"the reading keeps its origin and fits as the playhead moves");
        TimelineStrip *timeline = (TimelineStrip *)FindView(rootView, @"popover.timeline");
        NSArray *bands = [timeline dayBandLabels];
        BOOL aligned = bands.count >= 4;
        for (NSUInteger i = 0; i < bands.count && i < strip.days.count; i++)
            if (![bands[i] isEqual:strip.days[i][@"weekday"]]) aligned = NO;
        Check(aligned && [bands.firstObject isEqual:@"Today"],
            [NSString stringWithFormat:@"%@ timeline bands match the strip (%@)", placeName, [bands componentsJoinedByString:@", "]]);
    }
    for (NSString *step in @[@"+30 h", @"+3 d"]) {
        NSString *perth = aheadHeaders[[@"Perth" stringByAppendingString:step]];
        NSString *sydney = aheadHeaders[[@"Sydney" stringByAppendingString:step]];
        NSArray *a = [perth componentsSeparatedByString:@" · "], *b = [sydney componentsSeparatedByString:@" · "];
        Check(a.count > 1 && b.count > 1 && ![a[0] isEqual:b[0]],
            [NSString stringWithFormat:@"%@ headers use each place's own forecast (%@ / %@)", step, perth, sydney]);
    }
    {
        NSButton *narrow = (NSButton *)FindView(controller.popover.contentViewController.view, @"popover.obs");
        NSTextField *mark = (NSTextField *)FindView(controller.popover.contentViewController.view, @"hub.forecastMark");
        NSRect kept = narrow.frame;
        [narrow setFrameSize:NSMakeSize(280, NSHeight(kept))];
        NSDate *ahead = [now dateByAddingTimeInterval:30 * 3600.0];
        SeekTimeLens(controller, ahead);
        [controller applyTimeLensButton:narrow mark:mark date:ahead announce:NO];
        NSUInteger readingIndex = ReadingAttributeIndex(narrow.attributedTitle);
        NSFont *aheadFont = readingIndex != NSNotFound ?
            [narrow.attributedTitle attribute:NSFontAttributeName atIndex:readingIndex effectiveRange:NULL] : nil;
        BOOL fits = narrow.attributedTitle.size.width <= NSWidth(narrow.frame) - 4;
        SeekTimeLens(controller, now);
        [controller applyTimeLensButton:narrow mark:mark date:now announce:NO];
        readingIndex = ReadingAttributeIndex(narrow.attributedTitle);
        NSFont *nowFont = readingIndex != NSNotFound ?
            [narrow.attributedTitle attribute:NSFontAttributeName atIndex:readingIndex effectiveRange:NULL] : nil;
        Check(NSHeight(kept) <= 36 && fits && aheadFont.pointSize >= 11 && aheadFont.pointSize <= 13 && nowFont.pointSize <= 13,
            [NSString stringWithFormat:@"the popover header is one row and the reading fits (%.0f pt, now %.0f pt)",
                aheadFont.pointSize, nowFont.pointSize]);
        narrow.accessibilityIdentifier = @"fullscreen.temperature";
        [narrow setFrameSize:NSMakeSize(280, 40)];
        [controller applyTimeLensButton:narrow mark:mark date:now announce:NO];
        readingIndex = ReadingAttributeIndex(narrow.attributedTitle);
        nowFont = readingIndex != NSNotFound ?
            [narrow.attributedTitle attribute:NSFontAttributeName atIndex:readingIndex effectiveRange:NULL] : nil;
        Check(nowFont.pointSize == 28, @"a 56 pt observation keeps the large face");
        narrow.accessibilityIdentifier = @"popover.obs";
        [narrow setFrameSize:kept.size];
    }
    SeekTimeLens(controller, now);
    NSButton *back = (NSButton *)FindView(controller.popover.contentViewController.view, @"popover.obs");
    NSString *perthNow = ObservationSentence([controller packFor:[controller hubPlace]][@"obs"]);
    Check([[controller hubPlace][@"name"] hasPrefix:@"Sydney"] && [back.accessibilityLabel isEqual:perthNow],
        @"returning to now restores the observation");
    DayStripView *strip = (DayStripView *)FindView(controller.popover.contentViewController.view, @"hub.days");
    [controller setValue:@NO forKey:@"forecastPaused"];
    [controller setValue:@YES forKey:@"popoverPlaying"];
    strip.onHover(2);
    NSDate *hoveredTime = [controller selectedForecastDate];
    Check([[controller valueForKey:@"timelinePreviewing"] boolValue] && strip.highlightedDayIndex == 2 &&
        [SituationClock(hoveredTime, [controller placeZone]) isEqual:@"12 pm"],
        @"hovering a day holds playback on that day's midday");
    strip.onHover(-1);
    Check(![[controller valueForKey:@"timelinePreviewing"] boolValue] && strip.highlightedDayIndex == 2,
        @"leaving the day resumes from the previewed midday");
    [controller stopPopoverPlayback];
    [controller setValue:@YES forKey:@"forecastPaused"];
    NSDate *ahead = [now dateByAddingTimeInterval:30 * 3600.0];
    SeekTimeLens(controller, ahead);
    for (NSNumber *tag in @[@2, @4, @0, @3, @1]) {
        CheckLensCursor(controller, tag.integerValue, ahead);
    }
    NSDate *soon = [now dateByAddingTimeInterval:6 * 3600.0];
    SeekTimeLens(controller, soon);
    NSView *fly = [controller valueForKey:@"forecastGraph"];
    [fly layoutSubtreeIfNeeded];
    CGFloat flyX = [fly respondsToSelector:@selector(cursorXForDate:)] ? [(id)fly cursorXForDate:soon] : NAN;
    NSView *flyCursor = FindView(fly, @"playhead.cursor");
    Check(isfinite(flyX) && flyCursor && !flyCursor.hidden && fabs(NSMidX(flyCursor.frame) - flyX) < 0.8,
        @"the fly cursor is visible when the playhead is inside its time window");
    if ([[controller valueForKey:@"forecastMode"] integerValue] >= 0) ClickLens(controller, 1);
    for (NSString *placeName in @[@"Perth", @"Sydney"]) {
        NSPopUpButton *places = (NSPopUpButton *)FindView(controller.popover.contentViewController.view, @"hub.place");
        for (NSMenuItem *item in places.itemArray)
            if ([item.title hasPrefix:placeName]) { [places selectItem:item]; break; }
        [controller chooseHubPlace:places];
        [controller setValue:@YES forKey:@"forecastPaused"];
        for (NSArray *step in @[@[@0, @"now"], @[@(30 * 3600.0), @"30h"], @[@(72 * 3600.0), @"3d"]]) {
            SeekTimeLens(controller, [now dateByAddingTimeInterval:[step[0] doubleValue]]);
            for (NSArray *appearance in @[
                @[NSAppearanceNameAqua, @"light"],
                @[NSAppearanceNameDarkAqua, @"dark"],
            ]) {
                NSView *view = controller.popover.contentViewController.view;
                view.appearance = [NSAppearance appearanceNamed:appearance[0]];
                CGFloat top = CGFLOAT_MAX, bottom = 0;
                for (NSView *sub in view.subviews) {
                    if (sub.hidden || NSIsEmptyRect(sub.frame)) continue;
                    top = MIN(top, NSMinY(sub.frame));
                    bottom = MAX(bottom, NSMaxY(sub.frame));
                }
                Check(view.isFlipped && NSEqualSizes(controller.popover.contentSize, view.frame.size) &&
                    top <= 16 && bottom >= NSHeight(view.bounds) - 16,
                    [NSString stringWithFormat:@"%@ popover content fills its %.0fx%.0f window (%.0f–%.0f)",
                        placeName, NSWidth(view.bounds), NSHeight(view.bounds), top, bottom]);
                SaveTimeLensFrame(controller, view, [NSString stringWithFormat:@"%@-%@-%@.png",
                    [placeName lowercaseString], appearance[1], step[1]]);
            }
        }
    }
    [controller stopPopoverPlayback];
}

// MARK: Store reload. The disk is read off the main thread, only the newest
// request commits, and a failed read keeps the last good chart on screen.

// Every load phase and the thread it ran on. A gated load parks at "begin"
// until the test opens the gate, so a test can act while it is in flight.
static NSMutableArray<NSString *> *StorePhases;
static NSInteger StoreGates, StoreActive, StoreMostActive, StoreBegun;
static dispatch_semaphore_t StoreGateReached, StoreGateOpen;

static void RecordStorePhase(const char *phase) {
    BOOL gate = NO;
    @synchronized (StorePhases) {
        [StorePhases addObject:[NSString stringWithFormat:@"%s%s", phase, NSThread.isMainThread ? "@main" : ""]];
        if (!strcmp(phase, "begin")) {
            StoreBegun++;
            StoreMostActive = MAX(StoreMostActive, ++StoreActive);
            if (StoreGates > 0) { StoreGates--; gate = YES; }
        } else if (!strcmp(phase, "end")) StoreActive--;
    }
    if (!gate) return;
    dispatch_semaphore_signal(StoreGateReached);
    dispatch_semaphore_wait(StoreGateOpen, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(20 * NSEC_PER_SEC)));
}

static void WatchStoreLoads(NSInteger gates) {
    StorePhases = [NSMutableArray array];
    StoreGates = gates;
    StoreActive = StoreMostActive = StoreBegun = 0;
    StoreGateReached = dispatch_semaphore_create(0);
    StoreGateOpen = dispatch_semaphore_create(0);
    StoreReloadTestHook = RecordStorePhase;
}

static void StopWatchingStoreLoads(void) {
    StoreReloadTestHook = NULL;
    if (!StorePhases) return;
    @synchronized (StorePhases) { StoreGates = 0; }
    // Never leave a load parked behind a gate.
    for (int i = 0; i < 4; i++) dispatch_semaphore_signal(StoreGateOpen);
}

static BOOL WaitForStoreGate(NSTimeInterval ceiling) {
    return WaitUntil(^BOOL { return dispatch_semaphore_wait(StoreGateReached, DISPATCH_TIME_NOW) == 0; }, ceiling);
}

static void OpenStoreGate(void) { dispatch_semaphore_signal(StoreGateOpen); }

static NSArray<NSString *> *StorePhaseLog(void) {
    @synchronized (StorePhases) { return [StorePhases copy] ?: @[]; }
}

// Counts what a reload does to motion and the map.
@interface StoreSpyController : TestController
@property NSInteger starts, invalidates, prepares, applies, commits;
@property (strong) NSMutableArray<NSDate *> *startDates;
@property (strong) NSMutableArray<NSString *> *events;
@end
@implementation StoreSpyController
- (instancetype)init {
    if ((self = [super init])) {
        _startDates = [NSMutableArray array];
        _events = [NSMutableArray array];
    }
    return self;
}
- (void)startLivePlaybackFromDate:(NSDate *)date {
    self.starts++;
    [self.startDates addObject:date ?: NSDate.distantPast];
    [self.events addObject:@"start"];
    [super startLivePlaybackFromDate:date];
}
- (void)invalidateMotion { self.invalidates++; [self.events addObject:@"invalidate"]; [super invalidateMotion]; }
- (void)prepareChartImages { self.prepares++; [self.events addObject:@"prepare"]; [super prepareChartImages]; }
- (void)applyLiveFrame { self.applies++; [super applyLiveFrame]; }
- (void)commitStoreSnapshot:(StoreSnapshot *)snapshot {
    self.commits++;
    [self.events addObject:NSThread.isMainThread ? @"commit" : @"commit off main"];
    [super commitStoreSnapshot:snapshot];
}
@end

static NSString *GridStamp(NSDate *date, NSString *format) {
    NSDateFormatter *formatter = [NSDateFormatter new];
    formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    formatter.dateFormat = format;
    return [formatter stringFromDate:date];
}

static NSString *GridRunID(NSDate *date) { return GridStamp(date, @"yyyyMMdd'T'HH'Z'"); }

static uint16_t HalfFloat(float value) {
    uint32_t bits;
    memcpy(&bits, &value, 4);
    uint32_t sign = (bits >> 16) & 0x8000;
    int32_t exponent = (int32_t)((bits >> 23) & 0xff) - 127 + 15;
    uint32_t mantissa = bits & 0x7fffff;
    if (exponent <= 0) return (uint16_t)sign;
    if (exponent >= 31) return (uint16_t)(sign | 0x7c00);
    return (uint16_t)(sign | ((uint32_t)exponent << 10) | (mantissa >> 13));
}

// One published 0.25° run as the collector writes it: six variables of
// `frames` three-hour f16 payloads with sidecars, on the lon0 95, lat0 0 grid.
// Pressure drifts with valid time. Each run has its own phase, so a new run
// is visibly new at the same hour.
static void WritePublishedRun(NSString *root, NSDate *run, int nx, int ny, int frames) {
    NSArray *vars = @[@[@"mslp", @"msl", @"hPa"], @[@"t850", @"t", @"degC"], @[@"t2m", @"2t", @"degC"],
        @[@"u10", @"10u", @"m/s"], @[@"v10", @"10v", @"m/s"], @[@"tp", @"tp", @"mm"]];
    NSFileManager *fm = NSFileManager.defaultManager;
    size_t points = (size_t)nx * (size_t)ny;
    NSMutableData *payload = [NSMutableData dataWithLength:points * 2];
    double phase = fmod(run.timeIntervalSince1970 / (6 * 3600.0) * 0.9, 2 * M_PI);
    for (NSArray *variable in vars) {
        NSString *dir = [root stringByAppendingFormat:@"/products/grids/ecmwf_ifs025/runs/%@/%@", GridRunID(run), variable[0]];
        [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        BOOL pressure = [variable[0] isEqual:@"mslp"];
        for (int frame = 0; frame < frames; frame++) {
            NSDate *valid = [run dateByAddingTimeInterval:3 * 3600.0 * frame];
            double hours = (valid.timeIntervalSince1970 - 1790000000) / 3600.0;
            uint8_t *bytes = payload.mutableBytes;
            float flat = [variable[0] isEqual:@"tp"] ? 0.05f * frame : ([variable[0] hasPrefix:@"t"] ? 14 : 3);
            for (size_t i = 0; i < points; i++) {
                float value = flat;
                if (pressure) {
                    double u = (double)(i % (size_t)nx) / nx, w = (double)(i / (size_t)nx) / ny;
                    value = (float)(1012 + 9 * sin(6 * u + 0.05 * hours + phase) * cos(4 * w - 0.03 * hours));
                }
                uint16_t half = HalfFloat(value);
                bytes[2 * i] = (uint8_t)(half & 255);
                bytes[2 * i + 1] = (uint8_t)(half >> 8);
            }
            NSString *stem = [dir stringByAppendingPathComponent:GridRunID(valid)];
            [payload writeToFile:[stem stringByAppendingPathExtension:@"f16"] atomically:YES];
            NSDictionary *side = @{@"lat0": @0, @"lon0": @95, @"dlat": @-0.25, @"dlon": @0.25, @"ny": @(ny), @"nx": @(nx),
                @"units": variable[2], @"run": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"valid_time": GridStamp(valid, @"yyyy-MM-dd'T'HH:mm:ss'Z'"), @"model": @"ecmwf-ifs-0p25-open-data",
                @"fill": @-32768, @"native_step_hours": @3, @"order": @"north-to-south, west-to-east",
                @"dtype": @"float16", @"endian": @"little", @"param": variable[1]};
            [[NSJSONSerialization dataWithJSONObject:side options:0 error:nil]
                writeToFile:[stem stringByAppendingPathExtension:@"json"] atomically:YES];
        }
    }
}

static void WritePublishedPointer(NSString *root, NSArray<NSDate *> *runs) {
    NSMutableArray *ids = [NSMutableArray array];
    for (NSDate *run in runs) [ids addObject:GridRunID(run)];
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [NSFileManager.defaultManager createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
    NSData *pointer = [NSJSONSerialization dataWithJSONObject:@{@"latest": ids.lastObject, @"runs": ids} options:0 error:nil];
    [pointer writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
}

// A bounded global controller fixture. All frame payloads for one variable
// share a hard-linked 720x361 field; sidecars remain distinct so the reader
// still validates every 3-hour lead without writing hundreds of megabytes.
static void WritePublishedGlobalStore(NSString *root, NSDate *run) {
    int nx = 720, ny = 361;
    NSArray *leads = @[@0,@3,@6,@9,@12,@15,@18,@21,@24,@27,@30,@33,@36,@39,@42,@45,@48,@51,@54,@57,
        @60,@63,@66,@69,@72,@75,@78,@81,@84,@87,@90,@93,@96,@99,@102,@105,@108,@111,@114,@117,
        @120,@123,@126,@129,@132,@135,@138,@141,@144,@150,@156,@162,@168];
    NSArray *vars = @[@[ @"mslp", @"msl", @"hPa" ], @[ @"t850", @"t", @"degC" ],
        @[ @"t2m", @"2t", @"degC" ], @[ @"u10", @"10u", @"m/s" ],
        @[ @"v10", @"10v", @"m/s" ], @[ @"tp", @"tp", @"mm" ]];
    NSFileManager *fm = NSFileManager.defaultManager;
    size_t points = (size_t)nx * (size_t)ny;
    NSMutableData *payload = [NSMutableData dataWithLength:points * 2];
    for (NSArray *variable in vars) {
        NSString *dir = [root stringByAppendingFormat:@"/products/grids/ecmwf_ifs_global/runs/%@/%@",
            GridRunID(run), variable[0]];
        [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        uint16_t half = HalfFloat([variable[0] isEqual:@"mslp"] ? 1012 : 0);
        uint8_t *bytes = payload.mutableBytes;
        for (size_t i = 0; i < points; i++) { bytes[2*i] = (uint8_t)half; bytes[2*i+1] = (uint8_t)(half >> 8); }
        NSString *seed = [dir stringByAppendingPathComponent:@"payload.f16"];
        [payload writeToFile:seed atomically:YES];
        for (int frame = 0; frame < (int)leads.count; frame++) {
            int lead = [leads[frame] intValue];
            NSDate *valid = [run dateByAddingTimeInterval:lead * 3600.0];
            NSString *validID = GridRunID(valid);
            NSString *stem = [dir stringByAppendingPathComponent:validID];
            [fm linkItemAtPath:seed toPath:[stem stringByAppendingPathExtension:@"f16"] error:nil];
            NSDictionary *side = @{ @"lat0": @90, @"lon0": @-180, @"dlat": @-0.5, @"dlon": @0.5,
                @"ny": @(ny), @"nx": @(nx), @"units": variable[2],
                @"run": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"valid_time": GridStamp(valid, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"model": @"ecmwf-ifs-global", @"fill": @-32768, @"lead_hours": @(lead),
                @"param": variable[1], @"dtype": @"float16", @"endian": @"little",
                @"order": @"north-to-south, west-to-east" };
            [[NSJSONSerialization dataWithJSONObject:side options:0 error:nil]
                writeToFile:[stem stringByAppendingPathExtension:@"json"] atomically:YES];
        }
        [fm removeItemAtPath:seed error:nil];
    }
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs_global"];
    NSDictionary *manifest = @{ @"schema_version": @2, @"contract": @"isobar-data",
        @"family": @"grids/ecmwf_ifs_global", @"run": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
        @"generated": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'"), @"forecast_hours": leads,
        @"horizon_hours": @168 };
    NSString *runDir = [family stringByAppendingPathComponent:[NSString stringWithFormat:@"runs/%@", GridRunID(run)]];
    [[NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil]
        writeToFile:[runDir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
    NSDictionary *pointer = @{ @"schema_version": @2, @"contract": @"isobar-data",
        @"family": @"grids/ecmwf_ifs_global", @"latest": GridRunID(run),
        @"runs": @[GridRunID(run)], @"forecast_hours": leads, @"horizon_hours": @168 };
    [[NSJSONSerialization dataWithJSONObject:pointer options:0 error:nil]
        writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
    WriteStatus(root, YES);
}

// Runs oldest first, a pointer naming the newest, and a healthy status.
static void MakePublishedStore(NSString *root, NSArray<NSDate *> *runs, int nx, int ny) {
    for (NSDate *run in runs) WritePublishedRun(root, run, nx, ny, 33);
    WritePublishedPointer(root, runs);
    WriteStatus(root, YES);
}

// A Swanbourne observation in SQLite and a surface point beside Perth, so a
// load reads real rows on the store queue.
static void AddPublishedWeather(NSString *root, NSDate *now) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *obsDir = [root stringByAppendingPathComponent:@"products/obs"];
    [fm createDirectoryAtPath:obsDir withIntermediateDirectories:YES attributes:nil error:nil];
    sqlite3 *db = NULL;
    if (sqlite3_open([obsDir stringByAppendingPathComponent:@"obs.sqlite"].UTF8String, &db) == SQLITE_OK) {
        sqlite3_exec(db, "CREATE TABLE obs (wmo INTEGER, aifstime_utc TEXT, product_id TEXT, name TEXT, lat REAL, lon REAL, air_temp REAL, wind_dir TEXT, wind_dir_deg REAL, wind_spd_kmh REAL, gust_kmh REAL, wind_spd_kt REAL, gust_kt REAL, press_msl REAL, press_tend TEXT, rain_trace TEXT, cloud_base_m REAL, vis_km REAL)", NULL, NULL, NULL);
        NSString *stamp = GridStamp([now dateByAddingTimeInterval:-30 * 60], @"yyyyMMddHHmmss");
        NSString *row = [NSString stringWithFormat:@"INSERT INTO obs VALUES (94614,'%@','IDW60910','Swanbourne',-32,115.8,21,'W',270,20,24,11,13,1015,'-','0.0',NULL,NULL)", stamp];
        sqlite3_exec(db, row.UTF8String, NULL, NULL, NULL);
    }
    sqlite3_close(db);
    NSString *points = [root stringByAppendingPathComponent:@"products/points/ecmwf_ifs"];
    NSString *run = [points stringByAppendingPathComponent:@"runs/run1"];
    [fm createDirectoryAtPath:run withIntermediateDirectories:YES attributes:nil error:nil];
    [[NSJSONSerialization dataWithJSONObject:@{@"latest": @"run1"} options:0 error:nil]
        writeToFile:[points stringByAppendingPathComponent:@"current.json"] atomically:YES];
    NSMutableArray *times = [NSMutableArray array], *speeds = [NSMutableArray array], *temps = [NSMutableArray array];
    for (int hour = -2; hour < 30; hour++) {
        [times addObject:GridStamp([now dateByAddingTimeInterval:hour * 3600.0], @"yyyy-MM-dd'T'HH:00")];
        [speeds addObject:@(10 + hour % 5)];
        [temps addObject:@(18 + hour % 7)];
    }
    NSDictionary *point = @{@"id": @"perth", @"latitude": @-31.96, @"longitude": @115.78,
        @"units": @{@"wind_speed_10m": @"kn", @"wind_gusts_10m": @"kn"}, @"time": times,
        @"hourly": @{@"wind_speed_10m": speeds, @"temperature_2m": temps}};
    [[NSJSONSerialization dataWithJSONObject:point options:0 error:nil]
        writeToFile:[run stringByAppendingPathComponent:@"perth.json"] atomically:YES];
}

static NSString *CopyFixtureStore(NSString *fixtures, NSString *base, NSString *name) {
    NSString *root = [base stringByAppendingPathComponent:name];
    Check([NSFileManager.defaultManager copyItemAtPath:[fixtures stringByAppendingPathComponent:@"store"] toPath:root error:nil],
        [NSString stringWithFormat:@"copy the legacy fixture store for %@", name]);
    return root;
}

static NSView *PopoverRoot(TestController *c) { return c.popover.contentViewController.view; }

static NSImage *ShownMap(TestController *c) { return SnapshotDisplayedMap([c timelineChart]); }

// Share of dark isobar ink on the map the viewer sees.
static double InkShare(NSImage *frame) {
    int w = 0, h = 0;
    uint8_t *bytes = CopyRGBA(frame, &w, &h);
    if (!bytes) return 0;
    double share = (double)CountInk(bytes, w, h) / (w * h);
    free(bytes);
    return share;
}

// A map with no isobars on it.
static BOOL BlankMap(NSImage *frame) { return InkShare(frame) < 0.002; }

// Private step grid. Spacing and the step count change together in the player;
// writing the ivar alone would leave the old grid in place.
static void RebuildLiveSteps(IsobarLivePlayer *player) {
    SEL rebuild = NSSelectorFromString(@"rebuildSteps");
    if (![player respondsToSelector:rebuild]) return;
    IMP imp = [player methodForSelector:rebuild];
    ((void (*)(id, SEL))imp)(player, rebuild);
}

// The spacing a prompt render locks in. A busy machine stretches the render's
// wall time and would otherwise coarsen the step, so the glide checks pin the
// player's cadence here and then advance one display tick at a time.
static BOOL LockIntendedFrameSpacing(IsobarLivePlayer *player) {
    if (!player) return NO;
    WaitUntil(^BOOL { return player.rendersInFlight == 0; }, kLiveRenderCeiling);
    NSTimeInterval intended = IsobarLiveFrameSpacing(0.001, player.hoursPerSecond);
    @try {
        // Private cadence state. A prompt render locks this; a stalled render
        // would coarsen it, and the glide bound is for the prompt cadence.
        [player setValue:@(player.hoursPerSecond) forKey:@"spacingSpeed"];
        [player setValue:@(intended) forKey:@"spacing"];
        [player setValue:@YES forKey:@"spacingLocked"];
    } @catch (NSException *exception) {
        fprintf(stderr, "frame spacing lock failed: %s\n", exception.reason.UTF8String);
        return NO;
    }
    RebuildLiveSteps(player);
    [player invalidateFrames];
    return fabs(player.frameSpacing - intended) < 0.5;
}

static void SettleLiveCadence(TestController *c) {
    IsobarLivePlayer *live = [c valueForKey:@"live"];
    NSTimeInterval intended = IsobarLiveFrameSpacing(0.001, live.hoursPerSecond);
    BOOL locked = LockIntendedFrameSpacing(live);
    BOOL ready = WaitUntil(^BOOL { return live.baseImage != nil && live.rendersInFlight == 0; }, kLiveRenderCeiling);
    fprintf(stderr, "glide spacing %.0f intended %.0f\n", live.frameSpacing, intended);
    Check(locked && ready && fabs(live.frameSpacing - intended) < 0.5,
        @"glide checks use the frame spacing a prompt render keeps");
}

// One display tick, after any store reload or render already in flight has
// finished, then the picture that tick left on screen. Waiting first keeps a
// late frame from landing in the same snapshot as the next step.
static NSImage *TickShown(TestController *c) {
    [c waitForStoreCommit:kLiveRenderCeiling];
    SettleController(c);
    [c advanceLiveTicks:1];
    SettleController(c);
    [c applyLiveFrame];
    [CATransaction flush];
    return ShownMap(c);
}

static void ShowPlayingPopover(TestController *c) {
    ShownPlaybackPopover *shown = [ShownPlaybackPopover new];
    shown.contentViewController = c.popover.contentViewController;
    c.popover = shown;
    [c setValue:@NO forKey:@"forecastPaused"];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    [c popoverDidShow:[NSNotification notificationWithName:NSPopoverDidShowNotification object:shown]];
    IsobarLivePlayer *live = [c valueForKey:@"live"];
    WaitUntil(^BOOL { return live.baseImage != nil && live.rendersInFlight == 0; }, kLiveRenderCeiling);
}

static void ClosePlayingPopover(TestController *c) {
    [c stopPopoverPlayback];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:c.popover]];
}

static StoreSpyController *StoreSpy(NSString *root, NSDate *now) {
    StoreSpyController *c = [StoreSpyController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:now];
    [c useManualLiveClock];
    [c reloadStoreAtPath:root];
    [c rebuildContent];
    return c;
}

static void CheckColdStartFailsClosed(NSString *fixtures, NSString *base, NSDate *now) {
    NSString *broken = CopyFixtureStore(fixtures, base, @"cold-broken");
    Check([[NSData data] writeToFile:[broken stringByAppendingPathComponent:@"ecmwf/20260925T18Z/msl.f32"] atomically:YES],
        @"truncate the chart field before the first load");
    TestController *cold = [TestController new];
    cold.availableSize = NSMakeSize(1440, 900);
    [cold replaceLocations:DefaultLocations()];
    [cold setChartNow:now];
    [cold reloadStoreAtPath:broken];
    [cold rebuildContent];
    Check(![cold chartsReady] && HasText(PopoverRoot(cold), @"Chart unavailable") && !HasText(PopoverRoot(cold), @"ECMWF 18Z"),
        @"a manifest without readable chart data cannot advertise a fresh forecast");
    [cold setValue:@NO forKey:@"sourceECMWF"];
    [cold rebuildContent];
    Check([cold chartsReady] && HasText(PopoverRoot(cold), @"Bureau") &&
          !HasText(PopoverRoot(cold), @"Chart unavailable") && !HasText(PopoverRoot(cold), @"18Z"),
        @"the Bureau alternate remains available without borrowing an ECMWF timestamp");

    NSString *both = CopyFixtureStore(fixtures, base, @"cold-both");
    NSString *family = [both stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [NSFileManager.defaultManager createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
    [@"[]" writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    TestController *fresh = [TestController new];
    fresh.availableSize = NSMakeSize(1440, 900);
    [fresh replaceLocations:DefaultLocations()];
    [fresh setChartNow:now];
    [fresh reloadStoreAtPath:both];
    [fresh rebuildContent];
    Check(![fresh chartsReady] && ![fresh valueForKey:@"ownRun"] && HasText(PopoverRoot(fresh), @"Chart unavailable") &&
          !HasText(PopoverRoot(fresh), @"ECMWF 18Z"),
        @"an invalid published grid never falls back to the legacy chart");

    // A global pointer is authoritative even when its JSON is malformed: a
    // regional pointer copied into the same store must not make the controller
    // claim worldwide coverage survived a failed global publish.
    NSString *globalOnly = CopyFixtureStore(fixtures, base, @"cold-global-invalid");
    NSDate *regionalR0 = [now dateByAddingTimeInterval:-6.5 * 3600.0];
    NSDate *regionalR1 = [now dateByAddingTimeInterval:-30 * 60.0];
    MakePublishedStore(globalOnly, @[regionalR0, regionalR1], 24, 16);
    StoreSpyController *regionalBeforeGlobal = StoreSpy(globalOnly, now);
    Check([regionalBeforeGlobal chartsReady] && [regionalBeforeGlobal valueForKey:@"ownRun"],
        @"the control archive has a valid regional published run before the global pointer appears");
    [regionalBeforeGlobal stopPopoverPlayback];
    NSString *globalFamily = [globalOnly stringByAppendingPathComponent:@"products/grids/ecmwf_ifs_global"];
    [NSFileManager.defaultManager createDirectoryAtPath:globalFamily withIntermediateDirectories:YES attributes:nil error:nil];
    [@"[]" writeToFile:[globalFamily stringByAppendingPathComponent:@"current.json"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    TestController *globalCold = [TestController new];
    globalCold.availableSize = NSMakeSize(1440, 900);
    [globalCold replaceLocations:DefaultLocations()];
    [globalCold setChartNow:now];
    [globalCold reloadStoreAtPath:globalOnly];
    [globalCold rebuildContent];
    Check(![globalCold chartsReady] && ![globalCold valueForKey:@"ownRun"] &&
          HasText(PopoverRoot(globalCold), @"Chart unavailable"),
        @"a malformed global pointer fails closed instead of falling back to a regional run");

    NSString *legacy = CopyFixtureStore(fixtures, base, @"warm-legacy");
    TestController *warm = [TestController new];
    warm.availableSize = NSMakeSize(1440, 900);
    [warm replaceLocations:DefaultLocations()];
    [warm setChartNow:now];
    [warm reloadStoreAtPath:legacy];
    BOOL loaded = [warm chartsReady];
    NSString *warmFamily = [legacy stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [NSFileManager.defaultManager createDirectoryAtPath:warmFamily withIntermediateDirectories:YES attributes:nil error:nil];
    [@"[]" writeToFile:[warmFamily stringByAppendingPathComponent:@"current.json"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [warm reloadStoreAtPath:legacy];
    [warm rebuildContent];
    Check(loaded && ![warm chartsReady] && HasText(PopoverRoot(warm), @"Chart unavailable"),
        @"a broken published grid that replaces a legacy store is not covered by the legacy run");
    [NSFileManager.defaultManager removeItemAtPath:warmFamily error:nil];
    [warm reloadStoreAtPath:legacy];
    loaded = [warm chartsReady];
    [warm reloadStoreAtPath:broken];
    [warm rebuildContent];
    Check(loaded && ![warm chartsReady] && HasText(PopoverRoot(warm), @"Chart unavailable"),
        @"a broken store at another root is not covered by the last root's run");
    for (TestController *c in @[cold, fresh, globalCold, warm]) [c stopPopoverPlayback];
}

static void CheckLegacyFailedReloadKeepsLastGood(NSString *fixtures, NSString *base, NSDate *now) {
    NSString *root = CopyFixtureStore(fixtures, base, @"legacy-keep");
    TestController *c = [TestController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:now];
    [c reloadStoreAtPath:root];
    [c rebuildContent];
    OwnRun *run = [c valueForKey:@"ownRun"];
    NSDate *runDate = [c valueForKey:@"runDate"];
    NSData *pdf = [c valueForKey:@"chartPDF"], *drawn = [c valueForKey:@"chartPDFDrawn"];
    [c reloadStoreAtPath:root];
    Check(run && [c valueForKey:@"ownRun"] == run, @"re-reading an unchanged legacy run keeps the same run object");
    Check(pdf && [c valueForKey:@"chartPDF"] == pdf && [c valueForKey:@"chartPDFDrawn"] == drawn,
        @"an unchanged Bureau chart is not recoloured again");
    NSFileManager *fm = NSFileManager.defaultManager;
    Check([[NSData data] writeToFile:[root stringByAppendingPathComponent:@"ecmwf/20260925T18Z/msl.f32"] atomically:YES] &&
          [fm removeItemAtPath:[root stringByAppendingPathComponent:@"products/obs"] error:nil] &&
          [fm removeItemAtPath:[root stringByAppendingPathComponent:@"products/points"] error:nil],
        @"truncate the loaded field and drop observations and points");
    [c reloadStoreAtPath:root];
    [c rebuildContent];
    NSView *view = PopoverRoot(c);
    NSView *issuedCue = FindView(view, @"popover.issued");
    NSTextField *runCue = (NSTextField *)FindView(issuedCue, @"popover.issued.run");
    NSView *warnCue = FindView(issuedCue, @"popover.issued.warn");
    Check([c chartsReady] && [c valueForKey:@"ownRun"] == run && SameDate([c valueForKey:@"runDate"], runDate) &&
          [runCue.stringValue isEqual:@"18Z"] && warnCue && !warnCue.hidden &&
          [issuedCue.toolTip containsString:@"stale"] && !HasText(view, @"stale") && !HasText(view, @"Chart unavailable"),
        @"a truncated legacy field keeps the last good chart, with the age and a warning");
    BOOL dropped = YES;
    for (NSDictionary *place in DefaultLocations()) {
        NSDictionary *pack = [c packFor:place];
        if (pack[@"obs"] || [pack[@"hourly"] count] || [pack[@"series"] count] || [pack[@"history"] count]) dropped = NO;
    }
    Check(dropped, @"a kept chart does not keep weather the snapshot no longer has");
    [c stopPopoverPlayback];
}

static void CheckSurfaceTeardownAndExpandedUnavailable(NSString *fixtures, NSString *base, NSDate *now) {
    NSString *root = CopyFixtureStore(fixtures, base, @"expanded-unavailable");
    NSString *broken = CopyFixtureStore(fixtures, base, @"expanded-unavailable-broken");
    Check([[NSData data] writeToFile:[broken stringByAppendingPathComponent:@"ecmwf/20260925T18Z/msl.f32"] atomically:YES],
        @"prepare a failed-closed root for the expanded map");
    TestController *c = [TestController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:now];
    [c reloadStoreAtPath:root];
    [c rebuildContent];
    [c presentChartWindowInFrame:NSMakeRect(0, 0, 1280, 720)];
    NSView *expanded = c.chartWindow.contentView;
    Check(FindView(expanded, @"window.chart") != nil && FindView(expanded, @"fullscreen.timeline") != nil,
        @"expanded map starts with its map and transport attached");
    PDFCropView *expandedChart = (PDFCropView *)FindView(expanded, @"window.chart");
    Check(expandedChart && !expandedChart.handlesGestures && expandedChart.enclosingScrollView == [c valueForKey:@"singleScroll"],
        @"expanded fallback keeps its scroll-view gesture path");

    // A failed-closed root must replace the old expanded map, while a later
    // valid reload must restore the map and controls on the same window.
    [c reloadStoreAtPath:broken];
    Check(FindView(expanded, @"fullscreen.chartUnavailable") != nil &&
          FindView(expanded, @"window.chart") == nil &&
          FindView(expanded, @"fullscreen.timeline") == nil,
        @"a failed expanded reload replaces stale map controls with one unavailable cue");
    NSScrollView *scroll = [c valueForKey:@"singleScroll"];
    Check(scroll.hidden, @"an unavailable expanded map hides its old scroll surface");
    [c reloadStoreAtPath:root];
    Check([c chartsReady], @"a valid root restores chart readiness after failure");
    Check([c valueForKey:@"ownRun"] != nil && [[c valueForKey:@"frameIndices"] count] > 0,
        @"a valid root restores the run and frame ladder after failure");
    Check(!scroll.hidden, @"a valid root unhides the old scroll surface");
    Check(FindView(expanded, @"window.chart") != nil, @"a valid root restores the expanded map view");
    Check(FindView(expanded, @"fullscreen.timeline") != nil, @"a valid root restores the expanded timeline");
    Check(FindView(expanded, @"fullscreen.chartUnavailable") == nil, @"a valid root removes the unavailable cue");
    Check(!scroll.hidden && FindView(expanded, @"window.chart") != nil &&
          FindView(expanded, @"fullscreen.timeline") != nil &&
          FindView(expanded, @"fullscreen.chartUnavailable") == nil,
        @"a valid reload restores the expanded map and transport after failure");

    NSTimer *liveSize = [NSTimer timerWithTimeInterval:.15 repeats:NO block:^(__unused NSTimer *timer) {}];
    NSTimer *scrubRest = [NSTimer timerWithTimeInterval:.45 repeats:NO block:^(__unused NSTimer *timer) {}];
    [c setValue:liveSize forKey:@"liveSizeTimer"];
    [c setValue:scrubRest forKey:@"scrubRestTimer"];
    [c invalidateSurfaceTimers];
    Check([c valueForKey:@"liveSizeTimer"] == nil && [c valueForKey:@"scrubRestTimer"] == nil &&
          !liveSize.isValid && !scrubRest.isValid,
        @"surface teardown invalidates deferred resize and scrub timers");
    [c closeChartWindow];
}

static void CheckSnapshotLoadsOffMainThread(NSString *root, NSDate *now) {
    TestController *c = [TestController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:now];
    [c reloadStoreAtPath:root];
    WatchStoreLoads(0);
    [c requestStoreReload];
    BOOL committed = [c waitForStoreCommit:30];
    StopWatchingStoreLoads();
    NSArray<NSString *> *log = StorePhaseLog();
    NSArray *expected = @[@"begin", @"grid", @"previous grid", @"pdf", @"previous pdf", @"observations",
        @"kite", @"warnings", @"points", @"marine", @"aviation", @"end"];
    NSMutableArray *missing = [NSMutableArray array];
    for (NSString *phase in expected) if (![log containsObject:phase]) [missing addObject:phase];
    NSUInteger onMain = 0, commits = 0;
    for (NSString *entry in log) {
        if ([entry isEqual:@"commit@main"]) commits++;
        else if ([entry hasSuffix:@"@main"]) onMain++;
    }
    fprintf(stderr, "store phases %s\n", [log componentsJoinedByString:@", "].UTF8String);
    Check(committed && !missing.count && onMain == 0,
        [NSString stringWithFormat:@"every load phase runs off the main thread (missing %@)", [missing componentsJoinedByString:@", "]]);
    Check(commits == 1 && ![log containsObject:@"commit"], @"the snapshot commits once, on the main thread");
    Check([[c packFor:DefaultLocations().firstObject][@"obs"][@"airTemp"] doubleValue] == 21,
        @"the off-main load reads SQLite observations");
}

static void CheckRefreshDoesNotBlockPlayback(NSString *root, NSDate *now) {
    StoreSpyController *c = StoreSpy(root, now);
    ShowPlayingPopover(c);
    IsobarLivePlayer *live = [c valueForKey:@"live"];
    NSDate *before = live.playhead;
    c.commits = 0;
    c.prepares = 0;
    [c.events removeAllObjects];
    WatchStoreLoads(1);
    [c refreshAll];
    BOOL parked = WaitForStoreGate(5);
    [c advanceLiveTicks:5];
    NSDate *after = live.playhead;
    BOOL advanced = before && after && [after timeIntervalSinceDate:before] > 1;
    Check(parked && advanced && c.commits == 0 && c.prepares == 0,
        @"refreshAll returns at once and playback ticks while the store loads off the main thread");
    OpenStoreGate();
    BOOL committed = [c waitForStoreCommit:30];
    StopWatchingStoreLoads();
    Check(committed && c.commits == 1 && [c.events isEqual:@[@"commit", @"prepare"]],
        [NSString stringWithFormat:@"the load commits once, then prepares maps (%@)", [c.events componentsJoinedByString:@", "]]);
    ClosePlayingPopover(c);
}

static void CheckSupersededSnapshotIsDropped(NSString *root, NSString *other, NSDate *now, NSDate *otherRun) {
    StoreSpyController *c = StoreSpy(root, now);
    WatchStoreLoads(1);
    c.commits = 0;
    [c requestStoreReload];
    BOOL parked = WaitForStoreGate(5);
    [c requestStoreReload];
    [c requestStoreReload];
    OpenStoreGate();
    BOOL done = [c waitForStoreCommit:30];
    NSInteger begun, most;
    @synchronized (StorePhases) { begun = StoreBegun; most = StoreMostActive; }
    StopWatchingStoreLoads();
    Check(parked && done && c.commits == 1 && begun == 2 && most == 1,
        [NSString stringWithFormat:@"requests during a load coalesce into one follow-up, and only it commits (%ld loads, %ld commits)",
            (long)begun, (long)c.commits]);

    WatchStoreLoads(1);
    c.commits = 0;
    [c requestStoreReload];
    parked = WaitForStoreGate(5);
    [c setValue:other forKey:@"storeRoot"];
    [c requestStoreReload];
    OpenStoreGate();
    done = [c waitForStoreCommit:30];
    StopWatchingStoreLoads();
    Check(parked && done && c.commits == 1 && [[c valueForKey:@"storeRoot"] isEqual:other] &&
          SameDate([c valueForKey:@"runDate"], otherRun),
        @"a load of the old root that a root swap superseded never commits");

    WatchStoreLoads(1);
    c.commits = 0;
    [c requestStoreReload];
    parked = WaitForStoreGate(5);
    NSDictionary *perth = DefaultLocations()[0], *sydney = DefaultLocations()[1];
    [c replaceLocations:@[sydney]];
    OpenStoreGate();
    done = [c waitForStoreCommit:30];
    StopWatchingStoreLoads();
    NSDictionary *weather = [c valueForKey:@"weather"];
    Check(parked && done && c.commits == 1 && !weather[perth[@"geohash"]] && weather[sydney[@"geohash"]],
        @"places replaced during a load get a fresh load, and the old places never return");

    StoreSpyController *quitting = StoreSpy(root, now);
    WatchStoreLoads(1);
    quitting.commits = 0;
    [quitting requestStoreReload];
    parked = WaitForStoreGate(5);
    [quitting applicationWillTerminate:[NSNotification notificationWithName:NSApplicationWillTerminateNotification object:NSApp]];
    OpenStoreGate();
    Pump(0.5);
    StopWatchingStoreLoads();
    Check(parked && quitting.commits == 0, @"a load that finishes after terminate is dropped");
}

static void CheckUnchangedRefreshKeepsPlaybackSteady(StoreSpyController *c) {
    for (int i = 0; i < 10; i++) TickShown(c);
    IsobarLivePlayer *live = [c valueForKey:@"live"];
    OwnRun *run = [c valueForKey:@"ownRun"];
    NSDate *playhead = live.playhead;
    NSSet *keys = [NSSet setWithArray:[[c valueForKey:@"chartCache"] allKeys]];
    NSInteger starts = c.starts, invalidates = c.invalidates;
    NSImage *previous = ShownMap(c);
    [c refreshAll];
    BOOL committed = [c waitForStoreCommit:30];
    Check(committed && [c valueForKey:@"live"] == live && [c valueForKey:@"ownRun"] == run && SameDate(live.playhead, playhead) &&
          c.starts == starts && c.invalidates == invalidates,
        [NSString stringWithFormat:@"an unchanged refresh keeps the run, the player and the playhead (player %d run %d playhead %d starts %ld invalidates %ld)",
            [c valueForKey:@"live"] == live, [c valueForKey:@"ownRun"] == run, SameDate(live.playhead, playhead),
            (long)(c.starts - starts), (long)(c.invalidates - invalidates)]);
    Check([keys isSubsetOfSet:[NSSet setWithArray:[[c valueForKey:@"chartCache"] allKeys]]],
        @"an unchanged refresh keeps the rendered maps");
    double worst = 0;
    for (int i = 0; i < 12; i++) {
        NSImage *frame = TickShown(c);
        worst = MAX(worst, FractionChanged(previous, frame));
        previous = frame;
    }
    Check(worst <= kGlidePixelShare, [NSString stringWithFormat:@"the map glides through an unchanged refresh (worst tick %.4f)", worst]);
    [c previewPopoverMovieFraction:.55];
    WaitUntil(^BOOL { return [[c valueForKey:@"scrubRenderer"] renderCount] > 0; }, 2);
    [c refreshAll];
    committed = [c waitForStoreCommit:30];
    TimelineStrip *strip = [c valueForKey:@"popoverTimeline"];
    Check(committed && [[c valueForKey:@"timelinePreviewing"] boolValue] && fabs(strip.progress - .55) < .01,
        @"an unchanged refresh keeps a hover hold");
    [c previewPopoverMovieFraction:NAN];
    SettleController(c);
}

static void CheckLadderShiftKeepsPlaying(StoreSpyController *c) {
    NSDate *now = [c valueForKey:@"chartNow"];
    // Play from later than the next anchor, as an open map soon does.
    [c startLivePlaybackFromDate:[now dateByAddingTimeInterval:6 * 3600]];
    SettleController(c);
    for (int i = 0; i < 3; i++) TickShown(c);
    NSArray *frames = [c valueForKey:@"frameIndices"];
    IsobarLivePlayer *live = [c valueForKey:@"live"];
    NSDate *playhead = live.playhead;
    NSInteger starts = c.starts, invalidates = c.invalidates;
    NSImage *previous = ShownMap(c);
    [c setChartNow:[now dateByAddingTimeInterval:3 * 3600]];
    [c refreshAll];
    BOOL committed = [c waitForStoreCommit:30];
    Check(committed && ![[c valueForKey:@"frameIndices"] isEqual:frames], @"three hours on, the frame ladder re-anchors");
    Check(c.starts == starts && c.invalidates == invalidates && [c valueForKey:@"live"] == live && live.playing &&
          live.playhead && fabs([live.playhead timeIntervalSinceDate:playhead]) < 1,
        @"a re-anchored ladder keeps the player and the playhead's time");
    double worst = 0;
    for (int i = 0; i < 10; i++) {
        NSImage *frame = TickShown(c);
        worst = MAX(worst, FractionChanged(previous, frame));
        previous = frame;
    }
    Check(worst <= kGlidePixelShare, [NSString stringWithFormat:@"the map glides through a re-anchored ladder (worst tick %.4f)", worst]);
    [c setChartNow:now];
    [c refreshAll];
    [c waitForStoreCommit:30];
    [c startLivePlaybackFromDate:now];
    SettleController(c);
}

static void CheckFailedPublishKeepsLastGoodRun(StoreSpyController *c, NSString *root, NSArray<NSDate *> *runs, NSDate *next) {
    for (int i = 0; i < 40; i++) TickShown(c);
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    NSString *pointerPath = [family stringByAppendingPathComponent:@"current.json"];
    NSData *good = [NSData dataWithContentsOfFile:pointerPath];
    NSString *mslp = [family stringByAppendingFormat:@"/runs/%@/mslp", GridRunID(next)];
    NSString *aside = [family stringByAppendingPathComponent:@"aside"];
    [fm createDirectoryAtPath:aside withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *second = [mslp stringByAppendingPathComponent:GridRunID([next dateByAddingTimeInterval:3 * 3600])];
    NSString *last = [mslp stringByAppendingPathComponent:GridRunID([next dateByAddingTimeInterval:96 * 3600])];
    NSData *secondPayload = [NSData dataWithContentsOfFile:[second stringByAppendingPathExtension:@"f16"]];
    NSArray *newer = @[runs.lastObject, next];
    for (NSString *how in @[@"32 frames", @"payload removed", @"1-byte payload", @"pointer []", @"schema_version 2"]) {
        if ([how isEqual:@"32 frames"]) {
            [fm moveItemAtPath:[last stringByAppendingPathExtension:@"json"] toPath:[aside stringByAppendingPathComponent:@"last.json"] error:nil];
            [fm moveItemAtPath:[last stringByAppendingPathExtension:@"f16"] toPath:[aside stringByAppendingPathComponent:@"last.f16"] error:nil];
            WritePublishedPointer(root, newer);
        } else if ([how isEqual:@"payload removed"]) {
            [fm removeItemAtPath:[second stringByAppendingPathExtension:@"f16"] error:nil];
            WritePublishedPointer(root, newer);
        } else if ([how isEqual:@"1-byte payload"]) {
            [[NSData dataWithBytes:"x" length:1] writeToFile:[second stringByAppendingPathExtension:@"f16"] atomically:YES];
            WritePublishedPointer(root, newer);
        } else if ([how isEqual:@"pointer []"]) {
            [@"[]" writeToFile:pointerPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        } else {
            NSMutableDictionary *pointer = [[NSJSONSerialization JSONObjectWithData:good options:0 error:nil] mutableCopy];
            pointer[@"schema_version"] = @2;
            [[NSJSONSerialization dataWithJSONObject:pointer options:0 error:nil] writeToFile:pointerPath atomically:YES];
        }
        OwnRun *run = [c valueForKey:@"ownRun"];
        NSDate *runDate = [c valueForKey:@"runDate"];
        NSArray *times = [c valueForKey:@"sequenceTimes"], *frames = [c valueForKey:@"frameIndices"];
        IsobarLivePlayer *live = [c valueForKey:@"live"];
        NSInteger invalidates = c.invalidates;
        NSImage *before = ShownMap(c);
        NSSet *mapsBefore = [NSSet setWithArray:[[c valueForKey:@"chartCache"] allKeys]];
        NSDate *previousDate = [c valueForKey:@"previousRunDate"];
        [c reloadStoreAtPath:root];
        NSImage *after = TickShown(c);
        NSView *view = PopoverRoot(c);
        NSString *error = [c valueForKey:@"storeError"];
        NSView *issued = FindView(view, @"popover.issued");
        NSView *warnCue = FindView(issued, @"popover.issued.warn");
        double moved = FractionChanged(before, after);
        Check([c chartsReady] && run && [c valueForKey:@"ownRun"] == run && SameDate([c valueForKey:@"runDate"], runDate) &&
              [[c valueForKey:@"sequenceTimes"] isEqual:times] && [[c valueForKey:@"frameIndices"] isEqual:frames],
            [NSString stringWithFormat:@"%@: the last good run stays loaded", how]);
        Check(c.invalidates == invalidates && live && [c valueForKey:@"live"] == live && live.playing &&
              [[c valueForKey:@"popoverPlaying"] boolValue],
            [NSString stringWithFormat:@"%@: the same player keeps playing", how]);
        Check(warnCue && !warnCue.hidden && [issued.toolTip containsString:@"stale"] &&
              !HasText(view, @"stale") && !HasText(view, @"Chart unavailable") && HasText(view, @"Z"),
            [NSString stringWithFormat:@"%@: the header keeps the run and marks its age", how]);
        Check(error.length && [issued.toolTip containsString:error],
            [NSString stringWithFormat:@"%@: the read error is in the tooltip (%@)", how, error]);
        Check(moved < kGlidePixelShare && !BlankMap(after),
            [NSString stringWithFormat:@"%@: the map on screen does not jump or blank (%.4f, ink %.3f)", how, moved, InkShare(after)]);
        // The kept pair's rendered maps survive, and no other run's are added.
        NSSet *mapsAfter = [NSSet setWithArray:[[c valueForKey:@"chartCache"] allKeys]];
        BOOL keptMaps = mapsBefore.count > 0 && [mapsBefore isSubsetOfSet:mapsAfter];
        for (NSString *key in mapsAfter)
            if (![key hasPrefix:runDate.description] && !(previousDate && [key hasPrefix:previousDate.description])) keptMaps = NO;
        Check(keptMaps, [NSString stringWithFormat:@"%@: only the kept run's maps are cached, all still there (%lu before, %lu after)",
            how, (unsigned long)mapsBefore.count, (unsigned long)mapsAfter.count]);
        if ([how isEqual:@"32 frames"]) {
            [fm moveItemAtPath:[aside stringByAppendingPathComponent:@"last.json"] toPath:[last stringByAppendingPathExtension:@"json"] error:nil];
            [fm moveItemAtPath:[aside stringByAppendingPathComponent:@"last.f16"] toPath:[last stringByAppendingPathExtension:@"f16"] error:nil];
        } else if ([how hasSuffix:@"payload"] || [how hasSuffix:@"removed"]) {
            [secondPayload writeToFile:[second stringByAppendingPathExtension:@"f16"] atomically:YES];
        }
        [good writeToFile:pointerPath atomically:YES];
    }
    NSInteger starts = c.starts;
    WritePublishedPointer(root, newer);
    [c reloadStoreAtPath:root];
    NSView *view = PopoverRoot(c);
    NSView *recovered = FindView(view, @"popover.issued");
    NSView *recoveredWarn = FindView(recovered, @"popover.issued.warn");
    Check(SameDate([c valueForKey:@"runDate"], next) && ![[c valueForKey:@"storeError"] length] &&
          HasText(view, @"Z") && (!recoveredWarn || recoveredWarn.hidden) && !HasText(view, @"stale"),
        @"a complete newer run replaces the kept run and clears the warning");
    Check(c.starts == starts + 1 && SameDate(c.startDates.lastObject, [c valueForKey:@"chartNow"]),
        @"the recovered run plays once, from now");
    SettleController(c);
}

static void CheckNewRunResetIsTheOnlyJump(StoreSpyController *c, NSString *root, NSArray<NSDate *> *runs) {
    for (int i = 0; i < 5; i++) TickShown(c);
    NSInteger starts = c.starts, invalidates = c.invalidates;
    NSImage *previous = ShownMap(c);
    WritePublishedPointer(root, runs);
    [c refreshAll];
    BOOL committed = [c waitForStoreCommit:30];
    Check(committed && SameDate([c valueForKey:@"runDate"], runs.lastObject) && c.starts == starts + 1 &&
          SameDate(c.startDates.lastObject, [c valueForKey:@"chartNow"]) && c.invalidates == invalidates + 1,
        @"a new run restarts playback once, from now");
    NSInteger jumps = 0;
    BOOL blank = NO;
    NSMutableString *trace = [NSMutableString string];
    for (int i = 0; i < 25; i++) {
        NSImage *frame = TickShown(c);
        double moved = FractionChanged(previous, frame);
        [trace appendFormat:@" %.3f/%.3f", moved, InkShare(frame)];
        if (moved > 0.01) jumps++;
        if (BlankMap(frame)) blank = YES;
        previous = frame;
    }
    fprintf(stderr, "new run per-tick change/ink%s\n", trace.UTF8String);
    Check(jumps == 1 && !blank,
        [NSString stringWithFormat:@"a new run is one jump to now, with no blank frame (%ld jumps)", (long)jumps]);
}

static void CheckNewRunWhileHoveringResumes(StoreSpyController *c, NSString *root, NSArray<NSDate *> *runs) {
    TickShown(c);
    [c previewPopoverMovieFraction:.55];
    WaitUntil(^BOOL { return [[c valueForKey:@"scrubRenderer"] renderCount] > 0; }, 2);
    WritePublishedPointer(root, runs);
    [c refreshAll];
    BOOL committed = [c waitForStoreCommit:30];
    [c previewPopoverMovieFraction:NAN];
    SettleController(c);
    IsobarLivePlayer *live = [c valueForKey:@"live"];
    Check(committed && SameDate([c valueForKey:@"runDate"], runs.lastObject) &&
          [[c valueForKey:@"popoverPlaying"] boolValue] && live && live.playing,
        @"a new run that lands during a hover leaves the map playing once the pointer leaves");
}

static double NowMs(void) {
    static mach_timebase_info_data_t base;
    if (!base.denom) mach_timebase_info(&base);
    return (double)mach_absolute_time() * base.numer / base.denom / 1e6;
}

// Wall clock: a 4 ms heartbeat on the main run loop finds the longest gap
// while refreshAll runs, and the spy counts live frames applied.
static void MeasureRefresh(StoreSpyController *c, double *gapOut, double *shareOut) {
    __block double last = NowMs(), gap = 0;
    NSTimer *beat = [NSTimer timerWithTimeInterval:0.004 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        double now = NowMs();
        gap = MAX(gap, now - last);
        last = now;
    }];
    [NSRunLoop.mainRunLoop addTimer:beat forMode:NSRunLoopCommonModes];
    Pump(0.4);
    gap = 0;
    last = NowMs();
    NSInteger applies = c.applies;
    double began = NowMs();
    dispatch_async(dispatch_get_main_queue(), ^{ [c refreshAll]; });
    Pump(1.6);
    double window = NowMs() - began;
    [beat invalidate];
    *gapOut = gap;
    *shareOut = (c.applies - applies) / (window / (kIsobarLiveDisplayTick * 1000.0));
    [c waitForStoreCommit:30];
}

static void CheckRefreshKeepsMapTicking(NSString *base, NSArray<NSDate *> *runs, NSDate *next, NSDate *now) {
    NSString *root = [base stringByAppendingPathComponent:@"ticking"];
    MakePublishedStore(root, runs, 301, 201);
    StoreSpyController *c = StoreSpy(root, now);
    [c useWallLiveClock];
    ShowPlayingPopover(c);
    Pump(1.0);
    double unchangedGap = 0, unchangedShare = 0, newGap = 0, newShare = 0;
    // A busy machine can stall the main thread on its own. The best of three
    // unchanged refreshes still catches a reload that blocks it (180+ ms before).
    for (int attempt = 0; attempt < 3; attempt++) {
        MeasureRefresh(c, &unchangedGap, &unchangedShare);
        if (unchangedGap <= 50 && unchangedShare >= 0.9) break;
    }
    WritePublishedRun(root, next, 301, 201, 33);
    WritePublishedPointer(root, @[runs.lastObject, next]);
    MeasureRefresh(c, &newGap, &newShare);
    fprintf(stderr, "refresh main-thread gap unchanged %.1f ms (%.0f%% of ticks), new run %.1f ms (%.0f%% of ticks)\n",
        unchangedGap, unchangedShare * 100, newGap, newShare * 100);
    if (!IsobarCISlow()) {
        Check(unchangedGap <= 50 && unchangedShare >= 0.9, @"an unchanged refresh keeps the map ticking");
        Check(newGap <= 100 && newShare >= 0.9 && SameDate([c valueForKey:@"runDate"], next),
            @"loading a new run keeps the map ticking");
    } else fprintf(stderr, "refresh stall ceilings skipped (ISOBAR_CI_SLOW)\n");
    [c useManualLiveClock];
    ClosePlayingPopover(c);
}

// A background refresh never changes what the user chose to look at.
static void CheckRefreshKeepsChartChoices(NSString *fixtures, NSString *base, NSDate *now) {
    NSString *root = CopyFixtureStore(fixtures, base, @"bureau");
    NSString *suite = [@"com.isobar.store-reload." stringByAppendingString:NSUUID.UUID.UUIDString];
    PlaybackSuite = [[NSUserDefaults alloc] initWithSuiteName:suite];
    [PlaybackSuite setObject:@"bom" forKey:@"chartSource"];
    PlaybackPrefsController *bureau = [PlaybackPrefsController new];
    bureau.availableSize = NSMakeSize(1440, 900);
    [bureau replaceLocations:DefaultLocations()];
    [bureau setChartNow:now];
    [bureau reloadStoreAtPath:root];
    [bureau setValue:@NO forKey:@"sourceECMWF"];
    [bureau rebuildContent];
    ShownPlaybackPopover *shown = [ShownPlaybackPopover new];
    shown.contentViewController = bureau.popover.contentViewController;
    bureau.popover = shown;
    [bureau popoverDidShow:[NSNotification notificationWithName:NSPopoverDidShowNotification object:shown]];
    [bureau refreshAll];
    BOOL committed = [bureau waitForStoreCommit:30];
    Check(committed && ![[bureau valueForKey:@"sourceECMWF"] boolValue] &&
          [[PlaybackSuite stringForKey:@"chartSource"] isEqual:@"bom"],
        @"a background refresh leaves a shown Bureau map on the Bureau chart, and its saved choice");
    [bureau popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:shown]];
    [PlaybackSuite removePersistentDomainForName:suite];
    PlaybackSuite = nil;

    NSString *legacy = CopyFixtureStore(fixtures, base, @"compare");
    StoreSpyController *c = StoreSpy(legacy, now);
    HiddenMapWindow *window = [[HiddenMapWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 720)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = [[ChartRoot alloc] initWithFrame:NSMakeRect(0, 0, 1280, 720)];
    [c setValue:window forKey:@"chartWindow"];
    [c setValue:@NO forKey:@"forecastPaused"];
    [c presentChartWindowInFrame:NSMakeRect(0, 0, 1280, 720)];
    BOOL played = [[c valueForKey:@"looping"] boolValue];
    [c toggleIssueCompare];
    BOOL comparing = [[c valueForKey:@"comparing"] boolValue];
    // The collector publishes a newer run: 18Z copied as 26T00Z.
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *ecmwf = [legacy stringByAppendingPathComponent:@"ecmwf"];
    NSString *newer = [ecmwf stringByAppendingPathComponent:@"20260926T00Z"];
    [fm copyItemAtPath:[ecmwf stringByAppendingPathComponent:@"20260925T18Z"] toPath:newer error:nil];
    NSString *manifestPath = [newer stringByAppendingPathComponent:@"manifest.json"];
    NSMutableDictionary *manifest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:manifestPath] options:0 error:nil] mutableCopy];
    manifest[@"run"] = @"2026-09-26T00:00:00Z";
    [[NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil] writeToFile:manifestPath atomically:YES];
    [@"{\"run\": \"20260926T00Z\", \"path\": \"20260926T00Z\"}" writeToFile:[ecmwf stringByAppendingPathComponent:@"latest.json"]
        atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSDate *before = [c valueForKey:@"runDate"];
    [c refreshAll];
    committed = [c waitForStoreCommit:30];
    Check(played && comparing && committed && ![[c valueForKey:@"runDate"] isEqual:before] &&
          [[c valueForKey:@"comparing"] boolValue],
        @"a new run leaves an open expanded-map comparison as the user set it");
    [c closeChartWindow];
}

// Run ids are checked before any path is built from them.
static void CheckTraversalPointerStaysInStore(NSString *base, NSString *valid) {
    NSString *coast = [NSString stringWithUTF8String:getenv("ISOBAR_COAST") ?: "Resources/ownchart-coast.bin"];
    NSString *root = [base stringByAppendingPathComponent:@"traversal"];
    NSString *outside = [base stringByAppendingPathComponent:@"outside"];
    NSFileManager *fm = NSFileManager.defaultManager;
    [fm createDirectoryAtPath:outside withIntermediateDirectories:YES attributes:nil error:nil];
    [@"x" writeToFile:[outside stringByAppendingPathComponent:@"file"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [fm createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *escape = @"../../../../../outside";
    [[NSJSONSerialization dataWithJSONObject:@{@"latest": escape, @"runs": @[escape]} options:0 error:nil]
        writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
    Check(StorePublishedRunStamp(valid, NO, coast) != nil && !StorePublishedRunStamp(root, NO, coast) &&
          !StorePublishedRunStamp(root, YES, coast),
        @"a pointer that names no collector run id is never walked");
}

static void CheckStoreReload(NSString *fixtures) {
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    NSDate *r0 = [iso dateFromString:@"2026-09-25T18:00:00Z"], *r1 = [iso dateFromString:@"2026-09-26T00:00:00Z"];
    NSDate *r2 = [iso dateFromString:@"2026-09-26T06:00:00Z"], *r3 = [iso dateFromString:@"2026-09-26T12:00:00Z"];
    NSDate *now = [iso dateFromString:@"2026-09-26T13:30:00Z"];
    NSDate *legacyNow = [iso dateFromString:@"2026-09-26T00:30:00Z"];
    NSString *base = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [@"isobar-store-reload-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    [NSFileManager.defaultManager createDirectoryAtPath:base withIntermediateDirectories:YES attributes:nil error:nil];
    IsobarTestSetReduceMotion(NO);
    @try {
        CheckColdStartFailsClosed(fixtures, base, legacyNow);
        CheckLegacyFailedReloadKeepsLastGood(fixtures, base, legacyNow);
        CheckSurfaceTeardownAndExpandedUnavailable(fixtures, base, legacyNow);
        CheckRefreshKeepsChartChoices(fixtures, base, legacyNow);

        NSString *small = [base stringByAppendingPathComponent:@"small"];
        MakePublishedStore(small, @[r0, r1], 24, 16);
        AddPublishedWeather(small, now);
        NSString *other = [base stringByAppendingPathComponent:@"other"];
        MakePublishedStore(other, @[r1, r2], 24, 16);
        CheckTraversalPointerStaysInStore(base, small);
        CheckSnapshotLoadsOffMainThread(small, now);
        CheckRefreshDoesNotBlockPlayback(small, now);
        CheckSupersededSnapshotIsDropped(small, other, now, r2);

        NSString *global = [base stringByAppendingPathComponent:@"global-positive"];
        WritePublishedGlobalStore(global, r1);
        StoreSpyController *globalController = StoreSpy(global, now);
        OwnRun *globalRun = [globalController valueForKey:@"ownRun"];
        OwnRunGeo globalGeo = globalRun.geo;
        Check([globalController chartsReady] && globalRun.hours == 53 &&
              globalGeo.nLon == 720 && globalGeo.nLat == 361 && globalGeo.wrapsLongitude &&
              [[globalController valueForKey:@"sourceECMWF"] boolValue],
            @"a global-only published archive loads through the controller with its 53-frame world grid");
        [globalController stopPopoverPlayback];

        NSString *big = [base stringByAppendingPathComponent:@"big"];
        MakePublishedStore(big, @[r0, r1], 301, 201);
        WritePublishedRun(big, r2, 301, 201, 33);
        WritePublishedRun(big, r3, 301, 201, 33);
        StoreSpyController *c = StoreSpy(big, now);
        ShowPlayingPopover(c);
        SettleLiveCadence(c);
        CheckUnchangedRefreshKeepsPlaybackSteady(c);
        CheckLadderShiftKeepsPlaying(c);
        CheckFailedPublishKeepsLastGoodRun(c, big, @[r0, r1], r2);
        CheckNewRunResetIsTheOnlyJump(c, big, @[r2, r3]);
        CheckNewRunWhileHoveringResumes(c, big, @[r0, r1]);
        ClosePlayingPopover(c);

        CheckRefreshKeepsMapTicking(base, @[r0, r1], r2, now);
    } @finally {
        StopWatchingStoreLoads();
        IsobarTestRestoreReduceMotion();
        [NSFileManager.defaultManager removeItemAtPath:base error:nil];
    }
}

static void SelectHubPlace(TestController *c, NSString *prefix) {
    NSPopUpButton *places = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"hub.place");
    for (NSMenuItem *item in places.itemArray)
        if ([item.title hasPrefix:prefix]) { [places selectItem:item]; break; }
    [c chooseHubPlace:places];
}

static NSString *FlyBulletinText(TestController *c) {
    NSTextView *text = (NSTextView *)FindView(c.popover.contentViewController.view, @"aviation.bulletin");
    return text.string ?: @"";
}

// Place and airport changes go through the controller's store reload, which
// reads products/aviation/<ICAO>.json for the Fly aerodrome.
static void CheckFlyBulletinFollowsAerodrome(NSString *root) {
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    TestController *c = [TestController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:[iso dateFromString:@"2026-09-26T12:00:00Z"]];
    [c setValue:@YES forKey:@"forecastPaused"];
    [c reloadStoreAtPath:root];
    SeedForecastMode(c, 1);
    [c rebuildContent];
    NSString *perth = FlyBulletinText(c);
    NSPopUpButton *airport = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"aviation.airport");
    Check([airport.titleOfSelectedItem containsString:@"YPPH"] && [perth containsString:@"METAR YPPH"] &&
        [perth containsString:@"TAF YPPH"] && ![perth containsString:@"YSSY"],
        @"Perth coast loads the YPPH METAR and TAF");
    SelectHubPlace(c, @"Sydney");
    Check([c waitForStoreCommit:30], @"Sydney place change finishes loading YSSY");
    SeedForecastMode(c, 1);
    [c rebuildContent];
    NSString *sydney = FlyBulletinText(c);
    airport = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"aviation.airport");
    Check([airport.titleOfSelectedItem containsString:@"YSSY"] && [sydney containsString:@"METAR YSSY"] &&
        [sydney containsString:@"TAF YSSY"] && ![sydney containsString:@"YPPH"],
        @"Sydney loads the YSSY METAR and TAF");
    SelectHubPlace(c, @"Perth");
    Check([c waitForStoreCommit:30], @"returning to Perth reloads YPPH");
    [c pinFlyAerodrome:@"YSSY"];
    Check([c waitForStoreCommit:30], @"pinning YSSY at Perth reloads that station");
    SeedForecastMode(c, 1);
    [c rebuildContent];
    NSString *pinned = FlyBulletinText(c);
    airport = (NSPopUpButton *)FindView(c.popover.contentViewController.view, @"aviation.airport");
    BOOL sydneyText = [pinned containsString:@"METAR YSSY"] && [pinned containsString:@"TAF YSSY"];
    BOOL explicitGap = [pinned containsString:@"No TAF for YSSY yet"] || [pinned containsString:@"METAR for YSSY unavailable"];
    Check([airport.titleOfSelectedItem containsString:@"YSSY"] && (sydneyText || explicitGap) &&
        ![pinned containsString:@"YPPH"] && (sydneyText || ![pinned containsString:@"METAR YPPH"]),
        @"a YSSY pin at Perth shows YSSY, or an explicit gap, and never YPPH");
}

static BOOL SpeedTitleFits(NSPopUpButton *speed) {
    NSString *title = speed.titleOfSelectedItem ?: @"";
    if (!title.length || [title containsString:@"…"]) return NO;
    NSCell *cell = speed.cell;
    NSRect titleRect = [cell titleRectForBounds:speed.bounds];
    NSFont *font = cell.font ?: speed.font ?: [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    CGFloat need = ceil([title sizeWithAttributes:@{NSFontAttributeName: font}].width);
    return need <= NSWidth(titleRect) + 0.5;
}

static void CheckTimelineEndsAtLastFrame(void) {
    NSTimeZone *zone = [NSTimeZone timeZoneWithName:@"GMT"];
    NSDate *start = [NSDate dateWithTimeIntervalSince1970:0];
    NSDate *last = [start dateByAddingTimeInterval:96 * 3600.0];
    NSMutableArray *bands = [NSMutableArray array];
    for (NSInteger day = 0; day < 7; day++)
        [bands addObject:[start dateByAddingTimeInterval:day * 86400.0]];
    TimelineStrip *strip = [TimelineStrip new];
    strip.frame = NSMakeRect(0, 0, 700, 40);
    strip.timeZone = zone;
    strip.now = start;
    strip.times = @[start, last];
    strip.labels = @[@"Start", @"End"];
    strip.bandDates = bands;
    CGFloat end = [strip cursorXForFraction:1];
    NSRect track = [strip trackRect];
    Check(end < NSWidth(strip.bounds) - 40, @"four days of frames leave room past the last frame");
    Check(fabs(NSMaxX(track) - end) < 1.0,
        [NSString stringWithFormat:@"track end %.1f maps to the last frame %.1f", NSMaxX(track), end]);
    NSDate *covered = [start dateByAddingTimeInterval:7 * 86400.0 - 60];
    strip.times = @[start, covered];
    CGFloat full = [strip cursorXForFraction:1];
    Check(fabs(NSMaxX([strip trackRect]) - full) < 1.0 && full > NSWidth(strip.bounds) - 30,
        @"a week of frames fills the track");
}

static void CheckPopoverSpeedAndWarnings(NSString *root) {
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    TestController *c = [TestController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:[iso dateFromString:@"2026-09-26T00:30:00Z"]];
    [c reloadStoreAtPath:root];
    NSDate *runDate = [c valueForKey:@"runDate"];
    Check(runDate != nil, @"speed and warning check has a run");
    if (runDate) [c setChartNow:[runDate dateByAddingTimeInterval:23 * 3600.0]];
    NSString *hash = [c hubPlace][@"geohash"] ?: @"";
    [c noteWeatherForGeohash:hash obs:nil daily:nil hourly:nil warnings:@[
        @{@"shortTitle": @"Marine wind warning", @"title": @"Marine Wind Warning", @"text": @"Damaging winds"}
    ]];
    [c rebuildContent];
    NSView *view = c.popover.contentViewController.view;
    NSPopUpButton *speed = (NSPopUpButton *)FindView(view, @"popover.speed");
    Check([speed isKindOfClass:NSPopUpButton.class] && !speed.hidden, @"popover speed control is on screen");
    if ([speed isKindOfClass:NSPopUpButton.class]) {
        for (NSNumber *multiple in @[@0, @1, @2, @4, @8, @16, @32, @64, @128, @256]) {
            NSString *expect = (multiple.integerValue == 0 ? @"Real time" : [NSString stringWithFormat:@"%@ min/s", multiple]);
            [speed selectItemWithTag:multiple.integerValue];
            BOOL shown = [speed.titleOfSelectedItem isEqual:expect] && SpeedTitleFits(speed);
            Check(shown, [NSString stringWithFormat:@"%@ shows in full", expect]);
        }
    }
    NSView *issued = FindView(view, @"popover.issued");
    NSImageView *age = (NSImageView *)FindView(issued, @"popover.issued.warn");
    NSTextField *ageField = (NSTextField *)FindView(issued, @"popover.issued.age");
    NSButton *bureau = (NSButton *)FindView(view, @"hub.warning");
    Check([age isKindOfClass:NSImageView.class] && !age.hidden, @"old run keeps the age glyph");
    Check([ageField isKindOfClass:NSTextField.class] && [ageField.stringValue containsString:@"h"], @"age readout stays");
    NSColor *ink = [ageField.textColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    NSColor *orange = [NSColor.systemYellowColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    Check(ink && orange && fabs(ink.redComponent - orange.redComponent) < 0.05 &&
        fabs(ink.greenComponent - orange.greenComponent) < 0.05 &&
        fabs(ink.blueComponent - orange.blueComponent) < 0.05, @"old age is amber");
    Check([issued.toolTip containsString:@"stale"], @"age reason stays in the tooltip");
    Check([bureau isKindOfClass:NSButton.class] && !bureau.hidden, @"bureau warning stays in the header");
    Check([bureau.toolTip isEqual:@"Marine Wind Warning"], @"bureau warning tooltip names the warning");
    Check([age.image.name isEqual:@"exclamationmark.triangle.fill"] &&
        [bureau.image.name isEqual:@"exclamationmark.circle"] &&
        ![age.image.accessibilityDescription isEqual:bureau.image.accessibilityDescription],
        @"chart age and the bureau warning are different marks");
    TimelineStrip *timeline = (TimelineStrip *)FindView(view, @"popover.timeline");
    if ([timeline isKindOfClass:TimelineStrip.class] && timeline.times.count >= 2) {
        CGFloat end = [timeline cursorXForFraction:1];
        Check(fabs(NSMaxX(timeline.trackRect) - end) < 1.5, @"popover track end maps to the last frame time");
    } else Check(NO, @"popover timeline is missing");
    [c stopPopoverPlayback];
}

static void WritePopoverShot(NSView *view, NSString *name) {
    NSString *dir = @"build/qa/week";
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    [view layoutSubtreeIfNeeded];
    [view display];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    if (!rep) return;
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *path = [dir stringByAppendingPathComponent:name];
    Check(png.length > 1000 && [png writeToFile:path atomically:YES],
        [NSString stringWithFormat:@"write %@", path]);
}

static void ShootPopover(TestController *c, NSString *stem) {
    NSView *view = PopoverRoot(c);
    TimelineStrip *timeline = (TimelineStrip *)FindView(view, @"popover.timeline");
    if (timeline) {
        timeline.progress = 1;
        [c refreshPopoverClock];
        [timeline setNeedsDisplay:YES];
    }
    for (NSArray *pair in @[@[NSAppearanceNameAqua, @"light"], @[NSAppearanceNameDarkAqua, @"dark"]]) {
        view.appearance = [NSAppearance appearanceNamed:pair[0]];
        WritePopoverShot(view, [NSString stringWithFormat:@"%@-%@.png", stem, pair[1]]);
    }
}

// Schema 2 store: 3 h through 144 h, then 6 h through 168 h. Pressure drifts
// steadily with lead time so a 6 h gap must not jump harder than a 3 h gap.
static void WriteWeekRun(NSString *root, NSDate *run, int nx, int ny) {
    NSMutableArray<NSNumber *> *leads = [NSMutableArray array];
    for (int lead = 0; lead <= 144; lead += 3) [leads addObject:@(lead)];
    for (int lead = 150; lead <= 168; lead += 6) [leads addObject:@(lead)];
    NSArray *vars = @[@[@"mslp", @"msl", @"hPa"], @[@"t850", @"t", @"degC"], @[@"t2m", @"2t", @"degC"],
        @[@"u10", @"10u", @"m/s"], @[@"v10", @"10v", @"m/s"], @[@"tp", @"tp", @"mm"]];
    NSFileManager *fm = NSFileManager.defaultManager;
    size_t points = (size_t)nx * (size_t)ny;
    NSMutableData *payload = [NSMutableData dataWithLength:points * 2];
    NSString *runID = GridRunID(run);
    for (NSArray *variable in vars) {
        NSString *dir = [root stringByAppendingFormat:@"/products/grids/ecmwf_ifs025/runs/%@/%@", runID, variable[0]];
        [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        BOOL pressure = [variable[0] isEqual:@"mslp"];
        BOOL rain = [variable[0] isEqual:@"tp"];
        for (NSNumber *boxed in leads) {
            int lead = boxed.intValue;
            NSDate *valid = [run dateByAddingTimeInterval:lead * 3600.0];
            uint8_t *bytes = payload.mutableBytes;
            for (size_t i = 0; i < points; i++) {
                float value = rain ? (float)lead : 12;
                if (pressure) {
                    double u = (double)(i % (size_t)nx) / nx;
                    // One wave across the grid stays inside 996–1028 hPa, so the
                    // contour survives the chart's smoother, and it travels at
                    // one speed on both sides of 144 h.
                    value = (float)(1012 + 16 * sin(2 * M_PI * u + 0.8 * lead));
                }
                uint16_t half = HalfFloat(value);
                bytes[2 * i] = (uint8_t)(half & 255);
                bytes[2 * i + 1] = (uint8_t)(half >> 8);
            }
            NSString *stem = [dir stringByAppendingPathComponent:GridRunID(valid)];
            [payload writeToFile:[stem stringByAppendingPathExtension:@"f16"] atomically:YES];
            NSDictionary *side = @{@"lat0": @0, @"lon0": @95, @"dlat": @-0.25, @"dlon": @0.25,
                @"ny": @(ny), @"nx": @(nx), @"units": variable[2],
                @"run": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"valid_time": GridStamp(valid, @"yyyy-MM-dd'T'HH:mm:ss'Z'"),
                @"model": @"ecmwf-ifs-0p25-open-data", @"fill": @-32768, @"lead_hours": @(lead),
                @"order": @"north-to-south, west-to-east", @"dtype": @"float16", @"endian": @"little",
                @"param": variable[1]};
            [[NSJSONSerialization dataWithJSONObject:side options:0 error:nil]
                writeToFile:[stem stringByAppendingPathExtension:@"json"] atomically:YES];
        }
    }
    NSDictionary *manifest = @{@"schema_version": @2, @"schema": @2, @"contract": @"isobar-data",
        @"family": @"grids/ecmwf_ifs025", @"forecast_hours": leads, @"horizon_hours": @168,
        @"uniform_step_hours": NSNull.null, @"run": GridStamp(run, @"yyyy-MM-dd'T'HH:mm:ss'Z'")};
    NSString *runDir = [root stringByAppendingFormat:@"/products/grids/ecmwf_ifs025/runs/%@", runID];
    [[NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil]
        writeToFile:[runDir stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
}

static void WriteWeekPointer(NSString *root, NSDate *run) {
    NSMutableArray *hours = [NSMutableArray array];
    for (int lead = 0; lead <= 144; lead += 3) [hours addObject:@(lead)];
    for (int lead = 150; lead <= 168; lead += 6) [hours addObject:@(lead)];
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    [NSFileManager.defaultManager createDirectoryAtPath:family withIntermediateDirectories:YES attributes:nil error:nil];
    NSDictionary *pointer = @{@"latest": GridRunID(run), @"runs": @[GridRunID(run)],
        @"schema_version": @2, @"contract": @"isobar-data", @"family": @"grids/ecmwf_ifs025",
        @"forecast_hours": hours, @"horizon_hours": @168, @"uniform_step_hours": NSNull.null};
    [[NSJSONSerialization dataWithJSONObject:pointer options:0 error:nil]
        writeToFile:[family stringByAppendingPathComponent:@"current.json"] atomically:YES];
}

static void AddWeekDays(NSString *root, NSDate *now) {
    AddPublishedWeather(root, now);
    NSString *path = [root stringByAppendingPathComponent:@"products/points/ecmwf_ifs/runs/run1/perth.json"];
    NSMutableDictionary *point = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:NSJSONReadingMutableContainers error:nil] mutableCopy];
    NSMutableArray *dates = [NSMutableArray array], *mins = [NSMutableArray array], *maxs = [NSMutableArray array];
    for (int day = 0; day < 8; day++) {
        NSDate *date = [now dateByAddingTimeInterval:day * 86400.0];
        [dates addObject:[GridStamp(date, @"yyyy-MM-dd'T'HH:mm:ss'Z'") substringToIndex:10]];
        [mins addObject:@(14 + day)];
        [maxs addObject:@(22 + day)];
    }
    point[@"timezone"] = @"Australia/Perth";
    point[@"daily"] = @{@"time": dates, @"temperature_2m_min": mins, @"temperature_2m_max": maxs,
        @"precipitation_sum": @[@0, @0, @0, @0, @0, @1, @0, @0]};
    [[NSJSONSerialization dataWithJSONObject:point options:0 error:nil] writeToFile:path atomically:YES];
}

static NSInteger RunLeadIndex(OwnRun *run, NSDate *issued, int lead) {
    NSDate *when = [issued dateByAddingTimeInterval:lead * 3600.0];
    for (NSInteger i = 0; i < run.hours; i++) {
        NSDate *time = [run timeAtIndex:i];
        if (time && fabs([time timeIntervalSinceDate:when]) < 1) return i;
    }
    return -1;
}

static void CheckWeekGrid(void) {
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [@"isobar-week-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    NSDate *issued = [iso dateFromString:@"2026-10-06T00:00:00Z"];
    NSDate *now = [iso dateFromString:@"2026-10-06T18:00:00Z"];
    @try {
        // West is fixed at 95°. This span reaches the chart's northwest so the
        // traveling isobars are on screen.
        WriteWeekRun(root, issued, 140, 90);
        WriteWeekPointer(root, issued);
        AddWeekDays(root, now);
        WriteStatus(root, YES);
        StoreSpyController *c = StoreSpy(root, now);
        OwnRun *run = [c valueForKey:@"ownRun"];
        NSArray *times = [c valueForKey:@"sequenceTimes"];
        Check(run.hours == 53 && times.count >= 2, [NSString stringWithFormat:@"schema 2 controller loads 53 frames (%ld)", (long)run.hours]);
        if (run.hours != 53 || times.count < 2) return;
        Check(fabs([times.firstObject timeIntervalSinceDate:issued] - 18 * 3600) < 1 &&
              fabs([times.lastObject timeIntervalSinceDate:issued] - 168 * 3600) < 1,
            @"the track runs from the frame at now through the last listed hour");
        double at144 = [c liveModelIndexForDate:[issued dateByAddingTimeInterval:144 * 3600]];
        double at147 = [c liveModelIndexForDate:[issued dateByAddingTimeInterval:147 * 3600]];
        double at150 = [c liveModelIndexForDate:[issued dateByAddingTimeInterval:150 * 3600]];
        Check(fabs(at150 - at144 - 1) < 0.02 && fabs(at147 - (at144 + at150) / 2) < 0.02,
            [NSString stringWithFormat:@"147 h is halfway between the 144 h and 150 h frames (%.3f %.3f %.3f)", at144, at147, at150]);
        NSInteger rainIndex = RunLeadIndex(run, issued, 150);
        double rain = [run valueAtPointIndex:0 field:OwnRunFieldRain hour:rainIndex];
        Check(rainIndex >= 0 && fabs(rain - 24) < 0.25,
            [NSString stringWithFormat:@"150 h rain is the 126 h lead, 24 mm (%.2f)", rain]);
        IsobarLivePlayer *rate = [IsobarLivePlayer new];
        rate.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed8x);
        [rate configureRun:run start:times.firstObject end:times.lastObject now:now
            modelIndex:^double(NSDate *date) { return [c liveModelIndexForDate:date]; }];
        Check(fabs(rate.hoursPerSecond - 8.0 / 60.0) < 1e-9, @"8 min/s playback keeps its existing physical rate");
        NSView *view = PopoverRoot(c);
        [view layoutSubtreeIfNeeded];
        TimelineStrip *timeline = (TimelineStrip *)FindView(view, @"popover.timeline");
        NSArray<NSDate *> *ticks = timeline.tickDates;
        NSArray<NSNumber *> *xs = [timeline tickXs];
        double x141 = NAN, x144 = NAN, x150 = NAN;
        Check(ticks.count == xs.count && ticks.count > 10, @"ticks are the listed frames inside the track");
        for (NSUInteger i = 0; i < ticks.count && i < xs.count; i++) {
            double lead = [ticks[i] timeIntervalSinceDate:issued] / 3600.0;
            if (fabs(lead - 141) < 0.1) x141 = xs[i].doubleValue;
            if (fabs(lead - 144) < 0.1) x144 = xs[i].doubleValue;
            if (fabs(lead - 150) < 0.1) x150 = xs[i].doubleValue;
        }
        double gap3 = x144 - x141, gap6 = x150 - x144;
        Check(gap3 > 1 && fabs(gap6 / gap3 - 2) < 0.2,
            [NSString stringWithFormat:@"a 6 h step is twice a 3 h step on the same day (%.1f vs %.1f)", gap6, gap3]);
        NSUInteger tiles = 0;
        while (FindView(view, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)tiles])) tiles++;
        Check(tiles == 7 && timeline.daySpanCount == tiles, @"day bands match the seven day tiles");
        BOOL aligned = tiles == timeline.daySpanCount;
        for (NSUInteger i = 0; i < tiles && aligned; i++) {
            NSView *tile = FindView(view, [NSString stringWithFormat:@"hub.day.%lu", (unsigned long)i]);
            NSRect tileRect = [tile convertRect:tile.bounds toView:view];
            NSRect span = [timeline convertRect:[timeline daySpanFrameAtIndex:i] toView:view];
            if (fabs(NSMinX(tileRect) - NSMinX(span)) > 2 || fabs(NSMaxX(tileRect) - NSMaxX(span)) > 2) aligned = NO;
        }
        Check(aligned, @"each day band shares its tile's x range");
        NSRect lastBand = [timeline daySpanFrameAtIndex:timeline.daySpanCount - 1];
        CGFloat endX = [timeline cursorXForFraction:1];
        Check(NSMaxX(lastBand) - endX > 4, [NSString stringWithFormat:@"the track ends at the last frame and leaves the rest of the last day grey (%.1f px)", NSMaxX(lastBand) - endX]);
        ShootPopover(c, @"schema2");

        OwnRun *kept = run;
        NSString *frame168 = [root stringByAppendingFormat:@"/products/grids/ecmwf_ifs025/runs/%@/mslp/%@",
            GridRunID(issued), GridRunID([issued dateByAddingTimeInterval:168 * 3600])];
        NSString *aside = [root stringByAppendingPathComponent:@"aside-168.f16"];
        [NSFileManager.defaultManager moveItemAtPath:[frame168 stringByAppendingPathExtension:@"f16"] toPath:aside error:nil];
        [c reloadStoreAtPath:root];
        Check([c chartsReady] && [c valueForKey:@"ownRun"] == kept && [[c valueForKey:@"storeError"] length],
            @"a missing listed hour keeps the last good chart");
        [NSFileManager.defaultManager moveItemAtPath:aside toPath:[frame168 stringByAppendingPathExtension:@"f16"] error:nil];
        NSString *pointerPath = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/current.json"];
        NSData *goodPointer = [NSData dataWithContentsOfFile:pointerPath];
        NSMutableDictionary *broken = [[NSJSONSerialization JSONObjectWithData:goodPointer options:NSJSONReadingMutableContainers error:nil] mutableCopy];
        broken[@"schema_version"] = @3;
        [[NSJSONSerialization dataWithJSONObject:broken options:0 error:nil] writeToFile:pointerPath atomically:YES];
        [c reloadStoreAtPath:root];
        Check([c chartsReady] && [c valueForKey:@"ownRun"] == kept &&
              [[[c valueForKey:@"storeError"] description] containsString:@"unsupported contract"],
            @"schema 3 keeps the last good chart");
        [goodPointer writeToFile:pointerPath atomically:YES];

        OwnLayerOptions layers = {0};
        layers.bare = 1;
        layers.quiet = 1;
        NSMutableArray<NSImage *> *frames = [NSMutableArray array];
        double sum3 = 0, sum6 = 0, cross = 0;
        int n3 = 0, n6 = 0;
        NSImage *previous = nil;
        double previousLead = 0;
        for (double lead = 141; lead <= 153.01; lead += 0.5) { @autoreleasepool {
            NSDate *when = [issued dateByAddingTimeInterval:lead * 3600.0];
            NSImage *image = OwnRunRenderFraction(run, [c liveModelIndexForDate:when], @"", layers, nil, 1);
            if (!image) continue;
            if (previous) {
                double changed = FractionChanged(previous, image);
                if (previousLead < 144 && lead <= 144) { sum3 += changed; n3++; }
                else if (previousLead >= 144 && lead <= 150) { sum6 += changed; n6++; }
                // Samples land on 144 h, so the step into the 6 h gap is 144 → 144.5.
                if (previousLead <= 144 && lead > 144) cross = changed;
            }
            previous = image;
            previousLead = lead;
            [frames addObject:image];
        }}
        double mean3 = n3 ? sum3 / n3 : 0, mean6 = n6 ? sum6 / n6 : 0;
        fprintf(stderr, "step boundary change 3h %.4f (%d) 6h %.4f (%d) cross %.4f\n", mean3, n3, mean6, n6, cross);
        Check(n3 >= 4 && n6 >= 8 && mean3 > 0.0005 && mean6 < mean3 * 2.2 && mean6 > mean3 * 0.4
              && cross > mean3 * 0.4 && cross < mean3 * 3,
            @"the 144 h to 150 h step moves like the 3 h steps around it");
        NSString *dir = @"build/qa";
        [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        BOOL movie = frames.count >= 20 && WritePlaybackMovie(frames, [dir stringByAppendingPathComponent:@"step-boundary.mov"]);
        [@"12\n" writeToFile:[dir stringByAppendingPathComponent:@"step-boundary.hours"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        Check(movie, @"the 144–150 h step is recorded for the jank score");
        [c stopPopoverPlayback];

        NSString *liveRoot = [NSHomeDirectory() stringByAppendingPathComponent:@"Data/isobar"];
        NSString *livePointer = [liveRoot stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/current.json"];
        if ([[NSFileManager defaultManager] fileExistsAtPath:livePointer]) {
            TestController *live = [TestController new];
            live.availableSize = NSMakeSize(1440, 900);
            [live replaceLocations:DefaultLocations()];
            [live setChartNow:[NSDate date]];
            [live reloadStoreAtPath:liveRoot];
            [live rebuildContent];
            OwnRun *liveRun = [live valueForKey:@"ownRun"];
            fprintf(stderr, "live store hours %ld ready %d\n", (long)liveRun.hours, [live chartsReady]);
            if ([live chartsReady]) ShootPopover(live, @"schema1");
            [live stopPopoverPlayback];
        } else fprintf(stderr, "live store absent; schema 1 popover shot skipped\n");
    } @finally {
        [NSFileManager.defaultManager removeItemAtPath:root error:nil];
    }
}

static void CheckHazardControls(NSString *root) {
    TestController *c = [TestController new];
    c.availableSize = NSMakeSize(1440, 900);
    [c useManualLiveClock];
    [c replaceLocations:DefaultLocations()];
    [c setChartNow:[[NSISO8601DateFormatter new] dateFromString:@"2026-09-26T00:30:00Z"]];
    [c reloadStoreAtPath:root];
    [c setValue:@YES forKey:@"newMap"];
    [c rebuildContent];
    NSButton *(^toggle)(void) = ^{
        return (NSButton *)FindView(c.popover.contentViewController.view, @"popover.hazards");
    };
    Check(toggle() && toggle().enabled && !c.hazardLayer && toggle().state == NSControlStateValueOff,
        @"Pressure starts with an enabled Hazards toggle off");
    Check([toggle().toolTip isEqual:@"CB potential (model) · SIGMETs (official)"] &&
        [toggle().accessibilityLabel isEqual:@"Hazards"] && toggle().image,
        @"Hazards has its source tooltip, symbol and accessible name");
    for (NSNumber *mode in @[@1, @2, @0, @3, @4, @5, @-1, @1]) {
        ClickLens(c, mode.integerValue);
        BOOL expected = mode.integerValue == 1;
        GPUMapView *gpu = [c valueForKey:@"gpuMap"];
        Check(c.hazardLayer == expected && (!gpu || gpu.hazards == expected) &&
            (toggle().state == NSControlStateValueOn) == expected,
            [NSString stringWithFormat:@"hazards follow lens %ld before a manual choice", (long)mode.integerValue]);
    }
    ShootPopover(c, @"hazards-fly-wide");
    c.availableSize = NSMakeSize(640, 600); [c rebuildContent];
    ShootPopover(c, @"hazards-fly-narrow");
    c.availableSize = NSMakeSize(1440, 900); [c rebuildContent];
    [c closeForecast:nil];
    Check(!c.hazardLayer, @"closing Fly restores the Pressure hazard default");
    ClickLens(c, 1);
    NSMenuItem *temperature = [NSMenuItem new]; temperature.tag = 2;
    [c chooseTemperatureField:temperature];
    Check(!c.hazardLayer, @"Temp's menu also leaves the Fly hazard default");
    ClickLens(c, 1);
    [toggle() performClick:nil];
    Check(!c.hazardLayer, @"Fly hazards can be manually turned off");
    ClickLens(c, -1); ClickLens(c, 1);
    [c reloadStoreAtPath:root]; [c rebuildContent];
    Check(!c.hazardLayer && toggle().state == NSControlStateValueOff,
        @"manual off survives lens changes and a store refresh");
    ClickLens(c, -1);
    [toggle() performClick:nil];
    [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:c.popover]];
    [c rebuildContent];
    Check(c.hazardLayer && toggle().state == NSControlStateValueOn,
        @"manual on in Pressure survives closing and rebuilding the popover");
    NSView *expanded = [[ChartRoot alloc] initWithFrame:NSMakeRect(0, 0, 1440, 36)];
    [c layoutStatusBar:nil bar:(MSLPRect){0, 0, 1440, 36} in:expanded];
    NSButton *full = (NSButton *)FindView(expanded, @"fullscreen.hazards");
    Check(full && full.enabled && full.state == NSControlStateValueOn && [full.title isEqual:@"Hazards"],
        @"expanded lens row shares the session choice and full label");
    for (NSArray *look in @[@[NSAppearanceNameAqua, @"light"], @[NSAppearanceNameDarkAqua, @"dark"]]) {
        expanded.appearance = [NSAppearance appearanceNamed:look[0]];
        WritePopoverShot(expanded, [NSString stringWithFormat:@"hazards-expanded-wide-%@.png", look[1]]);
    }
    [full performClick:nil];
    Check(!c.hazardLayer && toggle().state == NSControlStateValueOff && full.state == NSControlStateValueOff,
        @"expanded hazard action updates both surfaces in place");
    ClickLens(c, 1);
    Check(!c.hazardLayer, @"expanded manual off still holds on Fly");
    c.availableSize = NSMakeSize(640, 600); [c rebuildContent];
    NSView *row = FindView(c.popover.contentViewController.view, @"popover.lensRow");
    Check([row.identifier isEqual:@"symbols"] && toggle().title.length == 0 &&
        [LensControl(c) labelForSegment:6].length == 0 && NSContainsRect(row.superview.bounds, row.frame) &&
        NSContainsRect(row.bounds, toggle().frame), @"narrow popover keeps one symbol-only lens row without clipping");
    for (NSNumber *labels in @[@YES, @NO]) {
        NSView *testRow = [c lensControlsWithIdentifier:@"test" height:28 labels:labels.boolValue];
        NSButton *hazard = (NSButton *)FindView(testRow, @"test.hazards");
        NSButton *barbs = (NSButton *)FindView(testRow, @"test.barbs");
        Check(NSMinX(hazard.frame) > NSMaxX(barbs.frame) &&
            NSContainsRect(testRow.bounds, hazard.frame) && ![hazard.title containsString:@"…"] &&
            (!labels.boolValue || NSWidth(hazard.frame) >= hazard.intrinsicContentSize.width),
            @"Hazards ends the row and fits its complete title or symbol");
    }
    expanded.frame = NSMakeRect(0, 0, 640, 36);
    [c layoutStatusBar:nil bar:(MSLPRect){0, 0, 640, 36} in:expanded];
    row = FindView(expanded, @"fullscreen.lensRow");
    full = (NSButton *)FindView(row, @"fullscreen.hazards");
    // Labels stay when the whole row fits (the GPU map has no Barbs button);
    // otherwise the row drops to symbols. Either way nothing is cut off.
    Check(NSContainsRect(NSInsetRect(expanded.bounds, 12, 0), row.frame) &&
        ([row.identifier isEqual:@"symbols"] ? full.title.length == 0 : [row.identifier isEqual:@"labels"]) &&
        ![full.title containsString:@"…"], @"narrow expanded lens row fits without truncation");
    for (NSArray *look in @[@[NSAppearanceNameAqua, @"light"], @[NSAppearanceNameDarkAqua, @"dark"]]) {
        expanded.appearance = [NSAppearance appearanceNamed:look[0]];
        WritePopoverShot(expanded, [NSString stringWithFormat:@"hazards-expanded-narrow-%@.png", look[1]]);
    }
    [c setValue:@NO forKey:@"newMap"]; [c rebuildContent];
    Check(!toggle().enabled, @"classic map disables the GPU-only hazard control");
    TestController *fresh = [TestController new];
    Check(!fresh.hazardLayer, @"a fresh session starts with hazards off on Pressure");
    [c stopPopoverPlayback];
    [[c valueForKey:@"gpuMap"] stopRendering];
}

static void TestFieldLegends(void) {
    for (NSString *appearance in @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) {
        for (NSNumber *flat in @[@NO, @YES]) for (NSNumber *width in @[@120, @240, @300]) {
            for (int field = 0; field < 5; field++) {
                ChartKeyView *key = [ChartKeyView new];
                key.appearance = [NSAppearance appearanceNamed:appearance];
                key.temperature = field < 2 ? field + 1 : 0;
                key.windFill = field == 2; key.showsRain = field >= 3;
                key.rainUnavailable = field == 4;
                key.flat = flat.boolValue; key.mapOverlay = YES; key.maxWidth = width.doubleValue;
                [key rebuild];
                NSString *expected = field == 0 ? @"Temp 850 · °C" : field == 1 ? @"Temp · °C" :
                    field == 2 ? @"Wind · kt" : @"Rain 24 h · mm";
                Check(HasText(key, expected), [@"visible legend includes name and unit: " stringByAppendingString:expected]);
                for (NSTextField *label in key.subviews) {
                    Check(NSContainsRect(key.bounds, label.frame), @"legend label stays inside its viewport");
                    CGFloat textWidth = [label.stringValue sizeWithAttributes:@{NSFontAttributeName:label.font}].width;
                    Check(textWidth <= NSWidth(label.frame) + .5, @"legend text is not truncated");
                    for (NSView *other in key.subviews) if (label != other)
                        Check(!NSIntersectsRect(label.frame, other.frame), @"legend name and ticks do not overlap");
                }
            }
        }
    }
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        TestFieldLegends();
        if (getenv("ISOBAR_TEST_FIELD_LEGENDS_ONLY")) return failures ? 1 : 0;
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
            if (getenv("ISOBAR_TEST_TIMELENS_ONLY")) {
                CheckTimeLens(root);
                fprintf(stderr, "time lens failures: %d\n", failures);
                return failures ? 1 : 0;
            }
            if (getenv("ISOBAR_TEST_HEADER")) {
                CheckTimelineEndsAtLastFrame();
                CheckPopoverSpeedAndWarnings(root);
                CheckTimeLens(root);
                fprintf(stderr, "header failures: %d\n", failures);
                return failures ? 1 : 0;
            }
            if (getenv("ISOBAR_TEST_HAZARD_CONTROLS")) {
                CheckHazardControls(root);
                fprintf(stderr, "hazard controls failures: %d\n", failures);
                return failures ? 1 : 0;
            }
            CheckTimelineEndsAtLastFrame();
            CheckPopoverSpeedAndWarnings(root);
            CheckFlyBulletinFollowsAerodrome(root);
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
                [layers setValue:@NO forKey:@"newMap"];
                [layers replaceLocations:DefaultLocations()]; [layers setChartNow:[iso dateFromString:@"2026-09-26T00:30:00Z"]];
                [layers reloadStoreAtPath:root]; [layers setValue:@NO forKey:@"sourceECMWF"]; [layers rebuildContent];
                ClickLens(layers, 4);
                PDFCropView *map=(PDFCropView *)FindView(layers.popover.contentViewController.view,@"popover.chart");
                Check(map.handlesGestures && !map.enclosingScrollView,
                    @"the classic popover chart owns its bounded gesture viewport");
                NSDate *gestureClock = [layers selectedForecastDate];
                Check(map.onClick == nil, @"fallback map does not wire click-to-Now");
                NSImage *liveFrame = [[NSImage alloc] initWithSize:NSMakeSize(8, 8)];
                [map setLiveFrames:liveFrame next:liveFrame opacity:0.5];
                FallbackGestureEvent *pinch = [FallbackGestureEvent new];
                NSPoint mapPoint = NSMakePoint(NSMidX(map.bounds), NSMidY(map.bounds));
                NSView *gestureRoot = layers.popover.contentViewController.view;
                NSPoint rootPoint = [map convertPoint:mapPoint toView:gestureRoot];
                NSView *gestureTarget = [gestureRoot hitTest:rootPoint];
                Check(gestureTarget == map && MapHandlesCameraGestureAtPoint(gestureRoot, rootPoint),
                    @"the assembled fallback map receives camera gestures through hit testing");
                pinch.gestureLocation = [map convertPoint:mapPoint toView:nil];
                pinch.gestureMagnification = 1.0;
                pinch.gesturePhase = NSEventPhaseChanged;
                [gestureTarget magnifyWithEvent:pinch];
                CALayer *liveLayer = [map valueForKey:@"_liveBase"];
                Check(liveLayer && liveLayer.affineTransform.a > 1.9 &&
                      SameDate([layers selectedForecastDate], gestureClock),
                    @"popover pinch routes to the live fallback layers without moving the clock");
                CGPoint samplePoint = CGPointMake(40, 30);
                CGPoint expectedPoint = CGPointApplyAffineTransform(samplePoint, liveLayer.affineTransform);
                CGPoint shownPoint = [liveLayer convertPoint:samplePoint toLayer:map.layer];
                Check(hypot(shownPoint.x - expectedPoint.x, shownPoint.y - expectedPoint.y) < 0.01,
                    @"live zoom uses the same top-left anchor as bitmap drawing");
                [map setLiveFrames:liveFrame next:liveFrame opacity:0.7];
                shownPoint = [liveLayer convertPoint:samplePoint toLayer:map.layer];
                Check(hypot(shownPoint.x - expectedPoint.x, shownPoint.y - expectedPoint.y) < 0.01 &&
                      NSEqualSizes(liveLayer.bounds.size, map.bounds.size),
                    @"advancing a live frame preserves zoom, pan and backing bounds");
                FallbackGestureEvent *pan = [FallbackGestureEvent new];
                pan.gestureLocation = pinch.gestureLocation;
                pan.gestureDX = 10000; pan.gestureDY = 25; pan.gesturePrecise = YES;
                [map scrollWheel:pan];
                Check(liveLayer.affineTransform.tx <= 1e-6 && liveLayer.affineTransform.tx >= NSWidth(map.bounds) * -3.0 - 1e-6 &&
                      liveLayer.affineTransform.ty <= 1e-6 && liveLayer.affineTransform.ty >= NSHeight(map.bounds) * -3.0 - 1e-6 &&
                      liveLayer.affineTransform.a > 2 && SameDate([layers selectedForecastDate], gestureClock),
                    @"popover two-finger scroll zooms within bounds without changing forecast time");
                [map mouseDown:pinch];
                pinch.gestureLocation = NSMakePoint(pinch.gestureLocation.x - 35, pinch.gestureLocation.y - 20);
                [map mouseDragged:pinch];
                [map mouseUp:pinch];
                Check(SameDate([layers selectedForecastDate], gestureClock), @"dragging the fallback map holds forecast time");
                [map mouseDown:pinch];
                [map mouseUp:pinch];
                Check(SameDate([layers selectedForecastDate], gestureClock), @"a fallback map click preserves forecast time");
                Check(map.mapDetails.count==0 && [[layers valueForKey:@"sourceECMWF"] boolValue] && [layers mapField] == 3,
                    @"Temp switches to its model field and opens beside the map without adding a chip");
                Check(FindView(layers.popover.contentViewController.view,@"popover.temperature")!=nil,@"Temperature graph is available");
                NSView *row=FindView(layers.popover.contentViewController.view,@"popover.lensRow");
                NSSegmentedControl *field=(NSSegmentedControl *)FindView(row,@"popover.lens");
                Check(row && ![row isKindOfClass:NSPopUpButton.class] && [field isKindOfClass:NSSegmentedControl.class] &&
                    field.segmentCount==7 && FindView(row,@"popover.barbs"),
                    @"the map row has one lens control and a barb toggle, no Layers menu");
                [layers toggleMapDetail:2]; [layers toggleMapDetail:4];
                NSDate *future=[NSDate dateWithTimeIntervalSince1970:2000000000];
                NSArray *missing=[layers mapDetailsAtTime:future];
                Check(missing.count==2 && [missing[0][@"value"] isEqual:@"—"] && [missing[1][@"value"] isEqual:@"—"],@"uncovered future map never borrows a current reading");
                [layers toggleMapDetail:2]; [layers toggleMapDetail:4];
                [layers setValue:@YES forKey:@"sourceECMWF"]; [layers setValue:@2 forKey:@"tempLayer"]; [layers rebuildContent];
                field=(NSSegmentedControl *)FindView(layers.popover.contentViewController.view,@"popover.lens");
                Check(field.selectedSegment>=0 && [field tagForSegment:field.selectedSegment] == 4,@"the Temp lens shows the temperature field");
                field.selectedSegment=0; [NSApp sendAction:field.action to:field.target from:field];
                Check(![[layers valueForKey:@"rainLayer"] boolValue] && ![[layers valueForKey:@"windFill"] boolValue] &&
                    [[layers valueForKey:@"tempLayer"] integerValue]==0 && [[layers valueForKey:@"forecastMode"] integerValue] == -1 &&
                    field.selectedSegment == 0,@"Pressure clears the colour field and panel");
                [layers stopPopoverPlayback];
            }
            NSView *view = c.popover.contentViewController.view;
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1 &&
                  !FindView(view, @"popover.rain") && !FindView(view, @"popover.windForecast") &&
                  !FindView(view, @"popover.aviation") && MapsLeadDetails(view),
                @"the default popover is map-first with forecast details closed");
            DayStripView *days = (DayStripView *)FindView(view, @"hub.days");
            NSPopUpButton *hubPlace = (NSPopUpButton *)FindView(view, @"hub.place");
            Check(days && days.days.count == 7 && FindView(view, @"hub.day.0") &&
                  [[days accessibilityLabelForDay:0] containsString:@"Today"] &&
                  hubPlace.numberOfItems >= 2 && [hubPlace.titleOfSelectedItem containsString:@"Perth"],
                @"the hub shows a seven-day strip for the selected place");
            NSView *dry = FindView(view, @"hub.day.0");
            NSView *wet = FindView(view, @"hub.day.5");
            NSUInteger dryInk = BlueInk(dry), wetInk = BlueInk(wet);
            fprintf(stderr, "blue ink dry %lu wet %lu\n", (unsigned long)dryInk, (unsigned long)wetInk);
            Check(dry && wet && wetInk > dryInk + 12,
                @"a day with at least a millimetre of rain draws that amount in the strip");
            Check([[c valueForKey:@"mapDetailModes"] count] == 0, @"lenses are closed chips on a fresh popover");
            NSButton *day = (NSButton *)FindView(view, @"hub.day.1");
            [day performClick:nil];
            view = c.popover.contentViewController.view;
            TimelineStrip *afterDay = (TimelineStrip *)FindView(view, @"popover.timeline");
            NSArray *week = [c packFor:[c hubPlace]][@"daily"];
            NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
            calendar.timeZone = [c placeZone];
            NSDate *noon = [calendar dateBySettingHour:12 minute:0 second:0 ofDate:week[1][@"date"] options:0];
            NSArray *sequence = [c valueForKey:@"sequenceTimes"];
            double span = [sequence.lastObject timeIntervalSinceDate:sequence.firstObject];
            double expected = span > 0 ? MIN(1, MAX(0, [noon timeIntervalSinceDate:sequence.firstObject] / span)) : 0;
            Check([[c valueForKey:@"hubDayIndex"] integerValue] == 1 && FindView(view, @"hub.hourly") &&
                  afterDay && fabs(afterDay.progress - expected) < 0.02,
                @"choosing a day seeks local midday and shows that day's hours");
            NSString *hubSuite = [@"com.isobar.hub-test." stringByAppendingString:NSUUID.UUID.UUIDString];
            HubDefaults = [[NSUserDefaults alloc] initWithSuiteName:hubSuite];
            [HubDefaults setObject:@[@2, @0] forKey:@"mapDetailModes"];
            HubDefaultsController *fresh = [HubDefaultsController new];
            fresh.availableSize = NSMakeSize(1024, 600);
            Check([[fresh valueForKey:@"mapDetailModes"] count] == 0 && [HubDefaults objectForKey:@"mapDetailModes"] == nil,
                @"a new launch does not restore lens chips");
            [fresh replaceLocations:DefaultLocations()];
            [fresh setChartNow:[iso dateFromString:@"2026-09-26T00:30:00Z"]];
            [fresh reloadStoreAtPath:root];
            [fresh rebuildContent];
            ClickLens(fresh, 2);
            Check([[fresh valueForKey:@"forecastMode"] integerValue] == 2 &&
                  [[fresh valueForKey:@"mapDetailModes"] count] == 0 &&
                  [HubDefaults objectForKey:@"mapDetailModes"] == nil &&
                  FindView(fresh.popover.contentViewController.view, @"hub.days"),
                @"opening a lens does not persist it and keeps the day strip");
            [HubDefaults removePersistentDomainForName:hubSuite];
            [c selectPopoverIndex:2];
            [c rebuildContent];
            view = c.popover.contentViewController.view;
            NSNumber *leftBefore = [c valueForKey:@"shownLeft"];
            NSNumber *rightBefore = [c valueForKey:@"shownRight"];
            ClickLens(c, 2);
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
                ClickLens(c, 2);
                ClickLens(c, 2);
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
            ClickLens(c, 2);
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
            ClickLens(c, 0);
            Check([[c valueForKey:@"forecastMode"] integerValue] == 0,
                @"a second detail can be opened before closing the popover");
            [c popoverWillClose:[NSNotification notificationWithName:NSPopoverWillCloseNotification object:c.popover]];
            Check([[c valueForKey:@"forecastMode"] integerValue] == -1,
                @"closing the popover resets the selected detail");
            [c rebuildContent];
            view = c.popover.contentViewController.view;
            for (NSNumber *mode in @[@0, @1, @2, @3, @4]) {
                SeedForecastMode(c, mode.integerValue);
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
                SeedForecastMode(c, mode.integerValue); [c rebuildContent];
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
            SeedForecastMode(c, 3); [c rebuildContent];
            Check(SameDate(changedDate,[[c valueForKey:@"forecastGraph"] valueForKey:@"selectedDate"]),
                @"closing and reopening preserves the selected time");
            SeedForecastMode(c, 1); [c rebuildContent];
            [c selectPopoverIndex:(NSInteger)[[c valueForKey:@"sequenceTimes"] count]-1]; [c rebuildContent];
            NSTextField *flyTime=(NSTextField *)FindView(c.popover.contentViewController.view, @"forecast.selectedTime");
            Check(flyTime && ![flyTime.stringValue containsString:@"Now"],
                @"Fly outside the TAF window does not relabel the panel Now");
            AviationForecastView *retiredFly=(AviationForecastView *)[c valueForKey:@"forecastGraph"];
            SeedForecastMode(c, 0); [c rebuildContent];
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
            [timeline mouseMoved:TimelineEvent(timeline,.78,NSEventTypeMouseMoved,501)]; Pump(.35);
            [timeline mouseExited:TimelineEvent(timeline,.78,NSEventTypeMouseExited,502)]; Pump(.25);
            Check(!SameDate(hoverRestore,[c selectedForecastDate]) &&
                SameDate([c selectedForecastDate],[[c valueForKey:@"forecastGraph"] valueForKey:@"selectedDate"]) &&
                fabs(timeline.progress-.78)<.001,
                @"leaving the timeline keeps the inspected map, graph and thumb time");
            NSDate *heldDate=[c selectedForecastDate];
            [timeline mouseMoved:TimelineEvent(timeline,.82,NSEventTypeMouseMoved,503)]; Pump(.35);
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
            scrub.progress=.1;
            for (NSInteger i=0;i<5;i++)
                [scrub mouseMoved:TimelineEventAtY(scrub,.2+i*.1,116,NSEventTypeMouseMoved,600+i)];
            Check(fabs(scrub.progress-.1)<.001 && hoverFrames.count==0,
                @"a fast timeline hover pass does not seek or preview");
            Pump(.04);
            Check(fabs(scrub.progress-.1)<.001 && hoverFrames.count==0,
                @"the hover dwell remains unarmed before 300 ms");
            Pump(.3);
            Check(hoverFrames.count==1 && fabs(hoverFrames.lastObject.doubleValue-.6)<.001,
                @"a stationary hover arms at the latest pointer position");
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
            Pump(.34); // A new hover must pass the intent dwell before preview.
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
                [c previewPopoverMovieFraction:.37];
                IsobarScrubRenderer *renderer=[c valueForKey:@"scrubRenderer"];
                Check(renderer && renderer.renderCount>0 && [[c valueForKey:@"scrubHasFraction"] boolValue],
                    @"pointer hover renders model frames while the forecast can play");
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
                [c previewPopoverMovieFraction:NAN];
                Check(fabs(((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress-.9)<.001,
                    @"leaving a rapid hover keeps its last selected time");
                CheckLivePlayback(c, root, fm);
                CheckDisplayedPlaybackUnderReduceMotion(c, root);
            }
            [c setValue:@-1 forKey:@"hubDayIndex"];
            // Keep this regression check in the disposable store harness too:
            // ordinary detail modes preserve the map geometry, while the
            // narrow surface deliberately switches to focused inspector.
            for (NSValue *size in @[[NSValue valueWithSize:NSMakeSize(1440,900)],
                                    [NSValue valueWithSize:NSMakeSize(1280,720)],
                                    [NSValue valueWithSize:NSMakeSize(1024,600)],
                                    [NSValue valueWithSize:NSMakeSize(800,600)],
                                    [NSValue valueWithSize:NSMakeSize(600,340)]]) {
                c.availableSize = size.sizeValue;
                SeedForecastMode(c, -1); [c rebuildContent];
                NSView *closed = c.popover.contentViewController.view;
                NSView *closedMap = FindView(closed,@"popover.chart");
                NSView *closedStrip=FindView(closed,@"popover.timeline");
                NSRect closedRect = [closedMap convertRect:closedMap.bounds toView:closed];
                NSNumber *selectedBefore = [[c valueForKey:@"shownLeft"] copy];
                for (NSNumber *mode in @[@0,@1,@2,@3,@4]) {
                    SeedForecastMode(c, mode.integerValue); [c rebuildContent];
                    NSView *open = c.popover.contentViewController.view;
                    NSView *map = FindView(open,@"popover.chart");
                    Check(open==closed && map==closedMap && FindView(open,@"popover.timeline")==closedStrip,
                        @"non-movie mode changes retain root, map and scrub target at every breakpoint");
                    Check(map && !map.hidden, @"a lens leaves the map on screen");
                    if (map && !map.hidden) {
                        NSRect openRect = [map convertRect:map.bounds toView:open];
                        BOOL roomForWideMap = c.availableSize.width >= 800 && c.availableSize.height >= 600;
                        Check(fabs(NSWidth(openRect)-NSWidth(closedRect)) < 1 &&
                              fabs(NSHeight(openRect)-NSHeight(closedRect)) < 1 &&
                              fabs(NSMinX(openRect)-NSMinX(closedRect)) < 1 &&
                              fabs(NSMinY(openRect)-NSMinY(closedRect)) < 1 &&
                              (!roomForWideMap || NSWidth(openRect) >= 500) &&
                              DetailFollowsMaps(open, mode.integerValue == 0 ? @"popover.windForecast" :
                                  (mode.integerValue == 1 ? @"popover.aviation" : (mode.integerValue == 3 ? @"popover.surf" : (mode.integerValue == 4 ? @"popover.temperature" : @"popover.rain")))),
                            @"map geometry survives an ordinary detail mode");
                    }
                }
                NSButton *back = (NSButton *)FindView(c.popover.contentViewController.view, @"forecast.back");
                if (back) [back performClick:nil];
                else { SeedForecastMode(c, -1); [c rebuildContent]; }
                NSView *restored = c.popover.contentViewController.view;
                NSView *restoredMap = FindView(restored,@"popover.chart");
                Check(restoredMap && !restoredMap.hidden &&
                      fabs(NSWidth([restoredMap convertRect:restoredMap.bounds toView:restored])-NSWidth(closedRect)) < 1 &&
                      [[c valueForKey:@"shownLeft"] isEqual:selectedBefore],
                    @"closing detail restores the map geometry");
            }
            c.availableSize = NSMakeSize(1440,900);
            SeedForecastMode(c, -1);
            [c rebuildContent];
            view = c.popover.contentViewController.view;
            NSView *freshIssued = FindView(view, @"popover.issued");
            NSTextField *freshRun = (NSTextField *)FindView(freshIssued, @"popover.issued.run");
            NSTextField *freshAge = (NSTextField *)FindView(freshIssued, @"popover.issued.age");
            NSView *freshWarn = FindView(freshIssued, @"popover.issued.warn");
            Check([freshRun.stringValue isEqual:@"18Z"] && [freshAge.stringValue isEqual:@"6 h"] &&
                  freshWarn.hidden && !HasText(view, @"updated just now") && !HasText(view, @"stale"),
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
            NSView *failedIssued = FindView(c.popover.contentViewController.view, @"popover.issued");
            NSTextField *failedAge = (NSTextField *)FindView(failedIssued, @"popover.issued.age");
            NSView *failedWarn = FindView(failedIssued, @"popover.issued.warn");
            Check([failedAge.stringValue isEqual:@"6 h"] && failedWarn && !failedWarn.hidden &&
                  [failedIssued.toolTip containsString:@"stale"] &&
                  !HasText(c.popover.contentViewController.view, @"stale"),
                @"a failed chart source tints the age and shows a warning");
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
                NSView *strip = FindView(fullscreen, @"fullscreen.days");
                NSPopUpButton *place = (NSPopUpButton *)FindView(fullscreen, @"fullscreen.place");
                NSButton *temperature = (NSButton *)FindView(fullscreen, @"fullscreen.temperature");
                NSUInteger readingIndex = ReadingAttributeIndex(temperature.attributedTitle);
                NSFont *tempFont = readingIndex != NSNotFound ?
                    [temperature.attributedTitle attribute:NSFontAttributeName atIndex:readingIndex effectiveRange:NULL] : nil;
                Check(transport && NSHeight(transport.frame)==28 &&
                    NSContainsRect(fullscreen.bounds,transportRect) &&
                    NSWidth(map.frame)>=400 && NSMinY(map.frame)>=NSMaxY(transportRect) &&
                    strip && NSWidth(strip.frame) > NSHeight(strip.frame) && FindView(strip, @"hub.day.0") &&
                    place.titleOfSelectedItem.length &&
                    [temperature.attributedTitle.string containsString:@"°"] && tempFont.pointSize >= 28 &&
                    FindView(fullscreen, @"fullscreen.lens") && FindView(fullscreen, @"fullscreen.issued") && !HasText(fullscreen, @"stale"),
                    [NSString stringWithFormat:@"expanded map and tile-aligned scrubber fit %.0fx%.0f",
                        dimensions.width,dimensions.height]);
                Capture(fullscreen,[NSString stringWithFormat:@"expanded-%.0fx%.0f.png",
                    dimensions.width,dimensions.height]);
            }
            NSView *backdrop = c.chartWindow.contentView;
            backdrop.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
            double darkBackdrop = LuminanceAt(backdrop, 6, 180);
            backdrop.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
            double lightBackdrop = LuminanceAt(backdrop, 6, 180);
            fprintf(stderr, "fullscreen backdrop light %.2f dark %.2f\n", lightBackdrop, darkBackdrop);
            Check(darkBackdrop < 0.45 && lightBackdrop > 0.7, @"fullscreen follows light and dark appearance");
            [c closeChartWindow];
            c.availableSize = NSMakeSize(1440, 900);
            WriteStatus(root, YES);
            [c reloadStoreAtPath:root];
            [c setChartNow:[iso dateFromString:@"2026-09-26T13:00:00Z"]];
            [c rebuildContent];
            NSView *agedIssued = FindView(c.popover.contentViewController.view, @"popover.issued");
            NSTextField *agedRun = (NSTextField *)FindView(agedIssued, @"popover.issued.run");
            NSTextField *agedAge = (NSTextField *)FindView(agedIssued, @"popover.issued.age");
            NSView *agedWarn = FindView(agedIssued, @"popover.issued.warn");
            Check([agedRun.stringValue isEqual:@"18Z"] && [agedAge.stringValue isEqual:@"19 h"] &&
                  agedWarn && !agedWarn.hidden && [agedIssued.toolTip containsString:@"stale"] &&
                  !HasText(c.popover.contentViewController.view, @"stale"),
                @"an open surface ages into a warning without waiting for another disk refresh");

            CheckTimeLens(root);

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

            // A field truncated under a loaded run keeps that run on screen,
            // marked stale. A cold start on the same store fails closed
            // (CheckColdStartFailsClosed).
            NSString *field = [root stringByAppendingPathComponent:@"ecmwf/20260925T18Z/msl.f32"];
            Check([[NSData data] writeToFile:field atomically:YES], @"truncate a disposable chart field");
            [c reloadStoreAtPath:root];
            [c rebuildContent];
            Check([c chartsReady] && HasText(c.popover.contentViewController.view, @"18Z") &&
                  !HasText(c.popover.contentViewController.view, @"Chart unavailable") &&
                  [[c valueForKey:@"storeError"] length],
                @"a field truncated under a loaded run keeps the last good chart");

            TestController *places = [TestController new];
            Check([[places homeAerodrome][@"code"] isEqual:@"YPPH"], @"Western Australia defaults to Perth");
            [places replaceLocations:@[@{@"name": @"Melbourne", @"state": @"VIC", @"geohash": @"r1r0fs6",
                @"latitude": @(-37.81), @"longitude": @144.96, @"timezone": @"Australia/Melbourne"}]];
            NSDictionary *melbourne = [places homeAerodrome];
            Check([melbourne[@"code"] isEqual:@"YMML"] && [melbourne[@"runways"] count] == 0,
                @"Victoria uses Melbourne and does not invent runways");
            [places replaceLocations:@[@{@"name": @"Unknown", @"state": @"ZZ", @"geohash": @"r1r0fs6",
                @"latitude": @0, @"longitude": @0, @"timezone": @"UTC"}]];
            Check(![[places homeAerodrome][@"code"] length], @"an unknown state leaves the aerodrome unset");
            Check([[places currentFlyPlan][@"line"] isEqual:@"Aerodrome not set"], @"an unset aerodrome is labelled");
            [places setValue:@"YSSY" forKey:@"aerodromeCode"];
            NSArray *sydneyRunways = [places homeAerodrome][@"runways"];
            Check(sydneyRunways.count > 0, @"a saved Sydney code keeps its runways");
            [places replaceLocations:@[DefaultLocations()[0]]];
            Check([[places flyAerodrome][@"code"] isEqual:@"YPPH"],
                @"Fly follows Perth coast to Perth Airport even when home is Sydney");
            [places setValue:[@{DefaultLocations()[0][@"geohash"]: @"YSSY"} mutableCopy] forKey:@"flyPins"];
            Check([[places flyAerodrome][@"code"] isEqual:@"YSSY"],
                @"a session pin keeps the airport chosen for this place");
            [places replaceLocations:@[DefaultLocations()[1]]];
            Check([[places flyAerodrome][@"code"] isEqual:@"YSSY"],
                @"a pin for Perth does not follow the user to Sydney");
            [places setValue:[NSMutableDictionary dictionary] forKey:@"flyPins"];
            [places replaceLocations:DefaultLocations()];
            [places setValue:@"YSSY" forKey:@"aerodromeCode"];

            NSMutableData *blankPDF = [NSMutableData data];
            CGDataConsumerRef consumer = CGDataConsumerCreateWithCFData((__bridge CFMutableDataRef)blankPDF);
            CGRect media = CGRectMake(0, 0, 240, 180);
            CGContextRef pdfContext = CGPDFContextCreate(consumer, &media, NULL);
            CGPDFContextBeginPage(pdfContext, NULL);
            CGPDFContextEndPage(pdfContext);
            CGContextRelease(pdfContext);
            CGDataConsumerRelease(consumer);
            [places setValue:@NO forKey:@"sourceECMWF"];
            [places setValue:@"" forKey:@"aerodromeCode"];
            [places noteChartImage:nil pdf:blankPDF issued:nil offline:NO];
            NSArray *panelTimes = [places valueForKey:@"sequenceTimes"];
            BOOL invented = NO;
            for (NSDate *when in panelTimes) if ([when timeIntervalSince1970] > 4000000000.0) invented = YES;
            Check([[places titleForSequenceIndex:0] isEqual:UndatedPanelLabel] &&
                  [[places relativeForSequenceIndex:0] isEqual:UndatedPanelLabel] &&
                  [places selectedForecastDate] == nil && !invented && panelTimes.count == 8,
                @"a chart with no valid times is undated");

            AviationNoticesView *notices = [places prepareAviationNotices:NO];
            NSDate *anchored = notices.now;
            [places setChartNow:[anchored dateByAddingTimeInterval:3600]];
            [places prepareAviationNotices:NO];
            Check(fabs([notices.now timeIntervalSinceDate:anchored] - 3600) < 1, @"notices re-anchor when shown again");

            NSTimer *clock = [NSTimer timerWithTimeInterval:30 repeats:YES block:^(__unused NSTimer *timer) {}];
            NSTimer *refresh = [NSTimer timerWithTimeInterval:300 repeats:YES block:^(__unused NSTimer *timer) {}];
            [places setValue:clock forKey:@"clock"];
            [places setValue:refresh forKey:@"refreshTimer"];
            [places applicationWillTerminate:[NSNotification notificationWithName:NSApplicationWillTerminateNotification object:NSApp]];
            Check([places valueForKey:@"clock"] == nil && [places valueForKey:@"refreshTimer"] == nil,
                @"terminate invalidates the clock and the refresh timer");
        } @finally {
            [fm removeItemAtPath:root error:nil];
        }
        CheckStoreReload(fixtures);
        CheckQuarterDegree(fixtures);
        // After the frame-time budget. The week ladder renders a long clip.
        CheckWeekGrid();
        // Capture-heavy control checks run after existing appearance and timing probes.
        CheckHazardControls([fixtures stringByAppendingPathComponent:@"store"]);
    }
    return failures ? 1 : 0;
}
