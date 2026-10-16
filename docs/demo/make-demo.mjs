// Builds a fake dataset for screenshots / trying the UI without an API key.
// Wallets come from the public Hardhat test mnemonic — never real funds, never real users.
//   node docs/demo/make-demo.mjs [en]   →  docs/demo/data/*.json (or data-en/ with English names)
//   node docs/demo/run-demo.mjs [en]    →  panel with this data on http://127.0.0.1:4779
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDNodeWallet, Mnemonic } from 'ethers';

const LANG = process.argv[2] === 'en' ? 'en' : 'ru';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), LANG === 'en' ? 'data-en' : 'data');
const SEED = LANG === 'en' ? 'Seed' : 'Сид';
const ACC = LANG === 'en' ? 'Acc' : 'Акк';
const PHRASE = 'test test test test test test test test test test test junk';
const root = HDNodeWallet.fromSeed(Mnemonic.fromPhrase(PHRASE).computeSeed());

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647); // deterministic, so screenshots are stable
const now = new Date().toISOString();

const wallets = [];
let id = 1;
for (let s = 1; s <= 5; s++) {
  for (let a = 0; a < 5; a++) {
    const p = `m/44'/60'/0'/0/${(s - 1) * 5 + a}`;
    wallets.push({ id: id++, address: root.derivePath(p).address, label: `${ACC} ${a + 1}`, group: `${SEED} ${s}`, source: `seed «${SEED} ${s}» ${p}`, addedAt: now });
  }
}

const T = (symbol, name, amount, price, native = false, spam = false) => ({
  token: native ? null : '0x' + Math.floor(rnd() * 1e16).toString(16).padStart(40, '0').slice(0, 40),
  native, symbol, name, decimals: 18, amount: String(amount), price, value: price == null ? null : amount * price, spam,
});
const ETH = 2450;
const pick = () => rnd();
const scanWallets = {};
for (const w of wallets) {
  const nets = {};
  const r = pick();
  const add = (net, tokens) => { nets[net] = { tokens, error: null, at: now }; };
  for (const net of ['eth-mainnet', 'arb-mainnet', 'opt-mainnet', 'base-mainnet', 'bnb-mainnet', 'linea-mainnet', 'zksync-mainnet', 'scroll-mainnet']) add(net, []);
  if (r < 0.55) add('base-mainnet', [T('ETH', 'Ethereum', +(pick() * 0.004).toFixed(6), ETH, true), ...(pick() < 0.3 ? [T('USDC', 'USD Coin', +(pick() * 12).toFixed(2), 1)] : [])]);
  if (r < 0.25) add('arb-mainnet', [T('ETH', 'Ethereum', +(pick() * 0.003).toFixed(6), ETH, true), ...(pick() < 0.4 ? [T('ARB', 'Arbitrum', +(pick() * 40).toFixed(2), 0.42)] : [])]);
  if (r > 0.7) add('bnb-mainnet', pick() < 0.5 ? [T('BNB', 'BNB', +(pick() * 0.02).toFixed(5), 730, true)] : [T('USDT', 'Tether USD', +(pick() * 15).toFixed(2), 1)]);
  if (r > 0.85) add('eth-mainnet', [T('ETH', 'Ethereum', +(pick() * 0.002).toFixed(6), ETH, true)]);
  if (pick() < 0.4) (nets['base-mainnet'].tokens).push(T('Visit claim-usdc.xyz', 'Claim your reward', 1000, 3, false, true));
  scanWallets[w.address.toLowerCase()] = { scannedAt: now, nets };
}

const activity = { scannedAt: now, wallets: {}, marks: {}, collectors: [], ownExtra: [], errors: [] };
for (const w of wallets) {
  const swaps = Math.floor(pick() * 8);
  const outExt = Math.floor(pick() * 4);
  const contracts = Math.floor(pick() * 5);
  const inExt = Math.floor(pick() * 6);
  const otherSent = Math.floor(pick() * 6);
  const score = swaps * 3 + outExt * 2 + contracts * 1.5 + inExt + otherSent * 0.5;
  if (score === 0) continue;
  const chain = pick() < 0.5 ? 'base' : 'bnb';
  activity.wallets[w.address.toLowerCase()] = {
    score,
    chains: { [chain]: { nonce: swaps + outExt + contracts + otherSent, swaps, outExt, contracts, inExt, polymarket: 0, internal: 0, otherSent, first: '2025-06-21T10:00:00Z', last: '2025-11-02T10:00:00Z' } },
    peers: [],
  };
}

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'wallets.json'), JSON.stringify({ nextId: id, items: wallets }, null, 1));
fs.writeFileSync(path.join(DIR, 'scan.json'), JSON.stringify({ scannedAt: now, wallets: scanWallets }, null, 1));
fs.writeFileSync(path.join(DIR, 'activity.json'), JSON.stringify(activity, null, 1));
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  apiKey: 'demo-key-not-real', dustUsd: 0.5, hiddenTokens: [], networkStatus: {},
  networks: ['eth-mainnet', 'arb-mainnet', 'opt-mainnet', 'base-mainnet', 'zksync-mainnet', 'linea-mainnet', 'scroll-mainnet', 'bnb-mainnet'],
}, null, 1));
console.log(`demo data: ${wallets.length} wallets → ${DIR}`);
