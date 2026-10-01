#import <Cocoa/Cocoa.h>

// A 1.5pt playhead line. Frame changes do not redraw or re-lay out the graph.
static inline void PlaceVerticalCursor(NSView *host, NSView *__strong *slot, CGFloat x, CGFloat y, CGFloat height) {
    if (!host || !slot) return;
    NSView *line = *slot;
    if (!line) {
        line = [[NSView alloc] initWithFrame:NSZeroRect];
        line.wantsLayer = YES;
        line.accessibilityIdentifier = @"playhead.cursor";
        line.accessibilityElement = NO;
        [host addSubview:line];
        *slot = line;
    } else if (line.superview != host) {
        [host addSubview:line];
    }
    line.layer.backgroundColor = [[NSColor.systemBlueColor colorWithAlphaComponent:.55] CGColor];
    BOOL visible = isfinite(x) && height > 1 && NSWidth(host.bounds) > 1 && NSHeight(host.bounds) > 1;
    if (!visible) {
        line.hidden = YES;
        return;
    }
    NSRect frame = NSMakeRect(x - 0.75, y, 1.5, height);
    line.hidden = NO;
    if (!NSEqualRects(line.frame, frame)) line.frame = frame;
}
