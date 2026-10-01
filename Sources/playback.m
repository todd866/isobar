#import "playback.h"
#import <math.h>

const NSUInteger kIsobarLiveCacheBudget = 300 * 1024 * 1024;
const NSTimeInterval kIsobarLiveFrameStep = 90;
const NSTimeInterval kIsobarLiveSeamDuration = 1.5;
const NSTimeInterval kIsobarLiveDisplayTick = 1.0 / 30.0;

@implementation IsobarLiveClock {
    BOOL _manual;
    NSTimeInterval _now;
}
+ (instancetype)wallClock { return [self new]; }
+ (instancetype)manualClock {
    IsobarLiveClock *clock = [self new];
    clock->_manual = YES;
    return clock;
}
- (BOOL)manual { return _manual; }
- (NSTimeInterval)now {
    return _manual ? _now : NSProcessInfo.processInfo.systemUptime;
}
- (void)advance:(NSTimeInterval)seconds {
    if (!_manual || !(seconds > 0)) return;
    _now += seconds;
}
@end
static const CGFloat kChartW = 580;
static const CGFloat kChartH = 444;

double IsobarLiveHoursPerSecond(IsobarLiveSpeed speed) {
    if (speed == IsobarLiveSpeedMedium) return 0.2;
    if (speed == IsobarLiveSpeedFast) return 1;
    return 0.05;
}

static NSInteger OverlayStride(NSTimeInterval spacing) {
    double step = spacing > 1 ? spacing : kIsobarLiveFrameStep;
    NSInteger stride = (NSInteger)llround(1800.0 / step);
    if (stride < 1) stride = 1;
    return stride;
}

NSTimeInterval IsobarLiveFrameSpacing(double renderSeconds, double hoursPerSecond) {
    double speed = hoursPerSecond > 0 ? hoursPerSecond : 0.05;
    // Frames are blended by the playhead, so a new one is needed only every
    // couple of pixels of isobar motion: about 90 forecast seconds. Never
    // finer than 30 new frames a real second.
    double pixelStep = kIsobarLiveFrameStep;
    double rateStep = speed * 3600.0 / 30.0;
    if (pixelStep < rateStep) pixelStep = rateStep;
    if (!(renderSeconds > 0) || !isfinite(renderSeconds)) return ceil(pixelStep - 1e-9);
    double fps = 0.15 / renderSeconds;
    if (fps > 30.0) fps = 30.0;
    if (fps < 1.0) fps = 1.0;
    double step = speed * 3600.0 / fps;
    if (step < pixelStep) step = pixelStep;
    if (step < 1) step = 1;
    return ceil(step - 1e-9);
}

static CGImageRef RetainedCGImage(NSImage *image) {
    if (!image) return NULL;
    CGImageRef imageRef = [image CGImageForProposedRect:NULL context:nil hints:nil];
    return imageRef ? CGImageRetain(imageRef) : NULL;
}

static NSImage *ImageOver(NSImage *plate, NSImage *ink, CGFloat inkAlpha) {
    if (!ink || inkAlpha <= 0) return plate;
    if (!plate && inkAlpha >= 0.999) return ink;
    CGImageRef under = RetainedCGImage(plate ?: ink);
    CGImageRef over = RetainedCGImage(ink);
    size_t width = over ? CGImageGetWidth(over) : CGImageGetWidth(under);
    size_t height = over ? CGImageGetHeight(over) : CGImageGetHeight(under);
    if (!width || !height) {
        if (under) CGImageRelease(under);
        if (over) CGImageRelease(over);
        return plate ?: ink;
    }
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, width, height, 8, width * 4, cs,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(cs);
    if (!ctx) {
        if (under) CGImageRelease(under);
        if (over) CGImageRelease(over);
        return plate ?: ink;
    }
    if (plate && under) CGContextDrawImage(ctx, CGRectMake(0, 0, width, height), under);
    if (over) {
        CGContextSetAlpha(ctx, MIN(1, MAX(0, inkAlpha)));
        CGContextDrawImage(ctx, CGRectMake(0, 0, width, height), over);
    }
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (under) CGImageRelease(under);
    if (over) CGImageRelease(over);
    if (!image) return plate ?: ink;
    NSImage *result = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(kChartW, kChartH)];
    CGImageRelease(image);
    return result;
}

