#import "traffic.h"
#import <math.h>
#include <stdio.h>

static int failures;
static void Check(BOOL ok,NSString *message) { if (!ok) { fprintf(stderr,"FAIL %s\n",message.UTF8String); failures++; } }
static NSDictionary *Aircraft(NSDictionary *overrides) {
    NSMutableDictionary *row=[@{@"hex":@"7c1234",@"flight":@"TEST123 ",@"r":@"VH-TEST",@"t":@"BE20",
        @"lat":@(-31.90),@"lon":@115.90,@"alt_baro":@18000,@"gs":@240,@"track":@350,@"seen_pos":@2} mutableCopy];
    [row addEntriesFromDictionary:overrides]; return row;
}
static NSDictionary *Payload(NSDate *date,NSArray *rows) { return @{@"now":@(date.timeIntervalSince1970*1000),@"ac":rows}; }
static void Spin(double seconds) { NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds]; while (end.timeIntervalSinceNow>0) [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.01]]; }
static NSInteger requests,httpStatus=200;
static BOOL delayResponse;
static NSString *lastPath;
@interface TrafficProtocol : NSURLProtocol
@property(nonatomic) BOOL cancelled;
@end
@implementation TrafficProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return [request.URL.host isEqual:@"api.adsb.lol"]; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
    @synchronized(TrafficProtocol.class) { requests++; lastPath=self.request.URL.path; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)((delayResponse?.25:.01)*NSEC_PER_SEC)),dispatch_get_main_queue(),^{
        if (self.cancelled) return;
        NSHTTPURLResponse *response=[[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:httpStatus HTTPVersion:@"HTTP/1.1" headerFields:@{@"Retry-After":@"300"}];
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        NSData *data=[NSJSONSerialization dataWithJSONObject:Payload(NSDate.date,@[Aircraft(@{})]) options:0 error:NULL];
        [self.client URLProtocol:self didLoadData:data]; [self.client URLProtocolDidFinishLoading:self];
    });
}
- (void)stopLoading { self.cancelled=YES; }
@end

int main(void) { @autoreleasepool {
    NSDate *now=[NSDate dateWithTimeIntervalSince1970:1790500000];
    NSDictionary *snapshot=TrafficSnapshot(Payload(now,@[Aircraft(@{})]),now,-31.94,115.967);
    NSArray *rows=snapshot[@"aircraft"];
    Check(rows.count==1,@"valid airborne report retained");
    Check([rows[0][@"callsign"] isEqual:@"TEST123"],@"callsign trimmed");
    Check([rows[0][@"pressureAltitudeFt"] doubleValue]==18000 && [rows[0][@"groundSpeedKt"] doubleValue]==240,@"native feet and knots preserved");
    Check(TrafficVisibleAircraft(snapshot,[now dateByAddingTimeInterval:89]).count==0,@"position ages out after 90 seconds");
    Check(TrafficSnapshot(Payload([now dateByAddingTimeInterval:-91],@[Aircraft(@{})]),now,-31.94,115.967)==nil,@"stale response rejected");
    Check(TrafficSnapshot(Payload([now dateByAddingTimeInterval:16],@[Aircraft(@{})]),now,-31.94,115.967)==nil,@"future response rejected");
    for (NSDictionary *bad in @[@{@"alt_baro":@"ground"},@{@"alt_baro":NSNull.null},@{@"alt_baro":@0},@{@"alt_baro":@YES},@{@"lat":NSNull.null},@{@"lon":@300},@{@"seen_pos":@91},@{@"seen_pos":@-1},@{@"lat":@-20},@{@"hex":@""}]) {
        NSDictionary *filtered=TrafficSnapshot(Payload(now,@[Aircraft(bad)]),now,-31.94,115.967);
        Check([filtered[@"aircraft"] count]==0,@"ground, unknown, stale and out-of-range reports excluded");
    }
    NSDictionary *duplicate=TrafficSnapshot(Payload(now,@[Aircraft(@{@"seen_pos":@20}),Aircraft(@{@"seen_pos":@1})]),now,-31.94,115.967);
    Check([duplicate[@"aircraft"] count]==1 && fabs([now timeIntervalSinceDate:duplicate[@"aircraft"][0][@"positionTime"]]-1)<.01,@"duplicates use freshest position");
    NSDictionary *missing=TrafficSnapshot(Payload(now,@[Aircraft(@{@"gs":NSNull.null,@"track":@-1,@"flight":@"@@@@@@"})]),now,-31.94,115.967)[@"aircraft"][0];
    Check(!missing[@"groundSpeedKt"] && !missing[@"trackDegrees"],@"missing speed and direction stay unknown");
    Check([missing[@"callsign"] isEqual:@"VH-TEST"],@"placeholder callsign falls back to registration");
    Check(TrafficSnapshot(@{},now,-31.94,115.967)==nil && TrafficSnapshot(Payload(now,@[]),now,NAN,115.967)==nil,@"invalid schema and location rejected");

    NSURLSessionConfiguration *configuration=NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.protocolClasses=@[TrafficProtocol.class];
    AirborneTraffic *client=[[AirborneTraffic alloc] initWithLatitude:-31.94 longitude:115.967 configuration:configuration];
    __block NSUInteger updates=0; __block NSDictionary *received; __block NSString *status;
    client.onUpdate=^(NSDictionary *value,NSString *message) { updates++; received=value; status=message; };
    @try {
        [client start]; [client start]; Spin(.2);
        Check(requests==1 && updates==1 && received!=nil,@"one bounded successful request and callback");
        Check([lastPath isEqual:@"/v2/point/-31.9400/115.9670/80"],@"airport point and 80 nm radius used");
        [client stop]; [client start]; Spin(.1);
        Check(requests==1,@"reopening reuses refresh deadline");
        [client stop]; [client setValue:NSDate.distantPast forKey:@"nextFetch"]; delayResponse=YES;
        [client start]; Spin(.05); [client stop]; Spin(.3);
        Check(updates==1 && !client.running,@"closing cancels late request and callback");
        Check([[client valueForKey:@"nextFetch"] timeIntervalSinceNow]<5,@"cancelled first request retries promptly on reopen");
        httpStatus=429; delayResponse=NO; [client setValue:NSDate.distantPast forKey:@"nextFetch"];
        [client start]; Spin(.2);
        Check(received==nil && [status containsString:@"retrying"],@"rate limit reports unavailable without fabricated traffic");
        Check([[client valueForKey:@"nextFetch"] timeIntervalSinceNow]>290,@"rate limit backs off");
    } @finally { [client stop]; client.onUpdate=nil; }
    fprintf(stderr,"traffic failures: %d\n",failures);
    return failures?1:0;
} }
