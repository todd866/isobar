#import "terrainscene.h"
#import <math.h>
#import <os/lock.h>

static const double kDegree = 0.017453292519943295;
static const double kEarthM = 6371000.0;

static double Clamp(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
static double Smooth(double e0, double e1, double x) { double t = Clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
static double Wrap180(double x) { double y = fmod(x + 180.0, 360.0); if (y < 0) y += 360.0; return y - 180.0; }

double TerrainReliefFactor(double spanKm) {
    if (!isfinite(spanKm) || spanKm <= 0) return 0;
    double rise = Smooth(0, 1, log2(spanKm / 25.0) / log2(20.0));
    double degrees = spanKm / 111.195;
    return (1.0 + 3.0 * rise) * (1.0 - Smooth(30.0, 70.0, degrees));
}

// ---- Scenes and their registry -------------------------------------------

static IsobarTerrainGrid GridOf(IsobarTerrainMosaic *m) {
    IsobarTerrainGrid g = {0};
    if (!m || !m.covered || !m.samples.length) return g;
    g.west = m.box.west; g.south = m.box.south; g.east = m.box.east; g.north = m.box.north;
    g.width = m.width; g.height = m.height; g.samples = m.samples.bytes;
    return g;
}

@implementation IsobarTerrainScene {
    uint64_t _token;
}
- (instancetype)initWithNear:(IsobarTerrainMosaic *)near far:(IsobarTerrainMosaic *)far {
    if (!(self = [super init])) return nil;
    _near = near.covered ? near : nil;
    _far = far.covered ? far : nil;
    double top = 0;
    for (IsobarTerrainMosaic *m in @[_near ?: (id)NSNull.null, _far ?: (id)NSNull.null]) {
        if (![m isKindOfClass:IsobarTerrainMosaic.class]) continue;
        const float *p = m.samples.bytes;
        for (NSUInteger i = 0; i < (NSUInteger)m.width * m.height; i++)
            if (p[i * 2 + 1] >= 1 && p[i * 2] > top) top = p[i * 2];
    }
    _maxHeightM = top;
    return self;
}
- (uint64_t)token { return _token; }

static os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
static IsobarTerrainScene *__strong gScenes[8];
static uint64_t gNextToken;
static unsigned long gEpoch = 1;

- (uint64_t)registerScene {
    os_unfair_lock_lock(&gLock);
    if (_token) { os_unfair_lock_unlock(&gLock); return _token; }
    _token = ++gNextToken;
    int slot = 0;
    for (int i = 0; i < 8; i++) {
        if (!gScenes[i]) { slot = i; break; }
        if (gScenes[i]->_token < gScenes[slot]->_token) slot = i;
    }
    IsobarTerrainScene *retired = gScenes[slot];
    gScenes[slot] = self;
    if (retired) gEpoch++;
    os_unfair_lock_unlock(&gLock);
    // A projection on another thread may still hold the retired grids for
    // the rest of its frame. Release them later, off every hot path.
    if (retired) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ (void)retired; });
    return _token;
}
@end

static IsobarTerrainScene *SceneForToken(uint64_t token) {
    if (!token) return nil;
    IsobarTerrainScene *found = nil;
    os_unfair_lock_lock(&gLock);
    for (int i = 0; i < 8; i++) if (gScenes[i] && gScenes[i].token == token) { found = gScenes[i]; break; }
    os_unfair_lock_unlock(&gLock);
    return found;
}

static unsigned long Epoch(void) {
    os_unfair_lock_lock(&gLock);
    unsigned long e = gEpoch;
    os_unfair_lock_unlock(&gLock);
    return e;
}

// ---- Heights: the CPU twin of terrainshader.inc --------------------------

