#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

@class OwnRun;

// The store reload in three steps. The controller captures a request on the
// main thread, StoreSnapshotLoad reads the disk on the store queue, and the
// controller commits the snapshot on the main thread. The loader uses
// Foundation, CoreGraphics and SQLite only: no views and no controller state.

// Recolours a Bureau prognosis for display. Pure; runs on the store queue.
typedef NSData *(*StoreChartRecolour)(NSData *pdf);

// Everything a load reads from the controller. Captured on the main thread
// and not changed once it is handed to the store queue.
@interface StoreReloadRequest : NSObject
@property (nonatomic, copy) NSString *root;
@property (nonatomic, strong) NSDate *now;
@property (nonatomic, copy) NSString *coastPath;
// Shown places, in order. Kite spots from the same snapshot join them.
@property (nonatomic, copy) NSArray<NSDictionary *> *places;
// The home aerodrome before an archived product adds runway ends; nil when unset.
@property (nonatomic, copy) NSDictionary *aerodrome;
// ICAO whose METAR/TAF file is read. Nil uses the home aerodrome's code.
@property (nonatomic, copy) NSString *aviationCode;
// Saved kite thresholds override the archive's. Nil when unset.
@property (nonatomic, strong) NSNumber *kiteMin, *kiteMax;
// The atmosphere window is open, so its product is read too.
@property (nonatomic) BOOL atmosphere;
// The committed runs and their file stamps. An unchanged legacy run is reused.
@property (nonatomic, strong) OwnRun *run, *previousRun;
@property (nonatomic, copy) NSString *runStamp, *previousRunStamp;
// Adopted Bureau chart bytes. Equal bytes skip the parse and the recolour.
@property (nonatomic, strong) NSData *chartPDF, *previousPDF;
@property (nonatomic) StoreChartRecolour recolourChart;
@end

typedef NS_ENUM(NSInteger, StoreChartChange) {
    StoreChartAbsent,
    StoreChartUnchanged,
    StoreChartChanged,
};

// One complete disk snapshot. A missing product stays missing. Whether a
// failed chart keeps the last good run is the commit's decision, not the
// loader's.
@interface StoreSnapshot : NSObject
@property (nonatomic, readonly, copy) NSString *root;
@property (nonatomic, readonly, strong) NSDate *now;
@property (nonatomic, readonly) BOOL statusOK, publishedGrid, publishedStore;
// Root and layout (published or legacy) of the chart. A kept run must match.
@property (nonatomic, readonly, copy) NSString *source;
// runDate is nil when the grid did not load; error says why when it can.
@property (nonatomic, readonly, strong) OwnRun *run, *previousRun;
@property (nonatomic, readonly, strong) NSDate *runDate, *previousRunDate, *issued;
@property (nonatomic, readonly, copy) NSArray<NSNumber *> *frameIndices;
@property (nonatomic, readonly, copy) NSString *error;
@property (nonatomic, readonly, copy) NSString *runStamp, *previousRunStamp;
// Bureau prognosis and its previous issue. A changed chart arrives parsed.
@property (nonatomic, readonly) StoreChartChange chartChange, previousChange;
@property (nonatomic, readonly, strong) NSData *chartPDF, *chartDrawn, *previousPDF;
@property (nonatomic, readonly) CGPDFDocumentRef chartDocument, previousDocument;
@property (nonatomic, readonly, copy) NSArray<NSDate *> *previousTimes;
// Weather. A nil kite threshold leaves the current one.
@property (nonatomic, readonly, copy) NSArray *rainDots, *kiteList, *airportSeries;
@property (nonatomic, readonly, strong) NSNumber *kiteMin, *kiteMax;
@property (nonatomic, readonly, copy) NSDictionary<NSString *, NSDictionary *> *weather;
@property (nonatomic, readonly, copy) NSDictionary *aviation, *notams, *sigmets, *atmosphere;
@property (nonatomic, readonly) BOOL atmosphereLoaded;
@end

// One serial queue at utility QoS for every load, so archive readers with
// unlocked statics stay single-threaded.
dispatch_queue_t StoreReloadQueue(void);
StoreSnapshot *StoreSnapshotLoad(StoreReloadRequest *request);

// The inputs of the published run (previous: the run before it) as one
// stamp: pointer bytes, its run files and the coast file. Nil when the
// pointer names no valid collector run. Exposed for tests.
NSString *StorePublishedRunStamp(NSString *root, BOOL previous, NSString *coastPath);

BOOL IsPDF(NSData *data);
// A document with at least one page, or NULL.
CGPDFDocumentRef PDFDocumentFromData(NSData *data) CF_RETURNS_RETAINED;

// Tests only; NULL in the app. Called on the loading thread as each phase of
// a load begins ("begin", "grid", ... "end") and on the main thread at
// "commit". A test may block in it to hold a load in flight.
typedef void (*StoreReloadHook)(const char *phase);
extern StoreReloadHook StoreReloadTestHook;
void StoreReloadNote(const char *phase);
