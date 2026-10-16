// Sweeper core: build a dry-run plan from the last scan + live RPC data, then (only when the user
// confirms) sign and broadcast in this browser tab. Keys live in KEYS below — page memory only,
// never sent to the local server, never written to storage, dropped by forgetKeys().
import { SWEEP_CHAINS, TEST_CHAINS, alchemyRpcUrl } from './sweep-chains.js';
import { parseSecretLines, deriveWallets } from './seeds.js';

const { ethers } = window;

const ERC20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const L1_ORACLE = {
  op: '0x420000000000000000000000000000000000000F', // OP-stack GasPriceOracle predeploy
  scroll: '0x5300000000000000000000000000000000000002', // Scroll L1GasPriceOracle
};
const L1_IFACE = new ethers.Interface(['function getL1Fee(bytes) view returns (uint256)']);
const L1_HEADROOM = 150n; // % of the oracle's L1 fee kept in reserve: it follows the L1 gas price
const TOKEN_GAS_MULT = 1.2;
const BUS_MARGIN = 10n; // % added on top of the gas a funded wallet needs
const CONFIRM_TIMEOUT_MS = 180_000;

export function chainRegistry(testMode) {
  return testMode ? { ...SWEEP_CHAINS, ...TEST_CHAINS } : SWEEP_CHAINS;
}

// ---------- small helpers ----------

const pct = (x, p) => (x * BigInt(Math.round(p * 100))) / 100n;
const ceilMul = (x, m) => (m === 1 ? x : (x * BigInt(Math.round(m * 1000)) + 999n) / 1000n);
const toNum = (wei, decimals = 18) => Number(ethers.formatUnits(wei, decimals));
// RPC errors may echo the URL — scrub the Alchemy key out of anything shown to the user
export function cleanErr(e) {
  const node = e?.error?.message || e?.info?.error?.message; // the RPC's own words beat ethers' "could not coalesce error"
  let msg = String((node && (!e?.shortMessage || /coalesce/.test(e.shortMessage)) ? node : e?.shortMessage) || e?.message || e);
  if (/insufficient funds|enough funds/i.test(msg)) msg = `не хватает нативной монеты на газ (${msg})`;
  return msg.replace(/\/v2\/[A-Za-z0-9_%-]+/g, '/v2/…').slice(0, 300);
}

// ---------- providers ----------

const providers = new Map();

export function resetProviders() {
  for (const p of providers.values()) p.destroy?.();
  providers.clear();
}

// First RPC that answers with the right chainId wins for the whole session.
export async function getProvider(net, chain, { rpcMode, alchemyKey }) {
  if (providers.has(net)) return providers.get(net);
  const urls = rpcMode === 'alchemy' && alchemyKey && !chain.test ? [alchemyRpcUrl(net, alchemyKey), ...chain.rpcs] : chain.rpcs;
  let lastErr;
  for (const url of urls) {
    const req = new ethers.FetchRequest(url);
    req.timeout = 20_000;
    const p = new ethers.JsonRpcProvider(req, chain.chainId, { staticNetwork: true, batchMaxCount: 1 });
    try {
      const id = Number(await p.send('eth_chainId', []));
      if (id !== chain.chainId) throw new Error(`RPC вернул chainId ${id}, ожидался ${chain.chainId}`);
      p.pollingInterval = chain.test ? 250 : 2000;
      providers.set(net, p);
      return p;
    } catch (e) {
      p.destroy();
      lastErr = e;
    }
  }
  throw new Error(`Нет рабочего RPC: ${cleanErr(lastErr)}`);
}

// ---------- fees ----------

// expected = what one gas unit will most likely cost, max = what we reserve for it
export async function feeInfo(p, chain, headroomPct) {
  const gasPrice = BigInt(await p.send('eth_gasPrice', []));
  if (!chain.legacy) {
    const block = await p.getBlock('latest');
    const base = block?.baseFeePerGas;
    if (base != null) {
      let tip;
      try {
        tip = BigInt(await p.send('eth_maxPriorityFeePerGas', []));
      } catch {
        tip = gasPrice > base ? gasPrice - base : 0n;
      }
      if (chain.minTip && tip < chain.minTip) tip = chain.minTip;
      const maxFee = base + pct(base, headroomPct / 100) + tip;
      return { legacy: false, base, tip, maxFee, expected: base + tip, max: maxFee };
    }
  }
  return { legacy: true, gasPrice, expected: gasPrice, max: gasPrice };
}

function feeFields(fee) {
  return fee.legacy
    ? { type: 0, gasPrice: fee.gasPrice }
    : { type: 2, maxFeePerGas: fee.maxFee, maxPriorityFeePerGas: fee.tip };
}

