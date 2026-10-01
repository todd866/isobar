#import "pure.h"
#import <math.h>
#import <stdlib.h>
#import <zlib.h>
#import <ctype.h>

static NSDictionary *JSONObject(NSData *data) {
    if (!data.length) return nil;
    id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [obj isKindOfClass:NSDictionary.class] ? obj : nil;
}

static NSArray *JSONArray(id obj) {
    return [obj isKindOfClass:NSArray.class] ? obj : nil;
}

static id Num(id v) {
    if ([v isKindOfClass:NSNumber.class]) return v;
    if ([v isKindOfClass:NSString.class]) {
        NSScanner *s = [NSScanner scannerWithString:v];
        double d = 0;
        if ([s scanDouble:&d]) return @(d);
    }
    return nil;
}

NSDate *IssueTimeFromCacheBuster(NSString *text) {
    if (!text.length) return nil;
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"IDG00074\\.gif\\?(\\d{4})-([A-Za-z]{3})-(\\d{2})-(\\d{2}):(\\d{2}):(\\d{2})"
        options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!m || m.numberOfRanges < 7) return nil;
    NSArray *months = @[@"jan",@"feb",@"mar",@"apr",@"may",@"jun",@"jul",@"aug",@"sep",@"oct",@"nov",@"dec"];
    NSString *mon = [[text substringWithRange:[m rangeAtIndex:2]] lowercaseString];
    NSUInteger month = [months indexOfObject:mon];
    if (month == NSNotFound) return nil;
    NSDateComponents *c = [NSDateComponents new];
    c.calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    c.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    c.year = [[text substringWithRange:[m rangeAtIndex:1]] integerValue];
    c.month = (NSInteger)month + 1;
    c.day = [[text substringWithRange:[m rangeAtIndex:3]] integerValue];
    c.hour = [[text substringWithRange:[m rangeAtIndex:4]] integerValue];
    c.minute = [[text substringWithRange:[m rangeAtIndex:5]] integerValue];
    c.second = [[text substringWithRange:[m rangeAtIndex:6]] integerValue];
    return c.date;
}

NSDate *IssueTimeFromHTTPDate(NSString *httpDate) {
    if (!httpDate.length) return nil;
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    f.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    f.dateFormat = @"EEE, dd MMM yyyy HH:mm:ss zzz";
    return [f dateFromString:httpDate];
}

NSString *AgeText(NSDate *then, NSDate *now) {
    if (!then || !now) return @"—";
    NSTimeInterval s = [now timeIntervalSinceDate:then];
    if (s < 0) s = 0;
    if (s < 60) return @"just now";
    if (s < 3600) return [NSString stringWithFormat:@"%.0fm", floor(s / 60.0)];
    if (s < 86400) return [NSString stringWithFormat:@"%.0fh", floor(s / 3600.0)];
    return [NSString stringWithFormat:@"%.0fd", floor(s / 86400.0)];
}

NSString *ClockText(NSDate *date, NSTimeZone *tz, NSDate *now) {
    if (!date) return @"—";
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: NSTimeZone.localTimeZone;
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = cal.timeZone;
    BOOL same = now && [cal isDate:date inSameDayAsDate:now];
    f.dateFormat = same ? @"HH:mm" : @"d MMM HH:mm";
    return [f stringFromDate:date];
}

static NSDictionary *StateTable(void) {
    return @{
        @"WA": @{@"product": @"IDW60901", @"path": @"wa"},
        @"NSW": @{@"product": @"IDN60901", @"path": @"nsw"},
        @"VIC": @{@"product": @"IDV60901", @"path": @"vic"},
        @"QLD": @{@"product": @"IDQ60901", @"path": @"qld"},
        @"SA": @{@"product": @"IDS60901", @"path": @"sa"},
        @"TAS": @{@"product": @"IDT60901", @"path": @"tas"},
        @"NT": @{@"product": @"IDD60901", @"path": @"nt"},
        @"ACT": @{@"product": @"IDN60903", @"path": @"act"},
    };
}

static NSString *CanonState(NSString *state) {
    return state.uppercaseString;
}

NSString *ObservationProductForState(NSString *state) {
    return StateTable()[CanonState(state)][@"product"];
}

NSString *ObservationIndexURL(NSString *state) {
    NSString *path = StateTable()[CanonState(state)][@"path"];
    if (!path) return nil;
    return [NSString stringWithFormat:@"https://www.bom.gov.au/%@/observations/%@all.shtml", path, path];
}

NSString *ObservationJSONURL(NSString *product, NSString *wmo) {
    if (!product.length || !wmo.length) return nil;
    return [NSString stringWithFormat:@"https://www.bom.gov.au/fwo/%@/%@.%@.json", product, product, wmo];
}

NSString *HourlyGeohash(NSString *geohash) {
    if (geohash.length < 6) return nil;
    return [geohash substringToIndex:6];
}

static NSTimeZone *TimeZoneForStateCode(NSString *code) {
    if (![code isKindOfClass:NSString.class] || !code.length) return nil;
    NSDictionary *names = @{
        @"WA": @"Australia/Perth",
        @"NT": @"Australia/Darwin",
        @"SA": @"Australia/Adelaide",
        @"QLD": @"Australia/Brisbane",
        @"NSW": @"Australia/Sydney",
        @"ACT": @"Australia/Sydney",
        @"VIC": @"Australia/Melbourne",
        @"TAS": @"Australia/Hobart",
    };
    NSString *name = names[code.uppercaseString];
    return name ? [NSTimeZone timeZoneWithName:name] : nil;
}

static NSString *ObservationStateCode(NSDictionary *obs) {
    NSArray *header = JSONArray(obs[@"header"]);
    if (!header.count || ![header[0] isKindOfClass:NSDictionary.class]) return nil;
    NSString *code = header[0][@"state_time_zone"];
    if (![code isKindOfClass:NSString.class] || !code.length) return nil;
    return code;
}

// Bureau civil stamps are local wall time. A missing or unknown state, or a
// clock time that does not exist (the DST spring-forward gap), is not a time.
static NSDate *CivilTime(NSString *yyyymmddhhmmss, NSTimeZone *tz) {
    if (!tz || (yyyymmddhhmmss.length != 12 && yyyymmddhhmmss.length != 14)) return nil;
    for (NSUInteger i = 0; i < yyyymmddhhmmss.length; i++) {
        unichar c = [yyyymmddhhmmss characterAtIndex:i];
        if (c < '0' || c > '9') return nil;
    }
    NSInteger year = [[yyyymmddhhmmss substringWithRange:NSMakeRange(0, 4)] integerValue];
    NSInteger month = [[yyyymmddhhmmss substringWithRange:NSMakeRange(4, 2)] integerValue];
    NSInteger day = [[yyyymmddhhmmss substringWithRange:NSMakeRange(6, 2)] integerValue];
    NSInteger hour = [[yyyymmddhhmmss substringWithRange:NSMakeRange(8, 2)] integerValue];
    NSInteger minute = [[yyyymmddhhmmss substringWithRange:NSMakeRange(10, 2)] integerValue];
    NSInteger second = yyyymmddhhmmss.length >= 14 ? [[yyyymmddhhmmss substringWithRange:NSMakeRange(12, 2)] integerValue] : 0;
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return nil;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz;
    NSDateComponents *c = [NSDateComponents new];
    c.calendar = cal;
    c.timeZone = tz;
    c.year = year;
    c.month = month;
    c.day = day;
    c.hour = hour;
    c.minute = minute;
    c.second = second;
    NSDate *date = [cal dateFromComponents:c];
    if (!date) return nil;
    NSDateComponents *back = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitSecond fromDate:date];
    if (back.year != year || back.month != month || back.day != day || back.hour != hour || back.minute != minute || back.second != second) return nil;
    return date;
}

double KnotsFromKmh(double kmh) {
    return kmh / 1.852;
}

NSDictionary *ParseLatestObservation(NSData *json) {
    NSDictionary *root = JSONObject(json);
    NSDictionary *obs = [root[@"observations"] isKindOfClass:NSDictionary.class] ? root[@"observations"] : nil;
    NSArray *data = JSONArray(obs[@"data"]);
    if (!data.count || ![data[0] isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *row = data[0];
    NSString *state = ObservationStateCode(obs);
    NSTimeZone *tz = TimeZoneForStateCode(state);
    NSString *stamp = [row[@"local_date_time_full"] isKindOfClass:NSString.class] ? row[@"local_date_time_full"] : nil;
    NSDate *time = CivilTime(stamp, tz);
    NSNumber *temp = Num(row[@"air_temp"]);
    if (!temp || !time || !state) return nil;
    NSString *rain = [row[@"rain_trace"] isKindOfClass:NSString.class] ? row[@"rain_trace"]
        : [row[@"rain_trace"] isKindOfClass:NSNumber.class] ? [row[@"rain_trace"] stringValue] : @"—";
    NSDictionary *tend = PressureTendency(json);
    NSNumber *windKmh = Num(row[@"wind_spd_kmh"]);
    NSNumber *gustKmh = Num(row[@"gust_kmh"]);
    NSNumber *windKt = Num(row[@"wind_spd_kt"]) ?: (windKmh ? @(KnotsFromKmh(windKmh.doubleValue)) : @0);
    NSNumber *gustKt = Num(row[@"gust_kt"]) ?: (gustKmh ? @(KnotsFromKmh(gustKmh.doubleValue)) : @0);
    return @{
        @"name": [row[@"name"] isKindOfClass:NSString.class] ? row[@"name"] : @"",
        @"wmo": row[@"wmo"] ? [row[@"wmo"] description] : @"",
        @"lat": Num(row[@"lat"]) ?: NSNull.null,
        @"lon": Num(row[@"lon"]) ?: NSNull.null,
        @"time": time,
        @"airTemp": temp,
        @"apparent": Num(row[@"apparent_t"]) ?: NSNull.null,
        @"humidity": Num(row[@"rel_hum"]) ?: NSNull.null,
        @"windDir": [row[@"wind_dir"] isKindOfClass:NSString.class] ? row[@"wind_dir"] : @"",
        @"windKmh": windKmh ?: @0,
        @"gustKmh": gustKmh ?: @0,
        @"windKt": windKt,
        @"gustKt": gustKt,
        @"pressMsl": Num(row[@"press_msl"]) ?: NSNull.null,
        @"pressDelta": tend[@"delta"] ?: NSNull.null,
        @"pressHours": tend[@"hours"] ?: NSNull.null,
        @"dewPoint": Num(row[@"dewpt"]) ?: NSNull.null,
        @"rainTrace": rain,
        @"state": state,
    };
}

static NSDate *ISODate(id v) {
    if (![v isKindOfClass:NSString.class]) return nil;
    NSISO8601DateFormatter *f = [NSISO8601DateFormatter new];
    f.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSDate *d = [f dateFromString:v];
    if (d) return d;
    f.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    return [f dateFromString:v];
}

NSArray<NSDictionary *> *ParseDailyForecasts(NSData *json) {
    NSArray *data = JSONArray(JSONObject(json)[@"data"]);
    if (!data) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *day in data) {
        if (![day isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *rain = [day[@"rain"] isKindOfClass:NSDictionary.class] ? day[@"rain"] : @{};
        NSDictionary *amount = [rain[@"amount"] isKindOfClass:NSDictionary.class] ? rain[@"amount"] : @{};
        NSDictionary *nowcast = [day[@"now"] isKindOfClass:NSDictionary.class] ? day[@"now"] : @{};
        [out addObject:@{
            @"date": ISODate(day[@"date"]) ?: NSNull.null,
            @"tempMin": Num(day[@"temp_min"]) ?: NSNull.null,
            @"tempMax": Num(day[@"temp_max"]) ?: NSNull.null,
            @"rainChance": Num(rain[@"chance"]) ?: NSNull.null,
            @"rainMin": Num(amount[@"min"]) ?: NSNull.null,
            @"rainMax": Num(amount[@"max"]) ?: NSNull.null,
            @"shortText": [day[@"short_text"] isKindOfClass:NSString.class] ? day[@"short_text"] : @"",
            @"extendedText": [day[@"extended_text"] isKindOfClass:NSString.class] ? day[@"extended_text"] : @"",
            @"iconDescriptor": [day[@"icon_descriptor"] isKindOfClass:NSString.class] ? day[@"icon_descriptor"] : @"",
            @"isNight": [nowcast[@"is_night"] isKindOfClass:NSNumber.class] ? @([nowcast[@"is_night"] boolValue]) : NSNull.null,
            @"tempNow": Num(nowcast[@"temp_now"]) ?: NSNull.null,
            @"tempLater": Num(nowcast[@"temp_later"]) ?: NSNull.null,
            @"nowLabel": [nowcast[@"now_label"] isKindOfClass:NSString.class] ? nowcast[@"now_label"] : @"",
            @"laterLabel": [nowcast[@"later_label"] isKindOfClass:NSString.class] ? nowcast[@"later_label"] : @"",
        }];
        if (out.count == 7) break;
    }
    return out;
}

NSArray<NSDictionary *> *ParseHourlyForecasts(NSData *json, NSDate *now, NSInteger limit) {
    NSArray *data = JSONArray(JSONObject(json)[@"data"]);
    if (!data || limit <= 0) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *hour in data) {
        if (![hour isKindOfClass:NSDictionary.class]) continue;
        NSDate *t = ISODate(hour[@"time"]);
        if (!t || (now && [t timeIntervalSinceDate:now] < -60)) continue;
        if (now && [t compare:now] == NSOrderedAscending) continue;
        NSDictionary *rain = [hour[@"rain"] isKindOfClass:NSDictionary.class] ? hour[@"rain"] : @{};
        NSDictionary *wind = [hour[@"wind"] isKindOfClass:NSDictionary.class] ? hour[@"wind"] : @{};
        [out addObject:@{
            @"time": t,
            @"temp": Num(hour[@"temp"]) ?: NSNull.null,
            @"rainChance": Num(rain[@"chance"]) ?: NSNull.null,
            @"windDir": [wind[@"direction"] isKindOfClass:NSString.class] ? wind[@"direction"] : @"",
            @"windKmh": Num(wind[@"speed_kilometre"]) ?: NSNull.null,
            @"iconDescriptor": [hour[@"icon_descriptor"] isKindOfClass:NSString.class] ? hour[@"icon_descriptor"] : @"",
            @"isNight": @([hour[@"is_night"] boolValue]),
        }];
        if ((NSInteger)out.count == limit) break;
    }
    return out;
}

NSString *PlainTextFromHTML(NSString *html) {
    if (![html isKindOfClass:NSString.class] || !html.length) return @"";
    NSMutableString *s = [html mutableCopy];
    NSRegularExpression *breaks = [NSRegularExpression regularExpressionWithPattern:
        @"<br\\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>"
        options:NSRegularExpressionCaseInsensitive error:nil];
    [breaks replaceMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"\n"];
    NSRegularExpression *tags = [NSRegularExpression regularExpressionWithPattern:@"<[^>]+>" options:0 error:nil];
    [tags replaceMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@""];
    NSDictionary *entities = @{@"&nbsp;": @" ", @"&#160;": @" ", @"&amp;": @"&", @"&lt;": @"<", @"&gt;": @">", @"&quot;": @"\""};
    for (NSString *key in entities)
        [s replaceOccurrencesOfString:key withString:entities[key] options:0 range:NSMakeRange(0, s.length)];
    NSRegularExpression *spaces = [NSRegularExpression regularExpressionWithPattern:@"[ \\t]+" options:0 error:nil];
    [spaces replaceMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@" "];
    NSRegularExpression *blank = [NSRegularExpression regularExpressionWithPattern:@"\\n{2,}" options:0 error:nil];
    [blank replaceMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"\n"];
    NSMutableArray *lines = [NSMutableArray array];
    for (NSString *line in [s componentsSeparatedByString:@"\n"]) {
        NSString *trim = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trim.length) [lines addObject:trim];
    }
    return [lines componentsJoinedByString:@"\n"];
}

static NSString *WarningBody(NSDictionary *w) {
    id message = w[@"message"];
    NSString *raw = @"";
    if ([message isKindOfClass:NSString.class] && [message length]) raw = PlainTextFromHTML(message);
    else if ([w[@"text"] isKindOfClass:NSString.class]) raw = w[@"text"];
    else if ([w[@"warning_text"] isKindOfClass:NSString.class]) raw = w[@"warning_text"];
    else if ([w[@"description"] isKindOfClass:NSString.class]) raw = w[@"description"];
    return CleanWarningText(raw);
}

static NSDictionary *WarningRecord(NSDictionary *w) {
    NSString *title = [w[@"title"] isKindOfClass:NSString.class] ? w[@"title"] : @"";
    return @{
        @"id": [w[@"id"] isKindOfClass:NSString.class] ? w[@"id"] : @"",
        @"title": title,
        @"shortTitle": [w[@"short_title"] isKindOfClass:NSString.class] ? w[@"short_title"] : title,
        @"text": WarningBody(w),
        @"issue": ISODate(w[@"issue_time"]) ?: NSNull.null,
        @"expiry": ISODate(w[@"expiry_time"]) ?: NSNull.null,
    };
}

NSDictionary *ParseWarningDetail(NSData *json) {
    NSDictionary *data = JSONObject(json)[@"data"];
    if (![data isKindOfClass:NSDictionary.class]) return nil;
    NSString *title = [data[@"title"] isKindOfClass:NSString.class] ? data[@"title"] : @"";
    if (!title.length) return nil;
    return WarningRecord(data);
}

NSArray<NSDictionary *> *ParseWarnings(NSData *json) {
    NSArray *data = JSONArray(JSONObject(json)[@"data"]);
    if (!data) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *w in data) {
        if (![w isKindOfClass:NSDictionary.class]) continue;
        NSString *title = [w[@"title"] isKindOfClass:NSString.class] ? w[@"title"] : @"";
        if (!title.length) continue;
        NSString *phase = [w[@"phase"] isKindOfClass:NSString.class] ? [(NSString *)w[@"phase"] lowercaseString] : @"";
        if ([phase isEqual:@"cancelled"] || [phase isEqual:@"cancel"]) continue;
        [out addObject:WarningRecord(w)];
    }
    return out;
}

NSArray<NSDictionary *> *ParseLocationSearch(NSData *json) {
    NSArray *data = JSONArray(JSONObject(json)[@"data"]);
    if (!data) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *p in data) {
        if (![p isKindOfClass:NSDictionary.class]) continue;
        NSString *hash = [p[@"geohash"] isKindOfClass:NSString.class] ? p[@"geohash"] : @"";
        if (hash.length < 6) continue;
        [out addObject:@{
            @"name": [p[@"name"] isKindOfClass:NSString.class] ? p[@"name"] : @"",
            @"state": [p[@"state"] isKindOfClass:NSString.class] ? p[@"state"] : @"",
            @"geohash": hash,
            @"postcode": [p[@"postcode"] isKindOfClass:NSString.class] ? p[@"postcode"] : @"",
        }];
    }
    return out;
}

NSArray<NSDictionary *> *ParseObservationStations(NSString *html) {
    if (!html.length) return @[];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"/products/ID[A-Z]\\d+/ID[A-Z]\\d+\\.(\\d+)\\.shtml\">([^<]+)"
        options:0 error:nil];
    NSMutableArray *out = [NSMutableArray array];
    [re enumerateMatchesInString:html options:0 range:NSMakeRange(0, html.length)
                      usingBlock:^(NSTextCheckingResult *m, NSMatchingFlags flags, BOOL *stop) {
        (void)flags; (void)stop;
        if (m.numberOfRanges < 3) return;
        NSString *name = [[html substringWithRange:[m rangeAtIndex:2]]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        [out addObject:@{
            @"wmo": [html substringWithRange:[m rangeAtIndex:1]],
            @"name": name,
        }];
    }];
    return out;
}

NSDictionary *MatchStationByName(NSArray<NSDictionary *> *stations, NSString *placeName) {
    if (!placeName.length) return nil;
    for (NSDictionary *s in stations) {
        if ([s[@"name"] caseInsensitiveCompare:placeName] == NSOrderedSame) return s;
    }
    return nil;
}

ChartFit FitChart(double pixelW, double pixelH, double maxPointW, double backingScale) {
    ChartFit fit = {0, 0, 0, NO};
    if (pixelW <= 0 || pixelH <= 0 || maxPointW <= 0) return fit;
    double scale = backingScale > 0 ? backingScale : 1;
    int best = 0;
    for (int k = 1; k <= 4; k++) {
        double w = pixelW * (double)k / scale;
        if (w <= maxPointW + 0.01) best = k;
    }
    if (best > 0) {
        fit.pixelMultiple = best;
        fit.integer = YES;
        fit.width = pixelW * (double)best / scale;
        fit.height = pixelH * (double)best / scale;
        return fit;
    }
    fit.width = maxPointW;
    fit.height = maxPointW * pixelH / pixelW;
    return fit;
}

// Measured from the Bureau's Illustrator chart (IDG00073, 532.207 × 793.779 pt).
// Each panel rect includes its black title strip. PDF origin is the bottom left.
static const double kMSLPRefW = 532.207;
static const double kMSLPRefH = 793.779;
static const MSLPRect kMSLPHeader = {38.937, 746.099, 462.062, 42.225};
static const MSLPRect kMSLPPanels[8] = {
    {38.543, 559.863, 228.072, 182.904},
    {273.328, 559.602, 228.072, 182.904},
    {38.543, 374.227, 228.072, 182.904},
    {273.570, 373.966, 228.072, 182.905},
    {38.543, 188.576, 228.072, 182.905},
    {273.570, 188.315, 228.072, 182.905},
    {38.543, 2.754, 228.072, 182.904},
    {273.570, 2.493, 228.072, 182.904},
};

static MSLPRect MSLPScale(MSLPRect r, double sx, double sy) {
    MSLPRect out = {r.x * sx, r.y * sy, r.width * sx, r.height * sy};
    return out;
}

MSLPPage MSLPPageLayout(double pageWidth, double pageHeight) {
    MSLPPage page = {0};
    if (pageWidth < 100 || pageHeight < 100) return page;
    double sx = pageWidth / kMSLPRefW;
    double sy = pageHeight / kMSLPRefH;
    page.pageWidth = pageWidth;
    page.pageHeight = pageHeight;
    page.header = MSLPScale(kMSLPHeader, sx, sy);
    for (int i = 0; i < 8; i++) page.panels[i] = MSLPScale(kMSLPPanels[i], sx, sy);
    page.valid = YES;
    return page;
}

int MSLPSourceColumn(int timeIndex) {
    if (timeIndex < 0 || timeIndex > 7) return 0;
    return timeIndex % 2;
}

int MSLPSourceRow(int timeIndex) {
    if (timeIndex < 0 || timeIndex > 7) return 0;
    return timeIndex / 2;
}

int MSLPDisplayColumn(int timeIndex) {
    if (timeIndex < 0 || timeIndex > 7) return 0;
    return timeIndex % 4;
}

int MSLPDisplayRow(int timeIndex) {
    if (timeIndex < 0 || timeIndex > 7) return 0;
    return timeIndex / 4;
}

static MSLPColour MSLPByteColour(int red, int green, int blue) {
    return (MSLPColour){red / 255.0, green / 255.0, blue / 255.0};
}

MSLPColour MSLPColourSea(void) { return MSLPByteColour(0xeb, 0xf1, 0xf7); }
MSLPColour MSLPColourLand(void) { return MSLPByteColour(0xf4, 0xee, 0xaf); }
MSLPColour MSLPColourLandLight(void) { return MSLPByteColour(0xf9, 0xf7, 0xde); }
MSLPColour MSLPColourLandMid(void) { return MSLPByteColour(0xf2, 0xe9, 0x97); }
MSLPColour MSLPColourLandDeep(void) { return MSLPByteColour(0xf1, 0xdc, 0x84); }
MSLPColour MSLPColourTitle(void) { return MSLPByteColour(0x03, 0x6d, 0x9b); }
MSLPColour MSLPColourInk(void) { return MSLPByteColour(0x26, 0x23, 0x22); }
MSLPColour MSLPColourPaper(void) { return MSLPByteColour(0xff, 0xff, 0xff); }

static const MSLPColour kFillSources[3] = {
    {0.862, 0.866, 0.871},
    {1, 1, 1},
    {0.137, 0.123, 0.126},
};

NSInteger MSLPFillMapCount(void) { return 3; }

BOOL MSLPFillMap(NSInteger index, MSLPColour *source, MSLPColour *colour) {
    if (index < 0 || index >= MSLPFillMapCount()) return NO;
    MSLPColour mapped[3] = {MSLPColourLand(), MSLPColourSea(), MSLPColourTitle()};
    if (source) *source = kFillSources[index];
    if (colour) *colour = mapped[index];
    return YES;
}

