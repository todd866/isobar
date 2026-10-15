// Isobar — E6-B wind triangle, Foundation-only numeric core.
#import <Foundation/Foundation.h>

typedef struct {
    double wca; // degrees, right positive
    double th;  // true heading degrees, [0, 360)
    double gs;  // knots
} E6BHeadingResult;

typedef struct {
    double from; // wind-from direction degrees, [0, 360)
    double kt;   // knots
} E6BWindResult;

// Wrap an angle into [0, 360). Non-finite input returns NAN.
double E6BWrap360(double angle);
// Signed shortest angle in [-180, 180]. Non-finite input returns NAN.
double E6BSigned180(double angle);

// Solve heading, WCA and ground speed for true course, TAS, wind-from and
// wind speed. Returns NO when no forward solution exists; all result fields
// are NAN in that case. Angles are true degrees and speeds are knots.
BOOL E6BSolveHeading(double tc, double tas, double windFrom, double windKt,
                     E6BHeadingResult *result);

// Solve wind direction and speed from true heading, true course, TAS and GS.
// Returns NO for invalid/non-positive air or ground speeds. For calm wind the
// direction is mathematically undefined; from is deterministically 180 and
// kt is 0 to match the shared TypeScript fixture convention.
BOOL E6BSolveWind(double th, double tc, double tas, double gs,
                  E6BWindResult *result);
