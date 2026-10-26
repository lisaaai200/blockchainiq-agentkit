import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { createWalletClient, http, verifyTypedData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import { ViemWalletProvider } from "@coinbase/agentkit";
import { blockchainIqActionProvider, BASE_URL } from "../src/blockchainIqActionProvider";
import { b64jsonDecode, b64jsonEncode, buildTypedData, chooseRequirement, X402Error } from "../src/x402";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";

function requirement(amount = "10000") {
  return { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } } as const;
}

function makeWallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = createWalletClient({ account, chain: base, transport: http("http://127.0.0.1:1") });
  return { account, wallet: new ViemWalletProvider(client) };
}

/** A fake x402 seller: answers 402, then verifies the EIP-712 signature and returns data + settlement. */
function fakeSeller(opts: { amount?: string; failPaid?: boolean } = {}) {
  const calls: { url: string; payment?: any; valid?: boolean }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const sigHdr = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
    if (!sigHdr) {
      calls.push({ url });
      const required = { x402Version: 2, resource: { url }, accepts: [requirement(opts.amount)] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64jsonEncode(required) } });
    }
    const payment = b64jsonDecode<any>(sigHdr);
    const a = payment.payload.authorization;
    const { typedData } = buildTypedData(a.from, payment.accepted, Number(a.validAfter) + 600, a.nonce);
    const valid = await verifyTypedData({ address: a.from, ...typedData, signature: payment.payload.signature } as any);
    calls.push({ url, payment, valid });
    if (opts.failPaid || !valid) {
      return new Response("bad", { status: 402, headers: { "PAYMENT-REQUIRED": b64jsonEncode({ accepts: [], error: "insufficient_funds" }) } });
    }
    const settle = { success: true, transaction: "0xabc123", network: "eip155:8453", payer: a.from };
    return new Response(JSON.stringify({ data: { coins: [{ symbol: "BTC" }] } }), { status: 200, headers: { "PAYMENT-RESPONSE": b64jsonEncode(settle) } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("x402 helpers", () => {
  it("chooses the exact/Base requirement", () => {
    expect(chooseRequirement({ accepts: [requirement()] }, 50_000n).amount).toBe("10000");
  });
  it("refuses a price above maxAmount", () => {
    expect(() => chooseRequirement({ accepts: [requirement("60000")] }, 50_000n)).toThrow(X402Error);
  });
  it("refuses unsupported networks", () => {
    expect(() => chooseRequirement({ accepts: [{ ...requirement(), network: "eip155:1" }] }, 50_000n)).toThrow(/no supported/);
  });
  it("builds a validity window around now", () => {
    const { authorization } = buildTypedData(PAY_TO, requirement(), 1_000_000, `0x${"00".repeat(32)}`);
    expect(authorization.validAfter).toBe("999400");
    expect(authorization.validBefore).toBe("1000300");
  });
});

describe("BlockchainIqActionProvider", () => {
  it("exposes two actions", () => {
    const { wallet } = makeWallet();
    const names = blockchainIqActionProvider().getActions(wallet).map(a => a.name);
    expect(names).toEqual(expect.arrayContaining(["BlockchainIqActionProvider_get_market_brief", "BlockchainIqActionProvider_get_event_risk"]));
  });

  it("supports Base mainnet only", () => {
    const p = blockchainIqActionProvider();
    expect(p.supportsNetwork({ protocolFamily: "evm", chainId: "8453", networkId: "base-mainnet" })).toBe(true);
    expect(p.supportsNetwork({ protocolFamily: "evm", chainId: "1", networkId: "ethereum-mainnet" })).toBe(false);
    expect(p.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" })).toBe(false);
  });

  it("pays for brief with a valid EIP-3009 signature from the agent wallet", async () => {
    const { account, wallet } = makeWallet();
    const seller = fakeSeller();
    const out = JSON.parse(await blockchainIqActionProvider({ fetchFn: seller.fetchFn }).getMarketBrief(wallet, {}));
    expect(out.success).toBe(true);
    expect(out.payment.transaction).toBe("0xabc123");
    expect(out.payment.amount).toBe("10000");
    expect(seller.calls[0].url).toBe(`${BASE_URL}/brief`);
    expect(seller.calls[1].valid).toBe(true);
    expect(seller.calls[1].payment.payload.authorization.from).toBe(account.address);
    expect(seller.calls[1].payment.payload.authorization.to).toBe(PAY_TO);
  });

  it("passes days to event-risk", async () => {
    const { wallet } = makeWallet();
    const seller = fakeSeller({ amount: "50000" });
    const out = JSON.parse(await blockchainIqActionProvider({ fetchFn: seller.fetchFn }).getEventRisk(wallet, { days: 3 }));
    expect(out.success).toBe(true);
    expect(seller.calls[0].url).toBe(`${BASE_URL}/event-risk?days=3`);
  });

  it("will not sign above maxAmount", async () => {
    const { wallet } = makeWallet();
    const seller = fakeSeller({ amount: "50000" });
    const out = JSON.parse(await blockchainIqActionProvider({ fetchFn: seller.fetchFn, maxAmount: 10_000n }).getEventRisk(wallet, {}));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/exceeds maxAmount/);
    expect(seller.calls.length).toBe(1);
  });

  it("reports the seller's error when settlement fails", async () => {
    const { wallet } = makeWallet();
    const seller = fakeSeller({ failPaid: true });
    const out = JSON.parse(await blockchainIqActionProvider({ fetchFn: seller.fetchFn }).getMarketBrief(wallet, {}));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/insufficient_funds/);
  });

  it("returns free responses without paying", async () => {
    const { wallet } = makeWallet();
    const fetchFn = (async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as unknown as typeof fetch;
    const out = JSON.parse(await blockchainIqActionProvider({ fetchFn }).getMarketBrief(wallet, {}));
    expect(out).toMatchObject({ success: true, payment: null, data: { ok: 1 } });
  });
});
