#import "fieldrender.h"
#import "ownchart.h"
#import <Accelerate/Accelerate.h>
#import <CoreText/CoreText.h>
#import <simd/simd.h>
#import <math.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <time.h>

const NSUInteger kIsobarFieldResidentCap = 16;

static NSString *const kIsobarFieldDomain = @"IsobarFieldRender";
// Weather values never reach this. GPUs flush real NaNs in textures to zero,
// which would paint missing data as the bottom of a palette.
static const float kMissingSentinel = -1.0e30f;
static const double kDeg = 0.017453292519943295;
static const double kMaxCameraPitch = 1.30;
static const double kPerspectiveFov = 0.4363323129985824;
static const int kContourCellCap = 100000;

static double Wrap180(double lon) {
    if (!isfinite(lon)) return lon;
    double x = fmod(lon + 180.0, 360.0);
    if (x < 0) x += 360.0;
    return x - 180.0;
}

static double Clamp01(double g) {
    if (g < 0) return 0;
    if (g > 1) return 1;
    return g;
}

static double SmoothStep01(double t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3.0 - 2.0 * t);
}

static double gTestingNow = -1;

static double NowMs(void) {
    if (gTestingNow >= 0) return gTestingNow;
    struct timespec t;
    clock_gettime(CLOCK_UPTIME_RAW, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

void IsobarFieldRenderTestingSetNow(double milliseconds) {
    gTestingNow = milliseconds;
}

static BOOL Metrics(IsobarCamera cam, double *vw, double *vh, double *pxPerDeg,
    double *radius, double *globe) {
    if (!(cam.viewportW >= 2) || !(cam.viewportH >= 2)) return NO;
    if (cam.viewportW > 8192 || cam.viewportH > 8192) return NO;
    if (!isfinite(cam.centreLat) || !isfinite(cam.centreLon) || !isfinite(cam.zoom)) return NO;
    if (!isfinite(cam.globe) || !isfinite(cam.pitch) || !(cam.zoom > 0)) return NO;
    if (cam.centreLat < -90 || cam.centreLat > 90) return NO;
    *vw = cam.viewportW;
    *vh = cam.viewportH;
    double fit = fmin(cam.viewportW / 360.0, cam.viewportH / 180.0);
    *pxPerDeg = cam.zoom * fit;
    *radius = *pxPerDeg / kDeg;
    *globe = Clamp01(cam.globe);
    return *pxPerDeg > 0 && *radius > 0;
}

// P is the morphed point in the camera frame (east, north, toward the viewer).
typedef struct {
    double x, y;
    double px, py, pz;
    BOOL visible;
} Surface;
static BOOL IsFront(IsobarCamera cam, double lat, double lon, Surface self);

static BOOL SurfaceAtHeight(IsobarCamera cam, double lat, double dlonDeg, double heightM, Surface *s) {
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
    if (!isfinite(lat) || !isfinite(dlonDeg) || !isfinite(heightM) || lat < -90 || lat > 90) return NO;
    if (heightM < -6371000.0) return NO;
    if (cam.pitch <= 1e-7 || SmoothStep01(cam.pitch / (20.0 * kDeg)) < 1e-3) {
        double fx = dlonDeg * kDeg * cos(cam.centreLat * kDeg);
        double fy = (lat - cam.centreLat) * kDeg;
        double g = cam.pitch > 1e-7 ? 0 : globe;
        if(g <= 1e-6) {
            s->px=fx; s->py=fy; s->pz=1; s->visible=YES;
            s->x=vw*.5+fx*radius; s->y=vh*.5-fy*radius;
            return isfinite(s->x)&&isfinite(s->y);
        }
        double phi = lat * kDeg, lam = dlonDeg * kDeg, phi0 = cam.centreLat * kDeg;
        double cp = cos(phi), sp = sin(phi), c0 = cos(phi0), s0 = sin(phi0);
        double sx = cp * sin(lam);
        double sy = sp * c0 - cp * s0 * cos(lam);
        double sz = s0 * sp + c0 * cp * cos(lam);
        double bx = (1 - g) * fx + g * sx, by = (1 - g) * fy + g * sy, bz = (1 - g) + g * sz;
        s->px = fx; s->py = fy; s->pz = bz;
        if (g > 1e-6) { s->px = bx; s->py = by; }
        s->x = vw * 0.5 + s->px * radius;
        s->y = vh * 0.5 - s->py * radius;
        s->visible = YES;
        return isfinite(s->x) && isfinite(s->y) && isfinite(s->pz);
    }
    double pitch = cam.pitch;
    if (pitch < 0) pitch = 0;
    if (pitch > kMaxCameraPitch) pitch = kMaxCameraPitch;
    double k = SmoothStep01(pitch / (20.0 * kDeg));
    double re = 1.0 / fmax(k, 1e-3);
    double phi = k * lat * kDeg, phi0 = k * cam.centreLat * kDeg;
    double lonCorrection = cos(cam.centreLat * kDeg) * (1.0 - k) + k;
    double lam = k * dlonDeg * kDeg * lonCorrection;
    double cp = cos(phi), sp = sin(phi), c0 = cos(phi0), s0 = sin(phi0);
    double cl = cos(lam), sl = sin(lam);
    double nx = cp * sl;
    double ny = sp * c0 - cp * cl * s0;
    double nz = cp * cl * c0 + sp * s0;
    double altitude = heightM / 6371000.0;
    double pointRadius = re + altitude;
    double pointX = pointRadius * nx, pointY = pointRadius * ny, pointZ = re * (nz - 1.0) + altitude * nz;
    double sn = sin(pitch), cn = cos(pitch);
    double distance = (vh * 0.5 / radius) / (tan(kPerspectiveFov) * fmax(k, 1e-3));

    double eyeY = -sn * distance, eyeZ = cn * distance;
    double relX = pointX, relY = pointY - eyeY, relZ = pointZ - eyeZ;
    double forwardY = sn, forwardZ = -cn;
    double upY = cn, upZ = sn;
    double depth = relY * forwardY + relZ * forwardZ;
    double denom = depth * tan(kPerspectiveFov) * fmax(k, 1e-3);
    if (!(fabs(denom) > 1e-9) || !isfinite(denom)) return NO;
    double viewZ = depth;
    double yNumerator = relY * upY + relZ * upZ;
    s->px = relX / denom * (vh * 0.5 / radius);
    s->py = yNumerator / denom * (vh * 0.5 / radius);
    s->pz = viewZ;
    s->x = vw * 0.5 + s->px * radius;
    s->y = vh * 0.5 - s->py * radius;
    double length2 = relX*relX + relY*relY + relZ*relZ;
    double t = fmax(0, fmin(1, -(eyeY*relY + eyeZ*relZ + re*relZ)/length2));
    double qx=relX*t, qy=eyeY+relY*t, qz=eyeZ+relZ*t;
    s->visible = depth > 0 && qx*qx+qy*qy+qz*qz+2*re*qz >= -1e-10;
    return isfinite(s->x) && isfinite(s->y) && isfinite(s->pz);
}

static BOOL SurfaceAt(IsobarCamera cam, double lat, double dlonDeg, Surface *s) {
    return SurfaceAtHeight(cam, lat, dlonDeg, 0, s);
}

BOOL IsobarCameraProjectAltitude(IsobarCamera camera, double latitude, double longitude,
    double heightM, double *x, double *y) {
    Surface s;
    if (!SurfaceAtHeight(camera, latitude, Wrap180(longitude - camera.centreLon), heightM, &s)) return NO;
    if (x) *x = s.x;
    if (y) *y = s.y;
    return IsFront(camera, latitude, longitude, s);
}

static BOOL SurfaceLon(IsobarCamera cam, double lat, double lon, Surface *s) {
    return SurfaceAt(cam, lat, Wrap180(lon - cam.centreLon), s);
}

static BOOL EvalPhi(IsobarCamera cam, double phi, double lam, double *px, double *py, double *pz) {
    Surface s;
    if (!SurfaceAt(cam, phi / kDeg, lam / kDeg, &s)) return NO;
    *px = s.px;
    *py = s.py;
    *pz = s.pz;
    return YES;
}

static BOOL NewtonRoot(IsobarCamera cam, double targetX, double targetY, double phi, double lam,
    double *outPhi, double *outLam, double *outZ) {
    for (int iter = 0; iter < 10; iter++) {
        double px, py, pz;
        if (!EvalPhi(cam, phi, lam, &px, &py, &pz)) return NO;
        double rx = px - targetX, ry = py - targetY;
        if (hypot(rx, ry) < 1e-7) {
            *outPhi = phi;
            *outLam = lam;
            *outZ = pz;
            return YES;
        }
        double h = 1e-5;
        double px1, py1, pz1, px2, py2, pz2;
        if (!EvalPhi(cam, phi + h, lam, &px1, &py1, &pz1)) return NO;
        if (!EvalPhi(cam, phi, lam + h, &px2, &py2, &pz2)) return NO;
        double j00 = (px1 - px) / h, j01 = (px2 - px) / h;
        double j10 = (py1 - py) / h, j11 = (py2 - py) / h;
        double det = j00 * j11 - j01 * j10;
        if (fabs(det) < 1e-14) return NO;
        double dphi = -(j11 * rx - j01 * ry) / det;
        double dlam = -(-j10 * rx + j00 * ry) / det;
        if (dphi > 0.45) dphi = 0.45;
        if (dphi < -0.45) dphi = -0.45;
        if (dlam > 0.45) dlam = 0.45;
        if (dlam < -0.45) dlam = -0.45;
        phi += dphi;
        lam += dlam;
        if (phi > 1.55) phi = 1.55;
        if (phi < -1.55) phi = -1.55;
        lam = atan2(sin(lam), cos(lam));
    }
    return NO;
}

// Highest camera-frame Z among roots of the screen ray. The query, when it
// is itself on the surface, is always one of the seeds.
static double HighestZ(IsobarCamera cam, double targetX, double targetY, double preferPhi, double preferLam) {
    enum { kSeed = 320, kKeep = 8 };
    double phiS[kSeed], lamS[kSeed], errS[kSeed];
    int n = 0;
    phiS[n] = preferPhi;
    lamS[n] = preferLam;
    errS[n] = 0;
    n++;
    for (int j = -5; j <= 5; j++) {
        for (int i = -12; i < 12; i++) {
            if (n >= kSeed) break;
            phiS[n] = j * (15.0 * kDeg);
            lamS[n] = i * (15.0 * kDeg);
            double px, py, pz;
            if (!EvalPhi(cam, phiS[n], lamS[n], &px, &py, &pz)) {
                errS[n] = 1e9;
            } else {
                errS[n] = hypot(px - targetX, py - targetY);
            }
            n++;
        }
    }
    int order[kKeep];
    int kept = 0;
    for (int s = 0; s < n; s++) {
        int place = kept;
        if (kept < kKeep) {
            order[kept++] = s;
        } else {
            int worst = 0;
            for (int k = 1; k < kKeep; k++)
                if (errS[order[k]] > errS[order[worst]]) worst = k;
            if (errS[s] >= errS[order[worst]]) continue;
            order[worst] = s;
            place = worst;
        }
        (void)place;
    }
    double best = -2;
    for (int k = 0; k < kept; k++) {
        double op, ol, oz;
        if (!NewtonRoot(cam, targetX, targetY, phiS[order[k]], lamS[order[k]], &op, &ol, &oz)) continue;
        if (oz > best) best = oz;
    }
    return best;
}

static BOOL IsFront(IsobarCamera cam, double lat, double lon, Surface self) {
    if (!self.visible) return NO;
    if (cam.pitch > 1e-7) return YES;
    double globe = Clamp01(cam.globe);
    if (globe <= 1e-7) return YES;
    if (globe >= 1 - 1e-7) return self.pz >= -1e-5;
    double dlon = Wrap180(lon - cam.centreLon);
    double best = HighestZ(cam, self.px, self.py, lat * kDeg, dlon * kDeg);
    return self.pz >= best - 1e-3;
}

BOOL IsobarCameraProject(IsobarCamera camera, double latitude, double longitude, double *x, double *y) {
    Surface s;
    if (!SurfaceLon(camera, latitude, longitude, &s)) return NO;
    if (x) *x = s.x;
    if (y) *y = s.y;
    return IsFront(camera, latitude, longitude, s);
}

static BOOL UnprojectFlat(IsobarCamera cam, double x, double y, double *lat, double *lon) {
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
    double X = (x - vw * 0.5) / radius;
    double Y = (vh * 0.5 - y) / radius;
    double cos0 = cos(cam.centreLat * kDeg);
    if (fabs(cos0) < 1e-5) {
        if (fabs(X) > 1e-3) return NO;
        *lat = cam.centreLat + Y / kDeg;
        *lon = Wrap180(cam.centreLon);
        return *lat >= -90 && *lat <= 90;
    }
    double dlon = (X / cos0) / kDeg;
    double la = cam.centreLat + Y / kDeg;
    if (fabs(dlon) > 180.0001 || la < -90 || la > 90 || !isfinite(la) || !isfinite(dlon)) return NO;
    *lat = la;
    *lon = Wrap180(cam.centreLon + dlon);
    return YES;
}

static BOOL UnprojectSphere(IsobarCamera cam, double x, double y, double *lat, double *lon) {
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
    double ox = (x - vw * 0.5) / radius;
    double oy = (vh * 0.5 - y) / radius;
    double rho = hypot(ox, oy);
    if (rho > 1.000001) return NO;
    if (rho > 1) rho = 1;
    if (rho < 1e-12) {
        *lat = cam.centreLat;
        *lon = Wrap180(cam.centreLon);
        return YES;
    }
    double c = asin(rho);
    double sinC = sin(c), cosC = cos(c);
    double phi0 = cam.centreLat * kDeg;
    double sin0 = sin(phi0), cos0 = cos(phi0);
    double sp = cosC * sin0 + oy * sinC * cos0 / rho;
    if (sp > 1) sp = 1;
    if (sp < -1) sp = -1;
    double la = asin(sp) / kDeg;
    double lo = cam.centreLon + atan2(ox * sinC, rho * cos0 * cosC - oy * sin0 * sinC) / kDeg;
    if (!isfinite(la) || !isfinite(lo)) return NO;
    *lat = la;
    *lon = Wrap180(lo);
    return YES;
}

static BOOL ClosePixel(IsobarCamera cam, double lat, double lon, double x, double y, double tol) {
    double px, py;
    if (!IsobarCameraProject(cam, lat, lon, &px, &py)) return NO;
    return hypot(px - x, py - y) <= tol;
}

static BOOL UnprojectTilted(IsobarCamera cam, double x, double y, double *lat, double *lon) {
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
    double pitch = cam.pitch;
    double k = SmoothStep01(pitch / (20.0 * kDeg));
    if (k < 1e-3) return UnprojectFlat(cam, x, y, lat, lon);
    double halfH = vh * 0.5 / radius, aspect = vw / vh;
    double d = tan(kPerspectiveFov) * k;
    double sn = sin(pitch), cn = cos(pitch);
    double distance = halfH / d;
    if (!(distance > 1e-6) || !isfinite(distance)) return NO;
    double eyeY = -sn * distance, eyeZ = cn * distance;
    double fy = sn, fz = -cn, uy = cn, uz = sn;
    double cx = (x - vw * 0.5) / (vw * 0.5);
    double cy = (vh * 0.5 - y) / (vh * 0.5);
    double dx = cx * d * aspect, dy = fy + cy * d * uy, dz = fz + cy * d * uz;
    double norm = sqrt(dx * dx + dy * dy + dz * dz);
    if (!(norm > 1e-9)) return NO;
    dx /= norm; dy /= norm; dz /= norm;
    double re = 1.0 / k;
    double ocx = 0, ocy = eyeY, ocz = eyeZ + re;
    double b = ocx * dx + ocy * dy + ocz * dz;
    double c = eyeY * eyeY + eyeZ * eyeZ + 2.0 * eyeZ * re;
    double disc = b * b - c;
    if (disc < 0) return NO;
    double root = sqrt(disc), q = b < 0 ? -b + root : -b - root;
    double t0 = q, t1 = fabs(q) > 1e-12 ? c / q : INFINITY;
    double t = (t0 > 0 && t1 > 0) ? fmin(t0, t1) : (t0 > 0 ? t0 : t1);
    if (!(t > 0) || !isfinite(t)) return NO;
    double hx = dx * t, hy = eyeY + dy * t, hz = eyeZ + dz * t;
    double nx = hx / re, ny = hy / re, nz = (hz + re) / re;
    double phi0 = k * cam.centreLat * kDeg;
    double sp = ny * cos(phi0) + nz * sin(phi0);
    if (sp < -1) sp = -1;
    if (sp > 1) sp = 1;
    double la = asin(sp) / k / kDeg;
    double lonCorrection = cos(cam.centreLat * kDeg) * (1.0 - k) + k;
    double lo = cam.centreLon + atan2(nx, nz * cos(phi0) - ny * sin(phi0)) / (k * lonCorrection) / kDeg;
    if (!isfinite(la) || !isfinite(lo) || la < -90 || la > 90 || fabs(lo-cam.centreLon)>180.000001) return NO;
    *lat = la; *lon = Wrap180(lo);
    return YES;
}

static BOOL UnprojectMorph(IsobarCamera cam, double x, double y, double *lat, double *lon) {
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
    double X = (x - vw * 0.5) / radius;
    double Y = (vh * 0.5 - y) / radius;
    double seeds[6][2];
    int n = 0;
    double la, lo;
    if (UnprojectFlat(cam, x, y, &la, &lo)) {
        seeds[n][0] = la;
        seeds[n][1] = lo;
        n++;
    }
    if (UnprojectSphere(cam, x, y, &la, &lo)) {
        seeds[n][0] = la;
        seeds[n][1] = lo;
        n++;
        seeds[n][0] = -la;
        seeds[n][1] = Wrap180(lo + 180);
        n++;
    }
    seeds[n][0] = cam.centreLat;
    seeds[n][1] = cam.centreLon;
    n++;
    double bestZ = -2, bestLat = 0, bestLon = 0;
    BOOL found = NO;
    for (int s = 0; s < n; s++) {
        double op, ol, oz;
        if (!NewtonRoot(cam, X, Y, seeds[s][0] * kDeg, Wrap180(seeds[s][1] - cam.centreLon) * kDeg, &op, &ol, &oz))
            continue;
        if (oz > bestZ) {
            bestZ = oz;
            bestLat = op / kDeg;
            bestLon = Wrap180(cam.centreLon + ol / kDeg);
            found = YES;
        }
    }
    // A coarse net catches the sheet the closed forms miss.
    for (int j = -4; j <= 4; j += 2) {
        for (int i = -6; i <= 6; i += 2) {
            double op, ol, oz;
            if (!NewtonRoot(cam, X, Y, j * (20.0 * kDeg), i * (20.0 * kDeg), &op, &ol, &oz)) continue;
            if (oz > bestZ) {
                bestZ = oz;
                bestLat = op / kDeg;
                bestLon = Wrap180(cam.centreLon + ol / kDeg);
                found = YES;
            }
        }
    }
    if (!found) return NO;
    *lat = bestLat;
    *lon = bestLon;
    return YES;
}

BOOL IsobarCameraUnproject(IsobarCamera camera, double x, double y, double *latitude, double *longitude) {
    if (!isfinite(x) || !isfinite(y)) return NO;
    double globe = Clamp01(camera.globe);
    double lat = 0, lon = 0;
    BOOL ok = NO;
    if (camera.pitch > 1e-7) ok = UnprojectTilted(camera, x, y, &lat, &lon);
    else if (globe <= 1e-7) ok = UnprojectFlat(camera, x, y, &lat, &lon);
    else if (globe >= 1 - 1e-7 && fabs(camera.pitch) <= 1e-7) ok = UnprojectSphere(camera, x, y, &lat, &lon);
    else ok = UnprojectMorph(camera, x, y, &lat, &lon);
    if (!ok) return NO;
    if (!ClosePixel(camera, lat, lon, x, y, globe > 1e-7 && globe < 1 - 1e-7 ? 0.05 : 1e-3)) return NO;
    if (latitude) *latitude = lat;
    if (longitude) *longitude = lon;
    return YES;
}

static const double kZoomMin = 1.0;
static const double kZoomMax = 18000.0;

IsobarCamera IsobarCameraClamp(IsobarCamera camera) {
    if (!isfinite(camera.globe)) camera.globe = 0;
    if (camera.globe < 0) camera.globe = 0;
    if (camera.globe > 1) camera.globe = 1;
    if (!isfinite(camera.pitch)) camera.pitch = 0;
    if (camera.pitch < 0) camera.pitch = 0;
    if (camera.pitch > kMaxCameraPitch) camera.pitch = kMaxCameraPitch;
    if (!isfinite(camera.centreLon)) camera.centreLon = 0;
    if (!isfinite(camera.viewportW) || camera.viewportW < 2) camera.viewportW = 2;
    if (!isfinite(camera.viewportH) || camera.viewportH < 2) camera.viewportH = 2;
    double globe = camera.globe;
    double fit = fmin(camera.viewportW / 360.0, camera.viewportH / 180.0);
    if (!(fit > 1e-9)) fit = 1e-9;
    double flatFloor = camera.viewportH / (180.0 * fit);
    if (flatFloor < kZoomMin) flatFloor = kZoomMin;
    double floorZ = kZoomMin + (flatFloor - kZoomMin) * (1.0 - globe);
    if (!isfinite(camera.zoom) || camera.zoom <= 0) camera.zoom = floorZ;
    if (camera.zoom < floorZ) camera.zoom = floorZ;
    if (camera.zoom > kZoomMax) camera.zoom = kZoomMax;
    if (!isfinite(camera.centreLat)) camera.centreLat = 0;
    double pxPerDeg = camera.zoom * fit;
    double halfLat = (camera.viewportH * 0.5) / pxPerDeg;
    double inset = halfLat * (1.0 - globe);
    if (inset > 90) inset = 90;
    double latMin = -90 + inset;
    double latMax = 90 - inset;
    if (latMin > latMax) camera.centreLat = 0;
    else {
        if (camera.centreLat < latMin) camera.centreLat = latMin;
        if (camera.centreLat > latMax) camera.centreLat = latMax;
    }
    if (camera.centreLat < -90) camera.centreLat = -90;
    if (camera.centreLat > 90) camera.centreLat = 90;
    return camera;
}

static IsobarRGB RGB(double r, double g, double b) {
    return (IsobarRGB){r, g, b};
}

static double Channel(int byte) { return byte / 255.0; }

IsobarRGB IsobarMissingColour(void) { return RGB(Channel(0x8E), Channel(0x8A), Channel(0x84)); }
IsobarRGB IsobarOceanColour(void) {
    OwnRGB sea = OwnChartSea();
    return RGB(sea.r, sea.g, sea.b);
}
IsobarRGB IsobarNoCoverageColour(void) { return RGB(Channel(0xE4), Channel(0xDD), Channel(0xD2)); }
IsobarRGB IsobarCoverageEdgeColour(void) { return RGB(Channel(0x5E), Channel(0x6A), Channel(0x74)); }

static IsobarRGB FromOwn(OwnRGB c) { return RGB(c.r, c.g, c.b); }

double IsobarFieldOverlayAlpha(IsobarFieldKind kind, double value) {
    return OwnFieldOverlayAlpha((int)kind, value);
}

IsobarRGB IsobarFieldColour(IsobarFieldKind kind, double value) {
    if (!isfinite(value)) return IsobarMissingColour();
    return FromOwn(OwnFieldRGB((int)kind, value));
}

double IsobarFieldSeaAlphaScale(IsobarFieldKind kind) {
    return OwnFieldSeaAlphaScale((int)kind);
}

// TODO(slice 3): isobar labels, H/L marks, text.
static NSString *const kShader = @""
"#include <metal_stdlib>\n"
"using namespace metal;\n"
"struct U {\n"
"    float4 cam;\n"
"    float4 cam2;\n"
"    float4 view;\n"
"    float4 geo0;\n"
"    float4 geo1;\n"
"    float4 flags;\n"
"    float4 stops[2];\n"
"    float4 colours[8];\n"
"    float4 missing;\n"
"    float4 ink;\n"
"    float4 ocean;\n"
"    float4 uncovered;\n"
"};\n"
"struct VOut {\n"
"    float4 position [[position]];\n"
"    float lat;\n"
"    float lon;\n"
"};\n"
"struct LineV {\n"
"    float lat0, lon0, lat1, lon1;\n"
"    float side, t, halfInk, halfOuter;\n"
"    float r, g, b, a;\n"
"};\n"
"struct LOut {\n"
"    float4 position [[position]];\n"
"    float side;\n"
"    float halfInk;\n"
"    float halfOuter;\n"
"    float pz;\n"
"    float4 colour;\n"
"};\n"
"struct Frag {\n"
"    float4 colour [[color(0)]];\n"
"    float2 geo [[color(1)]];\n"
"};\n"
"static float wrap180(float lon) {\n"
"    float x = fmod(lon + 180.0, 360.0);\n"
"    if (x < 0.0) x += 360.0;\n"
"    return x - 180.0;\n"
"}\n"
"static float depthOf(float z) { return 0.5 - 0.45 * z; }\n"
"static float3 projectAt(float lat, float dlon, constant U &u) {\n"
"    float centreLat = u.cam.x;\n"
"    float globe = clamp(u.cam.z, 0.0, 1.0);\n"
"    float pitch = clamp(u.cam2.x, 0.0, 1.30);\n"
"    float vw = u.view.x, vh = u.view.y, radius = u.view.w;\n"
"    if (pitch <= 0.0000001 || smoothstep(0.0, 1.0, pitch / 0.3490658504) < 0.001) {\n"
"        if(pitch > 0.0000001) globe=0.0;\n"
"        float phi = lat * 0.017453292519943295, lam = dlon * 0.017453292519943295;\n"
"        float phi0 = centreLat * 0.017453292519943295, cp = cos(phi), sp = sin(phi);\n"
"        float c0 = cos(phi0), s0 = sin(phi0), cl = cos(lam), sl = sin(lam);\n"
"        float sx = cp * sl, sy = sp * c0 - cp * cl * s0, sz = cp * cl * c0 + sp * s0;\n"
"        float fx = lam * c0, fy = (lat - centreLat) * 0.017453292519943295;\n"
"        float bx = mix(fx, sx, globe), by = mix(fy, sy, globe), bz = mix(1.0, sz, globe);\n"
"        return float3(vw * 0.5 + bx * radius, vh * 0.5 - by * radius, bz);\n"
"    }\n"
"    float k = smoothstep(0.0, 1.0, pitch / 0.3490658504);\n"
"    float re = 1.0 / max(k, 0.001);\n"
"    float phi = k * lat * 0.017453292519943295;\n"
"    float phi0 = k * centreLat * 0.017453292519943295;\n"
"    float lonCorrection = cos(centreLat * 0.017453292519943295) * (1.0 - k) + k;\n"
"    float lam = k * dlon * 0.017453292519943295 * lonCorrection, cp = cos(phi), sp = sin(phi);\n"
"    float c0 = cos(phi0), s0 = sin(phi0), cl = cos(lam), sl = sin(lam);\n"
"    float nx = cp * sl, ny = sp * c0 - cp * cl * s0, nz = cp * cl * c0 + sp * s0;\n"
"    float3 point = float3(re * nx, re * ny, re * (nz - 1.0));\n"
"    float sn = sin(pitch), cn = cos(pitch);\n"
"    float distance = (vh * 0.5 / radius) / (0.46630766 * max(k, 0.001));\n"
"    float3 eye = float3(0.0, -sn * distance, cn * distance);\n"
"    float3 rel = point - eye, forward = float3(0.0, sn, -cn), up = float3(0.0, cn, sn);\n"
"    float depth = dot(rel, forward);\n"
"    float scale = vh * 0.5 / (depth * 0.46630766 * max(k, 0.001));\n"
"    return float3(vw * 0.5 + rel.x * scale, vh * 0.5 - dot(rel, up) * scale, depth);\n"
"}\n"
"static float4 clipPoint(float3 p, constant U &u) {\n"
"    float2 xy=float2(p.x/u.view.x*2.0-1.0,1.0-p.y/u.view.y*2.0);\n"
"    float k=smoothstep(0.0,1.0,u.cam2.x/0.3490658504);\n"
"    if(u.cam2.x<=0.0000001 || k<0.001) return float4(xy,depthOf(p.z),1.0);\n"
"    float distance=(u.view.y*0.5/u.view.w)/(0.46630766*k);\n"
"    float nearZ=max(0.00000001,distance*0.001);\n"
"    return float4(xy*p.z,p.z-nearZ,p.z);\n"
"}\n"
"vertex VOut fieldVertex(uint vid [[vertex_id]], constant U &u [[buffer(0)]],\n"
"    const device float2 *verts [[buffer(1)]]) {\n"
"    float lat = verts[vid].x;\n"
"    float dlon = verts[vid].y;\n"
"    float3 p = projectAt(lat, dlon, u);\n"
"    VOut o;\n"
"    o.position = clipPoint(p,u);\n"
"    o.lat = lat;\n"
"    o.lon = u.cam.y + dlon;\n"
"    return o;\n"
"}\n"
"vertex LOut lineVertex(uint vid [[vertex_id]], constant U &u [[buffer(0)]],\n"
"    const device LineV *lines [[buffer(1)]]) {\n"
"    LineV v = lines[vid];\n"
"    float3 p0 = projectAt(v.lat0, v.lon0, u);\n"
"    float3 p1 = projectAt(v.lat1, v.lon1, u);\n"
"    float2 dir = p1.xy - p0.xy;\n"
"    float len = length(dir);\n"
"    float2 tangent = len > 0.25 ? dir / len : float2(1.0, 0.0);\n"
"    float2 normal = float2(-tangent.y, tangent.x);\n"
"    float2 c = mix(p0.xy, p1.xy, v.t);\n"
"    float cap = v.t < 0.5 ? -1.0 : 1.0;\n"
"    float capPx = 0.75 * max(u.flags.y, 1.0);\n"
"    c += tangent * cap * capPx;\n"
"    c += normal * v.side * v.halfOuter;\n"
"    float z = mix(p0.z, p1.z, v.t);\n"
"    LOut o;\n"
"    if (len > fmax(u.view.x, u.view.y) * 1.25) o.position = float4(4.0, 4.0, 1.0, 1.0);\n"
"    else o.position = clipPoint(float3(c,z),u);\n"
"    o.side = v.side;\n"
"    o.halfInk = v.halfInk;\n"
"    o.halfOuter = v.halfOuter;\n"
"    o.pz = z;\n"
"    o.colour = float4(v.r, v.g, v.b, v.a);\n"
"    return o;\n"
"}\n"
"static float srgbToLinear(float c) {\n"
"    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);\n"
"}\n"
"static float4 present(float4 c, constant U &u) {\n"
"    if (u.flags.x > 1.5) {\n"
"        c.r = srgbToLinear(c.r);\n"
"        c.g = srgbToLinear(c.g);\n"
"        c.b = srgbToLinear(c.b);\n"
"    }\n"
"    return c;\n"
"}\n"
"static bool onGlobe(float2 geo) { return geo.x <= 90.5 && geo.x >= -90.5; }\n"
"static float fieldAt(texture2d<float, access::read> tex, float lat, float lon, constant U &u) {\n"
"    float west = u.geo0.x, north = u.geo0.y, step = u.geo0.z, east = u.geo0.w;\n"
"    float south = u.geo1.x;\n"
"    int nLon = int(u.geo1.y), nLat = int(u.geo1.z);\n"
"    bool wraps = u.geo1.w > 0.5;\n"
"    if (!wraps) {\n"
"        float mid = (west + east) * 0.5;\n"
"        lon = mid + wrap180(lon - mid);\n"
"    }\n"
"    if (lat > north + 1e-3 || lat < south - 1e-3) return NAN;\n"
"    float fy = (north - lat) / step;\n"
"    if (fy < 0.0) fy = 0.0;\n"
"    if (fy > float(nLat - 1)) fy = float(nLat - 1);\n"
"    float fx;\n"
"    if (wraps) {\n"
"        float span = float(nLon) * step;\n"
"        float rel = lon - west;\n"
"        rel = rel - floor(rel / span) * span;\n"
"        if (rel < 0.0) rel += span;\n"
"        fx = rel / step;\n"
"        float n = float(nLon);\n"
"        fx = fx - floor(fx / n) * n;\n"
"        if (fx < 0.0) fx += n;\n"
"    } else {\n"
"        if (lon < west - 1e-3 || lon > east + 1e-3) return NAN;\n"
"        fx = (lon - west) / step;\n"
"        if (fx < 0.0) fx = 0.0;\n"
"        if (fx > float(nLon - 1)) fx = float(nLon - 1);\n"
"    }\n"
"    int y0 = int(floor(fy));\n"
"    int x0 = int(floor(fx));\n"
"    float ty = fy - float(y0);\n"
"    float tx = fx - float(x0);\n"
"    int y1 = y0 + 1, x1 = x0 + 1;\n"
"    if (y0 < 0) y0 = 0;\n"
"    if (y1 >= nLat) { y1 = nLat - 1; ty = 0.0; }\n"
"    if (wraps) {\n"
"        if (x0 >= nLon) x0 -= nLon;\n"
"        if (x0 < 0) x0 += nLon;\n"
"        x1 %= nLon;\n"
"        if (x1 < 0) x1 += nLon;\n"
"    } else {\n"
"        if (x0 < 0) x0 = 0;\n"
"        if (x0 >= nLon) x0 = nLon - 1;\n"
"        if (x1 >= nLon) { x1 = nLon - 1; tx = 0.0; }\n"
"    }\n"
"    if (x0 < 0 || y0 < 0 || x1 < 0 || y1 < 0 || x0 >= nLon || x1 >= nLon || y0 >= nLat || y1 >= nLat) return NAN;\n"
"    float v00 = tex.read(uint2(x0, y0)).x;\n"
"    float v10 = tex.read(uint2(x1, y0)).x;\n"
"    float v01 = tex.read(uint2(x0, y1)).x;\n"
"    float v11 = tex.read(uint2(x1, y1)).x;\n"
"    float w00 = v00 < -1e20 ? 0.0 : (1.0 - tx) * (1.0 - ty);\n"
"    float w10 = v10 < -1e20 ? 0.0 : tx * (1.0 - ty);\n"
"    float w01 = v01 < -1e20 ? 0.0 : (1.0 - tx) * ty;\n"
"    float w11 = v11 < -1e20 ? 0.0 : tx * ty;\n"
"    float w = w00 + w10 + w01 + w11;\n"
"    if (w < 1e-5) return NAN;\n"
"    float acc = 0.0;\n"
"    if (w00 > 0.0) acc += w00 * v00;\n"
"    if (w10 > 0.0) acc += w10 * v10;\n"
"    if (w01 > 0.0) acc += w01 * v01;\n"
"    if (w11 > 0.0) acc += w11 * v11;\n"
"    return acc / w;\n"
"}\n"
"static float blended(texture2d<float, access::read> a, texture2d<float, access::read> b,\n"
"    float lat, float lon, constant U &u) {\n"
"    float t = u.flags.z;\n"
"    float va = fieldAt(a, lat, lon, u);\n"
"    if (t <= 1e-5) return va;\n"
"    float vb = fieldAt(b, lat, lon, u);\n"
"    if (t >= 1.0 - 1e-5) return vb;\n"
"    if (isnan(va) || isnan(vb)) return NAN;\n"
"    return mix(va, vb, t);\n"
"}\n"
"static float3 colourFor(float v, constant U &u) {\n"
"    if (isnan(v)) return u.missing.xyz;\n"
"    int n = int(u.flags.w);\n"
"    float stops[8];\n"
"    float3 cols[8];\n"
"    stops[0] = u.stops[0].x; stops[1] = u.stops[0].y; stops[2] = u.stops[0].z; stops[3] = u.stops[0].w;\n"
"    stops[4] = u.stops[1].x; stops[5] = u.stops[1].y; stops[6] = u.stops[1].z; stops[7] = u.stops[1].w;\n"
"    cols[0] = u.colours[0].xyz; cols[1] = u.colours[1].xyz; cols[2] = u.colours[2].xyz; cols[3] = u.colours[3].xyz;\n"
"    cols[4] = u.colours[4].xyz; cols[5] = u.colours[5].xyz; cols[6] = u.colours[6].xyz; cols[7] = u.colours[7].xyz;\n"
"    if (n < 2) n = 2;\n"
"    if (n > 8) n = 8;\n"
"    if (v <= stops[0]) return cols[0];\n"
"    if (v >= stops[n - 1]) return cols[n - 1];\n"
"    for (int i = 0; i < 7; i++) {\n"
"        if (i + 1 >= n) break;\n"
"        if (v <= stops[i + 1]) {\n"
"            float t = (v - stops[i]) / (stops[i + 1] - stops[i]);\n"
"            return mix(cols[i], cols[i + 1], t);\n"
"        }\n"
"    }\n"
"    return cols[n - 1];\n"
"}\n"
"static float alphaFor(float v, constant U &u) {\n"
"    if (isnan(v)) return 0.0;\n"
"    int n = int(u.flags.w);\n"
"    float stops[8];\n"
"    float alphas[8];\n"
"    stops[0] = u.stops[0].x; stops[1] = u.stops[0].y; stops[2] = u.stops[0].z; stops[3] = u.stops[0].w;\n"
"    stops[4] = u.stops[1].x; stops[5] = u.stops[1].y; stops[6] = u.stops[1].z; stops[7] = u.stops[1].w;\n"
"    alphas[0] = u.colours[0].w; alphas[1] = u.colours[1].w; alphas[2] = u.colours[2].w; alphas[3] = u.colours[3].w;\n"
"    alphas[4] = u.colours[4].w; alphas[5] = u.colours[5].w; alphas[6] = u.colours[6].w; alphas[7] = u.colours[7].w;\n"
"    if (n < 2) n = 2;\n"
"    if (n > 7) n = 7;\n"
"    if (v < u.uncovered.w) return 0.0;\n"
"    if (v <= stops[0]) return alphas[0];\n"
"    if (v >= stops[n - 1]) return alphas[n - 1];\n"
"    for (int i = 0; i < 7; i++) {\n"
"        if (i + 1 >= n) break;\n"
"        if (v <= stops[i + 1]) {\n"
"            float t = (v - stops[i]) / (stops[i + 1] - stops[i]);\n"
"            return mix(alphas[i], alphas[i + 1], t);\n"
"        }\n"
"    }\n"
"    return alphas[n - 1];\n"
"}\n"
"static float landFraction(texture2d<float, access::read> land, float lat, float lon, constant U &u) {\n"
"    float west = u.geo0.x, north = u.geo0.y, step = u.geo0.z;\n"
"    float nLon = max(u.geo1.y, 2.0);\n"
"    float w = float(land.get_width()), h = float(land.get_height());\n"
"    bool wraps = u.geo1.w > 0.5;\n"
"    float k = wraps ? w / nLon : (w - 1.0) / (nLon - 1.0);\n"
"    int x = int(rint((lon - west) / step * k));\n"
"    int y = int(rint((north - lat) / step * k));\n"
"    if (wraps) x = ((x % int(w)) + int(w)) % int(w);\n"
"    if (x < 0) x = 0;\n"
"    if (y < 0) y = 0;\n"
"    if (x >= int(w)) x = int(w) - 1;\n"
"    if (y >= int(h)) y = int(h) - 1;\n"
"    return land.read(uint2(uint(x), uint(y))).r;\n"
"}\n"
"fragment Frag fieldFragment(VOut in [[stage_in]], constant U &u [[buffer(0)]],\n"
"    texture2d<float, access::read> fill0 [[texture(0)]],\n"
"    texture2d<float, access::read> fill1 [[texture(1)]],\n"
"    texture2d<float, access::read> land [[texture(2)]]) {\n"
"    Frag o;\n"
"    o.geo = float2(in.lat, in.lon);\n"
"    float west = u.geo0.x, north = u.geo0.y, east = u.geo0.w, south = u.geo1.x;\n"
"    bool wraps = u.geo1.w > 0.5;\n"
"    bool inside = in.lat <= north + 1e-3 && in.lat >= south - 1e-3;\n"
"    float lon = in.lon;\n"
"    if (!wraps) {\n"
"        float mid = (west + east) * 0.5;\n"
"        lon = mid + wrap180(in.lon - mid);\n"
"        inside = inside && lon >= west - 1e-3 && lon <= east + 1e-3;\n"
"    }\n"
"    if (!inside) {\n"
"        o.colour = float4(u.uncovered.xyz, 1.0);\n"
"        return o;\n"
"    }\n"
"    float v = blended(fill0, fill1, in.lat, in.lon, u);\n"
"    bool mask = u.ocean.w > 0.5;\n"
"    bool colourField = u.ink.w > 0.5;\n"
"    float3 rgb;\n"
"    if (isnan(v)) rgb = u.missing.xyz;\n"
"    else if (mask) {\n"
"        bool sea = landFraction(land, in.lat, lon, u) < 0.5;\n"
"        float3 plate = sea ? u.ocean.xyz : u.colours[7].xyz;\n"
"        if (colourField) {\n"
"            float a = clamp(alphaFor(v, u) * (sea ? u.missing.w : 1.0), 0.0, 1.0);\n"
"            rgb = mix(plate, colourFor(v, u), a);\n"
"        } else rgb = plate;\n"
"    } else rgb = colourFor(v, u);\n"
"    o.colour = present(float4(rgb, 1.0), u);\n"
"    return o;\n"
"}\n"
"fragment float2 pickFragment(VOut in [[stage_in]]) {\n"
"    return float2(in.lat, in.lon);\n"
"}\n"
"fragment float4 lineFragment(LOut in [[stage_in]], constant U &u [[buffer(0)]],\n"
"    texture2d<float, access::read> pick [[texture(0)]]) {\n"
"    if (u.cam.z > 0.001) {\n"
"        if (in.pz < -0.002) discard_fragment();\n"
"        uint2 px = uint2(uint(in.position.x), uint(in.position.y));\n"
"        if (px.x >= uint(u.view.x) || px.y >= uint(u.view.y)) discard_fragment();\n"
"        if (!onGlobe(pick.read(px).xy)) discard_fragment();\n"
"    }\n"
"    float dist = abs(in.side) * in.halfOuter;\n"
"    float3 rgb = in.colour.rgb;\n"
"    float alphaIn = in.colour.a;\n"
"    float alpha = (1.0 - smoothstep(in.halfInk, in.halfOuter, dist)) * alphaIn;\n"
"    if (alpha < 0.004) discard_fragment();\n"
"    return present(float4(rgb, alpha), u);\n"
"}\n"
"struct TIn {\n"
"    float x, y, u, v;\n"
"    float r, g, b, a;\n"
"};\n"
"struct TOut {\n"
"    float4 position [[position]];\n"
"    float2 uv;\n"
"    float4 colour;\n"
"};\n"
"vertex TOut textVertex(uint vid [[vertex_id]], constant U &u [[buffer(0)]],\n"
"    const device TIn *verts [[buffer(1)]]) {\n"
"    TIn t = verts[vid];\n"
"    TOut o;\n"
"    o.position = float4((t.x / u.view.x) * 2.0 - 1.0, 1.0 - (t.y / u.view.y) * 2.0, 0.0, 1.0);\n"
"    o.uv = float2(t.u, t.v);\n"
"    o.colour = float4(t.r, t.g, t.b, t.a);\n"
"    return o;\n"
"}\n"
"fragment float4 textFragment(TOut in [[stage_in]], constant U &u [[buffer(0)]],\n"
"    texture2d<float> atlas [[texture(0)]],\n"
"    texture2d<float, access::read> pick [[texture(1)]]) {\n"
"    if (u.cam.z > 0.001) {\n"
"        uint2 px = uint2(uint(in.position.x), uint(in.position.y));\n"
"        if (px.x >= uint(u.view.x) || px.y >= uint(u.view.y)) discard_fragment();\n"
"        if (!onGlobe(pick.read(px).xy)) discard_fragment();\n"
"    }\n"
"    constexpr sampler smp(mag_filter::linear, min_filter::linear, address::clamp_to_edge);\n"
"    float4 c = atlas.sample(smp, in.uv) * in.colour;\n"
"    if (c.a < 0.004) discard_fragment();\n"
"    return present(c, u);\n"
"}\n";

typedef struct {
    simd_float4 cam;
    simd_float4 cam2;
    simd_float4 view;
    simd_float4 geo0;
    simd_float4 geo1;
    simd_float4 flags;
    simd_float4 stops[2];
    simd_float4 colours[8];
    simd_float4 missing;
    simd_float4 ink;
    simd_float4 ocean;
    simd_float4 uncovered;
} FieldUniform;
_Static_assert(sizeof(FieldUniform) == 320, "field uniform must match the shader");

typedef struct {
    float lat0, lon0, lat1, lon1;
    float side, t, halfInk, halfOuter;
    float r, g, b, a;
} FieldLineVertex;
_Static_assert(sizeof(FieldLineVertex) == 48, "line vertex must match the shader");

typedef struct {
    double *lat;
    double *lon;
    int count;
    int closed;
    double level;
    uint32_t ident;
} FieldLine;

typedef struct {
    BOOL valid;
    NSInteger step0, step1;
    float mix;
    int stride, i0, j0, cols, rows, ghost, full;
    uint64_t gen;
} ContourKey;

typedef struct {
    float x, y, pz;
    uint8_t front;
} ProjPt;

// Immutable lines. The contour worker fills one and the main queue publishes
// it. Readers on the main thread use the published set only. proj is the
// worker's projection for projCam; the main thread reuses it until the
// camera changes.
typedef struct {
    FieldLine *lines;
    int nLines;
    double *lat;
    double *lon;
    ContourKey key;
    double zoom;
    double milliseconds;
    double projectMilliseconds;
    uint64_t gen;
    OwnExtremum centres[32];
    int nCentres;
    int centresValid;
    ProjPt *proj;
    int *projOf;
    int nProj;
    IsobarCamera projCam;
    int projReady;
} ContourSet;

typedef struct {
    BOOL valid;
    IsobarCamera camera;
} PickKey;

typedef struct {
    int stride, i0, j0, cols, rows, ghost, full;
    double originLon, originLat, dx;
} ContourDomain;

enum { kLabelCap = 80, kCentreCap = 16, kGlyphClasses = 3, kGlyphPer = 13, kGlyphCount = 39 };

typedef struct {
    float x, y, u, v;
    float r, g, b, a;
} TextVertex;
_Static_assert(sizeof(TextVertex) == 32, "text vertex must match the shader");

typedef struct {
    float u0, v0, u1, v1;
    float w, h;
    float originX, originY;
    float advance;
} GlyphSprite;

typedef struct {
    double x, y, angle, level, halfW, halfH;
    int geo;
    float alpha;
    uint32_t ident;
} DrawnLabel;

typedef struct {
    double x, y, value;
    int high;
} DrawnCentre;

typedef struct {
    int active;
    double level, x, y, alpha;
    double lat, lon;
    int geo;
    uint32_t ident;
} MotionSlot;

typedef struct {
    BOOL valid;
    IsobarCamera camera;
    double scale;
    uint64_t gen;
    NSInteger step0, step1;
    float mix;
} AnnKey;

static const char kGlyphChars[] = "0123456789HL-";
static const float kClassPx[3] = {11.f, 18.f, 11.f};

@interface IsobarFieldMotion () {
@public
    MotionSlot slots[kLabelCap];
    int frame;
    uint64_t gen;
    double stepMax;
    double alphaMax;
    NSInteger changes;
    double stamp;
}
@end

@implementation IsobarFieldMotion
- (double)maxLabelStep { return stepMax; }
- (double)maxAnnotationAlphaStep { return alphaMax; }
- (double)minimumActiveAlpha {
    double lowest = 0;
    int n = 0;
    for (int s = 0; s < kLabelCap; s++) {
        if (!slots[s].active) continue;
        if (!n || slots[s].alpha < lowest) lowest = slots[s].alpha;
        n++;
    }
    return n ? lowest : 0;
}
- (NSInteger)labelSetChanges { return changes; }
@end

@interface IsobarFieldSlot : NSObject
@property (nonatomic) NSInteger step;
@property (nonatomic) IsobarFieldKind kind;
@property (nonatomic) uint64_t stamp;
@property (nonatomic) NSUInteger bytes;
@property (nonatomic, strong) id<MTLTexture> texture;
@property (nonatomic, strong) NSData *values;
// Chart-style centre search on the land-mixed field. Pack is three grids
// (gaussian, mild blur, wide blur). Settled is the OwnExtremum list.
// The drawn texture is the uploaded field. The pack is not counted in
// residentBytes.
@property (nonatomic, strong) NSData *synopticPack;
@property (nonatomic, strong) NSData *synopticSettled;
@property (nonatomic) BOOL synopticReady;
@end
@implementation IsobarFieldSlot
@end

@interface IsobarFieldRenderer () {
    OwnCoast _coast;
    OwnCoast _worldCoast;
    uint8_t *_landMask;
    double *_landWeight;
    id<MTLTexture> _landTex;
    id<MTLTexture> _landDummy;
    int _landLon, _landLat;
    double _landWest, _landNorth, _landStep;
    ContourSet *_current;
    ContourSet *_pending;
    PickKey _pickKey;
    IsobarCamera _pickFrameCam;
    BOOL _pickFrameValid;
    uint64_t _contentGen;
    GlyphSprite _sprites[kGlyphCount];
    float _ascent[kGlyphClasses];
    float _descent[kGlyphClasses];
    float _solidU, _solidV;
    int _atlasW, _atlasH;
    DrawnLabel _labels[kLabelCap];
    int _nLabels;
    DrawnCentre _marks[kCentreCap];
    int _nMarks;
    OwnExtremum _cachedCentres[32];
    int _nCached;
    OwnExtremum _prevCentres[32];
    int _nPrev;
    uint64_t _prevGen;
    uint64_t _encodeSeq;
    uint64_t _pickFrameSeq;
    uint64_t _isobarGraceFor;
    BOOL _projExternal;
    NSInteger _cStep0, _cStep1;
    float _cMix;
    uint64_t _cGen;
    BOOL _cValid;
    AnnKey _ann;
    dispatch_queue_t _contourQueue;
    NSArray *_slotGates;
    int _slotNext;
    BOOL _contourBusy;
    int _lodStride;
    double _lodZoom;
    ProjPt *_proj;
    int *_projOf;
    int _projCap;
    int _projLineCap;
    ContourSet *_projSet;
    IsobarCamera _projCam;
    BOOL _projValid;
    float _geomAlpha[kLabelCap];
    id<MTLBuffer> _lineRing[3];
    NSUInteger _lineRingCap[3];
    int _lineRingi;
    id<MTLBuffer> _textRing[3];
    NSUInteger _textRingCap[3];
    int _textRingi;
    BOOL _geomValid;
    ContourSet *_geomSet;
    BOOL _geomIsobars;
    IsobarCamera _geomCam;
    double _geomScale;
    uint64_t _geomGen;
    int _geomLabels;
    int _cachedLineCount;
    int _cachedTextCount;
    // Coastline and the grid edge do not move with the forecast. Playback
    // keeps the camera still, so this mesh is built once and copied.
    FieldLineVertex *_baseVerts;
    int _baseVertCount;
    int _baseVertCap;
    int _lineHighWater;
    // Coastline mesh uploaded once per camera. Playback does not copy it
    // into the isobar buffer every frame.
    id<MTLBuffer> _coastBuf;
    int _coastCount;
    FieldLineVertex *_isoVerts;
    int _isoCap;
    IsobarCamera _baseCam;
    double _baseScale;
    uint64_t _baseGen;
    BOOL _baseReady;
    BOOL _baseDark;
    BOOL _baseTruncated;
    uint64_t _labelSig;
    uint64_t _labelGen;
    NSInteger _labelStep0;
    IsobarCamera _labelCam;
    BOOL _labelReady;
    int _labelHold;
    NSMutableDictionary *_pipes;
    id<MTLBuffer> _pickPixel;
    id<MTLFunction> _fieldVS;
    id<MTLFunction> _fieldFS;
    id<MTLFunction> _lineVS;
    id<MTLFunction> _lineFS;
    id<MTLFunction> _textVS;
    id<MTLFunction> _textFS;
    BOOL _endpointMix;
    NSInteger _endpoint0, _endpoint1;
    float _endpointT;
}
@property (nonatomic, strong) id<MTLDevice> device;
@property (nonatomic, strong) id<MTLCommandQueue> queue;
@property (nonatomic, strong) id<MTLRenderPipelineState> pipeRGBA;
@property (nonatomic, strong) id<MTLRenderPipelineState> pipeBGRA;
@property (nonatomic, strong) id<MTLRenderPipelineState> lineRGBA;
@property (nonatomic, strong) id<MTLRenderPipelineState> lineBGRA;
@property (nonatomic, strong) id<MTLRenderPipelineState> pipePick;
@property (nonatomic, strong) id<MTLRenderPipelineState> textRGBA;
@property (nonatomic, strong) id<MTLRenderPipelineState> textBGRA;
@property (nonatomic, strong) id<MTLTexture> atlas;
@property (nonatomic, strong) id<MTLDepthStencilState> depthWrite;
@property (nonatomic, strong) id<MTLDepthStencilState> depthRead;
@property (nonatomic, strong) NSMutableArray<IsobarFieldSlot *> *slots;
@property (nonatomic) uint64_t clock;
@property (nonatomic) IsobarGeoGrid grid;
@property (nonatomic) BOOL gridOK;
@property (nonatomic, strong) id<MTLBuffer> vertices;
@property (nonatomic, strong) id<MTLBuffer> indices;
@property (nonatomic) NSUInteger indexCount;
@property (nonatomic, strong) id<MTLTexture> colorTex;
@property (nonatomic, strong) id<MTLTexture> depthTex;
@property (nonatomic, strong) id<MTLTexture> pickTex;
@property (nonatomic, strong) id<MTLTexture> pickQuery;
@property (nonatomic, strong) id<MTLTexture> pickQueryDepth;
@property (nonatomic, strong) id<MTLBuffer> readback;
@property (nonatomic, strong) id<MTLBuffer> pickReadback;
@property (nonatomic) NSUInteger depthW;
@property (nonatomic) NSUInteger depthH;
@property (nonatomic) NSUInteger readbackStride;
@property (nonatomic) NSUInteger pickStride;
@property (nonatomic, readwrite) BOOL geometryTruncated;
@end

@implementation IsobarFieldRenderer

static BOOL Fail(NSError **error, NSInteger code, NSString *msg) {
    if (error) *error = [NSError errorWithDomain:kIsobarFieldDomain code:code
        userInfo:@{NSLocalizedDescriptionKey: msg ?: @"field render failed"}];
    return NO;
}

static double GridSouth(IsobarGeoGrid g) { return g.north - (g.nLat - 1) * g.step; }
static double GridEast(IsobarGeoGrid g) { return g.west + (g.nLon - 1) * g.step; }

static BOOL GridOK(IsobarGeoGrid g) {
    if (g.nLon < 2 || g.nLat < 2 || g.nLon > 4096 || g.nLat > 4096) return NO;
    if (!(g.step > 0) || !isfinite(g.west) || !isfinite(g.north)) return NO;
    if ((long long)g.nLon * g.nLat > 4000000) return NO;
    return YES;
}

static int ModIndex(int i, int n) {
    if (n <= 0) return 0;
    int m = i % n;
    if (m < 0) m += n;
    return m;
}

static void WrapGaussian(double *field, int nLon, int nLat, double sigma) {
    if (!field || !(sigma >= 0.4)) return;
    int rad = (int)ceil(3.0 * sigma);
    if (rad < 1) rad = 1;
    if (rad > 8) rad = 8;
    double kernel[17];
    double norm = 0;
    for (int i = -rad; i <= rad; i++) {
        double w = exp(-0.5 * (double)(i * i) / (sigma * sigma));
        kernel[i + rad] = w;
        norm += w;
    }
    for (int i = 0; i <= rad * 2; i++) kernel[i] /= norm;
    size_t n = (size_t)nLon * (size_t)nLat;
    double *val = malloc(n * sizeof(double));
    double *wgt = malloc(n * sizeof(double));
    double *tmpV = malloc(n * sizeof(double));
    double *tmpW = malloc(n * sizeof(double));
    if (!val || !wgt || !tmpV || !tmpW) {
        free(val); free(wgt); free(tmpV); free(tmpW);
        return;
    }
    for (size_t i = 0; i < n; i++) {
        if (isfinite(field[i])) { val[i] = field[i]; wgt[i] = 1; }
        else { val[i] = 0; wgt[i] = 0; }
    }
    for (int j = 0; j < nLat; j++) {
        for (int i = 0; i < nLon; i++) {
            double accV = 0, accW = 0;
            for (int di = -rad; di <= rad; di++) {
                int ii = ModIndex(i + di, nLon);
                double w = kernel[di + rad];
                size_t k = (size_t)j * (size_t)nLon + (size_t)ii;
                accV += w * val[k];
                accW += w * wgt[k];
            }
            size_t o = (size_t)j * (size_t)nLon + (size_t)i;
            tmpV[o] = accV;
            tmpW[o] = accW;
        }
    }
    for (int i = 0; i < nLon; i++) {
        for (int j = 0; j < nLat; j++) {
            double accV = 0, accW = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                int raw = j + dj;
                int jj = raw;
                int flips = 0;
                for (int guard = 0; guard < 6 && (jj < 0 || jj >= nLat); guard++) {
                    if (jj < 0) jj = -jj;
                    else jj = 2 * (nLat - 1) - jj;
                    flips++;
                }
                if (jj < 0) jj = 0;
                if (jj >= nLat) jj = nLat - 1;
                int col = i;
                if (flips & 1) col = ModIndex(i + nLon / 2, nLon);
                double w = kernel[dj + rad];
                size_t k = (size_t)jj * (size_t)nLon + (size_t)col;
                accV += w * tmpV[k];
                accW += w * tmpW[k];
            }
            size_t o = (size_t)j * (size_t)nLon + (size_t)i;
            field[o] = isfinite(field[o]) && accW > 1e-9 ? accV / accW : NAN;
        }
    }
    free(val); free(wgt); free(tmpV); free(tmpW);
}

static void SmoothMSLP(float *values, IsobarGeoGrid g, double sigmaDeg) {
    if (!values || !(g.step > 0) || !(sigmaDeg >= g.step * 0.4)) return;
    size_t n = (size_t)g.nLon * (size_t)g.nLat;
    double *field = malloc(n * sizeof(double));
    if (!field) return;
    for (size_t i = 0; i < n; i++) field[i] = isfinite(values[i]) ? (double)values[i] : NAN;
    double cells = sigmaDeg / g.step;
    if (g.wrapsLongitude) WrapGaussian(field, g.nLon, g.nLat, cells);
    else OwnGaussianSmooth(field, g.nLon, g.nLat, cells);
    for (size_t i = 0; i < n; i++) values[i] = isfinite(field[i]) ? (float)field[i] : NAN;
    free(field);
}

void IsobarSmoothPressure(float *values, IsobarGeoGrid grid, double sigmaDegrees) {
    if (!values || !GridOK(grid)) return;
    if (!isfinite(sigmaDegrees) || sigmaDegrees < 0) return;
    SmoothMSLP(values, grid, sigmaDegrees);
}

static void SetFree(ContourSet *set) {
    if (!set) return;
    free(set->lines);
    free(set->lat);
    free(set->lon);
    free(set->proj);
    free(set->projOf);
    free(set);
}

- (void)detachProj {
    if (_projExternal) {
        _proj = NULL;
        _projOf = NULL;
        _projExternal = NO;
        _projCap = 0;
        _projLineCap = 0;
    }
    _projValid = NO;
    _projSet = NULL;
}

- (void)discardOwnedProj {
    if (_projExternal) {
        [self detachProj];
        return;
    }
    free(_proj);
    free(_projOf);
    _proj = NULL;
    _projOf = NULL;
    _projCap = 0;
    _projLineCap = 0;
    _projValid = NO;
    _projSet = NULL;
}

- (void)clearLines {
    [self detachProj];
    SetFree(_current);
    _current = NULL;
    SetFree(_pending);
    _pending = NULL;
    _geomValid = NO;
}

- (void)dealloc {
    [self clearLines];
    free(_proj);
    free(_projOf);
    free(_baseVerts);
    free(_isoVerts);
    free(_landMask);
    free(_landWeight);
    OwnCoastFree(_coast);
    OwnCoastFree(_worldCoast);
}

static id<MTLRenderPipelineState> MakePipe(id<MTLDevice> device, id<MTLFunction> vs, id<MTLFunction> fs,
    MTLPixelFormat colour, MTLPixelFormat extra, BOOL blend, NSError **error) {
    MTLRenderPipelineDescriptor *desc = [MTLRenderPipelineDescriptor new];
    desc.vertexFunction = vs;
    desc.fragmentFunction = fs;
    desc.colorAttachments[0].pixelFormat = colour;
    if (blend) {
        desc.colorAttachments[0].blendingEnabled = YES;
        desc.colorAttachments[0].rgbBlendOperation = MTLBlendOperationAdd;
        desc.colorAttachments[0].alphaBlendOperation = MTLBlendOperationAdd;
        desc.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
        desc.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        desc.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
        desc.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    }
    if (extra != MTLPixelFormatInvalid) desc.colorAttachments[1].pixelFormat = extra;
    desc.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float;
    return [device newRenderPipelineStateWithDescriptor:desc error:error];
}

static id<MTLRenderPipelineState> MakeTextPipe(id<MTLDevice> device, id<MTLFunction> vs, id<MTLFunction> fs,
    MTLPixelFormat colour, NSError **error) {
    MTLRenderPipelineDescriptor *desc = [MTLRenderPipelineDescriptor new];
    desc.vertexFunction = vs;
    desc.fragmentFunction = fs;
    desc.colorAttachments[0].pixelFormat = colour;
    desc.colorAttachments[0].blendingEnabled = YES;
    desc.colorAttachments[0].rgbBlendOperation = MTLBlendOperationAdd;
    desc.colorAttachments[0].alphaBlendOperation = MTLBlendOperationAdd;
    desc.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorOne;
    desc.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    desc.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
    desc.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    return [device newRenderPipelineStateWithDescriptor:desc error:error];
}

- (BOOL)buildMesh {
    int latSeg = 180, lonSeg = 360;
    int nLatV = latSeg + 1, nLonV = lonSeg + 1;
    size_t nVert = (size_t)nLonV * (size_t)nLatV;
    float *verts = calloc(nVert, sizeof(float) * 2);
    uint32_t *idx = calloc((size_t)lonSeg * (size_t)latSeg * 6, sizeof(uint32_t));
    if (!verts || !idx) {
        free(verts);
        free(idx);
        return NO;
    }
    for (int row = 0; row < nLatV; row++) {
        float lat = (float)(90.0 - 180.0 * row / (double)latSeg);
        for (int col = 0; col < nLonV; col++) {
            float dlon = (float)(-180.0 + 360.0 * col / (double)lonSeg);
            size_t i = ((size_t)row * (size_t)nLonV + (size_t)col) * 2;
            verts[i] = lat;
            verts[i + 1] = dlon;
        }
    }
    NSUInteger n = 0;
    for (int row = 0; row < latSeg; row++) {
        for (int col = 0; col < lonSeg; col++) {
            uint32_t i00 = (uint32_t)(row * nLonV + col);
            uint32_t i10 = i00 + 1;
            uint32_t i01 = i00 + (uint32_t)nLonV;
            uint32_t i11 = i01 + 1;
            idx[n++] = i00; idx[n++] = i10; idx[n++] = i01;
            idx[n++] = i10; idx[n++] = i11; idx[n++] = i01;
        }
    }
    _vertices = [_device newBufferWithBytes:verts length:nVert * sizeof(float) * 2 options:MTLResourceStorageModeShared];
    _indices = [_device newBufferWithBytes:idx length:n * sizeof(uint32_t) options:MTLResourceStorageModeShared];
    _indexCount = n;
    free(verts);
    free(idx);
    return _vertices != nil && _indices != nil && n > 0;
}

- (instancetype)initWithDevice:(id<MTLDevice>)device {
    self = [super init];
    if (!self) return nil;
    if (!device) device = MTLCreateSystemDefaultDevice();
    if (!device) return nil;
    _device = device;
    _queue = [device newCommandQueue];
    _slots = [NSMutableArray array];
    _pressureSmoothDegrees = 0.3125;
    _contentScale = 1;
    _contentGen = 1;
    _residentByteBudget = 64u * 1024u * 1024u;
    _synchronousContours = NO;
    _contourQueue = dispatch_queue_create("isobar.field.contours", DISPATCH_QUEUE_SERIAL);
    _slotGates = @[
        dispatch_semaphore_create(1),
        dispatch_semaphore_create(1),
        dispatch_semaphore_create(1)
    ];
    _pipes = [NSMutableDictionary dictionary];
    if (!_queue) return nil;
    NSError *error = nil;
    MTLCompileOptions *options = [MTLCompileOptions new];
    options.mathMode = MTLMathModeSafe;
    id<MTLLibrary> lib = [device newLibraryWithSource:kShader options:options error:&error];
    if (!lib) {
        fprintf(stderr, "fieldrender: %s\n", error.localizedDescription.UTF8String);
        return nil;
    }
    id<MTLFunction> vs = [lib newFunctionWithName:@"fieldVertex"];
    id<MTLFunction> fs = [lib newFunctionWithName:@"fieldFragment"];
    id<MTLFunction> pick = [lib newFunctionWithName:@"pickFragment"];
    id<MTLFunction> lvs = [lib newFunctionWithName:@"lineVertex"];
    id<MTLFunction> lfs = [lib newFunctionWithName:@"lineFragment"];
    id<MTLFunction> tvs = [lib newFunctionWithName:@"textVertex"];
    id<MTLFunction> tfs = [lib newFunctionWithName:@"textFragment"];
    if (!vs || !fs || !pick || !lvs || !lfs || !tvs || !tfs) return nil;
    _fieldVS = vs;
    _fieldFS = fs;
    _lineVS = lvs;
    _lineFS = lfs;
    _textVS = tvs;
    _textFS = tfs;
    _pipeRGBA = MakePipe(device, vs, fs, MTLPixelFormatRGBA8Unorm, MTLPixelFormatRG32Float, NO, &error);
    _pipeBGRA = MakePipe(device, vs, fs, MTLPixelFormatBGRA8Unorm, MTLPixelFormatRG32Float, NO, &error);
    _lineRGBA = MakePipe(device, lvs, lfs, MTLPixelFormatRGBA8Unorm, MTLPixelFormatInvalid, YES, &error);
    _lineBGRA = MakePipe(device, lvs, lfs, MTLPixelFormatBGRA8Unorm, MTLPixelFormatInvalid, YES, &error);
    _pipePick = MakePipe(device, vs, pick, MTLPixelFormatRG32Float, MTLPixelFormatInvalid, NO, &error);
    _textRGBA = MakeTextPipe(device, tvs, tfs, MTLPixelFormatRGBA8Unorm, &error);
    _textBGRA = MakeTextPipe(device, tvs, tfs, MTLPixelFormatBGRA8Unorm, &error);
    if (!_pipeRGBA || !_pipeBGRA || !_lineRGBA || !_lineBGRA || !_pipePick || !_textRGBA || !_textBGRA) {
        fprintf(stderr, "fieldrender: %s\n", error.localizedDescription.UTF8String ?: "pipeline failed");
        return nil;
    }
    MTLDepthStencilDescriptor *depth = [MTLDepthStencilDescriptor new];
    depth.depthCompareFunction = MTLCompareFunctionLessEqual;
    depth.depthWriteEnabled = YES;
    _depthWrite = [device newDepthStencilStateWithDescriptor:depth];
    depth.depthWriteEnabled = NO;
    _depthRead = [device newDepthStencilStateWithDescriptor:depth];
    if (!_depthWrite || !_depthRead || ![self buildMesh]) return nil;
    _coast = OwnCoastParse([NSData dataWithContentsOfFile:OwnCoastPath()]);
    _worldCoast = OwnCoastParse([NSData dataWithContentsOfFile:OwnWorldCoastPath()]);
    MTLTextureDescriptor *landDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR8Unorm
        width:1 height:1 mipmapped:NO];
    landDesc.usage = MTLTextureUsageShaderRead;
    landDesc.storageMode = MTLStorageModeShared;
    _landDummy = [_device newTextureWithDescriptor:landDesc];
    if (_landDummy) {
        uint8_t landByte = 255;
        [_landDummy replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:&landByte bytesPerRow:1];
    }
    [self rebuildAtlas];
    return self;
}

