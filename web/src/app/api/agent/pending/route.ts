import { agentRoute } from '@/lib/agent/route';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request): Promise<Response> { return agentRoute('pending', request); }
