// Balances of the destination and the test wallets on all local chains.
//   node verify.mjs snapshot  → saves current balances to ./data/before.json
//   node verify.mjs           → prints what changed since the snapshot
import fs from 'node:fs/promises';
import { ethers } from 'ethers';
import { CHAINS, DEST } from './fixture.mjs';

const file = new URL('./data/before.json', import.meta.url);
const wallets = JSON.parse(await fs.readFile(new URL('./data/wallets.json', import.meta.url), 'utf8')).items;
const scan = JSON.parse(await fs.readFile(new URL('./data/scan.json', import.meta.url), 'utf8'));
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const DEC = {}; // symbol → decimals
for (const w of Object.values(scan.wallets)) for (const e of Object.values(w.nets)) for (const t of e.tokens) if (!t.native) DEC[t.symbol] = t.decimals;
const fmt = (sym, v) => ethers.formatUnits(v, DEC[sym] ?? 18);

async function balances() {
  const out = {};
  for (const [net, c] of Object.entries(CHAINS)) {
    const p = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
    const tokens = new Map();
    for (const w of Object.values(scan.wallets)) for (const t of w.nets[net]?.tokens ?? []) if (!t.native) tokens.set(t.token, t);
    for (const who of [{ label: 'DEST', address: DEST }, ...wallets]) {
      const row = { [c.native]: (await p.getBalance(who.address)).toString() };
      for (const [addr, t] of tokens) row[t.symbol] = BigInt(await p.call({ to: addr, data: erc20.encodeFunctionData('balanceOf', [who.address]) })).toString();
      out[`${net} ${who.label}`] = row;
    }
  }
  return out;
}

const now = await balances();
if (process.argv[2] === 'snapshot') {
  await fs.writeFile(file, JSON.stringify(now, null, 1));
  console.log('snapshot saved');
} else {
  const before = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const [k, row] of Object.entries(now)) {
    const diffs = Object.entries(row)
      .filter(([sym, v]) => v !== before[k][sym])
      .map(([sym, v]) => `${sym} ${fmt(sym, BigInt(before[k][sym]))} → ${fmt(sym, BigInt(v))} (Δ ${fmt(sym, BigInt(v) - BigInt(before[k][sym]))})`);
    if (diffs.length) console.log(`${k}: ${diffs.join('; ')}`);
  }
}
