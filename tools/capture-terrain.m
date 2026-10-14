// Offscreen native map acceptance. No window, installed app or owner archive.
#import "gpumapview.h"
#import "mapcamera.h"
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>

static BOOL Save(CGImageRef image, NSString *path) {
    if (!image) return NO;
    CGImageDestinationRef d = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], CFSTR("public.png"), 1, NULL);
    if (!d) return NO;
    CGImageDestinationAddImage(d, image, NULL);
    BOOL ok = CGImageDestinationFinalize(d); CFRelease(d); return ok;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) { fprintf(stderr, "usage: capture-terrain OUTPUT_DIRECTORY\n"); return 2; }
        setvbuf(stdout,NULL,_IOLBF,0);
        [NSApplication sharedApplication];
        NSString *out = @(argv[1]);
        [NSFileManager.defaultManager createDirectoryAtPath:out withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *error = nil;
        OwnRun *run = OwnRunLoad(@"Tests/fixtures/store/ecmwf/20260925T18Z", NSProcessInfo.processInfo.environment[@"ISOBAR_COAST"], &error);
        if (!run) { fprintf(stderr, "%s\n", error.UTF8String); return 1; }
        GPUMapView *view = [GPUMapView mapView];
        view.frame = NSMakeRect(0, 0, 1280, 720);
        [view adoptRun:run temperature:0 windFill:NO rain:NO];
        [view waitForUploads];
        struct { const char *name; double lat, lon; } places[] = {
            {"everest",27.9881,86.925}, {"alps",45.9763,7.6586},
            {"bluemtns",-33.70,150.30}, {"aoraki",-43.595,170.1418},
            {"tasmania",-41.85,146.0}};
        double pitches[] = {0, M_PI / 4, 1.30};
        // Overhead stays regional; tilted views come in to where ridges read
        // side-on. ISOBAR_CAPTURE_ZOOM overrides the tilted zoom.
        const char *zoomText = getenv("ISOBAR_CAPTURE_ZOOM");
        double tiltZoom = zoomText ? atof(zoomText) : 400;
        const char *only = getenv("ISOBAR_CAPTURE_ONLY");
        int failures = 0;
        for (int dark = 0; dark < 2; dark++) {
            if (getenv("ISOBAR_CAPTURE_LIGHT_ONLY") && dark) continue;
            view.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
            for (size_t p = 0; p < sizeof places / sizeof *places; p++) {
                if (only && !strstr(only, places[p].name)) continue;
                for (size_t t = 0; t < sizeof pitches / sizeof *pitches; t++) {
                    @autoreleasepool {
                        IsobarCamera camera = MapCameraMake(places[p].lat, places[p].lon, t ? tiltZoom : 64, t ? 1 : 0, 1280, 720);
                        camera.pitch = pitches[t]; view.camera = camera;
                        if (![view waitForTerrain]) { fprintf(stderr,"terrain timed out\n"); failures++; }
                        CGImageRef image = [view copySnapshot];
                        NSString *name = [NSString stringWithFormat:@"%s-%@-tilt%02ld.png", places[p].name, dark ? @"dark" : @"light", lround(pitches[t]*180/M_PI)];
                        if (!Save(image, [out stringByAppendingPathComponent:name])) failures++;
                        if (image) CGImageRelease(image);
                        printf("%s covered=%lu terrain=%llu\n", name.UTF8String,(unsigned long)view.terrainCoveredTexels,(unsigned long long)view.camera.terrain);
                    }
                }
            }
        }
        [view stopRendering];
        return failures ? 1 : 0;
    }
}
