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
// Drops open lines shorter than `minLength`, and closed rings whose perimeter
// is shorter than `minLength` or whose absolute area is below `minArea`.
// A detour that returns within `pinch` and encloses less than `minArea` is
// cut out of the line it rides on; what remains is still one line.
void OwnPruneContours(OwnLineSet *set, double minLength, double minArea, double pinch);
// An open stroke shorter than `minLength` is a fragment. It is kept when an
// endpoint lies within `edge` of the rectangle and the stroke is at least
// `edgeLength`: that is the visible part of a contour that crosses the edge.
// A closed ring is not a fragment.
BOOL OwnIsOpenFragment(const OwnLine *line, double minLength, double edgeLength,
    double minX, double minY, double maxX, double maxY, double edge);
// Douglas–Peucker. A vertex within `epsilon` of the chord across a longer span
// is dropped. Open endpoints stay. A closed ring that would fall below 4 points
// is left unchanged.
void OwnSimplifyContours(OwnLineSet *set, double epsilon);

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
// One Chaikin corner cut. Open endpoints stay. Returns the new count, or -1
// if outCap is short. Closed rings need n >= 3 and 2n slots. Open lines need
// 2n slots (a two-point segment becomes four colinear points).
int OwnChaikin(const OwnVec *in, int n, int closed, OwnVec *out, int outCap);
// In-place separable Gaussian. `sigma` is in grid cells. Non-finite samples
// stay missing and do not spread into neighbours. Indices past the border are
// reflected back into the field; where a weight lands on missing data the
// kernel is renormalised. It does not wrap. sigma < 0.4 leaves the field.
void OwnGaussianSmooth(double *field, int nLon, int nLat, double sigma);

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

// Centre minus the mean on a ring of `radius` (same units as x/y). Positive
// at a high. Zero when the centre or most of the ring is missing.
double OwnRingProminence(const double *field, int nLon, int nLat,
    double originX, double originY, double dx, double dy,
    double x, double y, double radius);

// A candidate is kept when its prominence clears `appear` (positive at a
// high, negative at a low), or when `enclosed` is set and the prominence
// still has that sign and clears 0.5. Pass one contour interval as `appear`
// so an unenclosed centre is drawn only when it stands that far off its
// surroundings. A previous centre of the same type within `holdDistance`
// lowers the bar from `appear` to `hold`. Same-type centres closer than
// `mergeDistance` then collapse to the stronger value (higher high, deeper
// low). Distances are hypot(dx, dy) unless `geographic` is set: then x is
// longitude, y is latitude, and distances are kilometres.
#define kOwnIsobarInterval 4.0
int OwnSettleCentres(const OwnExtremum *candidates, const double *prominence,
    const int *enclosed, int n,
    double appear, double hold, double mergeDistance, double holdDistance,
    int geographic,
    const OwnExtremum *previous, int nPrevious,
    OwnExtremum *out, int cap);

// Closed lines only. A point on an open line is never inside.
BOOL OwnLineContains(const OwnLine *line, double x, double y);

// A closed line whose span is at least `minSpan`, whose every vertex lies
// inside [minX,maxX]×[minY,maxY], and whose level sits on the outer side of
// the centre, marks the most extreme same-type candidate inside it. A ring
// that leaves that window does not enclose a centre.
void OwnMarkEnclosedCentres(const OwnExtremum *candidates, int n,
    const OwnLine *lines, int nLines, double minSpan,
    double minX, double minY, double maxX, double maxY, int *enclosed);

// Drops a closed line whose span is below `maxSpan` and which contains none
// of `centres`. Open lines stay.
void OwnDropStrayRings(OwnLineSet *set, const OwnExtremum *centres, int nCentres,
    double maxSpan);

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

// Greedy horizontal labels along each line. halfWidth returns the glyph
// half-width. The glyph box stays at least 1.5 label-heights inside
// [minX,maxX]×[minY,maxY]; a line that only crosses that margin stays bare.
// Straighter spans, then spans farther inside the rectangle, are chosen
// first. Two labels closer than three times the wider label's width are
// not both placed. Boxes are also padded by `padding` when testing overlap.
int OwnPlaceLabels(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight, double padding,
    double minX, double minY, double maxX, double maxY,
    OwnLabel *out, int cap);
// Existing labels stay. A line of length >= `minLength` gains a label, and a
// line of length >= `longLength` gains a second, when a site exists that
// keeps the same edge margin and the same gap from every label. Returns the
// new count. A line that only crosses the margin stays bare.
int OwnCoverLabels(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight, double padding,
    double minX, double minY, double maxX, double maxY,
    double minLength, double longLength,
    OwnLabel *labels, int nLabels, int cap);
// Point of `line` nearest to (x, y), then slid at most `slide` along the line
// toward a straighter heading that still lies inside the rectangle.
// `distance` is how far (x, y) sits from the line. NO when that exceeds
// `maxDist`, or when no point inside the rectangle is within the slide.
BOOL OwnContourAnchor(double x, double y, const OwnLine *line,
    double maxDist, double slide,
    double minX, double minY, double maxX, double maxY,
    double *outX, double *outY, double *outArc, double *outTangent, double *distance);
BOOL OwnLabelsOverlap(OwnLabel a, OwnLabel b, double padding);
// Compacts `labels`, keeping earlier entries. A later label that overlaps an
// earlier one, or sits closer than three times the wider label's width, is
// dropped. Returns the kept count.
int OwnKeepSeparated(OwnLabel *labels, int n, double padding);
// Like OwnKeepSeparated, except the only label on a closed line is kept when
// it is merely inside the crowd radius. Overlapping glyphs are still dropped.
int OwnKeepRingLabels(OwnLabel *labels, int n, const OwnLine *lines, int nLines, double padding);
// Slides a label along its line until it is at least three of its widths
// from every centre and still clear of the other labels and the margin.
// A label with no such site is dropped. Returns the kept count.
int OwnClearCentreLabels(OwnLabel *labels, int nLabels,
    const OwnLine *lines, int nLines, const OwnVec *centres, int nCentres,
    double minX, double minY, double maxX, double maxY);
// A closed ring whose longer side is at least `minSpan` and which has no
// label yet gains one. The site is the point on the ring farthest from every
// centre, inside the map and clear of labels already placed. Open lines are
// left untouched. Returns the new count.
int OwnCoverClosedRings(const OwnLine *lines, int nLines,
    OwnHalfWidth halfWidth, void *context, double halfHeight,
    double minX, double minY, double maxX, double maxY, double minSpan,
    const OwnVec *centres, int nCentres,
    OwnLabel *labels, int nLabels, int cap);
// Folds a baseline into (-π/2, π/2] so digits stay upright.
double OwnReadableAngle(double radians);

// Cuts each label box out of one polyline. The box is halfW by halfH at
// `angle`, centred on (x, y), expanded by 2.5 px. Only the run of the line
// inside a box is removed. No labels returns a copy. A closed ring opened
// by a gap comes back as open parts.
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

// Animated MSLP chart. Not the Bureau PDF fills in MSLPColour*.
OwnRGB OwnChartSea(void);
OwnRGB OwnChartLand(void);
OwnRGB OwnChartInk(void);
OwnRGB OwnChartTitle(void);
// 20 hPa lines (1000, 1020, …) are heavier than the 4 hPa lines between them.
double OwnIsobarWidth(double levelHPa);

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
