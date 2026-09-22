export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export type OrderLifecycle =
  | "RECEIVED"
  | "VALIDATED"
  | "AUTHORIZED"
  | "QUEUED"
  | "MATCHING"
  | "SETTLEMENT_PENDING"
  | "SETTLED"
  | "REJECTED"
  | "CANCELLED"
  | "PARTIALLY_FILLED"
  | "FILLED";

export type EngineOrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface Instrument {
  id: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  lotSize: number;
  minNotional: number;
}

export interface SubmitOrderInput {
  id: string;
  accountId: string;
  instrumentId: string;
  side: Side;
  type: OrderType;
  priceTicks: number | null;
  quantity: number;
  clientOrderId?: string;
}

export interface RestingOrder {
  id: string;
  accountId: string;
  instrumentId: string;
  side: Side;
  type: OrderType;
  priceTicks: number;
  quantity: number;
  remaining: number;
  seq: number;
  status: EngineOrderStatus;
  ts: number;
}

export interface Fill {
  tradeId: string;
  instrumentId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerAccountId: string;
  takerAccountId: string;
  priceTicks: number;
  quantity: number;
  seq: number;
  ts: number;
}

export interface BookLevel {
  priceTicks: number;
  quantity: number;
  orderCount: number;
}

export interface BookSnapshot {
  instrumentId: string;
  seq: number;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
}

export interface EngineEvent {
  type:
    | "order_accepted"
    | "order_rejected"
    | "order_cancelled"
    | "trade"
    | "book";
  seq: number;
  ts: number;
  payload: unknown;
}

export class EngineError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
  }
}
