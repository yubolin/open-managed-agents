import canonicalize from "canonicalize";

export const SNAPSHOT_HASH_ALGORITHM = "sha256:jcs-rfc8785:v1" as const;

export class SnapshotNotJsonError extends TypeError {
  readonly code = "snapshot_not_json";

  constructor(message: string) {
    super(message);
    this.name = "SnapshotNotJsonError";
  }
}

export interface HashedJsonSnapshot<T> {
  /** The exact JSON value callers must persist alongside configHash. */
  normalized: T;
  canonicalJson: string;
  hashAlgorithm: typeof SNAPSHOT_HASH_ALGORITHM;
  configHash: string;
}

/**
 * Normalize an input to the same value JSON storage will retain. Object
 * members whose value is undefined are omitted; undefined array elements
 * become null. Non-JSON values are rejected before JSON.stringify can silently
 * coerce NaN/Infinity to null.
 */
export function normalizeJson<T>(input: T): T {
  const ancestors = new Set<object>();

  const visit = (value: unknown, inArray: boolean): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new SnapshotNotJsonError("snapshot contains a non-finite number");
      }
      return value;
    }
    if (value === undefined) return inArray ? null : undefined;
    if (typeof value === "bigint") {
      throw new SnapshotNotJsonError("snapshot contains a BigInt");
    }
    if (typeof value === "function" || typeof value === "symbol") {
      throw new SnapshotNotJsonError(`snapshot contains unsupported ${typeof value}`);
    }
    if (typeof value !== "object") {
      throw new SnapshotNotJsonError("snapshot is not JSON serializable");
    }
    if (ancestors.has(value)) {
      throw new SnapshotNotJsonError("snapshot contains a circular reference");
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => visit(item, true));
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new SnapshotNotJsonError("snapshot contains a non-plain object");
      }
      const normalized: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const prepared = visit(child, false);
        if (prepared !== undefined) normalized[key] = prepared;
      }
      return normalized;
    } finally {
      ancestors.delete(value);
    }
  };

  const normalized = visit(input, false);
  if (normalized === undefined) {
    throw new SnapshotNotJsonError("snapshot root cannot be undefined");
  }
  return normalized as T;
}

/** RFC 8785/JCS serialization using the audited canonicalize package. */
export function canonicalizeJson(input: unknown): string {
  const serialized = canonicalize(normalizeJson(input));
  if (serialized === undefined) {
    throw new SnapshotNotJsonError("snapshot cannot be canonicalized");
  }
  return serialized;
}

/** Edge-safe SHA-256: relies only on WebCrypto, available in Node and Workers. */
export async function hashJsonSnapshot<T>(input: T): Promise<HashedJsonSnapshot<T>> {
  const normalized = normalizeJson(input);
  const serialized = canonicalize(normalized);
  if (serialized === undefined) {
    throw new SnapshotNotJsonError("snapshot cannot be canonicalized");
  }
  const bytes = new TextEncoder().encode(serialized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const configHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return {
    normalized,
    canonicalJson: serialized,
    hashAlgorithm: SNAPSHOT_HASH_ALGORITHM,
    configHash,
  };
}
