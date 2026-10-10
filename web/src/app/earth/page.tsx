import type { Metadata } from 'next';
import { EarthExperience } from './EarthExperience';
import './earth.css';
export const metadata: Metadata = { title: 'Earth · Isobar', robots: { index: false, follow: false } };
export default function EarthPage() { return <EarthExperience />; }
