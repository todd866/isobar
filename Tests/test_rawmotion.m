#import "ownrender.h"
#import "rawmovie.h"
#import "scrub.h"

static int failures;
static void check(BOOL okay, NSString *message) {
    fprintf(stderr, "%s %s\n", okay ? "ok  " : "FAIL", message.UTF8String);
    if (!okay) failures++;
}

// A moving, curved pressure field covering the actual map. A tiny offshore
// fixture can check arithmetic but cannot catch a renderer truncating time.
static OwnRun *SyntheticRun(NSString *directory) {
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSDictionary *manifest = @{
        @"grid":@{@"nx":@91,@"ny":@66,@"step":@1,@"west":@90,@"north":@5,@"dtype":@"float32",@"endian":@"little"},
        @"times":@[@"2026-09-27T00:00:00Z",@"2026-09-27T03:00:00Z"],
        @"run":@"2026-09-27T00:00:00Z", @"generated":@"2026-09-27T00:00:00Z"
    };
    [[NSJSONSerialization dataWithJSONObject:manifest options:0 error:NULL]
        writeToFile:[directory stringByAppendingPathComponent:@"manifest.json"] atomically:YES];
    for (NSString *field in @[@"msl",@"t850",@"t2m",@"u10",@"v10",@"rain24"]) {
        NSMutableData *data = [NSMutableData dataWithLength:91 * 66 * 2 * sizeof(float)];
        float *values = data.mutableBytes;
        for (int h = 0; h < 2; h++) for (int y = 0; y < 66; y++) for (int x = 0; x < 91; x++) {
            double dx = x - 40 - h * 5, dy = y - 38;
            float value = 1010 + .013 * dx * dx + .01 * dy * dy;
            if ([field isEqual:@"t850"]) value = 14 - .6 * y + h * 5;
            if ([field isEqual:@"t2m"]) value = 30 - .55 * y + h * 5;
            if ([field isEqual:@"u10"]) value = 8 + h * 2;
            if ([field isEqual:@"v10"]) value = 2 - h * 4;
            if ([field isEqual:@"rain24"]) value = 4 * exp(-(dx * dx + dy * dy) / 150);
            values[(h * 66 + y) * 91 + x] = value;
        }
        [data writeToFile:[directory stringByAppendingPathComponent:[field stringByAppendingPathExtension:@"f32"]] atomically:YES];
    }
    NSString *error = nil;
    OwnRun *run = OwnRunLoad(directory, @"Resources/ownchart-coast.bin", &error);
    check(run != nil, [NSString stringWithFormat:@"moving model fixture loads (%@)", error ?: @""]);
    return run;
}

static NSData *Pixels(NSImage *image) {
    CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cg) return nil;
    size_t width = CGImageGetWidth(cg), height = CGImageGetHeight(cg);
    NSMutableData *data = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(data.mutableBytes, width, height, 8, width * 4, space,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(space);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), cg);
    CGContextRelease(context);
    return data;
}

static NSUInteger ChangedPixels(NSData *a, NSData *b) {
    if (!a || a.length != b.length) return 0;
    const uint8_t *left = a.bytes, *right = b.bytes;
    NSUInteger changed = 0;
    for (NSUInteger i = 0; i < a.length; i += 4)
        if (abs(left[i]-right[i]) + abs(left[i+1]-right[i+1]) + abs(left[i+2]-right[i+2]) > 30) changed++;
    return changed;
}

static double MeanChange(NSData *a, NSData *b) {
    if (!a.length || a.length != b.length) return NAN;
    const uint8_t *left = a.bytes, *right = b.bytes;
    double sum = 0;
    for (NSUInteger i = 0; i < a.length; i += 4)
        sum += abs(left[i]-right[i]) + abs(left[i+1]-right[i+1]) + abs(left[i+2]-right[i+2]);
    return sum / (a.length / 4 * 3);
}

static BOOL WaitFor(BOOL (^ready)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!ready() && deadline.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.005]];
    return ready();
}

