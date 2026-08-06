export class EasyNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EasyNotifyError";
  }
}

/** Thrown when a payload fails its Standard Schema. Developer error. */
export class ValidationError extends EasyNotifyError {
  readonly issues: readonly { message: string; path?: string }[];

  constructor(type: string, issues: readonly { message: string; path?: string }[]) {
    super(`Payload for "${type}" failed validation: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Thrown at startup for a malformed config. Never at send time. */
export class ConfigError extends EasyNotifyError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Logger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[easy-notify] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[easy-notify] ${message}`, meta ?? ""),
};
