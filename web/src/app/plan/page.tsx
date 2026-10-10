import { PageBar } from '@/components/PageBar';

export default function PlanPage() {
  return (
    <>
      <PageBar>
        <span className="text-sm font-medium">Plan</span>
      </PageBar>
      <div className="px-4">
        <div className="flex h-12 items-center gap-3" title="Worked flight plans are not in this version">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-[var(--md-on-surface-variant)]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M9 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-3" />
            <rect x="9" y="2" width="6" height="3" rx="1" />
          </svg>
          <span className="text-sm font-medium">Plan</span>
          <span className="ml-auto text-sm tabular-nums text-[var(--md-on-surface-variant)]">Later</span>
        </div>
      </div>
    </>
  );
}