static OwnCoast CoastForGrid(IsobarGeoGrid grid, OwnCoast australia, OwnCoast world) {
    if (grid.wrapsLongitude) {
        // Never stretch the regional coastline over a world grid. A missing
        // world asset leaves the plate ocean-only until the bundle is fixed;
        // field values still render across every global cell.
        OwnCoast empty = {0};
        BOOL publishedGlobal = grid.nLon == 720 && grid.nLat == 361 && fabs(grid.step - 0.5) < 1e-6;
        return publishedGlobal && world.rings > 0 ? world : empty;
    }
    return australia;
}

- (void)setGrid:(IsobarGeoGrid)grid {
    _gridOK = NO;
    [_slots removeAllObjects];
    [self clearLines];
    free(_landMask);
    free(_landWeight);
    _landMask = NULL;
    _landWeight = NULL;
    _landTex = nil;
    _landLon = 0;
    _landLat = 0;
    _contentGen++;
    _nLabels = 0;
    _nMarks = 0;
    _cValid = NO;
    _ann.valid = NO;
    _nPrev = 0;
    _lodStride = 0;
    _lodZoom = 0;
    _geomValid = NO;
    if (!GridOK(grid)) return;
    _grid = grid;
    _gridOK = YES;
}

- (IsobarFieldSlot *)slotForStep:(NSInteger)step kind:(IsobarFieldKind)kind {
    for (IsobarFieldSlot *slot in _slots)
        if (slot.step == step && slot.kind == kind) return slot;
    return nil;
}

