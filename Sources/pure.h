// Isobar — pure, Foundation-only logic shared by the app and the unit tests.
#import <Foundation/Foundation.h>

// Cache-buster ?YYYY-Mon-DD-HH:MM:SS on the four-day chart (or the HTML that embeds it).
// The stamp matches the GIF Last-Modified header and is UTC. Nil when absent.
NSDate *IssueTimeFromCacheBuster(NSString *text);
// RFC 7231 IMF-fix date, e.g. "Fri, 25 Sep 2026 02:45:25 GMT".
NSDate *IssueTimeFromHTTPDate(NSString *httpDate);

// "just now", "15m", "3h", "2d", or "—" when then is nil.
NSString *AgeText(NSDate *then, NSDate *now);
// "16:00" when then is the same local day as now, otherwise "25 Sep 16:00".
NSString *ClockText(NSDate *date, NSTimeZone *tz, NSDate *now);

// IDW60901-style latest-observations product for a state abbreviation. Nil if unknown.
NSString *ObservationProductForState(NSString *state);
// State observations index (station names and WMO ids). Nil if unknown.
NSString *ObservationIndexURL(NSString *state);
NSString *ObservationJSONURL(NSString *product, NSString *wmo);
// Hourly forecasts require a 6-character geohash. Nil when shorter than 6.
NSString *HourlyGeohash(NSString *geohash);

// Latest observation, or nil. time is an absolute NSDate from local_date_time_full
// in the header's state timezone. Numbers are NSNumber; rainTrace is a string.
NSDictionary *ParseLatestObservation(NSData *json);
// Up to seven daily forecasts, oldest first. tempMin may be NSNull.
NSArray<NSDictionary *> *ParseDailyForecasts(NSData *json);
// The next `limit` hours at or after `now`.
NSArray<NSDictionary *> *ParseHourlyForecasts(NSData *json, NSDate *now, NSInteger limit);
NSArray<NSDictionary *> *ParseWarnings(NSData *json);
// Detail payload from /v1/warnings/{id}, including plain text of the HTML message.
NSDictionary *ParseWarningDetail(NSData *json);
NSString *PlainTextFromHTML(NSString *html);
// One place from /v1/locations/{geohash}: name, state, geohash, latitude, longitude, timezone.
NSDictionary *ParseLocation(NSData *json);
NSArray<NSDictionary *> *ParseLocationSearch(NSData *json);
// Station rows from a state observations index: @{name, wmo}.
NSArray<NSDictionary *> *ParseObservationStations(NSString *html);
// Exact name match (case-insensitive). Nil when several names would have to be guessed.
NSDictionary *MatchStationByName(NSArray<NSDictionary *> *stations, NSString *placeName);

typedef struct {
    double width;
    double height;
    int pixelMultiple;   // source pixels per device pixel when integer
    BOOL integer;        // YES when each source pixel maps to an integer device-pixel square
} ChartFit;

// Largest integer device-pixel multiple of a pixel-sized chart that fits maxPointW.
// Otherwise a non-integer fit at maxPointW (caller uses high-quality interpolation).
ChartFit FitChart(double pixelW, double pixelH, double maxPointW, double backingScale);
// Native size is one source pixel per device pixel (pixel / backingScale points).
// That size is used when it fits in the box. Otherwise the chart scales down to fit,
// preserving aspect (caller uses high-quality interpolation). Never scales up.
ChartFit FitChartBox(double pixelW, double pixelH, double maxPointW, double maxPointH, double backingScale);

typedef struct {
    double x;
    double y;
    double width;
    double height;
} MSLPRect;

typedef struct {
    double pageWidth;
    double pageHeight;
    MSLPRect header;     // legend and issue time, above the panels
    MSLPRect panels[8];  // time order, PDF user space (origin at the bottom left)
    BOOL valid;
} MSLPPage;

// IDG00073 is one page: a header band, then eight panels in time order,
// 2 columns × 4 rows, left to right then top to bottom. Rects scale with the page.
MSLPPage MSLPPageLayout(double pageWidth, double pageHeight);

// Source cell on that 2×4 page. Row 0 is the top row.
int MSLPSourceColumn(int timeIndex);
int MSLPSourceRow(int timeIndex);
// Screen cell on the 4×2 grid, same time order. Row 0 is the top row.
int MSLPDisplayColumn(int timeIndex);
int MSLPDisplayRow(int timeIndex);

