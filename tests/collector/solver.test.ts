import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE } from "@carscope/core";
import { HostThrottle, HttpClient, type Transport } from "../../packages/collector/src/http.ts";
import { Solver, solverTransport } from "../../packages/collector/src/solver.ts";

interface Call { cmd: string; url?: string; session?: string }

function fakeSolver(reply: (call: Call) => unknown, calls: Call[] = []) {
  const impl = (async (_endpoint: string, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as Call;
    calls.push(call);
    const body = reply(call);
    if (body === null) return new Response("upstream down", { status: 502 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    calls,
    solver: new Solver({ endpoint: "http://solver.invalid/v1", timeoutMs: 1_000, useSession: true }, impl),
  };
}

const solved = (html: string) => (call: Call) =>
  call.cmd === "sessions.create"
    ? { status: "ok", session: "carscope-1" }
    : { status: "ok", solution: { status: 200, response: html } };

const client = (solver: Solver): HttpClient =>
  new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "test",
    transport: async () => new Response("plain", { status: 200 }),
    solverTransport: solverTransport(solver),
  });

test("a request marked for the solver comes back with the page behind the challenge", async () => {
  const { solver } = fakeSolver(solved("<html>echte Seite</html>"));
  const http = client(solver);

  const plain = await http.getText("https://portal.invalid/a");
  assert.equal(plain.ok && plain.value, "plain");

  const viaSolver = await http.getText("https://portal.invalid/a", { solver: true });
  assert.ok(viaSolver.ok);
  assert.equal(viaSolver.value, "<html>echte Seite</html>");
});

test("the challenge is solved once and the session reused", async () => {
  const { solver, calls } = fakeSolver(solved("<html>ok</html>"));
  const http = client(solver);

  await http.getText("https://portal.invalid/1", { solver: true });
  await http.getText("https://portal.invalid/2", { solver: true });

  assert.equal(calls.filter((c) => c.cmd === "sessions.create").length, 1, "one session, not one per page");
  assert.equal(calls.filter((c) => c.cmd === "request.get").length, 2);
  assert.ok(calls.filter((c) => c.cmd === "request.get").every((c) => c.session === "carscope-1"));

  await solver.close();
  assert.equal(calls.at(-1)?.cmd, "sessions.destroy", "and it is handed back");
});

test("a solver that refuses says so instead of returning an empty page", async () => {
  const { solver } = fakeSolver((call) =>
    call.cmd === "sessions.create"
      ? { status: "ok", session: "s" }
      : { status: "error", message: "Challenge not solved after 60s" });

  const res = await client(solver).getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error.message, /Challenge not solved/);
});

test("a solver that is down reads as the source being unavailable", async () => {
  const { solver } = fakeSolver(() => null);
  const res = await client(solver).getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.http);
  assert.match(res.ok ? "" : res.error.message, /Solver/);
});

test("a source not routed through the solver is untouched by it", async () => {
  const { solver, calls } = fakeSolver(solved("<html>ok</html>"));
  const res = await client(solver).getText("https://portal.invalid/a");
  assert.ok(res.ok);
  assert.equal(res.value, "plain");
  assert.equal(calls.length, 0, "the solver is only used where it is asked for");
});

/**
 * Byparr documents `cmd` as accepted for FlareSolverr compatibility and ignored,
 * so it answers every call as a page fetch and never returns a session. Its
 * `url` defaults to the bare string "https://", which Playwright cannot
 * navigate to, so a probe sent without one failed on every run.
 */
const sessionless = (call: Call) => {
  void call;
  return { status: "ok", solution: { status: 200, response: "<html>ok</html>" } };
};

test("the session probe asks for the page we wanted anyway, not a bare scheme", async () => {
  const { solver, calls } = fakeSolver(sessionless);
  await client(solver).getText("https://portal.invalid/seite-1", { solver: true });

  const probe = calls[0];
  assert.equal(probe?.cmd, "sessions.create");
  assert.equal(probe?.url, "https://portal.invalid/seite-1", "a solver that ignores cmd can act on it");
});

test("a solver without sessions is used sessionless, not with an invented id", async () => {
  // Falling back to the id we proposed made every later request carry a session
  // the solver had no record of.
  const { solver, calls } = fakeSolver(sessionless);
  const http = client(solver);

  await http.getText("https://portal.invalid/1", { solver: true });
  await http.getText("https://portal.invalid/2", { solver: true });

  const pages = calls.filter((c) => c.cmd === "request.get");
  assert.ok(pages.every((c) => c.session === undefined), "no session is attached");

  await solver.close();
  assert.ok(
    calls.every((c) => c.cmd !== "sessions.destroy"),
    "and none is handed back, because none was created",
  );
});

test("the probe's own page is used rather than asking the portal twice", async () => {
  // A solver that ignores `cmd` answers the probe with the page. Requesting it
  // again put two hits on the portal seconds apart, for one search.
  const { solver, calls } = fakeSolver(sessionless);
  const res = await client(solver).getText("https://portal.invalid/seite-1", { solver: true });

  assert.ok(res.ok);
  assert.equal(res.value, "<html>ok</html>", "the probe's page is what comes back");
  assert.equal(calls.length, 1, "one call, not a probe and then a repeat");
  assert.equal(calls.filter((c) => c.url === "https://portal.invalid/seite-1").length, 1);
});

/**
 * Byparr returns the status of the first navigation. Cloudflare answers 403 and
 * then clears itself, so a solved page arrives carrying a 403.
 */
const solvedAfter403 = (body: string) => () => ({
  status: "ok",
  solution: { status: 403, response: body },
});

test("a page solved behind a 403 is the page, not a refusal", async () => {
  const listings = `<html><body>${"<article>Skyline</article>".repeat(2_000)}</body></html>`;
  const { solver } = fakeSolver(solvedAfter403(listings));

  const res = await client(solver).getText("https://portal.invalid/a", { solver: true });
  assert.ok(res.ok, "the results page is not thrown away because of the interstitial's status");
  assert.equal(res.value, listings);
});

test("a genuine refusal behind a 403 still reads as blocked", async () => {
  const denial = "<html><body>Access denied. You do not have permission.</body></html>";
  const { solver } = fakeSolver(solvedAfter403(denial));

  const res = await client(solver).getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false, "a short denial page keeps its status");
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
});

test("a long page that is still the bot check reads as blocked", async () => {
  const challenge = `<html><head><title>Just a moment</title></head><body>datadome${"x".repeat(30_000)}</body></html>`;
  const { solver } = fakeSolver(solvedAfter403(challenge));

  const res = await client(solver).getText("https://portal.invalid/a", { solver: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
});

test("whether the solver keeps a session is reported once", async () => {
  const notes: { available: boolean; reason: string }[] = [];
  const calls: Call[] = [];
  const impl = (async (_endpoint: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Call);
    return new Response(JSON.stringify(sessionless(calls[calls.length - 1] as Call)), { status: 200 });
  }) as unknown as typeof fetch;

  const solver = new Solver({
    endpoint: "http://solver.invalid/v1", timeoutMs: 1_000, useSession: true,
    onSession: (available, reason) => notes.push({ available, reason }),
  }, impl);
  const http = client(solver);

  await http.getText("https://portal.invalid/1", { solver: true });
  await http.getText("https://portal.invalid/2", { solver: true });

  assert.equal(notes.length, 1, "reported once, not per page");
  assert.equal(notes[0]?.available, false);
  assert.match(notes[0]?.reason ?? "", /session/i);
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
