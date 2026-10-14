#import "starlink.h"
#import <math.h>

// ---- SGP4, near earth (Vallado, "Revisiting Spacetrack Report #3", 2006) ----
static const double kRe = 6378.135, kMu = 398600.8, kJ2 = 0.001082616, kJ3 = -0.00000253881,
    kJ4 = -0.00000165597, kX2o3 = 2.0 / 3.0, kTwoPi = 2 * M_PI, kDeg = M_PI / 180;
static double Xke(void) { return 60.0 / sqrt(kRe * kRe * kRe / kMu); }

static double JulianDay(int year, int month, int day) {
    return 367.0 * year - floor(7 * (year + floor((month + 9) / 12.0)) * 0.25) + floor(275 * month / 9.0) + day + 1721013.5;
}

static BOOL ChecksumOK(NSString *line) {
    if (line.length < 69) return NO;
    int sum = 0;
    for (NSUInteger i = 0; i < 68; i++) {
        unichar c = [line characterAtIndex:i];
        if (c >= '0' && c <= '9') sum += c - '0';
        else if (c == '-') sum += 1;
    }
    unichar check = [line characterAtIndex:68];
    return check >= '0' && check <= '9' && sum % 10 == check - '0';
}

static double Field(NSString *line, NSUInteger from, NSUInteger length) {
    NSString *s = [[line substringWithRange:NSMakeRange(from, length)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    return s.length ? s.doubleValue : NAN;
}

// "-11606-4" → -0.11606e-4: implied leading decimal point and signed exponent.
static double Implied(NSString *line, NSUInteger from) {
    NSString *s = [line substringWithRange:NSMakeRange(from, 8)];
    double sign = [s characterAtIndex:0] == '-' ? -1 : 1;
    NSString *mantissa = [[s substringWithRange:NSMakeRange(1, 5)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    NSString *exponent = [[s substringWithRange:NSMakeRange(6, 2)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if (!mantissa.length) return 0;
    return sign * mantissa.doubleValue * 1e-5 * pow(10, exponent.doubleValue);
}

BOOL StarlinkOrbitFromTLE(NSString *line1, NSString *line2, StarlinkOrbit *o) {
    line1 = [line1 stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    line2 = [line2 stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (![line1 hasPrefix:@"1 "] || ![line2 hasPrefix:@"2 "] || !ChecksumOK(line1) || !ChecksumOK(line2)) return NO;
    memset(o, 0, sizeof *o);
    double yy = Field(line1, 18, 2), days = Field(line1, 20, 12);
    if (!isfinite(yy) || !isfinite(days)) return NO;
    int year = yy < 57 ? 2000 + (int)yy : 1900 + (int)yy;
    o->epochJD = JulianDay(year, 1, 1) + days - 1;
    o->bstar = Implied(line1, 53);
    o->inclo = Field(line2, 8, 8) * kDeg;
    o->nodeo = Field(line2, 17, 8) * kDeg;
    o->ecco = [@"0." stringByAppendingString:[line2 substringWithRange:NSMakeRange(26, 7)]].doubleValue;
    o->argpo = Field(line2, 34, 8) * kDeg;
    o->mo = Field(line2, 43, 8) * kDeg;
    double revs = Field(line2, 52, 11);
    if (!isfinite(o->inclo) || !isfinite(o->mo) || !isfinite(revs) || revs <= 0) return NO;
    o->noKozai = revs * kTwoPi / 1440.0;
    if (kTwoPi / o->noKozai >= 225) return NO; // deep space

    double xke = Xke(), j3oj2 = kJ3 / kJ2;
    double eccsq = o->ecco * o->ecco, omeosq = 1 - eccsq, rteosq = sqrt(omeosq);
    double cosio = cos(o->inclo), cosio2 = cosio * cosio;
    double ak = pow(xke / o->noKozai, kX2o3);
    double d1 = 0.75 * kJ2 * (3 * cosio2 - 1) / (rteosq * omeosq);
    double del = d1 / (ak * ak);
    double adel = ak * (1 - del * del - del * (1.0 / 3.0 + 134 * del * del / 81.0));
    del = d1 / (adel * adel);
    o->noUnkozai = o->noKozai / (1 + del);
    double ao = pow(xke / o->noUnkozai, kX2o3);
    double sinio = sin(o->inclo), po = ao * omeosq, con42 = 1 - 5 * cosio2;
    o->con41 = -con42 - cosio2 - cosio2;
    double posq = po * po, rp = ao * (1 - o->ecco);

    double ss = 78 / kRe + 1, qzms2t = pow((120 - 78) / kRe, 4);
    o->isimp = rp < 220 / kRe + 1;
    double sfour = ss, qzms24 = qzms2t, perige = (rp - 1) * kRe;
    if (perige < 156) {
        sfour = perige < 98 ? 20 : perige - 78;
        qzms24 = pow((120 - sfour) / kRe, 4);
        sfour = sfour / kRe + 1;
    }
    double pinvsq = 1 / posq, tsi = 1 / (ao - sfour);
    o->eta = ao * o->ecco * tsi;
    double etasq = o->eta * o->eta, eeta = o->ecco * o->eta, psisq = fabs(1 - etasq);
    double coef = qzms24 * pow(tsi, 4), coef1 = coef / pow(psisq, 3.5);
    double cc2 = coef1 * o->noUnkozai * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) +
        0.375 * kJ2 * tsi / psisq * o->con41 * (8 + 3 * etasq * (8 + etasq)));
    o->cc1 = o->bstar * cc2;
    double cc3 = o->ecco > 1e-4 ? -2 * coef * tsi * j3oj2 * o->noUnkozai * sinio / o->ecco : 0;
    o->x1mth2 = 1 - cosio2;
    o->cc4 = 2 * o->noUnkozai * coef1 * ao * omeosq * (o->eta * (2 + 0.5 * etasq) + o->ecco * (0.5 + 2 * etasq) -
        kJ2 * tsi / (ao * psisq) * (-3 * o->con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) +
        0.75 * o->x1mth2 * (2 * etasq - eeta * (1 + etasq)) * cos(2 * o->argpo)));
    o->cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
    double cosio4 = cosio2 * cosio2;
    double temp1 = 1.5 * kJ2 * pinvsq * o->noUnkozai, temp2 = 0.5 * temp1 * kJ2 * pinvsq,
        temp3 = -0.46875 * kJ4 * pinvsq * pinvsq * o->noUnkozai;
    o->mdot = o->noUnkozai + 0.5 * temp1 * rteosq * o->con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4);
    o->argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) + temp3 * (3 - 36 * cosio2 + 49 * cosio4);
    double xhdot1 = -temp1 * cosio;
    o->nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio;
    o->omgcof = o->bstar * cc3 * cos(o->argpo);
    o->xmcof = o->ecco > 1e-4 ? -kX2o3 * coef * o->bstar / eeta : 0;
    o->nodecf = 3.5 * omeosq * xhdot1 * o->cc1;
    o->t2cof = 1.5 * o->cc1;
    double denom = fabs(cosio + 1) > 1.5e-12 ? 1 + cosio : 1.5e-12;
    o->xlcof = -0.25 * j3oj2 * sinio * (3 + 5 * cosio) / denom;
    o->aycof = -0.5 * j3oj2 * sinio;
    o->delmo = pow(1 + o->eta * cos(o->mo), 3);
    o->sinmao = sin(o->mo);
    o->x7thm1 = 7 * cosio2 - 1;
    if (!o->isimp) {
        double cc1sq = o->cc1 * o->cc1;
        o->d2 = 4 * ao * tsi * cc1sq;
        double temp = o->d2 * tsi * o->cc1 / 3;
        o->d3 = (17 * ao + sfour) * temp;
        o->d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * o->cc1;
        o->t3cof = o->d2 + 2 * cc1sq;
        o->t4cof = 0.25 * (3 * o->d3 + o->cc1 * (12 * o->d2 + 10 * cc1sq));
        o->t5cof = 0.2 * (3 * o->d4 + 12 * o->cc1 * o->d3 + 6 * o->d2 * o->d2 + 15 * cc1sq * (2 * o->d2 + cc1sq));
    }
    return YES;
}

BOOL StarlinkPropagate(const StarlinkOrbit *o, double t, double r[3], double v[3]) {
    double xke = Xke(), vkmpersec = kRe * xke / 60;
    double xmdf = o->mo + o->mdot * t, argpdf = o->argpo + o->argpdot * t, nodedf = o->nodeo + o->nodedot * t;
    double argpm = argpdf, mm = xmdf, t2 = t * t, nodem = nodedf + o->nodecf * t2;
    double tempa = 1 - o->cc1 * t, tempe = o->bstar * o->cc4 * t, templ = o->t2cof * t2;
    if (!o->isimp) {
        double delomg = o->omgcof * t, delmtemp = 1 + o->eta * cos(xmdf);
        double delm = o->xmcof * (delmtemp * delmtemp * delmtemp - o->delmo);
        double temp = delomg + delm;
        mm = xmdf + temp;
        argpm = argpdf - temp;
        double t3 = t2 * t, t4 = t3 * t;
        tempa = tempa - o->d2 * t2 - o->d3 * t3 - o->d4 * t4;
        tempe = tempe + o->bstar * o->cc5 * (sin(mm) - o->sinmao);
        templ = templ + o->t3cof * t3 + t4 * (o->t4cof + t * o->t5cof);
    }
    double nm = o->noUnkozai, em = o->ecco, inclm = o->inclo;
    if (nm <= 0) return NO;
    double am = pow(xke / nm, kX2o3) * tempa * tempa;
    nm = xke / pow(am, 1.5);
    em -= tempe;
    if (em >= 1 || em < -0.001) return NO;
    if (em < 1e-6) em = 1e-6;
    mm += o->noUnkozai * templ;
    double xlm = mm + argpm + nodem;
    nodem = fmod(nodem, kTwoPi); argpm = fmod(argpm, kTwoPi); xlm = fmod(xlm, kTwoPi);
    mm = fmod(xlm - argpm - nodem, kTwoPi);
    double sinip = sin(inclm), cosip = cos(inclm);
    double axnl = em * cos(argpm), temp = 1 / (am * (1 - em * em));
    double aynl = em * sin(argpm) + temp * o->aycof;
    double xl = mm + argpm + nodem + temp * o->xlcof * axnl;
    double u = fmod(xl - nodem, kTwoPi), eo1 = u, tem5 = 9999.9, sineo1 = 0, coseo1 = 0;
    for (int k = 0; fabs(tem5) >= 1e-12 && k < 10; k++) {
        sineo1 = sin(eo1); coseo1 = cos(eo1);
        tem5 = 1 - coseo1 * axnl - sineo1 * aynl;
        tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
        if (fabs(tem5) >= 0.95) tem5 = tem5 > 0 ? 0.95 : -0.95;
        eo1 += tem5;
    }
    double ecose = axnl * coseo1 + aynl * sineo1, esine = axnl * sineo1 - aynl * coseo1;
    double el2 = axnl * axnl + aynl * aynl, pl = am * (1 - el2);
    if (pl < 0) return NO;
    double rl = am * (1 - ecose), rdotl = sqrt(am) * esine / rl, rvdotl = sqrt(pl) / rl, betal = sqrt(1 - el2);
    temp = esine / (1 + betal);
    double sinu = am / rl * (sineo1 - aynl - axnl * temp), cosu = am / rl * (coseo1 - axnl + aynl * temp);
    double su = atan2(sinu, cosu), sin2u = (cosu + cosu) * sinu, cos2u = 1 - 2 * sinu * sinu;
    temp = 1 / pl;
    double temp1 = 0.5 * kJ2 * temp, temp2 = temp1 * temp;
    double mrt = rl * (1 - 1.5 * temp2 * betal * o->con41) + 0.5 * temp1 * o->x1mth2 * cos2u;
    su -= 0.25 * temp2 * o->x7thm1 * sin2u;
    double xnode = nodem + 1.5 * temp2 * cosip * sin2u, xinc = inclm + 1.5 * temp2 * cosip * sinip * cos2u;
    double mvt = rdotl - nm * temp1 * o->x1mth2 * sin2u / xke;
    double rvdot = rvdotl + nm * temp1 * (o->x1mth2 * cos2u + 1.5 * o->con41) / xke;
    double sinsu = sin(su), cossu = cos(su), snod = sin(xnode), cnod = cos(xnode), sini = sin(xinc), cosi = cos(xinc);
    double xmx = -snod * cosi, xmy = cnod * cosi;
    double ux = xmx * sinsu + cnod * cossu, uy = xmy * sinsu + snod * cossu, uz = sini * sinsu;
    double vx = xmx * cossu - cnod * sinsu, vy = xmy * cossu - snod * sinsu, vz = sini * cossu;
    r[0] = mrt * ux * kRe; r[1] = mrt * uy * kRe; r[2] = mrt * uz * kRe;
    v[0] = (mvt * ux + rvdot * vx) * vkmpersec; v[1] = (mvt * uy + rvdot * vy) * vkmpersec; v[2] = (mvt * uz + rvdot * vz) * vkmpersec;
    return mrt >= 1;
}

double StarlinkJulianDate(NSDate *date) { return date.timeIntervalSince1970 / 86400.0 + 2440587.5; }

double StarlinkGMST(double jd) {
    double t = (jd - 2451545.0) / 36525.0;
    double s = -6.2e-6 * t * t * t + 0.093104 * t * t + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
    double g = fmod(s * kDeg / 240.0, kTwoPi);
    return g < 0 ? g + kTwoPi : g;
}

BOOL StarlinkLookAt(const StarlinkOrbit *orbit, double jd, double lat, double lon, double h, StarlinkLook *look) {
    double r[3], v[3];
    if (!StarlinkPropagate(orbit, (jd - orbit->epochJD) * 1440.0, r, v)) return NO;
    double g = StarlinkGMST(jd), c = cos(g), s = sin(g);
    double x = c * r[0] + s * r[1], y = -s * r[0] + c * r[1], z = r[2];
    const double a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f);
    double la = lat * kDeg, lo = lon * kDeg, sla = sin(la), cla = cos(la), slo = sin(lo), clo = cos(lo);
    double N = a / sqrt(1 - e2 * sla * sla);
    double dx = x - (N + h) * cla * clo, dy = y - (N + h) * cla * slo, dz = z - (N * (1 - e2) + h) * sla;
    double east = -slo * dx + clo * dy, north = -sla * clo * dx - sla * slo * dy + cla * dz,
        up = cla * clo * dx + cla * slo * dy + sla * dz;
    double range = sqrt(dx * dx + dy * dy + dz * dz);
    look->rangeKm = range;
    look->elevation = asin(up / range) / kDeg;
    look->azimuth = fmod(atan2(east, north) / kDeg + 360, 360);
    double p = sqrt(x * x + y * y);
    look->latitude = atan2(z, p * (1 - e2)) / kDeg;
    look->longitude = atan2(y, x) / kDeg;
    look->altitudeKm = sqrt(x * x + y * y + z * z) - 6371.0;
    return YES;
}

// ---- Catalogue -----------------------------------------------------------
@implementation StarlinkCatalog {
    NSData *_orbits;
    NSArray<NSString *> *_names;
    NSDictionary<NSString *, NSNumber *> *_index;
    NSDate *_newest;
}
+ (instancetype)catalogWithText:(NSString *)text {
    NSMutableArray *lines = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet])
        if ([line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length) [lines addObject:line];
    NSMutableData *orbits = [NSMutableData data];
    NSMutableArray *names = [NSMutableArray array];
    NSMutableDictionary *index = [NSMutableDictionary dictionary];
    double newest = 0;
    for (NSUInteger i = 0; i + 2 < lines.count; ) {
        NSString *name = [lines[i] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        StarlinkOrbit orbit;
        if (![name hasPrefix:@"1 "] && [lines[i + 1] hasPrefix:@"1 "] && StarlinkOrbitFromTLE(lines[i + 1], lines[i + 2], &orbit)) {
            [orbits appendBytes:&orbit length:sizeof orbit];
            index[name] = @(names.count);
            [names addObject:name];
            newest = MAX(newest, orbit.epochJD);
            i += 3;
        } else i += 1;
    }
    if (!names.count) return nil;
    StarlinkCatalog *catalog = [StarlinkCatalog new];
    catalog->_orbits = orbits;
    catalog->_names = names;
    catalog->_index = index;
    catalog->_newest = [NSDate dateWithTimeIntervalSince1970:(newest - 2440587.5) * 86400.0];
    return catalog;
}
- (NSUInteger)count { return _names.count; }
- (NSArray<NSString *> *)names { return _names; }
- (NSDate *)newestEpoch { return _newest; }
- (const StarlinkOrbit *)orbitAtIndex:(NSUInteger)index { return (const StarlinkOrbit *)_orbits.bytes + index; }
- (NSUInteger)indexOfName:(NSString *)name { NSNumber *n = _index[name]; return n ? n.unsignedIntegerValue : NSNotFound; }
@end

NSData *StarlinkSkyAt(StarlinkCatalog *catalog, NSDate *date, double lat, double lon,
    double south, double north, double west, double east, double keepAbove) {
    NSMutableData *out = [NSMutableData data];
    double jd = StarlinkJulianDate(date);
    for (NSUInteger i = 0; i < catalog.count; i++) {
        StarlinkLook look;
        if (!StarlinkLookAt([catalog orbitAtIndex:i], jd, lat, lon, 0, &look)) continue;
        BOOL inLon = west <= east ? (look.longitude >= west && look.longitude <= east)
                                  : (look.longitude >= west || look.longitude <= east);
        BOOL inside = look.latitude >= south && look.latitude <= north && inLon;
        if (!inside && look.elevation < keepAbove) continue;
        StarlinkSkyPoint p = {(float)look.latitude, (float)look.longitude, (float)look.elevation, (float)look.azimuth,
            (float)look.altitudeKm, (float)look.rangeKm, (uint32_t)i};
        [out appendBytes:&p length:sizeof p];
    }
    return out;
}

NSString *StarlinkShortName(NSString *name) {
    return [name hasPrefix:@"STARLINK-"] ? [name substringFromIndex:9] : name;
}

// ---- Dish wire format ----------------------------------------------------
const int StarlinkRequestStatus = 1004;
const int StarlinkRequestObstructionMap = 2008;

NSData *StarlinkGRPCWebRequest(int field) {
    uint8_t message[8]; size_t n = 0;
    uint32_t key = ((uint32_t)field << 3) | 2;
    do { uint8_t b = key & 0x7f; key >>= 7; message[n++] = b | (key ? 0x80 : 0); } while (key);
    message[n++] = 0;
    NSMutableData *body = [NSMutableData dataWithLength:5];
    uint8_t *head = body.mutableBytes;
    head[1] = (n >> 24) & 0xff; head[2] = (n >> 16) & 0xff; head[3] = (n >> 8) & 0xff; head[4] = n & 0xff;
    [body appendBytes:message length:n];
    return body;
}

NSData *StarlinkGRPCWebPayload(NSData *body) {
    const uint8_t *b = body.bytes;
    NSUInteger i = 0, n = body.length;
    while (i + 5 <= n) {
        uint32_t len = ((uint32_t)b[i + 1] << 24) | ((uint32_t)b[i + 2] << 16) | ((uint32_t)b[i + 3] << 8) | b[i + 4];
        if (i + 5 + len > n) return nil;
        if (!(b[i] & 0x80)) return [body subdataWithRange:NSMakeRange(i + 5, len)];
        i += 5 + len;
    }
    return nil;
}

typedef struct { const uint8_t *p, *end; } PB;
static BOOL Varint(PB *pb, uint64_t *out) {
    uint64_t r = 0; int s = 0;
    while (pb->p < pb->end && s < 64) {
        uint8_t c = *pb->p++;
        r |= (uint64_t)(c & 0x7f) << s; s += 7;
        if (c < 0x80) { *out = r; return YES; }
    }
    return NO;
}
// Calls `each(field, wire, varint, bytes, length)` per field; NO if malformed.
static BOOL Fields(const uint8_t *bytes, NSUInteger length,
    void (^each)(uint32_t field, int wire, uint64_t value, const uint8_t *data, NSUInteger size)) {
    PB pb = {bytes, bytes + length};
    while (pb.p < pb.end) {
        uint64_t key, value = 0;
        if (!Varint(&pb, &key)) return NO;
        int wire = key & 7; uint32_t field = (uint32_t)(key >> 3);
        const uint8_t *data = pb.p; NSUInteger size = 0;
        if (wire == 0) { if (!Varint(&pb, &value)) return NO; }
        else if (wire == 1) { size = 8; }
        else if (wire == 5) { size = 4; }
        else if (wire == 2) { if (!Varint(&pb, &value) || value > (uint64_t)(pb.end - pb.p)) return NO; data = pb.p; size = (NSUInteger)value; }
        else return NO;
        if (wire != 0) { if ((NSUInteger)(pb.end - data) < size) return NO; pb.p = data + size; }
        each(field, wire, value, data, size);
    }
    return YES;
}
static float F32(const uint8_t *d) { float f; memcpy(&f, d, 4); return f; }
static NSString *Text(const uint8_t *d, NSUInteger n) { return [[NSString alloc] initWithBytes:d length:n encoding:NSUTF8StringEncoding] ?: @""; }

// The response body for one Request field: Response.<field>.
static NSData *ResponseField(NSData *payload, uint32_t want) {
    __block NSData *found = nil;
    Fields(payload.bytes, payload.length, ^(uint32_t field, int wire, uint64_t value, const uint8_t *data, NSUInteger size) {
        (void)value;
        if (field == want && wire == 2) found = [NSData dataWithBytes:data length:size];
    });
    return found;
}

NSDictionary *StarlinkDecodeStatus(NSData *payload) {
    NSData *status = ResponseField(payload, 2004);
    if (!status) return nil;
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    void (^finite)(NSString *, float) = ^(NSString *key, float f) { if (isfinite(f)) out[key] = @(f); };
    BOOL ok = Fields(status.bytes, status.length, ^(uint32_t field, int wire, uint64_t value, const uint8_t *data, NSUInteger size) {
        (void)value;
        if (wire == 5) {
            float f = F32(data);
            switch (field) {
                case 1003: finite(@"dropRate", f); break;
                case 1007: finite(@"downBps", f); break;
                case 1008: finite(@"upBps", f); break;
                case 1009: finite(@"pingMs", f); break;
                case 1011: if (!out[@"azimuth"]) finite(@"azimuth", f); break;
                case 1012: if (!out[@"elevation"]) finite(@"elevation", f); break;
            }
        } else if (wire == 2 && field == 1) {
            Fields(data, size, ^(uint32_t f, int w, uint64_t v, const uint8_t *d, NSUInteger s) {
                (void)v;
                if (w == 2 && f == 2) out[@"hardware"] = Text(d, s);
                if (w == 2 && f == 3) out[@"software"] = Text(d, s);
            });
        } else if (wire == 2 && field == 2) {
            Fields(data, size, ^(uint32_t f, int w, uint64_t v, const uint8_t *d, NSUInteger s) {
                (void)d; (void)s;
                if (w == 0 && f == 1) out[@"uptimeS"] = @(v);
            });
        } else if (wire == 2 && field == 1027) {
            Fields(data, size, ^(uint32_t f, int w, uint64_t v, const uint8_t *d, NSUInteger s) {
                (void)v; (void)s;
                if (w != 5) return;
                if (f == 3) finite(@"tilt", F32(d));
                if (f == 4) finite(@"azimuth", F32(d));
                if (f == 5) finite(@"elevation", F32(d));
            });
        } else if (wire == 2 && field == 1049) {
            float q[4] = {NAN, 0, 0, 0};
            float *qp = q;
            Fields(data, size, ^(uint32_t f, int w, uint64_t v, const uint8_t *d, NSUInteger s) {
                (void)v; (void)s;
                if (w == 5 && f >= 1 && f <= 4) qp[f - 1] = F32(d);
            });
            double norm = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            if (isfinite(norm) && fabs(norm - 1) < 0.01) out[@"quaternion"] = @[@(q[0]), @(q[1]), @(q[2]), @(q[3])];
        }
    });
    return ok ? out : nil;
}

NSDictionary *StarlinkDecodeObstructionMap(NSData *payload) {
    NSData *map = ResponseField(payload, 2008);
    if (!map) return nil;
    __block uint64_t rows = 0, cols = 0, frame = 0;
    __block float maxTheta = NAN;
    NSMutableData *snr = [NSMutableData data];
    BOOL ok = Fields(map.bytes, map.length, ^(uint32_t field, int wire, uint64_t value, const uint8_t *data, NSUInteger size) {
        if (field == 1 && wire == 0) rows = value;
        else if (field == 2 && wire == 0) cols = value;
        else if (field == 3 && wire == 2) [snr appendBytes:data length:size - size % 4];
        else if (field == 3 && wire == 5) [snr appendBytes:data length:4];
        else if (field == 5 && wire == 5) maxTheta = F32(data);
        else if (field == 6 && wire == 0) frame = value;
    });
    if (!ok || !rows || !cols || rows > 512 || cols > 512 || snr.length != rows * cols * 4) return nil;
    return @{@"rows": @(rows), @"cols": @(cols), @"snr": snr,
             @"maxThetaDeg": @(isfinite(maxTheta) && maxTheta > 0 ? maxTheta : 80), @"frame": @(frame)};
}

BOOL StarlinkPixelToSky(double x, double y, NSInteger rows, double maxTheta, const double q[4], double *el, double *az) {
    if (rows < 3 || !isfinite(q[0])) return NO;
    double centre = (rows - 1) / 2.0, scale = maxTheta / centre * kDeg;
    // Fitted orientation: map rows run against the dish x axis, columns along y.
    double dx = -(y - centre), dy = x - centre;
    double theta = hypot(dx, dy) * scale, phi = atan2(dy, dx);
    if (theta > M_PI_2 + 0.2) return NO;
    double d[3] = {sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)};
    double w = q[0], i = q[1], j = q[2], k = q[3];
    double R[3][3] = {
        {1 - 2 * (j * j + k * k), 2 * (i * j - w * k), 2 * (i * k + w * j)},
        {2 * (i * j + w * k), 1 - 2 * (i * i + k * k), 2 * (j * k - w * i)},
        {2 * (i * k - w * j), 2 * (j * k + w * i), 1 - 2 * (i * i + j * j)}};
    double n = R[0][0] * d[0] + R[0][1] * d[1] + R[0][2] * d[2];
    double e = R[1][0] * d[0] + R[1][1] * d[1] + R[1][2] * d[2];
    double down = R[2][0] * d[0] + R[2][1] * d[1] + R[2][2] * d[2];
    *el = asin(fmax(-1, fmin(1, -down))) / kDeg;
    *az = fmod(atan2(e, n) / kDeg + 360, 360);
    return YES;
}

double StarlinkAngularSeparation(double el1, double az1, double el2, double az2) {
    double a = el1 * kDeg, b = el2 * kDeg, c = sin(a) * sin(b) + cos(a) * cos(b) * cos((az1 - az2) * kDeg);
    return acos(fmax(-1, fmin(1, c))) / kDeg;
}

NSTimeInterval StarlinkSlotStart(NSTimeInterval t) { return floor((t - 12) / 15) * 15 + 12; }

NSArray<NSDictionary *> *StarlinkChangedPixels(NSDictionary *previous, NSDictionary *current, const double q[4],
    NSTimeInterval from, NSTimeInterval to) {
    NSInteger rows = [current[@"rows"] integerValue], cols = [current[@"cols"] integerValue];
    if (rows != cols) return @[];  // the dish map is square; the geometry assumes it
    if (!previous || [previous[@"rows"] integerValue] != rows || [previous[@"cols"] integerValue] != cols) return @[];
    const float *a = [previous[@"snr"] bytes], *b = [current[@"snr"] bytes];
    double theta = [current[@"maxThetaDeg"] doubleValue];
    NSMutableArray *out = [NSMutableArray array];
    for (NSInteger k = 0; k < rows * cols; k++) {
        // Newly lit, or a brighter reading: the dish has just looked there.
        if (!(b[k] >= 0) || !(a[k] < 0 || b[k] > a[k])) continue;
        double el, az, x = k % cols, y = k / cols;
        if (!StarlinkPixelToSky(x, y, rows, theta, q, &el, &az) || el < 5) continue;
        [out addObject:@{@"x": @(x), @"y": @(y), @"el": @(el), @"az": @(az), @"from": @(from), @"to": @(to)}];
    }
    // Hundreds of changes at once is a map reset, not a satellite.
    return out.count > 40 ? @[] : out;
}

// The longest chain of pixels, each within 5 px and 10 s of the last.
static NSArray<NSDictionary *> *LongestTrack(NSArray<NSDictionary *> *pixels) {
    NSMutableArray<NSMutableArray *> *tracks = [NSMutableArray array];
    for (NSDictionary *p in [pixels sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
             return [a[@"to"] compare:b[@"to"]]; }]) {
        NSMutableArray *home = nil;
        for (NSMutableArray *t in tracks) {
            NSDictionary *l = t.lastObject;
            if ([p[@"from"] doubleValue] - [l[@"to"] doubleValue] < 10 &&
                hypot([p[@"x"] doubleValue] - [l[@"x"] doubleValue], [p[@"y"] doubleValue] - [l[@"y"] doubleValue]) <= 5) { home = t; break; }
        }
        if (home) [home addObject:p]; else [tracks addObject:[NSMutableArray arrayWithObject:p]];
    }
    NSArray *best = @[];
    for (NSArray *t in tracks) if (t.count > best.count) best = t;
    return best;
}