typedef struct {
    MSLPRect header;    // legend strip, aspect-fitted inside a slim band
    MSLPRect cells[8];  // time order, view space, origin at the top left
    MSLPRect bar;       // status bar along the bottom
    BOOL valid;
} MSLPScreen;

// Grid filling a flipped view: four columns by two rows, one bottom bar.
// The header and the grid are one block, centred between the top edge and the
// status bar. Each panel is the smaller of the width-fit and the height-fit,
// so spare height grows the panels until the width binds.
// placeCount is the number of status lines.
MSLPScreen MSLPScreenLayout(double screenWidth, double screenHeight, NSInteger placeCount);
// Largest src rectangle that fits in box, centered. box's origin is preserved.
MSLPRect MSLPAspectFit(double srcWidth, double srcHeight, MSLPRect box);
// One panel filling the area above the status bar.
MSLPRect MSLPSinglePanelFrame(double screenWidth, double screenHeight, NSInteger placeCount);

typedef struct {
    double red;
    double green;
    double blue;
} MSLPColour;

// Bureau four-day colour chart (IDG00074), sRGB. Land on the vector chart is the
// flat yellow; the other yellows are the GIF's terrain tints, unused by the PDF.
MSLPColour MSLPColourSea(void);        // #ebf1f7
MSLPColour MSLPColourLand(void);       // #f4eeaf
MSLPColour MSLPColourLandLight(void);  // #f9f7de
MSLPColour MSLPColourLandMid(void);    // #f2e997
MSLPColour MSLPColourLandDeep(void);   // #f1dc84
MSLPColour MSLPColourTitle(void);      // #036d9b
MSLPColour MSLPColourInk(void);        // #262322
MSLPColour MSLPColourPaper(void);      // white page around the panels

// Flat fills remapped from the black-and-white PDF. Strokes are not entries:
// isobars, fronts, coasts, hatching, and labels stay the ink the PDF drew.
// 0 land grey, 1 sea white, 2 title-bar black.
NSInteger MSLPFillMapCount(void);
BOOL MSLPFillMap(NSInteger index, MSLPColour *source, MSLPColour *colour);

// Uncompressed page content. Replaces land grey, paints sea rectangles and
// title-bar rectangles from the map, and leaves every stroke and title glyph.
NSData *MSLPRecolourStream(NSData *content);

// MSL pressure change from the history row nearest three hours before the latest.
// delta is latest minus earlier (positive rising), in hPa. Nil when no row is
// between 2 and 4 hours earlier. @{@"delta": NSNumber, @"hours": NSNumber}.
NSDictionary *PressureTendency(NSData *json);

// "Perth · 20° · SSE 17 (28) km/h · 1021.2 hPa · 0.0 mm"
NSString *ObservationStrip(NSString *name, NSDictionary *obs);
// Fullscreen status line. Trend is the three-hour MSL change, or "—" when unknown.
// "Perth · 20° · SSE 17 (28) km/h · 1021.2 hPa (+0.4)"
NSString *FullscreenStatusLine(NSString *name, NSDictionary *obs);
// "Issued 10:45 (5h)". Appends " · offline" when the chart is the cached copy.
NSString *IssuedCaption(NSDate *issued, NSTimeZone *tz, NSDate *now, BOOL offline);

BOOL GUIRequiresLaunchServicesRelaunch(NSString *runningBundleID, NSString *expectedBundleID);

// "4:53 pm" in tz. "—" when date is nil.
NSString *TimeOfDayText(NSDate *date, NSTimeZone *tz);

