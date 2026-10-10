import type { Metadata } from 'next';
import { PageBar } from '@/components/PageBar';
import { LabMount } from './LabMount';
import '../../../../training/src/instruments/instruments.css';

export const metadata: Metadata = {
  title: 'Instrument Lab · Isobar',
  description: 'Interactive E6-B flight computer and aviation teaching instruments.',
};

export default function LabPage() {
  return (
    <>
      <PageBar>
        <span className="text-sm font-medium">Instrument Lab</span>
      </PageBar>
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-6">
        <LabMount />
      </div>
    </>
  );
}
