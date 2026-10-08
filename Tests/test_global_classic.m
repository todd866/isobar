#import "ownrender.h"
#import "ownchart.h"
#import <ImageIO/ImageIO.h>
#import <stdio.h>
#import <stdlib.h>

int main(void) {
    @autoreleasepool {
        NSDictionary *env = NSProcessInfo.processInfo.environment;
        NSString *root = env[@"ISOBAR_DATA_ROOT"] ?: @"build/global-archive";
        NSString *coast = env[@"ISOBAR_WORLD_COAST"] ?: @"Resources/world-coast.bin";
        NSString *error = nil;
        OwnRun *run = OwnRunLoadPublished(root, NO, coast, &error);
        if (!run) { fprintf(stderr, "FAIL %s\n", error.UTF8String ?: "global classic load"); return 2; }
        const double places[][2] = {{51.5, -0.1}, {0, 179.5}, {90, 0}, {-90, 0}};
        for (NSUInteger i = 0; i < sizeof places / sizeof places[0]; i++) {
            double x = 0, y = 0;
            if (!OwnChartImagePoint(places[i][0], places[i][1], &x, &y) ||
                !isfinite(x) || !isfinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
                fprintf(stderr, "FAIL global map fraction %.1f %.1f\n", places[i][0], places[i][1]);
                return 2;
            }
        }
        OwnLayerOptions layers = {0}; layers.bare = 1;
        // The real application prepares its classic plate on background
        // rendering threads. A cold world-coast stroke used to take >20 s.
        // Exercise each first rasterization and both cache scale transitions.
        dispatch_queue_t renderQueue = dispatch_queue_create("isobar.global-classic-test", DISPATCH_QUEUE_SERIAL);
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        __block BOOL plateOK = YES;
        dispatch_async(renderQueue, ^{
            @autoreleasepool {
                OwnLayerOptions plateLayers = {0}; plateLayers.bare = 1; plateLayers.plateOnly = 1;
                for (NSNumber *scale in @[@1, @1, @2, @1]) {
                    CFAbsoluteTime began = CFAbsoluteTimeGetCurrent();
                    NSImage *frame = OwnRunRender(run, 26, @"", plateLayers, nil, scale.doubleValue);
                    double elapsed = CFAbsoluteTimeGetCurrent() - began;
                    CGImageRef cg = [frame CGImageForProposedRect:NULL context:nil hints:nil];
                    BOOL valid = cg && CGImageGetWidth(cg) == (size_t)(580 * scale.intValue);
                    if (!valid || elapsed > 5.0) plateOK = NO;
                    fprintf(stderr, "%s global coast plate %dx %.3fs\n", valid && elapsed <= 5.0 ? "ok" : "FAIL", scale.intValue, elapsed);
                }
            }
            dispatch_semaphore_signal(finished);
        });
        if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_SEC)) || !plateOK)
            return 2;
        NSImage *image = OwnRunRender(run, 26, @"Global classic", layers, nil, 1);
        if (!image || image.size.width < 1 || image.size.height < 1) { fprintf(stderr, "FAIL global classic render\n"); return 2; }
        CGImageRef rendered = [image CGImageForProposedRect:NULL context:nil hints:nil];
        CFDataRef pixels = CGDataProviderCopyData(CGImageGetDataProvider(rendered));
        layers.plateOnly = 1;
        NSImage *plate = OwnRunRender(run, 26, @"Global plate", layers, nil, 1);
        CGImageRef plateImage = [plate CGImageForProposedRect:NULL context:nil hints:nil];
        if (!plateImage) { CFRelease(pixels); return 2; }
        CFDataRef platePixels = CGDataProviderCopyData(CGImageGetDataProvider(plateImage));
        if (CFDataGetLength(pixels) != CFDataGetLength(platePixels)) { CFRelease(pixels); CFRelease(platePixels); return 2; }
        const unsigned char *plateBytes = CFDataGetBytePtr(platePixels);
        const unsigned char *bytes = CFDataGetBytePtr(pixels);
        size_t dark = 0, weather = 0, total = CFDataGetLength(pixels) / 4;
        for (size_t i = 0; i < total; i++) {
            if (bytes[i * 4] < 100 && bytes[i * 4 + 1] < 110 && bytes[i * 4 + 2] < 120) dark++;
            if (bytes[i * 4] + 50 < plateBytes[i * 4] && bytes[i * 4 + 1] + 50 < plateBytes[i * 4 + 1]) weather++;
        }
        CFRelease(pixels);
        CFRelease(platePixels);
        if (weather < 1000) { fprintf(stderr, "FAIL global classic has no weather beyond its coast plate (%zu)\n", weather); return 2; }
        NSString *out = env[@"ISOBAR_GLOBAL_CLASSIC_PNG"];
        if (out.length) {
            CGImageRef cg = rendered;
            CGImageDestinationRef dst = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:out], CFSTR("public.png"), 1, NULL);
            if (!dst) return 2;
            CGImageDestinationAddImage(dst, cg, NULL);
            BOOL ok = CGImageDestinationFinalize(dst);
            CFRelease(dst);
            if (!ok) return 2;
        }
        fprintf(stderr, "ok global classic %.0fx%.0f dark=%zu weather=%zu\n", image.size.width, image.size.height, dark, weather);
        run = nil;
        setenv("ISOBAR_WORLD_COAST", "/nonexistent/isobar-world-coast.bin", 1);
        error = nil;
        OwnRun *bad = OwnRunLoadPublished(root, NO, OwnCoastPath(), &error);
        if (bad || !error.length) { fprintf(stderr, "FAIL global run accepted missing world coast with regional fallback\n"); return 2; }
        fprintf(stderr, "ok global run rejects a missing world coast even when regional coast exists\n");
        return 0;
    }
}