// All-stations latest-observations product (lat/lon on every station). Nil if unknown.
// Distinct from ObservationProductForState, which is the capital-city product.
NSString *StationCatalogueProduct(NSString *state);
// {"stations":[{"name","wmo","lat","lon"}]} captured from that product.
NSArray<NSDictionary *> *ParseStationList(NSData *json);
// Closest station. Identical coordinates break toward the place name, then away from
// marine and airport names, then alphabetical.
NSDictionary *NearestStation(NSArray<NSDictionary *> *stations, double latitude, double longitude, NSString *placeName);
// Closest station whose `msl` flag is true (it publishes press_msl). Nil if none do.
NSDictionary *NearestPressureStation(NSArray<NSDictionary *> *stations, double latitude, double longitude, NSString *placeName);
// Stations with coordinates, nearest first.
NSArray<NSDictionary *> *StationsByDistance(NSArray<NSDictionary *> *stations, double latitude, double longitude);
double HaversineKm(double lat1, double lon1, double lat2, double lon2);
// Copy MSL and tendency from pressureObs when obs has none. Sets pressureStation
// when that source's name differs. Temp, wind, and rain stay on obs.
NSDictionary *ObservationWithPressure(NSDictionary *obs, NSDictionary *pressureObs);
// Warning prose without product codes, bureau headers, or the standard gust disclaimer.
NSString *CleanWarningText(NSString *text);

NSString *GeohashEncode(double latitude, double longitude, NSInteger precision);
// Sunrise and sunset for the local civil date of instant. Nil at polar day/night.
NSDictionary *SunEvents(double latitude, double longitude, NSDate *instant, NSTimeZone *tz);
// The next `limit` hours, with sunrise/sunset inserted when they fall in that span.
NSArray<NSDictionary *> *HourlyStrip(NSArray<NSDictionary *> *hours, NSDate *sunrise, NSDate *sunset, NSInteger limit);

NSArray<NSDictionary *> *DefaultLocations(void);
// The place's IANA zone, else its state's zone, else Perth.
NSTimeZone *ZoneForPlace(NSDictionary *place);
NSString *ArchiveLocations(NSArray *locations);
NSArray<NSDictionary *> *UnarchiveLocations(NSString *json);
NSArray *LocationListByAdding(NSArray *locations, NSDictionary *place);
NSArray *LocationListByRemovingIndex(NSArray *locations, NSUInteger index);
NSArray *LocationListByMoving(NSArray *locations, NSUInteger fromIndex, NSUInteger toIndex);

NSString *ForecastPageURL(NSString *name, NSString *state);
NSString *SymbolForIconDescriptor(NSString *descriptor, BOOL night);
// YES when any group contains a warning.
BOOL LocationWarningsActive(NSArray *warningGroups);

// First pluggable panel source: the Bureau four-day MSLP GIF.
extern NSString * const PanelSourceFourDayMSLP;

// Shown when D has no earlier chart for the focused valid time.
extern NSString * const ChartNoEarlierIssue;

// IDY00050 text "Valid: 1800 UTC 25 Sep. 2026" as an absolute instant. Nil if absent.
NSDate *AnalysisValidTime(NSData *pdf);
// "04am AEST 26 Sep" from the chart's local validity line. Nil if absent.
NSString *AnalysisLocalValidText(NSData *pdf);
// Eight IDG00073 panel times, oldest first. Times are Eastern Standard (UTC+10).
// Parsed prognosis times. When a document is loaded and nothing parses, undated
// is YES and the result is empty: callers label the panels undated.
extern NSString * const UndatedPanelLabel;
NSArray<NSDate *> *BureauPanelTimes(NSArray *parsed, BOOL documentLoaded, BOOL *undated);
NSArray<NSDate *> *PrognosisValidTimes(NSData *pdf);
// One zlib stream inflated whole, or nil when it is empty, malformed, truncated
// or would expand past 64 MB. A cached chart must not expand without a ceiling.
NSData *PDFInflate(NSData *raw);
// Analysis first, then the prognosis times in order.
NSArray<NSDate *> *ChartSequenceTimes(NSDate *analysis, NSArray<NSDate *> *prognosis);

typedef struct {
    NSInteger left;
    NSInteger right;
    BOOL valid;
} ChartPair;

// Opens on the analysis (left) and the first later chart still ahead of now (right).
ChartPair OpeningChartPair(NSArray<NSDate *> *times, NSDate *now);
// Steps onto the neighbouring consecutive pair. Stays put at either end.
ChartPair StepChartPair(ChartPair pair, NSInteger delta, NSInteger count);

// Index into previousTimes of the same valid instant, or -1.
NSInteger PreviousIssueIndex(NSArray<NSDate *> *previousTimes, NSDate *valid);
// YES when incoming is a different issue and the stored PDF should be kept.
BOOL IssueShouldArchive(NSDate *stored, NSDate *incoming);

