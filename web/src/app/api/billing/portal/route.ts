import { billingPost } from '@/lib/billing/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => billingPost(request, 'portal');
