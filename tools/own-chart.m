// Prototype Bureau-style MSLP renderer. Foundation, CoreGraphics and AppKit only.
// Run from the repo root: build/own-chart
#import "ownchart.h"
#import "pure.h"
#import "ownrender.h"
#import <AppKit/AppKit.h>
#ifndef ISOBAR_APP
#import <ImageIO/ImageIO.h>
#endif
#import <math.h>
#import <pthread.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>

static const int kPanelW = 580;
static const int kTitleH = 26;
static const int kMapH = 444;
static const int kPanelH = 470;
// Drawn window. The fetched grid is 95–170°E, 0–50°S. This inset fills the
// Lambert frame the way the Bureau prognosis does. Australia stays inside;
// Sumatra and the far Tasman do not.
static const double kViewWest = 108.0;
static const double kViewEast = 162.0;
static const double kViewSouth = -45.5;
static const double kViewNorth = -5.0;
// Bureau convention: hatch at 1 mm in the 24 h to the chart time. Ocean drizzle
// stays quiet because the stroke is thin, widely spaced, and about 40% ink.
static const double kRainMm = 1.0;
static const double kHatchWidth = 0.55;
static const int kHatchSpacing = 16;
static const double kHatchAlpha = 0.40;

// Published runs are immutable between collector publications. Keep a few
// parsed runs alive so a refresh that only changed the pointer does not decode
// the same 33-frame cube again. The key still includes every input file's
// metadata, so an in-place correction (or a changed coast file) drops through
// to the loader. Failed loads are never inserted.
static const NSUInteger kPublishedRunCacheLimit = 4;
static NSCache<NSString *, OwnRun *> *PublishedRunCache(void) {
    static NSCache<NSString *, OwnRun *> *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        cache = [NSCache new];
        cache.countLimit = kPublishedRunCacheLimit;
    });
    return cache;
}

static NSString *PublishedFileStamp(NSString *path) {
    struct stat info;
    if (!path.length || stat(path.fileSystemRepresentation,&info)!=0)
        return [NSString stringWithFormat:@"%@|missing",path];
    // ctime also catches a same-size edit whose publisher restores its mtime.
    return [NSString stringWithFormat:@"%@|%llu|%llu|%lld.%09ld|%lld.%09ld",path,
        (unsigned long long)info.st_size,(unsigned long long)info.st_ino,
        (long long)info.st_mtimespec.tv_sec,info.st_mtimespec.tv_nsec,
        (long long)info.st_ctimespec.tv_sec,info.st_ctimespec.tv_nsec];
}

static NSString *PublishedDirectoryStamp(NSString *directory) {
    NSDirectoryEnumerator *enumerator = [[NSFileManager defaultManager]
        enumeratorAtPath:directory];
    NSMutableArray<NSString *> *stamps = [NSMutableArray array];
    for (NSString *relative in enumerator) {
        NSString *path = [directory stringByAppendingPathComponent:relative];
        BOOL isDirectory = NO;
        if ([[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDirectory] && !isDirectory)
            [stamps addObject:PublishedFileStamp(path)];
    }
    [stamps sortUsingSelector:@selector(compare:)];
    return [stamps componentsJoinedByString:@"\n"];
}

// The manifest's window. Until a run is loaded these fall back to the 0.25° constants.
// Geometry helpers are used deep in the renderer. Keep their active grid on
// the calling thread: a background prewarm may load/render another product
// while the main thread is painting a run with different dimensions.
static _Thread_local double gWest, gNorth, gStep;
static _Thread_local int gNLon, gNLat, gGridReady;

static double GWest(void) { return gGridReady ? gWest : OwnGridWest (); }
static double GNorth(void) { return gGridReady ? gNorth : OwnGridNorth (); }
static double GStep(void) { return gGridReady ? gStep : OwnGridStep (); }
static int GNLon(void) { return gGridReady ? gNLon : OwnGridNLon (); }
static int GNLat(void) { return gGridReady ? gNLat : OwnGridNLat (); }

enum { VarMSLP, VarT850, VarT2M, VarWSpd, VarWDir, VarRain, VarCount };

typedef struct {
    int nLon, nLat, nHours, nPoints;
    double west, north, step;
    int64_t *times;
    float *data;
    NSTimeInterval fetched;
    char httpDate[64];
} Cube;

static void AdoptCubeGrid(const Cube *cube) {
    if (!cube || cube->step <= 0 || cube->nLon < 2 || cube->nLat < 2) return;
    gWest = cube->west;
    gNorth = cube->north;
    gStep = cube->step;
    gNLon = cube->nLon;
    gNLat = cube->nLat;
    gGridReady = 1;
}

static void CubeFree(Cube *cube) {
    free(cube->times);
    free(cube->data);
    *cube = (Cube){0};
}

static float CubeAt(const Cube *cube, int var, int point, int hour) {
    size_t index = ((size_t)var * (size_t)cube->nPoints + (size_t)point) * (size_t)cube->nHours + (size_t)hour;
    return cube->data[index];
}

static float CubeAtFraction(const Cube *cube, int var, int point, double hour) {
    if (!cube || point < 0 || point >= cube->nPoints || !isfinite(hour) || hour < 0 || hour > cube->nHours - 1) return NAN;
    int lo = (int)floor(hour);
    int hi = lo < cube->nHours - 1 ? lo + 1 : lo;
    double t = hour - lo;
    float a = CubeAt(cube, var, point, lo);
    if (hi == lo || t <= 0) return a;
    float b = CubeAt(cube, var, point, hi);
    if (!isfinite(a) || !isfinite(b)) return NAN;
    if (var == VarWSpd || var == VarWDir) {
        float speedA = CubeAt(cube, VarWSpd, point, lo), speedB = CubeAt(cube, VarWSpd, point, hi);
        float dirA = CubeAt(cube, VarWDir, point, lo), dirB = CubeAt(cube, VarWDir, point, hi);
        if (!isfinite(speedA) || !isfinite(speedB) || !isfinite(dirA) || !isfinite(dirB)) return NAN;
        double rad = M_PI / 180.0;
        double ua = -speedA * sin(dirA * rad), va = -speedA * cos(dirA * rad);
        double ub = -speedB * sin(dirB * rad), vb = -speedB * cos(dirB * rad);
        double u = ua + (ub - ua) * t, v = va + (vb - va) * t;
        if (var == VarWSpd) return hypot(u, v);
        double direction = atan2(-u, -v) / rad;
        return direction < 0 ? direction + 360 : direction;
    }
    return a + (b - a) * t;
}

#ifndef ISOBAR_APP
static NSData *HTTPGet(NSString *urlString, NSInteger *status, NSString **dateHeader) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) return nil;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.timeoutInterval = 180;
    [request setValue:@"isobar-own-chart/0.1" forHTTPHeaderField:@"User-Agent"];
    __block NSData *body = nil;
    __block NSInteger code = 0;
    __block NSString *date = nil;
    dispatch_semaphore_t gate = dispatch_semaphore_create(0);
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = 180;
    config.timeoutIntervalForResource = 300;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
    NSURLSessionDataTask *task = [session dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if (!error) body = data;
            if ([response isKindOfClass:NSHTTPURLResponse.class]) {
                NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
                code = http.statusCode;
                id header = http.allHeaderFields[@"Date"];
                if ([header isKindOfClass:NSString.class]) date = header;
            }
            dispatch_semaphore_signal(gate);
        }];
    [task resume];
    dispatch_semaphore_wait(gate, DISPATCH_TIME_FOREVER);
    [session finishTasksAndInvalidate];
    if (status) *status = code;
    if (dateHeader) *dateHeader = date;
    return (code >= 200 && code < 300) ? body : nil;
}
#endif

// Little-endian float32, time-major, then north-to-south, west-to-east.
static float *ReadF32(NSString *path, int nTimes, int nPoints, NSString **error) {
    NSData *file = [NSData dataWithContentsOfFile:path];
    size_t need = (size_t)nTimes * (size_t)nPoints * sizeof(float);
    if (file.length != need) {
        if (error) *error = [NSString stringWithFormat:@"%@ is %lu bytes, expected %lu",
            path.lastPathComponent, (unsigned long)file.length, (unsigned long)need];
        return NULL;
    }
    float *buf = malloc(need);
    if (!buf) return NULL;
    memcpy(buf, file.bytes, need);
    return buf;
}

// The collector's published grid is little-endian IEEE 754 binary16. Keep
// this decoder here rather than relying on a platform half type.
static float DecodeF16(uint16_t bits) {
    int sign = (bits >> 15) & 1;
    int exponent = (bits >> 10) & 0x1f;
    int fraction = bits & 0x3ff;
    float value;
    if (exponent == 0) {
        value = fraction == 0 ? 0.0f : ldexpf((float)fraction, -24);
    } else if (exponent == 31) {
        value = fraction ? NAN : INFINITY;
    } else {
        value = ldexpf(1.0f + (float)fraction / 1024.0f, exponent - 15);
    }
    return sign ? -value : value;
}

static float *ReadF16(NSString *path, int nPoints, NSString **error) {
    NSData *file = [NSData dataWithContentsOfFile:path];
    size_t need = (size_t)nPoints * sizeof(uint16_t);
    if (file.length != need) {
        if (error) *error = [NSString stringWithFormat:@"%@ is %lu bytes, expected %lu",
            path.lastPathComponent, (unsigned long)file.length, (unsigned long)need];
        return NULL;
    }
    const uint8_t *bytes = file.bytes;
    float *out = malloc((size_t)nPoints * sizeof(float));
    if (!out) {
        if (error) *error = @"not enough memory for an ECMWF field";
        return NULL;
    }
    for (int i = 0; i < nPoints; i++) {
        uint16_t bits = (uint16_t)bytes[i * 2] | ((uint16_t)bytes[i * 2 + 1] << 8);
        out[i] = bits == 0xf800 ? NAN : DecodeF16(bits); // fill = -32768
        if (isinf(out[i])) out[i] = NAN;
    }
    return out;
}

static NSDate *PublishedISODate(id value) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    return [iso dateFromString:value];
}

static NSDate *PublishedRunDate(NSString *runID) {
    if (![runID isKindOfClass:NSString.class] || runID.length != 12 ||
        [runID characterAtIndex:8] != 'T' || [runID characterAtIndex:11] != 'Z') return nil;
    NSString *iso = [NSString stringWithFormat:@"%@-%@-%@T%@:%@:%@Z",
        [runID substringWithRange:NSMakeRange(0, 4)], [runID substringWithRange:NSMakeRange(4, 2)],
        [runID substringWithRange:NSMakeRange(6, 2)], [runID substringWithRange:NSMakeRange(9, 2)],
        @"00", @"00"];
    return PublishedISODate(iso);
}

static void StoreField(Cube *cube, int var, int nTimes, const float *stack) {
    for (int hour = 0; hour < nTimes; hour++) {
        for (int point = 0; point < cube->nPoints; point++) {
            float value = stack[(size_t)hour * (size_t)cube->nPoints + (size_t)point];
            size_t index = ((size_t)var * (size_t)cube->nPoints + (size_t)point) * (size_t)cube->nHours + (size_t)hour;
            cube->data[index] = isfinite(value) ? value : NAN;
        }
    }
}

static NSString *VariableFile(NSDictionary *manifest, NSString *key, NSString *fallback, NSString **error) {
    NSDictionary *vars = [manifest[@"variables"] isKindOfClass:NSDictionary.class] ? manifest[@"variables"] : nil;
    NSDictionary *entry = [vars[key] isKindOfClass:NSDictionary.class] ? vars[key] : nil;
    NSString *file = [entry[@"file"] isKindOfClass:NSString.class] ? entry[@"file"] : fallback;
    if (!file.length) file = fallback;
    NSString *ext = file.pathExtension.lowercaseString;
    if ([ext isEqual:@"grib"] || [ext isEqual:@"grib2"] || [file containsString:@".."] || [file containsString:@"/"]) {
        if (error) *error = @"the chart reads float32 grids, not GRIB";
        return nil;
    }
    return file;
}

static BOOL LoadRunDirectory(NSString *dir, Cube *cube, NSDictionary **manifestOut, NSString **error);

static BOOL SupportedGridContract(NSDictionary *document, NSString **error) {
    if (![document isKindOfClass:NSDictionary.class]) return NO;
    id contract = document[@"contract"], version = document[@"schema_version"], family = document[@"family"];
    if ((contract && (![contract isKindOfClass:NSString.class] || ![contract isEqual:@"isobar-data"])) ||
        (version && (![version isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID() || [version doubleValue] != 1.0)) ||
        (family && (![family isKindOfClass:NSString.class] || ![family isEqual:@"grids/ecmwf_ifs025"]))) {
        if (error) *error = @"ECMWF data uses an unsupported contract version";
        return NO;
    }
    return YES;
}

#ifndef ISOBAR_APP
static BOOL LoadECMWF(NSString *root, Cube *cube, NSDictionary **manifestOut, NSString **error) {
    NSString *latestPath = [root stringByAppendingPathComponent:@"latest.json"];
    NSData *latestData = [NSData dataWithContentsOfFile:latestPath];
    NSDictionary *latest = [NSJSONSerialization JSONObjectWithData:latestData ?: [NSData data] options:0 error:nil];
    if (!SupportedGridContract(latest, error)) return NO;
    NSString *folder = [latest[@"path"] isKindOfClass:NSString.class] ? latest[@"path"] : nil;
    if (!folder.length) {
        if (error) *error = [NSString stringWithFormat:@"no ECMWF run at %@ (run fetch-ecmwf)", root];
        return NO;
    }
    return LoadRunDirectory([root stringByAppendingPathComponent:folder], cube, manifestOut, error);
}
#endif

static BOOL LoadRunDirectory(NSString *dir, Cube *cube, NSDictionary **manifestOut, NSString **error) {
    NSData *manifestData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"manifest.json"]];
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:manifestData ?: [NSData data] options:0 error:nil];
    if (!SupportedGridContract(manifest, error)) return NO;
    if (manifest[@"schema"] && [manifest[@"schema"] integerValue] != 1) {
        if (error) *error = @"ECMWF grid schema is unsupported";
        return NO;
    }
    NSDictionary *grid = [manifest[@"grid"] isKindOfClass:NSDictionary.class] ? manifest[@"grid"] : nil;
    NSArray *times = [manifest[@"times"] isKindOfClass:NSArray.class] ? manifest[@"times"] : nil;
    if (!grid || times.count < 1) {
        if (error) *error = @"ECMWF manifest is missing a grid or valid times";
        return NO;
    }
    NSString *dtype = [grid[@"dtype"] isKindOfClass:NSString.class] ? grid[@"dtype"] : nil;
    if (dtype.length && ![dtype isEqual:@"float32"]) {
        if (error) *error = @"ECMWF grid is not float32";
        return NO;
    }
    int nLon = [grid[@"nx"] intValue];
    int nLat = [grid[@"ny"] intValue];
    double step = [grid[@"step"] doubleValue];
    double west = [grid[@"west"] doubleValue];
    double north = [grid[@"north"] doubleValue];
    if (nLon < 2 || nLat < 2 || !(step > 0)) {
        if (error) *error = @"ECMWF grid dimensions are unusable";
        return NO;
    }
    int nTimes = (int)times.count;
    int nPoints = nLon * nLat;
    cube->nLon = nLon;
    cube->nLat = nLat;
    cube->west = west;
    cube->north = north;
    cube->step = step;
    cube->nHours = nTimes;
    cube->nPoints = nPoints;
    AdoptCubeGrid(cube);
    cube->times = calloc((size_t)nTimes, sizeof(int64_t));
    cube->data = calloc((size_t)VarCount * (size_t)nPoints * (size_t)nTimes, sizeof(float));
    if (!cube->times || !cube->data) return NO;
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    for (int h = 0; h < nTimes; h++) {
        NSDate *when = [times[h] isKindOfClass:NSString.class] ? [iso dateFromString:times[h]] : nil;
        if (!when) {
            if (error) *error = @"ECMWF manifest has a time this chart cannot read";
            return NO;
        }
        cube->times[h] = (int64_t)llround(when.timeIntervalSince1970);
    }
    NSDictionary *files = @{
        @(VarMSLP): @[@"msl", @"msl.f32"],
        @(VarT850): @[@"t850", @"t850.f32"],
        @(VarT2M): @[@"t2m", @"t2m.f32"],
        @(VarRain): @[@"rain24", @"rain24.f32"],
    };
    for (NSNumber *var in files) {
        NSArray *pair = files[var];
        NSString *name = VariableFile(manifest, pair[0], pair[1], error);
        if (!name) return NO;
        float *stack = ReadF32([dir stringByAppendingPathComponent:name], nTimes, nPoints, error);
        if (!stack) return NO;
        StoreField(cube, var.intValue, nTimes, stack);
        free(stack);
    }
    NSString *uName = VariableFile(manifest, @"u10", @"u10.f32", error);
    NSString *vName = VariableFile(manifest, @"v10", @"v10.f32", error);
    if (!uName || !vName) return NO;
    float *u = ReadF32([dir stringByAppendingPathComponent:uName], nTimes, nPoints, error);
    float *v = ReadF32([dir stringByAppendingPathComponent:vName], nTimes, nPoints, error);
    if (!u || !v) { free(u); free(v); return NO; }
    for (int hour = 0; hour < nTimes; hour++) {
        for (int point = 0; point < nPoints; point++) {
            float ue = u[(size_t)hour * (size_t)nPoints + (size_t)point];
            float vn = v[(size_t)hour * (size_t)nPoints + (size_t)point];
            float speed = NAN, direction = NAN;
            if (isfinite(ue) && isfinite(vn)) {
                speed = hypotf(ue, vn) * 1.9438445f;
                direction = atan2f(-ue, -vn) * (180.f / (float)M_PI);
                if (direction < 0) direction += 360.f;
            }
            size_t base = ((size_t)point) * (size_t)nTimes + (size_t)hour;
            cube->data[((size_t)VarWSpd * (size_t)nPoints) * (size_t)nTimes + base] = speed;
            cube->data[((size_t)VarWDir * (size_t)nPoints) * (size_t)nTimes + base] = direction;
        }
    }
    free(u);
    free(v);
    // A reset accumulation is not a rainfall total.
    for (int hour = 0; hour < nTimes; hour++) {
        for (int point = 0; point < nPoints; point++) {
            size_t index = ((size_t)VarRain * (size_t)nPoints + (size_t)point) * (size_t)nTimes + (size_t)hour;
            float value = cube->data[index];
            if (isfinite(value) && value < 0) cube->data[index] = NAN;
        }
    }
    NSString *generated = [manifest[@"generated"] isKindOfClass:NSString.class] ? manifest[@"generated"] : @"";
    NSDate *made = generated.length ? [iso dateFromString:generated] : nil;
    cube->fetched = made ? made.timeIntervalSince1970 : [NSDate date].timeIntervalSince1970;
    NSString *credit = [manifest[@"attribution"] isKindOfClass:NSString.class] ? manifest[@"attribution"] : @"ECMWF Open Data";
    strncpy(cube->httpDate, credit.UTF8String, sizeof cube->httpDate - 1);
    if (manifestOut) *manifestOut = manifest;
    return YES;
}