static void CheckLabelFade(void) {
    NSString *error = nil;
    OwnRun *run = OwnRunLoad(@"Tests/fixtures/grid025", @"Resources/ownchart-coast.bin", &error);
    check(run.hours >= 3, [NSString stringWithFormat:@"label-fade fixture loads (%@)", error ?: @""]);
    if (run.hours < 3) return;
    OwnLayerOptions layers = {.bare = 1};
    OwnMotionState *state = [OwnMotionState new];
    const int frames = 64;
    for (int i = 0; i < frames; i++) { @autoreleasepool {
        double hour = 0.35 + i * (30.0 / 3600.0);
        NSImage *image = OwnRunRenderMotion(run, hour, @"", layers, nil, 1, state);
        check(image != nil, @"a playback frame renders");
    }}
    CGPoint points[80];
    NSInteger labels = [state copyLabelPoints:points max:80];
    fprintf(stderr, "label fade changes %ld alpha step %.4f labels %ld\n",
        (long)state.labelSetChanges, state.maxAnnotationAlphaStep, (long)labels);
    check(labels >= 4, @"playback keeps several isobar labels");
    check(state.maxAnnotationAlphaStep <= 0.15 + 1e-9,
        @"label, centre and fragment alpha fades instead of jumping");
    check(state.labelSetChanges <= 8, @"the set of labels changes rarely across playback frames");
}

