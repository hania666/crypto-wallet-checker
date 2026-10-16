// Wallet activity: which of the user's wallets were actually used (swaps, transfers to outside addresses,
// contract calls, Polymarket) — so the few daily slots on reward checkers go to wallets that can qualify.
// Read-only: only public RPC reads and Alchemy's Transfers API. Results in data/activity.json.

const CHAINS = [
  { id: 'eth', alchemy: 'eth-mainnet', name: 'Ethereum', explorer: 'https://etherscan.io', internal: true, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'] },
  { id: 'base', alchemy: 'base-mainnet', name: 'Base', explorer: 'https://basescan.org', rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'] },
  { id: 'arb', alchemy: 'arb-mainnet', name: 'Arbitrum', explorer: 'https://arbiscan.io', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  { id: 'opt', alchemy: 'opt-mainnet', name: 'Optimism', explorer: 'https://optimistic.etherscan.io', rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'] },
  { id: 'polygon', alchemy: 'polygon-mainnet', name: 'Polygon', explorer: 'https://polygonscan.com', internal: true, rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'] },
  { id: 'bnb', alchemy: 'bnb-mainnet', name: 'BNB Chain', explorer: 'https://bscscan.com', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'] },
  { id: 'linea', alchemy: 'linea-mainnet', name: 'Linea', explorer: 'https://lineascan.build', rpcs: ['https://linea-rpc.publicnode.com', 'https://rpc.linea.build'] },
  { id: 'zksync', alchemy: 'zksync-mainnet', name: 'zkSync Era', explorer: 'https://era.zksync.network', rpcs: ['https://mainnet.era.zksync.io'] },
  { id: 'scroll', alchemy: 'scroll-mainnet', name: 'Scroll', explorer: 'https://scrollscan.com', rpcs: ['https://scroll-rpc.publicnode.com', 'https://rpc.scroll.io'] },
  { id: 'blast', alchemy: 'blast-mainnet', name: 'Blast', explorer: 'https://blastscan.io', rpcs: ['https://blast-rpc.publicnode.com', 'https://rpc.blast.io'] },
  { id: 'avax', alchemy: 'avax-mainnet', name: 'Avalanche', explorer: 'https://snowtrace.io', rpcs: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'] },
];
export const ACTIVITY_CHAINS = CHAINS.map(({ id, name, explorer }) => ({ id, name, explorer }));

// well-known contracts, only for nicer labels — classification itself doesn't depend on this list
const LABELS = {
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap',
  '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3',
  '0x10ed43c718714eb63d5aa57b78b54704e256024e': 'PancakeSwap',
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'PancakeSwap',
  '0x1a0a18ac4becddbd6389559687d1a73d8927e416': 'PancakeSwap',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x',
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': 'LI.FI',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': 'Polymarket',
  '0xc5d563a36ae78145c45a50134d48a1215220f80a': 'Polymarket',
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045': 'Polymarket',
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296': 'Polymarket',
};
const POLYMARKET = new Set(Object.entries(LABELS).filter(([, v]) => v === 'Polymarket').map(([k]) => k));
// Incoming tokens count as "money came in" only for these exact contracts (plus native coins).
// Symbols can't be trusted: address-poisoning spam mints fake "USDT" from look-alike addresses.
const REAL_TOKENS = {
  eth: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0x6b175474e89094c44da98b954eedeac495271d0f'],
  base: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x4200000000000000000000000000000000000006', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'],
  arb: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
  opt: ['0x0b2c639c533813f4aa9d7837caf62653d097ff85', '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', '0x4200000000000000000000000000000000000006'],
  polygon: ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'],
  bnb: ['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0xe9e7cea3dcdae0b0f1d5eabf8b2a4f4cbb3bd60b'],
  linea: ['0x176211869ca2b568f2a7d4ee941e073a821ee1ff', '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f'],
};
const REAL_TOKEN_SET = Object.fromEntries(Object.entries(REAL_TOKENS).map(([k, v]) => [k, new Set(v)]));
// an address that 50+ of the user's wallets sent to is the user's own collection address (e.g. today's sweep)
const COLLECTOR_MIN_WALLETS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// EIP-7702 delegated accounts carry code 0xef0100<impl> but are still people's wallets, not contracts
const isContractCode = (code) => Boolean(code && code !== '0x' && !code.startsWith('0xef0100'));
const alchemyUrl = (apiKey, chain) => `https://${chain.alchemy}.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`;

async function rpcBatch(urls, calls) {
  let lastErr;
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c[0], params: c[1] }))),
        signal: AbortSignal.timeout(25_000),
      });
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      const out = new Array(calls.length).fill(undefined);
      for (const r of json) out[r.id] = r.error ? undefined : r.result;
      if (out.some((x) => x === undefined)) throw new Error('incomplete batch');
      return out;
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function alchemyCall(apiKey, chain, method, params) {
  const url = `https://${chain.alchemy}.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      lastErr = new Error(`сеть недоступна: ${e.message}`); // never the URL: it carries the key
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Alchemy HTTP ${res.status}`);
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (json.error) {
      const e = new Error(json.error.message ?? 'ошибка Alchemy');
      e.rpc = true;
      throw e;
    }
    if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
    return json.result;
  }
  throw lastErr;
}