static NSString *MSLPColourOperands(MSLPColour colour) {
    return [NSString stringWithFormat:@"/CS0 cs %.6f %.6f %.6f scn\n", colour.red, colour.green, colour.blue];
}

static BOOL MSLPRectMatch(NSTextCheckingResult *m, NSString *text, double *width, double *height) {
    if (m.numberOfRanges < 5) return NO;
    *width = [text substringWithRange:[m rangeAtIndex:3]].doubleValue;
    *height = [text substringWithRange:[m rangeAtIndex:4]].doubleValue;
    return YES;
}

NSData *MSLPRecolourStream(NSData *content) {
    if (!content.length) return content;
    NSMutableString *text = [[NSMutableString alloc] initWithData:content encoding:NSISOLatin1StringEncoding];
    if (!text) return content;
    MSLPColour land = {0}, sea = {0}, title = {0};
    MSLPFillMap(0, NULL, &land);
    MSLPFillMap(1, NULL, &sea);
    MSLPFillMap(2, NULL, &title);
    NSString *landFrom = @"0.862 0.866 0.871  scn";
    NSString *landTo = [NSString stringWithFormat:@"%.6f %.6f %.6f scn", land.red, land.green, land.blue];
    [text replaceOccurrencesOfString:landFrom withString:landTo options:0 range:NSMakeRange(0, text.length)];

    NSRegularExpression *rects = [NSRegularExpression regularExpressionWithPattern:
        @"([0-9]*\\.?[0-9]+)[ ]+([0-9]*\\.?[0-9]+)[ ]+([0-9]*\\.?[0-9]+)[ ]+(-?[0-9]*\\.?[0-9]+)[ ]+re\\s+f\\*"
        options:0 error:nil];
    NSRegularExpression *titles = [NSRegularExpression regularExpressionWithPattern:
        @"/GS1 gs\\s+([0-9]*\\.?[0-9]+)[ ]+([0-9]*\\.?[0-9]+)[ ]+([0-9]*\\.?[0-9]+)[ ]+(-?[0-9]*\\.?[0-9]+)[ ]+re\\s+f\\*"
        options:0 error:nil];
    NSString *seaPaint = MSLPColourOperands(sea);
    NSString *titlePaint = MSLPColourOperands(title);
    NSArray *seaHits = [rects matchesInString:text options:0 range:NSMakeRange(0, text.length)];
    for (NSInteger i = (NSInteger)seaHits.count - 1; i >= 0; i--) {
        NSTextCheckingResult *m = seaHits[i];
        double width = 0, height = 0;
        if (!MSLPRectMatch(m, text, &width, &height)) continue;
        if (width < 200 || width > 250 || fabs(height) < 160 || fabs(height) > 190) continue;
        [text insertString:seaPaint atIndex:m.range.location];
    }
    NSArray *titleHits = [titles matchesInString:text options:0 range:NSMakeRange(0, text.length)];
    for (NSInteger i = (NSInteger)titleHits.count - 1; i >= 0; i--) {
        NSTextCheckingResult *m = titleHits[i];
        double width = 0, height = 0;
        if (!MSLPRectMatch(m, text, &width, &height)) continue;
        if (width < 200 || width > 250 || fabs(height) < 8 || fabs(height) > 16) continue;
        NSRange token = [text rangeOfString:@"/GS1 gs" options:0 range:m.range];
        if (token.location == NSNotFound) continue;
        [text insertString:[@"\n" stringByAppendingString:titlePaint] atIndex:NSMaxRange(token)];
    }
    return [text dataUsingEncoding:NSISOLatin1StringEncoding] ?: content;
}

static const double kScreenPad = 10;
static const double kScreenGutter = 8;
static const double kHeaderBand = 56;
double GlanceCardHeight(void) { return 128; }

static double StatusBarHeight(NSInteger placeCount, double screenH) {
    if (placeCount < 1) placeCount = 1;
    // One row of glance cards, not a stacked line per place.
    double h = GlanceCardHeight() + 8;
    double cap = screenH * 0.22;
    return h < cap ? h : cap;
}

MSLPRect MSLPAspectFit(double srcWidth, double srcHeight, MSLPRect box) {
    MSLPRect fit = {box.x, box.y, 0, 0};
    if (srcWidth <= 0 || srcHeight <= 0 || box.width <= 0 || box.height <= 0) return fit;
    double scale = MIN(box.width / srcWidth, box.height / srcHeight);
    fit.width = srcWidth * scale;
    fit.height = srcHeight * scale;
    fit.x = box.x + (box.width - fit.width) / 2.0;
    fit.y = box.y + (box.height - fit.height) / 2.0;
    return fit;
}

MSLPScreen MSLPScreenLayout(double screenWidth, double screenHeight, NSInteger placeCount) {
    MSLPScreen screen = {0};
    if (screenWidth < 320 || screenHeight < 240) return screen;
    MSLPPage ref = MSLPPageLayout(kMSLPRefW, kMSLPRefH);
    double barH = StatusBarHeight(placeCount, screenHeight);
    screen.bar = (MSLPRect){0, screenHeight - barH, screenWidth, barH};
    double gridW = screenWidth - 2 * kScreenPad;
    MSLPRect headerProbe = {0, 0, gridW, kHeaderBand};
    MSLPRect headerFit = MSLPAspectFit(ref.header.width, ref.header.height, headerProbe);
    double headerH = headerFit.height;
    double aspect = ref.panels[0].width / ref.panels[0].height;
    double widthFitW = (gridW - 3 * kScreenGutter) / 4.0;
    double widthFitH = widthFitW / aspect;
    double heightBudget = (screen.bar.y - 2 * kScreenPad) - headerH - 2 * kScreenGutter;
    double heightFitH = heightBudget / 2.0;
    double heightFitW = heightFitH * aspect;
    double cellW = widthFitW;
    double cellH = widthFitH;
    if (heightFitH < widthFitH) {
        cellW = heightFitW;
        cellH = heightFitH;
    }
    if (cellW <= 40 || cellH <= 40) return screen;
    double blockW = cellW * 4 + kScreenGutter * 3;
    double blockH = headerH + kScreenGutter + cellH * 2 + kScreenGutter;
    double originX = kScreenPad + (gridW - blockW) / 2.0;
    double originY = (screen.bar.y - blockH) / 2.0;
    screen.header = (MSLPRect){
        kScreenPad + (gridW - headerFit.width) / 2.0,
        originY,
        headerFit.width,
        headerH,
    };
    double gridTop = originY + headerH + kScreenGutter;
    for (int i = 0; i < 8; i++) {
        int col = MSLPDisplayColumn(i);
        int row = MSLPDisplayRow(i);
        screen.cells[i] = (MSLPRect){
            originX + col * (cellW + kScreenGutter),
            gridTop + row * (cellH + kScreenGutter),
            cellW,
            cellH,
        };
    }
    screen.valid = YES;
    return screen;
}

MSLPRect MSLPSinglePanelFrame(double screenWidth, double screenHeight, NSInteger placeCount) {
    MSLPRect empty = {0};
    if (screenWidth < 320 || screenHeight < 240) return empty;
    double barH = StatusBarHeight(placeCount, screenHeight);
    MSLPRect box = {
        kScreenPad,
        kScreenPad,
        screenWidth - 2 * kScreenPad,
        screenHeight - barH - kScreenPad - kScreenGutter,
    };
    MSLPPage ref = MSLPPageLayout(kMSLPRefW, kMSLPRefH);
    return MSLPAspectFit(ref.panels[0].width, ref.panels[0].height, box);
}

NSDictionary *PressureTendency(NSData *json) {
    NSDictionary *root = JSONObject(json);
    NSDictionary *obs = [root[@"observations"] isKindOfClass:NSDictionary.class] ? root[@"observations"] : nil;
    NSArray *data = JSONArray(obs[@"data"]);
    if (!data.count) return nil;
    NSString *state = ObservationStateCode(obs);
    NSTimeZone *tz = TimeZoneForStateCode(state);
    if (!tz) return nil;
    NSDate *latestTime = nil;
    double latestPress = 0;
    BOOL haveLatest = NO;
    NSDate *bestTime = nil;
    double bestPress = 0;
    double bestDist = 1e9;
    for (NSDictionary *row in data) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSNumber *press = Num(row[@"press_msl"]);
        NSString *stamp = [row[@"local_date_time_full"] isKindOfClass:NSString.class] ? row[@"local_date_time_full"] : nil;
        NSDate *time = CivilTime(stamp, tz);
        if (!press || !time) continue;
        if (!haveLatest) {
            haveLatest = YES;
            latestTime = time;
            latestPress = press.doubleValue;
            continue;
        }
        double hours = [latestTime timeIntervalSinceDate:time] / 3600.0;
        if (hours < 2.0 || hours > 4.0) continue;
        double dist = fabs(hours - 3.0);
        if (dist < bestDist) {
            bestDist = dist;
            bestTime = time;
            bestPress = press.doubleValue;
        }
    }
    if (!haveLatest || !bestTime) return nil;
    double hours = [latestTime timeIntervalSinceDate:bestTime] / 3600.0;
    return @{@"delta": @(latestPress - bestPress), @"hours": @(hours)};
}

ChartFit FitChartBox(double pixelW, double pixelH, double maxPointW, double maxPointH, double backingScale) {
    ChartFit fit = {0, 0, 0, NO};
    if (pixelW <= 0 || pixelH <= 0 || maxPointW <= 0 || maxPointH <= 0) return fit;
    double scale = backingScale > 0 ? backingScale : 1;
    double nativeW = pixelW / scale;
    double nativeH = pixelH / scale;
    if (nativeW <= maxPointW + 0.01 && nativeH <= maxPointH + 0.01) {
        fit.pixelMultiple = 1;
        fit.integer = YES;
        fit.width = nativeW;
        fit.height = nativeH;
        return fit;
    }
    double factor = MIN(maxPointW / nativeW, maxPointH / nativeH);
    fit.width = nativeW * factor;
    fit.height = nativeH * factor;
    return fit;
}

NSString *FullscreenStatusLine(NSString *name, NSDictionary *obs) {
    NSString *place = name.length ? name : @"—";
    if (![obs isKindOfClass:NSDictionary.class])
        return [NSString stringWithFormat:@"%@ · — · — · —", place];
    NSString *temp = @"—";
    if ([obs[@"airTemp"] isKindOfClass:NSNumber.class])
        temp = [NSString stringWithFormat:@"%.0f°", round([obs[@"airTemp"] doubleValue])];
    NSString *wind = @"—";
    if ([obs[@"windDir"] isKindOfClass:NSString.class] && [obs[@"windDir"] length]) {
        id speed = obs[@"windKmh"] ?: @0;
        if ([obs[@"gustKmh"] integerValue] > 0)
            wind = [NSString stringWithFormat:@"%@ %@ (%@) km/h", obs[@"windDir"], speed, obs[@"gustKmh"]];
        else
            wind = [NSString stringWithFormat:@"%@ %@ km/h", obs[@"windDir"], speed];
    }
    NSString *pressure = @"—";
    if ([obs[@"pressMsl"] isKindOfClass:NSNumber.class]) {
        NSString *msl = [NSString stringWithFormat:@"%.1f hPa", [obs[@"pressMsl"] doubleValue]];
        if ([obs[@"pressDelta"] isKindOfClass:NSNumber.class])
            pressure = [NSString stringWithFormat:@"%@ (%+.1f)", msl, [obs[@"pressDelta"] doubleValue]];
        else
            pressure = [NSString stringWithFormat:@"%@ (—)", msl];
    }
    return [NSString stringWithFormat:@"%@ · %@ · %@ · %@", place, temp, wind, pressure];
}

NSString *ObservationStrip(NSString *name, NSDictionary *obs) {
    NSString *place = name.length ? name : @"—";
    if (![obs isKindOfClass:NSDictionary.class])
        return [NSString stringWithFormat:@"%@ · — · — · — · —", place];
    NSString *temp = @"—";
    if ([obs[@"airTemp"] isKindOfClass:NSNumber.class])
        temp = [NSString stringWithFormat:@"%.0f°", round([obs[@"airTemp"] doubleValue])];
    NSString *wind = @"—";
    if ([obs[@"windDir"] isKindOfClass:NSString.class] && [obs[@"windDir"] length]) {
        id speed = obs[@"windKmh"] ?: @0;
        if ([obs[@"gustKmh"] integerValue] > 0)
            wind = [NSString stringWithFormat:@"%@ %@ (%@) km/h", obs[@"windDir"], speed, obs[@"gustKmh"]];
        else
            wind = [NSString stringWithFormat:@"%@ %@ km/h", obs[@"windDir"], speed];
    }
    NSString *pressure = [obs[@"pressMsl"] isKindOfClass:NSNumber.class]
        ? [NSString stringWithFormat:@"%.1f hPa", [obs[@"pressMsl"] doubleValue]] : @"—";
    NSString *rain = ([obs[@"rainTrace"] isKindOfClass:NSString.class] && [obs[@"rainTrace"] length])
        ? [NSString stringWithFormat:@"%@ mm", obs[@"rainTrace"]] : @"—";
    return [NSString stringWithFormat:@"%@ · %@ · %@ · %@ · %@", place, temp, wind, pressure, rain];
}

NSString *IssuedCaption(NSDate *issued, NSTimeZone *tz, NSDate *now, BOOL offline) {
    NSString *text = issued
        ? [NSString stringWithFormat:@"Issued %@ (%@)", ClockText(issued, tz, now), AgeText(issued, now)]
        : @"Issued —";
    if (offline) text = [text stringByAppendingString:@" · offline"];
    return text;
}

BOOL GUIRequiresLaunchServicesRelaunch(NSString *runningBundleID, NSString *expectedBundleID) {
    if (!expectedBundleID.length) return NO;
    return ![runningBundleID isEqualToString:expectedBundleID];
}

NSString * const PanelSourceFourDayMSLP = @"bom.IDG00074";

NSString *TimeOfDayText(NSDate *date, NSTimeZone *tz) {
    if (!date) return @"—";
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = tz ?: NSTimeZone.localTimeZone;
    f.dateFormat = @"h:mm a";
    return [f stringFromDate:date].lowercaseString;
}

NSString *StationCatalogueProduct(NSString *state) {
    NSDictionary *ids = @{
        @"WA": @"IDW60801", @"NSW": @"IDN60801", @"VIC": @"IDV60801", @"QLD": @"IDQ60801",
        @"SA": @"IDS60801", @"TAS": @"IDT60801", @"NT": @"IDD60801", @"ACT": @"IDN60801",
    };
    return ids[state.uppercaseString];
}

NSDictionary *ParseLocation(NSData *json) {
    NSDictionary *root = JSONObject(json);
    NSDictionary *data = [root[@"data"] isKindOfClass:NSDictionary.class] ? root[@"data"] : root;
    if (![data isKindOfClass:NSDictionary.class]) return nil;
    NSString *hash = [data[@"geohash"] isKindOfClass:NSString.class] ? data[@"geohash"] : @"";
    NSNumber *lat = Num(data[@"latitude"]);
    NSNumber *lon = Num(data[@"longitude"]);
    if (hash.length < 6 || !lat || !lon) return nil;
    return @{
        @"name": [data[@"name"] isKindOfClass:NSString.class] ? data[@"name"] : @"",
        @"state": [data[@"state"] isKindOfClass:NSString.class] ? data[@"state"] : @"",
        @"geohash": hash,
        @"latitude": lat,
        @"longitude": lon,
        @"timezone": [data[@"timezone"] isKindOfClass:NSString.class] ? data[@"timezone"] : @"",
    };
}

NSArray<NSDictionary *> *ParseStationList(NSData *json) {
    NSArray *rows = JSONArray(JSONObject(json)[@"stations"]);
    if (!rows) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *s in rows) {
        if (![s isKindOfClass:NSDictionary.class]) continue;
        NSNumber *lat = Num(s[@"lat"]);
        NSNumber *lon = Num(s[@"lon"]);
        NSString *wmo = [s[@"wmo"] isKindOfClass:NSString.class] ? s[@"wmo"] : [s[@"wmo"] description];
        if (!lat || !lon || !wmo.length) continue;
        [out addObject:@{
            @"name": [s[@"name"] isKindOfClass:NSString.class] ? s[@"name"] : @"",
            @"wmo": wmo,
            @"lat": lat,
            @"lon": lon,
        }];
    }
    return out;
}

double HaversineKm(double lat1, double lon1, double lat2, double lon2) {
    double r = 6371.0;
    double p1 = lat1 * M_PI / 180.0, p2 = lat2 * M_PI / 180.0;
    double dp = (lat2 - lat1) * M_PI / 180.0, dl = (lon2 - lon1) * M_PI / 180.0;
    double a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2);
    return 2 * r * atan2(sqrt(a), sqrt(1 - a));
}

static NSInteger NameAffinity(NSString *station, NSString *place) {
    if (!place.length || !station.length) return 3;
    NSString *s = station.lowercaseString, *p = place.lowercaseString;
    if ([s isEqual:p]) return 0;
    if ([s hasPrefix:p]) return 1;
    if ([s containsString:p]) return 2;
    return 3;
}

static NSInteger StationPenalty(NSString *name) {
    NSString *s = name.lowercaseString;
    for (NSString *word in @[@"airport", @"water", @"jetty", @"harbour", @"harbor", @"buoy", @"point", @"beacon"]) {
        if ([s containsString:word]) return 1;
    }
    return 0;
}

NSDictionary *NearestPressureStation(NSArray<NSDictionary *> *stations, double latitude, double longitude, NSString *placeName) {
    NSMutableArray *reporting = [NSMutableArray array];
    for (NSDictionary *s in stations) {
        if ([s[@"msl"] boolValue]) [reporting addObject:s];
    }
    return NearestStation(reporting, latitude, longitude, placeName);
}

NSArray<NSDictionary *> *StationsByDistance(NSArray<NSDictionary *> *stations, double latitude, double longitude) {
    NSMutableArray *rows = [NSMutableArray array];
    for (NSDictionary *s in stations) {
        if (![s[@"lat"] isKindOfClass:NSNumber.class] || ![s[@"lon"] isKindOfClass:NSNumber.class]) continue;
        double km = HaversineKm(latitude, longitude, [s[@"lat"] doubleValue], [s[@"lon"] doubleValue]);
        [rows addObject:@{@"km": @(km), @"station": s}];
    }
    [rows sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        double d = [a[@"km"] doubleValue] - [b[@"km"] doubleValue];
        if (fabs(d) > 0.05) return d < 0 ? NSOrderedAscending : NSOrderedDescending;
        return [a[@"station"][@"name"] caseInsensitiveCompare:b[@"station"][@"name"]];
    }];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *row in rows) [out addObject:row[@"station"]];
    return out;
}

NSDictionary *ObservationWithPressure(NSDictionary *obs, NSDictionary *pressureObs) {
    if (![obs isKindOfClass:NSDictionary.class] || ![pressureObs isKindOfClass:NSDictionary.class]) return obs;
    if ([obs[@"pressMsl"] isKindOfClass:NSNumber.class]) return obs;
    if (![pressureObs[@"pressMsl"] isKindOfClass:NSNumber.class]) return obs;
    NSMutableDictionary *out = [obs mutableCopy];
    out[@"pressMsl"] = pressureObs[@"pressMsl"];
    if ([pressureObs[@"pressDelta"] isKindOfClass:NSNumber.class]) out[@"pressDelta"] = pressureObs[@"pressDelta"];
    if ([pressureObs[@"pressHours"] isKindOfClass:NSNumber.class]) out[@"pressHours"] = pressureObs[@"pressHours"];
    NSString *from = [pressureObs[@"name"] isKindOfClass:NSString.class] ? pressureObs[@"name"] : @"";
    NSString *own = [obs[@"name"] isKindOfClass:NSString.class] ? obs[@"name"] : @"";
    if (from.length && [from caseInsensitiveCompare:own] != NSOrderedSame) out[@"pressureStation"] = from;
    return out;
}

static BOOL WarningBoilerplateLine(NSString *line) {
    NSString *lower = line.lowercaseString;
    if ([lower containsString:@"australian government bureau of meteorology"]) return YES;
    if ([lower containsString:@"warning summary"]) return YES;
    if ([lower hasPrefix:@"please be aware"]) return YES;
    NSSet *states = [NSSet setWithObjects:@"western australia", @"new south wales", @"victoria", @"queensland",
        @"south australia", @"tasmania", @"northern territory", @"australian capital territory", nil];
    return [states containsObject:lower];
}

NSString *CleanWarningText(NSString *text) {
    if (![text isKindOfClass:NSString.class] || !text.length) return @"";
    NSRegularExpression *codes = [NSRegularExpression regularExpressionWithPattern:@"\\bID[A-Z]{1,2}\\d{4,6}\\b"
        options:0 error:nil];
    NSMutableString *stripped = [text mutableCopy];
    [codes replaceMatchesInString:stripped options:0 range:NSMakeRange(0, stripped.length) withTemplate:@""];
    NSMutableArray *lines = [NSMutableArray array];
    for (NSString *line in [stripped componentsSeparatedByString:@"\n"]) {
        NSString *trim = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (!trim.length || WarningBoilerplateLine(trim)) continue;
        [lines addObject:trim];
    }
    return [lines componentsJoinedByString:@"\n"];
}

NSDictionary *NearestStation(NSArray<NSDictionary *> *stations, double latitude, double longitude, NSString *placeName) {
    NSDictionary *best = nil;
    double bestKm = DBL_MAX;
    for (NSDictionary *s in stations) {
        if (![s[@"lat"] isKindOfClass:NSNumber.class] || ![s[@"lon"] isKindOfClass:NSNumber.class]) continue;
        double km = HaversineKm(latitude, longitude, [s[@"lat"] doubleValue], [s[@"lon"] doubleValue]);
        if (!best || km < bestKm - 0.05) {
            best = s;
            bestKm = km;
            continue;
        }
        if (fabs(km - bestKm) > 0.05) continue;
        NSInteger affinity = NameAffinity(s[@"name"], placeName) - NameAffinity(best[@"name"], placeName);
        NSInteger penalty = StationPenalty(s[@"name"]) - StationPenalty(best[@"name"]);
        NSComparisonResult alpha = [s[@"name"] caseInsensitiveCompare:best[@"name"]];
        if (affinity < 0 || (affinity == 0 && (penalty < 0 || (penalty == 0 && alpha == NSOrderedAscending)))) {
            best = s;
            bestKm = km;
        }
    }
    return best;
}

NSString *GeohashEncode(double latitude, double longitude, NSInteger precision) {
    if (precision < 1 || precision > 12) return nil;
    static NSString *alphabet = @"0123456789bcdefghjkmnpqrstuvwxyz";
    double latR[2] = {-90, 90}, lonR[2] = {-180, 180};
    NSMutableString *out = [NSMutableString string];
    BOOL even = YES;
    int bit = 0, ch = 0;
    while ((NSInteger)out.length < precision) {
        if (even) {
            double mid = (lonR[0] + lonR[1]) / 2;
            if (longitude >= mid) { ch = ch * 2 + 1; lonR[0] = mid; }
            else { ch = ch * 2; lonR[1] = mid; }
        } else {
            double mid = (latR[0] + latR[1]) / 2;
            if (latitude >= mid) { ch = ch * 2 + 1; latR[0] = mid; }
            else { ch = ch * 2; latR[1] = mid; }
        }
        even = !even;
        if (++bit == 5) {
            [out appendFormat:@"%C", [alphabet characterAtIndex:ch]];
            bit = 0;
            ch = 0;
        }
    }
    return out;
}

static double SunDeclination(double lambda) {
    return asin(sin(lambda) * sin(23.4397 * M_PI / 180.0));
}

NSDictionary *SunEvents(double latitude, double longitude, NSDate *instant, NSTimeZone *tz) {
    if (!instant) return nil;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: [NSTimeZone timeZoneWithName:@"UTC"];
    NSDateComponents *parts = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay fromDate:instant];
    // Local noon, so the Julian day is the civil date the user is looking at.
    parts.hour = 12;
    NSDate *noon = [cal dateFromComponents:parts];
    double J1970 = 2440588.0, J2000 = 2451545.0, J0 = 0.0009;
    double e = 23.4397 * M_PI / 180.0;
    double days = noon.timeIntervalSince1970 / 86400.0 - 0.5 + J1970 - J2000;
    double lw = -longitude * M_PI / 180.0;
    double phi = latitude * M_PI / 180.0;
    double n = round(days - J0 - lw / (2 * M_PI));
    double ds = J0 + lw / (2 * M_PI) + n;
    double M = (357.5291 + 0.98560028 * ds) * M_PI / 180.0;
    double C = (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M)) * M_PI / 180.0;
    double L = M + C + 102.9372 * M_PI / 180.0 + M_PI;
    double dec = SunDeclination(L);
    double Jnoon = J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
    double h0 = -0.833 * M_PI / 180.0;
    double cosW = (sin(h0) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec));
    if (cosW < -1 || cosW > 1) return nil;
    double w = acos(cosW);
    double a = J0 + (w + lw) / (2 * M_PI) + n;
    double Jset = J2000 + a + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
    double Jrise = Jnoon - (Jset - Jnoon);
    NSDate * (^fromJ)(double) = ^NSDate *(double J) {
        return [NSDate dateWithTimeIntervalSince1970:(J + 0.5 - J1970) * 86400.0];
    };
    (void)e;
    return @{@"sunrise": fromJ(Jrise), @"sunset": fromJ(Jset)};
}