- (void)evictLRU {
    IsobarFieldSlot *oldest = nil;
    for (IsobarFieldSlot *slot in _slots)
        if (!oldest || slot.stamp < oldest.stamp) oldest = slot;
    if (oldest) [_slots removeObject:oldest];
}

- (NSUInteger)residentBytes {
    NSUInteger n = 0;
    for (IsobarFieldSlot *slot in _slots) n += slot.bytes;
    return n;
}

- (BOOL)uploadStep:(NSInteger)step kind:(IsobarFieldKind)kind values:(const float *)values error:(NSError **)error {
    if (!_gridOK) return Fail(error, 2, @"field grid is not set");
    if (!values || step < 0) return Fail(error, 3, @"field upload is missing values");
    if (kind < IsobarFieldPressure || kind > IsobarFieldRain) return Fail(error, 4, @"field kind is unknown");
    NSUInteger count = (NSUInteger)_grid.nLon * (NSUInteger)_grid.nLat;
    NSMutableData *kept = [NSMutableData dataWithLength:count * sizeof(float)];
    float *cpu = kept.mutableBytes;
    for (NSUInteger i = 0; i < count; i++) cpu[i] = isfinite(values[i]) ? values[i] : NAN;
    BOOL pressure = kind == IsobarFieldPressure;
    BOOL rain = kind == IsobarFieldRain;
    if (pressure) {
        double sigma = _pressureSmoothDegrees;
        if (!isfinite(sigma) || sigma < 0) sigma = 0;
        SmoothMSLP(cpu, _grid, sigma);
    }
    // The texture is the uploaded field. Bilinear sampling is the only
    // display blend; an extra Gaussian smears rain and temperature.
    // Rain still keeps the CPU copy so a pick reads the cell, not a neighbour.
    float *gpu = malloc(count * sizeof(float));
    if (!gpu) return Fail(error, 5, @"field upload is out of memory");
    for (NSUInteger i = 0; i < count; i++) gpu[i] = isfinite(cpu[i]) ? cpu[i] : kMissingSentinel;
    NSUInteger need = count * sizeof(float) * ((pressure || rain) ? 2 : 1);
    IsobarFieldSlot *slot = [self slotForStep:step kind:kind];
    while (!slot && _slots.count > 0 && [self residentBytes] + need > _residentByteBudget)
        [self evictLRU];
    if (!slot) {
        MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Float
            width:(NSUInteger)_grid.nLon height:(NSUInteger)_grid.nLat mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;
        id<MTLTexture> tex = [_device newTextureWithDescriptor:desc];
        if (!tex) {
            free(gpu);
            return Fail(error, 6, @"field texture could not be created");
        }
        slot = [IsobarFieldSlot new];
        slot.step = step;
        slot.kind = kind;
        slot.texture = tex;
        [_slots addObject:slot];
    }
    slot.bytes = need;
    [slot.texture replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)_grid.nLon, (NSUInteger)_grid.nLat)
        mipmapLevel:0 withBytes:gpu bytesPerRow:(NSUInteger)_grid.nLon * sizeof(float)];
    free(gpu);
    slot.values = (pressure || rain) ? kept : nil;
    slot.synopticPack = nil;
    slot.synopticSettled = nil;
    slot.synopticReady = NO;
    slot.stamp = ++_clock;
    if (pressure) {
        [self buildSynopticSlot:slot];
        _contentGen++;
        if (_current) _current->key.valid = NO;
        _cValid = NO;
        _ann.valid = NO;
        _geomValid = NO;
        _lodStride = 0;
    }
    return YES;
}

static double LonForGrid(IsobarGeoGrid g, double lon) {
    if (g.wrapsLongitude) return lon;
    double mid = 0.5 * (g.west + GridEast(g));
    return mid + Wrap180(lon - mid);
}

static double Bilinear(const float *values, IsobarGeoGrid g, double lat, double lon) {
    if (!values) return NAN;
    double south = GridSouth(g), east = GridEast(g);
    if (lat > g.north + 1e-4 || lat < south - 1e-4) return NAN;
    lon = LonForGrid(g, lon);
    double fy = (g.north - lat) / g.step;
    if (fy < 0) fy = 0;
    if (fy > g.nLat - 1) fy = g.nLat - 1;
    double fx;
    if (g.wrapsLongitude) {
        double span = (double)g.nLon * g.step;
        double rel = lon - g.west;
        rel = rel - floor(rel / span) * span;
        if (rel < 0) rel += span;
        fx = rel / g.step;
        double n = g.nLon;
        fx = fx - floor(fx / n) * n;
        if (fx < 0) fx += n;
    } else {
        if (lon < g.west - 1e-4 || lon > east + 1e-4) return NAN;
        fx = (lon - g.west) / g.step;
        if (fx < 0) fx = 0;
        if (fx > g.nLon - 1) fx = g.nLon - 1;
    }
    int y0 = (int)floor(fy), x0 = (int)floor(fx);
    double ty = fy - y0, tx = fx - x0;
    int y1 = y0 + 1, x1 = x0 + 1;
    if (y0 < 0) y0 = 0;
    if (y1 >= g.nLat) { y1 = g.nLat - 1; ty = 0; }
    if (g.wrapsLongitude) {
        if (x0 >= g.nLon) x0 -= g.nLon;
        if (x0 < 0) x0 += g.nLon;
        x1 %= g.nLon;
        if (x1 < 0) x1 += g.nLon;
    } else {
        if (x0 < 0) x0 = 0;
        if (x0 >= g.nLon) x0 = g.nLon - 1;
        if (x1 >= g.nLon) { x1 = g.nLon - 1; tx = 0; }
    }
    float v00 = values[y0 * g.nLon + x0];
    float v10 = values[y0 * g.nLon + x1];
    float v01 = values[y1 * g.nLon + x0];
    float v11 = values[y1 * g.nLon + x1];
    double w00 = isfinite(v00) ? (1.0 - tx) * (1.0 - ty) : 0;
    double w10 = isfinite(v10) ? tx * (1.0 - ty) : 0;
    double w01 = isfinite(v01) ? (1.0 - tx) * ty : 0;
    double w11 = isfinite(v11) ? tx * ty : 0;
    double w = w00 + w10 + w01 + w11;
    if (w < 1e-8) return NAN;
    return (w00 * v00 + w10 * v10 + w01 * v01 + w11 * v11) / w;
}

- (double)sampleTexture:(id<MTLTexture>)tex lat:(double)lat lon:(double)lon {
    if (!tex) return NAN;
    double south = GridSouth(_grid), east = GridEast(_grid);
    if (lat > _grid.north + 1e-4 || lat < south - 1e-4) return NAN;
    lon = LonForGrid(_grid, lon);
    double fy = (_grid.north - lat) / _grid.step;
    if (fy < 0) fy = 0;
    if (fy > _grid.nLat - 1) fy = _grid.nLat - 1;
    double fx;
    if (_grid.wrapsLongitude) {
        double span = (double)_grid.nLon * _grid.step;
        double rel = lon - _grid.west;
        rel = rel - floor(rel / span) * span;
        if (rel < 0) rel += span;
        fx = rel / _grid.step;
        fx = fx - floor(fx / _grid.nLon) * _grid.nLon;
        if (fx < 0) fx += _grid.nLon;
    } else {
        if (lon < _grid.west - 1e-4 || lon > east + 1e-4) return NAN;
        fx = (lon - _grid.west) / _grid.step;
        if (fx < 0) fx = 0;
        if (fx > _grid.nLon - 1) fx = _grid.nLon - 1;
    }
    int y0 = (int)floor(fy), x0 = (int)floor(fx);
    double ty = fy - y0, tx = fx - x0;
    int y1 = y0 + 1, x1 = x0 + 1;
    if (y1 >= _grid.nLat) { y1 = _grid.nLat - 1; ty = 0; }
    if (_grid.wrapsLongitude) {
        x0 = ModIndex(x0, _grid.nLon);
        x1 = ModIndex(x1, _grid.nLon);
    } else if (x1 >= _grid.nLon) {
        x1 = _grid.nLon - 1;
        tx = 0;
    }
    float s[4];
    int xs[4] = {x0, x1, x0, x1};
    int ys[4] = {y0, y0, y1, y1};
    double wgt[4] = {(1.0 - tx) * (1.0 - ty), tx * (1.0 - ty), (1.0 - tx) * ty, tx * ty};
    double acc = 0, sum = 0;
    for (int i = 0; i < 4; i++) {
        [tex getBytes:&s[i] bytesPerRow:sizeof(float)
            fromRegion:MTLRegionMake2D((NSUInteger)xs[i], (NSUInteger)ys[i], 1, 1) mipmapLevel:0];
        if (s[i] < -1e20f) continue;
        acc += wgt[i] * s[i];
        sum += wgt[i];
    }
    if (sum < 1e-8) return NAN;
    return acc / sum;
}

- (double)sampleStep:(NSInteger)step kind:(IsobarFieldKind)kind lat:(double)lat lon:(double)lon {
    IsobarFieldSlot *slot = [self slotForStep:step kind:kind];
    if (!slot) return NAN;
    slot.stamp = ++_clock;
    if (slot.values) return Bilinear(slot.values.bytes, _grid, lat, lon);
    return [self sampleTexture:slot.texture lat:lat lon:lon];
}

- (double)pixelsPerPoint { return [self pixelScale]; }

- (void)setPixelsPerPoint:(double)scale { [self setContentScale:scale]; }

- (NSInteger)contourStride {
    return _current && _current->key.valid ? _current->key.stride : 0;
}

- (double)blendAtLat:(double)lat lon:(double)lon time:(double)time kind:(IsobarFieldKind)kind {
    if (!_gridOK || !isfinite(time) || time < 0) return NAN;
    double base = floor(time + 1e-12);
    double f = time - base;
    if (f < 1e-5) return [self sampleStep:(NSInteger)base kind:kind lat:lat lon:lon];
    if (f > 1 - 1e-5) return [self sampleStep:(NSInteger)base + 1 kind:kind lat:lat lon:lon];
    double a = [self sampleStep:(NSInteger)base kind:kind lat:lat lon:lon];
    double b = [self sampleStep:(NSInteger)base + 1 kind:kind lat:lat lon:lon];
    if (!isfinite(a) || !isfinite(b)) return NAN;
    return a * (1 - f) + b * f;
}

static BOOL TimeSteps(double time, NSInteger *i0, NSInteger *i1, float *mix, NSError **error) {
    if (!isfinite(time) || time < -1e-9) return Fail(error, 7, @"forecast time is out of range");
    if (time < 0) time = 0;
    double base = floor(time + 1e-12);
    double f = time - base;
    if (f < 1e-5) f = 0;
    if (f > 1 - 1e-5) {
        base += 1;
        f = 0;
    }
    *i0 = (NSInteger)base;
    *i1 = f == 0 ? *i0 : *i0 + 1;
    *mix = (float)f;
    return YES;
}

static NSInteger NearestTimeStep(double time) {
    NSInteger i0 = 0, i1 = 0;
    float mix = 0;
    if (!TimeSteps(time, &i0, &i1, &mix, NULL)) return 0;
    return mix >= 0.5f ? i1 : i0;
}

static int StrideForZoom(IsobarGeoGrid g, double zoom) {
    double z = zoom > 1e-6 ? zoom : 1e-6;
    double target = fmax(g.step, 1.0 / z);
    int stride = (int)llround(target / g.step);
    if (stride < 1) stride = 1;
    if (stride > g.nLon - 1) stride = g.nLon - 1;
    if (stride > g.nLat - 1) stride = g.nLat - 1;
    if (stride < 1) stride = 1;
    return stride;
}

static int SnapDown(int i, int snap) {
    if (snap <= 1) return i;
    if (i >= 0) return (i / snap) * snap;
    int n = ((-i) + snap - 1) / snap;
    return -n * snap;
}

static BOOL DomainWindow(IsobarGeoGrid g, IsobarCamera cam, int stride, double halfLon, double halfLat, ContourDomain *d) {
    double mLon = fmax(3.0, halfLon * 0.25);
    double mLat = fmax(2.0, halfLat * 0.25);
    double lon0 = cam.centreLon - halfLon - mLon;
    double lon1 = cam.centreLon + halfLon + mLon;
    double latN = fmin(90.0, cam.centreLat + halfLat + mLat);
    double latS = fmax(-90.0, cam.centreLat - halfLat - mLat);
    int iStart = (int)floor((lon0 - g.west) / g.step);
    int iEnd = (int)ceil((lon1 - g.west) / g.step);
    int jStart = (int)floor((g.north - latN) / g.step);
    int jEnd = (int)ceil((g.north - latS) / g.step);
    if (!g.wrapsLongitude) {
        if (iStart < 0) iStart = 0;
        if (iEnd > g.nLon - 1) iEnd = g.nLon - 1;
    }
    if (jStart < 0) jStart = 0;
    if (jEnd > g.nLat - 1) jEnd = g.nLat - 1;
    int snap = stride * 4;
    if (g.wrapsLongitude) iStart = SnapDown(iStart, snap);
    else iStart = (iStart / snap) * snap;
    jStart = (jStart / snap) * snap;
    if (jStart < 0) jStart = 0;
    if (iEnd < iStart) iEnd = iStart;
    if (jEnd < jStart) jEnd = jStart;
    int cols = (iEnd - iStart) / stride + 1;
    int rows = (jEnd - jStart) / stride + 1;
    if (!g.wrapsLongitude && iStart + (cols - 1) * stride > g.nLon - 1)
        cols = 1 + (g.nLon - 1 - iStart) / stride;
    if (jStart + (rows - 1) * stride > g.nLat - 1)
        rows = 1 + (g.nLat - 1 - jStart) / stride;
    if (cols < 2) cols = 2;
    if (rows < 2) rows = 2;
    long cells = (long)cols * rows;
    if (cols > 1000 || rows > 1000 || cells > kContourCellCap) return NO;
    d->stride = stride;
    d->i0 = iStart;
    d->j0 = jStart;
    d->cols = cols;
    d->rows = rows;
    d->ghost = 0;
    d->full = 0;
    d->originLon = g.west + iStart * g.step;
    d->originLat = g.north - jStart * g.step;
    d->dx = stride * g.step;
    return YES;
}

static BOOL DomainBuild(IsobarGeoGrid g, IsobarCamera cam, ContourDomain *d, int holdStride, double holdZoom) {
    memset(d, 0, sizeof *d);
    int stride = StrideForZoom(g, cam.zoom);
    if (holdStride > 0 && holdZoom > 0) {
        if (stride > holdStride && cam.zoom > holdZoom * 0.90) stride = holdStride;
        if (stride < holdStride && cam.zoom < holdZoom * 1.10) stride = holdStride;
    }
    // Marching every native cell of a wide view misses the frame, and the
    // extra vertices are smaller than the smoothed line. A closer view, where
    // a cell is already a large mark, keeps the native grid.
    double cellW, cellH, pxPerDeg, cellRadius, cellGlobe;
    if (Metrics(cam, &cellW, &cellH, &pxPerDeg, &cellRadius, &cellGlobe) && g.step > 0 && stride >= 1) {
        double pxCell = pxPerDeg * g.step * (double)stride;
        if (pxCell > 0 && pxCell < 8.0 && stride <= 4) {
            int doubled = stride * 2;
            if (pxPerDeg * g.step * (double)doubled <= 16.0) stride = doubled;
        }
    }
    int fullStride = stride;
    if (g.wrapsLongitude) {
        int s = stride;
        while (s < g.nLon && (g.nLon % s) != 0) s++;
        if (s < g.nLon && s <= stride * 2) fullStride = s;
        else fullStride = 0;
    }
    if (fullStride > 0) {
        int cols = g.wrapsLongitude ? g.nLon / fullStride : 1 + (g.nLon - 1) / fullStride;
        int rows = 1 + (g.nLat - 1) / fullStride;
        int ghost = g.wrapsLongitude ? 1 : 0;
        long cells = (long)(cols + ghost) * rows;
        if (cols >= 2 && rows >= 2 && cols + ghost <= 1000 && rows <= 1000 && cells <= kContourCellCap) {
            d->stride = fullStride;
            d->cols = cols;
            d->rows = rows;
            d->ghost = ghost;
            d->full = 1;
            d->originLon = g.west;
            d->originLat = g.north;
            d->dx = fullStride * g.step;
            return YES;
        }
    }
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
    double cos0 = fabs(cos(cam.centreLat * kDeg));
    if (cos0 < 0.05) cos0 = 0.05;
    double viewLon = (vw * 0.5) / (px * cos0);
    double viewLat = (vh * 0.5) / px;
    double halfLon = viewLon, halfLat = viewLat;
    if (globe > 0.02) {
        double ax = fmin(1.0, (vw * 0.5) / fmax(radius, 1.0));
        double ay = fmin(1.0, (vh * 0.5) / fmax(radius, 1.0));
        double gLon = asin(ax) / kDeg + 2.0;
        double gLat = asin(ay) / kDeg + 2.0;
        if (radius <= vw * 0.5 && radius <= vh * 0.5) {
            gLon = 100;
            gLat = 100;
        }
        halfLon = fmax(halfLon, gLon);
        halfLat = fmax(halfLat, gLat);
    }
    int strideNow = stride;
    for (int attempt = 0; attempt < 12; attempt++) {
        if (DomainWindow(g, cam, strideNow, halfLon, halfLat, d)) return YES;
        if (halfLon > viewLon * 1.05 || halfLat > viewLat * 1.05) {
            halfLon = fmax(viewLon, halfLon * 0.72);
            halfLat = fmax(viewLat, halfLat * 0.72);
            continue;
        }
        int next = strideNow * 2;
        if (holdStride > 0 && next > stride && cam.zoom > holdZoom * 0.90) {
            halfLon *= 0.75;
            halfLat *= 0.75;
            if (halfLon < 4) halfLon = 4;
            if (halfLat < 3) halfLat = 3;
            if (attempt < 8) continue;
        }
        strideNow = next;
        if (strideNow > 64) break;
    }
    return NO;
}

static BOOL KeyMatch(ContourKey key, ContourDomain d, NSInteger s0, NSInteger s1, float mix, uint64_t gen) {
    return key.valid && key.gen == gen && key.step0 == s0 && key.step1 == s1 && key.mix == mix
        && key.stride == d.stride && key.i0 == d.i0 && key.j0 == d.j0
        && key.cols == d.cols && key.rows == d.rows && key.ghost == d.ghost && key.full == d.full;
}

typedef struct { int a, b; double ta, tb; } TraceLink;

static double TraceLerp(double a, double b, double level) {
    double d = b - a;
    if (fabs(d) < 1e-15) return 0;
    double t = (level - a) / d;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t;
}

static int TraceLinks(const double *field, int nLon, int i, int j, double level, TraceLink *out) {
    double v0 = field[(size_t)j * (size_t)nLon + (size_t)i];
    double v1 = field[(size_t)j * (size_t)nLon + (size_t)i + 1];
    double v2 = field[(size_t)(j + 1) * (size_t)nLon + (size_t)i + 1];
    double v3 = field[(size_t)(j + 1) * (size_t)nLon + (size_t)i];
    if (v0 != v0 || v1 != v1 || v2 != v2 || v3 != v3) return 0;
    double on = 1e-9 * fmax(1.0, fabs(level));
    if (fabs(v0 - level) <= on) v0 = level + on;
    if (fabs(v1 - level) <= on) v1 = level + on;
    if (fabs(v2 - level) <= on) v2 = level + on;
    if (fabs(v3 - level) <= on) v3 = level + on;
    int mask = (v0 >= level) | ((v1 >= level) << 1) | ((v2 >= level) << 2) | ((v3 >= level) << 3);
    if (mask == 0 || mask == 15) return 0;
    double vv[4] = {v0, v1, v2, v3};
    int pairA[4] = {0, 1, 3, 0}, pairB[4] = {1, 2, 2, 3};
    double ts[4];
    int have[4] = {0};
    for (int e = 0; e < 4; e++) {
        int aa = vv[pairA[e]] >= level, bb = vv[pairB[e]] >= level;
        if (aa == bb) continue;
        ts[e] = TraceLerp(vv[pairA[e]], vv[pairB[e]], level);
        have[e] = 1;
    }
    int raw[2][2], n = 0;
#define LINK(x, y) do { if (have[(x)] && have[(y)] && n < 2) { raw[n][0] = (x); raw[n][1] = (y); n++; } } while (0)
    switch (mask) {
        case 1: case 14: LINK(3, 0); break;
        case 2: case 13: LINK(0, 1); break;
        case 3: case 12: LINK(3, 1); break;
        case 4: case 11: LINK(1, 2); break;
        case 6: case 9: LINK(0, 2); break;
        case 7: case 8: LINK(3, 2); break;
        case 5: case 10: {
            double a = v0 - level, b = v1 - level, c = v2 - level, d = v3 - level;
            double scale = fmax(fmax(fabs(a), fabs(b)), fmax(fabs(c), fabs(d)));
            double saddle = (a / scale) * (c / scale) - (b / scale) * (d / scale);
            if (saddle >= 0) { LINK(0, 1); LINK(3, 2); }
            else { LINK(3, 0); LINK(1, 2); }
            break;
        }
        default: break;
    }
#undef LINK
    for (int k = 0; k < n; k++) out[k] = (TraceLink){raw[k][0], raw[k][1], ts[raw[k][0]], ts[raw[k][1]]};
    return n;
}

static void TraceMark(uint8_t *uh, uint8_t *uv, int edge, int i, int j, int nLon, int set) {
    int key, vert = 0;
    if (edge == 0) key = j * (nLon - 1) + i;
    else if (edge == 2) key = (j + 1) * (nLon - 1) + i;
    else if (edge == 1) { key = j * nLon + (i + 1); vert = 1; }
    else { key = j * nLon + i; vert = 1; }
    uint8_t *bits = vert ? uv : uh;
    if (set) bits[key >> 3] |= (uint8_t)(1u << (key & 7));
}

static int TraceUsed(const uint8_t *uh, const uint8_t *uv, int edge, int i, int j, int nLon) {
    int key, vert = 0;
    if (edge == 0) key = j * (nLon - 1) + i;
    else if (edge == 2) key = (j + 1) * (nLon - 1) + i;
    else if (edge == 1) { key = j * nLon + (i + 1); vert = 1; }
    else { key = j * nLon + i; vert = 1; }
    const uint8_t *bits = vert ? uv : uh;
    return (bits[key >> 3] >> (key & 7)) & 1;
}

static int TraceNeighbor(int i, int j, int edge, int nC, int nR, int *ni, int *nj, int *ne) {
    if (edge == 0) { *ni = i; *nj = j - 1; *ne = 2; }
    else if (edge == 2) { *ni = i; *nj = j + 1; *ne = 0; }
    else if (edge == 1) { *ni = i + 1; *nj = j; *ne = 3; }
    else { *ni = i - 1; *nj = j; *ne = 1; }
    return *ni >= 0 && *nj >= 0 && *ni < nC && *nj < nR;
}

static OwnVec TraceAt(int edge, int i, int j, double t, double ox, double oy, double dx, double dy) {
    if (edge == 0) return (OwnVec){ox + (i + t) * dx, oy + j * dy};
    if (edge == 1) return (OwnVec){ox + (i + 1) * dx, oy + (j + t) * dy};
    if (edge == 2) return (OwnVec){ox + (i + t) * dx, oy + (j + 1) * dy};
    return (OwnVec){ox + i * dx, oy + (j + t) * dy};
}

static void TraceAdd(OwnVec **pts, int *n, int *cap, OwnVec p) {
    if (*n > 0 && fabs((*pts)[*n - 1].x - p.x) < 1e-12 && fabs((*pts)[*n - 1].y - p.y) < 1e-12) return;
    if (*n >= *cap) {
        int nc = *cap ? *cap * 2 : 32;
        OwnVec *g = realloc(*pts, (size_t)nc * sizeof(OwnVec));
        if (!g) return;
        *pts = g;
        *cap = nc;
    }
    (*pts)[(*n)++] = p;
}

static int TraceWalk(const double *field, int nLon, int nLat, double level, double ox, double oy, double dx, double dy,
    uint8_t *uh, uint8_t *uv, int i, int j, int entry, OwnVec **pts, int *n, int *cap, int si, int sj, int sentry) {
    int nC = nLon - 1, nR = nLat - 1;
    int guard = nC * nR + 2;
    while (guard-- > 0) {
        TraceLink links[2];
        int nl = TraceLinks(field, nLon, i, j, level, links);
        int found = -1;
        for (int k = 0; k < nl; k++)
            if (links[k].a == entry || links[k].b == entry) { found = k; break; }
        if (found < 0) return 0;
        TraceLink L = links[found];
        int exitE = L.a == entry ? L.b : L.a;
        double tExit = L.a == entry ? L.tb : L.ta;
        TraceMark(uh, uv, entry, i, j, nLon, 1);
        TraceMark(uh, uv, exitE, i, j, nLon, 1);
        TraceAdd(pts, n, cap, TraceAt(exitE, i, j, tExit, ox, oy, dx, dy));
        int ni, nj, ne;
        if (!TraceNeighbor(i, j, exitE, nC, nR, &ni, &nj, &ne)) return 0;
        if (ni == si && nj == sj && ne == sentry) return 1;
        i = ni; j = nj; entry = ne;
    }
    return 0;
}

static void TracePush(OwnLineSet *set, OwnVec *pts, int n, int closed, double level) {
    if (!pts || n < 2 || (closed && n < 4)) { free(pts); return; }
    OwnLine *g = realloc(set->lines, (size_t)(set->count + 1) * sizeof(OwnLine));
    if (!g) { free(pts); return; }
    set->lines = g;
    set->lines[set->count++] = (OwnLine){pts, n, closed, level};
}

static OwnLineSet TraceLevel(const double *field, int nLon, int nLat, double ox, double oy, double dx, double dy, double level) {
    OwnLineSet set = {0};
    if (!field || nLon < 2 || nLat < 2 || !isfinite(level)) return set;
    int nH = nLat * (nLon - 1), nV = (nLat - 1) * nLon;
    uint8_t *uh = calloc((size_t)(nH + 7) / 8, 1);
    uint8_t *uv = calloc((size_t)(nV + 7) / 8, 1);
    if (!uh || !uv) { free(uh); free(uv); return set; }
    int nC = nLon - 1, nR = nLat - 1;
    for (int j = 0; j < nR; j++) {
        for (int i = 0; i < nC; i++) {
            TraceLink links[2];
            int nl = TraceLinks(field, nLon, i, j, level, links);
            for (int k = 0; k < nl; k++) {
                int ends[2] = {links[k].a, links[k].b};
                double ts[2] = {links[k].ta, links[k].tb};
                for (int w = 0; w < 2; w++) {
                    if (TraceUsed(uh, uv, ends[w], i, j, nLon)) continue;
                    OwnVec *pts = NULL;
                    int n = 0, cap = 0;
                    TraceAdd(&pts, &n, &cap, TraceAt(ends[w], i, j, ts[w], ox, oy, dx, dy));
                    TraceMark(uh, uv, ends[w], i, j, nLon, 1);
                    int closed = TraceWalk(field, nLon, nLat, level, ox, oy, dx, dy, uh, uv,
                        i, j, ends[w], &pts, &n, &cap, i, j, ends[w]);
                    if (!closed) {
                        OwnVec *back = NULL;
                        int nb = 0, cb = 0;
                        int ni, nj, ne;
                        if (TraceNeighbor(i, j, ends[w], nC, nR, &ni, &nj, &ne))
                            TraceWalk(field, nLon, nLat, level, ox, oy, dx, dy, uh, uv,
                                ni, nj, ne, &back, &nb, &cb, -1, -1, -1);
                        if (nb > 0) {
                            OwnVec *joined = malloc((size_t)(nb + n) * sizeof(OwnVec));
                            int wj = 0;
                            if (joined) {
                                for (int p = nb - 1; p >= 0; p--) joined[wj++] = back[p];
                                for (int p = 0; p < n; p++) {
                                    if (wj > 0 && fabs(joined[wj - 1].x - pts[p].x) < 1e-12
                                        && fabs(joined[wj - 1].y - pts[p].y) < 1e-12) continue;
                                    joined[wj++] = pts[p];
                                }
                                free(pts);
                                pts = joined;
                                n = wj;
                            }
                        }
                        free(back);
                    } else if (n > 1 && fabs(pts[0].x - pts[n - 1].x) < 1e-9 && fabs(pts[0].y - pts[n - 1].y) < 1e-9) {
                        n--;
                    }
                    TracePush(&set, pts, n, closed, level);
                    break;
                }
            }
        }
    }
    free(uh);
    free(uv);
    return set;
}

static OwnLineSet TraceAll(const double *field, int nLon, int nLat, double ox, double oy, double dx, double dy,
    const double *levels, int nLevels) {
    OwnLineSet all = {0};
    if (!levels || nLevels <= 0) return all;
    OwnLineSet *parts = calloc((size_t)nLevels, sizeof(OwnLineSet));
    if (!parts) return all;
    dispatch_apply((size_t)nLevels, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t L) {
        parts[L] = TraceLevel(field, nLon, nLat, ox, oy, dx, dy, levels[L]);
    });
    for (int L = 0; L < nLevels; L++) {
        for (int i = 0; i < parts[L].count; i++) {
            OwnLine *g = realloc(all.lines, (size_t)(all.count + 1) * sizeof(OwnLine));
            if (!g) break;
            all.lines = g;
            all.lines[all.count++] = parts[L].lines[i];
            parts[L].lines[i].pts = NULL;
        }
        free(parts[L].lines);
    }
    free(parts);
    return all;
}

static double RingLen(const OwnVec *p, int n, int closed) {
    double s = 0;
    int e = closed ? n : n - 1;
    for (int i = 0; i < e; i++) s += hypot(p[(i + 1) % n].x - p[i].x, p[(i + 1) % n].y - p[i].y);
    return s;
}

static double RingAreaAbs(const OwnVec *p, int n) {
    double a = 0;
    for (int i = 0; i < n; i++) {
        OwnVec q = p[(i + 1) % n];
        a += p[i].x * q.y - q.x * p[i].y;
    }
    return fabs(a * 0.5);
}

static void StitchRings(OwnLineSet *set, double tol) {
    for (int i = 0; i < set->count; i++) {
        OwnLine *ln = &set->lines[i];
        if (ln->closed || !ln->pts || ln->count < 4) continue;
        double dlon = Wrap180(ln->pts[ln->count - 1].x - ln->pts[0].x);
        double dlat = ln->pts[ln->count - 1].y - ln->pts[0].y;
        if (hypot(dlon, dlat) > tol) continue;
        // Only drop a point that is the same vertex, not the other side of
        // the antimeridian. A 360° twin is the seam Chaikin must keep.
        double raw = hypot(ln->pts[ln->count - 1].x - ln->pts[0].x, dlat);
        if (raw < 1e-4) ln->count--;
        ln->closed = 1;
    }
}

static OwnLineSet PullSeamRings(OwnLineSet *set) {
    OwnLineSet rings = {0};
    int w = 0;
    for (int i = 0; i < set->count; i++) {
        OwnLine ln = set->lines[i];
        BOOL seam = ln.closed && ln.pts && ln.count >= 4 && RingAreaAbs(ln.pts, ln.count) < 0.45
            && RingLen(ln.pts, ln.count, 1) > 12.0;
        if (!seam) { set->lines[w++] = ln; continue; }
        OwnLine *g = realloc(rings.lines, (size_t)(rings.count + 1) * sizeof(OwnLine));
        if (!g) { set->lines[w++] = ln; continue; }
        rings.lines = g;
        rings.lines[rings.count++] = ln;
    }
    set->count = w;
    return rings;
}

typedef struct {
    FieldLine *lines;
    int nLines;
    int lineCap;
    double *lat;
    double *lon;
    int used;
    int cap;
    OwnVec *scratchA;
    OwnVec *scratchB;
    int scratchCap;
    OwnVec *ring;
    int ringCap;
} ContourBuild;

static void BuildFree(ContourBuild *b) {
    if (!b) return;
    free(b->lines);
    free(b->lat);
    free(b->lon);
    free(b->scratchA);
    free(b->scratchB);
    free(b->ring);
    memset(b, 0, sizeof *b);
}

static BOOL BuildTake(ContourBuild *b, int n, double **lat, double **lon) {
    if (b->used + n > b->cap) {
        int nc = b->cap > 0 ? b->cap : 8192;
        while (nc < b->used + n) nc *= 2;
        double *oldLa = b->lat, *oldLo = b->lon;
        double *la = realloc(b->lat, (size_t)nc * sizeof(double));
        if (!la) return NO;
        double *lo = realloc(b->lon, (size_t)nc * sizeof(double));
        if (!lo) {
            b->lat = la;
            if (la != oldLa) {
                for (int i = 0; i < b->nLines; i++)
                    if (b->lines[i].lat) b->lines[i].lat = la + (b->lines[i].lat - oldLa);
            }
            return NO;
        }
        b->lat = la;
        b->lon = lo;
        b->cap = nc;
        if (la != oldLa || lo != oldLo) {
            for (int i = 0; i < b->nLines; i++) {
                if (b->lines[i].lat) b->lines[i].lat = la + (b->lines[i].lat - oldLa);
                if (b->lines[i].lon) b->lines[i].lon = lo + (b->lines[i].lon - oldLo);
            }
        }
    }
    *lat = b->lat + b->used;
    *lon = b->lon + b->used;
    b->used += n;
    return YES;
}

static BOOL BuildScratch(ContourBuild *b, int n) {
    if (n <= b->scratchCap && b->scratchA && b->scratchB) return YES;
    int nc = b->scratchCap > 0 ? b->scratchCap : 256;
    while (nc < n) nc *= 2;
    OwnVec *a = realloc(b->scratchA, (size_t)nc * sizeof(OwnVec));
    if (!a) return NO;
    b->scratchA = a;
    OwnVec *s = realloc(b->scratchB, (size_t)nc * sizeof(OwnVec));
    if (!s) return NO;
    b->scratchB = s;
    b->scratchCap = nc;
    return YES;
}

