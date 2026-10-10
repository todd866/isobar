import 'server-only';
import { billingEnabled } from '../billing/policy';
import { db } from '../server/prisma';
import { reportService } from './service';
import { resendDelivery } from './email';
const cap = (value: string | undefined, fallback: number) => value && /^\d+$/.test(value) ? Math.min(Number(value), 10_000) : fallback;
export function reports() {
  return reportService(db(), {
    billingEnabled: billingEnabled(), now: () => new Date(), secret: process.env.AUTH_SECRET ?? '', ownerEmail: process.env.ISOBAR_OWNER_EMAIL ?? null,
    deliver: resendDelivery({ ...process.env, EMAIL_FROM: process.env.ISOBAR_REPORT_FROM ?? process.env.EMAIL_FROM }),
    replyTo: process.env.ISOBAR_REPORT_REPLY_TO ?? 'reports@isobar.md', senderIdentity: process.env.ISOBAR_REPORT_SENDER_IDENTITY ?? '',
    perUserCap: cap(process.env.ISOBAR_REPORT_USER_CAP, 10), globalCap: cap(process.env.ISOBAR_REPORT_GLOBAL_CAP, 100),
    inboundUserCap: cap(process.env.ISOBAR_REPORT_INBOUND_USER_CAP, 10), inboundGlobalCap: cap(process.env.ISOBAR_REPORT_INBOUND_GLOBAL_CAP, 200),
  });
}
