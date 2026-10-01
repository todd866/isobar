#import "notices.h"

static NSString *String(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
static BOOL Flag(id value) { return [value isKindOfClass:NSNumber.class] && [value boolValue]; }
static NSDate *Stamp(id value) {
    if ([value isKindOfClass:NSDate.class]) return value;
    if ([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue])) return [NSDate dateWithTimeIntervalSince1970:[value doubleValue]];
    if (!String(value).length) return nil;
    NSISO8601DateFormatter *f=[NSISO8601DateFormatter new];
    NSDate *date=[f dateFromString:value];
    if (!date) { f.formatOptions=NSISO8601DateFormatWithInternetDateTime|NSISO8601DateFormatWithFractionalSeconds; date=[f dateFromString:value]; }
    return date;
}
static NSString *DateText(id value, NSTimeZone *zone) {
    NSDate *date=Stamp(value); if (!date) return @"Time unknown";
    NSDateFormatter *f=[NSDateFormatter new]; f.locale=[NSLocale localeWithLocaleIdentifier:@"en_AU_POSIX"];
    f.timeZone=zone; f.dateFormat=@"d MMM HH:mm"; return [f stringFromDate:date];
}
static NSArray *Categories(void) { return @[@"runway",@"approach",@"navaid",@"lighting",@"airspace",@"obstacle",@"services",@"other"]; }
static NSString *CategoryName(NSString *key) {
    return @{@"runway":@"Runway",@"approach":@"Approach",@"navaid":@"Navigation",@"lighting":@"Lighting",
        @"airspace":@"Airspace",@"obstacle":@"Obstacles",@"services":@"Services",@"other":@"Other",@"weather":@"Weather"}[key] ?: @"Other";
}
static NSArray *Locations(NSDictionary *row) {
    id items=row[@"locations"];
    if (![items isKindOfClass:NSArray.class]) return @[];
    NSMutableArray *out=[NSMutableArray array];
    for (id item in items) if (String(item).length) [out addObject:[item uppercaseString]];
    return out;
}

static NSDictionary *Coverage(NSDictionary *product) {
    return [product[@"coverage"] isKindOfClass:NSDictionary.class] ? product[@"coverage"] : @{};
}
static NSString *CoverageStatus(NSDictionary *product, NSString *location, NSDate *start, BOOL allDates) {
    NSDictionary *coverage=Coverage(product);
    NSArray *locations=Locations(coverage);
    if (locations.count && location.length && ![locations containsObject:location.uppercaseString]) return @"Location not downloaded";
    NSDate *from=Stamp(coverage[@"valid_from"]), *to=Stamp(coverage[@"valid_to"]);
    if (!from || !to || allDates) return @"";
    NSDate *end=[start dateByAddingTimeInterval:24*3600];
    if ([to compare:start]!=NSOrderedDescending || [from compare:end]!=NSOrderedAscending) return @"Time not downloaded";
    if ([from compare:start]==NSOrderedDescending || [to compare:end]==NSOrderedAscending) return @"Partial time coverage";
    return @"";
}

