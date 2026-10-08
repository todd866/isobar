#import <Cocoa/Cocoa.h>

// Training window. The popover Train button calls TrainingWindowPresent with
// the chart's store and clock. The page is the bundled trainer
// (Resources/training, or ISOBAR_TRAINING_DIST in a harness) loaded from disk.
// Progress is TrainingProgressPath(), not web localStorage. A harness whose
// activation policy is prohibited gets the window offscreen and a temporary
// progress file, so it does not open on the desktop or write the pilot's
// training.json. now nil follows TrainingSnapshot's clock.
//
// The on-screen window is a standard titled window (TrainingWindowConfigure):
// about 1280×820, minimum 960×640, centred until a saved frame exists. The
// green button can enter full screen; opening the window does not.
void TrainingWindowPresent(NSString *storeRoot, NSDate *now);
void TrainingWindowDismiss(void);
void TrainingWindowConfigure(NSWindow *window);

// Offscreen capture. The window is moved off the desktop and ordered out
// after the snapshot. progressPath nil uses a private temporary file so a
// capture does not write the pilot's training.json.
BOOL TrainingWindowRenderOffscreen(NSString *storeRoot, NSString *webRoot, NSString *coastPath,
    NSString *appearance, NSSize size, NSString *pngPath, NSString *progressPath, NSString **error);