NSArray<NSDictionary *> *HourlyStrip(NSArray<NSDictionary *> *hours, NSDate *sunrise, NSDate *sunset, NSInteger limit) {
    if (limit <= 0 || !hours.count) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *hour in hours) {
        if (![hour[@"time"] isKindOfClass:NSDate.class]) continue;
        NSMutableDictionary *slot = [hour mutableCopy];
        slot[@"kind"] = @"hour";
        [out addObject:slot];
        if ((NSInteger)out.count == limit) break;
    }
    if (!out.count) return @[];
    NSDate *start = out.firstObject[@"time"];
    NSDate *end = out.lastObject[@"time"];
    void (^insert)(NSDate *, NSString *) = ^(NSDate *time, NSString *kind) {
        if (!time) return;
        if ([time compare:start] == NSOrderedAscending) return;
        if ([time timeIntervalSinceDate:end] > 1800) return;
        [out addObject:@{@"kind": kind, @"time": time}];
    };
    insert(sunrise, @"sunrise");
    insert(sunset, @"sunset");
    [out sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"time"] compare:b[@"time"]];
    }];
    return out;
}

static NSDictionary *Place(NSString *name, NSString *state, NSString *hash, double lat, double lon,
                           NSString *tz, NSString *station, NSString *wmo, NSString *product) {
    return @{
        @"name": name, @"state": state, @"geohash": hash,
        @"latitude": @(lat), @"longitude": @(lon), @"timezone": tz,
        @"stationName": station, @"stationWMO": wmo, @"stationProduct": product,
    };
}

NSArray<NSDictionary *> *DefaultLocations(void) {
    return @[
        // Public coastal fallback at Cottesloe; personal locations belong in preferences.
        Place(@"Perth coast", @"WA", @"qd63czw", -31.994, 115.75,
              @"Australia/Perth", @"Swanbourne", @"94614", @"IDW60901"),
        Place(@"Sydney", @"NSW", @"r3gx2sp", -33.85917663574219, 151.2041473388672,
              @"Australia/Sydney", @"Sydney - Observatory Hill", @"94768", @"IDN60901"),
    ];
}

static NSArray *LocationFields(void) {
    return @[@"name", @"state", @"geohash", @"latitude", @"longitude", @"timezone", @"stationName", @"stationWMO", @"stationProduct"];
}

NSString *ArchiveLocations(NSArray *locations) {
    if (![NSJSONSerialization isValidJSONObject:locations ?: @[]]) return @"[]";
    NSData *data = [NSJSONSerialization dataWithJSONObject:locations ?: @[] options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"[]";
}

NSArray<NSDictionary *> *UnarchiveLocations(NSString *json) {
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    id obj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![obj isKindOfClass:NSArray.class] || ![obj count]) return DefaultLocations();
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *item in obj) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *hash = [item[@"geohash"] isKindOfClass:NSString.class] ? item[@"geohash"] : @"";
        if (hash.length < 6) continue;
        NSMutableDictionary *place = [NSMutableDictionary dictionary];
        for (NSString *key in LocationFields()) if (item[key]) place[key] = item[key];
        place[@"geohash"] = hash;
        if (!place[@"name"]) place[@"name"] = hash;
        if (!place[@"state"]) place[@"state"] = @"";
        [out addObject:place];
    }
    return out.count ? out : DefaultLocations();
}

NSArray *LocationListByAdding(NSArray *locations, NSDictionary *place) {
    NSString *hash = [place[@"geohash"] isKindOfClass:NSString.class] ? place[@"geohash"] : @"";
    if (hash.length < 6) return locations ?: @[];
    for (NSDictionary *existing in locations) {
        if ([existing[@"geohash"] isEqual:hash]) return locations;
    }
    return [(locations ?: @[]) arrayByAddingObject:place];
}

NSArray *LocationListByRemovingIndex(NSArray *locations, NSUInteger index) {
    if (locations.count <= 1 || index >= locations.count) return locations ?: @[];
    NSMutableArray *out = [locations mutableCopy];
    [out removeObjectAtIndex:index];
    return out;
}

NSArray *LocationListByMoving(NSArray *locations, NSUInteger fromIndex, NSUInteger toIndex) {
    if (!locations.count || fromIndex >= locations.count || toIndex >= locations.count || fromIndex == toIndex)
        return locations ?: @[];
    NSMutableArray *out = [locations mutableCopy];
    id item = out[fromIndex];
    [out removeObjectAtIndex:fromIndex];
    [out insertObject:item atIndex:toIndex];
    return out;
}

NSString *ForecastPageURL(NSString *name, NSString *state) {
    NSString *query = [NSString stringWithFormat:@"%@ %@", name ?: @"", state ?: @""];
    query = [query stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    NSString *enc = [query stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLQueryAllowedCharacterSet];
    return [@"https://www.bom.gov.au/search?query=" stringByAppendingString:enc ?: @""];
}

NSString *SymbolForIconDescriptor(NSString *descriptor, BOOL night) {
    NSString *d = descriptor.lowercaseString ?: @"";
    if ([d containsString:@"wind"]) return @"wind";
    if ([d containsString:@"storm"] || [d containsString:@"thunder"] || [d containsString:@"lightning"])
        return @"cloud.bolt.rain";
    if ([d containsString:@"snow"] || [d containsString:@"frost"]) return @"cloud.snow";
    if ([d containsString:@"fog"] || [d containsString:@"haze"]) return @"cloud.fog";
    if ([d containsString:@"shower"] || [d containsString:@"rain"] || [d containsString:@"drizzle"])
        return night ? @"cloud.moon.rain" : @"cloud.rain";
    if ([d containsString:@"cloud"] || [d isEqual:@"mostly_sunny"] || [d isEqual:@"partly_cloudy"])
        return night ? @"cloud.moon" : @"cloud.sun";
    if ([d containsString:@"sunny"] || [d isEqual:@"clear"] || [d isEqual:@"fine"])
        return night ? @"moon.stars" : @"sun.max";
    if ([d containsString:@"dust"] || [d containsString:@"smoke"]) return @"sun.dust";
    return night ? @"moon.stars" : @"cloud.sun";
}

BOOL LocationWarningsActive(NSArray *warningGroups) {
    for (id group in warningGroups) {
        if ([group isKindOfClass:NSArray.class] && [group count] > 0) return YES;
    }
    return NO;
}

NSString * const ChartNoEarlierIssue = @"no earlier issue for this time";

static NSTimeZone *ChartZone(void) {
    return [NSTimeZone timeZoneForSecondsFromGMT:10 * 3600];
}

static BOOL PDFSpace(unichar c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static NSArray<NSData *> *PDFInflatedStreams(NSData *pdf) {
    if (!pdf.length) return @[];
    const uint8_t *bytes = pdf.bytes;
    NSUInteger n = pdf.length, i = 0;
    NSMutableArray *out = [NSMutableArray array];
    while (i + 10 < n) {
        const void *found = memmem(bytes + i, n - i, "stream", 6);
        if (!found) break;
        NSUInteger j = (const uint8_t *)found - bytes + 6;
        if (j + 1 < n && bytes[j] == '\r' && bytes[j + 1] == '\n') j += 2;
        else if (j < n && bytes[j] == '\n') j += 1;
        const void *end = memmem(bytes + j, n - j, "endstream", 9);
        if (!end) break;
        NSUInteger k = (const uint8_t *)end - bytes;
        NSData *raw = [NSData dataWithBytes:bytes + j length:k - j];
        if (raw.length >= 2 && ((const uint8_t *)raw.bytes)[raw.length - 1] == '\n') {
            NSUInteger trim = 1;
            if (raw.length >= 2 && ((const uint8_t *)raw.bytes)[raw.length - 2] == '\r') trim = 2;
            raw = [raw subdataWithRange:NSMakeRange(0, raw.length - trim)];
        }
        z_stream strm = {0};
        strm.next_in = (Bytef *)raw.bytes;
        strm.avail_in = (uInt)MIN(raw.length, (NSUInteger)UINT_MAX);
        NSData *dec = nil;
        // A cached chart must not be able to expand without a ceiling.
        static const NSUInteger kPDFInflateLimit = 64u * 1024u * 1024u;
        if (raw.length && raw.length <= UINT_MAX && inflateInit(&strm) == Z_OK) {
            NSUInteger start = 65536;
            if (raw.length < 16384) start = raw.length * 4 + 64;
            if (start > kPDFInflateLimit) start = kPDFInflateLimit;
            NSMutableData *buf = [NSMutableData dataWithLength:start];
            int rc = Z_OK;
            while (rc == Z_OK) {
                if (strm.total_out >= kPDFInflateLimit) { rc = Z_BUF_ERROR; break; }
                if (strm.total_out >= buf.length) {
                    NSUInteger extra = MIN((NSUInteger)65536 + buf.length, kPDFInflateLimit - buf.length);
                    if (!extra) { rc = Z_BUF_ERROR; break; }
                    [buf increaseLengthBy:extra];
                }
                strm.next_out = (Bytef *)buf.mutableBytes + strm.total_out;
                strm.avail_out = (uInt)MIN(buf.length - strm.total_out, (NSUInteger)UINT_MAX);
                rc = inflate(&strm, Z_NO_FLUSH);
            }
            inflateEnd(&strm);
            if (rc == Z_STREAM_END && strm.total_out <= kPDFInflateLimit) {
                buf.length = strm.total_out;
                dec = buf;
            }
        }
        if (dec.length) [out addObject:dec];
        i = k + 9;
    }
    return out;
}

static NSArray<NSString *> *PDFTextRuns(NSString *stream) {
    if (!stream.length) return @[];
    NSMutableArray *runs = [NSMutableArray array];
    NSMutableString *run = nil;
    NSUInteger i = 0, n = stream.length;
    while (i < n) {
        unichar c = [stream characterAtIndex:i];
        if (c == '(') {
            i++;
            NSMutableString *s = [NSMutableString string];
            int depth = 1;
            while (i < n && depth) {
                unichar ch = [stream characterAtIndex:i++];
                if (ch == '\\' && i < n) {
                    unichar e = [stream characterAtIndex:i++];
                    if (e == 'n') [s appendString:@"\n"];
                    else if (e == 'r') [s appendString:@"\r"];
                    else if (e == 't') [s appendString:@"\t"];
                    else if (e == '(' || e == ')' || e == '\\') [s appendFormat:@"%C", e];
                    else if (e >= '0' && e <= '7') {
                        int v = e - '0', k = 0;
                        while (k < 2 && i < n) {
                            unichar o = [stream characterAtIndex:i];
                            if (o < '0' || o > '7') break;
                            v = (v << 3) + (o - '0');
                            i++;
                            k++;
                        }
                        [s appendFormat:@"%C", (unichar)(v & 0xFF)];
                    } else [s appendFormat:@"%C", e];
                } else if (ch == '(') {
                    depth++;
                    [s appendString:@"("];
                } else if (ch == ')') {
                    depth--;
                    if (depth) [s appendString:@")"];
                } else [s appendFormat:@"%C", ch];
            }
            NSUInteger j = i;
            while (j < n && PDFSpace([stream characterAtIndex:j])) j++;
            BOOL tj = j + 1 < n && [stream characterAtIndex:j] == 'T' && [stream characterAtIndex:j + 1] == 'j'
                && (j + 2 >= n || !isalnum((unsigned char)[stream characterAtIndex:j + 2]));
            if (tj && run) [run appendString:s];
            if (tj) i = j + 2;
            continue;
        }
        BOOL boundary = i == 0 || PDFSpace([stream characterAtIndex:i - 1]);
        if (boundary && i + 1 < n) {
            unichar b = [stream characterAtIndex:i + 1];
            BOOL end = i + 2 >= n || PDFSpace([stream characterAtIndex:i + 2]);
            if (end && c == 'B' && b == 'T') {
                run = [NSMutableString string];
                i += 2;
                continue;
            }
            if (end && c == 'E' && b == 'T') {
                if (run.length) [runs addObject:[run copy]];
                run = nil;
                i += 2;
                continue;
            }
        }
        i++;
    }
    if (run.length) [runs addObject:[run copy]];
    return runs;
}

static NSString *PDFPlainText(NSData *pdf) {
    NSMutableString *all = [NSMutableString string];
    for (NSData *data in PDFInflatedStreams(pdf)) {
        NSString *stream = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
        for (NSString *run in PDFTextRuns(stream)) {
            if (!run.length) continue;
            if (all.length) [all appendString:@"\n"];
            [all appendString:run];
        }
    }
    return all;
}

static NSDate *DateInZone(NSInteger year, NSInteger month, NSInteger day, NSInteger hour, NSInteger minute, NSTimeZone *tz) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: ChartZone();
    NSDateComponents *c = [NSDateComponents new];
    c.year = year;
    c.month = month;
    c.day = day;
    c.hour = hour;
    c.minute = minute;
    return [cal dateFromComponents:c];
}

static NSInteger MonthIndex(NSString *name) {
    NSArray *months = @[@"jan", @"feb", @"mar", @"apr", @"may", @"jun", @"jul", @"aug", @"sep", @"oct", @"nov", @"dec"];
    NSString *key = name.lowercaseString ?: @"";
    if (key.length > 3) key = [key substringToIndex:3];
    NSUInteger idx = [months indexOfObject:key];
    return idx == NSNotFound ? 0 : (NSInteger)idx + 1;
}

static NSString *Clock12(NSInteger hour, NSInteger minute) {
    NSString *suffix = hour >= 12 ? @"pm" : @"am";
    NSInteger h = hour % 12;
    if (h == 0) h = 12;
    if (minute == 0) return [NSString stringWithFormat:@"%ld%@", (long)h, suffix];
    return [NSString stringWithFormat:@"%ld:%02ld%@", (long)h, (long)minute, suffix];
}

NSDate *AnalysisValidTime(NSData *pdf) {
    NSString *text = PDFPlainText(pdf);
    if (!text.length) return nil;
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"Valid:\\s*([0-9]{4})\\s+UTC\\s+([0-9]{1,2})\\s+([A-Za-z]+)\\.?\\s+([0-9]{4})"
        options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!m || m.numberOfRanges < 5) return nil;
    NSInteger hour = [[text substringWithRange:[m rangeAtIndex:1]] integerValue];
    NSInteger day = [[text substringWithRange:[m rangeAtIndex:2]] integerValue];
    NSInteger month = MonthIndex([text substringWithRange:[m rangeAtIndex:3]]);
    NSInteger year = [[text substringWithRange:[m rangeAtIndex:4]] integerValue];
    NSInteger hh = hour / 100;
    NSInteger mm = hour % 100;
    if (!month || hh > 23 || mm > 59) return nil;
    return DateInZone(year, month, day, hh, mm, [NSTimeZone timeZoneForSecondsFromGMT:0]);
}

NSString *AnalysisLocalValidText(NSData *pdf) {
    NSString *text = PDFPlainText(pdf);
    if (!text.length) return nil;
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"([0-9]{1,2}(?:am|pm))\\s+AEST\\s+([0-9]{1,2})/([A-Za-z]{3})\\./([0-9]{4})"
        options:NSRegularExpressionCaseInsensitive error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!m || m.numberOfRanges < 4) return nil;
    NSString *clock = [text substringWithRange:[m rangeAtIndex:1]].lowercaseString;
    NSString *day = [text substringWithRange:[m rangeAtIndex:2]];
    NSString *month = [text substringWithRange:[m rangeAtIndex:3]];
    if (month.length) {
        month = [[month substringToIndex:1].uppercaseString stringByAppendingString:[month substringFromIndex:1].lowercaseString];
    }
    return [NSString stringWithFormat:@"%@ AEST %@ %@", clock, day, month];
}

NSString * const UndatedPanelLabel = @"Undated";

NSArray<NSDate *> *BureauPanelTimes(NSArray *parsed, BOOL documentLoaded, BOOL *undated) {
    if (undated) *undated = NO;
    NSMutableArray *times = [NSMutableArray array];
    for (id item in parsed) if ([item isKindOfClass:NSDate.class]) [times addObject:item];
    if (times.count) return times;
    if (documentLoaded && undated) *undated = YES;
    return @[];
}

NSArray<NSDate *> *PrognosisValidTimes(NSData *pdf) {
    NSString *text = PDFPlainText(pdf);
    if (!text.length) return @[];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"([0-9]{1,2})(am|pm)\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+"
        @"(January|February|March|April|May|June|July|August|September|October|November|December)\\s+"
        @"([0-9]{1,2}),\\s+([0-9]{4})"
        options:NSRegularExpressionCaseInsensitive error:nil];
    NSMutableDictionary<NSNumber *, NSDate *> *unique = [NSMutableDictionary dictionary];
    for (NSTextCheckingResult *m in [re matchesInString:text options:0 range:NSMakeRange(0, text.length)]) {
        if (m.numberOfRanges < 7) continue;
        NSInteger hour = [[text substringWithRange:[m rangeAtIndex:1]] integerValue];
        NSString *ampm = [text substringWithRange:[m rangeAtIndex:2]].lowercaseString;
        NSInteger day = [[text substringWithRange:[m rangeAtIndex:5]] integerValue];
        NSInteger month = MonthIndex([text substringWithRange:[m rangeAtIndex:4]]);
        NSInteger year = [[text substringWithRange:[m rangeAtIndex:6]] integerValue];
        if ([ampm isEqual:@"pm"] && hour < 12) hour += 12;
        if ([ampm isEqual:@"am"] && hour == 12) hour = 0;
        if (!month || hour > 23) continue;
        NSDate *when = DateInZone(year, month, day, hour, 0, ChartZone());
        if (when) unique[@(when.timeIntervalSince1970)] = when;
    }
    return [unique.allValues sortedArrayUsingSelector:@selector(compare:)];
}

NSArray<NSDate *> *ChartSequenceTimes(NSDate *analysis, NSArray<NSDate *> *prognosis) {
    NSMutableArray *out = [NSMutableArray array];
    if (analysis) [out addObject:analysis];
    for (id item in prognosis) {
        if ([item isKindOfClass:NSDate.class]) [out addObject:item];
    }
    return out;
}

ChartPair OpeningChartPair(NSArray<NSDate *> *times, NSDate *now) {
    ChartPair pair = {0, 1, NO};
    NSUInteger n = times.count;
    if (n < 2) return pair;
    pair.valid = YES;
    pair.left = 0;
    pair.right = 1;
    if (!now) return pair;
    for (NSUInteger i = 1; i < n; i++) {
        id item = times[i];
        if (![item isKindOfClass:NSDate.class]) continue;
        if ([(NSDate *)item compare:now] == NSOrderedDescending) {
            pair.right = (NSInteger)i;
            break;
        }
        pair.right = (NSInteger)i;
    }
    if (pair.right <= pair.left) pair.right = MIN((NSInteger)n - 1, pair.left + 1);
    return pair;
}

ChartPair StepChartPair(ChartPair pair, NSInteger delta, NSInteger count) {
    if (!pair.valid || count < 2 || delta == 0) return pair;
    NSInteger left = pair.left + (delta > 0 ? 1 : -1);
    if (left < 0) left = 0;
    if (left > count - 2) left = count - 2;
    return (ChartPair){left, left + 1, YES};
}

NSInteger PreviousIssueIndex(NSArray<NSDate *> *previousTimes, NSDate *valid) {
    if (!valid) return -1;
    for (NSUInteger i = 0; i < previousTimes.count; i++) {
        id item = previousTimes[i];
        if (![item isKindOfClass:NSDate.class]) continue;
        if (fabs([(NSDate *)item timeIntervalSinceDate:valid]) < 1.0) return (NSInteger)i;
    }
    return -1;
}

BOOL IssueShouldArchive(NSDate *stored, NSDate *incoming) {
    if (!stored || !incoming) return NO;
    return fabs([stored timeIntervalSinceDate:incoming]) > 1.0;
}

NSString *NowTitle(NSString *localText, NSDate *valid) {
    if (localText.length) return [@"Now · " stringByAppendingString:localText];
    if (!valid) return @"Now";
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = ChartZone();
    NSDateComponents *c = [cal components:NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitDay | NSCalendarUnitMonth fromDate:valid];
    NSDateFormatter *month = [NSDateFormatter new];
    month.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    month.timeZone = ChartZone();
    month.dateFormat = @"MMM";
    return [NSString stringWithFormat:@"Now · %@ AEST %ld %@", Clock12(c.hour, c.minute), (long)c.day, [month stringFromDate:valid]];
}

NSString *ForecastTitle(NSDate *valid) {
    if (!valid) return @"Forecast";
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = ChartZone();
    NSDateComponents *c = [cal components:NSCalendarUnitHour | NSCalendarUnitMinute fromDate:valid];
    return [NSString stringWithFormat:@"%@ EST %@", Clock12(c.hour, c.minute), ChartDayLabel(valid)];
}

NSString *ChartDayLabel(NSDate *time) {
    if (!time) return @"";
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = ChartZone();
    f.dateFormat = @"EEE";
    return [f stringFromDate:time] ?: @"";
}

NSString *IssueCompareTitle(NSDate *issue, NSDate *previous, NSTimeZone *tz) {
    if (!issue || !previous) return nil;
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = tz ?: ChartZone();
    f.dateFormat = @"d MMM HH:mm";
    return [NSString stringWithFormat:@"Issue %@ vs previous %@", [f stringFromDate:issue], [f stringFromDate:previous]];
}

SequenceScreen SequenceScreenLayout(double screenWidth, double screenHeight, NSInteger placeCount) {
    SequenceScreen screen = {0};
    if (screenWidth < 640 || screenHeight < 480) return screen;
    double barH = StatusBarHeight(placeCount, screenHeight);
    screen.bar = (MSLPRect){0, screenHeight - barH, screenWidth, barH};
    double gridW = screenWidth - 2 * kScreenPad;
    double gridH = screen.bar.y - 2 * kScreenPad;
    double cellW = (gridW - 2 * kScreenGutter) / 3.0;
    double cellH = (gridH - 2 * kScreenGutter) / 3.0;
    if (cellW < 80 || cellH < 60) return screen;
    for (int i = 0; i < 9; i++) {
        int col = i % 3;
        int row = i / 3;
        screen.cells[i] = (MSLPRect){
            kScreenPad + col * (cellW + kScreenGutter),
            kScreenPad + row * (cellH + kScreenGutter),
            cellW,
            cellH,
        };
    }
    screen.valid = YES;
    return screen;
}

MSLPRect SequenceSingleFrame(double screenWidth, double screenHeight, NSInteger placeCount,
    double srcWidth, double srcHeight) {
    MSLPRect empty = {0};
    if (screenWidth < 320 || screenHeight < 240 || srcWidth <= 0 || srcHeight <= 0) return empty;
    double barH = StatusBarHeight(placeCount, screenHeight);
    MSLPRect box = {
        kScreenPad,
        kScreenPad,
        screenWidth - 2 * kScreenPad,
        screenHeight - barH - kScreenPad - kScreenGutter,
    };
    return MSLPAspectFit(srcWidth, srcHeight, box);
}

typedef struct { double x, y; } V2;

static double VDist(V2 a, V2 b) {
    double dx = a.x - b.x, dy = a.y - b.y;
    return hypot(dx, dy);
}

