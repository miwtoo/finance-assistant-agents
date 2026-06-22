import { Elysia } from "elysia";
import { loadConfig, validateConfigPaths } from "./config";
import type { AppConfig } from "./config";
import type { ParserProvider } from "./domain/parserTypes";
import { cloudflareAccessGuard } from "./web/middleware/cloudflareAccess";
import { candidatesPageHandler } from "./web/routes/candidates";
import {
  parseSlipHandler,
  createManualDraftHandler,
  saveDraftFieldHandler,
  markDraftReadyHandler,
} from "./web/routes/draftApi";

export interface CreateAppOptions {
  /** Optional parser provider (injected for testing). Default: none (parse will fail at runtime until Gemini is wired). */
  parserProvider?: ParserProvider;
}

/**
 * Create the application with optional dependency injection.
 *
 * @param config - Application configuration (defaults to env-based)
 * @param opts   - Optional overrides (e.g. parser provider for testing)
 */
export function createApp(config = loadConfig(), opts?: CreateAppOptions) {
  // Guard: enforce DB_PATH not under SLIPS_RAW_DIR even when config is passed directly
  validateConfigPaths(config);

  const app = new Elysia();

  // Cloudflare Access guard — runs on every request
  app.onRequest(cloudflareAccessGuard(config));

  // Health
  app.get("/health", () => ({
    ok: true,
    service: "finance-assistant-agents",
  }));

  // Candidates page (existing)
  app.get("/candidates", candidatesPageHandler(config));

  // Draft API routes
  const provider = opts?.parserProvider ?? createNullParser();

  app.post("/candidates/:id/parse", parseSlipHandler(config, provider));
  app.post("/candidates/:id/create-draft", createManualDraftHandler(config));
  app.patch("/drafts/:id", saveDraftFieldHandler(config));
  app.post("/drafts/:id/mark-ready", markDraftReadyHandler(config));

  return app;
}

/**
 * Create a null parser for when no provider is configured.
 * Returns failed parse results for every call.
 */
function createNullParser(): ParserProvider {
  return {
    name: "none",
    model: null,
    async parse(_imagePath: string) {
      return {
        date: null,
        amount: null,
        currency: null,
        parsedMerchant: null,
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: [],
        confidence: "low",
        assessments: {},
        status: "failed" as any,
        providerRawPayload: null,
      };
    },
  };
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