typedef struct {
    NSString *directoryName;
    NSString *sidecarParam;
    NSString *units;
} PublishedSpec;

static BOOL SameNumber(id value, double expected) {
    return [value isKindOfClass:NSNumber.class] && fabs([value doubleValue] - expected) < 1e-7;
}

static BOOL PublishedField(NSString *root, NSString *runID, NSDate *runDate, NSDate *valid,
    PublishedSpec spec, int nLon, int nLat, float **out, NSString **error) {
    NSString *validID = nil;
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSString *validText = [iso stringFromDate:valid];
    if (!validText.length) return NO;
    validID = [NSString stringWithFormat:@"%@%@%@T%@%@",
        [validText substringWithRange:NSMakeRange(0, 4)],
        [validText substringWithRange:NSMakeRange(5, 2)],
        [validText substringWithRange:NSMakeRange(8, 2)],
        [validText substringWithRange:NSMakeRange(11, 2)], @"Z"];
    NSString *dir = [[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
        stringByAppendingPathComponent:runID];
    NSString *stem = [[dir stringByAppendingPathComponent:spec.directoryName]
        stringByAppendingPathComponent:validID];
    NSString *sidePath = [stem stringByAppendingPathExtension:@"json"];
    NSData *sideData = [NSData dataWithContentsOfFile:sidePath];
    NSDictionary *side = [NSJSONSerialization JSONObjectWithData:sideData ?: [NSData data] options:0 error:nil];
    if (![side isKindOfClass:NSDictionary.class]) {
        if (error) *error = [NSString stringWithFormat:@"%@ sidecar is missing or invalid", sidePath.lastPathComponent];
        return NO;
    }
    NSDate *sideRun = PublishedISODate(side[@"run"]);
    NSDate *sideValid = PublishedISODate(side[@"valid_time"]);
    if (!sideRun || !sideValid || fabs([sideRun timeIntervalSinceDate:runDate]) > 1 ||
        fabs([sideValid timeIntervalSinceDate:valid]) > 1 ||
        !SameNumber(side[@"nx"], nLon) || !SameNumber(side[@"ny"], nLat) ||
        !SameNumber(side[@"lon0"], 95.0) || !SameNumber(side[@"lat0"], 0.0) ||
        !SameNumber(side[@"dlon"], 0.25) || !SameNumber(side[@"dlat"], -0.25) ||
        !SameNumber(side[@"fill"], -32768.0) ||
        ![side[@"units"] isKindOfClass:NSString.class] || ![side[@"units"] isEqual:spec.units] ||
        ![side[@"param"] isEqual:spec.sidecarParam] ||
        ![side[@"dtype"] isEqual:@"float16"] || ![side[@"endian"] isEqual:@"little"] ||
        ![side[@"order"] isEqual:@"north-to-south, west-to-east"]) {
        if (error) *error = [NSString stringWithFormat:@"%@ sidecar metadata does not match the published grid",
            sidePath.lastPathComponent];
        return NO;
    }
    NSString *dataPath = [stem stringByAppendingPathExtension:@"f16"];
    float *values = ReadF16(dataPath, nLon * nLat, error);
    if (!values) return NO;
    *out = values;
    return YES;
}

static BOOL PublishedHasFile(NSString *root, NSString *runID, NSDate *valid, NSString *variable, BOOL *exists) {
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSString *text = [iso stringFromDate:valid];
    if (!text.length) return NO;
    NSString *validID = [NSString stringWithFormat:@"%@%@%@T%@%@",
        [text substringWithRange:NSMakeRange(0, 4)], [text substringWithRange:NSMakeRange(5, 2)],
        [text substringWithRange:NSMakeRange(8, 2)], [text substringWithRange:NSMakeRange(11, 2)], @"Z"];
    NSString *base = [[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
        stringByAppendingPathComponent:runID];
    NSString *f16 = [[[base stringByAppendingPathComponent:variable] stringByAppendingPathComponent:validID]
        stringByAppendingPathExtension:@"f16"];
    NSString *json = [[[base stringByAppendingPathComponent:variable] stringByAppendingPathComponent:validID]
        stringByAppendingPathExtension:@"json"];
    BOOL f = [[NSFileManager defaultManager] fileExistsAtPath:f16];
    BOOL j = [[NSFileManager defaultManager] fileExistsAtPath:json];
    if (exists) *exists = f || j;
    return f == j;
}

static BOOL LoadPublishedCube(NSString *root, NSString *runID, NSString *previousID,
    Cube *cube, NSDate **runDateOut, NSString **error) {
    NSDate *runDate = PublishedRunDate(runID);
    if (!runDate) {
        if (error) *error = @"published ECMWF run id is invalid";
        return NO;
    }
    PublishedSpec msl = {@"mslp", @"msl", @"hPa"};
    NSDate *valid = runDate;
    BOOL present = NO;
    if (!PublishedHasFile(root, runID, valid, msl.directoryName, &present) || !present) {
        if (error) *error = @"published ECMWF run has no valid mslp field";
        return NO;
    }
    // Read the first sidecar to establish dimensions, then require a complete
    // consecutive 3-hour sequence. The producer publishes 0–96 h (97 frames).
    NSString *base = [[[root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/runs"]
        stringByAppendingPathComponent:runID] stringByAppendingPathComponent:msl.directoryName];
    NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:base error:nil];
    NSMutableArray *jsonNames = [NSMutableArray array];
    for (NSString *name in files) if ([name.pathExtension.lowercaseString isEqual:@"json"]) [jsonNames addObject:name];
    if (jsonNames.count < 1 || jsonNames.count > 121) {
        if (error) *error = @"published ECMWF run has an unreasonable number of times";
        return NO;
    }
    [jsonNames sortUsingSelector:@selector(compare:)];
    NSString *firstName = jsonNames.firstObject;
    NSString *firstStem = [firstName stringByDeletingPathExtension];
    NSDate *firstValid = PublishedRunDate(firstStem);
    if (!firstValid || fabs([firstValid timeIntervalSinceDate:runDate]) > 1) {
        if (error) *error = @"published ECMWF run does not start at its issue time";
        return NO;
    }
    NSData *firstData = [NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:firstName]];
    NSDictionary *first = [NSJSONSerialization JSONObjectWithData:firstData ?: [NSData data] options:0 error:nil];
    if (![first isKindOfClass:NSDictionary.class] || ![first[@"nx"] isKindOfClass:NSNumber.class] ||
        ![first[@"ny"] isKindOfClass:NSNumber.class]) {
        if (error) *error = @"published ECMWF first sidecar has invalid dimensions";
        return NO;
    }
    int nLon = [first[@"nx"] intValue], nLat = [first[@"ny"] intValue];
    if (nLon < 2 || nLat < 2 || nLon > 1000 || nLat > 1000 || (size_t)nLon * (size_t)nLat > 250000) {
        if (error) *error = @"published ECMWF grid dimensions are unsafe";
        return NO;
    }
    int nTimes = (int)jsonNames.count;
    if (nTimes != 33) {
        if (error) *error = @"published ECMWF run must contain 33 three-hour frames";
        return NO;
    }
    if ((size_t)VarCount * (size_t)nLon * (size_t)nLat * (size_t)nTimes * sizeof(float) > 256u * 1024u * 1024u) {
        if (error) *error = @"published ECMWF grid is too large";
        return NO;
    }
    cube->nLon = nLon; cube->nLat = nLat; cube->west = 95; cube->north = 0;
    cube->step = 0.25; cube->nHours = nTimes; cube->nPoints = nLon * nLat;
    cube->times = calloc((size_t)nTimes, sizeof(int64_t));
    cube->data = calloc((size_t)VarCount * (size_t)cube->nPoints * (size_t)nTimes, sizeof(float));
    if (!cube->times || !cube->data) {
        if (error) *error = @"not enough memory for the published ECMWF grid";
        return NO;
    }
    PublishedSpec specs[VarCount] = {
        {@"mslp", @"msl", @"hPa"}, {@"t850", @"t", @"degC"},
        {@"t2m", @"2t", @"degC"}, {@"u10", @"10u", @"m/s"},
        {@"v10", @"10v", @"m/s"}, {@"tp", @"tp", @"mm"}
    };
    float *currentRain = calloc((size_t)nTimes * (size_t)cube->nPoints, sizeof(float));
    if (!currentRain) {
        if (error) *error = @"not enough memory for published rainfall";
        return NO;
    }
    for (int h = 0; h < nTimes; h++) {
        NSDate *when = [runDate dateByAddingTimeInterval:3 * 3600 * h];
        cube->times[h] = (int64_t)llround(when.timeIntervalSince1970);
        if (h > 0 && ![when isEqualToDate:[firstValid dateByAddingTimeInterval:3 * 3600 * h]]) {
            free(currentRain); if (error) *error = @"published ECMWF times are not 3-hourly"; return NO;
        }
        for (int var = 0; var < VarCount; var++) {
            float *field = NULL;
            if (!PublishedField(root, runID, runDate, when, specs[var], nLon, nLat, &field, error)) {
                free(currentRain); return NO;
            }
            for (int p = 0; p < cube->nPoints; p++) {
                size_t index = ((size_t)var * (size_t)cube->nPoints + (size_t)p) * (size_t)nTimes + (size_t)h;
                cube->data[index] = field[p];
                if (var == VarRain) currentRain[(size_t)h * (size_t)cube->nPoints + (size_t)p] = field[p];
            }
            free(field);
        }
    }
    // Convert u/v to the renderer's knots and meteorological direction.
    for (int h = 0; h < nTimes; h++) for (int p = 0; p < cube->nPoints; p++) {
        float u = cube->data[((size_t)VarWSpd * cube->nPoints + p) * nTimes + h];
        float v = cube->data[((size_t)VarWDir * cube->nPoints + p) * nTimes + h];
        if (isfinite(u) && isfinite(v)) {
            cube->data[((size_t)VarWSpd * cube->nPoints + p) * nTimes + h] = hypotf(u, v) * 1.9438445f;
            float direction = atan2f(-u, -v) * (180.f / (float)M_PI);
            cube->data[((size_t)VarWDir * cube->nPoints + p) * nTimes + h] = direction < 0 ? direction + 360 : direction;
        } else {
            cube->data[((size_t)VarWSpd * cube->nPoints + p) * nTimes + h] = NAN;
            cube->data[((size_t)VarWDir * cube->nPoints + p) * nTimes + h] = NAN;
        }
    }
    for (int h = 0; h < nTimes; h++) {
        float *earlyEnd = NULL, *earlyStart = NULL;
        if (h < 8 && previousID.length) {
            NSDate *endDate = [runDate dateByAddingTimeInterval:3 * 3600 * h];
            NSDate *startDate = [endDate dateByAddingTimeInterval:-24 * 3600];
            PublishedField(root, previousID, PublishedRunDate(previousID), endDate, specs[VarRain],
                nLon, nLat, &earlyEnd, nil);
            PublishedField(root, previousID, PublishedRunDate(previousID), startDate, specs[VarRain],
                nLon, nLat, &earlyStart, nil);
        }
        for (int p = 0; p < cube->nPoints; p++) {
        float rain = NAN;
        if (h >= 8) rain = (float)OwnAccumulationWindow(currentRain[(size_t)h * cube->nPoints + p],
            currentRain[(size_t)(h - 8) * cube->nPoints + p]);
        else if (earlyEnd && earlyStart)
            rain = (float)OwnAccumulationWindow(earlyEnd[p], earlyStart[p]);
        cube->data[((size_t)VarRain * cube->nPoints + p) * nTimes + h] = rain;
        }
        free(earlyEnd); free(earlyStart);
    }
    free(currentRain);
    cube->fetched = runDate.timeIntervalSince1970;
    strncpy(cube->httpDate, "ECMWF Open Data", sizeof cube->httpDate - 1);
    AdoptCubeGrid(cube);
    if (runDateOut) *runDateOut = runDate;
    return YES;
}

#ifndef ISOBAR_APP
static int HourIndex(const Cube *cube, NSDate *instant) {
    if (!instant) return -1;
    int64_t want = (int64_t)llround(instant.timeIntervalSince1970);
    int best = -1;
    int64_t bestDelta = INT64_MAX;
    for (int i = 0; i < cube->nHours; i++) {
        int64_t delta = llabs(cube->times[i] - want);
        if (delta < bestDelta) { bestDelta = delta; best = i; }
    }
    // Model steps are 3-hourly. Half a step either side still names that frame.
    return bestDelta <= 90 * 60 ? best : -1;
}
#endif

static double *ScalarField(const Cube *cube, int var, double hour) {
    double *field = malloc((size_t)cube->nPoints * sizeof(double));
    if (!field) return NULL;
    for (int p = 0; p < cube->nPoints; p++) {
        float value = CubeAtFraction(cube, var, p, hour);
        field[p] = isfinite(value) ? value : NAN;
    }
    return field;
}

// rain24 is already the 24 h ending at this frame, in millimetres.
static double *RainField(const Cube *cube, double hour) {
    return ScalarField(cube, VarRain, hour);
}

static void FieldRange(const double *field, int n, double *minV, double *maxV) {
    double lo = INFINITY, hi = -INFINITY;
    for (int i = 0; i < n; i++) {
        if (!isfinite(field[i])) continue;
        if (field[i] < lo) lo = field[i];
        if (field[i] > hi) hi = field[i];
    }
    *minV = lo;
    *maxV = hi;
}

static double SampleBilinear(const double *field, int nLon, int nLat, double longitude, double latitude) {
    double fi = (longitude - GWest()) / GStep();
    double fj = (GNorth() - latitude) / GStep();
    if (fi < 0 || fj < 0 || fi > nLon - 1 || fj > nLat - 1) return NAN;
    int i = (int)floor(fi);
    int j = (int)floor(fj);
    if (i >= nLon - 1) i = nLon - 2;
    if (j >= nLat - 1) j = nLat - 2;
    if (i < 0 || j < 0) return NAN;
    double tx = fi - i;
    double ty = fj - j;
    double a = field[j * nLon + i];
    double b = field[j * nLon + i + 1];
    double c = field[(j + 1) * nLon + i];
    double d = field[(j + 1) * nLon + i + 1];
    if (!isfinite(a) || !isfinite(b) || !isfinite(c) || !isfinite(d)) return NAN;
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// Clamp a pixel that falls just outside the grid so the colour wash meets the
// panel edge instead of stopping on the Lambert arc.
static double SampleWash(const double *field, int nLon, int nLat, double longitude, double latitude) {
    double west = GWest();
    double north = GNorth();
    double step = GStep();
    double east = west + (nLon - 1) * step;
    double south = north - (nLat - 1) * step;
    if (longitude < west - 14.0 || longitude > east + 14.0 || latitude > north + 14.0 || latitude < south - 14.0)
        return NAN;
    if (longitude < west) longitude = west;
    if (longitude > east) longitude = east;
    if (latitude > north) latitude = north;
    if (latitude < south) latitude = south;
    return SampleBilinear(field, nLon, nLat, longitude, latitude);
}

static BOOL PixelUnproject(OwnView view, double x, double yDown, double *latitude, double *longitude) {
    if (!view.valid || view.scale == 0) return NO;
    double projX = view.minX + (x - view.offsetX) / view.scale;
    double projY = view.maxY - (yDown - view.offsetY) / view.scale;
    return OwnUnproject(view.geo, projX, projY, latitude, longitude);
}

// Even-odd fill of the coastline onto the model grid. Orography is not in the
// local files; land is the stand-in, and rough land (below) stands in for the
// high ground where mean-sea-level reduction breaks into spikes.
static uint8_t *BuildLandMask(OwnCoast coast, int nLon, int nLat) {
    if (coast.rings < 1 || nLon < 2 || nLat < 2) return NULL;
    uint8_t *land = calloc((size_t)nLon * (size_t)nLat, 1);
    double *cross = malloc((size_t)coast.points * sizeof(double));
    if (!land || !cross) { free(land); free(cross); return NULL; }
    double step = GStep();
    double west = GWest();
    double north = GNorth();
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        for (int j = 0; j < nLat; j++) {
            int nCross = 0;
            double y = j;
            for (int e = 0; e < n; e++) {
                double y0 = (north - coast.lat[start + (e == 0 ? n - 1 : e - 1)]) / step;
                double y1 = (north - coast.lat[start + e]) / step;
                double x0 = (coast.lon[start + (e == 0 ? n - 1 : e - 1)] - west) / step;
                double x1 = (coast.lon[start + e] - west) / step;
                if (y0 == y1) continue;
                double yLo = y0 < y1 ? y0 : y1;
                double yHi = y0 < y1 ? y1 : y0;
                if (y < yLo || y >= yHi) continue;
                double t = (y - y0) / (y1 - y0);
                if (nCross < coast.points) cross[nCross++] = x0 + (x1 - x0) * t;
            }
            for (int a = 1; a < nCross; a++) {
                double v = cross[a];
                int b = a;
                while (b > 0 && cross[b - 1] > v) { cross[b] = cross[b - 1]; b--; }
                cross[b] = v;
            }
            for (int k = 0; k + 1 < nCross; k += 2) {
                int a = (int)ceil(cross[k] - 1e-8);
                int b = (int)floor(cross[k + 1] + 1e-8);
                if (a < 0) a = 0;
                if (b >= nLon) b = nLon - 1;
                for (int i = a; i <= b; i++) land[j * nLon + i] = 1;
            }
        }
    }
    free(cross);
    return land;
}

static void BlurField(const double *src, double *dst, int nLon, int nLat, double sigma) {
    int n = nLon * nLat;
    if (!(sigma >= 0.4)) { memcpy(dst, src, (size_t)n * sizeof(double)); return; }
    int rad = (int)ceil(3.0 * sigma);
    if (rad < 1) rad = 1;
    if (rad > 24) rad = 24;
    double kernel[49];
    double sum = 0;
    for (int i = -rad; i <= rad; i++) {
        double w = exp(-0.5 * (i * i) / (sigma * sigma));
        kernel[i + rad] = w;
        sum += w;
    }
    for (int i = 0; i <= rad * 2; i++) kernel[i] /= sum;
    double *tmp = malloc((size_t)n * sizeof(double));
    if (!tmp) { memcpy(dst, src, (size_t)n * sizeof(double)); return; }
    for (int j = 0; j < nLat; j++) {
        for (int i = 0; i < nLon; i++) {
            double acc = 0;
            for (int di = -rad; di <= rad; di++) {
                int ii = i + di;
                if (ii < 0) ii = 0;
                if (ii >= nLon) ii = nLon - 1;
                acc += kernel[di + rad] * src[j * nLon + ii];
            }
            tmp[j * nLon + i] = acc;
        }
    }
    for (int i = 0; i < nLon; i++) {
        for (int j = 0; j < nLat; j++) {
            double acc = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                int jj = j + dj;
                if (jj < 0) jj = 0;
                if (jj >= nLat) jj = nLat - 1;
                acc += kernel[dj + rad] * tmp[jj * nLon + i];
            }
            dst[j * nLon + i] = acc;
        }
    }
    free(tmp);
}

