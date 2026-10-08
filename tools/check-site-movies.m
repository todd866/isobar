#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>

static const unsigned long long kMovieBudget = 10ull * 1000ull * 1000ull;

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

static double NumberValue(NSDictionary *dictionary, NSString *key, NSString *context) {
    id value = dictionary[key];
    Require([value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID(),
            [NSString stringWithFormat:@"%@ is missing %s", context, key.UTF8String]);
    return [value doubleValue];
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

static void RequireFastStart(NSString *layer, NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
    Require(data.length >= 8, [NSString stringWithFormat:@"%@ movie is empty", layer]);
    const uint8_t *bytes = data.bytes;
    uint64_t offset = 0, moov = UINT64_MAX, mdat = UINT64_MAX;
    while (offset + 8 <= data.length) {
        uint64_t size = CFSwapInt32BigToHost(*(const uint32_t *)(bytes + offset));
        uint64_t header = 8;
        if (size == 1) {
            Require(offset + 16 <= data.length, [NSString stringWithFormat:@"%@ movie atom is truncated", layer]);
            size = CFSwapInt64BigToHost(*(const uint64_t *)(bytes + offset + 8));
            header = 16;
        } else if (size == 0) size = data.length - offset;
        Require(size >= header, [NSString stringWithFormat:@"%@ movie atom is invalid", layer]);
        char type[5] = {0};
        memcpy(type, bytes + offset + 4, 4);
        if (strcmp(type, "moov") == 0) moov = offset;
        if (strcmp(type, "mdat") == 0) mdat = offset;
        if (offset + size < offset) break;
        offset += size;
    }
    Require(moov != UINT64_MAX && mdat != UINT64_MAX && moov < mdat,
            [NSString stringWithFormat:@"%@ movie is not fast-start (moov must precede mdat)", layer]);
}

typedef struct { const uint8_t *bytes; size_t length; size_t bit; } Bits;

static int ReadBit(Bits *bits) {
    if (bits->bit / 8 >= bits->length) return -1;
    int value = (bits->bytes[bits->bit / 8] >> (7 - (bits->bit % 8))) & 1;
    bits->bit += 1;
    return value;
}

static int ReadBits(Bits *bits, int count) {
    int value = 0;
    for (int i = 0; i < count; i++) {
        int bit = ReadBit(bits);
        if (bit < 0) return -1;
        value = (value << 1) | bit;
    }
    return value;
}

static int ReadUE(Bits *bits) {
    int zeros = 0, bit = ReadBit(bits);
    while (bit == 0) { zeros += 1; bit = ReadBit(bits); }
    if (bit < 0 || zeros > 16) return -1;
    int rest = zeros ? ReadBits(bits, zeros) : 0;
    if (rest < 0) return -1;
    return ((1 << zeros) - 1) + rest;
}

static NSData *RBSP(const uint8_t *bytes, size_t length) {
    NSMutableData *raw = [NSMutableData dataWithCapacity:length];
    for (size_t i = 0; i < length; i++) {
        if (i + 2 < length && bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 3) {
            [raw appendBytes:bytes + i length:2];
            i += 2;
            continue;
        }
        [raw appendBytes:bytes + i length:1];
    }
    return raw;
}

// High profile can be 4:2:2 or 4:4:4. chroma_format_idc 1 is yuv420p.
// Main profile is 4:2:0 by definition.
static void RequireChroma(NSString *layer, CMFormatDescriptionRef format) {
    CFDictionaryRef atoms = CMFormatDescriptionGetExtension(format, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms);
    CFDataRef avcC = atoms ? CFDictionaryGetValue(atoms, CFSTR("avcC")) : NULL;
    Require(avcC && CFDataGetLength(avcC) >= 7, [NSString stringWithFormat:@"%@ movie has no avcC", layer]);
    const uint8_t *bytes = CFDataGetBytePtr(avcC);
    int profile = bytes[1];
    Require(profile == 77 || profile == 100 || profile == 110 || profile == 122 || profile == 144,
            [NSString stringWithFormat:@"%@ H.264 profile %d is not Main or High", layer, profile]);
    if (profile == 77) return;
    int sets = bytes[5] & 0x1f;
    Require(sets >= 1 && CFDataGetLength(avcC) >= 8, [NSString stringWithFormat:@"%@ movie has no SPS", layer]);
    size_t spsLength = ((size_t)bytes[6] << 8) | bytes[7];
    Require(8 + spsLength <= (size_t)CFDataGetLength(avcC) && spsLength > 4,
            [NSString stringWithFormat:@"%@ SPS is truncated", layer]);
    NSData *rbsp = RBSP(bytes + 8, spsLength);
    const uint8_t *sps = rbsp.bytes;
    Require(sps[0] == 0x67 || (sps[0] & 0x1f) == 7, [NSString stringWithFormat:@"%@ SPS NAL is missing", layer]);
    Bits cursor = {.bytes = sps + 4, .length = rbsp.length - 4, .bit = 0};
    Require(ReadUE(&cursor) >= 0, [NSString stringWithFormat:@"%@ SPS could not be read", layer]);
    int chroma = ReadUE(&cursor);
    Require(chroma == 1, [NSString stringWithFormat:@"%@ chroma_format_idc is %d; expected yuv420p", layer, chroma]);
}

static BOOL SyncSample(CMSampleBufferRef sample, CMItemIndex index) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (!attachments || index >= CFArrayGetCount(attachments)) return YES;
    CFDictionaryRef info = CFArrayGetValueAtIndex(attachments, index);
    if (!info) return YES;
    return CFDictionaryGetValue(info, kCMSampleAttachmentKey_NotSync) != kCFBooleanTrue;
}

// AVFoundation calls back on its own queue, so a bounded wait is safe here.
static NSArray<AVAssetTrack *> *VideoTracks(AVAsset *asset, NSString *layer) {
    __block NSArray<AVAssetTrack *> *found = nil;
    __block NSError *failure = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [asset loadTracksWithMediaType:AVMediaTypeVideo completionHandler:^(NSArray<AVAssetTrack *> *tracks, NSError *error) {
        found = tracks;
        failure = error;
        dispatch_semaphore_signal(done);
    }];
    Require(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)) == 0,
            [NSString stringWithFormat:@"%@ tracks did not load within 60s", layer]);
    Require(found != nil, [NSString stringWithFormat:@"%@ tracks failed to load: %@", layer, failure.localizedDescription ?: @"unknown error"]);
    return found;
}

