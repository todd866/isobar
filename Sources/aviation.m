#import "aviation.h"
#import <math.h>

static NSString *Text(id x) { return [x isKindOfClass:NSString.class] ? x : @""; }
static NSNumber *Number(id x) { return [x isKindOfClass:NSNumber.class] && isfinite([x doubleValue]) ? x : nil; }
static NSRegularExpression *Regex(NSString *s) { return [NSRegularExpression regularExpressionWithPattern:s options:0 error:NULL]; }
static BOOL Match(NSString *s, NSString *pattern) { return [Regex(pattern) firstMatchInString:s options:0 range:NSMakeRange(0,s.length)] != nil; }
static NSDate *Date(id value) {
    if ([value isKindOfClass:NSDate.class]) return value;
    if (Number(value)) return [NSDate dateWithTimeIntervalSince1970:[value doubleValue]];
    if (!Text(value).length) return nil;
    NSISO8601DateFormatter *f = [NSISO8601DateFormatter new];
    f.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSDate *d = [f dateFromString:value];
    if (!d) { f.formatOptions = NSISO8601DateFormatWithInternetDateTime; d = [f dateFromString:value]; }
    return d;
}
static NSString *Format(NSDate *d, NSTimeZone *tz, NSString *pattern) {
    if (!d) return @"—";
    NSDateFormatter *f = [NSDateFormatter new]; f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = tz; f.dateFormat = pattern;
    return [f stringFromDate:d];
}
static NSString *Clock(NSDate *d, NSTimeZone *tz) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; cal.timeZone = tz;
    return [Format(d,tz,[cal component:NSCalendarUnitMinute fromDate:d] ? @"h:mm a" : @"h a") lowercaseString];
}
static NSString *Span(NSDate *a, NSDate *b, NSTimeZone *tz) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; cal.timeZone = tz;
    BOOL same = [cal isDate:a inSameDayAsDate:b];
    NSString *aa = Clock(a,tz), *bb = Clock(b,tz);
    if (same && [[aa substringFromIndex:aa.length-2] isEqual:[bb substringFromIndex:bb.length-2]]) aa = [aa substringToIndex:aa.length-3];
    return [NSString stringWithFormat:@"%@ %@–%@%@",Format(a,tz,@"EEE"),aa,same?@"": [Format(b,tz,@"EEE") stringByAppendingString:@" "],bb];
}
static NSString *Feet(double value) {
    NSNumberFormatter *f = [NSNumberFormatter new]; f.numberStyle = NSNumberFormatterDecimalStyle; f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU"];
    f.maximumFractionDigits = 0;
    return [[f stringFromNumber:@(value)] stringByAppendingString:@" ft"];
}
static NSString *Visibility(double value) {
    if (value < 0) return @"—";
    if (value >= 9999) return @"10+ km";
    if (value == 0) return @"<50 m";
    if (value < 1000) return [NSString stringWithFormat:@"%.0f m",value];
    NSString *n = [NSString stringWithFormat:@"%.1f",value/1000];
    if ([n hasSuffix:@".0"]) n = [n substringToIndex:n.length-2];
    return [n stringByAppendingString:@" km"];
}

// No model-derived cloud base is used here. A ceiling needs BKN, OVC or VV.
static NSDictionary *Conditions(NSString *body) {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    NSArray *tokens = [body componentsSeparatedByString:@" "];
    double ceiling = INFINITY; BOOL cloud = NO, unknown = NO, cb = NO;
    BOOL cavok = NO, visibilityAtLeast = NO; NSNumber *visibilityM = nil;
    NSMutableArray *weather = [NSMutableArray array], *cloudLayers = [NSMutableArray array];
    for (NSString *token in tokens) {
        // Australian remarks (RMK T … Q 1018) and ICAO TX/TN groups are not visibility.
        if ([token isEqual:@"RMK"] || [token isEqual:@"TX"] || [token isEqual:@"TN"] || Match(token,@"^T[XN][0-9]")) break;
        if ([token isEqual:@"CAVOK"]) { cavok = YES; cloud = YES; [cloudLayers removeAllObjects]; visibilityAtLeast = YES; visibilityM = @9999; result[@"visibility"] = @"10+ km"; result[@"ceiling"] = @"CAVOK"; result[@"weather"] = @"CAVOK"; }
        else if (!visibilityM && Match(token,@"^[0-9]{4}$")) { visibilityM = @(token.doubleValue); visibilityAtLeast = token.doubleValue >= 9999; result[@"visibility"] = Visibility(token.doubleValue); }
        else if (Match(token,@"^(FEW|SCT|BKN|OVC|VV)([0-9]{3}|///)(CB|TCU)?$")) {
            cloud = YES;
            NSString *amount=[token hasPrefix:@"VV"]?@"VV":[token substringToIndex:3];
            NSUInteger baseOffset=amount.length;
            NSString *base=[token substringWithRange:NSMakeRange(baseOffset,3)], *type=token.length>baseOffset+3?[token substringFromIndex:baseOffset+3]:@"";
            [cloudLayers addObject:@{ @"amount":amount, @"baseFt":[base isEqual:@"///"]?[NSNull null]:@([base doubleValue]*100), @"type":type }];
            if ([type isEqual:@"CB"]) cb = YES;
            if ([token hasPrefix:@"BKN"] || [token hasPrefix:@"OVC"] || [token hasPrefix:@"VV"]) {
                NSUInteger offset = [token hasPrefix:@"VV"] ? 2 : 3;
                NSString *base = [token substringWithRange:NSMakeRange(offset,3)];
                if ([base isEqual:@"///"]) unknown = YES;
                else ceiling = MIN(ceiling,base.doubleValue*100);
            }
        } else if ([@[@"NSC",@"SKC",@"CLR",@"NCD"] containsObject:token]) { cloud = YES; [cloudLayers removeAllObjects]; }
        else if ([token isEqual:@"NSW"]) [weather addObject:@"NSW"];
        else if (Match(token,@"^[+-]?(VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$") || Match(token,@"^(VC)?TS$") || Match(token,@"^RE((VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+|(VC)?TS)$")) [weather addObject:token];
        else if ([token hasPrefix:@"WS"]) [weather addObject:@"Wind shear"];
    }
    if (cavok) {
        result[@"ceilingState"] = @"cavok";
        result[@"ceilingFt"] = [NSNull null];
        result[@"cloudLayers"] = @[];
    } else if (cloud) {
        result[@"ceilingState"] = unknown ? @"unknown" : isfinite(ceiling) ? @"value" : @"none";
        result[@"ceilingFt"] = !unknown && isfinite(ceiling) ? @(ceiling) : [NSNull null];
        result[@"ceiling"] = unknown ? @"Unknown" : isfinite(ceiling) ? Feet(ceiling) : @"None";
        result[@"cloudLayers"] = [cloudLayers copy];
    }
    if (visibilityM) { result[@"visibilityM"] = visibilityM; result[@"visibilityAtLeast"] = @(visibilityAtLeast); }
    if (cb && ![weather containsObject:@"CB"]) [weather addObject:@"CB"];
    if (weather.count) result[@"weather"] = [weather componentsJoinedByString:@" · "];
    return result;
}

