'use client';

import { useEffect, useRef, useState } from 'react';
import { unitKey } from '@/lib/units';
import { useUnits } from './UnitsControl';
import { mountTrainer, type TrainerStorage } from '../../../training/src/mount.ts';
import { labPreview } from '../../../training/src/instruments/lab.ts';
import { LEARN_KEY, readLearn, type LearnRecord } from '../../../training/src/learn-profile.ts';
import { learnCards } from '../../../training/src/learn-cards.ts';
import { readDeskLearn } from '@/lib/od/desk-learning';
import { loadTrainingSnapshot } from '@/lib/training-snapshot';
import { SYNCED, progressStore } from '@/lib/account/local';
import { trackUsage } from '@/lib/usage/browser';
import { LearnPicker } from './LearnPicker';
import { ChatPanel } from './ChatPanel';
import type { ChatContext } from '@/lib/chat/types';

function LearnBar() {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[var(--md-outline-soft)] px-4 py-2">
      <a href="/?tour=1" className="text-sm font-medium text-[var(--md-primary)]">Today’s tour</a>
      <a href="/decide" className="ml-auto rounded-md bg-[var(--md-primary)] px-3 py-1.5 text-sm font-medium text-[var(--md-on-primary)]">Operational Decision desk</a>
    </div>
  );
}

function storedLearn(): LearnRecord | null {
  try { return readLearn(JSON.parse(localStorage.getItem(LEARN_KEY) ?? 'null')); }
  catch { return null; }
}

function emptyContext(detail: { cardId: string; level: string; rules: 'aus' | 'us' | 'easa' | 'ca' | null } | null): ChatContext {
  return {
    place: null, timeUtc: null, timeLocal: null, lens: null, camera: null, point: null, fly: null, units: null,
    runId: null, dataSha256: null, level: detail?.level ?? null, cardId: detail?.cardId ?? null, rules: detail?.rules ?? null,
  };
}

/** React owns the host lifetime; the shared trainer owns everything inside it. */
export function Trainer() {
  const host = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const saved = useRef(false);
  const { units } = useUnits();
  const trainerRef = useRef<ReturnType<typeof mountTrainer> | null>(null);
  const [gate, setGate] = useState<'pending' | 'pick' | 'classic' | 'learn'>('pending');
  const [record, setRecord] = useState<LearnRecord | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [chat, setChat] = useState<{ cardId: string; level: string; rules: 'aus' | 'us' | 'easa' | 'ca' | null } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const recordRef = useRef<LearnRecord | null>(null);
  const explainRef = useRef((detail: NonNullable<typeof chat>) => { setChat(detail); setChatOpen(true); });
  explainRef.current = (detail) => { setChat(detail); setChatOpen(true); };

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onSynced = (event: Event) => {
      if ((event as CustomEvent<{ kinds: string[] }>).detail?.kinds.includes('training') && !saved.current) setGeneration((n) => n + 1);
    };
    window.addEventListener(SYNCED, onSynced);
    return () => window.removeEventListener(SYNCED, onSynced);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const stored = storedLearn();
    if (params.get('level') === '1') { setGate('pick'); setRecord(null); return; }
    if (params.get('card') || params.get('lab') || stored?.classic) { setGate('classic'); setRecord(null); return; }
    if (stored?.started && stored.person) { recordRef.current = stored; setRecord(stored); setGate('learn'); return; }
    // A citation link can open the current edition directly for a new visitor.
    if (params.get('concept')) {
      const desk = readDeskLearn();
      recordRef.current = desk; setRecord(desk); setGate('learn'); return;
    }
    setGate('pick');
  }, [generation]);

  useEffect(() => {
    if (gate !== 'classic' && gate !== 'learn') return;
    if (!host.current) return;
    const root = document.documentElement;
    const current = () => root.classList.contains('dark') ? 'dark' as const : 'light' as const;
    const params = new URLSearchParams(location.search);
    const sitting = recordRef.current;
    const concept = params.get('concept');
    const conceptCard = concept && sitting?.person
      ? learnCards.find((card) => card.conceptIds.includes(concept) && (card.rules == null || card.rules === 'both' || card.rules === sitting.person?.rules))
      : undefined;
    const trainer = mountTrainer(host.current, {
      navigation: 'tabs',
      theme: current(),
      storage: progressStore('training', () => { saved.current = true; }) as TrainerStorage,
      preview: { card: params.get('card') ?? conceptCard?.id, ...labPreview(params) },
      onAnswer: (answer) => trackUsage('train-answer', { card: answer.id, quality: answer.quality }),
      learn: gate === 'learn' && sitting?.person ? {
        record: sitting,
        place: localStorage.getItem('isobar.place'),
        onChange: (next) => {
          recordRef.current = next;
          try { localStorage.setItem(LEARN_KEY, JSON.stringify(next)); } catch { /* the trainer already saved the document */ }
        },
        onExplain: (detail) => explainRef.current({
          cardId: detail.cardId,
          level: detail.level,
          rules: detail.rules === 'us' || detail.rules === 'aus' || detail.rules === 'easa' || detail.rules === 'ca' ? detail.rules : null,
        }),
      } : undefined,
    });
    trainerRef.current = trainer;
    performance.mark('isobar-first-training-card');
    const themeObserver = new MutationObserver(() => trainer.setTheme(current()));
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => {
      trainerRef.current = null;
      themeObserver.disconnect();
      trainer.dispose();
    };
  }, [generation, gate]);

  useEffect(() => {
    const trainer = trainerRef.current;
    if (!trainer) return;
    const controller = new AbortController();
    void loadTrainingSnapshot({ signal: controller.signal, units }).then((snapshot) => {
      if (!controller.signal.aborted) trainer.setSnapshot(snapshot);
    }).catch(() => { /* The sitting stays up if a refresh fails. */ });
    return () => controller.abort();
  }, [generation, gate, unitKey(units)]);

  if (gate === 'pick') {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LearnBar />
        <LearnPicker theme={theme} onStart={(next) => { recordRef.current = next; setRecord(next); setGate('learn'); }} />
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {gate === 'learn' ? <LearnBar /> : null}
      <div ref={host} className="trainer min-h-0 flex-1" aria-label="ATPL training" tabIndex={-1} data-theme={theme} />
      {chat ? (
        <ChatPanel
          open={chatOpen}
          onOpen={() => setChatOpen(true)}
          onClose={() => setChatOpen(false)}
          anchorRef={host}
          context={() => emptyContext(chat)}
          onPlace={() => {}}
          onTime={() => {}}
        />
      ) : null}
    </div>
  );
}
