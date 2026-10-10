'use client';

import { useEffect, useState } from 'react';
import { priorPerson } from '../../../training/src/ability.ts';
import { LEARN_KEY, type LearnRecord } from '../../../training/src/learn-profile.ts';
import { isLearnGoal, isLearnLevel, isLearnRules, levelChoices, showsRules, type LearnGoal, type LearnLevel, type LearnRules } from '../../../training/src/levels.ts';
import { trackUsage } from '@/lib/usage/browser';
import { useUnits } from './UnitsControl';
import { assignLearn, defaultRules, iconDefault, type AssignResult } from '@/lib/learn/assign';

const ICONS: { id: LearnGoal; label: string; path: string }[] = [
  { id: 'weather', label: 'Weather', path: 'M6 15a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A3.5 3.5 0 0 1 18 15H6z' },
  { id: 'drones', label: 'Drones', path: 'M12 11v3M5 8l3 3M19 8l-3 3M8 14h8M4 8h3M17 8h3' },
  { id: 'flying', label: 'Flying', path: 'M3 13l18-6-6 14-2-6-6-2z' },
  { id: 'defence', label: 'Defence', path: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' },
];

function chipValue(level: LearnLevel, rules: LearnRules | null): string {
  if (!showsRules(level) || !rules) return `${level}|x`;
  return `${level}|${rules}`;
}

function topicsOf(text: string): boolean {
  return /\b(part\s*107|drone|dji|repl)\b/i.test(text);
}

export function LearnPicker({ theme, onStart }: { theme: 'light' | 'dark'; onStart: (record: LearnRecord) => void }) {
  const { mode } = useUnits();
  const [place, setPlace] = useState<string | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [icon, setIcon] = useState<LearnGoal>('flying');
  const [text, setText] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<AssignResult | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = topicsOf(topics.join(' ')) ? 'us' as const : defaultRules(mode, place);
  const suggested = topicsOf(topics.join(' ')) ? iconDefault('drones', 'us', place) : iconDefault(icon, mode, place);
  const value = chip ?? chipValue(suggested.level, suggested.rules);

  useEffect(() => {
    try { setPlace(localStorage.getItem('isobar.place')); } catch { /* private window */ }
    const found: string[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem('isobar.chat.topics') ?? 'null') as unknown;
      if (Array.isArray(raw)) found.push(...raw.filter((item): item is string => typeof item === 'string'));
    } catch { /* ignore */ }
    setTopics(found);
    const controller = new AbortController();
    void fetch('/api/chat/thread', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { messages?: { content?: unknown }[] };
      const more = (body.messages ?? []).map((item) => item.content).filter((item): item is string => typeof item === 'string');
      if (more.length) setTopics((current) => [...current, ...more]);
    }).catch(() => { /* signed out, or chat is down */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (topicsOf(topics.join(' ')) && chip == null) setIcon('drones');
  }, [topics, chip]);

  async function refine(nextText: string) {
    const trimmed = nextText.trim();
    if (!trimmed) { setAssigned(null); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/learn/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ icon, text: trimmed, units: mode, place, topics }),
      });
      const body = response.ok ? await response.json() as AssignResult : null;
      const result = body && isLearnLevel(body.level) && isLearnGoal(body.goal) ? body : await assignLearn({ icon, text: trimmed, units: mode, place, topics });
      setAssigned(result);
      setChip(chipValue(result.level, result.rules));
      setIcon(result.goal === 'defence' ? 'defence' : result.goal);
    } catch {
      setAssigned(null);
    } finally { setBusy(false); }
  }

  function chooseIcon(next: LearnGoal) {
    setIcon(next);
    setAssigned(null);
    const fallback = iconDefault(next, mode, place);
    setChip(chipValue(fallback.level, fallback.rules));
  }

  function start() {
    const [level, rulesBit] = value.split('|');
    if (!isLearnLevel(level)) return;
    const pickedRules: LearnRules | null = isLearnRules(rulesBit) ? rulesBit : null;
    const base = assigned && assigned.level === level ? assigned : iconDefault(icon, mode, place);
    const person = priorPerson({
      level, goal: base.goal, rules: showsRules(level) ? (pickedRules ?? base.rules) : null,
      now: Date.now(), emphasis: base.strands,
    });
    const record: LearnRecord = {
      version: 1,
      started: true,
      icon,
      text: text.trim().slice(0, 300),
      goal: base.goal,
      level,
      rules: person.rules,
      strands: base.strands,
      exam: base.exam,
      person,
      updatedAt: new Date().toISOString(),
    };
    try { localStorage.setItem(LEARN_KEY, JSON.stringify(record)); } catch { /* the sitting still starts */ }
    trackUsage('learn-start', { icon: record.icon, text: record.text, goal: record.goal, level: record.level, rules: record.rules });
    onStart(record);
  }

  return (
    <div className="trainer min-h-0 flex-1" data-theme={theme} aria-label="Learn">
      <form className="learn-picker" onSubmit={(event) => { event.preventDefault(); start(); }}>
        <p className="picker-prompt">What are you here for?</p>
        <div className="picker-icons" role="group" aria-label="What are you here for">
          {ICONS.map((item) => (
            <button key={item.id} type="button" aria-pressed={icon === item.id} onClick={() => chooseIcon(item.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" d={item.path} /></svg>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="picker-line">
          <input
            aria-label="In your own words"
            placeholder="In your own words (optional)"
            maxLength={300}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => { void refine(text); }}
          />
        </div>
        <div className="picker-go">
          <label className="mode">
            <select data-learn-chip aria-label="Level" value={value} disabled={busy} onChange={(event) => { setAssigned(null); setChip(event.target.value); }}>
              {levelChoices().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="submit" className="show">Start</button>
        </div>
      </form>
    </div>
  );
}
