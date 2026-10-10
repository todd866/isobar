import 'server-only';
import { Prisma } from '@prisma/client';
import { publishedChart } from '@/lib/chat/data';
import { databaseConfigured, db } from '@/lib/server/prisma';
import { overAfter, record } from '@/lib/server/throttle';
import type { ConnectorDeps } from './handle';
import { connectorEvent, memoryLimit, type ConnectorUsage, type LimitVerdict } from './limits';

/** Database buckets when configured, otherwise the in-process window. Never stores the raw address. */
export async function limitConnector(ip: string): Promise<LimitVerdict> {
  if (!databaseConfigured()) return memoryLimit(ip);
  try {
    await record('connectorIp', ip);
    await record('connectorIpDay', ip);
    if (await overAfter('connectorIpDay', ip)) return 'day';
    if (await overAfter('connectorIp', ip)) return 'minute';
    return 'ok';
  } catch {
    return memoryLimit(ip);
  }
}

export async function logConnector(event: ConnectorUsage): Promise<void> {
  if (!databaseConfigured()) return;
  const safe = connectorEvent(event);
  try {
    await db().usageEvent.create({
      data: {
        userId: null,
        deviceId: safe.kind,
        at: new Date(),
        kind: safe.kind,
        payload: safe.payload as Prisma.InputJsonValue,
      },
    });
  } catch { /* the weather response still returns */ }
}

export function liveDeps(): ConnectorDeps {
  return {
    chart: publishedChart().chart,
    now: new Date(),
    limit: limitConnector,
    log: logConnector,
  };
}
