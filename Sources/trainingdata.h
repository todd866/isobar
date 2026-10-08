#import <Foundation/Foundation.h>

@class NSDate;

// Live-data snapshot for Training mode. Missing products stay null.
// coastPath is the own-chart coastline; nil skips the chart render and the
// grid load fails closed. A published ECMWF pointer that will not load does
// not fall back to an older legacy run.
// now nil uses ISOBAR_CHECK_NOW when that is a valid ISO-8601 instant, then
// the current time. The popover passes its chart clock so the two match.
NSDictionary *TrainingSnapshot(NSString *storeRoot, NSDate *now, NSString *coastPath);
NSData *TrainingSnapshotJSON(NSString *storeRoot, NSDate *now, NSString *coastPath);

// ~/Library/Application Support/Isobar/training.json
// WKWebView localStorage is not used. Tests pass an explicit path.
NSString *TrainingProgressPath(void);
// Writes a JSON object, atomically, at most 1 MB. Rejects anything else.
BOOL TrainingProgressWrite(NSString *path, NSData *json, NSString **error);
NSData *TrainingProgressRead(NSString *path);