static NSArray<NSValue *> *PointValues(const CGPoint *points, NSInteger count) {
    NSMutableArray *values = [NSMutableArray arrayWithCapacity:(NSUInteger)MAX(0, count)];
    for (NSInteger i = 0; i < count; i++)
        [values addObject:[NSValue valueWithPoint:NSPointFromCGPoint(points[i])]];
    return values;
}

@implementation IsobarLivePlayer {
    OwnRun *_run;
    NSDate *_start;
    NSDate *_end;
    NSDate *_now;
    IsobarLiveModelIndex _modelIndex;
    double _hours;
    double _spanHours;
    double _nowHours;
    double _seam;
    NSUInteger _generation;
    NSInteger _stepCount;
    NSInteger _motionStep;
    OwnMotionState *_motion;
    OwnMotionState *_seekMotion;
    NSMutableDictionary<NSNumber *, NSImage *> *_frames;
    NSMutableDictionary<NSNumber *, NSArray<NSValue *> *> *_labels;
    NSMutableDictionary<NSNumber *, NSArray<NSValue *> *> *_centres;
    NSMutableArray<NSNumber *> *_lru;
    NSMutableDictionary<NSNumber *, NSNumber *> *_frameBytes;
    NSMutableSet<NSNumber *> *_pending;
    NSMutableDictionary<NSString *, NSImage *> *_plates;
    NSUInteger _bytes;
    NSUInteger _inFlight;
    NSUInteger _completed;
    NSUInteger _ticks;
    NSTimeInterval _spacing;
    double _spacingSpeed;
    double _renderSamples[3];
    int _renderCount;
    BOOL _spacingLocked;
    dispatch_queue_t _queue;
    IsobarLiveClock *_clock;
}

+ (void)retireEncodedMovies {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *directory = [@"~/Library/Caches/Isobar/motion" stringByExpandingTildeInPath];
        NSFileManager *fm = NSFileManager.defaultManager;
        for (NSString *name in [fm contentsOfDirectoryAtPath:directory error:nil]) {
            NSString *path = [directory stringByAppendingPathComponent:name];
            [fm removeItemAtPath:path error:nil];
        }
    });
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    _byteBudget = kIsobarLiveCacheBudget;
    _hoursPerSecond = IsobarLiveHoursPerSecond(IsobarLiveSpeedSlow);
    _spacing = kIsobarLiveFrameStep;
    _spacingSpeed = _hoursPerSecond;
    _scale = 1;
    _motionStep = -1;
    _motion = [OwnMotionState new];
    _seekMotion = nil;
    _frames = [NSMutableDictionary dictionary];
    _labels = [NSMutableDictionary dictionary];
    _centres = [NSMutableDictionary dictionary];
    _lru = [NSMutableArray array];
    _frameBytes = [NSMutableDictionary dictionary];
    _pending = [NSMutableSet set];
    _plates = [NSMutableDictionary dictionary];
    _queue = dispatch_queue_create("isobar.live", DISPATCH_QUEUE_SERIAL);
    _generation = 1;
    return self;
}

- (CGFloat)renderScale {
    CGFloat scale = _pixelSize.width >= 32 ? _pixelSize.width / kChartW : (_scale > 0 ? _scale : 1);
    if (scale < 1) scale = 1;
    if (scale > 4) scale = 4;
    return scale;
}

- (NSDate *)dateForHours:(double)hours {
    if (!_start) return nil;
    return [_start dateByAddingTimeInterval:hours * 3600.0];
}

- (NSTimeInterval)frameSpacing { return _spacing > 0 ? _spacing : kIsobarLiveFrameStep; }
- (IsobarLiveClock *)clock {
    if (!_clock) _clock = [IsobarLiveClock wallClock];
    return _clock;
}
- (void)setClock:(IsobarLiveClock *)clock { _clock = clock; }
- (NSTimeInterval)clockNow {
    return _clock ? [_clock now] : NSProcessInfo.processInfo.systemUptime;
}
- (double)stepHours { return [self frameSpacing] / 3600.0; }

