#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// A shaft-and-head arrow centred on the reading, north up, pointing downwind.
// Length is the full tip-to-tail distance in points.
NSBezierPath * _Nullable KiteWindArrowPath(NSPoint centre, double windFromDegrees, CGFloat length);
// Seabreeze-style strength bands: <12 kt red, 12–18 yellow, 18+ green.
NSColor *KiteWindSpeedColour(double knots);

// A compact two-lane forecast: wind is the main plot and rain is the hourly
// strip beneath it. Rows are dictionaries containing the keys documented here.
@interface HourlyForecastView : NSView <NSViewToolTipOwner>

@property(nonatomic, copy) NSArray<NSDictionary *> *windRows;
@property(nonatomic, copy) NSArray<NSDictionary *> *rainRows;
@property(nonatomic, strong, nullable) NSDate *now;
@property(nonatomic, strong, nullable) NSDate *selectedDate;
@property(nonatomic) double horizonHours;
@property(nonatomic, strong, nullable) NSTimeZone *timeZone;
@property(nonatomic) double minKt;
@property(nonatomic) double maxKt;
@property(nonatomic) double shoreNormal;
@property(nonatomic) BOOL hasShore;

- (NSRect)windPlotRect;
- (nullable NSString *)summaryAtPoint:(NSPoint)point;

@end

NS_ASSUME_NONNULL_END
