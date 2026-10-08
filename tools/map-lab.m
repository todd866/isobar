// Map Lab — a standalone window for trying the GPU field renderer by hand.
// Not the menu-bar app, and not wired into Sources/main.m.
//
//   tools/build-map-lab.sh
//   open build/MapLab.app
//   build/MapLab.app/Contents/MacOS/MapLab --store ~/Data/isobar
//   build/MapLab.app/Contents/MacOS/MapLab --selftest --store Tests/fixtures/fieldrender
//
// The store is opened read-only. This tool never writes the store or /Applications.
// 1× is one forecast minute per real second. The map plays from the first step
// to the end of the run and back. Isobars stay on. Missing samples stay missing.
// Each frame is encoded into the drawable's command buffer, presented and
// committed. That path does not wait for the GPU. A click picks the frame
// just presented. Labels and H/L marks come from the renderer; one
// IsobarFieldMotion stays for the run and is replaced only when the run changes.
#import "fieldrender.h"
#import "mapcamera.h"
#import "ownchart.h"
#import "ownrender.h"
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <math.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <fcntl.h>
#import <unistd.h>
#import <time.h>
#import <pthread.h>
#import <sys/qos.h>

static const double kSydneyLat = -33.87;
static const double kSydneyLon = 151.21;
static const double kDefaultZoom = 6;
static const double kMinZoom = 0.75;
static const double kMaxZoom = 32;
static const double kMapClickPoints = 4;
static const int kMapSpeeds[9] = {1, 2, 4, 8, 16, 32, 64, 128, 256};

typedef struct {
    double index;
    double direction;
    int playing;
    int holding;
    double speed;
    double lastIndex;
    double stepSeconds;
} MapPlay;

static double MapClampZoom(double zoom) {
    if (!(zoom > 0) || !isfinite(zoom)) return kDefaultZoom;
    if (zoom < kMinZoom) return kMinZoom;
    if (zoom > kMaxZoom) return kMaxZoom;
    return zoom;
}

static BOOL MapSpeedValid(int speed) {
    for (int i = 0; i < 9; i++) if (kMapSpeeds[i] == speed) return YES;
    return NO;
}

static NSString *MapSpeedTitle(int speed) {
    if (!MapSpeedValid(speed)) return nil;
    return [NSString stringWithFormat:@"%d×", speed];
}

static MapPlay MapPlayMake(double speed) {
    MapPlay play;
    memset(&play, 0, sizeof play);
    play.direction = 1;
    play.playing = 1;
    play.speed = MapSpeedValid((int)speed) ? speed : 8;
    return play;
}

// Distance along a segment that reverses at both ends. direction is +1 while
// the playhead is travelling toward the end of the run.
static double MapPingPong(double distance, double last, double *direction) {
    if (!(last > 0) || !isfinite(distance)) {
        if (direction) *direction = 1;
        return 0;
    }
    if (distance < 0) distance = 0;
    double span = last * 2.0;
    double x = fmod(distance, span);
    if (x < 0) x += span;
    if (x <= last) {
        if (direction) *direction = 1;
        return x;
    }
    if (direction) *direction = -1;
    return span - x;
}

static void MapPlayAdvance(MapPlay *play, double dt) {
    if (!play || !play->playing || play->holding) return;
    if (!(dt > 0) || !isfinite(dt)) return;
    if (!MapSpeedValid((int)play->speed)) return;
    if (!(play->lastIndex > 0) || !(play->stepSeconds > 0)) return;
    double delta = play->speed * 60.0 * dt / play->stepSeconds;
    double index = play->index;
    double dir = play->direction < 0 ? -1 : 1;
    int guard = 0;
    while (delta > 1e-15 && guard++ < 64) {
        if (dir > 0) {
            double room = play->lastIndex - index;
            if (delta < room) {
                index += delta;
                delta = 0;
            } else {
                delta -= room;
                index = play->lastIndex;
                dir = -1;
            }
        } else {
            double room = index;
            if (delta < room) {
                index -= delta;
                delta = 0;
            } else {
                delta -= room;
                index = 0;
                dir = 1;
            }
        }
    }
    play->index = index;
    play->direction = dir;
}

static void MapPlayNudge(MapPlay *play, int dir) {
    if (!play) return;
    if (dir > 0) {
        double next = floor(play->index + 1e-6) + 1.0;
        if (next > play->lastIndex) next = play->lastIndex;
        play->index = next;
    } else {
        double prev = ceil(play->index - 1e-6) - 1.0;
        if (prev < 0) prev = 0;
        play->index = prev;
    }
}

