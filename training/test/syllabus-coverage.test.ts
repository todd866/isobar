import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { coverageDocuments, validateSyllabi } from '../src/coverage.ts';

const root = new URL('../../docs/training/', import.meta.url);

test('syllabus lists validate and map onto the concept graph', () => {
  assert.deepEqual(validateSyllabi(root), []);
});

test('the coverage report regenerates deterministically', () => {
  const first = coverageDocuments(root);
  const second = coverageDocuments(root);
  assert.equal(first.markdown, second.markdown);
  assert.equal(JSON.stringify(first.json), JSON.stringify(second.json));
  assert.equal(readFileSync(new URL('coverage.md', root), 'utf8'), first.markdown);
  assert.equal(readFileSync(new URL('coverage.json', root), 'utf8'), `${JSON.stringify(first.json, null, 2)}\n`);
});
