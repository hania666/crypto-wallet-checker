// Local test chain "1559" (chainId 31337, hardfork cancun). Funded with the public Hardhat test mnemonic.
module.exports = {
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: 'cancun',
      initialBaseFeePerGas: 1_000_000_000,
      accounts: { mnemonic: 'test test test test test test test test test test test junk', count: 3 },
      mining: { auto: true },
    },
  },
  solidity: '0.8.28',
};