int main(void) { @autoreleasepool {
    CheckLabelFade();
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    @try {
        OwnRun *run = SyntheticRun(directory);
        OwnLayerOptions pressure = {.bare = 1};
        NSData *start = Pixels(OwnRunRenderFraction(run, 0, @"", pressure, nil, 1));
        NSData *middle = Pixels(OwnRunRenderFraction(run, .5, @"", pressure, nil, 1));
        NSData *end = Pixels(OwnRunRenderFraction(run, 1, @"", pressure, nil, 1));
        check(ChangedPixels(start, middle) > 1000 && ChangedPixels(middle, end) > 1000,
            @"half-hour rendering moves real contour pixels between both endpoints");
        OwnMotionState *state = [OwnMotionState new];
        NSData *previous = nil;
        NSUInteger movingFrames = 0;
        for (int frame = 0; frame < 90; frame++) { @autoreleasepool {
            NSData *current = Pixels(OwnRunRenderMotion(run, frame / 89.0, @"", pressure, nil, 1, state));
            if (previous && ChangedPixels(previous, current) > 20) movingFrames++;
            previous = current;
        }}
        check(movingFrames == 89, @"every in-between frame advances the raw pressure field");
        check(state.maxLabelStep > 0 && state.maxLabelStep <= 2.001 && state.maxCentreStep <= 2.001,
            @"moving annotations have bounded displacement");
        check([start isEqual:Pixels(OwnRunRenderFraction(run, 0, @"", pressure, nil, 1))],
            @"motion state leaves static map pixels unchanged");
        IsobarScrubRenderer *scrub = [[IsobarScrubRenderer alloc] initWithRun:run layers:pressure scale:1];
        NSMutableArray<NSNumber *> *delivered = [NSMutableArray array];
        __block NSImage *scrubImage = nil;
        IsobarScrubCompletion record = ^(NSImage *image, double index) {
            check(NSThread.isMainThread && image != nil, @"scrub completion carries an image on main thread");
            [delivered addObject:@(index)]; scrubImage = image;
        };
        [scrub requestIndex:.1 completion:record];
        for (int i=2; i<=9; i++) [scrub requestIndex:i/10.0 completion:record];
        check(WaitFor(^BOOL{ return delivered.count == 2; }) && scrub.renderCount == 2 &&
            fabs(delivered.firstObject.doubleValue-.1)<.00001 && fabs(delivered.lastObject.doubleValue-.9)<.00001,
            @"cold scrub renders first and latest target without queuing obsolete pointer events");
        NSImage *cachedImage = scrubImage;
        NSUInteger renders = scrub.renderCount;
        [scrub requestIndex:.9 completion:record];
        check(WaitFor(^BOOL{ return delivered.count == 3; }) && scrub.renderCount == renders && scrubImage == cachedImage,
            @"revisiting a prepared scrub frame reuses its decoded image");
        [delivered removeAllObjects];
        [scrub requestIndex:.22 completion:record];
        [scrub requestIndex:.33 completion:record];
        [scrub cancelRequests];
        [scrub requestIndex:.44 completion:record];
        check(WaitFor(^BOOL{ return delivered.count == 1; }) && fabs(delivered.lastObject.doubleValue-.44)<.00001,
            @"cancel suppresses active and queued callbacks while allowing a new target");
        [delivered removeAllObjects];
        [scrub requestIndex:.55 completion:record];
        [scrub requestIndex:.9 completion:record];
        check(WaitFor(^BOOL{ return delivered.count == 1; }) && scrubImage == cachedImage,
            @"cache hit supersedes an unfinished raw render");
        // Wait for the old raw render to exit: it must never replace that hit.
        NSDate *settled = [NSDate dateWithTimeIntervalSinceNow:.15];
        while (settled.timeIntervalSinceNow > 0)
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.005]];
        check(delivered.count == 1, @"superseded raw render cannot paint over a cached target");
        NSData *priorScrub = nil;
        NSUInteger distinctScrub = 0;
        for (int i=0; i<30; i++) {
            [delivered removeAllObjects];
            [scrub requestIndex:.2 + .6*i/29.0 completion:record];
            BOOL received = WaitFor(^BOOL{ return delivered.count > 0; });
            NSData *pixels = received ? Pixels(scrubImage) : nil;
            if (priorScrub && ChangedPixels(priorScrub,pixels)>20) distinctScrub++;
            priorScrub = pixels;
        }
        check(distinctScrub == 29, @"cold scrubbing produces distinct intermediate raw-data frames");
        [scrub cancelRequests];
        IsobarScrubRenderer *reversal=[[IsobarScrubRenderer alloc] initWithRun:run layers:pressure scale:1];
        [delivered removeAllObjects];
        [reversal requestIndex:.8 completion:record];
        check(WaitFor(^BOOL{ return delivered.count==1; }), @"reverse-scrub fixture has a displayed frame");
        [reversal requestIndex:.2 completion:record];
        [reversal requestIndex:.95 completion:record];
        check(WaitFor(^BOOL{ return delivered.count==2; }) &&
            fabs(delivered.lastObject.doubleValue-.95)<.00001,
            @"reversing the pointer skips a stale frame in the wrong direction");
        IsobarScrubRenderer *moving=[[IsobarScrubRenderer alloc] initWithRun:run layers:pressure scale:1];
        [delivered removeAllObjects];
        NSUInteger duringMove=0;
        for (int i=0;i<30;i++) {
            [moving requestIndex:.1+.8*i/29.0 completion:record];
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                beforeDate:[NSDate dateWithTimeIntervalSinceNow:1.0/60.0]];
            if (i==24) duringMove=delivered.count;
        }
        check(duringMove>=5 && WaitFor(^BOOL{ return delivered.count>duringMove &&
            fabs(delivered.lastObject.doubleValue-.9)<.001; }),
            @"continuous pointer movement displays multiple frames before it stops");
        BOOL forward=YES;
        for (NSUInteger i=1;i<delivered.count;i++)
            if (delivered[i].doubleValue+1e-6<delivered[i-1].doubleValue) forward=NO;
        check(forward,@"continuous forward scrub never displays a backward frame");
        const char *publishedPath = getenv("ISOBAR_TEST_PUBLISHED_DATA");
        if (publishedPath) {
            NSString *loadError = nil;
            OwnRun *published = OwnRunLoadPublished([NSString stringWithUTF8String:publishedPath], NO,
                @"Resources/ownchart-coast.bin", &loadError);
            check(published && published.hours > 32,
                [NSString stringWithFormat:@"published scrub benchmark loads (%@)",loadError ?: @""]);
            if (published && published.hours > 32) {
                OwnLayerOptions active = {.bare=1,.rain=1,.barbs=1};
                IsobarScrubRenderer *live=[[IsobarScrubRenderer alloc] initWithRun:published layers:active scale:1];
                __block NSUInteger frames=0;
                NSTimeInterval began=NSProcessInfo.processInfo.systemUptime;
                for (int i=0;i<120;i++) {
                    double index=4+28*i/119.0;
                    [live requestIndex:index completion:^(NSImage *image, double renderedIndex) {
                        (void)renderedIndex;
                        if (image) frames++;
                    }];
                    NSTimeInterval deadline=began+(i+1)/60.0;
                    while (NSProcessInfo.processInfo.systemUptime<deadline)
                        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                            beforeDate:[NSDate dateWithTimeIntervalSinceNow:.002]];
                }
                fprintf(stderr,"scrub benchmark: %lu/120 frames during 2-second sweep\n",(unsigned long)frames);
                // Shared developer machines have other renderers and builds
                // competing for CPU. Let a controlled benchmark set its own
                // acceptance target; always report the observed cadence.
                const char *minimum=getenv("ISOBAR_TEST_MIN_SCRUB_FRAMES");
                if (minimum) check(frames>=(NSUInteger)strtoul(minimum,NULL,10),
                    @"published wind and rain scrub meets the requested cadence");
            }
        }
        for (NSString *name in @[@"temperature",@"wind",@"rain"]) {
            OwnLayerOptions layer = {.bare = 1, .temperature=[name isEqual:@"temperature"]?2:0,
                .barbs=[name isEqual:@"wind"], .rain=[name isEqual:@"rain"]};
            NSData *plain = Pixels(OwnRunRenderMotion(run, .5, @"", pressure, nil, 1, [OwnMotionState new]));
            NSData *overlay = Pixels(OwnRunRenderMotion(run, .5, @"", layer, nil, 1, [OwnMotionState new]));
            check(ChangedPixels(plain, overlay) > 300, [NSString stringWithFormat:@"%@ changes motion pixels", name]);
        }
        NSMutableData *rain = [NSMutableData dataWithLength:91*66*2*sizeof(float)];
        float *rainValues = rain.mutableBytes;
        for (int h = 0; h < 2; h++) for (int p = 0; p < 91*66; p++) rainValues[h*91*66+p] = .75 + h*.5;
        [rain writeToFile:[directory stringByAppendingPathComponent:@"rain24.f32"] atomically:YES];
        OwnRun *thresholdRun = OwnRunLoad(directory,@"Resources/ownchart-coast.bin",NULL);
        double lastRainChange = -1;
        BOOL gradualRain = YES;
        for (int step = 0; step <= 4; step++) {
            double hour = step / 4.0;
            OwnLayerOptions wet = {.bare=1,.rain=1};
            NSData *plain = Pixels(OwnRunRenderMotion(thresholdRun,hour,@"",pressure,nil,1,[OwnMotionState new]));
            NSData *hatched = Pixels(OwnRunRenderMotion(thresholdRun,hour,@"",wet,nil,1,[OwnMotionState new]));
            double change = MeanChange(plain,hatched);
            if (change < lastRainChange + .02) gradualRain = NO;
            lastRainChange = change;
        }
        check(gradualRain,@"rain hatch fades continuously through the 1 mm threshold");

        NSString *pressurePath = [directory stringByAppendingPathComponent:@"msl.f32"];
        NSMutableData *missing = [NSMutableData dataWithContentsOfFile:pressurePath];
        float *pressureValues = missing.mutableBytes;
        pressureValues[38*91+40] = NAN; pressureValues[91*66+38*91+40] = NAN;
        [missing writeToFile:pressurePath atomically:YES];
        OwnRun *missingRun = OwnRunLoad(directory,@"Resources/ownchart-coast.bin",NULL);
        NSData *complete = Pixels(OwnRunRenderMotion(run,.5,@"",pressure,nil,1,[OwnMotionState new]));
        NSData *withHole = Pixels(OwnRunRenderMotion(missingRun,.5,@"",pressure,nil,1,[OwnMotionState new]));
        NSUInteger missingChanges = ChangedPixels(complete,withHole);
        check(isnan([missingRun valueAtPointIndex:38*91+40 field:OwnRunFieldMSLP fractionalHour:.5]) &&
            missingChanges < 2500, [NSString stringWithFormat:@"missing pressure stays local (%lu changed pixels)",(unsigned long)missingChanges]);
        NSURL *target = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:@"cancelled.mp4"]];
        NSProgress *cancel = [NSProgress progressWithTotalUnitCount:30]; [cancel cancel];
        NSString *error = nil;
        check(!IsobarWriteRawMovie(run,target,0,1,30,1,pressure,cancel,&error) &&
            ![NSFileManager.defaultManager fileExistsAtPath:target.path], @"cancel before encoding leaves no partial movie");
        [@"existing" writeToURL:target atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        check(!IsobarWriteRawMovie(run,target,0,1,30,1,pressure,nil,&error) &&
            [[NSString stringWithContentsOfURL:target encoding:NSUTF8StringEncoding error:NULL] isEqual:@"existing"],
            @"movie export never overwrites an existing destination");
    } @finally { [NSFileManager.defaultManager removeItemAtPath:directory error:NULL]; }
    return failures ? 1 : 0;
}}
