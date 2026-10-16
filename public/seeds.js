// Seed phrases / private keys → addresses, entirely in the browser.
// Nothing in this module talks to the network; callers send only the resulting addresses.
const { ethers } = window;

export const PATHS = {
  metamask: (i) => `m/44'/60'/0'/0/${i}`,
  ledgerlive: (i) => `m/44'/60'/${i}'/0/0`,
  legacy: (i) => `m/44'/60'/0'/${i}`,
};

// One secret per line, optionally "Label: secret" and optionally numbered ("1. ...").
// Returns parsed items plus the numbers of lines that could not be read (never their content).
export function parseSecretLines(text) {
  const items = [];
  const badLines = [];
  const dupLines = []; // { lineNo, ofLine } — same secret pasted twice
  const seen = new Map();
  const push = (item) => {
    const key = `${item.kind}:${item.secret.toLowerCase()}`;
    if (seen.has(key)) {
      dupLines.push({ lineNo: item.lineNo, ofLine: seen.get(key) });
      return;
    }
    seen.set(key, item.lineNo);
    items.push(item);
  };
  text.split(/\r?\n/).forEach((rawLine, idx) => {
    let line = rawLine.trim();
    if (!line) return;
    line = line.replace(/^\d+\s*[.)]\s+/, '');
    let label = '';
    const colon = line.indexOf(':');
    if (colon > 0) {
      label = line.slice(0, colon).trim().slice(0, 60);
      line = line.slice(colon + 1).trim();
    }
    const compact = line.replace(/\s+/g, '');
    const lineNo = idx + 1;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(compact)) {
      push({ lineNo, rawLine, kind: 'key', label, secret: compact.startsWith('0x') ? compact : '0x' + compact });
      return;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(compact)) {
      push({ lineNo, rawLine, kind: 'address', label, secret: compact.toLowerCase() });
      return;
    }
    const phrase = line.toLowerCase().replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
    const words = phrase.split(' ').length;
    if (![12, 15, 18, 21, 24].includes(words) || !ethers.Mnemonic.isValidMnemonic(phrase)) {
      badLines.push({ lineNo, rawLine });
      return;
    }
    push({ lineNo, rawLine, kind: 'seed', label, secret: phrase });
  });
  return { items, badLines, dupLines };
}

// BIP-39 seed via WebCrypto PBKDF2 (native, ~100x faster than pure JS for many phrases)
async function bip39Seed(phrase, passphrase) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(phrase.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', salt: enc.encode(('mnemonic' + (passphrase || '')).normalize('NFKD')), iterations: 2048 },
    key,
    512,
  );
  return new Uint8Array(bits);
}

// Same derivation as deriveAddresses, but returns signing wallets. Used only by the sweeper, which
// keeps them in page memory for the session and never sends them anywhere.
export async function deriveWallets(item, { count, start, pathKind, passphrase }) {
  if (item.kind === 'key') {
    const w = new ethers.Wallet(item.secret);
    return [{ address: w.address, path: 'приватный ключ', wallet: w }];
  }
  if (item.kind !== 'seed') return [];
  const seed = globalThis.crypto?.subtle
    ? await bip39Seed(item.secret, passphrase)
    : ethers.getBytes(ethers.Mnemonic.fromPhrase(item.secret, passphrase).computeSeed());
  const root = ethers.HDNodeWallet.fromSeed(seed);
  seed.fill(0);
  const pathFn = PATHS[pathKind] ?? PATHS.metamask;
  const out = [];
  for (let i = start; i < start + count; i++) {
    const p = pathFn(i);
    const node = root.derivePath(p);
    out.push({ address: node.address, path: p, wallet: new ethers.Wallet(node.privateKey) });
  }
  return out;
}

export async function deriveAddresses(item, { count, start, pathKind, passphrase }) {
  if (item.kind === 'key') {
    return [{ address: ethers.computeAddress(item.secret), path: 'приватный ключ', index: null }];
  }
  if (item.kind === 'address') {
    return [{ address: ethers.getAddress(item.secret), path: 'адрес', index: null }];
  }
  const seed = globalThis.crypto?.subtle
    ? await bip39Seed(item.secret, passphrase)
    : ethers.getBytes(ethers.Mnemonic.fromPhrase(item.secret, passphrase).computeSeed());
  const root = ethers.HDNodeWallet.fromSeed(seed);
  const pathFn = PATHS[pathKind] ?? PATHS.metamask;
  const out = [];
  for (let i = start; i < start + count; i++) {
    const p = pathFn(i);
    out.push({ address: root.derivePath(p).address, path: p, index: i });
  }
  return out;
}