static int CompareDouble(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return (x > y) - (x < y); }

NSDictionary *StarlinkIdentify(StarlinkCatalog *catalog, NSArray<NSDictionary *> *pixels, double lat, double lon) {
    NSArray *track = LongestTrack(pixels);
    if (track.count < 3 || !catalog.count) return nil;
    double t0 = INFINITY, t1 = -INFINITY;
    for (NSDictionary *p in track) { t0 = MIN(t0, [p[@"from"] doubleValue]); t1 = MAX(t1, [p[@"to"] doubleValue]); }
    t0 = floor(t0); t1 = MIN(ceil(t1), t0 + 40);
    NSInteger steps = (NSInteger)(t1 - t0) + 1;
    double mid = 2440587.5 + (t0 + t1) / 2 / 86400.0;
    NSUInteger n = track.count;
    double *errors = calloc(n, sizeof(double)), best = INFINITY, second = INFINITY;
    double *els = calloc(steps, sizeof(double)), *azs = calloc(steps, sizeof(double));
    NSUInteger bestIndex = NSNotFound;
    for (NSUInteger s = 0; s < catalog.count; s++) {
        // Direct-to-cell satellites serve phones, not dishes.
        if ([catalog.names[s] hasSuffix:@"[DTC]"]) continue;
        const StarlinkOrbit *orbit = [catalog orbitAtIndex:s];
        StarlinkLook look;
        if (!StarlinkLookAt(orbit, mid, lat, lon, 0, &look) || look.elevation < 10) continue;
        BOOL ok = YES;
        for (NSInteger k = 0; k < steps && ok; k++) {
            ok = StarlinkLookAt(orbit, 2440587.5 + (t0 + k) / 86400.0, lat, lon, 0, &look);
            els[k] = look.elevation; azs[k] = look.azimuth;
        }
        if (!ok) continue;
        for (NSUInteger i = 0; i < n; i++) {
            NSDictionary *p = track[i];
            NSInteger a = MAX(0, (NSInteger)floor([p[@"from"] doubleValue] - t0)),
                b = MIN(steps - 1, (NSInteger)ceil([p[@"to"] doubleValue] - t0));
            double e = INFINITY, pe = [p[@"el"] doubleValue], pa = [p[@"az"] doubleValue];
            for (NSInteger k = a; k <= b; k++) e = MIN(e, StarlinkAngularSeparation(els[k], azs[k], pe, pa));
            errors[i] = e;
        }
        qsort(errors, n, sizeof(double), CompareDouble);
        double median = n % 2 ? errors[n / 2] : (errors[n / 2 - 1] + errors[n / 2]) / 2;
        if (median < best) { second = best; best = median; bestIndex = s; }
        else if (median < second) second = median;
    }
    free(errors); free(els); free(azs);
    if (bestIndex == NSNotFound) return nil;
    BOOL confident = best <= 3.5 && second - best >= MAX(1.5, best);
    return @{@"name": catalog.names[bestIndex], @"index": @(bestIndex), @"errorDeg": @(best),
             @"runnerUpDeg": @(second), @"slot": @(StarlinkSlotStart(t1)), @"pixels": @(n), @"confident": @(confident)};
}