// CPU time of this thread. The frame budget is work on the main thread, not
// time spent preempted.
static double MapThreadMilliseconds(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return CFAbsoluteTimeGetCurrent() * 1000.0;
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

// Where the playhead sits after `ticks` of `dt`, including the bounce at either end.
static double MapPlayIndexAfter(int ticks, double dt, double speed, double last, double stepSeconds) {
    MapPlay play = MapPlayMake(speed);
    play.lastIndex = last;
    play.stepSeconds = stepSeconds;
    for (int i = 0; i < ticks; i++) MapPlayAdvance(&play, dt);
    return play.index;
}

static NSString *MapUnit(IsobarFieldKind kind) {
    switch (kind) {
    case IsobarFieldTemperature: return @"°C";
    case IsobarFieldWindSpeed: return @"kn";
    case IsobarFieldRain: return @"mm";
    default: return @"hPa";
    }
}

static NSString *MapInspectorText(BOOL onEarth, double value, IsobarFieldKind kind, NSString *when) {
    if (!onEarth) return @"No data here";
    if (!isfinite(value)) {
        if (!when.length) return @"No data here";
        return [NSString stringWithFormat:@"No data here\n%@\nECMWF IFS", when];
    }
    return [NSString stringWithFormat:@"%.1f %@\n%@\nECMWF IFS", value, MapUnit(kind), when ?: @""];
}

static NSString *MapHUDText(double fps, double gpu, double contour, NSUInteger bytes,
    IsobarCamera cam, NSString *status) {
    NSString *body = [NSString stringWithFormat:
        @"fps %.0f\nGPU %.2f ms\ncontour %.2f ms\nresidentBytes %lu\n%.2f, %.2f\nzoom %.2f  globe %.2f",
        fps, gpu, contour, (unsigned long)bytes,
        cam.centreLat, cam.centreLon, cam.zoom, cam.globe];
    if (!status.length) return body;
    return [NSString stringWithFormat:@"%@\n%@", status, body];
}

static BOOL MapReduceMotion(void) {
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}

static NSString *MapCoastPath(void) {
    const char *env = getenv("ISOBAR_COAST");
    if (env && env[0]) return [NSString stringWithUTF8String:env];
    NSString *bundled = [[NSBundle mainBundle] pathForResource:@"ownchart-coast" ofType:@"bin"];
    if (bundled.length) return bundled;
    if ([[NSFileManager defaultManager] fileExistsAtPath:@"Resources/ownchart-coast.bin"])
        return @"Resources/ownchart-coast.bin";
    return nil;
}

static void MapInstallCoast(void) {
    NSString *path = MapCoastPath();
    if (path.length) setenv("ISOBAR_COAST", path.fileSystemRepresentation, 0);
}

static void MapSetError(NSString **error, NSString *text) {
    if (error) *error = text;
}

static float MapHalf(uint16_t bits) {
    int sign = bits >> 15;
    int exp = (bits >> 10) & 31;
    int frac = bits & 1023;
    float value;
    if (exp == 31) value = NAN;
    else if (exp == 0) value = ldexpf((float)frac, -24);
    else value = ldexpf(1.0f + (float)frac / 1024.0f, exp - 15);
    return sign ? -value : value;
}

static void MapTimeIndices(double time, NSInteger steps, NSInteger *i0, NSInteger *i1) {
    if (steps < 1) {
        *i0 = *i1 = 0;
        return;
    }
    if (!isfinite(time) || time < 0) time = 0;
    double base = floor(time + 1e-12);
    double f = time - base;
    if (f < 1e-5) f = 0;
    if (f > 1 - 1e-5) {
        base += 1;
        f = 0;
    }
    NSInteger a = (NSInteger)base;
    NSInteger b = f == 0 ? a : a + 1;
    if (a < 0) a = 0;
    if (b < 0) b = 0;
    if (a > steps - 1) a = steps - 1;
    if (b > steps - 1) b = steps - 1;
    *i0 = a;
    *i1 = b;
}

static OwnRunField MapOwnField(IsobarFieldKind kind) {
    switch (kind) {
    case IsobarFieldTemperature: return OwnRunFieldT2M;
    case IsobarFieldWindSpeed: return OwnRunFieldWindSpeed;
    case IsobarFieldRain: return OwnRunFieldRain;
    default: return OwnRunFieldMSLP;
    }
}

@class MapLabController;

@interface MapLabView : NSView
@property (nonatomic, weak) MapLabController *owner;
@property (nonatomic) NSUInteger fixedW;
@property (nonatomic) NSUInteger fixedH;
@property (nonatomic, strong) CADisplayLink *link;
- (instancetype)initWithDevice:(id<MTLDevice>)device;
- (void)usePixelsWide:(NSUInteger)w high:(NSUInteger)h;
- (void)syncDrawable;
- (void)syncViewport:(IsobarCamera *)camera;
- (CGFloat)pixelScale;
- (void)stopLink;
- (void)waitForPresented;
- (BOOL)drawCamera:(IsobarCamera *)camera
              time:(double)time
              fill:(IsobarFieldKind)fill
          renderer:(IsobarFieldRenderer *)renderer
             error:(NSString **)error;
@property (nonatomic, readonly) double lastEncodeMilliseconds;
@property (nonatomic, readonly) double lastEncodeOnlyMilliseconds;
@property (nonatomic, readonly) NSUInteger drawablePixelFormat;
@end

@interface MapLabController : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property (nonatomic, copy) NSString *storePath;
@property (nonatomic, strong) MapLabView *map;
@property (nonatomic) IsobarCamera camera;
@property (nonatomic) BOOL renderEnabled;
@property (nonatomic) BOOL hudOn;
// YES for --selftest so contour lines exist when the render returns.
// The interactive app leaves this NO: contours lag one frame.
@property (nonatomic) BOOL synchronousContours;
- (void)mapBackingChanged;
- (void)noteGpuMilliseconds:(double)ms;
- (BOOL)encodeMapTime:(double)time
               camera:(IsobarCamera)camera
                scale:(double)scale
               buffer:(id<MTLCommandBuffer>)buffer
               target:(id<MTLTexture>)target
                error:(NSError **)error;
- (void)pointerDownX:(double)x y:(double)y;
- (void)pointerDragX:(double)x y:(double)y;
- (NSString *)pointerUpX:(double)x y:(double)y;
- (void)pinchFactor:(double)factor atX:(double)x y:(double)y;
- (void)panFromX:(double)x0 y:(double)y0 toX:(double)x1 y:(double)y1;
- (BOOL)displayTick:(double)dt;
@end

@interface MapRun : NSObject
@property (nonatomic, readonly) IsobarGeoGrid grid;
@property (nonatomic, readonly) NSInteger steps;
@property (nonatomic, readonly) double stepSeconds;
@property (nonatomic, readonly) IsobarFieldRenderer *renderer;
@property (nonatomic) IsobarFieldKind fill;
@property (nonatomic, readonly) BOOL published;
@property (nonatomic, copy, readonly) NSArray<NSDate *> *times;
+ (instancetype)loadStore:(NSString *)path device:(id<MTLDevice>)device error:(NSString **)error;
- (NSDate *)dateAtIndex:(double)index;
- (BOOL)ensureTime:(double)time error:(NSString **)error;
- (void)noteRenderedTime:(double)time;
- (void)preloadFromIndex:(double)index direction:(double)direction;
- (void)resetResidency;
- (void)prepareDisplaySynchronous:(BOOL)synchronous scale:(double)scale;
- (void)notePixelScale:(double)scale;
- (BOOL)encodeTime:(double)time
            camera:(IsobarCamera)camera
             scale:(double)scale
            buffer:(id<MTLCommandBuffer>)buffer
            target:(id<MTLTexture>)target
             error:(NSError **)error;
- (void)pickAtX:(double)x
              y:(double)y
           time:(double)time
         camera:(IsobarCamera)camera
        onEarth:(BOOL *)onEarth
          value:(double *)value;
@end

@implementation MapRun {
    OwnRun *_own;
    NSArray<NSData *> *_pressure;
    NSMutableSet<NSNumber *> *_ready;
    NSLock *_lock;
    dispatch_queue_t _uploads;
    double _smoothDegrees;
    NSString *_prefetchError;
    BOOL _gridReady;
}

- (NSNumber *)keyForStep:(NSInteger)step kind:(IsobarFieldKind)kind {
    return @(step * 8 + (NSInteger)kind);
}

- (void)applyBudget {
    NSUInteger n = (NSUInteger)self.grid.nLon * (NSUInteger)self.grid.nLat;
    if (n == 0 || self.steps < 1 || !_renderer) return;
    NSUInteger sample = n * sizeof(float);
    // Pressure keeps a texture and a CPU copy. The active fill, when it is
    // not pressure, keeps a texture. Size the budget for every step of both
    // so a playing run is not evicted.
    NSUInteger pressure = sample * 2;
    NSUInteger extra = _fill == IsobarFieldPressure ? 0 : sample;
    _renderer.residentByteBudget = (pressure + extra) * (NSUInteger)self.steps;
}

- (void)setFill:(IsobarFieldKind)fill {
    _fill = fill;
    if (!_gridReady) return;
    [_lock lock];
    [self applyBudget];
    [_lock unlock];
    [self prefetchAll];
}

// Caller is on _uploads. Smooths pressure before taking the renderer lock.
- (BOOL)uploadNow:(NSInteger)step kind:(IsobarFieldKind)kind error:(NSString **)error {
    if (step < 0 || step >= self.steps) {
        MapSetError(error, @"forecast step is outside the run");
        return NO;
    }
    NSNumber *key = [self keyForStep:step kind:kind];
    if ([_ready containsObject:key]) return YES;
    size_t n = (size_t)self.grid.nLon * (size_t)self.grid.nLat;
    float *values = malloc(n * sizeof(float));
    if (!values) {
        MapSetError(error, @"out of memory");
        return NO;
    }
    [self fillValues:values count:n step:step kind:kind];
    if (kind == IsobarFieldPressure && _smoothDegrees > 0)
        IsobarSmoothPressure(values, self.grid, _smoothDegrees);
    [_lock lock];
    NSError *uploadError = nil;
    BOOL ok = [_renderer uploadStep:step kind:kind values:values error:&uploadError];
    [_lock unlock];
    free(values);
    if (!ok) MapSetError(error, uploadError.localizedDescription ?: @"field upload failed");
    else [_ready addObject:key];
    return ok;
}

- (void)prefetchAll {
    if (!_uploads || !_gridReady) return;
    IsobarFieldKind fill = _fill;
    dispatch_async(_uploads, ^{
        for (NSInteger step = 0; step < self.steps; step++) {
            NSString *err = nil;
            if (![self uploadNow:step kind:IsobarFieldPressure error:&err]) {
                self->_prefetchError = err ?: @"pressure upload failed";
                return;
            }
            if (fill != IsobarFieldPressure && ![self uploadNow:step kind:fill error:&err]) {
                self->_prefetchError = err ?: @"fill upload failed";
                return;
            }
        }
    });
}

- (void)resetResidency {
    if (!_uploads) return;
    dispatch_sync(_uploads, ^{
        [self->_ready removeAllObjects];
        self->_prefetchError = nil;
    });
    [self prefetchAll];
}

- (void)fillValues:(float *)values count:(size_t)n step:(NSInteger)step kind:(IsobarFieldKind)kind {
    if (_own) {
        OwnRunField field = MapOwnField(kind);
        for (size_t i = 0; i < n; i++) {
            double sample = [_own valueAtPointIndex:(NSInteger)i field:field hour:step];
            values[i] = isfinite(sample) ? (float)sample : NAN;
        }
        return;
    }
    NSData *data = kind == IsobarFieldPressure && step < (NSInteger)_pressure.count ? _pressure[step] : nil;
    if (data.length != n * sizeof(float)) {
        for (size_t i = 0; i < n; i++) values[i] = NAN;
        return;
    }
    memcpy(values, data.bytes, data.length);
}

- (BOOL)ensureTime:(double)time error:(NSString **)error {
    NSInteger i0 = 0, i1 = 0;
    MapTimeIndices(time, self.steps, &i0, &i1);
    IsobarFieldKind fill = _fill;
    __block BOOL ok = YES;
    __block NSString *err = nil;
    dispatch_sync(_uploads, ^{
        if (self->_prefetchError.length && self->_ready.count == 0) {
            ok = NO;
            err = self->_prefetchError;
            return;
        }
        if (![self uploadNow:i0 kind:IsobarFieldPressure error:&err]) ok = NO;
        if (ok && i1 != i0 && ![self uploadNow:i1 kind:IsobarFieldPressure error:&err]) ok = NO;
        if (ok && fill != IsobarFieldPressure && ![self uploadNow:i0 kind:fill error:&err]) ok = NO;
        if (ok && fill != IsobarFieldPressure && i1 != i0 && ![self uploadNow:i1 kind:fill error:&err]) ok = NO;
    });
    if (!ok) MapSetError(error, err ?: @"field upload failed");
    return ok;
}

- (void)noteRenderedTime:(double)time {
    (void)time;
}

// The whole run is uploaded off the main thread. Playback does not upload.
- (void)preloadFromIndex:(double)index direction:(double)direction {
    (void)index;
    (void)direction;
}

- (void)prepareDisplaySynchronous:(BOOL)synchronous scale:(double)scale {
    [_lock lock];
    _renderer.synchronousContours = synchronous;
    if (!_renderer.motion) _renderer.motion = [IsobarFieldMotion new];
    if (scale > 0) _renderer.pixelsPerPoint = scale;
    [_lock unlock];
}

- (void)notePixelScale:(double)scale {
    if (!(scale > 0) || !_lock) return;
    [_lock lock];
    _renderer.pixelsPerPoint = scale;
    [_lock unlock];
}

- (BOOL)encodeTime:(double)time
            camera:(IsobarCamera)camera
             scale:(double)scale
            buffer:(id<MTLCommandBuffer>)buffer
            target:(id<MTLTexture>)target
             error:(NSError **)error {
    [_lock lock];
    if (scale > 0) _renderer.pixelsPerPoint = scale;
    BOOL ok = [_renderer encodeTime:time fill:_fill isobars:YES camera:camera
        intoCommandBuffer:buffer target:target error:error];
    [_lock unlock];
    return ok;
}

- (void)pickAtX:(double)x
              y:(double)y
           time:(double)time
         camera:(IsobarCamera)camera
        onEarth:(BOOL *)onEarth
          value:(double *)value {
    double lat = 0, lon = 0;
    [_lock lock];
    BOOL earth = [_renderer pickLatitude:&lat longitude:&lon atX:x y:y camera:camera];
    double sample = earth ? [_renderer pickValueAtX:x y:y camera:camera time:time kind:_fill] : NAN;
    [_lock unlock];
    if (onEarth) *onEarth = earth;
    if (value) *value = sample;
}

- (NSDate *)dateAtIndex:(double)index {
    if (!self.times.count) return nil;
    if (!isfinite(index) || index < 0) index = 0;
    if (index > self.steps - 1) index = self.steps - 1;
    NSInteger i0 = (NSInteger)floor(index + 1e-12);
    if (i0 < 0) i0 = 0;
    if (i0 >= (NSInteger)self.times.count) i0 = self.times.count - 1;
    double f = index - i0;
    if (f < 1e-5 || i0 + 1 >= (NSInteger)self.times.count) return self.times[i0];
    NSTimeInterval span = [self.times[i0 + 1] timeIntervalSinceDate:self.times[i0]];
    return [self.times[i0] dateByAddingTimeInterval:span * f];
}

+ (BOOL)openReadOnly:(NSString *)path error:(NSString **)error {
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_DIRECTORY);
    if (fd < 0) {
        MapSetError(error, @"store is not a readable directory");
        return NO;
    }
    close(fd);
    return YES;
}

