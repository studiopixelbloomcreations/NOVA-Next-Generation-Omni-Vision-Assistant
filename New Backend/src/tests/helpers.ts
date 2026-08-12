// Test helper — points the backend at the real python_runtime package even
// when a test chdir's into an isolated temp data directory. The backend
// resolves its runtime root from cwd for the real app; tests override it via
// the environment so the isolated data dir does not mask the interpreter.
import { fileURLToPath } from 'node:url';

/** Absolute path to New Backend/python_runtime, relative to this compiled file
 * (dist/tests/helpers.js -> ../../ = New Backend). */
export function pythonRuntimeRoot(): string {
  return fileURLToPath(new URL('../../python_runtime', import.meta.url));
}

/** Sets NOVA2_PYTHON_RUNTIME_ROOT so the bridge finds the real runtime. */
export function pointToPythonRuntime(): void {
  process.env.NOVA2_PYTHON_RUNTIME_ROOT = pythonRuntimeRoot();
}
