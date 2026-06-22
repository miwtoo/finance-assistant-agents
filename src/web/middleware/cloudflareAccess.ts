import type { AppConfig } from "../../config";

/**
 * Cloudflare Access guard for Elysia onRequest.
 *
 * When `cfAccessDevBypass` is true the check is skipped (local dev).
 * Otherwise the request must include the configured CF-Access header
 * with a non-empty value, or a 401 JSON response is returned.
 */
export function cloudflareAccessGuard(config: AppConfig) {
  return ({
    request,
    set,
  }: {
    request: Request;
    set: { status?: number };
  }): { ok: boolean; error: string } | void => {
    if (config.cfAccessDevBypass) return;

    const headerValue = request.headers.get(config.cfAccessHeader);
    if (!headerValue || headerValue.trim() === "") {
      set.status = 401;
      return { ok: false, error: "Unauthorized" };
    }
  };
}
