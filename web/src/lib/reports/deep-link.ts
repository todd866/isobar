/** Missing coordinates are not (0,0). Reject partial and empty pairs. */
export function reportPoint(params: URLSearchParams): {lat:number;lon:number} | null {
  const a=params.get('lat'), b=params.get('lon');
  if (!a?.trim() || !b?.trim()) return null;
  const lat=Number(a),lon=Number(b);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180 ? {lat,lon} : null;
}
