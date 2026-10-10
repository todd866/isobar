// Isobar — compact representative forecast atmosphere overlay for the GPU map.
// The overlay is an illustrative vertical profile, not a mapped cloud footprint.
#import <Cocoa/Cocoa.h>
#import "fieldrender.h"

NS_ASSUME_NONNULL_BEGIN

@interface AtmosphereMapView : NSView
@property(nonatomic) IsobarCamera camera;
@property(nonatomic,copy,nullable) NSDictionary *product;
@property(nonatomic,strong,nullable) NSDate *date;
@property(nonatomic) double latitude;
@property(nonatomic) double longitude;
@property(nonatomic) double aircraftAltitudeM;
@property(nonatomic,readonly) BOOL disclosureOpen;
@end

NS_ASSUME_NONNULL_END