// TAF group times are UTC, irrespective of the display timezone.
static NSDate *GroupDate(NSString *stamp, NSDate *anchor) {
    if (!Match(stamp,@"^[0-9]{4}([0-9]{2})?$")) return nil;
    NSInteger day = [[stamp substringToIndex:2] integerValue];
    NSInteger hour = [[stamp substringWithRange:NSMakeRange(2,2)] integerValue];
    NSInteger minute = stamp.length == 6 ? [[stamp substringFromIndex:4] integerValue] : 0;
    if (day<1 || day>31 || hour>24 || minute>59 || (hour==24 && minute)) return nil;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; cal.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    NSDateComponents *parts = [cal components:NSCalendarUnitYear|NSCalendarUnitMonth fromDate:anchor];
    parts.day = 1;
    NSDate *month = [cal dateFromComponents:parts], *best = nil; double bestDistance = INFINITY;
    for (NSInteger offset=-1;offset<=1;offset++) {
        NSDate *candidateMonth = [cal dateByAddingUnit:NSCalendarUnitMonth value:offset toDate:month options:0];
        if ((NSUInteger)day > [cal rangeOfUnit:NSCalendarUnitDay inUnit:NSCalendarUnitMonth forDate:candidateMonth].length) continue;
        NSDate *d = [candidateMonth dateByAddingTimeInterval:(day-1)*86400+hour*3600+minute*60];
        double distance = fabs([d timeIntervalSinceDate:anchor]);
        if (distance<bestDistance) { best=d; bestDistance=distance; }
    }
    return best;
}
static BOOL Prevailing(NSString *kind) { return [@[@"Base",@"FM",@"BECMG"] containsObject:kind]; }

