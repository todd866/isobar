import { Attribution } from '@/components/Attribution';
import fs from 'node:fs';
import path from 'node:path';
import { PageBar } from '@/components/PageBar';
import { downloadHref, type ReleaseFile } from '@/lib/release';

export const dynamic = 'force-static';

function readRelease(): (ReleaseFile & { label?: string }) | null {
  try {
    const file = path.join(process.cwd(), 'release.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseFile;
  } catch {
    return null;
  }
}

export default function DownloadPage() {
  const release = readRelease();
  const href = downloadHref(release);
  return (
    <>
      <PageBar>
        <span className="text-sm font-semibold">Isobar for Mac</span>
      </PageBar>
      <main data-download-page className="download-page mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Isobar</h1>
          <p className="text-sm text-[var(--md-on-surface-variant)]">Weather worldwide, with the latest forecast available offline.</p>
        </div>
        {href ? (
          <a href={href} className="grid h-12 place-items-center rounded-lg bg-[var(--md-primary)] text-sm font-medium text-[var(--md-on-primary)]" download>
            Download Isobar for Mac
          </a>
        ) : (
          <button type="button" disabled className="h-12 rounded-lg bg-[var(--md-surface-container-high)] text-sm font-medium text-[var(--md-on-surface-variant)]">
            Download unavailable
          </button>
        )}
        <p className="text-xs text-[var(--md-on-surface-variant)]">{release?.label ?? 'Apple silicon (M1 or newer) · macOS 15+'}</p>
        <nav className="flex gap-4 text-sm" aria-label="Mac release links">
          <a className="text-[var(--md-primary)] underline" href="https://github.com/todd866/isobar/blob/main/docs/install.md">Installation guide</a>
          <a className="text-[var(--md-primary)] underline" href="https://github.com/todd866/isobar">Source</a>
        </nav>
        <Attribution />
      </main>
    </>
  );
}
