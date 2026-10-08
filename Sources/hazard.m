// Aviation hazard layer: model CB potential and SIGMET polygons. See hazard.h.
#import "hazard.h"
#import "ownchart.h"
#import <CoreText/CoreText.h>
#import <math.h>
#import <string.h>
#import <stdlib.h>

// ---- Gates --------------------------------------------------------------

const IsobarCBGate kIsobarCBGates[3] = {
    {500.0, 1.0, 50.0},   // possible
    {1000.0, 2.0, 70.0},  // likely
    {1500.0, 2.0, 70.0},  // severe risk
};

double IsobarCBMargin(IsobarCBClass cls, double mucape, double rain3h, double cloud) {
    if (cls < IsobarCBPossible || cls > IsobarCBSevere) return NAN;
    if (!isfinite(mucape) || !isfinite(rain3h) || !isfinite(cloud)) return NAN;
    IsobarCBGate g = kIsobarCBGates[cls - 1];
    double a = mucape / g.mucape, b = rain3h / g.rain3h, c = cloud / g.cloud;
    double m = a < b ? a : b;
    return m < c ? m : c;
}

IsobarCBClass IsobarCBClassify(double mucape, double rain3h, double cloud) {
    if (!isfinite(mucape) || !isfinite(rain3h) || !isfinite(cloud)) return IsobarCBMissing;
    for (IsobarCBClass cls = IsobarCBSevere; cls >= IsobarCBPossible; cls--)
        if (IsobarCBMargin(cls, mucape, rain3h, cloud) >= 1.0) return cls;
    return IsobarCBNone;
}

NSString *IsobarCBClassName(IsobarCBClass cls) {
    switch (cls) {
        case IsobarCBPossible: return @"possible";
        case IsobarCBLikely: return @"likely";
        case IsobarCBSevere: return @"severe risk";
        case IsobarCBNone: return @"none";
        default: return @"missing";
    }
}

double IsobarRainWindow(double earlier, double later) {
    if (!isfinite(earlier) || !isfinite(later)) return NAN;
    double d = later - earlier;
    if (d < -0.05) return NAN;
    return d < 0 ? 0 : d;
}

NSString *IsobarCBCoverageWord(double fraction) {
    if (!isfinite(fraction) || fraction <= 0) return @"";
    if (fraction >= 0.75) return @"FRQ";
    if (fraction >= 0.5) return @"OCNL";
    return @"ISOL";
}

static NSString *Thousands(double value) {
    long n = lround(value);
    if (labs(n) < 1000) return [NSString stringWithFormat:@"%ld", n];
    return [NSString stringWithFormat:@"%ld,%03ld", n / 1000, labs(n) % 1000];
}

NSString *IsobarCBCauseHint(double troughShare, double lowShare, double frontShare,
    double coldShare, double heatShare, double peakMucape) {
    NSMutableArray<NSString *> *causes = [NSMutableArray array];
    const double need = 0.3;
    if (lowShare > 0) [causes addObject:@"low"];
    else if (troughShare >= need) [causes addObject:@"trough"];
    if (frontShare >= need) [causes addObject:coldShare >= need ? @"cold front" : @"front"];
    if (causes.count < 2 && heatShare >= need) [causes addObject:@"surface heating"];
    if (!causes.count) [causes addObject:@"instability + moisture"];
    while (causes.count > 2) [causes removeLastObject];
    NSString *cause = [causes componentsJoinedByString:@" + "];
    if (!isfinite(peakMucape)) return cause;
    double rounded = round(peakMucape / 100.0) * 100.0;
    return [NSString stringWithFormat:@"%@ + MUCAPE %@ J/kg", cause, Thousands(rounded)];
}

NSString *IsobarCBCauseLesson(NSString *hint) {
    if ([hint hasPrefix:@"low"])
        return @"Air spirals into a low and has to rise; unstable air keeps rising into cumulonimbus.";
    if ([hint hasPrefix:@"trough"])
        return @"A trough is a line where surface winds converge and force air up; unstable air keeps rising into cumulonimbus.";
    if ([hint containsString:@"cold front"])
        return @"The cold front wedges under warm moist air and lifts it; unstable air then rises into cumulonimbus.";
    if ([hint containsString:@"front"])
        return @"A strong temperature contrast marks a front; lift along it can set off cumulonimbus in unstable air.";
    if ([hint containsString:@"surface heating"])
        return @"Hot ground starts thermals; with moisture and instability they can grow into cumulonimbus.";
    return @"Moist air with MUCAPE keeps accelerating once lifted, so towers can grow into cumulonimbus.";
}

// ---- SIGMET -------------------------------------------------------------

@implementation IsobarSigmet {
    double *_lat, *_lon;
    NSInteger _count;
}

- (void)dealloc {
    free(_lat);
    free(_lon);
}

- (NSInteger)pointCount { return _count; }
- (double)latitudeAtIndex:(NSInteger)index { return index >= 0 && index < _count ? _lat[index] : NAN; }
- (double)longitudeAtIndex:(NSInteger)index { return index >= 0 && index < _count ? _lon[index] : NAN; }

- (BOOL)isValidAt:(NSDate *)time {
    if (!time || !_validFrom || !_validTo) return NO;
    NSTimeInterval t = time.timeIntervalSince1970;
    return t >= _validFrom.timeIntervalSince1970 && t < _validTo.timeIntervalSince1970;
}

static NSString *ZuluClock(NSDate *date) {
    if (!date) return @"—";
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    NSDateComponents *c = [cal components:NSCalendarUnitHour | NSCalendarUnitMinute fromDate:date];
    return [NSString stringWithFormat:@"%02ld%02ldZ", (long)c.hour, (long)c.minute];
}

- (NSString *)label {
    NSMutableArray *parts = [NSMutableArray arrayWithObject:@"SIGMET"];
    if (_phenomenon.length) [parts addObject:_phenomenon];
    if (_levelsLabel.length) [parts addObject:_levelsLabel];
    [parts addObject:[NSString stringWithFormat:@"until %@", ZuluClock(_validTo)]];
    return [parts componentsJoinedByString:@" "];
}

- (NSString *)plainPhenomenon {
    NSDictionary *words = @{
        @"FRQ": @"Frequent", @"EMBD": @"Embedded", @"OBSC": @"Obscured", @"SQL": @"Squall line of",
        @"ISOL": @"Isolated", @"OCNL": @"Occasional", @"SEV": @"Severe", @"MOD": @"Moderate",
        @"HVY": @"Heavy",
        @"TS": @"thunderstorms", @"TSGR": @"thunderstorms with hail", @"TURB": @"turbulence",
        @"ICE": @"icing", @"(FZRA)": @"(freezing rain)", @"MTW": @"mountain waves", @"VA": @"volcanic ash",
        @"TC": @"tropical cyclone", @"DS": @"dust storm", @"SS": @"sandstorm", @"RDOACT": @"radioactive",
        @"CLD": @"cloud", @"CB": @"cumulonimbus",
    };
    NSMutableArray *out = [NSMutableArray array];
    for (NSString *token in [_phenomenon componentsSeparatedByString:@" "]) {
        if (!token.length) continue;
        [out addObject:words[token] ?: token];
    }
    NSString *text = [out componentsJoinedByString:@" "];
    if (text.length) text = [[[text substringToIndex:1] uppercaseString] stringByAppendingString:[text substringFromIndex:1]];
    return text;
}

static NSString *PlainLevels(NSString *levels) {
    if (!levels.length) return @"";
    if ([levels hasPrefix:@"TOP "]) return [@"Tops " stringByAppendingString:[levels substringFromIndex:4]];
    return [@"Levels " stringByAppendingString:[levels stringByReplacingOccurrencesOfString:@"/" withString:@" to "]];
}

static NSString *PlainMovement(NSString *movement) {
    if (!movement.length) return @"";
    if ([movement isEqualToString:@"STNR"]) return @"stationary";
    NSString *m = [movement hasPrefix:@"MOV "] ? [movement substringFromIndex:4] : movement;
    m = [m stringByReplacingOccurrencesOfString:@"KT" withString:@" kt"];
    m = [m stringByReplacingOccurrencesOfString:@"KMH" withString:@" km/h"];
    return [@"moving " stringByAppendingString:m];
}

- (NSString *)tooltip {
    NSMutableArray *lines = [NSMutableArray array];
    [lines addObject:[NSString stringWithFormat:@"SIGMET %@ · %@ FIR · official warning", _sequence ?: @"",
        _firName.length ? _firName : @"—"]];
    NSString *what = [self plainPhenomenon];
    if ([_status isEqualToString:@"OBS"]) what = [what stringByAppendingString:@", observed"];
    else if ([_status isEqualToString:@"FCST"]) what = [what stringByAppendingString:@", forecast"];
    [lines addObject:what];
    NSMutableArray *detail = [NSMutableArray array];
    if (_levels.length) [detail addObject:PlainLevels(_levels)];
    if (_movement.length) [detail addObject:PlainMovement(_movement)];
    NSDictionary *change = @{@"NC": @"no change", @"INTSF": @"intensifying", @"WKN": @"weakening"};
    if (_change.length) [detail addObject:change[_change] ?: _change];
    if (detail.count) [lines addObject:[detail componentsJoinedByString:@" · "]];
    [lines addObject:[NSString stringWithFormat:@"Valid %@–%@", ZuluClock(_validFrom), ZuluClock(_validTo)]];
    [lines addObject:@""];
    [lines addObject:_raw ?: @""];
    return [lines componentsJoinedByString:@"\n"];
}

static NSString *Squash(NSString *text) {
    NSArray *parts = [text componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableArray *kept = [NSMutableArray array];
    for (NSString *p in parts) if (p.length) [kept addObject:p];
    return [kept componentsJoinedByString:@" "];
}

static NSString *Group(NSString *text, NSString *pattern, NSInteger group) {
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!m || group >= (NSInteger)m.numberOfRanges) return nil;
    NSRange r = [m rangeAtIndex:(NSUInteger)group];
    return r.location == NSNotFound ? nil : [text substringWithRange:r];
}

// "VALID 070313/070515" in the month the feature's epoch names. The nearest
// matching day within a month of the anchor wins.
static NSDate *DayHourMinute(NSString *ddhhmm, NSDate *anchor) {
    if (ddhhmm.length != 6 || !anchor) return nil;
    int dd = [[ddhhmm substringWithRange:NSMakeRange(0, 2)] intValue];
    int hh = [[ddhhmm substringWithRange:NSMakeRange(2, 2)] intValue];
    int mm = [[ddhhmm substringWithRange:NSMakeRange(4, 2)] intValue];
    if (dd < 1 || dd > 31 || hh > 24 || mm > 59) return nil;
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    NSDateComponents *base = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth fromDate:anchor];
    NSDate *best = nil;
    double bestGap = INFINITY;
    for (int shift = -1; shift <= 1; shift++) {
        NSDateComponents *c = [NSDateComponents new];
        c.year = base.year;
        c.month = base.month + shift;
        c.day = dd;
        c.hour = hh;
        c.minute = mm;
        NSDate *date = [cal dateFromComponents:c];
        if (!date) continue;
        NSDateComponents *check = [cal components:NSCalendarUnitDay fromDate:[date dateByAddingTimeInterval:hh == 24 ? -1 : 0]];
        if (check.day != dd) continue;
        double gap = fabs(date.timeIntervalSince1970 - anchor.timeIntervalSince1970);
        if (gap < bestGap) { bestGap = gap; best = date; }
    }
    return best;
}

