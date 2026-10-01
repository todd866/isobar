#import <Cocoa/Cocoa.h>
#import "notices.h"

static int failures;
static void ck(BOOL value, NSString *message) {
    fprintf(stderr, "%s %s\n", value ? "ok  " : "FAIL", message.UTF8String);
    if (!value) failures++;
}
static NSDate *utc(NSString *text) {
    NSDateFormatter *f=[NSDateFormatter new]; f.locale=[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    f.timeZone=[NSTimeZone timeZoneForSecondsFromGMT:0]; f.dateFormat=@"yyyy-MM-dd HH:mm";
    return [f dateFromString:text];
}
static NSDictionary *notice(NSString *ident, NSString *kind, id from, id to, NSString *category, NSString *raw) {
    NSMutableDictionary *d=[@{ @"id":ident, @"kind":kind, @"locations":@[ @"YPPH" ], @"category":category,
        @"title":ident, @"raw":raw, @"effective_from":from ?: [NSNull null], @"effective_to":to ?: [NSNull null],
        @"permanent":@NO, @"estimated":@NO, @"schedule":@"", @"body":raw, @"lower":@"", @"upper":@"" } mutableCopy];
    return d;
}
static NSView *findView(NSView *root, NSString *identifier) {
    if ([root.accessibilityIdentifier isEqual:identifier]) return root;
    for (NSView *child in root.subviews) { NSView *found=findView(child,identifier); if (found) return found; }
    return nil;
}
static BOOL within(NSRect frame, NSRect bounds) {
    return NSMinX(frame)>=-0.5 && NSMinY(frame)>=-0.5 && NSMaxX(frame)<=NSMaxX(bounds)+0.5 && NSMaxY(frame)<=NSMaxY(bounds)+0.5;
}
static NSInteger indexForId(NSArray *rows, NSString *ident) {
    for (NSUInteger i=0;i<rows.count;i++) if ([rows[i][@"id"] isEqual:ident]) return (NSInteger)i;
    return NSNotFound;
}
static void screenshot(AviationNoticesView *view, NSString *name) {
    NSString *dir=[[[NSProcessInfo processInfo] environment][@"ISOBAR_NOTICE_QA"] length] ? [[[NSProcessInfo processInfo] environment][@"ISOBAR_NOTICE_QA"] stringByExpandingTildeInPath] : @"/private/tmp/isobar-notice-qa";
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    NSInteger w=MAX(1,(NSInteger)NSWidth(view.bounds)), h=MAX(1,(NSInteger)NSHeight(view.bounds));
    NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:w pixelsHigh:h bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bitmapFormat:0 bytesPerRow:0 bitsPerPixel:0];
    NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    [NSGraphicsContext saveGraphicsState]; [NSGraphicsContext setCurrentContext:context]; [view displayRectIgnoringOpacity:view.bounds inContext:context]; [NSGraphicsContext restoreGraphicsState];
    NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES];
}

