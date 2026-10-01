#import <AppKit/AppKit.h>
#import "rawmovie.h"

int main(int argc, const char *argv[]) { @autoreleasepool {
    if (argc < 5 || argc > 8) { fprintf(stderr,"Usage: raw-movie ARCHIVE OUTPUT COAST pressure|temperature|wind|rain [SECONDS] [START-INDEX] [FPS]\n"); return 2; }
    NSString *error=nil, *kind=[NSString stringWithUTF8String:argv[4]];
    if (![@[@"pressure",@"temperature",@"wind",@"rain"] containsObject:kind]) return 2;
    OwnRun *run=OwnRunLoadPublished([NSString stringWithUTF8String:argv[1]], NO, [NSString stringWithUTF8String:argv[3]], &error);
    if (!run) { fprintf(stderr,"%s\n",error.UTF8String); return 1; }
    NSInteger start=0;
    NSDate *now=NSDate.date;
    for(NSInteger i=1;i<run.hours;i++) if([[run timeAtIndex:i] compare:now] != NSOrderedDescending) start=i;
    double from=argc>6 ? atof(argv[6]) : start;
    double duration=argc>5 ? atof(argv[5]) : 120;
    NSInteger fps=argc>7 ? atoi(argv[7]) : 60;
    NSURL *out=[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
    OwnLayerOptions layers={.bare=1,.temperature=[kind isEqual:@"temperature"]?2:0,.barbs=[kind isEqual:@"wind"],.rain=[kind isEqual:@"rain"]};
    NSProgress *progress=[NSProgress progressWithTotalUnitCount:1];
    NSTimeInterval began=NSProcessInfo.processInfo.systemUptime;
    BOOL result=IsobarWriteRawMovie(run,out,from,run.hours-1,fps,duration,layers,progress,&error);
    if(!result) { fprintf(stderr,"%s\n",error.UTF8String); return 1; }
    NSISO8601DateFormatter *iso=[NSISO8601DateFormatter new];
    NSDate *lower=[run timeAtIndex:(NSInteger)floor(from)];
    NSDate *upper=[run timeAtIndex:MIN(run.hours-1,(NSInteger)ceil(from))];
    NSDate *validFrom=[lower dateByAddingTimeInterval:[upper timeIntervalSinceDate:lower]*(from-floor(from))];
    NSDictionary *metadata=@{@"schemaVersion":@1,@"layer":kind,@"durationSeconds":@(progress.completedUnitCount/(double)fps),@"fps":@(fps),
        @"frameCount":@(progress.completedUnitCount),@"fromIndex":@(from),@"toIndex":@(run.hours-1),
        @"validFrom":[iso stringFromDate:validFrom],
        @"validTo":[iso stringFromDate:[run timeAtIndex:run.hours-1]],
        @"forecastRun":[iso stringFromDate:run.runDate],@"generatedAt":[iso stringFromDate:now],
        @"source":@"ECMWF Open Data",@"attribution":@"ECMWF Open Data · CC BY 4.0 / Natural Earth",
        @"interpolation":@"Linear interpolation of raw model fields; wind interpolated as vectors"};
    NSData *json=[NSJSONSerialization dataWithJSONObject:metadata options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];
    if(![json writeToFile:[[out.path stringByDeletingPathExtension] stringByAppendingPathExtension:@"json"] atomically:YES]) return 1;
    fprintf(stderr,"Rendered %lld raw frames in %.1fs → %s\n",progress.completedUnitCount,NSProcessInfo.processInfo.systemUptime-began,out.path.UTF8String);
    return 0;
}}