NSArray<NSDictionary *> *AviationNoticeRows(NSDictionary *product, BOOL sigmet, NSString *airport, NSDate *start, BOOL allDates, NSString *category) {
    start=start ?: NSDate.date;
    airport=airport.uppercaseString;
    id records=product[sigmet?@"features":@"notices"];
    if (![records isKindOfClass:NSArray.class]) return @[];
    NSDate *end=[start dateByAddingTimeInterval:24*3600];
    NSMutableArray *result=[NSMutableArray array];
    for (id record in records) {
        if (![record isKindOfClass:NSDictionary.class]) continue;
        NSMutableDictionary *row=[record mutableCopy];
        if (sigmet) {
            row[@"effective_from"]=row[@"valid_from"] ?: NSNull.null;
            row[@"effective_to"]=row[@"valid_to"] ?: NSNull.null;
            row[@"locations"]=String(row[@"firId"]).length ? @[row[@"firId"]] : @[];
            row[@"category"]=@"weather";
            NSString *hazard=@{@"TURB":@"Turbulence",@"ICE":@"Icing",@"TS":@"Thunderstorms",@"VA":@"Volcanic ash",@"TC":@"Tropical cyclone"}[String(row[@"hazard"])] ?: String(row[@"hazard"]);
            NSString *qualifier=@{@"SEV":@"Severe",@"EMBD":@"Embedded",@"OBSC":@"Obscured",@"FRQ":@"Frequent"}[String(row[@"qualifier"])] ?: String(row[@"qualifier"]);
            row[@"title"]=[NSString stringWithFormat:@"%@%@%@",qualifier,qualifier.length?@" ":@"",hazard.length?hazard:@"SIGMET"];
            row[@"id"]=String(row[@"firId"]);
            if ([row[@"base"] isKindOfClass:NSNumber.class] && [row[@"top"] isKindOfClass:NSNumber.class]) {
                row[@"title"]=[row[@"title"] stringByAppendingFormat:@" · %@–%@ ft",row[@"base"],row[@"top"]];
            }
        }
        if (!String(row[@"raw"]).length) continue;
        NSArray *locations=Locations(row);
        // FIR-wide NOTAMs have their own location or appear under All locations.
        // A regional notice must not masquerade as an airport-specific result.
        if (!sigmet && airport.length && locations.count && ![locations containsObject:airport]) continue;
        NSString *group=String(row[@"category"]);
        if (!group.length) group=@"other";
        if (category.length && ![category isEqual:group]) continue;
        NSDate *from=Stamp(row[@"effective_from"]), *to=Stamp(row[@"effective_to"]);
        if (!allDates && ((to && !Flag(row[@"estimated"]) && [to compare:start]!=NSOrderedDescending) || (from && [from compare:end]!=NSOrderedAscending))) continue;
        if (!allDates && ([String(row[@"kind"]) hasSuffix:@"C"] || Flag(row[@"superseded"]) || Flag(row[@"cancelled"]))) continue;
        row[@"locations"]=locations; row[@"category"]=group;
        row[@"source"]=String(product[@"source"]);
        if (!String(row[@"title"]).length) row[@"title"]=String(row[@"body"]).length?row[@"body"]:row[@"raw"];
        [result addObject:row];
    }
    [result sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        NSUInteger aa=[Categories() indexOfObject:a[@"category"]], bb=[Categories() indexOfObject:b[@"category"]];
        if (aa!=bb) return aa<bb?NSOrderedAscending:NSOrderedDescending;
        NSDate *at=Stamp(a[@"effective_from"]), *bt=Stamp(b[@"effective_from"]);
        if (at && bt && ![at isEqual:bt]) return [at compare:bt];
        return [String(a[@"id"]) compare:String(b[@"id"])];
    }];
    return result;
}

static NSString *TimeSpan(NSDictionary *row, NSTimeZone *zone) {
    NSString *finish=Flag(row[@"permanent"])?@"Permanent":DateText(row[@"effective_to"],zone);
    NSMutableString *text=[NSMutableString stringWithFormat:@"%@ – %@%@",DateText(row[@"effective_from"],zone),finish,Flag(row[@"estimated"])?@" (estimated)":@""];
    if (String(row[@"schedule"]).length) [text appendString:@" · Scheduled"];
    if (Flag(row[@"superseded"])) [text appendString:@" · Replaced"];
    if (Flag(row[@"cancelled"]) || [String(row[@"kind"]) hasSuffix:@"C"]) [text appendString:@" · Cancelled"];
    return text;
}
NSString *AviationNoticeDetail(NSDictionary *row, NSTimeZone *zone) {
    return [NSString stringWithFormat:@"%@ · %@\n%@ (%@)\n%@%@%@\n\n%@",String(row[@"id"]),[Locations(row) componentsJoinedByString:@", "],
        TimeSpan(row,zone),zone.abbreviation ?: @"local",String(row[@"source"]),String(row[@"schedule"]).length?@"\nSchedule (UTC): ":@"",String(row[@"schedule"]),String(row[@"raw"])];
}

