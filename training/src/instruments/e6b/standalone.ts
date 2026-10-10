/** Standalone page entry: the E6-B on its own (website route, previews). */
import { mountE6B } from './index.ts';

const host = document.querySelector<HTMLElement>('#e6b');
if (!host) throw new Error('missing #e6b host');
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme
  : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
host.dataset.theme = document.documentElement.dataset.theme;
const computer = mountE6B(host, { variant: 'lab', seed: 7 });
(window as unknown as { e6b: typeof computer }).e6b = computer;
