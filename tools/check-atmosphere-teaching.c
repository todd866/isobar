#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "../Sources/atmosphereteaching.h"

static void finite_sample(ATTeachingContext c) {
  for (int i=0;i<4;i++) {
    ATTeachingSample s=at_teaching_sample(c,c.lat,c.lon, c.groundM+500);
    const double *p=&s.u; for(int j=0;j<10;j++) assert(isfinite(p[j]));
  }
}
int main(int argc, char **argv) {
  ATTeachingContext sea={ATTeachingSeaBreeze,-31.95,115.86,20,1737000000000.0};
  ATTeachingSample ocean=at_teaching_sample(sea,sea.lat,sea.lon-.35,470), land=at_teaching_sample(sea,sea.lat,sea.lon+.35,470), upper=at_teaching_sample(sea,sea.lat,sea.lon,1870);
  assert(ocean.u>0 && land.w>0 && ocean.w<0 && upper.u<0);
  ATTeachingSample floor=at_teaching_sample(sea,sea.lat,sea.lon,20), lid=at_teaching_sample(sea,sea.lat,sea.lon,2520);
  assert(floor.u==0 && floor.w==0 && floor.cloudPct==0 && lid.u==0 && lid.w==0);
  ATTeachingContext storm=sea; storm.kind=ATTeachingThunderstorm; finite_sample(storm);
  ATTeachingSample up=at_teaching_sample(storm,storm.lat,storm.lon,3020), above=at_teaching_sample(storm,storm.lat,storm.lon,10120);
  ATTeachingSample golden=at_teaching_sample(storm,storm.lat+.01,storm.lon+.01,4220);
  assert(fabs(golden.w-7.322382145)<1e-6 && fabs(golden.temperatureC+0.901663337)<1e-6 && fabs(golden.cloudPct-100.0)<1e-6);
  assert(up.w>0 && above.u==0 && above.w==0);
  ATTeachingContext wave=sea; wave.kind=ATTeachingMountainWave; finite_sample(wave);
  /* Idealised ridge physics: w = U dh/dx at the ground, waves trail into the lee. */
  double mlon=111320.0*cos(wave.lat*3.14159265358979323846/180.0);
  ATTeachingSample windward=at_teaching_sample(wave,wave.lat,wave.lon-1200.0/mlon,wave.groundM), lee=at_teaching_sample(wave,wave.lat,wave.lon+1200.0/mlon,wave.groundM);
  assert(windward.w>2 && lee.w<-2 && windward.u>5);
  double upstream=0, down=0;
  for (double x=2000;x<=40000;x+=500) for (double z=1500;z<=4500;z+=1500) {
    upstream+=fabs(at_teaching_sample(wave,wave.lat,wave.lon-x/mlon,wave.groundM+z).w);
    down+=fabs(at_teaching_sample(wave,wave.lat,wave.lon+x/mlon,wave.groundM+z).w);
  }
  assert(down>2.5*upstream);
  if (argc > 1 && strcmp(argv[1], "--matrix") == 0) {
    const ATTeachingKind kinds[] = {ATTeachingCirculation,ATTeachingSeaBreeze,ATTeachingThunderstorm,ATTeachingMountainWave};
    const double offsets[][2]={{0,0},{.01,.01},{-.02,.015}};
    const double heights[]={0,500,1800,4200,9000,10000,12000};
    for (int k=0;k<4;k++) for (int o=0;o<3;o++) for (int h=0;h<7;h++) {
      ATTeachingContext c={kinds[k],-31.95,115.86,20,1737000000000.0}; ATTeachingSample s=at_teaching_sample(c,c.lat+offsets[o][0],c.lon+offsets[o][1],heights[h]);
      printf("%d,%d,%d %.12g %.12g %.12g %.12g %.12g %.12g %.12g %.12g %.12g %.12g\n",k,o,h,s.u,s.v,s.w,s.temperatureC,s.rhPct,s.pressureHPa,s.cloudPct,s.density,s.cloudBaseM,s.stabilityN2);
    }
  }
  puts("atmosphere teaching C checks passed"); return 0;
}
