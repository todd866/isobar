#import "e6bview.h"
#import "e6b.h"
#include <math.h>

@implementation E6BView {
    NSMutableArray<NSTextField *> *_inputs;
    NSMutableArray<NSStepper *> *_steps;
    NSMutableArray<NSTextField *> *_outputs;
}
- (BOOL)isFlipped { return YES; }
- (instancetype)initWithFrame:(NSRect)frame {
    if (!(self=[super initWithFrame:frame])) return nil;
    _inputs=[NSMutableArray new]; _steps=[NSMutableArray new]; _outputs=[NSMutableArray new];
    NSArray *names=@[@"TC °T",@"TAS kt",@"W/V °T",@"W/V kt"];
    NSArray *ids=@[@"tc",@"tas",@"from",@"kt"];
    for (NSInteger i=0;i<4;i++) {
        CGFloat x=18+i*133;
        NSTextField *label=[NSTextField labelWithString:names[i]];
        label.frame=NSMakeRect(x,16,115,20); label.textColor=NSColor.secondaryLabelColor;
        [self addSubview:label];
        NSTextField *input=[[NSTextField alloc] initWithFrame:NSMakeRect(x,40,88,30)];
        input.font=[NSFont monospacedDigitSystemFontOfSize:20 weight:NSFontWeightMedium];
        input.alignment=NSTextAlignmentRight; input.delegate=self;
        input.accessibilityIdentifier=[@"e6b." stringByAppendingString:ids[i]];
        input.accessibilityLabel=names[i]; input.stringValue=@"";
        [_inputs addObject:input]; [self addSubview:input];
        NSStepper *step=[[NSStepper alloc] initWithFrame:NSMakeRect(x+94,40,19,30)];
        step.minValue=0; step.maxValue=(i==0 || i==2)?360:2000; step.increment=1;
        step.tag=i; step.target=self; step.action=@selector(step:);
        step.accessibilityLabel=[names[i] stringByAppendingString:@" increment"];
        [_steps addObject:step]; [self addSubview:step];
    }
    NSArray *outNames=@[@"WCA",@"TH °T",@"GS kt"];
    for (NSInteger i=0;i<3;i++) {
        CGFloat x=18+i*177;
        NSTextField *label=[NSTextField labelWithString:outNames[i]];
        label.frame=NSMakeRect(x,94,155,20); label.textColor=NSColor.secondaryLabelColor;
        [self addSubview:label];
        NSTextField *value=[NSTextField labelWithString:@"—"];
        value.frame=NSMakeRect(x,118,155,45);
        value.font=[NSFont monospacedDigitSystemFontOfSize:32 weight:NSFontWeightMedium];
        value.alignment=NSTextAlignmentRight;
        value.accessibilityIdentifier=[@"e6b." stringByAppendingString:@[@"wca",@"th",@"gs"][i]];
        value.accessibilityLabel=outNames[i]; [_outputs addObject:value]; [self addSubview:value];
    }
    NSButton *close=[NSButton buttonWithTitle:@"Close" target:self action:@selector(cancelOperation:)];
    close.frame=NSMakeRect(450,180,90,28); close.keyEquivalent=@"\e";
    [self addSubview:close];
    return self;
}
- (void)drawRect:(NSRect)dirty {
    [NSColor.windowBackgroundColor setFill]; NSRectFill(dirty);
    [NSColor.separatorColor setFill]; NSRectFill(NSMakeRect(18,83,514,1));
}
static double inputNumber(NSTextField *field) {
    NSString *s=[field.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSScanner *scanner=[NSScanner scannerWithString:s]; scanner.locale=[[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
    double value;
    return s.length && [scanner scanDouble:&value] && scanner.isAtEnd && isfinite(value) ? value : NAN;
}
- (void)updateReadouts {
    double tc=inputNumber(_inputs[0]), tas=inputNumber(_inputs[1]);
    double from=inputNumber(_inputs[2]), kt=inputNumber(_inputs[3]);
    for (NSInteger i=0;i<4;i++) { double v=inputNumber(_inputs[i]); if (isfinite(v)) _steps[i].doubleValue=v; }
    E6BHeadingResult answer;
    E6BSolveHeading(tc,tas,from,kt,&answer);
    if (tc<0 || tc>360 || from<0 || from>360 || tas>2000 || kt>2000) answer=(E6BHeadingResult){NAN,NAN,NAN};
    BOOL valid=isfinite(answer.gs);
    _outputs[0].stringValue=valid ? [NSString stringWithFormat:@"%.1f° %@",fabs(answer.wca),fabs(answer.wca)<0.05?@"":answer.wca<0?@"L":@"R"] : @"—";
    _outputs[1].stringValue=valid ? [NSString stringWithFormat:@"%05.1f",answer.th] : @"—";
    _outputs[2].stringValue=valid ? [NSString stringWithFormat:@"%.1f",answer.gs] : @"—";
    for (NSTextField *out in _outputs) out.toolTip=valid?nil:@"Missing, invalid or no forward solution";
}
- (void)controlTextDidChange:(NSNotification *)notification { (void)notification; [self updateReadouts]; }
- (void)step:(NSStepper *)sender {
    _inputs[sender.tag].stringValue=[NSString stringWithFormat:@"%.0f",sender.doubleValue]; [self updateReadouts];
}
- (void)cancelOperation:(id)sender {
    (void)sender;
    [self.window cancelOperation:nil];
}
@end

@implementation E6BPanel
- (void)cancelOperation:(id)sender {
    (void)sender;
    if (self.sheetParent) [self.sheetParent endSheet:self];
    [self orderOut:nil];
}
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if (event.type==NSEventTypeKeyDown && event.keyCode==53) { [self cancelOperation:nil]; return YES; }
    return [super performKeyEquivalent:event];
}
@end

void E6BWindowPresent(NSWindow *parent, void (^onClose)(void)) {
    if (!parent || parent.attachedSheet) return;
    E6BPanel *panel=[[E6BPanel alloc] initWithContentRect:NSMakeRect(0,0,550,220)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
    panel.title=@"E6-B · Wind triangle"; panel.releasedWhenClosed=NO;
    panel.contentView=[[E6BView alloc] initWithFrame:NSMakeRect(0,0,550,220)];
    [parent beginSheet:panel completionHandler:^(NSModalResponse result) { (void)result; [panel orderOut:nil]; if (onClose) onClose(); }];
}