static NSDictionary *TAF(NSDictionary *taf, NSDate *now, NSTimeZone *tz) {
    NSString *raw = Text(taf[@"raw"]);
    raw = [[raw componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] componentsJoinedByString:@" "];
    raw = [Regex(@" +") stringByReplacingMatchesInString:raw options:0 range:NSMakeRange(0,raw.length) withTemplate:@" "];
    raw = [raw stringByReplacingOccurrencesOfString:@"=" withString:@""];
    if (Match(raw,@"\\bCNL\\b")) return @{@"status":@"TAF cancelled",@"periods":@[]};
    if (Match(raw,@"\\bNIL\\b")) return @{@"status":@"TAF unavailable",@"periods":@[]};
    NSDate *from = Date(taf[@"valid_from"]), *to = Date(taf[@"valid_to"]), *issue = Date(taf[@"issue_time"]);
    if (!from || !to || [to compare:from] != NSOrderedDescending || !raw.length) return @{@"status":@"TAF unavailable",@"periods":@[]};
    if ([to compare:now] != NSOrderedDescending) return @{@"status":@"TAF expired",@"periods":@[]};
    NSTextCheckingResult *valid = [Regex(@"\\b[0-9]{4}/[0-9]{4}\\b") firstMatchInString:raw options:0 range:NSMakeRange(0,raw.length)];
    if (!valid) return @{@"status":@"TAF · See source",@"periods":@[]};
    NSString *body = [raw substringFromIndex:NSMaxRange(valid.range)];
    NSString *pattern = @"\\b(FM[0-9]{6}|(?:PROB(?:30|40)(?: (?:TEMPO|INTER))?|BECMG|TEMPO|INTER) [0-9]{4}/[0-9]{4})\\b";
    NSArray *markers = [Regex(pattern) matchesInString:body options:0 range:NSMakeRange(0,body.length)];
    NSMutableArray *groups = [NSMutableArray array]; BOOL invalid = NO;
    for (NSUInteger i=0;i<=markers.count;i++) {
        NSUInteger begin = i ? NSMaxRange([markers[i-1] range]) : 0;
        NSUInteger end = i<markers.count ? [markers[i] range].location : body.length;
        NSString *text = [[body substringWithRange:NSMakeRange(begin,end-begin)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (Match(text,@"\\b(FM\\w*|BECMG|TEMPO|INTER|PROB\\w*|NOSIG|BECOME)\\b")) { invalid=YES; continue; }
        NSString *kind = @"Base", *marker = @""; NSDate *start = from, *finish = to;
        if (i) {
            marker = [body substringWithRange:[markers[i-1] range]];
            if ([marker hasPrefix:@"FM"]) { kind=@"FM"; start=[[marker substringWithRange:NSMakeRange(4,2)] integerValue] < 24 ? GroupDate([marker substringFromIndex:2],from) : nil; }
            else {
                NSRange space = [marker rangeOfString:@" " options:NSBackwardsSearch];
                kind = [marker substringToIndex:space.location];
                NSArray *span = [[marker substringFromIndex:space.location+1] componentsSeparatedByString:@"/"];
                start = GroupDate(span[0],from); finish = GroupDate(span[1],from);
            }
        }
        if (!start || !finish || [start compare:from]==NSOrderedAscending || [start compare:to]!=NSOrderedAscending || [finish compare:start]!=NSOrderedDescending || [finish compare:to]==NSOrderedDescending) { invalid=YES; continue; }
        [groups addObject:[@{@"change":kind,@"start":start,@"end":finish,@"raw":[NSString stringWithFormat:@"%@%@%@",marker,marker.length?@" ":@"",text],@"conditions":Conditions(text)} mutableCopy]];
    }
    // Unknown change syntax makes the period boundaries unreliable. Keep the
    // source available instead of extending a benign group through it.
    if (invalid) return @{@"status":@"TAF · See source",@"periods":@[]};
    [groups sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        NSComparisonResult order=[a[@"start"] compare:b[@"start"]];
        if (order==NSOrderedSame) return Prevailing(a[@"change"]) && !Prevailing(b[@"change"]) ? NSOrderedAscending : !Prevailing(a[@"change"]) && Prevailing(b[@"change"]) ? NSOrderedDescending : NSOrderedSame;
        return order;
    }];
    NSMutableArray *prevailing = [NSMutableArray array];
    for (NSMutableDictionary *g in groups) if (Prevailing(g[@"change"])) [prevailing addObject:g];
    NSMutableDictionary *prior = [NSMutableDictionary dictionary];
    NSMutableArray *continuations = [NSMutableArray array];
    for (NSUInteger i=0;i<prevailing.count;i++) {
        NSMutableDictionary *g=prevailing[i];
        NSDate *next = i+1<prevailing.count ? prevailing[i+1][@"start"] : to;
        if ([g[@"change"] isEqual:@"BECMG"]) {
            NSMutableDictionary *merged=[prior mutableCopy]; [merged addEntriesFromDictionary:g[@"conditions"]];
            g[@"conditions"]=merged;
            if ([g[@"end"] compare:next]==NSOrderedAscending) {
                NSMutableDictionary *after=[g mutableCopy]; after[@"start"]=g[@"end"]; after[@"end"]=next; after[@"change"]=@"After BECMG";
                [continuations addObject:after];
            }
            prior=merged;
        } else { g[@"end"]=next; prior=[g[@"conditions"] mutableCopy]; }
    }
    [groups addObjectsFromArray:continuations];
    [groups sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"start"] compare:b[@"start"]]; }];
    NSMutableArray *periods=[NSMutableArray array];
    for (NSDictionary *g in groups) {
        NSDate *a=g[@"start"], *b=g[@"end"];
        if ([b compare:now]!=NSOrderedDescending || [b compare:a]!=NSOrderedDescending) continue;
        NSDictionary *values=g[@"conditions"];
        [periods addObject:@{@"start":a,@"end":b,@"when":Span(a,b,tz),@"change":g[@"change"],
                             @"ceiling":values[@"ceiling"]?:@"—",
                             @"ceilingFt":values[@"ceilingFt"]?:[NSNull null],
                             @"ceilingState":values[@"ceilingState"]?:@"missing",
                             @"cloudLayers":values[@"cloudLayers"]?:[NSNull null],
                             @"visibility":values[@"visibility"]?:@"—",
                             @"visibilityM":values[@"visibilityM"]?:[NSNull null],
                             @"visibilityAtLeast":values[@"visibilityAtLeast"]?:@NO,
                             @"weather":values[@"weather"]?:@"—",
                             @"hazard":FlyConvectiveHazard(values[@"weather"], values[@"cloudLayers"]),
                             @"hazardTip":FlyConvectiveTip(values[@"weather"], values[@"cloudLayers"]),
                             @"raw":g[@"raw"]}];
    }
    NSString *status=issue ? [NSString stringWithFormat:@"TAF %@ %@",Format(issue,tz,@"EEE"),Clock(issue,tz)] : @"TAF";
    return @{@"status":status,@"periods":periods};
}

