export const ATTRIBUTION = 'ECMWF Open Data (CC BY 4.0). Open-Meteo (CC BY 4.0), including the UV index. Open-Meteo Marine (CC BY 4.0). Aviation weather: aviationweather.gov (US public domain). Coastline, lakes and places: Natural Earth (public domain). Close-zoom shorelines: OpenStreetMap via OpenFreeMap (ODbL). Summit elevations: national surveys and Natural Earth (public domain). Airports: OurAirports (public domain). Terrain: Mapterhorn (mapterhorn.com/attribution) from Copernicus GLO-30 (© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA) and national elevation models, including USGS 3DEP, Natural Resources Canada and Geoscience Australia (CC BY 4.0). Satellite imagery: NASA GIBS (public domain). ADSB.lol (ODbL).';

/** Sources and licences: on the map behind a small ⓘ, in full on the Download page. */
export function Attribution() {
  return <p data-attribution className="text-[11px] leading-4 text-[var(--md-on-surface-variant)]">{ATTRIBUTION}</p>;
}