static uint32_t LineIdent(double level, const double *lat, const double *lon, int n) {
    // Half-degree bucket of the centroid. Playback moves a line by a fraction
    // of a pixel per frame, so this stays put and a label keeps its isobar.
    // Hashing the vertex count, or hundredths of a degree, changes every frame.
    uint32_t h = 2166136261u;
    h ^= (uint32_t)llround(level * 4.0);
    h *= 16777619u;
    if (n > 0 && lat && lon) {
        double la = 0, lo = 0;
        for (int i = 0; i < n; i++) { la += lat[i]; lo += lon[i]; }
        h ^= (uint32_t)llround((la / n) * 2.0);
        h *= 16777619u;
        h ^= (uint32_t)llround((lo / n) * 2.0);
        h *= 16777619u;
    }
    return h ? h : 1u;
}

static BOOL BuildAppend(ContourBuild *b, const OwnVec *pts, int count, int closed, double level) {
    if (count < 2 || !pts) return YES;
    int n = count;
    int smoothClosed = closed ? 1 : 0;
    if (b->ringCap < count + 1) {
        int nc = b->ringCap > 0 ? b->ringCap : 64;
        while (nc < count + 1) nc *= 2;
        OwnVec *grown = realloc(b->ring, (size_t)nc * sizeof(OwnVec));
        if (!grown) return NO;
        b->ring = grown;
        b->ringCap = nc;
    }
    memcpy(b->ring, pts, (size_t)count * sizeof(OwnVec));
    for (int i = 1; i < count; i++)
        b->ring[i].x = b->ring[i - 1].x + Wrap180(b->ring[i].x - b->ring[i - 1].x);
    if (closed && count >= 3) {
        double dlon = Wrap180(b->ring[0].x - b->ring[count - 1].x);
        double dlat = b->ring[0].y - b->ring[count - 1].y;
        double raw = hypot(b->ring[0].x - b->ring[count - 1].x, b->ring[0].y - b->ring[count - 1].y);
        if (raw > hypot(dlon, dlat) + 0.5) {
            b->ring[count] = (OwnVec){b->ring[count - 1].x + dlon, b->ring[count - 1].y + dlat};
            n = count + 1;
            smoothClosed = 0;
        }
    }
    if (!BuildScratch(b, n * 4)) return NO;
    int n1 = OwnChaikin(b->ring, n, smoothClosed, b->scratchA, n * 2);
    if (n1 < 2) return YES;
    int n2 = OwnChaikin(b->scratchA, n1, smoothClosed, b->scratchB, n1 * 2);
    if (n2 < 2) return YES;
    if (!smoothClosed && closed && n2 > 2) n2--;
    double *la = NULL, *lo = NULL;
    if (!BuildTake(b, n2, &la, &lo)) return NO;
    for (int i = 0; i < n2; i++) {
        lo[i] = b->scratchB[i].x;
        la[i] = b->scratchB[i].y;
    }
    if (b->nLines >= b->lineCap) {
        int nc = b->lineCap > 0 ? b->lineCap * 2 : 16;
        if (nc < b->nLines + 1) nc = b->nLines + 1;
        FieldLine *grown = realloc(b->lines, (size_t)nc * sizeof(FieldLine));
        if (!grown) return NO;
        b->lines = grown;
        b->lineCap = nc;
    }
    b->lines[b->nLines++] = (FieldLine){la, lo, n2, closed, level, LineIdent(level, la, lo, n2)};
    return YES;
}

static int OnCoverageEdge(OwnVec p, double west, double east, double south, double north, double tol, int wrap) {
    if (p.y >= north - tol || p.y <= south + tol) return 1;
    if (!wrap && (p.x <= west + tol || p.x >= east - tol)) return 1;
    return 0;
}

static void PushOwnedLine(OwnLineSet *dst, OwnVec *pts, int n, int closed, double level) {
    if (!pts || n < 2 || (closed && n < 4)) { free(pts); return; }
    OwnLine *grown = realloc(dst->lines, (size_t)(dst->count + 1) * sizeof(OwnLine));
    if (!grown) { free(pts); return; }
    dst->lines = grown;
    dst->lines[dst->count++] = (OwnLine){pts, n, closed, level};
}

static void EmitEdgePiece(OwnLineSet *dst, const OwnVec *src, int from, int to, double level) {
    int n = to - from;
    if (n < 2) return;
    OwnVec *pts = malloc((size_t)n * sizeof(OwnVec));
    if (!pts) return;
    memcpy(pts, src + from, (size_t)n * sizeof(OwnVec));
    PushOwnedLine(dst, pts, n, 0, level);
}

// Keep a line that merely ends on the coverage edge. Drop the vertices that
// continue along that edge, and split the line where the walk does.
static void SplitCoverageEdge(OwnLineSet *dst, const OwnVec *pts, const int *flag, int n, double level) {
    int i = 0;
    while (i < n) {
        while (i < n && flag[i]) i++;
        if (i >= n) break;
        int start = (i > 0 && flag[i - 1]) ? i - 1 : i;
        while (i < n) {
            if (!flag[i]) { i++; continue; }
            int run = i;
            while (run < n && flag[run]) run++;
            if (run - i <= 1 && run < n && !flag[run]) {
                i = run;
                continue;
            }
            break;
        }
        int end = i;
        if (i < n && flag[i]) end = i + 1;
        while (i < n && flag[i]) i++;
        EmitEdgePiece(dst, pts, start, end, level);
    }
}

static void DropCoverageEdge(OwnLineSet *set, double west, double east, double south, double north, double tol, int wrap) {
    if (!set || set->count < 1 || !(tol > 0)) return;
    OwnLineSet kept = {0};
    for (int i = 0; i < set->count; i++) {
        OwnLine ln = set->lines[i];
        if (!ln.pts || ln.count < 2) { free(ln.pts); continue; }
        int *flag = malloc((size_t)ln.count * sizeof(int));
        if (!flag) { PushOwnedLine(&kept, ln.pts, ln.count, ln.closed, ln.level); continue; }
        int longest = 0, run = 0, nEdge = 0;
        for (int k = 0; k < ln.count; k++) {
            flag[k] = OnCoverageEdge(ln.pts[k], west, east, south, north, tol, wrap);
            if (flag[k]) { run++; nEdge++; }
            else { if (run > longest) longest = run; run = 0; }
        }
        if (run > longest) longest = run;
        if (nEdge == 0 || longest <= 1) {
            free(flag);
            PushOwnedLine(&kept, ln.pts, ln.count, ln.closed, ln.level);
            continue;
        }
        if (nEdge == ln.count) {
            free(flag);
            free(ln.pts);
            continue;
        }
        if (ln.closed) {
            int start = 0;
            for (int k = 0; k < ln.count; k++) if (!flag[k]) { start = k; break; }
            if (start > 0) {
                OwnVec *rot = malloc((size_t)ln.count * sizeof(OwnVec));
                int *rf = malloc((size_t)ln.count * sizeof(int));
                if (!rot || !rf) {
                    free(rot);
                    free(rf);
                    free(flag);
                    PushOwnedLine(&kept, ln.pts, ln.count, ln.closed, ln.level);
                    continue;
                }
                for (int k = 0; k < ln.count; k++) {
                    rot[k] = ln.pts[(start + k) % ln.count];
                    rf[k] = flag[(start + k) % ln.count];
                }
                free(ln.pts);
                free(flag);
                ln.pts = rot;
                flag = rf;
            }
        }
        SplitCoverageEdge(&kept, ln.pts, flag, ln.count, ln.level);
        free(flag);
        free(ln.pts);
    }
    free(set->lines);
    *set = kept;
}

static BOOL LandMixGrid(IsobarGeoGrid g, OwnCoast coast);
static ContourSet *BuildContourSet(const float *va, const float *vb, float mix,
    IsobarGeoGrid grid, ContourDomain domain, const double *packA, const double *packB,
    const uint8_t *land, const double *landW, const OwnExtremum *prev, int nPrev, BOOL reuseCentres,
    BOOL carryCentres, uint64_t gen, double zoom, double began, NSInteger s0, NSInteger s1,
    IsobarCamera builtCam);

- (void)installSet:(ContourSet *)set report:(BOOL)report {
    if (!set) return;
    if (set->gen != _contentGen) {
        SetFree(set);
        return;
    }
    [self detachProj];
    SetFree(_current);
    _current = set;
    _lodStride = set->key.stride;
    _lodZoom = set->zoom;
    _lastProjectMilliseconds = set->projectMilliseconds;
    _geomValid = NO;
    if (set->centresValid) {
        _nPrev = set->nCentres;
        if (_nPrev > 32) _nPrev = 32;
        if (_nPrev > 0) memcpy(_prevCentres, set->centres, (size_t)_nPrev * sizeof(OwnExtremum));
        _prevGen = set->gen;
        _cValid = YES;
        _cGen = set->gen;
        _cStep0 = set->key.step0;
        _cStep1 = set->key.step1;
        _cMix = set->key.mix;
        _nCached = _nPrev;
        if (_nCached > 0) memcpy(_cachedCentres, set->centres, (size_t)_nCached * sizeof(OwnExtremum));
    }
    if (report) _lastContourMilliseconds = set->milliseconds;
}

- (BOOL)adoptPending {
    if (!_pending) return NO;
    ContourSet *set = _pending;
    _pending = NULL;
    double ms = set->milliseconds;
    uint64_t gen = set->gen;
    [self installSet:set report:NO];
    if (_current && _current->gen == gen && gen == _contentGen) {
        _lastContourMilliseconds = ms;
        return YES;
    }
    return NO;
}

- (void)ensureContoursStep0:(NSInteger)s0 step1:(NSInteger)s1 mix:(float)mix camera:(IsobarCamera)cam {
    if (![self adoptPending]) _lastContourMilliseconds = 0;
    ContourDomain domain;
    if (!DomainBuild(_grid, cam, &domain, _lodStride, _lodZoom)) {
        [self clearLines];
        return;
    }
    if (_current && KeyMatch(_current->key, domain, s0, s1, mix, _contentGen)) return;
    if (!_synchronousContours && _contourBusy) return;
    IsobarFieldSlot *slotA = [self slotForStep:s0 kind:IsobarFieldPressure];
    IsobarFieldSlot *slotB = mix == 0 ? slotA : [self slotForStep:s1 kind:IsobarFieldPressure];
    if (!slotA || !slotB || !slotA.values || !slotB.values) return;
    NSData *valuesA = slotA.values;
    NSData *valuesB = slotB.values;
    NSData *packDataA = slotA.synopticPack;
    NSData *packDataB = slotB.synopticPack;
    OwnCoast coast = CoastForGrid(_grid, _coast, _worldCoast);
    BOOL landOK = LandMixGrid(_grid, coast) && packDataA != nil && _landMask && _landWeight;
    size_t nCell = (size_t)_grid.nLon * (size_t)_grid.nLat;
    uint8_t *land = NULL;
    double *weight = NULL;
    if (landOK) {
        land = malloc(nCell);
        weight = malloc(nCell * sizeof(double));
        if (!land || !weight) {
            free(land);
            free(weight);
            land = NULL;
            weight = NULL;
            landOK = NO;
        } else {
            memcpy(land, _landMask, nCell);
            memcpy(weight, _landWeight, nCell * sizeof(double));
        }
    }
    uint64_t gen = _contentGen;
    double zoom = cam.zoom;
    double began = NowMs();
    IsobarGeoGrid grid = _grid;
    int nPrev = _prevGen == gen && _nPrev > 0 ? (_nPrev > 32 ? 32 : _nPrev) : 0;
    BOOL samePair = _current && _current->centresValid && _current->gen == gen
        && _current->key.step0 == s0 && _current->key.step1 == s1;
    BOOL reuseCentres = samePair && _current->key.mix == mix;
    BOOL carryCentres = samePair && !reuseCentres && _current->nCentres > 0;
    if (reuseCentres || carryCentres) nPrev = _current->nCentres > 32 ? 32 : _current->nCentres;
    if (!(reuseCentres || carryCentres)) _centreSearches++;
    OwnExtremum *prevCopy = nPrev > 0 ? malloc((size_t)nPrev * sizeof(OwnExtremum)) : NULL;
    if (nPrev > 0 && !prevCopy) nPrev = 0;
    const OwnExtremum *prevSrc = (reuseCentres || carryCentres) ? _current->centres : _prevCentres;
    if (prevCopy && prevSrc) memcpy(prevCopy, prevSrc, (size_t)nPrev * sizeof(OwnExtremum));
    if (_synchronousContours) {
        const double *packA = landOK ? packDataA.bytes : NULL;
        const double *packB = landOK && packDataB ? packDataB.bytes : NULL;
        ContourSet *set = BuildContourSet(valuesA.bytes, valuesB.bytes, mix, grid, domain, packA, packB,
            land, weight, prevCopy, nPrev, reuseCentres, carryCentres, gen, zoom, began, s0, s1, cam);
        free(land);
        free(weight);
        free(prevCopy);
        [self installSet:set report:YES];
        return;
    }
    _contourBusy = YES;
    dispatch_async(_contourQueue, ^{
        const float *fa = valuesA.bytes;
        const float *fb = valuesB.bytes;
        const double *packA = landOK && packDataA ? packDataA.bytes : NULL;
        const double *packB = landOK && packDataB ? packDataB.bytes : NULL;
        ContourSet *set = BuildContourSet(fa, fb, mix, grid, domain, packA, packB,
            land, weight, prevCopy, nPrev, reuseCentres, carryCentres, gen, zoom, began, s0, s1, cam);
        free(land);
        free(weight);
        free(prevCopy);
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self->_pending) SetFree(self->_pending);
            self->_pending = set;
            self->_contourBusy = NO;
        });
    });
}


static void PushSegment(FieldLineVertex **verts, int *count, int *cap,
    float lat0, float dlon0, float lat1, float dlon1, float width, IsobarRGB rgb, float alpha,
    float pixelScale, BOOL *truncated) {
    enum { kLineVertHardCap = 1000000 };
    if (*count + 6 > kLineVertHardCap) {
        if (truncated) *truncated = YES;
        return;
    }
    if (*count + 6 > *cap) {
        int next = *cap ? *cap * 2 : 2048;
        if (next < *count + 6) next = *count + 6;
        FieldLineVertex *grown = realloc(*verts, (size_t)next * sizeof(FieldLineVertex));
        if (!grown) return;
        *verts = grown;
        *cap = next;
    }
    float scale = pixelScale > 0 ? pixelScale : 1;
    // width <= 0 is the coastline: 0.72 pt of solid ink (1.44 device px at
    // 2x, never under 1 px), a half-pixel antialiased edge and no halo. It
    // is drawn over every field so the outline reads at popover zoom.
    // Isobars keep the scaled stroke.
    float halfInk = width <= 0.f ? fmaxf(0.5f, 0.36f * scale) : fmaxf(0.35f * scale, width * 0.5f);
    float halfOuter = width <= 0.f ? halfInk + 0.5f : halfInk + 0.8f * scale;
    float corner[4][2] = {{0, -1}, {1, -1}, {0, 1}, {1, 1}};
    int tri[6] = {0, 1, 2, 1, 3, 2};
    for (int k = 0; k < 6; k++) {
        int c = tri[k];
        FieldLineVertex v;
        v.lat0 = lat0;
        v.lon0 = dlon0;
        v.lat1 = lat1;
        v.lon1 = dlon1;
        v.t = corner[c][0];
        v.side = corner[c][1];
        v.halfInk = halfInk;
        v.halfOuter = halfOuter;
        v.r = (float)rgb.r;
        v.g = (float)rgb.g;
        v.b = (float)rgb.b;
        v.a = alpha;
        (*verts)[(*count)++] = v;
    }
}

static void PushSplit(FieldLineVertex **verts, int *count, int *cap,
    double lat0, double a, double lat1, double b, float width, IsobarRGB rgb, float alpha,
    float pixelScale, BOOL *truncated) {
    if (b > 180.0 || b < -180.0) {
        double cut = b > 180.0 ? 180.0 : -180.0;
        double denom = b - a;
        double t = fabs(denom) > 1e-12 ? (cut - a) / denom : 0.5;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        double latM = lat0 + (lat1 - lat0) * t;
        double other = cut > 0 ? -180.0 : 180.0;
        double bIn = b > 180.0 ? b - 360.0 : b + 360.0;
        if (fabs(a - cut) > 1e-4)
            PushSegment(verts, count, cap, (float)lat0, (float)a, (float)latM, (float)cut, width, rgb, alpha, pixelScale, truncated);
        if (fabs(other - bIn) > 1e-4)
            PushSegment(verts, count, cap, (float)latM, (float)other, (float)lat1, (float)bIn, width, rgb, alpha, pixelScale, truncated);
        return;
    }
    PushSegment(verts, count, cap, (float)lat0, (float)a, (float)lat1, (float)b, width, rgb, alpha, pixelScale, truncated);
}

static void PushPolyline(FieldLineVertex **verts, int *count, int *cap, const double *lat, const double *lon,
    int n, int closed, double centreLon, float width, IsobarRGB rgb, float alpha,
    float pixelScale, BOOL *truncated);

static double PointSegDist(double px, double py, double ax, double ay, double bx, double by) {
    double dx = bx - ax, dy = by - ay;
    double len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return hypot(px - ax, py - ay);
    double t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Screen-space Douglas–Peucker. Endpoints stay. epsilon is in pixels.
static void DouglasKeep(const double *x, const double *y, int i0, int i1, double eps, uint8_t *keep) {
    if (i1 <= i0 + 1) return;
    int cap = (i1 - i0 + 1) * 4;
    if (cap < 8) cap = 8;
    int *stack = malloc((size_t)cap * sizeof(int));
    if (!stack) return;
    int sp = 0;
    stack[sp++] = i0;
    stack[sp++] = i1;
    while (sp >= 2) {
        int b = stack[--sp];
        int a = stack[--sp];
        if (b <= a + 1) continue;
        double maxD = 0;
        int mid = -1;
        for (int i = a + 1; i < b; i++) {
            double d = PointSegDist(x[i], y[i], x[a], y[a], x[b], y[b]);
            if (d > maxD) { maxD = d; mid = i; }
        }
        if (mid < 0 || maxD <= eps) continue;
        keep[mid] = 1;
        if (sp + 4 > cap) {
            int next = cap * 2;
            int *grown = realloc(stack, (size_t)next * sizeof(int));
            if (!grown) break;
            stack = grown;
            cap = next;
        }
        stack[sp++] = a;
        stack[sp++] = mid;
        stack[sp++] = mid;
        stack[sp++] = b;
    }
    free(stack);
}

// One projected run. Islands smaller than a few pixels are dropped.
// Douglas–Peucker at 0.5 px keeps the line within half a pixel of the
// source, so a closer camera keeps more of the ring.
static void PushCoastRun(FieldLineVertex **verts, int *count, int *cap,
    const double *lat, const double *lon, const double *sx, const double *sy, int m, int closed,
    double centreLon, IsobarRGB rgb, float scale, BOOL *truncated) {
    if (m < (closed ? 3 : 2) || !sx || !sy) return;
    double minX = sx[0], maxX = sx[0], minY = sy[0], maxY = sy[0];
    for (int i = 1; i < m; i++) {
        if (sx[i] < minX) minX = sx[i];
        if (sx[i] > maxX) maxX = sx[i];
        if (sy[i] < minY) minY = sy[i];
        if (sy[i] > maxY) maxY = sy[i];
    }
    if ((maxX - minX) < 4.0 && (maxY - minY) < 4.0) return;
    uint8_t *keep = calloc((size_t)m, 1);
    if (!keep) return;
    keep[0] = 1;
    keep[m - 1] = 1;
    if (closed && m >= 3) {
        int far = 1;
        double best = 0;
        for (int i = 1; i < m; i++) {
            double d = hypot(sx[i] - sx[0], sy[i] - sy[0]);
            if (d > best) { best = d; far = i; }
        }
        keep[far] = 1;
        DouglasKeep(sx, sy, 0, far, 0.5, keep);
        int n2 = (m - far) + 1;
        double *cx = malloc((size_t)n2 * sizeof(double));
        double *cy = malloc((size_t)n2 * sizeof(double));
        int *map = malloc((size_t)n2 * sizeof(int));
        uint8_t *keep2 = calloc((size_t)n2, 1);
        if (cx && cy && map && keep2) {
            int w = 0;
            for (int i = far; i < m; i++) {
                cx[w] = sx[i];
                cy[w] = sy[i];
                map[w] = i;
                w++;
            }
            cx[w] = sx[0];
            cy[w] = sy[0];
            map[w] = 0;
            w++;
            keep2[0] = 1;
            keep2[w - 1] = 1;
            DouglasKeep(cx, cy, 0, w - 1, 0.5, keep2);
            for (int i = 0; i < w; i++) if (keep2[i]) keep[map[i]] = 1;
        }
        free(cx);
        free(cy);
        free(map);
        free(keep2);
    } else {
        DouglasKeep(sx, sy, 0, m - 1, 0.5, keep);
    }
    double *outLat = malloc((size_t)m * sizeof(double));
    double *outLon = malloc((size_t)m * sizeof(double));
    int n = 0;
    if (outLat && outLon) {
        for (int i = 0; i < m; i++) {
            if (!keep[i]) continue;
            if (n > 0 && lat[i] == outLat[n - 1] && lon[i] == outLon[n - 1]) continue;
            outLat[n] = lat[i];
            outLon[n] = lon[i];
            n++;
        }
        if (n >= (closed ? 3 : 2))
            PushPolyline(verts, count, cap, outLat, outLon, n, closed, centreLon, 0, rgb, 1, scale, truncated);
    }
    free(outLat);
    free(outLon);
    free(keep);
}

static void PushSimplifiedCoast(FieldLineVertex **verts, int *count, int *cap, const double *lat, const double *lon,
    int n, IsobarCamera cam, IsobarRGB rgb, float scale, BOOL *truncated) {
    if (n < 3) return;
    double *sx = malloc((size_t)n * sizeof(double));
    double *sy = malloc((size_t)n * sizeof(double));
    double *rLat = malloc((size_t)n * sizeof(double));
    double *rLon = malloc((size_t)n * sizeof(double));
    if (!sx || !sy || !rLat || !rLon) {
        free(sx); free(sy); free(rLat); free(rLon);
        return;
    }
    int m = 0;
    for (int i = 0; i < n; i++) {
        double x = 0, y = 0;
        if (!IsobarCameraProject(cam, lat[i], lon[i], &x, &y)) {
            if (m >= 2)
                PushCoastRun(verts, count, cap, rLat, rLon, sx, sy, m, 0, cam.centreLon, rgb, scale, truncated);
            m = 0;
            continue;
        }
        sx[m] = x;
        sy[m] = y;
        rLat[m] = lat[i];
        rLon[m] = lon[i];
        m++;
    }
    if (m == n)
        PushCoastRun(verts, count, cap, rLat, rLon, sx, sy, m, 1, cam.centreLon, rgb, scale, truncated);
    else if (m >= 2)
        PushCoastRun(verts, count, cap, rLat, rLon, sx, sy, m, 0, cam.centreLon, rgb, scale, truncated);
    free(sx);
    free(sy);
    free(rLat);
    free(rLon);
}

static void PushPolyline(FieldLineVertex **verts, int *count, int *cap, const double *lat, const double *lon,
    int n, int closed, double centreLon, float width, IsobarRGB rgb, float alpha,
    float pixelScale, BOOL *truncated) {
    if (n < 2 || (closed && n < 3)) return;
    int segs = closed ? n : n - 1;
    for (int s = 0; s < segs; s++) {
        double lat0 = lat[s], lon0 = lon[s];
        double lat1 = lat[(s + 1) % n], lon1 = lon[(s + 1) % n];
        if (!isfinite(lat0) || !isfinite(lon0) || !isfinite(lat1) || !isfinite(lon1)) continue;
        double delta = Wrap180(lon1 - lon0);
        double a = Wrap180(lon0 - centreLon);
        double b = a + delta;
        PushSplit(verts, count, cap, lat0, a, lat1, b, width, rgb, alpha, pixelScale, truncated);
    }
}

// Hot paths (contour vertices, gap samples, label boxes) must not call
// HighestZ. The GPU drops a fragment whose lerped P.z is below -0.002.
// At globe <= 0.5 the whole sheet stays visible, matching ProjectMark's
// previous rule. The public project API still uses the front-most root.
static BOOL ProjectMark(IsobarCamera cam, double lat, double lon, double *x, double *y) {
    Surface s;
    if (!SurfaceLon(cam, lat, lon, &s)) return NO;
    if (x) *x = s.x;
    if (y) *y = s.y;
    if (cam.pitch > 1e-7) return s.visible;
    if (Clamp01(cam.globe) <= 0.5 + 1e-9) return YES;
    return s.pz >= -0.002;
}

static BOOL CamSame(IsobarCamera a, IsobarCamera b) {
    return a.centreLat == b.centreLat && a.centreLon == b.centreLon && a.zoom == b.zoom
        && a.globe == b.globe && a.pitch == b.pitch && a.viewportW == b.viewportW && a.viewportH == b.viewportH;
}

static int GlyphIndex(int klass, char ch) {
    if (klass < 0 || klass >= kGlyphClasses) return -1;
    const char *p = strchr(kGlyphChars, ch);
    if (!p) return -1;
    return klass * kGlyphPer + (int)(p - kGlyphChars);
}

static double FieldHalfWidth(double level, void *context) {
    const GlyphSprite *sprites = context;
    char buf[16];
    int n = snprintf(buf, sizeof buf, "%d", (int)llround(level));
    if (n < 1) return 8;
    double w = 0;
    for (int i = 0; i < n; i++) {
        int idx = GlyphIndex(0, buf[i]);
        if (idx >= 0) w += sprites[idx].advance;
    }
    return w > 1 ? w * 0.5 : 8;
}

static BOOL SegBox(double x0, double y0, double x1, double y1, double cx, double cy,
    double hw, double hh, double *enter, double *exit) {
    double dx = x1 - x0, dy = y1 - y0;
    double t0 = 0, t1 = 1;
    double p[4] = {-dx, dx, -dy, dy};
    double q[4] = {x0 - (cx - hw), (cx + hw) - x0, y0 - (cy - hh), (cy + hh) - y0};
    for (int i = 0; i < 4; i++) {
        if (fabs(p[i]) < 1e-9) {
            if (q[i] < -1e-8) return NO;
        } else {
            double t = q[i] / p[i];
            if (p[i] < 0) { if (t > t0) t0 = t; }
            else if (t < t1) t1 = t;
            if (t0 > t1 + 1e-12) return NO;
        }
    }
    if (t1 < 0 || t0 > 1) return NO;
    if (t0 < 0) t0 = 0;
    if (t1 > 1) t1 = 1;
    if (t1 - t0 < 1e-5) return NO;
    *enter = t0;
    *exit = t1;
    return YES;
}

static double LonNorm(double lon, double west, double span) {
    if (!(span > 0)) return lon;
    double x = lon - west;
    x = x - floor(x / span) * span;
    if (x < 0) x += span;
    return west + x;
}

static CTLineRef GlyphLine(CTFontRef font, UniChar ch, CGColorRef color) {
    const void *keys[] = {kCTFontAttributeName, kCTForegroundColorAttributeName};
    const void *vals[] = {font, color};
    CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, vals, 2,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFStringRef s = CFStringCreateWithCharacters(NULL, &ch, 1);
    CFAttributedStringRef astr = CFAttributedStringCreate(NULL, s, attrs);
    CTLineRef line = CTLineCreateWithAttributedString(astr);
    CFRelease(astr);
    CFRelease(s);
    CFRelease(attrs);
    return line;
}

static int FindExtrema(const double *field, int nLon, int nLat, double west, double north, double step,
    BOOL wrap, OwnExtremum *out, double *prom, int cap) {
    if (!field || !out || !prom || cap <= 0 || nLon < 3 || nLat < 3) return 0;
    double dx = step, dy = -step;
    double sep = fmax(step * 2.0, 1.25);
    double relief = 0.3;
    double radius = 3.6;
    if (!wrap) {
        int n = OwnExtrema(field, nLon, nLat, west, north, dx, dy, sep, relief, out, cap);
        for (int i = 0; i < n; i++)
            prom[i] = OwnRingProminence(field, nLon, nLat, west, north, dx, dy, out[i].x, out[i].y, radius);
        return n;
    }
    int pad = (int)ceil(radius / step) + 2;
    if (pad < 2) pad = 2;
    if (pad > nLon / 4) pad = nLon / 4;
    if (pad < 2) pad = 2;
    int nW = nLon + 2 * pad;
    double *padded = malloc((size_t)nW * (size_t)nLat * sizeof(double));
    if (!padded) return 0;
    for (int j = 0; j < nLat; j++) {
        for (int i = 0; i < nW; i++)
            padded[(size_t)j * (size_t)nW + (size_t)i] = field[(size_t)j * (size_t)nLon + (size_t)ModIndex(i - pad, nLon)];
    }
    OwnExtremum tmp[96];
    int n = OwnExtrema(padded, nW, nLat, west - pad * step, north, dx, dy, sep, relief, tmp, 96);
    double span = (double)nLon * step;
    int kept = 0;
    for (int i = 0; i < n && kept < cap; i++) {
        double lon = LonNorm(tmp[i].x, west, span);
        double lat = tmp[i].y;
        BOOL dup = NO;
        for (int k = 0; k < kept; k++) {
            double dlon = fabs(Wrap180(lon - out[k].x));
            if (hypot(dlon, lat - out[k].y) < sep) { dup = YES; break; }
        }
        if (dup) continue;
        prom[kept] = OwnRingProminence(padded, nW, nLat, west - pad * step, north, dx, dy, tmp[i].x, tmp[i].y, radius);
        out[kept] = tmp[i];
        out[kept].x = lon;
        kept++;
    }
    free(padded);
    return kept;
}

static double FieldBilinear(const double *field, IsobarGeoGrid g, double lat, double lon) {
    if (!field) return NAN;
    double south = GridSouth(g), east = GridEast(g);
    if (lat > g.north + 1e-4 || lat < south - 1e-4) return NAN;
    double fy = (g.north - lat) / g.step;
    if (fy < 0 || fy > g.nLat - 1) return NAN;
    double fx;
    if (g.wrapsLongitude) {
        double span = (double)g.nLon * g.step;
        double rel = lon - g.west;
        rel = rel - floor(rel / span) * span;
        if (rel < 0) rel += span;
        fx = rel / g.step;
        double n = g.nLon;
        fx = fx - floor(fx / n) * n;
        if (fx < 0) fx += n;
    } else {
        lon = LonForGrid(g, lon);
        if (lon < g.west - 1e-4 || lon > east + 1e-4) return NAN;
        fx = (lon - g.west) / g.step;
        if (fx < 0 || fx > g.nLon - 1) return NAN;
    }
    int y0 = (int)floor(fy), x0 = (int)floor(fx);
    double ty = fy - y0, tx = fx - x0;
    int y1 = y0 + 1, x1 = x0 + 1;
    if (y1 >= g.nLat) { y1 = g.nLat - 1; ty = 0; }
    if (g.wrapsLongitude) {
        x0 = ModIndex(x0, g.nLon);
        x1 = ModIndex(x1, g.nLon);
    } else if (x1 >= g.nLon) {
        x1 = g.nLon - 1;
        tx = 0;
    }
    double v00 = field[(size_t)y0 * (size_t)g.nLon + (size_t)x0];
    double v10 = field[(size_t)y0 * (size_t)g.nLon + (size_t)x1];
    double v01 = field[(size_t)y1 * (size_t)g.nLon + (size_t)x0];
    double v11 = field[(size_t)y1 * (size_t)g.nLon + (size_t)x1];
    if (!isfinite(v00) || !isfinite(v10) || !isfinite(v01) || !isfinite(v11)) return NAN;
    double a = v00 + (v10 - v00) * tx;
    double b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
}

typedef struct {
    OwnVec *pts;
    int count, cap, closed, geo;
    double level;
    uint32_t ident;
    float minX, minY, maxX, maxY;
} SLine;

static void SAdd(SLine *line, double x, double y) {
    if (line->count == 0) {
        line->minX = line->maxX = (float)x;
        line->minY = line->maxY = (float)y;
    } else {
        if (x < line->minX) line->minX = (float)x;
        if (x > line->maxX) line->maxX = (float)x;
        if (y < line->minY) line->minY = (float)y;
        if (y > line->maxY) line->maxY = (float)y;
    }
    if (line->count >= line->cap) {
        int ncap = line->cap ? line->cap * 2 : 32;
        OwnVec *grown = realloc(line->pts, (size_t)ncap * sizeof(OwnVec));
        if (!grown) return;
        line->pts = grown;
        line->cap = ncap;
    }
    line->pts[line->count++] = (OwnVec){x, y};
}

static void SFlush(SLine **lines, int *n, int *cap, SLine *cur) {
    if (cur->count < 2) {
        free(cur->pts);
        *cur = (SLine){0};
        return;
    }
    if (*n >= *cap) {
        int ncap = *cap ? *cap * 2 : 16;
        SLine *grown = realloc(*lines, (size_t)ncap * sizeof(SLine));
        if (!grown) {
            free(cur->pts);
            *cur = (SLine){0};
            return;
        }
        *lines = grown;
        *cap = ncap;
    }
    (*lines)[(*n)++] = *cur;
    *cur = (SLine){0};
}

static void PushTextVert(TextVertex **verts, int *n, int *cap, float x, float y, float u, float v,
    float r, float g, float b, float a) {
    if (*n + 1 > *cap) {
        int next = *cap ? *cap * 2 : 256;
        TextVertex *grown = realloc(*verts, (size_t)next * sizeof(TextVertex));
        if (!grown) return;
        *verts = grown;
        *cap = next;
    }
    if (*n >= 24000) return;
    (*verts)[(*n)++] = (TextVertex){x, y, u, v, r, g, b, a};
}

static void PushSolidStroke(TextVertex **verts, int *n, int *cap, float x0, float y0, float x1, float y1,
    float width, float u, float v, float r, float g, float b, float a) {
    float dx = x1 - x0, dy = y1 - y0;
    float len = hypotf(dx, dy);
    if (len < 1e-3f) return;
    float nx = -dy / len * width * 0.5f;
    float ny = dx / len * width * 0.5f;
    float xs[4] = {x0 + nx, x1 + nx, x0 - nx, x1 - nx};
    float ys[4] = {y0 + ny, y1 + ny, y0 - ny, y1 - ny};
    float pr = r * a, pg = g * a, pb = b * a;
    int tri[6] = {0, 1, 2, 1, 3, 2};
    for (int k = 0; k < 6; k++) {
        int i = tri[k];
        PushTextVert(verts, n, cap, xs[i], ys[i], u, v, pr, pg, pb, a);
    }
}

- (double)pixelScale {
    double s = _contentScale;
    if (!isfinite(s) || s < 1) return 1;
    if (s > 3) return 3;
    return s;
}

- (void)setContentScale:(double)scale {
    if (!isfinite(scale)) scale = 1;
    if (scale < 1) scale = 1;
    if (scale > 3) scale = 3;
    if (_atlas && fabs(_contentScale - scale) < 1e-6) return;
    _contentScale = scale;
    _ann.valid = NO;
    [self rebuildAtlas];
}

- (void)setChartDark:(BOOL)dark {
    if (_chartDark == dark) return;
    _chartDark = dark;
    _baseReady = NO;
    _geomValid = NO;
    _ann.valid = NO;
    [self rebuildAtlas];
}

- (void)rebuildAtlas {
    _atlas = nil;
    memset(_sprites, 0, sizeof _sprites);
    double scale = [self pixelScale];
    _contentScale = scale;
    int cell = (int)ceil(kClassPx[1] * (float)scale * 2.8);
    if (cell < 48) cell = 48;
    int cols = 8;
    int rows = (kGlyphCount + cols - 1) / cols;
    int margin = 2;
    _atlasW = margin + cols * cell;
    _atlasH = margin + rows * cell;
    size_t stride = (size_t)_atlasW * 4;
    uint8_t *px = calloc((size_t)_atlasH * stride, 1);
    if (!px) return;
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(px, (size_t)_atlasW, (size_t)_atlasH, 8, stride, space,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!ctx) {
        free(px);
        return;
    }
    CGContextSetShouldAntialias(ctx, true);
    CGContextSetShouldSmoothFonts(ctx, false);
    CGContextSetAllowsFontSmoothing(ctx, false);
    CGContextSetShouldSubpixelPositionFonts(ctx, false);
    CGContextSetShouldSubpixelQuantizeFonts(ctx, false);
    OwnChartPalette plate = OwnChartPaletteFor(_chartDark);
    CGColorRef ink = CGColorCreateSRGB(plate.label.r, plate.label.g, plate.label.b, 1);
    // A one-pixel plate knockout keeps inline labels clear without a heavy halo.
    double haloR = plate.sea.r, haloG = plate.sea.g, haloB = plate.sea.b;
    CGColorRef halo = CGColorCreateSRGB(haloR, haloG, haloB, 1);
    for (int klass = 0; klass < kGlyphClasses; klass++) {
        float size = kClassPx[klass] * (float)scale;
        CTFontRef font = CTFontCreateWithName(klass == 0 ? CFSTR("HelveticaNeue-Medium") : CFSTR("Helvetica-Bold"), size, NULL);
        if (!font) continue;
        _ascent[klass] = (float)CTFontGetAscent(font);
        _descent[klass] = (float)CTFontGetDescent(font);
        float stroke = 1.0f; // One physical pixel of plate knockout, independent of scale.
        for (int c = 0; c < kGlyphPer; c++) {
            int index = klass * kGlyphPer + c;
            int col = index % cols;
            int row = index / cols;
            float top = margin + row * cell;
            float left = margin + col * cell;
            float baseX = left + 5.f * (float)scale;
            float baseYUp = (_atlasH - top) - _ascent[klass] - 4.f * (float)scale;
            UniChar ch = (UniChar)kGlyphChars[c];
            CTLineRef haloLine = GlyphLine(font, ch, halo);
            CTLineRef inkLine = GlyphLine(font, ch, ink);
            if (haloLine) {
                CGContextSaveGState(ctx);
                CGContextSetTextDrawingMode(ctx, kCGTextStroke);
                CGContextSetLineWidth(ctx, stroke);
                CGContextSetLineJoin(ctx, kCGLineJoinRound);
                CGContextSetLineCap(ctx, kCGLineCapRound);
                CGContextSetRGBStrokeColor(ctx, haloR, haloG, haloB, 1);
                CGContextSetTextPosition(ctx, baseX, baseYUp);
                CTLineDraw(haloLine, ctx);
                CGContextRestoreGState(ctx);
                CFRelease(haloLine);
            }
            CGFloat ascent = 0, descent = 0, leading = 0;
            double advance = 0;
            if (inkLine) {
                advance = CTLineGetTypographicBounds(inkLine, &ascent, &descent, &leading);
                CGContextSetTextDrawingMode(ctx, kCGTextFill);
                CGContextSetTextPosition(ctx, baseX, baseYUp);
                CTLineDraw(inkLine, ctx);
                CFRelease(inkLine);
            }
            float baseY = (float)_atlasH - baseYUp;
            int x0 = (int)left, y0 = (int)top;
            int x1 = x0 + cell, y1 = y0 + cell;
            if (x1 > _atlasW) x1 = _atlasW;
            if (y1 > _atlasH) y1 = _atlasH;
            int minX = x1, minY = y1, maxX = x0 - 1, maxY = y0 - 1;
            for (int y = y0; y < y1; y++) {
                const uint8_t *rowp = px + (size_t)y * stride;
                for (int x = x0; x < x1; x++) {
                    if (rowp[x * 4 + 3] < 12) continue;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
            GlyphSprite *g = &_sprites[index];
            g->advance = (float)(advance > 0.5 ? advance : size * 0.6);
            if (maxX < minX) continue;
            if (minX > x0) minX--;
            if (minY > y0) minY--;
            if (maxX + 1 < x1) maxX++;
            if (maxY + 1 < y1) maxY++;
            g->w = (float)(maxX - minX + 1);
            g->h = (float)(maxY - minY + 1);
            g->originX = (float)minX - baseX;
            g->originY = (float)minY - baseY;
            g->u0 = (float)minX / (float)_atlasW;
            g->v0 = (float)minY / (float)_atlasH;
            g->u1 = (float)(maxX + 1) / (float)_atlasW;
            g->v1 = (float)(maxY + 1) / (float)_atlasH;
        }
        CFRelease(font);
    }
    CGContextRelease(ctx);
    CGColorRelease(ink);
    CGColorRelease(halo);
    px[0] = px[1] = px[2] = px[3] = 255;
    px[4] = px[5] = px[6] = px[7] = 255;
    _solidU = 0.5f / (float)_atlasW;
    _solidV = 0.5f / (float)_atlasH;
    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
        width:(NSUInteger)_atlasW height:(NSUInteger)_atlasH mipmapped:NO];
    desc.usage = MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModeShared;
    id<MTLTexture> tex = [_device newTextureWithDescriptor:desc];
    if (tex) {
        [tex replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)_atlasW, (NSUInteger)_atlasH)
            mipmapLevel:0 withBytes:px bytesPerRow:stride];
        _atlas = tex;
    }
    free(px);
}