// L1 data fee for OP-stack/Scroll, from the chain's own oracle, on the unsigned tx we are about to send
async function l1Fee(p, chain, fee, tx) {
  if (!chain.l1) return { exp: 0n, max: 0n };
  const unsigned = ethers.Transaction.from({ chainId: chain.chainId, ...feeFields(fee), ...tx }).unsignedSerialized;
  const r = await p.call({ to: L1_ORACLE[chain.l1], data: L1_IFACE.encodeFunctionData('getL1Fee', [unsigned]) });
  const exp = BigInt(r);
  return { exp, max: (exp * L1_HEADROOM) / 100n };
}

// A plain transfer to an EOA costs exactly 21000 on standard EVM chains (some nodes estimate 21001).
// Arbitrum / ZK-stack add L1/pubdata gas to the estimate, and contracts can run code: use the estimate there.
async function nativeGasLimit(p, chain, from, to, destIsContract) {
  if (!chain.gasMult && !destIsContract) return 21000n;
  const est = await p.estimateGas({ from, to, value: 0n });
  return ceilMul(est, chain.gasMult ?? 1.2);
}

// ---------- plan ----------

// Which (wallet × network) pairs are worth a live look: priced, non-spam, non-hidden assets from the scan.
// `excluded` counts what the panel shows but the plan leaves out (at scan prices), for the reconciliation line.
// `enabled` = networks switched on in Settings: the panel ignores the others, so the plan does too.
export function candidates({ wallets, scan, hidden, registry, nets, dest, threshold, enabled }) {
  const nativePrice = {};
  for (const w of Object.values(scan.wallets ?? {})) {
    for (const [net, e] of Object.entries(w.nets ?? {})) {
      const n = e.tokens.find((t) => t.native && t.price != null);
      if (n && nativePrice[net] == null) nativePrice[net] = n.price;
    }
  }
  const out = [];
  let dustPairs = 0;
  const excluded = { dust: { n: 0, usd: 0 }, netOff: { n: 0, usd: 0 }, unsupported: { n: 0, usd: 0 }, dest: { n: 0, usd: 0 } };
  const add = (k, v) => {
    excluded[k].n++;
    excluded[k].usd += v;
  };
  const destLc = dest?.toLowerCase();
  for (const w of wallets) {
    const sc = scan.wallets?.[w.address.toLowerCase()];
    if (!sc) continue;
    for (const [net, e] of Object.entries(sc.nets ?? {})) {
      if (enabled && !enabled.has(net)) continue;
      // same filter as the panel's totals
      const counted = e.tokens.filter((t) => !t.spam && t.value != null && !hidden.has(`${net}:${t.token ?? 'native'}`));
      const panelUsd = counted.reduce((x, t) => x + t.value, 0);
      if (panelUsd <= 0) continue;
      const chain = registry[net];
      if (w.address.toLowerCase() === destLc) { add('dest', panelUsd); continue; }
      if (!chain) { add('unsupported', panelUsd); continue; }
      if (nets && !nets.has(net)) { add('netOff', panelUsd); continue; }
      const skip = new Set(chain.skipTokens ?? []);
      const tokens = counted.filter((t) => !t.native && t.decimals != null && !skip.has(t.token));
      const native = counted.find((t) => t.native);
      const total = (native?.value ?? 0) + tokens.reduce((x, t) => x + t.value, 0);
      if (panelUsd - total > 0) add('unsupported', panelUsd - total);
      if (total <= 0) continue;
      if (total < threshold) {
        dustPairs++;
        add('dust', total);
        continue;
      }
      out.push({ wallet: w, net, chain, tokens, nativePrice: native?.price ?? nativePrice[net] ?? null, scanValue: total });
    }
  }
  return { pairs: out, dustPairs, excluded };
}

let stepSeq = 0;
const ORIG_FIELDS = ['action', 'reason', 'raw', 'amount', 'netUsd', 'valueUsd', 'selected'];

