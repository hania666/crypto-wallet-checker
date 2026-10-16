// Local test chain "legacy" (chainId 31338, hardfork berlin). Funded with the public Hardhat test mnemonic.
module.exports = {
  networks: {
    hardhat: {
      chainId: 31338,
      hardfork: 'berlin',
      accounts: { mnemonic: 'test test test test test test test test test test test junk', count: 3 },
      mining: { auto: true },
    },
  },
  solidity: '0.8.28',
};
