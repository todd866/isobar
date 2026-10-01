// Isobar — normalized upper-air model sampling.
#import <Foundation/Foundation.h>

// Sample an upper-air product at an absolute instant. The product contains a
// UTC-ish `time` array and pressure-level dictionaries in `levels`. Values are
// interpolated only between adjacent valid samples no more than four hours
// apart. The result is nil for an invalid product or an instant outside its
// valid range.
NSDictionary *AtmosphereAtDate(NSDictionary *product, NSDate *date);

// International Standard Atmosphere reference at standard geopotential height
// in metres. Valid from 0 through 20,000 m inclusive; nil outside that range.
// This is a reference curve, not model data: temperatureC, pressureHpa and
// densityKgM3 are returned for the requested height.
NSDictionary *StandardAtmosphereAtHeight(double heightM);
