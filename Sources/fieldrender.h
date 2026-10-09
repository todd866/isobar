// GPU forecast fields. Standalone spike: nothing in the app calls this yet.
// Colour comes from one field, interpolated in value between time steps
// (UX-002: never a crossfade of two finished contour images).
// Isobars are 4 hPa polylines. Labels and H/L marks are drawn with them.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Metal/Metal.h>

// Row 0 is the northern edge. Index = row * nLon + column.
// wrapsLongitude is true when nLon * step == 360, so the neighbour east of
// the last column is column 0. The Australian crop (95°E–170°E, 0°–50°S,
// 0.25°, 301×201) does not wrap. A global 0.25° grid is 1440×721 and does.
typedef struct {
    double west;
    double north;
    double step;
    int nLon;
    int nLat;
    BOOL wrapsLongitude;
} IsobarGeoGrid;

// Degrees. zoom 1 makes 180° of latitude, and 360° of longitude at the
// equator, fit the viewport. globe 0 is the tangent plane, 1 is the sphere.
// Values between morph in 3D. viewportW/H are pixels.
//
// The flat point lies on the plane tangent to the unit sphere at the camera
// centre: east = Δlon(rad) * cos(centreLat), north = Δlat(rad), wrapped
// about the centre. The sphere point is the unit vector. Those two positions
// are lerped by `globe`, then projected orthographically down the centre
// normal. radius = pxPerDeg * 180/π, so a degree at the centre has the same
// pixel size at every globe value.
//
// Depth is distance along that view axis (larger P.z is closer). A point is
// visible when its P.z is the greatest among geographic points that share its
// screen position, within 1e-3. Ties are visible. There is no globe cutoff.
// Project still writes a finite position for a hidden but valid point.
typedef struct {
    double centreLat;
    double centreLon;
    double zoom;
    double globe;
    double viewportW;
    double viewportH;
} IsobarCamera;

// Screen x right, y down.
BOOL IsobarCameraProject(IsobarCamera camera, double latitude, double longitude,
    double *x, double *y);
// Closed form at globe 0 and globe 1. The morph uses the same front-most
// root as Project. The pick API does not use this; it reads the lat/lon
// attachment.
BOOL IsobarCameraUnproject(IsobarCamera camera, double x, double y,
    double *latitude, double *longitude);
// Clamps a camera the app can apply during drag and pinch. Render does not
// call this, so a test can still pass an unclamped camera.
//
// zoom stays in [1, 64]. centreLon is left as given (repaired only when
// non-finite). globe is folded into [0, 1].
//
// Flat (globe 0): centreLat and, when the frame is taller than 2:1, zoom
// are pulled in until both poles lie at or outside the viewport edge. A
// wide zoom-1 frame otherwise shows an ocean band past 90°S. Zoomed in,
// a pole may sit far outside the edge; it is not left inside the frame
// with empty plate beyond it.
// Globe (globe 1): centreLat may be anywhere in [-90, 90], so the sphere
// can turn until a pole is in the middle of the view. Only zoom is limited.
// Between 0 and 1 the flat latitude inset and the extra zoom floor ease
// off linearly with globe.
IsobarCamera IsobarCameraClamp(IsobarCamera camera);

typedef NS_ENUM(NSInteger, IsobarFieldKind) {
    IsobarFieldPressure,    // hPa
    IsobarFieldTemperature, // °C
    IsobarFieldWindSpeed,   // knots
    IsobarFieldRain         // mm
};

typedef struct {
    double r, g, b;
} IsobarRGB;

// Field ramps live in OwnFieldRamp. Temperature is a low-saturation two-hue
// overlay (blue-grey to sand and terracotta) at no more than 35%, rain one
// blue, wind one slate. A non-finite value is the missing colour, never the
// colour of zero. Overlay alpha is 0 below the rain cutoff. Over sea the
// overlay alpha is multiplied by IsobarFieldSeaAlphaScale.
IsobarRGB IsobarFieldColour(IsobarFieldKind kind, double value);
double IsobarFieldOverlayAlpha(IsobarFieldKind kind, double value);
double IsobarFieldSeaAlphaScale(IsobarFieldKind kind);
IsobarRGB IsobarMissingColour(void);
IsobarRGB IsobarOceanColour(void);
// Viewport pixels the earth does not cover. Distinct from the ocean clear
// colour and from the missing-data colour inside the grid.
IsobarRGB IsobarNoCoverageColour(void);
// Calm hairline drawn on the boundary between that plate and the grid.
// Isobars and labels stop at the grid; they are not drawn on the plate.
IsobarRGB IsobarCoverageEdgeColour(void);

