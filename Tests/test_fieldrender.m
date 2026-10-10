// Offscreen tests for the GPU field renderer. No windows.
#import "fieldrender.h"
#import "ownchart.h"
#import "hazard.h"
#import <Metal/Metal.h>
#import <math.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <time.h>
#import <unistd.h>
#import <CoreFoundation/CoreFoundation.h>

static int failures = 0;

static void check(BOOL cond, NSString *msg) {
    fprintf(stderr, "%s %s\n", cond ? "ok  " : "FAIL", msg.UTF8String);
    if (!cond) failures++;
}

static double LonErr(double a, double b) {
    double d = fmod(a - b + 180.0, 360.0);
    if (d < 0) d += 360.0;
    return fabs(d - 180.0);
}

static IsobarCamera Cam(double lat, double lon, double zoom, double globe, double w, double h) {
    IsobarCamera c;
    c.centreLat = lat;
    c.centreLon = lon;
    c.zoom = zoom;
    c.globe = globe;
    c.pitch = 0;
    c.viewportW = w;
    c.viewportH = h;
    return c;
}

static int Chan(double c) {
    if (c < 0) c = 0;
    if (c > 1) c = 1;
    return (int)llround(c * 255.0);
}

static int Lum(int r, int g, int b) {
    return (int)llround(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

static BOOL NearRGB(int r, int g, int b, IsobarRGB c, int tol) {
    return abs(r - Chan(c.r)) <= tol && abs(g - Chan(c.g)) <= tol && abs(b - Chan(c.b)) <= tol;
}

static IsobarRGB PlateMix(IsobarRGB plate, IsobarRGB colour, double alpha) {
    if (alpha < 0) alpha = 0;
    if (alpha > 1) alpha = 1;
    return (IsobarRGB){
        plate.r * (1.0 - alpha) + colour.r * alpha,
        plate.g * (1.0 - alpha) + colour.g * alpha,
        plate.b * (1.0 - alpha) + colour.b * alpha,
    };
}

static int Pix(double c) { return (int)llround(c - 0.5); }

typedef struct {
    uint8_t *px;
    int w, h;
} Image;

static void ImageFree(Image *im) {
    free(im->px);
    im->px = NULL;
}

static BOOL ImageFrom(CGImageRef image, Image *im) {
    memset(im, 0, sizeof *im);
    if (!image) return NO;
    im->w = (int)CGImageGetWidth(image);
    im->h = (int)CGImageGetHeight(image);
    size_t bpr = CGImageGetBytesPerRow(image);
    CFDataRef data = CGDataProviderCopyData(CGImageGetDataProvider(image));
    if (!data || im->w < 1 || im->h < 1) {
        if (data) CFRelease(data);
        return NO;
    }
    im->px = malloc((size_t)im->w * (size_t)im->h * 4);
    const uint8_t *src = CFDataGetBytePtr(data);
    for (int y = 0; y < im->h; y++)
        memcpy(im->px + (size_t)y * (size_t)im->w * 4, src + (size_t)y * bpr, (size_t)im->w * 4);
    CFRelease(data);
    return YES;
}

static void At(Image im, int x, int y, int *r, int *g, int *b) {
    if (x < 0 || y < 0 || x >= im.w || y >= im.h) {
        *r = *g = *b = -1;
        return;
    }
    const uint8_t *p = im.px + ((size_t)y * (size_t)im.w + (size_t)x) * 4;
    *r = p[0];
    *g = p[1];
    *b = p[2];
}

static void Paint(float *v, int nLon, int nLat, double west, double north, double step,
    double lat0, double lat1, double lon0, double lon1, float value) {
    for (int row = 0; row < nLat; row++) {
        double lat = north - row * step;
        if (lat < lat1 - 1e-9 || lat > lat0 + 1e-9) continue;
        for (int col = 0; col < nLon; col++) {
            double lon = west + col * step;
            if (lon < lon0 - 1e-9 || lon > lon1 + 1e-9) continue;
            v[row * nLon + col] = value;
        }
    }
}

static BOOL Upload(IsobarFieldRenderer *r, NSInteger step, IsobarFieldKind kind, const float *v) {
    NSError *error = nil;
    BOOL ok = [r uploadStep:step kind:kind values:v error:&error];
    if (!ok) fprintf(stderr, "  upload: %s\n", error.localizedDescription.UTF8String);
    return ok;
}

static CGImageRef Render(IsobarFieldRenderer *r, double time, IsobarFieldKind fill, BOOL lines, IsobarCamera cam) {
    NSError *error = nil;
    CGImageRef image = [r renderTime:time fill:fill isobars:lines camera:cam error:&error];
    if (!image) fprintf(stderr, "  render: %s\n", error.localizedDescription.UTF8String);
    return image;
}

static void TestCamera(void) {
    double globes[] = {0, 0.5, 1};
    for (int g = 0; g < 3; g++) {
        IsobarCamera cam = Cam(0, 0, 1, globes[g], 640, 360);
        double x = 0, y = 0;
        check(IsobarCameraProject(cam, 0, 0, &x, &y), @"camera centre is visible");
        check(fabs(x - 320) < 1e-6 && fabs(y - 180) < 1e-6, @"camera centre projects to the viewport centre");
        double lat = 0, lon = 0;
        check(IsobarCameraUnproject(cam, x, y, &lat, &lon), @"viewport centre unprojects");
        check(fabs(lat) < 1e-4 && LonErr(lon, 0) < 1e-4, @"viewport centre is the camera centre");
    }

    for (int p = 1; p <= 3; p++) {
        IsobarCamera tilted = Cam(0, 179, 2, 1, 640, 420);
        tilted.pitch = p == 1 ? 0.02 : (p == 2 ? 0.349 : 1.12);
        double points[][2] = {{-8, 152}, {10, -170}};
        BOOL displaced = NO;
        for (int i = 0; i < 2; i++) {
            double x = 0, y = 0, la = 0, lo = 0;
            check(IsobarCameraProject(tilted, points[i][0], points[i][1], &x, &y),
                [NSString stringWithFormat:@"tilted globe %.2f projects a front point", tilted.pitch]);
            check(IsobarCameraUnproject(tilted, x, y, &la, &lo) &&
                fabs(la - points[i][0]) < 0.02 && LonErr(lo, points[i][1]) < 0.02,
                [NSString stringWithFormat:@"tilted globe %.2f global round trip", tilted.pitch]);
            displaced |= fabs(x - tilted.viewportW * 0.5) > 0.1 || fabs(y - tilted.viewportH * 0.5) > 0.1;
        }
        check(displaced,
            @"tilt produces a perspective displacement away from the focus");
    }
    IsobarCamera altitudeCam = Cam(-18, 137, 2, 1, 640, 420);
    altitudeCam.pitch = 0.9;
    double gx = 0, gy = 0, ax = 0, ay = 0;
    BOOL ground = IsobarCameraProjectAltitude(altitudeCam, -8, 152, 0, &gx, &gy);
    BOOL high = IsobarCameraProjectAltitude(altitudeCam, -8, 152, 12000, &ax, &ay);
    check(ground && high && isfinite(ax) && isfinite(ay), @"altitude projection accepts a visible atmospheric point");
    check(hypot(ax - gx, ay - gy) > 0.001, @"altitude projection has perspective parallax");
    IsobarCamera lowEye=Cam(0,0,10000,1,640,420); lowEye.pitch=1.2;
    check(IsobarCameraProjectAltitude(lowEye,.1,0,3000,&ax,&ay), @"cloud above the eye remains visible from below its shell");
    check(!IsobarCameraProjectAltitude(lowEye,0,180,3000,&ax,&ay), @"Earth occludes elevated backside objects");
    IsobarCamera flat = Cam(-20, 179, 1, 0, 720, 360);
    double xWest = 0, yWest = 0, xEast = 0, yEast = 0, xC = 0, yC = 0;
    check(IsobarCameraProject(flat, -20, 170, &xWest, &yWest), @"170E is visible beside the dateline");
    check(IsobarCameraProject(flat, -20, -170, &xEast, &yEast), @"170W is visible beside the dateline");
    check(IsobarCameraProject(flat, -20, 179, &xC, &yC), @"centre longitude is visible");
    check(xWest < xC && xC < xEast, @"flat map wraps 170E..170W across the dateline");
    double lat = 0, lon = 0;
    check(IsobarCameraUnproject(flat, xWest, yWest, &lat, &lon) && fabs(lat + 20) < 1e-4 && LonErr(lon, 170) < 1e-4,
        @"170E round-trips across the dateline");
    check(IsobarCameraUnproject(flat, xEast, yEast, &lat, &lon) && LonErr(lon, -170) < 1e-4,
        @"170W round-trips across the dateline");
    double xA = 0, yA = 0, xB = 0, yB = 0;
    check(IsobarCameraProject(flat, -20, 10, &xA, &yA) && IsobarCameraProject(flat, -20, 370, &xB, &yB),
        @"longitude +360 still projects");
    check(fabs(xA - xB) < 1e-6 && fabs(yA - yB) < 1e-6, @"longitude is periodic");

    struct { double lat, lon; } pts[] = {{0, 0}, {20, 30}, {-15, -25}, {35, 12}, {-40, 50}};
    for (int g = 0; g < 3; g++) {
        IsobarCamera cam = Cam(-10, 40, 1.5, globes[g], 500, 400);
        double tol = globes[g] == 0.5 ? 0.03 : 1e-4;
        for (unsigned i = 0; i < sizeof pts / sizeof pts[0]; i++) {
            double x = 0, y = 0, la = 0, lo = 0;
            if (!IsobarCameraProject(cam, pts[i].lat, pts[i].lon, &x, &y)) continue;
            BOOL back = IsobarCameraUnproject(cam, x, y, &la, &lo);
            check(back && fabs(la - pts[i].lat) < tol && LonErr(lo, pts[i].lon) < tol,
                [NSString stringWithFormat:@"round trip globe %.1f lat %.0f lon %.0f -> %.4f %.4f",
                    globes[g], pts[i].lat, pts[i].lon, la, lo]);
        }
    }

    IsobarCamera globe = Cam(0, 0, 1, 1, 400, 400);
    double x = 0, y = 0;
    BOOL vis = IsobarCameraProject(globe, 0, 180, &x, &y);
    check(!vis && isfinite(x) && isfinite(y), @"back hemisphere is hidden on the globe");
    globe.globe = 0.5;
    check(IsobarCameraProject(globe, 0, 180, &x, &y) && isfinite(x) && isfinite(y),
        @"back hemisphere stays visible at globe 0.5");
    globe.globe = 0.51;
    vis = IsobarCameraProject(globe, 0, 180, &x, &y);
    check(!vis && isfinite(x) && isfinite(y), @"back hemisphere is hidden just past globe 0.5");
    globe.globe = 1;
    check(!IsobarCameraUnproject(globe, 0, 0, &lat, &lon), @"a corner outside the disk does not unproject");

    double centres[] = {0, 80, -80};
    for (int g = 0; g < 3; g++) {
        for (int c = 0; c < 3; c++) {
            IsobarCamera cam = Cam(centres[c], 20, 1, globes[g], 300, 300);
            double px = 0, py = 0;
            IsobarCameraProject(cam, 90, 0, &px, &py);
            check(isfinite(px) && isfinite(py), @"north pole projects to a finite position");
            IsobarCameraProject(cam, -90, 45, &px, &py);
            check(isfinite(px) && isfinite(py), @"south pole projects to a finite position");
        }
    }

    // A degree at the centre is the same size at every globe. North matches
    // pxPerDeg; east matches pxPerDeg * cos(centreLat), because the tangent
    // plane uses local distance.
    double scales[] = {0, 0.5, 1};
    struct { double lat, lon, zoom, w, h; } cams[] = {
        {-35, 151, 3, 640, 400},
        {0, 120, 2, 720, 360},
    };
    for (int c = 0; c < 2; c++) {
        double north[3], east[3], fit = 0;
        for (int g = 0; g < 3; g++) {
            IsobarCamera cam = Cam(cams[c].lat, cams[c].lon, cams[c].zoom, scales[g], cams[c].w, cams[c].h);
            double x0, y0, xn, yn, xe, ye;
            check(IsobarCameraProject(cam, cam.centreLat, cam.centreLon, &x0, &y0), @"scale sample centre is visible");
            check(IsobarCameraProject(cam, cam.centreLat + 1, cam.centreLon, &xn, &yn), @"scale sample north is visible");
            check(IsobarCameraProject(cam, cam.centreLat, cam.centreLon + 1, &xe, &ye), @"scale sample east is visible");
            north[g] = hypot(xn - x0, yn - y0);
            east[g] = hypot(xe - x0, ye - y0);
            fit = cam.zoom * fmin(cam.viewportW / 360.0, cam.viewportH / 180.0);
        }
        for (int g = 1; g < 3; g++) {
            check(fabs(north[g] - north[0]) / north[0] < 0.01,
                [NSString stringWithFormat:@"north scale at lat %.0f globe %.1f matches globe 0 (%.3f vs %.3f px)",
                    cams[c].lat, scales[g], north[g], north[0]]);
            check(fabs(east[g] - east[0]) / east[0] < 0.01,
                [NSString stringWithFormat:@"east scale at lat %.0f globe %.1f matches globe 0 (%.3f vs %.3f px)",
                    cams[c].lat, scales[g], east[g], east[0]]);
        }
        double expectEast = fit * cos(cams[c].lat * M_PI / 180.0);
        check(fabs(north[0] - fit) / fit < 0.01 && fabs(east[0] - expectEast) / expectEast < 0.01,
            [NSString stringWithFormat:@"centre scale is px/deg (north %.3f east %.3f, expect %.3f %.3f)",
                north[0], east[0], fit, expectEast]);
    }

    // Flat: both poles sit on or outside the viewport edge. Globe: latitude is free.
    struct { double lat, lon, zoom, globe, w, h; } poles[] = {
        {-70, 133, 1, 0, 800, 400},
        {-80, 115, 4, 0, 800, 500},
        {70, 151, 1, 0, 400, 800},
    };
    for (int i = 0; i < 3; i++) {
        IsobarCamera raw = Cam(poles[i].lat, poles[i].lon, poles[i].zoom, poles[i].globe, poles[i].w, poles[i].h);
        IsobarCamera c = IsobarCameraClamp(raw);
        double nx = 0, ny = 0, sx = 0, sy = 0;
        check(IsobarCameraProject(c, 90, c.centreLon, &nx, &ny), @"clamped flat north pole projects");
        check(IsobarCameraProject(c, -90, c.centreLon, &sx, &sy), @"clamped flat south pole projects");
        check(ny <= 1.0 && sy >= c.viewportH - 1.0,
            [NSString stringWithFormat:@"flat poles stay at the edge (N %.1f S %.1f, view %.0f)",
                ny, sy, c.viewportH]);
        check(fabs(c.centreLon - raw.centreLon) < 1e-9, @"clamp keeps centre longitude");
        check(c.zoom >= 1 && c.zoom <= 18000, @"flat zoom stays in range");
    }
    IsobarCamera spun = IsobarCameraClamp(Cam(80, 17, 2, 1, 600, 600));
    check(fabs(spun.centreLat - 80) < 1e-9 && fabs(spun.centreLon - 17) < 1e-9,
        @"globe clamp leaves the pole free to rotate into view");
    IsobarCamera far = IsobarCameraClamp(Cam(0, 40, 20000, 1, 640, 480));
    IsobarCamera near = IsobarCameraClamp(Cam(0, 40, 0.05, 0.5, 640, 480));
    check(fabs(far.zoom - 18000) < 1e-9 && near.zoom >= 1 && near.zoom <= 18000,
        [NSString stringWithFormat:@"zoom clamps into 1...18000 (%.2f, %.2f)", far.zoom, near.zoom]);
}

static void ReadAt(Image im, IsobarCamera cam, double lat, double lon, int *r, int *g, int *b) {
    double x = 0, y = 0;
    if (!IsobarCameraProject(cam, lat, lon, &x, &y)) {
        *r = *g = *b = -1;
        return;
    }
    At(im, Pix(x), Pix(y), r, g, b);
}

static void TestAustralia(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO};
    [r setGrid:g];
    float *v = calloc((size_t)g.nLon * (size_t)g.nLat, sizeof(float));
    check(v != NULL, @"Australia field allocates");
    if (!v) return;
    for (int i = 0; i < g.nLon * g.nLat; i++) v[i] = 1013;
    Paint(v, g.nLon, g.nLat, g.west, g.north, g.step, -28, -36, 112, 120, 970);
    Paint(v, g.nLon, g.nLat, g.west, g.north, g.step, -14, -22, 146, 154, NAN);
    Paint(v, g.nLon, g.nLat, g.west, g.north, g.step, -36, -44, 98, 106, 0);
    check(Upload(r, 0, IsobarFieldPressure, v), @"Australia pressure uploads");
    IsobarCamera cam = Cam(-25, 132.5, 4, 0, 601, 401);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, NO, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"Australia frame renders");
    CGImageRelease(image);
    int r0, g0, b0;
    ReadAt(im, cam, -32.4, 116.3, &r0, &g0, &b0);
    OwnRGB landPlate = OwnChartLand();
    check(NearRGB(r0, g0, b0, (IsobarRGB){landPlate.r, landPlate.g, landPlate.b}, 4),
        [NSString stringWithFormat:@"a low over land uses the land plate (%d %d %d)", r0, g0, b0]);
    ReadAt(im, cam, -18.3, 150.4, &r0, &g0, &b0);
    check(NearRGB(r0, g0, b0, IsobarMissingColour(), 3),
        [NSString stringWithFormat:@"NaN region is the missing colour (%d %d %d)", r0, g0, b0]);
    check(!NearRGB(r0, g0, b0, IsobarFieldColour(IsobarFieldPressure, 0), 3),
        @"missing pressure is not the zero colour");
    ReadAt(im, cam, -40.4, 102.2, &r0, &g0, &b0);
    check(NearRGB(r0, g0, b0, IsobarOceanColour(), 4),
        [NSString stringWithFormat:@"ocean pressure uses the sea plate (%d %d %d)", r0, g0, b0]);
    ReadAt(im, cam, -1.3, 132.2, &r0, &g0, &b0);
    OwnRGB arafura = OwnChartLand();
    check(NearRGB(r0, g0, b0, (IsobarRGB){arafura.r, arafura.g, arafura.b}, 4),
        [NSString stringWithFormat:@"northern land uses the land plate (%d %d %d)", r0, g0, b0]);
    ReadAt(im, cam, 4, 132.5, &r0, &g0, &b0);
    check(NearRGB(r0, g0, b0, IsobarNoCoverageColour(), 3),
        [NSString stringWithFormat:@"north of the crop is outside coverage (%d %d %d)", r0, g0, b0]);
    check(!NearRGB(r0, g0, b0, IsobarOceanColour(), 3), @"outside coverage is not ocean");
    check(!NearRGB(r0, g0, b0, IsobarMissingColour(), 3), @"outside coverage is not missing");
    double x = 0, y = 0;
    IsobarCameraProject(cam, -32.4, 116.3, &x, &y);
    double picked = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    check(fabs(picked - 970) < 1e-3, @"pick reads the low");
    IsobarCameraProject(cam, -18.3, 150.4, &x, &y);
    check(isnan([r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure]), @"pick of a NaN cell is missing");
    IsobarCameraProject(cam, 8, 132.5, &x, &y);
    check(isnan([r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure]), @"pick outside the crop is missing");
    ImageFree(&im);
    free(v);
}

static void TestColourAndCoast(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    check(v != NULL, @"colour field allocates");
    if (!v) return;
    for (int i = 0; i < n; i++) v[i] = 28;
    check(Upload(r, 0, IsobarFieldTemperature, v), @"28 C field uploads");
    IsobarCamera cam = Cam(-25, 132.5, 4, 0, 601, 401);
    CGImageRef image = Render(r, 0, IsobarFieldTemperature, NO, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"28 C frame renders");
    CGImageRelease(image);
    int lr, lg, lb, sr, sg, sb;
    ReadAt(im, cam, -25, 133, &lr, &lg, &lb);
    ReadAt(im, cam, -42, 110, &sr, &sg, &sb);
    IsobarRGB landPlate = (IsobarRGB){OwnChartLand().r, OwnChartLand().g, OwnChartLand().b};
    IsobarRGB seaPlate = (IsobarRGB){OwnChartSea().r, OwnChartSea().g, OwnChartSea().b};
    IsobarRGB warm = IsobarFieldColour(IsobarFieldTemperature, 28);
    double a28 = IsobarFieldOverlayAlpha(IsobarFieldTemperature, 28);
    IsobarRGB land28 = PlateMix(landPlate, warm, a28);
    IsobarRGB sea28 = PlateMix(seaPlate, warm, a28 * IsobarFieldSeaAlphaScale(IsobarFieldTemperature));
    check(NearRGB(lr, lg, lb, land28, 6),
        [NSString stringWithFormat:@"28 C on land is the plate under a muted overlay (%d %d %d)", lr, lg, lb]);
    check(lg > 150 && lr > lg && lb < 180, @"28 C stays amber, not a saturated red");
    check(NearRGB(sr, sg, sb, sea28, 6),
        [NSString stringWithFormat:@"28 C over ocean keeps the sea plate (%d %d %d)", sr, sg, sb]);
    check(abs(lr - sr) + abs(lg - sg) + abs(lb - sb) > 8, @"ocean and land differ at the same temperature");
    int g28 = lg, b28 = lb;
    for (int i = 0; i < n; i++) v[i] = 35;
    check(Upload(r, 0, IsobarFieldTemperature, v), @"35 C field uploads");
    image = Render(r, 0, IsobarFieldTemperature, NO, cam);
    ImageFree(&im);
    check(image && ImageFrom(image, &im), @"35 C frame renders");
    CGImageRelease(image);
    ReadAt(im, cam, -25, 133, &lr, &lg, &lb);
    IsobarRGB hot = IsobarFieldColour(IsobarFieldTemperature, 35);
    IsobarRGB land35 = PlateMix(landPlate, hot, IsobarFieldOverlayAlpha(IsobarFieldTemperature, 35));
    check(NearRGB(lr, lg, lb, land35, 6) && lg < g28 && lb < b28,
        [NSString stringWithFormat:@"35 C on land is redder than 28 C (%d %d %d)", lr, lg, lb]);
    double cx = 0, cy = 0;
    IsobarCameraProject(cam, -32.0, 115.75, &cx, &cy);
    BOOL coast = NO;
    int rad = 12;
    for (int dy = -rad; dy <= rad && !coast; dy++) {
        for (int dx = -rad; dx <= rad; dx++) {
            int pr, pg, pb;
            At(im, (int)llround(cx) + dx, (int)llround(cy) + dy, &pr, &pg, &pb);
            BOOL core = pr < 70 && pg < 60 && pb < 55;
            if (core) coast = YES;
        }
    }
    check(coast, @"the Perth coast draws a dark hairline");
    for (int i = 0; i < n; i++) v[i] = 12;
    check(Upload(r, 0, IsobarFieldRain, v), @"rain field uploads");
    image = Render(r, 0, IsobarFieldRain, NO, cam);
    ImageFree(&im);
    check(image && ImageFrom(image, &im), @"rain field renders");
    CGImageRelease(image);
    ReadAt(im, cam, -25, 133, &lr, &lg, &lb);
    ReadAt(im, cam, -42, 110, &sr, &sg, &sb);
    check(abs(lr - sr) + abs(lg - sg) + abs(lb - sb) > 8, @"ocean and land differ at the same rainfall");
    for (int i = 0; i < n; i++) v[i] = 20;
    check(Upload(r, 0, IsobarFieldWindSpeed, v), @"wind field uploads");
    image = Render(r, 0, IsobarFieldWindSpeed, NO, cam);
    ImageFree(&im);
    check(image && ImageFrom(image, &im), @"wind field renders");
    CGImageRelease(image);
    ReadAt(im, cam, -25, 133, &lr, &lg, &lb);
    ReadAt(im, cam, -42, 110, &sr, &sg, &sb);
    check(abs(lr - sr) + abs(lg - sg) + abs(lb - sb) > 8, @"ocean and land differ at the same wind speed");
    for (int i = 0; i < n; i++) v[i] = 0;
    check(Upload(r, 0, IsobarFieldRain, v), @"dry field uploads");
    image = Render(r, 0, IsobarFieldRain, NO, cam);
    ImageFree(&im);
    check(image && ImageFrom(image, &im), @"dry field renders");
    CGImageRelease(image);
    ReadAt(im, cam, -25, 133, &lr, &lg, &lb);
    check(NearRGB(lr, lg, lb, landPlate, 5),
        [NSString stringWithFormat:@"rain below 0.1 mm/h leaves the land plate (%d %d %d)", lr, lg, lb]);
    ImageFree(&im);
    free(v);
}

