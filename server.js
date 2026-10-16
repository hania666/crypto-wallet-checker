// Local wallet balance panel. Binds to 127.0.0.1 only.
// Stores addresses, labels and scan results in ./data — never seed phrases or private keys
// (those are turned into addresses inside the browser and never sent here).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, formatUnits } from 'ethers';
import { NETWORKS, NETWORK_BY_ID } from './public/networks.js';
import { rpcOrigins } from './public/sweep-chains.js';
import { createActivity } from './activity.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
// WC_DATA_DIR / WC_TEST=1 are for the local test chain (testchain/README.md) — never needed for real use
const DATA_DIR = process.env.WC_DATA_DIR ? path.resolve(process.env.WC_DATA_DIR) : path.join(ROOT, 'data');
const TEST_MODE = process.env.WC_TEST === '1';
const ETHERS_BUNDLE = path.join(ROOT, 'node_modules', 'ethers', 'dist', 'ethers.umd.min.js');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4777;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const CONCURRENCY = 4;
const ADDRS_PER_REQ = 2; // Alchemy limit: max 2 addresses ...
const NETS_PER_REQ = 5; // ... and max 5 networks per address
const MAX_PAGES = 20;

// ---------- storage ----------

const files = {
  config: path.join(DATA_DIR, 'config.json'),
  wallets: path.join(DATA_DIR, 'wallets.json'),
  scan: path.join(DATA_DIR, 'scan.json'),
  activity: path.join(DATA_DIR, 'activity.json'),
};

const defaults = {
  config: () => ({
    apiKey: '',
    networks: NETWORKS.map((n) => n.id),
    dustUsd: 1,
    hiddenTokens: [],
    networkStatus: {},
  }),
  wallets: () => ({ nextId: 1, items: [] }),
  scan: () => ({ scannedAt: null, wallets: {} }),
  activity: () => ({ scannedAt: null, wallets: {}, marks: {} }),
};

async function load(name) {
  try {
    return { ...defaults[name](), ...JSON.parse(await fs.readFile(files[name], 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') return defaults[name]();
    throw e;
  }
}

const writeQueue = new Map();
async function save(name, data) {
  // serialize writes per file; write to tmp + rename so a crash never leaves half a file
  const prev = writeQueue.get(name) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = files[name] + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, files[name]);
  });
  writeQueue.set(name, next.catch(() => {}));
  return next;
}

const state = {
  config: await load('config'),
  wallets: await load('wallets'),
  scan: await load('scan'),
};
state.config.networks = state.config.networks.filter((id) => NETWORK_BY_ID[id]); // drop chains removed from networks.js
if (!state.config.apiKey && process.env.ALCHEMY_API_KEY) state.config.apiKey = process.env.ALCHEMY_API_KEY;

const activity = createActivity({
  getWallets: () => state.wallets.items,
  getApiKey: () => state.config.apiKey,
  load: () => load('activity'),
  save: (data) => save('activity', data),
});

// ---------- alchemy ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alchemyTokensByAddress(addresses, networks, { erc20 = true, prices = true } = {}) {
  const apiKey = state.config.apiKey;
  if (!apiKey) throw httpError(400, 'Не задан Alchemy API key (вкладка «Настройки»)');
  const url = `https://api.g.alchemy.com/data/v1/${encodeURIComponent(apiKey)}/assets/tokens/by-address`;
  const tokens = [];
  const partialErrors = [];
  let pageKey;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      addresses: addresses.map((address) => ({ address, networks })),
      withMetadata: true,
      withPrices: prices,
      includeNativeTokens: true,
      includeErc20Tokens: erc20,
    };
    if (pageKey) body.pageKey = pageKey;
    const json = await postWithRetry(url, body);
    tokens.push(...(json?.data?.tokens ?? []));
    partialErrors.push(...(json?.error?.partialErrors ?? []));
    const nextKey = json?.data?.pageKey;
    if (!nextKey || nextKey === pageKey) break;
    pageKey = nextKey;
  }
  return { tokens, partialErrors };
}

async function postWithRetry(url, body) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      lastErr = new Error(`Сеть недоступна: ${e.message}`); // never include the URL: it carries the key
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = httpError(res.status, res.status === 429 ? 'Лимит запросов Alchemy (429)' : `Alchemy HTTP ${res.status}`);
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text)?.error?.message ?? msg; } catch {}
      if (res.status === 401 || res.status === 403) msg = `Ключ отклонён (${res.status}): ${msg}`;
      throw httpError(res.status, msg);
    }
    return JSON.parse(text);
  }
  throw lastErr;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Obvious airdrop-spam: names/symbols that advertise a site or a "claim"