// "Now · 04am AEST 26 Sep". localText wins when the chart printed one.
NSString *NowTitle(NSString *localText, NSDate *valid);
// "10am EST Sat" in the chart's Eastern Standard zone.
NSString *ForecastTitle(NSDate *valid);
// "Sat" in the chart zone.
NSString *ChartDayLabel(NSDate *time);
// "Issue 25 Sep 02:45 vs previous 24 Sep 14:45".
NSString *IssueCompareTitle(NSDate *issue, NSDate *previous, NSTimeZone *tz);

typedef struct {
    MSLPRect cells[9]; // time order, view space, origin at the top left
    MSLPRect bar;
    BOOL valid;
} SequenceScreen;

// Nine charts, three columns by three rows, above the status bar.
SequenceScreen SequenceScreenLayout(double screenWidth, double screenHeight, NSInteger placeCount);
// One chart of the given source aspect, above the status bar.
MSLPRect SequenceSingleFrame(double screenWidth, double screenHeight, NSInteger placeCount,
    double srcWidth, double srcHeight);

// Lambert conformal conic fitted to the analysis graticule. Projects to PDF user space.
typedef struct {
    double poleX, poleY; // millimetres in the chart form
    double n, k, lon0;
    double a, d, e, f;   // page scale: x' = a*x + e, y' = d*y + f
    BOOL valid;
} AnalysisGeo;

AnalysisGeo AnalysisGeoreference(NSData *pdf);
BOOL AnalysisProject(AnalysisGeo geo, double latitude, double longitude, double *x, double *y);

// "Now", or "+12 h" rounded from origin. "Now" when valid is nil-origin or not later.
// Offset form kept for tests. The popover does not display it.
NSString *PopoverRelativeLabel(NSDate *valid, NSDate *origin);
// "Sat 8 pm AWST" in tz. Empty when valid is nil.
NSString *PopoverClockLabel(NSDate *valid, NSTimeZone *tz);
// "Now", or "+12h Sat 8pm" with no zone abbreviation.
NSString *PopoverTickLabel(NSDate *valid, NSDate *origin, NSTimeZone *tz);

// Day-part label in the owner's zone (Australia/Perth when tz is nil).
// Cut-offs, local clock: morning 5:00, afternoon 12:00, evening 17:00, night 21:00.
// A clock before 5:00 belongs to the previous day's night.
// "Now" when valid is within 90 minutes of now. Clock is "8 pm". Offset is "+18h"
// for a tooltip only; the phrase never contains it.
NSString *SituationPhrase(NSDate *valid, NSDate *now, NSTimeZone *tz);
NSString *SituationClock(NSDate *valid, NSTimeZone *tz);
NSString *SituationOffset(NSDate *valid, NSDate *now);
// "Tonight · 8 pm". Empty pieces are dropped.
NSString *SituationTitle(NSDate *valid, NSDate *now, NSTimeZone *tz);
// YYYYMMDD of the day-part's anchor day, for timeline separators. 0 when valid is nil.
NSInteger SituationAnchorDay(NSDate *valid, NSTimeZone *tz);
// "Forecast updated 6 h ago", counted from the ECMWF run. Empty when run or now is nil.
NSString *SituationFreshness(NSDate *run, NSDate *now);
// Colour-key name. 1 is "850 hPa (~5,000 ft) °C", 2 is "Surface °C". Empty when off.
NSString *ChartTemperatureLegend(int temperature);
// One line. Items are @{@"place", @"title"}. Same titles share a place list.
// "⚠︎ Marine wind warning — Perth, Sydney"
NSString *PopoverWarningSummary(NSArray<NSDictionary *> *items);

// Prognosis map interior for panel 0..7: the title bar and the grey frame are gone.
// Zero when the page or the index cannot hold a map.
MSLPRect MSLPPrognosisMapCrop(double pageWidth, double pageHeight, int panel);
// width / height of that map. Both popover panels use it.
double MSLPPopoverMapAspect(void);
// Popover crop at the prognosis map aspect. Mainland Australia is fitted to the
// width fraction and position it occupies on an IDG00073 panel. Zero when geo is invalid.
MSLPRect AnalysisPopoverCrop(AnalysisGeo geo, double pageWidth, double pageHeight);

