// 3D terrain scene: one height transform for mesh, overlays and picking.
// Synthetic DEM only; no tiles, no network.
#import "terrainscene.h"
#import "mapcamera.h"
#import <math.h>
#import <stdio.h>

static int bad;
static void Check(BOOL yes, const char *name) { fprintf(stderr, "%s %s\n", yes ? "ok  " : "FAIL", name); if (!yes) bad++; }

// An east-west ridge 3000 m high at 45.05°N, sea level elsewhere, plus a
// gentle 400 m plateau west of 6.9°E. Deterministic and analytic.
static double Ground(double lat, double lon) {
    double ridge = 3000 * exp(-pow((lat - 45.05) / 0.012, 2));
    double plateau = lon < 6.9 ? 400 : 0;
    return fmax(ridge, plateau);
}

static IsobarTerrainMosaic *Mosaic(id<MTLDevice> device, TerrainBox box, int w, int h) {
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)w * h * 2 * sizeof(float)];
    float *p = data.mutableBytes;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        double lat = box.south + (y + 0.5) * (box.north - box.south) / h;
        double lon = box.west + (x + 0.5) * (box.east - box.west) / w;
        p[(y * w + x) * 2] = (float)Ground(lat, lon);
        p[(y * w + x) * 2 + 1] = 1;
    }
    return [IsobarTerrainMosaic mosaicWithBox:box width:w height:h samples:data device:device];
}

// Brute force: walk the pixel's ray in steps far finer than any mesh cell.
static BOOL BruteHit(IsobarCamera cam, const IsobarTerrainView *v, double x, double y, double *lat, double *lon) {
    IsobarTiltBasis b;
    if (!IsobarTiltBasisMake(cam, v->relief, v->focusM, &b)) return NO;
    double e[3], d[3];
    IsobarTiltRay(&b, x, y, e, d);
    double step = v->sLat * 0.017453292519943295 / 64;
    for (int i = 0; i < 4000000; i++) {
        double t = i * step, q[3] = {e[0] + d[0] * t, e[1] + d[1] * t, e[2] + d[2] * t}, la, dl, h;
        IsobarTiltGeo(&b, q, &la, &dl, &h);
        if (h <= TerrainSceneDisplayedHeight(v, la, cam.centreLon + dl)) { *lat = la; *lon = cam.centreLon + dl; return YES; }
        if (h < -100) return NO;
    }
    return NO;
}

