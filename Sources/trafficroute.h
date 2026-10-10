#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSDictionary * _Nullable TrafficRouteParse(NSDictionary *payload, NSString *callsign);

@interface TrafficRouteLookup : NSObject
@property(nonatomic, readonly, getter=isEnabled) BOOL enabled;
+ (instancetype)configuredWithConfiguration:(nullable NSURLSessionConfiguration *)configuration;
- (instancetype)initWithConfiguration:(nullable NSURLSessionConfiguration *)configuration enabled:(BOOL)enabled;
- (instancetype)initWithConfiguration:(nullable NSURLSessionConfiguration *)configuration;
- (void)lookupCallsign:(NSString *)callsign completion:(void (^)(NSDictionary * _Nullable route))completion;
- (void)clear;
@end

NS_ASSUME_NONNULL_END
