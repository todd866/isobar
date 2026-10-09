// Prototype Bureau-style MSLP renderer. Foundation, CoreGraphics and AppKit only.
// Run from the repo root: build/own-chart
#import "ownchart.h"
#import "pure.h"
#import "ownrender.h"
#import <AppKit/AppKit.h>
#ifndef ISOBAR_APP
#import <ImageIO/ImageIO.h>
#endif
#import <Accelerate/Accelerate.h>
#import <math.h>
#import <os/lock.h>
#import <pthread.h>
#import <stdlib.h>
#import <string.h>
#import <limits.h>
#import <sys/stat.h>
#import <time.h>

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

static _Thread_local OwnRenderProfile gRenderProfile;
static _Thread_local double gProfileMark;
static _Thread_local double gChaikinMs;
static _Thread_local double gOpenInset;
static _Thread_local BOOL gClassicWorld;
static _Thread_local CGRect gLabelBoxes[80], gCentreBoxes[24];
static _Thread_local double gLabelAlpha[80], gCentreAlpha[24];
static _Thread_local int gNLabelBoxes, gNCentreBoxes;

static double ViewWest(void) { return gClassicWorld ? -180.0 : kViewWest; }
static double ViewEast(void) { return gClassicWorld ? 180.0 : kViewEast; }
static double ViewSouth(void) { return gClassicWorld ? -90.0 : kViewSouth; }
static double ViewNorth(void) { return gClassicWorld ? 90.0 : kViewNorth; }

static double ProfileNow(void) {
    return (double)clock_gettime_nsec_np(CLOCK_UPTIME_RAW) * 1e-6;
}

static void ProfileReset(void) {
    gRenderProfile = (OwnRenderProfile){0};
    gChaikinMs = 0;
    gOpenInset = -1e9;
    gNLabelBoxes = 0;
    gNCentreBoxes = 0;
    gProfileMark = ProfileNow();
}

static NSInteger CopyBoxes(const CGRect *from, const double *fromAlpha, int count,
    CGRect *rects, double *alphas, NSInteger max) {
    NSInteger n = MIN(max, (NSInteger)count);
    for (NSInteger i = 0; i < n; i++) {
        if (rects) rects[i] = from[i];
        if (alphas) alphas[i] = fromAlpha[i];
    }
    return n < 0 ? 0 : n;
}

NSInteger OwnRenderLastLabelBoxes(CGRect *rects, double *alphas, NSInteger max) {
    return CopyBoxes(gLabelBoxes, gLabelAlpha, gNLabelBoxes, rects, alphas, max);
}
NSInteger OwnRenderLastCentreBoxes(CGRect *rects, double *alphas, NSInteger max) {
    return CopyBoxes(gCentreBoxes, gCentreAlpha, gNCentreBoxes, rects, alphas, max);
}

// The cross, the letter above it and the value below.
static CGRect CentreMarkBox(double x, double y) {
    return CGRectMake(x - 16, y - 24, 32, 50);
}

static double ProfileLap(void) {
    double now = ProfileNow();
    double delta = now - gProfileMark;
    gProfileMark = now;
    return delta;
}

OwnRenderProfile OwnRenderProfileLast(void) { return gRenderProfile; }
double OwnRenderLastOpenInset(void) { return gOpenInset; }

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
// The published root may expose the Australian and wrapping global products
// side by side. Keep the selected family on this loading thread so all of the
// schema-2 sidecar helpers read the same immutable family. Store the path as
// bytes: a bridged NSString here would be unretained after the selector
// returns and could leave the worker reading a dangling object.
static _Thread_local char gPublishedFamilyPath[PATH_MAX];
static int PublishedSchema(NSDictionary *document);
static BOOL SupportedGridContract(NSDictionary *document, NSString **error);
static BOOL ParseForecastHours(NSArray *hours, int *leads, int *count, NSString **error);
static NSDate *PublishedRunDate(NSString *runID);

static NSString *PublishedFamilyPath(NSString *root) {
    NSString *selected = gPublishedFamilyPath[0] ? [NSString stringWithUTF8String:gPublishedFamilyPath] : nil;
    return selected.length ? selected
        : [root stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025"];
}

static BOOL PublishedPointerHasRun(NSString *family, NSDictionary *pointer, NSString *latestID) {
    if (!family.length || !latestID.length || ![pointer isKindOfClass:NSDictionary.class]) return NO;
    NSArray *runs = [pointer[@"runs"] isKindOfClass:NSArray.class] ? pointer[@"runs"] : nil;
    if (![runs containsObject:latestID]) return NO;
    NSString *dir = [[family stringByAppendingPathComponent:@"runs"] stringByAppendingPathComponent:latestID];
    BOOL isDir = NO;
    if (![[NSFileManager defaultManager] fileExistsAtPath:dir isDirectory:&isDir] || !isDir) return NO;
    NSString *manifestPath = [dir stringByAppendingPathComponent:@"manifest.json"];
    NSData *manifestData = [NSData dataWithContentsOfFile:manifestPath];
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:manifestData ?: [NSData data] options:0 error:nil];
    if (![manifest isKindOfClass:NSDictionary.class]) {
        NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:[dir stringByAppendingPathComponent:@"mslp"] error:nil];
        return files.count >= 1;
    }
    if (PublishedSchema(manifest) != 2 || !SupportedGridContract(manifest, nil)) return NO;
    int leads[80], count = 0;
    if (!ParseForecastHours(manifest[@"forecast_hours"], leads, &count, nil)) return NO;
    if ([family.lastPathComponent isEqual:@"ecmwf_ifs_global"]) {
        if (count != 53 || leads[0] != 0 || leads[count - 1] != 168) return NO;
        NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:[dir stringByAppendingPathComponent:@"mslp"] error:nil];
        NSMutableArray *json = [NSMutableArray array];
        for (NSString *name in files)
            if ([name.pathExtension.lowercaseString isEqual:@"json"]) [json addObject:name];
        if (json.count != 53) return NO;
        [json sortUsingSelector:@selector(compare:)];
        NSString *sidePath = [[dir stringByAppendingPathComponent:@"mslp"] stringByAppendingPathComponent:json.firstObject];
        NSDictionary *side = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:sidePath] ?: [NSData data] options:0 error:nil];
        if (![side isKindOfClass:NSDictionary.class] || [side[@"nx"] intValue] != 720 || [side[@"ny"] intValue] != 361) return NO;
    }
    NSDate *run = PublishedRunDate(latestID);
    if (!run) return NO;
    NSDate *valid = [run dateByAddingTimeInterval:leads[0] * 3600.0];
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSString *stamp = [iso stringFromDate:valid];
    if (stamp.length < 13) return NO;
    NSString *validID = [NSString stringWithFormat:@"%@%@%@T%@%@",
        [stamp substringWithRange:NSMakeRange(0, 4)], [stamp substringWithRange:NSMakeRange(5, 2)],
        [stamp substringWithRange:NSMakeRange(8, 2)], [stamp substringWithRange:NSMakeRange(11, 2)], @"Z"];
    NSString *stem = [[dir stringByAppendingPathComponent:@"mslp"] stringByAppendingPathComponent:validID];
    return [[NSFileManager defaultManager] fileExistsAtPath:[stem stringByAppendingPathExtension:@"f16"]] &&
        [[NSFileManager defaultManager] fileExistsAtPath:[stem stringByAppendingPathExtension:@"json"]];
}

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
    // Per model hour, three linear fields packed as gaussian, mild, wide.
    // The land correction is not linear, so it is applied after the lerp.
    double **smooth;
    double *landWeight;
    os_unfair_lock smoothLock;
} Cube;

static void AdoptCubeGrid(const Cube *cube) {
    if (!cube || cube->step <= 0 || cube->nLon < 2 || cube->nLat < 2) return;
    gWest = cube->west;
    gNorth = cube->north;
    gStep = cube->step;
    gNLon = cube->nLon;
    gNLat = cube->nLat;
    gGridReady = 1;
    gClassicWorld = cube->nLon == 720 && cube->nLat == 361 && fabs(cube->step - 0.5) < 1e-6;
}