IsobarSigmet *IsobarSigmetParse(NSDictionary *feature) {
    if (![feature isKindOfClass:NSDictionary.class]) return nil;
    NSString *raw = [feature[@"raw"] isKindOfClass:NSString.class] ? feature[@"raw"] : nil;
    if (!raw.length) return nil;
    NSString *text = Squash(raw);
    if ([text hasSuffix:@"="]) text = [text substringToIndex:text.length - 1];
    // The polygon: WI then "S2450 E15020 - S2530 E14950 - …".
    NSRange wi = [text rangeOfString:@" WI "];
    if (wi.location == NSNotFound) return nil;
    NSString *after = [text substringFromIndex:NSMaxRange(wi)];
    NSRegularExpression *point = [NSRegularExpression regularExpressionWithPattern:
        @"^([NS])(\\d{2})(\\d{2})? ([EW])(\\d{3})(\\d{2})?(?: - |\\s|$)" options:0 error:nil];
    NSMutableArray<NSNumber *> *lats = [NSMutableArray array], *lons = [NSMutableArray array];
    NSUInteger cursor = 0;
    while (cursor < after.length) {
        NSTextCheckingResult *m = [point firstMatchInString:after options:NSMatchingAnchored
            range:NSMakeRange(cursor, after.length - cursor)];
        if (!m) break;
        double latDeg = [[after substringWithRange:[m rangeAtIndex:2]] doubleValue];
        double latMin = [m rangeAtIndex:3].location != NSNotFound ? [[after substringWithRange:[m rangeAtIndex:3]] doubleValue] : 0;
        double lonDeg = [[after substringWithRange:[m rangeAtIndex:5]] doubleValue];
        double lonMin = [m rangeAtIndex:6].location != NSNotFound ? [[after substringWithRange:[m rangeAtIndex:6]] doubleValue] : 0;
        if (latMin >= 60 || lonMin >= 60) return nil;
        double lat = latDeg + latMin / 60.0, lon = lonDeg + lonMin / 60.0;
        if ([[after substringWithRange:[m rangeAtIndex:1]] isEqual:@"S"]) lat = -lat;
        if ([[after substringWithRange:[m rangeAtIndex:4]] isEqual:@"W"]) lon = -lon;
        [lats addObject:@(lat)];
        [lons addObject:@(lon)];
        cursor = NSMaxRange(m.range);
    }
    // A closing point that repeats the first is dropped; the ring closes itself.
    if (lats.count >= 2 && [lats.firstObject isEqual:lats.lastObject] && [lons.firstObject isEqual:lons.lastObject]) {
        [lats removeLastObject];
        [lons removeLastObject];
    }
    if (lats.count < 3) return nil;
    NSString *tail = Squash([after substringFromIndex:MIN(cursor, after.length)]);
    NSString *movement = @"", *change = @"", *levels = tail;
    NSRange stop = NSMakeRange(NSNotFound, 0);
    for (NSString *key in @[@"MOV ", @"STNR"]) {
        NSRange r = [levels rangeOfString:key];
        if (r.location != NSNotFound && (stop.location == NSNotFound || r.location < stop.location)) stop = r;
    }
    if (stop.location != NSNotFound) {
        NSString *rest = [levels substringFromIndex:stop.location];
        levels = Squash([levels substringToIndex:stop.location]);
        NSString *mov = Group(rest, @"^(MOV [NSEW]{1,3} \\d+(?:KT|KMH)|STNR)", 1);
        movement = mov ?: @"";
        rest = Squash([rest substringFromIndex:mov.length]);
        change = Group(rest, @"^(NC|INTSF|WKN)\\b", 1) ?: @"";
    } else {
        NSString *trailing = Group(levels, @"\\s?(NC|INTSF|WKN)$", 1);
        if (trailing) {
            change = trailing;
            levels = Squash([levels substringToIndex:levels.length - trailing.length]);
        }
    }
    NSString *header = [text substringToIndex:wi.location];
    NSString *phenomenon = Group(header, @" FIR(?:/UIR)? (.+?)(?: (OBS|FCST)\\b.*)?$", 1) ?: @"";
    NSString *status = Group(header, @" FIR(?:/UIR)? .+? (OBS|FCST)\\b", 1) ?: @"";
    NSString *fir = [feature[@"firName"] isKindOfClass:NSString.class] ? feature[@"firName"] : nil;
    if (!fir.length) fir = Group(header, @"([A-Z]{4} [A-Z ]+?) FIR", 1) ?: @"";
    NSString *sequence = Group(text, @"SIGMET (\\S+) VALID", 1) ?: @"";
    NSString *validFrom = Group(text, @"VALID (\\d{6})/(\\d{6})", 1);
    NSString *validTo = Group(text, @"VALID (\\d{6})/(\\d{6})", 2);
    NSDate *anchor = nil;
    if ([feature[@"valid_from"] isKindOfClass:NSNumber.class])
        anchor = [NSDate dateWithTimeIntervalSince1970:[feature[@"valid_from"] doubleValue]];
    NSDate *from = DayHourMinute(validFrom, anchor), *to = nil;
    if (from) to = DayHourMinute(validTo, from);
    if (!from && [feature[@"valid_from"] isKindOfClass:NSNumber.class] && [feature[@"valid_to"] isKindOfClass:NSNumber.class]) {
        from = [NSDate dateWithTimeIntervalSince1970:[feature[@"valid_from"] doubleValue]];
        to = [NSDate dateWithTimeIntervalSince1970:[feature[@"valid_to"] doubleValue]];
    }
    if (!from || !to || [to compare:from] != NSOrderedDescending) return nil;
    IsobarSigmet *s = [IsobarSigmet new];
    s->_raw = [raw copy];
    s->_firName = [fir copy];
    s->_sequence = [sequence copy];
    s->_phenomenon = [phenomenon copy];
    s->_status = [status copy];
    s->_levels = [levels copy];
    // FL200/400: the upper number is a flight level as well. FT and SFC stay.
    NSString *label = levels;
    NSString *upper = Group(levels, @"^FL\\d+/(\\d+)$", 1);
    if (upper) label = [[levels substringToIndex:levels.length - upper.length - 1]
        stringByAppendingFormat:@"–FL%@", upper];
    else label = [levels stringByReplacingOccurrencesOfString:@"/" withString:@"–"];
    s->_levelsLabel = [label copy];
    s->_movement = [movement copy];
    s->_change = [change copy];
    s->_validFrom = from;
    s->_validTo = to;
    s->_count = (NSInteger)lats.count;
    s->_lat = malloc(sizeof(double) * lats.count);
    s->_lon = malloc(sizeof(double) * lats.count);
    if (!s->_lat || !s->_lon) return nil;
    for (NSUInteger i = 0; i < lats.count; i++) {
        s->_lat[i] = lats[i].doubleValue;
        s->_lon[i] = lons[i].doubleValue;
    }
    return s;
}

NSArray<IsobarSigmet *> *IsobarSigmetsFromProduct(NSDictionary *product) {
    if (![product isKindOfClass:NSDictionary.class]) return @[];
    NSArray *features = [product[@"features"] isKindOfClass:NSArray.class] ? product[@"features"] : @[];
    NSMutableArray *out = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (id feature in features) {
        IsobarSigmet *s = IsobarSigmetParse(feature);
        if (!s) continue;
        // The same polygon, levels and validity issued under two FIRs is one area.
        NSMutableString *key = [NSMutableString stringWithFormat:@"%@|%@|%.0f|%.0f|", s.phenomenon, s.levels,
            s.validFrom.timeIntervalSince1970, s.validTo.timeIntervalSince1970];
        for (NSInteger i = 0; i < s.pointCount; i++)
            [key appendFormat:@"%.3f,%.3f;", [s latitudeAtIndex:i], [s longitudeAtIndex:i]];
        if ([seen containsObject:key]) continue;
        [seen addObject:key];
        [out addObject:s];
    }
    return out;
}

@end

// ---- Frames -------------------------------------------------------------

@interface IsobarHazardArea ()
@property (nonatomic) IsobarCBClass peakClass;
@property (nonatomic) NSInteger areaCells, possibleCells, likelyCells;
@property (nonatomic, copy) NSString *coverageWord;
@property (nonatomic, copy) NSString *causeHint;
@property (nonatomic) double peakMucape, peakRain3h, peakCloud, peakGustKnots;
@property (nonatomic) double labelLatitude, labelLongitude;
@property (nonatomic) int32_t identifier;
@property (nonatomic, copy) NSArray<NSData *> *outlineRings;
@property (nonatomic) double troughShare, frontShare, coldShare, heatShare;
@end

@implementation IsobarHazardArea
- (double)coverage { return _areaCells > 0 ? (double)_possibleCells / (double)_areaCells : 0; }
- (NSString *)label {
    return _coverageWord.length ? [@"CB " stringByAppendingString:_coverageWord] : @"CB";
}
static NSString *Value(double v, NSString *format) {
    return isfinite(v) ? [NSString stringWithFormat:format, v] : @"—";
}
- (NSString *)tooltip {
    NSMutableArray *lines = [NSMutableArray array];
    [lines addObject:[NSString stringWithFormat:@"CB potential: %@ (model guidance, not a forecast or SIGMET)",
        IsobarCBClassName(_peakClass)]];
    [lines addObject:[@"Why: " stringByAppendingString:_causeHint ?: @"—"]];
    [lines addObject:IsobarCBCauseLesson(_causeHint)];
    [lines addObject:[NSString stringWithFormat:@"%@: %.0f%% of model cells in this outline meet the possible gate",
        _coverageWord.length ? _coverageWord : @"Coverage", self.coverage * 100.0]];
    NSString *cape = isfinite(_peakMucape) ? Thousands(_peakMucape) : @"—";
    [lines addObject:[NSString stringWithFormat:@"Peak: MUCAPE %@ J/kg · rain %@ mm/3 h · cloud %@%% · gust %@ kt",
        cape, Value(_peakRain3h, @"%.1f"), Value(_peakCloud, @"%.0f"), Value(_peakGustKnots, @"%.0f")]];
    [lines addObject:@"ECMWF IFS 0.25°. Gates: MUCAPE, 3 h rain and total cloud."];
    return [lines componentsJoinedByString:@"\n"];
}
@end