static BOOL GridSample(const IsobarTerrainGrid *g, double lat, double lon, double *h, double *edge) {
    if (!g->samples || g->width < 2 || g->height < 2) return NO;
    double span = g->east - g->west, vspan = g->north - g->south;
    if (!(span > 0) || !(vspan > 0)) return NO;
    double rel = lon - g->west;
    if (rel < 0 || rel >= 360.0) { rel = fmod(rel, 360.0); if (rel < 0) rel += 360.0; }
    if (rel > span || lat < g->south || lat > g->north) return NO;
    double uu = rel / span, vv = (lat - g->south) / vspan;
    double x = Clamp(uu * g->width - 0.5, 0, g->width - 1), y = Clamp(vv * g->height - 0.5, 0, g->height - 1);
    int x0 = (int)floor(x), y0 = (int)floor(y);
    int x1 = x0 + 1 < g->width ? x0 + 1 : g->width - 1, y1 = y0 + 1 < g->height ? y0 + 1 : g->height - 1;
    const float *p = g->samples;
    size_t i00 = ((size_t)y0 * g->width + x0) * 2, i10 = ((size_t)y0 * g->width + x1) * 2;
    size_t i01 = ((size_t)y1 * g->width + x0) * 2, i11 = ((size_t)y1 * g->width + x1) * 2;
    if (p[i00 + 1] < 1 || p[i10 + 1] < 1 || p[i01 + 1] < 1 || p[i11 + 1] < 1) return NO;
    double a = x - x0, b = y - y0;
    *h = (1 - b) * ((1 - a) * p[i00] + a * p[i10]) + b * ((1 - a) * p[i01] + a * p[i11]);
    if (edge) *edge = Smooth(0, 0.06, fmin(fmin(uu, 1 - uu), fmin(vv, 1 - vv)));
    return YES;
}

double TerrainSceneGroundHeight(const IsobarTerrainView *v, double lat, double lon) {
    double n = 0, e = 0, f = 0;
    BOOL hn = GridSample(&v->near, lat, lon, &n, &e);
    // Inside the near box's blend band the far grid has no weight.
    BOOL hf = hn && e >= 1.0 ? NO : GridSample(&v->far, lat, lon, &f, NULL);
    double h = hn ? (hf ? f + (n - f) * e : n) : (hf ? f : 0);
    return h > 0 ? h : 0;
}

static double MeshOffset(const IsobarTerrainView *v, double i) {
    double a = fabs(i), n0 = v->n0, r = v->ratio;
    double o = a <= n0 ? a : (r - 1 < 1e-6 ? a : n0 + r * (pow(r, a - n0) - 1) / (r - 1));
    return i < 0 ? -o : o;
}

static double MeshIndex(const IsobarTerrainView *v, double o) {
    double a = fabs(o), n0 = v->n0, r = v->ratio;
    double i = a <= n0 ? a : (r - 1 < 1e-6 ? a : n0 + log(1 + (a - n0) * (r - 1) / r) / log(r));
    return o < 0 ? -i : i;
}

static double MeshLat(const IsobarTerrainView *v, double i) { return Clamp(v->latC + MeshOffset(v, i) * v->sLat, -89.5, 89.5); }
static double MeshLon(const IsobarTerrainView *v, double j) { return v->lonC + MeshOffset(v, j) * v->sLon; }

