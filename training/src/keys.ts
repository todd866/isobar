/** Review keys. Space reveals; after the answer, 1–4 grade and Space is Good. */

export type Overlay = 'none' | 'flag' | 'shortcuts' | 'difficulty';

export type KeyIntent =
  | { type: 'choose'; optionId: string }
  | { type: 'reveal' }
  | { type: 'grade'; quality: number }
  | { type: 'flag' }
  | { type: 'shortcuts' }
  | { type: 'submit-flag' }
  | { type: 'dismiss' }
  | { type: 'close' }
  | { type: 'ignore' };

export function keyIntent(input: {
  key: string;
  code: string;
  phase: 'ask' | 'revealed';
  overlay: Overlay;
  typing: boolean;
  shift: boolean;
  optionIds: readonly string[];
}): KeyIntent {
  const space = input.code === 'Space' || input.key === ' ';
  const enter = input.key === 'Enter';
  if (input.overlay !== 'none') {
    if (input.key === 'Escape') return { type: 'dismiss' };
    if (input.overlay === 'flag' && enter && !input.shift) return { type: 'submit-flag' };
    return { type: 'ignore' };
  }
  if (input.typing) return { type: 'ignore' };
  if (input.key === 'Escape') return { type: 'close' };
  if (input.key === '?') return { type: 'shortcuts' };
  if (input.key === 'f' || input.key === 'F') return { type: 'flag' };
  if (space || enter) return input.phase === 'ask' ? { type: 'reveal' } : { type: 'grade', quality: 3 };
  if (input.key >= '1' && input.key <= '4') {
    const quality = Number(input.key);
    if (input.phase === 'revealed') return { type: 'grade', quality };
    if (input.optionIds.includes(input.key)) return { type: 'choose', optionId: input.key };
  }
  return { type: 'ignore' };
}

export function shortcutRows(phase: 'ask' | 'revealed', kind: 'mcq' | 'later' | 'numeric' = 'mcq'): { keys: string; label: string }[] {
  if (phase === 'ask' && kind === 'numeric') {
    return [
      { keys: 'Enter', label: 'Submit' },
      { keys: 'Space', label: 'Show answer' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Shortcuts' },
    ];
  }
  if (phase === 'ask') {
    return [
      { keys: '1–4', label: 'Choose an answer' },
      { keys: 'Space', label: 'Show answer' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Shortcuts' },
    ];
  }
  return [
    { keys: '1', label: 'Again' },
    { keys: '2', label: 'Hard' },
    { keys: '3', label: 'Good' },
    { keys: '4', label: 'Easy' },
    { keys: 'Space', label: 'Good' },
    { keys: 'F', label: 'Flag this item' },
    { keys: '?', label: 'Shortcuts' },
  ];
}
