/** The E6-B flight computer as a self-contained module.
 *
 *   import { mountE6B } from './instruments/e6b/index.ts';
 *   const computer = mountE6B(document.querySelector('#host'), { variant: 'lab' });
 *
 * No dependencies: SVG, pointer events and TypeScript. Styles are injected once.
 */
import { FlightComputer, type E6BOptions } from './instrument.ts';

export { FlightComputer, type E6BOptions, type E6BStore } from './instrument.ts';
export { E6B } from './face.ts';
export { manualDemos } from './demos.ts';
export { E6B_CSS } from './styles.ts';

export function mountE6B(host: Element, options: E6BOptions = {}): FlightComputer {
  const computer = new FlightComputer(options);
  computer.mount(host);
  return computer;
}
