// Alchemy network ids. Shared by server.js and the browser panel.
// "core" = main Ethereum L1/L2s, scanned by default together with the rest.
export const NETWORKS = [
  { id: 'eth-mainnet', name: 'Ethereum', explorer: 'https://etherscan.io', core: true },
  { id: 'arb-mainnet', name: 'Arbitrum', explorer: 'https://arbiscan.io', core: true },
  { id: 'opt-mainnet', name: 'Optimism', explorer: 'https://optimistic.etherscan.io', core: true },
  { id: 'base-mainnet', name: 'Base', explorer: 'https://basescan.org', core: true },
  { id: 'zksync-mainnet', name: 'zkSync Era', explorer: 'https://era.zksync.network', core: true },
  { id: 'linea-mainnet', name: 'Linea', explorer: 'https://lineascan.build', core: true },
  { id: 'scroll-mainnet', name: 'Scroll', explorer: 'https://scrollscan.com', core: true },
  { id: 'matic-mainnet', name: 'Polygon', explorer: 'https://polygonscan.com', core: true },
  { id: 'bnb-mainnet', name: 'BNB Chain', explorer: 'https://bscscan.com', core: true },
  { id: 'avax-mainnet', name: 'Avalanche', explorer: 'https://snowtrace.io', core: true },
  { id: 'blast-mainnet', name: 'Blast', explorer: 'https://blastscan.io', core: true },
  { id: 'zora-mainnet', name: 'Zora', explorer: 'https://explorer.zora.energy', core: true },
  // Not served by the Portfolio API (checked 2026-10-16): Arbitrum Nova, Polygon zkEVM, Mantle,
  // Sonic, opBNB, Fraxtal, Metis, Mode, Plasma — would need a separate RPC check.
  { id: 'abstract-mainnet', name: 'Abstract', explorer: 'https://abscan.org' },
  { id: 'unichain-mainnet', name: 'Unichain', explorer: 'https://uniscan.xyz' },
  { id: 'worldchain-mainnet', name: 'World Chain', explorer: 'https://worldscan.org' },
  { id: 'soneium-mainnet', name: 'Soneium', explorer: 'https://soneium.blockscout.com' },
  { id: 'ink-mainnet', name: 'Ink', explorer: 'https://explorer.inkonchain.com' },
  { id: 'berachain-mainnet', name: 'Berachain', explorer: 'https://berascan.com' },
  { id: 'apechain-mainnet', name: 'ApeChain', explorer: 'https://apescan.io' },
  { id: 'shape-mainnet', name: 'Shape', explorer: 'https://shapescan.xyz' },
  { id: 'lens-mainnet', name: 'Lens', explorer: 'https://explorer.lens.xyz' },
  { id: 'celo-mainnet', name: 'Celo', explorer: 'https://celoscan.io' },
  { id: 'gnosis-mainnet', name: 'Gnosis', explorer: 'https://gnosisscan.io' },
  { id: 'monad-mainnet', name: 'Monad', explorer: 'https://monadscan.com' },
  { id: 'hyperliquid-mainnet', name: 'HyperEVM', explorer: 'https://hyperevmscan.io' },
  { id: 'ronin-mainnet', name: 'Ronin', explorer: 'https://app.roninchain.com' },
  { id: 'story-mainnet', name: 'Story', explorer: 'https://www.storyscan.io' },
];

export const NETWORK_BY_ID = Object.fromEntries(NETWORKS.map((n) => [n.id, n]));

export function networkName(id) {
  return NETWORK_BY_ID[id]?.name ?? id;
}

export function explorerAddressUrl(networkId, address) {
  const base = NETWORK_BY_ID[networkId]?.explorer;
  return base ? `${base}/address/${address}` : null;
}
