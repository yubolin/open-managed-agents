import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { kvKey } from "../kv-helpers";
import { generateId, skillFileR2Key } from "@open-managed-agents/shared";
import { CLAWHUB_BASE, searchClawHubSkills, type ClawHubPackage } from "../lib/clawhub";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>();

// GET /v1/clawhub/search?q=xxx — search ClawHub registry
app.get("/search", async (c) => {
  try {
    return c.json({ data: await searchClawHubSkills(c.req.query("q") || "") });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "ClawHub search failed" }, 502);
  }
});

// POST /v1/clawhub/install — install a skill from ClawHub
//
// SDS v0.2 §1.6 / §3.2: `version` is REQUIRED and must be explicit.
// "latest" is forbidden — callers must pin a version so installs are
// reproducible and the sha256 hash pinned at install time can be
// re-checked at attach time. Backwards-incompatible with v0.1 callers
// that omitted the field; update `oma skills install <slug> <version>`.
app.post("/install", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ slug?: string; version?: string }>();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);
  if (!body.version) {
    return c.json(
      { error: "version is required (latest is not allowed; pass an explicit version)" },
      400,
    );
  }
  if (body.version === "latest") {
    return c.json(
      { error: "version 'latest' is forbidden; pass an explicit version pin" },
      400,
    );
  }

  // 1. Get package metadata
  const metaRes = await fetch(`${CLAWHUB_BASE}/packages/${encodeURIComponent(body.slug)}`);
  if (!metaRes.ok) return c.json({ error: `Skill "${body.slug}" not found on ClawHub` }, 404);
  const meta = (await metaRes.json()) as { package: ClawHubPackage };
  // Refuse if the package has no published version (caller should never see
  // "latest" either, but a missing latestVersion means the skill is broken
  // upstream — fail loud rather than guess).
  if (!meta.package.latestVersion) {
    return c.json({ error: "ClawHub package has no published version" }, 502);
  }

  // 2. Download zip
  const dlRes = await fetch(`${CLAWHUB_BASE}/download?slug=${encodeURIComponent(body.slug)}&version=${encodeURIComponent(body.version)}`);
  if (!dlRes.ok) return c.json({ error: `Failed to download skill: ${dlRes.status}` }, 502);

  // 3. Extract files from zip
  const files = await extractZipFiles(dlRes);

  if (files.length === 0) {
    return c.json({ error: "Downloaded zip contains no files" }, 502);
  }

  const bucket = c.var.services.filesBlob;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  // 4. Write file bytes to R2, store only manifest in KV
  const pkg = meta.package;
  const skillName = (pkg.displayName || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
  const id = `skill_${generateId()}`;
  const versionId = Date.now().toString();
  const now = new Date().toISOString();

  const manifest: Array<{ filename: string; size_bytes: number; encoding: "utf8" }> = [];
  for (const f of files) {
    const bytes = new TextEncoder().encode(f.content);
    await bucket.put(skillFileR2Key(t, id, versionId, f.filename), bytes);
    manifest.push({ filename: f.filename, size_bytes: bytes.byteLength, encoding: "utf8" });
  }

  const skill = {
    id,
    display_title: pkg.displayName || pkg.name,
    name: skillName,
    description: pkg.summary || "",
    source: "custom" as const,
    latest_version: versionId,
    created_at: now,
    clawhub_slug: body.slug,
  };

  const version = { version: versionId, files: manifest, created_at: now };

  await Promise.all([
    c.var.services.kv.put(kvKey(t, "skill", id), JSON.stringify(skill)),
    c.var.services.kv.put(kvKey(t, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  return c.json({ ...skill, files }, 201);
});

/**
 * Extract text files from a zip ArrayBuffer.
 * Minimal zip parser — handles Store (0) and Deflate (8) methods.
 */
async function extractZipFiles(res: Response): Promise<Array<{ filename: string; content: string }>> {
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const files: Array<{ filename: string; content: string }> = [];
  let offset = 0;

  while (offset < buf.byteLength - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = new Uint8Array(buf, offset + 30, nameLen);
    const filename = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = new Uint8Array(buf, dataStart, compressedSize);

    if (!filename.endsWith("/") && !filename.startsWith("__MACOSX")) {
      try {
        let content: string;
        if (compressionMethod === 8) {
          // Deflate
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(rawData).catch((err) => {
            logWarn({ op: "clawhub.zip.deflate_write", err }, "deflate write failed");
          });
          writer.close().catch((err) => {
            logWarn({ op: "clawhub.zip.deflate_close", err }, "deflate close failed");
          });
          const decompressed = new Response(ds.readable);
          content = await decompressed.text();
        } else {
          content = new TextDecoder().decode(rawData);
        }
        files.push({ filename, content });
      } catch (err) {
        // Skip files that fail to decompress — preserve the rest of the zip.
        logWarn(
          { op: "clawhub.zip.entry_decompress", filename, err },
          "skipping unreadable zip entry",
        );
      }
    }

    offset = dataStart + compressedSize;
  }

  return files;
}

export default app;
