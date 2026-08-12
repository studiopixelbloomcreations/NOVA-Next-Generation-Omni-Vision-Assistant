"""NOVA New Backend — Python runtime.

Self-contained, stdlib-only Python services for the New Backend:
  * sandbox  — run a generated tool's tests in an ISOLATED temp-dir subprocess
               with a scrubbed environment and a hard timeout (validation only).
  * runtool  — execute a REGISTERED tool's run(params) in production against
               the real machine.
  * system   — real host/OS/environment introspection.
  * fs       — directory analysis (largest files, listing, stats).

The sandbox is only for validation. Production execution is explicit through
the approved runtime and NEVER runs untested code.
"""
