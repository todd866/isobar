import type { AgentApi, PendingMessage, ReplyRequest, ReportJob, MaintenanceTask } from './types';

export function validPending(value: unknown): PendingMessage | null {
  if (value === null) return null;
  const row = value as Partial<PendingMessage>;
  const nullableText = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 1000);
  if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 128 || typeof row.question !== 'string' || row.question.length > 4000 ||
      typeof row.leaseId !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.leaseId) || typeof row.leaseUntil !== 'string' || !Number.isFinite(Date.parse(row.leaseUntil)) ||
      !Array.isArray(row.thread) || row.thread.length > 24 || row.thread.some((message) => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 3000) ||
      !row.user || !nullableText(row.user.level) || !nullableText(row.user.goal) || JSON.stringify(row.context ?? null).length > 30_000) throw new Error('invalid pending response');
  if (row.type !== undefined && row.type !== 'chat' && row.type !== 'report') throw new Error('invalid pending response');
  if (row.type === 'report') {
    const report = row.report as Partial<ReportJob> | undefined;
    if (!report || !Number.isFinite(Date.parse(report.dueAt ?? '')) || typeof report.timezone !== 'string' || report.timezone.length > 100 ||
        !['once', 'recurring'].includes(report.kind ?? '') || typeof report.instructions !== 'string' || report.instructions.length > 20_000 ||
        !Array.isArray(report.places) || report.places.length > 32 || report.places.some((place) => !place || typeof place.name !== 'string' || place.name.length > 200 ||
          typeof place.lat !== 'number' || !Number.isFinite(place.lat) || place.lat < -90 || place.lat > 90 || typeof place.lon !== 'number' || !Number.isFinite(place.lon) || place.lon < -180 || place.lon > 180)) throw new Error('invalid report pending response');
  }
  return row as PendingMessage;
}

export function apiClient(url: string, token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000, identity = { host: 'isobar', role: 'primary' as 'primary' | 'standby', standbyMs: 90_000 }): AgentApi {
  const parsed = new URL(url);
  const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !local) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('ISOBAR_URL must be an HTTPS origin');
  async function call(path: string, payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error('agent API timeout')); }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(`${parsed.origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload), redirect: 'error', signal: controller.signal });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`agent API ${response.status}`); }
        reader = response.body?.getReader();
        if (!reader) throw new Error('empty agent response');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 128_000) { await reader.cancel(); throw new Error('agent response too large'); }
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      })()]);
    } finally { clearTimeout(timer); reader?.releaseLock(); }
  }
  return {
    async heartbeat(runtime, version) { await call('/api/agent/heartbeat', { host: identity.host, role: identity.role, runtime, version }); },
    async health() { return call('/api/agent/health', {}); },
    async pending() { return validPending(await call('/api/agent/claim', { host: identity.host, role: identity.role, standbyMs: identity.standbyMs })); },
    async reply(request: ReplyRequest) { await call('/api/agent/reply', { ...request, host: identity.host }); },
    async release(id: string, leaseId: string) { await call('/api/agent/release', { id, leaseId, host: identity.host }); },
    async reportClaim() { return validPending(await call('/api/agent/reports', { action: 'claim', host: identity.host, role: identity.role, standbyMs: identity.standbyMs })); },
    async reportReady(request: ReplyRequest) { await call('/api/agent/reports', { action: 'ready', host: identity.host, ...request }); },
    async reportRelease(id: string, leaseId: string) { await call('/api/agent/reports', { action: 'release', host: identity.host, id, leaseId }); },
    async reportMaintenance() {
      const value = await call('/api/agent/reports', { action: 'maintenance', host: identity.host, role: identity.role, standbyMs: identity.standbyMs });
      if (value === null) return null;
      const row = value as Partial<MaintenanceTask>;
      if (typeof row.id !== 'string' || typeof row.leaseId !== 'string' || typeof row.message !== 'string' || row.message.length > 300) throw new Error('invalid report maintenance response');
      return row as MaintenanceTask;
    },
    async reportNotified(id: string, leaseId: string, channel: 'text-ian' | 'email') { await call('/api/agent/reports', { action: 'notified', host: identity.host, id, leaseId, channel }); },
  };
}
