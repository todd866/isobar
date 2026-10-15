#import <Cocoa/Cocoa.h>

// Native wind triangle, degrees true / knots. Blank or invalid inputs clear
// every readout. No weather state or learner progress is read or changed.
@interface E6BView : NSView <NSTextFieldDelegate>
- (void)updateReadouts;
@end
// Handles Escape even while a numeric field editor is active.
@interface E6BPanel : NSPanel
@end

// A sheet preserves its parent surface; Close and Escape end only this sheet.
void E6BWindowPresent(NSWindow *parent, void (^onClose)(void));
