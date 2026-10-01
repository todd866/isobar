// AppKit entry to the own-chart renderer. Published grids are little-endian
// float16 fields selected by products/grids/ecmwf_ifs025/current.json.
#import <AppKit/AppKit.h>

double OwnChartPanelAspect(void);
double OwnChartMapAspect(void);
// Bureau rain key. Hatching is the 24 h to the chart time at or above 1 mm.
NSString *OwnRainLegendText(void);

typedef struct {
    int temperature; // 0 off, 1 the 850 hPa field, 2 the 2 m field
    int barbs;
    int rain;
    int observed; // station dots, and no model hatch
    int bare;     // map only; the popover draws its own heading
    int plateOnly; // sea, land and overlays, no isobars
    int inkOnly;   // isobars, labels and centres on a clear plate
} OwnLayerOptions;

typedef NS_ENUM(NSInteger, OwnRunField) {
    OwnRunFieldMSLP, OwnRunFieldT850, OwnRunFieldT2M,
    OwnRunFieldWindSpeed, OwnRunFieldWindDirection, OwnRunFieldRain
};

@interface OwnRun : NSObject
@property (nonatomic, readonly) NSInteger hours;
@property (nonatomic, readonly) NSDate *runDate;
@property (nonatomic, readonly) NSDate *generated;
@property (nonatomic, readonly, copy) NSString *attribution;
- (NSDate *)timeAtIndex:(NSInteger)index;
- (BOOL)hasRainAtIndex:(NSInteger)index;
- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field hour:(NSInteger)hour;
- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field fractionalHour:(double)hour;
@end

// Per-sequence state used by the motion renderer. Keep one instance for the
// complete movie so annotations do not get re-selected independently per
// frame. Static chart rendering does not use this object.
@interface OwnMotionState : NSObject
// A scrub sample can start mid-sequence. Annotations are drawn opaque in
// stills and movies either way, so one frame never shows grey type.
@property (nonatomic) BOOL immediateAnnotations;
@property (nonatomic, readonly) CGFloat maxLabelStep;
@property (nonatomic, readonly) CGFloat maxCentreStep;
// Largest label, centre, or contour alpha change after the first frame.
@property (nonatomic, readonly) CGFloat maxAnnotationAlphaStep;
// Frames after the first on which the set of labels at half opacity changed.
@property (nonatomic, readonly) NSInteger labelSetChanges;
// Chart-point positions of the annotations last drawn with this state.
- (NSInteger)copyLabelPoints:(CGPoint *)points max:(NSInteger)max;
- (NSInteger)copyCentrePoints:(CGPoint *)points max:(NSInteger)max;
@end

OwnRun *OwnRunLoad(NSString *runDirectory, NSString *coastPath, NSString **error);
OwnRun *OwnRunLoadPublished(NSString *root, BOOL previous, NSString *coastPath, NSString **error);
// stations are @{@"lat", @"lon", @"mm"}. scale is the pixel multiple (1–4).
NSImage *OwnRunRender(OwnRun *run, NSInteger hour, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale);
NSImage *OwnRunRenderFraction(OwnRun *run, double fractionalIndex, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale);
NSImage *OwnRunRenderMotion(OwnRun *run, double fractionalIndex, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale, OwnMotionState *state);

// Last OwnRunRender / OwnRunRenderMotion on this thread, in milliseconds.
typedef struct {
    double fieldMs;
    double smoothMs;
    double contourMs;
    double chaikinMs;
    double labelMs;
    double centreMs;
    double drawMs;
    double overlayMs;
    double plateMs;
    double totalMs;
} OwnRenderProfile;
OwnRenderProfile OwnRenderProfileLast(void);