+ (instancetype)loadStore:(NSString *)path device:(id<MTLDevice>)device error:(NSString **)error {
    if (![self openReadOnly:path error:error]) return nil;
    MapInstallCoast();
    IsobarFieldRenderer *renderer = [[IsobarFieldRenderer alloc] initWithDevice:device];
    if (!renderer) {
        MapSetError(error, @"field renderer failed to compile");
        return nil;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *pointer = [path stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/current.json"];
    NSString *header = [path stringByAppendingPathComponent:@"header.json"];
    MapRun *run = [MapRun new];
    run->_renderer = renderer;
    run->_ready = [NSMutableSet set];
    run->_lock = [NSLock new];
    run->_uploads = dispatch_queue_create("maplab.uploads", DISPATCH_QUEUE_SERIAL);
    run->_fill = IsobarFieldPressure;
    if ([fm fileExistsAtPath:pointer]) {
        if (![run loadPublished:path error:error]) return nil;
    } else if ([fm fileExistsAtPath:header]) {
        if (![run loadFixture:path error:error]) return nil;
    } else {
        MapSetError(error, @"published run did not load");
        return nil;
    }
    [renderer setGrid:run->_grid];
    run->_smoothDegrees = renderer.pressureSmoothDegrees;
    if (!(run->_smoothDegrees > 0)) run->_smoothDegrees = 0.3125;
    renderer.pressureSmoothDegrees = 0;
    run->_gridReady = YES;
    [run applyBudget];
    [run prefetchAll];
    return run;
}

- (BOOL)adoptTimes:(NSArray<NSDate *> *)times error:(NSString **)error {
    if (times.count < 1 || times.count > 256) {
        MapSetError(error, @"forecast run has no usable steps");
        return NO;
    }
    for (NSDate *date in times) {
        if (![date isKindOfClass:NSDate.class]) {
            MapSetError(error, @"forecast step has no valid time");
            return NO;
        }
    }
    _times = [times copy];
    _steps = (NSInteger)times.count;
    if (times.count >= 2) {
        NSTimeInterval gap = [times[1] timeIntervalSinceDate:times[0]];
        if (!(gap > 0)) {
            MapSetError(error, @"forecast steps are not ordered");
            return NO;
        }
        for (NSUInteger i = 2; i < times.count; i++) {
            NSTimeInterval next = [times[i] timeIntervalSinceDate:times[i - 1]];
            if (fabs(next - gap) > 2) {
                MapSetError(error, @"forecast steps are not evenly spaced");
                return NO;
            }
        }
        _stepSeconds = gap;
    } else {
        _stepSeconds = 3 * 3600;
    }
    return YES;
}

- (BOOL)loadPublished:(NSString *)path error:(NSString **)error {
    NSString *coast = MapCoastPath();
    NSString *runError = nil;
    OwnRun *own = OwnRunLoadPublished(path, NO, coast, &runError);
    if (!own) {
        MapSetError(error, runError ?: @"published run did not load");
        return NO;
    }
    _grid = (IsobarGeoGrid){
        .west = OwnGridWest(), .north = OwnGridNorth(), .step = OwnGridStep(),
        .nLon = OwnGridNLon(), .nLat = OwnGridNLat(), .wrapsLongitude = NO
    };
    NSMutableArray<NSDate *> *times = [NSMutableArray array];
    for (NSInteger i = 0; i < own.hours; i++) {
        NSDate *date = [own timeAtIndex:i];
        if (!date) {
            MapSetError(error, @"published step has no valid time");
            return NO;
        }
        [times addObject:date];
    }
    if (![self adoptTimes:times error:error]) return NO;
    _own = own;
    _published = YES;
    return YES;
}

- (BOOL)loadFixture:(NSString *)path error:(NSString **)error {
    NSData *headerData = [NSData dataWithContentsOfFile:[path stringByAppendingPathComponent:@"header.json"]];
    NSDictionary *header = [NSJSONSerialization JSONObjectWithData:headerData ?: [NSData data] options:0 error:nil];
    if (![header isKindOfClass:NSDictionary.class]) {
        MapSetError(error, @"field fixture header is not an object");
        return NO;
    }
    NSDictionary *grid = header[@"grid"];
    NSArray *steps = header[@"steps"];
    if (![grid isKindOfClass:NSDictionary.class] || ![steps isKindOfClass:NSArray.class] || !steps.count) {
        MapSetError(error, @"field fixture is missing a grid");
        return NO;
    }
    IsobarGeoGrid g = {
        .west = [grid[@"west"] doubleValue],
        .north = [grid[@"north"] doubleValue],
        .step = [grid[@"step"] doubleValue],
        .nLon = [grid[@"nLon"] intValue],
        .nLat = [grid[@"nLat"] intValue],
        .wrapsLongitude = [grid[@"wrapsLongitude"] boolValue]
    };
    if (!(g.step > 0) || g.nLon < 2 || g.nLat < 2 || g.nLon > 4096 || g.nLat > 4096) {
        MapSetError(error, @"field fixture grid is not usable");
        return NO;
    }
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    NSMutableArray<NSDate *> *times = [NSMutableArray array];
    NSMutableArray<NSData *> *fields = [NSMutableArray array];
    size_t n = (size_t)g.nLon * (size_t)g.nLat;
    for (id item in steps) {
        if (![item isKindOfClass:NSDictionary.class]) {
            MapSetError(error, @"field fixture step is not an object");
            return NO;
        }
        NSString *file = item[@"file"];
        NSString *valid = item[@"valid"];
        NSDate *date = [valid isKindOfClass:NSString.class] ? [iso dateFromString:valid] : nil;
        if (![file isKindOfClass:NSString.class] || !date) {
            MapSetError(error, @"field fixture step has no file or valid time");
            return NO;
        }
        NSData *raw = [NSData dataWithContentsOfFile:[path stringByAppendingPathComponent:file]];
        if (raw.length != n * 2) {
            MapSetError(error, @"field fixture step does not match the grid");
            return NO;
        }
        NSMutableData *values = [NSMutableData dataWithLength:n * sizeof(float)];
        float *out = values.mutableBytes;
        const uint8_t *bytes = raw.bytes;
        for (size_t i = 0; i < n; i++) {
            uint16_t bits = (uint16_t)(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
            float sample = MapHalf(bits);
            out[i] = isfinite(sample) ? sample : NAN;
        }
        [fields addObject:values];
        [times addObject:date];
    }
    if (![self adoptTimes:times error:error]) return NO;
    _grid = g;
    _pressure = fields;
    return YES;
}

@end

@implementation MapLabView {
    id<MTLDevice> _device;
    id<MTLCommandQueue> _presentQueue;
    id<MTLCommandBuffer> _inflight;
    CFTimeInterval _lastStamp;
}

- (instancetype)initWithDevice:(id<MTLDevice>)device {
    self = [super initWithFrame:NSMakeRect(0, 0, 640, 480)];
    if (!self) return nil;
    _device = device;
    CAMetalLayer *metal = [CAMetalLayer layer];
    metal.device = device;
    // The drawable's own format is what encode accepts: BGRA8Unorm, or
    // BGRA8Unorm_sRGB when the layer's colorspace selects it.
    metal.pixelFormat = MTLPixelFormatBGRA8Unorm;
    metal.framebufferOnly = YES;
    metal.opaque = YES;
    metal.allowsNextDrawableTimeout = NO;
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (space) {
        metal.colorspace = space;
        CGColorSpaceRelease(space);
    }
    self.layer = metal;
    self.wantsLayer = YES;
    _presentQueue = [device newCommandQueue];
    return self;
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }

- (CAMetalLayer *)metalLayer {
    return (CAMetalLayer *)self.layer;
}

- (CGFloat)pixelScale {
    if (self.fixedW >= 2) return 1;
    CGFloat scale = self.window.backingScaleFactor;
    return scale > 1 ? scale : 1;
}

- (void)syncDrawable {
    CAMetalLayer *metal = self.metalLayer;
    if (self.fixedW >= 2 && self.fixedH >= 2) {
        metal.contentsScale = 1;
        metal.drawableSize = CGSizeMake(self.fixedW, self.fixedH);
        return;
    }
    CGFloat scale = [self pixelScale];
    metal.contentsScale = scale;
    CGSize size = CGSizeMake(round(self.bounds.size.width * scale), round(self.bounds.size.height * scale));
    if (size.width < 2) size.width = 2;
    if (size.height < 2) size.height = 2;
    if (size.width > 8192) size.width = 8192;
    if (size.height > 8192) size.height = 8192;
    metal.drawableSize = size;
}

- (void)usePixelsWide:(NSUInteger)w high:(NSUInteger)h {
    self.fixedW = w;
    self.fixedH = h;
    self.frame = NSMakeRect(0, 0, w, h);
    [self syncDrawable];
}

- (void)syncViewport:(IsobarCamera *)camera {
    if (!camera) return;
    [self syncDrawable];
    camera->viewportW = self.metalLayer.drawableSize.width;
    camera->viewportH = self.metalLayer.drawableSize.height;
}

- (void)stopLink {
    [self.link invalidate];
    self.link = nil;
    _lastStamp = 0;
}

- (void)dealloc {
    [_link invalidate];
}

- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    [self stopLink];
    if (!self.window || self.fixedW >= 2) return;
    self.link = [self displayLinkWithTarget:self selector:@selector(onDisplay:)];
    [self.link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    BOOL visible = (self.window.occlusionState & NSWindowOcclusionStateVisible) != 0;
    self.link.paused = !visible;
}

- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    [self syncDrawable];
    [self.owner mapBackingChanged];
}

- (void)setFrameSize:(NSSize)newSize {
    [super setFrameSize:newSize];
    [self syncDrawable];
}

- (NSPoint)pixelFromEvent:(NSEvent *)event {
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    CGFloat scale = [self pixelScale];
    return NSMakePoint(p.x * scale, p.y * scale);
}

- (void)mouseDown:(NSEvent *)event {
    if (self.window) [self.window makeFirstResponder:self];
    NSPoint p = [self pixelFromEvent:event];
    [self.owner pointerDownX:p.x y:p.y];
}

- (void)mouseDragged:(NSEvent *)event {
    NSPoint p = [self pixelFromEvent:event];
    [self.owner pointerDragX:p.x y:p.y];
}

- (void)mouseUp:(NSEvent *)event {
    NSPoint p = [self pixelFromEvent:event];
    [self.owner pointerUpX:p.x y:p.y];
}

- (void)magnifyWithEvent:(NSEvent *)event {
    NSPoint p = [self pixelFromEvent:event];
    double factor = 1.0 + event.magnification;
    [self.owner pinchFactor:factor atX:p.x y:p.y];
}

- (void)scrollWheel:(NSEvent *)event {
    NSPoint p = [self pixelFromEvent:event];
    BOOL zoom = !event.hasPreciseScrollingDeltas || (event.modifierFlags & NSEventModifierFlagCommand) != 0;
    if (zoom) {
        double notches = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY / 40.0 : event.scrollingDeltaY;
        [self.owner pinchFactor:exp(notches * 0.12) atX:p.x y:p.y];
        return;
    }
    CGFloat scale = [self pixelScale];
    double dx = event.scrollingDeltaX * scale;
    double dy = -event.scrollingDeltaY * scale;
    [self.owner panFromX:p.x y:p.y toX:p.x + dx y:p.y + dy];
}

- (void)onDisplay:(CADisplayLink *)link {
    if (!self.window || self.isHiddenOrHasHiddenAncestor) return;
    if ((self.window.occlusionState & NSWindowOcclusionStateVisible) == 0) return;
    double dt = link.duration;
    if (_lastStamp > 0) {
        double elapsed = link.timestamp - _lastStamp;
        if (elapsed > 0 && elapsed < 1) dt = elapsed;
    }
    _lastStamp = link.timestamp;
    [self.owner displayTick:dt];
}

- (void)waitForPresented {
    if (!_inflight) return;
    [_inflight waitUntilCompleted];
    _inflight = nil;
}

- (BOOL)drawCamera:(IsobarCamera *)camera
              time:(double)time
              fill:(IsobarFieldKind)fill
          renderer:(IsobarFieldRenderer *)renderer
             error:(NSString **)error {
    (void)fill;
    (void)renderer;
    if (!camera || !self.owner) {
        MapSetError(error, @"map is not ready");
        return NO;
    }
    [self syncDrawable];
    id<CAMetalDrawable> drawable = [self.metalLayer nextDrawable];
    if (!drawable) {
        MapSetError(error, @"no Metal drawable");
        return NO;
    }
    camera->viewportW = drawable.texture.width;
    camera->viewportH = drawable.texture.height;
    _drawablePixelFormat = drawable.texture.pixelFormat;
    id<MTLCommandBuffer> buffer = [_presentQueue commandBuffer];
    if (!buffer) {
        MapSetError(error, @"command buffer could not be created");
        return NO;
    }
    NSError *renderError = nil;
    double began = MapThreadMilliseconds();
    BOOL ok = [self.owner encodeMapTime:time camera:*camera scale:[self pixelScale]
        buffer:buffer target:drawable.texture error:&renderError];
    _lastEncodeOnlyMilliseconds = MapThreadMilliseconds() - began;
    if (ok) {
        __weak MapLabController *owner = self.owner;
        [buffer addCompletedHandler:^(id<MTLCommandBuffer> done) {
            double gpu = (done.GPUEndTime - done.GPUStartTime) * 1000.0;
            [owner noteGpuMilliseconds:gpu > 0 ? gpu : 0];
        }];
        [buffer presentDrawable:drawable];
        [buffer commit];
        _inflight = buffer;
    }
    _lastEncodeMilliseconds = MapThreadMilliseconds() - began;
    if (!ok) MapSetError(error, renderError.localizedDescription ?: @"render failed");
    return ok;
}

@end

@implementation MapLabController {
    id<MTLDevice> _device;
    MapRun *_run;
    MapPlay _play;
    NSWindow *_window;
    NSView *_stage;
    NSView *_bar;
    NSButton *_playButton;
    NSPopUpButton *_speedPopup;
    NSSlider *_timeline;
    NSTextField *_clock;
    NSButton *_flatButton;
    NSSlider *_globeSlider;
    NSButton *_globeButton;
    NSPopUpButton *_layerPopup;
    NSButton *_recenterButton;
    NSTextField *_hud;
    NSTextField *_inspector;
    NSTextField *_unavailable;
    NSDateFormatter *_timeFormatter;
    BOOL _morphing;
    double _morphFrom, _morphTo, _morphT;
    BOOL _resume;
    int _chromeWrite;
    double _downX, _downY, _grabLat, _grabLon;
    BOOL _grabbed, _dragging;
    double _lastDt, _fps, _fpsWindow;
    int _fpsFrames;
    double _lastGpu, _lastContour;
    NSLock *_gpuLock;
    double _gpuSum;
    int _gpuFrames;
    NSString *_status;
    id _keyMonitor;
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    _device = MTLCreateSystemDefaultDevice();
    _hudOn = YES;
    _resume = YES;
    _gpuLock = [NSLock new];
    _camera = MapCameraMake(kSydneyLat, kSydneyLon, kDefaultZoom, 0, 480, 360);
    _play = MapPlayMake(8);
    return self;
}

- (void)dealloc {
    if (_keyMonitor) [NSEvent removeMonitor:_keyMonitor];
}

- (NSDateFormatter *)timeFormatter {
    if (_timeFormatter) return _timeFormatter;
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_AU"];
    fmt.timeZone = [NSTimeZone timeZoneWithName:@"Australia/Sydney"];
    fmt.dateFormat = @"d MMM yyyy, h:mm a zzz";
    _timeFormatter = fmt;
    return fmt;
}

- (NSString *)timeText {
    NSDate *date = [_run dateAtIndex:_play.index];
    if (!date) return @"";
    return [self.timeFormatter stringFromDate:date] ?: @"";
}

- (double)clickSlop {
    return kMapClickPoints * [self.map pixelScale];
}

- (void)syncPlayTitle {
    BOOL active = _play.holding ? _resume : _play.playing;
    _playButton.title = active ? @"Pause" : @"Play";
}

- (void)syncGlobeSlider {
    if (!_globeSlider) return;
    _chromeWrite++;
    _globeSlider.doubleValue = _camera.globe;
    _chromeWrite--;
}

- (void)syncPlayChrome {
    [self syncPlayTitle];
    [self syncGlobeSlider];
    if (_timeline) {
        _chromeWrite++;
        _timeline.doubleValue = _play.index;
        _chromeWrite--;
    }
    if (_clock) _clock.stringValue = [self timeText];
}

- (void)syncHUD {
    if (!_hud) return;
    [_gpuLock lock];
    double gpu = _lastGpu;
    [_gpuLock unlock];
    _hud.stringValue = MapHUDText(_fps, gpu, _lastContour,
        _run.renderer.residentBytes, _camera, _status);
}

- (void)noteGpuMilliseconds:(double)ms {
    [_gpuLock lock];
    _lastGpu = ms;
    _gpuSum += ms;
    _gpuFrames++;
    [_gpuLock unlock];
}

- (BOOL)encodeMapTime:(double)time
               camera:(IsobarCamera)camera
                scale:(double)scale
               buffer:(id<MTLCommandBuffer>)buffer
               target:(id<MTLTexture>)target
                error:(NSError **)error {
    if (!_run) return NO;
    return [_run encodeTime:time camera:camera scale:scale buffer:buffer target:target error:error];
}

- (void)mapBackingChanged {
    [self.map syncDrawable];
    if (_run) [_run notePixelScale:[self.map pixelScale]];
    [self invalidateMap];
}

- (void)noteFps {
    if (!(_lastDt > 0)) return;
    _fpsFrames++;
    _fpsWindow += _lastDt;
    if (_fpsWindow >= 0.5) {
        _fps = _fpsFrames / _fpsWindow;
        _fpsFrames = 0;
        _fpsWindow = 0;
    }
}

- (BOOL)renderNow {
    if (!_run || !self.map) return NO;
    NSString *error = nil;
    if (![_run ensureTime:_play.index error:&error]) {
        _status = error;
        [self syncHUD];
        return NO;
    }
    if (_camera.globe < 0) _camera.globe = 0;
    if (_camera.globe > 1) _camera.globe = 1;
    BOOL ok = [self.map drawCamera:&_camera time:_play.index fill:_run.fill renderer:_run.renderer error:&error];
    if (!ok && error.length && [error containsString:@"not resident"]) {
        [_run resetResidency];
        if ([_run ensureTime:_play.index error:&error])
            ok = [self.map drawCamera:&_camera time:_play.index fill:_run.fill renderer:_run.renderer error:&error];
    }
    if (ok) {
        [_run noteRenderedTime:_play.index];
        [_run preloadFromIndex:_play.index direction:_play.direction];
        _status = nil;
        // GPU time arrives from the command buffer's completion handler.
        // encodeTime does not wait, so lastGpuMilliseconds stays stale.
        _lastContour = _run.renderer.lastContourMilliseconds;
        [self noteFps];
    } else {
        _status = error ?: @"render failed";
    }
    [self syncHUD];
    return ok;
}

- (void)invalidateMap {
    if (!self.renderEnabled) return;
    if (!self.map.link || self.map.link.paused) [self renderNow];
}

- (void)advance:(double)dt {
    if (_morphing) {
        _morphT += dt;
        _camera.globe = MapGlobeAt(_morphFrom, _morphTo, _morphT, kMapMorphSeconds, 0);
        if (_morphT >= kMapMorphSeconds) {
            _camera.globe = _morphTo;
            _morphing = NO;
        }
    }
    MapPlayAdvance(&_play, dt);
    [self syncPlayChrome];
}

- (BOOL)displayTick:(double)dt {
    @autoreleasepool {
        if (!(dt > 0) || !isfinite(dt)) dt = 1.0 / 60.0;
        if (dt > 1) dt = 1;
        _lastDt = dt;
        [self advance:dt];
        if (!self.renderEnabled) return YES;
        return [self renderNow];
    }
}

- (void)animateGlobeTo:(double)target reduced:(BOOL)reduced {
    if (target < 0) target = 0;
    if (target > 1) target = 1;
    if (reduced || fabs(target - _camera.globe) < 1e-6) {
        _camera.globe = target;
        _morphing = NO;
        [self syncGlobeSlider];
        [self invalidateMap];
        return;
    }
    _morphFrom = _camera.globe;
    _morphTo = target;
    _morphT = 0;
    _morphing = YES;
}

- (void)togglePlay {
    if (_play.holding) _resume = !_resume;
    else _play.playing = !_play.playing;
    [self syncPlayTitle];
}

- (void)toggleHUD {
    self.hudOn = !self.hudOn;
    _hud.hidden = !self.hudOn;
}

- (void)beginHold {
    if (_play.holding) return;
    _resume = _play.playing;
    _play.holding = YES;
    [self syncPlayTitle];
}

- (void)scrubTo:(double)index {
    if (!isfinite(index) || index < 0) index = 0;
    if (index > _play.lastIndex) index = _play.lastIndex;
    _play.index = index;
    if (_clock) _clock.stringValue = [self timeText];
}

- (void)endHold {
    if (!_play.holding) return;
    _play.holding = NO;
    _play.playing = _resume;
    if (_play.index >= _play.lastIndex - 1e-9) _play.direction = -1;
    if (_play.index <= 1e-9) _play.direction = 1;
    [self syncPlayTitle];
}

- (void)nudge:(int)dir {
    MapPlayNudge(&_play, dir);
    [self syncPlayChrome];
    [self invalidateMap];
}

- (void)syncViewport {
    [self.map syncViewport:&_camera];
}

- (BOOL)anchorFromX:(double)x0 y:(double)y0 toX:(double)x1 y:(double)y1 {
    [self syncViewport];
    double lat = 0, lon = 0;
    if (!IsobarCameraUnproject(_camera, x0, y0, &lat, &lon)) return NO;
    IsobarCamera next = _camera;
    if (!MapCameraAnchor(&next, lat, lon, x1, y1)) return NO;
    _camera = next;
    return YES;
}

- (double)anchorErrorFromX:(double)x0 y:(double)y0 toX:(double)x1 y:(double)y1 {
    [self syncViewport];
    double lat = 0, lon = 0;
    if (!IsobarCameraUnproject(_camera, x0, y0, &lat, &lon)) return -1;
    IsobarCamera next = _camera;
    if (!MapCameraAnchor(&next, lat, lon, x1, y1)) return -1;
    double px = 0, py = 0;
    if (!IsobarCameraProject(next, lat, lon, &px, &py)) return -1;
    _camera = next;
    return hypot(px - x1, py - y1);
}

- (void)pointerDownX:(double)x y:(double)y {
    [self syncViewport];
    _downX = x;
    _downY = y;
    _dragging = NO;
    _grabbed = IsobarCameraUnproject(_camera, x, y, &_grabLat, &_grabLon);
}

- (void)pointerDragX:(double)x y:(double)y {
    [self syncViewport];
    if (!_dragging && MapPointerIsClick(x - _downX, y - _downY, [self clickSlop])) return;
    _dragging = YES;
    double lat = _grabLat, lon = _grabLon, ax = x, ay = y;
    if (!_grabbed) {
        double cx = _camera.viewportW * 0.5, cy = _camera.viewportH * 0.5;
        if (!IsobarCameraUnproject(_camera, cx, cy, &lat, &lon)) return;
        ax = cx + (x - _downX);
        ay = cy + (y - _downY);
    }
    IsobarCamera next = _camera;
    if (MapCameraAnchor(&next, lat, lon, ax, ay)) _camera = next;
    _camera = IsobarCameraClamp(_camera);
    [self invalidateMap];
}

- (void)showInspector:(NSString *)text atX:(double)x y:(double)y {
    if (!_inspector) return;
    _inspector.stringValue = text;
    _inspector.hidden = NO;
    if (!_stage) return;
    CGFloat scale = [self.map pixelScale];
    if (scale < 1) scale = 1;
    CGFloat px = x / scale;
    CGFloat py = y / scale;
    CGFloat stageH = NSHeight(_stage.bounds);
    CGFloat top = stageH - py;
    NSRect box = NSMakeRect(px + 12, top - 74, 230, 64);
    if (NSMaxX(box) > NSWidth(_stage.bounds) - 8) box.origin.x = MAX(8, px - 242);
    if (box.origin.y < 8) box.origin.y = 8;
    _inspector.frame = box;
}

- (NSString *)inspectX:(double)x y:(double)y {
    if (!_run) return @"No data here";
    self.renderEnabled = YES;
    if (![self renderNow]) return _status ?: @"Chart unavailable";
    // The frame path has already committed. Pick reads that attachment from
    // the renderer's queue, so the click waits for the present to finish.
    [self.map waitForPresented];
    BOOL onEarth = NO;
    double value = NAN;
    [_run pickAtX:x y:y time:_play.index camera:_camera onEarth:&onEarth value:&value];
    NSString *text = MapInspectorText(onEarth, value, _run.fill, [self timeText]);
    [self showInspector:text atX:x y:y];
    return text;
}

- (NSString *)pointerUpX:(double)x y:(double)y {
    BOOL click = !_dragging && MapPointerIsClick(x - _downX, y - _downY, [self clickSlop]);
    _dragging = NO;
    if (!click) return nil;
    return [self inspectX:x y:y];
}

- (double)pinchErrorFactor:(double)factor atX:(double)x y:(double)y {
    [self syncViewport];
    if (!isfinite(factor) || factor <= 0) return -1;
    double lat = 0, lon = 0;
    if (!IsobarCameraUnproject(_camera, x, y, &lat, &lon)) return -1;
    IsobarCamera next = _camera;
    next.zoom = MapClampZoom(_camera.zoom * factor);
    if (!MapCameraAnchor(&next, lat, lon, x, y)) return -1;
    double px = 0, py = 0;
    if (!IsobarCameraProject(next, lat, lon, &px, &py)) return -1;
    _camera = next;
    return hypot(px - x, py - y);
}

- (void)pinchFactor:(double)factor atX:(double)x y:(double)y {
    if ([self pinchErrorFactor:factor atX:x y:y] < 0) return;
    _camera = IsobarCameraClamp(_camera);
    [self invalidateMap];
}

- (void)panFromX:(double)x0 y:(double)y0 toX:(double)x1 y:(double)y1 {
    BOOL moved = [self anchorFromX:x0 y:y0 toX:x1 y:y1];
    if (!moved) {
        [self syncViewport];
        double cx = _camera.viewportW * 0.5, cy = _camera.viewportH * 0.5;
        moved = [self anchorFromX:cx y:cy toX:cx + (x1 - x0) y:cy + (y1 - y0)];
    }
    _camera = IsobarCameraClamp(_camera);
    if (moved) [self invalidateMap];
}

- (void)zoomBy:(double)factor {
    [self syncViewport];
    [self pinchFactor:factor atX:_camera.viewportW * 0.5 y:_camera.viewportH * 0.5];
}

- (void)recenter {
    _camera.centreLat = kSydneyLat;
    _camera.centreLon = kSydneyLon;
    _camera.zoom = kDefaultZoom;
    [self invalidateMap];
}

- (BOOL)handleCommand:(NSString *)chars modifiers:(NSEventModifierFlags)flags repeat:(BOOL)repeat {
    if (chars.length != 1) return NO;
    unichar ch = [chars characterAtIndex:0];
    BOOL command = (flags & NSEventModifierFlagCommand) != 0;
    if ((flags & (NSEventModifierFlagControl | NSEventModifierFlagOption)) != 0) return NO;
    if (command) {
        if (ch == '=' || ch == '+') {
            [self zoomBy:1.25];
            return YES;
        }
        if (ch == '-' || ch == '_') {
            [self zoomBy:1.0 / 1.25];
            return YES;
        }
        return NO;
    }
    if (repeat && (ch == ' ' || ch == 'h' || ch == 'H' || ch == '2' || ch == '3')) return YES;
    if (ch == ' ') {
        [self togglePlay];
        return YES;
    }
    if (ch == 'h' || ch == 'H') {
        [self toggleHUD];
        return YES;
    }
    if (ch == '2') {
        [self animateGlobeTo:0 reduced:MapReduceMotion()];
        return YES;
    }
    if (ch == '3') {
        [self animateGlobeTo:1 reduced:MapReduceMotion()];
        return YES;
    }
    if (ch == NSLeftArrowFunctionKey) {
        [self nudge:-1];
        return YES;
    }
    if (ch == NSRightArrowFunctionKey) {
        [self nudge:1];
        return YES;
    }
    return NO;
}

- (BOOL)handleKey:(NSEvent *)event {
    return [self handleCommand:event.charactersIgnoringModifiers modifiers:event.modifierFlags repeat:event.isARepeat];
}

- (NSButton *)textButton:(NSString *)title action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bordered = NO;
    button.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    return button;
}

- (NSTextField *)readout {
    NSTextField *field = [NSTextField labelWithString:@""];
    field.editable = NO;
    field.bezeled = NO;
    field.drawsBackground = NO;
    field.selectable = NO;
    field.font = [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular];
    field.alignment = NSTextAlignmentCenter;
    return field;
}

- (void)buildChrome {
    _bar = [NSView new];
    _stage = [NSView new];
    _playButton = [NSButton buttonWithTitle:@"Pause" target:self action:@selector(togglePlay)];
    _playButton.controlSize = NSControlSizeSmall;
    _playButton.font = [NSFont systemFontOfSize:[NSFont systemFontSizeForControlSize:NSControlSizeSmall]];
    _playButton.toolTip = @"Space";
    _playButton.accessibilityLabel = @"Play";

    _speedPopup = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
    _speedPopup.controlSize = NSControlSizeSmall;
    _speedPopup.font = [NSFont systemFontOfSize:[NSFont systemFontSizeForControlSize:NSControlSizeSmall]];
    _speedPopup.target = self;
    _speedPopup.action = @selector(speedChanged:);
    _speedPopup.toolTip = @"1× is one forecast minute per real second.";
    _speedPopup.accessibilityLabel = @"Playback speed";
    for (int i = 0; i < 9; i++) {
        [self->_speedPopup addItemWithTitle:MapSpeedTitle(kMapSpeeds[i])];
        self->_speedPopup.lastItem.tag = kMapSpeeds[i];
    }
    [_speedPopup selectItemWithTag:8];

    _timeline = [NSSlider sliderWithValue:0 minValue:0 maxValue:1 target:self action:@selector(timelineMoved:)];
    _timeline.controlSize = NSControlSizeSmall;
    _timeline.continuous = YES;
    [_timeline sendActionOn:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp];
    _timeline.accessibilityLabel = @"Timeline";

    _clock = [self readout];
    _flatButton = [self textButton:@"2D" action:@selector(goFlat:)];
    _flatButton.accessibilityLabel = @"Flat map";
    _globeSlider = [NSSlider sliderWithValue:0 minValue:0 maxValue:1 target:self action:@selector(globeSlid:)];
    _globeSlider.controlSize = NSControlSizeSmall;
    _globeSlider.continuous = YES;
    _globeSlider.toolTip = @"2 and 3";
    _globeSlider.accessibilityLabel = @"2D to 3D";
    _globeButton = [self textButton:@"3D" action:@selector(goGlobe:)];
    _globeButton.accessibilityLabel = @"Globe";

    _layerPopup = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
    _layerPopup.controlSize = NSControlSizeSmall;
    _layerPopup.font = _speedPopup.font;
    _layerPopup.target = self;
    _layerPopup.action = @selector(layerChanged:);
    _layerPopup.accessibilityLabel = @"Weather layer";
    NSArray *layers = @[
        @[@"Pressure", @(IsobarFieldPressure)],
        @[@"Rain 24h", @(IsobarFieldRain)],
        @[@"Wind speed", @(IsobarFieldWindSpeed)],
        @[@"Surface temperature", @(IsobarFieldTemperature)],
    ];
    for (NSArray *item in layers) {
        [_layerPopup addItemWithTitle:item[0]];
        _layerPopup.lastItem.tag = [item[1] integerValue];
    }
    [_layerPopup selectItemWithTag:IsobarFieldPressure];

    _recenterButton = [NSButton buttonWithTitle:@"Recenter" target:self action:@selector(recenter)];
    _recenterButton.controlSize = NSControlSizeSmall;
    _recenterButton.font = _playButton.font;
    _recenterButton.toolTip = @"Sydney";
    _recenterButton.accessibilityLabel = @"Recenter on Sydney";

    for (NSView *view in @[_playButton, _speedPopup, _timeline, _clock, _flatButton, _globeSlider, _globeButton, _layerPopup, _recenterButton])
        [_bar addSubview:view];

    _hud = [NSTextField labelWithString:@""];
    _hud.editable = NO;
    _hud.bezeled = NO;
    _hud.selectable = NO;
    _hud.drawsBackground = YES;
    _hud.backgroundColor = [NSColor colorWithSRGBRed:0.08 green:0.10 blue:0.12 alpha:0.88];
    _hud.textColor = NSColor.whiteColor;
    _hud.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    _hud.alignment = NSTextAlignmentLeft;
    _hud.wantsLayer = YES;
    _hud.layer.cornerRadius = 6;
    _hud.layer.masksToBounds = YES;
    _inspector = [NSTextField labelWithString:@""];
    _inspector.editable = NO;
    _inspector.bezeled = NO;
    _inspector.selectable = NO;
    _inspector.drawsBackground = YES;
    _inspector.backgroundColor = _hud.backgroundColor;
    _inspector.textColor = NSColor.whiteColor;
    _inspector.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    _inspector.hidden = YES;
    _inspector.wantsLayer = YES;
    _inspector.layer.cornerRadius = 6;
    _inspector.layer.masksToBounds = YES;
    _unavailable = [NSTextField wrappingLabelWithString:@"Chart unavailable"];
    _unavailable.alignment = NSTextAlignmentCenter;
    _unavailable.font = [NSFont systemFontOfSize:18 weight:NSFontWeightMedium];
    _unavailable.hidden = YES;
    [_stage addSubview:_hud];
    [_stage addSubview:_inspector];
    [_stage addSubview:_unavailable];
}

- (void)layoutBarWidth:(CGFloat)width {
    CGFloat y = 10, h = 24, gap = 8, x = 10;
    _playButton.frame = NSMakeRect(x, y, 72, h);
    x = NSMaxX(_playButton.frame) + gap;
    _speedPopup.frame = NSMakeRect(x, y, 78, h);
    x = NSMaxX(_speedPopup.frame) + gap;

    NSString *saved = _clock.stringValue;
    _clock.stringValue = @"30 Sep 2026, 12:00 pm AEDT";
    CGFloat clockW = ceil([_clock.cell cellSizeForBounds:NSMakeRect(0, 0, 800, h)].width) + 8;
    _clock.stringValue = saved ?: @"";
    if (clockW < 150) clockW = 150;

    CGFloat cluster = clockW + 28 + 120 + 28 + 176 + 92 + gap * 5;
    CGFloat timelineW = width - 10 - x - cluster;
    if (timelineW < 80) timelineW = 80;
    _timeline.frame = NSMakeRect(x, y, timelineW, h);

    CGFloat right = width - 10;
    _recenterButton.frame = NSMakeRect(right - 92, y, 92, h);
    right = NSMinX(_recenterButton.frame) - gap;
    _layerPopup.frame = NSMakeRect(right - 176, y, 176, h);
    right = NSMinX(_layerPopup.frame) - gap;
    _globeButton.frame = NSMakeRect(right - 28, y, 28, h);
    right = NSMinX(_globeButton.frame) - gap;
    _globeSlider.frame = NSMakeRect(right - 120, y, 120, h);
    right = NSMinX(_globeSlider.frame) - gap;
    _flatButton.frame = NSMakeRect(right - 28, y, 28, h);
    right = NSMinX(_flatButton.frame) - gap;
    _clock.frame = NSMakeRect(right - clockW, y, clockW, h);
    if (NSMinX(_clock.frame) < NSMaxX(_timeline.frame) + gap) {
        CGFloat fit = NSMinX(_clock.frame) - gap - NSMinX(_timeline.frame);
        if (fit < 40) fit = 40;
        NSRect timeline = _timeline.frame;
        timeline.size.width = fit;
        _timeline.frame = timeline;
    }
}

- (void)layoutChrome {
    if (!_window) return;
    NSRect bounds = _window.contentView.bounds;
    CGFloat barH = 44;
    _bar.frame = NSMakeRect(0, 0, bounds.size.width, barH);
    _stage.frame = NSMakeRect(0, barH, bounds.size.width, MAX(0, bounds.size.height - barH));
    self.map.frame = _stage.bounds;
    _unavailable.frame = NSInsetRect(_stage.bounds, 48, 48);
    [self layoutBarWidth:bounds.size.width];
    _hud.frame = NSMakeRect(10, NSHeight(_stage.bounds) - 128, 230, 112);
}

- (void)prepareMap {
    if (self.map || !_device) return;
    self.map = [[MapLabView alloc] initWithDevice:_device];
    self.map.owner = self;
    if (_stage && _hud) [_stage addSubview:self.map positioned:NSWindowBelow relativeTo:_hud];
    else if (_stage) [_stage addSubview:self.map];
}

- (void)installMenu {
    NSMenu *menubar = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    [menubar addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Map Lab"];
    [appMenu addItemWithTitle:@"Quit Map Lab" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;
    NSApp.mainMenu = menubar;
}

- (void)installKeys {
    if (_keyMonitor) return;
    __weak MapLabController *weakSelf = self;
    _keyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        MapLabController *strong = weakSelf;
        if (strong && [strong handleKey:event]) return nil;
        return event;
    }];
}

- (void)buildWindow {
    NSRect frame = NSMakeRect(0, 0, 1120, 760);
    _window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    _window.releasedWhenClosed = NO;
    _window.title = @"Map Lab";
    _window.minSize = NSMakeSize(1000, 640);
    _window.delegate = self;
    [_window.contentView addSubview:_stage];
    [_window.contentView addSubview:_bar];
    [self prepareMap];
    [self layoutChrome];
}

- (void)showUnavailable:(NSString *)error {
    [self.map stopLink];
    self.map.hidden = YES;
    _bar.hidden = YES;
    _hud.hidden = YES;
    _inspector.hidden = YES;
    _unavailable.hidden = NO;
    _unavailable.stringValue = error.length ? [NSString stringWithFormat:@"Chart unavailable\n%@", error] : @"Chart unavailable";
    _unavailable.toolTip = error;
}

- (void)showMap {
    self.map.hidden = NO;
    _bar.hidden = NO;
    _unavailable.hidden = YES;
    _hud.hidden = !self.hudOn;
    [self syncPlayChrome];
    [self syncHUD];
}

- (BOOL)loadStore:(NSString *)path error:(NSString **)error {
    if (!_device) {
        MapSetError(error, @"no Metal device");
        return NO;
    }
    [self prepareMap];
    _run = [MapRun loadStore:path device:_device error:error];
    if (!_run) return NO;
    [_run prepareDisplaySynchronous:self.synchronousContours scale:[self.map pixelScale]];
    _play = MapPlayMake(8);
    _play.lastIndex = _run.steps - 1;
    _play.stepSeconds = _run.stepSeconds;
    _camera = MapCameraMake(kSydneyLat, kSydneyLon, kDefaultZoom, 0, 480, 360);
    if (_timeline) {
        _timeline.minValue = 0;
        _timeline.maxValue = MAX(0, _play.lastIndex);
        _timeline.doubleValue = 0;
        _timeline.enabled = _run.steps > 1;
    }
    [_speedPopup selectItemWithTag:8];
    [_layerPopup selectItemWithTag:IsobarFieldPressure];
    [self syncPlayChrome];
    return YES;
}

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    (void)note;
    [self installMenu];
    [self installKeys];
    [self buildChrome];
    [self buildWindow];
    NSString *error = nil;
    NSString *path = self.storePath.length ? self.storePath : [@"~/Data/isobar" stringByExpandingTildeInPath];
    if (![self loadStore:path error:&error]) [self showUnavailable:error];
    else [self showMap];
    [self layoutChrome];
    self.renderEnabled = YES;
    [_window makeKeyAndOrderFront:nil];
    [NSApp activate];
    BOOL visible = (_window.occlusionState & NSWindowOcclusionStateVisible) != 0;
    self.map.link.paused = !visible;
    if (_run) [self renderNow];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    (void)sender;
    return YES;
}

