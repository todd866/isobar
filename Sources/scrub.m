#import "scrub.h"

@interface IsobarScrubRenderer ()
@property (nonatomic, strong) OwnRun *run;
@property (nonatomic, strong) NSCache<NSNumber *, NSImage *> *cache;
@property (nonatomic) OwnLayerOptions layers;
@property (nonatomic) CGFloat scale;
@property (nonatomic) dispatch_queue_t queue;
@property (nonatomic) OwnMotionState *motionState;
@property (nonatomic) BOOL active;
@property (nonatomic) BOOL hasPending;
@property (nonatomic) double pendingIndex;
@property (nonatomic, copy) IsobarScrubCompletion pendingCompletion;
@property (nonatomic) NSUInteger generation;
@property (nonatomic) NSUInteger renderCount;
@property (nonatomic) BOOL suppressActiveCallback;
@property (nonatomic) BOOL needsStateReset;
@property (nonatomic) BOOL hasScheduledIndex;
@property (nonatomic) double scheduledIndex;
@property (nonatomic) BOOL hasDisplayedIndex;
@property (nonatomic) double displayedIndex;
@property (nonatomic) double latestIndex;
@end

@implementation IsobarScrubRenderer

- (instancetype)initWithRun:(OwnRun *)run layers:(OwnLayerOptions)layers scale:(CGFloat)scale {
    NSParameterAssert(run);
    if ((self = [super init])) {
        _run = run;
        _layers = layers;
        _layers.bare = 1;
        _layers.observed = 0;
        _scale = scale > 0 ? scale : 1;
        _cache = [NSCache new];
        _cache.countLimit = 24;
        _cache.totalCostLimit = 32 * 1024 * 1024;
        _queue = dispatch_queue_create("au.com.isobar.scrub-render", DISPATCH_QUEUE_SERIAL);
        _generation = 1;
    }
    return self;
}

- (void)assertMainThread {
    NSAssert(NSThread.isMainThread, @"IsobarScrubRenderer is main-thread driven");
}

- (NSNumber *)keyForIndex:(double)index {
    return [NSNumber numberWithDouble:index];
}

- (NSUInteger)costForImage:(NSImage *)image {
    NSSize size = image.size;
    CGFloat factor = self.scale > 0 ? self.scale : 1;
    double cost = MAX(1, size.width * factor) * MAX(1, size.height * factor) * 4.0;
    return (NSUInteger)MIN((double)NSUIntegerMax, cost);
}

- (void)deliverCachedImage:(NSImage *)image index:(double)index generation:(NSUInteger)generation
                completion:(IsobarScrubCompletion)completion {
    if (!completion) return;
    // Callers already run on main; a prepared frame is ready immediately.
    if (self.generation == generation) completion(image, index);
}

- (void)startRenderAtIndex:(double)index completion:(IsobarScrubCompletion)completion {
    NSAssert(NSThread.isMainThread, @"renderer launch must be main-thread driven");
    self.active = YES;
    self.renderCount += 1;
    NSUInteger generation = self.generation;
    OwnRun *run = self.run;
    OwnLayerOptions layers = self.layers;
    CGFloat scale = self.scale;
    BOOL resetState = self.needsStateReset || !self.hasScheduledIndex ||
        fabs(index - self.scheduledIndex) > 0.5;
    self.needsStateReset = NO;
    self.hasScheduledIndex = YES;
    self.scheduledIndex = index;
    dispatch_async(self.queue, ^{
        @autoreleasepool {
            if (resetState || !self.motionState) {
                self.motionState = [OwnMotionState new];
                self.motionState.immediateAnnotations = YES;
            }
            NSImage *image = OwnRunRenderMotion(run, index, @"", layers, nil, scale, self.motionState);
            dispatch_async(dispatch_get_main_queue(), ^{
                [self finishRenderAtIndex:index generation:generation image:image completion:completion];
            });
        }
    });
}

- (void)finishRenderAtIndex:(double)index generation:(NSUInteger)generation image:(NSImage *)image
                 completion:(IsobarScrubCompletion)completion {
    [self assertMainThread];
    (void)generation;
    BOOL suppress = self.suppressActiveCallback;
    self.suppressActiveCallback = NO;
    self.active = NO;
    if (!suppress && image) [self.cache setObject:image forKey:[self keyForIndex:index] cost:[self costForImage:image]];

    BOOL hadPending = self.hasPending;
    double pendingIndex = self.pendingIndex;
    IsobarScrubCompletion pendingCompletion = [self.pendingCompletion copy];
    NSUInteger generationBeforeCallback = self.generation;
    self.hasPending = NO;
    self.pendingCompletion = nil;
    // A completed frame can be useful while a newer one is rendering, but it
    // must never move the map away from the current pointer direction.
    double target = hadPending ? pendingIndex : self.latestIndex;
    BOOL advances = !self.hasDisplayedIndex ||
        (target >= self.displayedIndex
            ? index >= self.displayedIndex && index <= target
            : index <= self.displayedIndex && index >= target);
    if (!suppress && image && advances) {
        self.displayedIndex = index;
        self.hasDisplayedIndex = YES;
        if (completion) completion(image, index);
    }

    // A callback may synchronously enqueue a newer request. Let that request
    // win over the older pending one while preserving one render in flight.
    if (self.active) return;
    if (hadPending && !self.hasPending && self.generation == generationBeforeCallback)
        [self startRenderAtIndex:pendingIndex completion:pendingCompletion];
}

- (void)requestIndex:(double)index completion:(IsobarScrubCompletion)completion {
    [self assertMainThread];
    NSUInteger generation = ++self.generation;
    if (!isfinite(index) || index < 0 || index > MAX(0, self.run.hours - 1)) {
        [self deliverCachedImage:nil index:index generation:generation completion:completion];
        return;
    }
    self.latestIndex = index;
    NSNumber *key = [self keyForIndex:index];
    NSImage *cached = [self.cache objectForKey:key];
    if (cached) {
        self.needsStateReset = YES;
        self.hasPending = NO;
        self.pendingCompletion = nil;
        if (self.active) self.suppressActiveCallback = YES;
        self.displayedIndex = index;
        self.hasDisplayedIndex = YES;
        [self deliverCachedImage:cached index:index generation:generation completion:completion];
        return;
    }
    if (self.active) {
        self.hasPending = YES;
        self.pendingIndex = index;
        self.pendingCompletion = [completion copy];
        return;
    }
    [self startRenderAtIndex:index completion:completion];
}

- (void)cancelRequests {
    [self assertMainThread];
    self.generation += 1;
    self.hasPending = NO;
    self.pendingCompletion = nil;
    self.needsStateReset = YES;
    self.hasDisplayedIndex = NO;
    if (self.active) self.suppressActiveCallback = YES;
}

@end
