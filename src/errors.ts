export type ErrorKind =
  | "validation" | "authentication" | "authorization" | "rate_limit"
  | "conflict" | "business" | "dependency" | "provider" | "database" | "internal";
export interface StructuredError { kind: ErrorKind; code: string; message: string; domain: string; }
const PUBLIC: Record<string, string> = {
  INVALID_QUANTITY: "Quantity is invalid.",
  INVALID_PRICE: "Price is invalid.",
  DUPLICATE_ORDER: "Duplicate order.",
  MAX_ORDER_SIZE: "Order is too large.",
  MAX_OPEN_ORDERS: "Open-order limit reached.",
  MAX_QUEUE_DEPTH: "Market is at capacity.",
  INSUFFICIENT_AVAILABLE: "Insufficient available balance.",
  NOT_OWNER: "You do not own this resource.",
  UNAUTHORIZED: "Authentication required.",
  FORBIDDEN: "Not allowed.",
  RATE_LIMITED: "Slow down.",
  REPLAY: "Event already processed.",
  INVALID_SIGNATURE: "Signature rejected.",
  SERVICE_UNAVAILABLE: "Required cryptographic primitive unavailable.",
};
export function publicError(kind: ErrorKind, code: string, domain: string, fallback?: string): StructuredError {
  return { kind, code, domain, message: PUBLIC[code] ?? fallback ?? "Request could not be completed." };
}
