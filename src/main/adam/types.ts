// A.D.A.M. — additive shared types for merged systems.
export type FailureClass =
  | 'tool_error'
  | 'dependency_error'
  | 'timeout'
  | 'permission'
  | 'environment_mismatch'
  | 'network_failure'
  | 'application_failure'
  | 'verification_failure'
  | 'malformed_output'
  | 'provider_unavailable';

export type RecoveryAction =
  | 'retry'
  | 'alternative_strategy'
  | 'alternative_tool'
  | 'repair_tool'
  | 'create_tool'
  | 'restart_worker'
  | 'replan';

export interface FailureReport {
  class: FailureClass;
  message: string;
  attempts: number;
  detail?: Record<string, unknown>;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  rationale: string;
}
