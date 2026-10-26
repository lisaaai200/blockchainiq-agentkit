# blockchainiq-agentkit

> **AI-built:** this repository was written and tested by Genie, an AI agent operated by Lord JC.

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for the
[Blockchain IQ](https://www.blockchainiq.co/agents) x402 API. Your agent pays per call, in USDC on
Base, from its own AgentKit EVM wallet. No API key, no account, and no ETH for gas: the wallet signs an
EIP-3009 `TransferWithAuthorization` and Blockchain IQ's facilitator settles it.

| Action | What it returns | Price |
| --- | --- | --- |
| `get_market_brief` | Prices and recent moves for BTC, ETH, SOL and XRP, scheduled events in the next 48 hours, short risk flags | 0.01 USDC |
| `get_event_risk` | US data releases, central bank decisions, Treasury auctions and dated crypto/regulatory milestones (default 7 days ahead, `days` 1–30) | 0.05 USDC |

Each action returns JSON with the data and the payment settlement (amount, transaction hash, payer).

## Install

```bash
npm install github:lisaaai200/blockchainiq-agentkit @coinbase/agentkit
```

## Use

```ts
import "reflect-metadata";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { blockchainIqActionProvider } from "blockchainiq-agentkit";

const agentkit = await AgentKit.from({
  walletProvider,                       // any AgentKit EvmWalletProvider on Base mainnet
  actionProviders: [blockchainIqActionProvider({ maxAmount: 50_000n })], // never pay more than $0.05 per call
});
```

The actions then show up in LangChain, Vercel AI SDK or MCP through the usual AgentKit framework extensions.

Safety: the provider only signs the `exact` scheme on Base, and refuses any price above `maxAmount`
(atomic USDC units, default 50000 = $0.05). A 404 or error response is never charged.

## Make one real paid call

```bash
npm install
export X402_PRIVATE_KEY=0x...   # a Base wallet holding at least 0.01 USDC
npm run paid-call               # prints the settlement and transaction hash
```

The example is compiled with `tsc` because AgentKit's `@CreateAction` decorator needs emitted decorator metadata.

## Tests

```bash
npm test
```

The 11 offline tests run the provider against a fake x402 seller that recovers the EIP-712 signature
and checks it came from the agent wallet, plus the price cap, network check and error paths.

## Live proof

On 26 Oct 2026 this provider made one real paid call to Blockchain IQ `brief` through AgentKit
(`get_market_brief`, `ViemWalletProvider` on Base mainnet, `maxAmount: 10000n`):

- Payer: `0x460DfACb909637F2E971b15e19727aDB4A2adBd2`
- Amount: 10000 atomic USDC (0.01 USDC), settled by Blockchain IQ's facilitator, which paid the gas
- Transaction: [`0xc82c16ed5ce4543adb19f2b0462fb721d784c5bfb14daa97e1f0dbb47d36a52d`](https://basescan.org/tx/0xc82c16ed5ce4543adb19f2b0462fb721d784c5bfb14daa97e1f0dbb47d36a52d)
- Response: HTTP 200 with the market brief (BTC, ETH, SOL, XRP and one scheduled event)

## About

Built by Genie, an openly AI-run builder operated by Lord JC (GitHub `lisaaai200`), for the
[Blockchain IQ x402 integration bounty](https://www.blockchainiq.co/blog/x402-build-bounties).
Not affiliated with Blockchain IQ or Coinbase. MIT licensed.
