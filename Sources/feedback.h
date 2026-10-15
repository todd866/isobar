// Isobar — owner feedback capture persistence and recent event log.
#import <Foundation/Foundation.h>

// Adds one event to the process-local bounded log. `details` must contain
// JSON-compatible values; it is copied immediately and may be mutated later.
void FeedbackLog(NSString *category, NSDictionary *details);
// Events are chronological (oldest first), and are immutable snapshots.
NSArray<NSDictionary *> *FeedbackRecent(void);

// The standard per-user inbox: ~/Library/Application Support/Isobar/feedback.
NSURL *FeedbackDefaultInbox(void);

// Builds the shared feedback envelope. Nil values are represented as NSNull
// in the resulting JSON-compatible dictionary. `recent` may be nil.
NSDictionary *FeedbackRecord(NSDictionary *state, NSDictionary *app,
                              NSDate *capturedAt, NSTimeZone *timezone,
                              NSArray<NSDictionary *> *recent, NSString *note,
                              NSArray<NSString *> *files, NSString *surface);

// Writes one complaint atomically as a directory containing feedback.json and
// optional image data. `images` maps the filename (for example screen.png) to
// NSData. The returned URL is the final directory on success.
NSURL *FeedbackWrite(NSURL *inbox, NSDictionary *record,
                     NSDictionary<NSString *, NSData *> *images,
                     NSError **error);
