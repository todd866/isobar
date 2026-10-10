import { handleAerodrome } from '@/lib/connector/handle';
import { liveDeps } from '@/lib/connector/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ icao: string }> }): Promise<Response> {
  const { icao } = await context.params;
  return handleAerodrome(request, icao, liveDeps());
}