- (void)windowDidResize:(NSNotification *)note {
    (void)note;
    _inspector.hidden = YES;
    [self layoutChrome];
    [self.map syncViewport:&_camera];
    _camera = IsobarCameraClamp(_camera);
}

- (void)windowDidChangeScreen:(NSNotification *)note {
    (void)note;
    [self mapBackingChanged];
}

- (void)windowDidChangeOcclusionState:(NSNotification *)note {
    (void)note;
    BOOL visible = (_window.occlusionState & NSWindowOcclusionStateVisible) != 0;
    self.map.link.paused = !visible;
}

- (void)speedChanged:(NSPopUpButton *)sender {
    if (_chromeWrite) return;
    if (!MapSpeedValid((int)sender.selectedTag)) return;
    _play.speed = sender.selectedTag;
}

- (void)layerChanged:(NSPopUpButton *)sender {
    if (_chromeWrite || !_run) return;
    _run.fill = (IsobarFieldKind)sender.selectedTag;
    [self invalidateMap];
}

- (void)timelineMoved:(NSSlider *)sender {
    if (_chromeWrite) return;
    NSEventType type = NSApp.currentEvent.type;
    if (type == NSEventTypeLeftMouseDown) [self beginHold];
    [self scrubTo:sender.doubleValue];
    if (type == NSEventTypeLeftMouseUp) [self endHold];
    [self invalidateMap];
}

