#import "ownrender.h"

// Render every video frame from interpolated raw model fields. Call on a
// background queue; progress also supplies cancellation. The output must be new.
// quality <= 0 keeps the Mac app's average-bitrate Main-profile settings.
// quality in (0, 1] is VideoToolbox Quality (fixed quantiser, @"Quality").
// keyframeInterval 0 means one keyframe per second. highProfile selects High.
typedef struct {
    double quality;
    NSInteger keyframeInterval;
    BOOL highProfile;
} IsobarMovieEncode;

BOOL IsobarWriteRawMovie(OwnRun *run, NSURL *output, double fromIndex, double toIndex,
    NSInteger fps, double duration, OwnLayerOptions layers, NSProgress *progress,
    NSString **error);
BOOL IsobarWriteRawMovieWithEncode(OwnRun *run, NSURL *output, double fromIndex, double toIndex,
    NSInteger fps, double duration, OwnLayerOptions layers, IsobarMovieEncode encode,
    NSProgress *progress, NSString **error);
