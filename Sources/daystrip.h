#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// Seven local days. Each day uses StorePointDays keys. `hours` is the selected
// day's point series (time, temp, rainMm, weatherCode); nil hides the detail row.
// `series` is the place's hourly points. The playhead highlight and temperature
// dot move without rebuilding the cells.
@interface DayStripView : NSView
@property (nonatomic, copy) NSArray<NSDictionary *> *days;
@property (nonatomic, copy, nullable) NSArray<NSDictionary *> *hours;
@property (nonatomic, copy, nullable) NSArray<NSDictionary *> *series;
@property (nonatomic) NSInteger selectedIndex;
@property (nonatomic, strong, nullable) NSDate *playhead;
@property (nonatomic, readonly) NSInteger highlightedDayIndex;
@property (nonatomic, readonly) double playheadTemperature;
@property (nonatomic, readonly) NSInteger hoverIndex;
@property (nonatomic, strong, nullable) NSTimeZone *timeZone;
@property (nonatomic, copy, nullable) void (^onSelect)(NSInteger index);
// -1 when the pointer leaves the cells. Hover does not change the selection.
@property (nonatomic, copy, nullable) void (^onHover)(NSInteger index);
- (NSString *)accessibilityLabelForDay:(NSInteger)index;
@end

// Linear temperature between hourly points. NAN outside the series, never extrapolated.
double DayStripTemperatureAtDate(NSArray<NSDictionary *> *_Nullable series, NSDate *_Nullable date);
// Nearest finite row within `limit` seconds. Nil when none is that close.
NSDictionary *_Nullable DayStripSampleAtDate(NSArray<NSDictionary *> *_Nullable series, NSDate *_Nullable date, NSTimeInterval limit);

NS_ASSUME_NONNULL_END