- (void)globeSlid:(NSSlider *)sender {
    if (_chromeWrite) return;
    _morphing = NO;
    _camera.globe = sender.doubleValue;
    [self invalidateMap];
}

- (void)goFlat:(id)sender {
    (void)sender;
    [self animateGlobeTo:0 reduced:MapReduceMotion()];
}

- (void)goGlobe:(id)sender {
    (void)sender;
    [self animateGlobeTo:1 reduced:MapReduceMotion()];
}

- (void)useCameraLat:(double)lat lon:(double)lon zoom:(double)zoom globe:(double)globe {
    _camera = MapCameraMake(lat, lon, zoom, globe, self.map.fixedW, self.map.fixedH);
}

static void Note(int *fails, BOOL ok, NSString *msg) {
    if (ok) return;
    (*fails)++;
    fprintf(stderr, "map-lab self-test: FAIL %s\n", msg.UTF8String);
}

static int MapCompareDouble(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
}

static double MapPercentile(double *values, int n, double p) {
    if (n <= 0) return -1;
    qsort(values, (size_t)n, sizeof(double), MapCompareDouble);
    if (n == 1) return values[0];
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    double rank = p * (double)(n - 1);
    int i = (int)floor(rank);
    int j = i + 1 < n ? i + 1 : i;
    double t = rank - (double)i;
    return values[i] * (1.0 - t) + values[j] * t;
}

