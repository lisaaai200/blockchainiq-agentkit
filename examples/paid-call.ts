/**
 * Make one real paid call to Blockchain IQ `brief` (0.01 USDC on Base) through AgentKit
 * and print the settlement proof.
 *
 *   export X402_PRIVATE_KEY=0x...   # a Base wallet holding at least 0.01 USDC (no ETH needed)
 *   npm run paid-call   (compiled with tsc: AgentKit needs emitted decorator metadata)
 */
import "reflect-metadata";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { blockchainIqActionProvider } from "../src";

// AgentKit fires an un-awaited analytics request when a wallet provider is created;
// if that endpoint rejects it, Node would crash on the unhandled rejection. Ignore only that.
process.on("unhandledRejection", (e) => {
  if (String((e as Error)?.stack ?? e).includes("sendAnalyticsEvent")) return;
  console.error(e);
  process.exit(1);
});

async function main() {
  const key = process.env.X402_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("set X402_PRIVATE_KEY");
  const client = createWalletClient({ account: privateKeyToAccount(key), chain: base, transport: http() });
  const walletProvider = new ViemWalletProvider(client);
  const agentkit = await AgentKit.from({ walletProvider, actionProviders: [blockchainIqActionProvider()] });
  const brief = agentkit.getActions().find(a => a.name.endsWith("get_market_brief"))!;
  const out = JSON.parse(await brief.invoke({}));
  console.log(JSON.stringify(out.payment, null, 2));
  console.log("transaction:", out.payment?.transaction ?? out.error);
}

main().catch(e => { console.error(e); process.exit(1); });
