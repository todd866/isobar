import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOrbitSource } from '@/lib/earth-orbit';

export const dynamic = 'force-dynamic';
// Never polls CelesTrak per visitor. An explicit ingestion tool publishes a bounded file.
export async function GET() {
  try {
    const text = await readFile(path.join(process.cwd(), 'public/data/earth/iss.json'), 'utf8');
    if (text.length > 32_768) throw new Error('Oversized orbit');
    const source = parseOrbitSource(JSON.parse(text));
    if (source.kind !== 'elements') throw new Error('Current elements required');
    return Response.json(source, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Current ISS elements unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