static void SmoothLandMSLPMotion(double *field, const uint8_t *land, int nLon, int nLat, uint8_t *roughOut);

// Static and moving charts must use the same pressure field. Otherwise the
// contour jumps at the transition between a still frame and the movie.
static void SmoothLandMSLP(double *field, const uint8_t *land, int nLon, int nLat, uint8_t *roughOut) {
    SmoothLandMSLPMotion(field, land, nLon, nLat, roughOut);
}

// Normalize around missing cells without filling those cells or spreading
// their missingness across an otherwise valid pressure field.
static void BlurFiniteField(const double *src, double *dst, int nLon, int nLat, double sigma) {
    size_t n = (size_t)nLon * nLat;
    BOOL missing = NO;
    for (size_t i = 0; i < n; i++) if (!isfinite(src[i])) { missing = YES; break; }
    if (!missing) { BlurField(src, dst, nLon, nLat, sigma); return; }
    double *values = malloc(n * sizeof(double)), *weights = malloc(n * sizeof(double));
    double *normal = malloc(n * sizeof(double));
    if (!values || !weights || !normal) {
        free(values); free(weights); free(normal); memcpy(dst, src, n * sizeof(double)); return;
    }
    for (size_t i = 0; i < n; i++) {
        weights[i] = isfinite(src[i]) ? 1 : 0;
        values[i] = isfinite(src[i]) ? src[i] : 0;
    }
    BlurField(values, dst, nLon, nLat, sigma);
    BlurField(weights, normal, nLon, nLat, sigma);
    for (size_t i = 0; i < n; i++) dst[i] = isfinite(src[i]) && normal[i] > 1e-9 ? dst[i] / normal[i] : NAN;
    free(values); free(weights); free(normal);
}

// MSL pressure reduction over high ground produces small bends and false
// closed contours. Preserve the analysed ocean field and blend toward a
// synoptic-scale land field, feathered across the coast. This is spatial
// smoothing only; every displayed time is still rendered from its own grid.
static void SmoothLandMSLPMotion(double *field, const uint8_t *land, int nLon, int nLat, uint8_t *roughOut) {
    int n = nLon * nLat;
    double *mild = malloc((size_t)n * sizeof(double));
    double *wide = malloc((size_t)n * sizeof(double));
    double *landW = malloc((size_t)n * sizeof(double));
    double *weight = malloc((size_t)n * sizeof(double));
    if (!mild || !wide || !landW || !weight) {
        free(mild); free(wide); free(landW); free(weight);
        return;
    }
    for (int i = 0; i < n; i++) landW[i] = land && land[i] ? 1.0 : 0.0;
    BlurFiniteField(field, mild, nLon, nLat, 2.0);
    BlurFiniteField(field, wide, nLon, nLat, 8.0);
    BlurField(landW, weight, nLon, nLat, 2.0);
    for (int i = 0; i < n; i++) {
        double terrain = weight[i];
        if (terrain < 0) terrain = 0;
        if (terrain > 1) terrain = 1;
        double delta = fabs(field[i] - wide[i]);
        if (roughOut) roughOut[i] = land && land[i] && delta > 1.8;
        // The wide field carries much of the land map even away from the
        // sharpest spikes; contour levels are sensitive to shallow ripples.
        double rough = (delta - 0.6) / 2.4;
        if (rough < 0) rough = 0;
        if (rough > 1) rough = 1;
        rough = rough * rough * (3.0 - 2.0 * rough);
        double wideBlend = terrain * (0.4 + 0.45 * rough);
        double base = field[i] * (1.0 - 0.75 * terrain) + mild[i] * (0.75 * terrain);
        field[i] = base * (1.0 - wideBlend) + wide[i] * wideBlend;
    }
    free(mild); free(wide); free(landW); free(weight);
}

// A closed ring smaller than about 3° is MSL-reduction noise, not a cyclone.
static void DropSmallClosed(OwnLineSet *set, double minSpan) {
    if (!set || !set->lines) return;
    int w = 0;
    int dropped = 0;
    for (int i = 0; i < set->count; i++) {
        OwnLine line = set->lines[i];
        BOOL tiny = NO;
        if (line.closed && line.count >= 3) {
            double minX = INFINITY, maxX = -INFINITY, minY = INFINITY, maxY = -INFINITY;
            for (int p = 0; p < line.count; p++) {
                if (line.pts[p].x < minX) minX = line.pts[p].x;
                if (line.pts[p].x > maxX) maxX = line.pts[p].x;
                if (line.pts[p].y < minY) minY = line.pts[p].y;
                if (line.pts[p].y > maxY) maxY = line.pts[p].y;
            }
            tiny = fmax(maxX - minX, maxY - minY) < minSpan;
        }
        if (tiny) { free(line.pts); dropped++; continue; }
        set->lines[w++] = line;
    }
    set->count = w;
#ifndef ISOBAR_APP
    if (dropped) fprintf(stderr, "  dropped %d closed contours under %.0f°\n", dropped, minSpan);
#else
    (void)dropped;
#endif
}

typedef struct {
    double minLon, maxLon, minLat, maxLat;
    int small;
} RingSpan;

static RingSpan *CoastSpans(OwnCoast coast) {
    if (coast.rings < 1) return NULL;
    RingSpan *spans = calloc((size_t)coast.rings, sizeof(RingSpan));
    if (!spans) return NULL;
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        double minLon = INFINITY, maxLon = -INFINITY, minLat = INFINITY, maxLat = -INFINITY;
        for (int i = 0; i < n; i++) {
            double lon = coast.lon[start + i], lat = coast.lat[start + i];
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        spans[r] = (RingSpan){minLon, maxLon, minLat, maxLat, fmax(maxLon - minLon, maxLat - minLat) < 3.0};
    }
    return spans;
}

static BOOL PointInRing(OwnCoast coast, int ring, double lon, double lat) {
    int start = coast.ringStart[ring];
    int n = coast.ringCount[ring];
    BOOL inside = NO;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        double yi = coast.lat[start + i], yj = coast.lat[start + j];
        double xi = coast.lon[start + i], xj = coast.lon[start + j];
        if ((yi > lat) != (yj > lat)) {
            double x = xi + (xj - xi) * (lat - yi) / (yj - yi);
            if (lon < x) inside = !inside;
        }
    }
    return inside;
}

static BOOL OnSmallLand(OwnCoast coast, const RingSpan *spans, double lat, double lon) {
    if (!spans) return NO;
    for (int r = 0; r < coast.rings; r++) {
        if (!spans[r].small) continue;
        if (lon < spans[r].minLon || lon > spans[r].maxLon || lat < spans[r].minLat || lat > spans[r].maxLat)
            continue;
        if (PointInRing(coast, r, lon, lat)) return YES;
    }
    return NO;
}

static double GeoDegrees(double lat1, double lon1, double lat2, double lon2) {
    double mid = (lat1 + lat2) * 0.5 * (M_PI / 180.0);
    return hypot(lat2 - lat1, (lon2 - lon1) * cos(mid));
}

// Heading change a few vertices either side of the label. A synoptic bend
// stays under this; a kink over an island does not.
static BOOL LabelOnStraight(const OwnLine *line, double x, double y) {
    if (!line || line->count < 6) return YES;
    int best = 0;
    double bestD = 1e9;
    for (int i = 0; i < line->count; i++) {
        double d = hypot(line->pts[i].x - x, line->pts[i].y - y);
        if (d < bestD) { bestD = d; best = i; }
    }
    int span = line->count > 16 ? 5 : 2;
    int n = line->count;
    int i0 = best - span, i1 = best + span;
    if (!line->closed) {
        if (i0 < 0) i0 = 0;
        if (i1 >= n) i1 = n - 1;
        if (best - i0 < 2 || i1 - best < 2) return YES;
    } else {
        i0 = (best - span + n * 2) % n;
        i1 = (best + span) % n;
    }
    OwnVec a = line->pts[i0], b = line->pts[best], c = line->pts[i1];
    double a0 = atan2(b.y - a.y, b.x - a.x);
    double a1 = atan2(c.y - b.y, c.x - b.x);
    double turn = a1 - a0;
    while (turn > M_PI) turn -= 2.0 * M_PI;
    while (turn < -M_PI) turn += 2.0 * M_PI;
    return fabs(turn) <= 0.70;
}

static double PolyLength(const OwnLine *line) {
    if (!line || line->count < 2) return 0;
    double total = 0;
    for (int i = 1; i < line->count; i++)
        total += hypot(line->pts[i].x - line->pts[i - 1].x, line->pts[i].y - line->pts[i - 1].y);
    if (line->closed)
        total += hypot(line->pts[0].x - line->pts[line->count - 1].x, line->pts[0].y - line->pts[line->count - 1].y);
    return total;
}

// One label per isobar per `minDeg` of path, none on a landmass under 3°,
// none on a kink, and none crowding another label or an H/L. Longer isobars
// claim a spot first so a fragment over an island does not win.
static int ThinLabels(OwnLabel *labels, int nLabels, const OwnLine *lines,
    OwnView view, double mapH, OwnCoast coast, const RingSpan *spans,
    const OwnVec *centers, int nCenters, double minDeg, double minPx, double centrePx) {
    if (nLabels <= 0) return 0;
    typedef struct { int index; double length, lat, lon; int geo; } Cand;
    Cand *order = malloc((size_t)nLabels * sizeof(Cand));
    if (!order) return nLabels;
    for (int i = 0; i < nLabels; i++) {
        double lat = 0, lon = 0;
        BOOL geo = PixelUnproject(view, labels[i].x, mapH - labels[i].y, &lat, &lon);
        int line = labels[i].line;
        double length = (line >= 0) ? PolyLength(&lines[line]) : 0;
        order[i] = (Cand){i, length, lat, lon, geo};
    }
    for (int a = 1; a < nLabels; a++) {
        Cand key = order[a];
        int b = a;
        while (b > 0 && order[b - 1].length < key.length) { order[b] = order[b - 1]; b--; }
        order[b] = key;
    }
    int keep[128];
    int nKeep = 0;
    for (int a = 0; a < nLabels && nKeep < 128; a++) {
        OwnLabel lab = labels[order[a].index];
        if (lab.line >= 0 && !LabelOnStraight(&lines[lab.line], lab.x, lab.y)) continue;
        if (order[a].geo && OnSmallLand(coast, spans, order[a].lat, order[a].lon)) continue;
        BOOL close = NO;
        for (int k = 0; k < nKeep && !close; k++) {
            OwnLabel other = labels[keep[k]];
            if (hypot(lab.x - other.x, lab.y - other.y) < minPx) { close = YES; break; }
            if (OwnLabelsOverlap(lab, other, 8)) { close = YES; break; }
            if (fabs(lab.level - other.level) < 0.5 && order[a].geo) {
                double olat = 0, olon = 0;
                // Recover the kept label's geography from its place in `order`.
                double alat = 0, alon = 0;
                BOOL ageo = NO;
                for (int t = 0; t < nLabels; t++) if (order[t].index == keep[k]) {
                    alat = order[t].lat; alon = order[t].lon; ageo = order[t].geo; break;
                }
                olat = alat; olon = alon;
                if (ageo && GeoDegrees(order[a].lat, order[a].lon, olat, olon) < minDeg) close = YES;
            }
        }
        for (int c = 0; c < nCenters && !close; c++) {
            if (hypot(lab.x - centers[c].x, lab.y - centers[c].y) < centrePx) close = YES;
        }
        if (!close) keep[nKeep++] = order[a].index;
    }
    OwnLabel *kept = malloc((size_t)nKeep * sizeof(OwnLabel));
    if (!kept) { free(order); return nLabels; }
    for (int i = 0; i < nKeep; i++) kept[i] = labels[keep[i]];
    for (int i = 0; i < nKeep; i++) labels[i] = kept[i];
    free(kept);
    free(order);
    return nKeep;
}

// Densify once, then remove the grid-scale zigzags without changing the
// underlying pressure field or the broad shape of a trough.
static OwnVec *RefineLine(const OwnVec *in, int count, int closed, int *outCount) {
    if (count < 2) return NULL;
    int cap1 = closed ? count * 2 : count * 2 - 1;
    OwnVec *mid = malloc((size_t)cap1 * sizeof(OwnVec));
    int n1 = mid ? OwnDensify(in, count, closed, mid, cap1) : -1;
    if (n1 < 2) { free(mid); return NULL; }
    OwnSmoothLine(mid, n1, closed, 2);
    *outCount = n1;
    return mid;
}

static double LabelHalf(double level, void *context) {
    NSFont *font = (__bridge NSFont *)context;
    NSString *text = [NSString stringWithFormat:@"%.0f", level];
    NSSize size = [text sizeWithAttributes:@{NSFontAttributeName: font}];
    return size.width * 0.5 + 1.5;
}

static void StrokeLine(CGContextRef ctx, const OwnVec *pts, int count, int closed,
    const OwnVec *avoid, int nAvoid, double avoidRadius,
    double width, double red, double green, double blue, double alpha) {
    if (count < 2) return;
    CGContextSetLineWidth(ctx, width);
    CGContextSetRGBStrokeColor(ctx, red, green, blue, alpha);
    CGContextBeginPath(ctx);
    BOOL drawing = NO;
    for (int i = 0; i < count; i++) {
        BOOL blocked = NO;
        for (int a = 0; a < nAvoid; a++) {
            if (hypot(pts[i].x - avoid[a].x, pts[i].y - avoid[a].y) < avoidRadius) { blocked = YES; break; }
        }
        if (blocked) { drawing = NO; continue; }
        if (!drawing) {
            CGContextMoveToPoint(ctx, pts[i].x, pts[i].y);
            drawing = YES;
        } else {
            CGContextAddLineToPoint(ctx, pts[i].x, pts[i].y);
        }
    }
    if (closed && drawing && nAvoid == 0) CGContextClosePath(ctx);
    CGContextStrokePath(ctx);
}

static void DrawText(CGContextRef ctx, NSString *text, NSFont *font, NSColor *color,
    double x, double y, double angle) {
    if (!text.length) return;
    NSDictionary *attrs = @{NSFontAttributeName: font, NSForegroundColorAttributeName: color};
    NSSize size = [text sizeWithAttributes:attrs];
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, x, y);
    CGContextRotateCTM(ctx, angle);
    [text drawAtPoint:NSMakePoint(-size.width / 2.0, -size.height / 2.0) withAttributes:attrs];
    CGContextRestoreGState(ctx);
}

static OwnLineSet ProjectContours(OwnLineSet raw, OwnView view, double mapH) {
    OwnLineSet projected = {0};
    for (int i = 0; i < raw.count; i++) {
        OwnVec *pts = malloc((size_t)raw.lines[i].count * sizeof(OwnVec));
        int n = 0;
        for (int p = 0; p < raw.lines[i].count; p++) {
            double x, y;
            if (!OwnViewProject(view, raw.lines[i].pts[p].y, raw.lines[i].pts[p].x, &x, &y)) continue;
            pts[n++] = (OwnVec){x, mapH - y};
        }
        if (n < 2) { free(pts); continue; }
        int refinedCount = 0;
        OwnVec *refined = RefineLine(pts, n, raw.lines[i].closed, &refinedCount);
        free(pts);
        if (!refined) continue;
        OwnLine *grown = realloc(projected.lines, (size_t)(projected.count + 1) * sizeof(OwnLine));
        if (!grown) { free(refined); break; }
        projected.lines = grown;
        projected.lines[projected.count++] = (OwnLine){refined, refinedCount, raw.lines[i].closed, raw.lines[i].level};
    }
    return projected;
}

