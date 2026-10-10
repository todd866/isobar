import { computeTeachingSnapshot, type TeachingInput } from '../lib/teaching-snapshot';
self.onmessage = (event: MessageEvent<TeachingInput>) => {
  try { self.postMessage({ snapshot: computeTeachingSnapshot(event.data) }); }
  catch { self.postMessage({ error: 'Chart explanation unavailable' }); }
};
