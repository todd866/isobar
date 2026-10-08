#import "skyview.h"
#import <math.h>

double SkyAerodromeElevationFt(NSString *code) {
    static NSDictionary<NSString *, NSNumber *> *table;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        table = @{@"YPPH": @67, @"YSSY": @21, @"YMML": @434, @"YBBN": @13, @"YPAD": @20,
                  @"YMHB": @13, @"YPDN": @103, @"YSCB": @1886};
    });
    NSNumber *value = [code isKindOfClass:NSString.class] ? table[code.uppercaseString] : nil;
    return value ? value.doubleValue : NAN;
}

NSNumber *SkyAerodromeCoastKm(NSString *code) {
    if (![code isKindOfClass:NSString.class]) return nil;
    return @{@"YPPH": @(-19), @"YSSY": @6}[code.uppercaseString];
}

static NSString *SkyText(id value) { return [value isKindOfClass:NSString.class] && [value length] ? value : nil; }

static NSNumber *SkyMs(id value) {
    NSString *text = SkyText(value);
    if (!text) return nil;
    static NSISO8601DateFormatter *plain, *fractional;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        plain = [NSISO8601DateFormatter new];
        fractional = [NSISO8601DateFormatter new];
        fractional.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    });
    // The upper-air product writes UTC times without a zone: "2026-10-08T03:00".
    if (text.length == 16) text = [text stringByAppendingString:@":00Z"];
    else if (text.length == 19) text = [text stringByAppendingString:@"Z"];
    NSDate *date = [plain dateFromString:text] ?: [fractional dateFromString:text];
    return date ? @(llround(date.timeIntervalSince1970 * 1000.0)) : nil;
}

static NSArray *SkyColumn(NSDictionary *level, NSString *key, NSUInteger count) {
    NSArray *values = [level[key] isKindOfClass:NSArray.class] ? level[key] : @[];
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:count];
    for (NSUInteger i = 0; i < count; i++) {
        id value = i < values.count ? values[i] : nil;
        BOOL finite = [value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]);
        [out addObject:finite ? value : NSNull.null];
    }
    return out;
}

NSDictionary *SkyProfileSeries(NSDictionary *upper) {
    NSArray *rawTimes = [upper[@"time"] isKindOfClass:NSArray.class] ? upper[@"time"] : nil;
    NSDictionary *levels = [upper[@"levels"] isKindOfClass:NSDictionary.class] ? upper[@"levels"] : nil;
    if (!rawTimes.count || !levels.count) return nil;
    NSMutableArray *times = [NSMutableArray array];
    for (id value in rawTimes) {
        NSNumber *ms = SkyMs(value);
        if (!ms) return nil;
        [times addObject:ms];
    }
    NSMutableArray *rows = [NSMutableArray array];
    NSUInteger n = times.count;
    for (NSString *key in levels) {
        NSDictionary *level = levels[key];
        double hPa = key.doubleValue;
        if (![level isKindOfClass:NSDictionary.class] || !(hPa >= 1 && hPa <= 1100)) continue;
        [rows addObject:@{@"hPa": @(hPa), @"z": SkyColumn(level, @"height_m", n), @"t": SkyColumn(level, @"temperature_c", n),
            @"rh": SkyColumn(level, @"relative_humidity_pct", n), @"ws": SkyColumn(level, @"wind_speed_kt", n),
            @"wd": SkyColumn(level, @"wind_direction_deg", n), @"cc": SkyColumn(level, @"cloud_cover_pct", n),
            @"w": SkyColumn(level, @"vertical_velocity_ms", n)}];
    }
    if (!rows.count) return nil;
    [rows sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [b[@"hPa"] compare:a[@"hPa"]]; }];
    return @{@"run": SkyText(upper[@"run"]) ?: @"", @"time": times, @"levels": rows};
}

