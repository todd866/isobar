#import "ownrender.h"

// Ambient forecast playback. Frames are rendered locally, just ahead of the
// playhead. The Mac UI does not encode an H.264 movie.
extern const NSUInteger kIsobarLiveCacheBudget; // bytes
// Initial forecast seconds between ink frames. The player calibrates this from
// render cost after three samples, keeping a minimum cadence of 10/20/30 fps
// at 1x/2x/4x, 8x, 16x, 32x, 64x, 128x and 256x speed and never asking for more than 30 new frames/sec.
extern const NSTimeInterval kIsobarLiveFrameStep;
NSTimeInterval IsobarLiveFrameSpacing(double renderSeconds, double hoursPerSecond);
extern const NSTimeInterval kIsobarLiveSeamDuration; // real seconds, end of run back to now
// One display step. The on-screen timer fires at this interval. A manual
// clock advances by this step; it does not follow the machine.
extern const NSTimeInterval kIsobarLiveDisplayTick;

// Monotonic seconds. The wall clock is process uptime and ignores -advance:.
// A manual clock stays put until the harness steps it, so a slow runner
// cannot stretch or skip a frame.
@interface IsobarLiveClock : NSObject
@property (nonatomic, readonly) BOOL manual;
- (NSTimeInterval)now;
- (void)advance:(NSTimeInterval)seconds;
+ (instancetype)wallClock;
+ (instancetype)manualClock;
@end

typedef NS_ENUM(NSInteger, IsobarLiveSpeed) {
    IsobarLiveSpeed1x = 1,     // 1 forecast minute per real second
    IsobarLiveSpeed2x = 2,     // 2 forecast minutes per real second
    IsobarLiveSpeed4x = 4,     // 4 forecast minutes per real second
    IsobarLiveSpeed8x = 8,     // 8 forecast minutes per real second
    IsobarLiveSpeed16x = 16,   // 16 forecast minutes per real second
    IsobarLiveSpeed32x = 32,   // 32 forecast minutes per real second
    IsobarLiveSpeed64x = 64,   // 64 forecast minutes per real second
    IsobarLiveSpeed128x = 128, // 128 forecast minutes per real second
    IsobarLiveSpeed256x = 256, // 256 forecast minutes per real second
};

BOOL IsobarLiveSpeedIsValid(IsobarLiveSpeed speed);
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
// The one forecast timeline. A display link samples `modelIndexAtTime:` at
// its target timestamp; it does not keep a second clock. `playheadRate` is
// forecast hours per real second: the playing speed, 0 while paused or held,
// and negative while the seam runs back to now. Each push (tick, seek, hold,
// pause, seam) re-anchors. Forward play does not step backwards across a push.
@property (nonatomic, readonly) NSTimeInterval playheadAnchorTime;
@property (nonatomic, readonly) double playheadAnchorHours;
@property (nonatomic, readonly) double playheadRate;
@property (nonatomic, readonly) NSUInteger playheadEpoch;
- (double)forecastHoursAtTime:(NSTimeInterval)time;
- (double)modelIndexAtTime:(NSTimeInterval)time;
// Label and centre positions of the frame on screen, in chart points.
@property (nonatomic, readonly, copy) NSArray<NSValue *> *labelPositions;
@property (nonatomic, readonly, copy) NSArray<NSValue *> *centrePositions;
@property (nonatomic) NSUInteger byteBudget;
@property (nonatomic) double hoursPerSecond;
@property (nonatomic, readonly) NSTimeInterval frameSpacing;
@property (nonatomic) CGFloat scale;
@property (nonatomic) NSSize pixelSize;
@property (nonatomic) OwnLayerOptions layers;
// Nil until first use, then a wall clock. Tests install a manual clock.
@property (nonatomic, strong) IsobarLiveClock *clock;
- (NSTimeInterval)clockNow;

- (void)configureRun:(OwnRun *)run start:(NSDate *)start end:(NSDate *)end now:(NSDate *)now
          modelIndex:(IsobarLiveModelIndex)modelIndex;
- (void)playFromDate:(NSDate *)date;
- (void)pause;
- (void)holdAtDate:(NSDate *)date;
- (void)tick:(NSTimeInterval)seconds;
// The frame on screen. Steady play shows one pressure render at a time. The
// seam passes through the cached flat plate between the last frame and now.
- (NSImage *)displayedImage;
// Drops cached frames except the one on screen and ignores in-flight renders.
- (void)stopRendering;
// Layer or run change. Playback continues; stale renders are discarded.
- (void)invalidateFrames;
+ (void)retireEncodedMovies;
@end