// ---- HTTP over a socket --------------------------------------------------
#import <sys/socket.h>
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <arpa/inet.h>
#import <unistd.h>
#import <fcntl.h>
#import <poll.h>
#import <ctype.h>

NSData *StarlinkHTTPBody(NSData *response) {
    NSData *gap = [@"\r\n\r\n" dataUsingEncoding:NSASCIIStringEncoding];
    NSRange split = [response rangeOfData:gap options:0 range:NSMakeRange(0, response.length)];
    if (split.location == NSNotFound) return nil;
    NSString *head = [[NSString alloc] initWithData:[response subdataWithRange:NSMakeRange(0, split.location)] encoding:NSISOLatin1StringEncoding];
    NSArray *lines = [head componentsSeparatedByString:@"\r\n"];
    NSArray *first = [lines.firstObject componentsSeparatedByString:@" "];
    if (first.count < 2 || ![first[1] isEqual:@"200"]) return nil;
    BOOL chunked = NO;
    for (NSString *line in lines)
        if ([line.lowercaseString hasPrefix:@"transfer-encoding:"] && [line.lowercaseString containsString:@"chunked"]) chunked = YES;
    NSData *raw = [response subdataWithRange:NSMakeRange(NSMaxRange(split), response.length - NSMaxRange(split))];
    if (!chunked) return raw;
    NSMutableData *body = [NSMutableData data];
    const uint8_t *b = raw.bytes; NSUInteger i = 0, n = raw.length;
    while (i < n) {
        NSUInteger eol = i;
        while (eol + 1 < n && !(b[eol] == '\r' && b[eol + 1] == '\n')) eol++;
        if (eol + 1 >= n) return nil;
        if (eol - i > 16) return nil;  // a chunk size is a few hex digits
        char digits[17] = {0};
        for (NSUInteger k = i; k < eol; k++) {
            if (!isxdigit(b[k]) && b[k] != ';') return nil;
            if (b[k] == ';') break;   // chunk extensions are ignored
            digits[k - i] = (char)b[k];
        }
        if (!digits[0]) return nil;
        unsigned long long size = strtoull(digits, NULL, 16);
        i = eol + 2;
        if (size == 0) return body;
        if (size > n - i) return nil;
        [body appendBytes:b + i length:(NSUInteger)size];
        i += (NSUInteger)size + 2;
    }
    return nil;
}

