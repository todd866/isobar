// Renders a published run through the GPU field renderer.
// Usage: field-preview --store DIR --out DIR
//        field-preview --store DIR --compare-centres
// Coastline path: ISOBAR_COAST, or Resources/ownchart-coast.bin.
// The store is a published root (products/grids/ecmwf_ifs025/current.json).
// PNGs are written only under --out.
// --compare-centres reads the store and writes no files. It lists the chart's
// H/L marks (OwnRunRenderMotion + copyCentrePoints) and the GPU renderer's
// marks at frame indices 0, 2.5, 8 and 24, plus forecast hour 48 (frame 16;
// the published run has 33 frames, so index 48 is not a step).
//
// Build (from the repo root):
// clang -fobjc-arc -Wall -Wextra -Werror -isysroot "$(xcrun --sdk macosx --show-sdk-path)" -mmacosx-version-min=15.0 -ISources -DISOBAR_APP \
//   Sources/fieldrender.m Sources/ownchart.m Sources/pure.m tools/own-chart.m tools/field-preview.m \
//   -framework Foundation -framework Cocoa -framework Metal -framework CoreGraphics -framework CoreText -framework ImageIO -framework Accelerate -lz \
//   -o build/field-preview
#import "fieldrender.h"
#import "ownchart.h"
#import "ownrender.h"
#import <ImageIO/ImageIO.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>

static BOOL WritePNG(CGImageRef image, NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.png"), 1, NULL);
    if (!dest) return NO;
    CGImageDestinationAddImage(dest, image, NULL);
    BOOL ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
    return ok;
}

static float *Pull(OwnRun *run, OwnRunField field, NSInteger hour, NSInteger n) {
    float *values = malloc(sizeof(float) * (size_t)n);
    if (!values) return NULL;
    for (NSInteger i = 0; i < n; i++) {
        double sample = [run valueAtPointIndex:i field:field hour:hour];
        values[i] = isfinite(sample) ? (float)sample : NAN;
    }
    return values;
}

static BOOL UploadHour(IsobarFieldRenderer *renderer, OwnRun *run, OwnRunField field,
    IsobarFieldKind kind, NSInteger hour, NSInteger count) {
    float *values = Pull(run, field, hour, count);
    if (!values) {
        fprintf(stderr, "field-preview: out of memory\n");
        return NO;
    }
    NSError *error = nil;
    BOOL ok = [renderer uploadStep:hour kind:kind values:values error:&error];
    free(values);
    if (!ok) fprintf(stderr, "field-preview: %s\n", error.localizedDescription.UTF8String);
    return ok;
}

static IsobarCamera View(double lat, double lon, double globe, double zoom) {
    IsobarCamera cam;
    cam.centreLat = lat;
    cam.centreLon = lon;
    cam.zoom = zoom;
    cam.globe = globe;
    cam.viewportW = 1100;
    cam.viewportH = 720;
    return cam;
}

static BOOL RenderNamed(IsobarFieldRenderer *renderer, NSString *out, NSString *name,
    double time, IsobarFieldKind fill, IsobarCamera cam) {
    NSError *error = nil;
    CGImageRef image = [renderer renderTime:time fill:fill isobars:YES camera:cam error:&error];
    if (!image) {
        fprintf(stderr, "field-preview: %s\n", error.localizedDescription.UTF8String);
        return NO;
    }
    NSString *path = [out stringByAppendingPathComponent:name];
    BOOL ok = WritePNG(image, path);
    CGImageRelease(image);
    if (!ok) {
        fprintf(stderr, "field-preview: could not write %s\n", path.UTF8String);
        return NO;
    }
    fprintf(stderr, "wrote %s\n", path.UTF8String);
    return YES;
}

// Chart plate from tools/own-chart.m (kView*, kPanelW, kMapH). y from
// copyCentrePoints is up; OwnViewProject's y is down.
static const double kPlateWest = 108.0, kPlateEast = 162.0, kPlateSouth = -45.5, kPlateNorth = -5.0;
static const double kPlateW = 580.0, kPlateH = 444.0;

