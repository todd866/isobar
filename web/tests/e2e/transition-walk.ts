/** An Euler walk through every ordered action pair, including repeats.
 * The seed changes the ordering; failures can replay the exact prefix. */
export function transitionWalk<T extends string>(actions: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const edges = actions.map(() => {
    const list = actions.map((_, i) => i);
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  });
  if (!actions.length) return [];
  const stack = [Math.floor(next() * actions.length)], path: number[] = [];
  while (stack.length) {
    const node = stack.at(-1)!;
    if (edges[node].length) stack.push(edges[node].pop()!); else path.push(stack.pop()!);
  }
  return path.reverse().map(i => actions[i]);
}
