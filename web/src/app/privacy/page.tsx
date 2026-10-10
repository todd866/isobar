import { PageBar } from '@/components/PageBar';

export const dynamic = 'force-static';

const ROWS: { id: string; label: string; value: string }[] = [
  { id: 'what', label: 'What', value: 'Questions, replies, grades, map use, Train answers' },
  { id: 'why', label: 'Why', value: 'Improve Isobar · Australian Privacy Principles' },
  { id: 'where', label: 'Where', value: 'Private database · nightly copy on the owner\'s Mac' },
  { id: 'kept', label: 'How long', value: 'While the account exists' },
  { id: 'download', label: 'Download', value: 'Ask from the account' },
  { id: 'delete', label: 'Delete', value: 'Delete account removes your chat and anonymises use' },
  { id: 'billing', label: 'Billing', value: 'Stripe holds billing contact/address, tax IDs, payment method and invoices. Isobar retains customer and subscription IDs, status and period only; card details never touch Isobar servers.' },
  { id: 'billing-delete', label: 'Billing delete', value: 'Deleting your account cancels its subscription. Stripe may retain invoice records.' },
];

export default function PrivacyPage() {
  return (
    <>
      <PageBar>
        <span className="text-[15px] font-semibold">Privacy</span>
      </PageBar>
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-2 text-[var(--md-on-surface)]">
        {ROWS.map((row) => (
          <div key={row.id} data-privacy-row={row.id} className="grid min-h-11 grid-cols-[6.5rem_1fr] items-baseline gap-3 border-b border-[var(--md-outline-soft)] py-2 text-[15px]">
            <span className="text-[13px] font-medium text-[var(--md-on-surface-variant)]">{row.label}</span>
            <span>{row.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}