static void CubeFree(Cube *cube) {
    if (cube->smooth) {
        for (int h = 0; h < cube->nHours; h++) free(cube->smooth[h]);
        free(cube->smooth);
    }
    free(cube->landWeight);
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

static float *ReadF16Stack(NSString *path, int nTimes, int nPoints, NSString **error) {
    NSData *file = [NSData dataWithContentsOfFile:path];
    size_t count = (size_t)nTimes * (size_t)nPoints;
    size_t need = count * sizeof(uint16_t);
    if (file.length != need) {
        if (error) *error = [NSString stringWithFormat:@"%@ is %lu bytes, expected %lu",
            path.lastPathComponent, (unsigned long)file.length, (unsigned long)need];
        return NULL;
    }
    const uint8_t *bytes = file.bytes;
    float *out = malloc(count * sizeof(float));
    if (!out) {
        if (error) *error = @"not enough memory for an ECMWF field";
        return NULL;
    }
    for (size_t i = 0; i < count; i++) {
        uint16_t bits = (uint16_t)bytes[i * 2] | ((uint16_t)bytes[i * 2 + 1] << 8);
        out[i] = bits == 0xf800 ? NAN : DecodeF16(bits);
        if (isinf(out[i])) out[i] = NAN;
    }
    return out;
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

// Absent schema is the original grid. Schema 1 is 33 frames at 3 h. Schema 2
// lists forecast_hours. Anything else fails closed.
static int PublishedSchema(NSDictionary *document) {
    if (![document isKindOfClass:NSDictionary.class]) return -1;
    id version = document[@"schema_version"];
    if (!version) return 1;
    if (![version isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID())
        return -1;
    double value = [version doubleValue];
    if (value == 1.0) return 1;
    if (value == 2.0) return 2;
    return -1;
}

static BOOL SupportedGridContract(NSDictionary *document, NSString **error) {
    if (![document isKindOfClass:NSDictionary.class]) return NO;
    id contract = document[@"contract"], family = document[@"family"];
    BOOL familyOK = !family || ([family isKindOfClass:NSString.class] &&
        ([family isEqual:@"grids/ecmwf_ifs025"] || [family isEqual:@"grids/ecmwf_ifs_global"]));
    if ((contract && (![contract isKindOfClass:NSString.class] || ![contract isEqual:@"isobar-data"])) ||
        PublishedSchema(document) < 0 ||
        !familyOK) {
        if (error) *error = @"ECMWF data uses an unsupported contract version";
        return NO;
    }
    return YES;
}

// Strictly increasing whole hours, starting at 0 and ending by 168 h.
static BOOL ParseForecastHours(NSArray *hours, int *leads, int *count, NSString **error) {
    if (![hours isKindOfClass:NSArray.class] || hours.count < 2 || hours.count > 80) {
        if (error) *error = @"ECMWF schema 2 is missing forecast_hours";
        return NO;
    }
    int previous = -1;
    for (NSUInteger i = 0; i < hours.count; i++) {
        id item = hours[i];
        if (![item isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)item) == CFBooleanGetTypeID()) {
            if (error) *error = @"ECMWF schema 2 is missing forecast_hours";
            return NO;
        }
        double value = [item doubleValue];
        if (value != floor(value) || value < 0 || value > 168) {
            if (error) *error = @"ECMWF forecast_hours is outside 0–168 h";
            return NO;
        }
        int lead = (int)value;
        if (i == 0 && lead != 0) {
            if (error) *error = @"ECMWF forecast_hours does not start at 0";
            return NO;
        }
        if (lead <= previous) {
            if (error) *error = @"ECMWF forecast_hours is not strictly increasing";
            return NO;
        }
        leads[i] = lead;
        previous = lead;
    }
    *count = (int)hours.count;
    return YES;
}

static BOOL SameForecastHours(NSArray *hours, const int *leads, int count) {
    if (![hours isKindOfClass:NSArray.class] || (int)hours.count != count) return NO;
    for (int i = 0; i < count; i++) {
        id item = hours[i];
        if (![item isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)item) == CFBooleanGetTypeID())
            return NO;
        if (fabs([item doubleValue] - leads[i]) > 1e-6) return NO;
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
    int schema = PublishedSchema(manifest);
    if (schema < 1 || schema > 2) {
        if (error) *error = @"ECMWF grid schema is unsupported";
        return NO;
    }
    NSDictionary *grid = [manifest[@"grid"] isKindOfClass:NSDictionary.class] ? manifest[@"grid"] : nil;
    NSArray *times = [manifest[@"times"] isKindOfClass:NSArray.class] ? manifest[@"times"] : nil;
    if (schema == 2 && times.count < 1) {
        int leads[80], count = 0;
        NSDate *runDate = PublishedISODate(manifest[@"run"]);
        if (!runDate || !ParseForecastHours(manifest[@"forecast_hours"], leads, &count, error)) return NO;
        NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
        iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        NSMutableArray *generatedTimes = [NSMutableArray arrayWithCapacity:(NSUInteger)count];
        for (int i = 0; i < count; i++)
            [generatedTimes addObject:[iso stringFromDate:[runDate dateByAddingTimeInterval:leads[i] * 3600.0]]];
        times = generatedTimes;
    }
    if (!grid || times.count < 1) {
        if (error) *error = @"ECMWF manifest is missing a grid or valid times";
        return NO;
    }
    NSString *dtype = [grid[@"dtype"] isKindOfClass:NSString.class] ? grid[@"dtype"] : nil;
    BOOL half = [dtype isEqual:@"float16"];
    if (dtype.length && ![dtype isEqual:@"float32"] && !half) {
        if (error) *error = @"ECMWF grid is not float32 or float16";
        return NO;
    }
    NSString *endian = [grid[@"endian"] isKindOfClass:NSString.class] ? grid[@"endian"] : nil;
    unsigned short endianProbe = 1;
    if (![endian isEqual:@"little"] || *((unsigned char *)&endianProbe) != 1) {
        if (error) *error = @"ECMWF grid is not little-endian";
        return NO;
    }
    int nLon = [grid[@"nx"] intValue];
    int nLat = [grid[@"ny"] intValue];
    double step = [grid[@"step"] doubleValue];
    double west = [grid[@"west"] doubleValue];
    double north = [grid[@"north"] doubleValue];
    size_t nPoints = (size_t)nLon * (size_t)nLat;
    if (nLon < 2 || nLat < 2 || nLon > 1000 || nLat > 1000 || nPoints > 300000 || !(step > 0)) {
        if (error) *error = @"ECMWF grid dimensions are unsafe";
        return NO;
    }
    if (times.count < 1 || times.count > 10000) {
        if (error) *error = @"ECMWF grid is too large";
        return NO;
    }
    int nTimes = (int)times.count;
    if ((size_t)VarCount * nPoints * (size_t)nTimes * sizeof(float) > 384u * 1024u * 1024u) {
        if (error) *error = @"ECMWF grid is too large";
        return NO;
    }
    cube->nLon = nLon;
    cube->nLat = nLat;
    cube->west = west;
    cube->north = north;
    cube->step = step;
    cube->nHours = nTimes;
    cube->nPoints = (int)nPoints;
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
        NSString *path = [dir stringByAppendingPathComponent:name];
        float *stack = half ? ReadF16Stack(path, nTimes, (int)nPoints, error)
            : ReadF32(path, nTimes, (int)nPoints, error);
        if (!stack) return NO;
        StoreField(cube, var.intValue, nTimes, stack);
        free(stack);
    }
    NSString *uName = VariableFile(manifest, @"u10", @"u10.f32", error);
    NSString *vName = VariableFile(manifest, @"v10", @"v10.f32", error);
    if (!uName || !vName) return NO;
    NSString *uPath = [dir stringByAppendingPathComponent:uName];
    NSString *vPath = [dir stringByAppendingPathComponent:vName];
    float *u = half ? ReadF16Stack(uPath, nTimes, (int)nPoints, error) : ReadF32(uPath, nTimes, (int)nPoints, error);
    float *v = half ? ReadF16Stack(vPath, nTimes, (int)nPoints, error) : ReadF32(vPath, nTimes, (int)nPoints, error);
    if (!u || !v) { free(u); free(v); return NO; }
    for (int hour = 0; hour < nTimes; hour++) {
        for (size_t point = 0; point < nPoints; point++) {
            float ue = u[(size_t)hour * (size_t)nPoints + point];
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
        for (size_t point = 0; point < nPoints; point++) {
            size_t index = ((size_t)VarRain * nPoints + point) * (size_t)nTimes + (size_t)hour;
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

// expectLead < 0 skips the schema 2 lead check. Schema 1 sidecars have no lead_hours.
static BOOL PublishedField(NSString *root, NSString *runID, NSDate *runDate, NSDate *valid,
    PublishedSpec spec, int nLon, int nLat, float **out, int expectLead, NSString **error) {
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
    NSString *dir = [[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
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
    BOOL global = [PublishedFamilyPath(root).lastPathComponent isEqual:@"ecmwf_ifs_global"];
    double expectedLon0 = global ? -180.0 : 95.0;
    double expectedLat0 = global ? 90.0 : 0.0;
    double expectedStep = global ? 0.5 : 0.25;
    if (!sideRun || !sideValid || fabs([sideRun timeIntervalSinceDate:runDate]) > 1 ||
        fabs([sideValid timeIntervalSinceDate:valid]) > 1 ||
        !SameNumber(side[@"nx"], nLon) || !SameNumber(side[@"ny"], nLat) ||
        !SameNumber(side[@"lon0"], expectedLon0) || !SameNumber(side[@"lat0"], expectedLat0) ||
        !SameNumber(side[@"dlon"], expectedStep) || !SameNumber(side[@"dlat"], -expectedStep) ||
        !SameNumber(side[@"fill"], -32768.0) ||
        ![side[@"units"] isKindOfClass:NSString.class] || ![side[@"units"] isEqual:spec.units] ||
        ![side[@"param"] isEqual:spec.sidecarParam] ||
        ![side[@"dtype"] isEqual:@"float16"] || ![side[@"endian"] isEqual:@"little"] ||
        ![side[@"order"] isEqual:@"north-to-south, west-to-east"] ||
        (expectLead >= 0 && (!SameNumber(side[@"lead_hours"], expectLead) ||
            (side[@"native_step_hours"] && ![side[@"native_step_hours"] isKindOfClass:NSNull.class])))) {
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
    NSString *base = [[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
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

static int PublishedRunSchemaAt(NSString *root, NSString *runID) {
    NSString *path = [[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
        stringByAppendingPathComponent:runID] stringByAppendingPathComponent:@"manifest.json"];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return [[NSFileManager defaultManager] fileExistsAtPath:path] ? -1 : 1;
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![manifest isKindOfClass:NSDictionary.class] || !SupportedGridContract(manifest, nil)) return -1;
    return PublishedSchema(manifest);
}

static BOOL PublishedRunHasLead(NSString *root, NSString *runID, int lead) {
    NSString *path = [[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
        stringByAppendingPathComponent:runID] stringByAppendingPathComponent:@"manifest.json"];
    NSData *data = [NSData dataWithContentsOfFile:path];
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:data ?: [NSData data] options:0 error:nil];
    if (![manifest isKindOfClass:NSDictionary.class]) return NO;
    int hours[80], count = 0;
    if (!ParseForecastHours(manifest[@"forecast_hours"], hours, &count, nil)) return NO;
    for (int i = 0; i < count; i++) if (hours[i] == lead) return YES;
    return NO;
}

// Rain is the accumulated total 24 h earlier in the lead list, not N frames back.
// A lead with no partner uses the newest older cycle whose files cover both
// valid-24 h and valid. A missing complete window stays missing; it is never
// fabricated with zero.
static void ApplyPublishedRain(Cube *cube, const float *currentRain, const int *leads, int nTimes,
    NSString *root, NSArray<NSString *> *previousIDs, NSDate *runDate, PublishedSpec rainSpec, int nLon, int nLat) {
    for (int h = 0; h < nTimes; h++) {
        int partner = -1;
        for (int i = 0; i < nTimes; i++) if (leads[i] == leads[h] - 24) { partner = i; break; }
        float *earlyEnd = NULL, *earlyStart = NULL;
        if (partner < 0 && previousIDs.count) {
            NSDate *endDate = [runDate dateByAddingTimeInterval:leads[h] * 3600.0];
            NSDate *startDate = [endDate dateByAddingTimeInterval:-24 * 3600.0];
            for (NSString *previousID in previousIDs) {
                float *candidateEnd = NULL, *candidateStart = NULL;
                int schema = PublishedRunSchemaAt(root, previousID);
                if (schema < 0) continue;
                int expectLead = -1;
                if (schema == 2) {
                    NSTimeInterval delta = [endDate timeIntervalSinceDate:PublishedRunDate(previousID)];
                    double rounded = round(delta / 3600.0);
                    if (!(delta >= 0) || fabs(delta / 3600.0 - rounded) > 1e-6 || rounded < 24 || rounded > 168) continue;
                    expectLead = (int)rounded;
                    if (!PublishedRunHasLead(root, previousID, expectLead) ||
                        !PublishedRunHasLead(root, previousID, expectLead - 24)) continue;
                }
                PublishedField(root, previousID, PublishedRunDate(previousID), endDate, rainSpec,
                    nLon, nLat, &candidateEnd, expectLead, nil);
                PublishedField(root, previousID, PublishedRunDate(previousID), startDate, rainSpec,
                    nLon, nLat, &candidateStart, expectLead - (expectLead >= 0 ? 24 : 0), nil);
                BOOL covered = NO;
                if (candidateEnd && candidateStart) for (int p = 0; p < cube->nPoints; p++)
                    if (isfinite(OwnAccumulationWindow(candidateEnd[p], candidateStart[p]))) { covered = YES; break; }
                if (covered) {
                    earlyEnd = candidateEnd;
                    earlyStart = candidateStart;
                    break;
                }
                free(candidateEnd);
                free(candidateStart);
            }
        }
        for (int p = 0; p < cube->nPoints; p++) {
            float rain = NAN;
            if (partner >= 0)
                rain = (float)OwnAccumulationWindow(currentRain[(size_t)h * (size_t)cube->nPoints + (size_t)p],
                    currentRain[(size_t)partner * (size_t)cube->nPoints + (size_t)p]);
            else if (earlyEnd && earlyStart)
                rain = (float)OwnAccumulationWindow(earlyEnd[p], earlyStart[p]);
            cube->data[((size_t)VarRain * (size_t)cube->nPoints + (size_t)p) * (size_t)nTimes + (size_t)h] = rain;
        }
        free(earlyEnd);
        free(earlyStart);
    }
}

static BOOL LoadPublishedCube(NSString *root, NSString *runID, NSArray<NSString *> *previousIDs,
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
    // Read the first sidecar to establish dimensions, then require the schema 1
    // sequence: 33 frames at 3 h, 0–96 h.
    NSString *base = [[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
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
    if (nLon < 2 || nLat < 2 || nLon > 1000 || nLat > 1000 || (size_t)nLon * (size_t)nLat > 300000) {
        if (error) *error = @"published ECMWF grid dimensions are unsafe";
        return NO;
    }
    int nTimes = (int)jsonNames.count;
    if (nTimes != 33) {
        if (error) *error = @"published ECMWF run must contain 33 three-hour frames";
        return NO;
    }
    if ((size_t)VarCount * (size_t)nLon * (size_t)nLat * (size_t)nTimes * sizeof(float) > 384u * 1024u * 1024u) {
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
            if (!PublishedField(root, runID, runDate, when, specs[var], nLon, nLat, &field, -1, error)) {
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
    // 24 h is a lead-time pair. Eight frames back is 24 h only while the step is 3 h.
    int schema1Leads[33];
    for (int h = 0; h < nTimes && h < 33; h++) schema1Leads[h] = 3 * h;
    ApplyPublishedRain(cube, currentRain, schema1Leads, nTimes, root, previousIDs, runDate, specs[VarRain], nLon, nLat);
    free(currentRain);
    cube->fetched = runDate.timeIntervalSince1970;
    strncpy(cube->httpDate, "ECMWF Open Data", sizeof cube->httpDate - 1);
    AdoptCubeGrid(cube);
    if (runDateOut) *runDateOut = runDate;
    return YES;
}

// Schema 2: the manifest's forecast_hours are the frames. A listed hour with
// no file fails the run. Hours that are not listed are not invented.
static BOOL LoadPublishedLadder(NSString *root, NSString *runID, NSArray<NSString *> *previousIDs,
    const int *leads, int nLeads, Cube *cube, NSDate **runDateOut, NSString **error) {
    NSDate *runDate = PublishedRunDate(runID);
    if (!runDate || !leads || nLeads < 2) {
        if (error) *error = @"published ECMWF run id is invalid";
        return NO;
    }
    NSString *manifestPath = [[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
        stringByAppendingPathComponent:runID] stringByAppendingPathComponent:@"manifest.json"];
    NSData *manifestData = [NSData dataWithContentsOfFile:manifestPath];
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:manifestData ?: [NSData data] options:0 error:nil];
    if (![manifest isKindOfClass:NSDictionary.class]) {
        if (error) *error = @"published ECMWF schema 2 run has no manifest";
        return NO;
    }
    if (!SupportedGridContract(manifest, error) || PublishedSchema(manifest) != 2) {
        if (error && !*error) *error = @"ECMWF grid schema is unsupported";
        return NO;
    }
    if (!SameForecastHours(manifest[@"forecast_hours"], leads, nLeads)) {
        if (error) *error = @"ECMWF forecast_hours do not match the run";
        return NO;
    }
    id uniform = manifest[@"uniform_step_hours"];
    if (uniform && ![uniform isKindOfClass:NSNull.class]) {
        if (error) *error = @"ECMWF schema 2 claims a uniform step";
        return NO;
    }
    id horizon = manifest[@"horizon_hours"];
    if (horizon && (![horizon isKindOfClass:NSNumber.class] || [horizon intValue] != leads[nLeads - 1])) {
        if (error) *error = @"ECMWF horizon does not match forecast_hours";
        return NO;
    }
    PublishedSpec specs[VarCount] = {
        {@"mslp", @"msl", @"hPa"}, {@"t850", @"t", @"degC"},
        {@"t2m", @"2t", @"degC"}, {@"u10", @"10u", @"m/s"},
        {@"v10", @"10v", @"m/s"}, {@"tp", @"tp", @"mm"}
    };
    NSDate *firstValid = [runDate dateByAddingTimeInterval:leads[0] * 3600.0];
    BOOL present = NO;
    if (!PublishedHasFile(root, runID, firstValid, specs[0].directoryName, &present) || !present) {
        if (error) *error = @"published ECMWF run has no valid mslp field";
        return NO;
    }
    NSString *validID = nil;
    NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
    iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    iso.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
    NSString *validText = [iso stringFromDate:firstValid];
    validID = [NSString stringWithFormat:@"%@%@%@T%@%@",
        [validText substringWithRange:NSMakeRange(0, 4)],
        [validText substringWithRange:NSMakeRange(5, 2)],
        [validText substringWithRange:NSMakeRange(8, 2)],
        [validText substringWithRange:NSMakeRange(11, 2)], @"Z"];
    NSString *sidePath = [[[[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
        stringByAppendingPathComponent:runID] stringByAppendingPathComponent:@"mslp"]
        stringByAppendingPathComponent:validID] stringByAppendingPathExtension:@"json"];
    NSData *sideData = [NSData dataWithContentsOfFile:sidePath];
    NSDictionary *side = [NSJSONSerialization JSONObjectWithData:sideData ?: [NSData data] options:0 error:nil];
    if (![side isKindOfClass:NSDictionary.class] || ![side[@"nx"] isKindOfClass:NSNumber.class] ||
        ![side[@"ny"] isKindOfClass:NSNumber.class]) {
        if (error) *error = @"published ECMWF first sidecar has invalid dimensions";
        return NO;
    }
    int nLon = [side[@"nx"] intValue], nLat = [side[@"ny"] intValue];
    if (nLon < 2 || nLat < 2 || nLon > 1000 || nLat > 1000 || (size_t)nLon * (size_t)nLat > 300000) {
        if (error) *error = @"published ECMWF grid dimensions are unsafe";
        return NO;
    }
    BOOL global = [PublishedFamilyPath(root).lastPathComponent isEqual:@"ecmwf_ifs_global"];
    if (global && (nLon != 720 || nLat != 361)) {
        if (error) *error = @"published global ECMWF run is not the 0.5-degree 720 by 361 grid";
        return NO;
    }
    int nTimes = nLeads;
    // The published 0.5-degree global cube is 720*361*53*6 float values
    // (~330 MiB), plus the rain working set. Keep one bounded run below 512 MiB.
    if ((size_t)VarCount * (size_t)nLon * (size_t)nLat * (size_t)nTimes * sizeof(float) > 512u * 1024u * 1024u) {
        if (error) *error = @"published ECMWF grid is too large";
        return NO;
    }
    cube->nLon = nLon; cube->nLat = nLat;
    cube->west = global ? -180.0 : 95.0;
    cube->north = global ? 90.0 : 0.0;
    cube->step = global ? 0.5 : 0.25;
    cube->nHours = nTimes; cube->nPoints = nLon * nLat;
    cube->times = calloc((size_t)nTimes, sizeof(int64_t));
    cube->data = calloc((size_t)VarCount * (size_t)cube->nPoints * (size_t)nTimes, sizeof(float));
    if (!cube->times || !cube->data) {
        if (error) *error = @"not enough memory for the published ECMWF grid";
        return NO;
    }
    float *currentRain = calloc((size_t)nTimes * (size_t)cube->nPoints, sizeof(float));
    if (!currentRain) {
        if (error) *error = @"not enough memory for published rainfall";
        return NO;
    }
    for (int h = 0; h < nTimes; h++) {
        NSDate *when = [runDate dateByAddingTimeInterval:leads[h] * 3600.0];
        cube->times[h] = (int64_t)llround(when.timeIntervalSince1970);
        BOOL hourPresent = NO;
        if (!PublishedHasFile(root, runID, when, @"mslp", &hourPresent) || !hourPresent) {
            free(currentRain);
            if (error) *error = [NSString stringWithFormat:@"published ECMWF run is missing the %d h frame", leads[h]];
            return NO;
        }
        for (int var = 0; var < VarCount; var++) {
            float *field = NULL;
            if (!PublishedField(root, runID, runDate, when, specs[var], nLon, nLat, &field, leads[h], error)) {
                free(currentRain);
                return NO;
            }
            for (int p = 0; p < cube->nPoints; p++) {
                size_t index = ((size_t)var * (size_t)cube->nPoints + (size_t)p) * (size_t)nTimes + (size_t)h;
                cube->data[index] = field[p];
                if (var == VarRain) currentRain[(size_t)h * (size_t)cube->nPoints + (size_t)p] = field[p];
            }
            free(field);
        }
    }
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
    ApplyPublishedRain(cube, currentRain, leads, nTimes, root, previousIDs, runDate, specs[VarRain], nLon, nLat);
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

static void BlurField(const double *src, double *dst, int nLon, int nLat, double sigma);
static void BlurFiniteField(const double *src, double *dst, int nLon, int nLat, double sigma);
static void MixLandMSLP(double *field, const double *mild, const double *wide,
    const double *terrain, const uint8_t *land, int n, uint8_t *roughOut);

// One model hour's linear pieces: short Gaussian, then the mild and wide
// blurs the land correction mixes. The mix itself runs after interpolation.
static void EnsureSmoothedHour(Cube *cube, int hour, const uint8_t *land) {
    if (!cube || hour < 0 || hour >= cube->nHours) return;
    os_unfair_lock_lock(&cube->smoothLock);
    if (!cube->smooth) cube->smooth = calloc((size_t)cube->nHours, sizeof(double *));
    BOOL ready = cube->smooth && cube->smooth[hour];
    BOOL needWeight = land && !cube->landWeight;
    os_unfair_lock_unlock(&cube->smoothLock);
    if (needWeight) {
        int n = cube->nPoints;
        double *mask = malloc((size_t)n * sizeof(double));
        double *weight = malloc((size_t)n * sizeof(double));
        if (mask && weight) {
            for (int i = 0; i < n; i++) mask[i] = land[i] ? 1.0 : 0.0;
            BlurField(mask, weight, cube->nLon, cube->nLat, 2.0);
        }
        free(mask);
        os_unfair_lock_lock(&cube->smoothLock);
        if (weight && !cube->landWeight) cube->landWeight = weight;
        else free(weight);
        os_unfair_lock_unlock(&cube->smoothLock);
    }
    if (ready) return;
    double began = ProfileNow();
    int n = cube->nPoints;
    double *field = ScalarField(cube, VarMSLP, hour);
    double *mild = field ? malloc((size_t)n * sizeof(double)) : NULL;
    double *wide = field ? malloc((size_t)n * sizeof(double)) : NULL;
    double *pack = field && mild && wide ? malloc((size_t)n * 3 * sizeof(double)) : NULL;
    if (pack) {
        OwnGaussianSmooth(field, cube->nLon, cube->nLat, 1.25);
        BlurFiniteField(field, mild, cube->nLon, cube->nLat, 2.0);
        BlurFiniteField(field, wide, cube->nLon, cube->nLat, 8.0);
        memcpy(pack, field, (size_t)n * sizeof(double));
        memcpy(pack + n, mild, (size_t)n * sizeof(double));
        memcpy(pack + 2 * n, wide, (size_t)n * sizeof(double));
    }
    free(field);
    free(mild);
    free(wide);
    os_unfair_lock_lock(&cube->smoothLock);
    if (pack && cube->smooth && !cube->smooth[hour]) cube->smooth[hour] = pack;
    else free(pack);
    os_unfair_lock_unlock(&cube->smoothLock);
    gRenderProfile.smoothMs += ProfileNow() - began;
}

static void LerpPacked(const double *a, const double *b, double t, double *dst, int n) {
    if (!b || t <= 1e-8) { memcpy(dst, a, (size_t)n * sizeof(double)); return; }
    double u = 1.0 - t;
    vDSP_vsmulD(a, 1, &u, dst, 1, (vDSP_Length)n);
    vDSP_vsmaD(b, 1, &t, dst, 1, dst, 1, (vDSP_Length)n);
}

// Caller frees the field and the rough mask.
static double *SmoothedMSLP(Cube *cube, double hour, const uint8_t *land, uint8_t **roughOut) {
    if (roughOut) *roughOut = NULL;
    if (!cube || !isfinite(hour) || hour < 0 || hour > cube->nHours - 1) return NULL;
    int lo = (int)floor(hour);
    int hi = lo < cube->nHours - 1 ? lo + 1 : lo;
    double t = hour - lo;
    if (t < 0) t = 0;
    EnsureSmoothedHour(cube, lo, land);
    if (hi != lo) EnsureSmoothedHour(cube, hi, land);
    os_unfair_lock_lock(&cube->smoothLock);
    double *a = cube->smooth ? cube->smooth[lo] : NULL;
    double *b = cube->smooth ? cube->smooth[hi] : NULL;
    double *terrain = cube->landWeight;
    os_unfair_lock_unlock(&cube->smoothLock);
    if (!a) return NULL;
    int n = cube->nPoints;
    double *out = malloc((size_t)n * sizeof(double));
    double *mild = malloc((size_t)n * sizeof(double));
    double *wide = malloc((size_t)n * sizeof(double));
    uint8_t *rough = calloc((size_t)n, 1);
    if (!out || !mild || !wide || !rough) {
        free(out); free(mild); free(wide); free(rough);
        return NULL;
    }
    double began = ProfileNow();
    LerpPacked(a, b, t, out, n);
    LerpPacked(a + n, b ? b + n : NULL, t, mild, n);
    LerpPacked(a + 2 * n, b ? b + 2 * n : NULL, t, wide, n);
    MixLandMSLP(out, mild, wide, terrain, land, n, rough);
    gRenderProfile.fieldMs += ProfileNow() - began;
    free(mild);
    free(wide);
    if (roughOut) *roughOut = rough;
    else free(rough);
    return out;
}

static BOOL PixelUnproject(OwnView view, double x, double yDown, double *latitude, double *longitude);

BOOL OwnChartImagePoint(double latitude, double longitude, double *xFraction, double *yFraction) {
    if (!xFraction || !yFraction) return NO;
    OwnView view = gClassicWorld
        ? OwnWorldViewMake(ViewWest(), ViewEast(), ViewSouth(), ViewNorth(), 0, 0, kPanelW, kMapH)
        : OwnViewMake(OwnAustraliaLambert(), ViewWest(), ViewEast(), ViewSouth(), ViewNorth(),
            0, 0, kPanelW, kMapH);
    double x, yDown;
    if (!OwnViewProject(view, latitude, longitude, &x, &yDown)) return NO;
    if (x < 0 || yDown < 0 || x > kPanelW || yDown > kMapH) return NO;
    *xFraction = x / kPanelW;
    *yFraction = (kTitleH + yDown) / (double)kPanelH;
    return YES;
}

// Contours only need the cells that can cross the drawn map. The Lambert
// rectangle reaches past the view's lon/lat box at its corners, so the window
// is the box around the unprojected map edge. Two cells of margin keep a line
// that leaves the frame the same shape it had on the full grid, and its ends
// outside the map.
static double *ContourWindow(const double *field, int nLon, int nLat, OwnView view,
    int *outW, int *outH, double *originX, double *originY) {
    if (!field || nLon < 2 || nLat < 2) return NULL;
    double step = GStep();
    if (!(step > 0)) return NULL;
    double west = ViewWest(), east = ViewEast(), south = ViewSouth(), north = ViewNorth();
    for (int k = 0; k <= 64; k++) {
        double u = k / 64.0;
        double edge[4][2] = {{u * kPanelW, 0}, {u * kPanelW, kMapH}, {0, u * kMapH}, {kPanelW, u * kMapH}};
        for (int e = 0; e < 4; e++) {
            double lat, lon;
            if (!PixelUnproject(view, edge[e][0], edge[e][1], &lat, &lon)) continue;
            west = fmin(west, lon); east = fmax(east, lon);
            south = fmin(south, lat); north = fmax(north, lat);
        }
    }
    int i0 = (int)floor((west - GWest()) / step) - 2;
    int i1 = (int)ceil((east - GWest()) / step) + 2;
    int j0 = (int)floor((GNorth() - north) / step) - 2;
    int j1 = (int)ceil((GNorth() - south) / step) + 2;
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 > nLon - 1) i1 = nLon - 1;
    if (j1 > nLat - 1) j1 = nLat - 1;
    int w = i1 - i0 + 1, h = j1 - j0 + 1;
    if (w < 2 || h < 2) return NULL;
    double *box = malloc((size_t)w * (size_t)h * sizeof(double));
    if (!box) return NULL;
    for (int j = 0; j < h; j++)
        memcpy(box + (size_t)j * (size_t)w, field + (size_t)(j0 + j) * (size_t)nLon + (size_t)i0,
            (size_t)w * sizeof(double));
    *outW = w;
    *outH = h;
    *originX = GWest() + i0 * step;
    *originY = GNorth() - j0 * step;
    return box;
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
    if (gClassicWorld) {
        double period = (double)nLon;
        fi = fi - floor(fi / period) * period;
        if (fi < 0) fi += period;
    } else if (fi < 0 || fi > nLon - 1) return NAN;
    if (fj < 0 || fj > nLat - 1) return NAN;
    int i = (int)floor(fi);
    int j = (int)floor(fj);
    if (j >= nLat - 1) j = nLat - 2;
    if (i < 0 || j < 0) return NAN;
    double tx = fi - i;
    double ty = fj - j;
    int i1 = gClassicWorld ? (i + 1) % nLon : (i >= nLon - 1 ? nLon - 1 : i + 1);
    if (!gClassicWorld && i >= nLon - 1) { i = nLon - 2; i1 = nLon - 1; tx = 1; }
    double a = field[j * nLon + i];
    double b = field[j * nLon + i1];
    double c = field[(j + 1) * nLon + i];
    double d = field[(j + 1) * nLon + i1];
    if (!isfinite(a) || !isfinite(b) || !isfinite(c) || !isfinite(d)) return NAN;
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// Clamp a pixel that falls just outside the grid so the colour wash meets the
// panel edge instead of stopping on the Lambert arc.
static double SampleWash(const double *field, int nLon, int nLat, double longitude, double latitude) {
    double west = GWest();
    double north = GNorth();
    double step = GStep();
    double east = west + (gClassicWorld ? nLon : nLon - 1) * step;
    double south = north - (nLat - 1) * step;
    if ((!gClassicWorld && (longitude < west - 14.0 || longitude > east + 14.0)) ||
        latitude > north + 14.0 || latitude < south - 14.0)
        return NAN;
    if (gClassicWorld) {
        while (longitude < west) longitude += 360;
        while (longitude >= east) longitude -= 360;
    } else {
        if (longitude < west) longitude = west;
        if (longitude > east) longitude = east;
    }
    if (latitude > north) latitude = north;
    if (latitude < south) latitude = south;
    return SampleBilinear(field, nLon, nLat, longitude, latitude);
}

static BOOL PixelUnproject(OwnView view, double x, double yDown, double *latitude, double *longitude) {
    if (!view.valid || view.scale == 0) return NO;
    if (view.equirectangular) {
        *longitude = view.west + (x - view.offsetX) / view.scale;
        *latitude = view.north - (yDown - view.offsetY) / view.scale;
        return isfinite(*latitude) && isfinite(*longitude);
    }
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
    int flen = rad * 2 + 1;
    double *tmp = malloc((size_t)n * sizeof(double));
    int span = (nLon > nLat ? nLon : nLat) + flen;
    double *pad = malloc((size_t)span * sizeof(double));
    if (!tmp || !pad) { free(tmp); free(pad); memcpy(dst, src, (size_t)n * sizeof(double)); return; }
    for (int j = 0; j < nLat; j++) {
        for (int i = -rad; i < nLon + rad; i++) {
            int ii = i;
            if (ii < 0) ii = 0;
            if (ii >= nLon) ii = nLon - 1;
            pad[i + rad] = src[j * nLon + ii];
        }
        vDSP_convD(pad, 1, kernel, 1, tmp + j * nLon, 1, (vDSP_Length)nLon, (vDSP_Length)flen);
    }
    for (int i = 0; i < nLon; i++) {
        for (int j = -rad; j < nLat + rad; j++) {
            int jj = j;
            if (jj < 0) jj = 0;
            if (jj >= nLat) jj = nLat - 1;
            pad[j + rad] = tmp[jj * nLon + i];
        }
        vDSP_convD(pad, 1, kernel, 1, dst + i, (vDSP_Stride)nLon, (vDSP_Length)nLat, (vDSP_Length)flen);
    }
    free(tmp);
    free(pad);
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
// synoptic-scale land field, feathered across the coast. The blurs are
// linear; this mix is not, so playback applies it after interpolating.
static void MixLandMSLP(double *field, const double *mild, const double *wide,
    const double *terrainW, const uint8_t *land, int n, uint8_t *roughOut) {
    if (!field || !mild || !wide || n < 1) return;
    for (int i = 0; i < n; i++) {
        double terrain = terrainW ? terrainW[i] : 0;
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
            double apart = fmax(minPx, 6.0 * fmax(lab.halfW, other.halfW));
            if (hypot(lab.x - other.x, lab.y - other.y) < apart) { close = YES; break; }
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
            if (hypot(lab.x - centers[c].x, lab.y - centers[c].y) < fmax(centrePx, 6.0 * lab.halfW))
                close = YES;
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

// Two Chaikin cuts after the contour is projected. Grid corners become a
// curve; endpoints of an open isobar stay put.
static OwnVec *RefineLine(const OwnVec *in, int count, int closed, int *outCount) {
    if (count < 2 || (closed && count < 3)) return NULL;
    double began = ProfileNow();
    int cap1 = count * 2;
    OwnVec *mid = malloc((size_t)cap1 * sizeof(OwnVec));
    int n1 = mid ? OwnChaikin(in, count, closed, mid, cap1) : -1;
    if (n1 < 2) { free(mid); gChaikinMs += ProfileNow() - began; return NULL; }
    int cap2 = n1 * 2;
    OwnVec *out = malloc((size_t)cap2 * sizeof(OwnVec));
    int n2 = out ? OwnChaikin(mid, n1, closed, out, cap2) : -1;
    free(mid);
    if (n2 < 2) { free(out); gChaikinMs += ProfileNow() - began; return NULL; }
    *outCount = n2;
    gChaikinMs += ProfileNow() - began;
    return out;
}

// Several threads render at once (live player, chart preparation, scrub, main),
// so the label table is built once and the width cache is per thread.
static NSString *PressureText(int hPa) {
    static NSArray<NSString *> *text;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableArray *built = [NSMutableArray arrayWithCapacity:1601];
        for (int i = 0; i <= 1600; i++) [built addObject:[NSString stringWithFormat:@"%d", i]];
        text = [built copy];
    });
    if (hPa < 0 || hPa > 1600) return [NSString stringWithFormat:@"%d", hPa];
    return text[hPa];
}

static double LabelHalf(double level, void *context) {
    NSFont *font = (__bridge NSFont *)context;
    int key = (int)llround(level);
    static _Thread_local double cache[1601];
    static _Thread_local const void *fontSeen;
    if (fontSeen != (__bridge const void *)font) {
        memset(cache, 0, sizeof cache);
        fontSeen = (__bridge const void *)font;
    }
    if (key >= 0 && key <= 1600 && cache[key] > 0) return cache[key];
    NSString *text = PressureText(key);
    NSSize size = [text sizeWithAttributes:@{NSFontAttributeName: font}];
    double half = size.width * 0.5;
    if (key >= 0 && key <= 1600) cache[key] = half > 0 ? half : 0.01;
    return half;
}

static double LabelHalfHeight(NSFont *font) {
    NSSize size = [@"1020" sizeWithAttributes:@{NSFontAttributeName: font ?: [NSFont systemFontOfSize:15]}];
    return size.height > 2 ? size.height * 0.5 : 8;
}

// Tiny contours fade to nothing at the geometric pruning thresholds. This
// is a function of the current field, so seeking and playing agree. Cutting
// detours or dropping an opaque ring at a size threshold causes visible pops.
static double ContourVisibility(const OwnLine *line) {
    double t = MIN(1, MAX(0, (PolyLength(line) - 16) / 24));
    if (line->closed) {
        double area = 0, minX = INFINITY, maxX = -INFINITY, minY = INFINITY, maxY = -INFINITY;
        for (int i = 0; i < line->count; i++) {
            OwnVec p = line->pts[i], q = line->pts[(i + 1) % line->count];
            area += p.x * q.y - q.x * p.y;
            minX = MIN(minX, p.x); maxX = MAX(maxX, p.x);
            minY = MIN(minY, p.y); maxY = MAX(maxY, p.y);
        }
        t = MIN(t, MIN(1, MAX(0, fabs(area) * .5 / 600)));
        t = MIN(t, MIN(1, MAX(0, (MAX(maxX - minX, maxY - minY) - 6) / 12)));
    }
    return t * t * (3 - 2 * t);
}

static void StrokeRun(CGContextRef ctx, const OwnVec *pts, int a, int b, int closed) {
    if (b - a < 2) return;
    CGContextBeginPath(ctx);
    CGContextMoveToPoint(ctx, pts[a].x, pts[a].y);
    for (int i = a + 1; i < b; i++) CGContextAddLineToPoint(ctx, pts[i].x, pts[i].y);
    if (closed) CGContextClosePath(ctx);
    CGContextStrokePath(ctx);
}

static void StrokeLine(CGContextRef ctx, const OwnVec *pts, int count, int closed,
    const OwnVec *avoid, const double *avoidAlpha, int nAvoid, double avoidRadius,
    double width, double red, double green, double blue, double alpha) {
    if (count < 2) return;
    CGContextSaveGState(ctx);
    if (nAvoid > 0 && avoidRadius > 0) {
        // Clip the stroke at the actual circle, rather than dropping vertices
        // as they enter it. Vertex-based gaps snap and can open a closed ring
        // even when the marker never touches that ring.
        CGContextBeginPath(ctx);
        CGContextAddRect(ctx, CGContextGetClipBoundingBox(ctx));
        for (int a = 0; a < nAvoid; a++) {
            // A faint marker must not suddenly acquire a full-size hole.
            double radius = avoidRadius * (avoidAlpha ? avoidAlpha[a] : 1);
            if (radius <= 0) continue;
            CGContextAddEllipseInRect(ctx, CGRectMake(avoid[a].x - radius,
                avoid[a].y - radius, 2 * radius, 2 * radius));
        }
        CGContextEOClip(ctx);
    }
    CGContextSetLineWidth(ctx, width);
    CGContextSetRGBStrokeColor(ctx, red, green, blue, alpha);
    StrokeRun(ctx, pts, 0, count, closed);
    CGContextRestoreGState(ctx);
}

// A contour may stop where the model data stops: the grid edge, or a missing cell.
static BOOL AtDataEdge(OwnView view, double x, double yUp, const double *field, int nLon, int nLat,
    double originX, double originY) {
    double lat, lon, step = GStep();
    if (!field || !(step > 0) || !PixelUnproject(view, x, kMapH - yUp, &lat, &lon)) return YES;
    double fi = (lon - originX) / step, fj = (originY - lat) / step;
    if (fi < 1.5 || fj < 1.5 || fi > nLon - 2.5 || fj > nLat - 2.5) return YES;
    int i0 = (int)floor(fi), j0 = (int)floor(fj);
    for (int j = j0 - 1; j <= j0 + 2; j++)
        for (int i = i0 - 1; i <= i0 + 2; i++)
            if (!isfinite(field[(size_t)j * (size_t)nLon + (size_t)i])) return YES;
    return NO;
}

// Most inland open end, in chart points, measured before a label cuts a gap.
// Ends where the model data stops do not count.
static void NoteOpenEnds(const OwnLineSet *lines, OwnView view, const double *field, int nLon, int nLat,
    double originX, double originY) {
    double worst = -1e9;
    if (lines) {
        for (int i = 0; i < lines->count; i++) {
            const OwnLine *line = &lines->lines[i];
            if (!line->pts || line->count < 2 || line->closed) continue;
            OwnVec ends[2] = {line->pts[0], line->pts[line->count - 1]};
            for (int e = 0; e < 2; e++) {
                double inset = fmin(fmin(ends[e].x, ends[e].y),
                    fmin(kPanelW - ends[e].x, kMapH - ends[e].y));
                if (inset <= worst) continue;
                if (inset > 0 && AtDataEdge(view, ends[e].x, ends[e].y, field, nLon, nLat, originX, originY)) continue;
                worst = inset;
            }
        }
    }
    gOpenInset = worst;
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

// Glyph stroke in the fill under the label, then the ink. The same treatment
// is used for stills and for movie frames. A nil halo draws the ink alone.
static void DrawHaloText(CGContextRef ctx, NSString *text, NSFont *font, NSColor *ink, NSColor *halo,
    double x, double y, double angle) {
    if (!text.length || !font) return;
    NSDictionary *fill = @{NSFontAttributeName: font, NSForegroundColorAttributeName: ink};
    NSSize size = [text sizeWithAttributes:fill];
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, x, y);
    CGContextRotateCTM(ctx, angle);
    NSPoint origin = NSMakePoint(-size.width / 2.0, -size.height / 2.0);
    if (halo) [text drawAtPoint:origin withAttributes:@{
        NSFontAttributeName: font,
        NSForegroundColorAttributeName: halo,
        NSStrokeColorAttributeName: halo,
        NSStrokeWidthAttributeName: @(100.0 / font.pointSize),
    }];
    [text drawAtPoint:origin withAttributes:fill];
    CGContextRestoreGState(ctx);
}

static NSColor *HaloColour(OwnView view, double x, double yUp, const uint8_t *land, int nLon, int nLat,
    MSLPColour sea, MSLPColour landColour) {
    MSLPColour rgb = sea;
    double lat = 0, lon = 0;
    if (land && PixelUnproject(view, x, kMapH - yUp, &lat, &lon) && GStep() > 0) {
        int i = (int)llround((lon - GWest()) / GStep());
        int j = (int)llround((GNorth() - lat) / GStep());
        if (i >= 0 && j >= 0 && i < nLon && j < nLat && land[(size_t)j * (size_t)nLon + (size_t)i])
            rgb = landColour;
    }
    return [NSColor colorWithSRGBRed:rgb.red green:rgb.green blue:rgb.blue alpha:1];
}

static NSString *PressureText(int hPa);

static void DrawCentreMark(CGContextRef ctx, double x, double y, BOOL high, double value,
    NSFont *letterFont, NSFont *valueFont, NSColor *ink, NSColor *halo) {
    CGContextSaveGState(ctx);
    CGContextSetStrokeColorWithColor(ctx, ink.CGColor);
    CGContextSetLineWidth(ctx, 1.15);
    CGContextMoveToPoint(ctx, x - 4.2, y - 4.2);
    CGContextAddLineToPoint(ctx, x + 4.2, y + 4.2);
    CGContextMoveToPoint(ctx, x - 4.2, y + 4.2);
    CGContextAddLineToPoint(ctx, x + 4.2, y - 4.2);
    CGContextStrokePath(ctx);
    DrawHaloText(ctx, high ? @"H" : @"L", letterFont, ink, halo, x, y + 14, 0);
    DrawHaloText(ctx, PressureText((int)llround(value)), valueFont, ink, halo, x, y - 16, 0);
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
    uint8_t *ocean;
    const uint8_t *oceanLand;
    OwnView oceanView;
    int oceanW, oceanH;
} PixelLocationCache;

static void FreePixelLocationCache(void *value) {
    PixelLocationCache *cache = value;
    if (!cache) return;
    free(cache->locations);
    free(cache->ocean);
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

static BOOL MaskOcean(const uint8_t *land, double lon, double lat);

// 1 where the plate pixel is ocean. Built once per view; the colour loops
// then read a byte instead of locating the mask cell again.
static const uint8_t *PixelOcean(OwnView view, int width, int height, const uint8_t *land) {
    if (!land) return NULL;
    const OwnVec *locations = PixelLocations(view, width, height);
    if (!locations) return NULL;
    PixelLocationCache *cache = pthread_getspecific(PixelLocationKey());
    if (!cache) return NULL;
    if (cache->ocean && cache->oceanLand == land && cache->oceanW == width && cache->oceanH == height
        && memcmp(&cache->oceanView, &view, sizeof view) == 0)
        return cache->ocean;
    uint8_t *next = malloc((size_t)width * (size_t)height);
    if (!next) return NULL;
    for (int i = 0; i < width * height; i++) {
        OwnVec point = locations[i];
        next[i] = isfinite(point.y) && MaskOcean(land, point.x, point.y) ? 1 : 0;
    }
    free(cache->ocean);
    cache->ocean = next;
    cache->oceanLand = land;
    cache->oceanView = view;
    cache->oceanW = width;
    cache->oceanH = height;
    return cache->ocean;
}

static BOOL MaskOcean(const uint8_t *land, double lon, double lat) {
    if (!land) return NO;
    double step = GStep();
    if (!(step > 0)) return NO;
    int i = (int)llround((lon - GWest()) / step);
    int j = (int)llround((GNorth() - lat) / step);
    int nLon = GNLon(), nLat = GNLat();
    if (i < 0 || j < 0 || i >= nLon || j >= nLat) return YES;
    return land[(size_t)j * (size_t)nLon + (size_t)i] == 0;
}

// Dark core over a light halo, above the colour fill and below the isobars.
// The rings are projected once and stroked twice.
static void AddWorldCoastSegment(CGMutablePathRef path, const OwnVec *points, int count,
    BOOL closed, double tolerance) {
    if (count < 2) return;
    OwnVec *copy = malloc((size_t)count * sizeof(*copy));
    if (!copy) return;
    memcpy(copy, points, (size_t)count * sizeof(*copy));
    OwnLine line = {.pts = copy, .count = count, .closed = closed};
    OwnLineSet set = {.lines = &line, .count = 1};
    OwnSimplifyContours(&set, tolerance);
    CGPathMoveToPoint(path, NULL, line.pts[0].x, line.pts[0].y);
    for (int i = 1; i < line.count; i++)
        CGPathAddLineToPoint(path, NULL, line.pts[i].x, line.pts[i].y);
    if (closed) CGPathCloseSubpath(path);
    free(line.pts);
}

static BOOL DrawWorldCoastline(CGContextRef ctx, OwnView view, OwnCoast coast) {
    CGMutablePathRef *paths = calloc((size_t)coast.rings, sizeof(*paths));
    if (!paths) return NO;
    CGAffineTransform transform = CGContextGetCTM(ctx);
    double scale = fmax(hypot(transform.a, transform.b), hypot(transform.c, transform.d));
    double tolerance = 0.35 / fmax(1, scale);
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r], n = coast.ringCount[r], count = 0;
        OwnVec *points = malloc((size_t)n * sizeof(*points));
        paths[r] = CGPathCreateMutable();
        if (!points || !paths[r]) {
            free(points);
            for (int j = 0; j <= r; j++) if (paths[j]) CGPathRelease(paths[j]);
            free(paths);
            return NO;
        }
        BOOL closed = YES;
        for (int i = 0; i < n; i++) {
            double x, y;
            BOOL valid = OwnViewProject(view, coast.lat[start + i], coast.lon[start + i], &x, &y);
            BOOL seam = i > 0 && fabs(coast.lon[start + i] - coast.lon[start + i - 1]) > 180;
            if (!valid || seam) {
                AddWorldCoastSegment(paths[r], points, count, NO, tolerance);
                count = 0;
                closed = NO;
            }
            if (valid) points[count++] = (OwnVec){x, kMapH - y};
        }
        AddWorldCoastSegment(paths[r], points, count, closed, tolerance);
        free(points);
    }
    CGContextSetLineJoin(ctx, kCGLineJoinRound);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    // Separate rings keep Core Graphics from building a huge intersection
    // table for thousands of overlapping subpixel islands and round joins.
    // Projection-space simplification stays within 0.35 output pixels.
    for (int pass = 0; pass < 2; pass++) {
        if (pass == 0) CGContextSetRGBStrokeColor(ctx, 0.98, 0.97, 0.93, 1);
        else CGContextSetRGBStrokeColor(ctx, 0.07, 0.06, 0.05, 0.85);
        CGContextSetLineWidth(ctx, pass == 0 ? 3.2 : 1.2);
        for (int r = 0; r < coast.rings; r++) {
            CGContextAddPath(ctx, paths[r]);
            CGContextStrokePath(ctx);
        }
    }
    for (int r = 0; r < coast.rings; r++) CGPathRelease(paths[r]);
    free(paths);
    return YES;
}

static void DrawCoastline(CGContextRef ctx, OwnView view, OwnCoast coast) {
    if (gClassicWorld && DrawWorldCoastline(ctx, view, coast)) return;
    CGMutablePathRef path = CGPathCreateMutable();
    if (!path) return;
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        BOOL moved = NO;
        BOOL seam = NO;
        for (int i = 0; i < n; i++) {
            double x, y;
            if (!OwnViewProject(view, coast.lat[start + i], coast.lon[start + i], &x, &y)) { moved = NO; continue; }
            if (gClassicWorld && i > 0 && fabs(coast.lon[start + i] - coast.lon[start + i - 1]) > 180) {
                moved = NO; seam = YES;
            }
            double yUp = kMapH - y;
            if (!moved) { CGPathMoveToPoint(path, NULL, x, yUp); moved = YES; }
            else CGPathAddLineToPoint(path, NULL, x, yUp);
        }
        if (moved && (!gClassicWorld || !seam)) CGPathCloseSubpath(path);
    }
    CGContextSetLineJoin(ctx, kCGLineJoinRound);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetRGBStrokeColor(ctx, 0.98, 0.97, 0.93, 1);
    CGContextSetLineWidth(ctx, 3.2);
    CGContextAddPath(ctx, path);
    CGContextStrokePath(ctx);
    CGContextSetRGBStrokeColor(ctx, 0.07, 0.06, 0.05, 0.85);
    CGContextSetLineWidth(ctx, 1.2);
    CGContextAddPath(ctx, path);
    CGContextStrokePath(ctx);
    CGPathRelease(path);
}

// The panel window does not change between frames, so the halo and core are
// drawn once per thread/view/scale and blitted on subsequent weather frames.
static CGImageRef CachedCoastImage(CGContextRef dest, OwnView view, OwnCoast coast) {
    static _Thread_local CGImageRef image;
    static _Thread_local const double *keyLat;
    static _Thread_local int keyRings;
    static _Thread_local double keyScale, keyWest, keyEast, keySouth, keyNorth;
    if (coast.rings < 1 || !coast.lat) return NULL;
    CGAffineTransform ctm = CGContextGetCTM(dest);
    double scale = fabs(ctm.a) > 0.01 ? fabs(ctm.a) : 1;
    if (image && keyLat == coast.lat && keyRings == coast.rings && fabs(keyScale - scale) < 0.01
        && keyWest == view.west && keyEast == view.east && keySouth == view.south && keyNorth == view.north)
        return image;
    CGImageRelease(image);
    image = NULL;
    int w = (int)llround(kPanelW * scale);
    int h = (int)llround(kMapH * scale);
    if (w < 1 || h < 1) return NULL;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, (size_t)w, (size_t)h, 8, (size_t)w * 4, cs,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(cs);
    if (!ctx) return NULL;
    CGContextSetAllowsAntialiasing(ctx, true);
    CGContextSetShouldAntialias(ctx, true);
    CGContextScaleCTM(ctx, scale, scale);
    DrawCoastline(ctx, view, coast);
    image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    keyLat = coast.lat;
    keyRings = coast.rings;
    keyScale = scale;
    keyWest = view.west;
    keyEast = view.east;
    keySouth = view.south;
    keyNorth = view.north;
    return image;
}

static CGImageRef TemperatureImage(const double *field, OwnView view, int mapW, int mapH, double opacity,
    const uint8_t *land) {
    size_t bytes = (size_t)mapW * (size_t)mapH * 4;
    uint8_t *buffer = calloc(1, bytes);
    if (!buffer) return NULL;
    const OwnVec *locations = PixelLocations(view, mapW, mapH);
    const uint8_t *ocean = PixelOcean(view, mapW, mapH, land);
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
            if (ocean ? ocean[(size_t)y * (size_t)mapW + (size_t)x] : MaskOcean(land, lon, lat))
                rgb = OwnOceanWash(rgb);
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

static CGImageRef OverlayWashImage(const double *field, OwnView view, int mapW, int mapH,
    BOOL rain, double opacity, const uint8_t *land) {
    size_t bytes = (size_t)mapW * (size_t)mapH * 4;
    uint8_t *buffer = calloc(1, bytes);
    if (!buffer) return NULL;
    const OwnVec *locations = PixelLocations(view, mapW, mapH);
    const uint8_t *ocean = PixelOcean(view, mapW, mapH, land);
    for (int y = 0; y < mapH; y++) for (int x = 0; x < mapW; x++) {
        OwnVec point = locations ? locations[(size_t)y * mapW + x] : (OwnVec){NAN, NAN};
        double lat = point.y, lon = point.x;
        if (!locations && !PixelUnproject(view, x + .5, y + .5, &lat, &lon)) continue;
        if (!isfinite(lat)) continue;
        double value = SampleBilinear(field, GNLon(), GNLat(), lon, lat);
        // Zero rainfall is dry and missing cells are unavailable: both remain
        // fully transparent so the sea/land plate is not dyed by guesses.
        if (!isfinite(value) || (rain && value < 0.1)) continue;
        OwnRGB rgb = rain ? OwnRainRGB(value) : OwnWindRGB(value);
        if (ocean ? ocean[(size_t)y * mapW + x] : MaskOcean(land, lon, lat)) rgb = OwnOceanWash(rgb);
        double alpha = fmin(opacity, OwnFieldOverlayAlpha(rain ? 3 : 2, value));
        uint8_t *px = buffer + ((size_t)y * mapW + x) * 4;
        px[0] = (uint8_t)lrint(rgb.r * 255); px[1] = (uint8_t)lrint(rgb.g * 255);
        px[2] = (uint8_t)lrint(rgb.b * 255); px[3] = (uint8_t)lrint(alpha * 255);
    }
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, buffer, bytes, ReleaseImageBuffer);
    CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image = CGImageCreate(mapW, mapH, 8, 32, mapW * 4, colors,
        kCGImageAlphaLast | kCGBitmapByteOrderDefault, provider, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(colors); CGDataProviderRelease(provider);
    return image;
}

static _Thread_local double *gRainSmooth;
static _Thread_local size_t gRainSmoothN;
static _Thread_local double gRainSmoothHour = -1;
static _Thread_local const void *gRainSmoothCube;
static _Thread_local uint64_t gRainSmoothStamp;

// The cube pointer is recycled when a run is released, so identity is not a
// content key. A sample hash keeps one hour's smooth without reusing another's.
static uint64_t RainFieldStamp(const double *field, size_t n) {
    uint64_t hash = 1469598103934665603ULL;
    size_t step = n > 128 ? n / 128 : 1;
    for (size_t i = 0; i < n; i += step) {
        uint64_t bits = 0;
        memcpy(&bits, field + i, sizeof bits);
        hash ^= bits;
        hash *= 1099511628211ULL;
    }
    return hash ^ n;
}

static const double *SmoothedRainDisplay(const void *cube, double hour, const double *field) {
    int nLon = GNLon(), nLat = GNLat();
    size_t n = (size_t)nLon * (size_t)nLat;
    if (!field || n < 1) return field;
    uint64_t stamp = RainFieldStamp(field, n);
    if (gRainSmooth && gRainSmoothCube == cube && gRainSmoothN == n &&
        gRainSmoothStamp == stamp && fabs(gRainSmoothHour - hour) < 1e-6)
        return gRainSmooth;
    double *next = malloc(n * sizeof(double));
    if (!next) return field;
    memcpy(next, field, n * sizeof(double));
    OwnGaussianSmooth(next, nLon, nLat, 0.75);
    free(gRainSmooth);
    gRainSmooth = next;
    gRainSmoothN = n;
    gRainSmoothHour = hour;
    gRainSmoothCube = cube;
    gRainSmoothStamp = stamp;
    return gRainSmooth;
}

static void DrawWash(CGContextRef ctx, const double *field, OwnView view, double mapW, double mapH,
    BOOL rain, double opacity, const uint8_t *land) {
    CGImageRef image = OverlayWashImage(field, view, (int)mapW, (int)mapH, rain, opacity, land);
    if (image) { CGContextDrawImage(ctx, CGRectMake(0, 0, mapW, mapH), image); CGImageRelease(image); }
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
    const double t0 = 0, t1 = 40;
    int barW = (int)width - 16;
    double barY = y + (rain || observed ? 28 : 16);
    for (int i = 0; i < barW; i++) {
        double t = t0 + (t1 - t0) * i / (barW - 1);
        OwnRGB rgb = OwnTemperatureRGB(t);
        CGContextSetRGBFillColor(ctx, rgb.r, rgb.g, rgb.b, 1);
        CGContextFillRect(ctx, CGRectMake(x + 8 + i, barY, 1, 10));
    }
    NSFont *tickFont = [NSFont fontWithName:@"Helvetica" size:9] ?: [NSFont systemFontOfSize:9];
    NSArray *ticks = @[@"0", @"20", @"35"];
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
    int windFill;
    int rain;
    int smoothRain;
    int observed; // Now frame only: station dots, and no model hatch
    int bare;     // map only, for the popover headings
    int plateOnly;
    int inkOnly;
    int quiet;
    const char *legend;
    const StationRain *stations;
    int nStations;
    OwnMotionState *motionState;
} PanelOptions;

typedef struct {
    BOOL active;
    double level, x, y, angle, alpha;
    int age, missing, line;
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
    CGFloat _maxAlphaStep;
    NSInteger _labelSetChanges;
    OwnExtremum _cachedExtrema[48];
    double _cachedProminence[48];
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
- (CGFloat)maxAnnotationAlphaStep { return _maxAlphaStep; }
- (NSInteger)labelSetChanges { return _labelSetChanges; }
- (NSInteger)copyLabelPoints:(CGPoint *)points max:(NSInteger)max {
    NSInteger count = 0;
    if (!points || max < 1) return 0;
    for (int s = 0; s < 128 && count < max; s++) {
        if (!_motionLabels[s].active || _motionLabels[s].alpha < 0.4) continue;
        points[count++] = CGPointMake(_motionLabels[s].x, _motionLabels[s].y);
    }
    return count;
}
- (NSInteger)copyCentrePoints:(CGPoint *)points max:(NSInteger)max {
    NSInteger count = 0;
    if (!points || max < 1) return 0;
    for (int s = 0; s < 24 && count < max; s++) {
        if (!_motionCentres[s].active || _motionCentres[s].alpha <= 0.4) continue;
        points[count++] = CGPointMake(_motionCentres[s].x, _motionCentres[s].y);
    }
    return count;
}
@end

static const double kMotionFade = 1.0 / 30.0;
static const double kFragmentLength = 96;
static const double kFragmentEdgeLength = 48;
static const double kFragmentEdge = 2;

static double MotionFadeStep(OwnMotionState *state) {
    if (!state) return 1;
    if (state.immediateAnnotations || state->_motionFrame <= 1) return 1;
    return kMotionFade;
}

static void MotionNoteAlpha(OwnMotionState *state, double before, double after) {
    if (!state || state->_motionFrame <= 1) return;
    double jump = fabs(after - before);
    if (jump > state->_maxAlphaStep) state->_maxAlphaStep = (CGFloat)jump;
}

static BOOL MotionFragment(const OwnLine *line) {
    return OwnIsOpenFragment(line, kFragmentLength, kFragmentEdgeLength, 0, 0, kPanelW, kMapH, kFragmentEdge);
}

static BOOL LineCanHoldLabel(const OwnLine *line) {
    if (!line || !line->pts || line->count < 2) return NO;
    if (MotionFragment(line)) return NO;
    if (line->closed) {
        double loX = INFINITY, hiX = -INFINITY, loY = INFINITY, hiY = -INFINITY;
        for (int p = 0; p < line->count; p++) {
            OwnVec q = line->pts[p];
            if (q.x < loX) loX = q.x;
            if (q.x > hiX) hiX = q.x;
            if (q.y < loY) loY = q.y;
            if (q.y > hiY) hiY = q.y;
        }
        if (fmax(hiX - loX, hiY - loY) < 28) return NO;
    }
    return PolyLength(line) >= 72;
}

static const double kStickyCentre = 10;
// Chart points a label or centre may walk in one frame. Under the jank
// tracker's 4 px "still" threshold, and above one 256× forecast step.
static const double kLabelGlide = 3;

static int MotionUpdateCentres(OwnMotionState *state, const OwnExtremum *candidates, int nCandidates,
    OwnVec *visible, double *visibleAlpha, int cap) {
    if (!state) return 0;
    BOOL used[48] = {0};
    for (int s = 0; s < 24; s++) {
        MotionCentreSlot *slot = &state->_motionCentres[s];
        if (!slot->active) continue;
        int best = -1; double bestDistance = 120.0;
        for (int c = 0; c < nCandidates && c < 48; c++) {
            if (used[c] || candidates[c].high != slot->high) continue;
            double d = hypot(candidates[c].x - slot->x, candidates[c].y - slot->y);
            if (d < bestDistance) { bestDistance = d; best = c; }
        }
        // A marker and its value stay still while the centre is within
        // kStickyCentre points. Farther, but still the same centre, it
        // glides. Only a centre that has left the search fades out here.
        if (best >= 0 && bestDistance > kStickyCentre) {
            // Close only the gap past the hold, so an 8× frame that has
            // barely left it creeps, and a 256× frame cannot jump the rest.
            double excess = bestDistance - kStickyCentre;
            double travel = excess > kLabelGlide ? kLabelGlide : excess;
            double t = travel / bestDistance;
            slot->x += (candidates[best].x - slot->x) * t;
            slot->y += (candidates[best].y - slot->y) * t;
        }
        if (best >= 0) {
            // The value is the centre's pressure now, held or gliding, so a
            // filling low reads true and the digit never changes with a move.
            slot->value = candidates[best].value;
            used[best] = YES;
            slot->missing = 0; slot->age++;
            double before = slot->alpha;
            double step = MotionFadeStep(state);
            slot->alpha = MIN(1, slot->alpha + step);
            MotionNoteAlpha(state, before, slot->alpha);
        } else {
            double before = slot->alpha;
            double step = MotionFadeStep(state);
            slot->alpha = MAX(0, slot->alpha - step);
            MotionNoteAlpha(state, before, slot->alpha);
            slot->missing++;
            if (slot->alpha <= 0) slot->active = NO;
        }
    }
    for (int c = 0; c < nCandidates && c < 48; c++) {
        if (used[c]) continue;
        BOOL nearExisting = NO;
        for (int s = 0; s < 24; s++) {
            MotionCentreSlot *slot = &state->_motionCentres[s];
            // A marker that is still fading out holds its neighbourhood: the
            // new one appears only after the old has gone, never beside it.
            if (slot->active && slot->high == candidates[c].high &&
                hypot(slot->x - candidates[c].x, slot->y - candidates[c].y) < 160) { nearExisting = YES; break; }
        }
        if (nearExisting) continue;
        int active = 0;
        for (int s = 0; s < 24; s++) if (state->_motionCentres[s].active) active++;
        if (active >= 8) break;
        double step = MotionFadeStep(state);
        for (int s = 0; s < 24; s++) if (!state->_motionCentres[s].active) {
            state->_motionCentres[s] = (MotionCentreSlot){YES, candidates[c].high, candidates[c].value,
                candidates[c].x, candidates[c].y, MIN(1, step), 1, 0};
            MotionNoteAlpha(state, 0, MIN(1, step));
            break;
        }
    }
    int count = 0;
    for (int s = 0; s < 24 && count < cap; s++) {
        MotionCentreSlot *slot = &state->_motionCentres[s];
        if (slot->active && slot->alpha >= 0.02) {
            visible[count] = (OwnVec){slot->x, slot->y};
            visibleAlpha[count++] = slot->alpha;
        }
    }
    return count;
}

static BOOL NearMotionCentre(double x, double y, double halfW, const OwnVec *centres, int nCentres) {
    double gap = 6.0 * halfW;
    if (!(gap > 0)) return NO;
    for (int c = 0; c < nCentres; c++)
        if (hypot(x - centres[c].x, y - centres[c].y) < gap) return YES;
    return NO;
}

// A label stays still while its isobar passes within kStickyLabel points.
// Past that, but still on the same line, it glides at most kLabelGlide points
// a frame. Replanting at the layout site jumps the digits (tens of points at
// 256×) while the stroke stays smooth. A line that has actually left fades
// out where it is and a new label fades in. It also retires when the contour
// leaves the map, shrinks below the label length, or a collision or an H/L
// marker forces it off. One label per isobar. The stroke gap is the label
// box, not a plate erase.
static const double kStickyLabel = 8;
static int MotionEaseLabels(OwnMotionState *state, const OwnLabel *desired, int nDesired,
    const OwnLine *lines, int nLines, const OwnVec *centres, int nCentres, NSFont *font,
    OwnLabel *out, double *outAlpha, int cap) {
    if (!state || !lines || !out || !outAlpha || cap <= 0 || !font) return 0;
    if (nDesired < 0 || !desired) nDesired = 0;
    if (nCentres < 0 || !centres) nCentres = 0;
    double step = MotionFadeStep(state);
    double halfH = LabelHalfHeight(font);
    int attached[128];
    char hold[128];
    for (int s = 0; s < 128; s++) { attached[s] = -1; hold[s] = 0; }

    typedef struct { double level, x, y; } Mark;
    Mark before[128];
    int nBefore = 0;
    if (state->_motionFrame > 1) {
        for (int s = 0; s < 128; s++) {
            MotionLabelSlot *slot = &state->_motionLabels[s];
            if (!slot->active || slot->alpha < 0.5 || nBefore >= 128) continue;
            before[nBefore++] = (Mark){slot->level, slot->x, slot->y};
        }
    }

    for (int s = 0; s < 128; s++) {
        MotionLabelSlot *slot = &state->_motionLabels[s];
        if (!slot->active) continue;
        int best = -1;
        double bestD = 24;
        double ax = slot->x, ay = slot->y;
        for (int i = 0; i < nLines; i++) {
            if (fabs(lines[i].level - slot->level) > 0.1) continue;
            if (!LineCanHoldLabel(&lines[i])) continue;
            double px, py, arc, tangent, dist = 1e9;
            if (!OwnContourAnchor(slot->x, slot->y, &lines[i], 24, 0,
                    0, 0, kPanelW, kMapH, &px, &py, &arc, &tangent, &dist)) continue;
            if (dist < bestD) { bestD = dist; best = i; ax = px; ay = py; }
        }
        // The foot is on this isobar. Glide toward it instead of retiring the
        // label and letting the next layout site appear somewhere else.
        if (best >= 0 && bestD > kStickyLabel) {
            double excess = bestD - kStickyLabel;
            double travel = excess > kLabelGlide ? kLabelGlide : excess;
            double t = bestD > 0 ? travel / bestD : 0;
            slot->x += (ax - slot->x) * t;
            slot->y += (ay - slot->y) * t;
        }
        if (best >= 0) {
            slot->missing = 0;
            slot->age++;
            slot->line = best;
            attached[s] = best;
            double half = LabelHalf(slot->level, (__bridge void *)font);
            hold[s] = NearMotionCentre(slot->x, slot->y, half, centres, nCentres) ? 0 : 1;
        }
    }

    for (int c = 0; c < nDesired && c < 80; c++) {
        int lineNo = desired[c].line;
        if (lineNo < 0 || lineNo >= nLines || !LineCanHoldLabel(&lines[lineNo])) continue;
        double half = desired[c].halfW > 0 ? desired[c].halfW : LabelHalf(desired[c].level, (__bridge void *)font);
        BOOL taken = NO;
        int onLine = 0;
        for (int s = 0; s < 128; s++) {
            MotionLabelSlot *slot = &state->_motionLabels[s];
            if (!slot->active) continue;
            // A retiring label still fading out also blocks its neighbourhood,
            // so a replacement never appears beside it as a sliding number.
            if (hold[s] && attached[s] == lineNo) onLine++;
            if (fabs(slot->level - desired[c].level) > 0.1) continue;
            double apart = 6.0 * fmax(half, LabelHalf(slot->level, (__bridge void *)font));
            if (hypot(slot->x - desired[c].x, slot->y - desired[c].y) < apart) taken = YES;
        }
        if (onLine >= 1) taken = YES;
        if (NearMotionCentre(desired[c].x, desired[c].y, half, centres, nCentres)) taken = YES;
        if (taken) continue;
        for (int s = 0; s < 128; s++) {
            if (state->_motionLabels[s].active) continue;
            state->_motionLabels[s] = (MotionLabelSlot){YES, desired[c].level,
                desired[c].x, desired[c].y, 0, 0, 1, 0, lineNo};
            attached[s] = lineNo;
            hold[s] = 1;
            break;
        }
    }

    for (int a = 0; a < 128; a++) {
        if (!hold[a]) continue;
        MotionLabelSlot *sa = &state->_motionLabels[a];
        double halfA = LabelHalf(sa->level, (__bridge void *)font);
        OwnLabel la = {sa->x, sa->y, 0, halfA, halfH, 0, halfA + 2.5, sa->level, attached[a]};
        for (int b = a + 1; b < 128; b++) {
            if (!hold[b]) continue;
            MotionLabelSlot *sb = &state->_motionLabels[b];
            double halfB = LabelHalf(sb->level, (__bridge void *)font);
            OwnLabel lb = {sb->x, sb->y, 0, halfB, halfH, 0, halfB + 2.5, sb->level, attached[b]};
            double apart = 6.0 * fmax(halfA, halfB);
            BOOL crowd = hypot(sa->x - sb->x, sa->y - sb->y) < apart || OwnLabelsOverlap(la, lb, 4);
            if (!crowd) continue;
            int drop = sa->age >= sb->age ? b : a;
            BOOL ringA = attached[a] >= 0 && attached[a] < nLines && lines[attached[a]].closed;
            BOOL ringB = attached[b] >= 0 && attached[b] < nLines && lines[attached[b]].closed;
            int onA = 0, onB = 0;
            for (int t = 0; t < 128; t++) {
                if (!hold[t]) continue;
                if (attached[t] == attached[a]) onA++;
                if (attached[t] == attached[b]) onB++;
            }
            if (ringA && onA == 1 && !(ringB && onB == 1)) drop = b;
            else if (ringB && onB == 1 && !(ringA && onA == 1)) drop = a;
            hold[drop] = 0;
            if (drop == a) break;
        }
    }

    for (int s = 0; s < 128; s++) {
        MotionLabelSlot *slot = &state->_motionLabels[s];
        if (!slot->active) continue;
        double beforeAlpha = slot->alpha;
        double target = hold[s] ? 1 : 0;
        if (slot->alpha < target) slot->alpha = MIN(target, slot->alpha + step);
        else slot->alpha = MAX(target, slot->alpha - step);
        MotionNoteAlpha(state, beforeAlpha, slot->alpha);
        if (slot->alpha <= 0 && target <= 0) slot->active = NO;
    }

    if (state->_motionFrame > 1) {
        Mark after[128];
        int nAfter = 0;
        for (int s = 0; s < 128; s++) {
            MotionLabelSlot *slot = &state->_motionLabels[s];
            if (!slot->active || slot->alpha < 0.5 || nAfter >= 128) continue;
            after[nAfter++] = (Mark){slot->level, slot->x, slot->y};
        }
        char usedB[128] = {0}, usedA[128] = {0};
        for (int a = 0; a < nAfter; a++) {
            int best = -1;
            double bestD = 24;
            for (int b = 0; b < nBefore; b++) {
                if (usedB[b] || fabs(before[b].level - after[a].level) > 0.1) continue;
                double d = hypot(before[b].x - after[a].x, before[b].y - after[a].y);
                if (d < bestD) { bestD = d; best = b; }
            }
            if (best >= 0) { usedB[best] = 1; usedA[a] = 1; }
        }
        int missed = 0;
        for (int a = 0; a < nAfter; a++) if (!usedA[a]) missed++;
        for (int b = 0; b < nBefore; b++) if (!usedB[b]) missed++;
        if (missed) state->_labelSetChanges++;
    }

    int n = 0;
    for (int s = 0; s < 128 && n < cap; s++) {
        MotionLabelSlot *slot = &state->_motionLabels[s];
        if (!slot->active || slot->alpha < 0.02) continue;
        double half = LabelHalf(slot->level, (__bridge void *)font);
        // Contour arrays are rebuilt each frame. A retired label must never
        // cut a gap in whichever unrelated line inherited its old index.
        int line = attached[s];
        out[n] = (OwnLabel){slot->x, slot->y, 0, half, halfH, 0, half + 2.5, slot->level, line};
        outAlpha[n] = slot->alpha;
        n++;
    }
    return n;
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

// Local extrema of the smoothed field, with ring prominence (centre minus
// the mean about 400 km out). Settlement — prominence, enclosure, merge,
// hysteresis — is OwnSettleCentres.
static int SynopticCandidates(const double *field, int nLon, int nLat,
    const uint8_t *land, const uint8_t *rough,
    OwnExtremum *out, double *prominence, int cap) {
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
            if (lon < ViewWest() || lon > ViewEast() || lat < ViewSouth() || lat > ViewNorth()) continue;
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
            if (localLow && z >= quickMean - 0.8 + 1e-8) localLow = NO;
            if (localHigh && z <= quickMean + 0.8 - 1e-8) localHigh = NO;
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
    free(rowSums);
    free(rowCounts);
    for (int a = 0; a < n; a++) {
        cands[a].score = OwnRingProminence(field, nLon, nLat, GWest(), GNorth(), step, -step,
            cands[a].lon, cands[a].lat, 4.0);
        BOOL rightSign = cands[a].high ? cands[a].score > 0.3 : cands[a].score < -0.3;
        if (!rightSign) cands[a].score = 0;
        // A spike over high terrain is not a centre. A deep synoptic centre
        // can still sit on land.
        if (cands[a].score != 0 && MaskNear(rough, nLon, nLat, cands[a].lon, cands[a].lat, 2)
            && fabs(cands[a].score) < 4.0)
            cands[a].score = 0;
    }
    (void)land;
    for (int a = 1; a < n; a++) {
        Cand key = cands[a];
        int b = a;
        while (b > 0 && fabs(cands[b - 1].score) < fabs(key.score)) {
            cands[b] = cands[b - 1];
            b--;
        }
        cands[b] = key;
    }
    int written = 0;
    for (int a = 0; a < n && written < cap; a++) {
        if (cands[a].score == 0) continue;
        double ox = 0, oy = 0;
        int i = (int)llround((cands[a].lon - GWest()) / step);
        int j = (int)llround((GNorth() - cands[a].lat) / step);
        if (i > 0 && i < nLon - 1 && j > 0 && j < nLat - 1) {
            double zm = field[j * nLon + (i - 1)];
            double zp = field[j * nLon + (i + 1)];
            double denom = zm - 2.0 * cands[a].value + zp;
            if (isfinite(denom) && fabs(denom) > 1e-6) {
                ox = 0.5 * (zm - zp) / denom;
                if (ox > 0.75) ox = 0.75;
                if (ox < -0.75) ox = -0.75;
            }
            zm = field[(j - 1) * nLon + i];
            zp = field[(j + 1) * nLon + i];
            denom = zm - 2.0 * cands[a].value + zp;
            if (isfinite(denom) && fabs(denom) > 1e-6) {
                oy = 0.5 * (zm - zp) / denom;
                if (oy > 0.75) oy = 0.75;
                if (oy < -0.75) oy = -0.75;
            }
        }
        double lon = GWest() + (i + ox) * step;
        double lat = GNorth() - (j + oy) * step;
        double score = OwnRingProminence(field, nLon, nLat, GWest(), GNorth(), step, -step, lon, lat, 4.0);
        if (cands[a].high ? score < 0.3 : score > -0.3) continue;
        out[written] = (OwnExtremum){lon, lat, cands[a].value, cands[a].high};
        if (prominence) prominence[written] = score;
        written++;
    }
    free(cands);
    return written;
}

static void RenderPanel(CGContextRef ctx, double originX, double originY, const Cube *cube, double hour,
    NSString *title, OwnCoast coast, const uint8_t *landMask, const RingSpan *spans, PanelOptions options) {
    AdoptCubeGrid(cube);
    ProfileReset();
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, originX, originY);
    NSGraphicsContext *graphics = [NSGraphicsContext graphicsContextWithCGContext:ctx flipped:NO];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:graphics];

    OwnRGB seaRGB = OwnChartSea(), landRGB = OwnChartLand(), inkRGB = OwnChartInk(), titleRGB = OwnChartTitle();
    MSLPColour sea = {seaRGB.r, seaRGB.g, seaRGB.b};
    MSLPColour land = {landRGB.r, landRGB.g, landRGB.b};
    MSLPColour ink = {inkRGB.r, inkRGB.g, inkRGB.b};
    MSLPColour titleColour = {titleRGB.r, titleRGB.g, titleRGB.b};
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
    OwnView view = gClassicWorld ? OwnWorldViewMake(ViewWest(), ViewEast(), ViewSouth(), ViewNorth(),
        0, 0, kPanelW, kMapH) : OwnViewMake(OwnAustraliaLambert(), ViewWest(), ViewEast(), ViewSouth(), ViewNorth(),
        0, 0, kPanelW, kMapH);
    if (!options.inkOnly) {
    CGContextSetRGBFillColor(ctx, sea.red, sea.green, sea.blue, 1);
    CGContextFillRect(ctx, CGRectMake(0, 0, kPanelW, kMapH));

    CGContextBeginPath(ctx);
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        BOOL moved = NO;
        BOOL seam = NO;
        for (int i = 0; i < n; i++) {
            double x, y;
            if (!OwnViewProject(view, coast.lat[start + i], coast.lon[start + i], &x, &y)) { moved = NO; continue; }
            if (gClassicWorld && i > 0 && fabs(coast.lon[start + i] - coast.lon[start + i - 1]) > 180) { moved = NO; seam = YES; }
            double yUp = kMapH - y;
            if (!moved) { CGContextMoveToPoint(ctx, x, yUp); moved = YES; }
            else CGContextAddLineToPoint(ctx, x, yUp);
        }
        if (!gClassicWorld || !seam) CGContextClosePath(ctx);
    }
    CGContextSetRGBFillColor(ctx, land.red, land.green, land.blue, 1);
    CGContextEOFillPath(ctx);
    }
    gRenderProfile.plateMs += ProfileLap();

    uint8_t *rough = NULL;
    // Smoothing is cached per model hour. A fractional frame lerps the two
    // smoothed hours, which matches smoothing the interpolated field.
    double *mslp = options.plateOnly ? NULL : SmoothedMSLP((Cube *)cube, hour, landMask, &rough);
    ProfileLap();
    double *temp = NULL;
    if (!options.inkOnly && options.temperature == 1) temp = ScalarField(cube, VarT850, hour);
    else if (!options.inkOnly && options.temperature == 2) temp = ScalarField(cube, VarT2M, hour);
    if (temp) {
        CGImageRef shade = TemperatureImage(temp, view, kPanelW, kMapH, 1.0, landMask);
        if (shade) {
            CGContextDrawImage(ctx, CGRectMake(0, 0, kPanelW, kMapH), shade);
            CGImageRelease(shade);
        }
    }

    gRenderProfile.plateMs += ProfileLap();

    OwnVec avoidPts[160];
    int nAvoid = 0;
    if (!options.inkOnly && options.rain && !options.observed) {
        double *rain = RainField(cube, hour);
        if (rain) {
            if (options.smoothRain) DrawWash(ctx, SmoothedRainDisplay(cube, hour, rain), view, kPanelW, kMapH, YES, .56, landMask);
            else DrawHatch(ctx, rain, view, kPanelW, kMapH, kRainMm, options.motionState != nil);
        }
        free(rain);
    }

    if (!options.inkOnly && options.windFill) {
        double *wind = ScalarField(cube, VarWSpd, hour);
        if (wind) DrawWash(ctx, wind, view, kPanelW, kMapH, NO, .45, landMask);
        free(wind);
    }

    if (!options.inkOnly) {
        CGImageRef coastImage = CachedCoastImage(ctx, view, coast);
        if (coastImage) CGContextDrawImage(ctx, CGRectMake(0, 0, kPanelW, kMapH), coastImage);
        else DrawCoastline(ctx, view, coast);
    }

    OwnVec centers[48];
    double centerAlpha[48];
    for (int i = 0; i < 48; i++) centerAlpha[i] = 1;
    int nCenters = 0;
    OwnExtremum extrema[48];
    OwnExtremum motionExtrema[48];
    OwnExtremum candidates[48];
    double candProm[48];
    int nCand = 0;
    int nExt = 0;
    if (mslp) {
        OwnMotionState *state = options.motionState;
        // Candidate scan is the costly part. Nearby frames share it; which
        // of those candidates are marked still depends on the previous frame.
        if (state && state->_hasCachedExtrema && state->_cachedExtremaCube == cube &&
            state->_cachedExtremaNLon == cube->nLon && state->_cachedExtremaNLat == cube->nLat &&
            fabs(hour - state->_cachedExtremaHour) < 0.5) {
            nCand = state->_cachedExtremaCount;
            memcpy(candidates, state->_cachedExtrema, (size_t)nCand * sizeof(OwnExtremum));
            memcpy(candProm, state->_cachedProminence, (size_t)nCand * sizeof(double));
        } else {
            nCand = SynopticCandidates(mslp, cube->nLon, cube->nLat, landMask,
                rough, candidates, candProm, 48);
            if (state) {
                state->_cachedExtremaCount = nCand;
                memcpy(state->_cachedExtrema, candidates, (size_t)nCand * sizeof(OwnExtremum));
                memcpy(state->_cachedProminence, candProm, (size_t)nCand * sizeof(double));
                state->_cachedExtremaHour = hour;
                state->_cachedExtremaCube = cube;
                state->_cachedExtremaNLon = cube->nLon;
                state->_cachedExtremaNLat = cube->nLat;
                state->_hasCachedExtrema = YES;
            }
        }
        gRenderProfile.centreMs += ProfileLap();
    }

    // Temperature uses colour alone; linework is reserved for pressure.

    if (mslp) {
        int winW = 0, winH = 0;
        double originX = GWest(), originY = GNorth();
        double *window = ContourWindow(mslp, cube->nLon, cube->nLat, view, &winW, &winH, &originX, &originY);
        const double *contoured = window ? window : mslp;
        int cLon = window ? winW : cube->nLon;
        int cLat = window ? winH : cube->nLat;
        double lo = 0, hi = 0;
        FieldRange(contoured, cLon * cLat, &lo, &hi);
        double levels[56];
        int nLevels = OwnInteriorLevels(lo, hi, 4, levels, 56);
        OwnLineSet raw = OwnContours(contoured, cLon, cLat, originX, originY,
            GStep(), -GStep(), levels, nLevels);
        free(window);
        OwnPruneContours(&raw, 1.2, 0.45, 0);
        // No vertex simplification: which vertices survive flips between
        // nearby instants, and playback would show the polygon kinking.
        gRenderProfile.contourMs += ProfileLap();
        int enclosed[48] = {0};
        if (nCand > 48) nCand = 48;
        OwnMarkEnclosedCentres(candidates, nCand, raw.lines, raw.count, 6.0,
            ViewWest(), ViewSouth(), ViewEast(), ViewNorth(), enclosed);
        // The two southern highs on the plate sit about 110 px apart at 2×,
        // 730–800 km. Same-type centres inside 860 km collapse. Marker
        // hysteresis lives in the glyph tracker; the rings match a still.
        nExt = OwnSettleCentres(candidates, candProm, enclosed, nCand,
            kOwnIsobarInterval, 0.5, 860.0, 500.0, 1, NULL, 0, extrema, 8);
        // A real pressure ring does not depend on whether an H/L was selected
        // for display. Candidate scans are cached and marker selection has
        // thresholds; using it to delete contours made whole loops pop.
        {
            int drawn = 0;
            for (int e = 0; e < nExt; e++) {
                double sampled = SampleBilinear(mslp, cube->nLon, cube->nLat, extrema[e].x, extrema[e].y);
                if (isfinite(sampled)) extrema[e].value = sampled;
                double x, y;
                if (!OwnViewProject(view, extrema[e].y, extrema[e].x, &x, &y)) continue;
                double yUp = kMapH - y;
                if (x < 18 || x > kPanelW - 18 || yUp < 18 || yUp > kMapH - 18) continue;
                extrema[drawn] = extrema[e];
                centers[drawn] = (OwnVec){x, yUp};
                motionExtrema[drawn] = extrema[e];
                motionExtrema[drawn].x = x;
                motionExtrema[drawn].y = yUp;
                drawn++;
            }
            nExt = drawn;
            nCenters = drawn;
            if (options.motionState) {
                nCenters = MotionUpdateCentres(options.motionState, motionExtrema, nExt, centers, centerAlpha, 48);
            }
            if (options.quiet) nCenters = 0;
        }
        gRenderProfile.centreMs += ProfileLap();
        OwnLineSet lines = ProjectContours(raw, view, kMapH);
        double projected = ProfileLap();
        gRenderProfile.chaikinMs += gChaikinMs;
        if (projected > gChaikinMs) gRenderProfile.contourMs += projected - gChaikinMs;
        gChaikinMs = 0;
        OwnLineSetFree(raw);
        OwnPruneContours(&lines, 16, 4, 0);
        NoteOpenEnds(&lines, view, mslp, cube->nLon, cube->nLat, GWest(), GNorth());

        NSFont *labelFont = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
        double labelHalfH = LabelHalfHeight(labelFont);
        OwnLabel labels[80];
        int nLabels = OwnPlaceLabels(lines.lines, lines.count, LabelHalf, (__bridge void *)labelFont, labelHalfH, 6,
            0, 0, kPanelW, kMapH, labels, 80);
        nLabels = ThinLabels(labels, nLabels, lines.lines, view, kMapH, coast, spans,
            centers, nCenters, 6.0, 46, 48);
        nLabels = OwnCoverLabels(lines.lines, lines.count, LabelHalf, (__bridge void *)labelFont, labelHalfH, 6,
            0, 0, kPanelW, kMapH, 72, 260, labels, nLabels, 80);
        nLabels = OwnClearCentreLabels(labels, nLabels, lines.lines, lines.count, centers, nCenters,
            0, 0, kPanelW, kMapH);
        nLabels = OwnCoverClosedRings(lines.lines, lines.count, LabelHalf, (__bridge void *)labelFont,
            labelHalfH, 0, 0, kPanelW, kMapH, 28, centers, nCenters, labels, nLabels, 80);
        OwnLabel drawn[80];
        double drawnAlpha[80];
        int nDrawn = 0;
        if (options.motionState) {
            OwnVec clear[72];
            int nClear = 0;
            for (int c = 0; c < nCenters && nClear < 48; c++) clear[nClear++] = centers[c];
            for (int s = 0; s < 24 && nClear < 72; s++) {
                MotionCentreSlot *slot = &options.motionState->_motionCentres[s];
                if (!slot->active || slot->alpha < 0.15) continue;
                clear[nClear++] = (OwnVec){slot->x, slot->y};
            }
            nDrawn = MotionEaseLabels(options.motionState, labels, nLabels, lines.lines, lines.count,
                clear, nClear, labelFont, drawn, drawnAlpha, 80);
        } else {
            for (int L = 0; L < nLabels && nDrawn < 80; L++) {
                drawn[nDrawn] = labels[L];
                drawn[nDrawn].angle = 0;
                drawnAlpha[nDrawn] = 1;
                nDrawn++;
            }
            nDrawn = OwnKeepSeparated(drawn, nDrawn, 4);
        }
        // Quiet frames keep the label memory up to date but draw no numbers.
        if (options.quiet) nDrawn = 0;
        nLabels = nDrawn;
        for (int L = 0; L < nDrawn && nAvoid < 160; L++)
            avoidPts[nAvoid++] = (OwnVec){drawn[L].x, drawn[L].y};
        gRenderProfile.labelMs += ProfileLap();

        for (int L = 0; L < nDrawn && gNLabelBoxes < 80; L++) {
            if (drawnAlpha[L] < 0.02) continue;
            double hw = drawn[L].halfW + 2.5, hh = drawn[L].halfH + 2.5;
            gLabelAlpha[gNLabelBoxes] = drawnAlpha[L];
            gLabelBoxes[gNLabelBoxes++] = CGRectMake(drawn[L].x - hw, drawn[L].y - hh, hw * 2, hh * 2);
        }

        NSColor *inkColor = [NSColor colorWithSRGBRed:ink.red green:ink.green blue:ink.blue alpha:1];
        for (int i = 0; i < lines.count; i++) {
            double width = OwnIsobarWidth(lines.lines[i].level);
            double visibility = ContourVisibility(&lines.lines[i]);
            if (visibility <= 0) continue;
            OwnLabel mine[8];
            double mineAlpha[8];
            int mineCount = 0;
            for (int L = 0; L < nDrawn && mineCount < 8; L++) {
                if (drawnAlpha[L] < 0.02 || drawn[L].line != i) continue;
                mineAlpha[mineCount] = drawnAlpha[L];
                mine[mineCount++] = drawn[L];
            }
            if (mineCount == 0) {
                StrokeLine(ctx, lines.lines[i].pts, lines.lines[i].count, lines.lines[i].closed,
                    centers, centerAlpha, nCenters, 11, width, ink.red, ink.green, ink.blue, visibility);
                continue;
            }
            // The gap is the label box: the stroke is cut, the plate stays.
            OwnLineSet parts = OwnCutGaps(lines.lines[i].pts, lines.lines[i].count,
                lines.lines[i].closed, mine, mineCount);
            for (int p = 0; p < parts.count; p++) {
                StrokeLine(ctx, parts.lines[p].pts, parts.lines[p].count, 0,
                    centers, centerAlpha, nCenters, 11, width, ink.red, ink.green, ink.blue, visibility);
            }
            OwnLineSetFree(parts);
            // A fading label's gap closes with it.
            for (int L = 0; L < mineCount; L++) {
                if (mineAlpha[L] > 0.98) continue;
                double hw = mine[L].halfW + 2.5, hh = mine[L].halfH + 2.5;
                CGContextSaveGState(ctx);
                CGContextClipToRect(ctx, CGRectMake(mine[L].x - hw, mine[L].y - hh, hw * 2, hh * 2));
                StrokeLine(ctx, lines.lines[i].pts, lines.lines[i].count, lines.lines[i].closed,
                    centers, centerAlpha, nCenters, 11, width, ink.red, ink.green, ink.blue, visibility * (1 - mineAlpha[L]));
                CGContextRestoreGState(ctx);
            }
        }
        for (int L = 0; L < nDrawn; L++) {
            double glyphAlpha = L < 80 ? drawnAlpha[L] : 1;
            if (drawn[L].line >= 0 && drawn[L].line < lines.count)
                glyphAlpha *= ContourVisibility(&lines.lines[drawn[L].line]);
            if (glyphAlpha < 0.02) continue;
            // The stroke gap is the knockout; the plate shows around the glyphs.
            DrawHaloText(ctx, PressureText((int)llround(drawn[L].level)), labelFont,
                [inkColor colorWithAlphaComponent:glyphAlpha], nil, drawn[L].x, drawn[L].y, 0);
        }
        NSFont *letterFont = [NSFont fontWithName:@"Helvetica-Bold" size:18] ?: [NSFont boldSystemFontOfSize:18];
        NSFont *valueFont = [NSFont fontWithName:@"Helvetica-Bold" size:11] ?: [NSFont boldSystemFontOfSize:11];
        if (options.quiet) {
        } else if (!options.motionState) {
            for (int e = 0; e < nExt; e++) {
                NSColor *halo = HaloColour(view, centers[e].x, centers[e].y, landMask,
                    cube->nLon, cube->nLat, sea, land);
                DrawCentreMark(ctx, centers[e].x, centers[e].y, extrema[e].high, extrema[e].value,
                    letterFont, valueFont, inkColor, halo);
                if (gNCentreBoxes < 24) {
                    gCentreAlpha[gNCentreBoxes] = 1;
                    gCentreBoxes[gNCentreBoxes++] = CentreMarkBox(centers[e].x, centers[e].y);
                }
            }
        } else {
            for (int s = 0; s < 24; s++) {
                MotionCentreSlot *slot = &options.motionState->_motionCentres[s];
                if (!slot->active || slot->alpha < 0.02) continue;
                NSColor *halo = HaloColour(view, slot->x, slot->y, landMask,
                    cube->nLon, cube->nLat, sea, land);
                DrawCentreMark(ctx, slot->x, slot->y, slot->high, slot->value,
                    letterFont, valueFont,
                    [inkColor colorWithAlphaComponent:slot->alpha],
                    [halo colorWithAlphaComponent:slot->alpha]);
                if (gNCentreBoxes < 24) {
                    gCentreAlpha[gNCentreBoxes] = slot->alpha;
                    gCentreBoxes[gNCentreBoxes++] = CentreMarkBox(slot->x, slot->y);
                }
            }
        }
        if (getenv("ISOBAR_CHART_LOG")) {
            int closed = 0, closedLabelled = 0;
            for (int i = 0; i < lines.count; i++) {
                if (!lines.lines[i].closed) continue;
                double loX = INFINITY, hiX = -INFINITY, loY = INFINITY, hiY = -INFINITY;
                for (int p = 0; p < lines.lines[i].count; p++) {
                    OwnVec q = lines.lines[i].pts[p];
                    if (q.x < loX) loX = q.x;
                    if (q.x > hiX) hiX = q.x;
                    if (q.y < loY) loY = q.y;
                    if (q.y > hiY) hiY = q.y;
                }
                if (fmax(hiX - loX, hiY - loY) < 28) continue;
                closed++;
                for (int L = 0; L < nLabels; L++) if (drawn[L].line == i) closedLabelled++;
            }
            fprintf(stderr, "  isobars %d labels %d closed %d closed-labelled %d centres %d candidates %d  pressure %.0f–%.0f\n",
                lines.count, nLabels, closed, closedLabelled, nExt, nCand, lo, hi);
            for (int e = 0; e < nExt; e++) {
                double prom = 0;
                for (int c = 0; c < nCand; c++) {
                    if (candidates[c].high != extrema[e].high) continue;
                    if (hypot(candidates[c].x - extrema[e].x, candidates[c].y - extrema[e].y) < 0.8)
                        prom = candProm[c];
                }
                fprintf(stderr, "    %s %.0f at %.1fS %.1fE  prom %.1f\n", extrema[e].high ? "H" : "L",
                    round(extrema[e].value), fabs(extrema[e].y), extrema[e].x, prom);
            }
        }
        OwnLineSetFree(lines);
        gRenderProfile.drawMs += ProfileLap();
    }

    if (!options.inkOnly && options.barbs) {
        // Sparse, geographically fixed samples do not jump as the time changes.
        const double barbStep = 8.0;
        for (double lat = ceil(ViewSouth() / barbStep) * barbStep; lat <= ViewNorth(); lat += barbStep) {
            for (double lon = ceil(ViewWest() / barbStep) * barbStep; lon <= ViewEast(); lon += barbStep) {
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

    if (!options.inkOnly && options.observed && options.stations && options.nStations > 0) {
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

    if (!options.inkOnly && options.temperature && options.legend) {
        DrawLegend(ctx, kPanelW, kMapH, [NSString stringWithUTF8String:options.legend],
            options.rain && !options.observed, options.observed);
    }
    CGContextRestoreGState(ctx);

    if (!options.inkOnly) {
    CGContextSetRGBStrokeColor(ctx, 0.42, 0.43, 0.44, 1);
    CGContextSetLineWidth(ctx, 1);
    CGContextStrokeRect(ctx, CGRectMake(0.5, 0.5, kPanelW - 1, kMapH - 1));
    }
    if (!options.inkOnly && !options.bare) {
        CGContextSetRGBStrokeColor(ctx, titleColour.red, titleColour.green, titleColour.blue, 1);
        CGContextStrokeRect(ctx, CGRectMake(0.5, 0.5, kPanelW - 1, kPanelH - 1));
    }

    gRenderProfile.overlayMs += ProfileLap();
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

- (OwnRunGeo)geo {
    OwnRunGeo grid = {0};
    grid.west = _cube.west;
    grid.north = _cube.north;
    grid.step = _cube.step;
    grid.nLon = _cube.nLon;
    grid.nLat = _cube.nLat;
    double span = (double)_cube.nLon * _cube.step;
    grid.wrapsLongitude = isfinite(span) && fabs(span - 360.0) < 1e-3;
    return grid;
}
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

- (double *)screenedMslpAtHour:(NSInteger)hour rough:(uint8_t **)roughOut {
    if (roughOut) *roughOut = NULL;
    if (hour < 0 || hour >= _cube.nHours || !_land) return NULL;
    return SmoothedMSLP(&_cube, (double)hour, _land, roughOut);
}

- (BOOL)readDirectory:(NSString *)dir coast:(NSString *)coastPath error:(NSString **)error {
    NSDictionary *manifest = nil;
    if (!LoadRunDirectory(dir, &_cube, &manifest, error)) return NO;
    NSString *selectedCoastPath = coastPath;
    if (_cube.nLon == 720 && _cube.nLat == 361 && fabs(_cube.step - 0.5) < 1e-6) {
        NSString *world = OwnWorldCoastPath();
        selectedCoastPath = world;
    }
    NSData *coastData = [NSData dataWithContentsOfFile:selectedCoastPath];
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

- (BOOL)readPublishedRoot:(NSString *)root run:(NSString *)runID previousRuns:(NSArray<NSString *> *)previousRuns
    leads:(const int *)leads count:(int)nLeads coast:(NSString *)coastPath error:(NSString **)error {
    NSDate *date = nil;
    BOOL loaded = NO;
    if (nLeads > 0) {
        // A run directory with no manifest is the old 0–96 h grid. A schema 2
        // directory that lists other hours cannot borrow that path.
        NSString *manifestPath = [[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
            stringByAppendingPathComponent:runID] stringByAppendingPathComponent:@"manifest.json"];
        if ([[NSFileManager defaultManager] fileExistsAtPath:manifestPath])
            loaded = LoadPublishedLadder(root, runID, previousRuns, leads, nLeads, &_cube, &date, error);
        else {
            NSString *mslp = [[[PublishedFamilyPath(root) stringByAppendingPathComponent:@"runs"]
                stringByAppendingPathComponent:runID] stringByAppendingPathComponent:@"mslp"];
            NSArray *names = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:mslp error:nil];
            NSUInteger jsonCount = 0;
            for (NSString *name in names) if ([name.pathExtension.lowercaseString isEqual:@"json"]) jsonCount++;
            // The legacy loader is Australian-only; a global run must have its manifest.
            BOOL global = [PublishedFamilyPath(root).lastPathComponent isEqual:@"ecmwf_ifs_global"];
            if (jsonCount == 33 && !global)
                loaded = LoadPublishedCube(root, runID, previousRuns, &_cube, &date, error);
            else {
                if (error) *error = @"published ECMWF schema 2 run has no manifest";
                return NO;
            }
        }
    } else
        loaded = LoadPublishedCube(root, runID, previousRuns, &_cube, &date, error);
    if (!loaded) return NO;
    NSString *selectedCoastPath = coastPath;
    if (_cube.nLon == 720 && _cube.nLat == 361 && fabs(_cube.step - 0.5) < 1e-6) {
        NSString *world = OwnWorldCoastPath();
        selectedCoastPath = world;
    }
    NSData *coastData = [NSData dataWithContentsOfFile:selectedCoastPath];
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
    double frameBegan = ProfileNow();
    if (scale < 1) scale = 1;
    if (scale > 4) scale = 4;
    int logicalH = layers.bare ? kMapH : kPanelH;
    int pixelsW = (int)llround(kPanelW * scale);
    int pixelsH = (int)llround(logicalH * scale);
    CGContextRef ctx = MakeContext(pixelsW, pixelsH);
    if (!ctx) return nil;
    if (layers.inkOnly) CGContextClearRect(ctx, CGRectMake(0, 0, pixelsW, pixelsH));
    CGContextScaleCTM(ctx, scale, scale);
    PanelOptions options = {0};
    options.temperature = layers.temperature;
    options.barbs = layers.barbs;
    options.windFill = layers.windFill;
    options.rain = layers.rain && !layers.observed;
    options.smoothRain = layers.rain && !layers.observed;
    options.observed = layers.observed;
    options.bare = layers.bare;
    options.plateOnly = layers.plateOnly;
    options.inkOnly = layers.inkOnly;
    options.quiet = layers.quiet;
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
    gRenderProfile.totalMs = ProfileNow() - frameBegan;
    return result;
}

- (NSImage *)renderMotion:(double)hour title:(NSString *)title layers:(OwnLayerOptions)layers
    stations:(NSArray *)stations scale:(CGFloat)scale state:(OwnMotionState *)state {
    if (!state || _cube.nPoints > 1000000 || !isfinite(hour) || hour < 0 || hour > _cube.nHours - 1) return nil;
    double frameBegan = ProfileNow();
    AdoptCubeGrid(&_cube);
    if (scale < 1) scale = 1;
    if (scale > 4) scale = 4;
    int logicalH = layers.bare ? kMapH : kPanelH;
    int pixelsW = (int)llround(kPanelW * scale);
    int pixelsH = (int)llround(logicalH * scale);
    CGContextRef ctx = MakeContext(pixelsW, pixelsH);
    if (!ctx) return nil;
    if (layers.inkOnly) CGContextClearRect(ctx, CGRectMake(0, 0, pixelsW, pixelsH));
    CGContextScaleCTM(ctx, scale, scale);
    PanelOptions options = {0};
    options.temperature = layers.temperature;
    options.barbs = layers.barbs;
    options.windFill = layers.windFill;
    options.rain = layers.rain && !layers.observed;
    options.smoothRain = layers.rain && !layers.observed;
    options.observed = layers.observed;
    options.bare = layers.bare;
    options.plateOnly = layers.plateOnly;
    options.inkOnly = layers.inkOnly;
    options.quiet = layers.quiet;
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
    gRenderProfile.totalMs = ProfileNow() - frameBegan;
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
    NSString *family = nil;
    NSData *pointerData = nil;
    NSDictionary *pointer = nil;
    NSString *globalFamily = [[root stringByAppendingPathComponent:@"products/grids"]
        stringByAppendingPathComponent:@"ecmwf_ifs_global"];
    NSString *globalPointerPath = [globalFamily stringByAppendingPathComponent:@"current.json"];
    BOOL hasGlobalPointer = [[NSFileManager defaultManager] fileExistsAtPath:globalPointerPath];
    if (hasGlobalPointer) {
        // A published global pointer is authoritative. Never silently select
        // the regional product when that pointer is malformed or incomplete:
        // doing so would report a healthy Australia run while global coverage
        // had actually failed.
        pointerData = [NSData dataWithContentsOfFile:globalPointerPath];
        pointer = [NSJSONSerialization JSONObjectWithData:pointerData ?: [NSData data] options:0 error:nil];
        NSString *latestID = [pointer isKindOfClass:NSDictionary.class] &&
            [pointer[@"latest"] isKindOfClass:NSString.class] ? pointer[@"latest"] : nil;
        if (![pointer isKindOfClass:NSDictionary.class] || !SupportedGridContract(pointer, error) ||
            !PublishedPointerHasRun(globalFamily, pointer, latestID)) {
            if (error && !*error) *error = @"published global ECMWF pointer is invalid or incomplete";
            return nil;
        }
        family = globalFamily;
        // The global reader uses the world plate. Include that actual asset in
        // the cache identity, even when a caller supplied its regional coast.
        coastPath = OwnWorldCoastPath();
        if (!coastPath.length) {
            if (error) *error = @"world coastline is missing";
            return nil;
        }
    } else {
        family = [[root stringByAppendingPathComponent:@"products/grids"]
            stringByAppendingPathComponent:@"ecmwf_ifs025"];
        pointerData = [NSData dataWithContentsOfFile:[family stringByAppendingPathComponent:@"current.json"]];
        pointer = [NSJSONSerialization JSONObjectWithData:pointerData ?: [NSData data] options:0 error:nil];
    }
    strlcpy(gPublishedFamilyPath, family.fileSystemRepresentation, sizeof gPublishedFamilyPath);
    if (![pointer isKindOfClass:NSDictionary.class]) {
        if (error) *error = @"published ECMWF pointer is not an object";
        return nil;
    }
    if (!SupportedGridContract(pointer, error)) return nil;
    int schema = PublishedSchema(pointer);
    int leads[80];
    int nLeads = 0;
    if (schema == 2) {
        if (!ParseForecastHours(pointer[@"forecast_hours"], leads, &nLeads, error)) return nil;
        id uniform = pointer[@"uniform_step_hours"];
        if (uniform && ![uniform isKindOfClass:NSNull.class]) {
            if (error) *error = @"ECMWF schema 2 claims a uniform step";
            return nil;
        }
    }
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
    NSArray<NSString *> *rainPreviousRuns = @[];
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
        NSMutableArray<NSString *> *older = [NSMutableArray array];
        for (NSString *item in dates)
            if ([dates[item] compare:latestDate] == NSOrderedAscending) [older addObject:item];
        [older sortUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
            return [dates[b] compare:dates[a]];
        }];
        rainPreviousRuns = [older copy];
        previousID = older.firstObject;
    }
    NSString *runsRoot = [family stringByAppendingPathComponent:@"runs"];
    NSMutableString *cacheKey = [NSMutableString stringWithFormat:@"%@|previous=%d|pointer=",
        [root stringByStandardizingPath], previous];
    [cacheKey appendString:[pointerData base64EncodedStringWithOptions:0] ?: @"missing"];
    [cacheKey appendFormat:@"|coast=%@", PublishedFileStamp(coastPath)];
    // Current runs may derive early rain frames from any retained older run,
    // so include every candidate directory in the identity. Metadata is enough
    // to detect atomic publishes and in-place corrections without hashing tens
    // of megabytes on every tick.
    NSArray<NSString *> *dependencies = [@[runID] arrayByAddingObjectsFromArray:rainPreviousRuns];
    for (NSString *dependency in dependencies) {
        NSString *dir = [runsRoot stringByAppendingPathComponent:dependency];
        [cacheKey appendFormat:@"|run=%@:%@", dependency, PublishedDirectoryStamp(dir)];
    }
    OwnRun *cached = [PublishedRunCache() objectForKey:cacheKey];
    if (cached) return cached;
    OwnRun *run = [OwnRun new];
    if (![run readPublishedRoot:root run:runID previousRuns:rainPreviousRuns leads:nLeads ? leads : NULL count:nLeads coast:coastPath error:error]) return nil;
    // Each publish changes the key. Drop the superseded run for this root and
    // slot, so a 550 MiB global run does not linger beside its successor.
    static NSMutableDictionary<NSString *, NSString *> *latestKeys;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ latestKeys = [NSMutableDictionary dictionary]; });
    NSString *slot = [NSString stringWithFormat:@"%@|previous=%d", [root stringByStandardizingPath], previous];
    @synchronized (latestKeys) {
        NSString *stale = latestKeys[slot];
        if (stale && ![stale isEqualToString:cacheKey]) [PublishedRunCache() removeObjectForKey:stale];
        latestKeys[slot] = cacheKey;
    }
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
    return @"24 h precipitation ending at chart time (mm)";
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
