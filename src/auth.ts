// Ledger API authentication.
//
// Every real Canton participant requires a bearer token; only a development
// sandbox accepts unauthenticated calls. Without this the tool can be pointed
// at a laptop and nothing else, which is the single thing that keeps it out of
// a real deployment.
//
// Three ways to get a token, covering how deployments actually issue them:
//
//   static    a token you already have (flag, file, or environment)
//   oauth     client-credentials against an IdP, refreshed before expiry
//   hs256     minted locally from a shared secret — TEST ONLY, for a
//             participant configured with `unsafe-jwt-hmac-256`
//
// The provider is async and re-consulted per request, so a long soak run does
// not die when its token expires mid-flight.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export interface TokenProvider {
  /** Current bearer token, or undefined for an unauthenticated ledger. */
  get(): Promise<string | undefined>;
}

export const noAuth: TokenProvider = { get: async () => undefined };

export function staticToken(token: string): TokenProvider {
  const t = token.trim();
  return { get: async () => t };
}

export function tokenFromFile(path: string): TokenProvider {
  // Read once at construction: a file that changes mid-run is a rotation
  // story, and rotation belongs to the OAuth path.
  return staticToken(readFileSync(path, "utf8"));
}

// ---- OAuth 2.0 client credentials ------------------------------------------

export interface OAuthConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
  /** Refresh this many seconds before the token actually expires. */
  skewSeconds?: number;
}

/** Fetch a token with client_credentials and cache it until shortly before it
 * expires. Refreshing early matters: a token that dies mid-run turns a
 * capacity measurement into a pile of auth errors. */
export function oauthClientCredentials(cfg: OAuthConfig): TokenProvider {
  let cached: { token: string; expiresAtMs: number } | undefined;
  const skewMs = (cfg.skewSeconds ?? 60) * 1000;

  return {
    async get(): Promise<string> {
      if (cached && Date.now() < cached.expiresAtMs - skewMs) return cached.token;
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      });
      if (cfg.scope) body.set("scope", cfg.scope);
      if (cfg.audience) body.set("audience", cfg.audience);

      const res = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`token endpoint ${cfg.tokenUrl} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new Error("token endpoint returned no access_token");
      cached = {
        token: j.access_token,
        expiresAtMs: Date.now() + (j.expires_in ?? 3600) * 1000,
      };
      return cached.token;
    },
  };
}

// ---- HS256, for testing against an unsafe-jwt-hmac-256 participant ---------

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Hs256Options {
  /** Ledger API user the token authenticates as. Rights live on the
   * participant against this user, not in the token. */
  userId?: string;
  /** Token lifetime. Canton REJECTS long-lived tokens outright — a one-hour
   * token is refused with "token lifetime too long" — so this is short by
   * default and the provider re-mints as it nears expiry. */
  expiresInSeconds?: number;
}

/** Mint a scope-based HS256 token, the format Canton 3.x accepts:
 *
 *     { "sub": "<userId>", "scope": "daml_ledger_api", "exp": …, "iat": … }
 *
 * Note what is NOT in it: no party claims. Canton 3.x takes authorisation from
 * participant user management, so the token says *who you are* and the
 * participant decides *what you may do*. (The older custom-claims format,
 * `https://daml.com/ledger-api`, is rejected — verified against 3.4.11.)
 *
 * **Test facility only**, for a participant configured with
 * `unsafe-jwt-hmac-256`. Real deployments issue tokens from an IdP: use
 * `--auth-token` or the OAuth options. */
export function mintHs256(secret: string, o: Hs256Options = {}): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: o.userId ?? "participant_admin",
    scope: "daml_ledger_api",
    exp: now + (o.expiresInSeconds ?? 60),
    iat: now,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

/** Short-lived HS256 tokens, re-minted before they expire.
 *
 * The refresh is not optional polish: Canton caps token lifetime, so any run
 * longer than that cap — every soak test — would otherwise fail partway
 * through with authentication errors rather than a measurement. */
export function hs256Provider(secret: string, o: Hs256Options = {}): TokenProvider {
  const ttl = o.expiresInSeconds ?? 60;
  let token = "";
  let mintedAtMs = 0;
  return {
    async get(): Promise<string> {
      // Re-mint at half the lifetime; cheap, and leaves ample margin.
      if (!token || Date.now() - mintedAtMs > (ttl * 1000) / 2) {
        token = mintHs256(secret, { ...o, expiresInSeconds: ttl });
        mintedAtMs = Date.now();
      }
      return token;
    },
  };
}