- (BOOL)onCoverageX:(double)x y:(double)y camera:(IsobarCamera)cam {
    double lat = 0, lon = 0;
    double g = Clamp01(cam.globe);
    BOOL ok = NO;
    if (cam.pitch > 1e-7) ok = UnprojectTilted(cam,x,y,&lat,&lon);
    else if (g <= 1e-7) ok = UnprojectFlat(cam, x, y, &lat, &lon);
    else if (g >= 1 - 1e-7 && fabs(cam.pitch) <= 1e-7) ok = UnprojectSphere(cam, x, y, &lat, &lon);
    else {
        // One short Newton from the closer closed form. The coarse net and
        // HighestZ stay on the public unproject.
        double vw, vh, px, radius, globe;
        if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return NO;
        double X = (x - vw * 0.5) / radius;
        double Y = (vh * 0.5 - y) / radius;
        double seeds[2][2];
        int nSeed = 0;
        double sla, slo;
        if (UnprojectFlat(cam, x, y, &sla, &slo)) { seeds[nSeed][0] = sla; seeds[nSeed][1] = slo; nSeed++; }
        if (UnprojectSphere(cam, x, y, &sla, &slo)) { seeds[nSeed][0] = sla; seeds[nSeed][1] = slo; nSeed++; }
        double bestErr = 1e300, bestLat = 0, bestLon = 0;
        for (int s = 0; s < nSeed; s++) {
            Surface seed;
            if (!SurfaceLon(cam, seeds[s][0], seeds[s][1], &seed)) continue;
            double err = hypot(seed.x - x, seed.y - y);
            if (err < bestErr) { bestErr = err; bestLat = seeds[s][0]; bestLon = seeds[s][1]; ok = YES; }
        }
        if (ok && bestErr > 1.5) {
            double op, ol, oz;
            if (NewtonRoot(cam, X, Y, bestLat * kDeg, Wrap180(bestLon - cam.centreLon) * kDeg, &op, &ol, &oz)) {
                bestLat = op / kDeg;
                bestLon = Wrap180(cam.centreLon + ol / kDeg);
            }
        }
        if (ok) { lat = bestLat; lon = bestLon; }
    }
    if (!ok) return NO;
    Surface s;
    if (!SurfaceLon(cam, lat, lon, &s)) return NO;
    if (cam.pitch > 1e-7 && !s.visible) return NO;
    if (g > 0.5 + 1e-9 && s.pz < -0.002) return NO;
    if (hypot(s.x - x, s.y - y) > (g > 1e-7 && g < 1 - 1e-7 ? 1.5 : 1.0)) return NO;
    double south = GridSouth(_grid);
    if (lat > _grid.north + 1e-3 || lat < south - 1e-3) return NO;
    if (_grid.wrapsLongitude) return YES;
    lon = LonForGrid(_grid, lon);
    return lon >= _grid.west - 1e-3 && lon <= GridEast(_grid) + 1e-3;
}

// Viewport pixels. Same-level isobars stay 140 px apart; any pair stays a
// label width plus 24 px apart. Matches OwnPlaceLabels.
static BOOL LabelSitesClear(double x, double y, double half, double level, uint32_t ident, const DrawnLabel *labs, int n) {
    (void)level;
    for (int i = 0; i < n; i++) {
        double gap = hypot(x - labs[i].x, y - labs[i].y);
        double width = 2.0 * fmax(half, labs[i].halfW);
        // Every pair keeps a label of clearance. A second label on the same
        // isobar stays at least 140 px away, so one contour cannot read twice.
        double need = fmax(3.0 * width, width + 24.0);
        if (ident && labs[i].ident == ident) need = fmax(need, 140.0);
        if (gap < need) return NO;
    }
    return YES;
}

static BOOL ClearOfCentres(double x, double y, const OwnVec *centres, int n, double gap) {
    if (!(gap > 0) || !centres) return YES;
    for (int c = 0; c < n; c++)
        if (hypot(x - centres[c].x, y - centres[c].y) < gap) return NO;
    return YES;
}

- (BOOL)labelFits:(DrawnLabel)lab camera:(IsobarCamera)cam {
    if (!(lab.halfW > 0) || !(lab.halfH > 0)) return NO;
    // The halo stroke sits outside the advance box. Keep that fringe inside
    // the viewport and on data, so a label is not clipped or drawn on the plate.
    double fringe = 4.0 * [self pixelScale];
    double hw = lab.halfW + fringe, hh = lab.halfH + fringe;
    if (lab.x < hw || lab.y < hh) return NO;
    if (lab.x > cam.viewportW - hw || lab.y > cam.viewportH - hh) return NO;
    double xs[5] = {lab.x, lab.x - hw, lab.x + hw, lab.x, lab.x};
    double ys[5] = {lab.y, lab.y, lab.y, lab.y - hh, lab.y + hh};
    for (int i = 0; i < 5; i++)
        if (![self onCoverageX:xs[i] y:ys[i] camera:cam]) return NO;
    return YES;
}

// The site OwnPlaceLabels picked can sit on the plate or on a centre. Walk
// the screen line for the nearest point that clears both.
- (BOOL)refitLabel:(DrawnLabel *)lab on:(const SLine *)line centres:(const OwnVec *)centres
    nCentres:(int)nCentres camera:(IsobarCamera)cam {
    if (!lab || !line || line->count < 2) return NO;
    double gap = 6.0 * lab->halfW;
    double ox = lab->x, oy = lab->y;
    int step = 1;
    if (line->count > 96) step = line->count / 96;
    BOOL found = NO;
    double best = 1e300;
    DrawnLabel kept = *lab;
    for (int p = 0; p < line->count; p += step) {
        DrawnLabel trial = *lab;
        trial.x = line->pts[p].x;
        trial.y = line->pts[p].y;
        int a = p > 0 ? p - 1 : 0;
        int b = p + 1 < line->count ? p + 1 : p;
        trial.angle = OwnReadableAngle(atan2(line->pts[b].y - line->pts[a].y,
            line->pts[b].x - line->pts[a].x));
        if (![self labelFits:trial camera:cam]) continue;
        if (!ClearOfCentres(trial.x, trial.y, centres, nCentres, gap)) continue;
        double d = hypot(trial.x - ox, trial.y - oy);
        if (!found || d < best) { found = YES; best = d; kept = trial; }
    }
    if (!found) return NO;
    *lab = kept;
    return YES;
}

static int SeekExtrema(const double *field, int nLon, int nLat, double west, double north, double step,
    BOOL wrap, OwnExtremum *out, double *prom, int cap) {
    int dec = (int)llround(1.0 / step);
    if (dec < 1) dec = 1;
    if (dec > 8) dec = 8;
    if (dec == 1 || nLon / dec < 8 || nLat / dec < 8)
        return FindExtrema(field, nLon, nLat, west, north, step, wrap, out, prom, cap);
    int nC = 1 + (nLon - 1) / dec;
    int nR = 1 + (nLat - 1) / dec;
    double *coarse = malloc((size_t)nC * (size_t)nR * sizeof(double));
    if (!coarse) return FindExtrema(field, nLon, nLat, west, north, step, wrap, out, prom, cap);
    for (int j = 0; j < nR; j++) {
        int jj = j * dec;
        if (jj >= nLat) jj = nLat - 1;
        for (int i = 0; i < nC; i++) {
            int ii = i * dec;
            if (ii >= nLon) ii = nLon - 1;
            coarse[(size_t)j * (size_t)nC + (size_t)i] = field[(size_t)jj * (size_t)nLon + (size_t)ii];
        }
    }
    int n = FindExtrema(coarse, nC, nR, west, north, step * dec, wrap, out, prom, cap);
    free(coarse);
    for (int k = 0; k < n; k++) {
        int i0 = (int)llround((out[k].x - west) / step);
        int j0 = (int)llround((north - out[k].y) / step);
        int bestI = i0, bestJ = j0;
        double best = NAN;
        for (int dj = -dec; dj <= dec; dj++) {
            int j = j0 + dj;
            if (j < 0 || j >= nLat) continue;
            for (int di = -dec; di <= dec; di++) {
                int i = i0 + di;
                if (wrap) i = ModIndex(i, nLon);
                if (i < 0 || i >= nLon) continue;
                double v = field[(size_t)j * (size_t)nLon + (size_t)i];
                if (v != v) continue;
                if (best != best || (out[k].high ? v > best : v < best)) {
                    best = v;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        if (best == best) {
            out[k].x = west + bestI * step;
            out[k].y = north - bestJ * step;
            out[k].value = best;
        }
        prom[k] = OwnRingProminence(field, nLon, nLat, west, north, step, -step, out[k].x, out[k].y, 4.0);
    }
    return n;
}

// A world grid is about a million cells. Copying it to doubles and walking
// every contour for enclosure blows the contour budget, and there is no
// global land mask to mix against. Centres come from the same decimated
// extrema the smaller grids use, sampled straight from the uploaded floats.
static int CentresCoarse(const float *va, const float *vb, float mix, IsobarGeoGrid g,
    const OwnExtremum *prev, int nPrev, OwnExtremum *out, int cap) {
    int dec = (int)llround(1.0 / g.step);
    if (dec < 1) dec = 1;
    if (dec > 8) dec = 8;
    int nC = 1 + (g.nLon - 1) / dec;
    int nR = 1 + (g.nLat - 1) / dec;
    if (nC < 8 || nR < 8) return 0;
    double *coarse = malloc((size_t)nC * (size_t)nR * sizeof(double));
    if (!coarse) return 0;
    int nCell = g.nLon * g.nLat;
    for (int j = 0; j < nR; j++) {
        int jj = j * dec;
        if (jj >= g.nLat) jj = g.nLat - 1;
        for (int i = 0; i < nC; i++) {
            int ii = i * dec;
            if (ii >= g.nLon) ii = g.nLon - 1;
            int at = jj * g.nLon + ii;
            float fa = va && at < nCell ? va[at] : NAN;
            float fb = vb && at < nCell ? vb[at] : NAN;
            double v = NAN;
            if (mix <= 0) v = isfinite(fa) ? fa : NAN;
            else if (mix >= 1) v = isfinite(fb) ? fb : NAN;
            else if (isfinite(fa) && isfinite(fb)) v = (1.0 - mix) * fa + mix * fb;
            coarse[(size_t)j * (size_t)nC + (size_t)i] = v;
        }
    }
    OwnExtremum cand[48];
    double prom[48];
    int nCand = FindExtrema(coarse, nC, nR, g.west, g.north, g.step * dec, g.wrapsLongitude, cand, prom, 48);
    free(coarse);
    int enclosed[48] = {0};
    return OwnSettleCentres(cand, prom, enclosed, nCand, kOwnIsobarInterval, 0.5, 860.0, 500.0, 1,
        prev, nPrev, out, cap);
}

static void ScreenCentres(const double *field, int nLon, int nLat, double west, double north, double step,
    BOOL wrap, OwnExtremum *cand, double *prom, int *enclosed, int n, const OwnLine *owns, int nLines) {
    if (!field || !cand || !prom || !enclosed || n <= 0) return;
    int rad = (int)llround(4.0 / step);
    if (rad < 2) rad = 2;
    int rad2 = rad * rad;
    for (int c = 0; c < n; c++) {
        int col = (int)llround((cand[c].x - west) / step);
        int row = (int)llround((north - cand[c].y) / step);
        if (wrap) col = ModIndex(col, nLon);
        BOOL lonEdge = !wrap && (col < rad || col >= nLon - rad);
        if (lonEdge || row < rad || row >= nLat - rad || col < 0 || col >= nLon) {
            prom[c] = 0;
            enclosed[c] = 0;
            continue;
        }
        double z = cand[c].value, sum = 0;
        int seen = 0, flat = 0;
        for (int dj = -rad; dj <= rad; dj++) {
            int jj = row + dj;
            if (jj < 0 || jj >= nLat) continue;
            for (int di = -rad; di <= rad; di++) {
                if (!di && !dj) continue;
                if (di * di + dj * dj > rad2) continue;
                int ii = col + di;
                if (wrap) ii = ModIndex(ii, nLon);
                else if (ii < 0 || ii >= nLon) continue;
                double v = field[(size_t)jj * (size_t)nLon + (size_t)ii];
                if (v != v) continue;
                // A plateau rim is level with other cells in the disk. A centre
                // is the unique extreme, even when the next cell is only a
                // little lower.
                if (cand[c].high ? v > z - 1e-3 : v < z + 1e-3) flat++;
                sum += v;
                seen++;
            }
        }
        if (seen < 8 || flat > 0) { prom[c] = 0; enclosed[c] = 0; continue; }
        double mean = sum / seen;
        if (cand[c].high) {
            if (!(z > mean + 0.8)) { prom[c] = 0; enclosed[c] = 0; continue; }
        } else if (!(z < mean - 0.8)) {
            prom[c] = 0;
            enclosed[c] = 0;
            continue;
        }
        if (!enclosed[c] || !owns) continue;
        double bestArea = 1e300, bestLevel = NAN;
        for (int li = 0; li < nLines; li++) {
            const OwnLine *ln = &owns[li];
            if (!ln->closed || !ln->pts || ln->count < 4) continue;
            if (!OwnLineContains(ln, cand[c].x, cand[c].y)) continue;
            double loX = 1e300, hiX = -1e300, loY = 1e300, hiY = -1e300;
            for (int p = 0; p < ln->count; p++) {
                if (ln->pts[p].x < loX) loX = ln->pts[p].x;
                if (ln->pts[p].x > hiX) hiX = ln->pts[p].x;
                if (ln->pts[p].y < loY) loY = ln->pts[p].y;
                if (ln->pts[p].y > hiY) hiY = ln->pts[p].y;
            }
            if (fmax(hiX - loX, hiY - loY) < 6.0) continue;
            double area = RingAreaAbs(ln->pts, ln->count);
            if (area < bestArea) { bestArea = area; bestLevel = ln->level; }
        }
        if (!(bestArea < 1e299) || bestArea < 12.0) enclosed[c] = 0;
        else if (fabs(cand[c].value - bestLevel) < 4.0 && fabs(prom[c]) < 4.0) {
            enclosed[c] = 0;
            prom[c] = 0;
        }
    }
}

// The chart's H/L search is static in tools/own-chart.m (BlurField,
// BlurFiniteField, MixLandMSLP, BuildLandMask, SynopticCandidates). It is
// copied here. Settlement, enclosure, ring prominence and contours are the
// shared Own* calls. The upload already applied OwnGaussianSmooth at 1.25
// cells on a 0.25° grid, which is the chart's first smooth.
static const double kPlateWest = 108.0, kPlateEast = 162.0, kPlateSouth = -45.5, kPlateNorth = -5.0;
static const double kPlateW = 580.0, kPlateH = 444.0;

static BOOL SynopticGrid(IsobarGeoGrid g) {
    return !g.wrapsLongitude && fabs(g.step - 0.25) < 1e-6 && g.nLon >= 48 && g.nLat >= 48;
}

static BOOL ChartPlate(IsobarGeoGrid g) {
    return SynopticGrid(g) && g.nLon == 301 && g.nLat == 201
        && fabs(g.west - 95.0) < 1e-4 && fabs(g.north) < 1e-4;
}

// The chart's candidate disk is 4° and its contour window keeps two cells.
// Centres sit that far inside the loaded grid. The Australian Lambert
// rectangle is the chart's frame, not a property of every grid.
static double EdgeMargin(IsobarGeoGrid g) {
    double cells = 2.0 * g.step;
    double ring = 4.0;
    return ring > cells ? ring : cells;
}

static void CandidateBox(IsobarGeoGrid g, double *minLon, double *maxLon, double *minLat, double *maxLat) {
    double m = EdgeMargin(g);
    double south = GridSouth(g);
    double east = g.wrapsLongitude ? g.west + g.nLon * g.step : GridEast(g);
    double w = g.west + (g.wrapsLongitude ? 0.0 : m);
    double e = east - (g.wrapsLongitude ? 0.0 : m);
    double s = south + m;
    double n = g.north - m;
    if (n < s) { n = g.north; s = south; }
    if (e < w) { w = g.west; e = east; }
    if (minLon) *minLon = w;
    if (maxLon) *maxLon = e;
    if (minLat) *minLat = s;
    if (maxLat) *maxLat = n;
}

// The bundled coast is an Australian crop. It covers a grid when that grid
// sits inside the crop. A wrapping world grid does not: there is no global
// land mask here, and none is invented.
static BOOL CoastSpansGrid(OwnCoast coast, IsobarGeoGrid g) {
    if (coast.rings < 1 || coast.points < 3 || !coast.lat || !coast.lon) return NO;
    double w = 1e300, e = -1e300, s = 1e300, n = -1e300;
    for (int i = 0; i < coast.points; i++) {
        if (coast.lon[i] < w) w = coast.lon[i];
        if (coast.lon[i] > e) e = coast.lon[i];
        if (coast.lat[i] < s) s = coast.lat[i];
        if (coast.lat[i] > n) n = coast.lat[i];
    }
    double gs = GridSouth(g);
    double ge = g.wrapsLongitude ? g.west + g.nLon * g.step : GridEast(g);
    return g.west >= w - 1.0 && ge <= e + 1.0 && gs >= s - 1.0 && g.north <= n + 1.0;
}

static BOOL LandMixGrid(IsobarGeoGrid g, OwnCoast coast) {
    if (!CoastSpansGrid(coast, g)) return NO;
    if (g.nLon < 24 || g.nLat < 24) return NO;
    if (!(g.step > 0) || g.step > 2.0) return NO;
    int rad = (int)llround(4.0 / g.step);
    if (rad < 2) rad = 2;
    if (g.nLon <= rad * 2 + 4 || g.nLat <= rad * 2 + 4) return NO;
    return YES;
}

static void BlurClamp(const double *src, double *dst, int nLon, int nLat, double sigma) {
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

static void BlurFiniteClamp(const double *src, double *dst, int nLon, int nLat, double sigma) {
    size_t n = (size_t)nLon * nLat;
    BOOL missing = NO;
    for (size_t i = 0; i < n; i++) if (!isfinite(src[i])) { missing = YES; break; }
    if (!missing) { BlurClamp(src, dst, nLon, nLat, sigma); return; }
    double *values = malloc(n * sizeof(double)), *weights = malloc(n * sizeof(double));
    double *normal = malloc(n * sizeof(double));
    if (!values || !weights || !normal) {
        free(values); free(weights); free(normal);
        memcpy(dst, src, n * sizeof(double));
        return;
    }
    for (size_t i = 0; i < n; i++) {
        weights[i] = isfinite(src[i]) ? 1 : 0;
        values[i] = isfinite(src[i]) ? src[i] : 0;
    }
    BlurClamp(values, dst, nLon, nLat, sigma);
    BlurClamp(weights, normal, nLon, nLat, sigma);
    for (size_t i = 0; i < n; i++) dst[i] = isfinite(src[i]) && normal[i] > 1e-9 ? dst[i] / normal[i] : NAN;
    free(values); free(weights); free(normal);
}

static void MixLandPressure(double *field, const double *mild, const double *wide,
    const double *terrainW, const uint8_t *land, int n, uint8_t *roughOut) {
    if (!field || !mild || !wide || n < 1) return;
    for (int i = 0; i < n; i++) {
        double terrain = terrainW ? terrainW[i] : 0;
        if (terrain < 0) terrain = 0;
        if (terrain > 1) terrain = 1;
        double delta = fabs(field[i] - wide[i]);
        if (roughOut) roughOut[i] = land && land[i] && delta > 1.8;
        double rough = (delta - 0.6) / 2.4;
        if (rough < 0) rough = 0;
        if (rough > 1) rough = 1;
        rough = rough * rough * (3.0 - 2.0 * rough);
        double wideBlend = terrain * (0.4 + 0.45 * rough);
        double base = field[i] * (1.0 - 0.75 * terrain) + mild[i] * (0.75 * terrain);
        field[i] = base * (1.0 - wideBlend) + wide[i] * wideBlend;
    }
}

static uint8_t *LandMaskFromCoast(OwnCoast coast, int nLon, int nLat, double west, double north, double step, BOOL wraps) {
    if (coast.rings < 1 || nLon < 2 || nLat < 2 || !(step > 0)) return NULL;
    uint8_t *land = calloc((size_t)nLon * (size_t)nLat, 1);
    double *cross = malloc((size_t)coast.points * sizeof(double));
    if (!land || !cross) { free(land); free(cross); return NULL; }
    for (int r = 0; r < coast.rings; r++) {
        int start = coast.ringStart[r];
        int n = coast.ringCount[r];
        for (int j = 0; j < nLat; j++) {
            int nCross = 0;
            double y = j;
            for (int e = 0; e < n; e++) {
                int prev = e == 0 ? n - 1 : e - 1;
                double y0 = (north - coast.lat[start + prev]) / step;
                double y1 = (north - coast.lat[start + e]) / step;
                double x0 = (coast.lon[start + prev] - west) / step;
                double x1 = (coast.lon[start + e] - west) / step;
                if (wraps) {
                    double period = 360.0 / step;
                    while (x1 - x0 > period * 0.5) x1 -= period;
                    while (x0 - x1 > period * 0.5) x1 += period;
                }
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
                double period = wraps ? 360.0 / step : 0;
                int copies = wraps ? 3 : 1;
                for (int copy = 0; copy < copies; copy++) {
                    double shift = wraps ? (copy - 1) * period : 0;
                    int a = (int)ceil(cross[k] + shift - 1e-8);
                    int b = (int)floor(cross[k + 1] + shift + 1e-8);
                    if (a < 0) a = 0;
                    if (b >= nLon) b = nLon - 1;
                    for (int i = a; i <= b; i++) land[j * nLon + i] = 1;
                }
            }
        }
    }
    free(cross);
    return land;
}

// The published Australian grid is larger than the coastline bbox, so the
// synoptic land mix does not cover it. The display mask still fills that
// grid: cells outside every ring stay ocean. ECMWF land-sea mask is not in
// the store; the coastline polygons are the mask.
// The plate mask is kLandMaskFactor times finer than the grid, so the
// land/sea edge follows the coast line instead of 0.25° cells (about 10 px
// at popover zoom). The shader scales by the texture's own size.
enum { kLandMaskFactor = 4 };

- (void)ensureLandTexture {
    OwnCoast coast = CoastForGrid(_grid, _coast, _worldCoast);
    // Display geography follows the supported archive extent, not its weather
    // sampling resolution. The 1-degree archive/fixtures cover the same coast
    // as the 0.25-degree chart; restricting this to ChartPlate silently dropped
    // their land/sea tokens and exposed the light-only pressure fallback ramp.
    BOOL australianExtent = !_grid.wrapsLongitude && fabs(_grid.west - 95.0) < 1e-4 &&
        fabs(_grid.north) < 1e-4 && fabs(GridEast(_grid) - 170.0) < 1e-4 &&
        fabs(GridSouth(_grid) + 50.0) < 1e-4;
    if (_landTex || !_gridOK || (!australianExtent && !_grid.wrapsLongitude) ||
        coast.rings < 1 || !_device) return;
    int maskLon = _grid.wrapsLongitude ? _grid.nLon * kLandMaskFactor
        : (_grid.nLon - 1) * kLandMaskFactor + 1;
    int maskLat = (_grid.nLat - 1) * kLandMaskFactor + 1;
    uint8_t *mask = LandMaskFromCoast(coast, maskLon, maskLat, _grid.west, _grid.north,
        _grid.step / kLandMaskFactor, _grid.wrapsLongitude);
    if (!mask) return;
    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR8Unorm
        width:(NSUInteger)maskLon height:(NSUInteger)maskLat mipmapped:NO];
    desc.usage = MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModeShared;
    id<MTLTexture> tex = [_device newTextureWithDescriptor:desc];
    if (!tex) {
        free(mask);
        return;
    }
    // R8Unorm stores 255 as 1. The mask uses 1 for land.
    NSUInteger rowBytes = ((NSUInteger)maskLon + 255u) & ~255u;
    uint8_t *padded = calloc((size_t)rowBytes * (size_t)maskLat, 1);
    if (!padded) {
        free(mask);
        return;
    }
    for (int j = 0; j < maskLat; j++) {
        for (int i = 0; i < maskLon; i++) {
            if (mask[j * maskLon + i]) padded[(size_t)j * rowBytes + (size_t)i] = 255;
        }
    }
    free(mask);
    [tex replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)maskLon, (NSUInteger)maskLat)
        mipmapLevel:0 withBytes:padded bytesPerRow:rowBytes];
    free(padded);
    _landTex = tex;
}

static BOOL RoughNear(const uint8_t *mask, int nLon, int nLat, double west, double north, double step,
    double lon, double lat, int rad) {
    if (!mask || !(step > 0)) return NO;
    int i = (int)llround((lon - west) / step);
    int j = (int)llround((north - lat) / step);
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

// A float16 terrace is flat for several degrees, so the 4° ring understates a
// real high. The wider ring is the same centre minus the mean further out.
static double CentreScore(const double *field, int nLon, int nLat, double west, double north, double step,
    double lon, double lat, int high, int plateau) {
    double score = OwnRingProminence(field, nLon, nLat, west, north, step, -step, lon, lat, 4.0);
    if (!plateau) return score;
    double wide = OwnRingProminence(field, nLon, nLat, west, north, step, -step, lon, lat, 8.0);
    if (high ? wide > score : wide < score) score = wide;
    return score;
}

static int SynopticCandidates(const double *field, int nLon, int nLat, double west, double north, double step,
    const uint8_t *rough, double minLon, double maxLon, double minLat, double maxLat, BOOL wrapLon,
    OwnExtremum *out, double *prominence, int cap) {
    if (!field || !out || cap <= 0 || !(step > 0)) return 0;
    int rad = (int)llround(4.0 / step);
    if (rad < 2) rad = 2;
    typedef struct { double value, score, lon, lat; int high, plateau; } Cand;
    int maxCand = 64;
    Cand *cands = malloc((size_t)maxCand * sizeof(Cand));
    if (!cands) return 0;
    size_t pitch = (size_t)nLon + 1;
    double *rowSums = calloc((size_t)nLat * pitch, sizeof(double));
    int *rowCounts = calloc((size_t)nLat * pitch, sizeof(int));
    size_t cells = (size_t)nLon * (size_t)nLat;
    uint8_t *claimed = calloc(cells, 1);
    int *queue = malloc(cells * sizeof(int));
    int *members = malloc(cells * sizeof(int));
    if (!rowSums || !rowCounts || !claimed || !queue || !members) {
        free(rowSums); free(rowCounts); free(cands); free(claimed); free(queue); free(members);
        return 0;
    }
    for (int j = 0; j < nLat; j++) {
        for (int i = 0; i < nLon; i++) {
            double value = field[(size_t)j * (size_t)nLon + (size_t)i];
            rowSums[(size_t)j * pitch + (size_t)i + 1] = rowSums[(size_t)j * pitch + (size_t)i] + (isfinite(value) ? value : 0);
            rowCounts[(size_t)j * pitch + (size_t)i + 1] = rowCounts[(size_t)j * pitch + (size_t)i] + (isfinite(value) ? 1 : 0);
        }
    }
    int n = 0;
    for (int j = rad; j < nLat - rad; j++) {
        for (int i = rad; i < nLon - rad; i++) {
            double z = field[(size_t)j * (size_t)nLon + (size_t)i];
            if (!isfinite(z) || claimed[(size_t)j * (size_t)nLon + (size_t)i]) continue;
            double lon = west + i * step;
            double lat = north - j * step;
            if (!wrapLon && (lon < minLon || lon > maxLon)) continue;
            if (lat < minLat || lat > maxLat) continue;
            BOOL localLow = YES, localHigh = YES, plateau = NO;
            for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
                if (!di && !dj) continue;
                double nearby = field[(size_t)(j + dj) * (size_t)nLon + (size_t)(i + di)];
                if (!isfinite(nearby)) { localLow = NO; localHigh = NO; }
                if (fabs(nearby - z) <= 1e-3) plateau = YES;
                if (nearby < z - .05) localLow = NO;
                if (nearby > z + .05) localHigh = NO;
            }
            // A tied neighbour is still the top of a float16 terrace. Rejecting
            // it dropped the broad southern high and kept only the rim.
            if (!localLow && !localHigh) continue;
            int rad2 = rad * rad;
            double quickSum = 0;
            int quickSeen = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                int reach = (int)floor(sqrt((double)(rad2 - dj * dj)));
                size_t row = (size_t)(j + dj) * pitch;
                quickSum += rowSums[row + (size_t)i + (size_t)reach + 1] - rowSums[row + (size_t)i - (size_t)reach];
                quickSeen += rowCounts[row + (size_t)i + (size_t)reach + 1] - rowCounts[row + (size_t)i - (size_t)reach];
            }
            if (quickSeen < 20) continue;
            double quickMean = quickSum / quickSeen;
            if (localLow && z >= quickMean - 0.8 + 1e-8) localLow = NO;
            if (localHigh && z <= quickMean + 0.8 - 1e-8) localHigh = NO;
            if (!localLow && !localHigh) continue;
            BOOL low = YES, high = YES;
            double sum = 0;
            int seen = 0;
            for (int dj = -rad; dj <= rad; dj++) {
                for (int di = -rad; di <= rad; di++) {
                    if (di * di + dj * dj > rad2) continue;
                    double value = field[(size_t)(j + dj) * (size_t)nLon + (size_t)(i + di)];
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
            if (plateau) {
                int qh = 0, qt = 0, nMem = 0;
                int seed = j * nLon + i;
                queue[qt++] = seed;
                claimed[seed] = 1;
                while (qh < qt) {
                    int idx = queue[qh++];
                    members[nMem++] = idx;
                    int ii = idx % nLon, jj = idx / nLon;
                    for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
                        if (!di && !dj) continue;
                        int ni = ii + di, nj = jj + dj;
                        if (ni < 0 || nj < 0 || ni >= nLon || nj >= nLat) continue;
                        size_t nidx = (size_t)nj * (size_t)nLon + (size_t)ni;
                        if (claimed[nidx]) continue;
                        double value = field[nidx];
                        if (!isfinite(value) || fabs(value - z) > 1e-3) continue;
                        claimed[nidx] = 1;
                        queue[qt++] = (int)nidx;
                    }
                }
                double sumLat = 0, sumLon = 0;
                for (int m = 0; m < nMem; m++) {
                    int ii = members[m] % nLon, jj = members[m] / nLon;
                    sumLon += west + ii * step;
                    sumLat += north - jj * step;
                }
                double cLon = sumLon / nMem, cLat = sumLat / nMem;
                double best = 1e300;
                for (int m = 0; m < nMem; m++) {
                    int ii = members[m] % nLon, jj = members[m] / nLon;
                    double d = hypot((west + ii * step) - cLon, (north - jj * step) - cLat);
                    if (d < best) { best = d; lon = west + ii * step; lat = north - jj * step; }
                }
            }
            if (n >= maxCand) {
                maxCand *= 2;
                Cand *grown = realloc(cands, (size_t)maxCand * sizeof(Cand));
                if (!grown) break;
                cands = grown;
            }
            cands[n++] = (Cand){z, 0, lon, lat, kind, plateau ? 1 : 0};
        }
    }
    free(rowSums);
    free(rowCounts);
    free(claimed);
    free(queue);
    free(members);
    for (int a = 0; a < n; a++) {
        cands[a].score = CentreScore(field, nLon, nLat, west, north, step,
            cands[a].lon, cands[a].lat, cands[a].high, cands[a].plateau);
        BOOL rightSign = cands[a].high ? cands[a].score > 0.3 : cands[a].score < -0.3;
        if (!rightSign) cands[a].score = 0;
        // Rough land is the chart's stand-in for high terrain. A centre there
        // is the reduction spike (New Guinea, the Andes), not a synoptic mark.
        if (cands[a].score != 0 && RoughNear(rough, nLon, nLat, west, north, step, cands[a].lon, cands[a].lat, 2))
            cands[a].score = 0;
    }
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
        int i = (int)llround((cands[a].lon - west) / step);
        int j = (int)llround((north - cands[a].lat) / step);
        if (i > 0 && i < nLon - 1 && j > 0 && j < nLat - 1) {
            double zm = field[(size_t)j * (size_t)nLon + (size_t)(i - 1)];
            double zp = field[(size_t)j * (size_t)nLon + (size_t)(i + 1)];
            double denom = zm - 2.0 * cands[a].value + zp;
            if (isfinite(zm) && isfinite(zp) && isfinite(denom) && fabs(denom) > 1e-6) {
                ox = 0.5 * (zm - zp) / denom;
                if (ox > 0.75) ox = 0.75;
                if (ox < -0.75) ox = -0.75;
            }
            zm = field[(size_t)(j - 1) * (size_t)nLon + (size_t)i];
            zp = field[(size_t)(j + 1) * (size_t)nLon + (size_t)i];
            denom = zm - 2.0 * cands[a].value + zp;
            if (isfinite(zm) && isfinite(zp) && isfinite(denom) && fabs(denom) > 1e-6) {
                oy = 0.5 * (zm - zp) / denom;
                if (oy > 0.75) oy = 0.75;
                if (oy < -0.75) oy = -0.75;
            }
        }
        double lon = west + (i + ox) * step;
        double lat = north - (j + oy) * step;
        double score = CentreScore(field, nLon, nLat, west, north, step, lon, lat, cands[a].high, cands[a].plateau);
        if (cands[a].high ? score < 0.3 : score > -0.3) continue;
        out[written] = (OwnExtremum){lon, lat, cands[a].value, cands[a].high};
        if (prominence) prominence[written] = score;
        written++;
    }
    free(cands);
    return written;
}