@implementation IsobarHazardFrame {
    @public
    NSMutableArray<NSData *> *_rings[3];
    int32_t *_labels;
    IsobarGeoGrid _grid;
    NSArray<IsobarHazardArea *> *_areas;
    double _step;
}
- (void)dealloc { free(_labels); }
- (double)step { return _step; }
- (NSArray<IsobarHazardArea *> *)areas { return _areas ?: @[]; }
- (NSInteger)ringCountForLevel:(NSInteger)level {
    return level >= 0 && level < 3 ? (NSInteger)_rings[level].count : 0;
}
- (NSInteger)vertexCountForRing:(NSInteger)ring level:(NSInteger)level {
    if (level < 0 || level > 2 || ring < 0 || ring >= (NSInteger)_rings[level].count) return 0;
    return (NSInteger)(_rings[level][(NSUInteger)ring].length / (2 * sizeof(double)));
}
- (void)vertexForRing:(NSInteger)ring level:(NSInteger)level index:(NSInteger)index
             latitude:(double *)latitude longitude:(double *)longitude {
    NSInteger n = [self vertexCountForRing:ring level:level];
    if (index < 0 || index >= n) return;
    const double *v = _rings[level][(NSUInteger)ring].bytes;
    if (latitude) *latitude = v[index * 2];
    if (longitude) *longitude = v[index * 2 + 1];
}
- (void)updateDrawnLowCentres:(NSArray<NSValue *> *)centres {
    NSArray<NSValue *> *drawn = [centres isKindOfClass:NSArray.class] ? centres : @[];
    for (IsobarHazardArea *area in _areas) {
        BOOL near = NO;
        for (NSValue *value in drawn) {
            if (![value isKindOfClass:NSValue.class]) continue;
            NSPoint centre = value.pointValue;
            if (!isfinite(centre.x) || !isfinite(centre.y)) continue;
            BOOL insideArea = NO;
            double areaDistance = INFINITY;
            for (NSData *data in area.outlineRings) {
                const double *ring = data.bytes;
                NSInteger n = (NSInteger)(data.length / (2 * sizeof(double)));
                BOOL inside = NO;
                double best = INFINITY;
                for (NSInteger i = 0; i < n; i++) {
                    NSInteger j = (i + 1) % n;
                    double x0 = ring[i * 2 + 1], y0 = ring[i * 2];
                    double x1 = ring[j * 2 + 1], y1 = ring[j * 2];
                    double x1u = x1, dx = x1 - x0;
                    if (dx > 180) x1u -= 360;
                    if (dx < -180) x1u += 360;
                    double xu = centre.x;
                    while (xu - x0 > 180) xu -= 360;
                    while (xu - x0 < -180) xu += 360;
                    if (((y0 > centre.y) != (y1 > centre.y)) &&
                        xu < (x1u - x0) * (centre.y - y0) / (y1 - y0) + x0) inside = !inside;
                    double ex = x1u - x0, ey = y1 - y0;
                    double q = ex * ex + ey * ey;
                    double u = q > 0 ? ((xu - x0) * ex + (centre.y - y0) * ey) / q : 0;
                    if (u < 0) u = 0; else if (u > 1) u = 1;
                    best = fmin(best, hypot(xu - (x0 + u * ex), centre.y - (y0 + u * ey)));
                }
                if (inside) insideArea = !insideArea;
                areaDistance = fmin(areaDistance, best);
            }
            if (insideArea || areaDistance <= 2.0) { near = YES; break; }
        }
        double lowShare = near ? 1.0 : 0.0;
        area.causeHint = IsobarCBCauseHint(area.troughShare, lowShare, area.frontShare,
            area.coldShare, area.heatShare, area.peakMucape);
    }
}
- (IsobarHazardArea *)areaAtLatitude:(double)latitude longitude:(double)longitude {
    if (!_labels || !(_grid.step > 0)) return nil;
    int row = (int)lround((_grid.north - latitude) / _grid.step);
    double rel = longitude - _grid.west;
    if (_grid.wrapsLongitude && _grid.nLon > 0) {
        double span = (double)_grid.nLon * _grid.step;
        rel = rel - floor(rel / span) * span;
        if (rel < 0) rel += span;
    }
    int col = (int)lround(rel / _grid.step);
    if (_grid.wrapsLongitude && col == _grid.nLon) col = 0;
    if (col < 0 || row < 0 || col >= _grid.nLon || row >= _grid.nLat) return nil;
    int32_t id = _labels[(size_t)row * (size_t)_grid.nLon + (size_t)col];
    if (id <= 0) return nil;
    for (IsobarHazardArea *a in _areas) if (a.identifier == id) return a;
    return nil;
}
@end

static int WrapCol(int i, int nx) {
    int m = i % nx;
    return m < 0 ? m + nx : m;
}

static double UnwrapNear(double lon, double prev) {
    while (lon - prev > 180.0) lon -= 360.0;
    while (lon - prev < -180.0) lon += 360.0;
    return lon;
}

static double HazardWrap180(double lon) {
    if (!isfinite(lon)) return lon;
    double x = fmod(lon + 180.0, 360.0);
    if (x < 0) x += 360.0;
    return x - 180.0;
}

// Outside the grid is zero, so a ring closes. A wrapping grid reads the
// column across the seam instead of inventing a zero west or east of it.
static float ContourSample(const float *v, int i, int j, int nx, int ny, BOOL wrap) {
    if (j < 0 || j >= ny) return 0;
    if (i < 0 || i >= nx) {
        if (!wrap) return 0;
        i = WrapCol(i, nx);
    }
    return v[(size_t)j * (size_t)nx + (size_t)i];
}

static double FoldLon(IsobarGeoGrid grid, double lon) {
    double span = (double)grid.nLon * grid.step;
    if (!(span > 0)) return lon;
    double x = lon - grid.west;
    x = x - floor(x / span) * span;
    if (x < 0) x += span;
    if (x >= span) x = 0;
    return grid.west + x;
}

// Marching squares at `iso`. Latitude rows outside the grid are zero, so a
// ring closes at the poles. A longitude-wrapping grid does not pad east or
// west: that zero pad closes a seam blob along the dateline, and the straight
// screen stroke of the short edge is a full-width band. The seam's two
// vertical-edge ids are the same edge. Longitudes are unwrapped before the
// area test and Chaikin, then folded back into the grid. Each segment runs
// from the edge the clockwise cell walk enters through to the edge it leaves
// by, so the area is on the left as drawn north-up.
static void ContourRings(const float *v, int nx, int ny, float iso, IsobarGeoGrid grid,
    NSMutableArray<NSData *> *out, int minVertices, double minCells,
    const int32_t *labels, NSMutableArray<NSNumber *> *owners) {
    int W = nx + 2, H = ny + 2;
    size_t edges = (size_t)W * (size_t)H * 2;
    int32_t *next = malloc(edges * sizeof(int32_t));
    float *ex = malloc(edges * sizeof(float)), *ey = malloc(edges * sizeof(float));
    if (!next || !ex || !ey) { free(next); free(ex); free(ey); return; }
    memset(next, 0xff, edges * sizeof(int32_t));
    BOOL wrap = grid.wrapsLongitude;
#define VAL(I, J) ContourSample(v, (I), (J), nx, ny, wrap)
#define COL(I) (wrap ? WrapCol((I), nx) : (I))
#define HID(I, J) ((int32_t)((((J) + 1) * W + (COL(I) + 1)) * 2))
#define VID(I, J) ((int32_t)((((J) + 1) * W + (COL(I) + 1)) * 2 + 1))
    BOOL any = NO;
    for (int j = -1; j < ny; j++) {
        for (int i = wrap ? 0 : -1; i < nx; i++) {
            float c[4] = {VAL(i, j), VAL(i + 1, j), VAL(i + 1, j + 1), VAL(i, j + 1)};
            BOOL in[4];
            int count = 0;
            for (int k = 0; k < 4; k++) { in[k] = c[k] >= iso; count += in[k]; }
            if (count == 0 || count == 4) continue;
            any = YES;
            // Edges in walk order: top c0→c1, right c1→c2, bottom c2→c3, left c3→c0.
            static const int ea[4] = {0, 1, 2, 3}, eb[4] = {1, 2, 3, 0};
            int32_t ids[4] = {HID(i, j), VID(i + 1, j), HID(i, j + 1), VID(i, j)};
            // Corner positions in (col,row).
            float cx[4] = {i, i + 1, i + 1, i}, cy[4] = {j, j, j + 1, j + 1};
            int entry[2], exit_[2], ne = 0, nxit = 0;
            for (int e = 0; e < 4; e++) {
                int a = ea[e], b = eb[e];
                if (in[a] == in[b]) continue;
                // Position is per edge, independent of walk direction.
                int lo = a, hi = b;
                if ((e == 2) || (e == 3)) { lo = b; hi = a; }
                float t = (iso - c[lo]) / (c[hi] - c[lo]);
                if (!(t >= 0)) t = 0;
                if (t > 1) t = 1;
                ex[ids[e]] = cx[lo] + (cx[hi] - cx[lo]) * t;
                ey[ids[e]] = cy[lo] + (cy[hi] - cy[lo]) * t;
                if (!in[a] && in[b]) entry[ne++] = e;
                else exit_[nxit++] = e;
            }
            if (ne == 1 && nxit == 1) {
                next[ids[entry[0]]] = ids[exit_[0]];
            } else if (ne == 2 && nxit == 2) {
                float centre = (c[0] + c[1] + c[2] + c[3]) * 0.25f;
                // Entry edge e ends at inside corner e+1. Separate inside corners:
                // each is cut off alone, entry e → exit e+1. Joined through the
                // middle: the outside corners are cut off, entry e → exit e−1.
                BOOL joined = centre >= iso;
                for (int k = 0; k < 2; k++) {
                    int e = entry[k];
                    int target = joined ? (e + 3) % 4 : (e + 1) % 4;
                    next[ids[e]] = ids[target];
                }
            }
        }
    }
    if (!any) { free(next); free(ex); free(ey); return; }
    double *ring = NULL;
    size_t cap = 0;
    for (size_t start = 0; start < edges; start++) {
        if (next[start] < 0) continue;
        // This original marching-square edge touches the component before
        // ring smoothing. Its inside endpoint gives the exact owner, even
        // for holes or nearby separate areas; never search a neighbourhood.
        int32_t owner = 0;
        if (labels) {
            int i = (int)((start / 2) % W) - 1, j = (int)((start / 2) / W) - 1;
            if (VAL(i, j) < iso) {
                if (start % 2 == 0) i++; else j++;
            }
            // The seam edge is stored at column 0; a step onto column nx is that
            // same node. Non-wrapping grids still drop an index outside the crop.
            if (wrap) i = WrapCol(i, nx);
            if (i >= 0 && i < nx && j >= 0 && j < ny)
                owner = labels[(size_t)j * nx + i];
        }
        size_t n = 0;
        int32_t e = (int32_t)start;
        while (e >= 0 && next[e] >= 0) {
            if (n + 1 > cap) {
                cap = cap ? cap * 2 : 256;
                double *grown = realloc(ring, cap * 2 * sizeof(double));
                if (!grown) { free(ring); free(next); free(ex); free(ey); return; }
                ring = grown;
            }
            ring[n * 2] = grid.north - ey[e] * grid.step;
            ring[n * 2 + 1] = grid.west + ex[e] * grid.step;
            n++;
            int32_t to = next[e];
            next[e] = -1;
            e = to;
        }
        if ((int)n < minVertices) continue;
        // A seam ring jumps by 360° where the two edge ids meet. Unwrap so the
        // area test and Chaikin follow the short side, then fold back into the grid.
        if (wrap && n > 1) {
            for (size_t k = 1; k < n; k++)
                ring[k * 2 + 1] = UnwrapNear(ring[k * 2 + 1], ring[(k - 1) * 2 + 1]);
            double closed = UnwrapNear(ring[1], ring[(n - 1) * 2 + 1]);
            double shift = closed - ring[1];
            if (fabs(shift) > 1e-4)
                for (size_t k = 0; k < n; k++) ring[k * 2 + 1] += shift;
        }
        // Rings (and holes) smaller than minCells grid cells are speckle.
        double twice = 0;
        for (size_t k = 0; k < n; k++) {
            const double *p = ring + k * 2, *q = ring + ((k + 1) % n) * 2;
            twice += p[1] * q[0] - q[1] * p[0];
        }
        if (fabs(twice) * 0.5 < minCells * grid.step * grid.step) continue;
        // One Chaikin pass softens the 0.25° stair without moving the area.
        size_t m = n * 2;
        double *soft = malloc(m * 2 * sizeof(double));
        if (!soft) continue;
        for (size_t k = 0; k < n; k++) {
            const double *p = ring + k * 2, *q = ring + ((k + 1) % n) * 2;
            soft[k * 4] = 0.75 * p[0] + 0.25 * q[0];
            soft[k * 4 + 1] = 0.75 * p[1] + 0.25 * q[1];
            soft[k * 4 + 2] = 0.25 * p[0] + 0.75 * q[0];
            soft[k * 4 + 3] = 0.25 * p[1] + 0.75 * q[1];
        }
        if (wrap)
            for (size_t k = 0; k < m; k++) soft[k * 2 + 1] = FoldLon(grid, soft[k * 2 + 1]);
        [out addObject:[NSData dataWithBytesNoCopy:soft length:m * 2 * sizeof(double) freeWhenDone:YES]];
        [owners addObject:@(owner)];
    }
#undef VAL
#undef COL
#undef HID
#undef VID
    free(ring);
    free(next);
    free(ex);
    free(ey);
}

// ---- Run ----------------------------------------------------------------

static const uint16_t kMissing = 0xFFFF;

static inline uint16_t Quant(double value, double scale, double maxValue) {
    if (!isfinite(value)) return kMissing;
    if (value < 0) value = 0;
    if (value > maxValue) value = maxValue;
    long q = lround(value * scale);
    if (q >= kMissing) q = kMissing - 1;
    return (uint16_t)q;
}

