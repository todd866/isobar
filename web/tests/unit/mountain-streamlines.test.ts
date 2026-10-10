import { describe, expect, it } from "vitest";
import { buildMountainStreamlines } from "../../src/lib/mountain-streamlines";
const seed = { lat: 28, lon: 86.9, heightM: 5600 };
const flat = (lon: number, lat: number) => 5000;

describe("mountain streamlines", () => {
  it("curves in a turning wind field and is deterministic", () => {
    const sample = (lat: number, lon: number, height: number) => ({
      u: 8,
      v: (lat - 28) * 40,
      w: 0,
    });
    const a = buildMountainStreamlines([seed], sample, flat, {
      steps: 12,
      stepM: 100,
    });
    const b = buildMountainStreamlines([seed], sample, flat, {
      steps: 12,
      stepM: 100,
    });
    expect(a).toEqual(b);
    expect(a[0].points.length).toBeGreaterThan(2);
    expect(
      new Set(a[0].points.map((point) => point.lon.toFixed(5))).size,
    ).toBeGreaterThan(2);
  });
  it("orders points from upstream through the seed to downstream", () => {
    const path = buildMountainStreamlines(
      [seed],
      () => ({ u: 8, v: 0, w: 0 }),
      flat,
      { steps: 4, stepM: 100 },
    )[0];
    const seedIndex = path.points.reduce(
      (best, point, index) =>
        Math.abs(point.lon - seed.lon) <
        Math.abs(path.points[best].lon - seed.lon)
          ? index
          : best,
      0,
    );
    expect(path.points[0].lon).toBeLessThan(seed.lon);
    expect(path.points.at(-1)!.lon).toBeGreaterThan(seed.lon);
    expect(seedIndex).toBeGreaterThan(0);
  });
  it("stops when any wind component is missing", () => {
    const paths = buildMountainStreamlines(
      [seed],
      () => ({ u: null, v: 2, w: 0 }),
      flat,
      { steps: 8 },
    );
    expect(paths).toHaveLength(0);
  });
  it("follows rising and sinking vertical wind", () => {
    const rising = buildMountainStreamlines(
      [seed],
      () => ({ u: 8, v: 0, w: 2 }),
      flat,
      { steps: 6, stepM: 100 },
    )[0];
    const sinking = buildMountainStreamlines(
      [seed],
      () => ({ u: 8, v: 0, w: -2 }),
      flat,
      { steps: 6, stepM: 100 },
    )[0];
    expect(
      Math.max(...rising.points.map((point) => point.heightM)),
    ).toBeGreaterThan(seed.heightM);
    expect(
      Math.min(...sinking.points.map((point) => point.heightM)),
    ).toBeLessThan(seed.heightM);
  });
  it("stops before a ridge collision", () => {
    const path = buildMountainStreamlines(
      [seed],
      (lat, lon, height) => ({ u: 20, v: 0, w: 0 }),
      (lon) => (lon > 86.91 ? 5700 : 5000),
      { steps: 24, stepM: 100 },
    )[0];
    expect(
      path.points.every(
        (point) => point.heightM - (point.lon > 86.91 ? 5700 : 5000) >= 50,
      ),
    ).toBe(true);
    expect(path.points.length).toBeLessThan(40);
  });
  it("bounds paths, steps and null samples", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => ({
      ...seed,
      heightM: 5000 + i * 10,
    }));
    const paths = buildMountainStreamlines(seeds, () => null, flat, {
      maxPaths: 200,
      steps: 100,
    });
    expect(paths).toHaveLength(0);
    expect(() =>
      buildMountainStreamlines([seed], () => ({ u: 1, v: 0, w: 0 }), flat, {
        steps: Number.NaN,
      }),
    ).toThrow();
  });
});
