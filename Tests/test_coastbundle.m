// The installed app runs from / without ISOBAR_COAST. Run this binary from
// inside a bundle, as the app is, and require the bundled coastline.
#import <Foundation/Foundation.h>
#import "ownchart.h"

int main(void) { @autoreleasepool {
    unsetenv("ISOBAR_COAST");
    unsetenv("ISOBAR_WORLD_COAST");
    chdir("/");
    NSString *path = OwnCoastPath();
    OwnCoast coast = OwnCoastParse([NSData dataWithContentsOfFile:path]);
    BOOL ok = [path hasPrefix:NSBundle.mainBundle.bundlePath] && coast.rings > 100;
    printf("%s bundled coastline from / (%s, %d rings)\n", ok ? "ok  " : "FAIL", path.UTF8String, coast.rings);
    OwnCoastFree(coast);
    NSString *worldPath = OwnWorldCoastPath();
    OwnCoast world = OwnCoastParse([NSData dataWithContentsOfFile:worldPath]);
    BOOL worldOK = [worldPath hasPrefix:NSBundle.mainBundle.bundlePath] && world.rings > 1000 && world.points > 50000;
    printf("%s bundled world coastline from / (%d rings)\n", worldOK ? "ok  " : "FAIL", world.rings);
    OwnCoastFree(world);
    ok = ok && worldOK;
    return ok ? 0 : 1;
}}
