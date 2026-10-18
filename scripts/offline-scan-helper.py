"""Private, path-free /proc scanner. Invoked only by offline-scan.ts through sudo."""
import errno
import json
import os
import re
import selectors
import sys
import time

MAX_LINE = 8192
MAX_REQUESTS = 64
SESSION_SECONDS = 1800
REQUEST_SECONDS = 30
DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,24})\Z")
NONCE = re.compile(r"[a-f0-9]{64}\Z")


class ScanError(Exception):
    def __init__(self, code="OFFLINE_CHECK_UNAVAILABLE"):
        super().__init__(code)
        self.code = code


def decimal(value):
    return isinstance(value, str) and DECIMAL.fullmatch(value) is not None


def process_identity(proc_root, pid):
    with open(os.path.join(proc_root, str(pid), "status"), "rb") as source:
        status = source.read(65537)
    if len(status) > 65536:
        raise ScanError()
    rows = [line.split()[1:] for line in status.splitlines() if line.startswith(b"Uid:")]
    if len(rows) != 1 or len(rows[0]) != 4 or not all(decimal(v.decode("ascii")) for v in rows[0]):
        raise ScanError()
    with open(os.path.join(proc_root, str(pid), "stat"), "rb") as source:
        value = source.read(8193)
    end = value.rfind(b")")
    fields = value[end + 2:].split()
    if len(value) > 8192 or end < 1 or len(fields) < 20 or not decimal(fields[1].decode("ascii")) or not decimal(fields[19].decode("ascii")):
        raise ScanError()
    return tuple(int(v) for v in rows[0]), int(fields[1]), fields[19].decode("ascii")


def assert_parent(proc_root, parent_pid, parent_start, uid):
    try:
        uids, _, start = process_identity(proc_root, parent_pid)
        if any(value != uid for value in uids) or start != parent_start:
            raise ScanError()
    except (OSError, UnicodeError, ValueError):
        raise ScanError() from None


def assert_ancestor(proc_root, helper_pid, parent_pid):
    pid = helper_pid
    seen = set()
    for _ in range(32):
        if pid == parent_pid:
            return
        if pid <= 1 or pid in seen:
            break
        seen.add(pid)
        try:
            _, pid, _ = process_identity(proc_root, pid)
        except (OSError, UnicodeError, ValueError):
            break
    raise ScanError()


def scan(proc_root, uid, identities, guard=lambda: None):
    """Testable core; production main always supplies literal /proc."""
    try:
        guard()
        for name in os.listdir(proc_root):
            guard()
            if not name.isascii() or not name.isdecimal():
                continue
            try:
                uids, _, _ = process_identity(proc_root, name)
                if uid not in uids:
                    continue
                directory = os.path.join(proc_root, name, "fd")
                for descriptor in os.listdir(directory):
                    guard()
                    try:
                        item = os.stat(os.path.join(directory, descriptor))
                        if (str(item.st_dev), str(item.st_ino)) in identities:
                            raise ScanError("DATABASE_OPEN")
                    except OSError as error:
                        if error.errno != errno.ENOENT:
                            raise ScanError() from None
            except OSError as error:
                if error.errno != errno.ENOENT:
                    raise ScanError() from None
                try:
                    os.stat(os.path.join(proc_root, name))
                except OSError as vanished:
                    if vanished.errno == errno.ENOENT:
                        continue
                    raise ScanError() from None
                raise ScanError()
    except (OSError, UnicodeError, ValueError):
        raise ScanError() from None


def validate_init(message):
    if not isinstance(message, dict) or set(message) != {"version", "type", "sequence", "nonce", "uid", "parentPid", "parentStart"}:
        raise ScanError()
    if type(message["version"]) is not int or message["version"] != 1 or message["type"] != "init" or type(message["sequence"]) is not int or message["sequence"] != 0:
        raise ScanError()
    if not isinstance(message["nonce"], str) or NONCE.fullmatch(message["nonce"]) is None:
        raise ScanError()
    if not decimal(message["uid"]) or int(message["uid"]) <= 0 or not decimal(message["parentPid"]) or int(message["parentPid"]) <= 1 or not decimal(message["parentStart"]):
        raise ScanError()
    return message