@implementation IsobarHazardRun {
    IsobarGeoGrid _grid;
    NSInteger _steps;
    NSArray<NSDate *> *_times;
    size_t _cells;
    uint16_t **_cape, **_rain, **_cloud, **_gust; // J/kg, mm×100, %×100, kt×10
    uint8_t **_flags;
    BOOL _hasCB;
}

- (void)dealloc {
    for (NSInteger s = 0; s < _steps; s++) {
        if (_cape) free(_cape[s]);
        if (_rain) free(_rain[s]);
        if (_cloud) free(_cloud[s]);
        if (_gust) free(_gust[s]);
        if (_flags) free(_flags[s]);
    }
    free(_cape); free(_rain); free(_cloud); free(_gust); free(_flags);
}

- (IsobarGeoGrid)grid { return _grid; }
- (NSInteger)steps { return _steps; }
- (NSArray<NSDate *> *)times { return _times; }
- (BOOL)hasCBInputs { return _hasCB; }

- (instancetype)initWithGrid:(IsobarGeoGrid)grid times:(NSArray<NSDate *> *)times {
    self = [super init];
    if (!self) return nil;
    if (grid.nLon < 2 || grid.nLat < 2 || !(grid.step > 0) || times.count < 1) return nil;
    _grid = grid;
    _times = [times copy];
    _steps = (NSInteger)times.count;
    _cells = (size_t)grid.nLon * (size_t)grid.nLat;
    _cape = calloc((size_t)_steps, sizeof(uint16_t *));
    _rain = calloc((size_t)_steps, sizeof(uint16_t *));
    _cloud = calloc((size_t)_steps, sizeof(uint16_t *));
    _gust = calloc((size_t)_steps, sizeof(uint16_t *));
    _flags = calloc((size_t)_steps, sizeof(uint8_t *));
    if (!_cape || !_rain || !_cloud || !_gust || !_flags) return nil;
    return self;
}

static uint16_t *QuantArray(const float *values, size_t n, double scale, double maxValue) {
    uint16_t *q = malloc(n * sizeof(uint16_t));
    if (!q) return NULL;
    for (size_t i = 0; i < n; i++) q[i] = values ? Quant(values[i], scale, maxValue) : kMissing;
    return q;
}

// Separable sliding minimum over ±r cells; missing samples are skipped.
static void SlidingMin(const float *in, float *out, float *tmp, int nx, int ny, int r) {
    for (int j = 0; j < ny; j++)
        for (int i = 0; i < nx; i++) {
            float m = INFINITY;
            for (int k = i - r; k <= i + r; k++) {
                if (k < 0 || k >= nx) continue;
                float v = in[(size_t)j * nx + k];
                if (v < m) m = v;
            }
            tmp[(size_t)j * nx + i] = m;
        }
    for (int j = 0; j < ny; j++)
        for (int i = 0; i < nx; i++) {
            float m = INFINITY;
            for (int k = j - r; k <= j + r; k++) {
                if (k < 0 || k >= ny) continue;
                float v = tmp[(size_t)k * nx + i];
                if (v < m) m = v;
            }
            out[(size_t)j * nx + i] = m;
        }
}

static uint8_t *CauseFlags(IsobarGeoGrid g, const float *mslp, const float *t850, const float *t2m,
    const float *u10, const float *v10) {
    int nx = g.nLon, ny = g.nLat;
    size_t n = (size_t)nx * (size_t)ny;
    uint8_t *flags = calloc(n, 1);
    if (!flags) return NULL;
    // 2° stencils: n2 cells either side.
    int n2 = (int)lround(1.0 / g.step);
    if (n2 < 1) n2 = 1;
    double d = n2 * g.step;
    if (mslp) {
        for (int j = n2; j < ny - n2; j++)
            for (int i = n2; i < nx - n2; i++) {
                size_t k = (size_t)j * nx + i;
                float c = mslp[k], e = mslp[k + n2], w = mslp[k - n2], s = mslp[k + (size_t)n2 * nx], no = mslp[k - (size_t)n2 * nx];
                if (!isfinite(c) || !isfinite(e) || !isfinite(w) || !isfinite(s) || !isfinite(no)) continue;
                double lap = (e + w + s + no - 4.0 * c) / (d * d);
                if (lap >= 0.75) flags[k] |= IsobarCauseTrough;
            }
        // A closed low: the minimum of its ±2° window, 1.5 hPa below that window's mean.
        int r = (int)lround(2.0 / g.step);
        float *mins = malloc(n * sizeof(float)), *tmp = malloc(n * sizeof(float));
        if (mins && tmp) {
            SlidingMin(mslp, mins, tmp, nx, ny, r);
            for (int j = r; j < ny - r; j += 1)
                for (int i = r; i < nx - r; i += 1) {
                    size_t k = (size_t)j * nx + i;
                    if (!isfinite(mslp[k]) || mslp[k] > mins[k]) continue;
                    double sum = 0;
                    int count = 0;
                    for (int dj = -r; dj <= r; dj += 2)
                        for (int di = -r; di <= r; di += 2) {
                            float v = mslp[k + (size_t)((long)dj * nx + di)];
                            if (isfinite(v)) { sum += v; count++; }
                        }
                    if (count < 8 || sum / count - mslp[k] < 1.5) continue;
                    // Closed: pressure rises at least 1 hPa toward all four sides.
                    float rise = INFINITY;
                    float sides[4] = {mslp[k + r], mslp[k - r], mslp[k + (size_t)r * nx], mslp[k - (size_t)r * nx]};
                    for (int q = 0; q < 4; q++) rise = isfinite(sides[q]) ? fminf(rise, sides[q] - mslp[k]) : -INFINITY;
                    if (!(rise >= 1.0f)) continue;
                    // The chart renderer supplies the actual L centre later;
                    // retain the pressure minimum as trough evidence until
                    // then, so a broad minimum does not fall through to the
                    // generic instability hint.
                    for (int dj = -r; dj <= r; dj++)
                        for (int di = -r; di <= r; di++)
                            if (di * di + dj * dj <= r * r)
                                flags[k + (size_t)((long)dj * nx + di)] |= IsobarCausePressureMinimum;
                }
        }
        free(mins);
        free(tmp);
    }
    if (t850) {
        int h = (int)lround(1.0 / g.step);
        if (h < 1) h = 1;
        for (int j = h; j < ny - h; j++) {
            double lat = g.north - j * g.step;
            double kmX = 2.0 * h * g.step * 111.2 * cos(lat * M_PI / 180.0), kmY = 2.0 * h * g.step * 111.2;
            if (kmX < 1) continue;
            for (int i = h; i < nx - h; i++) {
                size_t k = (size_t)j * nx + i;
                float e = t850[k + h], w = t850[k - h], no = t850[k - (size_t)h * nx], s = t850[k + (size_t)h * nx];
                if (!isfinite(e) || !isfinite(w) || !isfinite(no) || !isfinite(s)) continue;
                double gx = (e - w) / kmX * 100.0, gy = (no - s) / kmY * 100.0; // K per 100 km, east and north
                if (hypot(gx, gy) >= 1.5) flags[k] |= IsobarCauseFront;
                if (u10 && v10 && isfinite(u10[k]) && isfinite(v10[k])) {
                    double advection = -(u10[k] * gx + v10[k] * gy) * 3600.0 / 100000.0; // K/h
                    if (advection <= -0.1) flags[k] |= IsobarCauseColdAir;
                }
            }
        }
    }
    if (t2m) for (size_t k = 0; k < n; k++) if (isfinite(t2m[k]) && t2m[k] >= 30.0f) flags[k] |= IsobarCauseHeat;
    return flags;
}

- (void)setStep:(NSInteger)step mucape:(const float *)mucape rain3h:(const float *)rain
          cloud:(const float *)cloud gust:(const float *)gustMetres mslp:(const float *)mslp
           t850:(const float *)t850 t2m:(const float *)t2m u10:(const float *)u10 v10:(const float *)v10 {
    if (step < 0 || step >= _steps) return;
    @synchronized (self) {
        free(_cape[step]); free(_rain[step]); free(_cloud[step]); free(_gust[step]); free(_flags[step]);
        _cape[step] = QuantArray(mucape, _cells, 1.0, 65000);
        _rain[step] = QuantArray(rain, _cells, 100.0, 600);
        _cloud[step] = QuantArray(cloud, _cells, 100.0, 100);
        float *knots = NULL;
        if (gustMetres) {
            knots = malloc(_cells * sizeof(float));
            if (knots) for (size_t i = 0; i < _cells; i++) knots[i] = gustMetres[i] * 1.943844f;
        }
        _gust[step] = QuantArray(knots, _cells, 10.0, 6000);
        free(knots);
        _flags[step] = CauseFlags(_grid, mslp, t850, t2m, u10, v10);
        if (mucape && rain && cloud) _hasCB = YES;
    }
}

static NSString *ValidID(NSDate *date) {
    NSCalendar *cal = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
    cal.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    NSDateComponents *c = [cal components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour
        fromDate:date];
    return [NSString stringWithFormat:@"%04ld%02ld%02ldT%02ldZ", (long)c.year, (long)c.month, (long)c.day, (long)c.hour];
}

