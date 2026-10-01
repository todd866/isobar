#import "rain.h"
#import <math.h>

static NSString *Day(NSDate *date, NSDate *now, NSCalendar *cal) {
    NSDate *today = [cal startOfDayForDate:now ?: date];
    NSDate *day = [cal startOfDayForDate:date];
    NSInteger delta = [cal components:NSCalendarUnitDay fromDate:today toDate:day options:0].day;
    if (now && delta == 0) return @"Today";
    if (now && delta == 1) return @"Tomorrow";
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = cal.timeZone;
    f.dateFormat = @"EEE";
    return [f stringFromDate:date] ?: @"";
}

static NSString *Clock(NSDate *date, NSCalendar *cal) {
    NSDateFormatter *f = [NSDateFormatter new];
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone = cal.timeZone;
    f.dateFormat = @"h a";
    return [[f stringFromDate:date] lowercaseString] ?: @"";
}

static NSString *Amount(double mm) {
    if (mm <= 0) return @"0";
    if (mm < 0.1) return @"<0.1";
    return mm < 10 ? [NSString stringWithFormat:@"%.1f", mm] : [NSString stringWithFormat:@"%.0f", mm];
}

static BOOL ValidAmount(id value, double *amount) {
    if (![value isKindOfClass:NSNumber.class]) return NO;
    double n = [value doubleValue];
    if (!isfinite(n) || n < 0) return NO;
    if (amount) *amount = n;
    return YES;
}

static BOOL ValidWeatherCode(id value, NSInteger *codeOut) {
    if (![value isKindOfClass:NSNumber.class]) return NO;
    double raw = [value doubleValue];
    if (!isfinite(raw) || raw < 0 || raw > 99 || floor(raw) != raw) return NO;
    if (codeOut) *codeOut = (NSInteger)raw;
    return YES;
}

static NSString *KindForCode(id value) {
    NSInteger code = 0;
    if (!ValidWeatherCode(value, &code)) return nil;
    if (code == 0) return @"Clear";
    if (code <= 3) return @"Cloud";
    if (code == 45 || code == 48) return @"Fog";
    if (code == 51 || code == 53 || code == 55 || code == 56 || code == 57) return @"Drizzle";
    if (code == 61) return @"Light rain";
    if (code == 63) return @"Rain";
    if (code == 65) return @"Heavy rain";
    if (code == 66 || code == 67) return @"Freezing rain";
    if (code == 71 || code == 73 || code == 75 || code == 77 || code == 85 || code == 86) return @"Snow";
    if (code == 80) return @"Light showers";
    if (code == 81) return @"Showers";
    if (code == 82) return @"Heavy showers";
    if (code == 95 || code == 96 || code == 97 || code == 99) return @"Thunderstorms";
    return nil;
}

static NSString *Amount24(double mm) {
    if (mm <= 0) return @"0 mm · 24h";
    if (mm < 1) return @"<1 mm · 24h";
    return [NSString stringWithFormat:@"~%ld mm · 24h", (long)lround(mm)];
}

static NSDate *HourFloor(NSDate *date, NSCalendar *cal);

static NSString *ShortPeriod(NSDate *date, NSDate *now, NSCalendar *cal) {
    NSDate *today = [cal startOfDayForDate:now ?: date];
    NSDate *day = [cal startOfDayForDate:date];
    NSInteger delta = [cal components:NSCalendarUnitDay fromDate:today toDate:day options:0].day;
    NSInteger hour = [cal component:NSCalendarUnitHour fromDate:date];
    if (now && delta == 0) {
        if ([date isEqual:HourFloor(now, cal)]) return @"now";
        if (hour >= 17) return @"tonight";
        if (hour < 12) return @"this morning";
        return @"this afternoon";
    }
    if (delta == 1) {
        if (hour < 12) return @"tomorrow morning";
        if (hour < 17) return @"tomorrow afternoon";
        return @"tomorrow evening";
    }
    NSString *name = Day(date, now, cal);
    if (hour < 12) return [NSString stringWithFormat:@"%@ morning", name];
    if (hour < 17) return [NSString stringWithFormat:@"%@ afternoon", name];
    return [NSString stringWithFormat:@"%@ evening", name];
}

