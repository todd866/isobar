// Shows the real NSPopover on an off-screen anchor and checks the composited
// popover. The acceptance harness that only overrides isShown never runs the
// shown-window paths (contentSize while shown, backing, display link, present).
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#import <stdarg.h>
#import <stdlib.h>
#import <math.h>

@interface GPUMapView (LivePopoverHarness)
- (CAMetalLayer *)metalLayer;
@end

@interface LivePopoverController : Controller
@property NSSize budget;
@end
@implementation LivePopoverController
- (NSSize)screenBudget { return self.budget.width > 1 ? self.budget : [super screenBudget]; }
- (NSUserDefaults *)chartPreferences { return nil; }
@end

static FILE *gLog = NULL;
static int gFailures = 0;
static const char *gPhase = "init";
static IMP gOrigContentSize = NULL;
static IMP gOrigOrderFront = NULL;
static IMP gOrigOrderFrontRegardless = NULL;
static IMP gOrigMakeKey = NULL;
static IMP gOrigConstrain = NULL;
static IMP gOrigActivate = NULL;
static IMP gOrigSetFrame = NULL;
static IMP gOrigSetFrameAnimate = NULL;
static IMP gOrigSetOrigin = NULL;
static BOOL gParking = NO;
static BOOL gInFrame = NO;

static void Log(const char *fmt, ...) {
    char buf[4096];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    fputs(buf, stderr);
    if (gLog) fputs(buf, gLog);
}

static void Fail(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    gFailures++;
    Log("FAIL %s\n", buf);
}

static BOOL FrameOnScreen(NSRect frame) {
    for (NSScreen *screen in NSScreen.screens)
        if (NSIntersectsRect(frame, screen.frame)) return YES;
    return NO;
}

static NSRect OffscreenFrame(NSRect frame) {
    if (!FrameOnScreen(frame) && frame.origin.x <= -15000 && frame.origin.y <= -15000) return frame;
    frame.origin = NSMakePoint(-20000, -20000);
    return frame;
}

static void ParkWindow(NSWindow *window) {
    if (!window || gParking) return;
    NSRect frame = OffscreenFrame(window.frame);
    if (NSEqualRects(frame, window.frame)) return;
    gParking = YES;
    [window setFrame:frame display:NO];
    gParking = NO;
}

static void ParkAll(void) {
    for (NSWindow *window in NSApp.windows) ParkWindow(window);
}

static BOOL gInSize = NO;
static void HarnessContentSize(id self, SEL cmd, NSSize size) {
    if (gInSize) {
        ((void (*)(id, SEL, NSSize))gOrigContentSize)(self, cmd, size);
        return;
    }
    gInSize = YES;
    Log("setContentSize %s phase=%s shown=%d animates=%d\n", NSStringFromSize(size).UTF8String, gPhase,
        [(NSPopover *)self isShown], [(NSPopover *)self animates]);
    ((void (*)(id, SEL, NSSize))gOrigContentSize)(self, cmd, size);
    ParkAll();
    gInSize = NO;
}

static void HarnessOrderFront(id self, SEL cmd, id sender) {
    ((void (*)(id, SEL, id))gOrigOrderFront)(self, cmd, sender);
    ParkWindow(self);
}

static void HarnessOrderFrontRegardless(id self, SEL cmd) {
    ((void (*)(id, SEL))gOrigOrderFrontRegardless)(self, cmd);
    ParkWindow(self);
}

static void HarnessMakeKey(id self, SEL cmd, id sender) {
    ((void (*)(id, SEL, id))gOrigMakeKey)(self, cmd, sender);
    ParkWindow(self);
}

static NSRect HarnessConstrain(id self, SEL cmd, NSRect rect, NSScreen *screen) {
    (void)self; (void)cmd; (void)screen;
    return OffscreenFrame(rect);
}

static void HarnessSetFrame(id self, SEL cmd, NSRect frame, BOOL display) {
    if (gInFrame) {
        ((void (*)(id, SEL, NSRect, BOOL))gOrigSetFrame)(self, cmd, frame, display);
        return;
    }
    gInFrame = YES;
    NSRect parked = OffscreenFrame(frame);
    if (!NSEqualRects(parked, frame)) display = NO;
    ((void (*)(id, SEL, NSRect, BOOL))gOrigSetFrame)(self, cmd, parked, display);
    gInFrame = NO;
}

static void HarnessSetFrameAnimate(id self, SEL cmd, NSRect frame, BOOL display, BOOL animate) {
    if (gInFrame) {
        ((void (*)(id, SEL, NSRect, BOOL, BOOL))gOrigSetFrameAnimate)(self, cmd, frame, display, animate);
        return;
    }
    gInFrame = YES;
    NSRect parked = OffscreenFrame(frame);
    if (!NSEqualRects(parked, frame)) display = NO;
    ((void (*)(id, SEL, NSRect, BOOL, BOOL))gOrigSetFrameAnimate)(self, cmd, parked, display, NO);
    gInFrame = NO;
}

static void HarnessSetOrigin(id self, SEL cmd, NSPoint origin) {
    NSRect frame = OffscreenFrame(NSMakeRect(origin.x, origin.y, 1, 1));
    ((void (*)(id, SEL, NSPoint))gOrigSetOrigin)(self, cmd, frame.origin);
}

static void HarnessActivate(id self, SEL cmd, BOOL flag) {
    (void)self; (void)cmd;
    Log("suppress activateIgnoringOtherApps:%d phase=%s\n", flag, gPhase);
}

