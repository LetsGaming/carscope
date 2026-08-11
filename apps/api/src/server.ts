import { build } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = await build({ config });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}

await app.listen({ port: config.port, host: config.host });
