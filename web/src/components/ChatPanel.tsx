'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useAccount } from './Account';
import { emailQuestion } from '@/lib/reports/client';
import { archiveAction, fetchThread, hasPendingSlow, mergeSlowEntries, readChatStream, type ChatEntry } from '@/lib/chat/thread-client';
import { answerFocus, linkify } from '@/lib/chat/links';
import { currentConversation, placeKey } from '@/lib/chat/topic';
import { LINES, coordChip, lensChip, modelLabel, utcChip, type ChatAnchors, type ChatContext } from '@/lib/chat/types';
import { POINT_SIDE_QUERY, useMapSheet } from './MapSheet';
import styles from './ChatPanel.module.css';

export function ChatButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Ask Isobar"
      title="Ask Isobar"
      aria-pressed={open}
      data-chat-button
      onClick={onClick}
      className={`flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[14px] font-medium ${open ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" d="M5 6.5h14v9H8.5L5 18.5z" />
      </svg>
      <span>Ask</span>
    </button>
  );
}

function ArchiveMark() {
  return (
    <span className={styles.archive} data-archive title="Archive">
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path fill="none" stroke="currentColor" strokeWidth="1.6" d="M4 7h16v11H4zM4 7l2-3h12l2 3M9 12h6" />
      </svg>
      <span className="sr-only">Archive</span>
    </span>
  );
}

type Entry = ChatEntry & { upgrade?: boolean };

let entryId = 1;

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLElement | null>;
  context: () => ChatContext;
  onPlace: (lat: number, lon: number) => void;
  onTime: (timeUtc: string) => void;
  onOpen?: () => void;
  onAnchor?: (anchor: { text: string; lat: number; lon: number }) => void;
}

export function ChatPanel(props: ChatPanelProps) {
  const { user, ready } = useAccount();
  // Changing accounts unmounts all private state, including late async work.
  return <ChatConversation key={user?.id ?? 'signed-out'} {...props} accountId={user?.id ?? null} ready={ready} />;
}

function ChatConversation({ open, onClose, onOpen, onAnchor, anchorRef, panelRef, context, onPlace, onTime, accountId, ready }:
  ChatPanelProps & { accountId: string | null; ready: boolean }) {
  const { setOpen: openAccount } = useAccount();
  const { desktop, anchor } = useMapSheet(anchorRef, POINT_SIDE_QUERY);
  const keyboard = useKeyboardView();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [showEarlier, setShowEarlier] = useState(false);
  // Learn can open without a map place. Only this open panel's local exchange
  // gets a temporary identity; legacy unknown server rows never join it.
  const [unplacedTopic, setUnplacedTopic] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<Record<string, boolean>>({});
  const [archiveNotice, setArchiveNotice] = useState(false);
  const [opened, setOpened] = useState(open);
  const revealArchiveRef = useRef<string | null>(null);
  const completedArchiveRef = useRef<string | null>(null);
  const openRef = useRef(open); openRef.current = open;
  const onAnchorRef = useRef(onAnchor); onAnchorRef.current = onAnchor;
  const contextRef = useRef(context); contextRef.current = context;
  const actionsRef = useRef(new Set<AbortController>());
  useEffect(() => () => {
    lifecycleRef.current += 1;
    sendAbortRef.current?.abort();
    for (const controller of actionsRef.current) controller.abort();
  }, []);
  useEffect(() => { if (open) { setOpened(true); setArchiveNotice(false); } }, [open]);
  const inputRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const lifecycleRef = useRef(0);
  const sendAbortRef = useRef<AbortController | null>(null);
  const localSendRef = useRef<{ mine: number; reply: number } | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const chips = open ? context() : null;
  const topic = placeKey(chips);
  const conversation = open ? currentConversation(entries, { placeKey: topic ?? unplacedTopic, createdAt: new Date() }) : [];
  const hasEarlier = conversation.length < entries.length;
  const visibleEntries = showEarlier ? entries : conversation;
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    setShowEarlier(open && !!revealArchiveRef.current);
    setUnplacedTopic(null);
    followRef.current = true;
  }, [open, topic]);
  useLayoutEffect(() => {
    const log = logRef.current;
    const archive = log && revealArchiveRef.current
      ? log.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(revealArchiveRef.current)}"]`) : null;
    if (archive) {
      archive.scrollIntoView({ block: 'nearest' });
      followRef.current = false;
      revealArchiveRef.current = null;
    } else if (log && followRef.current) log.scrollTop = log.scrollHeight;
  }, [entries, open, showEarlier, visibleEntries.length]);
  const [chrome, setChrome] = useState(122);
  const [contentHeight, setContentHeight] = useState(0);
  const hasContent = visibleEntries.length > 0 || unavailable;
  const available = anchor ? anchor.bottom - anchor.top : 0;
  // The sheet is the context row and the input (the privacy notice lives in the ☰ menu). A status
  // line or a reply adds its own height. The log does not flex-fill, so an
  // empty middle never opens the sheet. Replies then grow it up to 65% of the map.
  const cap = anchor ? Math.max(chrome, available * 0.65) : chrome;
  const wanted = chrome + (hasContent ? contentHeight : 0);
  const height = Math.min(Math.max(wanted, 120), cap);
  useLayoutEffect(() => {
    if (desktop) return;
    const root = conversationRef.current;
    if (!root) return;
    const measure = () => {
      const bar = root.querySelector(`.${styles.bar}`) as HTMLElement | null;
      const form = root.querySelector(`.${styles.form}`) as HTMLElement | null;
      const notice = root.querySelector('[data-usage-notice]') as HTMLElement | null;
      const log = logRef.current;
      const shell = Math.ceil((bar?.offsetHeight ?? 0) + (form?.offsetHeight ?? 0) + (notice?.offsetHeight ?? 0));
      const body = log && hasContent && getComputedStyle(log).display !== 'none' ? log.scrollHeight : 0;
      setChrome((old) => (shell > 0 && old !== shell ? shell : old));
      setContentHeight((old) => (Math.abs(old - body) < 0.5 ? old : body));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [root.querySelector(`.${styles.bar}`), root.querySelector(`.${styles.form}`), root.querySelector('[data-usage-notice]'), logRef.current]) {
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [desktop, entries, showEarlier, unavailable, draft, anchor, hasContent, open]);

  const positioned = desktop || !!anchor;
  useEffect(() => {
    if (!open || !positioned) return;
    if (desktop) inputRef.current?.focus({ preventScroll: true });
    else conversationRef.current?.focus({ preventScroll: true });
  }, [open, positioned, desktop]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    let cancel = false;
    void fetch('/api/chat').then(async (response) => {
      if (cancel) return;
      if (response.status === 503) {
        const body = await response.json().catch(() => null) as { unavailable?: boolean } | null;
        if (!cancel && body?.unavailable) setUnavailable(true);
        return;
      }
      setUnavailable(false);
    }).catch(() => { if (!cancel) setUnavailable(true); });
    return () => {
      cancel = true; lifecycleRef.current += 1; sendAbortRef.current?.abort(); sendAbortRef.current = null;
      const local = localSendRef.current;
      if (local) setEntries((list) => list.filter((entry) => entry.id !== local.mine && entry.id !== local.reply));
      localSendRef.current = null;
      setBusy(false);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!opened || !ready || !accountId) return;
    const controller = new AbortController();
    let active = true, refreshing = false, refreshAgain = false, hydrated = false;
    const refresh = async () => {
      if (refreshing) { refreshAgain = true; return; }
      if (sendAbortRef.current || !active) return;
      refreshing = true;
      // A poll may start just before Send. Its snapshot is discarded if a send
      // starts while it is in flight, even if that send has already finished.
      const generation = lifecycleRef.current;
      try {
        const thread = await fetchThread(controller.signal);
        if (!active || sendAbortRef.current || generation !== lifecycleRef.current) return;
        hydrated = true;
        const current = entriesRef.current;
        const merged = thread ? mergeSlowEntries(current, thread.messages) : [];
        const completed = merged.filter((entry) => entry.archive && entry.deliveryStatus === 'complete'
          && current.some((prior) => prior.messageId === entry.messageId && prior.pending));
        setEntries(merged);
        if (completed.length && !openRef.current) {
          completedArchiveRef.current = completed.at(-1)?.messageId ?? null;
          setArchiveNotice(true);
        }
        if (openRef.current) {
          const currentTopic = currentConversation(merged, { context: contextRef.current(), createdAt: new Date() });
          const latest = completed.filter((entry) => currentTopic.includes(entry)).at(-1);
          const focus = latest && answerFocus(latest.anchors ?? { places: [], times: [] }, latest.text);
          if (focus) onAnchorRef.current?.(focus);
        }
      } catch { /* Keep the last good thread and retry at the next pending tick. */ }
      finally {
        refreshing = false;
        if (refreshAgain && active) { refreshAgain = false; void refresh(); }
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => {
      if (!hydrated || hasPendingSlow(entriesRef.current)) void refresh();
    }, 15_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); refreshRef.current = null; };
  }, [opened, ready, accountId]);
  useEffect(() => { if (open) void refreshRef.current?.(); }, [open]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy || unavailable) return;
    const sent = context();
    const generation = ++lifecycleRef.current;
    const controller = new AbortController();
    sendAbortRef.current = controller;
    const current = () => lifecycleRef.current === generation && !controller.signal.aborted;
    followRef.current = true;
    setDraft('');
    setBusy(true);
    setShowEarlier(false);
    const sentKey = placeKey(sent) ?? unplacedTopic ?? `local:${entryId}`;
    if (!placeKey(sent)) setUnplacedTopic(sentKey);
    const stamp = { createdAt: new Date().toISOString(), placeKey: sentKey };
    const mine: Entry = { id: entryId++, kind: 'user', text: message, ...stamp };
    const replyId = entryId++;
    localSendRef.current = { mine: Number(mine.id), reply: replyId };
    setEntries((list) => [...list, mine, { id: replyId, kind: 'reply', text: '', status: 'Sending…', ...stamp }]);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, context: sent }),
        signal: controller.signal,
      });
      if (!current()) return;
      const type = response.headers.get('content-type') ?? '';
      if (response.status === 503) {
        setUnavailable(true);
        setEntries((list) => list.filter((item) => item.id !== replyId).concat({ id: entryId++, kind: 'line', text: LINES.unavailable, ...stamp }));
        return;
      }
      if (type.includes('application/json')) {
        const body = await response.json() as { line?: string; upgrade?: boolean; reportOffer?: boolean; messageId?: string; userMessageId?: string; archiveId?: string };
        if (!current()) return;
        const text = typeof body.line === 'string' ? body.line : LINES.failed;
        setEntries((list) => list.map((item) => item.id === replyId ? { ...item, kind: body.archiveId || body.reportOffer ? 'reply' : 'line', text, upgrade: body.upgrade === true, reportOffer: body.reportOffer === true, status: undefined, messageId: body.messageId, archiveId: body.archiveId, userMessageId: body.userMessageId } : item.id === mine.id ? { ...item, messageId: body.userMessageId } : item));
        if (body.archiveId) setEntries((list) => [...list, { id: body.archiveId!, messageId: body.archiveId, kind: 'archive', text: '', pending: true, deliveryStatus: 'pending', archive: true, archiveId: body.archiveId, userMessageId: body.userMessageId, answerId: body.messageId, ...stamp }]);
        return;
      }
      let text = '';
      const meta = await readChatStream(response, (event) => {
        if (typeof event.replace === 'string') text = event.replace;
        if (typeof event.delta === 'string') text += event.delta;
        const next = text;
        if (current()) setEntries((list) => list.map((item) => item.id === replyId ? {
          ...item, text: next,
          status: event.done ? undefined : typeof event.status === 'string' ? event.status : item.status,
          caveat: typeof event.caveat === 'string' ? event.caveat : item.caveat,
        } : item));
      });
      const anchors = meta.anchors && typeof meta.anchors === 'object' ? meta.anchors as ChatAnchors : undefined;
      const model = !meta.held && typeof meta.model === 'string' ? meta.model : undefined;
      const userMessageId = typeof meta.userMessageId === 'string' ? meta.userMessageId : undefined;
      const archiveId = typeof meta.archiveId === 'string' ? meta.archiveId : undefined;
      const archiveLine = typeof meta.archiveLine === 'string' ? meta.archiveLine : undefined;
      const messageId = typeof meta.messageId === 'string' ? meta.messageId : undefined;
      if (!current()) return;
      setEntries((list) => list.map((item): Entry => item.id === replyId ? { ...item, text, model, anchors, messageId, archive: false, archiveId, archiveLine, userMessageId, reportOffer: meta.reportOffer === true, deliveryStatus: meta.held ? 'held' : meta.failed || meta.blocked ? 'failed' : 'complete', status: undefined, caveat: typeof meta.caveat === 'string' ? meta.caveat : undefined } : item)
        .map((item) => userMessageId && item.id === mine.id ? { ...item, messageId: userMessageId } : item));
      const focus = answerFocus(anchors ?? { places: [], times: [] }, text);
      if (focus && openRef.current) onAnchorRef.current?.(focus);
      if (meta.archive) setEntries((list) => archiveId && list.some((item) => item.messageId === archiveId)
        ? list : [...list, { id: archiveId ?? entryId++, kind: 'archive', text: archiveLine ?? '', messageId: archiveId, pending: true, deliveryStatus: 'pending', archive: true, archiveId, userMessageId, answerId: messageId, ...stamp }]);
    } catch {
      if (current()) setEntries((list) => list.map((item) => item.id === replyId ? { ...item, kind: 'line', text: LINES.interrupted, status: undefined, caveat: undefined } : item));
    } finally {
      if (current()) {
        setBusy(false);
        localSendRef.current = null;
        sendAbortRef.current = null;
        // Also discovers a hand-off when the fast response itself failed.
        void refreshRef.current?.();
      }
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  const requestReport = async (entry: Entry) => {
    if (!entry.messageId || !accountId || actionsRef.current.size) return;
    const controller = new AbortController();
    actionsRef.current.add(controller);
    setArchiveBusy(old => ({ ...old, [String(entry.id)]: true }));
    const feedback = (line: string) => setEntries(list => list.map(item => item.id === entry.id ? { ...item, feedback: line } : item));
    feedback('Requesting report…');
    try {
      if (entry.reportId) {
        const result = await archiveAction('cancel', entry.reportId, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === 'cancelled') setEntries(list => list.map(item => item.messageId === entry.reportId
          ? { ...item, pending: false, deliveryStatus: 'cancelled', text: '' } : item));
        feedback(result.status === 'cancelled' ? 'Report cancelled' : 'Report already started');
      } else {
        const result = await emailQuestion(entry.messageId, controller.signal);
        if (controller.signal.aborted) return;
        if (result.ok && result.reportId) {
          const reportId = result.reportId;
          setEntries(list => [...list.filter(item => item.messageId !== reportId).map(item => item.id === entry.id ? { ...item, reportId, feedback: undefined } : item), {
            id: reportId, messageId: reportId, kind: 'archive', text: LINES.reportPreparing, pending: true,
            deliveryStatus: 'pending', archive: true, source: 'report', answerId: entry.messageId,
            userMessageId: entry.userMessageId, createdAt: entry.createdAt, placeKey: entry.placeKey,
          }]);
        } else feedback(result.line);
      }
      void refreshRef.current?.();
    } catch { if (!controller.signal.aborted) feedback('Report unavailable. Try again.'); }
    finally {
      actionsRef.current.delete(controller);
      if (!controller.signal.aborted) setArchiveBusy(old => ({ ...old, [String(entry.id)]: false }));
    }
  };

  const changeArchive = async (entry: Entry, slow?: Entry) => {
    if (!entry.messageId || !accountId || actionsRef.current.size) return;
    const controller = new AbortController();
    actionsRef.current.add(controller);
    setArchiveBusy((old) => ({ ...old, [String(entry.id)]: true }));
    const feedback = (line: string) => setEntries((list) => list.map((item) => item.id === entry.id ? { ...item, feedback: line } : item));
    feedback(slow?.pending ? 'Cancelling…' : 'Requesting archive check…');
    try {
      const result = await archiveAction(slow?.pending ? 'cancel' : 'queue', slow?.messageId ?? entry.messageId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === 'queued' && result.messageId) {
        const slowId = result.messageId;
        setEntries((list) => [...list.map((item) => item.id === entry.id ? { ...item, archiveId: slowId, feedback: undefined } : item), {
          id: slowId, messageId: slowId, kind: 'archive', text: LINES.archiveChecking,
          pending: true, deliveryStatus: 'pending', archive: true, archiveId: slowId,
          answerId: entry.messageId, userMessageId: entry.userMessageId, createdAt: entry.createdAt, placeKey: entry.placeKey,
        }]);
      } else if (result.status === 'cancelled') {
        setEntries((list) => list.map((item) => item.messageId === slow?.messageId
          ? { ...item, pending: false, deliveryStatus: 'cancelled', text: '' }
          : item.id === entry.id ? { ...item, feedback: 'Archive check cancelled' } : item));
      } else if (result.status === 'claimed') {
        setEntries((list) => list.map((item) => item.messageId === slow?.messageId ? { ...item, deliveryStatus: 'claimed' } : item));
        feedback('Archive check started');
      } else feedback(result.status === 'pending' ? 'One archive question is already in flight' : result.line ?? 'Archive unavailable');
      void refreshRef.current?.();
    } catch { if (!controller.signal.aborted) feedback('Archive unavailable'); }
    finally {
      actionsRef.current.delete(controller);
      if (!controller.signal.aborted) setArchiveBusy((old) => ({ ...old, [String(entry.id)]: false }));
    }
  };

  if (!open || !chips) return archiveNotice && onOpen ? <button type="button" className={styles.notice} data-archive-notice onClick={() => {
    revealArchiveRef.current = completedArchiveRef.current;
    setArchiveNotice(false); onOpen();
  }}>Archive reply ready</button> : null;

  const chipRow = [
    chips.cardId,
    chips.place?.name,
    utcChip(chips.timeUtc),
    lensChip(chips.lens),
    chips.point ? (chips.point.name || coordChip(chips.point.lat, chips.point.lon)) : null,
  ].filter((item): item is string => !!item && item !== '—');

  return (
    <aside
      ref={(node) => { conversationRef.current = node; if (panelRef) panelRef.current = node; }}
      tabIndex={-1}
      aria-label="Ask Isobar"
      data-chat-panel
      data-chat-empty={!hasContent}
      data-chat-layout={desktop ? 'side' : 'sheet'}
      className={`${styles.panel} ${desktop ? styles.side : styles.sheet}`}
      style={!desktop ? (keyboard
        // iPhone keyboard open: sit on top of it, inside the visible part of the page.
        ? { left: anchor?.left ?? 0, width: anchor?.width ?? '100%', top: keyboard.bottom - Math.min(height, keyboard.height * 0.6), height: Math.min(height, keyboard.height * 0.6) }
        : anchor ? { left: anchor.left, width: anchor.width, top: anchor.bottom - height, height } : { visibility: 'hidden' }) : undefined}
    >
      <div className={styles.bar}>
        <div className={styles.chips} data-chat-chips>
          {chipRow.map((chip, index) => <span key={`${chip}-${index}`} data-chat-chip>{chip}</span>)}
        </div>
        {hasEarlier ? <button type="button" className={styles.earlier} aria-expanded={showEarlier} onClick={() => {
          setShowEarlier(!showEarlier);
          followRef.current = showEarlier;
          if (!showEarlier && logRef.current) logRef.current.scrollTop = 0;
        }}>{showEarlier ? 'Hide earlier' : 'Earlier'}</button> : null}
        <button type="button" className={styles.close} aria-label="Close chat" title="Close chat" onClick={onClose}>×</button>
      </div>
      <div ref={logRef} className={styles.log} role="log" aria-live="polite" onScroll={(event) => {
        const log = event.currentTarget;
        followRef.current = log.scrollHeight - log.clientHeight - log.scrollTop < 32;
      }}>
        {unavailable ? <p className={styles.line} data-chat-line>{LINES.unavailable}</p> : null}
        {visibleEntries.map((entry) => {
          if (entry.deliveryStatus === 'cancelled') return null;
          // A keyword handoff has no fast answer to preserve. Retire its queue
          // line when the laptop finishes, or show the result of cancellation.
          if (!entry.archive && entry.archiveId && (entry.text === LINES.archiveChecking || entry.text === LINES.archive)) {
            const slow = entries.find((item) => item.messageId === entry.archiveId);
            if (slow?.deliveryStatus === 'complete') return null;
            if (slow?.deliveryStatus === 'cancelled') entry = { ...entry, text: 'Archive check cancelled', feedback: undefined };
          }
          if (entry.kind === 'archive' && entry.pending && entries.some((other) => !other.archive && other.archiveId === entry.messageId && other.text === LINES.archiveChecking)) return null;
          if (entry.kind === 'archive') return <p key={entry.id}><ArchiveMark />{entry.text ? <span className={styles.archiveText}>{entry.text}</span> : entry.pending ? <span className={styles.archiveText}>Checking the archive…</span> : null}</p>;
          if (entry.kind === 'line') return (
            <p key={entry.id} className={styles.line} data-chat-line>
              {entry.text}
              {entry.upgrade ? <> · <button type="button" className={styles.link} data-chat-upgrade onClick={() => openAccount(true)}>Upgrade for more</button></> : null}
            </p>
          );
          if (entry.kind === 'user') return <p key={entry.id} className={styles.user} data-chat-user>{entry.text}</p>;
          const parts = linkify(entry.text, entry.anchors ?? { places: [], times: [] });
          return (
            <div key={entry.id} className={styles.reply} data-chat-reply data-chat-message={entry.messageId}>
              {entry.status ? <div className={styles.status} data-chat-status role="status"><span className={styles.activity} aria-hidden="true" />{entry.status}</div> : null}
              {entry.archive ? <ArchiveMark /> : null}
              {entry.model ? <span className={styles.chip} data-chat-model={entry.model}>{modelLabel(entry.model)}</span> : null}
              {parts.map((part, index) => part.kind === 'place' ? (
                <button key={index} type="button" className={styles.link} data-chat-place={part.text} onClick={() => onPlace(part.lat ?? 0, part.lon ?? 0)}>{part.text}</button>
              ) : part.kind === 'time' ? (
                <button key={index} type="button" className={styles.link} data-chat-time={part.timeUtc} onClick={() => onTime(part.timeUtc ?? '')}>{part.text}</button>
              ) : <span key={index}>{part.text}</span>)}
              {entry.caveat ? <p className={styles.caveat} data-chat-caveat>{entry.caveat}</p> : null}
              {accountId && entry.reportOffer && entry.messageId ? (() => {
                const report = entries.find(item => item.messageId === entry.reportId);
                const label = !entry.reportId ? 'Email me a detailed report' : report?.pending ? 'Cancel report'
                  : report?.deliveryStatus === 'complete' ? 'Report emailed' : report?.deliveryStatus === 'cancelled' ? 'Report cancelled'
                  : report?.deliveryStatus === 'failed' ? 'Report failed' : report?.deliveryStatus === 'held' ? 'Report held' : 'Report requested';
                return <div className={styles.actions}><button type="button" className={styles.deeper} data-email-report
                  disabled={Object.values(archiveBusy).some(Boolean) || (!!entry.reportId && !report?.pending)}
                  onClick={() => void requestReport(entry)}>{label}</button>
                  {entry.feedback ? <span className={styles.feedback} role="status">{entry.feedback}</span> : null}</div>;
              })() : null}
              {accountId && !entry.reportOffer && entry.source !== 'report' && entry.messageId && entry.text && entry.text !== LINES.blocked && entry.status === undefined && entry.deliveryStatus !== 'held' && entry.deliveryStatus !== 'failed' ? (() => {
                const slow = [...entries].reverse().find((item) => item.archive && item.pending && (item.answerId === entry.messageId || item.messageId === entry.archiveId));
                return <div className={styles.actions}><button type="button" className={styles.deeper} data-dig-deeper
                  disabled={Object.values(archiveBusy).some(Boolean) || slow?.deliveryStatus === 'claimed'}
                  onClick={() => void changeArchive(entry, slow)}>
                  {slow?.deliveryStatus === 'claimed' ? 'Archive check started' : slow?.pending ? 'Cancel archive check' : 'Dig deeper'}
                </button>{entry.feedback ? <span className={styles.feedback} role="status">{entry.feedback}</span> : null}</div>;
              })() : null}
              {entry.images?.map((image) => <img key={image.src} className={styles.image} src={image.src} alt={image.alt} loading="lazy" />)}
            </div>
          );
        })}
      </div>
      {unavailable ? null : (
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <input ref={inputRef} placeholder="Ask about this weather…" aria-label="Message" maxLength={1500} value={draft} onChange={(event) => setDraft(event.target.value)} autoComplete="off" />
          <button type="submit" disabled={busy || !draft.trim()}>Send</button>
        </form>
      )}
    </aside>
  );
}

/** While an on-screen keyboard covers the page, the visible area (layout-viewport px). Null otherwise. */
function useKeyboardView(): { bottom: number; height: number } | null {
  const [view, setView] = useState<{ bottom: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      setView(covered > 120 ? { bottom: viewport.offsetTop + viewport.height, height: viewport.height } : null);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, []);
  return view;
}
