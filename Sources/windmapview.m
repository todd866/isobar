#import "windmapview.h"
#import "ownchart.h"
#import <math.h>

BOOL WindMapProjectOffset(IsobarCamera camera,double lat,double lon,double east,double north,NSPoint *p) {
    // Exponential map on the sphere avoids a cos(latitude) singularity at the poles.
    double d=hypot(east,north)/6371000.0, bearing=atan2(east,north), phi=lat*M_PI/180;
    double target=asin(fmax(-1,fmin(1,sin(phi)*cos(d)+cos(phi)*sin(d)*cos(bearing))));
    double lambda=lon*M_PI/180+atan2(sin(bearing)*sin(d)*cos(phi),cos(d)-sin(phi)*sin(target));
    double x=0,y=0;
    // Native map currently has a sea-level surface; no model orography is fabricated.
    if (!IsobarCameraProjectAltitude(camera,target*180/M_PI,lambda*180/M_PI,10,&x,&y)) return NO;
    if (!isfinite(x)||!isfinite(y)) return NO;
    if(p) *p=NSMakePoint(x,y);
    return YES;
}

@implementation WindMapView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty; _drawnCount=0;
    if (!_run || !isfinite(_fractionalStep)) return;
    IsobarCamera camera=_camera;
    camera.viewportW=NSWidth(self.bounds); camera.viewportH=NSHeight(self.bounds);
    if(camera.viewportW<1||camera.viewportH<1||camera.zoom<=0) return;
    OwnRunGeo grid=[_run geo];
    if(grid.step<=0||grid.nLon<1||grid.nLat<1) return;
    // One world length at the focus; foreshortening survives instead of re-normalising each glyph.
    double metresPerPoint=111195.08/(camera.zoom*fmin(camera.viewportW/360.0,camera.viewportH/180.0));
    double staff=23*metresPerPoint;
    NSColor *ink=[(_chartDark?[NSColor colorWithWhite:.9 alpha:1]:[NSColor colorWithSRGBRed:.12 green:.18 blue:.22 alpha:1]) colorWithAlphaComponent:.68];
    [ink setStroke]; [ink setFill];
    for(double y=40;y<camera.viewportH-20;y+=58) for(double x=28;x<camera.viewportW-20;x+=58) {
        double lat=0,lon=0;
        if(!IsobarCameraUnproject(camera,x,y,&lat,&lon)) continue;
        double col=(lon-grid.west)/grid.step;
        if(grid.wrapsLongitude) col=fmod(fmod(col,grid.nLon)+grid.nLon,grid.nLon);
        NSInteger i=llround(col),j=llround((grid.north-lat)/grid.step);
        if(grid.wrapsLongitude) i%=grid.nLon;
        if(i<0||i>=grid.nLon||j<0||j>=grid.nLat) continue;
        NSInteger cell=j*grid.nLon+i;
        double speed=[_run valueAtPointIndex:cell field:OwnRunFieldWindSpeed fractionalHour:_fractionalStep];
        double from=[_run valueAtPointIndex:cell field:OwnRunFieldWindDirection fractionalHour:_fractionalStep];
        if(!isfinite(speed)||!isfinite(from)||speed<0) continue;
        OwnBarb barb=OwnWindBarb(from,speed,staff,lat<0);
        NSBezierPath *path=[NSBezierPath bezierPath]; path.lineWidth=1;
        if(barb.calm) {
            BOOL valid=YES;
            for(int k=0;k<=12;k++) { NSPoint p; double a=k*M_PI/6;
                if(!WindMapProjectOffset(camera,lat,lon,2*metresPerPoint*cos(a),2*metresPerPoint*sin(a),&p)){valid=NO;break;}
                if(k==0)[path moveToPoint:p];else[path lineToPoint:p];
            }
            if(valid){[path stroke];_drawnCount++;} continue;
        }
        BOOL drawn=NO;
        for(int k=0;k<barb.nSeg;k++) {
            NSPoint a,b;
            if(!WindMapProjectOffset(camera,lat,lon,barb.segs[k].a.x,barb.segs[k].a.y,&a)||
               !WindMapProjectOffset(camera,lat,lon,barb.segs[k].b.x,barb.segs[k].b.y,&b))continue;
            if(hypot(b.x-a.x,b.y-a.y)>camera.viewportW*.5) continue;
            [path moveToPoint:a];[path lineToPoint:b];drawn=YES;
        }
        [path stroke];
        for(int k=0;k<barb.nTri;k++) {
            NSPoint p[3];BOOL valid=YES;
            for(int v=0;v<3;v++) if(!WindMapProjectOffset(camera,lat,lon,barb.tri[k][v].x,barb.tri[k][v].y,&p[v]))valid=NO;
            if(!valid)continue;
            NSBezierPath *flag=[NSBezierPath bezierPath];[flag moveToPoint:p[0]];[flag lineToPoint:p[1]];[flag lineToPoint:p[2]];[flag closePath];[flag fill];drawn=YES;
        }
        if(drawn)_drawnCount++;
    }
}
@end
