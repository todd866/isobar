import { USAGE_NOTICE } from '@/lib/usage/events';

/** One line, on sign-in and in the chat panel. */
export function UsageNotice({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[12px] leading-snug text-[var(--md-on-surface-variant)] [&_a]:font-semibold [&_a]:text-[var(--md-primary)] ${className}`} data-usage-notice>
      {USAGE_NOTICE}
      {' · '}
      <a href="/privacy">Privacy</a>
    </p>
  );
}
