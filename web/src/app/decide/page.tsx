import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Decide } from '@/components/od/Decide';
import '@/components/od/desk.css';

export const metadata: Metadata = { title: 'Operational Decision · Isobar' };
export default function DecidePage() {
  return <Suspense fallback={null}><Decide /></Suspense>;
}
