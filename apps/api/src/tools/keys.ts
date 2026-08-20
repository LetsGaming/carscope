import { openDatabase } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { ApiKeyRepository } from "../repositories/api-keys.ts";
import { issueKey, scopesToColumn, SCOPE, type Scope } from "../services/api-keys.ts";

/**
 * Issues, lists and revokes API keys directly against the database. There is
 * deliberately no HTTP endpoint for this: a key is only ever as trustworthy as
 * whoever can create one, so creation is restricted to whoever can already
 * reach the deployment and run a command in it — the same bar Docker or a
 * server login already sets.
 *
 *   npm run keys -- issue "r34-dashboard" --scope admin --expires 2027-01-01
 *   npm run keys -- list
 *   npm run keys -- revoke a1b2c3d4
 */
const [action, ...rest] = process.argv.slice(2);
const USAGE = "usage: npm run keys -- <issue <label> [--scope admin] [--expires <iso>]|list|revoke <prefix>>\n";

if (action === undefined) {
  process.stderr.write(USAGE);
  process.exit(1);
}

const config = loadConfig();
// WAL means this is safe to run against a database the server already has open.
const db = openDatabase(config.databaseFile);
const repo = new ApiKeyRepository(db);

function flag(name: string): string | null {
  const i = rest.indexOf(name);
  return i === -1 || rest[i + 1] === undefined ? null : (rest[i + 1] ?? null);
}

switch (action) {
  case "issue": {
    const label = rest.find((a) => !a.startsWith("--"));
    if (label === undefined) {
      process.stderr.write(USAGE);
      process.exit(1);
    }
    const scopeArg = flag("--scope");
    const scopes: Scope[] = scopeArg === SCOPE.admin ? [SCOPE.admin] : scopeArg === SCOPE.write ? [SCOPE.write] : [];
    const expiresAt = flag("--expires");

    const issued = issueKey();
    repo.insert({ prefix: issued.prefix, tokenHash: issued.tokenHash, label, scopes: scopesToColumn(scopes), expiresAt });

    process.stdout.write(
      `Token (nur jetzt sichtbar, nicht wiederherstellbar):\n  ${issued.token}\n\n`
      + `Prefix: ${issued.prefix}   Scopes: ${scopes.length > 0 ? scopes.join(",") : "(keine, nur Lese-Tarif)"}\n`,
    );
    break;
  }

  case "list": {
    for (const row of repo.list()) {
      const state = row.revoked_at !== null ? "revoked"
        : row.expires_at !== null && Date.parse(row.expires_at) <= Date.now() ? "expired"
        : "active";
      process.stdout.write(
        `${row.prefix}  ${row.label.padEnd(24)}  ${(row.scopes || "-").padEnd(12)}  ${state}  `
        + `last used: ${row.last_used_at ?? "never"}\n`,
      );
    }
    break;
  }

  case "revoke": {
    const prefix = rest[0];
    if (prefix === undefined) {
      process.stderr.write(USAGE);
      process.exit(1);
    }
    const ok = repo.revoke(prefix);
    process.stdout.write(ok ? `Widerrufen: ${prefix}\n` : `Kein aktiver Schlüssel mit diesem Prefix.\n`);
    if (!ok) process.exitCode = 1;
    break;
  }

  default:
    process.stderr.write(USAGE);
    process.exit(1);
}

db.close();