// Kept so existing callers still compile. Eviction is a byte budget
// (residentByteBudget), not this slot count. residentBytes sums what each
// slot keeps: pressure stores an R32Float texture and a CPU copy (contours
// read it); rain stores the same pair so a pick reads the raw accumulation
// while the texture is the smoothed display; temperature and wind keep only
// the texture and are sampled from it.
extern const NSUInteger kIsobarFieldResidentCap;

// Gaussian smooth of an MSLP grid, in degrees. Same kernel uploadStep applies
// when pressureSmoothDegrees > 0. The caller owns `values` and may run this
// off the render thread, then upload with the renderer's sigma set to 0.
void IsobarSmoothPressure(float *values, IsobarGeoGrid grid, double sigmaDegrees);

// Label identity across frames. maxLabelStep is the largest screen-pixel
// move of a label that stayed, measured after the first frame. A sample
// walks at most 3 px times the pixel scale toward its isobar; it does not
// snap the rest of the way.
// labelSetChanges counts later frames on which that set changed.
// maxAnnotationAlphaStep is the largest opacity change of a label or an
// H/L mark after the first frame. A still frame leaves all three at zero.
// minimumActiveAlpha is the lowest opacity among labels still alive, or 0
// when none are. A label is drawn once that opacity reaches one half.
@interface IsobarFieldMotion : NSObject
@property (nonatomic, readonly) double maxLabelStep;
@property (nonatomic, readonly) double maxAnnotationAlphaStep;
@property (nonatomic, readonly) double minimumActiveAlpha;
@property (nonatomic, readonly) NSInteger labelSetChanges;
@end

// Test clock for label fades, in milliseconds. NowMs returns this value
// while it is >= 0, and fades follow its deltas, capped at 87 ms so one
// stall stays under the 0.35 alpha step. A negative value restores the
// process clock for NowMs. Fades then advance one 60 Hz quantum per
// rendered forecast sample: the wall gap since the previous sample is not
// the clock, so a slow frame cannot push a label in or out of the set.
void IsobarFieldRenderTestingSetNow(double milliseconds);

@interface IsobarFieldRenderer : NSObject
// nil device selects the system default. Returns nil when Metal is absent
// or the field library fails to compile.
- (instancetype)initWithDevice:(id<MTLDevice>)device;
- (void)setGrid:(IsobarGeoGrid)grid;
// Gaussian sigma for MSLP, in degrees. Default 0.3125, which is own-chart's
// 1.25-cell smooth on a 0.25° grid (tools/own-chart.m). Wrapping grids wrap
// in longitude. Other kinds are stored as uploaded. Applied at upload;
// zero leaves pressure unchanged. The linear time blend of smoothed steps
// matches smoothing the blend.
@property (nonatomic) double pressureSmoothDegrees;
// `values` is nLon * nLat floats, row 0 at the north edge. Non-finite
// samples stay missing; they are not stored as zero.
- (BOOL)uploadStep:(NSInteger)step
              kind:(IsobarFieldKind)kind
            values:(const float *)values
             error:(NSError **)error;
