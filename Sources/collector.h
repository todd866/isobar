#import <Foundation/Foundation.h>

// Owns the collector process shipped inside the app. It never installs a
// service or changes the user's Python environment.
@interface IsobarCollector : NSObject
@property(nonatomic, copy) void (^onUpdate)(void);
@property(nonatomic, readonly) BOOL running;
@property(nonatomic, readonly) NSString *lastError;
- (instancetype)initWithExecutable:(NSURL *)executable store:(NSURL *)store;
- (void)refresh;
- (void)stop;
@end