// One published float16 field, checked against the grid. NULL when absent.
static float *ReadField(NSString *runDir, NSString *field, NSString *param, NSString *units, NSDate *valid,
    IsobarGeoGrid g) {
    NSString *stem = [[runDir stringByAppendingPathComponent:field] stringByAppendingPathComponent:ValidID(valid)];
    NSData *sideData = [NSData dataWithContentsOfFile:[stem stringByAppendingPathExtension:@"json"]];
    if (!sideData) return NULL;
    NSDictionary *side = [NSJSONSerialization JSONObjectWithData:sideData options:0 error:nil];
    if (![side isKindOfClass:NSDictionary.class]) return NULL;
    if ([side[@"nx"] intValue] != g.nLon || [side[@"ny"] intValue] != g.nLat) return NULL;
    if (fabs([side[@"lon0"] doubleValue] - g.west) > 1e-6 || fabs([side[@"lat0"] doubleValue] - g.north) > 1e-6) return NULL;
    if (fabs([side[@"dlon"] doubleValue] - g.step) > 1e-6 || fabs([side[@"dlat"] doubleValue] + g.step) > 1e-6) return NULL;
    if (![side[@"units"] isEqual:units] || ![side[@"param"] isEqual:param]) return NULL;
    if (![side[@"dtype"] isEqual:@"float16"] || ![side[@"endian"] isEqual:@"little"]) return NULL;
    NSData *file = [NSData dataWithContentsOfFile:[stem stringByAppendingPathExtension:@"f16"]];
    size_t n = (size_t)g.nLon * (size_t)g.nLat;
    if (file.length != n * 2) return NULL;
    float *out = malloc(n * sizeof(float));
    if (!out) return NULL;
    const uint8_t *bytes = file.bytes;
    for (size_t i = 0; i < n; i++) {
        uint16_t bits = (uint16_t)(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
        if (bits == 0xf800) { out[i] = NAN; continue; }
        __fp16 h;
        memcpy(&h, &bits, 2);
        float v = (float)h;
        out[i] = isfinite(v) ? v : NAN;
    }
    return out;
}

+ (instancetype)runFromStoreRoot:(NSString *)root runDate:(NSDate *)runDate
    times:(NSArray<NSDate *> *)times grid:(IsobarGeoGrid)grid error:(NSString **)error {
    if (!root.length || !runDate || times.count < 1) {
        if (error) *error = @"no store, run or times";
        return nil;
    }
    NSString *family = grid.wrapsLongitude ? @"ecmwf_ifs_global" : @"ecmwf_ifs025";
    NSString *runDir = [[[root stringByAppendingPathComponent:@"products/grids"] stringByAppendingPathComponent:family]
        stringByAppendingPathComponent:@"runs"];
    runDir = [runDir
        stringByAppendingPathComponent:ValidID(runDate)];
    BOOL isDir = NO;
    if (![NSFileManager.defaultManager fileExistsAtPath:runDir isDirectory:&isDir] || !isDir) {
        if (error) *error = [NSString stringWithFormat:@"no published run %@", ValidID(runDate)];
        return nil;
    }
    IsobarHazardRun *run = [[IsobarHazardRun alloc] initWithGrid:grid times:times];
    if (!run) {
        if (error) *error = @"bad grid";
        return nil;
    }
    size_t n = run->_cells;
    NSInteger steps = (NSInteger)times.count;
    float **tp = calloc((size_t)steps, sizeof(float *));
    if (!tp) return nil;
    for (NSInteger s = 0; s < steps; s++) tp[s] = ReadField(runDir, @"tp", @"tp", @"mm", times[(NSUInteger)s], grid);
    float *windowBuf = malloc(n * sizeof(float) * 2), *rain = malloc(n * sizeof(float));
    for (NSInteger s = 0; s < steps && windowBuf && rain; s++) {
        // Rain around step s, per 3 h: the mean of the window ending at s and
        // the window starting at s. The first and last steps use their one window.
        float *before = windowBuf, *after = windowBuf + n;
        BOOL hasBefore = s > 0 && tp[s - 1] && tp[s], hasAfter = s + 1 < steps && tp[s] && tp[s + 1];
        double hoursBefore = s > 0 ? [times[(NSUInteger)s] timeIntervalSinceDate:times[(NSUInteger)s - 1]] / 3600.0 : 0;
        double hoursAfter = s + 1 < steps ? [times[(NSUInteger)s + 1] timeIntervalSinceDate:times[(NSUInteger)s]] / 3600.0 : 0;
        if (!(hoursBefore > 0)) hasBefore = NO;
        if (!(hoursAfter > 0)) hasAfter = NO;
        for (size_t i = 0; i < n; i++) {
            before[i] = hasBefore ? (float)(IsobarRainWindow(tp[s - 1][i], tp[s][i]) * 3.0 / hoursBefore) : NAN;
            after[i] = hasAfter ? (float)(IsobarRainWindow(tp[s][i], tp[s + 1][i]) * 3.0 / hoursAfter) : NAN;
            if (hasBefore && hasAfter) rain[i] = (before[i] + after[i]) * 0.5f; // NAN if either reset
            else rain[i] = hasBefore ? before[i] : hasAfter ? after[i] : NAN;
        }
        NSDate *valid = times[(NSUInteger)s];
        float *cape = ReadField(runDir, @"mucape", @"mucape", @"J/kg", valid, grid);
        float *cloud = ReadField(runDir, @"cloud_cover", @"tcc", @"%", valid, grid);
        float *gust = ReadField(runDir, @"gust10", @"10fg", @"m/s", valid, grid);
        float *mslp = ReadField(runDir, @"mslp", @"msl", @"hPa", valid, grid);
        float *t850 = ReadField(runDir, @"t850", @"t", @"degC", valid, grid);
        float *t2m = ReadField(runDir, @"t2m", @"2t", @"degC", valid, grid);
        float *u10 = ReadField(runDir, @"u10", @"10u", @"m/s", valid, grid);
        float *v10 = ReadField(runDir, @"v10", @"10v", @"m/s", valid, grid);
        BOOL rainKnown = hasBefore || hasAfter;
        [run setStep:s mucape:cape rain3h:rainKnown ? rain : NULL cloud:cloud gust:gust mslp:mslp t850:t850
            t2m:t2m u10:u10 v10:v10];
        free(cape); free(cloud); free(gust); free(mslp); free(t850); free(t2m); free(u10); free(v10);
    }
    free(windowBuf);
    free(rain);
    for (NSInteger s = 0; s < steps; s++) free(tp[s]);
    free(tp);
    if (!run->_hasCB) {
        if (error) *error = @"run has no MUCAPE, cloud and rain together";
    }
    return run;
}

- (NSDate *)timeAtStep:(double)t {
    if (!_times.count || !isfinite(t)) return nil;
    if (t <= 0) return _times.firstObject;
    if (t >= _steps - 1) return _times.lastObject;
    NSInteger s0 = (NSInteger)floor(t);
    double f = t - s0;
    NSTimeInterval a = _times[(NSUInteger)s0].timeIntervalSince1970, b = _times[(NSUInteger)s0 + 1].timeIntervalSince1970;
    return [NSDate dateWithTimeIntervalSince1970:a + (b - a) * f];
}

static inline double Deq(uint16_t q, double scale) { return q == kMissing ? NAN : q / scale; }

static inline double Lerp(const uint16_t *a, const uint16_t *b, size_t i, double f, double scale) {
    if (!a || !b) return NAN;
    double x = Deq(a[i], scale), y = Deq(b[i], scale);
    if (f <= 0) return x;
    if (f >= 1) return y;
    return x + (y - x) * f;
}

- (IsobarHazardFrame *)frameAtStep:(double)fractionalStep {
    if (!isfinite(fractionalStep)) return nil;
    double t = fractionalStep;
    if (t < 0) t = 0;
    if (t > _steps - 1) t = _steps - 1;
    NSInteger s0 = (NSInteger)floor(t), s1 = s0 + 1 < _steps ? s0 + 1 : s0;
    double f = t - s0;
    if (s1 == s0) f = 0;
    int nx = _grid.nLon, ny = _grid.nLat;
    size_t n = _cells;
    float *mp = malloc(n * sizeof(float)), *ml = malloc(n * sizeof(float)), *ms = malloc(n * sizeof(float));
    float *area = malloc(n * sizeof(float));
    int32_t *labels = calloc(n, sizeof(int32_t));
    int32_t *queue = malloc(n * sizeof(int32_t));
    IsobarHazardFrame *frame = [IsobarHazardFrame new];
    for (int k = 0; k < 3; k++) frame->_rings[k] = [NSMutableArray array];
    frame->_grid = _grid;
    frame->_step = t;
    if (!mp || !ml || !ms || !area || !labels || !queue) {
        free(mp); free(ml); free(ms); free(area); free(labels); free(queue);
        return frame;
    }
    const uint16_t *ca, *cb, *ra, *rb, *ka, *kb, *ga, *gb;
    const uint8_t *flags;
    @synchronized (self) {
        ca = _cape[s0]; cb = _cape[s1]; ra = _rain[s0]; rb = _rain[s1];
        ka = _cloud[s0]; kb = _cloud[s1]; ga = _gust[s0]; gb = _gust[s1];
        flags = _flags[f < 0.5 ? s0 : s1];
    }
    const IsobarCBGate g0 = kIsobarCBGates[0], g1 = kIsobarCBGates[1], g2 = kIsobarCBGates[2];
    for (size_t i = 0; i < n; i++) {
        double c = Lerp(ca, cb, i, f, 1.0), r = Lerp(ra, rb, i, f, 100.0), k = Lerp(ka, kb, i, f, 100.0);
        if (!isfinite(c) || !isfinite(r) || !isfinite(k)) { mp[i] = ml[i] = ms[i] = 0; continue; }
        double a = c / g0.mucape, b = r / g0.rain3h, d = k / g0.cloud;
        mp[i] = (float)fmin(a, fmin(b, d));
        a = c / g1.mucape; b = r / g1.rain3h; d = k / g1.cloud;
        ml[i] = (float)fmin(a, fmin(b, d));
        a = c / g2.mucape; b = r / g2.rain3h; d = k / g2.cloud;
        ms[i] = (float)fmin(a, fmin(b, d));
    }
    // The outline encloses a cluster: the possible margin dilated by one cell.
    for (int j = 0; j < ny; j++)
        for (int i = 0; i < nx; i++) {
            float m = 0;
            for (int dj = -1; dj <= 1; dj++) {
                int jj = j + dj;
                if (jj < 0 || jj >= ny) continue;
                for (int di = -1; di <= 1; di++) {
                    int ii = i + di;
                    if (_grid.wrapsLongitude) ii = WrapCol(ii, nx);
                    else if (ii < 0 || ii >= nx) continue;
                    float v = mp[(size_t)jj * nx + ii];
                    if (v > m) m = v;
                }
            }
            area[(size_t)j * nx + i] = m;
        }
    NSMutableArray<IsobarHazardArea *> *areas = [NSMutableArray array];
    int32_t nextID = 0;
    for (size_t seed = 0; seed < n; seed++) {
        if (labels[seed] != 0 || area[seed] < 1.0f) continue;
        int32_t id = ++nextID;
        size_t head = 0, tail = 0;
        queue[tail++] = (int32_t)seed;
        labels[seed] = id;
        NSInteger cells = 0, poss = 0, lik = 0, sev = 0;
        double peakCape = -INFINITY, peakRain = -INFINITY, peakCloud = -INFINITY, peakGust = -INFINITY;
        double sumLat = 0, sumLon = 0, lonOrigin = NAN;
        NSInteger trough = 0, minimum = 0, front = 0, cold = 0, heat = 0;
        while (head < tail) {
            int32_t at = queue[head++];
            int j = at / nx, i = at % nx;
            cells++;
            if (mp[at] >= 1.0f) {
                poss++;
                if (ml[at] >= 1.0f) lik++;
                if (ms[at] >= 1.0f) sev++;
                double c = Lerp(ca, cb, (size_t)at, f, 1.0), r = Lerp(ra, rb, (size_t)at, f, 100.0);
                double k = Lerp(ka, kb, (size_t)at, f, 100.0), gst = Lerp(ga, gb, (size_t)at, f, 10.0);
                if (c > peakCape) peakCape = c;
                if (r > peakRain) peakRain = r;
                if (k > peakCloud) peakCloud = k;
                if (isfinite(gst) && gst > peakGust) peakGust = gst;
                sumLat += _grid.north - j * _grid.step;
                double lon = _grid.west + i * _grid.step;
                if (_grid.wrapsLongitude) {
                    if (!isfinite(lonOrigin)) lonOrigin = lon;
                    lon = UnwrapNear(lon, lonOrigin);
                }
                sumLon += lon;
                uint8_t fl = flags ? flags[at] : 0;
                if (fl & IsobarCauseTrough) trough++;
                if (fl & IsobarCausePressureMinimum) minimum++;
                if (fl & IsobarCauseFront) front++;
                if (fl & IsobarCauseColdAir) cold++;
                if (fl & IsobarCauseHeat) heat++;
            }
            for (int dj = -1; dj <= 1; dj++)
                for (int di = -1; di <= 1; di++) {
                    int jj = j + dj, ii = i + di;
                    if (!dj && !di) continue;
                    if (jj < 0 || jj >= ny) continue;
                    if (_grid.wrapsLongitude) ii = WrapCol(ii, nx);
                    else if (ii < 0 || ii >= nx) continue;
                    size_t k = (size_t)jj * nx + ii;
                    if (labels[k] != 0 || area[k] < 1.0f) continue;
                    labels[k] = id;
                    queue[tail++] = (int32_t)k;
                }
        }
        // Speckle: fewer than three possible cells and nothing likely is not an area.
        if (poss < 3 && lik == 0) {
            for (size_t q = 0; q < tail; q++) { area[queue[q]] = 0; labels[queue[q]] = -1; }
            continue;
        }
        IsobarHazardArea *a = [IsobarHazardArea new];
        a.identifier = id;
        a.areaCells = cells;
        a.possibleCells = poss;
        a.likelyCells = lik;
        a.peakClass = sev > 0 ? IsobarCBSevere : lik > 0 ? IsobarCBLikely : IsobarCBPossible;
        a.coverageWord = IsobarCBCoverageWord(a.coverage);
        a.peakMucape = isfinite(peakCape) ? peakCape : NAN;
        a.peakRain3h = isfinite(peakRain) ? peakRain : NAN;
        a.peakCloud = isfinite(peakCloud) ? peakCloud : NAN;
        a.peakGustKnots = isfinite(peakGust) ? peakGust : NAN;
        double p = poss > 0 ? (double)poss : 1.0;
        a.troughShare = minimum > 0 ? 1.0 : trough / p;
        a.frontShare = front / p;
        a.coldShare = cold / p;
        a.heatShare = heat / p;
        // No renderer centres are available on the hazard queue. Pressure
        // minima therefore remain troughs until the map supplies its drawn Ls.
        a.causeHint = IsobarCBCauseHint(a.troughShare, 0, a.frontShare, a.coldShare,
            a.heatShare, a.peakMucape);
        // The label sits on the possible cell nearest the centroid, so a
        // crescent's label stays inside it.
        double cLat = sumLat / p, cLon = sumLon / p, best = INFINITY;
        a.labelLatitude = cLat;
        a.labelLongitude = _grid.wrapsLongitude ? HazardWrap180(cLon) : cLon;
        for (size_t q = 0; q < tail; q++) {
            int32_t at = queue[q];
            if (mp[at] < 1.0f) continue;
            double lat = _grid.north - (at / nx) * _grid.step, lon = _grid.west + (at % nx) * _grid.step;
            if (_grid.wrapsLongitude) lon = UnwrapNear(lon, cLon);
            double d = (lat - cLat) * (lat - cLat) + (lon - cLon) * (lon - cLon);
            if (d < best) {
                best = d;
                a.labelLatitude = lat;
                a.labelLongitude = _grid.wrapsLongitude ? HazardWrap180(lon) : lon;
            }
        }
        [areas addObject:a];
    }
    for (size_t i = 0; i < n; i++) if (labels[i] < 0) labels[i] = 0;
    [areas sortUsingComparator:^NSComparisonResult(IsobarHazardArea *x, IsobarHazardArea *y) {
        if (x.areaCells != y.areaCells) return x.areaCells > y.areaCells ? NSOrderedAscending : NSOrderedDescending;
        return x.identifier < y.identifier ? NSOrderedAscending : NSOrderedDescending;
    }];
    // Cores only count inside kept areas.
    for (size_t i = 0; i < n; i++) if (labels[i] == 0) { ml[i] = fminf(ml[i], 0.0f); ms[i] = fminf(ms[i], 0.0f); }
    NSMutableArray<NSNumber *> *owners = [NSMutableArray array];
    ContourRings(area, nx, ny, 1.0f, _grid, frame->_rings[0], 4, 4.0, labels, owners);
    ContourRings(ml, nx, ny, 1.0f, _grid, frame->_rings[1], 4, 2.0, NULL, nil);
    ContourRings(ms, nx, ny, 1.0f, _grid, frame->_rings[2], 4, 2.0, NULL, nil);
    frame->_areas = areas;
    frame->_labels = labels;
    for (NSUInteger i = 0; i < owners.count; i++) {
        int32_t owner = owners[i].intValue;
        for (IsobarHazardArea *a in areas) if (a.identifier == owner) {
            a.outlineRings = [a.outlineRings ?: @[] arrayByAddingObject:frame->_rings[0][i]];
            break;
        }
    }
    free(mp); free(ml); free(ms); free(area); free(queue);
    return frame;
}

@end

// ---- Drawing ------------------------------------------------------------

typedef struct { double r, g, b; } HazardRGB;

// Light plate: muted amber, red for severe risk. The dark plate's land is
// olive-amber, so amber hatch over dark sea reads as land; there the CB ink
// is a muted rose and severe risk a crimson (TestCoastOverFields checks it).
static HazardRGB AmberInk(BOOL dark) {
    return dark ? (HazardRGB){0.94, 0.50, 0.60} : (HazardRGB){0.66, 0.42, 0.08};
}
static HazardRGB RedInk(BOOL dark) {
    return dark ? (HazardRGB){1.00, 0.38, 0.48} : (HazardRGB){0.70, 0.17, 0.12};
}
static HazardRGB SigmetInk(BOOL dark) {
    return dark ? (HazardRGB){1.00, 0.40, 0.42} : (HazardRGB){0.55, 0.03, 0.08};
}
static HazardRGB HaloInk(BOOL dark) {
    return dark ? (HazardRGB){0.10, 0.11, 0.13} : (HazardRGB){1.0, 0.99, 0.95};
}

// The bundled coastline, loaded once from ISOBAR_COAST (the renderer's own
// source). Hatch and scallops are knocked out along it so the coast stays the
// darkest (light) or lightest (dark) line at the shore under any hazard.
typedef struct { double south, north, west, east; } GeoBox;
static OwnCoast gCoast;
static GeoBox *gCoastBoxes;

static void LoadCoast(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        gCoast = OwnCoastParse([NSData dataWithContentsOfFile:OwnCoastPath()]);
        if (gCoast.rings < 1) return;
        gCoastBoxes = malloc(sizeof(GeoBox) * (size_t)gCoast.rings);
        if (!gCoastBoxes) return;
        for (int r = 0; r < gCoast.rings; r++) {
            GeoBox b = {INFINITY, -INFINITY, INFINITY, -INFINITY};
            for (int k = gCoast.ringStart[r]; k < gCoast.ringStart[r] + gCoast.ringCount[r]; k++) {
                b.south = fmin(b.south, gCoast.lat[k]); b.north = fmax(b.north, gCoast.lat[k]);
                b.west = fmin(b.west, gCoast.lon[k]); b.east = fmax(b.east, gCoast.lon[k]);
            }
            gCoastBoxes[r] = b;
        }
    });
}

