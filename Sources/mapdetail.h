#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// Point samples are only used within half an hourly forecast step. A missing
// sample remains missing; today's observation is never substituted.
NSDictionary * _Nullable MapDetailSample(NSArray<NSDictionary *> * _Nullable rows, NSDate * _Nullable valid);
// Each record has a kind, place and value, plus an optional downwind bearing.
void DrawMapDetails(NSArray<NSDictionary *> *records, NSRect bounds);
NSRect MapDetailsRect(NSUInteger count, NSRect bounds);

@interface TemperatureForecastView : NSView <NSViewToolTipOwner>
@property(nonatomic, copy) NSArray<NSDictionary *> *rows;
@property(nonatomic, strong, nullable) NSDate *now;
@property(nonatomic, strong, nullable) NSDate *selectedDate;
@property(nonatomic) double horizonHours;
@property(nonatomic, strong, nullable) NSTimeZone *timeZone;
- (NSRect)plotRect;
- (NSArray<NSArray<NSDictionary *> *> *)segments;
// One weekday label per local noon. Each dictionary has text, x, y and width.
// A noon closer than the label width plus 8 px to the previous label is omitted.
- (NSArray<NSDictionary<NSString *, id> *> *)dayLabels;
- (nullable NSString *)summaryAtPoint:(NSPoint)point;
- (CGFloat)cursorXForDate:(nullable NSDate *)date;
@end

NS_ASSUME_NONNULL_END
