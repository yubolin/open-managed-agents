// Shared, controlled ZIP parser for skill artifacts.
//
// SDS agent-self-install §2.4 + P0 review 2026-08-20: previously the
// ClawHub install path hand-rolled its own minimal parser with no path
// traversal guard, no size limits, no SKILL.md requirement, and no
// binary-safe handling. Rejected path segments could escape the
// `/home/user/.skills/<name>/` directory the SessionDO writes into, and
// a malicious zip could declare multi-GB uncompressed sizes to exhaust
// Worker memory. This module factors the controlled parser used by
// /v1/skills/upload out into a shared lib so install + upload go through
// the same envelope.
//
// Invariants enforced before any byte is decoded:
//   - file count    ≤ ZIP_MAX_FILE_COUNT
//   - per-file uncompressed size ≤ ZIP_MAX_FILE_UNCOMPRESSED
//   - total uncompressed size   ≤ ZIP_MAX_TOTAL_UNCOMPRESSED
//   - every entry's path is relative, contains no `..`, no leading `/`,
//     no backslash
//   - exactly one entry maps to SKILL.md (case-insensitive) at the
//     resolved root
//   - SKILL.md is UTF-8 decodable text (not raw bytes)

import { unzipSync } from "fflate";

export class SkillZipError extends Error {}

export interface SkillFileInput {
  filename: string;
  /** Decoded content — utf8 string for text files, base64 for binary. */
  content: string;
  encoding: "utf8" | "base64";
}

/** Raw bytes + encoding for callers that need to write directly to
 *  blob storage without a base64 round-trip (e.g. install_skill into R2). */
export interface SkillFileBytes {
  filename: string;
  bytes: Uint8Array;
  encoding: "utf8" | "base64";
}

export interface ParsedSkillZip {
  files: SkillFileInput[];
  /** name parsed from SKILL.md YAML frontmatter, if present */
  name?: string;
  /** description parsed from SKILL.md YAML frontmatter, if present */
  description?: string;
}

/** Caps — SDS P0 review 2026-08-20. Generous enough for legitimate
 *  Anthropic-style packs (~5 MB / ~100 files in the field) with ~20×
 *  headroom. Reject at central-directory read so we never decompress
 *  attacker-declared gigabytes. */
export const ZIP_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;
export const ZIP_MAX_FILE_UNCOMPRESSED = 25 * 1024 * 1024;
export const ZIP_MAX_FILE_COUNT = 500;

const IGNORED_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const IGNORED_PREFIXES = ["__MACOSX/", ".git/", ".idea/", ".vscode/"];

function zipEntryIgnored(path: string): boolean {
  if (IGNORED_PREFIXES.some((p) => path.startsWith(p) || path.includes(`/${p}`))) return true;
  const base = path.split("/").pop() || "";
  if (IGNORED_BASENAMES.has(base)) return true;
  if (base.startsWith("._")) return true;
  return false;
}

/** Reject any path segment that could escape the skill directory or
 *  confuse downstream tooling. Backslashes are reserved on POSIX too —
 *  a maliciously crafted zip could deliver entries with `..\` segments
 *  that some clients normalize one way and others differently. */
function isPathSafe(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  // Split on every path separator; reject any segment that's exactly
  // `..` or starts with `..` followed by another separator.
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

function commonRootPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const firstSlash = paths[0].indexOf("/");
  if (firstSlash < 0) return "";
  const candidate = paths[0].slice(0, firstSlash + 1);
  return paths.every((p) => p.startsWith(candidate)) ? candidate : "";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(bin);
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function parseFrontmatter(
  content: string,
): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const result: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return { name: result.name, description: result.description };
}

