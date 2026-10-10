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
    NSDictionary *vertical=TrafficSnapshot(Payload(now,@[Aircraft(@{@"baro_rate":@650,@"squawk":@"1200"})]),now,-31.94,115.967)[@"aircraft"][0];
    Check([vertical[@"verticalRateFpm"] doubleValue]==650 && [vertical[@"verticalTrend"] isEqual:@"climb"] && [vertical[@"squawk"] isEqual:@"1200"],@"vertical trend and squawk are retained");
    NSDictionary *level=TrafficSnapshot(Payload(now,@[Aircraft(@{@"baro_rate":@50})]),now,-31.94,115.967)[@"aircraft"][0];
    Check([level[@"verticalTrend"] isEqual:@"level"],@"small vertical rates are level");
    Check(TrafficSnapshot(@{},now,-31.94,115.967)==nil && TrafficSnapshot(Payload(now,@[]),now,NAN,115.967)==nil,@"invalid schema and location rejected");

    TrafficTrackSession *tracks=[[TrafficTrackSession alloc] initWithMaximumPointsPerAircraft:3];
    NSDictionary *(^Report)(NSDate *,NSString *,double,double,double)=^NSDictionary *(NSDate *date,NSString *hex,double lat,double lon,double alt) {
        return @{ @"time":date, @"aircraft":@[@{@"hex":hex, @"latitude":@(lat), @"longitude":@(lon), @"pressureAltitudeFt":@(alt), @"positionTime":date}] };
    };
    [tracks mergeSnapshot:Report(now,@"abc",-31.9,115.9,10000)];
    [tracks mergeSnapshot:Report([now dateByAddingTimeInterval:20],@"abc",-31.8,116.0,12000)];
    [tracks mergeSnapshot:Report([now dateByAddingTimeInterval:10],@"abc",-31.85,115.95,11000)];
    [tracks mergeSnapshot:Report([now dateByAddingTimeInterval:30],@"abc",-31.7,116.1,13000)];
    [tracks mergeSnapshot:Report([now dateByAddingTimeInterval:5],@"abc",-31.9,115.9,9000)];
    Check([[[tracks aircraftForHex:@"abc"] objectForKey:@"positionTime"] isEqual:[now dateByAddingTimeInterval:30]],@"out of order report does not regress selected metadata");
    NSArray *path=[tracks trackForHex:@"abc"];
    Check(path.count==3 && [path[0][@"pressureAltitudeFt"] doubleValue]==11000 && [path[2][@"pressureAltitudeFt"] doubleValue]==13000,@"track merge orders points, preserves altitude and bounds history");
    NSArray *sampled=[tracks aircraftAtDate:[now dateByAddingTimeInterval:15]];
    Check(sampled.count==1 && [sampled[0][@"latitude"] doubleValue] < -31.8 && [sampled[0][@"pressureAltitudeFt"] doubleValue]==11500,@"historical sample interpolates position and pressure altitude");
    Check(!sampled[0][@"groundSpeedKt"] && !sampled[0][@"squawk"] && sampled[0][@"trackDegrees"],@"historical sample does not leak current fields and derives heading");
    Check([tracks aircraftAtDate:[now dateByAddingTimeInterval:-120]].count==0 && [tracks aircraftAtDate:[now dateByAddingTimeInterval:31]].count==0,@"historical sample has no unseen past or future");
    TrafficTrackSession *dateline=[TrafficTrackSession new];
    [dateline mergeSnapshot:Report(now,@"dateline",0,179.8,10000)];
    [dateline mergeSnapshot:Report([now dateByAddingTimeInterval:60],@"dateline",0,-179.8,12000)];
    NSDictionary *crossing=[dateline aircraftAtDate:[now dateByAddingTimeInterval:30]].firstObject;
    Check(fabs([crossing[@"longitude"] doubleValue])>179.9 && [crossing[@"trackDegrees"] doubleValue]>80 && [crossing[@"trackDegrees"] doubleValue]<100,@"historical interpolation takes the short dateline path");
    Check([tracks toggleSelectionForHex:@"abc"] && ![tracks toggleSelectionForHex:@"abc"] && tracks.selectedHexes.count==0,@"selection toggles off on second tap");
    NSMutableArray *selected=[NSMutableArray array];
    for (NSUInteger i=0;i<8;i++) { NSString *hex=[NSString stringWithFormat:@"%02lu",(unsigned long)i]; Check([tracks toggleSelectionForHex:hex],@"selection admits up to eight aircraft"); [selected addObject:hex]; }
    Check(![tracks toggleSelectionForHex:@"overflow"] && tracks.selectedHexes.count==8,@"ninth selection is bounded");
    NSMutableSet *colourSet=[NSMutableSet set]; for (NSString *hex in selected) [colourSet addObject:@([tracks colourIndexForHex:hex])];
    Check(colourSet.count==8,@"selected aircraft receive distinct stable colours");
    NSInteger retainedColour=[tracks colourIndexForHex:@"03"];
    Check([tracks removeSelectionForHex:@"03"] && [tracks colourIndexForHex:@"03"]==retainedColour,@"remove is undoable and colour assignment remains stable");
    [tracks clearSelections]; Check(tracks.selectedHexes.count==0,@"Escape clear operation has an explicit model helper");

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
