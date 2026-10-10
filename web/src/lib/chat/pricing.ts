/**
 * List-price USD estimates in the same shape as md3's model-pricing.
 * Opus 5.5 and Sonnet 5.5 match that file. Haiku 5.5 is $0.10 / $0.50 (prompts up to 100K tokens;
 * Isobar prompts stay far below that). The provider invoice is authoritative.
 * Cache tokens are not priced here: a reply that used them has unknown cost.
 */

export const CHAT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type PricedModel = (typeof CHAT_MODELS)[number];

const RATES: Record<PricedModel, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};

export function messageCostUsd(model: string, promptTokens: number | null, completionTokens: number | null): number | null {
  if (!CHAT_MODELS.includes(model as PricedModel) || promptTokens == null || completionTokens == null) return null;
  if (![promptTokens, completionTokens].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const rate = RATES[model as PricedModel];
  return (promptTokens * rate.in + completionTokens * rate.out) / 1_000_000;
}

export function modelFamily(model: string | null | undefined): 'opus' | 'sonnet' | 'haiku' | null {
  if (!model) return null;
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return null;
}
