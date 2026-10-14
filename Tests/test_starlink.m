#import "../Sources/starlink.h"
#import <math.h>

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static NSString *const kTLE =
    @"STARLINK-1008           \n"
    @"1 44714U 19074B   26286.81034929  .00053040  00000+0  49371-3 0  9999\n"
    @"2 44714  53.1457 212.7090 0002887 117.9274 242.2035 15.66876383382727\n"
    @"STARLINK-1810           \n"
    @"1 46709U 20073AR  26286.57776559  .09374670  12330-4  83055-3 0  9996\n"
    @"2 46709  53.0090 234.7860 0002227 286.5126  73.5674 16.38388586331485\n"
    @"STARLINK-6285           \n"
    @"1 56405U 23061AH  26286.61286548 -.00001431  00000+0 -42482-4 0  9990\n"
    @"2 56405  43.0058  36.2811 0001512 271.3807  88.6871 15.27572128190200\n"
    @"STARLINK-35964          \n"
    @"1 66796U 25278F   26286.33652369  .00035575  00000+0  12950-2 0  9992\n"
    @"2 66796  43.0021 310.3178 0001915 301.2798  58.7866 15.27606406 48666\n";

// python-sgp4 2.24 (Vallado's code, WGS-72, improved mode), tsince minutes.
typedef struct { const char *name; double t, r[3], v[3]; } Vector;
static const Vector kVectors[] = {
    {"STARLINK-1008", 0, {-5677.778644, -3646.328545, -0.000149}, {2.498101488, -3.873603050, 6.153625479}},
    {"STARLINK-1008", 90, {-5926.214928, -3156.191308, -680.956198}, {1.638137754, -4.375818434, 6.104353876}},
    {"STARLINK-1008", 1440, {875.148336, 4591.968937, -4871.202000}, {-7.053039420, -1.469103260, -2.656094566}},
    {"STARLINK-1008", 4320, {-5933.532285, -2938.812453, 1286.309614}, {3.133823087, -3.689288030, 5.975926397}},
    // Perigee below 220 km: the simplified branch.
    {"STARLINK-1810", 0, {-3776.216680, -5350.346441, -0.004569}, {3.838261977, -2.702337437, 6.236158829}},
    {"STARLINK-1810", 90, {-3257.568491, -5617.395798, 817.530504}, {4.486502574, -1.697841052, 6.160631320}},
    {"STARLINK-1810", 1440, {4444.059574, 4727.100656, 371.882966}, {-3.188531957, 3.499177371, -6.243632252}},
    {"STARLINK-6285", 0, {5530.785388, 4059.952485, -0.003821}, {-3.302526426, 4.491339964, 5.203321229}},
    {"STARLINK-6285", 4320, {5876.770809, -1557.967768, -3183.568567}, {3.539454169, 5.570143037, 3.812102019}},
    {"STARLINK-35964", 90, {3185.636317, -5940.370067, -1280.460375}, {5.448478210, 1.847274980, 5.004456955}},
    {"STARLINK-35964", 4320, {-997.902212, -6045.664046, -3088.127832}, {5.838631724, -2.956768263, 3.907691481}},
};