// Page-point isobar stroke that matches the prognosis once the page is cropped to cropWidth.
// Zero when cropWidth is not a map.
double AnalysisIsobarStroke(double cropWidth);

// IDY00050 device RGB. Sea, land, coasts, and black ink take the Bureau palette.
// Front blue (0 0 1) and warm-front red stay as drawn.
NSData *AnalysisRecolourStream(NSData *content);
// Recolour, drop the graticule and state borders, thicken isobars to AnalysisIsobarStroke
// when cropWidth is positive, and draw isobar and H/L labels in Helvetica-Bold.
NSData *AnalysisPopoverStream(NSData *content, double cropWidth);

// Local store written by isobar-data. The app reads these paths and does not fetch.
// ECMWF grids: <root>/ecmwf/<run>/manifest.json and the float32 files it names.
// Bureau prognosis: <root>/products/charts/IDG00073.pdf and previous/IDG00073.pdf.
// Observations: <root>/products/obs/<wmo>.json (Bureau latest-observation JSON from the FTP tarball).
// Warnings: <root>/products/warnings/*.xml. Point forecasts: <root>/products/points/<geohash>.json.
// Kite spots: <root>/products/kite.json.
NSString *StoreStatusRelative(void);
NSString *StoreECMWFLatestRelative(void);
NSString *StoreChartRelative(void);
NSString *StoreChartPreviousRelative(void);
NSString *StoreObservationRelative(NSString *wmo);
NSString *StoreWarningsDirectoryRelative(void);
NSString *StorePointRelative(NSString *geohash);
NSString *StoreKiteRelative(void);

// Manifest for one ECMWF run. Nil when the grid is missing, not float32, or has no times.
// run, generated: NSDate. times: NSArray<NSDate>. nx, ny, west, east, north, south, step: NSNumber.
// variables: the manifest dictionary. attribution: NSString.
NSDictionary *StoreManifestFromJSON(NSData *json);
// Relative run directory from ecmwf/latest.json, or nil. Rejects absolute paths and "..".
NSString *StoreLatestRunPath(NSData *json);
// Preformatted source label. The daemon writes "ecmwf-open-data"; legacy
// fixtures use "ecmwf-ifs". No other product's status is substituted.
NSString *StoreStatusLabel(NSData *json);
// ECMWF run instant from that same source. Nil when the file has no run.
// This is the forecast cycle, not the file's "updated" time.
NSDate *StoreStatusRun(NSData *json);
// YES only when the national chart source explicitly reports ok. Other sources
// (observations, points, ensembles) cannot establish the chart's health.
BOOL StoreStatusOK(NSData *json);
// A run older than this has room for the next IFS cycle to have been stored (6 h cycle, ~7 h delay).
NSTimeInterval StoreStaleAge(void);
// Stale when statusOK is NO, or the run is missing, or now is more than StoreStaleAge after the run.
BOOL StoreRunIsStale(NSDate *run, NSDate *now, BOOL statusOK);
// Age of the successfully loaded chart, never a newer run mentioned by status.
// Adds "stale" for old/failed/unknown data, or "Chart unavailable" without a chart.
NSString *StoreForecastFreshness(NSDate *loadedRun, NSDate *now, BOOL statusOK);
// Same sentence as status.json when the file has no label. Hours are whole hours since the run, UTC cycle.
NSString *StoreRunStatusLine(NSDate *run, NSDate *now);
// "18Z vs previous 06Z".
NSString *StoreRunCompareTitle(NSDate *run, NSDate *previous);

// Indices into `times` for one run. The anchor is the latest time at or before now (a model step of slack).
// Prefer the anchor and every later time on a 12-hour ladder through +168 h. When that ladder is not what
// the store holds, use the frames present from the anchor through +168 h.
NSArray<NSNumber *> *StoreFrameIndices(NSArray<NSDate *> *times, NSDate *now);
// Lexicographic previous run id (YYYYMMDDTHHZ), or nil.
NSString *StorePreviousRunID(NSArray<NSString *> *runIDs, NSString *current);