static void InstallSwizzles(void) {
    Method size = class_getInstanceMethod(NSPopover.class, @selector(setContentSize:));
    gOrigContentSize = method_setImplementation(size, (IMP)HarnessContentSize);
    Method front = class_getInstanceMethod(NSWindow.class, @selector(orderFront:));
    gOrigOrderFront = method_setImplementation(front, (IMP)HarnessOrderFront);
    Method regardless = class_getInstanceMethod(NSWindow.class, @selector(orderFrontRegardless));
    gOrigOrderFrontRegardless = method_setImplementation(regardless, (IMP)HarnessOrderFrontRegardless);
    Method key = class_getInstanceMethod(NSWindow.class, @selector(makeKeyAndOrderFront:));
    gOrigMakeKey = method_setImplementation(key, (IMP)HarnessMakeKey);
    Method constrain = class_getInstanceMethod(NSWindow.class, @selector(constrainFrameRect:toScreen:));
    gOrigConstrain = method_setImplementation(constrain, (IMP)HarnessConstrain);
    Method setFrame = class_getInstanceMethod(NSWindow.class, @selector(setFrame:display:));
    gOrigSetFrame = method_setImplementation(setFrame, (IMP)HarnessSetFrame);
    Method setFrameAnimate = class_getInstanceMethod(NSWindow.class, @selector(setFrame:display:animate:));
    gOrigSetFrameAnimate = method_setImplementation(setFrameAnimate, (IMP)HarnessSetFrameAnimate);
    Method setOrigin = class_getInstanceMethod(NSWindow.class, @selector(setFrameOrigin:));
    gOrigSetOrigin = method_setImplementation(setOrigin, (IMP)HarnessSetOrigin);
    Method activate = class_getInstanceMethod(NSApplication.class, @selector(activateIgnoringOtherApps:));
    if (activate) gOrigActivate = method_setImplementation(activate, (IMP)HarnessActivate);
    (void)gOrigConstrain;
    (void)gOrigActivate;
}

static NSView *Find(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) {
        NSView *found = Find(child, identifier);
        if (found) return found;
    }
    return nil;
}

