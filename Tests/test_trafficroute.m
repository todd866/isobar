#import "trafficroute.h"
#include <stdio.h>

static int failures;
static void Check(BOOL ok, NSString *message) { if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); failures++; } }

@interface RouteProtocol : NSURLProtocol
@property(nonatomic) BOOL cancelled;
@end
static NSInteger requests;
static BOOL malformed;
static NSData *RouteData(void) {
    NSDictionary *airport = @{ @"airport_icao": @"YPPH", @"airport_iata": @"PER", @"name": @"Perth", @"latitude": @-31.94, @"longitude": @115.97 };
    NSDictionary *destination = @{ @"airport_icao": @"YPAD", @"airport_iata": @"ADL", @"name": @"Adelaide", @"latitude": @-34.95, @"longitude": @138.53 };
    NSDictionary *body = malformed ? @{ @"response": @{ @"flightroute": @{ @"origin": airport } } } : @{ @"response": @{ @"flightroute": @{ @"origin": airport, @"destination": destination } } };
    return [NSJSONSerialization dataWithJSONObject:body options:0 error:NULL];
}
@implementation RouteProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return [request.URL.host isEqual:@"api.adsbdb.com"]; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
    @synchronized(RouteProtocol.class) { requests++; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(.01 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.cancelled) return;
        NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:@{}];
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        [self.client URLProtocol:self didLoadData:RouteData()]; [self.client URLProtocolDidFinishLoading:self];
    });
}
- (void)stopLoading { self.cancelled = YES; }
@end

static void Spin(double seconds) { NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds]; while (end.timeIntervalSinceNow > 0) [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.01]]; }

int main(void) { @autoreleasepool {
    NSDictionary *route = TrafficRouteParse(@{ @"response": @{ @"flightroute": @{ @"origin": @{ @"airport_icao": @"YPPH", @"latitude": @-31.94, @"longitude": @115.97 }, @"destination": @{ @"airport_icao": @"YPAD", @"latitude": @-34.95, @"longitude": @138.53 } } } }, @" qfa642 ");
    Check([route[@"callsign"] isEqual:@"QFA642"] && [route[@"origin"][@"icao"] isEqual:@"YPPH"], @"route parser normalizes callsign and airports");
    Check(!TrafficRouteParse(@{ @"response": @{} }, @"QFA642"), @"missing route rejected");
    Check(!TrafficRouteParse(@{ @"response": @{ @"flightroute": @{ @"origin": @{ @"airport_icao": NSNull.null, @"latitude": @-31.94, @"longitude": @115.97 }, @"destination": @{ @"airport_icao": @"YPAD", @"latitude": @-35, @"longitude": @138 } } } }, @"QFA642"), @"null ICAO rejected");
    NSDictionary *nullIata=TrafficRouteParse(@{ @"response": @{ @"flightroute": @{ @"origin": @{ @"airport_icao": @"YPPH", @"airport_iata": NSNull.null, @"latitude": @-31.94, @"longitude": @115.97 }, @"destination": @{ @"airport_icao": @"YPAD", @"latitude": @-35, @"longitude": @138 } } } }, @"QFA642");
    Check(nullIata != nil && !nullIata[@"origin"][@"iata"], @"null IATA is ignored safely");
    Check(!TrafficRouteParse(@{ @"response": @{ @"flightroute": @{ @"origin": @{ @"airport_icao": @"YPPH", @"latitude": @-31.94, @"longitude": @115.97 }, @"destination": @{ @"airport_icao": @"YPAD", @"latitude": @-35, @"longitude": @300 } } } }, @"QFA642"), @"invalid geometry rejected");
    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration; configuration.protocolClasses = @[RouteProtocol.class];
    TrafficRouteLookup *disabled = [[TrafficRouteLookup alloc] initWithConfiguration:configuration];
    __block BOOL disabledCalled = NO; [disabled lookupCallsign:@"QFA642" completion:^(NSDictionary *value) { disabledCalled = YES; Check(!value, @"disabled lookup returns nil"); }];
    Check(disabledCalled && requests == 0, @"disabled lookup does not fetch");
    [disabled lookupCallsign:@"!!!" completion:^(NSDictionary *value) { Check(!value, @"invalid callsign returns nil"); }];
    Check(requests == 0, @"invalid callsign does not fetch");
    TrafficRouteLookup *client = [[TrafficRouteLookup alloc] initWithConfiguration:configuration enabled:YES];
    [client lookupCallsign:@"" completion:^(NSDictionary *value) { Check(!value, @"empty callsign returns nil while enabled"); }];
    [client lookupCallsign:@"!!!" completion:^(NSDictionary *value) { Check(!value, @"invalid callsign returns nil while enabled"); }];
    Spin(.02); Check(requests==0, @"enabled lookup rejects empty and invalid callsigns without a request");
    __block NSUInteger callbacks = 0; __block NSDictionary *received;
    [client lookupCallsign:@"QFA642" completion:^(NSDictionary *value) { callbacks++; received = value; }];
    [client lookupCallsign:@"qfa642" completion:^(NSDictionary *value) { callbacks++; Check(value != nil, @"deduplicated waiter receives route"); }];
    Spin(.2); Check(requests == 1 && callbacks == 2 && received != nil, @"positive lookup deduplicates in flight");
    [client lookupCallsign:@"QFA642" completion:^(NSDictionary *value) { (void)value; callbacks++; }]; Spin(.05); Check(requests == 1 && callbacks == 3, @"positive route cache avoids fetch");
    malformed = YES; [client lookupCallsign:@"VOZ771" completion:^(NSDictionary *value) { Check(!value, @"malformed route is negative cached"); }]; Spin(.1); NSInteger before = requests;
    [client lookupCallsign:@"VOZ771" completion:^(NSDictionary *value) { Check(!value, @"negative cache returns nil"); }]; Spin(.05); Check(requests == before, @"negative route cache avoids fetch");
    [client lookupCallsign:@"CANCEL1" completion:^(NSDictionary *value) { (void)value; callbacks++; }];
    [client clear]; NSUInteger cleared=callbacks; Spin(.1); Check(callbacks==cleared, @"clear suppresses late callbacks");
    before=requests;
    malformed=NO; [client lookupCallsign:@"TEST123" completion:^(NSDictionary *value) { Check(value != nil, @"lookup works after clear recreates session"); callbacks++; }]; Spin(.1); Check(requests==before+1, @"clear permits a fresh request");
    [client clear];
    fprintf(stderr, "trafficroute failures: %d\n", failures); return failures ? 1 : 0;
} }
