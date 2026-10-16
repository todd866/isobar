#ifndef ISOBAR_ABOUTWINDOW_H
#define ISOBAR_ABOUTWINDOW_H

#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// The attribution surface is deliberately a small native window so map
// surfaces remain focused on weather. The returned window is retained by the
// caller (AboutWindowPresent also retains a shared instance).
static NSWindow *AboutWindowCreate(void);
static void AboutWindowPresent(NSWindow * _Nullable parent) __attribute__((unused));

#ifdef __OBJC__

@interface IsobarAboutWindow : NSWindow
@property(nonatomic, weak, nullable) NSWindow *previousWindow;
@end

static NSString *AboutVersion(void) {
    NSString *shortVersion = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    NSString *build = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    if (!shortVersion.length) shortVersion = @"development";
    return build.length ? [NSString stringWithFormat:@"%@ (%@)", shortVersion, build] : shortVersion;
}

// Kept as data to make the complete credit set inspectable by tests and easy
// to update when an upstream source changes its terms.
static NSArray<NSDictionary *> *AboutAttributionRows(void) {
    return @[
        @{ @"name": @"ECMWF open data", @"detail": @"CC BY 4.0", @"url": @"https://www.ecmwf.int/en/forecasts/datasets/open-data" },
        @{ @"name": @"Mapterhorn terrain", @"detail": @"Copernicus GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the EU and ESA", @"url": @"https://mapterhorn.com/attribution/" },
        @{ @"name": @"Geoscience Australia", @"detail": @"CC BY 4.0", @"url": @"https://www.ga.gov.au/copyright" },
        @{ @"name": @"Natural Earth", @"detail": @"Public domain", @"url": @"https://www.naturalearthdata.com/about/terms-of-use/" },
        @{ @"name": @"Bureau of Meteorology", @"detail": @"Australian weather observations and forecasts", @"url": @"https://www.bom.gov.au/" },
        @{ @"name": @"aviationweather.gov", @"detail": @"Aviation weather products", @"url": @"https://aviationweather.gov/" },
        @{ @"name": @"CelesTrak", @"detail": @"Satellite orbital elements", @"url": @"https://celestrak.org/" },
        @{ @"name": @"NOTAC", @"detail": @"Aviation notices service", @"url": @"https://notac.aero/" },
        @{ @"name": @"ADSB.lol", @"detail": @"Live aircraft positions", @"url": @"https://adsb.lol/" },
        @{ @"name": @"ADSBDB", @"detail": @"Aircraft route information", @"url": @"https://www.adsbdb.com/" },
        @{ @"name": @"Cohort (MD3)", @"detail": @"MIT License; © 2025–2026 MD3 Contributors", @"url": @"https://opensource.org/license/mit" },
    ];
}

@interface IsobarAboutContent : NSView
@end
@implementation IsobarAboutContent
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirty { [NSColor.windowBackgroundColor setFill]; NSRectFill(dirty); }
@end

static NSTextField *AboutLabel(NSString *value, NSRect frame, BOOL secondary) {
    NSTextField *field = [NSTextField wrappingLabelWithString:value];
    field.frame = frame;
    field.font = [NSFont systemFontOfSize:12];
    field.textColor = secondary ? NSColor.secondaryLabelColor : NSColor.labelColor;
    return field;
}

static NSWindow *AboutWindowCreate(void) {
    IsobarAboutContent *content = [[IsobarAboutContent alloc] initWithFrame:NSMakeRect(0,0,620,430)];
    NSTextField *title = AboutLabel(@"Isobar", NSMakeRect(20,16,160,30), NO);
    title.font = [NSFont systemFontOfSize:22 weight:NSFontWeightSemibold];
    [content addSubview:title];
    NSTextField *version = AboutLabel([NSString stringWithFormat:@"Version %@", AboutVersion()], NSMakeRect(200,23,400,20), YES);
    version.accessibilityIdentifier = @"about.version";
    [content addSubview:version];
    CGFloat y = 62;
    for (NSDictionary *row in AboutAttributionRows()) {
        CGFloat height = [row[@"name"] isEqual:@"Mapterhorn terrain"] ? 66 : 26;
        NSTextField *name = AboutLabel(row[@"name"], NSMakeRect(20,y,174,height), NO);
        name.allowsEditingTextAttributes = YES; name.selectable = YES;
        name.attributedStringValue = [[NSAttributedString alloc] initWithString:row[@"name"] attributes:@{
            NSFontAttributeName:[NSFont systemFontOfSize:12], NSForegroundColorAttributeName:NSColor.linkColor,
            NSLinkAttributeName:[NSURL URLWithString:row[@"url"]]}];
        [content addSubview:name];
        NSTextField *detail = AboutLabel(row[@"detail"], NSMakeRect(200,y,400,height), YES);
        [content addSubview:detail];
        y += height;
    }
    [content setFrameSize:NSMakeSize(620,y+16)];
    IsobarAboutWindow *window = [[IsobarAboutWindow alloc] initWithContentRect:content.bounds
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:YES];
    window.title = @"About Isobar"; window.releasedWhenClosed = NO;
    window.restorable = NO; window.contentView = content;
    return window;
}

static void AboutRestore(IsobarAboutWindow *window) {
    NSWindow *previous = window.previousWindow; window.previousWindow = nil;
    [window orderOut:nil];
    if (previous) { [previous makeKeyAndOrderFront:nil]; [previous makeFirstResponder:previous.firstResponder]; }
}

@implementation IsobarAboutWindow
- (void)sendEvent:(NSEvent *)event {
    if (event.type == NSEventTypeKeyDown && event.keyCode == 53) { [self close]; return; }
    [super sendEvent:event];
}
- (void)cancelOperation:(id _Nullable)sender { (void)sender; [self close]; }
- (void)close { AboutRestore(self); }
@end

static void AboutWindowPresent(NSWindow * _Nullable parent) {
    static IsobarAboutWindow *window;
    if (!window) window = (IsobarAboutWindow *)AboutWindowCreate();
    if (parent != window) window.previousWindow = parent;
    [window center];
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

#endif
NS_ASSUME_NONNULL_END

#endif
