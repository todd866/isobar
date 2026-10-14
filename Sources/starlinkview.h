#import <Cocoa/Cocoa.h>
#import "starlink.h"

NS_ASSUME_NONNULL_BEGIN

// The Sat lens panel (owner pick "A", 14 Oct 2026): a sky dome above two
// instrument rows. The dome is the sky from home, zenith at the centre: the
// patch the dish has used (amber where blocked), every Starlink satellite
// above the horizon, the dish boresight (+), and the serving satellite ringed
// with its path from one minute before to one minute after. The handover
// clock sits top left: seconds to the next 15 s reschedule.
//
// Rows: [satellite] serving number · elevation and slant range, then
// [ping] latency · down/up throughput. Missing stays "—" with the reason in
// the tooltip. A satellite identified in an earlier slot is muted and says how
// long ago; it is never shown as the current link.
@interface StarlinkLensView : NSView
@property (nonatomic, strong, nullable) StarlinkCatalog *catalog;
@property (nonatomic, copy, nullable) NSDictionary *status;
@property (nonatomic, copy, nullable) NSDictionary *obstructionMap;
@property (nonatomic, copy, nullable) NSDictionary *serving;
@property (nonatomic, copy, nullable) NSString *dishError;
@property (nonatomic, copy, nullable) NSString *catalogError;
@property (nonatomic) double latitude, longitude;
@property (nonatomic, strong) NSDate *now;
// Natural height for a width.
- (CGFloat)fittingHeightForWidth:(CGFloat)width;
// Visible text, for tests: {serving, servingDatum, ping, pingDatum, clock}.
@property (nonatomic, readonly, copy) NSDictionary<NSString *, NSString *> *readings;
// Satellites drawn in the dome on the last draw.
@property (nonatomic, readonly) NSUInteger drawnSatellites;
@end

// The serving satellite's state at `now`: {name, short, current (BOOL),
// age (s since its slot ended, 0 when current), look: {el, az, rangeKm,
// latitude, longitude}}. Nil without an identification or catalogue.
NSDictionary * _Nullable StarlinkServingState(StarlinkCatalog * _Nullable catalog, NSDictionary * _Nullable serving,
    NSDate *now, double latitude, double longitude);

NS_ASSUME_NONNULL_END
