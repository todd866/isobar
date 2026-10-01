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
- (NSDictionary *)daylightAtDate:(NSDate *)date;
@property(nonatomic, copy) void (^onInspect)(NSString *summary);
@property(nonatomic) NSInteger selectedCloudIndex;
@property(nonatomic, readonly) NSString *aircraftAssetName;
@property(nonatomic, readonly) BOOL animationRunning;
@property(nonatomic, readonly) NSTimeInterval animationPhase;
- (void)advanceAnimationAtTime:(NSTimeInterval)time;
- (void)inspectDate:(NSDate *)date;
- (NSString *)summaryAtDate:(NSDate *)date;
- (NSArray<NSDictionary *> *)activePeriodsAtDate:(NSDate *)date;
- (NSRect)timelineRect;
@end
