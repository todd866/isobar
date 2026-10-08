#import "storereload.h"
#import "archive.h"
#import "ownrender.h"
#import "ownchart.h"
#import "pure.h"
#import <sys/stat.h>

StoreReloadHook StoreReloadTestHook;

void StoreReloadNote(const char *phase) {
    StoreReloadHook hook = StoreReloadTestHook;
    if (hook) hook(phase);
}

BOOL IsPDF(NSData *data) {
    return data.length >= 5 && memcmp(data.bytes, "%PDF-", 5) == 0;
}

CGPDFDocumentRef PDFDocumentFromData(NSData *data) {
    if (!IsPDF(data)) return NULL;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    if (!provider) return NULL;
    CGPDFDocumentRef doc = CGPDFDocumentCreateWithProvider(provider);
    CGDataProviderRelease(provider);
    if (doc && CGPDFDocumentGetNumberOfPages(doc) < 1) {
        CGPDFDocumentRelease(doc);
        return NULL;
    }
    return doc;
}

dispatch_queue_t StoreReloadQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("isobar.store",
            dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0));
    });
    return queue;
}

@implementation StoreReloadRequest
@end

@interface StoreSnapshot ()
@property (nonatomic, copy) NSString *root;
@property (nonatomic, strong) NSDate *now;
@property (nonatomic) BOOL statusOK, publishedGrid, publishedStore;
@property (nonatomic, copy) NSString *source;
@property (nonatomic, strong) OwnRun *run, *previousRun;
@property (nonatomic, strong) NSDate *runDate, *previousRunDate, *issued;
@property (nonatomic, copy) NSArray<NSNumber *> *frameIndices;
@property (nonatomic, copy) NSString *error;
@property (nonatomic, copy) NSString *runStamp, *previousRunStamp;
@property (nonatomic) StoreChartChange chartChange, previousChange;
@property (nonatomic, strong) NSData *chartPDF, *chartDrawn, *previousPDF;
@property (nonatomic, copy) NSArray<NSDate *> *previousTimes;
@property (nonatomic, copy) NSArray *rainDots, *kiteList, *airportSeries;
@property (nonatomic, strong) NSNumber *kiteMin, *kiteMax;
@property (nonatomic, copy) NSDictionary<NSString *, NSDictionary *> *weather;
@property (nonatomic, copy) NSDictionary *aviation, *notams, *sigmets, *atmosphere;
@property (nonatomic) BOOL atmosphereLoaded;
@end

@implementation StoreSnapshot {
    id _chartDocumentObject, _previousDocumentObject;
}
- (CGPDFDocumentRef)chartDocument { return (__bridge CGPDFDocumentRef)_chartDocumentObject; }
- (CGPDFDocumentRef)previousDocument { return (__bridge CGPDFDocumentRef)_previousDocumentObject; }
- (void)adoptChartDocument:(CGPDFDocumentRef)doc { _chartDocumentObject = CFBridgingRelease(doc); }
- (void)adoptPreviousDocument:(CGPDFDocumentRef)doc { _previousDocumentObject = CFBridgingRelease(doc); }
@end

// ctime also catches a same-size edit whose writer restores its mtime.
static NSString *StatStamp(NSString *path, const struct stat *info) {
    return [NSString stringWithFormat:@"%@|%llu|%llu|%lld.%09ld|%lld.%09ld", path,
        (unsigned long long)info->st_size, (unsigned long long)info->st_ino,
        (long long)info->st_mtimespec.tv_sec, info->st_mtimespec.tv_nsec,
        (long long)info->st_ctimespec.tv_sec, info->st_ctimespec.tv_nsec];
}

static NSString *FileStamp(NSString *path) {
    struct stat info;
    if (!path.length || stat(path.fileSystemRepresentation, &info) != 0)
        return [NSString stringWithFormat:@"%@|missing", path];
    return StatStamp(path, &info);
}