- (BOOL)insideGridLat:(double)lat lon:(double)lon {
    IsobarGeoGrid g = _run.grid;
    if (!(g.step > 0) || g.nLon < 2 || g.nLat < 2) return NO;
    double south = g.north - (g.nLat - 1) * g.step;
    double east = g.west + (g.nLon - 1) * g.step;
    const double pad = 0.05;
    if (!isfinite(lat) || !isfinite(lon)) return NO;
    if (lat > g.north - pad || lat < south + pad) return NO;
    if (!g.wrapsLongitude && (lon < g.west + pad || lon > east - pad)) return NO;
    return YES;
}

- (BOOL)outsideGridLat:(double)lat lon:(double)lon {
    IsobarGeoGrid g = _run.grid;
    if (!(g.step > 0) || g.nLon < 2 || g.nLat < 2) return NO;
    double south = g.north - (g.nLat - 1) * g.step;
    double east = g.west + (g.nLon - 1) * g.step;
    const double pad = 0.05;
    if (!isfinite(lat) || !isfinite(lon) || lat > 85 || lat < -85) return NO;
    if (lat > g.north + pad || lat < south - pad) return YES;
    if (!g.wrapsLongitude && (lon < g.west - pad || lon > east + pad)) return YES;
    return NO;
}

- (BOOL)findOutsideCoverageX:(double *)x y:(double *)y {
    [self syncViewport];
    int w = (int)llround(_camera.viewportW);
    int h = (int)llround(_camera.viewportH);
    if (w < 4 || h < 4) return NO;
    int sx = MAX(1, w / 28);
    int sy = MAX(1, h / 20);
    BOOL found = NO;
    double best = 1e9;
    for (int py = 1; py < h - 1; py += sy) {
        for (int px = 1; px < w - 1; px += sx) {
            double lat = 0, lon = 0;
            if (!IsobarCameraUnproject(_camera, px, py, &lat, &lon)) continue;
            if (![self outsideGridLat:lat lon:lon]) continue;
            double score = fabs((double)py - h * 0.5);
            if (!found || score < best) {
                best = score;
                *x = px;
                *y = py;
                found = YES;
            }
        }
    }
    return found;
}

- (BOOL)findOffGlobeX:(double *)x y:(double *)y {
    [self syncViewport];
    int w = (int)llround(_camera.viewportW);
    int h = (int)llround(_camera.viewportH);
    if (w < 2 || h < 2) return NO;
    int sx = MAX(1, w / 28);
    int sy = MAX(1, h / 20);
    for (int py = 0; py < h; py += sy) {
        for (int px = 0; px < w; px += sx) {
            double lat = 0, lon = 0;
            if (!IsobarCameraUnproject(_camera, px + 0.5, py + 0.5, &lat, &lon)) {
                *x = px + 0.5;
                *y = py + 0.5;
                return YES;
            }
        }
    }
    return NO;
}

