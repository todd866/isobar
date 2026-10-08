#import <Cocoa/Cocoa.h>
#import "traffic.h"
NS_ASSUME_NONNULL_BEGIN
@interface AtmosphereView : NSView <NSViewToolTipOwner>
@property(nonatomic, copy) NSDictionary *product;
@property(nonatomic, strong) NSDate *now;
@property(nonatomic, strong) NSTimeZone *timeZone;
@property(nonatomic) double latitude;
@property(nonatomic) double longitude;
@property(nonatomic, copy, nullable) void (^onInspect)(NSString *summary);
@property(nonatomic, strong, nullable) AirborneTraffic *trafficClient;
@property(nonatomic, copy, nullable) NSDictionary *trafficSnapshot;
@property(nonatomic) BOOL trafficEnabled;
// The sky section (docs/design/sky-section.md). When set it covers the cloud
// lane, the height axis becomes the section's (surface to FL450, the same
// curve as its picture), and the illustrated aircraft and live traffic go;
// wind, vertical motion and temperature stay beside it on the same heights.
@property(nonatomic, strong, nullable) NSView *sectionView;
// The time to show changed (inspectDate).
@property(nonatomic, copy, nullable) void (^onDate)(NSDate *date);
- (NSRect)sectionRect;
- (double)heightForY:(CGFloat)y;
@property(nonatomic, readonly) NSDate *selectedDate;
@property(nonatomic, readonly) NSInteger selectedLevelIndex;
@property(nonatomic, readonly) BOOL animationRunning;
- (void)inspectDate:(NSDate *)date;
- (NSRect)plotRect;
- (NSRect)timelineRect;
- (NSArray<NSValue *> *)aircraftMarkerRects;
- (NSArray<NSDictionary *> *)liveAircraft;
- (NSArray<NSValue *> *)liveAircraftRects;
- (nullable NSString *)hoverCardSummary;
- (NSRect)hoverCardRect;
- (CGFloat)yForHeight:(double)height;
- (void)advanceAnimationAtTime:(NSTimeInterval)time;
@end
NS_ASSUME_NONNULL_END
