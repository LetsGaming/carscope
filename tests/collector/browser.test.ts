import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA, FAILURE } from "@carscope/core";
import {
  browserTransport, BrowserUnavailable, HostThrottle, HttpClient,
  collect, identityFor, type BrowserFetch, type BrowserOptions, type CollectorStore,
} from "@carscope/collector";
import { mock } from "../../packages/collector/src/adapters/mock.ts";

const OPTIONS: BrowserOptions = {
  headless: true, userAgent: "test", locale: "de-DE", timeoutMs: 1_000, settleMs: 0,
};

function fakeBrowser(pages: (() => Promise<{ status: number; body: string }>)): BrowserFetch {
  return { fetch: pages, close: async () => {} };
}

const client = (browser?: BrowserFetch): HttpClient =>
  new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "test",
    transport: async () => new Response("plain response", { status: 200 }),
    ...(browser === undefined ? {} : { browserTransport: browserTransport(browser, OPTIONS) }),
  });

test("a browser request goes to the browser backend, a plain one does not", async () => {
  const http = client(fakeBrowser(async () => ({ status: 200, body: "<html>rendered</html>" })));

  const plain = await http.getText("https://example.invalid/a");
  assert.ok(plain.ok);
  assert.equal(plain.value, "plain response");

  const rendered = await http.getText("https://example.invalid/a", { browser: true });
  assert.ok(rendered.ok);
  assert.equal(rendered.value, "<html>rendered</html>");
});

test("a missing browser is a named failure, never an empty result", async () => {
  const http = client();
  const res = await http.getText("https://example.invalid/a", { browser: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
  assert.match(res.ok ? "" : res.error.message, /needs a browser/);
});

test("a browser that cannot launch reports why rather than returning nothing", async () => {
  const http = client(fakeBrowser(async () => { throw new BrowserUnavailable(new Error("no chromium")); }));
  const res = await http.getText("https://example.invalid/a", { browser: true });
  assert.equal(res.ok, false, "this is the silent-failure case that must stay loud");
  assert.match(res.ok ? "" : res.error.message, /Playwright is not available/);
});

test("a missing Chromium binary names the command that fixes it", async () => {
  const http = client(fakeBrowser(async () => {
    throw new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium/headless_shell");
  }));
  const res = await http.getText("https://example.invalid/a", { browser: true });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error.message, /npx playwright install chromium/);
});

test("a navigation that produced no response is not treated as a good page", async () => {
  const http = client(fakeBrowser(async () => ({ status: 0, body: "" })));
  const res = await http.getText("https://example.invalid/a", { browser: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? 0 : res.error.status, 599);
});

test("a bot challenge rendered by the browser is still recognised", async () => {
  const http = client(fakeBrowser(async () => ({
    status: 200,
    body: "<html><body>Please enable JS — captcha-delivery.com</body></html>",
  })));
  const res = await http.getText("https://example.invalid/a", { browser: true });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.error.kind, FAILURE.blocked);
});

test("a source that needs a browser and has none records a failed run, not an empty one", async () => {
  const runs: { status: string; note: string | null }[] = [];
  const store: CollectorStore = {
    resolveVehicle: () => ({ vehicle: { id: "v" } as never, created: true }),
    upsertListing() {}, recordPrice() {}, savePhotos() {}, setImageHash() {},
    saveDetail() {}, needsDetail: () => false,
    markDelisted: () => 0,
    recordRun: (r) => { runs.push({ status: r.status, note: r.note }); },
  };

  const run = await collect(
    {
      http: client(),
      store,
      now: () => new Date("2026-08-06T00:00:00Z"),
      options: {
        maxPages: 1, sourceDeadlineMs: 30_000, maxDetails: 25, detailReserveMs: 1_000,
        enrichDetails: true, solverSources: [], rateToBase: () => 1,
      },
    },
    { ...mock, needsBrowser: true },
    { id: "s1", name: "R34", criteria: EMPTY_CRITERIA },
  );

  assert.equal(run.status, "blocked");
  assert.equal(run.fetched, 0);
  assert.match(runs[0]?.note ?? "", /needs a browser/);
});

test("consent handling stays inside its budget on a page full of iframes", async () => {
  // A results page carries a dozen advertising iframes. Probing every selector
  // in every one of them used to cost more than a source is allowed to take.
  let attempts = 0;
  const frame = (url: string) => ({
    url: () => url,
    locator: () => ({
      first() { return this; },
      async click({ timeout }: { timeout: number }) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, timeout));
        throw new Error("not found");
      },
    }),
  });

  const page = {
    ...frame("https://portal.invalid/results"),
    frames: () => [
      ...Array.from({ length: 12 }, (_, i) => frame(`https://ads.invalid/banner-${String(i)}`)),
      frame("https://consent.portal.invalid/cmp"),
    ],
  };

  const started = Date.now();
  const { acceptConsentForTest } = await import("../../packages/collector/src/browser.ts");
  const accepted = await acceptConsentForTest(page as never);
  const elapsed = Date.now() - started;

  assert.equal(accepted, false);
  assert.ok(attempts <= 4, `probed ${String(attempts)} targets; advertising frames must be skipped`);
  assert.ok(elapsed < 2_500, `took ${String(elapsed)}ms, which would blow the source deadline`);
});