NSDictionary *SkyPointFeed(double lat, double lon, NSString *name, double elevationFt, NSNumber *coastKm,
                           NSDictionary *upper, NSDictionary *aviation, NSDate *now) {
    if (!isfinite(lat) || !isfinite(lon)) return nil;
    NSString *label = SkyText(name) ?: [NSString stringWithFormat:@"%.2f,%.2f", lat, lon];
    NSMutableDictionary *feed = [@{@"lat": @(lat), @"lon": @(lon), @"name": label,
        @"elevationFt": isfinite(elevationFt) ? @(elevationFt) : @0, @"coastKm": coastKm ?: NSNull.null,
        @"nowMs": @(llround((now ?: NSDate.date).timeIntervalSince1970 * 1000.0)),
        @"profile": NSNull.null, @"report": NSNull.null} mutableCopy];
    NSDictionary *metar = [aviation[@"metar"] isKindOfClass:NSDictionary.class] ? aviation[@"metar"] : nil;
    NSDictionary *taf = [aviation[@"taf"] isKindOfClass:NSDictionary.class] ? aviation[@"taf"] : nil;
    if (SkyText(metar[@"raw"]) || SkyText(taf[@"raw"])) {
        feed[@"report"] = @{
            @"metar": SkyText(metar[@"raw"]) ? @{@"raw": metar[@"raw"], @"time": SkyText(metar[@"time"]) ?: NSNull.null} : NSNull.null,
            @"taf": SkyText(taf[@"raw"]) ? @{@"raw": taf[@"raw"], @"issue": SkyText(taf[@"issue_time"]) ?: NSNull.null,
                @"from": SkyText(taf[@"valid_from"]) ?: NSNull.null, @"to": SkyText(taf[@"valid_to"]) ?: NSNull.null} : NSNull.null};
    }
    NSDictionary *series = SkyProfileSeries(upper);
    if (series) {
        NSMutableDictionary *profile = [series mutableCopy];
        [profile addEntriesFromDictionary:@{@"icao": label, @"lat": @(lat), @"lon": @(lon),
            @"elevationFt": feed[@"elevationFt"], @"coastKm": feed[@"coastKm"]}];
        feed[@"profile"] = profile;
    }
    return feed;
}

NSDictionary *SkySectionFeed(NSDictionary *aviation, NSDictionary *upper, NSDictionary *aerodrome, NSDate *now) {
    NSString *code = [SkyText(aerodrome[@"code"]) uppercaseString];
    if (!code.length) return nil;
    double lat = [aerodrome[@"latitude"] isKindOfClass:NSNumber.class] ? [aerodrome[@"latitude"] doubleValue] : NAN;
    double lon = [aerodrome[@"longitude"] isKindOfClass:NSNumber.class] ? [aerodrome[@"longitude"] doubleValue] : NAN;
    double elevation = SkyAerodromeElevationFt(code);
    if (!isfinite(elevation) && [aerodrome[@"elevationFt"] isKindOfClass:NSNumber.class]) elevation = [aerodrome[@"elevationFt"] doubleValue];
    // Products only when they are this aerodrome's.
    NSString *reportCode = [SkyText(aviation[@"icao"]) ?: SkyText(aviation[@"metar"][@"icao"]) uppercaseString];
    BOOL ours = [reportCode isEqual:code];
    BOOL profileOurs = [[SkyText(upper[@"id"]) uppercaseString] isEqual:code];
    return SkyPointFeed(lat, lon, code, elevation, SkyAerodromeCoastKm(code), profileOurs ? upper : nil, ours ? aviation : nil, now);
}

NSString *SkySectionWebRoot(void) {
    NSString *page = [[NSBundle mainBundle] pathForResource:@"sky" ofType:@"html" inDirectory:@"training"];
    if (page.length) return [page.stringByDeletingLastPathComponent stringByStandardizingPath];
    const char *env = getenv("ISOBAR_TRAINING_DIST");
    if (!env || !env[0]) return nil;
    NSString *root = [[NSString stringWithUTF8String:env] stringByStandardizingPath];
    BOOL built = [NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@"sky.html"]] &&
        [NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@"sky.js"]];
    return built ? root : nil;
}

