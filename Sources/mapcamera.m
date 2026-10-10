#import "mapcamera.h"
#import <math.h>
#import <string.h>

const double kMapMorphSeconds = 0.6;
static const double kDeg = 0.017453292519943295;

double MapWrap180(double lon) {
    if (!isfinite(lon)) return lon;
    double x = fmod(lon + 180.0, 360.0);
    if (x < 0) x += 360.0;
    return x - 180.0;
}

double MapEaseInOut(double t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3.0 - 2.0 * t);
}

double MapGlobeAt(double from, double to, double elapsed, double duration, int reduced) {
    if (reduced || !(duration > 0)) return to;
    if (elapsed <= 0) return from;
    if (elapsed >= duration) return to;
    double e = MapEaseInOut(elapsed / duration);
    return from + (to - from) * e;
}

int MapPointerIsClick(double dx, double dy, double slop) {
    return hypot(dx, dy) <= slop;
}

IsobarCamera MapCameraMake(double lat, double lon, double zoom, double globe, double w, double h) {
    IsobarCamera cam;
    memset(&cam, 0, sizeof cam);
    cam.centreLat = lat;
    cam.centreLon = MapWrap180(lon);
    cam.zoom = zoom;
    cam.globe = globe;
    cam.pitch = 0;
    cam.bearing = 0;
    cam.viewportW = w;
    cam.viewportH = h;
    return cam;
}

static BOOL MapRadius(IsobarCamera cam, double *radius) {
    if (!(cam.viewportW >= 2) || !(cam.viewportH >= 2)) return NO;
    if (!(cam.zoom > 0) || !isfinite(cam.zoom)) return NO;
    double fit = fmin(cam.viewportW / 360.0, cam.viewportH / 180.0);
    double px = cam.zoom * fit;
    if (!(px > 0)) return NO;
    *radius = px / kDeg;
    return isfinite(*radius) && *radius > 0;
}

static BOOL ScreenOf(IsobarCamera cam, double lat, double lon, double x, double y,
    double *err, double *px, double *py) {
    double sx = 0, sy = 0;
    if (!IsobarCameraProject(cam, lat, lon, &sx, &sy)) return NO;
    if (px) *px = sx;
    if (py) *py = sy;
    if (err) *err = hypot(sx - x, sy - y);
    return YES;
}

static BOOL AnchorFlat(IsobarCamera *cam, double lat, double lon, double x, double y) {
    double radius = 0;
    if (!cam || !MapRadius(*cam, &radius)) return NO;
    double X = (x - cam->viewportW * 0.5) / radius;
    double Y = (cam->viewportH * 0.5 - y) / radius;
    double centreLat = lat - Y / kDeg;
    if (centreLat > 90 || centreLat < -90 || !isfinite(centreLat)) return NO;
    double cos0 = cos(centreLat * kDeg);
    if (fabs(cos0) < 1e-6) return NO;
    double dlon = (X / cos0) / kDeg;
    if (!isfinite(dlon) || fabs(dlon) > 180) return NO;
    cam->centreLat = centreLat;
    cam->centreLon = MapWrap180(lon - dlon);
    return YES;
}

static void ClampAnchorLatitude(IsobarCamera *cam) {
    if (cam->pitch >= 20.0 * kDeg || (cam->pitch <= 1e-7 && cam->globe >= 1 - 1e-7)) return;
    cam->centreLat = fmax(-89.5, fmin(89.5, cam->centreLat));
}

