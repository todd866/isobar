#import <Foundation/Foundation.h>

// ADSB.lol reports pressure altitude in feet, ground speed in knots, and
// position age in seconds. Keep these separate from forecast AMSL heights.
FOUNDATION_EXPORT NSDictionary *TrafficSnapshot(NSDictionary *payload, NSDate *now,
                                                double latitude, double longitude);
FOUNDATION_EXPORT NSArray<NSDictionary *> *TrafficVisibleAircraft(NSDictionary *snapshot, NSDate *now);

// A layer session owns its history.  It deliberately has no persistence: closing
// the layer releases the store and therefore releases the aircraft track cache.
// Track points use the same pressure-altitude-in-feet convention as snapshots.
@interface TrafficTrackSession : NSObject
@property(nonatomic, readonly) NSUInteger maximumSelections;
@property(nonatomic, readonly) NSArray<NSString *> *selectedHexes;
- (instancetype)init;
- (instancetype)initWithMaximumPointsPerAircraft:(NSUInteger)maximumPoints;
- (void)mergeSnapshot:(NSDictionary *)snapshot;
- (NSArray<NSDictionary *> *)trackForHex:(NSString *)hex;
- (NSDictionary *)aircraftForHex:(NSString *)hex;
// Local observation replay only. Returns aircraft interpolated at date when
// adjacent captured points are no more than two minutes apart.
- (NSArray<NSDictionary *> *)aircraftAtDate:(NSDate *)date;
- (BOOL)toggleSelectionForHex:(NSString *)hex;
- (BOOL)removeSelectionForHex:(NSString *)hex;
- (void)clearSelections;
- (NSInteger)colourIndexForHex:(NSString *)hex;
@end

@interface AirborneTraffic : NSObject
@property(nonatomic, copy) void (^onUpdate)(NSDictionary *snapshot, NSString *status);
@property(nonatomic, readonly) BOOL running;
- (instancetype)initWithLatitude:(double)latitude longitude:(double)longitude
                  configuration:(NSURLSessionConfiguration *)configuration;
- (void)start;
- (void)stop;
@end
