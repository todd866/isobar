// Own-chart — pure geometry for a Bureau-style MSLP prototype.
// Foundation only. Drawing lives in tools/own-chart.m.
#import <Foundation/Foundation.h>

// ECMWF IFS 0.25° window, 95°E–170°E and 0°–50°S (60,501 points).
// Row 0 is the northern edge. Index = row * nLon + column.
// The chart draws a tighter Lambert frame; this is the field it samples.
double OwnGridStep(void);
double OwnGridWest(void);
double OwnGridNorth(void);
double OwnGridEast(void);
double OwnGridSouth(void);
int OwnGridNLon(void);
int OwnGridNLat(void);
NSInteger OwnGridCount(void);
void OwnGridCoord(NSInteger index, double *latitude, double *longitude);

// Requests stay at or under 200 locations. Ranges partition the grid.
enum { OwnBatchLimit = 200 };
NSInteger OwnBatchCount(void);
void OwnBatchRange(NSInteger batch, NSInteger *start, NSInteger *length);

// Open-Meteo ECMWF IFS 0.25° forecast. forecastDays is written as given.
// This is the fallback for a "Now" precipitation window, not the chart grid.
NSString *OwnForecastURL(const double *latitudes, const double *longitudes,
    NSInteger count, NSInteger forecastDays);
// Same request with past_days, so a trailing 24 h sum can see the day before
// the forecast. pastDays of 0 omits the parameter.
NSString *OwnForecastURLWithPast(const double *latitudes, const double *longitudes,
    NSInteger count, NSInteger forecastDays, NSInteger pastDays);
// One dictionary per location: latitude, longitude, time, and the six series.
// Nil when the payload is an error or a series is missing.
NSArray<NSDictionary *> *OwnParseForecast(NSData *json);
// Index of yyyy-MM-dd'T'HH:mm in the UTC time list, or -1.
NSInteger OwnTimeIndex(NSArray<NSString *> *times, NSDate *instant);
// Sum of `hours` values ending at index, missing entries counted as zero.
// A window that starts before the series is shortened rather than rejected.
double OwnTrailingSum(NSArray *values, NSInteger index, NSInteger hours);
// Same sum, but NAN unless all `hours` samples lie inside the series.
// The Bureau hatch is a full preceding day, not the few hours since a model run.
double OwnPrecedingSum(NSArray *values, NSInteger index, NSInteger hours);
// Millimetres between two accumulated totals. NAN when either value is missing
// or the later total has reset (more than 0.05 mm below the earlier one).
// Packing noise just below zero becomes zero. Now and every later frame use this.
double OwnAccumulationWindow(double endMm, double startMm);

// At most two fetches a day: a fetch is due when the last one is 12 h old.
BOOL OwnRefreshDue(NSDate *lastFetch, NSDate *now);

// Eight valid times of the four-day prognosis issued on `now`'s Eastern
// Standard calendar day: 10am EST the next day, then every 12 hours.
// Eastern Standard is fixed UTC+10, matching the Bureau charts.
NSArray<NSDate *> *OwnPrognosisTimes(NSDate *now);
// forecast_days that covers lastValid from UTC midnight of `now`. At least 4.
NSInteger OwnForecastDayCount(NSDate *now, NSDate *lastValid);
NSDate *OwnNearestHour(NSDate *now);
// "10am EST Sun 27 Sep", or "Now · 2pm EST Sat 26 Sep".
NSString *OwnValidTitle(NSDate *valid, BOOL now);

// Tangent Lambert conformal. parallelDeg is the standard parallel (south negative).
// y increases north. Central meridian projects to x = 0.
typedef struct {
    double lon0;
    double parallel;
    double n, F, rho0;
    BOOL valid;
} OwnLambert;

OwnLambert OwnLambertMake(double centralMeridianDeg, double parallelDeg);
// 130°E, standard parallel 30°S — the cone fitted to the Bureau analysis.
OwnLambert OwnAustraliaLambert(void);
BOOL OwnProject(OwnLambert geo, double latitude, double longitude, double *x, double *y);
BOOL OwnUnproject(OwnLambert geo, double x, double y, double *latitude, double *longitude);

// Geographic window fitted into a pixel rectangle. Projected y is down.
typedef struct {
    OwnLambert geo;
    double west, east, south, north;
    double pixelX, pixelY, pixelW, pixelH;
    double scale, offsetX, offsetY;
    double minX, maxX, minY, maxY;
    BOOL valid;
} OwnView;