const SPAM_RE = /(https?:|www\.|\.(com|io|xyz|org|net|app|vip|top|site|online|pro|cc|me|gg|fi|lol)\b|t\.me|claim|visit|reward|airdrop|voucher|bonus|gift|\$\s?\d)/i;

function parseToken(t) {
  const native = t.tokenAddress == null;
  let raw;
  try {
    raw = BigInt(t.tokenBalance ?? 0);
  } catch {
    return null;
  }
  if (raw === 0n) return null;
  const meta = t.tokenMetadata ?? {};
  const decimals = Number.isInteger(meta.decimals) ? meta.decimals : native ? 18 : null;
  const amountStr = decimals == null ? null : formatUnits(raw, decimals);
  const amount = amountStr == null ? null : Number(amountStr);
  const priceStr = (t.tokenPrices ?? []).find((p) => p.currency?.toLowerCase() === 'usd')?.value;
  const price = priceStr != null && priceStr !== '' ? Number(priceStr) : null;
  const value = price != null && amount != null ? amount * price : null;
  const symbol = String(meta.symbol ?? (native ? 'ETH' : '?')).slice(0, 40);
  const name = String(meta.name ?? '').slice(0, 80);
  // unpriced look-alikes: "U5DT", "UЅDС" (Cyrillic letters), "USDT" clones with no market
  const fakeStable = price == null && (/[^\x20-\x7E]/.test(symbol) || /^(U[S5$][D][TC]|USD[T₮C]\d?|WETH|ETH)$/i.test(symbol));
  const spam = !native && (fakeStable || SPAM_RE.test(symbol) || SPAM_RE.test(name) || symbol.length > 15);
  return {
    token: native ? null : t.tokenAddress.toLowerCase(),
    native,
    symbol,
    name,
    decimals,
    amount: amountStr,
    price,
    value,
    spam,
  };
}

// ---------- scan job ----------

