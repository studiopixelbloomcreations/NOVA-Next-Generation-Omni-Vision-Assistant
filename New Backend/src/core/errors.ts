// New Backend — core/errors.ts
// Typed error hierarchy. Every engine raises structured errors so the
// Recovery Engine can classify failures without string matching.

import type { FailureClass } from '../contracts/domain.js';

export class NovaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NovaError';
    this.code = code;
  }
}

export class NovaFailureError extends NovaError {
  readonly failureClass: FailureClass;
  constructor(failureClass: FailureClass, message: string, code = 'nova.failure') {
    super(code, message);
    this.name = 'NovaFailureError';
    this.failureClass = failureClass;
  }
}

export class ProviderUnavailableError extends NovaFailureError {
  constructor(message: string) {
    super('provider_unavailable', message, 'nova.provider.unavailable');
    this.name = 'ProviderUnavailableError';
  }
}

export class ValidationBlockError extends NovaFailureError {
  constructor(message: string) {
    super('permission', message, 'nova.validation.block');
    this.name = 'ValidationBlockError';
  }
}

export class PathEscapeError extends NovaFailureError {
  constructor(message: string) {
    super('permission', message, 'nova.security.path');
    this.name = 'PathEscapeError';
  }
}

export class ToolExecutionFailureError extends NovaFailureError {
  constructor(message: string) {
    super('tool_error', message, 'nova.tool.execution');
    this.name = 'ToolExecutionFailureError';
  }
}

export class SandboxTestFailureError extends NovaFailureError {
  constructor(message: string) {
    super('tool_error', message, 'nova.forge.sandbox');
    this.name = 'SandboxTestFailureError';
  }
}

export class PlanEmptyError extends NovaFailureError {
  constructor() {
    super('malformed_output', 'planner returned an empty executable plan', 'nova.plan.empty');
    this.name = 'PlanEmptyError';
  }
}

export function toNovaError(err: unknown): NovaError {
  if (err instanceof NovaError) return err;
  if (err instanceof Error) return new NovaError('nova.generic', err.message);
  return new NovaError('nova.generic', String(err));
}

/** Best-effort failure classification for the Recovery Engine. */
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof NovaFailureError) return err.failureClass;
  const message = err instanceof Error ? err.message : String(err);
  const m = message.toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
  if (m.includes('permission') || m.includes('denied') || m.includes('not permitted')) return 'permission';
  if (m.includes('network') || m.includes('fetch') || m.includes('socket') || m.includes('econnrefused') || m.includes('enotfound') || m.includes('api error')) return 'network_failure';
  if (m.includes('not configured') || m.includes('unavailable') || m.includes('api key')) return 'provider_unavailable';
  if (m.includes('module') || m.includes('import') || m.includes('dependency') || m.includes('package')) return 'dependency_error';
  if (m.includes('verif')) return 'verification_failure';
  if (m.includes('json') || m.includes('parse') || m.includes('malformed')) return 'malformed_output';
  if (m.includes('environment') || m.includes('platform') || m.includes('windows')) return 'environment_mismatch';
  return 'tool_error';
}
