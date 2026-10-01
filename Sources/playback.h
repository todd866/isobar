#import "ownrender.h"

// Ambient forecast playback. Frames are rendered locally, just ahead of the
// playhead. The Mac UI does not encode an H.264 movie.
extern const NSUInteger kIsobarLiveCacheBudget; // bytes
// Forecast seconds between ink frames when a frame is cheap. Ninety seconds
// keeps the stroke near a pixel per frame at the default speed and leaves
// the core budget intact. IsobarLiveFrameSpacing widens this when a render
// would use more than 15% of one core, and never asks for more than 30 new
// frames a real second.
extern const NSTimeInterval kIsobarLiveFrameStep;
NSTimeInterval IsobarLiveFrameSpacing(double renderSeconds, double hoursPerSecond);
extern const NSTimeInterval kIsobarLiveSeamDuration; // real seconds, end of run back to now

typedef NS_ENUM(NSInteger, IsobarLiveSpeed) {
    IsobarLiveSpeedSlow = 0,   // 1 forecast hour per 5 real seconds
    IsobarLiveSpeedMedium = 1, // 1 forecast hour per 2 real seconds
    IsobarLiveSpeedFast = 2,   // 1 forecast hour per real second
};

double IsobarLiveHoursPerSecond(IsobarLiveSpeed speed);

typedef double (^IsobarLiveModelIndex)(NSDate *date);

@interface IsobarLivePlayer : NSObject
@property (nonatomic, readonly) BOOL playing;
@property (nonatomic, readonly) BOOL holding;
@property (nonatomic, readonly) BOOL seaming;
@property (nonatomic, readonly, strong) NSDate *playhead;
@property (nonatomic, readonly, strong) NSImage *baseImage;
@property (nonatomic, readonly, strong) NSImage *nextImage;
@property (nonatomic, readonly) CGFloat nextOpacity;
@property (nonatomic, readonly) NSUInteger cacheBytes;
@property (nonatomic, readonly) NSUInteger rendersInFlight;
@property (nonatomic, readonly) NSUInteger completedRenders;
@property (nonatomic, readonly) NSUInteger displayTicks;
// Label and centre positions of the frame on screen, in chart points.
@property (nonatomic, readonly, copy) NSArray<NSValue *> *labelPositions;
@property (nonatomic, readonly, copy) NSArray<NSValue *> *centrePositions;
@property (nonatomic) NSUInteger byteBudget;
@property (nonatomic) double hoursPerSecond;
@property (nonatomic, readonly) NSTimeInterval frameSpacing;
@property (nonatomic) CGFloat scale;
@property (nonatomic) NSSize pixelSize;
@property (nonatomic) OwnLayerOptions layers;

- (void)configureRun:(OwnRun *)run start:(NSDate *)start end:(NSDate *)end now:(NSDate *)now
          modelIndex:(IsobarLiveModelIndex)modelIndex;
- (void)playFromDate:(NSDate *)date;
- (void)pause;
- (void)holdAtDate:(NSDate *)date;
- (void)tick:(NSTimeInterval)seconds;
// The frame on screen. Steady play shows one fine render. The seam blends the
// last frame back to now.
- (NSImage *)displayedImage;
// Drops cached frames except the one on screen and ignores in-flight renders.
- (void)stopRendering;
// Layer or run change. Playback continues; stale renders are discarded.
- (void)invalidateFrames;
+ (void)retireEncodedMovies;
@end