typedef struct {
    double lat, lon, value;
    int high;
} CentreMark;

static BOOL PlateUnproject(OwnView view, double x, double yDown, double *lat, double *lon) {
    if (!view.valid || view.scale == 0) return NO;
    double projX = view.minX + (x - view.offsetX) / view.scale;
    double projY = view.maxY - (yDown - view.offsetY) / view.scale;
    return OwnUnproject(view.geo, projX, projY, lat, lon);
}

static BOOL OnPlate(OwnView view, double lat, double lon) {
    double x = 0, yDown = 0;
    if (!OwnViewProject(view, lat, lon, &x, &yDown)) return NO;
    double yUp = kPlateH - yDown;
    return x >= 18 && x <= kPlateW - 18 && yUp >= 18 && yUp <= kPlateH - 18;
}

static int ParseChartLog(const char *text, CentreMark *out, int cap) {
    int n = 0;
    const char *p = text;
    while (p && *p && n < cap) {
        const char *line = p;
        const char *nl = strchr(p, '\n');
        p = nl ? nl + 1 : p + strlen(p);
        char kind = 0;
        double value = 0, lat = 0, lon = 0;
        if (sscanf(line, " %c %lf at %lfS %lfE", &kind, &value, &lat, &lon) != 4) continue;
        if (kind != 'H' && kind != 'L') continue;
        out[n++] = (CentreMark){-lat, lon, value, kind == 'H'};
    }
    return n;
}

static int ChartCentres(OwnRun *run, double index, OwnView view, CentreMark *out, int cap, NSString **logOut) {
    OwnMotionState *state = [OwnMotionState new];
    state.immediateAnnotations = YES;
    OwnLayerOptions layers = {0};
    fflush(stderr);
    [[NSFileManager defaultManager] createDirectoryAtPath:@"build" withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *path = @"build/centre-compare.log";
    FILE *log = fopen(path.fileSystemRepresentation, "w+");
    int saved = dup(STDERR_FILENO);
    if (!log || saved < 0) {
        if (log) fclose(log);
        if (saved >= 0) close(saved);
        return -1;
    }
    setenv("ISOBAR_CHART_LOG", "1", 1);
    dup2(fileno(log), STDERR_FILENO);
    NSImage *image = OwnRunRenderMotion(run, index, @"", layers, nil, 1, state);
    fflush(stderr);
    dup2(saved, STDERR_FILENO);
    close(saved);
    unsetenv("ISOBAR_CHART_LOG");
    (void)image;
    rewind(log);
    NSMutableData *bytes = [NSMutableData data];
    char buf[1024];
    size_t got = 0;
    while ((got = fread(buf, 1, sizeof buf, log)) > 0) [bytes appendBytes:buf length:got];
    fclose(log);
    remove(path.fileSystemRepresentation);
    NSString *text = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding] ?: @"";
    if (logOut) *logOut = text;
    CentreMark logged[24];
    int nLog = ParseChartLog(text.UTF8String, logged, 24);
    CGPoint points[24];
    NSInteger nPts = [state copyCentrePoints:points max:24];
    if (nPts != nLog)
        printf("  chart points %ld log %d\n%s", (long)nPts, nLog, text.UTF8String);
    int n = 0;
    for (NSInteger i = 0; i < nPts && n < cap; i++) {
        double lat = 0, lon = 0;
        double yDown = kPlateH - points[i].y;
        if (!PlateUnproject(view, points[i].x, yDown, &lat, &lon)) continue;
        CentreMark mark = {lat, lon, NAN, -1};
        double best = 1.5;
        for (int k = 0; k < nLog; k++) {
            double d = hypot(logged[k].lat - lat, logged[k].lon - lon);
            if (d < best) { best = d; mark.high = logged[k].high; mark.value = logged[k].value; }
        }
        if (mark.high < 0) continue;
        out[n++] = mark;
    }
    return n;
}

