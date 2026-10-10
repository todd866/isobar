#import <Cocoa/Cocoa.h>
#import "atmosphere.h"
#import "atmospheremapview.h"
#import "mapcamera.h"
#include <math.h>
#include <stdio.h>

@interface AtmosphereMapView (TestSampling)
- (NSDictionary *)sample;
- (void)drawSyntheticFlows;
- (NSDictionary *)syntheticWindAtHeight:(double)height latitude:(double)latitude longitude:(double)longitude;
@end
@interface SeedProbe : AtmosphereMapView
@property(nonatomic) NSUInteger projectedSeeds;
@end
@implementation SeedProbe
- (BOOL)projectLat:(double)lat lon:(double)lon height:(double)height x:(double *)x y:(double *)y {
    (void)lat; (void)lon; (void)height; (void)x; (void)y;
    self.projectedSeeds++; return NO;
}
@end
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

static double WindComponent(AtmosphereMapView *view, NSString *key, double height, double latitude, double longitude) {
    return [[view syntheticWindAtHeight:height latitude:latitude longitude:longitude][key] doubleValue];
}

static void CheckSyntheticCell(AtmosphereMapView *view) {
    const double latitude=-31.94, longitude=115.97;
    Check(fabs(WindComponent(view,@"verticalMS",0,latitude,longitude))<1e-12,
          @"synthetic cell has zero vertical flow at floor");
    Check(fabs(WindComponent(view,@"verticalMS",10000,latitude,longitude))<1e-12,
          @"synthetic cell has zero vertical flow at top");

    double lowEast=WindComponent(view,@"eastMS",2500,latitude,longitude)-13.0;
    double highEast=WindComponent(view,@"eastMS",7500,latitude,longitude)-23.0;
    double lowNorth=WindComponent(view,@"northMS",2500,latitude,longitude)-(-1.0);
    double highNorth=WindComponent(view,@"northMS",7500,latitude,longitude)-7.0;
    Check(lowEast*highEast+lowNorth*highNorth<0,
          @"synthetic cell reverses horizontal perturbation across midlevel");

    // The analytic partners cancel in local metres, within finite-difference
    // error from the latitude-dependent longitude scale.
    const double dLat=.0005, dLon=.0005, dHeight=1.0;
    for (NSArray *point in @[@[@(-31.94),@(115.97),@(2500)],
                             @[@(-12.0),@(40.0),@(5000)],
                             @[@(32.0),@(-110.0),@(7500)]]) {
        double lat=[point[0] doubleValue], lon=[point[1] doubleValue], h=[point[2] doubleValue];
        double du=(WindComponent(view,@"eastMS",h,lat,lon+dLon)-WindComponent(view,@"eastMS",h,lat,lon-dLon))
            /(2*dLon*111320.0*MAX(.1,cos(lat*M_PI/180.0)));
        double dv=(WindComponent(view,@"northMS",h,lat+dLat,lon)-WindComponent(view,@"northMS",h,lat-dLat,lon))
            /(2*dLat*111132.0);
        double dw=(WindComponent(view,@"verticalMS",h+dHeight,lat,lon)-WindComponent(view,@"verticalMS",h-dHeight,lat,lon))/(2*dHeight);
        Check(fabs(du+dv+dw)<5e-7, @"synthetic cell is locally divergence-free");
    }

    NSDate *base=view.date;
    NSDictionary *baseline=[view syntheticWindAtHeight:2500 latitude:latitude longitude:longitude];
    view.date=[base dateByAddingTimeInterval:299];
    NSDictionary *before=[view syntheticWindAtHeight:2500 latitude:latitude longitude:longitude];
    view.date=[base dateByAddingTimeInterval:300];
    NSDictionary *after=[view syntheticWindAtHeight:2500 latitude:latitude longitude:longitude];
    Check([baseline isEqual:before] && ![baseline isEqual:after], @"synthetic field is quantized to five-minute forecast steps");
    view.date=base;
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
    view.date = nil;
    [view setNeedsDisplay:YES];
    NSBitmapImageRep *blank = Capture(view, window);
    Check(badge.hidden && [view hitTest:NSMakePoint(NSMidX(badge.frame), NSMidY(badge.frame))] == nil, @"missing date hides profile interaction");
    Check(InkPixels(blank) < InkPixels(profile), @"missing date removes profile drawing");

    AtmosphereMapView *synthetic=[AtmosphereMapView new];
    synthetic.camera=MapCameraMake(-31.94,115.97,32,0,640,420);
    IsobarCamera syntheticCamera=synthetic.camera; syntheticCamera.pitch=0.8; synthetic.camera=syntheticCamera;
    synthetic.date=date; synthetic.latitude=-31.94; synthetic.longitude=115.97;
    CheckSyntheticCell(synthetic);
    NSBitmapImageRep *syntheticBitmap=Capture(synthetic,window);
    NSButton *syntheticBadge=[synthetic valueForKey:@"disclosureButton"];
    Check(!syntheticBadge.hidden && InkPixels(syntheticBitmap)>20, @"synthetic layered wind renders without a product");
    SeedProbe *probe=[[SeedProbe alloc] initWithFrame:NSMakeRect(0,0,640,420)]; probe.date=date;
    for (NSNumber *latitude in @[@93,@106,@(-93),@(-106),@89.99,@(-89.99)]) {
        IsobarCamera orbit=MapCameraMake(latitude.doubleValue,12,10000,0,640,420);
        orbit.centreLat=latitude.doubleValue; orbit.pitch=.8; probe.camera=orbit;
        probe.projectedSeeds=0; [probe drawSyntheticFlows];
        Check(probe.projectedSeeds>0,@"pole orbit retains atmosphere seeds at close zoom");
        NSDictionary *orbital=[probe sample];
        if (fabs(latitude.doubleValue)>90) {
            orbit.centreLat=latitude.doubleValue>0?180-latitude.doubleValue:-180-latitude.doubleValue;
            orbit.centreLon=-168; probe.camera=orbit;
            Check([orbital isEqual:[probe sample]],@"pole orbit samples equivalent physical location");
        }
    }
    [window close];
    return failures ? 1 : 0;
} }