def validate_request(message, nonce, sequence):
    if not isinstance(message, dict) or message.get("nonce") != nonce or type(message.get("sequence")) is not int or message["sequence"] != sequence:
        raise ScanError()
    if message.get("type") == "close" and set(message) == {"type", "nonce", "sequence"}:
        return None
    if message.get("type") != "scan" or set(message) != {"type", "nonce", "sequence", "identities"}:
        raise ScanError()
    identities = message["identities"]
    if not isinstance(identities, list) or len(identities) > 8:
        raise ScanError()
    result = set()
    for item in identities:
        if not isinstance(item, dict) or set(item) != {"dev", "ino"} or not decimal(item["dev"]) or not decimal(item["ino"]):
            raise ScanError()
        result.add((item["dev"], item["ino"]))
    if len(result) != len(identities):
        raise ScanError()
    return result


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ScanError()
        result[key] = value
    return result


def main():
    # No arguments, environment-selected proc root, arbitrary commands, or files.
    selector = None
    buffer = b""
    nonce = None
    sequence = 0
    parent = None
    try:
        if len(sys.argv) != 1:
            return 1
        selector = selectors.DefaultSelector()
        selector.register(sys.stdin.buffer, selectors.EVENT_READ)
        started = time.monotonic()
        while sequence <= MAX_REQUESTS:
            deadline = min(started + SESSION_SECONDS, time.monotonic() + REQUEST_SECONDS) if buffer and parent is not None else started + SESSION_SECONDS if parent is not None else started + 15
            while b"\n" not in buffer:
                if time.monotonic() >= deadline:
                    raise ScanError()
                if parent is not None:
                    assert_parent("/proc", *parent)
                if selector.select(min(1, max(0, deadline - time.monotonic()))):
                    chunk = os.read(sys.stdin.fileno(), MAX_LINE + 1)
                    if not chunk:
                        return 0
                    if not buffer and parent is not None:
                        deadline = min(started + SESSION_SECONDS, time.monotonic() + REQUEST_SECONDS)
                    buffer += chunk
                    if len(buffer) > MAX_LINE:
                        raise ScanError()
            line, buffer = buffer.split(b"\n", 1)
            message = json.loads(line, object_pairs_hook=unique_object)
            if nonce is None:
                message = validate_init(message)
                nonce = message["nonce"]
                uid = int(message["uid"])
                if os.geteuid() != 0 or os.environ.get("SUDO_UID") != str(uid):
                    raise ScanError("AUTH_REQUIRED")
                parent = (int(message["parentPid"]), message["parentStart"], uid)
                assert_parent("/proc", *parent)
                assert_ancestor("/proc", os.getpid(), parent[0])
            else:
                assert_parent("/proc", *parent)
                identities = validate_request(message, nonce, sequence)
                if identities is None:
                    print(json.dumps({"version": 1, "nonce": nonce, "sequence": sequence, "code": "OK"}), flush=True)
                    return 0
                deadline = min(started + SESSION_SECONDS, time.monotonic() + REQUEST_SECONDS)
                def guard():
                    if time.monotonic() >= deadline:
                        raise ScanError()
                    assert_parent("/proc", *parent)
                scan("/proc", parent[2], identities, guard)
                assert_parent("/proc", *parent)
            print(json.dumps({"version": 1, "nonce": nonce, "sequence": sequence, "code": "OK"}), flush=True)
            sequence += 1
    except BaseException as error:
        # Fixed codes only; never include exception messages, proc paths or data.
        code = error.code if isinstance(error, ScanError) else "OFFLINE_CHECK_UNAVAILABLE"
        if nonce is not None:
            try:
                print(json.dumps({"version": 1, "nonce": nonce, "sequence": sequence, "code": code}), flush=True)
            except BaseException:
                pass
        return 1
    finally:
        if selector is not None:
            try:
                selector.close()
            except BaseException:
                return 1
    return 1


if __name__ == "__main__":
    try:
        result = main()
    except BaseException:
        result = 1
    sys.exit(result)
