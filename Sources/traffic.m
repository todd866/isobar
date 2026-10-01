#import "traffic.h"
#import <math.h>

static BOOL TNumber(id x) { return [x isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)x)!=CFBooleanGetTypeID() && isfinite([x doubleValue]); }
static NSString *TString(id x) { return [x isKindOfClass:NSString.class] ? [[x stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] substringToIndex:MIN(40,[[x stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] length])] : @""; }
static double TDistance(double a,double b,double c,double d) {
    double r=M_PI/180, x=sin((c-a)*r/2),y=sin((d-b)*r/2);
    return 3440.065*2*asin(sqrt(MIN(1,x*x+cos(a*r)*cos(c*r)*y*y)));
}
NSArray<NSDictionary *> *TrafficVisibleAircraft(NSDictionary *snapshot, NSDate *now) {
    NSMutableArray *result=[NSMutableArray array];
    for (NSDictionary *aircraft in snapshot[@"aircraft"]) {
        NSTimeInterval age=[now timeIntervalSinceDate:aircraft[@"positionTime"]];
        if (age>=-15 && age<=90) [result addObject:aircraft];
    }
    return result;
}
NSDictionary *TrafficSnapshot(NSDictionary *payload,NSDate *now,double latitude,double longitude) {
    if (![payload isKindOfClass:NSDictionary.class] || !TNumber(payload[@"now"]) ||
        ![payload[@"ac"] isKindOfClass:NSArray.class] || !isfinite(latitude) || fabs(latitude)>90 ||
        !isfinite(longitude) || fabs(longitude)>180 || !isfinite(now.timeIntervalSince1970)) return nil;
    NSDate *stamp=[NSDate dateWithTimeIntervalSince1970:[payload[@"now"] doubleValue]/1000];
    double age=[now timeIntervalSinceDate:stamp];
    if (age< -15 || age>90) return nil;
    NSMutableDictionary *byAddress=[NSMutableDictionary dictionary];
    for (id item in payload[@"ac"]) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *a=item;
        if (!TNumber(a[@"alt_baro"]) || !TNumber(a[@"lat"]) || !TNumber(a[@"lon"]) || !TNumber(a[@"seen_pos"])) continue;
        double alt=[a[@"alt_baro"] doubleValue],lat=[a[@"lat"] doubleValue],lon=[a[@"lon"] doubleValue],seen=[a[@"seen_pos"] doubleValue];
        if (alt<=0 || alt>65600 || fabs(lat)>90 || fabs(lon)>180 || seen<0 || age+seen>90) continue;
        NSString *hex=TString(a[@"hex"]); if (!hex.length) continue;
        double distance=TDistance(latitude,longitude,lat,lon); if (distance>80) continue;
        NSDate *position=[stamp dateByAddingTimeInterval:-seen];
        if (byAddress[hex] && [position compare:byAddress[hex][@"positionTime"]]!=NSOrderedDescending) continue;
        NSString *callsign=TString(a[@"flight"]),*registration=TString(a[@"r"]),*type=TString(a[@"t"]);
        if ([callsign rangeOfCharacterFromSet:NSCharacterSet.alphanumericCharacterSet].location==NSNotFound) callsign=@"";
        NSMutableDictionary *row=[@{@"hex":hex,@"callsign":callsign.length?callsign:(registration.length?registration:hex.uppercaseString),
            @"registration":registration,@"type":type,@"latitude":@(lat),@"longitude":@(lon),
            @"pressureAltitudeFt":@(alt),@"distanceNm":@(distance),@"positionTime":position} mutableCopy];
        if (TNumber(a[@"gs"]) && [a[@"gs"] doubleValue]>=0 && [a[@"gs"] doubleValue]<=1500) row[@"groundSpeedKt"]=a[@"gs"];
        if (TNumber(a[@"track"]) && [a[@"track"] doubleValue]>=0 && [a[@"track"] doubleValue]<360) row[@"trackDegrees"]=a[@"track"];
        byAddress[hex]=row;
    }
    NSArray *rows=[byAddress.allValues sortedArrayUsingDescriptors:@[[NSSortDescriptor sortDescriptorWithKey:@"pressureAltitudeFt" ascending:YES],[NSSortDescriptor sortDescriptorWithKey:@"hex" ascending:YES]]];
    return @{@"time":stamp,@"aircraft":rows,@"source":@"ADSB.lol",@"radiusNm":@80};
}

