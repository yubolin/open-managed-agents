// Skill read-path — Node mirror of CF session-do.ts:4417-4489.
//
// SessionRegistry.build() calls resolveSessionSkills() once with the
// frozen agent snapshot's skills and freezes the result into the
// machine's buildHarnessContext closure — same lifecycle constraint as
// memory reminders (reminders can never drift from what was provisioned;
// attach_skill already returns new_session_required).
//
// Parity invariants:
//   - Reminder format: source `skill:<id>`, body either the resolved
//     system_prompt_addition (builtin) or CF's `<skill name="…">` wrapper
//     around the inlined SKILL.md (custom) — byte-identical to what CF's
//     composeSystemPrompt wraps in <source name="…"> blocks.
//   - Ordering: builtin skills first, then custom (session-do.ts:4419-
//     4434). The registry appends memory reminders AFTER these; CF's
//     appendable prompts (pushed first on CF) are a known Node gap.
//   - Mount base: CF writes /home/user/.skills inside its microVM. Node
//     local-subprocess sandboxes run on the host FS where an absolute
//     /home/user path would escape the workdir jail, so skills mount
//     workdir-relative instead. The metadata-fallback reminder text uses
//     the same base so the model reads a path that actually exists.
//
// All failure modes are best-effort per skill (mirrors CF): a skill that
// fails to resolve is skipped, never fails the session build.

import {
  getSkillFiles,
  resolveCustomSkills,
  resolveSkills,
  type SkillBucketLike,
  type SkillKvLike,
} from "@open-managed-agents/agent/harness/skills";

export type { SkillBucketLike, SkillKvLike };

/** Workdir-relative mount base — see module comment. */
export const SKILLS_DIR_BASE = ".skills";

export interface SkillReminder {
  source: string;
  text: string;
}

export interface SkillFileMount {
  skillName: string;
  /** Sandbox-visible directory (workdir-relative on Node) for the files. */
  dir: string;
  files: Array<{ filename: string; bytes: Uint8Array }>;
}

export interface SkillSessionResult {
  /** Prompt reminders, source `skill:<id>` — caller merges with memory
   *  reminders (skills first, memory after) before composeSystemPrompt. */
  reminders: SkillReminder[];
  /** Custom skill files for the caller to write into the sandbox
   *  (progressive disclosure). Builtin skills carry no files. */
  mounts: SkillFileMount[];
}

export interface SkillSessionArgs {
  skillConfigs: ReadonlyArray<{ skill_id: string; type?: string; version?: string }>;
  kv: SkillKvLike;
  blobs: SkillBucketLike | undefined;
  tenantId: string;
  skillsDirBase?: string;
}

/** Resolve agent.skills → prompt reminders + sandbox file mounts. */
export async function resolveSessionSkills(args: SkillSessionArgs): Promise<SkillSessionResult> {
  const base = args.skillsDirBase ?? SKILLS_DIR_BASE;
  const configs = [...(args.skillConfigs ?? [])];
  const reminders: SkillReminder[] = [];

  // Built-in skills from the in-memory registry (resolveSkills skips
  // unregistered ids — empty registry ⇒ no-op, matching CF today).
  for (const s of resolveSkills(configs)) {
    if (s.system_prompt_addition) {
      reminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
    }
  }

  // Custom skills: metadata from KV, SKILL.md inlined from the blob store
  // (falls back to a metadata-only pointer at the mount base).
  const custom = await resolveCustomSkills(configs, args.kv, args.blobs, args.tenantId, {
    skillsDirBase: base,
  });
  for (const s of custom) {
    if (s.system_prompt_addition) {
      reminders.push({ source: `skill:${s.id}`, text: s.system_prompt_addition });
    }
  }

  // Files for the sandbox mount (custom only).
  const mounts: SkillFileMount[] = [];
  for (const sf of await getSkillFiles(configs, args.kv, args.blobs, args.tenantId)) {
    mounts.push({ skillName: sf.skillName, dir: `${base}/${sf.skillName}`, files: sf.files });
  }

  return { reminders, mounts };
}
