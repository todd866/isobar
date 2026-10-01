#import <Foundation/Foundation.h>

// Compact, source-faithful METAR/TAF outlook for the aviation card.
// The returned dictionary contains observation, periods, detail and status.
// Periods include ceilingFt/ceilingState, visibilityM/visibilityAtLeast and
// cloudLayers (amount, baseFt, type); missing fields are NSNull, never implied zero.
NSDictionary *AviationOutlook(NSDictionary *aviation, NSDate *now, NSTimeZone *tz);