@property (nonatomic, readonly) NSUInteger residentBytes;
// Milliseconds spent building isobar polylines on the last render, and
// milliseconds of GPU work in that frame's command buffer (draw and readback
// together). A contour-cache hit reports 0. The cache key is the fractional
// step, the decimated window and the stride, so panning inside a full-grid
// contour does not rebuild it.
@property (nonatomic, readonly) double lastContourMilliseconds;
@property (nonatomic, readonly) double lastGpuMilliseconds;
// Milliseconds this frame blocked for a geometry-ring slot. A display link
// hides that wait in the vsync gap; a tight test loop does not.
@property (nonatomic, readonly) double lastSyncWaitMilliseconds;
// Milliseconds placing labels and H/L marks on the last render. The glyph
// atlas is not included; it is built when the scale changes.
@property (nonatomic, readonly) double lastLabelMilliseconds;
// Milliseconds projecting the new lines, and milliseconds expanding them into
// stroke vertices. Both sit outside the contour and label timers.
@property (nonatomic, readonly) double lastProjectMilliseconds;
@property (nonatomic, readonly) double lastGeometryMilliseconds;
// Lat/lon polylines from the last render that asked for isobars.
@property (nonatomic, readonly) NSInteger contourLineCount;
- (NSInteger)contourVertexCountForLine:(NSInteger)line;
- (double)contourLevelForLine:(NSInteger)line;
- (BOOL)contourLineIsClosed:(NSInteger)line;
- (BOOL)contourVertexForLine:(NSInteger)line
                        index:(NSInteger)index
                     latitude:(double *)latitude
                    longitude:(double *)longitude;
// Offscreen RGBA image. The caller releases it. `fractionalStep` blends the
// two neighbouring steps' values. Isobars are 4 hPa polylines of smoothed
// MSLP, width from OwnIsobarWidth, drawn over whichever fill is active.
// With isobars on, each line carries an upright Helvetica-Bold pressure
// label (a gap cut in the stroke) and the frame marks H/L centres.
// The bundled coastline (Resources/ownchart-coast.bin, or ISOBAR_COAST) is
// the Australian Natural Earth crop only — not a world shoreline. It is a
// 0.72 pt line in the coast token over every field (near-black on the light
// plate, near-white on the dark), simplified to the screen, with no halo.
// Centres use the chart's land-mixed search when that crop covers the
// loaded grid, and a rough cell is not a centre.
// A world shoreline is not invented here, so a grid the crop does not cover
// keeps centres on the pressure field alone.
// Pixel scale of the glyph atlas, strokes, antialiasing and caps. 1 matches
// a point-sized viewport; 2 and 3 are Retina. Values outside 1...3 are
// clamped. The atlas is built once per scale. pixelsPerPoint is the same
// value.
@property (nonatomic) double contentScale;
@property (nonatomic) double pixelsPerPoint;
// YES draws the inverted plate (light ink on dark land and sea).
@property (nonatomic) BOOL chartDark;
// Bytes of resident field slots. Default 64 MiB. A slot larger than the
// budget is kept alone. Pressure counts the texture and the CPU copy;
// other kinds count the texture only.
@property (nonatomic) NSUInteger residentByteBudget;
// Contour rebuilds run on a serial queue. The worker allocates its own
// lines, arena and centres; its only shared effect is a block on the main
// queue that publishes that immutable set. Call the renderer from the main
// thread when this is NO. Tests and field-preview set YES so the lines are
// ready before the render returns. Default NO.
//
// A pressure upload bumps the content generation. The previous isobar set
// is drawn only while its generation is still current, or for one frame
// while a rebuild of the new generation is in flight. Geometry is stamped
// with the generation that set was built from. The frame after that draws
// the new fill with no old lines. setGrid (a new layout) drops the lines
// immediately, so a new run is never drawn under the previous run's isobars.
@property (nonatomic) BOOL synchronousContours;
// YES when a frame's line geometry hit the hard vertex cap.
@property (nonatomic, readonly) BOOL geometryTruncated;
// Times a line or label ring allocated a new Metal buffer. Steady playback
// grows a slot once, with headroom, and then stays put.
@property (nonatomic, readonly) NSUInteger geometryAllocations;
// Stride of the contour grid used for the published lines. 0 before any build.
@property (nonatomic, readonly) NSInteger contourStride;
// Times the main thread projected contour vertices. A set projected on the
// contour queue for this camera does not count; a camera change does.
@property (nonatomic, readonly) NSUInteger mainProjections;
// Full centre searches. Mixes of the same two steps carry the previous
// centres and settle them; that carry does not count.
@property (nonatomic, readonly) NSUInteger centreSearches;
// Encodes that found every ring slot busy and drew through a fresh buffer.
@property (nonatomic, readonly) NSUInteger ringFallbacks;
// Kept across renders so a label slides with its isobar. Nil places each
// frame on its own and leaves the motion metrics untouched.
@property (nonatomic, strong) IsobarFieldMotion *motion;
// Labels from the last isobar render, in viewport pixels, y down.
// angle is in (-π/2, π/2], so the digits stay upright. halfW/halfH is the
// glyph box; the stroke gap is that box plus 2.5 px at scale 1.
@property (nonatomic, readonly) NSInteger labelCount;
- (BOOL)labelAtIndex:(NSInteger)index
                   x:(double *)x
                   y:(double *)y
               angle:(double *)angle
               level:(double *)level
               halfW:(double *)halfW
               halfH:(double *)halfH;
