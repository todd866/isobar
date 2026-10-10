#import "trafficroute.h"
#import <math.h>

static const NSUInteger TRMaxBytes = 256 * 1024;
static const NSUInteger TRMaxEntries = 128;
static const NSUInteger TRMaxInflight = 8;
static const NSTimeInterval TRTTL = 600;

static BOOL TRNumber(id value) { return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() && isfinite([value doubleValue]); }
static NSString *TRCallsign(NSString *value) {
    if (![value isKindOfClass:NSString.class]) return @"";
    NSString *trimmed=[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].uppercaseString;
    if (trimmed.length<2 || trimmed.length>12) return @"";
    NSCharacterSet *allowed=[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -"];
    if ([trimmed rangeOfCharacterFromSet:[allowed invertedSet]].location!=NSNotFound ||
        ![[NSCharacterSet alphanumericCharacterSet] characterIsMember:[trimmed characterAtIndex:0]]) return @"";
    return [trimmed stringByReplacingOccurrencesOfString:@" " withString:@""];
}
static NSDictionary *TRAirport(NSDictionary *raw) {
    if (![raw isKindOfClass:NSDictionary.class]) return nil;
    id rawIcao=raw[@"icao"]; if (![rawIcao isKindOfClass:NSString.class]) rawIcao=raw[@"airport_icao"];
    if (![rawIcao isKindOfClass:NSString.class]) return nil;
    NSString *icao=[(NSString *)rawIcao stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].uppercaseString;
    NSNumber *lat=TRNumber(raw[@"latitude"])?raw[@"latitude"]:(TRNumber(raw[@"lat"])?raw[@"lat"]:nil);
    NSNumber *lon=TRNumber(raw[@"longitude"])?raw[@"longitude"]:(TRNumber(raw[@"lon"])?raw[@"lon"]:nil);
    if (icao.length!=4 || [icao rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] invertedSet]].location!=NSNotFound || !lat || !lon || fabs(lat.doubleValue)>90 || fabs(lon.doubleValue)>180) return nil;
    NSMutableDictionary *airport=[@{@"icao":icao, @"latitude":lat, @"longitude":lon} mutableCopy];
    NSString *name=[raw[@"name"] isKindOfClass:NSString.class]?raw[@"name"]:nil;
    id rawIata=[raw[@"iata"] isKindOfClass:NSString.class]?raw[@"iata"]:raw[@"airport_iata"];
    NSString *iata=[rawIata isKindOfClass:NSString.class]?(NSString *)rawIata:nil;
    if (name.length) airport[@"name"]=name.length>120?[name substringToIndex:120]:name;
    if (iata.length) airport[@"iata"]=iata.uppercaseString.length>3?[iata.uppercaseString substringToIndex:3]:iata.uppercaseString;
    return airport;
}
NSDictionary *TrafficRouteParse(NSDictionary *payload, NSString *callsign) {
    NSString *key=TRCallsign(callsign); if (!key.length || ![payload isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *response=[payload[@"response"] isKindOfClass:NSDictionary.class]?payload[@"response"]:payload;
    NSDictionary *flight=[response[@"flightroute"] isKindOfClass:NSDictionary.class]?response[@"flightroute"]:response;
    NSDictionary *origin=TRAirport(flight[@"origin"]), *destination=TRAirport(flight[@"destination"]);
    if (!origin || !destination) return nil;
    return @{ @"callsign":key, @"origin":origin, @"destination":destination };
}

@interface TrafficRouteLookup () <NSURLSessionDataDelegate>
@property(nonatomic) BOOL enabled;
@property(nonatomic,strong) NSURLSession *session;
@property(nonatomic,strong) NSURLSessionConfiguration *sessionConfiguration;
@property(nonatomic,strong) NSMutableDictionary<NSString *, NSDictionary *> *cache;
@property(nonatomic,strong) NSMutableDictionary<NSString *, NSDate *> *cacheDates;
@property(nonatomic,strong) NSMutableDictionary<NSString *, NSMutableArray<void (^)(NSDictionary *)> *> *waiters;
@property(nonatomic,strong) NSMutableDictionary<NSURLSessionDataTask *, NSMutableData *> *buffers;
@property(nonatomic,strong) NSMutableDictionary<NSURLSessionDataTask *, NSString *> *taskKeys;
@end

@implementation TrafficRouteLookup
+ (instancetype)configuredWithConfiguration:(NSURLSessionConfiguration *)configuration {
    BOOL enabled=[[[NSProcessInfo processInfo].environment objectForKey:@"ISOBAR_ADSBDB_ROUTES_ENABLED"] isEqual:@"1"];
    return [[self alloc] initWithConfiguration:configuration enabled:enabled];
}
- (instancetype)initWithConfiguration:(NSURLSessionConfiguration *)configuration { return [self initWithConfiguration:configuration enabled:NO]; }
- (instancetype)initWithConfiguration:(NSURLSessionConfiguration *)configuration enabled:(BOOL)enabled {
    if ((self=[super init])) {
        _enabled=enabled; _cache=[NSMutableDictionary dictionary]; _cacheDates=[NSMutableDictionary dictionary];
        _waiters=[NSMutableDictionary dictionary]; _buffers=[NSMutableDictionary dictionary]; _taskKeys=[NSMutableDictionary dictionary];
        _sessionConfiguration=configuration ?: NSURLSessionConfiguration.ephemeralSessionConfiguration;
        if (_enabled) [self ensureSession];
    }
    return self;
}
- (void)ensureSession {
    if (_session || !_enabled) return;
    NSOperationQueue *queue=[[NSOperationQueue alloc] init]; queue.maxConcurrentOperationCount=1;
    _session=[NSURLSession sessionWithConfiguration:_sessionConfiguration delegate:self delegateQueue:queue];
}
- (void)lookupCallsign:(NSString *)callsign completion:(void (^)(NSDictionary * _Nullable))completion {
    NSString *key=TRCallsign(callsign); if (!key.length || !_enabled) { if (completion) completion(nil); return; }
    @synchronized(self) {
        NSDate *date=_cacheDates[key]; if (date && -date.timeIntervalSinceNow<TRTTL) { id cached=_cache[key]; if (completion) completion(cached==NSNull.null?nil:cached); return; }
        if (date) { [_cache removeObjectForKey:key]; [_cacheDates removeObjectForKey:key]; }
        if (_waiters[key]) { if (completion) [_waiters[key] addObject:[completion copy]]; return; }
        if (_taskKeys.count>=TRMaxInflight) { if (completion) completion(nil); return; }
        void (^waiter)(NSDictionary *);
        if (completion) waiter=[completion copy]; else waiter=^(NSDictionary *value) { (void)value; };
        _waiters[key]=[NSMutableArray arrayWithObject:waiter];
        NSURL *url=[NSURL URLWithString:[NSString stringWithFormat:@"https://api.adsbdb.com/v0/callsign/%@",[key stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet]]];
        NSMutableURLRequest *request=[NSMutableURLRequest requestWithURL:url]; request.timeoutInterval=5; [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
        [self ensureSession]; NSURLSessionDataTask *task=[_session dataTaskWithRequest:request]; _taskKeys[task]=key; _buffers[task]=[NSMutableData data]; [task resume];
    }
}
- (void)finish:(NSURLSessionDataTask *)task route:(NSDictionary *)route {
    NSString *key=nil; NSArray *waiters=nil;
    @synchronized(self) {
        key=_taskKeys[task];
        if (!key) return; _cache[key]=route ?: (id)NSNull.null; _cacheDates[key]=NSDate.date;
        while (_cache.count>TRMaxEntries) {
            NSString *oldest=nil; NSDate *oldestDate=nil;
            for (NSString *candidate in _cacheDates) if (!oldestDate || [_cacheDates[candidate] compare:oldestDate]==NSOrderedAscending) { oldest=candidate; oldestDate=_cacheDates[candidate]; }
            if (!oldest) break; [_cache removeObjectForKey:oldest]; [_cacheDates removeObjectForKey:oldest];
        }
        waiters=[_waiters[key] copy]; [_waiters removeObjectForKey:key]; [_taskKeys removeObjectForKey:task]; [_buffers removeObjectForKey:task];
    }
    dispatch_async(dispatch_get_main_queue(), ^{ for (void (^callback)(NSDictionary *) in waiters) callback(route); });
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    if (response.expectedContentLength >= 0 && (unsigned long long)response.expectedContentLength > TRMaxBytes) { [task cancel]; completionHandler(NSURLSessionResponseCancel); return; }
    completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    @synchronized(self) { NSMutableData *buffer=_buffers[task]; if (!buffer) return; if (buffer.length+data.length>TRMaxBytes) { [task cancel]; return; } [buffer appendData:data]; }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (![task isKindOfClass:NSURLSessionDataTask.class]) return; NSURLSessionDataTask *dataTask=(NSURLSessionDataTask *)task;
    NSDictionary *route=nil; NSData *data=nil; NSString *key=nil; NSHTTPURLResponse *response=(NSHTTPURLResponse *)task.response;
    @synchronized(self) { data=[_buffers[dataTask] copy]; key=[_taskKeys[dataTask] copy]; }
    if (!error && response.statusCode>=200 && response.statusCode<300 && data.length<=TRMaxBytes) { id json=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]; if ([json isKindOfClass:NSDictionary.class]) route=TrafficRouteParse(json,key); }
    [self finish:dataTask route:route];
}
- (void)clear { @synchronized(self) { [_cache removeAllObjects]; [_cacheDates removeAllObjects]; for (NSURLSessionDataTask *task in [_taskKeys.allKeys copy]) [task cancel]; [_waiters removeAllObjects]; [_taskKeys removeAllObjects]; [_buffers removeAllObjects]; [_session invalidateAndCancel]; _session=nil; } }
- (void)dealloc { [_session invalidateAndCancel]; }
@end
