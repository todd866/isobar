// Aviation hazard layer for the GPU map: model CB (thunderstorm) potential
// and official SIGMET polygons. Rendering is Core Graphics over the Metal map,
// shared by the live overlay and snapshots. Nothing here decides the popover's
// controls; GPUMapView exposes one `hazards` switch.
//
// CB potential is MODEL GUIDANCE from the ECMWF IFS 0.25° open data. It is not
// a forecast, a TAF or a SIGMET. A SIGMET is the official warning and is drawn
// differently (solid outline, no hatch). See docs/design/hazard-layer.md.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "fieldrender.h"

// ---- CB potential gates -------------------------------------------------
// A cell meets a class when all three inputs reach that class's floor:
//   possible:    MUCAPE ≥  500 J/kg, rain ≥ 1.0 mm/3 h, total cloud ≥ 50 %
//   likely:      MUCAPE ≥ 1000 J/kg, rain ≥ 2.0 mm/3 h, total cloud ≥ 70 %
//   severe risk: MUCAPE ≥ 1500 J/kg, rain ≥ 2.0 mm/3 h, total cloud ≥ 70 %
// Instability (MUCAPE), moisture (cloud) and a trigger (model rain). A dry
// high-CAPE cell stays off. Any missing input makes the cell missing.
typedef NS_ENUM(NSInteger, IsobarCBClass) {
    IsobarCBMissing = -1,
    IsobarCBNone = 0,
    IsobarCBPossible = 1,
    IsobarCBLikely = 2,
    IsobarCBSevere = 3
};
typedef struct { double mucape, rain3h, cloud; } IsobarCBGate;
// Index 0 possible, 1 likely, 2 severe risk.
extern const IsobarCBGate kIsobarCBGates[3];
IsobarCBClass IsobarCBClassify(double mucape, double rain3h, double cloud);
// min(MUCAPE / floor, rain / floor, cloud / floor) for that class: ≥ 1 meets
// it. NAN when an input is missing. The renderer contours this at 1, so the
// outline moves continuously as the inputs are interpolated in time.
double IsobarCBMargin(IsobarCBClass cls, double mucape, double rain3h, double cloud);
// "possible", "likely", "severe risk"; "missing" and "none".
NSString *IsobarCBClassName(IsobarCBClass cls);
// Model rain in one window from the run's accumulated `tp` (mm). A drop of
// more than 0.05 mm is a reset and returns NAN; a smaller negative clamps to 0.
double IsobarRainWindow(double earlier, double later);
// ICAO-style coverage word from the share of model cells inside an outlined
// area that meet the possible gate: < 50 % ISOL, 50–75 % OCNL, ≥ 75 % FRQ.
// It is the model's cell share, not an observed count of storms.
NSString *IsobarCBCoverageWord(double fraction);

// Synoptic cause flags for one cell (see IsobarHazardRun for the tests).
typedef NS_OPTIONS(uint8_t, IsobarCauseFlags) {
    IsobarCauseTrough = 1 << 0,     // cyclonic MSLP curvature: Laplacian ≥ 0.75 hPa/deg² on a 2° stencil
    IsobarCausePressureMinimum = 1 << 1, // pressure minimum; called trough until renderer supplies an L
    IsobarCauseFront = 1 << 2,      // |∇T850| ≥ 1.5 K per 100 km
    IsobarCauseColdAir = 1 << 3,    // 10 m wind blows colder 850 hPa air in at ≥ 0.1 K/h
    IsobarCauseHeat = 1 << 4        // 2 m temperature ≥ 30 °C
};
// One line, e.g. "trough + MUCAPE 1,800 J/kg". A cause needs at least 30 % of
// the area's cells. The caller supplies lowShare only for actual drawn Ls;
// an unmarked pressure minimum is trough evidence, never low evidence.
// Otherwise "instability + moisture".
NSString *IsobarCBCauseHint(double troughShare, double lowShare, double frontShare,
    double coldShare, double heatShare, double peakMucape);
