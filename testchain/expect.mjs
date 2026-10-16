// Hand-computed plan for the fixture, written independently of public/sweep.js, to compare with the
// numbers the "Сборщик" tab shows. Run right after "Построить план" (nothing must be mined between).
// Settings assumed: threshold $1, gas headroom 50%, gas bus on (auto), destination = DEST.
//
//   legacy:   gas price = eth_gasPrice                          (reserve = expected)
//   EIP-1559: reserve price = base*1.5 + tip, expected = base + tip
//   L1 (OP):  oracle fee F → reserve 1.5·F, expected F
//   token:    reserve = ceil(est*1.2)·reserve price (+1.5F); worth it if value − reserve ≥ $1
//   native:   sent = balance − Σ token reserves − 21000·reserve price (−1.5F); sent if ≥ $1
//   no gas for its tokens → class (c). Gas bus for it:
//     need = Σ token reserves + its sweep reserve − its balance;  fund = ceil(need·1.10)
//     ride cost = fund tx reserve (21000·reserve price + 1.5F) + Σ token reserves + sweep reserve
//     funded only if Σ token value − ride cost ≥ $1, else "не выгодно"
//     bus = wallet with most spare native (balance − own token reserves − own sweep reserve);
//     its own native sweep shrinks by Σ (fund + fund tx reserve); leftover the funded wallet returns
//     ≥ balance + fund − Σ token reserves − sweep reserve   (the plan's conservative figure)
//   delivered to DEST = Σ token values + Σ native sent   (token gas is already inside the native numbers)
import { ethers } from 'ethers';
import fs from 'node:fs/promises';
import { CHAINS, PRICES, DEST } from './fixture.mjs';

const wallets = JSON.parse(await fs.readFile(new URL('./data/wallets.json', import.meta.url), 'utf8')).items;
const scan = JSON.parse(await fs.readFile(new URL('./data/scan.json', import.meta.url), 'utf8'));
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256)']);
const $ = (x) => `$${x.toFixed(4)}`;
const E = (w) => ethers.formatEther(w);

let total = 0;
for (const [net, c] of Object.entries(CHAINS)) {
  const p = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const price = PRICES[c.native];
  const usd = (w) => Number(E(w)) * price;
  let max;
  let exp;
  if (c.legacy) max = exp = BigInt(await p.send('eth_gasPrice', []));
  else {
    const base = (await p.getBlock('latest')).baseFeePerGas;
    const tip = BigInt(await p.send('eth_maxPriorityFeePerGas', []));
    max = base + (base * 50n) / 100n + tip;
    exp = base + tip;
  }
  const l1Max = c.l1Fee ? (c.l1Fee * 150n) / 100n : 0n;
  const l1Exp = c.l1Fee ?? 0n;
  const sweepRes = 21000n * max + l1Max;
  const fundTx = 21000n * max + l1Max;
  console.log(`\n== ${net}: reserve price ${ethers.formatUnits(max, 'gwei')} gwei${l1Max ? `, L1 reserve ${E(l1Max)}` : ''}`);

  const rows = [];
  for (const w of wallets) {
    const e = scan.wallets[w.address.toLowerCase()].nets[net];
    if (!e) continue;
    const scanTotal = e.tokens.filter((t) => !t.spam && t.price != null).reduce((s, t) => s + t.value, 0);
    if (scanTotal < 1) continue; // not even a candidate
    const bal = await p.getBalance(w.address);
    const toks = [];
    for (const t of e.tokens.filter((x) => !x.native && !x.spam && x.price != null)) {
      const raw = BigInt(await p.call({ to: t.token, data: erc20.encodeFunctionData('balanceOf', [w.address]) }));
      const value = Number(ethers.formatUnits(raw, t.decimals)) * t.price;
      if (value < 1) continue;
      const est = await p.estimateGas({ from: w.address, to: t.token, data: erc20.encodeFunctionData('transfer', [DEST, raw]) });
      const res = ((est * 1200n + 999n) / 1000n) * max + l1Max;
      if (value - usd(res) < 1) continue;
      toks.push({ sym: t.symbol, value, res, expGas: est * exp + l1Exp });
    }
    const tokRes = toks.reduce((s, t) => s + t.res, 0n);
    rows.push({ w, bal, toks, tokRes, needy: toks.length > 0 && tokRes > bal });
  }

  // gas bus
  const spare = (r) => r.bal - r.tokRes - sweepRes;
  const busCands = rows.filter((r) => !r.needy && r.bal > 0n && spare(r) > 0n).sort((a, b) => (spare(b) > spare(a) ? 1 : -1));
  const bus = busCands[0];
  let busSpent = 0n;
  for (const r of rows.filter((x) => x.needy)) {
    const need = r.tokRes + sweepRes - r.bal;
    const fund = (need * 110n + 99n) / 100n;
    const value = r.toks.reduce((s, t) => s + t.value, 0);
    const cost = usd(fundTx + r.tokRes + sweepRes);
    if (value - cost < 1) { r.note = `не выгодно: ${$(value)} − ride ${$(cost)} = ${$(value - cost)}`; continue; }
    r.fund = fund;
    busSpent += fund + fundTx;
    const left = r.bal + fund - r.tokRes - sweepRes;
    r.left = left > 0n ? left : 0n;
    r.note = `bus brings ${E(fund)} (need ${E(need)}), ride ${$(cost)}, profit ${$(value - cost)}, leftover ≈ ${E(r.left)} = ${$(usd(r.left))}`;
  }

  for (const r of rows) {
    const lines = [];
    if (r.needy && !r.fund) {
      lines.push(...r.toks.map((t) => `${t.sym}: ${$(t.value)} → нужен газ`), r.note);
    } else {
      for (const t of r.toks) {
        total += t.value;
        lines.push(`${t.sym}: value ${$(t.value)} gas reserve ${$(usd(t.res))} → send`);
      }
      if (r.fund) {
        total += usd(r.left);
        lines.push(r.note);
      } else {
        let sent = r.bal - r.tokRes - sweepRes;
        if (r === bus && busSpent) sent -= busSpent;
        const v = sent > 0n ? usd(sent) : 0;
        if (v >= 1) total += v;
        lines.push(`native: ${E(r.bal)} − tokens ${E(r.tokRes)} − own ${E(sweepRes)}${r === bus && busSpent ? ` − bus ${E(busSpent)}` : ''} = ${E(sent)} = ${$(v)} → ${v >= 1 ? 'send' : 'skip'}`);
      }
    }
    console.log(`#${r.w.id} ${r.w.label}${r === bus && busSpent ? ' 🚌' : ''}\n   ${lines.join('\n   ')}`);
  }
}
console.log(`\nTOTAL delivered to destination: ${$(total)}`);