// Metadata of every file under a directory, sorted. One stat per entry.
static NSString *TreeStamp(NSString *directory) {
    NSDirectoryEnumerator *walk = [NSFileManager.defaultManager enumeratorAtPath:directory];
    if (!walk) return nil;
    NSMutableArray *stamps = [NSMutableArray array];
    for (NSString *relative in walk) {
        NSString *path = [directory stringByAppendingPathComponent:relative];
        struct stat info;
        if (stat(path.fileSystemRepresentation, &info) != 0) [stamps addObject:[path stringByAppendingString:@"|missing"]];
        else if (!S_ISDIR(info.st_mode)) [stamps addObject:StatStamp(path, &info)];
    }
    [stamps sortUsingSelector:@selector(compare:)];
    return [stamps componentsJoinedByString:@"\n"];
}

// The inputs of a legacy run: its directory and the coast file.
static NSString *LegacyStamp(NSString *directory, NSString *coastPath) {
    NSString *files = TreeStamp(directory);
    return files ? [NSString stringWithFormat:@"%@\n%@", files, FileStamp(coastPath)] : nil;
}

// The collector's run id, YYYYMMDDTHHZ, and nothing else: no path can be
// built from anything that is not one.
static BOOL CollectorRunID(id value) {
    if (![value isKindOfClass:NSString.class] || [value length] != 12) return NO;
    for (NSUInteger i = 0; i < 12; i++) {
        unichar c = [value characterAtIndex:i];
        if (i == 8 ? c != 'T' : (i == 11 ? c != 'Z' : (c < '0' || c > '9'))) return NO;
    }
    return YES;
}

// A global pointer is authoritative whenever it exists. An unreadable global
// pointer therefore cannot make the older regional product look healthy.
static NSString *PublishedFamilyForRoot(NSString *root, BOOL *globalOut) {
    NSString *grids = [root stringByAppendingPathComponent:@"products/grids"];
    NSString *global = [grids stringByAppendingPathComponent:@"ecmwf_ifs_global"];
    BOOL isGlobal = [NSFileManager.defaultManager fileExistsAtPath:
        [global stringByAppendingPathComponent:@"current.json"]];
    if (globalOut) *globalOut = isGlobal;
    return isGlobal ? global : [grids stringByAppendingPathComponent:@"ecmwf_ifs025"];
}

static NSString *PublishedCoastForRoot(NSString *root, NSString *regionalCoast) {
    BOOL isGlobal = NO;
    PublishedFamilyForRoot(root, &isGlobal);
    return isGlobal ? OwnWorldCoastPath() : regionalCoast;
}

// The inputs of a published run: the pointer's bytes, every file of the run
// and of all retained older runs that may supply rain frames, plus the coast file. The
// same inputs make the same field, whatever the parsed-run cache has evicted.
// A pointer with any id that is not the collector's gets no stamp, so it is
// never walked; OwnRunLoadPublished then rejects it.
NSString *StorePublishedRunStamp(NSString *root, BOOL previous, NSString *coastPath) {
    NSString *family = PublishedFamilyForRoot(root, NULL);
    NSData *pointerData = [NSData dataWithContentsOfFile:[family stringByAppendingPathComponent:@"current.json"]];
    id pointer = pointerData ? [NSJSONSerialization JSONObjectWithData:pointerData options:0 error:nil] : nil;
    NSString *latest = [pointer isKindOfClass:NSDictionary.class] ? pointer[@"latest"] : nil;
    NSArray *runs = [pointer isKindOfClass:NSDictionary.class] ? pointer[@"runs"] : nil;
    if (!CollectorRunID(latest) || ![runs isKindOfClass:NSArray.class]) return nil;
    for (id run in runs) if (!CollectorRunID(run)) return nil;
    // Text order is time order for these ids.
    NSString *older = nil;
    for (NSString *run in runs)
        if ([run compare:latest] == NSOrderedAscending && (!older || [run compare:older] == NSOrderedDescending)) older = run;
    // Current published loads may derive rain from any retained older cycle,
    // so every retained run belongs in the stamp. Previous mode reads only
    // the selected older run.
    NSArray *read = nil;
    if (previous) read = older ? @[older] : @[];
    else {
        NSMutableArray *all = [NSMutableArray arrayWithObject:latest];
        for (NSString *run in runs) if (![run isEqual:latest]) [all addObject:run];
        read = all;
    }
    NSMutableString *stamp = [NSMutableString stringWithFormat:@"%d\n%@\n%@", previous,
        [pointerData base64EncodedStringWithOptions:0],
        FileStamp(PublishedCoastForRoot(root, coastPath))];
    for (NSString *run in read) {
        NSString *files = TreeStamp([family stringByAppendingPathComponent:[@"runs" stringByAppendingPathComponent:run]]);
        if (!files) return nil;
        [stamp appendFormat:@"\n%@", files];
    }
    return stamp;
}