static BOOL PlateUnproject(OwnView view, double x, double yDown, double *lat, double *lon) {
    if (!view.valid || view.scale == 0 || !lat || !lon) return NO;
    double projX = view.minX + (x - view.offsetX) / view.scale;
    double projY = view.maxY - (yDown - view.offsetY) / view.scale;
    return OwnUnproject(view.geo, projX, projY, lat, lon);
}

static double *PlateWindow(const double *field, int nLon, int nLat, double west, double north, double step,
    int *outW, int *outH, double *originX, double *originY) {
    if (!field || !(step > 0)) return NULL;
    OwnView view = OwnViewMake(OwnAustraliaLambert(), kPlateWest, kPlateEast, kPlateSouth, kPlateNorth,
        0, 0, kPlateW, kPlateH);
    double boxW = kPlateWest, boxE = kPlateEast, boxS = kPlateSouth, boxN = kPlateNorth;
    for (int k = 0; k <= 64; k++) {
        double u = k / 64.0;
        double edge[4][2] = {{u * kPlateW, 0}, {u * kPlateW, kPlateH}, {0, u * kPlateH}, {kPlateW, u * kPlateH}};
        for (int e = 0; e < 4; e++) {
            double lat, lon;
            if (!PlateUnproject(view, edge[e][0], edge[e][1], &lat, &lon)) continue;
            if (lon < boxW) boxW = lon;
            if (lon > boxE) boxE = lon;
            if (lat < boxS) boxS = lat;
            if (lat > boxN) boxN = lat;
        }
    }
    int i0 = (int)floor((boxW - west) / step) - 2;
    int i1 = (int)ceil((boxE - west) / step) + 2;
    int j0 = (int)floor((north - boxN) / step) - 2;
    int j1 = (int)ceil((north - boxS) / step) + 2;
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
    *originX = west + i0 * step;
    *originY = north - j0 * step;
    return box;
}

static void MarkSynopticEnclosed(const double *field, IsobarGeoGrid g, BOOL plate,
    OwnExtremum *cand, int nCand, int *enclosed) {
    if (!enclosed) return;
    for (int i = 0; i < nCand; i++) enclosed[i] = 0;
    if (!field || nCand < 1) return;
    int nLon = g.nLon, nLat = g.nLat;
    double west = g.west, north = g.north, step = g.step;
    int winW = 0, winH = 0;
    double originX = west, originY = north;
    double *window = plate ? PlateWindow(field, nLon, nLat, west, north, step, &winW, &winH, &originX, &originY) : NULL;
    const double *used = window ? window : field;
    int cLon = window ? winW : nLon;
    int cLat = window ? winH : nLat;
    double lo = INFINITY, hi = -INFINITY;
    int nCell = cLon * cLat;
    for (int i = 0; i < nCell; i++) {
        if (!isfinite(used[i])) continue;
        if (used[i] < lo) lo = used[i];
        if (used[i] > hi) hi = used[i];
    }
    if (!(hi > lo)) { free(window); return; }
    double levels[56];
    int nLevels = OwnInteriorLevels(lo, hi, 4, levels, 56);
    if (nLevels < 1) { free(window); return; }
    OwnLineSet raw = OwnContours(used, cLon, cLat, originX, originY, step, -step, levels, nLevels);
    free(window);
    OwnPruneContours(&raw, 1.2, 0.45, 0);
    double south = plate ? kPlateSouth : north - (nLat - 1) * step;
    double east = plate ? kPlateEast : west + (nLon - 1) * step;
    double minX = plate ? kPlateWest : west;
    double maxY = plate ? kPlateNorth : north;
    OwnMarkEnclosedCentres(cand, nCand, raw.lines, raw.count, 6.0, minX, south, east, maxY, enclosed);
    OwnLineSetFree(raw);
}

static void LerpDoubles(const double *a, const double *b, double t, double *dst, int n) {
    if (!a || !dst || n < 1) return;
    if (!b || t <= 1e-8) { memcpy(dst, a, (size_t)n * sizeof(double)); return; }
    double u = 1.0 - t;
    for (int i = 0; i < n; i++) dst[i] = a[i] * u + b[i] * t;
}

static int SettleSynoptic(const double *shortF, const double *mild, const double *wide,
    const double *terrain, const uint8_t *land, IsobarGeoGrid g, BOOL plate,
    const OwnExtremum *prev, int nPrev, OwnExtremum *out, int cap) {
    if (!shortF || !mild || !wide || !out || cap < 1) return 0;
    int n = g.nLon * g.nLat;
    double *mixed = malloc((size_t)n * sizeof(double));
    uint8_t *rough = calloc((size_t)n, 1);
    if (!mixed || !rough) { free(mixed); free(rough); return 0; }
    memcpy(mixed, shortF, (size_t)n * sizeof(double));
    MixLandPressure(mixed, mild, wide, terrain, land, n, rough);
    OwnExtremum cand[48];
    double prom[48];
    // The search is the loaded grid inset by the chart's edge margin, so a
    // global grid is not clipped to the Australian Lambert window.
    double minLon, maxLon, minLat, maxLat;
    CandidateBox(g, &minLon, &maxLon, &minLat, &maxLat);
    int nCand = SynopticCandidates(mixed, g.nLon, g.nLat, g.west, g.north, g.step, rough,
        minLon, maxLon, minLat, maxLat, g.wrapsLongitude, cand, prom, 48);
    int enclosed[48] = {0};
    // Enclosure lowers the bar to half a hectopascal. That is the chart plate's
    // rule. On any other grid a centre still has to clear a full isobar
    // interval, so a 1 hPa bump on a plateau is not marked.
    if (nCand > 0 && plate) MarkSynopticEnclosed(mixed, g, plate, cand, nCand, enclosed);
    int nSet = 0;
    if (nCand > 0)
        nSet = OwnSettleCentres(cand, prom, enclosed, nCand, kOwnIsobarInterval, 0.5, 860.0, 500.0, 1,
            prev, nPrev, out, cap);
    for (int i = 0; i < nSet; i++) {
        double sample = FieldBilinear(mixed, g, out[i].y, out[i].x);
        if (isfinite(sample)) out[i].value = sample;
    }
    free(mixed);
    free(rough);
    return nSet;
}

- (BOOL)ensureLandWeight {
    if (_landWeight && _landLon == _grid.nLon && _landLat == _grid.nLat
        && _landWest == _grid.west && _landNorth == _grid.north && _landStep == _grid.step)
        return YES;
    free(_landMask);
    free(_landWeight);
    _landMask = NULL;
    _landWeight = NULL;
    _landLon = _grid.nLon;
    _landLat = _grid.nLat;
    _landWest = _grid.west;
    _landNorth = _grid.north;
    _landStep = _grid.step;
    OwnCoast coast = CoastForGrid(_grid, _coast, _worldCoast);
    if (!LandMixGrid(_grid, coast)) return NO;
    _landMask = LandMaskFromCoast(coast, _grid.nLon, _grid.nLat, _grid.west, _grid.north,
        _grid.step, _grid.wrapsLongitude);
    int n = _grid.nLon * _grid.nLat;
    double *mask = _landMask ? malloc((size_t)n * sizeof(double)) : NULL;
    double *weight = mask ? malloc((size_t)n * sizeof(double)) : NULL;
    if (!mask || !weight) { free(mask); free(weight); return NO; }
    for (int i = 0; i < n; i++) mask[i] = _landMask[i] ? 1.0 : 0.0;
    BlurClamp(mask, weight, _grid.nLon, _grid.nLat, 2.0);
    free(mask);
    _landWeight = weight;
    return YES;
}

- (void)buildSynopticSlot:(IsobarFieldSlot *)slot {
    OwnCoast coast = CoastForGrid(_grid, _coast, _worldCoast);
    if (!slot || !LandMixGrid(_grid, coast) || !slot.values) return;
    int n = _grid.nLon * _grid.nLat;
    const float *src = slot.values.bytes;
    double *pack = malloc((size_t)n * 3 * sizeof(double));
    if (!pack) return;
    for (int i = 0; i < n; i++) pack[i] = isfinite(src[i]) ? (double)src[i] : NAN;
    double *mild = pack + n, *wide = pack + 2 * (size_t)n;
    BlurFiniteClamp(pack, mild, _grid.nLon, _grid.nLat, 2.0);
    BlurFiniteClamp(pack, wide, _grid.nLon, _grid.nLat, 8.0);
    [self ensureLandWeight];
    int cap = ChartPlate(_grid) ? 8 : kCentreCap;
    OwnExtremum settled[kCentreCap];
    int nSet = SettleSynoptic(pack, mild, wide, _landWeight, _landMask, _grid, ChartPlate(_grid), NULL, 0, settled, cap);
    slot.synopticPack = [NSData dataWithBytes:pack length:(size_t)n * 3 * sizeof(double)];
    free(pack);
    if (!slot.synopticPack) return;
    slot.synopticSettled = nSet > 0
        ? [NSData dataWithBytes:settled length:(size_t)nSet * sizeof(OwnExtremum)]
        : [NSData data];
    slot.synopticReady = YES;
}

static ContourSet *FinishLines(ContourBuild *b, ContourDomain domain, NSInteger s0, NSInteger s1,
    float mix, uint64_t gen, double zoom, double began, const OwnExtremum *centres, int nCentres) {
    ContourSet *set = calloc(1, sizeof(ContourSet));
    if (!set) { BuildFree(b); return NULL; }
    set->lines = b->lines;
    set->nLines = b->nLines;
    set->lat = b->lat;
    set->lon = b->lon;
    b->lines = NULL;
    b->lat = NULL;
    b->lon = NULL;
    BuildFree(b);
    set->key.valid = YES;
    set->key.step0 = s0;
    set->key.step1 = s1;
    set->key.mix = mix;
    set->key.stride = domain.stride;
    set->key.i0 = domain.i0;
    set->key.j0 = domain.j0;
    set->key.cols = domain.cols;
    set->key.rows = domain.rows;
    set->key.ghost = domain.ghost;
    set->key.full = domain.full;
    set->key.gen = gen;
    set->zoom = zoom;
    set->milliseconds = NowMs() - began;
    set->gen = gen;
    set->centresValid = 1;
    set->nCentres = nCentres;
    if (set->nCentres > 32) set->nCentres = 32;
    if (set->nCentres < 0) set->nCentres = 0;
    if (set->nCentres > 0 && centres)
        memcpy(set->centres, centres, (size_t)set->nCentres * sizeof(OwnExtremum));
    return set;
}

static int CentresFromLines(const double *field, IsobarGeoGrid g, ContourBuild *b,
    const OwnExtremum *prev, int nPrev, OwnExtremum *out, int cap) {
    OwnExtremum cand[48];
    double prom[48];
    int nCand = SeekExtrema(field, g.nLon, g.nLat, g.west, g.north, g.step, g.wrapsLongitude, cand, prom, 48);
    int enclosed[48] = {0};
    int nLines = b ? b->nLines : 0;
    BOOL heavy = (long)g.nLon * (long)g.nLat > 250000;
    OwnVec *pts = NULL;
    OwnLine *owns = NULL;
    if (!heavy && nCand > 0 && nLines > 0) {
        int total = 0;
        for (int i = 0; i < nLines; i++) total += b->lines[i].count;
        pts = total > 0 ? malloc((size_t)total * sizeof(OwnVec)) : NULL;
        owns = pts ? calloc((size_t)nLines, sizeof(OwnLine)) : NULL;
        if (pts && owns) {
            int cursor = 0;
            for (int i = 0; i < nLines; i++) {
                owns[i].pts = pts + cursor;
                owns[i].count = b->lines[i].count;
                owns[i].closed = b->lines[i].closed;
                owns[i].level = b->lines[i].level;
                for (int p = 0; p < b->lines[i].count; p++)
                    pts[cursor++] = (OwnVec){b->lines[i].lon[p], b->lines[i].lat[p]};
            }
            double south = GridSouth(g);
            double east = g.wrapsLongitude ? g.west + g.nLon * g.step : GridEast(g);
            OwnMarkEnclosedCentres(cand, nCand, owns, nLines, 6.0, g.west, south, east, g.north, enclosed);
            ScreenCentres(field, g.nLon, g.nLat, g.west, g.north, g.step, g.wrapsLongitude,
                cand, prom, enclosed, nCand, owns, nLines);
        }
        free(pts);
        free(owns);
    } else if (nCand > 0) {
        ScreenCentres(field, g.nLon, g.nLat, g.west, g.north, g.step, g.wrapsLongitude,
            cand, prom, enclosed, nCand, NULL, 0);
    }
    return OwnSettleCentres(cand, prom, enclosed, nCand, kOwnIsobarInterval, 0.5, 860.0, 500.0, 1,
        prev, nPrev, out, cap);
}

static void ProjectContour(ContourSet *set, IsobarCamera cam) {
    if (!set) return;
    int nLines = set->nLines;
    int total = 0;
    for (int i = 0; i < nLines; i++) total += set->lines[i].count;
    int *projOf = nLines > 0 ? malloc((size_t)nLines * sizeof(int)) : NULL;
    ProjPt *proj = total > 0 ? malloc((size_t)total * sizeof(ProjPt)) : NULL;
    if ((nLines > 0 && !projOf) || (total > 0 && !proj)) {
        free(projOf);
        free(proj);
        return;
    }
    double g = Clamp01(cam.globe);
    int cursor = 0;
    for (int i = 0; i < nLines; i++) {
        projOf[i] = cursor;
        FieldLine ln = set->lines[i];
        for (int p = 0; p < ln.count; p++) {
            ProjPt q = {0};
            Surface s;
            if (SurfaceLon(cam, ln.lat[p], ln.lon[p], &s)) {
                q.x = (float)s.x;
                q.y = (float)s.y;
                q.pz = (float)s.pz;
                q.front = cam.pitch > 1e-7 ? s.visible : (g <= 0.5 + 1e-9 || s.pz >= -0.002);
            }
            proj[cursor++] = q;
        }
    }
    set->proj = proj;
    set->projOf = projOf;
    set->nProj = total;
    set->projCam = cam;
    set->projReady = 1;
}

static double SynopticAt(const double *pack, int n, int band, int idx) {
    return pack[(size_t)band * (size_t)n + (size_t)idx];
}

static double MixPressurePoint(double field, double mild, double wide, double terrain) {
    if (!isfinite(field) || !isfinite(mild) || !isfinite(wide)) return NAN;
    if (terrain < 0) terrain = 0;
    if (terrain > 1) terrain = 1;
    double delta = fabs(field - wide);
    double rough = (delta - 0.6) / 2.4;
    if (rough < 0) rough = 0;
    if (rough > 1) rough = 1;
    rough = rough * rough * (3.0 - 2.0 * rough);
    double wideBlend = terrain * (0.4 + 0.45 * rough);
    double base = field * (1.0 - 0.75 * terrain) + mild * (0.75 * terrain);
    return base * (1.0 - wideBlend) + wide * wideBlend;
}

// A 1° plateau edge walks the grid. The classic chart avoids that by contouring
// the land-mixed field. Finer grids already match that chart's 1.25-cell pass,
// and mixing them makes a moving front change shape between frames.
static double ContourSample(const float *va, const float *vb, float mix, const double *packA,
    const double *packB, const double *landW, IsobarGeoGrid grid, int idx) {
    int n = grid.nLon * grid.nLat;
    if (grid.step >= 0.75 && packA && landW && idx >= 0 && idx < n) {
        double t = mix <= 0 || !packB ? 0 : (mix >= 1 ? 1 : mix);
        double u = 1.0 - t;
        double field = SynopticAt(packA, n, 0, idx) * u + (t > 0 ? SynopticAt(packB, n, 0, idx) * t : 0);
        double mild = SynopticAt(packA, n, 1, idx) * u + (t > 0 ? SynopticAt(packB, n, 1, idx) * t : 0);
        double wide = SynopticAt(packA, n, 2, idx) * u + (t > 0 ? SynopticAt(packB, n, 2, idx) * t : 0);
        return MixPressurePoint(field, mild, wide, landW[idx]);
    }
    float fa = va ? va[idx] : NAN;
    float fb = vb ? vb[idx] : NAN;
    if (mix <= 0 || !vb) return fa;
    if (mix >= 1) return fb;
    if (isfinite(fa) && isfinite(fb)) return (double)fa * (1.0 - mix) + (double)fb * mix;
    return NAN;
}

static ContourSet *BuildContourSet(const float *va, const float *vb, float mix,
    IsobarGeoGrid grid, ContourDomain domain, const double *packA, const double *packB,
    const uint8_t *land, const double *landW, const OwnExtremum *prev, int nPrev, BOOL reuseCentres,
    BOOL carryCentres, uint64_t gen, double zoom, double began, NSInteger s0, NSInteger s1,
    IsobarCamera builtCam) {
    int nF = domain.cols + domain.ghost;
    double *window = calloc((size_t)nF * (size_t)domain.rows, sizeof(double));
    if (!window) return NULL;
    BOOL any = NO;
    double lo = 0, hi = 0;
    for (int r = 0; r < domain.rows; r++) {
        int j = domain.j0 + r * domain.stride;
        if (j < 0) j = 0;
        if (j >= grid.nLat) j = grid.nLat - 1;
        for (int c = 0; c < domain.cols; c++) {
            int i = domain.i0 + c * domain.stride;
            if (grid.wrapsLongitude) i = ModIndex(i, grid.nLon);
            else {
                if (i < 0) i = 0;
                if (i >= grid.nLon) i = grid.nLon - 1;
            }
            int idx = j * grid.nLon + i;
            double v = ContourSample(va, vb, mix, packA, packB, landW, grid, idx);
            window[(size_t)r * (size_t)nF + (size_t)c] = isfinite(v) ? v : NAN;
            if (!isfinite(v)) continue;
            if (!any || v < lo) lo = v;
            if (!any || v > hi) hi = v;
            any = YES;
        }
        if (domain.ghost) window[(size_t)r * (size_t)nF + (size_t)domain.cols] = window[(size_t)r * (size_t)nF];
    }
    OwnLineSet raw = {0};
    if (any && hi > lo) {
        // 4 hPa at synoptic scale; a regional view gets 2 hPa so a city-sized
        // window still carries isobars rather than an empty coastline.
        double spanLat = domain.rows * domain.dx;
        double interval = !domain.full && spanLat > 0 && spanLat < 24.0 ? 2.0 : 4.0;
        double levels[64];
        int nLevels = OwnInteriorLevels(lo, hi, interval, levels, 64);
        if (nLevels > 0)
            raw = TraceAll(window, nF, domain.rows, domain.originLon, domain.originLat,
                domain.dx, -domain.dx, levels, nLevels);
    }
    free(window);
    // A contour may end on the coverage edge. It must not walk along that edge:
    // those segments are the stepped polygon around the grid.
    if (domain.dx > 0 && domain.cols >= 2 && domain.rows >= 2) {
        double edgeWest = domain.originLon;
        double edgeNorth = domain.originLat;
        double edgeEast = edgeWest + (domain.cols - 1) * domain.dx;
        double edgeSouth = edgeNorth - (domain.rows - 1) * domain.dx;
        DropCoverageEdge(&raw, edgeWest, edgeEast, edgeSouth, edgeNorth,
            domain.dx * 0.05, domain.ghost != 0);
    }
    StitchRings(&raw, fmax(0.05, domain.dx * 0.75));
    OwnLineSet rings = PullSeamRings(&raw);
    OwnPruneContours(&raw, 1.2, 0.45, 0);
    if (rings.count > 0) {
        OwnLine *joined = realloc(raw.lines, (size_t)(raw.count + rings.count) * sizeof(OwnLine));
        if (joined) {
            raw.lines = joined;
            for (int i = 0; i < rings.count; i++) raw.lines[raw.count++] = rings.lines[i];
            rings.lines = NULL;
        }
    }
    free(rings.lines);
    ContourBuild b = {0};
    if (raw.count > 0) {
        b.lines = calloc((size_t)raw.count, sizeof(FieldLine));
        if (b.lines) b.lineCap = raw.count;
    }
    for (int i = 0; i < raw.count; i++)
        BuildAppend(&b, raw.lines[i].pts, raw.lines[i].count, raw.lines[i].closed, raw.lines[i].level);
    OwnLineSetFree(raw);
    double lineMs = NowMs() - began;
    OwnExtremum centres[32];
    int nCentres = 0;
    int n = grid.nLon * grid.nLat;
    if (reuseCentres || carryCentres) {
        nCentres = nPrev > 32 ? 32 : nPrev;
        if (nCentres > 0 && prev) memcpy(centres, prev, (size_t)nCentres * sizeof(OwnExtremum));
        if (carryCentres && nCentres > 0 && n > 0 && va && vb) {
            double *full = malloc((size_t)n * sizeof(double));
            if (full) {
                for (int i = 0; i < n; i++) {
                    float fa = va[i], fb = vb[i];
                    if (mix <= 0) full[i] = isfinite(fa) ? fa : NAN;
                    else if (mix >= 1) full[i] = isfinite(fb) ? fb : NAN;
                    else if (isfinite(fa) && isfinite(fb)) full[i] = (1.0 - mix) * fa + mix * fb;
                    else full[i] = NAN;
                }
                OwnExtremum cand[32];
                double prom[32];
                int enclosed[32];
                int nCand = 0;
                for (int i = 0; i < nCentres && nCand < 32; i++) {
                    double sample = FieldBilinear(full, grid, centres[i].y, centres[i].x);
                    if (!isfinite(sample)) continue;
                    cand[nCand] = centres[i];
                    cand[nCand].value = sample;
                    prom[nCand] = OwnRingProminence(full, grid.nLon, grid.nLat, grid.west, grid.north,
                        grid.step, -grid.step, centres[i].x, centres[i].y, 4.0);
                    enclosed[nCand] = 0;
                    nCand++;
                }
                OwnExtremum settled[32];
                int nSet = OwnSettleCentres(cand, prom, enclosed, nCand, kOwnIsobarInterval, 0.5,
                    860.0, 500.0, 1, prev, nPrev, settled, 32);
                nCentres = nSet > 32 ? 32 : nSet;
                if (nCentres < 0) nCentres = 0;
                if (nCentres > 0) memcpy(centres, settled, (size_t)nCentres * sizeof(OwnExtremum));
                free(full);
            }
        }
    } else if (n > 0 && packA && land && landW) {
        const double *shortF = NULL, *mild = NULL, *wide = NULL;
        double *blend = NULL;
        if (mix <= 1e-5 || !packB) {
            shortF = packA;
            mild = packA + n;
            wide = packA + 2 * (size_t)n;
        } else if (mix >= 1.0 - 1e-5) {
            shortF = packB;
            mild = packB + n;
            wide = packB + 2 * (size_t)n;
        } else {
            blend = malloc((size_t)n * 3 * sizeof(double));
            if (blend) {
                LerpDoubles(packA, packB, mix, blend, n);
                LerpDoubles(packA + n, packB + n, mix, blend + n, n);
                LerpDoubles(packA + 2 * (size_t)n, packB + 2 * (size_t)n, mix, blend + 2 * (size_t)n, n);
                shortF = blend;
                mild = blend + n;
                wide = blend + 2 * (size_t)n;
            }
        }
        if (shortF && mild && wide) {
            int cap = ChartPlate(grid) ? 8 : kCentreCap;
            nCentres = SettleSynoptic(shortF, mild, wide, landW, land, grid, ChartPlate(grid), prev, nPrev, centres, cap);
        }
        free(blend);
        if (nCentres > 0 && !ChartPlate(grid) && va && vb) {
            double *raw = malloc((size_t)n * sizeof(double));
            if (raw) {
                for (int i = 0; i < n; i++) {
                    float fa = va[i], fb = vb[i];
                    if (mix <= 0) raw[i] = isfinite(fa) ? fa : NAN;
                    else if (mix >= 1) raw[i] = isfinite(fb) ? fb : NAN;
                    else if (isfinite(fa) && isfinite(fb)) raw[i] = (1.0 - mix) * fa + mix * fb;
                    else raw[i] = NAN;
                }
                double prom[32];
                int enclosed[32] = {0};
                for (int i = 0; i < nCentres; i++)
                    prom[i] = OwnRingProminence(raw, grid.nLon, grid.nLat, grid.west, grid.north,
                        grid.step, -grid.step, centres[i].x, centres[i].y, 4.0);
                ScreenCentres(raw, grid.nLon, grid.nLat, grid.west, grid.north, grid.step,
                    grid.wrapsLongitude, centres, prom, enclosed, nCentres, NULL, 0);
                int w = 0;
                for (int i = 0; i < nCentres; i++) {
                    if (prom[i] == 0 || fabs(prom[i]) < kOwnIsobarInterval) continue;
                    centres[w++] = centres[i];
                }
                nCentres = w;
                free(raw);
            }
        }
    } else if (n > 250000 && va && vb) {
        nCentres = CentresCoarse(va, vb, mix, grid, prev, nPrev, centres, kCentreCap);
    } else if (n > 0 && va && vb) {
        double *full = malloc((size_t)n * sizeof(double));
        if (full) {
            for (int i = 0; i < n; i++) {
                float fa = va[i], fb = vb[i];
                if (mix <= 0) full[i] = isfinite(fa) ? fa : NAN;
                else if (mix >= 1) full[i] = isfinite(fb) ? fb : NAN;
                else if (isfinite(fa) && isfinite(fb)) full[i] = (1.0 - mix) * fa + mix * fb;
                else full[i] = NAN;
            }
            nCentres = CentresFromLines(full, grid, &b, prev, nPrev, centres, kCentreCap);
            for (int i = 0; i < nCentres; i++) {
                double sample = FieldBilinear(full, grid, centres[i].y, centres[i].x);
                if (isfinite(sample)) centres[i].value = sample;
            }
            free(full);
        }
    }
    if (!any || !(hi > lo)) {
        BuildFree(&b);
        ContourBuild empty = {0};
        ContourSet *set = FinishLines(&empty, domain, s0, s1, mix, gen, zoom, began, centres, nCentres);
        if (set) {
            set->milliseconds = n > 250000 ? lineMs : (NowMs() - began);
            double projectBegan = NowMs();
            ProjectContour(set, builtCam);
            set->projectMilliseconds = NowMs() - projectBegan;
        }
        return set;
    }
    ContourSet *set = FinishLines(&b, domain, s0, s1, mix, gen, zoom, began, centres, nCentres);
    // A wrapping world grid has no land mask, so centre settling is a coarse
    // sample and is not part of this contour time. Smaller grids include it:
    // that search is the chart's, and the frame budget counts it.
    if (set) {
        set->milliseconds = n > 250000 ? lineMs : (NowMs() - began);
        double projectBegan = NowMs();
        ProjectContour(set, builtCam);
        set->projectMilliseconds = NowMs() - projectBegan;
    }
    return set;
}

- (void)emitString:(const char *)text class:(int)klass cx:(float)cx cy:(float)cy alpha:(float)alpha
    angle:(float)ang verts:(TextVertex **)verts n:(int *)n cap:(int *)cap {
    if (!text || !text[0] || alpha < 0.02f) return;
    float width = 0;
    for (const char *p = text; *p; p++) {
        int idx = GlyphIndex(klass, *p);
        if (idx >= 0) width += _sprites[idx].advance;
    }
    if (!(width > 0)) return;
    float ascent = _ascent[klass], descent = _descent[klass];
    float baseline = cy + (ascent - descent) * 0.5f;
    float pen = cx - width * 0.5f;
    for (const char *p = text; *p; p++) {
        int idx = GlyphIndex(klass, *p);
        if (idx < 0) continue;
        GlyphSprite g = _sprites[idx];
        if (g.w > 0 && g.h > 0) {
            float x0 = pen + g.originX, y0 = baseline + g.originY;
            float co = cosf(ang), si = sinf(ang);
            float xs[4] = {x0, x0 + g.w, x0, x0 + g.w};
            float ys[4] = {y0, y0, y0 + g.h, y0 + g.h};
            float us[4] = {g.u0, g.u1, g.u0, g.u1};
            float vs[4] = {g.v0, g.v0, g.v1, g.v1};
            int tri[6] = {0, 1, 2, 1, 3, 2};
            float pr = alpha, pg = alpha, pb = alpha;
            for (int k = 0; k < 6; k++) {
                int q = tri[k];
                float dx = xs[q] - cx, dy = ys[q] - cy;
                float rx = cx + dx * co - dy * si;
                float ry = cy + dx * si + dy * co;
                PushTextVert(verts, n, cap, rx, ry, us[q], vs[q], pr, pg, pb, alpha);
            }
        }
        pen += g.advance;
    }
}

- (void)ensureProj:(IsobarCamera)cam {
    ContourSet *set = _current;
    if (_projValid && _projSet == set && CamSame(_projCam, cam)) return;
    if (set && set->projReady && CamSame(set->projCam, cam)
        && (set->nLines == 0 || set->projOf) && (set->nProj == 0 || set->proj)) {
        [self discardOwnedProj];
        _proj = set->proj;
        _projOf = set->projOf;
        _projExternal = YES;
        _projCap = set->nProj;
        _projLineCap = set->nLines;
        _projSet = set;
        _projCam = cam;
        _projValid = YES;
        return;
    }
    _mainProjections++;
    if (_projExternal) [self detachProj];
    _projValid = NO;
    int nLines = set ? set->nLines : 0;
    int total = 0;
    for (int i = 0; i < nLines; i++) total += set->lines[i].count;
    if (nLines > _projLineCap) {
        free(_projOf);
        _projOf = nLines > 0 ? malloc((size_t)nLines * sizeof(int)) : NULL;
        _projLineCap = _projOf ? nLines : 0;
    }
    if (total > _projCap) {
        free(_proj);
        _proj = total > 0 ? malloc((size_t)total * sizeof(ProjPt)) : NULL;
        _projCap = _proj ? total : 0;
    }
    if ((nLines > 0 && !_projOf) || (total > 0 && !_proj)) return;
    int cursor = 0;
    double g = Clamp01(cam.globe);
    for (int i = 0; i < nLines; i++) {
        _projOf[i] = cursor;
        FieldLine ln = set->lines[i];
        for (int p = 0; p < ln.count; p++) {
            ProjPt q = {0};
            Surface s;
            if (SurfaceLon(cam, ln.lat[p], ln.lon[p], &s)) {
                q.x = (float)s.x;
                q.y = (float)s.y;
                q.pz = (float)s.pz;
                q.front = cam.pitch > 1e-7 ? s.visible : (g <= 0.5 + 1e-9 || s.pz >= -0.002);
            }
            _proj[cursor++] = q;
        }
    }
    _projSet = set;
    _projCam = cam;
    _projValid = YES;
}

