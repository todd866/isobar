import { headers } from 'next/headers';
import { MapExperience } from '@/components/MapExperience';
import { geoFromHeaders } from '@/lib/request-geo';

export default async function MapPage() {
  const initialGeo = geoFromHeaders(await headers());
  return <MapExperience initialGeo={initialGeo} />;
}