// One Bureau warning XML file (legacy fixture or AMOC product). Same keys as ParseWarnings,
// plus state/phase/issue/expiry metadata. Cancelled products are dropped; cancelled hazards
// inside an otherwise active product do not hide the active summary.
NSArray<NSDictionary *> *ParseWarningXML(NSData *xml);
// @{lat, lon, mm} from a Bureau observation JSON row, or nil when rain or the coordinate is missing.
NSDictionary *StoreRainObservation(NSData *json);
// Model point file: {"hourly":[{"time","temp","wind_direction","wind_speed_kmh"}]}.
// Same keys as ParseHourlyForecasts.
NSArray<NSDictionary *> *StorePointHours(NSData *json, NSDate *now, NSInteger limit);
// ISO 8601 instant. Naive "YYYY-MM-DDTHH:MM" and "YYYY-MM-DDTHH:MM:SS" are GMT.
// A trailing Z or a numeric offset is honoured. Nil when the text is not a time.
NSDate *WeatherInstant(NSString *text);
// Up to `limit` local days from a surface-point product, from `now`'s local day.
// `placeZone` is used only when the product has no timezone. Missing numbers are
// NSNull. Keys: date, weekday, min, max, rainMm, rainHours, weatherCode, gust, windDir.
NSArray<NSDictionary *> *StorePointDays(NSData *json, NSDate *now, NSInteger limit, NSTimeZone *placeZone);
// WMO weather code. `day` selects the daytime SF Symbol. Nil when the code is unknown.
NSString *WeatherCodeSymbol(NSInteger code, BOOL day);
NSString *WeatherCodeLabel(NSInteger code);

// One fitted size, placed in every cell with the same inset, so a column shares x and a gutter.
void SequenceUniformFrames(SequenceScreen screen, double srcWidth, double srcHeight, MSLPRect *frames);
// Observation line inside the status bar. x is inset from the bar's left edge.
MSLPRect StatusLineFrame(MSLPRect bar, NSInteger lineIndex);

// Glance cards. Knots are the Bureau kt field when it is present, otherwise km/h ÷ 1.852.
// The arrow points where the wind is blowing to. Compass labels stay the "from" direction.
double KnotsFromKmh(double kmh);
// Height of one glance card, and of the fullscreen bar that holds one row of them.
double GlanceCardHeight(void);
// Meteorological compass ("SSE") to degrees the wind comes from. NO for calm or blank.
BOOL WindFromDegrees(NSString *compass, double *degrees);
double WindToDegrees(double fromDegrees);
// "SSE 9 kt, gusts 15". Speeds are knots. Calm or missing wind is "Calm" or "—".
NSString *WindGlanceLabel(NSString *compass, double speedKt, double gustKt, BOOL hasWind, BOOL hasGust);
// "1021 hPa".
NSString *PressureGlanceLabel(double hPa);
// "rising 0.8/3h", "falling 1.4/3h", or "steady". Unknown is "—".
NSString *PressureTrendLabel(double deltaHPa, double hours, BOOL known);
// +1 rising, −1 falling, 0 steady or unknown.
int PressureTrendSign(double deltaHPa, BOOL known);

// Arrow in a unit square, y down, north up. Head is where the wind is going.
// Gust, when faster, is a point beyond the head. Weight is points at a 44 pt box.
typedef struct {
    double tailX, tailY;
    double headX, headY;
    double gustX, gustY;
    double weight;
    BOOL hasGust;
    BOOL calm;
} WindArrow;
WindArrow WindArrowLayout(double toDegrees, double speedKt, double gustKt, BOOL hasWind, BOOL hasGust);

// shoreNormalDeg points offshore (Cottesloe 270 faces west, out to sea).
// "offshore", "onshore", or "cross". Empty when there is no wind.
NSString *WindShoreName(double toDegrees, double shoreNormalDeg, BOOL hasWind);
BOOL WindIsOffshore(double toDegrees, double shoreNormalDeg, BOOL hasWind);
// Sustained speed inside [minKt, maxKt] and not offshore. No shore skips the offshore test.
BOOL HourIsRideable(double speedKt, BOOL hasWind, double toDegrees, double minKt, double maxKt,
    double shoreNormalDeg, BOOL hasShore);