- (void)noteRenderSeconds:(double)seconds {
    if (fabs(_spacingSpeed - _hoursPerSecond) > 1e-9) {
        _spacingSpeed = _hoursPerSecond;
        _spacingLocked = NO;
        _renderCount = 0;
        if (fabs(_spacing - kIsobarLiveFrameStep) > 0.5) {
            _spacing = kIsobarLiveFrameStep;
            [self rebuildSteps];
        }
    }
    if (!(seconds > 0) || _spacingLocked) return;
    if (_renderCount < 3) _renderSamples[_renderCount++] = seconds;
    if (_renderCount < 3) return;
    double sample[3] = {_renderSamples[0], _renderSamples[1], _renderSamples[2]};
    if (sample[0] > sample[1]) { double swap = sample[0]; sample[0] = sample[1]; sample[1] = swap; }
    if (sample[1] > sample[2]) { double swap = sample[1]; sample[1] = sample[2]; sample[2] = swap; }
    if (sample[0] > sample[1]) { double swap = sample[0]; sample[0] = sample[1]; sample[1] = swap; }
    NSTimeInterval next = IsobarLiveFrameSpacing(sample[1], _hoursPerSecond);
    _spacingLocked = YES;
    if (fabs(next - _spacing) < 0.5) return;
    _spacing = next;
    _generation++;
    _motion = [OwnMotionState new];
    _seekMotion = nil;
    _motionStep = -1;
    [_frames removeAllObjects];
    [_labels removeAllObjects];
    [_centres removeAllObjects];
    [_lru removeAllObjects];
    [_frameBytes removeAllObjects];
    [_pending removeAllObjects];
    _bytes = 0;
    _baseImage = nil;
    _nextImage = nil;
    _nextOpacity = 0;
    [self rebuildSteps];
    dispatch_async(_queue, ^{ [self->_plates removeAllObjects]; });
}

- (NSDate *)playhead {
    if (_seaming && _spanHours > 0) {
        double t = MIN(1, MAX(0, _seam));
        return [self dateForHours:_spanHours + (_nowHours - _spanHours) * t];
    }
    return [self dateForHours:_hours];
}

- (NSUInteger)rendersInFlight { return _inFlight; }
- (NSUInteger)completedRenders { return _completed; }
- (NSUInteger)displayTicks { return _ticks; }
- (NSUInteger)cacheBytes { return _bytes; }

- (NSInteger)stepForHours:(double)hours {
    if (_stepCount < 1) return 0;
    NSInteger step = (NSInteger)floor(hours / [self stepHours]);
    if (step < 0) step = 0;
    if (step >= _stepCount) step = _stepCount - 1;
    return step;
}

- (NSDate *)dateForStep:(NSInteger)step {
    return [self dateForHours:step * [self stepHours]];
}

- (NSArray<NSValue *> *)labelPositions {
    return _labels[@([self stepForHours:_seaming ? _spanHours : _hours])] ?: @[];
}

- (NSArray<NSValue *> *)centrePositions {
    return _centres[@([self stepForHours:_seaming ? _spanHours : _hours])] ?: @[];
}

- (NSImage *)displayedImage {
    if (!_baseImage) return nil;
    if (!_nextImage || _nextOpacity <= 0.001) return _baseImage;
    return ImageOver(_baseImage, _nextImage, _nextOpacity);
}

- (void)rememberStep:(NSNumber *)step {
    [_lru removeObject:step];
    [_lru addObject:step];
}

- (NSUInteger)bytesForImage:(NSImage *)image {
    (void)image;
    double scale = [self renderScale];
    double pixels = kChartW * scale * kChartH * scale * 4.0;
    return (NSUInteger)MIN((double)NSUIntegerMax, pixels);
}

- (void)evictIfNeededProtecting:(NSSet<NSNumber *> *)keep {
    while (_bytes > _byteBudget && _lru.count) {
        NSNumber *oldest = nil;
        for (NSNumber *step in _lru) {
            if ([keep containsObject:step]) continue;
            oldest = step;
            break;
        }
        if (!oldest) break;
        NSUInteger cost = _frameBytes[oldest].unsignedIntegerValue;
        [_frames removeObjectForKey:oldest];
        [_labels removeObjectForKey:oldest];
        [_centres removeObjectForKey:oldest];
        [_frameBytes removeObjectForKey:oldest];
        [_lru removeObject:oldest];
        if (cost < _bytes) _bytes -= cost;
        else _bytes = 0;
    }
}

- (void)storeImage:(NSImage *)image labels:(NSArray *)labels centres:(NSArray *)centres step:(NSInteger)step {
    if (!image) return;
    NSNumber *key = @(step);
    NSUInteger cost = [self bytesForImage:image];
    NSUInteger previous = _frameBytes[key].unsignedIntegerValue;
    if (previous < _bytes) _bytes -= previous;
    else _bytes = 0;
    _frames[key] = image;
    _labels[key] = labels ?: @[];
    _centres[key] = centres ?: @[];
    _frameBytes[key] = @(cost);
    _bytes += cost;
    [self rememberStep:key];
    NSInteger shown = [self stepForHours:_hours];
    NSInteger nowStep = [self stepForHours:_nowHours];
    // The loop returns to now. Dropping that frame makes the next render
    // start a new motion track, and the isobars then pop.
    [self evictIfNeededProtecting:[NSSet setWithObjects:@(shown),
        @(MIN(_stepCount - 1, shown + 1)), @(nowStep), nil]];
}

