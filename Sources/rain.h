#import <Foundation/Foundation.h>

// Input: time (end of the accumulation hour), rainMm, optional weatherCode.
// Output: headline / amount24 for the 24-hour glance; hours contains 48
// start/end, known, mm and kind buckets. line/detail retain exact event data.
NSDictionary *RainOutlook(NSArray<NSDictionary *> *rows, NSDate *now, NSTimeZone *tz);