static NSDate *HourFloor(NSDate *date, NSCalendar *cal) {
    NSDate *start = nil;
    [cal rangeOfUnit:NSCalendarUnitHour startDate:&start interval:NULL forDate:date];
    return start ?: date;
}

static NSString *Span(NSDate *start, NSDate *end, NSDate *now, NSCalendar *cal) {
    BOOL current = [start isEqual:HourFloor(now, cal)];
    NSString *day = Day(start, now, cal);
    NSString *lastDay = Day(end, now, cal);
    NSString *firstClock = Clock(start, cal);
    NSString *lastClock = Clock(end, cal);
    if ([start isEqual:end]) return current ? @"Now" : [NSString stringWithFormat:@"%@ %@", day, firstClock];
    if (current) return [NSString stringWithFormat:@"Now–%@", lastClock];
    if ([day isEqual:lastDay]) {
        NSString *firstSuffix = [firstClock substringFromIndex:firstClock.length - 2];
        NSString *lastSuffix = [lastClock substringFromIndex:lastClock.length - 2];
        if ([firstSuffix isEqual:lastSuffix]) {
            NSString *first = [firstClock substringToIndex:firstClock.length - 3];
            NSString *last = [lastClock substringToIndex:lastClock.length - 3];
            return [NSString stringWithFormat:@"%@ %@–%@ %@", day, first, last, firstSuffix];
        }
        return [NSString stringWithFormat:@"%@ %@–%@", day, firstClock, lastClock];
    }
    return [NSString stringWithFormat:@"%@ %@–%@ %@", day, firstClock, lastDay, lastClock];
}

