import { NETWORKS, NETWORK_BY_ID, networkName, explorerAddressUrl } from './networks.js';
import { parseSecretLines, deriveAddresses } from './seeds.js';
import { mountSweep } from './sweep-ui.js';
import { mountActivity } from './activity-ui.js';
import { tt, tr, LANG, LOCALE, translateDom, setLang } from './i18n.js';

const $ = (id) => document.getElementById(id);

// Every piece of on-chain text (token names!) is attacker-controlled spam, so DOM is built with
// textContent only — never innerHTML with data.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const S = {
  config: null,
  wallets: [],
  scan: { wallets: {} },
  job: null,
  hidden: new Set(),
  sums: new Map(),
  open: new Set(),
  selected: new Set(),
  sort: { key: 'total', dir: 'desc' },
  preview: null,
  tab: 'overview',
  netDraft: null,
};

// ---------- utils ----------

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usd(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (v > 0 && v < 0.01) return '<$0.01';
  return usdFmt.format(v);
}
function usdShort(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
  if (v >= 100) return `$${Math.round(v).toLocaleString('en-US')}`;
  return usd(v);
}
function amount(s) {
  const n = Number(s);
  if (s == null || !Number.isFinite(n)) return s ?? '?';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e12) return n.toExponential(3);
  if (abs < 1) return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: abs >= 1000 ? 2 : 4 });
}
function price(p) {
  if (p == null) return '—';
  if (p >= 1) return usd(p);
  return '$' + p.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
function ago(iso) {
  if (!iso) return tt("ещё не было");
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return tt("только что");
  if (s < 3600) return tt("{0} мин назад", [Math.floor(s / 60)]);
  if (s < 86400) return tt("{0} ч назад", [Math.floor(s / 3600)]);
  return tt("{0} дн назад", [Math.floor(s / 86400)]);
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(LOCALE) : '');
const walletName = (w) => w.label || tt("Кошелёк {0}", [w.id]);

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    toast(tt("Ошибка: ") + tr(e.message), 6000);
  }
}

