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

typedef NS_ENUM(NSInteger, ChartKeyAction) {
    ChartKeyPass = 0,
    ChartKeyDrop,
    ChartKeyEscape,
    ChartKeyLeft,
    ChartKeyRight,
    ChartKeyPlay,
    ChartKeyCompare,
    ChartKeySource,
};

// Space repeats are ignored. Arrow repeats step at most once per 150 ms.
// Command-D and Command-B are not chart shortcuts.
ChartKeyAction ChartKeyActionFor(unsigned short keyCode, NSString *characters, NSEventModifierFlags flags,
    BOOL isRepeat, NSTimeInterval now, NSTimeInterval *lastArrow);

@interface FullscreenWindow : NSWindow
@property (nonatomic, weak) id<FullscreenWindowController> controller;
@end
