#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Geometric altitude of the sun's centre in degrees at an absolute instant.
/// Returns NAN for invalid coordinates or a missing date. Longitude is east-positive.
double SolarElevation(double latitude, double longitude, NSDate * _Nullable instant);

/// Civil-light state for the local civil date containing `instant`.
///
/// The returned dictionary contains `state` (day, civilTwilight, or night),
/// `altitudeDegrees`, and `civilDawn`/`civilDusk` NSDate values when the local
/// date has those events, plus `sunrise`/`sunset` using the conventional
/// apparent solar threshold. `state` reaches `day` at that apparent sunrise
/// threshold. Civil twilight uses the aviation convention of the
/// sun's geometric centre at -6 degrees; no refraction is added to that
/// threshold. The event values are nil on polar days/nights and are omitted
/// from the dictionary in that case. `timeZone` only chooses the local civil
/// date; the calculation itself is UTC based.
NSDictionary<NSString *, id> * _Nullable SolarDaylight(double latitude, double longitude,
                                                        NSDate * _Nullable instant,
                                                        NSTimeZone * _Nullable timeZone);

NS_ASSUME_NONNULL_END
