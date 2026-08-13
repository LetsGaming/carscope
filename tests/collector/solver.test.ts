import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE } from "@carscope/core";
import { HostThrottle, HttpClient, looksBinary, type Transport } from "../../packages/collector/src/http.ts";
import { ClearanceStore } from "../../packages/collector/src/clearance.ts";
import { Solver, solverTransport } from "../../packages/collector/src/solver.ts";

interface Call { cmd: string; url?: string; maxTimeout?: number }
interface Cookie { name: string; value: string; domain: string }

/** A fake Byparr: records the commands it receives and replies per `reply`. */
function fakeSolver(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_endpoint: string, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as Call;
    calls.push(call);
    const body = reply(call);
    if (body === null) return new Response("upstream down", { status: 502 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  return { calls, solver: new Solver({ endpoint: "http://solver.invalid/v1", timeoutMs: 1_000 }, impl) };
}

/** A solved-page reply, with the clearance (cookies + agent) Byparr returns. */
const page = (
  html: string,
  opts: { status?: number; cookies?: Cookie[]; userAgent?: string } = {},
) => (): unknown => ({
  status: "ok",
  solution: {
    status: opts.status ?? 200,
    response: html,
    cookies: opts.cookies ?? [],
    userAgent: opts.userAgent ?? "camoufox-UA",
  },
});

const listings = `<html><body>${"<article>Skyline</article>".repeat(2_000)}</body></html>`;

interface PlainCall { url: string; cookie: string | null; userAgent: string | null }

/**
 * An HTTP client wired to the fake solver, recording the plain fetches the
 * clearance replay makes. A store is shared between the solver transport (which
 * banks a clearance) and the client (which replays it) when one is passed.
 */
function harness(opts: {
  solver: Solver;
  store?: ClearanceStore;
  plain?: (call: PlainCall) => Response;
}): { http: HttpClient; plainCalls: PlainCall[] } {
  const plainCalls: PlainCall[] = [];
  const plain: Transport = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const call: PlainCall = {
      url,
      cookie: headers.get("cookie"),
      userAgent: headers.get("user-agent"),
    };
    plainCalls.push(call);
    return (opts.plain ?? (() => new Response("plain", { status: 200 })))(call);
  };

  const http = new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "default-UA",
    transport: plain,
    solverTransport: solverTransport(opts.solver, opts.store ? { clearance: opts.store } : {}),
    ...(opts.store ? { clearance: opts.store } : {}),
  });
  return { http, plainCalls };
}

test("a request marked for the solver comes back with the page behind the challenge", async () => {
  const { solver } = fakeSolver(page("<html>echte Seite</html>"));
  const { http } = harness({ solver });

  const plain = await http.getText("https://portal.invalid/a");
  assert.equal(plain.ok && plain.value, "plain");

  const viaSolver = await http.getText("https://portal.invalid/a", { solver: true });
  assert.ok(viaSolver.ok);
  assert.equal(viaSolver.value, "<html>echte Seite</html>");
});

test("a solved host is fetched plainly next time, with the cookies that cleared it", async () => {
  const store = new ClearanceStore(60_000);
  const { solver, calls } = fakeSolver(page(listings, {
    cookies: [{ name: "cf_clearance", value: "abc", domain: ".portal.invalid" }],
    userAgent: "camoufox-UA",
  }));
  const { http, plainCalls } = harness({ solver, store });

  const first = await http.getText("https://portal.invalid/1", { solver: true, browser: true });
  assert.ok(first.ok);
  assert.equal(calls.filter((c) => c.cmd === "request.get").length, 1);
  assert.equal(plainCalls.length, 0, "the first page is the solver's");

  const second = await http.getText("https://portal.invalid/2", { solver: true, browser: true });
  assert.ok(second.ok);
  assert.equal(calls.filter((c) => c.cmd === "request.get").length, 1, "the solver is not asked again");
  assert.equal(plainCalls.length, 1, "the second page is a plain fetch");
  assert.equal(plainCalls[0]?.cookie, "cf_clearance=abc");
  assert.equal(plainCalls[0]?.userAgent, "camoufox-UA", "the agent the cookie is bound to, not our default");
});

test("a clearance the portal no longer honours is dropped and the host re-solved", async () => {
  const store = new ClearanceStore(60_000);
  const { solver, calls } = fakeSolver(page(listings, {
    cookies: [{ name: "cf_clearance", value: "abc", domain: ".portal.invalid" }],
  }));
  // The stale cookie draws the challenge again, which the portal answers 403.
  const { http, plainCalls } = harness({ solver, store, plain: () => new Response("nope", { status: 403 }) });

  await http.getText("https://portal.invalid/1", { solver: true, browser: true });
  const again = await http.getText("https://portal.invalid/2", { solver: true, browser: true });

  assert.ok(again.ok, "the request falls through to a fresh solve");
  assert.equal(plainCalls.length, 1, "the stale pass was tried once");
  assert.equal(calls.filter((c) => c.cmd === "request.get").length, 2, "and the solver solved again");
});

