import { z } from "zod";
import { ActionProvider, CreateAction, EvmWalletProvider, Network } from "@coinbase/agentkit";
import { payingGet, X402Error } from "./x402";

export const BASE_URL = "https://www.blockchainiq.co/api/x402/v1";

export const BriefSchema = z.object({}).strip().describe("No input. Costs 0.01 USDC on Base via x402.");

export const EventRiskSchema = z
  .object({
    days: z.number().int().min(1).max(30).optional().describe("How many days ahead to look (default 7)"),
  })
  .strip()
  .describe("Costs 0.05 USDC on Base via x402.");

export interface BlockchainIqConfig {
  /** Highest price the provider will pay for one call, in atomic USDC units (default 50000 = $0.05). */
  maxAmount?: bigint;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * AgentKit action provider for the Blockchain IQ x402 API.
 * Each call is paid per request in USDC on Base by the agent's own EVM wallet.
 */
export class BlockchainIqActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly maxAmount: bigint;
  private readonly baseUrl: string;
  private readonly fetchFn?: typeof fetch;

  constructor(config: BlockchainIqConfig = {}) {
    super("blockchainiq", []);
    this.maxAmount = config.maxAmount ?? 50_000n;
    this.baseUrl = config.baseUrl ?? BASE_URL;
    this.fetchFn = config.fetchFn;
  }

  @CreateAction({
    name: "get_market_brief",
    description: `Get the Blockchain IQ market brief: prices and recent moves for BTC, ETH, SOL and XRP,
scheduled macro and crypto events in the next 48 hours, and short risk flags.
Pays 0.01 USDC on Base from the agent wallet via x402. Returns JSON with the data and the payment settlement (transaction hash).`,
    schema: BriefSchema,
  })
  async getMarketBrief(wallet: EvmWalletProvider, _args: z.infer<typeof BriefSchema>): Promise<string> {
    return this.call(wallet, "brief");
  }

  @CreateAction({
    name: "get_event_risk",
    description: `Get upcoming event risk from Blockchain IQ: US data releases, central bank decisions,
Treasury auctions and dated crypto and regulatory milestones, each with its official source.
Pays 0.05 USDC on Base from the agent wallet via x402.`,
    schema: EventRiskSchema,
  })
  async getEventRisk(wallet: EvmWalletProvider, args: z.infer<typeof EventRiskSchema>): Promise<string> {
    return this.call(wallet, "event-risk", args.days ? { days: String(args.days) } : undefined);
  }

  supportsNetwork = (network: Network): boolean =>
    network.protocolFamily === "evm" && (network.chainId === "8453" || network.networkId === "base-mainnet");

  private async call(wallet: EvmWalletProvider, resource: string, params?: Record<string, string>): Promise<string> {
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    try {
      const res = await payingGet(`${this.baseUrl}/${resource}${qs}`, wallet, {
        maxAmount: this.maxAmount,
        fetchFn: this.fetchFn,
      });
      return JSON.stringify({
        success: res.status < 400,
        status: res.status,
        data: res.data,
        payment: res.settlement
          ? { amount: res.paidAmount, transaction: res.settlement.transaction, network: res.settlement.network, payer: res.settlement.payer }
          : null,
      });
    } catch (e) {
      const msg = e instanceof X402Error ? e.message : `request failed: ${(e as Error).message}`;
      return JSON.stringify({ success: false, error: msg });
    }
  }
}

export const blockchainIqActionProvider = (config?: BlockchainIqConfig) => new BlockchainIqActionProvider(config);
