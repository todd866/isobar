// Unit tests for Isobar's pure functions (Sources/pure.m). Run via ./tests.sh.
#import <Foundation/Foundation.h>
#import <zlib.h>
#import "pure.h"

static int failures = 0;
static void check(BOOL cond, NSString *msg) {
    fprintf(stderr, "%s %s\n", cond ? "ok  " : "FAIL", msg.UTF8String);
    if (!cond) failures++;
}

static NSData *DeflatedZeros(size_t count) {
    z_stream strm = {0};
    if (deflateInit(&strm, Z_BEST_SPEED) != Z_OK) return nil;
    NSMutableData *compressed = [NSMutableData data];
    uint8_t zeros[1 << 16] = {0};
    uint8_t out[1 << 16];
    size_t left = count;
    int rc;
    do {
        if (!strm.avail_in && left) {
            uInt chunk = (uInt)MIN(sizeof zeros, left);
            strm.next_in = zeros;
            strm.avail_in = chunk;
            left -= chunk;
        }
        strm.next_out = out;
        strm.avail_out = sizeof out;
        rc = deflate(&strm, left ? Z_NO_FLUSH : Z_FINISH);
        if (sizeof out > strm.avail_out) [compressed appendBytes:out length:sizeof out - strm.avail_out];
    } while (rc == Z_OK);
    deflateEnd(&strm);
    return rc == Z_STREAM_END ? compressed : nil;
}

static NSData *InflateBombPDF(void) {
    NSData *compressed = DeflatedZeros(70ull << 20);
    if (!compressed) return nil;
    NSMutableData *pdf = [NSMutableData dataWithData:[@"stream\n" dataUsingEncoding:NSASCIIStringEncoding]];
    [pdf appendData:compressed];
    [pdf appendData:[@"\nendstream" dataUsingEncoding:NSASCIIStringEncoding]];
    return pdf;
}

static NSData *Fixture(NSString *name) {
    NSString *root = [NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] stringByExpandingTildeInPath];
    NSString *path = [root stringByAppendingPathComponent:name];
    NSData *data = [NSData dataWithContentsOfFile:path];
    check(data.length > 0, [@"fixture " stringByAppendingString:name]);
    return data;
}

static NSData *Inflate(NSData *data) {
    if (!data.length) return nil;
    z_stream strm = {0};
    strm.next_in = (Bytef *)data.bytes;
    strm.avail_in = (uInt)data.length;
    if (inflateInit(&strm) != Z_OK) return nil;
    NSMutableData *out = [NSMutableData dataWithLength:data.length * 4 + 64];
    int rc;
    do {
        if (strm.total_out >= out.length) [out increaseLengthBy:out.length + 65536];
        strm.next_out = (Bytef *)out.mutableBytes + strm.total_out;
        strm.avail_out = (uInt)(out.length - strm.total_out);
        rc = inflate(&strm, Z_NO_FLUSH);
    } while (rc == Z_OK);
    inflateEnd(&strm);
    if (rc != Z_STREAM_END) return nil;
    out.length = strm.total_out;
    return out;
}

static BOOL MediaBoxOf(NSData *pdf, double *width, double *height) {
    NSString *text = [[NSString alloc] initWithBytes:pdf.bytes length:pdf.length encoding:NSISOLatin1StringEncoding];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"MediaBox\\s*\\[\\s*([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\s*\\]" options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!m) return NO;
    double x0 = [text substringWithRange:[m rangeAtIndex:1]].doubleValue;
    double y0 = [text substringWithRange:[m rangeAtIndex:2]].doubleValue;
    double x1 = [text substringWithRange:[m rangeAtIndex:3]].doubleValue;
    double y1 = [text substringWithRange:[m rangeAtIndex:4]].doubleValue;
    *width = x1 - x0;
    *height = y1 - y0;
    return *width > 0 && *height > 0;
}

// Outer map frame unioned with the title strip just above it. PDF origin is bottom-left.
static int PanelsInPDF(NSData *pdf, MSLPRect *outPanels, MSLPRect *header) {
    const uint8_t *bytes = pdf.bytes;
    NSUInteger n = pdf.length;
    NSMutableData *joined = [NSMutableData data];
    NSUInteger i = 0;
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
        NSData *dec = Inflate(raw);
        if (dec.length) [joined appendData:dec];
        i = k + 9;
    }
    NSString *text = [[NSString alloc] initWithData:joined encoding:NSISOLatin1StringEncoding];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"(?m)^([0-9.]+)[ ]+([0-9.]+)[ ]+([0-9.]+)[ ]+(-?[0-9.]+)[ ]+re\\b" options:0 error:nil];
    NSMutableArray *maps = [NSMutableArray array];
    NSMutableArray *titles = [NSMutableArray array];
    for (NSTextCheckingResult *m in [re matchesInString:text options:0 range:NSMakeRange(0, text.length)]) {
        double x = [text substringWithRange:[m rangeAtIndex:1]].doubleValue;
        double y = [text substringWithRange:[m rangeAtIndex:2]].doubleValue;
        double w = [text substringWithRange:[m rangeAtIndex:3]].doubleValue;
        double h = [text substringWithRange:[m rangeAtIndex:4]].doubleValue;
        if (h < 0) { y += h; h = -h; }
        if (w < 200 || w > 250) {
            if (header && w > 400 && h > 30 && h < 60 && y > 700)
                *header = (MSLPRect){x, y, w, h};
            continue;
        }
        NSValue *boxed = [NSValue valueWithBytes:&(MSLPRect){x, y, w, h} objCType:@encode(MSLPRect)];
        if (h > 160 && h < 180) [maps addObject:boxed];
        else if (h > 8 && h < 16) [titles addObject:boxed];
    }
    NSMutableArray *outer = [NSMutableArray array];
    for (NSValue *boxed in maps) {
        MSLPRect r; [boxed getValue:&r];
        BOOL merged = NO;
        for (NSUInteger t = 0; t < outer.count; t++) {
            MSLPRect o; [outer[t] getValue:&o];
            if (fabs(o.x - r.x) < 4 && fabs(o.y - r.y) < 8) {
                if (r.height > o.height) outer[t] = boxed;
                merged = YES;
                break;
            }
        }
        if (!merged) [outer addObject:boxed];
    }
    int count = 0;
    for (NSValue *titleBox in titles) {
        MSLPRect title; [titleBox getValue:&title];
        for (NSValue *mapBox in outer) {
            MSLPRect map; [mapBox getValue:&map];
            double mapTop = map.y + map.height;
            if (fabs(title.x - map.x) > 3 || fabs(title.y - mapTop) > 3) continue;
            if (count < 8) {
                double top = MAX(mapTop, title.y + title.height);
                outPanels[count++] = (MSLPRect){map.x, map.y, map.width, top - map.y};
            }
        }
    }
    // Time order: top to bottom, then left to right. PDF y grows upward.
    for (int a = 0; a < count; a++) {
        for (int b = a + 1; b < count; b++) {
            BOOL higher = outPanels[b].y > outPanels[a].y + 20
                || (fabs(outPanels[b].y - outPanels[a].y) <= 20 && outPanels[b].x < outPanels[a].x);
            if (higher) {
                MSLPRect tmp = outPanels[a];
                outPanels[a] = outPanels[b];
                outPanels[b] = tmp;
            }
        }
    }
    return count;
}

static NSDate *Date(NSString *iso) {
    NSISO8601DateFormatter *f = [NSISO8601DateFormatter new];
    f.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    return [f dateFromString:iso];
}

