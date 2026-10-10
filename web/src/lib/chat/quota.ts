/** Anonymous quota: three messages a UTC day, then ask them to sign in. */

export const ANON_DAILY_MESSAGES = 3;

export function anonDecision(deviceCount: number, ipCount: number, limit = ANON_DAILY_MESSAGES): 'ok' | 'sign-in' {
  if (!Number.isFinite(deviceCount) || !Number.isFinite(ipCount)) return 'sign-in';
  return deviceCount >= limit || ipCount >= limit ? 'sign-in' : 'ok';
}

/** Keys stored on AnonChatQuota. One row for the device, one for the IP. */
export function quotaKeys(deviceHash: string, ipHash: string): { device: string; ip: string } {
  return { device: `d:${deviceHash}`, ip: `i:${ipHash}` };
}