NSData *StarlinkHTTPPost(NSString *host, uint16_t port, NSString *path, NSDictionary<NSString *, NSString *> *headers,
    NSData *body, NSTimeInterval timeout, NSString **error) {
    struct sockaddr_in addr = {.sin_len = sizeof addr, .sin_family = AF_INET, .sin_port = htons(port)};
    if (inet_pton(AF_INET, host.UTF8String, &addr.sin_addr) != 1) { if (error) *error = @"Dish address is not an IPv4 address"; return nil; }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { if (error) *error = @"No socket"; return nil; }
    int on = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    int (^wait)(short) = ^int(short events) {
        int ms = (int)MAX(0, [deadline timeIntervalSinceNow] * 1000);
        struct pollfd p = {fd, events, 0};
        return poll(&p, 1, ms);
    };
    NSData *result = nil;
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0 && errno != EINPROGRESS) { if (error) *error = @"Dish not reachable"; goto done; }
    if (wait(POLLOUT) <= 0) { if (error) *error = @"Dish not reachable"; goto done; }
    int soerr = 0; socklen_t len = sizeof soerr;
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &len);
    if (soerr) { if (error) *error = @"Dish not reachable"; goto done; }
    {
        NSMutableString *head = [NSMutableString stringWithFormat:@"POST %@ HTTP/1.1\r\nHost: %@:%u\r\nContent-Length: %lu\r\nConnection: close\r\n",
            path, host, port, (unsigned long)body.length];
        for (NSString *key in headers) [head appendFormat:@"%@: %@\r\n", key, headers[key]];
        [head appendString:@"\r\n"];
        NSMutableData *request = [[head dataUsingEncoding:NSASCIIStringEncoding] mutableCopy];
        [request appendData:body];
        NSUInteger sent = 0;
        while (sent < request.length) {
            if (wait(POLLOUT) <= 0) { if (error) *error = @"Dish timed out"; goto done; }
            ssize_t k = send(fd, (const uint8_t *)request.bytes + sent, request.length - sent, 0);
            if (k < 0 && errno != EAGAIN) { if (error) *error = @"Dish closed the connection"; goto done; }
            if (k > 0) sent += (NSUInteger)k;
        }
        NSMutableData *response = [NSMutableData data];
        uint8_t buffer[16384];
        for (;;) {
            if (response.length > 4 << 20) { if (error) *error = @"Dish reply too large"; goto done; }
            if (wait(POLLIN) <= 0) { if (error) *error = @"Dish timed out"; goto done; }
            ssize_t k = recv(fd, buffer, sizeof buffer, 0);
            if (k == 0) break;
            if (k < 0) { if (errno == EAGAIN) continue; if (error) *error = @"Dish closed the connection"; goto done; }
            [response appendBytes:buffer length:(NSUInteger)k];
        }
        result = StarlinkHTTPBody(response);
        if (!result && error) *error = @"Dish refused the request";
    }
