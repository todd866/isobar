#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// Seven local-day segments, one shared forecast clock. The row is 34 pt high;
// rain units and full day names remain in accessibility labels and tooltips.
// `hours` is retained for source compatibility; it never creates a second row.
@interface DayStripView : NSView
@property (nonatomic, copy) NSArray<NSDictionary *> *days;
@property (nonatomic, copy, nullable) NSArray<NSDictionary *> *hours;
@property (nonatomic, copy, nullable) NSArray<NSDictionary *> *series;
@property (nonatomic) NSInteger selectedIndex;
@property (nonatomic, strong, nullable) NSDate *playhead;
@property (nonatomic, strong, nullable) NSDate *timelineStart;
@property (nonatomic, strong, nullable) NSDate *timelineEnd;
@property (nonatomic, readonly) NSInteger highlightedDayIndex;
@property (nonatomic, readonly) double playheadTemperature;
@property (nonatomic, readonly) NSInteger hoverIndex;
@property (nonatomic, strong, nullable) NSTimeZone *timeZone;
@property (nonatomic, copy, nullable) void (^onSelect)(NSInteger index);
// -1 when the pointer leaves the cells. Hover does not change the selection.
@property (nonatomic, copy, nullable) void (^onHover)(NSInteger index);
// Fraction callbacks use the actual linear timeline from timelineStart to
// timelineEnd. Preview callbacks receive NAN when hover leaves the strip.
@property (nonatomic, copy, nullable) void (^onPreviewFraction)(double fraction);
@property (nonatomic, copy, nullable) void (^onSelectFraction)(double fraction);
// Normalized horizontal position in the local-day segments.
- (double)positionForDate:(NSDate *)date;
- (NSString *)accessibilityLabelForDay:(NSInteger)index;
@end

// Linear temperature between hourly points. NAN outside the series, never extrapolated.
double DayStripTemperatureAtDate(NSArray<NSDictionary *> *_Nullable series, NSDate *_Nullable date);
// Nearest finite row within `limit` seconds. Nil when none is that close.
NSDictionary *_Nullable DayStripSampleAtDate(NSArray<NSDictionary *> *_Nullable series, NSDate *_Nullable date, NSTimeInterval limit);

NS_ASSUME_NONNULL_END