int main(void) { @autoreleasepool {
    NSApplication *app=[NSApplication sharedApplication]; [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSWindow *window=nil, *small=nil;
    @try {
    NSTimeZone *zone=[NSTimeZone timeZoneForSecondsFromGMT:8*3600]; NSDate *now=utc(@"2026-09-27 00:00");
    NSString *longRaw=[NSString stringWithFormat:@"A1000/26 NOTAMN E) RWY CLOSED %@", [@"QUALIFIER " stringByPaddingToLength:2600 withString:@"x" startingAtIndex:0]];
    NSArray *records=@[
        notice(@"A1000/26",@"NOTAMN",now,[now dateByAddingTimeInterval:3600],@"runway",longRaw),
        notice(@"A1001/26",@"NOTAMN",[now dateByAddingTimeInterval:-3600],now,@"approach",@"A1001/26 E) expired"),
        notice(@"A1002/26",@"NOTAMN",[now dateByAddingTimeInterval:7200],nil,@"lighting",@"A1002/26 E) unknown end"),
        notice(@"A1003/26",@"NOTAMC",now,[now dateByAddingTimeInterval:7200],@"runway",@"A1003/26 E) cancelled"),
        notice(@"A1004/26",@"NOTAMN",now,[now dateByAddingTimeInterval:7200],@"navaid",@"A1004/26 E) superseded"),
        notice(@"A1005/26",@"NOTAMN",[now dateByAddingTimeInterval:-7200],now,@"runway",@"A1005/26 E) estimated expiry"),
        notice(@"A1006/26",@"NOTAMN",[now dateByAddingTimeInterval:86400],[now dateByAddingTimeInterval:90000],@"other",@"A1006/26 E) exactly next day"),
        notice(@"A1007/26",@"NOTAMN",[now dateByAddingTimeInterval:10800],[now dateByAddingTimeInterval:14400],@"services",@"A1007/26 E) nullable flags")
    ];
    ((NSMutableDictionary *)records[4])[@"superseded"]=@YES;
    ((NSMutableDictionary *)records[0])[@"title"]=@"Runway 03/21 closed except emergency landings";
    ((NSMutableDictionary *)records[5])[@"estimated"]=@YES;
    ((NSMutableDictionary *)records[7])[@"locations"]=@[ @"ypph" ];
    ((NSMutableDictionary *)records[7])[@"estimated"]=[NSNull null];
    ((NSMutableDictionary *)records[7])[@"permanent"]=[NSNull null];
    ((NSMutableDictionary *)records[7])[@"cancelled"]=[NSNull null];
    NSDictionary *notams=@{ @"source":@"synthetic", @"retrieved_at":now, @"imported":@YES, @"notices":records };
    NSArray *rows=AviationNoticeRows(notams,NO,@"YPPH",now,NO, @"");
    ck(rows.count==4, @"next-24h hides expired, cancelled, superseded and exact-next-day notices");
    ck([rows filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *row, NSDictionary *_) { return [row[@"id"] isEqual:@"A1000/26"]; }]].count==1, @"start boundary is included");
    ck([rows filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *row, NSDictionary *_) { return [row[@"id"] isEqual:@"A1002/26"]; }]].count==1, @"unknown end is retained");
    ck(AviationNoticeRows(notams,NO,@"ypph",now,NO,@"").count==4, @"lowercase airport matches normalized locations");
    ck(AviationNoticeRows(notams,NO,@"YPPH",now,NO,@"lighting").count==1, @"category filter is exact");
    NSArray *all=AviationNoticeRows(notams,NO,@"YPPH",now,YES,@"");
    ck(all.count==8, @"All dates reveals cancelled and superseded notices");
    NSDictionary *longNotice=rows[indexForId(rows,@"A1000/26")];
    NSString *detail=AviationNoticeDetail(longNotice,zone);
    ck([detail containsString:longRaw] && [detail containsString:@"synthetic"], @"raw detail retains complete source and provenance");

    NSDictionary *sigmets=@{ @"features":@[ @{ @"firId":@"YMMM", @"hazard":@"TS", @"qualifier":@"SEV", @"valid_from":now, @"valid_to":[now dateByAddingTimeInterval:3600], @"raw":@"SIGMET YMMM TS SEV" } ] };
    NSArray *sigRows=AviationNoticeRows(sigmets,YES,@"YPPH",now,NO,@"");
    ck(sigRows.count==1 && [sigRows[0][@"category"] isEqual:@"weather"] && [sigRows[0][@"title"] containsString:@"Thunderstorms"], @"SIGMET hazard decoding");

    window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,840,540) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
    window.releasedWhenClosed=NO;
    AviationNoticesView *view=[[AviationNoticesView alloc] initWithFrame:NSMakeRect(0,0,840,540)]; view.notams=notams; view.sigmets=sigmets; view.airport=@"YPPH"; view.now=now; view.timeZone=zone; [window setContentView:view]; [view reload]; [view layoutSubtreeIfNeeded];
    for (NSView *child in view.subviews) ck(within(child.frame,view.bounds), [NSString stringWithFormat:@"control %@ stays inside 840x540",child.accessibilityIdentifier ?: @"unnamed"]);
    ck(findView(view,@"notices.list")!=nil && findView(view,@"notices.raw")!=nil, @"accessibility identifiers expose list and raw detail");
    [view selectNoticeAtIndex:indexForId(view.rows,@"A1000/26")]; [view layoutSubtreeIfNeeded]; NSTextView *raw=(NSTextView *)findView(view,@"notices.raw"); ck(raw.string.length>2000 && [raw.string containsString:@"QUALIFIER"], @"selection reveals long raw document");
    [raw.layoutManager ensureLayoutForTextContainer:raw.textContainer]; NSScrollView *rawScroll=raw.enclosingScrollView; CGFloat documentHeight=NSMaxY([raw.layoutManager usedRectForTextContainer:raw.textContainer]);
    ck(documentHeight>NSHeight(rawScroll.contentView.bounds), @"long raw document exceeds detail clip height");
    NSRect before=rawScroll.contentView.bounds; [raw scrollRangeToVisible:NSMakeRange(raw.string.length-1,1)]; NSRect after=rawScroll.contentView.bounds;
    ck(NSMinY(after)>NSMinY(before), @"scrolling to raw end changes visible rect");
    screenshot(view,@"notices-840x540.png");
    [view setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]]; screenshot(view,@"notices-840x540-dark.png");
    NSPopUpButton *category=(NSPopUpButton *)findView(view,@"notices.category"); [category selectItemWithTitle:@"Lighting"]; [category sendAction:category.action to:category.target];
    ck(view.rows.count==1, @"category control updates visible rows");
    [category selectItemWithTitle:@"All changes"]; [category sendAction:category.action to:category.target];
    NSPopUpButton *dates=(NSPopUpButton *)findView(view,@"notices.dates"); [dates selectItemAtIndex:1]; [dates sendAction:dates.action to:dates.target];
    ck(view.rows.count==8, @"date mode control updates visible rows");

    small=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,620,360) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
    small.releasedWhenClosed=NO;
    AviationNoticesView *compact=[[AviationNoticesView alloc] initWithFrame:NSMakeRect(0,0,620,360)]; compact.notams=notams; compact.sigmets=sigmets; compact.airport=@"YPPH"; compact.now=now; compact.timeZone=zone; [small setContentView:compact]; [compact reload]; [compact layoutSubtreeIfNeeded];
    for (NSView *child in compact.subviews) ck(within(child.frame,compact.bounds), [NSString stringWithFormat:@"control %@ stays inside 620x360",child.accessibilityIdentifier ?: @"unnamed"]);
    __block BOOL requestedNotac=NO; compact.onNotac=^{ requestedNotac=YES; };
    NSButton *notacButton=(NSButton *)findView(compact,@"notices.notac");
    ck(notacButton && !notacButton.hidden,@"NOTAC connection is available beside imported briefings");
    [notacButton performClick:nil]; ck(requestedNotac,@"NOTAC control opens its connection flow");
    compact.showingSIGMET=YES; [compact reload]; ck(notacButton.hidden,@"NOTAC control is hidden on SIGMETs");
    compact.showingSIGMET=NO; [compact reload];
    [compact selectNoticeAtIndex:indexForId(compact.rows,@"A1000/26")]; [compact layoutSubtreeIfNeeded]; NSTextView *compactRaw=(NSTextView *)findView(compact,@"notices.raw");
    ck(compactRaw.string.length>2000, @"small layout keeps long raw detail selectable");
    screenshot(compact,@"notices-620x360.png"); [compact setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]]; screenshot(compact,@"notices-620x360-dark.png");

    NSMutableDictionary *fir=[notice(@"B2000/26",@"NOTAMN",now,[now dateByAddingTimeInterval:3600],@"airspace",@"B2000/26 NOTAMN A) YMMM E) REGIONAL NOTICE") mutableCopy]; fir[@"locations"]=@[@"YMMM"];
    NSDictionary *coverage=@{@"locations":@[@"YPPH",@"YPJT",@"YMMM"],@"valid_from":now,@"valid_to":[now dateByAddingTimeInterval:72*3600]};
    NSDictionary *notac=@{@"source":@"NOTAC · unofficial",@"provider":@"NOTAC",@"retrieved_at":now,@"coverage":coverage,@"notices":@[records[0],fir]};
    ck(AviationNoticeRows(notac,NO,@"YPPH",now,NO,@"").count==1,@"FIR notices are not presented as airport-specific NOTAMs");
    ck(AviationNoticeRows(notac,NO,@"YSSY",now,NO,@"").count==0,@"FIR notice does not imply another airport was downloaded");
    ck(AviationNoticeRows(notac,NO,@"YMMM",now,NO,@"").count==1,@"FIR notices can be selected explicitly");
    ck(AviationNoticeRows(notac,NO,@"",now,NO,@"").count==2,@"All locations retains airport and regional notices");
    compact.notams=notac; [compact reload];
    NSPopUpButton *locations=(NSPopUpButton *)findView(compact,@"notices.location");
    ck([locations itemWithTitle:@"YPJT"]!=nil,@"downloaded location with zero notices remains selectable");
    [locations selectItemWithTitle:@"YPJT"]; [locations sendAction:locations.action to:locations.target];
    NSTextField *empty=(NSTextField *)findView(compact,@"notices.empty");
    ck([empty.stringValue isEqual:@"No results from NOTAC"],@"valid empty query is attributed to provider rather than a claim of no notices");
    compact.airport=@"YSSY"; [compact reload];
    ck([empty.stringValue isEqual:@"Location not downloaded"],@"unqueried airport is not reported clear");
    compact.airport=@"YPPH"; [compact reload];
    NSDatePicker *time=(NSDatePicker *)findView(compact,@"notices.time");
    time.dateValue=[now dateByAddingTimeInterval:96*3600]; [time sendAction:time.action to:time.target];
    ck([empty.stringValue isEqual:@"Time not downloaded"],@"outside downloaded window is not reported empty");
    time.dateValue=[now dateByAddingTimeInterval:60*3600]; [time sendAction:time.action to:time.target];
    NSTextField *status=(NSTextField *)findView(compact,@"notices.status");
    ck([status.stringValue containsString:@"Partial time coverage"],@"partly downloaded day is identified");
    time.dateValue=now; [time sendAction:time.action to:time.target];
    ck([status.stringValue containsString:@"NOTAC · unofficial"] && [status.toolTip containsString:@"YPJT"],@"NOTAC attribution and exact coverage remain available");
    NSPopUpButton *compactDates=(NSPopUpButton *)findView(compact,@"notices.dates");
    ck([[compactDates itemAtIndex:1].title isEqual:@"Downloaded"],@"bounded snapshot does not claim all dates");
    [compact selectNoticeAtIndex:0]; [compact layoutSubtreeIfNeeded];
    screenshot(compact,@"notac-620x360-dark.png");
    [compact setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameAqua]]; screenshot(compact,@"notac-620x360.png");

    NSMutableDictionary *scheduled=[notice(@"S1000/26",@"NOTAMN",now,[now dateByAddingTimeInterval:3600],@"services",@"S1000/26 E) daily closure") mutableCopy];
    scheduled[@"schedule"]=@"2200/0600";
    NSDictionary *barNotams=@{@"source":@"synthetic",@"retrieved_at":now,@"imported":@YES,@"notices":@[records[0],scheduled]};
    AviationNoticesView *bars=[[AviationNoticesView alloc] initWithFrame:NSMakeRect(0,0,840,540)];
    bars.notams=barNotams; bars.airport=@"YPPH"; bars.now=now; bars.timeZone=zone;
    NSWindow *barWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,840,540) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
    barWindow.releasedWhenClosed=NO; [barWindow setContentView:bars]; [bars reload]; [bars layoutSubtreeIfNeeded];
    NSTableView *table=(NSTableView *)findView(bars,@"notices.list");
    NSInteger solidRow=indexForId(bars.rows,@"A1000/26"), hatchRow=indexForId(bars.rows,@"S1000/26");
    NSView *solid=[table viewAtColumn:0 row:solidRow makeIfNecessary:YES];
    NSView *hatched=[table viewAtColumn:0 row:hatchRow makeIfNecessary:YES];
    solid.frame=NSMakeRect(0,0,800,62); hatched.frame=NSMakeRect(0,0,800,62);
    NSUInteger (^ink)(NSView *)=^NSUInteger(NSView *cell) {
        NSInteger w=MAX(1,(NSInteger)NSWidth(cell.bounds)), h=MAX(1,(NSInteger)NSHeight(cell.bounds));
        NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:w pixelsHigh:h bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        [NSGraphicsContext saveGraphicsState]; [NSGraphicsContext setCurrentContext:context];
        [cell displayRectIgnoringOpacity:cell.bounds inContext:context]; [NSGraphicsContext restoreGraphicsState];
        NSUInteger count=0;
        for (NSInteger y=0;y<h;y++) for (NSInteger x=0;x<w;x++) {
            NSColor *c=[bitmap colorAtX:x y:y];
            if (c.blueComponent>c.redComponent+0.12 && c.blueComponent>0.25) count++;
        }
        return count;
    };
    NSUInteger solidInk=ink(solid), hatchInk=ink(hatched);
    ck(hatchInk>0 && solidInk>hatchInk, @"a scheduled NOTAM draws a hatched validity bar");
    [barWindow close];

    AviationNoticesView *anchor=[[AviationNoticesView alloc] initWithFrame:NSMakeRect(0,0,840,540)];
    anchor.notams=notams; anchor.airport=@"YPPH"; anchor.now=now; anchor.timeZone=zone; [anchor reload];
    NSDatePicker *anchorTime=(NSDatePicker *)findView(anchor,@"notices.time");
    ck(fabs([anchorTime.dateValue timeIntervalSinceDate:now])<1, @"Next 24h starts at the current time");
    NSDate *later=[now dateByAddingTimeInterval:2*86400];
    anchor.now=later; [anchor reload];
    ck(fabs([anchorTime.dateValue timeIntervalSinceDate:later])<1, @"showing notices again re-anchors an untouched picker");
    anchorTime.dateValue=now; [anchorTime sendAction:anchorTime.action to:anchorTime.target];
    anchor.now=[now dateByAddingTimeInterval:5*86400]; [anchor reload];
    ck(fabs([anchorTime.dateValue timeIntervalSinceDate:now])<1, @"a picker the user changed stays put");

    [view setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
    NSTextView *darkRaw=(NSTextView *)findView(view,@"notices.raw");
    __block CGFloat backgroundRed=1;
    [darkRaw.effectiveAppearance performAsCurrentDrawingAppearance:^{
        NSColor *bg=[darkRaw.backgroundColor colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
        backgroundRed=bg?bg.redComponent:1;
    }];
    ck(backgroundRed<0.5, @"raw notice text uses the dark text background");
    } @finally {
        [window close]; [small close];
    }
}
return failures ? 1 : 0;
}