static int GpuCentres(IsobarFieldRenderer *renderer, double index, IsobarCamera cam, OwnView plate,
    CentreMark *out, int cap) {
    NSError *error = nil;
    CGImageRef image = [renderer renderTime:index fill:IsobarFieldPressure isobars:YES camera:cam error:&error];
    if (!image) {
        fprintf(stderr, "field-preview: %s\n", error.localizedDescription.UTF8String ?: "GPU frame failed");
        return -1;
    }
    CGImageRelease(image);
    int n = 0;
    for (NSInteger i = 0; i < renderer.centreCount && n < cap; i++) {
        double x = 0, y = 0, value = 0;
        BOOL high = NO;
        if (![renderer centreAtIndex:i x:&x y:&y value:&value high:&high]) continue;
        double lat = 0, lon = 0;
        if (!IsobarCameraUnproject(cam, x, y, &lat, &lon)) continue;
        if (!OnPlate(plate, lat, lon)) continue;
        out[n++] = (CentreMark){lat, lon, value, high ? 1 : 0};
    }
    return n;
}

static BOOL SameCentre(CentreMark a, CentreMark b) {
    if (a.high != b.high) return NO;
    if (hypot(a.lat - b.lat, a.lon - b.lon) > 1.5) return NO;
    return fabs(a.value - b.value) <= 1.0;
}