static void TestRainDisplay(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = 130, .north = -20, .step = 0.25, .nLon = 16, .nLat = 16, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = calloc((size_t)n, sizeof(float));
    check(v != NULL, @"rain spike allocates");
    if (!v) return;
    int row = 8, col = 8;
    v[row * g.nLon + col] = 50;
    check(Upload(r, 0, IsobarFieldRain, v), @"rain spike uploads");
    check(r.residentBytes == (NSUInteger)n * sizeof(float) * 2, @"rain keeps a raw copy beside the texture");
    double lat = g.north - row * g.step, lon = g.west + col * g.step;
    IsobarCamera cam = Cam(lat, lon, 12, 0, 240, 240);
    double x = 0, y = 0;
    check(IsobarCameraProject(cam, lat, lon, &x, &y), @"rain spike projects");
    double picked = -1;
    for (int dy = -6; dy <= 6; dy++) {
        for (int dx = -6; dx <= 6; dx++) {
            double sample = [r pickValueAtX:x + dx y:y + dy camera:cam time:0 kind:IsobarFieldRain];
            if (sample > picked) picked = sample;
        }
    }
    check(picked > 20, [NSString stringWithFormat:@"rain pick %.2f still sees the raw spike", picked]);
    CGImageRef image = Render(r, 0, IsobarFieldRain, NO, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"rain spike renders");
    CGImageRelease(image);
    int pr, pg, pb;
    ReadAt(im, cam, lat, lon, &pr, &pg, &pb);
    IsobarRGB heavy = IsobarFieldColour(IsobarFieldRain, 50);
    check(NearRGB(pr, pg, pb, heavy, 14) && pg < 100 && pb < 160,
        [NSString stringWithFormat:@"the rain spike draws its own colour (%d %d %d)", pr, pg, pb]);
    int nr, ng, nb;
    ReadAt(im, cam, lat, lon + 2 * g.step, &nr, &ng, &nb);
    check(NearRGB(nr, ng, nb, IsobarFieldColour(IsobarFieldRain, 0), 10) && !NearRGB(nr, ng, nb, heavy, 30),
        [NSString stringWithFormat:@"a dry neighbour is not smeared into the spike (%d %d %d)", nr, ng, nb]);
    ImageFree(&im);
    free(v);
}

static void TestTimeAndIsobar(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = 100, .north = -10, .step = 1, .nLon = 41, .nLat = 21, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    float *b = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) {
        a[i] = 1000;
        b[i] = 1010;
    }
    check(Upload(r, 0, IsobarFieldPressure, a) && Upload(r, 1, IsobarFieldPressure, b),
        @"constant pressure steps upload");
    IsobarCamera cam = Cam(-20, 120, 8, 0, 481, 321);
    double x = 0, y = 0;
    IsobarCameraProject(cam, -20, 120, &x, &y);
    double mid = [r pickValueAtX:x y:y camera:cam time:0.5 kind:IsobarFieldPressure];
    check(fabs(mid - 1005) < 1e-3, [NSString stringWithFormat:@"t=0.5 blends 1000 and 1010 to %.3f", mid]);

    for (int row = 0; row < g.nLat; row++) {
        for (int col = 0; col < g.nLon; col++) {
            a[row * g.nLon + col] = 1000 + col;
            b[row * g.nLon + col] = 1010 + col;
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, a) && Upload(r, 1, IsobarFieldPressure, b),
        @"pressure ramp replaces the constant steps");
    double times[] = {0, 0.2};
    double lons[] = {104, 102};
    double away[] = {110, 104};
    for (int t = 0; t < 2; t++) {
        CGImageRef image = Render(r, times[t], IsobarFieldPressure, YES, cam);
        Image im = {0};
        check(image && ImageFrom(image, &im), @"ramp frame renders");
        CGImageRelease(image);
        double lx = 0, ly = 0;
        IsobarCameraProject(cam, -20, lons[t], &lx, &ly);
        int cx = Pix(lx), cy = Pix(ly);
        int bestX = cx, bestLum = 1000;
        for (int dy = -3; dy <= 3; dy++) {
            for (int dx = -8; dx <= 8; dx++) {
                int pr, pg, pb;
                At(im, cx + dx, cy + dy, &pr, &pg, &pb);
                int lum = Lum(pr, pg, pb);
                if (pr >= 0 && lum < bestLum) {
                    bestLum = lum;
                    bestX = cx + dx;
                }
            }
        }
        double ax = 0, ay = 0;
        IsobarCameraProject(cam, -20, away[t], &ax, &ay);
        int ar, ag, ab;
        At(im, Pix(ax), Pix(ay), &ar, &ag, &ab);
        double value = 1000 + 10 * times[t] + (away[t] - 100);
        check(NearRGB(ar, ag, ab, IsobarFieldColour(IsobarFieldPressure, value), 4),
            [NSString stringWithFormat:@"off-line pixel at t=%.1f matches the ramp fill (%d %d %d)", times[t], ar, ag, ab]);
        check(bestLum < Lum(ar, ag, ab) - 25 && abs(bestX - cx) <= 3,
            [NSString stringWithFormat:@"1004 hPa line at t=%.1f is near x %d (found %d lum %d, fill lum %d)",
                times[t], cx, bestX, bestLum, Lum(ar, ag, ab)]);
        ImageFree(&im);
    }
    free(a);
    free(b);
}

static void TestDateline(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = -180, .north = 90, .step = 90, .nLon = 4, .nLat = 3, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    float cols[] = {1040, 1000, 1000, 980};
    for (int row = 0; row < g.nLat; row++)
        for (int col = 0; col < g.nLon; col++) v[row * g.nLon + col] = cols[col];
    check(Upload(r, 0, IsobarFieldPressure, v), @"wrapped pressure uploads");
    IsobarCamera cam = Cam(0, 135, 8, 0, 401, 301);
    double x = 0, y = 0;
    IsobarCameraProject(cam, 0, 135, &x, &y);
    double picked = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    check(fabs(picked - 1010) < 1e-3, [NSString stringWithFormat:@"wrap blend at lon 135 is %.3f", picked]);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, NO, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"wrap frame renders");
    CGImageRelease(image);
    int pr, pg, pb;
    At(im, Pix(x), Pix(y), &pr, &pg, &pb);
    check(NearRGB(pr, pg, pb, IsobarFieldColour(IsobarFieldPressure, 1010), 3),
        [NSString stringWithFormat:@"dateline cell paints the blended colour (%d %d %d)", pr, pg, pb]);
    check(!NearRGB(pr, pg, pb, IsobarFieldColour(IsobarFieldPressure, 980), 8),
        @"dateline cell is not the clamped edge colour");
    ImageFree(&im);
    free(v);

    IsobarGeoGrid fine = {.west = -180, .north = 90, .step = 1, .nLon = 360, .nLat = 181, .wrapsLongitude = YES};
    [r setGrid:fine];
    int fn = fine.nLon * fine.nLat;
    float *field = malloc(sizeof(float) * (size_t)fn);
    for (int row = 0; row < fine.nLat; row++) {
        for (int col = 0; col < fine.nLon; col++) {
            double lon = fine.west + col * fine.step;
            field[row * fine.nLon + col] = (float)(1012 + 12 * sin(lon * M_PI / 180.0));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, field), @"smooth global field uploads");
    IsobarCamera world = Cam(0, 180, 1, 0, 401, 221);
    image = Render(r, 0, IsobarFieldPressure, NO, world);
    check(image && ImageFrom(image, &im), @"dateline-centred frame renders");
    CGImageRelease(image);
    IsobarCameraProject(world, 0, 180, &x, &y);
    int cx = Pix(x), cy = Pix(y);
    int leftR, leftG, leftB, rightR, rightG, rightB, midR, midG, midB;
    At(im, cx - 1, cy, &leftR, &leftG, &leftB);
    At(im, cx + 1, cy, &rightR, &rightG, &rightB);
    At(im, cx, cy, &midR, &midG, &midB);
    double pickL = [r pickValueAtX:(cx - 1) + 0.5 y:cy + 0.5 camera:world time:0 kind:IsobarFieldPressure];
    double pickR = [r pickValueAtX:(cx + 1) + 0.5 y:cy + 0.5 camera:world time:0 kind:IsobarFieldPressure];
    check(NearRGB(leftR, leftG, leftB, IsobarFieldColour(IsobarFieldPressure, pickL), 4),
        [NSString stringWithFormat:@"pixel west of the dateline matches the field (%d %d %d)", leftR, leftG, leftB]);
    check(NearRGB(rightR, rightG, rightB, IsobarFieldColour(IsobarFieldPressure, pickR), 4),
        [NSString stringWithFormat:@"pixel east of the dateline matches the field (%d %d %d)", rightR, rightG, rightB]);
    int seam = abs(leftR - rightR) + abs(leftG - rightG) + abs(leftB - rightB);
    check(seam < 12 && !NearRGB(midR, midG, midB, IsobarOceanColour(), 3),
        [NSString stringWithFormat:@"no seam column on the dateline (channel delta %d)", seam]);
    ImageFree(&im);
    free(field);
}

static BOOL SameImage(Image a, Image b) {
    if (!a.px || !b.px || a.w != b.w || a.h != b.h) return NO;
    return memcmp(a.px, b.px, (size_t)a.w * (size_t)a.h * 4) == 0;
}

static void TestGlobeAndDeterminism(IsobarFieldRenderer *r, id<MTLDevice> device) {
    IsobarGeoGrid g = {.west = 130, .north = -20, .step = 1, .nLon = 5, .nLat = 5, .wrapsLongitude = NO};
    [r setGrid:g];
    float *v = malloc(sizeof(float) * 25);
    for (int i = 0; i < 25; i++) v[i] = 1000;
    check(Upload(r, 0, IsobarFieldPressure, v), @"constant patch uploads");
    double globes[] = {0, 0.5, 1};
    IsobarCamera saved = {0};
    Image first = {0};
    for (int i = 0; i < 3; i++) {
        IsobarCamera cam = Cam(-22, 132, 1, globes[i], 301, 301);
        CGImageRef image = Render(r, 0, IsobarFieldPressure, NO, cam);
        Image im = {0};
        check(image && ImageFrom(image, &im),
            [NSString stringWithFormat:@"globe %.1f renders", globes[i]]);
        CGImageRelease(image);
        int pr, pg, pb;
        ReadAt(im, cam, -22, 132, &pr, &pg, &pb);
        check(NearRGB(pr, pg, pb, IsobarFieldColour(IsobarFieldPressure, 1000), 3),
            [NSString stringWithFormat:@"globe %.1f centre is the field (%d %d %d)", globes[i], pr, pg, pb]);
        if (globes[i] != 0.5) {
            At(im, 2, 2, &pr, &pg, &pb);
            check(NearRGB(pr, pg, pb, IsobarOceanColour(), 3),
                [NSString stringWithFormat:@"globe %.1f corner is ocean (%d %d %d)", globes[i], pr, pg, pb]);
        }
        if (i == 0) {
            saved = cam;
            first = im;
        } else {
            ImageFree(&im);
        }
    }
    CGImageRef again = Render(r, 0, IsobarFieldPressure, NO, saved);
    Image second = {0};
    check(again && ImageFrom(again, &second), @"second flat render");
    CGImageRelease(again);
    IsobarCamera other = saved;
    other.globe = 1;
    CGImageRef globe = Render(r, 0, IsobarFieldPressure, NO, other);
    CGImageRelease(globe);
    again = Render(r, 0, IsobarFieldPressure, NO, saved);
    Image third = {0};
    check(again && ImageFrom(again, &third), @"flat render after a globe frame");
    CGImageRelease(again);
    check(SameImage(first, second) && SameImage(first, third), @"same inputs are byte-identical");
    ImageFree(&first);
    ImageFree(&second);
    ImageFree(&third);

    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
        width:301 height:301 mipmapped:NO];
    desc.usage = MTLTextureUsageRenderTarget;
    desc.storageMode = MTLStorageModePrivate;
    id<MTLTexture> tex = [device newTextureWithDescriptor:desc];
    NSError *error = nil;
    check([r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:saved toTexture:tex error:&error],
        error.localizedDescription ?: @"render into a caller texture");

    MTLTextureDescriptor *bgraDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:301 height:301 mipmapped:NO];
    bgraDesc.usage = MTLTextureUsageRenderTarget;
    bgraDesc.storageMode = MTLStorageModeShared;
    id<MTLTexture> bgra = [device newTextureWithDescriptor:bgraDesc];
    error = nil;
    check(bgra && [r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:saved toTexture:bgra error:&error],
        error.localizedDescription ?: @"render into a BGRA8 texture");
    uint8_t bgraPx[4] = {0};
    double bx = 0, by = 0;
    IsobarCameraProject(saved, -22, 132, &bx, &by);
    NSUInteger bgraX = (NSUInteger)floor(bx), bgraY = (NSUInteger)floor(by);
    [bgra getBytes:bgraPx bytesPerRow:301 * 4
        fromRegion:MTLRegionMake2D(bgraX, bgraY, 1, 1) mipmapLevel:0];
    check(NearRGB(bgraPx[2], bgraPx[1], bgraPx[0], IsobarFieldColour(IsobarFieldPressure, 1000), 3),
        [NSString stringWithFormat:@"BGRA8 centre is the field (%d %d %d)", bgraPx[2], bgraPx[1], bgraPx[0]]);
    free(v);
}

static IsobarFieldRenderer *MakeRenderer(id<MTLDevice> device) {
    IsobarFieldRenderer *r = [[IsobarFieldRenderer alloc] initWithDevice:device];
    r.synchronousContours = YES;
    return r;
}

static void TestLRU(void) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    IsobarFieldRenderer *r = MakeRenderer(device);
    IsobarGeoGrid g = {.west = 0, .north = 0, .step = 1, .nLon = 4, .nLat = 3, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = 12;
    float *v = malloc(sizeof(float) * (size_t)n);
    NSUInteger one = (NSUInteger)n * sizeof(float) * 2;
    r.residentByteBudget = one * 3;
    for (int i = 0; i < n; i++) v[i] = 1000;
    check(Upload(r, 0, IsobarFieldPressure, v), @"first slot uploads");
    check(Upload(r, 0, IsobarFieldPressure, v), @"re-upload does not grow residency");
    check(r.residentBytes == one, @"one pressure slot counts the texture and the CPU copy");
    for (int i = 0; i < n; i++) v[i] = 1100;
    Upload(r, 1, IsobarFieldPressure, v);
    for (int i = 0; i < n; i++) v[i] = 1200;
    Upload(r, 2, IsobarFieldPressure, v);
    check(r.residentBytes == one * 3, @"three pressure slots fill the byte budget");
    for (int i = 0; i < n; i++) v[i] = 1000;
    Upload(r, 0, IsobarFieldPressure, v);
    for (int i = 0; i < n; i++) v[i] = 5000;
    check(Upload(r, 3, IsobarFieldPressure, v), @"upload past the budget");
    check(r.residentBytes == one * 3, @"residency stays inside the byte budget");
    IsobarCamera cam = Cam(-1, 1.5, 1, 0, 200, 120);
    double x = 0, y = 0;
    IsobarCameraProject(cam, -1, 1.5, &x, &y);
    double kept = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    double evicted = [r pickValueAtX:x y:y camera:cam time:1 kind:IsobarFieldPressure];
    double newest = [r pickValueAtX:x y:y camera:cam time:3 kind:IsobarFieldPressure];
    check(fabs(kept - 1000) < 1e-3, @"refreshed step 0 stays resident");
    check(isnan(evicted), @"the least recently used step is evicted");
    check(fabs(newest - 5000) < 1e-3, @"the newest step is resident");
    NSUInteger before = r.residentBytes;
    for (int i = 0; i < n; i++) v[i] = 22;
    r.residentByteBudget = before + (NSUInteger)n * sizeof(float);
    check(Upload(r, 0, IsobarFieldTemperature, v), @"temperature uploads without a CPU copy");
    check(r.residentBytes == before + (NSUInteger)n * sizeof(float), @"temperature counts the texture only");
    double temp = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldTemperature];
    check(fabs(temp - 22) < 1e-2, [NSString stringWithFormat:@"temperature is read from the texture (%.3f)", temp]);
    r.pixelsPerPoint = 2;
    check(fabs(r.contentScale - 2) < 1e-9 && fabs(r.pixelsPerPoint - 2) < 1e-9, @"pixelsPerPoint is the pixel scale");
    r.pixelsPerPoint = 1;
    free(v);
}

static BOOL NearCrop(double lat, double lon, double west, double east, double south, double north, double margin) {
    double L = lon;
    while (L < west - 180) L += 360;
    while (L > east + 180) L -= 360;
    return lat <= north + margin && lat >= south - margin && L >= west - margin && L <= east + margin;
}

// The crop straddles the camera antimeridian when the centre is near -45,
// so one screen bounding box covers the whole viewport. A fill pixel has to
// unproject into the geographic crop.
static void TestSmear(IsobarFieldRenderer *r) {
    const int nLon = 301, nLat = 201;
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = nLon, .nLat = nLat, .wrapsLongitude = NO};
    [r setGrid:g];
    float *v = malloc(sizeof(float) * (size_t)nLon * (size_t)nLat);
    check(v != NULL, @"smear field allocates");
    if (!v) return;
    for (int i = 0; i < nLon * nLat; i++) v[i] = 1013;
    check(Upload(r, 0, IsobarFieldPressure, v), @"smear field uploads");
    free(v);
    double east = 95 + (nLon - 1) * 0.25;
    double south = 0 - (nLat - 1) * 0.25;
    double centres[] = {-45, 135 + 180};
    OwnRGB land = OwnChartLand();
    IsobarRGB fill = {land.r, land.g, land.b};
    for (int c = 0; c < 2; c++) {
        IsobarCamera cam = Cam(-25, centres[c], 1, 0, 720, 360);
        int finite = 0, badPos = 0;
        for (double lat = south; lat <= 0.01; lat += 2) {
            for (double lon = 95; lon <= east + 0.01; lon += 2) {
                double x = NAN, y = NAN;
                BOOL vis = IsobarCameraProject(cam, lat, lon, &x, &y);
                finite++;
                if (!vis || !isfinite(x) || !isfinite(y)) badPos++;
            }
        }
        check(finite > 100 && badPos == 0,
            [NSString stringWithFormat:@"centre %.0f crop positions are finite (%d bad of %d)", centres[c], badPos, finite]);
        CGImageRef image = Render(r, 0, IsobarFieldPressure, NO, cam);
        Image im = {0};
        check(image && ImageFrom(image, &im), @"smear frame renders");
        CGImageRelease(image);
        if (!im.px) continue;
        int cr, cg, cb;
        At(im, im.w / 2, im.h / 2, &cr, &cg, &cb);
        check(!NearRGB(cr, cg, cb, fill, 2),
            [NSString stringWithFormat:@"centre %.0f viewport centre is not the crop fill (%d %d %d)", centres[c], cr, cg, cb]);
        int fillPx = 0, stray = 0;
        for (int y = 0; y < im.h; y++) {
            for (int x = 0; x < im.w; x++) {
                int pr, pg, pb;
                At(im, x, y, &pr, &pg, &pb);
                if (!NearRGB(pr, pg, pb, fill, 2)) continue;
                fillPx++;
                double lat = 0, lon = 0;
                if (!IsobarCameraUnproject(cam, x + 0.5, y + 0.5, &lat, &lon) ||
                    !NearCrop(lat, lon, 95, east, south, 0, 2.0)) stray++;
            }
        }
        check(fillPx > 100 && stray == 0,
            [NSString stringWithFormat:@"centre %.0f fill stays in the crop (%d fill, %d stray)", centres[c], fillPx, stray]);
        ImageFree(&im);
    }
}

