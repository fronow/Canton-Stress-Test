// A minimal, deliberately FAST stand-in for the JSON Ledger API.
//
// Its purpose is to measure the LOAD GENERATOR, not a ledger. A real sandbox
// commits at single-digit-to-tens of transactions per second, so any run
// against it measures Canton, and a second load-generating process would show
// no improvement at all — the ledger was the bottleneck the whole time.
//
// To show that distributed generation (S6) actually lifts the single-process
// ceiling, the target has to be faster than the generator. This server answers
// every request immediately from memory, so whatever throughput a run achieves
// is the generator's own limit.
//
// Not a Canton simulator: no contracts, no contention, no validation.

import { createServer, type Server } from "node:http";

export interface MockLedger {
  url: string;
  /** Requests served, by path. */
  counts: Map<string, number>;
  close(): Promise<void>;
}

const json = (body: unknown): string => JSON.stringify(body);

export function startMockLedger(port = 0): Promise<MockLedger> {
  const counts = new Map<string, number>();
  let offset = 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    counts.set(path, (counts.get(path) ?? 0) + 1);

    // Drain the body without parsing it: parsing every command payload would
    // make the MOCK the bottleneck, which is exactly what we are avoiding.
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      switch (path) {
        case "/v2/parties": {
          const n = counts.get(path)!;
          res.end(json({ partyDetails: { party: `mock-p${n}::mock` } }));
          return;
        }
        case "/v2/state/ledger-end":
          res.end(json({ offset: offset }));
          return;
        case "/v2/state/connected-synchronizers":
          res.end(json({ connectedSynchronizers: [{ synchronizerId: "mock::sync" }] }));
          return;
        case "/v2/state/active-contracts":
          res.end(json([]));
          return;
        case "/v2/commands/submit-and-wait":
          res.end(json({ updateId: `u${++offset}`, completionOffset: offset }));
          return;
        case "/v2/commands/submit-and-wait-for-transaction-tree": {
          const id = ++offset;
          res.end(
            json({
              transactionTree: {
                updateId: `u${id}`,
                eventsById: {
                  "0": {
                    CreatedTreeEvent: { value: { contractId: `c${id}`, templateId: "mock:M:T" } },
                  },
                },
              },
            }),
          );
          return;
        }
        case "/v2/interactive-submission/prepare":
          res.end(
            json({
              preparedTransactionHash: "mock",
              hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
              costEstimation: {
                confirmationRequestTrafficCostEstimation: 300,
                confirmationResponseTrafficCostEstimation: 200,
                totalTrafficCostEstimation: 500,
              },
            }),
          );
          return;
        default:
          res.statusCode = 404;
          res.end(json({ errors: [`no mock route for ${path}`] }));
      }
    });
  });

  // Keep-alive matters: without it every operation pays a TCP handshake and
  // the measurement becomes one of connection setup, not of the generator.
  server.keepAliveTimeout = 60_000;

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        counts,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// Run standalone: `node test/fixtures/mock-ledger.ts [port]`
if (process.argv[1]?.endsWith("mock-ledger.ts") && process.env.CANTON_STRESS_WORKER !== "1") {
  const port = Number(process.argv[2] ?? 7600);
  const m = await startMockLedger(port);
  console.log(`mock ledger listening at ${m.url}`);
}