// One pair → live balances, gas estimates, decisions. Never signs anything.
async function planPair(p, pair, fee, { dest, threshold, destIsContract }) {
  const { wallet, net, chain, nativePrice } = pair;
  const from = wallet.address;
  const base = { net, walletId: wallet.id, address: from, nativeSymbol: chain.native };
  const usdOf = (wei) => (nativePrice == null ? null : toNum(wei) * nativePrice);
  const nativeBal = await p.getBalance(from, 'latest');
  const steps = [];

  // tokens first: they need native gas, the native sweep takes what is left
  for (const t of pair.tokens) {
    const s = { ...base, id: ++stepSeq, kind: 'erc20', token: t.token, symbol: t.symbol, decimals: t.decimals, price: t.price };
    steps.push(s);
    try {
      s.raw = BigInt(await p.call({ to: t.token, data: ERC20.encodeFunctionData('balanceOf', [from]) }));
    } catch (e) {
      Object.assign(s, { action: 'skip', reason: `balanceOf не читается: ${cleanErr(e)}` });
      continue;
    }
    s.amount = ethers.formatUnits(s.raw, t.decimals);
    s.valueUsd = Number(s.amount) * t.price;
    if (s.raw === 0n) {
      Object.assign(s, { action: 'skip', reason: 'баланс уже 0' });
      continue;
    }
    if (s.valueUsd < threshold) {
      Object.assign(s, { action: 'skip', reason: 'дешевле порога' });
      continue;
    }
    const data = ERC20.encodeFunctionData('transfer', [dest, s.raw]);
    let est;
    try {
      est = await p.estimateGas({ from, to: t.token, data });
    } catch (e) {
      Object.assign(s, { action: 'skip', reason: `перевод не проходит: ${cleanErr(e)}` });
      continue;
    }
    s.gasLimit = ceilMul(est, Math.max(TOKEN_GAS_MULT, chain.gasMult ?? 1));
    const l1 = await l1Fee(p, chain, fee, { to: t.token, data, gasLimit: s.gasLimit, nonce: 0, value: 0n });
    s.gasWei = s.gasLimit * fee.max + l1.max; // reserve (worst case)
    s.gasExpWei = est * fee.expected + l1.exp; // most likely
    s.l1Wei = l1.max;
    s.gasUsd = usdOf(s.gasWei);
    if (s.gasUsd == null) {
      Object.assign(s, { action: 'skip', reason: `нет цены ${chain.native} — газ не оценить` });
      continue;
    }
    s.netUsd = s.valueUsd - s.gasUsd;
    if (s.netUsd < threshold) {
      Object.assign(s, { action: 'skip', reason: s.gasUsd >= s.valueUsd ? 'газ дороже токена' : 'после газа меньше порога' });
      continue;
    }
    s.action = 'send';
  }

  // pay gas for the most valuable tokens first; the rest needs a top-up
  const worth = steps.filter((s) => s.action === 'send').sort((a, b) => b.netUsd - a.netUsd);
  let reserved = 0n;
  for (const s of worth) {
    if (reserved + s.gasWei <= nativeBal) reserved += s.gasWei;
    else Object.assign(s, { action: 'needgas', reason: 'нет газа' });
  }
  const starving = worth.filter((s) => s.action === 'needgas');
  const topUpWei = starving.length ? reserved + starving.reduce((x, s) => x + s.gasWei, 0n) - nativeBal : 0n;

  // native sweep: balance − gas reserved for the tokens − its own gas (− L1 fee)
  const n = { ...base, id: ++stepSeq, kind: 'native', token: null, symbol: chain.native, decimals: 18, price: nativePrice, balance: nativeBal };
  steps.push(n);
  const remaining = nativeBal - reserved;
  n.valueUsd = usdOf(remaining > 0n ? remaining : 0n);
  if (nativePrice != null) {
    n.gasLimit = await nativeGasLimit(p, chain, from, dest, destIsContract);
    const l1 = await l1Fee(p, chain, fee, { to: dest, value: remaining > 0n ? remaining : 0n, gasLimit: n.gasLimit, nonce: 0 });
    n.gasWei = n.gasLimit * fee.max + l1.max;
    n.gasExpWei = n.gasLimit * fee.expected + l1.exp;
    n.l1Wei = l1.max;
    n.gasUsd = usdOf(n.gasWei);
  }
  if (starving.length) {
    Object.assign(n, { action: 'skip', reason: 'оставлено на газ для токенов', raw: 0n, amount: '0' });
  } else if (nativePrice == null) {
    Object.assign(n, { action: 'skip', reason: `нет цены ${chain.native}`, raw: 0n, amount: '0' });
  } else if (remaining <= 0n) {
    Object.assign(n, { action: 'skip', reason: 'пусто', raw: 0n, amount: '0' });
  } else {
    n.raw = remaining > n.gasWei ? remaining - n.gasWei : 0n;
    n.amount = ethers.formatEther(n.raw);
    n.netUsd = usdOf(n.raw);
    if (n.raw === 0n) Object.assign(n, { action: 'skip', reason: 'не хватает даже на газ' });
    else if (n.netUsd < threshold) Object.assign(n, { action: 'skip', reason: n.gasUsd >= n.valueUsd ? 'газ дороже остатка' : 'после газа меньше порога' });
    else n.action = 'send';
  }
  for (const st of steps) {
    st.selected = st.action === 'send';
    st.orig = Object.fromEntries(ORIG_FIELDS.map((f) => [f, st[f]])); // the bus edits these, this restores them
  }
  return {
    key: `${net}|${from.toLowerCase()}`,
    net,
    wallet,
    nativeBal,
    nativePrice,
    steps,
    topUpWei,
    topUpUsd: topUpWei > 0n ? usdOf(topUpWei) : 0,
  };
}

