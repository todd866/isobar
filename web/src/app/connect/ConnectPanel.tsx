'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { MCP_PATH, OPENAPI_PATH } from '@/lib/connector/paths';

const ROWS = [
  { id: 'mcp', label: 'MCP', path: MCP_PATH, copy: 'MCP URL', title: 'Streamable HTTP. No account.' },
  { id: 'openapi', label: 'OpenAPI', path: OPENAPI_PATH, copy: 'OpenAPI URL', title: 'GPT Action schema. Open-Meteo profiles are non-commercial.' },
  { id: 'chatgpt', label: 'ChatGPT', text: 'Actions → Import OpenAPI URL', title: 'Create a GPT → Configure → Actions → Import from URL. An Apps SDK connector pastes the MCP URL.' },
  { id: 'claude', label: 'Claude', text: 'Settings → Connectors → paste MCP URL', title: 'Add a custom connector, then paste the MCP URL.' },
] as const;

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function RowIcon({ id }: { id: (typeof ROWS)[number]['id'] }) {
  if (id === 'mcp') {
    return (
      <Mark>
        <path d="M9 7v3" />
        <path d="M15 7v3" />
        <path d="M7 10h10v3a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3v-3z" />
        <path d="M12 16v4" />
      </Mark>
    );
  }
  if (id === 'openapi') {
    return (
      <Mark>
        <path d="M7 3.5h7l5 5V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
        <path d="M14 3.5V9h5.5" />
      </Mark>
    );
  }
  if (id === 'chatgpt') {
    return (
      <Mark>
        <path d="M5 6.5h14v8.5H9l-4 3.5v-12z" />
      </Mark>
    );
  }
  return (
    <Mark>
      <path d="M12 3.2 14.1 9H20l-4.7 3.5L17 18.2 12 14.8 7 18.2l1.7-5.7L4 9h5.9L12 3.2z" />
    </Mark>
  );
}

function UrlValue({ value }: { value: string }) {
  const match = /^(https?:\/\/[^/]+)(.*)$/.exec(value);
  if (!match) return <>{value}</>;
  const [, host, rest] = match;
  const bits = rest.split('/').filter(Boolean);
  return (
    <>
      {host}
      {bits.map((bit, index) => <span key={`${bit}-${index}`}>/<wbr />{bit}</span>)}
    </>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const id = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={done ? `Copied ${label}` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setDone(true)).catch(() => setDone(false));
      }}
      className="h-11 min-w-[5.75rem] rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface-container-lowest)] px-3 text-[15px] font-semibold text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-primary)]"
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function ConnectPanel() {
  const [origin, setOrigin] = useState('https://isobar.md');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col px-4 text-[var(--md-on-surface)]">
      {ROWS.map((row) => {
        const value = 'path' in row ? `${origin}${row.path}` : row.text;
        return (
          <div
            key={row.id}
            data-connect-row={row.id}
            className="grid min-h-14 grid-cols-[1.75rem_5.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-[var(--md-outline-soft)] py-3 max-md:grid-cols-[1.75rem_minmax(0,1fr)_auto]"
          >
            <span className="text-[var(--md-on-surface)]"><RowIcon id={row.id} /></span>
            <span className="text-[13px] font-medium text-[var(--md-on-surface-variant)]">{row.label}</span>
            <span
              data-connect-value={row.id}
              title={row.title}
              className="min-w-0 text-[22px] font-medium leading-snug [overflow-wrap:anywhere] max-md:col-span-3 max-md:row-start-2"
            >
              {'path' in row ? <UrlValue value={value} /> : value}
            </span>
            {'copy' in row
              ? <span className="justify-self-end max-md:col-start-3 max-md:row-start-1"><CopyButton label={row.copy} value={value} /></span>
              : <span className="max-md:hidden" />}
          </div>
        );
      })}
    </div>
  );
}