static BOOL AnchorSphere(IsobarCamera *cam, double lat, double lon, double x, double y) {
    double err = 0;
    if (!ScreenOf(*cam, lat, lon, x, y, &err, NULL, NULL)) {
        cam->centreLat = lat;
        cam->centreLon = MapWrap180(lon);
        if (!ScreenOf(*cam, lat, lon, x, y, &err, NULL, NULL)) return NO;
    }
    for (int iter = 0; iter < 12 && err > 0.05; iter++) {
        double px = 0, py = 0;
        if (!ScreenOf(*cam, lat, lon, x, y, &err, &px, &py)) break;
        if (err <= 0.05) break;
        double h = 1e-4;
        IsobarCamera latCam = *cam, lonCam = *cam;
        latCam.centreLat += h;
        lonCam.centreLon = MapWrap180(cam->centreLon + h);
        double ax = 0, ay = 0, bx = 0, by = 0, aerr = 0, berr = 0;
        if (!ScreenOf(latCam, lat, lon, x, y, &aerr, &ax, &ay)) return NO;
        if (!ScreenOf(lonCam, lat, lon, x, y, &berr, &bx, &by)) return NO;
        double j00 = (ax - px) / h, j01 = (bx - px) / h;
        double j10 = (ay - py) / h, j11 = (by - py) / h;
        double det = j00 * j11 - j01 * j10;
        if (fabs(det) < 1e-12) break;
        double dLat = (j11 * (x - px) - j01 * (y - py)) / det;
        double dLon = (-j10 * (x - px) + j00 * (y - py)) / det;
        BOOL stepped = NO;
        for (int k = 0; k < 8; k++) {
            double s = 1.0 / (double)(1 << k);
            IsobarCamera trial = *cam;
            trial.centreLat += dLat * s;
            trial.centreLon = MapWrap180(trial.centreLon + dLon * s);
            ClampAnchorLatitude(&trial);
            double terr = 0;
            if (!ScreenOf(trial, lat, lon, x, y, &terr, NULL, NULL)) continue;
            if (terr < err) {
                *cam = trial;
                err = terr;
                stepped = YES;
                break;
            }
        }
        if (!stepped) break;
    }
    if (err > 1) {
        double step = 1;
        for (int iter = 0; iter < 48 && err > 0.05 && step > 1e-6; iter++) {
            IsobarCamera best = *cam;
            double bestErr = err;
            double dlat[4] = {step, -step, 0, 0};
            double dlon[4] = {0, 0, step, -step};
            for (int k = 0; k < 4; k++) {
                IsobarCamera trial = *cam;
                trial.centreLat += dlat[k];
                trial.centreLon = MapWrap180(trial.centreLon + dlon[k]);
                ClampAnchorLatitude(&trial);
                double terr = 0;
                if (!ScreenOf(trial, lat, lon, x, y, &terr, NULL, NULL)) continue;
                if (terr < bestErr) {
                    bestErr = terr;
                    best = trial;
                }
            }
            if (bestErr < err) {
                *cam = best;
                err = bestErr;
            } else {
                step *= 0.5;
            }
        }
    }
    return err <= 1;
}

BOOL MapCameraAnchor(IsobarCamera *camera, double lat, double lon, double x, double y) {
    if (!camera || !isfinite(lat) || !isfinite(lon) || !isfinite(x) || !isfinite(y)) return NO;
    IsobarCamera cam = *camera;
    double globe = cam.globe;
    if (!isfinite(globe)) return NO;
    if (globe < 0) globe = 0;
    if (globe > 1) globe = 1;
    cam.globe = globe;
    if (globe >= 1 - 1e-7 || fabs(cam.pitch) > 1e-7) {
        if (!AnchorSphere(&cam, lat, lon, x, y)) return NO;
        *camera = cam;
        return YES;
    }
    if (!AnchorFlat(&cam, lat, lon, x, y)) return NO;
    if (globe <= 1e-7) {
        double err = 0;
        if (!ScreenOf(cam, lat, lon, x, y, &err, NULL, NULL) || err > 1) return NO;
    }
    *camera = cam;
    return YES;
}

BOOL MapCameraAdjustEyeHeight(IsobarCamera *camera, double delta) {
    if (!camera || !isfinite(delta) || !isfinite(camera->pitch) || !(camera->zoom > 0) ||
        !(camera->viewportW >= 2) || !(camera->viewportH >= 2)) return NO;
    const double fov = 25.0 * kDeg;
    double t = camera->pitch / (20.0 * kDeg);
    if (t <= 0) t = 0;
    else if (t >= 1) t = 1;
    else t = t * t * (3.0 - 2.0 * t);
    t = fmax(t, 1e-3);
    double fit = fmin(camera->viewportW / 360.0, camera->viewportH / 180.0);
    double radius = camera->zoom * fit / kDeg;
    double distance = (camera->viewportH * 0.5 / radius) / tan(fov) / t;
    double horizontal = sin(camera->pitch) * distance;
    double vertical = cos(camera->pitch) * distance;
    double maxPitch = 1.30;
    double newVertical = fmax(100.0 / 6371000.0, horizontal / tan(maxPitch));
    newVertical = fmax(newVertical, vertical + delta * distance);
    double newDistance = hypot(horizontal, newVertical);
    if (!(distance > 1e-6) || !(newDistance > 1e-6)) return NO;
    camera->pitch = atan2(horizontal, newVertical);
    double newT = camera->pitch / (20.0 * kDeg);
    if (newT <= 0) newT = 0;
    else if (newT >= 1) newT = 1;
    else newT = newT * newT * (3.0 - 2.0 * newT);
    newT = fmax(newT, 1e-3);
    camera->zoom *= distance / newDistance * t / newT;
    camera->globe = fmax(0, fmin(1, camera->pitch / (20.0 * kDeg)));
    *camera = IsobarCameraClamp(*camera);
    return YES;
}
