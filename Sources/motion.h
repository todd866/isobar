#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Returns intervals + 1 frames, including the original endpoints.
/// Coarse-to-fine bidirectional motion preserves the static chart geography.
/// This API never falls back to a full-frame crossfade.
FOUNDATION_EXPORT NSArray<NSImage *> * _Nullable IsobarMotionFrames(NSImage * _Nullable from,
    NSImage * _Nullable to, NSUInteger intervals, NSString * _Nullable * _Nullable error);

NS_ASSUME_NONNULL_END
