// "Сборщик" tab: plan (dry run) → keys → confirm → send. All signing happens here in the page.
import { NETWORK_BY_ID } from './networks.js';
import {
  chainRegistry, candidates, buildPlan, planTotals, executePlan, loadKeys, forgetKeys, hasKey, keyCount, resetProviders,
  applyBus, chainDelivered, reconcile,
} from './sweep.js';

const { ethers } = window;

export function mountSweep(ctx) {
  const { S, h, $, api, toast, usd, amount, guarded, walletName } = ctx;
  const SW = { plan: null, building: false, running: false, stopReq: false, netDraft: null, alchemyKey: null, keyStatus: '' };

  const registry = () => chainRegistry(Boolean(S.config.testMode));
  const chainName = (net) => registry()[net]?.name ?? NETWORK_BY_ID[net]?.name ?? net;
  const txUrl = (net, hash) => {
    const base = NETWORK_BY_ID[net]?.explorer;
    return base ? `${base}/tx/${hash}` : null;
  };
  const gwei = (wei) => {
    const g = Number(ethers.formatUnits(wei, 'gwei'));
    return g >= 1 ? g.toFixed(2) : g.toPrecision(3);
  };
  const nat = (wei, sym) => `${amount(ethers.formatEther(wei))} ${sym}`;

  function readOpts() {
    let dest = null;
    const raw = $('swDest').value.trim();
    if (raw) {
      try {
        dest = ethers.getAddress(raw.toLowerCase() === raw || raw.toUpperCase() === raw ? raw.toLowerCase() : raw);
      } catch {
        dest = null;
      }
    }
    return {
      dest,
      destRaw: raw,
      threshold: Math.max(0, Number($('swThreshold').value) || 0),
      headroomPct: Math.min(300, Math.max(5, Number($('swHeadroom').value) || 50)),
      rpcMode: $('swRpc').value,
      bus: $('swBus').checked,
    };
  }

  function scanCandidates(dest, threshold) {
    return candidates({
      wallets: S.wallets, scan: S.scan, hidden: S.hidden, registry: registry(), nets: null, dest, threshold, enabled: enabledNets(),
    });
  }

  // the panel only counts networks switched on in Settings (test mode: the local chains)
  const enabledNets = () => (S.config.testMode ? null : new Set(S.config.networks));
  // test mode: the panel's own totals skip the local chains, so add up the scan the same way it would
  const panelTotal = () => (S.config.testMode
    ? Object.values(S.scan.wallets ?? {}).reduce((x, w) => x + Object.values(w.nets ?? {}).reduce((y, e) => y + e.tokens
      .filter((t) => !t.spam && t.value != null).reduce((z, t) => z + t.value, 0), 0), 0)
    : S.wallets.reduce((x, w) => x + (S.sums.get(w.id)?.total ?? 0), 0));

  function maxAccountIndex() {
    let max = 1;
    for (const w of S.wallets) {
      const m = /^Акк (\d+)$/.exec(w.label ?? '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  // ---------- render ----------

  function render() {
    if (!$('swCount').dataset.touched) $('swCount').value = maxAccountIndex();
    const o = readOpts();
    $('swDestHint').replaceChildren(
      !o.destRaw ? h('span', { class: 'muted', text: 'Адрес твоего основного кошелька (EOA, например MetaMask/Rabby).' })
        : !o.dest ? h('span', { class: 'badge err', text: '✕ не похоже на EVM-адрес (или ошибка в регистре букв)' })
          : S.wallets.some((w) => w.address.toLowerCase() === o.dest.toLowerCase())
            ? h('span', { class: 'badge ok', text: '✓ адрес есть в списке — сам себе он ничего не отправит' })
            : h('span', { class: 'badge ok', text: `✓ ${o.dest}` }),
    );
    $('swRpcHint').textContent = S.config.testMode
      ? 'Тестовый режим: локальные Hardhat-сети 127.0.0.1:8545–8547.'
      : o.rpcMode === 'alchemy' ? 'Ключ из «Настроек» используется только этой вкладкой для RPC-запросов к Alchemy.' : 'Публичные RPC (publicnode, официальные RPC сетей).';

    // which networks are in play
    const { pairs } = scanCandidates(o.dest, o.threshold);
    const byNet = new Map();
    for (const p of pairs) byNet.set(p.net, (byNet.get(p.net) ?? 0) + p.scanValue);
    if (!SW.netDraft) SW.netDraft = new Set(byNet.keys());
    const nets = [...byNet.entries()].sort((a, b) => b[1] - a[1]);
    $('swNets').replaceChildren(...(nets.length
      ? nets.map(([net, v]) => {
          const box = h('input', { type: 'checkbox', checked: SW.netDraft.has(net) });
          box.addEventListener('change', () => (box.checked ? SW.netDraft.add(net) : SW.netDraft.delete(net)));
          return h('label', null, h('span', { class: 'l' }, box, chainName(net)), h('span', { class: 'muted num', text: usd(v) }));
        })
      : [h('div', { class: 'd-empty', text: `В последнем скане нет кошельков с суммой от ${usd(o.threshold)} в поддерживаемых сетях.` })]));
    $('swBuildBtn').disabled = SW.building || SW.running || !o.dest || !nets.length;
    $('swBuildBtn').textContent = SW.building ? 'Считаю план…' : 'Построить план (ничего не отправляет)';

    renderKeys();
    renderPlan();
  }

  function renderKeys() {
    const n = keyCount();
    const wanted = planAddresses();
    const covered = [...wanted].filter((a) => hasKey(a)).length;
    $('swKeyState').replaceChildren(h('span', null,
      n ? h('span', { class: 'badge ok', text: `🔑 в памяти вкладки: ${n} ключ(ей)` }) : h('span', { class: 'muted', text: 'Ключей в памяти нет.' }),
      SW.plan ? h('span', { class: 'muted', text: ` · кошельков плана с ключом: ${covered} из ${wanted.size}` }) : null));
    $('swKeyStatus').textContent = SW.keyStatus;
    $('swForgetBtn').disabled = !n;
    $('swLoadKeysBtn').disabled = !SW.plan || SW.running;
    $('swLoadKeysBtn').title = SW.plan ? '' : 'Сначала построй план — ключи сохраняются только для кошельков из плана';
  }

  function planAddresses() {
    const set = new Set();
    for (const c of SW.plan?.chains ?? []) {
      for (const r of c.rows) for (const s of r.steps) if (s.action === 'send') set.add(s.address.toLowerCase());
    }
    return set;
  }

  const STATUS = {
    pending: ['⏳ отправлена', 'gas'],
    confirmed: ['✓ подтверждена', 'ok'],
    failed: ['✕ ошибка', 'err'],
    unknown: ['? нет подтверждения', 'gas'],
    skipped: ['— пропущено', 'spam'],
    stopped: ['■ остановлено', 'spam'],
    nokey: ['🔑 нет ключа', 'spam'],
  };

  function actionCell(s) {
    if (s.status) {
      const [text, cls] = STATUS[s.status];
      const url = s.hash ? txUrl(s.net, s.hash) : null;
      return h('td', null,
        h('span', { class: `badge ${cls}`, text }),
        s.hash ? (url
          ? h('a', { class: 'mono small', href: url, target: '_blank', rel: 'noopener noreferrer', text: ` ${s.hash.slice(0, 10)}… ↗` })
          : h('span', { class: 'mono small muted', text: ` ${s.hash.slice(0, 10)}…`, title: s.hash })) : null,
        s.error ? h('div', { class: 'small muted', text: s.error }) : null);
    }
    if (s.action === 'send') {
      const why = s.kind === 'fund' || s.busLeftover || s.reason?.includes('автобус') ? s.reason : null;
      return h('td', null, h('span', { class: 'badge ok', text: hasKey(s.address) ? 'отправить' : 'отправить · нет ключа' }), why ? h('div', { class: 'small muted', text: why }) : null);
    }
    if (s.action === 'needgas') return h('td', null, h('span', { class: 'badge gas', text: '⚠ нужен газ' }), s.reason && s.reason !== 'нет газа' ? h('div', { class: 'small muted', text: s.reason }) : null);
    return h('td', null, h('span', { class: 'muted small', text: s.reason }));
  }

  // why the plan total differs from the panel total, so a mismatch explains itself
  function renderRecon(plan, t) {
    const { items, drift } = reconcile(plan);
    const panel = panelTotal();
    const parts = items.map((it) => `${it.label} — ${usd(it.usd)}`);
    if (Math.abs(drift) >= 0.01) parts.push(`балансы изменились после скана: ${drift > 0 ? '+' : '−'}${usd(Math.abs(drift))}`);
    const accounted = t.valueUsd + items.reduce((x, it) => x + it.usd, 0) - drift;
    const rest = panel - accounted;
    if (Math.abs(rest) >= 0.01) parts.push(`прочее (округления) — ${rest > 0 ? '' : '−'}${usd(Math.abs(rest))}`);
    $('swRecon').replaceChildren(
      h('b', { text: `в панели ${usd(panel)}` }),
      ` · в плане ${usd(t.valueUsd)} до газа · `,
      parts.length ? h('span', null, 'не вошло: ', parts.join('; ')) : 'всё вошло',
    );
  }

  // the four kinds of wallets per chain (what the user asked to see before anything else)
  function renderClasses(plan) {
    const cell = (x, extra) => (x.n ? h('td', { class: 'c-num' }, h('b', { text: `${x.n}` }), ` · ${usd(x.usd)}`, extra ? h('div', { class: 'small muted', text: extra }) : null) : h('td', { class: 'c-num muted', text: '—' }));
    const rows = plan.chains.filter((c) => c.classes).map((c) => {
      const k = c.classes;
      const b = c.bus;
      const busText = !k.c.n ? '' : !plan.busEnabled ? 'автобус выключен'
        : k.c.bus ? `${k.c.bus} довезёт ${b.funder?.label ?? ''} · выгода ≈ ${usd(k.c.busUsd)}` : b.noFunder ? 'нет кошелька с газом' : '';
      const notes = [busText, b.unprofitable ? `не выгодно: ${b.unprofitable}` : '', b.noRoom ? `автобусу не хватило газа: ${b.noRoom}` : ''].filter(Boolean).join(' · ');
      return h('tr', null,
        h('td', null, h('b', { text: chainName(c.net) })),
        cell(k.a), cell(k.b), cell(k.c, notes),
        h('td', { class: 'c-num muted', text: k.none.n ? `${k.none.n}` : '—' }));
    });
    $('swClasses').replaceChildren(h('table', { class: 'plain sw-classes' },
      h('thead', null, h('tr', null,
        h('th', { text: 'Сеть' }),
        h('th', { class: 'c-num', text: 'Только нативка (платит сам)' }),
        h('th', { class: 'c-num', text: 'Токены + газ есть' }),
        h('th', { class: 'c-num', text: 'Токены, газа нет' }),
        h('th', { class: 'c-num', text: 'Нечего слать' }))),
      h('tbody', null, rows)));
  }

  // "bus" picker in a chain header: which wallet carries gas to the wallets that have none
  function busControl(plan, c) {
    if (!plan.busEnabled || !c.classes?.c.n || !c.bus) return null;
    const sel = h('select', { class: 'sw-bus', disabled: SW.running });
    sel.append(h('option', { value: 'auto', text: 'авто (самый богатый)' }));
    for (const o of c.bus.options) {
      sel.append(h('option', { value: o.id, text: `${o.isDest ? 'получатель (нужен его ключ)' : o.label} — свободно ${nat(o.capWei, c.chain.native)}` }));
    }
    sel.value = c.bus.choice;
    sel.addEventListener('change', () => {
      applyBus(plan, c, sel.value);
      renderPlan();
      renderKeys();
    });
    return h('label', { class: 'small sw-buslabel' }, ' 🚌 автобус: ', sel);
  }

  function renderPlan() {
    const plan = SW.plan;
    $('swPlanCard').classList.toggle('hidden', !plan);
    $('swRunCard').classList.toggle('hidden', !plan);
    if (!plan) return;
    const t = planTotals(plan);
    const kpi = (label, value, sub, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'k-label', text: label }), h('div', { class: 'k-value num', text: value }), h('div', { class: 'k-sub', text: sub }));
    $('swKpis').replaceChildren(
      kpi('Придёт на адрес (чистыми)', usd(t.netUsd), `${t.sendCount} транзакций · ${t.wallets.size} кошельков`, 'hero'),
      kpi('Стоимость до газа', usd(t.valueUsd), 'по ценам из последнего скана'),
      kpi('Газ (резерв)', usd(t.gasUsd), 'фактически обычно меньше'),
      kpi('Без газа', `${t.needGas}`, t.busWallets ? `газ довезёт автобус: ${t.busWallets}${t.needGas ? ` · остальным докинуть ≈ ${usd(t.topUpUsd)}` : ''}` : t.needGas ? `докинуть ≈ ${usd(t.topUpUsd)}` : 'везде хватает', t.needGas ? 'warn' : ''),
    );
    renderClasses(plan);
    renderRecon(plan, t);
    $('swPlanInfo').textContent = `план от ${new Date(plan.createdAt).toLocaleTimeString('ru-RU')} · проверено пар «кошелёк × сеть»: ${plan.candidates}`
      + (plan.dustPairs ? ` · ещё ${plan.dustPairs} пар дешевле порога не смотрел` : '');

    const frag = document.createDocumentFragment();
    for (const c of plan.chains) {
      const f = c.fee;
      const feeText = c.error ? '' : f.legacy ? `legacy · gasPrice ${gwei(f.gasPrice)} gwei` : `EIP-1559 · base ${gwei(f.base)} + tip ${gwei(f.tip)} gwei · резерв +${plan.headroomPct}%`;
      const cSend = c.rows.flatMap((r) => r.steps).filter((s) => s.action === 'send');
      frag.append(h('tr', { class: 'sw-chain' },
        h('td', { colspan: 9 },
          h('b', { text: chainName(c.net) }),
          h('span', { class: 'muted small', text: ` · ${feeText}${c.chain.l1 ? ' + L1 data fee' : ''}` }),
          c.destIsContract ? h('span', { class: 'badge gas', text: ' ⚠ получатель здесь — контракт' }) : null,
          c.error ? h('span', { class: 'badge err', text: ` ✕ ${c.error}` }) : h('span', { class: 'muted small', text: ` · к отправке: ${cSend.length} · придёт ${usd(chainDelivered(c))}` }),
          busControl(plan, c))));
      for (const r of c.rows) {
        if (r.error) {
          frag.append(h('tr', { class: 'dim' }, h('td'), h('td', { text: walletName(r.wallet) }), h('td', { colspan: 7 }, h('span', { class: 'badge err', text: `✕ ${r.error}` }))));
          continue;
        }
        const visible = r.steps.filter((s) => s.action !== 'skip' || s.kind === 'native' || $('swShowSkipped').checked);
        visible.forEach((s, i) => {
          const box = h('input', { type: 'checkbox', checked: s.selected, disabled: s.action !== 'send' || SW.running || Boolean(s.status) });
          box.addEventListener('change', () => {
            s.selected = box.checked;
            renderPlan();
          });
          const gasTitle = s.gasWei != null ? `резерв ${nat(s.gasWei, s.nativeSymbol)}${s.l1Wei ? ` (из них L1 ${nat(s.l1Wei, s.nativeSymbol)})` : ''} · gas limit ${s.gasLimit}` : '';
          frag.append(h('tr', { class: `${s.action === 'send' ? '' : 'dim'}${s.kind === 'fund' ? ' sw-fund' : ''}` },
            h('td', { class: 'c-sel' }, box),
            h('td', null, i === 0 ? [
              h('div', { class: 'w-label', text: `#${r.wallet.id} ${walletName(r.wallet)}` }),
              h('div', { class: 'w-group mono', text: `${r.wallet.group} · ${r.wallet.address.slice(0, 8)}…${r.wallet.address.slice(-4)}` }),
              r.isFunder ? h('span', { class: 'badge gas', text: '🚌 автобус' }) : null,
              r.funded ? h('span', { class: 'badge ok', text: '⛽ получит газ' }) : null,
            ] : null),
            h('td', null, s.kind === 'fund'
              ? [h('b', { text: `⛽ ${s.symbol}` }), h('span', { class: 'muted small', text: ` от ${s.funderLabel} (автобус)` })]
              : [h('b', { text: s.symbol }), s.kind === 'native' ? h('span', { class: 'muted small', text: s.busLeftover ? ' (остаток газа)' : ' (нативная)' }) : null]),
            h('td', { class: 'c-num', text: s.amount != null ? amount(s.amount) : '—', title: s.kind === 'native' && s.balance != null ? `баланс ${nat(s.balance, s.nativeSymbol)}` : '' }),
            h('td', { class: 'c-num', text: usd(s.valueUsd) }),
            h('td', { class: 'c-num', text: s.gasUsd != null ? usd(s.gasUsd) : '—', title: gasTitle }),
            h('td', { class: 'c-num' }, s.action === 'send' ? h('b', { text: usd(s.netUsd) }) : h('span', { class: 'muted', text: s.netUsd != null ? usd(s.netUsd) : '—' })),
            actionCell(s),
            h('td', { class: 'small muted' }, i === 0 && r.topUpWei > 0n && !r.funded ? `докинуть ≥ ${nat(r.topUpWei, s.nativeSymbol)} (${usd(r.topUpUsd)})` : '')));
        });
      }
    }
    $('swPlanRows').replaceChildren(frag);

    $('swRunBtn').disabled = SW.running || !t.selected;
    $('swRunBtn').textContent = `Отправить выбранные: ${t.selected} (≈ ${usd(t.selectedNet)})…`;
    $('swStopBtn').classList.toggle('hidden', !SW.running);
    const steps = plan.chains.flatMap((c) => c.rows.flatMap((r) => r.steps));
    const cnt = (st) => steps.filter((s) => s.status === st).length;
    const any = steps.some((s) => s.status);
    $('swRunStatus').textContent = any
      ? `подтверждено ${cnt('confirmed')} · в пути ${cnt('pending')} · ошибок ${cnt('failed')} · без подтверждения ${cnt('unknown')} · пропущено ${cnt('skipped') + cnt('stopped') + cnt('nokey')}`
      : t.noKey ? `Без ключа: ${t.noKey} из ${t.selected} выбранных — они будут пропущены.` : '';
    $('swExportBtn').disabled = false;
  }

  // ---------- actions ----------

  async function alchemyKey() {
    if (SW.alchemyKey) return SW.alchemyKey;
    const r = await api('/api/alchemy-key');
    SW.alchemyKey = r.key;
    return r.key;
  }

  async function build() {
    const o = readOpts();
    if (!o.dest) return toast('Сначала введи адрес получателя');
    SW.building = true;
    resetProviders();
    render();
    try {
      const rpc = { rpcMode: o.rpcMode, alchemyKey: o.rpcMode === 'alchemy' && !S.config.testMode ? await alchemyKey() : null };
      SW.rpc = rpc;
      SW.plan = await buildPlan({
        wallets: S.wallets, scan: S.scan, hidden: S.hidden, registry: registry(), nets: SW.netDraft, enabled: enabledNets(),
        dest: o.dest, threshold: o.threshold, headroomPct: o.headroomPct, rpc, bus: o.bus,
      }, (d, n) => { $('swBuildBtn').textContent = `Считаю план… ${d} / ${n}`; });
    } finally {
      SW.building = false;
    }
    render();
    $('swPlanCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadKeysFromInput() {
    const ta = $('swSeeds');
    const passEl = $('swPass');
    const text = ta.value;
    const passphrase = passEl.value;
    ta.value = '';
    passEl.value = '';
    if (!text.trim()) return toast('Вставь сид-фразы или приватные ключи');
    $('swLoadKeysBtn').disabled = true;
    try {
      const r = await loadKeys(text, {
        count: Math.min(200, Math.max(1, Number($('swCount').value) || 1)),
        start: Math.max(0, (Number($('swStart').value) || 1) - 1),
        pathKind: $('swPath').value,
        passphrase,
      }, planAddresses(), (i, n) => { $('swKeyStatus').textContent = `Обрабатываю ${i + 1} / ${n}…`; }, () => {
        SW.keyStatus = 'Ключи забыты автоматически (прошло 20 минут).';
        renderKeys();
        renderPlan();
      });
      SW.keyStatus = `Строк с ключами/сидами: ${r.secrets} · адресов проверено: ${r.derived} · совпало с планом: ${r.matched}`
        + (r.failed.length ? ` · не распознаны строки: ${r.failed.slice(0, 20).join(', ')}` : '')
        + '. Остальное сразу выброшено из памяти.';
    } finally {
      renderKeys();
      renderPlan();
    }
  }

  function wipe(msg) {
    forgetKeys();
    SW.keyStatus = msg;
    renderKeys();
    renderPlan();
  }

  function openConfirm() {
    const plan = SW.plan;
    const t = planTotals(plan);
    const dest = plan.dest;
    const groups = dest.slice(2).match(/.{1,4}/g);
    const contractNets = plan.chains.filter((c) => c.destIsContract).map((c) => chainName(c.net));
    const selNets = new Set(plan.chains.filter((c) => c.rows.some((r) => r.steps.some((s) => s.selected && s.action === 'send'))).map((c) => c.net));
    const d = $('swConfirm');
    const typed = h('input', { class: 'mono', placeholder: 'последние 6 символов', autocomplete: 'off', spellcheck: 'false' });
    const ack = h('input', { type: 'checkbox' });
    const go = h('button', { class: 'primary', disabled: true, text: 'Подписать и отправить' });
    const check = () => { go.disabled = !(ack.checked && typed.value.trim().toLowerCase() === dest.slice(-6).toLowerCase()); };
    typed.addEventListener('input', check);
    ack.addEventListener('change', check);
    go.addEventListener('click', () => { d.close(); guarded(run); });
    d.replaceChildren(
      h('h2', { text: 'Проверь перед отправкой' }),
      h('p', null, `Будет подписано до ${t.selected} транзакций из ${new Set(plan.chains.flatMap((c) => c.rows.flatMap((r) => r.steps.filter((s) => s.selected && s.action === 'send').map((s) => s.address.toLowerCase())))).size} кошельков в ${selNets.size} сетях, на адрес придёт ≈ `, h('b', { text: usd(t.selectedNet) }), '.',
        t.noKey ? ` Без ключа (будут пропущены): ${t.noKey}.` : '',
        t.bus ? ` Газовый автобус: ${t.bus} перевод(а) газа на кошельки без газа — сначала они, потом токены с этих кошельков, автобус последним.` : ''),
      h('div', { class: 'note crit' },
        h('b', { text: '1. Кошельки станут связаны навсегда. ' }),
        'Все переводы на один адрес видны в блокчейне. Проекты с аирдропами (и их антисибил-фильтры) увидят, что все эти кошельки принадлежат одному человеку, и могут исключить их все разом. Если на этих кошельках ещё фармятся аирдропы — лучше не собирать или собирать позже.'),
      h('div', { class: 'note crit' },
        h('b', { text: '2. Транзакции необратимы. ' }),
        'Если адрес получателя неверный — деньги не вернуть. Сравни его по символам с адресом в своём кошельке (не из буфера обмена, а прямо в приложении кошелька):'),
      h('div', { class: 'sw-dest mono' }, h('span', { text: '0x' }), ...groups.map((g, i) => h('span', { class: i % 2 ? 'alt' : '', text: g }))),
      contractNets.length ? h('div', { class: 'note' }, `⚠ В сетях ${contractNets.join(', ')} по этому адресу — контракт (смарт-кошелёк). Убедись, что он твой и умеет принимать токены. В сетях, где он не развёрнут, адрес может быть вообще не твоим.`) : '',
      h('div', { class: 'row' }, h('label', null, 'Повтори последние 6 символов адреса:', typed)),
      h('div', { class: 'row' }, h('label', { class: 'chk' }, ack, 'Понимаю, что эти кошельки будут связаны on-chain, и проверил адрес получателя')),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'ghost', onclick: () => d.close(), text: 'Отмена' }), go),
    );
    d.showModal();
    typed.focus();
  }

  async function run() {
    const plan = SW.plan;
    for (const c of plan.chains) for (const r of c.rows) for (const s of r.steps) {
      if (s.selected && s.action === 'send') Object.assign(s, { status: null, error: null, hash: null });
    }
    SW.running = true;
    SW.stopReq = false;
    renderPlan();
    try {
      await executePlan(plan, {
        stopOnError: $('swStopOnError').checked,
        isStopped: () => SW.stopReq,
        rpc: SW.rpc,
        onStep: () => renderPlan(),
      });
    } finally {
      SW.running = false;
      wipe('Отправка закончена — ключи удалены из памяти вкладки. Для повтора вставь их заново.');
    }
    toast('Готово. Скачай журнал CSV и пересканируй кошельки, чтобы обновить балансы.', 8000);
  }

  function exportCsv() {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['Сеть', '#', 'Кошелёк', 'Группа', 'Адрес', 'Монета', 'Контракт', 'Количество (план)', 'Стоимость $', 'Газ резерв', 'Газ $', 'Чистыми $', 'Решение', 'Причина', 'Статус', 'Отправлено (факт)', 'Tx', 'Ссылка', 'Ошибка', 'Время', 'Получатель'].join(';')];
    for (const c of SW.plan.chains) {
      for (const r of c.rows) {
        for (const s of r.steps) {
          const sent = s.sentRaw != null ? ethers.formatUnits(s.sentRaw, s.decimals) : '';
          lines.push([chainName(c.net), r.wallet.id, walletName(r.wallet), r.wallet.group, r.wallet.address, s.kind === 'fund' ? `газ (автобус) от ${s.address}` : s.symbol, s.kind === 'fund' ? `→ ${s.to}` : s.token ?? 'native', s.amount ?? '',
            s.valueUsd?.toFixed(4) ?? '', s.gasWei != null ? ethers.formatEther(s.gasWei) : '', s.gasUsd?.toFixed(4) ?? '', s.netUsd?.toFixed(4) ?? '',
            s.action, s.reason ?? '', s.status ?? (s.selected ? 'не отправлялась' : 'не выбрана'), sent, s.hash ?? '', s.hash ? txUrl(c.net, s.hash) ?? '' : '',
            s.error ?? '', s.sentAt ?? '', SW.plan.dest].map(esc).join(';'));
        }
        if (r.error) lines.push([chainName(c.net), r.wallet.id, walletName(r.wallet), r.wallet.group, r.wallet.address, '', '', '', '', '', '', '', 'error', r.error].map(esc).join(';'));
      }
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `sweep-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- wiring ----------

  $('swDest').addEventListener('input', () => render());
  $('swThreshold').addEventListener('input', () => { SW.netDraft = null; render(); });
  $('swRpc').addEventListener('change', () => { resetProviders(); render(); });
  $('swCount').addEventListener('input', () => { $('swCount').dataset.touched = '1'; });
  $('swShowSkipped').addEventListener('change', renderPlan);
  $('swBus').addEventListener('change', () => {
    if (!SW.plan || SW.running) return;
    SW.plan.busEnabled = $('swBus').checked;
    for (const c of SW.plan.chains) applyBus(SW.plan, c, 'auto');
    renderPlan();
    renderKeys();
  });
  $('swBuildBtn').addEventListener('click', () => guarded(build));
  $('swLoadKeysBtn').addEventListener('click', () => guarded(loadKeysFromInput));
  $('swForgetBtn').addEventListener('click', () => wipe('Ключи удалены из памяти вкладки.'));
  $('swRunBtn').addEventListener('click', () => {
    if (!keyCount()) return toast('Сначала загрузи ключи (шаг 2)');
    openConfirm();
  });
  $('swStopBtn').addEventListener('click', () => { SW.stopReq = true; toast('Останавливаю: текущие транзакции дождутся подтверждения, новые не отправятся'); });
  $('swExportBtn').addEventListener('click', exportCsv);
  // leaving or reloading the page drops keys too (they would be gone anyway, this just makes it explicit)
  addEventListener('pagehide', () => forgetKeys());
  addEventListener('beforeunload', (e) => {
    if (SW.running) e.preventDefault();
  });

  return { render };
}