static void ReleaseImageBuffer(void *info, const void *data, size_t size) {
    (void)info; (void)size; free((void *)data);
}

typedef struct {
    OwnView prior;
    int width, height;
    OwnVec *locations;
} PixelLocationCache;

static void FreePixelLocationCache(void *value) {
    PixelLocationCache *cache = value;
    if (!cache) return;
    free(cache->locations);
    free(cache);
}

static pthread_key_t gPixelLocationKey;
static pthread_once_t gPixelLocationOnce = PTHREAD_ONCE_INIT;
static void InitializePixelLocationKey(void) {
    pthread_key_create(&gPixelLocationKey, FreePixelLocationCache);
}
static pthread_key_t PixelLocationKey(void) {
    pthread_once(&gPixelLocationOnce, InitializePixelLocationKey);
    return gPixelLocationKey;
}

// Every weather frame uses the same map projection. Reuse exact pixel
// coordinates instead of repeating inverse trigonometry for every colour
// sample. Each thread owns one bounded plate, reclaimed when that thread exits.
static const OwnVec *PixelLocations(OwnView view, int width, int height) {
    if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return NULL;
    pthread_key_t key = PixelLocationKey();
    PixelLocationCache *cache = pthread_getspecific(key);
    if (!cache) {
        cache = calloc(1, sizeof(*cache));
        if (!cache || pthread_setspecific(key, cache) != 0) {
            free(cache);
            return NULL;
        }
    }
    if (cache->locations && cache->width == width && cache->height == height &&
        memcmp(&cache->prior, &view, sizeof(view)) == 0) return cache->locations;
    OwnVec *next = malloc((size_t)width * height * sizeof(OwnVec));
    if (!next) return NULL;
    for (int y=0; y<height; y++) for (int x=0; x<width; x++) {
        double lat, lon;
        BOOL valid = PixelUnproject(view, x+.5, y+.5, &lat, &lon);
        next[(size_t)y*width+x] = (OwnVec){valid?lon:NAN, valid?lat:NAN};
    }
    free(cache->locations); cache->locations = next;
    cache->prior = view; cache->width = width; cache->height = height;
    return cache->locations;
}

static CGImageRef TemperatureImage(const double *field, OwnView view, int mapW, int mapH, double opacity) {
    size_t bytes = (size_t)mapW * (size_t)mapH * 4;
    uint8_t *buffer = calloc(1, bytes);
    if (!buffer) return NULL;
    const OwnVec *locations = PixelLocations(view, mapW, mapH);
    for (int y = 0; y < mapH; y++) {
        for (int x = 0; x < mapW; x++) {
            double lat, lon;
            if (locations) {
                OwnVec point = locations[(size_t)y*mapW+x]; lat=point.y; lon=point.x;
                if (!isfinite(lat)) continue;
            } else if (!PixelUnproject(view, x + 0.5, y + 0.5, &lat, &lon)) continue;
            double value = SampleWash(field, GNLon(), GNLat(), lon, lat);
            if (!isfinite(value)) continue;
            OwnRGB rgb = OwnTemperatureRGB(value);
            uint8_t *px = buffer + ((size_t)y * (size_t)mapW + (size_t)x) * 4;
            px[0] = (uint8_t)lrint(rgb.r * 255);
            px[1] = (uint8_t)lrint(rgb.g * 255);
            px[2] = (uint8_t)lrint(rgb.b * 255);
            px[3] = (uint8_t)lrint(opacity * 255);
        }
    }
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, buffer, bytes, ReleaseImageBuffer);
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image = CGImageCreate(mapW, mapH, 8, 32, mapW * 4, cs,
        kCGImageAlphaLast | kCGBitmapByteOrderDefault, provider, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(cs);
    CGDataProviderRelease(provider);
    return image;
}

// Bureau forecast-rain hatch: thin diagonals, widely spaced, about 40% ink,
// lighter than the isobars. The stroke slopes down to the right.
static void DrawStaticHatch(CGContextRef ctx, const double *rain, OwnView view, double mapW, double mapH, double thresholdMm) {
    const int w = (int)mapW;
    const int h = (int)mapH;
    uint8_t *mask = calloc((size_t)w * (size_t)h, 1);
    if (!mask) return;
    const OwnVec *locations = PixelLocations(view, w, h);
    int covered = 0, seen = 0;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            double lat, lon;
            if (locations) {
                OwnVec point = locations[(size_t)y*w+x]; lat=point.y; lon=point.x;
                if (!isfinite(lat)) continue;
            } else if (!PixelUnproject(view, x + 0.5, y + 0.5, &lat, &lon)) continue;
            seen++;
            double sum = SampleBilinear(rain, GNLon(), GNLat(), lon, lat);
            if (sum >= thresholdMm) {
                mask[(size_t)y * (size_t)w + (size_t)x] = 1;
                covered++;
            }
        }
    }
    (void)covered;
    (void)seen;
    CGContextSaveGState(ctx);
    CGContextSetLineWidth(ctx, kHatchWidth);
    CGContextSetLineCap(ctx, kCGLineCapButt);
    CGContextSetRGBStrokeColor(ctx, 0.28, 0.27, 0.25, kHatchAlpha);
    CGContextBeginPath(ctx);
    const int spacing = kHatchSpacing;
    for (int s = -h; s < w + h; s += spacing) {
        BOOL drawing = NO;
        for (int y = 0; y < h; y++) {
            int x = s + y;
            if (x < 0 || x >= w) { drawing = NO; continue; }
            BOOL on = mask[(size_t)y * (size_t)w + (size_t)x];
            double yUp = mapH - y;
            if (!on) { drawing = NO; continue; }
            if (!drawing) CGContextMoveToPoint(ctx, x, yUp);
            else CGContextAddLineToPoint(ctx, x, yUp);
            drawing = YES;
        }
    }
    CGContextStrokePath(ctx);
    CGContextRestoreGState(ctx);
    free(mask);
}

static void DrawHatch(CGContextRef ctx, const double *rain, OwnView view,
    double mapW, double mapH, double thresholdMm, BOOL motion) {
    if (!motion) { DrawStaticHatch(ctx, rain, view, mapW, mapH, thresholdMm); return; }
    const int w = (int)mapW, h = (int)mapH;
    size_t bytes = (size_t)w * h * 4;
    uint8_t *pixels = calloc(1, bytes);
    if (!pixels) return;
    const OwnVec *locations = PixelLocations(view, w, h);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        double phase = fmod(x - y + h * kHatchSpacing, kHatchSpacing);
        double distance = fmin(phase, kHatchSpacing - phase) / M_SQRT2;
        double coverage = fmax(0, fmin(1, kHatchWidth * .5 + .5 - distance));
        if (coverage <= 0) continue;
        double lat, lon;
        if (locations) {
            OwnVec point = locations[(size_t)y*w+x]; lat=point.y; lon=point.x;
            if (!isfinite(lat)) continue;
        } else if (!PixelUnproject(view, x + .5, y + .5, &lat, &lon)) continue;
        double value = SampleBilinear(rain, GNLon(), GNLat(), lon, lat);
        if (!isfinite(value)) continue;
        double fade = fmax(0, fmin(1, (value - thresholdMm + .25) / .5));
        fade = fade * fade * (3 - 2 * fade);
        size_t index = ((size_t)y * w + x) * 4;
        pixels[index] = 71; pixels[index + 1] = 69; pixels[index + 2] = 64;
        pixels[index + 3] = (uint8_t)lrint(255 * kHatchAlpha * fade * coverage);
    }
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, pixels, bytes, ReleaseImageBuffer);
    CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image = CGImageCreate(w, h, 8, 32, w * 4, colors,
        kCGImageAlphaLast | kCGBitmapByteOrderDefault, provider, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(colors); CGDataProviderRelease(provider);
    if (image) { CGContextDrawImage(ctx, CGRectMake(0, 0, mapW, mapH), image); CGImageRelease(image); }
}

static void DrawLegend(CGContextRef ctx, double mapW, double mapH, NSString *caption, BOOL rain, BOOL observed) {
    double width = rain || observed ? 248 : 168;
    double height = rain || observed ? 62 : 44;
    double x = mapW - width - 8, y = mapH - height - 8;
    CGContextSetRGBFillColor(ctx, 0.98, 0.98, 0.97, 0.94);
    CGContextFillRect(ctx, CGRectMake(x, y, width, height));
    CGContextSetRGBStrokeColor(ctx, 0.28, 0.27, 0.25, 0.55);
    CGContextSetLineWidth(ctx, 0.8);
    CGContextStrokeRect(ctx, CGRectMake(x, y, width, height));
    NSFont *font = [NSFont fontWithName:@"Helvetica-Bold" size:11] ?: [NSFont boldSystemFontOfSize:11];
    NSColor *ink = [NSColor colorWithSRGBRed:0.12 green:0.11 blue:0.10 alpha:1];
    [caption drawAtPoint:NSMakePoint(x + 8, y + height - 16) withAttributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: ink}];
    const double t0 = -12, t1 = 28;
    int barW = (int)width - 16;
    double barY = y + (rain || observed ? 28 : 16);
    for (int i = 0; i < barW; i++) {
        double t = t0 + (t1 - t0) * i / (barW - 1);
        OwnRGB rgb = OwnTemperatureRGB(t);
        CGContextSetRGBFillColor(ctx, rgb.r, rgb.g, rgb.b, 1);
        CGContextFillRect(ctx, CGRectMake(x + 8 + i, barY, 1, 10));
    }
    NSFont *tickFont = [NSFont fontWithName:@"Helvetica" size:9] ?: [NSFont systemFontOfSize:9];
    NSArray *ticks = @[@"-12", @"0", @"12", @"24"];
    for (NSString *tick in ticks) {
        double value = tick.doubleValue;
        double frac = (value - t0) / (t1 - t0);
        double tx = x + 8 + (barW - 1) * frac;
        [tick drawAtPoint:NSMakePoint(tx - 8, barY - 12) withAttributes:@{NSFontAttributeName: tickFont, NSForegroundColorAttributeName: ink}];
    }
    if (rain || observed) {
        NSFont *note = [NSFont fontWithName:@"Helvetica" size:9] ?: tickFont;
        NSString *line = observed
            ? @"Observed rain since 9am (mm)"
            : OwnRainLegendText();
        if (rain && !observed) {
            CGContextSetRGBStrokeColor(ctx, 0.28, 0.27, 0.25, kHatchAlpha);
            CGContextSetLineWidth(ctx, kHatchWidth);
            CGContextBeginPath(ctx);
            for (int i = 0; i < 4; i++) {
                double hx = x + 10 + i * 6;
                CGContextMoveToPoint(ctx, hx, y + 12);
                CGContextAddLineToPoint(ctx, hx + 5, y + 4);
            }
            CGContextStrokePath(ctx);
            [line drawAtPoint:NSMakePoint(x + 36, y + 3) withAttributes:@{NSFontAttributeName: note, NSForegroundColorAttributeName: ink}];
        } else {
            [line drawAtPoint:NSMakePoint(x + 8, y + 3) withAttributes:@{NSFontAttributeName: note, NSForegroundColorAttributeName: ink}];
        }
    }
}

static void DrawWindBarb(CGContextRef ctx, double directionFrom, double speedKt,
                         double x, double y, double alpha) {
    OwnBarb barb = OwnWindBarb(directionFrom, speedKt, 13.5, YES);
    CGContextSetRGBStrokeColor(ctx, 0.13, 0.29, 0.39, alpha);
    CGContextSetRGBFillColor(ctx, 0.13, 0.29, 0.39, alpha);
    CGContextSetLineWidth(ctx, 1.45);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    if (barb.calm) {
        CGContextStrokeEllipseInRect(ctx, CGRectMake(x - 2.7, y - 2.7, 5.4, 5.4));
        return;
    }
    CGContextBeginPath(ctx);
    for (int i = 0; i < barb.nSeg; i++) {
        CGContextMoveToPoint(ctx, x + barb.segs[i].a.x, y + barb.segs[i].a.y);
        CGContextAddLineToPoint(ctx, x + barb.segs[i].b.x, y + barb.segs[i].b.y);
    }
    CGContextStrokePath(ctx);
    for (int i = 0; i < barb.nTri; i++) {
        CGContextBeginPath(ctx);
        CGContextMoveToPoint(ctx, x + barb.tri[i][0].x, y + barb.tri[i][0].y);
        CGContextAddLineToPoint(ctx, x + barb.tri[i][1].x, y + barb.tri[i][1].y);
        CGContextAddLineToPoint(ctx, x + barb.tri[i][2].x, y + barb.tri[i][2].y);
        CGContextClosePath(ctx);
        CGContextFillPath(ctx);
    }
}

typedef struct {
    double lat, lon, mm;
} StationRain;

typedef struct {
    double x, y, mm, width, height;
    NSString *text;
} ObservedRainLabel;

static BOOL ObservedRainBoxesOverlap(CGRect a, CGRect b, double padding) {
    return CGRectIntersectsRect(CGRectInset(a, -padding, -padding),
        CGRectInset(b, -padding, -padding));
}

static double ObservedRainPriority(double mm) {
    // Wet readings carry the useful signal at this zoom. Keep trace/zero
    // values available when there is room, but let them yield first in a
    // crowded station cluster.
    if (mm >= 1.0) return 1000.0 + mm;
    if (mm > 0.0) return 500.0 + mm;
    return 0.0;
}

typedef struct {
    int temperature; // 0 off, 1 the 850 hPa field, 2 the 2 m field
    int barbs;
    int rain;
    int observed; // Now frame only: station dots, and no model hatch
    int bare;     // map only, for the popover headings
    const char *legend;
    const StationRain *stations;
    int nStations;
    OwnMotionState *motionState;
} PanelOptions;

typedef struct {
    BOOL active;
    double level, x, y, angle, alpha;
    int age, missing;
} MotionLabelSlot;

typedef struct {
    BOOL active, high;
    double value, x, y, alpha;
    int age, missing;
} MotionCentreSlot;

@interface OwnMotionState () {
@public
    MotionLabelSlot _motionLabels[128];
    MotionCentreSlot _motionCentres[24];
    OwnExtremum _cachedExtrema[48];
    int _cachedExtremaCount;
    double _cachedExtremaHour;
    const void *_cachedExtremaCube;
    int _cachedExtremaNLon, _cachedExtremaNLat;
    BOOL _hasCachedExtrema;
    NSInteger _motionFrame;
    CGFloat _maxLabelStep, _maxCentreStep;
}
@end

@implementation OwnMotionState
- (CGFloat)maxLabelStep { return _maxLabelStep; }
- (CGFloat)maxCentreStep { return _maxCentreStep; }
@end

static void MotionMoveVector(double *x, double *y, double targetX, double targetY,
    double maxStep, double *stepOut) {
    double dx = targetX - *x, dy = targetY - *y;
    double distance = hypot(dx, dy);
    if (distance > maxStep && distance > 0) { dx *= maxStep / distance; dy *= maxStep / distance; }
    *x += dx; *y += dy;
    if (stepOut) *stepOut = hypot(dx, dy);
}

static double MotionContourAlpha(const OwnLine *line) {
    if (!line || !line->closed || line->count < 3) return 1.0;
    double minX = INFINITY, maxX = -INFINITY, minY = INFINITY, maxY = -INFINITY;
    for (int i = 0; i < line->count; i++) {
        minX = fmin(minX, line->pts[i].x); maxX = fmax(maxX, line->pts[i].x);
        minY = fmin(minY, line->pts[i].y); maxY = fmax(maxY, line->pts[i].y);
    }
    double span = fmax(maxX - minX, maxY - minY);
    double a = (span - 10.0) / 28.0;
    if (a < 0) a = 0;
    if (a > 1) a = 1;
    return a * a * (3.0 - 2.0 * a);
}

