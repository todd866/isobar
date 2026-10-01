// Exercise the real controller against disposable disk snapshots. No app launch,
// network request, status item, visible window, or preference write.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop
#include <sys/resource.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import "test_accessibility.h"

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

static BOOL MapsLeadDetails(NSView *view) {
    NSView *map = FindView(view, @"popover.chart");
    NSView *right = FindView(view, @"popover.chart.right");
    NSView *modes = FindView(view, @"popover.forecastMode");
    NSView *layers = FindView(view, @"popover.layers");
    NSView *legend = FindView(view, @"chart.legend");
    NSView *timeline = FindView(view, @"popover.timeline");
    // The map stays on screen. Lenses sit under the timeline, never in place of the map.
    if (!map || map.hidden || !modes || !layers || !timeline || timeline.hidden || FindView(view, @"forecast.back")) return NO;
    CGFloat mapBottom = right ? MAX(NSMaxY(map.frame), NSMaxY(right.frame)) : NSMaxY(map.frame);
    if (legend) {
        if (NSIntersectsRect(legend.frame, modes.frame) || NSIntersectsRect(legend.frame, layers.frame)) return NO;
        for (NSView *label in legend.subviews)
            if (!NSContainsRect(legend.bounds, label.frame)) return NO;
    }
    BOOL fits = mapBottom <= NSMinY(timeline.frame) + 1 &&
        NSMaxY(timeline.frame) <= MIN(NSMinY(modes.frame), NSMinY(layers.frame)) + 1 &&
        !NSIntersectsRect(modes.frame, layers.frame);
    if (!fits) fprintf(stderr, "layout map %.1f timeline %.1f modes %.1f layers %.1f\\n",
        mapBottom, NSMinY(timeline.frame), NSMinY(modes.frame), NSMinY(layers.frame));
    return fits;
}

static BOOL DetailFollowsMaps(NSView *view, NSString *identifier) {
    NSView *map = FindView(view, @"popover.chart");
    NSView *detail = FindView(view, identifier);
    NSView *inspector = FindView(view, @"forecast.inspector");
    NSView *modes = FindView(view, @"popover.forecastMode");
    NSView *timeline = FindView(view, @"popover.timeline");
    if (!detail || !map || map.hidden || !inspector || !modes || !timeline || timeline.hidden || FindView(view, @"forecast.back")) return NO;
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
    NSPoint point=[timeline convertPoint:NSMakePoint(NSMinX(track)+NSWidth(track)*fraction,8) toView:nil];
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
    AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeMPEG4 error:&failure];
    AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @2500000,
            AVVideoExpectedSourceFrameRateKey: @30,
            AVVideoMaxKeyFrameIntervalKey: @30,
            AVVideoAllowFrameReorderingKey: @NO,
        },
    }];
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

static void CheckSmoothPlayback(TestController *c) {
    OwnRun *run = [c valueForKey:@"ownRun"];
    NSArray *times = [c valueForKey:@"sequenceTimes"];
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    player.pixelSize = NSMakeSize(580, 444);
    player.scale = 1;
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeedSlow);
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
    Check(maxLabel <= 2 && maxCentre <= 2, @"labels and centres glide at most 2px a frame");
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

