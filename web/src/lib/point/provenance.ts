/**
 * One reading's own forecast identity: source, model and cycle.
 * A missing cycle is "latest at fetch time", never another product's run.
 */

const MODEL_LABEL: Record<string, string> = {
  ecmwf_ifs025: 'IFS 0.25°',
  ecmwf_ifs: 'IFS',
};

export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'IFS 0.25°';
  return MODEL_LABEL[model] ?? model;
}

function normalizeRun(run: string): string {
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(run);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`;
  return /[zZ]|[+-]\d\d:?\d\d$/.test(run) ? run : `${run}Z`;
}

/** Day and cycle hour, UTC: "08 00Z". A fetch time with minutes keeps them. */
export function forecastStamp(run: string): string | null {
  const ms = Date.parse(normalizeRun(run));
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  if (date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) return `${day} ${hour}Z`;
  return `${day} ${hour}:${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

export interface ForecastIdentity {
  source?: string | null;
  model?: string | null;
  run: string;
  /** False when `run` is the fetch time because no cycle was named. */
  cycle?: boolean;
}

/** One short line: "IFS 0.25° · 08 00Z", or "IFS 0.25° · latest 08 16:11Z". */
export function forecastRunLabel(input: ForecastIdentity): string {
  const model = modelLabel(input.model);
  const stamp = forecastStamp(input.run);
  if (input.cycle === false) return stamp ? `${model} · latest ${stamp}` : `${model} · latest`;
  return stamp ? `${model} · ${stamp}` : model;
}

/** Source beside the line. At most 60 characters; no instructions. */
export function forecastRunTitle(input: ForecastIdentity): string {
  const source = input.source || 'ECMWF';
  const text = input.cycle === false ? `${source} · latest at fetch` : `${source} · ${forecastRunLabel(input)}`;
  return text.length <= 60 ? text : text.slice(0, 60);
}

/** Source, run and the valid time of the reading. At most 60 characters. */
export function readingTitle(input: ForecastIdentity, valid: string | null): string {
  const base = forecastRunTitle(input);
  const stamp = valid ? forecastStamp(valid) : null;
  const text = stamp ? `${base} · valid ${stamp}` : base;
  return text.length <= 60 ? text : base;
}