- (int)exerciseStore:(NSString *)store report:(NSMutableDictionary *)report {
    int fails = 0;
    [self buildChrome];
    [self prepareMap];
    [self layoutBarWidth:1000];
    NSArray<NSView *> *row = @[_playButton, _speedPopup, _timeline, _clock, _flatButton, _globeSlider, _globeButton, _layerPopup, _recenterButton];
    CGFloat prev = 0;
    for (NSView *view in row) {
        Note(&fails, NSMinX(view.frame) >= prev - 0.5, [NSString stringWithFormat:@"control overlap %@", view]);
        Note(&fails, NSMaxX(view.frame) <= 1000.5, @"controls fit the bar");
        prev = NSMaxX(view.frame);
    }
    Note(&fails, _timeline.frame.size.width >= 100, @"timeline has room beside the speed");
    Note(&fails, NSMinX(_speedPopup.frame) >= NSMaxX(_playButton.frame) - 0.5
        && NSMinX(_speedPopup.frame) - NSMaxX(_playButton.frame) < 24, @"speed sits beside play");
    Note(&fails, _speedPopup.selectedTag == 8, @"default speed is 8×");
    Note(&fails, !_hud.hidden, @"HUD starts visible");
    Note(&fails, [self handleCommand:@"h" modifiers:0 repeat:NO] && _hud.hidden, @"H hides the HUD");
    Note(&fails, [self handleCommand:@"h" modifiers:0 repeat:NO] && !_hud.hidden, @"H shows the HUD");

    NSString *error = nil;
    if (![self loadStore:store error:&error]) {
        Note(&fails, NO, error ?: @"store did not load");
        return fails;
    }
    Note(&fails, _run.steps >= 2 && _run.stepSeconds > 0,
        [NSString stringWithFormat:@"run has %ld steps %.0f s apart", (long)_run.steps, _run.stepSeconds]);
    Note(&fails, _run.renderer.motion != nil, @"the run keeps one label motion");
    Note(&fails, _run.renderer.synchronousContours == self.synchronousContours, @"contour sync matches the mode");
    [self.map usePixelsWide:480 high:360];
    self.renderEnabled = NO;
    double lat = _run.grid.north - (_run.grid.nLat - 1) * _run.grid.step * 0.5;
    double lon = _run.grid.west + (_run.grid.nLon - 1) * _run.grid.step * 0.5;
    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    double drag = [self anchorErrorFromX:200 y:160 toX:270 y:210];
    report[@"drag_px"] = @(drag);
    Note(&fails, drag >= 0 && drag <= 1, [NSString stringWithFormat:@"flat drag %.4f px", drag]);

    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    double pinch = [self pinchErrorFactor:1.35 atX:300 y:150];
    report[@"pinch_px"] = @(pinch);
    Note(&fails, pinch >= 0 && pinch <= 1, [NSString stringWithFormat:@"pinch %.4f px", pinch]);

    [self useCameraLat:lat lon:lon zoom:4 globe:1];
    double globeDrag = [self anchorErrorFromX:240 y:180 toX:264 y:192];
    report[@"globe_drag_px"] = @(globeDrag);
    Note(&fails, globeDrag >= 0 && globeDrag <= 1, [NSString stringWithFormat:@"globe drag %.4f px", globeDrag]);

    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    double keepLat = _camera.centreLat, keepLon = _camera.centreLon, keepZoom = _camera.zoom;
    [self animateGlobeTo:1 reduced:NO];
    for (int i = 0; i < 6; i++) [self advance:0.1];
    report[@"morph_dlat"] = @(fabs(_camera.centreLat - keepLat));
    report[@"morph_dlon"] = @(fabs(_camera.centreLon - keepLon));
    report[@"morph_dzoom"] = @(fabs(_camera.zoom - keepZoom));
    Note(&fails, !_morphing && fabs(_camera.globe - 1) < 1e-9, @"morph reaches the globe");
    Note(&fails, fabs(_camera.centreLat - keepLat) < 1e-12 && fabs(_camera.centreLon - keepLon) < 1e-12
        && fabs(_camera.zoom - keepZoom) < 1e-12, @"morph keeps the geographic centre and scale");
    [self animateGlobeTo:0 reduced:YES];
    Note(&fails, !_morphing && _camera.globe == 0, @"reduced motion jumps to flat");
    Note(&fails, fabs(_camera.centreLat - keepLat) < 1e-12, @"reduced motion keeps the centre");

    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    [self pointerDownX:240 y:180];
    [self pointerDragX:300 y:200];
    [self pointerDragX:242 y:182];
    NSString *notClick = [self pointerUpX:242 y:182];
    Note(&fails, notClick == nil, @"a drag is not a click");

    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    [self syncViewport];
    double cx = _camera.viewportW * 0.5, cy = _camera.viewportH * 0.5;
    double sampleLat = 0, sampleLon = 0;
    BOOL sampleOn = IsobarCameraUnproject(_camera, cx, cy, &sampleLat, &sampleLon);
    Note(&fails, sampleOn && [self insideGridLat:sampleLat lon:sampleLon], @"the inspect point is inside the grid");
    _play.index = 0;
    self.renderEnabled = YES;
    IsobarFieldMotion *motion = _run.renderer.motion;
    [self pointerDownX:cx y:cy];
    NSString *click = [self pointerUpX:cx y:cy];
    report[@"click"] = click ?: @"";
    report[@"labels"] = @(_run.renderer.labelCount);
    report[@"centres"] = @(_run.renderer.centreCount);
    report[@"drawable"] = @(self.map.drawablePixelFormat);
    Note(&fails, click.length && [click containsString:@"hPa"] && [click containsString:@"ECMWF IFS"]
        && [click rangeOfString:@"No data here"].location == NSNotFound, @"click shows the pressure reading");
    NSString *when = [self timeText];
    Note(&fails, when.length && [click containsString:when], @"click shows the valid time");
    if (_run.published) {
        Note(&fails, _run.renderer.labelCount > 0,
            [NSString stringWithFormat:@"published run draws %ld labels", (long)_run.renderer.labelCount]);
    }
    Note(&fails, motion != nil && motion == _run.renderer.motion, @"labels keep the same motion");

    [self useCameraLat:lat lon:lon zoom:1 globe:0];
    _camera = IsobarCameraClamp(_camera);
    double nx = 0, ny = 0;
    BOOL foundOutside = [self findOutsideCoverageX:&nx y:&ny];
    Note(&fails, foundOutside, @"a pixel lies outside the loaded grid");
    NSString *outside = nil;
    if (foundOutside) {
        [self pointerDownX:nx y:ny];
        outside = [self pointerUpX:nx y:ny];
    }
    report[@"nodata"] = outside ?: @"";
    Note(&fails, [outside containsString:@"No data here"] && [outside containsString:@"ECMWF IFS"]
        && [outside rangeOfString:@"hPa"].location == NSNotFound,
        [NSString stringWithFormat:@"outside the grid says there is no data (%@)",
            [outside stringByReplacingOccurrencesOfString:@"\n" withString:@" | "] ?: @"-"]);
    [self useCameraLat:lat lon:lon zoom:1 globe:1];
    _camera = IsobarCameraClamp(_camera);
    double ox = 0, oy = 0;
    BOOL foundOff = [self findOffGlobeX:&ox y:&oy];
    Note(&fails, foundOff, @"a pixel misses the globe");
    NSString *offEarth = nil;
    if (foundOff) {
        [self pointerDownX:ox y:oy];
        offEarth = [self pointerUpX:ox y:oy];
    }
    Note(&fails, [offEarth isEqualToString:@"No data here"],
        [NSString stringWithFormat:@"off the globe says there is no data (%@)", offEarth ?: @"-"]);
    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    [self syncViewport];
    cx = _camera.viewportW * 0.5;
    cy = _camera.viewportH * 0.5;

    _run.fill = IsobarFieldRain;
    [self pointerDownX:cx y:cy];
    NSString *rain = [self pointerUpX:cx y:cy];
    if ([rain containsString:@"No data here"]) {
        Note(&fails, [rain containsString:@"ECMWF IFS"] && [rain rangeOfString:@"mm"].location == NSNotFound,
            @"missing rain is not invented");
    } else {
        Note(&fails, [rain containsString:@"mm"] && [rain containsString:@"ECMWF IFS"]
            && [rain rangeOfString:@"No data here"].location == NSNotFound,
            @"rain on the grid names the unit and source");
    }
    _run.fill = IsobarFieldPressure;
    [self.map waitForPresented];
    [_gpuLock lock];
    _gpuSum = 0;
    _gpuFrames = 0;
    [_gpuLock unlock];
    // A hidden self-test is not a visible window, so the main thread would
    // otherwise sit on an efficiency core. Playback in the app runs at the
    // interactive class. Measure that.
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);

    double camLat = _camera.centreLat, camLon = _camera.centreLon, camZoom = _camera.zoom;
    _morphing = NO;
    _play = MapPlayMake(8);
    _play.lastIndex = _run.steps - 1;
    _play.stepSeconds = _run.stepSeconds;
    double contourMax = 0, labelMax = 0, encodeOnlyMax = 0;
    int frames = 0;
    double samples[240];
    int nSamples = 0;
    double maxMs = 0;
    double sync256Max = 0;
    CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
    for (int i = 0; i < 120; i++) {
        if (![self displayTick:1.0 / 60.0]) {
            Note(&fails, NO, _status ?: @"8× frame failed");
            break;
        }
        double ms = self.map.lastEncodeMilliseconds;
        if (nSamples < 240) samples[nSamples++] = ms;
        if (ms > maxMs) maxMs = ms;
        if (self.map.lastEncodeOnlyMilliseconds > encodeOnlyMax) encodeOnlyMax = self.map.lastEncodeOnlyMilliseconds;
        if (_lastContour > contourMax) contourMax = _lastContour;
        if (_run.renderer.lastLabelMilliseconds > labelMax) labelMax = _run.renderer.lastLabelMilliseconds;
        frames++;
    }
    double play8 = _play.index;
    double expect8 = MapPlayIndexAfter(120, 1.0 / 60.0, 8, _run.steps - 1, _run.stepSeconds);
    report[@"play8"] = @(play8);
    report[@"expect8"] = @(expect8);
    Note(&fails, fabs(play8 - expect8) < 1e-4,
        [NSString stringWithFormat:@"8× playhead %.6f expected %.6f (%ld steps, %.0f s)",
            play8, expect8, (long)_run.steps, _run.stepSeconds]);
    Note(&fails, fabs(_camera.centreLat - camLat) < 1e-12 && fabs(_camera.centreLon - camLon) < 1e-12
        && fabs(_camera.zoom - camZoom) < 1e-12, @"playback leaves the camera where it is");

    _play = MapPlayMake(256);
    _play.lastIndex = _run.steps - 1;
    _play.stepSeconds = _run.stepSeconds;
    for (int i = 0; i < 120; i++) {
        if (![self displayTick:1.0 / 60.0]) {
            Note(&fails, NO, _status ?: @"256× frame failed");
            break;
        }
        double ms = self.map.lastEncodeMilliseconds;
        if (nSamples < 240) samples[nSamples++] = ms;
        if (ms > maxMs) maxMs = ms;
        if (ms > sync256Max) sync256Max = ms;
        if (self.map.lastEncodeOnlyMilliseconds > encodeOnlyMax) encodeOnlyMax = self.map.lastEncodeOnlyMilliseconds;
        if (_lastContour > contourMax) contourMax = _lastContour;
        if (_run.renderer.lastLabelMilliseconds > labelMax) labelMax = _run.renderer.lastLabelMilliseconds;
        frames++;
    }
    double play256 = _play.index;
    double expect256 = MapPlayIndexAfter(120, 1.0 / 60.0, 256, _run.steps - 1, _run.stepSeconds);
    report[@"play256"] = @(play256);
    report[@"expect256"] = @(expect256);
    Note(&fails, fabs(play256 - expect256) < 1e-4,
        [NSString stringWithFormat:@"256× playhead %.6f expected %.6f", play256, expect256]);
    [self.map waitForPresented];
    [_gpuLock lock];
    double gpuAvg = _gpuFrames > 0 ? _gpuSum / _gpuFrames : -1;
    [_gpuLock unlock];
    CFAbsoluteTime wall = CFAbsoluteTimeGetCurrent() - t0;
    double sorted[240];
    double p50 = -1, p95 = -1;
    if (nSamples > 0) {
        memcpy(sorted, samples, (size_t)nSamples * sizeof(double));
        p50 = MapPercentile(sorted, nSamples, 0.50);
        memcpy(sorted, samples, (size_t)nSamples * sizeof(double));
        p95 = MapPercentile(sorted, nSamples, 0.95);
    }
    report[@"frame_p50"] = @(p50);
    report[@"frame_p95"] = @(p95);
    report[@"frame_max"] = @(maxMs);
    report[@"sync256_max"] = @(sync256Max);
    report[@"gpu_ms_avg"] = @(gpuAvg);
    report[@"contour_ms_max"] = @(contourMax);
    report[@"label_ms_max"] = @(labelMax);
    report[@"encode_only_max"] = @(encodeOnlyMax);
    report[@"residentBytes"] = @(_run.renderer.residentBytes);
    report[@"wall_s"] = @(wall);
    report[@"frames"] = @(frames);
    report[@"steps"] = @(_run.steps);
    report[@"step_s"] = @(_run.stepSeconds);
    Note(&fails, frames == 240, @"120 ticks at 8× and 120 at 256×");
    // Synchronous contours are not the app. The numbers above are recorded;
    // the 16 ms cap applies to the async pass below.
    // The interactive app traces off the main thread. This pass is that path:
    // 600 ticks at 256×, publishes drained on the run loop, labels on screen,
    // and a 16 ms main-thread cap.
    BOOL savedSync = self.synchronousContours;
    self.synchronousContours = NO;
    _run.renderer.synchronousContours = NO;
    [self useCameraLat:lat lon:lon zoom:4 globe:0];
    _play = MapPlayMake(256);
    _play.lastIndex = _run.steps - 1;
    _play.stepSeconds = _run.stepSeconds;
    // One untimed frame settles the new camera. The 600 ticks are playback.
    [self displayTick:1.0 / 60.0];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, false);
    double asyncSamples[600];
    int asyncN = 0;
    double asyncMax = 0, asyncLabel = 0;
    BOOL asyncLabels = NO;
    for (int i = 0; i < 600; i++) {
        if (![self displayTick:1.0 / 60.0]) {
            Note(&fails, NO, _status ?: @"async frame failed");
            break;
        }
        double ms = self.map.lastEncodeMilliseconds;
        asyncSamples[asyncN++] = ms;
        if (ms > asyncMax) asyncMax = ms;
        if (_run.renderer.lastLabelMilliseconds > asyncLabel) asyncLabel = _run.renderer.lastLabelMilliseconds;
        if (_run.renderer.labelCount > 0) asyncLabels = YES;
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, false);
    }
    double asyncP95 = -1;
    if (asyncN > 0) {
        double asyncSorted[600];
        memcpy(asyncSorted, asyncSamples, (size_t)asyncN * sizeof(double));
        asyncP95 = MapPercentile(asyncSorted, asyncN, 0.95);
    }
    report[@"async_frames"] = @(asyncN);
    report[@"async_frame_max"] = @(asyncMax);
    report[@"async_frame_p95"] = @(asyncP95);
    report[@"async_label_ms_max"] = @(asyncLabel);
    report[@"async_labels"] = @(asyncLabels ? _run.renderer.labelCount : 0);
    Note(&fails, asyncN == 600 && asyncMax <= 16.0,
        [NSString stringWithFormat:@"async 256× main-thread p95 %.2f max %.2f ms (%d frames)",
            asyncP95, asyncMax, asyncN]);
    Note(&fails, asyncLabels, @"async playback draws labels");
    self.synchronousContours = savedSync;
    _run.renderer.synchronousContours = savedSync;
    Note(&fails, _run.renderer.residentBytes > 0, @"the field stays resident");
    Note(&fails, motion == _run.renderer.motion, @"playback does not reset label motion");

    self.renderEnabled = NO;
    double held = _play.index;
    [self beginHold];
    [self advance:1];
    Note(&fails, fabs(_play.index - held) < 1e-12, @"timeline hold freezes the playhead");
    [self endHold];
    Note(&fails, _play.playing, @"release resumes playback");
    [self beginHold];
    [self handleCommand:@" " modifiers:0 repeat:NO];
    [self endHold];
    Note(&fails, !_play.playing, @"space during a hold pauses");
    _play.playing = YES;

    double globe = 0.35;
    _camera.globe = globe;
    [self recenter];
    Note(&fails, fabs(_camera.centreLat - kSydneyLat) < 1e-12 && fabs(_camera.centreLon - kSydneyLon) < 1e-9
        && _camera.zoom == kDefaultZoom && fabs(_camera.globe - globe) < 1e-12,
        @"recenter returns to Sydney without changing the globe");

    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    _play.index = 0;
    _play.lastIndex = _run.steps - 1;
    [self handleCommand:@" " modifiers:0 repeat:NO];
    Note(&fails, !_play.playing, @"space pauses");
    unichar right = NSRightArrowFunctionKey;
    NSString *rightKey = [NSString stringWithCharacters:&right length:1];
    [self handleCommand:rightKey modifiers:0 repeat:NO];
    Note(&fails, fabs(_play.index - 1) < 1e-9, @"right arrow steps one frame");
    unichar left = NSLeftArrowFunctionKey;
    NSString *leftKey = [NSString stringWithCharacters:&left length:1];
    [self handleCommand:leftKey modifiers:0 repeat:NO];
    Note(&fails, fabs(_play.index) < 1e-9, @"left arrow steps back");

    self.renderEnabled = NO;
    [self useCameraLat:70 lon:lon zoom:6 globe:0];
    [self syncViewport];
    double midX = _camera.viewportW * 0.5, midY = _camera.viewportH * 0.5;
    [self pointerDownX:midX y:midY];
    [self pointerDragX:midX y:_camera.viewportH - 2];
    IsobarCamera clamped = IsobarCameraClamp(_camera);
    Note(&fails, fabs(_camera.centreLat - clamped.centreLat) < 1e-9
        && fabs(_camera.zoom - clamped.zoom) < 1e-9, @"a flat drag stays inside the pole clamp");
    double poleX = 0, poleY = 0;
    BOOL pole = IsobarCameraProject(_camera, 90, _camera.centreLon, &poleX, &poleY);
    Note(&fails, pole && poleY <= 1.0,
        [NSString stringWithFormat:@"flat drag keeps the north pole out (y %.2f)", poleY]);
    [self useCameraLat:lat lon:lon zoom:6 globe:0];
    [self pinchFactor:0.05 atX:midX y:midY];
    clamped = IsobarCameraClamp(_camera);
    Note(&fails, fabs(_camera.zoom - clamped.zoom) < 1e-6
        && fabs(_camera.centreLat - clamped.centreLat) < 1e-6, @"a pinch stays inside the pole clamp");
    [self useCameraLat:80 lon:lon zoom:2 globe:0];
    [self panFromX:midX y:midY - 40 toX:midX y:midY + 80];
    clamped = IsobarCameraClamp(_camera);
    Note(&fails, fabs(_camera.centreLat - clamped.centreLat) < 1e-6
        && fabs(_camera.zoom - clamped.zoom) < 1e-6, @"a scroll stays inside the pole clamp");
    return fails;
}