static void CheckLivePlayback(TestController *c, NSString *root, NSFileManager *fm) {
    Check(fabs(IsobarLiveHoursPerSecond(IsobarLiveSpeedSlow) - 0.2) < 1e-9 &&
        fabs(IsobarLiveHoursPerSecond(IsobarLiveSpeedMedium) - 0.5) < 1e-9 &&
        fabs(IsobarLiveHoursPerSecond(IsobarLiveSpeedFast) - 1) < 1e-9 &&
        fabs(kIsobarLiveFrameStep - 90) < 1e-9 && kIsobarLiveSeamDuration >= 1,
        @"slow is one hour per five seconds, then medium and fast");
    Check(fabs(IsobarLiveFrameSpacing(0.003, 0.2) - 90) < 1e-6 &&
        fabs(IsobarLiveFrameSpacing(0.008, 0.2) - 90) < 1e-6 &&
        fabs(IsobarLiveFrameSpacing(0.040, 0.2) - 192) < 1e-6 &&
        fabs(IsobarLiveFrameSpacing(0.010, 1.0) - 450) < 1e-6 &&
        IsobarLiveFrameSpacing(0.001, 0.2) >= 90 - 1e-6,
        @"cheap frames stay near 90 forecast seconds and slow frames widen");
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
    if (chart.onClick) chart.onClick();
    SettleController(c);
    double nowFraction = [c motionFractionForDate:[c valueForKey:@"chartNow"]];
    progress = ((TimelineStrip *)[c valueForKey:@"popoverTimeline"]).progress;
    Check([[c valueForKey:@"popoverPlaying"] boolValue] && fabs(progress - nowFraction) < .05,
        @"clicking the map returns playback to now");

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
    // The tick that opens the seam does not spend seam time. The fade is 1.5s
    // of playback ticks, and only the tick after that returns the playhead to now.
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
    live.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeedSlow);
    [c startLivePlaybackFromDate:[c valueForKey:@"chartNow"]];
    for (NSInteger i = 0; i < 5; i++) {
        Pump(0.4);
        SavePlaybackFrame(live.baseImage, [NSString stringWithFormat:@"frame-%02ld.png", (long)i]);
    }
    Pump(2);
    struct rusage beforeUsage, afterUsage;
    getrusage(RUSAGE_SELF, &beforeUsage);
    Pump(20);
    getrusage(RUSAGE_SELF, &afterUsage);
    double cpuPercent = (CpuSeconds(afterUsage) - CpuSeconds(beforeUsage)) / 20.0 * 100.0;
    fprintf(stderr, "ambient cpu %.2f%% of one core\n", cpuPercent);
    // Reported share of one core. The ceiling is loose: a warm machine moves
    // it by several points, and a runaway still fails.
    if (!IsobarCISlow()) Check(cpuPercent < 20.0, @"ambient playback stays under 20% of one core");
    else fprintf(stderr, "ambient cpu ceiling skipped (ISOBAR_CI_SLOW)\n");
    [c useManualLiveClock];
    CheckSmoothPlayback(c);

    [c stopPopoverPlayback];
    OwnRun *run = [c valueForKey:@"ownRun"];
    IsobarLivePlayer *budget = [IsobarLivePlayer new];
    budget.byteBudget = 3 * 1024 * 1024;
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
        live.completedRenders == completedAtClose && live.cacheBytes < 3 * 1024 * 1024,
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
    Check([[c valueForKey:@"forecastPaused"] boolValue] && ![[c valueForKey:@"popoverPlaying"] boolValue],
        @"an explicit pause survives closing and reopening");
    NSString *suite = [@"com.isobar.playback." stringByAppendingString:NSUUID.UUID.UUIDString];
    PlaybackSuite = [[NSUserDefaults alloc] initWithSuiteName:suite];
    [PlaybackSuite setBool:YES forKey:@"forecastPaused"];
    PlaybackPrefsController *remembered = [PlaybackPrefsController new];
    Check([[remembered valueForKey:@"forecastPaused"] boolValue],
        @"an explicit pause is still set on the next launch");
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
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeedSlow);
    player.layers = layers;
    NSDate *start = [run timeAtIndex:0];
    NSDate *end = [run timeAtIndex:run.hours - 1];
    [player configureRun:run start:start end:end now:start modelIndex:^double(NSDate *date) {
        return ModelIndex(run, date);
    }];
    [player playFromDate:start];
    NSDate *warm = [NSDate dateWithTimeIntervalSinceNow:kLiveRenderCeiling];
    while (warm.timeIntervalSinceNow > 0 && player.completedRenders < 2) TickPlayer(player, 1);
    Check(player.completedRenders >= 2, @"0.25° playback renders the frames a tick asks for");
    struct rusage beforeUsage, afterUsage;
    getrusage(RUSAGE_SELF, &beforeUsage);
    NSTimeInterval cpuBegan = NSProcessInfo.processInfo.systemUptime;
    while (NSProcessInfo.processInfo.systemUptime - cpuBegan < 12.0) {
        [player tick:0.02];
        Pump(0.01);
    }
    getrusage(RUSAGE_SELF, &afterUsage);
    double cpuElapsed = NSProcessInfo.processInfo.systemUptime - cpuBegan;
    double cpuPercent = (CpuSeconds(afterUsage) - CpuSeconds(beforeUsage)) / MAX(0.001, cpuElapsed) * 100.0;
    fprintf(stderr, "grid025 ambient cpu %.2f%% spacing %.0fs\n", cpuPercent, player.frameSpacing);
    if (!IsobarCISlow()) Check(cpuPercent < 25.0, @"0.25° ambient playback stays under 25% of one core");
    else fprintf(stderr, "grid025 cpu ceiling skipped (ISOBAR_CI_SLOW)\n");

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
    Check(compared > 20 && maxMove <= 1.5 && maxTail <= 1.5 && maxLost < .10,
        @"0.25° isobars stay inside a 1.5px glide");
    Check(maxLabel <= 2 && maxCentre <= 2, @"0.25° labels and centres glide at most 2px a frame");
    Check(advanced > expected * 0.8 && advanced < expected * 1.2, @"0.25° playback keeps the slow rate");
    [player stopRendering];
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
                Check(map.mapDetails.count==0 && ![[layers valueForKey:@"sourceECMWF"] boolValue],
                    @"Temperature opens beside the map without adding a chip");
                Check(FindView(layers.popover.contentViewController.view,@"popover.temperature")!=nil,@"Temperature graph is available");
                NSPopUpButton *menu=(NSPopUpButton *)FindView(layers.popover.contentViewController.view,@"popover.layers");
                NSMenuItem *item=[menu.menu itemWithTag:14];
                Check(item.state==NSControlStateValueOff,@"opening Temperature does not check its map chip");
                [menu.menu performActionForItemAtIndex:[menu.menu indexOfItem:item]];
                map=(PDFCropView *)FindView(layers.popover.contentViewController.view,@"popover.chart");
                Check(map.mapDetails.count==1 && [map.mapDetails[0][@"kind"] isEqual:@"Temperature"] &&
                    FindView(layers.popover.contentViewController.view,@"popover.temperature"),@"a session chip can be shown without closing its graph");
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
            [(NSButton *)FindView(fresh.popover.contentViewController.view, @"forecast.toggle.rain") performClick:nil];
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
                NSView *strip = FindView(fullscreen, @"hub.days");
                NSPopUpButton *place = (NSPopUpButton *)FindView(fullscreen, @"fullscreen.place");
                NSButton *temperature = (NSButton *)FindView(fullscreen, @"fullscreen.temperature");
                NSFont *tempFont = temperature.attributedTitle.length ?
                    [temperature.attributedTitle attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL] : nil;
                Check(transport && NSHeight(transport.frame)==112 &&
                    NSContainsRect(fullscreen.bounds,transportRect) &&
                    NSWidth(map.frame)>=400 && NSMaxY(map.frame)<=NSMinY(transportRect)+1 &&
                    strip && NSWidth(strip.frame) > NSHeight(strip.frame) && FindView(strip, @"hub.day.0") &&
                    place.titleOfSelectedItem.length &&
                    [temperature.attributedTitle.string containsString:@"°"] && tempFont.pointSize >= 28 &&
                    FindView(fullscreen, @"fullscreen.lens.rain") && HasText(fullscreen, @"ECMWF"),
                    [NSString stringWithFormat:@"expanded map and tall scrubber fit %.0fx%.0f",
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
        CheckQuarterDegree(fixtures);
    }
    return failures ? 1 : 0;
}
