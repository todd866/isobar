#import "feedbackview.h"

@interface FeedbackNotePanel ()
@property (nonatomic, strong) NSTextField *noteField;
@property (nonatomic, copy) void (^completion)(NSString * _Nullable note);
@property (nonatomic, strong) NSImageView *thumbnailView;
@property (nonatomic, strong) NSImageView *errorMark;
@property (nonatomic) BOOL deliverySuspended;
@end

@interface FeedbackPanelBackgroundView : NSView
@end
@implementation FeedbackPanelBackgroundView
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    [NSColor.windowBackgroundColor setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 0.5, 0.5) xRadius:8 yRadius:8] fill];
}
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
@end

@implementation FeedbackNotePanel

- (instancetype)initWithThumbnail:(NSImage *)thumbnail
                         completion:(void (^)(NSString * _Nullable note))completion {
    self = [super initWithContentRect:NSMakeRect(0, 0, 560, 64)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered defer:NO];
    if (!self) return nil;
    _completion = [completion copy];
    self.floatingPanel = YES;
    self.level = NSStatusWindowLevel;
    self.hidesOnDeactivate = NO;
    self.becomesKeyOnlyIfNeeded = NO;
    self.releasedWhenClosed = NO;
    self.backgroundColor = NSColor.clearColor;
    self.hasShadow = YES;

    NSView *content = [[FeedbackPanelBackgroundView alloc] initWithFrame:self.contentView.bounds];
    content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.contentView = content;

    _thumbnailView = [[NSImageView alloc] initWithFrame:NSMakeRect(10, 10, 64, 44)];
    _thumbnailView.imageScaling = NSImageScaleProportionallyUpOrDown;
    _thumbnailView.imageAlignment = NSImageAlignCenter;
    _thumbnailView.image = thumbnail ?: [NSImage imageWithSystemSymbolName:@"photo" accessibilityDescription:@"Feedback capture"];
    _thumbnailView.accessibilityLabel = @"Feedback capture thumbnail";
    _thumbnailView.wantsLayer = YES;
    _thumbnailView.layer.cornerRadius = 4;
    _thumbnailView.layer.masksToBounds = YES;
    _thumbnailView.layer.backgroundColor = NSColor.quaternaryLabelColor.CGColor;
    [content addSubview:_thumbnailView];

    _noteField = [[NSTextField alloc] initWithFrame:NSMakeRect(86, 17, 414, 30)];
    _noteField.placeholderString = @"What went wrong?";
    _noteField.font = [NSFont systemFontOfSize:14];
    _noteField.bordered = YES;
    _noteField.bezeled = YES;
    _noteField.focusRingType = NSFocusRingTypeDefault;
    _noteField.usesSingleLineMode = YES;
    _noteField.lineBreakMode = NSLineBreakByTruncatingTail;
    _noteField.delegate = self;
    _noteField.accessibilityLabel = @"Feedback note";
    _noteField.accessibilityIdentifier = @"feedback.note";
    [content addSubview:_noteField];
    _errorMark = [[NSImageView alloc] initWithFrame:NSMakeRect(510, 23, 22, 22)];
    _errorMark.image = [NSImage imageWithSystemSymbolName:@"exclamationmark.triangle.fill" accessibilityDescription:@"Feedback save error"];
    _errorMark.contentTintColor = NSColor.systemRedColor;
    _errorMark.imageScaling = NSImageScaleProportionallyDown;
    _errorMark.hidden = YES;
    _errorMark.accessibilityLabel = @"Feedback save error";
    [content addSubview:_errorMark];
    return self;
}

- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }

- (void)finishWithNote:(NSString *)note {
    if (self.deliverySuspended) return;
    void (^completion)(NSString *) = self.completion;
    if (completion) completion(note);
}

- (BOOL)control:(NSControl *)control textView:(NSTextView *)textView
  doCommandBySelector:(SEL)commandSelector {
    (void)control; (void)textView;
    if (commandSelector == @selector(insertNewline:)) {
        [self.noteField validateEditing];
        [self finishWithNote:self.noteField.stringValue ?: @""];
        return YES;
    }
    if (commandSelector == @selector(cancelOperation:)) {
        [self finishWithNote:nil];
        return YES;
    }
    return NO;
}

- (void)showSaved {
    self.deliverySuspended = YES;
    self.errorMark.hidden = YES;
    self.noteField.stringValue = @"Feedback saved";
    self.noteField.editable = NO;
    self.noteField.selectable = NO;
    self.noteField.textColor = NSColor.secondaryLabelColor;
    self.noteField.toolTip = nil;
}

- (void)showError:(NSString *)error {
    self.deliverySuspended = NO;
    self.errorMark.hidden = NO;
    self.noteField.editable = YES;
    self.noteField.selectable = YES;
    self.noteField.textColor = NSColor.labelColor;
    self.noteField.toolTip = error.length ? error : @"Could not save feedback";
    self.errorMark.toolTip = self.noteField.toolTip;
    [self makeFirstResponder:self.noteField];
}

@end