double TerrainSceneDisplayedHeight(const IsobarTerrainView *v, double lat, double lon) {
    if (!v || !v->active || !isfinite(lat) || !isfinite(lon)) return 0;
    double N = v->n0 + v->nOuter;
    double dl = Wrap180(lon - v->lonC);
    double iy = MeshIndex(v, (lat - v->latC) / v->sLat), ix = MeshIndex(v, dl / v->sLon);
    if (fabs(iy) >= N || fabs(ix) >= N) return 0;
    double cy = floor(iy), cx = floor(ix);
    double la0 = v->latC + MeshOffset(v, cy) * v->sLat, la1 = v->latC + MeshOffset(v, cy + 1) * v->sLat;
    double lo0 = MeshOffset(v, cx) * v->sLon, lo1 = MeshOffset(v, cx + 1) * v->sLon;
    double b = Clamp((lat - la0) / (la1 - la0), 0, 1), a = Clamp((dl - lo0) / (lo1 - lo0), 0, 1);
    double h00 = TerrainSceneGroundHeight(v, MeshLat(v, cy), MeshLon(v, cx));
    double h10 = TerrainSceneGroundHeight(v, MeshLat(v, cy), MeshLon(v, cx + 1));
    double h01 = TerrainSceneGroundHeight(v, MeshLat(v, cy + 1), MeshLon(v, cx));
    double h11 = TerrainSceneGroundHeight(v, MeshLat(v, cy + 1), MeshLon(v, cx + 1));
    if (a + b <= 1) return h00 + a * (h10 - h00) + b * (h01 - h00);
    return h11 + (1 - a) * (h01 - h11) + (1 - b) * (h10 - h11);
}

// Edge of the mesh cell around a point, degrees of latitude-equivalent arc.
static double CellDegrees(const IsobarTerrainView *v, double lat, double lon) {
    double N = v->n0 + v->nOuter;
    double iy = fabs(MeshIndex(v, (lat - v->latC) / v->sLat)), ix = fabs(MeshIndex(v, Wrap180(lon - v->lonC) / v->sLon));
    if (iy >= N || ix >= N) return v->radiusDeg;
    double cy = floor(iy), cx = floor(ix);
    double dy = (MeshOffset(v, cy + 1) - MeshOffset(v, cy)) * v->sLat;
    double dx = (MeshOffset(v, cx + 1) - MeshOffset(v, cx)) * v->sLon * fmax(cos(lat * kDegree), 0.01);
    return fmin(dy, dx);
}

// ---- One camera's view ---------------------------------------------------

static BOOL ComputeView(IsobarCamera cam, IsobarTerrainScene *scene, IsobarTerrainView *v) {
    memset(v, 0, sizeof *v);
    if (!(cam.pitch > 1e-7) || !isfinite(cam.centreLat) || fabs(cam.centreLat) > 85) return NO;
    IsobarTiltBasis b0;
    if (!IsobarTiltBasisMake(cam, 1.0, 0, &b0)) return NO;
    double halfH = b0.vh * 0.5 / b0.radius, halfDeg = halfH / kDegree;
    v->halfH = halfH;
    v->relief = TerrainReliefFactor(2 * halfH * kEarthM / 1000.0);
    if (!(v->relief >= 0.05)) return NO;
    v->n0 = kTerrainMeshInner;
    v->nOuter = kTerrainMeshOuter;
    v->sLat = exp2(floor(log2(halfDeg / 40.0)));
    v->latC = Clamp(round(cam.centreLat / v->sLat) * v->sLat, -89, 89);
    double c = fmax(cos(v->latC * kDegree), 1.0 / 64);
    v->sLon = v->sLat * exp2(ceil(log2(1.0 / c) - 1e-9));
    v->lonC = round(Wrap180(cam.centreLon) / v->sLon) * v->sLon;
    v->near = GridOf(scene.near);
    v->far = GridOf(scene.far);
    v->nearTexture = (__bridge void *)scene.near.texture;
    v->farTexture = (__bridge void *)scene.far.texture;
    v->maxM = scene ? scene.maxHeightM : 9000;
    v->ratio = 1;
    v->active = 1;
    // Orbit focus: the mean ground across the middle of the view, raised if
    // needed so the eye stays a quarter of its height above the ground below it.
    double sum = 0, cosC = fmax(cos(cam.centreLat * kDegree), 0.05);
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++)
        sum += TerrainSceneGroundHeight(v, cam.centreLat + j * 0.25 * halfDeg, cam.centreLon + i * 0.25 * halfDeg / cosC);
    double focus = sum / 25;
    double eye[3] = {0, b0.eyeY, b0.eyeZ}, eyeLat = 0, eyeDlon = 0, eyeAlt = 0;
    IsobarTiltGeo(&b0, eye, &eyeLat, &eyeDlon, &eyeAlt);
    double under = 0, cosE = fmax(cos(eyeLat * kDegree), 0.05);
    for (int i = 0; i < 5; i++) {
        double dy = i == 1 ? 1 : i == 2 ? -1 : 0, dx = i == 3 ? 1 : i == 4 ? -1 : 0;
        under = fmax(under, TerrainSceneGroundHeight(v, eyeLat + dy * 0.2 * halfDeg, cam.centreLon + eyeDlon + dx * 0.2 * halfDeg / cosE));
    }
    double need = (under * v->relief + 0.25 * eyeAlt - eyeAlt) / v->relief;
    v->focusM = fmax(focus, need);
    // Mesh reach: the eye's horizon plus how far the highest relief shows
    // beyond it, plus the eye's own offset from the focus.
    double re = b0.re, k = b0.k;
    double a = eyeAlt / kEarthM + v->focusM * v->relief / kEarthM;
    double horizon = acos(re / (re + fmax(a, 0))) / k;
    double beyond = acos(1.0 / (1.0 + v->maxM * v->relief / kEarthM));
    double offset = hypot((eyeLat - cam.centreLat) * kDegree, eyeDlon * kDegree * cosC);
    double reach = (horizon + beyond + offset) * 1.05 + 2.0 * halfH * fmax(1.0, b0.vw / b0.vh);
    v->radiusDeg = fmin(80.0, reach / kDegree);
    double cells = v->radiusDeg / v->sLat, inner = v->n0, outer = v->nOuter;
    if (cells > inner + outer) {
        double lo = 1.0 + 1e-9, hi = 4.0;
        for (int i = 0; i < 60; i++) {
            double r = 0.5 * (lo + hi);
            double total = inner + r * (pow(r, outer) - 1) / (r - 1);
            if (total < cells) lo = r; else hi = r;
        }
        v->ratio = hi;
    }
    return YES;
}

