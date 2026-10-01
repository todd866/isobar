#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>

static void Die(NSString *message) {
    fprintf(stderr, "check-site-movies: %s\n", message.UTF8String);
    exit(EXIT_FAILURE);
}

static void Require(BOOL condition, NSString *message) {
    if (!condition) Die(message);
}

static NSString *StringValue(NSDictionary *dictionary, NSString *key, NSString *context) {
    id value = dictionary[key];
    Require([value isKindOfClass:[NSString class]] && [value length] > 0,
            [NSString stringWithFormat:@"%@ is missing %s", context, key.UTF8String]);
    return value;
}

static NSURL *MovieURL(NSString *source, NSString *dataRoot, NSString *layer) {
    Require(![source hasPrefix:@"/"] && ![source containsString:@".."],
            [NSString stringWithFormat:@"%@ source escapes site/data: %@", layer, source]);
    NSString *path = [dataRoot stringByAppendingPathComponent:source];
    NSString *standard = [path stringByStandardizingPath];
    NSString *root = [dataRoot stringByStandardizingPath];
    Require([standard hasPrefix:[root stringByAppendingString:@"/"]],
            [NSString stringWithFormat:@"%@ source escapes site/data: %@", layer, source]);
    Require([[NSFileManager defaultManager] fileExistsAtPath:standard],
            [NSString stringWithFormat:@"%@ movie is missing: %@", layer, standard]);
    return [NSURL fileURLWithPath:standard];
}

static void CheckMovie(NSString *layer, NSURL *url) {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:@{ AVURLAssetPreferPreciseDurationAndTimingKey: @YES }];
    NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    Require(tracks.count == 1, [NSString stringWithFormat:@"%@ movie has %lu video tracks", layer, (unsigned long)tracks.count]);
    AVAssetTrack *track = tracks.firstObject;
    double duration = CMTimeGetSeconds(asset.duration);
    double fps = track.nominalFrameRate;
    CGSize size = track.naturalSize;
    Require(isfinite(duration) && fabs(duration - 120.0) < 0.5,
            [NSString stringWithFormat:@"%@ duration is %.3fs; expected 120s", layer, duration]);
    Require(isfinite(fps) && fabs(fps - 60.0) < 0.01,
            [NSString stringWithFormat:@"%@ nominal frame rate is %.3f; expected 60fps", layer, fps]);
    Require(fabs(size.width) > 0.0 && fabs(size.height) > 0.0,
            [NSString stringWithFormat:@"%@ has invalid dimensions %.0fx%.0f", layer, size.width, size.height]);

    NSError *error = nil;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    Require(reader != nil, [NSString stringWithFormat:@"%@ reader failed: %@", layer, error.localizedDescription ?: @"unknown error"]);
    AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:nil];
    Require([reader canAddOutput:output], [NSString stringWithFormat:@"%@ reader rejected video output", layer]);
    [reader addOutput:output];
    Require([reader startReading], [NSString stringWithFormat:@"%@ reader could not start: %@", layer, reader.error.localizedDescription ?: @"unknown error"]);

    NSUInteger count = 0;
    CMTime previous = kCMTimeInvalid;
    CMSampleBufferRef sample = NULL;
    while ((sample = [output copyNextSampleBuffer])) {
        CMItemCount sampleCount = CMSampleBufferGetNumSamples(sample);
        for (CMItemIndex index = 0; index < sampleCount; index++) {
            CMSampleTimingInfo timing = {0};
            OSStatus timingStatus = CMSampleBufferGetSampleTimingInfo(sample, index, &timing);
            Require(timingStatus == noErr,
                    [NSString stringWithFormat:@"%@ sample timing extraction failed", layer]);
            CMTime presentation = timing.presentationTimeStamp;
            Require(CMTIME_IS_VALID(presentation), [NSString stringWithFormat:@"%@ sample %lu has no presentation timestamp", layer, (unsigned long)count]);
            if (CMTIME_IS_VALID(previous)) {
                double delta = CMTimeGetSeconds(CMTimeSubtract(presentation, previous));
                Require(delta > 0.0 && fabs(delta - (1.0 / 60.0)) < 0.002,
                        [NSString stringWithFormat:@"%@ sample %lu has non-monotonic or uneven timestamp delta %.6fs", layer, (unsigned long)count, delta]);
            }
            previous = presentation;
            count += 1;
        }
        CFRelease(sample);
    }
    Require(reader.status == AVAssetReaderStatusCompleted,
            [NSString stringWithFormat:@"%@ reader stopped with status %ld: %@", layer, (long)reader.status, reader.error.localizedDescription ?: @"unknown error"]);
    Require(count == 7200,
            [NSString stringWithFormat:@"%@ contains %lu compressed samples; expected 7200", layer, (unsigned long)count]);
    printf("%s: %.3fs %.3ffps %.0fx%.0f %lu samples\n", layer.UTF8String, duration, fps, fabs(size.width), fabs(size.height), (unsigned long)count);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Require(argc == 2, @"usage: check-site-movies MANIFEST");
        NSString *manifestPath = [NSString stringWithUTF8String:argv[1]];
        NSData *manifestData = [NSData dataWithContentsOfFile:manifestPath options:0 error:nil];
        Require(manifestData != nil, [NSString stringWithFormat:@"could not read manifest: %@", manifestPath]);
        NSError *error = nil;
        NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:manifestData options:0 error:&error];
        Require([manifest isKindOfClass:[NSDictionary class]], [NSString stringWithFormat:@"invalid manifest JSON: %@", error.localizedDescription ?: @"unknown error"]);
        NSDictionary *animations = manifest[@"animations"] ?: manifest[@"animation"];
        Require([animations isKindOfClass:[NSDictionary class]], @"manifest has no animations");
        NSString *dataRoot = [[manifestPath stringByDeletingLastPathComponent] stringByStandardizingPath];
        for (NSString *layer in @[ @"pressure", @"temperature", @"rain", @"wind" ]) {
            NSDictionary *movie = animations[layer];
            Require([movie isKindOfClass:[NSDictionary class]], [NSString stringWithFormat:@"manifest is missing %@ movie", layer]);
            NSString *source = StringValue(movie, @"src", layer);
            CheckMovie(layer, MovieURL(source, dataRoot, layer));
        }
        puts("check-site-movies: passed");
    }
    return EXIT_SUCCESS;
}
