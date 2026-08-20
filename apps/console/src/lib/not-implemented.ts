/**
 * 501 discriminator for runtime capability gaps (SDS agent-self-install
 * §2.7 / docs/skill-onboarding/runtime-capabilities.md §4).
 *
 * main-node answers the not-yet-implemented APIs (/v1/skills,
 * /v1/runtimes, integrations credentials endpoints, custom-skill
 * writes) with 501 {error, runtime:"node"}. A 501 must render as
 * "not implemented" — treating it like an empty list is the
 * silent-fake this module exists to prevent. 404 stays "resource
 * missing", which is a different state.
 */

import { ApiError } from "./api";

export function isNotImplementedError(e: unknown): e is ApiError & { status: 501 } {
  return e instanceof ApiError && e.status === 501;
}
