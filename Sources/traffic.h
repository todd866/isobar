#import <Foundation/Foundation.h>

// ADSB.lol reports pressure altitude in feet, ground speed in knots, and
// position age in seconds. Keep these separate from forecast AMSL heights.
FOUNDATION_EXPORT NSDictionary *TrafficSnapshot(NSDictionary *payload, NSDate *now,
                                                double latitude, double longitude);
FOUNDATION_EXPORT NSArray<NSDictionary *> *TrafficVisibleAircraft(NSDictionary *snapshot, NSDate *now);

@interface AirborneTraffic : NSObject
@property(nonatomic, copy) void (^onUpdate)(NSDictionary *snapshot, NSString *status);
@property(nonatomic, readonly) BOOL running;
- (instancetype)initWithLatitude:(double)latitude longitude:(double)longitude
                  configuration:(NSURLSessionConfiguration *)configuration;
- (void)start;
- (void)stop;
@end