static void TestVisibility(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = -180, .north = 90, .step = 2, .nLon = 180, .nLat = 91, .wrapsLongitude = YES};
    [r setGrid:g];
    float *v = malloc(sizeof(float) * (size_t)g.nLon * (size_t)g.nLat);
    check(v != NULL, @"visibility field allocates");
    if (!v) return;
    for (int i = 0; i < g.nLon * g.nLat; i++) v[i] = 1010;
    check(Upload(r, 0, IsobarFieldPressure, v), @"visibility field uploads");
    free(v);
    double globes[] = {0.3, 0.5, 0.7, 1.0};
    for (int gi = 0; gi < 4; gi++) {
        IsobarCamera cam = Cam(-20, 135, 1.6, globes[gi], 360, 360);
        int hit = 0, bad = 0;
        double worst = 0;
        for (int y = 8; y < 352; y += 16) {
            for (int x = 8; x < 352; x += 16) {
                double lat = 0, lon = 0;
                if (![r pickLatitude:&lat longitude:&lon atX:x + 0.5 y:y + 0.5 camera:cam]) continue;
                double px = NAN, py = NAN;
                BOOL vis = IsobarCameraProject(cam, lat, lon, &px, &py);
                double err = hypot(px - (x + 0.5), py - (y + 0.5));
                if (!vis || !isfinite(px) || !isfinite(py) || err > 1.0) {
                    bad++;
                    if (isfinite(err) && err > worst) worst = err;
                    if (!isfinite(err)) worst = 1e9;
                } else {
                    hit++;
                }
            }
        }
        check(hit >= 30 && bad == 0,
            [NSString stringWithFormat:@"globe %.1f pick round-trips (%d hit, %d bad, worst %.2f px)",
                globes[gi], hit, bad, worst]);
    }
}

static void TestTiltedMetalPick(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = -180, .north = 90, .step = 1, .nLon = 360, .nLat = 181, .wrapsLongitude = YES};
    [r setGrid:g];
    size_t count = (size_t)g.nLon * (size_t)g.nLat;
    float *values = malloc(sizeof(float) * count);
    if (!values) { check(NO, @"tilted pick field allocates"); return; }
    for (size_t i = 0; i < count; i++) values[i] = 1000;
    check(Upload(r, 0, IsobarFieldPressure, values), @"tilted pick field uploads");
    free(values);
    struct { double lat, lon, zoom, pitch; const char *name; } cameras[] = {
        {-31.95, 115.86, 2, .1, "Perth world"},
        {-31.95, 115.86, 16, .6, "Perth local"},
        {-33.87, 151.21, 2, 1.3, "Sydney world"},
        {-33.87, 151.21, 16, .6, "Sydney local"},
        {0, 179, 2, .6, "dateline"},
        {12, -45, 1, 1.3, "global"},
    };
    for (NSUInteger ci = 0; ci < sizeof(cameras) / sizeof(cameras[0]); ci++) {
        IsobarCamera cam = Cam(cameras[ci].lat, cameras[ci].lon, cameras[ci].zoom, 1, 640, 420);
        cam.pitch = cameras[ci].pitch;
        double points[][2] = {
            {cam.centreLat, cam.centreLon},
            {cam.centreLat + .8, cam.centreLon + .9},
            {cam.centreLat - .7, cam.centreLon - .8},
        };
        int hits = 0;
        for (NSUInteger pi = 0; pi < sizeof(points) / sizeof(points[0]); pi++) {
            double x = 0, y = 0;
            if (!IsobarCameraProject(cam, points[pi][0], points[pi][1], &x, &y)) continue;
            double lat = 0, lon = 0;
            BOOL picked = [r pickLatitude:&lat longitude:&lon atX:x y:y camera:cam];
            // GPU picking samples the pixel centre, not the fractional cursor.
            double expectedLat=0,expectedLon=0;
            BOOL ray=IsobarCameraUnproject(cam,floor(x)+.5,floor(y)+.5,&expectedLat,&expectedLon);
            double geoError = picked && ray ? hypot(lat - expectedLat, LonErr(lon, expectedLon)) : INFINITY;
            double pickedX = 0, pickedY = 0;
            BOOL reproj = picked && IsobarCameraProject(cam, lat, lon, &pickedX, &pickedY);
            double pixelError = reproj ? hypot(pickedX - x, pickedY - y) : INFINITY;
            double geoTolerance = .1;
            check(reproj && pixelError < 2.0 && geoError < geoTolerance,
                [NSString stringWithFormat:@"%s tilted GPU pick follows CPU point %.1f (%.2f px %.3f deg)", cameras[ci].name, cam.pitch, pixelError, geoError]);
            if (reproj && pixelError < 2.0 && geoError < geoTolerance) hits++;
        }
        check(hits >= 2, [NSString stringWithFormat:@"%s keeps front points pickable", cameras[ci].name]);
        double backLat = -cam.centreLat, backLon = cam.centreLon + 180;
        double bx = 0, by = 0;
        BOOL backVisible = IsobarCameraProject(cam, backLat, backLon, &bx, &by);
        if (!backVisible) {
            double pickedLat = 0, pickedLon = 0;
            BOOL picked = [r pickLatitude:&pickedLat longitude:&pickedLon atX:bx y:by camera:cam];
            double hiddenError = picked ? hypot(pickedLat - backLat, LonErr(pickedLon, backLon)) : INFINITY;
            check(!picked || hiddenError > 1.0, [NSString stringWithFormat:@"%s does not report the hidden backside point (%.2f deg away)", cameras[ci].name, hiddenError]);
        }
    }
}

static void TestWeakGradient(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = -40, .north = 8, .step = 1, .nLon = 81, .nLat = 17, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        for (int col = 0; col < g.nLon; col++) {
            double lon = g.west + col * g.step;
            v[row * g.nLon + col] = (float)(1000.0 + 0.1 * lon);
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"weak gradient uploads");
    free(v);
    IsobarCamera cam = Cam(0, 0, 64, 0, 400, 300);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"weak gradient frame renders");
    CGImageRelease(image);
    check(r.contourLineCount > 0, @"weak gradient still has an isobar");
    double x = 0, y = 0;
    IsobarCameraProject(cam, 0, 0, &x, &y);
    int dark = 0;
    if (im.px) {
        int cx = (int)llround(x), cy = (int)llround(y);
        for (int dy = -40; dy <= 40; dy++) {
            for (int dx = -6; dx <= 6; dx++) {
                int pr, pg, pb;
                At(im, cx + dx, cy + dy, &pr, &pg, &pb);
                if (pr >= 0 && Lum(pr, pg, pb) < 90) dark++;
            }
        }
    }
    check(dark > 8, [NSString stringWithFormat:@"0.1 hPa/deg isobar is drawn at zoom 64 (%d dark px)", dark]);
    ImageFree(&im);
}

typedef struct { double x, y; } ScreenPt;

static int CopyContour(IsobarFieldRenderer *r, IsobarCamera cam, ScreenPt **out) {
    int n = 0;
    for (NSInteger i = 0; i < r.contourLineCount; i++) n += (int)[r contourVertexCountForLine:i];
    ScreenPt *pts = n ? calloc((size_t)n, sizeof(ScreenPt)) : NULL;
    int k = 0;
    for (NSInteger i = 0; i < r.contourLineCount; i++) {
        NSInteger count = [r contourVertexCountForLine:i];
        for (NSInteger p = 0; p < count; p++) {
            double lat = 0, lon = 0, x = 0, y = 0;
            if (![r contourVertexForLine:i index:p latitude:&lat longitude:&lon]) continue;
            IsobarCameraProject(cam, lat, lon, &x, &y);
            if (!pts || !isfinite(x) || !isfinite(y)) continue;
            pts[k++] = (ScreenPt){x, y};
        }
    }
    *out = pts;
    return k;
}

static double Farthest(const ScreenPt *a, int na, const ScreenPt *b, int nb) {
    double worst = 0;
    for (int i = 0; i < na; i++) {
        double best = 1e9;
        for (int j = 0; j < nb; j++) {
            double d = hypot(a[i].x - b[j].x, a[i].y - b[j].y);
            if (d < best) best = d;
        }
        if (best > worst) worst = best;
    }
    return worst;
}

static void TestStability(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = 100, .north = -10, .step = 1, .nLon = 41, .nLat = 21, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    float *b = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        for (int col = 0; col < g.nLon; col++) {
            double lon = g.west + col * g.step;
            // Stays clear of a 4 hPa level at both ends, so one frame cannot
            // create or drop an isobar. The 1000 hPa line sits between nodes.
            float base = (float)(1002.2 + 0.25 * (lon - 120.0));
            a[row * g.nLon + col] = base;
            b[row * g.nLon + col] = base + 0.3f;
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, a) && Upload(r, 1, IsobarFieldPressure, b), @"stability steps upload");
    free(a);
    free(b);
    IsobarCamera cam = Cam(-20, 112, 4, 0, 480, 320);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    ScreenPt *first = NULL;
    int n0 = CopyContour(r, cam, &first);
    double dt = 1.0 / 675.0;
    image = Render(r, dt, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    ScreenPt *second = NULL;
    int n1 = CopyContour(r, cam, &second);
    double worst = fmax(Farthest(first, n0, second, n1), Farthest(second, n1, first, n0));
    check(n0 >= 10 && n1 >= 10 && worst < 0.5,
        [NSString stringWithFormat:@"one 8× frame moves contour vertices %.3f px (%d, %d verts)", worst, n0, n1]);
    free(first);
    free(second);
}

static float DecodeF16(uint16_t bits) {
    int sign = bits >> 15;
    int exp = (bits >> 10) & 31;
    int frac = bits & 1023;
    float value;
    if (exp == 31) value = NAN;
    else if (exp == 0) value = ldexpf((float)frac, -24);
    else value = ldexpf(1.0f + (float)frac / 1024.0f, exp - 15);
    return sign ? -value : value;
}

static void AccumulateTurn(const double *lon, const double *lat, int n, int closed,
    double *turn, double *length, int *lines) {
    if (n < 3) return;
    int segN = closed ? n : n - 1;
    double len = 0;
    for (int i = 0; i < segN; i++) {
        int j = closed ? (i + 1) % n : i + 1;
        double dlon = lon[j] - lon[i];
        if (dlon > 180) dlon -= 360;
        if (dlon < -180) dlon += 360;
        len += hypot(dlon, lat[j] - lat[i]);
    }
    if (len < 8.0) return;
    double t = 0;
    int corners = closed ? n : n - 2;
    for (int k = 0; k < corners; k++) {
        int i = closed ? k : k + 1;
        int prev = closed ? (i - 1 + n) % n : i - 1;
        int next = closed ? (i + 1) % n : i + 1;
        double ax = lon[i] - lon[prev], ay = lat[i] - lat[prev];
        double bx = lon[next] - lon[i], by = lat[next] - lat[i];
        if (ax > 180) ax -= 360;
        if (ax < -180) ax += 360;
        if (bx > 180) bx -= 360;
        if (bx < -180) bx += 360;
        double la = hypot(ax, ay), lb = hypot(bx, by);
        if (la < 1e-6 || lb < 1e-6) continue;
        t += fabs(atan2(ax * by - ay * bx, ax * bx + ay * by));
    }
    *turn += t;
    *length += len;
    (*lines)++;
}

static double Jagged(const double *lon, const double *lat, const int *counts, const int *closed, int nLines) {
    double turn = 0, length = 0;
    int lines = 0, cursor = 0;
    for (int i = 0; i < nLines; i++) {
        AccumulateTurn(lon + cursor, lat + cursor, counts[i], closed[i], &turn, &length, &lines);
        cursor += counts[i];
    }
    if (lines < 1 || length < 8) return 99;
    return turn / length;
}

static void TestFixture(IsobarFieldRenderer *r) {
    NSString *dir = @"Tests/fixtures/fieldrender";
    NSFileManager *fm = [NSFileManager defaultManager];
    NSArray *names = [fm contentsOfDirectoryAtPath:dir error:nil];
    unsigned long long bytes = 0;
    for (NSString *name in names) {
        NSString *path = [dir stringByAppendingPathComponent:name];
        BOOL folder = NO;
        if ([fm fileExistsAtPath:path isDirectory:&folder] && !folder)
            bytes += [[fm attributesOfItemAtPath:path error:nil] fileSize];
    }
    check(bytes > 0 && bytes <= 64 * 1024,
        [NSString stringWithFormat:@"fixture is %llu bytes", bytes]);
    NSData *headerData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"header.json"]];
    NSDictionary *header = [NSJSONSerialization JSONObjectWithData:headerData options:0 error:nil];
    NSString *credit = header[@"attribution"];
    check([credit containsString:@"CC BY 4.0"], @"fixture credits ECMWF CC BY 4.0");
    NSDictionary *grid = header[@"grid"];
    IsobarGeoGrid g = {
        .west = [grid[@"west"] doubleValue],
        .north = [grid[@"north"] doubleValue],
        .step = [grid[@"step"] doubleValue],
        .nLon = [grid[@"nLon"] intValue],
        .nLat = [grid[@"nLat"] intValue],
        .wrapsLongitude = NO
    };
    NSString *file0 = header[@"steps"][0][@"file"];
    NSData *raw = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:file0]];
    int n = g.nLon * g.nLat;
    check(raw.length == (NSUInteger)n * 2 && g.nLon == 120 && g.nLat == 80, @"fixture is 120×80 float16");
    if (raw.length != (NSUInteger)n * 2) return;
    float *values = malloc(sizeof(float) * (size_t)n);
    double *plain = malloc(sizeof(double) * (size_t)n);
    const uint8_t *bytesIn = raw.bytes;
    double lo = 0, hi = 0;
    BOOL any = NO;
    for (int i = 0; i < n; i++) {
        uint16_t bits = (uint16_t)(bytesIn[i * 2] | (bytesIn[i * 2 + 1] << 8));
        float sample = DecodeF16(bits);
        values[i] = isfinite(sample) ? sample : NAN;
        plain[i] = values[i];
        if (!isfinite(plain[i])) continue;
        if (!any || plain[i] < lo) lo = plain[i];
        if (!any || plain[i] > hi) hi = plain[i];
        any = YES;
    }
    double levels[64];
    int nLevels = OwnInteriorLevels(lo, hi, 4, levels, 64);
    OwnLineSet rawLines = OwnContours(plain, g.nLon, g.nLat, g.west, g.north, g.step, -g.step, levels, nLevels);
    OwnPruneContours(&rawLines, 1.2, 0.45, 0);
    int rawVerts = 0;
    for (int i = 0; i < rawLines.count; i++) rawVerts += rawLines.lines[i].count;
    double *rawLon = calloc((size_t)rawVerts, sizeof(double));
    double *rawLat = calloc((size_t)rawVerts, sizeof(double));
    int *rawCount = calloc((size_t)rawLines.count, sizeof(int));
    int *rawClosed = calloc((size_t)rawLines.count, sizeof(int));
    int cursor = 0;
    for (int i = 0; i < rawLines.count; i++) {
        rawCount[i] = rawLines.lines[i].count;
        rawClosed[i] = rawLines.lines[i].closed;
        for (int p = 0; p < rawLines.lines[i].count; p++) {
            rawLon[cursor] = rawLines.lines[i].pts[p].x;
            rawLat[cursor] = rawLines.lines[i].pts[p].y;
            cursor++;
        }
    }
    double rawJag = Jagged(rawLon, rawLat, rawCount, rawClosed, rawLines.count);
    OwnLineSetFree(rawLines);
    free(rawLon);
    free(rawLat);
    free(rawCount);
    free(rawClosed);
    free(plain);

    [r setGrid:g];
    check(Upload(r, 0, IsobarFieldPressure, values), @"fixture uploads");
    free(values);
    double centreLat = g.north - (g.nLat - 1) * g.step * 0.5;
    double centreLon = g.west + (g.nLon - 1) * g.step * 0.5;
    IsobarCamera cam = Cam(centreLat, centreLon, 6, 0, 480, 360);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    check(image != NULL, @"fixture frame renders");
    CGImageRelease(image);
    int smoothVerts = 0;
    for (NSInteger i = 0; i < r.contourLineCount; i++) smoothVerts += (int)[r contourVertexCountForLine:i];
    double *smoothLon = calloc((size_t)smoothVerts + 1, sizeof(double));
    double *smoothLat = calloc((size_t)smoothVerts + 1, sizeof(double));
    int *smoothCount = calloc((size_t)r.contourLineCount + 1, sizeof(int));
    int *smoothClosed = calloc((size_t)r.contourLineCount + 1, sizeof(int));
    cursor = 0;
    for (NSInteger i = 0; i < r.contourLineCount; i++) {
        int count = (int)[r contourVertexCountForLine:i];
        smoothCount[i] = count;
        smoothClosed[i] = [r contourLineIsClosed:i] ? 1 : 0;
        for (int p = 0; p < count; p++) {
            double lat = 0, lon = 0;
            [r contourVertexForLine:i index:p latitude:&lat longitude:&lon];
            smoothLon[cursor] = lon;
            smoothLat[cursor] = lat;
            cursor++;
        }
    }
    double smoothJag = Jagged(smoothLon, smoothLat, smoothCount, smoothClosed, (int)r.contourLineCount);
    free(smoothLon);
    free(smoothLat);
    free(smoothCount);
    free(smoothClosed);
    fprintf(stderr, "fixture jagged raw %.3f smooth %.3f\n", rawJag, smoothJag);
    check(r.contourLineCount > 0 && smoothJag < 0.45 && rawJag >= 0.45,
        [NSString stringWithFormat:@"smoothed isobars are calmer than the raw field (%.3f vs %.3f)", smoothJag, rawJag]);
}

static BOOL RectOverlap(double x0, double y0, double hw0, double hh0,
    double x1, double y1, double hw1, double hh1) {
    return fabs(x0 - x1) < hw0 + hw1 - 0.5 && fabs(y0 - y1) < hh0 + hh1 - 0.5;
}

static double SegDist(double px, double py, double ax, double ay, double bx, double by) {
    double dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    double t = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return hypot(px - (ax + t * dx), py - (ay + t * dy));
}

static BOOL LoadF16(NSString *path, float *values, int n) {
    NSData *raw = [NSData dataWithContentsOfFile:path];
    if (raw.length != (NSUInteger)n * 2) return NO;
    const uint8_t *bytesIn = raw.bytes;
    for (int i = 0; i < n; i++) {
        uint16_t bits = (uint16_t)(bytesIn[i * 2] | (bytesIn[i * 2 + 1] << 8));
        float sample = DecodeF16(bits);
        values[i] = isfinite(sample) ? sample : NAN;
    }
    return YES;
}

static void CheckLabels(IsobarFieldRenderer *r, IsobarCamera cam, IsobarGeoGrid g, const char *what) {
    NSInteger n = r.labelCount;
    double xs[80], ys[80], angs[80], levels[80], hws[80], hhs[80];
    if (n > 80) n = 80;
    int badAngle = 0, outside = 0, hidden = 0, plate = 0, overlap = 0, close = 0;
    double south = g.north - (g.nLat - 1) * g.step;
    double east = g.west + (g.nLon - 1) * g.step;
    for (NSInteger i = 0; i < n; i++) {
        [r labelAtIndex:i x:&xs[i] y:&ys[i] angle:&angs[i] level:&levels[i] halfW:&hws[i] halfH:&hhs[i]];
        if (!(angs[i] > -M_PI_2 - 1e-6 && angs[i] <= M_PI_2 + 1e-6)) badAngle++;
        if (xs[i] - hws[i] < -0.5 || ys[i] - hhs[i] < -0.5
            || xs[i] + hws[i] > cam.viewportW + 0.5 || ys[i] + hhs[i] > cam.viewportH + 0.5) outside++;
        double lat = 0, lon = 0;
        BOOL front = IsobarCameraUnproject(cam, xs[i], ys[i], &lat, &lon)
            && IsobarCameraProject(cam, lat, lon, NULL, NULL);
        if (!front) hidden++;
        BOOL onGrid = lat <= g.north + 0.05 && lat >= south - 0.05 && LonErr(lon, (g.west + east) * 0.5) <= (east - g.west) * 0.5 + 0.2;
        if (!onGrid) plate++;
        for (NSInteger k = 0; k < i; k++) {
            if (fabs(levels[i] - levels[k]) < 0.1 && RectOverlap(xs[i], ys[i], hws[i], hhs[i], xs[k], ys[k], hws[k], hhs[k]))
                overlap++;
            double gap = hypot(xs[i] - xs[k], ys[i] - ys[k]);
            double width = 2.0 * fmax(hws[i], hws[k]);
            double need = fmax(3.0 * width, width + 24.0);
            if (gap < need - 0.5) close++;
        }
    }
    int centreHit = 0;
    for (NSInteger c = 0; c < r.centreCount; c++) {
        double cx = 0, cy = 0, value = 0;
        BOOL high = NO;
        [r centreAtIndex:c x:&cx y:&cy value:&value high:&high];
        for (NSInteger i = 0; i < n; i++) {
            if (RectOverlap(xs[i], ys[i], hws[i], hhs[i], cx, cy - 2, 14, 26)) centreHit++;
        }
    }
    check(badAngle == 0 && outside == 0 && hidden == 0 && plate == 0 && overlap == 0 && centreHit == 0 && close == 0,
        [NSString stringWithFormat:@"%s labels upright, inside, separated (%ld labels, angle %d out %d hid %d plate %d overlap %d close %d centres %d)",
            what, (long)r.labelCount, badAngle, outside, hidden, plate, overlap, close, centreHit]);
}

