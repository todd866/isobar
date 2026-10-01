#import <Cocoa/Cocoa.h>

// Compact hourly rain chart. `outlook[@"hours"]` contains hourly dictionaries
// with start/end dates, known, mm, and kind values.
@interface RainForecastView : NSView <NSViewToolTipOwner>
@property(nonatomic, copy) NSDictionary *outlook;
@property(nonatomic, strong) NSDate *now;
@property(nonatomic, strong) NSDate *selectedDate;
@property(nonatomic, strong) NSDate *referenceNow;
@property(nonatomic) double horizonHours;
@property(nonatomic, strong) NSTimeZone *timeZone;
@property(nonatomic, copy) void (^onInspect)(NSString *summary);
- (void)inspectDate:(NSDate *)date;
- (NSString *)summaryAtDate:(NSDate *)date;
// Horizontal position of the shared playhead. NAN when `date` is outside the plot.
- (CGFloat)cursorXForDate:(NSDate *)date;
@end
