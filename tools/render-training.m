#import <Cocoa/Cocoa.h>
#import "trainingwindow.h"

// Offscreen Training window. Does not call TrainingWindowPresent and does not
// open a visible window. Progress is the caller's file, never the pilot's.
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 9) {
            fprintf(stderr, "usage: render-training STORE WEBROOT APPEARANCE WIDTH HEIGHT PNG COAST PROGRESS\n");
            return 2;
        }
        NSString *error = nil;
        BOOL ok = TrainingWindowRenderOffscreen(@(argv[1]), @(argv[2]), @(argv[7]), @(argv[3]),
            NSMakeSize(atoi(argv[4]), atoi(argv[5])), @(argv[6]), @(argv[8]), &error);
        if (!ok) {
            fprintf(stderr, "render-training: %s\n", (error ?: @"failed").UTF8String);
            return 1;
        }
        printf("wrote %s\n", argv[6]);
        return 0;
    }
}