done:
    close(fd);
    return result;
}

// ---- Link ----------------------------------------------------------------
@implementation StarlinkLink {
    NSString *_host; uint16_t _port; NSURL *_catalogURL, *_cacheURL;
    dispatch_queue_t _queue;
    NSUInteger _generation, _polls;
    NSDictionary *_previousMap; NSTimeInterval _previousTime;
    NSMutableArray<NSDictionary *> *_pixels;
    double _quaternion[4];
    BOOL _catalogLoading;
    NSDate *_catalogAttempt;
}

+ (instancetype)defaultLink {
    NSURL *caches = [NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *cache = [[caches URLByAppendingPathComponent:@"Isobar" isDirectory:YES] URLByAppendingPathComponent:@"starlink.tle"];
    NSString *host = [NSUserDefaults.standardUserDefaults stringForKey:@"StarlinkDishHost"] ?: @"192.168.100.1";
    return [[self alloc] initWithDishHost:host port:9201
        catalogURL:[NSURL URLWithString:@"https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle"] cacheURL:cache];
}

- (instancetype)initWithDishHost:(NSString *)host port:(uint16_t)port catalogURL:(NSURL *)catalogURL cacheURL:(NSURL *)cacheURL {
    if (!(self = [super init])) return nil;
    _host = [host copy]; _port = port; _catalogURL = catalogURL; _cacheURL = cacheURL;
    _queue = dispatch_queue_create("isobar.starlink", DISPATCH_QUEUE_SERIAL);
    _pixels = [NSMutableArray array];
    _quaternion[0] = NAN;
    _latitude = NAN; _longitude = NAN;
    return self;
}

- (void)publish {
    void (^update)(void) = self.onUpdate;
    if (update) dispatch_async(dispatch_get_main_queue(), update);
}

- (void)start {
    if (_running) return;
    _running = YES;
    NSUInteger generation = ++_generation;
    [self loadCatalog];
    // An empty host is no dish at all (offscreen harnesses): no socket, ever.
    if (!_host.length) { _dishError = @"No dish"; [self publish]; return; }
    dispatch_async(_queue, ^{ [self pollGeneration:generation]; });
}

// Readings from an earlier session are not shown as live on reopen.
- (void)stop {
    _running = NO;
    _generation++;
    _status = nil; _obstructionMap = nil; _dishError = nil;
    dispatch_async(_queue, ^{ self->_previousMap = nil; [self->_pixels removeAllObjects]; });
}

- (void)loadCatalog {
    if (_catalogLoading) return;
    if (_catalog && _catalogAttempt && -[_catalogAttempt timeIntervalSinceNow] < 12 * 3600) return;
    _catalogLoading = YES;
    NSURL *cache = _cacheURL, *source = _catalogURL;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSDate *modified = nil;
        [cache getResourceValue:&modified forKey:NSURLContentModificationDateKey error:nil];
        NSString *text = [NSString stringWithContentsOfURL:cache encoding:NSUTF8StringEncoding error:nil];
        StarlinkCatalog *cached = text ? [StarlinkCatalog catalogWithText:text] : nil;
        void (^finish)(StarlinkCatalog *, NSString *) = ^(StarlinkCatalog *catalog, NSString *problem) {
            dispatch_async(dispatch_get_main_queue(), ^{
                self->_catalogLoading = NO;
                self->_catalogAttempt = NSDate.date;
                if (catalog) self->_catalog = catalog;
                self->_catalogError = self->_catalog ? nil : problem;
                [self publish];
            });
        };
        // CelesTrak asks for no more than one download every two hours; 12 h is plenty.
        if (!source || (cached && modified && -modified.timeIntervalSinceNow < 12 * 3600)) {
            finish(cached, cached ? nil : @"No orbits");
            return;
        }
        if (cached) dispatch_async(dispatch_get_main_queue(), ^{ if (!self->_catalog) { self->_catalog = cached; [self publish]; } });
        NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
        configuration.timeoutIntervalForRequest = 60;
        NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
        [[session dataTaskWithURL:source
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            NSString *body = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
            StarlinkCatalog *fresh = ((NSHTTPURLResponse *)response).statusCode == 200 && body ? [StarlinkCatalog catalogWithText:body] : nil;
            if (fresh.count > 1000) {
                [NSFileManager.defaultManager createDirectoryAtURL:cache.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
                [data writeToURL:cache atomically:YES];
                finish(fresh, nil);
            } else finish(cached, error ? @"Orbits unavailable offline" : @"CelesTrak sent no orbits");
        }] resume];
        [session finishTasksAndInvalidate];
    });
}

