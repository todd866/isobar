#import "trainingwindow.h"
#import "trainingdata.h"
#import <WebKit/WebKit.h>

@interface TrainingHost : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) WKWebView *web;
@property (nonatomic, copy) NSString *storeRoot;
@property (nonatomic, copy) NSString *coastPath;
@property (nonatomic, copy) NSString *webRoot;
@property (nonatomic, copy) NSString *progressPath;
@property (nonatomic, copy) NSString *theme;
@property (nonatomic, strong) NSDate *now;
@property (nonatomic) BOOL temporaryProgress;
@end

@implementation TrainingHost

static NSString *ScriptJSON(NSData *data) {
    if (!data.length) return @"null";
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!text.length) return @"null";
    text = [text stringByReplacingOccurrencesOfString:@"<" withString:@"\\u003c"];
    text = [text stringByReplacingOccurrencesOfString:@"\u2028" withString:@"\\u2028"];
    text = [text stringByReplacingOccurrencesOfString:@"\u2029" withString:@"\\u2029"];
    return text;
}

- (void)webView:(__unused WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    NSString *root = [self.webRoot stringByStandardizingPath];
    NSString *path = url.path.stringByStandardizingPath;
    BOOL localFile = url.isFileURL && root.length &&
        ([path isEqualToString:root] || [path hasPrefix:[root stringByAppendingString:@"/"]]);
    BOOL blank = [url.scheme isEqualToString:@"about"];
    decisionHandler((localFile || blank) ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)loadPage {
    [self.web stopLoading];
    [self detach];
    self.web = nil;
    WKUserContentController *content = [WKUserContentController new];
    [content addScriptMessageHandler:self name:@"training"];
    NSData *snapshot = TrainingSnapshotJSON(self.storeRoot, self.now, self.coastPath);
    NSData *progress = TrainingProgressRead(self.progressPath);
    NSString *theme = [self.theme isEqual:@"dark"] ? @"dark" : @"light";
    NSString *source = [NSString stringWithFormat:
        @"window.__THEME='%@';window.isobar={snapshot:%@,progress:%@,"
        "save:function(p){window.webkit.messageHandlers.training.postMessage(p);},"
        "close:function(){window.webkit.messageHandlers.training.postMessage({cmd:'close'});}};",
        theme, ScriptJSON(snapshot), ScriptJSON(progress)];
    WKUserScript *script = [[WKUserScript alloc] initWithSource:source
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    [content addUserScript:script];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.userContentController = content;
    config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    WKWebView *web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    web.navigationDelegate = self;
    self.window.contentView = web;
    self.web = web;
    NSURL *root = [NSURL fileURLWithPath:self.webRoot isDirectory:YES];
    NSURL *page = [root URLByAppendingPathComponent:@"index.html"];
    [web loadFileURL:page allowingReadAccessToURL:root];
}

- (void)userContentController:(__unused WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:NSDictionary.class]) return;
    if ([message.body[@"cmd"] isEqual:@"close"]) {
        [self.window close];
        return;
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:message.body options:0 error:nil];
    TrainingProgressWrite(self.progressPath, json, nil);
}

- (void)detach {
    self.web.navigationDelegate = nil;
    [self.web.configuration.userContentController removeScriptMessageHandlerForName:@"training"];
}

@end

static TrainingHost *PresentedHost;

static NSString *TrainingWebRoot(void) {
    NSString *page = [[NSBundle mainBundle] pathForResource:@"index" ofType:@"html" inDirectory:@"training"];
    if (page.length) return [page.stringByDeletingLastPathComponent stringByStandardizingPath];
    const char *env = getenv("ISOBAR_TRAINING_DIST");
    if (!env || !env[0]) return nil;
    NSString *root = [[NSString stringWithUTF8String:env] stringByStandardizingPath];
    NSString *index = [root stringByAppendingPathComponent:@"index.html"];
    return [NSFileManager.defaultManager fileExistsAtPath:index] ? root : nil;
}

static NSString *TrainingCoastPath(void) {
    NSString *coast = [[NSBundle mainBundle] pathForResource:@"ownchart-coast" ofType:@"bin"];
    if (coast.length) return coast;
    const char *env = getenv("ISOBAR_COAST");
    return (env && env[0]) ? [NSString stringWithUTF8String:env] : nil;
}

