#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// Seven local days. Each day uses StorePointDays keys. `hours` is the selected
// day's point series (time, temp, rainMm, weatherCode); nil hides the detail row.
@interface DayStripView : NSView
@property (nonatomic, copy) NSArray<NSDictionary *> *days;
@property (nonatomic, copy, nullable) NSArray<NSDictionary *> *hours;
@property (nonatomic) NSInteger selectedIndex;
@property (nonatomic, strong, nullable) NSTimeZone *timeZone;
@property (nonatomic, copy, nullable) void (^onSelect)(NSInteger index);
- (NSString *)accessibilityLabelForDay:(NSInteger)index;
@end

NS_ASSUME_NONNULL_END
