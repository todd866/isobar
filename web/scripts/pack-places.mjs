#!/usr/bin/env node
/**
 * Packs Natural Earth 1:10m populated places (public domain) for the web map's
 * town names: [name, lat, lon, rank, region], most important first.
 *
 * rank is Natural Earth's min_zoom (smaller shows sooner), as in the Mac's
 * tools/pack-places.py. region is the short admin code that tells two towns of
 * one name apart ("Vancouver WA"): the state or province postal code in the
 * US, Canada and Australia, otherwise the ISO country code.
 *
 *   node scripts/pack-places.mjs ne_10m_populated_places_simple.geojson public/places/world-places.json
 */
import fs from 'node:fs';

const STATES = {
  US: {
    Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
    Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
    Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
    Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
    Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
    'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA',
    'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
    Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  },
  CA: {
    Alberta: 'AB', 'British Columbia': 'BC', Manitoba: 'MB', 'New Brunswick': 'NB', 'Newfoundland and Labrador': 'NL',
    'Northwest Territories': 'NT', 'Nova Scotia': 'NS', Nunavut: 'NU', Ontario: 'ON', 'Prince Edward Island': 'PE',
    Québec: 'QC', Quebec: 'QC', Saskatchewan: 'SK', Yukon: 'YT',
  },
  AU: {
    'New South Wales': 'NSW', Victoria: 'VIC', Queensland: 'QLD', 'Western Australia': 'WA', 'South Australia': 'SA',
    Tasmania: 'TAS', 'Northern Territory': 'NT', 'Australian Capital Territory': 'ACT', 'Jervis Bay Territory': 'JBT',
  },
};

const [source, output] = process.argv.slice(2);
if (!source || !output) {
  console.error('usage: pack-places.mjs <ne_10m_populated_places_simple.geojson> <output.json>');
  process.exit(2);
}
const rows = [];
for (const feature of JSON.parse(fs.readFileSync(source, 'utf8')).features) {
  const p = feature.properties;
  const name = p.name || p.nameascii;
  const lat = p.latitude, lon = p.longitude, rank = p.min_zoom;
  if (!name || ![lat, lon, rank].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
  const country = typeof p.iso_a2 === 'string' && /^[A-Z]{2}$/.test(p.iso_a2) ? p.iso_a2 : '';
  const region = STATES[country]?.[p.adm1name] ?? country;
  rows.push([name, Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, Math.round(rank * 10) / 10, region, -(p.pop_max || 0)]);
}
rows.sort((a, b) => a[3] - b[3] || a[5] - b[5]);
fs.mkdirSync(new URL('.', `file://${output.startsWith('/') ? output : `${process.cwd()}/${output}`}`).pathname, { recursive: true });
fs.writeFileSync(output, JSON.stringify(rows.map((row) => row.slice(0, 5))));
console.log(`${rows.length} places -> ${output}`);