static int CompareCentres(NSString *store, NSString *coast) {
    NSString *error = nil;
    OwnRun *run = OwnRunLoadPublished(store, NO, coast, &error);
    if (!run) {
        fprintf(stderr, "field-preview: %s\n", error.UTF8String ?: "published run did not load");
        return 1;
    }
    // Frame index is the renderer's fractional step (3 h each). 0, 2.5, 8 and
    // 24 are inside the 33-frame run. 48 is a forecast hour, frame 16.
    struct { const char *name; double index; } times[] = {
        {"0", 0}, {"2.5", 2.5}, {"8", 8}, {"24", 24}, {"48h", 16},
    };
    IsobarFieldRenderer *renderer = [[IsobarFieldRenderer alloc] initWithDevice:nil];
    if (!renderer) {
        fprintf(stderr, "field-preview: no Metal device\n");
        return 1;
    }
    renderer.synchronousContours = YES;
    IsobarGeoGrid grid = {
        .west = OwnGridWest(), .north = OwnGridNorth(), .step = OwnGridStep(),
        .nLon = OwnGridNLon(), .nLat = OwnGridNLat(), .wrapsLongitude = NO
    };
    [renderer setGrid:grid];
    NSInteger count = OwnGridCount();
    int need[33] = {0};
    for (int t = 0; t < 5; t++) {
        int lo = (int)floor(times[t].index);
        int hi = lo + ((times[t].index - lo) > 1e-6 ? 1 : 0);
        if (lo >= 0 && lo < 33) need[lo] = 1;
        if (hi >= 0 && hi < 33) need[hi] = 1;
    }
    for (int h = 0; h < 33; h++) {
        if (!need[h]) continue;
        if (h >= run.hours) {
            fprintf(stderr, "field-preview: run has %ld frames, need %d\n", (long)run.hours, h);
            return 1;
        }
        if (!UploadHour(renderer, run, OwnRunFieldMSLP, IsobarFieldPressure, h, count)) return 1;
    }
    OwnView plate = OwnViewMake(OwnAustraliaLambert(), kPlateWest, kPlateEast, kPlateSouth, kPlateNorth,
        0, 0, kPlateW, kPlateH);
    // Zoom keeps the plate's glyphs inside the grid so a northern mark is not
    // dropped for hanging off the coverage edge.
    IsobarCamera cam = View(-25.25, 135.0, 0, 4.0);
    printf("hour  index  valid                         chart  gpu  match  miss  extra\n");
    int totalMiss = 0, totalExtra = 0;
    for (int t = 0; t < 5; t++) {
        NSDate *when = [run timeAtIndex:(NSInteger)floor(times[t].index)];
        CentreMark chart[24], gpu[24];
        NSString *log = nil;
        int nChart = ChartCentres(run, times[t].index, plate, chart, 24, &log);
        int nGpu = GpuCentres(renderer, times[t].index, cam, plate, gpu, 24);
        if (nChart < 0 || nGpu < 0) return 1;
        char used[24] = {0};
        int matches = 0, misses = 0, extras = 0;
        for (int c = 0; c < nChart; c++) {
            int hit = -1;
            for (int g = 0; g < nGpu; g++) {
                if (used[g] || !SameCentre(chart[c], gpu[g])) continue;
                hit = g;
                break;
            }
            if (hit >= 0) { used[hit] = 1; matches++; }
            else misses++;
        }
        for (int g = 0; g < nGpu; g++) if (!used[g]) extras++;
        totalMiss += misses;
        totalExtra += extras;
        printf("%-5s %5.2f  %-28s %5d %4d %6d %5d %6d\n",
            times[t].name, times[t].index, when.description.UTF8String ?: "-",
            nChart, nGpu, matches, misses, extras);
        for (int c = 0; c < nChart; c++) {
            BOOL matched = NO;
            for (int g = 0; g < nGpu; g++) if (SameCentre(chart[c], gpu[g])) matched = YES;
            if (matched) continue;
            printf("  miss  %s %5.0f  %6.2f %7.2f\n", chart[c].high ? "H" : "L",
                chart[c].value, chart[c].lat, chart[c].lon);
        }
        for (int g = 0; g < nGpu; g++) {
            BOOL matched = NO;
            for (int c = 0; c < nChart; c++) if (SameCentre(chart[c], gpu[g])) matched = YES;
            if (matched) continue;
            printf("  extra %s %5.1f  %6.2f %7.2f\n", gpu[g].high ? "H" : "L",
                gpu[g].value, gpu[g].lat, gpu[g].lon);
        }
        for (int c = 0; c < nChart; c++) {
            for (int g = 0; g < nGpu; g++) {
                if (!SameCentre(chart[c], gpu[g])) continue;
                printf("  match %s %5.0f/%5.1f  chart %6.2f %7.2f  gpu %6.2f %7.2f\n",
                    chart[c].high ? "H" : "L", chart[c].value, gpu[g].value,
                    chart[c].lat, chart[c].lon, gpu[g].lat, gpu[g].lon);
                break;
            }
        }
        (void)log;
    }
    printf("total misses %d extras %d\n", totalMiss, totalExtra);
    return totalMiss || totalExtra ? 1 : 0;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        NSString *store = nil, *out = nil;
        BOOL compare = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--store") == 0 && i + 1 < argc) store = [NSString stringWithUTF8String:argv[++i]];
            else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) out = [NSString stringWithUTF8String:argv[++i]];
            else if (strcmp(argv[i], "--compare-centres") == 0) compare = YES;
            else {
                fprintf(stderr, "usage: field-preview --store DIR --out DIR\n"
                    "       field-preview --store DIR --compare-centres\n");
                return 2;
            }
        }
        if (compare) {
            if (!store.length) {
                fprintf(stderr, "usage: field-preview --store DIR --compare-centres\n");
                return 2;
            }
            const char *coastEnv = getenv("ISOBAR_COAST");
            NSString *coast = coastEnv && coastEnv[0]
                ? [NSString stringWithUTF8String:coastEnv]
                : @"Resources/ownchart-coast.bin";
            return CompareCentres(store, coast);
        }
        if (!store.length || !out.length) {
            fprintf(stderr, "usage: field-preview --store DIR --out DIR\n");
            return 2;
        }
        const char *coastEnv = getenv("ISOBAR_COAST");
        NSString *coast = coastEnv && coastEnv[0]
            ? [NSString stringWithUTF8String:coastEnv]
            : @"Resources/ownchart-coast.bin";
        NSString *error = nil;
        OwnRun *run = OwnRunLoadPublished(store, NO, coast, &error);
        if (!run) {
            fprintf(stderr, "field-preview: %s\n", error.UTF8String ?: "published run did not load");
            return 1;
        }
        if (run.hours < 4) {
            fprintf(stderr, "field-preview: published run has %ld hours; need index 2.5\n", (long)run.hours);
            return 1;
        }
        NSInteger rainHour = -1;
        for (NSInteger i = 8; i < run.hours; i++) {
            if ([run hasRainAtIndex:i]) {
                rainHour = i;
                break;
            }
        }
        if (rainHour < 0) {
            fprintf(stderr, "field-preview: no Rain 24h at an index >= 8\n");
            return 1;
        }
        IsobarFieldRenderer *renderer = [[IsobarFieldRenderer alloc] initWithDevice:nil];
        if (!renderer) {
            fprintf(stderr, "field-preview: no Metal device\n");
            return 1;
        }
        renderer.synchronousContours = YES;
        IsobarGeoGrid grid = {
            .west = OwnGridWest(), .north = OwnGridNorth(), .step = OwnGridStep(),
            .nLon = OwnGridNLon(), .nLat = OwnGridNLat(), .wrapsLongitude = NO
        };
        [renderer setGrid:grid];
        NSInteger count = OwnGridCount();
        NSInteger pressureHours[] = {0, 2, 3, rainHour};
        for (int i = 0; i < 4; i++) {
            if (!UploadHour(renderer, run, OwnRunFieldMSLP, IsobarFieldPressure, pressureHours[i], count))
                return 1;
        }
        if (!UploadHour(renderer, run, OwnRunFieldRain, IsobarFieldRain, rainHour, count)) return 1;
        if (![[NSFileManager defaultManager] createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:nil]) {
            fprintf(stderr, "field-preview: could not create %s\n", out.UTF8String);
            return 1;
        }
        double centreLat = (OwnGridNorth() + OwnGridSouth()) * 0.5;
        double centreLon = (OwnGridWest() + OwnGridEast()) * 0.5;
        struct {
            const char *name;
            double lat, lon, globe, zoom;
        } views[] = {
            {"flat", centreLat, centreLon, 0, 3.2},
            {"globe", centreLat, centreLon, 1, 1.75},
            {"morph", centreLat, centreLon, 0.5, 2.0},
            // Zoom stays low enough that 95°E and 170°E, 140° from 45°W, are both
            // on screen. A 3.2× frame would be entirely outside the crop.
            {"pan", centreLat, -45, 0, 1.15},
            {"sydney", -33.87, 151.21, 0, 6},
        };
        double times[] = {0, 2.5};
        for (int v = 0; v < 5; v++) {
            IsobarCamera cam = View(views[v].lat, views[v].lon, views[v].globe, views[v].zoom);
            for (int t = 0; t < 2; t++) {
                NSString *name = [NSString stringWithFormat:@"%s-mslp-h%.1f.png", views[v].name, times[t]];
                if (!RenderNamed(renderer, out, name, times[t], IsobarFieldPressure, cam)) return 1;
            }
            NSString *rainName = [NSString stringWithFormat:@"%s-rain-isobars-h%.1f.png", views[v].name, (double)rainHour];
            if (!RenderNamed(renderer, out, rainName, (double)rainHour, IsobarFieldRain, cam)) return 1;
        }
        renderer.contentScale = 2;
        IsobarCamera retina = View(centreLat, centreLon, 0, 3.2);
        retina.viewportW = 2200;
        retina.viewportH = 1440;
        if (!RenderNamed(renderer, out, @"flat-2x-mslp-h0.0.png", 0, IsobarFieldPressure, retina)) return 1;
    }
    return 0;
}