// Coast rings inside `box`, projected, one px apart at least.
static CGPathRef CoastPath(GeoBox box, IsobarCamera camera) {
    LoadCoast();
    CGMutablePathRef path = CGPathCreateMutable();
    if (!gCoastBoxes) return path;
    for (int r = 0; r < gCoast.rings; r++) {
        GeoBox b = gCoastBoxes[r];
        if (b.north < box.south || b.south > box.north || b.east < box.west || b.west > box.east) continue;
        BOOL open = NO;
        double lx = 0, ly = 0;
        int end = gCoast.ringStart[r] + gCoast.ringCount[r];
        for (int k = gCoast.ringStart[r]; k < end; k++) {
            double x = 0, y = 0;
            if (!IsobarCameraProject(camera, gCoast.lat[k], gCoast.lon[k], &x, &y)) { open = NO; continue; }
            if (!open) { CGPathMoveToPoint(path, NULL, x, y); open = YES; lx = x; ly = y; continue; }
            if (fabs(x - lx) + fabs(y - ly) < 1.0 && k + 1 < end) continue;
            CGPathAddLineToPoint(path, NULL, x, y);
            lx = x; ly = y;
        }
    }
    return path;
}

static GeoBox FrameBox(IsobarHazardFrame *frame) {
    GeoBox b = {INFINITY, -INFINITY, INFINITY, -INFINITY};
    for (NSInteger r = 0; r < [frame ringCountForLevel:0]; r++)
        for (NSInteger i = 0; i < [frame vertexCountForRing:r level:0]; i++) {
            double lat = 0, lon = 0;
            [frame vertexForRing:r level:0 index:i latitude:&lat longitude:&lon];
            b.south = fmin(b.south, lat); b.north = fmax(b.north, lat);
            b.west = fmin(b.west, lon); b.east = fmax(b.east, lon);
        }
    return b;
}

static void SetStroke(CGContextRef c, HazardRGB ink, double alpha) {
    CGContextSetRGBStrokeColor(c, ink.r, ink.g, ink.b, alpha);
}

// The short geographic edge whose ends fall on opposite sides of the camera
// antimeridian. A straight screen segment between them is the full-width band.
static BOOL CrossesAntimeridian(double centreLon, double lon0, double lon1) {
    double a = HazardWrap180(lon0 - centreLon);
    double b = HazardWrap180(lon1 - centreLon);
    return a * b < 0.0 && fabs(a) + fabs(b) > 180.0;
}

static void AddPlainRing(CGMutablePathRef path, const CGPoint *p, NSInteger n);
static void AddScallopRing(CGMutablePathRef path, const CGPoint *p, NSInteger n, double spacing);

static void AddClosedChain(CGMutablePathRef plain, CGMutablePathRef scallop, const CGPoint *pts,
    const double *lons, NSInteger n, double centreLon, double spacing) {
    if (n < 3 || CrossesAntimeridian(centreLon, lons[n - 1], lons[0])) return;
    AddPlainRing(plain, pts, n);
    if (scallop) AddScallopRing(scallop, pts, n, spacing);
}

// Project the ring. Split it where an edge crosses the camera antimeridian and
// close each piece on its own side of the cut, so the stroke cannot chord
// across the viewport. A vertex that fails projection drops the whole ring,
// matching the previous behaviour.
static void AddProjectedRing(CGMutablePathRef plain, CGMutablePathRef scallop, IsobarHazardFrame *frame,
    NSInteger ring, NSInteger level, IsobarCamera camera, double spacing) {
    NSInteger n = [frame vertexCountForRing:ring level:level];
    if (n < 3 || !plain) return;
    CGPoint *pts = malloc(sizeof(CGPoint) * (size_t)n);
    double *lons = malloc(sizeof(double) * (size_t)n);
    if (!pts || !lons) { free(pts); free(lons); return; }
    for (NSInteger i = 0; i < n; i++) {
        double lat = 0, lon = 0, x = 0, y = 0;
        [frame vertexForRing:ring level:level index:i latitude:&lat longitude:&lon];
        if (!IsobarCameraProject(camera, lat, lon, &x, &y)) { free(pts); free(lons); return; }
        pts[i] = CGPointMake(x, y);
        lons[i] = lon;
    }
    BOOL *cross = calloc((size_t)n, 1);
    NSInteger nCross = 0;
    if (cross) {
        for (NSInteger i = 0; i < n; i++) {
            cross[i] = CrossesAntimeridian(camera.centreLon, lons[i], lons[(i + 1) % n]);
            nCross += cross[i] ? 1 : 0;
        }
    }
    if (!cross || nCross == 0) {
        AddPlainRing(plain, pts, n);
        if (scallop) AddScallopRing(scallop, pts, n, spacing);
    } else {
        NSInteger start = 0;
        for (NSInteger i = 0; i < n; i++) if (cross[i]) { start = (i + 1) % n; break; }
        CGPoint *chain = malloc(sizeof(CGPoint) * (size_t)n);
        double *chainLon = malloc(sizeof(double) * (size_t)n);
        if (chain && chainLon) {
            NSInteger cn = 0, i = start;
            for (NSInteger k = 0; k < n; k++) {
                chain[cn] = pts[i];
                chainLon[cn] = lons[i];
                cn++;
                if (cross[i]) {
                    AddClosedChain(plain, scallop, chain, chainLon, cn, camera.centreLon, spacing);
                    cn = 0;
                }
                i = (i + 1) % n;
            }
            if (cn) AddClosedChain(plain, scallop, chain, chainLon, cn, camera.centreLon, spacing);
        }
        free(chain);
        free(chainLon);
    }
    free(cross);
    free(pts);
    free(lons);
}

static void AddPlainRing(CGMutablePathRef path, const CGPoint *p, NSInteger n) {
    CGPathMoveToPoint(path, NULL, p[0].x, p[0].y);
    for (NSInteger i = 1; i < n; i++) CGPathAddLineToPoint(path, NULL, p[i].x, p[i].y);
    CGPathCloseSubpath(path);
}