static int CompareDouble(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static double MedianSorted(double *v, int n) {
    if (n <= 0) return 0;
    qsort(v, (size_t)n, sizeof(double), CompareDouble);
    if (n % 2) return v[n / 2];
    return 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

#define kGeoPolyCap 40
#define kGeoPointCap 64

typedef struct {
    V2 pts[kGeoPointCap];
    int n;
} GeoPoly;

static BOOL ReadPDFNumber(NSString *s, NSUInteger *i, double *out) {
    NSUInteger n = s.length, p = *i;
    if (p >= n) return NO;
    unichar c = [s characterAtIndex:p];
    if (!(c == '+' || c == '-' || c == '.' || (c >= '0' && c <= '9'))) return NO;
    NSUInteger start = p;
    if (c == '+' || c == '-') p++;
    BOOL dot = NO, digit = NO;
    while (p < n) {
        unichar d = [s characterAtIndex:p];
        if (d >= '0' && d <= '9') { digit = YES; p++; }
        else if (d == '.' && !dot) { dot = YES; p++; }
        else break;
    }
    if (!digit || p == start) return NO;
    *out = [[s substringWithRange:NSMakeRange(start, p - start)] doubleValue];
    *i = p;
    return YES;
}

static void EmitPoly(GeoPoly *polys, int *count, const V2 *pts, int n) {
    if (n < 2 || *count >= kGeoPolyCap) return;
    GeoPoly *poly = &polys[*count];
    poly->n = MIN(n, kGeoPointCap);
    for (int i = 0; i < poly->n; i++) poly->pts[i] = pts[i];
    (*count)++;
}

static int GrayPolylines(NSString *stream, GeoPoly *polys) {
    int count = 0;
    NSRegularExpression *mark = [NSRegularExpression regularExpressionWithPattern:
        @"0\\.647\\s+0\\.647\\s+0\\.647\\s+RG" options:0 error:nil];
    NSArray *marks = [mark matchesInString:stream options:0 range:NSMakeRange(0, stream.length)];
    for (NSUInteger m = 0; m < marks.count; m++) {
        NSUInteger start = NSMaxRange(((NSTextCheckingResult *)marks[m]).range);
        NSUInteger end = (m + 1 < marks.count) ? ((NSTextCheckingResult *)marks[m + 1]).range.location : stream.length;
        if (end <= start) continue;
        NSString *chunk = [stream substringWithRange:NSMakeRange(start, end - start)];
        V2 cur[kGeoPointCap];
        int cn = 0;
        double pair[2];
        int have = 0;
        NSUInteger i = 0, n = chunk.length;
        while (i < n) {
            unichar c = [chunk characterAtIndex:i];
            if (PDFSpace(c)) { i++; continue; }
            if (c == '[') {
                while (i < n && [chunk characterAtIndex:i] != ']') i++;
                if (i < n) i++;
                have = 0;
                continue;
            }
            double num = 0;
            if (ReadPDFNumber(chunk, &i, &num)) {
                if (have < 2) pair[have++] = num;
                else {
                    pair[0] = pair[1];
                    pair[1] = num;
                }
                continue;
            }
            NSUInteger op = i;
            while (i < n) {
                unichar d = [chunk characterAtIndex:i];
                if ((d >= 'A' && d <= 'Z') || (d >= 'a' && d <= 'z') || d == '*') i++;
                else break;
            }
            if (i == op) { i++; continue; }
            NSString *name = [chunk substringWithRange:NSMakeRange(op, i - op)];
            if ([name isEqual:@"m"] && have >= 2) {
                if (cn >= 2) EmitPoly(polys, &count, cur, cn);
                cn = 1;
                cur[0] = (V2){pair[0], pair[1]};
            } else if ([name isEqual:@"l"] && have >= 2 && cn > 0 && cn < kGeoPointCap) {
                cur[cn++] = (V2){pair[0], pair[1]};
            } else if (([name isEqual:@"S"] || [name isEqual:@"s"]) && cn >= 2) {
                EmitPoly(polys, &count, cur, cn);
                cn = 0;
            }
            have = 0;
        }
        if (cn >= 2) EmitPoly(polys, &count, cur, cn);
    }
    return count;
}

static BOOL CrossLines(V2 a, V2 b, V2 c, V2 d, V2 *hit) {
    double den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (fabs(den) < 1e-8) return NO;
    double t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
    hit->x = a.x + t * (b.x - a.x);
    hit->y = a.y + t * (b.y - a.y);
    return YES;
}

static double NorthAngle(V2 pole, V2 a, V2 b) {
    V2 far = VDist(pole, a) > VDist(pole, b) ? a : b;
    return atan2(far.x - pole.x, -(far.y - pole.y));
}

static BOOL GraticuleValue(NSString *text, double *value, BOOL *latitude) {
    if ([text isEqual:@"180"]) { *value = 180; *latitude = NO; return YES; }
    if (text.length < 2) return NO;
    unichar tail = [text characterAtIndex:text.length - 1];
    if (tail != 'E' && tail != 'e' && tail != 'S' && tail != 's') return NO;
    NSString *num = [text substringToIndex:text.length - 1];
    NSCharacterSet *bad = [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
    if (!num.length || [num rangeOfCharacterFromSet:bad].location != NSNotFound) return NO;
    double v = num.doubleValue;
    if (tail == 'S' || tail == 's') {
        if (v <= 0 || v >= 90) return NO;
        *value = -v;
        *latitude = YES;
        return YES;
    }
    if (v < 0 || v > 180) return NO;
    *value = v;
    *latitude = NO;
    return YES;
}

static BOOL ChartScale(NSArray<NSData *> *streams, double *a, double *d, double *e, double *f) {
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"([0-9]+\\.[0-9]+)\\s+0\\s+0\\s+(-[0-9]+\\.[0-9]+)\\s+([-0-9.]+)\\s+([-0-9.]+)\\s+cm"
        options:0 error:nil];
    for (NSData *data in streams) {
        NSString *text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
        if (!text.length) continue;
        for (NSTextCheckingResult *m in [re matchesInString:text options:0 range:NSMakeRange(0, text.length)]) {
            if (m.numberOfRanges < 5) continue;
            double aa = [[text substringWithRange:[m rangeAtIndex:1]] doubleValue];
            double dd = [[text substringWithRange:[m rangeAtIndex:2]] doubleValue];
            if (aa > 2.0 && aa < 4.0 && dd < -2.0 && dd > -4.0) {
                *a = aa;
                *d = dd;
                *e = [[text substringWithRange:[m rangeAtIndex:3]] doubleValue];
                *f = [[text substringWithRange:[m rangeAtIndex:4]] doubleValue];
                return YES;
            }
        }
    }
    return NO;
}

BOOL AnalysisProject(AnalysisGeo geo, double latitude, double longitude, double *x, double *y) {
    if (!geo.valid || !x || !y) return NO;
    double phi = latitude * M_PI / 180.0;
    double t = tan(M_PI_4 + phi / 2.0);
    if (!(t > 0)) return NO;
    double rho = geo.k * pow(t, geo.n);
    double th = geo.n * (longitude - geo.lon0) * M_PI / 180.0;
    double xm = geo.poleX + rho * sin(th);
    double ym = geo.poleY - rho * cos(th);
    *x = geo.a * xm + geo.e;
    *y = geo.d * ym + geo.f;
    return isfinite(*x) && isfinite(*y);
}

AnalysisGeo AnalysisGeoreference(NSData *pdf) {
    AnalysisGeo geo = {0};
    NSArray<NSData *> *streams = PDFInflatedStreams(pdf);
    double a = 0, d = 0, e = 0, f = 0;
    if (!ChartScale(streams, &a, &d, &e, &f)) return geo;
    NSString *chart = nil;
    NSUInteger marks = 0;
    NSRegularExpression *mark = [NSRegularExpression regularExpressionWithPattern:
        @"0\\.647\\s+0\\.647\\s+0\\.647\\s+RG" options:0 error:nil];
    for (NSData *data in streams) {
        NSString *text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
        NSUInteger n = text.length ? [mark numberOfMatchesInString:text options:0 range:NSMakeRange(0, text.length)] : 0;
        if (n > marks) { marks = n; chart = text; }
    }
    if (!chart || marks < 8) return geo;

    GeoPoly *polys = calloc((size_t)kGeoPolyCap, sizeof(GeoPoly));
    if (!polys) return geo;
    int npoly = GrayPolylines(chart, polys);

    V2 hits[512];
    int nh = 0;
    for (int i = 0; i < npoly; i++) {
        if (polys[i].n != 2) continue;
        if (VDist(polys[i].pts[0], polys[i].pts[1]) < 20) continue;
        for (int j = i + 1; j < npoly; j++) {
            if (polys[j].n != 2 || VDist(polys[j].pts[0], polys[j].pts[1]) < 20) continue;
            V2 hit;
            if (!CrossLines(polys[i].pts[0], polys[i].pts[1], polys[j].pts[0], polys[j].pts[1], &hit)) continue;
            if (hit.x < 40 || hit.x > 180 || hit.y < 200 || hit.y > 800) continue;
            if (nh < 512) hits[nh++] = hit;
        }
    }
    if (nh < 6) { free(polys); return geo; }
    double xs[512], ys[512];
    for (int i = 0; i < nh; i++) { xs[i] = hits[i].x; ys[i] = hits[i].y; }
    V2 pole = {MedianSorted(xs, nh), MedianSorted(ys, nh)};

    typedef struct { double angle, lon; } Meridian;
    Meridian mers[kGeoPolyCap];
    int nm = 0;
    typedef struct { double radius, span; int n; } Parallel;
    Parallel pars[kGeoPolyCap];
    int np = 0;
    for (int i = 0; i < npoly; i++) {
        if (polys[i].n == 2 && VDist(polys[i].pts[0], polys[i].pts[1]) >= 20) {
            if (nm < kGeoPolyCap) {
                mers[nm].angle = NorthAngle(pole, polys[i].pts[0], polys[i].pts[1]);
                mers[nm].lon = NAN;
                nm++;
            }
        } else if (polys[i].n >= 5) {
            double sum = 0, minX = 1e9, maxX = -1e9;
            for (int p = 0; p < polys[i].n; p++) {
                sum += VDist(pole, polys[i].pts[p]);
                if (polys[i].pts[p].x < minX) minX = polys[i].pts[p].x;
                if (polys[i].pts[p].x > maxX) maxX = polys[i].pts[p].x;
            }
            double radius = sum / polys[i].n;
            if (radius > 40 && radius < 900 && maxX - minX > 80 && np < kGeoPolyCap) {
                pars[np].radius = radius;
                pars[np].span = maxX - minX;
                pars[np].n = polys[i].n;
                np++;
            }
        }
    }
    free(polys);
    if (nm < 4 || np < 3) return geo;

    NSRegularExpression *tm = [NSRegularExpression regularExpressionWithPattern:
        @"([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+Tm"
        options:0 error:nil];
    typedef struct { double value, x, y, angle; BOOL latitude; } Label;
    Label labels[80];
    int nl = 0;
    for (NSTextCheckingResult *match in [tm matchesInString:chart options:0 range:NSMakeRange(0, chart.length)]) {
        if (nl >= 80 || match.numberOfRanges < 7) continue;
        NSUInteger from = NSMaxRange(match.range);
        if (from >= chart.length) continue;
        NSUInteger len = MIN((NSUInteger)280, chart.length - from);
        NSString *rest = [chart substringWithRange:NSMakeRange(from, len)];
        NSRange open = [rest rangeOfString:@"("];
        NSRange close = open.location == NSNotFound ? NSMakeRange(NSNotFound, 0) : [rest rangeOfString:@")" options:0
            range:NSMakeRange(open.location, rest.length - open.location)];
        if (open.location == NSNotFound || close.location == NSNotFound || close.location <= open.location + 1) continue;
        NSString *literal = [rest substringWithRange:NSMakeRange(open.location + 1, close.location - open.location - 1)];
        double value = 0;
        BOOL latitude = NO;
        if (!GraticuleValue(literal, &value, &latitude)) continue;
        double lx = [[chart substringWithRange:[match rangeAtIndex:5]] doubleValue];
        double ly = [[chart substringWithRange:[match rangeAtIndex:6]] doubleValue];
        labels[nl++] = (Label){value, lx, ly, atan2(lx - pole.x, -(ly - pole.y)), latitude};
    }

    for (int i = 0; i < nm; i++) {
        double best = 2.0 * M_PI / 180.0;
        double lon = NAN;
        for (int L = 0; L < nl; L++) {
            if (labels[L].latitude) continue;
            double diff = fabs(mers[i].angle - labels[L].angle);
            if (diff < best) { best = diff; lon = labels[L].value; }
        }
        mers[i].lon = lon;
    }
    int central = -1;
    double centralAbs = 1e9;
    for (int i = 0; i < nm; i++) {
        if (!isfinite(mers[i].lon)) continue;
        double absA = fabs(mers[i].angle);
        if (absA < centralAbs) { centralAbs = absA; central = i; }
    }
    if (central < 0) return geo;
    double lon0 = mers[central].lon;
    double samples[kGeoPolyCap];
    int ns = 0;
    for (int i = 0; i < nm; i++) {
        if (!isfinite(mers[i].lon) || fabs(mers[i].lon - lon0) < 0.5) continue;
        double n = mers[i].angle / ((mers[i].lon - lon0) * M_PI / 180.0);
        if (n > 0.35 && n < 0.7 && ns < kGeoPolyCap) samples[ns++] = n;
    }
    if (ns < 3) return geo;
    double cone = MedianSorted(samples, ns);

    int usedP[kGeoPolyCap] = {0};
    int usedL[80] = {0};
    double radii[16], lats[16];
    int nfit = 0;
    while (nfit < 16) {
        int bestP = -1, bestL = -1;
        double best = 25;
        for (int L = 0; L < nl; L++) {
            if (usedL[L] || !labels[L].latitude) continue;
            double lr = hypot(labels[L].x - pole.x, labels[L].y - pole.y);
            for (int p = 0; p < np; p++) {
                if (usedP[p]) continue;
                double diff = fabs(pars[p].radius - lr);
                if (diff < best) { best = diff; bestP = p; bestL = L; }
            }
        }
        if (bestP < 0) break;
        usedP[bestP] = 1;
        usedL[bestL] = 1;
        radii[nfit] = pars[bestP].radius;
        lats[nfit] = labels[bestL].value;
        nfit++;
    }
    if (nfit < 3) return geo;
    double ksum = 0;
    double ks[16];
    for (int i = 0; i < nfit; i++) {
        double t = tan(M_PI_4 + lats[i] * M_PI / 180.0 / 2.0);
        if (!(t > 0)) return geo;
        ks[i] = radii[i] / pow(t, cone);
        ksum += ks[i];
    }
    double k = ksum / nfit;
    for (int i = 0; i < nfit; i++) {
        if (fabs(ks[i] - k) > 0.02 * k) return geo;
    }
    geo.poleX = pole.x;
    geo.poleY = pole.y;
    geo.n = cone;
    geo.k = k;
    geo.lon0 = lon0;
    geo.a = a;
    geo.d = d;
    geo.e = e;
    geo.f = f;
    geo.valid = YES;
    return geo;
}

// Grey frame of each prognosis map, reference page, PDF origin at the bottom left.
// The 2 pt stroke is centred on this rect. The title bar sits above it.
// Registered to the identical mainland vector in each Bureau panel. The page
// frame drifts by up to a point; using the frame itself makes Australia wobble.
static const MSLPRect kMSLPMapFrames[8] = {
    {39.332000, 560.651000, 226.494, 170.594},
    {273.395675, 560.570556, 226.494, 170.594},
    {38.455596, 374.839644, 226.494, 170.594},
    {273.371993, 374.754531, 226.494, 170.594},
    {39.332000, 189.364333, 226.494, 170.594},
    {273.237106, 189.104079, 226.494, 170.594},
    {38.510101, 3.870864, 226.494, 170.594},
    {273.511581, 2.772048, 226.494, 170.594},
};
static const double kMapFrameInset = 1.25;

MSLPRect MSLPPrognosisMapCrop(double pageWidth, double pageHeight, int panel) {
    MSLPRect empty = {0};
    if (panel < 0 || panel > 7 || pageWidth < 100 || pageHeight < 100) return empty;
    double sx = pageWidth / kMSLPRefW;
    double sy = pageHeight / kMSLPRefH;
    MSLPRect r = MSLPScale(kMSLPMapFrames[panel], sy, sy);
    // Some Bureau exports trim the page width without scaling the map vectors.
    // Anchor panel zero as before; all panel-relative offsets use one scale.
    r.x += kMSLPMapFrames[0].x * (sx - sy);
    double inset = kMapFrameInset * sy;
    if (r.width <= inset * 2 + 20 || r.height <= inset * 2 + 20) return empty;
    r.x += inset;
    r.y += inset;
    r.width -= inset * 2;
    r.height -= inset * 2;
    return r;
}

double MSLPPopoverMapAspect(void) {
    MSLPRect r = MSLPPrognosisMapCrop(kMSLPRefW, kMSLPRefH, 0);
    if (r.height < 1) return 1.33;
    return r.width / r.height;
}

// Mainland extremes. Tasmania lies south of Wilsons Promontory and stays in the
// lower margin, as it does on the prognosis panel.
static const double kAusExtremes[][2] = {
    {-26.15, 113.16}, // Steep Point, west
    {-28.63, 153.64}, // Cape Byron, east
    {-10.69, 142.53}, // Cape York, north
    {-39.13, 146.42}, // Wilsons Promontory, south
};
// Land-fill box of Australia on IDG00073 panel 0, as a fraction of that map.
static const double kProgAusLeft = 0.1737;
static const double kProgAusWidth = 0.6613;
static const double kProgAusCenter = 0.5958; // of the panel height, from the bottom

MSLPRect AnalysisPopoverCrop(AnalysisGeo geo, double pageWidth, double pageHeight) {
    MSLPRect empty = {0};
    if (!geo.valid || pageWidth < 50 || pageHeight < 50) return empty;
    double aspect = MSLPPopoverMapAspect();
    if (!(aspect > 0.2 && aspect < 5)) return empty;
    double minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    int hits = 0;
    for (int i = 0; i < 4; i++) {
        double x = 0, y = 0;
        if (!AnalysisProject(geo, kAusExtremes[i][0], kAusExtremes[i][1], &x, &y) || !isfinite(x) || !isfinite(y))
            continue;
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        hits++;
    }
    if (hits < 4) return empty;
    double ausW = maxx - minx, ausH = maxy - miny;
    if (ausW < 20 || ausH < 20) return empty;
    double edge = 1.0;
    double cropW = ausW / kProgAusWidth;
    double cropH = cropW / aspect;
    double maxW = pageWidth - 2 * edge, maxH = pageHeight - 2 * edge;
    if (cropW > maxW || cropH > maxH) {
        double scale = MIN(maxW / cropW, maxH / cropH);
        cropW *= scale;
        cropH = cropW / aspect;
    }
    double midX = (minx + maxx) / 2.0;
    double midY = (miny + maxy) / 2.0;
    double cropX = midX - (kProgAusLeft + kProgAusWidth / 2.0) * cropW;
    double cropY = midY - kProgAusCenter * cropH;
    if (cropX < edge) cropX = edge;
    if (cropY < edge) cropY = edge;
    if (cropX + cropW > pageWidth - edge) cropX = pageWidth - edge - cropW;
    if (cropY + cropH > pageHeight - edge) cropY = pageHeight - edge - cropH;
    if (cropW < 20 || cropH < 20) return empty;
    return (MSLPRect){cropX, cropY, cropW, cropH};
}

// Long isobar stroke on IDG00073, in page points. The 1.66 pt strokes are fronts.
static const double kPrognosisIsobarWidth = 0.592;

double AnalysisIsobarStroke(double cropWidth) {
    MSLPRect map = MSLPPrognosisMapCrop(kMSLPRefW, kMSLPRefH, 0);
    if (cropWidth < 20 || map.width < 20) return 0;
    // Measured against the rendered prognosis: the ratio alone drew analysis isobars about twice
    // as heavy (the prognosis crop is presented at a larger scale), so halve it to match by eye.
    return 0.5 * kPrognosisIsobarWidth * cropWidth / map.width;
}

static NSTimeZone *PopoverZone(NSTimeZone *tz) {
    return tz ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
}

static void PopoverClockParts(NSDate *valid, NSTimeZone *tz, NSString **day, NSInteger *hour12,
    NSInteger *minute, NSString **suffix, NSString **zone) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = PopoverZone(tz);
    NSDateComponents *c = [cal components:NSCalendarUnitHour | NSCalendarUnitMinute fromDate:valid];
    NSInteger h = c.hour % 12;
    if (h == 0) h = 12;
    NSDateFormatter *days = [NSDateFormatter new];
    days.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    days.timeZone = cal.timeZone;
    days.dateFormat = @"EEE";
    if (day) *day = [days stringFromDate:valid] ?: @"";
    if (hour12) *hour12 = h;
    if (minute) *minute = c.minute;
    if (suffix) *suffix = c.hour >= 12 ? @"pm" : @"am";
    if (zone) *zone = [cal.timeZone abbreviationForDate:valid] ?: @"";
}

NSString *PopoverRelativeLabel(NSDate *valid, NSDate *origin) {
    if (!valid) return @"";
    if (!origin) return @"Now";
    NSInteger hours = (NSInteger)llround([valid timeIntervalSinceDate:origin] / 3600.0);
    if (hours <= 0) return @"Now";
    return [NSString stringWithFormat:@"+%ld h", (long)hours];
}

NSString *PopoverClockLabel(NSDate *valid, NSTimeZone *tz) {
    if (!valid) return @"";
    NSString *day = @"", *suffix = @"", *zone = @"";
    NSInteger hour = 0, minute = 0;
    PopoverClockParts(valid, tz, &day, &hour, &minute, &suffix, &zone);
    if (minute == 0)
        return [NSString stringWithFormat:@"%@ %ld %@ %@", day, (long)hour, suffix, zone];
    return [NSString stringWithFormat:@"%@ %ld:%02ld %@ %@", day, (long)hour, (long)minute, suffix, zone];
}

NSString *PopoverTickLabel(NSDate *valid, NSDate *origin, NSTimeZone *tz) {
    NSString *relative = PopoverRelativeLabel(valid, origin);
    if (![relative hasPrefix:@"+"]) return relative.length ? relative : @"";
    NSString *day = @"", *suffix = @"";
    NSInteger hour = 0, minute = 0;
    PopoverClockParts(valid, tz, &day, &hour, &minute, &suffix, NULL);
    NSString *hours = [relative stringByReplacingOccurrencesOfString:@" h" withString:@"h"];
    if (minute == 0)
        return [NSString stringWithFormat:@"%@ %@ %ld%@", hours, day, (long)hour, suffix];
    return [NSString stringWithFormat:@"%@ %@ %ld:%02ld%@", hours, day, (long)hour, (long)minute, suffix];
}

// Morning 5:00, afternoon 12:00, evening 17:00, night 21:00. Before 5:00 the
// anchor day is the previous calendar day, so 2 am Sunday is still Saturday night.
static const NSTimeInterval kSituationNowWindow = 90 * 60;

static NSCalendar *SituationCalendar(NSTimeZone *tz) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    return cal;
}

static NSDate *SituationAnchor(NSDate *date, NSCalendar *cal) {
    if (!date) return nil;
    NSDate *start = [cal startOfDayForDate:date];
    if ([cal component:NSCalendarUnitHour fromDate:date] < 5)
        start = [cal dateByAddingUnit:NSCalendarUnitDay value:-1 toDate:start options:0];
    return start;
}

static int SituationPart(NSDate *date, NSCalendar *cal) {
    NSInteger hour = [cal component:NSCalendarUnitHour fromDate:date];
    if (hour < 5) return 3;
    if (hour < 12) return 0;
    if (hour < 17) return 1;
    if (hour < 21) return 2;
    return 3;
}

static NSString *SituationWeekday(NSDate *anchor, NSCalendar *cal) {
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    fmt.timeZone = cal.timeZone;
    fmt.dateFormat = @"EEE";
    return [fmt stringFromDate:anchor] ?: @"";
}

NSString *SituationPhrase(NSDate *valid, NSDate *now, NSTimeZone *tz) {
    if (!valid) return @"";
    NSCalendar *cal = SituationCalendar(tz);
    if (now && fabs([valid timeIntervalSinceDate:now]) <= kSituationNowWindow) return @"Now";
    int part = SituationPart(valid, cal);
    NSDate *anchor = SituationAnchor(valid, cal);
    NSInteger delta = 0;
    if (now && anchor) {
        NSDate *today = SituationAnchor(now, cal);
        if (today)
            delta = [cal components:NSCalendarUnitDay fromDate:today toDate:anchor options:0].day;
    }
    if (!now) {
        NSString *day = SituationWeekday(anchor, cal);
        if (part == 0) return [NSString stringWithFormat:@"%@ morning", day];
        if (part == 1) return [NSString stringWithFormat:@"%@ afternoon", day];
        return [NSString stringWithFormat:@"%@ night", day];
    }
    if (delta == 0) {
        if (part == 0) return @"This morning";
        if (part == 1) return @"This afternoon";
        return @"Tonight";
    }
    if (delta == 1) {
        if (part == 0) return @"Tomorrow morning";
        if (part == 1) return @"Tomorrow afternoon";
        return @"Tomorrow night";
    }
    if (delta == -1) {
        if (part == 0) return @"Yesterday morning";
        if (part == 1) return @"Yesterday afternoon";
        return @"Last night";
    }
    NSString *day = SituationWeekday(anchor, cal);
    if (part == 0) return [NSString stringWithFormat:@"%@ morning", day];
    if (part == 1) return [NSString stringWithFormat:@"%@ afternoon", day];
    return [NSString stringWithFormat:@"%@ night", day];
}

