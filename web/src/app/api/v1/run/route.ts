import { handleRun } from '@/lib/connector/handle';
import { liveDeps } from '@/lib/connector/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleRun(request, liveDeps());
}