BOOL TerrainSceneResolve(IsobarCamera cam, IsobarTerrainView *v) {
    IsobarTerrainScene *scene = SceneForToken(cam.terrain);
    if (!scene || (!scene.near && !scene.far)) { if (v) memset(v, 0, sizeof *v); return NO; }
    IsobarTerrainView view;
    BOOL ok = ComputeView(cam, scene, &view);
    if (v) *v = view;
    return ok;
}

NSString *TerrainReliefLabel(IsobarCamera camera) {
    IsobarTerrainView v;
    if (!IsobarCameraTerrain(camera, &v)) return nil;
    double r = round(v.relief * 10) / 10;
    NSString *n = fabs(r - round(r)) < 1e-9 ? [NSString stringWithFormat:@"%.0f", r] : [NSString stringWithFormat:@"%.1f", r];
    return [@"relief ×" stringByAppendingString:n];
}

// ---- GPU depth probes ------------------------------------------------------
// The renderer publishes the drawn mesh's view depth for a camera. Overlay
// occlusion and picking read it; any other camera falls back to the march.

@interface IsobarTerrainProbe : NSObject {
@public
    IsobarCamera camera;
    int width, height;
    id<MTLBuffer> buffer;
    id<MTLCommandBuffer> pending;
}
@end
@implementation IsobarTerrainProbe
// Rows of view depth once the GPU has written them; NULL if it failed.
- (const float *)range {
    id<MTLCommandBuffer> work = pending;
    if (work && work.status < MTLCommandBufferStatusCompleted) [work waitUntilCompleted];
    if (work && work.status != MTLCommandBufferStatusCompleted) return NULL;
    return buffer.contents;
}
@end

static IsobarTerrainProbe *__strong gProbes[4];
static unsigned gProbeNext;

