/** Read before parsing, bounded even for chunked webhook/agent requests. */
export async function readBody(request: Request, maximum = 32_768): Promise<string> {
  const reader = request.body?.getReader(); if (!reader) throw new Error('body');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > maximum) { await reader.cancel(); throw new Error('body'); } chunks.push(part.value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
export const reportJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control':'private, no-store', 'referrer-policy':'no-referrer' } });