int main(void) { @autoreleasepool {
    // Relief transform.
    Check(TerrainReliefFactor(10) == 1 && TerrainReliefFactor(25) == 1, "relief is physical close in");
    Check(fabs(TerrainReliefFactor(500) - 4) < 1e-9, "relief reaches x4 at regional scale");
    BOOL monotone = YES;
    for (double km = 25; km < 500; km *= 1.1) if (TerrainReliefFactor(km * 1.1) < TerrainReliefFactor(km)) monotone = NO;
    Check(monotone, "relief rises monotonically with view size");
    Check(TerrainReliefFactor(9000) == 0 && TerrainReliefFactor(NAN) == 0, "synoptic and invalid views have no mesh");

    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) { fprintf(stderr, "skip terrainscene: no Metal device\n"); return 0; }
    IsobarTerrainMosaic *near = Mosaic(device, (TerrainBox){6.5, 44.7, 7.5, 45.4}, 600, 420);
    IsobarTerrainMosaic *far = Mosaic(device, (TerrainBox){-3, 35, 17, 55}, 400, 400);
    IsobarTerrainScene *scene = [[IsobarTerrainScene alloc] initWithNear:near far:far];
    uint64_t token = [scene registerScene];
    Check(token > 0 && scene.maxHeightM > 2900 && scene.maxHeightM <= 3000, "scene registers with its highest ground");

    IsobarCamera flat = MapCameraMake(45.0, 7.0, 600, 1, 1280, 720);
    flat.pitch = 1.2;
    IsobarCamera cam = flat;
    cam.terrain = token;
    IsobarTerrainView v;
    Check(IsobarCameraTerrain(cam, &v) && v.active, "tilted camera with a live token resolves terrain");
    Check(v.relief >= 1 && v.relief < 1.5, "a 37 km view is close to physical relief");
    IsobarCamera overhead = cam;
    overhead.pitch = 0;
    Check(!IsobarCameraTerrain(overhead, NULL), "overhead camera keeps the 2D relief path");
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    IsobarCamera stale = flat;
    stale.terrain = token + 1000;
    BOOL a = IsobarCameraProject(flat, 44.98, 7.02, &x0, &y0), b2 = IsobarCameraProject(stale, 44.98, 7.02, &x1, &y1);
    Check(a == b2 && x0 == x1 && y0 == y1, "an unknown token is the unchanged sea-level camera");

    // Pixel scale does not change the surface: overlays use point viewports.
    IsobarCamera retina = cam;
    retina.viewportW = 2560; retina.viewportH = 1440;
    IsobarTerrainView vr;
    Check(IsobarCameraTerrain(retina, &vr) && vr.relief == v.relief && vr.focusM == v.focusM && vr.sLat == v.sLat
        && vr.latC == v.latC && vr.lonC == v.lonC && vr.ratio == v.ratio, "terrain view is independent of pixel scale");
    double rx = 0, ry = 0;
    Check(IsobarCameraProject(cam, 44.99, 7.03, &x0, &y0) && IsobarCameraProject(retina, 44.99, 7.03, &rx, &ry)
        && fabs(rx - 2 * x0) < 1e-6 && fabs(ry - 2 * y0) < 1e-6, "point and pixel viewports project the same ground");

    // The displayed surface equals the DEM at mesh vertices.
    double vlat = v.latC + 3 * v.sLat, vlon = v.lonC - 5 * v.sLon;
    Check(fabs(TerrainSceneDisplayedHeight(&v, vlat, vlon) - TerrainSceneGroundHeight(&v, vlat, vlon)) < 1e-6,
        "mesh vertex height is the blended DEM");
    Check(TerrainSceneGroundHeight(&v, 45.05, 7.0) > 2900, "ridge crest is measured");
    Check(v.focusM > 0, "orbit focus is lifted to the local ground");

    // Ground projection sits on the displayed surface; elevated points rise.
    double gx = 0, gy = 0, ax = 0, ay = 0;
    Check(IsobarCameraProject(cam, 44.98, 7.0, &gx, &gy) && IsobarCameraProjectAboveGround(cam, 44.98, 7.0, 0, &ax, &ay)
        && fabs(gx - ax) < 1e-6 && fabs(gy - ay) < 1e-6, "ground projection equals zero metres above ground");
    Check(IsobarCameraProjectAboveGround(cam, 44.98, 7.0, 2000, &ax, &ay) && ay < gy - 1, "a point above ground draws higher");

    // Occlusion: the valley behind the ridge is hidden; the crest and the
    // foreground are not.
    double hx = 0, hy = 0;
    Check(!IsobarCameraProject(cam, 45.12, 7.0, &hx, &hy) && isfinite(hx) && isfinite(hy), "valley behind the ridge is hidden");
    Check(IsobarCameraProject(cam, 45.05, 7.0, &hx, &hy), "ridge crest is visible");
    Check(IsobarCameraProject(cam, 44.97, 7.0, &hx, &hy), "foreground is visible");
    Check(IsobarCameraProjectAboveGround(cam, 45.12, 7.0, 9000, &hx, &hy), "a high point over the hidden valley is visible");

    // Picking: verified first intersection, compared with a fine brute march.
    int picks = 0, agree = 0, round = 0, sky = 0;
    double worst = 0;
    for (int j = 0; j <= 8; j++) for (int i = 0; i <= 8; i++) {
        double px = 40 + i * 150, py = 20 + j * 85, lat = 0, lon = 0, bl = 0, bo = 0;
        BOOL hit = IsobarCameraUnproject(cam, px, py, &lat, &lon);
        BOOL brute = BruteHit(cam, &v, px, py, &bl, &bo);
        if (!hit && !brute) { sky++; continue; }
        picks++;
        double cellM = v.sLat * 111195.0;
        double err = hypot((lat - bl) * 111195.0, (lon - bo) * 111195.0 * cos(lat * M_PI / 180));
        if (hit && brute && err < 0.5 * cellM) agree++;
        if (hit && brute && err > worst) worst = err;
        double qx = 0, qy = 0;
        if (hit && IsobarCameraProject(cam, lat, lon, &qx, &qy) && hypot(qx - px, qy - py) < 0.5) round++;
    }
    fprintf(stderr, "     picks=%d agree=%d round=%d sky=%d worst=%.1f m cell=%.0f m\n", picks, agree, round, sky, worst, v.sLat * 111195.0);
    Check(picks > 40 && agree == picks, "pick matches the brute-force first intersection");
    Check(round == picks, "every pick reprojects to its own pixel and is visible");

    // The GPU pick reads the same displaced mesh.
    IsobarFieldRenderer *renderer = [[IsobarFieldRenderer alloc] initWithDevice:device];
    IsobarGeoGrid grid = {0, 60, 0.5, 60, 61, NO};
    [renderer setGrid:grid];
    float *field = malloc(60 * 61 * sizeof(float));
    for (int k = 0; k < 60 * 61; k++) field[k] = 1013 + (k % 60) * 0.1f;
    Check([renderer uploadStep:0 kind:IsobarFieldPressure values:field error:NULL], "pressure uploads");
    free(field);
    int gpu = 0, gpuAgree = 0;
    double gpuWorst = 0;
    for (int j = 2; j <= 8; j++) for (int i = 0; i <= 8; i++) {
        double px = 40.5 + i * 150, py = 20.5 + j * 85, lat = 0, lon = 0, glat = 0, glon = 0;
        if (!IsobarCameraUnproject(cam, px, py, &lat, &lon)) continue;
        if (![renderer pickLatitude:&glat longitude:&glon atX:px y:py camera:cam]) continue;
        gpu++;
        // One pixel of ground at this depth bounds the comparison.
        double ux = 0, uy = 0, lat2 = 0, lon2 = 0;
        IsobarCameraUnproject(cam, px + 1, py + 1, &lat2, &lon2);
        double pixelM = hypot((lat2 - lat) * 111195.0, (lon2 - lon) * 111195.0 * cos(lat * M_PI / 180));
        double err = hypot((glat - lat) * 111195.0, (glon - lon) * 111195.0 * cos(lat * M_PI / 180));
        (void)ux; (void)uy;
        if (err <= fmax(2.0 * pixelM, 30.0)) gpuAgree++;
        if (err > gpuWorst) gpuWorst = err;
    }
    fprintf(stderr, "     gpu picks=%d agree=%d worst=%.1f m\n", gpu, gpuAgree, gpuWorst);
    Check(gpu > 30 && gpuAgree == gpu, "GPU pick of the drawn mesh agrees with the CPU surface");

    // With the renderer's depth probe published, occlusion and picking take
    // the fast path and must give the same answers as the march.
    [renderer publishTerrainProbeForCamera:cam];
    Check(!IsobarCameraProject(cam, 45.12, 7.0, &hx, &hy), "probe: valley behind the ridge is hidden");
    Check(IsobarCameraProject(cam, 45.05, 7.0, &hx, &hy) && IsobarCameraProject(cam, 44.97, 7.0, &hx, &hy),
        "probe: crest and foreground are visible");
    int probePicks = 0, probeAgree = 0;
    for (int j = 0; j <= 8; j++) for (int i = 0; i <= 8; i++) {
        double px = 40 + i * 150, py = 20 + j * 85, lat = 0, lon = 0, bl = 0, bo = 0;
        BOOL hit = IsobarCameraUnproject(cam, px, py, &lat, &lon);
        BOOL brute = BruteHit(cam, &v, px, py, &bl, &bo);
        if (!hit && !brute) continue;
        probePicks++;
        double err = hypot((lat - bl) * 111195.0, (lon - bo) * 111195.0 * cos(lat * M_PI / 180));
        if (hit && brute && err < 0.5 * v.sLat * 111195.0) probeAgree++;
    }
    Check(probePicks > 40 && probeAgree == probePicks, "probe: picks match the brute-force first intersection");

    // A terrain frame renders: sky at the top, lit ground below, no seam.
    CGImageRef image = [renderer renderTime:0 fill:IsobarFieldPressure isobars:YES camera:cam error:NULL];
    Check(image != NULL, "terrain frame renders");
    if (image) {
        CFDataRef pixels = CGDataProviderCopyData(CGImageGetDataProvider(image));
        const uint8_t *p = CFDataGetBytePtr(pixels);
        size_t row = CGImageGetBytesPerRow(image);
        const uint8_t *top = p + 2 * row + 640 * 4, *bottom = p + 700 * row + 640 * 4;
        Check(top[2] > top[0] + 20, "sky above the horizon is blue");
        Check(abs((int)bottom[0] - (int)top[0]) > 10, "ground differs from sky");
        CFRelease(pixels);
        CGImageRelease(image);
    }
    return bad ? 1 : 0;
} }