static void Pump(NSTimeInterval seconds) {
    const char *saved = gPhase;
    gPhase = "pump";
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0) {
        ParkAll();
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        [NSRunLoop.currentRunLoop runMode:NSRunLoopCommonModes beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
    ParkAll();
    gPhase = saved;
}

static void LogWindows(const char *tag) {
    Log("windows %s\n", tag);
    for (NSScreen *screen in NSScreen.screens)
        Log("  screen %s scale=%.2f\n", NSStringFromRect(screen.frame).UTF8String, screen.backingScaleFactor);
    for (NSWindow *window in NSApp.windows) {
        Log("  %s frame=%s onScreen=%d visible=%d alpha=%.2f occ=%lu key=%d num=%ld\n",
            object_getClassName(window), NSStringFromRect(window.frame).UTF8String, FrameOnScreen(window.frame),
            window.isVisible, window.alphaValue, (unsigned long)window.occlusionState, window.keyWindow,
            (long)window.windowNumber);
    }
}

static NSString *AppearanceName(NSView *view) {
    NSAppearance *appearance = view.effectiveAppearance;
    return appearance.name ?: @"?";
}

static void DumpView(NSView *view, int depth, NSView *root) {
    if (!view || depth > 40) return;
    NSRect windowRect = view.window ? [view convertRect:view.bounds toView:nil] : NSZeroRect;
    NSRect rootRect = root ? [view convertRect:view.bounds toView:root] : view.frame;
    CALayer *layer = view.wantsLayer ? view.layer : nil;
    const char *ident = view.accessibilityIdentifier.UTF8String ?: "";
    Log("%*s%s id=%s frame=%s root=%s win=%s hid=%d hidAnc=%d alpha=%.2f wants=%d "
        "layerOp=%.2f layerHid=%d z=%.1f masks=%d app=%s opaque=%d sib=%lu\n",
        depth * 2, "", object_getClassName(view), ident,
        NSStringFromRect(view.frame).UTF8String, NSStringFromRect(rootRect).UTF8String,
        NSStringFromRect(windowRect).UTF8String, view.hidden, view.isHiddenOrHasHiddenAncestor, view.alphaValue,
        view.wantsLayer, layer ? layer.opacity : -1, layer ? layer.hidden : 0, layer ? layer.zPosition : 0,
        layer ? layer.masksToBounds : 0, AppearanceName(view).UTF8String, view.isOpaque,
        (unsigned long)[view.superview.subviews indexOfObject:view]);
    if ([view isKindOfClass:NSButton.class]) {
        NSButton *button = (NSButton *)view;
        Log("%*s  button title='%s' state=%ld tint=%s\n", depth * 2, "", button.title.UTF8String,
            (long)button.state, button.contentTintColor.description.UTF8String);
    } else if ([view isKindOfClass:NSTextField.class]) {
        NSTextField *field = (NSTextField *)view;
        NSString *text = field.stringValue.length ? field.stringValue : field.attributedStringValue.string;
        if (text.length > 80) text = [[text substringToIndex:80] stringByAppendingString:@"…"];
        Log("%*s  text='%s' color=%s\n", depth * 2, "", (text ?: @"").UTF8String, field.textColor.description.UTF8String);
    } else if ([view isKindOfClass:NSTextView.class]) {
        NSTextView *text = (NSTextView *)view;
        Log("%*s  textView len=%lu drawsBg=%d bg=%s frame=%s\n", depth * 2, "",
            (unsigned long)text.string.length, text.drawsBackground, text.backgroundColor.description.UTF8String,
            NSStringFromRect(text.frame).UTF8String);
    }
    if ([view isKindOfClass:GPUMapView.class]) {
        GPUMapView *gpu = (GPUMapView *)view;
        CAMetalLayer *metal = gpu.metalLayer;
        Log("%*s  gpu presented=%lu blank=%d drawable=%s metalFrame=%s metalOp=%.2f metalHid=%d txn=%d\n",
            depth * 2, "", (unsigned long)gpu.presentedCount, gpu.presentedFrameBlank,
            NSStringFromSize(NSMakeSize(metal.drawableSize.width, metal.drawableSize.height)).UTF8String,
            NSStringFromRect(metal.frame).UTF8String, metal.opacity, metal.hidden, metal.presentsWithTransaction);
    }
    for (NSView *child in view.subviews) DumpView(child, depth + 1, root);
}

typedef struct {
    double mean, stddev, nearWhite, nearBlack, chroma;
    NSUInteger samples;
} RegionStats;

static RegionStats StatsOf(NSBitmapImageRep *rep, NSRect pixelRect) {
    RegionStats stats = {0};
    if (!rep) return stats;
    NSInteger minX = MAX(0, (NSInteger)floor(pixelRect.origin.x));
    NSInteger minY = MAX(0, (NSInteger)floor(pixelRect.origin.y));
    NSInteger maxX = MIN(rep.pixelsWide, (NSInteger)ceil(NSMaxX(pixelRect)));
    NSInteger maxY = MIN(rep.pixelsHigh, (NSInteger)ceil(NSMaxY(pixelRect)));
    if (maxX - minX < 2 || maxY - minY < 2) return stats;
    NSInteger step = MAX(1, ((maxX - minX) * (maxY - minY) > 250000) ? 4 : 2);
    double sum = 0, sum2 = 0;
    for (NSInteger y = minY; y < maxY; y += step) {
        for (NSInteger x = minX; x < maxX; x += step) {
            NSColor *color = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (!color) continue;
            double r = color.redComponent, g = color.greenComponent, b = color.blueComponent;
            double luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            double chroma = MAX(r, MAX(g, b)) - MIN(r, MIN(g, b));
            sum += luma;
            sum2 += luma * luma;
            stats.samples++;
            if (r > 0.96 && g > 0.96 && b > 0.96) stats.nearWhite += 1;
            if (luma < 0.08) stats.nearBlack += 1;
            if (chroma > 0.08) stats.chroma += 1;
        }
    }
    if (!stats.samples) return stats;
    stats.mean = sum / stats.samples;
    double var = sum2 / stats.samples - stats.mean * stats.mean;
    stats.stddev = var > 0 ? sqrt(var) : 0;
    stats.nearWhite /= stats.samples;
    stats.nearBlack /= stats.samples;
    stats.chroma /= stats.samples;
    return stats;
}

static BOOL RegionBlank(RegionStats stats) {
    if (stats.samples < 20) return YES;
    return stats.stddev < 0.025 || stats.nearWhite > 0.92 || stats.nearBlack > 0.92;
}

static void LogStats(const char *name, RegionStats stats) {
    Log("pixels %s n=%lu mean=%.3f sd=%.3f white=%.3f black=%.3f chroma=%.3f blank=%d\n",
        name, (unsigned long)stats.samples, stats.mean, stats.stddev, stats.nearWhite, stats.nearBlack,
        stats.chroma, RegionBlank(stats));
}

static BOOL WriteRep(NSBitmapImageRep *rep, NSString *path) {
    if (!rep) return NO;
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return png && [png writeToFile:path atomically:YES];
}

static CGImageRef CaptureWindowImage(NSWindow *window) {
    if (!window || window.windowNumber <= 0) return NULL;
    typedef CGImageRef (*CaptureFunc)(CGRect, uint32_t, uint32_t, uint32_t);
    static CaptureFunc capture = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ capture = (CaptureFunc)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage"); });
    if (!capture) return NULL;
    // IncludingWindow | BoundsIgnoreFraming | BestResolution. The symbol is
    // obsoleted for new code; the call is still how this process reads its own
    // composited window without a screen-recording prompt.
    const uint32_t includingWindow = 1u << 3;
    const uint32_t ignoreFraming = 1u << 0;
    const uint32_t bestResolution = 1u << 3;
    return capture(CGRectNull, includingWindow, (uint32_t)window.windowNumber, ignoreFraming | bestResolution);
}

static NSBitmapImageRep *WindowRep(NSWindow *window, NSString *path) {
    CGImageRef image = CaptureWindowImage(window);
    if (!image) {
        Log("window capture nil num=%ld\n", window ? (long)window.windowNumber : 0);
        return nil;
    }
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
    CGImageRelease(image);
    if (path) WriteRep(rep, path);
    return rep;
}

static BOOL WriteCGImage(CGImageRef image, NSString *path) {
    if (!image) return NO;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
    BOOL ok = WriteRep(rep, path);
    return ok;
}

static RegionStats SideStats(NSBitmapImageRep *rep, CGFloat splitFraction, BOOL right) {
    if (!rep || rep.pixelsWide < 4) return (RegionStats){0};
    CGFloat split = MIN(rep.pixelsWide - 2, MAX(2, splitFraction * rep.pixelsWide));
    NSRect rect = right ? NSMakeRect(split, 0, rep.pixelsWide - split, rep.pixelsHigh)
                        : NSMakeRect(0, 0, split, rep.pixelsHigh);
    return StatsOf(rep, rect);
}

static CGFloat InspectorSplit(NSView *root) {
    NSView *inspector = Find(root, @"forecast.inspector");
    if (!inspector || NSWidth(root.bounds) < 1) return 1;
    NSRect rect = [inspector convertRect:inspector.bounds toView:root];
    return MIN(0.95, MAX(0.05, NSMinX(rect) / NSWidth(root.bounds)));
}

static void LogCover(NSView *root) {
    NSArray *keys = @[@"hub.place", @"popover.obs", @"popover.issued", @"hub.days", @"popover.timeline",
        @"popover.play", @"popover.speed", @"popover.now", @"popover.chart", @"popover.gpu", @"popover.lensRow",
        @"popover.lens", @"popover.barbs", @"forecast.inspector", @"chart.legend"];
    for (NSString *key in keys) {
        NSView *view = Find(root, key);
        if (!view) {
            Log("missing %s\n", key.UTF8String);
            continue;
        }
        NSRect mine = [view convertRect:view.bounds toView:nil];
        Log("key %s zero=%d hid=%d alpha=%.2f win=%s\n", key.UTF8String,
            NSWidth(view.bounds) < 1 || NSHeight(view.bounds) < 1, view.isHiddenOrHasHiddenAncestor,
            view.alphaValue, NSStringFromRect(mine).UTF8String);
        NSMutableArray *stack = [NSMutableArray arrayWithObject:root.window.contentView ?: root];
        while (stack.count) {
            NSView *other = stack.lastObject;
            [stack removeLastObject];
            for (NSView *child in other.subviews.reverseObjectEnumerator) [stack addObject:child];
            if (other == view || [other isDescendantOf:view] || [view isDescendantOf:other]) continue;
            if (other.hidden || other.alphaValue < 0.05) continue;
            NSRect theirs = [other convertRect:other.bounds toView:nil];
            NSRect hit = NSIntersectionRect(mine, theirs);
            if (NSIsEmptyRect(hit) || NSWidth(mine) < 1 || NSHeight(mine) < 1) continue;
            CGFloat cover = (NSWidth(hit) * NSHeight(hit)) / (NSWidth(mine) * NSHeight(mine));
            if (cover < 0.55) continue;
            Log("  covered %.0f%% by %s id=%s win=%s\n", cover * 100, object_getClassName(other),
                other.accessibilityIdentifier.UTF8String ?: "", NSStringFromRect(theirs).UTF8String);
        }
    }
}

static void ShowPopover(LivePopoverController *controller, NSView *anchor) {
    gPhase = "show";
    if (!controller.popover) [controller rebuildContent];
    controller.popover.animates = NO;
    if (!controller.popover.shown)
        [controller.popover showRelativeToRect:anchor.bounds ofView:anchor preferredEdge:NSMinYEdge];
    ParkAll();
    gPhase = "shown";
    Log("shown=%d content=%s class=%s\n", controller.popover.shown,
        NSStringFromSize(controller.popover.contentSize).UTF8String,
        object_getClassName(controller.popover.contentViewController.view));
    LogWindows("after-show");
}

static void ClickControl(LivePopoverController *controller, NSString *identifier) {
    NSView *root = controller.popover.contentViewController.view;
    NSButton *button = (NSButton *)Find(root, identifier);
    if (![button isKindOfClass:NSButton.class]) {
        Fail("missing toggle %s", identifier.UTF8String);
        return;
    }
    gPhase = "click";
    Log("click %s title='%s' state=%ld\n", identifier.UTF8String, button.title.UTF8String, (long)button.state);
    [button performClick:nil];
    ParkAll();
    gPhase = "clicked";
}

static NSBitmapImageRep *Record(LivePopoverController *controller, NSString *dir, NSString *name, BOOL deep) {
    NSView *root = controller.popover.contentViewController.view;
    NSWindow *window = root.window;
    ParkAll();
    Log("\n==== %s shown=%d content=%s window=%s ====\n", name.UTF8String, controller.popover.shown,
        NSStringFromSize(controller.popover.contentSize).UTF8String,
        NSStringFromRect(window.frame).UTF8String);
    if (FrameOnScreen(window.frame)) Fail("%s popover window is on a screen", name.UTF8String);
    if (deep) {
        Log("chain\n");
        for (NSView *view = root; view; view = view.superview)
            Log("  %s frame=%s wants=%d\n", object_getClassName(view), NSStringFromRect(view.frame).UTF8String,
                view.wantsLayer);
        DumpView(window.contentView ?: root, 0, root);
        LogCover(root);
    }
    GPUMapView *gpu = (GPUMapView *)Find(root, @"popover.gpu");
    if ([gpu isKindOfClass:GPUMapView.class]) {
        [gpu waitForUploads];
        Log("gpu presented=%lu blank=%d render=%lu step=%.2f\n", (unsigned long)gpu.presentedCount,
            gpu.presentedFrameBlank, (unsigned long)gpu.renderCount, gpu.renderedStep);
        CGImageRef shot = [gpu copySnapshot];
        if (shot) {
            NSBitmapImageRep *shotRep = [[NSBitmapImageRep alloc] initWithCGImage:shot];
            LogStats("gpu-snapshot", StatsOf(shotRep, NSMakeRect(0, 0, shotRep.pixelsWide, shotRep.pixelsHigh)));
            WriteCGImage(shot, [dir stringByAppendingPathComponent:[name stringByAppendingString:@"-gpu.png"]]);
            CGImageRelease(shot);
        } else Log("gpu snapshot nil\n");
    } else Log("gpu absent\n");
    gPhase = "capture-window";
    NSBitmapImageRep *live = WindowRep(window, [dir stringByAppendingPathComponent:[name stringByAppendingString:@"-window.png"]]);
    CGFloat split = InspectorSplit(root);
    Log("split %.3f\n", split);
    if (live) {
        LogStats([[name stringByAppendingString:@"-window-left"] UTF8String], SideStats(live, split, NO));
        LogStats([[name stringByAppendingString:@"-window-right"] UTF8String], SideStats(live, split, YES));
    }
    return live;
}

typedef struct {
    double median, ink, nearWhite, chroma, stddev, red, green, blue;
    NSUInteger samples;
} InkStats;

static int CompareSample(const void *a, const void *b) {
    double left = ((const double *)a)[3], right = ((const double *)b)[3];
    return (left > right) - (left < right);
}

static InkStats InkInRect(NSBitmapImageRep *rep, NSRect pixelRect) {
    InkStats stats = {0};
    if (!rep) return stats;
    NSInteger minX = MAX(0, (NSInteger)floor(pixelRect.origin.x));
    NSInteger minY = MAX(0, (NSInteger)floor(pixelRect.origin.y));
    NSInteger maxX = MIN(rep.pixelsWide, (NSInteger)ceil(NSMaxX(pixelRect)));
    NSInteger maxY = MIN(rep.pixelsHigh, (NSInteger)ceil(NSMaxY(pixelRect)));
    NSInteger width = maxX - minX, height = maxY - minY;
    if (width < 2 || height < 2) return stats;
    NSInteger step = 1;
    while ((width / step) * (height / step) > 6000) step++;
    NSInteger cap = ((width / step) + 1) * ((height / step) + 1);
    double *samples = malloc((size_t)cap * 4 * sizeof(double));
    if (!samples) return stats;
    double sum = 0, sum2 = 0;
    NSUInteger n = 0, white = 0, chroma = 0;
    for (NSInteger y = minY; y < maxY && (NSInteger)n < cap; y += step) {
        for (NSInteger x = minX; x < maxX && (NSInteger)n < cap; x += step) {
            NSColor *color = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (!color) continue;
            double r = color.redComponent, g = color.greenComponent, b = color.blueComponent;
            double luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            samples[n * 4] = r;
            samples[n * 4 + 1] = g;
            samples[n * 4 + 2] = b;
            samples[n * 4 + 3] = luma;
            sum += luma;
            sum2 += luma * luma;
            if (r > 0.96 && g > 0.96 && b > 0.96) white++;
            if (MAX(r, MAX(g, b)) - MIN(r, MIN(g, b)) > 0.08) chroma++;
            n++;
        }
    }
    if (!n) { free(samples); return stats; }
    qsort(samples, n, 4 * sizeof(double), CompareSample);
    double *mid = samples + (n / 2) * 4;
    NSUInteger ink = 0;
    for (NSUInteger i = 0; i < n; i++)
        if (fabs(samples[i * 4 + 3] - mid[3]) > 0.08) ink++;
    stats.samples = n;
    stats.median = mid[3];
    stats.red = mid[0];
    stats.green = mid[1];
    stats.blue = mid[2];
    stats.ink = (double)ink / n;
    stats.nearWhite = (double)white / n;
    stats.chroma = (double)chroma / n;
    double var = sum2 / n - (sum / n) * (sum / n);
    stats.stddev = var > 0 ? sqrt(var) : 0;
    free(samples);
    return stats;
}

static NSRect PixelRect(NSRect windowRect, NSWindow *window, NSBitmapImageRep *rep) {
    if (!window || !rep || NSWidth(window.frame) < 1 || NSHeight(window.frame) < 1) return NSZeroRect;
    CGFloat scaleX = rep.pixelsWide / NSWidth(window.frame);
    CGFloat scaleY = rep.pixelsHigh / NSHeight(window.frame);
    // CGWindowListCreateImage rows start at the top of the window. colorAtX:y: on
    // the resulting bitmap uses that same row order.
    CGFloat y = (NSHeight(window.frame) - NSMaxY(windowRect)) * scaleY;
    return NSMakeRect(windowRect.origin.x * scaleX, y, windowRect.size.width * scaleX, windowRect.size.height * scaleY);
}

static double LinearChannel(double channel) {
    return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4);
}

