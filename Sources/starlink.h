#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Starlink lens model: orbits, the dish's local status, and which satellite
// the dish is using. Pure Foundation; the network lives in StarlinkLink.
//
// Orbits are CelesTrak two-line elements propagated with near-earth SGP4
// (Vallado 2006, WGS-72, improved mode). Every Starlink satellite is near
// earth, so deep-space terms are left out and a deep-space element set is
// rejected rather than propagated wrongly.

typedef struct {
    double epochJD;                 // UTC Julian date of the element epoch
    double bstar, inclo, nodeo, ecco, argpo, mo, noKozai, noUnkozai;
    int isimp;
    double aycof, con41, cc1, cc4, cc5, d2, d3, d4, delmo, eta, argpdot, omgcof, sinmao,
        t2cof, t3cof, t4cof, t5cof, x1mth2, x7thm1, mdot, nodedot, xlcof, xmcof, nodecf;
} StarlinkOrbit;

// NO for a malformed line pair, a bad checksum, or a deep-space orbit.
BOOL StarlinkOrbitFromTLE(NSString *line1, NSString *line2, StarlinkOrbit *orbit);
// TEME position (km) and velocity (km/s) `minutes` after the epoch. NO once
// the orbit has decayed or the elements no longer converge.
BOOL StarlinkPropagate(const StarlinkOrbit *orbit, double minutes, double r[_Nonnull 3], double v[_Nonnull 3]);

double StarlinkJulianDate(NSDate *date);
// Greenwich mean sidereal time, radians (IAU-82, as SGP4 uses).
double StarlinkGMST(double julianDate);

typedef struct {
    double elevation, azimuth, rangeKm;     // from the observer; azimuth from true north
    double latitude, longitude, altitudeKm; // sub-satellite point
} StarlinkLook;

// Look angles from a WGS-84 observer (degrees, km). Polar motion is ignored:
// metres at 550 km, far below the dish map's 1.3° pixel.
BOOL StarlinkLookAt(const StarlinkOrbit *orbit, double julianDate, double latitude, double longitude,
    double heightKm, StarlinkLook *look);

// A CelesTrak TLE file: name line, line 1, line 2. Bad triples are skipped.
@interface StarlinkCatalog : NSObject
@property (nonatomic, readonly) NSUInteger count;
@property (nonatomic, readonly, copy) NSArray<NSString *> *names;
@property (nonatomic, readonly, nullable) NSDate *newestEpoch;
+ (nullable instancetype)catalogWithText:(NSString *)text;
- (const StarlinkOrbit *)orbitAtIndex:(NSUInteger)index;
- (NSUInteger)indexOfName:(NSString *)name;
@end

// Every satellite at one instant, as seen from the observer. Points outside
// [south, north] × [west, east] (degrees, west may exceed east across the
// antimeridian) are dropped unless the observer can see them above
// `keepAboveDeg`.
typedef struct {
    float latitude, longitude, elevation, azimuth, altitudeKm, rangeKm;
    uint32_t index;
} StarlinkSkyPoint;
NSData *StarlinkSkyAt(StarlinkCatalog *catalog, NSDate *date, double latitude, double longitude,
    double south, double north, double west, double east, double keepAboveDeg);

// Short label: "STARLINK-35964" → "35964"; other names unchanged.
NSString *StarlinkShortName(NSString *name);

// ---- The dish -------------------------------------------------------------
// The dish answers gRPC-web at http://192.168.100.1:9201 with the method
// SpaceX.API.Device.Device/Handle. Messages are encoded by hand: the request
// is a Request whose one field is an empty sub-message.
extern const int StarlinkRequestStatus;          // get_status
extern const int StarlinkRequestObstructionMap;  // dish_get_obstruction_map
NSData *StarlinkGRPCWebRequest(int field);
// The first data frame's payload; nil for a trailer-only or malformed body.
NSData * _Nullable StarlinkGRPCWebPayload(NSData *body);

// DishGetStatusResponse as {azimuth, elevation, tilt (deg), quaternion
// [w,x,y,z] (NED to dish), pingMs, downBps, upBps, dropRate, hardware,
// software, uptimeS}. Absent fields are absent keys. Nil when not a status.
NSDictionary * _Nullable StarlinkDecodeStatus(NSData *payload);

