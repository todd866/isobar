/** Convective lead for a METAR instrument row. The lead never ellipsizes. */

export interface ConvectiveCloud {
  hazard: '' | 'TS' | 'VCTS' | 'CB' | 'TCU';
  lead: string;
  rest: string;
}

const HAZARDS = new Set(['TS', 'VCTS', 'CB', 'TCU']);

function feet(code: string): string {
  if (code === '///') return '—';
  const value = Number(code) * 100;
  return Number.isFinite(value) ? value.toLocaleString('en-AU') : '—';
}

function layersOf(text: string): { amount: string; base: string; type: string }[] {
  const layers: { amount: string; base: string; type: string }[] = [];
  const pattern = /\b(FEW|SCT|BKN|OVC|VV)(\d{3}|\/{3})(CB|TCU)?\b/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    layers.push({ amount: match[1], base: match[2], type: match[3] ?? '' });
  }
  return layers;
}

function thunderstorm(token: string): '' | 'TS' | 'VCTS' | 'recent' {
  let body = token;
  let recent = false;
  let vicinity = false;
  if (body.startsWith('RE') && body.length > 2) {
    recent = true;
    body = body.slice(2);
  }
  if (body.startsWith('+') || body.startsWith('-')) body = body.slice(1);
  if (body.startsWith('VC')) {
    vicinity = true;
    body = body.slice(2);
  }
  body = body.replace(/^(MI|PR|BC|DR|BL|SH|FZ)/, '');
  if (!body.startsWith('TS')) return '';
  if (recent) return 'recent';
  return vicinity ? 'VCTS' : 'TS';
}

function hazardOf(raw: string): ConvectiveCloud['hazard'] {
  let ts = false;
  let vcts = false;
  let cb = false;
  let tcu = false;
  for (const token of raw.split(/\s+/)) {
    if (token === 'CB') cb = true;
    if (token === 'TCU') tcu = true;
    const kind = thunderstorm(token);
    if (kind === 'TS') ts = true;
    if (kind === 'VCTS') vcts = true;
    const layer = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/{3})(CB|TCU)?$/.exec(token);
    if (layer?.[3] === 'CB') cb = true;
    if (layer?.[3] === 'TCU') tcu = true;
  }
  if (ts) return 'TS';
  if (vcts) return 'VCTS';
  if (cb) return 'CB';
  if (tcu) return 'TCU';
  return '';
}

function splitDatum(cloud: string): { lead: string; rest: string } | null {
  const parts = cloud.split(' · ').map((part) => part.trim()).filter(Boolean);
  const leads = parts.filter((part) => /^(CB|TCU) /.test(part));
  if (!leads.length) return null;
  return {
    lead: leads.join(' · '),
    rest: parts.filter((part) => !/^(CB|TCU) /.test(part)).join(' · '),
  };
}

function fromLayers(raw: string): { lead: string; rest: string } {
  const layers = layersOf(raw);
  const named = layers.filter((layer) => layer.type === 'CB' || layer.type === 'TCU');
  named.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'CB' ? -1 : 1;
    const left = a.base === '///' ? Number.POSITIVE_INFINITY : Number(a.base);
    const right = b.base === '///' ? Number.POSITIVE_INFINITY : Number(b.base);
    return left - right;
  });
  const lead = named.map((layer) => `${layer.type} ${feet(layer.base)}`).join(' · ');
  const rest = layers
    .filter((layer) => layer.type !== 'CB' && layer.type !== 'TCU')
    .map((layer) => `${layer.amount}${layer.base}`)
    .join(lead ? ' · ' : '/');
  return { lead, rest };
}

/** Prefer the native cloud datum. A buried `FEW035CB` still comes out as `CB 3,500`. */
export function convectiveCloud(raw: string, cloud: string, hazard?: string): ConvectiveCloud {
  const known = hazard && HAZARDS.has(hazard) ? hazard as ConvectiveCloud['hazard'] : hazardOf(raw);
  const split = splitDatum(cloud) ?? (known ? fromLayers(raw) : null);
  if (!split?.lead) return { hazard: known, lead: '', rest: cloud };
  return { hazard: known, lead: split.lead, rest: split.rest };
}
