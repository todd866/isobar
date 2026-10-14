#import "starlinkview.h"
#import <math.h>

static BOOL Dark(NSView *view) {
    return [view.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]] == NSAppearanceNameDarkAqua;
}
static NSColor *RGB(int r, int g, int b, double a) { return [NSColor colorWithSRGBRed:r / 255.0 green:g / 255.0 blue:b / 255.0 alpha:a]; }
// The map's link accent and plate (Sources/ownchart.m palette).
static NSColor *Accent(BOOL dark) { return dark ? RGB(0x7C, 0xC4, 0xFF, 1) : RGB(0x1F, 0x6F, 0xB2, 1); }
static NSColor *Sky(BOOL dark) { return dark ? RGB(0x24, 0x32, 0x42, 1) : RGB(0xEB, 0xF1, 0xF7, 1); }
static NSColor *Blocked(BOOL dark) { return dark ? RGB(0xE8, 0xB0, 0x4A, 1) : RGB(0xB5, 0x74, 0x1A, 1); }

NSDictionary *StarlinkServingState(StarlinkCatalog *catalog, NSDictionary *serving, NSDate *now, double lat, double lon) {
    NSString *name = serving[@"name"];
    if (!catalog || !name || !isfinite(lat) || !isfinite(lon)) return nil;
    NSUInteger index = [catalog indexOfName:name];
    if (index == NSNotFound) return nil;
    StarlinkLook look;
    if (!StarlinkLookAt([catalog orbitAtIndex:index], StarlinkJulianDate(now), lat, lon, 0, &look)) return nil;
    NSTimeInterval slotEnd = [serving[@"slot"] doubleValue] + 15, t = now.timeIntervalSince1970;
    BOOL current = t < slotEnd && t >= slotEnd - 15;
    return @{@"name": name, @"short": StarlinkShortName(name), @"current": @(current), @"age": @(current ? 0 : MAX(0, t - slotEnd)),
             @"look": @{@"el": @(look.elevation), @"az": @(look.azimuth), @"rangeKm": @(look.rangeKm),
                        @"latitude": @(look.latitude), @"longitude": @(look.longitude)}};
}

@implementation StarlinkLensView {
    NSDictionary *_fieldMap;
    NSArray<NSArray<NSNumber *> *> *_field;  // [el, az, snr]
    NSDictionary *_readings;
    NSUInteger _drawn;
}

- (instancetype)initWithFrame:(NSRect)frame {
    if (!(self = [super initWithFrame:frame])) return nil;
    _now = NSDate.date;
    _latitude = NAN; _longitude = NAN;
    self.accessibilityRole = NSAccessibilityGroupRole;
    self.accessibilityLabel = @"Starlink";
    return self;
}
- (BOOL)isFlipped { return YES; }
- (NSDictionary *)readings { return _readings ?: @{}; }
- (NSUInteger)drawnSatellites { return _drawn; }

static const CGFloat kTop = 26, kRowH = 28;
- (CGFloat)domeDiameterForWidth:(CGFloat)width { return MAX(80, MIN(width - 28, 236)); }
- (CGFloat)fittingHeightForWidth:(CGFloat)width { return kTop + [self domeDiameterForWidth:width] + 18 + 2 * kRowH; }

- (void)setNow:(NSDate *)now { _now = now ?: NSDate.date; self.needsDisplay = YES; }
- (void)setStatus:(NSDictionary *)status { _status = [status copy]; self.needsDisplay = YES; }
- (void)setServing:(NSDictionary *)serving { _serving = [serving copy]; self.needsDisplay = YES; }
- (void)setCatalog:(StarlinkCatalog *)catalog { _catalog = catalog; self.needsDisplay = YES; }
- (void)setDishError:(NSString *)error { _dishError = [error copy]; self.needsDisplay = YES; }
- (void)setObstructionMap:(NSDictionary *)map { _obstructionMap = [map copy]; self.needsDisplay = YES; }

