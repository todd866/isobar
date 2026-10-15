#import "e6bview.h"
#include <math.h>
@interface TestE6BPanel : E6BPanel
@property BOOL dismissed;
@end
@implementation TestE6BPanel
- (void)orderOut:(id)sender { self.dismissed=YES; [super orderOut:sender]; }
@end
static int failures;
static void ck(BOOL ok, NSString *name) { fprintf(stderr,"%s %s\n",ok?"ok":"FAIL",name.UTF8String); if(!ok) failures++; }
static NSView *find(NSView *root, NSString *name) {
    if ([root.accessibilityIdentifier isEqual:name]) return root;
    for (NSView *child in root.subviews) { NSView *v=find(child,name); if(v) return v; }
    return nil;
}
static void set(E6BView *view, NSString *name, NSString *value) {
    NSTextField *field=(NSTextField *)find(view,[@"e6b." stringByAppendingString:name]); field.stringValue=value;
    [view controlTextDidChange:[NSNotification notificationWithName:NSControlTextDidChangeNotification object:field]];
}
static NSString *get(E6BView *view, NSString *name) { return [(NSTextField *)find(view,[@"e6b." stringByAppendingString:name]) stringValue]; }
int main(void) { @autoreleasepool {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    TestE6BPanel *window=[[TestE6BPanel alloc] initWithContentRect:NSMakeRect(0,0,550,220) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES]; window.releasedWhenClosed=NO;
    E6BView *view=[[E6BView alloc] initWithFrame:NSMakeRect(0,0,550,220)]; window.contentView=view;
    ck([get(view,@"gs") isEqual:@"—"],@"initial missing input is missing output");
    NSString *root=NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] ?: @"Tests/fixtures";
    NSDictionary *fixture=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:@"e6b/wind.json"]] options:0 error:NULL];
    NSDictionary *sample=nil;
    for (NSDictionary *item in fixture[@"cases"]) if ([item[@"id"] isEqual:@"direct-crosswind-right"]) sample=item;
    ck(sample!=nil,@"shared view fixture exists");
    NSDictionary *input=sample[@"input"], *expected=sample[@"expected"];
    set(view,@"tc",[input[@"tc"] stringValue]); set(view,@"tas",[input[@"tas"] stringValue]);
    set(view,@"from",[input[@"windFrom"] stringValue]); set(view,@"kt",[input[@"windKt"] stringValue]);
    ck(fabs(get(view,@"gs").doubleValue-[expected[@"gs"] doubleValue])<0.1,@"live GS matches shared fixture");
    ck(fabs(get(view,@"th").doubleValue-[expected[@"th"] doubleValue])<0.1,@"live TH matches shared fixture");
    ck(fabs(get(view,@"wca").doubleValue-[expected[@"wca"] doubleValue])<0.1 && [get(view,@"wca") hasSuffix:@"R"],@"live WCA right matches shared fixture");
    for(NSView *child in view.subviews) ck(NSContainsRect(view.bounds,child.frame),@"control fits compact native viewport");
    [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa" withIntermediateDirectories:YES attributes:nil error:NULL];
    for (NSString *theme in @[@"light",@"dark"]) {
        view.appearance=[NSAppearance appearanceNamed:[theme isEqual:@"light"]?NSAppearanceNameAqua:NSAppearanceNameDarkAqua];
        [view.effectiveAppearance performAsCurrentDrawingAppearance:^{
            NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:550 pixelsHigh:220 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
            NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
            [NSGraphicsContext saveGraphicsState]; [NSGraphicsContext setCurrentContext:context];
            [view displayRectIgnoringOpacity:view.bounds inContext:context]; [NSGraphicsContext restoreGraphicsState];
            ck([[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithFormat:@"build/qa/e6b-%@.png",theme] atomically:YES],@"offscreen PNG written");
        }];
    }
    set(view,@"kt",@"120"); ck([get(view,@"gs") isEqual:@"—"],@"impossible crosswind clears outputs");
    for (NSString *invalid in @[@"",@"garbage",@"-1",@"nan",@"12foo"]) { set(view,@"tas",invalid); ck([get(view,@"th") isEqual:@"—"],@"invalid input stays missing"); }
    set(view,@"tas",@"120"); set(view,@"kt",@"30"); set(view,@"from",@"270");
    ck([get(view,@"wca") hasSuffix:@"L"],@"left correction carries L");
    NSStepper *step=nil; for(NSView *child in view.subviews) if([child isKindOfClass:NSStepper.class] && child.tag==1) step=(NSStepper *)child;
    step.doubleValue=130; [step sendAction:step.action to:step.target]; ck([get(view,@"tas") isEqual:@"130"],@"stepper updates input live");
    [window makeFirstResponder:find(view,@"e6b.tc")];
    NSEvent *escape=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil characters:@"\e" charactersIgnoringModifiers:@"\e" isARepeat:NO keyCode:53];
    ck([window performKeyEquivalent:escape] && window.dismissed,@"Escape key dismisses while editing numeric field");
    window.dismissed=NO;
    for(NSView *child in view.subviews) if([child isKindOfClass:NSButton.class]) [(NSButton *)child performClick:nil];
    ck(window.dismissed,@"Close button reaches panel dismissal");
    ck([get(view,@"tas") isEqual:@"130"],@"dismissal preserves calculator values"); [window close];
} return failures?1:0; }
