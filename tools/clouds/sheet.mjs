import { skies, styles } from './fixtures.mjs';
import { loadSprites, prepareScene } from './render.mjs';
const params = new URLSearchParams(location.search);
const theme = document.querySelector('#theme'), sky = document.querySelector('#sky');
theme.value = params.get('theme') === 'dark' ? 'dark' : 'light';
sky.value = skies.some(s => s.id === params.get('sky')) ? params.get('sky') : 'all';
document.body.classList.toggle('contact', params.has('contact'));
const sprites = await loadSprites();
const cache = new Map();
window.cloudStudy = { ready: false, renders: [], cache };
function render() {
  window.cloudStudy.ready = false;
  document.documentElement.classList.toggle('dark', theme.value === 'dark');
  const main = document.querySelector('main'); main.replaceChildren();
  for (const scene of skies.filter(s => sky.value === 'all' || sky.value === s.id)) for (const style of styles) {
    const figure = document.createElement('figure'); figure.dataset.scene = scene.id; figure.dataset.style = style.id;
    const caption = document.createElement('figcaption');
    const name = document.createElement('span'); name.className = 'specimen'; name.textContent = scene.title;
    const variant = document.createElement('span'); variant.className = 'style'; variant.textContent = style.title;
    caption.append(name, variant); const c = document.createElement('canvas'); c.setAttribute('role', 'img'); c.setAttribute('aria-label', `${scene.title}, ${style.title}`);
    figure.append(caption, c); main.append(figure);
  }
  for (const figure of main.children) {
    const scene = skies.find(s => s.id === figure.dataset.scene), style = figure.dataset.style;
    const width = Math.round(figure.clientWidth), height = params.has('contact') || width < 460 ? 236 : 278;
    const key = `${scene.id}/${style}/${width}/${height}/${theme.value}`;
    const start = performance.now();
    if (!cache.has(key)) {
      // Bounded gallery: keep at most the current and previous 12 specimens.
      if (cache.size >= 24) cache.delete(cache.keys().next().value);
      cache.set(key, prepareScene(scene, style, width, height, theme.value === 'dark', sprites));
    }
    const prepared = cache.get(key), c = figure.querySelector('canvas'); c.width = prepared.width; c.height = prepared.height;
    c.getContext('2d').drawImage(prepared, 0, 0);
    window.cloudStudy.renders.push({ key, prepareMs: performance.now() - start });
    figure._prepared = prepared;
  }
  window.cloudStudy.ready = true;
}
theme.addEventListener('change', render); sky.addEventListener('change', render);
let timer; window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(render, 80); });
window.cloudStudy.benchmark = () => {
  const measurements = [];
  for (const figure of document.querySelectorAll('figure')) {
    const ctx = figure.querySelector('canvas').getContext('2d'), times = [];
    for (let i = 0; i < 160; i++) { const start = performance.now(); ctx.drawImage(figure._prepared, 0, 0); times.push(performance.now() - start); }
    times.sort((a,b) => a-b); measurements.push({ scene: figure.dataset.scene, style: figure.dataset.style, medianMs: times[80], p95Ms: times[152], maxMs: times.at(-1) });
  }
  return measurements;
};
render();
