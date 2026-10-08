#import <Foundation/Foundation.h>

// Compact, source-faithful METAR/TAF outlook for the aviation card.
// The returned dictionary contains observation, periods, detail and status.
// Periods include ceilingFt/ceilingState, visibilityM/visibilityAtLeast and
// cloudLayers (amount, baseFt, type); missing fields are NSNull, never implied zero.
NSDictionary *AviationOutlook(NSDictionary *aviation, NSDate *now, NSTimeZone *tz);

// Fly lens identity. A place has name, latitude, longitude and geohash.
// An aerodrome has code, name, latitude and longitude. Missing coordinates
// stay missing. `hasTAF` NO drops an aerodrome from the nearest choice.
NSString *FlyPlaceKey(NSDictionary *place);
NSString *FlyIdentityTitle(NSDictionary *aerodrome);
// "YPPH  21 km E". The aerodrome name stays in the tooltip.
NSString *FlyIdentityRow(NSDictionary *place, NSDictionary *aerodrome);
// "3,296 km E of Perth coast", or nil when either point has no position.
NSString *FlyDistancePhrase(NSDictionary *place, NSDictionary *aerodrome);
// "21 km E", or nil when either point has no position.
NSString *FlyDistanceCompact(NSDictionary *place, NSDictionary *aerodrome);
// Spoken form of the same distance, for VoiceOver.
NSString *FlyDistanceSpeech(NSDictionary *place, NSDictionary *aerodrome);
NSDictionary *FlyNearestTAFAerodrome(NSDictionary *place, NSArray<NSDictionary *> *aerodromes);
// Nil when `shown` is the nearest TAF aerodrome.
// Otherwise action "Nearest: ICAO" and code. No sentence.
NSDictionary *FlyAerodromeCue(NSDictionary *place, NSDictionary *shown, NSArray<NSDictionary *> *aerodromes);
// ISO string, epoch number, or NSDate. Nil when it is not a time.
NSDate *FlyDate(id value);
// One METAR instrument: cloud, vis, wind, clock, age, aged, tip, hazard, hazardTip.
// Missing pieces are "—". Age is "24 h" or "12 m".
// A CB or TCU layer leads the cloud datum ("CB 3,500") so truncation keeps it.
// hazard is "", "TS", "VCTS", "CB" or "TCU". hazardTip is the plain explanation.
NSDictionary *FlyMetarInstrument(NSString *raw, NSDate *time, NSDate *now, NSTimeZone *zone);
// Overhead thunderstorm outranks vicinity, then CB, then TCU. Recent RE* is not current.
// weather is the joined token string ("TSRA · CB"); cloudLayers may be nil.
NSString *FlyConvectiveHazard(NSString *weather, NSArray *cloudLayers);
// "" when nothing convective. "Thunderstorm in vicinity · CB base 3,500 ft".
NSString *FlyConvectiveTip(NSString *weather, NSArray *cloudLayers);
// "TAF 26 20:00 → 27 20:00" in `zone`, and the same span in UTC.
NSString *FlyValidityRow(NSDate *from, NSDate *to, NSTimeZone *zone);
NSString *FlyValidityUTC(NSDate *from, NSDate *to);
// Session pins map FlyPlaceKey to an ICAO. A pin applies only to that place.
NSDictionary *FlyAerodromeForPlace(NSDictionary *place, NSArray<NSDictionary *> *aerodromes, NSDictionary *sessionPins);

// Issued METAR and TAF. TAF groups break before FM, BECMG, TEMPO, PROBnn and INTER.
// `lines` are @{text, active}; active follows `playhead`. A report is shown only
// when its station, parsed from the raw text and checked against product
// metadata, is the selected aerodrome. Anything else is an explicit gap:
// "METAR for YSSY unavailable" and "No TAF for YSSY yet". A product with no
// report stays "METAR unavailable" / "No TAF issued for YSSY".
NSString *AviationTAFWrapped(NSString *raw);
NSDictionary *AviationBulletin(NSDictionary *aviation, NSString *icao, NSDate *playhead, NSTimeZone *placeZone);
