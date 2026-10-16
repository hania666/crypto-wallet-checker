// "Активность" tab: which wallets were really used (swaps, deposits out, contracts), ranked,
// plus a "5 for today" list with a done-mark so the user can feed a reward checker 5 wallets a day.
import { tt, tr, LOCALE } from './i18n.js';

export function mountActivity(ctx) {
  const { S, h, $, api, toast, guarded, walletName } = ctx;
  const A = { data: null, polling: null, hideMarked: true, minScore: 1, showAll: false };

  const chainInfo = () => Object.fromEntries((A.data?.chains ?? []).map((c) => [c.id, c]));
  const short = (x) => `${x.slice(0, 6)}…${x.slice(-4)}`;
  const day = (iso) => (iso ? iso.slice(0, 10) : '');
  const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

  async function load() {
    A.data = await api('/api/activity');
    if (A.data.job?.running) poll();
  }

  function poll() {
    clearTimeout(A.polling);
    A.polling = setTimeout(async () => {
      try {
        const job = await api('/api/activity/job');
        A.data.job = job;
        if (job.running) poll();
        else {
          await load();
          toast(job.lastError ? tt("Проверка остановилась: {0}", [tr(job.lastError)]) : tt("Проверка активности готова"));
        }
      } catch {
        poll();
      }
      render();
    }, 1500);
  }

  // what the wallet did, as short readable chips per chain
  function chips(r) {
    const info = chainInfo();
    const out = [];
    for (const [cid, c] of Object.entries(r.chains)) {
      const parts = [];
      if (c.polymarket) parts.push(`Polymarket ${c.polymarket}`);
      if (c.swaps) parts.push(tt("свапов {0}", [c.swaps]));
      if (c.outExt) parts.push(tt("наружу {0}", [c.outExt]));
      if (c.contracts) parts.push(tt("контракты {0}", [c.contracts]));
      if (c.inExt) parts.push(tt("приходило {0}", [c.inExt]));
      if (c.otherSent) parts.push(tt("прочих tx {0}", [c.otherSent]));
      if (!parts.length) continue;
      out.push(h('span', { class: `chip${c.polymarket || c.swaps ? ' good' : ''}`, title: c.first ? `${day(c.first)} … ${day(c.last)}` : '' },
        h('b', { text: info[cid]?.name ?? cid }), ' ', parts.join(' · ')));
    }
    return out;
  }

  function peersView(r) {
    const info = chainInfo();
    return (r.peers ?? []).filter((p) => p.out).slice(0, 3).map((p) => {
      const url = info[p.chain]?.explorer ? `${info[p.chain].explorer}/address/${p.address}` : null;
      const what = p.label ?? (p.contract ? tt("контракт") : tt("адрес"));
      const shared = p.sharedWallets > 1 ? tt(" · сюда слали {0} твоих", [p.sharedWallets]) : '';
      return h('div', { class: 'small muted' },
        `→ ${info[p.chain]?.name ?? p.chain}: ${what} `,
        url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'mono', text: short(p.address) }) : short(p.address),
        ` ×${p.out}${shared}`);
    });
  }

  function rows() {
    const marks = A.data?.marks ?? {};
    return S.wallets
      .map((w) => ({ w, r: A.data?.wallets?.[w.address.toLowerCase()], mark: marks[w.address.toLowerCase()] }))
      .filter((x) => x.r && x.r.score > 0)
      .sort((x, y) => y.r.score - x.r.score || x.w.id - y.w.id);
  }

  async function setMark(address, on) {
    const r = await api('/api/activity/mark', { address, on });
    A.data.marks = r.marks;
    render();
  }

  function walletRow(x, rank) {
    const { w, r, mark } = x;
    const box = h('input', { type: 'checkbox', checked: Boolean(mark), title: tt("Уже добавил на сайт") });
    box.addEventListener('change', () => guarded(() => setMark(w.address, box.checked)));
    return h('tr', { class: mark ? 'dim' : '' },
      h('td', { class: 'c-id', text: rank }),
      h('td', null, h('div', { class: 'w-label', text: `#${w.id} ${walletName(w)}` }), h('div', { class: 'w-group', text: w.group })),
      h('td', null, h('span', { class: 'addr mono' }, short(w.address),
        h('button', { class: 'icon', title: tt("Скопировать полный адрес"), text: '⧉', onclick: () => guarded(async () => { await navigator.clipboard.writeText(w.address); toast(tt("Адрес скопирован")); }) }))),
      h('td', { class: 'c-num w-total', text: r.score }),
      h('td', null, h('div', { class: 'chips' }, chips(r)), ...peersView(r)),
      h('td', { class: 'c-act' }, h('label', { class: 'chk' }, box, mark ? day(mark) : tt("добавил"))));
  }

  function render() {
    const root = $('activityRoot');
    if (!root) return;
    if (!A.data) {
      root.replaceChildren(h('div', { class: 'd-empty', text: tt("Загружаю…") }));
      guarded(async () => { await load(); render(); });
      return;
    }
    const job = A.data.job ?? {};
    const all = rows();
    const marks = A.data.marks ?? {};
    const todayCount = Object.values(marks).filter(isToday).length;
    const next = all.filter((x) => !x.mark).slice(0, Math.max(0, 5 - todayCount));
    const strong = all.filter((x) => Object.values(x.r.chains).some((c) => c.swaps || c.polymarket)).length;

    const ownArea = h('textarea', { rows: 2, spellcheck: 'false', placeholder: tt("0x… основной кошелёк, с которого пополнял остальные") });
    ownArea.value = (A.data.ownExtra ?? []).join('\n');

    const startBtn = h('button', { class: 'primary', disabled: job.running, text: job.running ? tt("Проверяю…") : A.data.scannedAt ? tt("Проверить заново") : tt("Проверить активность") });
    startBtn.addEventListener('click', () => guarded(async () => {
      const list = ownArea.value.split(/[\s,;]+/).filter(Boolean);
      A.data.ownExtra = (await api('/api/activity/own', { list })).ownExtra;
      A.data.job = await api('/api/activity/scan', {});
      poll();
      render();
    }));

    const head = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: tt("Активность кошельков") }),
        h('span', { class: 'muted small', text: A.data.scannedAt ? tt("проверено: {0}", [new Date(A.data.scannedAt).toLocaleString(LOCALE)]) : tt("ещё не проверялось") })),
      h('p', { class: 'muted' }, tt("Смотрю историю в 11 сетях: свапы на DEX, переводы на внешние адреса (так выглядят депы в казино, Polymarket, на биржи), вызовы контрактов. "),
        tt("Спам и «отравление адреса» (нулевые и копеечные переводы с похожих адресов) не считаются. Переводы между твоими кошельками и сегодняшний сбор — тоже.")),
      h('label', { class: 'small', text: tt("Мои другие адреса — переводы с них/на них не считаются внешней активностью:") }),
      ownArea,
      h('div', { class: 'row' },
        job.running ? h('span', { class: 'muted small', text: `${tr(job.stage)}… ${job.done}/${job.total}` }) : h('span', { class: 'muted small', text: (A.data.errors ?? []).length ? tt("предупреждения: {0}", [A.data.errors.map(tr).join('; ')]) : '' }),
        h('span', { class: 'spacer' }), startBtn));

    if (!A.data.scannedAt) {
      root.replaceChildren(head);
      return;
    }

    const kpis = h('div', { class: 'kpis' },
      kpiBox(tt("Кошельков с активностью"), `${all.length}`, tt("из {0}", [S.wallets.length]), 'hero'),
      kpiBox(tt("Свапы / Polymarket"), `${strong}`, tt("самые сильные кандидаты")),
      kpiBox(tt("Добавлено сегодня"), `${todayCount} / 5`, tt("лимит сайта в день")),
      kpiBox(tt("Добавлено всего"), `${Object.keys(marks).length}`, tt("осталось: {0}", [all.filter((x) => !x.mark).length])),
      kpiBox(tt("Общие адреса"), `${(A.data.collectors ?? []).length}`, tt("куда слали 50+ твоих кошельков — не считаю")));

    const todayCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: tt("На сегодня") }),
        h('span', { class: 'muted small', text: todayCount >= 5 ? tt("на сегодня лимит выбран — продолжим завтра") : tt("лучшие из ещё не добавленных; отметь «добавил», когда внесёшь на сайт") })),
      next.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'wallets' }, h('tbody', null, next.map((x, i) => walletRow(x, i + 1)))))
        : h('div', { class: 'd-empty', text: todayCount >= 5 ? tt("5 из 5 на сегодня ✓") : tt("Все активные кошельки уже добавлены.") }));

    const shown = all.filter((x) => (!A.hideMarked || !x.mark) && x.r.score >= A.minScore);
    const hideBox = h('input', { type: 'checkbox', checked: A.hideMarked });
    hideBox.addEventListener('change', () => { A.hideMarked = hideBox.checked; render(); });
    const minInput = h('input', { type: 'number', value: A.minScore, min: 0, step: 1 });
    minInput.addEventListener('change', () => { A.minScore = Number(minInput.value) || 0; render(); });
    const limit = A.showAll ? shown.length : 100;
    const listCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: tt("Все активные, по убыванию") }),
        h('label', { class: 'chk' }, hideBox, tt("скрыть уже добавленные")),
        h('label', null, tt("мин. балл "), minInput),
        h('span', { class: 'muted small', text: tt("показано {0} из {1}", [Math.min(limit, shown.length), shown.length]) })),
      h('p', { class: 'muted small', text: tt("Балл: Polymarket ×10, свап ×3, перевод наружу ×2, контракт ×1.5, входящий перевод ×1, прочие транзакции ×0.5. Наведи на сеть — даты первой и последней активности.") }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'wallets' },
        h('thead', null, h('tr', null, h('th', { text: '№' }), h('th', { text: tt("Кошелёк") }), h('th', { text: tt("Адрес") }), h('th', { class: 'c-num', text: tt("Балл") }), h('th', { text: tt("Что делал") }), h('th', { text: '' }))),
        h('tbody', null, shown.slice(0, limit).map((x, i) => walletRow(x, i + 1))))),
      shown.length > limit ? h('div', { class: 'row' }, h('button', { text: tt("Показать все {0}", [shown.length]), onclick: () => { A.showAll = true; render(); } })) : null);

    root.replaceChildren(head, kpis, todayCard, listCard);
  }

  function kpiBox(label, value, sub, cls = '') {
    return h('div', { class: `kpi ${cls}` }, h('div', { class: 'k-label', text: label }), h('div', { class: 'k-value num', text: value }), h('div', { class: 'k-sub', text: sub }));
  }

  return { render };
}
