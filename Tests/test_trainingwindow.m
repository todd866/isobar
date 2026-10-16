#import <Cocoa/Cocoa.h>
#import "trainingwindow.h"

static int failures;
static void Check(BOOL ok, NSString *why) {
    if (!ok) { fprintf(stderr, "FAIL %s\n", why.UTF8String); failures++; }
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSWindow removeFrameUsingName:@"IsobarTraining"];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-24000, -24000, 100, 100)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
        window.releasedWhenClosed = NO;
        TrainingWindowConfigure(window);
        NSWindowStyleMask mask = window.styleMask;
        Check((mask & NSWindowStyleMaskTitled) != 0, @"training window is titled");
        Check((mask & NSWindowStyleMaskClosable) != 0, @"training window is closable");
        Check((mask & NSWindowStyleMaskResizable) != 0, @"training window is resizable");
        Check((mask & NSWindowStyleMaskMiniaturizable) != 0, @"training window is miniaturizable");
        Check((mask & NSWindowStyleMaskFullScreen) == 0, @"training window does not open full screen");
        Check(!window.isVisible, @"configure does not order the window on screen");
        Check(NSEqualSizes(window.contentMinSize, NSMakeSize(960, 640)),
            [NSString stringWithFormat:@"minimum content size %@", NSStringFromSize(window.contentMinSize)]);
        NSRect content = [window contentRectForFrameRect:window.frame];
        // 1280×820, or the largest size that fits a smaller visible frame (13" Air).
        NSRect fit = (window.screen ?: NSScreen.mainScreen).visibleFrame;
        NSRect full = [window frameRectForContentRect:NSMakeRect(0, 0, 1280, 820)];
        double wantW = MAX(960, 1280 - MAX(0, NSWidth(full) - NSWidth(fit)));
        double wantH = MAX(640, 820 - MAX(0, NSHeight(full) - NSHeight(fit)));
        Check(fabs(content.size.width - wantW) < 1 && fabs(content.size.height - wantH) < 1,
            [NSString stringWithFormat:@"content size %@ (want %.0f×%.0f)", NSStringFromSize(content.size), wantW, wantH]);
        Check([window.frameAutosaveName isEqual:@"IsobarTraining"],
            [NSString stringWithFormat:@"frame autosave %@", window.frameAutosaveName ?: @"nil"]);
        Check((window.collectionBehavior & NSWindowCollectionBehaviorFullScreenPrimary) != 0,
            @"the green button can enter full screen");
        NSScreen *screen = window.screen ?: NSScreen.mainScreen;
        NSRect visible = screen.visibleFrame;
        // NSWindow center is exact horizontally and a little above the geometric centre.
        CGFloat dy = NSMidY(window.frame) - NSMidY(visible);
        Check(fabs(NSMidX(window.frame) - NSMidX(visible)) < 2 && dy > -2 && dy < 40 &&
            NSContainsRect(NSInsetRect(visible, -1, -1), window.frame),
            [NSString stringWithFormat:@"window %@ is centred in %@", NSStringFromRect(window.frame), NSStringFromRect(visible)]);
        [window orderOut:nil];
        [window close];
        printf("training window test failures: %d\n", failures);
        return failures ? 1 : 0;
    }
}
