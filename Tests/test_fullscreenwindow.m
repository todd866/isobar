#import "fullscreenwindow.h"

static int failures;
static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

@interface KeyStub : NSObject <FullscreenWindowController>
@property NSInteger plays, lefts, rights, compares, sources, escapes;
@end
@implementation KeyStub
- (void)escapeFullscreen { self.escapes++; }
- (void)stepFullscreenPanel:(NSInteger)delta { if (delta < 0) self.lefts++; else self.rights++; }
- (void)toggleChartLoop { self.plays++; }
- (void)toggleIssueCompare { self.compares++; }
- (void)toggleChartSource { self.sources++; }
- (void)closeChartWindow {}
- (void)zoomChart:(int)direction { (void)direction; }
@end

static NSEvent *Key(unsigned short code, NSString *characters, NSEventModifierFlags flags, BOOL repeat) {
    return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:0
        windowNumber:0 context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:repeat keyCode:code];
}

int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        (void)app;
        NSTimeInterval last = 0;
        Check(ChartKeyActionFor(49, @" ", 0, NO, 10, &last) == ChartKeyPlay, @"space starts playback");
        Check(ChartKeyActionFor(49, @" ", 0, YES, 10.01, &last) == ChartKeyDrop, @"a repeated space does not toggle playback");
        last = 0;
        Check(ChartKeyActionFor(123, @"", 0, NO, 20, &last) == ChartKeyLeft && last == 20, @"left arrow steps back");
        Check(ChartKeyActionFor(123, @"", 0, YES, 20.05, &last) == ChartKeyDrop && last == 20, @"a fast arrow repeat is coalesced");
        Check(ChartKeyActionFor(124, @"", 0, YES, 20.2, &last) == ChartKeyRight && last == 20.2, @"a later arrow repeat steps");
        Check(ChartKeyActionFor(2, @"d", NSEventModifierFlagCommand, NO, 30, &last) == ChartKeyPass, @"command-D is not the compare shortcut");
        Check(ChartKeyActionFor(11, @"b", NSEventModifierFlagCommand, NO, 30, &last) == ChartKeyPass, @"command-B is not the source shortcut");
        Check(ChartKeyActionFor(2, @"d", 0, NO, 30, &last) == ChartKeyCompare, @"D compares issues");
        Check(ChartKeyActionFor(11, @"b", 0, NO, 30, &last) == ChartKeySource, @"B changes chart source");

        KeyStub *stub = [KeyStub new];
        FullscreenWindow *window = [[FullscreenWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 200)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
        window.releasedWhenClosed = NO;
        window.controller = stub;
        [window sendEvent:Key(49, @" ", 0, NO)];
        [window sendEvent:Key(49, @" ", 0, YES)];
        [window sendEvent:Key(123, @"", 0, NO)];
        [window sendEvent:Key(123, @"", 0, YES)];
        [window sendEvent:Key(2, @"d", NSEventModifierFlagCommand, NO)];
        [window sendEvent:Key(2, @"d", 0, NO)];
        [window sendEvent:Key(11, @"b", NSEventModifierFlagCommand, NO)];
        Check(stub.plays == 1, @"the window toggles playback once for a held space");
        Check(stub.lefts == 1, @"the window steps once for a held left arrow");
        Check(stub.compares == 1 && stub.sources == 0, @"command-modified shortcuts are not chart commands");
        [window close];
    }
    return failures ? 1 : 0;
}
