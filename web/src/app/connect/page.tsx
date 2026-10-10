import type { Metadata } from 'next';
import { PageBar } from '@/components/PageBar';
import { ConnectPanel } from './ConnectPanel';

export const dynamic = 'force-static';

export const metadata: Metadata = { title: 'Connect · Isobar' };

export default function ConnectPage() {
  return (
    <>
      <PageBar>
        <span className="text-[15px] font-semibold">Connect</span>
      </PageBar>
      <ConnectPanel />
    </>
  );
}