static void TestPropagation(void) {
    StarlinkCatalog *catalog = [StarlinkCatalog catalogWithText:kTLE];
    CHECK(catalog.count == 4, "catalog count %lu", (unsigned long)catalog.count);
    for (size_t i = 0; i < sizeof kVectors / sizeof *kVectors; i++) {
        const Vector *want = &kVectors[i];
        NSUInteger index = [catalog indexOfName:@(want->name)];
        CHECK(index != NSNotFound, "%s missing", want->name);
        if (index == NSNotFound) continue;
        double r[3], v[3];
        BOOL ok = StarlinkPropagate([catalog orbitAtIndex:index], want->t, r, v);
        CHECK(ok, "%s t=%g failed", want->name, want->t);
        double dr = 0, dv = 0;
        for (int k = 0; k < 3; k++) { dr = fmax(dr, fabs(r[k] - want->r[k])); dv = fmax(dv, fabs(v[k] - want->v[k])); }
        CHECK(dr < 1e-3 && dv < 1e-6, "%s t=%g: position off %.6f km, velocity %.9f km/s", want->name, want->t, dr, dv);
    }
    StarlinkOrbit orbit;
    CHECK(!StarlinkOrbitFromTLE(@"1 44714U 19074B   26286.81034929  .00053040  00000+0  49371-3 0  9998",
        @"2 44714  53.1457 212.7090 0002887 117.9274 242.2035 15.66876383382727", &orbit), "bad checksum accepted");
    // Geostationary: deep space is refused, not propagated with near-earth terms.
    CHECK(!StarlinkOrbitFromTLE(@"1 41866U 16071A   26286.50000000 -.00000300  00000+0  00000+0 0  9991",
        @"2 41866   0.0200 270.0000 0001000 180.0000 100.0000  1.00270000 36503", &orbit), "deep space accepted");
    CHECK(StarlinkOrbitFromTLE(@"1 41866U 16071A   26286.50000000 -.00000300  00000+0  00000+0 0  9991", @"2 41866   0.0200 270.0000 0001000 180.0000 100.0000 15.00270000 36508", &orbit), "checksum helper");
    CHECK([StarlinkShortName(@"STARLINK-35964") isEqual:@"35964"], "short name");
    CHECK([catalog.newestEpoch timeIntervalSince1970] > 0, "newest epoch");
}

static void TestLook(void) {
    StarlinkCatalog *catalog = [StarlinkCatalog catalogWithText:kTLE];
    const StarlinkOrbit *orbit = [catalog orbitAtIndex:[catalog indexOfName:@"STARLINK-35964"]];
    double jd = orbit->epochJD + 30 / 1440.0;
    StarlinkLook from;
    CHECK(StarlinkLookAt(orbit, jd, 0, 0, 0, &from), "look");
    StarlinkLook under;
    CHECK(StarlinkLookAt(orbit, jd, from.latitude, from.longitude, 0, &under), "look under");
    CHECK(under.elevation > 89.5, "overhead elevation %.3f", under.elevation);
    CHECK(fabs(under.rangeKm - under.altitudeKm) < 25 && under.altitudeKm > 450 && under.altitudeKm < 600,
        "range %.1f altitude %.1f", under.rangeKm, under.altitudeKm);
    // GMST at J2000.0 is 280.46°.
    CHECK(fabs(StarlinkGMST(2451545.0) * 180 / M_PI - 280.46061837) < 1e-4, "gmst");
    CHECK(fabs(StarlinkJulianDate([NSDate dateWithTimeIntervalSince1970:946728000]) - 2451545.0) < 1e-9, "jd");
}

// Builds a Response{field: message} body framed for gRPC-web.
static void Varint(NSMutableData *d, uint64_t v) { do { uint8_t b = v & 0x7f; v >>= 7; if (v) b |= 0x80; [d appendBytes:&b length:1]; } while (v); }
static void Key(NSMutableData *d, uint32_t field, int wire) { Varint(d, ((uint64_t)field << 3) | wire); }
static void Float(NSMutableData *d, uint32_t field, float f) { Key(d, field, 5); [d appendBytes:&f length:4]; }
static void Message(NSMutableData *d, uint32_t field, NSData *m) { Key(d, field, 2); Varint(d, m.length); [d appendData:m]; }
static NSData *Framed(NSData *payload) {
    NSMutableData *body = [NSMutableData dataWithLength:5];
    uint8_t *h = body.mutableBytes; uint32_t n = (uint32_t)payload.length;
    h[1] = n >> 24; h[2] = n >> 16; h[3] = n >> 8; h[4] = n;
    [body appendData:payload];
    [body appendData:[NSData dataWithBytes:"\x80\x00\x00\x00\x10grpc-status: 0\r\n" length:21]];
    return body;
}

