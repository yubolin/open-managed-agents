// Tiny structured JSON logger (stdout). No external dep — keeps the spike
// self-contained and its output greppable / pipeable.

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export function createLogger(level: Level = "info"): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: Level, obj: Record<string, unknown>, msg?: string): void => {
    if (ORDER[lvl] < threshold) return;
    const payload = { level: lvl, ts: Date.now(), ...obj, ...(msg ? { msg } : {}) };
    process.stdout.write(JSON.stringify(payload) + "\n");
  };
  return {
    debug: (o, m) => emit("debug", o, m),
    info: (o, m) => emit("info", o, m),
    warn: (o, m) => emit("warn", o, m),
    error: (o, m) => emit("error", o, m),
  };
}

export function errToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
