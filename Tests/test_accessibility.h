#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// Keep animation tests independent of the runner's desktop preference. This
// swaps only the NSWorkspace getter in the current test process and restores
// the original IMP before the suite exits; it never writes accessibility
// preferences or changes another process.
static IMP IsobarTestOriginalReduceMotionIMP;
static Method IsobarTestReduceMotionMethod;
static BOOL IsobarTestReduceMotionOverrideActive;
static BOOL IsobarTestReduceMotionValue;

static BOOL IsobarTestReduceMotionGetter(id self, SEL selector) {
    (void)self; (void)selector;
    return IsobarTestReduceMotionValue;
}

static void IsobarTestSetReduceMotion(BOOL reduceMotion) {
    if (!IsobarTestReduceMotionOverrideActive) {
        IsobarTestReduceMotionMethod = class_getInstanceMethod([NSWorkspace class], @selector(accessibilityDisplayShouldReduceMotion));
        if (!IsobarTestReduceMotionMethod) return;
        IsobarTestOriginalReduceMotionIMP = method_setImplementation(IsobarTestReduceMotionMethod, (IMP)IsobarTestReduceMotionGetter);
        IsobarTestReduceMotionOverrideActive = YES;
    }
    IsobarTestReduceMotionValue = reduceMotion;
}

static void IsobarTestRestoreReduceMotion(void) {
    if (!IsobarTestReduceMotionOverrideActive) return;
    method_setImplementation(IsobarTestReduceMotionMethod, IsobarTestOriginalReduceMotionIMP);
    IsobarTestReduceMotionMethod = NULL;
    IsobarTestOriginalReduceMotionIMP = NULL;
    IsobarTestReduceMotionOverrideActive = NO;
}
