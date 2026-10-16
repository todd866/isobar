import type { Page } from '@playwright/test';

// Archive fixture exercises the same renderer even when public history assets are absent.
export async function historyRoutes(page: Page) {
  const coast = Buffer.alloc(26);
  coast.write('OCST'); coast.writeUInt16LE(1, 4); coast.writeUInt16LE(1, 6); coast.writeUInt16LE(4, 8);
  [[-5, 45], [5, 45], [5, 55], [-5, 55]].forEach(([lon, lat], i) => { coast.writeInt16LE(lon * 100, 10 + i * 4); coast.writeInt16LE(lat * 100, 12 + i * 4); });
  const dates = ['1944-06-05', '1944-06-06'];
  const times = dates.flatMap(day => Array.from({length:24}, (_,h) => `${day}T${String(h).padStart(2,'0')}:00Z`));
  await page.route('**/history/**', route => {
    const name = new URL(route.request().url()).pathname;
    if(name.endsWith('world-coast.bin')) return route.fulfill({body:coast,contentType:'application/octet-stream'});
    if(name.endsWith('catalog.json')) return route.fulfill({json:{schema_version:1,collections:[{id:'dday',title:'D-Day',manifest:'/history/dday-manifest.json',days:dates.map(date=>({date,complete:true}))}]}});
    if(name.endsWith('dday-manifest.json')) return route.fulfill({json:{weather:'/history/dday.json'}});
    if(name.endsWith('dday.json')) return route.fulfill({json:{schema_version:1,product:'isobar-historical-weather',event:{id:'dday'},model:'ERA5',units:{pressure_msl:'hPa',u:'knots',v:'knots'},grid:{nx:4,ny:3,longitudes:[-180,-90,0,90],latitudes:[90,0,-90],step_degrees:90},times,frames:times.map((time,h)=>({time,pressure_msl:Array.from({length:12},(_,i)=>980+i*4+h),u:Array(12).fill(10),v:Array(12).fill(4)}))}});
    return route.continue();
  });
}
