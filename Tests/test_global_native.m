// Native global smoke test. It loads the published 0.5-degree archive, pushes
// real MSLP frames through IsobarFieldRenderer, and optionally writes PNGs.
#import "fieldrender.h"
#import "ownchart.h"
#import "ownrender.h"
#import <ImageIO/ImageIO.h>
#import <Metal/Metal.h>
#import <math.h>
#import <stdio.h>
#import <stdlib.h>

static int fail(const char *message) { fprintf(stderr, "FAIL %s\n", message); return 2; }

static BOOL writePNG(CGImageRef image, NSString *path) {
    if (!image || !path.length) return NO;
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageDestinationRef dst = CGImageDestinationCreateWithURL((__bridge CFURLRef)url,
        CFSTR("public.png"), 1, NULL);
    if (!dst) return NO;
    CGImageDestinationAddImage(dst, image, NULL);
    BOOL ok = CGImageDestinationFinalize(dst);
    CFRelease(dst);
    return ok;
}

int main(void) {
    @autoreleasepool {
        NSString *root = [[[NSProcessInfo processInfo] environment][@"ISOBAR_DATA_ROOT"]
            length] ? [[[NSProcessInfo processInfo] environment][@"ISOBAR_DATA_ROOT"] copy] : @"build/global-archive";
        NSString *coast = [[[NSProcessInfo processInfo] environment][@"ISOBAR_WORLD_COAST"] length]
            ? [[[NSProcessInfo processInfo] environment][@"ISOBAR_WORLD_COAST"] copy] : @"Resources/world-coast.bin";
        NSString *error = nil;
        OwnRun *run = OwnRunLoadPublished(root, NO, coast, &error);
        if (!run) return fail(error.UTF8String ?: "global archive did not load");
        OwnRunGeo geo = run.geo;
        if (run.hours != 53 || geo.nLon != 720 || geo.nLat != 361 || !geo.wrapsLongitude ||
            fabs(geo.west + 180) > 1e-6 || fabs(geo.north - 90) > 1e-6 || fabs(geo.step - .5) > 1e-6)
            return fail("global archive geometry does not match the published contract");
        OwnCoast world = OwnCoastParse([NSData dataWithContentsOfFile:coast]);
        if (world.rings < 1 || world.points < 3) return fail("world coastline asset is missing or invalid");
        OwnCoastFree(world);
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) return fail("Metal device unavailable");
        IsobarFieldRenderer *renderer = [[IsobarFieldRenderer alloc] initWithDevice:device];
        if (!renderer) return fail("global field renderer unavailable");
        [renderer setGrid:(IsobarGeoGrid){geo.west, geo.north, geo.step, geo.nLon, geo.nLat, geo.wrapsLongitude}];
        renderer.pressureSmoothDegrees = 0;
        renderer.synchronousContours = YES;
        size_t points = (size_t)geo.nLon * geo.nLat;
        float *field = malloc(points * sizeof *field);
        if (!field) return fail("global field allocation failed");
        NSArray *frames = @[@0, @26, @52];
        NSArray *places = @[
            @{ @"name": @"london", @"lat": @51.5, @"lon": @-0.1 },
            @{ @"name": @"new-york", @"lat": @40.7, @"lon": @-74.0 },
            @{ @"name": @"tokyo", @"lat": @35.7, @"lon": @139.7 },
            @{ @"name": @"dateline", @"lat": @0.0, @"lon": @179.5 },
            @{ @"name": @"north-pole", @"lat": @90.0, @"lon": @0.0 },
            @{ @"name": @"south-pole", @"lat": @-90.0, @"lon": @0.0 },
        ];
        for (NSNumber *frameNumber in frames) {
            NSInteger frame = frameNumber.integerValue;
            [renderer setGrid:(IsobarGeoGrid){geo.west, geo.north, geo.step, geo.nLon, geo.nLat, geo.wrapsLongitude}];
            for (size_t p = 0; p < points; p++) {
                double v = [run valueAtPointIndex:(NSInteger)p field:OwnRunFieldMSLP hour:frame];
                field[p] = isfinite(v) ? (float)v : NAN;
            }
            NSError *uploadError = nil;
            if (![renderer uploadStep:frame kind:IsobarFieldPressure values:field error:&uploadError]) {
                free(field); return fail(uploadError.localizedDescription.UTF8String ?: "global GPU upload failed");
            }
            if (frame < run.hours - 1) {
                NSInteger next = frame + 1;
                for (size_t p = 0; p < points; p++) {
                    double v = [run valueAtPointIndex:(NSInteger)p field:OwnRunFieldMSLP hour:next];
                    field[p] = isfinite(v) ? (float)v : NAN;
                }
                if (![renderer uploadStep:next kind:IsobarFieldPressure values:field error:&uploadError]) {
                    free(field); return fail(uploadError.localizedDescription.UTF8String ?: "global adjacent GPU upload failed");
                }
            }
            NSString *out = [[[NSProcessInfo processInfo] environment][@"ISOBAR_GLOBAL_RENDER_OUT"] copy];
            for (NSDictionary *place in places) {
                double globe = ([place[@"name"] hasSuffix:@"pole"]) ? 1.0 : 0.0;
                IsobarCamera camera = {.centreLat=[place[@"lat"] doubleValue], .centreLon=[place[@"lon"] doubleValue], .zoom=2.0, .globe=globe, .viewportW=640, .viewportH=360};
                camera = IsobarCameraClamp(camera);
            NSError *renderError = nil;
                CGImageRef image = [renderer renderTime:frame fill:IsobarFieldPressure isobars:YES camera:camera error:&renderError];
            if (!image) return fail(renderError.localizedDescription.UTF8String ?: "global GPU render failed");
            double x = 0, y = 0;
            IsobarCameraProject(camera, camera.centreLat, camera.centreLon, &x, &y);
            double value = [renderer pickValueAtX:x y:y camera:camera time:frame kind:IsobarFieldPressure];
            if (!isfinite(value)) { CGImageRelease(image); return fail("global GPU pick was missing at a selected place"); }
                if (renderer.contourLineCount < 1) { CGImageRelease(image); return fail("global GPU render produced no pressure contours"); }
                NSString *pngName = [NSString stringWithFormat:@"%@-h%ld.png", place[@"name"], (long)frame];
            if (out.length && !writePNG(image, [out stringByAppendingPathComponent:pngName])) {
                CGImageRelease(image); return fail("global PNG export failed");
            }
                fprintf(stderr, "ok global hour %ld %s %.0fx%.0f value %.1f lines %ld\n", (long)frame,
                [place[@"name"] UTF8String], (double)CGImageGetWidth(image), (double)CGImageGetHeight(image), value,
                (long)renderer.contourLineCount);
            CGImageRelease(image);
            }
        }
        free(field);
        return 0;
    }
}