// Recorded on a Starlink Mini in Perth, 14 Oct 2026 (identifiers removed).
static const double kQuaternion[4] = {-0.1355827897787094, 0.7081814408302307, 0.669562578201294, -0.17827607691287994};

static void TestWire(void) {
    NSData *request = StarlinkGRPCWebRequest(StarlinkRequestStatus);
    const uint8_t want[] = {0, 0, 0, 0, 3, 0xe2, 0x3e, 0};
    CHECK([request isEqual:[NSData dataWithBytes:want length:sizeof want]], "status request %s", request.description.UTF8String);
    const uint8_t map[] = {0, 0, 0, 0, 3, 0xc2, 0x7d, 0};
    CHECK([StarlinkGRPCWebRequest(StarlinkRequestObstructionMap) isEqual:[NSData dataWithBytes:map length:sizeof map]], "map request");

    NSMutableData *status = [NSMutableData data], *info = [NSMutableData data], *align = [NSMutableData data], *quat = [NSMutableData data];
    Key(info, 2, 2); Varint(info, 16); [info appendBytes:"mini1_pez_proto1" length:16];
    Message(status, 1, info);
    Float(status, 1009, 24.6f); Float(status, 1007, 494281.9f); Float(status, 1008, 464754.1f);
    Float(status, 1011, -173.86f); Float(status, 1012, 64.11f);
    Float(align, 3, 26.17f); Float(align, 4, -173.86f); Float(align, 5, 64.11f);
    Message(status, 1027, align);
    for (int i = 0; i < 4; i++) Float(quat, i + 1, (float)kQuaternion[i]);
    Message(status, 1049, quat);
    NSMutableData *response = [NSMutableData data];
    Key(response, 3, 0); Varint(response, 43);
    Message(response, 2004, status);
    NSData *payload = StarlinkGRPCWebPayload(Framed(response));
    NSDictionary *decoded = payload ? StarlinkDecodeStatus(payload) : nil;
    CHECK(fabs([decoded[@"pingMs"] doubleValue] - 24.6) < 1e-3, "ping %s", [decoded description].UTF8String);
    CHECK(fabs([decoded[@"tilt"] doubleValue] - 26.17) < 1e-3, "tilt");
    CHECK([decoded[@"quaternion"] count] == 4, "quaternion");
    CHECK([decoded[@"hardware"] isEqual:@"mini1_pez_proto1"], "hardware");
    CHECK(!StarlinkGRPCWebPayload([NSData dataWithBytes:(const uint8_t[]){0x80, 0, 0, 0, 2, 0x61, 0x62} length:7]), "trailer only");
    CHECK(!StarlinkDecodeStatus([NSData dataWithBytes:"\xff\xff" length:2]), "garbage");
    NSData *(^http)(NSString *) = ^NSData *(NSString *text) { return [text dataUsingEncoding:NSISOLatin1StringEncoding]; };
    CHECK([StarlinkHTTPBody(http(@"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n")) isEqual:[@"abc" dataUsingEncoding:NSASCIIStringEncoding]], "chunked");
    CHECK(!StarlinkHTTPBody(http(@"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\u00e9\r\nabc\r\n0\r\n\r\n")), "non-hex chunk size");
    CHECK(!StarlinkHTTPBody(http(@"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffffff\r\nabc\r\n")), "huge chunk size");
    CHECK(!StarlinkHTTPBody(http(@"HTTP/1.1 500 Nope\r\n\r\nx")), "non-200");

    // A 3×3 map, one lit pixel, snr split over two packed chunks.
    NSMutableData *obs = [NSMutableData data], *chunk1 = [NSMutableData data], *chunk2 = [NSMutableData data];
    float a[5] = {-1, -1, -1, -1, 1}, b[4] = {-1, -1, -1, -1};
    [chunk1 appendBytes:a length:sizeof a]; [chunk2 appendBytes:b length:sizeof b];
    Key(obs, 1, 0); Varint(obs, 3); Key(obs, 2, 0); Varint(obs, 3);
    Message(obs, 3, chunk1); Message(obs, 3, chunk2);
    Float(obs, 5, 80); Key(obs, 6, 0); Varint(obs, 2);
    NSMutableData *obsResponse = [NSMutableData data];
    Message(obsResponse, 2008, obs);
    NSDictionary *grid = StarlinkDecodeObstructionMap(StarlinkGRPCWebPayload(Framed(obsResponse)));
    CHECK([grid[@"rows"] integerValue] == 3 && [grid[@"snr"] length] == 36, "map %s", grid.description.UTF8String);
    CHECK([grid[@"frame"] integerValue] == 2 && [grid[@"maxThetaDeg"] doubleValue] == 80, "map frame");
}

