import type { Metadata, Viewport } from 'next';
import { PageBar } from '@/components/PageBar';
import { E6BMount } from './E6BMount';

export const metadata: Metadata = {
  title: 'E6-B flight computer · Isobar',
  description: 'An exact, interactive ASA E6-B flight computer: both sides, guided lessons from the manual, and exam-style practice.',
};

// Draw under the home indicator and notch; the shell and tab bar pad by the safe-area insets.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function E6BPage() {
  return (
    <>
      {/* On a phone the tab bar already names the page; the instrument gets the row. */}
      <PageBar className="e6b-pagebar hidden md:flex">
        <span className="text-sm font-medium">E6-B flight computer</span>
      </PageBar>
      <div className="px-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4 md:pt-3 md:pb-3 [@media(min-width:768px)_and_(max-height:500px)]:pt-2 [@media(min-width:768px)_and_(max-height:500px)]:pb-0">
        <E6BMount />
      </div>
    </>
  );
}
