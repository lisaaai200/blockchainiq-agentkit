/**
 * Minimal x402 v2 "exact" scheme client for EVM (EIP-3009 USDC on Base).
 * The payer only signs a TransferWithAuthorization; the seller's facilitator
 * settles it on chain and pays the gas.
 */
export const SUPPORTED_NETWORKS: Record<string, number> = { "eip155:8453": 8453, "eip155:84532": 84532 };

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

export interface PaymentRequired {
  x402Version?: number;
  resource?: unknown;
  accepts: PaymentRequirement[];
  error?: string;
}

export interface Signer {
  getAddress(): string;
  signTypedData(typedData: unknown): Promise<`0x${string}`>;
}

export class X402Error extends Error {}

export const b64jsonEncode = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
export const b64jsonDecode = <T = unknown>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;

export function chooseRequirement(required: PaymentRequired, maxAmount: bigint): PaymentRequirement {
  for (const req of required.accepts ?? []) {
    if (req.scheme !== "exact" || !(req.network in SUPPORTED_NETWORKS)) continue;
    if (BigInt(req.amount) > maxAmount) {
      throw new X402Error(`price ${req.amount} exceeds maxAmount ${maxAmount} (atomic USDC units)`);
    }
    return req;
  }
  throw new X402Error("no supported payment option (need scheme 'exact' on Base)");
}

export function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function buildTypedData(from: string, req: PaymentRequirement, now: number, nonce: `0x${string}`) {
  const authorization = {
    from,
    to: req.payTo,
    value: req.amount,
    validAfter: String(now - 600),
    validBefore: String(now + (req.maxTimeoutSeconds ?? 300)),
    nonce,
  };
  const typedData = {
    domain: {
      name: req.extra?.name ?? "USD Coin",
      version: req.extra?.version ?? "2",
      chainId: SUPPORTED_NETWORKS[req.network],
      verifyingContract: req.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from,
      to: req.payTo,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce,
    },
  };
  return { authorization, typedData };
}

export interface PaidResult {
  status: number;
  data: unknown;
  settlement: Record<string, unknown> | null;
  paidAmount: string | null;
}

export async function payingGet(
  url: string,
  signer: Signer,
  opts: { maxAmount?: bigint; fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<PaidResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxAmount = opts.maxAmount ?? 50_000n; // $0.05
  const first = await fetchFn(url);
  if (first.status !== 402) {
    return { status: first.status, data: await readBody(first), settlement: null, paidAmount: null };
  }
  const header = first.headers.get("PAYMENT-REQUIRED");
  const required = header ? b64jsonDecode<PaymentRequired>(header) : ((await readBody(first)) as PaymentRequired);
  const req = chooseRequirement(required, maxAmount);
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const { authorization, typedData } = buildTypedData(signer.getAddress(), req, now, randomNonce());
  const signature = await signer.signTypedData(typedData);
  const payment = {
    x402Version: 2,
    resource: required.resource,
    accepted: req,
    payload: { signature, authorization },
  };
  const paid = await fetchFn(url, { headers: { "PAYMENT-SIGNATURE": b64jsonEncode(payment) } });
  const settleHdr = paid.headers.get("PAYMENT-RESPONSE");
  const settlement = settleHdr ? b64jsonDecode<Record<string, unknown>>(settleHdr) : null;
  if (paid.status >= 400) {
    let reason = String(await readBody(paid)).slice(0, 300);
    const again = paid.headers.get("PAYMENT-REQUIRED");
    if (again) {
      try {
        reason = b64jsonDecode<PaymentRequired>(again).error ?? reason;
      } catch {
        /* keep body text */
      }
    }
    throw new X402Error(`paid request failed: HTTP ${paid.status} ${reason}`);
  }
  return { status: paid.status, data: await readBody(paid), settlement, paidAmount: req.amount };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