NSString *SituationClock(NSDate *valid, NSTimeZone *tz) {
    if (!valid) return @"";
    NSCalendar *cal = SituationCalendar(tz);
    NSDateComponents *c = [cal components:NSCalendarUnitHour | NSCalendarUnitMinute fromDate:valid];
    NSInteger h = c.hour % 12;
    if (h == 0) h = 12;
    NSString *suffix = c.hour >= 12 ? @"pm" : @"am";
    if (c.minute == 0) return [NSString stringWithFormat:@"%ld %@", (long)h, suffix];
    return [NSString stringWithFormat:@"%ld:%02ld %@", (long)h, (long)c.minute, suffix];
}

NSString *SituationOffset(NSDate *valid, NSDate *now) {
    if (!valid || !now) return @"";
    NSInteger hours = (NSInteger)llround([valid timeIntervalSinceDate:now] / 3600.0);
    if (hours == 0) return @"";
    if (hours > 0) return [NSString stringWithFormat:@"+%ldh", (long)hours];
    return [NSString stringWithFormat:@"%ldh ago", (long)-hours];
}

NSString *SituationTitle(NSDate *valid, NSDate *now, NSTimeZone *tz) {
    NSString *phrase = SituationPhrase(valid, now, tz);
    NSString *clock = SituationClock(valid, tz);
    if (!phrase.length) return clock ?: @"";
    if (!clock.length) return phrase;
    return [NSString stringWithFormat:@"%@ · %@", phrase, clock];
}

NSInteger SituationAnchorDay(NSDate *valid, NSTimeZone *tz) {
    if (!valid) return 0;
    NSCalendar *cal = SituationCalendar(tz);
    NSDate *anchor = SituationAnchor(valid, cal);
    if (!anchor) return 0;
    NSDateComponents *c = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay fromDate:anchor];
    return c.year * 10000 + c.month * 100 + c.day;
}

NSString *SituationFreshness(NSDate *run, NSDate *now) {
    if (!run || !now) return @"";
    NSTimeInterval age = [now timeIntervalSinceDate:run];
    if (age < 0) age = 0;
    NSInteger hours = (NSInteger)floor(age / 3600.0);
    if (hours < 1) return @"Forecast updated just now";
    return [NSString stringWithFormat:@"Forecast updated %ld h ago", (long)hours];
}

NSString *ChartTemperatureLegend(int temperature) {
    if (temperature == 2) return @"Surface \u00B0C";
    if (temperature > 0) return @"850 hPa (~5,000 ft) \u00B0C";
    return @"";
}

static NSString *WarningSentence(NSString *title) {
    if (!title.length) return @"";
    NSString *lower = title.lowercaseString;
    NSArray *parts = [lower componentsSeparatedByString:@" · "];
    if (parts.count > 1 && [@[@"wa", @"nsw", @"vic", @"qld", @"sa", @"tas", @"nt", @"act"] containsObject:parts[0]])
        return [NSString stringWithFormat:@"%@ · %@", [parts[0] uppercaseString],
            WarningSentence([[parts subarrayWithRange:NSMakeRange(1, parts.count - 1)] componentsJoinedByString:@" · "])];
    NSRange first = [lower rangeOfComposedCharacterSequenceAtIndex:0];
    return [[[lower substringWithRange:first] uppercaseString] stringByAppendingString:[lower substringFromIndex:NSMaxRange(first)]];
}

NSString *PopoverWarningSummary(NSArray<NSDictionary *> *items) {
    if (![items isKindOfClass:NSArray.class] || !items.count) return @"";
    NSMutableArray *order = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSMutableArray<NSString *> *> *places = [NSMutableDictionary dictionary];
    for (id item in items) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *title = [item[@"title"] isKindOfClass:NSString.class] ? item[@"title"] : @"";
        NSString *place = [item[@"place"] isKindOfClass:NSString.class] ? item[@"place"] : @"";
        if (!title.length) continue;
        NSString *key = title.lowercaseString;
        if (!places[key]) {
            places[key] = [NSMutableArray array];
            [order addObject:key];
        }
        if (place.length && ![places[key] containsObject:place]) [places[key] addObject:place];
    }
    NSMutableArray *parts = [NSMutableArray array];
    for (NSString *key in order) {
        NSString *shown = WarningSentence(key);
        NSString *who = [places[key] componentsJoinedByString:@", "];
        [parts addObject:who.length
            ? [NSString stringWithFormat:@"\u26A0\uFE0E %@ — %@", shown, who]
            : [NSString stringWithFormat:@"\u26A0\uFE0E %@", shown]];
    }
    return [parts componentsJoinedByString:@"   ·   "];
}

static NSString *AnalysisRGB(MSLPColour colour, BOOL stroke) {
    return [NSString stringWithFormat:@"%.6f %.6f %.6f %@", colour.red, colour.green, colour.blue, stroke ? @"RG" : @"rg"];
}

NSData *AnalysisRecolourStream(NSData *content) {
    if (!content.length) return content;
    NSMutableString *text = [[NSMutableString alloc] initWithData:content encoding:NSISOLatin1StringEncoding];
    if (!text) return content;
    NSDictionary<NSString *, NSString *> *map = @{
        @"0.922 0.941 1.000 rg": AnalysisRGB(MSLPColourSea(), NO),
        @"0.945 0.945 0.863 rg": AnalysisRGB(MSLPColourLand(), NO),
        @"0.518 0.529 1.000 RG": AnalysisRGB(MSLPColourInk(), YES),
        @"0.000 0.000 0.000 rg": AnalysisRGB(MSLPColourInk(), NO),
        @"0.000 0.000 0.000 RG": AnalysisRGB(MSLPColourInk(), YES),
    };
    for (NSString *from in map)
        [text replaceOccurrencesOfString:from withString:map[from] options:0 range:NSMakeRange(0, text.length)];
    return [text dataUsingEncoding:NSISOLatin1StringEncoding] ?: content;
}

// The Bureau draws each label twice: an invisible /A0 text run, and a filled outline just before it.
static NSString *const kGlyphSetup = @"[0 1] 0 d 0.000 0.000 0.000 RG 0.1 w 2 j";

static BOOL WholeMatch(NSString *text, NSString *pattern) {
    if (!text.length) return NO;
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
    NSTextCheckingResult *hit = re ? [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] : nil;
    return hit && NSEqualRanges(hit.range, NSMakeRange(0, text.length));
}

static BOOL AnalysisLabelKind(NSString *shown, BOOL *graticule) {
    if (WholeMatch(shown, @"^(?:180|\\d{2,3}[EWNS])$")) {
        *graticule = YES;
        return YES;
    }
    if ([shown isEqual:@"H"] || [shown isEqual:@"L"] || WholeMatch(shown, @"^\\d{3,4}$")) {
        *graticule = NO;
        return YES;
    }
    return NO;
}

// From the dash setup through the newline before BT, when that setup belongs to this label.
static NSRange GlyphOutlineBefore(NSString *text, NSUInteger bt) {
    NSRange none = NSMakeRange(NSNotFound, 0);
    if (bt < 4) return none;
    NSUInteger cursor = bt;
    if ([text characterAtIndex:cursor - 1] == '\n') cursor--;
    if (cursor && [text characterAtIndex:cursor - 1] == '\r') cursor--;
    if (cursor < 3 || ![[text substringWithRange:NSMakeRange(cursor - 3, 3)] isEqual:@"h f"]) return none;
    NSUInteger window = 12000;
    NSUInteger from = cursor > window ? cursor - window : 0;
    NSRange marker = [text rangeOfString:kGlyphSetup options:NSBackwardsSearch range:NSMakeRange(from, cursor - from)];
    if (marker.location == NSNotFound) return none;
    NSString *between = [text substringWithRange:NSMakeRange(NSMaxRange(marker), cursor - NSMaxRange(marker))];
    if ([between containsString:@"ET"] || [between containsString:@"Tj"]) return none;
    return NSMakeRange(marker.location, bt - marker.location);
}

static NSString *BoldPressureBlock(NSString *block) {
    NSRegularExpression *tm = [NSRegularExpression regularExpressionWithPattern:
        @"([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+([-+0-9.]+)\\s+Tm"
        options:0 error:nil];
    NSMutableString *next = [block mutableCopy];
    // The prognosis face is condensed. Helvetica-Bold at the Bureau's advance width
    // runs the rotated contour label into the central value, so the advance is narrowed
    // and the cap height stays. That is the bold sans this PDF can draw.
    const double advance = 0.80;
    [next replaceOccurrencesOfString:@"/A0 gs" withString:@"/A255 gs" options:0 range:NSMakeRange(0, next.length)];
    [next replaceOccurrencesOfString:@"/F0 " withString:@"/F0b " options:0 range:NSMakeRange(0, next.length)];
    NSTextCheckingResult *place = [tm firstMatchInString:next options:0 range:NSMakeRange(0, next.length)];
    if (place && place.numberOfRanges >= 7) {
        double m[4];
        for (int k = 0; k < 4; k++)
            m[k] = [[next substringWithRange:[place rangeAtIndex:(NSUInteger)(k + 1)]] doubleValue];
        m[0] *= advance;
        m[1] *= advance;
        NSString *scaled = [NSString stringWithFormat:@"%.6f %.6f %.6f %.6f %@ %@ Tm",
            m[0], m[1], m[2], m[3],
            [next substringWithRange:[place rangeAtIndex:5]],
            [next substringWithRange:[place rangeAtIndex:6]]];
        [next replaceCharactersInRange:place.range withString:scaled];
    }
    return next;
}

static void RestyleAnalysisLabels(NSMutableString *text) {
    NSRegularExpression *shown = [NSRegularExpression regularExpressionWithPattern:@"\\(([^)]*)\\)\\s*Tj" options:0 error:nil];
    NSMutableArray<NSValue *> *spans = [NSMutableArray array];
    NSMutableArray<NSString *> *replacements = [NSMutableArray array];
    NSUInteger cursor = 0;
    while (cursor < text.length) {
        NSRange bt = [text rangeOfString:@"BT" options:0 range:NSMakeRange(cursor, text.length - cursor)];
        if (bt.location == NSNotFound) break;
        NSUInteger limit = MIN((NSUInteger)500, text.length - bt.location);
        NSRange et = [text rangeOfString:@"ET" options:0 range:NSMakeRange(bt.location, limit)];
        if (et.location == NSNotFound) break;
        NSRange blockRange = NSMakeRange(bt.location, NSMaxRange(et) - bt.location);
        NSString *block = [text substringWithRange:blockRange];
        NSTextCheckingResult *label = [shown firstMatchInString:block options:0 range:NSMakeRange(0, block.length)];
        cursor = NSMaxRange(blockRange);
        if (!label || label.numberOfRanges < 2 || ![block containsString:@"/A0 gs"]) continue;
        BOOL graticule = NO;
        NSString *literal = [block substringWithRange:[label rangeAtIndex:1]];
        if (!AnalysisLabelKind(literal, &graticule)) continue;
        NSRange outline = GlyphOutlineBefore(text, bt.location);
        if (outline.location == NSNotFound) continue;
        [spans addObject:[NSValue valueWithRange:NSMakeRange(outline.location, NSMaxRange(blockRange) - outline.location)]];
        [replacements addObject:graticule ? @"" : BoldPressureBlock(block)];
    }
    for (NSInteger i = (NSInteger)spans.count - 1; i >= 0; i--)
        [text replaceCharactersInRange:spans[i].rangeValue withString:replacements[i]];
}

static void SuppressStrokeColour(NSMutableString *text, NSString *colour) {
    NSUInteger search = 0;
    while (search < text.length) {
        NSRange found = [text rangeOfString:colour options:0 range:NSMakeRange(search, text.length - search)];
        if (found.location == NSNotFound) break;
        NSUInteger from = NSMaxRange(found);
        NSRange next = [text rangeOfString:@" RG" options:0 range:NSMakeRange(from, text.length - from)];
        NSUInteger end = next.location == NSNotFound ? text.length : next.location;
        NSUInteger scan = from;
        while (scan < end) {
            NSRange stroke = [text rangeOfString:@" S" options:0 range:NSMakeRange(scan, end - scan)];
            if (stroke.location == NSNotFound) break;
            NSUInteger afterAt = stroke.location + 2;
            unichar after = afterAt < text.length ? [text characterAtIndex:afterAt] : '\n';
            if (after == ' ' || after == '\n' || after == '\r')
                [text replaceCharactersInRange:NSMakeRange(stroke.location + 1, 1) withString:@"n"];
            scan = stroke.location + 2;
        }
        search = from;
    }
}

NSData *AnalysisPopoverStream(NSData *content, double cropWidth) {
    if (!content.length) return content;
    NSMutableString *text = [[NSMutableString alloc] initWithData:content encoding:NSISOLatin1StringEncoding];
    if (!text) return AnalysisRecolourStream(content);
    RestyleAnalysisLabels(text);
    SuppressStrokeColour(text, @"0.647 0.647 0.647 RG");
    SuppressStrokeColour(text, @"0.490 0.490 0.333 RG");
    double stroke = AnalysisIsobarStroke(cropWidth);
    if (stroke > 0) {
        NSString *ink = [NSString stringWithFormat:@"%@ %.3f w", AnalysisRGB(MSLPColourInk(), YES), stroke];
        [text replaceOccurrencesOfString:@"0.314 0.314 0.314 RG 0.4 w" withString:ink options:0 range:NSMakeRange(0, text.length)];
    }
    return AnalysisRecolourStream([text dataUsingEncoding:NSISOLatin1StringEncoding] ?: content);
}

NSString *StoreStatusRelative(void) { return @"status.json"; }
NSString *StoreECMWFLatestRelative(void) { return @"ecmwf/latest.json"; }
NSString *StoreChartRelative(void) { return @"products/charts/IDG00073.pdf"; }
NSString *StoreChartPreviousRelative(void) { return @"products/charts/previous/IDG00073.pdf"; }

NSString *StoreObservationRelative(NSString *wmo) {
    if (!wmo.length) return nil;
    NSCharacterSet *ok = [NSCharacterSet characterSetWithCharactersInString:@"0123456789"];
    if ([wmo rangeOfCharacterFromSet:ok.invertedSet].location != NSNotFound) return nil;
    return [NSString stringWithFormat:@"products/obs/%@.json", wmo];
}

NSString *StoreWarningsDirectoryRelative(void) { return @"products/warnings"; }

NSString *StorePointRelative(NSString *geohash) {
    if (geohash.length < 4) return nil;
    NSCharacterSet *ok = [NSCharacterSet characterSetWithCharactersInString:
        @"0123456789bcdefghjkmnpqrstuvwxyz"];
    if ([geohash.lowercaseString rangeOfCharacterFromSet:ok.invertedSet].location != NSNotFound) return nil;
    return [NSString stringWithFormat:@"products/points/%@.json", geohash.lowercaseString];
}

NSString *StoreKiteRelative(void) {
    return @"products/kite.json";
}

static BOOL StoreSafeRelative(NSString *path) {
    if (!path.length || [path hasPrefix:@"/"] || [path hasPrefix:@"~"]) return NO;
    if ([path containsString:@".."] || [path containsString:@"\\"]) return NO;
    return YES;
}

NSDictionary *StoreManifestFromJSON(NSData *json) {
    NSDictionary *root = JSONObject(json);
    if (!root) return nil;
    id schema = root[@"schema"];
    if (schema && ![schema isKindOfClass:NSNumber.class]) return nil;
    if ([schema isKindOfClass:NSNumber.class] && [(NSNumber *)schema integerValue] != 1) return nil;
    NSDictionary *grid = [root[@"grid"] isKindOfClass:NSDictionary.class] ? root[@"grid"] : nil;
    NSArray *timesIn = JSONArray(root[@"times"]);
    if (!grid || !timesIn.count) return nil;
    NSString *dtype = [grid[@"dtype"] isKindOfClass:NSString.class] ? grid[@"dtype"] : nil;
    if (dtype.length && ![dtype isEqual:@"float32"]) return nil;
    NSString *endian = [grid[@"endian"] isKindOfClass:NSString.class] ? grid[@"endian"] : nil;
    if (![endian isEqual:@"little"]) return nil;
    double step = [Num(grid[@"step"]) doubleValue];
    int nx = [Num(grid[@"nx"]) intValue];
    int ny = [Num(grid[@"ny"]) intValue];
    NSNumber *west = Num(grid[@"west"]);
    NSNumber *east = Num(grid[@"east"]);
    NSNumber *north = Num(grid[@"north"]);
    NSNumber *south = Num(grid[@"south"]);
    size_t cells = (size_t)nx * (size_t)ny;
    if (!west || !east || !north || !south || !(step > 0) || nx < 2 || ny < 2 || nx > 1000 || ny > 1000 || cells > 250000) return nil;
    NSDate *run = ISODate(root[@"run"]);
    if (!run) return nil;
    NSMutableArray *times = [NSMutableArray array];
    for (id item in timesIn) {
        NSDate *when = ISODate(item);
        if (!when) return nil;
        [times addObject:when];
    }
    NSString *order = [grid[@"order"] isKindOfClass:NSString.class] ? grid[@"order"] : @"";
    if (order.length && [order rangeOfString:@"north-to-south"].location == NSNotFound) return nil;
    NSDictionary *variables = [root[@"variables"] isKindOfClass:NSDictionary.class] ? root[@"variables"] : @{};
    for (NSString *key in variables) {
        NSDictionary *entry = [variables[key] isKindOfClass:NSDictionary.class] ? variables[key] : nil;
        NSString *file = [entry[@"file"] isKindOfClass:NSString.class] ? entry[@"file"] : @"";
        NSString *ext = file.pathExtension.lowercaseString;
        if ([ext isEqual:@"grib"] || [ext isEqual:@"grib2"] || !StoreSafeRelative(file)) return nil;
    }
    NSString *credit = [root[@"attribution"] isKindOfClass:NSString.class] ? root[@"attribution"] : @"";
    return @{
        @"run": run,
        @"generated": ISODate(root[@"generated"]) ?: NSNull.null,
        @"times": times,
        @"nx": @(nx), @"ny": @(ny), @"step": @(step),
        @"west": west, @"east": east, @"north": north, @"south": south,
        @"variables": variables,
        @"attribution": credit,
    };
}

NSString *StoreLatestRunPath(NSData *json) {
    NSDictionary *root = JSONObject(json);
    NSString *path = [root[@"path"] isKindOfClass:NSString.class] ? root[@"path"] : nil;
    if (!path.length) path = [root[@"run"] isKindOfClass:NSString.class] ? root[@"run"] : nil;
    if (!StoreSafeRelative(path)) return nil;
    return path;
}

static NSDictionary *StoreECMWFSource(NSData *json) {
    NSArray *sources = JSONArray(JSONObject(json)[@"sources"]);
    NSDictionary *legacy = nil;
    for (NSDictionary *source in sources) {
        if (![source isKindOfClass:NSDictionary.class]) continue;
        NSString *ident = [source[@"id"] isKindOfClass:NSString.class] ? source[@"id"] : @"";
        // Point forecasts and ensembles can have different cycles. Only the
        // national chart source may report the chart fetch's health.
        if ([ident isEqual:@"ecmwf-open-data"]) return source;
        if ([ident isEqual:@"ecmwf-ifs"]) legacy = source;
    }
    return legacy;
}

NSString *StoreStatusLabel(NSData *json) {
    NSDictionary *source = StoreECMWFSource(json);
    NSString *label = [source[@"label"] isKindOfClass:NSString.class] ? source[@"label"] : nil;
    return label.length ? label : nil;
}

NSDate *StoreStatusRun(NSData *json) {
    return ISODate(StoreECMWFSource(json)[@"run"]);
}

BOOL StoreStatusOK(NSData *json) {
    NSDictionary *source = StoreECMWFSource(json);
    if (!source) return NO;
    id ok = source[@"ok"];
    if ([ok isKindOfClass:NSNumber.class]) return [(NSNumber *)ok boolValue];
    return NO;
}

NSTimeInterval StoreStaleAge(void) { return 18 * 3600; }

BOOL StoreRunIsStale(NSDate *run, NSDate *now, BOOL statusOK) {
    if (!statusOK || !run || !now) return YES;
    return [now timeIntervalSinceDate:run] > StoreStaleAge();
}

NSString *StoreForecastFreshness(NSDate *loadedRun, NSDate *now, BOOL statusOK) {
    if (!loadedRun) return @"Chart unavailable";
    NSString *text = SituationFreshness(loadedRun, now);
    if (StoreRunIsStale(loadedRun, now, statusOK))
        text = [text stringByAppendingString:@" · stale"];
    return text;
}

NSString *StoreRunStatusLine(NSDate *run, NSDate *now) {
    if (!run) return @"ECMWF";
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSInteger hour = [cal component:NSCalendarUnitHour fromDate:run];
    NSInteger age = 0;
    if (now) {
        NSTimeInterval seconds = [now timeIntervalSinceDate:run];
        if (seconds > 0) age = (NSInteger)floor(seconds / 3600.0);
    }
    return [NSString stringWithFormat:@"ECMWF %02ldZ · %ld h ago", (long)hour, (long)age];
}

NSString *StoreRunCompareTitle(NSDate *run, NSDate *previous) {
    if (!run || !previous) return nil;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSInteger hour = [cal component:NSCalendarUnitHour fromDate:run];
    NSInteger earlier = [cal component:NSCalendarUnitHour fromDate:previous];
    return [NSString stringWithFormat:@"%02ldZ vs previous %02ldZ", (long)hour, (long)earlier];
}

static const NSTimeInterval kFrameSlop = 90 * 60;
static const NSTimeInterval kFrameHorizon = 96 * 3600;

NSArray<NSNumber *> *StoreFrameIndices(NSArray<NSDate *> *times, NSDate *now) {
    if (!times.count || !now) return @[];
    NSInteger anchor = -1;
    for (NSInteger i = 0; i < (NSInteger)times.count; i++) {
        id item = times[i];
        if (![item isKindOfClass:NSDate.class]) continue;
        // Keep a sample at or before now so interpolation can represent now.
        if ([(NSDate *)item timeIntervalSinceDate:now] <= 0) anchor = i;
    }
    if (anchor < 0) {
        for (NSInteger i = 0; i < (NSInteger)times.count; i++) {
            if (![times[i] isKindOfClass:NSDate.class]) continue;
            if (anchor < 0 || [(NSDate *)times[i] compare:times[anchor]] == NSOrderedAscending) anchor = i;
        }
    }
    if (anchor < 0) return @[];
    NSDate *origin = times[anchor];
    NSMutableArray<NSNumber *> *ladder = [NSMutableArray array];
    for (int lead = 0; lead <= 96; lead += 12) {
        NSDate *want = [origin dateByAddingTimeInterval:lead * 3600.0];
        NSInteger best = -1;
        NSTimeInterval bestDelta = kFrameSlop + 1;
        for (NSInteger i = 0; i < (NSInteger)times.count; i++) {
            if (![times[i] isKindOfClass:NSDate.class]) continue;
            NSTimeInterval delta = fabs([(NSDate *)times[i] timeIntervalSinceDate:want]);
            if (delta < bestDelta) { bestDelta = delta; best = i; }
        }
        if (best < 0 || bestDelta > kFrameSlop) continue;
        NSNumber *boxed = @(best);
        if (![ladder containsObject:boxed]) [ladder addObject:boxed];
    }
    if (ladder.count >= 2) {
        // Preserve the final valid hour even when it is off the 12-hour ladder.
        for (NSInteger i = (NSInteger)times.count - 1; i > ladder.lastObject.integerValue; i--) {
            if (![times[i] isKindOfClass:NSDate.class]) continue;
            NSTimeInterval lead = [times[i] timeIntervalSinceDate:origin];
            if (lead >= 0 && lead <= kFrameHorizon) { [ladder addObject:@(i)]; break; }
        }
        return ladder;
    }
    NSMutableArray<NSNumber *> *present = [NSMutableArray array];
    for (NSInteger i = 0; i < (NSInteger)times.count; i++) {
        if (![times[i] isKindOfClass:NSDate.class]) continue;
        NSTimeInterval lead = [(NSDate *)times[i] timeIntervalSinceDate:origin];
        if (lead < -60 || lead > kFrameHorizon + 60) continue;
        [present addObject:@(i)];
    }
    return present.count ? present : @[@(anchor)];
}