export function parseSkillZipBytes(bytes: Uint8Array): ParsedSkillZip {
  // 1. Read central directory through fflate's filter, enforcing the
  // zip-bomb + file-count budget on declared sizes BEFORE decompression.
  let entries: Record<string, Uint8Array>;
  try {
    let totalUncompressed = 0;
    let count = 0;
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith("/") || zipEntryIgnored(file.name)) return false;
        // Path-traversal / absolute-path / backslash guard — fflate would
        // happily forward any of these downstream.
        if (!isPathSafe(file.name)) {
          throw new SkillZipError(
            `Zip entry "${file.name}" rejected: path traversal / absolute path / backslash not allowed`,
          );
        }
        count++;
        if (count > ZIP_MAX_FILE_COUNT) {
          throw new SkillZipError(
            `Zip has too many files (>${ZIP_MAX_FILE_COUNT}); refusing to process`,
          );
        }
        if (file.originalSize > ZIP_MAX_FILE_UNCOMPRESSED) {
          throw new SkillZipError(
            `File "${file.name}" is ${file.originalSize} bytes uncompressed; per-file limit is ${ZIP_MAX_FILE_UNCOMPRESSED}`,
          );
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED) {
          throw new SkillZipError(
            `Zip uncompressed size exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED} (zip-bomb defense)`,
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof SkillZipError) throw err;
    throw new SkillZipError(
      `Could not read zip: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  const usable = Object.entries(entries);
  if (usable.length === 0) {
    throw new SkillZipError("Zip is empty (after filtering metadata files)");
  }

  // 2. Strip the common top-level directory (Anthropic-style packs).
  const prefix = commonRootPrefix(usable.map(([p]) => p));
  const stripped = usable.map(([path, data]) => ({
    path: prefix ? path.slice(prefix.length) : path,
    bytes: data,
  }));

  // 3. SKILL.md must exist at the resolved root and decode as UTF-8.
  const skillMd = stripped.find((e) => e.path.toLowerCase() === "skill.md");
  if (!skillMd) {
    throw new SkillZipError(
      "Zip must contain SKILL.md at the root (or a single top-level folder containing it)",
    );
  }
  const skillMdText = tryDecodeUtf8(skillMd.bytes);
  if (skillMdText === null) {
    throw new SkillZipError("SKILL.md must be UTF-8 text");
  }

  // 4. Project every entry onto the same SkillFileInput shape the JSON
  // endpoint already consumes — utf8 for text, base64 for binary.
  const files: SkillFileInput[] = [];
  for (const entry of stripped) {
    if (!entry.path) continue;
    const decoded =
      entry.path === skillMd.path ? skillMdText : tryDecodeUtf8(entry.bytes);
    if (decoded !== null) {
      files.push({ filename: entry.path, content: decoded, encoding: "utf8" });
    } else {
      files.push({
        filename: entry.path,
        content: bytesToBase64(entry.bytes),
        encoding: "base64",
      });
    }
  }

  const { name, description } = parseFrontmatter(skillMdText);
  return { files, name, description };
}

/** Like parseSkillZipBytes but returns the raw bytes per file. Used by
 *  install_skill so R2 writes don't have to base64-round-trip binary
 *  entries. Same security guards — the only difference is the on-the-
 *  wire projection. */
export function parseSkillZipBytesRaw(bytes: Uint8Array): {
  files: SkillFileBytes[];
  name?: string;
  description?: string;
} {
  let entries: Record<string, Uint8Array>;
  try {
    let totalUncompressed = 0;
    let count = 0;
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith("/") || zipEntryIgnored(file.name)) return false;
        if (!isPathSafe(file.name)) {
          throw new SkillZipError(
            `Zip entry "${file.name}" rejected: path traversal / absolute path / backslash not allowed`,
          );
        }
        count++;
        if (count > ZIP_MAX_FILE_COUNT) {
          throw new SkillZipError(
            `Zip has too many files (>${ZIP_MAX_FILE_COUNT}); refusing to process`,
          );
        }
        if (file.originalSize > ZIP_MAX_FILE_UNCOMPRESSED) {
          throw new SkillZipError(
            `File "${file.name}" is ${file.originalSize} bytes uncompressed; per-file limit is ${ZIP_MAX_FILE_UNCOMPRESSED}`,
          );
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED) {
          throw new SkillZipError(
            `Zip uncompressed size exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED} (zip-bomb defense)`,
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof SkillZipError) throw err;
    throw new SkillZipError(
      `Could not read zip: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  const usable = Object.entries(entries);
  if (usable.length === 0) {
    throw new SkillZipError("Zip is empty (after filtering metadata files)");
  }

  const prefix = commonRootPrefix(usable.map(([p]) => p));
  const stripped = usable.map(([path, data]) => ({
    path: prefix ? path.slice(prefix.length) : path,
    bytes: data,
  }));

  const skillMd = stripped.find((e) => e.path.toLowerCase() === "skill.md");
  if (!skillMd) {
    throw new SkillZipError(
      "Zip must contain SKILL.md at the root (or a single top-level folder containing it)",
    );
  }
  const skillMdText = tryDecodeUtf8(skillMd.bytes);
  if (skillMdText === null) {
    throw new SkillZipError("SKILL.md must be UTF-8 text");
  }

  const files: SkillFileBytes[] = stripped
    .filter((e) => e.path.length > 0)
    .map((e) => {
      // SKILL.md is canonicalized — the bytes we keep are the decoded
      // text re-encoded as UTF-8 so downstream readers always see the
      // same byte sequence regardless of the original zip encoding.
      if (e.path === skillMd.path) {
        return {
          filename: e.path,
          bytes: new TextEncoder().encode(skillMdText),
          encoding: "utf8" as const,
        };
      }
      const isText = tryDecodeUtf8(e.bytes) !== null;
      return {
        filename: e.path,
        bytes: e.bytes,
        encoding: isText ? ("utf8" as const) : ("base64" as const),
      };
    });

  const { name, description } = parseFrontmatter(skillMdText);
  return { files, name, description };
}