static int MotionUpdateLabels(OwnMotionState *state, const OwnLabel *candidates, int nCandidates,
    const OwnLine *lines, int nLines, const OwnVec *centres, int nCentres, BOOL allowSeeds) {
    if (!state) return 0;
    for (int s = 0; s < 128; s++) {
        MotionLabelSlot *slot = &state->_motionLabels[s];
        if (!slot->active) continue;
        int best = -1; double bestDistance = 14.0; OwnLabel tracked = {0};
        // Existing labels follow the nearest point on the current contour,
        // rather than jumping to whichever newly placed label won a sort.
        for (int li = 0; li < nLines; li++) {
            if (fabs(lines[li].level - slot->level) > 0.1 || lines[li].count < 2) continue;
            int last = lines[li].closed ? lines[li].count : lines[li].count - 1;
            for (int p = 0; p < last; p++) {
                OwnVec a = lines[li].pts[p], b = lines[li].pts[(p + 1) % lines[li].count];
                double vx = b.x - a.x, vy = b.y - a.y;
                double denom = vx * vx + vy * vy;
                double t = denom > 0 ? ((slot->x - a.x) * vx + (slot->y - a.y) * vy) / denom : 0;
                if (t < 0) t = 0; if (t > 1) t = 1;
                double px = a.x + t * vx, py = a.y + t * vy;
                double d = hypot(px - slot->x, py - slot->y);
                if (d < bestDistance) {
                    bestDistance = d; best = li;
                    tracked = (OwnLabel){px, py, OwnReadableAngle(atan2(vy, vx)), 0, 0, 0, 0, lines[li].level, li};
                }
            }
        }
        if (best >= 0) {
            double step = 0;
            MotionMoveVector(&slot->x, &slot->y, tracked.x, tracked.y, 2.0, &step);
            if (step > state->_maxLabelStep) state->_maxLabelStep = step;
            // Horizontal pressure labels are calmer and remain legible as a
            // contour bends through successive frames.
            slot->angle = 0;
            slot->missing = 0;
            slot->age++;
        } else {
            slot->missing++;
            slot->alpha -= 0.1;
            if (slot->alpha <= 0) slot->active = NO;
        }
    }
    for (int s = 0; s < 128; s++) {
        MotionLabelSlot *slot = &state->_motionLabels[s];
        if (!slot->active || slot->missing) continue;
        double target = 1;
        for (int c = 0; c < nCentres; c++)
            target = fmin(target, fmax(0, fmin(1, (hypot(slot->x-centres[c].x, slot->y-centres[c].y)-35)/20)));
        for (int t = 0; t < 128; t++) {
            MotionLabelSlot *older = &state->_motionLabels[t];
            if (!older->active || t == s || older->age < slot->age ||
                (older->age == slot->age && t > s)) continue;
            double minimum = fabs(older->level-slot->level) < .1 ? 70 : 38;
            target = fmin(target, fmax(0, fmin(1, (hypot(slot->x-older->x,slot->y-older->y)-minimum)/20)));
        }
        slot->alpha += (target - slot->alpha) * .18;
    }
    if (allowSeeds) {
        for (int c = 0; c < nCandidates && c < 80; c++) {
            BOOL close = NO;
            int active = 0;
            for (int s = 0; s < 128; s++) if (state->_motionLabels[s].active) active++;
            if (active >= 20) break;
            for (int s = 0; s < 128; s++) {
                MotionLabelSlot *slot = &state->_motionLabels[s];
                if (slot->active && hypot(slot->x - candidates[c].x, slot->y - candidates[c].y) < 80) { close = YES; break; }
            }
            if (close) continue;
            for (int s = 0; s < 128; s++) {
                MotionLabelSlot *slot = &state->_motionLabels[s];
                if (!slot->active) {
                    *slot = (MotionLabelSlot){YES, candidates[c].level, candidates[c].x,
                        candidates[c].y, 0, state.immediateAnnotations ? 1 : 0.25, 1, 0};
                    break;
                }
            }
        }
    }
    int active = 0;
    for (int s = 0; s < 128; s++) if (state->_motionLabels[s].active) active++;
    return active;
}

static int MotionUpdateCentres(OwnMotionState *state, const OwnExtremum *candidates, int nCandidates,
    OwnVec *visible, int cap) {
    if (!state) return 0;
    BOOL used[48] = {0};
    for (int s = 0; s < 24; s++) {
        MotionCentreSlot *slot = &state->_motionCentres[s];
        if (!slot->active) continue;
        int best = -1; double bestDistance = 70.0;
        for (int c = 0; c < nCandidates && c < 48; c++) {
            if (used[c] || candidates[c].high != slot->high) continue;
            double d = hypot(candidates[c].x - slot->x, candidates[c].y - slot->y);
            if (d < bestDistance) { bestDistance = d; best = c; }
        }
        if (best >= 0) {
            used[best] = YES;
            double nx = slot->x, ny = slot->y;
            MotionMoveVector(&nx, &ny, candidates[best].x, candidates[best].y, 2.0, NULL);
            double step = hypot(nx - slot->x, ny - slot->y);
            if (step > state->_maxCentreStep) state->_maxCentreStep = step;
            slot->x = nx; slot->y = ny; slot->value = candidates[best].value;
            slot->missing = 0; slot->age++; slot->alpha += (1.0 - slot->alpha) * 0.25;
        } else {
            slot->missing++; slot->alpha -= 0.1;
            if (slot->alpha <= 0) slot->active = NO;
        }
    }
    for (int c = 0; c < nCandidates && c < 48; c++) {
        if (used[c]) continue;
        BOOL nearExisting = NO;
        for (int s = 0; s < 24; s++) {
            MotionCentreSlot *slot = &state->_motionCentres[s];
            if (slot->active && slot->high == candidates[c].high &&
                hypot(slot->x - candidates[c].x, slot->y - candidates[c].y) < 45) { nearExisting = YES; break; }
        }
        if (nearExisting) continue;
        int active = 0;
        for (int s = 0; s < 24; s++) if (state->_motionCentres[s].active) active++;
        if (active >= 6) break;
        for (int s = 0; s < 24; s++) if (!state->_motionCentres[s].active) {
            state->_motionCentres[s] = (MotionCentreSlot){YES, candidates[c].high, candidates[c].value,
                candidates[c].x, candidates[c].y, state.immediateAnnotations ? 1 : 0,
                state.immediateAnnotations ? 3 : 1, 0};
            break;
        }
    }
    int count = 0;
    for (int s = 0; s < 24 && count < cap; s++) {
        MotionCentreSlot *slot = &state->_motionCentres[s];
        if (slot->active && slot->age >= 3 && slot->alpha > 0) visible[count++] = (OwnVec){slot->x, slot->y};
    }
    return count;
}

// A centre has to be the extreme of a 4° disk, then stand out from an 8–11° ring.
// Immediate-neighbour relief on a 0.25° grid promotes a one-cell bump over the
// broad Bight high, whose peak is only a few hundredths above the next cell.
static double RingAnomaly(const double *field, int nLon, int nLat, double longitude, double latitude) {
    double centre = SampleBilinear(field, nLon, nLat, longitude, latitude);
    if (!isfinite(centre)) return 0;
    double sum = 0;
    int n = 0;
    const double radii[] = {8.0, 11.0};
    for (int r = 0; r < 2; r++) {
        for (int k = 0; k < 12; k++) {
            double ang = k * (M_PI / 6.0);
            double lat = latitude + radii[r] * sin(ang);
            double lon = longitude + radii[r] * cos(ang);
            double value = SampleBilinear(field, nLon, nLat, lon, lat);
            if (!isfinite(value)) continue;
            sum += value;
            n++;
        }
    }
    if (n < 12) return 0;
    return centre - sum / n;
}

static BOOL MaskNear(const uint8_t *mask, int nLon, int nLat, double lon, double lat, int rad) {
    if (!mask) return NO;
    double step = GStep();
    int i = (int)llround((lon - GWest()) / step);
    int j = (int)llround((GNorth() - lat) / step);
    for (int dj = -rad; dj <= rad; dj++) {
        for (int di = -rad; di <= rad; di++) {
            if (di * di + dj * dj > rad * rad) continue;
            int ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nLon || jj >= nLat) continue;
            if (mask[jj * nLon + ii]) return YES;
        }
    }
    return NO;
}

static int SynopticCentres(const double *field, int nLon, int nLat,
    const uint8_t *land, const uint8_t *rough, OwnExtremum *out, int cap) {
    if (!field || !out || cap <= 0) return 0;
    double step = GStep();
    int rad = (int)llround(4.0 / step);
    if (rad < 2) rad = 2;
    typedef struct { double value, score, lon, lat; int high; } Cand;
    int maxCand = 64;
    Cand *cands = malloc((size_t)maxCand * sizeof(Cand));
    if (!cands) return 0;
    // Prefix sums let us check the disk's mean in O(radius), before the much
    // more expensive per-cell extremum scan. Flat ridges fail this test.
    size_t pitch = (size_t)nLon + 1;
    double *rowSums = calloc((size_t)nLat * pitch, sizeof(double));
    int *rowCounts = calloc((size_t)nLat * pitch, sizeof(int));
    if (!rowSums || !rowCounts) {
        free(rowSums); free(rowCounts); free(cands);
        return 0;
    }
    for (int j = 0; j < nLat; j++) {
        for (int i = 0; i < nLon; i++) {
            double value = field[j * nLon + i];
            rowSums[(size_t)j*pitch+i+1] = rowSums[(size_t)j*pitch+i] + (isfinite(value) ? value : 0);
            rowCounts[(size_t)j*pitch+i+1] = rowCounts[(size_t)j*pitch+i] + isfinite(value);
        }
    }
    int n = 0;
    for (int j = rad; j < nLat - rad; j++) {
        for (int i = rad; i < nLon - rad; i++) {
            double z = field[j * nLon + i];
            if (!isfinite(z)) continue;
            double lon = GWest() + i * step;
            double lat = GNorth() - j * step;
            if (lon < kViewWest || lon > kViewEast || lat < kViewSouth || lat > kViewNorth) continue;
            // The eight immediate neighbours are a subset of the disk below.
            // Match the disk's tolerance so a shallow but valid centre is
            // never discarded by the cheap immediate-neighbour check.
            BOOL localLow = YES, localHigh = YES;
            for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
                if (!di && !dj) continue;
                double nearby = field[(j + dj) * nLon + i + di];
                if (!isfinite(nearby)) { localLow = NO; localHigh = NO; }
                if (nearby < z - .05) localLow = NO;
                if (nearby > z + .05) localHigh = NO;
            }
            if (!localLow && !localHigh) continue;
            int rad2 = rad * rad;
            double quickSum = 0;
            int quickSeen = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                int reach = (int)floor(sqrt((double)(rad2 - dj*dj)));
                size_t row = (size_t)(j+dj)*pitch;
                quickSum += rowSums[row+i+reach+1] - rowSums[row+i-reach];
                quickSeen += rowCounts[row+i+reach+1] - rowCounts[row+i-reach];
            }
            if (quickSeen < 20) continue;
            double quickMean = quickSum / quickSeen;
            // Leave a tiny rounding margin; the exact scan below remains the
            // authority for every candidate that might pass.
            if (localLow && z >= quickMean - .8 + 1e-8) localLow = NO;
            if (localHigh && z <= quickMean + .8 - 1e-8) localHigh = NO;
            if (!localLow && !localHigh) continue;
            BOOL low = YES, high = YES;
            double sum = 0;
            int seen = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                for (int di = -rad; di <= rad; di++) {
                    if (di * di + dj * dj > rad2) continue;
                    double value = field[(j + dj) * nLon + (i + di)];
                    if (!isfinite(value)) { low = NO; high = NO; continue; }
                    if (value < z - 0.05) low = NO;
                    if (value > z + 0.05) high = NO;
                    sum += value;
                    seen++;
                }
            }
            if (seen < 20) continue;
            double mean = sum / seen;
            int kind = -1;
            if (low && z < mean - 0.8) kind = 0;
            else if (high && z > mean + 0.8) kind = 1;
            if (kind < 0) continue;
            if (n >= maxCand) {
                maxCand *= 2;
                Cand *grown = realloc(cands, (size_t)maxCand * sizeof(Cand));
                if (!grown) break;
                cands = grown;
            }
            cands[n++] = (Cand){z, 0, lon, lat, kind};
        }
    }
    int nLow = 0;
    for (int a = 0; a < n; a++) {
        if (cands[a].high) continue;
        Cand tmp = cands[nLow];
        cands[nLow++] = cands[a];
        cands[a] = tmp;
    }
    for (int pass = 0; pass < 2; pass++) {
        int begin = pass == 0 ? 0 : nLow;
        int end = pass == 0 ? nLow : n;
        int descending = pass;
        for (int a = begin + 1; a < end; a++) {
            Cand key = cands[a];
            int b = a;
            while (b > begin && (descending ? cands[b - 1].value < key.value : cands[b - 1].value > key.value)) {
                cands[b] = cands[b - 1];
                b--;
            }
            cands[b] = key;
        }
    }
    Cand kept[48];
    int nKept = 0;
    for (int a = 0; a < n && nKept < 48; a++) {
        BOOL near = NO;
        for (int b = 0; b < nKept; b++) {
            if (cands[a].high != kept[b].high) continue;
            if (hypot(cands[a].lon - kept[b].lon, cands[a].lat - kept[b].lat) < 5.5) { near = YES; break; }
        }
        if (!near) kept[nKept++] = cands[a];
    }
    free(cands);
    free(rowSums);
    free(rowCounts);
    for (int a = 0; a < nKept; a++) {
        kept[a].score = RingAnomaly(field, nLon, nLat, kept[a].lon, kept[a].lat);
        if (kept[a].high != (kept[a].score > 0)) kept[a].score = 0;
    }
    for (int a = 1; a < nKept; a++) {
        Cand key = kept[a];
        int b = a;
        while (b > 0 && fabs(kept[b - 1].score) < fabs(key.score)) {
            kept[b] = kept[b - 1];
            b--;
        }
        kept[b] = key;
    }
    int written = 0;
    for (int a = 0; a < nKept && written < cap; a++) {
        if (fabs(kept[a].score) < 2.2) continue;
        // A 1019 high in the equatorial trough and a 1026 col are local extrema,
        // but they are not the closed centres a Bureau MSLP chart marks. Keep a
        // weak one only when it stands well clear of the ring around it.
        if (kept[a].high) {
            if (kept[a].value < 1024.0 && fabs(kept[a].score) < 6.0) continue;
        } else if (kept[a].value > 1020.0 && fabs(kept[a].score) < 6.0) {
            continue;
        }
        // Spikes over high terrain are not centres. A synoptic low at or below
        // 1016 hPa, or a high at or above 1030, can sit on smooth land — the
        // Western Australian lows do — and still be marked.
        if (MaskNear(rough, nLon, nLat, kept[a].lon, kept[a].lat, 3) && fabs(kept[a].score) < 5.5)
            continue;
        if (MaskNear(land, nLon, nLat, kept[a].lon, kept[a].lat, 0) && fabs(kept[a].score) < 3.2) {
            BOOL synoptic = kept[a].high ? kept[a].value >= 1030.0 : kept[a].value <= 1016.0;
            if (!synoptic) continue;
        }
        double ox = 0, oy = 0;
        int i = (int)llround((kept[a].lon - GWest()) / step);
        int j = (int)llround((GNorth() - kept[a].lat) / step);
        if (i > 0 && i < nLon - 1 && j > 0 && j < nLat - 1) {
            double zm = field[j * nLon + (i - 1)];
            double zp = field[j * nLon + (i + 1)];
            double denom = zm - 2.0 * kept[a].value + zp;
            if (isfinite(denom) && fabs(denom) > 1e-6) {
                ox = 0.5 * (zm - zp) / denom;
                if (ox > 0.75) ox = 0.75;
                if (ox < -0.75) ox = -0.75;
            }
            zm = field[(j - 1) * nLon + i];
            zp = field[(j + 1) * nLon + i];
            denom = zm - 2.0 * kept[a].value + zp;
            if (isfinite(denom) && fabs(denom) > 1e-6) {
                oy = 0.5 * (zm - zp) / denom;
                if (oy > 0.75) oy = 0.75;
                if (oy < -0.75) oy = -0.75;
            }
        }
        out[written++] = (OwnExtremum){
            GWest() + (i + ox) * step,
            GNorth() - (j + oy) * step,
            kept[a].value,
            kept[a].high,
        };
    }
    return written;
}

