#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString * const IsobarNotacErrorDomain;

// NOTAC keys are deliberately kept out of UserDefaults, process arguments,
// environment variables, logs and returned collector output.
FOUNDATION_EXPORT BOOL IsobarNotacTokenIsValid(NSString * _Nullable token);

@protocol IsobarNotacKeychain <NSObject>
- (BOOL)saveToken:(NSString *)token error:(NSError * _Nullable * _Nullable)error;
- (nullable NSString *)loadToken:(NSError * _Nullable * _Nullable)error;
- (BOOL)removeToken:(NSError * _Nullable * _Nullable)error;
@end

@interface IsobarNotacConnection : NSObject

- (instancetype)initWithService:(NSString *)service
                         account:(NSString *)account
                         keychain:(id<IsobarNotacKeychain> _Nullable)keychain NS_DESIGNATED_INITIALIZER;
- (instancetype)init;

- (BOOL)saveToken:(NSString *)token error:(NSError * _Nullable * _Nullable)error;
- (nullable NSString *)loadToken:(NSError * _Nullable * _Nullable)error;
- (BOOL)removeToken:(NSError * _Nullable * _Nullable)error;

// Runs on a background queue. The completion is also called on that queue;
// callers that update AppKit state should dispatch back to the main queue.
// The token is written to the task's stdin and is never included in arguments,
// the environment, output, or an error returned by this API.
- (void)fetchWithDataDirectory:(NSString *)dataDirectory
                executableURL:(NSURL *)executableURL
                    completion:(void (^)(BOOL success, NSString *message))completion;

@end

NS_ASSUME_NONNULL_END
