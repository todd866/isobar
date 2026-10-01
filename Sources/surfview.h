#import <Cocoa/Cocoa.h>
NS_ASSUME_NONNULL_BEGIN
NSDictionary *SurfOutlook(NSDictionary * _Nullable product, NSDate * _Nullable now);
// Surf wind is drawn in the label colour, not the kite band.
NSColor *SurfWindInk(void);
@interface SurfForecastView : NSView <NSViewToolTipOwner>
@property(nonatomic, copy) NSDictionary *outlook;
@property(nonatomic, copy) NSArray<NSDictionary *> *windRows;
@property(nonatomic, strong, nullable) NSDate *now;
@property(nonatomic, strong, nullable) NSDate *selectedDate;
@property(nonatomic) double horizonHours;
@property(nonatomic, strong, nullable) NSTimeZone *timeZone;
- (nullable NSString *)summaryAtPoint:(NSPoint)point;
- (NSRect)plotRect;
- (CGFloat)cursorXForDate:(nullable NSDate *)date;
@end
NS_ASSUME_NONNULL_END