static void TestAnnotations(IsobarFieldRenderer *r) {
    NSString *dir = @"Tests/fixtures/fieldrender";
    NSData *headerData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"header.json"]];
    NSDictionary *header = [NSJSONSerialization JSONObjectWithData:headerData options:0 error:nil];
    NSDictionary *grid = header[@"grid"];
    IsobarGeoGrid g = {
        .west = [grid[@"west"] doubleValue], .north = [grid[@"north"] doubleValue],
        .step = [grid[@"step"] doubleValue], .nLon = [grid[@"nLon"] intValue],
        .nLat = [grid[@"nLat"] intValue], .wrapsLongitude = NO
    };
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    float *b = malloc(sizeof(float) * (size_t)n);
    NSString *file0 = header[@"steps"][0][@"file"];
    NSString *file1 = header[@"steps"][1][@"file"];
    check(a && b && LoadF16([dir stringByAppendingPathComponent:file0], a, n)
        && LoadF16([dir stringByAppendingPathComponent:file1], b, n), @"label fixture loads");
    if (!a || !b) { free(a); free(b); return; }
    [r setGrid:g];
    r.motion = nil;
    r.contentScale = 1;
    check(Upload(r, 0, IsobarFieldPressure, a) && Upload(r, 1, IsobarFieldPressure, b), @"label fixture uploads");
    free(a);
    free(b);
    double centreLat = g.north - (g.nLat - 1) * g.step * 0.5;
    double centreLon = g.west + (g.nLon - 1) * g.step * 0.5;
    IsobarCamera cam = Cam(centreLat, centreLon, 6, 0, 480, 360);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    check(image != NULL && r.labelCount > 0, [NSString stringWithFormat:@"fixture draws %ld labels", (long)r.labelCount]);
    CGImageRelease(image);
    CheckLabels(r, cam, g, "fixture");

    IsobarCamera limb = Cam(-40, 62, 1.7, 1, 640, 640);
    image = Render(r, 0, IsobarFieldPressure, YES, limb);
    check(image != NULL, @"limb frame renders");
    CGImageRelease(image);
    check(r.labelCount > 0, [NSString stringWithFormat:@"limb still has %ld labels (%ld contours)",
        (long)r.labelCount, (long)r.contourLineCount]);
    CheckLabels(r, limb, g, "limb");

    r.motion = [IsobarFieldMotion new];
    double dt = 8.0 / 60.0 / 180.0;
    BOOL drew = YES;
    for (int i = 0; i < 60; i++) {
        image = Render(r, i * dt, IsobarFieldPressure, YES, cam);
        if (!image) drew = NO;
        CGImageRelease(image);
    }
    check(drew && r.labelCount > 0, @"sixty 8× frames rendered");
    check(r.motion.maxLabelStep < 2 && r.motion.labelSetChanges == 0,
        [NSString stringWithFormat:@"labels slide (max step %.3f px, set changes %ld, alpha step %.3f)",
            r.motion.maxLabelStep, (long)r.motion.labelSetChanges, r.motion.maxAnnotationAlphaStep]);

    r.motion = [IsobarFieldMotion new];
    image = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    enum { kPan = 8, kHold = 40 };
    double prevX[kHold], prevY[kHold], prevL[kHold];
    int nPrev = (int)r.labelCount;
    if (nPrev > kHold) nPrev = kHold;
    for (int i = 0; i < nPrev; i++)
        [r labelAtIndex:i x:&prevX[i] y:&prevY[i] angle:NULL level:&prevL[i] halfW:NULL halfH:NULL];
    double px = cam.zoom * fmin(cam.viewportW / 360.0, cam.viewportH / 180.0);
    double dLon = 1.0 / (px * cos(cam.centreLat * M_PI / 180.0));
    double sum = 0;
    int nMoved = 0;
    double worst = 0;
    for (int frame = 0; frame < kPan; frame++) {
        cam.centreLon += dLon;
        image = Render(r, 0, IsobarFieldPressure, YES, cam);
        CGImageRelease(image);
        int nNow = (int)r.labelCount;
        if (nNow > kHold) nNow = kHold;
        double nowX[kHold], nowY[kHold], nowL[kHold];
        for (int i = 0; i < nNow; i++)
            [r labelAtIndex:i x:&nowX[i] y:&nowY[i] angle:NULL level:&nowL[i] halfW:NULL halfH:NULL];
        for (int i = 0; i < nNow; i++) {
            int best = -1;
            double bd = 8;
            for (int k = 0; k < nPrev; k++) {
                if (fabs(prevL[k] - nowL[i]) > 0.1) continue;
                double d = hypot(prevX[k] - nowX[i], prevY[k] - nowY[i]);
                if (d < bd) { bd = d; best = k; }
            }
            if (best < 0) continue;
            if (bd > worst) worst = bd;
            sum += bd;
            nMoved++;
        }
        nPrev = nNow;
        memcpy(prevX, nowX, sizeof nowX);
        memcpy(prevY, nowY, sizeof nowY);
        memcpy(prevL, nowL, sizeof nowL);
    }
    double mean = nMoved ? sum / nMoved : 0;
    check(nMoved >= kPan && mean > 0.75 && mean < 1.35,
        [NSString stringWithFormat:@"1 px pan moves labels by %.3f px (worst %.3f, %d samples)", mean, worst, nMoved]);
    r.motion = nil;

    r.pressureSmoothDegrees = 0;
    IsobarGeoGrid lowGrid = {.west = 110, .north = -20, .step = 1, .nLon = 21, .nLat = 21, .wrapsLongitude = NO};
    [r setGrid:lowGrid];
    int ln = lowGrid.nLon * lowGrid.nLat;
    float *field = malloc(sizeof(float) * (size_t)ln);
    for (int i = 0; i < ln; i++) field[i] = 1016;
    int lowCol = 10, lowRow = 10;
    field[lowRow * lowGrid.nLon + lowCol] = 980;
    double lowLat = lowGrid.north - lowRow * lowGrid.step;
    double lowLon = lowGrid.west + lowCol * lowGrid.step;
    check(Upload(r, 0, IsobarFieldPressure, field), @"synthetic low uploads");
    free(field);
    IsobarCamera lowCam = Cam(lowLat, lowLon, 8, 0, 420, 420);
    image = Render(r, 0, IsobarFieldPressure, YES, lowCam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"synthetic low renders");
    CGImageRelease(image);
    double expectX = 0, expectY = 0;
    IsobarCameraProject(lowCam, lowLat, lowLon, &expectX, &expectY);
    int lows = 0, highs = 0;
    double foundX = 0, foundY = 0, foundV = 0;
    for (NSInteger i = 0; i < r.centreCount; i++) {
        double cx = 0, cy = 0, value = 0;
        BOOL high = NO;
        [r centreAtIndex:i x:&cx y:&cy value:&value high:&high];
        if (high) { highs++; continue; }
        if (hypot(cx - expectX, cy - expectY) < 4) {
            lows++;
            foundX = cx;
            foundY = cy;
            foundV = value;
        }
    }
    check(lows == 1 && fabs(foundV - 980) < 0.6,
        [NSString stringWithFormat:@"one L at the low (count %d, highs %d, value %.2f, err %.2f px)",
            lows, highs, foundV, hypot(foundX - expectX, foundY - expectY)]);
    int letter = 0, digits = 0;
    if (im.px && lows == 1) {
        int cx = Pix(foundX), cy = Pix(foundY);
        for (int dy = -20; dy <= -8; dy++) {
            for (int dx = -10; dx <= 10; dx++) {
                int pr, pg, pb;
                At(im, cx + dx, cy + dy, &pr, &pg, &pb);
                if (pr >= 0 && Lum(pr, pg, pb) < 80) letter++;
            }
        }
        for (int dy = 8; dy <= 24; dy++) {
            for (int dx = -16; dx <= 16; dx++) {
                int pr, pg, pb;
                At(im, cx + dx, cy + dy, &pr, &pg, &pb);
                if (pr >= 0 && Lum(pr, pg, pb) < 80) digits++;
            }
        }
    }
    check(letter > 8 && digits > 8,
        [NSString stringWithFormat:@"L and its value are drawn (%d letter px, %d value px)", letter, digits]);
    ImageFree(&im);

    IsobarGeoGrid seam = {.west = 0, .north = 60, .step = 5, .nLon = 72, .nLat = 25, .wrapsLongitude = YES};
    [r setGrid:seam];
    int sn = seam.nLon * seam.nLat;
    field = malloc(sizeof(float) * (size_t)sn);
    for (int row = 0; row < seam.nLat; row++) {
        double lat = seam.north - row * seam.step;
        for (int col = 0; col < seam.nLon; col++) {
            double lon = seam.west + col * seam.step;
            double dlon = LonErr(lon, 0);
            double d = hypot(lat + 20, dlon);
            field[row * seam.nLon + col] = (float)(1016 - 28 * exp(-0.5 * d * d / (8 * 8)));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, field), @"dateline low uploads");
    free(field);
    IsobarCamera seamCam = Cam(-20, 0, 4, 0, 480, 360);
    image = Render(r, 0, IsobarFieldPressure, YES, seamCam);
    check(image != NULL, @"dateline low renders");
    CGImageRelease(image);
    int seamLows = 0;
    for (NSInteger i = 0; i < r.centreCount; i++) {
        double cx = 0, cy = 0, value = 0;
        BOOL high = NO;
        if (![r centreAtIndex:i x:&cx y:&cy value:&value high:&high] || high) continue;
        double lat = 0, lon = 0;
        if (!IsobarCameraUnproject(seamCam, cx, cy, &lat, &lon)) continue;
        if (fabs(lat + 20) < 4 && LonErr(lon, 0) < 8) seamLows++;
    }
    check(seamLows == 1, [NSString stringWithFormat:@"dateline low is found once (%d)", seamLows]);

    r.pressureSmoothDegrees = 0.3125;
    IsobarGeoGrid crop = {.west = 100, .north = -10, .step = 2, .nLon = 11, .nLat = 11, .wrapsLongitude = NO};
    [r setGrid:crop];
    int cn = crop.nLon * crop.nLat;
    field = malloc(sizeof(float) * (size_t)cn);
    for (int i = 0; i < cn; i++) field[i] = 1013;
    check(Upload(r, 0, IsobarFieldPressure, field), @"coverage field uploads");
    free(field);
    IsobarCamera edgeCam = Cam(-20, 110, 2, 0, 640, 480);
    image = Render(r, 0, IsobarFieldPressure, YES, edgeCam);
    check(image && ImageFrom(image, &im), @"coverage frame renders");
    CGImageRelease(image);
    double south = crop.north - (crop.nLat - 1) * crop.step;
    double east = crop.west + (crop.nLon - 1) * crop.step;
    double corners[4][2] = {{-10, 100}, {-10, east}, {south, east}, {south, 100}};
    double ex[4], ey[4];
    for (int i = 0; i < 4; i++) IsobarCameraProject(edgeCam, corners[i][0], corners[i][1], &ex[i], &ey[i]);
    IsobarRGB edge = IsobarCoverageEdgeColour();
    int edgePx = 0, stray = 0;
    if (im.px) {
        for (int y = 0; y < im.h; y++) {
            for (int x = 0; x < im.w; x++) {
                int pr, pg, pb;
                At(im, x, y, &pr, &pg, &pb);
                if (!NearRGB(pr, pg, pb, edge, 8)) continue;
                double d = 1e9;
                for (int e = 0; e < 4; e++) {
                    int n = (e + 1) % 4;
                    double dist = SegDist(x + 0.5, y + 0.5, ex[e], ey[e], ex[n], ey[n]);
                    if (dist < d) d = dist;
                }
                edgePx++;
                if (d > 2.5) stray++;
            }
        }
    }
    check(edgePx > 40 && stray == 0,
        [NSString stringWithFormat:@"coverage hairline follows the crop (%d px, %d stray)", edgePx, stray]);
    ImageFree(&im);

    IsobarGeoGrid globe = {.west = 0, .north = 90, .step = 10, .nLon = 36, .nLat = 19, .wrapsLongitude = YES};
    [r setGrid:globe];
    int gn = globe.nLon * globe.nLat;
    field = malloc(sizeof(float) * (size_t)gn);
    for (int i = 0; i < gn; i++) field[i] = 1013;
    check(Upload(r, 0, IsobarFieldPressure, field), @"full-sphere field uploads");
    free(field);
    image = Render(r, 0, IsobarFieldPressure, NO, Cam(0, 20, 1.2, 0, 360, 240));
    check(image && ImageFrom(image, &im), @"full sphere renders");
    CGImageRelease(image);
    int globeEdge = 0;
    if (im.px) {
        for (int y = 0; y < im.h; y++) {
            for (int x = 0; x < im.w; x++) {
                int pr, pg, pb;
                At(im, x, y, &pr, &pg, &pb);
                if (NearRGB(pr, pg, pb, edge, 8)) globeEdge++;
            }
        }
    }
    check(globeEdge == 0, [NSString stringWithFormat:@"a pole-to-pole wrap has no coverage edge (%d)", globeEdge]);
    ImageFree(&im);
    r.motion = nil;
}

static void TimeRender(IsobarFieldRenderer *r, IsobarCamera cam, const char *label, BOOL limit) {
    CGImageRef warm = Render(r, 0, IsobarFieldPressure, NO, cam);
    CGImageRelease(warm);
    struct timespec a, b;
    clock_gettime(CLOCK_UPTIME_RAW, &a);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    clock_gettime(CLOCK_UPTIME_RAW, &b);
    double wall = (b.tv_sec - a.tv_sec) * 1000.0 + (b.tv_nsec - a.tv_nsec) / 1e6;
    double contour = r.lastContourMilliseconds;
    double labels = r.lastLabelMilliseconds;
    double gpu = r.lastGpuMilliseconds;
    fprintf(stderr, "%s contour_ms %.2f label_ms %.2f gpu_ms %.2f total_ms %.2f wall_ms %.2f\n",
        label, contour, labels, gpu, contour + labels + gpu, wall);
    check(image != NULL, [NSString stringWithFormat:@"%s rendered", label]);
    CGImageRelease(image);
    if (limit) {
        check(contour + labels + gpu <= 16.0,
            [NSString stringWithFormat:@"%s contour+label+gpu %.2f ms", label, contour + labels + gpu]);
    }
}

static void TestBudgets(IsobarFieldRenderer *r) {
    const int nLon = 301, nLat = 201;
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = nLon, .nLat = nLat, .wrapsLongitude = NO};
    [r setGrid:g];
    float *v = malloc(sizeof(float) * (size_t)nLon * (size_t)nLat);
    for (int row = 0; row < nLat; row++) {
        double lat = g.north - row * g.step;
        for (int col = 0; col < nLon; col++) {
            double lon = g.west + col * g.step;
            v[row * nLon + col] = (float)(1012 + 14 * sin(lat * M_PI / 180.0) + 9 * sin(lon * M_PI / 90.0));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"AU timing field uploads");
    free(v);
    IsobarCamera wide = Cam(-25, 133, 1, 0, 800, 500);
    TimeRender(r, wide, "AU zoom 1", YES);
    check(r.lastLabelMilliseconds > 0 && r.lastLabelMilliseconds <= 4.0,
        [NSString stringWithFormat:@"AU zoom 1 label %.2f ms", r.lastLabelMilliseconds]);
    double built = r.lastContourMilliseconds;
    wide.centreLon = 135;
    CGImageRef panned = Render(r, 0, IsobarFieldPressure, YES, wide);
    CGImageRelease(panned);
    check(built > 0 && r.lastContourMilliseconds == 0,
        [NSString stringWithFormat:@"panning a full-grid contour does not rebuild (was %.2f, now %.2f)",
            built, r.lastContourMilliseconds]);
    IsobarCamera close = Cam(-33.87, 151.21, 6, 0, 800, 500);
    TimeRender(r, close, "AU zoom 6", YES);
}

static void TestTiming(void) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    IsobarFieldRenderer *r = MakeRenderer(device);
    IsobarGeoGrid g = {.west = 0, .north = 90, .step = 0.25, .nLon = 1440, .nLat = 721, .wrapsLongitude = YES};
    [r setGrid:g];
    size_t n = (size_t)g.nLon * (size_t)g.nLat;
    float *v = malloc(n * sizeof(float));
    for (int row = 0; row < g.nLat; row++) {
        double lat = g.north - row * g.step;
        for (int col = 0; col < g.nLon; col++) {
            double lon = g.west + col * g.step;
            v[(size_t)row * (size_t)g.nLon + (size_t)col] =
                (float)(1010 + 15 * sin(lat * M_PI / 180.0) + 8 * sin(lon * M_PI / 180.0));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"global 0.25° field uploads");
    float *v2 = malloc(n * sizeof(float));
    check(v2 != NULL, @"global step 1 allocates");
    if (v2) {
        for (size_t i = 0; i < n; i++) v2[i] = v[i] + 4.f;
        check(Upload(r, 1, IsobarFieldPressure, v2), @"global step 1 uploads");
    }
    IsobarCamera cam = Cam(-25, 133, 1, 0, 1600, 1000);
    CGImageRef warm = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(warm);
    enum { kRebuild = 5, kN = 7 };
    double rebuild[kRebuild];
    double mixes[kRebuild] = {0.2, 0.4, 0.5, 0.7, 0.85};
    for (int i = 0; i < kRebuild; i++) {
        CGImageRef image = Render(r, mixes[i], IsobarFieldPressure, YES, cam);
        rebuild[i] = r.lastContourMilliseconds;
        check(image != NULL && rebuild[i] > 0, @"timed contour rebuild");
        CGImageRelease(image);
    }
    for (int i = 0; i < kRebuild; i++) {
        for (int j = i + 1; j < kRebuild; j++) {
            if (rebuild[j] < rebuild[i]) {
                double s = rebuild[i];
                rebuild[i] = rebuild[j];
                rebuild[j] = s;
            }
        }
    }
    double contourMedian = rebuild[kRebuild / 2];
    fprintf(stderr, "global zoom 1 contour median %.2f ms (%.2f %.2f %.2f %.2f %.2f)\n",
        contourMedian, rebuild[0], rebuild[1], rebuild[2], rebuild[3], rebuild[4]);
    check(contourMedian <= 10.0,
        [NSString stringWithFormat:@"global zoom 1 contour %.2f ms", contourMedian]);
    double samples[kN];
    for (int i = 0; i < kN; i++) {
        struct timespec a, b;
        clock_gettime(CLOCK_UPTIME_RAW, &a);
        CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
        clock_gettime(CLOCK_UPTIME_RAW, &b);
        BOOL drew = image != NULL;
        CGImageRelease(image);
        samples[i] = (b.tv_sec - a.tv_sec) * 1000.0 + (b.tv_nsec - a.tv_nsec) / 1e6;
        check(drew, @"timed frame rendered");
    }
    for (int i = 0; i < kN; i++) {
        for (int j = i + 1; j < kN; j++) {
            if (samples[j] < samples[i]) {
                double s = samples[i];
                samples[i] = samples[j];
                samples[j] = s;
            }
        }
    }
    double median = samples[kN / 2];
    fprintf(stderr, "fieldrender median_ms %.2f\n", median);
    check(median <= 12.0, [NSString stringWithFormat:@"1600×1000 global frame median %.2f ms", median]);
    IsobarCamera close = cam;
    close.zoom = 6;
    struct timespec a, b;
    clock_gettime(CLOCK_UPTIME_RAW, &a);
    CGImageRef zoomed = Render(r, 0, IsobarFieldPressure, YES, close);
    clock_gettime(CLOCK_UPTIME_RAW, &b);
    double wall = (b.tv_sec - a.tv_sec) * 1000.0 + (b.tv_nsec - a.tv_nsec) / 1e6;
    fprintf(stderr, "global zoom 6 contour_ms %.2f gpu_ms %.2f total_ms %.2f wall_ms %.2f\n",
        r.lastContourMilliseconds, r.lastGpuMilliseconds,
        r.lastContourMilliseconds + r.lastGpuMilliseconds, wall);
    check(zoomed != NULL, @"global zoom 6 rendered");
    CGImageRelease(zoomed);
    free(v2);
    free(v);
}

static int InkAt(Image im, int x, int y) {
    int r, g, b;
    At(im, x, y, &r, &g, &b);
    if (r < 0) return 0;
    return Lum(r, g, b) < 55 && r < 80 && g < 90 && b < 100;
}

static int RowInk(Image im, int y, int x0, int x1) {
    int n = 0;
    if (y < 0 || y >= im.h) return 0;
    if (x0 < 0) x0 = 0;
    if (x1 > im.w) x1 = im.w;
    for (int x = x0; x < x1; x++) n += InkAt(im, x, y);
    return n;
}

// Isobars that cross the camera antimeridian must be split, not shifted
// past it. A tall zoom-1 frame puts ±180° on the left and right edges.
static void TestAntimeridianSplit(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 10, .north = 80, .step = 20, .nLon = 18, .nLat = 9, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        float p = (float)(1000 + (g.north - row * g.step));
        for (int col = 0; col < g.nLon; col++) v[row * g.nLon + col] = p;
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"antimeridian field uploads");
    free(v);
    IsobarCamera cam = Cam(0, 0, 1, 0, 420, 900);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"antimeridian frame renders");
    CGImageRelease(image);
    int bestY = -1, best = 0;
    for (int y = 0; y < im.h; y++) {
        int nInk = RowInk(im, y, im.w / 5, im.w * 4 / 5);
        if (nInk > best) { best = nInk; bestY = y; }
    }
    int left = 0, right = 0;
    for (int dy = -2; dy <= 2; dy++) {
        left += InkAt(im, 0, bestY + dy) + InkAt(im, 1, bestY + dy);
        right += InkAt(im, im.w - 1, bestY + dy) + InkAt(im, im.w - 2, bestY + dy);
    }
    check(best > 20 && left > 0 && right > 0,
        [NSString stringWithFormat:@"isobar split at the camera antimeridian (row %d mid %d left %d right %d)",
            bestY, best, left, right]);
    ImageFree(&im);
}

static void TestTemperatureKeepsContours(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 100, .north = -10, .step = 2, .nLon = 16, .nLat = 12, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *p = malloc(sizeof(float) * (size_t)n);
    float *t = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) {
        p[i] = (float)(1000 + (i % g.nLon));
        t[i] = (float)(20 - i % 7);
    }
    check(Upload(r, 0, IsobarFieldPressure, p), @"pressure for contour identity");
    IsobarCamera cam = Cam(-20, 115, 4, 0, 280, 200);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    double built = r.lastContourMilliseconds;
    NSInteger lines = r.contourLineCount;
    double lat = 0, lon = 0;
    BOOL vert = lines > 0 && [r contourVertexForLine:0 index:0 latitude:&lat longitude:&lon];
    check(Upload(r, 0, IsobarFieldTemperature, t), @"temperature uploads");
    image = Render(r, 0, IsobarFieldTemperature, YES, cam);
    CGImageRelease(image);
    double lat2 = 0, lon2 = 0;
    BOOL vert2 = [r contourVertexForLine:0 index:0 latitude:&lat2 longitude:&lon2];
    check(built > 0 && r.lastContourMilliseconds == 0 && lines > 0 && r.contourLineCount == lines
        && vert && vert2 && fabs(lat - lat2) < 1e-6 && fabs(lon - lon2) < 1e-6,
        [NSString stringWithFormat:@"temperature upload does not recontour (was %.2f ms / %ld lines, now %.2f / %ld)",
            built, (long)lines, r.lastContourMilliseconds, (long)r.contourLineCount]);
    free(p);
    free(t);
}

static double MeanSegment(IsobarFieldRenderer *r) {
    double sum = 0;
    int n = 0;
    for (NSInteger line = 0; line < r.contourLineCount; line++) {
        NSInteger count = [r contourVertexCountForLine:line];
        int closed = [r contourLineIsClosed:line] ? 1 : 0;
        int segs = closed ? (int)count : (int)count - 1;
        for (int s = 0; s < segs; s++) {
            double la0 = 0, lo0 = 0, la1 = 0, lo1 = 0;
            [r contourVertexForLine:line index:s latitude:&la0 longitude:&lo0];
            [r contourVertexForLine:line index:(s + 1) % count latitude:&la1 longitude:&lo1];
            double d = hypot(la1 - la0, LonErr(lo1, lo0));
            if (d > 1e-6) { sum += d; n++; }
        }
    }
    return n ? sum / n : 0;
}

