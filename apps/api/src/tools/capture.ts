import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserFailure, PlaywrightBrowser } from "@carscope/collector";
import { loadConfig } from "../config.ts";

/**
 * Fetches a URL exactly as the collector would and saves what came back.
 *
 * Writing an adapter against a guess is how three of the four here had to be
 * written twice. This produces the fixture a parser should be built from, and it
 * is also the fastest way to see why a portal is refusing.
 *
 *   npm run capture -- "https://www.example.de/search?q=..."
 */
const url = process.argv[2];
if (url === undefined) {
  process.stderr.write('usage: npm run capture -- "<url>" [name]\n');
  process.exit(1);
}

const config = loadConfig();
const name = process.argv[3] ?? new URL(url).host;
const outDir = join(config.dataDir, "captures");
const browser = new PlaywrightBrowser();

try {
  const page = await browser.fetch(url, {
    headless: config.collect.browserHeadless,
    ...(config.collect.browserUserAgent === null ? {} : { userAgent: config.collect.browserUserAgent }),
    locale: config.collect.locale,
    timeoutMs: Math.max(config.collect.timeoutMs, 30_000),
    settleMs: config.collect.browserSettleMs,
    timezone: config.collect.timezone,
    stateDir: join(config.dataDir, "browser-state"),
    ...(config.collect.browserCdp === null ? {} : { cdpEndpoint: config.collect.browserCdp }),
    ...(config.collect.browserProfileDir === null ? {} : { profileDir: config.collect.browserProfileDir }),
    debugDir: outDir,
    ...(config.collect.browserChannel === null ? {} : { channel: config.collect.browserChannel }),
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${name}.html`), page.body);

  process.stdout.write(
    `status ${String(page.status)}, ${String(Math.round(page.body.length / 1024))} KB\n`
    + `  ${join(outDir, `${name}.html`)}\n`
    + `  ${join(outDir, new URL(url).host)}/  (Screenshot und Markup je Abruf)\n`,
  );
} catch (e) {
  const failure = browserFailure(e);
  process.stderr.write(`${failure.kind}: ${failure.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