@end

static int MapPureChecks(void) {
    int fails = 0;
    Note(&fails, MapEaseInOut(0) == 0 && MapEaseInOut(1) == 1, @"ease hits the ends");
    Note(&fails, fabs(MapEaseInOut(0.5) - 0.5) < 1e-12, @"ease is halfway at mid time");
    Note(&fails, MapEaseInOut(0.25) < 0.25, @"ease starts slowly");
    Note(&fails, fabs(MapGlobeAt(0, 1, 0.3, kMapMorphSeconds, 0) - 0.5) < 1e-12, @"0.6 s morph is mid-way at 0.3 s");
    Note(&fails, MapGlobeAt(0.2, 1, 0, kMapMorphSeconds, 1) == 1, @"reduced motion is instant");
    Note(&fails, MapPointerIsClick(0, 0, 4) && MapPointerIsClick(3, 0, 4) && !MapPointerIsClick(5, 0, 4),
        @"a drag past the slop is not a click");
    Note(&fails, MapSpeedValid(1) && MapSpeedValid(8) && MapSpeedValid(256) && !MapSpeedValid(7), @"speed steps");
    Note(&fails, [MapSpeedTitle(8) isEqualToString:@"8×"] && [MapSpeedTitle(256) isEqualToString:@"256×"], @"speed reads as a multiplier");

    NSString *reading = MapInspectorText(YES, 1013.24, IsobarFieldPressure, @"4 Oct 2026, 11:00 pm AEDT");
    Note(&fails, [reading containsString:@"1013.2 hPa"] && [reading containsString:@"ECMWF IFS"]
        && [reading rangeOfString:@"No data here"].location == NSNotFound, @"a pressure reading names the unit and source");
    Note(&fails, [MapInspectorText(NO, 0, IsobarFieldRain, @"x") isEqualToString:@"No data here"], @"off the earth is no data");
    NSString *hole = MapInspectorText(YES, NAN, IsobarFieldRain, @"4 Oct 2026, 11:00 pm AEDT");
    Note(&fails, [hole containsString:@"No data here"] && [hole containsString:@"ECMWF IFS"]
        && [hole rangeOfString:@"mm"].location == NSNotFound, @"a missing sample is not zero");

    IsobarCamera cam = MapCameraMake(-35, 140, 6, 0, 480, 360);
    double lat = 0, lon = 0;
    Note(&fails, IsobarCameraUnproject(cam, 200, 160, &lat, &lon), @"flat unproject");
    IsobarCamera moved = cam;
    Note(&fails, MapCameraAnchor(&moved, lat, lon, 270, 210), @"flat anchor solves");
    double px = 0, py = 0;
    Note(&fails, IsobarCameraProject(moved, lat, lon, &px, &py) && hypot(px - 270, py - 210) <= 1, @"flat anchor stays within 1 px");
    Note(&fails, moved.zoom == cam.zoom && moved.globe == cam.globe, @"anchor keeps zoom and globe");

    IsobarCamera globe = MapCameraMake(-35, 140, 4, 1, 480, 360);
    Note(&fails, IsobarCameraUnproject(globe, 240, 180, &lat, &lon), @"globe unproject");
    IsobarCamera spun = globe;
    Note(&fails, MapCameraAnchor(&spun, lat, lon, 268, 196), @"globe anchor solves");
    Note(&fails, IsobarCameraProject(spun, lat, lon, &px, &py) && hypot(px - 268, py - 196) <= 1, @"globe anchor stays within 1 px");

    IsobarCamera zoomed = MapCameraMake(-35, 140, 6, 0, 480, 360);
    Note(&fails, IsobarCameraUnproject(zoomed, 300, 150, &lat, &lon), @"pinch unproject");
    zoomed.zoom = MapClampZoom(zoomed.zoom * 1.35);
    Note(&fails, MapCameraAnchor(&zoomed, lat, lon, 300, 150), @"pinch anchor solves");
    Note(&fails, IsobarCameraProject(zoomed, lat, lon, &px, &py) && hypot(px - 300, py - 150) <= 1, @"pinch keeps the gesture point");

    MapPlay slow = MapPlayMake(8);
    slow.lastIndex = 1;
    slow.stepSeconds = 10800;
    for (int i = 0; i < 120; i++) MapPlayAdvance(&slow, 1.0 / 60.0);
    Note(&fails, fabs(slow.index - (120.0 * 8.0 / 10800.0)) < 1e-6, @"8× advances one forecast minute per real second");
    MapPlay fast = MapPlayMake(256);
    fast.lastIndex = 1;
    fast.stepSeconds = 10800;
    for (int i = 0; i < 120; i++) MapPlayAdvance(&fast, 1.0 / 60.0);
    double dir = 0;
    double bounced = MapPingPong(120.0 * 256.0 / 10800.0, 1, &dir);
    Note(&fails, fabs(fast.index - bounced) < 1e-5 && dir > 0, @"256× runs to the end and back");
    double frozen = fast.index;
    fast.holding = 1;
    MapPlayAdvance(&fast, 5);
    Note(&fails, fast.index == frozen, @"holding does not advance");
    return fails;
}

static const char *MapPixelFormatName(NSUInteger fmt) {
    switch (fmt) {
    case MTLPixelFormatBGRA8Unorm: return "BGRA8Unorm";
    case MTLPixelFormatBGRA8Unorm_sRGB: return "BGRA8Unorm_sRGB";
    case MTLPixelFormatRGBA8Unorm: return "RGBA8Unorm";
    case MTLPixelFormatRGBA8Unorm_sRGB: return "RGBA8Unorm_sRGB";
    default: return "other";
    }
}

static int MapLabSelfTest(NSString *store) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        app.activationPolicy = NSApplicationActivationPolicyProhibited;
        printf("map-lab self-test\n");
        fflush(stdout);
        int fails = MapPureChecks();
        MapLabController *controller = [MapLabController new];
        // The app leaves this at the renderer default (one-frame lag). The
        // self-test traces before encode returns so labels are the frame's own.
        controller.synchronousContours = YES;
        NSMutableDictionary *report = [NSMutableDictionary dictionary];
        fails += [controller exerciseStore:store report:report];
        NSString *clickLine = [report[@"click"] stringByReplacingOccurrencesOfString:@"\n" withString:@" | "];
        NSString *nodataLine = [report[@"nodata"] stringByReplacingOccurrencesOfString:@"\n" withString:@" | "];
        printf("drag_px %.6f\n", [report[@"drag_px"] doubleValue]);
        printf("pinch_px %.6f\n", [report[@"pinch_px"] doubleValue]);
        printf("globe_drag_px %.6f\n", [report[@"globe_drag_px"] doubleValue]);
        printf("morph_dlat %.6f morph_dlon %.6f morph_dzoom %.6f\n",
            [report[@"morph_dlat"] doubleValue], [report[@"morph_dlon"] doubleValue], [report[@"morph_dzoom"] doubleValue]);
        printf("click %s\n", clickLine.UTF8String ?: "-");
        printf("nodata %s\n", nodataLine.UTF8String ?: "-");
        printf("play8 %.6f expect8 %.6f\n", [report[@"play8"] doubleValue], [report[@"expect8"] doubleValue]);
        printf("play256 %.6f expect256 %.6f\n", [report[@"play256"] doubleValue], [report[@"expect256"] doubleValue]);
        printf("steps %.0f step_s %.0f\n", [report[@"steps"] doubleValue], [report[@"step_s"] doubleValue]);
        printf("labels %.0f centres %.0f\n", [report[@"labels"] doubleValue], [report[@"centres"] doubleValue]);
        printf("frames %.0f\n", [report[@"frames"] doubleValue]);
        printf("frame_cpu_ms p50 %.3f p95 %.3f max %.3f sync256_max %.3f\n",
            [report[@"frame_p50"] doubleValue], [report[@"frame_p95"] doubleValue],
            [report[@"frame_max"] doubleValue], [report[@"sync256_max"] doubleValue]);
        printf("gpu_ms_avg %.3f\n", [report[@"gpu_ms_avg"] doubleValue]);
        printf("contour_ms_max %.3f label_ms_max %.3f encode_only_max %.3f\n",
            [report[@"contour_ms_max"] doubleValue], [report[@"label_ms_max"] doubleValue],
            [report[@"encode_only_max"] doubleValue]);
        printf("async_frames %.0f async_p95 %.3f async_max %.3f async_label_ms_max %.3f async_labels %.0f\n",
            [report[@"async_frames"] doubleValue], [report[@"async_frame_p95"] doubleValue],
            [report[@"async_frame_max"] doubleValue], [report[@"async_label_ms_max"] doubleValue],
            [report[@"async_labels"] doubleValue]);
        printf("residentBytes %.0f\n", [report[@"residentBytes"] doubleValue]);
        printf("drawable %s\n", MapPixelFormatName((NSUInteger)[report[@"drawable"] unsignedIntegerValue]));
        printf("wall_s %.3f\n", [report[@"wall_s"] doubleValue]);
        fflush(stdout);
        if (fails) {
            fprintf(stderr, "map-lab self-test: FAIL %d\n", fails);
            return 1;
        }
        printf("map-lab self-test: ok\n");
        fflush(stdout);
        return 0;
    }
}

static NSString *gStorePath;
static MapLabController *gController;

int main(int argc, char **argv) {
    @autoreleasepool {
        NSString *store = [@"~/Data/isobar" stringByExpandingTildeInPath];
        BOOL selftest = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--selftest") == 0) selftest = YES;
            else if (strcmp(argv[i], "--store") == 0 && i + 1 < argc)
                store = [NSString stringWithUTF8String:argv[++i]];
            else {
                fprintf(stderr, "usage: MapLab [--store DIR] [--selftest]\n");
                return 2;
            }
        }
        if (selftest) return MapLabSelfTest(store);
        MapInstallCoast();
        gStorePath = store;
        NSApplication *app = [NSApplication sharedApplication];
        gController = [MapLabController new];
        gController.storePath = gStorePath;
        app.delegate = gController;
        app.activationPolicy = NSApplicationActivationPolicyRegular;
        [app run];
    }
    return 0;
}