- (BOOL)anchorGeo:(int)geo x:(double)x y:(double)y camera:(IsobarCamera)cam lat:(double *)lat lon:(double *)lon {
    if (!_projValid || !_current || geo < 0 || geo >= _current->nLines || !_projOf) return NO;
    FieldLine ln = _current->lines[geo];
    int base = _projOf[geo];
    double best = 1e300;
    int pick = -1;
    for (int p = 0; p < ln.count; p++) {
        ProjPt q = _proj[base + p];
        if (!q.front) continue;
        double d = hypot(q.x - x, q.y - y);
        if (d < best) { best = d; pick = p; }
    }
    if (pick < 0 || best > 80) return NO;
    if (lat) *lat = ln.lat[pick];
    if (lon) *lon = ln.lon[pick];
    return YES;
}

- (void)buildAnnotationsCamera:(IsobarCamera)cam s0:(NSInteger)s0 s1:(NSInteger)s1 mix:(float)mix time:(double)time {
    double began = NowMs();
    _lastLabelMilliseconds = 0;
    double scale = [self pixelScale];
    if (!self.motion && _ann.valid && _ann.gen == _contentGen && _ann.step0 == s0 && _ann.step1 == s1
        && _ann.mix == mix && _ann.scale == scale && CamSame(_ann.camera, cam)
        && _projValid && _projSet == _current)
        return;
    [self ensureProj:cam];
    ContourSet *set = _current;
    int nLines = set ? set->nLines : 0;
    const OwnExtremum *cached = set && set->centresValid ? set->centres : NULL;
    int nCached = cached ? set->nCentres : 0;
    _nMarks = 0;
    OwnVec centres[kCentreCap];
    int nCentres = 0;
    double margin = 32.0 * scale;
    for (int i = 0; i < nCached && _nMarks < kCentreCap; i++) {
        double x = 0, y = 0;
        if (!ProjectMark(cam, cached[i].y, cached[i].x, &x, &y)) continue;
        if (x < margin || y < margin || x > cam.viewportW - margin || y > cam.viewportH - margin) continue;
        if (![self onCoverageX:x y:y camera:cam]) continue;
        if (![self onCoverageX:x y:y - 28.0 * scale camera:cam]) continue;
        if (![self onCoverageX:x y:y + 24.0 * scale camera:cam]) continue;
        _marks[_nMarks++] = (DrawnCentre){x, y, cached[i].value, cached[i].high};
        centres[nCentres++] = (OwnVec){x, y};
    }
    SLine *slines = NULL;
    int nS = 0, capS = 0;
    double jump = fmax(cam.viewportW, cam.viewportH) * 0.85;
    for (int i = 0; i < nLines; i++) {
        SLine cur = {0};
        FieldLine ln = set->lines[i];
        cur.level = ln.level;
        cur.geo = i;
        cur.ident = ln.ident;
        BOOL broke = NO;
        int base = _projOf ? _projOf[i] : 0;
        for (int p = 0; p < ln.count; p++) {
            ProjPt q = _projValid ? _proj[base + p] : (ProjPt){0};
            if (!q.front) {
                SFlush(&slines, &nS, &capS, &cur);
                cur.level = ln.level;
                cur.geo = i;
                cur.ident = ln.ident;
                broke = YES;
                continue;
            }
            if (cur.count > 0 && hypot(q.x - cur.pts[cur.count - 1].x, q.y - cur.pts[cur.count - 1].y) > jump) {
                SFlush(&slines, &nS, &capS, &cur);
                cur.level = ln.level;
                cur.geo = i;
                cur.ident = ln.ident;
                broke = YES;
            }
            SAdd(&cur, q.x, q.y);
        }
        if (!broke && ln.closed && cur.count >= 3) cur.closed = 1;
        SFlush(&slines, &nS, &capS, &cur);
    }
    double halfH = (_ascent[0] + _descent[0]) * 0.5;
    if (halfH < 2) halfH = 8;
    // Level multiset, not the per-frame line hash. A moving isobar keeps its
    // labels; a new pressure line places them again.
    uint64_t sig = 1469598103934665603ull ^ (uint64_t)nS;
    for (int i = 0; i < nS; i++)
        sig ^= (uint64_t)llround(slines[i].level * 4.0) * 0x9E3779B97F4A7C15ull;
    IsobarFieldMotion *motionNow = self.motion;
    BOOL motionReset = motionNow && motionNow->gen != _contentGen;
    // The next model step is a new chart: label it on this frame. The first
    // blend after a keyframe keeps the same step and must not rebuild sites.
    BOOL stepChanged = !_labelReady || _labelStep0 != s0;
    BOOL sigChanged = !_labelReady || sig != _labelSig || _labelGen != _contentGen;
    if (sigChanged) _labelHold++;
    else _labelHold = 0;
    // Rebuilding label sites is several milliseconds. Existing labels keep
    // sliding. A fresh motion object, or the next model step, places them now.
    BOOL relabel = !motionNow || motionReset || stepChanged || _labelHold >= 30;
    if (relabel) _labelHold = 0;
    OwnLabel desired[kLabelCap];
    int nDes = 0;
    OwnLine *owns = NULL;
    int *srcLine = NULL;
    if (nS > 0) {
        owns = calloc((size_t)nS, sizeof(OwnLine));
        srcLine = calloc((size_t)nS, sizeof(int));
        if (owns && srcLine) {
            // Lines nearest the middle of the view are labelled first, so a
            // neighbour steps aside along its own line instead of stacking
            // on the same screen row.
            double midX = cam.viewportW * 0.5, midY = cam.viewportH * 0.5;
            double *rank = malloc((size_t)nS * sizeof(double));
            for (int i = 0; i < nS; i++) srcLine[i] = i;
            if (rank) {
                for (int i = 0; i < nS; i++) {
                    double sx = 0, sy = 0;
                    int n = slines[i].count > 0 ? slines[i].count : 1;
                    for (int p = 0; p < slines[i].count; p++) {
                        sx += slines[i].pts[p].x;
                        sy += slines[i].pts[p].y;
                    }
                    rank[i] = hypot(sx / n - midX, sy / n - midY);
                }
                for (int a = 1; a < nS; a++) {
                    int key = srcLine[a];
                    double kd = rank[key];
                    int b = a;
                    while (b > 0 && (rank[srcLine[b - 1]] > kd
                        || (rank[srcLine[b - 1]] == kd && srcLine[b - 1] > key))) {
                        srcLine[b] = srcLine[b - 1];
                        b--;
                    }
                    srcLine[b] = key;
                }
                free(rank);
            }
            for (int i = 0; i < nS; i++) {
                int src = srcLine[i];
                owns[i].pts = slines[src].pts;
                owns[i].count = slines[src].count;
                owns[i].closed = slines[src].closed;
                owns[i].level = slines[src].level;
            }
            if (relabel) {
                nDes = OwnPlaceLabels(owns, nS, FieldHalfWidth, _sprites, halfH, 6,
                    0, 0, cam.viewportW, cam.viewportH, desired, kLabelCap);
                nDes = OwnCoverLabels(owns, nS, FieldHalfWidth, _sprites, halfH, 6,
                    0, 0, cam.viewportW, cam.viewportH, 70, 180, desired, nDes, kLabelCap);
                nDes = OwnClearCentreLabels(desired, nDes, owns, nS, centres, nCentres,
                    0, 0, cam.viewportW, cam.viewportH);
            }
        }
    }
    IsobarFieldMotion *motion = self.motion;
    _nLabels = 0;
    if (!motion) {
        for (int i = 0; i < nDes && _nLabels < kLabelCap; i++) {
            if (desired[i].line < 0 || desired[i].line >= nS) continue;
            int src = srcLine[desired[i].line];
            double ang = 0;
            if (slines[src].count >= 2) {
                int best = 0;
                double bd = 1e300;
                for (int p = 0; p < slines[src].count; p++) {
                    double d = hypot(slines[src].pts[p].x - desired[i].x, slines[src].pts[p].y - desired[i].y);
                    if (d < bd) { bd = d; best = p; }
                }
                int a = best > 0 ? best - 1 : 0;
                int b = best + 1 < slines[src].count ? best + 1 : best;
                ang = OwnReadableAngle(atan2(slines[src].pts[b].y - slines[src].pts[a].y,
                    slines[src].pts[b].x - slines[src].pts[a].x));
            }
            DrawnLabel lab = {
                desired[i].x, desired[i].y, ang, desired[i].level,
                desired[i].halfW, halfH, slines[src].geo, 1, slines[src].ident
            };
            if (![self labelFits:lab camera:cam]
                && ![self refitLabel:&lab on:&slines[src] centres:centres nCentres:nCentres camera:cam])
                continue;
            if (!LabelSitesClear(lab.x, lab.y, lab.halfW, lab.level, lab.ident, _labels, _nLabels)) continue;
            _labels[_nLabels++] = lab;
        }
    } else {
        if (motion->gen != _contentGen) {
            memset(motion->slots, 0, sizeof motion->slots);
            motion->gen = _contentGen;
            motion->frame = 0;
            motion->stepMax = 0;
            motion->alphaMax = 0;
            motion->changes = 0;
            motion->stamp = 0;
        }
        BOOL first = motion->frame == 0;
        // The forecast sample is the frame. A steady 60 Hz frame advances
        // 1/15 of the 250 ms ramp. The wall gap since the previous sample is
        // not the clock: under load that gap was a few milliseconds and a
        // label sitting near half opacity left the set. Tests inject
        // milliseconds; 87 ms is one step under the 0.35 alpha bound
        // (87/250 = 0.348).
        double dt = 0;
        if (!isfinite(time)) {
            dt = 0;
        } else if (gTestingNow >= 0) {
            double now = gTestingNow;
            dt = !first && motion->stamp > 0 ? now - motion->stamp : 0;
            if (!(dt >= 0)) dt = 0;
            if (dt > 87) dt = 87;
            motion->stamp = now;
        } else if (!first) {
            dt = 1000.0 / 60.0;
            motion->stamp += dt;
        }
        double fade = dt / 250.0;
        if (fade > 1) fade = 1;
        typedef struct { double level, x, y; } Mark;
        Mark before[kLabelCap];
        int nBefore = 0;
        if (!first) {
            for (int s = 0; s < kLabelCap; s++) {
                MotionSlot *slot = &motion->slots[s];
                if (!slot->active || slot->alpha < 0.5 || nBefore >= kLabelCap) continue;
                before[nBefore++] = (Mark){slot->level, slot->x, slot->y};
            }
        }
        int *onLine = nS > 0 ? calloc((size_t)nS, sizeof(int)) : NULL;
        for (int s = 0; s < kLabelCap; s++) {
            MotionSlot *slot = &motion->slots[s];
            if (!slot->active) continue;
            double qx = slot->x, qy = slot->y;
            if (isfinite(slot->lat) && isfinite(slot->lon)) {
                double px = 0, py = 0;
                if (ProjectMark(cam, slot->lat, slot->lon, &px, &py)) {
                    qx = px;
                    qy = py;
                }
            }
            int best = -1;
            double bx = qx, by = qy, bd = 12;
            int hint = -1;
            int identHint = -1;
            double nearD = 1e300;
            for (int i = 0; i < nS; i++) {
                if (fabs(slines[i].level - slot->level) > 0.1) continue;
                double dx = 0, dy = 0;
                if (qx < slines[i].minX) dx = slines[i].minX - qx;
                else if (qx > slines[i].maxX) dx = qx - slines[i].maxX;
                if (qy < slines[i].minY) dy = slines[i].minY - qy;
                else if (qy > slines[i].maxY) dy = qy - slines[i].maxY;
                double d = hypot(dx, dy);
                if (slot->ident && slines[i].ident == slot->ident && d < 80) identHint = i;
                if (d < nearD) { nearD = d; hint = i; }
            }
            if (identHint >= 0) hint = identHint;
            if (nearD > 80) hint = identHint;
            if (hint >= 0 && owns && srcLine) {
                for (int i = 0; i < nS; i++) {
                    if (srcLine[i] != hint) continue;
                    double ox, oy, arc, tang, dist = 1e9;
                    if (OwnContourAnchor(qx, qy, &owns[i], 48, 0, 0, 0, cam.viewportW, cam.viewportH,
                            &ox, &oy, &arc, &tang, &dist)) {
                        best = i;
                        bx = ox;
                        by = oy;
                    }
                    break;
                }
            }
            for (int i = 0; best < 0 && owns && srcLine && i < nS; i++) {
                BOOL same = slot->ident && slines[srcLine[i]].ident == slot->ident;
                if (!same && fabs(owns[i].level - slot->level) > 0.1) continue;
                double ox, oy, arc, tang, dist = 1e9;
                if (!OwnContourAnchor(qx, qy, &owns[i], same ? 48 : 12, 0, 0, 0, cam.viewportW, cam.viewportH,
                        &ox, &oy, &arc, &tang, &dist)) continue;
                double score = dist - (same ? 1000 : 0);
                if (score < bd) { bd = score; best = i; bx = ox; by = oy; }
            }
            double half = FieldHalfWidth(slot->level, _sprites);
            int geo = best >= 0 ? slines[srcLine[best]].geo : slot->geo;
            uint32_t ident = best >= 0 ? slines[srcLine[best]].ident : slot->ident;
            DrawnLabel fitted = {bx, by, 0, slot->level, half, halfH, geo, 0, ident};
            BOOL keep = best >= 0 && [self labelFits:fitted camera:cam];
            if (keep && nCentres > 0) {
                double gap = 6.0 * half;
                for (int c = 0; c < nCentres; c++)
                    if (hypot(bx - centres[c].x, by - centres[c].y) < gap) keep = NO;
            }
            // The anchor can sit a pixel over the grid edge once the fringe
            // is included. Slide along the same isobar to a point that fits
            // instead of fading the label out on a wall-clock timer.
            if (!keep && best >= 0 && owns && srcLine) {
                DrawnLabel nudged = fitted;
                if ([self refitLabel:&nudged on:&slines[srcLine[best]] centres:centres nCentres:nCentres camera:cam]) {
                    bx = nudged.x;
                    by = nudged.y;
                    keep = YES;
                }
            }
            if (!keep) {
                if (first) {
                    slot->active = 0;
                } else {
                    if (isfinite(slot->lat) && isfinite(slot->lon)) {
                        double px = 0, py = 0;
                        if (ProjectMark(cam, slot->lat, slot->lon, &px, &py)) {
                            slot->x = px;
                            slot->y = py;
                        }
                    }
                    double prevA = slot->alpha;
                    slot->alpha -= fade;
                    if (fabs(slot->alpha - prevA) > motion->alphaMax) motion->alphaMax = fabs(slot->alpha - prevA);
                    if (slot->alpha <= 0.02) slot->active = 0;
                    else if (onLine && best >= 0) onLine[best]++;
                }
                continue;
            }
            if (!first) {
                double step = hypot(bx - slot->x, by - slot->y);
                // One sample at 256× can move an isobar tens of pixels. Walk
                // toward that point. Snapping there relocates the digits while
                // the line itself is still moving smoothly. 8× samples stay
                // under 2 px, inside the labels-slide check.
                double cap = 3.0 * [self pixelScale];
                if (step > cap && step > 0) {
                    double t = cap / step;
                    bx = slot->x + (bx - slot->x) * t;
                    by = slot->y + (by - slot->y) * t;
                    step = cap;
                }
                if (step > motion->stepMax) motion->stepMax = step;
            }
            slot->x = bx;
            slot->y = by;
            double nlat = 0, nlon = 0;
            if ([self anchorGeo:geo x:bx y:by camera:cam lat:&nlat lon:&nlon]) {
                slot->lat = nlat;
                slot->lon = nlon;
            }
            slot->geo = geo;
            slot->ident = ident;
            if (!first && slot->alpha < 1) {
                double prevA = slot->alpha;
                slot->alpha += fade;
                if (slot->alpha > 1) slot->alpha = 1;
                if (slot->alpha - prevA > motion->alphaMax) motion->alphaMax = slot->alpha - prevA;
            } else {
                slot->alpha = 1;
            }
            if (onLine) onLine[best]++;
        }
        for (int i = 0; i < nDes && owns && srcLine; i++) {
            int line = desired[i].line;
            if (line < 0 || line >= nS) continue;
            if (onLine && onLine[line] >= 1) continue;
            double half = desired[i].halfW > 0 ? desired[i].halfW : FieldHalfWidth(desired[i].level, _sprites);
            BOOL near = NO;
            for (int s = 0; s < kLabelCap && !near; s++) {
                MotionSlot *slot = &motion->slots[s];
                if (!slot->active || slot->alpha < 0.5) continue;
                double width = 2.0 * fmax(half, FieldHalfWidth(slot->level, _sprites));
                double need = fmax(3.0 * width, width + 24.0);
                if (slot->ident && line >= 0 && line < nS && slines[srcLine[line]].ident == slot->ident)
                    need = fmax(need, 140.0);
                if (hypot(slot->x - desired[i].x, slot->y - desired[i].y) < need) near = YES;
            }
            if (near) continue;
            DrawnLabel lab = {desired[i].x, desired[i].y, 0, desired[i].level, half, halfH,
                slines[srcLine[line]].geo, 0, slines[srcLine[line]].ident};
            if (![self labelFits:lab camera:cam]
                && ![self refitLabel:&lab on:&slines[srcLine[line]] centres:centres nCentres:nCentres camera:cam])
                continue;
            desired[i].x = lab.x;
            desired[i].y = lab.y;
            int freeSlot = -1;
            for (int s = 0; s < kLabelCap; s++) if (!motion->slots[s].active) { freeSlot = s; break; }
            if (freeSlot < 0) break;
            double blat = 0, blon = 0;
            int bornGeo = slines[srcLine[line]].geo;
            if (![self anchorGeo:bornGeo x:desired[i].x y:desired[i].y camera:cam lat:&blat lon:&blon]) continue;
            MotionSlot born = {0};
            born.active = 1;
            born.level = desired[i].level;
            born.x = desired[i].x;
            born.y = desired[i].y;
            born.alpha = first ? 1 : fade;
            born.lat = blat;
            born.lon = blon;
            born.geo = bornGeo;
            born.ident = slines[srcLine[line]].ident;
            motion->slots[freeSlot] = born;
            if (onLine) onLine[line]++;
        }
        motion->frame++;
        if (!first) {
            Mark after[kLabelCap];
            int nAfter = 0;
            for (int s = 0; s < kLabelCap; s++) {
                MotionSlot *slot = &motion->slots[s];
                if (!slot->active || slot->alpha < 0.5 || nAfter >= kLabelCap) continue;
                after[nAfter++] = (Mark){slot->level, slot->x, slot->y};
            }
            char usedB[kLabelCap] = {0}, usedA[kLabelCap] = {0};
            for (int a = 0; a < nAfter; a++) {
                int best = -1;
                double bd = 24;
                for (int b = 0; b < nBefore; b++) {
                    if (usedB[b] || fabs(before[b].level - after[a].level) > 0.1) continue;
                    double d = hypot(before[b].x - after[a].x, before[b].y - after[a].y);
                    if (d < bd) { bd = d; best = b; }
                }
                if (best >= 0) { usedB[best] = 1; usedA[a] = 1; }
            }
            int missed = 0;
            for (int a = 0; a < nAfter; a++) if (!usedA[a]) missed++;
            for (int b = 0; b < nBefore; b++) if (!usedB[b]) missed++;
            if (missed) motion->changes++;
        }
        for (int s = 0; s < kLabelCap && _nLabels < kLabelCap; s++) {
            MotionSlot *slot = &motion->slots[s];
            if (!slot->active || slot->alpha < 0.5) continue;
            double half = FieldHalfWidth(slot->level, _sprites);
            if (!LabelSitesClear(slot->x, slot->y, half, slot->level, slot->ident, _labels, _nLabels)) continue;
            _labels[_nLabels++] = (DrawnLabel){
                slot->x, slot->y, OwnReadableAngle(0), slot->level, half, halfH, slot->geo,
                (float)slot->alpha, slot->ident
            };
        }
        free(onLine);
    }
    free(owns);
    free(srcLine);
    for (int i = 0; i < nS; i++) free(slines[i].pts);
    free(slines);
    _labelSig = sig;
    _labelStep0 = s0;
    _labelCam = cam;
    _labelGen = _contentGen;
    _labelReady = YES;
    if (!motion) {
        _ann.valid = YES;
        _ann.camera = cam;
        _ann.scale = scale;
        _ann.gen = _contentGen;
        _ann.step0 = s0;
        _ann.step1 = s1;
        _ann.mix = mix;
    }
    _lastLabelMilliseconds = NowMs() - began;
}

static void LocalOf(double x, double y, double cx, double cy, double ang, double *lx, double *ly) {
    double dx = x - cx, dy = y - cy;
    double co = cos(ang), si = sin(ang);
    *lx = dx * co + dy * si;
    *ly = -dx * si + dy * co;
}

- (void)pushGappedLine:(int)geo width:(float)width ink:(IsobarRGB)ink camera:(IsobarCamera)cam
    scale:(double)scale verts:(FieldLineVertex **)verts count:(int *)count cap:(int *)cap {
    if (!_current || geo < 0 || geo >= _current->nLines) return;
    FieldLine line = _current->lines[geo];
    if (line.count < 2) return;
    [self ensureProj:cam];
    if (!_projValid || !_projOf) return;
    int base = _projOf[geo];
    // Padding past the advance box: halo, the shader's end cap, and the
    // quad's outer half-width. The cap is drawn on the next segment, so the
    // box has to reach that vertex or the stroke pokes back over the digits.
    double halfOuter = fmax(0.35 * scale, width * 0.5) + 0.8 * scale;
    double fringe = 2.5 * scale + 0.75 * scale + halfOuter + scale;
    int segs = line.closed ? line.count : line.count - 1;
    for (int s = 0; s < segs; s++) {
        double lat0 = line.lat[s], lon0 = line.lon[s];
        int nxt = (s + 1) % line.count;
        ProjPt q0 = _proj[base + s], q1 = _proj[base + nxt];
        if (!q0.front || !q1.front) continue;
        double x0 = q0.x, y0 = q0.y, x1 = q1.x, y1 = q1.y;
        double lat1 = line.lat[nxt], lon1 = line.lon[nxt];
        double segLen = hypot(x1 - x0, y1 - y0);
        if (segLen > fmax(cam.viewportW, cam.viewportH) * 1.1) continue;
        double extra = segLen > 1e-3 ? fringe / segLen : 0;
        double gaps[32];
        int nGap = 0;
        double dLon = Wrap180(lon1 - lon0);
        for (int L = 0; L < _nLabels && nGap + 2 <= 32; L++) {
            if (_labels[L].ident != line.ident) continue;
            double hw = _labels[L].halfW + fringe, hh = _labels[L].halfH + fringe;
            // The label box sits inside this circle. A short segment whose
            // ends are both outside it cannot cross the digits.
            double rad = hypot(hw, hh) + segLen;
            double dx = x0 - _labels[L].x, dy = y0 - _labels[L].y;
            double ex = x1 - _labels[L].x, ey = y1 - _labels[L].y;
            if (dx * dx + dy * dy > rad * rad && ex * ex + ey * ey > rad * rad) continue;
            double ax, ay, bx, by;
            LocalOf(x0, y0, _labels[L].x, _labels[L].y, _labels[L].angle, &ax, &ay);
            LocalOf(x1, y1, _labels[L].x, _labels[L].y, _labels[L].angle, &bx, &by);
            double t0 = 1, t1 = 0;
            BOOL hit = NO;
            double chord0, chord1;
            if (SegBox(ax, ay, bx, by, 0, 0, hw, hh, &chord0, &chord1)) {
                hit = YES;
                t0 = chord0;
                t1 = chord1;
            }
            // A flat map projects a segment as a straight screen chord, so the
            // box test is the gap. The dense sample is only for globe curvature.
            if (cam.globe > 1e-6) {
                double reach = hypot(hw, hh);
                if (!hit && hypot(ax, ay) > reach && hypot(bx, by) > reach) continue;
                int steps = (int)ceil(segLen / 3.0);
                if (steps < 4) steps = 4;
                if (steps > 32) steps = 32;
                for (int k = 0; k <= steps; k++) {
                    double t = (double)k / (double)steps;
                    double la = lat0 + (lat1 - lat0) * t;
                    double lo = lon0 + dLon * t;
                    double px = 0, py = 0;
                    if (!ProjectMark(cam, la, lo, &px, &py)) continue;
                    double lx, ly;
                    LocalOf(px, py, _labels[L].x, _labels[L].y, _labels[L].angle, &lx, &ly);
                    if (fabs(lx) > hw || fabs(ly) > hh) continue;
                    hit = YES;
                    if (t < t0) t0 = t;
                    if (t > t1) t1 = t;
                }
            }
            if (!hit) continue;
            t0 -= extra;
            t1 += extra;
            if (t0 < 0) t0 = 0;
            if (t1 > 1) t1 = 1;
            if (t1 - t0 < 1e-5) continue;
            gaps[nGap++] = t0;
            gaps[nGap++] = t1;
        }
        for (int i = 2; i < nGap; i += 2) {
            double a = gaps[i], b = gaps[i + 1];
            int j = i;
            while (j > 0 && gaps[j - 2] > a) {
                gaps[j] = gaps[j - 2];
                gaps[j + 1] = gaps[j - 1];
                j -= 2;
            }
            gaps[j] = a;
            gaps[j + 1] = b;
        }
        double merged[32];
        int nMerged = 0;
        for (int i = 0; i < nGap; i += 2) {
            double a = gaps[i], b = gaps[i + 1];
            if (nMerged && a <= merged[nMerged - 1] + 1e-6) {
                if (b > merged[nMerged - 1]) merged[nMerged - 1] = b;
            } else if (nMerged + 2 <= 32) {
                merged[nMerged++] = a;
                merged[nMerged++] = b;
            }
        }
        double cursor = 0;
        BOOL any = NO;
        for (int i = 0; i < nMerged; i += 2) {
            if (merged[i] > cursor + 1e-5) {
                double d0 = Wrap180(lon1 - lon0);
                double la0 = lat0 + (lat1 - lat0) * cursor;
                double lo0 = lon0 + d0 * cursor;
                double la1 = lat0 + (lat1 - lat0) * merged[i];
                double lo1 = lon0 + d0 * merged[i];
                double lats[2] = {la0, la1}, lons[2] = {lo0, lo1};
                PushPolyline(verts, count, cap, lats, lons, 2, 0, cam.centreLon, width, ink, _chartDark ? .85 : 1, (float)scale, &_geometryTruncated);
                any = YES;
            }
            if (merged[i + 1] > cursor) cursor = merged[i + 1];
        }
        if (!any && nMerged == 0) {
            double lats[2] = {lat0, lat1}, lons[2] = {lon0, lon1};
            PushPolyline(verts, count, cap, lats, lons, 2, 0, cam.centreLon, width, ink, _chartDark ? .85 : 1, (float)scale, &_geometryTruncated);
        } else if (cursor < 1 - 1e-5) {
            double d0 = Wrap180(lon1 - lon0);
            double la0 = lat0 + (lat1 - lat0) * cursor;
            double lo0 = lon0 + d0 * cursor;
            double lats[2] = {la0, lat1}, lons[2] = {lo0, lon1};
            PushPolyline(verts, count, cap, lats, lons, 2, 0, cam.centreLon, width, ink, _chartDark ? .85 : 1, (float)scale, &_geometryTruncated);
        }
    }
}

- (void)pushCoverageCamera:(IsobarCamera)cam scale:(double)scale verts:(FieldLineVertex **)verts
    count:(int *)count cap:(int *)cap {
    double south = GridSouth(_grid);
    double east = _grid.wrapsLongitude ? _grid.west + _grid.nLon * _grid.step : GridEast(_grid);
    BOOL drawN = _grid.north < 89.99;
    BOOL drawS = south > -89.99;
    BOOL drawSides = !_grid.wrapsLongitude;
    if (!drawN && !drawS && !drawSides) return;
    double vw, vh, px, radius, globe;
    if (!Metrics(cam, &vw, &vh, &px, &radius, &globe)) return;
    double step = 2.0 / fmax(px, 0.25);
    if (step < _grid.step) step = _grid.step;
    if (step > 2) step = 2;
    IsobarRGB edge = FromOwn(OwnChartPaletteFor(_chartDark).edge);
    float width = (float)(0.9 * scale);
    double spanLon = east - _grid.west;
    double spanLat = _grid.north - south;
    int nLon = (int)ceil(spanLon / step) + 1;
    int nLat = (int)ceil(spanLat / step) + 1;
    if (nLon < 2) nLon = 2;
    if (nLat < 2) nLat = 2;
    if (nLon > 1500) nLon = 1500;
    if (nLat > 1500) nLat = 1500;
    double *lats = malloc((size_t)(nLon > nLat ? nLon : nLat) * sizeof(double));
    double *lons = malloc((size_t)(nLon > nLat ? nLon : nLat) * sizeof(double));
    if (!lats || !lons) {
        free(lats);
        free(lons);
        return;
    }
    if (drawN || drawS) {
        for (int i = 0; i < nLon; i++) {
            double t = (double)i / (double)(nLon - 1);
            lons[i] = _grid.west + spanLon * t;
        }
        if (drawN) {
            for (int i = 0; i < nLon; i++) lats[i] = _grid.north;
            PushPolyline(verts, count, cap, lats, lons, nLon, 0, cam.centreLon, width, edge, 1, (float)scale, &_geometryTruncated);
        }
        if (drawS) {
            for (int i = 0; i < nLon; i++) lats[i] = south;
            PushPolyline(verts, count, cap, lats, lons, nLon, 0, cam.centreLon, width, edge, 1, (float)scale, &_geometryTruncated);
        }
    }
    if (drawSides) {
        for (int i = 0; i < nLat; i++) {
            double t = (double)i / (double)(nLat - 1);
            lats[i] = _grid.north - spanLat * t;
        }
        for (int i = 0; i < nLat; i++) lons[i] = _grid.west;
        PushPolyline(verts, count, cap, lats, lons, nLat, 0, cam.centreLon, width, edge, 1, (float)scale, &_geometryTruncated);
        for (int i = 0; i < nLat; i++) lons[i] = east;
        PushPolyline(verts, count, cap, lats, lons, nLat, 0, cam.centreLon, width, edge, 1, (float)scale, &_geometryTruncated);
    }
    free(lats);
    free(lons);
}

- (TextVertex *)textVerts:(int *)outCount {
    TextVertex *verts = NULL;
    int n = 0, cap = 0;
    double scale = [self pixelScale];
    IsobarRGB ink = FromOwn(OwnChartPaletteFor(_chartDark).centre);
    for (int i = 0; i < _nMarks; i++) {
        float x = (float)_marks[i].x, y = (float)_marks[i].y;
        float arm = 4.2f * (float)scale;
        float stroke = 1.15f * (float)scale;
        PushSolidStroke(&verts, &n, &cap, x - arm, y - arm, x + arm, y + arm, stroke, _solidU, _solidV,
            (float)ink.r, (float)ink.g, (float)ink.b, 1);
        PushSolidStroke(&verts, &n, &cap, x - arm, y + arm, x + arm, y - arm, stroke, _solidU, _solidV,
            (float)ink.r, (float)ink.g, (float)ink.b, 1);
        char letter[2] = {_marks[i].high ? 'H' : 'L', 0};
        char value[16];
        snprintf(value, sizeof value, "%d", (int)llround(_marks[i].value));
        [self emitString:letter class:1 cx:x cy:y - 14.f * (float)scale alpha:1 angle:0 verts:&verts n:&n cap:&cap];
        [self emitString:value class:2 cx:x cy:y + 16.f * (float)scale alpha:1 angle:0 verts:&verts n:&n cap:&cap];
    }
    for (int i = 0; i < _nLabels; i++) {
        char text[16];
        snprintf(text, sizeof text, "%d", (int)llround(_labels[i].level));
        float la = _labels[i].alpha > 0 ? _labels[i].alpha : 1;
        [self emitString:text class:0 cx:(float)_labels[i].x cy:(float)_labels[i].y alpha:la
            angle:(float)_labels[i].angle verts:&verts n:&n cap:&cap];
    }
    *outCount = n;
    return verts;
}

- (FieldUniform)uniformForCamera:(IsobarCamera)camera fill:(IsobarFieldKind)fill mix:(float)mix {
    double vw, vh, px, radius, globe;
    Metrics(camera, &vw, &vh, &px, &radius, &globe);
    FieldUniform u;
    memset(&u, 0, sizeof u);
    u.cam = (simd_float4){(float)camera.centreLat, (float)camera.centreLon, (float)globe, (float)camera.zoom};
    u.cam2 = (simd_float4){(float)camera.pitch, 0, 0, 0};
    u.view = (simd_float4){(float)vw, (float)vh, (float)px, (float)radius};
    u.geo0 = (simd_float4){(float)_grid.west, (float)_grid.north, (float)_grid.step, (float)GridEast(_grid)};
    u.geo1 = (simd_float4){(float)GridSouth(_grid), (float)_grid.nLon, (float)_grid.nLat, _grid.wrapsLongitude ? 1.f : 0.f};
    OwnChartPalette plate = OwnChartPaletteFor(_chartDark);
    const double *stops = NULL, *alphas = NULL;
    const OwnRGB *cols = NULL;
    int count = 0;
    double cutoff = -1e30;
    OwnFieldRampForAppearance((int)fill, _chartDark, &stops, &cols, &alphas, &count, &cutoff);
    if (count > 7) count = 7;
    u.flags = (simd_float4){1.f, 0.f, mix, (float)count};
    float stopv[8] = {0};
    for (int i = 0; i < count && i < 8; i++) stopv[i] = (float)stops[i];
    u.stops[0] = (simd_float4){stopv[0], stopv[1], stopv[2], stopv[3]};
    u.stops[1] = (simd_float4){stopv[4], stopv[5], stopv[6], stopv[7]};
    for (int i = 0; i < count && i < 7; i++)
        u.colours[i] = (simd_float4){(float)cols[i].r, (float)cols[i].g, (float)cols[i].b, (float)alphas[i]};
    BOOL colourField = fill == IsobarFieldTemperature || fill == IsobarFieldRain || fill == IsobarFieldWindSpeed;
    // missing.w is the overlay opacity scale over sea (OwnFieldSeaAlphaScale).
    u.missing = (simd_float4){(float)plate.missing.r, (float)plate.missing.g, (float)plate.missing.b,
        (float)OwnFieldSeaAlphaScale((int)fill)};
    u.ink = (simd_float4){(float)plate.isobar.r, (float)plate.isobar.g, (float)plate.isobar.b, colourField ? 1.f : 0.f};
    // colours[7] is past every ramp (at most 7 stops). It carries the land plate.
    u.colours[7] = (simd_float4){(float)plate.land.r, (float)plate.land.g, (float)plate.land.b, 1};
    [self ensureLandTexture];
    u.ocean = (simd_float4){(float)plate.sea.r, (float)plate.sea.g, (float)plate.sea.b, _landTex ? 1.f : 0.f};
    u.uncovered = (simd_float4){(float)plate.uncovered.r, (float)plate.uncovered.g, (float)plate.uncovered.b, (float)cutoff};
    return u;
}