async function pool(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      await fn(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function buildPlan(opts, onProgress) {
  const { dest, threshold, headroomPct, rpc } = opts;
  const { pairs, dustPairs, excluded } = candidates(opts);
  const byNet = new Map();
  for (const pr of pairs) {
    if (!byNet.has(pr.net)) byNet.set(pr.net, []);
    byNet.get(pr.net).push(pr);
  }
  const chains = [];
  let done = 0;
  await pool([...byNet.entries()], 4, async ([net, list]) => {
    const chain = list[0].chain;
    const c = { net, chain, rows: [], error: null, fee: null, destIsContract: false };
    chains.push(c);
    try {
      const p = await getProvider(net, chain, rpc);
      c.fee = await feeInfo(p, chain, headroomPct);
      c.destIsContract = (await p.getCode(dest)) !== '0x';
      c.destBal = await p.getBalance(dest, 'latest');
      for (const pr of list) {
        try {
          c.rows.push({ ...await planPair(p, pr, c.fee, { dest, threshold, destIsContract: c.destIsContract }), scanValue: pr.scanValue });
        } catch (e) {
          c.rows.push({ key: `${net}|${pr.wallet.address.toLowerCase()}`, net, wallet: pr.wallet, steps: [], error: cleanErr(e), topUpWei: 0n, topUpUsd: 0, scanValue: pr.scanValue });
        }
        onProgress?.(++done, pairs.length);
      }
      c.nativePrice = c.rows.find((r) => r.nativePrice != null)?.nativePrice ?? null;
      if (c.rows.some((r) => r.steps.some((st) => st.action === 'needgas'))) c.busGas = await busGas(p, c);
    } catch (e) {
      c.error = cleanErr(e);
      c.scanValue = list.reduce((x, pr) => x + pr.scanValue, 0);
      done += list.length;
      onProgress?.(done, pairs.length);
    }
  });
  const plan = { dest, threshold, headroomPct, busEnabled: opts.bus !== false, rpc: { rpcMode: rpc.rpcMode }, createdAt: new Date().toISOString(), chains, dustPairs, excluded, candidates: pairs.length };
  for (const c of chains) applyBus(plan, c, 'auto');
  chains.sort((a, b) => chainDelivered(b) - chainDelivered(a));
  return plan;
}

// What actually lands on the destination: tokens at full value, native coin after its gas.
// (Token gas is already taken out of the native remainder, so subtracting it again would count it twice.)
export const deliveredUsd = (s) => (s.kind === 'erc20' ? s.valueUsd : s.kind === 'native' ? s.netUsd : 0) ?? 0;
export const chainDelivered = (c, onlySelected = false) => c.rows.reduce((x, r) => x + r.steps.reduce(
  (y, st) => y + (st.action === 'send' && (!onlySelected || st.selected) ? deliveredUsd(st) : 0), 0), 0);

// ---------- gas bus ----------
// Wallets with tokens but no gas get exactly the gas they need from one "bus" wallet on the same chain,
// send their tokens, return what is left; the bus itself is swept last.

// gas of one funding transfer (bus → wallet)
async function busGas(p, c) {
  const fee = c.fee;
  const to = c.rows.find((r) => r.steps.some((st) => st.action === 'needgas'))?.wallet.address;
  const from = c.rows.slice().sort((a, b) => (b.nativeBal > a.nativeBal ? 1 : -1))[0]?.wallet.address;
  let gasLimit = 21000n;
  if (c.chain.gasMult) {
    try {
      gasLimit = ceilMul(await p.estimateGas({ from, to, value: 0n }), c.chain.gasMult);
    } catch {
      gasLimit = ceilMul(21000n, 2);
    }
  }
  const l1 = await l1Fee(p, c.chain, fee, { to, value: 10n ** 15n, gasLimit, nonce: 0 });
  return { gasLimit, gasWei: gasLimit * fee.max + l1.max, gasExpWei: gasLimit * fee.expected + l1.exp, l1Wei: l1.max };
}

function classify(r) {
  if (r.error) return 'err';
  const toks = r.steps.filter((st) => st.kind === 'erc20' && (st.action === 'send' || st.action === 'needgas'));
  if (toks.some((st) => st.action === 'needgas')) return 'c';
  if (toks.length) return 'b';
  return r.steps.some((st) => st.kind === 'native' && st.action === 'send') ? 'a' : 'none';
}

// wallets that can drive the bus: plan wallets with spare native (after their own tokens and sweep) + the destination
export function busOptions(c) {
  const out = [];
  for (const r of c.rows) {
    if (r.error || r.cls === 'c' || !(r.nativeBal > 0n)) continue;
    const own = r.steps.filter((st) => st.kind === 'erc20' && st.orig.action === 'send').reduce((x, st) => x + st.gasWei, 0n);
    const sweep = r.steps.find((st) => st.kind === 'native')?.gasWei ?? 0n;
    const cap = r.nativeBal - own - sweep;
    if (cap > 0n) out.push({ id: r.wallet.address.toLowerCase(), address: r.wallet.address, walletId: r.wallet.id, label: `#${r.wallet.id} ${r.wallet.label || ''}`.trim(), row: r, capWei: cap });
  }
  out.sort((a, b) => (b.capWei > a.capWei ? 1 : -1));
  if (c.destBal > 0n) out.push({ id: 'dest', address: null, label: 'получатель', isDest: true, capWei: c.destBal });
  return out;
}

export function applyBus(plan, c, choice = 'auto') {
  for (const r of c.rows) {
    r.steps = r.steps.filter((st) => st.kind !== 'fund');
    for (const st of r.steps) {
      Object.assign(st, st.orig);
      delete st.busLeftover;
    }
    r.funded = null;
    r.isFunder = false;
    r.bus = null;
    r.cls = classify(r);
  }
  const bus = { choice, enabled: plan.busEnabled, funder: null, fundings: [], unprofitable: 0, noRoom: 0, options: [] };
  c.bus = bus;
  const price = c.nativePrice;
  const usd = (wei) => (price == null ? null : toNum(wei) * price);
  const needy = c.rows.filter((r) => r.cls === 'c');
  if (!needy.length || !plan.busEnabled || c.error || price == null || !c.busGas) return summarizeClasses(c);
  const g = c.busGas;
  const asks = [];
  for (const r of needy) {
    const toks = r.steps.filter((st) => st.kind === 'erc20' && (st.action === 'send' || st.action === 'needgas'));
    const nat = r.steps.find((st) => st.kind === 'native');
    const tokRes = toks.reduce((x, st) => x + st.gasWei, 0n);
    const sweepRes = nat?.gasWei ?? 0n;
    const need = tokRes + sweepRes - r.nativeBal;
    const fund = (need * (100n + BUS_MARGIN) + 99n) / 100n;
    const value = toks.reduce((x, st) => x + st.valueUsd, 0);
    const cost = usd(g.gasWei + tokRes + sweepRes);
    const profit = value - cost;
    if (profit < plan.threshold) {
      r.bus = { status: 'unprofitable', value, cost };
      bus.unprofitable++;
      for (const st of toks) if (st.action === 'needgas') st.reason = `не выгодно: газ с доставкой ${fmtUsd(cost)} против ${fmtUsd(value)}`;
      continue;
    }
    asks.push({ r, toks, nat, fund, value, cost, profit });
  }
  asks.sort((a, b) => b.profit - a.profit);
  bus.options = busOptions(c);
  let f = null;
  if (choice !== 'auto') f = bus.options.find((o) => o.id === choice) ?? null;
  else if (asks.length) {
    const first = asks[asks.length - 1].fund + g.gasWei; // cheapest ride
    f = bus.options.find((o) => !o.isDest && o.capWei >= first) ?? bus.options.find((o) => o.isDest && o.capWei >= first) ?? null;
  }
  if (asks.length && !f) {
    bus.noFunder = true;
    for (const a of asks) for (const st of a.toks) if (st.action === 'needgas') st.reason = 'нет кошелька с газом в этой сети для автобуса';
    return summarizeClasses(c);
  }
  bus.funder = f;
  let cap = f?.capWei ?? 0n;
  for (const a of asks) {
    if (a.fund + g.gasWei > cap) {
      a.r.bus = { status: 'noroom' };
      bus.noRoom++;
      for (const st of a.toks) if (st.action === 'needgas') st.reason = 'автобусу не хватает газа';
      continue;
    }
    cap -= a.fund + g.gasWei;
    const fs = {
      id: ++stepSeq, kind: 'fund', net: c.net, walletId: f.walletId ?? null, address: f.isDest ? plan.dest : f.address, to: a.r.wallet.address,
      symbol: c.chain.native, nativeSymbol: c.chain.native, decimals: 18, price, token: null,
      raw: a.fund, amount: ethers.formatEther(a.fund), valueUsd: usd(a.fund),
      gasLimit: g.gasLimit, gasWei: g.gasWei, gasExpWei: g.gasExpWei, l1Wei: g.l1Wei, gasUsd: usd(g.gasWei), netUsd: -usd(g.gasWei),
      action: 'send', selected: true, reason: `газ от ${f.label}`, funderLabel: f.label,
    };
    a.r.steps.unshift(fs);
    for (const st of a.toks) Object.assign(st, { action: 'send', selected: true, reason: 'газ привезёт автобус' });
    if (a.nat) {
      // what is left even if every transfer burns its full reserve (the real leftover is usually larger);
      // returned only if it is worth more than its own gas
      const left = a.r.nativeBal + a.fund - a.toks.reduce((x, st) => x + st.gasWei, 0n) - a.nat.gasWei;
      const raw = left > 0n ? left : 0n;
      Object.assign(a.nat, { action: 'send', selected: true, busLeftover: true, raw, amount: ethers.formatEther(raw), valueUsd: usd(raw + a.nat.gasWei), netUsd: usd(raw), reason: 'вернуть остаток газа, если он больше комиссии' });
    }
    a.r.funded = { by: f, fund: a.fund, step: fs, profit: a.profit };
    a.r.bus = { status: 'funded', profit: a.profit };
    bus.fundings.push(fs);
  }
  if (f?.row && bus.fundings.length) {
    f.row.isFunder = true;
    const spent = bus.fundings.reduce((x, st) => x + st.raw + st.gasWei, 0n);
    const n = f.row.steps.find((st) => st.kind === 'native');
    if (n && n.orig.action === 'send') {
      const raw = n.orig.raw - spent;
      if (raw <= 0n) Object.assign(n, { action: 'skip', selected: false, raw: 0n, amount: '0', netUsd: 0, reason: 'весь остаток ушёл на автобус' });
      else {
        Object.assign(n, { raw, amount: ethers.formatEther(raw), netUsd: usd(raw) });
        if (n.netUsd < plan.threshold) Object.assign(n, { action: 'skip', selected: false, reason: 'после автобуса меньше порога' });
        else n.reason = 'отправится последним — после автобуса';
      }
    }
  }
  return summarizeClasses(c);
}

const fmtUsd = (v) => `$${(v ?? 0).toFixed(2)}`;

function summarizeClasses(c) {
  const k = { a: { n: 0, usd: 0 }, b: { n: 0, usd: 0 }, c: { n: 0, usd: 0, bus: 0, busUsd: 0 }, none: { n: 0 } };
  for (const r of c.rows) {
    const x = k[r.cls];
    if (!x) continue;
    x.n++;
    if (r.cls === 'c') {
      x.usd += r.steps.filter((st) => st.kind === 'erc20' && (st.orig.action === 'send' || st.orig.action === 'needgas')).reduce((y, st) => y + st.valueUsd, 0);
      if (r.funded) {
        x.bus++;
        x.busUsd += r.funded.profit;
      }
    } else if (r.cls !== 'none') {
      x.usd += r.steps.reduce((y, st) => y + (st.orig.action === 'send' ? deliveredUsd(st) : 0), 0);
    }
  }
  c.classes = k;
}

// "в панели $X · в плане $Y · не вошло: …" — everything the panel counts but the plan does not send
export function reconcile(plan) {
  const items = [];
  const ex = plan.excluded ?? {};
  const thr = `$${plan.threshold}`;
  if (ex.dust?.n) items.push({ label: `мелочь дешевле ${thr} на пару «кошелёк × сеть» (${ex.dust.n} шт.)`, usd: ex.dust.usd });
  if (ex.netOff?.n) items.push({ label: `сети сняты галочкой (${ex.netOff.n} шт.)`, usd: ex.netOff.usd });
  if (ex.dest?.n) items.push({ label: 'это и есть кошелёк-получатель', usd: ex.dest.usd });
  if (ex.unsupported?.usd > 0.005) items.push({ label: 'сеть или монета, которую сборщик не переводит', usd: ex.unsupported.usd });
  let unavailable = 0;
  let live = 0;
  let scanned = 0;
  const groups = new Map();
  for (const c of plan.chains) {
    if (c.error) {
      unavailable += c.scanValue ?? 0;
      continue;
    }
    for (const r of c.rows) {
      if (r.error) {
        unavailable += r.scanValue ?? 0;
        continue;
      }
      scanned += r.scanValue ?? 0;
      live += r.steps.filter((st) => st.kind === 'erc20').reduce((x, st) => x + (st.valueUsd ?? 0), 0) + (r.nativePrice != null ? toNum(r.nativeBal) * r.nativePrice : 0);
      for (const st of r.steps) {
        if ((st.action !== 'skip' && st.action !== 'needgas') || !(st.valueUsd > 0.005)) continue;
        if (st.reason?.includes('автобус') && st.kind === 'native' && r.isFunder) continue; // moved by the bus, not lost
        let why = st.reason ?? '';
        if (st.action === 'needgas') {
          why = r.bus?.status === 'unprofitable' ? 'нет газа, а возить газ не выгодно'
            : c.bus?.noFunder ? 'нет газа и нет кошелька-автобуса в этой сети'
              : r.bus?.status === 'noroom' ? 'нет газа, автобусу не хватило' : !plan.busEnabled ? 'нет газа (автобус выключен)' : 'нет газа';
        } else if (st.reason === 'оставлено на газ для токенов') why = 'нативка на кошельке без газа для токенов';
        const k = `${why}`;
        const g = groups.get(k) ?? { label: why, usd: 0, n: 0, what: new Set() };
        g.usd += st.valueUsd;
        g.n++;
        g.what.add(`${st.symbol}`);
        groups.set(k, g);
      }
    }
  }
  for (const g of [...groups.values()].sort((a, b) => b.usd - a.usd)) items.push({ label: `${g.label}: ${[...g.what].join(', ')}`, usd: g.usd });
  if (unavailable > 0.005) items.push({ label: 'RPC не ответил — не проверено', usd: unavailable });
  const drift = live - scanned;
  return { items, drift };
}

export function planTotals(plan) {
  const t = { sendCount: 0, valueUsd: 0, gasUsd: 0, netUsd: 0, wallets: new Set(), needGas: 0, topUpUsd: 0, selected: 0, selectedNet: 0, noKey: 0, bus: 0, busWallets: 0 };
  for (const c of plan.chains) {
    for (const r of c.rows) {
      if (r.topUpWei > 0n && !r.funded) {
        t.needGas++;
        t.topUpUsd += r.topUpUsd ?? 0;
      }
      if (r.funded) t.busWallets++;
      for (const s of r.steps) {
        if (s.action !== 'send') continue;
        t.sendCount++;
        if (s.kind === 'fund') t.bus++;
        t.gasUsd += s.gasUsd ?? 0;
        t.netUsd += deliveredUsd(s);
        t.wallets.add(r.wallet.address.toLowerCase());
        if (s.selected) {
          t.selected++;
          t.selectedNet += deliveredUsd(s);
          if (!hasKey(s.address)) t.noKey++;
        }
      }
    }
  }
  t.valueUsd = t.netUsd + t.gasUsd;
  return t;
}

// ---------- keys (page memory only) ----------

const KEYS = new Map(); // lowercased address → ethers.Wallet
let wipeTimer;
const WIPE_AFTER_MS = 20 * 60_000;

export const hasKey = (addr) => KEYS.has(addr.toLowerCase());
export const keyCount = () => KEYS.size;

export function forgetKeys() {
  KEYS.clear();
  clearTimeout(wipeTimer);
}

function armWipe(onWipe) {
  clearTimeout(wipeTimer);
  wipeTimer = setTimeout(() => {
    forgetKeys();
    onWipe?.();
  }, WIPE_AFTER_MS);
}

// Derive wallets from pasted seeds/keys and keep only those whose address is in `wanted`.
// Everything else (and the phrases themselves) is dropped as soon as this returns.
export async function loadKeys(text, { count, start, pathKind, passphrase }, wanted, onProgress, onWipe) {
  const { items, badLines } = parseSecretLines(text);
  let matched = 0;
  let derived = 0;
  const failed = badLines.map((b) => b.lineNo);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i % 5 === 0) {
      onProgress?.(i, items.length);
      await new Promise((r) => setTimeout(r));
    }
    if (it.kind === 'address') continue;
    try {
      const list = await deriveWallets(it, { count, start, pathKind, passphrase });
      for (const { address, wallet } of list) {
        derived++;
        const k = address.toLowerCase();
        if (wanted.has(k) && !KEYS.has(k)) {
          KEYS.set(k, wallet);
          matched++;
        }
      }
    } catch {
      failed.push(it.lineNo);
    }
    it.secret = null;
    it.rawLine = null;
  }
  for (const b of badLines) b.rawLine = null;
  if (KEYS.size) armWipe(onWipe);
  return { secrets: items.filter((x) => x.kind !== 'address').length, derived, matched, failed: failed.sort((a, b) => a - b) };
}