const tip = $('tooltip');
function showTip(evt, title, lines) {
  tip.replaceChildren(h('div', { class: 't-title', text: title }), ...lines.map((l) => h('div', { text: l })));
  tip.classList.remove('hidden');
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => tip.classList.add('hidden');

// ---------- derived numbers ----------

const hiddenKey = (net, token) => `${net}:${token ?? 'native'}`;

function summarize(w) {
  const sc = S.scan.wallets[w.address.toLowerCase()];
  const dust = S.config.dustUsd;
  const out = { scanned: Boolean(sc), scannedAt: sc?.scannedAt, total: 0, nets: [], gasNets: [], errNets: [], unpricedReal: 0 };
  if (!sc) return out;
  const enabled = new Set(S.config.networks);
  for (const [net, e] of Object.entries(sc.nets)) {
    if (!enabled.has(net)) continue;
    const tokens = e.tokens.map((t) => ({ ...t, hidden: S.hidden.has(hiddenKey(net, t.token)) }));
    const counted = tokens.filter((t) => !t.hidden && !t.spam && t.value != null);
    const total = sum(counted, (t) => t.value);
    const native = tokens.find((t) => t.native);
    const tokenValue = sum(counted.filter((t) => !t.native), (t) => t.value);
    const needGas = tokenValue >= Math.max(1, dust) && (!native || (native.value != null && native.value < 0.05));
    const unpriced = tokens.filter((t) => !t.hidden && !t.spam && t.value == null).length;
    out.unpricedReal += unpriced;
    out.nets.push({ net, total, tokens, tokenValue, native, needGas, error: e.error, unpriced });
    out.total += total;
    if (needGas) out.gasNets.push(net);
    if (e.error) out.errNets.push(net);
  }
  out.nets.sort((a, b) => b.total - a.total);
  return out;
}

function recompute() {
  S.hidden = new Set(S.config.hiddenTokens);
  S.sums = new Map(S.wallets.map((w) => [w.id, summarize(w)]));
}

// ---------- loading & scan job ----------

async function loadState() {
  const st = await api('/api/state');
  S.config = st.config;
  S.wallets = st.wallets;
  S.scan = st.scan;
  S.job = st.job;
  for (const id of [...S.selected]) if (!S.wallets.some((w) => w.id === id)) S.selected.delete(id);
  recompute();
  renderAll();
}

let pollTimer;
let pollTick = 0;
async function pollJob() {
  clearTimeout(pollTimer);
  try {
    S.job = await api('/api/job');
  } catch {
    pollTimer = setTimeout(pollJob, 3000);
    return;
  }
  renderProgress();
  if (S.job.running) {
    if (++pollTick % 4 === 0) await loadState(); // show partial results while scanning
    pollTimer = setTimeout(pollJob, 1000);
  } else {
    await loadState();
    if (S.job.aborted) toast(tt("Скан остановлен: ") + (tr(S.job.lastError) || tt("ошибка ключа")), 8000);
    else toast(tt("Скан завершён{0}", [S.job.failed ? tt(", с ошибками: {0}", [S.job.failed]) : '']));
  }
}

async function startScan(ids) {
  await guarded(async () => {
    S.job = await api('/api/scan', ids ? { ids } : {});
    renderProgress();
    pollTick = 0;
    pollJob();
  });
}

function renderProgress() {
  const j = S.job;
  const running = Boolean(j?.running);
  $('progress').classList.toggle('hidden', !running);
  $('scanAllBtn').disabled = running;
  $('scanSelBtn').disabled = running;
  if (running) {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    $('progressFill').style.width = `${pct}%`;
    $('progressText').textContent = tt("Сканирую… {0} / {1} запросов ({2}%){3}", [j.done, j.total, pct, j.failed ? tt(" · ошибок: {0}", [j.failed]) : '']);
  }
  $('scanInfo').textContent = running ? '' : tt("Последний скан: {0}", [ago(S.scan.scannedAt)]);
}

// ---------- rendering ----------

function renderAll() {
  $('walletCount').textContent = S.wallets.length || '';
  renderBanner();
  renderProgress();
  if (S.tab === 'overview') renderOverview();
  if (S.tab === 'wallets') renderWallets();
  if (S.tab === 'settings') renderSettings();
  if (S.tab === 'add') renderAdd();
  if (S.tab === 'sweep') sweep.render();
  if (S.tab === 'activity') activityTab.render();
}

function renderBanner() {
  const b = $('banner');
  b.replaceChildren();
  if (!S.config.hasKey) {
    b.append(h('div', { class: 'banner warn' }, tt("⚠ Не задан Alchemy API key — без него скан не работает."),
      h('button', { onclick: () => switchTab('settings') }, tt("Открыть настройки"))));
  } else if (S.job?.aborted && !S.job.running) {
    b.append(h('div', { class: 'banner crit' }, tt("✕ Последний скан остановлен: "), tr(S.job.lastError) || ''));
  } else if (!S.wallets.length) {
    b.append(h('div', { class: 'banner warn' }, tt("Список кошельков пуст."),
      h('button', { onclick: () => switchTab('add') }, tt("Добавить адреса или сиды"))));
  }
}

function switchTab(tab) {
  S.tab = tab;
  for (const btn of $('tabs').querySelectorAll('button')) btn.classList.toggle('active', btn.dataset.tab === tab);
  for (const sec of document.querySelectorAll('section.tab')) sec.classList.toggle('hidden', sec.id !== `tab-${tab}`);
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  renderAll();
}

// --- overview ---

function aggregates() {
  const dust = S.config.dustUsd;
  const byNet = new Map();
  const byToken = new Map();
  const gas = [];
  const errors = new Map();
  let total = 0;
  let withMoney = 0;
  let scanned = 0;
  for (const w of S.wallets) {
    const s = S.sums.get(w.id);
    if (!s.scanned) continue;
    scanned++;
    total += s.total;
    if (s.total >= dust) withMoney++;
    for (const n of s.nets) {
      if (n.total > 0) {
        const a = byNet.get(n.net) ?? { value: 0, wallets: 0 };
        a.value += n.total;
        if (n.total >= dust) a.wallets++;
        byNet.set(n.net, a);
      }
      for (const t of n.tokens) {
        if (t.hidden || t.spam || t.value == null || t.value <= 0) continue;
        const key = t.symbol.toUpperCase();
        const a = byToken.get(key) ?? { value: 0, amount: 0, nets: new Set(), wallets: new Set() };
        a.value += t.value;
        a.amount += Number(t.amount) || 0;
        a.nets.add(n.net);
        a.wallets.add(w.id);
        byToken.set(key, a);
      }
      if (n.needGas) gas.push({ w, net: n.net, value: n.tokenValue, n });
      if (n.error) {
        const e = errors.get(n.net) ?? { count: 0, msg: n.error };
        e.count++;
        errors.set(n.net, e);
      }
    }
  }
  return { total, withMoney, scanned, byNet, byToken, gas, errors };
}

function kpi(label, value, sub, cls = '') {
  return h('div', { class: `kpi ${cls}` }, h('div', { class: 'k-label', text: label }), h('div', { class: 'k-value num', text: value }), h('div', { class: 'k-sub', text: sub }));
}

function barList(container, rows, { onClick, limit = 14 }) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(h('div', { class: 'd-empty', text: tt("Пока нет данных — запусти скан.") }));
    return;
  }
  const max = rows[0].value || 1;
  const shown = rows.slice(0, limit);
  const total = sum(rows, (r) => r.value);
  for (const r of shown) {
    const pct = Math.max(0.4, (r.value / max) * 100);
    const row = h('div', { class: `bl-row${onClick ? ' click' : ''}` },
      h('div', { class: 'bl-name', text: r.name }),
      h('div', { class: 'bl-track' }, h('div', { class: 'bl-fill', style: `width:${pct}%` })),
      h('div', { class: 'bl-val', text: usdShort(r.value) }));
    row.addEventListener('mousemove', (e) => showTip(e, r.name, [usd(r.value), tt("{0}% от всего", [((r.value / total) * 100).toFixed(1)]), ...(r.extra ?? [])]));
    row.addEventListener('mouseleave', hideTip);
    if (onClick) row.addEventListener('click', () => { hideTip(); onClick(r); });
    container.append(row);
  }
  if (rows.length > limit) {
    const rest = rows.slice(limit);
    container.append(h('div', { class: 'bl-more', text: tt("+ ещё {0} на {1}", [rest.length, usd(sum(rest, (r) => r.value))]) }));
  }
}

