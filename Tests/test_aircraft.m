#import <Foundation/Foundation.h>
#import "aircraft.h"

static int failures;
static void ck(BOOL ok, NSString *msg) {
    fprintf(stderr, "%s %s\n", ok ? "ok  " : "FAIL", msg.UTF8String);
    if (!ok) failures++;
}

static NSArray<NSString *> *RequiredKeys(void) {
    return @[ @"name", @"title", @"nickname", @"recognition", @"history", @"source", @"height" ];
}

int main(void) { @autoreleasepool {
    NSArray<NSDictionary *> *cards = AircraftRecognitionCards();
    ck(cards.count == 7, @"seven recognition cards");

    NSArray *order = @[ @"plane", @"glider", @"pc9", @"kingair", @"jumbo", @"u2", @"sr71" ];
    NSMutableSet *names = [NSMutableSet set];
    NSMutableSet *titles = [NSMutableSet set];
    double previousHeight = -INFINITY;

    for (NSUInteger i = 0; i < cards.count; i++) {
        NSDictionary *card = cards[i];
        ck([card isKindOfClass:NSDictionary.class], @"card is dictionary");
        for (NSString *key in RequiredKeys()) {
            id value = card[key];
            if ([key isEqual:@"height"]) {
                ck([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue]), @"height is numeric");
            } else {
                ck([value isKindOfClass:NSString.class] && [value length] > 0, [key stringByAppendingFormat:@" present on card %lu", (unsigned long)i]);
            }
        }
        NSString *name = card[@"name"];
        ck([name isEqual:order[i]], @"catalogue order");
        ck(![names containsObject:name], @"distinct asset name");
        [names addObject:name];
        NSString *title = card[@"title"];
        ck(![titles containsObject:title], @"distinct title");
        [titles addObject:title];

        double height = [card[@"height"] doubleValue];
        ck(height > previousHeight, @"heights ascend");
        ck(height >= 914.4 && height <= 19812, @"height in illustrative range");
        previousHeight = height;
    }

    ck(fabs([cards[0][@"height"] doubleValue] - 914.4) < 0.01, @"plane reference height");
    ck(fabs([cards[6][@"height"] doubleValue] - 19812) < 0.01, @"sr71 reference height");
    ck([[cards[2][@"history"] lowercaseString] containsString:@"raaf"], @"pc9 RAAF role");
    ck([[cards[3][@"recognition"] lowercaseString] containsString:@"t tail"], @"king air cue");
    ck([[cards[4][@"recognition"] lowercaseString] containsString:@"hump"], @"747 cue");
    ck([cards[5][@"history"] containsString:@"1955"], @"u2 first flight");
    ck([[cards[6][@"recognition"] lowercaseString] containsString:@"chine"], @"sr71 cue");

    return failures ? 1 : 0;
} }
