import { Elysia } from "elysia";
import { loadConfig, validateConfigPaths } from "./config";
import { cloudflareAccessGuard } from "./web/middleware/cloudflareAccess";
import { candidatesPageHandler } from "./web/routes/candidates";

export function createApp(config = loadConfig()) {
  // Guard: enforce DB_PATH not under SLIPS_RAW_DIR even when config is passed directly
  validateConfigPaths(config);

  const app = new Elysia();

  // Cloudflare Access guard — runs on every request
  app.onRequest(cloudflareAccessGuard(config));

  app.get("/health", () => ({
    ok: true,
    service: "finance-assistant-agents",
  }));

  app.get("/candidates", candidatesPageHandler(config));

  return app;
}

// When run directly, start the server
const isMain =
  import.meta.path === Bun.main ||
  process.argv[1] === import.meta.path;

if (isMain) {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port);
  console.log(`Server listening on http://0.0.0.0:${config.port}`);
}

export type App = ReturnType<typeof createApp>;
