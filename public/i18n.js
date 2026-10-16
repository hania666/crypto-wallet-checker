// UI language: Russian (source strings) or English. Choice is remembered per browser; default follows the browser.
import { EN } from './i18n-en.js';

function detect() {
  // ?lang=en / ?lang=ru in the address wins and is remembered
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl === 'ru' || fromUrl === 'en') {
    try { localStorage.setItem('lang', fromUrl); } catch {}
    return fromUrl;
  }
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {}
  return /^(ru|uk|be)/i.test(navigator.language || '') ? 'ru' : 'en';
}

export const LANG = detect();
export const LOCALE = LANG === 'ru' ? 'ru-RU' : 'en-US';

const fill = (s, args) => (args ? s.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) : s);

// tt('Сканирую… {0} / {1}', [done, total]) — strings written in the code
export function tt(key, args) {
  return fill(LANG === 'ru' ? key : EN[key] ?? key, args);
}

// tr(text) — text that arrives already assembled (server errors, sweeper reasons): exact match first,
// then match against templated keys like "газ от {0}" and re-fill the English template
let patterns = null;
export function tr(text) {
  if (LANG === 'ru' || text == null || text === '') return text;
  const s = String(text);
  if (EN[s] != null) return EN[s];
  patterns ??= Object.keys(EN)
    .filter((k) => /\{\d+\}/.test(k))
    .sort((a, b) => b.length - a.length)
    .map((k) => {
      const order = [];
      const re = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\d+)\}/g, (_, i) => { order.push(Number(i)); return '([\\s\\S]*?)'; });
      return { re: new RegExp(`^${re}$`), order, key: k };
    });
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (!m) continue;
    const args = [];
    // inner parts are only swapped on an exact match — wallet names and other user data stay as they are
    p.order.forEach((idx, g) => { args[idx] = EN[m[g + 1]] ?? m[g + 1]; });
    return fill(EN[p.key], args);
  }
  return s;
}

// static markup in index.html: translate text nodes and placeholder/title attributes once at startup
export function translateDom(root = document.body) {
  document.documentElement.lang = LANG;
  if (LANG === 'ru') return;
  document.title = tr(document.title);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const key = raw.replace(/\s+/g, ' ').trim();
    if (!key || !/[А-Яа-яЁё]/.test(key)) continue;
    const en = EN[key];
    if (en != null) n.nodeValue = (/^\s/.test(raw) ? ' ' : '') + en + (/\s$/.test(raw) ? ' ' : '');
  }
  for (const el of root.querySelectorAll('[placeholder],[title]')) {
    for (const attr of ['placeholder', 'title']) {
      const v = el.getAttribute(attr);
      if (v && EN[v] != null) el.setAttribute(attr, EN[v]);
    }
  }
}

export function setLang(lang) {
  try { localStorage.setItem('lang', lang); } catch {}
  const url = new URL(location.href);
  url.searchParams.set('lang', lang); // also works when storage is blocked
  location.href = url.toString();
}