static void CheckMovie(NSString *layer, NSDictionary *movie, NSURL *url) {
    NSNumber *bytes = [[NSFileManager defaultManager] attributesOfItemAtPath:url.path error:nil][NSFileSize];
    unsigned long long size = bytes.unsignedLongLongValue;
    Require(size > 0 && size <= kMovieBudget,
            [NSString stringWithFormat:@"%@ movie is %llu bytes; budget is %llu", layer, size, kMovieBudget]);
    RequireFastStart(layer, url.path);
    double expectedDuration = NumberValue(movie, @"durationSeconds", layer);
    double expectedFPS = NumberValue(movie, @"fps", layer);
    Require(expectedDuration >= 20.0 && expectedDuration <= 30.0,
            [NSString stringWithFormat:@"%@ manifest duration is %.3fs; expected 20 to 30s", layer, expectedDuration]);
    Require(expectedFPS >= 12.0 && expectedFPS <= 30.0,
            [NSString stringWithFormat:@"%@ manifest frame rate is %.3f; expected at most 30fps", layer, expectedFPS]);
    NSInteger expectedFrames = (NSInteger)llround(expectedDuration * expectedFPS);

    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:@{ AVURLAssetPreferPreciseDurationAndTimingKey: @YES }];
    NSArray<AVAssetTrack *> *tracks = VideoTracks(asset, layer);
    Require(tracks.count == 1, [NSString stringWithFormat:@"%@ movie has %lu video tracks", layer, (unsigned long)tracks.count]);
    AVAssetTrack *track = tracks.firstObject;
    double duration = CMTimeGetSeconds(asset.duration);
    double fps = track.nominalFrameRate;
    CGSize dimensions = track.naturalSize;
    Require(isfinite(duration) && fabs(duration - expectedDuration) < 0.5,
            [NSString stringWithFormat:@"%@ duration is %.3fs; manifest says %.3fs", layer, duration, expectedDuration]);
    Require(isfinite(fps) && fabs(fps - expectedFPS) < 0.05,
            [NSString stringWithFormat:@"%@ nominal frame rate is %.3f; manifest says %.3f", layer, fps, expectedFPS]);
    Require(fabs(dimensions.width - 1160.0) < 0.5 && fabs(dimensions.height - 888.0) < 0.5,
            [NSString stringWithFormat:@"%@ dimensions are %.0fx%.0f; expected 1160x888", layer, fabs(dimensions.width), fabs(dimensions.height)]);
    Require(track.formatDescriptions.count == 1, [NSString stringWithFormat:@"%@ has no format description", layer]);
    CMFormatDescriptionRef format = (__bridge CMFormatDescriptionRef)track.formatDescriptions.firstObject;
    FourCharCode codec = CMFormatDescriptionGetMediaSubType(format);
    Require(codec == kCMVideoCodecType_H264,
            [NSString stringWithFormat:@"%@ codec is %c%c%c%c; expected H.264", layer, (codec >> 24) & 255, (codec >> 16) & 255, (codec >> 8) & 255, codec & 255]);
    RequireChroma(layer, format);

    NSError *error = nil;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    Require(reader != nil, [NSString stringWithFormat:@"%@ reader failed: %@", layer, error.localizedDescription ?: @"unknown error"]);
    AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:nil];
    Require([reader canAddOutput:output], [NSString stringWithFormat:@"%@ reader rejected video output", layer]);
    [reader addOutput:output];
    Require([reader startReading], [NSString stringWithFormat:@"%@ reader could not start: %@", layer, reader.error.localizedDescription ?: @"unknown error"]);

    NSUInteger count = 0;
    CMTime previous = kCMTimeInvalid, previousSync = kCMTimeInvalid;
    CMSampleBufferRef sample = NULL;
    while ((sample = [output copyNextSampleBuffer])) {
        CMItemCount sampleCount = CMSampleBufferGetNumSamples(sample);
        for (CMItemIndex index = 0; index < sampleCount; index++) {
            CMSampleTimingInfo timing = {0};
            OSStatus timingStatus = CMSampleBufferGetSampleTimingInfo(sample, index, &timing);
            Require(timingStatus == noErr, [NSString stringWithFormat:@"%@ sample timing extraction failed", layer]);
            CMTime presentation = timing.presentationTimeStamp;
            Require(CMTIME_IS_VALID(presentation), [NSString stringWithFormat:@"%@ sample %lu has no presentation timestamp", layer, (unsigned long)count]);
            if (CMTIME_IS_VALID(previous)) {
                double delta = CMTimeGetSeconds(CMTimeSubtract(presentation, previous));
                Require(delta > 0.0 && fabs(delta - (1.0 / expectedFPS)) < 0.002,
                        [NSString stringWithFormat:@"%@ sample %lu has non-monotonic or uneven timestamp delta %.6fs", layer, (unsigned long)count, delta]);
            }
            if (SyncSample(sample, index)) {
                if (CMTIME_IS_VALID(previousSync)) {
                    double gap = CMTimeGetSeconds(CMTimeSubtract(presentation, previousSync));
                    Require(gap <= 1.25, [NSString stringWithFormat:@"%@ keyframe gap is %.3fs; expected about 1s", layer, gap]);
                }
                previousSync = presentation;
            }
            previous = presentation;
            count += 1;
        }
        CFRelease(sample);
    }
    Require(reader.status == AVAssetReaderStatusCompleted,
            [NSString stringWithFormat:@"%@ reader stopped with status %ld: %@", layer, (long)reader.status, reader.error.localizedDescription ?: @"unknown error"]);
    Require(count == (NSUInteger)expectedFrames,
            [NSString stringWithFormat:@"%@ contains %lu compressed samples; expected %ld", layer, (unsigned long)count, (long)expectedFrames]);
    Require(CMTIME_IS_VALID(previousSync), [NSString stringWithFormat:@"%@ movie has no keyframe", layer]);
    if (CMTIME_IS_VALID(previous) && CMTIME_IS_VALID(previousSync)) {
        double tail = CMTimeGetSeconds(CMTimeSubtract(previous, previousSync));
        Require(tail <= 1.25, [NSString stringWithFormat:@"%@ trailing keyframe gap is %.3fs", layer, tail]);
    }
    printf("%s: %.3fs %.3ffps %.0fx%.0f %lu samples %llu bytes\n", layer.UTF8String, duration, fps, fabs(dimensions.width), fabs(dimensions.height), (unsigned long)count, size);
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
            CheckMovie(layer, movie, MovieURL(source, dataRoot, layer));
        }
        puts("check-site-movies: passed");
    }
    return EXIT_SUCCESS;
}