NSDictionary *AviationOutlook(NSDictionary *aviation, NSDate *now, NSTimeZone *tz) {
    now=now?:NSDate.date; tz=tz?:[NSTimeZone timeZoneWithName:@"Australia/Perth"];
    if (![aviation isKindOfClass:NSDictionary.class]) aviation=@{};
    NSDictionary *metar=[aviation[@"metar"] isKindOfClass:NSDictionary.class]?aviation[@"metar"]:@{};
    NSDictionary *taf=[aviation[@"taf"] isKindOfClass:NSDictionary.class]?aviation[@"taf"]:@{};
    NSString *raw=Text(metar[@"raw"]); NSDate *time=Date(metar[@"time"]);
    NSDictionary *values=Conditions(raw);
    NSNumber *ceiling=Number(metar[@"ceiling_ft"]), *visibility=Number(metar[@"visibility_m"]);
    NSString *ceilText=ceiling && ceiling.doubleValue>=0?Feet(ceiling.doubleValue):values[@"ceiling"]?:@"—";
    NSString *visText=visibility?Visibility(visibility.doubleValue):values[@"visibility"]?:@"—";
    double age=time?[now timeIntervalSinceDate:time]:0;
    NSString *stale=age>5400?[NSString stringWithFormat:@" · %.0fh old",floor(age/3600)]:@"";
    NSString *ceilPhrase=[ceilText isEqual:@"None"]?@"No ceiling":[@"Ceiling " stringByAppendingString:ceilText];
    NSString *observation=raw.length?[NSString stringWithFormat:@"METAR %@%@ · %@ · Vis %@",time?Clock(time,tz):@"—",stale,ceilPhrase,visText]:@"METAR unavailable";
    NSDictionary *parsed=TAF(taf,now,tz);
    NSString *detail=[NSString stringWithFormat:@"METAR %@\n%@\n\nTAF issued %@\nValid %@ – %@\n%@",Format(time,tz,@"EEE d MMM HH:mm z"),raw.length?raw:@"Unavailable",Format(Date(taf[@"issue_time"]),tz,@"EEE d MMM HH:mm z"),Format(Date(taf[@"valid_from"]),tz,@"EEE d MMM HH:mm z"),Format(Date(taf[@"valid_to"]),tz,@"EEE d MMM HH:mm z"),Text(taf[@"raw"]).length?taf[@"raw"]:@"Unavailable"];
    return @{@"observation":observation,@"periods":parsed[@"periods"],@"status":parsed[@"status"],@"detail":detail};
}

static double FlyKm(double lat1, double lon1, double lat2, double lon2) {
    double r = 6371.0, p1 = lat1 * M_PI / 180.0, p2 = lat2 * M_PI / 180.0;
    double dp = (lat2 - lat1) * M_PI / 180.0, dl = (lon2 - lon1) * M_PI / 180.0;
    double a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2);
    return 2 * r * atan2(sqrt(a), sqrt(1 - a));
}
static BOOL FlyPoint(NSDictionary *row, double *lat, double *lon) {
    NSNumber *la = Number(row[@"latitude"]), *lo = Number(row[@"longitude"]);
    if (!la || !lo) return NO;
    if (lat) *lat = la.doubleValue;
    if (lon) *lon = lo.doubleValue;
    return YES;
}
static NSString *FlyCode(NSDictionary *field) {
    NSString *code = Text(field[@"code"]);
    return code.length ? code.uppercaseString : @"";
}
static BOOL FlyHasTAF(NSDictionary *field) {
    id flag = field[@"hasTAF"];
    return !([flag isKindOfClass:NSNumber.class] && ![flag boolValue]);
}
static NSString *FlyCompass(double degrees) {
    static NSString *const names[] = {@"N", @"NE", @"E", @"SE", @"S", @"SW", @"W", @"NW"};
    double wrapped = degrees - 360.0 * floor(degrees / 360.0);
    int idx = (int)lround(wrapped / 45.0) % 8;
    if (idx < 0) idx += 8;
    return names[idx];
}
static NSString *FlyCompassWord(NSString *point) {
    NSDictionary *words = @{@"N": @"north", @"NE": @"northeast", @"E": @"east", @"SE": @"southeast",
        @"S": @"south", @"SW": @"southwest", @"W": @"west", @"NW": @"northwest"};
    return words[point] ?: point;
}
static NSString *FlyGroupedKm(double km) {
    NSNumberFormatter *f = [NSNumberFormatter new];
    f.numberStyle = NSNumberFormatterDecimalStyle;
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU"];
    f.maximumFractionDigits = 0;
    return [f stringFromNumber:@(round(km))] ?: [NSString stringWithFormat:@"%.0f", round(km)];
}
static BOOL FlySeparation(NSDictionary *place, NSDictionary *aerodrome, double *km, NSString **compass) {
    double lat1, lon1, lat2, lon2;
    if (!FlyPoint(place, &lat1, &lon1) || !FlyPoint(aerodrome, &lat2, &lon2)) return NO;
    double p1 = lat1 * M_PI / 180.0, p2 = lat2 * M_PI / 180.0, dl = (lon2 - lon1) * M_PI / 180.0;
    double y = sin(dl) * cos(p2);
    double x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl);
    double bearing = atan2(y, x) * 180.0 / M_PI;
    if (km) *km = FlyKm(lat1, lon1, lat2, lon2);
    if (compass) *compass = FlyCompass(bearing);
    return YES;
}

