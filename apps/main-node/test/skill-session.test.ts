// Skill read-path parity — Node mirror of CF session-do.ts:4417-4489.
//
// resolveSessionSkills() turns agent.skills into:
//   1. prompt reminders (source `skill:<id>`) — same byte format CF's
//      composeSystemPrompt inlines via <source name="..."> blocks
//   2. sandbox file mounts (progressive disclosure) at a workdir-relative
//      base — NOT /home/user, which would escape the Node workdir jail
//
// Ordering parity: CF pushes builtin skills (session-do:4419-4424) before
// custom skills (4429-4434). The registry then appends memory reminders
// after both. These tests pin the skill-half of that order.

import { describe, it, expect } from "vitest";
import { skillFileR2Key } from "@open-managed-agents/shared";
import {
  registerSkill,
  type SkillBucketLike,
  type SkillKvLike,
} from "@open-managed-agents/agent/harness/skills";
import {
  resolveSessionSkills,
  SKILLS_DIR_BASE,
} from "../src/lib/skill-session.js";

function fakeKv(entries: Record<string, string>): SkillKvLike {
  const m = new Map(Object.entries(entries));
  return { get: async (k) => m.get(k) ?? null };
}

function fakeBlobs(entries: Record<string, Uint8Array>): SkillBucketLike {
  const m = new Map(Object.entries(entries));
  return {
    get: async (k) => {
      const bytes = m.get(k);
      if (!bytes) return null;
      return {
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      };
    },
  };
}

const TENANT = "t_test";

// A custom skill exactly as node-skill-rpc.skillInstall persists it
// (KV meta + versioned manifest + blob bytes at skillFileR2Key paths).
function installFixture(opts?: { withSkillMd?: boolean; version?: string }) {
  const id = "skill_ch_demo_abc123";
  const version = opts?.version ?? "1.2.0";
  const files = opts?.withSkillMd === false
    ? [{ filename: "run.sh", size_bytes: 3, encoding: "utf8" as const }]
    : [
        { filename: "SKILL.md", size_bytes: 5, encoding: "utf8" as const },
        { filename: "run.sh", size_bytes: 3, encoding: "utf8" as const },
      ];
  const skillMd = "---\nname: demo\n---\nDo the demo thing.";
  const kv = fakeKv({
    [`t:${TENANT}:skill:${id}`]: JSON.stringify({
      id,
      name: "demo-skill",
      display_title: "Demo Skill",
      description: "A demo",
      latest_version: version,
    }),
    [`t:${TENANT}:skillver:${id}:${version}`]: JSON.stringify({ files }),
  });
  const blobs = fakeBlobs(
    opts?.withSkillMd === false
      ? { [skillFileR2Key(TENANT, id, version, "run.sh")]: new Uint8Array([1, 2, 3]) }
      : {
          [skillFileR2Key(TENANT, id, version, "SKILL.md")]: new TextEncoder().encode(skillMd),
          [skillFileR2Key(TENANT, id, version, "run.sh")]: new Uint8Array([1, 2, 3]),
        },
  );
  return {
    id,
    version,
    skillMd,
    kv,
    blobs,
    configs: [{ skill_id: id, type: "custom", version }] as Array<{
      skill_id: string;
      type?: string;
      version?: string;
    }>,
  };
}

describe("resolveSessionSkills (prompt parity with CF)", () => {
  it("inlines SKILL.md body in the CF <skill> wrapper, source tagged skill:<id>", async () => {
    const fx = installFixture();
    const { reminders } = await resolveSessionSkills({
      skillConfigs: fx.configs,
      kv: fx.kv,
      blobs: fx.blobs,
      tenantId: TENANT,
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].source).toBe(`skill:${fx.id}`);
    // Byte-parity with CF skills.ts:100 — <skill name="<display_title>">
    expect(reminders[0].text).toBe(`<skill name="Demo Skill">\n${fx.skillMd}\n</skill>`);
  });

  it("falls back to metadata text pointing at the workdir-relative .skills dir", async () => {
    const fx = installFixture({ withSkillMd: false });
    const { reminders } = await resolveSessionSkills({
      skillConfigs: fx.configs,
      kv: fx.kv,
      blobs: fx.blobs,
      tenantId: TENANT,
    });
    expect(reminders[0].text).toBe(
      `[Skill: Demo Skill] A demo. Read ${SKILLS_DIR_BASE}/Demo Skill/SKILL.md for instructions.`,
    );
  });

  it("skips custom skills whose KV metadata is gone (uninstalled)", async () => {
    const { reminders, mounts } = await resolveSessionSkills({
      skillConfigs: [{ skill_id: "skill_ch_ghost_000", type: "custom", version: "1.0.0" }],
      kv: fakeKv({}),
      blobs: fakeBlobs({}),
      tenantId: TENANT,
    });
    expect(reminders).toEqual([]);
    expect(mounts).toEqual([]);
  });

  it("resolves latest_version when the config pins no explicit version", async () => {
    const fx = installFixture();
    const { reminders } = await resolveSessionSkills({
      skillConfigs: [{ skill_id: fx.id, type: "custom" }],
      kv: fx.kv,
      blobs: fx.blobs,
      tenantId: TENANT,
    });
    expect(reminders[0].text).toContain("Do the demo thing.");
  });

  it("orders registered builtin skills before custom ones (CF session-do order)", async () => {
    registerSkill({
      id: "builtin_test_pdf",
      name: "pdf",
      system_prompt_addition: "You can parse PDF files.",
    });
    const fx = installFixture();
    const { reminders } = await resolveSessionSkills({
      skillConfigs: [
        { skill_id: fx.id, type: "custom", version: fx.version },
        { skill_id: "builtin_test_pdf" },
      ],
      kv: fx.kv,
      blobs: fx.blobs,
      tenantId: TENANT,
    });
    expect(reminders.map((r) => r.source)).toEqual([
      "skill:builtin_test_pdf",
      `skill:${fx.id}`,
    ]);
  });
});

describe("resolveSessionSkills (sandbox file mounts)", () => {
  it("mounts manifest files verbatim under <base>/<skill-name>/", async () => {
    const fx = installFixture();
    const { mounts } = await resolveSessionSkills({
      skillConfigs: fx.configs,
      kv: fx.kv,
      blobs: fx.blobs,
      tenantId: TENANT,
    });
    expect(mounts).toHaveLength(1);
    expect(mounts[0].skillName).toBe("demo-skill");
    expect(mounts[0].dir).toBe(`${SKILLS_DIR_BASE}/demo-skill`);
    expect(mounts[0].files.map((f) => f.filename).sort()).toEqual(["SKILL.md", "run.sh"]);
    const run = mounts[0].files.find((f) => f.filename === "run.sh");
    expect(run && Array.from(run.bytes)).toEqual([1, 2, 3]);
  });

  it("carries no mounts when the blob store is unavailable", async () => {
    const fx = installFixture();
    const { mounts, reminders } = await resolveSessionSkills({
      skillConfigs: fx.configs,
      kv: fx.kv,
      blobs: undefined,
      tenantId: TENANT,
    });
    // Prompt falls back to metadata text; no files to mount.
    expect(mounts).toEqual([]);
    expect(reminders[0].text).toContain(`Read ${SKILLS_DIR_BASE}/Demo Skill/SKILL.md`);
  });
});
