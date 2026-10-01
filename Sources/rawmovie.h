#import "ownrender.h"

// Render every video frame from interpolated raw model fields. Call on a
// background queue; progress also supplies cancellation. The output must be new.
BOOL IsobarWriteRawMovie(OwnRun *run, NSURL *output, double fromIndex, double toIndex,
    NSInteger fps, double duration, OwnLayerOptions layers, NSProgress *progress,
    NSString **error);