const job = { running: false, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, lastError: null };

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function runPool(tasks, limit) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) await tasks[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function startScan(addresses) {
  if (job.running) throw httpError(409, 'Скан уже идёт');
  if (!state.config.apiKey) throw httpError(400, 'Сначала укажи Alchemy API key во вкладке «Настройки»');
  const networks = state.config.networks.filter((id) => NETWORK_BY_ID[id]);
  if (!networks.length) throw httpError(400, 'Не выбрано ни одной сети');
  if (!addresses.length) throw httpError(400, 'Нет кошельков для проверки');

  const addrGroups = chunk(addresses, ADDRS_PER_REQ);
  const netGroups = chunk(networks, NETS_PER_REQ);
  Object.assign(job, {
    running: true, aborted: false, total: addrGroups.length * netGroups.length, done: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  });

  const now = () => new Date().toISOString();
  const store = (addr, net, entry) => {
    const key = addr.toLowerCase();
    const w = (state.scan.wallets[key] ??= { nets: {} });
    w.nets[net] = entry;
    w.scannedAt = now();
  };

  // scan one (addresses × networks) block; if Alchemy rejects the whole block (e.g. one unknown
  // network id → 400), split it into single networks so one bad chain doesn't hide the others
  const scanBlock = async (addrs, nets, attempt = 0) => {
    let retryNets = [];
    try {
      const { tokens, partialErrors } = await alchemyTokensByAddress(addrs, nets);
      // Alchemy sometimes answers 200 but fails one chain ("Internal server error") — retry just those
      if (attempt < 3) {
        retryNets = [...new Set(partialErrors.filter((pe) => !/not supported/i.test(pe.message ?? '')).map((pe) => pe.network))]
          .filter((n) => nets.includes(n));
      }
      const fresh = {};
      for (const a of addrs) for (const n of nets) fresh[`${a.toLowerCase()}|${n}`] = { tokens: [], error: null, at: now() };
      for (const pe of partialErrors) {
        for (const a of addrs) {
          const e = fresh[`${a.toLowerCase()}|${pe.network}`];
          if (e) e.error = pe.message || 'ошибка сети';
        }
      }
      for (const t of tokens) {
        const e = fresh[`${String(t.address).toLowerCase()}|${t.network}`];
        const parsed = e && parseToken(t);
        if (parsed) e.tokens.push(parsed);
      }
      for (const [k, entry] of Object.entries(fresh)) {
        const [a, n] = k.split('|');
        if (!retryNets.includes(n)) store(a, n, entry);
      }
    } catch (e) {
      if (e.status === 400 && nets.length > 1) {
        for (const n of nets) await scanBlock(addrs, [n]);
        return;
      }
      retryNets = [];
      if (e.status === 401 || e.status === 403) job.aborted = true; // bad key: stop instead of failing 700 times
      job.failed++;
      job.lastError = e.message;
      // keep the previous good numbers for this wallet/network, just mark that the refresh failed
      for (const a of addrs) {
        for (const n of nets) {
          const prev = state.scan.wallets[a.toLowerCase()]?.nets?.[n];
          store(a, n, { tokens: prev?.tokens ?? [], error: e.message, at: now() });
        }
      }
    }
    if (retryNets.length) {
      await sleep(1500 * (attempt + 1));
      await scanBlock(addrs, retryNets, attempt + 1);
    }
  };

  const tasks = [];
  for (const addrs of addrGroups) {
    for (const nets of netGroups) {
      tasks.push(async () => {
        if (!job.aborted) await scanBlock(addrs, nets);
        job.done++;
        if (job.done % 25 === 0) await save('scan', state.scan).catch(() => {});
      });
    }
  }

  runPool(tasks, CONCURRENCY)
    .catch((e) => { job.lastError = e.message; })
    .finally(async () => {
      state.scan.scannedAt = now();
      await save('scan', state.scan).catch((e) => console.error('save scan failed', e));
      job.running = false;
      job.finishedAt = now();
      console.log(`Scan finished: ${job.done}/${job.total} blocks, ${job.failed} failed`);
    });
}

// one cheap native-only request per network to see which ones this key can read
async function checkNetworks() {
  const probe = '0x000000000000000000000000000000000000dEaD';
  const status = {};
  await runPool(
    state.config.networks.map((id) => async () => {
      try {
        const { partialErrors } = await alchemyTokensByAddress([probe], [id], { erc20: false, prices: false });
        status[id] = partialErrors.length ? { ok: false, error: partialErrors[0].message } : { ok: true };
      } catch (e) {
        status[id] = { ok: false, error: e.message };
      }
    }),
    CONCURRENCY,
  );
  state.config.networkStatus = { ...state.config.networkStatus, ...status, checkedAt: new Date().toISOString() };
  // chains the Portfolio API itself can't read only produce error cards — switch them off right away
  state.config.networks = state.config.networks.filter((id) => !/not supported/i.test(status[id]?.error ?? ''));
  await save('config', state.config);
  return state.config.networkStatus;
}

// ---------- wallets ----------

function addWallets(list) {
  let added = 0;
  let merged = 0;
  const invalid = [];
  const byAddr = new Map(state.wallets.items.map((w) => [w.address.toLowerCase(), w]));
  for (const raw of list) {
    let address;
    try {
      address = getAddress(String(raw.address ?? '').trim());
    } catch {
      invalid.push(String(raw.address ?? '').slice(0, 60));
      continue;
    }
    const label = String(raw.label ?? '').trim().slice(0, 80);
    const group = String(raw.group ?? '').trim().slice(0, 60) || 'Без группы';
    const source = String(raw.source ?? '').trim().slice(0, 120);
    const existing = byAddr.get(address.toLowerCase());
    if (existing) {
      // same address came from a second place (e.g. typed by hand and derived from a seed): remember both
      const alias = [group, label].filter(Boolean).join(' · ');
      const own = [existing.group, existing.label].filter(Boolean).join(' · ');
      if (alias && alias !== own && !(existing.aliases ??= []).includes(alias)) {
        existing.aliases.push(alias);
        if (source.startsWith('seed') && !existing.source) existing.source = source;
        merged++;
      }
      continue;
    }
    const w = { id: state.wallets.nextId++, address, label, group, source, addedAt: new Date().toISOString() };
    state.wallets.items.push(w);
    byAddr.set(address.toLowerCase(), w);
    added++;
  }
  return { added, merged, invalid };
}

// ---------- http ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    // connect-src: our own API + the sweeper's RPC hosts (sweep-chains.js), nothing else
    `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${rpcOrigins(TEST_MODE).join(' ')}; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw httpError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Некорректный JSON');
  }
}

function publicConfig() {
  const k = state.config.apiKey;
  return {
    hasKey: Boolean(k),
    keyHint: k ? `…${k.slice(-4)}` : '',
    networks: state.config.networks,
    dustUsd: state.config.dustUsd,
    hiddenTokens: state.config.hiddenTokens,
    networkStatus: state.config.networkStatus,
    testMode: TEST_MODE,
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const idMatch = url.pathname.match(/^\/api\/wallets\/(\d+)$/);

  if (route === 'GET /api/state') {
    return send(res, 200, { config: publicConfig(), wallets: state.wallets.items, scan: state.scan, job });
  }
  if (route === 'GET /api/job') return send(res, 200, job);

  if (route === 'GET /api/activity') return send(res, 200, await activity.get());
  if (route === 'GET /api/activity/job') return send(res, 200, activity.job);
  if (route === 'POST /api/activity/scan') {
    activity.start();
    return send(res, 202, activity.job);
  }
  if (route === 'POST /api/activity/own') {
    const b = await readJson(req);
    return send(res, 200, { ownExtra: await activity.setOwnExtra(b.list) });
  }
  if (route === 'POST /api/activity/mark') {
    const b = await readJson(req);
    return send(res, 200, { marks: await activity.mark(b.address, Boolean(b.on)) });
  }

  // the sweeper tab can use the saved Alchemy key as its RPC; only our own page may read it
  if (route === 'GET /api/alchemy-key') {
    if (req.headers['sec-fetch-site'] !== 'same-origin') throw httpError(403, 'Только для страницы панели');
    if (!state.config.apiKey) throw httpError(400, 'Не задан Alchemy API key (вкладка «Настройки»)');
    return send(res, 200, { key: state.config.apiKey });
  }

  if (route === 'POST /api/config') {
    const b = await readJson(req);
    if (typeof b.apiKey === 'string') {
      const k = b.apiKey.trim();
      if (k && !/^[A-Za-z0-9_-]{8,100}$/.test(k)) throw httpError(400, 'Ключ выглядит неправильно');
      state.config.apiKey = k;
      state.config.networkStatus = {};
    }
    if (Array.isArray(b.networks)) state.config.networks = b.networks.filter((id) => NETWORK_BY_ID[id]);
    if (b.dustUsd != null && Number.isFinite(Number(b.dustUsd))) state.config.dustUsd = Math.max(0, Number(b.dustUsd));
    if (Array.isArray(b.hiddenTokens)) state.config.hiddenTokens = b.hiddenTokens.map(String).slice(0, 5000);
    await save('config', state.config);
    return send(res, 200, publicConfig());
  }

  if (route === 'POST /api/networks/check') return send(res, 200, await checkNetworks());

  // wipe the wallet list and scan results (key, networks and hidden coins stay); numbering restarts at #1
  if (route === 'POST /api/reset') {
    if (job.running) throw httpError(409, 'Сначала дождись окончания скана');
    const removed = state.wallets.items.length;
    state.wallets = defaults.wallets();
    state.scan = defaults.scan();
    await save('wallets', state.wallets);
    await save('scan', state.scan);
    return send(res, 200, { removed });
  }

  if (route === 'POST /api/wallets') {
    const b = await readJson(req);
    if (!Array.isArray(b.wallets)) throw httpError(400, 'Нужен список wallets');
    const result = addWallets(b.wallets.slice(0, 10_000));
    await save('wallets', state.wallets);
    return send(res, 200, { ...result, wallets: state.wallets.items });
  }
  if (idMatch && req.method === 'PATCH') {
    const w = state.wallets.items.find((x) => x.id === Number(idMatch[1]));
    if (!w) throw httpError(404, 'Кошелёк не найден');
    const b = await readJson(req);
    if (typeof b.label === 'string') w.label = b.label.trim().slice(0, 80);
    if (typeof b.group === 'string') w.group = b.group.trim().slice(0, 60) || 'Без группы';
    if (Array.isArray(b.aliases)) w.aliases = b.aliases.map((a) => String(a).slice(0, 120)).slice(0, 20);
    if (typeof b.source === 'string') w.source = b.source.trim().slice(0, 120);
    await save('wallets', state.wallets);
    return send(res, 200, w);
  }
  if (route === 'POST /api/wallets/delete') {
    const b = await readJson(req);
    const ids = new Set((b.ids ?? []).map(Number));
    const removed = state.wallets.items.filter((w) => ids.has(w.id));
    state.wallets.items = state.wallets.items.filter((w) => !ids.has(w.id));
    for (const w of removed) delete state.scan.wallets[w.address.toLowerCase()];
    await save('wallets', state.wallets);
    await save('scan', state.scan);
    return send(res, 200, { removed: removed.length, wallets: state.wallets.items });
  }

  if (route === 'POST /api/scan') {
    const b = await readJson(req);
    let items = state.wallets.items;
    if (Array.isArray(b.ids) && b.ids.length) {
      const ids = new Set(b.ids.map(Number));
      items = items.filter((w) => ids.has(w.id));
    }
    startScan(items.map((w) => w.address));
    return send(res, 202, job);
  }

  throw httpError(404, 'Нет такого API');
}

async function serveStatic(res, pathname) {
  let file;
  if (pathname === '/vendor/ethers.js') file = ETHERS_BUNDLE;
  else {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  }
  try {
    const body = await fs.readFile(file);
    return send(res, 200, body, MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    return send(res, 404, 'not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // block DNS-rebinding and cross-site requests: only our own origin may talk to the API
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, 'bad host', 'text/plain');
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) {
      return send(res, 403, { error: 'bad origin' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
    return await serveStatic(res, url.pathname);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    return send(res, status, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Wallet panel: http://127.0.0.1:${PORT}${TEST_MODE ? `  [TEST MODE, data: ${DATA_DIR}]` : ''}`);
});