NSString *StorePreviousRunID(NSArray<NSString *> *runIDs, NSString *current) {
    NSString *best = nil;
    for (NSString *runID in runIDs) {
        if (![runID isKindOfClass:NSString.class] || !runID.length) continue;
        if (!StoreSafeRelative(runID)) continue;
        if (current.length && [runID compare:current] != NSOrderedAscending) continue;
        if (!best || [runID compare:best] == NSOrderedDescending) best = runID;
    }
    return best;
}

static NSString *XMLTagText(NSString *block, NSString *tag) {
    if (!block.length || !tag.length) return @"";
    NSString *pattern = [NSString stringWithFormat:@"(?i)<%@[^>]*>(.*?)</%@>", tag, tag];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pattern
        options:NSRegularExpressionDotMatchesLineSeparators error:nil];
    NSTextCheckingResult *match = [re firstMatchInString:block options:0 range:NSMakeRange(0, block.length)];
    if (!match || match.numberOfRanges < 2) return @"";
    NSString *raw = [block substringWithRange:[match rangeAtIndex:1]];
    return [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static NSString *XMLNodeText(NSXMLNode *node) {
    NSString *value = node.stringValue ?: @"";
    return [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static NSArray<NSXMLNode *> *XMLDescendants(NSXMLNode *node, NSString *name) {
    NSMutableArray *out = [NSMutableArray array];
    for (NSXMLNode *child in node.children ?: @[]) {
        if ([child.name.lowercaseString isEqual:name.lowercaseString]) [out addObject:child];
        [out addObjectsFromArray:XMLDescendants(child, name)];
    }
    return out;
}

static NSXMLNode *XMLFirstDescendant(NSXMLNode *node, NSString *name) {
    for (NSXMLNode *child in node.children ?: @[]) {
        if ([child.name.lowercaseString isEqual:name.lowercaseString]) return child;
        NSXMLNode *found = XMLFirstDescendant(child, name);
        if (found) return found;
    }
    return nil;
}

static NSString *XMLTextOfType(NSXMLNode *root, NSString *type) {
    for (NSXMLNode *node in XMLDescendants(root, @"text")) {
        NSString *nodeType = [[[(NSXMLElement *)node attributeForName:@"type"] stringValue] lowercaseString];
        if ([nodeType isEqual:type.lowercaseString]) return XMLNodeText(node);
    }
    return @"";
}

static NSString *WarningStateFromRegionOrIdentifier(NSString *region, NSString *identifier) {
    NSString *lower = region.lowercaseString;
    NSDictionary *names = @{
        @"western australia": @"WA", @"new south wales": @"NSW", @"victoria": @"VIC",
        @"queensland": @"QLD", @"south australia": @"SA", @"tasmania": @"TAS",
        @"northern territory": @"NT", @"australian capital territory": @"ACT",
    };
    NSString *state = names[lower];
    if (state.length) return state;
    NSDictionary *prefixes = @{@"IDW": @"WA", @"IDN": @"NSW", @"IDV": @"VIC", @"IDQ": @"QLD",
        @"IDS": @"SA", @"IDT": @"TAS", @"IDD": @"NT"};
    for (NSString *prefix in prefixes) if ([identifier.uppercaseString hasPrefix:prefix]) return prefixes[prefix];
    return @"";
}

static NSArray<NSDictionary *> *ParseBureauProductWarningXML(NSData *xml) {
    // Bureau product XML is untrusted input. Reject DTDs so parsing cannot resolve external entities.
    NSString *raw = [[NSString alloc] initWithData:xml encoding:NSUTF8StringEncoding];
    if (!raw.length || [raw rangeOfString:@"<!DOCTYPE" options:NSCaseInsensitiveSearch].location != NSNotFound)
        return @[];
    NSError *error = nil;
    NSXMLDocument *document = [[NSXMLDocument alloc] initWithData:xml options:0 error:&error];
    if (error || !document.rootElement) return @[];
    NSXMLNode *amoc = XMLFirstDescendant(document.rootElement, @"amoc");
    NSXMLNode *info = XMLFirstDescendant(document.rootElement, @"warning-info");
    if (!amoc || !info) return @[];
    NSString *phase = XMLNodeText(XMLFirstDescendant(amoc, @"phase")).uppercaseString;
    NSString *status = XMLNodeText(XMLFirstDescendant(amoc, @"status")).uppercaseString;
    if ([phase isEqual:@"CAN"] || [phase isEqual:@"CANCEL"] || [phase isEqual:@"CANCELLED"] || [status isEqual:@"C"])
        return @[];
    NSString *identifier = XMLNodeText(XMLFirstDescendant(amoc, @"identifier"));
    NSXMLNode *source = XMLFirstDescendant(amoc, @"source");
    NSString *region = XMLNodeText(XMLFirstDescendant(source, @"region"));
    NSString *state = WarningStateFromRegionOrIdentifier(region, identifier);
    NSString *title = XMLTextOfType(info, @"warning_title");
    if (!title.length) title = XMLTextOfType(info, @"title");
    if (!title.length) return @[];
    NSString *shortTitle = title;
    NSRange summary = [shortTitle rangeOfString:@" summary" options:NSCaseInsensitiveSearch];
    if (summary.location != NSNotFound) shortTitle = [shortTitle substringToIndex:summary.location];
    if (region.length && ![title.lowercaseString containsString:region.lowercaseString])
        title = [NSString stringWithFormat:@"%@ for %@", title, region];
    NSMutableArray *parts = [NSMutableArray array];
    for (NSString *type in @[@"warning_area_summary", @"warning_phenomena_summary", @"warning_summary", @"warning_advice"]) {
        NSString *rawPart = [type isEqual:@"warning_summary"]
            ? XMLNodeText(XMLFirstDescendant(document.rootElement, @"warning-summary"))
            : XMLTextOfType(document.rootElement, type);
        NSString *part = PlainTextFromHTML(rawPart);
        if (part.length && ![parts containsObject:part]) [parts addObject:part];
    }
    NSString *body = CleanWarningText([parts componentsJoinedByString:@"\n"]);
    NSDate *issue = ISODate(XMLNodeText(XMLFirstDescendant(amoc, @"issue-time-utc")));
    NSDate *expiry = ISODate(XMLNodeText(XMLFirstDescendant(amoc, @"expiry-time")));
    return @[@{
        @"id": identifier ?: @"", @"title": title, @"shortTitle": shortTitle,
        @"text": body ?: @"", @"state": state ?: @"", @"phase": phase ?: @"",
        @"issue": issue ?: NSNull.null, @"expiry": expiry ?: NSNull.null,
        @"expires": expiry ?: NSNull.null,
    }];
}

NSArray<NSDictionary *> *ParseWarningXML(NSData *xml) {
    if (!xml.length) return @[];
    NSString *text = [[NSString alloc] initWithData:xml encoding:NSUTF8StringEncoding];
    if (!text) text = [[NSString alloc] initWithData:xml encoding:NSISOLatin1StringEncoding];
    if (!text.length) return @[];
    if ([text rangeOfString:@"<product" options:NSCaseInsensitiveSearch].location != NSNotFound)
        return ParseBureauProductWarningXML(xml);
    NSRegularExpression *blocks = [NSRegularExpression regularExpressionWithPattern:
        @"(?i)<warning\\b[^>]*>(.*?)</warning>"
        options:NSRegularExpressionDotMatchesLineSeparators error:nil];
    NSArray *hits = [blocks matchesInString:text options:0 range:NSMakeRange(0, text.length)];
    NSMutableArray *out = [NSMutableArray array];
    for (NSTextCheckingResult *hit in hits) {
        if (hit.numberOfRanges < 2) continue;
        NSString *block = [text substringWithRange:[hit rangeAtIndex:1]];
        NSString *phase = XMLTagText(block, @"phase").lowercaseString;
        if ([phase isEqual:@"cancelled"] || [phase isEqual:@"cancel"] || [phase isEqual:@"ended"]) continue;
        NSString *title = XMLTagText(block, @"title");
        if (!title.length) title = XMLTagText(block, @"headline");
        if (!title.length) continue;
        NSString *shortTitle = XMLTagText(block, @"short_title");
        if (!shortTitle.length) shortTitle = XMLTagText(block, @"short-title");
        NSString *body = XMLTagText(block, @"text");
        if (!body.length) body = XMLTagText(block, @"description");
        body = CleanWarningText(PlainTextFromHTML(body));
        [out addObject:@{
            @"id": XMLTagText(block, @"id"),
            @"title": title,
            @"shortTitle": shortTitle.length ? shortTitle : title,
            @"text": body ?: @"",
            @"state": XMLTagText(block, @"state"),
        }];
    }
    return out;
}

NSDictionary *StoreRainObservation(NSData *json) {
    NSDictionary *root = JSONObject(json);
    NSDictionary *obs = [root[@"observations"] isKindOfClass:NSDictionary.class] ? root[@"observations"] : nil;
    NSArray *data = JSONArray(obs[@"data"]);
    for (NSDictionary *row in data) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSNumber *lat = Num(row[@"lat"]);
        NSNumber *lon = Num(row[@"lon"]);
        if (!lat || !lon) continue;
        id rain = row[@"rain_trace"];
        if ([rain isKindOfClass:NSString.class] && (![rain length] || [rain isEqual:@"-"] || [rain isEqual:@"—"]))
            continue;
        NSNumber *mm = Num(rain);
        if (!mm) continue;
        return @{@"lat": lat, @"lon": lon, @"mm": mm};
    }
    return nil;
}

static NSNumber *KnotsNumber(NSNumber *kt, NSNumber *kmh) {
    if (kt) return kt;
    if (kmh) return @(KnotsFromKmh(kmh.doubleValue));
    return nil;
}

NSArray<NSDictionary *> *StorePointSeries(NSData *json) {
    NSArray *hours = JSONArray(JSONObject(json)[@"hourly"]);
    if (!hours) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *hour in hours) {
        if (![hour isKindOfClass:NSDictionary.class]) continue;
        NSDate *time = ISODate(hour[@"time"]);
        if (!time) continue;
        NSDictionary *wind = [hour[@"wind"] isKindOfClass:NSDictionary.class] ? hour[@"wind"] : nil;
        NSString *dir = [hour[@"wind_direction"] isKindOfClass:NSString.class] ? hour[@"wind_direction"] : @"";
        if (!dir.length && [wind[@"direction"] isKindOfClass:NSString.class]) dir = wind[@"direction"];
        NSNumber *speed = Num(hour[@"wind_speed_kmh"]);
        if (!speed) speed = Num(wind[@"speed_kilometre"]);
        NSNumber *gust = Num(hour[@"wind_gust_kmh"]) ?: Num(hour[@"gust_kmh"]);
        NSNumber *press = Num(hour[@"pressure_msl"]) ?: Num(hour[@"press_msl"]);
        NSNumber *windKt = KnotsNumber(Num(hour[@"wind_speed_kt"]) ?: Num(hour[@"wind_spd_kt"]), speed);
        NSNumber *gustKt = KnotsNumber(Num(hour[@"wind_gust_kt"]) ?: Num(hour[@"gust_kt"]), gust);
        NSNumber *from = Num(hour[@"wind_from"]);
        if (!from || !isfinite(from.doubleValue) || from.doubleValue < 0 || from.doubleValue > 360) {
            double degrees = 0;
            from = WindFromDegrees(dir, &degrees) ? @(degrees) : nil;
        }
        NSNumber *rain = Num(hour[@"rain_mm"]) ?: Num(hour[@"rainMm"]);
        if (!rain && [hour[@"rain"] isKindOfClass:NSNumber.class]) rain = hour[@"rain"];
        [out addObject:@{
            @"time": time,
            @"temp": Num(hour[@"temp"]) ?: NSNull.null,
            @"windDir": dir ?: @"",
            @"windKmh": speed ?: NSNull.null,
            @"gustKmh": gust ?: NSNull.null,
            @"windKt": windKt ?: NSNull.null,
            @"gustKt": gustKt ?: NSNull.null,
            @"pressMsl": press ?: NSNull.null,
            @"airTemp": Num(hour[@"temp"]) ?: NSNull.null,
            @"rainMm": rain ?: NSNull.null,
            @"weatherCode": Num(hour[@"weather_code"]) ?: Num(hour[@"weatherCode"]) ?: NSNull.null,
            @"t850": Num(hour[@"t850"]) ?: NSNull.null,
            @"cloudBaseFt": Num(hour[@"cloud_base_ft"]) ?: Num(hour[@"cloudBaseFt"]) ?: NSNull.null,
            @"visibilityM": Num(hour[@"visibility_m"]) ?: Num(hour[@"visibilityM"]) ?: NSNull.null,
            @"windFrom": from ?: NSNull.null,
            @"isDay": Num(hour[@"is_day"]) ?: NSNull.null,
        }];
    }
    [out sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"time"] compare:b[@"time"]];
    }];
    return out;
}

NSDate *WeatherInstant(NSString *text) {
    if (![text isKindOfClass:NSString.class] || text.length < 16) return nil;
    NSRange tee = [text rangeOfString:@"T"];
    if (tee.location == NSNotFound || tee.location < 8) return nil;
    NSString *rest = [text substringFromIndex:tee.location + 1];
    NSRange plus = [rest rangeOfString:@"+"];
    NSRange minus = [rest rangeOfString:@"-"];
    BOOL zulu = [text hasSuffix:@"Z"] || [text hasSuffix:@"z"];
    BOOL offset = plus.location != NSNotFound || minus.location != NSNotFound;
    NSString *s = text;
    if (!zulu && !offset) {
        if (text.length == 16) s = [text stringByAppendingString:@":00Z"];
        else if (text.length == 19) s = [text stringByAppendingString:@"Z"];
        else return nil;
    } else if (offset) {
        NSUInteger sign = plus.location != NSNotFound ? plus.location : minus.location;
        NSString *clock = [rest substringToIndex:sign];
        if (clock.length == 5)
            s = [NSString stringWithFormat:@"%@%@:00%@", [text substringToIndex:tee.location + 1], clock, [rest substringFromIndex:sign]];
    } else if (text.length == 17)
        s = [[text substringToIndex:16] stringByAppendingString:@":00Z"];
    NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    formatter.timeZone = [NSTimeZone timeZoneWithName:@"GMT"];
    return [formatter dateFromString:s];
}

static id DayNumber(NSArray *values, NSUInteger index) {
    if (![values isKindOfClass:NSArray.class] || index >= values.count) return NSNull.null;
    id value = values[index];
    if ([value isKindOfClass:NSNumber.class] && isfinite([(NSNumber *)value doubleValue])) return value;
    return NSNull.null;
}

static NSDate *LocalCalendarDay(NSString *text, NSCalendar *calendar) {
    if (![text isKindOfClass:NSString.class] || text.length < 10) return nil;
    if ([text characterAtIndex:4] != '-' || [text characterAtIndex:7] != '-') return nil;
    NSInteger year = [[text substringWithRange:NSMakeRange(0, 4)] integerValue];
    NSInteger month = [[text substringWithRange:NSMakeRange(5, 2)] integerValue];
    NSInteger day = [[text substringWithRange:NSMakeRange(8, 2)] integerValue];
    if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return nil;
    NSDateComponents *parts = [NSDateComponents new];
    parts.year = year; parts.month = month; parts.day = day;
    NSDate *date = [calendar dateFromComponents:parts];
    if (!date) return nil;
    NSDateComponents *back = [calendar components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay fromDate:date];
    if (back.year != year || back.month != month || back.day != day) return nil;
    return date;
}

NSString *WeatherCodeSymbol(NSInteger code, BOOL day) {
    switch (code) {
        case 0: return day ? @"sun.max" : @"moon.stars";
        case 1: return day ? @"sun.min" : @"moon.stars";
        case 2: return day ? @"cloud.sun" : @"cloud.moon";
        case 3: return @"cloud";
        case 45: case 48: return @"cloud.fog";
        case 51: case 53: case 55: case 56: case 57: return @"cloud.drizzle";
        case 61: case 63: case 66: case 67: case 81: return @"cloud.rain";
        case 65: case 82: return @"cloud.heavyrain";
        case 71: case 73: case 75: case 77: case 85: case 86: return @"cloud.snow";
        case 80: return day ? @"cloud.sun.rain" : @"cloud.moon.rain";
        case 95: case 96: case 99: return @"cloud.bolt.rain";
        default: return nil;
    }
}

NSString *WeatherCodeLabel(NSInteger code) {
    switch (code) {
        case 0: return @"Clear";
        case 1: return @"Mostly clear";
        case 2: return @"Partly cloudy";
        case 3: return @"Cloudy";
        case 45: case 48: return @"Fog";
        case 51: case 53: case 55: return @"Drizzle";
        case 56: case 57: return @"Freezing drizzle";
        case 61: case 63: case 81: return @"Rain";
        case 65: case 82: return @"Heavy rain";
        case 66: case 67: return @"Freezing rain";
        case 71: case 73: case 75: case 77: return @"Snow";
        case 80: return @"Showers";
        case 85: case 86: return @"Snow showers";
        case 95: case 96: case 99: return @"Thunderstorm";
        default: return nil;
    }
}

NSArray<NSDictionary *> *StorePointDays(NSData *json, NSDate *now, NSInteger limit, NSTimeZone *placeZone) {
    if (limit <= 0) return @[];
    NSDictionary *root = JSONObject(json);
    NSDictionary *daily = [root[@"daily"] isKindOfClass:NSDictionary.class] ? root[@"daily"] : nil;
    NSArray *dates = JSONArray(daily[@"time"]);
    if (!dates.count) return @[];
    NSString *zoneName = [root[@"timezone"] isKindOfClass:NSString.class] ? root[@"timezone"] : nil;
    NSTimeZone *zone = zoneName.length ? [NSTimeZone timeZoneWithName:zoneName] : nil;
    if (!zone) zone = placeZone;
    if (!zone) zone = [NSTimeZone timeZoneWithName:@"GMT"];
    NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone;
    NSDate *today = now ? [calendar startOfDayForDate:now] : nil;
    NSDateFormatter *weekday = [NSDateFormatter new];
    weekday.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    weekday.timeZone = zone;
    weekday.dateFormat = @"EEE";
    NSMutableArray *out = [NSMutableArray array];
    for (NSUInteger i = 0; i < dates.count; i++) {
        NSDate *date = LocalCalendarDay(dates[i], calendar);
        if (!date) continue;
        if (today && [date compare:today] == NSOrderedAscending) continue;
        NSString *label = [weekday stringFromDate:date] ?: @"";
        if (now && [calendar isDate:date inSameDayAsDate:now]) label = @"Today";
        [out addObject:@{
            @"date": date,
            @"weekday": label,
            @"min": DayNumber(daily[@"temperature_2m_min"], i),
            @"max": DayNumber(daily[@"temperature_2m_max"], i),
            @"rainMm": DayNumber(daily[@"precipitation_sum"], i),
            @"rainHours": DayNumber(daily[@"precipitation_hours"], i),
            @"weatherCode": DayNumber(daily[@"weather_code"], i),
            @"gust": DayNumber(daily[@"wind_gusts_10m_max"], i),
            @"windDir": DayNumber(daily[@"wind_direction_10m_dominant"], i),
        }];
        if ((NSInteger)out.count == limit) break;
    }
    return out;
}

NSArray<NSDictionary *> *StorePointHours(NSData *json, NSDate *now, NSInteger limit) {
    if (limit <= 0) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *hour in StorePointSeries(json)) {
        NSDate *time = hour[@"time"];
        if (now && [time compare:now] == NSOrderedAscending) continue;
        [out addObject:@{
            @"time": time,
            @"temp": hour[@"temp"] ?: NSNull.null,
            @"rainChance": NSNull.null,
            @"windDir": hour[@"windDir"] ?: @"",
            @"windKmh": hour[@"windKmh"] ?: NSNull.null,
            @"windKt": hour[@"windKt"] ?: NSNull.null,
            @"gustKt": hour[@"gustKt"] ?: NSNull.null,
            @"pressMsl": hour[@"pressMsl"] ?: NSNull.null,
            @"iconDescriptor": @"",
            @"isNight": @NO,
        }];
        if ((NSInteger)out.count == limit) break;
    }
    return out;
}

static double Wrap360(double degrees) {
    double d = fmod(degrees, 360.0);
    if (d < 0) d += 360.0;
    return d;
}

static double AngleBetween(double a, double b) {
    double d = Wrap360(a - b);
    if (d > 180.0) d = 360.0 - d;
    return d;
}

BOOL WindFromDegrees(NSString *compass, double *degrees) {
    if (degrees) *degrees = 0;
    if (![compass isKindOfClass:NSString.class]) return NO;
    NSString *key = compass.uppercaseString;
    NSDictionary *table = @{
        @"N": @0, @"NNE": @22.5, @"NE": @45, @"ENE": @67.5,
        @"E": @90, @"ESE": @112.5, @"SE": @135, @"SSE": @157.5,
        @"S": @180, @"SSW": @202.5, @"SW": @225, @"WSW": @247.5,
        @"W": @270, @"WNW": @292.5, @"NW": @315, @"NNW": @337.5,
    };
    NSNumber *hit = table[key];
    if (!hit) return NO;
    if (degrees) *degrees = hit.doubleValue;
    return YES;
}

double WindToDegrees(double fromDegrees) {
    return Wrap360(fromDegrees + 180.0);
}

static NSString *KnotText(double knots) {
    return [NSString stringWithFormat:@"%.0f", round(knots)];
}

NSString *WindGlanceLabel(NSString *compass, double speedKt, double gustKt, BOOL hasWind, BOOL hasGust) {
    if (!hasWind) return @"—";
    double from = 0;
    BOOL pointed = WindFromDegrees(compass, &from);
    if (!pointed || speedKt < 0.5) return @"Calm";
    NSString *dir = compass.uppercaseString;
    if (hasGust && gustKt > speedKt + 0.5)
        return [NSString stringWithFormat:@"%@ %@ kt, gusts %@", dir, KnotText(speedKt), KnotText(gustKt)];
    return [NSString stringWithFormat:@"%@ %@ kt", dir, KnotText(speedKt)];
}

NSString *PressureGlanceLabel(double hPa) {
    if (!isfinite(hPa) || hPa < 900 || hPa > 1100) return @"—";
    return [NSString stringWithFormat:@"%.0f hPa", round(hPa)];
}

NSString *PressureTrendLabel(double deltaHPa, double hours, BOOL known) {
    if (!known || !isfinite(deltaHPa)) return @"—";
    if (fabs(deltaHPa) < 0.05) return @"steady";
    int span = (int)lround(hours);
    if (span < 1) span = 3;
    NSString *word = deltaHPa > 0 ? @"rising" : @"falling";
    return [NSString stringWithFormat:@"%@ %.1f/%dh", word, fabs(deltaHPa), span];
}

int PressureTrendSign(double deltaHPa, BOOL known) {
    if (!known || !isfinite(deltaHPa) || fabs(deltaHPa) < 0.05) return 0;
    return deltaHPa > 0 ? 1 : -1;
}

static double SpeedSpan(double knots) {
    double t = knots <= 0 ? 0 : pow(fmin(knots / 32.0, 1.0), 0.62);
    return 0.34 + 0.62 * t;
}

WindArrow WindArrowLayout(double toDegrees, double speedKt, double gustKt, BOOL hasWind, BOOL hasGust) {
    WindArrow arrow = {0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.6, NO, YES};
    if (!hasWind || speedKt < 0.5) return arrow;
    double rad = Wrap360(toDegrees) * M_PI / 180.0;
    double dx = sin(rad);
    double dy = -cos(rad);
    double meanSpan = SpeedSpan(speedKt);
    double gustSpan = hasGust ? SpeedSpan(fmax(gustKt, speedKt)) : meanSpan;
    if (hasGust && gustKt > speedKt + 3.0) gustSpan = fmax(gustSpan, meanSpan + 0.22);
    double cx = 0.50, cy = 0.50;
    arrow.calm = NO;
    arrow.tailX = cx - dx * meanSpan * 0.42;
    arrow.tailY = cy - dy * meanSpan * 0.42;
    arrow.headX = cx + dx * meanSpan * 0.58;
    arrow.headY = cy + dy * meanSpan * 0.58;
    arrow.hasGust = hasGust && gustSpan > meanSpan + 0.04;
    arrow.gustX = arrow.hasGust ? cx + dx * gustSpan * 0.58 : arrow.headX;
    arrow.gustY = arrow.hasGust ? cy + dy * gustSpan * 0.58 : arrow.headY;
    double weightT = pow(fmin(fmax(speedKt, 0) / 32.0, 1.0), 0.75);
    arrow.weight = 2.15 + 2.5 * weightT;
    return arrow;
}

