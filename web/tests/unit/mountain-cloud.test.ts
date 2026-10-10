import { describe, expect, it } from "vitest";
import {
  sampleMountainCloud,
  terrainDisplacement,
} from "../../src/lib/mountain-cloud";

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
  it("reports windward crest lift and a negative lee-wave phase", () => {
    const crest = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 3000,
      currentDownwindM: 3000,
      distanceLeeM: 0,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 100,
    });
    const flat = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 1000,
      currentDownwindM: 1000,
      distanceLeeM: 0,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 100,
    });
    const opposite = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 3000,
      currentDownwindM: 1800,
      distanceLeeM: crest.wavelengthM / 2,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 100,
    });
    expect(crest.liftM).toBeGreaterThan(flat.liftM);
    expect([crest.leeWaveM, opposite.leeWaveM].some((value) => value < 0)).toBe(
      true,
    );
  });
  it("damps lee-wave displacement with altitude above ground", () => {
    const low = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 3000,
      currentDownwindM: 1800,
      distanceLeeM: 500,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 0,
    });
    const high = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 3000,
      currentDownwindM: 1800,
      distanceLeeM: 500,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 6000,
    });
    expect(Math.abs(high.leeWaveM)).toBeLessThan(Math.abs(low.leeWaveM));
  });
  it("returns bounded, decaying terrain displacement", () => {
    const near = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 3000,
      currentDownwindM: 1800,
      distanceLeeM: 100,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 500,
    });
    const far = terrainDisplacement({
      upwindBaselineM: 1000,
      crestM: 3000,
      currentDownwindM: 1800,
      distanceLeeM: 10000,
      windSpeedMs: 18,
      stabilityN2: 0.0004,
      heightAboveGroundM: 500,
    });
    expect(Math.abs(near.totalM)).toBeLessThanOrEqual(2700);
    expect(Math.abs(far.leeWaveM)).toBeLessThan(Math.abs(near.leeWaveM));
    expect(far.wavelengthM).toBeGreaterThanOrEqual(500);
  });
  it("rejects nonfinite or impossible inputs", () => {
    expect(() =>
      sampleMountainCloud({
        temperatureC: NaN,
        rhPct: 50,
        pressureHPa: 900,
        liftM: 100,
        stabilityN2: 0,
        heightAboveGroundM: 10,
        windSpeedMs: 2,
      }),
    ).toThrow();
    expect(() =>
      terrainDisplacement({
        upwindBaselineM: 0,
        crestM: 1,
        currentDownwindM: 0,
        distanceLeeM: 1,
        windSpeedMs: 0,
        stabilityN2: 0,
        heightAboveGroundM: 0,
      }),
    ).toThrow();
  });
});

describe("mountain wave vertical velocity", () => {
  const base = {
    upwindBaselineM: 1000,
    crestM: 2200,
    currentDownwindM: 1800,
    windSpeedMs: 18,
    stabilityN2: 0.0004,
    heightAboveGroundM: 300,
  };
  it("matches the analytic distance derivative at positive and negative phases", () => {
    const origin = terrainDisplacement({ ...base, distanceLeeM: 0 });
    for (const distanceLeeM of [0, origin.wavelengthM / 2]) {
      const epsilon = 0.5;
      const before = terrainDisplacement({
        ...base,
        distanceLeeM: Math.max(0, distanceLeeM - epsilon),
      });
      const after = terrainDisplacement({
        ...base,
        distanceLeeM: distanceLeeM + epsilon,
      });
      const finiteDifference =
        ((after.leeWaveM - before.leeWaveM) /
          (distanceLeeM === 0 ? epsilon : 2 * epsilon)) *
        base.windSpeedMs;
      expect(
        Math.abs(
          terrainDisplacement({ ...base, distanceLeeM })
            .waveVerticalVelocityMs - finiteDifference,
        ),
      ).toBeLessThan(0.08);
    }
  });
  it("returns zero wave velocity when stable-wave conditions are absent", () => {
    expect(
      terrainDisplacement({ ...base, stabilityN2: 0, distanceLeeM: 1000 })
        .waveVerticalVelocityMs,
    ).toBe(0);
    expect(
      terrainDisplacement({ ...base, windSpeedMs: 4, distanceLeeM: 1000 })
        .waveVerticalVelocityMs,
    ).toBe(0);
  });
});
