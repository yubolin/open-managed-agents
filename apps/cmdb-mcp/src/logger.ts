export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export class Logger {
  private threshold: number;

  constructor(level: LogLevel = "info") {
    this.threshold = LEVEL_WEIGHTS[level] ?? 30;
  }

  setLevel(level: LogLevel) {
    this.threshold = LEVEL_WEIGHTS[level] ?? 30;
  }

  private log(level: LogLevel, data: Record<string, unknown>, msg: string) {
    const weight = LEVEL_WEIGHTS[level];
    if (weight < this.threshold) return;

    // Sanitize any accidental credential leaks
    const safeData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      const lk = k.toLowerCase();
      if (lk.includes("token") || lk.includes("auth") || lk.includes("secret") || lk.includes("password")) {
        safeData[k] = "[REDACTED]";
      } else {
        safeData[k] = v;
      }
    }

    const payload = {
      level: weight,
      time: Date.now(),
      service: "cmdb-mcp",
      ...safeData,
      msg,
    };

    const str = JSON.stringify(payload);
    if (weight >= 40) {
      process.stderr.write(str + "\n");
    } else {
      process.stdout.write(str + "\n");
    }
  }

  debug(data: Record<string, unknown>, msg: string) {
    this.log("debug", data, msg);
  }

  info(data: Record<string, unknown>, msg: string) {
    this.log("info", data, msg);
  }

  warn(data: Record<string, unknown>, msg: string) {
    this.log("warn", data, msg);
  }

  error(data: Record<string, unknown>, msg: string) {
    this.log("error", data, msg);
  }
}

export const defaultLogger = new Logger("info");
