import { resolve, relative } from "node:path";

// NOTE: zod is not declared as a dependency. We parse env with manual typed
// helpers to keep the dependency footprint minimal for MVP 0.

export interface AppConfig {
  fireflyBaseUrl: string;
  fireflyToken: string;
  geminiApiKey: string;
  geminiModel: string;
  slipsRawDir: string;
  dbPath: string;
  cfAccessHeader: string;
  cfAccessDevBypass: boolean;
  port: number;
}

function envStr(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined) return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === "true" || val === "1";
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

/**
 * Validate that the DB path is not inside the raw slips directory.
 * Throws if the guard is violated.
 */
export function validateConfigPaths(config: AppConfig): void {
  const absRawDir = resolve(config.slipsRawDir);
  const absDbPath = resolve(config.dbPath);
  const rel = relative(absRawDir, absDbPath);
  if (!rel.startsWith("..") && rel !== "") {
    throw new Error(
      `DB_PATH must not be inside SLIPS_RAW_DIR (` +
        `resolved slipsRawDir=${absRawDir}, dbPath=${absDbPath})`,
    );
  }
}

export function loadConfig(): AppConfig {
  const slipsRawDir = envStr("SLIPS_RAW_DIR");
  const dbPath = envStr("DB_PATH", "./data/app.sqlite");

  const config: AppConfig = {
    fireflyBaseUrl: envStr("FIREFLY_BASE_URL"),
    fireflyToken: envStr("FIREFLY_TOKEN"),
    geminiApiKey: envStr("GEMINI_API_KEY"),
    geminiModel: envStr("GEMINI_MODEL", "gemini-2.5-flash"),
    slipsRawDir,
    dbPath,
    cfAccessHeader: envStr(
      "CF_ACCESS_HEADER",
      "Cf-Access-Authenticated-User-Email",
    ),
    cfAccessDevBypass: envBool("CF_ACCESS_DEV_BYPASS", false),
    port: envInt("PORT", 3000),
  };

  validateConfigPaths(config);
  return config;
}
