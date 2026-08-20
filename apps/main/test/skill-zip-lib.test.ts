// P0 SDS agent-self-install §2.4: controlled ZIP parsing shared by both
// upload-from-zip and ClawHub install-skill. Rejects path traversal, zip
// bombs, missing SKILL.md, and binary-non-utf8 transparently.

import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseSkillZipBytes, parseSkillZipBytesRaw, SkillZipError } from "../src/lib/skill-zip";

function zip(entries: Array<{ name: string; content: Uint8Array | string }>): Uint8Array {
  const obj: Record<string, Uint8Array> = {};
  for (const e of entries) {
    obj[e.name] = typeof e.content === "string" ? strToU8(e.content) : e.content;
  }
  return zipSync(obj);
}

describe("parseSkillZipBytes — happy path", () => {
  it("extracts SKILL.md plus sibling files; binary entries get base64 encoding", () => {
    // SKILL.md → utf8; sibling file with non-UTF-8 bytes → base64.
    // We use a deterministic non-UTF-8 sequence (every byte is 0xff,
    // which is NEVER a valid UTF-8 byte) so the binary path is
    // unambiguously triggered.
    const nonUtf8 = new Uint8Array(256).fill(0xff);
    const bytes = zip([
      { name: "SKILL.md", content: "---\nname: x\n---\n# x\n" },
      { name: "blob.bin", content: nonUtf8 },
    ]);
    const parsed = parseSkillZipBytes(bytes);
    expect(parsed.name).toBe("x");
    const skill = parsed.files.find((f) => f.filename === "SKILL.md");
    expect(skill).toBeDefined();
    expect(skill!.encoding).toBe("utf8");
    const bin = parsed.files.find((f) => f.filename === "blob.bin");
    expect(bin).toBeDefined();
    expect(bin!.encoding).toBe("base64");
    // Base64 round-trip — decode via charCodeAt since Uint8Array.from
    // on a string iterates code units, not bytes, and engines disagree
    // on UTF-8 vs Latin-1 semantics.
    const decoded = atob(bin!.content);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    expect(out).toEqual(nonUtf8);
  });

  it("parseSkillZipBytesRaw returns Uint8Array for blob storage without round-trip", () => {
    // Non-UTF-8 sequence → binary path; verify the raw API preserves
    // the bytes verbatim for R2 writes.
    const nonUtf8 = new Uint8Array(256).fill(0xff);
    const bytes = zip([
      { name: "SKILL.md", content: "---\nname: x\n---\n# x\n" },
      { name: "blob.bin", content: nonUtf8 },
    ]);
    const parsed = parseSkillZipBytesRaw(bytes);
    const bin = parsed.files.find((f) => f.filename === "blob.bin")!;
    expect(bin.encoding).toBe("base64");
    expect(bin.bytes).toEqual(nonUtf8);
  });

  it("strips the common top-level directory (Anthropic-style pack)", () => {
    const bytes = zip([
      { name: "my-skill/SKILL.md", content: "---\nname: my-skill\n---\n" },
      { name: "my-skill/README.md", content: "# readme" },
    ]);
    const parsed = parseSkillZipBytes(bytes);
    expect(parsed.files.map((f) => f.filename)).toEqual(["SKILL.md", "README.md"]);
  });

  it("filters __MACOSX/.DS_Store/Thumbs.db without counting against the file budget", () => {
    const bytes = zip([
      { name: "SKILL.md", content: "x" },
      { name: "__MACOSX/._SKILL.md", content: "junk" },
      { name: ".DS_Store", content: "junk" },
      { name: "Thumbs.db", content: "junk" },
    ]);
    const parsed = parseSkillZipBytes(bytes);
    expect(parsed.files.map((f) => f.filename)).toEqual(["SKILL.md"]);
  });
});

describe("parseSkillZipBytes — security", () => {
  it("rejects path traversal (../) entries", () => {
    const bytes = zip([
      { name: "SKILL.md", content: "x" },
      { name: "../../etc/passwd", content: "evil" },
    ]);
    expect(() => parseSkillZipBytes(bytes)).toThrow(SkillZipError);
    expect(() => parseSkillZipBytes(bytes)).toThrow(/path traversal/i);
  });

  it("rejects absolute-path entries", () => {
    const bytes = zip([
      { name: "SKILL.md", content: "x" },
      { name: "/etc/passwd", content: "evil" },
    ]);
    expect(() => parseSkillZipBytes(bytes)).toThrow(SkillZipError);
  });

  it("rejects windows-style backslash entries", () => {
    const bytes = zip([
      { name: "SKILL.md", content: "x" },
      { name: "..\\evil.md", content: "x" },
    ]);
    expect(() => parseSkillZipBytes(bytes)).toThrow(SkillZipError);
  });

  it("rejects zip-bombs (declared uncompressed size > per-file cap)", () => {
    // fflate reads uncompressed size from the CENTRAL DIRECTORY entry
    // (signature 0x02014b50), not the local file header. Walk the
    // produced zip, find the CD entry for SKILL.md, and inflate the
    // declared uncompressed size past the per-file cap.
    const small = zip([{ name: "SKILL.md", content: "x" }]);
    const view = new DataView(small.buffer, small.byteOffset, small.byteLength);
    const len = small.byteLength;
    const CD_SIG = 0x02014b50;
    let cdOffset = -1;
    for (let i = 0; i < len - 4; i++) {
      if (view.getUint32(i, true) === CD_SIG) {
        cdOffset = i;
        break;
      }
    }
    expect(cdOffset).toBeGreaterThanOrEqual(0);
    // Central directory entry layout: sig(4) + verMade(2) + verNeed(2) +
    // flags(2) + method(2) + mtime(2) + mdate(2) + crc(4) + compressed(4) +
    // UNCOMPRESSED(4) → offset 24 within the entry.
    view.setUint32(cdOffset + 24, 26 * 1024 * 1024, true);
    expect(() => parseSkillZipBytes(small)).toThrow(/per-file limit/i);
  });

  it("rejects zips with too many files (>500)", () => {
    const entries = [{ name: "SKILL.md", content: "x" }];
    for (let i = 0; i < 501; i++) entries.push({ name: `f${i}.txt`, content: "x" });
    const bytes = zip(entries);
    expect(() => parseSkillZipBytes(bytes)).toThrow(/too many files/i);
  });

  it("rejects zips missing SKILL.md", () => {
    const bytes = zip([{ name: "README.md", content: "no skill" }]);
    expect(() => parseSkillZipBytes(bytes)).toThrow(/SKILL\.md/i);
  });

  it("rejects SKILL.md that is not UTF-8 text", () => {
    const bytes = zip([
      { name: "SKILL.md", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) },
    ]);
    expect(() => parseSkillZipBytes(bytes)).toThrow(/UTF-8/i);
  });
});