#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

// The sky section (docs/design/sky-section.md): the air over one aerodrome at
// the map's time, drawn by the same TypeScript renderer as isobar.md. The page
// is training/sky.html, built into Resources/training with the trainer.

// AIP elevation, ft AMSL, for the TAF aerodromes the app offers; NAN otherwise.
double SkyAerodromeElevationFt(NSString *code);
// Signed distance to the coast along the section's W–E line, km (negative =
// west); nil inland or unknown.
NSNumber * _Nullable SkyAerodromeCoastKm(NSString *code);

// The page's input is a point feed, so any place can be shown, not only an
// aerodrome (docs/design/wind-and-point-sections.md):
//   {lat, lon, name, elevationFt, coastKm|null, nowMs,
//    profile: {run, time:[ms UTC], levels:[{hPa, z, t, rh, ws, wd, cc, w}]}|null,
//    report: {metar: {raw, time}|null, taf: {raw, issue, from, to}|null}|null}
// Missing values are null. The page uses the nearest profile sample within
// 3 h of the time, and otherwise draws no model cloud and says so in one line.

// A pressure-level product in the archive's point shape ({run, time:[UTC],
// levels:{"850":{height_m:[…], temperature_c:[…], …}}}) as the feed's
// profile; nil when it has no usable times or levels.
NSDictionary * _Nullable SkyProfileSeries(NSDictionary * _Nullable upper);

// A point feed. upper is a pressure-level product (any source with the
// archive's shape); aviation, when given, supplies the METAR/TAF. Nil
// without a finite position.
NSDictionary * _Nullable SkyPointFeed(double lat, double lon, NSString * _Nullable name, double elevationFt,
    NSNumber * _Nullable coastKm, NSDictionary * _Nullable upper, NSDictionary * _Nullable aviation, NSDate *now);

// The Fly card's point: an aerodrome, with its AIP elevation and coast, and
// its products only when they are its own (aviation by ICAO, upper by id).
// Nil without an aerodrome code.
NSDictionary * _Nullable SkySectionFeed(NSDictionary * _Nullable aviation, NSDictionary * _Nullable upper,
    NSDictionary * _Nullable aerodrome, NSDate *now);

// The directory holding sky.html and sky.js: the app's Resources/training, or
// ISOBAR_TRAINING_DIST in a harness. Nil when the page is not built.
NSString * _Nullable SkySectionWebRoot(void);

// Hosts the page in a WKWebView. The web view exists only while this view is
// in a window and not hidden; it is torn down otherwise. Time changes are
// coalesced: at most one is in flight to the page, and the page draws at most
// one state per frame from cached pictures. Light and dark follow the view's
// effective appearance. The view ignores the mouse, so a host underneath
// keeps its own clicks and tooltips.
@interface SkySectionView : NSView
// Show a point feed (SkyPointFeed). Nil clears nothing; the last feed stays.
- (void)setPoint:(nullable NSDictionary *)feed;
// The Fly card's convenience: SkySectionFeed, then setPoint:.
- (void)setAviation:(nullable NSDictionary *)aviation upper:(nullable NSDictionary *)upper
          aerodrome:(nullable NSDictionary *)aerodrome now:(NSDate *)now;
// The map's playhead. Nil shows now.
@property (nonatomic, strong, nullable) NSDate *time;
// What the page last drew (window.skyState): icao, timeMs, source, layers
// [{type, cover, baseFtAmsl, topFtAmsl, baseY, …}], freezingFt, notes.
@property (nonatomic, readonly, copy, nullable) NSDictionary *drawnState;
@property (nonatomic, readonly) BOOL pageReady;
@property (nonatomic, readonly, nullable) WKWebView *webView;
@property (nonatomic, copy, nullable) void (^onState)(NSDictionary *state);
// The rendered page as an image (offscreen captures and tests).
- (void)snapshotWithCompletion:(void (^)(NSImage * _Nullable image))completion;
@end

NS_ASSUME_NONNULL_END