// ---------- execution ----------

// Sends the selected steps. Chains run in parallel; inside a chain strictly one tx at a time (each waits
// for its receipt). Order per chain: bus fundings → wallets that got gas → everyone else → the bus wallet.
export async function executePlan(plan, { stopOnError, onStep, isStopped, rpc }) {
  const dest = plan.dest;
  let stop = false;
  const halted = () => stop || isStopped();
  const active = (s) => s.selected && s.action === 'send';
  const mark = (s, status, error) => {
    s.status = status;
    if (error) s.error = error;
    onStep(s);
  };

  await Promise.all(plan.chains.map(async (c) => {
    const rows = c.rows.filter((r) => r.steps.some(active));
    if (!rows.length || c.error) return;
    let p;
    try {
      p = await getProvider(c.net, c.chain, rpc);
    } catch (e) {
      for (const r of rows) for (const s of r.steps) if (active(s)) mark(s, 'failed', cleanErr(e));
      if (stopOnError) stop = true;
      return;
    }
    const nonces = new Map();
    let fee;

    // one step: re-read what is there now, sign, broadcast, wait. → 'ok' | 'skip' | 'fail'
    async function runStep(s, wallet) {
      let broadcast = false;
      try {
        let tx;
        if (s.kind === 'fund') {
          // re-price at today's fee: the wallet's token gas + its sweep gas − what it already has, + margin
          const r = c.rows.find((x) => x.wallet.address === s.to);
          const need = r.steps.filter((x) => x.kind !== 'fund' && active(x)).reduce((y, x) => y + x.gasLimit * fee.max + (x.l1Wei ?? 0n), 0n)
            - await p.getBalance(s.to, 'latest');
          if (need <= 0n) {
            mark(s, 'skipped', 'газ уже есть');
            return 'skip';
          }
          s.sentRaw = (need * (100n + BUS_MARGIN) + 99n) / 100n;
          tx = { to: s.to, value: s.sentRaw, gasLimit: s.gasLimit };
        } else if (s.kind === 'erc20') {
          const raw = BigInt(await p.call({ to: s.token, data: ERC20.encodeFunctionData('balanceOf', [wallet.address]) }));
          if (raw === 0n) {
            mark(s, 'skipped', 'баланс уже 0');
            return 'skip';
          }
          s.sentRaw = raw;
          tx = { to: s.token, data: ERC20.encodeFunctionData('transfer', [dest, raw]), value: 0n, gasLimit: s.gasLimit };
        } else {
          // re-read: token transfers above usually cost less than reserved, so a bit more goes out
          const bal = await p.getBalance(wallet.address, 'latest');
          const l1 = await l1Fee(p, c.chain, fee, { to: dest, value: bal, gasLimit: s.gasLimit, nonce: 0 });
          const value = bal - (s.gasLimit * fee.max + l1.max);
          const ownGas = s.gasLimit * fee.expected + l1.exp;
          if (value <= 0n || (s.busLeftover ? value <= ownGas : toNum(value) * (s.price ?? 0) < plan.threshold)) {
            mark(s, 'skipped', s.busLeftover ? 'остаток газа меньше комиссии — оставлен' : 'после газа меньше порога');
            return 'skip';
          }
          s.sentRaw = value;
          tx = { to: dest, value, gasLimit: s.gasLimit };
        }
        const k = wallet.address.toLowerCase();
        if (!nonces.has(k)) nonces.set(k, await p.getTransactionCount(wallet.address, 'pending'));
        const signed = await wallet.signTransaction({ ...tx, nonce: nonces.get(k), chainId: c.chain.chainId, ...feeFields(fee) });
        s.hash = ethers.keccak256(signed);
        s.sentAt = new Date().toISOString();
        mark(s, 'pending');
        await p.broadcastTransaction(signed);
        broadcast = true;
        nonces.set(k, nonces.get(k) + 1);
        const rcpt = await p.waitForTransaction(s.hash, 1, CONFIRM_TIMEOUT_MS);
        if (!rcpt) throw new Error('не подтвердилась за 3 минуты — проверь в эксплорере');
        s.gasPaidWei = rcpt.gasUsed * (rcpt.gasPrice ?? 0n); // L2 part only, receipts don't carry the L1 fee
        if (rcpt.status === 1) {
          mark(s, 'confirmed');
          return 'ok';
        }
        mark(s, 'failed', 'транзакция откатилась (reverted)');
      } catch (e) {
        if (broadcast) {
          // already in the mempool: it may still land, so it's neither "failed" nor safe to resend
          mark(s, 'unknown', cleanErr(e));
        } else {
          s.hash = null; // signed but never accepted by the node — nothing to look up
          mark(s, 'failed', cleanErr(e));
        }
      }
      if (stopOnError) stop = true;
      return 'fail';
    }

    const signer = (addr) => KEYS.get(addr.toLowerCase())?.connect(p);
    const skipAll = (steps, status, error) => {
      for (const s of steps) if (!s.status) mark(s, status, error);
    };

    async function runSteps(steps, addr) {
      const wallet = signer(addr);
      if (!wallet) return skipAll(steps, 'nokey');
      try {
        fee = await feeInfo(p, c.chain, plan.headroomPct);
      } catch (e) {
        return skipAll(steps, 'failed', cleanErr(e));
      }
      for (const s of steps) {
        if (halted()) {
          mark(s, 'stopped');
          continue;
        }
        if (await runStep(s, wallet) === 'fail') {
          // nonce/balance state of this wallet is now uncertain — don't send its remaining steps
          skipAll(steps, 'stopped', 'пропущено после ошибки');
          break;
        }
      }
    }

    // 1. the bus delivers gas
    const fundings = rows.flatMap((r) => r.steps.filter((s) => s.kind === 'fund' && active(s)));
    if (fundings.length) await runSteps(fundings, fundings[0].address);
    // 2. funded wallets, 3. the rest, 4. the bus wallet itself
    const ordered = [...rows.filter((r) => r.funded), ...rows.filter((r) => !r.funded && !r.isFunder), ...rows.filter((r) => r.isFunder)];
    for (const r of ordered) {
      const queue = r.steps.filter((s) => s.kind !== 'fund' && active(s)).sort((a, b) => (a.kind === 'native') - (b.kind === 'native'));
      if (!queue.length) continue;
      const fs = r.steps.find((s) => s.kind === 'fund');
      if (r.funded && fs && !['confirmed', 'skipped'].includes(fs.status)) {
        skipAll(queue, 'stopped', 'газ не довезён — автобус не приехал');
        continue;
      }
      await runSteps(queue, r.wallet.address);
    }
  }));
}