// Contour identity of that label. Zero means the label is not tied to a line.
- (uint32_t)labelIdentAtIndex:(NSInteger)index;
// H/L marks from the last isobar render. The cross is at (x, y). The letter
// sits 14 px above it and the rounded hPa value 16 px below, times contentScale,
// matching own-chart. value is the centre's pressure, not the rounded text.
@property (nonatomic, readonly) NSInteger centreCount;
- (BOOL)centreAtIndex:(NSInteger)index
                    x:(double *)x
                    y:(double *)y
                value:(double *)value
                 high:(BOOL *)high;
- (CGImageRef)renderTime:(double)fractionalStep
                    fill:(IsobarFieldKind)fill
                 isobars:(BOOL)isobars
                  camera:(IsobarCamera)camera
                   error:(NSError **)error CF_RETURNS_RETAINED;
// Encode the frame into `commandBuffer` and return. Does not commit or wait.
// `camera.viewportW/H` must equal the drawable size in pixels. Accepted
// targets: RGBA8Unorm, BGRA8Unorm, RGBA8Unorm_sRGB, BGRA8Unorm_sRGB and
// RGBA16Float. A pipeline is cached per format.
//
// Line and label vertices sit in a 3-slot ring. Each encoded frame owns the
// slot it writes until that command buffer's completed handler runs, so
// out-of-order completion cannot hand the slot to another frame. The app
// must commit every encoded buffer: a buffer that is never committed never
// completes, and its slot stays owned. Encode does not block forever. If no
// slot is free within the timeout it draws through a fresh transient buffer
// and counts the fallback (ringFallbacks).
//
// The frame writes a pick attachment and samples it in later passes of the
// same buffer. That attachment is not the CPU pick source. CPU pick renders
// a separate query texture on the renderer's queue and waits for it, so it
// does not rewrite an attachment an in-flight frame is sampling. The frame
// camera is published on the main queue from the buffer's completed handler,
// not when encode returns. Each frame has a monotonic sequence; an older
// completion does not replace a newer one. Pick validity is that newest
// completed frame's camera. Pick from the main thread.
- (BOOL)encodeTime:(double)fractionalStep
              fill:(IsobarFieldKind)fill
           isobars:(BOOL)isobars
            camera:(IsobarCamera)camera
  intoCommandBuffer:(id<MTLCommandBuffer>)commandBuffer
            target:(id<MTLTexture>)target
             error:(NSError **)error;
// Next draws blend the steps nearest `fromTime` and `toTime` instead of
// walking `time`. mix 0 draws `time` as usual. The blend does not visit the
// hours between the two steps.
- (void)setEndpointMixFrom:(double)fromTime to:(double)toTime mix:(float)mix;
// Commits and waits. Same target formats as encodeTime:.
- (BOOL)renderTime:(double)fractionalStep
              fill:(IsobarFieldKind)fill
           isobars:(BOOL)isobars
            camera:(IsobarCamera)camera
         toTexture:(id<MTLTexture>)texture
             error:(NSError **)error;
// Camera of the newest frame whose command buffer completed. NO before that.
// An older completion does not replace it.
- (BOOL)latestFrameCamera:(IsobarCamera *)camera;
// Lat/lon of the front-most fragment at this pixel, from the RG32Float
// attachment. NO off the earth.
- (BOOL)pickLatitude:(double *)latitude
           longitude:(double *)longitude
                 atX:(double)x
                   y:(double)y
              camera:(IsobarCamera)camera;
// Attachment pick, then a CPU sample of the stored field. NAN off the earth,
// outside the grid, or where either neighbouring sample is missing.
- (double)pickValueAtX:(double)x
                      y:(double)y
                 camera:(IsobarCamera)camera
                   time:(double)fractionalStep
                   kind:(IsobarFieldKind)kind;
@end
