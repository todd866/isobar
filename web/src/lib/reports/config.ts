export interface ReportsConfig {
  enabled: boolean;
  senderIdentity: string;
}

/** Reports stay dark until delivery, auth, database and sender identity are configured. */
export function reportsConfig(env: NodeJS.ProcessEnv = process.env): ReportsConfig {
  const senderIdentity = env.ISOBAR_REPORT_SENDER_IDENTITY?.trim() ?? '';
  const from = (env.ISOBAR_REPORT_FROM ?? env.EMAIL_FROM)?.trim() ?? '';
  const enabled = env.ISOBAR_REPORTS_ENABLED === '1'
    && Boolean(env.AUTH_SECRET?.trim())
    && Boolean(env.ISOBAR_OWNER_EMAIL?.trim())
    && Boolean(env.DATABASE_URL?.trim())
    && Boolean(env.RESEND_API_KEY?.trim())
    && Boolean(from)
    && Boolean(senderIdentity);
  return { enabled, senderIdentity };
}

export function reportsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return reportsConfig(env).enabled;
}
