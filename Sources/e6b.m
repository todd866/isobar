// Isobar — E6-B wind triangle, Foundation-only numeric core.
#import "e6b.h"
#include <math.h>

static void HeadingNaN(E6BHeadingResult *result) {
    if (result) result->wca = result->th = result->gs = NAN;
}

static void WindNaN(E6BWindResult *result) {
    if (result) result->from = result->kt = NAN;
}

double E6BWrap360(double angle) {
    if (!isfinite(angle)) return NAN;
    double wrapped = fmod(angle, 360.0);
    if (wrapped < 0.0) wrapped += 360.0;
    return wrapped == 360.0 ? 0.0 : wrapped;
}

double E6BSigned180(double angle) {
    double wrapped = E6BWrap360(angle);
    if (!isfinite(wrapped)) return NAN;
    return wrapped > 180.0 ? wrapped - 360.0 : wrapped;
}

BOOL E6BSolveHeading(double tc, double tas, double windFrom, double windKt,
                     E6BHeadingResult *result) {
    HeadingNaN(result);
    if (!result || !isfinite(tc) || !isfinite(tas) || !isfinite(windFrom) ||
        !isfinite(windKt) || tas <= 0.0 || windKt < 0.0) return NO;
    double angle = (windFrom - tc) * M_PI / 180.0;
    double cross = windKt * sin(angle);
    // The crosswind cannot exceed TAS. A tail component can still provide
    // positive GS at a 90-degree correction; reject numerical zero below.
    if (fabs(cross) > tas) return NO;
    double wca = asin(cross / tas) * 180.0 / M_PI;
    double gs = tas * cos(wca * M_PI / 180.0) - windKt * cos(angle);
    if (!isfinite(gs) || gs <= tas * 1e-12) return NO;
    result->wca = wca;
    result->th = E6BWrap360(tc + wca);
    result->gs = gs;
    return YES;
}

BOOL E6BSolveWind(double th, double tc, double tas, double gs,
                  E6BWindResult *result) {
    WindNaN(result);
    if (!result || !isfinite(th) || !isfinite(tc) || !isfinite(tas) ||
        !isfinite(gs) || tas <= 0.0 || gs <= 0.0) return NO;
    double tcr = tc * M_PI / 180.0;
    double thr = th * M_PI / 180.0;
    double wx = gs * sin(tcr) - tas * sin(thr);
    double wy = gs * cos(tcr) - tas * cos(thr);
    result->from = E6BWrap360(atan2(-wx, -wy) * 180.0 / M_PI);
    result->kt = hypot(wx, wy);
    // Suppress floating-point cancellation at calm; direction is conventional.
    if (result->kt < 1e-12) { result->from=180.0; result->kt=0.0; }
    return isfinite(result->from) && isfinite(result->kt);
}