function openWallet(id) {
  const fs = ['fSearch', 'fGroup', 'fNetwork'];
  for (const f of fs) $(f).value = '';
  $('fNonEmpty').checked = false;
  $('fGas').checked = false;
  S.open.add(id);
  switchTab('wallets');
  document.querySelector(`tr.w-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
}

function renderOverview() {
  const a = aggregates();
  const dust = S.config.dustUsd;
  const unscanned = S.wallets.length - a.scanned;
  const netsWithMoney = [...a.byNet.values()].filter((x) => x.value >= dust).length;
  $('kpis').replaceChildren(
    kpi(tt("Всего на кошельках"), usd(a.total), tt("{0} кошельков · {1} сетей{2}", [S.wallets.length, S.config.networks.length, unscanned ? tt(" · не проверено: {0}", [unscanned]) : '']), 'hero'),
    kpi(tt("Кошельков с деньгами"), `${a.withMoney}`, tt("из {0} · от {1}", [a.scanned, usd(dust)])),
    kpi(tt("Сетей с деньгами"), `${netsWithMoney}`, tt("от {0} суммарно", [usd(dust)])),
    kpi(tt("Нужен газ"), `${a.gas.length}`, tt("пар «кошелёк × сеть»"), a.gas.length ? 'warn' : ''),
    kpi(tt("Последний скан"), ago(S.scan.scannedAt), fmtDate(S.scan.scannedAt)),
  );

  const netRows = [...a.byNet.entries()]
    .map(([net, x]) => ({ id: net, name: networkName(net), value: x.value, extra: [tt("кошельков от {0}: {1}", [usd(dust), x.wallets])] }))
    .filter((r) => r.value > 0)
    .sort((x, y) => y.value - x.value);
  $('netHint').textContent = tt("клик — показать кошельки в этой сети");
  barList($('byNetwork'), netRows, {
    onClick: (r) => {
      $('fNetwork').value = r.id;
      $('fSearch').value = '';
      $('fGroup').value = '';
      $('fNonEmpty').checked = true;
      switchTab('wallets');
    },
  });

  const tokRows = [...a.byToken.entries()]
    .map(([sym, x]) => ({ name: sym, value: x.value, extra: [`${amount(x.amount)} ${sym}`, tt("сетей: {0} · кошельков: {1}", [x.nets.size, x.wallets.size])] }))
    .sort((x, y) => y.value - x.value);
  barList($('byToken'), tokRows, {});

  const top = S.wallets
    .map((w) => ({ w, s: S.sums.get(w.id) }))
    .filter((x) => x.s.total >= dust)
    .sort((x, y) => y.s.total - x.s.total)
    .slice(0, 12);
  $('topWallets').replaceChildren(
    ...(top.length
      ? top.map(({ w, s }) =>
          h('div', { class: 'list-row', onclick: () => openWallet(w.id) },
            h('span', { class: 'c-id', text: `#${w.id}` }),
            h('span', { class: 'grow' }, h('b', { text: walletName(w) }), h('span', { class: 'muted', text: ` · ${w.group}` })),
            h('span', { class: 'muted small', text: s.nets.filter((n) => n.total >= dust).slice(0, 3).map((n) => networkName(n.net)).join(', ') }),
            h('b', { class: 'num', text: usd(s.total) })))
      : [h('div', { class: 'd-empty', text: tt("Нет кошельков с балансом выше порога.") })]),
  );

  const gas = a.gas.sort((x, y) => y.value - x.value).slice(0, 15);
  $('gasList').replaceChildren(
    ...(gas.length
      ? gas.map(({ w, net, value }) =>
          h('div', { class: 'list-row', onclick: () => openWallet(w.id) },
            h('span', { class: 'badge gas', text: tt("⚠ газ") }),
            h('span', { class: 'grow' }, h('b', { text: `#${w.id} ${walletName(w)}` }), h('span', { class: 'muted', text: ` · ${networkName(net)}` })),
            h('span', { class: 'num', text: tt("токенов на {0}", [usd(value)]) })))
      : [h('div', { class: 'd-empty', text: tt("Везде, где есть токены, есть и газ.") })]),
    ...(a.gas.length > 15 ? [h('div', { class: 'bl-more', text: tt("+ ещё {0} — фильтр «нужен газ» во вкладке «Кошельки»", [a.gas.length - 15]) })] : []),
  );

  $('errorsCard').classList.toggle('hidden', !a.errors.size);
  $('errorsList').replaceChildren(
    ...[...a.errors.entries()].map(([net, e]) =>
      h('div', { class: 'list-row' },
        h('span', { class: 'badge err', text: '✕' }),
        h('b', { text: networkName(net) }),
        h('span', { class: 'grow muted', text: e.msg }),
        h('span', { class: 'muted small', text: tt("кошельков: {0}", [e.count]) }))),
  );
}

// --- wallets table ---