static void TestSky(void) {
    // The map centre is the antenna normal: the status boresight (az 186.1°, el 64.1°).
    double el, az;
    CHECK(StarlinkPixelToSky(61, 61, 123, 80, kQuaternion, &el, &az), "centre");
    CHECK(fabs(el - 64.11) < 0.3 && fabs(az - 186.14) < 0.5, "centre el %.2f az %.2f", el, az);
    CHECK(fabs(StarlinkAngularSeparation(10, 350, 10, 10) - 19.70) < 0.05, "separation across north");
    CHECK(fmod(StarlinkSlotStart(100000.0) - 12, 15) == 0 && StarlinkSlotStart(100000.0) <= 100000.0 &&
        StarlinkSlotStart(100000.0) > 100000.0 - 15, "slot bounds");
}

static void TestIdentify(void) {
    StarlinkCatalog *catalog = [StarlinkCatalog catalogWithText:kTLE];
    const StarlinkOrbit *orbit = [catalog orbitAtIndex:[catalog indexOfName:@"STARLINK-6285"]];
    // Find a time it is high over Perth, then light pixels along its path.
    double lat = -31.95, lon = 115.86, jd = orbit->epochJD;
    StarlinkLook look = {0};
    for (int k = 0; k < 2 * 1440 * 60; k += 5) {
        StarlinkLookAt(orbit, orbit->epochJD + k / 86400.0, lat, lon, 0, &look);
        if (look.elevation > 50) { jd = orbit->epochJD + k / 86400.0; break; }
    }
    CHECK(look.elevation > 50, "no pass found");
    NSTimeInterval t = (jd - 2440587.5) * 86400.0;
    NSMutableArray *pixels = [NSMutableArray array];
    for (int k = 0; k < 6; k++) {
        StarlinkLookAt(orbit, jd + k * 2 / 86400.0, lat, lon, 0, &look);
        [pixels addObject:@{@"x": @(40 + k), @"y": @(50), @"el": @(look.elevation + 0.4), @"az": @(look.azimuth),
                            @"from": @(t + k * 2 - 1), @"to": @(t + k * 2 + 1)}];
    }
    NSDictionary *match = StarlinkIdentify(catalog, pixels, lat, lon);
    CHECK([match[@"name"] isEqual:@"STARLINK-6285"], "identify %s", match.description.UTF8String);
    CHECK([match[@"errorDeg"] doubleValue] < 1 && [match[@"confident"] boolValue], "error");
    // Too few pixels: no claim.
    CHECK(!StarlinkIdentify(catalog, [pixels subarrayWithRange:NSMakeRange(0, 2)], lat, lon), "two pixels identified");
}

int main(void) {
    @autoreleasepool {
        TestPropagation();
        TestLook();
        TestWire();
        TestSky();
        TestIdentify();
    }
    if (failures) { fprintf(stderr, "%d starlink failure(s)\n", failures); return 1; }
    puts("starlink tests passed");
    return 0;
}
