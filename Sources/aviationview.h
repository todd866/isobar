#import <Cocoa/Cocoa.h>

typedef struct {
    CGFloat groundY, ceilingY;
    NSPoint visibilityStart, visibilityEnd;
    CGFloat visibilityMaxX;
} AviationSceneGeometry;
AviationSceneGeometry AviationSceneLayout(NSRect rect, NSDictionary *period, double maximumFeet);

@interface AviationForecastView : NSView <NSViewToolTipOwner>
@property(nonatomic, copy) NSArray<NSDictionary *> *periods;
@property(nonatomic, strong) NSDate *now;
@property(nonatomic, strong) NSDate *selectedDate;
@property(nonatomic, strong) NSDate *windowStart;
@property(nonatomic) BOOL showsTimeline;
@property(nonatomic, copy) void (^onPreviewDate)(NSDate *date);
@property(nonatomic, copy) void (^onSelectDate)(NSDate *date);
@property(nonatomic, strong) NSTimeZone *timeZone;
@property(nonatomic, copy) NSString *status;
// Airport coordinates; unknown defaults to NaN, never a guessed location.
@property(nonatomic) double latitude;
@property(nonatomic) double longitude;
// Full title for the summary: "YSSY TAF · Civil night · BCT 06:00".
// The drawn sky title shortens ("TAF · night") when that string does not fit.
@property(nonatomic, copy) NSString *airportCode;
- (NSString *)graphicTitleAtDate:(NSDate *)date;
- (NSString *)skyTitleAtDate:(NSDate *)date width:(CGFloat)width;
- (NSDictionary *)daylightAtDate:(NSDate *)date;
@property(nonatomic, copy) void (^onInspect)(NSString *summary);
@property(nonatomic) NSInteger selectedCloudIndex;
@property(nonatomic, readonly) NSString *aircraftAssetName;
@property(nonatomic, readonly) BOOL animationRunning;
@property(nonatomic, readonly) NSTimeInterval animationPhase;
// A change of active TAF groups animates the scene, never a picture of it:
// paired cloud decks glide lowest to lowest over 0.9 s, panels re-lay out,
// and light follows the displayed time. Reduce Motion, a view outside a
// window and the first draw show the new state at once. Offscreen replay
// drives this clock with explicit frame times.
- (void)advanceAnimationAtTime:(NSTimeInterval)time;
- (void)inspectDate:(NSDate *)date;
- (NSString *)summaryAtDate:(NSDate *)date;
- (NSArray<NSDictionary *> *)activePeriodsAtDate:(NSDate *)date;
- (NSRect)timelineRect;
- (CGFloat)cursorXForDate:(NSDate *)date;
@end

// The Fly panel: airport identity, the cloud graphic, and the issued text.
@interface AviationLensView : NSView
// Reserve the close control on the airport row when embedded in a lens card.
@property(nonatomic) CGFloat headerTrailingInset;
@property(nonatomic, copy) NSDictionary *place;
@property(nonatomic, copy) NSDictionary *aerodrome;
@property(nonatomic, copy) NSArray<NSDictionary *> *aerodromes;
@property(nonatomic, copy) NSDictionary *aviation;
// Notice products are supplied by the controller so the links can show the
// same current counts as the Notices window.
@property(nonatomic, copy) NSDictionary *notams;
@property(nonatomic, copy) NSDictionary *sigmets;
@property(nonatomic, strong) NSDate *now;
@property(nonatomic, strong) NSDate *playhead;
@property(nonatomic, strong) NSTimeZone *placeZone;
@property(nonatomic, readonly) AviationForecastView *forecast;
@property(nonatomic, readonly) NSTextView *bulletin;
@property(nonatomic, readonly) NSTextField *timeField;
@property(nonatomic, readonly) NSPopUpButton *airportButton;
@property(nonatomic, readonly) NSButton *nearestButton;
@property(nonatomic, copy) void (^onChooseAerodrome)(NSString *code);
@property(nonatomic, copy) void (^onShowNearest)(NSString *code);
@property(nonatomic, copy) void (^onNotices)(NSInteger sigmet);
@property(nonatomic, copy) void (^onSource)(id sender);
@property(nonatomic, copy) void (^onAtmosphere)(id sender);
- (void)reload;
// Natural card height for a given width, including the issued text that is
// currently loaded. Controllers can use this to avoid reserving blank space.
- (CGFloat)fittingHeightForWidth:(CGFloat)width;
@end