NSString *WindShoreName(double toDegrees, double shoreNormalDeg, BOOL hasWind) {
    if (!hasWind) return @"";
    if (AngleBetween(toDegrees, shoreNormalDeg) <= 60.0) return @"offshore";
    if (AngleBetween(toDegrees, shoreNormalDeg + 180.0) <= 60.0) return @"onshore";
    return @"cross";
}

BOOL WindIsOffshore(double toDegrees, double shoreNormalDeg, BOOL hasWind) {
    return [WindShoreName(toDegrees, shoreNormalDeg, hasWind) isEqual:@"offshore"];
}

BOOL HourIsRideable(double speedKt, BOOL hasWind, double toDegrees, double minKt, double maxKt,
    double shoreNormalDeg, BOOL hasShore) {
    if (!hasWind || speedKt < minKt || speedKt > maxKt) return NO;
    if (hasShore && WindIsOffshore(toDegrees, shoreNormalDeg, YES)) return NO;
    return YES;
}

static NSDictionary *HistoryRow(NSDictionary *row, NSTimeZone *tz) {
    NSString *stamp = [row[@"local_date_time_full"] isKindOfClass:NSString.class] ? row[@"local_date_time_full"] : nil;
    NSDate *time = CivilTime(stamp, tz);
    if (!time) return nil;
    NSString *dir = [row[@"wind_dir"] isKindOfClass:NSString.class] ? row[@"wind_dir"] : @"";
    if ([dir isEqual:@"-"]) dir = @"";
    NSNumber *windKmh = Num(row[@"wind_spd_kmh"]);
    NSNumber *gustKmh = Num(row[@"gust_kmh"]);
    NSNumber *windKt = KnotsNumber(Num(row[@"wind_spd_kt"]), windKmh);
    NSNumber *gustKt = KnotsNumber(Num(row[@"gust_kt"]), gustKmh);
    return @{
        @"time": time,
        @"airTemp": Num(row[@"air_temp"]) ?: NSNull.null,
        @"windDir": dir,
        @"windKmh": windKmh ?: NSNull.null,
        @"gustKmh": gustKmh ?: NSNull.null,
        @"windKt": windKt ?: NSNull.null,
        @"gustKt": gustKt ?: NSNull.null,
        @"pressMsl": Num(row[@"press_msl"]) ?: NSNull.null,
    };
}

NSArray<NSDictionary *> *ObservationHistory(NSData *json) {
    NSDictionary *root = JSONObject(json);
    NSDictionary *obs = [root[@"observations"] isKindOfClass:NSDictionary.class] ? root[@"observations"] : nil;
    NSArray *data = JSONArray(obs[@"data"]);
    if (!data) return @[];
    NSTimeZone *tz = TimeZoneForStateCode(ObservationStateCode(obs));
    if (!tz) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *row in data) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *sample = HistoryRow(row, tz);
        if (sample) [out addObject:sample];
    }
    [out sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"time"] compare:b[@"time"]];
    }];
    return out;
}

NSArray<NSDictionary *> *ObservationHistoryWithPressure(NSArray<NSDictionary *> *primary, NSArray<NSDictionary *> *pressure) {
    if (![primary isKindOfClass:NSArray.class]) return @[];
    if (![pressure isKindOfClass:NSArray.class] || !pressure.count) return primary;
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *row in primary) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        if ([row[@"pressMsl"] isKindOfClass:NSNumber.class] || ![row[@"time"] isKindOfClass:NSDate.class]) {
            [out addObject:row];
            continue;
        }
        NSDate *time = row[@"time"];
        NSDictionary *best = nil;
        double bestDt = 46 * 60;
        for (NSDictionary *other in pressure) {
            if (![other[@"pressMsl"] isKindOfClass:NSNumber.class]) continue;
            if (![other[@"time"] isKindOfClass:NSDate.class]) continue;
            double dt = fabs([time timeIntervalSinceDate:other[@"time"]]);
            if (dt < bestDt) { bestDt = dt; best = other; }
        }
        if (!best) { [out addObject:row]; continue; }
        NSMutableDictionary *copy = [row mutableCopy];
        copy[@"pressMsl"] = best[@"pressMsl"];
        [out addObject:copy];
    }
    return out;
}

static double HourOffset(NSDate *time, NSDate *now) {
    if (![time isKindOfClass:NSDate.class] || !now) return NAN;
    return [time timeIntervalSinceDate:now] / 3600.0;
}

static BOOL HourInside(double hour, double lo, double hi, BOOL future) {
    if (!isfinite(hour) || hour < lo || hour > hi) return NO;
    if (future) return hour > 0;
    return hour <= 0.02;
}

NSDictionary *PressureSpark(NSArray<NSDictionary *> *history, NSArray<NSDictionary *> *forecast, NSDate *now) {
    NSMutableArray *observed = [NSMutableArray array];
    NSMutableArray *ahead = [NSMutableArray array];
    void (^take)(NSArray *, BOOL) = ^(NSArray *rows, BOOL future) {
        for (NSDictionary *row in rows) {
            if (![row isKindOfClass:NSDictionary.class]) continue;
            if (![row[@"pressMsl"] isKindOfClass:NSNumber.class]) continue;
            double hour = HourOffset(row[@"time"], now);
            if (!HourInside(hour, future ? 0 : -24, future ? 24 : 0.02, future)) continue;
            NSDictionary *pt = @{@"h": @(hour), @"v": row[@"pressMsl"]};
            if (future) [ahead addObject:pt];
            else [observed addObject:pt];
        }
    };
    take(history, NO);
    take(forecast, YES);
    double lo = 1e9, hi = -1e9;
    BOOL any = NO;
    for (NSDictionary *pt in [observed arrayByAddingObjectsFromArray:ahead]) {
        double v = [pt[@"v"] doubleValue];
        if (!any || v < lo) lo = v;
        if (!any || v > hi) hi = v;
        any = YES;
    }
    return @{
        @"observed": observed,
        @"forecast": ahead,
        @"min": any ? @(lo) : NSNull.null,
        @"max": any ? @(hi) : NSNull.null,
    };
}

static NSDictionary *WindPoint(NSDictionary *row, double hour) {
    if (![row[@"windKt"] isKindOfClass:NSNumber.class]) return nil;
    id gust = [row[@"gustKt"] isKindOfClass:NSNumber.class] ? row[@"gustKt"] : NSNull.null;
    return @{@"h": @(hour), @"s": row[@"windKt"], @"g": gust};
}

NSDictionary *WindSpark(NSArray<NSDictionary *> *history, NSArray<NSDictionary *> *forecast, NSDate *now) {
    NSMutableArray *observed = [NSMutableArray array];
    NSMutableArray *ahead = [NSMutableArray array];
    NSMutableArray *pool = [NSMutableArray array];
    void (^take)(NSArray *, BOOL) = ^(NSArray *rows, BOOL future) {
        for (NSDictionary *row in rows) {
            if (![row isKindOfClass:NSDictionary.class]) continue;
            double hour = HourOffset(row[@"time"], now);
            [pool addObject:@{@"row": row, @"h": @(hour)}];
            if (!HourInside(hour, future ? 0 : -12, future ? 12 : 0.02, future)) continue;
            NSDictionary *pt = WindPoint(row, hour);
            if (!pt) continue;
            if (future) [ahead addObject:pt];
            else [observed addObject:pt];
        }
    };
    take(history, NO);
    take(forecast, YES);
    NSMutableArray *ticks = [NSMutableArray array];
    for (int step = -12; step <= 12; step += 3) {
        double best = 1.6;
        double to = 0;
        BOOL found = NO;
        for (NSDictionary *item in pool) {
            NSDictionary *row = item[@"row"];
            double from = 0;
            if (!WindFromDegrees(row[@"windDir"], &from)) continue;
            double hour = [item[@"h"] doubleValue];
            if (!isfinite(hour)) continue;
            double dist = fabs(hour - step);
            if (dist < best) { best = dist; to = WindToDegrees(from); found = YES; }
        }
        if (found) [ticks addObject:@{@"h": @(step), @"to": @(to)}];
    }
    return @{@"observed": observed, @"forecast": ahead, @"ticks": ticks};
}

NSArray<NSDictionary *> *RideableWindow(NSArray<NSDictionary *> *forecast, NSDate *now,
    double minKt, double maxKt, double shoreNormalDeg, BOOL hasShore) {
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *row in forecast) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        double hour = HourOffset(row[@"time"], now);
        if (!isfinite(hour) || hour <= 0 || hour > 24) continue;
        double from = 0;
        BOOL hasWind = WindFromDegrees(row[@"windDir"], &from);
        double speed = [row[@"windKt"] isKindOfClass:NSNumber.class] ? [row[@"windKt"] doubleValue] : 0;
        BOOL daylight = ![row[@"isDay"] isKindOfClass:NSNumber.class] || [row[@"isDay"] boolValue];
        BOOL on = daylight && HourIsRideable(speed, hasWind, hasWind ? WindToDegrees(from) : 0, minKt, maxKt, shoreNormalDeg, hasShore);
        [out addObject:@{@"h": @(hour), @"on": @(on)}];
    }
    return out;
}

static NSDictionary *KiteSpot(NSDictionary *spot) {
    if (![spot isKindOfClass:NSDictionary.class]) return nil;
    NSString *hash = [spot[@"geohash"] isKindOfClass:NSString.class] ? spot[@"geohash"] : @"";
    NSString *name = [spot[@"name"] isKindOfClass:NSString.class] ? spot[@"name"] : @"";
    NSNumber *shore = Num(spot[@"shoreNormal"]);
    NSNumber *lat = Num(spot[@"latitude"]) ?: Num(spot[@"lat"]);
    NSNumber *lon = Num(spot[@"longitude"]) ?: Num(spot[@"lon"]);
    if (hash.length < 6 || !name.length || !shore || !lat || !lon) return nil;
    return @{
        @"name": name,
        @"archiveID": [spot[@"archiveID"] isKindOfClass:NSString.class] ? spot[@"archiveID"] : @"",
        @"state": [spot[@"state"] isKindOfClass:NSString.class] ? spot[@"state"] : @"",
        @"geohash": hash,
        @"latitude": lat,
        @"longitude": lon,
        @"timezone": [spot[@"timezone"] isKindOfClass:NSString.class] ? spot[@"timezone"] : @"",
        @"stationName": [spot[@"stationName"] isKindOfClass:NSString.class] ? spot[@"stationName"] : name,
        @"stationWMO": spot[@"stationWMO"] ? [spot[@"stationWMO"] description] : @"",
        @"stationProduct": [spot[@"stationProduct"] isKindOfClass:NSString.class] ? spot[@"stationProduct"] : @"",
        @"shoreNormal": shore,
    };
}

NSDictionary *StoreKiteFile(NSData *json) {
    NSDictionary *root = JSONObject(json);
    double minKt = 15, maxKt = 30;
    if ([root[@"minKt"] isKindOfClass:NSNumber.class]) minKt = [root[@"minKt"] doubleValue];
    if ([root[@"maxKt"] isKindOfClass:NSNumber.class]) maxKt = [root[@"maxKt"] doubleValue];
    if (maxKt < minKt) { double swap = minKt; minKt = maxKt; maxKt = swap; }
    NSMutableArray *spots = [NSMutableArray array];
    for (NSDictionary *spot in JSONArray(root[@"spots"])) {
        NSDictionary *place = KiteSpot(spot);
        if (place) [spots addObject:place];
    }
    return @{@"minKt": @(minKt), @"maxKt": @(maxKt), @"spots": spots};
}

NSArray<NSDictionary *> *GlancePlaces(NSArray<NSDictionary *> *locations, NSArray<NSDictionary *> *spots, BOOL include) {
    NSMutableArray *out = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (NSDictionary *place in locations) {
        if (![place isKindOfClass:NSDictionary.class]) continue;
        [out addObject:place];
        NSString *hash = [place[@"geohash"] isKindOfClass:NSString.class] ? place[@"geohash"] : @"";
        if (hash.length) [seen addObject:hash];
    }
    if (!include) return out;
    for (NSDictionary *spot in spots) {
        if (![spot isKindOfClass:NSDictionary.class]) continue;
        NSString *hash = [spot[@"geohash"] isKindOfClass:NSString.class] ? spot[@"geohash"] : @"";
        if (hash.length < 6 || [seen containsObject:hash]) continue;
        [seen addObject:hash];
        [out addObject:spot];
    }
    return out;
}

NSArray<NSDictionary *> *WarningTags(NSArray<NSDictionary *> *warnings) {
    if (![warnings isKindOfClass:NSArray.class]) return @[];
    NSMutableArray *out = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (NSDictionary *warning in warnings) {
        if (![warning isKindOfClass:NSDictionary.class]) continue;
        NSString *title = [warning[@"shortTitle"] length] ? warning[@"shortTitle"] : warning[@"title"];
        if (![title isKindOfClass:NSString.class] || !title.length) continue;
        NSString *key = title.lowercaseString;
        if ([seen containsObject:key]) continue;
        [seen addObject:key];
        NSString *full = [warning[@"text"] isKindOfClass:NSString.class] ? warning[@"text"] : @"";
        if (!full.length) full = [warning[@"title"] isKindOfClass:NSString.class] ? warning[@"title"] : title;
        [out addObject:@{@"title": WarningSentence(key), @"text": full}];
    }
    return out;
}

static NSDictionary *NewestSample(NSArray *rows) {
    NSDictionary *best = nil;
    for (NSDictionary *row in rows) {
        if (![row[@"time"] isKindOfClass:NSDate.class]) continue;
        if (!best || [row[@"time"] compare:best[@"time"]] == NSOrderedDescending) best = row;
    }
    return best;
}

NSDictionary *GlanceCardModel(NSString *name, NSDictionary *obs, NSArray<NSDictionary *> *history,
    NSArray<NSDictionary *> *forecast, NSDate *now, NSNumber *shoreNormal, double minKt, double maxKt,
    NSArray<NSDictionary *> *warnings, NSTimeZone *tz) {
    if (![obs isKindOfClass:NSDictionary.class]) obs = NewestSample(history);
    NSString *tempText = @"—";
    if ([obs[@"airTemp"] isKindOfClass:NSNumber.class])
        tempText = [NSString stringWithFormat:@"%.0f°", round([obs[@"airTemp"] doubleValue])];
    NSString *dir = [obs[@"windDir"] isKindOfClass:NSString.class] ? obs[@"windDir"] : @"";
    double from = 0;
    BOOL hasWind = WindFromDegrees(dir, &from);
    double speed = 0, gust = 0;
    if ([obs[@"windKt"] isKindOfClass:NSNumber.class]) speed = [obs[@"windKt"] doubleValue];
    else if ([obs[@"windKmh"] isKindOfClass:NSNumber.class]) speed = KnotsFromKmh([obs[@"windKmh"] doubleValue]);
    BOOL gustKnown = [obs[@"gustKt"] isKindOfClass:NSNumber.class] || [obs[@"gustKmh"] isKindOfClass:NSNumber.class];
    if ([obs[@"gustKt"] isKindOfClass:NSNumber.class]) gust = [obs[@"gustKt"] doubleValue];
    else if ([obs[@"gustKmh"] isKindOfClass:NSNumber.class]) gust = KnotsFromKmh([obs[@"gustKmh"] doubleValue]);
    BOOL hasGust = gustKnown && gust > speed + 0.5;
    if (hasWind && speed < 0.5) hasWind = NO;
    BOOL pressureKnown = [obs[@"pressMsl"] isKindOfClass:NSNumber.class];
    double pressure = pressureKnown ? [obs[@"pressMsl"] doubleValue] : 0;
    BOOL trendKnown = [obs[@"pressDelta"] isKindOfClass:NSNumber.class];
    double delta = trendKnown ? [obs[@"pressDelta"] doubleValue] : 0;
    double hours = [obs[@"pressHours"] isKindOfClass:NSNumber.class] ? [obs[@"pressHours"] doubleValue] : 3;
    BOOL shore = [shoreNormal isKindOfClass:NSNumber.class];
    double shoreDeg = shore ? shoreNormal.doubleValue : 0;
    if (!(minKt > 0) || !(maxKt > minKt)) { minKt = 15; maxKt = 30; }
    double to = hasWind ? WindToDegrees(from) : 0;
    NSString *shoreName = shore ? WindShoreName(to, shoreDeg, hasWind) : @"";
    NSTimeZone *zone = tz ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSMutableDictionary *pressureTrace = [PressureSpark(history, forecast, now) mutableCopy];
    NSMutableDictionary *windTrace = [WindSpark(history, forecast, now) mutableCopy];
    if (now) {
        pressureTrace[@"axisLeft"] = SituationPhrase([now dateByAddingTimeInterval:-24 * 3600.0], now, zone);
        pressureTrace[@"axisRight"] = SituationPhrase([now dateByAddingTimeInterval:24 * 3600.0], now, zone);
        windTrace[@"axisLeft"] = SituationPhrase([now dateByAddingTimeInterval:-12 * 3600.0], now, zone);
        windTrace[@"axisRight"] = SituationPhrase([now dateByAddingTimeInterval:12 * 3600.0], now, zone);
    }
    return @{
        @"name": name.length ? name : @"—",
        @"tempText": tempText,
        @"windLabel": WindGlanceLabel(dir, speed, gust, hasWind, hasGust),
        @"pressureText": pressureKnown ? PressureGlanceLabel(pressure) : @"—",
        @"trendText": PressureTrendLabel(delta, hours, trendKnown && pressureKnown),
        @"trendSign": @(PressureTrendSign(delta, trendKnown && pressureKnown)),
        @"fromDeg": hasWind ? @(from) : NSNull.null,
        @"toDeg": hasWind ? @(to) : NSNull.null,
        @"speedKt": @(speed),
        @"gustKt": @(gust),
        @"hasWind": @(hasWind),
        @"hasGust": @(hasGust),
        @"offshore": @([shoreName isEqual:@"offshore"]),
        @"shore": shoreName,
        @"shoreNormal": shore ? shoreNormal : NSNull.null,
        @"pressure": pressureTrace,
        @"wind": windTrace,
        @"ride": shore ? RideableWindow(forecast, now, minKt, maxKt, shoreDeg, YES) : @[],
        @"warnings": WarningTags(warnings),
    };
}

static double RowDouble(NSDictionary *row, NSString *key, BOOL *known) {
    id value = [row isKindOfClass:NSDictionary.class] ? row[key] : nil;
    if ([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue])) {
        if (known) *known = YES;
        return [value doubleValue];
    }
    if (known) *known = NO;
    return 0;
}

static BOOL RowWindFrom(NSDictionary *row, double *degrees) {
    BOOL known = NO;
    double given = RowDouble(row, @"windFrom", &known);
    if (known) {
        if (degrees) *degrees = given;
        return YES;
    }
    return WindFromDegrees([row[@"windDir"] isKindOfClass:NSString.class] ? row[@"windDir"] : nil, degrees);
}

static BOOL RowSpeed(NSDictionary *row, double *speed, double *gust) {
    BOOL known = NO;
    double kt = RowDouble(row, @"windKt", &known);
    if (!known) {
        double kmh = RowDouble(row, @"windKmh", &known);
        if (known) kt = KnotsFromKmh(kmh);
    }
    BOOL gustKnown = NO;
    double g = RowDouble(row, @"gustKt", &gustKnown);
    if (!gustKnown) {
        double gkmh = RowDouble(row, @"gustKmh", &gustKnown);
        if (gustKnown) g = KnotsFromKmh(gkmh);
    }
    if (speed) *speed = known ? kt : 0;
    if (gust) *gust = gustKnown ? g : NAN;
    return known || gustKnown;
}

static NSString *Compass8(double fromDeg) {
    static NSString *const names[] = {@"N", @"NE", @"E", @"SE", @"S", @"SW", @"W", @"NW"};
    int idx = (int)lround(Wrap360(fromDeg) / 45.0) % 8;
    if (idx < 0) idx += 8;
    return names[idx];
}

static NSString *PhraseInSentence(NSString *phrase) {
    if (!phrase.length || [phrase isEqual:@"Now"]) return @"now";
    if (phrase.length >= 4 && [phrase characterAtIndex:3] == ' ') return phrase;
    return [[[phrase substringToIndex:1] lowercaseString] stringByAppendingString:[phrase substringFromIndex:1]];
}

static NSArray *SeriesRows(NSArray *series) {
    if (![series isKindOfClass:NSArray.class]) return @[];
    NSMutableArray *rows = [NSMutableArray array];
    for (NSDictionary *row in series)
        if ([row isKindOfClass:NSDictionary.class] && [row[@"time"] isKindOfClass:NSDate.class])
            [rows addObject:row];
    [rows sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"time"] compare:b[@"time"]];
    }];
    return rows;
}

