// Isobar — local rain, wind, aviation weather and Bureau synoptic charts.
#import <Cocoa/Cocoa.h>
#import <CoreLocation/CoreLocation.h>
#import <ServiceManagement/ServiceManagement.h>
#import "pure.h"
#import "menubar.h"
#import "ownchart.h"
#import "ownrender.h"
#import "archive.h"
#import "forecastview.h"
#import "surfview.h"
#import "motion.h"
#import "rawmovie.h"
#import "scrub.h"
#import "mapdetail.h"
#import "collector.h"
#import "rain.h"
#import "rainview.h"
#import "aviation.h"
#import "aviationview.h"
#import "atmosphereview.h"
#import "notices.h"
#import "notacconnection.h"
#import "fullscreenwindow.h"
#import <math.h>
#import <zlib.h>
#import <AVFoundation/AVFoundation.h>

static const NSTimeInterval kRefreshInterval = 5 * 60;
static const NSUInteger kMotionIntervals = 24;
static const double kMotionFPS = 24;
static const double kEvolutionDuration = 120;
static BOOL MotionEnabled(void) { return getenv("ISOBAR_EXPERIMENTAL_MOTION") || getenv("ISOBAR_CHECK_MOTION"); }

static NSTimeZone *ZoneForPlace(NSDictionary *place) {
    NSString *name = place[@"timezone"];
    NSTimeZone *tz = [name isKindOfClass:NSString.class] ? [NSTimeZone timeZoneWithName:name] : nil;
    if (tz) return tz;
    NSDictionary *names = @{
        @"WA": @"Australia/Perth", @"NT": @"Australia/Darwin", @"SA": @"Australia/Adelaide",
        @"QLD": @"Australia/Brisbane", @"NSW": @"Australia/Sydney", @"ACT": @"Australia/Sydney",
        @"VIC": @"Australia/Melbourne", @"TAS": @"Australia/Hobart",
    };
    return [NSTimeZone timeZoneWithName:names[[place[@"state"] uppercaseString] ?: @""] ?: @"Australia/Perth"];
}

static NSTimeZone *OwnerZone(void) {
    return [NSTimeZone timeZoneWithName:@"Australia/Perth"];
}

static NSDictionary *SavedPlaceForTimeZone(NSArray<NSDictionary *> *places, NSString *zone) {
    for (NSDictionary *place in places)
        if ([place[@"timezone"] isEqual:zone]) return place;
    return places.firstObject;
}

static CGFloat TextWidth(NSString *text, NSFont *font) {
    if (!text.length || !font) return 0;
    return ceil([text sizeWithAttributes:@{NSFontAttributeName: font}].width);
}

static BOOL IsPDF(NSData *data) {
    return data.length >= 5 && memcmp(data.bytes, "%PDF-", 5) == 0;
}

static CGPDFDocumentRef PDFDocumentFromData(NSData *data) {
    if (!IsPDF(data)) return NULL;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    if (!provider) return NULL;
    CGPDFDocumentRef doc = CGPDFDocumentCreateWithProvider(provider);
    CGDataProviderRelease(provider);
    if (doc && CGPDFDocumentGetNumberOfPages(doc) < 1) {
        CGPDFDocumentRelease(doc);
        return NULL;
    }
    return doc;
}

@interface ClickLabel : NSTextField
@property (nonatomic, copy) void (^onClick)(void);
@end

@implementation ClickLabel
- (void)mouseDown:(NSEvent *)event {
    (void)event;
    if (self.onClick) self.onClick();
    else [super mouseDown:event];
}
- (void)resetCursorRects {
    if (self.onClick) [self addCursorRect:self.bounds cursor:NSCursor.pointingHandCursor];
}
@end

@interface ChartView : NSView
@property (nonatomic, strong) NSImage *image;
@property (nonatomic) BOOL crisp;
@property (nonatomic, copy) void (^onClick)(void);
@property (nonatomic, copy) void (^onDoubleClick)(NSPoint pointInView);
@property (nonatomic, copy) void (^onZoom)(BOOL zoomIn);
@end

@implementation ChartView {
    NSPoint _down;
    NSPoint _last;
    BOOL _dragged;
    BOOL _ateDouble;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)e { (void)e; return YES; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [NSGraphicsContext.currentContext setImageInterpolation:
        self.crisp ? NSImageInterpolationNone : NSImageInterpolationHigh];
    [self.image drawInRect:self.bounds fromRect:NSZeroRect
        operation:NSCompositingOperationSourceOver fraction:1 respectFlipped:YES hints:nil];
}
- (void)mouseDown:(NSEvent *)e {
    _down = _last = [self convertPoint:e.locationInWindow fromView:nil];
    _dragged = NO;
    if (e.clickCount == 2 && self.onDoubleClick) {
        self.onDoubleClick(_down);
        _ateDouble = YES;
    }
}
- (void)mouseDragged:(NSEvent *)e {
    NSPoint p = [self convertPoint:e.locationInWindow fromView:nil];
    if (fabs(p.x - _down.x) >= 4 || fabs(p.y - _down.y) >= 4) _dragged = YES;
    if (_dragged && self.enclosingScrollView) {
        NSRect vis = self.visibleRect;
        [self scrollPoint:NSMakePoint(NSMinX(vis) - (p.x - _last.x), NSMinY(vis) - (p.y - _last.y))];
    }
    _last = p;
}
- (void)mouseUp:(NSEvent *)e {
    (void)e;
    if (_ateDouble) { _ateDouble = NO; return; }
    if (!_dragged && self.onClick) self.onClick();
}
- (void)magnifyWithEvent:(NSEvent *)e {
    if (self.enclosingScrollView.allowsMagnification) {
        [self.enclosingScrollView magnifyWithEvent:e];
        return;
    }
    if (e.phase != NSEventPhaseEnded || !self.onZoom) return;
    self.onZoom(e.magnification > 0);
}
@end

@interface FlippedView : NSView
@end
@implementation FlippedView
- (BOOL)isFlipped { return YES; }
@end

@interface ChartRoot : FlippedView
@property (nonatomic, copy) void (^onBackgroundClick)(void);
@end
@implementation ChartRoot
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (void)drawRect:(NSRect)dirty {
    MSLPColour paper = MSLPColourPaper();
    [[NSColor colorWithSRGBRed:paper.red green:paper.green blue:paper.blue alpha:1] setFill];
    NSRectFill(NSIntersectionRect(dirty, self.bounds));
}
- (void)mouseDown:(NSEvent *)event {
    (void)event;
    if (self.onBackgroundClick) self.onBackgroundClick();
}
@end

@interface PassThroughView : FlippedView
@end
@implementation PassThroughView
- (NSView *)hitTest:(NSPoint)point {
    NSView *hit = [super hitTest:point];
    if ([hit isKindOfClass:ClickLabel.class]) return hit;
    if (hit == self || [hit isKindOfClass:NSTextField.class]) return nil;
    return hit;
}
@end

@interface EscapeHint : NSView
@end
@implementation EscapeHint
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSDictionary *attrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:11 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: [NSColor colorWithSRGBRed:0.35 green:0.33 blue:0.31 alpha:0.9],
    };
    [@"Esc to close" drawAtPoint:NSZeroPoint withAttributes:attrs];
}
@end

@interface PopoverRootView : FlippedView
@property(nonatomic) BOOL inspectorSurface;
@end
@implementation PopoverRootView
- (void)drawRect:(NSRect)dirty {
    [NSColor.windowBackgroundColor set];
    NSRectFill(NSIntersectionRect(dirty, self.bounds));
    if (self.inspectorSurface) {
        [[NSColor.controlBackgroundColor colorWithAlphaComponent:.72] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:12 yRadius:12] fill];
        [[NSColor.separatorColor colorWithAlphaComponent:.25] setStroke];
        NSBezierPath *edge=[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds,.5,.5) xRadius:12 yRadius:12];
        edge.lineWidth=1; [edge stroke];
    }
}
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
@end

// One horizontal key for the temperature ramp and the rain hatch. Panels do not draw it.
@interface ChartKeyView : FlippedView
@property (nonatomic) NSInteger temperature;
@property (nonatomic) BOOL showsRain;
@property (nonatomic) BOOL showsObserved;
@property (nonatomic) CGFloat maxWidth;
@property (nonatomic) NSRect rampRect;
@property (nonatomic) NSRect hatchRect;
@property (nonatomic) BOOL drawsRamp;
@property (nonatomic) BOOL drawsHatch;
- (void)rebuild;
@end

// A label cell insets the glyphs, so the frame has to be wider than the measured string
// or the tail is replaced with an ellipsis.
static CGFloat KeyTextWidth(NSString *text, NSFont *font) {
    return TextWidth(text, font) + 10;
}

static NSTextField *KeyLabel(NSString *text, NSFont *font, NSColor *color, CGFloat width, CGFloat height) {
    NSTextField *field = [NSTextField labelWithString:text ?: @""];
    field.translatesAutoresizingMaskIntoConstraints = YES;
    field.font = font;
    field.textColor = color;
    field.lineBreakMode = NSLineBreakByClipping;
    field.drawsBackground = NO;
    field.frame = NSMakeRect(0, 0, width, height);
    return field;
}

@implementation ChartKeyView
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
- (void)rebuild {
    for (NSView *child in self.subviews.copy) [child removeFromSuperview];
    NSFont *font = [NSFont systemFontOfSize:11 weight:NSFontWeightRegular];
    NSFont *tickFont = [NSFont systemFontOfSize:9 weight:NSFontWeightMedium];
    NSColor *ink = NSColor.secondaryLabelColor;
    CGFloat h = 22;
    CGFloat x = 0;
    CGFloat maxW = self.maxWidth > 40 ? self.maxWidth : 10000;
    self.drawsRamp = NO;
    self.drawsHatch = NO;
    self.accessibilityIdentifier = @"chart.legend";
    NSString *note = self.showsRain && self.showsObserved ? @"Rain ≥1 mm /24h · dots since 9am" :
        (self.showsRain ? @"Rain ≥1 mm /24h" : (self.showsObserved ? @"Rain since 9am" : nil));
    CGFloat noteW = note.length ? KeyTextWidth(note, font) : 0;
    CGFloat hatchW = self.showsRain ? 16.0 + 5.0 : 0;
    NSString *name = self.temperature == 1 ? @"850 hPa °C" : (self.temperature == 2 ? @"Surface °C" : @"");
    self.toolTip = self.temperature > 0 ? ChartTemperatureLegend(self.temperature) : note;
    CGFloat nameW = name.length ? KeyTextWidth(name, font) : 0;
    NSString *lo = @"\u221212";
    NSString *hi = @"28";
    CGFloat loW = KeyTextWidth(lo, tickFont);
    CGFloat hiW = KeyTextWidth(hi, tickFont);
    CGFloat (^rampWidth)(CGFloat) = ^CGFloat(CGFloat barW) {
        return loW + 3 + barW + 3 + hiW + 6 + nameW;
    };
    CGFloat rainWidth = hatchW + noteW;
    CGFloat gap = (name.length && note.length) ? 14 : 0;
    CGFloat barW = 56;
    BOOL stacked = NO;
    if (name.length) {
        while (barW > 28 && rampWidth(barW) + gap + rainWidth > maxW) barW -= 4;
        stacked = rampWidth(barW) + gap + rainWidth > maxW;
        if (stacked) {
            barW = 48;
            while (barW > 24 && rampWidth(barW) > maxW) barW -= 4;
        }
    }
    CGFloat rowH = h;
    CGFloat height = h;
    if (stacked) height = h * 2 + 2;
    if (name.length && rampWidth(barW) <= maxW) {
        NSTextField *loField = KeyLabel(lo, tickFont, ink, loW, rowH);
        loField.frame = NSMakeRect(x, 0, loW, rowH);
        [self addSubview:loField];
        x += loW + 3;
        self.rampRect = NSMakeRect(x, floor((rowH - 8) / 2.0), barW, 8);
        self.drawsRamp = YES;
        x += barW + 3;
        NSTextField *hiField = KeyLabel(hi, tickFont, ink, hiW, rowH);
        hiField.frame = NSMakeRect(x, 0, hiW, rowH);
        [self addSubview:hiField];
        x += hiW + 6;
        NSTextField *nameField = KeyLabel(name, font, NSColor.labelColor, nameW, rowH);
        nameField.frame = NSMakeRect(x, 0, nameW, rowH);
        nameField.accessibilityIdentifier = @"chart.legend.temp";
        [self addSubview:nameField];
        x += nameW;
    } else if (name.length) {
        NSTextField *nameField = KeyLabel(name, font, NSColor.labelColor, nameW, rowH);
        nameField.frame = NSMakeRect(0, 0, nameW, rowH);
        nameField.accessibilityIdentifier = @"chart.legend.temp";
        [self addSubview:nameField];
        x = nameW;
    }
    CGFloat rainX = stacked ? 0 : (x > 0 && note.length ? x + gap : x);
    CGFloat rainY = stacked ? h + 2 : 0;
    if (note.length && rainX + rainWidth <= maxW + 0.5) {
        if (self.showsRain) {
            self.hatchRect = NSMakeRect(rainX, rainY + floor((rowH - 12) / 2.0), 16, 12);
            self.drawsHatch = YES;
            rainX += 16 + 5;
        }
        NSTextField *noteField = KeyLabel(note, font, ink, noteW, rowH);
        noteField.frame = NSMakeRect(rainX, rainY, noteW, rowH);
        noteField.accessibilityIdentifier = @"chart.legend.rain";
        [self addSubview:noteField];
        rainX += noteW;
        x = MAX(x, rainX);
    }
    self.frame = NSMakeRect(0, 0, MIN(maxW, MAX(1, ceil(x))), height);
    self.needsDisplay = YES;
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    if (self.drawsRamp && self.rampRect.size.width > 1) {
        CGFloat width = self.rampRect.size.width;
        for (NSInteger i = 0; i < (NSInteger)ceil(width); i++) {
            double t = -12.0 + 40.0 * ((double)i / MAX(width - 1.0, 1.0));
            OwnRGB rgb = OwnTemperatureRGB(t);
            [[NSColor colorWithSRGBRed:rgb.r green:rgb.g blue:rgb.b alpha:1] setFill];
            NSRectFill(NSMakeRect(NSMinX(self.rampRect) + i, NSMinY(self.rampRect), 1, NSHeight(self.rampRect)));
        }
        [[NSColor.separatorColor colorWithAlphaComponent:0.85] setStroke];
        NSBezierPath *edge = [NSBezierPath bezierPathWithRect:NSInsetRect(self.rampRect, 0.25, 0.25)];
        edge.lineWidth = 0.5;
        [edge stroke];
    }
    if (self.drawsHatch) {
        [NSGraphicsContext saveGraphicsState];
        NSRectClip(self.hatchRect);
        NSBezierPath *path = [NSBezierPath bezierPath];
        path.lineWidth = 0.8;
        path.lineCapStyle = NSLineCapStyleButt;
        CGFloat y0 = NSMinY(self.hatchRect);
        CGFloat y1 = NSMaxY(self.hatchRect);
        CGFloat rise = NSHeight(self.hatchRect);
        for (CGFloat s = NSMinX(self.hatchRect) - rise; s < NSMaxX(self.hatchRect); s += 5) {
            [path moveToPoint:NSMakePoint(s, y0)];
            [path lineToPoint:NSMakePoint(s + rise, y1)];
        }
        [[NSColor.labelColor colorWithAlphaComponent:0.7] setStroke];
        [path stroke];
        [NSGraphicsContext restoreGraphicsState];
    }
}
@end

static int DirectLength(const uint8_t *bytes, NSUInteger start, NSUInteger end) {
    const char *key = "/Length";
    for (NSUInteger i = start; i + 8 < end; i++) {
        if (memcmp(bytes + i, key, 7) != 0) continue;
        NSUInteger j = i + 7;
        while (j < end && (bytes[j] == ' ' || bytes[j] == '\n' || bytes[j] == '\r')) j++;
        if (j >= end || bytes[j] < '0' || bytes[j] > '9') continue;
        int value = 0;
        while (j < end && bytes[j] >= '0' && bytes[j] <= '9') {
            value = value * 10 + (bytes[j] - '0');
            j++;
        }
        while (j < end && bytes[j] == ' ') j++;
        if (j < end && bytes[j] == 'R') continue;
        return value;
    }
    return -1;
}

static NSDictionary<NSNumber *, NSData *> *PDFObjects(NSData *pdf) {
    const uint8_t *b = pdf.bytes;
    NSUInteger n = pdf.length;
    NSMutableDictionary *objs = [NSMutableDictionary dictionary];
    NSUInteger i = 0;
    while (i + 6 < n) {
        if (!((i == 0 || b[i - 1] == '\n' || b[i - 1] == '\r') && b[i] >= '0' && b[i] <= '9')) { i++; continue; }
        int num = 0, gen = 0;
        NSUInteger p = i;
        while (p < n && b[p] >= '0' && b[p] <= '9') { num = num * 10 + (b[p] - '0'); p++; }
        if (p >= n || b[p] != ' ') { i++; continue; }
        p++;
        int digits = 0;
        while (p < n && b[p] >= '0' && b[p] <= '9') { gen = gen * 10 + (b[p] - '0'); digits++; p++; }
        if (!digits || p + 4 > n || b[p] != ' ' || memcmp(b + p, " obj", 4) != 0) { i++; continue; }
        (void)gen;
        NSUInteger start = i;
        NSUInteger scan = p + 4;
        NSRange streamAt = NSMakeRange(NSNotFound, 0);
        NSRange endObjAt = NSMakeRange(NSNotFound, 0);
        for (NSUInteger k = scan; k + 6 < n && k < scan + 800000; k++) {
            if (endObjAt.location == NSNotFound && k + 6 <= n && memcmp(b + k, "endobj", 6) == 0)
                endObjAt = NSMakeRange(k, 6);
            if (streamAt.location == NSNotFound && k + 6 <= n && memcmp(b + k, "stream", 6) == 0)
                streamAt = NSMakeRange(k, 6);
            if (endObjAt.location != NSNotFound && (streamAt.location == NSNotFound || endObjAt.location < streamAt.location))
                break;
            if (streamAt.location != NSNotFound && streamAt.location < endObjAt.location) break;
        }
        NSUInteger objEnd = NSNotFound;
        if (streamAt.location != NSNotFound && (endObjAt.location == NSNotFound || streamAt.location < endObjAt.location)) {
            int length = DirectLength(b, start, streamAt.location);
            NSUInteger j = streamAt.location + 6;
            if (j + 1 < n && b[j] == '\r' && b[j + 1] == '\n') j += 2;
            else if (j < n && b[j] == '\n') j += 1;
            NSUInteger es = length >= 0 ? j + (NSUInteger)length : j;
            if (es > n) es = j;
            for (NSUInteger k = es; k + 9 <= n && k < es + 32; k++) {
                if (memcmp(b + k, "endstream", 9) == 0) { es = k; break; }
            }
            for (NSUInteger k = es; k + 6 <= n && k < es + 40; k++) {
                if (memcmp(b + k, "endobj", 6) == 0) { objEnd = k + 6; break; }
            }
        } else if (endObjAt.location != NSNotFound) {
            objEnd = endObjAt.location + 6;
        }
        if (objEnd == NSNotFound || objEnd <= start) { i = p + 4; continue; }
        objs[@(num)] = [pdf subdataWithRange:NSMakeRange(start, objEnd - start)];
        i = objEnd;
    }
    return objs;
}

static NSData *ZlibInflate(NSData *data) {
    if (!data.length) return nil;
    z_stream strm = {0};
    strm.next_in = (Bytef *)data.bytes;
    strm.avail_in = (uInt)data.length;
    if (inflateInit(&strm) != Z_OK) return nil;
    NSMutableData *out = [NSMutableData dataWithLength:MAX((NSUInteger)64, data.length * 4)];
    int rc;
    do {
        if (strm.total_out >= out.length) [out increaseLengthBy:out.length + 65536];
        strm.next_out = (Bytef *)out.mutableBytes + strm.total_out;
        strm.avail_out = (uInt)(out.length - strm.total_out);
        rc = inflate(&strm, Z_NO_FLUSH);
    } while (rc == Z_OK);
    inflateEnd(&strm);
    if (rc != Z_STREAM_END) return nil;
    out.length = strm.total_out;
    return out;
}

static NSData *ZlibDeflate(NSData *data) {
    uLong bound = compressBound((uLong)data.length);
    NSMutableData *out = [NSMutableData dataWithLength:bound];
    uLongf dest = bound;
    if (compress2(out.mutableBytes, &dest, data.bytes, (uLong)data.length, 9) != Z_OK) return nil;
    out.length = dest;
    return out;
}

static NSData *ASCII(NSString *text) {
    return [text dataUsingEncoding:NSASCIIStringEncoding];
}

// Flat fills only. Land grey, sea white, and the title-bar rectangle take the
// Bureau colour chart. Strokes, hatch patterns, labels, and the white title
// glyphs stay as the PDF drew them.
static NSData *RecolourObject(NSData *object) {
    NSRange stream = [object rangeOfData:ASCII(@"stream") options:0 range:NSMakeRange(0, object.length)];
    if (stream.location == NSNotFound) return object;
    const uint8_t *b = object.bytes;
    NSUInteger j = stream.location + stream.length;
    NSData *sep = nil;
    if (j + 1 < object.length && b[j] == '\r' && b[j + 1] == '\n') { sep = ASCII(@"\r\n"); j += 2; }
    else if (j < object.length && b[j] == '\n') { sep = ASCII(@"\n"); j += 1; }
    else return object;
    NSData *dict = [object subdataWithRange:NSMakeRange(0, stream.location)];
    int length = DirectLength(b, 0, stream.location);
    if (length < 0 || j + (NSUInteger)length > object.length) return object;
    NSData *raw = [object subdataWithRange:NSMakeRange(j, (NSUInteger)length)];
    NSData *plain = ZlibInflate(raw);
    if (!plain) return object;
    if ([dict rangeOfData:ASCII(@"/Subtype") options:0 range:NSMakeRange(0, dict.length)].location != NSNotFound)
        return object;
    if ([plain rangeOfData:ASCII(@" scn") options:0 range:NSMakeRange(0, plain.length)].location == NSNotFound
        && [plain rangeOfData:ASCII(@"/GS1") options:0 range:NSMakeRange(0, plain.length)].location == NSNotFound)
        return object;
    NSData *edited = MSLPRecolourStream(plain);
    if (!edited.length || [edited isEqualToData:plain]) return object;
    NSData *comp = ZlibDeflate(edited);
    if (!comp) return object;
    NSMutableData *newDict = [dict mutableCopy];
    NSData *lengthKey = ASCII(@"/Length");
    NSRange key = [newDict rangeOfData:lengthKey options:0 range:NSMakeRange(0, newDict.length)];
    if (key.location == NSNotFound) return object;
    NSUInteger v = key.location + key.length;
    while (v < newDict.length && (((const uint8_t *)newDict.bytes)[v] == ' ' || ((const uint8_t *)newDict.bytes)[v] == '\n')) v++;
    NSUInteger vend = v;
    while (vend < newDict.length && ((const uint8_t *)newDict.bytes)[vend] >= '0' && ((const uint8_t *)newDict.bytes)[vend] <= '9') vend++;
    NSString *digits = [NSString stringWithFormat:@"%lu", (unsigned long)comp.length];
    [newDict replaceBytesInRange:NSMakeRange(v, vend - v) withBytes:digits.UTF8String length:digits.length];
    NSData *rest = [object subdataWithRange:NSMakeRange(j + (NSUInteger)length, object.length - (j + (NSUInteger)length))];
    NSMutableData *rebuilt = [NSMutableData dataWithData:newDict];
    [rebuilt appendData:ASCII(@"stream")];
    [rebuilt appendData:sep];
    [rebuilt appendData:comp];
    [rebuilt appendData:sep];
    [rebuilt appendData:rest];
    return rebuilt;
}

static int PDFTrailerRoot(NSData *pdf);

static NSData *RecolourChartPDF(NSData *pdf) {
    if (!IsPDF(pdf)) return nil;
    NSDictionary<NSNumber *, NSData *> *objs = PDFObjects(pdf);
    int root = PDFTrailerRoot(pdf);
    if (root < 1 || !objs[@(root)]) return nil;
    int maxNum = 0;
    for (NSNumber *n in objs) maxNum = MAX(maxNum, n.intValue);
    NSMutableData *out = [NSMutableData dataWithBytes:"%PDF-1.5\n" length:9];
    NSMutableDictionary<NSNumber *, NSNumber *> *offsets = [NSMutableDictionary dictionary];
    for (int n = 1; n <= maxNum; n++) {
        NSData *body = objs[@(n)];
        if (!body) continue;
        body = RecolourObject(body);
        offsets[@(n)] = @(out.length);
        [out appendData:body];
        if (((const uint8_t *)body.bytes)[body.length - 1] != '\n') [out appendBytes:"\n" length:1];
    }
    NSUInteger xref = out.length;
    NSMutableData *xrefBytes = [NSMutableData data];
    [xrefBytes appendData:ASCII([NSString stringWithFormat:@"xref\n0 %d\n", maxNum + 1])];
    [xrefBytes appendData:ASCII(@"0000000000 65535 f \n")];
    for (int n = 1; n <= maxNum; n++) {
        NSNumber *off = offsets[@(n)];
        NSString *line = off
            ? [NSString stringWithFormat:@"%010ld 00000 n \n", off.longValue]
            : @"0000000000 00000 f \n";
        [xrefBytes appendData:ASCII(line)];
    }
    [xrefBytes appendData:ASCII([NSString stringWithFormat:
        @"trailer\n<</Size %d/Root %d 0 R>>\nstartxref\n%lu\n%%%%EOF\n", maxNum + 1, root, (unsigned long)xref])];
    [out appendData:xrefBytes];
    return out;
}

static NSUInteger FindLiteral(const uint8_t *b, NSUInteger n, NSUInteger from, const char *lit) {
    size_t len = strlen(lit);
    if (!len || from >= n) return NSNotFound;
    const void *hit = memmem(b + from, n - from, lit, len);
    return hit ? (const uint8_t *)hit - b : NSNotFound;
}

static BOOL AtObjectStart(const uint8_t *b, NSUInteger n, NSUInteger i, int *num) {
    if (i >= n || b[i] < '0' || b[i] > '9') return NO;
    if (i > 0 && b[i - 1] != '\n' && b[i - 1] != '\r') return NO;
    NSUInteger p = i;
    int value = 0;
    while (p < n && b[p] >= '0' && b[p] <= '9') {
        value = value * 10 + (b[p] - '0');
        p++;
    }
    if (p >= n || b[p] != ' ') return NO;
    p++;
    int digits = 0;
    while (p < n && b[p] >= '0' && b[p] <= '9') { digits++; p++; }
    if (!digits || p + 4 > n || b[p] != ' ' || memcmp(b + p, " obj", 4) != 0) return NO;
    if (num) *num = value;
    return YES;
}

static int PDFTrailerRoot(NSData *pdf) {
    if (pdf.length < 16) return 0;
    // Linearized Bureau PDFs keep the root near the beginning. Incremental
    // updates may replace it in a later trailer, so use the last reference.
    NSString *text = [[NSString alloc] initWithData:pdf encoding:NSISOLatin1StringEncoding];
    if (!text) return 0;
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
        @"/Root\\s+(\\d+)\\s+\\d+\\s+R" options:0 error:nil];
    NSTextCheckingResult *m = [[re matchesInString:text options:0 range:NSMakeRange(0, text.length)] lastObject];
    if (!m || m.numberOfRanges < 2) return 0;
    return [[text substringWithRange:[m rangeAtIndex:1]] intValue];
}

static NSData *RebuildNumberedPDF(NSDictionary<NSNumber *, NSData *> *objs, int root) {
    int maxNum = 0;
    for (NSNumber *n in objs) maxNum = MAX(maxNum, n.intValue);
    if (root < 1 || !objs[@(root)]) return nil;
    NSMutableData *out = [NSMutableData dataWithBytes:"%PDF-1.4\n" length:9];
    NSMutableDictionary<NSNumber *, NSNumber *> *offsets = [NSMutableDictionary dictionary];
    for (int n = 1; n <= maxNum; n++) {
        NSData *body = objs[@(n)];
        if (!body) continue;
        offsets[@(n)] = @(out.length);
        [out appendData:body];
        if (((const uint8_t *)body.bytes)[body.length - 1] != '\n') [out appendBytes:"\n" length:1];
    }
    NSUInteger xref = out.length;
    NSMutableData *xrefBytes = [NSMutableData data];
    [xrefBytes appendData:ASCII([NSString stringWithFormat:@"xref\n0 %d\n", maxNum + 1])];
    [xrefBytes appendData:ASCII(@"0000000000 65535 f \n")];
    for (int n = 1; n <= maxNum; n++) {
        NSNumber *off = offsets[@(n)];
        NSString *line = off
            ? [NSString stringWithFormat:@"%010ld 00000 n \n", off.longValue]
            : @"0000000000 00000 f \n";
        [xrefBytes appendData:ASCII(line)];
    }
    [xrefBytes appendData:ASCII([NSString stringWithFormat:
        @"trailer\n<</Size %d/Root %d 0 R>>\nstartxref\n%lu\n%%%%EOF\n",
        maxNum + 1, root, (unsigned long)xref])];
    [out appendData:xrefBytes];
    return out;
}

// IDY00050 keeps indirect /Length objects, so the prognosis rewriter does not apply.
// Streams are recoloured and the length objects updated. The original is returned
// when the result is not a readable one-page PDF.
static NSData *RecolourAnalysisDocument(NSData *pdf) {
    if (!IsPDF(pdf)) return nil;
    double cropWidth = 0;
    CGPDFDocumentRef probe = PDFDocumentFromData(pdf);
    if (probe) {
        CGPDFPageRef page = CGPDFDocumentGetPage(probe, 1);
        if (page) {
            CGRect media = CGPDFPageGetBoxRect(page, kCGPDFMediaBox);
            AnalysisGeo geo = AnalysisGeoreference(pdf);
            cropWidth = AnalysisPopoverCrop(geo, media.size.width, media.size.height).width;
        }
        CGPDFDocumentRelease(probe);
    }
    const uint8_t *b = pdf.bytes;
    NSUInteger n = pdf.length;
    NSMutableDictionary<NSNumber *, NSData *> *objs = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSNumber *, NSNumber *> *lengths = [NSMutableDictionary dictionary];
    NSUInteger i = 0;
    while (i + 6 < n) {
        int num = 0;
        if (!AtObjectStart(b, n, i, &num)) { i++; continue; }
        NSUInteger endObj = FindLiteral(b, n, i + 4, "endobj");
        NSUInteger streamAt = FindLiteral(b, n, i + 4, "stream");
        if (endObj == NSNotFound) break;
        if (streamAt == NSNotFound || streamAt > endObj) {
            NSUInteger end = endObj + 6;
            if (end <= i) { i++; continue; }
            objs[@(num)] = [pdf subdataWithRange:NSMakeRange(i, end - i)];
            i = end;
            continue;
        }
        NSUInteger endStream = FindLiteral(b, n, streamAt + 6, "endstream");
        if (endStream == NSNotFound) break;
        endObj = FindLiteral(b, n, endStream + 9, "endobj");
        if (endObj == NSNotFound) break;
        NSUInteger dataAt = streamAt + 6;
        if (dataAt + 1 < endStream && b[dataAt] == '\r' && b[dataAt + 1] == '\n') dataAt += 2;
        else if (dataAt < endStream && b[dataAt] == '\n') dataAt += 1;
        NSUInteger dataEnd = endStream;
        if (dataEnd > dataAt && b[dataEnd - 1] == '\n') {
            dataEnd--;
            if (dataEnd > dataAt && b[dataEnd - 1] == '\r') dataEnd--;
        }
        NSUInteger objEnd = endObj + 6;
        NSData *original = objEnd > i ? [pdf subdataWithRange:NSMakeRange(i, objEnd - i)] : nil;
        NSData *raw = dataEnd > dataAt ? [pdf subdataWithRange:NSMakeRange(dataAt, dataEnd - dataAt)] : nil;
        NSData *plain = ZlibInflate(raw);
        NSData *edited = plain ? AnalysisPopoverStream(plain, cropWidth) : nil;
        NSData *comp = (edited && ![edited isEqualToData:plain]) ? ZlibDeflate(edited) : nil;
        if (!comp || !original) {
            if (original) objs[@(num)] = original;
            i = objEnd;
            continue;
        }
        NSData *dict = [pdf subdataWithRange:NSMakeRange(i, streamAt - i)];
        NSString *dictText = [[NSString alloc] initWithData:dict encoding:NSISOLatin1StringEncoding];
        NSRegularExpression *indirect = [NSRegularExpression regularExpressionWithPattern:
            @"/Length\\s+(\\d+)\\s+\\d+\\s+R" options:0 error:nil];
        NSTextCheckingResult *ref = dictText ? [indirect firstMatchInString:dictText options:0
            range:NSMakeRange(0, dictText.length)] : nil;
        if (ref && ref.numberOfRanges >= 2)
            lengths[@([[dictText substringWithRange:[ref rangeAtIndex:1]] intValue])] = @(comp.length);
        NSMutableData *rebuilt = [dict mutableCopy];
        if (!rebuilt.length || ((const uint8_t *)rebuilt.bytes)[rebuilt.length - 1] != '\n')
            [rebuilt appendBytes:"\n" length:1];
        [rebuilt appendBytes:"stream\n" length:7];
        [rebuilt appendData:comp];
        [rebuilt appendBytes:"\nendstream\nendobj" length:17];
        objs[@(num)] = rebuilt;
        i = objEnd;
    }
    NSRegularExpression *bare = [NSRegularExpression regularExpressionWithPattern:
        @"(obj\\s+)\\d+(\\s+endobj)" options:0 error:nil];
    for (NSNumber *key in lengths) {
        NSData *body = objs[key];
        NSString *text = [[NSString alloc] initWithData:body encoding:NSISOLatin1StringEncoding];
        if (!text || ![bare firstMatchInString:text options:0 range:NSMakeRange(0, text.length)]) continue;
        NSString *updated = [bare stringByReplacingMatchesInString:text options:0
            range:NSMakeRange(0, text.length)
            withTemplate:[NSString stringWithFormat:@"$1%@$2", lengths[key]]];
        NSData *next = [updated dataUsingEncoding:NSISOLatin1StringEncoding];
        if (next) objs[key] = next;
    }
    NSData *rebuilt = RebuildNumberedPDF(objs, PDFTrailerRoot(pdf));
    CGPDFDocumentRef doc = PDFDocumentFromData(rebuilt);
    if (!doc) return nil;
    CGPDFDocumentRelease(doc);
    return rebuilt;
}

static NSColor *MSLPNSColour(MSLPColour colour) {
    return [NSColor colorWithSRGBRed:colour.red green:colour.green blue:colour.blue alpha:1];
}
static NSColor *SeaColour(void) { return MSLPNSColour(MSLPColourSea()); }

@interface PDFCropView : NSView
@property (nonatomic, copy) void (^onClick)(void);
@property (nonatomic, copy) void (^onMagnify)(CGFloat delta);
@property (nonatomic) BOOL drawsFrame;
@property (nonatomic) NSInteger sequenceIndex;
@property (nonatomic, copy) NSArray<NSDictionary *> *mapDetails;
- (void)setDocument:(CGPDFDocumentRef)document crop:(CGRect)crop;
- (void)setChartImage:(NSImage *)image comparison:(NSImage *)comparison alpha:(CGFloat)alpha;
- (void)setPins:(NSArray<NSDictionary *> *)pins;
- (void)setComparisonDocument:(CGPDFDocumentRef)document crop:(CGRect)crop alpha:(CGFloat)alpha;
- (void)clearComparison;
- (void)attachMoviePlayer:(AVPlayer *)player;
- (void)removeMoviePlayer;
@end

static CGImageRef ChartCropImage(CGPDFDocumentRef document, CGRect crop, size_t pw, size_t ph) {
    if (!document || crop.size.width < 1 || crop.size.height < 1 || pw < 1 || ph < 1) return NULL;
    CGPDFPageRef page = CGPDFDocumentGetPage(document, 1);
    if (!page) return NULL;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef bitmap = CGBitmapContextCreate(NULL, pw, ph, 8, pw * 4, cs,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(cs);
    if (!bitmap) return NULL;
    CGContextSetFillColorWithColor(bitmap, SeaColour().CGColor);
    CGContextFillRect(bitmap, CGRectMake(0, 0, pw, ph));
    CGContextSaveGState(bitmap);
    CGFloat sx = pw / crop.size.width;
    CGFloat sy = ph / crop.size.height;
    CGContextTranslateCTM(bitmap, -crop.origin.x * sx, -crop.origin.y * sy);
    CGContextScaleCTM(bitmap, sx, sy);
    CGContextClipToRect(bitmap, crop);
    CGContextDrawPDFPage(bitmap, page);
    CGContextRestoreGState(bitmap);
    CGImageRef image = CGBitmapContextCreateImage(bitmap);
    CGContextRelease(bitmap);
    return image;
}

@implementation PDFCropView {
    CGPDFDocumentRef _document;
    CGRect _crop;
    CGImageRef _cache;
    size_t _cacheW, _cacheH;
    CGPDFDocumentRef _compareDoc;
    CGRect _compareCrop;
    CGFloat _compareAlpha;
    CGImageRef _compareCache;
    size_t _compareW, _compareH;
    NSArray<NSDictionary *> *_pins;
    NSImage *_chartImage;
    NSImage *_compareImage;
    AVPlayerLayer *_movieLayer;
    NSPoint _down, _last;
    BOOL _dragged;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (void)dealloc {
    [_movieLayer removeFromSuperlayer];
    if (_cache) CGImageRelease(_cache);
    if (_compareCache) CGImageRelease(_compareCache);
    if (_document) CGPDFDocumentRelease(_document);
    if (_compareDoc) CGPDFDocumentRelease(_compareDoc);
}
- (void)resetCursorRects {
    if (self.onClick) [self addCursorRect:self.bounds cursor:NSCursor.pointingHandCursor];
}
- (void)setFrameSize:(NSSize)size {
    if (!NSEqualSizes(size, self.frame.size)) {
        if (_cache) { CGImageRelease(_cache); _cache = NULL; }
        if (_compareCache) { CGImageRelease(_compareCache); _compareCache = NULL; }
    }
    [super setFrameSize:size];
    _movieLayer.frame = self.bounds;
}
- (void)attachMoviePlayer:(AVPlayer *)player {
    if (_movieLayer.player == player && _movieLayer.superlayer == self.layer) return;
    [self removeMoviePlayer];
    self.wantsLayer = YES;
    _movieLayer = [AVPlayerLayer playerLayerWithPlayer:player];
    _movieLayer.videoGravity = AVLayerVideoGravityResizeAspect;
    _movieLayer.frame = self.bounds;
    _movieLayer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    [self.layer addSublayer:_movieLayer];
    self.needsDisplay = YES;
}
- (void)removeMoviePlayer {
    [_movieLayer removeFromSuperlayer];
    _movieLayer = nil;
}
- (void)clearComparison {
    _compareImage=nil;
    [self setComparisonDocument:NULL crop:CGRectZero alpha:0];
    self.needsDisplay=YES;
}
- (void)setDocument:(CGPDFDocumentRef)document crop:(CGRect)crop {
    if (document == _document && CGRectEqualToRect(crop, _crop) && !_chartImage) return;
    [self removeMoviePlayer];
    if (document) CGPDFDocumentRetain(document);
    if (_document) CGPDFDocumentRelease(_document);
    _document = document;
    _crop = crop;
    _chartImage = nil;
    _compareImage = nil;
    if (_cache) { CGImageRelease(_cache); _cache = NULL; }
    self.needsDisplay = YES;
}
- (void)setChartImage:(NSImage *)image comparison:(NSImage *)comparison alpha:(CGFloat)alpha {
    [self removeMoviePlayer];
    _chartImage = image;
    _compareImage = comparison;
    _compareAlpha = alpha;
    if (_document) { CGPDFDocumentRelease(_document); _document = NULL; }
    if (_compareDoc) { CGPDFDocumentRelease(_compareDoc); _compareDoc = NULL; }
    if (_cache) { CGImageRelease(_cache); _cache = NULL; }
    if (_compareCache) { CGImageRelease(_compareCache); _compareCache = NULL; }
    self.needsDisplay = YES;
}
- (void)setMapDetails:(NSArray<NSDictionary *> *)details {
    if (_mapDetails==details || [_mapDetails isEqualToArray:details]) return;
    _mapDetails = [details copy];
    self.toolTip = [[details valueForKey:@"summary"] componentsJoinedByString:@"\n"];
    self.needsDisplay = YES;
}
- (void)setPins:(NSArray<NSDictionary *> *)pins {
    _pins = [pins copy];
    self.needsDisplay = YES;
}
- (void)setComparisonDocument:(CGPDFDocumentRef)document crop:(CGRect)crop alpha:(CGFloat)alpha {
    BOOL same = document == _compareDoc && CGRectEqualToRect(crop, _compareCrop) && fabs(alpha - _compareAlpha) < 0.001;
    if (same) return;
    if (document) CGPDFDocumentRetain(document);
    if (_compareDoc) CGPDFDocumentRelease(_compareDoc);
    _compareDoc = document;
    _compareCrop = crop;
    _compareAlpha = alpha;
    if (_compareCache) { CGImageRelease(_compareCache); _compareCache = NULL; }
    self.needsDisplay = YES;
}
- (void)ensureCacheInContext:(CGContextRef)ctx {
    if (!_document || _crop.size.width < 1 || _crop.size.height < 1 || !ctx) return;
    CGRect dev = CGContextConvertRectToDeviceSpace(ctx, self.bounds);
    size_t pw = MAX((size_t)1, (size_t)llround(fabs(dev.size.width)));
    size_t ph = MAX((size_t)1, (size_t)llround(fabs(dev.size.height)));
    if (_cache && _cacheW == pw && _cacheH == ph) return;
    CGImageRef image = ChartCropImage(_document, _crop, pw, ph);
    if (!image) return;
    if (_cache) CGImageRelease(_cache);
    _cache = image;
    _cacheW = pw;
    _cacheH = ph;
}
- (void)ensureCompareCacheInContext:(CGContextRef)ctx {
    if (!_compareDoc || _compareAlpha <= 0 || _compareCrop.size.width < 1 || !ctx) return;
    CGRect dev = CGContextConvertRectToDeviceSpace(ctx, self.bounds);
    size_t pw = MAX((size_t)1, (size_t)llround(fabs(dev.size.width)));
    size_t ph = MAX((size_t)1, (size_t)llround(fabs(dev.size.height)));
    if (_compareCache && _compareW == pw && _compareH == ph) return;
    CGImageRef image = ChartCropImage(_compareDoc, _compareCrop, pw, ph);
    if (!image) return;
    if (_compareCache) CGImageRelease(_compareCache);
    _compareCache = image;
    _compareW = pw;
    _compareH = ph;
}
- (void)drawPins {
    if (_pins.count == 0 || _crop.size.width < 1 || _crop.size.height < 1) return;
    CGFloat width = NSWidth(self.bounds);
    CGFloat height = NSHeight(self.bounds);
    // A small unlabelled dot: the owner knows where he lives, and a name label covers the isobars.
    NSColor *blue = MSLPNSColour(MSLPColourTitle());
    for (NSDictionary *pin in _pins) {
        CGFloat pdfX = [pin[@"x"] doubleValue];
        CGFloat pdfY = [pin[@"y"] doubleValue];
        CGFloat vx = (pdfX - _crop.origin.x) / _crop.size.width * width;
        CGFloat vy = (_crop.origin.y + _crop.size.height - pdfY) / _crop.size.height * height;
        if (vx < 1 || vy < 1 || vx > width - 1 || vy > height - 1) continue;
        [NSColor.whiteColor setFill];
        [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(vx - 4, vy - 4, 8, 8)] fill];
        [blue setFill];
        [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(vx - 2.5, vy - 2.5, 5, 5)] fill];
    }
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [SeaColour() setFill];
    NSRectFill(self.bounds);
    if (_chartImage) {
        [_chartImage drawInRect:self.bounds fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1 respectFlipped:YES hints:nil];
        if (_compareImage && _compareAlpha > 0)
            [_compareImage drawInRect:self.bounds fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:_compareAlpha respectFlipped:YES hints:nil];
        DrawMapDetails(self.mapDetails, self.bounds);
        if (self.drawsFrame) {
            [[NSColor colorWithSRGBRed:0x26 / 255.0 green:0x23 / 255.0 blue:0x22 / 255.0 alpha:0.55] setStroke];
            NSBezierPath *frame = [NSBezierPath bezierPathWithRect:NSInsetRect(self.bounds, 0.5, 0.5)];
            frame.lineWidth = 1;
            [frame stroke];
        }
        return;
    }
    CGContextRef ctx = NSGraphicsContext.currentContext.CGContext;
    [self ensureCacheInContext:ctx];
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, 0, NSHeight(self.bounds));
    CGContextScaleCTM(ctx, 1, -1);
    if (_cache) CGContextDrawImage(ctx, CGRectMake(0, 0, NSWidth(self.bounds), NSHeight(self.bounds)), _cache);
    [self ensureCompareCacheInContext:ctx];
    if (_compareCache && _compareAlpha > 0) {
        CGContextSetAlpha(ctx, _compareAlpha);
        CGContextDrawImage(ctx, CGRectMake(0, 0, NSWidth(self.bounds), NSHeight(self.bounds)), _compareCache);
    }
    CGContextRestoreGState(ctx);
    [self drawPins];
    DrawMapDetails(self.mapDetails, self.bounds);
    if (self.drawsFrame) {
        [[NSColor colorWithSRGBRed:0x26 / 255.0 green:0x23 / 255.0 blue:0x22 / 255.0 alpha:0.55] setStroke];
        NSBezierPath *frame = [NSBezierPath bezierPathWithRect:NSInsetRect(self.bounds, 0.5, 0.5)];
        frame.lineWidth = 1;
        [frame stroke];
    }
}
- (BOOL)acceptsFirstResponder { return self.onClick != nil; }
- (BOOL)isAccessibilityElement { return self.onClick != nil; }
- (BOOL)accessibilityPerformPress { if (!self.onClick) return NO; self.onClick(); return YES; }
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode == 36 && self.onClick) self.onClick();
    else [super keyDown:event];
}
- (void)mouseDown:(NSEvent *)event {
    _down = _last = [self convertPoint:event.locationInWindow fromView:nil];
    _dragged = NO;
}
- (void)mouseDragged:(NSEvent *)event {
    if (!self.enclosingScrollView) return;
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    if (fabs(p.x - _down.x) >= 4 || fabs(p.y - _down.y) >= 4) _dragged = YES;
    if (_dragged) {
        NSRect vis = self.visibleRect;
        [self scrollPoint:NSMakePoint(NSMinX(vis) - (p.x - _last.x), NSMinY(vis) - (p.y - _last.y))];
    }
    _last = p;
}
- (void)mouseUp:(NSEvent *)event {
    (void)event;
    if (!_dragged && self.onClick) self.onClick();
}
- (void)magnifyWithEvent:(NSEvent *)event {
    if (self.onMagnify && event.phase != NSEventPhaseCancelled) self.onMagnify(event.magnification);
}
@end

@interface HairlineView : NSView
@end
@implementation HairlineView
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [NSColor.separatorColor setFill];
    NSRectFill(self.bounds);
}
@end

static NSString *ForecastDay(NSDate *date, NSDate *now, NSTimeZone *zone) {
    if (!date) return @"";
    if (now && fabs([date timeIntervalSinceDate:now])<1800) return @"Now";
    NSCalendar *calendar=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; calendar.timeZone=zone;
    NSInteger days=[calendar components:NSCalendarUnitDay fromDate:[calendar startOfDayForDate:now ?: NSDate.date] toDate:[calendar startOfDayForDate:date] options:0].day;
    if (days==0) return @"Today";
    if (days==1) return @"Tomorrow";
    NSDateFormatter *format=[NSDateFormatter new]; format.timeZone=zone; format.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"]; format.dateFormat=@"EEE";
    return [format stringFromDate:date];
}

@interface TimelineStrip : NSView
@property (nonatomic, copy) NSArray<NSString *> *labels;
@property (nonatomic, copy) NSArray<NSString *> *clocks;
@property (nonatomic, copy) NSArray<NSNumber *> *dayKeys;
@property (nonatomic, copy) NSArray<NSDate *> *times;
@property (nonatomic, copy) NSArray<NSString *> *tips;
@property NSInteger leftIndex;
@property NSInteger rightIndex;
@property NSInteger hoverIndex;
@property CGFloat progress;
@property BOOL preservesInteraction;
@property (nonatomic, readonly) BOOL pointerScrubbing;
@property (nonatomic, readonly) double previewRestoreFraction;
@property (nonatomic, copy) void (^onSelect)(NSInteger index);
@property (nonatomic, copy) void (^onHover)(NSInteger index);
@property (nonatomic, copy) void (^onSeek)(double fraction);
@property (nonatomic, copy) void (^onPreview)(double fraction);
@end

@implementation TimelineStrip
{
    BOOL _dragging;
    BOOL _hovering;
    BOOL _previewHasDisplayed;
    double _previewDisplayed;
    double _previewRestoreFraction;
    BOOL _previewHasRestoreFraction;
    NSArray *_rulerDays, *_rulerHours;
    NSArray *_rulerTimes;
    CGFloat _rulerWidth;
    NSDateFormatter *_selectionFormatter;
}
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (self) { self.hoverIndex = -1; self.progress = NAN; }
    return self;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)pointerScrubbing { return _dragging || _hovering; }
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    if (!self.window && !self.preservesInteraction) {
        _dragging = NO;
        _hovering = NO;
        _previewHasRestoreFraction = NO;
    }
}
- (BOOL)acceptsFirstResponder { return self.onSeek != nil; }
- (void)setOnSeek:(void (^)(double))onSeek {
    _onSeek = [onSeek copy];
    [self updateTrackingAreas];
    [self resetCursorRects];
}
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return self.onSeek ? NSAccessibilitySliderRole : NSAccessibilityGroupRole; }
- (NSString *)accessibilityLabel { return @"Forecast time"; }
- (id)accessibilityValue { return @(isfinite(self.progress) ? self.progress : 0); }
- (id)accessibilityMinValue { return @0; }
- (id)accessibilityMaxValue { return @1; }
- (NSString *)accessibilityValueDescription {
    if (self.times.count < 2) return @"";
    NSDate *date = [self.times.firstObject dateByAddingTimeInterval:
        [self.times.lastObject timeIntervalSinceDate:self.times.firstObject] * (isfinite(self.progress) ? self.progress : 0)];
    NSDateFormatter *format = [NSDateFormatter new]; format.timeZone = OwnerZone(); format.dateFormat = @"EEEE h a";
    return [format stringFromDate:date];
}
- (void)setAccessibilityValue:(id)value { if (self.onSeek) self.onSeek(MIN(1, MAX(0, [value doubleValue]))); }
- (void)stepHour:(NSInteger)direction {
    NSTimeInterval span = [self.times.lastObject timeIntervalSinceDate:self.times.firstObject];
    if (self.onSeek && span > 0) {
        double epoch = self.times.firstObject.timeIntervalSince1970 + (isfinite(self.progress) ? self.progress : 0) * span;
        // Pointer scrubbing is continuous; keys still choose whole hours.
        double hour = (round(epoch / 3600.0) + direction) * 3600.0;
        self.onSeek(MIN(1, MAX(0, (hour - self.times.firstObject.timeIntervalSince1970) / span)));
    }
}
- (BOOL)accessibilityPerformIncrement { [self stepHour:1]; return YES; }
- (BOOL)accessibilityPerformDecrement { [self stepHour:-1]; return YES; }
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode == 123) [self stepHour:-1];
    else if (event.keyCode == 124) [self stepHour:1];
    else if (event.keyCode == 115 && self.onSeek) self.onSeek(0);
    else if (event.keyCode == 119 && self.onSeek) self.onSeek(1);
    else [super keyDown:event];
}
- (void)resetCursorRects {
    if (self.onSelect || self.onSeek) [self addCursorRect:self.bounds cursor:NSCursor.pointingHandCursor];
}
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
    // Once entered, keep tracking a little above and below the ruler. The
    // pointer can drift vertically without ending a horizontal time scrub.
    NSRect hoverRect = self.onSeek ? NSInsetRect(self.bounds, 0, -36) : self.bounds;
    NSTrackingArea *area = [[NSTrackingArea alloc] initWithRect:hoverRect
        options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways
        owner:self userInfo:nil];
    [self addTrackingArea:area];
}
- (NSRect)trackRect {
    return NSInsetRect(self.bounds, self.onSeek ? 12 : 0, 1);
}
- (NSInteger)indexAt:(NSPoint)p {
    NSRect track = [self trackRect];
    if (!NSPointInRect(p, track) || self.labels.count < 2) return -1;
    CGFloat segW = NSWidth(track) / self.labels.count;
    if (segW < 1) return -1;
    NSInteger index = (NSInteger)floor((p.x - NSMinX(track)) / segW);
    if (index < 0) index = 0;
    if (index >= (NSInteger)self.labels.count) index = (NSInteger)self.labels.count - 1;
    return index;
}
- (double)fractionAt:(NSPoint)p {
    NSRect track = [self trackRect];
    if (NSWidth(track) <= 1) return 0;
    return MIN(1.0, MAX(0.0, (p.x - NSMinX(track)) / NSWidth(track)));
}
- (double)currentPreviewFraction {
    if (_previewHasDisplayed && isfinite(_previewDisplayed)) return _previewDisplayed;
    return isfinite(self.progress) ? MIN(1, MAX(0, self.progress)) : 0;
}
- (double)previewRestoreFraction {
    return _previewHasRestoreFraction ? _previewRestoreFraction : [self currentPreviewFraction];
}
- (void)retargetPreview:(double)fraction {
    fraction = MIN(1, MAX(0, fraction));
    // Send every pointer position to the asynchronous renderer. It keeps only
    // the newest queued frame, while the strip never waits for a timer to show
    // where the pointer has arrived.
    _previewDisplayed = fraction;
    _previewHasDisplayed = YES;
    self.progress=fraction; self.needsDisplay=YES;
    [self deliverScrubFraction:fraction];
}
- (void)deliverScrubFraction:(double)fraction {
    if (_dragging) { if (self.onSeek) self.onSeek(fraction); }
    else if (_hovering) { if (self.onPreview) self.onPreview(fraction); }
}
- (void)finishPreviewAtCurrentTime {
    _previewHasDisplayed = NO;
    if (_previewHasRestoreFraction && self.onPreview) self.onPreview(NAN);
    _previewHasRestoreFraction = NO;
    self.needsDisplay = YES;
}
- (void)removeFromSuperview {
    if (self.preservesInteraction) { [super removeFromSuperview]; return; }
    _previewHasDisplayed = NO;
    _previewHasRestoreFraction = NO;
    _dragging = NO;
    _hovering = NO;
    [super removeFromSuperview];
}
- (void)mouseDown:(NSEvent *)event {
    if (!self.onSelect && !self.onSeek) return;
    _dragging = YES;
    _previewHasRestoreFraction = NO;
    [self.window makeFirstResponder:self];
    NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
    if (self.onSeek) {
        [self retargetPreview:[self fractionAt:point]];
    }
    else {
        NSInteger index = [self indexAt:point];
        if (index >= 0) self.onSelect(index);
    }
}
- (void)mouseDragged:(NSEvent *)event {
    if (!_dragging) return;
    NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
    if (self.onSeek) [self retargetPreview:[self fractionAt:point]];
    else if (self.onSelect) {
        NSInteger index = [self indexAt:point];
        if (index >= 0) self.onSelect(index);
    }
}
- (void)mouseUp:(NSEvent *)event {
    if (_dragging && self.onSeek) {
        NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
        double fraction = [self fractionAt:point];
        _previewDisplayed = fraction; _previewHasDisplayed = YES;
        self.onSeek(fraction);
        self.progress = fraction;
    }
    _dragging = NO;
    _hovering = NO;
    _previewHasRestoreFraction = NO;
}
- (void)mouseEntered:(NSEvent *)event { [self mouseMoved:event]; }
- (void)mouseMoved:(NSEvent *)event {
    if (self.onSeek) {
        if (!_dragging && self.onPreview) {
            NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
            NSRect hoverRect = _hovering ? NSInsetRect(self.bounds, 0, -36) : self.bounds;
            if (NSPointInRect(point, hoverRect)) {
                if (!_hovering) {
                    _hovering = YES; self.needsDisplay = YES;
                    _previewRestoreFraction = [self currentPreviewFraction];
                    _previewHasRestoreFraction = YES;
                    _previewHasDisplayed = YES;
                    _previewDisplayed = _previewRestoreFraction;
                }
                [self retargetPreview:[self fractionAt:point]];
            }
        }
        return;
    }
    NSInteger index = [self indexAt:[self convertPoint:event.locationInWindow fromView:nil]];
    if (index == self.hoverIndex) return;
    self.hoverIndex = index;
    if (index >= 0 && index < (NSInteger)self.tips.count) self.toolTip = self.tips[index];
    else self.toolTip = nil;
    self.needsDisplay = YES;
    if (self.onHover) self.onHover(index);
}
- (void)mouseExited:(NSEvent *)event {
    (void)event;
    if (self.onSeek) {
        if (_dragging) return;
        _hovering = NO; self.needsDisplay = YES;
        [self finishPreviewAtCurrentTime];
        return;
    }
    if (self.hoverIndex < 0) return;
    self.hoverIndex = -1;
    self.toolTip = nil;
    self.needsDisplay = YES;
    if (self.onHover) self.onHover(-1);
}
- (void)prepareRuler {
    CGFloat width=NSWidth([self trackRect]);
    if (_rulerDays && _rulerWidth==width && [_rulerTimes isEqualToArray:self.times]) return;
    _rulerWidth=width; _rulerTimes=[self.times copy];
    NSDate *first=self.times.firstObject, *last=self.times.lastObject;
    NSTimeInterval span=[last timeIntervalSinceDate:first];
    NSMutableArray *days=[NSMutableArray array], *hours=[NSMutableArray array];
    if (span>0) {
        NSCalendar *cal=[NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian]; cal.timeZone=OwnerZone();
        NSDateFormatter *format=[NSDateFormatter new]; format.timeZone=OwnerZone();
        format.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
        for (NSDate *date=[cal startOfDayForDate:first]; [date compare:last]==NSOrderedAscending;) {
            NSDate *next=[cal dateByAddingUnit:NSCalendarUnitDay value:1 toDate:date options:0];
            format.dateFormat=@"EEE";
            [days addObject:@{@"left":@(MAX(0,[date timeIntervalSinceDate:first]/span)),
                @"right":@(MIN(1,[next timeIntervalSinceDate:first]/span)),@"label":[format stringFromDate:date]}];
            date=next;
        }
        NSInteger step=width/(span/3600/6)>=46?6:12;
        NSDate *date=[cal dateByAddingUnit:NSCalendarUnitHour value:step toDate:[cal startOfDayForDate:first] options:0];
        format.dateFormat=@"ha";
        while ([date compare:last]!=NSOrderedDescending) {
            double fraction=[date timeIntervalSinceDate:first]/span;
            if (fraction>=0) [hours addObject:@{@"fraction":@(fraction),@"label":[format stringFromDate:date].lowercaseString}];
            date=[cal dateByAddingUnit:NSCalendarUnitHour value:step toDate:date options:0];
        }
    }
    _rulerDays=days; _rulerHours=hours;
    if (!_selectionFormatter) {
        _selectionFormatter=[NSDateFormatter new]; _selectionFormatter.timeZone=OwnerZone();
        _selectionFormatter.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
        _selectionFormatter.dateFormat=@"EEE h:mm a";
    }
}
- (void)drawTimeSlider {
    [self prepareRuler];
    NSRect track=[self trackRect];
    CGFloat start=NSMinX(track), width=NSWidth(track);
    BOOL tall=NSHeight(track)>=106;
    CGFloat lineY=tall?44:32;
    NSColor *accent=NSColor.controlAccentColor;
    NSDictionary *dayStyle=@{NSFontAttributeName:[NSFont systemFontOfSize:11 weight:NSFontWeightSemibold],NSForegroundColorAttributeName:NSColor.secondaryLabelColor};
    NSDictionary *hourStyle=@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:10 weight:NSFontWeightRegular],NSForegroundColorAttributeName:NSColor.secondaryLabelColor};
    NSUInteger index=0;
    for (NSDictionary *day in _rulerDays) {
        CGFloat x=start+width*[day[@"left"] doubleValue], end=start+width*[day[@"right"] doubleValue];
        if (index++%2==0) {
            [[NSColor.labelColor colorWithAlphaComponent:.025] setFill];
            [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(x,tall?52:40,end-x,tall?52:36) xRadius:4 yRadius:4] fill];
        }
        NSString *text=day[@"label"]; CGFloat w=[text sizeWithAttributes:dayStyle].width;
        if (end-x>w+6) [text drawAtPoint:NSMakePoint((x+end-w)/2,tall?83:61) withAttributes:dayStyle];
    }
    CGFloat previousRight=-100;
    for (NSDictionary *hour in _rulerHours) {
        CGFloat x=start+width*[hour[@"fraction"] doubleValue];
        NSString *text=hour[@"label"]; CGFloat w=[text sizeWithAttributes:hourStyle].width;
        CGFloat left=MIN(start+width-w,MAX(start,x-w/2));
        if (left<previousRight+12) continue;
        [text drawAtPoint:NSMakePoint(left,tall?59:44) withAttributes:hourStyle]; previousRight=left+w;
        [[NSColor.separatorColor colorWithAlphaComponent:.5] setFill]; NSRectFill(NSMakeRect(x-.5,tall?48:34,1,4));
    }
    [[NSColor.labelColor colorWithAlphaComponent:.12] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(start,lineY-1.5,width,3) xRadius:1.5 yRadius:1.5] fill];
    double fraction=isfinite(self.progress)?MIN(1,MAX(0,self.progress)):0;
    CGFloat cursor=start+width*fraction;
    [accent setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(start,lineY-1.5,width*fraction,3) xRadius:1.5 yRadius:1.5] fill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(cursor-5,lineY-5,10,10)] fill];
    NSDate *first=self.times.firstObject, *last=self.times.lastObject;
    NSTimeInterval span=[last timeIntervalSinceDate:first];
    if (span>0) {
        NSString *selected=[_selectionFormatter stringFromDate:[first dateByAddingTimeInterval:span*fraction]].lowercaseString;
        selected=[selected stringByReplacingCharactersInRange:NSMakeRange(0,1) withString:[[selected substringToIndex:1] uppercaseString]];
        NSDictionary *style=@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightMedium],NSForegroundColorAttributeName:accent};
        CGFloat w=[selected sizeWithAttributes:style].width;
        CGFloat x=MAX(start,MIN(start+width-w,cursor-w/2));
        [[accent colorWithAlphaComponent:_hovering?.12:.07] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(x-6,3,w+12,21) xRadius:6 yRadius:6] fill];
        [selected drawAtPoint:NSMakePoint(x,6) withAttributes:style];
    }
    if (self.window.firstResponder==self) {
        [NSColor.keyboardFocusIndicatorColor setStroke];
        NSBezierPath *focus=[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds,1,1) xRadius:6 yRadius:6];
        focus.lineWidth=2; [focus stroke];
    }
}
- (BOOL)isDarkAppearance {
    NSAppearance *appearance = nil;
    for (NSView *view = self; view; view = view.superview)
        if (view.appearance) { appearance = view.appearance; break; }
    if (!appearance) appearance = NSApp.effectiveAppearance;
    NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[
        NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
    return [match isEqualToString:NSAppearanceNameDarkAqua];
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSUInteger n = self.labels.count;
    if (n < 2) return;
    if (self.onSeek) { [self drawTimeSlider]; return; }
    BOOL dark = [self isDarkAppearance];
    NSRect track = [self trackRect];
    NSBezierPath *background = [NSBezierPath bezierPathWithRoundedRect:track xRadius:8 yRadius:8];
    NSColor *trackColour = dark
        ? [NSColor colorWithSRGBRed:1 green:1 blue:1 alpha:0.10]
        : [NSColor colorWithSRGBRed:0.925 green:0.914 blue:0.894 alpha:1];
    [trackColour setFill];
    [background fill];
    if (isfinite(self.progress)) {
        CGFloat x = NSMinX(track) + NSWidth(track) * MIN(1, MAX(0, self.progress));
        [[NSColor.controlAccentColor colorWithAlphaComponent:0.95] setFill];
        NSRect progress = NSMakeRect(x - 1, NSMinY(track) + 3, 2, NSHeight(track) - 6);
        NSRectFill(progress);
        NSRect knob = NSMakeRect(x - 4, NSMinY(track) + 2, 8, 8);
        [[NSColor.controlAccentColor colorWithAlphaComponent:1] setFill];
        [[NSBezierPath bezierPathWithOvalInRect:knob] fill];
    }
    CGFloat segW = NSWidth(track) / n;
    NSInteger lo = MIN(self.leftIndex, self.rightIndex);
    NSInteger hi = MAX(self.leftIndex, self.rightIndex);
    BOOL spanned = lo >= 0 && hi >= lo && hi < (NSInteger)n;
    if (spanned) {
        NSRect pill = NSInsetRect(NSMakeRect(NSMinX(track) + segW * lo, NSMinY(track), segW * (hi - lo + 1), NSHeight(track)), 2, 2);
        [[MSLPNSColour(MSLPColourTitle()) colorWithAlphaComponent:1] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:pill xRadius:6 yRadius:6] fill];
    }
    if (self.hoverIndex >= 0 && self.hoverIndex < (NSInteger)n && !(spanned && self.hoverIndex >= lo && self.hoverIndex <= hi)) {
        NSRect hint = NSInsetRect(NSMakeRect(NSMinX(track) + segW * self.hoverIndex, NSMinY(track), segW, NSHeight(track)), 2, 2);
        [[NSColor.tertiaryLabelColor colorWithAlphaComponent:0.35] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:hint xRadius:6 yRadius:6] fill];
    }
    NSFont *font = [NSFont systemFontOfSize:10 weight:NSFontWeightMedium];
    NSFont *onFont = [NSFont systemFontOfSize:10 weight:NSFontWeightSemibold];
    NSFont *clockFont = [NSFont systemFontOfSize:9 weight:NSFontWeightRegular];
    NSColor *idle = dark
        ? [NSColor colorWithSRGBRed:1 green:1 blue:1 alpha:0.78]
        : [NSColor colorWithSRGBRed:0.38 green:0.36 blue:0.34 alpha:1];
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
    style.alignment = NSTextAlignmentCenter;
    style.lineBreakMode = NSLineBreakByWordWrapping;
    for (NSUInteger i = 0; i < n; i++) {
        if (i > 0 && i < self.dayKeys.count && self.dayKeys[i].integerValue != self.dayKeys[i - 1].integerValue
            && self.dayKeys[i].integerValue != 0) {
            NSRect rule = NSMakeRect(NSMinX(track) + segW * i - 0.5, NSMinY(track) + 6, 1, NSHeight(track) - 12);
            [[NSColor.separatorColor colorWithAlphaComponent:0.9] setFill];
            NSRectFill(rule);
        }
        BOOL on = spanned && (NSInteger)i >= lo && (NSInteger)i <= hi;
        NSColor *ink = on ? NSColor.whiteColor : idle;
        NSRect seg = NSMakeRect(NSMinX(track) + segW * i, NSMinY(track), segW, NSHeight(track));
        NSRect phrase = NSInsetRect(seg, 3, 0);
        phrase.origin.y += 3;
        phrase.size.height = NSHeight(seg) - 16;
        NSString *label = self.labels[i] ?: @"";
        [NSGraphicsContext saveGraphicsState];
        NSRectClip(NSInsetRect(seg, 1, 1));
        [label drawInRect:phrase withAttributes:@{
            NSFontAttributeName: on ? onFont : font,
            NSForegroundColorAttributeName: ink,
            NSParagraphStyleAttributeName: style,
        }];
        NSString *clock = i < self.clocks.count ? self.clocks[i] : @"";
        if (clock.length) {
            NSRect clockRect = NSMakeRect(NSMinX(seg), NSMaxY(seg) - 14, NSWidth(seg), 12);
            [clock drawInRect:clockRect withAttributes:@{
                NSFontAttributeName: clockFont,
                NSForegroundColorAttributeName: on ? [NSColor.whiteColor colorWithAlphaComponent:0.85] : [idle colorWithAlphaComponent:0.9],
                NSParagraphStyleAttributeName: style,
            }];
        }
        [NSGraphicsContext restoreGraphicsState];
    }
}
@end

static BOOL ViewIsDark(NSView *view) {
    NSAppearance *appearance = nil;
    for (NSView *cursor = view; cursor; cursor = cursor.superview)
        if (cursor.appearance) { appearance = cursor.appearance; break; }
    if (!appearance) appearance = NSApp.effectiveAppearance;
    NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[
        NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
    return [match isEqualToString:NSAppearanceNameDarkAqua];
}

static NSTextField *GlanceField(NSFont *font, NSColor *color) {
    NSTextField *field = [NSTextField labelWithString:@""];
    field.translatesAutoresizingMaskIntoConstraints = YES;
    field.font = font;
    field.textColor = color;
    field.lineBreakMode = NSLineBreakByTruncatingTail;
    field.drawsBackground = NO;
    return field;
}

static void StrokeArrow(NSPoint a, NSPoint b, CGFloat width, NSColor *color, BOOL head, CGFloat headLength);

static void StrokeSegment(NSPoint a, NSPoint b, CGFloat width, NSColor *color, BOOL head) {
    StrokeArrow(a, b, width, color, head, 0);
}

static void StrokeArrow(NSPoint a, NSPoint b, CGFloat width, NSColor *color, BOOL head, CGFloat headLength) {
    if (!color) return;
    [color setStroke];
    [color setFill];
    NSBezierPath *shaft = [NSBezierPath bezierPath];
    shaft.lineWidth = MAX(0.8, width);
    shaft.lineCapStyle = NSLineCapStyleRound;
    shaft.lineJoinStyle = NSLineJoinStyleRound;
    [shaft moveToPoint:a];
    [shaft lineToPoint:b];
    [shaft stroke];
    if (!head) return;
    double ang = atan2(b.y - a.y, b.x - a.x);
    CGFloat len = headLength > 0 ? headLength : MAX(7.0, width * 3.2);
    CGFloat spread = 0.42;
    NSPoint left = NSMakePoint(b.x - len * cos(ang - spread), b.y - len * sin(ang - spread));
    NSPoint right = NSMakePoint(b.x - len * cos(ang + spread), b.y - len * sin(ang + spread));
    NSBezierPath *tri = [NSBezierPath bezierPath];
    [tri moveToPoint:b];
    [tri lineToPoint:left];
    [tri lineToPoint:right];
    [tri closePath];
    [tri fill];
}

static NSDictionary *FooterWindModel(NSDictionary *obs) {
    if (![obs isKindOfClass:NSDictionary.class]) return @{};
    NSString *direction = [obs[@"windDir"] isKindOfClass:NSString.class] ? [obs[@"windDir"] uppercaseString] : @"";
    double from = 0;
    BOOL hasDirection = WindFromDegrees(direction, &from);
    BOOL hasSpeed = NO;
    double speed = 0;
    id kt = obs[@"windKt"];
    id kmh = obs[@"windKmh"];
    if ([kt isKindOfClass:NSNumber.class] && isfinite([kt doubleValue]) && [kt doubleValue] >= 0) {
        speed = [kt doubleValue]; hasSpeed = YES;
    } else if ([kmh isKindOfClass:NSNumber.class] && isfinite([kmh doubleValue]) && [kmh doubleValue] >= 0) {
        speed = KnotsFromKmh([kmh doubleValue]); hasSpeed = isfinite(speed) && speed >= 0;
    }
    BOOL calm = hasSpeed && speed < 0.5;
    return @{
        @"direction": direction,
        @"hasDirection": @(hasDirection),
        @"hasSpeed": @(hasSpeed),
        @"speedKt": @(speed),
        @"fromDeg": @(from),
        @"calm": @(calm),
        @"toDeg": hasDirection ? @(WindToDegrees(from)) : NSNull.null,
    };
}

static NSString *FooterWindSpeedLabel(NSDictionary *model) {
    if (![model[@"hasSpeed"] boolValue]) return @"—";
    return [NSString stringWithFormat:@"%.0f kt", round([model[@"speedKt"] doubleValue])];
}

static NSImage *FooterWindImage(NSDictionary *model) {
    NSImage *image = [NSImage imageWithSize:NSMakeSize(22, 18) flipped:NO
        drawingHandler:^BOOL(NSRect dirtyRect) {
            (void)dirtyRect;
            NSColor *ink = NSColor.labelColor;
            BOOL hasDirection = [model[@"hasDirection"] boolValue];
            BOOL hasSpeed = [model[@"hasSpeed"] boolValue];
            BOOL calm = [model[@"calm"] boolValue];
            NSRect box = NSMakeRect(1, 1, 20, 16);
            if (calm) {
                NSBezierPath *calm = [NSBezierPath bezierPathWithOvalInRect:NSInsetRect(box, 4.5, 4.5)];
                calm.lineWidth = 1.4;
                [ink setStroke];
                [calm stroke];
            } else if (hasDirection && hasSpeed) {
                IsobarDrawMenuBarWindArrow([model[@"fromDeg"] doubleValue], box);
            } else if (hasSpeed) {
                // A known speed with no direction uses a neutral dotted mark.
                [ink setFill];
                for (NSInteger i = 0; i < 3; i++)
                    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(4 + i * 5, 7, 3, 3)] fill];
            }
            return YES;
        }];
    image.cacheMode = NSImageCacheNever;
    return image;
}

static CGFloat PlotX(NSRect plot, double hour, double lo, double hi) {
    double span = hi - lo;
    if (fabs(span) < 1e-6) return NSMidX(plot);
    return NSMinX(plot) + (hour - lo) / span * NSWidth(plot);
}

static CGFloat PlotY(NSRect plot, double value, double lo, double hi) {
    double span = hi - lo;
    if (fabs(span) < 1e-6) return NSMidY(plot);
    double t = (value - lo) / span;
    return NSMinY(plot) + (1.0 - t) * NSHeight(plot);
}

@interface GlanceCard : FlippedView
@property (nonatomic, copy) NSDictionary *model;
@property (nonatomic) BOOL showsBarbs;
@property (nonatomic, copy) NSString *warningIdentifier;
@property (nonatomic, copy) void (^onWarning)(NSString *text, NSView *anchor);
@end

@implementation GlanceCard {
    NSTextField *_name;
    NSTextField *_temp;
    NSTextField *_wind;
    NSTextField *_press;
    NSTextField *_trend;
    NSMutableArray<NSView *> *_tags;
}
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    _tags = [NSMutableArray array];
    _name = GlanceField([NSFont systemFontOfSize:12 weight:NSFontWeightSemibold], NSColor.labelColor);
    _temp = GlanceField([NSFont monospacedDigitSystemFontOfSize:18 weight:NSFontWeightSemibold], NSColor.labelColor);
    _wind = GlanceField([NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium], NSColor.labelColor);
    _press = GlanceField([NSFont monospacedDigitSystemFontOfSize:13 weight:NSFontWeightSemibold], NSColor.labelColor);
    _trend = GlanceField([NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightMedium], NSColor.secondaryLabelColor);
    for (NSTextField *field in @[_name, _temp, _wind, _press, _trend]) [self addSubview:field];
    return self;
}
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
- (void)setModel:(NSDictionary *)model {
    _model = [model copy];
    [self rebuildTags];
    [self applyText];
    [self placeText];
    self.needsDisplay = YES;
}
- (void)setShowsBarbs:(BOOL)showsBarbs {
    _showsBarbs = showsBarbs;
    self.needsDisplay = YES;
}
- (void)applyText {
    NSDictionary *model = self.model ?: @{};
    _name.stringValue = model[@"name"] ?: @"—";
    _temp.stringValue = model[@"tempText"] ?: @"—";
    _wind.stringValue = model[@"windLabel"] ?: @"—";
    _press.stringValue = model[@"pressureText"] ?: @"—";
    NSString *trend = model[@"trendText"] ?: @"—";
    int sign = [model[@"trendSign"] intValue];
    NSString *mark = sign > 0 ? @"\u2191 " : sign < 0 ? @"\u2193 " : ([trend isEqual:@"steady"] ? @"\u2192 " : @"");
    _trend.stringValue = [mark stringByAppendingString:trend];
    self.accessibilityLabel = [NSString stringWithFormat:@"%@, %@, %@, %@, %@",
        _name.stringValue, _temp.stringValue, _wind.stringValue, _press.stringValue, _trend.stringValue];
    self.toolTip = self.accessibilityLabel;
}
- (void)rebuildTags {
    for (NSView *tag in _tags) [tag removeFromSuperview];
    [_tags removeAllObjects];
    NSFont *font = [NSFont systemFontOfSize:10 weight:NSFontWeightSemibold];
    NSColor *ink = [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        BOOL dark = [[appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]] isEqual:NSAppearanceNameDarkAqua];
        return dark ? [NSColor colorWithSRGBRed:1 green:0.62 blue:0.57 alpha:1]
            : [NSColor colorWithSRGBRed:0.70 green:0.13 blue:0.10 alpha:1];
    }];
    for (NSDictionary *warning in self.model[@"warnings"]) {
        if (![warning isKindOfClass:NSDictionary.class]) continue;
        NSString *title = warning[@"title"] ?: @"";
        if (!title.length) continue;
        CGFloat width = MIN(156, TextWidth(title, font) + 14);
        ClickLabel *chip = [[ClickLabel alloc] initWithFrame:NSMakeRect(0, 0, width, 16)];
        chip.stringValue = title;
        chip.font = font;
        chip.textColor = ink;
        chip.alignment = NSTextAlignmentCenter;
        chip.bezeled = NO;
        chip.editable = NO;
        chip.selectable = NO;
        chip.drawsBackground = YES;
        chip.backgroundColor = [ink colorWithAlphaComponent:0.12];
        chip.lineBreakMode = NSLineBreakByTruncatingTail;
        chip.wantsLayer = YES;
        chip.layer.cornerRadius = 4;
        chip.layer.masksToBounds = YES;
        chip.toolTip = title;
        if (!_tags.count && self.warningIdentifier.length) chip.accessibilityIdentifier = self.warningIdentifier;
        NSString *text = [warning[@"text"] isKindOfClass:NSString.class] ? warning[@"text"] : title;
        __weak GlanceCard *weak = self;
        __weak ClickLabel *weakChip = chip;
        chip.onClick = ^{
            GlanceCard *strong = weak;
            if (strong.onWarning) strong.onWarning(text, weakChip);
        };
        [self addSubview:chip];
        [_tags addObject:chip];
    }
}
- (void)layout {
    [super layout];
    [self placeText];
}
- (void)placeText {
    NSRect bounds = self.bounds;
    CGFloat pad = 8;
    CGFloat tempW = TextWidth(_temp.stringValue, _temp.font) + 10;
    CGFloat nameNeed = MIN(128, TextWidth(_name.stringValue, _name.font) + 6);
    CGFloat tagsBudget = MAX(0, NSWidth(bounds) - pad * 2 - tempW - nameNeed - 4);
    CGFloat tagXBudget = tagsBudget;
    for (NSView *tag in _tags) {
        NSRect frame = tag.frame;
        CGFloat give = MIN(NSWidth(frame), MAX(0, tagXBudget));
        frame.size.width = give;
        tag.frame = frame;
        tagXBudget -= give + 4;
    }
    CGFloat tagsW = 0;
    for (NSView *tag in _tags) if (NSWidth(tag.frame) > 8) tagsW += NSWidth(tag.frame) + 4;
    CGFloat nameW = MAX(36, NSWidth(bounds) - pad * 2 - tempW - tagsW);
    _name.frame = NSMakeRect(pad, 6, nameW, 16);
    _temp.frame = NSMakeRect(pad + nameW, 4, tempW, 20);
    CGFloat x = NSMaxX(_temp.frame) + 4;
    for (NSView *tag in _tags) {
        if (NSWidth(tag.frame) < 8) { tag.hidden = YES; continue; }
        tag.hidden = NO;
        NSRect frame = tag.frame;
        frame.origin = NSMakePoint(x, 6);
        tag.frame = frame;
        x += NSWidth(frame) + 4;
    }
    CGFloat labelX = pad + 68;
    CGFloat labelW = MAX(24, NSWidth(bounds) - labelX - pad);
    _wind.frame = NSMakeRect(labelX, 28, labelW, 16);
    CGFloat pressNeed = TextWidth(_press.stringValue, _press.font) + 8;
    CGFloat trendNeed = TextWidth(_trend.stringValue, _trend.font) + 4;
    if (pressNeed + 4 + trendNeed <= labelW) {
        _press.frame = NSMakeRect(labelX, 46, pressNeed, 18);
        _trend.frame = NSMakeRect(labelX + pressNeed + 2, 47, trendNeed, 16);
    } else {
        _press.frame = NSMakeRect(labelX, 44, labelW, 16);
        _trend.frame = NSMakeRect(labelX, 60, labelW, 14);
    }
}
- (NSRect)arrowBox {
    return NSMakeRect(6, 22, 60, 56);
}
- (NSRect)plotRow {
    BOOL ride = [self.model[@"ride"] isKindOfClass:NSArray.class] && [self.model[@"ride"] count] > 0;
    CGFloat top = 82;
    CGFloat bottom = NSHeight(self.bounds) - (ride ? 16 : 7);
    if (bottom < top + 18) bottom = top + 18;
    return NSMakeRect(8, top, MAX(20, NSWidth(self.bounds) - 16), bottom - top);
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect card = NSInsetRect(self.bounds, 0.5, 0.5);
    NSBezierPath *shape = [NSBezierPath bezierPathWithRoundedRect:card xRadius:8 yRadius:8];
    BOOL dark = ViewIsDark(self);
    BOOL offshore = [self.model[@"offshore"] boolValue];
    NSColor *fill = offshore
        ? [NSColor colorWithSRGBRed:0.86 green:0.48 blue:0.08 alpha:dark ? 0.28 : 0.16]
        : (dark ? [NSColor colorWithWhite:1 alpha:0.06] : [NSColor colorWithSRGBRed:0.965 green:0.955 blue:0.935 alpha:1]);
    [fill setFill];
    [shape fill];
    NSColor *edge = offshore
        ? [NSColor colorWithSRGBRed:0.76 green:0.42 blue:0.08 alpha:0.9]
        : [NSColor colorWithWhite:dark ? 1 : 0.62 alpha:dark ? 0.16 : 0.45];
    [edge setStroke];
    shape.lineWidth = 1;
    [shape stroke];
    [NSGraphicsContext saveGraphicsState];
    [shape addClip];
    [self drawWindMark];
    if (NSHeight(self.bounds) >= 120 && NSWidth(self.bounds) >= 320) [self drawSparks];
    [NSGraphicsContext restoreGraphicsState];
}
- (void)drawWindMark {
    NSRect box = [self arrowBox];
    NSNumber *shore = [self.model[@"shoreNormal"] isKindOfClass:NSNumber.class] ? self.model[@"shoreNormal"] : nil;
    if (shore) [self drawCoastIn:box normal:shore.doubleValue];
    BOOL hasWind = [self.model[@"hasWind"] boolValue];
    BOOL offshore = [self.model[@"offshore"] boolValue];
    NSColor *ink = offshore ? [NSColor colorWithSRGBRed:0.76 green:0.38 blue:0.04 alpha:1] : NSColor.labelColor;
    if (!hasWind) {
        NSBezierPath *calm = [NSBezierPath bezierPathWithOvalInRect:NSInsetRect(box, 17, 17)];
        calm.lineWidth = 1.4;
        [ink setStroke];
        [calm stroke];
        return;
    }
    double from = [self.model[@"fromDeg"] doubleValue];
    double speed = [self.model[@"speedKt"] doubleValue];
    if (self.showsBarbs) {
        [self drawBarbIn:box from:from speed:speed color:ink];
        return;
    }
    WindArrow arrow = WindArrowLayout([self.model[@"toDeg"] doubleValue], speed,
        [self.model[@"gustKt"] doubleValue], YES, [self.model[@"hasGust"] boolValue]);
    CGFloat scale = NSWidth(box) / 44.0;
    if (arrow.hasGust) {
        NSPoint gust = [self unit:arrow.gustX y:arrow.gustY in:box];
        StrokeSegment([self unit:arrow.headX y:arrow.headY in:box], gust,
            MAX(1.3, arrow.weight * 0.45 * scale), [ink colorWithAlphaComponent:0.40], NO);
        NSBezierPath *tip = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(gust.x - 2.1, gust.y - 2.1, 4.2, 4.2)];
        [[ink colorWithAlphaComponent:0.45] setFill];
        [tip fill];
    }
    StrokeArrow([self unit:arrow.tailX y:arrow.tailY in:box], [self unit:arrow.headX y:arrow.headY in:box],
        arrow.weight * scale, ink, YES, 0);
}
- (NSPoint)unit:(double)x y:(double)y in:(NSRect)box {
    return NSMakePoint(NSMinX(box) + x * NSWidth(box), NSMinY(box) + y * NSHeight(box));
}
- (void)drawCoastIn:(NSRect)box normal:(double)normal {
    double rad = normal * M_PI / 180.0;
    double ox = sin(rad), oy = -cos(rad);
    double cx = -oy, cy = ox;
    NSPoint mid = NSMakePoint(NSMidX(box), NSMidY(box));
    CGFloat half = NSWidth(box) * 0.46;
    NSPoint a = NSMakePoint(mid.x - cx * half, mid.y - cy * half);
    NSPoint b = NSMakePoint(mid.x + cx * half, mid.y + cy * half);
    NSColor *sea = [NSColor colorWithSRGBRed:0.42 green:0.62 blue:0.78 alpha:0.95];
    StrokeSegment(NSMakePoint(a.x + ox * 3.2, a.y + oy * 3.2), NSMakePoint(b.x + ox * 3.2, b.y + oy * 3.2), 3.2, sea, NO);
    StrokeSegment(a, b, 1.5, NSColor.secondaryLabelColor, NO);
}
- (void)drawBarbIn:(NSRect)box from:(double)from speed:(double)speed color:(NSColor *)color {
    OwnBarb barb = OwnWindBarb(from, speed, NSWidth(box) * 0.46,
        [self.model[@"southernHemisphere"] boolValue]);
    NSPoint origin = NSMakePoint(NSMidX(box), NSMidY(box));
    NSPoint (^point)(double, double) = ^NSPoint(double x, double y) {
        return NSMakePoint(origin.x + x, origin.y - y);
    };
    if (barb.calm) {
        NSBezierPath *dot = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(origin.x - 4, origin.y - 4, 8, 8)];
        dot.lineWidth = 1.3;
        [color setStroke];
        [dot stroke];
        return;
    }
    [color setStroke];
    [color setFill];
    for (int i = 0; i < barb.nSeg; i++)
        StrokeSegment(point(barb.segs[i].a.x, barb.segs[i].a.y), point(barb.segs[i].b.x, barb.segs[i].b.y), 1.2, color, NO);
    for (int i = 0; i < barb.nTri; i++) {
        NSBezierPath *tri = [NSBezierPath bezierPath];
        [tri moveToPoint:point(barb.tri[i][0].x, barb.tri[i][0].y)];
        [tri lineToPoint:point(barb.tri[i][1].x, barb.tri[i][1].y)];
        [tri lineToPoint:point(barb.tri[i][2].x, barb.tri[i][2].y)];
        [tri closePath];
        [tri fill];
    }
}
- (NSBezierPath *)lineForPoints:(NSArray *)points key:(NSString *)key plot:(NSRect)plot x0:(double)x0 x1:(double)x1 y0:(double)y0 y1:(double)y1 {
    NSBezierPath *path = [NSBezierPath bezierPath];
    BOOL moved = NO;
    for (NSDictionary *point in points) {
        if (![point[key] isKindOfClass:NSNumber.class]) continue;
        NSPoint p = NSMakePoint(PlotX(plot, [point[@"h"] doubleValue], x0, x1),
            PlotY(plot, [point[key] doubleValue], y0, y1));
        if (!moved) { [path moveToPoint:p]; moved = YES; }
        else [path lineToPoint:p];
    }
    return moved ? path : nil;
}
- (void)stroke:(NSBezierPath *)path color:(NSColor *)color width:(CGFloat)width dashed:(BOOL)dashed {
    if (!path) return;
    path.lineWidth = width;
    path.lineJoinStyle = NSLineJoinStyleRound;
    path.lineCapStyle = NSLineCapStyleRound;
    if (dashed) {
        CGFloat dash[] = {1.4, 2.2};
        [path setLineDash:dash count:2 phase:0];
    }
    [color setStroke];
    [path stroke];
}
- (void)drawNowIn:(NSRect)plot from:(double)x0 to:(double)x1 {
    CGFloat x = PlotX(plot, 0, x0, x1);
    StrokeSegment(NSMakePoint(x, NSMinY(plot)), NSMakePoint(x, NSMaxY(plot)), 1, [NSColor.tertiaryLabelColor colorWithAlphaComponent:0.85], NO);
}
- (void)drawCaption:(NSString *)text at:(NSPoint)origin color:(NSColor *)color {
    NSDictionary *attrs = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:9 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: color ?: NSColor.secondaryLabelColor,
    };
    [text drawAtPoint:origin withAttributes:attrs];
}
- (void)drawAxis:(NSDictionary *)trace in:(NSRect)rect leftInset:(CGFloat)inset {
    NSString *left = [trace[@"axisLeft"] isKindOfClass:NSString.class] ? trace[@"axisLeft"] : @"";
    NSString *right = [trace[@"axisRight"] isKindOfClass:NSString.class] ? trace[@"axisRight"] : @"";
    if (!left.length && !right.length) return;
    NSFont *font = [NSFont systemFontOfSize:9 weight:NSFontWeightMedium];
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
    style.lineBreakMode = NSLineBreakByTruncatingTail;
    NSDictionary *attrs = @{
        NSFontAttributeName: font,
        NSForegroundColorAttributeName: NSColor.secondaryLabelColor,
        NSParagraphStyleAttributeName: style,
    };
    CGFloat y = NSMaxY(rect) - 11;
    CGFloat x0 = NSMinX(rect) + inset;
    CGFloat x1 = NSMaxX(rect) - 1;
    if (right.length) {
        NSMutableParagraphStyle *end = [style mutableCopy];
        end.alignment = NSTextAlignmentRight;
        end.lineBreakMode = NSLineBreakByTruncatingHead;
        NSDictionary *endAttrs = @{
            NSFontAttributeName: font,
            NSForegroundColorAttributeName: NSColor.secondaryLabelColor,
            NSParagraphStyleAttributeName: end,
        };
        CGFloat natural = [right sizeWithAttributes:endAttrs].width;
        CGFloat room = MAX(0, x1 - x0);
        CGFloat rw = MIN(natural, MAX(24, room * 0.62));
        [right drawInRect:NSMakeRect(x1 - rw, y, rw, 11) withAttributes:endAttrs];
        x1 -= rw + 6;
    }
    if (left.length && x1 - x0 > 8)
        [left drawInRect:NSMakeRect(x0, y, x1 - x0, 11) withAttributes:attrs];
}
- (CGFloat)axisHeight:(NSDictionary *)trace {
    return [trace[@"axisLeft"] length] || [trace[@"axisRight"] length] ? 12 : 0;
}
- (void)drawPressure:(NSDictionary *)trace in:(NSRect)rect {
    NSArray *observed = [trace[@"observed"] isKindOfClass:NSArray.class] ? trace[@"observed"] : @[];
    NSArray *forecast = [trace[@"forecast"] isKindOfClass:NSArray.class] ? trace[@"forecast"] : @[];
    CGFloat axisH = [self axisHeight:trace];
    NSRect plot = NSMakeRect(NSMinX(rect) + 28, NSMinY(rect) + 2, MAX(8, NSWidth(rect) - 30), MAX(8, NSHeight(rect) - 4 - axisH));
    if ([trace[@"min"] isKindOfClass:NSNumber.class] && [trace[@"max"] isKindOfClass:NSNumber.class]) {
        double minV = [trace[@"min"] doubleValue];
        double maxV = [trace[@"max"] doubleValue];
        double pad = MAX(0.35, (maxV - minV) * 0.18);
        double y0 = minV - pad, y1 = maxV + pad;
        [self drawNowIn:plot from:-24 to:24];
        NSBezierPath *solid = [self lineForPoints:observed key:@"v" plot:plot x0:-24 x1:24 y0:y0 y1:y1];
        NSMutableArray *ahead = [forecast mutableCopy];
        if (observed.count) [ahead insertObject:observed.lastObject atIndex:0];
        NSBezierPath *dotted = [self lineForPoints:ahead key:@"v" plot:plot x0:-24 x1:24 y0:y0 y1:y1];
        [self stroke:solid color:NSColor.labelColor width:1.6 dashed:NO];
        [self stroke:dotted color:[NSColor.labelColor colorWithAlphaComponent:0.85] width:1.35 dashed:YES];
        NSColor *sub = NSColor.secondaryLabelColor;
        [self drawCaption:[NSString stringWithFormat:@"%.0f", round(maxV)] at:NSMakePoint(NSMinX(rect), NSMinY(plot) - 1) color:sub];
        [self drawCaption:[NSString stringWithFormat:@"%.0f", round(minV)] at:NSMakePoint(NSMinX(rect), NSMaxY(plot) - 11) color:sub];
        [self drawAxis:trace in:rect leftInset:28];
    }
}
- (void)fillGust:(NSArray *)points plot:(NSRect)plot y1:(double)y1 alpha:(CGFloat)alpha {
    if (points.count < 2) return;
    NSBezierPath *band = [NSBezierPath bezierPath];
    NSMutableArray<NSValue *> *upper = [NSMutableArray array];
    NSMutableArray<NSValue *> *lower = [NSMutableArray array];
    for (NSDictionary *point in points) {
        if (![point[@"s"] isKindOfClass:NSNumber.class]) continue;
        double speed = [point[@"s"] doubleValue];
        double gust = [point[@"g"] isKindOfClass:NSNumber.class] ? [point[@"g"] doubleValue] : speed;
        if (gust < speed) gust = speed;
        double hour = [point[@"h"] doubleValue];
        [lower addObject:[NSValue valueWithPoint:NSMakePoint(PlotX(plot, hour, -12, 12), PlotY(plot, speed, 0, y1))]];
        [upper addObject:[NSValue valueWithPoint:NSMakePoint(PlotX(plot, hour, -12, 12), PlotY(plot, gust, 0, y1))]];
    }
    if (upper.count < 2) return;
    [band moveToPoint:upper[0].pointValue];
    for (NSValue *value in upper) [band lineToPoint:value.pointValue];
    for (NSValue *value in lower.reverseObjectEnumerator) [band lineToPoint:value.pointValue];
    [band closePath];
    [[NSColor.labelColor colorWithAlphaComponent:alpha] setFill];
    [band fill];
}
- (void)drawWindTrace:(NSDictionary *)trace in:(NSRect)rect {
    NSArray *observed = [trace[@"observed"] isKindOfClass:NSArray.class] ? trace[@"observed"] : @[];
    NSArray *forecast = [trace[@"forecast"] isKindOfClass:NSArray.class] ? trace[@"forecast"] : @[];
    NSArray *ticks = [trace[@"ticks"] isKindOfClass:NSArray.class] ? trace[@"ticks"] : @[];
    CGFloat axisH = [self axisHeight:trace];
    NSRect plot = NSMakeRect(NSMinX(rect) + 2, NSMinY(rect) + 1, MAX(8, NSWidth(rect) - 4), MAX(8, NSHeight(rect) - 16 - axisH));
    double peak = 0;
    for (NSDictionary *point in [observed arrayByAddingObjectsFromArray:forecast]) {
        double speed = [point[@"s"] isKindOfClass:NSNumber.class] ? [point[@"s"] doubleValue] : 0;
        double gust = [point[@"g"] isKindOfClass:NSNumber.class] ? [point[@"g"] doubleValue] : speed;
        if (gust > peak) peak = gust;
        if (speed > peak) peak = speed;
    }
    // 0–30 kt fills the card at a breeze; a stronger gust lifts the scale and is labelled.
    double y1 = MAX(30.0, peak * 1.12);
    NSBezierPath *floor = [NSBezierPath bezierPath];
    [floor moveToPoint:NSMakePoint(NSMinX(plot), NSMaxY(plot))];
    [floor lineToPoint:NSMakePoint(NSMaxX(plot), NSMaxY(plot))];
    floor.lineWidth = 0.6;
    [[NSColor.tertiaryLabelColor colorWithAlphaComponent:0.55] setStroke];
    [floor stroke];
    [self drawNowIn:plot from:-12 to:12];
    [self fillGust:observed plot:plot y1:y1 alpha:0.16];
    NSMutableArray *ahead = [forecast mutableCopy];
    if (observed.count) [ahead insertObject:observed.lastObject atIndex:0];
    [self fillGust:ahead plot:plot y1:y1 alpha:0.09];
    [self stroke:[self lineForPoints:observed key:@"s" plot:plot x0:-12 x1:12 y0:0 y1:y1] color:NSColor.labelColor width:1.6 dashed:NO];
    [self stroke:[self lineForPoints:ahead key:@"s" plot:plot x0:-12 x1:12 y0:0 y1:y1] color:NSColor.labelColor width:1.35 dashed:YES];
    NSColor *tick = NSColor.secondaryLabelColor;
    for (NSDictionary *mark in ticks) {
        double hour = [mark[@"h"] doubleValue];
        if (hour < -12 || hour > 12) continue;
        double to = [mark[@"to"] doubleValue];
        double rad = to * M_PI / 180.0;
        CGFloat cx = PlotX(plot, hour, -12, 12);
        CGFloat cy = NSMaxY(plot) - 1;
        CGFloat len = 7.0;
        NSPoint head = NSMakePoint(cx + sin(rad) * len, cy - cos(rad) * len);
        NSPoint tail = NSMakePoint(cx - sin(rad) * len * 0.7, cy + cos(rad) * len * 0.7);
        StrokeArrow(tail, head, 1.15, tick, YES, 3.6);
    }
    [self drawAxis:trace in:rect leftInset:2];
}
- (void)drawRide {
    NSArray *hours = self.model[@"ride"];
    if (![hours isKindOfClass:NSArray.class] || !hours.count) return;
    NSRect bar = NSMakeRect(8, NSHeight(self.bounds) - 13, MAX(8, NSWidth(self.bounds) - 16), 5);
    NSBezierPath *track = [NSBezierPath bezierPathWithRoundedRect:bar xRadius:2.5 yRadius:2.5];
    [[NSColor.quaternaryLabelColor colorWithAlphaComponent:0.45] setFill];
    [track fill];
    NSColor *on = [NSColor colorWithSRGBRed:0.012 green:0.427 blue:0.608 alpha:1];
    for (NSUInteger i = 0; i < hours.count; i++) {
        NSDictionary *sample = hours[i];
        if (![sample[@"on"] boolValue]) continue;
        double start = [sample[@"h"] doubleValue];
        double end = (i + 1 < hours.count) ? [hours[i + 1][@"h"] doubleValue] : MIN(24, start + 1);
        if (end < start) continue;
        CGFloat x0 = NSMinX(bar) + start / 24.0 * NSWidth(bar);
        CGFloat x1 = NSMinX(bar) + end / 24.0 * NSWidth(bar);
        NSRect block = NSMakeRect(x0, NSMinY(bar), MAX(1.5, x1 - x0), NSHeight(bar));
        [on setFill];
        [[NSBezierPath bezierPathWithRect:block] fill];
    }
}
- (void)drawSparks {
    NSRect row = [self plotRow];
    CGFloat gap = 18;
    CGFloat width = floor((NSWidth(row) - gap) / 2.0);
    NSRect left = NSMakeRect(NSMinX(row), NSMinY(row), width, NSHeight(row));
    NSRect right = NSMakeRect(NSMaxX(left) + gap, NSMinY(row), NSWidth(row) - width - gap, NSHeight(row));
    [self drawPressure:self.model[@"pressure"] in:left];
    [self drawWindTrace:self.model[@"wind"] in:right];
    [self drawRide];
}
@end

@interface Controller : NSObject <FullscreenWindowController, NSApplicationDelegate, NSPopoverDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, CLLocationManagerDelegate, NSTextFieldDelegate>
@property (nonatomic, strong) NSPopover *popover;
- (void)rebuildContent;
- (void)noteChartImage:(NSImage *)image pdf:(NSData *)pdf issued:(NSDate *)issued offline:(BOOL)offline;
- (void)noteAnalysisPDF:(NSData *)pdf;
- (void)notePreviousPrognosis:(NSData *)pdf issued:(NSDate *)issued;
- (void)setChartNow:(NSDate *)now;
- (void)noteObservation:(NSDictionary *)obs daily:(NSArray *)daily hourly:(NSArray *)hourly warnings:(NSArray *)warnings;
- (void)noteWeatherForGeohash:(NSString *)geohash obs:(NSDictionary *)obs daily:(NSArray *)daily hourly:(NSArray *)hourly warnings:(NSArray *)warnings;
- (void)openChartWindow;
- (void)refreshAll;
- (void)replaceLocations:(NSArray *)locations;
- (void)reloadStoreAtPath:(NSString *)root;
- (void)toggleChartSource;
- (BOOL)fullscreenReady;
- (void)presentChartWindowInFrame:(NSRect)frame;
- (void)closeChartWindow;
- (void)zoomChart:(int)direction;
- (void)escapeFullscreen;
- (void)stepFullscreenPanel:(NSInteger)delta;
- (void)focusFullscreenPanel:(NSInteger)index;
- (void)toggleIssueCompare;
- (void)toggleChartLoop;
- (void)playMotionWhenReady;
- (void)resetPopoverToNow;
- (void)inspectPopoverMovieFraction:(double)fraction;
- (NSInteger)fullscreenPanelIndex;
- (NSWindow *)chartWindow;
@end

@implementation Controller {
    NSStatusItem *_item;
    NSWindow *_chartWindow;
    NSScrollView *_singleScroll;
    PDFCropView *_headerView;
    PDFCropView *_panelViews[9];
    NSTextField *_timeTitle;
    NSTextField *_compareNote;
    NSView *_statusBar;
    NSView *_chartToolbar;
    NSView *_chartTransport;
    TimelineStrip *_chartTimeline;
    NSButton *_chartPlayButton;
    BOOL _expandedMap;
    NSWindow *_settingsWindow;
    NSWindow *_noticesWindow;
    NSWindow *_atmosphereWindow;
    AtmosphereView *_atmosphereView;
    AviationNoticesView *_noticesView;
    NSImage *_chart;
    NSData *_chartPDF;
    NSData *_chartPDFDrawn;
    CGPDFDocumentRef _pdfDoc;
    NSInteger _panelIndex;
    CGFloat _panelZoom;
    NSDate *_issued;
    BOOL _offline;
    NSArray *_locations;
    NSDictionary *_here;
    NSMutableDictionary *_weather;
    NSDate *_lastFetch;
    BOOL _fetching;
    IsobarCollector *_collector;
    IsobarNotacConnection *_notacConnection;
    NSArray *_searchResults;
    NSTableView *_searchTable;
    NSTableView *_locationsTable;
    NSButton *_loginToggle;
    NSTextField *_searchField;
    CLLocationManager *_locationManager;
    NSTimer *_clock;
    NSPopover *_warningPop;
    NSPopover *_observationPop;
    NSView *_escapeHint;
    NSInteger _escapeHintToken;
    NSTimeInterval _popoverClosedAt;
    NSData *_analysisPDF;
    NSData *_analysisDrawn;
    NSString *_analysisLocal;
    CGPDFDocumentRef _analysisDoc;
    AnalysisGeo _geo;
    NSData *_previousPDF;
    CGPDFDocumentRef _previousDoc;
    NSDate *_previousIssued;
    NSArray<NSDate *> *_sequenceTimes;
    NSArray<NSDate *> *_previousTimes;
    BOOL _hasAnalysisSlot;
    ChartPair _pair;
    BOOL _pairPinned;
    NSDate *_chartNow;
    BOOL _comparing;
    BOOL _looping;
    BOOL _loopAdvancing;
    NSTimer *_loopTimer;
    NSTimer *_popoverLoopTimer;
    BOOL _popoverPlaying;
    BOOL _motionPreparing;
    NSUInteger _motionGeneration;
    NSProgress *_motionPreparation;
    NSArray<NSImage *> *_motionFrames;
    NSInteger _motionStartIndex;
    NSTimeInterval _motionEpoch;
    NSUInteger _motionOffset;
    NSUInteger _motionCursor;
    BOOL _motionHasCursor;
    BOOL _motionCursorFullscreen;
    NSString *_motionError;
    NSURL *_motionMovieURL;
    AVPlayer *_motionPlayer;
    id _motionTimeObserver;
    BOOL _motionSeeking;
    NSNumber *_motionQueuedFraction;
    NSUInteger _motionSeekGeneration;
    BOOL _motionResetToNow;
    BOOL _evolutionOnOpenPending;
    NSNumber *_motionPendingFraction;
    BOOL _timelinePreviewing;
    BOOL _timelinePreviewWasPlaying;
    double _timelinePreviewRestoreFraction;
    double _timelinePreviewFraction;
    IsobarScrubRenderer *_scrubRenderer;
    NSString *_scrubKey;
    BOOL _scrubHasFraction;
    double _scrubFraction;
    double _scrubDisplayedFraction;
    NSButton *_popoverPlayButton;
    TimelineStrip *_popoverTimeline;
    NSInteger _compareNoteToken;
    id _keyMonitor;
    BOOL _sourceECMWF;
    NSString *_storeRoot;
    NSString *_statusLabel;
    BOOL _dataStale;
    OwnRun *_ownRun;
    OwnRun *_previousRun;
    NSDate *_runDate;
    BOOL _storeStatusOK;
    BOOL _publishedStore;
    BOOL _publishedGrid;
    NSString *_storeError;
    NSDictionary *_aviation;
    NSDictionary *_notams;
    NSDictionary *_sigmets;
    NSArray *_airportSeries;
    NSDate *_previousRunDate;
    NSArray<NSNumber *> *_frameIndices;
    NSMutableDictionary *_chartCache;
    NSOperationQueue *_chartPreparationQueue;
    NSUInteger _chartPreparationGeneration;
    NSInteger _tempLayer;
    BOOL _barbs;
    BOOL _glanceBarbs;
    BOOL _kiteSpots;
    NSArray *_kiteList;
    NSString *_windSpotHash;
    NSString *_rainPlaceHash;
    NSInteger _forecastMode;
    NSView *_forecastGraph;
    NSTextField *_forecastTime;
    NSTextField *_forecastReading;
    NSMutableSet<NSNumber *> *_mapDetailModes;
    NSMutableDictionary *_mapDetailCache;
    BOOL _rainLayer;
    double _kiteMin;
    double _kiteMax;
    NSArray *_rainDots;
    NSInteger _previewIndex;
    PDFCropView *_leftChart;
    PDFCropView *_rightChart;
    NSTextField *_leftTitle;
    NSTextField *_rightTitle;
    NSInteger _shownLeft;
    NSInteger _shownRight;
    id _scrollMonitor;
    CGFloat _scrollAccum;
    NSString *_aerodromeCode;
    NSTextField *_kiteMinField;
    NSTextField *_kiteMaxField;
    NSPopUpButton *_aerodromePopup;
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    NSUserDefaults *defaults = [self chartPreferences];
    _locations = UnarchiveLocations([defaults stringForKey:@"locations"]);
    _weather = [NSMutableDictionary dictionary];
    _notacConnection = [IsobarNotacConnection new];
    _chartCache = [NSMutableDictionary dictionary];
    _panelIndex = -1;
    _panelZoom = 1;
    BOOL fixture = getenv("ISOBAR_FIXTURES") != NULL;
    _sourceECMWF = fixture || [[defaults stringForKey:@"chartSource"] isEqual:@"ecmwf"];
    _tempLayer = (!fixture && [defaults objectForKey:@"chartTemperature"]) ? [defaults integerForKey:@"chartTemperature"] : 0;
    if (_tempLayer < 0 || _tempLayer > 2) _tempLayer = 0;
    _barbs = fixture ? NO : ([defaults objectForKey:@"chartBarbs"] ? [defaults boolForKey:@"chartBarbs"] : YES);
    _glanceBarbs = [defaults objectForKey:@"glanceBarbs"] ? [defaults boolForKey:@"glanceBarbs"] : NO;
    _kiteSpots = fixture ? NO : [defaults boolForKey:@"kiteSpots"];
    _kiteMin = 15;
    _kiteMax = 30;
    if (!fixture && [defaults objectForKey:@"kiteMinKt"]) _kiteMin = [defaults doubleForKey:@"kiteMinKt"];
    if (!fixture && [defaults objectForKey:@"kiteMaxKt"]) _kiteMax = [defaults doubleForKey:@"kiteMaxKt"];
    _kiteList = @[];
    _windSpotHash = fixture ? @"" : ([defaults stringForKey:@"windSpot"] ?: @"");
    // Forecasts are a disclosure from the map, not a saved landing page.
    _forecastMode = -1;
    _mapDetailModes = [NSMutableSet set];
    _mapDetailCache = [NSMutableDictionary dictionary];
    if (!fixture) for (id mode in [defaults arrayForKey:@"mapDetailModes"])
        if ([mode isKindOfClass:NSNumber.class] && [mode integerValue]>=0 && [mode integerValue]<=4) [_mapDetailModes addObject:mode];
    _rainLayer = fixture || ![defaults objectForKey:@"chartRain"] || [defaults boolForKey:@"chartRain"];
    _aerodromeCode = fixture ? @"" : ([defaults stringForKey:@"homeAerodrome"] ?: @"");
    _previewIndex = -1;
    _shownLeft = -1;
    _shownRight = -1;
    const char *kiteEnv = getenv("ISOBAR_KITE");
    if (kiteEnv && kiteEnv[0] == '1') _kiteSpots = YES;
    const char *barbEnv = getenv("ISOBAR_BARBS");
    if (barbEnv && barbEnv[0] == '1') _glanceBarbs = YES;
    return self;
}

- (void)dealloc {
    [_chartPreparationQueue cancelAllOperations];
    [_loopTimer invalidate];
    [_popoverLoopTimer invalidate];
    [_motionPreparation cancel];
    if (_motionTimeObserver && _motionPlayer) [_motionPlayer removeTimeObserver:_motionTimeObserver];
    [_motionPlayer pause];
    if (_keyMonitor) [NSEvent removeMonitor:_keyMonitor];
    if (_scrollMonitor) [NSEvent removeMonitor:_scrollMonitor];
    if (_pdfDoc) CGPDFDocumentRelease(_pdfDoc);
    if (_analysisDoc) CGPDFDocumentRelease(_analysisDoc);
    if (_previousDoc) CGPDFDocumentRelease(_previousDoc);
}

- (NSArray *)shownLocations {
    if (!_here) return _locations;
    NSString *replaced = _here[@"replacesGeohash"] ?: _here[@"geohash"];
    NSMutableArray *out = [NSMutableArray arrayWithObject:_here];
    for (NSDictionary *saved in _locations) {
        if ([saved[@"geohash"] isEqual:replaced]) continue;
        [out addObject:saved];
    }
    return out;
}

- (NSTextField *)label:(NSString *)s font:(NSFont *)font color:(NSColor *)color frame:(NSRect)frame {
    NSTextField *t = [NSTextField labelWithString:s ?: @""];
    // labelWithString opts into Auto Layout, which then ignores this frame and pins the text at the origin.
    t.translatesAutoresizingMaskIntoConstraints = YES;
    t.font = font;
    if (color) t.textColor = color;
    t.frame = frame;
    t.lineBreakMode = NSLineBreakByTruncatingTail;
    return t;
}

- (void)adoptChartPDF:(NSData *)pdf {
    if (!pdf.length || pdf == _chartPDF) return;
    _chartPDF = pdf;
    NSData *drawn = RecolourChartPDF(pdf);
    _chartPDFDrawn = drawn.length ? drawn : pdf;
    if (_pdfDoc) CGPDFDocumentRelease(_pdfDoc);
    _pdfDoc = NULL;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)_chartPDFDrawn);
    if (!provider) return;
    _pdfDoc = CGPDFDocumentCreateWithProvider(provider);
    CGDataProviderRelease(provider);
    if (!_pdfDoc || CGPDFDocumentGetNumberOfPages(_pdfDoc) < 1) {
        if (_pdfDoc) CGPDFDocumentRelease(_pdfDoc);
        _pdfDoc = NULL;
        _chartPDFDrawn = pdf;
        provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)pdf);
        _pdfDoc = CGPDFDocumentCreateWithProvider(provider);
        CGDataProviderRelease(provider);
    }
}

- (void)noteChartImage:(NSImage *)image pdf:(NSData *)pdf issued:(NSDate *)issued offline:(BOOL)offline {
    if (!_sourceECMWF && pdf.length && ![pdf isEqual:_chartPDF]) [self invalidateMotion];
    if (image) _chart = image;
    if (pdf.length) [self adoptChartPDF:pdf];
    if (issued) _issued = issued;
    _offline = offline;
    [self rebuildSequence];
}

- (void)noteAnalysisPDF:(NSData *)pdf {
    if (!IsPDF(pdf) || pdf == _analysisPDF) return;
    [self invalidateMotion];
    _analysisPDF = pdf;
    _analysisLocal = AnalysisLocalValidText(pdf);
    _geo = AnalysisGeoreference(pdf);
    if (_analysisDoc) CGPDFDocumentRelease(_analysisDoc);
    _analysisDrawn = RecolourAnalysisDocument(pdf);
    _analysisDoc = PDFDocumentFromData(_analysisDrawn.length ? _analysisDrawn : pdf);
    if (!_analysisDoc) _analysisDoc = PDFDocumentFromData(pdf);
    [self rebuildSequence];
}

- (void)notePreviousPrognosis:(NSData *)pdf issued:(NSDate *)issued {
    if (!IsPDF(pdf)) return;
    _previousPDF = pdf;
    _previousIssued = issued;
    if (_previousDoc) CGPDFDocumentRelease(_previousDoc);
    _previousDoc = PDFDocumentFromData(pdf);
    _previousTimes = PrognosisValidTimes(pdf) ?: @[];
}

- (void)setChartNow:(NSDate *)now {
    _chartNow = now;
    _pairPinned = NO;
}

- (void)rebuildSequence {
    if (_sourceECMWF) {
        NSMutableArray *times = [NSMutableArray array];
        for (NSNumber *idx in _frameIndices) {
            NSDate *when = [_ownRun timeAtIndex:idx.integerValue];
            if (when) [times addObject:when];
        }
        if (![_sequenceTimes isEqualToArray:times] || _hasAnalysisSlot) {
            _sequenceTimes = times;
            _hasAnalysisSlot = NO;
            _pairPinned = NO;
        }
        if (!_previousTimes) _previousTimes = @[];
        return;
    }
    NSDate *analysisTime = nil;
    NSArray *prog = _chartPDF.length ? PrognosisValidTimes(_chartPDF) : @[];
    if (prog.count == 0 && _pdfDoc) {
        NSMutableArray *fallback = [NSMutableArray array];
        for (int i = 0; i < 8; i++)
            [fallback addObject:[NSDate dateWithTimeIntervalSince1970:4102444800.0 + i * 43200.0]];
        prog = fallback;
    }
    BOOL slot = NO;
    NSArray *times = ChartSequenceTimes(nil, prog) ?: @[];
    (void)analysisTime;
    if (![_sequenceTimes isEqualToArray:times] || slot != _hasAnalysisSlot) {
        _sequenceTimes = times;
        _hasAnalysisSlot = slot;
        _pairPinned = NO;
    }
    if (!_previousTimes) _previousTimes = @[];
}

- (void)ensurePair {
    if (_sequenceTimes.count < 2) {
        _pair = (ChartPair){0, 0, NO};
        return;
    }
    if (_pairPinned && _pair.valid && _pair.left >= 0 && _pair.right < (NSInteger)_sequenceTimes.count && _pair.right > _pair.left)
        return;
    _pair = OpeningChartPair(_sequenceTimes, _chartNow ?: NSDate.date);
}

- (NSArray *)analysisPins {
    if (!_geo.valid) return @[];
    NSMutableArray *pins = [NSMutableArray array];
    for (NSDictionary *place in [self shownLocations]) {
        double x = 0, y = 0;
        if (!AnalysisProject(_geo, [place[@"latitude"] doubleValue], [place[@"longitude"] doubleValue], &x, &y)) continue;
        [pins addObject:@{@"x": @(x), @"y": @(y), @"name": place[@"name"] ?: @""}];
    }
    return pins;
}

- (CGPDFDocumentRef)documentForSequenceIndex:(NSInteger)index crop:(CGRect *)cropOut pins:(NSArray **)pinsOut {
    if (pinsOut) *pinsOut = nil;
    if (cropOut) *cropOut = CGRectZero;
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return NULL;
    if (_hasAnalysisSlot && index == 0) {
        CGPDFPageRef page = _analysisDoc ? CGPDFDocumentGetPage(_analysisDoc, 1) : NULL;
        if (!page) return NULL;
        if (cropOut) *cropOut = CGPDFPageGetBoxRect(page, kCGPDFMediaBox);
        if (pinsOut) *pinsOut = [self analysisPins];
        return _analysisDoc;
    }
    NSInteger panel = _hasAnalysisSlot ? index - 1 : index;
    if (panel < 0 || panel > 7 || !_pdfDoc) return NULL;
    CGPDFPageRef page = CGPDFDocumentGetPage(_pdfDoc, 1);
    if (!page) return NULL;
    MSLPPage chart = MSLPPageLayout(CGPDFPageGetBoxRect(page, kCGPDFMediaBox).size.width,
        CGPDFPageGetBoxRect(page, kCGPDFMediaBox).size.height);
    if (!chart.valid) return NULL;
    if (cropOut) *cropOut = CGRectMake(chart.panels[panel].x, chart.panels[panel].y, chart.panels[panel].width, chart.panels[panel].height);
    return _pdfDoc;
}

- (CGPDFDocumentRef)documentForPopoverIndex:(NSInteger)index crop:(CGRect *)cropOut pins:(NSArray **)pinsOut {
    if (pinsOut) *pinsOut = nil;
    if (cropOut) *cropOut = CGRectZero;
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return NULL;
    if (_hasAnalysisSlot && index == 0) {
        CGPDFPageRef page = _analysisDoc ? CGPDFDocumentGetPage(_analysisDoc, 1) : NULL;
        if (!page) return NULL;
        CGRect media = CGPDFPageGetBoxRect(page, kCGPDFMediaBox);
        MSLPRect window = AnalysisPopoverCrop(_geo, media.size.width, media.size.height);
        if (window.width < 10 || window.height < 10)
            window = (MSLPRect){0, 0, media.size.width, media.size.height};
        if (cropOut) *cropOut = CGRectMake(window.x, window.y, window.width, window.height);
        if (pinsOut) *pinsOut = [self analysisPins];
        return _analysisDoc;
    }
    NSInteger panel = _hasAnalysisSlot ? index - 1 : index;
    if (panel < 0 || panel > 7 || !_pdfDoc) return NULL;
    CGPDFPageRef page = CGPDFDocumentGetPage(_pdfDoc, 1);
    if (!page) return NULL;
    CGRect media = CGPDFPageGetBoxRect(page, kCGPDFMediaBox);
    MSLPRect map = MSLPPrognosisMapCrop(media.size.width, media.size.height, (int)panel);
    if (map.width < 10 || map.height < 10) {
        MSLPPage chart = MSLPPageLayout(media.size.width, media.size.height);
        if (!chart.valid) return NULL;
        map = chart.panels[panel];
    }
    if (cropOut) *cropOut = CGRectMake(map.x, map.y, map.width, map.height);
    return _pdfDoc;
}

- (CGSize)cropSizeForSequenceIndex:(NSInteger)index {
    CGRect crop = CGRectZero;
    if ([self documentForSequenceIndex:index crop:&crop pins:NULL] && crop.size.width > 1 && crop.size.height > 1)
        return crop.size;
    if (_hasAnalysisSlot && index == 0) return CGSizeMake(640, 432);
    return CGSizeMake(228, 183);
}

- (NSString *)humanTitleForIndex:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return @"";
    return SituationTitle(_sequenceTimes[index], _chartNow ?: NSDate.date, OwnerZone()) ?: @"";
}

- (NSString *)ecmwfPanelTitleForIndex:(NSInteger)index {
    return [self humanTitleForIndex:index];
}

- (NSString *)titleForSequenceIndex:(NSInteger)index {
    return [self humanTitleForIndex:index];
}

- (NSInteger)previousPrognosisPanelForSequenceIndex:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return -1;
    if (_hasAnalysisSlot && index == 0) return -1;
    return PreviousIssueIndex(_previousTimes, _sequenceTimes[index]);
}

// All map/detail surfaces inspect the same instant. A hover has its own
// restore point; rebuilding a panel must not silently switch it back to now.
- (NSDate *)selectedForecastDate {
    if (_sequenceTimes.count>1) {
        double fraction=NAN;
        if (_timelinePreviewing) fraction=_timelinePreviewFraction;
        else if (_motionSeeking) fraction=[self activeTimeline].progress;
        else if (_motionPendingFraction) fraction=_motionPendingFraction.doubleValue;
        else if (_scrubHasFraction) fraction=_scrubFraction;
        else if (_motionPlayer && _motionMovieURL) fraction=CMTimeGetSeconds(_motionPlayer.currentTime)/[self motionMovieSpan];
        else if (_motionHasCursor) return [self motionDateAtFrame:_motionCursor];
        if (isfinite(fraction)) return [_sequenceTimes.firstObject dateByAddingTimeInterval:
            [_sequenceTimes.lastObject timeIntervalSinceDate:_sequenceTimes.firstObject]*MIN(1,MAX(0,fraction))];
    }
    NSInteger index=_expandedMap?_panelIndex:(_pair.valid?_pair.left:0);
    return index>=0 && index<(NSInteger)_sequenceTimes.count ? _sequenceTimes[index] : (_chartNow ?: NSDate.date);
}

- (NSDate *)detailStartDate {
    NSDate *now=_chartNow ?: NSDate.date;
    NSDate *first=_sequenceTimes.firstObject;
    return first && [first compare:now]==NSOrderedAscending ? first : now;
}
- (double)detailHorizonHours {
    return MIN(120,MAX(24,ceil([_sequenceTimes.lastObject timeIntervalSinceDate:[self detailStartDate]]/3600)+1));
}

- (void)updateForecastInspection:(NSDate *)date {
    if (!date || !_forecastGraph) return;
    NSTimeZone *zone=(_forecastMode==1)?[self aviationTimeZone]:ZoneForPlace((_forecastMode==0 || _forecastMode==3)?[self windPlace]:[self rainPlace]);
    _forecastTime.stringValue=[NSString stringWithFormat:@"%@ · %@",ForecastDay(date,_chartNow ?: NSDate.date,zone),SituationClock(date,zone)];
    if ([_forecastGraph isKindOfClass:AviationForecastView.class]) {
        [(AviationForecastView *)_forecastGraph setSelectedDate:date];
        return;
    }
    [(id)_forecastGraph setSelectedDate:date];
    NSDictionary *place=(_forecastMode==0 || _forecastMode==3)?[self windPlace]:[self rainPlace];
    NSDictionary *row=MapDetailSample([self packFor:place][@"series"],date);
    NSString *reading=@"No forecast";
    BOOL (^valid)(id)=^BOOL(id value) { return [value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]); };
    if (_forecastMode==2) {
        RainForecastView *rain=(RainForecastView *)_forecastGraph;
        for (NSDictionary *hour in rain.outlook[@"hours"]) {
            if ([date compare:hour[@"start"]]==NSOrderedAscending || [date compare:hour[@"end"]]!=NSOrderedAscending) continue;
            if ([hour[@"known"] boolValue]) {
                double mm=[hour[@"mm"] doubleValue];
                NSString *amount=mm>0 && mm<.1?@"<0.1":[NSString stringWithFormat:@"%.1f",mm];
                reading=[NSString stringWithFormat:@"%@ · %@ mm",mm>0?hour[@"kind"]:@"Dry",amount];
            }
            break;
        }
    } else if (_forecastMode==4 && valid(row[@"temp"])) reading=[NSString stringWithFormat:@"%.0f°C",[row[@"temp"] doubleValue]];
    else if (_forecastMode==0 && valid(row[@"windKt"])) {
        reading=[NSString stringWithFormat:@"%.0f kt",[row[@"windKt"] doubleValue]];
        if (valid(row[@"gustKt"]) && [row[@"gustKt"] doubleValue]>[row[@"windKt"] doubleValue])
            reading=[reading stringByAppendingFormat:@" · gust %.0f",[row[@"gustKt"] doubleValue]];
    } else if (_forecastMode==3) {
        row=MapDetailSample(((SurfForecastView *)_forecastGraph).outlook[@"rows"],date);
        if (valid(row[@"waveHeight"])) reading=[NSString stringWithFormat:@"%.1f m waves",[row[@"waveHeight"] doubleValue]];
        if (valid(row[@"swellPeriod"])) reading=[reading stringByAppendingFormat:@" · %.0f s swell",[row[@"swellPeriod"] doubleValue]];
    }
    _forecastReading.stringValue=reading;
    _forecastReading.toolTip=reading;
}

- (void)updatePopoverPlayControl {
    NSString *label = _motionPreparing ? @"Preparing animation" : (_popoverPlaying ? @"Pause forecast" : @"Play forecast");
    _popoverPlayButton.image = [NSImage imageWithSystemSymbolName:_motionPreparing ? @"hourglass" : (_popoverPlaying ? @"pause.fill" : @"play.fill") accessibilityDescription:label];
    _popoverPlayButton.accessibilityLabel = label;
    _popoverPlayButton.toolTip = _motionError ?: [label stringByAppendingString:@" (Space)"];
    NSString *windowLabel=_motionPreparing?@"Preparing animation":(_looping?@"Pause forecast":@"Play forecast");
    _chartPlayButton.image=[NSImage imageWithSystemSymbolName:_motionPreparing?@"hourglass":(_looping?@"pause.fill":@"play.fill") accessibilityDescription:windowLabel];
    _chartPlayButton.accessibilityLabel=windowLabel;
    _chartPlayButton.toolTip=_motionError ?: windowLabel;
}

- (PDFCropView *)timelineChart { return _expandedMap ? (PDFCropView *)_singleScroll.documentView : _leftChart; }
- (TimelineStrip *)activeTimeline { return _expandedMap ? _chartTimeline : _popoverTimeline; }
- (BOOL)timelinePlaying { return _expandedMap ? _looping : _popoverPlaying; }
- (void)setTimelinePlaying:(BOOL)playing { if (_expandedMap) _looping=playing; else _popoverPlaying=playing; }
- (void)updateTimelineHeading:(NSDate *)date {
    if (_expandedMap) _timeTitle.stringValue=[NSString stringWithFormat:@"%@ · %@",ForecastDay(date,_chartNow ?: NSDate.date,OwnerZone()),SituationClock(date,OwnerZone())];
    else _leftTitle.attributedStringValue=[self popoverHeadingText:ForecastDay(date,_chartNow ?: NSDate.date,OwnerZone()) clock:SituationClock(date,OwnerZone()) kind:nil];
}

- (void)cancelMotionPreparation {
    if (!_motionPreparing) return;
    [_motionPreparation cancel];
    _motionPreparation = nil;
    _motionPreparing = NO;
    _motionGeneration++;
}

- (void)stopPopoverPlayback {
    [_scrubRenderer cancelRequests];
    _scrubHasFraction = NO;
    _timelinePreviewing = NO;
    _evolutionOnOpenPending = NO;
    _motionResetToNow = NO; _motionPendingFraction = nil;
    _motionSeekGeneration++; _motionSeeking = NO; _motionQueuedFraction = nil;
    [_motionPlayer.currentItem cancelPendingSeeks];
    _popoverPlaying = NO;
    [_popoverLoopTimer invalidate];
    _popoverLoopTimer = nil;
    [_motionPlayer pause];
    if (!_looping) [self cancelMotionPreparation];
    [self updatePopoverPlayControl];
}

- (void)invalidateMotion {
    [self stopPopoverPlayback];
    _scrubRenderer = nil; _scrubKey = nil;
    [self stopChartLoop];
    [self cancelMotionPreparation];
    _motionFrames = nil;
    if (_motionTimeObserver && _motionPlayer) [_motionPlayer removeTimeObserver:_motionTimeObserver];
    _motionTimeObserver = nil;
    [_motionPlayer pause];
    _motionPlayer = nil;
    _motionMovieURL = nil;
    _motionSeeking = NO; _motionSeekGeneration++;
    _motionHasCursor = NO;
    _motionResetToNow = NO;
    _motionPendingFraction = nil;
    _motionError = nil;
}

- (NSDate *)motionDateAtFrame:(NSUInteger)frame {
    if (_motionPlayer && _motionMovieURL && _sequenceTimes.count > 1) {
        double seconds = CMTimeGetSeconds(_motionPlayer.currentTime);
        if (!isfinite(seconds)) return nil;
        return [_sequenceTimes.firstObject dateByAddingTimeInterval:
            [_sequenceTimes.lastObject timeIntervalSinceDate:_sequenceTimes.firstObject] * MIN(1, MAX(0, seconds/[self motionMovieSpan]))];
    }
    NSUInteger segment = frame / kMotionIntervals;
    NSInteger index = MIN((NSInteger)_sequenceTimes.count - 1, _motionStartIndex + (NSInteger)segment);
    if (index < 0) return nil;
    NSDate *date = _sequenceTimes[index];
    if (index + 1 >= (NSInteger)_sequenceTimes.count) return date;
    return [date dateByAddingTimeInterval:[_sequenceTimes[index + 1] timeIntervalSinceDate:date] * (frame % kMotionIntervals) / kMotionIntervals];
}

- (void)retitleMotionField:(NSTextField *)field frame:(NSUInteger)frame {
    if (!field) return;
    NSDate *date = [self motionDateAtFrame:frame];
    field.attributedStringValue = [self popoverHeadingText:ForecastDay(date, _chartNow ?: NSDate.date, OwnerZone())
        clock:SituationClock(date, OwnerZone()) kind:nil];
    field.toolTip = @"Frames interpolated between forecast maps";
}

- (NSUInteger)motionFrameNow {
    // One second at each forecast step, followed by a short hold at the end.
    NSUInteger count = _motionFrames.count;
    if (!count) return 0;
    NSUInteger tick = (NSUInteger)MAX(0, floor((NSProcessInfo.processInfo.systemUptime - _motionEpoch) * kMotionFPS));
    return (_motionOffset + tick) % count;
}

- (void)showPopoverMotionFrame:(NSUInteger)frame {
    if (!_motionFrames.count) return;
    NSUInteger last = _motionFrames.count - 1;
    NSUInteger left = MIN(frame, last > kMotionIntervals ? last - kMotionIntervals : 0);
    _motionCursor = left; _motionHasCursor = YES; _motionCursorFullscreen = NO;
    NSInteger index = _motionStartIndex + (NSInteger)(left / kMotionIntervals);
    _pair = (ChartPair){index, MIN(index + 1, (NSInteger)_sequenceTimes.count - 1), YES};
    _pairPinned = YES;
    _shownLeft = _pair.left; _shownRight = _pair.right;
    _leftChart.sequenceIndex = index;
    _leftChart.mapDetails = [self mapDetailsAtTime:[self motionDateAtFrame:left]];
    [_leftChart setChartImage:_motionFrames[left] comparison:nil alpha:0];
    [self retitleMotionField:_leftTitle frame:left];
    [self updateForecastInspection:[self motionDateAtFrame:left]];
    if (_popoverTimeline.leftIndex != index) {
        _popoverTimeline.leftIndex = index; _popoverTimeline.rightIndex = index;
    }
    _popoverTimeline.progress = _motionFrames.count > 1
        ? (CGFloat)left / (CGFloat)(_motionFrames.count - 1) : 0;
    _popoverTimeline.needsDisplay = YES;
}

- (void)advancePopoverPlayback {
    if (_popoverPlaying) [self showPopoverMotionFrame:[self motionFrameNow]];
}

- (double)motionMovieFPS {
    // Player-item tracks are already loaded for playback; avoid synchronous
    // asset-track loading on every timeline tick.
    for (AVPlayerItemTrack *track in _motionPlayer.currentItem.tracks) {
        if (![track.assetTrack.mediaType isEqualToString:AVMediaTypeVideo]) continue;
        double fps = track.assetTrack.nominalFrameRate;
        if (isfinite(fps) && fps >= 1) return fps;
    }
    return 60; // Isobar's generated movie rate, also used while preparing.
}

- (double)motionMovieSpan {
    AVPlayerItem *item = _motionPlayer.currentItem;
    double duration = CMTimeGetSeconds(item.duration);
    if (!isfinite(duration) || duration <= 0) duration = 30;
    double fps = [self motionMovieFPS];
    return MAX(.001, duration - 1.0 / fps);
}

- (void)updateRawMovieTime:(CMTime)time {
    if (_motionSeeking || !CMTIME_IS_NUMERIC(time)) return;
    double seconds = MAX(0, CMTimeGetSeconds(time));
    double span = [self motionMovieSpan];
    double movieProgress = MIN(1.0, MAX(0.0, seconds / span));
    NSDate *base = [_ownRun timeAtIndex:[self hourForSequenceIndex:_motionStartIndex]];
    NSDate *last = [_ownRun timeAtIndex:[self hourForSequenceIndex:(NSInteger)_sequenceTimes.count - 1]];
    if (!base || !last) return;
    NSDate *date = [base dateByAddingTimeInterval:[last timeIntervalSinceDate:base] * movieProgress];
    double fps = [self motionMovieFPS];
    NSUInteger frame = (NSUInteger)MAX(0, floor(seconds * fps));
    _motionCursor = frame; _motionHasCursor = YES;
    [self activeTimeline].progress = movieProgress;
    NSInteger nearest = 0; NSTimeInterval nearestDistance = DBL_MAX;
    for (NSInteger i = 0; i < (NSInteger)_sequenceTimes.count; i++) {
        NSTimeInterval distance = fabs([_sequenceTimes[i] timeIntervalSinceDate:date]);
        if (distance < nearestDistance) { nearest = i; nearestDistance = distance; }
    }
    [self activeTimeline].leftIndex = nearest; [self activeTimeline].rightIndex = nearest;
    [self activeTimeline].needsDisplay = YES;
    // Point readings use their hourly sample; both headings show the actual
    // selected minute while the underlying field moves continuously.
    NSDate *displayDate = [NSDate dateWithTimeIntervalSince1970:round(date.timeIntervalSince1970/3600)*3600];
    if (!_motionCursorFullscreen) {
        _leftChart.mapDetails = [self mapDetailsAtTime:displayDate];
        [self updateForecastInspection:date];
        _leftTitle.attributedStringValue = [self popoverHeadingText:ForecastDay(date, _chartNow ?: NSDate.date, OwnerZone())
            clock:SituationClock(date, OwnerZone()) kind:nil];
    } else {
        PDFCropView *panel = (PDFCropView *)_singleScroll.documentView;
        _panelIndex=nearest;
        panel.mapDetails = [self mapDetailsAtTime:displayDate];
        _timeTitle.stringValue = [NSString stringWithFormat:@"%@ · %@",
            ForecastDay(date, _chartNow ?: NSDate.date, OwnerZone()), SituationClock(date, OwnerZone())];
    }
    if (seconds >= span - .0001 && !_motionQueuedFraction) {
        // Ambient playback wraps to the current weather. A manually selected
        // endpoint stays still, and an expired forecast never loops in place.
        double nowFraction = [self motionFractionForDate:(_chartNow ?: NSDate.date)];
        if ((_popoverPlaying || _looping) && nowFraction < 1) {
            [self seekPopoverMovieFraction:nowFraction];
            return;
        }
        _popoverPlaying = NO;
        _looping = NO;
        [_motionPlayer pause];
        [self updatePopoverPlayControl];
    }
}

- (void)startPreparedMotion {
    if (!_motionFrames.count && !_motionMovieURL) return;
    // The movie is for playback. Leave the raw renderer in control during
    // hover and drag, including when encoding finishes mid-interaction.
    if (([self activeTimeline].pointerScrubbing || _scrubHasFraction || _timelinePreviewing) &&
        !_popoverPlaying && !_looping) return;
    if (_motionMovieURL) {
        [_scrubRenderer cancelRequests];
        _scrubHasFraction = NO;
        if (_motionTimeObserver && _motionPlayer) [_motionPlayer removeTimeObserver:_motionTimeObserver];
        BOOL newPlayer = !_motionPlayer;
        if (newPlayer) {
            _motionPlayer = [AVPlayer playerWithURL:_motionMovieURL];
            // This is a fully encoded local file, with nothing to buffer from
            // the network. Start promptly after a seek, including at 60 fps.
            _motionPlayer.automaticallyWaitsToMinimizeStalling = NO;
            _motionPlayer.allowsExternalPlayback = NO;
        }
        PDFCropView *target = [self timelineChart];
        [target attachMoviePlayer:_motionPlayer];
        _motionCursorFullscreen = _expandedMap;
        __weak Controller *weak = self;
        _motionTimeObserver = [_motionPlayer addPeriodicTimeObserverForInterval:CMTimeMake(1, 30)
            queue:dispatch_get_main_queue() usingBlock:^(CMTime time) {
                Controller *strong = weak;
                if (!strong || strong->_motionSeeking || !CMTIME_IS_NUMERIC(time)) return;
                [strong updateRawMovieTime:time];
            }];
        if (_motionResetToNow || _motionPendingFraction) {
            double fraction = _motionResetToNow ? [self motionFractionForDate:(_chartNow ?: NSDate.date)] : _motionPendingFraction.doubleValue;
            _motionResetToNow = NO; _motionPendingFraction = nil;
            [self seekPopoverMovieFraction:fraction];
        } else if (newPlayer && _sourceECMWF && _ownRun.hours > 1) {
            NSInteger selectedHour = [self hourForSequenceIndex:MAX(_motionStartIndex, _pair.left)];
            NSInteger firstHour = [self hourForSequenceIndex:_motionStartIndex];
            NSInteger lastHour = [self hourForSequenceIndex:(NSInteger)_sequenceTimes.count - 1];
            if (selectedHour >= firstHour && lastHour > firstHour) {
                double fraction = (double)(selectedHour - firstHour) / (double)(lastHour - firstHour);
                [self seekPopoverMovieFraction:fraction];
            }
        }
        if (!newPlayer && !_motionSeeking && (_popoverPlaying || _looping) && CMTimeGetSeconds(_motionPlayer.currentTime) >= [self motionMovieSpan] - .001)
            [self seekPopoverMovieFraction:[self motionFractionForDate:(_chartNow ?: NSDate.date)]];
        [self playMotionWhenReady];
        [self updatePopoverPlayControl];
        return;
    }
    NSInteger index = _looping ? _panelIndex : _pair.left;
    _motionOffset = _motionHasCursor && _motionCursorFullscreen == _looping ? _motionCursor : (NSUInteger)MAX(0, index - _motionStartIndex) * kMotionIntervals;
    _motionEpoch = NSProcessInfo.processInfo.systemUptime;
    __weak Controller *weak = self;
    if (_popoverPlaying) {
        [_popoverLoopTimer invalidate];
        _popoverLoopTimer = [NSTimer timerWithTimeInterval:1.0 / kMotionFPS repeats:YES block:^(NSTimer *timer) {
            Controller *strong = weak;
            if (!strong || !strong.popover.shown) { [timer invalidate]; [strong stopPopoverPlayback]; return; }
            [strong advancePopoverPlayback];
        }];
        [NSRunLoop.mainRunLoop addTimer:_popoverLoopTimer forMode:NSRunLoopCommonModes];
        [self advancePopoverPlayback];
    } else if (_looping) {
        [_loopTimer invalidate];
        _loopTimer = [NSTimer timerWithTimeInterval:1.0 / kMotionFPS repeats:YES block:^(NSTimer *timer) {
            Controller *strong = weak;
            if (!strong || !strong->_chartWindow.isVisible) { [timer invalidate]; [strong stopChartLoop]; return; }
            [strong loopTick];
        }];
        [NSRunLoop.mainRunLoop addTimer:_loopTimer forMode:NSRunLoopCommonModes];
        [self loopTick];
    }
    [self updatePopoverPlayControl];
}

- (void)playMotionWhenReady {
    AVPlayer *player = _motionPlayer;
    if (!player || _motionSeeking || (!_popoverPlaying && !_looping)) return;
    if (player.status == AVPlayerStatusFailed || player.currentItem.status == AVPlayerItemStatusFailed) {
        _motionError = @"Animation unavailable"; _popoverPlaying = NO; _looping = NO;
        [self updatePopoverPlayControl]; return;
    }
    if (player.status == AVPlayerStatusReadyToPlay && player.currentItem.status == AVPlayerItemStatusReadyToPlay) {
        double duration = CMTimeGetSeconds(player.currentItem.duration);
        [player playImmediatelyAtRate:(float)MIN(1.0, MAX(.25, duration / kEvolutionDuration))];
        return;
    }
    __weak Controller *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        Controller *strong = weak;
        if (strong && strong->_motionPlayer == player) [strong playMotionWhenReady];
    });
}

- (NSString *)motionMovieKey {
    NSString *run = _runDate ? [NSString stringWithFormat:@"%.0f", _runDate.timeIntervalSince1970] : @"run";
    NSInteger first = [self hourForSequenceIndex:_motionStartIndex];
    NSInteger last = [self hourForSequenceIndex:MAX(_motionStartIndex, (NSInteger)_sequenceTimes.count - 1)];
    return [NSString stringWithFormat:@"v5-120s-60fps-%@-%ld-%ld-t%ld-b%d-r%d", run, (long)first, (long)last,
        (long)_tempLayer, _barbs, _rainLayer];
}

- (void)prepareRawMotionMovie {
    if (!_ownRun || _sequenceTimes.count < 2) return;
    NSInteger first = [self hourForSequenceIndex:_motionStartIndex];
    NSInteger last = [self hourForSequenceIndex:(NSInteger)_sequenceTimes.count - 1];
    if (first < 0 || last <= first) { _motionError = @"Animation source times are unavailable"; return; }
    NSString *directory = [[@"~/Library/Caches/Isobar/motion" stringByExpandingTildeInPath] stringByStandardizingPath];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSURL *url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:[[self motionMovieKey] stringByAppendingPathExtension:@"mp4"]]];
    if ([NSFileManager.defaultManager fileExistsAtPath:url.path]) {
        AVAsset *cached = [AVURLAsset URLAssetWithURL:url options:nil];
        if (CMTIME_IS_NUMERIC(cached.duration) && CMTimeGetSeconds(cached.duration) >= kEvolutionDuration - .5) {
            _motionMovieURL = url;
            [self startPreparedMotion];
            return;
        }
        [NSFileManager.defaultManager removeItemAtURL:url error:NULL];
    }
    NSURL *temporaryURL = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:
        [NSString stringWithFormat:@".%@.%@.tmp.mp4", url.lastPathComponent, NSUUID.UUID.UUIDString]]];
    _motionPreparing = YES;
    _motionError = nil;
    NSUInteger generation = ++_motionGeneration;
    NSProgress *progress = [NSProgress progressWithTotalUnitCount:7200];
    _motionPreparation = progress;
    [self updatePopoverPlayControl];
    OwnLayerOptions layers = {0};
    layers.temperature = (int)_tempLayer; layers.barbs = _barbs; layers.rain = _rainLayer;
    OwnRun *movieRun = _ownRun;
    __weak Controller *weak = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *error = nil;
        BOOL okay = IsobarWriteRawMovie(movieRun, temporaryURL, first, last, 60, kEvolutionDuration, layers, progress, &error);
        if (okay) okay = [NSFileManager.defaultManager moveItemAtURL:temporaryURL toURL:url error:NULL];
        if (!okay) [NSFileManager.defaultManager removeItemAtURL:temporaryURL error:NULL];
        dispatch_async(dispatch_get_main_queue(), ^{
            Controller *strong = weak;
            if (!strong || generation != strong->_motionGeneration || progress.cancelled) return;
            strong->_motionPreparing = NO; strong->_motionPreparation = nil;
            if (!okay) {
                strong->_motionError = error ?: @"Animation could not be prepared";
                strong->_popoverPlaying = NO; strong->_looping = NO;
                strong->_motionResetToNow = NO; strong->_motionPendingFraction = nil;
                [strong updatePopoverPlayControl];
                return;
            }
            strong->_motionMovieURL = url;
            [strong startPreparedMotion];
        });
    });
}

- (void)prepareMotion {
    if (!MotionEnabled() && !_sourceECMWF) { _looping=NO; _popoverPlaying=NO; return; }
    if (_motionFrames.count) { [self startPreparedMotion]; return; }
    if (_motionPreparing) return;
    // Analysis and prognosis use different map projections. Only animate the
    // registered prognosis panels; manual navigation still includes analysis.
    _motionStartIndex = (!_sourceECMWF && _hasAnalysisSlot) ? 1 : 0;
    NSMutableArray<NSDictionary *> *specs = [NSMutableArray array];
    if (_sourceECMWF) {
        [self prepareRawMotionMovie];
        return;
    }
    NSData *pdf = [_chartPDFDrawn copy];
    for (NSInteger i = _motionStartIndex; i < MIN((NSInteger)9, (NSInteger)_sequenceTimes.count); i++) {
        CGRect crop = CGRectZero;
        [self documentForPopoverIndex:i crop:&crop pins:NULL];
        [specs addObject:@{@"crop": [NSValue valueWithRect:NSRectFromCGRect(crop)]}];
    }
    if (specs.count < 2) { _motionError = @"At least two forecast maps are needed"; [self stopPopoverPlayback]; [self stopChartLoop]; return; }
    _motionError = nil;
    _motionPreparing = YES;
    NSProgress *progress = [NSProgress progressWithTotalUnitCount:specs.count * 2 - 1];
    _motionPreparation = progress;
    NSUInteger generation = ++_motionGeneration;
    [self updatePopoverPlayControl];
    if (_chartWindow.isVisible) [self layoutChartToolbarIn:_chartWindow.contentView height:42];
    __weak Controller *weak = self;
    static dispatch_queue_t motionQueue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ motionQueue = dispatch_queue_create("isobar.motion", DISPATCH_QUEUE_SERIAL); });
    dispatch_async(motionQueue, ^{
        NSMutableArray<NSImage *> *keys = [NSMutableArray array];
        CGPDFDocumentRef document = !progress.cancelled ? PDFDocumentFromData(pdf) : NULL;
        NSMutableArray<NSImage *> *frames = [NSMutableArray array];
        NSString *error = nil;
        {
            for (NSDictionary *spec in specs) {
                if (progress.cancelled) break;
                @autoreleasepool {
                    CGRect crop = NSRectToCGRect([spec[@"crop"] rectValue]);
                    NSImage *image = nil;
                    if (crop.size.width > 0 && crop.size.height > 0) {
                        CGFloat scale = MIN(580 / crop.size.width, 444 / crop.size.height);
                        CGImageRef cg = ChartCropImage(document, crop, (size_t)MAX(1, round(crop.size.width * scale)), (size_t)MAX(1, round(crop.size.height * scale)));
                        if (cg) { image = [[NSImage alloc] initWithCGImage:cg size:NSZeroSize]; CGImageRelease(cg); }
                    }
                    if (image) [keys addObject:image];
                    else error = @"Animation could not load the forecast maps";
                    progress.completedUnitCount++;
                }
            }
            for (NSUInteger i = 1; i < keys.count && !error && !progress.cancelled; i++) {
                @autoreleasepool {
                    NSArray *segment = IsobarMotionFrames(keys[i - 1], keys[i], kMotionIntervals, &error);
                    if (!segment) break;
                    [frames addObjectsFromArray:[segment subarrayWithRange:NSMakeRange(0, segment.count - 1)]];
                    progress.completedUnitCount++;
                }
            }
            if (!error && !progress.cancelled && keys.count) [frames addObject:keys.lastObject];
        }
        if (document) CGPDFDocumentRelease(document);
        dispatch_async(dispatch_get_main_queue(), ^{
            Controller *strong = weak;
            if (!strong || generation != strong->_motionGeneration || progress.cancelled) return;
            strong->_motionPreparing = NO; strong->_motionPreparation = nil;
            if (error || frames.count < 2) {
                strong->_motionError = error ?: @"Animation could not be prepared";
                [strong stopPopoverPlayback]; [strong stopChartLoop];
            } else { strong->_motionFrames = frames; [strong startPreparedMotion]; }
            [strong updatePopoverPlayControl];
            if (strong->_chartWindow.isVisible) [strong layoutChartToolbarIn:strong->_chartWindow.contentView height:42];
        });
    });
}

- (double)motionFractionForDate:(NSDate *)date {
    NSDate *first = _sequenceTimes.firstObject, *last = _sequenceTimes.lastObject;
    NSTimeInterval span = [last timeIntervalSinceDate:first];
    return first && last && span > 0 ? MIN(1.0, MAX(0.0, [date timeIntervalSinceDate:first] / span)) : 0;
}

- (void)useRawForecastForMotion {
    if (!_sourceECMWF && _ownRun.hours > 1) {
        [self invalidateMotion];
        _sourceECMWF = YES;
        [[self chartPreferences] setObject:@"ecmwf" forKey:@"chartSource"];
        [self rebuildSequence];
        [self ensurePair];
        if (_expandedMap) [self layoutChartWindow]; else [self rebuildContent];
    }
}

- (void)endChartComparison {
    if (!_comparing) return;
    _comparing=NO;
    [[self timelineChart] clearComparison];
    if (_expandedMap) [self layoutChartToolbarIn:_chartWindow.contentView height:42];
}

- (void)resetPopoverToNow {
    [self endChartComparison];
    [_scrubRenderer cancelRequests];
    _scrubHasFraction = NO;
    _timelinePreviewing = NO;
    _evolutionOnOpenPending = _ownRun.hours < 2;
    if (_evolutionOnOpenPending) return;
    [self useRawForecastForMotion];
    [self stopChartLoop];
    _motionResetToNow = YES;
    _motionPendingFraction = nil;
    [self setTimelinePlaying:YES];
    if (_motionMovieURL) [self startPreparedMotion];
    else [self prepareMotion];
    [self updatePopoverPlayControl];
}

- (BOOL)allowsAutomaticEvolution {
    return !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}

- (void)beginPopoverEvolution {
    if ([self allowsAutomaticEvolution]) [self resetPopoverToNow];
}

- (void)inspectPopoverMovieFraction:(double)fraction {
    [self endChartComparison];
    _timelinePreviewing = NO;
    _evolutionOnOpenPending = NO;
    if (_ownRun.hours < 2) { [self seekPopoverMovieFraction:fraction]; return; }
    [self useRawForecastForMotion];
    if (_sequenceTimes.count < 2) return;
    [self setTimelinePlaying:NO];
    [_motionPlayer pause];
    _motionResetToNow = NO;
    fraction = MIN(1, MAX(0, fraction));
    _motionPendingFraction = @(fraction);
    [self showStaticTimelineFraction:fraction];
    if (!_motionMovieURL) [self prepareMotion];
    [self updatePopoverPlayControl];
}

- (void)showStaticTimelineFraction:(double)fraction {
    if (![self timelineChart].superview || !_sequenceTimes.count) return;
    fraction = MIN(1, MAX(0, fraction));
    NSDate *first = _sequenceTimes.firstObject, *last = _sequenceTimes.lastObject;
    NSDate *target = [first dateByAddingTimeInterval:[last timeIntervalSinceDate:first] * fraction];
    NSInteger index = 0;
    NSTimeInterval closest = DBL_MAX;
    for (NSInteger i = 0; i < (NSInteger)_sequenceTimes.count; i++) {
        NSTimeInterval distance = fabs([_sequenceTimes[i] timeIntervalSinceDate:target]);
        if (distance < closest) { closest = distance; index = i; }
    }
    [self activeTimeline].progress = fraction;
    [self activeTimeline].needsDisplay = YES;
    if (!_sourceECMWF || _ownRun.hours < 2) {
        [self placePopoverChart:[self timelineChart] index:index frame:[self timelineChart].frame in:[self timelineChart].superview];
        [self updateTimelineHeading:_sequenceTimes[index]];
        [self updateForecastInspection:_sequenceTimes[index]];
        return;
    }
    // Raw fields render quickly enough to track the pointer. Random video
    // seeks can starve the display until the pointer stops, so keep the movie
    // for playback and render scrub frames directly from the model.
    OwnRun *run = _ownRun;
    double modelIndex = run.hours - 1;
    for (NSInteger i = 1; i < run.hours; i++) {
        NSDate *end = [run timeAtIndex:i];
        if ([target compare:end] != NSOrderedDescending) {
            NSDate *start = [run timeAtIndex:i-1];
            NSTimeInterval span = [end timeIntervalSinceDate:start];
            modelIndex = i-1 + (span > 0 ? MIN(1, MAX(0, [target timeIntervalSinceDate:start]/span)) : 0);
            break;
        }
    }
    OwnLayerOptions layers = {.temperature=(int)_tempLayer, .barbs=_barbs, .rain=_rainLayer, .bare=1};
    NSString *key = [NSString stringWithFormat:@"%p-%ld-%d-%d", run, (long)_tempLayer, _barbs, _rainLayer];
    if (![_scrubKey isEqual:key]) {
        [_scrubRenderer cancelRequests];
        _scrubRenderer = [[IsobarScrubRenderer alloc] initWithRun:run layers:layers scale:1];
        _scrubKey = key;
    }
    _scrubHasFraction = YES; _scrubFraction = fraction;
    if (!_timelinePreviewing) {
        _pair = (ChartPair){index, MIN(index+1, (NSInteger)_sequenceTimes.count-1), YES};
        _pairPinned = YES; _shownLeft = index;
        if (_expandedMap) _panelIndex=index;
    }
    [self updateTimelineHeading:target];
    // Detail markers belong to the image that actually reached the screen;
    // calculating them for superseded pointer events wastes main-thread time.
    __weak Controller *weak = self;
    __weak PDFCropView *chart = [self timelineChart];
    [_scrubRenderer requestIndex:modelIndex completion:^(NSImage *image, double renderedIndex) {
        Controller *strong = weak;
        PDFCropView *surface = chart;
        if (!strong || !image || surface != [strong timelineChart] || !surface.superview ||
            !strong->_scrubHasFraction || strong->_ownRun != run ||
            ![strong->_scrubKey isEqual:key]) return;
        NSInteger lower = (NSInteger)floor(renderedIndex), upper = MIN(lower+1, run.hours-1);
        NSDate *start = [run timeAtIndex:lower], *end = [run timeAtIndex:upper];
        NSDate *date = [start dateByAddingTimeInterval:[end timeIntervalSinceDate:start]*(renderedIndex-lower)];
        strong->_scrubDisplayedFraction = [strong motionFractionForDate:date];
        [surface setChartImage:image comparison:nil alpha:0];
        [surface setPins:nil];
        surface.mapDetails = [strong mapDetailsAtTime:date];
        [strong updateForecastInspection:date];
        strong->_leftTitle.attributedStringValue = [strong popoverHeadingText:ForecastDay(date, strong->_chartNow ?: NSDate.date, OwnerZone())
            clock:SituationClock(date, OwnerZone()) kind:nil];
    }];
}

- (void)previewPopoverMovieFraction:(double)fraction {
    if (_sequenceTimes.count < 2) return;
    if (!isfinite(fraction)) {
        if (!_timelinePreviewing) return;
        // Leaving the strip commits the inspected time. A narrow hover target
        // must never bounce the map back to Now when the pointer slips off.
        double selected = isfinite(_timelinePreviewFraction) ? _timelinePreviewFraction
            : _timelinePreviewRestoreFraction;
        _timelinePreviewing = NO;
        [self setTimelinePlaying:_timelinePreviewWasPlaying];
        _motionResetToNow = NO;
        _motionPendingFraction = @(selected);
        if ([self timelinePlaying] && _motionMovieURL && _motionPlayer) {
            [_scrubRenderer cancelRequests];
            _scrubHasFraction = NO;
            _motionPendingFraction = nil;
            [[self timelineChart] attachMoviePlayer:_motionPlayer];
            [self seekPopoverMovieFraction:selected];
        } else if ([self timelinePlaying]) {
            if (_motionMovieURL) [self startPreparedMotion];
            else if (!_motionPreparing) [self prepareMotion];
        }
        [self updatePopoverPlayControl];
        return;
    }
    if (!_timelinePreviewing) {
        _timelinePreviewRestoreFraction = _motionResetToNow ? [self motionFractionForDate:(_chartNow ?: NSDate.date)]
            : _motionPendingFraction ? _motionPendingFraction.doubleValue
            : _motionSeeking ? [self activeTimeline].previewRestoreFraction
            : _motionPlayer ? CMTimeGetSeconds(_motionPlayer.currentTime) / [self motionMovieSpan]
            : [self activeTimeline].previewRestoreFraction;
        if (!isfinite(_timelinePreviewRestoreFraction)) _timelinePreviewRestoreFraction = 0;
        _timelinePreviewWasPlaying = [self timelinePlaying];
        _timelinePreviewFraction = NAN;
        _timelinePreviewing = YES;
    }
    fraction = MIN(1, MAX(0, fraction));
    if (isfinite(_timelinePreviewFraction) && fabs(fraction - _timelinePreviewFraction) < .000001) return;
    [self endChartComparison];
    _timelinePreviewFraction = fraction;
    [self setTimelinePlaying:NO];
    [_motionPlayer pause];
    _motionResetToNow = NO;
    _motionPendingFraction = @(fraction);
    [self showStaticTimelineFraction:fraction];
    [self updatePopoverPlayControl];
}

- (void)togglePopoverPlayback:(id)sender {
    (void)sender;
    _timelinePreviewing = NO;
    if (_popoverPlaying) { [self stopPopoverPlayback]; return; }
    if (_sequenceTimes.count < 2 || !_pair.valid) return;
    if (!_sourceECMWF && _ownRun.hours > 0) {
        _sourceECMWF = YES;
        [[self chartPreferences] setObject:@"ecmwf" forKey:@"chartSource"];
        [self invalidateMotion];
        [self rebuildSequence];
        [self ensurePair];
        if (self.popover.shown) [self rebuildContent];
    }
    [self stopChartLoop];
    _popoverPlaying = YES;
    [self prepareMotion];
    [self updatePopoverPlayControl];
}

- (void)stepPopoverPair:(NSInteger)delta {
    _motionHasCursor = NO;
    if (_motionMovieURL) [self invalidateMotion];
    else [self stopPopoverPlayback];
    if (!_pair.valid || delta == 0) return;
    ChartPair next = StepChartPair(_pair, delta, (NSInteger)_sequenceTimes.count);
    if (next.left == _pair.left && next.right == _pair.right) return;
    _pair = next;
    _pairPinned = YES;
    if (self.popover.shown) [self rebuildContent];
}

- (void)stepPairButton:(NSButton *)sender {
    [self stepPopoverPair:sender.tag];
}

- (void)selectPopoverIndex:(NSInteger)index {
    _motionHasCursor = NO;
    if (_motionMovieURL) [self invalidateMotion];
    else [self stopPopoverPlayback];
    NSInteger count = (NSInteger)_sequenceTimes.count;
    if (count < 2 || index < 0 || index >= count) return;
    ChartPair next = index >= count - 1
        ? (ChartPair){count - 2, count - 1, YES}
        : (ChartPair){index, index + 1, YES};
    if (_pair.valid && next.left == _pair.left && next.right == _pair.right) return;
    _pair = next;
    _pairPinned = YES;
    if (self.popover.shown) [self rebuildContent];
}

- (NSString *)relativeForSequenceIndex:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return @"";
    return ForecastDay(_sequenceTimes[index], _chartNow ?: NSDate.date, OwnerZone()) ?: @"";
}

- (NSString *)clockForSequenceIndex:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return @"";
    return SituationClock(_sequenceTimes[index], OwnerZone()) ?: @"";
}

- (NSAttributedString *)popoverHeadingText:(NSString *)relative clock:(NSString *)clock kind:(NSString *)kind {
    NSFont *relFont = [NSFont systemFontOfSize:17 weight:NSFontWeightSemibold];
    NSFont *clockFont = [NSFont systemFontOfSize:13 weight:NSFontWeightRegular];
    NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
    style.alignment = NSTextAlignmentLeft;
    style.lineBreakMode = NSLineBreakByTruncatingTail;
    NSMutableAttributedString *text = [NSMutableAttributedString new];
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:relative ?: @"" attributes:@{
        NSFontAttributeName: relFont,
        NSForegroundColorAttributeName: NSColor.labelColor,
        NSParagraphStyleAttributeName: style,
    }]];
    if (clock.length) {
        NSString *tail = kind.length
            ? [NSString stringWithFormat:@" \u00B7 %@ \u00B7 %@", clock, kind]
            : [NSString stringWithFormat:@"  \u00B7  %@", clock];
        [text appendAttributedString:[[NSAttributedString alloc] initWithString:tail attributes:@{
            NSFontAttributeName: clockFont,
            NSForegroundColorAttributeName: NSColor.secondaryLabelColor,
            NSParagraphStyleAttributeName: style,
        }]];
    }
    return text;
}

- (NSTextField *)popoverHeading:(NSString *)relative clock:(NSString *)clock kind:(NSString *)kind frame:(NSRect)frame {
    NSAttributedString *plain = [self popoverHeadingText:relative clock:clock kind:nil];
    NSAttributedString *use = plain;
    if (kind.length && clock.length) {
        NSAttributedString *extended = [self popoverHeadingText:relative clock:clock kind:kind];
        if (ceil(extended.size.width) + 16 <= NSWidth(frame)) use = extended;
    }
    NSTextField *field = [NSTextField labelWithAttributedString:use];
    field.translatesAutoresizingMaskIntoConstraints = YES;
    field.frame = frame;
    field.lineBreakMode = NSLineBreakByTruncatingTail;
    field.drawsBackground = NO;
    return field;
}

- (NSTextField *)factField:(NSAttributedString *)text frame:(NSRect)frame identifier:(NSString *)identifier {
    NSTextField *field = [NSTextField labelWithAttributedString:text];
    field.translatesAutoresizingMaskIntoConstraints = YES;
    field.frame = frame;
    field.drawsBackground = NO;
    field.lineBreakMode = NSLineBreakByTruncatingTail;
    if (identifier) field.accessibilityIdentifier = identifier;
    return field;
}

- (void)noteWeatherForGeohash:(NSString *)geohash obs:(NSDictionary *)obs daily:(NSArray *)daily hourly:(NSArray *)hourly warnings:(NSArray *)warnings {
    if (!geohash.length) return;
    NSMutableDictionary *pack = [_weather[geohash] mutableCopy] ?: [NSMutableDictionary dictionary];
    if (obs) pack[@"obs"] = obs;
    if (daily) pack[@"daily"] = daily;
    if (hourly) pack[@"hourly"] = hourly;
    if (warnings) pack[@"warnings"] = warnings;
    _weather[geohash] = pack;
}

- (void)noteObservation:(NSDictionary *)obs daily:(NSArray *)daily hourly:(NSArray *)hourly warnings:(NSArray *)warnings {
    [self noteWeatherForGeohash:[self shownLocations].firstObject[@"geohash"] obs:obs daily:daily hourly:hourly warnings:warnings];
}

- (NSDictionary *)packFor:(NSDictionary *)place {
    return _weather[place[@"geohash"]] ?: @{};
}

- (NSArray *)cardPlaces {
    return [self shownLocations];
}

- (void)noteGlanceForGeohash:(NSString *)geohash history:(NSArray *)history series:(NSArray *)series {
    if (!geohash.length) return;
    NSMutableDictionary *pack = [_weather[geohash] mutableCopy] ?: [NSMutableDictionary dictionary];
    if (history) pack[@"history"] = history;
    if (series) pack[@"series"] = series;
    _weather[geohash] = pack;
}

- (NSDictionary *)glanceModelForPlace:(NSDictionary *)place {
    NSDictionary *pack = [self packFor:place];
    NSDictionary *obs = [pack[@"obs"] isKindOfClass:NSDictionary.class] ? pack[@"obs"] : nil;
    NSArray *history = [pack[@"history"] isKindOfClass:NSArray.class] ? pack[@"history"] : @[];
    NSArray *series = [pack[@"series"] isKindOfClass:NSArray.class] ? pack[@"series"] : @[];
    NSArray *warnings = [pack[@"warnings"] isKindOfClass:NSArray.class] ? pack[@"warnings"] : @[];
    NSDate *now = _chartNow ?: NSDate.date;
    NSDate *observed = [obs[@"time"] isKindOfClass:NSDate.class] ? obs[@"time"] : nil;
    NSString *name = place[@"name"];
    if (observed && [now timeIntervalSinceDate:observed] > 2 * 3600)
        name = [name stringByAppendingString:@" · stale reading"];
    NSMutableDictionary *model = [GlanceCardModel(name, obs, history, series, now,
        [place[@"shoreNormal"] isKindOfClass:NSNumber.class] ? place[@"shoreNormal"] : nil,
        _kiteMin, _kiteMax, warnings, ZoneForPlace(place)) mutableCopy];
    model[@"southernHemisphere"] = @([place[@"latitude"] doubleValue] < 0);
    return model;
}

- (GlanceCard *)glanceCardForPlace:(NSDictionary *)place frame:(NSRect)frame identifier:(NSString *)identifier warningID:(NSString *)warningID {
    GlanceCard *card = [[GlanceCard alloc] initWithFrame:frame];
    card.warningIdentifier = warningID;
    card.accessibilityIdentifier = identifier;
    card.showsBarbs = _glanceBarbs;
    card.model = [self glanceModelForPlace:place];
    NSDictionary *pack = [self packFor:place];
    NSDictionary *source = pack[@"pointSource"];
    NSString *point = [source[@"point"] isKindOfClass:NSString.class] ? source[@"point"] : nil;
    if (point.length) {
        NSString *station = pack[@"obs"][@"name"] ?: place[@"stationName"] ?: @"No station reading";
        card.toolTip = [NSString stringWithFormat:@"Observed at %@. Forecast: %@, %.1f km from this place.",
            station, [point stringByReplacingOccurrencesOfString:@"-" withString:@" "].capitalizedString,
            [source[@"distance_km"] doubleValue]];
        NSString *pressureStation = pack[@"obs"][@"pressureStation"];
        if (pressureStation.length) card.toolTip = [card.toolTip stringByAppendingFormat:@" Pressure: %@.", pressureStation];
    }
    __weak Controller *weak = self;
    card.onWarning = ^(NSString *text, NSView *anchor) {
        [weak showWarningText:text relativeTo:anchor];
    };
    return card;
}

- (NSString *)tempText:(NSDictionary *)place suffix:(NSString *)suffix {
    id temp = [self packFor:place][@"obs"][@"airTemp"];
    if (![temp isKindOfClass:NSNumber.class]) return [@"—" stringByAppendingString:suffix ?: @""];
    return [NSString stringWithFormat:@"%.0f°%@", round([temp doubleValue]), suffix ?: @""];
}

- (NSDictionary *)menubarPlace {
    NSDictionary *place = _here ?: SavedPlaceForTimeZone(_locations, NSTimeZone.localTimeZone.name);
    if (_here) {
        // A moving fix may be outside the collector's saved point set. Prefer
        // its own observation, then a nearby saved place with live data.
        NSDictionary *hereObs = [self packFor:_here][@"obs"];
        NSDate *hereTime = hereObs[@"time"];
        BOOL hereFresh = hereObs && (![hereTime isKindOfClass:NSDate.class] ||
            [(_chartNow ?: NSDate.date) timeIntervalSinceDate:hereTime] <= 2 * 3600);
        if (!hereFresh) {
            double nearestKm = 75;
            for (NSDictionary *saved in _locations) {
                double km = HaversineKm([_here[@"latitude"] doubleValue], [_here[@"longitude"] doubleValue],
                    [saved[@"latitude"] doubleValue], [saved[@"longitude"] doubleValue]);
                NSDictionary *obs = [self packFor:saved][@"obs"];
                NSDate *time = obs[@"time"];
                BOOL fresh = obs && (![time isKindOfClass:NSDate.class] ||
                    [(_chartNow ?: NSDate.date) timeIntervalSinceDate:time] <= 2 * 3600);
                if (km < nearestKm && fresh) { place = saved; nearestKm = km; }
            }
        }
    }
    return place;
}

- (void)updateBar {
    if (!_item.button) return;
    NSDictionary *place = [self menubarPlace];
    NSDictionary *obs = [self packFor:place][@"obs"];
    NSDate *observed = obs[@"time"];
    if ([observed isKindOfClass:NSDate.class] &&
        [(_chartNow ?: NSDate.date) timeIntervalSinceDate:observed] > 2 * 3600) obs = nil;
    BOOL warn = LocationWarningsActive([_weather.allValues valueForKey:@"warnings"]);
    __block NSImage *image = nil;
    [_item.button.effectiveAppearance performAsCurrentDrawingAppearance:^{
        image = IsobarMenuBarImage(obs, warn);
    }];
    _item.button.image = image;
    _item.button.imagePosition = NSImageOnly;
    NSString *tip = [NSString stringWithFormat:@"%@ · %@", place[@"name"] ?: @"Isobar", IsobarMenuBarAccessibility(obs)];
    if (warn) tip = [tip stringByAppendingString:@", warning"];
    _item.button.toolTip = tip;
    _item.button.accessibilityLabel = tip;
}

- (NSScreen *)activeScreen {
    return _item.button.window.screen ?: NSScreen.mainScreen ?: NSScreen.screens.firstObject;
}

- (NSSize)screenBudget {
    NSScreen *screen = [self activeScreen];
    if (!screen) return NSMakeSize(1100, 800);
    NSRect vis = screen.visibleFrame;
    return NSMakeSize(MAX(360, vis.size.width - 20), MAX(280, vis.size.height - 12));
}

- (double)backingScale {
    NSScreen *screen = [self activeScreen];
    return screen.backingScaleFactor > 0 ? screen.backingScaleFactor : 2;
}

- (ChartFit)chartFitInWidth:(CGFloat)maxW height:(CGFloat)maxH {
    NSImageRep *rep = _chart.representations.firstObject;
    double px = rep ? rep.pixelsWide : 601;
    double py = rep ? rep.pixelsHigh : 1006;
    return FitChartBox(px, py, maxW, maxH, [self backingScale]);
}

- (ChartView *)chartViewWithFit:(ChartFit)fit clickable:(BOOL)clickable {
    ChartView *chart = [[ChartView alloc] initWithFrame:NSMakeRect(0, 0, fit.width, fit.height)];
    chart.image = _chart;
    chart.crisp = fit.integer;
    chart.accessibilityIdentifier = @"popover.chart";
    if (clickable && _chart) {
        __weak Controller *weak = self;
        chart.onClick = ^{
            [weak.popover performClose:nil];
            [weak openChartWindow];
        };
    }
    return chart;
}

- (PDFCropView *)popoverChartView:(NSString *)identifier {
    PDFCropView *chart = [PDFCropView new];
    chart.drawsFrame = NO;
    chart.wantsLayer=YES;
    chart.layer.cornerRadius=10;
    chart.layer.masksToBounds=YES;
    chart.accessibilityIdentifier = identifier;
    chart.sequenceIndex = 0;
    __weak Controller *weak = self;
    chart.onClick = ^{ [weak resetPopoverToNow]; };
    chart.accessibilityRole = NSAccessibilityButtonRole;
    chart.accessibilityLabel = @"Return to now and play forecast";
    chart.toolTip = @"Return to now";
    return chart;
}

- (void)placePopoverChart:(PDFCropView *)chart index:(NSInteger)index frame:(NSRect)frame in:(NSView *)root {
    chart.sequenceIndex = index;
    chart.frame = frame;
    chart.mapDetails = [self mapDetailsAtTime:index>=0 && index<(NSInteger)_sequenceTimes.count ? _sequenceTimes[index] : nil];
    if (_sourceECMWF) {
        [chart setChartImage:[self ecmwfImageForIndex:index bare:YES comparison:NO] comparison:nil alpha:0];
        [chart setPins:nil];
        [root addSubview:chart];
        return;
    }
    CGRect crop = CGRectZero;
    NSArray *pins = nil;
    CGPDFDocumentRef doc = [self documentForPopoverIndex:index crop:&crop pins:&pins];
    [chart setDocument:doc crop:crop];
    [chart setPins:pins];
    [root addSubview:chart];
}

- (NSDictionary *)homeAerodrome {
    NSString *code = _aerodromeCode;
    if (!code.length) {
        NSString *state = [self shownLocations].firstObject[@"state"];
        code = [state isEqual:@"NSW"] ? @"YSSY" : @"YPPH";
    }
    NSMutableDictionary *field = [(AerodromeForCode(code) ?: AerodromeForCode(@"YPPH")) mutableCopy];
    // Published runway headings are true bearings, matching the model wind.
    if (_publishedStore) {
        NSMutableArray *pairs = [NSMutableArray array];
        NSArray *ends = [_aviation[@"runways"] isKindOfClass:NSArray.class] ? _aviation[@"runways"] : @[];
        for (NSDictionary *end in ends) {
            if (![end isKindOfClass:NSDictionary.class] || [end[@"closed"] boolValue]) continue;
            if (![end[@"end"] isKindOfClass:NSString.class] || ![end[@"heading_true"] isKindOfClass:NSNumber.class]) continue;
            [pairs addObject:@{@"id": end[@"end"], @"hdg": end[@"heading_true"]}];
        }
        field[@"ends"] = pairs;
    }
    return field;
}

- (NSDictionary *)currentKitePlan {
    NSMutableArray *spots = [NSMutableArray array];
    BOOL hasForecast = NO;
    for (NSDictionary *spot in _kiteList) {
        if (![spot isKindOfClass:NSDictionary.class]) continue;
        NSMutableDictionary *copy = [spot mutableCopy];
        copy[@"hours"] = [self packFor:spot][@"series"] ?: @[];
        for (NSDictionary *hour in copy[@"hours"]) {
            if ([hour[@"time"] timeIntervalSinceDate:_chartNow ?: NSDate.date] >= 0 &&
                [hour[@"windKt"] isKindOfClass:NSNumber.class]) hasForecast = YES;
        }
        [spots addObject:copy];
    }
    if (_publishedStore && !hasForecast) return @{@"line": @"Kite forecast unavailable", @"detail": @""};
    return KitePlan(spots, _chartNow ?: NSDate.date, OwnerZone(), _kiteMin, _kiteMax) ?: @{};
}

- (NSDictionary *)currentFlyPlan {
    NSDictionary *place = [self shownLocations].firstObject;
    NSDictionary *field = [self homeAerodrome];
    NSArray *series = _publishedStore ? _airportSeries : [self packFor:place][@"series"];
    if (_publishedStore && ![field[@"ends"] count])
        return @{@"line": [NSString stringWithFormat:@"%@ runway data unavailable", field[@"code"]], @"detail": @""};
    NSMutableDictionary *plan = [(FlyPlan(series, _chartNow ?: NSDate.date, OwnerZone(), field) ?: @{}) mutableCopy];
    if (_publishedStore) {
        plan[@"line"] = [NSString stringWithFormat:@"%@ · %@", field[@"code"], plan[@"line"] ?: @""];
        NSMutableString *detail = [NSMutableString stringWithString:plan[@"detail"] ?: @""];
        NSDictionary *metar = [_aviation[@"metar"] isKindOfClass:NSDictionary.class] ? _aviation[@"metar"] : nil;
        NSDictionary *taf = [_aviation[@"taf"] isKindOfClass:NSDictionary.class] ? _aviation[@"taf"] : nil;
        if ([metar[@"raw"] isKindOfClass:NSString.class]) [detail appendFormat:@"\nLatest archived observation\n%@\n", metar[@"raw"]];
        if ([taf[@"raw"] isKindOfClass:NSString.class]) [detail appendFormat:@"\nArchived TAF\n%@\n", taf[@"raw"]];
        plan[@"detail"] = detail;
    }
    return plan;
}

- (void)retitleChartField:(NSTextField *)field index:(NSInteger)index {
    if (!field) return;
    NSDate *when = (index >= 0 && index < (NSInteger)_sequenceTimes.count) ? _sequenceTimes[index] : nil;
    NSDate *now = _chartNow ?: NSDate.date;
    NSString *phrase = when ? (ForecastDay(when, now, OwnerZone()) ?: @"") : @"";
    NSString *clock = when ? (SituationClock(when, OwnerZone()) ?: @"") : @"";
    if (!phrase.length && ![self chartsReady]) {
        phrase = _dataStale ? @"Chart unavailable" : @"Chart loading";
        clock = @"";
    }
    field.attributedStringValue = [self popoverHeadingText:phrase clock:clock kind:nil];
    NSString *offset = SituationOffset(when, now);
    field.toolTip = offset.length ? offset : nil;
}

- (void)previewSequenceIndex:(NSInteger)index {
    if (_popoverPlaying || _motionMovieURL) return;
    if (!_leftChart || !_leftChart.superview) return;
    NSInteger show = index < 0 ? _shownLeft : index;
    if (show < 0 || show == _leftChart.sequenceIndex) return;
    _previewIndex = index;
    [self placePopoverChart:_leftChart index:show frame:_leftChart.frame in:_leftChart.superview];
    [self retitleChartField:_leftTitle index:show];
    [self updateForecastInspection:_sequenceTimes[show]];
}

- (void)seekPopoverMovieFraction:(double)fraction {
    fraction = MIN(1.0, MAX(0.0, fraction));
    if (_motionPlayer && _motionMovieURL) {
        AVPlayer *player = _motionPlayer;
        [self activeTimeline].progress = fraction;
        [self activeTimeline].needsDisplay = YES;
        // Let the decoder finish each frame. Cancelling on every mouse move
        // can starve display entirely; keep only the newest pending target.
        if (_motionSeeking) { _motionQueuedFraction = @(fraction); return; }
        NSUInteger seekGeneration = ++_motionSeekGeneration;
        _motionSeeking = YES;
        __weak Controller *weak = self;
        [player pause];
        [player seekToTime:CMTimeMakeWithSeconds(fraction * [self motionMovieSpan], 60000)
            toleranceBefore:kCMTimeZero toleranceAfter:kCMTimeZero completionHandler:^(BOOL finished) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    Controller *strong = weak;
                    if (!strong || strong->_motionPlayer != player || strong->_motionSeekGeneration != seekGeneration) return;
                    strong->_motionSeeking = NO;
                    if (finished) [strong updateRawMovieTime:player.currentTime];
                    NSNumber *queued = strong->_motionQueuedFraction;
                    strong->_motionQueuedFraction = nil;
                    if (queued) {
                        [strong seekPopoverMovieFraction:queued.doubleValue];
                        return;
                    }
                    if (fraction >= 1) { strong->_popoverPlaying = NO; strong->_looping = NO; }
                    if (finished) [strong playMotionWhenReady];
                    [strong updatePopoverPlayControl];
                });
            }];
        return;
    }
    if (_expandedMap) { [self showStaticTimelineFraction:fraction]; return; }
    NSInteger count = (NSInteger)_sequenceTimes.count;
    if (count < 1) return;
    NSInteger index = MIN(count - 1, MAX(0, (NSInteger)llround(fraction * (count - 1))));
    [self selectPopoverIndex:index];
}

- (void)openChartOnFrame:(NSInteger)index {
    if (![self chartsReady]) return;
    NSScreen *screen=[self activeScreen];
    NSRect frame=screen?screen.visibleFrame:NSMakeRect(0,0,1470,956);
    [self presentChartWindowInFrame:frame];
    if (index>=0) [self focusFullscreenPanel:index];
    [_chartWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (NSUserDefaults *)chartPreferences { return NSUserDefaults.standardUserDefaults; }

- (void)saveMapDetails {
    [_mapDetailCache removeAllObjects];
    [[self chartPreferences] setObject:[_mapDetailModes.allObjects sortedArrayUsingSelector:@selector(compare:)] forKey:@"mapDetailModes"];
    if (_expandedMap) [self layoutChartWindow];
}

- (void)toggleMapDetail:(NSInteger)mode {
    if ([_mapDetailModes containsObject:@(mode)]) [_mapDetailModes removeObject:@(mode)];
    else [_mapDetailModes addObject:@(mode)];
    [self saveMapDetails];
    [self rebuildContent];
}

- (void)hideMapLayers {
    [_mapDetailModes removeAllObjects];
    _tempLayer = 0; _barbs = NO; _rainLayer = NO;
    NSUserDefaults *defaults = [self chartPreferences];
    [defaults setInteger:0 forKey:@"chartTemperature"];
    [defaults setBool:NO forKey:@"chartBarbs"];
    [defaults setBool:NO forKey:@"chartRain"];
    [self invalidateMotion];
    [_chartCache removeAllObjects];
    [self saveMapDetails];
    [self rebuildContent];
}

- (NSMenu *)mapLayersMenu {
    NSMenu *menu = [NSMenu new]; menu.autoenablesItems = NO;
    [menu addItemWithTitle:@"Layers" action:NULL keyEquivalent:@""];
    void (^add)(NSString *, NSInteger, BOOL, BOOL) = ^(NSString *title, NSInteger tag, BOOL on, BOOL enabled) {
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(chooseLayerItem:) keyEquivalent:@""];
        item.target = self; item.tag = tag; item.enabled = enabled;
        item.state = on ? NSControlStateValueOn : NSControlStateValueOff;
        [menu addItem:item];
    };
    NSArray *names = @[@"Kite wind", @"Flying conditions", @"Rain", @"Surf", @"Temperature"];
    for (NSNumber *mode in @[@2,@4,@0,@3,@1]) add(names[mode.unsignedIntegerValue], 10+mode.integerValue, [_mapDetailModes containsObject:mode], YES);
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem *heading = [menu addItemWithTitle:_sourceECMWF ? @"Model map" : @"Switch to model map" action:NULL keyEquivalent:@""]; heading.enabled = NO;
    BOOL available = [self modelChartsReady];
    add(@"Temperature aloft", 1, _sourceECMWF && _tempLayer == 1, available);
    add(@"Surface temperature colour", 2, _sourceECMWF && _tempLayer == 2, available);
    add(@"No temperature colour", 0, _sourceECMWF && _tempLayer == 0, available && _sourceECMWF);
    add(@"Wind direction · kt", 3, _sourceECMWF && _barbs, available);
    add(@"Rain shading", 5, _sourceECMWF && _rainLayer, available);
    [menu addItem:NSMenuItem.separatorItem];
    add(@"Hide all layers", 99, NO, YES);
    add(_sourceECMWF ? @"Show Bureau chart" : @"Show model chart", 4, NO, _sourceECMWF ? _pdfDoc != NULL : available);
    return menu;
}

- (NSArray<NSDictionary *> *)mapDetailsAtTime:(NSDate *)valid {
    if (!valid || !_mapDetailModes.count) return @[];
    NSNumber *key = @(valid.timeIntervalSince1970);
    if (_mapDetailCache[key]) return _mapDetailCache[key];
    NSMutableArray *records = [NSMutableArray array];
    NSDictionary *place = [self rainPlace], *spot = [self windPlace];
    BOOL (^number)(id) = ^BOOL(id n) { return [n isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)n) != CFBooleanGetTypeID() && isfinite([n doubleValue]); };
    for (NSNumber *mode in @[@2,@4,@0,@3,@1]) {
        if (![_mapDetailModes containsObject:mode]) continue;
        NSDictionary *local = mode.integerValue == 0 || mode.integerValue == 3 ? spot : place;
        NSDictionary *row = MapDetailSample([self packFor:local][@"series"],valid);
        NSString *kind = @"", *value = @"—", *name = local[@"name"] ?: @"Local", *source = @"ECMWF";
        NSNumber *direction = nil; NSDate *sampleTime = row[@"time"];
        switch (mode.integerValue) {
            case 2:
                kind = @"Rain";
                if (number(row[@"rainMm"]) && [row[@"rainMm"] doubleValue]>=0) value=[NSString stringWithFormat:@"%.1f mm · 1h",[row[@"rainMm"] doubleValue]];
                break;
            case 4:
                kind = @"Temperature";
                if (number(row[@"temp"])) value=[NSString stringWithFormat:@"%.0f°C",[row[@"temp"] doubleValue]];
                break;
            case 0:
                kind = @"Kite";
                if (number(row[@"windKt"]) && [row[@"windKt"] doubleValue]>=0) {
                    double speed=[row[@"windKt"] doubleValue];
                    value=[NSString stringWithFormat:@"%.0f kt",speed];
                    if (number(row[@"gustKt"]) && [row[@"gustKt"] doubleValue]>speed) value=[value stringByAppendingFormat:@" · gust %.0f",[row[@"gustKt"] doubleValue]];
                    if (speed>0 && number(row[@"windFrom"])) direction=@(WindToDegrees([row[@"windFrom"] doubleValue]));
                }
                break;
            case 3: {
                kind = @"Surf"; source = @"Open-Meteo";
                row=MapDetailSample(SurfOutlook([self packFor:spot][@"marine"], _chartNow ?: NSDate.date)[@"rows"],valid);
                sampleTime=row[@"time"];
                if (number(row[@"waveHeight"])) value=[NSString stringWithFormat:@"%.1f m waves",[row[@"waveHeight"] doubleValue]];
                // Period belongs to swell, not the total wave height.
                if (number(row[@"swellPeriod"])) value=[value stringByAppendingFormat:@" · %.0fs swell",[row[@"swellPeriod"] doubleValue]];
                break;
            }
            case 1: {
                kind=@"Fly"; source=@"TAF"; name=[self homeAerodrome][@"code"] ?: @"Airport"; sampleTime=valid;
                NSDictionary *outlook=AviationOutlook(_aviation,valid,[self aviationTimeZone]);
                NSMutableArray *parts=[NSMutableArray array];
                for (NSDictionary *period in outlook[@"periods"]) {
                    if ([valid compare:period[@"start"]]==NSOrderedAscending || [valid compare:period[@"end"]]!=NSOrderedAscending) continue;
                    NSString *change=period[@"change"], *prefix=([change isEqual:@"Base"] || [change isEqual:@"FM"] || [change isEqual:@"After BECMG"]) ? @"" : [change stringByAppendingString:@" "];
                    [parts addObject:[NSString stringWithFormat:@"%@%@ / %@",prefix,period[@"ceiling"],period[@"visibility"]]];
                }
                value=parts.count ? [parts componentsJoinedByString:@"; "] : @"No TAF for this time";
                break;
            }
        }
        NSMutableDictionary *record=[@{@"kind":kind,@"place":name,@"value":value,
            @"summary":[NSString stringWithFormat:@"%@ · %@ · %@\n%@ · %@",name,kind,value,source,sampleTime ? PopoverClockLabel(sampleTime,OwnerZone()) : @"No sample for this map time"]} mutableCopy];
        if (direction) record[@"to"]=direction;
        if (sampleTime) record[@"time"]=sampleTime;
        [records addObject:record];
    }
    if (_mapDetailCache.count>=512) [_mapDetailCache removeAllObjects];
    _mapDetailCache[key]=records;
    return records;
}

- (void)selectChartLayer:(NSInteger)tag {
    [self invalidateMotion];
    if (tag < 0 || tag > 5 || ![self modelChartsReady]) return;
    if (tag == 0 && !_sourceECMWF) return;
    if (tag == 5) {
        _rainLayer = !_rainLayer;
        [[self chartPreferences] setBool:_rainLayer forKey:@"chartRain"];
    } else if (tag == 3) {
        // A stored wind setting is not a visible layer on the Bureau PDF.
        _barbs = !_sourceECMWF || !_barbs;
        [[self chartPreferences] setBool:_barbs forKey:@"chartBarbs"];
    } else {
        _tempLayer = tag;
        [[self chartPreferences] setInteger:_tempLayer forKey:@"chartTemperature"];
    }
    if (!_sourceECMWF) {
        [self toggleChartSource];
        return;
    }
    [_chartCache removeAllObjects];
    if (self.popover.shown) [self rebuildContent];
    if (_expandedMap) [self layoutChartWindow];
    [self prepareChartImages];
}

- (void)chooseLayerItem:(id)sender {
    NSMenuItem *item = [sender isKindOfClass:NSMenuItem.class] ? sender : nil;
    if (!item || !item.enabled || item.tag < 0) return;
    if (item.tag == 4) [self toggleChartSource];
    else if (item.tag == 99) [self hideMapLayers];
    else if (item.tag >= 10 && item.tag <= 14) [self toggleMapDetail:item.tag - 10];
    else [self selectChartLayer:item.tag];
}

- (NSArray *)windPlaces { return _kiteList.count ? _kiteList : [self shownLocations]; }

- (NSDictionary *)windPlace {
    for (NSDictionary *place in [self windPlaces])
        if ([place[@"geohash"] isEqual:_windSpotHash]) return place;
    return [self windPlaces].firstObject;
}

- (void)showMarineSource:(id)sender {
    (void)sender;
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"https://open-meteo.com/en/docs/marine-weather-api"]];
}

- (void)chooseWindSpot:(NSPopUpButton *)sender {
    [_mapDetailCache removeAllObjects];
    _windSpotHash = sender.selectedItem.representedObject ?: @"";
    [NSUserDefaults.standardUserDefaults setObject:_windSpotHash forKey:@"windSpot"];
    [self rebuildContent];
}

- (void)focusForecastControl:(NSInteger)mode {
    NSView *root = self.popover.contentViewController.view;
    for (NSView *row in root.subviews) {
        if (![row.accessibilityIdentifier isEqual:@"popover.forecastMode"]) continue;
        for (NSView *control in row.subviews) {
            if ([control isKindOfClass:NSButton.class] && [(NSButton *)control tag] == mode) {
                [root.window makeFirstResponder:control];
                return;
            }
        }
    }
}

- (void)chooseForecastMode:(NSButton *)sender {
    NSInteger mode = sender.tag;
    [_warningPop close];
    BOOL closing = _forecastMode == mode;
    _forecastMode = closing ? -1 : mode;
    if (closing) [_mapDetailModes removeObject:@(mode)];
    else [_mapDetailModes addObject:@(mode)];
    [self saveMapDetails];
    [self rebuildContent];
    [self focusForecastControl:mode];
}

- (void)closeForecast:(id)sender {
    (void)sender;
    NSInteger mode = _forecastMode;
    [_warningPop close];
    _forecastMode = -1;
    [self rebuildContent];
    [self focusForecastControl:mode];
}

- (void)escapePopover {
    if (_forecastMode >= 0) [self closeForecast:nil];
    else [self.popover performClose:nil];
}

- (NSDictionary *)rainPlace {
    for (NSDictionary *place in [self shownLocations])
        if ([place[@"geohash"] isEqual:_rainPlaceHash]) return place;
    return [self shownLocations].firstObject;
}

- (void)chooseRainPlace:(NSPopUpButton *)sender {
    [_mapDetailCache removeAllObjects];
    _rainPlaceHash = sender.selectedItem.representedObject ?: @"";
    [_warningPop close];
    [self rebuildContent];
}

- (void)showRainDetails:(NSView *)sender {
    NSDictionary *place = [self rainPlace];
    NSDictionary *rain = RainOutlook([self packFor:place][@"series"], _chartNow ?: NSDate.date, ZoneForPlace(place));
    [self showWarningText:rain[@"detail"] relativeTo:sender];
}

- (void)showAviationDetails:(NSView *)sender {
    NSDictionary *outlook = AviationOutlook(_aviation, _chartNow ?: NSDate.date, [self aviationTimeZone]);
    [self showWarningText:outlook[@"detail"] relativeTo:sender];
}

- (AtmosphereView *)prepareAtmosphere {
    NSDictionary *field=[self homeAerodrome];
    if (!_atmosphereWindow) {
        NSSize budget=[self screenBudget];
        NSSize size=NSMakeSize(MIN(980,budget.width-36),MIN(620,budget.height-60));
        _atmosphereWindow=[[NSWindow alloc] initWithContentRect:(NSRect){NSZeroPoint,size}
            styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
        _atmosphereWindow.releasedWhenClosed=NO;
        _atmosphereWindow.contentMinSize=NSMakeSize(600,340);
        _atmosphereView=[[AtmosphereView alloc] initWithFrame:(NSRect){NSZeroPoint,size}];
        _atmosphereView.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
        _atmosphereView.accessibilityIdentifier=@"aviation.atmosphere";
        _atmosphereWindow.contentView=_atmosphereView;
    }
    _atmosphereWindow.title=[NSString stringWithFormat:@"%@ · Atmosphere",field[@"code"]];
    if (!_atmosphereView.trafficClient || _atmosphereView.latitude!=[field[@"latitude"] doubleValue] || _atmosphereView.longitude!=[field[@"longitude"] doubleValue])
        _atmosphereView.trafficClient=[[AirborneTraffic alloc] initWithLatitude:[field[@"latitude"] doubleValue] longitude:[field[@"longitude"] doubleValue] configuration:nil];
    _atmosphereView.latitude=[field[@"latitude"] doubleValue]; _atmosphereView.longitude=[field[@"longitude"] doubleValue];
    _atmosphereView.timeZone=[self aviationTimeZone];
    _atmosphereView.product=ArchiveAtmosphereProduct(_storeRoot,field[@"code"]);
    _atmosphereView.now=_chartNow ?: NSDate.date;
    [_atmosphereView inspectDate:[self selectedForecastDate]];
    return _atmosphereView;
}

- (void)showAtmosphere:(id)sender {
    (void)sender; [self prepareAtmosphere]; [self.popover close];
    [_atmosphereWindow center]; [_atmosphereWindow makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
}

- (AviationNoticesView *)prepareAviationNotices:(BOOL)sigmet {
    if (!_noticesWindow) {
        NSSize budget=[self screenBudget];
        NSSize size=NSMakeSize(MIN(840,budget.width-36),MIN(600,budget.height-60));
        _noticesWindow=[[NSWindow alloc] initWithContentRect:(NSRect){NSZeroPoint,size}
            styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
        _noticesWindow.title=@"Aviation notices"; _noticesWindow.releasedWhenClosed=NO;
        _noticesWindow.contentMinSize=NSMakeSize(620,360);
        _noticesView=[[AviationNoticesView alloc] initWithFrame:(NSRect){NSZeroPoint,size}];
        _noticesView.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
        _noticesView.now=_chartNow ?: NSDate.date; _noticesView.timeZone=[self aviationTimeZone];
        __weak Controller *weak=self;
        _noticesView.onClose=^{ Controller *strong=weak; if (strong) [strong->_noticesWindow close]; };
        _noticesView.onImport=^{ [weak importAviationNotices:nil]; };
        _noticesView.onNotac=^{ [weak connectAviationNotices]; };
        _noticesWindow.contentView=_noticesView; [_noticesWindow center];
    }
    _noticesView.notacKeySaved=getenv("ISOBAR_FIXTURES") == NULL && [_notacConnection loadToken:nil] != nil;
    _noticesView.timeZone=[self aviationTimeZone];
    _noticesView.notams=_notams ?: @{}; _noticesView.sigmets=_sigmets ?: @{};
    _noticesView.airport=[self homeAerodrome][@"code"]; _noticesView.showingSIGMET=sigmet;
    [_noticesView reload]; return _noticesView;
}

- (void)showAviationNotices:(NSButton *)sender {
    [self prepareAviationNotices:sender.tag==1];
    [self.popover close];
    [_noticesWindow makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
}

- (void)importAviationNotices:(id)sender {
    (void)sender;
    NSOpenPanel *panel=[NSOpenPanel openPanel]; panel.canChooseDirectories=NO; panel.allowsMultipleSelection=NO;
    panel.message=@"Choose a text or JSON NOTAM briefing.";
    [panel beginSheetModalForWindow:_noticesWindow completionHandler:^(NSModalResponse response) {
        if (response!=NSModalResponseOK || !panel.URL) return;
        NSString *tool=[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"collector/isobar-data"];
        if (![NSFileManager.defaultManager isExecutableFileAtPath:tool]) {
            [self->_noticesView setImportStatus:@"The collector is missing from this build."]; return;
        }
        [self->_noticesView setImportStatus:@"Importing…"];
        NSString *path=panel.URL.path, *root=[self->_storeRoot copy];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            NSTask *task=[NSTask new]; task.executableURL=[NSURL fileURLWithPath:tool];
            task.arguments=@[@"import-notams",@"--file",path,@"--source",@"Imported briefing",@"--data-dir",root];
            NSPipe *output=[NSPipe pipe]; task.standardOutput=output; task.standardError=output;
            NSError *error=nil; BOOL launched=[task launchAndReturnError:&error];
            NSData *data=launched?[output.fileHandleForReading readDataToEndOfFile]:nil;
            if (launched) [task waitUntilExit];
            BOOL success=launched && task.terminationStatus==0;
            NSString *message=success?@"":[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            if (!message.length && !success) message=error.localizedDescription ?: @"Import failed";
            if (message.length>240) message=[message substringToIndex:240];
            dispatch_async(dispatch_get_main_queue(),^{
                if (success) [self refreshAll];
                [self->_noticesView setImportStatus:message];
                [self prepareAviationNotices:NO];
            });
        });
    }];
}

- (void)fetchNotacNotices {
    NSString *tool=[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"collector/isobar-data"];
    _noticesView.notacUpdating=YES;
    [_noticesView setImportStatus:@"Updating NOTAMs…"];
    __weak Controller *weak=self;
    [_notacConnection fetchWithDataDirectory:_storeRoot executableURL:[NSURL fileURLWithPath:tool]
        completion:^(BOOL success, NSString *message) {
            dispatch_async(dispatch_get_main_queue(), ^{
                Controller *strong=weak; if (!strong) return;
                strong->_noticesView.notacUpdating=NO;
                if (success) [strong reloadStoreAtPath:strong->_storeRoot];
                [strong->_noticesView setImportStatus:success?@"":message];
                [strong prepareAviationNotices:NO];
            });
        }];
}

- (void)connectAviationNotices {
    if ([_notacConnection loadToken:nil]) {
        NSAlert *choice=[NSAlert new]; choice.messageText=@"NOTAC";
        choice.informativeText=@"Refresh notices or remove this Mac's key.";
        [choice addButtonWithTitle:@"Refresh"]; [choice addButtonWithTitle:@"Remove key"]; [choice addButtonWithTitle:@"Cancel"];
        [choice beginSheetModalForWindow:_noticesWindow completionHandler:^(NSModalResponse response) {
            if (response==NSAlertFirstButtonReturn) [self fetchNotacNotices];
            if (response==NSAlertSecondButtonReturn) {
                NSError *error=nil;
                BOOL removed=[self->_notacConnection removeToken:&error];
                self->_noticesView.notacKeySaved=!removed;
                [self->_noticesView setImportStatus:removed?@"NOTAC key removed":error.localizedDescription];
            }
        }];
        return;
    }
    NSAlert *entry=[NSAlert new]; entry.messageText=@"Connect NOTAC";
    entry.informativeText=@"Create a key from your NOTAC Account menu.";
    NSSecureTextField *field=[[NSSecureTextField alloc] initWithFrame:NSMakeRect(0,0,340,26)];
    field.placeholderString=@"API key"; entry.accessoryView=field;
    [entry addButtonWithTitle:@"Connect"]; [entry addButtonWithTitle:@"Get key ↗"]; [entry addButtonWithTitle:@"Cancel"];
    [entry beginSheetModalForWindow:_noticesWindow completionHandler:^(NSModalResponse response) {
        if (response==NSAlertSecondButtonReturn) {
            [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"https://notac.aero/"]]; return;
        }
        if (response!=NSAlertFirstButtonReturn) return;
        NSError *error=nil;
        BOOL saved=[self->_notacConnection saveToken:field.stringValue error:&error];
        field.stringValue=@"";
        self->_noticesView.notacKeySaved=saved;
        if (!saved) { [self->_noticesView setImportStatus:error.localizedDescription ?: @"The NOTAC key could not be saved"]; return; }
        [self fetchNotacNotices];
    }];
}

- (NSTimeZone *)aviationTimeZone {
    return [NSTimeZone timeZoneWithName:[self homeAerodrome][@"timeZone"]] ?: OwnerZone();
}

- (NSView *)aviationForecastWithFrame:(NSRect)frame {
    NSDictionary *field=[self homeAerodrome];
    NSDictionary *outlook = AviationOutlook(_aviation, _chartNow ?: NSDate.date, [self aviationTimeZone]);
    FlippedView *view = [[FlippedView alloc] initWithFrame:frame];
    view.accessibilityIdentifier = @"popover.aviation";
    CGFloat width = NSWidth(frame);
    NSTextField *observation = [self label:outlook[@"observation"] ?: @"METAR unavailable"
        font:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium] color:NSColor.labelColor
        frame:NSMakeRect(0, 0, width, 20)];
    observation.accessibilityIdentifier = @"aviation.metar";
    BOOL narrow=width<600;
    CGFloat observationH=narrow?38:20;
    observation.frame=NSMakeRect(0,0,MAX(0,width-112),observationH);
    observation.maximumNumberOfLines=narrow?2:1;
    observation.lineBreakMode=narrow?NSLineBreakByWordWrapping:NSLineBreakByTruncatingTail;
    [view addSubview:observation];
    NSButton *atmosphere=[NSButton buttonWithTitle:@"Atmosphere ›" target:self action:@selector(showAtmosphere:)];
    atmosphere.bordered=NO; atmosphere.font=[NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    atmosphere.frame=NSMakeRect(width-108,0,108,20); atmosphere.accessibilityIdentifier=@"aviation.atmosphere.open";
    atmosphere.toolTip=@"Cloud, moisture and temperature through height";
    [view addSubview:atmosphere];
    AviationForecastView *timeline = [[AviationForecastView alloc] initWithFrame:NSMakeRect(0, observationH+2, width, NSHeight(frame)-observationH-2)];
    timeline.periods = outlook[@"periods"] ?: @[];
    timeline.now = _chartNow ?: NSDate.date;
    timeline.windowStart=[self detailStartDate];
    timeline.timeZone = [self aviationTimeZone];
    timeline.latitude = [field[@"latitude"] isKindOfClass:NSNumber.class] ? [field[@"latitude"] doubleValue] : NAN;
    timeline.longitude = [field[@"longitude"] isKindOfClass:NSNumber.class] ? [field[@"longitude"] doubleValue] : NAN;
    timeline.status = outlook[@"status"];
    timeline.accessibilityIdentifier = @"aviation.timeline";
    __weak NSTextField *reading = observation;
    NSString *current = observation.stringValue;
    timeline.onInspect = ^(NSString *summary) {
        // The graphic carries the selected forecast. Keep the current METAR
        // stable rather than replacing it with a long list of TAF conditions.
        reading.toolTip = summary ?: current;
    };
    timeline.selectedDate=[self selectedForecastDate];
    __weak Controller *weak=self;
    __weak AviationForecastView *weakTimeline=timeline;
    timeline.onPreviewDate=^(NSDate *date) {
        Controller *strong=weak;
        if (strong && strong->_forecastGraph==weakTimeline)
            [strong previewPopoverMovieFraction:date?[strong motionFractionForDate:date]:NAN];
    };
    timeline.onSelectDate=^(NSDate *date) {
        Controller *strong=weak;
        if (strong && strong->_forecastGraph==weakTimeline)
            [strong inspectPopoverMovieFraction:[strong motionFractionForDate:date]];
    };
    _forecastGraph=timeline;
    [view addSubview:timeline];
    return view;
}

- (void)showObservation:(NSButton *)sender {
    NSArray *places = [self cardPlaces];
    if (sender.tag < 0 || sender.tag >= (NSInteger)places.count) return;
    [_warningPop close];
    [_observationPop close];
    NSViewController *vc = [NSViewController new];
    vc.view = [self glanceCardForPlace:places[sender.tag] frame:NSMakeRect(0, 0, 420, GlanceCardHeight())
        identifier:@"observation.detail" warningID:@"observation.warning"];
    NSPopover *pop = [NSPopover new];
    pop.behavior = NSPopoverBehaviorTransient;
    pop.animates = NO;
    pop.contentViewController = vc;
    pop.contentSize = vc.view.frame.size;
    _observationPop = pop;
    [pop showRelativeToRect:sender.bounds ofView:sender preferredEdge:NSMaxYEdge];
}

- (NSView *)forecastInspectorWithWidth:(CGFloat)width height:(CGFloat)height sharedTimeline:(BOOL)sharedTimeline {
    NSDate *now=_chartNow ?: NSDate.date;
    NSDate *windowStart=[self detailStartDate];
    NSDictionary *rainPlace=[self rainPlace];
    NSDictionary *rain=RainOutlook([self packFor:rainPlace][@"series"],now,ZoneForPlace(rainPlace));
    CGFloat pad=14,y=pad;
    // Graphs retain a useful aspect ratio instead of stretching to map height.
    CGFloat graphH=MIN(250,MAX(150,(width-2*pad)*.58));
    CGFloat forecastH=MIN(MAX(1,height-2*pad-(_forecastMode==1?80:96)),
        _forecastMode==1?420:graphH+(_forecastMode==2?66:0));
    PopoverRootView *root=[[PopoverRootView alloc] initWithFrame:NSMakeRect(0,0,width,height)];
    root.accessibilityIdentifier=@"forecast.inspector";
    root.inspectorSurface=YES;
    _forecastTime=nil; _forecastReading=nil; _forecastGraph=nil;
    if (_forecastMode == 1) {
        NSString *airport = [self homeAerodrome][@"code"] ?: @"";
        NSPopUpButton *airports=[[NSPopUpButton alloc] initWithFrame:NSMakeRect(pad,y,95,24) pullsDown:NO];
        airports.bordered=NO; airports.font=[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
        for (NSDictionary *field in KnownAerodromes()) {
            [airports addItemWithTitle:field[@"code"]]; airports.lastItem.representedObject=field[@"code"];
            if ([field[@"code"] isEqual:airport]) [airports selectItem:airports.lastItem];
        }
        airports.target=self; airports.action=@selector(chooseAerodrome:); airports.accessibilityIdentifier=@"aviation.airport";
        [root addSubview:airports];
        for (NSInteger i=0;i<2;i++) {
            NSString *name=i?@"SIGMETs":@"NOTAMs";
            NSButton *notices=[NSButton buttonWithTitle:[name stringByAppendingString:@" ›"] target:self action:@selector(showAviationNotices:)];
            notices.tag=i; notices.bordered=NO; notices.font=[NSFont systemFontOfSize:11];
            notices.frame=NSMakeRect(pad+102+i*88,y,84,24);
            notices.accessibilityIdentifier=i?@"aviation.sigmets":@"aviation.notams"; [root addSubview:notices];
        }
        NSDictionary *aviation = AviationOutlook(_aviation, now, [self aviationTimeZone]);
        NSString *source = [NSString stringWithFormat:@"%@  ›", aviation[@"status"] ?: @"TAF / METAR"];
        NSButton *raw = [NSButton buttonWithTitle:source target:self action:@selector(showAviationDetails:)];
        raw.bordered = NO;
        raw.font = [NSFont systemFontOfSize:11];
        raw.alignment = NSTextAlignmentRight;
        raw.frame = NSMakeRect(pad, y+28, width-2*pad, 24);
        raw.accessibilityIdentifier = @"aviation.source";
        raw.toolTip = @"TAF and METAR";
        [root addSubview:raw];
    } else if (_forecastMode == 0 || _forecastMode == 3) {
        NSPopUpButton *spots = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(pad, y, 190, 24) pullsDown:NO];
        spots.bordered = NO;
        spots.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        NSDictionary *selected = [self windPlace];
        for (NSDictionary *place in [self windPlaces]) {
            [spots addItemWithTitle:place[@"name"] ?: @"Wind"];
            spots.lastItem.representedObject = place[@"geohash"] ?: @"";
        }
        for (NSMenuItem *item in spots.itemArray)
            if ([item.representedObject isEqual:selected[@"geohash"]]) [spots selectItem:item];
        spots.target = self;
        spots.action = @selector(chooseWindSpot:);
        spots.accessibilityIdentifier = _forecastMode == 3 ? @"surf.spot" : @"popover.windSpot";
        spots.accessibilityLabel = _forecastMode == 3 ? @"Surf spot" : @"Kite spot";
        [root addSubview:spots];
        if (_forecastMode == 3) {
            NSButton *source = [NSButton buttonWithTitle:@"Open-Meteo ↗" target:self action:@selector(showMarineSource:)];
            source.bordered=NO; source.font=[NSFont systemFontOfSize:11];
            source.frame=NSMakeRect(pad+192,y,120,24); source.accessibilityIdentifier=@"surf.source";
            source.toolTip=@"Wave and swell model · Open-Meteo";
            [root addSubview:source];
        }
        NSString *legendText = _forecastMode == 3 ? @"Offshore waves" : @"Gusts dashed";
        NSTextField *legend = [self label:legendText font:[NSFont systemFontOfSize:11]
            color:NSColor.secondaryLabelColor frame:NSMakeRect(width-pad-28-160, y+3, 160, 20)];
        legend.alignment = NSTextAlignmentRight;
        if (width >= 680) [root addSubview:legend];
    }
    if (_forecastMode == 2 || _forecastMode == 4) {
        CGFloat placeWidth = MIN(220, width - 2*pad - 160);
        NSPopUpButton *places = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(pad, y, placeWidth, 24) pullsDown:NO];
        places.bordered = NO;
        places.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        for (NSDictionary *place in [self shownLocations]) {
            [places addItemWithTitle:place[@"name"] ?: @"Weather"];
            places.lastItem.representedObject = place[@"geohash"] ?: @"";
            if ([place[@"geohash"] isEqual:rainPlace[@"geohash"]]) [places selectItem:places.lastItem];
        }
        places.target = self;
        places.action = @selector(chooseRainPlace:);
        places.accessibilityIdentifier = _forecastMode == 4 ? @"temperature.place" : @"rain.place";
        places.accessibilityLabel = @"Forecast location";
        [root addSubview:places];
        NSButton *source = [NSButton buttonWithTitle:@"ECMWF  ›" target:self action:@selector(showRainDetails:)];
        source.bordered = NO;
        source.font = [NSFont systemFontOfSize:11];
        source.alignment = NSTextAlignmentRight;
        source.frame = NSMakeRect(width-pad-28-120, y, 120, 24);
        source.accessibilityIdentifier = _forecastMode == 4 ? @"temperature.source" : @"rain.source";
        source.toolTip = _forecastMode == 4 ? @"Hourly temperature · ECMWF" : @"Hourly forecast amounts";
        if (_forecastMode == 4) { source.title = @"ECMWF · °C"; source.enabled = NO; }
        [root addSubview:source];
    }
    NSImage *closeImage = [NSImage imageWithSystemSymbolName:@"xmark" accessibilityDescription:@"Close forecast"];
    NSButton *close = [NSButton buttonWithImage:closeImage target:self action:@selector(closeForecast:)];
    close.bordered = NO;
    close.contentTintColor = NSColor.secondaryLabelColor;
    close.frame = NSMakeRect(width-pad-24, y, 24, 24);
    close.accessibilityIdentifier = @"forecast.close";
    close.accessibilityLabel = @"Close forecast";
    close.toolTip = @"Back to map (Esc)";
    [root addSubview:close];
    y += _forecastMode == 1 ? 58 : 34;
    _forecastTime=[self label:@"" font:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(pad,y,width-2*pad,20)];
    _forecastTime.accessibilityIdentifier=@"forecast.selectedTime"; [root addSubview:_forecastTime];
    y+=24;
    if (_forecastMode!=1) {
        _forecastReading=[self label:@"" font:[NSFont monospacedDigitSystemFontOfSize:22 weight:NSFontWeightSemibold]
            color:NSColor.labelColor frame:NSMakeRect(pad,y,width-2*pad,30)];
        _forecastReading.accessibilityIdentifier=@"forecast.reading"; [root addSubview:_forecastReading]; y+=36;
    }
    NSRect forecastFrame = NSMakeRect(pad, y, width-2*pad, forecastH);
    if (_forecastMode == 1) {
        [root addSubview:[self aviationForecastWithFrame:forecastFrame]];
        ((AviationForecastView *)_forecastGraph).showsTimeline=!sharedTimeline;
    } else if (_forecastMode == 2) {
        FlippedView *panel = [[FlippedView alloc] initWithFrame:forecastFrame];
        panel.accessibilityIdentifier = @"popover.rain";
        NSString *headline = rain[@"headline"] ?: @"Rain unavailable";
        NSTextField *reading = [self label:headline font:[NSFont systemFontOfSize:13 weight:NSFontWeightMedium]
            color:NSColor.labelColor frame:NSMakeRect(0, forecastH-58, NSWidth(forecastFrame), 30)];
        reading.accessibilityIdentifier = @"rain.headline";
        reading.maximumNumberOfLines=2; reading.lineBreakMode=NSLineBreakByWordWrapping;
        [panel addSubview:reading];
        NSTextField *amount = [self label:[rain[@"amount24"] stringByReplacingOccurrencesOfString:@"· 24h" withString:@"· next 24h"] ?: @"— · next 24h"
            font:[NSFont monospacedDigitSystemFontOfSize:13 weight:NSFontWeightMedium]
            color:NSColor.secondaryLabelColor frame:NSMakeRect(0, forecastH-24, NSWidth(forecastFrame), 22)];
        amount.alignment = NSTextAlignmentLeft;
        [panel addSubview:amount];
        RainForecastView *graph = [[RainForecastView alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(forecastFrame), MAX(60,forecastH-66))];
        NSMutableDictionary *extended=[rain mutableCopy];
        NSMutableArray *hours=[RainOutlook([self packFor:rainPlace][@"series"],windowStart,ZoneForPlace(rainPlace))[@"hours"] mutableCopy] ?: [NSMutableArray array];
        for (NSInteger offset=48;offset<[self detailHorizonHours];offset+=48)
            [hours addObjectsFromArray:RainOutlook([self packFor:rainPlace][@"series"],[windowStart dateByAddingTimeInterval:offset*3600],ZoneForPlace(rainPlace))[@"hours"] ?: @[]];
        extended[@"hours"]=hours; graph.outlook=extended;
        graph.horizonHours=[self detailHorizonHours]; _forecastGraph=graph;
        graph.now = windowStart; graph.referenceNow=now;
        graph.timeZone = ZoneForPlace(rainPlace);
        graph.accessibilityIdentifier = @"rain.timeline";
        __weak NSTextField *hoverReading=reading;
        graph.onInspect=^(NSString *summary) {
            hoverReading.stringValue=summary ?: headline;
            hoverReading.toolTip=summary;
        };
        [panel addSubview:graph];
        [root addSubview:panel];
    } else if (_forecastMode == 4) {
        TemperatureForecastView *temperature = [[TemperatureForecastView alloc] initWithFrame:forecastFrame];
        temperature.rows = [self packFor:rainPlace][@"series"] ?: @[];
        temperature.now = windowStart; temperature.timeZone = ZoneForPlace(rainPlace);
        temperature.horizonHours=[self detailHorizonHours]; _forecastGraph=temperature;
        temperature.accessibilityIdentifier = @"popover.temperature";
        [root addSubview:temperature];
    } else if (_forecastMode == 3) {
        NSDictionary *spot = [self windPlace];
        SurfForecastView *surf = [[SurfForecastView alloc] initWithFrame:forecastFrame];
        surf.outlook = SurfOutlook([self packFor:spot][@"marine"], now);
        surf.windRows = [self packFor:spot][@"series"] ?: @[];
        surf.now = windowStart;
        surf.horizonHours=[self detailHorizonHours]; _forecastGraph=surf;
        surf.timeZone = ZoneForPlace(spot);
        surf.accessibilityIdentifier = @"popover.surf";
        [root addSubview:surf];
    } else if (_forecastMode == 0) {
        NSDictionary *spot = [self windPlace];
        HourlyForecastView *forecast = [[HourlyForecastView alloc] initWithFrame:forecastFrame];
        forecast.windRows = [self packFor:spot][@"series"] ?: @[];
        forecast.rainRows = [self packFor:spot][@"series"] ?: @[];
        forecast.now = windowStart;
        forecast.horizonHours=[self detailHorizonHours]; _forecastGraph=forecast;
        forecast.timeZone = ZoneForPlace(spot);
        forecast.minKt = _kiteMin;
        forecast.maxKt = _kiteMax;
        forecast.hasShore = [spot[@"shoreNormal"] isKindOfClass:NSNumber.class];
        forecast.shoreNormal = [spot[@"shoreNormal"] doubleValue];
        forecast.accessibilityIdentifier = @"popover.windForecast";
        [root addSubview:forecast];
    }
    [self updateForecastInspection:[self selectedForecastDate]];
    return root;
}

- (void)rebuildContent {
    double seekingProgress = _motionSeeking ? _popoverTimeline.progress : NAN;
    PDFCropView *retainedMap=_leftChart;
    TimelineStrip *retainedTimeline=_popoverTimeline;
    retainedTimeline.preservesInteraction=YES;
    BOOL keepMovie=retainedMap && _motionPlayer && _motionMovieURL && !_motionCursorFullscreen;
    _forecastGraph=nil; _forecastTime=nil; _forecastReading=nil;
    if (!self.popover) {
        self.popover = [NSPopover new];
        self.popover.behavior = NSPopoverBehaviorTransient;
        self.popover.animates = NO;
        self.popover.delegate = self;
        self.popover.contentViewController = [NSViewController new];
    }
    [self rebuildSequence];
    [self ensurePair];
    NSDate *now = _chartNow ?: NSDate.date;
    NSSize budget = [self screenBudget];
    BOOL compact = budget.height < 640;
    NSString *fresh = [self chartFreshnessAt:now];
    NSFont *issuedFont = [NSFont systemFontOfSize:11 weight:NSFontWeightRegular];
    CGFloat pad = 12;
    // The taller timeline needs a little tighter compact chrome so the map
    // keeps its 500px working width at the 1024x600 breakpoint.
    CGFloat gutter = compact ? 7 : 10;
    CGFloat titleH = 26;
    CGFloat layerH = 26;
    CGFloat timelineH = compact ? 80 : 120;
    CGFloat cardH = 28;
    CGFloat chrome = pad + titleH + 2 * gutter + layerH + gutter + timelineH + gutter + cardH + pad;
    CGFloat maxChartH = MAX(64, budget.height - chrome - (compact ? 4 : 0));
    CGFloat aspect = _sourceECMWF ? OwnChartMapAspect() : MSLPPopoverMapAspect();
    if (!(aspect > 0.4 && aspect < 4)) aspect = 1.33;
    NSInteger leftIndex = _pair.valid ? _pair.left : 0;
    // The popover is a single-map viewer. The pair still drives stepping and
    // compatibility with the existing timeline model, but only its left
    // (selected) index is rendered here.
    CGFloat contentCap = MIN(budget.width, 980);
    CGFloat panelW = MIN(contentCap - 2 * pad, floor(maxChartH * aspect));
    // Details never take height away from the map. Add a right-hand inspector
    // when the screen has room; narrow screens use a focused detail surface.
    CGFloat width = MAX(360,2*pad+panelW);
    width=MIN(width,budget.width);
    CGFloat panelH = panelW / aspect;
    CGFloat inspectorW=MIN(420,budget.width-width-gutter);
    BOOL sideInspector=_forecastMode>=0 && inspectorW>=360;
    BOOL focusedInspector=_forecastMode>=0 && !sideInspector;
    CGFloat totalWidth=sideInspector?width+gutter+inspectorW:width;

    // Keep the live map's view/layer tree attached while changing inspectors.
    // Replacing it makes AVPlayer wait for a fresh presentation surface.
    PopoverRootView *root=(id)self.popover.contentViewController.view;
    if (![root isKindOfClass:PopoverRootView.class])
        root=[[PopoverRootView alloc] initWithFrame:NSMakeRect(0,0,width,10)];
    for (NSView *child in [root.subviews copy])
        if (child!=retainedMap && child!=retainedTimeline) [child removeFromSuperview];
    retainedMap.hidden=NO; retainedTimeline.hidden=NO;
    CGFloat observationsY=pad;
    CGFloat y=pad+cardH+gutter;
    NSDate *leftWhen = [self selectedForecastDate];
    NSString *leftRelative = leftWhen ? (ForecastDay(leftWhen, now, OwnerZone()) ?: @"") : @"";
    NSString *leftClock = leftWhen ? (SituationClock(leftWhen, OwnerZone()) ?: @"") : @"";
    if (!leftRelative.length && ![self chartsReady]) {
        leftRelative = _dataStale ? @"Chart unavailable" : @"Chart loading";
        leftClock = @"";
    }
    CGFloat gear = 52;
    CGFloat issuedW = fresh.length ? TextWidth(fresh, issuedFont) + 16 : 0;
    CGFloat issuedX = width - pad - gear - (fresh.length ? 8 + issuedW : 0);
    NSTextField *(^heading)(NSString *, NSString *, NSRect, NSString *) =
        ^NSTextField *(NSString *relative, NSString *clock, NSRect frame, NSString *identifier) {
            NSTextField *title = [self popoverHeading:relative clock:clock kind:nil frame:frame];
            title.accessibilityIdentifier = identifier;
            NSDate *when = leftWhen;
            NSString *offset = SituationOffset(when, now);
            if (offset.length) title.toolTip = offset;
            return title;
        };
    PDFCropView *leftChart = nil;
    NSTextField *leftCap = nil;
    CGFloat titleW = MAX(80, issuedX - gutter - pad);
    leftCap = heading(leftRelative, leftClock, NSMakeRect(pad, y, titleW, titleH), @"popover.title.left");
    [root addSubview:leftCap];
    y += titleH + gutter;
    leftChart = retainedMap ?: [self popoverChartView:@"popover.chart"];
    CGFloat mapX = MAX(pad, floor((width - panelW) / 2.0));
    NSRect mapFrame=NSMakeRect(mapX,y,panelW,panelH);
    if (keepMovie) {
        leftChart.frame=mapFrame;
        if (leftChart.superview!=root) [root addSubview:leftChart];
    } else [self placePopoverChart:leftChart index:leftIndex frame:mapFrame in:root];
    y += panelH + gutter;
    _leftChart = leftChart;
    _rightChart = nil;
    _leftTitle = leftCap;
    _rightTitle = nil;
    _shownLeft = leftIndex;
    _shownRight = -1;
    _previewIndex = -1;

    if (fresh.length) {
        NSTextField *issue = [self label:fresh font:issuedFont
            color:NSColor.secondaryLabelColor
            frame:NSMakeRect(issuedX, NSMinY(leftCap.frame), issuedW, titleH)];
        issue.alignment = NSTextAlignmentRight;
        issue.lineBreakMode = NSLineBreakByClipping;
        issue.accessibilityIdentifier = @"popover.issued";
        NSString *raw = _sourceECMWF ? _statusLabel : @"Bureau issue time is unavailable in the local store";
        if (raw.length) issue.toolTip = raw;
        [root addSubview:issue];
    }
    NSImage *gearImage = [NSImage imageWithSystemSymbolName:@"gearshape" accessibilityDescription:@"Settings"];
    NSImageSymbolConfiguration *gearStyle = [NSImageSymbolConfiguration configurationWithPointSize:13 weight:NSFontWeightRegular];
    if (gearStyle) gearImage = [gearImage imageWithSymbolConfiguration:gearStyle] ?: gearImage;
    NSButton *settings = [NSButton buttonWithImage:gearImage target:self action:@selector(openSettings:)];
    settings.bordered = NO;
    settings.imagePosition = NSImageOnly;
    settings.imageScaling = NSImageScaleProportionallyDown;
    settings.contentTintColor = NSColor.secondaryLabelColor;
    settings.toolTip = @"Settings";
    settings.accessibilityLabel = @"Settings";
    settings.frame = NSMakeRect(width - pad - 22, NSMinY(leftCap.frame) + 2, 22, 22);
    settings.accessibilityIdentifier = @"popover.settings";
    [root addSubview:settings];
    NSButton *expand = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"arrow.up.left.and.arrow.down.right" accessibilityDescription:@"Expand map"] target:self action:@selector(openChartWindow)];
    expand.bordered = NO; expand.contentTintColor = NSColor.secondaryLabelColor;
    expand.frame = NSMakeRect(width-pad-52, NSMinY(leftCap.frame)+2, 22, 22);
    expand.accessibilityIdentifier = @"popover.expand"; expand.toolTip = @"Expand map";
    [root addSubview:expand];

    BOOL compactControls = width < 500;
    CGFloat layersW = compactControls ? 56 : 84;
    NSPopUpButton *layers = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(pad, y, layersW, layerH) pullsDown:YES];
    layers.bordered = NO;
    layers.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    layers.menu = [self mapLayersMenu];
    layers.accessibilityIdentifier = @"popover.layers";
    [root addSubview:layers];
    CGFloat modesX = compactControls ? pad + layersW + 8 : width - pad - 344;
    CGFloat modesW = compactControls ? width - pad - modesX : 344;
    FlippedView *modes = [[FlippedView alloc] initWithFrame:NSMakeRect(modesX, y, modesW, 26)];
    modes.accessibilityIdentifier = @"popover.forecastMode";
    NSArray *titles = @[@"Rain", @"Temperature", @"Kite", @"Surf", @"Fly"];
    NSArray *symbols=@[@"cloud.rain",@"thermometer.medium",@"wind",@"water.waves",@"airplane"];
    NSArray *values = @[@2, @4, @0, @3, @1];
    CGFloat modeX = 0;
    for (NSUInteger i=0; i<titles.count; i++) {
        NSButton *button = [NSButton buttonWithTitle:titles[i] target:self action:@selector(chooseForecastMode:)];
        button.buttonType = NSButtonTypePushOnPushOff;
        button.bordered=NO;
        button.wantsLayer=YES; button.layer.cornerRadius=6;
        button.image=[NSImage imageWithSystemSymbolName:symbols[i] accessibilityDescription:nil];
        button.imagePosition=NSImageLeading;
        button.imageScaling=NSImageScaleProportionallyDown;
        if (i==1) button.title=@"Temp";
        button.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        button.tag = [values[i] integerValue];
        button.state = _forecastMode == button.tag ? NSControlStateValueOn : NSControlStateValueOff;
        BOOL selected=button.state==NSControlStateValueOn;
        button.contentTintColor=selected?NSColor.controlAccentColor:NSColor.secondaryLabelColor;
        button.layer.backgroundColor=[NSColor.controlAccentColor colorWithAlphaComponent:selected?.12:0].CGColor;
        CGFloat buttonWidth=(modesW-16)/5;
        if (compactControls) button.imagePosition=NSNoImage;
        button.frame = NSMakeRect(modeX, 0, buttonWidth, 26);
        modeX += buttonWidth+4;
        button.accessibilityIdentifier = [@"forecast.toggle." stringByAppendingString:[titles[i] lowercaseString]];
        button.accessibilityLabel=titles[i]; button.toolTip=titles[i];
        [modes addSubview:button];
    }
    [root addSubview:modes];
    if (_sourceECMWF) {
        CGFloat keyLeft = NSMaxX(layers.frame) + 8;
        CGFloat keyRight = NSMinX(modes.frame) - gutter;
        NSView *key = [self makeChartKeyMaxWidth:keyRight - keyLeft window:NO];
        if (key && NSHeight(key.frame) <= layerH) {
            key.frame = NSMakeRect(keyLeft, y, MIN(NSWidth(key.frame), keyRight - keyLeft), layerH);
            [root addSubview:key];
        }
    }
    y += layerH + gutter;

    CGFloat buttonW = 22;
    BOOL rawMotion = _sourceECMWF && _ownRun.hours > 0;
    CGFloat playW = (rawMotion || MotionEnabled()) ? 30 : 0;
    CGFloat nowW=42;
    NSButton *play = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:_popoverPlaying ? @"pause.fill" : @"play.fill"
        accessibilityDescription:_popoverPlaying ? @"Pause forecast" : @"Play forecast"] target:self action:@selector(togglePopoverPlayback:)];
    play.bordered=NO; play.contentTintColor=NSColor.labelColor;
    play.hidden=!(rawMotion || MotionEnabled());
    play.frame=NSMakeRect(pad,y,playW,timelineH);
    play.enabled=_sequenceTimes.count>=2 && _pair.valid;
    play.toolTip=_popoverPlaying?@"Pause forecast (Space)":@"Play forecast (Space)";
    play.accessibilityIdentifier=@"popover.play";
    play.accessibilityLabel=_popoverPlaying?@"Pause forecast":@"Play forecast";
    [root addSubview:play];
    _popoverPlayButton = play;
    [self updatePopoverPlayControl];
    NSFont *stepFont = [NSFont systemFontOfSize:16 weight:NSFontWeightMedium];
    BOOL canBack = NO, canForward = NO;
    if (_pair.valid) {
        ChartPair back = StepChartPair(_pair, -1, (NSInteger)_sequenceTimes.count);
        ChartPair forward = StepChartPair(_pair, 1, (NSInteger)_sequenceTimes.count);
        canBack = back.left != _pair.left || back.right != _pair.right;
        canForward = forward.left != _pair.left || forward.right != _pair.right;
    }
    NSButton *(^stepButton)(NSString *, NSInteger, BOOL) = ^NSButton *(NSString *glyph, NSInteger tag, BOOL enabled) {
        NSButton *button = [NSButton buttonWithTitle:glyph target:self action:@selector(stepPairButton:)];
        button.tag = tag;
        button.bordered = NO;
        button.enabled = enabled;
        button.attributedTitle = [[NSAttributedString alloc] initWithString:glyph attributes:@{
            NSFontAttributeName: stepFont,
            NSForegroundColorAttributeName: enabled ? NSColor.labelColor : NSColor.quaternaryLabelColor,
        }];
        return button;
    };
    NSButton *prev = stepButton(@"‹", -1, canBack);
    prev.frame = NSMakeRect(pad + playW + nowW, y, buttonW, timelineH);
    prev.accessibilityIdentifier = @"popover.prev";
    [root addSubview:prev];
    NSButton *nowButton=[NSButton buttonWithTitle:@"Now" target:self action:@selector(resetPopoverToNow)];
    nowButton.bordered=NO; nowButton.font=[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
    nowButton.contentTintColor=NSColor.controlAccentColor;
    nowButton.frame=NSMakeRect(pad+playW,y,nowW,timelineH);
    nowButton.accessibilityIdentifier=@"popover.now";
    nowButton.toolTip=@"Return to now and play forecast"; [root addSubview:nowButton];
    NSButton *next = stepButton(@"›", 1, canForward);
    next.frame = NSMakeRect(totalWidth - pad - buttonW, y, buttonW, timelineH);
    next.accessibilityIdentifier = @"popover.next";
    [root addSubview:next];
    NSMutableArray *ticks = [NSMutableArray array];
    NSMutableArray *clocks = [NSMutableArray array];
    NSMutableArray *days = [NSMutableArray array];
    NSMutableArray *tips = [NSMutableArray array];
    for (NSDate *time in _sequenceTimes) {
        [ticks addObject:ForecastDay(time, now, OwnerZone()) ?: @""];
        [clocks addObject:SituationClock(time, OwnerZone()) ?: @""];
        [days addObject:@(SituationAnchorDay(time, OwnerZone()))];
        [tips addObject:SituationOffset(time, now) ?: @""];
    }
    TimelineStrip *strip=retainedTimeline ?: [TimelineStrip new];
    strip.frame=NSMakeRect(pad+playW+nowW+buttonW,y,
        MAX(40,totalWidth-2*pad-2*buttonW-playW-nowW),timelineH);
    _popoverTimeline = strip;
    strip.times = _sequenceTimes;
    strip.labels = ticks;
    strip.clocks = clocks;
    strip.dayKeys = days;
    strip.tips = tips;
    strip.hoverIndex = -1;
    strip.leftIndex = _pair.valid ? _pair.left : -1;
    strip.rightIndex = _pair.valid ? _pair.left : -1;
    strip.progress = isfinite(seekingProgress) ? seekingProgress : [self motionFractionForDate:leftWhen ?: now];
    strip.accessibilityIdentifier = @"popover.timeline";
    __weak Controller *weak = self;
    strip.onSelect = ^(NSInteger index) { [weak selectPopoverIndex:index]; };
    strip.onSeek = ^(double fraction) { [weak inspectPopoverMovieFraction:fraction]; };
    __weak TimelineStrip *weakStrip = strip;
    strip.onPreview = ^(double fraction) {
        Controller *strong = weak;
        // A periodic refresh replaces the strip. Ignore exit events from
        // the retired view so they cannot undo the current preview.
        if (strong && strong->_popoverTimeline == weakStrip) [strong previewPopoverMovieFraction:fraction];
    };
    strip.onHover = ^(NSInteger index) { [weak previewSequenceIndex:index]; };
    if (strip.superview!=root) [root addSubview:strip];


    NSArray *cards = [self cardPlaces];
    CGFloat cardGap = 8;
    NSInteger cardCount = MAX((NSInteger)cards.count, 1);
    CGFloat cardW = (width - 2 * pad - cardGap * (cardCount - 1)) / cardCount;
    for (NSInteger i = 0; i < (NSInteger)cards.count; i++) {
        NSRect frame = NSMakeRect(pad + i * (cardW + cardGap), observationsY, cardW, cardH);
        NSButton *button=[self observationButtonForPlace:cards[i] index:i frame:frame identifier:@"popover.obs"];
        [root addSubview:button];
    }
    for (NSView *control in @[play, nowButton, prev, next, strip]) {
        NSRect frame = control.frame; frame.origin.y = y; control.frame = frame;
    }
    y += timelineH + pad;

    if (_forecastMode>=0) {
        CGFloat naturalH=(_forecastMode==1?480:(_forecastMode==2?440:374));
        CGFloat inspectorH=sideInspector?MIN(NSMaxY(leftChart.frame),naturalH):budget.height-pad-layerH-gutter;
        NSView *inspector=[self forecastInspectorWithWidth:sideInspector?inspectorW:width height:inspectorH sharedTimeline:sideInspector];
        inspector.frame=NSMakeRect(sideInspector?width+gutter:0,0,NSWidth(inspector.frame),inspectorH);
        if (focusedInspector) {
            // A narrow screen shows the selected detail at a useful size.
            // Keep only the mode switcher and an explicit route back to the map.
            for (NSView *child in root.subviews) child.hidden=(child!=modes);
            for (NSView *child in inspector.subviews)
                if ([child.accessibilityIdentifier isEqual:@"forecast.close"]) child.hidden=YES;
            NSRect modeFrame=modes.frame; modeFrame.origin.y=budget.height-pad-layerH; modes.frame=modeFrame;
            NSButton *back=[NSButton buttonWithTitle:@"‹ Map" target:self action:@selector(closeForecast:)];
            back.bordered=NO; back.font=[NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
            back.frame=NSMakeRect(pad,NSMinY(modes.frame),compactControls?56:84,26);
            back.accessibilityIdentifier=@"forecast.back"; [root addSubview:back];
            y=budget.height;
        }
        [root addSubview:inspector];
    }
    root.frame = NSMakeRect(0, 0, totalWidth, y);
    if (!NSEqualSizes(self.popover.contentSize,NSMakeSize(totalWidth,y)))
        self.popover.contentSize=NSMakeSize(totalWidth,y);
    if (self.popover.contentViewController.view!=root) self.popover.contentViewController.view=root;
    strip.preservesInteraction=NO;
    if (_motionPlayer && _motionMovieURL && !_motionCursorFullscreen &&
        !_timelinePreviewing && !_scrubHasFraction) {
        [_leftChart attachMoviePlayer:_motionPlayer];
        [self updateRawMovieTime:_motionPlayer.currentTime];
    } else if (_timelinePreviewing) [self showStaticTimelineFraction:_timelinePreviewFraction];
    else if (_scrubHasFraction) [self showStaticTimelineFraction:_scrubFraction];
    else if (_motionHasCursor && !_motionCursorFullscreen) [self showPopoverMotionFrame:_motionCursor];
    [self updateBar];
}

- (NSWindow *)chartWindow { return _chartWindow; }
- (BOOL)fullscreenReady {
    return [self chartsReady] && !_fetching;
}

- (void)ensureClock {
    if (_clock) return;
    _clock = [NSTimer scheduledTimerWithTimeInterval:30 target:self selector:@selector(tickSurfaces) userInfo:nil repeats:YES];
}

- (void)tickSurfaces {
    // Fresh data rebuilds the controls. A clock tick only updates text, leaving
    // hover capture, the decoder and its presentation layer undisturbed.
    if (self.popover.shown) {
        NSDate *date=[self selectedForecastDate];
        [self updateForecastInspection:date];
        _leftTitle.attributedStringValue=[self popoverHeadingText:ForecastDay(date,_chartNow ?: NSDate.date,OwnerZone())
            clock:SituationClock(date,OwnerZone()) kind:nil];
        for (NSView *view in self.popover.contentViewController.view.subviews)
            if ([view.accessibilityIdentifier isEqual:@"popover.issued"])
                ((NSTextField *)view).stringValue=[self chartFreshnessAt:_chartNow ?: NSDate.date] ?: @"";
    }
    if (_chartWindow.isVisible) {
        NSInteger placeIndex=0;
        NSArray *places=[self cardPlaces];
        for (NSView *view in _statusBar.subviews) {
            if ([view.accessibilityIdentifier isEqual:@"fullscreen.run"])
                ((NSTextField *)view).stringValue=[self chartFreshnessAt:_chartNow ?: NSDate.date] ?: @"";
            if ([view isKindOfClass:GlanceCard.class] && placeIndex<(NSInteger)places.count)
                ((GlanceCard *)view).model=[self glanceModelForPlace:places[placeIndex++]];
        }
    }
    [self updateBar];
}

static NSColor *Ink(void) { return MSLPNSColour(MSLPColourInk()); }
static NSColor *Paper(void) { return MSLPNSColour(MSLPColourPaper()); }

// Silence a missing-prototype warning if the SDK header is not pulled in.
extern char *getenv(const char *);

static NSRect RectOf(MSLPRect r) { return NSMakeRect(r.x, r.y, r.width, r.height); }
static CGRect CropOf(MSLPRect r) { return CGRectMake(r.x, r.y, r.width, r.height); }

- (PDFCropView *)headerView {
    if (_headerView) return _headerView;
    _headerView = [PDFCropView new];
    _headerView.accessibilityIdentifier = @"fullscreen.header";
    __weak Controller *weak = self;
    _headerView.onClick = ^{ [weak escapeFullscreen]; };
    return _headerView;
}

- (PDFCropView *)panelViewAt:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return nil;
    if (_panelViews[0]) return _panelViews[0];
    PDFCropView *view=[PDFCropView new];
    view.accessibilityIdentifier=@"window.chart";
    view.wantsLayer=YES; view.layer.cornerRadius=10; view.layer.masksToBounds=YES;
    __weak Controller *weak=self;
    view.onClick=^{ [weak resetPopoverToNow]; };
    view.onMagnify=^(CGFloat delta) {
        Controller *strong=weak; if (!strong) return;
        strong->_panelZoom=MIN(4,MAX(1,strong->_panelZoom*(1+delta)));
        [strong layoutChartWindow];
    };
    _panelViews[0]=view;
    return view;
}

- (NSScrollView *)singleScroll {
    if (_singleScroll) return _singleScroll;
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
    scroll.allowsMagnification = NO;
    scroll.hasHorizontalScroller = YES;
    scroll.hasVerticalScroller = YES;
    scroll.autohidesScrollers = YES;
    scroll.scrollerStyle = NSScrollerStyleOverlay;
    scroll.drawsBackground = NO;
    scroll.borderType = NSNoBorder;
    scroll.accessibilityIdentifier = @"fullscreen.chartScroll";
    _singleScroll = scroll;
    return scroll;
}

- (void)showWarningText:(NSString *)text relativeTo:(NSView *)view {
    if (!text.length || !view) return;
    [_warningPop close];
    NSFont *font = [NSFont systemFontOfSize:13];
    CGFloat width = 380;
    NSRect bounds = [text boundingRectWithSize:NSMakeSize(width, 4000)
        options:NSStringDrawingUsesLineFragmentOrigin attributes:@{NSFontAttributeName: font}];
    CGFloat textH = MAX(20, ceil(bounds.size.height));
    CGFloat height = MIN(320, textH + 20);
    FlippedView *doc = [[FlippedView alloc] initWithFrame:NSMakeRect(0, 0, width + 20, textH + 20)];
    NSTextField *label = [self label:text font:font color:NSColor.labelColor frame:NSMakeRect(10, 10, width, textH)];
    label.selectable = YES;
    label.cell.wraps = YES;
    label.lineBreakMode = NSLineBreakByWordWrapping;
    label.maximumNumberOfLines = 0;
    [doc addSubview:label];
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, width + 20, height)];
    scroll.documentView = doc;
    scroll.hasVerticalScroller = textH + 20 > height;
    scroll.drawsBackground = NO;
    scroll.borderType = NSNoBorder;
    NSViewController *controller = [NSViewController new];
    controller.view = scroll;
    NSPopover *pop = [NSPopover new];
    pop.behavior = NSPopoverBehaviorTransient;
    pop.animates = NO;
    pop.contentViewController = controller;
    pop.contentSize = NSMakeSize(width + 20, height);
    _warningPop = pop;
    [pop showRelativeToRect:view.bounds ofView:view preferredEdge:NSMaxYEdge];
}

- (NSButton *)observationButtonForPlace:(NSDictionary *)place index:(NSInteger)index frame:(NSRect)frame identifier:(NSString *)identifier {
    CGFloat cardW=NSWidth(frame);
    NSDictionary *pack = [self packFor:place];
    NSDictionary *observation = [pack[@"obs"] isKindOfClass:NSDictionary.class] ? pack[@"obs"] : nil;
    NSDictionary *windModel = FooterWindModel(observation);
    NSString *temp = [observation[@"airTemp"] isKindOfClass:NSNumber.class]
        ? [NSString stringWithFormat:@"%.0f°", round([observation[@"airTemp"] doubleValue])] : @"—";
    BOOL hasSpeed = [windModel[@"hasSpeed"] boolValue];
    NSString *speed = FooterWindSpeedLabel(windModel);
    NSString *warningMark = [pack[@"warnings"] count] ? @"  ⚠" : @"";
    NSString *title = [NSString stringWithFormat:@"%@  %@  %@%@  ›", place[@"name"] ?: @"", temp, speed, warningMark];
    NSButton *button = [NSButton buttonWithTitle:title target:self action:@selector(showObservation:)];
    button.bordered = NO;
    button.alignment = NSTextAlignmentLeft;
    button.font = [NSFont systemFontOfSize:12];
    NSMutableAttributedString *attributed=[[NSMutableAttributedString alloc] initWithString:
        [NSString stringWithFormat:@"%@  ",temp]
        attributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:22 weight:NSFontWeightSemibold],NSForegroundColorAttributeName:NSColor.labelColor}];
    [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:
        [NSString stringWithFormat:@"%@ · now  ",place[@"name"] ?: @""]
        attributes:@{NSFontAttributeName:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium],NSForegroundColorAttributeName:NSColor.secondaryLabelColor}]];
    NSImage *windImage = FooterWindImage(windModel);
    if (cardW>=230 && observation && ([windModel[@"hasDirection"] boolValue] || hasSpeed)) {
        NSTextAttachment *attachment = [NSTextAttachment new];
        attachment.image = windImage;
        attachment.bounds = NSMakeRect(0, -3, 22, 18);
        [attributed appendAttributedString:[NSAttributedString attributedStringWithAttachment:attachment]];
    }
    [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:
        cardW>=230?[NSString stringWithFormat:@"  %@%@  ›", speed, warningMark]:warningMark
        attributes:@{NSFontAttributeName: button.font, NSForegroundColorAttributeName: NSColor.labelColor}]];
    button.attributedTitle = attributed;
    button.frame = frame;
    button.tag = index;
    button.accessibilityIdentifier = identifier;
    NSString *direction = [windModel[@"calm"] boolValue] ? @"Calm"
        : ([windModel[@"hasDirection"] boolValue]
            ? ([windModel[@"direction"] length] ? windModel[@"direction"] : @"Wind")
            : (hasSpeed ? @"Direction unavailable" : @"Wind unavailable"));
    NSString *warning = [pack[@"warnings"] count] ? @", warning" : @"";
    button.toolTip = [NSString stringWithFormat:@"%@ · %@ now · %@%@. Observations and warnings.",
        place[@"name"] ?: @"Weather",temp, hasSpeed ? [NSString stringWithFormat:@"%@ %.0f kt", direction, [windModel[@"speedKt"] doubleValue]] : direction, warning];
    button.accessibilityLabel = button.toolTip;
    return button;
}

- (void)layoutStatusBar:(NSArray *)places bar:(MSLPRect)bar in:(NSView *)root {
    if (!_statusBar) {
        _statusBar = [[PassThroughView alloc] initWithFrame:NSZeroRect];
        _statusBar.accessibilityIdentifier = @"fullscreen.statusBar";
    }
    _statusBar.frame = RectOf(bar);
    if (_statusBar.superview!=root) [root addSubview:_statusBar];
    for (NSView *child in _statusBar.subviews.copy) [child removeFromSuperview];
    CGFloat inset=18, gap=12;
    NSInteger count=places.count;
    CGFloat cardW=count?MIN(440,(bar.width-2*inset-gap*(count-1))/count):0;
    for (NSInteger i=0;i<count;i++) {
        NSRect frame=NSMakeRect(inset+i*(cardW+gap),0,cardW,34);
        NSButton *button=[self observationButtonForPlace:places[i] index:i frame:frame
            identifier:i==0?@"fullscreen.status":@"fullscreen.observation"];
        [_statusBar addSubview:button];
    }
    NSFont *font=[NSFont systemFontOfSize:11];
    NSString *runLine=[self chartFreshnessAt:_chartNow ?: NSDate.date];
    CGFloat runW=MIN(bar.width-2*inset,TextWidth(runLine,font)+8);
    if (runLine.length) {
        NSTextField *run=[self label:runLine font:font color:NSColor.secondaryLabelColor
            frame:NSMakeRect(bar.width-inset-runW,42,runW,18)];
        run.alignment=NSTextAlignmentRight;
        run.accessibilityIdentifier=@"fullscreen.run";
        [_statusBar addSubview:run];
    }
    if (_sourceECMWF) {
        CGFloat room=bar.width-2*inset-runW-gap;
        NSView *key=room>=96?[self makeChartKeyMaxWidth:room window:NO]:nil;
        if (key) {
            key.frame=NSMakeRect(inset,38,MIN(NSWidth(key.frame),room),MIN(28,NSHeight(key.frame)));
            [_statusBar addSubview:key];
        }
    }
}

- (NSTextField *)timeTitleField {
    if (_timeTitle) return _timeTitle;
    _timeTitle = [[NSTextField alloc] initWithFrame:NSZeroRect];
    _timeTitle.editable = NO;
    _timeTitle.selectable = NO;
    _timeTitle.bezeled = NO;
    _timeTitle.drawsBackground = NO;
    _timeTitle.textColor = Ink();
    _timeTitle.font = [NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
    _timeTitle.alignment = NSTextAlignmentCenter;
    _timeTitle.lineBreakMode = NSLineBreakByTruncatingTail;
    _timeTitle.accessibilityIdentifier = @"fullscreen.timeTitle";
    return _timeTitle;
}

- (NSString *)singleTitleForIndex:(NSInteger)index {
    if (_comparing && _sourceECMWF && _runDate && _previousRunDate) {
        NSString *label = StoreRunCompareTitle(_runDate, _previousRunDate);
        if (label.length) return label;
    }
    if (_comparing) {
        NSString *label = IssueCompareTitle(_issued, _previousIssued, ZoneForPlace([self shownLocations].firstObject));
        if (label.length) return label;
    }
    return [self titleForSequenceIndex:index];
}

- (void)applyComparisonToPanel:(PDFCropView *)panel index:(NSInteger)index bare:(BOOL)bare {
    NSInteger prev = _comparing ? [self previousPrognosisPanelForSequenceIndex:index] : -1;
    if (prev < 0 || !_previousDoc) {
        [panel setComparisonDocument:NULL crop:CGRectZero alpha:0];
        return;
    }
    CGPDFPageRef page = CGPDFDocumentGetPage(_previousDoc, 1);
    if (!page) {
        [panel setComparisonDocument:NULL crop:CGRectZero alpha:0];
        return;
    }
    CGRect media = CGPDFPageGetBoxRect(page, kCGPDFMediaBox);
    MSLPPage chart = MSLPPageLayout(media.size.width, media.size.height);
    if (!chart.valid || prev > 7) {
        [panel setComparisonDocument:NULL crop:CGRectZero alpha:0];
        return;
    }
    MSLPRect crop = bare ? MSLPPrognosisMapCrop(media.size.width, media.size.height, (int)prev) : chart.panels[prev];
    if (crop.width < 10 || crop.height < 10) crop = chart.panels[prev];
    [panel setComparisonDocument:_previousDoc crop:CropOf(crop) alpha:0.5];
}

- (void)chartToolbarAction:(NSButton *)sender {
    switch (sender.tag) {
        case 0: [self resetPopoverToNow]; break;
        case 1: [self stepFullscreenPanel:-1]; break;
        case 2: [self toggleChartLoop]; break;
        case 3: [self stepFullscreenPanel:1]; break;
        case 4: [self zoomChart:-1]; break;
        case 5: [self zoomChart:0]; break;
        case 6: [self zoomChart:1]; break;
        case 7: [self toggleIssueCompare]; break;
        case 8: [self closeChartWindow]; break;
    }
}

- (void)layoutChartToolbarIn:(NSView *)root height:(CGFloat)height {
    if (!_chartToolbar) {
        _chartToolbar = [FlippedView new];
        _chartToolbar.accessibilityIdentifier = @"fullscreen.toolbar";
    }
    CGFloat width = NSWidth(root.bounds);
    NSResponder *responder = root.window.firstResponder;
    NSString *focusedControl = [responder isKindOfClass:NSView.class] &&
        [(NSView *)responder isDescendantOf:_chartToolbar] ? [(NSView *)responder accessibilityIdentifier] : nil;
    _chartToolbar.frame = NSMakeRect(0, 0, width, height);
    for (NSView *child in _chartToolbar.subviews.copy) [child removeFromSuperview];
    [root addSubview:_chartToolbar];
    NSButton *(^control)(NSString *, NSString *, NSString *, NSInteger, CGFloat, CGFloat) =
        ^NSButton *(NSString *name, NSString *symbol, NSString *tip, NSInteger tag, CGFloat x, CGFloat w) {
            NSImage *image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:tip];
            NSButton *button = [NSButton buttonWithImage:image target:self action:@selector(chartToolbarAction:)];
            button.bordered = NO;
            button.imageScaling = NSImageScaleProportionallyDown;
            button.frame = NSMakeRect(x, 6, w, 28);
            button.tag = tag;
            button.toolTip = tip;
            button.accessibilityLabel = tip;
            button.accessibilityIdentifier = [@"fullscreen." stringByAppendingString:name];
            [_chartToolbar addSubview:button];
            if ([button.accessibilityIdentifier isEqual:focusedControl]) [root.window makeFirstResponder:button];
            return button;
        };
    control(@"close", @"xmark", @"Close map (⌘W)", 8, width-40, 28);
    NSPopUpButton *layerMenu=[[NSPopUpButton alloc] initWithFrame:NSMakeRect(width-300,8,84,26) pullsDown:YES];
    layerMenu.menu=[self mapLayersMenu]; layerMenu.bordered=NO; layerMenu.font=[NSFont systemFontOfSize:12];
    layerMenu.accessibilityIdentifier=@"fullscreen.layers"; [_chartToolbar addSubview:layerMenu];
    control(@"zoomOut", @"minus.magnifyingglass", @"Zoom out (⌘−)", 4, width-212, 28).enabled = _panelZoom > 1;
    NSButton *reset = control(@"zoomReset", @"arrow.counterclockwise", @"Reset zoom (⌘0)", 5, width-180, 56);
    reset.imagePosition = NSNoImage;
    reset.title = [NSString stringWithFormat:@"%.0f%%", _panelZoom * 100];
    reset.font = [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium];
    reset.enabled = _panelZoom > 1;
    control(@"zoomIn", @"plus.magnifyingglass", @"Zoom in (⌘+)", 6, width-120, 28).enabled = _panelZoom < 4;
    BOOL canCompare = [self earlierIssueForIndex:_panelIndex] >= 0;
    NSButton *compare = control(@"compare", @"square.2.layers.3d",
        canCompare ? @"Compare previous forecast (D)" : @"No earlier chart available", 7, width-80, 28);
    compare.enabled = canCompare;
    compare.contentTintColor = _comparing ? NSColor.controlAccentColor : NSColor.labelColor;
    compare.state = _comparing ? NSControlStateValueOn : NSControlStateValueOff;
    NSTextField *title = [self timeTitleField];
    title.hidden = NO;
    title.frame = NSMakeRect(14, 10, MAX(40, width-324), 22);
    title.alignment=NSTextAlignmentLeft;
    title.stringValue = [self singleTitleForIndex:_panelIndex] ?: @"";
    title.toolTip = title.stringValue;
    [_chartToolbar addSubview:title];
}

- (void)layoutChartTransportIn:(NSView *)root y:(CGFloat)y height:(CGFloat)height {
    if (!_chartTransport) { _chartTransport=[FlippedView new]; _chartTransport.accessibilityIdentifier=@"fullscreen.transport"; }
    CGFloat width=NSWidth(root.bounds);
    _chartTransport.frame=NSMakeRect(0,y,width,height);
    if (_chartTransport.superview!=root) [root addSubview:_chartTransport];
    for (NSView *child in _chartTransport.subviews.copy) if (child!=_chartTimeline) [child removeFromSuperview];
    NSButton *(^button)(NSString *,NSString *,NSInteger,CGFloat,CGFloat)=^NSButton *(NSString *name,NSString *symbol,NSInteger tag,CGFloat x,CGFloat w) {
        NSButton *control=[NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:symbol accessibilityDescription:name] target:self action:@selector(chartToolbarAction:)];
        control.bordered=NO; control.frame=NSMakeRect(x,24,w,32); control.tag=tag;
        control.accessibilityIdentifier=[@"fullscreen." stringByAppendingString:name];
        control.enabled=_sequenceTimes.count>1;
        [_chartTransport addSubview:control]; return control;
    };
    _chartPlayButton=button(@"play",@"play.fill",2,12,28);
    NSButton *now=button(@"now",@"arrow.counterclockwise",0,44,48);
    now.title=@"Now"; now.imagePosition=NSNoImage; now.contentTintColor=NSColor.controlAccentColor;
    now.font=[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]; now.toolTip=@"Now · keep playing";
    button(@"prev",@"chevron.left",1,96,24).toolTip=@"Previous forecast";
    button(@"next",@"chevron.right",3,width-36,24).toolTip=@"Next forecast";
    if (!_chartTimeline) _chartTimeline=[TimelineStrip new];
    _chartTimeline.frame=NSMakeRect(124,0,MAX(40,width-164),height);
    _chartTimeline.accessibilityIdentifier=@"fullscreen.timeline";
    _chartTimeline.times=_sequenceTimes;
    NSMutableArray *labels=[NSMutableArray array], *clocks=[NSMutableArray array], *days=[NSMutableArray array], *tips=[NSMutableArray array];
    for (NSDate *date in _sequenceTimes) {
        [labels addObject:ForecastDay(date,_chartNow ?: NSDate.date,OwnerZone()) ?: @""];
        [clocks addObject:SituationClock(date,OwnerZone()) ?: @""];
        [days addObject:@(SituationAnchorDay(date,OwnerZone()))];
        [tips addObject:SituationOffset(date,_chartNow ?: NSDate.date) ?: @""];
    }
    _chartTimeline.labels=labels; _chartTimeline.clocks=clocks;
    _chartTimeline.dayKeys=days; _chartTimeline.tips=tips;
    _chartTimeline.leftIndex=_panelIndex; _chartTimeline.rightIndex=_panelIndex;
    _chartTimeline.progress=[self motionFractionForDate:[self selectedForecastDate]];
    __weak Controller *weak=self;
    _chartTimeline.onSeek=^(double fraction) { [weak inspectPopoverMovieFraction:fraction]; };
    _chartTimeline.onPreview=^(double fraction) { [weak previewPopoverMovieFraction:fraction]; };
    if (_chartTimeline.superview!=_chartTransport) [_chartTransport addSubview:_chartTimeline];
    [_chartTimeline updateTrackingAreas];
    [self updatePopoverPlayControl];
}

- (void)layoutChartWindow {
    if (!_chartWindow || !_expandedMap || ![self chartsReady]) return;
    [self rebuildSequence];
    NSView *root=_chartWindow.contentView;
    NSRect bounds=root.bounds;
    if (NSWidth(bounds)<200 || NSHeight(bounds)<200) return;
    _panelIndex=MIN(MAX(0,_panelIndex),(NSInteger)_sequenceTimes.count-1);
    CGFloat toolbarH=42, timelineH=112;
    CGFloat footerH=72;
    CGFloat timelineY=NSHeight(bounds)-footerH-timelineH;
    NSRect area=NSMakeRect(12,toolbarH+4,NSWidth(bounds)-24,MAX(40,timelineY-toolbarH-10));
    double sw=580,sh=444;
    if (!_sourceECMWF) {
        CGRect crop=CGRectZero;
        if ([self documentForPopoverIndex:_panelIndex crop:&crop pins:NULL] && crop.size.width>1 && crop.size.height>1) { sw=crop.size.width; sh=crop.size.height; }
    }
    MSLPRect fitted=MSLPAspectFit(sw,sh,(MSLPRect){area.origin.x,area.origin.y,area.size.width,area.size.height});
    NSScrollView *scroll=[self singleScroll];
    scroll.hidden=NO;
    if (scroll.superview!=root) [root addSubview:scroll];
    PDFCropView *panel=[self panelViewAt:_panelIndex];
    panel.hidden=NO;
    NSRect scrollFrame=_panelZoom<=1.001?RectOf(fitted):area;
    if (!NSEqualRects(scroll.frame,scrollFrame)) scroll.frame=scrollFrame;
    if (scroll.documentView!=panel) scroll.documentView=panel;
    NSSize mapSize=NSMakeSize(fitted.width*MAX(1,_panelZoom),fitted.height*MAX(1,_panelZoom));
    if (!NSEqualSizes(panel.frame.size,mapSize)) [panel setFrameSize:mapSize];
    panel.sequenceIndex=_panelIndex;
    BOOL hasMovie=_motionPlayer && _motionMovieURL && !_comparing &&
        !_timelinePreviewing && !_scrubHasFraction;
    if (!hasMovie && !_scrubHasFraction) [self assignChart:panel index:_panelIndex bare:YES compare:YES];
    if (hasMovie) { [panel attachMoviePlayer:_motionPlayer]; _motionCursorFullscreen=YES; }
    [self layoutStatusBar:[self cardPlaces] bar:(MSLPRect){0,NSHeight(bounds)-footerH,NSWidth(bounds),footerH} in:root];
    [self layoutChartToolbarIn:root height:toolbarH];
    [self layoutChartTransportIn:root y:timelineY height:timelineH];
    if (hasMovie && !_motionSeeking) [self updateRawMovieTime:_motionPlayer.currentTime];
    else if (!_comparing && (_scrubHasFraction || _motionSeeking)) [self updateTimelineHeading:[self selectedForecastDate]];
    if (_compareNote.superview) [root addSubview:_compareNote];
}

- (NSInteger)fullscreenPanelIndex { return _panelIndex; }

- (void)dismissCompareNote {
    _compareNoteToken++;
    [_compareNote removeFromSuperview];
}

- (void)focusFullscreenPanel:(NSInteger)index {
    NSInteger last=(NSInteger)_sequenceTimes.count-1;
    if (last<0 || index>last) return;
    if (index<0) index=MAX(0,_panelIndex);
    [self dismissCompareNote];
    [self stopChartLoop];
    [_scrubRenderer cancelRequests]; _scrubHasFraction=NO; _timelinePreviewing=NO;
    _motionHasCursor=NO;
    if (_comparing && [self earlierIssueForIndex:index]<0) [self endChartComparison];
    _panelIndex=index;
    [self layoutChartWindow];
    if (_motionPlayer && _motionMovieURL && !_comparing)
        [self seekPopoverMovieFraction:[self motionFractionForDate:_sequenceTimes[index]]];
}

- (void)escapeFullscreen { [self closeChartWindow]; }

- (void)stepFullscreenPanel:(NSInteger)delta {
    _motionHasCursor = NO;
    if (_panelIndex < 0 || delta == 0) return;
    if (!_loopAdvancing) [self stopChartLoop];
    NSInteger n = _sequenceTimes.count;
    if (n < 1) return;
    NSInteger next = (_panelIndex + delta) % n;
    if (next < 0) next += n;
    [self focusFullscreenPanel:next];
}

- (void)stopChartLoop {
    _looping = NO;
    [_loopTimer invalidate];
    _loopTimer = nil;
    [_motionPlayer pause];
    if (!_popoverPlaying) [self cancelMotionPreparation];
}

- (void)toggleChartLoop {
    if (_panelIndex < 0) return;
    if (_looping) {
        [self stopChartLoop];
        [self layoutChartToolbarIn:_chartWindow.contentView height:42];
        [self updateTimelineHeading:[self selectedForecastDate]];
        [self updatePopoverPlayControl];
        return;
    }
    double fraction=[self activeTimeline].progress;
    [self stopPopoverPlayback];
    _motionPendingFraction=isfinite(fraction)?@(fraction):nil;
    [self endChartComparison];
    _looping = YES;
    [self prepareMotion];
    [self layoutChartToolbarIn:_chartWindow.contentView height:42];
    [self updatePopoverPlayControl];
}

- (void)loopTick {
    if (_panelIndex < 0 || !_looping || !_motionFrames.count) return;
    NSUInteger frame = [self motionFrameNow];
    NSInteger index = _motionStartIndex + (NSInteger)(frame / kMotionIntervals);
    _motionCursor = frame; _motionHasCursor = YES; _motionCursorFullscreen = YES;
    _panelIndex = index;
    PDFCropView *panel = (PDFCropView *)_singleScroll.documentView;
    panel.sequenceIndex = index;
    panel.mapDetails = [self mapDetailsAtTime:[self motionDateAtFrame:frame]];
    [panel setChartImage:_motionFrames[frame] comparison:nil alpha:0];
    NSDate *date = [self motionDateAtFrame:frame];
    _timeTitle.stringValue = [NSString stringWithFormat:@"%@ · %@", ForecastDay(date, _chartNow ?: NSDate.date, OwnerZone()), SituationClock(date, OwnerZone())];
    _timeTitle.toolTip = @"Frames interpolated between forecast maps";
}

- (void)flashCompareNote {
    if (!_chartWindow) return;
    if (!_compareNote) {
        _compareNote = [[NSTextField alloc] initWithFrame:NSZeroRect];
        _compareNote.editable = NO;
        _compareNote.selectable = NO;
        _compareNote.bezeled = NO;
        _compareNote.drawsBackground = YES;
        _compareNote.backgroundColor = Paper();
        _compareNote.textColor = Ink();
        _compareNote.alignment = NSTextAlignmentCenter;
        _compareNote.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
        _compareNote.accessibilityIdentifier = @"fullscreen.compareNote";
        _compareNote.stringValue = ChartNoEarlierIssue;
    }
    NSView *root = _chartWindow.contentView;
    CGFloat width = 280;
    CGFloat height = 24;
    _compareNote.frame = NSMakeRect((NSWidth(root.bounds) - width) / 2.0, 44, width, height);
    _compareNote.alphaValue = 1;
    [root addSubview:_compareNote];
    NSInteger token = ++_compareNoteToken;
    __weak Controller *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        Controller *strong = weak;
        if (!strong || strong->_compareNoteToken != token) return;
        [strong->_compareNote removeFromSuperview];
    });
}

- (void)toggleIssueCompare {
    if (_panelIndex < 0) return;
    [self dismissCompareNote];
    [self stopChartLoop];
    [self stopPopoverPlayback];
    [_scrubRenderer cancelRequests]; _scrubHasFraction=NO; _timelinePreviewing=NO;
    if (_comparing) {
        [self endChartComparison];
        [self layoutChartWindow];
        return;
    }
    if ([self earlierIssueForIndex:_panelIndex] < 0) {
        [self flashCompareNote];
        return;
    }
    _comparing = YES;
    [self layoutChartWindow];
}

- (void)zoomChart:(int)direction {
    if (_panelIndex < 0) return;
    if (direction == 0) _panelZoom = 1;
    else _panelZoom = MIN(4, MAX(1, _panelZoom + (direction > 0 ? 0.5 : -0.5)));
    [self layoutChartWindow];
}

- (void)closeChartWindow {
    [_chartTimeline finishPreviewAtCurrentTime];
    [self stopChartLoop];
    [self stopPopoverPlayback];
    [_scrubRenderer cancelRequests]; _scrubHasFraction=NO; _timelinePreviewing=NO;
    _expandedMap=NO; _motionCursorFullscreen=NO;
    [(PDFCropView *)_singleScroll.documentView removeMoviePlayer];
    _comparing = NO;
    [_compareNote removeFromSuperview];
    [_warningPop close];
    [_escapeHint removeFromSuperview];
    _escapeHintToken++;
    [_chartWindow orderOut:nil];
    if (!self.popover.shown) {
        [_clock invalidate];
        _clock = nil;
    }
}

- (void)placeEscapeHint {
    if (!_escapeHint || !_chartWindow) return;
    NSView *root = _chartWindow.contentView;
    NSString *text = @"Esc to close";
    NSFont *font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
    NSSize size = [text sizeWithAttributes:@{NSFontAttributeName: font}];
    CGFloat width = ceil(size.width) + 2;
    CGFloat height = ceil(size.height);
    CGFloat y = NSHeight(root.bounds) - height - 18;
    _escapeHint.frame = NSMakeRect(NSWidth(root.bounds) - width - 16, y, width, height);
}

- (void)armEscapeHint {
    NSView *root = _chartWindow.contentView;
    if (!_escapeHint) {
        _escapeHint = [EscapeHint new];
        _escapeHint.accessibilityIdentifier = @"fullscreen.escapeHint";
        _escapeHint.wantsLayer = YES;
    }
    _escapeHint.alphaValue = 1;
    [self placeEscapeHint];
    [root addSubview:_escapeHint];
    NSInteger token = ++_escapeHintToken;
    __weak Controller *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        Controller *strong = weak;
        if (!strong || strong->_escapeHintToken != token || !strong->_escapeHint.superview) return;
        NSView *hint = strong->_escapeHint;
        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
            context.duration = 0.4;
            hint.animator.alphaValue = 0;
        } completionHandler:^{
            if (strong->_escapeHintToken == token) [hint removeFromSuperview];
        }];
    });
}

- (void)presentChartWindowInFrame:(NSRect)frame {
    if (![self chartsReady]) return;
    NSDate *selected=[self selectedForecastDate];
    double fraction=[self motionFractionForDate:selected];
    BOOL playing=[self timelinePlaying];
    // AppKit may deliver the popover close notification after performClose:
    // returns. The destination owns playback throughout that transition.
    _expandedMap=YES;
    [self.popover performClose:nil];
    [_leftChart removeMoviePlayer];
    _comparing=NO;
    _panelIndex=MAX(0,[self nearestChartIndexToDate:selected]); _panelZoom=1;
    _popoverPlaying=NO; [_popoverLoopTimer invalidate]; _popoverLoopTimer=nil;
    _looping=playing;
    if (!_chartWindow) {
        FullscreenWindow *window=[[FullscreenWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.controller=self; window.delegate=self; window.releasedWhenClosed=NO;
        window.opaque=YES; window.hasShadow=NO; window.backgroundColor=Paper();
        window.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
        window.level=NSFloatingWindowLevel;
        window.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary;
        window.contentView=[[ChartRoot alloc] initWithFrame:NSMakeRect(0,0,frame.size.width,frame.size.height)];
        _chartWindow=window;
    }
    [_chartWindow setFrame:frame display:NO];
    [self layoutChartWindow];
    _motionCursorFullscreen=YES;
    if (_motionMovieURL) { _motionPendingFraction=@(fraction); [self startPreparedMotion]; }
    else {
        [self showStaticTimelineFraction:fraction];
        if (playing) [self prepareMotion];
    }
    [self ensureClock];
}

- (void)openChartWindow {
    [self openChartOnFrame:-1];
}

- (void)windowDidResize:(NSNotification *)note {
    if (note.object == _chartWindow) [self layoutChartWindow];
}

- (void)popoverDidShow:(NSNotification *)notification {
    if (notification.object != self.popover || _keyMonitor) return;
    [self beginPopoverEvolution];
    __weak Controller *weak = self;
    _keyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        Controller *strong = weak;
        if (!strong || !strong.popover.shown) return event;
        if (event.window != strong.popover.contentViewController.view.window) return event;
        if (([event.window.firstResponder isKindOfClass:AviationForecastView.class] ||
             [event.window.firstResponder isKindOfClass:RainForecastView.class] ||
             [event.window.firstResponder isKindOfClass:TimelineStrip.class]) &&
            (event.keyCode == 123 || event.keyCode == 124)) return event;
        if (event.keyCode == 49) { [strong togglePopoverPlayback:nil]; return nil; }
        if (event.keyCode == 53) { [strong escapePopover]; return nil; }
        if (event.keyCode == 123) { [strong stepPopoverPair:-1]; return nil; }
        if (event.keyCode == 124) { [strong stepPopoverPair:1]; return nil; }
        return event;
    }];
    if (_scrollMonitor) return;
    _scrollAccum = 0;
    _scrollMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event) {
        Controller *strong = weak;
        if (!strong || !strong.popover.shown) return event;
        if (event.window != strong.popover.contentViewController.view.window) return event;
        CGFloat dy = event.scrollingDeltaY;
        if (fabs(dy) < 0.01 && fabs(event.deltaY) < 0.01) return event;
        if (event.hasPreciseScrollingDeltas) {
            strong->_scrollAccum += dy;
            if (fabs(strong->_scrollAccum) < 48) return nil;
            dy = strong->_scrollAccum;
            strong->_scrollAccum = 0;
        }
        [strong stepPopoverPair:dy > 0 ? -1 : 1];
        return nil;
    }];
}

- (void)popoverWillClose:(NSNotification *)notification {
    if (notification.object != self.popover) return;
    if (!_expandedMap) [self stopPopoverPlayback];
    _popoverClosedAt = [NSDate timeIntervalSinceReferenceDate];
    if (!_expandedMap) { _forecastMode=-1; _pairPinned=NO; _previewIndex=-1; }
    _scrollAccum=0;
    if (_keyMonitor) {
        [NSEvent removeMonitor:_keyMonitor];
        _keyMonitor = nil;
    }
    if (_scrollMonitor) {
        [NSEvent removeMonitor:_scrollMonitor];
        _scrollMonitor = nil;
    }
}

- (void)togglePopover:(id)sender {
    (void)sender;
    if (_chartWindow.isVisible) {
        [self closeChartWindow];
        return;
    }
    if (self.popover.shown) {
        [self.popover performClose:nil];
        if (!_chartWindow.isVisible) {
            [_clock invalidate];
            _clock = nil;
        }
        return;
    }
    // A transient popover closes on the mouse-down outside it, then the status
    // item's action fires on mouse-up and would open it again.
    if ([NSDate timeIntervalSinceReferenceDate] - _popoverClosedAt < 0.35) return;
    if (!_lastFetch || -_lastFetch.timeIntervalSinceNow > kRefreshInterval) [self refreshAll];
    [self rebuildContent];
    NSButton *button = _item.button;
    [self.popover showRelativeToRect:button.bounds ofView:button preferredEdge:NSMinYEdge];
    [self ensureClock];
}

- (void)applicationDidResignActive:(NSNotification *)note {
    (void)note;
    [_warningPop close];
    if (self.popover.shown) [self.popover performClose:nil];
    if (_chartWindow.isVisible) [self closeChartWindow];
}

- (BOOL)modelChartsReady { return _ownRun.hours > 0 && _frameIndices.count > 0; }

- (BOOL)chartsReady {
    if (_sourceECMWF) return [self modelChartsReady];
    return _pdfDoc && CGPDFDocumentGetNumberOfPages(_pdfDoc) > 0;
}

- (NSString *)chartFreshnessAt:(NSDate *)now {
    if (_sourceECMWF) {
        if (!_runDate) return @"Chart unavailable";
        NSString *line = StoreRunStatusLine(_runDate, now);
        return StoreRunIsStale(_runDate, now, _storeStatusOK) ? [line stringByAppendingString:@" · stale"] : line;
    }
    // The local Bureau PDF has no issue metadata. Its timestamp cannot be
    // inferred from the separately published ECMWF model cycle.
    return [self chartsReady] ? @"Bureau chart" : @"Chart unavailable";
}

- (NSInteger)hourForSequenceIndex:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_frameIndices.count) return -1;
    return _frameIndices[index].integerValue;
}

- (NSInteger)hourInRun:(OwnRun *)run matching:(NSDate *)valid {
    if (!run || !valid) return -1;
    NSInteger best = -1;
    NSTimeInterval bestDelta = 91 * 60;
    for (NSInteger i = 0; i < run.hours; i++) {
        NSDate *when = [run timeAtIndex:i];
        if (!when) continue;
        NSTimeInterval delta = fabs([when timeIntervalSinceDate:valid]);
        if (delta < bestDelta) { bestDelta = delta; best = i; }
    }
    return bestDelta <= 90 * 60 ? best : -1;
}

- (NSInteger)earlierIssueForIndex:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_sequenceTimes.count) return -1;
    if (_sourceECMWF) return [self hourInRun:_previousRun matching:_sequenceTimes[index]];
    if (!_previousDoc) return -1;
    return [self previousPrognosisPanelForSequenceIndex:index];
}

- (NSString *)coastPath {
    NSString *env = NSProcessInfo.processInfo.environment[@"ISOBAR_COAST"];
    if (env.length) return env.stringByExpandingTildeInPath;
    NSString *bundled = [NSBundle.mainBundle pathForResource:@"ownchart-coast" ofType:@"bin"];
    if (bundled.length) return bundled;
    return @"Resources/ownchart-coast.bin";
}

- (NSString *)defaultStoreRoot {
    NSString *env = NSProcessInfo.processInfo.environment[@"ISOBAR_STORE"];
    if (env.length) return env.stringByExpandingTildeInPath;
    NSString *legacy=[@"~/Data/isobar" stringByExpandingTildeInPath];
    if ([NSFileManager.defaultManager fileExistsAtPath:[legacy stringByAppendingPathComponent:@"status.json"]]) return legacy;
    return [@"~/Library/Application Support/Isobar/Weather" stringByExpandingTildeInPath];
}

- (BOOL)indexShowsModelRain:(NSInteger)index {
    if (!_sourceECMWF || !_rainLayer || index < 0 || index >= (NSInteger)_sequenceTimes.count) return NO;
    return [_ownRun hasRainAtIndex:[self hourForSequenceIndex:index]];
}

- (BOOL)chartKeyModelRainInWindow:(BOOL)window {
    if (!_sourceECMWF || _sequenceTimes.count < 1) return NO;
    if (window) {
        if (_panelIndex >= 0) return [self indexShowsModelRain:_panelIndex];
        NSInteger n = MIN((NSInteger)_sequenceTimes.count, (NSInteger)9);
        for (NSInteger i = 0; i < n; i++) if ([self indexShowsModelRain:i]) return YES;
        return NO;
    }
    NSInteger left = _pair.valid ? _pair.left : 0;
    NSInteger right = (_pair.valid && _pair.right != left) ? _pair.right : -1;
    return [self indexShowsModelRain:left] || (right >= 0 && [self indexShowsModelRain:right]);
}

- (BOOL)chartKeyObservedInWindow:(BOOL)window {
    (void)window;
    return NO;
}

- (NSView *)makeChartKeyMaxWidth:(CGFloat)maxWidth window:(BOOL)window {
    if (!_sourceECMWF || maxWidth < 96) return nil;
    BOOL rain = [self chartKeyModelRainInWindow:window];
    BOOL observed = [self chartKeyObservedInWindow:window];
    if (_tempLayer <= 0 && !rain && !observed) return nil;
    ChartKeyView *key = [ChartKeyView new];
    key.temperature = _tempLayer;
    key.showsRain = rain;
    key.showsObserved = observed;
    key.maxWidth = maxWidth;
    [key rebuild];
    return NSWidth(key.frame) >= 24 ? key : nil;
}

- (NSString *)chartImageKeyForIndex:(NSInteger)index bare:(BOOL)bare comparison:(BOOL)comparison {
    OwnRun *run = comparison ? _previousRun : _ownRun;
    if (!run || index < 0 || index >= (NSInteger)_sequenceTimes.count) return nil;
    NSInteger hour = comparison ? [self hourInRun:run matching:_sequenceTimes[index]] : [self hourForSequenceIndex:index];
    if (hour < 0) return nil;
    BOOL observed = NO;
    NSString *title = bare ? @"" : [self ecmwfPanelTitleForIndex:index];
    return [NSString stringWithFormat:@"%@:%ld:%ld:%d:%d:%d:%d:%@",
        comparison ? (_previousRunDate.description ?: @"p") : (_runDate.description ?: @"c"),
        (long)hour, (long)_tempLayer, _barbs, bare, observed, _rainLayer, title];
}

- (NSImage *)ecmwfImageForIndex:(NSInteger)index bare:(BOOL)bare comparison:(BOOL)comparison {
    NSString *key=[self chartImageKeyForIndex:index bare:bare comparison:comparison];
    if (!key) return nil;
    NSImage *cached = _chartCache[key];
    if (cached) return cached;
    OwnRun *run=comparison?_previousRun:_ownRun;
    NSInteger hour=comparison?[self hourInRun:run matching:_sequenceTimes[index]]:[self hourForSequenceIndex:index];
    BOOL observed=NO;
    NSString *title=bare?@"":[self ecmwfPanelTitleForIndex:index];
    OwnLayerOptions layers = {0};
    layers.temperature = (int)_tempLayer;
    layers.barbs = _barbs ? 1 : 0;
    layers.rain = _rainLayer && !observed;
    layers.observed = _rainLayer && observed;
    layers.bare = bare ? 1 : 0;
    NSImage *image = OwnRunRender(run, hour, title, layers, observed ? _rainDots : nil, 2);
    if (image) _chartCache[key] = image;
    return image;
}

- (void)prepareChartImages {
    [_chartPreparationQueue cancelAllOperations];
    NSUInteger generation=++_chartPreparationGeneration;
    if (!_sourceECMWF || !_ownRun) return;
    if (!_chartPreparationQueue) {
        _chartPreparationQueue=[NSOperationQueue new];
        _chartPreparationQueue.maxConcurrentOperationCount=1;
        _chartPreparationQueue.qualityOfService=NSQualityOfServiceUtility;
    }
    // Snapshot on the UI thread; render the bounded next maps on one worker.
    // Publication is serial on the UI thread and rejects superseded runs/layers.
    OwnRun *run=_ownRun;
    NSArray *dots=[_rainDots copy];
    __weak Controller *weak=self;
    for (NSInteger i = 0; i < (NSInteger)_sequenceTimes.count; i++) {
        for (NSNumber *bareNumber in @[@YES,@NO]) {
            BOOL bare=bareNumber.boolValue;
            NSString *key=[self chartImageKeyForIndex:i bare:bare comparison:NO];
            if (!key || _chartCache[key]) continue;
            NSInteger hour=[self hourForSequenceIndex:i];
            NSString *title=bare?@"":[self ecmwfPanelTitleForIndex:i];
            BOOL observed=NO;
            OwnLayerOptions layers={0}; layers.temperature=(int)_tempLayer; layers.barbs=_barbs;
            layers.rain=_rainLayer && !observed; layers.observed=_rainLayer && observed; layers.bare=bare;
            NSBlockOperation *operation=[NSBlockOperation new];
            __weak NSBlockOperation *weakOperation=operation;
            [operation addExecutionBlock:^{
                @autoreleasepool {
                    if (weakOperation.cancelled) return;
                    NSImage *image=OwnRunRender(run,hour,title,layers,observed?dots:nil,2);
                    if (!image || weakOperation.cancelled) return;
                    // Materialize its bitmap here rather than at first display.
                    (void)[image CGImageForProposedRect:NULL context:nil hints:nil];
                    dispatch_async(dispatch_get_main_queue(),^{
                        Controller *strong=weak;
                        if (strong && generation==strong->_chartPreparationGeneration && strong->_ownRun==run && !strong->_chartCache[key])
                            strong->_chartCache[key]=image;
                    });
                }
            }];
            [_chartPreparationQueue addOperation:operation];
        }
    }
}

- (void)assignChart:(PDFCropView *)panel index:(NSInteger)index bare:(BOOL)bare compare:(BOOL)compare {
    panel.mapDetails = [self mapDetailsAtTime:index>=0 && index<(NSInteger)_sequenceTimes.count ? _sequenceTimes[index] : nil];
    if (_sourceECMWF) {
        NSImage *image = [self ecmwfImageForIndex:index bare:bare comparison:NO];
        NSImage *other = (compare && _comparing) ? [self ecmwfImageForIndex:index bare:bare comparison:YES] : nil;
        [panel setChartImage:image comparison:other alpha:other ? 0.5 : 0];
        [panel setPins:nil];
        return;
    }
    CGRect crop = CGRectZero;
    NSArray *pins = nil;
    CGPDFDocumentRef doc = bare ? [self documentForPopoverIndex:index crop:&crop pins:&pins]
        : [self documentForSequenceIndex:index crop:&crop pins:&pins];
    [panel setDocument:doc crop:crop];
    [panel setPins:pins];
    if (compare) [self applyComparisonToPanel:panel index:index bare:bare];
    else [panel setComparisonDocument:NULL crop:CGRectZero alpha:0];
}

- (void)chooseTemperatureLayer:(NSButton *)sender {
    if (sender.tag >= 0 && sender.tag <= 2) [self selectChartLayer:sender.tag];
}

- (void)toggleBarbs:(id)sender {
    (void)sender;
    [self selectChartLayer:3];
}

- (void)toggleKiteSpots:(NSButton *)sender {
    _kiteSpots = sender.state == NSControlStateValueOn;
    [NSUserDefaults.standardUserDefaults setBool:_kiteSpots forKey:@"kiteSpots"];
    if (self.popover.shown) [self rebuildContent];
    if (_expandedMap) [self layoutChartWindow];
}

- (void)toggleGlanceBarbs:(NSButton *)sender {
    _glanceBarbs = sender.state == NSControlStateValueOn;
    [NSUserDefaults.standardUserDefaults setBool:_glanceBarbs forKey:@"glanceBarbs"];
    if (self.popover.shown) [self rebuildContent];
    if (_expandedMap) [self layoutChartWindow];
}

- (NSInteger)nearestChartIndexToDate:(NSDate *)date {
    NSInteger nearest = -1;
    NSTimeInterval distance = DBL_MAX;
    for (NSInteger i = 0; date && i < (NSInteger)_sequenceTimes.count; i++) {
        NSTimeInterval delta = fabs([_sequenceTimes[i] timeIntervalSinceDate:date]);
        if (delta < distance) { nearest = i; distance = delta; }
    }
    return nearest;
}

- (void)toggleChartSource {
    [self invalidateMotion];
    if (_sourceECMWF ? !_pdfDoc : ![self modelChartsReady]) return;
    [self ensurePair];
    NSDate *left = _pair.valid ? _sequenceTimes[_pair.left] : nil;
    NSDate *right = _pair.valid ? _sequenceTimes[_pair.right] : nil;
    NSDate *focus = _panelIndex >= 0 && _panelIndex < (NSInteger)_sequenceTimes.count ? _sequenceTimes[_panelIndex] : nil;
    [self stopChartLoop];
    _sourceECMWF = !_sourceECMWF;
    [[self chartPreferences] setObject:(_sourceECMWF ? @"ecmwf" : @"bom") forKey:@"chartSource"];
    _comparing = NO;
    _pairPinned = NO;
    [_chartCache removeAllObjects];
    [self rebuildSequence];
    NSInteger leftIndex = [self nearestChartIndexToDate:left];
    NSInteger rightIndex = [self nearestChartIndexToDate:right];
    if (leftIndex >= 0 && rightIndex >= 0 && rightIndex <= leftIndex && _sequenceTimes.count >= 2) {
        leftIndex = MIN(leftIndex, (NSInteger)_sequenceTimes.count - 2);
        rightIndex = leftIndex + 1;
    }
    if (leftIndex >= 0 && rightIndex > leftIndex) {
        _pair = (ChartPair){leftIndex, rightIndex, YES};
        _pairPinned = YES;
    }
    if (focus) _panelIndex = [self nearestChartIndexToDate:focus];
    if (self.popover.shown) [self rebuildContent];
    if (_expandedMap) [self layoutChartWindow];
    [self prepareChartImages];
}

- (void)replaceLocations:(NSArray *)locations {
    if (!locations.count) return;
    _locations = [locations copy];
    [_mapDetailCache removeAllObjects];
    [_weather removeAllObjects];
}

- (void)reloadStoreAtPath:(NSString *)root {
    BOOL resumeEvolution = (_expandedMap && _looping) ||
        ((_popoverPlaying || _evolutionOnOpenPending) && self.popover.shown);
    NSArray *cachedFrames = _frameIndices;
    NSString *cachedRoot = _storeRoot;
    if (!root.length) root = [self defaultStoreRoot];
    _storeRoot = root.stringByExpandingTildeInPath;
    NSDate *cachedRun = _runDate;
    NSDate *cachedPrevious = _previousRunDate;
    NSArray *cachedRain = _rainDots;
    _ownRun = nil;
    _previousRun = nil;
    _frameIndices = @[];
    _runDate = nil;
    _storeStatusOK = NO;
    _previousRunDate = nil;
    _rainDots = @[];
    NSFileManager *fm = NSFileManager.defaultManager;
    NSData *statusData = [NSData dataWithContentsOfFile:[_storeRoot stringByAppendingPathComponent:StoreStatusRelative()]];
    _storeStatusOK = StoreStatusOK(statusData);
    _publishedGrid = [fm fileExistsAtPath:[_storeRoot stringByAppendingPathComponent:@"products/grids/ecmwf_ifs025/current.json"]];
    _publishedStore = _publishedGrid ||
        [fm fileExistsAtPath:[_storeRoot stringByAppendingPathComponent:@"products/points/ecmwf_ifs/current.json"]];
    _storeError = nil;
    NSDate *now = _chartNow ?: NSDate.date;
    _offline = NO;
    if (_publishedGrid) {
        NSString *error = nil;
        _ownRun = OwnRunLoadPublished(_storeRoot, NO, [self coastPath], &error);
        _storeError = error;
        _previousRun = OwnRunLoadPublished(_storeRoot, YES, [self coastPath], nil);
        _previousRunDate = _previousRun.runDate;
        NSMutableArray *times = [NSMutableArray array];
        for (NSInteger i = 0; i < _ownRun.hours; i++) [times addObject:[_ownRun timeAtIndex:i]];
        _frameIndices = StoreFrameIndices(times, now) ?: @[];
        if (_ownRun && _frameIndices.count) _runDate = _ownRun.runDate;
        _issued = _ownRun.generated ?: _runDate;
    } else {
        NSData *latestData = [NSData dataWithContentsOfFile:[_storeRoot stringByAppendingPathComponent:StoreECMWFLatestRelative()]];
        NSString *runPath = StoreLatestRunPath(latestData);
        NSString *runDir = runPath.length ? [[_storeRoot stringByAppendingPathComponent:@"ecmwf"] stringByAppendingPathComponent:runPath] : nil;
        NSDictionary *manifest = StoreManifestFromJSON([NSData dataWithContentsOfFile:[runDir stringByAppendingPathComponent:@"manifest.json"]]);
        NSDate *candidateRun = [manifest[@"run"] isKindOfClass:NSDate.class] ? manifest[@"run"] : nil;
        if (runDir.length && candidateRun) {
            NSString *error = nil;
            _ownRun = OwnRunLoad(runDir, [self coastPath], &error);
            _storeError = error;
            NSArray *times = [manifest[@"times"] isKindOfClass:NSArray.class] ? manifest[@"times"] : @[];
            _frameIndices = _ownRun ? (StoreFrameIndices(times, now) ?: @[]) : @[];
            if (_ownRun && _frameIndices.count) _runDate = candidateRun;
        }
        _issued = _runDate && [manifest[@"generated"] isKindOfClass:NSDate.class] ? manifest[@"generated"] : _runDate;
        NSString *ecmwfRoot = [_storeRoot stringByAppendingPathComponent:@"ecmwf"];
        NSMutableArray *runIDs = [NSMutableArray array];
        for (NSString *name in [fm contentsOfDirectoryAtPath:ecmwfRoot error:nil]) {
            BOOL dir = NO;
            if ([fm fileExistsAtPath:[ecmwfRoot stringByAppendingPathComponent:name] isDirectory:&dir] && dir) [runIDs addObject:name];
        }
        NSString *previousID = StorePreviousRunID(runIDs, runPath);
        if (previousID.length) {
            NSString *prevDir = [ecmwfRoot stringByAppendingPathComponent:previousID];
            NSDictionary *prevManifest = StoreManifestFromJSON([NSData dataWithContentsOfFile:[prevDir stringByAppendingPathComponent:@"manifest.json"]]);
            _previousRunDate = [prevManifest[@"run"] isKindOfClass:NSDate.class] ? prevManifest[@"run"] : nil;
            _previousRun = OwnRunLoad(prevDir, [self coastPath], nil);
        }
    }
    BOOL keepMotion = _sourceECMWF && cachedRun && [cachedRun isEqual:_runDate] &&
        [cachedFrames isEqual:_frameIndices] && [cachedRoot isEqual:_storeRoot];
    // Re-reading the same immutable model run must not cancel a long encode,
    // restart the moving map, or discard an inspected hour every five minutes.
    if (!keepMotion) [self invalidateMotion];
    _dataStale = StoreRunIsStale(_runDate, now, _storeStatusOK);
    _statusLabel = _runDate ? StoreRunStatusLine(_runDate, now) : (_storeError ?: @"Chart unavailable");
    if (_runDate && _dataStale) _statusLabel = [_statusLabel stringByAppendingString:@" · stale"];
    NSData *pdf = [NSData dataWithContentsOfFile:ArchiveChartPath(_storeRoot, NO)];
    if (IsPDF(pdf)) [self noteChartImage:nil pdf:pdf issued:_issued offline:NO];
    else { _chartPDF = nil; if (_pdfDoc) { CGPDFDocumentRelease(_pdfDoc); _pdfDoc = NULL; } }
    NSData *previousPDF = [NSData dataWithContentsOfFile:ArchiveChartPath(_storeRoot, YES)];
    if (IsPDF(previousPDF)) [self notePreviousPrognosis:previousPDF issued:nil];
    else { _previousPDF = nil; _previousIssued = nil; _previousTimes = @[]; if (_previousDoc) { CGPDFDocumentRelease(_previousDoc); _previousDoc = NULL; } }
    NSString *obsDir = [_storeRoot stringByAppendingPathComponent:@"products/obs"];
    NSMutableArray *dots = [NSMutableArray array];
    NSMutableDictionary *obsByWMO = [NSMutableDictionary dictionary];
    NSMutableDictionary *histByWMO = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSData *> *observationFiles = [NSMutableDictionary dictionary];
    if (_publishedStore) [observationFiles addEntriesFromDictionary:ArchiveObservationFilesAtDate(_storeRoot, now) ?: @{}];
    else for (NSString *name in [fm contentsOfDirectoryAtPath:obsDir error:nil]) {
        if (![name.pathExtension.lowercaseString isEqual:@"json"]) continue;
        NSData *body = [NSData dataWithContentsOfFile:[obsDir stringByAppendingPathComponent:name]];
        if (body) observationFiles[name.stringByDeletingPathExtension] = body;
    }
    for (NSString *wmo in [observationFiles.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        NSData *body = observationFiles[wmo];
        NSDictionary *obs = ParseLatestObservation(body);
        NSDictionary *dot = StoreRainObservation(body);
        NSDate *observed = [obs[@"time"] isKindOfClass:NSDate.class] ? obs[@"time"] : nil;
        if ([dot[@"mm"] doubleValue] >= 1 && observed && [now timeIntervalSinceDate:observed] < 2 * 3600) [dots addObject:dot];
        if (obs) obsByWMO[wmo] = obs;
        NSArray *history = ObservationHistory(body);
        if (history.count) histByWMO[wmo] = history;
    }
    _rainDots = dots;
    NSDictionary *kite = StoreKiteFile(_publishedStore ? ArchiveKiteFile(_storeRoot) : [NSData dataWithContentsOfFile:[_storeRoot stringByAppendingPathComponent:StoreKiteRelative()]]);
    if (kite) {
        _kiteMin = [kite[@"minKt"] doubleValue];
        _kiteMax = [kite[@"maxKt"] doubleValue];
        _kiteList = [kite[@"spots"] isKindOfClass:NSArray.class] ? kite[@"spots"] : @[];
    } else {
        _kiteList = @[];
    }
    if (!getenv("ISOBAR_FIXTURES")) {
        NSUserDefaults *kiteDefaults = NSUserDefaults.standardUserDefaults;
        if ([kiteDefaults objectForKey:@"kiteMinKt"]) _kiteMin = [kiteDefaults doubleForKey:@"kiteMinKt"];
        if ([kiteDefaults objectForKey:@"kiteMaxKt"]) _kiteMax = [kiteDefaults doubleForKey:@"kiteMaxKt"];
    }
    NSMutableArray *warnings = [NSMutableArray array];
    NSString *warnDir = ArchiveWarningDirectory(_storeRoot);
    for (NSString *name in [fm contentsOfDirectoryAtPath:warnDir error:nil]) {
        if (![name.pathExtension.lowercaseString isEqual:@"xml"]) continue;
        NSData *body = [NSData dataWithContentsOfFile:[warnDir stringByAppendingPathComponent:name]];
        for (NSDictionary *warning in ParseWarningXML(body)) {
            NSDate *expires = [warning[@"expires"] isKindOfClass:NSDate.class] ? warning[@"expires"] : nil;
            if (expires && [expires compare:now] != NSOrderedDescending) continue;
            if ([warning[@"issue"] isKindOfClass:NSDate.class] && [warning[@"state"] length]) {
                NSMutableDictionary *regional = [warning mutableCopy];
                regional[@"shortTitle"] = [NSString stringWithFormat:@"%@ · %@", warning[@"state"], warning[@"shortTitle"] ?: warning[@"title"]];
                [warnings addObject:regional];
            } else [warnings addObject:warning];
        }
    }
    // This is a complete disk snapshot, not a partial network callback. Dropped
    // or unreadable files must not leave readings from the last snapshot alive.
    [_mapDetailCache removeAllObjects];
    [_weather removeAllObjects];
    for (NSDictionary *place in GlancePlaces([self shownLocations], _kiteList, YES)) {
        NSString *hash = place[@"geohash"];
        NSString *wmo = [place[@"stationWMO"] description];
        NSDictionary *obs = wmo.length ? obsByWMO[wmo] : nil;
        NSArray *history = wmo.length ? histByWMO[wmo] : @[];
        if (obs && ![obs[@"pressMsl"] isKindOfClass:NSNumber.class]) {
            NSDictionary *nearest = nil;
            double closest = 40;
            for (NSDictionary *candidate in obsByWMO.allValues) {
                if (![candidate[@"pressMsl"] isKindOfClass:NSNumber.class] ||
                    ![candidate[@"lat"] isKindOfClass:NSNumber.class] || ![candidate[@"lon"] isKindOfClass:NSNumber.class]) continue;
                if (fabs([candidate[@"time"] timeIntervalSinceDate:obs[@"time"]]) > 45 * 60) continue;
                double distance = HaversineKm([place[@"latitude"] doubleValue], [place[@"longitude"] doubleValue],
                    [candidate[@"lat"] doubleValue], [candidate[@"lon"] doubleValue]);
                if (distance < closest) { nearest = candidate; closest = distance; }
            }
            if (nearest) {
                obs = ObservationWithPressure(obs, nearest);
                history = ObservationHistoryWithPressure(history, histByWMO[nearest[@"wmo"]]);
            }
        }
        NSString *pointRel = StorePointRelative(hash);
        NSData *point = _publishedStore ? ArchivePointFile(_storeRoot, place) : (pointRel.length ? [NSData dataWithContentsOfFile:[_storeRoot stringByAppendingPathComponent:pointRel]] : nil);
        NSArray *series = StorePointSeries(point);
        NSArray *hourly = StorePointHours(point, now, 24);
        NSString *state = [place[@"state"] isKindOfClass:NSString.class] ? place[@"state"] : @"";
        NSMutableArray *mine = [NSMutableArray array];
        for (NSDictionary *warning in warnings) {
            NSString *where = [warning[@"state"] isKindOfClass:NSString.class] ? warning[@"state"] : @"";
            if (where.length && state.length && [where caseInsensitiveCompare:state] != NSOrderedSame) continue;
            [mine addObject:warning];
        }
        [self noteWeatherForGeohash:hash obs:obs daily:nil hourly:hourly.count ? hourly : nil warnings:mine];
        [self noteGlanceForGeohash:hash history:history series:series];
        [_weather[hash] removeObjectForKey:@"marine"];
        NSDictionary *pointInfo = point ? [NSJSONSerialization JSONObjectWithData:point options:0 error:nil] : nil;
        if ([pointInfo isKindOfClass:NSDictionary.class] && _weather[hash]) _weather[hash][@"pointSource"] = pointInfo[@"_archive"] ?: @{};
    }
    for (NSDictionary *spot in _kiteList) {
        NSDictionary *marine = _publishedStore ? ArchiveMarineProduct(_storeRoot, spot[@"archiveID"]) : nil;
        if (marine && _weather[spot[@"geohash"]]) _weather[spot[@"geohash"]][@"marine"] = marine;
    }
    _aviation = nil;
    _airportSeries = @[];
    if (_publishedStore) {
        NSDictionary *field = [self homeAerodrome];
        _aviation=ArchiveAviationProduct(_storeRoot,[NSString stringWithFormat:@"%@.json",field[@"code"]]);
        _airportSeries = StorePointSeries(ArchivePointFile(_storeRoot, field));
    }
    _notams=ArchiveAviationProduct(_storeRoot,@"notams.json");
    _sigmets=ArchiveAviationProduct(_storeRoot,@"sigmet.json");
    if (_noticesWindow.visible) {
        _noticesView.timeZone=[self aviationTimeZone];
        _noticesView.notams=_notams ?: @{}; _noticesView.sigmets=_sigmets ?: @{}; [_noticesView reload];
    }
    if (_atmosphereWindow.visible) {
        _atmosphereView.product=ArchiveAtmosphereProduct(_storeRoot,[self homeAerodrome][@"code"]);
        _atmosphereView.now=_chartNow ?: NSDate.date;
    }
    _lastFetch = NSDate.date;
    [self rebuildSequence];
    if (!_publishedGrid || ![cachedRun isEqual:_runDate] ||
        !((!cachedPrevious && !_previousRunDate) || [cachedPrevious isEqual:_previousRunDate]) ||
        ![cachedRain isEqual:_rainDots]) [_chartCache removeAllObjects];
    [self updateBar];
    if (self.popover.shown) [self rebuildContent];
    if (_expandedMap) [self layoutChartWindow];
    if (resumeEvolution && !keepMotion) [self resetPopoverToNow];
}

- (void)refreshAll {
    [_collector refresh];
    [self reloadStoreAtPath:_storeRoot];
    [self prepareChartImages];
}

- (void)saveLocations {
    [NSUserDefaults.standardUserDefaults setObject:ArchiveLocations(_locations) forKey:@"locations"];
}

- (void)openSettings:(id)sender {
    (void)sender;
    if (_settingsWindow) {
        [_locationsTable reloadData];
        [_settingsWindow makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        return;
    }
    _settingsWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 440, 720)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    _settingsWindow.title = @"Settings";
    FlippedView *root = [[FlippedView alloc] initWithFrame:NSMakeRect(0, 0, 440, 720)];
    [root addSubview:[self label:@"Places" font:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(16, 16, 200, 16)]];
    NSScrollView *listScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(16, 36, 300, 160)];
    listScroll.hasVerticalScroller = YES;
    _locationsTable = [[NSTableView alloc] initWithFrame:listScroll.bounds];
    NSTableColumn *locCol = [[NSTableColumn alloc] initWithIdentifier:@"location"];
    locCol.width = 280;
    [_locationsTable addTableColumn:locCol];
    _locationsTable.headerView = nil;
    _locationsTable.dataSource = self;
    _locationsTable.delegate = self;
    listScroll.documentView = _locationsTable;
    [root addSubview:listScroll];
    NSButton *up = [NSButton buttonWithTitle:@"Up" target:self action:@selector(moveLocationUp:)];
    up.frame = NSMakeRect(328, 36, 96, 26);
    NSButton *down = [NSButton buttonWithTitle:@"Down" target:self action:@selector(moveLocationDown:)];
    down.frame = NSMakeRect(328, 68, 96, 26);
    NSButton *remove = [NSButton buttonWithTitle:@"Remove" target:self action:@selector(removeLocation:)];
    remove.frame = NSMakeRect(328, 100, 96, 26);
    [root addSubview:up];
    [root addSubview:down];
    [root addSubview:remove];

    [root addSubview:[self label:@"Add a place" font:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(16, 210, 200, 16)]];
    _searchField = [NSTextField textFieldWithString:@""];
    _searchField.placeholderString = @"Search places";
    _searchField.frame = NSMakeRect(16, 232, 300, 24);
    _searchField.target = self;
    _searchField.action = @selector(searchLocations:);
    [root addSubview:_searchField];
    NSButton *go = [NSButton buttonWithTitle:@"Search" target:self action:@selector(searchLocations:)];
    go.frame = NSMakeRect(328, 230, 96, 26);
    [root addSubview:go];
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(16, 268, 408, 140)];
    scroll.hasVerticalScroller = YES;
    _searchTable = [[NSTableView alloc] initWithFrame:scroll.bounds];
    NSTableColumn *col = [[NSTableColumn alloc] initWithIdentifier:@"place"];
    col.width = 390;
    [_searchTable addTableColumn:col];
    _searchTable.headerView = nil;
    _searchTable.dataSource = self;
    _searchTable.delegate = self;
    _searchTable.target = self;
    _searchTable.doubleAction = @selector(addLocation:);
    scroll.documentView = _searchTable;
    [root addSubview:scroll];
    NSButton *add = [NSButton buttonWithTitle:@"Add selected place" target:self action:@selector(addLocation:)];
    add.frame = NSMakeRect(16, 418, 180, 28);
    [root addSubview:add];
    CGFloat spotY = 456;
    [root addSubview:[self label:@"Kite spots" font:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(16, spotY, 200, 16)]];
    spotY += 22;
    if (!_kiteList.count) {
        [root addSubview:[self label:@"No kite spots in the forecast." font:[NSFont systemFontOfSize:13]
            color:NSColor.secondaryLabelColor frame:NSMakeRect(16, spotY, 400, 18)]];
        spotY += 22;
    }
    for (NSDictionary *spot in _kiteList) {
        NSString *name = [spot[@"name"] isKindOfClass:NSString.class] ? spot[@"name"] : @"Spot";
        NSString *facing = [spot[@"shoreNormal"] isKindOfClass:NSNumber.class]
            ? ShoreFacingName([spot[@"shoreNormal"] doubleValue]) : @"";
        NSString *line = facing.length
            ? [NSString stringWithFormat:@"%@, shore faces %@", name, facing]
            : name;
        [root addSubview:[self label:line font:[NSFont systemFontOfSize:13] color:NSColor.labelColor
            frame:NSMakeRect(16, spotY, 400, 18)]];
        spotY += 20;
    }
    spotY += 8;
    [root addSubview:[self label:@"Kiteable wind" font:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(16, spotY, 200, 16)]];
    spotY += 22;
    _kiteMinField = [NSTextField textFieldWithString:[NSString stringWithFormat:@"%.0f", _kiteMin]];
    _kiteMinField.frame = NSMakeRect(16, spotY, 52, 24);
    _kiteMinField.delegate = self;
    _kiteMinField.alignment = NSTextAlignmentCenter;
    [root addSubview:_kiteMinField];
    [root addSubview:[self label:@"to" font:[NSFont systemFontOfSize:13] color:NSColor.secondaryLabelColor
        frame:NSMakeRect(74, spotY + 3, 20, 18)]];
    _kiteMaxField = [NSTextField textFieldWithString:[NSString stringWithFormat:@"%.0f", _kiteMax]];
    _kiteMaxField.frame = NSMakeRect(98, spotY, 52, 24);
    _kiteMaxField.delegate = self;
    _kiteMaxField.alignment = NSTextAlignmentCenter;
    [root addSubview:_kiteMaxField];
    [root addSubview:[self label:@"kt, and not blowing offshore" font:[NSFont systemFontOfSize:13]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(158, spotY + 3, 250, 18)]];
    spotY += 36;
    [root addSubview:[self label:@"Home aerodrome" font:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]
        color:NSColor.secondaryLabelColor frame:NSMakeRect(16, spotY, 200, 16)]];
    spotY += 22;
    _aerodromePopup = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(16, spotY, 260, 26) pullsDown:NO];
    NSString *selectedCode = [self homeAerodrome][@"code"] ?: @"YPPH";
    for (NSDictionary *field in KnownAerodromes()) {
        NSString *title = [NSString stringWithFormat:@"%@ (%@)", field[@"name"], field[@"code"]];
        [_aerodromePopup addItemWithTitle:title];
        _aerodromePopup.lastItem.representedObject = field[@"code"];
        if ([field[@"code"] isEqual:selectedCode]) [_aerodromePopup selectItem:_aerodromePopup.lastItem];
    }
    _aerodromePopup.target = self;
    _aerodromePopup.action = @selector(chooseAerodrome:);
    [root addSubview:_aerodromePopup];
    spotY += 40;
    _loginToggle = [NSButton checkboxWithTitle:@"Open Isobar when I log in" target:self action:@selector(toggleLaunch:)];
    _loginToggle.frame = NSMakeRect(16, spotY, 280, 20);
    SMAppServiceStatus status = SMAppService.mainAppService.status;
    _loginToggle.state = status == SMAppServiceStatusEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    _loginToggle.allowsMixedState = YES;
    if (status == SMAppServiceStatusRequiresApproval) _loginToggle.state = NSControlStateValueMixed;
    [root addSubview:_loginToggle];
    CGFloat windowH = spotY + 36;
    root.frame = NSMakeRect(0, 0, 440, windowH);
    [_settingsWindow setContentSize:NSMakeSize(440, windowH)];
    _settingsWindow.contentView = root;
    [_settingsWindow center];
    [_settingsWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)kiteThresholdChanged:(id)sender {
    (void)sender;
    double minV = _kiteMinField.doubleValue;
    double maxV = _kiteMaxField.doubleValue;
    if (minV < 5 || minV > 40) minV = 15;
    if (maxV <= minV || maxV > 60) maxV = MAX(minV + 5, 30);
    _kiteMin = minV;
    _kiteMax = maxV;
    _kiteMinField.stringValue = [NSString stringWithFormat:@"%.0f", minV];
    _kiteMaxField.stringValue = [NSString stringWithFormat:@"%.0f", maxV];
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    [defaults setDouble:_kiteMin forKey:@"kiteMinKt"];
    [defaults setDouble:_kiteMax forKey:@"kiteMaxKt"];
    if (self.popover.shown) [self rebuildContent];
}

- (void)controlTextDidEndEditing:(NSNotification *)note {
    if (note.object == _kiteMinField || note.object == _kiteMaxField) [self kiteThresholdChanged:note.object];
}

- (void)chooseAerodrome:(NSPopUpButton *)sender {
    [_mapDetailCache removeAllObjects];
    NSString *code = sender.selectedItem.representedObject;
    if (![code isKindOfClass:NSString.class] || !code.length) return;
    _aerodromeCode = code;
    [NSUserDefaults.standardUserDefaults setObject:code forKey:@"homeAerodrome"];
    [self refreshAll];
}

- (NSArray *)stationsForState:(NSString *)state {
    NSString *code = state.lowercaseString;
    NSString *name = [@"stations-" stringByAppendingString:code];
    NSString *path = [NSBundle.mainBundle pathForResource:name ofType:@"json"];
    if (!path) {
        NSString *root = NSProcessInfo.processInfo.environment[@"ISOBAR_FIXTURES"];
        if (root) path = [[root stringByExpandingTildeInPath] stringByAppendingPathComponent:[name stringByAppendingString:@".json"]];
    }
    NSData *data = [NSData dataWithContentsOfFile:path];
    return data ? ParseStationList(data) : @[];
}

- (NSDictionary *)placeByResolvingStation:(NSDictionary *)place {
    NSMutableDictionary *out = [place mutableCopy];
    NSArray *stations = [self stationsForState:place[@"state"]];
    NSDictionary *station = NearestStation(stations, [place[@"latitude"] doubleValue], [place[@"longitude"] doubleValue], place[@"name"]);
    if (station) {
        out[@"stationName"] = station[@"name"];
        out[@"stationWMO"] = station[@"wmo"];
        out[@"stationProduct"] = ObservationProductForState(place[@"state"]) ?: out[@"stationProduct"];
    }
    if (![out[@"timezone"] length]) {
        NSString *zone = ZoneForPlace(out).name;
        if (zone) out[@"timezone"] = zone;
    }
    return out;
}

- (void)searchLocations:(id)sender {
    (void)sender;
    NSString *q = [_searchField.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (q.length < 2) return;
    NSMutableArray *hits = [NSMutableArray array];
    for (NSString *state in @[@"WA", @"NSW", @"VIC"]) {
        for (NSDictionary *station in [self stationsForState:state]) {
            NSString *name = [station[@"name"] isKindOfClass:NSString.class] ? station[@"name"] : @"";
            if ([name rangeOfString:q options:NSCaseInsensitiveSearch].location == NSNotFound) continue;
            double lat = [station[@"lat"] doubleValue];
            double lon = [station[@"lon"] doubleValue];
            [hits addObject:@{
                @"name": name,
                @"state": state,
                @"postcode": @"",
                @"geohash": GeohashEncode(lat, lon, 7) ?: @"",
                @"latitude": @(lat),
                @"longitude": @(lon),
                @"stationWMO": station[@"wmo"] ?: @"",
            }];
            if (hits.count >= 40) break;
        }
        if (hits.count >= 40) break;
    }
    _searchResults = hits;
    [_searchTable reloadData];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
    if (tableView == _locationsTable) return _locations.count;
    return _searchResults.count;
}

- (id)tableView:(NSTableView *)tableView objectValueForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
    (void)column;
    if (tableView == _locationsTable) {
        NSDictionary *p = _locations[row];
        NSString *mark = row == 0 ? @"↑  " : @"    ";
        return [NSString stringWithFormat:@"%@%@ %@", mark, p[@"name"], p[@"state"] ?: @""];
    }
    NSDictionary *p = _searchResults[row];
    return [NSString stringWithFormat:@"%@ %@ %@", p[@"name"], p[@"state"], p[@"postcode"] ?: @""];
}

- (void)addLocation:(id)sender {
    (void)sender;
    NSInteger row = _searchTable.selectedRow;
    if (row < 0 || row >= (NSInteger)_searchResults.count) return;
    NSDictionary *picked = _searchResults[row];
    NSDictionary *resolved = [self placeByResolvingStation:picked];
    _locations = LocationListByAdding(_locations, resolved);
    [self saveLocations];
    [_locationsTable reloadData];
    [self refreshAll];
}

- (void)removeLocation:(id)sender {
    (void)sender;
    NSInteger row = _locationsTable.selectedRow;
    if (row < 0) return;
    _locations = LocationListByRemovingIndex(_locations, (NSUInteger)row);
    [self saveLocations];
    [_locationsTable reloadData];
    [self refreshAll];
}

- (void)moveLocationUp:(id)sender { [self moveLocationBy:-1]; (void)sender; }
- (void)moveLocationDown:(id)sender { [self moveLocationBy:1]; (void)sender; }

- (void)moveLocationBy:(NSInteger)delta {
    NSInteger row = _locationsTable.selectedRow;
    if (row < 0) return;
    NSInteger dest = row + delta;
    if (dest < 0 || dest >= (NSInteger)_locations.count) return;
    _locations = LocationListByMoving(_locations, (NSUInteger)row, (NSUInteger)dest);
    [self saveLocations];
    [_locationsTable reloadData];
    [_locationsTable selectRowIndexes:[NSIndexSet indexSetWithIndex:dest] byExtendingSelection:NO];
    [self updateBar];
    if (self.popover.shown) [self rebuildContent];
}

- (void)toggleLaunch:(NSButton *)sender {
    NSError *error = nil;
    BOOL on = sender.state == NSControlStateValueOn;
    BOOL ok = on ? [SMAppService.mainAppService registerAndReturnError:&error]
                 : [SMAppService.mainAppService unregisterAndReturnError:&error];
    if (!ok) {
        NSAlert *alert = [NSAlert alertWithError:error];
        alert.messageText = @"Couldn’t update Launch at Login";
        [alert runModal];
    }
}

- (void)startLocationIfAllowed {
    CLAuthorizationStatus status = _locationManager.authorizationStatus;
    if (status == kCLAuthorizationStatusAuthorized) {
        [_locationManager startUpdatingLocation];
    }
    [self updateBar];
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    (void)manager;
    [self startLocationIfAllowed];
}

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
    (void)manager;
    CLLocation *fix = locations.lastObject;
    if (!fix || fix.horizontalAccuracy < 0 || fabs(fix.timestamp.timeIntervalSinceNow) > 15 * 60) return;
    double lat = fix.coordinate.latitude, lon = fix.coordinate.longitude;
    NSString *hash = GeohashEncode(lat, lon, 7);
    if (!hash.length) return;
    if (_here && HaversineKm(lat, lon, [_here[@"latitude"] doubleValue], [_here[@"longitude"] doubleValue]) < 3) return;
    NSDictionary *nearestSaved = nil;
    double nearestSavedKm = 75;
    for (NSDictionary *saved in _locations) {
        double km = HaversineKm(lat, lon, [saved[@"latitude"] doubleValue], [saved[@"longitude"] doubleValue]);
        if (km < nearestSavedKm) { nearestSaved = saved; nearestSavedKm = km; }
    }
    NSString *state = nearestSaved[@"state"] ?: @"";
    NSString *timezone = nearestSaved[@"timezone"] ?: @"";
    if (!nearestSaved) {
        double nearestStationKm = 150;
        for (NSString *candidate in @[@"WA", @"NSW", @"VIC"]) {
            NSDictionary *station = NearestStation([self stationsForState:candidate], lat, lon, nil);
            if (!station) continue;
            double km = HaversineKm(lat, lon, [station[@"lat"] doubleValue], [station[@"lon"] doubleValue]);
            if (km < nearestStationKm) { nearestStationKm = km; state = candidate; }
        }
        if (state.length) timezone = ZoneForPlace(@{@"state":state}).name ?: @"";
    }
    if (!timezone.length) timezone = NSTimeZone.localTimeZone.name ?: @"UTC";
    NSMutableDictionary *place = [@{
        @"name": nearestSaved ? (nearestSaved[@"name"] ?: @"Current Location") : @"Current Location",
        @"state": state,
        @"geohash": hash,
        @"replacesGeohash": nearestSaved[@"geohash"] ?: @"",
        @"latitude": @(lat),
        @"longitude": @(lon),
        @"timezone": timezone,
    } mutableCopy];
    _here = [self placeByResolvingStation:place];
    [self refreshAll];
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
    (void)manager; (void)error;
}

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    (void)note;
    _item = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    _item.button.target = self;
    _item.button.action = @selector(togglePopover:);
    [_item.button addObserver:self forKeyPath:@"effectiveAppearance" options:0 context:NULL];
    _offline = NO;
    [self updateBar];
    // Explicit custom stores are managed by their owner. The ordinary download
    // supplies its own collector and needs no Python or separate installation.
    if (!NSProcessInfo.processInfo.environment[@"ISOBAR_STORE"].length && !getenv("ISOBAR_FIXTURES")) {
        NSURL *helper=[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"collector/isobar-data"];
        _collector=[[IsobarCollector alloc] initWithExecutable:helper store:[NSURL fileURLWithPath:[self defaultStoreRoot]]];
        __weak Controller *weak=self;
        _collector.onUpdate=^{ Controller *strong=weak; if(strong){ [strong reloadStoreAtPath:strong->_storeRoot]; [strong prepareChartImages]; } };
    }
    [self refreshAll];
    [NSTimer scheduledTimerWithTimeInterval:kRefreshInterval target:self selector:@selector(refreshAll) userInfo:nil repeats:YES];
    _locationManager = [CLLocationManager new];
    _locationManager.delegate = self;
    _locationManager.desiredAccuracy = kCLLocationAccuracyKilometer;
    _locationManager.distanceFilter = 3000;
    CLAuthorizationStatus status = _locationManager.authorizationStatus;
    if (status == kCLAuthorizationStatusNotDetermined) [_locationManager requestWhenInUseAuthorization];
    else [self startLocationIfAllowed];
}

- (void)applicationWillTerminate:(NSNotification *)note { (void)note; [_collector stop]; }

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    (void)keyPath; (void)object; (void)change; (void)context;
    [self updateBar];
}

@end

static int RelaunchIfNeeded(BOOL already) {
    NSString *expected = NSBundle.mainBundle.bundleIdentifier;
    if (!expected.length) return 70;
    if (!GUIRequiresLaunchServicesRelaunch(NSRunningApplication.currentApplication.bundleIdentifier, expected))
        return -1;
    if (already) return 70;
    NSURL *bundleURL = NSBundle.mainBundle.bundleURL;
    if (![bundleURL.pathExtension.lowercaseString isEqual:@"app"]) return 70;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
    task.arguments = @[bundleURL.path, @"--args", @"--isobar-launch-services-relaunch"];
    if (![task launchAndReturnError:nil]) return 70;
    [task waitUntilExit];
    return task.terminationStatus == 0 ? 0 : 70;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        BOOL relaunched = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--version") == 0) {
                NSString *version = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
                printf("Isobar %s\n", (version ?: @"development").UTF8String);
                return 0;
            }
            if (strcmp(argv[i], "--help") == 0) {
                printf("Isobar — animated weather maps in your menu bar\n\n"
                       "  --version  Show the app version\n"
                       "  --help     Show this help\n");
                return 0;
            }
            if (strcmp(argv[i], "--isobar-launch-services-relaunch") == 0) relaunched = YES;
        }
        int relaunch = RelaunchIfNeeded(relaunched);
        if (relaunch >= 0) return relaunch;
        NSApplication *app = NSApplication.sharedApplication;
        Controller *controller = [Controller new];
        app.delegate = controller;
        [app run];
    }
    return 0;
}