// The used sky, converted once per map.
- (NSArray *)field {
    NSDictionary *map = _obstructionMap;
    NSArray *q = _status[@"quaternion"];
    if (!map || q.count != 4) return @[];
    if (map == _fieldMap && _field) return _field;
    double quat[4]; for (int i = 0; i < 4; i++) quat[i] = [q[i] doubleValue];
    NSInteger rows = [map[@"rows"] integerValue], cols = [map[@"cols"] integerValue];
    if (rows != cols) return @[];
    const float *snr = [map[@"snr"] bytes];
    double theta = [map[@"maxThetaDeg"] doubleValue];
    NSMutableArray *field = [NSMutableArray array];
    for (NSInteger k = 0; k < rows * cols; k++) {
        if (!(snr[k] >= 0)) continue;
        double el, az;
        if (StarlinkPixelToSky(k % cols, k / cols, rows, theta, quat, &el, &az) && el > 0) [field addObject:@[@(el), @(az), @(snr[k])]];
    }
    _fieldMap = map; _field = field;
    return field;
}

static NSPoint DomePoint(NSPoint c, CGFloat r, double el, double az) {
    double d = r * (90 - el) / 90, a = az * M_PI / 180;
    return NSMakePoint(c.x + d * sin(a), c.y - d * cos(a));
}

static void Text(NSString *s, NSFont *font, NSColor *color, NSPoint p, NSTextAlignment align, CGFloat width) {
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
    style.alignment = align; style.lineBreakMode = NSLineBreakByClipping;
    NSDictionary *attrs = @{NSFontAttributeName: font, NSForegroundColorAttributeName: color, NSParagraphStyleAttributeName: style};
    CGFloat h = ceil(font.ascender - font.descender + 1);
    [s drawInRect:NSMakeRect(p.x, p.y - h / 2, width, h) withAttributes:attrs];
}

static void SatelliteGlyph(NSPoint c, NSColor *color) {
    NSAffineTransform *t = [NSAffineTransform transform];
    [t translateXBy:c.x yBy:c.y]; [t rotateByDegrees:-34];
    [NSGraphicsContext saveGraphicsState]; [t concat]; [color setFill];
    NSRectFill(NSMakeRect(-2.5, -2.5, 5, 5)); NSRectFill(NSMakeRect(-9, -1.8, 5, 3.6)); NSRectFill(NSMakeRect(4, -1.8, 5, 3.6));
    [NSGraphicsContext restoreGraphicsState];
}

static void PingGlyph(NSPoint c, NSColor *color) {
    NSBezierPath *p = [NSBezierPath bezierPath];
    p.lineWidth = 1.4; p.lineCapStyle = NSLineCapStyleRound; p.lineJoinStyle = NSLineJoinStyleRound;
    [p moveToPoint:NSMakePoint(c.x - 7, c.y)]; [p lineToPoint:NSMakePoint(c.x + 7, c.y)];
    [p moveToPoint:NSMakePoint(c.x - 4, c.y - 3)]; [p lineToPoint:NSMakePoint(c.x - 7, c.y)]; [p lineToPoint:NSMakePoint(c.x - 4, c.y + 3)];
    [p moveToPoint:NSMakePoint(c.x + 4, c.y - 3)]; [p lineToPoint:NSMakePoint(c.x + 7, c.y)]; [p lineToPoint:NSMakePoint(c.x + 4, c.y + 3)];
    [color setStroke]; [p stroke];
}

static void ClockGlyph(NSPoint c, double fraction, NSColor *track, NSColor *fill) {
    NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(c.x - 6.5, c.y - 6.5, 13, 13)];
    ring.lineWidth = 2.4; [track setStroke]; [ring stroke];
    NSBezierPath *arc = [NSBezierPath bezierPath];
    // Flipped view: clockwise on screen from 12 o'clock.
    [arc appendBezierPathWithArcWithCenter:c radius:6.5 startAngle:-90 endAngle:-90 + 360 * fraction clockwise:NO];
    arc.lineWidth = 2.4; [fill setStroke]; [arc stroke];
}

- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    BOOL dark = Dark(self);
    NSColor *ink = NSColor.labelColor, *muted = NSColor.secondaryLabelColor, *accent = Accent(dark);
    NSColor *faint = [ink colorWithAlphaComponent:0.16];
    CGFloat width = NSWidth(self.bounds), D = [self domeDiameterForWidth:width], R = D / 2;
    NSPoint c = NSMakePoint(width / 2, kTop + R);
    NSTimeInterval t = _now.timeIntervalSince1970;
    NSInteger toHandover = (NSInteger)ceil(StarlinkSlotStart(t) + 15 - t);
    if (toHandover > 15) toHandover = 15;

    // Handover clock, top left.
    ClockGlyph(NSMakePoint(9, 11), 1 - toHandover / 15.0, faint, accent);
    NSString *clock = [NSString stringWithFormat:@"%ld s", (long)toHandover];
    Text(clock, [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightMedium], muted, NSMakePoint(22, 11), NSTextAlignmentLeft, 60);

    // Dome.
    [Sky(dark) setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(c.x - R, c.y - R, D, D)] fill];
    CGFloat px = MAX(2, R / 44);
    for (NSArray *p in [self field]) {
        double snr = [p[2] doubleValue];
        NSPoint q = DomePoint(c, R, [p[0] doubleValue], [p[1] doubleValue]);
        [(snr <= 0.1 ? [Blocked(dark) colorWithAlphaComponent:0.4] : [accent colorWithAlphaComponent:0.2]) setFill];
        NSRectFillUsingOperation(NSMakeRect(q.x - px / 2, q.y - px / 2, px, px), NSCompositingOperationSourceOver);
    }
    [faint setStroke];
    for (NSNumber *e in @[@30, @60]) {
        CGFloat r = R * (90 - e.doubleValue) / 90;
        NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(c.x - r, c.y - r, 2 * r, 2 * r)];
        ring.lineWidth = 1; [ring stroke];
    }
    NSBezierPath *rim = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(c.x - R, c.y - R, D, D)];
    rim.lineWidth = 1.2; [[ink colorWithAlphaComponent:0.45] setStroke]; [rim stroke];
    NSFont *compass = [NSFont systemFontOfSize:10 weight:NSFontWeightSemibold];
    for (NSArray *k in @[@[@"N", @0], @[@"E", @90], @[@"S", @180], @[@"W", @270]]) {
        NSPoint q = DomePoint(c, R + 9, 0, [k[1] doubleValue]);
        Text(k[0], compass, muted, NSMakePoint(q.x - 10, q.y), NSTextAlignmentCenter, 20);
    }

    // Every satellite above the horizon.
    _drawn = 0;
    if (_catalog && isfinite(_latitude) && isfinite(_longitude)) {
        NSData *sky = StarlinkSkyAt(_catalog, _now, _latitude, _longitude, 1, -1, 0, 0, 0);
        const StarlinkSkyPoint *pts = sky.bytes;
        for (NSUInteger i = 0; i < sky.length / sizeof *pts; i++) {
            if (pts[i].elevation < 0) continue;
            BOOL high = pts[i].elevation >= 25;
            NSPoint q = DomePoint(c, R, pts[i].elevation, pts[i].azimuth);
            CGFloat r = high ? 1.8 : 1.2;
            [[ink colorWithAlphaComponent:high ? 0.8 : 0.4] setFill];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(q.x - r, q.y - r, 2 * r, 2 * r)] fill];
            _drawn++;
        }
    }

    // Boresight.
    NSNumber *bel = _status[@"elevation"], *baz = _status[@"azimuth"];
    if (bel && baz) {
        NSPoint b = DomePoint(c, R, bel.doubleValue, fmod(baz.doubleValue + 360, 360));
        NSBezierPath *plus = [NSBezierPath bezierPath];
        [plus moveToPoint:NSMakePoint(b.x - 4, b.y)]; [plus lineToPoint:NSMakePoint(b.x + 4, b.y)];
        [plus moveToPoint:NSMakePoint(b.x, b.y - 4)]; [plus lineToPoint:NSMakePoint(b.x, b.y + 4)];
        plus.lineWidth = 1.2; [ink setStroke]; [plus stroke];
    }

    // Serving satellite: arc from a minute before to a minute after, ringed now.
    NSDictionary *state = StarlinkServingState(_catalog, _serving, _now, _latitude, _longitude);
    BOOL current = [state[@"current"] boolValue];
    NSColor *linkColor = current ? accent : [muted colorWithAlphaComponent:0.7];
    if (state) {
        const StarlinkOrbit *orbit = [_catalog orbitAtIndex:[_catalog indexOfName:state[@"name"]]];
        NSBezierPath *arc = [NSBezierPath bezierPath];
        BOOL started = NO;
        for (int s = -60; s <= 60; s += 5) {
            StarlinkLook look;
            if (!StarlinkLookAt(orbit, StarlinkJulianDate([_now dateByAddingTimeInterval:s]), _latitude, _longitude, 0, &look) || look.elevation < 0) continue;
            NSPoint q = DomePoint(c, R, look.elevation, look.azimuth);
            if (started) [arc lineToPoint:q]; else { [arc moveToPoint:q]; started = YES; }
        }
        arc.lineWidth = 2; arc.lineCapStyle = NSLineCapStyleRound; [linkColor setStroke]; [arc stroke];
        double el = [state[@"look"][@"el"] doubleValue];
        if (el >= 0) {
            NSPoint s = DomePoint(c, R, el, [state[@"look"][@"az"] doubleValue]);
            [linkColor setFill];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(s.x - 3.6, s.y - 3.6, 7.2, 7.2)] fill];
            NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(s.x - 7.5, s.y - 7.5, 15, 15)];
            ring.lineWidth = 1.6; [ring stroke];
        }
    }

    // Instrument rows.
    CGFloat y0 = kTop + D + 18;
    NSFont *value = [NSFont monospacedSystemFontOfSize:15 weight:NSFontWeightSemibold];
    NSFont *datum = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
    NSString *servingText = @"—", *servingDatum = @"";
    if (state) {
        servingText = state[@"short"];
        servingDatum = current
            ? [NSString stringWithFormat:@"el %.0f°  %.0f km", [state[@"look"][@"el"] doubleValue], [state[@"look"][@"rangeKm"] doubleValue]]
            : [NSString stringWithFormat:@"%.0f s ago", [state[@"age"] doubleValue]];
    } else if (!_catalog) servingDatum = _catalogError ? @"no orbits" : @"loading orbits";
    else if (_dishError) servingDatum = @"no dish";
    NSString *ping = @"—", *pingDatum = _dishError ? @"no dish" : @"";
    NSNumber *ms = _status[@"pingMs"], *down = _status[@"downBps"], *up = _status[@"upBps"];
    if (!_dishError && ms) ping = [NSString stringWithFormat:@"%.0f ms", ms.doubleValue];
    if (!_dishError && down && up) pingDatum = [NSString stringWithFormat:@"↓%.1f  ↑%.1f Mb/s", down.doubleValue / 1e6, up.doubleValue / 1e6];
    NSArray *rows = @[@[servingText, servingDatum], @[ping, pingDatum]];
    for (NSUInteger i = 0; i < rows.count; i++) {
        CGFloat y = y0 + i * kRowH + kRowH / 2;
        if (i) {
            [[ink colorWithAlphaComponent:0.12] setFill];
            NSRectFillUsingOperation(NSMakeRect(0, y0 + i * kRowH, width, 1), NSCompositingOperationSourceOver);
        }
        if (i == 0) SatelliteGlyph(NSMakePoint(11, y), linkColor);
        else PingGlyph(NSMakePoint(11, y), ink);
        Text(rows[i][0], value, i == 0 && state && !current ? muted : ink, NSMakePoint(28, y), NSTextAlignmentLeft, width / 2);
        Text(rows[i][1], datum, muted, NSMakePoint(width / 2 - 20, y), NSTextAlignmentRight, width / 2 + 20);
    }
    _readings = @{@"serving": servingText, @"servingDatum": servingDatum, @"ping": ping, @"pingDatum": pingDatum, @"clock": clock};
    NSMutableArray *tips = [NSMutableArray array];
    if (state) [tips addObject:[NSString stringWithFormat:@"%@ · fit %.1f°", state[@"name"], [_serving[@"errorDeg"] doubleValue]]];
    if (_dishError) [tips addObject:[NSString stringWithFormat:@"%@ (192.168.100.1)", _dishError]];
    if (_catalogError && !_catalog) [tips addObject:_catalogError];
    [tips addObject:@"Orbits: CelesTrak · dish: local status"];
    self.toolTip = [tips componentsJoinedByString:@"\n"];
    self.accessibilityValue = [NSString stringWithFormat:@"%@ %@, %@ %@", servingText, servingDatum, ping, pingDatum];
}
@end
