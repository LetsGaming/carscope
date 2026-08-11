import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";

/**
 * Moves a warmed browser session between machines.
 *
 * `data/` is runtime state and is not in git, so a profile warmed on a desktop
 * does not reach a server by itself. This copies the profile and the saved
 * cookies to or from a directory that can be scp'd.
 *
 *   npm run session -- export ./mobile-session
 *   npm run session -- import ./mobile-session
 */
const [action, target] = process.argv.slice(2);
if ((action !== "export" && action !== "import") || target === undefined) {
  process.stderr.write("usage: npm run session -- <export|import> <directory>\n");
  process.exit(1);
}

const config = loadConfig();
const profileDir = config.collect.browserProfileDir ?? join(config.dataDir, "browser-profile");
const stateDir = join(config.dataDir, "browser-state");

/** Caches and logs are large, machine-specific and not part of a session. */
const SKIP = new Set([
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache",
  "Crashpad", "component_crx_cache", "Safe Browsing", "Default/Cache",
]);

async function copyTree(from: string, to: string): Promise<number> {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => null);
  if (entries === null) return 0;
  await mkdir(to, { recursive: true });

  let copied = 0;
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) copied += await copyTree(source, destination);
    else {
      await cp(source, destination, { force: true });
      copied += 1;
    }
  }
  return copied;
}

const pairs = action === "export"
  ? [[profileDir, join(target, "profile")], [stateDir, join(target, "state")]]
  : [[join(target, "profile"), profileDir], [join(target, "state"), stateDir]];

let total = 0;
for (const [from, to] of pairs) {
  if (from === undefined || to === undefined) continue;
  if (action === "import") await rm(to, { recursive: true, force: true });
  total += await copyTree(from, to);
}

process.stdout.write(
  `${action === "export" ? "Exportiert" : "Importiert"}: ${String(total)} Dateien\n`
  + (action === "export"
    ? `  ${target} auf den Server kopieren, dort: npm run session -- import ${target}\n`
    : `  Profil liegt in ${profileDir}\n`),
);
