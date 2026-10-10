#import "fullscreenwindow.h"
#import "gpumapview.h"

static const NSTimeInterval kArrowRepeatInterval = 0.15;

ChartKeyAction ChartKeyActionFor(unsigned short keyCode, NSString *characters, NSEventModifierFlags flags,
    BOOL isRepeat, NSTimeInterval now, NSTimeInterval *lastArrow) {
    NSEventModifierFlags mods = flags & NSEventModifierFlagDeviceIndependentFlagsMask;
    BOOL command = (mods & NSEventModifierFlagCommand) != 0;
    NSString *ch = characters.lowercaseString ?: @"";
    if ([ch isEqualToString:@"d"] || [ch isEqualToString:@"b"]) {
        if (command) return ChartKeyPass;
        if (isRepeat) return ChartKeyDrop;
        return [ch isEqualToString:@"d"] ? ChartKeyCompare : ChartKeySource;
    }
    if (keyCode == 53) return ChartKeyEscape;
    if (keyCode == 49) return isRepeat ? ChartKeyDrop : ChartKeyPlay;
    if (keyCode == 123 || keyCode == 124) {
        if (isRepeat && lastArrow && now - *lastArrow < kArrowRepeatInterval) return ChartKeyDrop;
        if (lastArrow) *lastArrow = now;
        return keyCode == 123 ? ChartKeyLeft : ChartKeyRight;
    }
    return ChartKeyPass;
}

@implementation FullscreenWindow {
    NSTimeInterval _lastArrow;
}
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
- (void)performChartKey:(ChartKeyAction)action {
    switch (action) {
        case ChartKeyEscape: [self.controller escapeFullscreen]; break;
        case ChartKeyLeft: [self.controller stepFullscreenPanel:-1]; break;
        case ChartKeyRight: [self.controller stepFullscreenPanel:1]; break;
        case ChartKeyPlay: [self.controller toggleChartLoop]; break;
        case ChartKeyCompare: [self.controller toggleIssueCompare]; break;
        case ChartKeySource: [self.controller toggleChartSource]; break;
        default: break;
    }
}
- (ChartKeyAction)actionForEvent:(NSEvent *)event {
    return ChartKeyActionFor(event.keyCode, event.charactersIgnoringModifiers, event.modifierFlags,
        event.isARepeat, NSDate.timeIntervalSinceReferenceDate, &_lastArrow);
}
- (void)sendEvent:(NSEvent *)event {
    if (event.type == NSEventTypeKeyDown) {
        if ([self.firstResponder isKindOfClass:NSTextView.class] ||
        ([self.firstResponder isKindOfClass:NSTextField.class] && [(NSTextField *)self.firstResponder isEditable])) { [super sendEvent:event]; return; }
        unsigned short key = event.keyCode;
        // The 3D map owns navigation while focused. This lets arrow repeats
        // yaw/pitch there without stealing arrows from the timeline or text
        // fields elsewhere in the fullscreen window.
        if ([self.firstResponder respondsToSelector:@selector(handle3DKeyEvent:)] &&
            [(id)self.firstResponder handle3DKeyEvent:event]) return;
        if ([self.firstResponder isKindOfClass:NSClassFromString(@"TimelineStrip")] && (key == 123 || key == 124)) {
            [super sendEvent:event];
            return;
        }
        ChartKeyAction action = [self actionForEvent:event];
        if (action != ChartKeyPass) {
            [self performChartKey:action];
            return;
        }
    }
    [super sendEvent:event];
}
- (void)cancelOperation:(id)sender { (void)sender; [self.controller escapeFullscreen]; }
- (void)keyDown:(NSEvent *)e {
    if ([self.firstResponder respondsToSelector:@selector(handle3DKeyEvent:)] &&
        [(GPUMapView *)self.firstResponder handle3DKeyEvent:e]) return;
    ChartKeyAction action = [self actionForEvent:e];
    if (action == ChartKeyPass) { [super keyDown:e]; return; }
    [self performChartKey:action];
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
