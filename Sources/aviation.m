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
        if ([token isEqual:@"CAVOK"]) { cavok = YES; cloud = YES; [cloudLayers removeAllObjects]; visibilityAtLeast = YES; visibilityM = @9999; result[@"visibility"] = @"10+ km"; result[@"ceiling"] = @"CAVOK"; result[@"weather"] = @"CAVOK"; }
        else if (Match(token,@"^[0-9]{4}$")) { visibilityM = @(token.doubleValue); visibilityAtLeast = token.doubleValue >= 9999; result[@"visibility"] = Visibility(token.doubleValue); }
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
        else if (Match(token,@"^[+-]?(VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$") || Match(token,@"^(VC)?TS$")) [weather addObject:token];
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
                             @"weather":values[@"weather"]?:@"—",@"raw":g[@"raw"]}];
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
    NSString *observation=raw.length?[NSString stringWithFormat:@"METAR %@%@ · Ceiling %@ · Vis %@",time?Clock(time,tz):@"—",stale,ceilText,visText]:@"METAR unavailable";
    NSDictionary *parsed=TAF(taf,now,tz);
    NSString *detail=[NSString stringWithFormat:@"METAR %@\n%@\n\nTAF issued %@\nValid %@ – %@\n%@",Format(time,tz,@"EEE d MMM HH:mm z"),raw.length?raw:@"Unavailable",Format(Date(taf[@"issue_time"]),tz,@"EEE d MMM HH:mm z"),Format(Date(taf[@"valid_from"]),tz,@"EEE d MMM HH:mm z"),Format(Date(taf[@"valid_to"]),tz,@"EEE d MMM HH:mm z"),Text(taf[@"raw"]).length?taf[@"raw"]:@"Unavailable"];
    return @{@"observation":observation,@"periods":parsed[@"periods"],@"status":parsed[@"status"],@"detail":detail};
}
