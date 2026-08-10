import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { hs256Provider, mintHs256, noAuth, oauthClientCredentials, staticToken } from "../src/auth.ts";

const decode = (jwt: string) => {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    signature: s,
  };
};

test("mintHs256 produces the scope-based shape Canton 3.x accepts", () => {
  // Verified live against Canton 3.4.11: the scope-based form is accepted and
  // the older custom-claims form ("https://daml.com/ledger-api") is rejected.
  const { header, payload } = decode(mintHs256("s3cret", { userId: "participant_admin" }));
  assert.equal(header.alg, "HS256");
  assert.equal(payload.sub, "participant_admin");
  assert.equal(payload.scope, "daml_ledger_api");
  // No party claims: Canton 3.x authorises from participant user management.
  assert.equal(payload["https://daml.com/ledger-api"], undefined);
  assert.equal(payload.actAs, undefined);
});

test("tokens are SHORT-LIVED — Canton refuses long ones outright", () => {
  // Measured: a one-hour token is rejected with "token lifetime too long".
  const { payload } = decode(mintHs256("s", {}));
  const lifetime = payload.exp - payload.iat;
  assert.ok(lifetime <= 300, `default lifetime ${lifetime}s is too long for Canton`);
  assert.ok(lifetime > 0);
});

test("the HS256 signature verifies against the shared secret", () => {
  const jwt = mintHs256("correct-horse", { userId: "u" });
  const [h, p, sig] = jwt.split(".");
  const expected = createHmac("sha256", "correct-horse").update(`${h}.${p}`).digest("base64url");
  assert.equal(sig, expected);
  // A different secret must not verify.
  const wrong = createHmac("sha256", "other").update(`${h}.${p}`).digest("base64url");
  assert.notEqual(sig, wrong);
});

test("the HS256 provider re-mints before expiry", async () => {
  const p = hs256Provider("s", { userId: "u", expiresInSeconds: 2 });
  const first = await p.get();
  assert.equal(await p.get(), first, "must reuse a fresh token rather than mint per request");
  // Past half the lifetime it re-mints, so a long run never carries a dead token.
  await new Promise((r) => setTimeout(r, 1100));
  const second = await p.get();
  assert.notEqual(second, first);
  assert.equal(decode(second!).payload.sub, "u");
});

test("static and absent providers behave", async () => {
  assert.equal(await staticToken("  abc  ").get(), "abc");
  assert.equal(await noAuth.get(), undefined);
});

test("OAuth client-credentials caches until near expiry, then refetches", async () => {
  let calls = 0;
  let bodySeen = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    calls++;
    bodySeen = init.body ?? "";
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: `tok${calls}`, expires_in: 120 }),
    };
  }) as unknown as typeof fetch;
  try {
    const p = oauthClientCredentials({
      tokenUrl: "https://idp.example/token",
      clientId: "id",
      clientSecret: "secret",
      scope: "daml_ledger_api",
      skewSeconds: 30,
    });
    assert.equal(await p.get(), "tok1");
    assert.equal(await p.get(), "tok1", "second call must be served from cache");
    assert.equal(calls, 1);
    assert.match(bodySeen, /grant_type=client_credentials/);
    assert.match(bodySeen, /scope=daml_ledger_api/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OAuth surfaces a failing token endpoint instead of running unauthenticated", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => "invalid_client",
  })) as unknown as typeof fetch;
  try {
    const p = oauthClientCredentials({ tokenUrl: "https://idp/token", clientId: "i", clientSecret: "s" });
    await assert.rejects(() => p.get(), /HTTP 401.*invalid_client/s);
  } finally {
    globalThis.fetch = realFetch;
  }
});