static void RenderPanel(CGContextRef ctx, double originX, double originY, const Cube *cube, double hour,
    NSString *title, OwnCoast coast, const uint8_t *landMask, const RingSpan *spans, PanelOptions options) {
    AdoptCubeGrid(cube);
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, originX, originY);
    NSGraphicsContext *graphics = [NSGraphicsContext graphicsContextWithCGContext:ctx flipped:NO];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:graphics];

    MSLPColour sea = MSLPColourSea();
    MSLPColour land = MSLPColourLand();
    MSLPColour ink = MSLPColourInk();
    MSLPColour titleColour = MSLPColourTitle();
    if (!options.bare) {
        CGContextSetRGBFillColor(ctx, titleColour.red, titleColour.green, titleColour.blue, 1);
        CGContextFillRect(ctx, CGRectMake(0, kMapH, kPanelW, kTitleH));
        NSFont *titleFont = [NSFont fontWithName:@"Helvetica-Bold" size:13] ?: [NSFont boldSystemFontOfSize:13];
        NSString *mark = @"ECMWF · CC BY 4.0";
        [title drawAtPoint:NSMakePoint(8, kMapH + 6) withAttributes:@{
            NSFontAttributeName: titleFont,
            NSForegroundColorAttributeName: NSColor.whiteColor,
        }];
        NSFont *markFont = [NSFont fontWithName:@"Helvetica" size:9] ?: [NSFont systemFontOfSize:9];
        NSSize markSize = [mark sizeWithAttributes:@{NSFontAttributeName: markFont}];
        [mark drawAtPoint:NSMakePoint(kPanelW - markSize.width - 8, kMapH + 8) withAttributes:@{
            NSFontAttributeName: markFont,
            NSForegroundColorAttributeName: [NSColor colorWithWhite:1 alpha:0.85],
        }];
    }

    CGContextSaveGState(ctx);
    CGContextClipToRect(ctx, CGRectMake(0, 0, kPanelW, kMapH));
    CGContextSetRGBFillColor(ctx, sea.red, sea.green, sea.blue, 1);
    CGContextFillRect(ctx, CGRectMake(0, 0, kPanelW, kMapH));

    OwnView view = OwnViewMake(OwnAustraliaLambert(), kViewWest, kViewEast, kViewSouth, kViewNorth,
        0, 0, kPanelW, kMapH);

    CGContextBeginPath(ctx);
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        BOOL moved = NO;
        for (int i = 0; i < n; i++) {
            double x, y;
            if (!OwnViewProject(view, coast.lat[start + i], coast.lon[start + i], &x, &y)) { moved = NO; continue; }
            double yUp = kMapH - y;
            if (!moved) { CGContextMoveToPoint(ctx, x, yUp); moved = YES; }
            else CGContextAddLineToPoint(ctx, x, yUp);
        }
        CGContextClosePath(ctx);
    }
    CGContextSetRGBFillColor(ctx, land.red, land.green, land.blue, 1);
    CGContextEOFillPath(ctx);

    double *mslp = ScalarField(cube, VarMSLP, hour);
    uint8_t *rough = NULL;
    if (mslp && landMask) {
        if (options.motionState) {
            rough = calloc((size_t)cube->nPoints, 1);
            SmoothLandMSLPMotion(mslp, landMask, cube->nLon, cube->nLat, rough);
        } else {
            rough = calloc((size_t)cube->nPoints, 1);
            if (rough) SmoothLandMSLP(mslp, landMask, cube->nLon, cube->nLat, rough);
        }
    }
    double *temp = NULL;
    if (options.temperature == 1) temp = ScalarField(cube, VarT850, hour);
    else if (options.temperature == 2) temp = ScalarField(cube, VarT2M, hour);
    if (temp) {
        CGImageRef shade = TemperatureImage(temp, view, kPanelW, kMapH, 0.50);
        if (shade) {
            CGContextDrawImage(ctx, CGRectMake(0, 0, kPanelW, kMapH), shade);
            CGImageRelease(shade);
        }
    }

    CGContextBeginPath(ctx);
    // Greyer and thinner than the isobars, so a coast does not read as a pressure line.
    CGContextSetLineWidth(ctx, 0.65);
    CGContextSetRGBStrokeColor(ctx, 0.55, 0.53, 0.49, 0.95);
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        BOOL moved = NO;
        for (int i = 0; i < n; i++) {
            double x, y;
            if (!OwnViewProject(view, coast.lat[start + i], coast.lon[start + i], &x, &y)) { moved = NO; continue; }
            double yUp = kMapH - y;
            if (!moved) { CGContextMoveToPoint(ctx, x, yUp); moved = YES; }
            else CGContextAddLineToPoint(ctx, x, yUp);
        }
        if (moved) CGContextClosePath(ctx);
    }
    CGContextStrokePath(ctx);

    OwnVec avoidPts[160];
    int nAvoid = 0;
    if (options.rain && !options.observed) {
        double *rain = RainField(cube, hour);
        if (rain) DrawHatch(ctx, rain, view, kPanelW, kMapH, kRainMm, options.motionState != nil);
        free(rain);
    }

    OwnVec centers[48];
    int nCenters = 0;
    OwnExtremum extrema[48];
    OwnExtremum motionExtrema[48];
    int nExt = 0;
    if (mslp) {
        OwnMotionState *state=options.motionState;
        // Centres evolve on a synoptic timescale. Reuse their candidates for
        // nearby frames; the tracked markers ease toward each new position.
        if (state && state->_hasCachedExtrema && state->_cachedExtremaCube == cube &&
            state->_cachedExtremaNLon == cube->nLon && state->_cachedExtremaNLat == cube->nLat &&
            fabs(hour-state->_cachedExtremaHour)<0.5) {
            nExt=state->_cachedExtremaCount;
            memcpy(extrema,state->_cachedExtrema,(size_t)nExt*sizeof(OwnExtremum));
        } else {
            nExt = SynopticCentres(mslp, cube->nLon, cube->nLat, landMask,
                rough, extrema, 6);
            if (state) {
                state->_cachedExtremaCount=nExt;
                memcpy(state->_cachedExtrema,extrema,(size_t)nExt*sizeof(OwnExtremum));
                state->_cachedExtremaHour=hour;
                state->_cachedExtremaCube=cube;
                state->_cachedExtremaNLon=cube->nLon;
                state->_cachedExtremaNLat=cube->nLat;
                state->_hasCachedExtrema=YES;
            }
        }
        int drawn = 0;
        for (int e = 0; e < nExt; e++) {
            double sampled = SampleBilinear(mslp, cube->nLon, cube->nLat, extrema[e].x, extrema[e].y);
            if (isfinite(sampled)) extrema[e].value = sampled;
            double x, y;
            if (!OwnViewProject(view, extrema[e].y, extrema[e].x, &x, &y)) continue;
            double yUp = kMapH - y;
            if (x < 18 || x > kPanelW - 18 || yUp < 18 || yUp > kMapH - 18) continue;
            extrema[drawn] = extrema[e];
            if (drawn < 48) {
                centers[drawn] = (OwnVec){x, yUp};
                motionExtrema[drawn] = extrema[e];
                motionExtrema[drawn].x = x;
                motionExtrema[drawn].y = yUp;
            }
            drawn++;
        }
        nExt = drawn;
        nCenters = drawn;
        if (options.motionState) {
            nCenters = MotionUpdateCentres(options.motionState, motionExtrema, nExt, centers, 48);
        }
    }

    // Temperature uses colour alone; linework is reserved for pressure.

    if (mslp) {
        double lo = 0, hi = 0;
        FieldRange(mslp, cube->nPoints, &lo, &hi);
        double levels[56];
        int nLevels = options.motionState ? 0 : OwnInteriorLevels(lo, hi, 4, levels, 56);
        if (options.motionState) {
            // Keep the fixed pressure lattice, but do not scan the entire
            // grid for levels that cannot cross this frame's field.
            for (double level = 880; level <= 1080.001; level += 4)
                if (level >= lo && level <= hi) levels[nLevels++] = level;
        }
        OwnLineSet raw = OwnContours(mslp, cube->nLon, cube->nLat, GWest(), GNorth(),
            GStep(), -GStep(), levels, nLevels);
        if (!options.motionState) DropSmallClosed(&raw, 3.0);
        OwnLineSet lines = ProjectContours(raw, view, kMapH);
        OwnLineSetFree(raw);

        NSFont *labelFont = [NSFont fontWithName:@"Helvetica-Bold" size:15] ?: [NSFont boldSystemFontOfSize:15];
        OwnLabel labels[80];
        int nLabels = OwnPlaceLabels(lines.lines, lines.count, LabelHalf, (__bridge void *)labelFont, 8, 6,
            16, 16, kPanelW - 16, kMapH - 16, labels, 80);
        OwnLabel motionSeeds[80];
        int nMotionSeeds = 0;
        if (options.motionState) {
            // Candidate placement is deliberately sparse. Existing tracks
            // follow their contour segment every frame; only this seed pass
            // is allowed to introduce a new annotation.
            memcpy(motionSeeds, labels, (size_t)nLabels * sizeof(OwnLabel));
            nMotionSeeds = ThinLabels(motionSeeds, nLabels, lines.lines, view, kMapH, coast, spans,
                centers, nCenters, 8.0, 80, 55);
        } else {
            nLabels = ThinLabels(labels, nLabels, lines.lines, view, kMapH, coast, spans,
                centers, nCenters, 6.0, 46, 48);
        }
        int visibleMotionLabels = options.motionState ? MotionUpdateLabels(options.motionState, motionSeeds, nMotionSeeds,
            lines.lines, lines.count, centers, nCenters, options.motionState->_motionFrame == 1 ||
                (options.motionState->_motionFrame % 30) == 0) : 0;
        for (int L = 0; L < nLabels && nAvoid < 160; L++)
            avoidPts[nAvoid++] = (OwnVec){labels[L].x, labels[L].y};

        for (int i = 0; i < lines.count; i++) {
            OwnLabel mine[8];
            int mineCount = 0;
            for (int L = 0; L < nLabels && mineCount < 8; L++) {
                if (labels[L].line == i) mine[mineCount++] = labels[L];
            }
            if (options.motionState) {
                // Motion frames keep every contour continuous. Label tracking
                // is visual annotation only; it never cuts a line underneath.
                StrokeLine(ctx, lines.lines[i].pts, lines.lines[i].count, lines.lines[i].closed,
                    NULL, 0, 0, 1.55, ink.red, ink.green, ink.blue, MotionContourAlpha(&lines.lines[i]));
            } else if (mineCount == 0) {
                StrokeLine(ctx, lines.lines[i].pts, lines.lines[i].count, lines.lines[i].closed,
                    centers, nCenters, 18, 1.55, ink.red, ink.green, ink.blue, 1);
            } else {
                OwnLineSet parts = OwnCutGaps(lines.lines[i].pts, lines.lines[i].count, lines.lines[i].closed, mine, mineCount);
                for (int p = 0; p < parts.count; p++) {
                    StrokeLine(ctx, parts.lines[p].pts, parts.lines[p].count, 0,
                        centers, nCenters, 18, 1.55, ink.red, ink.green, ink.blue, 1);
                }
                OwnLineSetFree(parts);
            }
        }
        NSColor *inkColor = [NSColor colorWithSRGBRed:ink.red green:ink.green blue:ink.blue alpha:1];
        for (int L = 0; L < nLabels && !options.motionState; L++) {
            NSString *text = [NSString stringWithFormat:@"%.0f", labels[L].level];
            DrawText(ctx, text, labelFont, inkColor, labels[L].x, labels[L].y, labels[L].angle);
        }
        if (options.motionState) {
            for (int s = 0; s < 128; s++) {
                MotionLabelSlot *slot = &options.motionState->_motionLabels[s];
                if (!slot->active || slot->alpha <= 0) continue;
                NSString *text = [NSString stringWithFormat:@"%.0f", slot->level];
                NSColor *plate = [NSColor colorWithWhite:0.96 alpha:0.24 * slot->alpha];
                NSSize size = [text sizeWithAttributes:@{NSFontAttributeName: labelFont}];
                CGContextSaveGState(ctx);
                CGContextTranslateCTM(ctx, slot->x, slot->y);
                CGContextRotateCTM(ctx, slot->angle);
                CGContextSetFillColorWithColor(ctx, plate.CGColor);
                CGRect plateRect = CGRectMake(-size.width * 0.5 - 2,
                    -size.height * 0.5 - 1, size.width + 4, size.height + 2);
                CGPathRef platePath = CGPathCreateWithRoundedRect(plateRect, 2.0, 2.0, NULL);
                CGContextAddPath(ctx, platePath);
                CGContextFillPath(ctx);
                CGPathRelease(platePath);
                CGContextRestoreGState(ctx);
                NSColor *motionInk = [NSColor colorWithSRGBRed:ink.red green:ink.green blue:ink.blue alpha:slot->alpha];
                DrawText(ctx, text, labelFont, motionInk, slot->x, slot->y, slot->angle);
            }
            (void)visibleMotionLabels;
        }
        NSFont *letterFont = [NSFont fontWithName:@"Helvetica-Bold" size:18] ?: [NSFont boldSystemFontOfSize:18];
        NSFont *valueFont = [NSFont fontWithName:@"Helvetica-Bold" size:11] ?: [NSFont boldSystemFontOfSize:11];
        CGContextSetRGBStrokeColor(ctx, ink.red, ink.green, ink.blue, 1);
        CGContextSetLineWidth(ctx, 1.15);
        for (int e = 0; e < nExt && !options.motionState; e++) {
            double x = centers[e].x, yUp = centers[e].y;
            // Bureau centres are a saltire, not a plus.
            CGContextMoveToPoint(ctx, x - 4.2, yUp - 4.2);
            CGContextAddLineToPoint(ctx, x + 4.2, yUp + 4.2);
            CGContextMoveToPoint(ctx, x - 4.2, yUp + 4.2);
            CGContextAddLineToPoint(ctx, x + 4.2, yUp - 4.2);
            CGContextStrokePath(ctx);
            DrawText(ctx, extrema[e].high ? @"H" : @"L", letterFont, inkColor, x, yUp + 14, 0);
            DrawText(ctx, [NSString stringWithFormat:@"%.0f", round(extrema[e].value)], valueFont, inkColor, x, yUp - 16, 0);
        }
        if (options.motionState) {
            NSFont *motionLetter = [NSFont fontWithName:@"Helvetica-Bold" size:18] ?: [NSFont boldSystemFontOfSize:18];
            NSFont *motionValue = [NSFont fontWithName:@"Helvetica-Bold" size:11] ?: [NSFont boldSystemFontOfSize:11];
            for (int s = 0; s < 24; s++) {
                MotionCentreSlot *slot = &options.motionState->_motionCentres[s];
                if (!slot->active || slot->age < 3 || slot->alpha <= 0) continue;
                CGContextSetRGBStrokeColor(ctx, ink.red, ink.green, ink.blue, slot->alpha);
                CGContextSetLineWidth(ctx, 1.15);
                CGContextMoveToPoint(ctx, slot->x - 4.2, slot->y - 4.2);
                CGContextAddLineToPoint(ctx, slot->x + 4.2, slot->y + 4.2);
                CGContextMoveToPoint(ctx, slot->x - 4.2, slot->y + 4.2);
                CGContextAddLineToPoint(ctx, slot->x + 4.2, slot->y - 4.2);
                CGContextStrokePath(ctx);
                NSColor *centreInk = [NSColor colorWithSRGBRed:ink.red green:ink.green blue:ink.blue alpha:slot->alpha];
                DrawText(ctx, slot->high ? @"H" : @"L", motionLetter, centreInk, slot->x, slot->y + 14, 0);
                DrawText(ctx, [NSString stringWithFormat:@"%.0f", round(slot->value)], motionValue, centreInk, slot->x, slot->y - 16, 0);
            }
        }
#ifndef ISOBAR_APP
        fprintf(stderr, "  isobars %d labels %d centres %d  pressure %.0f–%.0f\n",
            lines.count, nLabels, nExt, lo, hi);
        for (int e = 0; e < nExt; e++) {
            fprintf(stderr, "    %s %.0f at %.1fS %.1fE\n", extrema[e].high ? "H" : "L",
                round(extrema[e].value), fabs(extrema[e].y), extrema[e].x);
        }
#endif
        OwnLineSetFree(lines);
    }

    if (options.barbs) {
        // Sparse, geographically fixed samples do not jump as the time changes.
        const double barbStep = 8.0;
        for (double lat = ceil(kViewSouth / barbStep) * barbStep; lat <= kViewNorth; lat += barbStep) {
            for (double lon = ceil(kViewWest / barbStep) * barbStep; lon <= kViewEast; lon += barbStep) {
                double fi = (lon - GWest()) / GStep();
                double fj = (GNorth() - lat) / GStep();
                int i = (int)llround(fi);
                int j = (int)llround(fj);
                if (i < 0 || j < 0 || i >= cube->nLon || j >= cube->nLat) continue;
                int point = j * cube->nLon + i;
                float speed = CubeAtFraction(cube, VarWSpd, point, hour);
                float direction = CubeAtFraction(cube, VarWDir, point, hour);
                if (!isfinite(speed) || !isfinite(direction)) continue;
                double x, y;
                if (!OwnViewProject(view, lat, lon, &x, &y)) continue;
                double yUp = kMapH - y;
                if (x < 20 || x > kPanelW - 34 || yUp < 20 || yUp > kMapH - 20) continue;
                BOOL near = NO;
                double samplesX[3] = {x - 6, x + 6, x + 25};
                double samplesY[3] = {yUp, yUp, yUp};
                for (int s = 0; s < 3 && !near; s++) {
                    for (int c = 0; c < nCenters; c++) {
                        if (hypot(samplesX[s] - centers[c].x, samplesY[s] - centers[c].y) < 40) { near = YES; break; }
                    }
                    for (int a = 0; a < nAvoid && !near; a++) {
                        if (hypot(samplesX[s] - avoidPts[a].x, samplesY[s] - avoidPts[a].y) < 28) near = YES;
                    }
                }
                if (near && !options.motionState) continue;
                double barbAlpha = 0.72;
                if (options.motionState) {
                    for (int s = 0; s < 128; s++) {
                        MotionLabelSlot *label = &options.motionState->_motionLabels[s];
                        if (!label->active || label->alpha <= 0) continue;
                        double d = hypot(x - label->x, yUp - label->y);
                        if (d < 36) barbAlpha = fmin(barbAlpha, 0.22 + 0.50 * d / 36.0);
                    }
                    for (int s = 0; s < 24; s++) {
                        MotionCentreSlot *centre = &options.motionState->_motionCentres[s];
                        if (!centre->active || centre->alpha <= 0) continue;
                        double d = hypot(x - centre->x, yUp - centre->y);
                        if (d < 42) barbAlpha = fmin(barbAlpha, 0.22 + 0.50 * d / 42.0);
                    }
                }
                DrawWindBarb(ctx, direction, speed, x, yUp, barbAlpha);
            }
        }
    }

    if (options.observed && options.stations && options.nStations > 0) {
        NSFont *valueFont = [NSFont fontWithName:@"Helvetica-Bold" size:9] ?: [NSFont boldSystemFontOfSize:9];
        NSColor *ink = [NSColor colorWithSRGBRed:0.12 green:0.11 blue:0.10 alpha:1];
        ObservedRainLabel candidates[48];
        CGRect stationDots[48];
        int nStationDots = 0;
        int nCandidates = 0;
        for (int s = 0; s < options.nStations; s++) {
            if (!isfinite(options.stations[s].mm)) continue;
            double x, y;
            if (!OwnViewProject(view, options.stations[s].lat, options.stations[s].lon, &x, &y)) continue;
            double yUp = kMapH - y;
            if (x < 8 || x > kPanelW - 28 || yUp < 8 || yUp > kMapH - 8) continue;
            CGContextSetRGBFillColor(ctx, 0.15, 0.15, 0.16, options.stations[s].mm >= 1 ? 0.95 : 0.45);
            CGContextFillEllipseInRect(ctx, CGRectMake(x - 2.4, yUp - 2.4, 4.8, 4.8));
            if (nStationDots < 48)
                stationDots[nStationDots++] = CGRectMake(x - 5, yUp - 5, 10, 10);
            NSString *text = [NSString stringWithFormat:@"%.1f", options.stations[s].mm];
            if (nCandidates >= 48) continue;
            NSSize size = [text sizeWithAttributes:@{NSFontAttributeName: valueFont}];
            candidates[nCandidates++] = (ObservedRainLabel){x, yUp + 1, options.stations[s].mm,
                size.width + 2, size.height + 1, text};
        }

        // Claim the strongest readings first. This keeps the labels useful
        // when a dense city/station cluster is projected into a small map.
        for (int i = 1; i < nCandidates; i++) {
            ObservedRainLabel key = candidates[i];
            int j = i;
            while (j > 0 && ObservedRainPriority(candidates[j - 1].mm) <
                ObservedRainPriority(key.mm)) {
                candidates[j] = candidates[j - 1];
                j--;
            }
            candidates[j] = key;
        }

        CGRect placed[48];
        int nPlaced = 0;
        // Keep labels close to their dots, but give each reading a few
        // sensible escape routes. There is no jitter, so a label remains
        // stable as the frame advances.
        for (int i = 0; i < nCandidates; i++) {
            ObservedRainLabel candidate = candidates[i];
            CGRect chosen = CGRectZero;
            BOOL found = NO;
            double dx = 5 + 3 + candidate.width * 0.5;
            double dy = 5 + 3 + candidate.height * 0.5;
            const double offsets[8][2] = {
                {dx, 0}, {-dx, 0}, {0, dy}, {0, -dy},
                {dx * 0.82, dy * 0.82}, {-dx * 0.82, dy * 0.82},
                {dx * 0.82, -dy * 0.82}, {-dx * 0.82, -dy * 0.82}
            };
            for (size_t o = 0; o < 8; o++) {
                double cx = candidate.x + offsets[o][0];
                double cy = candidate.y + offsets[o][1];
                CGRect box = CGRectMake(cx - candidate.width * 0.5,
                    cy - candidate.height * 0.5, candidate.width, candidate.height);
                if (CGRectGetMinX(box) < 8 || CGRectGetMaxX(box) > kPanelW - 8 ||
                    CGRectGetMinY(box) < 8 || CGRectGetMaxY(box) > kMapH - 8) continue;
                BOOL blocked = NO;
                for (int p = 0; p < nPlaced && !blocked; p++)
                    blocked = ObservedRainBoxesOverlap(box, placed[p], 2.0);
                for (int p = 0; p < nStationDots && !blocked; p++)
                    blocked = ObservedRainBoxesOverlap(box, stationDots[p], 1.0);
                for (int p = 0; p < nAvoid && !blocked; p++)
                    blocked = ObservedRainBoxesOverlap(box,
                        CGRectMake(avoidPts[p].x - 22, avoidPts[p].y - 22, 44, 44), 1.0);
                for (int p = 0; p < nCenters && !blocked; p++)
                    blocked = ObservedRainBoxesOverlap(box,
                        CGRectMake(centers[p].x - 18, centers[p].y - 28, 36, 56), 1.0);
                if (!blocked) { chosen = box; found = YES; break; }
            }
            // Zero/trace labels are useful when isolated, but should not
            // force a wet reading off the chart in a crowded area.
            if (!found) continue;
            placed[nPlaced++] = chosen;
            DrawText(ctx, candidate.text, valueFont, ink,
                CGRectGetMidX(chosen), CGRectGetMidY(chosen), 0);
        }
    }

    if (options.temperature && options.legend) {
        DrawLegend(ctx, kPanelW, kMapH, [NSString stringWithUTF8String:options.legend],
            options.rain && !options.observed, options.observed);
    }
    CGContextRestoreGState(ctx);

    CGContextSetRGBStrokeColor(ctx, 0.42, 0.43, 0.44, 1);
    CGContextSetLineWidth(ctx, 1);
    CGContextStrokeRect(ctx, CGRectMake(0.5, 0.5, kPanelW - 1, kMapH - 1));
    if (!options.bare) {
        CGContextSetRGBStrokeColor(ctx, titleColour.red, titleColour.green, titleColour.blue, 1);
        CGContextStrokeRect(ctx, CGRectMake(0.5, 0.5, kPanelW - 1, kPanelH - 1));
    }

    free(mslp);
    free(rough);
    free(temp);
    [NSGraphicsContext restoreGraphicsState];
    CGContextRestoreGState(ctx);
}

