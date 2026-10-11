#import <AppKit/AppKit.h>
#import "windmapview.h"
#import <math.h>
@interface TestWindRun : OwnRun
@property(nonatomic) double speed;
@property(nonatomic) double u;
@property(nonatomic) double v;
@property(nonatomic) BOOL missing;
@property(nonatomic,copy) NSString *pattern;
@end
@implementation TestWindRun
- (OwnRunGeo)geo { return (OwnRunGeo){.west=-180,.north=90,.step=.5,.nLon=720,.nLat=361,.wrapsLongitude=YES}; }
- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field fractionalHour:(double)hour {
    (void)point;(void)hour;
    if (self.missing) return NAN;
    double u=self.u,v=self.v,lon=(point%720)*.5-180,lat=90-(point/720)*.5;
    if([self.pattern isEqual:@"opposite"]&&hour>=.5){u=-u;v=-v;}
    double dx=(lon-116)*cos(-32*M_PI/180),dy=lat+32;
    if([self.pattern isEqual:@"gap"]&&fabs(dx)<3&&fabs(dy)<3)return NAN;
    if([self.pattern isEqual:@"shear"])v=fmax(-12,fmin(12,dy*.5));
    if([self.pattern isEqual:@"circulation"]){double r=fmax(.1,hypot(dx,dy));u=dy/r*12;v=-dx/r*12;}
    if (field==OwnRunFieldWindSpeed) return self.pattern ? hypot(u,v)/.514444 : (self.speed>0?self.speed:hypot(u,v)/.514444);
    if (field==OwnRunFieldWindDirection) return fmod(atan2(-u,-v) * 180.0 / M_PI + 360.0,360.0);
    return 1013;
}
- (double)valueAtPointIndex:(NSInteger)point field:(OwnRunField)field hour:(NSInteger)hour {
    return [self valueAtPointIndex:point field:field fractionalHour:(self.pattern && [self.pattern isEqual:@"opposite"] && hour >= 1) ? 1.0 : 0.0];
}
@end
static NSUInteger Render(WindMapView *view, NSString *name) {
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:640 pixelsHigh:420 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
    CGContextTranslateCTM(NSGraphicsContext.currentContext.CGContext,0,NSHeight(view.bounds));
    CGContextScaleCTM(NSGraphicsContext.currentContext.CGContext,1,-1);
    CGContextClearRect(NSGraphicsContext.currentContext.CGContext,NSRectToCGRect(view.bounds));[view drawRect:view.bounds];
    [NSGraphicsContext restoreGraphicsState];
    NSUInteger ink=0;
    for(NSInteger y=0;y<rep.pixelsHigh;y++)for(NSInteger x=0;x<rep.pixelsWide;x++) {
        NSUInteger pixel[4];[rep getPixel:pixel atX:x y:y];if(pixel[3]>15)ink++;
    }
    [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa/wind" withIntermediateDirectories:YES attributes:nil error:NULL];
    [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[@"build/qa/wind" stringByAppendingPathComponent:name] atomically:YES];
    return ink;
}
static void BitmapMetrics(NSBitmapImageRep *rep, NSBitmapImageRep *before, NSUInteger *ink, NSUInteger *tiles, double *motion) {
    NSUInteger count=0, occupied=0; BOOL tile[16]={0}; double delta=0;
    for (NSInteger y=0;y<rep.pixelsHigh;y++) for (NSInteger x=0;x<rep.pixelsWide;x++) {
        NSUInteger p[4]; [rep getPixel:p atX:x y:y];
        if (p[3]>=16) { count++; tile[(y*4/rep.pixelsHigh)*4+(x*4/rep.pixelsWide)]=YES; }
        if (before) { NSUInteger q[4]; [before getPixel:q atX:x y:y]; delta += fabs((double)p[3]-(double)q[3]); }
    }
    for (int i=0;i<16;i++) if(tile[i]) occupied++;
    *ink=count; *tiles=occupied; *motion=before ? delta/(255.0*rep.pixelsWide*rep.pixelsHigh) : 0;
}
static NSBitmapImageRep *Capture(WindMapView *view, NSString *name) {
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:NSWidth(view.bounds) pixelsHigh:NSHeight(view.bounds) bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState]; [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
    CGContextTranslateCTM(NSGraphicsContext.currentContext.CGContext,0,NSHeight(view.bounds));
    CGContextScaleCTM(NSGraphicsContext.currentContext.CGContext,1,-1); CGContextClearRect(NSGraphicsContext.currentContext.CGContext,NSRectToCGRect(view.bounds));[view drawRect:view.bounds]; [NSGraphicsContext restoreGraphicsState];
    NSString *dir= @"build/qa/wind"; [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL]; [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}]; [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES]; return rep;
}
static void AdvanceAndDraw(WindMapView *view,double seconds,double dt) {
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:NSWidth(view.bounds) pixelsHigh:NSHeight(view.bounds) bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
    CGContextTranslateCTM(NSGraphicsContext.currentContext.CGContext,0,NSHeight(view.bounds));
    CGContextScaleCTM(NSGraphicsContext.currentContext.CGContext,1,-1);
    for(int i=0;i<(int)llround(seconds/dt);i++) { @autoreleasepool {
        CGContextClearRect(NSGraphicsContext.currentContext.CGContext,NSRectToCGRect(view.bounds));
        [view advanceBy:dt];CGContextClearRect(NSGraphicsContext.currentContext.CGContext,NSRectToCGRect(view.bounds));[view drawRect:view.bounds];
    }}
    [NSGraphicsContext restoreGraphicsState];
}
int main(void) { @autoreleasepool {
    IsobarCamera c={.centreLat=-32,.centreLon=116,.zoom=30,.viewportW=1000,.viewportH=700};
    NSPoint a,b; int failures=0;
    BOOL flat=WindMapProjectOffset(c,-32,116,0,0,&a)&&WindMapProjectOffset(c,-32,116,0,10000,&b);
    double overhead=hypot(b.x-a.x,b.y-a.y);
    c.pitch=1.05;c.globe=1;
    BOOL tilted=WindMapProjectOffset(c,-32,116,0,0,&a)&&WindMapProjectOffset(c,-32,116,0,10000,&b);
    if(!flat||!tilted||!(hypot(b.x-a.x,b.y-a.y)<overhead*.85)){fprintf(stderr,"FAIL wind geometry must foreshorten\n");failures++;}
    c.centreLat=89.9;c.centreLon=179.9;
    if(!WindMapProjectOffset(c,89.9,179.9,1000,0,&a)||!isfinite(a.x)){fprintf(stderr,"FAIL polar vector\n");failures++;}
    c.centreLat=0;c.centreLon=0;
    if(WindMapProjectOffset(c,0,180,1000,0,&a)){fprintf(stderr,"FAIL far-side vector must be hidden\n");failures++;}
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    WindMapView *view=[[WindMapView alloc] initWithFrame:NSMakeRect(0,0,640,420)];
    TestWindRun *run=[TestWindRun new];view.run=run;
    c.centreLat=-32;c.centreLon=116;c.zoom=30;view.camera=c;
    view.barbs=YES;
    for(NSNumber *speed in @[@15,@65,@125]) {
        run.speed=speed.doubleValue;
        NSUInteger ink=Render(view,[NSString stringWithFormat:@"tilted-%@.png",speed]);
        if(view.drawnCount<10||ink<150){fprintf(stderr,"FAIL real wind barbs not visible at %.0f kt (%lu, %lu pixels)\n",run.speed,(unsigned long)view.drawnCount,(unsigned long)ink);failures++;}
    }
    run.missing=YES;
    if(Render(view,@"missing.png")!=0||view.drawnCount){fprintf(stderr,"FAIL missing wind must stay blank\n");failures++;}
    run.missing=NO;run.pattern=@"opposite";run.u=12;run.v=0;view.barbs=NO;view.fractionalStep=.5;
    if(Render(view,@"opposite-halfway.png")!=0||view.drawnCount){fprintf(stderr,"FAIL opposite endpoint vectors must cancel at halfway\n");failures++;}
    view.fractionalStep=0;run.pattern=nil;
    WindMapView *densityView=[[WindMapView alloc] initWithFrame:NSMakeRect(0,0,640,420)];
    densityView.camera=(IsobarCamera){.centreLat=-32,.centreLon=116,.zoom=80,.viewportW=640,.viewportH=420};
    densityView.windLens=YES;run.missing=NO;run.u=12;run.v=0;run.speed=12/.514444;densityView.run=run;
    AdvanceAndDraw(densityView,3,1.0/60);
    NSUInteger dense=Render(densityView,@"density-before.png");
    densityView.windLens=NO;[densityView advanceBy:1.0/60.0];NSUInteger reduced=Render(densityView,@"density-after.png");
    if(dense<200||reduced<dense*.65){fprintf(stderr,"FAIL density switch must fade outgoing flow (%lu -> %lu)\n",(unsigned long)dense,(unsigned long)reduced);failures++;}
    // Shared native/browser visual contract. The fixture is deliberately read
    // at runtime so additions to the scene set cannot silently skip native.
    NSData *fixture=[NSData dataWithContentsOfFile:@"Tests/fixtures/wind-visual-contract.json"]; NSError *jsonError=nil; NSDictionary *contract=fixture?[NSJSONSerialization JSONObjectWithData:fixture options:0 error:&jsonError]:nil; NSArray *scenes=contract[@"scenes"];
    if(![scenes isKindOfClass:[NSArray class]]) { fprintf(stderr,"FAIL missing wind visual contract: %s\n",jsonError.localizedDescription.UTF8String); return 1; }
    NSMutableArray *report=[NSMutableArray array];
    for(NSDictionary *scene in scenes){ NSInteger width=[scene[@"width"] integerValue],height=[scene[@"height"] integerValue]; WindMapView *flow=[[WindMapView alloc] initWithFrame:NSMakeRect(0,0,width,height)]; TestWindRun *wind=[TestWindRun new]; wind.missing=scene[@"u"]==[NSNull null]||scene[@"v"]==[NSNull null]; wind.u=wind.missing?0:[scene[@"u"] doubleValue]; wind.v=wind.missing?0:[scene[@"v"] doubleValue]; wind.speed=hypot(wind.u,wind.v)/0.514444; wind.pattern=scene[@"pattern"]; flow.run=wind; flow.camera=(IsobarCamera){.centreLat=[scene[@"latitude"] doubleValue],.centreLon=[scene[@"longitude"] doubleValue],.zoom=[scene[@"zoom"] doubleValue],.pitch=[scene[@"pitch"] doubleValue],.globe=[scene[@"pitch"] doubleValue]>0?1:0,.viewportW=width,.viewportH=height}; flow.chartDark=[scene[@"dark"] boolValue]; flow.windLens=[scene[@"windLens"] boolValue]; flow.reducedMotion=[scene[@"reduced"] boolValue];
        AdvanceAndDraw(flow,[contract[@"warmupSeconds"] doubleValue],[contract[@"dt"] doubleValue]); NSBitmapImageRep *before=Capture(flow,[scene[@"id"] stringByAppendingString:@"-before.png"]); AdvanceAndDraw(flow,[contract[@"motionSeconds"] doubleValue],[contract[@"dt"] doubleValue]); NSBitmapImageRep *after=Capture(flow,[scene[@"id"] stringByAppendingString:@"-after.png"]); NSUInteger ink=0,tiles=0;double motion=0;BitmapMetrics(after,before,&ink,&tiles,&motion); NSMutableDictionary *row=[@{ @"id":scene[@"id"], @"inkFraction":@(ink/(double)(width*height)), @"occupiedTiles":@(tiles), @"motionFraction":@(motion), @"drawn":@(flow.drawnCount), @"maxSegmentPx":@(flow.maxSegmentPixels) } mutableCopy]; [report addObject:row];
        NSDictionary *limits=contract[@"limits"];
        BOOL blank=wind.missing||hypot(wind.u,wind.v)<2.5;
        double fraction=ink/(double)(width*height);
        BOOL passed=blank?(ink==0&&flow.drawnCount==0):
            fraction>[limits[@"minInkFraction"] doubleValue]&&fraction<[limits[@"maxInkFraction"] doubleValue]&&
            tiles>=[limits[@"minOccupiedTiles"] unsignedIntegerValue]&&
            (flow.reducedMotion?motion==0:motion>[limits[@"minMotionFraction"] doubleValue])&&
            motion<[limits[@"maxMotionFraction"] doubleValue]&&flow.maxSegmentPixels<=[limits[@"maxSegmentPx"] doubleValue];
        if(!passed){fprintf(stderr,"FAIL flow contract %s ink=%g tiles=%lu motion=%g segment=%g\n",[scene[@"id"] UTF8String],fraction,(unsigned long)tiles,motion,flow.maxSegmentPixels);failures++;}
    }
    NSData *reportData=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:NULL]; [[NSFileManager defaultManager] createDirectoryAtPath:@"build/qa/wind" withIntermediateDirectories:YES attributes:nil error:NULL]; [reportData writeToFile:@"build/qa/wind/native-contract.json" atomically:YES];
    printf("wind map geometry failures: %d\n",failures); return failures?1:0;
} }
