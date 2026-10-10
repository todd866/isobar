// Deterministic playback-cache regression tests. No controller, timer, or real
// render is needed.
#import "playback.h"
#import <Cocoa/Cocoa.h>

@interface IsobarLivePlayer (PlaybackTesting)
- (void)noteRenderSeconds:(double)seconds;
- (void)publish;
- (void)storeImage:(NSImage *)image plate:(NSImage *)plate labels:(NSArray *)labels centres:(NSArray *)centres step:(NSInteger)step;
@end

static int failures;

// A thin contour moving across a large map must remain one contour. The old
// image dissolve produced two grey outlines even though its motion score passed.
static NSImage *ContourFrame(CGFloat x) {
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, 1540, 1180, 8, 1540 * 4, space,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(space);
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, 1540, 1180));
    if (x >= 0) {
        CGContextSetRGBFillColor(context, .1, .1, .1, 1);
        CGContextFillRect(context, CGRectMake(x, 0, 3, 1180));
    }
    CGImageRef cg = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    NSImage *image = [[NSImage alloc] initWithCGImage:cg size:NSMakeSize(580, 444)];
    CGImageRelease(cg);
    return image;
}

static int ContoursAcrossMiddle(NSImage *image) {
    CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cg) return -1;
    NSMutableData *pixels = [NSMutableData dataWithLength:1540 * 1180 * 4];
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, 1540, 1180, 8, 1540 * 4, space,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(space);
    CGContextDrawImage(context, CGRectMake(0, 0, 1540, 1180), cg);
    CGContextRelease(context);
    const uint8_t *bytes = pixels.bytes;
    int lines = 0;
    BOOL previous = NO;
    for (int x = 0; x < 1540; x++) {
        BOOL ink = bytes[(590 * 1540 + x) * 4] < 235;
        if (ink && !previous) lines++;
        previous = ink;
    }
    return lines;
}

static void Check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s %s\n", condition ? "ok  " : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void SeedFrameCache(IsobarLivePlayer *player) {
    [player setValue:[NSMutableDictionary dictionaryWithObject:[NSImage new] forKey:@0] forKey:@"frames"];
    [player setValue:[NSMutableDictionary dictionaryWithObject:@1 forKey:@0] forKey:@"frameBytes"];
    [player setValue:[NSMutableArray arrayWithObject:@0] forKey:@"lru"];
    [player setValue:@1 forKey:@"bytes"];
}

static void TestMovingContourHasNoGhost(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    NSImage *first = ContourFrame(600), *next = ContourFrame(612);
    [player setValue:[NSMutableDictionary dictionaryWithDictionary:@{@0:first, @1:next}] forKey:@"frames"];
    [player setValue:@2 forKey:@"stepCount"];
    for (NSNumber *fraction in @[@.25, @.5, @.75]) {
        [player setValue:@(fraction.doubleValue * player.frameSpacing / 3600) forKey:@"hours"];
        [player publish];
        Check(ContoursAcrossMiddle(player.displayedImage) == 1,
            @"a moving pressure contour has one outline, including between cached frames");
    }
}

static void TestSpacingChangeKeepsOldKeysUntilCalibrated(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed1x);
    // Establish a non-default spacing first. This is the state the old
    // speed-change reset discarded before it had three samples for the new
    // speed.
    [player noteRenderSeconds:0.005];
    [player noteRenderSeconds:0.005];
    [player noteRenderSeconds:0.005];
    Check(player.frameSpacing == 2,
        @"initial calibration establishes a finer frame spacing");
    SeedFrameCache(player);

    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed16x);
    [player noteRenderSeconds:1.0];
    Check(player.frameSpacing == 2,
        @"speed change keeps the old frame spacing during calibration");
    Check([[player valueForKey:@"frames"] count] == 1,
        @"cached frame indices remain valid before recalibration completes");

    [player noteRenderSeconds:1.0];
    [player noteRenderSeconds:1.0];
    Check(player.frameSpacing == 32,
        @"third render sample applies the measured spacing");
    Check([[player valueForKey:@"frames"] count] == 0 &&
        [[player valueForKey:@"labels"] count] == 0 &&
        [[player valueForKey:@"centres"] count] == 0 &&
        [[player valueForKey:@"lru"] count] == 0 &&
        [player cacheBytes] == 0,
        @"spacing recalibration invalidates all frame caches atomically");
}

static void TestRapidSpeedChangesKeepMapping(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed1x);
    for (int i = 0; i < 3; i++) [player noteRenderSeconds:.005];
    SeedFrameCache(player);
    for (NSNumber *speed in @[@(IsobarLiveSpeed16x), @(IsobarLiveSpeed4x),
        @(IsobarLiveSpeed1x), @(IsobarLiveSpeed16x), @(IsobarLiveSpeed1x)]) {
        player.hoursPerSecond = IsobarLiveHoursPerSecond((IsobarLiveSpeed)speed.integerValue);
        [player noteRenderSeconds:.03];
        [player noteRenderSeconds:.03];
        Check(player.frameSpacing == 2 && [[player valueForKey:@"frames"] count] == 1,
            @"rapid speed changes retain the cached time mapping until one speed is calibrated");
    }
    [player noteRenderSeconds:.03];
    Check(player.frameSpacing == 6 && [[player valueForKey:@"frames"] count] == 0,
        @"settling at the final speed replaces the mapping and cache together");
}