static CGContextRef MakeContext(int width, int height) {
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, width, height, 8, width * 4, cs,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(cs);
    CGContextSetAllowsAntialiasing(ctx, true);
    CGContextSetShouldAntialias(ctx, true);
    CGContextSetLineJoin(ctx, kCGLineJoinRound);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
    CGContextFillRect(ctx, CGRectMake(0, 0, width, height));
    return ctx;
}

double OwnChartPanelAspect(void) { return (double)kPanelW / (double)kPanelH; }
double OwnChartMapAspect(void) { return (double)kPanelW / (double)kMapH; }

@implementation OwnRun {
    Cube _cube;
    OwnCoast _coast;
    uint8_t *_land;
    RingSpan *_spans;
    NSDate *_generated;
    NSDate *_runDate;
    NSString *_attribution;
}

- (void)dealloc {
    CubeFree(&_cube);
    OwnCoastFree(_coast);
    free(_land);
    free(_spans);
}

- (NSInteger)hours { return _cube.nHours; }
- (NSDate *)runDate { return _runDate; }
- (NSDate *)generated { return _generated; }
- (NSString *)attribution { return _attribution; }

- (NSDate *)timeAtIndex:(NSInteger)index {
    if (index < 0 || index >= _cube.nHours || !_cube.times) return nil;
    return [NSDate dateWithTimeIntervalSince1970:_cube.times[index]];
}

- (BOOL)hasRainAtIndex:(NSInteger)index {
    if (index < 0 || index >= _cube.nHours) return NO;
    for (int p = 0; p < _cube.nPoints; p++) {
        float value = CubeAt(&_cube, VarRain, (int)p, (int)index);
        if (isfinite(value)) return YES;
    }
    return NO;
}

- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field hour:(NSInteger)hour {
    if (point < 0 || point >= _cube.nPoints || hour < 0 || hour >= _cube.nHours ||
        field < OwnRunFieldMSLP || field > OwnRunFieldRain) return NAN;
    return CubeAt(&_cube, (int)field, (int)point, (int)hour);
}

- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field fractionalHour:(double)hour {
    if (point < 0 || point >= _cube.nPoints || field < OwnRunFieldMSLP || field > OwnRunFieldRain) return NAN;
    return CubeAtFraction(&_cube, (int)field, (int)point, hour);
}

- (BOOL)readDirectory:(NSString *)dir coast:(NSString *)coastPath error:(NSString **)error {
    NSDictionary *manifest = nil;
    if (!LoadRunDirectory(dir, &_cube, &manifest, error)) return NO;
    NSData *coastData = [NSData dataWithContentsOfFile:coastPath];
    _coast = OwnCoastParse(coastData);
    if (_coast.rings < 1) {
        if (error) *error = @"coastline is missing";
        return NO;
    }
    AdoptCubeGrid(&_cube);
    _land = BuildLandMask(_coast, _cube.nLon, _cube.nLat);
    _spans = CoastSpans(_coast);
    if (!_land || !_spans) {
        if (error) *error = @"could not build the land mask";
        return NO;
    }
    id generated = manifest[@"generated"];
    if ([generated isKindOfClass:NSString.class]) {
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        _generated = [iso dateFromString:generated];
    }
    _attribution = [manifest[@"attribution"] isKindOfClass:NSString.class] ? manifest[@"attribution"] : @"ECMWF Open Data";
    _runDate = PublishedISODate(manifest[@"run"]) ?: _generated;
    return YES;
}

- (BOOL)readPublishedRoot:(NSString *)root run:(NSString *)runID previous:(NSString *)previousID
    coast:(NSString *)coastPath error:(NSString **)error {
    NSDate *date = nil;
    if (!LoadPublishedCube(root, runID, previousID, &_cube, &date, error)) return NO;
    NSData *coastData = [NSData dataWithContentsOfFile:coastPath];
    _coast = OwnCoastParse(coastData);
    if (_coast.rings < 1) {
        if (error) *error = @"coastline is missing";
        return NO;
    }
    AdoptCubeGrid(&_cube);
    _land = BuildLandMask(_coast, _cube.nLon, _cube.nLat);
    _spans = CoastSpans(_coast);
    if (!_land || !_spans) {
        if (error) *error = @"could not build the land mask";
        return NO;
    }
    _runDate = date;
    _generated = date;
    _attribution = @"ECMWF Open Data";
    return YES;
}

- (NSImage *)renderHour:(double)hour title:(NSString *)title layers:(OwnLayerOptions)layers
    stations:(NSArray *)stations scale:(CGFloat)scale {
    if (!isfinite(hour) || hour < 0 || hour > _cube.nHours - 1) return nil;
    AdoptCubeGrid(&_cube);
    if (scale < 1) scale = 1;
    if (scale > 3) scale = 3;
    int logicalH = layers.bare ? kMapH : kPanelH;
    int pixelsW = (int)llround(kPanelW * scale);
    int pixelsH = (int)llround(logicalH * scale);
    CGContextRef ctx = MakeContext(pixelsW, pixelsH);
    if (!ctx) return nil;
    CGContextScaleCTM(ctx, scale, scale);
    PanelOptions options = {0};
    options.temperature = layers.temperature;
    options.barbs = layers.barbs;
    options.rain = layers.rain && !layers.observed;
    options.observed = layers.observed;
    options.bare = layers.bare;
    // The app draws one key in the chrome. A panel does not carry a legend box.
    StationRain stack[48];
    int nStations = 0;
    if (layers.observed && stations.count) {
        for (NSDictionary *dot in stations) {
            if (nStations >= 48 || ![dot isKindOfClass:NSDictionary.class]) continue;
            stack[nStations++] = (StationRain){
                [dot[@"lat"] doubleValue],
                [dot[@"lon"] doubleValue],
                [dot[@"mm"] doubleValue],
            };
        }
        options.stations = stack;
        options.nStations = nStations;
    }
    RenderPanel(ctx, 0, 0, &_cube, hour, title ?: @"", _coast, _land, _spans, options);
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!image) return nil;
    NSImage *result = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(kPanelW, logicalH)];
    CGImageRelease(image);
    return result;
}

- (NSImage *)renderMotion:(double)hour title:(NSString *)title layers:(OwnLayerOptions)layers
    stations:(NSArray *)stations scale:(CGFloat)scale state:(OwnMotionState *)state {
    if (!state || _cube.nPoints > 1000000 || !isfinite(hour) || hour < 0 || hour > _cube.nHours - 1) return nil;
    AdoptCubeGrid(&_cube);
    if (scale < 1) scale = 1;
    if (scale > 3) scale = 3;
    int logicalH = layers.bare ? kMapH : kPanelH;
    int pixelsW = (int)llround(kPanelW * scale);
    int pixelsH = (int)llround(logicalH * scale);
    CGContextRef ctx = MakeContext(pixelsW, pixelsH);
    if (!ctx) return nil;
    CGContextScaleCTM(ctx, scale, scale);
    PanelOptions options = {0};
    options.temperature = layers.temperature;
    options.barbs = layers.barbs;
    options.rain = layers.rain && !layers.observed;
    options.observed = layers.observed;
    options.bare = layers.bare;
    options.motionState = state;
    StationRain stack[48];
    int nStations = 0;
    if (layers.observed && stations.count) {
        for (NSDictionary *dot in stations) {
            if (nStations >= 48 || ![dot isKindOfClass:NSDictionary.class]) continue;
            stack[nStations++] = (StationRain){[dot[@"lat"] doubleValue], [dot[@"lon"] doubleValue], [dot[@"mm"] doubleValue]};
        }
        options.stations = stack;
        options.nStations = nStations;
    }
    state->_motionFrame++;
    RenderPanel(ctx, 0, 0, &_cube, hour, title ?: @"", _coast, _land, _spans, options);
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!image) return nil;
    NSImage *result = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(kPanelW, logicalH)];
    CGImageRelease(image);
    return result;
}

@end

OwnRun *OwnRunLoad(NSString *runDirectory, NSString *coastPath, NSString **error) {
    if (!runDirectory.length) {
        if (error) *error = @"no ECMWF run directory";
        return nil;
    }
    OwnRun *run = [OwnRun new];
    if (![run readDirectory:runDirectory coast:coastPath error:error]) return nil;
    return run;
}

OwnRun *OwnRunLoadPublished(NSString *root, BOOL previous, NSString *coastPath, NSString **error) {
    if (!root.length) {
        if (error) *error = @"no isobar data root";
        return nil;
    }
    NSString *family = [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
    NSData *pointerData = [NSData dataWithContentsOfFile:[family stringByAppendingPathComponent:@"current.json"]];
    NSDictionary *pointer = [NSJSONSerialization JSONObjectWithData:pointerData ?: [NSData data] options:0 error:nil];
    if (![pointer isKindOfClass:NSDictionary.class]) {
        if (error) *error = @"published ECMWF pointer is not an object";
        return nil;
    }
    if (!SupportedGridContract(pointer, error)) return nil;
    NSString *latest = [pointer[@"latest"] isKindOfClass:NSString.class] ? pointer[@"latest"] : nil;
    NSArray *runs = [pointer[@"runs"] isKindOfClass:NSArray.class] ? pointer[@"runs"] : nil;
    if (!latest.length || !runs.count) {
        if (error) *error = @"published ECMWF pointer is missing latest/runs";
        return nil;
    }
    NSMutableDictionary<NSString *, NSDate *> *dates = [NSMutableDictionary dictionary];
    for (id item in runs) {
        if (![item isKindOfClass:NSString.class] || !PublishedRunDate(item) || dates[item]) {
            if (error) *error = @"published ECMWF pointer contains an invalid or duplicate run";
            return nil;
        }
        dates[item] = PublishedRunDate(item);
    }
    NSDate *latestDate = dates[latest];
    if (!latestDate) {
        if (error) *error = @"published ECMWF pointer has no valid latest run";
        return nil;
    }
    for (NSString *item in dates) if ([dates[item] compare:latestDate] == NSOrderedDescending) {
        if (error) *error = @"published ECMWF pointer latest run is not the newest published run";
        return nil;
    }
    NSInteger latestIndex = [runs indexOfObject:latest];
    if (latestIndex == NSNotFound) {
        if (error) *error = @"published ECMWF pointer does not list its latest run";
        return nil;
    }
    NSString *runID = latest;
    NSString *previousID = nil;
    if (previous) {
        NSString *nearestOlder = nil;
        NSDate *nearestDate = nil;
        for (NSString *item in dates) {
            NSDate *date = dates[item];
            if ([date compare:latestDate] == NSOrderedAscending &&
                (!nearestDate || [date compare:nearestDate] == NSOrderedDescending)) {
                nearestOlder = item; nearestDate = date;
            }
        }
        if (!nearestOlder) {
            if (error) *error = @"published ECMWF pointer has no previous run";
            return nil;
        }
        previousID = nearestOlder;
        runID = previousID;
        if (!runID.length) {
            if (error) *error = @"published ECMWF previous run id is invalid";
            return nil;
        }
    } else {
        NSDate *nearestDate = nil;
        for (NSString *item in dates) {
            NSDate *date = dates[item];
            if ([date compare:latestDate] == NSOrderedAscending &&
                (!nearestDate || [date compare:nearestDate] == NSOrderedDescending)) {
                previousID = item; nearestDate = date;
            }
        }
    }
    NSString *rainPreviousID = previous ? nil : previousID;
    NSString *runsRoot = [family stringByAppendingPathComponent:@"runs"];
    NSMutableString *cacheKey = [NSMutableString stringWithFormat:@"%@|previous=%d|pointer=",
        [root stringByStandardizingPath], previous];
    [cacheKey appendString:[pointerData base64EncodedStringWithOptions:0] ?: @"missing"];
    [cacheKey appendFormat:@"|coast=%@", PublishedFileStamp(coastPath)];
    // Current runs derive the first eight rain frames from the adjacent older
    // run, so include that directory in the identity too. The selected run is
    // always included. Metadata is enough to detect atomic publishes and
    // in-place corrections without hashing tens of megabytes on every tick.
    NSArray<NSString *> *dependencies = rainPreviousID.length
        ? @[runID, rainPreviousID] : @[runID];
    for (NSString *dependency in dependencies) {
        NSString *dir = [runsRoot stringByAppendingPathComponent:dependency];
        [cacheKey appendFormat:@"|run=%@:%@", dependency, PublishedDirectoryStamp(dir)];
    }
    OwnRun *cached = [PublishedRunCache() objectForKey:cacheKey];
    if (cached) return cached;
    OwnRun *run = [OwnRun new];
    if (![run readPublishedRoot:root run:runID previous:rainPreviousID coast:coastPath error:error]) return nil;
    [PublishedRunCache() setObject:run forKey:cacheKey];
    return run;
}

NSImage *OwnRunRender(OwnRun *run, NSInteger hour, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale) {
    return [run renderHour:hour title:title layers:layers stations:stations scale:scale];
}

NSImage *OwnRunRenderFraction(OwnRun *run, double fractionalIndex, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale) {
    return [run renderHour:fractionalIndex title:title layers:layers stations:stations scale:scale];
}

NSImage *OwnRunRenderMotion(OwnRun *run, double fractionalIndex, NSString *title, OwnLayerOptions layers,
    NSArray<NSDictionary *> *stations, CGFloat scale, OwnMotionState *state) {
    return [run renderMotion:fractionalIndex title:title layers:layers stations:stations scale:scale state:state];
}

NSString *OwnRainLegendText(void) {
    return @"Rain ≥ 1 mm, 24 h to chart time";
}

#ifndef ISOBAR_APP
static BOOL WritePNG(CGContextRef ctx, NSString *path) {
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    if (!image) return NO;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    CGImageRelease(image);
    return png.length && [png writeToFile:path atomically:YES];
}

static CGImageRef LoadPNG(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) return NULL;
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    return image;
}