@interface NoticeCell : NSTableCellView
@property NSDictionary *notice;
@property NSTimeZone *zone;
@property NSDate *start;
@end
@implementation NoticeCell
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect r=NSInsetRect(self.bounds,10,0);
    NSDictionary *title=@{NSFontAttributeName:[NSFont systemFontOfSize:13 weight:NSFontWeightMedium],NSForegroundColorAttributeName:NSColor.labelColor};
    NSMutableParagraphStyle *style=[NSMutableParagraphStyle new]; style.lineBreakMode=NSLineBreakByTruncatingTail;
    NSMutableDictionary *attrs=[title mutableCopy]; attrs[NSParagraphStyleAttributeName]=style;
    [String(self.notice[@"title"]) drawInRect:NSMakeRect(r.origin.x,7,r.size.width,20) withAttributes:attrs];
    attrs[NSFontAttributeName]=[NSFont systemFontOfSize:11]; attrs[NSForegroundColorAttributeName]=NSColor.secondaryLabelColor;
    NSString *meta=[NSString stringWithFormat:@"%@ · %@ · %@",CategoryName(self.notice[@"category"]),[Locations(self.notice) componentsJoinedByString:@", "],TimeSpan(self.notice,self.zone)];
    [meta drawInRect:NSMakeRect(r.origin.x,29,r.size.width,17) withAttributes:attrs];
    NSDate *from=Stamp(self.notice[@"effective_from"]), *to=Stamp(self.notice[@"effective_to"]);
    BOOL scheduled=String(self.notice[@"schedule"]).length>0;
    CGFloat y=53;
    [[NSColor.separatorColor colorWithAlphaComponent:.4] setFill]; NSRectFillUsingOperation(NSMakeRect(r.origin.x,y,r.size.width,2),NSCompositingOperationSourceOver);
    if (from && !Flag(self.notice[@"estimated"]) && (to || Flag(self.notice[@"permanent"]))) {
        CGFloat x0=MAX(0,MIN(1,[from timeIntervalSinceDate:self.start]/86400));
        CGFloat x1=to?MAX(0,MIN(1,[to timeIntervalSinceDate:self.start]/86400)):1;
        if (x1>x0) {
            [[NSColor.systemBlueColor colorWithAlphaComponent:.55] setFill];
            CGFloat begin=r.origin.x+x0*r.size.width, finish=r.origin.x+x1*r.size.width;
            if (scheduled) {
                for (CGFloat x=begin;x<finish;x+=7) NSRectFillUsingOperation(NSMakeRect(x,y,MIN(4,finish-x),2),NSCompositingOperationSourceOver);
            } else NSRectFillUsingOperation(NSMakeRect(begin,y,finish-begin,2),NSCompositingOperationSourceOver);
        }
    }
}
@end

@implementation AviationNoticesView {
    NSSegmentedControl *_kind;
    NSPopUpButton *_location, *_category, *_dates;
    NSDatePicker *_date;
    NSButton *_import, *_notac, *_close;
    NSTextField *_status, *_empty;
    NSScrollView *_list, *_detail;
    NSTableView *_table;
    NSTextView *_raw;
    NSArray *_rows;
    NSString *_importStatus;
    BOOL _datePinned;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return YES; }
