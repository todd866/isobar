/** Browser calls to Auth.js, without next-auth/react: CSRF token, then a form post
 * that answers with the next URL (X-Auth-Return-Redirect). */

export interface SessionUser { id: string; email: string | null }

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    const body = await response.json() as { user?: SessionUser } | null;
    return body?.user?.id ? body.user : null;
  } catch {
    return null;
  }
}

async function csrf(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { cache: 'no-store', credentials: 'same-origin' });
  return (await response.json() as { csrfToken: string }).csrfToken;
}

async function post(path: string, fields: Record<string, string>): Promise<{ status: number; url: URL | null }> {
  const body = new URLSearchParams({ ...fields, csrfToken: await csrf() });
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
    body,
  });
  let url: URL | null = null;
  try { url = new URL((await response.json() as { url: string }).url, location.origin); } catch { /* none */ }
  return { status: response.status, url };
}

export type SendResult = 'sent' | 'limited' | 'invalid' | 'failed';

export async function requestCode(email: string, callbackUrl: string): Promise<SendResult> {
  try {
    const { status, url } = await post('/api/auth/signin/email', { email, callbackUrl });
    const error = url?.searchParams.get('error');
    if (status === 429 || error === 'RateLimited') return 'limited';
    if (!error && status < 400) return 'sent';
    return error === 'EmailSignin' || error === 'Configuration' ? 'failed' : 'invalid';
  } catch {
    return 'failed';
  }
}

export async function signOutHere(): Promise<void> {
  await post('/api/auth/signout', { callbackUrl: location.href }).catch(() => undefined);
}

export async function deleteAccount(): Promise<boolean> {
  const response = await fetch('/api/account', { method: 'DELETE', credentials: 'same-origin' }).catch(() => null);
  return response?.status === 204;
}