- (void)rebuildSteps {
    _spanHours = (_start && _end) ? MAX(0, [_end timeIntervalSinceDate:_start] / 3600.0) : 0;
    double stepHours = [self stepHours];
    _stepCount = _spanHours > 0 ? (NSInteger)floor(_spanHours / stepHours) + 1 : (_start ? 1 : 0);
    _nowHours = 0;
    if (_start && _now) _nowHours = [_now timeIntervalSinceDate:_start] / 3600.0;
    if (_nowHours < 0) _nowHours = 0;
    if (_spanHours > 0 && _nowHours > _spanHours) _nowHours = _spanHours;
}

- (void)configureRun:(OwnRun *)run start:(NSDate *)start end:(NSDate *)end now:(NSDate *)now
          modelIndex:(IsobarLiveModelIndex)modelIndex {
    BOOL sameRun = run == _run && [start isEqual:_start] && [end isEqual:_end];
    _run = run;
    _start = start;
    _end = end;
    _now = now;
    _modelIndex = [modelIndex copy];
    [self rebuildSteps];
    if (!sameRun) [self invalidateFrames];
}

- (void)invalidateFrames {
    _generation++;
    _motion = [OwnMotionState new];
    _seekMotion = nil;
    _motionStep = -1;
    [_frames removeAllObjects];
    [_labels removeAllObjects];
    [_centres removeAllObjects];
    [_lru removeAllObjects];
    [_frameBytes removeAllObjects];
    [_pending removeAllObjects];
    _bytes = 0;
    _baseImage = nil;
    _nextImage = nil;
    _nextOpacity = 0;
    dispatch_async(_queue, ^{ [self->_plates removeAllObjects]; });
    if (_playing) [self schedule];
}

- (void)stopRendering {
    _generation++;
    _playing = NO;
    _holding = NO;
    _seaming = NO;
    _seam = 0;
    _motion = [OwnMotionState new];
    _seekMotion = nil;
    _motionStep = -1;
    [_pending removeAllObjects];
    NSInteger shown = [self stepForHours:_hours];
    NSImage *keep = _frames[@(shown)] ?: _baseImage;
    NSArray *keepLabels = _labels[@(shown)];
    NSArray *keepCentres = _centres[@(shown)];
    NSUInteger cost = keep ? [self bytesForImage:keep] : 0;
    [_frames removeAllObjects];
    [_labels removeAllObjects];
    [_centres removeAllObjects];
    [_lru removeAllObjects];
    [_frameBytes removeAllObjects];
    _bytes = 0;
    if (keep) {
        _frames[@(shown)] = keep;
        _labels[@(shown)] = keepLabels ?: @[];
        _centres[@(shown)] = keepCentres ?: @[];
        _frameBytes[@(shown)] = @(cost);
        [_lru addObject:@(shown)];
        _bytes = cost;
        _baseImage = keep;
    }
    dispatch_async(_queue, ^{ [self->_plates removeAllObjects]; });
}

- (void)playFromDate:(NSDate *)date {
    if (date && _start) {
        _hours = [date timeIntervalSinceDate:_start] / 3600.0;
        if (_hours < 0) _hours = 0;
        if (_spanHours > 0 && _hours > _spanHours) _hours = _spanHours;
    } else if (_hours <= 0 && _nowHours > 0) _hours = _nowHours;
    _holding = NO;
    _seaming = NO;
    _seam = 0;
    _playing = YES;
    [self publish];
    [self schedule];
}

- (void)pause {
    _playing = NO;
    _holding = NO;
}

- (void)holdAtDate:(NSDate *)date {
    if (date && _start) {
        _hours = [date timeIntervalSinceDate:_start] / 3600.0;
        if (_hours < 0) _hours = 0;
        if (_spanHours > 0 && _hours > _spanHours) _hours = _spanHours;
    }
    _playing = NO;
    _holding = YES;
    _seaming = NO;
    [self publish];
    [self schedule];
}

- (BOOL)hasStep:(NSInteger)step {
    return _frames[@(step)] != nil;
}