async function getTransfers(apiKey, chain, dir, address) {
  // excludeZeroValue: zero-value transfers are almost always address-poisoning spam
  const base = { fromBlock: '0x0', toBlock: 'latest', withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8', order: 'asc' };
  base[dir === 'out' ? 'fromAddress' : 'toAddress'] = address;
  const categorySets = [
    [...(chain.internal ? ['internal'] : []), 'external', 'erc20', 'erc721', 'erc1155'],
    ['external', 'erc20'],
  ];
  for (let ci = 0; ci < categorySets.length; ci++) {
    try {
      const all = [];
      let pageKey;
      for (let page = 0; page < 5; page++) {
        const r = await alchemyCall(apiKey, chain, 'alchemy_getAssetTransfers', [{ ...base, category: categorySets[ci], ...(pageKey ? { pageKey } : {}) }]);
        all.push(...(r?.transfers ?? []));
        pageKey = r?.pageKey;
        if (!pageKey) break;
      }
      return all;
    } catch (e) {
      // some chains don't know erc721/erc1155/internal → retry with the basic set
      if (e.rpc && ci === 0) continue;
      throw e;
    }
  }
  return [];
}

async function runPool(tasks, limit) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) await tasks[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

export function createActivity({ getWallets, getApiKey, load, save }) {
  let data = null; // { scannedAt, wallets: { [addrLower]: {...} }, collectors: [], marks: { [addrLower]: isoDate } }
  const job = { running: false, stage: '', done: 0, total: 0, startedAt: null, finishedAt: null, lastError: null };

  async function ensure() {
    if (!data) data = await load();
    data.marks ??= {};
    data.wallets ??= {};
    return data;
  }

  async function scan() {
    const apiKey = getApiKey();
    const wallets = getWallets();
    const addrs = wallets.map((w) => w.address);
    await ensure();
    const own = new Set([...addrs, ...(data.ownExtra ?? [])].map((a) => a.toLowerCase()));

    // 1) how many txs each wallet ever sent, per chain (cheap, public RPC, batched)
    job.stage = 'Считаю транзакции по сетям';
    job.total = CHAINS.length;
    job.done = 0;
    const nonces = {}; // chainId -> number[]
    await runPool(CHAINS.map((chain) => async () => {
      const res = new Array(addrs.length).fill(0);
      for (let i = 0; i < addrs.length; i += 50) {
        const part = addrs.slice(i, i + 50);
        try {
          const out = await rpcBatch(chain.rpcs, part.map((a) => ['eth_getTransactionCount', [a, 'latest']]));
          out.forEach((x, k) => { res[i + k] = parseInt(x, 16) || 0; });
        } catch {
          // public RPC failed — fall back to Alchemy one by one for this slice
          for (let k = 0; k < part.length; k++) {
            try { res[i + k] = parseInt(await alchemyCall(apiKey, chain, 'eth_getTransactionCount', [part[k], 'latest']), 16) || 0; } catch { res[i + k] = 0; }
          }
        }
      }
      nonces[chain.id] = res;
      job.done++;
    }), 4);

    // 2) full transfer history only where the wallet actually sent something
    const pairs = [];
    addrs.forEach((a, i) => CHAINS.forEach((c) => { if (nonces[c.id][i] > 0) pairs.push({ a, i, chain: c }); }));
    job.stage = 'Читаю историю переводов';
    job.total = pairs.length;
    job.done = 0;
    const raw = {}; // addrLower -> chainId -> transfers[]
    const errors = [];
    await runPool(pairs.map(({ a, chain }) => async () => {
      try {
        const [outs, ins] = [await getTransfers(apiKey, chain, 'out', a), await getTransfers(apiKey, chain, 'in', a)];
        ((raw[a.toLowerCase()] ??= {})[chain.id] = [...outs, ...ins]);
      } catch (e) {
        errors.push(`${chain.name}: ${e.message}`);
        ((raw[a.toLowerCase()] ??= {})[chain.id] = null);
      }
      job.done++;
    }), 2);

    // 3) which token transfers "from" the wallet were really sent by it: poisoning spam emits
    //    transferFrom(victim → look-alike) in someone else's tx. Native transfers are always genuine.
    job.stage = 'Проверяю, кто отправлял транзакции';
    const sender = {}; // chainId -> Map(hash -> from)
    const toCheck = {};
    for (const [a, byChain] of Object.entries(raw)) {
      for (const [cid, list] of Object.entries(byChain)) {
        for (const t of list ?? []) {
          if (t.from?.toLowerCase() === a && t.category !== 'external') (toCheck[cid] ??= new Set()).add(t.hash);
        }
      }
    }
    job.total = Object.values(toCheck).reduce((s, set) => s + Math.ceil(set.size / 50), 0);
    job.done = 0;
    for (const chain of CHAINS) {
      const list = [...(toCheck[chain.id] ?? [])];
      sender[chain.id] = new Map();
      for (let i = 0; i < list.length; i += 50) {
        const part = list.slice(i, i + 50);
        try {
          const out = await rpcBatch([...chain.rpcs, alchemyUrl(apiKey, chain)], part.map((h) => ['eth_getTransactionByHash', [h]]));
          out.forEach((tx, k) => sender[chain.id].set(part[k], tx?.from?.toLowerCase() ?? null));
        } catch {
          part.forEach((h) => sender[chain.id].set(h, null));
        }
        job.done++;
      }
    }
    const sentBy = (chainId, t, a) => t.from?.toLowerCase() === a && (t.category === 'external' || sender[chainId].get(t.hash) === a);

    // 4) where the wallets sent money (genuinely sent txs only); 50+ own wallets → own collection address
    const receivedFrom = new Map();
    for (const [a, byChain] of Object.entries(raw)) {
      for (const [cid, list] of Object.entries(byChain)) {
        for (const t of list ?? []) {
          if (!t.to || !sentBy(cid, t, a)) continue;
          const to = t.to.toLowerCase();
          if (!receivedFrom.has(to)) receivedFrom.set(to, new Set());
          receivedFrom.get(to).add(a);
        }
      }
    }
    const collectorCandidates = [...receivedFrom.entries()].filter(([, from]) => from.size >= COLLECTOR_MIN_WALLETS).map(([to]) => to);
    const collectors = new Set();
    for (const addr of collectorCandidates) {
      let contract = false;
      for (const chain of CHAINS) {
        try {
          const [code] = await rpcBatch([...chain.rpcs, alchemyUrl(apiKey, chain)], [['eth_getCode', [addr, 'latest']]]);
          if (isContractCode(code)) { contract = true; break; }
        } catch {}
      }
      if (!contract) collectors.add(addr);
    }
    const isOwn = (x) => own.has(x) || collectors.has(x);

    // 5) which counterparties are contracts (per chain, batched getCode)
    job.stage = 'Определяю контракты';
    const codeOf = {};
    const counterparties = {};
    for (const [a, byChain] of Object.entries(raw)) {
      for (const [cid, list] of Object.entries(byChain)) {
        for (const t of list ?? []) {
          const peer = (sentBy(cid, t, a) ? t.to : t.to?.toLowerCase() === a ? t.from : null)?.toLowerCase();
          if (peer && !isOwn(peer)) (counterparties[cid] ??= new Set()).add(peer);
        }
      }
    }
    job.total = Object.values(counterparties).reduce((s, set) => s + Math.ceil(set.size / 50), 0);
    job.done = 0;
    for (const chain of CHAINS) {
      const list = [...(counterparties[chain.id] ?? [])];
      codeOf[chain.id] = new Map();
      for (let i = 0; i < list.length; i += 50) {
        const part = list.slice(i, i + 50);
        try {
          const out = await rpcBatch([...chain.rpcs, alchemyUrl(apiKey, chain)], part.map((x) => ['eth_getCode', [x, 'latest']]));
          out.forEach((code, k) => codeOf[chain.id].set(part[k], isContractCode(code)));
        } catch {
          part.forEach((x) => codeOf[chain.id].set(x, null));
        }
        job.done++;
      }
    }

    // 6) classify each transaction of each wallet
    const results = {};
    wallets.forEach((w, i) => {
      const a = w.address.toLowerCase();
      const chains = {};
      let score = 0;
      const peers = new Map();
      const addPeer = (cid, addr, dir) => {
        const k = `${cid}:${addr}`;
        const p = peers.get(k) ?? { chain: cid, address: addr, out: 0, in: 0 };
        p[dir]++;
        peers.set(k, p);
      };
      for (const chain of CHAINS) {
        const nonce = nonces[chain.id][i];
        const list = raw[a]?.[chain.id];
        if (!nonce && !list) continue;
        const c = { nonce, swaps: 0, outExt: 0, contracts: 0, inExt: 0, polymarket: 0, internal: 0, otherSent: 0, first: null, last: null, error: list === null };
        const byHash = new Map();
        for (const t of list ?? []) {
          if (!byHash.has(t.hash)) byHash.set(t.hash, []);
          byHash.get(t.hash).push(t);
        }
        let sentCount = 0;
        for (const txs of byHash.values()) {
          const outs = txs.filter((t) => sentBy(chain.id, t, a));
          const sent = outs.length > 0;
          const assetKey = (t) => (t.rawContract?.address ?? 'native').toLowerCase();
          const realValue = (t) => (t.category === 'external' || t.category === 'internal' || REAL_TOKEN_SET[chain.id]?.has(assetKey(t)));
          // poisoning also sends real USDC/ETH dust (0.000001) from look-alike addresses — ignore crumbs
          const notDust = (t) => Number(t.value) >= (/USD|DAI/i.test(String(t.asset)) ? 0.01 : 0.00001);
          const ins = txs.filter((t) => t.to?.toLowerCase() === a && (sent || (realValue(t) && notDust(t))));
          if (!sent && !ins.length) continue; // spam / poisoning
          if (sent) sentCount++;
          const peersInTx = [...outs.map((t) => t.to), ...ins.map((t) => t.from)].map((x) => x?.toLowerCase()).filter(Boolean);
          let kind;
          if (peersInTx.length && peersInTx.every(isOwn)) kind = 'internal';
          else if (peersInTx.some((x) => POLYMARKET.has(x)) || txs.some((t) => POLYMARKET.has(assetKey(t)))) kind = 'polymarket';
          else if (sent && ins.length && outs.some((o) => ins.some((n) => assetKey(n) !== assetKey(o)))) kind = 'swaps';
          else if (sent) {
            const to = outs[0].to?.toLowerCase();
            kind = codeOf[chain.id].get(to) ? 'contracts' : 'outExt';
            if (to && !isOwn(to)) addPeer(chain.id, to, 'out');
          } else {
            const from = ins[0].from?.toLowerCase();
            if (from && isOwn(from)) kind = 'internal';
            else {
              kind = 'inExt';
              if (from) addPeer(chain.id, from, 'in');
            }
          }
          c[kind]++;
          if (kind === 'internal') continue;
          const ts = txs[0]?.metadata?.blockTimestamp ?? null;
          if (ts) {
            if (!c.first || ts < c.first) c.first = ts;
            if (!c.last || ts > c.last) c.last = ts;
          }
        }
        // sent txs that carried no transfer at all: approvals, claims, votes, mints without value
        c.otherSent = list ? Math.max(0, nonce - sentCount) : nonce;
        chains[chain.id] = c;
        score += c.polymarket * 10 + c.swaps * 3 + c.outExt * 2 + c.contracts * 1.5 + c.inExt * 1 + c.otherSent * 0.5;
      }
      const topPeers = [...peers.values()]
        .sort((x, y) => y.out + y.in - (x.out + x.in))
        .slice(0, 6)
        .map((p) => ({
          ...p,
          contract: codeOf[p.chain]?.get(p.address) ?? null,
          label: LABELS[p.address] ?? null,
          sharedWallets: receivedFrom.get(p.address)?.size ?? 0, // how many of the user's wallets sent here
        }));
      results[a] = { score: Math.round(score * 10) / 10, chains, peers: topPeers };
    });

    data.scannedAt = new Date().toISOString();
    data.wallets = results;
    data.collectors = [...collectors];
    data.errors = [...new Set(errors)].slice(0, 20);
    await save(data);
  }

  return {
    chains: ACTIVITY_CHAINS,
    job,
    async get() {
      await ensure();
      return { job, chains: ACTIVITY_CHAINS, labels: LABELS, ...data };
    },
    start() {
      if (job.running) throw Object.assign(new Error('Проверка уже идёт'), { status: 409 });
      if (!getApiKey()) throw Object.assign(new Error('Нужен Alchemy API key'), { status: 400 });
      if (!getWallets().length) throw Object.assign(new Error('Нет кошельков'), { status: 400 });
      Object.assign(job, { running: true, stage: 'Старт', done: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, lastError: null });
      scan()
        .catch((e) => { job.lastError = e.message; console.error('activity scan failed', e); })
        .finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); job.stage = ''; });
    },
    async setOwnExtra(list) {
      await ensure();
      data.ownExtra = [...new Set((list ?? []).map((x) => String(x).trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x)))].slice(0, 50);
      await save(data);
      return data.ownExtra;
    },
    // "added to the reward checker on <date>" — so the user can do 5 a day without losing track
    async mark(address, on) {
      await ensure();
      const k = String(address).toLowerCase();
      if (on) data.marks[k] = new Date().toISOString();
      else delete data.marks[k];
      await save(data);
      return data.marks;
    },
  };
}
