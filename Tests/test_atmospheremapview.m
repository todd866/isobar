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
@property(nonatomic,strong) NSMutableSet<NSString *> *seedKeys;
@end
@implementation SeedProbe
- (BOOL)projectLat:(double)lat lon:(double)lon height:(double)height x:(double *)x y:(double *)y {
    (void)lat; (void)lon; (void)height; (void)x; (void)y;
    self.projectedSeeds++;
    if (!self.seedKeys) self.seedKeys=[NSMutableSet set];
    [self.seedKeys addObject:[NSString stringWithFormat:@"%.5f:%.5f:%.0f",lat,lon,height]];
    return NO;
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

static void CheckSyntheticCell(AtmosphereMapView *view) {
    const double latitude=-31.94, longitude=115.97;
    ATTeachingContext context={ATTeachingCirculation,latitude,longitude,0,view.date.timeIntervalSince1970*1000.0};
    ATTeachingSample floor=at_teaching_sample(context,latitude,longitude,0), top=at_teaching_sample(context,latitude,longitude,10000);
    Check(floor.w==0 && floor.cloudPct==0 && top.w==0 && top.cloudPct==0, @"teaching cell closes flow and cloud at floor/lid");
    ATTeachingSample c=at_teaching_sample(context,latitude+.01,longitude+.01,4220);
    NSDictionary *native=[view syntheticWindAtHeight:4220 latitude:latitude+.01 longitude:longitude+.01];
    Check(fabs([native[@"verticalMS"] doubleValue]-c.w)<1e-9, @"native wind samples shared C field");
    view.teachingKind=ATTeachingSeaBreeze; NSDate *base=view.date; NSDictionary *baseline=[view syntheticWindAtHeight:500 latitude:latitude longitude:longitude]; view.date=[base dateByAddingTimeInterval:299];
    NSDictionary *before=[view syntheticWindAtHeight:500 latitude:latitude longitude:longitude];
    view.date=[base dateByAddingTimeInterval:300];
    NSDictionary *after=[view syntheticWindAtHeight:500 latitude:latitude longitude:longitude];
    Check([baseline isEqual:before] && ![before isEqual:after], @"native context time changes at the five-minute boundary"); view.date=base;
    view.teachingKind=ATTeachingSeaBreeze;
    NSDictionary *ocean=[view syntheticWindAtHeight:470 latitude:latitude longitude:longitude-.35];
    NSDictionary *land=[view syntheticWindAtHeight:470 latitude:latitude longitude:longitude+.35];
    NSDictionary *returnFlow=[view syntheticWindAtHeight:1870 latitude:latitude longitude:longitude];
    Check([ocean[@"eastMS"] doubleValue]>0 && [ocean[@"verticalMS"] doubleValue]<0 && [land[@"verticalMS"] doubleValue]>0 && [returnFlow[@"eastMS"] doubleValue]<0, @"sea breeze has onshore, return, rise, and descent branches");
    view.teachingKind=ATTeachingCirculation;
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
    NSPopUpButton *selector=[view valueForKey:@"teachingSelector"];
    [window displayIfNeeded];
    __block BOOL framed=NO;
    __weak AtmosphereMapView *weakView=view;
    view.onFrameCamera=^(IsobarCamera camera){framed=YES;weakView.camera=camera;};
    NSButton *frameButton=[view valueForKey:@"frameButton"];[frameButton performClick:nil];
    Check(framed,@"frame action requests shared map camera update");
    Check(isfinite(view.camera.centreLat) && isfinite(view.camera.centreLon) && isfinite(view.camera.zoom) && isfinite(view.camera.pitch) && isfinite(view.camera.globe), @"framing leaves a finite camera");
    double frameX=0,frameY=0;Check(IsobarCameraProjectAltitude(view.camera,view.latitude,view.longitude,10020,&frameX,&frameY) && frameY>=view.camera.viewportH*.14 && frameY<view.camera.viewportH*.4,@"framing makes the physical column visible");
    Check(selector != nil && [view hitTest:NSMakePoint(NSMidX(selector.frame),NSMidY(selector.frame))] == selector, @"teaching scenario selector is interactive");
    NSBitmapImageRep *low = Capture(view, window);
    slider.doubleValue = 9000;
    [slider sendAction:slider.action to:slider.target];
    Check(fabs(view.aircraftAltitudeM - 9000) < 0.1, @"altitude control updates the reference height");
    [view setNeedsDisplay:YES];
    NSBitmapImageRep *high = Capture(view, window);
    Check(Difference(low, high) > 100, @"changing reference altitude changes rendered pixels");
    WriteScreenshot(high);
    NSEvent *escape=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil characters:@"\x1b" charactersIgnoringModifiers:@"\x1b" isARepeat:NO keyCode:53];
    [view keyDown:escape];Check(!view.disclosureOpen && selector.hidden && frameButton.hidden,@"Escape closes all native atmosphere instruments");

    NSDictionary *anchorWind=[view syntheticWindAtHeight:470 latitude:view.latitude longitude:view.longitude];
    IsobarCamera moved=view.camera; moved.centreLat=-31.72; moved.centreLon=116.32; view.camera=moved;
    NSDictionary *stillAnchor=[view syntheticWindAtHeight:470 latitude:view.latitude longitude:view.longitude];
    Check([anchorWind isEqual:stillAnchor], @"teaching field anchor remains fixed while camera pans");
    NSDictionary *pannedSample=[view sample]; NSDictionary *pannedLevel=pannedSample[@"levels"][0];
    ATTeachingContext pannedContext={view.teachingKind,view.latitude,view.longitude,20,date.timeIntervalSince1970*1000.0};
    ATTeachingSample pannedField=at_teaching_sample(pannedContext,moved.centreLat,moved.centreLon,[pannedLevel[@"heightM"] doubleValue]);
    Check(fabs([pannedLevel[@"verticalVelocityMS"] doubleValue]-pannedField.w)<1e-9, @"profile follows camera centre while field anchor stays fixed");

    double anchorLat=[[view valueForKey:@"anchorLat"] doubleValue], anchorLon=[[view valueForKey:@"anchorLon"] doubleValue], anchorGround=[[view valueForKey:@"anchorGroundM"] doubleValue];
    view.latitude=-32.15; view.longitude=116.85; view.product=@{@"elevation":@8848};
    Check(fabs([[view valueForKey:@"anchorLat"] doubleValue]-anchorLat)<1e-12 && fabs([[view valueForKey:@"anchorLon"] doubleValue]-anchorLon)<1e-12 && fabs([[view valueForKey:@"anchorGroundM"] doubleValue]-anchorGround)<1e-12,
          @"airport/product coordinate updates preserve the established teaching anchor");
    Check(fabs([[view valueForKey:@"groundHeight"] doubleValue]-anchorGround)<1e-12, @"profile axis and displayed field retain the same anchor ground after product change");
    view.product=product;

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
    for (NSInteger kind=0;kind<4;kind++) {
        AtmosphereMapView *scenario=[[AtmosphereMapView alloc] initWithFrame:NSMakeRect(0,0,640,420)];
        scenario.camera=MapCameraMake(-31.94,115.97,1200,0,640,420); IsobarCamera scenarioCamera=scenario.camera; scenarioCamera.pitch=.8; scenario.camera=scenarioCamera;
        scenario.date=date; scenario.latitude=-31.94; scenario.longitude=115.97; scenario.teachingKind=(ATTeachingKind)kind;
        for(NSNumber *ground in @[@0,@8848])for(NSValue *size in @[[NSValue valueWithSize:NSMakeSize(640,420)],[NSValue valueWithSize:NSMakeSize(390,600)],[NSValue valueWithSize:NSMakeSize(844,390)]]) {
            scenario.product=@{@"elevation":ground}; scenario.teachingKind=(ATTeachingKind)kind; IsobarCamera c=scenario.camera;c.viewportW=size.sizeValue.width;c.viewportH=size.sizeValue.height;c.zoom=3;scenario.camera=c;
            [(NSButton *)[scenario valueForKey:@"frameButton"] performClick:nil];
            double top=kind==1?2500:kind==3?12000:10000,x=0,y=0;
            double displayTop=ground.doubleValue+(kind==1?top*3.0:top);
            Check(IsobarCameraProjectAltitude(scenario.camera,scenario.latitude,scenario.longitude,displayTop,&x,&y) && y>=c.viewportH*.14 && y<c.viewportH*.4,@"every framed native model has a visible lid at low and high terrain");
            if (kind==1) {
                double lateral=8000.0/(111320.0*MAX(.2,cos(scenario.latitude*M_PI/180.0))),westX=0,westY=0,eastX=0,eastY=0;
                Check(IsobarCameraProjectAltitude(scenario.camera,scenario.latitude,scenario.longitude-lateral,ground.doubleValue+1250*3.0,&westX,&westY) && IsobarCameraProjectAltitude(scenario.camera,scenario.latitude,scenario.longitude+lateral,ground.doubleValue+1250*3.0,&eastX,&eastY) && westX>=c.viewportW*.08 && eastX<=c.viewportW*.92 && westY>=c.viewportH*.12 && westY<=c.viewportH*.88 && eastY>=c.viewportH*.12 && eastY<=c.viewportH*.88,@"sea-breeze frame keeps the full lateral cell visible");
            }
        }
        scenario.product=nil;scenario.camera=scenarioCamera;[(NSButton *)[scenario valueForKey:@"frameButton"] performClick:nil];
        NSBitmapImageRep *scenarioBitmap=Capture(scenario,window);
        [[scenarioBitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithFormat:@"build/atmosphere/native-scenario-%ld.png",(long)kind] atomically:YES];
        Check(InkPixels(scenarioBitmap)>20, @"each teaching scenario renders a bounded close regional profile");
    }
    SeedProbe *probe=[[SeedProbe alloc] initWithFrame:NSMakeRect(0,0,640,420)]; probe.date=date;
    for (NSNumber *latitude in @[@93,@106,@(-93),@(-106),@89.99,@(-89.99)]) {
        IsobarCamera orbit=MapCameraMake(latitude.doubleValue,12,10000,0,640,420);
        orbit.centreLat=latitude.doubleValue; orbit.pitch=.8; probe.camera=orbit;
        probe.projectedSeeds=0; probe.seedKeys=[NSMutableSet set]; [probe drawSyntheticFlows];
        Check(probe.projectedSeeds>0,@"pole orbit retains atmosphere seeds at close zoom");
        Check(probe.seedKeys.count>1,@"fixed atmosphere lattice projects distinct trajectory seeds");
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