@interface AirborneTraffic ()
@property(nonatomic) double latitude,longitude;
@property(nonatomic) BOOL running;
@property(nonatomic) NSUInteger generation;
@property(nonatomic,strong) NSURLSession *session;
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(nonatomic,strong) NSTimer *timer;
@property(nonatomic,strong) NSDate *nextFetch;
@end
@implementation AirborneTraffic
- (instancetype)initWithLatitude:(double)latitude longitude:(double)longitude configuration:(NSURLSessionConfiguration *)configuration {
    if ((self=[super init])) {
        _latitude=latitude; _longitude=longitude;
        _session=[NSURLSession sessionWithConfiguration:configuration?:NSURLSessionConfiguration.ephemeralSessionConfiguration];
    } return self;
}
- (void)dealloc { [_timer invalidate]; [_session invalidateAndCancel]; }
- (void)start {
    if (_running || !isfinite(_latitude) || fabs(_latitude)>90 || !isfinite(_longitude) || fabs(_longitude)>180) return;
    _running=YES; [self schedule];
}
- (void)stop {
    _running=NO; _generation++;
    // A cancelled first fetch has no useful cached result. Retry promptly on
    // reopen, but retain a short throttle if the window is toggled repeatedly.
    if (_task && [_nextFetch timeIntervalSinceNow]>5) _nextFetch=[NSDate dateWithTimeIntervalSinceNow:5];
    [_task cancel]; _task=nil; [_timer invalidate]; _timer=nil;
}
- (void)schedule {
    if (!_running) return;
    NSTimeInterval delay=[_nextFetch timeIntervalSinceNow];
    if (delay<=0) { [self fetch]; return; }
    __weak AirborneTraffic *weak=self;
    _timer=[NSTimer scheduledTimerWithTimeInterval:delay repeats:NO block:^(NSTimer *timer) { (void)timer; weak.timer=nil; [weak fetch]; }];
}
- (void)fetch {
    if (!_running || _task) return;
    NSUInteger generation=++_generation;
    NSString *url=[NSString stringWithFormat:@"https://api.adsb.lol/v2/point/%.4f/%.4f/80",_latitude,_longitude];
    NSMutableURLRequest *request=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:url] cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:12];
    [request setValue:@"Isobar/1.7.5 (https://github.com/todd866/isobar)" forHTTPHeaderField:@"User-Agent"];
    _nextFetch=[NSDate dateWithTimeIntervalSinceNow:60];
    __weak AirborneTraffic *weak=self;
    _task=[_session dataTaskWithRequest:request completionHandler:^(NSData *data,NSURLResponse *response,NSError *error) {
        NSInteger code=[response isKindOfClass:NSHTTPURLResponse.class]?[(NSHTTPURLResponse *)response statusCode]:0;
        id payload=(!error && code==200 && data.length<=2*1024*1024)?[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]:nil;
        dispatch_async(dispatch_get_main_queue(),^{
            AirborneTraffic *self=weak; if (!self || !self.running || generation!=self.generation) return;
            self.task=nil;
            NSDictionary *snapshot=TrafficSnapshot(payload,NSDate.date,self.latitude,self.longitude);
            NSTimeInterval delay=snapshot?60:120;
            if (code==429) delay=MAX(300,MIN(3600,[[(NSHTTPURLResponse *)response valueForHTTPHeaderField:@"Retry-After"] doubleValue]));
            self.nextFetch=[NSDate dateWithTimeIntervalSinceNow:delay];
            if (self.onUpdate) self.onUpdate(snapshot,snapshot?@"":code==429?@"Traffic resting · retrying shortly":@"Traffic unavailable · retrying");
            [self schedule];
        });
    }]; [_task resume];
}
@end
