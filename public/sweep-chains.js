// RPC settings for the sweeper ("Сборщик"). Shared by server.js (to build the CSP connect-src list)
// and the browser (which signs and broadcasts itself — the local server never sees keys or txs).
// Public RPCs checked 2026-10-16: eth_chainId matched for every URL below.
//
// legacy: send type-0 txs with eth_gasPrice (exact fee → native balance can be drained to 0)
// l1:     OP-stack / Scroll chains charge an extra L1 data fee, read from the chain's gas oracle
// gasMult: gas limit headroom where eth_estimateGas moves with L1 prices (Arbitrum) or pubdata (ZK stack)
// minTip: floor for the priority fee where RPCs suggest 0 but blocks still need a tip
// skipTokens: ERC-20 views of the native coin (sending both would double-spend the same balance)
export const SWEEP_CHAINS = {
  'eth-mainnet': { chainId: 1, native: 'ETH', minTip: 50_000_000n, rpcs: ['https://ethereum-rpc.publicnode.com'] },
  'arb-mainnet': { chainId: 42161, native: 'ETH', gasMult: 1.3, rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  'opt-mainnet': { chainId: 10, native: 'ETH', l1: 'op', rpcs: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'] },
  'base-mainnet': { chainId: 8453, native: 'ETH', l1: 'op', rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  'zksync-mainnet': { chainId: 324, native: 'ETH', gasMult: 1.3, rpcs: ['https://mainnet.era.zksync.io'] },
  'linea-mainnet': { chainId: 59144, native: 'ETH', rpcs: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'] },
  'scroll-mainnet': { chainId: 534352, native: 'ETH', l1: 'scroll', rpcs: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'] },
  'matic-mainnet': { chainId: 137, native: 'POL', rpcs: ['https://polygon-bor-rpc.publicnode.com'], skipTokens: ['0x0000000000000000000000000000000000001010'] },
  'bnb-mainnet': { chainId: 56, native: 'BNB', legacy: true, rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'] },
  'avax-mainnet': { chainId: 43114, native: 'AVAX', rpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'] },
  'blast-mainnet': { chainId: 81457, native: 'ETH', l1: 'op', rpcs: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com'] },
  'zora-mainnet': { chainId: 7777777, native: 'ETH', l1: 'op', rpcs: ['https://rpc.zora.energy'] },
  'abstract-mainnet': { chainId: 2741, native: 'ETH', gasMult: 1.3, rpcs: ['https://api.mainnet.abs.xyz'] },
  'unichain-mainnet': { chainId: 130, native: 'ETH', l1: 'op', rpcs: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'] },
  'worldchain-mainnet': { chainId: 480, native: 'ETH', l1: 'op', rpcs: ['https://worldchain-mainnet.g.alchemy.com/public'] },
  'soneium-mainnet': { chainId: 1868, native: 'ETH', l1: 'op', rpcs: ['https://rpc.soneium.org'] },
  'ink-mainnet': { chainId: 57073, native: 'ETH', l1: 'op', rpcs: ['https://rpc-gel.inkonchain.com', 'https://rpc-qnd.inkonchain.com'] },
  'berachain-mainnet': { chainId: 80094, native: 'BERA', rpcs: ['https://rpc.berachain.com'] },
  'apechain-mainnet': { chainId: 33139, native: 'APE', gasMult: 1.3, rpcs: ['https://rpc.apechain.com'] },
  'shape-mainnet': { chainId: 360, native: 'ETH', l1: 'op', rpcs: ['https://mainnet.shape.network'] },
  'lens-mainnet': { chainId: 232, native: 'GHO', gasMult: 1.3, rpcs: ['https://rpc.lens.xyz'] },
  'celo-mainnet': { chainId: 42220, native: 'CELO', l1: 'op', rpcs: ['https://forno.celo.org'], skipTokens: ['0x471ece3750da237f93b8e339c536989b8978a438'] },
  'gnosis-mainnet': { chainId: 100, native: 'xDAI', rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'] },
  'monad-mainnet': { chainId: 143, native: 'MON', rpcs: ['https://rpc.monad.xyz'] },
  'hyperliquid-mainnet': { chainId: 999, native: 'HYPE', rpcs: ['https://rpc.hyperliquid.xyz/evm'] },
  'ronin-mainnet': { chainId: 2020, native: 'RON', rpcs: ['https://api.roninchain.com/rpc'] },
  'story-mainnet': { chainId: 1514, native: 'IP', rpcs: ['https://mainnet.storyrpc.io'] },
};

// Local Hardhat chains for testing (see testchain/README). Only used when the server runs with WC_TEST=1.
export const TEST_CHAINS = {
  'local-1559': { chainId: 31337, name: 'Local EIP-1559', native: 'ETH', test: true, rpcs: ['http://127.0.0.1:8545'] },
  'local-legacy': { chainId: 31338, name: 'Local legacy', native: 'BNB', legacy: true, test: true, rpcs: ['http://127.0.0.1:8546'] },
  'local-op': { chainId: 31339, name: 'Local OP (L1 fee)', native: 'ETH', l1: 'op', test: true, rpcs: ['http://127.0.0.1:8547'] },
};

export const ALCHEMY_RPC_HOST = 'https://*.g.alchemy.com';
export const alchemyRpcUrl = (networkId, key) => `https://${networkId}.g.alchemy.com/v2/${encodeURIComponent(key)}`;

// Origins the page may connect to (CSP connect-src). Test chains add plain-http localhost.
export function rpcOrigins(testMode) {
  const set = new Set([ALCHEMY_RPC_HOST]);
  for (const c of Object.values(SWEEP_CHAINS)) for (const u of c.rpcs) set.add(new URL(u).origin);
  if (testMode) set.add('http://127.0.0.1:*');
  return [...set];
}