static void ProbePublish(IsobarCamera camera, int width, int height, void *buffer, void *pending) {
    id<MTLBuffer> rows = (__bridge id<MTLBuffer>)buffer;
    if (width < 2 || height < 2 || rows.length < (NSUInteger)width * height * sizeof(float)) return;
    IsobarTerrainProbe *probe = [IsobarTerrainProbe new];
    probe->camera = camera;
    probe->width = width;
    probe->height = height;
    probe->buffer = rows;
    probe->pending = (__bridge id<MTLCommandBuffer>)pending;
    os_unfair_lock_lock(&gLock);
    IsobarTerrainProbe *retired = gProbes[gProbeNext % 4];
    gProbes[gProbeNext++ % 4] = probe;
    os_unfair_lock_unlock(&gLock);
    if (retired) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ (void)retired; });
}

// Same view, any pixel scale: overlays draw in points, the renderer in pixels.
static IsobarTerrainProbe *ProbeFor(IsobarCamera c) {
    IsobarTerrainProbe *found = nil;
    os_unfair_lock_lock(&gLock);
    for (unsigned i = 0; i < 4 && !found; i++) {
        IsobarTerrainProbe *p = gProbes[i];
        if (!p) continue;
        IsobarCamera q = p->camera;
        if (q.terrain == c.terrain && q.centreLat == c.centreLat && q.centreLon == c.centreLon && q.zoom == c.zoom
            && q.pitch == c.pitch && q.bearing == c.bearing && q.globe == c.globe
            && fabs(q.viewportW * c.viewportH - q.viewportH * c.viewportW) <= 1e-9 * q.viewportW * c.viewportH)
            found = p;
    }
    os_unfair_lock_unlock(&gLock);
    return found;
}

// View depth of the nearest (or farthest) drawn surface around a pixel.
static double ProbeRange(IsobarTerrainProbe *p, IsobarCamera c, double x, double y, BOOL farthest) {
    const float *r = [p range];
    if (!r) return NAN;
    double sx = x * p->width / c.viewportW - 0.5, sy = y * p->height / c.viewportH - 0.5;
    int cx = (int)floor(sx), cy = (int)floor(sy);
    double best = farthest ? -INFINITY : INFINITY;
    for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
        int px = cx + i, py = cy + j;
        if (px < 0 || py < 0 || px >= p->width || py >= p->height) continue;
        double v = r[py * p->width + px];
        best = farthest ? fmax(best, v) : fmin(best, v);
    }
    return best;
}

// ---- Rays against the displayed surface -----------------------------------

// A point is hidden when the straight path to the eye passes below the
// displayed surface. Steps follow the local mesh cell; the march ends once
// the path is climbing above the highest terrain in the scene.
static BOOL Occluded(IsobarCamera camera, const IsobarTiltBasis *b, const IsobarTerrainView *v, const double p[3],
    double x, double y, double depth) {
    IsobarTerrainProbe *probe = ProbeFor(camera);
    if (probe) {
        // Hidden only when nearer surface covers the whole neighbourhood.
        double behind = ProbeRange(probe, camera, x, y, YES);
        if (!isnan(behind)) return isfinite(behind) && depth > behind * 1.003;
    }
    double e[3] = {0, b->eyeY, b->eyeZ}, seg[3] = {e[0] - p[0], e[1] - p[1], e[2] - p[2]};
    double len = sqrt(seg[0] * seg[0] + seg[1] * seg[1] + seg[2] * seg[2]);
    if (!(len > 0)) return NO;
    double lat = 0, dlon = 0, h = 0;
    IsobarTiltGeo(b, p, &lat, &dlon, &h);
    double cell = CellDegrees(v, lat, b->centreLon + dlon) * kDegree;
    double t = fmin(0.5, 1.5 * cell / len), previous = INFINITY;
    for (int i = 0; i < 2000 && t < 1; i++) {
        double q[3] = {p[0] + seg[0] * t, p[1] + seg[1] * t, p[2] + seg[2] * t};
        IsobarTiltGeo(b, q, &lat, &dlon, &h);
        double lon = b->centreLon + dlon;
        double local = CellDegrees(v, lat, lon) * kDegree;
        // A chord sags below its sphere; allow that plus a few metres.
        double tolerance = 3.0 + local * local / 8.0 * kEarthM / b->relief;
        if (h < TerrainSceneDisplayedHeight(v, lat, lon) - tolerance) return YES;
        if (h > v->maxM + tolerance && h > previous) return NO;
        previous = h;
        t += 0.35 * local / len;
    }
    return NO;
}

