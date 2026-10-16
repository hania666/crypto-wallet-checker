// Deploys test tokens on the three local Hardhat chains, funds test wallets with fixed amounts and
// writes a fixture data dir (wallets.json / scan.json / config.json) for the panel in test mode.
// Uses only public test mnemonics. Run after `npm run chains` (see README.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { ethers } from 'ethers';
import { TEST_WALLET_MNEMONIC, TEST_KEY_INDEX, DEST, CHAINS, SCENARIO, PRICES } from './fixture.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'data');

function compile(source) {
  const input = {
    language: 'Solidity',
    sources: { 'Token.sol': { content: source } },
    settings: { evmVersion: 'berlin', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['Token.sol'].Token;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// Mock OP GasPriceOracle: any call returns a constant L1 fee (wei).
// PUSH32 fee, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN
const mockOracleCode = (fee) => '0x7f' + ethers.toBeHex(fee, 32).slice(2) + '600052' + '60206000f3';


const { abi, bytecode } = compile(await fs.readFile(path.join(DIR, 'Token.sol'), 'utf8'));

const root = ethers.HDNodeWallet.fromPhrase(TEST_WALLET_MNEMONIC, undefined, "m/44'/60'/0'/0");
const seedWallets = SCENARIO.seedAccounts.map((_, i) => root.deriveChild(i).address);
const keyWallet = root.deriveChild(TEST_KEY_INDEX).address;

const wallets = [
  ...seedWallets.map((address, i) => ({ id: i + 1, address, label: `Акк ${i + 1}`, group: 'Сид 1', source: `seed «Сид 1» m/44'/60'/0'/0/${i}` })),
  { id: seedWallets.length + 1, address: keyWallet, label: 'Ключ 1', group: 'Приватные ключи', source: 'private key' },
].map((w) => ({ ...w, addedAt: new Date().toISOString(), aliases: [] }));
const accounts = [...SCENARIO.seedAccounts, SCENARIO.keyAccount];

const scan = { scannedAt: new Date().toISOString(), wallets: {} };
for (const w of wallets) scan.wallets[w.address.toLowerCase()] = { nets: {}, scannedAt: scan.scannedAt };

for (const [net, c] of Object.entries(CHAINS)) {
  const p = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  p.pollingInterval = 100;
  const funder = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/0").connect(p);
  let nonce = await p.getTransactionCount(funder.address, 'pending');
  const fee = c.legacy ? { type: 0, gasPrice: BigInt(await p.send('eth_gasPrice', [])) * 2n } : {};
  const send = async (tx) => (await funder.sendTransaction({ ...fee, ...tx, nonce: nonce++ })).wait();

  if (c.l1Fee) await p.send('hardhat_setCode', ['0x420000000000000000000000000000000000000F', mockOracleCode(c.l1Fee)]);

  const tokens = {};
  for (const t of SCENARIO.tokens) {
    const f = new ethers.ContractFactory(abi, bytecode, funder);
    const ct = await f.deploy(t.name, t.symbol, t.decimals, { ...fee, nonce: nonce++ });
    await ct.waitForDeployment();
    tokens[t.symbol] = { ...t, address: (await ct.getAddress()).toLowerCase(), contract: ct };
  }
  const nativePrice = PRICES[c.native];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const a = accounts[i];
    const entry = { tokens: [], error: null, at: scan.scannedAt };
    const nat = a.native?.[net] ?? a.native?.all;
    if (nat) {
      await send({ to: w.address, value: ethers.parseEther(nat) });
      entry.tokens.push({ token: null, native: true, symbol: c.native, name: '', decimals: 18, amount: nat, price: nativePrice, value: Number(nat) * nativePrice, spam: false });
    }
    for (const [sym, amt] of Object.entries(a.tokens ?? {})) {
      const t = tokens[sym];
      const tx = await t.contract.mint.populateTransaction(w.address, ethers.parseUnits(amt, t.decimals));
      await send(tx);
      entry.tokens.push({ token: t.address, native: false, symbol: t.symbol, name: t.name, decimals: t.decimals, amount: amt, price: t.price, value: t.price == null ? null : Number(amt) * t.price, spam: Boolean(t.spam) });
    }
    if (entry.tokens.length) scan.wallets[w.address.toLowerCase()].nets[net] = entry;
  }
  console.log(`${net}: tokens ${Object.values(tokens).map((t) => `${t.symbol}=${t.address}`).join(' ')}`);
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'wallets.json'), JSON.stringify({ nextId: wallets.length + 1, items: wallets }, null, 1));
await fs.writeFile(path.join(OUT, 'scan.json'), JSON.stringify(scan, null, 1));
await fs.writeFile(path.join(OUT, 'config.json'), JSON.stringify({ apiKey: '', networks: [], dustUsd: 1, hiddenTokens: [], networkStatus: {} }, null, 1));
console.log(`Fixture written to ${OUT}. Destination for the test: ${DEST}`);