// WKUserContentController keeps its handlers; this keeps the view out of that cycle.
@interface SkyMessageProxy : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@property (nonatomic, copy) NSString *root;
@end
@implementation SkyMessageProxy
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    [self.target userContentController:controller didReceiveScriptMessage:message];
}
- (void)webView:(__unused WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    NSString *path = url.path.stringByStandardizingPath;
    BOOL local = url.isFileURL && self.root.length && [path hasPrefix:[self.root stringByAppendingString:@"/"]];
    decisionHandler(local || [url.scheme isEqual:@"about"] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
@end

@interface SkySectionView () <WKScriptMessageHandler>
@end

@implementation SkySectionView {
    WKWebView *_web;
    SkyMessageProxy *_proxy;
    NSString *_feedJSON;
    BOOL _feedSent, _timeInFlight, _timeDirty;
    double _sentMs;
}

- (instancetype)initWithFrame:(NSRect)frame {
    if ((self = [super initWithFrame:frame])) {
        _sentMs = NAN;
        self.accessibilityIdentifier = @"sky.section";
        self.accessibilityElement = YES;
        self.accessibilityRole = NSAccessibilityImageRole;
        self.accessibilityLabel = @"Sky section";
    }
    return self;
}

- (void)dealloc { [self tearDown]; }
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (WKWebView *)webView { return _web; }

- (BOOL)wantsWeb {
    return self.window && !self.isHiddenOrHasHiddenAncestor && SkySectionWebRoot().length;
}

- (void)updateActive {
    if ([self wantsWeb]) { if (!_web) [self buildWeb]; }
    else if (_web) [self tearDown];
}
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self updateActive]; }
- (void)viewDidHide { [super viewDidHide]; [self updateActive]; }
- (void)viewDidUnhide { [super viewDidUnhide]; [self updateActive]; }

