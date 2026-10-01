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
// Interactive stills must be readable even if the pointer stops after one
// frame. Movies leave this off so newly appearing annotations can fade in.
@property (nonatomic) BOOL immediateAnnotations;
@property (nonatomic, readonly) CGFloat maxLabelStep;
@property (nonatomic, readonly) CGFloat maxCentreStep;
@end

OwnRun *OwnRunLoad(NSString *runDirectory, NSString *coastPath, NSString **error);
OwnRun *OwnRunLoadPublished(NSString *root, BOOL previous, NSString *coastPath, NSString **error);
// stations are @{@"lat", @"lon", @"mm"}. scale is the pixel multiple (1–3).
NSImage *OwnRunRender(OwnRun *run, NSInteger hour, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale);
NSImage *OwnRunRenderFraction(OwnRun *run, double fractionalIndex, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale);
NSImage *OwnRunRenderMotion(OwnRun *run, double fractionalIndex, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale, OwnMotionState *state);