NSString *SituationHeadline(NSString *place, NSArray<NSDictionary *> *series, NSDate *now, NSTimeZone *tz) {
    if (!now) return @"";
    NSArray *rows = SeriesRows(series);
    if (!rows.count) return @"";
    NSTimeZone *zone = tz ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSCalendar *cal = SituationCalendar(zone);
    NSDate *horizon = [now dateByAddingTimeInterval:72 * 3600.0];
    NSDate *recent = [now dateByAddingTimeInterval:-30 * 60.0];
    BOOL (^ahead)(NSDate *) = ^BOOL(NSDate *time) {
        return [time compare:recent] != NSOrderedAscending && [time compare:horizon] != NSOrderedDescending;
    };
    NSDate *frontTime = nil;
    for (NSDictionary *row in rows) {
        NSDate *time = row[@"time"];
        if (!ahead(time)) continue;
        BOOL known = NO;
        double here = RowDouble(row, @"t850", &known);
        if (!known) continue;
        NSDictionary *best = nil;
        double bestDist = 100;
        for (NSDictionary *earlier in rows) {
            double hours = [time timeIntervalSinceDate:earlier[@"time"]] / 3600.0;
            if (hours < 6.0 || hours > 18.0) continue;
            BOOL earlierKnown = NO;
            RowDouble(earlier, @"t850", &earlierKnown);
            if (!earlierKnown) continue;
            double dist = fabs(hours - 12.0);
            if (dist < bestDist) { bestDist = dist; best = earlier; }
        }
        if (!best) continue;
        BOOL earlierKnown = NO;
        double was = RowDouble(best, @"t850", &earlierKnown);
        if (fabs(was - here) >= 4.0) { frontTime = time; break; }
    }
    if (!frontTime) {
        for (NSDictionary *row in rows) {
            NSDate *time = row[@"time"];
            if (!ahead(time)) continue;
            BOOL known = NO;
            double press = RowDouble(row, @"pressMsl", &known);
            if (!known) continue;
            double from = 0;
            if (!RowWindFrom(row, &from)) continue;
            NSDictionary *best = nil;
            double bestDist = 100;
            for (NSDictionary *earlier in rows) {
                double hours = [time timeIntervalSinceDate:earlier[@"time"]] / 3600.0;
                if (hours < 5.0 || hours > 8.0) continue;
                BOOL earlierKnown = NO;
                RowDouble(earlier, @"pressMsl", &earlierKnown);
                if (!earlierKnown) continue;
                double dist = fabs(hours - 6.0);
                if (dist < bestDist) { bestDist = dist; best = earlier; }
            }
            if (!best) continue;
            BOOL earlierKnown = NO;
            double was = RowDouble(best, @"pressMsl", &earlierKnown);
            if (was - press < 3.0) continue;
            double earlierFrom = 0;
            if (!RowWindFrom(best, &earlierFrom) || AngleBetween(from, earlierFrom) < 60.0) continue;
            frontTime = time;
            break;
        }
    }
    NSDictionary *peak = nil;
    double peakScore = -1;
    NSInteger aheadCount = 0;
    double maxSpeed = 0, maxGust = 0, minPress = 1e9;
    BOOL anyPress = NO, anyRain = NO;
    NSDate *rainTime = nil, *lastTime = nil;
    double sx = 0, sy = 0;
    NSMutableArray<NSNumber *> *directions = [NSMutableArray array];
    for (NSDictionary *row in rows) {
        NSDate *time = row[@"time"];
        if (!ahead(time)) continue;
        aheadCount++;
        lastTime = time;
        double speed = 0, gust = 0;
        BOOL hasWind = RowSpeed(row, &speed, &gust);
        if (hasWind && speed > maxSpeed) maxSpeed = speed;
        if (isfinite(gust) && gust > maxGust) maxGust = gust;
        double score = hasWind ? speed : 0;
        if (isfinite(gust) && gust > score) score = gust;
        if (score > peakScore) { peakScore = score; peak = row; }
        BOOL known = NO;
        double press = RowDouble(row, @"pressMsl", &known);
        if (known) { anyPress = YES; if (press < minPress) minPress = press; }
        double rain = RowDouble(row, @"rainMm", &known);
        if (known && rain >= 1.0 && !anyRain) { anyRain = YES; rainTime = time; }
        double from = 0;
        if (hasWind && speed >= 1.0 && RowWindFrom(row, &from)) {
            double rad = from * M_PI / 180.0;
            sx += sin(rad);
            sy += cos(rad);
            [directions addObject:@(from)];
        }
    }
    NSMutableArray *clauses = [NSMutableArray array];
    NSString *frontPhrase = frontTime ? SituationPhrase(frontTime, now, zone) : @"";
    if (frontTime) {
        NSString *who = place.length ? place : @"here";
        if ([frontPhrase isEqual:@"Now"])
            [clauses addObject:[NSString stringWithFormat:@"Front is at %@ now", who]];
        else
            [clauses addObject:[NSString stringWithFormat:@"Front reaches %@ %@", who, PhraseInSentence(frontPhrase)]];
    }
    if (peak) {
        double speed = 0, gust = 0;
        RowSpeed(peak, &speed, &gust);
        if (speed >= 20.0 || (isfinite(gust) && gust >= 30.0)) {
            double from = 0;
            NSString *dir = [peak[@"windDir"] isKindOfClass:NSString.class] ? [peak[@"windDir"] uppercaseString] : @"";
            if (!dir.length && RowWindFrom(peak, &from)) dir = Compass8(from);
            if (!dir.length) dir = @"Wind";
            int spd = (int)lround(speed);
            int gst = isfinite(gust) ? (int)lround(gust) : 0;
            BOOL showGust = isfinite(gust) && (gst >= 30 || (gst >= spd + 5 && gst >= 25));
            NSString *wind = showGust
                ? [NSString stringWithFormat:@"%@ %d kt, gusts %d", dir, spd, gst]
                : [NSString stringWithFormat:@"%@ %d kt", dir, spd];
            NSString *when = SituationPhrase(peak[@"time"], now, zone);
            if (!frontTime) {
                NSString *whenBit = when.length ? PhraseInSentence(when) : @"now";
                NSString *lead = place.length ? [NSString stringWithFormat:@"%@ %@", place, whenBit] : whenBit;
                if (!place.length && lead.length)
                    lead = [[[lead substringToIndex:1] uppercaseString] stringByAppendingString:[lead substringFromIndex:1]];
                [clauses addObject:[NSString stringWithFormat:@"%@: %@", lead, wind]];
            } else {
                NSString *body = wind;
                if (![when isEqual:frontPhrase]) {
                    if ([when isEqual:@"Now"]) body = [body stringByAppendingString:@" now"];
                    else if (when.length) body = [NSString stringWithFormat:@"%@ %@", body, PhraseInSentence(when)];
                }
                [clauses addObject:body];
            }
        }
    }
    if (rainTime) {
        NSString *when = SituationPhrase(rainTime, now, zone);
        [clauses addObject:[when isEqual:@"Now"] ? @"rain now"
            : [NSString stringWithFormat:@"rain from %@", PhraseInSentence(when)]];
    }
    if (clauses.count) return [clauses componentsJoinedByString:@" · "];
    if (aheadCount < 4 || maxSpeed >= 15.0 || maxGust >= 25.0 || anyRain) return @"";
    NSString *through = @"";
    if (lastTime) through = SituationWeekday(SituationAnchor(lastTime, cal), cal);
    BOOL steady = NO;
    NSString *dirName = @"";
    if (directions.count >= 3) {
        double mean = atan2(sx, sy) * 180.0 / M_PI;
        if (mean < 0) mean += 360.0;
        double worst = 0;
        for (NSNumber *direction in directions) {
            double ang = AngleBetween(direction.doubleValue, mean);
            if (ang > worst) worst = ang;
        }
        if (worst <= 50.0) { steady = YES; dirName = Compass8(mean); }
    }
    BOOL high = anyPress && minPress >= 1018.0;
    if (!through.length) return high ? @"Settled: high pressure, light winds" : @"Settled";
    if (high && steady)
        return [NSString stringWithFormat:@"Settled: high pressure, light %@ winds through %@", dirName, through];
    if (high)
        return [NSString stringWithFormat:@"Settled: high pressure, light winds through %@", through];
    if (steady)
        return [NSString stringWithFormat:@"Settled: light %@ winds through %@", dirName, through];
    return @"Settled";
}

NSString *MenuBarReading(NSDictionary *obs) {
    if (![obs isKindOfClass:NSDictionary.class]) return @"—";
    NSString *temp = @"—";
    if ([obs[@"airTemp"] isKindOfClass:NSNumber.class])
        temp = [NSString stringWithFormat:@"%.0f°", round([obs[@"airTemp"] doubleValue])];
    double from = 0;
    BOOL pointed = RowWindFrom(obs, &from);
    double speed = 0, gust = 0;
    BOOL hasSpeed = RowSpeed(obs, &speed, &gust);
    (void)gust;
    if (!pointed || !hasSpeed || speed < 0.5) {
        if (pointed && hasSpeed && speed < 0.5) return [NSString stringWithFormat:@"%@ calm", temp];
        return temp;
    }
    NSString *dir = [obs[@"windDir"] isKindOfClass:NSString.class] && [obs[@"windDir"] length]
        ? [obs[@"windDir"] uppercaseString] : Compass8(from);
    return [NSString stringWithFormat:@"%@ %@ %.0f", temp, dir, round(speed)];
}

NSString *ShoreFacingName(double degrees) {
    static NSString *const names[] = {
        @"north", @"northeast", @"east", @"southeast", @"south", @"southwest", @"west", @"northwest",
    };
    int idx = (int)lround(Wrap360(degrees) / 45.0) % 8;
    if (idx < 0) idx += 8;
    return names[idx];
}

static NSDictionary *RunwayPair(NSString *a, double ah, NSString *b, double bh) {
    return @{@"a": a, @"ah": @(ah), @"b": b, @"bh": @(bh)};
}

NSArray<NSDictionary *> *KnownAerodromes(void) {
    return @[
        @{@"code": @"YPPH", @"name": @"Perth Airport",
          @"latitude": @(-31.9403), @"longitude": @(115.967003), @"timeZone": @"Australia/Perth",
          @"runways": @[RunwayPair(@"03", 30, @"21", 210), RunwayPair(@"06", 60, @"24", 240)]},
        @{@"code": @"YSSY", @"name": @"Sydney Airport",
          @"latitude": @(-33.946), @"longitude": @(151.177), @"timeZone": @"Australia/Sydney",
          @"runways": @[RunwayPair(@"16", 160, @"34", 340), RunwayPair(@"07", 70, @"25", 250)]},
    ];
}

NSDictionary *AerodromeForCode(NSString *code) {
    for (NSDictionary *field in KnownAerodromes())
        if ([field[@"code"] caseInsensitiveCompare:code ?: @""] == NSOrderedSame) return field;
    return nil;
}

NSString *PrimaryAerodromeCode(NSString *state) {
    if (![state isKindOfClass:NSString.class]) return nil;
    NSDictionary *codes = @{
        @"NSW": @"YSSY", @"VIC": @"YMML", @"QLD": @"YBBN", @"SA": @"YPAD",
        @"WA": @"YPPH", @"TAS": @"YMHB", @"NT": @"YPDN", @"ACT": @"YSCB",
    };
    return codes[state.uppercaseString];
}

NSDictionary *AerodromeForState(NSString *state) {
    NSString *code = PrimaryAerodromeCode(state);
    if (!code) return nil;
    NSDictionary *known = AerodromeForCode(code);
    if (known) return known;
    // Runway headings are configured for YPPH and YSSY only. Other capitals
    // still name the aerodrome so METAR/TAF is not Perth's.
    NSDictionary *zones = @{
        @"YMML": @"Australia/Melbourne", @"YBBN": @"Australia/Brisbane",
        @"YPAD": @"Australia/Adelaide", @"YMHB": @"Australia/Hobart",
        @"YPDN": @"Australia/Darwin", @"YSCB": @"Australia/Sydney",
    };
    return @{@"code": code, @"name": code, @"timeZone": zones[code] ?: @"", @"runways": @[]};
}

static void ClockBits(NSDate *date, NSCalendar *cal, NSInteger *hour12, NSInteger *minute, BOOL *pm) {
    NSInteger hour = [cal component:NSCalendarUnitHour fromDate:date];
    NSInteger mins = [cal component:NSCalendarUnitMinute fromDate:date];
    NSInteger h = hour % 12;
    if (h == 0) h = 12;
    if (hour12) *hour12 = h;
    if (minute) *minute = mins;
    if (pm) *pm = hour >= 12;
}

static NSString *ClockOne(NSInteger hour12, NSInteger minute, BOOL pm) {
    NSString *suffix = pm ? @"pm" : @"am";
    if (minute == 0) return [NSString stringWithFormat:@"%ld %@", (long)hour12, suffix];
    return [NSString stringWithFormat:@"%ld:%02ld %@", (long)hour12, (long)minute, suffix];
}

static NSString *ClockSpan(NSDate *start, NSDate *end, NSCalendar *cal) {
    if (!start) return @"";
    if (!end || fabs([start timeIntervalSinceDate:end]) < 50) {
        NSInteger hour = 0, minute = 0; BOOL pm = NO;
        ClockBits(start, cal, &hour, &minute, &pm);
        return ClockOne(hour, minute, pm);
    }
    NSInteger h1 = 0, m1 = 0, h2 = 0, m2 = 0;
    BOOL pm1 = NO, pm2 = NO;
    ClockBits(start, cal, &h1, &m1, &pm1);
    ClockBits(end, cal, &h2, &m2, &pm2);
    if (pm1 == pm2) {
        NSString *left = m1 ? [NSString stringWithFormat:@"%ld:%02ld", (long)h1, (long)m1]
                            : [NSString stringWithFormat:@"%ld", (long)h1];
        NSString *right = m2 ? [NSString stringWithFormat:@"%ld:%02ld", (long)h2, (long)m2]
                             : [NSString stringWithFormat:@"%ld", (long)h2];
        return [NSString stringWithFormat:@"%@\u2013%@ %@", left, right, pm1 ? @"pm" : @"am"];
    }
    NSString *a = ClockOne(h1, m1, pm1);
    NSString *b = ClockOne(h2, m2, pm2);
    return [NSString stringWithFormat:@"%@\u2013%@", a, b];
}

static NSString *SpeedBand(NSString *dir, int lo, int hi) {
    if (lo > hi) { int swap = lo; lo = hi; hi = swap; }
    if (dir.length && lo == hi) return [NSString stringWithFormat:@"%@ %d kt", dir, lo];
    if (dir.length) return [NSString stringWithFormat:@"%@ %d\u2013%d kt", dir, lo, hi];
    if (lo == hi) return [NSString stringWithFormat:@"%d kt", lo];
    return [NSString stringWithFormat:@"%d\u2013%d kt", lo, hi];
}

static NSDictionary *BestKiteWindow(NSDictionary *spot, NSDate *now, NSCalendar *cal, double minKt, double maxKt) {
    NSArray *hours = SeriesRows(spot[@"hours"]);

    NSDate *horizon = [now dateByAddingTimeInterval:72 * 3600.0];
    double shore = [spot[@"shoreNormal"] doubleValue];
    BOOL hasShore = [spot[@"shoreNormal"] isKindOfClass:NSNumber.class];
    NSMutableArray<NSDictionary *> *on = [NSMutableArray array];
    for (NSDictionary *row in hours) {
        NSDate *time = row[@"time"];
        if ([time timeIntervalSinceDate:now] < -15 * 60 || [time compare:horizon] == NSOrderedDescending) continue;
        if ([row[@"isDay"] isKindOfClass:NSNumber.class] && ![row[@"isDay"] boolValue]) continue;
        double from = 0, speed = 0, gust = 0;
        BOOL pointed = RowWindFrom(row, &from);
        BOOL hasSpeed = RowSpeed(row, &speed, &gust);
        (void)gust;
        if (!HourIsRideable(speed, pointed && hasSpeed, pointed ? WindToDegrees(from) : 0,
                minKt, maxKt, shore, hasShore)) continue;
        NSString *dir = [row[@"windDir"] isKindOfClass:NSString.class] ? [row[@"windDir"] uppercaseString] : @"";
        if (!dir.length && pointed) dir = Compass8(from);
        [on addObject:@{@"time": time, @"speed": @(speed), @"dir": dir}];
    }
    if (!on.count) return nil;
    NSMutableArray *windows = [NSMutableArray array];
    NSMutableArray *current = [NSMutableArray array];
    for (NSDictionary *sample in on) {
        NSDate *prev = current.count ? current.lastObject[@"time"] : nil;
        if (prev && [sample[@"time"] timeIntervalSinceDate:prev] > 90 * 60) {
            [windows addObject:current];
            current = [NSMutableArray array];
        }
        [current addObject:sample];
    }
    if (current.count) [windows addObject:current];
    NSDictionary *best = nil;
    NSTimeInterval bestLength = -1;
    NSDate *bestStart = nil;
    for (NSArray *window in windows) {
        NSDate *end = window.lastObject[@"time"];
        if ([end compare:now] == NSOrderedAscending) continue;
        NSDate *start = window.firstObject[@"time"];
        NSTimeInterval length = [end timeIntervalSinceDate:start];
        NSComparisonResult dayOrder = best ? [[cal startOfDayForDate:start] compare:[cal startOfDayForDate:bestStart]] : NSOrderedAscending;
        if (best && (dayOrder == NSOrderedDescending || (dayOrder == NSOrderedSame &&
            (length < bestLength - 1 || (fabs(length - bestLength) <= 1 && [start compare:bestStart] != NSOrderedAscending))))) continue;
        double lo = 1e9, hi = -1;
        NSCountedSet *dirs = [NSCountedSet set];
        for (NSDictionary *sample in window) {
            double speed = [sample[@"speed"] doubleValue];
            if (speed < lo) lo = speed;
            if (speed > hi) hi = speed;
            if ([sample[@"dir"] length]) [dirs addObject:sample[@"dir"]];
        }
        NSString *dir = @"";
        NSUInteger dirCount = 0;
        for (NSString *name in dirs)
            if ([dirs countForObject:name] > dirCount) { dirCount = [dirs countForObject:name]; dir = name; }
        bestLength = length;
        bestStart = start;
        best = @{
            @"start": start, @"end": end,
            @"min": @((int)lround(lo)), @"max": @((int)lround(hi)), @"dir": dir,
        };
    }
    return best;
}

NSDictionary *KitePlan(NSArray<NSDictionary *> *spots, NSDate *now, NSTimeZone *tz, double minKt, double maxKt) {
    NSCalendar *cal = SituationCalendar(tz);
    if (!(minKt > 0) || !(maxKt > minKt)) { minKt = 15; maxKt = 30; }
    NSMutableString *detail = [NSMutableString string];
    NSDictionary *bestSpot = nil;
    NSDictionary *bestWindow = nil;
    NSInteger bestBucket = 9;
    NSTimeInterval bestLength = -1;
    if (now) {
        for (NSDictionary *spot in spots) {
            if (![spot isKindOfClass:NSDictionary.class]) continue;
            NSString *name = [spot[@"name"] isKindOfClass:NSString.class] ? spot[@"name"] : @"Spot";
            double shore = [spot[@"shoreNormal"] doubleValue];
            NSString *facing = [spot[@"shoreNormal"] isKindOfClass:NSNumber.class] ? ShoreFacingName(shore) : @"";
            NSDictionary *window = BestKiteWindow(spot, now, cal, minKt, maxKt);
            if (facing.length)
                [detail appendFormat:@"%@, shore faces %@\n", name, facing];
            else
                [detail appendFormat:@"%@\n", name];
            if (!window) {
                [detail appendString:@"No kite window in the available forecast\n"];
                continue;
            }
            NSString *span = ClockSpan(window[@"start"], window[@"end"], cal);
            NSString *band = SpeedBand(window[@"dir"], [window[@"min"] intValue], [window[@"max"] intValue]);
            NSDate *startDay = [cal startOfDayForDate:now];
            NSInteger days = [cal components:NSCalendarUnitDay fromDate:startDay toDate:[cal startOfDayForDate:window[@"start"]] options:0].day;
            NSString *when = days <= 0 ? @"Today" : days == 1 ? @"Tomorrow" : SituationWeekday(window[@"start"], cal);
            [detail appendFormat:@"%@ %@, %@\n", when, span, band];
            NSInteger bucket = days <= 0 ? 0 : days == 1 ? 1 : 2;
            NSTimeInterval length = [window[@"end"] timeIntervalSinceDate:window[@"start"]];
            if (!bestWindow || bucket < bestBucket || (bucket == bestBucket && length > bestLength + 1)) {
                bestBucket = bucket;
                bestLength = length;
                bestWindow = window;
                bestSpot = spot;
            }
        }
    }
    if (!bestWindow) {
        NSString *line = spots.count ? @"No kite window in forecast" : @"No kite spots set";
        return @{@"line": line, @"detail": detail};
    }
    NSString *name = bestSpot[@"name"] ?: @"Spot";
    NSString *span = ClockSpan(bestWindow[@"start"], bestWindow[@"end"], cal);
    NSString *band = SpeedBand(bestWindow[@"dir"], [bestWindow[@"min"] intValue], [bestWindow[@"max"] intValue]);
    NSString *line = nil;
    if (bestBucket == 0)
        line = [NSString stringWithFormat:@"%@: kiteable today %@ (%@)", name, span, band];
    else if (bestBucket == 1)
        line = [NSString stringWithFormat:@"%@: tomorrow %@ (%@)", name, span, band];
    else {
        NSString *day = SituationWeekday(bestWindow[@"start"], cal);
        line = [NSString stringWithFormat:@"%@: %@ %@ (%@)", name, day, span, band];
    }
    return @{@"line": line, @"detail": detail};
}

static void WindOnRunway(double fromDeg, double speed, double heading, double *cross, double *head) {
    double turn = (fromDeg - heading) * M_PI / 180.0;
    if (head) *head = speed * cos(turn);
    if (cross) *cross = fabs(speed * sin(turn));
}

NSDictionary *FlyPlan(NSArray<NSDictionary *> *hours, NSDate *now, NSTimeZone *tz, NSDictionary *aerodrome) {
    NSDictionary *field = aerodrome ?: AerodromeForCode(@"YPPH");
    NSString *name = [field[@"name"] isKindOfClass:NSString.class] ? field[@"name"] : @"the aerodrome";
    if (!now) return @{@"line": @"", @"detail": @""};
    NSCalendar *cal = SituationCalendar(tz);
    NSInteger hour = [cal component:NSCalendarUnitHour fromDate:now];
    int firstSlot = hour < 9 ? 0 : hour < 15 ? 1 : 2;
    NSArray *rows = SeriesRows(hours);
    NSDate *start = [cal startOfDayForDate:now];
    NSDictionary *sample = nil;
    int usedSlot = firstSlot;
    for (int slot = firstSlot; slot <= 3 && !sample; slot++) {
        NSDateComponents *add = [NSDateComponents new];
        add.day = slot >= 2 ? 1 : 0;
        add.hour = (slot % 2 == 0) ? 10 : 15;
        NSDate *target = [cal dateByAddingComponents:add toDate:start options:0];
        NSDictionary *nearest = nil;
        double nearestDt = 2.5 * 3600.0 + 1;
        for (NSDictionary *row in rows) {
            double dt = fabs([row[@"time"] timeIntervalSinceDate:target]);
            if (dt < nearestDt) { nearestDt = dt; nearest = row; }
        }
        if (nearest && nearestDt <= 2.5 * 3600.0) { sample = nearest; usedSlot = slot; }
    }
    NSArray *slotNames = @[@"This morning", @"This afternoon", @"Tomorrow morning", @"Tomorrow afternoon"];
    NSString *when = slotNames[MIN(usedSlot, 3)];
    if (!sample) {
        NSString *line = [NSString stringWithFormat:@"No wind forecast for %@", name];
        return @{@"line": line, @"detail": line};
    }
    double from = 0, speed = 0, gust = 0;
    BOOL pointed = RowWindFrom(sample, &from);
    BOOL hasWind = RowSpeed(sample, &speed, &gust);
    (void)gust;
    if (!hasWind || (!pointed && speed >= 2.0)) {
        NSString *line = [NSString stringWithFormat:@"No wind forecast for %@", name];
        return @{@"line": line, @"detail": line};
    }
    if (speed < 2.0) {
        NSString *line = [NSString stringWithFormat:@"%@: calm", when];
        return @{@"line": line, @"detail": [NSString stringWithFormat:@"%@ at %@: calm", when, name]};
    }
    int dir10 = (int)lround(Wrap360(from) / 10.0) * 10;
    if (dir10 <= 0 || dir10 >= 360) dir10 = 360;
    int spd = (int)lround(speed);
    NSString *bestEnd = @"";
    double bestHead = -1e9, bestCross = 0;
    NSMutableString *detail = [NSMutableString stringWithFormat:@"%@ at %@\nWind %03d° at %d kt\n", when, name, dir10, spd];
    NSMutableArray *runwayEnds = [NSMutableArray array];
    if ([field[@"ends"] isKindOfClass:NSArray.class]) [runwayEnds addObjectsFromArray:field[@"ends"]];
    else for (NSDictionary *pair in field[@"runways"]) {
        [runwayEnds addObjectsFromArray:@[@{@"id": pair[@"a"], @"hdg": pair[@"ah"]},
            @{@"id": pair[@"b"], @"hdg": pair[@"bh"]}]];
    }
    for (NSDictionary *end in runwayEnds) {
            double cross = 0, head = 0;
            WindOnRunway(from, speed, [end[@"hdg"] doubleValue], &cross, &head);
            NSString *along = head >= 0 ? @"headwind" : @"tailwind";
            [detail appendFormat:@"Runway %@: crosswind %d kt, %@ %d kt\n",
                end[@"id"], (int)lround(cross), along, (int)lround(fabs(head))];
            if (head > bestHead + 0.05 || (fabs(head - bestHead) <= 0.05 && cross < bestCross)) {
                bestHead = head;
                bestCross = cross;
                bestEnd = end[@"id"];
            }
    }
    NSMutableString *line = [NSMutableString stringWithFormat:@"%@: %03d/%d kt, crosswind %d kt RWY %@",
        when, dir10, spd, (int)lround(bestCross), bestEnd];
    BOOL cloudKnown = NO, visKnown = NO;
    double cloud = RowDouble(sample, @"cloudBaseFt", &cloudKnown);
    double vis = RowDouble(sample, @"visibilityM", &visKnown);
    if (cloudKnown && cloud > 0) {
        int rounded = (int)lround(cloud / 100.0) * 100;
        NSString *bit = [NSString stringWithFormat:@"cloud base ~%d ft", rounded];
        [line appendFormat:@", %@", bit];
        [detail appendFormat:@"%@\n", bit];
    }
    if (visKnown && vis > 0 && vis < 8000) {
        NSString *bit = vis >= 1000
            ? [NSString stringWithFormat:@"visibility %d km", (int)lround(vis / 1000.0)]
            : [NSString stringWithFormat:@"visibility %d m", (int)lround(vis)];
        [line appendFormat:@", %@", bit];
        [detail appendFormat:@"%@\n", bit];
    }
    return @{@"line": line, @"detail": detail};
}

void SequenceUniformFrames(SequenceScreen screen, double srcWidth, double srcHeight, MSLPRect *frames) {
    if (!frames) return;
    for (int i = 0; i < 9; i++) frames[i] = (MSLPRect){0};
    if (!screen.valid || srcWidth <= 0 || srcHeight <= 0) return;
    MSLPRect fit = MSLPAspectFit(srcWidth, srcHeight, screen.cells[0]);
    double dx = fit.x - screen.cells[0].x;
    double dy = fit.y - screen.cells[0].y;
    for (int i = 0; i < 9; i++) {
        frames[i] = (MSLPRect){
            screen.cells[i].x + dx,
            screen.cells[i].y + dy,
            fit.width,
            fit.height,
        };
    }
}

MSLPRect StatusLineFrame(MSLPRect bar, NSInteger lineIndex) {
    if (lineIndex < 0) lineIndex = 0;
    const double inset = 18;
    const double line = 18;
    double width = bar.width - 2 * inset;
    if (width < 0) width = 0;
    return (MSLPRect){bar.x + inset, bar.y + 8 + lineIndex * line, width, line};
}
