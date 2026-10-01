#import <AppKit/AppKit.h>
#import "ownrender.h"

typedef void (^IsobarScrubCompletion)(NSImage *image, double index);

// A small asynchronous renderer for pointer scrubbing before the prepared
// movie exists. Instances are main-thread driven; rendering and motion-state
// mutation stay on their private serial queue.
@interface IsobarScrubRenderer : NSObject
- (instancetype)initWithRun:(OwnRun *)run layers:(OwnLayerOptions)layers scale:(CGFloat)scale;
- (void)requestIndex:(double)index completion:(IsobarScrubCompletion)completion;
- (void)cancelRequests;
@property (nonatomic, readonly) NSUInteger renderCount;
@end
