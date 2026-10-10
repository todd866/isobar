import { describe, expect, it } from 'vitest';
import { dirtySource, isGeneratedPath, porcelainPath, sha256 } from '../../scripts/write-release-stamp.mjs';

describe('release stamp', () => {
  it('ignores generated deploy outputs and still sees source edits', () => {
    expect(isGeneratedPath('web/public/data/manifest.json')).toBe(true);
    expect(isGeneratedPath('web/.vercel/output/static/data/manifest.json')).toBe(true);
    expect(isGeneratedPath('web/public/procedures/YSSY.json')).toBe(true);
    expect(isGeneratedPath('web/public/isobar-release.json')).toBe(true);
    expect(isGeneratedPath('web/src/lib/point/openmeteo.ts')).toBe(false);
    const generated = [
      '?? web/public/data/manifest.json',
      '?? web/.vercel/project.json',
      '?? web/public/procedures/a.json',
    ].join('\n');
    expect(dirtySource(generated)).toBe(false);
    expect(dirtySource(`${generated}\n M web/src/lib/point/openmeteo.ts`)).toBe(true);
    expect(dirtySource('?? web/src/lib/point/new.ts')).toBe(true);
    expect(dirtySource('')).toBe(false);
    expect(porcelainPath('R  web/old.ts -> web/src/lib/point/openmeteo.ts')).toBe('web/src/lib/point/openmeteo.ts');
  });

  it('hashes the exported manifest bytes', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(Buffer.from('abc'))).not.toBe(sha256(Buffer.from('abd')));
  });
});
