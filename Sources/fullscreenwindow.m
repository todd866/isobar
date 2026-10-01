#import "fullscreenwindow.h"

@implementation FullscreenWindow
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
- (void)sendEvent:(NSEvent *)event {
    if (event.type == NSEventTypeKeyDown) {
        unsigned short key = event.keyCode;
        if ([self.firstResponder isKindOfClass:NSClassFromString(@"TimelineStrip")] && (key == 123 || key == 124)) {
            [super sendEvent:event];
            return;
        }
        NSString *ch = event.charactersIgnoringModifiers.lowercaseString;
        if (key == 53 || key == 123 || key == 124 || key == 49 || [ch isEqualToString:@"d"] || [ch isEqualToString:@"b"]) {
            [self keyDown:event];
            return;
        }
    }
    [super sendEvent:event];
}
- (void)cancelOperation:(id)sender { (void)sender; [self.controller escapeFullscreen]; }
- (void)keyDown:(NSEvent *)e {
    if (e.keyCode == 53) { [self.controller escapeFullscreen]; return; }
    if (e.keyCode == 123) { [self.controller stepFullscreenPanel:-1]; return; }
    if (e.keyCode == 124) { [self.controller stepFullscreenPanel:1]; return; }
    if (e.keyCode == 49) { [self.controller toggleChartLoop]; return; }
    if ([e.charactersIgnoringModifiers.lowercaseString isEqualToString:@"d"]) { [self.controller toggleIssueCompare]; return; }
    if ([e.charactersIgnoringModifiers.lowercaseString isEqualToString:@"b"]) { [self.controller toggleChartSource]; return; }
    [super keyDown:e];
}
- (BOOL)performKeyEquivalent:(NSEvent *)e {
    NSEventModifierFlags mods = e.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
    if (mods & NSEventModifierFlagCommand) {
        NSString *ch = e.charactersIgnoringModifiers.lowercaseString;
        if ([ch isEqualToString:@"w"]) { [self.controller closeChartWindow]; return YES; }
        if ([ch isEqualToString:@"="] || [ch isEqualToString:@"+"]) { [self.controller zoomChart:1]; return YES; }
        if ([ch isEqualToString:@"-"]) { [self.controller zoomChart:-1]; return YES; }
        if ([ch isEqualToString:@"0"]) { [self.controller zoomChart:0]; return YES; }
    }
    return [super performKeyEquivalent:e];
}
@end