- (void)pollGeneration:(NSUInteger)generation {
    if (generation != _generation) return;
    NSDictionary *headers = @{@"Content-Type": @"application/grpc-web+proto", @"X-Grpc-Web": @"1"};
    NSString *path = @"/SpaceX.API.Device.Device/Handle", *problem = nil;
    NSDate *started = NSDate.date;
    NSDictionary *status = nil;
    if (_polls % 10 == 0 || !isfinite(_quaternion[0])) {
        NSData *body = StarlinkHTTPPost(_host, _port, path, headers, StarlinkGRPCWebRequest(StarlinkRequestStatus), 8, &problem);
        NSData *payload = body ? StarlinkGRPCWebPayload(body) : nil;
        status = payload ? StarlinkDecodeStatus(payload) : nil;
        if (body && !status) problem = @"Dish sent no status";
        NSArray *q = status[@"quaternion"];
        if (q.count == 4) for (int i = 0; i < 4; i++) _quaternion[i] = [q[i] doubleValue];
    }
    NSDictionary *map = nil;
    if (!problem) {
        NSData *body = StarlinkHTTPPost(_host, _port, path, headers, StarlinkGRPCWebRequest(StarlinkRequestObstructionMap), 15, &problem);
        NSData *payload = body ? StarlinkGRPCWebPayload(body) : nil;
        map = payload ? StarlinkDecodeObstructionMap(payload) : nil;
    }
    NSTimeInterval answered = NSDate.date.timeIntervalSince1970;
    _polls++;
    // A failed or aging catalogue is retried while the lens stays open.
    if (_polls % 600 == 0) dispatch_async(dispatch_get_main_queue(), ^{ if (self->_running) [self loadCatalog]; });
    NSDictionary *serving = nil;
    if (map && isfinite(_quaternion[0])) {
        if (_previousMap && answered - _previousTime < 30)
            [_pixels addObjectsFromArray:StarlinkChangedPixels(_previousMap, map, _quaternion, _previousTime - 1, answered)];
        _previousMap = map; _previousTime = answered;
        // Keep the current and previous slot; a satellite's pixels arrive over its slot.
        NSTimeInterval keepFrom = StarlinkSlotStart(answered) - 15;
        [_pixels filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *p, id b) {
            (void)b; return [p[@"to"] doubleValue] >= keepFrom; }]];
        __block StarlinkCatalog *catalog = nil; __block double lat = NAN, lon = NAN;
        dispatch_sync(dispatch_get_main_queue(), ^{ catalog = self->_catalog; lat = self->_latitude; lon = self->_longitude; });
        NSTimeInterval slot = StarlinkSlotStart(answered);
        NSArray *current = [_pixels filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *p, id b) {
            (void)b; return StarlinkSlotStart(([p[@"from"] doubleValue] + [p[@"to"] doubleValue]) / 2) == slot; }]];
        NSDictionary *match = catalog && isfinite(lat) ? StarlinkIdentify(catalog, current, lat, lon) : nil;
        if ([match[@"confident"] boolValue]) serving = match;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        if (generation != self->_generation) return;
        if (status) self->_status = status;
        if (map) self->_obstructionMap = map;
        if (serving) self->_serving = serving;
        self->_dishError = problem;
        [self publish];
    });
    // About one map a second; back off while the dish is unreachable.
    NSTimeInterval wait = problem ? 10 : MAX(0, 1 - [NSDate.date timeIntervalSinceDate:started]);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), _queue, ^{ [self pollGeneration:generation]; });
}
@end