static void TestStrideMonotonic(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 0, .north = 90, .step = 0.25, .nLon = 1440, .nLat = 721, .wrapsLongitude = YES};
    [r setGrid:g];
    size_t n = (size_t)g.nLon * (size_t)g.nLat;
    float *v = malloc(n * sizeof(float));
    for (int row = 0; row < g.nLat; row += 4) {
        double lat = g.north - row * g.step;
        for (int col = 0; col < g.nLon; col += 4) {
            double lon = g.west + col * g.step;
            float p = (float)(1010 + 12 * sin(lat * M_PI / 180.0) + 6 * sin(lon * M_PI / 180.0));
            for (int dj = 0; dj < 4 && row + dj < g.nLat; dj++)
                for (int di = 0; di < 4 && col + di < g.nLon; di++)
                    v[(size_t)(row + dj) * (size_t)g.nLon + (size_t)(col + di)] = p;
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"stride field uploads");
    free(v);
    for (int globe = 0; globe <= 1; globe++) {
        double prev = 1e9;
        double zooms[] = {1, 1.5, 2, 3, 4, 5, 6, 7, 8};
        for (int zi = 0; zi < 9; zi++) {
            double z = zooms[zi];
            IsobarCamera cam = Cam(-25, 133, z, globe, 1600, 1000);
            CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
            CGImageRelease(image);
            double seg = MeanSegment(r);
            check(seg > 0 && seg <= prev * 1.05,
                [NSString stringWithFormat:@"globe %d zoom %.1f segment %.3f° (previous %.3f°)",
                    globe, z, seg, prev]);
            prev = seg;
        }
    }
}

static void TestZonalSeam(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 0, .north = 70, .step = 10, .nLon = 36, .nLat = 15, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        float p = (float)(980 + row * 4);
        for (int col = 0; col < g.nLon; col++) v[row * g.nLon + col] = p;
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"zonal ring uploads");
    free(v);
    IsobarCamera cam = Cam(0, 0, 1, 0, 480, 270);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"zonal seam frame renders");
    CGImageRelease(image);
    int bestY = -1, best = 0;
    for (int y = 0; y < im.h; y++) {
        int nInk = RowInk(im, y, 0, im.w);
        if (nInk > best) { best = nInk; bestY = y; }
    }
    int gap = 0, run = 0;
    int saw = 0;
    for (int x = im.w / 4; x < im.w * 3 / 4; x++) {
        BOOL labelled = NO;
        for (NSInteger L = 0; L < r.labelCount; L++) {
            double lx = 0, ly = 0, hw = 0, hh = 0;
            if (![r labelAtIndex:L x:&lx y:&ly angle:NULL level:NULL halfW:&hw halfH:&hh]) continue;
            if (fabs(x - lx) <= hw + 8 && fabs(bestY - ly) <= hh + 6) labelled = YES;
        }
        if (labelled) { saw = 0; run = 0; continue; }
        int ink = 0;
        for (int dy = -1; dy <= 1; dy++) ink += InkAt(im, x, bestY + dy);
        if (ink) { saw = 1; run = 0; }
        else if (saw) {
            run++;
            if (run > gap) gap = run;
        }
    }
    int closed = 0;
    double worstJump = 0, jumpLon0 = 0, jumpLon1 = 0, jumpLat = 0;
    for (NSInteger i = 0; i < r.contourLineCount; i++) {
        if (![r contourLineIsClosed:i]) continue;
        closed++;
        NSInteger nv = [r contourVertexCountForLine:i];
        for (NSInteger p = 0; p < nv; p++) {
            double la0, lo0, la1, lo1;
            [r contourVertexForLine:i index:p latitude:&la0 longitude:&lo0];
            [r contourVertexForLine:i index:(p + 1) % nv latitude:&la1 longitude:&lo1];
            double jump = fabs(LonErr(lo1, lo0));
            if (fabs(la0) < 45 && jump > worstJump) { worstJump = jump; jumpLon0 = lo0; jumpLon1 = lo1; jumpLat = la0; }
        }
    }
    check(best > 30 && gap <= 2 && closed > 0,
        [NSString stringWithFormat:@"zonal ring is closed across the seam (row %d ink %d gap %d closed %d jump %.2f at %.1f→%.1f lat %.1f labels %ld)",
            bestY, best, gap, closed, worstJump, jumpLon0, jumpLon1, jumpLat, (long)r.labelCount]);
    ImageFree(&im);
}

static void TestGlobeLimb(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 0, .north = 80, .step = 10, .nLon = 36, .nLat = 17, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        double lat = g.north - row * g.step;
        for (int col = 0; col < g.nLon; col++) {
            double lon = g.west + col * g.step;
            v[row * g.nLon + col] = (float)(1010 + 16 * sin(lat * M_PI / 180.0) + 10 * sin(lon * M_PI / 90.0));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"limb field uploads");
    free(v);
    IsobarCamera cam = Cam(10, 40, 1, 1, 420, 420);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"globe limb frame renders");
    CGImageRelease(image);
    double vw, vh, px, radius, globe;
    // radius = pxPerDeg / deg, same as the renderer.
    double fit = fmin(cam.viewportW / 360.0, cam.viewportH / 180.0);
    radius = cam.zoom * fit / (M_PI / 180.0);
    (void)vw; (void)vh; (void)px; (void)globe;
    double cx = cam.viewportW * 0.5, cy = cam.viewportH * 0.5;
    int leak = 0;
    for (int y = 0; y < im.h; y++) {
        for (int x = 0; x < im.w; x++) {
            double d = hypot(x + 0.5 - cx, y + 0.5 - cy);
            if (d <= radius + 0.25) continue;
            int pr, pg, pb;
            At(im, x, y, &pr, &pg, &pb);
            if (pr < 0) continue;
            if (!NearRGB(pr, pg, pb, IsobarOceanColour(), 6)) leak++;
        }
    }
    check(leak == 0, [NSString stringWithFormat:@"no line or label ink outside the disc (%d px, radius %.1f)", leak, radius]);
    ImageFree(&im);
}

static void TestPickWrap(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    IsobarGeoGrid g = {.west = -180, .north = 20, .step = 10, .nLon = 36, .nLat = 5, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) v[i] = 1013;
    check(Upload(r, 0, IsobarFieldPressure, v), @"pick-wrap field uploads");
    free(v);
    IsobarCamera cam = Cam(0, 190, 2, 0, 200, 140);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, NO, cam);
    CGImageRelease(image);
    double x = 0, y = 0;
    IsobarCameraProject(cam, 0, -170, &x, &y);
    double lat = 0, lon = 999;
    BOOL ok = [r pickLatitude:&lat longitude:&lon atX:x y:y camera:cam];
    check(ok && fabs(lat) < 1 && fabs(lon) <= 180 && LonErr(lon, 190) < 1,
        [NSString stringWithFormat:@"pick longitude wraps (lat %.2f lon %.2f)", lat, lon]);
}

static void TestLineCapacity(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 0, .north = 90, .step = 1, .nLon = 360, .nLat = 181, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        float p = (float)(960 + row); // 4 hPa every 4 rows, many long parallels
        for (int col = 0; col < g.nLon; col++) v[row * g.nLon + col] = p;
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"dense parallels upload");
    free(v);
    IsobarCamera cam = Cam(-40, 20, 1, 0, 360, 200);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"dense parallels render");
    CGImageRelease(image);
    int south = 0;
    double x = 0, y = 0;
    // A southern parallel (lat -70, pressure 960+160 = 1120) must still be drawn.
    if (IsobarCameraProject(cam, -70, 20, &x, &y)) {
        for (int dy = -3; dy <= 3; dy++) south += RowInk(im, Pix(y) + dy, 0, im.w);
    }
    check(south > 8, [NSString stringWithFormat:@"isobars past the old vertex cap are drawn (%d southern px)", south]);
    ImageFree(&im);
}

static void TestPoleAntipode(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 1;
    IsobarGeoGrid g = {.west = 0, .north = 90, .step = 1, .nLon = 16, .nLat = 8, .wrapsLongitude = YES};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) v[i] = 1000;
    v[1 * g.nLon + 0] = 2500; // just south of the pole, lon 0. A 100 hPa spike
    // only shifts the antipode by a few hPa after a 1° gaussian; this one
    // makes a same-column reflection stay near 1000 and the antipode jump.
    check(Upload(r, 0, IsobarFieldPressure, v), @"pole spike uploads");
    free(v);
    IsobarCamera cam = Cam(89, 0, 8, 0, 200, 160);
    double anti = [r pickValueAtX:100 y:80 camera:cam time:0 kind:IsobarFieldPressure];
    // Sample through the geographic API, not a guessed pixel.
    (void)anti;
    double x = 0, y = 0;
    IsobarCameraProject(cam, 89.2, 180, &x, &y);
    double atAnti = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    IsobarCameraProject(cam, 89.2, 90, &x, &y);
    double atQuarter = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    check(isfinite(atAnti) && isfinite(atQuarter) && atAnti > atQuarter + 20,
        [NSString stringWithFormat:@"pole smooth uses the antipode (anti %.2f quarter %.2f at %.0f,%.0f)",
            atAnti, atQuarter, x, y]);
    r.pressureSmoothDegrees = 0.3125;
}

static void TestMotionBirth(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = [IsobarFieldMotion new];
    // One closed 1012 isobar, wide enough that its label sits outside the
    // centre exclusion (six label-widths) around the low.
    IsobarGeoGrid g = {.west = 110, .north = -5, .step = 2, .nLon = 41, .nLat = 41, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    float *b = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) a[i] = b[i] = 1016;
    int col = 20, row = 20;
    for (int j = 0; j < g.nLat; j++) {
        for (int i = 0; i < g.nLon; i++) {
            double d = hypot((i - col) * g.step, (j - row) * g.step);
            b[j * g.nLon + i] = (float)(1016 - 6 * exp(-0.5 * d * d / (18.0 * 18.0)));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, a) && Upload(r, 1, IsobarFieldPressure, b), @"motion birth uploads");
    free(a);
    free(b);
    double lat = g.north - row * g.step;
    double lon = g.west + col * g.step;
    IsobarCamera cam = Cam(lat, lon, 6, 0, 480, 480);
    r.motion = nil;
    CGImageRef image = Render(r, 1, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    image = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    r.motion = [IsobarFieldMotion new];
    image = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    NSInteger before = r.labelCount;
    BOOL appeared = NO;
    for (int frame = 1; frame <= 8; frame++) {
        usleep(20000);
        image = Render(r, 1, IsobarFieldPressure, YES, cam);
        CGImageRelease(image);
        if (r.labelCount > before) appeared = YES;
    }
    check(appeared, [NSString stringWithFormat:@"a new closed isobar gains a label within 8 frames (before %ld after %ld, contours %ld)",
        (long)before, (long)r.labelCount, (long)r.contourLineCount]);
    check(r.motion.maxAnnotationAlphaStep <= 0.35,
        [NSString stringWithFormat:@"label fade step stays bounded (%.3f)", r.motion.maxAnnotationAlphaStep]);
    r.motion = nil;
}

static void TestSmallBump(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 120, .north = -5, .step = 1, .nLon = 31, .nLat = 31, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) v[i] = 1010;
    for (int j = 4; j <= 26; j++)
        for (int i = 4; i <= 26; i++) v[j * g.nLon + i] = 1020.2f;
    v[15 * g.nLon + 15] = 1021.2f;
    check(Upload(r, 0, IsobarFieldPressure, v), @"1 hPa bump uploads");
    free(v);
    IsobarCamera cam = Cam(-25, 135, 4, 0, 360, 360);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    CGImageRelease(image);
    int highs = 0;
    for (NSInteger i = 0; i < r.centreCount; i++) {
        BOOL high = NO;
        if ([r centreAtIndex:i x:NULL y:NULL value:NULL high:&high] && high) highs++;
    }
    check(highs == 0, [NSString stringWithFormat:@"a 1 hPa bump is not a high (%d)", highs]);
}

static void TestCameraMotionLabels(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west=100,.north=0,.step=1,.nLon=81,.nLat=71,.wrapsLongitude=NO};
    [r setGrid:g];
    float *field = malloc(sizeof(float)*81*71);
    for (int j=0;j<71;j++) for (int i=0;i<81;i++) field[j*81+i]=980+j;
    check(Upload(r,0,IsobarFieldPressure,field), @"camera-label fixture uploads");
    free(field);
    r.motion = [IsobarFieldMotion new];
    IsobarCamera cam = Cam(-35,140,6,0,640,480);
    CGImageRelease(Render(r,0,IsobarFieldPressure,YES,cam));
    double xs[128],ys[128],levels[128]; int count=0;
    for (NSInteger i=0;i<r.labelCount && count<128;i++) {
        double x,y,level;
        [r labelAtIndex:i x:&x y:&y angle:NULL level:&level halfW:NULL halfH:NULL];
        if (x>80 && x<560 && y>80 && y<350) { xs[count]=x;ys[count]=y;levels[count++]=level; }
    }
    IsobarCamera moved = cam; moved.centreLat += 3;
    for (int n=0;n<count;n++) {
        double lat=0,lon=0,x=0,y=0;
        check(IsobarCameraUnproject(cam,xs[n],ys[n],&lat,&lon) && IsobarCameraProject(moved,lat,lon,&x,&y), @"label geographic anchor projects after pan");
        xs[n]=x;ys[n]=y;
    }
    cam = moved;
    CGImageRelease(Render(r,0,IsobarFieldPressure,YES,cam));
    int followed=0;
    for (int n=0;n<count;n++) for (NSInteger i=0;i<r.labelCount;i++) {
        double x,y,level;
        [r labelAtIndex:i x:&x y:&y angle:NULL level:&level halfW:NULL halfH:NULL];
        if (fabs(level-levels[n])<.1 && hypot(x-xs[n],y-ys[n])<2) { followed++; break; }
    }
    check(count>=2 && followed==count, [NSString stringWithFormat:@"pressure labels follow camera immediately (%d/%d)",followed,count]);
    r.motion = nil;
}

static void TestManyLabels(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    r.contentScale = 1;
    IsobarGeoGrid g = {.west = 95, .north = 5, .step = 1, .nLon = 110, .nLat = 70, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) v[i] = 1016;
    // Six separated lows. Each 1012 ring is far enough from its low that the
    // centre exclusion does not remove the only label.
    double centres[6][2] = {
        {-12, 110}, {-12, 146}, {-12, 182},
        {-48, 110}, {-48, 146}, {-48, 182},
    };
    for (int row = 0; row < g.nLat; row++) {
        double lat = g.north - row * g.step;
        for (int col = 0; col < g.nLon; col++) {
            double lon = g.west + col * g.step;
            float p = 1016;
            for (int c = 0; c < 6; c++) {
                double d = hypot(lat - centres[c][0], lon - centres[c][1]);
                float dip = (float)(6.0 * exp(-0.5 * d * d / (16.0 * 16.0)));
                if (1016 - dip < p) p = (float)(1016 - dip);
            }
            v[row * g.nLon + col] = p;
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"multi-isobar field uploads");
    free(v);
    IsobarCamera cam = Cam(-30, 146, 2.8, 0, 1200, 800);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    check(image != NULL, @"multi-isobar frame renders");
    CGImageRelease(image);
    check(r.labelCount >= 6, [NSString stringWithFormat:@"placement sees at least 6 labels (%ld, contours %ld)",
        (long)r.labelCount, (long)r.contourLineCount]);
    CheckLabels(r, cam, g, "multi");
}

static void TestLabelGap(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    r.contentScale = 2;
    IsobarGeoGrid g = {.west = 115, .north = -10, .step = 1, .nLon = 71, .nLat = 71, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int j = 0; j < g.nLat; j++) {
        for (int i = 0; i < g.nLon; i++) {
            double d = hypot(i - 35, j - 35) * g.step;
            v[j * g.nLon + i] = (float)(1020 - 6 * exp(-0.5 * d * d / (22.0 * 22.0)));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"curved label field uploads");
    free(v);
    IsobarCamera cam = Cam(-45, 150, 6, 0, 760, 760);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    Image im = {0};
    check(image && ImageFrom(image, &im), @"curved label frame renders");
    CGImageRelease(image);
    int stub = 0, checked = 0;
    for (NSInteger L = 0; L < r.labelCount; L++) {
        double x = 0, y = 0, level = 0, hw = 0, hh = 0, ang = 0;
        if (![r labelAtIndex:L x:&x y:&y angle:&ang level:&level halfW:&hw halfH:&hh]) continue;
        int geo = -1;
        double best = 1e9;
        for (NSInteger line = 0; line < r.contourLineCount; line++) {
            if (fabs([r contourLevelForLine:line] - level) > 0.1) continue;
            NSInteger nv = [r contourVertexCountForLine:line];
            for (NSInteger i = 0; i < nv; i += 3) {
                double la, lo, px = 0, py = 0;
                [r contourVertexForLine:line index:i latitude:&la longitude:&lo];
                if (!IsobarCameraProject(cam, la, lo, &px, &py)) continue;
                double d = hypot(px - x, py - y);
                if (d < best) { best = d; geo = (int)line; }
            }
        }
        if (geo < 0 || best > 40) continue;
        double pad = 2.5 * 2 + 1.5;
        NSInteger nv = [r contourVertexCountForLine:geo];
        for (NSInteger i = 0; i + 1 < nv; i++) {
            double la0, lo0, la1, lo1;
            [r contourVertexForLine:geo index:i latitude:&la0 longitude:&lo0];
            [r contourVertexForLine:geo index:i + 1 latitude:&la1 longitude:&lo1];
            for (int s = 0; s <= 24; s++) {
                double t = s / 24.0;
                double la = la0 + (la1 - la0) * t;
                double lo = lo0 + (lo1 - lo0) * t;
                double px = 0, py = 0;
                if (!IsobarCameraProject(cam, la, lo, &px, &py)) continue;
                double dx = px - x, dy = py - y;
                double co = cos(ang), si = sin(ang);
                double lx = dx * co + dy * si, ly = -dx * si + dy * co;
                if (fabs(lx) > hw + pad || fabs(ly) > hh + pad) continue;
                if (fabs(lx) <= hw && fabs(ly) <= hh) continue;
                checked++;
                stub += InkAt(im, (int)llround(px), (int)llround(py));
            }
        }
    }
    check(checked > 4 && stub == 0,
        [NSString stringWithFormat:@"label gap covers the curved stroke (%d ink / %d samples, labels %ld lines %ld)",
            stub, checked, (long)r.labelCount, (long)r.contourLineCount]);
    ImageFree(&im);
    r.contentScale = 1;
}

static void TestFormats(IsobarFieldRenderer *r) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    r.contentScale = 1;
    // Mid-Atlantic, clear of the Australian coastline the renderer always draws.
    IsobarGeoGrid g = {.west = 0, .north = 40, .step = 1, .nLon = 21, .nLat = 21, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *raw = malloc(sizeof(float) * (size_t)n);
    float *smoothed = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) raw[i] = 1000;
    raw[10 * g.nLon + 10] = 1100;
    memcpy(smoothed, raw, sizeof(float) * (size_t)n);
    IsobarSmoothPressure(smoothed, g, 1.0);
    check(Upload(r, 0, IsobarFieldPressure, smoothed), @"pre-smoothed pressure uploads");
    r.pressureSmoothDegrees = 1;
    check(Upload(r, 1, IsobarFieldPressure, raw), @"upload applies the same smooth");
    r.pressureSmoothDegrees = 0;
    IsobarCamera cam = Cam(30, 10, 4, 0, 240, 240);
    double x = 0, y = 0;
    IsobarCameraProject(cam, 30, 10, &x, &y);
    double pre = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    double up = [r pickValueAtX:x y:y camera:cam time:1 kind:IsobarFieldPressure];
    check(isfinite(pre) && fabs(pre - up) < 0.05,
        [NSString stringWithFormat:@"IsobarSmoothPressure matches upload smoothing (%.3f vs %.3f)", pre, up]);
    for (int i = 0; i < n; i++) raw[i] = 1000;
    r.pressureSmoothDegrees = 0;
    check(Upload(r, 0, IsobarFieldPressure, raw), @"flat field for format checks");
    free(raw);
    free(smoothed);
    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
        width:240 height:240 mipmapped:NO];
    desc.usage = MTLTextureUsageRenderTarget;
    desc.storageMode = MTLStorageModeShared;
    id<MTLTexture> tex = [device newTextureWithDescriptor:desc];
    id<MTLCommandQueue> queue = [device newCommandQueue];
    id<MTLCommandBuffer> buf = [queue commandBuffer];
    NSError *error = nil;
    check(tex && buf && [r encodeTime:0 fill:IsobarFieldPressure isobars:NO camera:cam
        intoCommandBuffer:buf target:tex error:&error], error.localizedDescription ?: @"encodeTime encodes");
    check(buf.status == MTLCommandBufferStatusNotEnqueued, @"encodeTime does not commit");
    [buf commit];
    [buf waitUntilCompleted];
    uint8_t px[4] = {0};
    NSUInteger ix = (NSUInteger)floor(x), iy = (NSUInteger)floor(y);
    [tex getBytes:px bytesPerRow:240 * 4 fromRegion:MTLRegionMake2D(ix, iy, 1, 1) mipmapLevel:0];
    IsobarRGB field = IsobarFieldColour(IsobarFieldPressure, 1000);
    MTLTextureDescriptor *bgraDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:240 height:240 mipmapped:NO];
    bgraDesc.usage = MTLTextureUsageRenderTarget;
    bgraDesc.storageMode = MTLStorageModeShared;
    id<MTLTexture> bgra = [device newTextureWithDescriptor:bgraDesc];
    error = nil;
    uint8_t bp[4] = {0};
    if (bgra && [r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:cam toTexture:bgra error:&error])
        [bgra getBytes:bp bytesPerRow:240 * 4 fromRegion:MTLRegionMake2D(ix, iy, 1, 1) mipmapLevel:0];
    double centre = [r pickValueAtX:x y:y camera:cam time:0 kind:IsobarFieldPressure];
    check(buf.status == MTLCommandBufferStatusCompleted && NearRGB(px[0], px[1], px[2], field, 3),
        [NSString stringWithFormat:@"committed encode draws the field (%d %d %d bgra %d %d %d at %.0f,%.0f value %.2f expect %d %d %d)",
            px[0], px[1], px[2], bp[2], bp[1], bp[0], x, y, centre, Chan(field.r), Chan(field.g), Chan(field.b)]);
    MTLTextureDescriptor *srgbDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm_sRGB
        width:240 height:240 mipmapped:NO];
    srgbDesc.usage = MTLTextureUsageRenderTarget;
    srgbDesc.storageMode = MTLStorageModeShared;
    id<MTLTexture> srgb = [device newTextureWithDescriptor:srgbDesc];
    error = nil;
    check(srgb && [r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:cam toTexture:srgb error:&error],
        error.localizedDescription ?: @"sRGB target renders");
    uint8_t sp[4] = {0};
    [srgb getBytes:sp bytesPerRow:240 * 4 fromRegion:MTLRegionMake2D(ix, iy, 1, 1) mipmapLevel:0];
    check(NearRGB(sp[2], sp[1], sp[0], field, 4),
        [NSString stringWithFormat:@"sRGB target matches the field after one encode (%d %d %d)", sp[2], sp[1], sp[0]]);
    MTLTextureDescriptor *halfDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float
        width:240 height:240 mipmapped:NO];
    halfDesc.usage = MTLTextureUsageRenderTarget;
    halfDesc.storageMode = MTLStorageModeShared;
    id<MTLTexture> half = [device newTextureWithDescriptor:halfDesc];
    error = nil;
    check(half && [r renderTime:0 fill:IsobarFieldPressure isobars:NO camera:cam toTexture:half error:&error],
        error.localizedDescription ?: @"RGBA16Float target renders");
    uint16_t hp[4] = {0};
    [half getBytes:hp bytesPerRow:240 * 8 fromRegion:MTLRegionMake2D(ix, iy, 1, 1) mipmapLevel:0];
    float hr = DecodeF16(hp[0]), hg = DecodeF16(hp[1]), hb = DecodeF16(hp[2]);
    check(fabsf(hr - (float)field.r) < 0.02f && fabsf(hg - (float)field.g) < 0.02f && fabsf(hb - (float)field.b) < 0.02f,
        [NSString stringWithFormat:@"RGBA16Float matches the field (%.3f %.3f %.3f)", hr, hg, hb]);
    check(!r.geometryTruncated, @"a small frame is not truncated");
}