- (double)clampedAdvance:(double)candidate {
    // Move through rendered frames and stop at the first one that is missing.
    // A large step must not skip ahead, and it must not freeze before frames
    // that are already cached.
    if (_stepCount < 1) return _hours;
    if (candidate < 0) candidate = 0;
    if (_spanHours > 0 && candidate > _spanHours) candidate = _spanHours;
    if (candidate <= _hours) return _hours;
    double stepHours = [self stepHours];
    NSInteger step = [self stepForHours:_hours];
    if (![self hasStep:step]) return _hours;
    double furthest = _hours;
    while (step < _stepCount && [self hasStep:step]) {
        double start = step * stepHours;
        NSInteger next = step + 1;
        BOOL nextReady = next >= _stepCount || [self hasStep:next];
        if (!nextReady) return MAX(furthest, start);
        double end = next >= _stepCount ? (_spanHours > 0 ? _spanHours : start) : (next * stepHours);
        if (candidate <= end + 0.00001) return candidate;
        furthest = end;
        step = next;
    }
    return furthest;
}

- (void)tick:(NSTimeInterval)seconds {
    _ticks++;
    if (seconds < 0) seconds = 0;
    if (seconds > 0.25) seconds = 0.25;
    if (_seaming) {
        _seam += seconds / kIsobarLiveSeamDuration;
        if (_seam >= 1) {
            _seaming = NO;
            _seam = 0;
            _hours = _nowHours;
        }
        [self publish];
        [self schedule];
        return;
    }
    if (_playing && !_holding && _hoursPerSecond > 0) {
        double candidate = _hours + _hoursPerSecond * seconds;
        if (_spanHours > 0 && candidate >= _spanHours - 0.00001) {
            NSInteger last = _stepCount - 1;
            NSInteger nowStep = [self stepForHours:_nowHours];
            if ([self hasStep:last] && [self hasStep:nowStep]) {
                _hours = _spanHours;
                _seaming = YES;
                _seam = 0;
            } else {
                _hours = [self clampedAdvance:MIN(candidate, _spanHours)];
            }
        } else {
            _hours = [self clampedAdvance:candidate];
        }
    }
    [self publish];
    [self schedule];
}

- (void)publish {
    if (_stepCount < 1) return;
    if (_seaming) {
        NSInteger last = _stepCount - 1;
        NSInteger nowStep = [self stepForHours:_nowHours];
        _baseImage = _frames[@(last)];
        _nextImage = _frames[@(nowStep)];
        _nextOpacity = (CGFloat)MIN(1, MAX(0, _seam));
        if (_baseImage) [self rememberStep:@(last)];
        if (_nextImage) [self rememberStep:@(nowStep)];
        return;
    }
    NSInteger step = [self stepForHours:_hours];
    NSInteger next = MIN(_stepCount - 1, step + 1);
    _baseImage = _frames[@(step)];
    _nextImage = next == step ? nil : _frames[@(next)];
    // Adjacent fine frames are a fraction of a pixel apart at ambient speed,
    // so blending by the playhead's position between them reads as sub-pixel
    // motion rather than a cut every frame.
    double into = [self stepHours] > 0 ? (_hours - step * [self stepHours]) / [self stepHours] : 0;
    _nextOpacity = _nextImage ? (CGFloat)MIN(1, MAX(0, into)) : 0;
    if (_baseImage) [self rememberStep:@(step)];
    if (_nextImage) [self rememberStep:@(next)];
}

- (BOOL)heavyLayers { return _layers.temperature || _layers.barbs || _layers.rain; }

- (NSInteger)nextWantedStep {
    if (!_run || _stepCount < 1 || !_modelIndex) return NSNotFound;
    NSInteger current = [self stepForHours:_seaming ? _spanHours : _hours];
    NSInteger ahead = MIN(_stepCount, current + 3);
    for (NSInteger step = current; step < ahead; step++) {
        NSNumber *key = @(step);
        if (_frames[key] || [_pending containsObject:key]) continue;
        return step;
    }
    NSInteger nowStep = [self stepForHours:_nowHours];
    NSNumber *nowKey = @(nowStep);
    if ((_playing || _seaming) && nowStep >= 0 && nowStep < _stepCount &&
        !_frames[nowKey] && ![_pending containsObject:nowKey]) return nowStep;
    return NSNotFound;
}

