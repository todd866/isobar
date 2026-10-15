#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// Compact, non-activating note editor used after a feedback snapshot. The
// caller owns the capture and persistence; this panel only returns the note.
@interface FeedbackNotePanel : NSPanel <NSTextFieldDelegate>
@property (nonatomic, readonly) NSTextField *noteField;
- (instancetype)initWithThumbnail:(nullable NSImage *)thumbnail
                         completion:(void (^)(NSString * _Nullable note))completion;
- (void)showSaved;
- (void)showError:(NSString *)error;
@end

NS_ASSUME_NONNULL_END
