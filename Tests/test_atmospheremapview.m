#import <Cocoa/Cocoa.h>
#import "atmosphere.h"
#import "atmospheremapview.h"
#import "mapcamera.h"
#include <math.h>
#include <stdio.h>

static int failures;
static void Check(BOOL ok, NSString *message) {
    if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); failures++; }
}

static NSDate *UTC(NSString *value) {
    NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    return [formatter dateFromString:value];
}

static NSDictionary *ProfileFixture(void) {
    return @{
        @"id": @"YPPH", @"model": @"fixture",
        @"run": @"2026-09-27T00:00:00Z", @"latitude": @(-31.94),
        @"longitude": @(115.97), @"elevation": @20,
        @"time": @[@"2026-09-27T12:00:00Z", @"2026-09-27T15:00:00Z"],
        @"levels": @{
            @"1000": @{
                @"height_m": @[@80, @90], @"temperature_c": @[@20, @19],
                @"relative_humidity_pct": @[@72, @78], @"cloud_cover_pct": @[@85, @92],
                @"wind_speed_kt": @[@12, @16], @"wind_direction_deg": @[@300, @320],
                @"vertical_velocity_ms": @[@0.2, @0.1]
            },
            @"850": @{
                @"height_m": @[@1500, @1520], @"temperature_c": @[@12, @11],
                @"relative_humidity_pct": @[@80, @88], @"cloud_cover_pct": @[@70, @82],
                @"wind_speed_kt": @[@22, @26], @"wind_direction_deg": @[@250, @270]
            },
            @"700": @{
                @"height_m": @[@3000, @3010], @"temperature_c": @[@2, @1],
                @"relative_humidity_pct": @[@55, @60], @"cloud_cover_pct": @[@30, @45],
                @"wind_speed_kt": @[@30, @34], @"wind_direction_deg": @[@220, @230]
            }
        }
    };
}

static NSBitmapImageRep *Capture(AtmosphereMapView *view, NSWindow *window) {
    [view setFrameSize:NSMakeSize(640, 420)];
    [window.contentView addSubview:view];
    [window displayIfNeeded];
    NSBitmapImageRep *bitmap = [window.contentView bitmapImageRepForCachingDisplayInRect:window.contentView.bounds];
    [window.contentView cacheDisplayInRect:window.contentView.bounds toBitmapImageRep:bitmap];
    [view removeFromSuperview];
    return bitmap;
}

static NSUInteger InkPixels(NSBitmapImageRep *bitmap) {
    if (!bitmap || bitmap.isPlanar || bitmap.bitsPerSample != 8) return 0;
    NSUInteger count = 0, channels = bitmap.samplesPerPixel;
    for (NSInteger y = 0; y < bitmap.pixelsHigh; y++) {
        const unsigned char *row = bitmap.bitmapData + y * bitmap.bytesPerRow;
        for (NSInteger x = 0; x < bitmap.pixelsWide; x++) {
            const unsigned char *p = row + x * channels;
            NSUInteger sum = 0;
            for (NSUInteger c = 0; c < MIN(channels, (NSUInteger)3); c++) sum += p[c];
            if (sum > 35) count++;
        }
    }
    return count;
}

static NSUInteger Difference(NSBitmapImageRep *a, NSBitmapImageRep *b) {
    if (!a || !b || a.isPlanar || b.isPlanar || a.bitsPerSample != 8 || b.bitsPerSample != 8 ||
        a.pixelsWide != b.pixelsWide || a.pixelsHigh != b.pixelsHigh || a.samplesPerPixel != b.samplesPerPixel) return 0;
    NSUInteger count = 0, channels = a.samplesPerPixel;
    for (NSInteger y = 0; y < a.pixelsHigh; y++) {
        const unsigned char *ra = a.bitmapData + y * a.bytesPerRow;
        const unsigned char *rb = b.bitmapData + y * b.bytesPerRow;
        for (NSInteger x = 0; x < a.pixelsWide; x++) {
            const unsigned char *pa = ra + x * channels, *pb = rb + x * channels;
            NSUInteger delta = 0;
            for (NSUInteger c = 0; c < channels; c++) delta += (NSUInteger)labs((long)pa[c] - (long)pb[c]);
            if (delta > 24) count++;
        }
    }
    return count;
}

static void WriteScreenshot(NSBitmapImageRep *bitmap) {
    if (!bitmap) return;
    NSString *path = @"build/atmosphere/native-profile.png";
    NSString *directory = [path stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:path atomically:YES];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

    NSDictionary *product = ProfileFixture();
    NSDate *date = UTC(@"2026-09-27T12:00:00Z");
    NSDictionary *sample = AtmosphereAtDate(product, date);
    Check(sample != nil && [sample[@"levels"] count] >= 3, @"synthetic pressure-level product samples");

    AtmosphereMapView *view = [[AtmosphereMapView alloc] initWithFrame:NSMakeRect(0, 0, 640, 420)];
    view.camera = MapCameraMake(-31.94, 115.97, 64, 0, 640, 420);
    IsobarCamera tilted = view.camera;
    tilted.pitch = 1.0;
    view.camera = tilted;
    view.product = product;
    view.date = date;
    view.latitude = -31.94;
    view.longitude = 115.97;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-2000, -2000, 640, 420)
                                                    styleMask:NSWindowStyleMaskBorderless
                                                      backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    NSBitmapImageRep *profile = Capture(view, window);
    Check(InkPixels(profile) > 20, @"tilted profile renders visible pixels");

    NSButton *badge = [view valueForKey:@"disclosureButton"];
    Check(NSMinY(badge.frame)>=40 && !badge.hidden && [view hitTest:NSMakePoint(NSMidX(badge.frame), NSMidY(badge.frame))] == badge, @"profile badge is interactive when available");
    [badge performClick:nil];
    NSSlider *slider = [view valueForKey:@"altitudeSlider"];
    Check(view.disclosureOpen && slider != nil && !slider.hidden, @"badge opens profile section and altitude slider");
    NSBitmapImageRep *low = Capture(view, window);
    slider.doubleValue = 11000;
    [slider sendAction:slider.action to:slider.target];
    Check(fabs(view.aircraftAltitudeM - 11000) < 0.1, @"altitude control updates the reference height");
    [view setNeedsDisplay:YES];
    NSBitmapImageRep *high = Capture(view, window);
    Check(Difference(low, high) > 100, @"changing reference altitude changes rendered pixels");
    WriteScreenshot(high);

    view.product = nil;
    [view setNeedsDisplay:YES];
    NSBitmapImageRep *blank = Capture(view, window);
    Check(badge.hidden && [view hitTest:NSMakePoint(NSMidX(badge.frame), NSMidY(badge.frame))] == nil, @"missing product hides profile interaction");
    Check(InkPixels(blank) < InkPixels(profile), @"missing product removes profile drawing");
    [window close];
    return failures ? 1 : 0;
} }