static void TestReview(IsobarFieldRenderer *r) {
    TestFormats(r);
    TestAntimeridianSplit(r);
    TestLabelGap(r);
    TestTemperatureKeepsContours(r);
    TestZonalSeam(r);
    TestGlobeLimb(r);
    TestPickWrap(r);
    TestLineCapacity(r);
    TestPoleAntipode(r);
    TestMotionBirth(r);
    TestSmallBump(r);
    TestManyLabels(r);
    TestCameraMotionLabels(r);
    TestStrideMonotonic(r);
}

// Published 2026-10-04T12Z crop. The chart's hour-0 marks are a high near
// 38°S 139°E and the Tasman low near 43°S 151°E; neither falls in this crop.
// A heat low over northern WA is in the raw field and is not a chart centre
// at the compared frames.
static void TestNewGuinea(IsobarFieldRenderer *r) {
    NSString *dir = @"Tests/fixtures/fieldrender-centres";
    NSFileManager *fm = [NSFileManager defaultManager];
    NSArray *names = [fm contentsOfDirectoryAtPath:dir error:nil];
    unsigned long long bytes = 0;
    for (NSString *name in names) {
        NSString *path = [dir stringByAppendingPathComponent:name];
        BOOL folder = NO;
        if ([fm fileExistsAtPath:path isDirectory:&folder] && !folder)
            bytes += [[fm attributesOfItemAtPath:path error:nil] fileSize];
    }
    check(bytes > 0 && bytes <= 40 * 1024,
        [NSString stringWithFormat:@"New Guinea fixture is %llu bytes", bytes]);
    NSData *headerData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"header.json"]];
    NSDictionary *header = [NSJSONSerialization JSONObjectWithData:headerData options:0 error:nil];
    check([header[@"attribution"] containsString:@"CC BY 4.0"], @"New Guinea fixture credits ECMWF CC BY 4.0");
    NSDictionary *grid = header[@"grid"];
    IsobarGeoGrid g = {
        .west = [grid[@"west"] doubleValue],
        .north = [grid[@"north"] doubleValue],
        .step = [grid[@"step"] doubleValue],
        .nLon = [grid[@"nLon"] intValue],
        .nLat = [grid[@"nLat"] intValue],
        .wrapsLongitude = NO
    };
    check(g.nLon == 113 && g.nLat == 81 && fabs(g.west - 128) < 1e-6 && fabs(g.north) < 1e-6,
        @"New Guinea fixture covers 128°E–156°E, 0°–20°S");
    [r setGrid:g];
    r.motion = nil;
    r.pressureSmoothDegrees = 0.3125;
    int n = g.nLon * g.nLat;
    NSArray *steps = header[@"steps"];
    check(steps.count == 2, @"New Guinea fixture has two steps");
    for (NSUInteger s = 0; s < steps.count; s++) {
        float *values = malloc(sizeof(float) * (size_t)n);
        NSString *file = [dir stringByAppendingPathComponent:steps[s][@"file"]];
        check(values && LoadF16(file, values, n), @"New Guinea step loads");
        if (s == 0 && values) {
            float peak = -INFINITY;
            for (int j = 0; j < g.nLat; j++) {
                double lat = g.north - j * g.step;
                if (lat > -5.0 || lat < -11.0) continue;
                for (int i = 0; i < g.nLon; i++) {
                    double lon = g.west + i * g.step;
                    if (lon < 130.0 || lon > 152.0) continue;
                    float sample = values[j * g.nLon + i];
                    if (sample > peak) peak = sample;
                }
            }
            check(peak >= 1020.f, [NSString stringWithFormat:@"the New Guinea reduction spike is in the fixture (%.1f hPa)", peak]);
        }
        check(Upload(r, (NSInteger)s, IsobarFieldPressure, values), @"New Guinea step uploads");
        free(values);
    }
    IsobarCamera cam = Cam(-8, 143, 5, 0, 720, 520);
    for (double time = 0; time < 2; time += 1) {
        CGImageRef image = Render(r, time, IsobarFieldPressure, YES, cam);
        check(image != NULL, @"New Guinea frame renders");
        CGImageRelease(image);
        int ngHigh = 0, marked = 0;
        NSMutableString *where = [NSMutableString string];
        for (NSInteger i = 0; i < r.centreCount; i++) {
            double x = 0, y = 0, value = 0;
            BOOL high = NO;
            if (![r centreAtIndex:i x:&x y:&y value:&value high:&high]) continue;
            double lat = 0, lon = 0;
            if (!IsobarCameraUnproject(cam, x, y, &lat, &lon)) continue;
            marked++;
            [where appendFormat:@" %s%.0f@%.1f,%.1f", high ? "H" : "L", value, lat, lon];
            // Southern New Guinea is inside the chart window (north edge 5°S).
            if (high && lat <= -5.0 && lat >= -11.0 && lon >= 130.0 && lon <= 152.0) ngHigh++;
        }
        check(ngHigh == 0, [NSString stringWithFormat:@"no H over New Guinea at step %.0f (%d highs, marks %d:%@)",
            time, ngHigh, marked, where]);
    }
}

// A float16 terrace is flat across Bass Strait. The 4° ring is only a couple
// of hectopascals; the centre is the terrace, not its rim. A spike on the New
// Guinea highlands stays unmarked.
static void TestFlatSynopticHigh(IsobarFieldRenderer *r) {
    r.pressureSmoothDegrees = 0.3125;
    r.motion = nil;
    IsobarGeoGrid g = {
        .west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO
    };
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *values = malloc(sizeof(float) * (size_t)n);
    check(values != NULL, @"flat-high field allocates");
    if (!values) return;
    for (int j = 0; j < g.nLat; j++) {
        double lat = g.north - j * g.step;
        for (int i = 0; i < g.nLon; i++) {
            double lon = g.west + i * g.step;
            double d = hypot(lat + 40.2, lon - 146.2);
            float p = 1016.f;
            if (d <= 3.0) p = 1032.f;
            else if (d < 12.0) p = (float)(1032.0 - (d - 3.0) / 9.0 * 16.0);
            double ng = hypot(lat + 6.0, lon - 141.0);
            if (ng < 1.5) p = (float)(1048.0 - ng * 10.0);
            values[j * g.nLon + i] = p;
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, values), @"flat high uploads");
    free(values);
    IsobarCamera cam = Cam(-25, 140, 4.2, 0, 960, 720);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    check(image != NULL, @"flat high frame renders");
    CGImageRelease(image);
    int southHigh = 0, ngHigh = 0, marked = 0;
    NSMutableString *where = [NSMutableString string];
    for (NSInteger i = 0; i < r.centreCount; i++) {
        double x = 0, y = 0, value = 0;
        BOOL high = NO;
        if (![r centreAtIndex:i x:&x y:&y value:&value high:&high]) continue;
        double lat = 0, lon = 0;
        if (!IsobarCameraUnproject(cam, x, y, &lat, &lon)) continue;
        marked++;
        [where appendFormat:@" %s%.0f@%.1f,%.1f", high ? "H" : "L", value, lat, lon];
        if (high && value >= 1028 && lat <= -35.0 && lat >= -46.0 && lon >= 140.0 && lon <= 152.0) southHigh++;
        if (high && lat <= -4.0 && lat >= -11.0 && lon >= 130.0 && lon <= 152.0) ngHigh++;
    }
    check(southHigh == 1, [NSString stringWithFormat:@"the Bass Strait terrace is one H (%d, marks %d:%@)",
        southHigh, marked, where]);
    check(ngHigh == 0, [NSString stringWithFormat:@"no H over the New Guinea spike (%d, marks %d:%@)",
        ngHigh, marked, where]);
}

static double Median5(double *s) {
    for (int i = 0; i < 5; i++) {
        for (int j = i + 1; j < 5; j++) {
            if (s[j] < s[i]) {
                double t = s[i];
                s[i] = s[j];
                s[j] = t;
            }
        }
    }
    return s[2];
}

static double CpuFrame(IsobarFieldRenderer *r, IsobarCamera cam) {
    struct timespec a, b;
    clock_gettime(CLOCK_UPTIME_RAW, &a);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    clock_gettime(CLOCK_UPTIME_RAW, &b);
    CGImageRelease(image);
    double wall = (b.tv_sec - a.tv_sec) * 1000.0 + (b.tv_nsec - a.tv_nsec) / 1e6;
    double cpu = wall - r.lastGpuMilliseconds;
    return cpu > 0 ? cpu : 0;
}

static void TestGlobeCost(void) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    IsobarFieldRenderer *r = MakeRenderer(device);
    NSString *dir = @"Tests/fixtures/fieldrender";
    NSData *headerData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"header.json"]];
    NSDictionary *header = [NSJSONSerialization JSONObjectWithData:headerData options:0 error:nil];
    NSDictionary *grid = header[@"grid"];
    if (!grid) {
        check(NO, @"AU fixture header");
        return;
    }
    IsobarGeoGrid g = {
        .west = [grid[@"west"] doubleValue], .north = [grid[@"north"] doubleValue],
        .step = [grid[@"step"] doubleValue], .nLon = [grid[@"nLon"] intValue],
        .nLat = [grid[@"nLat"] intValue], .wrapsLongitude = NO
    };
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    NSString *file0 = header[@"steps"][0][@"file"];
    check(a && LoadF16([dir stringByAppendingPathComponent:file0], a, n), @"globe fixture loads");
    if (!a) return;
    [r setGrid:g];
    check(Upload(r, 0, IsobarFieldPressure, a), @"globe fixture uploads");
    free(a);
    IsobarCamera flat = Cam(-33, 135, 4, 0, 640, 480);
    IsobarCamera globe = flat;
    globe.globe = 0.75;
    CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, flat));
    CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, globe));
    double flatS[5], globeS[5];
    for (int i = 0; i < 5; i++) flatS[i] = CpuFrame(r, flat);
    for (int i = 0; i < 5; i++) globeS[i] = CpuFrame(r, globe);
    double flatM = Median5(flatS), globeM = Median5(globeS);
    fprintf(stderr, "globe cpu flat %.2f ms globe0.75 %.2f ms\n", flatM, globeM);
    check(globeM < 8.0 && globeM <= flatM * 2.0 + 0.05,
        [NSString stringWithFormat:@"globe 0.75 cpu %.2f ms vs flat %.2f ms", globeM, flatM]);
}

static void TestSteadyBuffers(void) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    IsobarFieldRenderer *r = MakeRenderer(device);
    IsobarGeoGrid g = {.west = 110, .north = -10, .step = 0.5, .nLon = 80, .nLat = 60, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        double lat = g.north - row * g.step;
        for (int col = 0; col < g.nLon; col++) {
            double lon = g.west + col * g.step;
            v[row * g.nLon + col] = (float)(1010 + 12 * sin(lat * 0.2) + 8 * sin(lon * 0.15));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"steady field uploads");
    free(v);
    IsobarCamera cam = Cam(-25, 130, 3, 0.2, 640, 480);
    for (int i = 0; i < 8; i++) {
        cam.centreLon = 128 + i * 0.4;
        CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, cam));
    }
    NSUInteger before = r.geometryAllocations;
    for (int i = 0; i < 600; i++) {
        cam.centreLon = 130 + 0.15 * sin(i * 0.05);
        cam.centreLat = -25 + 0.1 * cos(i * 0.04);
        CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
        CGImageRelease(image);
    }
    check(r.geometryAllocations == before,
        [NSString stringWithFormat:@"steady playback allocates no buffers (%lu after warm %lu)",
            (unsigned long)r.geometryAllocations, (unsigned long)before]);
}

static void TestAsyncStress(void) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    IsobarFieldRenderer *r = [[IsobarFieldRenderer alloc] initWithDevice:device];
    check(r != nil && r.synchronousContours == NO, @"async renderer starts async");
    if (!r) return;
    IsobarGeoGrid g = {.west = 110, .north = -10, .step = 0.5, .nLon = 70, .nLat = 50, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    float *w = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) {
        v[i] = 1012;
        w[i] = 1008;
    }
    for (int row = 0; row < g.nLat; row++) {
        for (int col = 0; col < g.nLon; col++) {
            double d = hypot(col - 30, row - 24);
            v[row * g.nLon + col] = (float)(1016 - 18 * exp(-0.02 * d * d));
            w[row * g.nLon + col] = (float)(1004 + 14 * exp(-0.015 * d * d));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"async step 0 uploads");
    IsobarCamera cam = Cam(-22, 128, 4, 0.3, 480, 360);
    BOOL labels = NO;
    for (int frame = 0; frame < 600; frame++) {
        if (frame == 200) check(Upload(r, 1, IsobarFieldPressure, w), @"async step 1 uploads");
        if (frame == 400) check(Upload(r, 0, IsobarFieldPressure, v), @"async step 0 reuploads");
        cam.centreLon = 125 + 8.0 * sin(frame * 0.02);
        cam.centreLat = -22 + 4.0 * cos(frame * 0.017);
        cam.globe = 0.25 + 0.5 * (0.5 + 0.5 * sin(frame * 0.01));
        double time = (frame % 200) / 200.0;
        CGImageRef image = Render(r, time, IsobarFieldPressure, YES, cam);
        CGImageRelease(image);
        NSInteger lines = r.contourLineCount;
        if (lines > 0) {
            NSInteger verts = [r contourVertexCountForLine:0];
            double level = [r contourLevelForLine:0];
            BOOL closed = [r contourLineIsClosed:0];
            double lat = 0, lon = 0;
            if (verts > 0)
                [r contourVertexForLine:0 index:verts / 2 latitude:&lat longitude:&lon];
            (void)level; (void)closed; (void)lat; (void)lon;
        }
        if (r.labelCount > 0) labels = YES;
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, false);
    }
    for (int i = 0; i < 30 && r.contourLineCount < 1; i++)
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
    CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, cam));
    check(r.contourLineCount > 0, [NSString stringWithFormat:@"async playback published contours (%ld)",
        (long)r.contourLineCount]);
    check(labels || r.labelCount > 0, [NSString stringWithFormat:@"async playback drew labels (%ld)",
        (long)r.labelCount]);
    free(v);
    free(w);
}

static void Pump(double seconds) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false);
}

static BOOL CamEq(IsobarCamera a, IsobarCamera b) {
    return a.centreLat == b.centreLat && a.centreLon == b.centreLon && a.zoom == b.zoom
        && a.globe == b.globe && a.pitch == b.pitch && a.viewportW == b.viewportW && a.viewportH == b.viewportH;
}

static uint64_t ContourSig(IsobarFieldRenderer *r) {
    uint64_t h = 1469598103934665603ull;
    NSInteger nLines = r.contourLineCount;
    h ^= (uint64_t)nLines;
    for (NSInteger i = 0; i < nLines; i++) {
        NSInteger n = [r contourVertexCountForLine:i];
        double level = [r contourLevelForLine:i];
        h = h * 1099511628211ull + (uint64_t)n;
        h ^= (uint64_t)llround(level * 100.0);
        if (n <= 0) continue;
        double la = 0, lo = 0;
        [r contourVertexForLine:i index:0 latitude:&la longitude:&lo];
        h = h * 1099511628211ull + (uint64_t)llround(la * 50.0);
        h = h * 1099511628211ull + (uint64_t)llround(lo * 50.0);
        [r contourVertexForLine:i index:n / 2 latitude:&la longitude:&lo];
        h = h * 1099511628211ull + (uint64_t)llround(la * 50.0);
    }
    return h;
}

static id<MTLTexture> ColourTarget(id<MTLDevice> device, int w, int h) {
    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
        width:(NSUInteger)w height:(NSUInteger)h mipmapped:NO];
    desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModeShared;
    return [device newTextureWithDescriptor:desc];
}

static uint64_t InkRows(id<MTLTexture> tex) {
    int w = (int)tex.width, h = (int)tex.height;
    if (w < 1 || h < 1 || h > 64) return 0;
    uint8_t *px = malloc((size_t)w * 4u * (size_t)h);
    if (!px) return 0;
    [tex getBytes:px bytesPerRow:(NSUInteger)w * 4
        fromRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h) mipmapLevel:0];
    uint64_t bits = 0;
    for (int y = 0; y < h; y++) {
        int ink = 0;
        for (int x = 0; x < w; x++) {
            const uint8_t *p = px + ((size_t)y * (size_t)w + (size_t)x) * 4u;
            int lum = (int)llround(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
            if (lum < 55 && p[0] < 80 && p[1] < 90 && p[2] < 100) ink++;
        }
        if (ink > 4) bits |= 1ull << y;
    }
    free(px);
    return bits;
}

static void FillLatBand(float *v, IsobarGeoGrid g, double lat0) {
    for (int row = 0; row < g.nLat; row++) {
        double lat = g.north - row * g.step;
        float p = lat >= lat0 ? 1016.f : 1004.f;
        for (int col = 0; col < g.nLon; col++) v[row * g.nLon + col] = p;
    }
}

static BOOL Encode(IsobarFieldRenderer *r, id<MTLCommandBuffer> buf, id<MTLTexture> tex,
    double time, IsobarCamera cam, BOOL lines) {
    NSError *error = nil;
    BOOL ok = [r encodeTime:time fill:IsobarFieldPressure isobars:lines camera:cam
        intoCommandBuffer:buf target:tex error:&error];
    if (!ok) fprintf(stderr, "  encode: %s\n", error.localizedDescription.UTF8String);
    return ok;
}

static void TestFadeUnits(id<MTLDevice> device) {
    IsobarFieldRenderer *r = MakeRenderer(device);
    r.pressureSmoothDegrees = 0;
    r.motion = [IsobarFieldMotion new];
    IsobarGeoGrid g = {.west = 110, .north = -5, .step = 2, .nLon = 41, .nLat = 41, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *flat = malloc(sizeof(float) * (size_t)n);
    float *low = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) flat[i] = low[i] = 1016;
    for (int j = 0; j < g.nLat; j++) {
        for (int i = 0; i < g.nLon; i++) {
            double d = hypot((i - 20) * g.step, (j - 20) * g.step);
            low[j * g.nLon + i] = (float)(1016 - 6 * exp(-0.5 * d * d / (18.0 * 18.0)));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, flat) && Upload(r, 1, IsobarFieldPressure, low), @"fade field uploads");
    double lat = g.north - 20 * g.step;
    double lon = g.west + 20 * g.step;
    IsobarCamera cam = Cam(lat, lon, 6, 0, 480, 480);
    const double t0 = 10000;
    IsobarFieldRenderTestingSetNow(t0);
    CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, cam));
    r.motion = [IsobarFieldMotion new];
    IsobarFieldRenderTestingSetNow(t0);
    CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, cam));
    IsobarFieldRenderTestingSetNow(t0);
    CGImageRelease(Render(r, 1, IsobarFieldPressure, YES, cam));
    double born = r.motion.minimumActiveAlpha;
    int fullAt = -1;
    double stepAlpha = born;
    const double hz = 1000.0 / 60.0;
    for (int frame = 1; frame <= 20; frame++) {
        IsobarFieldRenderTestingSetNow(t0 + frame * hz);
        CGImageRelease(Render(r, 1, IsobarFieldPressure, YES, cam));
        double a = r.motion.minimumActiveAlpha;
        if (frame == 1) stepAlpha = a;
        if (a >= 1.0 - 1e-9) { fullAt = frame; break; }
    }
    check(born < 0.05 && fullAt >= 14 && fullAt <= 16,
        [NSString stringWithFormat:@"60 Hz newborn reaches full alpha in 15 frames ± 1 (born %.3f full at %d, one-step %.3f)",
            born, fullAt, stepAlpha]);
    double frameDelta = stepAlpha - born;

    IsobarFieldRenderer *stall = MakeRenderer(device);
    stall.pressureSmoothDegrees = 0;
    stall.motion = [IsobarFieldMotion new];
    [stall setGrid:g];
    check(Upload(stall, 0, IsobarFieldPressure, flat) && Upload(stall, 1, IsobarFieldPressure, low), @"stall field uploads");
    const double s0 = 20000;
    IsobarFieldRenderTestingSetNow(s0);
    CGImageRelease(Render(stall, 0, IsobarFieldPressure, YES, cam));
    stall.motion = [IsobarFieldMotion new];
    IsobarFieldRenderTestingSetNow(s0);
    CGImageRelease(Render(stall, 0, IsobarFieldPressure, YES, cam));
    IsobarFieldRenderTestingSetNow(s0);
    CGImageRelease(Render(stall, 1, IsobarFieldPressure, YES, cam));
    double before = stall.motion.minimumActiveAlpha;
    IsobarFieldRenderTestingSetNow(s0 + 500);
    CGImageRelease(Render(stall, 1, IsobarFieldPressure, YES, cam));
    double after = stall.motion.minimumActiveAlpha;
    double stallDelta = after - before;
    check(stallDelta > 0.2 && stallDelta <= 87.0 / 250.0 + 0.02 && stallDelta > frameDelta * 2.0,
        [NSString stringWithFormat:@"500 ms stall is one capped step (delta %.3f, 60 Hz step %.3f)",
            stallDelta, frameDelta]);
    IsobarFieldRenderTestingSetNow(-1);

    // The injected clock may simulate a stall. The process clock must not:
    // a late frame eases one 60 Hz quantum, so the label set does not
    // depend on how long the render took.
    IsobarFieldRenderer *wall = MakeRenderer(device);
    wall.pressureSmoothDegrees = 0;
    wall.motion = [IsobarFieldMotion new];
    [wall setGrid:g];
    check(Upload(wall, 0, IsobarFieldPressure, flat) && Upload(wall, 1, IsobarFieldPressure, low),
        @"wall-clock field uploads");
    wall.motion = [IsobarFieldMotion new];
    CGImageRelease(Render(wall, 0, IsobarFieldPressure, YES, cam));
    CGImageRelease(Render(wall, 1, IsobarFieldPressure, YES, cam));
    usleep(400000);
    CGImageRelease(Render(wall, 1, IsobarFieldPressure, YES, cam));
    double wallStep = wall.motion.maxAnnotationAlphaStep;
    check(wallStep > 0.02 && wallStep <= 1000.0 / 60.0 / 250.0 + 0.02,
        [NSString stringWithFormat:@"a 400 ms wall stall eases one frame (step %.3f)", wallStep]);
    free(flat);
    free(low);
}