// YES when the committed run's inputs are unchanged, so it is reused. Stamps
// are taken before a read, so a write during the read is seen next time.
static BOOL Unchanged(OwnRun *committed, NSString *committedStamp, NSString *stamp) {
    return committed && stamp && [stamp isEqual:committedStamp];
}

StoreSnapshot *StoreSnapshotLoad(StoreReloadRequest *request) {
    StoreSnapshot *s = [StoreSnapshot new];
    @autoreleasepool {
    StoreReloadNote("begin");
    NSString *root = request.root;
    NSDate *now = request.now;
    NSString *coast = PublishedCoastForRoot(root, request.coastPath);
    NSFileManager *fm = NSFileManager.defaultManager;
    s.root = root;
    s.now = now;
    NSData *statusData = [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:StoreStatusRelative()]];
    s.statusOK = StoreStatusOK(statusData);
    s.publishedGrid = [fm fileExistsAtPath:[PublishedFamilyForRoot(root, NULL)
        stringByAppendingPathComponent:@"current.json"]];
    s.publishedStore = s.publishedGrid ||
        [fm fileExistsAtPath:[root stringByAppendingPathComponent:@"products/points/ecmwf_ifs/current.json"]];
    s.source = [root stringByAppendingString:s.publishedGrid ? @"|published" : @"|legacy"];
    s.frameIndices = @[];
    StoreReloadNote("grid");
    if (s.publishedGrid) {
        NSString *error = nil;
        NSString *stamp = StorePublishedRunStamp(root, NO, coast);
        OwnRun *run = Unchanged(request.run, request.runStamp, stamp) ? request.run : OwnRunLoadPublished(root, NO, coast, &error);
        s.error = error;
        s.runStamp = run ? stamp : nil;
        StoreReloadNote("previous grid");
        // A global run is ~550 MiB resident. Issue comparison is not worth a
        // second copy, so it is offered for the Australian grid only.
        BOOL global = NO;
        PublishedFamilyForRoot(root, &global);
        NSString *previousStamp = global ? nil : StorePublishedRunStamp(root, YES, coast);
        s.previousRun = global ? nil
            : Unchanged(request.previousRun, request.previousRunStamp, previousStamp) ? request.previousRun
            : OwnRunLoadPublished(root, YES, coast, nil);
        s.previousRunStamp = s.previousRun ? previousStamp : nil;
        s.previousRunDate = s.previousRun.runDate;
        NSMutableArray *times = [NSMutableArray array];
        for (NSInteger i = 0; i < run.hours; i++) [times addObject:[run timeAtIndex:i] ?: NSNull.null];
        s.run = run;
        s.frameIndices = StoreFrameIndices(times, now) ?: @[];
        if (run && s.frameIndices.count) s.runDate = run.runDate;
        s.issued = run.generated ?: s.runDate;
    } else {
        NSData *latestData = [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:StoreECMWFLatestRelative()]];
        NSString *runPath = StoreLatestRunPath(latestData);
        NSString *runDir = runPath.length ? [[root stringByAppendingPathComponent:@"ecmwf"] stringByAppendingPathComponent:runPath] : nil;
        NSDictionary *manifest = StoreManifestFromJSON([NSData dataWithContentsOfFile:[runDir stringByAppendingPathComponent:@"manifest.json"]]);
        NSDate *candidateRun = [manifest[@"run"] isKindOfClass:NSDate.class] ? manifest[@"run"] : nil;
        if (runDir.length && candidateRun) {
            NSString *error = nil, *stamp = LegacyStamp(runDir, coast);
            OwnRun *run = Unchanged(request.run, request.runStamp, stamp) ? request.run : OwnRunLoad(runDir, coast, &error);
            s.error = error;
            s.run = run;
            s.runStamp = run ? stamp : nil;
            NSArray *times = [manifest[@"times"] isKindOfClass:NSArray.class] ? manifest[@"times"] : @[];
            s.frameIndices = run ? (StoreFrameIndices(times, now) ?: @[]) : @[];
            if (run && s.frameIndices.count) s.runDate = candidateRun;
        }
        s.issued = s.runDate && [manifest[@"generated"] isKindOfClass:NSDate.class] ? manifest[@"generated"] : s.runDate;
        StoreReloadNote("previous grid");
        NSString *ecmwfRoot = [root stringByAppendingPathComponent:@"ecmwf"];
        NSMutableArray *runIDs = [NSMutableArray array];
        for (NSString *name in [fm contentsOfDirectoryAtPath:ecmwfRoot error:nil]) {
            BOOL dir = NO;
            if ([fm fileExistsAtPath:[ecmwfRoot stringByAppendingPathComponent:name] isDirectory:&dir] && dir) [runIDs addObject:name];
        }
        NSString *previousID = StorePreviousRunID(runIDs, runPath);
        if (previousID.length) {
            NSString *prevDir = [ecmwfRoot stringByAppendingPathComponent:previousID];
            NSDictionary *prevManifest = StoreManifestFromJSON([NSData dataWithContentsOfFile:[prevDir stringByAppendingPathComponent:@"manifest.json"]]);
            s.previousRunDate = [prevManifest[@"run"] isKindOfClass:NSDate.class] ? prevManifest[@"run"] : nil;
            NSString *stamp = LegacyStamp(prevDir, coast);
            s.previousRun = Unchanged(request.previousRun, request.previousRunStamp, stamp) ? request.previousRun
                : OwnRunLoad(prevDir, coast, nil);
            s.previousRunStamp = s.previousRun ? stamp : nil;
        }
    }

    StoreReloadNote("pdf");
    NSData *pdf = [NSData dataWithContentsOfFile:ArchiveChartPath(root, NO)];
    if (!IsPDF(pdf)) s.chartChange = StoreChartAbsent;
    else if (request.chartPDF && [pdf isEqualToData:request.chartPDF]) s.chartChange = StoreChartUnchanged;
    else {
        // As adoptChartPDF did on the main thread: the recoloured chart, or
        // the original when the recolour does not open as a document.
        s.chartChange = StoreChartChanged;
        s.chartPDF = pdf;
        NSData *drawn = request.recolourChart ? request.recolourChart(pdf) : nil;
        s.chartDrawn = drawn.length ? drawn : pdf;
        CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)s.chartDrawn);
        CGPDFDocumentRef doc = NULL;
        if (provider) {
            doc = CGPDFDocumentCreateWithProvider(provider);
            CGDataProviderRelease(provider);
            if (!doc || CGPDFDocumentGetNumberOfPages(doc) < 1) {
                if (doc) CGPDFDocumentRelease(doc);
                s.chartDrawn = pdf;
                provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)pdf);
                doc = CGPDFDocumentCreateWithProvider(provider);
                CGDataProviderRelease(provider);
            }
        }
        [s adoptChartDocument:doc];
    }
    StoreReloadNote("previous pdf");
    NSData *previousPDF = [NSData dataWithContentsOfFile:ArchiveChartPath(root, YES)];
    if (!IsPDF(previousPDF)) s.previousChange = StoreChartAbsent;
    else if (request.previousPDF && [previousPDF isEqualToData:request.previousPDF]) s.previousChange = StoreChartUnchanged;
    else {
        s.previousChange = StoreChartChanged;
        s.previousPDF = previousPDF;
        [s adoptPreviousDocument:PDFDocumentFromData(previousPDF)];
        s.previousTimes = PrognosisValidTimes(previousPDF) ?: @[];
    }

    StoreReloadNote("observations");
    NSString *obsDir = [root stringByAppendingPathComponent:@"products/obs"];
    NSMutableArray *dots = [NSMutableArray array];
    NSMutableDictionary *obsByWMO = [NSMutableDictionary dictionary];
    NSMutableDictionary *histByWMO = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSData *> *observationFiles = [NSMutableDictionary dictionary];
    if (s.publishedStore) [observationFiles addEntriesFromDictionary:ArchiveObservationFilesAtDate(root, now) ?: @{}];
    else for (NSString *name in [fm contentsOfDirectoryAtPath:obsDir error:nil]) {
        if (![name.pathExtension.lowercaseString isEqual:@"json"]) continue;
        NSData *body = [NSData dataWithContentsOfFile:[obsDir stringByAppendingPathComponent:name]];
        if (body) observationFiles[name.stringByDeletingPathExtension] = body;
    }
    for (NSString *wmo in [observationFiles.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        NSData *body = observationFiles[wmo];
        NSDictionary *obs = ParseLatestObservation(body);
        NSDictionary *dot = StoreRainObservation(body);
        NSDate *observed = [obs[@"time"] isKindOfClass:NSDate.class] ? obs[@"time"] : nil;
        if ([dot[@"mm"] doubleValue] >= 1 && observed && [now timeIntervalSinceDate:observed] < 2 * 3600) [dots addObject:dot];
        if (obs) obsByWMO[wmo] = obs;
        NSArray *history = ObservationHistory(body);
        if (history.count) histByWMO[wmo] = history;
    }
    s.rainDots = dots;

    StoreReloadNote("kite");
    NSDictionary *kite = StoreKiteFile(s.publishedStore ? ArchiveKiteFile(root)
        : [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:StoreKiteRelative()]]);
    NSArray *kiteList = @[];
    if (kite) {
        s.kiteMin = @([kite[@"minKt"] doubleValue]);
        s.kiteMax = @([kite[@"maxKt"] doubleValue]);
        kiteList = [kite[@"spots"] isKindOfClass:NSArray.class] ? kite[@"spots"] : @[];
    }
    if (request.kiteMin) s.kiteMin = request.kiteMin;
    if (request.kiteMax) s.kiteMax = request.kiteMax;
    s.kiteList = kiteList;

    StoreReloadNote("warnings");
    NSMutableArray *warnings = [NSMutableArray array];
    NSString *warnDir = ArchiveWarningDirectory(root);
    for (NSString *name in [fm contentsOfDirectoryAtPath:warnDir error:nil]) {
        if (![name.pathExtension.lowercaseString isEqual:@"xml"]) continue;
        NSData *body = [NSData dataWithContentsOfFile:[warnDir stringByAppendingPathComponent:name]];
        for (NSDictionary *warning in ParseWarningXML(body)) {
            NSDate *expires = [warning[@"expires"] isKindOfClass:NSDate.class] ? warning[@"expires"] : nil;
            if (expires && [expires compare:now] != NSOrderedDescending) continue;
            if ([warning[@"issue"] isKindOfClass:NSDate.class] && [warning[@"state"] length]) {
                NSMutableDictionary *regional = [warning mutableCopy];
                regional[@"shortTitle"] = [NSString stringWithFormat:@"%@ · %@", warning[@"state"], warning[@"shortTitle"] ?: warning[@"title"]];
                [warnings addObject:regional];
            } else [warnings addObject:warning];
        }
    }

    // A complete snapshot: a place with no readings has no pack at all, so a
    // dropped or unreadable file cannot leave the last snapshot's readings.
    StoreReloadNote("points");
    NSMutableDictionary<NSString *, NSMutableDictionary *> *weather = [NSMutableDictionary dictionary];
    for (NSDictionary *place in GlancePlaces(request.places, kiteList, YES)) {
        NSString *hash = [place[@"geohash"] isKindOfClass:NSString.class] ? place[@"geohash"] : nil;
        if (!hash.length) continue;
        NSString *wmo = [place[@"stationWMO"] description];
        NSDictionary *obs = wmo.length ? obsByWMO[wmo] : nil;
        NSArray *history = wmo.length ? histByWMO[wmo] : @[];
        if (obs && ![obs[@"pressMsl"] isKindOfClass:NSNumber.class]) {
            NSDictionary *nearest = nil;
            double closest = 40;
            for (NSDictionary *candidate in obsByWMO.allValues) {
                if (![candidate[@"pressMsl"] isKindOfClass:NSNumber.class] ||
                    ![candidate[@"lat"] isKindOfClass:NSNumber.class] || ![candidate[@"lon"] isKindOfClass:NSNumber.class]) continue;
                if (fabs([candidate[@"time"] timeIntervalSinceDate:obs[@"time"]]) > 45 * 60) continue;
                double distance = HaversineKm([place[@"latitude"] doubleValue], [place[@"longitude"] doubleValue],
                    [candidate[@"lat"] doubleValue], [candidate[@"lon"] doubleValue]);
                if (distance < closest) { nearest = candidate; closest = distance; }
            }
            if (nearest) {
                obs = ObservationWithPressure(obs, nearest);
                history = ObservationHistoryWithPressure(history, histByWMO[nearest[@"wmo"]]);
            }
        }
        NSString *pointRel = StorePointRelative(hash);
        NSData *point = s.publishedStore ? ArchivePointFile(root, place)
            : (pointRel.length ? [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:pointRel]] : nil);
        NSArray *series = StorePointSeries(point);
        NSArray *hourly = StorePointHours(point, now, 24);
        NSString *state = [place[@"state"] isKindOfClass:NSString.class] ? place[@"state"] : @"";
        NSMutableArray *mine = [NSMutableArray array];
        for (NSDictionary *warning in warnings) {
            NSString *where = [warning[@"state"] isKindOfClass:NSString.class] ? warning[@"state"] : @"";
            if (where.length && state.length && [where caseInsensitiveCompare:state] != NSOrderedSame) continue;
            [mine addObject:warning];
        }
        NSArray *daily = StorePointDays(point, now, 7, ZoneForPlace(place));
        // Same merge as noteWeatherForGeohash: and noteGlanceForGeohash:.
        NSMutableDictionary *pack = weather[hash] ?: [NSMutableDictionary dictionary];
        if (obs) pack[@"obs"] = obs;
        if (daily) pack[@"daily"] = daily;
        if (hourly.count) pack[@"hourly"] = hourly;
        pack[@"warnings"] = mine;
        if (history) pack[@"history"] = history;
        if (series) pack[@"series"] = series;
        [pack removeObjectForKey:@"marine"];
        NSDictionary *pointInfo = point ? [NSJSONSerialization JSONObjectWithData:point options:0 error:nil] : nil;
        if ([pointInfo isKindOfClass:NSDictionary.class]) pack[@"pointSource"] = pointInfo[@"_archive"] ?: @{};
        weather[hash] = pack;
    }
    StoreReloadNote("marine");
    for (NSDictionary *spot in kiteList) {
        NSDictionary *marine = s.publishedStore ? ArchiveMarineProduct(root, spot[@"archiveID"]) : nil;
        NSString *hash = [spot[@"geohash"] isKindOfClass:NSString.class] ? spot[@"geohash"] : nil;
        if (marine && hash && weather[hash]) weather[hash][@"marine"] = marine;
    }
    s.weather = weather;

    // The aerodrome is read as homeAerodrome reads before an aviation product
    // is loaded: its code and position, no runway ends.
    StoreReloadNote("aviation");
    NSDictionary *field = request.aerodrome ?: @{};
    NSString *code = [field[@"code"] isKindOfClass:NSString.class] ? field[@"code"] : @"";
    NSString *aviationCode = [request.aviationCode isKindOfClass:NSString.class] && request.aviationCode.length
        ? request.aviationCode : code;
    s.airportSeries = @[];
    // METAR/TAF follow the Fly aerodrome even on a legacy store. Runway wind
    // series still need the published point layout.
    if (aviationCode.length) s.aviation = ArchiveAviationProduct(root, [NSString stringWithFormat:@"%@.json", aviationCode]);
    if (s.publishedStore) s.airportSeries = StorePointSeries(ArchivePointFile(root, field));
    s.notams = ArchiveAviationProduct(root, @"notams.json");
    s.sigmets = ArchiveAviationProduct(root, @"sigmet.json");
    s.atmosphereLoaded = request.atmosphere;
    // The Fly aerodrome's, like METAR/TAF: the Atmosphere window and the sky section show it.
    if (request.atmosphere && aviationCode.length) s.atmosphere = ArchiveAtmosphereProduct(root, aviationCode);
    StoreReloadNote("end");
    }
    return s;
}