test("the headless marker is corrected everywhere the page can be asked", async () => {
  const { userAgentForTest, clientHintsForTest } = await import(
    "../../packages/collector/src/browser.ts"
  );

  const headless = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) HeadlessChrome/133.0.6943.16 Safari/537.36";
  const corrected = userAgentForTest(headless);

  assert.ok(!corrected.includes("Headless"), "the user agent no longer announces headless");
  assert.ok(corrected.includes("Chrome/133.0.6943.16"), "the version still matches the binary");

  // Client hints travel with the user agent and are checked against it.
  const hints = clientHintsForTest(corrected);
  assert.match(hints["sec-ch-ua"] ?? "", /"Google Chrome";v="133"/);
  assert.ok(!(hints["sec-ch-ua"] ?? "").includes("Headless"));
  assert.equal(hints["sec-ch-ua-platform"], '"Windows"');
  assert.equal(hints["sec-ch-ua-mobile"], "?0");
});

test("client hints are omitted when the version cannot be read", async () => {
  const { clientHintsForTest } = await import("../../packages/collector/src/browser.ts");
  assert.deepEqual(clientHintsForTest("some other browser"), {});
});

test("the browser corrects what headless Chromium says about itself", async () => {
  const { clientHintsForTest, userAgentForTest } = await import("../../packages/collector/src/browser.ts");

  const headless = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) HeadlessChrome/133.0.6943.16 Safari/537.36";
  const userAgent = userAgentForTest(headless);
  const hints = clientHintsForTest(userAgent);

  // The one word is corrected; the version stays whatever the binary really is,
  // because a claimed version the browser does not have is its own giveaway.
  assert.ok(!userAgent.includes("Headless"));
  assert.ok(userAgent.includes("Chrome/133.0.6943.16"));

  // Client hints travel beside the user agent and have to agree with it.
  assert.equal(hints["sec-ch-ua-platform"], '"Windows"');
  assert.equal(hints["sec-ch-ua-mobile"], "?0");
  assert.ok(hints["sec-ch-ua"]?.includes('"Google Chrome";v="133"'));
  assert.ok(!hints["sec-ch-ua"]?.includes("Headless"));
});

test("client hints name a real browser, not Chromium alone", async () => {
  const { clientHintsForTest } = await import("../../packages/collector/src/browser.ts");
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
  const hints = clientHintsForTest(ua);

  // Bundled Chromium sends only Chromium plus a GREASE brand, which no installed
  // browser looks like.
  assert.match(hints["sec-ch-ua"] ?? "", /"Google Chrome";v="151"/);
  assert.match(hints["sec-ch-ua"] ?? "", /"Chromium";v="151"/);
  assert.equal(hints["sec-ch-ua-platform"], '"Windows"');
  assert.equal(hints["sec-ch-ua-mobile"], "?0");
});

test("the sensor wait gives up rather than hanging", async () => {
  const { waitForSensorForTest } = await import("../../packages/collector/src/browser.ts");
  const started = Date.now();
  const scored = await waitForSensorForTest({ cookies: async () => [{ name: "irrelevant" }] } as never);

  assert.equal(scored, false);
  assert.ok(Date.now() - started >= 5_000, "it waits for the sensor");
  assert.ok(Date.now() - started < 9_000, "but not forever");
});

test("a scored session is recognised as soon as the cookie appears", async () => {
  const { waitForSensorForTest } = await import("../../packages/collector/src/browser.ts");
  const started = Date.now();
  const scored = await waitForSensorForTest({
    cookies: async () => [{ name: "bm_so" }, { name: "_abck" }],
  } as never);

  assert.equal(scored, true, "_abck is what Akamai records its verdict in");
  assert.ok(Date.now() - started < 1_000, "and it returns at once");
});

/**
 * The trace of a headless run showed `HeadlessChrome/151` on every request to
 * AutoUncle, and Cloudflare challenged the first navigation and never cleared
 * it. The correction was computed and then applied only under stealth, which is
 * not the default, so it never reached the header it was written for.
 */
const HEADLESS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36";
const HEADFUL_UA = HEADLESS_UA.replace("HeadlessChrome", "Chrome");

test("a headless binary has its name corrected even with stealth off", () => {
  const identity = identityFor({
    detected: HEADFUL_UA,
    namesItselfHeadless: true,
    patched: false,
  });

  assert.equal(identity.override, true, "the corrected agent is actually sent");
  assert.ok(!identity.userAgent.includes("Headless"), "and carries no headless marker");
  assert.equal(identity.userAgent, HEADFUL_UA, "the version still matches the binary");
});

test("a headful binary is left to send its own consistent headers", () => {
  const identity = identityFor({
    detected: HEADFUL_UA,
    namesItselfHeadless: false,
    patched: false,
  });

  assert.equal(identity.override, false, "nothing is overridden");
});

test("a configured agent always wins and is always sent", () => {
  const identity = identityFor({
    detected: HEADFUL_UA,
    configured: "carscope/1.0",
    namesItselfHeadless: false,
    patched: false,
  });

  assert.equal(identity.userAgent, "carscope/1.0");
  assert.equal(identity.override, true);
});

test("stealth still overrides on its own", () => {
  const identity = identityFor({
    detected: HEADFUL_UA,
    namesItselfHeadless: false,
    patched: true,
  });

  assert.equal(identity.override, true);
});