NSString *FlyPlaceKey(NSDictionary *place) {
    NSString *hash = Text(place[@"geohash"]);
    if (hash.length) return hash;
    return Text(place[@"name"]);
}
NSString *FlyIdentityTitle(NSDictionary *aerodrome) {
    NSString *code = FlyCode(aerodrome), *name = Text(aerodrome[@"name"]);
    if (!code.length) return name.length ? name : @"Airport";
    if (!name.length || [name caseInsensitiveCompare:code] == NSOrderedSame) return code;
    return [NSString stringWithFormat:@"%@ · %@", name, code];
}
NSString *FlyDistanceCompact(NSDictionary *place, NSDictionary *aerodrome) {
    double km = 0; NSString *compass = nil;
    if (!FlySeparation(place, aerodrome, &km, &compass)) return nil;
    return [NSString stringWithFormat:@"%@ km %@", FlyGroupedKm(km), compass];
}
NSString *FlyIdentityRow(NSDictionary *place, NSDictionary *aerodrome) {
    NSString *code = FlyCode(aerodrome);
    NSString *dist = FlyDistanceCompact(place, aerodrome);
    if (!code.length) return dist.length ? dist : (Text(aerodrome[@"name"]).length ? Text(aerodrome[@"name"]) : @"Airport");
    if (!dist.length) return code;
    return [NSString stringWithFormat:@"%@  %@", code, dist];
}
NSString *FlyDistancePhrase(NSDictionary *place, NSDictionary *aerodrome) {
    double km = 0; NSString *compass = nil;
    if (!FlySeparation(place, aerodrome, &km, &compass)) return nil;
    NSString *name = Text(place[@"name"]);
    if (!name.length) name = @"this place";
    return [NSString stringWithFormat:@"%@ km %@ of %@", FlyGroupedKm(km), compass, name];
}
NSString *FlyDistanceSpeech(NSDictionary *place, NSDictionary *aerodrome) {
    double km = 0; NSString *compass = nil;
    if (!FlySeparation(place, aerodrome, &km, &compass)) return nil;
    NSString *name = Text(place[@"name"]);
    if (!name.length) name = @"this place";
    NSString *unit = round(km) == 1 ? @"kilometre" : @"kilometres";
    return [NSString stringWithFormat:@"%@ %@ %@ of %@", FlyGroupedKm(km), unit, FlyCompassWord(compass), name];
}
NSDictionary *FlyNearestTAFAerodrome(NSDictionary *place, NSArray<NSDictionary *> *aerodromes) {
    double lat, lon;
    if (!FlyPoint(place, &lat, &lon)) return nil;
    NSDictionary *best = nil; double bestKm = INFINITY;
    for (NSDictionary *field in aerodromes) {
        if (![field isKindOfClass:NSDictionary.class] || !FlyHasTAF(field) || !FlyCode(field).length) continue;
        double flat, flon;
        if (!FlyPoint(field, &flat, &flon)) continue;
        double km = FlyKm(lat, lon, flat, flon);
        if (km < bestKm) { bestKm = km; best = field; }
    }
    return best;
}
NSDictionary *FlyAerodromeCue(NSDictionary *place, NSDictionary *shown, NSArray<NSDictionary *> *aerodromes) {
    NSDictionary *nearest = FlyNearestTAFAerodrome(place, aerodromes);
    NSString *shownCode = FlyCode(shown), *nearCode = FlyCode(nearest);
    if (!shownCode.length || !nearCode.length || [shownCode isEqual:nearCode]) return nil;
    return @{@"code": nearCode,
             @"action": [NSString stringWithFormat:@"Nearest: %@", nearCode]};
}
NSDictionary *FlyAerodromeForPlace(NSDictionary *place, NSArray<NSDictionary *> *aerodromes, NSDictionary *sessionPins) {
    NSString *key = FlyPlaceKey(place);
    NSString *pinned = key.length ? FlyCode(@{@"code": sessionPins[key] ?: @""}) : @"";
    if (pinned.length) {
        for (NSDictionary *field in aerodromes)
            if ([FlyCode(field) isEqual:pinned]) return field;
    }
    return FlyNearestTAFAerodrome(place, aerodromes);
}

