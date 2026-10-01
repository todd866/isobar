#import <Cocoa/Cocoa.h>

@protocol FullscreenWindowController <NSObject>
- (void)escapeFullscreen;
- (void)stepFullscreenPanel:(NSInteger)delta;
- (void)toggleChartLoop;
- (void)toggleIssueCompare;
- (void)toggleChartSource;
- (void)closeChartWindow;
- (void)zoomChart:(int)direction;
@end

@interface FullscreenWindow : NSWindow
@property (nonatomic, weak) id<FullscreenWindowController> controller;
@end