static NSDictionary *DetailedRainOutlook(NSArray<NSDictionary *> *rows, NSDate *now, NSTimeZone *tz) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    if (!now) return @{@"line": @"Rain unavailable", @"detail": @"", @"headline": @"Rain unavailable",
        @"amount24": @"— · 24h", @"hours": @[]};
    NSMutableDictionary *byHour = [NSMutableDictionary dictionary];
    for (NSDictionary *row in rows) {
        if (![row isKindOfClass:NSDictionary.class] || ![row[@"time"] isKindOfClass:NSDate.class]) continue;
        double mm = 0;
        if (!ValidAmount(row[@"rainMm"], &mm)) continue;
        NSDate *end = HourFloor(row[@"time"], cal);
        NSString *kind = KindForCode(row[@"weatherCode"]);
        if (!kind) kind = mm > 0 ? @"Rain" : @"Dry";
        if (mm > 0 && ([kind isEqual:@"Clear"] || [kind isEqual:@"Cloud"] || [kind isEqual:@"Fog"]))
            kind = @"Rain";
        byHour[@([end timeIntervalSince1970])] = @{@"end": end, @"mm": @(mm), @"kind": kind};
    }
    if (!byHour.count) return @{@"line": @"Rain unavailable", @"detail": @"", @"headline": @"Rain unavailable",
        @"amount24": @"— · 24h", @"hours": @[]};
    NSDate *floorNow = HourFloor(now, cal);
    NSMutableArray *buckets = [NSMutableArray array];
    for (NSInteger i = 0; i < 48; i++) {
        NSDate *end = [cal dateByAddingUnit:NSCalendarUnitHour value:i + 1 toDate:floorNow options:0];
        NSDictionary *source = byHour[@([end timeIntervalSince1970])];
        [buckets addObject:@{@"start": [end dateByAddingTimeInterval:-3600], @"end": end,
            @"known": @(source != nil), @"mm": source ? source[@"mm"] : @0,
            @"kind": source ? source[@"kind"] : @"Rain"}];
    }
    NSInteger firstKnown = NSNotFound;
    for (NSInteger i = 0; i < (NSInteger)buckets.count; i++)
        if ([buckets[i][@"known"] boolValue]) { firstKnown = i; break; }
    if (firstKnown == NSNotFound) return @{@"line": @"Rain unavailable", @"detail": @"",
        @"headline": @"Rain unavailable", @"amount24": @"— · 24h", @"hours": buckets};
    NSInteger eventStart = NSNotFound, eventEnd = NSNotFound;
    BOOL gapBeforeEvent = NO;
    BOOL eventTruncated = NO;
    for (NSInteger i = 0; i < (NSInteger)buckets.count; i++) {
        if (![buckets[i][@"known"] boolValue]) {
            if (eventStart != NSNotFound) {
                eventTruncated = YES;
                break;
            }
            if (i > firstKnown) gapBeforeEvent = YES;
            continue;
        }
        double mm = [buckets[i][@"mm"] doubleValue];
        if (mm > 0) {
            if (eventStart == NSNotFound) eventStart = i;
            eventEnd = i;
        } else if (eventStart != NSNotFound) break;
    }
    if (eventEnd == (NSInteger)buckets.count - 1) eventTruncated = YES;
    NSMutableString *detail = [NSMutableString string];
    for (NSInteger i = 0; i < MIN((NSInteger)buckets.count, 24); i++) {
        if (![buckets[i][@"known"] boolValue]) continue;
        [detail appendFormat:@"%@ %@–%@ · %@ mm\n", Day(buckets[i][@"start"], now, cal), Clock(buckets[i][@"start"], cal),
            Clock(buckets[i][@"end"], cal), Amount([buckets[i][@"mm"] doubleValue])];
    }
    NSString *prefix = (firstKnown > 0 || gapBeforeEvent)
        ? @"Forecast incomplete"
        : @"";
    if (eventStart != NSNotFound) {
        NSDate *start = buckets[eventStart][@"start"];
        NSDate *end = buckets[eventEnd][@"end"];
        double total = 0;
        for (NSInteger i = eventStart; i <= eventEnd; i++) total += [buckets[i][@"mm"] doubleValue];
        NSString *totalText = eventTruncated && total < 0.1 ? @"Trace" : [NSString stringWithFormat:@"%@%@ mm", Amount(total), eventTruncated ? @"+" : @""];
        NSString *span = Span(start, end, now, cal);
        if (eventTruncated) span = [start isEqual:floorNow] ? @"Now" : [NSString stringWithFormat:@"From %@ %@", Day(start, now, cal), Clock(start, cal)];
        NSString *line = [NSString stringWithFormat:@"%@ · %@", span, totalText];
        if (prefix.length) line = [NSString stringWithFormat:@"%@ · %@", prefix, line];
        NSMutableDictionary *out = [@{@"line": line, @"detail": detail,
            @"eventStart": start, @"eventEnd": end, @"total24": @"—"} mutableCopy];
        BOOL complete = YES;
        double total24 = 0;
        for (NSInteger i = 0; i < 24; i++) {
            if (![buckets[i][@"known"] boolValue]) { complete = NO; break; }
            total24 += [buckets[i][@"mm"] doubleValue];
        }
        if (complete) {
            out[@"total24"] = [NSString stringWithFormat:@"24h · %@ mm", Amount(total24)];
            out[@"totalMm"] = @(total24);
        }
        out[@"hours"] = buckets;
        NSString *kind = buckets[eventStart][@"kind"] ?: @"Rain";
        NSString *headline = [NSString stringWithFormat:@"%@ %@", kind, ShortPeriod(start, now, cal)];
        out[@"headline"] = headline;
        out[@"amount24"] = complete ? Amount24(total24) : @"— · 24h";
        return out;
    }
    NSInteger lastKnown = NSNotFound;
    for (NSInteger i = 0; i < (NSInteger)buckets.count; i++) {
        if (![buckets[i][@"known"] boolValue]) break;
        lastKnown = i;
    }
    if (lastKnown == NSNotFound || firstKnown > 0)
        return @{@"line": prefix.length ? prefix : @"Rain forecast incomplete", @"detail": detail, @"total24": @"—",
            @"headline": @"Rain unavailable", @"amount24": @"— · 24h", @"hours": buckets};
    NSDate *through = buckets[lastKnown][@"end"];
    NSMutableDictionary *out = [@{@"line": [NSString stringWithFormat:@"Dry through %@ %@", Day(through, now, cal), Clock(through, cal)],
        @"detail": detail, @"total24": @"—"} mutableCopy];
    BOOL complete = YES;
    double total24 = 0;
    for (NSInteger i = 0; i < 24; i++) {
        if (![buckets[i][@"known"] boolValue]) { complete = NO; break; }
        total24 += [buckets[i][@"mm"] doubleValue];
    }
    if (complete) {
        out[@"total24"] = [NSString stringWithFormat:@"24h · %@ mm", Amount(total24)];
        out[@"totalMm"] = @(total24);
    }
    out[@"hours"] = buckets;
    out[@"headline"] = [NSString stringWithFormat:@"Dry through %@ %@", Day(through, now, cal), Clock(through, cal)];
    out[@"amount24"] = complete ? Amount24(total24) : @"— · 24h";
    return out;
}