static void TestSpeedRatesAndAdvancement(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    // Give clampedAdvance a contiguous ladder so each one-second tick can
    // advance through as many frame steps as its selected rate requires.
    NSMutableDictionary *frames = [NSMutableDictionary dictionary];
    for (NSInteger step = 0; step < 400; step++) frames[@(step)] = [NSImage new];
    [player setValue:frames forKey:@"frames"];
    [player setValue:@400 forKey:@"stepCount"];
    [player setValue:@8.0 forKey:@"spanHours"];
    [player setValue:@0.0 forKey:@"hours"];
    [player setValue:@YES forKey:@"playing"];
    NSArray *speeds = @[@(IsobarLiveSpeedRealTime), @(IsobarLiveSpeed1x), @(IsobarLiveSpeed2x),
        @(IsobarLiveSpeed4x), @(IsobarLiveSpeed8x), @(IsobarLiveSpeed16x),
        @(IsobarLiveSpeed32x), @(IsobarLiveSpeed64x),
        @(IsobarLiveSpeed128x), @(IsobarLiveSpeed256x)];
    for (NSNumber *raw in speeds) {
        player.hoursPerSecond = IsobarLiveHoursPerSecond((IsobarLiveSpeed)raw.integerValue);
        [player setValue:@0.0 forKey:@"hours"];
        for (NSInteger tick = 0; tick < 4; tick++) [player tick:0.25];
        double expected = raw.integerValue == 0 ? 1.0 / 3600.0 : raw.doubleValue / 60.0;
        Check(fabs([player valueForKey:@"hours"] ? [[player valueForKey:@"hours"] doubleValue] - expected : -1) < 1e-8,
            [NSString stringWithFormat:@"%@x advances exactly %@ forecast hours per real second", raw, @(expected)]);
    }
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeedRealTime);
    [player setValue:@0.0 forKey:@"hours"];
    [player setValue:[NSMutableDictionary dictionary] forKey:@"frames"];
    [player tick:90];
    Check(fabs([[player valueForKey:@"hours"] doubleValue] - 90.0/3600.0)<1e-9,
        @"real time keeps 90 elapsed seconds even when rendering is late");
    Check(IsobarLiveSpeedIsValid(IsobarLiveSpeedRealTime) && IsobarLiveSpeedIsValid(IsobarLiveSpeed1x) &&
        IsobarLiveSpeedIsValid(IsobarLiveSpeed16x) &&
        IsobarLiveSpeedIsValid(IsobarLiveSpeed64x) &&
        IsobarLiveSpeedIsValid(IsobarLiveSpeed128x) &&
        IsobarLiveSpeedIsValid(IsobarLiveSpeed256x) &&
        !IsobarLiveSpeedIsValid((IsobarLiveSpeed)3),
        @"Real time and the nine accelerated rates are valid");
    Check(fabs(IsobarLiveHoursPerSecond((IsobarLiveSpeed)99) - 8.0 / 60.0) < 1e-9,
        @"invalid playback values fall back to 8x");
}

static void TestLoopDissolvesTheEndpoints(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    NSImage *now = ContourFrame(600), *end = ContourFrame(612);
    [player setValue:[NSMutableDictionary dictionaryWithDictionary:@{@0:now, @1:end}] forKey:@"frames"];
    [player setValue:@2 forKey:@"stepCount"];
    [player setValue:@YES forKey:@"seaming"];
    [player setValue:@0.1 forKey:@"seam"];
    [player publish];
    Check(player.seamMix <= 0.001 && ContoursAcrossMiddle(player.displayedImage) == 1,
        @"the seam holds the last frame before the dissolve");
    [player setValue:@0.7 forKey:@"seam"];
    [player publish];
    Check(player.seamMix > 0.4 && player.seamMix < 0.7 &&
        fabs(player.nextOpacity - player.seamMix) < 1e-4 &&
        ContoursAcrossMiddle(player.displayedImage) == 2,
        @"the dissolve blends the end frame into the now frame");
}

