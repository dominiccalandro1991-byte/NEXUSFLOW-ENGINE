import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.ts";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface JwkKey extends JsonWebKey {
  kid?: string;
}

interface JwtClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  role?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

let jwksCache: { fetchedAt: number; keys: JwkKey[] } | null = null;

function decodeJson<T>(segment: string): T {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json) as T;
}

function audienceMatches(audience: string | string[] | undefined, expected: string): boolean {
  if (typeof audience === "string") return audience === expected;
  return Array.isArray(audience) && audience.includes(expected);
}

function assertClaims(claims: JwtClaims, config: AppConfig): string {
  if (!claims.sub || !/^[A-Za-z0-9_.:-]{1,128}$/.test(claims.sub)) {
    throw new AuthError("TOKEN_SUBJECT");
  }
  if (claims.iss !== config.jwtIssuer) throw new AuthError("TOKEN_ISSUER");
  if (!audienceMatches(claims.aud, config.jwtAudience)) throw new AuthError("TOKEN_AUDIENCE");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 5000) {
    throw new AuthError("TOKEN_EXPIRED");
  }
  if (claims.role && claims.role !== "authenticated") throw new AuthError("TOKEN_ROLE");
  return claims.sub;
}

function verifyHmac(token: string, secret: string, headerPart: string, payloadPart: string, signaturePart: string): void {
  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthError("TOKEN_SIGNATURE");
  }
}

async function verifyJwks(
  config: AppConfig,
  header: JwtHeader,
  signingInput: string,
  signaturePart: string,
): Promise<void> {
  if (!config.supabaseUrl) throw new AuthError("JWKS_UNAVAILABLE");
  const now = Date.now();
  if (!jwksCache || now - jwksCache.fetchedAt > 10 * 60 * 1000) {
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`);
    if (!response.ok) throw new AuthError("JWKS_UNAVAILABLE");
    const body = (await response.json()) as { keys?: JwkKey[] };
    jwksCache = { fetchedAt: now, keys: body.keys ?? [] };
  }
  const jwk = jwksCache.keys.find((key) => key.kid === header.kid) ?? jwksCache.keys[0];
  if (!jwk) throw new AuthError("TOKEN_SIGNATURE");
  const algorithm =
    header.alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : header.alg === "ES256"
        ? { name: "ECDSA", namedCurve: "P-256" }
        : null;
  if (!algorithm) throw new AuthError("TOKEN_ALG");
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : algorithm,
    key,
    Buffer.from(signaturePart, "base64url"),
    Buffer.from(signingInput),
  );
  if (!ok) throw new AuthError("TOKEN_SIGNATURE");
}

export async function authenticate(authorization: string | undefined, config: AppConfig): Promise<string> {
  if (!authorization || !authorization.startsWith("Bearer ")) throw new AuthError("TOKEN_MISSING");
  const token = authorization.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new AuthError("TOKEN_MALFORMED");
  const [headerPart, payloadPart, signaturePart] = parts;
  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = decodeJson(headerPart);
    claims = decodeJson(payloadPart);
  } catch {
    throw new AuthError("TOKEN_MALFORMED");
  }
  if (header.alg === "HS256") {
    if (!config.supabaseJwtSecret) throw new AuthError("TOKEN_ALG");
    verifyHmac(token, config.supabaseJwtSecret, headerPart, payloadPart, signaturePart);
  } else if (header.alg === "RS256" || header.alg === "ES256") {
    await verifyJwks(config, header, `${headerPart}.${payloadPart}`, signaturePart);
  } else {
    throw new AuthError("TOKEN_ALG");
  }
  return assertClaims(claims, config);
}
