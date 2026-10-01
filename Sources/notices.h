#import <Cocoa/Cocoa.h>

// All records retain their original source. Unknown validity is never treated as clear.
NSArray<NSDictionary *> *AviationNoticeRows(NSDictionary *product, BOOL sigmet,
    NSString *airport, NSDate *start, BOOL allDates, NSString *category);
NSString *AviationNoticeDetail(NSDictionary *row, NSTimeZone *zone);

@interface AviationNoticesView : NSView <NSTableViewDataSource, NSTableViewDelegate>
@property(nonatomic, copy) NSDictionary *notams;
@property(nonatomic, copy) NSDictionary *sigmets;
@property(nonatomic, copy) NSString *airport;
@property(nonatomic, strong) NSDate *now;
@property(nonatomic, strong) NSTimeZone *timeZone;
@property(nonatomic) BOOL showingSIGMET;
@property(nonatomic, copy) void (^onImport)(void);
@property(nonatomic, copy) void (^onNotac)(void);
@property(nonatomic) BOOL notacKeySaved;
@property(nonatomic) BOOL notacUpdating;
@property(nonatomic, copy) void (^onClose)(void);
@property(nonatomic, copy, readonly) NSArray<NSDictionary *> *rows;
- (void)reload;
- (void)selectNoticeAtIndex:(NSInteger)index;
- (void)setImportStatus:(NSString *)status;
@end
