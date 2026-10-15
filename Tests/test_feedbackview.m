#import <Cocoa/Cocoa.h>
#import "../Sources/feedbackview.h"

static int failures;
static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static NSData *Render(FeedbackNotePanel *panel, NSString *appearance, NSString *name) {
    panel.appearance = [NSAppearance appearanceNamed:appearance];
    NSView *view = panel.contentView;
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [panel.appearance performAsCurrentDrawingAppearance:^{
        [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    }];
    [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa"
                               withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    Check([png writeToFile:[@"build/qa" stringByAppendingPathComponent:name] atomically:YES],
          [NSString stringWithFormat:@"render %@", name]);
    return png;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        __block NSString *submitted = nil;
        FeedbackNotePanel *panel = [[FeedbackNotePanel alloc] initWithThumbnail:nil completion:^(NSString *note) {
            submitted = [note copy];
        }];
        Check(NSWidth(panel.contentView.bounds) == 560 && NSHeight(panel.contentView.bounds) == 64,
              @"panel is the compact 560x64 surface");
        Check(NSWidth(panel.noteField.frame) > 400 && NSMaxX(panel.noteField.frame) <= NSWidth(panel.contentView.bounds),
              @"note field fits the row");
        Check([panel.noteField.accessibilityLabel isEqual:@"Feedback note"], @"note field is accessible");
        panel.noteField.stringValue = @"Map jumped after scrubbing";
        [panel control:panel.noteField textView:[NSTextView new] doCommandBySelector:@selector(insertNewline:)];
        Check([submitted isEqual:@"Map jumped after scrubbing"], @"Enter returns the note");

        __block NSString *cancelled = @"sentinel";
        FeedbackNotePanel *discard = [[FeedbackNotePanel alloc] initWithThumbnail:nil completion:^(NSString *note) {
            cancelled = note;
        }];
        [discard control:discard.noteField textView:[NSTextView new] doCommandBySelector:@selector(cancelOperation:)];
        Check(cancelled == nil, @"Escape discards with nil");
        [panel showSaved];
        Check([panel.noteField.stringValue isEqual:@"Feedback saved"] && !panel.noteField.editable,
              @"saved state is compact and read-only");
        [discard showError:@"Inbox unavailable"];
        Check([discard.noteField.toolTip isEqual:@"Inbox unavailable"] && discard.noteField.editable,
              @"error preserves editable note field");
        discard.noteField.stringValue = @"Retry this save";
        [discard control:discard.noteField textView:[NSTextView new] doCommandBySelector:@selector(insertNewline:)];
        Check([cancelled isEqual:@"Retry this save"], @"error state permits retry with Enter");
        FeedbackNotePanel *editor = [[FeedbackNotePanel alloc] initWithThumbnail:nil completion:^(NSString *note) { (void)note; }];
        editor.noteField.stringValue = @"Map jumped after scrubbing";
        NSData *light = Render(editor, NSAppearanceNameAqua, @"feedback-light.png");
        NSData *dark = Render(editor, NSAppearanceNameDarkAqua, @"feedback-dark.png");
        Check(![light isEqualToData:dark], @"dark appearance changes the rendered panel");
    }
    if (failures) return 1;
    puts("feedback view tests passed");
    return 0;
}