- (void)schedule {
    if (!_run || (!_playing && !_holding && !_seaming)) return;
    if (_inFlight >= 1) return;
    NSInteger step = [self nextWantedStep];
    if (step == NSNotFound) return;
    NSNumber *key = @(step);
    [_pending addObject:key];
    _inFlight++;
    NSUInteger generation = _generation;
    OwnRun *run = _run;
    OwnLayerOptions layers = _layers;
    layers.bare = 1;
    BOOL heavy = [self heavyLayers];
    // Only the next forecast step continues the glide. The loop's now frame
    // is rendered out of order and must not start the track over.
    BOOL inSequence = _motionStep < 0 || step == _motionStep + 1;
    OwnMotionState *motion = _motion;
    if (inSequence) _motionStep = step;
    else {
        // Seeks (hover, scrub, the loop's now frame) share one memory of their
        // own, so a hover keeps its numbers still instead of re-placing them
        // on every step, and never disturbs the playing sequence's memory.
        if (!_seekMotion) {
            _seekMotion = [OwnMotionState new];
            _seekMotion.immediateAnnotations = YES;
        }
        motion = _seekMotion;
    }
    CGFloat scale = [self renderScale];
    // Weather overlays stay a flat plate. The coast is static and is drawn at
    // the isobar scale once, then reused. Only isobars are rendered per frame.
    CGFloat plateScale = heavy ? 1 : scale;
    NSDate *when = [self dateForStep:step];
    double index = _modelIndex ? _modelIndex(when) : 0;
    NSInteger stride = OverlayStride([self frameSpacing]);
    NSInteger plateStep = (step / stride) * stride;
    NSDate *plateWhen = [self dateForStep:plateStep];
    double plateIndex = _modelIndex && plateWhen ? _modelIndex(plateWhen) : index;
    NSString *plateKey = heavy
        ? [NSString stringWithFormat:@"%ld-%.3f-%d-%d-%d",
            (long)plateStep, plateScale, layers.temperature, layers.barbs, layers.rain]
        : [NSString stringWithFormat:@"coast-%.3f", scale];
    __weak IsobarLivePlayer *weak = self;
    dispatch_async(_queue, ^{
        NSImage *image = nil;
        NSArray<NSValue *> *labels = nil;
        NSArray<NSValue *> *centres = nil;
        double inkSeconds = 0;
        @autoreleasepool {
            IsobarLivePlayer *owner = weak;
            if (!owner || generation != owner->_generation) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    IsobarLivePlayer *strong = weak;
                    if (!strong) return;
                    if (strong->_inFlight) strong->_inFlight--;
                    [strong->_pending removeObject:key];
                    [strong schedule];
                });
                return;
            }
            OwnLayerOptions draw = layers;
            draw.inkOnly = 1;
            draw.temperature = 0;
            draw.barbs = 0;
            draw.rain = 0;
            CFAbsoluteTime began = CFAbsoluteTimeGetCurrent();
            NSImage *ink = OwnRunRenderMotion(run, index, @"", draw, nil, scale, motion);
            inkSeconds = CFAbsoluteTimeGetCurrent() - began;
            CGPoint labelPoints[80], centrePoints[24];
            NSInteger nLabels = [motion copyLabelPoints:labelPoints max:80];
            NSInteger nCentres = [motion copyCentrePoints:centrePoints max:24];
            labels = PointValues(labelPoints, nLabels);
            centres = PointValues(centrePoints, nCentres);
            NSImage *plate = ink ? owner->_plates[plateKey] : nil;
            if (ink && !plate) {
                OwnLayerOptions plateLayers = layers;
                plateLayers.plateOnly = 1;
                plateLayers.bare = 1;
                plateLayers.inkOnly = 0;
                plate = OwnRunRenderFraction(run, plateIndex, @"", plateLayers, nil, plateScale);
                if (plate && owner && generation == owner->_generation) owner->_plates[plateKey] = plate;
            }
            image = ink ? ImageOver(plate, ink, 1) : nil;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            IsobarLivePlayer *strong = weak;
            if (!strong) return;
            if (strong->_inFlight) strong->_inFlight--;
            [strong->_pending removeObject:key];
            if (generation != strong->_generation) {
                [strong schedule];
                return;
            }
            [strong noteRenderSeconds:inkSeconds];
            if (generation != strong->_generation) {
                [strong schedule];
                return;
            }
            strong->_completed++;
            [strong storeImage:image labels:labels centres:centres step:step];
            [strong publish];
            [strong schedule];
        });
    });
}

@end
