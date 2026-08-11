import { join } from "node:path";
import { browserFailure, PlaywrightBrowser } from "@carscope/collector";
import { loadConfig } from "../config.ts";

/**
 * Loads a bot-detection test page with the browser exactly as configured, and
 * saves what it reported.
 *
 * Guessing which check a portal fails has cost several rounds. This shows it:
 * open the screenshot, read the red rows, and change only what they name.
 *
 *   npm run fingerprint
 *   npm run fingerprint -- https://abrahamjuliot.github.io/creepjs/
 */
const url = process.argv[2] ?? "https://bot.sannysoft.com/";
const config = loadConfig();
const outDir = join(config.dataDir, "fingerprint");
const browser = new PlaywrightBrowser();

process.stdout.write(
  `Prüfseite: ${url}\n`
  + `  stealth=${config.collect.browserStealth} headless=${String(config.collect.browserHeadless)} `
  + `channel=${config.collect.browserChannel ?? "(gebündeltes Chromium)"}\n`
  + `  profil=${config.collect.browserProfileDir ?? "(keins)"}\n\n`,
);

try {
  const page = await browser.fetch(url, {
    headless: config.collect.browserHeadless,
    locale: config.collect.locale,
    timeoutMs: 60_000,
    settleMs: 3_000,
    timezone: config.collect.timezone,
    stealth: config.collect.browserStealth,
    // The test page needs its own assets to render its verdict.
    blockAssets: false,
    debugDir: outDir,
    ...(config.collect.browserChannel === null ? {} : { channel: config.collect.browserChannel }),
    ...(config.collect.browserProfileDir === null ? {} : { profileDir: config.collect.browserProfileDir }),
    ...(config.collect.browserCdp === null ? {} : { cdpEndpoint: config.collect.browserCdp }),
  });
  process.stdout.write(`status ${String(page.status)}\n  ${join(outDir, `${new URL(url).host}.png`)}\n`);
} catch (e) {
  const failure = browserFailure(e);
  process.stderr.write(`${failure.kind}: ${failure.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