OwnView OwnViewMake(OwnLambert geo, double west, double east, double south, double north,
    double pixelX, double pixelY, double pixelW, double pixelH);
BOOL OwnViewProject(OwnView view, double latitude, double longitude, double *x, double *y);

typedef struct {
    double x, y;
} OwnVec;

// Direction the air moves for a meteorological bearing (degrees FROM north).
// Vector coordinates are east/right and north/up.
BOOL OwnWindFlow(double fromDegrees, OwnVec *vector);

typedef struct {
    OwnVec *pts;
    int count;
    int closed;
    double level;
} OwnLine;

typedef struct {
    OwnLine *lines;
    int count;
} OwnLineSet;

void OwnLineSetFree(OwnLineSet set);

// Marching squares. field is row-major, index = j * nLon + i.
// Coordinates are origin + index * spacing. Non-finite corners are skipped.
// Levels equal to a grid value are nudged so the line does not sit on a node.
OwnLineSet OwnContours(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy,
    const double *levels, int nLevels);

// In-place Laplacian. Open endpoints stay put. `passes` of 0 is a no-op.
void OwnSmoothLine(OwnVec *pts, int count, int closed, int passes);
// Insert a midpoint on every edge. Returns the new count, or -1 if outCap is short.
// Open lines need 2*n-1 slots; closed lines need 2*n.
int OwnDensify(const OwnVec *in, int n, int closed, OwnVec *out, int outCap);

// Multiples of `step` strictly inside (minV, maxV).
int OwnInteriorLevels(double minV, double maxV, double step, double *out, int cap);

// Local extrema. Position is refined by a parabolic offset on the 3×3.
// minSeparation is in the same units as origin/dx/dy. minRelief is the
// average excess over the eight neighbours.
typedef struct {
    double x, y, value;
    int high;
} OwnExtremum;

int OwnExtrema(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy,
    double minSeparation, double minRelief,
    OwnExtremum *out, int cap);

typedef struct {
    double x, y;
    double angle;
    double halfW, halfH;
    double arc;
    double gap;
    double level;
    int line;
} OwnLabel;

typedef double (*OwnHalfWidth)(double level, void *context);

// Greedy labels along each line. halfWidth returns the glyph half-width.
// A label whose rotated box leaves [minX,maxX]×[minY,maxY] is skipped.
// Boxes are padded by `padding` when testing overlap.
int OwnPlaceLabels(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight, double padding,
    double minX, double minY, double maxX, double maxY,
    OwnLabel *out, int cap);
BOOL OwnLabelsOverlap(OwnLabel a, OwnLabel b, double padding);
// Folds a baseline into (-π/2, π/2] so digits stay upright.
double OwnReadableAngle(double radians);

// Cuts gap intervals out of one polyline. Labels are already in that line's
// arc-length. No labels returns a copy. A closed ring opened by a gap comes
// back as open parts.
OwnLineSet OwnCutGaps(const OwnVec *pts, int count, int closed,
    const OwnLabel *labels, int nLabels);

// Wind barb in a y-up frame: +y north, +x east, station at the origin.
// `fromDegrees` is the direction the wind comes from. Speed is knots.
// Under 5 kt is a calm circle. southernHemisphere flips the feathers
// (Australian charts).
typedef struct {
    double x, y;
} OwnBarbPoint;

typedef struct {
    OwnBarbPoint a, b;
} OwnBarbSeg;

typedef struct {
    int calm;
    int nFull, nHalf, nPenn;
    OwnBarbPoint tip;
    int nSeg;
    OwnBarbSeg segs[16];
    int nTri;
    OwnBarbPoint tri[4][3];
} OwnBarb;

OwnBarb OwnWindBarb(double fromDegrees, double knots, double staff, BOOL southernHemisphere);

// Low-saturation cool-to-warm ramp for a temperature field.
typedef struct {
    double r, g, b;
} OwnRGB;

OwnRGB OwnTemperatureRGB(double celsius);

// Natural Earth crop. See Resources/OWNCHART-COAST.txt.
typedef struct {
    double *lon;
    double *lat;
    int *ringStart;
    int *ringCount;
    int rings;
    int points;
} OwnCoast;

OwnCoast OwnCoastParse(NSData *data);
void OwnCoastFree(OwnCoast coast);