// 2×2 sheet: Bureau crop, MSLP, 850 hPa, then wind and rain together.
static BOOL WriteCompare(NSString *dir) {
    NSString *files[4] = {
        [dir stringByAppendingPathComponent:@"a-bom.png"],
        [dir stringByAppendingPathComponent:@"b-mslp.png"],
        [dir stringByAppendingPathComponent:@"c-t850.png"],
        [dir stringByAppendingPathComponent:@"d-barbs-rain.png"],
    };
    NSString *caps[4] = {@"a  Bureau", @"b  MSLP", @"c  850 hPa", @"d  wind and rain"};
    CGImageRef images[4] = {0};
    for (int i = 0; i < 4; i++) {
        images[i] = LoadPNG(files[i]);
        if (!images[i]) {
            fprintf(stderr, "compare is missing %s\n", files[i].UTF8String);
            for (int k = 0; k < 4; k++) if (images[k]) CGImageRelease(images[k]);
            return NO;
        }
    }
    const int gap = 14;
    const int capH = 22;
    int width = 2 * kPanelW + 3 * gap;
    int height = 2 * (capH + kPanelH) + 3 * gap;
    CGContextRef ctx = MakeContext(width, height);
    if (!ctx) {
        for (int i = 0; i < 4; i++) CGImageRelease(images[i]);
        return NO;
    }
    NSGraphicsContext *graphics = [NSGraphicsContext graphicsContextWithCGContext:ctx flipped:NO];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:graphics];
    NSFont *font = [NSFont fontWithName:@"Helvetica-Bold" size:13] ?: [NSFont boldSystemFontOfSize:13];
    NSColor *ink = [NSColor colorWithSRGBRed:0.15 green:0.14 blue:0.13 alpha:1];
    for (int i = 0; i < 4; i++) {
        int col = i % 2;
        int row = i / 2;
        double x = gap + col * (kPanelW + gap);
        double top = gap + row * (capH + kPanelH + gap);
        double y = height - top - capH - kPanelH;
        [caps[i] drawAtPoint:NSMakePoint(x, y + kPanelH + 4) withAttributes:@{
            NSFontAttributeName: font,
            NSForegroundColorAttributeName: ink,
        }];
        CGContextDrawImage(ctx, CGRectMake(x, y, kPanelW, kPanelH), images[i]);
        CGImageRelease(images[i]);
    }
    [NSGraphicsContext restoreGraphicsState];
    BOOL ok = WritePNG(ctx, [dir stringByAppendingPathComponent:@"compare.png"]);
    CGContextRelease(ctx);
    return ok;
}

static BOOL WritePanel(NSString *path, const Cube *cube, int hour, NSString *title, OwnCoast coast,
    const uint8_t *landMask, const RingSpan *spans, PanelOptions options) {
    CGContextRef ctx = MakeContext(kPanelW, kPanelH);
    if (!ctx) return NO;
    RenderPanel(ctx, 0, 0, cube, hour, title, coast, landMask, spans, options);
    BOOL ok = WritePNG(ctx, path);
    CGContextRelease(ctx);
    return ok;
}

static BOOL CropBureau(NSData *gif, int panelIndex, NSString *path) {
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)gif, NULL);
    if (!source) return NO;
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (!image) return NO;
    size_t width = CGImageGetWidth(image);
    size_t height = CGImageGetHeight(image);
    int column = MSLPSourceColumn(panelIndex);
    int row = MSLPSourceRow(panelIndex);
    double colX[2] = {8.0 / 601.0, 306.0 / 601.0};
    double rowY[4] = {65.0 / 1006.0, 300.0 / 1006.0, 535.0 / 1006.0, 771.0 / 1006.0};
    CGRect rect = CGRectMake(colX[column] * width, rowY[row] * height, (290.0 / 601.0) * width, (235.0 / 1006.0) * height);
    rect = CGRectIntegral(rect);
    CGImageRef cropped = CGImageCreateWithImageInRect(image, rect);
    CGImageRelease(image);
    if (!cropped) return NO;
    CGContextRef ctx = MakeContext(kPanelW, kPanelH);
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextDrawImage(ctx, CGRectMake(0, 0, kPanelW, kPanelH), cropped);
    CGImageRelease(cropped);
    BOOL ok = WritePNG(ctx, path);
    CGContextRelease(ctx);
    return ok;
}

// Capital-city IDX60901 products, plus a few regional stations in each state.
// Rain is the Bureau's rain_trace, millimetres since 9am local, not the model hatch.
static const char *kObserved[][2] = {
    {"IDW60901", "94608"}, {"IDW60901", "94614"}, {"IDW60901", "94151"},
    {"IDN60901", "94768"}, {"IDN60901", "94767"}, {"IDN60901", "94776"},
    {"IDN60901", "95765"}, {"IDN60901", "94765"},
    {"IDV60901", "95936"}, {"IDV60901", "94866"}, {"IDV60901", "94870"},
    {"IDQ60901", "94576"}, {"IDQ60901", "94578"}, {"IDQ60901", "94575"},
    {"IDS60901", "94648"},
    {"IDT60901", "94970"},
    {"IDD60901", "94120"}, {"IDD60901", "94122"},
};

static BOOL StationRainFromJSON(NSData *json, StationRain *out) {
    id root = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
    NSArray *data = [root[@"observations"][@"data"] isKindOfClass:NSArray.class] ? root[@"observations"][@"data"] : nil;
    NSDictionary *row = data.count && [data[0] isKindOfClass:NSDictionary.class] ? data[0] : nil;
    if (![row[@"lat"] isKindOfClass:NSNumber.class] || ![row[@"lon"] isKindOfClass:NSNumber.class]) return NO;
    id rain = row[@"rain_trace"];
    NSString *text = [rain isKindOfClass:NSString.class] ? rain : [rain isKindOfClass:NSNumber.class] ? [rain description] : nil;
    if (!text.length) return NO;
    NSScanner *scanner = [NSScanner scannerWithString:text];
    double mm = 0;
    if (![scanner scanDouble:&mm]) return NO;
    out->lat = [row[@"lat"] doubleValue];
    out->lon = [row[@"lon"] doubleValue];
    out->mm = mm;
    return YES;
}

static int LoadObserved(StationRain *out, int cap) {
    int n = 0;
    int total = (int)(sizeof kObserved / sizeof kObserved[0]);
    for (int i = 0; i < total && n < cap; i++) {
        NSString *url = ObservationJSONURL(@(kObserved[i][0]), @(kObserved[i][1]));
        NSInteger status = 0;
        NSData *body = HTTPGet(url, &status, NULL);
        StationRain rain = {0};
        if (!body || !StationRainFromJSON(body, &rain)) {
            fprintf(stderr, "  station %s.%s skipped (HTTP %ld)\n", kObserved[i][0], kObserved[i][1], (long)status);
            continue;
        }
        BOOL near = NO;
        for (int k = 0; k < n; k++) {
            if (hypot(rain.lat - out[k].lat, rain.lon - out[k].lon) < 0.8) { near = YES; break; }
        }
        if (near) {
            fprintf(stderr, "  %s.%s %.1f mm sits on a station already plotted\n",
                kObserved[i][0], kObserved[i][1], rain.mm);
            continue;
        }
        fprintf(stderr, "  %s.%s %.1f mm at %.2f %.2f\n", kObserved[i][0], kObserved[i][1], rain.mm, rain.lat, rain.lon);
        out[n++] = rain;
    }
    return n;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        NSString *root = [NSFileManager.defaultManager currentDirectoryPath];
        NSString *outDir = [root stringByAppendingPathComponent:@"docs/design/own-chart"];
        NSString *coastPath = [root stringByAppendingPathComponent:@"Resources/ownchart-coast.bin"];
        NSString *ecmwf = [NSHomeDirectory() stringByAppendingPathComponent:@"Data/isobar/ecmwf"];
        const char *envRoot = getenv("ISOBAR_ECMWF");
        if (envRoot && envRoot[0]) ecmwf = [NSString stringWithUTF8String:envRoot];
        BOOL observed = NO;
        BOOL offline = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--refresh") == 0) continue;
            if (strcmp(argv[i], "--observed") == 0) observed = YES;
            else if (strcmp(argv[i], "--offline") == 0) offline = YES;
            else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) outDir = [NSString stringWithUTF8String:argv[++i]];
            else if (strcmp(argv[i], "--ecmwf") == 0 && i + 1 < argc) ecmwf = [NSString stringWithUTF8String:argv[++i]];
        }
        NSData *coastData = [NSData dataWithContentsOfFile:coastPath];
        OwnCoast coast = OwnCoastParse(coastData);
        if (coast.rings < 1) {
            fprintf(stderr, "coastline missing at %s\n", coastPath.UTF8String);
            return 1;
        }
        [NSFileManager.defaultManager createDirectoryAtPath:outDir withIntermediateDirectories:YES attributes:nil error:nil];

        NSDate *now = [NSDate date];
        NSArray<NSDate *> *prognosis = OwnPrognosisTimes(now);
        NSInteger status = 0;
        NSData *pdf = nil;
        NSData *gif = nil;
        if (offline) {
            fprintf(stderr, "offline: valid times from the prognosis rule, Bureau crop left as saved\n");
        } else {
            fprintf(stderr, "fetching Bureau chart for the panel crop\n");
            pdf = HTTPGet(@"https://www.bom.gov.au/fwo/IDG00073.pdf", &status, NULL);
            gif = HTTPGet(@"https://www.bom.gov.au/fwo/IDG00074.gif", &status, NULL);
            if (pdf.length) {
                NSArray<NSDate *> *fromChart = PrognosisValidTimes(pdf);
                if (fromChart.count == 8) prognosis = fromChart;
            }
        }
        if (prognosis.count != 8) {
            fprintf(stderr, "could not resolve eight valid times\n");
            OwnCoastFree(coast);
            return 1;
        }
        NSDate *compare = prognosis[0];
        fprintf(stderr, "valid %s … %s\n",
            OwnValidTitle(prognosis[0], NO).UTF8String,
            OwnValidTitle(prognosis.lastObject, NO).UTF8String);

        Cube cube = {0};
        NSDictionary *manifest = nil;
        NSString *error = nil;
        fprintf(stderr, "reading ECMWF grids from %s\n", ecmwf.UTF8String);
        if (!LoadECMWF(ecmwf, &cube, &manifest, &error)) {
            fprintf(stderr, "ECMWF grid: %s\n", error.UTF8String ?: "unreadable");
            CubeFree(&cube);
            OwnCoastFree(coast);
            return 1;
        }

        NSTimeInterval step = 3 * 3600;
        NSDate *nowHour = [NSDate dateWithTimeIntervalSince1970:round(now.timeIntervalSince1970 / step) * step];
        int nowIndex = HourIndex(&cube, nowHour);
        int compareIndex = HourIndex(&cube, compare);
        if (compareIndex < 0 || nowIndex < 0) {
            fprintf(stderr, "valid time is outside the ECMWF run (now %d compare %d)\n", nowIndex, compareIndex);
            CubeFree(&cube);
            OwnCoastFree(coast);
            return 1;
        }
        nowHour = [NSDate dateWithTimeIntervalSince1970:cube.times[nowIndex]];

        StationRain stations[32];
        int nStations = 0;
        if (observed) {
            fprintf(stderr, "observed rain since 9am\n");
            nStations = LoadObserved(stations, 32);
        }

        NSString *compareTitle = OwnValidTitle(compare, NO);
        PanelOptions mslpOnly = {0};
        PanelOptions shaded = {.temperature = 1, .legend = "850 hPa °C"};
        PanelOptions surface = {.temperature = 2, .legend = "2 m °C"};
        PanelOptions layers = {.temperature = 1, .barbs = 1, .rain = 1, .legend = "850 hPa °C"};
        PanelOptions stripOpt = {.temperature = 1, .rain = 1, .legend = "850 hPa °C"};
        uint8_t *landMask = BuildLandMask(coast, cube.nLon, cube.nLat);
        RingSpan *spans = CoastSpans(coast);
        if (!landMask || !spans) {
            fprintf(stderr, "could not build the land mask\n");
            free(landMask);
            free(spans);
            CubeFree(&cube);
            OwnCoastFree(coast);
            return 1;
        }
        int perthI = (int)llround((115.86 - GWest()) / GStep());
        int perthJ = (int)llround((GNorth() - (-31.95)) / GStep());
        int bightI = (int)llround((130.0 - GWest()) / GStep());
        int bightJ = (int)llround((GNorth() - (-40.0)) / GStep());
        fprintf(stderr, "  land mask Perth %d  Bight %d\n",
            landMask[perthJ * cube.nLon + perthI], landMask[bightJ * cube.nLon + bightI]);

        fprintf(stderr, "render %s\n", compareTitle.UTF8String);
        if (!WritePanel([outDir stringByAppendingPathComponent:@"b-mslp.png"], &cube, compareIndex, compareTitle, coast, landMask, spans, mslpOnly)
            || !WritePanel([outDir stringByAppendingPathComponent:@"c-t850.png"], &cube, compareIndex, compareTitle, coast, landMask, spans, shaded)
            || !WritePanel([outDir stringByAppendingPathComponent:@"c-t2m.png"], &cube, compareIndex, compareTitle, coast, landMask, spans, surface)
            || !WritePanel([outDir stringByAppendingPathComponent:@"d-barbs-rain.png"], &cube, compareIndex, compareTitle, coast, landMask, spans, layers)) {
            free(landMask);
            free(spans);
            CubeFree(&cube);
            OwnCoastFree(coast);
            return 1;
        }

        if (gif.length) {
            int panel = 0;
            NSArray<NSDate *> *chartTimes = pdf.length ? PrognosisValidTimes(pdf) : prognosis;
            for (NSUInteger i = 0; i < chartTimes.count && i < 8; i++) {
                if (fabs([chartTimes[i] timeIntervalSinceDate:compare]) < 60) { panel = (int)i; break; }
            }
            if (!CropBureau(gif, panel, [outDir stringByAppendingPathComponent:@"a-bom.png"]))
                fprintf(stderr, "warning: Bureau crop failed\n");
        } else if (!offline) {
            fprintf(stderr, "warning: IDG00074 was not fetched\n");
        }

        int stripCount = 9;
        int gap = 10;
        int stripW = stripCount * kPanelW + (stripCount - 1) * gap;
        CGContextRef strip = MakeContext(stripW, kPanelH);
        NSDate *frames[9] = {nowHour, prognosis[0], prognosis[1], prognosis[2], prognosis[3],
            prognosis[4], prognosis[5], prognosis[6], prognosis[7]};
        BOOL nowFlags[9] = {YES, NO, NO, NO, NO, NO, NO, NO, NO};
        for (int i = 0; i < stripCount; i++) {
            int hour = HourIndex(&cube, frames[i]);
            if (hour < 0) continue;
            NSString *frameTitle = OwnValidTitle(frames[i], nowFlags[i]);
            fprintf(stderr, "strip %d %s\n", i, frameTitle.UTF8String);
            PanelOptions frame = stripOpt;
            if (nowFlags[i] && observed) {
                frame.rain = 0;
                frame.observed = 1;
                frame.stations = stations;
                frame.nStations = nStations;
            }
            RenderPanel(strip, i * (kPanelW + gap), 0, &cube, hour, frameTitle, coast, landMask, spans, frame);
        }
        if (!WritePNG(strip, [outDir stringByAppendingPathComponent:@"e-strip.png"])) {
            CGContextRelease(strip);
            free(landMask);
            free(spans);
            CubeFree(&cube);
            OwnCoastFree(coast);
            return 1;
        }
        CGContextRelease(strip);

        NSDate *fetched = [NSDate dateWithTimeIntervalSince1970:cube.fetched];
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        NSMutableArray *valid = [NSMutableArray array];
        for (NSDate *when in prognosis) [valid addObject:[iso stringFromDate:when]];
        NSString *runStamp = [manifest[@"run"] isKindOfClass:NSString.class] ? manifest[@"run"] : @"";
        NSDictionary *meta = @{
            @"model": @"ecmwf-ifs-0p25",
            @"source": @"ECMWF Open Data",
            @"licence": @"CC BY 4.0",
            @"licence_url": @"https://creativecommons.org/licenses/by/4.0/",
            @"attribution": cube.httpDate[0] ? [NSString stringWithUTF8String:cube.httpDate] : @"ECMWF Open Data",
            @"run": runStamp,
            @"fetched": [iso stringFromDate:fetched],
            @"grid": @{@"step": @(GStep()), @"west": @(GWest()), @"east": @(OwnGridEast()),
                       @"north": @(GNorth()), @"south": @(OwnGridSouth()),
                       @"points": @(cube.nPoints)},
            @"compare": [iso stringFromDate:compare],
            @"now": [iso stringFromDate:nowHour],
            @"valid": valid,
            @"rain": [NSString stringWithFormat:@"24 h ending at the chart time, hatched at ≥ %.0f mm, from IFS tp", kRainMm],
        };
        NSData *metaJSON = [NSJSONSerialization dataWithJSONObject:meta options:NSJSONWritingPrettyPrinted error:nil];
        [metaJSON writeToFile:[outDir stringByAppendingPathComponent:@"meta.json"] atomically:YES];
        if (!WriteCompare(outDir)) fprintf(stderr, "warning: comparison sheet was not written\n");
        fprintf(stderr, "wrote %s\n", outDir.UTF8String);
        free(landMask);
        free(spans);
        CubeFree(&cube);
        OwnCoastFree(coast);
        return 0;
    }
}
#endif