test("a corrupted solver page reads as unavailable, not as content", async () => {
  const garbled = `<html><head></head><body>${"\u0000\u0001\u0002\u0003\ufffd".repeat(400)}</body>`;
  assert.ok(looksBinary(garbled), "the fixture is undecodable, as the fault produces");

  const { solver } = fakeSolver(page(garbled));
  const { http } = harness({ solver, store: new ClearanceStore(60_000) });

  const res = await http.getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false, "the parser is never handed the bytes");
  assert.equal(res.ok ? null : res.error.kind, FAILURE.http);
  assert.match(res.ok ? "" : res.error.message, /corrupted/);
});

test("a clean page does not read as binary", () => {
  assert.equal(looksBinary(listings), false);
  assert.equal(looksBinary(""), false);
});

test("a solver that refuses says so instead of returning an empty page", async () => {
  const { solver } = fakeSolver(() => ({ status: "error", message: "Challenge not solved after 60s" }));

  const { http } = harness({ solver });
  const res = await http.getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error.message, /Challenge not solved/);
});

test("a solver that is down reads as the source being unavailable", async () => {
  const { solver } = fakeSolver(() => null);
  const { http } = harness({ solver });
  const res = await http.getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.http);
  assert.match(res.ok ? "" : res.error.message, /Solver/);
});

test("a source not routed through the solver is untouched by it", async () => {
  const { solver, calls } = fakeSolver(page("<html>ok</html>"));
  const { http } = harness({ solver });
  const res = await http.getText("https://portal.invalid/a");
  assert.ok(res.ok);
  assert.equal(res.value, "plain");
  assert.equal(calls.length, 0, "the solver is only used where it is asked for");
});

test("the solver is asked with a real page request, not a bare scheme", async () => {
  const { solver, calls } = fakeSolver(page("<html>ok</html>"));
  await harness({ solver }).http.getText("https://portal.invalid/seite-1", { solver: true });

  assert.equal(calls.length, 1, "one call, no session dance");
  assert.equal(calls[0]?.cmd, "request.get");
  assert.equal(calls[0]?.url, "https://portal.invalid/seite-1");
});

/**
 * Byparr returns the status of the first navigation. Cloudflare answers 403 and
 * then clears itself, so a solved page arrives carrying a 403.
 */
test("a page solved behind a 403 is the page, not a refusal", async () => {
  const { solver } = fakeSolver(page(listings, { status: 403 }));

  const res = await harness({ solver }).http.getText("https://portal.invalid/a", { solver: true });
  assert.ok(res.ok, "the results page is not thrown away because of the interstitial's status");
  assert.equal(res.value, listings);
});

test("a genuine refusal behind a 403 still reads as blocked", async () => {
  const denial = "<html><body>Access denied. You do not have permission.</body></html>";
  const { solver } = fakeSolver(page(denial, { status: 403 }));

  const res = await harness({ solver }).http.getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false, "a short denial page keeps its status");
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
});

test("a long page that is still the bot check reads as blocked", async () => {
  const challenge = `<html><head><title>Just a moment</title></head><body>datadome${"x".repeat(30_000)}</body></html>`;
  const { solver } = fakeSolver(page(challenge, { status: 403 }));

  const res = await harness({ solver }).http.getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
});

test("without a solver configured the request still goes out", async () => {
  const http = new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "test",
    transport: async () => new Response("plain", { status: 200 }),
  });
  const res = await http.getText("https://portal.invalid/a", { solver: true });
  assert.ok(res.ok, "asking for a solver that is not there falls back rather than failing");
  assert.equal(res.value, "plain");
});

/**
 * AutoUncle serves our own browser and refuses the solver's headless one. The
 * solver used to supersede the browser outright, so a source we could fetch was
 * reported unavailable while a working transport sat unused.
 */
test("a portal that refuses the solver is retried with our own browser", async () => {
  const refusing = (): Transport => () =>
    Promise.resolve(new Response("<html>Attention Required</html>", { status: 403 }));

  let browserCalls = 0;
  const browser: Transport = () => {
    browserCalls += 1;
    return Promise.resolve(new Response(`<html>${"<article/>".repeat(3_000)}</html>`, { status: 200 }));
  };

  const http = new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "test",
    solverTransport: refusing(),
    browserTransport: browser,
  });

  const res = await http.getText("https://portal.invalid/a", { solver: true, browser: true });
  assert.ok(res.ok, "the page comes back through the browser");
  assert.equal(browserCalls, 1, "the browser was tried exactly once");
});

test("both transports refused says so, rather than blaming one", async () => {
  const refuse: Transport = () => Promise.resolve(new Response("no", { status: 403 }));
  const http = new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "test",
    solverTransport: refuse,
    browserTransport: refuse,
  });

  const res = await http.getText("https://portal.invalid/a", { solver: true, browser: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
  assert.match(res.ok ? "" : res.error.message, /both the solver and the browser/);
});

test("a source with no browser of its own is not retried", async () => {
  let solverCalls = 0;
  const solver: Transport = () => {
    solverCalls += 1;
    return Promise.resolve(new Response("no", { status: 403 }));
  };
  const http = new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000, userAgent: "test", solverTransport: solver,
  });

  const res = await http.getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.equal(solverCalls, 1, "no second attempt when there is nothing to fall back to");
});
