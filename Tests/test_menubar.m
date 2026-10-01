#import <Cocoa/Cocoa.h>
#import "../Sources/pure.h"
#import "../Sources/menubar.h"
#include <math.h>
#include <stdio.h>

static int failures;
static void Check(BOOL ok, NSString *message) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static void Save(NSBitmapImageRep *rep, NSString *name) {
    NSString *dir = NSProcessInfo.processInfo.environment[@"ISOBAR_MENUBAR_SCREENSHOTS"];
    if (!dir.length) return;
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:[dir stringByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]] atomically:YES];
}

static NSBitmapImageRep *CaptureImage(NSImage *image, CGFloat scale, NSAppearance *appearance) {
    // Use explicit bitmap dimensions: an offscreen AppKit window inherits the
    // host display's backing scale, so it cannot establish 1x/2x coverage.
    NSInteger width=(NSInteger)ceil(image.size.width*scale), height=(NSInteger)ceil(image.size.height*scale);
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:width pixelsHigh:height
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    [NSGraphicsContext saveGraphicsState];
    @try {
        NSGraphicsContext.currentContext=context;
        [appearance performAsCurrentDrawingAppearance:^{
            BOOL dark=[appearance.name isEqual:NSAppearanceNameDarkAqua];
            [(dark?[NSColor colorWithWhite:.12 alpha:1]:NSColor.whiteColor) setFill];
            NSRect bounds=NSMakeRect(0,0,width,height);
            NSRectFill(bounds);
            NSImage *drawing=image.copy;
            drawing.template=NO;
            [drawing drawInRect:bounds fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
        }];
    } @finally { [NSGraphicsContext restoreGraphicsState]; }
    return rep;
}

static NSBitmapImageRep *CaptureArrow(double from) {
    NSImage *image = [NSImage imageWithSize:NSMakeSize(22, 18) flipped:NO drawingHandler:^BOOL(NSRect dirtyRect) {
        (void)dirtyRect;
        IsobarDrawMenuBarWindArrow(from, NSMakeRect(1, 1, 20, 16));
        return YES;
    }];
    return CaptureImage(image, 1, [NSAppearance appearanceNamed:NSAppearanceNameAqua]);
}

static double InkAt(NSBitmapImageRep *rep, NSInteger x, NSInteger y) {
    NSColor *pixel = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    return 1.0 - (pixel.redComponent + pixel.greenComponent + pixel.blueComponent) / 3.0;
}

static BOOL ArrowFits(NSBitmapImageRep *rep) {
    for (NSInteger x = 0; x < rep.pixelsWide; x++)
        if (InkAt(rep, x, 0) > .05 || InkAt(rep, x, rep.pixelsHigh - 1) > .05) return NO;
    for (NSInteger y = 0; y < rep.pixelsHigh; y++)
        if (InkAt(rep, 0, y) > .05 || InkAt(rep, rep.pixelsWide - 1, y) > .05) return NO;
    return YES;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSDictionary *sample = @{ @"airTemp": @16, @"windDir": @"N", @"windKt": @7 };
        NSDictionary *lightWind = @{ @"airTemp": @13, @"windDir": @"N", @"windKt": @3 };
        NSDictionary *calm = @{ @"airTemp": @16, @"windKt": @0 };
        NSDictionary *converted = @{ @"airTemp": @16, @"wind_direction_deg": @135, @"wind_speed_kmh": @18.52 };
        NSDictionary *missing = @{};
        NSImage *normal = IsobarMenuBarImage(sample, NO);
        NSImage *alert = IsobarMenuBarImage(sample, YES);
        NSImage *calmImage = IsobarMenuBarImage(calm, NO);
        NSImage *missingImage = IsobarMenuBarImage(missing, NO);
        Check(normal.size.height == 18 && normal.size.width >= 45, @"normal reading is compact and 18pt high");
        Check(normal.template, @"ordinary status image is a template");
        Check(!alert.template, @"warning image keeps its colour");
        Check(calmImage.size.width > 0 && missingImage.size.width > 0, @"calm and missing observations render");
        Check([IsobarMenuBarAccessibility(sample) containsString:@"16 degrees"], @"accessibility includes temperature");
        Check([IsobarMenuBarAccessibility(sample) containsString:@"from N"], @"accessibility includes wind direction");
        Check([IsobarMenuBarAccessibility(sample) containsString:@"7 knots"], @"accessibility includes knots");
        Check([IsobarMenuBarAccessibility(calm) containsString:@"calm"], @"accessibility names calm wind");
        Check([IsobarMenuBarAccessibility(missing) containsString:@"unavailable"], @"accessibility handles missing observation");
        Check([IsobarMenuBarAccessibility(converted) containsString:@"10 knots"], @"km/h converts to knots");
        Check([IsobarMenuBarAccessibility(converted) containsString:@"from 135°"], @"accessibility includes numeric wind direction");
        Check(![IsobarMenuBarAccessibility(@{@"airTemp":@16, @"wind_direction_deg":@(NAN), @"windKt":@7}) containsString:@"from"],
              @"invalid numeric direction is ignored");
        Check(![IsobarMenuBarAccessibility(@{@"airTemp":@16, @"wind_direction_deg":@361, @"windKt":@7}) containsString:@"from"],
              @"out-of-range numeric direction is ignored");
        NSAppearance *light = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        NSAppearance *dark = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        NSBitmapImageRep *normalPixels = CaptureImage(normal, 1, light);
        NSBitmapImageRep *alertPixels = CaptureImage(alert, 1, light);
        Save(normalPixels, @"normal-light"); Save(alertPixels, @"warning-light");
        Save(CaptureImage(IsobarMenuBarImage(lightWind, YES), 2, light), @"light-wind-2x");
        Save(CaptureImage(IsobarMenuBarImage(lightWind, YES), 2, dark), @"light-wind-dark-2x");
        Save(CaptureImage(IsobarMenuBarImage(@{@"airTemp":@13,@"windDir":@"SE",@"windKt":@15}, YES), 2, light), @"15kt-se-2x");
        Save(CaptureImage(IsobarMenuBarImage(@{@"airTemp":@13,@"windDir":@"W",@"windKt":@50}, YES), 2, light), @"50kt-w-2x");
        Save(CaptureImage(normal, 3, light), @"normal-sheet");
        Save(CaptureImage(normal, 1, dark), @"normal-dark");
        Save(CaptureImage(alert, 1, dark), @"warning-dark");
        NSBitmapImageRep *retina=CaptureImage(normal,2,light);
        Save(retina,@"normal-light-2x");
        Check(retina.pixelsWide==normalPixels.pixelsWide*2 && retina.pixelsHigh==36,
              @"Retina capture renders at double resolution");
        Check(normalPixels != nil && alertPixels != nil, @"actual-size captures render");
        Check(normalPixels.pixelsWide == (NSInteger)ceil(normal.size.width) && normalPixels.pixelsHigh == 18,
              @"actual-size capture matches native dimensions");
        Check(alertPixels.pixelsWide >= normalPixels.pixelsWide, @"warning keeps the reading and adds only its dot");
        NSBitmapImageRep *northWind = CaptureArrow(0), *southWind = CaptureArrow(180);
        NSBitmapImageRep *eastWind = CaptureArrow(90), *westWind = CaptureArrow(270);
        Check(ArrowFits(northWind) && ArrowFits(southWind) && ArrowFits(eastWind) && ArrowFits(westWind) &&
              ArrowFits(CaptureArrow(135)), @"direction arrows fit the native icon at cardinal and diagonal angles");
        double northBottom = 0, northTop = 0, southBottom = 0, southTop = 0;
        double eastLeft = 0, eastRight = 0, westLeft = 0, westRight = 0;
        for (NSInteger y = 0; y < 18; y++) for (NSInteger x = 0; x < 22; x++) {
            if (y < 5) { northTop += InkAt(northWind, x, y); southTop += InkAt(southWind, x, y); }
            if (y > 12) { northBottom += InkAt(northWind, x, y); southBottom += InkAt(southWind, x, y); }
            if (x < 5) { eastLeft += InkAt(eastWind, x, y); westLeft += InkAt(westWind, x, y); }
            if (x > 16) { eastRight += InkAt(eastWind, x, y); westRight += InkAt(westWind, x, y); }
        }
        Check(northBottom > southBottom && southTop > northTop,
              @"northerly wind arrow flows down and southerly wind arrow flows up");
        Check(eastLeft > westLeft && westRight > eastRight,
              @"easterly wind arrow flows left and westerly wind arrow flows right");
        NSImage *fast = IsobarMenuBarImage(@{@"airTemp":@13, @"windDir":@"N", @"windKt":@50}, NO);
        Check(fast.size.width >= normal.size.width,
              @"exact knot speed remains visible without a second speed code in the icon");
        fprintf(stderr, "menubar acceptance failures: %d\n", failures);
    }
    return failures ? 1 : 0;
}
