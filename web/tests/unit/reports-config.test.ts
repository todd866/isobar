import { describe, expect, it } from 'vitest';
import { reportsConfig } from '../../src/lib/reports/config';

const ready = {
  ISOBAR_REPORTS_ENABLED: '1',
  AUTH_SECRET: 'auth-secret',
  ISOBAR_OWNER_EMAIL: 'owner@example.test',
  DATABASE_URL: 'postgres://db.example.test/isobar',
  RESEND_API_KEY: 'resend-key',
  EMAIL_FROM: 'Isobar <reports@example.test>',
  ISOBAR_REPORT_SENDER_IDENTITY: 'Isobar · Perth WA',
};

describe('reports rollout configuration', () => {
  it('requires the explicit flag and complete delivery identity', () => {
    expect(reportsConfig(ready).enabled).toBe(true);
    expect(reportsConfig({ ...ready, ISOBAR_REPORTS_ENABLED: 'true' }).enabled).toBe(false);
    expect(reportsConfig({ ...ready, ISOBAR_REPORT_SENDER_IDENTITY: '' }).enabled).toBe(false);
  });

  it.each(['AUTH_SECRET', 'ISOBAR_OWNER_EMAIL', 'DATABASE_URL', 'RESEND_API_KEY', 'EMAIL_FROM'])('stays disabled without %s', (key) => {
    const env: NodeJS.ProcessEnv = { ...ready };
    delete env[key];
    expect(reportsConfig(env).enabled).toBe(false);
  });

  it('allows the report-specific from address to satisfy mail configuration', () => {
    const env = { ...ready, EMAIL_FROM: '', ISOBAR_REPORT_FROM: 'Reports <reports@example.test>' };
    expect(reportsConfig(env).enabled).toBe(true);
  });
});
