export interface ReportResult { ok: boolean; line: string; reportId?: string }

/** One tap names a saved answer, never an email address or a replacement question. */
export async function emailQuestion(messageId: string, signal?: AbortSignal): Promise<ReportResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 10_000);
  try {
    const response = await fetch('/api/chat/report', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ messageId }), signal: controller.signal,
    });
    const body = await response.json() as Partial<ReportResult>;
    if ((!response.ok && response.status !== 409) || typeof body.ok !== 'boolean' || typeof body.line !== 'string'
      || (body.ok && typeof body.reportId !== 'string')) throw new Error('Report unavailable');
    return { ok: body.ok, line: body.line, ...(typeof body.reportId === 'string' ? { reportId: body.reportId } : {}) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