// Cumulus edge: resample the ring every `spacing` px and bulge each step
// outward (the area is on the left of the ring, so outward is the right).
static void AddScallopRing(CGMutablePathRef path, const CGPoint *p, NSInteger n, double spacing) {
    double perimeter = 0;
    for (NSInteger i = 0; i < n; i++) {
        CGPoint a = p[i], b = p[(i + 1) % n];
        perimeter += hypot(b.x - a.x, b.y - a.y);
    }
    NSInteger bumps = (NSInteger)floor(perimeter / spacing);
    if (bumps < 6) {
        AddPlainRing(path, p, n);
        return;
    }
    double step = perimeter / bumps;
    CGPoint *q = malloc(sizeof(CGPoint) * (size_t)bumps);
    if (!q) return;
    NSInteger seg = 0;
    double segStart = 0, segLen = hypot(p[1 % n].x - p[0].x, p[1 % n].y - p[0].y);
    for (NSInteger k = 0; k < bumps; k++) {
        double at = k * step;
        while (seg < n - 1 && at > segStart + segLen) {
            segStart += segLen;
            seg++;
            CGPoint a = p[seg], b = p[(seg + 1) % n];
            segLen = hypot(b.x - a.x, b.y - a.y);
        }
        CGPoint a = p[seg], b = p[(seg + 1) % n];
        double t = segLen > 0 ? (at - segStart) / segLen : 0;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        q[k] = CGPointMake(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
    CGPathMoveToPoint(path, NULL, q[0].x, q[0].y);
    for (NSInteger k = 0; k < bumps; k++) {
        CGPoint a = q[k], b = q[(k + 1) % bumps];
        double dx = b.x - a.x, dy = b.y - a.y;
        // Screen y is down: the right of (dx, dy) is (-dy, dx).
        CGPoint control = CGPointMake((a.x + b.x) * 0.5 - dy * 0.85, (a.y + b.y) * 0.5 + dx * 0.85);
        CGPathAddQuadCurveToPoint(path, NULL, control.x, control.y, b.x, b.y);
    }
    CGPathCloseSubpath(path);
    free(q);
}

static void Hatch(CGContextRef c, CGPathRef clip, CGRect box, double spacing, BOOL rising, double width) {
    if (CGRectIsEmpty(box)) return;
    CGContextSaveGState(c);
    CGContextAddPath(c, clip);
    CGContextEOClip(c);
    CGContextSetLineWidth(c, width);
    CGContextBeginPath(c);
    double h = box.size.height;
    // Lines at 45°, anchored to the viewport so they do not crawl with the area.
    double start = floor((box.origin.x - h) / spacing) * spacing;
    for (double x = start; x <= CGRectGetMaxX(box) + h; x += spacing) {
        if (rising) {
            CGContextMoveToPoint(c, x, CGRectGetMaxY(box));
            CGContextAddLineToPoint(c, x + h, box.origin.y);
        } else {
            CGContextMoveToPoint(c, x, box.origin.y);
            CGContextAddLineToPoint(c, x + h, CGRectGetMaxY(box));
        }
    }
    CGContextStrokePath(c);
    CGContextRestoreGState(c);
}

static NSMutableArray<NSString *> *LastLabels(void) {
    NSMutableDictionary *tls = NSThread.currentThread.threadDictionary;
    NSMutableArray *labels = tls[@"isobar.hazard.labels"];
    if (!labels) {
        labels = [NSMutableArray array];
        tls[@"isobar.hazard.labels"] = labels;
    }
    return labels;
}

NSArray<NSString *> *IsobarHazardLastLabels(void) { return [LastLabels() copy]; }

// Text centred near (x, y) in a y-down context, with a halo in the plate
// colour. Tries the point, then above, below and to the sides, so a label
// moves rather than vanishing; NULL rect when every place collides.
static CGRect DrawLabelAt(CGContextRef c, NSString *text, const CGPoint *anchors, NSInteger anchorCount, double size,
    HazardRGB ink, BOOL dark, CGRect bounds, NSArray<NSValue *> *avoid, BOOL bold, BOOL force) {
    CTFontRef font = CTFontCreateUIFontForLanguage(bold ? kCTFontUIFontEmphasizedSystem : kCTFontUIFontSystem, size, NULL);
    if (!font) return CGRectNull;
    CGColorRef colour = CGColorCreateSRGB(ink.r, ink.g, ink.b, 1);
    NSDictionary *attrs = @{(__bridge id)kCTFontAttributeName: (__bridge id)font,
                            (__bridge id)kCTForegroundColorAttributeName: (__bridge id)colour};
    NSAttributedString *s = [[NSAttributedString alloc] initWithString:text attributes:attrs];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)s);
    CGFloat ascent = 0, descent = 0;
    double w = CTLineGetTypographicBounds(line, &ascent, &descent, NULL);
    double h = ascent + descent;
    const double offsets[][2] = {{0, 0}, {0, -1.4}, {0, 1.4}, {0, -2.8}, {0, 2.8}, {-0.6, 0}, {0.6, 0},
        {-0.6, -1.4}, {0.6, 1.4}, {0, -4.2}, {0, 4.2}};
    CGRect box = CGRectNull, hit = CGRectNull;
    size_t tries = sizeof offsets / sizeof offsets[0];
    for (size_t t = 0; t < tries * (size_t)anchorCount + (force ? 1 : 0) && CGRectIsNull(box); t++) {
        BOOL last = t == tries * (size_t)anchorCount;
        size_t k = last ? 0 : t % tries;
        CGPoint at = anchors[last ? 0 : t / tries];
        double x = at.x, y = at.y;
        CGRect b = CGRectMake(x - w * 0.5 + offsets[k][0] * w, y - h * 0.5 + offsets[k][1] * h, w, h);
        // Keep the whole label on the map.
        double pad = 3;
        if (b.origin.x < bounds.origin.x + pad) b.origin.x = bounds.origin.x + pad;
        if (CGRectGetMaxX(b) > CGRectGetMaxX(bounds) - pad) b.origin.x = CGRectGetMaxX(bounds) - pad - w;
        if (b.origin.y < bounds.origin.y + pad) b.origin.y = bounds.origin.y + pad;
        if (CGRectGetMaxY(b) > CGRectGetMaxY(bounds) - pad) b.origin.y = CGRectGetMaxY(bounds) - pad - h;
        CGRect r = CGRectInset(b, -3, -2);
        BOOL clear = YES;
        for (NSValue *v in avoid) if (!last && CGRectIntersectsRect(r, NSRectToCGRect(v.rectValue))) { clear = NO; break; }
        if (clear) { box = b; hit = r; }
    }
    if (CGRectIsNull(box)) {
        CFRelease(line); CFRelease(font); CGColorRelease(colour);
        return CGRectNull;
    }
    CGContextSaveGState(c);
    // The context is y down; text draws y up.
    CGContextTranslateCTM(c, box.origin.x, box.origin.y + ascent);
    CGContextScaleCTM(c, 1, -1);
    CGContextSetTextPosition(c, 0, 0);
    HazardRGB halo = HaloInk(dark);
    CGContextSetRGBStrokeColor(c, halo.r, halo.g, halo.b, 0.92);
    CGContextSetLineWidth(c, size * 0.28);
    CGContextSetLineJoin(c, kCGLineJoinRound);
    CGContextSetTextDrawingMode(c, kCGTextStroke);
    CTLineDraw(line, c);
    CGContextSetTextDrawingMode(c, kCGTextFill);
    CGContextSetTextPosition(c, 0, 0);
    CTLineDraw(line, c);
    CGContextRestoreGState(c);
    CFRelease(line);
    CFRelease(font);
    CGColorRelease(colour);
    [LastLabels() addObject:text];
    return hit;
}

static CGRect DrawLabel(CGContextRef c, NSString *text, double x, double y, double size, HazardRGB ink, BOOL dark,
    CGRect bounds, NSArray<NSValue *> *avoid, BOOL bold) {
    CGPoint at = CGPointMake(x, y);
    return DrawLabelAt(c, text, &at, 1, size, ink, dark, bounds, avoid, bold, NO);
}

static void DrawKey(CGContextRef c, CGRect bounds, double scale, BOOL dark, BOOL cb, BOOL sigmets) {
    double size = 10.5 * scale, gap = 6 * scale, swatch = 16 * scale;
    NSMutableArray *names = [NSMutableArray array];
    if (cb) [names addObject:@"CB potential (model)"];
    if (sigmets) [names addObject:@"SIGMET (official)"];
    if (!names.count) return;
    CTFontRef font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, NULL);
    if (!font) return;
    HazardRGB text = dark ? (HazardRGB){0.92, 0.92, 0.92} : (HazardRGB){0.16, 0.16, 0.16};
    CGColorRef colour = CGColorCreateSRGB(text.r, text.g, text.b, 1);
    NSMutableArray *lines = [NSMutableArray array];
    double total = 0, height = 0;
    for (NSString *name in names) {
        NSDictionary *attrs = @{(__bridge id)kCTFontAttributeName: (__bridge id)font,
                                (__bridge id)kCTForegroundColorAttributeName: (__bridge id)colour};
        CTLineRef line = CTLineCreateWithAttributedString(
            (__bridge CFAttributedStringRef)[[NSAttributedString alloc] initWithString:name attributes:attrs]);
        CGFloat ascent = 0, descent = 0;
        double w = CTLineGetTypographicBounds(line, &ascent, &descent, NULL);
        if (ascent + descent > height) height = ascent + descent;
        total += swatch + 4 * scale + w + gap * 2;
        [lines addObject:@[(__bridge_transfer id)line, @(w), @(ascent)]];
    }
    double pad = 6 * scale, rowH = height + 6 * scale;
    CGRect panel = CGRectMake(CGRectGetMaxX(bounds) - total - pad + gap, CGRectGetMaxY(bounds) - rowH - 8 * scale,
        total - gap + pad, rowH);
    HazardRGB back = dark ? (HazardRGB){0.12, 0.13, 0.15} : (HazardRGB){1, 1, 1};
    CGContextSetRGBFillColor(c, back.r, back.g, back.b, 0.86);
    CGPathRef rounded = CGPathCreateWithRoundedRect(panel, 4 * scale, 4 * scale, NULL);
    CGContextAddPath(c, rounded);
    CGContextFillPath(c);
    CGPathRelease(rounded);
    double x = panel.origin.x + pad * 0.6, mid = CGRectGetMidY(panel);
    for (NSUInteger i = 0; i < lines.count; i++) {
        CGRect sw = CGRectMake(x, mid - 5 * scale, swatch, 10 * scale);
        if ([names[i] hasPrefix:@"CB"]) {
            CGMutablePathRef p = CGPathCreateMutable();
            CGPoint pts[4] = {{sw.origin.x, sw.origin.y}, {sw.origin.x, CGRectGetMaxY(sw)},
                {CGRectGetMaxX(sw), CGRectGetMaxY(sw)}, {CGRectGetMaxX(sw), sw.origin.y}};
            AddScallopRing(p, pts, 4, 4.0 * scale);
            HazardRGB amber = AmberInk(dark);
            SetStroke(c, amber, 0.42);
            Hatch(c, p, CGRectInset(sw, -3 * scale, -3 * scale), 3.5 * scale, YES, 0.7 * scale);
            SetStroke(c, amber, 0.95);
            CGContextSetLineWidth(c, 1.0 * scale);
            CGContextAddPath(c, p);
            CGContextStrokePath(c);
            CGPathRelease(p);
        } else {
            SetStroke(c, SigmetInk(dark), 1);
            CGContextSetLineWidth(c, 1.6 * scale);
            CGContextStrokeRect(c, CGRectInset(sw, 1 * scale, 1 * scale));
        }
        x += swatch + 4 * scale;
        CTLineRef line = (__bridge CTLineRef)lines[i][0];
        double w = [lines[i][1] doubleValue], ascent = [lines[i][2] doubleValue];
        CGContextSaveGState(c);
        CGContextTranslateCTM(c, x, mid - height * 0.5 + ascent);
        CGContextScaleCTM(c, 1, -1);
        CGContextSetTextPosition(c, 0, 0);
        CGContextSetTextDrawingMode(c, kCGTextFill);
        CTLineDraw(line, c);
        CGContextRestoreGState(c);
        [LastLabels() addObject:names[i]];
        x += w + gap * 2;
    }
    CGColorRelease(colour);
    CFRelease(font);
}

