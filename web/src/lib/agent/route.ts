import 'server-only';
import { db } from '../server/prisma';
import { clientIp, overAfter, record } from '../server/throttle';
import { agentJson, postAgent, type AgentAction } from './service';
import { prismaAgentStore } from './prisma-store';

export async function agentRoute(action: AgentAction, request: Request): Promise<Response> {
  try {
    return await postAgent(action, request, {
      secret: process.env.AUTH_SECRET ?? '', ownerEmail: process.env.ISOBAR_OWNER_EMAIL ?? null,
      now: () => new Date(), store: prismaAgentStore(db(), process.env.ISOBAR_OWNER_EMAIL ?? null),
      limited: async (request, tokenId) => {
        const name = tokenId ? 'agentToken' : 'agentIp';
        const key = tokenId ?? clientIp(request);
        await record(name, key);
        return overAfter(name, key);
      },
    });
  } catch {
    // Database errors can contain private values. Never echo or log the body.
    return agentJson({ error: 'unavailable' }, 503);
  }
}
