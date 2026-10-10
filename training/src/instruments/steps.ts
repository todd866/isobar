/** Pure lesson state: estimates are recorded before any worked answer appears.
 * A miss opens a simpler manipulation, then returns to the unsolved problem. */
export type Phase = 'estimate' | 'watch' | 'guided' | 'solo' | 'scaffold' | 'complete';
export interface Lesson { phase: Phase; practice: boolean; estimate: number | null; misses: number; feedback: string; }
export type LessonEvent =
  | { type: 'estimate'; value: number }
  | { type: 'watched' }
  | { type: 'manipulated'; correct: boolean }
  | { type: 'answer'; value: number; answer: number; tolerance: number };
export function beginLesson(practice = false): Lesson {
  return { phase: 'estimate', practice, estimate: null, misses: 0, feedback: '' };
}
export function advanceLesson(lesson: Lesson, event: LessonEvent): Lesson {
  if (event.type === 'estimate' && lesson.phase === 'estimate' && Number.isFinite(event.value)) {
    return { ...lesson, estimate: event.value, phase: lesson.practice ? 'solo' : 'watch', feedback: '' };
  }
  if (event.type === 'watched' && lesson.phase === 'watch') return { ...lesson, phase: 'guided', feedback: '' };
  if (event.type === 'manipulated' && (lesson.phase === 'guided' || lesson.phase === 'scaffold')) {
    return event.correct ? { ...lesson, phase: 'solo', feedback: '' } : { ...lesson, feedback: 'Follow the highlighted control. Match the marked value.' };
  }
  if (event.type === 'answer' && lesson.phase === 'solo' && Number.isFinite(event.value) && Number.isFinite(event.answer) && Number.isFinite(event.tolerance) && event.tolerance >= 0) {
    if (Math.abs(event.value-event.answer) <= event.tolerance + 1e-9) return { ...lesson, phase: 'complete', feedback: '✓ Solved' };
    return { ...lesson, phase: 'scaffold', misses: lesson.misses + 1, feedback: '' };
  }
  return lesson;
}