// DishGetObstructionMapResponse: {rows, cols, snr (NSData of float),
// maxThetaDeg, frame}. snr < 0 is sky the dish has not used.
NSDictionary * _Nullable StarlinkDecodeObstructionMap(NSData *payload);

// A map pixel to sky elevation/azimuth, degrees. The map is the dish frame
// (FRAME_UT): a polar plot about the antenna normal, maxThetaDeg at the rim,
// rotated to north-east-down by the status quaternion. Fitted against
// matched satellite tracks on a Starlink Mini, 14 Oct 2026.
BOOL StarlinkPixelToSky(double x, double y, NSInteger rows, double maxThetaDeg,
    const double quaternion[_Nonnull 4], double *elevation, double *azimuth);

double StarlinkAngularSeparation(double el1, double az1, double el2, double az2);

// ---- Which satellite ------------------------------------------------------
// The dish is rescheduled every 15 s, at :12, :27, :42 and :57 past the minute.
NSTimeInterval StarlinkSlotStart(NSTimeInterval unixTime);

// Sky pixels that changed between two maps, as {x, y, el, az, from, to}:
// `from`/`to` bound when the dish lit them (unix seconds).
NSArray<NSDictionary *> *StarlinkChangedPixels(NSDictionary *previous, NSDictionary *current,
    const double quaternion[_Nonnull 4], NSTimeInterval from, NSTimeInterval to);

// The satellite whose path best fits the longest coherent run of ≥3 lit
// pixels: {name, index, errorDeg, runnerUpDeg, slot, pixels, confident}.
// `confident` only when the fit is ≤3.5° and the next satellite is worse by
// at least that error (and 1.5°); anything else is a guess and is not shown
// as the link. Direct-to-cell satellites are never candidates.
NSDictionary * _Nullable StarlinkIdentify(StarlinkCatalog *catalog, NSArray<NSDictionary *> *pixels,
    double latitude, double longitude);

NS_ASSUME_NONNULL_END

NS_ASSUME_NONNULL_BEGIN

// ---- The live link ---------------------------------------------------------
// Polls the dish while running: the obstruction map about once a second and
// the status every tenth poll. Loads the CelesTrak catalogue from the cache,
// refreshing it at most every 12 h. The dish is reached over a plain socket
// (HTTP/1.1, Connection: close) so App Transport Security does not apply to
// the IP-literal, LAN-only address. Nothing is ever written to the dish.
@interface StarlinkLink : NSObject
@property (nonatomic, copy, nullable) void (^onUpdate)(void);   // main queue
@property (nonatomic, readonly) BOOL running;
@property (nonatomic) double latitude, longitude;               // home
@property (nonatomic, readonly, nullable) StarlinkCatalog *catalog;
@property (nonatomic, readonly, copy, nullable) NSDictionary *status;
@property (nonatomic, readonly, copy, nullable) NSDictionary *obstructionMap;
// The newest confident identification: {name, index, slot, errorDeg}.
@property (nonatomic, readonly, copy, nullable) NSDictionary *serving;
// Nil while the dish answers; a short reason otherwise.
@property (nonatomic, readonly, copy, nullable) NSString *dishError;
@property (nonatomic, readonly, copy, nullable) NSString *catalogError;
// A nil catalogURL never downloads: the cache is the catalogue. An empty host
// never opens a socket and reports "No dish" (tests).
- (instancetype)initWithDishHost:(NSString *)host port:(uint16_t)port catalogURL:(nullable NSURL *)catalogURL
                        cacheURL:(NSURL *)cacheURL;
// 192.168.100.1:9201, CelesTrak's Starlink group, ~/Library/Caches/Isobar.
+ (instancetype)defaultLink;
- (void)start;
- (void)stop;
@end

// One HTTP/1.1 POST over a socket; the decoded body (chunked or not), or nil.
NSData * _Nullable StarlinkHTTPPost(NSString *host, uint16_t port, NSString *path, NSDictionary<NSString *, NSString *> *headers,
    NSData *body, NSTimeInterval timeout, NSString * _Nullable * _Nullable error);
// Splits a raw HTTP response; nil unless the status is 200.
NSData * _Nullable StarlinkHTTPBody(NSData *response);

NS_ASSUME_NONNULL_END
