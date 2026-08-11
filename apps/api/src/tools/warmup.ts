import { join } from "node:path";
import { PlaywrightBrowser, browserFailure } from "@carscope/collector";
import { loadConfig } from "../config.ts";

/**
 * Opens a portal in the persistent profile so a person can get through whatever
 * it asks for — consent, a challenge, a puzzle — once.
 *
 * The profile keeps the cookies and the local storage that follow, and the
 * collector reuses them unattended from then on. This is the one-time setup;
 * after it, nothing here needs a human.
 *
 *   npm run warmup -- https://suchen.mobile.de/fahrzeuge/search.html
 */
const url = process.argv[2] ?? "https://suchen.mobile.de/";
const config = loadConfig();
const profileDir = config.collect.browserProfileDir ?? join(config.dataDir, "browser-profile");

process.stdout.write(
  `Profil: ${profileDir}\n`
  + "Fenster öffnet sich. Zustimmen, ggf. Prüfung lösen, kurz normal browsen, dann Fenster schließen.\n\n",
);

const browser = new PlaywrightBrowser();
try {
  const page = await browser.fetch(url, {
    headless: false,
    locale: config.collect.locale,
    timeoutMs: 120_000,
    settleMs: 60_000,
    timezone: config.collect.timezone,
    profileDir,
    ...(config.collect.browserChannel === null ? {} : { channel: config.collect.browserChannel }),
  });
  process.stdout.write(
    `status ${String(page.status)}\n`
    + `Profil gespeichert. Jetzt COLLECT_BROWSER_PROFILE_DIR=${profileDir} setzen.\n`,
  );
} catch (e) {
  const failure = browserFailure(e);
  process.stderr.write(`${failure.kind}: ${failure.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
