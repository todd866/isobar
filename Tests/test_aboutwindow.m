#import <Cocoa/Cocoa.h>
#import "aboutwindow.h"

static int failures;
@interface AboutTestParent : NSWindow
@property(nonatomic) BOOL restored;
@end
@implementation AboutTestParent
- (void)makeKeyAndOrderFront:(id)sender { (void)sender; self.restored = YES; }
@end
static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static NSView *FindText(NSView *view, NSString *needle) {
    if ([view isKindOfClass:NSTextField.class] && [((NSTextField *)view).stringValue containsString:needle]) return view;
    for (NSView *child in view.subviews) { NSView *found = FindText(child, needle); if (found) return found; }
    return nil;
}

static NSData *Render(NSWindow *window, NSString *appearance, NSString *name) {
    window.appearance = [NSAppearance appearanceNamed:appearance];
    NSView *view = window.contentView;
    [view layoutSubtreeIfNeeded];
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:NSWidth(view.bounds) pixelsHigh:NSHeight(view.bounds)
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [window.appearance performAsCurrentDrawingAppearance:^{
        NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
        [NSGraphicsContext saveGraphicsState]; NSGraphicsContext.currentContext = context;
        [view displayRectIgnoringOpacity:view.bounds inContext:context];
        [NSGraphicsContext restoreGraphicsState];
    }];
    [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa" withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    Check([png writeToFile:[@"build/qa" stringByAppendingPathComponent:name] atomically:YES],
          [NSString stringWithFormat:@"render %@", name]);
    return png;
}

int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication]; [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        IsobarAboutWindow *window = (IsobarAboutWindow *)AboutWindowCreate();
        Check([window.title isEqual:@"About Isobar"], @"window title is About Isobar");
        Check(FindText(window.contentView, @"Version") != nil, @"window shows app version");
        Check(FindText(window.contentView, @"ECMWF open data") != nil && FindText(window.contentView, @"Mapterhorn terrain") != nil,
              @"window contains core attribution rows");
        Check(FindText(window.contentView, @"Copernicus GLO-30") != nil, @"window contains full terrain copyright");
        NSUInteger links = 0;
        for (NSTextField *field in window.contentView.subviews) {
            Check(NSContainsRect(window.contentView.bounds,field.frame), @"About row fits window");
            NSRect text = [field.attributedStringValue boundingRectWithSize:NSMakeSize(NSWidth(field.frame),CGFLOAT_MAX)
                options:NSStringDrawingUsesLineFragmentOrigin];
            Check(NSHeight(text) <= NSHeight(field.frame), @"About text fits row height");
            if ([field.attributedStringValue attribute:NSLinkAttributeName atIndex:0 effectiveRange:NULL]) links++;
        }
        Check(links == AboutAttributionRows().count, @"every source has a native link");
        AboutTestParent *parent = [[AboutTestParent alloc] initWithContentRect:NSMakeRect(0, 0, 300, 200)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
        parent.releasedWhenClosed = NO;
        window.previousWindow = parent;
        [window sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:window.windowNumber context:nil characters:@"\e" charactersIgnoringModifiers:@"\e" isARepeat:NO keyCode:53]];
        Check(!window.isVisible, @"Escape closes the About window");
        Check(parent.restored, @"Escape restores previous window");
        NSData *light = Render(window, NSAppearanceNameAqua, @"about-light.png");
        NSData *dark = Render(window, NSAppearanceNameDarkAqua, @"about-dark.png");
        Check(![light isEqualToData:dark], @"dark appearance changes About rendering");
        parent.restored = NO; window.previousWindow = parent;
        [window performClose:nil];
        Check(parent.restored && !window.previousWindow, @"titlebar close restores parent and clears reference");
        [parent close];
    }
    if (failures) return 1;
    puts("about window tests passed"); return 0;
}