// One sentence explaining how that cause builds CB, for the tooltip.
NSString *IsobarCBCauseLesson(NSString *hint);

// ---- SIGMET -------------------------------------------------------------
@interface IsobarSigmet : NSObject
@property (nonatomic, readonly, copy) NSString *raw;          // as issued, whitespace kept
@property (nonatomic, readonly, copy) NSString *firName;      // "YBBB BRISBANE"
@property (nonatomic, readonly, copy) NSString *sequence;     // "M01"
@property (nonatomic, readonly, copy) NSString *phenomenon;   // as written: "FRQ TSGR", "SEV TURB"
@property (nonatomic, readonly, copy) NSString *status;       // "OBS", "FCST" or ""
@property (nonatomic, readonly, copy) NSString *levels;       // as written: "FL200/400", "TOP FL370", "SFC/6000FT"
@property (nonatomic, readonly, copy) NSString *levelsLabel;  // the slash as an en dash, units kept: "FL200–FL400"
@property (nonatomic, readonly, copy) NSString *movement;     // "MOV NE 30KT", "STNR" or ""
@property (nonatomic, readonly, copy) NSString *change;       // "NC", "INTSF", "WKN" or ""
@property (nonatomic, readonly) NSDate *validFrom, *validTo;
@property (nonatomic, readonly) NSInteger pointCount;
- (double)latitudeAtIndex:(NSInteger)index;
- (double)longitudeAtIndex:(NSInteger)index;
- (BOOL)isValidAt:(NSDate *)time;
// "SIGMET SEV TURB FL200–FL400 until 0645Z"
- (NSString *)label;
// Plain words, the decode and the raw text: the hover text.
- (NSString *)tooltip;
// "FRQ TSGR" → "Frequent thunderstorms with hail"
- (NSString *)plainPhenomenon;
@end

// Parses one stored feature: the polygon from the raw "WI S2450 E15020 - …"
// group, the phenomenon and levels exactly as written, and validity from the
// raw "VALID ddhhmm/ddhhmm" (the feature's valid_from/valid_to epoch seconds
// anchor the month). Nil without a polygon of three points or a validity.
IsobarSigmet *IsobarSigmetParse(NSDictionary *feature);
// Every parseable feature of a stored product, with duplicates (the same
// text issued for two FIRs) dropped.
NSArray<IsobarSigmet *> *IsobarSigmetsFromProduct(NSDictionary *product);

// ---- Per-frame CB areas -------------------------------------------------
@interface IsobarHazardArea : NSObject
@property (nonatomic, readonly) IsobarCBClass peakClass;
@property (nonatomic, readonly) NSInteger areaCells;      // cells inside the outline
@property (nonatomic, readonly) NSInteger possibleCells;  // of those, cells meeting possible
@property (nonatomic, readonly) NSInteger likelyCells;
@property (nonatomic, readonly) double coverage;          // possibleCells / areaCells
@property (nonatomic, readonly, copy) NSString *coverageWord;
@property (nonatomic, readonly, copy) NSString *causeHint;
@property (nonatomic, readonly) double peakMucape, peakRain3h, peakCloud, peakGustKnots;
@property (nonatomic, readonly) double labelLatitude, labelLongitude;
// "CB OCNL"
- (NSString *)label;
- (NSString *)tooltip;
@end

@interface IsobarHazardFrame : NSObject
@property (nonatomic, readonly) double step;
@property (nonatomic, readonly) NSArray<IsobarHazardArea *> *areas; // largest first
// Closed lat/lon rings. Outline: the area outline (scalloped). Likely and
// severe: the denser-hatched cores. Rings run with the area on their left.
- (NSInteger)ringCountForLevel:(NSInteger)level; // 0 outline, 1 likely, 2 severe
- (NSInteger)vertexCountForRing:(NSInteger)ring level:(NSInteger)level;
- (void)vertexForRing:(NSInteger)ring level:(NSInteger)level index:(NSInteger)index
             latitude:(double *)latitude longitude:(double *)longitude;
