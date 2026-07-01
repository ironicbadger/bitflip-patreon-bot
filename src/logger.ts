import type { LogLevel } from "./types";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, context?: unknown): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: unknown): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: unknown): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: unknown): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: unknown): void {
    if (order[level] < order[this.level]) {
      return;
    }

    const entry = {
      level,
      time: new Date().toISOString(),
      message,
      ...(context === undefined ? {} : { context })
    };

    const serialized = JSON.stringify(entry);
    if (level === "error") {
      console.error(serialized);
      return;
    }
    if (level === "warn") {
      console.warn(serialized);
      return;
    }
    console.log(serialized);
  }
}
