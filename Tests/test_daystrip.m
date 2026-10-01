// The day strip's range is a hairline and a temperature gradient. Offscreen.
#import <Cocoa/Cocoa.h>
#import "../Sources/daystrip.h"

static int failures;
static void Check(BOOL ok, const char *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message);
    if (!ok) failures++;
}

@interface StripBackdrop : NSView
@end
@implementation StripBackdrop
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [NSColor.windowBackgroundColor setFill];
    NSRectFill(self.bounds);
}
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        StripBackdrop *backdrop = [[StripBackdrop alloc] initWithFrame:NSMakeRect(0, 0, 320, 64)];
        backdrop.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        DayStripView *strip = [[DayStripView alloc] initWithFrame:backdrop.bounds];
        strip.days = @[
            @{@"weekday": @"Today", @"max": @12, @"min": @8, @"weatherCode": @1},
            @{@"weekday": @"Fri", @"max": @32, @"min": @28, @"weatherCode": @1, @"rainMm": @3},
        ];
        [backdrop addSubview:strip];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:backdrop.frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.appearance = backdrop.appearance;
        window.contentView = backdrop;
        [backdrop layoutSubtreeIfNeeded];
        [backdrop display];
        NSBitmapImageRep *rep = [backdrop bitmapImageRepForCachingDisplayInRect:backdrop.bounds];
        [backdrop cacheDisplayInRect:backdrop.bounds toBitmapImageRep:rep];
        NSInteger wide = (NSInteger)rep.pixelsWide, high = (NSInteger)rep.pixelsHigh;
        if (high > 512) high = 512;
        NSInteger coolRows[512] = {0}, warmRows[512] = {0};
        for (NSInteger y = 0; y < high; y++) {
            for (NSInteger x = 0; x < wide; x++) {
                NSColor *color = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
                if (!color) continue;
                if (color.blueComponent > .55 && color.blueComponent > color.redComponent + .08) coolRows[y]++;
                if (color.redComponent > .7 && color.redComponent > color.blueComponent + .25) warmRows[y]++;
            }
        }
        NSInteger bar = -1, best = 0;
        for (NSInteger y = 0; y < high; y++) {
            NSInteger both = MIN(coolRows[y], warmRows[y]);
            if (both > best) { best = both; bar = y; }
        }
        double coolX = 0, warmX = 0;
        NSInteger coolN = 0, warmN = 0, trackN = 0;
        NSInteger y0 = MAX(0, bar - 1), y1 = MIN(high - 1, bar + 1);
        for (NSInteger y = y0; y <= y1 && bar >= 0; y++) {
            for (NSInteger x = 0; x < wide; x++) {
                NSColor *color = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
                if (!color) continue;
                double r = color.redComponent, g = color.greenComponent, b = color.blueComponent;
                BOOL cool = b > .55 && b > r + .08;
                BOOL warm = r > .7 && r > b + .25;
                if (cool) { coolX += x; coolN++; }
                if (warm) { warmX += x; warmN++; }
                double hi = MAX(r, MAX(g, b)), lo = MIN(r, MIN(g, b));
                double luma = .2126 * r + .7152 * g + .0722 * b;
                if (!cool && !warm && luma > .72 && hi - lo < .12) trackN++;
            }
        }
        fprintf(stderr, "day strip cool %ld warm %ld track %ld bar %ld\n",
            (long)coolN, (long)warmN, (long)trackN, (long)bar);
        Check([[strip accessibilityLabelForDay:0] containsString:@"Today"], "today stays labelled");
        Check(coolN > 8 && warmN > 8 && coolX / coolN < warmX / warmN, "the range runs cool to warm");
        Check(trackN > 12, "the range track is a light hairline");
        (void)window;
    }
    return failures ? 1 : 0;
}
