"""CLI entry point: `python -m nova_runtime --stdio`."""
import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="nova_runtime", description="NOVA Python backend worker")
    parser.add_argument(
        "--stdio",
        action="store_true",
        help="run as a persistent JSON-RPC worker over stdin/stdout",
    )
    parser.add_argument(
        "--ping",
        action="store_true",
        help="print a one-line JSON status and exit (used by the TS bridge to probe)",
    )
    args = parser.parse_args()

    if args.ping:
        from nova_runtime.services.system import system_info

        import json

        print(json.dumps({"ok": True, "novaRuntime": "1.0.0", "system": system_info()}))
        return 0

    if args.stdio:
        from nova_runtime.runtime.worker import run_stdio_worker

        return run_stdio_worker()

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