static void TestStaleIsobars(id<MTLDevice> device) {
    IsobarGeoGrid g = {.west = -40, .north = 30, .step = 2, .nLon = 16, .nLat = 12, .wrapsLongitude = NO};
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    float *b = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        float pa = (float)(1000 + row * 4);
        float pb = (float)(1000 + (g.nLat - 1 - row) * 4);
        for (int col = 0; col < g.nLon; col++) {
            a[row * g.nLon + col] = pa;
            b[row * g.nLon + col] = pb;
        }
    }
    IsobarCamera cam = Cam(18, -24, 4, 0, 280, 180);
    IsobarFieldRenderer *sync = MakeRenderer(device);
    sync.pressureSmoothDegrees = 0;
    sync.motion = nil;
    [sync setGrid:g];
    check(Upload(sync, 0, IsobarFieldPressure, a), @"sync field A uploads");
    CGImageRelease(Render(sync, 0, IsobarFieldPressure, YES, cam));
    uint64_t sigA = ContourSig(sync);
    check(Upload(sync, 0, IsobarFieldPressure, b), @"sync field B uploads");
    CGImageRelease(Render(sync, 0, IsobarFieldPressure, YES, cam));
    uint64_t sigB = ContourSig(sync);
    check(sigA != 0 && sigB != 0 && sigA != sigB,
        [NSString stringWithFormat:@"sync renders of the two fields differ (%llx %llx)", sigA, sigB]);

    IsobarFieldRenderer *async = [[IsobarFieldRenderer alloc] initWithDevice:device];
    async.pressureSmoothDegrees = 0;
    async.motion = nil;
    check(async != nil && async.synchronousContours == NO, @"stale-isobar renderer is async");
    [async setGrid:g];
    check(Upload(async, 0, IsobarFieldPressure, a), @"async field A uploads");
    uint64_t gotA = 0;
    for (int i = 0; i < 40 && gotA != sigA; i++) {
        CGImageRelease(Render(async, 0, IsobarFieldPressure, YES, cam));
        Pump(0.02);
        gotA = ContourSig(async);
    }
    check(gotA == sigA, [NSString stringWithFormat:@"async publishes field A (%llx vs %llx)", gotA, sigA]);
    check(Upload(async, 0, IsobarFieldPressure, b), @"async field B replaces A");
    BOOL oldLater = NO;
    uint64_t later = 0;
    for (int frame = 0; frame < 5; frame++) {
        CGImageRelease(Render(async, 0, IsobarFieldPressure, YES, cam));
        uint64_t sig = ContourSig(async);
        if (frame > 0 && sig == sigA) oldLater = YES;
        later = sig;
    }
    check(!oldLater, [NSString stringWithFormat:@"no frame after the first post-upload frame keeps field A (last %llx)", later]);
    uint64_t gotB = ContourSig(async);
    for (int i = 0; i < 40 && gotB != sigB; i++) {
        CGImageRelease(Render(async, 0, IsobarFieldPressure, YES, cam));
        Pump(0.02);
        gotB = ContourSig(async);
    }
    check(gotB == sigB, [NSString stringWithFormat:@"async settles on the sync render of field B (%llx vs %llx)", gotB, sigB]);
    free(a);
    free(b);
}

static void TestPickOrder(id<MTLDevice> device) {
    IsobarFieldRenderer *r = [[IsobarFieldRenderer alloc] initWithDevice:device];
    r.synchronousContours = YES;
    r.pressureSmoothDegrees = 0;
    IsobarGeoGrid g = {.west = -20, .north = 20, .step = 2, .nLon = 16, .nLat = 12, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) v[i] = 1013;
    check(Upload(r, 0, IsobarFieldPressure, v), @"pick-order field uploads");
    free(v);
    IsobarCamera camA = Cam(0, 10, 2, 0, 80, 60);
    IsobarCamera camB = Cam(0, 30, 2, 0, 80, 60);
    id<MTLCommandQueue> queue = [device newCommandQueue];
    id<MTLTexture> texA = ColourTarget(device, 80, 60);
    id<MTLTexture> texB = ColourTarget(device, 80, 60);
    id<MTLCommandBuffer> bufA = [queue commandBuffer];
    id<MTLCommandBuffer> bufB = [queue commandBuffer];
    check(Encode(r, bufA, texA, 0, camA, NO) && Encode(r, bufB, texB, 0, camB, NO), @"two frames encode");
    [bufB commit];
    [bufB waitUntilCompleted];
    for (int i = 0; i < 20; i++) {
        Pump(0.01);
        IsobarCamera got;
        if ([r latestFrameCamera:&got] && CamEq(got, camB)) break;
    }
    [bufA commit];
    [bufA waitUntilCompleted];
    for (int i = 0; i < 20; i++) Pump(0.01);
    IsobarCamera got;
    BOOL published = [r latestFrameCamera:&got];
    check(published && CamEq(got, camB),
        [NSString stringWithFormat:@"pick uses the newer frame (lat %.1f lon %.1f)", got.centreLat, got.centreLon]);
    double lat = 0, lon = 999;
    BOOL picked = [r pickLatitude:&lat longitude:&lon atX:40 y:30 camera:got];
    check(picked && fabs(lat - camB.centreLat) < 2.0 && LonErr(lon, camB.centreLon) < 2.0,
        [NSString stringWithFormat:@"pick of the published camera is that frame (%.2f, %.2f)", lat, lon]);
}

static void TestPlaybackCost(id<MTLDevice> device) {
    IsobarFieldRenderer *r = MakeRenderer(device);
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = -30, .north = 20, .step = 1, .nLon = 24, .nLat = 20, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *a = malloc(sizeof(float) * (size_t)n);
    float *b = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        for (int col = 0; col < g.nLon; col++) {
            double lat = g.north - row * g.step;
            double lon = g.west + col * g.step;
            a[row * g.nLon + col] = (float)(1010 + 8 * sin(lat * 0.4) + 6 * sin(lon * 0.3));
            b[row * g.nLon + col] = (float)(1014 + 8 * sin(lat * 0.4) + 6 * sin(lon * 0.3));
        }
    }
    check(Upload(r, 0, IsobarFieldPressure, a) && Upload(r, 1, IsobarFieldPressure, b), @"playback field uploads");
    free(a);
    free(b);
    IsobarCamera cam = Cam(10, -18, 3, 0, 320, 200);
    CGImageRelease(Render(r, 0.2, IsobarFieldPressure, YES, cam));
    NSUInteger searches = r.centreSearches;
    NSUInteger projs = r.mainProjections;
    NSInteger lines = r.contourLineCount;
    check(lines > 0 && searches > 0, @"the first mix of a step pair searches centres");
    CGImageRelease(Render(r, 0.35, IsobarFieldPressure, YES, cam));
    CGImageRelease(Render(r, 0.7, IsobarFieldPressure, YES, cam));
    check(r.centreSearches == searches,
        [NSString stringWithFormat:@"mixes of the same steps carry centres (%lu searches, was %lu)",
            (unsigned long)r.centreSearches, (unsigned long)searches]);
    check(r.mainProjections == projs,
        [NSString stringWithFormat:@"a new set for the same camera is not reprojected on main (%lu, was %lu)",
            (unsigned long)r.mainProjections, (unsigned long)projs]);
    check(r.contourLineCount > 0, @"carried frames still draw isobars");
    cam.centreLon += 4;
    CGImageRelease(Render(r, 0.7, IsobarFieldPressure, YES, cam));
    check(r.mainProjections > projs, @"a moved camera reprojects on main");
}

static void TestAsyncContourTime(id<MTLDevice> device) {
    IsobarFieldRenderer *r = [[IsobarFieldRenderer alloc] initWithDevice:device];
    check(r.synchronousContours == NO, @"contour-time renderer is async");
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    IsobarGeoGrid g = {.west = 0, .north = 40, .step = 1, .nLon = 36, .nLat = 28, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    for (int row = 0; row < g.nLat; row++) {
        float p = (float)(1000 + row);
        for (int col = 0; col < g.nLon; col++) v[row * g.nLon + col] = p;
    }
    check(Upload(r, 0, IsobarFieldPressure, v), @"async timing field uploads");
    free(v);
    IsobarCamera cam = Cam(26, 18, 2, 0, 240, 160);
    CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, cam));
    check(r.lastContourMilliseconds == 0, @"the frame that only starts the build reports no time yet");
    double ms = 0;
    NSInteger lines = 0;
    for (int i = 0; i < 40; i++) {
        Pump(0.02);
        CGImageRelease(Render(r, 0, IsobarFieldPressure, YES, cam));
        ms = r.lastContourMilliseconds;
        lines = r.contourLineCount;
        if (ms > 0 && lines > 0) break;
    }
    check(ms > 0 && lines > 0,
        [NSString stringWithFormat:@"adopting a set reports its build time (%.3f ms, %ld lines)", ms, (long)lines]);
}

static void TestRing(id<MTLDevice> device) {
    IsobarGeoGrid g = {.west = -30, .north = 16, .step = 2, .nLon = 16, .nLat = 16, .wrapsLongitude = NO};
    int n = g.nLon * g.nLat;
    float *band[4];
    double lat0[4] = {6, 2, -2, -6};
    for (int s = 0; s < 4; s++) {
        band[s] = malloc(sizeof(float) * (size_t)n);
        FillLatBand(band[s], g, lat0[s]);
    }
    IsobarCamera cam = Cam(0, -14, 8, 0, 96, 48);
    IsobarFieldRenderer *sync = MakeRenderer(device);
    sync.pressureSmoothDegrees = 0;
    sync.motion = nil;
    [sync setGrid:g];
    BOOL up = YES;
    for (int s = 0; s < 4; s++) up = up && Upload(sync, s, IsobarFieldPressure, band[s]);
    check(up, @"ring reference uploads");
    uint64_t expect[4] = {0};
    BOOL distinct = YES;
    for (int s = 0; s < 4; s++) {
        id<MTLTexture> tex = ColourTarget(device, 96, 48);
        NSError *error = nil;
        BOOL ok = [sync renderTime:s fill:IsobarFieldPressure isobars:YES camera:cam toTexture:tex error:&error];
        expect[s] = ok ? InkRows(tex) : 0;
        if (!ok || expect[s] == 0) distinct = NO;
    }
    for (int s = 0; s < 4 && distinct; s++)
        for (int t = s + 1; t < 4; t++)
            if (expect[s] == expect[t]) distinct = NO;
    check(distinct, [NSString stringWithFormat:@"four fields leave different ink (%llx %llx %llx %llx)",
        expect[0], expect[1], expect[2], expect[3]]);

    IsobarFieldRenderer *r = MakeRenderer(device);
    r.pressureSmoothDegrees = 0;
    r.motion = nil;
    [r setGrid:g];
    up = YES;
    for (int s = 0; s < 4; s++) up = up && Upload(r, s, IsobarFieldPressure, band[s]);
    check(up, @"ring field uploads");
    id<MTLCommandQueue> queue = [device newCommandQueue];
    id<MTLTexture> tex[4];
    id<MTLCommandBuffer> buf[4];
    BOOL encoded = YES;
    for (int s = 0; s < 3; s++) {
        tex[s] = ColourTarget(device, 96, 48);
        buf[s] = [queue commandBuffer];
        encoded = encoded && Encode(r, buf[s], tex[s], s, cam, YES);
    }
    check(encoded, @"three frames encode without committing");
    [buf[2] commit];
    [buf[2] waitUntilCompleted];
    tex[3] = ColourTarget(device, 96, 48);
    buf[3] = [queue commandBuffer];
    check(Encode(r, buf[3], tex[3], 3, cam, YES), @"a fourth frame encodes after one completion");
    [buf[3] commit];
    [buf[0] commit];
    [buf[1] commit];
    [buf[0] waitUntilCompleted];
    [buf[1] waitUntilCompleted];
    [buf[3] waitUntilCompleted];
    BOOL exclusive = YES;
    for (int s = 0; s < 4; s++) {
        uint64_t got = InkRows(tex[s]);
        if (got != expect[s]) exclusive = NO;
    }
    check(exclusive, [NSString stringWithFormat:@"out-of-order completion keeps slots exclusive (%llx %llx %llx %llx)",
        InkRows(tex[0]), InkRows(tex[1]), InkRows(tex[2]), InkRows(tex[3])]);

    IsobarFieldRenderer *hold = MakeRenderer(device);
    hold.pressureSmoothDegrees = 0;
    [hold setGrid:g];
    check(Upload(hold, 0, IsobarFieldPressure, band[0]), @"uncommitted-ring field uploads");
    id<MTLCommandQueue> holdQ = [device newCommandQueue];
    id<MTLCommandBuffer> heldBuf[3];
    id<MTLTexture> heldTex[3];
    BOOL held = YES;
    for (int s = 0; s < 3; s++) {
        heldBuf[s] = [holdQ commandBuffer];
        heldTex[s] = ColourTarget(device, 96, 48);
        held = held && Encode(hold, heldBuf[s], heldTex[s], 0, cam, NO);
    }
    check(held, @"three encodes hold the ring");
    fprintf(stderr, "ring 4th encode\n");
    NSDate *t0 = [NSDate date];
    id<MTLCommandBuffer> b4 = [holdQ commandBuffer];
    id<MTLTexture> t4 = ColourTarget(device, 96, 48);
    BOOL fourth = Encode(hold, b4, t4, 0, cam, NO);
    double waited = -[t0 timeIntervalSinceNow] * 1000.0;
    check(fourth && waited < 100.0 && hold.ringFallbacks >= 1,
        [NSString stringWithFormat:@"4th uncommitted encode returns in %.1f ms (fallbacks %lu)",
            waited, (unsigned long)hold.ringFallbacks]);
    for (int s = 0; s < 4; s++) free(band[s]);
}

static void TestSlice5b(void) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) {
        check(NO, @"Metal device");
        return;
    }
    TestFadeUnits(device);
    TestStaleIsobars(device);
    TestPickOrder(device);
    TestPlaybackCost(device);
    TestAsyncContourTime(device);
    TestRing(device);
}

static int LongestEdgeRun(IsobarFieldRenderer *r, double west, double east, double south, double north, double tol) {
    int longest = 0;
    for (NSInteger line = 0; line < r.contourLineCount; line++) {
        NSInteger n = [r contourVertexCountForLine:line];
        int run = 0;
        for (NSInteger i = 0; i < n; i++) {
            double lat = 0, lon = 0;
            if (![r contourVertexForLine:line index:i latitude:&lat longitude:&lon]) continue;
            BOOL edge = lat >= north - tol || lat <= south + tol || lon <= west + tol || lon >= east - tol;
            if (edge) run++;
            else { if (run > longest) longest = run; run = 0; }
        }
        if (run > longest) longest = run;
    }
    return longest;
}

static void TestCoverageEdge(IsobarFieldRenderer *r) {
    r.synchronousContours = YES;
    r.pressureSmoothDegrees = 0;
    IsobarGeoGrid g = {.west = 110, .north = -10, .step = 1, .nLon = 8, .nLat = 6, .wrapsLongitude = NO};
    [r setGrid:g];
    float *v = calloc((size_t)g.nLon * (size_t)g.nLat, sizeof(float));
    for (int i = 0; i < g.nLon * g.nLat; i++) v[i] = 1030;
    for (int col = 0; col < g.nLon; col++) v[col] = (col % 2) ? 1024 : 1008;
    check(Upload(r, 0, IsobarFieldPressure, v), @"coverage-edge field uploads");
    free(v);
    IsobarCamera cam = Cam(-12.5, 113.5, 8, 0, 400, 300);
    CGImageRef image = Render(r, 0, IsobarFieldPressure, YES, cam);
    check(image != nil, @"coverage-edge frame draws");
    if (image) CGImageRelease(image);
    double south = g.north - (g.nLat - 1) * g.step;
    double east = g.west + (g.nLon - 1) * g.step;
    int run = LongestEdgeRun(r, g.west, east, south, g.north, g.step * 0.02);
    check(run <= 1, [NSString stringWithFormat:@"an isobar ends at the coverage edge instead of walking along it (run %d, lines %ld)",
        run, (long)r.contourLineCount]);

    float *cross = calloc((size_t)g.nLon * (size_t)g.nLat, sizeof(float));
    for (int row = 0; row < g.nLat; row++)
        for (int col = 0; col < g.nLon; col++)
            cross[row * g.nLon + col] = 1000.0f + (float)col * 8.0f;
    check(Upload(r, 0, IsobarFieldPressure, cross), @"crossing field uploads");
    free(cross);
    image = Render(r, 0, IsobarFieldPressure, YES, cam);
    check(image != nil && r.contourLineCount >= 1, @"a contour that only meets the edge still draws");
    if (image) CGImageRelease(image);
    BOOL interior = NO;
    for (NSInteger line = 0; line < r.contourLineCount; line++) {
        NSInteger n = [r contourVertexCountForLine:line];
        if (n < 4) continue;
        for (NSInteger i = 0; i < n; i++) {
            double lat = 0, lon = 0;
            [r contourVertexForLine:line index:i latitude:&lat longitude:&lon];
            if (lat < g.north - g.step && lat > south + g.step && lon > g.west + g.step && lon < east - g.step)
                interior = YES;
        }
    }
    check(interior, @"dropping the coverage-edge walk keeps the contour inside the grid");
}

// Owner, 7 Oct 2026: with the temperature field on, "the continental
// outline is really hard to see". Popover zoom at 2x, isobars off. Along
// the mainland coast, wherever a clean plate shows land on one side and sea
// on the other, each field must leave: a coast line wider than the old 1 px
// hairline that contrasts in luminance with both neighbours, and
// land and sea that still differ (CIE76 ΔE). The light plate's land and sea
// differ in hue, not luminance (0.84 vs 0.87), so plate survival is a colour
// difference. Temperature must also leave the sea reading as sea: a warm sea
// pixel nearer the sea plate than the land plate.
typedef struct { double x, y, nx, ny; } CoastProbe;

static void LabOf(int r, int g, int b, double lab[3]) {
    double c[3] = {r / 255.0, g / 255.0, b / 255.0};
    for (int i = 0; i < 3; i++) c[i] = c[i] <= 0.04045 ? c[i] / 12.92 : pow((c[i] + 0.055) / 1.055, 2.4);
    double X = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047;
    double Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    double Z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
    double f[3] = {X, Y, Z};
    for (int i = 0; i < 3; i++) f[i] = f[i] > 0.008856 ? cbrt(f[i]) : 7.787 * f[i] + 16.0 / 116.0;
    lab[0] = 116 * f[1] - 16;
    lab[1] = 500 * (f[0] - f[1]);
    lab[2] = 200 * (f[1] - f[2]);
}

static double DeltaE(int r0, int g0, int b0, int r1, int g1, int b1) {
    double a[3], b[3];
    LabOf(r0, g0, b0, a);
    LabOf(r1, g1, b1, b);
    return sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
}

// Bilinear luma of the encoded pixels. The offscreen target blends in
// encoded sRGB, so the ink integral is the stroke's width in pixels.
static double LumAt(Image im, double x, double y) {
    int x0 = (int)floor(x - 0.5), y0 = (int)floor(y - 0.5);
    double tx = x - 0.5 - x0, ty = y - 0.5 - y0;
    double acc = 0;
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            int r, g, b;
            At(im, x0 + dx, y0 + dy, &r, &g, &b);
            if (r < 0) return NAN;
            acc += (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (0.2126 * r + 0.7152 * g + 0.0722 * b);
        }
    }
    return acc;
}

static void RGBAt(Image im, double x, double y, int *r, int *g, int *b) { At(im, Pix(x), Pix(y), r, g, b); }


// The hazard layer composited over a render: severe-risk CB (the densest
// hatch and both scalloped outlines) over the whole mainland box, so the coast
// sits under hatch everywhere.
static CGImageRef WithHazards(CGImageRef image, IsobarCamera cam, BOOL dark, double scale) {
    static IsobarHazardFrame *frame;
    if (!frame) {
        IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO};
        IsobarHazardRun *run = [[IsobarHazardRun alloc] initWithGrid:g times:@[[NSDate dateWithTimeIntervalSince1970:0]]];
        size_t n = (size_t)g.nLon * g.nLat;
        float *c = calloc(n, 4), *rain = calloc(n, 4), *k = calloc(n, 4);
        Paint(c, g.nLon, g.nLat, g.west, g.north, g.step, -9, -45, 110, 156, 2000);
        Paint(rain, g.nLon, g.nLat, g.west, g.north, g.step, -9, -45, 110, 156, 5);
        Paint(k, g.nLon, g.nLat, g.west, g.north, g.step, -9, -45, 110, 156, 100);
        [run setStep:0 mucape:c rain3h:rain cloud:k gust:NULL mslp:NULL t850:NULL t2m:NULL u10:NULL v10:NULL];
        free(c); free(rain); free(k);
        frame = [run frameAtStep:0];
    }
    size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
    CGContextTranslateCTM(ctx, 0, h);
    CGContextScaleCTM(ctx, 1, -1);
    IsobarHazardDraw(ctx, frame, nil, nil, cam, scale, dark, NO, nil);
    CGImageRef out = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    return out;
}

