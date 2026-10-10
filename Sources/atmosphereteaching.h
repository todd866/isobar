// Synthetic teaching atmosphere. Header-only, deterministic, and dependency-free.
// These fields are illustrative displacement models, never a weather forecast.
#ifndef ISOBAR_ATMOSPHERE_TEACHING_H
#define ISOBAR_ATMOSPHERE_TEACHING_H

#include <math.h>
#include <stdint.h>

typedef enum {
  ATTeachingCirculation = 0,
  ATTeachingSeaBreeze = 1,
  ATTeachingThunderstorm = 2,
  ATTeachingMountainWave = 3
} ATTeachingKind;

typedef struct {
  ATTeachingKind kind;
  double lat, lon, groundM, timeMs;
} ATTeachingContext;

typedef struct {
  double u, v, w, temperatureC, rhPct, pressureHPa, stabilityN2;
  double cloudPct, density, cloudBaseM;
} ATTeachingSample;

static inline double at_clamp(double x, double lo, double hi) { return fmax(lo, fmin(hi, x)); }
static inline double at_wrap180(double x) {
  double r = fmod(x + 540.0, 360.0);
  if (r < 0) r += 360.0;
  return r - 180.0;
}
static inline double at_sat_hpa(double t) { return 6.112 * exp((17.67 * t) / (t + 243.5)); }
static inline double at_dewpoint(double t, double rh) {
  double r = at_clamp(rh, .1, 100.0) / 100.0;
  double g = log(r) + 17.67 * t / (t + 243.5);
  return 243.5 * g / (17.67 - g);
}
static inline double at_mixing_gkg(double t, double p, double rh) {
  double vap = at_sat_hpa(t) * at_clamp(rh, 0, 100) / 100.0;
  return 1000.0 * .622 * vap / fmax(1.0, p - vap);
}

static inline void at_profile(double z, double ground, double warm, double rhOffset,
                              double *t, double *rh, double *p) {
  double amsl = ground + z;
  *t = at_clamp(24.0 + warm - .0065 * amsl, -90.0, 50.0);
  *p = at_clamp(1013.25 * exp(-9.80665 * amsl / (287.05 * (*t + 273.15))), 50.0, 1100.0);
  *rh = at_clamp(78.0 + rhOffset - .0018 * z, 28.0, 96.0);
}

/* Parcel lift is explicit synthetic displacement. Negative lift dries on descent. */
static inline void at_cloud(double t, double rh, double p, double z, double n2,
                            double lift, double wind, double *pct, double *base,
                            double *liftedTOut, double *mixOut, int *saturatedOut) {
  double dp = at_dewpoint(t, rh);
  double lcl = fmax(0.0, 125.0 * (t - dp));
  double initial = at_mixing_gkg(t, p, rh);
  double dryLift = fmin(fmax(lift, 0.0), lcl) + fmin(fmax(lift, -5000.0), 0.0);
  double liftedT = t - dryLift * .0098;
  double liftedP = p * exp(-dryLift / 8000.0);
  double moist = fmax(0.0, lift - lcl);
  int steps = (int)fmax(1.0, ceil(moist / 100.0));
  double dz = moist / steps;
  for (int i = 0; i < steps; i++) {
    double kelvin = liftedT + 273.15;
    double q = at_mixing_gkg(liftedT, liftedP, 100.0) / 1000.0;
    double latent = 2.5e6;
    double lapse = (9.80665 * (1.0 + latent * q / (287.05 * kelvin))) /
      (1004.0 + latent * latent * q * .622 / (287.05 * kelvin * kelvin));
    liftedT -= lapse * dz;
    liftedP *= exp(-9.80665 * dz / (287.05 * kelvin));
  }
  double condensate = at_clamp(initial - at_mixing_gkg(liftedT, liftedP, 100.0), 0, 8.0);
  int saturated = condensate > .02 && lift >= lcl;
  *pct = saturated ? 100.0 * at_clamp(1.0 - exp(-condensate / .15), 0, 1) : 0.0;
  *base = lcl;
  *liftedTOut = liftedT;
  *mixOut = initial;
  *saturatedOut = saturated;
  (void)z; (void)n2; (void)wind;
}

