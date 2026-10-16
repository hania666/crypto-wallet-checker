# Sweeper and test rig — technical details

**[Русская версия →](SWEEPER.ru.md)**

How the **Sweeper** tab works (gas math, the gas bus, transaction order) and how to run it on local test networks.

## The Sweeper tab

Collects leftovers from your wallets to one address. Transactions are signed and sent **by the page itself in your
browser**, after you confirm. The local server takes no part in it: it never receives keys or transactions.

1. **Where to collect.** Enter the recipient address, the threshold (default $1) and the gas price margin (default 50%).
   Choose the RPC: public ones (publicnode, official network RPCs) or Alchemy with the key from Settings.
2. **Plan (dry run, sends nothing).** Candidates come from the last scan: only priced coins, no spam and nothing
   hidden. For every wallet × network pair, balances are read from a live RPC and gas is estimated:
   - ERC-20: `reserve = ceil(estimateGas × 1.2) × maxFee` (+ L1 data fee × 1.5 on the OP stack and Scroll);
     sent if `value − reserve ≥ threshold`.
   - Native coin (last): `balance − token reserves − 21000 × maxFee (− L1 fee × 1.5)`;
     sent if what's left ≥ threshold.
   - EIP-1559: `maxFee = base × (1 + margin) + tip`. Legacy (BNB): `gasPrice`, the wallet is emptied to exactly 0.
   - Arbitrum and ZK networks (zkSync, Abstract, Lens), and a contract recipient: gas limit = estimate × 1.3,
     because the estimate includes the L1/pubdata part.
   - Above the plan there's a summary per network: how many wallets (and how many $) are “native only, pays its own gas”,
     “tokens + gas”, “tokens, no gas”, “nothing to send”.
   - Without the gas bus, a “tokens, no gas” wallet is marked “needs gas” with the amount to top up.
   - “Arrives at the address” = token value + native coin sent (token gas is already deducted from the native coin).
   - A reconciliation line under the totals: “panel $X · plan $Y before gas · not included: …” — dust below the threshold,
     unticked networks, skipped items with a reason (gas costs more, no gas and delivering it isn't worth it, …),
     balance changes since the scan. The plan plus “not included” equals the panel total.
3. **🚌 Gas bus** (checkbox, on by default). A wallet with tokens but no gas gets gas from a wallet in the same network:
   - By default the bus is the wallet with the most spare native coin (after its own transfers).
     It can be changed in the network header, including to the recipient itself — then its key is needed too.
   - It delivers exactly `gas for its tokens + gas to return the leftover − what's already there`, plus a 10% margin.
     The amount is recalculated at the current gas price when sending.
   - Gas is delivered only when it pays off: `token value − (delivery gas + token gas + return gas) ≥ threshold`.
     Otherwise the wallet is marked “not worth it”.
   - Order in each network:
     1. All gas deliveries first (each waits for confirmation).
     2. Then the wallets that got gas: their tokens, then the gas leftover is returned — only if it exceeds the fee.
     3. Then all other wallets.
     4. The bus last.
   - If a gas delivery fails, tokens from that wallet are not sent.
4. **Keys.** Paste seeds or private keys (same format as on the Add tab). Only wallets that sign something in the plan
   (including the bus) stay in page memory; everything else is dropped immediately. Keys are forgotten after sending,
   after 20 minutes, on the “Forget keys” button and when the tab closes. Nothing is written to localStorage,
   the server or disk.
5. **Sending.** A confirmation dialog warns that the wallets will be linked. You have to type the last 6 characters
   of the address and tick a checkbox. In each network transactions go strictly one at a time, waiting for confirmation;
   networks run in parallel. Each transaction shows its status and an explorer link. There's a
   “stop everything on the first error” option. The log can be downloaded with “Export CSV”.

**Important.** Collecting from many wallets into one address links them on-chain forever, and airdrop anti-sybil
filters will see them as one person. Check the recipient address character by character in your wallet app.

Network settings (RPC, chainId, legacy, L1 fee): `public/sweep-chains.js`. The CSP header lets the page talk only to
these RPC hosts and `*.g.alchemy.com`.

## Testing on local networks (no real money)

Only public test mnemonics (`abandon … about`, `test … junk`). Never paste real seeds here.

```bash
cd testchain
npm install          # once: hardhat + solc
npm run chains       # 3 local networks: 8545 EIP-1559, 8546 legacy, 8547 OP with a mock L1-fee oracle (keep running)
npm run setup        # in another window: tokens + balances + fixture in testchain/data/
node verify.mjs snapshot
npm run panel        # panel in test mode: http://127.0.0.1:4778 (uses testchain/data, doesn't touch data/)
```

Then on the Sweeper tab:
1. Recipient `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, then “Build plan”.
2. `node expect.mjs` — the plan calculated by hand; the numbers must match the table.
3. Paste the lines from `testchain/TEST-SECRETS.txt` → “Load keys” → “Send selected” → confirm.
4. `node verify.mjs` — what actually moved on the networks.

Afterwards check that no secrets were stored anywhere:

```bash
grep -rlE "abandon|junk|1d8e676c" data testchain/data
```

Expected result (2026-10-16, fixture with the gas bus):
- The plan matched `expect.mjs`: $664.95 arrives; gas deliveries and leftovers match to the last digit.
  Reconciliation: $669.39 in the plan + $6.94 “not included” = $676.33 in the panel, nothing unaccounted.
- “Acc 2” and “Acc 5” (tokens without gas) got gas from the bus. “Acc 6” was marked “not worth it”
  (delivery $0.24 vs $1.20) and left untouched.
- All 33 transactions confirmed. Order within blocks: deliveries → wallets that got gas → the rest → the bus.
- On the legacy network every sending wallet, including the bus, ended at exactly 0. On EIP-1559 some dust
  from the gas margin remains (~$0.002), on OP also the L1 reserve (the mock oracle doesn't charge it).
- A run with an error (before the bus): “stop on error” stopped the remaining steps.
- grep found nothing. The page made no POST requests to the server.
