// Render the two-panel popover offscreen. Does not create a status item.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"
#define main IsobarApplicationMain
#import "../Sources/main.m"
#undef main
#pragma clang diagnostic pop

static NSView *FindID(NSView *view, NSString *identifier) {
    if ([view.accessibilityIdentifier isEqual:identifier]) return view;
    for (NSView *child in view.subviews) {
        NSView *hit = FindID(child, identifier);
        if (hit) return hit;
    }
    return nil;
}

static BOOL HasText(NSView *view, NSString *text) {
    if ([view isKindOfClass:NSTextField.class] && [((NSTextField *)view).stringValue containsString:text]) return YES;
    if ([view isKindOfClass:NSButton.class] && [((NSButton *)view).title containsString:text]) return YES;
    if ([view isKindOfClass:NSButton.class] && [((NSButton *)view).attributedTitle.string containsString:text]) return YES;
    for (NSView *child in view.subviews) if (HasText(child, text)) return YES;
    return NO;
}

static BOOL LegendFits(NSView *legend) {
    if (!legend) return NO;
    for (NSView *child in legend.subviews) {
        if (![child isKindOfClass:NSTextField.class]) continue;
        NSTextField *field = (NSTextField *)child;
        if (!field.stringValue.length || !field.font) continue;
        CGFloat need = ceil([field.stringValue sizeWithAttributes:@{NSFontAttributeName: field.font}].width);
        if (field.frame.size.width + 0.5 < need) return NO;
    }
    return YES;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 3) {
            fprintf(stderr, "usage: render-popover light.png dark.png\n");
            return 64;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *dir = [NSString stringWithUTF8String:getenv("ISOBAR_FIXTURES") ?: "Tests/fixtures"];
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        NSDate *now = [iso dateFromString:@"2026-09-26T00:30:00Z"];
        Controller *c = [Controller new];
        [c replaceLocations:DefaultLocations()];
        [c setChartNow:now];
        [c reloadStoreAtPath:[dir stringByAppendingPathComponent:@"store"]];
        [c rebuildContent];
        NSView *root = c.popover.contentViewController.view;
        NSView *left = FindID(root, @"popover.chart");
        NSView *right = FindID(root, @"popover.chart.right");
        NSView *timeline = FindID(root, @"popover.timeline");
        BOOL wide = left.frame.size.width >= 420 && right.frame.size.width >= 420;
        BOOL paired = left && right && !left.hidden && !right.hidden
            && fabs(left.frame.origin.y - right.frame.origin.y) < 1
            && fabs(left.frame.size.width - right.frame.size.width) < 1
            && fabs(left.frame.size.height - right.frame.size.height) < 1;
        BOOL times = timeline && timeline.frame.size.height >= 40 && timeline.frame.size.width > 400;
        NSTextField *leftTitle = (NSTextField *)FindID(root, @"popover.title.left");
        NSTextField *rightTitle = (NSTextField *)FindID(root, @"popover.title.right");
        NSString *heading = leftTitle.attributedStringValue.string;
        if (!heading.length) heading = leftTitle.stringValue;
        NSString *rightHeading = rightTitle.attributedStringValue.string;
        if (!rightHeading.length) rightHeading = rightTitle.stringValue;
        NSView *layers = FindID(root, @"popover.layers");
        NSView *legend = FindID(root, @"chart.legend");
        BOOL nowHeader = [heading hasPrefix:@"Now"] && [heading containsString:@"8 am"]
            && ![heading containsString:@"AWST"] && ![heading containsString:@"+"];
        BOOL tonight = [rightHeading containsString:@"Tonight"] && [rightHeading containsString:@"8 pm"];
        BOOL legendRow = legend && layers && fabs(legend.frame.origin.y - layers.frame.origin.y) < 2
            && HasText(legend, @"at least 1 mm")
            && HasText(legend, @"850 hPa (~5,000 ft)")
            && !HasText(legend, @"aloft")
            && LegendFits(legend)
            && !NSIntersectsRect(NSInsetRect(legend.frame, -1, -1), left.frame)
            && !NSIntersectsRect(NSInsetRect(legend.frame, -1, -1), right.frame);
        BOOL answers = FindID(root, @"popover.rain") && FindID(root, @"popover.windForecast")
            && FindID(root, @"popover.forecastMode") && !HasText(root, @"situational awareness")
            && !FindID(root, @"popover.headline");
        if (!wide || !paired || !times || !nowHeader || !tonight || !answers || HasText(root, @"analysis") ||
            HasText(root, @"AEST") || HasText(root, @"AWST") || HasText(root, @"+12") || HasText(root, @"+66") ||
            HasText(root, @"T850") || HasText(root, @"Settings") ||
            !HasText(root, @"Perth") || !HasText(root, @"Sydney") || !legendRow ||
            !HasText(root, @"‹") || !HasText(root, @"›") ||
            !FindID(root, @"popover.obs") || !FindID(root, @"popover.settings") ||
            FindID(root, @"popover.layer.t850") ||
            HasText(root, @"Feels like") || FindID(root, @"popover.hourly") || FindID(root, @"popover.forecast")) {
            fprintf(stderr, "popover left %.0fx%.0f right %.0fx%.0f root %.0fx%.0f wide=%d paired=%d times=%d now=%d tonight=%d legend=%d answers=%d\n",
                left.frame.size.width, left.frame.size.height, right.frame.size.width, right.frame.size.height,
                root.bounds.size.width, root.bounds.size.height, wide, paired, times, nowHeader, tonight, legendRow, answers);
            fprintf(stderr, "heading: %s | %s\n", heading.UTF8String ?: "(nil)", rightHeading.UTF8String ?: "(nil)");
            return 1;
        }
        NSArray *names = @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua];
        for (NSUInteger i = 0; i < 2; i++) {
            root.appearance = [NSAppearance appearanceNamed:names[i]];
            [root layoutSubtreeIfNeeded];
            [root display];
            NSBitmapImageRep *rep = [root bitmapImageRepForCachingDisplayInRect:root.bounds];
            [root cacheDisplayInRect:root.bounds toBitmapImageRep:rep];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            if (![png writeToFile:[NSString stringWithUTF8String:argv[i + 1]] atomically:YES]) return 1;
            printf("wrote %s (%ldx%ld) panels %.0f and %.0f\n", argv[i + 1],
                (long)rep.pixelsWide, (long)rep.pixelsHigh, left.frame.size.width, right.frame.size.width);
        }
    }
    return 0;
}
