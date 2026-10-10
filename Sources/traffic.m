#import "traffic.h"
#import <math.h>

static BOOL TNumber(id x) { return [x isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)x)!=CFBooleanGetTypeID() && isfinite([x doubleValue]); }
static NSString *TString(id x) { return [x isKindOfClass:NSString.class] ? [[x stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] substringToIndex:MIN(40,[[x stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] length])] : @""; }
static double TDistance(double a,double b,double c,double d) {
    double r=M_PI/180, x=sin((c-a)*r/2),y=sin((d-b)*r/2);
    return 3440.065*2*asin(sqrt(MIN(1,x*x+cos(a*r)*cos(c*r)*y*y)));
}
static NSNumber *TVerticalRate(NSDictionary *a) {
    for (NSString *key in @[@"baro_rate", @"geom_rate", @"vert_rate", @"vertical_rate"])
        if (TNumber(a[key]) && fabs([a[key] doubleValue])<=20000) return a[key];
    return nil;
}
static NSString *TTrend(NSNumber *rate) {
    if (!rate || fabs(rate.doubleValue)<100) return rate ? @"level" : @"unknown";
    return rate.doubleValue>0 ? @"climb" : @"descend";
}
static const NSTimeInterval TReplayMaxGap = 120;
static double TWrappedLongitude(double from, double to, double fraction) {
    double delta=to-from;
    while (delta>180) delta-=360;
    while (delta<-180) delta+=360;
    return fmod(from+delta*fraction+540,360)-180;
}
static double TBearing(NSDictionary *a, NSDictionary *b) {
    double r=M_PI/180, lat1=[a[@"latitude"] doubleValue]*r, lat2=[b[@"latitude"] doubleValue]*r;
    double dlon=([b[@"longitude"] doubleValue]-[a[@"longitude"] doubleValue])*r;
    double y=sin(dlon)*cos(lat2), x=cos(lat1)*sin(lat2)-sin(lat1)*cos(lat2)*cos(dlon);
    return fmod(atan2(y,x)*180/M_PI+360,360);
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
        NSNumber *verticalRate=TVerticalRate(a);
        if (verticalRate) {
            row[@"verticalRateFpm"]=verticalRate;
            row[@"verticalTrend"]=TTrend(verticalRate);
        }
        NSString *squawk=TString(a[@"squawk"]);
        if (squawk.length && squawk.length<=4 && [squawk rangeOfCharacterFromSet:[[NSCharacterSet decimalDigitCharacterSet] invertedSet]].location==NSNotFound)
            row[@"squawk"]=squawk;
        byAddress[hex]=row;
    }
    NSArray *rows=[byAddress.allValues sortedArrayUsingDescriptors:@[[NSSortDescriptor sortDescriptorWithKey:@"pressureAltitudeFt" ascending:YES],[NSSortDescriptor sortDescriptorWithKey:@"hex" ascending:YES]]];
    return @{@"time":stamp,@"aircraft":rows,@"source":@"ADSB.lol",@"radiusNm":@80};
}

@interface TrafficTrackSession ()
@property(nonatomic) NSUInteger maximumPoints;
@property(nonatomic,strong) NSDate *latestTime;
@property(nonatomic,strong) NSMutableDictionary<NSString *, NSMutableArray<NSDictionary *> *> *tracks;
@property(nonatomic,strong) NSMutableDictionary<NSString *, NSDictionary *> *aircraft;
@property(nonatomic,strong) NSMutableArray<NSString *> *mutableSelections;
@property(nonatomic,strong) NSMutableDictionary<NSString *, NSNumber *> *colours;
@end

