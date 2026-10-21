#!/usr/bin/env python3
"""Living Memory managed hook v2. Calls the shared CLI after a successful KG workflow."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit


def valid_text(value):
    return (isinstance(value, str) and bool(value.strip())
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def read_config(config_path):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if (not isinstance(config, dict) or not valid_text(config.get("projectRoot"))
            or not Path(config["projectRoot"]).is_absolute()):
        raise ValueError()
    if not valid_text(config.get("serverUrl")):
        raise ValueError()
    url = urlsplit(config["serverUrl"])
    if (url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1", "::1")
            or url.username is not None or url.password is not None
            or url.query or url.fragment or url.path not in ("", "/")):
        raise ValueError()
    # Validate malformed and out-of-range ports without connecting.
    _ = url.port
    if "version" not in config:
        if set(config) != {"projectRoot", "serverUrl"}:
            raise ValueError()
    else:
        if (type(config["version"]) is not int or config["version"] != 2
                or set(config) != {"version", "projectRoot", "serverUrl", "dataDir", "cliStateDir"}):
            raise ValueError()
        for key in ("dataDir", "cliStateDir"):
            if not valid_text(config[key]) or not Path(config[key]).is_absolute():
                raise ValueError()
    return config


def main():
    parser = argparse.ArgumentParser(description="成功完成 KG 操作后刷新 Living Memory；不会确认重温。")
    parser.add_argument("operation", choices=("query", "ingest", "consolidate"))
    parser.add_argument("--operation-id", required=True, help="本次成功操作的 ID，重试复用同一 ID")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    config_path = root / "_system" / "living-memory.local.json"
    if not config_path.exists() and not config_path.is_symlink():
        print(json.dumps({"status": "skipped", "reason": "Living Memory 未在本机配置"}, ensure_ascii=False))
        return 0
    try:
        config = read_config(config_path)
        project = Path(config["projectRoot"]).resolve(strict=True)
        if not (project / "src" / "cli" / "index.ts").is_file():
            raise ValueError("Living Memory CLI 不存在，请重新安装接入配置")
        command = [
            "npm", "--prefix", str(project), "run", "--silent", "lm", "--",
            "after", args.operation, "--operation-id", args.operation_id,
            "--source-root", str(root), "--url", config["serverUrl"],
        ]
        env = os.environ.copy()
        if config.get("version") == 2:
            env.update({"LM_DATA_DIR": config["dataDir"],
                        "LM_CLI_SESSION_FILE": str(Path(config["dataDir"]) / "cli-session.json"),
                        "LM_CLI_STATE_DIR": config["cliStateDir"]})
            command.extend(["--state-dir", config["cliStateDir"]])
        result = subprocess.run(command, cwd=project, env=env, timeout=45, check=False)
        return result.returncode
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.TimeoutExpired):
        print(json.dumps({"error": {"code": "HOOK_FAILED", "message": "钩子配置或执行失败，请核对本机配置和 CLI；不会回退到其他实例。"},
                          "operationId": args.operation_id,
                          "hint": "保留原知识操作结果；服务恢复后使用同一 operation-id 重试刷新。"},
                         ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