// Oldest first. Numbers missing from a row are NSNull. windKt prefers wind_spd_kt.
NSArray<NSDictionary *> *ObservationHistory(NSData *json);
// Copy pressMsl from the pressure series when a primary row has none, within 45 minutes.
NSArray<NSDictionary *> *ObservationHistoryWithPressure(NSArray<NSDictionary *> *primary, NSArray<NSDictionary *> *pressure);
// Every model hour. Same wind and pressure keys as ObservationHistory, plus temp.
NSArray<NSDictionary *> *StorePointSeries(NSData *json);

// Pressure: observed hours in [-24, 0], forecast in (0, 24], min and max across both.
// Wind: speed and gust in [-12, 0] and (0, 12], direction ticks every 3 h.
// @{observed, forecast, min, max} and @{observed, forecast, ticks}.
NSDictionary *PressureSpark(NSArray<NSDictionary *> *history, NSArray<NSDictionary *> *forecast, NSDate *now);
NSDictionary *WindSpark(NSArray<NSDictionary *> *history, NSArray<NSDictionary *> *forecast, NSDate *now);
// One flag per forecast hour in (0, 24]. @{h, on}.
NSArray<NSDictionary *> *RideableWindow(NSArray<NSDictionary *> *forecast, NSDate *now,
    double minKt, double maxKt, double shoreNormalDeg, BOOL hasShore);

// products/kite.json. Spots carry a place dictionary plus shoreNormal. Missing thresholds are 15 and 30.
NSDictionary *StoreKiteFile(NSData *json);
// Locations, then kite spots whose geohash is not already shown, when include is YES.
NSArray<NSDictionary *> *GlancePlaces(NSArray<NSDictionary *> *locations, NSArray<NSDictionary *> *spots, BOOL include);
// One tag per title. Title is sentence case. Text is the warning body.
NSArray<NSDictionary *> *WarningTags(NSArray<NSDictionary *> *warnings);
// Compact Bureau warning badge: text, severity ("advisory" or "severe"),
// SF Symbol glyph, and a newline-separated title tooltip. Invalid records are ignored.
NSDictionary *WarningBadgeModel(NSArray<NSDictionary *> *warnings);

// Strings and traces for one card. shoreNormal nil means not a kite spot.
// obs is a ParseLatestObservation dictionary. history and forecast may be empty.
// tz is the owner's zone for the spark axis. Nil means Australia/Perth.
NSDictionary *GlanceCardModel(NSString *name, NSDictionary *obs, NSArray<NSDictionary *> *history,
    NSArray<NSDictionary *> *forecast, NSDate *now, NSNumber *shoreNormal, double minKt, double maxKt,
    NSArray<NSDictionary *> *warnings, NSTimeZone *tz);

// One line for the primary place over the next three days, or "Settled…" when the
// series is quiet, or "" when there is nothing to say. Built only from the rows.
// A wind line with no front names the place first: "Perth this afternoon: WSW 22 kt, gusts 31".
// Rows use StorePointSeries keys, plus rainMm (mm in that hour) and t850 (°C).
NSString *SituationHeadline(NSString *place, NSArray<NSDictionary *> *series, NSDate *now, NSTimeZone *tz);

// "16° SE 15". Temperature, the direction the wind comes from, and knots.
NSString *MenuBarReading(NSDictionary *obs);

// "west", "southwest", … for a shore-normal in degrees (the offshore direction).
NSString *ShoreFacingName(double degrees);

// Perth Airport and Sydney Airport. Nil for an unknown code.
NSArray<NSDictionary *> *KnownAerodromes(void);
NSDictionary *AerodromeForCode(NSString *code);
// Primary capital aerodrome for a state abbreviation. Nil when the state is unknown.
// YPPH and YSSY include runways. Other capitals have a name and position, no runways.
NSString *PrimaryAerodromeCode(NSString *state);
NSDictionary *AerodromeForState(NSString *state);

// @{line, detail}. Spots are kite places plus hours (a point series).
// The line names the best window in the next three days.
NSDictionary *KitePlan(NSArray<NSDictionary *> *spots, NSDate *now, NSTimeZone *tz, double minKt, double maxKt);
// @{line, detail}. hours is the primary place's point series. The line is the next
// morning or afternoon on the favoured runway of aerodrome.
NSDictionary *FlyPlan(NSArray<NSDictionary *> *hours, NSDate *now, NSTimeZone *tz, NSDictionary *aerodrome);