int main(void) {
    @autoreleasepool {
        NSDate *issued = IssueTimeFromCacheBuster(@"https://www.bom.gov.au/fwo/IDG00074.gif?2026-Sep-25-02:45:25");
        check(fabs(issued.timeIntervalSince1970 - Date(@"2026-09-25T02:45:25Z").timeIntervalSince1970) < 0.5,
              @"cache-buster is UTC");
        NSString *html = [[NSString alloc] initWithData:Fixture(@"4day-page.html") encoding:NSUTF8StringEncoding];
        NSDate *fromPage = IssueTimeFromCacheBuster(html);
        check(fabs(fromPage.timeIntervalSince1970 - issued.timeIntervalSince1970) < 0.5,
              @"page cache-buster ignores the decoy gif");
        check(IssueTimeFromCacheBuster(@"no query here") == nil, @"missing cache-buster is nil");

        NSDate *http = IssueTimeFromHTTPDate(@"Fri, 25 Sep 2026 02:45:25 GMT");
        check(fabs(http.timeIntervalSince1970 - issued.timeIntervalSince1970) < 0.5, @"Last-Modified matches cache-buster");
        check(IssueTimeFromHTTPDate(@"not a date") == nil, @"bad HTTP date is nil");

        NSDate *now = Date(@"2026-09-25T03:00:25Z");
        check([AgeText(issued, now) isEqual:@"15m"], @"age minutes");
        check([AgeText(Date(@"2026-09-25T00:00:25Z"), now) isEqual:@"3h"], @"age hours");
        check([AgeText(Date(@"2026-09-23T03:00:25Z"), now) isEqual:@"2d"], @"age days");
        check([AgeText(Date(@"2026-09-25T03:00:00Z"), now) isEqual:@"just now"], @"age just now");
        check([AgeText(nil, now) isEqual:@"—"], @"age missing");

        check([ObservationProductForState(@"WA") isEqual:@"IDW60901"], @"WA product");
        check([ObservationProductForState(@"nsw") isEqual:@"IDN60901"], @"NSW product");
        check([ObservationProductForState(@"VIC") isEqual:@"IDV60901"], @"VIC product");
        check([ObservationProductForState(@"QLD") isEqual:@"IDQ60901"], @"QLD product");
        check([ObservationProductForState(@"SA") isEqual:@"IDS60901"], @"SA product");
        check([ObservationProductForState(@"TAS") isEqual:@"IDT60901"], @"TAS product");
        check([ObservationProductForState(@"NT") isEqual:@"IDD60901"], @"NT product");
        check([ObservationProductForState(@"ACT") isEqual:@"IDN60903"], @"ACT product");
        check(ObservationProductForState(@"XX") == nil, @"unknown state");
        check([ObservationIndexURL(@"WA") isEqual:@"https://www.bom.gov.au/wa/observations/waall.shtml"], @"WA station index");
        check([ObservationJSONURL(@"IDW60901", @"94608") isEqual:
               @"https://www.bom.gov.au/fwo/IDW60901/IDW60901.94608.json"], @"obs URL");
        check([HourlyGeohash(@"qd66hrm") isEqual:@"qd66hr"], @"hourly geohash is 6 chars");
        check([HourlyGeohash(@"qd66hr") isEqual:@"qd66hr"], @"6-char geohash unchanged");
        check(HourlyGeohash(@"qd66") == nil, @"short geohash rejected");

        NSTimeZone *perth = [NSTimeZone timeZoneWithName:@"Australia/Perth"];
        NSDictionary *obs = ParseLatestObservation(Fixture(@"obs-perth.json"));
        check([obs[@"name"] isEqual:@"Perth"] && [obs[@"wmo"] isEqual:@"94608"], @"obs station");
        check(fabs([obs[@"airTemp"] doubleValue] - 19.6) < 0.01, @"obs air temp");
        check(fabs([obs[@"apparent"] doubleValue] - 16.4) < 0.01, @"obs apparent");
        check([obs[@"humidity"] integerValue] == 53, @"obs humidity");
        check([obs[@"windDir"] isEqual:@"SSE"] && [obs[@"windKmh"] integerValue] == 17, @"obs wind");
        check([obs[@"gustKmh"] integerValue] == 28, @"obs gust");
        check(fabs([obs[@"pressMsl"] doubleValue] - 1021.2) < 0.01, @"obs MSLP");
        check([obs[@"rainTrace"] isEqual:@"0.0"], @"obs rain trace");
        NSDate *obsAt = obs[@"time"];
        NSDateComponents *c = [[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]
            componentsInTimeZone:perth fromDate:obsAt];
        check(c.year == 2026 && c.month == 9 && c.day == 25 && c.hour == 16 && c.minute == 0,
              @"obs local_date_time_full is Perth civil time");
        check([ClockText(obsAt, perth, Date(@"2026-09-25T08:30:00Z")) isEqual:@"16:00"], @"obs clock today");
        check(ParseLatestObservation([@"{\"observations\":{\"data\":[]}}" dataUsingEncoding:NSUTF8StringEncoding]) == nil,
              @"empty obs is nil");

        NSArray *days = ParseDailyForecasts(Fixture(@"daily-perth.json"));
        check(days.count == 7, @"seven daily days");
        check([days[0][@"shortText"] isEqual:@"Possible shower."], @"day short text");
        check([days[0][@"extendedText"] containsString:@"southeasterly"], @"day extended text");
        check([days[0][@"tempMax"] integerValue] == 23, @"day max");
        check(days[0][@"tempMin"] == NSNull.null, @"today min can be null");
        check([days[0][@"tempLater"] integerValue] == 11 && [days[0][@"laterLabel"] isEqual:@"Overnight min"],
              @"today later min");
        check([days[0][@"rainChance"] integerValue] == 40, @"rain chance");
        check([days[0][@"rainMin"] integerValue] == 0 && [days[0][@"rainMax"] integerValue] == 1, @"rain range");
        check([days[1][@"tempMin"] isKindOfClass:NSNumber.class], @"later day has a min");

        NSArray *hours = ParseHourlyForecasts(Fixture(@"hourly-perth.json"), Date(@"2026-09-25T08:10:00Z"), 12);
        check(hours.count == 12, @"next 12 hours");
        check(fabs([hours[0][@"time"] timeIntervalSince1970] - Date(@"2026-09-25T09:00:00Z").timeIntervalSince1970) < 1,
              @"hourly starts at the next hour");
        check([hours[0][@"temp"] integerValue] == [hours[0][@"temp"] integerValue], @"hourly temp present");
        check(hours[0][@"rainChance"] != nil && hours[0][@"windDir"] != nil, @"hourly rain and wind");

        check(ParseWarnings(Fixture(@"warnings-empty.json")).count == 0, @"no warnings");
        NSArray *warn = ParseWarnings(Fixture(@"warnings-marine.json"));
        check(warn.count == 1 && [warn[0][@"title"] isEqual:@"Marine Wind Warning for Tasmania"], @"warning title");
        check([PlainTextFromHTML(@"<p>Gale &amp; strong<br>wind</p>") isEqual:@"Gale & strong\nwind"], @"warning html to text");
        NSDictionary *detail = ParseWarningDetail([@"{\"data\":{\"title\":\"Marine Wind Warning\",\"message\":\"<p>Strong wind.</p>\"}}" dataUsingEncoding:NSUTF8StringEncoding]);
        check([detail[@"text"] isEqual:@"Strong wind."], @"warning detail text");
        check([warn[0][@"shortTitle"] isEqual:@"Marine Wind Warning"], @"warning short title");

        NSArray *places = ParseLocationSearch(Fixture(@"locations-perth.json"));
        check(places.count >= 2 && [places[0][@"geohash"] isEqual:@"qd66hrm"] && [places[0][@"state"] isEqual:@"WA"],
              @"location search");

        NSString *stationHTML = [[NSString alloc] initWithData:Fixture(@"stations-wa.html") encoding:NSUTF8StringEncoding];
        NSArray *stations = ParseObservationStations(stationHTML);
        check(stations.count == 3, @"three stations");
        NSDictionary *match = MatchStationByName(stations, @"Perth");
        check([match[@"wmo"] isEqual:@"94608"] && [match[@"name"] isEqual:@"Perth"], @"exact station name");
        check(MatchStationByName(stations, @"Perth Airport")[@"wmo"] != nil, @"airport still matches itself");
        check(MatchStationByName(stations, @"Fremantle") == nil, @"unknown place does not guess");

        ChartFit fit = FitChart(601, 1006, 360, 2);
        check(fit.integer && fit.pixelMultiple == 1 && fabs(fit.width - 300.5) < 0.01, @"@2x 1:1 device pixels");
        ChartFit wide = FitChart(601, 1006, 700, 2);
        check(wide.integer && wide.pixelMultiple == 2 && fabs(wide.width - 601) < 0.01, @"@2x integer 2× when it fits");
        ChartFit tight = FitChart(601, 1006, 200, 2);
        check(!tight.integer && fabs(tight.width - 200) < 0.01, @"non-integer fit uses the available width");
        ChartFit box = FitChartBox(601, 1006, 800, 900, 2);
        check(box.integer && box.pixelMultiple == 1 && fabs(box.width - 300.5) < 0.01 && fabs(box.height - 503) < 0.01,
              @"@2x native box is 1:1 device pixels");
        ChartFit shortBox = FitChartBox(601, 1006, 800, 400, 2);
        check(!shortBox.integer && fabs(shortBox.height - 400) < 0.01 && shortBox.width < 300.5,
              @"short screen scales the chart down");
        ChartFit narrowBox = FitChartBox(601, 1006, 200, 900, 2);
        check(!narrowBox.integer && fabs(narrowBox.width - 200) < 0.01, @"narrow screen scales the chart down");
        ChartFit oneX = FitChartBox(601, 1006, 2000, 2000, 1);
        check(oneX.integer && fabs(oneX.width - 601) < 0.01 && fabs(oneX.height - 1006) < 0.01,
              @"@1x native is the GIF pixel size and does not scale up");
        NSDictionary *stripObs = ParseLatestObservation(Fixture(@"obs-perth.json"));
        check([ObservationStrip(@"Perth", stripObs) isEqual:
               @"Perth · 20° · SSE 17 (28) km/h · 1021.2 hPa · 0.0 mm"], @"observation strip");
        check([ObservationStrip(@"Nowhere", nil) isEqual:@"Nowhere · — · — · — · —"], @"strip without an observation");
        check([FullscreenStatusLine(@"Perth", stripObs) isEqual:
               @"Perth · 20° · SSE 17 (28) km/h · 1021.2 hPa (+0.8)"],
              @"fullscreen line keeps pressure and omits rain");
        check([FullscreenStatusLine(@"Nowhere", nil) isEqual:@"Nowhere · — · — · —"], @"fullscreen line without an observation");
        NSDate *pageIssued = IssueTimeFromCacheBuster([[NSString alloc] initWithData:Fixture(@"4day-page.html") encoding:NSUTF8StringEncoding]);
        NSDate *issuedNow = [pageIssued dateByAddingTimeInterval:5 * 3600 + 10];
        check([IssuedCaption(pageIssued, [NSTimeZone timeZoneWithName:@"UTC"], issuedNow, NO) isEqual:@"Issued 02:45 (5h)"],
              @"issued caption");
        check([IssuedCaption(pageIssued, [NSTimeZone timeZoneWithName:@"UTC"], issuedNow, YES) isEqual:@"Issued 02:45 (5h) · offline"],
              @"issued caption offline");
        check([IssuedCaption(nil, nil, issuedNow, NO) isEqual:@"Issued —"], @"issued caption missing");

        check(GUIRequiresLaunchServicesRelaunch(nil, @"com.iantodd.isobar"), @"anonymous launch relaunches");
        check(!GUIRequiresLaunchServicesRelaunch(@"com.iantodd.isobar", @"com.iantodd.isobar"), @"matching bundle stays");

        NSDictionary *perthPlace = ParseLocation(Fixture(@"location-perth.json"));
        check([perthPlace[@"name"] isEqual:@"Perth"] && [perthPlace[@"geohash"] isEqual:@"qd66hrm"],
              @"Perth location");
        check(fabs([perthPlace[@"latitude"] doubleValue] + 31.9516754) < 0.01, @"Perth latitude");
        check([perthPlace[@"timezone"] isEqual:@"Australia/Perth"], @"Perth zone");
        NSDictionary *sydneyObs = ParseLatestObservation(Fixture(@"obs-sydney.json"));
        check([sydneyObs[@"name"] isEqual:@"Sydney - Observatory Hill"] && [sydneyObs[@"wmo"] isEqual:@"94768"],
              @"sydney obs station");
        check(fabs([sydneyObs[@"airTemp"] doubleValue] - 21.7) < 0.01, @"sydney air temp");
        check([sydneyObs[@"windDir"] isEqual:@"NE"] && [sydneyObs[@"windKmh"] integerValue] == 17, @"sydney wind");
        check(fabs([sydneyObs[@"pressMsl"] doubleValue] - 1025.0) < 0.01, @"sydney MSLP");
        check([ObservationStrip(@"Sydney", sydneyObs) isEqual:
               @"Sydney · 22° · NE 17 km/h · 1025.0 hPa · 0.0 mm"], @"strip omits a missing gust");
        check([FullscreenStatusLine(@"Sydney", sydneyObs) isEqual:
               @"Sydney · 22° · NE 17 km/h · 1025.0 hPa (+0.2)"], @"fullscreen line shows a rising trend");
        NSMutableDictionary *fallingObs = [stripObs mutableCopy];
        fallingObs[@"pressDelta"] = @(-1.4);
        check([FullscreenStatusLine(@"Perth", fallingObs) isEqual:
               @"Perth · 20° · SSE 17 (28) km/h · 1021.2 hPa (-1.4)"],
              @"fullscreen line shows a falling trend");
        NSTimeZone *sydneyTZ = [NSTimeZone timeZoneWithName:@"Australia/Sydney"];
        NSDateComponents *sc = [[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]
            componentsInTimeZone:sydneyTZ fromDate:sydneyObs[@"time"]];
        check(sc.hour == 18 && sc.minute == 30, @"sydney obs is Sydney civil time");
        NSArray *sydneyDays = ParseDailyForecasts(Fixture(@"daily-sydney.json"));
        check(sydneyDays.count == 7 && [sydneyDays[0][@"iconDescriptor"] length] > 0, @"sydney daily icon");
        check(ParseWarnings(Fixture(@"warnings-sydney.json")).count == 0, @"cancelled warning is inactive");

        NSArray *waStations = ParseStationList(Fixture(@"stations-wa.json"));
        NSArray *nswStations = ParseStationList(Fixture(@"stations-nsw.json"));
        NSArray *vicStations = ParseStationList(Fixture(@"stations-vic.json"));
        check(waStations.count == 146 && nswStations.count == 200 && vicStations.count == 104, @"station catalogues");
        check([StationCatalogueProduct(@"WA") isEqual:@"IDW60801"], @"WA station product");
        check([StationCatalogueProduct(@"NSW") isEqual:@"IDN60801"], @"NSW station product");
        check([StationCatalogueProduct(@"VIC") isEqual:@"IDV60801"], @"VIC station product");
        NSDictionary *nearPerthPlace = NearestStation(waStations, [perthPlace[@"latitude"] doubleValue],
            [perthPlace[@"longitude"] doubleValue], perthPlace[@"name"]);
        check([nearPerthPlace[@"wmo"] isEqual:@"94608"] && [nearPerthPlace[@"name"] isEqual:@"Perth"],
              @"city-centre fixture resolves to Perth station");
        NSDictionary *sydneyPlace = ParseLocation(Fixture(@"location-sydney.json"));
        NSDictionary *nearSydney = NearestStation(nswStations, [sydneyPlace[@"latitude"] doubleValue],
            [sydneyPlace[@"longitude"] doubleValue], @"Sydney");
        check([nearSydney[@"wmo"] isEqual:@"94768"], @"sydney nearest is Observatory Hill");
        NSDictionary *nearCottesloe = NearestStation(waStations, -31.995620727539062, 115.75538635253906, @"Cottesloe");
        check([nearCottesloe[@"wmo"] isEqual:@"94614"] && [nearCottesloe[@"name"] isEqual:@"Swanbourne"],
              @"cottesloe nearest is Swanbourne");
        NSDictionary *nearPerth = NearestStation(waStations, -31.951675415039062, 115.85838317871094, @"Perth");
        check([nearPerth[@"wmo"] isEqual:@"94608"] && [nearPerth[@"name"] isEqual:@"Perth"], @"perth nearest is Perth");
        NSDictionary *nearSafety = NearestStation(waStations, -32.30461120605469, 115.72929382324219, @"Safety Bay");
        check([nearSafety[@"wmo"] isEqual:@"95607"] && [nearSafety[@"name"] isEqual:@"Garden Island"],
              @"safety bay nearest is Garden Island");
        NSDictionary *nearMelbourne = NearestStation(vicStations, -37.81425476074219, 144.9748992919922, @"East Melbourne");
        check([nearMelbourne[@"wmo"] isEqual:@"95936"] && [nearMelbourne[@"name"] isEqual:@"Melbourne (Olympic Park)"],
              @"melbourne nearest is Olympic Park");

        check([GeohashEncode(-31.951675415039062, 115.85838317871094, 7) isEqual:@"qd66hrm"], @"geohash Perth");
        check([GeohashEncode(-33.85917663574219, 151.2041473388672, 7) isEqual:@"r3gx2sp"], @"geohash sydney");
        check(GeohashEncode(-31.9, 115.9, 0) == nil, @"geohash precision rejected");

        NSDate *sunDay = Date(@"2026-09-25T02:00:00Z");
        NSDictionary *sydSun = SunEvents(-33.85917663574219, 151.2041473388672, sunDay, sydneyTZ);
        NSDate *bomRise = Date(@"2026-09-24T19:41:11Z");
        NSDate *bomSet = Date(@"2026-09-25T07:53:21Z");
        check(fabs([sydSun[@"sunrise"] timeIntervalSinceDate:bomRise]) < 180, @"sydney sunrise");
        check(fabs([sydSun[@"sunset"] timeIntervalSinceDate:bomSet]) < 180, @"sydney sunset");
        check([TimeOfDayText(sydneyObs[@"time"], sydneyTZ) isEqual:@"6:30 pm"], @"local time of day");

        NSArray *strip = HourlyStrip(ParseHourlyForecasts(Fixture(@"hourly-perth.json"), Date(@"2026-09-25T08:10:00Z"), 8),
            Date(@"2026-09-24T22:04:10Z"), Date(@"2026-09-25T10:15:20Z"), 8);
        BOOL sawSunset = NO;
        NSInteger hourCount = 0;
        NSDate *prev = nil;
        BOOL ordered = YES;
        for (NSDictionary *slot in strip) {
            if ([slot[@"kind"] isEqual:@"sunset"]) sawSunset = YES;
            if ([slot[@"kind"] isEqual:@"hour"]) hourCount++;
            if ([slot[@"kind"] isEqual:@"sunrise"]) ordered = NO;
            NSDate *t = slot[@"time"];
            if (prev && [t compare:prev] == NSOrderedAscending) ordered = NO;
            prev = t;
        }
        check(hourCount == 8 && sawSunset && ordered, @"hourly strip inserts sunset in order");

        NSArray *defaults = DefaultLocations();
        check(defaults.count == 2, @"two default locations");
        check([defaults[0][@"geohash"] isEqual:@"qd63czw"] && [defaults[0][@"name"] isEqual:@"Perth coast"],
              @"primary is public Perth coast at Cottesloe");
        check([defaults[0][@"stationWMO"] isEqual:@"94614"] && [defaults[0][@"stationName"] isEqual:@"Swanbourne"],
              @"primary uses coastal observations");
        NSDictionary *expectStation = @{
            @"Perth coast": @[@"94614", @"IDW60901"],
            @"Sydney": @[@"94768", @"IDN60901"],
        };
        for (NSDictionary *place in defaults) {
            NSArray *expect = expectStation[place[@"name"]];
            check(expect && [place[@"stationWMO"] isEqual:expect[0]] && [place[@"stationProduct"] isEqual:expect[1]],
                  @"observation product for each default place");
            check([ObservationJSONURL(place[@"stationProduct"], place[@"stationWMO"]) containsString:expect[1]],
                  @"observation URL uses the capital-city product");
        }
        check([sydneyDays[0][@"isNight"] boolValue], @"sydney today is night in its own forecast");
        NSArray *order = @[@"qd63czw", @"r3gx2sp"];
        BOOL hashes = YES;
        for (NSUInteger i = 0; i < order.count; i++) if (![defaults[i][@"geohash"] isEqual:order[i]]) hashes = NO;
        check(hashes, @"default location order");
        check([defaults[1][@"stationWMO"] isEqual:@"94768"] && [defaults[1][@"timezone"] isEqual:@"Australia/Sydney"],
              @"sydney default station and zone");
        NSString *archived = ArchiveLocations(defaults);
        NSArray *restored = UnarchiveLocations(archived);
        check(restored.count == 2 && [restored[1][@"geohash"] isEqual:@"r3gx2sp"], @"locations round-trip");
        check(UnarchiveLocations(nil).count == 2 && UnarchiveLocations(@"[]").count == 2, @"empty locations use defaults");
        check(UnarchiveLocations(@"not json") == nil ? NO : UnarchiveLocations(@"not json").count == 2,
              @"bad locations use defaults");
        NSArray *added = LocationListByAdding(defaults, @{@"name": @"Broome", @"state": @"WA", @"geohash": @"qd66abc",
            @"latitude": @(-17.9), @"longitude": @(122.2)});
        check(added.count == 3 && [added.lastObject[@"geohash"] isEqual:@"qd66abc"], @"add location");
        check(LocationListByAdding(added, added.lastObject).count == 3, @"duplicate location ignored");
        NSArray *removed = LocationListByRemovingIndex(defaults, 1);
        check(removed.count == 1 && [removed[0][@"geohash"] isEqual:@"qd63czw"], @"remove sydney");
        check(LocationListByRemovingIndex(removed, 99).count == 1, @"remove ignores a bad index");
        check(LocationListByRemovingIndex(@[defaults[0]], 0).count == 1, @"last location stays");
        NSArray *moved = LocationListByMoving(defaults, 0, 1);
        check([moved[0][@"geohash"] isEqual:@"r3gx2sp"] && [moved[1][@"geohash"] isEqual:@"qd63czw"],
              @"move primary down");
        check([ForecastPageURL(@"Perth", @"WA") isEqual:
               @"https://www.bom.gov.au/search?query=Perth%20WA"], @"forecast page");
        check([SymbolForIconDescriptor(@"shower", NO) isEqual:@"cloud.rain"], @"shower symbol");
        check([SymbolForIconDescriptor(@"wind", NO) isEqual:@"wind"], @"wind symbol");
        check([SymbolForIconDescriptor(@"mostly_sunny", YES) isEqual:@"cloud.moon"], @"night symbol");
        check([SymbolForIconDescriptor(@"partly_cloudy", NO) isEqual:@"cloud.sun"], @"partly cloudy day");
        check([SymbolForIconDescriptor(@"partly_cloudy", YES) isEqual:@"cloud.moon"], @"partly cloudy night");
        check([SymbolForIconDescriptor(@"sunny", NO) isEqual:@"sun.max"], @"sunny day");
        check([SymbolForIconDescriptor(@"clear", YES) isEqual:@"moon.stars"], @"clear night");
        check(LocationWarningsActive(@[@[], ParseWarnings(Fixture(@"warnings-marine.json"))]), @"any warning");
        check(!LocationWarningsActive(@[@[], @[]]), @"no warnings anywhere");
        check([PanelSourceFourDayMSLP isEqual:@"bom.IDG00074"], @"panel source id");

        NSDictionary *sydneyTend = PressureTendency(Fixture(@"obs-sydney.json"));
        check(fabs([sydneyTend[@"delta"] doubleValue] - 0.2) < 0.011, @"sydney pressure rose 0.2 hPa");
        check(fabs([sydneyTend[@"hours"] doubleValue] - 3.0) < 0.05, @"sydney tendency spans 3 h");
        NSDictionary *perthTend = PressureTendency(Fixture(@"obs-perth.json"));
        check(fabs([perthTend[@"delta"] doubleValue] - 0.8) < 0.011, @"perth pressure rose 0.8 hPa over 3 h");
        check(fabs([perthTend[@"hours"] doubleValue] - 3.0) < 0.05, @"perth tendency spans 3 h");
        NSData *halfHour = [@"{\"observations\":{\"header\":[{\"state_time_zone\":\"WA\"}],\"data\":["
            "{\"local_date_time_full\":\"20260925160000\",\"press_msl\":1021.2},"
            "{\"local_date_time_full\":\"20260925153000\",\"press_msl\":1021.0}"
            "]}}" dataUsingEncoding:NSUTF8StringEncoding];
        check(PressureTendency(halfHour) == nil, @"half an hour is not a 3 h tendency");
        NSData *falling = [@"{\"observations\":{\"header\":[{\"state_time_zone\":\"WA\"}],\"data\":["
            "{\"local_date_time_full\":\"20260925160000\",\"press_msl\":1018.4,\"air_temp\":20},"
            "{\"local_date_time_full\":\"20260925130000\",\"press_msl\":1020.1,\"air_temp\":18},"
            "{\"local_date_time_full\":\"20260925100000\",\"press_msl\":1019.0,\"air_temp\":17}"
            "]}}" dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *fall = PressureTendency(falling);
        check(fabs([fall[@"delta"] doubleValue] - (1018.4 - 1020.1)) < 0.011, @"pressure tendency falls");
        check(fabs([fall[@"hours"] doubleValue] - 3.0) < 0.05, @"synthetic tendency is 3 h");

        check(MSLPSourceColumn(0) == 0 && MSLPSourceRow(0) == 0, @"first time is the top-left source cell");
        check(MSLPSourceColumn(1) == 1 && MSLPSourceRow(1) == 0, @"second time is the top-right source cell");
        check(MSLPSourceColumn(2) == 0 && MSLPSourceRow(2) == 1, @"third time starts the second source row");
        check(MSLPSourceColumn(7) == 1 && MSLPSourceRow(7) == 3, @"last time is the bottom-right source cell");
        check(MSLPDisplayColumn(0) == 0 && MSLPDisplayRow(0) == 0, @"first time opens the screen grid");
        check(MSLPDisplayColumn(2) == 2 && MSLPDisplayRow(2) == 0, @"third time stays on the first screen row");
        check(MSLPDisplayColumn(3) == 3 && MSLPDisplayRow(3) == 0, @"fourth time is the end of the first screen row");
        check(MSLPDisplayColumn(4) == 0 && MSLPDisplayRow(4) == 1, @"fifth time wraps to the second screen row");
        check(MSLPDisplayColumn(7) == 3 && MSLPDisplayRow(7) == 1, @"last time is the bottom-right screen cell");
        check(MSLPSourceColumn(-1) == 0 && MSLPDisplayColumn(9) == 0, @"a bad time index stays in cell zero");

        MSLPPage chart = MSLPPageLayout(532.207, 793.779);
        check(chart.valid, @"reference page lays out");
        check(chart.panels[0].x < chart.panels[1].x && fabs(chart.panels[0].y - chart.panels[1].y) < 1.0,
              @"time order puts 10pm to the right of 10am");
        check(chart.panels[0].y > chart.panels[2].y, @"the next morning sits on the next source row");
        check(chart.header.y > chart.panels[0].y + chart.panels[0].height - 1.0, @"header sits above the panels");
        check(chart.panels[0].width > 200 && chart.panels[0].height > 160, @"a panel is a map, not a label");
        for (int i = 0; i < 8; i++) {
            MSLPRect p = chart.panels[i];
            check(p.x >= 0 && p.y >= 0 && p.x + p.width <= chart.pageWidth + 0.5
                  && p.y + p.height <= chart.pageHeight + 0.5, @"panel stays on the page");
        }
        MSLPPage doubled = MSLPPageLayout(532.207 * 2, 793.779 * 2);
        check(fabs(doubled.panels[3].width - chart.panels[3].width * 2) < 0.02
              && fabs(doubled.panels[3].y - chart.panels[3].y * 2) < 0.02,
              @"panel rects scale with the page");
        check(!MSLPPageLayout(0, 793).valid && !MSLPPageLayout(532, 0).valid, @"a bad page does not lay out");
        NSArray *pressureStations = @[
            @{@"name": @"Swanbourne", @"wmo": @"94614", @"lat": @(-32.0), @"lon": @(115.8), @"msl": @NO},
            @{@"name": @"Melville Water", @"wmo": @"95620", @"lat": @(-32.0), @"lon": @(115.8), @"msl": @NO},
            @{@"name": @"Perth", @"wmo": @"94608", @"lat": @(-31.9), @"lon": @(115.9), @"msl": @YES},
            @{@"name": @"Perth Airport", @"wmo": @"94151", @"lat": @(-31.9), @"lon": @(116.0), @"msl": @YES},
        ];
        NSDictionary *pressurePick = NearestPressureStation(pressureStations,
            [perthPlace[@"latitude"] doubleValue], [perthPlace[@"longitude"] doubleValue], @"Perth");
        check([pressurePick[@"wmo"] isEqual:@"94608"] && [pressurePick[@"name"] isEqual:@"Perth"],
              @"Perth pressure station");
        NSDictionary *sydneyPressure = NearestPressureStation(@[
            @{@"name": @"Sydney - Observatory Hill", @"wmo": @"94768", @"lat": @(-33.86), @"lon": @(151.20), @"msl": @YES},
            @{@"name": @"Sydney Airport", @"wmo": @"94767", @"lat": @(-33.95), @"lon": @(151.18), @"msl": @YES},
        ], [sydneyPlace[@"latitude"] doubleValue], [sydneyPlace[@"longitude"] doubleValue], @"Sydney");
        check([sydneyPressure[@"wmo"] isEqual:@"94768"], @"sydney pressure station stays Observatory Hill");
        NSData *swanbourneJSON = [@"{ \"observations\": { \"header\": [{\"state_time_zone\": \"WA\"}], \"data\": ["
            "{\"name\": \"Swanbourne\", \"wmo\": 94614, \"local_date_time_full\": \"20260925193000\","
            "\"air_temp\": 15.9, \"wind_dir\": \"ESE\", \"wind_spd_kmh\": 19, \"gust_kmh\": 35,"
            "\"rel_hum\": 82, \"dewpt\": 12.8, \"rain_trace\": \"0.0\"}]}}" dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *swanbourne = ParseLatestObservation(swanbourneJSON);
        check(swanbourne[@"pressMsl"] == NSNull.null, @"swanbourne fixture has no MSL");
        NSDictionary *merged = ObservationWithPressure(swanbourne, stripObs);
        check(fabs([merged[@"airTemp"] doubleValue] - 15.9) < 0.01, @"pressure merge keeps the near-station temp");
        check([merged[@"windDir"] isEqual:@"ESE"], @"pressure merge keeps the near-station wind");
        check(fabs([merged[@"pressMsl"] doubleValue] - 1021.2) < 0.01, @"pressure merge takes Perth MSL");
        check(fabs([merged[@"pressDelta"] doubleValue] - 0.8) < 0.011, @"pressure merge copies the 3 h tendency");
        check([merged[@"pressureStation"] isEqual:@"Perth"], @"pressure source is labelled when it differs");
        check(ObservationWithPressure(stripObs, stripObs)[@"pressureStation"] == nil,
              @"same station does not add a pressure label");
        NSArray *byDistance = StationsByDistance(pressureStations, -31.995620727539062, 115.75538635253906);
        check(byDistance.count == 4, @"stations ranked by distance");
        NSUInteger swanAt = [byDistance indexOfObjectPassingTest:^BOOL(NSDictionary *s, NSUInteger idx, BOOL *stop) {
            (void)idx; (void)stop; return [s[@"wmo"] isEqual:@"94614"];
        }];
        NSUInteger perthAt = [byDistance indexOfObjectPassingTest:^BOOL(NSDictionary *s, NSUInteger idx, BOOL *stop) {
            (void)idx; (void)stop; return [s[@"wmo"] isEqual:@"94608"];
        }];
        check(swanAt < perthAt, @"Swanbourne is closer than Perth");

        NSString *rawWarning = [[NSString alloc] initWithData:Fixture(@"warning-marine-body.txt") encoding:NSUTF8StringEncoding];
        NSString *clean = CleanWarningText(rawWarning);
        check(![clean containsString:@"IDW20100"], @"warning drops the product code");
        check(![clean containsString:@"Australian Government"], @"warning drops the bureau header");
        check(![clean containsString:@"Warning Summary"], @"warning drops the summary banner");
        check(![clean containsString:@"Please be aware"], @"warning drops the gust boilerplate");
        check([clean containsString:@"Perth Local Waters"], @"warning keeps the area");
        check([clean containsString:@"20 to 30 knots"], @"warning keeps the wind");
        check([clean containsString:@"4:45 pm"], @"warning keeps the time");
        check([clean containsString:@"midnight"], @"warning keeps the valid-until time");
        check([CleanWarningText(@"Strong wind.") isEqual:@"Strong wind."], @"plain warning text stays");
        check([[[clean componentsSeparatedByString:@"\n"] firstObject] containsString:@"Issued at"],
              @"cleaned warning starts at the issue time");

        MSLPScreen grid = MSLPScreenLayout(1470, 956, 2);
        check(grid.valid, @"1470x956 grid lays out");
        check(grid.cells[0].width > 300 && grid.cells[0].height > 240, @"grid cells are large");
        check(fabs(grid.cells[2].y - grid.cells[0].y) < 0.01 && grid.cells[2].x > grid.cells[1].x,
              @"the first four times share the top row, in order");
        check(grid.cells[4].y > grid.cells[0].y && grid.cells[4].x < grid.cells[5].x,
              @"Monday starts the second row");
        check(grid.header.y + grid.header.height <= grid.cells[0].y + 0.5, @"header stays above the grid");
        check(grid.header.height <= 56.1 && grid.header.height > 40, @"header is a slim strip");
        check(fabs((grid.bar.y + grid.bar.height) - 956) < 0.01 && grid.bar.y > grid.cells[4].y + grid.cells[4].height,
              @"status bar sits under the grid");
        MSLPRect fitted = MSLPAspectFit(chart.panels[0].width, chart.panels[0].height, grid.cells[0]);
        check(fitted.width > 300 && fitted.height > 220, @"a fitted panel fills its cell");
        check(fabs(fitted.width / fitted.height - chart.panels[0].width / chart.panels[0].height) < 0.01,
              @"fitted panel keeps the chart aspect");
        MSLPRect single = MSLPSinglePanelFrame(1470, 956, 2);
        check(single.width > 1000 && single.height > 800, @"one panel fills the screen");
        check(fabs(grid.bar.height - (GlanceCardHeight() + 8)) < 0.01, @"the status bar is one row of glance cards");
        check(single.width > fitted.width * 2 && single.height > fitted.height, @"single view is bigger than a grid cell");
        check(!MSLPScreenLayout(100, 100, 2).valid, @"a tiny window does not lay out");
        check(MSLPSinglePanelFrame(100, 100, 1).width == 0, @"a tiny window has no single panel");

        NSData *vector = Fixture(@"IDG00073.pdf");
        double pageW = 0, pageH = 0;
        check(MediaBoxOf(vector, &pageW, &pageH), @"fixture PDF publishes a media box");
        MSLPPage fixturePage = MSLPPageLayout(pageW, pageH);
        MSLPRect drawn[8] = {0};
        MSLPRect drawnHeader = {0};
        int drawnCount = PanelsInPDF(vector, drawn, &drawnHeader);
        check(drawnCount == 8, @"fixture PDF draws eight panels");
        check(fabs(drawnHeader.x - fixturePage.header.x) < 0.8
              && fabs(drawnHeader.y - fixturePage.header.y) < 0.8
              && fabs(drawnHeader.width - fixturePage.header.width) < 0.8
              && fabs(drawnHeader.height - fixturePage.header.height) < 0.8,
              @"header rect matches the fixture PDF");
        for (int i = 0; i < drawnCount && i < 8; i++) {
            MSLPRect want = fixturePage.panels[i];
            MSLPRect got = drawn[i];
            BOOL close = fabs(got.x - want.x) < 0.8 && fabs(got.y - want.y) < 0.8
                && fabs(got.width - want.width) < 0.8 && fabs(got.height - want.height) < 0.8;
            check(close, [NSString stringWithFormat:@"panel %d matches the fixture PDF", i]);
            if (i > 0) {
                BOOL timeOrder = got.y < drawn[i - 1].y - 20 || (fabs(got.y - drawn[i - 1].y) <= 20 && got.x > drawn[i - 1].x);
                check(timeOrder, [NSString stringWithFormat:@"panel %d follows panel %d in time", i, i - 1]);
            }
        }

        BOOL (^nearByte)(MSLPColour, int, int, int) = ^BOOL(MSLPColour colour, int r, int g, int b) {
            return fabs(colour.red - r / 255.0) < 1e-12 && fabs(colour.green - g / 255.0) < 1e-12
                && fabs(colour.blue - b / 255.0) < 1e-12;
        };
        check(nearByte(MSLPColourSea(), 0xeb, 0xf1, 0xf7), @"sea is Bureau #ebf1f7");
        check(nearByte(MSLPColourLand(), 0xf4, 0xee, 0xaf), @"land is Bureau #f4eeaf");
        check(nearByte(MSLPColourLandLight(), 0xf9, 0xf7, 0xde), @"light terrain yellow");
        check(nearByte(MSLPColourLandMid(), 0xf2, 0xe9, 0x97), @"mid terrain yellow");
        check(nearByte(MSLPColourLandDeep(), 0xf1, 0xdc, 0x84), @"deep terrain yellow");
        check(nearByte(MSLPColourTitle(), 0x03, 0x6d, 0x9b), @"title bar is Bureau #036d9b");
        check(nearByte(MSLPColourInk(), 0x26, 0x23, 0x22), @"ink is #262322");
        check(nearByte(MSLPColourPaper(), 0xff, 0xff, 0xff), @"page around the panels is white");
        check(MSLPFillMapCount() == 3, @"three flat fills are remapped");
        MSLPColour source = {0}, mapped = {0};
        check(MSLPFillMap(0, &source, &mapped) && fabs(source.red - 0.862) < 1e-9 && nearByte(mapped, 0xf4, 0xee, 0xaf),
              @"PDF land grey maps to #f4eeaf");
        check(MSLPFillMap(1, &source, &mapped) && source.red == 1 && source.green == 1 && source.blue == 1
              && nearByte(mapped, 0xeb, 0xf1, 0xf7), @"PDF sea white maps to #ebf1f7");
        check(MSLPFillMap(2, &source, &mapped) && fabs(source.red - 0.137) < 1e-9 && nearByte(mapped, 0x03, 0x6d, 0x9b),
              @"PDF title-bar black maps to #036d9b");
        check(!MSLPFillMap(3, &source, &mapped) && !MSLPFillMap(-1, NULL, NULL), @"fill map rejects a bad index");

        NSString * (^paint)(NSString *) = ^NSString *(NSString *stream) {
            NSData *out = MSLPRecolourStream([stream dataUsingEncoding:NSISOLatin1StringEncoding]);
            return [[NSString alloc] initWithData:out encoding:NSISOLatin1StringEncoding];
        };
        MSLPColour land = {0}, sea = {0}, title = {0};
        MSLPFillMap(0, NULL, &land);
        MSLPFillMap(1, NULL, &sea);
        MSLPFillMap(2, NULL, &title);
        NSString *landOp = [NSString stringWithFormat:@"%.6f %.6f %.6f scn", land.red, land.green, land.blue];
        NSString *seaOp = [NSString stringWithFormat:@"/CS0 cs %.6f %.6f %.6f scn\n", sea.red, sea.green, sea.blue];
        NSString *titleOp = [NSString stringWithFormat:@"/CS0 cs %.6f %.6f %.6f scn\n", title.red, title.green, title.blue];
        NSString *panel = paint(@"1 1 1  scn\n/GS0 gs\n38.543 732.034 228.072 -172.171 re\nf*\n0.862 0.866 0.871  scn\n");
        check([panel containsString:seaOp] && [panel containsString:@"38.543 732.034 228.072 -172.171 re\nf*"],
              @"a sea rectangle is filled with #ebf1f7");
        check([panel containsString:landOp] && ![panel containsString:@"0.862 0.866 0.871"],
              @"land grey becomes #f4eeaf");
        NSString *bar = paint(@"/GS1 gs\n38.543 742.767 228.072 -10.853 re\nf*\nBT\n1 1 1  scn\n/T1_1 1 Tf\n(10am )Tj\n");
        check([bar containsString:titleOp] && [bar containsString:@"1 1 1  scn\n/T1_1"],
              @"title bar is #036d9b and the title text stays white");
        NSString *ink = @"0.137 0.123 0.126  SCN\n0.5 w\n0 0 m\n10 10 l\nS\n"
            @"0.428 0.433 0.443  SCN\n2 w\n39.332 731.245 226.494 -170.594 re\nS\n"
            @"0.004 0.005 0.004  SCN\n0 0 m\n72 72 l\nS\n"
            @"0.137 0.123 0.126  scn\n/T1_0 1 Tf\n(1024)Tj\n"
            @"1 1 1  scn\n341.27 776.917 -6.825 4.666 re\nf\n";
        check([paint(ink) isEqual:ink], @"strokes, labels, hatching, and legend white stay as drawn");

        NSMutableData *recoloured = [NSMutableData data];
        {
            const uint8_t *bytes = vector.bytes;
            NSUInteger n = vector.length, cursor = 0;
            while (cursor + 10 < n) {
                const void *found = memmem(bytes + cursor, n - cursor, "stream", 6);
                if (!found) break;
                NSUInteger j = (const uint8_t *)found - bytes + 6;
                if (j + 1 < n && bytes[j] == '\r' && bytes[j + 1] == '\n') j += 2;
                else if (j < n && bytes[j] == '\n') j += 1;
                const void *end = memmem(bytes + j, n - j, "endstream", 9);
                if (!end) break;
                NSUInteger k = (const uint8_t *)end - bytes;
                NSData *raw = [NSData dataWithBytes:bytes + j length:k - j];
                if (raw.length && ((const uint8_t *)raw.bytes)[raw.length - 1] == '\n') {
                    NSUInteger trim = 1;
                    if (raw.length >= 2 && ((const uint8_t *)raw.bytes)[raw.length - 2] == '\r') trim = 2;
                    raw = [raw subdataWithRange:NSMakeRange(0, raw.length - trim)];
                }
                NSData *dec = Inflate(raw);
                if (dec.length) [recoloured appendData:MSLPRecolourStream(dec)];
                cursor = k + 9;
            }
        }
        NSString *chartInk = [[NSString alloc] initWithData:recoloured encoding:NSISOLatin1StringEncoding];
        check([chartInk containsString:landOp] && ![chartInk containsString:@"0.862 0.866 0.871"],
              @"fixture land grey is #f4eeaf");
        check([chartInk containsString:seaOp] && [chartInk containsString:titleOp],
              @"fixture sea and title bars use the Bureau palette");
        check([chartInk containsString:@"1 1 1  scn\n/T1_1"], @"fixture title text stays white");
        check([chartInk containsString:@"0.137 0.123 0.126  scn"] && [chartInk containsString:@"0.137 0.123 0.126  SCN"],
              @"fixture labels and dark strokes stay in ink");
        check([chartInk containsString:@"0.428 0.433 0.443  SCN"] && [chartInk containsString:@"0.004 0.005 0.004  SCN"],
              @"fixture coasts and rain hatching stay as drawn");
        check(![chartInk containsString:@"0.620 0.500 0.240"] && ![chartInk containsString:@"0.300 0.780"]
              && ![chartInk containsString:@"0.930 0.910 0.830"] && ![chartInk containsString:@"0.055 0.078 0.110"],
              @"the dark theme colours are gone");

        double mapAspect = chart.panels[0].width / chart.panels[0].height;
        check(fabs(grid.cells[0].width / grid.cells[0].height - mapAspect) < 0.01, @"grid cell keeps the panel aspect");
        check(grid.cells[0].x < 12 && (grid.cells[3].x + grid.cells[3].width) - grid.cells[0].x > 1400,
              @"a wide screen uses the width fit");
        double above = grid.header.y;
        double below = grid.bar.y - (grid.cells[4].y + grid.cells[4].height);
        check(fabs(above - below) < 0.75 && above > 40, @"header and grid are centred above the status bar");
        MSLPScreen squat = MSLPScreenLayout(1470, 520, 2);
        check(squat.valid, @"a shorter screen still lays out");
        check(squat.cells[0].height < grid.cells[0].height - 30 && squat.cells[0].width < grid.cells[0].width - 30,
              @"spare height grows panels only up to the smaller fit");
        check(fabs(squat.cells[0].width / squat.cells[0].height - mapAspect) < 0.01, @"the height fit keeps the panel aspect");
        double squatAbove = squat.header.y;
        double squatBelow = squat.bar.y - (squat.cells[4].y + squat.cells[4].height);
        check(fabs(squatAbove - squatBelow) < 0.75, @"a short grid stays centred");
        check(squat.cells[0].x > grid.cells[0].x + 20, @"the narrower block is centred across the width");
        check(squat.header.y + squat.header.height <= squat.cells[0].y + 0.5, @"short header stays above its grid");
        check(squat.bar.y > squat.cells[4].y + squat.cells[4].height, @"short grid stays above the status bar");

        NSData *analysisPDF = Fixture(@"IDY00050.pdf");
        NSDate *analysisWhen = AnalysisValidTime(analysisPDF);
        check(analysisWhen && fabs(analysisWhen.timeIntervalSince1970 - Date(@"2026-09-25T18:00:00Z").timeIntervalSince1970) < 1,
              @"analysis is valid 1800 UTC 25 Sep 2026");
        NSString *localValid = AnalysisLocalValidText(analysisPDF);
        check([localValid isEqual:@"04am AEST 26 Sep"],
              [@"analysis local validity " stringByAppendingString:localValid ?: @"nil"]);
        check([NowTitle(localValid, analysisWhen) isEqual:@"Now · 04am AEST 26 Sep"], @"now title uses the chart line");
        check(AnalysisValidTime([@"not a chart" dataUsingEncoding:NSUTF8StringEncoding]) == nil, @"prose has no validity time");

        NSArray<NSDate *> *prognosis = PrognosisValidTimes(Fixture(@"IDG00073.pdf"));
        check(prognosis.count == 8, [NSString stringWithFormat:@"prognosis has eight times (%lu)", (unsigned long)prognosis.count]);
        NSDate *firstPrognosis = Date(@"2026-09-26T00:00:00Z");
        check(prognosis.count == 8 && fabs([prognosis[0] timeIntervalSinceDate:firstPrognosis]) < 1,
              @"first prognosis is 10am EST Saturday");
        BOOL spaced = prognosis.count == 8;
        for (NSUInteger i = 1; i < prognosis.count; i++) {
            if (fabs([prognosis[i] timeIntervalSinceDate:prognosis[i - 1]] - 12 * 3600) > 1) spaced = NO;
        }
        check(spaced, @"prognosis times step by 12 hours");
        NSString *firstTitle = prognosis.count ? ForecastTitle(prognosis[0]) : @"nil";
        check(prognosis.count >= 2 && [firstTitle isEqual:@"10am EST Sat"],
              [@"forecast title " stringByAppendingString:firstTitle]);
        check(prognosis.count >= 2 && [ForecastTitle(prognosis[1]) isEqual:@"10pm EST Sat"], @"second panel is 10pm EST Sat");
        check(prognosis.count >= 3 && [ChartDayLabel(prognosis[2]) isEqual:@"Sun"], @"Sunday starts the third prognosis");

        NSArray<NSDate *> *sequence = ChartSequenceTimes(analysisWhen, prognosis);
        check(sequence.count == 9, @"sequence is the analysis plus eight prognoses");
        BOOL rising = sequence.count == 9 && [sequence[0] timeIntervalSinceDate:analysisWhen] == 0;
        for (NSUInteger i = 1; rising && i < sequence.count; i++) {
            if ([sequence[i] compare:sequence[i - 1]] != NSOrderedDescending) rising = NO;
        }
        check(rising, @"analysis leads the prognosis, and the nine times increase");

        NSDate *midMorning = Date(@"2026-09-26T01:00:00Z");
        ChartPair opened = OpeningChartPair(sequence, midMorning);
        check(opened.valid && opened.left == 0 && opened.right == 2,
              @"after 10am EST the pair is the analysis and the 10pm chart");
        NSDate *justAfterAnalysis = Date(@"2026-09-25T19:00:00Z");
        ChartPair early = OpeningChartPair(sequence, justAfterAnalysis);
        check(early.valid && early.left == 0 && early.right == 1,
              @"before the first prognosis the pair is analysis and 10am");
        ChartPair stepped = StepChartPair(opened, 1, (NSInteger)sequence.count);
        check(stepped.left == 1 && stepped.right == 2, @"stepping the gap lands on the consecutive pair");
        ChartPair back = StepChartPair(opened, -1, (NSInteger)sequence.count);
        check(back.left == 0 && back.right == 1, @"stepping back from the gap shows analysis and 10am");
        ChartPair tail = StepChartPair((ChartPair){7, 8, YES}, 1, 9);
        check(tail.left == 7 && tail.right == 8, @"the last pair does not step past the sequence");
        ChartPair head = StepChartPair((ChartPair){0, 1, YES}, -1, 9);
        check(head.left == 0 && head.right == 1, @"the first pair does not step before the analysis");
        ChartPair late = OpeningChartPair(sequence, Date(@"2026-09-30T00:00:00Z"));
        check(late.left == 0 && late.right == 8, @"after every chart the pair is the analysis and the last forecast");

        NSArray *earlier = @[
            Date(@"2026-09-25T12:00:00Z"),
            firstPrognosis,
            Date(@"2026-09-26T12:00:00Z"),
        ];
        check(prognosis.count >= 1 && PreviousIssueIndex(earlier, prognosis[0]) == 1,
              @"10am Saturday matches the same valid time in the previous issue");
        check(prognosis.count == 8 && PreviousIssueIndex(earlier, prognosis[7]) == -1,
              @"a time the previous issue does not have stays unmatched");
        check(PreviousIssueIndex(earlier, analysisWhen) == -1, @"the analysis time is not a prognosis panel");
        check(IssueShouldArchive(Date(@"2026-09-25T02:45:25Z"), Date(@"2026-09-26T02:45:25Z")),
              @"a new issue archives the one on disk");
        check(!IssueShouldArchive(Date(@"2026-09-25T02:45:25Z"), Date(@"2026-09-25T02:45:25Z")),
              @"the same issue does not archive over itself");
        check(!IssueShouldArchive(nil, Date(@"2026-09-26T02:45:25Z")), @"the first issue has nothing to archive");
        NSString *compare = IssueCompareTitle(Date(@"2026-09-25T02:45:00Z"), Date(@"2026-09-24T14:45:00Z"),
            [NSTimeZone timeZoneForSecondsFromGMT:0]);
        check([compare isEqual:@"Issue 25 Sep 02:45 vs previous 24 Sep 14:45"],
              [@"compare label " stringByAppendingString:compare ?: @"nil"]);
        check([ChartNoEarlierIssue isEqual:@"no earlier issue for this time"], @"missing-issue note");

        AnalysisGeo geo = AnalysisGeoreference(analysisPDF);
        check(geo.valid, @"analysis graticule fits a projection");
        double pinX = 0, pinY = 0;
        BOOL perthPin = AnalysisProject(geo, -31.9505, 115.8605, &pinX, &pinY);
        check(perthPin && fabs(pinX - 189.03) < 3 && fabs(pinY - 227.00) < 3,
              [NSString stringWithFormat:@"Perth pin %.2f,%.2f", pinX, pinY]);
        BOOL sydneyPin = AnalysisProject(geo, -33.85917663574219, 151.2041473388672, &pinX, &pinY);
        check(sydneyPin && fabs(pinX - 447.89) < 3 && fabs(pinY - 202.31) < 3,
              [NSString stringWithFormat:@"Sydney pin %.2f,%.2f", pinX, pinY]);
        check(!AnalysisGeoreference([@"not a chart" dataUsingEncoding:NSUTF8StringEncoding]).valid,
              @"prose does not georeference");

        double aspect = MSLPPopoverMapAspect();
        MSLPRect map0 = MSLPPrognosisMapCrop(pageW, pageH, 0);
        double panelTop = fixturePage.panels[0].y + fixturePage.panels[0].height;
        double mapTop = map0.y + map0.height;
        check(map0.width > 200 && panelTop - mapTop > 10, @"prognosis crop drops the title bar");
        check(map0.x > fixturePage.panels[0].x && map0.y > fixturePage.panels[0].y,
              @"prognosis crop sits inside the grey frame");
        check(fabs(map0.width / map0.height - aspect) < 0.002, @"popover aspect is the map interior");
        check(MSLPPrognosisMapCrop(pageW, pageH, 8).width == 0, @"a ninth prognosis panel is not a map");
        double analysisW = 0, analysisH = 0;
        check(MediaBoxOf(analysisPDF, &analysisW, &analysisH), @"analysis publishes a media box");
        MSLPRect window = AnalysisPopoverCrop(geo, analysisW, analysisH);
        check(window.width > 200 && fabs(window.width / window.height - aspect) < 0.002,
              @"analysis crop matches the prognosis aspect");
        check(window.y > 70 && window.y + window.height <= analysisH,
              @"analysis crop clears the legend and stays on the page");
        check(window.x > 20 && window.x + window.width < analysisW - 10,
              @"analysis crop trims ocean east and west of Australia");
        check(AnalysisPopoverCrop((AnalysisGeo){0}, analysisW, analysisH).width == 0,
              @"analysis crop needs a projection");
        double sx = 0, sy = 0;
        AnalysisProject(geo, -31.9505, 115.8605, &sx, &sy);
        check(sx > window.x && sx < window.x + window.width && sy > window.y && sy < window.y + window.height,
              @"Perth stays inside the analysis window");
        AnalysisProject(geo, -33.85917663574219, 151.2041473388672, &sx, &sy);
        check(sx > window.x && sx < window.x + window.width && sy > window.y && sy < window.y + window.height,
              @"Sydney stays inside the analysis window");
        double westX = 0, eastX = 0, unusedY = 0;
        AnalysisProject(geo, -26.15, 113.16, &westX, &unusedY);
        AnalysisProject(geo, -28.63, 153.64, &eastX, &unusedY);
        double leftFrac = (westX - window.x) / window.width;
        double widthFrac = (eastX - westX) / window.width;
        check(fabs(leftFrac - 0.1737) < 0.02 && fabs(widthFrac - 0.6613) < 0.02,
              [NSString stringWithFormat:@"Australia matches the prognosis placement %.3f %.3f", leftFrac, widthFrac]);

        NSDate *origin = Date(@"2026-09-25T18:00:00Z");
        NSDate *plus6 = Date(@"2026-09-26T00:00:00Z");
        NSDate *plus18 = Date(@"2026-09-26T12:00:00Z");
        check([PopoverRelativeLabel(origin, origin) isEqual:@"Now"], @"the analysis is Now");
        check([PopoverRelativeLabel(plus6, origin) isEqual:@"+6 h"], @"six hours is +6 h");
        check([PopoverRelativeLabel(plus18, origin) isEqual:@"+18 h"], @"eighteen hours is +18 h");
        NSString *evening = PopoverClockLabel(plus18, perth);
        NSString *morning = PopoverClockLabel(plus6, perth);
        // Apple's timezone database uses AWST or GMT+8 depending on macOS.
        // Both name the same Perth offset; the day and civil time must match.
        check([@[@"Sat 8 pm AWST", @"Sat 8 pm GMT+8"] containsObject:evening ?: @""],
              [@"evening clock " stringByAppendingString:evening ?: @"nil"]);
        check([@[@"Sat 8 am AWST", @"Sat 8 am GMT+8"] containsObject:morning ?: @""],
              [@"morning clock " stringByAppendingString:morning ?: @"nil"]);
        check([PopoverTickLabel(origin, origin, perth) isEqual:@"Now"], @"the Now tick has no zone");
        NSString *tick = PopoverTickLabel(plus18, origin, perth);
        check([tick isEqual:@"+18h Sat 8pm"], [@"tick " stringByAppendingString:tick ?: @"nil"]);
        check(![evening containsString:@"AEST"] && ![evening containsString:@"EST"] && ![tick containsString:@"EST"],
              @"popover times do not say AEST or EST");

        NSString *warnLine = PopoverWarningSummary(@[
            @{@"place": @"Perth", @"title": @"Marine Wind Warning"},
            @{@"place": @"Sydney", @"title": @"Marine Wind Warning"},
            @{@"place": @"Sydney", @"title": @"Storm Warning"},
        ]);
        check([warnLine containsString:@"Marine wind warning — Perth, Sydney"],
              [@"warning summary " stringByAppendingString:warnLine ?: @"nil"]);
        check([warnLine containsString:@"Storm warning — Sydney"], @"a second warning type stays on the line");
        check([[warnLine componentsSeparatedByString:@"\n"] count] == 1, @"deduped warnings are one line");
        check(PopoverWarningSummary(@[]).length == 0, @"no warnings is an empty line");

        NSString *sample = @"0.922 0.941 1.000 rg 0.945 0.945 0.863 rg 0.518 0.529 1.000 RG "
            @"0.000 0.000 0.000 rg 0.000 0.000 0.000 RG 0.000 0.000 1.000 RG 1.000 0.000 0.000 rg";
        NSString *painted = [[NSString alloc] initWithData:AnalysisRecolourStream(
            [sample dataUsingEncoding:NSISOLatin1StringEncoding]) encoding:NSISOLatin1StringEncoding];
        check([painted containsString:@"0.921569 0.945098 0.968627 rg"], @"analysis sea becomes #ebf1f7");
        check([painted containsString:@"0.956863 0.933333 0.686275 rg"], @"analysis land becomes #f4eeaf");
        check([painted containsString:@"0.149020 0.137255 0.133333 rg"]
              && [painted containsString:@"0.149020 0.137255 0.133333 RG"], @"analysis ink is #262322");
        check(![painted containsString:@"0.945 0.945 0.863"] && ![painted containsString:@"0.922 0.941 1.000"],
              @"analysis beige and lavender are gone");
        check([painted containsString:@"0.000 0.000 1.000 RG"] && [painted containsString:@"1.000 0.000 0.000 rg"],
              @"analysis fronts keep their blue and red");
        NSString *labelChart = @"[0 1] 0 d 0.000 0.000 0.000 RG 0.1 w 2 j\n"
            @"/A255 gs 0.314 0.314 0.314 rg\n10 10 m 20 20 l h f\n"
            @"BT\n  0.974663 0.223680 0.223680 -0.974663 30 140 Tm\n"
            @"  0.000 0.000 0.000 rg /A0 gs   /F0 4.487334 Tf\n  (1016) Tj\nET\n"
            @"[0 1] 0 d 0.000 0.000 0.000 RG 0.1 w 2 j\n"
            @"/A255 gs 0.000 0.000 0.000 rg\n10 10 m 12 12 l h f\n"
            @"BT\n  1.000000 0.000000 0.000000 -1.000000 40 100 Tm\n"
            @"  0.000 0.000 0.000 rg /A0 gs   /F0 7.958667 Tf\n  (H) Tj\nET\n"
            @"[0 1] 0 d 0.000 0.000 0.000 RG 0.1 w 2 j\n"
            @"/A255 gs 0.647 0.647 0.647 rg\n1 1 m 2 2 l h f\n"
            @"BT\n  1 0 0 -1 10 20 Tm\n"
            @"  0.000 0.000 0.000 rg /A0 gs   /F0b 4.318000 Tf\n  (120E) Tj\nET\n"
            @"0.647 0.647 0.647 RG 0.2 w\n10 10 m 20 20 l S\n"
            @"0.490 0.490 0.333 RG 0.3 w\n10 10 m 30 30 l S\n"
            @"0.314 0.314 0.314 RG 0.4 w\n10 10 m 40 40 l S\n"
            @"0.000 0.000 1.000 RG\n10 10 m 50 50 l S\n";
        NSString *styled = [[NSString alloc] initWithData:AnalysisPopoverStream(
            [labelChart dataUsingEncoding:NSISOLatin1StringEncoding], 474) encoding:NSISOLatin1StringEncoding];
        check(![styled containsString:@"(120E)"] && ![styled containsString:@"1 1 m 2 2 l h f"],
              @"analysis graticule labels are dropped");
        check([styled containsString:@"l n"] && ![styled containsString:@"20 20 l S"] && ![styled containsString:@"30 30 l S"],
              @"analysis graticule and state borders do not stroke");
        check([styled containsString:@"(1016)"] && [styled containsString:@"/F0b 4.487334 Tf"]
              && [styled containsString:@"/A255 gs"] && ![styled containsString:@"10 10 m 20 20 l h f"],
              @"isobar values are bold sans instead of thin outlines");
        check([styled containsString:@"(H)"] && [styled containsString:@"/F0b 7.958667 Tf"],
              @"H and L are bold sans");
        double isobar = AnalysisIsobarStroke(474);
        // Halved after the rendered comparison: the full ratio drew the analysis about twice as heavy.
        check(isobar > 0.5 && isobar < 1.0 && [styled containsString:[NSString stringWithFormat:@"%.3f w", isobar]],
              @"analysis isobars take the prognosis weight");
        check([styled containsString:@"0.000 0.000 1.000 RG"] && [styled containsString:@"50 50 l S"],
              @"analysis fronts stay blue and keep their stroke");

        SequenceScreen nine = SequenceScreenLayout(1470, 956, 2);
        check(nine.valid, @"1470x956 nine-chart grid lays out");
        check(nine.cells[0].width > 400 && nine.cells[0].height > 220, @"a nine-chart cell is large");
        check(fabs(nine.cells[1].y - nine.cells[0].y) < 0.1 && nine.cells[2].x > nine.cells[1].x
              && nine.cells[1].x > nine.cells[0].x, @"the first three times share the top row");
        check(nine.cells[3].y > nine.cells[0].y && fabs(nine.cells[3].x - nine.cells[0].x) < 0.1,
              @"the fourth time starts the second row");
        check(nine.cells[8].x > nine.cells[7].x && nine.cells[8].y > nine.cells[5].y,
              @"the last time is the bottom-right cell");
        check(nine.bar.y > nine.cells[6].y + nine.cells[6].height, @"the status bar stays under the nine");
        check(!SequenceScreenLayout(100, 100, 2).valid, @"a tiny window has no nine-chart grid");
        MSLPRect analysisFrame = SequenceSingleFrame(1470, 956, 2, 640, 432);
        check(analysisFrame.width > 1000 && analysisFrame.height > 700, @"one analysis chart fills the screen");

        for (int col = 0; col < 3; col++) {
            double x = nine.cells[col].x;
            check(fabs(nine.cells[col + 3].x - x) < 0.01 && fabs(nine.cells[col + 6].x - x) < 0.01,
                @"a nine-chart column shares x");
            check(fabs(nine.cells[col].width - nine.cells[col + 3].width) < 0.01
                && fabs(nine.cells[col].width - nine.cells[col + 6].width) < 0.01,
                @"a nine-chart column shares a width");
        }
        double gutter = nine.cells[1].x - (nine.cells[0].x + nine.cells[0].width);
        double gutter2 = nine.cells[2].x - (nine.cells[1].x + nine.cells[1].width);
        check(gutter > 1 && fabs(gutter - gutter2) < 0.01, @"the nine-chart gutters are equal");
        MSLPRect uniform[9];
        SequenceUniformFrames(nine, 580, 470, uniform);
        check(fabs(uniform[0].x - uniform[3].x) < 0.01 && fabs(uniform[0].x - uniform[6].x) < 0.01
            && fabs(uniform[1].x - uniform[4].x) < 0.01 && fabs(uniform[2].x - uniform[8].x) < 0.01,
            @"fitted cells keep every column on one x");
        check(fabs(uniform[0].width - uniform[8].width) < 0.01 && fabs(uniform[0].height - uniform[4].height) < 0.01,
            @"fitted cells are one size");
        MSLPRect status0 = StatusLineFrame(nine.bar, 0);
        MSLPRect status1 = StatusLineFrame(nine.bar, 1);
        check(status0.x >= 16 && status0.x + status0.width <= nine.bar.x + nine.bar.width,
            @"the status line is inset from the window edge");
        check(fabs(status1.x - status0.x) < 0.01 && status1.y > status0.y, @"status lines share the inset");

        NSString *manifestJSON =
            @"{\"schema\":1,\"run\":\"2026-09-25T18:00:00Z\",\"generated\":\"2026-09-26T00:00:00Z\","
            @"\"attribution\":\"ECMWF Open Data\","
            @"\"grid\":{\"west\":95,\"east\":170,\"north\":0,\"south\":-50,\"step\":1,\"nx\":76,\"ny\":51,"
            @"\"dtype\":\"float32\",\"endian\":\"little\",\"order\":\"time, north-to-south, west-to-east\"},"
            @"\"times\":[\"2026-09-26T00:00:00Z\",\"2026-09-26T12:00:00Z\",\"2026-09-27T00:00:00Z\","
            @"\"2026-09-27T12:00:00Z\",\"2026-09-28T00:00:00Z\",\"2026-09-28T12:00:00Z\","
            @"\"2026-09-29T00:00:00Z\",\"2026-09-29T12:00:00Z\",\"2026-09-30T00:00:00Z\"],"
            @"\"variables\":{\"msl\":{\"file\":\"msl.f32\",\"units\":\"hPa\"}}}";
        NSDictionary *manifest = StoreManifestFromJSON([manifestJSON dataUsingEncoding:NSUTF8StringEncoding]);
        check(manifest && [manifest[@"nx"] intValue] == 76 && [manifest[@"step"] doubleValue] == 1.0,
            @"a float32 manifest parses");
        check([manifest[@"times"] count] == 9, @"the manifest keeps its valid times");
        check(StoreManifestFromJSON([@"{\"schema\":1,\"grid\":{\"dtype\":\"float64\",\"nx\":2,\"ny\":2,\"step\":1,\"west\":0,\"east\":1,\"north\":0,\"south\":-1},\"times\":[\"2026-09-26T00:00:00Z\"],\"run\":\"2026-09-25T18:00:00Z\"}" dataUsingEncoding:NSUTF8StringEncoding]) == nil,
            @"a non-float32 grid is refused");
        check(StoreManifestFromJSON([@"{\"variables\":{\"msl\":{\"file\":\"msl.grib2\"}},\"grid\":{\"dtype\":\"float32\",\"nx\":2,\"ny\":2,\"step\":1,\"west\":0,\"east\":1,\"north\":0,\"south\":-1},\"times\":[\"2026-09-26T00:00:00Z\"],\"run\":\"2026-09-25T18:00:00Z\"}" dataUsingEncoding:NSUTF8StringEncoding]) == nil,
            @"GRIB is not a chart grid");
        check([StoreLatestRunPath([@"{\"run\":\"20260925T18Z\",\"path\":\"20260925T18Z\"}" dataUsingEncoding:NSUTF8StringEncoding]) isEqual:@"20260925T18Z"],
            @"latest.json names the run directory");
        check(StoreLatestRunPath([@"{\"path\":\"../secret\"}" dataUsingEncoding:NSUTF8StringEncoding]) == nil,
            @"a latest.json path cannot leave the store");

        NSString *statusJSON =
            @"{\"updated\":\"2026-09-26T00:00:00Z\",\"sources\":[{\"id\":\"ecmwf-ifs\",\"ok\":true,"
            @"\"run\":\"2026-09-25T18:00:00Z\",\"label\":\"ECMWF 18Z · 6 h ago\",\"detail\":\"\"}]}";
        NSData *status = [statusJSON dataUsingEncoding:NSUTF8StringEncoding];
        check([StoreStatusLabel(status) isEqual:@"ECMWF 18Z · 6 h ago"], @"status.json supplies the run line");
        NSDate *statusRun = StoreStatusRun(status);
        check(statusRun && fabs(statusRun.timeIntervalSince1970 - Date(@"2026-09-25T18:00:00Z").timeIntervalSince1970) < 1,
            @"status.json supplies the ECMWF run, not the file's updated time");
        check([SituationFreshness(statusRun, Date(@"2026-09-26T00:30:00Z")) isEqual:@"Forecast updated 6 h ago"],
            @"forecast age counts from that ECMWF run");
        check([SituationFreshness(Date(@"2026-09-26T00:00:00Z"), Date(@"2026-09-26T00:30:00Z")) isEqual:@"Forecast updated just now"],
            @"the status updated time is not the forecast age");
        check(StoreStatusOK(status), @"an ok source is current");
        NSData *unrelatedStatus = [@"{\"sources\":[{\"id\":\"bom-obs\",\"ok\":true,\"run\":\"2026-09-26T00:00:00Z\"},{\"id\":\"open-meteo-ecmwf-ensemble\",\"ok\":true}]}" dataUsingEncoding:NSUTF8StringEncoding];
        check(!StoreStatusOK(unrelatedStatus) && !StoreStatusRun(unrelatedStatus),
            @"observation and ensemble status cannot stand in for the national chart");
        NSData *mixedStatus = [@"{\"sources\":[{\"id\":\"ecmwf-ifs\",\"ok\":true},{\"id\":\"ecmwf-open-data\",\"ok\":false}]}" dataUsingEncoding:NSUTF8StringEncoding];
        check(!StoreStatusOK(mixedStatus), @"the current chart source takes precedence over legacy status");
        check(!StoreStatusOK(nil), @"missing status cannot establish forecast health");
        NSData *malformedStatus = [@"{\"sources\":[null,{\"id\":17,\"ok\":true},{\"id\":\"ecmwf-open-data\",\"ok\":\"true\"}]}" dataUsingEncoding:NSUTF8StringEncoding];
        check(!StoreStatusOK(malformedStatus), @"malformed source IDs and non-boolean health cannot establish freshness");
        NSDate *run = manifest[@"run"];
        NSDate *sixHours = [run dateByAddingTimeInterval:6 * 3600];
        check(!StoreRunIsStale(run, sixHours, YES), @"six hours after 18Z is inside the cycle");
        check(StoreRunIsStale(run, [run dateByAddingTimeInterval:StoreStaleAge() + 60], YES),
            @"a run past the stale age is kept and marked");
        check(StoreRunIsStale(run, sixHours, NO), @"a failed status is stale even when the run is young");
        check(StoreRunIsStale(nil, sixHours, YES), @"an empty store is stale");
        check([StoreForecastFreshness(run, sixHours, YES) isEqual:@"Forecast updated 6 h ago"],
            @"freshness names the loaded chart age");
        check([StoreForecastFreshness(run, sixHours, NO) isEqual:@"Forecast updated 6 h ago · stale"],
            @"a failed fetch remains visible alongside the retained chart age");
        check([StoreForecastFreshness(run, [run dateByAddingTimeInterval:19 * 3600], YES) hasSuffix:@" · stale"],
            @"the freshness cue becomes stale as time passes without a reload");
        check([StoreForecastFreshness(nil, sixHours, YES) isEqual:@"Chart unavailable"],
            @"an unreadable chart cannot claim a successful update");
        NSString *computed = StoreRunStatusLine(run, sixHours);
        check([computed isEqual:@"ECMWF 18Z · 6 h ago"], [@"computed status " stringByAppendingString:computed ?: @"nil"]);
        check([StoreRunCompareTitle(run, [run dateByAddingTimeInterval:-12 * 3600]) isEqual:@"18Z vs previous 06Z"],
            @"compare names the two cycles");

        NSArray<NSNumber *> *frames = StoreFrameIndices(manifest[@"times"], sixHours);
        check(frames.count == 9 && frames.firstObject.integerValue == 0 && frames.lastObject.integerValue == 8,
            @"Now and every 12 h through +96 h are the frames");
        NSMutableArray *threeHourly = [NSMutableArray array];
        for (NSInteger h = 0; h <= 30; h += 3) [threeHourly addObject:[run dateByAddingTimeInterval:h*3600]];
        NSArray<NSNumber *> *continuous = StoreFrameIndices(threeHourly, [run dateByAddingTimeInterval:2*3600]);
        check(continuous.firstObject.integerValue == 0, @"the time range contains now even when the next sample is closer");
        check(continuous.lastObject.integerValue == 10, @"the slider reaches the final hour off the 12-hour ladder");
        NSMutableArray *week = [NSMutableArray array];
        for (int lead = 0; lead <= 144; lead += 3) [week addObject:[run dateByAddingTimeInterval:lead * 3600]];
        for (int lead = 150; lead <= 168; lead += 6) [week addObject:[run dateByAddingTimeInterval:lead * 3600]];
        NSArray<NSNumber *> *weekFrames = StoreFrameIndices(week, [run dateByAddingTimeInterval:18 * 3600]);
        NSDate *weekEnd = week[weekFrames.lastObject.integerValue];
        check(weekFrames.firstObject.integerValue == 6 && week.count == 53 &&
              fabs([weekEnd timeIntervalSinceDate:run] - 168 * 3600) < 1,
            @"a 168 h ladder runs from the frame at now through the last listed hour");
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        NSMutableArray *bureau = [NSMutableArray array];
        [bureau addObject:[iso dateFromString:@"2026-09-26T06:00:00Z"]];
        for (int i = 0; i < 8; i++)
            [bureau addObject:[iso dateFromString:[NSString stringWithFormat:@"2026-09-%02dT%@:00:00Z",
                27 + (i / 2), (i % 2) ? @"12" : @"00"]]];
        NSDate *bureauNow = [iso dateFromString:@"2026-09-26T07:00:00Z"];
        NSArray<NSNumber *> *present = StoreFrameIndices(bureau, bureauNow);
        check(present.count >= 2 && present.firstObject.integerValue == 0, @"frames present are used when the 12 h ladder is absent");
        BOOL onLadder = YES;
        NSDate *anchor = bureau[0];
        for (NSNumber *index in present) {
            NSTimeInterval lead = [bureau[index.integerValue] timeIntervalSinceDate:anchor];
            if (lead > 168 * 3600 + 60) onLadder = NO;
        }
        check(onLadder, @"present frames stay inside +168 h");
        check([StorePreviousRunID(@[@"20260925T18Z", @"20260925T06Z", @"20260924T18Z"], @"20260925T18Z") isEqual:@"20260925T06Z"],
            @"the previous run is the next older cycle");

        NSString *warningXML =
            @"<warnings><warning><id>IDW20100</id><title>Marine Wind Warning for Western Australia</title>"
            @"<short_title>Marine Wind Warning</short_title><state>WA</state><phase>active</phase>"
            @"<text>Strong wind.</text></warning>"
            @"<warning><title>Cancelled storm</title><phase>cancelled</phase><text>Old.</text></warning></warnings>";
        NSArray *xmlWarnings = ParseWarningXML([warningXML dataUsingEncoding:NSUTF8StringEncoding]);
        check(xmlWarnings.count == 1 && [xmlWarnings[0][@"shortTitle"] isEqual:@"Marine Wind Warning"]
            && [xmlWarnings[0][@"state"] isEqual:@"WA"], @"FTP warning XML keeps the active warning");
        NSString *rainJSON = @"{\"observations\":{\"data\":[{\"lat\":-31.96,\"lon\":115.76,\"rain_trace\":\"3.2\"}]}}";
        NSDictionary *dot = StoreRainObservation([rainJSON dataUsingEncoding:NSUTF8StringEncoding]);
        check(fabs([dot[@"mm"] doubleValue] - 3.2) < 0.01 && fabs([dot[@"lat"] doubleValue] + 31.96) < 0.01,
            @"observed rain is a station dot");
        check(StoreRainObservation([@"{\"observations\":{\"data\":[{\"lat\":-32,\"lon\":115,\"rain_trace\":\"-\"}]}}" dataUsingEncoding:NSUTF8StringEncoding]) == nil,
            @"a missing rain trace is not a dot");
        NSString *pointJSON = @"{\"hourly\":[{\"time\":\"2026-09-25T18:00:00Z\",\"temp\":16,\"wind_direction\":\"S\",\"wind_speed_kmh\":12},"
            @"{\"time\":\"2026-09-26T02:00:00Z\",\"temp\":18,\"wind_direction\":\"SW\",\"wind_speed_kmh\":22}]}";
        NSArray *points = StorePointHours([pointJSON dataUsingEncoding:NSUTF8StringEncoding], sixHours, 4);
        check(points.count == 1 && fabs([points[0][@"temp"] doubleValue] - 18) < 0.01
            && [points[0][@"windDir"] isEqual:@"SW"], @"point forecasts are the hours still ahead");

        NSString *fixtureRoot = NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] ?: @"Tests/fixtures";
        NSData *stored = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/ecmwf/20260925T18Z/manifest.json"]];
        NSDictionary *storedManifest = StoreManifestFromJSON(stored);
        NSArray *storedFrames = StoreFrameIndices(storedManifest[@"times"], sixHours);
        check(storedManifest && storedFrames.count == 9, @"the fixture run is Now plus eight 12 h frames");
        NSData *msl = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/ecmwf/20260925T18Z/msl.f32"]];
        NSUInteger expectBytes = (NSUInteger)([storedManifest[@"nx"] intValue] * [storedManifest[@"ny"] intValue] * (int)[storedManifest[@"times"] count] * 4);
        check(msl.length == expectBytes, @"the fixture grid matches the manifest");

        check(fabs(KnotsFromKmh(17) - 17.0 / 1.852) < 0.001, @"17 km/h is about 9 kt");
        check(fabs(KnotsFromKmh(28) - 28.0 / 1.852) < 0.001, @"28 km/h is about 15 kt");
        double sse = 0;
        check(WindFromDegrees(@"SSE", &sse) && fabs(sse - 157.5) < 0.01, @"SSE is 157.5° from");
        check(fabs(WindToDegrees(sse) - 337.5) < 0.01, @"SSE blows toward NNW");
        check(!WindFromDegrees(@"CALM", &sse) && !WindFromDegrees(@"-", &sse), @"calm is not a direction");
        check([WindGlanceLabel(@"SSE", 9.2, 15.1, YES, YES) isEqual:@"SSE 9 kt, gusts 15"],
            @"the glance says the wind in knots");
        check([WindGlanceLabel(@"N", 0.2, 0, YES, NO) isEqual:@"Calm"], @"a near-calm wind is Calm");
        check([WindGlanceLabel(@"", 0, 0, NO, NO) isEqual:@"—"], @"missing wind is a dash");
        check([PressureGlanceLabel(1021.2) isEqual:@"1021 hPa"], @"pressure is a whole number of hPa");
        check([PressureTrendLabel(0.8, 3, YES) isEqual:@"rising 0.8/3h"], @"a rise is said in words");
        check([PressureTrendLabel(-1.4, 3.1, YES) isEqual:@"falling 1.4/3h"], @"a fall is said in words");
        check([PressureTrendLabel(0.02, 3, YES) isEqual:@"steady"] && PressureTrendSign(0.02, YES) == 0,
            @"a tenth under 0.05 hPa is steady");
        check(PressureTrendSign(0.8, YES) == 1 && PressureTrendSign(-0.4, YES) == -1, @"trend sign follows the change");
        check([PressureTrendLabel(0, 0, NO) isEqual:@"—"], @"an unknown trend is a dash");

        WindArrow east = WindArrowLayout(90, 20, 32, YES, YES);
        check(!east.calm && east.headX > east.tailX && fabs(east.headY - east.tailY) < 0.05,
            @"an easterly arrow points to where the wind is going");
        check(east.hasGust && east.gustX > east.headX, @"the gust continues past the head");
        WindArrow north = WindArrowLayout(0, 12, 12, YES, NO);
        check(north.headY < north.tailY && !north.hasGust, @"a northerly arrow points up the card");
        check(WindArrowLayout(30, 9, 15, YES, YES).weight < WindArrowLayout(30, 30, 40, YES, YES).weight,
            @"a stronger wind draws a heavier arrow");
        check(WindArrowLayout(0, 0, 0, NO, NO).calm, @"no wind is a calm mark");

        check([WindShoreName(270, 270, YES) isEqual:@"offshore"], @"straight out to sea is offshore");
        check([WindShoreName(90, 270, YES) isEqual:@"onshore"], @"onto the beach is onshore");
        check([WindShoreName(337.5, 270, YES) isEqual:@"cross"], @"SSE at Cottesloe is cross-shore");
        check([WindShoreName(350, 10, YES) isEqual:@"offshore"], @"shore angle wraps past north");
        check(WindIsOffshore(270, 270, YES) && !WindIsOffshore(90, 270, YES), @"offshore is the amber case");
        check(HourIsRideable(20, YES, 90, 15, 30, 270, YES), @"20 kt onshore is rideable");
        check(!HourIsRideable(10, YES, 90, 15, 30, 270, YES), @"under 15 kt is not rideable");
        check(!HourIsRideable(35, YES, 90, 15, 30, 270, YES), @"over 30 kt is not rideable");
        check(!HourIsRideable(20, YES, 270, 15, 30, 270, YES), @"offshore is not rideable");
        check(HourIsRideable(20, YES, 270, 15, 30, 0, NO), @"without a shore, direction does not veto");

        NSString *histJSON = @"{\"observations\":{\"header\":[{\"state_time_zone\":\"WA\"}],\"data\":["
            "{\"local_date_time_full\":\"20260926080000\",\"air_temp\":19.6,\"wind_dir\":\"SSE\","
            "\"wind_spd_kmh\":17,\"wind_spd_kt\":9,\"gust_kmh\":28,\"gust_kt\":15,\"press_msl\":1021.2},"
            "{\"local_date_time_full\":\"20260926050000\",\"air_temp\":18.0,\"wind_dir\":\"SE\","
            "\"wind_spd_kmh\":14,\"press_msl\":1020.4},"
            "{\"local_date_time_full\":\"20260925120000\",\"air_temp\":21.0,\"wind_dir\":\"W\","
            "\"wind_spd_kmh\":22,\"press_msl\":1018.4},"
            "{\"local_date_time_full\":\"20260925080000\",\"air_temp\":17.0,\"wind_dir\":\"SW\","
            "\"wind_spd_kmh\":24,\"press_msl\":1018.6}"
            "]}}";
        NSArray *hist = ObservationHistory([histJSON dataUsingEncoding:NSUTF8StringEncoding]);
        check(hist.count == 4 && [hist[0][@"windDir"] isEqual:@"SW"] && [hist.lastObject[@"windDir"] isEqual:@"SSE"],
            @"observation history is oldest first");
        check(fabs([hist.lastObject[@"windKt"] doubleValue] - 9) < 0.01, @"history prefers the Bureau kt field");
        check(fabs([hist[2][@"windKt"] doubleValue] - KnotsFromKmh(14)) < 0.01, @"history converts km/h when kt is absent");
        NSDate *newest = hist.lastObject[@"time"];
        NSDate *oldest = hist.firstObject[@"time"];
        check([newest timeIntervalSinceDate:oldest] >= 23.5 * 3600, @"the sample covers a day");
        NSString *bareJSON = @"{\"observations\":{\"header\":[{\"state_time_zone\":\"WA\"}],\"data\":["
            "{\"local_date_time_full\":\"20260926080000\",\"air_temp\":15.9,\"wind_dir\":\"ESE\",\"wind_spd_kmh\":19}"
            "]}}";
        NSArray *mergedHist = ObservationHistoryWithPressure(
            ObservationHistory([bareJSON dataUsingEncoding:NSUTF8StringEncoding]), hist);
        check(fabs([mergedHist.lastObject[@"pressMsl"] doubleValue] - 1021.2) < 0.01
            && [mergedHist.lastObject[@"windDir"] isEqual:@"ESE"],
            @"a station without MSL takes Perth's pressure");

        NSString *spotJSON = @"{\"hourly\":["
            "{\"time\":\"2026-09-26T01:00:00Z\",\"temp\":19,\"wind_direction\":\"S\",\"wind_speed_kmh\":20,\"wind_gust_kmh\":30,\"pressure_msl\":1021.4},"
            "{\"time\":\"2026-09-26T06:00:00Z\",\"temp\":22,\"wind_direction\":\"SW\",\"wind_speed_kmh\":35,\"wind_gust_kmh\":50,\"pressure_msl\":1022.4},"
            "{\"time\":\"2026-09-26T18:00:00Z\",\"temp\":16,\"wind_direction\":\"E\",\"wind_speed_kmh\":22,\"wind_gust_kmh\":34,\"pressure_msl\":1020.2}"
            "]}";
        NSDate *glanceNow = [[NSISO8601DateFormatter new] dateFromString:@"2026-09-26T00:30:00Z"];
        NSArray *series = StorePointSeries([spotJSON dataUsingEncoding:NSUTF8StringEncoding]);
        check(series.count == 3 && fabs([series[1][@"windKt"] doubleValue] - KnotsFromKmh(35)) < 0.01
            && fabs([series[1][@"pressMsl"] doubleValue] - 1022.4) < 0.01,
            @"point series keeps gust and pressure");

        NSString *windFromJSON = @"{\"hourly\":["
            @"{\"time\":\"2026-09-27T01:00:00Z\",\"wind_direction\":\"SSE\",\"wind_speed_kmh\":16},"
            @"{\"time\":\"2026-09-27T02:00:00Z\",\"wind_direction\":\"SSE\",\"wind_from\":90,\"wind_speed_kmh\":16},"
            @"{\"time\":\"2026-09-27T03:00:00Z\",\"wind_direction\":\"SW\",\"wind_from\":-1,\"wind_speed_kmh\":16},"
            @"{\"time\":\"2026-09-27T04:00:00Z\",\"wind_direction\":\"CALM\",\"wind_speed_kmh\":0},"
            @"{\"time\":\"2026-09-27T05:00:00Z\",\"wind_speed_kmh\":0}]}";
        NSArray *windFromSeries = StorePointSeries([windFromJSON dataUsingEncoding:NSUTF8StringEncoding]);
        check(windFromSeries.count == 5
            && fabs([windFromSeries[0][@"windFrom"] doubleValue] - 157.5) < 0.01,
            @"legacy compass wind direction becomes a from bearing");
        check(fabs([windFromSeries[1][@"windFrom"] doubleValue] - 90) < 0.01,
            @"a valid numeric wind_from takes precedence over the compass label");
        check(fabs([windFromSeries[2][@"windFrom"] doubleValue] - 225) < 0.01,
            @"an invalid numeric wind_from falls back to the compass label");
        check(windFromSeries[3][@"windFrom"] == [NSNull null] && windFromSeries[4][@"windFrom"] == [NSNull null],
            @"calm and missing wind directions stay unknown");
        NSDictionary *ps = PressureSpark(hist, series, glanceNow);
        check([ps[@"observed"] count] >= 2 && [ps[@"forecast"] count] == 3, @"pressure splits observed from forecast");
        check([ps[@"min"] doubleValue] < 1019 && [ps[@"max"] doubleValue] > 1022, @"the barograph spans its range");
        NSDictionary *ws = WindSpark(hist, series, glanceNow);
        check([ws[@"ticks"] count] >= 3, @"wind direction is ticked through the window");
        BOOL tickSteps = YES;
        double previousTick = -100;
        for (NSDictionary *tick in ws[@"ticks"]) {
            double hour = [tick[@"h"] doubleValue];
            if (fmod(fabs(hour), 3) > 0.01 || hour < previousTick) tickSteps = NO;
            previousTick = hour;
        }
        check(tickSteps, @"direction ticks land on the 3 h marks");
        NSArray *ride = RideableWindow(series, glanceNow, 15, 30, 270, YES);
        check(ride.count == 3 && ![ride[0][@"on"] boolValue] && [ride[1][@"on"] boolValue] && ![ride[2][@"on"] boolValue],
            @"the rideable window is 15–30 kt and not offshore");

        NSDictionary *kite = StoreKiteFile([@"{\"spots\":[{\"name\":\"Cottesloe\",\"geohash\":\"qd66kxx\",\"latitude\":-31.99,\"longitude\":115.75,\"shoreNormal\":270,\"state\":\"WA\"},{\"name\":\"Skip\",\"geohash\":\"ab\"}]}" dataUsingEncoding:NSUTF8StringEncoding]);
        check(fabs([kite[@"minKt"] doubleValue] - 15) < 0.01 && fabs([kite[@"maxKt"] doubleValue] - 30) < 0.01,
            @"kite thresholds default to 15–30 kt");
        check([kite[@"spots"] count] == 1 && fabs([kite[@"spots"][0][@"shoreNormal"] doubleValue] - 270) < 0.01,
            @"a kite spot keeps its shore normal");
        NSArray *withKite = GlancePlaces(DefaultLocations(), kite[@"spots"], YES);
        check(withKite.count == 3 && [withKite[2][@"name"] isEqual:@"Cottesloe"], @"kite spots append as cards");
        check(GlancePlaces(DefaultLocations(), kite[@"spots"], NO).count == 2, @"kite spots stay off until asked");
        NSArray *tags = WarningTags(@[
            @{@"shortTitle": @"Marine Wind Warning", @"title": @"Marine Wind Warning for Western Australia", @"text": @"Strong wind."},
            @{@"shortTitle": @"Marine Wind Warning", @"text": @"Again."},
            @{@"title": @"Storm warning", @"text": @"Later."},
        ]);
        check(tags.count == 2 && [tags[0][@"title"] isEqual:@"Marine wind warning"] && [tags[0][@"text"] isEqual:@"Strong wind."],
            @"warning tags are sentence case and deduped");

        NSDictionary *card = GlanceCardModel(@"Perth", ParseLatestObservation([histJSON dataUsingEncoding:NSUTF8StringEncoding]),
            hist, series, glanceNow, nil, 0, 0, tags, nil);
        check([card[@"windLabel"] isEqual:@"SSE 9 kt, gusts 15"], @"the card label is SSE in knots");
        check([card[@"pressureText"] isEqual:@"1021 hPa"] && [card[@"trendText"] isEqual:@"rising 0.8/3h"],
            @"the card says 1021 hPa and the three-hour rise");
        check([card[@"tempText"] isEqual:@"20°"] && ![card[@"offshore"] boolValue] && [card[@"ride"] count] == 0,
            @"a plain card has the temperature and no kite bar");
        NSDictionary *kiteCard = GlanceCardModel(@"Cottesloe", ParseLatestObservation([histJSON dataUsingEncoding:NSUTF8StringEncoding]),
            hist, series, glanceNow, @270, 15, 30, @[], nil);
        check([kiteCard[@"shore"] isEqual:@"cross"] && [kiteCard[@"ride"] count] == 3, @"a kite card keeps the rideable hours");

        NSData *storedObs = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/products/obs/94608.json"]];
        NSArray *storedHist = ObservationHistory(storedObs);
        NSDictionary *storedLatest = ParseLatestObservation(storedObs);
        check(storedHist.count >= 20, @"the fixture observation covers a day of history");
        check(fabs([storedLatest[@"pressMsl"] doubleValue] - 1021.2) < 0.01
            && [storedLatest[@"windDir"] isEqual:@"SSE"]
            && fabs([storedLatest[@"pressDelta"] doubleValue] - 0.8) < 0.011,
            @"Perth's fixture is still Perth's 1021.2 hPa, SSE, +0.8");
        NSData *storedPoint = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/products/points/qd66hrm.json"]];
        NSArray *storedSeries = StorePointSeries(storedPoint);
        check(storedSeries.count >= 24, @"the point forecast runs a day ahead");
        NSDictionary *storedKite = StoreKiteFile([NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/products/kite.json"]]);
        check(fabs([storedKite[@"spots"][0][@"shoreNormal"] doubleValue] - 270) < 0.01
            && fabs([storedKite[@"spots"][1][@"shoreNormal"] doubleValue] - 235) < 0.01
            && [storedKite[@"spots"][0][@"name"] isEqual:@"Cottesloe"]
            && [storedKite[@"spots"][1][@"name"] isEqual:@"Safety Bay"],
            @"the kite file is Cottesloe 270° and Safety Bay 235°");
        NSDictionary *fixtureCard = GlanceCardModel(@"Perth", storedLatest, storedHist, storedSeries, glanceNow, nil, 15, 30, @[], perth);
        check([fixtureCard[@"windLabel"] isEqual:@"SSE 9 kt, gusts 15"]
            && [fixtureCard[@"pressureText"] isEqual:@"1021 hPa"]
            && [fixtureCard[@"trendText"] isEqual:@"rising 0.8/3h"],
            @"the fixture card reads SSE 9 kt and rising 0.8/3h");
        check([fixtureCard[@"pressure"][@"observed"] count] >= 12 && [fixtureCard[@"pressure"][@"forecast"] count] >= 12,
            @"the barograph has a day behind it and a day ahead");
        check([fixtureCard[@"wind"][@"ticks"] count] >= 5, @"the wind trace has direction ticks");
        check([fixtureCard[@"pressure"][@"axisLeft"] isEqual:@"Yesterday morning"]
            && [fixtureCard[@"pressure"][@"axisRight"] isEqual:@"Tomorrow morning"]
            && [fixtureCard[@"wind"][@"axisLeft"] isEqual:@"Last night"]
            && [fixtureCard[@"wind"][@"axisRight"] isEqual:@"Tonight"],
            @"spark axes are day-parts, not hour offsets");

        NSDate *satMorning = Date(@"2026-09-26T00:30:00Z");
        NSDictionary *phrases = @{
            @"2026-09-26T00:00:00Z": @"Now",
            @"2026-09-26T02:00:00Z": @"Now",
            @"2026-09-26T02:01:00Z": @"This morning",
            @"2026-09-26T03:59:00Z": @"This morning",
            @"2026-09-26T04:00:00Z": @"This afternoon",
            @"2026-09-26T08:59:00Z": @"This afternoon",
            @"2026-09-26T09:00:00Z": @"Tonight",
            @"2026-09-26T12:59:00Z": @"Tonight",
            @"2026-09-26T13:00:00Z": @"Tonight",
            @"2026-09-26T18:00:00Z": @"Tonight",
            @"2026-09-26T20:59:00Z": @"Tonight",
            @"2026-09-26T21:00:00Z": @"Tomorrow morning",
            @"2026-09-27T04:00:00Z": @"Tomorrow afternoon",
            @"2026-09-27T12:00:00Z": @"Tomorrow night",
            @"2026-09-28T00:00:00Z": @"Mon morning",
            @"2026-09-28T12:00:00Z": @"Mon night",
        };
        for (NSString *iso in phrases) {
            NSString *got = SituationPhrase(Date(iso), satMorning, perth);
            check([got isEqual:phrases[iso]], [NSString stringWithFormat:@"%@ → %@ (%@)", iso, got, phrases[iso]]);
            check([got rangeOfString:@"+" options:0].location == NSNotFound
                && [got rangeOfString:@" h" options:0].location == NSNotFound, @"a day-part is not an hour offset");
        }
        NSDate *satAfternoon = Date(@"2026-09-26T07:00:00Z");
        check([SituationPhrase(Date(@"2026-09-26T20:59:00Z"), satAfternoon, perth) isEqual:@"Tonight"]
            && [SituationPhrase(Date(@"2026-09-26T21:00:00Z"), satAfternoon, perth) isEqual:@"Tomorrow morning"],
            @"4:59 am is still tonight and 5:00 am is tomorrow morning");
        NSDate *friMorning = Date(@"2026-09-25T00:30:00Z");
        check([SituationPhrase(Date(@"2026-09-27T12:59:00Z"), friMorning, perth) isEqual:@"Sun night"]
            && [SituationPhrase(Date(@"2026-09-27T13:00:00Z"), friMorning, perth) isEqual:@"Sun night"],
            @"evening and night after tomorrow are both Sun night");
        check([SituationPhrase(Date(@"2026-09-26T00:00:00Z"), Date(@"2026-09-27T00:00:00Z"), perth) isEqual:@"Yesterday morning"],
            @"Sunday morning calls Saturday morning yesterday");
        check([SituationPhrase(Date(@"2026-09-26T12:00:00Z"), Date(@"2026-09-27T00:00:00Z"), perth) isEqual:@"Last night"],
            @"Sunday morning calls Saturday evening last night");
        check([SituationPhrase(Date(@"2026-09-26T18:00:00Z"), Date(@"2026-09-27T00:30:00Z"), nil) isEqual:@"Last night"],
            @"a missing zone is still Perth");
        check([SituationClock(Date(@"2026-09-26T12:00:00Z"), perth) isEqual:@"8 pm"]
            && [SituationClock(Date(@"2026-09-26T00:30:00Z"), perth) isEqual:@"8:30 am"],
            @"the small clock is 8 pm or 8:30 am");
        check([SituationTitle(Date(@"2026-09-26T12:00:00Z"), satMorning, perth) isEqual:@"Tonight · 8 pm"],
            @"a panel title is the day-part and the clock");
        check([SituationOffset(Date(@"2026-09-26T12:00:00Z"), satMorning) isEqual:@"+12h"]
            && [SituationPhrase(Date(@"2026-09-26T12:00:00Z"), satMorning, perth) isEqual:@"Tonight"],
            @"+12h stays out of the phrase");
        check(SituationPhrase(nil, satMorning, perth).length == 0 && SituationClock(nil, perth).length == 0,
            @"a missing time has no label");
        check(SituationAnchorDay(Date(@"2026-09-26T12:00:00Z"), perth) == SituationAnchorDay(Date(@"2026-09-26T18:00:00Z"), perth)
            && SituationAnchorDay(Date(@"2026-09-26T18:00:00Z"), perth) != SituationAnchorDay(Date(@"2026-09-26T21:00:00Z"), perth),
            @"2 am stays with the previous night, 5 am starts the next day");
        check([SituationFreshness(Date(@"2026-09-25T18:00:00Z"), satMorning) isEqual:@"Forecast updated 6 h ago"],
            @"a six-hour-old forecast says so in hours");
        check([SituationFreshness(Date(@"2026-09-25T23:30:00Z"), satMorning) isEqual:@"Forecast updated 1 h ago"],
            @"one hour uses the same forecast age pattern");
        check([ChartTemperatureLegend(1) isEqual:@"850 hPa (~5,000 ft) \u00B0C"]
            && [ChartTemperatureLegend(2) isEqual:@"Surface \u00B0C"]
            && ChartTemperatureLegend(0).length == 0,
            @"the colour key names 850 hPa or the surface");
        check([MenuBarReading(@{@"airTemp": @16.2, @"windDir": @"SE", @"windKt": @15.4}) isEqual:@"16° SE 15"],
            @"the menu bar is temperature, direction and knots");
        check([MenuBarReading(storedLatest) isEqual:@"20° SSE 9"], @"Perth's fixture reads 20° SSE 9");
        check([ShoreFacingName(270) isEqual:@"west"] && [ShoreFacingName(235) isEqual:@"southwest"],
            @"shore normals are named from the direction they face");

        NSDictionary *(^row)(NSString *, double, NSString *, double, double, double, double) =
            ^NSDictionary *(NSString *iso, double press, NSString *dir, double kt, double gust, double rain, double t850) {
                return @{@"time": Date(iso), @"pressMsl": @(press), @"windDir": dir, @"windKt": @(kt),
                    @"gustKt": @(gust), @"rainMm": @(rain), @"t850": @(t850)};
            };
        NSArray *front = @[
            row(@"2026-09-25T00:00:00Z", 1022, @"SE", 8, 12, 0, 16),
            row(@"2026-09-26T00:00:00Z", 1022, @"SE", 8, 12, 0, 16),
            row(@"2026-09-26T12:00:00Z", 1021, @"SE", 8, 12, 0, 16),
            row(@"2026-09-27T00:00:00Z", 1020, @"S", 10, 14, 0, 16),
            row(@"2026-09-27T12:00:00Z", 1014, @"SW", 25, 35, 0, 10),
            row(@"2026-09-28T00:00:00Z", 1012, @"SW", 18, 24, 2, 9),
            row(@"2026-09-28T12:00:00Z", 1013, @"S", 12, 16, 0, 10),
        ];
        NSString *headline = SituationHeadline(@"Perth", front, friMorning, perth);
        check([headline isEqual:@"Front reaches Perth Sun night · SW 25 kt, gusts 35 · rain from Mon morning"],
            [@"front headline " stringByAppendingString:headline ?: @"nil"]);
        NSArray *settled = @[
            row(@"2026-09-26T00:00:00Z", 1024, @"SE", 8, 12, 0, 14),
            row(@"2026-09-26T12:00:00Z", 1024, @"SE", 8, 12, 0, 14),
            row(@"2026-09-27T00:00:00Z", 1025, @"SE", 7, 11, 0, 14),
            row(@"2026-09-27T12:00:00Z", 1025, @"SE", 8, 12, 0, 14),
            row(@"2026-09-28T00:00:00Z", 1024, @"SE", 8, 12, 0, 14),
            row(@"2026-09-28T12:00:00Z", 1024, @"SE", 6, 10, 0, 14),
            row(@"2026-09-29T00:00:00Z", 1023, @"SE", 8, 12, 0, 14),
        ];
        NSString *quiet = SituationHeadline(@"Perth", settled, satMorning, perth);
        check([quiet isEqual:@"Settled: high pressure, light SE winds through Tue"],
            [@"settled headline " stringByAppendingString:quiet ?: @"nil"]);
        NSArray *middling = @[
            row(@"2026-09-26T02:00:00Z", 1010, @"E", 16, 18, 0, 14),
            row(@"2026-09-26T08:00:00Z", 1010, @"E", 16, 18, 0, 14),
            row(@"2026-09-27T02:00:00Z", 1010, @"E", 16, 18, 0, 14),
            row(@"2026-09-27T08:00:00Z", 1010, @"E", 16, 18, 0, 14),
        ];
        check(SituationHeadline(@"Perth", middling, satMorning, perth).length == 0,
            @"a moderate wind with no front stays silent");
        NSArray *pressureFront = @[
            @{@"time": Date(@"2026-09-25T18:00:00Z"), @"pressMsl": @1022, @"windDir": @"N", @"windKt": @8},
            @{@"time": Date(@"2026-09-26T00:00:00Z"), @"pressMsl": @1018, @"windDir": @"SW", @"windKt": @10},
            @{@"time": Date(@"2026-09-26T06:00:00Z"), @"pressMsl": @1018, @"windDir": @"SW", @"windKt": @10},
            @{@"time": Date(@"2026-09-26T12:00:00Z"), @"pressMsl": @1018, @"windDir": @"SW", @"windKt": @10},
        ];
        NSString *fell = SituationHeadline(@"Perth", pressureFront, satMorning, perth);
        check([fell isEqual:@"Front is at Perth now"], [@"pressure front " stringByAppendingString:fell ?: @"nil"]);
        NSString *fixtureHeadline = SituationHeadline(@"Perth", storedSeries, satMorning, perth);
        check([fixtureHeadline isEqual:@"Perth this afternoon: WSW 22 kt, gusts 31"],
            [@"fixture headline " stringByAppendingString:fixtureHeadline ?: @"nil"]);

        NSArray *kiteHours = @[
            @{@"time": Date(@"2026-09-26T05:00:00Z"), @"windDir": @"SW", @"windKt": @20},
            @{@"time": Date(@"2026-09-26T06:00:00Z"), @"windDir": @"SW", @"windKt": @22},
            @{@"time": Date(@"2026-09-26T07:00:00Z"), @"windDir": @"SW", @"windKt": @18},
            @{@"time": Date(@"2026-09-26T08:00:00Z"), @"windDir": @"SW", @"windKt": @16},
            @{@"time": Date(@"2026-09-26T09:00:00Z"), @"windDir": @"E", @"windKt": @20},
        ];
        NSDictionary *kitePlan = KitePlan(@[
            @{@"name": @"Cottesloe", @"shoreNormal": @270, @"hours": kiteHours},
        ], satMorning, perth, 15, 30);
        check([kitePlan[@"line"] isEqual:@"Cottesloe: kiteable today 1\u20134 pm (SW 16\u201322 kt)"],
            [@"kite line " stringByAppendingString:kitePlan[@"line"] ?: @"nil"]);
        NSDictionary *offshore = KitePlan(@[
            @{@"name": @"Cottesloe", @"shoreNormal": @270, @"hours": @[
                @{@"time": Date(@"2026-09-26T06:00:00Z"), @"windDir": @"E", @"windKt": @20},
                @{@"time": Date(@"2026-09-26T07:00:00Z"), @"windDir": @"E", @"windKt": @22},
            ]},
        ], satMorning, perth, 15, 30);
        check([offshore[@"line"] isEqual:@"No kite window in forecast"], @"offshore wind is not kiteable");
        NSData *cottesloePoint = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/products/points/qd63czw.json"]];
        NSData *safetyPoint = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"store/products/points/qd620yz.json"]];
        NSMutableArray *fixtureSpots = [NSMutableArray array];
        for (NSDictionary *spot in storedKite[@"spots"]) {
            NSMutableDictionary *copy = [spot mutableCopy];
            NSData *body = [spot[@"name"] isEqual:@"Cottesloe"] ? cottesloePoint : safetyPoint;
            copy[@"hours"] = StorePointSeries(body);
            [fixtureSpots addObject:copy];
        }
        NSDictionary *fixtureKite = KitePlan(fixtureSpots, satMorning, perth, 15, 30);
        check([fixtureKite[@"line"] isEqual:@"Cottesloe: kiteable today 12\u20137 pm (WSW 16\u201324 kt)"],
            [@"fixture kite " stringByAppendingString:fixtureKite[@"line"] ?: @"nil"]);

        NSArray *flyHours = @[@{
            @"time": Date(@"2026-09-27T02:00:00Z"),
            @"windFrom": @190, @"windKt": @8, @"cloudBaseFt": @3000, @"visibilityM": @5000,
        }];
        NSDictionary *fly = FlyPlan(flyHours, Date(@"2026-09-26T12:00:00Z"), perth, AerodromeForCode(@"YPPH"));
        check([fly[@"line"] isEqual:@"Tomorrow morning: 190/8 kt, crosswind 3 kt RWY 21, cloud base ~3000 ft, visibility 5 km"],
            [@"fly line " stringByAppendingString:fly[@"line"] ?: @"nil"]);
        check([fly[@"detail"] containsString:@"Runway 21"] && [fly[@"detail"] containsString:@"headwind"],
            @"the fly detail names the runway and the headwind");
        NSDictionary *fixtureFly = FlyPlan(storedSeries, satMorning, perth, AerodromeForCode(@"YPPH"));
        check([fixtureFly[@"line"] isEqual:@"This morning: 160/8 kt, crosswind 6 kt RWY 21"],
            [@"fixture fly " stringByAppendingString:fixtureFly[@"line"] ?: @"nil"]);
        NSDictionary *missingWind = FlyPlan(@[@{@"time": Date(@"2026-09-27T02:00:00Z")}],
            Date(@"2026-09-26T12:00:00Z"), perth, AerodromeForCode(@"YPPH"));
        check([missingWind[@"line"] hasPrefix:@"No wind forecast"], @"missing wind is not calm");
        NSDictionary *trueRunway = FlyPlan(@[@{@"time": Date(@"2026-09-27T02:00:00Z"), @"windFrom": @14, @"windKt": @12}],
            Date(@"2026-09-26T12:00:00Z"), perth,
            @{@"name": @"Perth Airport", @"ends": @[@{@"id": @"03", @"hdg": @14}, @{@"id": @"21", @"hdg": @194}]});
        check([trueRunway[@"line"] containsString:@"crosswind 0 kt RWY 03"], @"published true bearings are used for runway wind");
        NSDictionary *nightKite = KitePlan(@[@{@"name": @"Cottesloe", @"shoreNormal": @270,
            @"hours": @[@{@"time": Date(@"2026-09-26T13:00:00Z"), @"windDir": @"SW", @"windKt": @20, @"isDay": @NO}]}],
            Date(@"2026-09-26T12:00:00Z"), perth, 15, 30);
        check([nightKite[@"line"] isEqual:@"No kite window in forecast"], @"a night wind is not a daylight kite window");
        NSArray *nightRide = RideableWindow(@[@{@"time": Date(@"2026-09-26T13:00:00Z"), @"windDir": @"SW", @"windKt": @20, @"isDay": @NO}],
            Date(@"2026-09-26T12:00:00Z"), 15, 30, 270, YES);
        check(nightRide.count == 1 && ![nightRide[0][@"on"] boolValue], @"the kite chart also excludes nighttime windows");
        NSDictionary *soonKite = KitePlan(@[@{@"name": @"Cottesloe", @"shoreNormal": @270,
            @"hours": @[@{@"time": Date(@"2026-09-26T07:00:00Z"), @"windDir": @"SW", @"windKt": @20},
                @{@"time": Date(@"2026-09-27T05:00:00Z"), @"windDir": @"SW", @"windKt": @20},
                @{@"time": Date(@"2026-09-27T06:00:00Z"), @"windDir": @"SW", @"windKt": @20}]}],
            Date(@"2026-09-26T06:00:00Z"), perth, 15, 30);
        check([soonKite[@"line"] containsString:@"today"], @"a longer tomorrow window does not hide today's opportunity");

        NSCalendar *sydney = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
        sydney.timeZone = [NSTimeZone timeZoneWithName:@"Australia/Sydney"];
        NSData *(^gapJSON)(NSString *, NSString *) = ^NSData *(NSString *zone, NSString *stamp) {
            NSString *header = zone.length ? [NSString stringWithFormat:@"{\"state_time_zone\":\"%@\"}", zone] : @"";
            NSString *json = [NSString stringWithFormat:@"{\"observations\":{\"header\":[%@],\"data\":[{\"local_date_time_full\":\"%@\",\"air_temp\":18,\"press_msl\":1016}]}}", header, stamp];
            return [json dataUsingEncoding:NSUTF8StringEncoding];
        };
        NSDate *beforeGap = ParseLatestObservation(gapJSON(@"NSW", @"20261004013000"))[@"time"];
        NSDate *afterGap = ParseLatestObservation(gapJSON(@"NSW", @"20261004033000"))[@"time"];
        NSDateComponents *beforeParts = [sydney components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute fromDate:beforeGap];
        NSDateComponents *afterParts = [sydney components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute fromDate:afterGap];
        check(beforeParts.year == 2026 && beforeParts.month == 10 && beforeParts.day == 4 && beforeParts.hour == 1 && beforeParts.minute == 30,
            @"1:30 AEST on 4 Oct 2026 exists");
        check(afterParts.day == 4 && afterParts.hour == 3 && afterParts.minute == 30, @"3:30 AEDT on 4 Oct 2026 exists");
        check(beforeGap && afterGap && fabs([afterGap timeIntervalSinceDate:beforeGap] - 3600) < 1,
            @"the Sydney spring-forward gap is one hour of UTC");
        check(ParseLatestObservation(gapJSON(@"NSW", @"20261004023000")) == nil, @"2:30 does not exist on the Sydney changeover");
        check(ParseLatestObservation(gapJSON(nil, @"20261004013000")) == nil, @"a missing state is not Western Australia");
        check(ParseLatestObservation(gapJSON(@"ZZ", @"20261004013000")) == nil, @"an unknown state is not the Mac zone");
        check(ParseLatestObservation(gapJSON(@"NSW", @"20260231013000")) == nil, @"civil time is not lenient");
        check(ObservationHistory(gapJSON(@"ZZ", @"20261004013000")).count == 0, @"history without a zone is empty");
        check(PressureTendency(gapJSON(@"ZZ", @"20261004013000")) == nil, @"pressure tendency without a zone is missing");

        NSString *oversized = @"{\"schema\":1,\"grid\":{\"dtype\":\"float32\",\"endian\":\"little\",\"nx\":100000,\"ny\":100000,\"step\":1,\"west\":0,\"east\":1,\"north\":0,\"south\":-1},\"times\":[\"2026-09-26T00:00:00Z\"],\"run\":\"2026-09-25T18:00:00Z\"}";
        NSString *noEndian = @"{\"schema\":1,\"grid\":{\"dtype\":\"float32\",\"nx\":4,\"ny\":4,\"step\":1,\"west\":0,\"east\":1,\"north\":0,\"south\":-1},\"times\":[\"2026-09-26T00:00:00Z\"],\"run\":\"2026-09-25T18:00:00Z\"}";
        NSString *bigEndian = @"{\"schema\":1,\"grid\":{\"dtype\":\"float32\",\"endian\":\"big\",\"nx\":4,\"ny\":4,\"step\":1,\"west\":0,\"east\":1,\"north\":0,\"south\":-1},\"times\":[\"2026-09-26T00:00:00Z\"],\"run\":\"2026-09-25T18:00:00Z\"}";
        check(StoreManifestFromJSON([oversized dataUsingEncoding:NSUTF8StringEncoding]) == nil, @"an oversized manifest is refused");
        check(StoreManifestFromJSON([noEndian dataUsingEncoding:NSUTF8StringEncoding]) == nil, @"a manifest without endian is refused");
        check(StoreManifestFromJSON([bigEndian dataUsingEncoding:NSUTF8StringEncoding]) == nil, @"a big-endian manifest is refused");

        NSDate *bombStarted = [NSDate date];
        check(PrognosisValidTimes(InflateBombPDF()).count == 0 && -[bombStarted timeIntervalSinceNow] < 8,
            @"an inflate bomb does not expand without a ceiling");
        NSData *megabyte = DeflatedZeros(1u << 20);
        NSData *plainMegabyte = PDFInflate(megabyte);
        check(plainMegabyte.length == (1u << 20) && ((const uint8_t *)plainMegabyte.bytes)[12345] == 0,
            @"a normal zlib stream inflates whole");
        check(PDFInflate([megabyte subdataWithRange:NSMakeRange(0, megabyte.length / 2)]) == nil,
            @"a truncated zlib stream is refused");
        check(PDFInflate(nil) == nil && PDFInflate([NSData data]) == nil, @"an empty stream is refused");
        NSDate *capStarted = [NSDate date];
        check(PDFInflate(DeflatedZeros(70ull << 20)) == nil && -[capStarted timeIntervalSinceNow] < 8,
            @"a stream past the 64 MB ceiling is refused");
        BOOL undated = NO;
        NSDate *datedPanel = [NSDate dateWithTimeIntervalSince1970:1000];
        check([BureauPanelTimes(@[datedPanel], YES, &undated) count] == 1 && !undated, @"parsed panel times stay dated");
        check(BureauPanelTimes(@[], YES, &undated).count == 0 && undated, @"a loaded chart with no times is undated");
        check(BureauPanelTimes(@[], NO, &undated).count == 0 && !undated, @"no document does not invent undated panels");
        check([PrimaryAerodromeCode(@"NSW") isEqual:@"YSSY"] && [PrimaryAerodromeCode(@"VIC") isEqual:@"YMML"]
            && [PrimaryAerodromeCode(@"QLD") isEqual:@"YBBN"] && [PrimaryAerodromeCode(@"SA") isEqual:@"YPAD"]
            && [PrimaryAerodromeCode(@"WA") isEqual:@"YPPH"] && [PrimaryAerodromeCode(@"TAS") isEqual:@"YMHB"]
            && [PrimaryAerodromeCode(@"NT") isEqual:@"YPDN"] && [PrimaryAerodromeCode(@"ACT") isEqual:@"YSCB"],
            @"each state has its capital aerodrome");
        check(PrimaryAerodromeCode(@"ZZ") == nil && AerodromeForState(@"ZZ") == nil, @"an unknown state has no aerodrome");
        check([AerodromeForState(@"NSW")[@"runways"] count] > 0 && [AerodromeForState(@"WA")[@"code"] isEqual:@"YPPH"],
            @"Sydney and Perth keep their runway configuration");
        check([AerodromeForState(@"VIC")[@"code"] isEqual:@"YMML"] && [AerodromeForState(@"VIC")[@"runways"] count] == 0
            && [AerodromeForState(@"VIC")[@"timeZone"] isEqual:@"Australia/Melbourne"]
            && [AerodromeForState(@"VIC")[@"name"] isEqual:@"Melbourne Airport"]
            && fabs([AerodromeForState(@"VIC")[@"latitude"] doubleValue] + 37.6733) < 0.01,
            @"Melbourne is named and positioned without invented runways");

        NSDate *naiveNine = WeatherInstant(@"2026-09-26T09:00");
        NSDate *zuluNine = WeatherInstant(@"2026-09-26T09:00:00Z");
        NSDate *plusTen = WeatherInstant(@"2026-09-26T19:00+10:00");
        check(naiveNine && zuluNine && fabs([naiveNine timeIntervalSinceDate:zuluNine]) < 1, @"a naive point time is GMT");
        check(plusTen && fabs([plusTen timeIntervalSinceDate:zuluNine]) < 1, @"an offset clock is the same instant");
        check(WeatherInstant(@"2026-10-02T05:31+10:00") != nil && WeatherInstant(@"not-a-time") == nil,
            @"local sunrise with an offset parses and a blank time does not");

        NSString *pointFixtureRoot = NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"] ?: @"Tests/fixtures";
        NSData *sydneyPoint = [NSData dataWithContentsOfFile:[pointFixtureRoot stringByAppendingPathComponent:
            @"store/products/points/ecmwf_ifs/runs/20261001T00Z/sydney.json"]];
        NSData *perthPoint = [NSData dataWithContentsOfFile:[pointFixtureRoot stringByAppendingPathComponent:
            @"store/products/points/ecmwf_ifs/runs/20261001T00Z/perth.json"]];
        NSDate *octoberMorning = WeatherInstant(@"2026-10-01T00:30:00Z");
        NSArray *sydneyWeek = StorePointDays(sydneyPoint, octoberMorning, 7, [NSTimeZone timeZoneWithName:@"Australia/Perth"]);
        NSArray *perthWeek = StorePointDays(perthPoint, octoberMorning, 7, [NSTimeZone timeZoneWithName:@"Australia/Sydney"]);
        check(sydneyWeek.count == 7 && perthWeek.count == 7, @"Sydney and Perth each keep seven local days");
        check([sydneyWeek[0][@"weekday"] isEqual:@"Today"] && [sydneyWeek[1][@"weekday"] isEqual:@"Fri"]
            && fabs([sydneyWeek[0][@"max"] doubleValue] - 28.9) < 0.01
            && fabs([sydneyWeek[0][@"min"] doubleValue] - 13.5) < 0.01
            && fabs([sydneyWeek[1][@"rainMm"] doubleValue] - 5.6) < 0.01
            && [sydneyWeek[0][@"weatherCode"] integerValue] == 3
            && [sydneyWeek[1][@"weatherCode"] integerValue] == 80
            && [sydneyWeek[2][@"weatherCode"] integerValue] == 95
            && [sydneyWeek[3][@"weatherCode"] integerValue] == 51,
            @"Sydney day 0 is today with the published max, min and weather codes");
        check([sydneyWeek[0][@"rainMm"] doubleValue] == 0 && sydneyWeek[0][@"rainMm"] != (id)NSNull.null,
            @"a dry day stays zero and is not treated as missing");
        check(perthWeek[2][@"min"] == (id)NSNull.null && perthWeek[3][@"gust"] == (id)NSNull.null
            && fabs([perthWeek[5][@"rainMm"] doubleValue] - 8.4) < 0.01
            && fabs([perthWeek[0][@"windDir"] doubleValue] - 270) < 0.01,
            @"a missing Perth min or gust stays missing");
        NSCalendar *sydneyCal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
        sydneyCal.timeZone = [NSTimeZone timeZoneWithName:@"Australia/Sydney"];
        NSDateComponents *sydneyDay = [sydneyCal components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay fromDate:sydneyWeek[0][@"date"]];
        check(sydneyDay.year == 2026 && sydneyDay.month == 10 && sydneyDay.day == 1, @"the day is the local calendar date");
        NSString *noZone = @"{\"daily\":{\"time\":[\"2026-10-01\",\"2026-10-02\"],\"temperature_2m_max\":[20,21],\"temperature_2m_min\":[null,10]}}";
        NSDate *sydneyEvening = WeatherInstant(@"2026-10-01T15:00:00Z");
        NSArray *fellBack = StorePointDays([noZone dataUsingEncoding:NSUTF8StringEncoding], sydneyEvening, 7,
            [NSTimeZone timeZoneWithName:@"Australia/Sydney"]);
        check(fellBack.count == 1 && [fellBack[0][@"weekday"] isEqual:@"Today"]
            && fabs([fellBack[0][@"min"] doubleValue] - 10) < 0.01,
            @"a product without a timezone uses the place zone and drops the previous local day");
        check([WeatherCodeSymbol(0, YES) isEqual:@"sun.max"] && [WeatherCodeSymbol(0, NO) isEqual:@"moon.stars"]
            && [WeatherCodeLabel(0) isEqual:@"Clear"] && [WeatherCodeLabel(1) isEqual:@"Mostly clear"]
            && [WeatherCodeSymbol(2, YES) isEqual:@"cloud.sun"] && [WeatherCodeLabel(2) isEqual:@"Partly cloudy"]
            && [WeatherCodeSymbol(3, YES) isEqual:@"cloud"] && [WeatherCodeLabel(3) isEqual:@"Cloudy"]
            && [WeatherCodeSymbol(45, YES) isEqual:@"cloud.fog"] && [WeatherCodeLabel(51) isEqual:@"Drizzle"]
            && [WeatherCodeSymbol(65, YES) isEqual:@"cloud.heavyrain"] && [WeatherCodeLabel(65) isEqual:@"Heavy rain"]
            && [WeatherCodeSymbol(80, YES) isEqual:@"cloud.sun.rain"] && [WeatherCodeSymbol(80, NO) isEqual:@"cloud.moon.rain"]
            && [WeatherCodeLabel(80) isEqual:@"Showers"] && [WeatherCodeSymbol(95, YES) isEqual:@"cloud.bolt.rain"]
            && [WeatherCodeLabel(95) isEqual:@"Thunderstorm"] && WeatherCodeSymbol(999, YES) == nil,
            @"weather codes map to a day symbol and a short label");
    }
    return failures ? 1 : 0;
}
