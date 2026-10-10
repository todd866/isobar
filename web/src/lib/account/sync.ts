/** Signed-in sync: merge this device with the account, write both sides.
 *
 * The first run after sign-in is the guest claim: whatever this device holds
 * is merged into the account (never replacing either side). Afterwards local
 * changes push about two seconds after they happen, and the account is pulled
 * again whenever the app comes back to the foreground. A write names the rev
 * it was merged onto; on 409 the server's copy is merged in and written again. */
import { DOC_KINDS, mergeDoc, sameJson, type DocKind } from './merge.ts';
import { LOCAL_CHANGE, SYNCED, readLocal, writeLocal } from './local.ts';

interface Remote { data: unknown; rev: number }

const PUSH_DELAY_MS = 2_000;
const PULL_GAP_MS = 15_000;

export class AccountSync {
  private remote: Partial<Record<DocKind, Remote | null>> = {};
  private dirty = new Set<DocKind>();
  private timer = 0;
  private lastPull = 0;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Resolves when the first pull-and-merge has finished. */
  readonly ready: Promise<void>;

  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {
    window.addEventListener(LOCAL_CHANGE, this.onLocal);
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('pagehide', this.onHide);
    this.ready = this.queue(() => this.pull());
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    window.removeEventListener(LOCAL_CHANGE, this.onLocal);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('pagehide', this.onHide);
  }

  /** Pushes anything pending now (tests, sign-out). */
  flush(): Promise<void> {
    window.clearTimeout(this.timer);
    return this.queue(() => this.push());
  }

  private onLocal = (event: Event) => {
    const kind = (event as CustomEvent<{ kind: DocKind }>).detail?.kind;
    if (!kind) return;
    this.dirty.add(kind);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.queue(() => this.push()), PUSH_DELAY_MS);
  };

  private onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - this.lastPull > PULL_GAP_MS) void this.queue(() => this.pull());
    if (document.visibilityState === 'hidden' && this.dirty.size) void this.flush();
  };

  private onHide = () => { if (this.dirty.size) void this.flush(); };

  /** One operation at a time, in order. */
  private queue(step: () => Promise<void>): Promise<void> {
    this.running = this.running.then(() => (this.stopped ? undefined : step())).catch(() => { /* offline: the next change or resume retries */ });
    return this.running;
  }

  private async pull(): Promise<void> {
    const response = await this.fetcher('/api/account/data', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const { docs } = await response.json() as { docs: Partial<Record<DocKind, Remote>> };
    this.lastPull = Date.now();
    for (const kind of DOC_KINDS) this.remote[kind] = docs[kind] ? { data: docs[kind]!.data, rev: docs[kind]!.rev } : null;
    const changed: DocKind[] = [];
    for (const kind of DOC_KINDS) if (await this.reconcile(kind)) changed.push(kind);
    if (changed.length) window.dispatchEvent(new CustomEvent(SYNCED, { detail: { kinds: changed } }));
  }

  private async push(): Promise<void> {
    const kinds = [...this.dirty];
    this.dirty.clear();
    for (const kind of kinds) await this.reconcile(kind);
  }

  /** Merge local with the last known account copy; write whichever side differs. True if local changed. */
  private async reconcile(kind: DocKind): Promise<boolean> {
    let localChanged = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remote = this.remote[kind] ?? null;
      const local = readLocal(kind);
      const merged = mergeDoc(kind, remote?.data ?? null, local);
      if (merged == null) return localChanged;
      if (!sameJson(merged, local)) { writeLocal(kind, merged); localChanged = true; }
      if (remote && sameJson(merged, remote.data)) return localChanged;
      const response = await this.fetcher('/api/account/data', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, baseRev: remote?.rev ?? 0, data: merged }),
        keepalive: JSON.stringify(merged).length < 60_000,
      });
      if (response.ok) {
        const { doc } = await response.json() as { doc: Remote };
        this.remote[kind] = { data: doc.data, rev: doc.rev };
        return localChanged;
      }
      if (response.status !== 409) return localChanged;
      const { current } = await response.json() as { current: Remote | null };
      this.remote[kind] = current ? { data: current.data, rev: current.rev } : null;
    }
    return localChanged;
  }
}
