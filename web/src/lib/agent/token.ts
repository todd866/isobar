import { createHmac, randomBytes } from 'node:crypto';

export const TOKEN_PATTERN = /^isb_agent_[A-Za-z0-9_-]{43}$/;
export type AgentScope = 'owner' | 'user';
export interface AgentPrincipal { id: string; userId: string; scope: AgentScope }
export interface TokenRecord extends AgentPrincipal { email: string | null; revokedAt: Date | null }

export function hashAgentToken(token: string, secret: string): string {
  if (!secret) throw new Error('AUTH_SECRET is required');
  return createHmac('sha256', secret).update('isobar-agent\0').update(token).digest('hex');
}

/** Call only from the operator's script. Never log the return value elsewhere. */
export function mintAgentToken(secret: string): { token: string; hashedToken: string } {
  const token = `isb_agent_${randomBytes(32).toString('base64url')}`;
  return { token, hashedToken: hashAgentToken(token, secret) };
}

/** An owner token belongs to the configured account, not its plus-address aliases. */
export function exactOwner(email: string | null | undefined, ownerEmail: string | null | undefined): boolean {
  return !!email && !!ownerEmail?.trim() && email.trim().toLowerCase() === ownerEmail.trim().toLowerCase();
}
