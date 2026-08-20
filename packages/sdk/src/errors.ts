/**
 * Typed error thrown by every SDK call when the server returns
 * non-2xx. Carries the HTTP status, the parsed body when JSON-shaped,
 * and the raw text otherwise — enough to switch on for retry / UI
 * surfacing without re-fetching.
 */
export class OpenMAError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
  readonly url: string;

  constructor(status: number, raw: string, url: string) {
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    const message = (parsed && typeof parsed === "object" && "error" in parsed
      ? typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : JSON.stringify((parsed as { error: unknown }).error)
      : raw || `HTTP ${status}`);
    super(`OpenMA ${status}: ${message}`);
    this.name = "OpenMAError";
    this.status = status;
    this.body = parsed;
    this.raw = raw;
    this.url = url;
  }
}

/**
 * Runtime capability gap discriminator (SDS agent-self-install §2.7 /
 * runtime-capabilities.md §4). main-node answers not-yet-implemented
 * APIs with 501 {error, runtime:"node"}; a 501 means "this runtime
 * can't do it" and must surface as such — never as an empty result.
 * 404 ("resource missing") is a different state and stays excluded.
 */
export function isOpenMANotImplemented(
  e: unknown,
): e is OpenMAError & { status: 501 } {
  return e instanceof OpenMAError && e.status === 501;
}