static CGPathRef SigmetPath(IsobarSigmet *s, IsobarCamera camera, CGPoint *centroid) {
    CGMutablePathRef path = CGPathCreateMutable();
    double sx = 0, sy = 0;
    NSInteger used = 0;
    // Edges are densified so a long polygon side follows the projection.
    for (NSInteger i = 0; i < s.pointCount; i++) {
        double la0 = [s latitudeAtIndex:i], lo0 = [s longitudeAtIndex:i];
        double la1 = [s latitudeAtIndex:(i + 1) % s.pointCount], lo1 = [s longitudeAtIndex:(i + 1) % s.pointCount];
        int parts = (int)ceil(fmax(fabs(la1 - la0), fabs(lo1 - lo0)) / 0.5);
        if (parts < 1) parts = 1;
        for (int k = 0; k < parts; k++) {
            double t = (double)k / parts, x = 0, y = 0;
            if (!IsobarCameraProject(camera, la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t, &x, &y)) continue;
            if (used == 0) CGPathMoveToPoint(path, NULL, x, y);
            else CGPathAddLineToPoint(path, NULL, x, y);
            if (k == 0) { sx += x; sy += y; }
            used++;
        }
    }
    if (used) CGPathCloseSubpath(path);
    if (centroid) *centroid = CGPointMake(sx / MAX(1, s.pointCount), sy / MAX(1, s.pointCount));
    return path;
}

void IsobarHazardDraw(CGContextRef c, IsobarHazardFrame *frame, NSArray<IsobarSigmet *> *sigmets,
    NSDate *time, IsobarCamera camera, double scale, BOOL dark, BOOL key, NSArray<NSValue *> *reserved) {
    [LastLabels() removeAllObjects];
    if (!c) return;
    if (!(scale > 0)) scale = 1;
    CGRect bounds = CGRectMake(0, 0, camera.viewportW, camera.viewportH);
    CGContextSaveGState(c);
    CGContextClipToRect(c, bounds);
    CGContextSetLineJoin(c, kCGLineJoinRound);
    CGContextSetLineCap(c, kCGLineCapRound);
    NSMutableArray<NSValue *> *placed = [NSMutableArray arrayWithArray:reserved ?: @[]];
    HazardRGB amber = AmberInk(dark), red = RedInk(dark);
    // Model CB: hatch first, scallops over it.
    CGMutablePathRef outline = CGPathCreateMutable(), likely = CGPathCreateMutable(), severe = CGPathCreateMutable();
    CGMutablePathRef outlineScallop = CGPathCreateMutable(), severeScallop = CGPathCreateMutable();
    for (NSInteger level = 0; level < 3; level++) {
        for (NSInteger r = 0; r < [frame ringCountForLevel:level]; r++) {
            CGMutablePathRef plain = level == 0 ? outline : level == 1 ? likely : severe;
            CGMutablePathRef scallop = level == 0 ? outlineScallop : level == 2 ? severeScallop : NULL;
            AddProjectedRing(plain, scallop, frame, r, level, camera, (level == 2 ? 5.0 : 7.0) * scale);
        }
    }
    if (!CGPathIsEmpty(outline)) {
        CGRect box = CGRectIntersection(CGPathGetBoundingBox(outlineScallop), bounds);
        CGContextBeginTransparencyLayerWithRect(c, CGRectInset(box, -4 * scale, -4 * scale), NULL);
        SetStroke(c, amber, dark ? 0.26 : 0.36);
        Hatch(c, outlineScallop, box, 7.0 * scale, YES, (dark ? 0.6 : 0.7) * scale);
        if (!CGPathIsEmpty(likely)) {
            CGRect lbox = CGRectIntersection(CGPathGetBoundingBox(likely), bounds);
            SetStroke(c, amber, dark ? 0.28 : 0.42);
            CGContextSaveGState(c);
            CGContextTranslateCTM(c, 3.5 * scale, 0);
            CGAffineTransform back = CGAffineTransformMakeTranslation(-3.5 * scale, 0);
            CGPathRef shifted = CGPathCreateCopyByTransformingPath(likely, &back);
            Hatch(c, shifted, CGRectOffset(lbox, -3.5 * scale, 0), 7.0 * scale, YES, (dark ? 0.6 : 0.7) * scale);
            CGPathRelease(shifted);
            CGContextRestoreGState(c);
        }
        if (!CGPathIsEmpty(severe)) {
            CGRect sbox = CGRectIntersection(CGPathGetBoundingBox(severeScallop), bounds);
            SetStroke(c, red, dark ? 0.30 : 0.42);
            Hatch(c, severeScallop, sbox, 7.0 * scale, NO, (dark ? 0.6 : 0.7) * scale);
        }
        SetStroke(c, amber, 0.95);
        CGContextSetLineWidth(c, 1.1 * scale);
        CGContextAddPath(c, outlineScallop);
        CGContextStrokePath(c);
        if (!CGPathIsEmpty(severeScallop)) {
            SetStroke(c, red, 0.95);
            CGContextSetLineWidth(c, 1.1 * scale);
            CGContextAddPath(c, severeScallop);
            CGContextStrokePath(c);
        }
        CGPathRef shore = CoastPath(FrameBox(frame), camera);
        if (!CGPathIsEmpty(shore)) {
            CGContextSetBlendMode(c, kCGBlendModeClear);
            CGContextSetLineWidth(c, 3.0 * scale);
            CGContextAddPath(c, shore);
            CGContextStrokePath(c);
            CGContextSetBlendMode(c, kCGBlendModeNormal);
        }
        CGPathRelease(shore);
        CGContextEndTransparencyLayer(c);
    }
    CGPathRelease(outline); CGPathRelease(likely); CGPathRelease(severe);
    CGPathRelease(outlineScallop); CGPathRelease(severeScallop);
    // SIGMETs over the model, solid, no hatch.
    NSMutableArray *valid = [NSMutableArray array];
    for (IsobarSigmet *s in sigmets) if ([s isValidAt:time]) [valid addObject:s];
    NSMutableArray *sigmetLabels = [NSMutableArray array];
    NSInteger sigmetsDrawn = 0;
    for (IsobarSigmet *s in valid) {
        CGPoint centre = CGPointZero;
        CGPathRef path = SigmetPath(s, camera, &centre);
        if (!CGPathIsEmpty(path) && CGRectIntersectsRect(CGPathGetBoundingBox(path), bounds)) {
            HazardRGB halo = HaloInk(dark);
            SetStroke(c, halo, 0.7);
            CGContextSetLineWidth(c, 3.2 * scale);
            CGContextAddPath(c, path);
            CGContextStrokePath(c);
            SetStroke(c, SigmetInk(dark), 1);
            CGContextSetLineWidth(c, 1.6 * scale);
            CGContextAddPath(c, path);
            CGContextStrokePath(c);
            // Anchors inside the visible part of the polygon: its centre first,
            // then a 3×3 lattice over the visible box.
            CGRect vis = CGRectIntersection(CGPathGetBoundingBox(path), bounds);
            NSMutableArray *anchors = [NSMutableArray array];
            if (CGRectContainsPoint(vis, centre) && CGPathContainsPoint(path, NULL, centre, true))
                [anchors addObject:[NSValue valueWithPoint:NSPointFromCGPoint(centre)]];
            for (int gy = 1; gy <= 3; gy++)
                for (int gx = 1; gx <= 3; gx++) {
                    CGPoint p = CGPointMake(vis.origin.x + vis.size.width * gx / 4.0, vis.origin.y + vis.size.height * gy / 4.0);
                    if (CGPathContainsPoint(path, NULL, p, true)) [anchors addObject:[NSValue valueWithPoint:NSPointFromCGPoint(p)]];
                }
            if (!anchors.count) [anchors addObject:[NSValue valueWithPoint:NSMakePoint(CGRectGetMidX(vis), CGRectGetMidY(vis))]];
            [sigmetLabels addObject:@[s, anchors]];
            sigmetsDrawn++;
        }
        CGPathRelease(path);
    }
    CGRect keyRect = CGRectNull;
    if (key && (frame.areas.count || sigmetsDrawn)) {
        // Reserve the key's corner before labels.
        keyRect = CGRectMake(CGRectGetMaxX(bounds) - 300 * scale, CGRectGetMaxY(bounds) - 30 * scale, 300 * scale, 30 * scale);
        [placed addObject:[NSValue valueWithRect:NSRectFromCGRect(keyRect)]];
    }
    for (NSArray *item in sigmetLabels) {
        IsobarSigmet *s = item[0];
        NSArray<NSValue *> *list = item[1];
        CGPoint anchors[10];
        NSInteger count = 0;
        for (NSValue *v in list) if (count < 10) anchors[count++] = NSPointToCGPoint(v.pointValue);
        // An official warning keeps its words even when the map is crowded.
        CGRect r = DrawLabelAt(c, [s label], anchors, count, 10.5 * scale, SigmetInk(dark), dark, bounds, placed, YES, YES);
        if (!CGRectIsNull(r)) [placed addObject:[NSValue valueWithRect:NSRectFromCGRect(r)]];
    }
    // The hatch and the key already say "CB potential". A word goes only on an
    // outline big enough to hold it, at most six, each a label-width apart, so
    // a busy tropics frame reads as areas rather than a field of text.
    NSInteger drawn = 0;
    double minArea = 3200.0 * scale * scale;
    for (IsobarHazardArea *a in frame.areas) {
        if (drawn >= 6) break;
        double x = 0, y = 0, x1 = 0, y1 = 0;
        if (!IsobarCameraProject(camera, a.labelLatitude, a.labelLongitude, &x, &y)) continue;
        if (!CGRectContainsPoint(bounds, CGPointMake(x, y))) continue;
        if (IsobarCameraProject(camera, a.labelLatitude, a.labelLongitude + frame->_grid.step, &x1, &y1)) {
            double cell = hypot(x1 - x, y1 - y);
            if ((double)a.areaCells * cell * cell < minArea && a.peakClass != IsobarCBSevere) continue;
        }
        HazardRGB ink = a.peakClass == IsobarCBSevere ? red : amber;
        if (!dark) ink = (HazardRGB){ink.r * 0.82, ink.g * 0.82, ink.b * 0.82};
        CGRect r = DrawLabel(c, [a label], x, y, 10.5 * scale, ink, dark, bounds, placed, YES);
        if (!CGRectIsNull(r)) {
            [placed addObject:[NSValue valueWithRect:NSRectFromCGRect(CGRectInset(r, -r.size.width * 0.5, -r.size.height))]];
            drawn++;
        }
    }
    if (key && (frame.areas.count || sigmetsDrawn)) DrawKey(c, bounds, scale, dark, frame.areas.count > 0, sigmetsDrawn > 0);
    CGContextRestoreGState(c);
}

static BOOL PathContains(CGPathRef path, double x, double y) {
    return CGPathContainsPoint(path, NULL, CGPointMake(x, y), true);
}

NSString *IsobarHazardTooltip(IsobarHazardFrame *frame, NSArray<IsobarSigmet *> *sigmets,
    NSDate *time, IsobarCamera camera, double x, double y) {
    NSMutableArray *parts = [NSMutableArray array];
    for (IsobarSigmet *s in sigmets) {
        if (![s isValidAt:time]) continue;
        CGPathRef path = SigmetPath(s, camera, NULL);
        if (PathContains(path, x, y)) [parts addObject:[s tooltip]];
        CGPathRelease(path);
    }
    double lat = 0, lon = 0;
    if (frame && IsobarCameraUnproject(camera, x, y, &lat, &lon)) {
        IsobarHazardArea *a = [frame areaAtLatitude:lat longitude:lon];
        if (a) [parts insertObject:[a tooltip] atIndex:0];
    }
    return parts.count ? [parts componentsJoinedByString:@"\n\n"] : nil;
}