// The glance and graph cover the same 24 hours. Keep exact event boundaries in
// the expanded detail, and bring later severe weather into the short headline.
NSDictionary *RainOutlook(NSArray<NSDictionary *> *rows, NSDate *now, NSTimeZone *tz) {
    NSMutableDictionary *out = [DetailedRainOutlook(rows, now, tz) mutableCopy];
    NSArray *hours = out[@"hours"];
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = tz ?: [NSTimeZone timeZoneWithName:@"Australia/Perth"];
    NSDictionary *first = nil, *severe = nil;
    NSInteger severeRank = 0, known = 0, contiguousDry = 0;
    double knownTotal = 0;
    for (NSInteger i=0; i<MIN(24, (NSInteger)hours.count); i++) {
        NSDictionary *hour=hours[i];
        if (![hour[@"known"] boolValue]) continue;
        known++;
        double mm=[hour[@"mm"] doubleValue];
        knownTotal += mm;
        if (mm > 0 && !first) first=hour;
        if (mm == 0 && i == contiguousDry) contiguousDry++;
        NSString *kind=hour[@"kind"];
        NSInteger rank=[kind isEqual:@"Thunderstorms"] ? 3 :
            ([kind isEqual:@"Freezing rain"] ? 2 : ([kind hasPrefix:@"Heavy"] ? 1 : 0));
        if (rank > severeRank) { severe=hour; severeRank=rank; }
    }
    if (first) {
        NSString *headline=[NSString stringWithFormat:@"%@ %@", first[@"kind"], ShortPeriod(first[@"start"],now,cal)];
        if (severe && ![severe[@"kind"] isEqual:first[@"kind"]]) {
            NSString *kind=[severe[@"kind"] isEqual:@"Thunderstorms"] ? @"Storms" : severe[@"kind"];
            headline=[headline stringByAppendingFormat:@" · %@ %@",kind,ShortPeriod(severe[@"start"],now,cal)];
        }
        out[@"headline"]=headline;
    } else if (severe) {
        out[@"headline"]=[NSString stringWithFormat:@"%@ %@",severe[@"kind"],ShortPeriod(severe[@"start"],now,cal)];
    } else if (known == 24) out[@"headline"]=@"Dry for 24h";
    else if (contiguousDry > 0) out[@"headline"]=[NSString stringWithFormat:@"Dry until %@",Clock(hours[contiguousDry-1][@"end"],cal)];
    else out[@"headline"]=known ? @"Forecast gaps" : @"Rain unavailable";
    if (known > 0 && known < 24) {
        out[@"amount24"] = knownTotal >= 0.1
            ? [NSString stringWithFormat:@"≥%.1f mm · 24h",floor(knownTotal*10+1e-9)/10]
            : (knownTotal > 0 ? @"Trace+ · 24h" : @"Partial · 24h");
    }
    return out;
}