static BOOL TrainingHarnessOffscreen(void) {
    const char *force = getenv("ISOBAR_TRAINING_OFFSCREEN");
    if (force && force[0] == '1') return YES;
    if (force && force[0] == '0') return NO;
    // A loose test binary is not the menu-bar app. Never order that window
    // onto a desktop; setActivationPolicy can fail and still leave it visible.
    NSString *ext = NSBundle.mainBundle.bundleURL.pathExtension.lowercaseString;
    if (![ext isEqualToString:@"app"]) return YES;
    return NSApp.activationPolicy == NSApplicationActivationPolicyProhibited;
}

void TrainingWindowConfigure(NSWindow *window) {
    window.styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    window.title = @"Training";
    window.contentMinSize = NSMakeSize(960, 640);
    // Full-screen stays available from the green button. Opening does not enter it.
    window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    [window setContentSize:NSMakeSize(1280, 820)];
    [window center];
    // A saved frame replaces the default. The name is what makes later moves stick.
    [window setFrameAutosaveName:@"IsobarTraining"];
}

void TrainingWindowDismiss(void) {
    TrainingHost *host = PresentedHost;
    PresentedHost = nil;
    if (!host) return;
    BOOL temporary = host.temporaryProgress;
    NSString *progress = host.progressPath;
    [host.web stopLoading];
    [host detach];
    [host.window orderOut:nil];
    [host.window close];
    if (temporary && progress.length) [NSFileManager.defaultManager removeItemAtPath:progress error:nil];
}

void TrainingWindowPresent(NSString *storeRoot, NSDate *now) {
    NSString *webRoot = TrainingWebRoot();
    if (!webRoot.length || !storeRoot.length) return;
    BOOL offscreen = TrainingHarnessOffscreen();
    TrainingHost *host = PresentedHost ?: [TrainingHost new];
    host.storeRoot = storeRoot;
    host.now = now;
    host.coastPath = TrainingCoastPath();
    host.webRoot = webRoot;
    host.theme = [NSApp.effectiveAppearance.name.lowercaseString containsString:@"dark"] ? @"dark" : @"light";
    if (offscreen) {
        if (!host.temporaryProgress || !host.progressPath.length) {
            host.progressPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
                [NSString stringWithFormat:@"isobar-training-%@.json", NSUUID.UUID.UUIDString]];
            host.temporaryProgress = YES;
        }
    } else {
        host.progressPath = TrainingProgressPath();
        host.temporaryProgress = NO;
    }
    NSWindow *window = host.window;
    if (!window) {
        // A titled window is constrained onto a screen. The harness uses the
        // same borderless offscreen window as TrainingWindowRenderOffscreen.
        NSRect frame = offscreen ? NSMakeRect(-24000, -24000, 1440, 900)
            : NSMakeRect(0, 0, 1280, 820);
        NSWindowStyleMask mask = offscreen ? NSWindowStyleMaskBorderless
            : (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable);
        window = [[NSWindow alloc] initWithContentRect:frame styleMask:mask
            backing:NSBackingStoreBuffered defer:NO];
        window.title = @"Training";
        window.releasedWhenClosed = NO;
        if (offscreen) {
            window.sharingType = NSWindowSharingNone;
            window.ignoresMouseEvents = YES;
            window.collectionBehavior = NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
        } else {
            TrainingWindowConfigure(window);
        }
        host.window = window;
    } else if (offscreen) {
        [window setFrame:NSMakeRect(-24000, -24000, 1440, 900) display:NO];
    }
    PresentedHost = host;
    [host loadPage];
    if (offscreen) {
        [window orderFrontRegardless];
        [window setFrame:NSMakeRect(-24000, -24000, 1440, 900) display:NO];
        return;
    }
    [window makeKeyAndOrderFront:nil];
}

static BOOL PumpUntil(BOOL (^done)(void), NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    return done();
}

