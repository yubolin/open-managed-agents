// Memory store platform reminders — Node mirror of CF session-do.ts:4419-4461.
//
// Task 2 (§3.8): the system prompt must describe exactly the mounts the
// sandbox actually got. CRITICAL lifecycle constraint (P1 review):
// SessionRegistry provisions mounts ONCE in build() and caches the
// machine forever — there is no remount path. Reminders are therefore
// derived from the SAME resolved mount list build() provisions and
// frozen into the machine's deps closure at build time. We never re-read
// session_memory_stores per turn: bindings added or access modes changed
// after first build are rejected with 409 by the binding routes, so the
// frozen snapshot can never drift from reality.
//
// Format parity with CF:
//   ## Memory store: <name>
//   Mounted at /mnt/memory/<name>/ (read-write | read-only)
//   [description]
//   (read-only mount — write attempts to this directory will fail)   ← read_only only
// Source tag: `memory:<store_id>`.
//
// Note: Node's `session_memory_stores` has no `instructions` column (CF's
// session resources do), so the mirror omits that line by design.

/** Resolved mount as built by SessionRegistry.build() — one entry per
 *  actually-provisioned mount (missing stores are already filtered). */
export interface ResolvedMemoryMount {
  storeId: string;
  storeName: string;
  /** Store description at bind time — rendered into the reminder. */
  description?: string | null;
  readOnly: boolean;
}

export interface MemoryReminder {
  source: string;
  text: string;
}

/** Pure transform: resolved mounts → platform reminders. Because the
 *  input is the mount list the orchestrator provisioned, the prompt can
 *  never describe a mount that isn't there (or vice versa). */
export function remindersFromMounts(mounts: ReadonlyArray<ResolvedMemoryMount>): MemoryReminder[] {
  const reminders: MemoryReminder[] = [];
  for (const mount of mounts) {
    const accessLabel = mount.readOnly ? "read-only" : "read-write";
    const lines = [
      `## Memory store: ${mount.storeName}`,
      `Mounted at /mnt/memory/${mount.storeName}/ (${accessLabel})`,
    ];
    if (mount.description) lines.push(mount.description);
    if (mount.readOnly) {
      lines.push("(read-only mount — write attempts to this directory will fail)");
    }
    reminders.push({ source: `memory:${mount.storeId}`, text: lines.join("\n") });
  }
  return reminders;
}
