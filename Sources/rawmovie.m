#import "rawmovie.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <unistd.h>

BOOL IsobarWriteRawMovie(OwnRun *run, NSURL *output, double fromIndex, double toIndex,
    NSInteger fps, double duration, OwnLayerOptions layers, NSProgress *progress,
    NSString **error) {
    IsobarMovieEncode encode = {0};
    return IsobarWriteRawMovieWithEncode(run, output, fromIndex, toIndex, fps, duration, layers, encode, progress, error);
}

BOOL IsobarWriteRawMovieWithEncode(OwnRun *run, NSURL *output, double fromIndex, double toIndex,
    NSInteger fps, double duration, OwnLayerOptions layers, IsobarMovieEncode encode,
    NSProgress *progress, NSString **error) {
    if (!run || !output.isFileURL || !isfinite(fromIndex) || !isfinite(toIndex) ||
        fromIndex < 0 || toIndex <= fromIndex || toIndex > run.hours - 1 ||
        fps < 24 || fps > 60 || !isfinite(duration) || duration < 1 || duration > 120 ||
        !isfinite(encode.quality) || encode.quality < 0 || encode.quality > 1 ||
        [NSFileManager.defaultManager fileExistsAtPath:output.path]) {
        if (error) *error = @"Invalid animation request";
        return NO;
    }
    const int width = 1160, height = 888;
    NSError *failure = nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:output.URLByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:&failure]) {
        if (error) *error = failure.localizedDescription;
        return NO;
    }
    if (progress.cancelled) { if (error) *error=@"Animation cancelled"; return NO; }
    NSInteger frames = (NSInteger)llround(duration * fps);
    progress.totalUnitCount = frames;
    layers.bare = 1;
    layers.observed = 0; // A moving forecast must never animate station observations.
    AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:output fileType:AVFileTypeMPEG4 error:&failure];
    // The app path is average bitrate. Site export passes VideoToolbox Quality
    // (the compression key is @"Quality"; AVVideoQualityKey is JPEG-only).
    NSDictionary *compression = encode.quality > 0 ? @{
        @"Quality": @(encode.quality),
        AVVideoProfileLevelKey: encode.highProfile ? AVVideoProfileLevelH264HighAutoLevel : AVVideoProfileLevelH264MainAutoLevel,
        AVVideoExpectedSourceFrameRateKey: @(fps),
        AVVideoMaxKeyFrameIntervalKey: @(encode.keyframeInterval > 0 ? encode.keyframeInterval : fps),
        AVVideoMaxKeyFrameIntervalDurationKey: @1.0,
        AVVideoAllowFrameReorderingKey: @NO,
        AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
    } : @{
        AVVideoAverageBitRateKey: @(fps > 30 ? 6000000 : 4000000),
        AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
        AVVideoExpectedSourceFrameRateKey: @(fps), AVVideoMaxKeyFrameIntervalKey: @(fps),
        AVVideoAllowFrameReorderingKey: @NO};
    AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
        AVVideoCodecKey:AVVideoCodecTypeH264, AVVideoWidthKey:@(width), AVVideoHeightKey:@(height),
        AVVideoCompressionPropertiesKey:compression}];
    input.expectsMediaDataInRealTime = NO;
    AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input sourcePixelBufferAttributes:@{
        (NSString *)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA),
        (NSString *)kCVPixelBufferWidthKey:@(width), (NSString *)kCVPixelBufferHeightKey:@(height),
        (NSString *)kCVPixelBufferCGImageCompatibilityKey:@YES,
        (NSString *)kCVPixelBufferCGBitmapContextCompatibilityKey:@YES}];
    if (!writer || ![writer canAddInput:input]) {
        if (error) *error = failure.localizedDescription ?: @"Video encoder unavailable";
        [NSFileManager.defaultManager removeItemAtURL:output error:NULL];
        return NO;
    }
    [writer addInput:input];
    writer.shouldOptimizeForNetworkUse = YES;
    if (![writer startWriting]) {
        if(error) *error=writer.error.localizedDescription;
        [NSFileManager.defaultManager removeItemAtURL:output error:NULL];
        return NO;
    }
    [writer startSessionAtSourceTime:kCMTimeZero];
    BOOL okay = YES;
    NSString *reason = nil;
    OwnMotionState *motion = [OwnMotionState new];
    for (NSInteger i = 0; i < frames && okay; i++) { @autoreleasepool {
        if (progress.cancelled) { okay=NO; reason=@"Animation cancelled"; break; }
        double fraction = fromIndex + (toIndex - fromIndex) * i / (frames - 1);
        NSImage *image = OwnRunRenderMotion(run, fraction, @"", layers, nil, 2, motion);
        CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
        if (!cg) { okay=NO; reason=@"Could not render weather frame"; break; }
        NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 30;
        while (!input.readyForMoreMediaData && writer.status == AVAssetWriterStatusWriting &&
            !progress.cancelled && NSProcessInfo.processInfo.systemUptime < deadline) usleep(2000);
        if (!input.readyForMoreMediaData || progress.cancelled) {
            okay=NO; reason=progress.cancelled ? @"Animation cancelled" : @"Video encoder stopped responding"; break;
        }
        CVPixelBufferRef buffer = NULL;
        if (!adaptor.pixelBufferPool || CVPixelBufferPoolCreatePixelBuffer(NULL, adaptor.pixelBufferPool, &buffer) != kCVReturnSuccess) {
            okay=NO; reason=@"Could not allocate video frame"; break;
        }
        CVPixelBufferLockBaseAddress(buffer, 0);
        CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(buffer), width, height,
            8, CVPixelBufferGetBytesPerRow(buffer), colors, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
        CGColorSpaceRelease(colors);
        if (context) {
            CGContextDrawImage(context, CGRectMake(0,0,width,height), cg);
            CGContextRelease(context);
        }
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        if (!context || ![adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMake(i, (int32_t)fps)]) {
            okay=NO; reason=writer.error.localizedDescription ?: @"Could not encode weather frame";
        }
        CVPixelBufferRelease(buffer);
        progress.completedUnitCount = i + 1;
        if (encode.quality > 0 && (i + 1) % 48 == 0)
            fprintf(stderr, "  %ld/%ld\n", (long)(i + 1), (long)frames);
    }}
    if (okay) {
        [input markAsFinished];
        [writer endSessionAtSourceTime:CMTimeMake(frames, (int32_t)fps)];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC))) {
            okay=NO; reason=@"Video encoder did not finish";
        } else okay=writer.status == AVAssetWriterStatusCompleted;
    }
    if (!okay) {
        // AVAssetWriter.h permits cancellation during finishing; it blocks
        // until cancellation and is a no-op for failed/completed writers.
        [writer cancelWriting];
        [NSFileManager.defaultManager removeItemAtURL:output error:NULL];
        if (error) *error=reason ?: writer.error.localizedDescription ?: @"Animation could not be prepared";
    }
    if (okay && getenv("ISOBAR_MOTION_DIAGNOSTICS"))
        fprintf(stderr,"Motion: max label step %.3f px, centre step %.3f px\n",motion.maxLabelStep,motion.maxCentreStep);
    return okay;
}