- (void)drawRect:(NSRect)dirty { (void)dirty; [NSColor.windowBackgroundColor setFill]; NSRectFill(self.bounds); }
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self=[super initWithFrame:frame])) {
        _notams=@{}; _sigmets=@{}; _airport=@"YPPH"; _now=NSDate.date; _timeZone=NSTimeZone.localTimeZone;
        _kind=[NSSegmentedControl segmentedControlWithLabels:@[@"NOTAMs",@"SIGMETs"] trackingMode:NSSegmentSwitchTrackingSelectOne target:self action:@selector(changeKind:)];
        _kind.selectedSegment=0; _kind.accessibilityIdentifier=@"notices.kind"; [self addSubview:_kind];
        _location=[[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO]; _location.target=self; _location.action=@selector(filter:); _location.accessibilityIdentifier=@"notices.location"; [self addSubview:_location];
        _category=[[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO]; [_category addItemWithTitle:@"All changes"]; _category.lastItem.representedObject=@"";
        for (NSString *key in Categories()) { [_category addItemWithTitle:CategoryName(key)]; _category.lastItem.representedObject=key; }
        _category.target=self; _category.action=@selector(filter:); _category.accessibilityIdentifier=@"notices.category"; [self addSubview:_category];
        _date=[[NSDatePicker alloc] initWithFrame:NSZeroRect]; _date.datePickerStyle=NSDatePickerStyleTextFieldAndStepper;
        _date.datePickerElements=NSDatePickerElementFlagYearMonthDay|NSDatePickerElementFlagHourMinute;
        _date.target=self; _date.action=@selector(filter:); _date.accessibilityIdentifier=@"notices.time"; [self addSubview:_date];
        _dates=[[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO]; [_dates addItemsWithTitles:@[@"Next 24h",@"All dates"]]; _dates.target=self; _dates.action=@selector(filter:); _dates.accessibilityIdentifier=@"notices.dates"; [self addSubview:_dates];
        _import=[NSButton buttonWithTitle:@"Import…" target:self action:@selector(import:)]; _import.bezelStyle=NSBezelStyleRounded; _import.accessibilityIdentifier=@"notices.import"; [self addSubview:_import];
        _notac=[NSButton buttonWithTitle:@"NOTAC" target:self action:@selector(notac:)]; _notac.bezelStyle=NSBezelStyleRounded; _notac.accessibilityIdentifier=@"notices.notac"; [self addSubview:_notac];
        _close=[NSButton buttonWithTitle:@"Close" target:self action:@selector(close:)]; _close.bezelStyle=NSBezelStyleRounded; _close.keyEquivalent=@"\e"; _close.accessibilityIdentifier=@"notices.close"; [self addSubview:_close];
        _status=[NSTextField labelWithString:@""]; _status.font=[NSFont systemFontOfSize:11]; _status.textColor=NSColor.secondaryLabelColor; _status.lineBreakMode=NSLineBreakByTruncatingMiddle; _status.accessibilityIdentifier=@"notices.status"; [self addSubview:_status];
        _empty=[NSTextField labelWithString:@""]; _empty.font=[NSFont systemFontOfSize:13]; _empty.textColor=NSColor.secondaryLabelColor; _empty.alignment=NSTextAlignmentCenter; _empty.accessibilityIdentifier=@"notices.empty"; [self addSubview:_empty];
        _table=[[NSTableView alloc] initWithFrame:NSZeroRect]; NSTableColumn *column=[[NSTableColumn alloc] initWithIdentifier:@"notice"]; [_table addTableColumn:column]; _table.headerView=nil; _table.rowHeight=62; _table.dataSource=self; _table.delegate=self; _table.allowsEmptySelection=YES; _table.accessibilityIdentifier=@"notices.list";
        _list=[[NSScrollView alloc] initWithFrame:NSZeroRect]; _list.documentView=_table; _list.hasVerticalScroller=YES; _list.borderType=NSNoBorder; [self addSubview:_list];
        _raw=[[NSTextView alloc] initWithFrame:NSZeroRect]; _raw.editable=NO; _raw.verticallyResizable=YES; _raw.horizontallyResizable=NO; _raw.maxSize=NSMakeSize(CGFLOAT_MAX,CGFLOAT_MAX); _raw.font=[NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular]; _raw.textContainerInset=NSMakeSize(10,10); _raw.autoresizingMask=NSViewWidthSizable; _raw.textContainer.widthTracksTextView=YES; _raw.accessibilityIdentifier=@"notices.raw";
        _raw.drawsBackground=YES; _raw.backgroundColor=NSColor.textBackgroundColor; _raw.textColor=NSColor.labelColor;
        _detail=[[NSScrollView alloc] initWithFrame:NSZeroRect]; _detail.documentView=_raw; _detail.hasVerticalScroller=YES; _detail.borderType=NSBezelBorder; [self addSubview:_detail];
    }
    return self;
}
- (NSArray *)rows { return _rows ?: @[]; }
- (void)setAirport:(NSString *)value {
    NSString *next=value.uppercaseString ?: @"";
    if ([_airport isEqual:next]) return;
    _airport=[next copy];
    [_location removeAllItems];
}
- (void)setShowingSIGMET:(BOOL)value { _showingSIGMET=value; _kind.selectedSegment=value?1:0; }
- (void)reload {
    NSString *selected=_location.selectedItem.representedObject ?: self.airport.uppercaseString ?: @"";
    NSMutableOrderedSet *codes=[NSMutableOrderedSet orderedSet]; if (self.airport.length) [codes addObject:self.airport.uppercaseString];
    [codes addObjectsFromArray:Locations(Coverage(self.notams))];
    for (NSDictionary *r in [self.notams[@"notices"] isKindOfClass:NSArray.class]?self.notams[@"notices"]:@[]) if ([r isKindOfClass:NSDictionary.class]) [codes addObjectsFromArray:Locations(r)];
    [_location removeAllItems]; [_location addItemWithTitle:@"All locations"]; _location.lastItem.representedObject=@"";
    for (NSString *code in codes) { [_location addItemWithTitle:code]; _location.lastItem.representedObject=code; }
    for (NSMenuItem *item in _location.itemArray) if ([item.representedObject isEqual:selected]) [_location selectItem:item];
    NSString *selectedRaw=_table.selectedRow>=0 && _table.selectedRow<(NSInteger)self.rows.count?String(self.rows[_table.selectedRow][@"raw"]):@"";
    _date.timeZone=self.timeZone;
    if (!_datePinned) _date.dateValue=self.now ?: NSDate.date;
    [self filter:nil];
    if (selectedRaw.length) for (NSUInteger i=0;i<self.rows.count;i++) if ([self.rows[i][@"raw"] isEqual:selectedRaw]) { [self selectNoticeAtIndex:i]; break; }
}
- (void)changeKind:(id)sender { (void)sender; self.showingSIGMET=_kind.selectedSegment==1; [self filter:nil]; }
- (void)filter:(id)sender {
    if (sender == _date) _datePinned = YES;
    BOOL sigmet=self.showingSIGMET;
    NSDictionary *product=sigmet?self.sigmets:self.notams;
    BOOL bounded=!sigmet && Coverage(product).count>0;
    [_dates itemAtIndex:1].title=bounded?@"Downloaded":@"All dates";
    _location.enabled=!sigmet; _category.enabled=!sigmet; _import.hidden=sigmet; _notac.hidden=sigmet;
    _notac.enabled=!self.notacUpdating;
    _notac.title=self.notacUpdating?@"Updating…":@"NOTAC";
    _notac.toolTip=self.notacKeySaved?@"Refresh notices or remove your key":@"Connect your NOTAC account";
    _date.enabled=_dates.indexOfSelectedItem==0;
    _rows=AviationNoticeRows(product,sigmet,_location.selectedItem.representedObject,_date.dateValue,_dates.indexOfSelectedItem==1,sigmet?@"":_category.selectedItem.representedObject);
    [_table reloadData]; [_table deselectAll:nil]; _raw.string=@"";
    BOOL connected=[product[sigmet?@"features":@"notices"] isKindOfClass:NSArray.class];
    NSString *coverageStatus=sigmet?@"":CoverageStatus(product,_location.selectedItem.representedObject,_date.dateValue,_dates.indexOfSelectedItem==1);
    _empty.stringValue=_rows.count?@"":connected?@"No notices in this view":sigmet?@"SIGMET feed unavailable":self.notacKeySaved?@"Refresh NOTAC or import a briefing":@"Connect NOTAC or import a briefing";
    if (!_rows.count && connected && [String(product[@"provider"]) isEqual:@"NOTAC"]) _empty.stringValue=@"No results from NOTAC";
    if (!_rows.count && coverageStatus.length) _empty.stringValue=coverageStatus;
    _empty.hidden=_rows.count>0;
    NSString *origin=sigmet?@"Australia":String(product[@"source"]);
    NSString *prefix=Flag(product[@"imported"])?@"Imported":@"Updated";
    NSString *stamp=Stamp(product[@"retrieved_at"])?[NSString stringWithFormat:@"%@ %@",prefix,DateText(product[@"retrieved_at"],self.timeZone)]:@"";
    NSMutableArray *parts=[NSMutableArray array];
    if (origin.length) [parts addObject:origin];
    if (stamp.length) [parts addObject:stamp];
    if (coverageStatus.length) [parts addObject:coverageStatus];
    if (bounded && _dates.indexOfSelectedItem==1) [parts addObject:[NSString stringWithFormat:@"Through %@",DateText(Coverage(product)[@"valid_to"],self.timeZone)]];
    [parts addObject:connected?[NSString stringWithFormat:@"%lu shown",(unsigned long)_rows.count]:@"No feed"];
    [parts addObject:self.timeZone.abbreviation ?: @"Local time"];
    _status.stringValue=_importStatus.length?_importStatus:[parts componentsJoinedByString:@" · "];
    NSDictionary *coverage=Coverage(product);
    NSArray *coverageLocations=Locations(coverage);
    _status.toolTip=coverageLocations.count?[NSString stringWithFormat:@"%@\n%@ – %@ (%@)",[coverageLocations componentsJoinedByString:@", "],DateText(coverage[@"valid_from"],self.timeZone),DateText(coverage[@"valid_to"],self.timeZone),self.timeZone.abbreviation ?: @"local"]:_status.stringValue;
    [self setNeedsLayout:YES];
}
- (void)setImportStatus:(NSString *)status { _importStatus=[status copy]; [self filter:nil]; }
- (void)import:(id)sender { (void)sender; if (self.onImport) self.onImport(); }
- (void)notac:(id)sender { (void)sender; if (self.onNotac) self.onNotac(); }
- (void)close:(id)sender { (void)sender; if (self.onClose) self.onClose(); }
- (NSInteger)numberOfRowsInTableView:(NSTableView *)table { (void)table; return self.rows.count; }
- (NSView *)tableView:(NSTableView *)table viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
    (void)table; (void)column;
    NoticeCell *cell=[[NoticeCell alloc] initWithFrame:NSMakeRect(0,0,NSWidth(_list.bounds),62)];
    cell.notice=self.rows[row]; cell.zone=self.timeZone; cell.start=_date.dateValue;
    cell.toolTip=String(cell.notice[@"title"]); cell.accessibilityLabel=[NSString stringWithFormat:@"%@. %@",cell.toolTip,TimeSpan(cell.notice,self.timeZone)];
    return cell;
}
- (void)tableViewSelectionDidChange:(NSNotification *)notification {
    (void)notification; NSInteger row=_table.selectedRow;
    _raw.string=row>=0 && row<(NSInteger)self.rows.count?AviationNoticeDetail(self.rows[row],self.timeZone):@"";
    _raw.textColor=NSColor.labelColor; _raw.backgroundColor=NSColor.textBackgroundColor;
    [self setNeedsLayout:YES];
}
- (void)selectNoticeAtIndex:(NSInteger)index { if (index>=0 && index<(NSInteger)self.rows.count) [_table selectRowIndexes:[NSIndexSet indexSetWithIndex:index] byExtendingSelection:NO]; }
- (void)layout {
    [super layout]; CGFloat w=NSWidth(self.bounds),h=NSHeight(self.bounds),pad=14;
    _kind.frame=NSMakeRect(pad,12,180,26); _notac.frame=NSMakeRect(w-258,10,80,30); _import.frame=NSMakeRect(w-174,10,80,30); _close.frame=NSMakeRect(w-90,10,76,30);
    _location.frame=NSMakeRect(pad,50,115,26); _category.frame=NSMakeRect(135,50,140,26);
    _date.frame=NSMakeRect(285,50,190,26); _dates.frame=NSMakeRect(w-134,50,120,26);
    CGFloat detailH=_raw.string.length?MIN(180,h*.36):0;
    _status.frame=NSMakeRect(pad,h-27,w-2*pad,18);
    _detail.hidden=detailH==0; _detail.frame=NSMakeRect(pad,h-35-detailH,w-2*pad,detailH);
    _raw.frame=NSMakeRect(0,0,MAX(1,w-2*pad-4),MAX(detailH,100));
    _raw.textContainer.containerSize=NSMakeSize(MAX(1,w-2*pad-24),CGFLOAT_MAX);
    [_raw.layoutManager ensureLayoutForTextContainer:_raw.textContainer];
    CGFloat textHeight=NSHeight([_raw.layoutManager usedRectForTextContainer:_raw.textContainer])+20;
    [_raw setFrameSize:NSMakeSize(NSWidth(_raw.frame),MAX(detailH,textHeight))];
    _list.frame=NSMakeRect(pad,88,w-2*pad,MAX(60,h-123-(detailH?detailH+8:0)));
    _table.tableColumns.firstObject.width=NSWidth(_list.contentView.bounds);
    _empty.frame=NSMakeRect(pad,100,w-2*pad,24);
}
@end
