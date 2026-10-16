// Test scenario for the sweeper. PUBLIC TEST VALUES ONLY — never put real seeds here.
// BIP-39 test vector mnemonic (all-zero entropy), known to everyone:
export const TEST_WALLET_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// account index of the same mnemonic that the test pastes as a raw private key instead
export const TEST_KEY_INDEX = 10;
// Hardhat test account #1 ("test test … junk", m/44'/60'/0'/0/1)
export const DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

export const CHAINS = {
  'local-1559': { chainId: 31337, rpc: 'http://127.0.0.1:8545', native: 'ETH' },
  'local-legacy': { chainId: 31338, rpc: 'http://127.0.0.1:8546', native: 'BNB', legacy: true },
  'local-op': { chainId: 31339, rpc: 'http://127.0.0.1:8547', native: 'ETH', l1Fee: 10_000_000_000_000n }, // 0.00001 ETH
};

export const PRICES = { ETH: 2000, BNB: 600 };

export const SCENARIO = {
  tokens: [
    { name: 'Test USD', symbol: 'TUSD', decimals: 6, price: 1 },
    { name: 'Test Wrapped Ether', symbol: 'TWETH', decimals: 18, price: 2000 },
    { name: 'Claim reward at scam.xyz', symbol: 'SPAM', decimals: 18, price: 5, spam: true },
    { name: 'No Price Token', symbol: 'NOPRICE', decimals: 18, price: null },
  ],
  // Акк 1..6 of the test mnemonic
  seedAccounts: [
    // 1: everything goes: native + two priced tokens
    { native: { all: '0.01' }, tokens: { TUSD: '50', TWETH: '0.005' } },
    // 2: tokens but zero native → the gas bus brings exactly the gas it needs
    { tokens: { TUSD: '30' } },
    // 3: dust: token and native are each below the $1 threshold → skipped
    { native: { all: '0.0004' }, tokens: { TUSD: '0.2' } },
    // 4: native + token sent; spam and unpriced token ignored
    { native: { all: '0.002' }, tokens: { TUSD: '5', SPAM: '1000', NOPRICE: '1' } },
    // 5: valuable token, native too small for its gas → the gas bus tops it up
    { native: { all: '0.00002' }, tokens: { TUSD: '100' } },
    // 6: $1.20 token, no gas: worth sending on its own, but not after paying for the bus ride → "не выгодно"
    { tokens: { TUSD: '1.2' } },
  ],
  // pasted as a private key: native only, on the legacy chain only
  keyAccount: { native: { 'local-legacy': '0.05' } },
};
