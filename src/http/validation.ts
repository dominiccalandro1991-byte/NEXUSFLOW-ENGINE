import { NEXUS_LIMITS } from "../limits.ts";
import type { Side } from "../types.ts";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const ORDER_KEYS = new Set([
  "instrumentId",
  "side",
  "type",
  "priceTicks",
  "quantity",
  "clientOrderId",
]);

export interface PlaceBody {
  instrumentId: string;
  side: Side;
  type: "limit" | "market";
  priceTicks: number | null;
  quantity: number;
  clientOrderId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePlaceBody(value: unknown): PlaceBody {
  if (!isRecord(value)) throw new ValidationError("Body must be a JSON object.");
  for (const key of Object.keys(value)) {
    if (!ORDER_KEYS.has(key)) throw new ValidationError(`Unexpected field ${key}.`);
  }
  const { instrumentId, side, type, priceTicks, quantity, clientOrderId } = value;
  if (typeof instrumentId !== "string" || !/^[A-Z0-9-]{1,32}$/.test(instrumentId)) {
    throw new ValidationError("instrumentId is invalid.");
  }
  if (side !== "buy" && side !== "sell") throw new ValidationError("side must be buy or sell.");
  if (type !== "limit" && type !== "market") throw new ValidationError("type must be limit or market.");
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < NEXUS_LIMITS.MIN_QUANTITY) {
    throw new ValidationError("quantity must be a positive integer.");
  }
  if (quantity > NEXUS_LIMITS.MAX_ORDER_SIZE) throw new ValidationError("quantity exceeds MAX_ORDER_SIZE.");
  if (type === "limit") {
    if (!Number.isInteger(priceTicks) || (priceTicks as number) < NEXUS_LIMITS.MIN_PRICE_TICKS) {
      throw new ValidationError("priceTicks must be a positive integer for limit orders.");
    }
  } else if (priceTicks !== null) {
    throw new ValidationError("market orders require priceTicks null.");
  }
  if (clientOrderId !== undefined) {
    if (typeof clientOrderId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(clientOrderId)) {
      throw new ValidationError("clientOrderId is invalid.");
    }
  }
  const body: PlaceBody = {
    instrumentId,
    side,
    type,
    priceTicks: type === "market" ? null : (priceTicks as number),
    quantity,
  };
  if (typeof clientOrderId === "string") body.clientOrderId = clientOrderId;
  return body;
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new ValidationError("Idempotency-Key is required.");
  }
  return value;
}

export function parseOrderId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new ValidationError("orderId is invalid.");
  return value;
}

export async function readJsonBody(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (declared && Number(declared) > maxBytes) {
    throw new ValidationError("BODY_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes) throw new ValidationError("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (size === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Body must be valid JSON.");
  }
}