// Recompute cause hints using the pressure L centres actually drawn by the
// map renderer. Centres are NSValue points with x=longitude, y=latitude.
// Passing an empty array clears any prior low cause. Call on the main thread
// after frame construction completes; never mutate a frame still being built.
- (void)updateDrawnLowCentres:(NSArray<NSValue *> *)centres;
// Area under a geographic point, or nil.
- (IsobarHazardArea *)areaAtLatitude:(double)latitude longitude:(double)longitude;
@end

// Model inputs for one run, quantised per step and kept off the main thread
// until published. Inputs come from the published grids
// products/grids/ecmwf_ifs025/runs/<run>/<field>/<valid>.f16: mucape,
// cloud_cover, tp, gust10, mslp, t850, t2m, u10, v10. A missing field leaves
// that input missing for the step.
@interface IsobarHazardRun : NSObject
@property (nonatomic, readonly) IsobarGeoGrid grid;
@property (nonatomic, readonly) NSInteger steps;
@property (nonatomic, readonly, copy) NSArray<NSDate *> *times;
// YES when the run had the CB inputs (mucape, cloud_cover, tp) for any step.
@property (nonatomic, readonly) BOOL hasCBInputs;
+ (instancetype)runFromStoreRoot:(NSString *)root runDate:(NSDate *)runDate
    times:(NSArray<NSDate *> *)times grid:(IsobarGeoGrid)grid error:(NSString **)error;
// Synthetic runs for tests. Rain is per 3 h (already differenced); NULL
// arrays are missing. Cause fields are optional (NULL).
- (instancetype)initWithGrid:(IsobarGeoGrid)grid times:(NSArray<NSDate *> *)times;
- (void)setStep:(NSInteger)step mucape:(const float *)mucape rain3h:(const float *)rain
          cloud:(const float *)cloud gust:(const float *)gustMetres mslp:(const float *)mslp
           t850:(const float *)t850 t2m:(const float *)t2m u10:(const float *)u10 v10:(const float *)v10;
// Time-interpolated inputs, contoured. Thread-safe; the GPU map calls it on
// a background queue and caches by step quantised to 0.02.
- (IsobarHazardFrame *)frameAtStep:(double)fractionalStep;
// Valid time of a fractional step (linear between steps).
- (NSDate *)timeAtStep:(double)fractionalStep;
@end

// ---- Drawing ------------------------------------------------------------
// Draws into `context` in viewport pixels, y down (the caller sets the CTM).
// CB areas: a scalloped amber outline with light diagonal hatch, denser where
// likely, a red scalloped core and cross-hatch where severe risk, and a
// "CB ISOL/OCNL/FRQ" label. SIGMETs valid at `time`: a solid dark-red outline
// and its label. The key, when asked, is one row bottom-right. Coast and
// isobars stay readable: hatch alpha stays ≤ 0.42 and there is no fill.
// Labels move to avoid each other and the `reserved` rects (NSRect values in
// viewport pixels, e.g. the map's own key and buttons).
void IsobarHazardDraw(CGContextRef context, IsobarHazardFrame *frame, NSArray<IsobarSigmet *> *sigmets,
    NSDate *time, IsobarCamera camera, double scale, BOOL dark, BOOL key, NSArray<NSValue *> *reserved);
// Hover text at a viewport pixel: the CB area and any valid SIGMET under it.
NSString *IsobarHazardTooltip(IsobarHazardFrame *frame, NSArray<IsobarSigmet *> *sigmets,
    NSDate *time, IsobarCamera camera, double x, double y);
// Label strings drawn by the last IsobarHazardDraw on this thread (tests).
NSArray<NSString *> *IsobarHazardLastLabels(void);