static NSString *CloudGroup(NSDictionary *layer) {
    NSString *amount = Text(layer[@"amount"]);
    NSString *type = Text(layer[@"type"]);
    id base = layer[@"baseFt"];
    if (![base isKindOfClass:NSNumber.class]) return [NSString stringWithFormat:@"%@///%@", amount, type];
    return [NSString stringWithFormat:@"%@%03d%@", amount, (int)llround([base doubleValue] / 100.0), type];
}
static NSString *GroupedFeet(double value) {
    NSNumberFormatter *f = [NSNumberFormatter new];
    f.numberStyle = NSNumberFormatterDecimalStyle;
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU"];
    f.maximumFractionDigits = 0;
    return [f stringFromNumber:@(value)] ?: [NSString stringWithFormat:@"%.0f", value];
}
static BOOL TokenHasThunderstorm(NSString *token, BOOL *vicinity, BOOL *recent) {
    if (vicinity) *vicinity = NO;
    if (recent) *recent = NO;
    if (!token.length || [token isEqual:@"—"] || [token isEqual:@"NSW"] || [token isEqual:@"CAVOK"]) return NO;
    NSString *body = token;
    if ([body hasPrefix:@"RE"] && body.length > 2) {
        if (recent) *recent = YES;
        body = [body substringFromIndex:2];
    }
    if ([body hasPrefix:@"+"] || [body hasPrefix:@"-"]) body = [body substringFromIndex:1];
    if ([body hasPrefix:@"VC"]) {
        if (vicinity) *vicinity = YES;
        body = [body substringFromIndex:2];
    }
    for (NSString *prefix in @[@"MI", @"PR", @"BC", @"DR", @"BL", @"SH", @"FZ"])
        if ([body hasPrefix:prefix]) { body = [body substringFromIndex:prefix.length]; break; }
    return [body hasPrefix:@"TS"];
}
static void ConvectiveFlags(NSString *weather, NSArray *cloudLayers, BOOL *ts, BOOL *vcts, BOOL *cb, BOOL *tcu, BOOL *recentTS) {
    *ts = *vcts = *cb = *tcu = *recentTS = NO;
    if (![cloudLayers isKindOfClass:NSArray.class]) cloudLayers = nil;
    for (NSString *token in [Text(weather) componentsSeparatedByString:@" · "]) {
        BOOL vicinity = NO, recent = NO;
        if ([token isEqual:@"CB"]) *cb = YES;
        if ([token isEqual:@"TCU"]) *tcu = YES;
        if (!TokenHasThunderstorm(token, &vicinity, &recent)) continue;
        if (recent) *recentTS = YES;
        else if (vicinity) *vcts = YES;
        else *ts = YES;
    }
    for (NSDictionary *layer in cloudLayers) {
        if (![layer isKindOfClass:NSDictionary.class]) continue;
        if ([Text(layer[@"type"]) isEqual:@"CB"]) *cb = YES;
        if ([Text(layer[@"type"]) isEqual:@"TCU"]) *tcu = YES;
    }
}
NSString *FlyConvectiveHazard(NSString *weather, NSArray *cloudLayers) {
    BOOL ts, vcts, cb, tcu, recentTS;
    ConvectiveFlags(weather, cloudLayers, &ts, &vcts, &cb, &tcu, &recentTS);
    if (ts) return @"TS";
    if (vcts) return @"VCTS";
    if (cb) return @"CB";
    if (tcu) return @"TCU";
    return @"";
}
static NSString *BasePhrase(NSDictionary *layer) {
    NSString *type = Text(layer[@"type"]);
    if (![type isEqual:@"CB"] && ![type isEqual:@"TCU"]) return nil;
    id base = layer[@"baseFt"];
    if (![base isKindOfClass:NSNumber.class] || !isfinite([base doubleValue]))
        return [NSString stringWithFormat:@"%@ base unknown", type];
    return [NSString stringWithFormat:@"%@ base %@ ft", type, GroupedFeet([base doubleValue])];
}
NSString *FlyConvectiveTip(NSString *weather, NSArray *cloudLayers) {
    BOOL ts, vcts, cb, tcu, recentTS;
    ConvectiveFlags(weather, cloudLayers, &ts, &vcts, &cb, &tcu, &recentTS);
    NSMutableArray *parts = [NSMutableArray array];
    if (ts) [parts addObject:@"Thunderstorm"];
    else if (vcts) [parts addObject:@"Thunderstorm in vicinity"];
    NSMutableArray *named = [NSMutableArray array];
    if (![cloudLayers isKindOfClass:NSArray.class]) cloudLayers = nil;
    for (NSDictionary *layer in cloudLayers) {
        NSString *phrase = BasePhrase(layer);
        if (phrase) [named addObject:@{@"phrase": phrase, @"type": Text(layer[@"type"]),
            @"base": [layer[@"baseFt"] isKindOfClass:NSNumber.class] ? layer[@"baseFt"] : @(INFINITY)}];
    }
    [named sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        BOOL ac = [a[@"type"] isEqual:@"CB"], bc = [b[@"type"] isEqual:@"CB"];
        if (ac != bc) return ac ? NSOrderedAscending : NSOrderedDescending;
        return [a[@"base"] compare:b[@"base"]];
    }];
    for (NSDictionary *item in named) [parts addObject:item[@"phrase"]];
    if (recentTS) [parts addObject:@"Recent thunderstorm"];
    return parts.count ? [parts componentsJoinedByString:@" · "] : @"";
}
static NSString *FlyCloudDatum(NSArray *cloudLayers, NSString *ceilingFallback) {
    if (![cloudLayers isKindOfClass:NSArray.class]) cloudLayers = nil;
    NSMutableArray *lead = [NSMutableArray array], *rest = [NSMutableArray array];
    for (NSDictionary *layer in cloudLayers) {
        if (![layer isKindOfClass:NSDictionary.class]) continue;
        NSString *type = Text(layer[@"type"]);
        if ([type isEqual:@"CB"] || [type isEqual:@"TCU"]) {
            id base = layer[@"baseFt"];
            NSString *height = [base isKindOfClass:NSNumber.class] && isfinite([base doubleValue]) ? GroupedFeet([base doubleValue]) : @"—";
            [lead addObject:@{@"text": [NSString stringWithFormat:@"%@ %@", type, height], @"type": type,
                @"base": [base isKindOfClass:NSNumber.class] ? base : @(INFINITY)}];
        } else [rest addObject:CloudGroup(layer)];
    }
    if (!lead.count) return rest.count ? [rest componentsJoinedByString:@"/"] : (Text(ceilingFallback).length ? Text(ceilingFallback) : @"—");
    [lead sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        BOOL ac = [a[@"type"] isEqual:@"CB"], bc = [b[@"type"] isEqual:@"CB"];
        if (ac != bc) return ac ? NSOrderedAscending : NSOrderedDescending;
        return [a[@"base"] compare:b[@"base"]];
    }];
    NSMutableArray *parts = [NSMutableArray array];
    for (NSDictionary *item in lead) [parts addObject:item[@"text"]];
    [parts addObjectsFromArray:rest];
    return [parts componentsJoinedByString:@" · "];
}
NSDate *FlyDate(id value) { return Date(value); }
NSDictionary *FlyMetarInstrument(NSString *raw, NSDate *time, NSDate *now, NSTimeZone *zone) {
    zone = zone ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    now = now ?: NSDate.date;
    NSString *text = Text(raw);
    NSDictionary *values = Conditions(text);
    NSString *cloud = FlyCloudDatum(values[@"cloudLayers"], values[@"ceiling"]);
    NSString *hazard = FlyConvectiveHazard(values[@"weather"], values[@"cloudLayers"]);
    NSString *hazardTip = FlyConvectiveTip(values[@"weather"], values[@"cloudLayers"]);
    NSString *vis = Text(values[@"visibility"]).length ? Text(values[@"visibility"]) : @"—";
    NSString *wind = @"—", *gust = nil;
    NSTextCheckingResult *hit = [Regex(@"\\b((?:[0-9]{3})|VRB)([0-9]{2})(?:G([0-9]{2}))?KT\\b") firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (hit && hit.numberOfRanges >= 3) {
        NSString *dir = [text substringWithRange:[hit rangeAtIndex:1]];
        NSString *spd = [text substringWithRange:[hit rangeAtIndex:2]];
        wind = [NSString stringWithFormat:@"%@/%@", dir, spd];
        if ([hit rangeAtIndex:3].location != NSNotFound) gust = [text substringWithRange:[hit rangeAtIndex:3]];
    }
    NSString *clock = time ? Format(time, zone, @"HH:mm") : @"—";
    double age = time ? [now timeIntervalSinceDate:time] : 0;
    if (age < 0) age = 0;
    BOOL aged = time && age > 5400;
    NSString *ageText = time ? (age < 3600
        ? [NSString stringWithFormat:@"%.0f m", floor(age / 60.0)]
        : [NSString stringWithFormat:@"%.0f h", floor(age / 3600.0)]) : @"—";
    NSString *tip = text.length ? text : @"METAR unavailable";
    if (hazardTip.length) tip = [hazardTip stringByAppendingFormat:@"\n%@", tip];
    if (gust.length) tip = [tip stringByAppendingFormat:@"\nGust %d kt", gust.intValue];
    if (aged) tip = [tip stringByAppendingFormat:@"\nObserved %@, %.0f h ago", clock, floor(age / 3600.0)];
    return @{@"cloud": cloud, @"vis": vis, @"wind": wind, @"clock": clock,
             @"age": ageText, @"aged": @(aged), @"tip": tip,
             @"hazard": hazard ?: @"", @"hazardTip": hazardTip ?: @"",
             @"line": [NSString stringWithFormat:@"%@   %@   %@   ·   %@   ·   %@", cloud, vis, wind, clock, ageText]};
}
static NSString *ValidityStamp(NSDate *date, NSTimeZone *zone) {
    if (!date) return @"—";
    return [NSString stringWithFormat:@"%@ %@", Format(date, zone, @"d"), Format(date, zone, @"HH:mm")];
}
NSString *FlyValidityRow(NSDate *from, NSDate *to, NSTimeZone *zone) {
    zone = zone ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    if (!from || !to) return @"TAF";
    return [NSString stringWithFormat:@"TAF %@ → %@", ValidityStamp(from, zone), ValidityStamp(to, zone)];
}
NSString *FlyValidityUTC(NSDate *from, NSDate *to) {
    if (!from || !to) return @"UTC validity unavailable";
    NSTimeZone *utc = [NSTimeZone timeZoneWithName:@"UTC"];
    return [NSString stringWithFormat:@"%@ → %@ UTC", ValidityStamp(from, utc), ValidityStamp(to, utc)];
}
NSString *AviationTAFWrapped(NSString *raw) {
    NSString *text = Text(raw);
    if (!text.length) return @"";
    text = [[text componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] componentsJoinedByString:@" "];
    text = [Regex(@" +") stringByReplacingMatchesInString:text options:0 range:NSMakeRange(0, text.length) withTemplate:@" "];
    text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    NSString *pattern = @"\\b(?:FM[0-9]{6}|PROB(?:30|40)(?: (?:TEMPO|INTER))? [0-9]{4}/[0-9]{4}|(?:BECMG|TEMPO|INTER) [0-9]{4}/[0-9]{4})\\b";
    NSArray *marks = [Regex(pattern) matchesInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!marks.count) return text;
    NSMutableString *out = [NSMutableString string];
    NSUInteger cursor = 0;
    for (NSTextCheckingResult *mark in marks) {
        if (mark.range.location <= cursor) continue;
        NSString *chunk = [[text substringWithRange:NSMakeRange(cursor, mark.range.location - cursor)]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (chunk.length) {
            if (out.length) [out appendString:@"\n"];
            [out appendString:chunk];
        }
        cursor = mark.range.location;
    }
    NSString *tail = [[text substringFromIndex:cursor] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if (tail.length) {
        if (out.length) [out appendString:@"\n"];
        [out appendString:tail];
    }
    return out;
}
static NSString *BulletinStamp(NSDate *date, NSTimeZone *tz) {
    if (!date) return nil;
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = tz;
    f.dateFormat = @"EEE d MMM HH:mm zzz";
    return [f stringFromDate:date];
}
static NSString *BulletinUTC(NSDate *date) {
    if (!date) return nil;
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    f.dateFormat = @"d MMM HH:mm";
    return [[f stringFromDate:date] stringByAppendingString:@" UTC"];
}
static BOOL BulletinCovers(NSDictionary *period, NSDate *playhead) {
    NSDate *a = period[@"start"], *b = period[@"end"];
    if (!playhead || ![a isKindOfClass:NSDate.class] || ![b isKindOfClass:NSDate.class]) return NO;
    return [playhead compare:a] != NSOrderedAscending && [playhead compare:b] == NSOrderedAscending;
}
// The station is the ICAO in the report, after METAR/SPECI/TAF and an optional
// AMD/COR/RTD. A metadata ICAO that disagrees with that text does not count.
static NSString *ReportStation(NSString *raw) {
    NSString *text = [Text(raw) uppercaseString];
    if (!text.length) return @"";
    NSTextCheckingResult *hit = [Regex(@"\\b(?:METAR|SPECI|TAF)\\b(?:\\s+(?:AMD|COR|RTD))*\\s+([A-Z]{4})\\b")
        firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!hit || hit.numberOfRanges < 2 || [hit rangeAtIndex:1].location == NSNotFound) return @"";
    return [text substringWithRange:[hit rangeAtIndex:1]];
}
static NSString *MetaStation(id value) {
    NSString *code = Text(value).uppercaseString;
    return Match(code, @"^[A-Z]{4}$") ? code : @"";
}
static BOOL ReportMatchesAerodrome(NSString *raw, id metadata, NSString *selected) {
    NSString *want = Text(selected).uppercaseString;
    if (!Text(raw).length || !want.length) return NO;
    NSString *fromRaw = ReportStation(raw), *fromMeta = MetaStation(metadata);
    if (!fromRaw.length) return NO;
    if (fromMeta.length && ![fromMeta isEqual:fromRaw]) return NO;
    return [fromRaw isEqual:want];
}

NSDictionary *AviationBulletin(NSDictionary *aviation, NSString *icao, NSDate *playhead, NSTimeZone *placeZone) {
    placeZone = placeZone ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSString *code = Text(icao).length ? icao.uppercaseString : @"";
    if (![aviation isKindOfClass:NSDictionary.class]) aviation = @{};
    NSDictionary *metar = [aviation[@"metar"] isKindOfClass:NSDictionary.class] ? aviation[@"metar"] : @{};
    NSDictionary *taf = [aviation[@"taf"] isKindOfClass:NSDictionary.class] ? aviation[@"taf"] : @{};
    NSString *metarRaw = [Text(metar[@"raw"]) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSString *tafRaw = [Text(taf[@"raw"]) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    id metarMeta = MetaStation(metar[@"icao"]).length ? metar[@"icao"] : aviation[@"icao"];
    id tafMeta = MetaStation(taf[@"icao"]).length ? taf[@"icao"] : aviation[@"icao"];
    BOOL metarOK = ReportMatchesAerodrome(metarRaw, metarMeta, code);
    BOOL tafOK = ReportMatchesAerodrome(tafRaw, tafMeta, code);
    BOOL metarForeign = metarRaw.length && code.length && !metarOK;
    BOOL tafForeign = tafRaw.length && code.length && !tafOK;
    NSString *metarMissing = code.length ? [NSString stringWithFormat:@"METAR for %@ unavailable", code] : @"METAR unavailable";
    NSString *metarText = metarForeign ? metarMissing : (metarRaw.length ? metarRaw : @"METAR unavailable");
    NSDictionary *outlook = AviationOutlook(aviation, playhead ?: NSDate.date, placeZone);
    NSString *wrapped = tafOK ? AviationTAFWrapped(tafRaw) : @"";
    BOOL issued = wrapped.length > 0;
    NSString *missing = tafForeign
        ? [NSString stringWithFormat:@"No TAF for %@ yet", code]
        : (code.length ? [NSString stringWithFormat:@"No TAF issued for %@", code] : @"No TAF issued");
    NSArray *sourceLines = issued ? [wrapped componentsSeparatedByString:@"\n"] : @[];
    NSMutableArray *lines = [NSMutableArray array];
    for (NSString *line in sourceLines) {
        if (!line.length) continue;
        BOOL active = NO;
        if (playhead) {
            for (NSDictionary *period in outlook[@"periods"]) {
                NSString *raw = Text(period[@"raw"]);
                if (raw.length && BulletinCovers(period, playhead) && [line containsString:raw]) active = YES;
            }
        }
        [lines addObject:@{@"text": line, @"active": @(active)}];
    }
    NSDate *issue = Date(taf[@"issue_time"]), *from = Date(taf[@"valid_from"]), *to = Date(taf[@"valid_to"]);
    NSString *issuedLine = nil, *validLine = nil;
    if (issued) {
        NSString *localIssue = BulletinStamp(issue, placeZone), *utcIssue = BulletinUTC(issue);
        issuedLine = localIssue && utcIssue ? [NSString stringWithFormat:@"Issued %@ · %@", localIssue, utcIssue] : @"Issue time unavailable";
        NSString *localFrom = BulletinStamp(from, placeZone), *localTo = BulletinStamp(to, placeZone);
        NSString *utcFrom = BulletinUTC(from), *utcTo = BulletinUTC(to);
        validLine = localFrom && localTo && utcFrom && utcTo
            ? [NSString stringWithFormat:@"Valid %@ – %@ · %@ – %@", localFrom, localTo, utcFrom, utcTo]
            : @"Validity unavailable";
    }
    NSString *tafText = issued ? wrapped : missing;
    NSString *observation = metarForeign ? metarMissing : (metarOK ? (outlook[@"observation"] ?: @"METAR unavailable") : @"METAR unavailable");
    return @{@"metar": metarText,
             @"observation": observation,
             @"taf": tafText,
             @"issued": issuedLine ?: @"",
             @"valid": validLine ?: @"",
             @"source": tafForeign ? @"" : (outlook[@"status"] ?: @""),
             @"lines": lines,
             @"missingTAF": @(!issued),
             @"metarMatches": @(metarOK),
             @"tafMatches": @(tafOK),
             @"tafForeign": @(tafForeign)};
}