@implementation TrafficTrackSession
- (instancetype)init { return [self initWithMaximumPointsPerAircraft:1441]; }
- (instancetype)initWithMaximumPointsPerAircraft:(NSUInteger)maximumPoints {
    if ((self=[super init])) {
        _maximumPoints=MIN(1441,MAX(2,maximumPoints));
        _tracks=[NSMutableDictionary dictionary];
        _aircraft=[NSMutableDictionary dictionary];
        _mutableSelections=[NSMutableArray array];
        _colours=[NSMutableDictionary dictionary];
    }
    return self;
}
- (NSUInteger)maximumSelections { return 8; }
- (NSArray<NSString *> *)selectedHexes { return [_mutableSelections copy]; }
- (NSArray<NSDictionary *> *)trackForHex:(NSString *)hex {
    if (![hex isKindOfClass:NSString.class]) return @[];
    return [_tracks[hex] copy] ?: @[];
}
- (NSDictionary *)aircraftForHex:(NSString *)hex { return _aircraft[hex]; }
- (NSArray<NSDictionary *> *)aircraftAtDate:(NSDate *)date {
    if (![date isKindOfClass:NSDate.class]) return @[];
    NSMutableArray *result=[NSMutableArray array];
    for (NSString *hex in _tracks) {
        NSArray *points=_tracks[hex]; NSUInteger left=0,right=points.count;
        while (left<right) { NSUInteger mid=left+(right-left)/2; if ([points[mid][@"time"] compare:date]==NSOrderedAscending) left=mid+1; else right=mid; }
        NSDictionary *point=nil, *leftPoint=nil, *rightPoint=nil;
        NSNumber *track=nil;
        if (right<points.count && [points[right][@"time"] compare:date]==NSOrderedSame) {
            point=points[right];
            if (right>0 && [point[@"time"] timeIntervalSinceDate:points[right-1][@"time"]]<=TReplayMaxGap) { leftPoint=points[right-1]; rightPoint=point; }
        } else if (right>0 && right<points.count) {
            leftPoint=points[right-1]; rightPoint=points[right];
            NSTimeInterval gap=[rightPoint[@"time"] timeIntervalSinceDate:leftPoint[@"time"]];
            if (gap>0 && gap<=TReplayMaxGap) {
                double f=[date timeIntervalSinceDate:leftPoint[@"time"]]/gap;
                NSMutableDictionary *sample=[@{ @"latitude":@([leftPoint[@"latitude"] doubleValue]+([rightPoint[@"latitude"] doubleValue]-[leftPoint[@"latitude"] doubleValue])*f),
                    @"longitude":@(TWrappedLongitude([leftPoint[@"longitude"] doubleValue],[rightPoint[@"longitude"] doubleValue],f)), @"time":date } mutableCopy];
                NSNumber *a=leftPoint[@"pressureAltitudeFt"], *b=rightPoint[@"pressureAltitudeFt"];
                if (a && b) sample[@"pressureAltitudeFt"]=@([a doubleValue]+([b doubleValue]-[a doubleValue])*f);
                point=sample;
            }
        }
        if (!point) continue;
        if (leftPoint && rightPoint && ([leftPoint[@"latitude"] doubleValue]!=[rightPoint[@"latitude"] doubleValue] || [leftPoint[@"longitude"] doubleValue]!=[rightPoint[@"longitude"] doubleValue])) track=@(TBearing(leftPoint,rightPoint));
        NSMutableDictionary *aircraft=[_aircraft[hex] mutableCopy]; if (!aircraft) continue;
        aircraft[@"latitude"]=point[@"latitude"]; aircraft[@"longitude"]=point[@"longitude"]; aircraft[@"positionTime"]=date;
        if (point[@"pressureAltitudeFt"]) aircraft[@"pressureAltitudeFt"]=point[@"pressureAltitudeFt"];
        else [aircraft removeObjectForKey:@"pressureAltitudeFt"];
        for (NSString *key in @[@"groundSpeedKt", @"verticalRateFpm", @"verticalTrend", @"squawk", @"distanceNm", @"trackDegrees"]) [aircraft removeObjectForKey:key];
        if (track) aircraft[@"trackDegrees"]=track;
        [result addObject:aircraft];
    }
    return result;
}
- (void)mergeSnapshot:(NSDictionary *)snapshot {
    NSDate *latestSeen=[snapshot[@"time"] isKindOfClass:NSDate.class]?snapshot[@"time"]:self.latestTime;
    for (NSDictionary *aircraft in snapshot[@"aircraft"]) {
        NSString *hex=aircraft[@"hex"];
        NSDate *time=aircraft[@"positionTime"];
        if (![hex isKindOfClass:NSString.class] || !hex.length || ![time isKindOfClass:NSDate.class] ||
            !TNumber(aircraft[@"latitude"]) || !TNumber(aircraft[@"longitude"]) || !TNumber(aircraft[@"pressureAltitudeFt"])) continue;
        if (!latestSeen || [time compare:latestSeen]==NSOrderedDescending) latestSeen=time;
        if (!_aircraft[hex] || [time compare:_aircraft[hex][@"positionTime"]]!=NSOrderedAscending) _aircraft[hex]=[aircraft copy];
        NSMutableArray *points=_tracks[hex];
        if (!points) points=_tracks[hex]=[NSMutableArray array];
        NSDictionary *point=@{@"latitude":aircraft[@"latitude"], @"longitude":aircraft[@"longitude"],
                              @"pressureAltitudeFt":aircraft[@"pressureAltitudeFt"], @"time":time};
        NSUInteger index=0; BOOL replaced=NO;
        for (NSDictionary *existing in points) {
            NSComparisonResult comparison=[existing[@"time"] compare:time];
            if (comparison==NSOrderedSame) { points[index]=point; replaced=YES; break; }
            if (comparison==NSOrderedDescending) break;
            index++;
        }
        if (!replaced) [points insertObject:point atIndex:index];
        while (points.count>_maximumPoints) [points removeObjectAtIndex:0];
    }
    if (!self.latestTime || [latestSeen compare:self.latestTime]==NSOrderedDescending) self.latestTime=latestSeen;
    NSDate *cutoff=[self.latestTime dateByAddingTimeInterval:-14400];
    for (NSString *hex in [_tracks.allKeys copy]) {
        NSMutableArray *points=_tracks[hex];
        while (points.count && cutoff && [points.firstObject[@"time"] compare:cutoff]==NSOrderedAscending) [points removeObjectAtIndex:0];
        if (!points.count || (cutoff && [points.lastObject[@"time"] compare:cutoff]==NSOrderedAscending)) { [_tracks removeObjectForKey:hex]; [_aircraft removeObjectForKey:hex]; [_colours removeObjectForKey:hex]; }
    }
    while (_tracks.count>256) {
        NSString *oldest=nil; NSDate *oldestDate=nil;
        for (NSString *hex in _tracks) { if ([_mutableSelections containsObject:hex]) continue; NSDate *date=_tracks[hex].lastObject[@"time"]; if (!oldestDate || [date compare:oldestDate]==NSOrderedAscending) { oldest=hex; oldestDate=date; } }
        if (!oldest) break; [_tracks removeObjectForKey:oldest]; [_aircraft removeObjectForKey:oldest]; [_colours removeObjectForKey:oldest];
    }
}
- (BOOL)toggleSelectionForHex:(NSString *)hex {
    if (![hex isKindOfClass:NSString.class] || !hex.length) return NO;
    if ([_mutableSelections containsObject:hex]) { [_mutableSelections removeObject:hex]; return NO; }
    if (_mutableSelections.count>=self.maximumSelections) return NO;
    [_mutableSelections addObject:hex];
    (void)[self colourIndexForHex:hex];
    return YES;
}
- (BOOL)removeSelectionForHex:(NSString *)hex {
    NSUInteger index=[_mutableSelections indexOfObject:hex];
    if (index==NSNotFound) return NO;
    [_mutableSelections removeObjectAtIndex:index]; return YES;
}
- (void)clearSelections { [_mutableSelections removeAllObjects]; }
- (NSInteger)colourIndexForHex:(NSString *)hex {
    if (![hex isKindOfClass:NSString.class] || !hex.length) return NSNotFound;
    BOOL used[8]={NO};
    for (NSString *selected in _mutableSelections)
        if (![selected isEqualToString:hex] && _colours[selected]) used[_colours[selected].integerValue]=YES;
    NSNumber *known=_colours[hex];
    if (known && !used[known.integerValue]) return known.integerValue;
    NSUInteger hash=0; for (NSUInteger i=0;i<hex.length;i++) hash=(hash*33u) ^ [hex characterAtIndex:i];
    for (NSUInteger offset=0; offset<8; offset++) {
        NSInteger candidate=(hash+offset)%8;
        if (!used[candidate]) { _colours[hex]=@(candidate); return candidate; }
    }
    return NSNotFound;
}
@end

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
