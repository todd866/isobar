#import "solar.h"
#import <math.h>

static const double RAD = M_PI / 180.0;
static const double DEG = 180.0 / M_PI;
static const double DaySeconds = 86400.0;
static const double CivilThreshold = -6.0;
static const double SunriseThreshold = -50.0 / 60.0;

static BOOL ValidCoordinate(double latitude, double longitude) {
    return isfinite(latitude) && isfinite(longitude) && latitude >= -90.0 && latitude <= 90.0 &&
        longitude >= -180.0 && longitude <= 180.0;
}

static double WrapDegrees(double value) {
    value = fmod(value, 360.0);
    return value < 0.0 ? value + 360.0 : value;
}

static double JulianDate(NSDate *date) {
    return date.timeIntervalSince1970 / DaySeconds + 2440587.5;
}

// NOAA Solar Position Algorithm, simplified to the geometric solar centre.
// Equations: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// This is continuous in time and avoids local-time/DST arithmetic in the
// actual position calculation.
double SolarElevation(double latitude, double longitude, NSDate *instant) {
    if (!ValidCoordinate(latitude, longitude) || !instant || !isfinite(instant.timeIntervalSince1970)) return NAN;
    double jd = JulianDate(instant);
    double t = (jd - 2451545.0) / 36525.0;
    double l0 = WrapDegrees(280.46646 + t * (36000.76983 + 0.0003032 * t));
    double m = WrapDegrees(357.52911 + t * (35999.05029 - 0.0001537 * t));
    double mr = m * RAD;
    double eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    double c = (1.914602 - t * (0.004817 + 0.000014 * t)) * sin(mr)
             + (0.019993 - 0.000101 * t) * sin(2.0 * mr)
             + 0.000289 * sin(3.0 * mr);
    double trueLongitude = l0 + c;
    double omega = (125.04 - 1934.136 * t) * RAD;
    double apparentLongitude = (trueLongitude - 0.00569 - 0.00478 * sin(omega)) * RAD;
    double meanObliquity = (23.0 + (26.0 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60.0) / 60.0) * RAD;
    double obliquity = meanObliquity + 0.00256 * cos(omega) * RAD;
    double declination = asin(sin(obliquity) * sin(apparentLongitude));

    double y = tan(obliquity / 2.0);
    y *= y;
    double equationOfTime = 4.0 * DEG * (y * sin(2.0 * l0 * RAD)
        - 2.0 * eccentricity * sin(mr)
        + 4.0 * eccentricity * y * sin(mr) * cos(2.0 * l0 * RAD)
        - 0.5 * y * y * sin(4.0 * l0 * RAD)
        - 1.25 * eccentricity * eccentricity * sin(2.0 * mr));
    double utcMinutes = fmod(instant.timeIntervalSince1970, DaySeconds) / 60.0;
    if (utcMinutes < 0.0) utcMinutes += 1440.0;
    double solarMinutes = fmod(utcMinutes + equationOfTime + 4.0 * longitude, 1440.0);
    if (solarMinutes < 0.0) solarMinutes += 1440.0;
    double hourAngle = solarMinutes / 4.0 - 180.0;
    double lat = latitude * RAD;
    double cosineZenith = sin(lat) * sin(declination) + cos(lat) * cos(declination) * cos(hourAngle * RAD);
    cosineZenith = fmax(-1.0, fmin(1.0, cosineZenith));
    return asin(cosineZenith) * DEG;
}