// Fast play used to sweep forecast hours backwards for the whole seam. The
// seam now holds the last hour, dissolves the end frame into now, and jumps
// once. Sampled hours may drop only on that return.
static void TestFastLoopsDissolveForward(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    IsobarLiveClock *clock = [IsobarLiveClock manualClock];
    player.clock = clock;
    [player setValue:@3600 forKey:@"spacing"];
    [player setValue:@YES forKey:@"spacingLocked"];
    NSDate *start = [NSDate dateWithTimeIntervalSince1970:1700000000];
    const double span = 3;
    NSDate *end = [start dateByAddingTimeInterval:span * 3600];
    [player configureRun:nil start:start end:end now:start modelIndex:^double(NSDate *date) {
        return [date timeIntervalSinceDate:start] / 3600.0;
    }];
    NSMutableDictionary *frames = [NSMutableDictionary dictionary];
    NSImage *nowFrame = ContourFrame(600), *endFrame = ContourFrame(900);
    NSInteger steps = [[player valueForKey:@"stepCount"] integerValue];
    for (NSInteger step = 0; step < steps; step++)
        frames[@(step)] = step == 0 ? nowFrame : endFrame;
    [player setValue:frames forKey:@"frames"];
    player.hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeed256x);
    [player playFromDate:start];

    double previous = [player forecastHoursAtTime:[clock now]];
    int drops = 0, seams = 0;
    BOOL inSeam = NO, sawHold = NO, sawDissolve = NO;
    NSTimeInterval seamBegan = -1;
    for (int tick = 0; tick < 400 && seams < 4; tick++) {
        [clock advance:kIsobarLiveDisplayTick];
        [player tick:kIsobarLiveDisplayTick];
        double hours = [player forecastHoursAtTime:[clock now]];
        double ahead = [player forecastHoursAtTime:[clock now] + 0.5 * kIsobarLiveDisplayTick];
        Check(player.playheadRate >= -1e-12, @"a playing rate is never negative");
        if (player.playing && !player.seaming)
            Check(player.playheadRate > 0, @"forward play reports its positive rate");
        if (hours + 1e-3 < previous) {
            drops++;
            Check(hours <= 0.05 && previous >= span - 0.05,
                @"the only backwards step is the return from the end of the run to now");
        } else {
            Check(hours + 1e-9 >= previous, @"forecast hours do not decrease");
        }
        if (player.seaming) {
            if (!inSeam) seamBegan = [clock now];
            inSeam = YES;
            double elapsed = [clock now] - seamBegan;
            double shown = [player.playhead timeIntervalSinceDate:start] / 3600.0;
            Check(fabs(hours - span) < 1e-3 && fabs(ahead - span) < 1e-3 && fabs(shown - span) < 1e-3,
                @"the seam holds the last forecast hour, including a sample between ticks");
            Check(fabs([player modelIndexAtTime:[clock now]] - span) < 1e-3,
                @"the map samples the last hour during the seam");
            if (elapsed + 1e-9 < kIsobarLiveSeamHold) {
                sawHold = YES;
                Check(player.seamMix <= 0.001 && player.nextOpacity <= 0.02,
                    @"the seam holds the last frame before it dissolves");
            } else if (elapsed + 1e-6 >= kIsobarLiveSeamHold + kIsobarLiveDisplayTick) {
                double mix = MIN(1, (elapsed - kIsobarLiveSeamHold) / kIsobarLiveSeamDissolve);
                if (player.seamMix > 0.35 && player.seamMix < 0.7) {
                    sawDissolve = YES;
                    Check(ContoursAcrossMiddle(player.displayedImage) == 2,
                        @"the dissolve blends the end frame into the now frame");
                }
                Check(fabs(player.nextOpacity - player.seamMix) < 1e-3 && fabs(player.seamMix - mix) < 0.08,
                    @"the seam's on-screen time is the dissolve");
            }
            Check(ahead + 1e-9 >= hours, @"the seam does not rewind between ticks");
        } else if (inSeam) {
            inSeam = NO;
            seams++;
            seamBegan = -1;
        }
        if (!player.seaming)
            Check(ahead + 1e-6 >= hours, @"a future sample does not move backwards");
        previous = ahead;
    }
    Check(seams >= 4 && drops == seams, @"each loop has one discontinuity back to now");
    Check(sawHold && sawDissolve, @"each loop holds the last frame, then dissolves");
}

static void TestPlateRetentionIsBudgeted(void) {
    IsobarLivePlayer *player = [IsobarLivePlayer new];
    NSImage *image = ContourFrame(600), *plate = ContourFrame(-1);
    NSUInteger frameCost = 1540 * 1180 * 4 * 2;
    player.byteBudget = frameCost * 2;
    [player setValue:@4 forKey:@"stepCount"];
    for (NSInteger step = 0; step < 3; step++)
        [player storeImage:image plate:plate labels:@[] centres:@[] step:step];
    Check(player.cacheBytes == frameCost * 2 &&
        [[player valueForKey:@"frames"] count] == 2 &&
        [[player valueForKey:@"framePlates"] count] == 2,
        @"cache eviction includes the retained flat plates and their actual raster bytes");
    [player stopRendering];
    Check(player.cacheBytes == frameCost &&
        [[player valueForKey:@"framePlates"] count] == 1,
        @"stopping keeps only the displayed frame and its budgeted plate");
    [player storeImage:image plate:nil labels:@[] centres:@[] step:3];
    Check(player.cacheBytes == frameCost && [[player valueForKey:@"frames"] count] == 1,
        @"a failed flat-plate render cannot publish transparent pressure ink over an older map");
}

int main(void) {
    @autoreleasepool {
        TestSpacingChangeKeepsOldKeysUntilCalibrated();
        TestRapidSpeedChangesKeepMapping();
        TestSpeedRatesAndAdvancement();
        TestMovingContourHasNoGhost();
        TestLoopDissolvesTheEndpoints();
        TestFastLoopsDissolveForward();
        TestPlateRetentionIsBudgeted();
    }
    return failures ? 1 : 0;
}
