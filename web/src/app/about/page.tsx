import fs from 'node:fs';
import path from 'node:path';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AboutBack } from './AboutBack';
import { HISTORICAL_SCENES } from '@/lib/historical-scenes';
import { KATRINA_MARINE } from '@/lib/historical-marine';
import { EVEREST_SOURCE } from '@/lib/everest';
import imagery from '@/lib/terrain/everest-imagery.json';

export const dynamic = 'force-static';
export const metadata = { title: 'About Isobar' };

const cc = 'https://creativecommons.org/licenses/by/4.0/';
const rows = [
  ['ECMWF Open Data', 'https://www.ecmwf.int/en/forecasts/datasets/open-data', 'CC BY 4.0', cc],
  ['Open-Meteo', 'https://open-meteo.com/', 'Weather and UV index · CC BY 4.0', cc],
  ['Open-Meteo Marine', 'https://open-meteo.com/en/docs/marine-weather-api', 'CC BY 4.0', cc],
  ['Bureau of Meteorology', 'https://www.bom.gov.au/', 'Copyright and terms', 'https://www.bom.gov.au/other/copyright.shtml'],
  ['aviationweather.gov', 'https://aviationweather.gov/', 'US public domain'],
  ['Mapterhorn', 'https://mapterhorn.com/attribution', 'Terrain · Copernicus GLO-30 and national elevation models'],
  ['Copernicus GLO-30', 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model', '© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA'],
  ['Geoscience Australia', 'https://www.ga.gov.au/', 'CC BY 4.0', cc],
  ['USGS 3DEP', 'https://www.usgs.gov/3d-elevation-program', 'National elevation models'],
  ['Natural Resources Canada', 'https://natural-resources.canada.ca/', 'National elevation models'],
  ['Natural Earth', 'https://www.naturalearthdata.com/about/terms-of-use/', 'Coastline, lakes, places and summit elevations · public domain'],
  ['OpenStreetMap', 'https://www.openstreetmap.org/copyright', 'Shorelines · ODbL'],
  ['OpenFreeMap / OpenMapTiles', 'https://openfreemap.org/', 'Water polygons', 'https://openmaptiles.org/'],
  ['OurAirports', 'https://ourairports.com/data/', 'Airports · public domain'],
  ['NASA GIBS', 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs', 'Satellite imagery · public domain'],
  ['ADSB.lol', 'https://www.adsb.lol/', 'ODbL', 'https://opendatacommons.org/licenses/odbl/1-0/'],
  ['Copernicus Sentinel-2 / ESA / Element84', imagery.stac_item, `${imagery.attribution} ${imagery.license}`],
  ['NASA Blue Marble', 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/', 'October 2004 surface · NASA media terms', 'https://www.nasa.gov/nasa-brand-center/images-and-media/'],
  ['NASA VTAD', 'https://science.nasa.gov/resource/international-space-station-3d-model/', 'ISS model · optimised mesh and textures; illustrative configuration'],
  ['CelesTrak', 'https://celestrak.org/', 'Orbital elements'],
  ['Satellite.js', 'https://github.com/shashwatak/satellite-js', 'Orbit propagation and 2019 reference · MIT'],
  ['Copernicus / ECMWF ERA5', 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels', 'Historical reanalysis', 'https://cds.climate.copernicus.eu/licences'],
  ['Everest expedition observations', EVEREST_SOURCE, 'Pugh · 1952–1953'],
  ['Everest ascent route', 'https://teara.govt.nz/en/interactive/28428/final-ascent-of-everest', 'Te Ara'],
  ['D-Day map', 'https://blogs.loc.gov/folklife/2023/06/vhp-collection-spotlight-joseph-vaghis-d-day-map/', 'Library of Congress'],
  ...HISTORICAL_SCENES.flatMap(scene => scene.provenance.sources.map(source => [source.title, source.url, scene.title])),
  ...KATRINA_MARINE.stations.filter(station => station.source_url).map(station => [`NDBC ${station.id}`, station.source_url!, 'Katrina buoy observations']),
  ...KATRINA_MARINE.satellites.map(picture => ['NASA MODIS', picture.source_url, `${picture.date} daily composite`]),
  ...KATRINA_MARINE.surge.map(mark => [mark.name, mark.source_url, 'Katrina storm surge']),
];
const uniqueRows = rows.filter((row, index) => rows.findIndex(other => other.join('|') === row.join('|')) === index);

export default function AboutPage() {
  // The app's canonical version, resolved while this static page is built.
  const plist = fs.readFileSync(path.resolve(process.cwd(), '../Info.plist'), 'utf8');
  const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? 'Unavailable';
  return <>
    <header className="about-bar"><AboutBack /><h1>About Isobar</h1><ThemeToggle /></header>
    <div data-about-page className="mx-auto w-full max-w-3xl px-4 py-2 text-[var(--md-on-surface)]">
      <div className="about-row"><span>Version</span><span data-app-version>{version}</span></div>
      {uniqueRows.map(([name, href, detail, licence], index) => <div className="about-row" key={`${href}-${index}`}>
        <a href={href} target="_blank" rel="noreferrer">{name}</a>
        {licence ? <a href={licence} target="_blank" rel="noreferrer">{detail}</a> : <span>{detail}</span>}
      </div>)}
      <div className="about-row"><span>Historical paper texture</span><span>AI-generated</span></div>
    </div>
  </>;
}