static BOOL SphereRoots(const double e[3], const double d[3], double re, double radius, double *t0, double *t1) {
    double oc[3] = {e[0], e[1], e[2] + re};
    double bq = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
    double cq = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - radius * radius;
    double disc = bq * bq - cq;
    if (disc < 0) return NO;
    double root = sqrt(disc);
    *t0 = -bq - root; *t1 = -bq + root;
    return YES;
}

// First crossing of the pixel's ray with the displayed surface, refined by
// bisection and accepted only if it reprojects to the same pixel.
static BOOL March(const IsobarTiltBasis *b, const IsobarTerrainView *v, const double e[3], const double d[3],
    double start, double end, double x, double y, double *outLat, double *outLon);

static BOOL Unproject(IsobarCamera camera, const IsobarTiltBasis *b, const IsobarTerrainView *v, double x, double y,
    double *outLat, double *outLon) {
    double e[3], d[3];
    IsobarTiltRay(b, x, y, e, d);
    double top = b->re + (v->maxM * b->relief + 50.0) / kEarthM, a0, a1, s0, s1;
    if (!SphereRoots(e, d, b->re, top, &a0, &a1) || a1 <= 0) return NO;
    double start = fmax(0, a0), end = a1;
    BOOL sea = SphereRoots(e, d, b->re, b->re, &s0, &s1) && s1 > 0;
    if (sea) end = fmax(start, s0 > 0 ? s0 : 0);
    IsobarTerrainProbe *probe = ProbeFor(camera);
    if (probe) {
        // Start just short of the nearest drawn surface around this pixel.
        double nearest = ProbeRange(probe, camera, x, y, NO), farthest = ProbeRange(probe, camera, x, y, YES);
        double along = d[1] * b->sn - d[2] * b->cn;
        if (isfinite(nearest) && along > 1e-9) {
            double cell = v->sLat * kDegree;
            double t0 = fmax(start, nearest / along * 0.98 - 2 * cell);
            double t1 = isfinite(farthest) ? fmin(end, farthest / along * 1.005 + cell) : end;
            if (t1 > t0 && March(b, v, e, d, t0, t1, x, y, outLat, outLon)) return YES;
        }
    }
    return March(b, v, e, d, start, end, x, y, outLat, outLon);
}

static BOOL March(const IsobarTiltBasis *b, const IsobarTerrainView *v, const double e[3], const double d[3],
    double start, double end, double x, double y, double *outLat, double *outLon) {
    double lat = 0, dlon = 0, h = 0;
    double t = start, previous = start;
    BOOL hit = NO;
    for (int i = 0; i < 20000; i++) {
        double q[3] = {e[0] + d[0] * t, e[1] + d[1] * t, e[2] + d[2] * t};
        IsobarTiltGeo(b, q, &lat, &dlon, &h);
        double lon = b->centreLon + dlon;
        if (h - TerrainSceneDisplayedHeight(v, lat, lon) <= 0) { hit = YES; break; }
        if (t >= end) break;
        previous = t;
        t = fmin(end, t + 0.25 * CellDegrees(v, lat, lon) * kDegree);
    }
    if (!hit) return NO;
    double lo = previous, hi = t;
    if (hi > lo) {
        for (int i = 0; i < 60; i++) {
            double mid = 0.5 * (lo + hi);
            double q[3] = {e[0] + d[0] * mid, e[1] + d[1] * mid, e[2] + d[2] * mid};
            IsobarTiltGeo(b, q, &lat, &dlon, &h);
            if (h - TerrainSceneDisplayedHeight(v, lat, b->centreLon + dlon) <= 0) hi = mid; else lo = mid;
        }
    }
    double q[3] = {e[0] + d[0] * hi, e[1] + d[1] * hi, e[2] + d[2] * hi};
    IsobarTiltGeo(b, q, &lat, &dlon, &h);
    double lon = b->centreLon + dlon;
    // Verification: the surface point itself must land on this pixel.
    double p[3], px = 0, py = 0, depth = 0;
    IsobarTiltPoint(b, lat, dlon, TerrainSceneDisplayedHeight(v, lat, lon), p);
    if (!IsobarTiltScreen(b, p, &px, &py, &depth) || depth <= 0 || hypot(px - x, py - y) > 0.5) return NO;
    *outLat = lat;
    *outLon = lon;
    return YES;
}