function visibleWallets() {
  const q = $('fSearch').value.trim().toLowerCase();
  const group = $('fGroup').value;
  const net = $('fNetwork').value;
  const nonEmpty = $('fNonEmpty').checked;
  const gasOnly = $('fGas').checked;
  const dust = S.config.dustUsd;
  const list = S.wallets.filter((w) => {
    const s = S.sums.get(w.id);
    if (group && w.group !== group) return false;
    if (q) {
      const hay = `${w.id} ${w.label} ${w.group} ${w.address} ${(w.aliases ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (net) {
      const n = s.nets.find((x) => x.net === net);
      if (!n || (n.total < dust && !n.tokens.some((t) => !t.spam && !t.hidden))) return false;
    }
    if (nonEmpty && s.scanned && s.total < dust && !s.errNets.length) return false;
    if (gasOnly && !s.gasNets.length) return false;
    return true;
  });
  const { key, dir } = S.sort;
  const k = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (key === 'total') return k * (S.sums.get(a.id).total - S.sums.get(b.id).total) || a.id - b.id;
    if (key === 'label') return k * walletName(a).localeCompare(walletName(b), LANG, { numeric: true }) || a.id - b.id;
    return k * (a.id - b.id);
  });
  return list;
}

function fillSelect(sel, options, firstLabel) {
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '', text: firstLabel }), ...options.map(([v, t]) => h('option', { value: v, text: t })));
  sel.value = options.some(([v]) => v === cur) ? cur : '';
}

function renderWallets() {
  const groups = [...new Set(S.wallets.map((w) => w.group))].sort((a, b) => a.localeCompare(b, LANG, { numeric: true }));
  fillSelect($('fGroup'), groups.map((g) => [g, g]), tt("Все группы"));
  fillSelect($('fNetwork'), NETWORKS.filter((n) => S.config.networks.includes(n.id)).map((n) => [n.id, n.name]), tt("Все сети"));

  for (const th of document.querySelectorAll('th.sortable')) {
    th.classList.toggle('sorted', th.dataset.sort === S.sort.key);
    th.classList.toggle('asc', th.dataset.sort === S.sort.key && S.sort.dir === 'asc');
  }

  const list = visibleWallets();
  const dust = S.config.dustUsd;
  const showSpam = $('fSpam').checked;
  const tbody = $('walletRows');
  const frag = document.createDocumentFragment();
  for (const w of list) {
    const s = S.sums.get(w.id);
    const open = S.open.has(w.id);
    const chips = [];
    if (!s.scanned) chips.push(h('span', { class: 'muted small', text: tt("не проверен") }));
    for (const n of s.nets) {
      if (n.total < dust && !n.needGas) continue;
      chips.push(h('span', { class: `chip${n.needGas ? ' gas' : ''}`, title: n.needGas ? tt("Есть токены, но нет нативной монеты на газ") : '' },
        n.needGas ? '⚠ ' : '', networkName(n.net), ' ', h('b', { text: usdShort(n.total) }), n.needGas ? tt(" · нет газа") : ''));
    }
    if (s.errNets.length) chips.push(h('span', { class: 'chip err', title: s.errNets.map(networkName).join(', ') }, tt("✕ ошибки: {0}", [s.errNets.length])));
    if (s.scanned && !chips.length) {
      chips.push(h('span', { class: 'muted small', text: s.total > 0 ? tt("мелочь {0}", [usd(s.total)]) : tt("пусто") }));
    }
    if (s.unpricedReal) chips.push(h('span', { class: 'chip', title: tt("Монеты без цены у Alchemy — проверь вручную в деталях") }, tt("? без цены: {0}", [s.unpricedReal])));

    frag.append(h('tr', { class: `w-row${open ? ' open' : ''}${s.scanned && s.total < dust ? ' dim' : ''}`, 'data-id': w.id },
      h('td', { class: 'c-sel' }, h('input', { type: 'checkbox', 'data-sel': w.id, checked: S.selected.has(w.id) })),
      h('td', { class: 'c-id', text: w.id }),
      h('td', null, h('div', { class: 'w-label', text: walletName(w) }), h('div', { class: 'w-group', text: w.group })),
      h('td', null, h('span', { class: 'addr mono' }, shortAddr(w.address),
        h('button', { class: 'icon', 'data-act': 'copy', title: tt("Скопировать адрес"), text: '⧉' }))),
      h('td', null, h('div', { class: 'chips' }, chips)),
      h('td', { class: 'c-num w-total', text: s.scanned ? usd(s.total) : '—' }),
      h('td', { class: 'c-act' },
        h('button', { class: 'icon', 'data-act': 'scan', title: tt("Пересканировать этот кошелёк"), text: '↻' }),
        h('button', { class: 'icon', 'data-act': 'edit', title: tt("Переименовать / сменить группу"), text: '✎' }))));
    if (open) frag.append(detailsRow(w, s, showSpam));
  }
  tbody.replaceChildren(frag);

  const empty = $('walletsEmpty');
  empty.classList.toggle('hidden', list.length > 0);
  empty.textContent = S.wallets.length ? tt("Под фильтр ничего не попало.") : tt("Кошельков пока нет — добавь их во вкладке «Добавить».");

  const visTotal = sum(list, (w) => S.sums.get(w.id).total);
  $('walletsFoot').textContent = tt("Показано {0} из {1} · сумма по показанным: {2}", [list.length, S.wallets.length, usd(visTotal)]);
  const visIds = list.map((w) => w.id);
  $('selAll').checked = visIds.length > 0 && visIds.every((id) => S.selected.has(id));
  renderSelBar();
}

function detailsRow(w, s, showSpam) {
  const dust = S.config.dustUsd;
  const meta = h('div', { class: 'd-meta' },
    h('span', null, tt("Адрес: "), h('span', { class: 'mono', text: w.address })),
    w.source ? h('span', { text: tt("Источник: {0}", [w.source]) }) : null,
    w.aliases?.length ? h('span', { text: tt("Также: {0}", [w.aliases.join('; ')]) }) : null,
    h('span', { text: tt("Проверен: {0}", [s.scanned ? fmtDate(s.scannedAt) : tt("нет")]) }),
    h('a', { href: `https://debank.com/profile/${w.address}`, target: '_blank', rel: 'noopener noreferrer', text: 'DeBank ↗' }));

  const cards = [];
  for (const n of s.nets) {
    const visible = n.tokens.filter((t) => showSpam || (!t.spam && !t.hidden && t.value != null) || (t.native && !t.hidden));
    const hiddenCount = n.tokens.length - visible.length;
    if (!visible.length && !n.error && !(showSpam && hiddenCount)) continue;
    const explorer = explorerAddressUrl(n.net, w.address);
    const rows = visible
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
      .map((t) => h('tr', { class: (t.value ?? 0) < dust || t.spam || t.hidden ? 'dust' : '' },
        h('td', null, h('div', { class: 'sym', text: t.symbol }), t.name && t.name !== t.symbol ? h('div', { class: 'tname', text: t.name, title: t.name }) : null),
        h('td', { class: 'c-num', text: amount(t.amount) }),
        h('td', { class: 'c-num muted', text: price(t.price) }),
        h('td', { class: 'c-num', text: usd(t.value) }),
        h('td', { class: 'c-act' },
          t.spam ? h('span', { class: 'badge spam', text: tt("спам?") }) : null,
          t.hidden
            ? h('button', { class: 'icon', 'data-act': 'unhide', 'data-key': hiddenKey(n.net, t.token), title: tt("Вернуть монету"), text: '↺' })
            : t.native ? null : h('button', { class: 'icon', 'data-act': 'hide', 'data-key': hiddenKey(n.net, t.token), title: tt("Скрыть эту монету везде (спам, фейковая цена)"), text: '✕' }))));
    cards.push(h('div', { class: 'd-net' },
      h('div', { class: 'd-net-head' },
        h('span', { class: 'name', text: networkName(n.net) }),
        h('b', { class: 'num', text: usd(n.total) }),
        n.needGas ? h('span', { class: 'badge gas', text: tt("⚠ нет газа") }) : null,
        n.error ? h('span', { class: 'badge err', text: tt("✕ ошибка") }) : null,
        h('span', { class: 'spacer' }),
        explorer ? h('a', { href: explorer, target: '_blank', rel: 'noopener noreferrer', text: tt("эксплорер ↗") }) : null),
      n.error ? h('div', { class: 'd-empty', text: n.error }) : null,
      rows.length ? h('table', { class: 'tokens' }, h('tbody', null, rows)) : null,
      !showSpam && hiddenCount ? h('div', { class: 'd-empty', text: tt("+ {0} монет без цены / спам / скрытых — включи «показывать спам» сверху", [hiddenCount]) }) : null));
  }
  if (!cards.length) cards.push(h('div', { class: 'd-empty', text: s.scanned ? tt("На включённых сетях ничего нет.") : tt("Ещё не проверен — нажми ↻.") }));
  return h('tr', { class: 'd-row' }, h('td', { colspan: 7 }, meta, h('div', { class: 'd-nets' }, cards)));
}

function renderSelBar() {
  const n = S.selected.size;
  $('selBar').classList.toggle('hidden', n === 0);
  $('selText').textContent = tt("Выбрано: {0}", [n]);
}

async function setHidden(key, hide) {
  const set = new Set(S.config.hiddenTokens);
  if (hide) set.add(key);
  else set.delete(key);
  S.config = await api('/api/config', { hiddenTokens: [...set] });
  recompute();
  renderAll();
}

async function onWalletAction(act, id, el) {
  const w = S.wallets.find((x) => x.id === id);
  if (act === 'copy') {
    await navigator.clipboard.writeText(w.address);
    toast(tt("Адрес скопирован"));
  } else if (act === 'scan') {
    await startScan([id]);
  } else if (act === 'edit') {
    const label = prompt(tt("Название кошелька"), w.label);
    if (label == null) return;
    const group = prompt(tt("Группа"), w.group);
    if (group == null) return;
    await api(`/api/wallets/${id}`, { label, group }, 'PATCH');
    await loadState();
  } else if (act === 'hide') {
    await setHidden(el.dataset.key, true);
  } else if (act === 'unhide') {
    await setHidden(el.dataset.key, false);
  }
}

function exportCsv() {
  const list = visibleWallets();
  const showSpam = $('fSpam').checked;
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['#', tt("Группа"), tt("Название"), tt("Адрес"), tt("Сеть"), tt("Монета"), tt("Контракт"), tt("Количество"), tt("Цена $"), tt("Стоимость $"), tt("Пометка")].join(';')];
  for (const w of list) {
    const s = S.sums.get(w.id);
    let any = false;
    for (const n of s.nets) {
      for (const t of n.tokens) {
        if (!showSpam && (t.spam || t.hidden)) continue;
        any = true;
        const mark = [t.spam && tt("спам?"), t.hidden && tt("скрыта"), n.needGas && t.native === false && tt("нет газа")].filter(Boolean).join(', ');
        lines.push([w.id, w.group, walletName(w), w.address, networkName(n.net), t.symbol, t.token ?? 'native', t.amount, t.price ?? '', t.value != null ? t.value.toFixed(2) : '', mark].map(esc).join(';'));
      }
    }
    if (!any) lines.push([w.id, w.group, walletName(w), w.address, '', '', '', '', '', s.scanned ? '0' : '', s.scanned ? tt("пусто") : tt("не проверен")].map(esc).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `balances-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// --- add tab ---

function parseAddressLines(text) {
  const out = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/0x[a-fA-F0-9]{40}/);
    if (!m) {
      bad++;
      continue;
    }
    const label = line.replace(m[0], '').replace(/^[\s,;|:\t–—-]+|[\s,;|:\t–—-]+$/g, '').trim();
    out.push({ address: m[0], label });
  }
  return { out, bad };
}

function renderAdd() {
  const { out, bad } = parseAddressLines($('addrInput').value);
  $('addrCount').textContent = out.length || bad ? tt("найдено адресов: {0}{1}", [out.length, bad ? tt(", строк без адреса: {0}", [bad]) : '']) : '';
}

function nextSeedNumber() {
  let max = 0;
  for (const w of S.wallets) {
    const m = /^(?:Сид|Seed) (\d+)$/.exec(w.group);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (const p of S.preview ?? []) {
    const m = /^(?:Сид|Seed) (\d+)$/.exec(p.group);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function deriveFromSeeds() {
  const ta = $('seedInput');
  const passEl = $('seedPass');
  const text = ta.value;
  const passphrase = passEl.value;
  if (!text.trim()) return toast(tt("Вставь сид-фразы или ключи"));
  const count = Math.min(200, Math.max(1, Number($('seedCount').value) || 1));
  const start = Math.max(0, (Number($('seedStart').value) || 1) - 1);
  const pathKind = $('seedPath').value;
  const { items, badLines, dupLines } = parseSecretLines(text);

  // wipe secrets from the page right away; keep only lines we could not read so they can be fixed
  ta.value = badLines.map((b) => b.rawLine).join('\n');
  passEl.value = '';

  $('deriveBtn').disabled = true;
  const status = $('seedStatus');
  const preview = [];
  const failed = [...badLines.map((b) => b.lineNo)];
  let seedNo = nextSeedNumber();
  let keyNo = 1 + S.wallets.filter((w) => (w.group === 'Приватные ключи' || w.group === 'Private keys')).length;
  // addresses are the dedup key: the same seed always gives the same addresses, so a seed imported
  // earlier (or pasted twice in another form) is recognised without ever storing the phrase itself
  const inList = new Map(S.wallets.map((w) => [w.address.toLowerCase(), w]));
  const inBatch = new Map();
  const stats = { seeds: 0, keys: 0, knownSeeds: 0, overlap: 0 };
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      status.textContent = tt("Обрабатываю {0} / {1}…", [i + 1, items.length]);
      if (i % 5 === 0) await new Promise((r) => setTimeout(r)); // let the UI breathe
      let addrs;
      try {
        addrs = await deriveAddresses(it, { count, start, pathKind, passphrase });
      } catch {
        failed.push(it.lineNo);
        continue;
      }
      let group;
      let labelOf;
      let source;
      if (it.kind === 'seed') {
        stats.seeds++;
        // seen this seed before → put its new accounts into the same group instead of "Сид N+1"
        const prev = addrs.map((a) => inList.get(a.address.toLowerCase())).find((w) => w);
        if (prev && addrs.every((a) => inList.has(a.address.toLowerCase()))) stats.knownSeeds++;
        group = it.label || (prev?.source?.startsWith('seed') ? prev.group : null) || tt("Сид {0}", [seedNo++]);
        labelOf = (a) => tt("Акк {0}", [a.index + 1]);
        source = (a) => `seed «${group}» ${a.path}`;
      } else if (it.kind === 'key') {
        stats.keys++;
        group = tt("Приватные ключи");
        labelOf = () => it.label || tt("Ключ {0}", [keyNo++]);
        source = () => 'private key';
      } else {
        group = tt("Адреса");
        labelOf = () => it.label;
        source = () => 'manual';
      }
      for (const a of addrs) {
        const key = a.address.toLowerCase();
        if (inBatch.has(key)) {
          stats.overlap++; // e.g. a private key that is also account 1 of a seed in this list
          continue;
        }
        const existing = inList.get(key);
        const row = { lineNo: it.lineNo, group, label: labelOf(a), address: a.address, path: a.path, source: source(a), exists: Boolean(existing), existingName: existing ? `${existing.group} · ${walletName(existing)}` : '' };
        inBatch.set(key, row);
        preview.push(row);
      }
      it.secret = null;
      it.rawLine = null;
    }
  } finally {
    $('deriveBtn').disabled = false;
  }
  failed.sort((a, b) => a - b);
  const fresh = preview.filter((p) => !p.exists).length;
  const parts = [tt("Сидов: {0}", [stats.seeds]), stats.keys && tt("ключей: {0}", [stats.keys]), tt("новых адресов: {0}", [fresh])];
  if (dupLines.length) {
    const list = dupLines.slice(0, 15).map((d) => `${d.lineNo}=${d.ofLine}`).join(', ');
    parts.push(tt("повторы в списке пропущены: {0} (строка=строка: {1}{2})", [dupLines.length, list, dupLines.length > 15 ? '…' : '']));
  }
  if (stats.knownSeeds) parts.push(tt("уже были импортированы раньше: {0}", [stats.knownSeeds]));
  if (stats.overlap) parts.push(tt("совпавших адресов внутри списка: {0}", [stats.overlap]));
  if (failed.length) parts.push(tt("не распознаны строки: {0} (остались в поле)", [failed.slice(0, 30).join(', ')]));
  status.textContent = parts.filter(Boolean).join(' · ');
  S.preview = preview;
  renderPreview();
}

function renderPreview() {
  const p = S.preview;
  $('previewCard').classList.toggle('hidden', !p?.length);
  if (!p?.length) return;
  const fresh = p.filter((x) => !x.exists).length;
  $('previewInfo').textContent = tt("{0} адресов · новых: {1} · уже в списке: {2} (их не добавим повторно)", [p.length, fresh, p.length - fresh]);
  $('previewAdd').disabled = fresh === 0;
  $('previewAdd').textContent = fresh ? tt("Добавить {0} новых", [fresh]) : tt("Новых нет");
  // new ones first, already-known ones after
  const rows = [...p].sort((a, b) => a.exists - b.exists);
  $('previewRows').replaceChildren(...rows.map((x) =>
    h('tr', { class: x.exists ? 'dim' : '' },
      h('td', { class: 'c-id', text: x.lineNo }),
      h('td', { text: x.group }),
      h('td', { text: x.label }),
      h('td', null, h('span', { class: 'mono', text: x.address }), x.exists ? h('span', { class: 'badge spam', text: tt(" уже есть: {0}", [x.existingName]) }) : null),
      h('td', { class: 'mono muted', text: x.path }))));
}

// --- settings ---

function renderSettings() {
  const c = S.config;
  $('keyStatus').replaceChildren(c.hasKey ? h('span', { class: 'badge ok', text: tt("✓ ключ сохранён ({0})", [c.keyHint]) }) : h('span', { class: 'badge err', text: tt("ключ не задан") }));
  $('dustInput').value = c.dustUsd;
  if (!S.netDraft) S.netDraft = new Set(c.networks);
  const st = c.networkStatus ?? {};
  $('netGrid').replaceChildren(...NETWORKS.map((n) => {
    const s = st[n.id];
    const box = h('input', { type: 'checkbox', checked: S.netDraft.has(n.id) });
    box.addEventListener('change', () => {
      if (box.checked) S.netDraft.add(n.id);
      else S.netDraft.delete(n.id);
      renderNetCount();
    });
    return h('label', { title: s?.error ?? n.id },
      h('span', { class: 'l' }, box, n.name),
      s ? h('span', { class: `badge ${s.ok ? 'ok' : 'err'}`, text: s.ok ? '✓' : tt("✕ нет") }) : null);
  }));
  renderNetCount();
  const hidden = c.hiddenTokens;
  $('hiddenList').replaceChildren(...(hidden.length
    ? hidden.map((key) => {
        const [net, token] = key.split(':');
        return h('div', { class: 'list-row' },
          h('span', { class: 'grow' }, h('b', { text: networkName(net) }), ' ', h('span', { class: 'mono muted', text: token })),
          h('button', { onclick: () => guarded(() => setHidden(key, false)), text: tt("Вернуть") }));
      })
    : [h('div', { class: 'd-empty', text: tt("Ничего не скрыто.") })]));
}

function renderNetCount() {
  const st = S.config.networkStatus ?? {};
  const bad = NETWORKS.filter((n) => st[n.id] && !st[n.id].ok).length;
  $('netCount').textContent = tt("включено {0} из {1}{2}", [S.netDraft.size, NETWORKS.length, st.checkedAt ? tt(" · проверено {0}, не работают: {1}", [ago(st.checkedAt), bad]) : '']);
}

// ---------- wiring ----------

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
$('scanAllBtn').addEventListener('click', () => startScan());

for (const id of ['fSearch', 'fGroup', 'fNetwork', 'fNonEmpty', 'fGas', 'fSpam']) {
  $(id).addEventListener(id === 'fSearch' ? 'input' : 'change', () => renderWallets());
}
for (const th of document.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    S.sort = S.sort.key === key ? { key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'total' ? 'desc' : 'asc' };
    renderWallets();
  });
}
$('walletRows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const actEl = e.target.closest('[data-act]');
  const row = tr.classList.contains('d-row') ? tr.previousElementSibling : tr;
  const id = Number(row?.dataset.id);
  if (actEl) {
    e.stopPropagation();
    guarded(() => onWalletAction(actEl.dataset.act, id, actEl));
    return;
  }
  if (e.target.closest('a, input, button') || !tr.classList.contains('w-row')) return;
  if (S.open.has(id)) S.open.delete(id);
  else S.open.add(id);
  renderWallets();
});
$('walletRows').addEventListener('change', (e) => {
  const id = Number(e.target.dataset.sel);
  if (!id) return;
  if (e.target.checked) S.selected.add(id);
  else S.selected.delete(id);
  renderSelBar();
});
$('selAll').addEventListener('change', (e) => {
  for (const w of visibleWallets()) {
    if (e.target.checked) S.selected.add(w.id);
    else S.selected.delete(w.id);
  }
  renderWallets();
});
$('clearSelBtn').addEventListener('click', () => {
  S.selected.clear();
  renderWallets();
});
$('scanSelBtn').addEventListener('click', () => startScan([...S.selected]));
$('groupSelBtn').addEventListener('click', () => guarded(async () => {
  const group = prompt(tt("Новая группа для {0} кошельков", [S.selected.size]));
  if (!group) return;
  for (const id of S.selected) await api(`/api/wallets/${id}`, { group }, 'PATCH');
  await loadState();
}));
$('delSelBtn').addEventListener('click', () => guarded(async () => {
  if (!confirm(tt("Удалить из списка {0} кошельков? (Сами кошельки не пострадают — это только список в панели.)", [S.selected.size]))) return;
  await api('/api/wallets/delete', { ids: [...S.selected] });
  S.selected.clear();
  await loadState();
}));
$('rescanErrBtn').addEventListener('click', () => {
  const ids = S.wallets.filter((w) => S.sums.get(w.id).errNets.length).map((w) => w.id);
  if (!ids.length) return toast(tt("Кошельков с ошибками нет"));
  startScan(ids);
});
$('delEmptyBtn').addEventListener('click', () => guarded(async () => {
  const empty = S.wallets.filter((w) => {
    const s = S.sums.get(w.id);
    if (!s.scanned || s.errNets.length) return false;
    // keep wallets with tokens Alchemy can't price — could be a fresh airdrop
    return !s.nets.some((n) => n.tokens.some((t) => !t.spam && !t.hidden && (t.value == null || t.value >= 0.01)));
  });
  if (!empty.length) return toast(tt("Пустых проверенных кошельков нет"));
  if (!confirm(tt("Удалить из списка {0} проверенных кошельков, где ничего нет? Кошельки с монетами без цены останутся.", [empty.length]))) return;
  await api('/api/wallets/delete', { ids: empty.map((w) => w.id) });
  await loadState();
}));
$('exportBtn').addEventListener('click', exportCsv);

$('addrInput').addEventListener('input', renderAdd);
$('addAddrBtn').addEventListener('click', () => guarded(async () => {
  const { out } = parseAddressLines($('addrInput').value);
  if (!out.length) return toast(tt("Не нашёл ни одного адреса 0x…"));
  const group = $('addrGroup').value.trim() || tt("Адреса");
  const r = await api('/api/wallets', { wallets: out.map((x) => ({ ...x, group, source: 'manual' })) });
  $('addrInput').value = '';
  renderAdd();
  toast(tt("Добавлено: {0}{1}{2}", [r.added, r.merged ? tt(", уже были: {0}", [r.merged]) : '', r.invalid.length ? tt(", неверных: {0}", [r.invalid.length]) : '']));
  await loadState();
}));
$('deriveBtn').addEventListener('click', () => guarded(deriveFromSeeds));
$('seedFileBtn').addEventListener('click', () => $('seedFile').click());
$('seedFile').addEventListener('change', () => guarded(async () => {
  const file = $('seedFile').files[0];
  $('seedFile').value = '';
  if (!file) return;
  if (file.size > 5_000_000) return toast(tt("Файл слишком большой (больше 5 МБ)"));
  const text = await file.text();
  const ta = $('seedInput');
  ta.value = ta.value.trim() ? `${ta.value.trim()}\n${text}` : text;
  $('seedStatus').textContent = tt("Из файла загружено строк: {0}. Нажми «Получить адреса».", [text.split(/\r?\n/).filter((l) => l.trim()).length]);
}));
$('previewCancel').addEventListener('click', () => {
  S.preview = null;
  renderPreview();
});
$('previewAdd').addEventListener('click', () => guarded(async () => {
  const fresh = S.preview.filter((x) => !x.exists);
  const r = await api('/api/wallets', { wallets: fresh.map(({ address, label, group, source }) => ({ address, label, group, source })) });
  S.preview = null;
  renderPreview();
  $('seedStatus').textContent = '';
  toast(tt("Добавлено: {0}{1}", [r.added, r.merged ? tt(", совпали с уже добавленными: {0}", [r.merged]) : '']));
  await loadState();
}));

$('saveKeyBtn').addEventListener('click', () => guarded(async () => {
  const k = $('keyInput').value.trim();
  if (!k) return toast(tt("Вставь ключ"));
  S.config = await api('/api/config', { apiKey: k });
  $('keyInput').value = '';
  toast(tt("Ключ сохранён — проверяю сети…"));
  renderAll();
  S.config.networkStatus = await api('/api/networks/check', {});
  renderAll();
  const bad = Object.entries(S.config.networkStatus).filter(([k2, v]) => k2 !== 'checkedAt' && !v.ok).length;
  toast(bad ? tt("Ключ работает, но {0} сетей недоступны — см. список ниже", [bad]) : tt("Ключ работает во всех сетях"));
}));
$('resetAllBtn').addEventListener('click', () => guarded(async () => {
  if (!S.wallets.length) return toast(tt("Список и так пуст"));
  if (!confirm(tt("Удалить из панели все {0} кошельков и результаты сканов?\n\nКлюч Alchemy и настройки сетей останутся. Деньги на кошельках это не затрагивает.", [S.wallets.length]))) return;
  const r = await api('/api/reset', {});
  S.open.clear();
  S.selected.clear();
  S.preview = null;
  renderPreview();
  await loadState();
  toast(tt("Удалено кошельков: {0}. Можно заливать фразы заново — дубли отсеются сами.", [r.removed]), 6000);
  switchTab('add');
}));
$('saveDustBtn').addEventListener('click', () => guarded(async () => {
  S.config = await api('/api/config', { dustUsd: Number($('dustInput').value) });
  recompute();
  toast(tt("Порог сохранён"));
  renderAll();
}));
$('netAllBtn').addEventListener('click', () => {
  S.netDraft = new Set(NETWORKS.map((n) => n.id));
  renderSettings();
});
$('netCoreBtn').addEventListener('click', () => {
  S.netDraft = new Set(NETWORKS.filter((n) => n.core).map((n) => n.id));
  renderSettings();
});
$('netDisableBadBtn').addEventListener('click', () => {
  const st = S.config.networkStatus ?? {};
  for (const n of NETWORKS) if (st[n.id] && !st[n.id].ok) S.netDraft.delete(n.id);
  renderSettings();
});
$('saveNetsBtn').addEventListener('click', () => guarded(async () => {
  S.config = await api('/api/config', { networks: [...S.netDraft] });
  recompute();
  toast(tt("Сети сохранены"));
  renderAll();
}));
$('netCheckBtn').addEventListener('click', () => guarded(async () => {
  $('netCheckBtn').disabled = true;
  try {
    await api('/api/config', { networks: [...S.netDraft] });
    S.config.networkStatus = await api('/api/networks/check', {});
    S.config.networks = [...S.netDraft];
    renderSettings();
    toast(tt("Проверка сетей завершена"));
  } finally {
    $('netCheckBtn').disabled = false;
  }
}));

const sweep = mountSweep({ S, h, $, api, toast, usd, amount, guarded, walletName });
const activityTab = mountActivity({ S, h, $, api, toast, guarded, walletName });

// boot
translateDom();
$('langBtn').textContent = LANG === 'ru' ? 'EN' : 'RU';
$('langBtn').addEventListener('click', () => setLang(LANG === 'ru' ? 'en' : 'ru'));
const initialTab = location.hash.slice(1);
await guarded(loadState);
switchTab(['overview', 'wallets', 'add', 'activity', 'sweep', 'settings'].includes(initialTab) ? initialTab : 'overview');
if (S.job?.running) pollJob();
setInterval(() => { if (!S.job?.running) renderProgress(); }, 30_000);