static inline ATTeachingSample at_teaching_sample(ATTeachingContext c, double lat, double lon, double heightM) {
  const double PI = 3.14159265358979323846, EARTH = 111320.0, MAXZ = 12000.0;
  double z = at_clamp(heightM - c.groundM, 0, MAXZ);
  double x = at_wrap180(lon - c.lon) * EARTH * fmax(.2, cos(c.lat * PI / 180.0));
  double y = (lat - c.lat) * EARTH;
  double u=0, v=0, w=0, n2=.00008, lift=0, wind=5, lid=2500;
  double localMs = c.timeMs + c.lon * 240000.0;
  double day = 2 * PI * (localMs / 86400000.0 - .25);
  double daylight = .5 + .5 * sin(day);
  if (c.kind == ATTeachingSeaBreeze) {
    double H=2500, L=6000, s=exp(-x*x/(L*L)), ds=-2*x*s/(L*L), q=sin(PI*z/H), amp=8*(.65+.35*daylight);
    u=amp*s*sin(2*PI*z/H); w=-(amp*H/PI)*ds*q*q; n2=.00006; wind=fabs(u)+1; lift=700*s*q*q;
  } else if (c.kind == ATTeachingThunderstorm) {
    double H=10000, L=5000, r2=x*x+y*y, g=exp(-r2/(L*L)), f=(1-r2/(L*L))*g, q=sin(PI*z/H), r=sqrt(r2);
    double vr=-9*PI/H*cos(PI*z/H)*.5*r*g; w=9*f*q; u=r>0?vr*x/r:0; v=r>0?vr*y/r:0;
    n2=(z/H)<.65?-.00008:.00012; wind=hypot(u,v)+4;
    double outflow=at_clamp((z-6500.0)/3000.0,0,1), plumeRadius=2500*(1+2.2*outflow*outflow*(3-2*outflow));
    lift=fmin(z,3000.0)*exp(-r2/(plumeRadius*plumeRadius)); lid=H;
  } else if (c.kind == ATTeachingMountainWave) {
    double k=2*PI/12000, m=PI/7000, phase=k*x+m*z, taper=sin(PI*z/MAXZ); taper*=taper;
    double hg=exp(-x*x/(130000.0*130000.0)), d=900*cos(phase)*taper*hg;
    double dx=900*taper*hg*(-k*sin(phase)-2*x*cos(phase)/(130000.0*130000.0));
    double dz=900*hg*(-m*sin(phase)*taper+cos(phase)*(PI/MAXZ)*sin(2*PI*z/MAXZ));
    double mean=16+1.2*sin(day); u=mean-mean*dz; w=mean*dx; v=.4*sin(phase+PI/2)*taper*hg; n2=.00035; wind=fabs(u); lift=d; lid=MAXZ;
  } else {
    double H=10000, L=6000, r2=x*x+y*y, g=exp(-r2/(L*L)), f=(1-r2/(L*L))*g, q=z/H, r=sqrt(r2);
    double vr=-3*PI/H*cos(PI*q)*.5*r*g; u=r>0?vr*x/r:0; v=r>0?vr*y/r:0; w=3*f*sin(PI*q); n2=.0001; wind=hypot(u,v)+1; lift=600*f*(1-cos(PI*q))*.5; lid=H;
  }
  double t,rh,p; double warm=c.kind==ATTeachingThunderstorm?1:0, offset=c.kind==ATTeachingThunderstorm?12:(c.kind==ATTeachingMountainWave?8:0);
  at_profile(z,c.groundM,warm,offset,&t,&rh,&p);
  double origin=at_clamp(z-lift,0,MAXZ), ot,orh,op;
  at_profile(origin,c.groundM,warm,offset,&ot,&orh,&op);
  double cloud,base,liftedT,mix; int saturated;
  at_cloud(ot,orh,op,z,n2,lift,wind,&cloud,&base,&liftedT,&mix,&saturated);
  double finalRh = saturated ? 100.0 : at_clamp(100.0 * (mix * p / (622.0 + mix)) / at_sat_hpa(liftedT), 0, 100);
  double lidFade=1.0-at_clamp((z-(lid-500.0))/500.0,0,1);
  int below=heightM<c.groundM, above=z>=lid;
  ATTeachingSample out={below||above?0:u,below||above?0:v,below||above?0:w,liftedT,finalRh,p,n2,below||above?0:cloud*lidFade,below||above?0:cloud*lidFade/100.0,below?c.groundM:c.groundM+origin+base};
  return out;
}

#endif
