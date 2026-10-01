#import <AppKit/AppKit.h>
#import "ownrender.h"
#import "archive.h"
#import "pure.h"
#import "surfview.h"
#import "rawmovie.h"

// Explicit public export: model maps and a named coastal forecast only.
// Never walk/copy the archive, its observations, briefings or user settings.
static BOOL PNG(NSImage *image, NSString *path) {
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
    return [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
}
static id Number(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID() && isfinite([value doubleValue]) ? value : NSNull.null;
}
int main(int argc, const char *argv[]) { @autoreleasepool {
    if(argc!=4) { fprintf(stderr,"usage: export-site ARCHIVE OUTPUT COAST\n"); return 2; }
    NSString *root=[NSString stringWithUTF8String:argv[1]], *out=[NSString stringWithUTF8String:argv[2]];
    NSString *error=nil;
    OwnRun *run=OwnRunLoadPublished(root,NO,[NSString stringWithUTF8String:argv[3]],&error);
    if(!run || run.hours<2) { fprintf(stderr,"No complete model run: %s\n",error.UTF8String); return 1; }
    NSISO8601DateFormatter *iso=[NSISO8601DateFormatter new];
    NSDate *now=NSDate.date;
    NSString *generation=[NSString stringWithFormat:@"frames-%lld",(long long)now.timeIntervalSince1970];
    NSString *framesDir=[out stringByAppendingPathComponent:generation];
    NSError *failure=nil;
    if(![NSFileManager.defaultManager createDirectoryAtPath:framesDir withIntermediateDirectories:YES attributes:nil error:&failure]) return 1;
    NSMutableArray *frames=[NSMutableArray array];
    NSInteger start=0;
    for(NSInteger i=1;i<run.hours;i++) if([[run timeAtIndex:i] compare:now] != NSOrderedDescending) start=i;
    NSDate *previous=nil;
    for(NSInteger i=start;i<run.hours && frames.count<9;i++) { @autoreleasepool {
        NSDate *valid=[run timeAtIndex:i];
        if(previous && [valid timeIntervalSinceDate:previous]<12*3600 && i != run.hours-1) continue;
        if([valid timeIntervalSinceDate:now]>96*3600) break;
        NSMutableDictionary *maps=[NSMutableDictionary dictionary];
        for(NSString *kind in @[@"pressure",@"temperature",@"rain",@"wind"]) {
            if([kind isEqual:@"rain"] && ![run hasRainAtIndex:i]) continue;
            OwnLayerOptions layer={.bare=1,.temperature=[kind isEqual:@"temperature"]?2:0,.barbs=[kind isEqual:@"wind"],.rain=[kind isEqual:@"rain"]};
            NSString *name=[NSString stringWithFormat:@"%lu-%@.png",(unsigned long)frames.count,kind];
            NSImage *image=OwnRunRender(run,i,@"",layer,@[],2);
            if(!image || !PNG(image,[framesDir stringByAppendingPathComponent:name])) return 1;
            maps[kind]=[generation stringByAppendingPathComponent:name];
        }
        [frames addObject:@{@"time":[iso stringFromDate:valid],@"maps":maps}]; previous=valid;
    }}
    if(frames.count<2) { fprintf(stderr,"Insufficient forecast coverage\n"); return 1; }
    // This is the configured public beach, never the app's current/home place.
    NSArray *surface=StorePointSeries(ArchivePointFile(root,@{@"latitude":@(-31.995),@"longitude":@(115.752)}));
    NSArray *marine=SurfOutlook(ArchiveMarineProduct(root,@"cottesloe"),now)[@"rows"];
    NSMutableDictionary *seaByTime=[NSMutableDictionary dictionary];
    for(NSDictionary *row in marine) if([row[@"time"] isKindOfClass:NSDate.class]) seaByTime[row[@"time"]]=row;
    NSMutableArray *hours=[NSMutableArray array];
    for(NSDictionary *row in surface) {
        NSDate *time=row[@"time"];
        if(![time isKindOfClass:NSDate.class] || [time timeIntervalSinceDate:now]<-3600 || [time timeIntervalSinceDate:now]>48*3600) continue;
        NSDictionary *sea=seaByTime[time] ?: @{};
        [hours addObject:@{@"time":[iso stringFromDate:time],@"temp":Number(row[@"temp"]),@"rain":Number(row[@"rainMm"]),
            @"windKt":Number(row[@"windKt"]),@"gustKt":Number(row[@"gustKt"]),@"windFrom":Number(row[@"windFrom"]),
            @"waveHeight":Number(sea[@"waveHeight"]),@"swellPeriod":Number(sea[@"swellPeriod"]),@"swellFrom":Number(sea[@"swellFrom"])}];
    }
    // A refresh must keep all four public views usable. A missing point feed
    // must not replace the previous site with an apparently healthy empty graph.
    for(NSString *field in @[@"temp",@"rain",@"windKt",@"waveHeight"]) {
        NSUInteger available=0;
        for(NSDictionary *hour in hours) if(Number(hour[field])!=NSNull.null) available++;
        if(available<24) { fprintf(stderr,"Insufficient coastal coverage for %s (%lu hours)\n",field.UTF8String,(unsigned long)available); return 1; }
    }
    NSMutableDictionary *manifest=[@{@"schemaVersion":@1,@"updatedAt":[iso stringFromDate:now],@"runAt":[iso stringFromDate:run.runDate],
        @"source":@"ECMWF",@"frames":frames,@"points":@{@"place":@"Perth coastal",@"hours":hours},
        @"units":@{@"temp":@"°C",@"rain":@"mm / preceding hour",@"windKt":@"kt",@"gustKt":@"kt",@"windFrom":@"degrees from north",@"waveHeight":@"m",@"swellPeriod":@"s",@"swellFrom":@"degrees from north",@"mapRain":@"mm / preceding 24 hours"},
        @"attribution":@[@{@"label":@"ECMWF · CC BY 4.0",@"url":@"https://www.ecmwf.int/en/forecasts/datasets/open-data"},
            @{@"label":@"Open-Meteo · CC BY 4.0",@"url":@"https://open-meteo.com/"},
            @{@"label":@"Natural Earth",@"url":@"https://www.naturalearthdata.com/"}]} mutableCopy];
    NSMutableDictionary *animations=[NSMutableDictionary dictionary];
    for(NSString *kind in @[@"pressure",@"temperature",@"rain",@"wind"]) { @autoreleasepool {
        OwnLayerOptions layer={.bare=1,.temperature=[kind isEqual:@"temperature"]?2:0,.barbs=[kind isEqual:@"wind"],.rain=[kind isEqual:@"rain"]};
        NSString *name=[kind stringByAppendingPathExtension:@"mp4"];
        NSURL *movie=[NSURL fileURLWithPath:[framesDir stringByAppendingPathComponent:name]];
        NSProgress *progress=[NSProgress progressWithTotalUnitCount:7200];
        fprintf(stderr,"Preparing %s animation…\n",kind.UTF8String);
        if(!IsobarWriteRawMovie(run,movie,start,run.hours-1,60,120,layer,progress,&error)) {
            fprintf(stderr,"Animation export failed: %s\n",error.UTF8String); return 1;
        }
        animations[kind]=@{@"src":[generation stringByAppendingPathComponent:name],@"layer":kind,
            @"durationSeconds":@120,@"fps":@60,@"validFrom":[iso stringFromDate:[run timeAtIndex:start]],
            @"validTo":[iso stringFromDate:[run timeAtIndex:run.hours-1]],@"forecastRun":[iso stringFromDate:run.runDate]};
    }}
    manifest[@"animations"]=animations;
    // Release information is authored separately, never guessed from a tag.
    NSData *releaseData=[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"release.json"]];
    id release=releaseData?[NSJSONSerialization JSONObjectWithData:releaseData options:0 error:nil]:nil;
    if([release isKindOfClass:NSDictionary.class]) manifest[@"release"]=release;
    NSData *json=[NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:&failure];
    if(!json || ![json writeToFile:[out stringByAppendingPathComponent:@"current.json"] options:NSDataWritingAtomic error:&failure]) return 1;
    printf("Exported %lu maps and %lu coastal hours\n",(unsigned long)frames.count,(unsigned long)hours.count);
    return 0;
}}
