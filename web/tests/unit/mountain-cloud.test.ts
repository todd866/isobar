import { describe, expect, it } from "vitest";
import { sampleMountainCloud } from "../../src/lib/mountain-cloud";

describe("mountain parcel cloud model", () => {
  it("condenses a moist parcel lifted through its LCL", () => {
    const result = sampleMountainCloud({
      temperatureC: 12,
      rhPct: 92,
      pressureHPa: 850,
      liftM: 1800,
      stabilityN2: 0.0001,
      heightAboveGroundM: 500,
      windSpeedMs: 12,
    });
    expect(result.saturated).toBe(true);
    expect(result.condensateGKg).toBeGreaterThan(0);
    expect(["orographic", "wave"]).toContain(result.kind);
  });
  it("keeps dry or descending parcels clear", () => {
    const dry = sampleMountainCloud({
      temperatureC: 20,
      rhPct: 15,
      pressureHPa: 900,
      liftM: 100,
      stabilityN2: 0,
      heightAboveGroundM: 20,
      windSpeedMs: 3,
    });
    const descending = sampleMountainCloud({
      temperatureC: 10,
      rhPct: 65,
      pressureHPa: 900,
      liftM: -500,
      stabilityN2: 0,
      heightAboveGroundM: 20,
      windSpeedMs: 3,
    });
    expect(dry.kind).toBe("clear");
    expect(descending.kind).toBe("clear");
    expect(descending.density).toBe(0);
  });
  it("distinguishes stable lee waves from unstable convection", () => {
    const wave = sampleMountainCloud({
      temperatureC: 2,
      rhPct: 95,
      pressureHPa: 700,
      liftM: 2200,
      stabilityN2: 0.0004,
      heightAboveGroundM: 1000,
      windSpeedMs: 18,
    });
    const convective = sampleMountainCloud({
      temperatureC: 25,
      rhPct: 90,
      pressureHPa: 950,
      liftM: 1800,
      stabilityN2: -0.0001,
      heightAboveGroundM: 500,
      windSpeedMs: 8,
    });
    expect(wave.kind).toBe("wave");
    expect(convective.kind).toBe("convective");
  });
  it("uses a colder saturated lapse rate closer to dry adiabatic", () => {
    const cold = sampleMountainCloud({
      temperatureC: -25,
      rhPct: 95,
      pressureHPa: 600,
      liftM: 2500,
      stabilityN2: 0,
      heightAboveGroundM: 500,
      windSpeedMs: 10,
    });
    const warm = sampleMountainCloud({
      temperatureC: 25,
      rhPct: 95,
      pressureHPa: 900,
      liftM: 2500,
      stabilityN2: 0,
      heightAboveGroundM: 500,
      windSpeedMs: 10,
    });
    const coldDrop = -25 - cold.liftedTemperatureC;
    const warmDrop = 25 - warm.liftedTemperatureC;
    expect(coldDrop).toBeGreaterThan(warmDrop);
    expect(coldDrop).toBeLessThan(25);
  });
});