static NSDate *LocalStartOfDay(NSDate *instant, NSTimeZone *zone) {
    NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone ?: [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    NSDateComponents *components = [calendar components:(NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay)
                                               fromDate:instant];
    return [calendar dateFromComponents:components];
}

static NSDate *Crossing(double latitude, double longitude, NSDate *a, NSDate *b, double threshold, BOOL rising) {
    double fa = SolarElevation(latitude, longitude, a) - threshold;
    double fb = SolarElevation(latitude, longitude, b) - threshold;
    if (!isfinite(fa) || !isfinite(fb) || (rising ? !(fa < 0.0 && fb >= 0.0) : !(fa >= 0.0 && fb < 0.0))) return nil;
    for (NSInteger i = 0; i < 42; i++) {
        NSTimeInterval span = [b timeIntervalSinceDate:a];
        NSDate *mid = [a dateByAddingTimeInterval:span / 2.0];
        double fm = SolarElevation(latitude, longitude, mid) - threshold;
        if (rising ? fm >= 0.0 : fm < 0.0) b = mid;
        else a = mid;
    }
    return [a dateByAddingTimeInterval:[b timeIntervalSinceDate:a] / 2.0];
}

static NSDictionary *EventsForThreshold(double latitude, double longitude,
                                                               NSDate *start, NSDate *end, double threshold) {
    if (!start || !end || [end compare:start] != NSOrderedDescending) return @{};
    NSMutableDictionary *events = [NSMutableDictionary dictionary];
    NSMutableArray *crossings=[NSMutableArray array];
    NSDate *previous = start;
    double previousValue = SolarElevation(latitude, longitude, previous) - threshold;
    NSTimeInterval duration = [end timeIntervalSinceDate:start];
    NSInteger steps = MAX(1, (NSInteger)ceil(duration / 600.0));
    for (NSInteger index = 1; index <= steps; index++) {
        NSDate *current = index == steps ? end : [start dateByAddingTimeInterval:index * 600.0];
        double currentValue = SolarElevation(latitude, longitude, current) - threshold;
        if (previousValue < 0.0 && currentValue >= 0.0) {
            NSDate *event = Crossing(latitude, longitude, previous, current, threshold, YES);
            if (event && [event compare:end]==NSOrderedAscending) { if (!events[@"rise"]) events[@"rise"] = event; [crossings addObject:@{@"kind":@"rise",@"time":event}]; }
        } else if (previousValue >= 0.0 && currentValue < 0.0) {
            NSDate *event = Crossing(latitude, longitude, previous, current, threshold, NO);
            if (event && [event compare:end]==NSOrderedAscending) { if (!events[@"set"]) events[@"set"] = event; [crossings addObject:@{@"kind":@"set",@"time":event}]; }
        }
        previous = current;
        previousValue = currentValue;
    }
    events[@"crossings"]=crossings;
    return [events copy];
}

static NSDate *NextLocalDay(NSDate *start, NSTimeZone *zone) {
    NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone ?: [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    return [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:start options:0];
}

NSDictionary<NSString *, id> *SolarDaylight(double latitude, double longitude, NSDate *instant, NSTimeZone *timeZone) {
    double elevation = SolarElevation(latitude, longitude, instant);
    if (!isfinite(elevation) || !instant) return nil;
    NSString *state = elevation >= SunriseThreshold ? @"day" : (elevation >= CivilThreshold ? @"civilTwilight" : @"night");
    NSMutableDictionary *result = [@{ @"state": state, @"altitudeDegrees": @(elevation) } mutableCopy];
    NSDate *start = LocalStartOfDay(instant, timeZone);
    NSDate *end = start ? NextLocalDay(start, timeZone) : nil;
    NSDictionary *civilEvents = start ? EventsForThreshold(latitude, longitude, start, end, CivilThreshold) : @{};
    result[@"civilEvents"]=civilEvents[@"crossings"]?:@[];
    if (civilEvents[@"rise"]) result[@"civilDawn"] = civilEvents[@"rise"];
    if (civilEvents[@"set"]) result[@"civilDusk"] = civilEvents[@"set"];
    // NOAA's conventional apparent sunrise/set centre is approximately -0.833°.
    NSDictionary *sunEvents = start ? EventsForThreshold(latitude, longitude, start, end, SunriseThreshold) : @{};
    result[@"sunEvents"]=sunEvents[@"crossings"]?:@[];
    if (sunEvents[@"rise"]) result[@"sunrise"] = sunEvents[@"rise"];
    if (sunEvents[@"set"]) result[@"sunset"] = sunEvents[@"set"];
    return result;
}