- (BOOL)dark {
    NSAppearanceName match = [self.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
    return [match isEqual:NSAppearanceNameDarkAqua];
}

- (void)buildWeb {
    NSString *root = SkySectionWebRoot();
    if (!root.length) return;
    _proxy = [SkyMessageProxy new];
    _proxy.target = self;
    _proxy.root = root;
    WKUserContentController *content = [WKUserContentController new];
    [content addScriptMessageHandler:_proxy name:@"sky"];
    NSString *theme = [NSString stringWithFormat:@"window.__SKY_THEME='%@';", self.dark ? @"dark" : @"light"];
    [content addUserScript:[[WKUserScript alloc] initWithSource:theme injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.userContentController = content;
    config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    config.suppressesIncrementalRendering = YES;
    WKWebView *web = [[WKWebView alloc] initWithFrame:self.bounds configuration:config];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    web.navigationDelegate = _proxy;
    web.allowsMagnification = NO;
    web.allowsBackForwardNavigationGestures = NO;
    [web setValue:@NO forKey:@"drawsBackground"];
    web.accessibilityElement = NO;
    [self addSubview:web];
    _web = web;
    _pageReady = NO;
    _feedSent = NO;
    _timeInFlight = NO;
    _sentMs = NAN;
    NSURL *dir = [NSURL fileURLWithPath:root isDirectory:YES];
    [web loadFileURL:[dir URLByAppendingPathComponent:@"sky.html"] allowingReadAccessToURL:dir];
}

- (void)tearDown {
    if (!_web) return;
    [_web stopLoading];
    _web.navigationDelegate = nil;
    [_web.configuration.userContentController removeScriptMessageHandlerForName:@"sky"];
    [_web removeFromSuperview];
    _web = nil;
    _proxy = nil;
    _pageReady = NO;
    _timeInFlight = NO;
}

- (void)userContentController:(__unused WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    NSDictionary *body = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
    if (!body) return;
    if ([body[@"ready"] boolValue]) {
        _pageReady = YES;
        _feedSent = NO;
        _sentMs = NAN;
        [self push];
        return;
    }
    _drawnState = [body copy];
    self.accessibilityValue = [self spokenState];
    if (self.onState) self.onState(_drawnState);
}

- (NSString *)spokenState {
    NSMutableArray *parts = [NSMutableArray array];
    NSNumberFormatter *f = [NSNumberFormatter new];
    f.numberStyle = NSNumberFormatterDecimalStyle;
    f.maximumFractionDigits = 0;
    for (NSDictionary *layer in _drawnState[@"layers"]) {
        if (![layer isKindOfClass:NSDictionary.class]) continue;
        double base = round([layer[@"baseFtAmsl"] doubleValue] / 100) * 100;
        [parts addObject:[NSString stringWithFormat:@"%@ %@ %@ ft", layer[@"cover"], layer[@"type"], [f stringFromNumber:@(base)]]];
    }
    if ([_drawnState[@"freezingFt"] isKindOfClass:NSNumber.class])
        [parts addObject:[NSString stringWithFormat:@"0°C %@ ft", [f stringFromNumber:@(round([_drawnState[@"freezingFt"] doubleValue] / 100) * 100)]]];
    for (NSString *note in _drawnState[@"notes"]) if ([note isKindOfClass:NSString.class]) [parts addObject:note];
    return parts.count ? [parts componentsJoinedByString:@", "] : @"No cloud";
}

- (void)setAviation:(NSDictionary *)aviation upper:(NSDictionary *)upper aerodrome:(NSDictionary *)aerodrome now:(NSDate *)now {
    [self setPoint:SkySectionFeed(aviation, upper, aerodrome, now ?: NSDate.date)];
}

- (void)setPoint:(NSDictionary *)feed {
    NSData *json = feed ? [NSJSONSerialization dataWithJSONObject:feed options:0 error:nil] : nil;
    NSString *text = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : nil;
    if ([text isEqual:_feedJSON]) return;
    _feedJSON = text;
    _feedSent = NO;
    [self push];
}

- (void)setTime:(NSDate *)time {
    if (_time == time || [_time isEqualToDate:time]) return;
    _time = time;
    [self push];
}

- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    if (_pageReady) [_web evaluateJavaScript:[NSString stringWithFormat:@"window.isobarSky.theme(%@)", self.dark ? @"true" : @"false"] completionHandler:nil];
}

// One time change in flight at a time; the newest wins.
- (void)push {
    if (!_pageReady || !_web) return;
    if (!_feedSent && _feedJSON.length) {
        _feedSent = YES;
        NSString *script = [NSString stringWithFormat:@"window.isobarSky.theme(%@);window.isobarSky.feed(%@)",
            self.dark ? @"true" : @"false", _feedJSON];
        [_web evaluateJavaScript:script completionHandler:nil];
    }
    if (!_time) return;
    double ms = round(_time.timeIntervalSince1970 * 1000.0);
    if (ms == _sentMs) return;
    if (_timeInFlight) { _timeDirty = YES; return; }
    _timeInFlight = YES;
    _timeDirty = NO;
    _sentMs = ms;
    __weak SkySectionView *weak = self;
    WKWebView *web = _web;
    [web evaluateJavaScript:[NSString stringWithFormat:@"window.isobarSky.time(%.0f)", ms] completionHandler:^(__unused id result, __unused NSError *error) {
        SkySectionView *strong = weak;
        if (!strong || strong->_web != web) return;
        strong->_timeInFlight = NO;
        if (strong->_timeDirty) [strong push];
    }];
}

- (void)snapshotWithCompletion:(void (^)(NSImage *))completion {
    if (!_web || !_pageReady) { completion(nil); return; }
    // An offscreen or occluded window gets no animation frames: draw first.
    WKWebView *web = _web;
    [web evaluateJavaScript:@"window.isobarSky.flush()" completionHandler:^(__unused id result, __unused NSError *flushError) {
        WKSnapshotConfiguration *config = [WKSnapshotConfiguration new];
        config.rect = web.bounds;
        config.afterScreenUpdates = YES;
        [web takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, __unused NSError *error) { completion(image); }];
    }];
}
@end