// ---- Hooks ------------------------------------------------------------------

static BOOL HookResolve(IsobarCamera camera, IsobarTerrainView *view) { return TerrainSceneResolve(camera, view); }
static double HookHeight(const IsobarTerrainView *view, double lat, double lon) { return TerrainSceneDisplayedHeight(view, lat, lon); }
static double HookCell(const IsobarTerrainView *view, double lat, double lon) { return CellDegrees(view, lat, lon); }

static const IsobarTerrainHooks kHooks = {HookResolve, HookHeight, Occluded, Unproject, HookCell, Epoch, ProbePublish};

__attribute__((constructor)) static void InstallTerrainHooks(void) {
    IsobarTerrainHooksInstalled = &kHooks;
}

// ---- Controller -------------------------------------------------------------

@implementation IsobarTerrainSceneController {
    IsobarTerrainMap *_nearMap, *_farMap;
    IsobarTerrainMosaic *_lastNear, *_lastFar;
    IsobarTerrainScene *_scene;
}
- (instancetype)initWithDevice:(id<MTLDevice>)device {
    if (!(self = [super init])) return nil;
    _nearMap = [[IsobarTerrainMap alloc] initWithDevice:device];
    _farMap = [[IsobarTerrainMap alloc] initWithDevice:device];
    return self;
}
- (IsobarTerrainScene *)scene { return _scene; }
- (uint64_t)updateCamera:(IsobarCamera)camera {
    camera.terrain = 0;
    IsobarTerrainView v;
    if (!ComputeView(camera, _scene, &v)) return 0;
    double reach = 2 * v.n0 * v.sLat, reachLon = 2 * v.n0 * v.sLon;
    [_nearMap updateBox:(TerrainBox){v.lonC - reachLon, v.latC - reach, v.lonC + reachLon, v.latC + reach} density:2.0 / v.sLat];
    double c = fmax(cos(v.latC * kDegree), 0.02);
    double farLon = fmin(180.0, v.radiusDeg / c);
    [_farMap updateBox:(TerrainBox){v.lonC - farLon, v.latC - v.radiusDeg, v.lonC + farLon, v.latC + v.radiusDeg}
        density:1600.0 / (2.0 * v.radiusDeg)];
    IsobarTerrainMosaic *near = _nearMap.mosaic, *far = _farMap.mosaic;
    if ((near != _lastNear || far != _lastFar) && (near.covered || far.covered)) {
        _lastNear = near;
        _lastFar = far;
        _scene = [[IsobarTerrainScene alloc] initWithNear:near far:far];
        [_scene registerScene];
    }
    return _scene.token;
}
- (BOOL)waitUntilSettled:(NSTimeInterval)timeout {
    BOOL a = [_nearMap waitUntilSettled:timeout], b = [_farMap waitUntilSettled:timeout];
    return a && b;
}
- (void)cancel { [_nearMap cancel]; [_farMap cancel]; }
@end