static double RelativeLuminance(NSColor *color) {
    NSColor *rgb = [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    if (!rgb) return NAN;
    return 0.2126 * LinearChannel(rgb.redComponent) + 0.7152 * LinearChannel(rgb.greenComponent)
        + 0.0722 * LinearChannel(rgb.blueComponent);
}

static NSColor *ForegroundColor(NSView *view) {
    __block NSColor *color = NSColor.labelColor;
    if ([view isKindOfClass:NSButton.class] && ((NSButton *)view).contentTintColor)
        color = ((NSButton *)view).contentTintColor;
    else if ([view isKindOfClass:NSTextField.class] && ((NSTextField *)view).textColor)
        color = ((NSTextField *)view).textColor;
    NSAppearance *appearance = view.effectiveAppearance ?: NSApp.effectiveAppearance;
    [appearance performAsCurrentDrawingAppearance:^{
        color = [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    }];
    return color;
}

static NSString *ControlTitle(NSView *view) {
    if ([view isKindOfClass:NSButton.class]) return ((NSButton *)view).title ?: @"";
    if ([view isKindOfClass:NSTextField.class]) return ((NSTextField *)view).stringValue ?: @"";
    return @"";
}

static void FlattenVisible(NSView *view, NSMutableArray *order) {
    if (!view || view.hidden || view.alphaValue < 0.05) return;
    [order addObject:view];
    for (NSView *child in view.subviews) FlattenVisible(child, order);
}

static NSString *Occluder(NSView *view) {
    if (!view.window) return @"no window";
    NSMutableArray *order = [NSMutableArray array];
    FlattenVisible(view.window.contentView, order);
    NSUInteger index = [order indexOfObject:view];
    if (index == NSNotFound) return @"missing from draw order";
    NSRect mine = [view convertRect:view.bounds toView:nil];
    CGFloat area = NSWidth(mine) * NSHeight(mine);
    if (area < 1) return nil;
    for (NSUInteger i = index + 1; i < order.count; i++) {
        NSView *other = order[i];
        if ([other isDescendantOf:view] || other.isHiddenOrHasHiddenAncestor || other.alphaValue < 0.05) continue;
        NSRect hit = NSIntersectionRect(mine, [other convertRect:other.bounds toView:nil]);
        if (NSIsEmptyRect(hit)) continue;
        if ((NSWidth(hit) * NSHeight(hit)) / area < 0.70) continue;
        return other.accessibilityIdentifier.length ? other.accessibilityIdentifier
            : [NSString stringWithUTF8String:object_getClassName(other)];
    }
    return nil;
}

static BOOL FlatFill(InkStats stats) {
    return stats.samples < 12 || (stats.nearWhite > 0.97) || (stats.chroma < 0.02 && stats.stddev < 0.02 && stats.ink < 0.01);
}

static void ExpectComposited(NSString *name, NSString *identifier, NSView *root, NSBitmapImageRep *live, BOOL labelSide) {
    NSView *view = Find(root, identifier);
    if (!view) {
        Fail("%s missing %s", name.UTF8String, identifier.UTF8String);
        return;
    }
    if (view.isHiddenOrHasHiddenAncestor || view.alphaValue < 0.05 || NSWidth(view.bounds) < 1 || NSHeight(view.bounds) < 1) {
        Fail("%s %s is not visible", name.UTF8String, identifier.UTF8String);
        return;
    }
    NSString *cover = Occluder(view);
    if (cover) Fail("%s %s is covered by %s", name.UTF8String, identifier.UTF8String, cover.UTF8String);
    NSRect pixels = PixelRect([view convertRect:view.bounds toView:nil], view.window, live);
    InkStats ink = InkInRect(live, pixels);
    Log("%s %s ink=%.3f white=%.3f chroma=%.3f sd=%.3f\n", name.UTF8String, identifier.UTF8String,
        ink.ink, ink.nearWhite, ink.chroma, ink.stddev);
    if (ink.ink < 0.015)
        Fail("%s %s has no painted text or icon in the popover", name.UTF8String, identifier.UTF8String);
    NSString *title = ControlTitle(view);
    BOOL showsTitle = title.length > 0;
    if ([view isKindOfClass:NSButton.class] && ((NSButton *)view).imagePosition == NSImageOnly) showsTitle = NO;
    if (showsTitle) {
        NSColor *background = [NSColor colorWithSRGBRed:ink.red green:ink.green blue:ink.blue alpha:1];
        double ratio = 0;
        double fore = RelativeLuminance(ForegroundColor(view));
        double back = RelativeLuminance(background);
        if (isfinite(fore) && isfinite(back)) {
            double hi = MAX(fore, back), lo = MIN(fore, back);
            ratio = (hi + 0.05) / (lo + 0.05);
        }
        Log("%s %s title='%s' contrast=%.2f\n", name.UTF8String, identifier.UTF8String, title.UTF8String, ratio);
        if (ratio < 1.6)
            Fail("%s %s text does not contrast with its background (%.2f)", name.UTF8String, identifier.UTF8String, ratio);
    }
    if (labelSide && [view isKindOfClass:NSButton.class]) {
        NSRect local = view.bounds;
        local.origin.x += NSWidth(local) * 0.42;
        local.size.width = NSWidth(view.bounds) - (local.origin.x - NSMinX(view.bounds));
        InkStats label = InkInRect(live, PixelRect([view convertRect:local toView:nil], view.window, live));
        Log("%s %s labelInk=%.3f title='%s'\n", name.UTF8String, identifier.UTF8String, label.ink,
            ((NSButton *)view).title.UTF8String);
        if (label.ink < 0.015 || ((NSButton *)view).title.length < 1)
            Fail("%s %s label is missing", name.UTF8String, identifier.UTF8String);
    }
}

static void RejectEllipsis(NSView *view, NSString *name) {
    if (!view || view.isHiddenOrHasHiddenAncestor || view.alphaValue < 0.05) return;
    NSString *text = @"";
    NSLineBreakMode mode = NSLineBreakByWordWrapping;
    NSFont *font = nil;
    if ([view isKindOfClass:NSButton.class]) {
        NSButton *button = (NSButton *)view;
        text = button.title ?: @"";
        mode = button.lineBreakMode;
        font = button.font;
    } else if ([view isKindOfClass:NSTextField.class]) {
        NSTextField *field = (NSTextField *)view;
        text = field.stringValue.length ? field.stringValue : field.attributedStringValue.string;
        mode = field.lineBreakMode;
        font = field.font;
    } else if ([view isKindOfClass:NSTextView.class]) {
        text = ((NSTextView *)view).string ?: @"";
    }
    NSString *ident = view.accessibilityIdentifier ?: @"";
    if ([text containsString:@"…"])
        Fail("%s label ellipsizes: %s", name.UTF8String, ident.length ? ident.UTF8String : "control");
    // Icon buttons keep an accessibility title in a square that is not a drawn label.
    BOOL drawsTitle = YES;
    if ([view isKindOfClass:NSButton.class]) {
        NSCellImagePosition position = ((NSButton *)view).imagePosition;
        drawsTitle = position != NSImageOnly && position != NSImageOverlaps;
    }
    BOOL clips = mode == NSLineBreakByTruncatingTail || mode == NSLineBreakByTruncatingHead || mode == NSLineBreakByTruncatingMiddle;
    BOOL watched = [ident hasPrefix:@"aviation."] || [ident hasPrefix:@"popover."] || [ident hasPrefix:@"hub."];
    if (clips && drawsTitle && watched && text.length && NSWidth(view.bounds) > 1) {
        CGFloat need = ceil([text sizeWithAttributes:@{NSFontAttributeName: font ?: [NSFont systemFontOfSize:13]}].width);
        if (need > NSWidth(view.bounds) + 1)
            Fail("%s clips %s", name.UTF8String, ident.UTF8String);
    }
    for (NSView *child in view.subviews) RejectEllipsis(child, name);
}

static void AcceptPopover(LivePopoverController *controller, NSString *dir, NSString *name, BOOL deep, BOOL newMap, BOOL dark) {
    NSView *root = controller.popover.contentViewController.view;
    if (!controller.popover.shown || !root.window) {
        Fail("%s popover is not shown", name.UTF8String);
        return;
    }
    NSString *appearance = root.effectiveAppearance.name ?: @"";
    Log("%s appearance=%s\n", name.UTF8String, appearance.UTF8String);
    if (dark != [appearance containsString:@"Dark"])
        Fail("%s appearance is %s", name.UTF8String, appearance.UTF8String);
    RejectEllipsis(root, name);
    NSBitmapImageRep *live = Record(controller, dir, name, deep);
    if (!live) {
        Fail("%s window capture failed", name.UTF8String);
        return;
    }
    NSView *inspector = Find(root, @"forecast.inspector");
    CGFloat split = 1;
    if (inspector)
        split = MIN(0.95, MAX(0.05, NSMinX([inspector convertRect:inspector.bounds toView:nil]) / NSWidth(root.window.frame)));
    RegionStats left = SideStats(live, split, NO);
    CGFloat insetX = live.pixelsWide * 0.02;
    CGFloat insetY = live.pixelsHigh * 0.03;
    CGFloat splitX = split * live.pixelsWide;
    RegionStats interior = StatsOf(live, NSMakeRect(insetX, insetY, MAX(2, splitX - insetX * 2), MAX(2, live.pixelsHigh - insetY * 2)));
    LogStats([[name stringByAppendingString:@"-left"] UTF8String], left);
    LogStats([[name stringByAppendingString:@"-interior"] UTF8String], interior);
    if (interior.nearWhite > 0.90 || (interior.chroma < 0.04 && interior.stddev < 0.04))
        Fail("%s blanks the popover left of the inspector", name.UTF8String);
    if (inspector) {
        InkStats panel = InkInRect(live, PixelRect([inspector convertRect:inspector.bounds toView:nil], root.window, live));
        Log("%s panel ink=%.3f white=%.3f chroma=%.3f sd=%.3f\n", name.UTF8String, panel.ink, panel.nearWhite, panel.chroma, panel.stddev);
        if (panel.samples < 12 || (panel.ink < 0.008 && panel.stddev < 0.02))
            Fail("%s lens panel is blank", name.UTF8String);
    }
    NSArray *controls = @[@"hub.place", @"popover.obs", @"hub.days", @"popover.timeline", @"popover.play",
        @"popover.speed", @"popover.now", @"popover.lensRow", @"popover.lens"];
    for (NSString *identifier in controls)
        ExpectComposited(name, identifier, root, live, [identifier isEqual:@"popover.lens"]);
    NSString *mapId = newMap ? @"popover.gpu" : @"popover.chart";
    NSView *map = Find(root, mapId);
    if (!map || map.isHiddenOrHasHiddenAncestor) {
        Fail("%s missing %s", name.UTF8String, mapId.UTF8String);
    } else {
        InkStats field = InkInRect(live, PixelRect([map convertRect:map.bounds toView:nil], root.window, live));
        Log("%s map %s ink=%.3f white=%.3f chroma=%.3f sd=%.3f\n", name.UTF8String, mapId.UTF8String,
            field.ink, field.nearWhite, field.chroma, field.stddev);
        if (FlatFill(field)) Fail("%s map is blank", name.UTF8String);
        NSString *cover = Occluder(map);
        if (cover) Fail("%s map is covered by %s", name.UTF8String, cover.UTF8String);
    }
    if (newMap) {
        GPUMapView *gpu = (GPUMapView *)Find(root, @"popover.gpu");
        if (![gpu isKindOfClass:GPUMapView.class] || gpu.presentedCount < 1 || gpu.presentedFrameBlank)
            Fail("%s GPU map did not present a non-blank frame (presented=%lu blank=%d)", name.UTF8String,
                (unsigned long)([gpu isKindOfClass:GPUMapView.class] ? gpu.presentedCount : 0),
                [gpu isKindOfClass:GPUMapView.class] ? gpu.presentedFrameBlank : 1);
        if (Find(root, @"popover.chart") == nil) Fail("%s classic chart view is missing under the new map", name.UTF8String);
    } else if (Find(root, @"popover.gpu") && !Find(root, @"popover.gpu").isHiddenOrHasHiddenAncestor) {
        Fail("%s GPU map is still in the popover", name.UTF8String);
    }
}

static void UseAppearance(LivePopoverController *controller, BOOL dark) {
    NSAppearance *appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    NSApp.appearance = appearance;
    if (!controller.popover) return;
    controller.popover.appearance = appearance;
    NSView *root = controller.popover.contentViewController.view;
    root.appearance = appearance;
    root.window.appearance = appearance;
    gPhase = dark ? "dark" : "light";
    [controller rebuildContent];
    ParkAll();
}

static void SetNewMap(LivePopoverController *controller, BOOL on) {
    NSButton *box = [NSButton checkboxWithTitle:@"New map" target:controller action:@selector(toggleNewMap:)];
    box.state = on ? NSControlStateValueOn : NSControlStateValueOff;
    gPhase = on ? "new-map-on" : "new-map-off";
    [controller toggleNewMap:box];
    ParkAll();
}

static void ClickLens(LivePopoverController *controller, NSInteger segment) {
    NSSegmentedControl *row = (NSSegmentedControl *)Find(controller.popover.contentViewController.view, @"popover.lens");
    if (![row isKindOfClass:NSSegmentedControl.class] || row.segmentCount != 7) {
        Fail("missing seven-segment lens control"); return;
    }
    row.selectedSegment = segment;
    [NSApp sendAction:row.action to:row.target from:row];
    ParkAll(); Pump(.4);
}

// Choose the coupled lens through the same AppKit action as a real click.
static void ChooseLens(LivePopoverController *controller, NSInteger segment) {
    NSSegmentedControl *row = (NSSegmentedControl *)Find(controller.popover.contentViewController.view, @"popover.lens");
    if (![row isKindOfClass:NSSegmentedControl.class] || row.segmentCount != 7) {
        Fail("missing seven-segment lens control"); return;
    }
    if (row.selectedSegment != segment) {
        row.selectedSegment = segment;
        [NSApp sendAction:row.action to:row.target from:row];
    }
    ParkAll(); Pump(0.45);
    NSInteger fields[] = {0, 1, 2, 3, 2, 0, 0};
    NSInteger panels[] = {-1, 2, -1, 4, 0, 3, 1};
    if ([controller mapField] != fields[segment] || [[controller valueForKey:@"forecastMode"] integerValue] != panels[segment])
        Fail("lens %ld field/panel mismatch", (long)segment);
    row = (NSSegmentedControl *)Find(controller.popover.contentViewController.view, @"popover.lens");
    if (row.selectedSegment != segment) Fail("lens selection mismatch");
    if (NSWidth(row.frame) + .5 < row.intrinsicContentSize.width) Fail("lens labels clipped");
    if (Find(controller.popover.contentViewController.view, @"popover.field") ||
        Find(controller.popover.contentViewController.view, @"popover.forecastMode")) Fail("duplicate field/lens row");
}

static void CaptureLenses(LivePopoverController *controller, NSString *dir, NSString *prefix, BOOL newMap, BOOL dark) {
    NSArray *names = @[@"pressure", @"rain", @"wind", @"temp", @"kite", @"surf", @"fly"];
    for (NSInteger segment = 0; segment < 7; segment++) {
        ChooseLens(controller, segment);
        AcceptPopover(controller, dir, [prefix stringByAppendingString:names[segment]], segment == 6, newMap, dark);
        ClickLens(controller, segment);
        NSSegmentedControl *row = (NSSegmentedControl *)Find(controller.popover.contentViewController.view, @"popover.lens");
        if ([controller mapField] != 0 || [[controller valueForKey:@"forecastMode"] integerValue] != -1 || row.selectedSegment != 0)
            Fail("reselecting lens %ld did not return to Pressure", (long)segment);
    }
}

static void RunOwnerSession(LivePopoverController *controller, NSView *anchor, NSString *dir) {
    UseAppearance(controller, NO);
    [controller rebuildContent];
    ShowPopover(controller, anchor);
    Pump(.5);
    ChooseLens(controller, 0);
    AcceptPopover(controller, dir, @"light-new-play-pressure", YES, YES, NO);
    ChooseLens(controller, 1);
    ChooseLens(controller, 6);
    AcceptPopover(controller, dir, @"light-new-play-rain-then-fly", YES, YES, NO);
    CaptureLenses(controller, dir, @"light-new-lens-", YES, NO);
    [controller.popover performClose:nil]; Pump(.15);
    [controller rebuildContent]; ShowPopover(controller, anchor); Pump(.35);
    ChooseLens(controller, 6);
    AcceptPopover(controller, dir, @"light-new-play-reopen-fly", NO, YES, NO);
    ClickControl(controller, @"popover.play"); Pump(.35);
    AcceptPopover(controller, dir, @"light-new-paused-fly", NO, YES, NO);
    ClickControl(controller, @"popover.play"); Pump(.25);
    UseAppearance(controller, YES); Pump(.45);
    CaptureLenses(controller, dir, @"dark-new-lens-", YES, YES);
    SetNewMap(controller, NO); Pump(.45);
    UseAppearance(controller, NO);
    CaptureLenses(controller, dir, @"light-classic-lens-", NO, NO);
    UseAppearance(controller, YES);
    CaptureLenses(controller, dir, @"dark-classic-lens-", NO, YES);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) {
            fprintf(stderr, "usage: check-popover-live STORE OUTPUT\n");
            return 64;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        InstallSwizzles();
        NSString *store = [NSString stringWithUTF8String:argv[1]];
        NSString *output = [NSString stringWithUTF8String:argv[2]];
        [NSFileManager.defaultManager createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:nil];
        gLog = fopen([output stringByAppendingPathComponent:@"dump.txt"].UTF8String, "w");
        LivePopoverController *controller = [LivePopoverController new];
        controller.budget = NSMakeSize(1440, 900);
        [controller replaceLocations:DefaultLocations()];
        Log("load %s\n", store.UTF8String);
        [controller reloadStoreAtPath:store];
        Log("charts %d\n", [controller chartsReady]);
        if (![controller chartsReady]) Fail("store has no chart");
        NSWindow *anchorWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 48, 24)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        anchorWindow.releasedWhenClosed = NO;
        anchorWindow.opaque = NO;
        anchorWindow.backgroundColor = NSColor.clearColor;
        anchorWindow.hasShadow = NO;
        anchorWindow.ignoresMouseEvents = YES;
        anchorWindow.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary;
        NSView *anchor = [[NSView alloc] initWithFrame:NSMakeRect(12, 2, 22, 22)];
        anchor.accessibilityIdentifier = @"harness.anchor";
        [anchorWindow.contentView addSubview:anchor];
        [anchorWindow orderBack:nil];
        ParkWindow(anchorWindow);
        @try {
            RunOwnerSession(controller, anchor, output);
        } @catch (NSException *exception) {
            Fail("exception %s", exception.reason.UTF8String);
        } @finally {
            gPhase = "close";
            [controller.popover performClose:nil];
            GPUMapView *gpu = (GPUMapView *)Find(controller.popover.contentViewController.view, @"popover.gpu");
            if ([gpu isKindOfClass:GPUMapView.class]) [gpu stopRendering];
            [anchorWindow orderOut:nil];
            for (NSWindow *window in NSApp.windows.copy) [window orderOut:nil];
            [anchorWindow close];
        }
        Log("failures %d\n", gFailures);
        if (gLog) fclose(gLog);
        return gFailures ? 1 : 0;
    }
}