- (BOOL)prepareTargetWidth:(NSUInteger)w height:(NSUInteger)h colour:(id<MTLTexture>)colour error:(NSError **)error {
    if (!_depthTex || _depthW != w || _depthH != h) {
        MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float
            width:w height:h mipmapped:NO];
        desc.usage = MTLTextureUsageRenderTarget;
        desc.storageMode = MTLStorageModePrivate;
        _depthTex = [_device newTextureWithDescriptor:desc];
        desc.pixelFormat = MTLPixelFormatRG32Float;
        desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
        _pickTex = [_device newTextureWithDescriptor:desc];
        desc.pixelFormat = MTLPixelFormatDepth32Float;
        desc.usage = MTLTextureUsageRenderTarget;
        desc.storageMode = MTLStorageModePrivate;
        _pickQueryDepth = [_device newTextureWithDescriptor:desc];
        desc.pixelFormat = MTLPixelFormatRG32Float;
        desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
        _pickQuery = [_device newTextureWithDescriptor:desc];
        _depthW = w;
        _depthH = h;
        _pickKey.valid = NO;
        _pickFrameValid = NO;
    }
    if (!_depthTex || !_pickTex || !_pickQuery || !_pickQueryDepth)
        return Fail(error, 15, @"depth texture could not be created");
    (void)colour;
    return YES;
}

static BOOL ColourFormatOK(MTLPixelFormat fmt) {
    return fmt == MTLPixelFormatRGBA8Unorm || fmt == MTLPixelFormatBGRA8Unorm
        || fmt == MTLPixelFormatRGBA8Unorm_sRGB || fmt == MTLPixelFormatBGRA8Unorm_sRGB
        || fmt == MTLPixelFormatRGBA16Float;
}

static double ToLinear(double c) {
    if (c <= 0.04045) return c / 12.92;
    return pow((c + 0.055) / 1.055, 2.4);
}

- (NSArray<id<MTLRenderPipelineState>> *)pipesForFormat:(MTLPixelFormat)fmt error:(NSError **)error {
    NSArray *cached = _pipes[@(fmt)];
    if (cached) return cached;
    id<MTLRenderPipelineState> field = MakePipe(_device, _fieldVS, _fieldFS, fmt, MTLPixelFormatRG32Float, NO, error);
    id<MTLRenderPipelineState> line = MakePipe(_device, _lineVS, _lineFS, fmt, MTLPixelFormatInvalid, YES, error);
    id<MTLRenderPipelineState> text = MakeTextPipe(_device, _textVS, _textFS, fmt, error);
    if (!field || !line || !text) return nil;
    cached = @[field, line, text];
    _pipes[@(fmt)] = cached;
    return cached;
}

// 64 KiB floor, then at least 1.5x the request, so a steady frame does not
// allocate again when the vertex count jitters.
- (id<MTLBuffer>)ring:(id<MTLBuffer> __strong *)slots caps:(NSUInteger *)caps slot:(int)slot bytes:(NSUInteger)bytes {
    if (bytes == 0) return nil;
    if (!slots[slot] || caps[slot] < bytes) {
        NSUInteger cap = bytes + bytes / 2;
        if (cap < bytes) cap = bytes;
        if (cap < 65536) cap = 65536;
        slots[slot] = [_device newBufferWithLength:cap options:MTLResourceStorageModeShared];
        caps[slot] = slots[slot] ? cap : 0;
        if (slots[slot]) _geometryAllocations++;
    }
    return slots[slot];
}

- (int)acquireFrameSlot {
    int n = (int)_slotGates.count;
    if (n <= 0) {
        _ringFallbacks++;
        return -1;
    }
    // The slot that already holds this frame's geometry is free once that
    // buffer has been committed and completed. Taking it avoids copying the
    // ring on the common path.
    if (_lineRingi >= 0 && _lineRingi < n
        && dispatch_semaphore_wait((dispatch_semaphore_t)_slotGates[_lineRingi], DISPATCH_TIME_NOW) == 0) {
        _slotNext = (_lineRingi + 1) % n;
        return _lineRingi;
    }
    for (int i = 0; i < n; i++) {
        int slot = (_slotNext + i) % n;
        if (dispatch_semaphore_wait((dispatch_semaphore_t)_slotGates[slot], DISPATCH_TIME_NOW) == 0) {
            _slotNext = (slot + 1) % n;
            return slot;
        }
    }
    int slot = _slotNext % n;
    // One 120 Hz frame. Longer than that, draw through a transient buffer
    // instead of stalling the popover.
    double waitBegan = NowMs();
    if (dispatch_semaphore_wait((dispatch_semaphore_t)_slotGates[slot],
            dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_MSEC)) == 0) {
        _lastSyncWaitMilliseconds += NowMs() - waitBegan;
        _slotNext = (slot + 1) % n;
        return slot;
    }
    _lastSyncWaitMilliseconds += NowMs() - waitBegan;
    _ringFallbacks++;
    return -1;
}

- (void)releaseFrameSlot:(int)slot {
    if (slot < 0 || slot >= (int)_slotGates.count) return;
    dispatch_semaphore_signal((dispatch_semaphore_t)_slotGates[slot]);
}

- (void)copyRingSlot:(int)from to:(int)to {
    if (from == to || from < 0 || to < 0 || from > 2 || to > 2) return;
    if (_cachedLineCount > 0 && _lineRing[from]) {
        NSUInteger bytes = (NSUInteger)_cachedLineCount * sizeof(FieldLineVertex);
        id<MTLBuffer> buf = [self ring:_lineRing caps:_lineRingCap slot:to bytes:bytes];
        if (buf && _lineRing[from].length >= bytes) memcpy(buf.contents, _lineRing[from].contents, bytes);
    }
    if (_cachedTextCount > 0 && _textRing[from]) {
        NSUInteger bytes = (NSUInteger)_cachedTextCount * sizeof(TextVertex);
        id<MTLBuffer> buf = [self ring:_textRing caps:_textRingCap slot:to bytes:bytes];
        if (buf && _textRing[from].length >= bytes) memcpy(buf.contents, _textRing[from].contents, bytes);
    }
}

- (void)setEndpointMixFrom:(double)fromTime to:(double)toTime mix:(float)mix {
    if (!(mix > 0) || !isfinite(fromTime) || !isfinite(toTime)) {
        _endpointMix = NO;
        return;
    }
    _endpoint0 = NearestTimeStep(fromTime);
    _endpoint1 = NearestTimeStep(toTime);
    _endpointT = MIN(1.f, mix);
    _endpointMix = YES;
}

- (BOOL)drawCamera:(IsobarCamera)camera fill:(IsobarFieldKind)fill isobars:(BOOL)isobars time:(double)time
    into:(id<MTLTexture>)color command:(id<MTLCommandBuffer>)external commit:(BOOL)commit
    blitColour:(BOOL)blitColour error:(NSError **)error {
    if (!_gridOK || _indexCount == 0) return Fail(error, 8, @"field grid is not set");
    double vw, vh, px, radius, globe;
    if (!Metrics(camera, &vw, &vh, &px, &radius, &globe)) return Fail(error, 10, @"camera is not usable");
    NSUInteger w = (NSUInteger)llround(vw), h = (NSUInteger)llround(vh);
    if (color.width != w || color.height != h) return Fail(error, 11, @"texture size does not match the camera");
    if (!ColourFormatOK(color.pixelFormat)) return Fail(error, 12, @"texture format is not supported");
    BOOL srgb = color.pixelFormat == MTLPixelFormatRGBA8Unorm_sRGB || color.pixelFormat == MTLPixelFormatBGRA8Unorm_sRGB;
    NSArray<id<MTLRenderPipelineState>> *pipes = [self pipesForFormat:color.pixelFormat error:error];
    if (!pipes) return NO;
    NSInteger i0 = 0, i1 = 0;
    float mix = 0;
    if (_endpointMix) {
        // Blend the end step into the now step. A missing now step holds the
        // end frame rather than failing the draw.
        i0 = _endpoint0;
        i1 = _endpoint1;
        mix = i0 == i1 ? 0 : _endpointT;
        if (mix > 0 && ![self slotForStep:i1 kind:IsobarFieldPressure]) {
            i1 = i0;
            mix = 0;
        }
        if (mix > 0 && fill != IsobarFieldPressure && ![self slotForStep:i1 kind:fill]) {
            i1 = i0;
            mix = 0;
        }
    } else if (!TimeSteps(time, &i0, &i1, &mix, error)) return NO;
    IsobarFieldSlot *fill0 = [self slotForStep:i0 kind:fill];
    IsobarFieldSlot *fill1 = mix == 0 ? fill0 : [self slotForStep:i1 kind:fill];
    if (!fill0 || !fill1) return Fail(error, 13, @"fill step is not resident");
    _lastContourMilliseconds = 0;
    _lastLabelMilliseconds = 0;
    _lastProjectMilliseconds = 0;
    _lastGeometryMilliseconds = 0;
    _lastSyncWaitMilliseconds = 0;
    double scale = [self pixelScale];
    if (isobars) {
        IsobarFieldSlot *msl0 = [self slotForStep:i0 kind:IsobarFieldPressure];
        IsobarFieldSlot *msl1 = mix == 0 ? msl0 : [self slotForStep:i1 kind:IsobarFieldPressure];
        if (!msl0 || !msl1) return Fail(error, 14, @"pressure step is not resident");
        [self ensureContoursStep0:i0 step1:i1 mix:mix camera:camera];
        [self buildAnnotationsCamera:camera s0:i0 s1:i1 mix:mix time:time];
        msl0.stamp = ++_clock;
        msl1.stamp = ++_clock;
    } else {
        _nLabels = 0;
        _nMarks = 0;
    }
    fill0.stamp = ++_clock;
    fill1.stamp = ++_clock;
    double geometryBegan = NowMs();
    if (![self prepareTargetWidth:w height:h colour:color error:error]) return NO;
    BOOL linesFresh = _current && _current->gen == _contentGen;
    BOOL linesGrace = isobars && _current && !linesFresh && _isobarGraceFor != _contentGen;
    BOOL drawIso = isobars && _current && (linesFresh || linesGrace);
    BOOL fadeSteady = YES;
    int nAlpha = _nLabels < kLabelCap ? _nLabels : kLabelCap;
    for (int i = 0; i < nAlpha; i++) if (_geomAlpha[i] != _labels[i].alpha) fadeSteady = NO;
    BOOL reuse = _geomValid && linesFresh && _geomSet == _current && fadeSteady && _geomIsobars == isobars
        && CamSame(_geomCam, camera) && fabs(_geomScale - scale) < 1e-6
        && _geomGen == _contentGen && _geomGen == _current->gen
        && _geomLabels == _nLabels && _lineRing[_lineRingi] != nil;
    int isoCount = _cachedLineCount;
    int coastCount = _coastCount;
    int textCount = _cachedTextCount;
    FieldLineVertex *lineVerts = NULL;
    TextVertex *textVerts = NULL;
    id<MTLBuffer> coastBuf = _coastBuf;
    if (!reuse) {
        _geometryTruncated = NO;
        isoCount = 0;
        OwnChartPalette plate = OwnChartPaletteFor(_chartDark);
        BOOL baseHit = _baseReady && CamSame(_baseCam, camera) && fabs(_baseScale - scale) < 1e-6
            && _baseGen == _contentGen && _baseDark == _chartDark;
        if (!baseHit) {
            _baseVertCount = 0;
            _baseTruncated = NO;
            IsobarRGB coastInk = FromOwn(plate.coast);
            OwnCoast coast = CoastForGrid(_grid, _coast, _worldCoast);
            for (int r = 0; r < coast.rings; r++) {
                int start = coast.ringStart[r];
                int n = coast.ringCount[r];
                PushSimplifiedCoast(&_baseVerts, &_baseVertCount, &_baseVertCap,
                    coast.lat + start, coast.lon + start, n, camera, coastInk, (float)scale, &_baseTruncated);
            }
            [self pushCoverageCamera:camera scale:scale verts:&_baseVerts count:&_baseVertCount cap:&_baseVertCap];
            _baseCam = camera;
            _baseScale = scale;
            _baseGen = _contentGen;
            _baseDark = _chartDark;
            _baseReady = YES;
            _coastBuf = nil;
            _coastCount = 0;
            if (_baseVertCount > 0) {
                _coastBuf = [_device newBufferWithBytes:_baseVerts
                    length:(NSUInteger)_baseVertCount * sizeof(FieldLineVertex)
                    options:MTLResourceStorageModeShared];
                _coastCount = _coastBuf ? _baseVertCount : 0;
            }
            coastBuf = _coastBuf;
        }
        coastCount = _coastCount;
        if (_baseTruncated) _geometryTruncated = YES;
        int lineCap = _isoCap;
        lineVerts = _isoVerts;
        if (drawIso) {
            IsobarRGB ink = FromOwn(plate.isobar);
            for (int i = 0; i < _current->nLines; i++) {
                float width = (float)((_chartDark ? 1.0 : OwnIsobarWidth(_current->lines[i].level)) * scale);
                [self pushGappedLine:i width:width ink:ink camera:camera scale:scale
                    verts:&lineVerts count:&isoCount cap:&lineCap];
            }
        }
        _isoVerts = lineVerts;
        _isoCap = lineCap;
        if (isoCount > _lineHighWater) _lineHighWater = isoCount;
        textCount = 0;
        textVerts = [self textVerts:&textCount];
        _lastGeometryMilliseconds = NowMs() - geometryBegan;
    }
    // Each frame owns one ring slot until its command buffer completes.
    // A slot that is never committed stays owned; this wait times out and
    // the frame draws through a transient buffer instead.
    int slot = [self acquireFrameSlot];
    id<MTLBuffer> lineBuf = nil;
    id<MTLBuffer> textBuf = nil;
    if (!reuse) {
        if (slot >= 0) {
            if (isoCount > 0 && lineVerts) {
                NSUInteger bytes = (NSUInteger)isoCount * sizeof(FieldLineVertex);
                id<MTLBuffer> buf = [self ring:_lineRing caps:_lineRingCap slot:slot bytes:bytes];
                if (buf) memcpy(buf.contents, lineVerts, bytes);
            }
            if (textCount > 0) {
                NSUInteger bytes = (NSUInteger)textCount * sizeof(TextVertex);
                id<MTLBuffer> buf = [self ring:_textRing caps:_textRingCap slot:slot bytes:bytes];
                if (buf) memcpy(buf.contents, textVerts, bytes);
            }
            _lineRingi = slot;
            _cachedLineCount = isoCount;
            _cachedTextCount = textCount;
            _geomValid = YES;
            _geomSet = drawIso ? _current : NULL;
            _geomIsobars = drawIso;
            _geomCam = camera;
            _geomScale = scale;
            _geomGen = (drawIso && _current) ? _current->gen : _contentGen;
            _geomLabels = _nLabels;
            memset(_geomAlpha, 0, sizeof _geomAlpha);
            for (int i = 0; i < nAlpha; i++) _geomAlpha[i] = _labels[i].alpha;
            lineBuf = _lineRing[slot];
            textBuf = _textRing[slot];
        } else {
            if (isoCount > 0 && lineVerts)
                lineBuf = [_device newBufferWithBytes:lineVerts length:(NSUInteger)isoCount * sizeof(FieldLineVertex)
                    options:MTLResourceStorageModeShared];
            if (textCount > 0)
                textBuf = [_device newBufferWithBytes:textVerts length:(NSUInteger)textCount * sizeof(TextVertex)
                    options:MTLResourceStorageModeShared];
            _geomValid = NO;
        }
        free(textVerts);
        textVerts = NULL;
    } else if (slot >= 0) {
        if (slot != _lineRingi) [self copyRingSlot:_lineRingi to:slot];
        _lineRingi = slot;
        lineBuf = _lineRing[slot];
        textBuf = _textRing[slot];
    } else {
        if (_cachedLineCount > 0 && _lineRing[_lineRingi])
            lineBuf = [_device newBufferWithBytes:_lineRing[_lineRingi].contents
                length:(NSUInteger)_cachedLineCount * sizeof(FieldLineVertex) options:MTLResourceStorageModeShared];
        if (_cachedTextCount > 0 && _textRing[_lineRingi])
            textBuf = [_device newBufferWithBytes:_textRing[_lineRingi].contents
                length:(NSUInteger)_cachedTextCount * sizeof(TextVertex) options:MTLResourceStorageModeShared];
    }
    if (linesGrace) {
        _isobarGraceFor = _contentGen;
        if (_projExternal && _projSet == _current) [self detachProj];
        if (_geomSet == _current) _geomSet = NULL;
        _geomValid = NO;
        SetFree(_current);
        _current = NULL;
    }
    NSUInteger colourStride = (w * 4 + 255u) & ~255u;
    if (blitColour && (!_readback || _readbackStride != colourStride || _readback.length < colourStride * h)) {
        _readback = [_device newBufferWithLength:colourStride * h options:MTLResourceStorageModeShared];
        _readbackStride = colourStride;
    }
    if (blitColour && !_readback) {
        [self releaseFrameSlot:slot];
        return Fail(error, 21, @"readback buffer could not be created");
    }
    id<MTLCommandBuffer> buffer = external ?: [_queue commandBuffer];
    if (!buffer) {
        [self releaseFrameSlot:slot];
        return Fail(error, 16, @"command buffer could not be created");
    }
    MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
    IsobarRGB ocean = FromOwn(OwnChartPaletteFor(_chartDark).sea);
    double cr = ocean.r, cg = ocean.g, cb = ocean.b;
    if (srgb) { cr = ToLinear(cr); cg = ToLinear(cg); cb = ToLinear(cb); }
    pass.colorAttachments[0].texture = color;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(cr, cg, cb, 1);
    pass.colorAttachments[1].texture = _pickTex;
    pass.colorAttachments[1].loadAction = MTLLoadActionClear;
    pass.colorAttachments[1].storeAction = MTLStoreActionStore;
    pass.colorAttachments[1].clearColor = MTLClearColorMake(999, 999, 0, 0);
    pass.depthAttachment.texture = _depthTex;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.storeAction = (coastCount + isoCount) > 0 ? MTLStoreActionStore : MTLStoreActionDontCare;
    pass.depthAttachment.clearDepth = 1;
    id<MTLRenderCommandEncoder> enc = [buffer renderCommandEncoderWithDescriptor:pass];
    if (!enc) {
        [self releaseFrameSlot:slot];
        return Fail(error, 17, @"render pass could not be created");
    }
    FieldUniform uniform = [self uniformForCamera:camera fill:fill mix:mix];
    uniform.flags.x = srgb ? 2.f : 1.f;
    uniform.flags.y = (float)scale;
    [enc setRenderPipelineState:pipes[0]];
    [enc setDepthStencilState:_depthWrite];
    [enc setCullMode:MTLCullModeNone];
    [enc setVertexBuffer:_vertices offset:0 atIndex:1];
    [enc setVertexBytes:&uniform length:sizeof uniform atIndex:0];
    [enc setFragmentBytes:&uniform length:sizeof uniform atIndex:0];
    [enc setFragmentTexture:fill0.texture atIndex:0];
    [enc setFragmentTexture:fill1.texture atIndex:1];
    [enc setFragmentTexture:(_landTex ?: _landDummy) atIndex:2];
    [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:_indexCount indexType:MTLIndexTypeUInt32
        indexBuffer:_indices indexBufferOffset:0];
    [enc endEncoding];
    if (coastCount + isoCount > 0) {
        MTLRenderPassDescriptor *lines = [MTLRenderPassDescriptor renderPassDescriptor];
        lines.colorAttachments[0].texture = color;
        lines.colorAttachments[0].loadAction = MTLLoadActionLoad;
        lines.colorAttachments[0].storeAction = MTLStoreActionStore;
        lines.depthAttachment.texture = _depthTex;
        lines.depthAttachment.loadAction = MTLLoadActionLoad;
        lines.depthAttachment.storeAction = MTLStoreActionDontCare;
        id<MTLRenderCommandEncoder> le = [buffer renderCommandEncoderWithDescriptor:lines];
        if (le && ((coastCount > 0 && coastBuf) || (isoCount > 0 && lineBuf))) {
            [le setRenderPipelineState:pipes[1]];
            [le setDepthStencilState:_depthRead];
            [le setDepthBias:-0.0015 slopeScale:0 clamp:0];
            [le setCullMode:MTLCullModeNone];
            [le setVertexBytes:&uniform length:sizeof uniform atIndex:0];
            [le setFragmentBytes:&uniform length:sizeof uniform atIndex:0];
            [le setFragmentTexture:_pickTex atIndex:0];
            if (coastCount > 0 && coastBuf) {
                [le setVertexBuffer:coastBuf offset:0 atIndex:1];
                [le drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:(NSUInteger)coastCount];
            }
            if (isoCount > 0 && lineBuf) {
                [le setVertexBuffer:lineBuf offset:0 atIndex:1];
                [le drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:(NSUInteger)isoCount];
            }
            [le endEncoding];
        } else if (le) {
            [le endEncoding];
        }
    }
    if (textCount > 0 && _atlas && textBuf) {
        MTLRenderPassDescriptor *text = [MTLRenderPassDescriptor renderPassDescriptor];
        text.colorAttachments[0].texture = color;
        text.colorAttachments[0].loadAction = MTLLoadActionLoad;
        text.colorAttachments[0].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> te = [buffer renderCommandEncoderWithDescriptor:text];
        if (te) {
            [te setRenderPipelineState:pipes[2]];
            [te setCullMode:MTLCullModeNone];
            [te setVertexBuffer:textBuf offset:0 atIndex:1];
            [te setVertexBytes:&uniform length:sizeof uniform atIndex:0];
            [te setFragmentBytes:&uniform length:sizeof uniform atIndex:0];
            [te setFragmentTexture:_atlas atIndex:0];
            [te setFragmentTexture:_pickTex atIndex:1];
            [te drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:(NSUInteger)textCount];
            [te endEncoding];
        }
    }
    if (blitColour) {
        id<MTLBlitCommandEncoder> blit = [buffer blitCommandEncoder];
        if (!blit) {
            [self releaseFrameSlot:slot];
            return Fail(error, 22, @"field readback failed");
        }
        [blit copyFromTexture:color sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0, 0, 0)
            sourceSize:MTLSizeMake(w, h, 1) toBuffer:_readback destinationOffset:0
            destinationBytesPerRow:colourStride destinationBytesPerImage:colourStride * h];
        [blit endEncoding];
    }
    IsobarCamera doneCam = camera;
    int owned = slot;
    uint64_t seq = ++_encodeSeq;
    [buffer addCompletedHandler:^(id<MTLCommandBuffer> done) {
        [self releaseFrameSlot:owned];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (seq < self->_pickFrameSeq) return;
            IsobarCamera prev = self->_pickFrameCam;
            BOOL had = self->_pickFrameValid;
            self->_pickFrameSeq = seq;
            self->_pickFrameCam = doneCam;
            self->_pickFrameValid = done.status == MTLCommandBufferStatusCompleted;
            if (!self->_pickFrameValid || !had || !CamSame(prev, doneCam))
                self->_pickKey.valid = NO;
        });
    }];
    if (!commit) return YES;
    [buffer commit];
    [buffer waitUntilCompleted];
    if (buffer.status != MTLCommandBufferStatusCompleted)
        return Fail(error, 18, buffer.error.localizedDescription ?: @"field render failed");
    double gpu = (buffer.GPUEndTime - buffer.GPUStartTime) * 1000.0;
    _lastGpuMilliseconds = gpu > 0 ? gpu : 0;
    return YES;
}

- (BOOL)renderTime:(double)fractionalStep fill:(IsobarFieldKind)fill isobars:(BOOL)isobars
    camera:(IsobarCamera)camera toTexture:(id<MTLTexture>)texture error:(NSError **)error {
    if (!texture) return Fail(error, 19, @"render texture is missing");
    id<MTLCommandBuffer> buffer = [_queue commandBuffer];
    if (!buffer) return Fail(error, 16, @"command buffer could not be created");
    if (![self drawCamera:camera fill:fill isobars:isobars time:fractionalStep into:texture
            command:buffer commit:YES blitColour:NO error:error]) return NO;
    return YES;
}

- (BOOL)encodeTime:(double)fractionalStep fill:(IsobarFieldKind)fill isobars:(BOOL)isobars
    camera:(IsobarCamera)camera intoCommandBuffer:(id<MTLCommandBuffer>)commandBuffer
    target:(id<MTLTexture>)target error:(NSError **)error {
    _lastSyncWaitMilliseconds = 0;
    if (!commandBuffer) return Fail(error, 16, @"command buffer is missing");
    if (!target) return Fail(error, 19, @"render texture is missing");
    return [self drawCamera:camera fill:fill isobars:isobars time:fractionalStep into:target
        command:commandBuffer commit:NO blitColour:NO error:error];
}

static void FreePixels(void *info, const void *data, size_t size) {
    (void)info;
    (void)size;
    free((void *)data);
}

- (CGImageRef)renderTime:(double)fractionalStep fill:(IsobarFieldKind)fill isobars:(BOOL)isobars
    camera:(IsobarCamera)camera error:(NSError **)error {
    double vw, vh, px, radius, globe;
    if (!Metrics(camera, &vw, &vh, &px, &radius, &globe)) {
        Fail(error, 10, @"camera is not usable");
        return NULL;
    }
    NSUInteger w = (NSUInteger)llround(vw), h = (NSUInteger)llround(vh);
    if (!_colorTex || _colorTex.width != w || _colorTex.height != h) {
        MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
            width:w height:h mipmapped:NO];
        desc.usage = MTLTextureUsageRenderTarget;
        desc.storageMode = MTLStorageModePrivate;
        _colorTex = [_device newTextureWithDescriptor:desc];
    }
    if (!_colorTex) {
        Fail(error, 20, @"colour texture could not be created");
        return NULL;
    }
    if (![self drawCamera:camera fill:fill isobars:isobars time:fractionalStep into:_colorTex
            command:nil commit:YES blitColour:YES error:error])
        return NULL;
    size_t tight = (size_t)w * 4 * (size_t)h;
    uint8_t *pixels = malloc(tight);
    if (!pixels) {
        Fail(error, 5, @"image is out of memory");
        return NULL;
    }
    const uint8_t *src = _readback.contents;
    for (NSUInteger row = 0; row < h; row++)
        memcpy(pixels + row * w * 4, src + row * _readbackStride, w * 4);
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, pixels, tight, FreePixels);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image = CGImageCreate(w, h, 8, 32, w * 4, space,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big,
        provider, NULL, NO, kCGRenderingIntentDefault);
    CGColorSpaceRelease(space);
    CGDataProviderRelease(provider);
    if (!image) {
        Fail(error, 23, @"image could not be created");
        return NULL;
    }
    return image;
}

- (BOOL)latestFrameCamera:(IsobarCamera *)camera {
    if (!_pickFrameValid) return NO;
    if (camera) *camera = _pickFrameCam;
    return YES;
}

- (BOOL)ensurePickCamera:(IsobarCamera)camera error:(NSError **)error {
    if (_pickKey.valid && memcmp(&_pickKey.camera, &camera, sizeof camera) == 0 && _pickQuery) return YES;
    if (!_gridOK) return Fail(error, 8, @"field grid is not set");
    double vw, vh, px, radius, globe;
    if (!Metrics(camera, &vw, &vh, &px, &radius, &globe)) return Fail(error, 10, @"camera is not usable");
    NSUInteger w = (NSUInteger)llround(vw), h = (NSUInteger)llround(vh);
    if (![self prepareTargetWidth:w height:h colour:nil error:error]) return NO;
    id<MTLCommandBuffer> buffer = [_queue commandBuffer];
    if (!buffer) return Fail(error, 16, @"command buffer could not be created");
    MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
    pass.colorAttachments[0].texture = _pickQuery;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(999, 999, 0, 0);
    pass.depthAttachment.texture = _pickQueryDepth;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.storeAction = MTLStoreActionDontCare;
    pass.depthAttachment.clearDepth = 1;
    id<MTLRenderCommandEncoder> enc = [buffer renderCommandEncoderWithDescriptor:pass];
    if (!enc) return Fail(error, 17, @"render pass could not be created");
    FieldUniform uniform = [self uniformForCamera:camera fill:IsobarFieldPressure mix:0];
    [enc setRenderPipelineState:_pipePick];
    [enc setDepthStencilState:_depthWrite];
    [enc setCullMode:MTLCullModeNone];
    [enc setVertexBuffer:_vertices offset:0 atIndex:1];
    [enc setVertexBytes:&uniform length:sizeof uniform atIndex:0];
    [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:_indexCount indexType:MTLIndexTypeUInt32
        indexBuffer:_indices indexBufferOffset:0];
    [enc endEncoding];
    [buffer commit];
    [buffer waitUntilCompleted];
    if (buffer.status != MTLCommandBufferStatusCompleted)
        return Fail(error, 18, buffer.error.localizedDescription ?: @"field render failed");
    _pickKey.valid = YES;
    _pickKey.camera = camera;
    return YES;
}

- (BOOL)copyPickX:(int)ix y:(int)iy lat:(float *)lat lon:(float *)lon {
    if (!_pickPixel) _pickPixel = [_device newBufferWithLength:256 options:MTLResourceStorageModeShared];
    if (!_pickPixel || !_pickQuery) return NO;
    id<MTLCommandBuffer> buffer = [_queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = buffer ? [buffer blitCommandEncoder] : nil;
    if (!blit) return NO;
    [blit copyFromTexture:_pickQuery sourceSlice:0 sourceLevel:0
        sourceOrigin:MTLOriginMake((NSUInteger)ix, (NSUInteger)iy, 0)
        sourceSize:MTLSizeMake(1, 1, 1) toBuffer:_pickPixel destinationOffset:0
        destinationBytesPerRow:256 destinationBytesPerImage:256];
    [blit endEncoding];
    [buffer commit];
    [buffer waitUntilCompleted];
    if (buffer.status != MTLCommandBufferStatusCompleted) return NO;
    memcpy(lat, _pickPixel.contents, sizeof(float));
    memcpy(lon, (const uint8_t *)_pickPixel.contents + sizeof(float), sizeof(float));
    return YES;
}

- (BOOL)pickLatitude:(double *)latitude longitude:(double *)longitude atX:(double)x y:(double)y camera:(IsobarCamera)camera {
    if (![self ensurePickCamera:camera error:NULL]) return NO;
    double vw, vh, px, radius, globe;
    if (!Metrics(camera, &vw, &vh, &px, &radius, &globe)) return NO;
    int ix = (int)floor(x), iy = (int)floor(y);
    int w = (int)llround(vw), h = (int)llround(vh);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return NO;
    float lat = 0, lon = 0;
    if (![self copyPickX:ix y:iy lat:&lat lon:&lon]) return NO;
    if (!isfinite(lat) || !isfinite(lon) || lat > 90.5 || lat < -90.5) return NO;
    if (latitude) *latitude = lat;
    if (longitude) *longitude = Wrap180(lon);
    return YES;
}

- (double)pickValueAtX:(double)x y:(double)y camera:(IsobarCamera)camera time:(double)time kind:(IsobarFieldKind)kind {
    double lat = 0, lon = 0;
    if (![self pickLatitude:&lat longitude:&lon atX:x y:y camera:camera]) return NAN;
    return [self blendAtLat:lat lon:lon time:time kind:kind];
}

- (NSInteger)contourLineCount { return _current ? _current->nLines : 0; }

- (NSInteger)contourVertexCountForLine:(NSInteger)line {
    if (!_current || line < 0 || line >= _current->nLines) return 0;
    return _current->lines[line].count;
}

- (double)contourLevelForLine:(NSInteger)line {
    if (!_current || line < 0 || line >= _current->nLines) return NAN;
    return _current->lines[line].level;
}

- (BOOL)contourLineIsClosed:(NSInteger)line {
    if (!_current || line < 0 || line >= _current->nLines) return NO;
    return _current->lines[line].closed ? YES : NO;
}

- (BOOL)contourVertexForLine:(NSInteger)line index:(NSInteger)index latitude:(double *)latitude longitude:(double *)longitude {
    if (!_current || line < 0 || line >= _current->nLines || index < 0 || index >= _current->lines[line].count) return NO;
    if (latitude) *latitude = _current->lines[line].lat[index];
    if (longitude) *longitude = _current->lines[line].lon[index];
    return YES;
}

- (NSInteger)labelCount { return _nLabels; }

- (BOOL)labelAtIndex:(NSInteger)index x:(double *)x y:(double *)y angle:(double *)angle
    level:(double *)level halfW:(double *)halfW halfH:(double *)halfH {
    if (index < 0 || index >= _nLabels) return NO;
    DrawnLabel lab = _labels[index];
    if (x) *x = lab.x;
    if (y) *y = lab.y;
    if (angle) *angle = lab.angle;
    if (level) *level = lab.level;
    if (halfW) *halfW = lab.halfW;
    if (halfH) *halfH = lab.halfH;
    return YES;
}

- (uint32_t)labelIdentAtIndex:(NSInteger)index {
    if (index < 0 || index >= _nLabels) return 0;
    return _labels[index].ident;
}

- (NSInteger)centreCount { return _nMarks; }

- (BOOL)centreAtIndex:(NSInteger)index x:(double *)x y:(double *)y value:(double *)value high:(BOOL *)high {
    if (index < 0 || index >= _nMarks) return NO;
    DrawnCentre mark = _marks[index];
    if (x) *x = mark.x;
    if (y) *y = mark.y;
    if (value) *value = mark.value;
    if (high) *high = mark.high ? YES : NO;
    return YES;
}

@end
