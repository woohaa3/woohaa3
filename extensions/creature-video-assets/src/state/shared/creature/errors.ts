export const EXIT_CODES = {
  success: 0,
  validation: 2,
  blocked: 3,
  remoteFailed: 4,
  submitUnknown: 5,
  concurrency: 6,
  tooling: 7,
  security: 8,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CreatureVideoError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, exitCode: ExitCode, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CreatureVideoError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class ValidationError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('validation_failed', message, EXIT_CODES.validation, details);
    this.name = 'ValidationError';
  }
}

export class IllegalTransitionError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('illegal_transition', message, EXIT_CODES.validation, details);
    this.name = 'IllegalTransitionError';
  }
}

export class BlockedError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('blocked', message, EXIT_CODES.blocked, details);
    this.name = 'BlockedError';
  }
}

export class RemoteOperationError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('remote_failed', message, EXIT_CODES.remoteFailed, details);
    this.name = 'RemoteOperationError';
  }
}

export class SubmitUnknownError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('submit_unknown', message, EXIT_CODES.submitUnknown, details);
    this.name = 'SubmitUnknownError';
  }
}

export class ConcurrencyError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('concurrency_conflict', message, EXIT_CODES.concurrency, details);
    this.name = 'ConcurrencyError';
  }
}

export class ToolingError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('tooling_missing', message, EXIT_CODES.tooling, details);
    this.name = 'ToolingError';
  }
}

export class SecurityError extends CreatureVideoError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('security_violation', message, EXIT_CODES.security, details);
    this.name = 'SecurityError';
  }
}

export function exitCodeOf(error: unknown): ExitCode {
  return error instanceof CreatureVideoError ? error.exitCode : EXIT_CODES.tooling;
}