static BOOL ImageVaries(NSImage *image) {
    NSData *tiff = image.TIFFRepresentation;
    NSBitmapImageRep *rep = tiff.length ? [[NSBitmapImageRep alloc] initWithData:tiff] : nil;
    if (rep.pixelsWide < 8 || rep.pixelsHigh < 8) return NO;
    NSColor *first = [[rep colorAtX:8 y:8] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    for (NSInteger y = 8; y < rep.pixelsHigh - 8; y += 40) {
        for (NSInteger x = 8; x < rep.pixelsWide - 8; x += 40) {
            NSColor *sample = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (!sample || !first) return YES;
            if (fabs(sample.redComponent - first.redComponent) > 0.04 ||
                fabs(sample.greenComponent - first.greenComponent) > 0.04 ||
                fabs(sample.blueComponent - first.blueComponent) > 0.04) return YES;
        }
    }
    return NO;
}

BOOL TrainingWindowRenderOffscreen(NSString *storeRoot, NSString *webRoot, NSString *coastPath,
    NSString *appearance, NSSize size, NSString *pngPath, NSString *progressPath, NSString **error) {
    if (size.width < 100 || size.height < 100 || !webRoot.length || !pngPath.length) {
        if (error) *error = @"render size or paths are missing";
        return NO;
    }
    if (appearance.length && ![appearance isEqual:@"light"] && ![appearance isEqual:@"dark"]) {
        if (error) *error = @"appearance must be light or dark";
        return NO;
    }
    NSString *page = [webRoot stringByAppendingPathComponent:@"index.html"];
    if (![NSFileManager.defaultManager fileExistsAtPath:page]) {
        if (error) *error = @"training bundle has no index.html";
        return NO;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSString *progress = progressPath;
    BOOL temporary = !progress.length;
    if (temporary) progress = [NSTemporaryDirectory() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
    TrainingHost *host = [TrainingHost new];
    host.storeRoot = storeRoot;
    host.coastPath = coastPath;
    host.webRoot = webRoot;
    host.progressPath = progress;
    host.theme = appearance.length ? appearance : @"light";
    NSRect frame = NSMakeRect(-24000, -24000, size.width, size.height);
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.sharingType = NSWindowSharingNone;
    window.ignoresMouseEvents = YES;
    host.window = window;
    [host loadPage];
    [window orderFrontRegardless];
    __block BOOL ready = NO;
    __block BOOL pending = NO;
    BOOL painted = PumpUntil(^BOOL{
        if (ready) return YES;
        if (!pending) {
            pending = YES;
            [host.web evaluateJavaScript:@"window.__TRAINING_READY === true" completionHandler:^(id result, NSError *jsError) {
                (void)jsError;
                pending = NO;
                if ([result boolValue]) ready = YES;
            }];
        }
        return NO;
    }, 30);
    if (!painted) painted = PumpUntil(^BOOL{ return ready; }, 2);
    if (!painted) {
        [window orderOut:nil];
        [host detach];
        [window close];
        if (temporary) [NSFileManager.defaultManager removeItemAtPath:progress error:nil];
        if (error) *error = @"training page did not become ready";
        return NO;
    }
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.4]];
    WKSnapshotConfiguration *config = [WKSnapshotConfiguration new];
    config.rect = NSMakeRect(0, 0, size.width, size.height);
    config.afterScreenUpdates = YES;
    __block NSImage *shot = nil;
    __block BOOL shotDone = NO;
    [host.web takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *shotError) {
        (void)shotError;
        shot = image;
        shotDone = YES;
    }];
    PumpUntil(^BOOL{ return shotDone; }, 20);
    BOOL varied = ImageVaries(shot);
    NSData *tiff = shot.TIFFRepresentation;
    NSBitmapImageRep *rep = tiff.length ? [[NSBitmapImageRep alloc] initWithData:tiff] : nil;
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    BOOL wrote = png.length > 1000 && [png writeToFile:pngPath atomically:YES];
    [window orderOut:nil];
    [host detach];
    [window close];
    if (temporary) [NSFileManager.defaultManager removeItemAtPath:progress error:nil];
    if (!wrote || !varied) {
        if (error) *error = varied ? @"snapshot was not written" : @"snapshot was blank";
        return NO;
    }
    return YES;
}
