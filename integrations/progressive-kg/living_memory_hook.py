#!/usr/bin/env python3
"""Living Memory managed hook v1. Calls the shared CLI after a successful KG workflow."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description="成功完成 KG 操作后刷新 Living Memory；不会确认重温。")
    parser.add_argument("operation", choices=("query", "ingest", "consolidate"))
    parser.add_argument("--operation-id", required=True, help="本次成功操作的 ID，重试复用同一 ID")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    config_path = root / "_system" / "living-memory.local.json"
    if not config_path.exists():
        print(json.dumps({"status": "skipped", "reason": "Living Memory 未在本机配置"}, ensure_ascii=False))
        return 0
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        project = Path(config["projectRoot"]).resolve(strict=True)
        if not (project / "src" / "cli" / "index.ts").is_file():
            raise ValueError("Living Memory CLI 不存在，请重新安装接入配置")
        command = [
            "npm", "--prefix", str(project), "run", "--silent", "lm", "--",
            "after", args.operation, "--operation-id", args.operation_id,
            "--source-root", str(root), "--url", config["serverUrl"],
        ]
        result = subprocess.run(command, cwd=project, timeout=45, check=False)
        return result.returncode
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": {"code": "HOOK_FAILED", "message": str(error)},
                          "operationId": args.operation_id,
                          "hint": "保留原知识操作结果；服务恢复后使用同一 operation-id 重试刷新。"},
                         ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