static void TestCoastOverFields(IsobarFieldRenderer *r) {
    NSString *path = [NSString stringWithUTF8String:getenv("ISOBAR_COAST") ?: "Resources/ownchart-coast.bin"];
    OwnCoast coast = OwnCoastParse([NSData dataWithContentsOfFile:path]);
    check(coast.rings > 0, @"coast-over-field check loads the coastline");
    if (coast.rings < 1) return;
    int mainRing = 0;
    for (int i = 1; i < coast.rings; i++) if (coast.ringCount[i] > coast.ringCount[mainRing]) mainRing = i;
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO};
    [r setGrid:g];
    double savedScale = r.contentScale;
    r.contentScale = 2;
    // About the owner's popover map: 1600 px wide at 2x, ~38 px per degree.
    IsobarCamera cam = Cam(-27, 133, 6.8, 0, 1600, 1360);
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    CoastProbe *probes = malloc(sizeof(CoastProbe) * (size_t)coast.ringCount[mainRing]);
    double *width = malloc(sizeof(double) * (size_t)coast.ringCount[mainRing]);
    if (!v || !probes || !width) { free(v); free(probes); free(width); OwnCoastFree(coast); return; }
    for (int dark = 0; dark < 2; dark++) {
        r.chartDark = dark;
        OwnChartPalette plate = OwnChartPaletteFor(dark);
        IsobarRGB landPlate = {plate.land.r, plate.land.g, plate.land.b};
        IsobarRGB seaPlate = {plate.sea.r, plate.sea.g, plate.sea.b};
        int coastL = Lum(Chan(plate.coast.r), Chan(plate.coast.g), Chan(plate.coast.b));
        // Probes: coast vertices whose plate shows land 7 px one way and sea
        // 7 px the other. The normal is flipped to point at the land.
        for (int i = 0; i < n; i++) v[i] = 1013;
        Upload(r, 0, IsobarFieldPressure, v);
        CGImageRef image = Render(r, 0, IsobarFieldPressure, NO, cam);
        Image im = {0};
        BOOL ok = image && ImageFrom(image, &im);
        CGImageRelease(image);
        if (!ok) { check(NO, @"coast plate renders"); continue; }
        int start = coast.ringStart[mainRing], count = coast.ringCount[mainRing], nProbe = 0;
        for (int k = 4; k < count - 4; k += 2) {
            double ax, ay, bx, by, px, py;
            if (!IsobarCameraProject(cam, coast.lat[start + k - 4], coast.lon[start + k - 4], &ax, &ay) ||
                !IsobarCameraProject(cam, coast.lat[start + k + 4], coast.lon[start + k + 4], &bx, &by) ||
                !IsobarCameraProject(cam, coast.lat[start + k], coast.lon[start + k], &px, &py)) continue;
            double tx = bx - ax, ty = by - ay, len = hypot(tx, ty);
            if (len < 6 || len > 60) continue;
            double nx = -ty / len, ny = tx / len;
            // A straight run only: the vertex sits on the chord.
            if (fabs((px - ax) * nx + (py - ay) * ny) > 1.5) continue;
            int r1, g1, b1, r2, g2, b2;
            RGBAt(im, px + nx * 7, py + ny * 7, &r1, &g1, &b1);
            RGBAt(im, px - nx * 7, py - ny * 7, &r2, &g2, &b2);
            BOOL landA = NearRGB(r1, g1, b1, landPlate, 4) && NearRGB(r2, g2, b2, seaPlate, 4);
            BOOL landB = NearRGB(r2, g2, b2, landPlate, 4) && NearRGB(r1, g1, b1, seaPlate, 4);
            if (!landA && !landB) continue;
            if (landB) { nx = -nx; ny = -ny; }
            probes[nProbe++] = (CoastProbe){px, py, nx, ny};
        }
        ImageFree(&im);
        check(nProbe >= 40, [NSString stringWithFormat:@"%s plate has clean land/sea coast probes (%d)",
            dark ? "dark" : "light", nProbe]);
        if (nProbe < 40) continue;
        struct { IsobarFieldKind kind; double value; const char *name; } fields[] = {
            {IsobarFieldPressure, 1013, "plate"},
            {IsobarFieldTemperature, 0, "0 C"}, {IsobarFieldTemperature, 12, "12 C"},
            {IsobarFieldTemperature, 20, "20 C"}, {IsobarFieldTemperature, 28, "28 C"},
            {IsobarFieldTemperature, 35, "35 C"}, {IsobarFieldTemperature, 40, "40 C"},
            {IsobarFieldRain, 1, "rain 1"}, {IsobarFieldRain, 5, "rain 5"},
            {IsobarFieldRain, 15, "rain 15"}, {IsobarFieldRain, 40, "rain 40"},
            {IsobarFieldWindSpeed, 10, "wind 10"}, {IsobarFieldWindSpeed, 20, "wind 20"},
            {IsobarFieldWindSpeed, 35, "wind 35"}, {IsobarFieldWindSpeed, 60, "wind 60"},
            {IsobarFieldPressure, 1013, "plate + CB hazard"}, {IsobarFieldRain, 5, "rain 5 + CB hazard"},
            {IsobarFieldTemperature, 28, "28 C + CB hazard"},
        };
        for (size_t f = 0; f < sizeof fields / sizeof fields[0]; f++) {
            for (int i = 0; i < n; i++) v[i] = (float)fields[f].value;
            Upload(r, 0, fields[f].kind, v);
            image = Render(r, 0, fields[f].kind, NO, cam);
            if (image && strstr(fields[f].name, "CB hazard")) {
                CGImageRef hatched = WithHazards(image, cam, dark, 2);
                CGImageRelease(image);
                image = hatched;
            }
            ok = image && ImageFrom(image, &im);
            CGImageRelease(image);
            if (!ok) { check(NO, @"coast field renders"); continue; }
            int contrastOK = 0, measured = 0;
            double sumDE = 0, seaMargin = 0, landMargin = 0;
            for (int p = 0; p < nProbe; p++) {
                CoastProbe q = probes[p];
                int lr, lg, lb, sr, sg, sb;
                RGBAt(im, q.x + q.nx * 7, q.y + q.ny * 7, &lr, &lg, &lb);
                RGBAt(im, q.x - q.nx * 7, q.y - q.ny * 7, &sr, &sg, &sb);
                if (lr < 0 || sr < 0) continue;
                double landL = Lum(lr, lg, lb), seaL = Lum(sr, sg, sb);
                // Integrated ink along the normal against each side's own ground.
                double ink = 0, core = NAN;
                for (double t = -3; t <= 3 + 1e-9; t += 0.25) {
                    double L = LumAt(im, q.x + q.nx * t, q.y + q.ny * t);
                    if (isnan(L)) continue;
                    double ground = t >= 0 ? landL : seaL;
                    double span = coastL - ground;
                    double frac = fabs(span) < 8 ? 0 : (L - ground) / span;
                    ink += fmin(1, fmax(0, frac)) * 0.25;
                }
                for (int d = -1; d <= 1; d++) {
                    int cr, cg, cb;
                    RGBAt(im, q.x + q.nx * d * 0.5, q.y + q.ny * d * 0.5, &cr, &cg, &cb);
                    if (cr < 0) continue;
                    double L = Lum(cr, cg, cb);
                    if (isnan(core) || fabs(L - coastL) < fabs(core - coastL)) core = L;
                }
                width[measured++] = ink;
                if (fabs(core - landL) >= 100 && fabs(core - seaL) >= 100) contrastOK++;
                sumDE += DeltaE(lr, lg, lb, sr, sg, sb);
                int lpr = Chan(landPlate.r), lpg = Chan(landPlate.g), lpb = Chan(landPlate.b);
                int spr = Chan(seaPlate.r), spg = Chan(seaPlate.g), spb = Chan(seaPlate.b);
                seaMargin += DeltaE(sr, sg, sb, lpr, lpg, lpb) - DeltaE(sr, sg, sb, spr, spg, spb);
                landMargin += DeltaE(lr, lg, lb, spr, spg, spb) - DeltaE(lr, lg, lb, lpr, lpg, lpb);
            }
            ImageFree(&im);
            if (measured < 1) { check(NO, @"coast probes measured"); continue; }
            for (int a = 1; a < measured; a++) {
                double key = width[a];
                int b = a - 1;
                while (b >= 0 && width[b] > key) { width[b + 1] = width[b]; b--; }
                width[b + 1] = key;
            }
            double medianW = width[measured / 2];
            double meanDE = sumDE / measured;
            const char *mode = dark ? "dark" : "light";
            // Joins and antialiasing add about half a pixel to the integral: the
            // old 1 px hairline measures 2.0 here, the 1.44 px line about 2.4.
            check(medianW >= 2.2, [NSString stringWithFormat:
                @"%s %s: the coast is a solid line, %.2f px of integrated ink at 2x (>= 2.2)", mode, fields[f].name, medianW]);
            check(contrastOK >= measured * 9 / 10, [NSString stringWithFormat:
                @"%s %s: the coast contrasts with land and sea at %d of %d probes", mode, fields[f].name,
                contrastOK, measured]);
            check(meanDE >= 20, [NSString stringWithFormat:
                @"%s %s: land and sea still differ beside the coast (ΔE %.1f >= 20)", mode, fields[f].name, meanDE]);
            if (fields[f].kind == IsobarFieldTemperature) {
                check(seaMargin / measured >= 8 && landMargin / measured >= 3, [NSString stringWithFormat:
                    @"%s %s: sea still reads as sea and land as land (margins %.1f, %.1f)", mode, fields[f].name,
                    seaMargin / measured, landMargin / measured]);
            }
        }
    }
    r.chartDark = NO;
    r.contentScale = savedScale;
    free(v);
    free(probes);
    free(width);
    OwnCoastFree(coast);
}

// The field colours are composited over the chart plates in the renderer. Keep
// this as a pixel test so a ramp cannot pass by looking distinct in isolation
// while disappearing against either plate in the actual map.
static void TestFieldContrast(IsobarFieldRenderer *r) {
    IsobarGeoGrid g = {.west = 95, .north = 0, .step = 0.25, .nLon = 301, .nLat = 201, .wrapsLongitude = NO};
    [r setGrid:g];
    int n = g.nLon * g.nLat;
    float *v = malloc(sizeof(float) * (size_t)n);
    check(v != NULL, @"field contrast allocates");
    if (!v) return;
    IsobarCamera cam = Cam(-25, 132.5, 4, 0, 601, 401);
    struct { double lat, lon; const char *name; } probes[] = {
        {-25, 133, "land"}, {-42, 110, "sea"},
    };
    struct { IsobarFieldKind kind; double value; double minimum; const char *name; } fields[] = {
        {IsobarFieldRain, 5, 15, "rain 5 mm"},
        {IsobarFieldWindSpeed, 20, 12, "wind 20 kt"},
        {IsobarFieldTemperature, 0, 10, "850 hPa 0 C"},
        {IsobarFieldTemperature, 10, 10, "850 hPa 10 C"},
        {IsobarFieldTemperature, 20, 10, "850 hPa 20 C"},
    };
    for (int dark = 0; dark < 2; dark++) {
        r.chartDark = dark;
        for (size_t p = 0; p < sizeof probes / sizeof probes[0]; p++) {
            for (int i = 0; i < n; i++) v[i] = 1013;
            check(Upload(r, 0, IsobarFieldPressure, v), @"contrast plate uploads");
            CGImageRef plateImage = Render(r, 0, IsobarFieldPressure, NO, cam);
            Image plate = {0};
            BOOL plateOK = plateImage && ImageFrom(plateImage, &plate);
            CGImageRelease(plateImage);
            int pr = -1, pg = -1, pb = -1;
            if (plateOK) ReadAt(plate, cam, probes[p].lat, probes[p].lon, &pr, &pg, &pb);
            check(plateOK && pr >= 0, [NSString stringWithFormat:@"%s %s plate renders",
                dark ? "dark" : "light", probes[p].name]);
            for (size_t f = 0; f < sizeof fields / sizeof fields[0]; f++) {
                for (int i = 0; i < n; i++) v[i] = (float)fields[f].value;
                check(Upload(r, 0, fields[f].kind, v), @"contrast field uploads");
                CGImageRef image = Render(r, 0, fields[f].kind, NO, cam);
                Image field = {0};
                BOOL ok = image && ImageFrom(image, &field);
                CGImageRelease(image);
                int fr = -1, fg = -1, fb = -1;
                if (ok) ReadAt(field, cam, probes[p].lat, probes[p].lon, &fr, &fg, &fb);
                double de = (ok && plateOK) ? DeltaE(fr, fg, fb, pr, pg, pb) : 0;
                check(ok && de >= fields[f].minimum, [NSString stringWithFormat:
                    @"%s %s %s separates from its plate (DeltaE %.1f >= %.1f)",
                    dark ? "dark" : "light", probes[p].name, fields[f].name, de, fields[f].minimum]);
                ImageFree(&field);
            }
            ImageFree(&plate);
        }

        // A trace of rain below the display threshold must remain transparent
        // over both plates; this catches accidental alpha or colour leakage.
        for (size_t p = 0; p < sizeof probes / sizeof probes[0]; p++) {
            for (int i = 0; i < n; i++) v[i] = 0.09f;
            check(Upload(r, 0, IsobarFieldRain, v), @"dry rain uploads");
            CGImageRef image = Render(r, 0, IsobarFieldRain, NO, cam);
            Image dry = {0};
            BOOL ok = image && ImageFrom(image, &dry);
            CGImageRelease(image);
            int dr = -1, dg = -1, db = -1;
            if (ok) ReadAt(dry, cam, probes[p].lat, probes[p].lon, &dr, &dg, &db);
            for (int i = 0; i < n; i++) v[i] = 1013;
            Upload(r, 0, IsobarFieldPressure, v);
            image = Render(r, 0, IsobarFieldPressure, NO, cam);
            Image plate = {0};
            BOOL plateOK = image && ImageFrom(image, &plate);
            CGImageRelease(image);
            int pr = -1, pg = -1, pb = -1;
            if (plateOK) ReadAt(plate, cam, probes[p].lat, probes[p].lon, &pr, &pg, &pb);
            double de = (ok && plateOK) ? DeltaE(dr, dg, db, pr, pg, pb) : 99;
            check(ok && plateOK && de <= 1.5, [NSString stringWithFormat:
                @"%s %s rain 0.09 mm remains transparent (DeltaE %.1f <= 1.5)",
                dark ? "dark" : "light", probes[p].name, de]);
            ImageFree(&dry);
            ImageFree(&plate);
        }
    }
    r.chartDark = NO;
    free(v);
}

// A coarser archive of the supported Australian extent must retain the
// appearance-aware geographic plate rather than a light pressure gradient.
static void TestCoarsePressureAppearance(IsobarFieldRenderer *r) {
    IsobarGeoGrid grid = {.west=95, .north=0, .step=1, .nLon=76, .nLat=51};
    [r setGrid:grid];
    float *values = malloc(sizeof(float) * grid.nLon * grid.nLat);
    if (!values) { check(NO, @"coarse pressure fixture allocates"); return; }
    for (int j=0; j<grid.nLat; j++) for (int i=0; i<grid.nLon; i++)
        values[j*grid.nLon+i] = 1000 + i * .3;
    check(Upload(r, 0, IsobarFieldPressure, values), @"coarse pressure uploads");
    free(values);
    for (int dark=0; dark<2; dark++) {
        r.chartDark=dark;
        OwnChartPalette palette=OwnChartPaletteFor(dark);
        for (int tilt=0; tilt<2; tilt++) {
            IsobarCamera camera=Cam(-25,132.5,4,tilt,640,480); camera.pitch=tilt*.6;
            CGImageRef plainImage=Render(r,0,IsobarFieldPressure,NO,camera);
            Image plain={0}, chart={0};
            BOOL plainOK=plainImage && ImageFrom(plainImage,&plain);
            if (plainImage) CGImageRelease(plainImage);
            struct {double lat,lon;OwnRGB colour;const char *name;} probes[]={
                {-25,133,palette.land,"land"},{-25,110,palette.sea,"sea"}};
            for (int p=0;p<2;p++) {
                int red=-1,green=-1,blue=-1;
                if (plainOK) ReadAt(plain,camera,probes[p].lat,probes[p].lon,&red,&green,&blue);
                OwnRGB expected=probes[p].colour;
                check(plainOK && NearRGB(red,green,blue,(IsobarRGB){expected.r,expected.g,expected.b},4),
                    [NSString stringWithFormat:@"1-degree %s %s %s uses its geographic plate (%d %d %d)",
                    dark?"dark":"light",tilt?"tilted":"flat",probes[p].name,red,green,blue]);
            }
            CGImageRef chartImage=Render(r,0,IsobarFieldPressure,YES,camera);
            BOOL chartOK=chartImage && ImageFrom(chartImage,&chart);
            if (chartImage) CGImageRelease(chartImage);
            NSUInteger readable=0;
            if (plainOK && chartOK && plain.w==chart.w && plain.h==chart.h)
                for (int y=0;y<plain.h;y++) for (int x=0;x<plain.w;x++) {
                    int ar,ag,ab,br,bg,bb;
                    At(plain,x,y,&ar,&ag,&ab);At(chart,x,y,&br,&bg,&bb);
                    int contrast=Lum(br,bg,bb)-Lum(ar,ag,ab);
                    if (dark?contrast>100:contrast< -100) readable++;
                }
            check(readable>100,[NSString stringWithFormat:@"1-degree %s %s pressure contours contrast with plate (%lu pixels)",
                dark?"dark":"light",tilt?"tilted":"flat",(unsigned long)readable]);
            ImageFree(&plain);ImageFree(&chart);
        }
    }
    r.chartDark=NO;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc>1 && strcmp(argv[1], "--camera-labels")==0) {
            IsobarFieldRenderer *renderer=MakeRenderer(MTLCreateSystemDefaultDevice());
            if (!renderer) return 1;
            TestCameraMotionLabels(renderer);
            return failures ? 1 : 0;
        }
        BOOL asyncOnly = NO, sliceOnly = NO, coastOnly = NO, contrastOnly = NO, notesOnly = NO, tiltOnly = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--async") == 0) asyncOnly = YES;
            if (strcmp(argv[i], "--tilt") == 0) tiltOnly = YES;
            if (strcmp(argv[i], "--slice") == 0) sliceOnly = YES;
            if (strcmp(argv[i], "--coast") == 0) coastOnly = YES;
            if (strcmp(argv[i], "--contrast") == 0) contrastOnly = YES;
            if (strcmp(argv[i], "--annotations") == 0) notesOnly = YES;
        }
        if (notesOnly) {
            id<MTLDevice> notesDevice = MTLCreateSystemDefaultDevice();
            if (!notesDevice) {
                printf("SKIP no Metal device\n");
                return failures ? 1 : 0;
            }
            IsobarFieldRenderer *notes = MakeRenderer(notesDevice);
            if (!notes) {
                fprintf(stderr, "FAIL Metal device exists but the field renderer did not compile\n");
                return 1;
            }
            TestAnnotations(notes);
            fprintf(stderr, "%s\n", failures ? "FAILED" : "ok");
            return failures ? 1 : 0;
        }
        if (coastOnly) {
            IsobarFieldRenderer *coast = MakeRenderer(nil);
            if (coast) TestCoastOverFields(coast);
            else check(NO, @"field renderer compiles");
            fprintf(stderr, "%s\n", failures ? "FAILED" : "ok");
            return failures ? 1 : 0;
        }
        if (sliceOnly) {
            TestSlice5b();
            fprintf(stderr, "%s\n", failures ? "FAILED" : "ok");
            return failures ? 1 : 0;
        }
        if (asyncOnly) {
            TestAsyncStress();
            fprintf(stderr, "%s\n", failures ? "FAILED" : "ok");
            return failures ? 1 : 0;
        }
        if (contrastOnly) {
            id<MTLDevice> contrastDevice = MTLCreateSystemDefaultDevice();
            if (!contrastDevice) {
                fprintf(stderr, "SKIP --contrast no Metal device\n");
                return 0;
            }
            IsobarFieldRenderer *contrast = MakeRenderer(nil);
            if (contrast) { TestFieldContrast(contrast); TestCoarsePressureAppearance(contrast); }
            else check(NO, @"field renderer compiles");
            fprintf(stderr, "%s\n", failures ? "FAILED" : "ok");
            return failures ? 1 : 0;
        }
        TestCamera();
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            printf("SKIP no Metal device\n");
            return failures ? 1 : 0;
        }
        IsobarFieldRenderer *renderer = MakeRenderer(nil);
        if (!renderer) {
            fprintf(stderr, "FAIL Metal device exists but the field renderer did not compile\n");
            return 1;
        }
        if (tiltOnly) { TestTiltedMetalPick(renderer); return failures ? 1 : 0; }
        TestCoverageEdge(renderer);
        TestAustralia(renderer);
        TestColourAndCoast(renderer);
        TestCoastOverFields(renderer);
        TestFieldContrast(renderer);
        TestCoarsePressureAppearance(renderer);
        TestRainDisplay(renderer);
        TestTimeAndIsobar(renderer);
        TestDateline(renderer);
        TestGlobeAndDeterminism(renderer, device);
        TestTiltedMetalPick(renderer);
        TestLRU();
        IsobarFieldRenderer *slice = MakeRenderer(device);
        TestSmear(slice);
        TestVisibility(slice);
        TestWeakGradient(slice);
        TestStability(slice);
        TestFixture(slice);
        TestNewGuinea(slice);
        TestFlatSynopticHigh(slice);
        TestBudgets(slice);
        TestGlobeCost();
        TestSteadyBuffers();
        TestTiming();
        IsobarFieldRenderer *notes = MakeRenderer(device);
        TestAnnotations(notes);
        IsobarFieldRenderer *review = MakeRenderer(device);
        TestReview(review);
        TestSlice5b();
    }
    return failures ? 1 : 0;
}
