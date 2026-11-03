#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp_path, path)


def read_json(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def update_status(
    status_file: Path,
    state: str,
    pid: Optional[int],
    raw_bytes: int,
    raw_files: int,
    last_growth_ts: float,
    restarts: int,
    now_ts: float,
    detail: str = "",
) -> bool:
    current = read_json(status_file)
    if current is not None and current.get("state") == state:
        return False
    payload = {
        "state": state,
        "pid": pid,
        "raw_bytes": raw_bytes,
        "raw_files": raw_files,
        "last_growth_ts": last_growth_ts,
        "restarts": restarts,
        "updated_ts": now_ts,
        "detail": detail,
    }
    atomic_write_json(status_file, payload)
    return True


def compute_raw_signature(raw_dir: Path) -> Tuple[int, int, float]:
    total_bytes = 0
    file_count = 0
    newest_mtime = 0.0
    if not raw_dir.exists():
        return (0, 0, 0.0)
    for root, _, files in os.walk(raw_dir, onerror=lambda _: None):
        for name in files:
            p = os.path.join(root, name)
            try:
                st = os.stat(p, follow_symlinks=False)
                total_bytes += st.st_size
                file_count += 1
                if st.st_mtime > newest_mtime:
                    newest_mtime = st.st_mtime
            except OSError:
                continue
    return (total_bytes, file_count, newest_mtime)


def snapshot_finished_files(raw_dir: Path) -> Dict[str, int]:
    snap: Dict[str, int] = {}
    if not raw_dir.exists():
        return snap
    for root, _, files in os.walk(raw_dir, onerror=lambda _: None):
        for name in files:
            if name.endswith(".csv") or name.endswith(".rows"):
                full_path = Path(root) / name
                rel_path = str(full_path.relative_to(raw_dir))
                try:
                    snap[rel_path] = full_path.stat().st_size
                except OSError:
                    continue
    return snap


def verify_no_loss(before: Dict[str, int], after: Dict[str, int]) -> List[str]:
    issues: List[str] = []
    for rel_path, old_size in sorted(before.items()):
        if rel_path not in after:
            issues.append(rel_path)
        elif after[rel_path] < old_size:
            issues.append(rel_path)
    return issues


def default_find_pid() -> Optional[int]:
    proc = Path("/proc")
    if not proc.exists():
        return None
    my_pid = os.getpid()
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == my_pid:
            continue
        try:
            cmdline_bytes = (entry / "cmdline").read_bytes()
            cmdline = cmdline_bytes.replace(b"\x00", b" ").decode("utf-8", errors="ignore")
            if "onestore.py" in cmdline and "fetch-gaia" in cmdline:
                return pid
        except OSError:
            continue
    return None


def default_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    proc_stat = Path(f"/proc/{pid}/stat")
    if proc_stat.exists():
        try:
            content = proc_stat.read_text(encoding="utf-8", errors="ignore")
            rparen = content.rfind(")")
            if rparen != -1 and len(content) > rparen + 2:
                state_char = content[rparen + 2]
                if state_char == "Z":
                    return False
        except OSError:
            pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def default_kill_process(
    pid: int,
    is_alive_fn: Callable[[int], bool] = default_is_alive,
    sleep_fn: Callable[[float], None] = time.sleep,
    wait_seconds: float = 60.0,
) -> None:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    elapsed = 0.0
    step = 0.5
    while elapsed < wait_seconds:
        if not is_alive_fn(pid):
            return
        sleep_fn(step)
        elapsed += step
    if is_alive_fn(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def default_spawn_process(build_dir: Path, python_bin: str, fetch_args: str) -> int:
    build_dir.mkdir(parents=True, exist_ok=True)
    log_path = build_dir / "fetch-gaia.watchdog.log"
    onestore_script = "onestore.py"
    if not (build_dir / "onestore.py").exists() and (build_dir.parent / "onestore.py").exists():
        onestore_script = str(build_dir.parent / "onestore.py")
    cmd = [python_bin, onestore_script, "fetch-gaia"] + shlex.split(fetch_args)
    with open(log_path, "ab") as log_f:
        proc = subprocess.Popen(
            cmd,
            cwd=str(build_dir),
            stdout=log_f,
            stderr=log_f,
            start_new_session=True,
        )
        return proc.pid


def sha256_file(path: Path) -> Tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def run_offload(
    build_dir: Path,
    drive_dir: Optional[Path],
    approval_file: Path,
    status_file: Path,
    offload_free: bool = False,
    dry_run: bool = False,
    now_fn: Callable[[], float] = time.time,
) -> int:
    now_ts = now_fn()
    raw_dir = build_dir / "raw"
    raw_bytes, raw_files, _ = compute_raw_signature(raw_dir)
    sidecar_path = Path(f"{status_file}.state")
    sidecar = read_json(sidecar_path) or {}
    restarts = int(sidecar.get("restarts", 0))
    last_growth_ts = float(sidecar.get("last_growth_ts", now_ts))

    if not approval_file.exists():
        update_status(
            status_file=status_file,
            state="offload_refused",
            pid=None,
            raw_bytes=raw_bytes,
            raw_files=raw_files,
            last_growth_ts=last_growth_ts,
            restarts=restarts,
            now_ts=now_ts,
            detail=f"Approval file missing: {approval_file}",
        )
        return 1

    if drive_dir is None:
        update_status(
            status_file=status_file,
            state="offload_refused",
            pid=None,
            raw_bytes=raw_bytes,
            raw_files=raw_files,
            last_growth_ts=last_growth_ts,
            restarts=restarts,
            now_ts=now_ts,
            detail="--drive-dir is required for offload",
        )
        return 1

    gaia_dir = raw_dir / "gaia"
    search_dir = gaia_dir if gaia_dir.exists() else raw_dir
    offloaded_count = 0

    if search_dir.exists():
        drive_dir.mkdir(parents=True, exist_ok=True)
        for csv_path in sorted(search_dir.rglob("r_*.csv")):
            if not csv_path.is_file():
                continue
            rows_path = csv_path.with_suffix(".rows")
            tmp_csv_path = csv_path.with_name(csv_path.name + ".tmp")
            if not rows_path.exists() or tmp_csv_path.exists():
                continue

            dest_path = drive_dir / csv_path.name
            tmp_dest_path = drive_dir / f"{csv_path.name}.{os.getpid()}.tmp"
            marker_path = csv_path.with_suffix(".offloaded")

            if dry_run:
                offloaded_count += 1
                continue

            shutil.copy2(csv_path, tmp_dest_path)
            os.replace(tmp_dest_path, dest_path)

            src_sha, src_size = sha256_file(csv_path)
            dst_sha, dst_size = sha256_file(dest_path)

            if src_size != dst_size or src_sha != dst_sha:
                raise RuntimeError(f"Offload verification failed for {csv_path}")

            marker_data = {
                "sha256": src_sha,
                "size": src_size,
                "dest": str(dest_path),
            }
            atomic_write_json(marker_path, marker_data)

            if offload_free:
                csv_path.unlink()

            offloaded_count += 1

    raw_bytes, raw_files, _ = compute_raw_signature(raw_dir)
    update_status(
        status_file=status_file,
        state="offload_done",
        pid=None,
        raw_bytes=raw_bytes,
        raw_files=raw_files,
        last_growth_ts=last_growth_ts,
        restarts=restarts,
        now_ts=now_ts,
        detail=f"Offloaded {offloaded_count} files",
    )
    return 0


def check_once(
    build_dir: Path,
    status_file: Path,
    stall_minutes: float = 30.0,
    pid: Optional[int] = None,
    dry_run: bool = False,
    python_bin: str = "../.venv/bin/python",
    fetch_args: str = "--chunks 768 --parallel 4",
    now_fn: Callable[[], float] = time.time,
    find_pid_fn: Callable[[], Optional[int]] = default_find_pid,
    is_alive_fn: Callable[[int], bool] = default_is_alive,
    kill_fn: Callable[[int], None] = default_kill_process,
    spawn_fn: Callable[[Path, str, str], int] = default_spawn_process,
) -> dict:
    now_ts = now_fn()
    raw_dir = build_dir / "raw"
    raw_bytes, raw_files, newest_mtime = compute_raw_signature(raw_dir)
    signature = [raw_bytes, raw_files, newest_mtime]

    sidecar_path = Path(f"{status_file}.state")
    sidecar = read_json(sidecar_path) or {}
    prev_sig = sidecar.get("signature")
    restarts = int(sidecar.get("restarts", 0))

    if prev_sig != signature or "last_growth_ts" not in sidecar:
        last_growth_ts = now_ts
    else:
        last_growth_ts = float(sidecar["last_growth_ts"])

    resolved_pid = pid if pid is not None else find_pid_fn()
    alive = resolved_pid is not None and is_alive_fn(resolved_pid)

    if not alive:
        state = "not_running"
        detail = "Fetch process is not running"
        active_pid = None
        atomic_write_json(
            sidecar_path,
            {
                "signature": signature,
                "last_growth_ts": last_growth_ts,
                "restarts": restarts,
                "updated_ts": now_ts,
            },
        )
        update_status(
            status_file=status_file,
            state=state,
            pid=active_pid,
            raw_bytes=raw_bytes,
            raw_files=raw_files,
            last_growth_ts=last_growth_ts,
            restarts=restarts,
            now_ts=now_ts,
            detail=detail,
        )
        return {
            "state": state,
            "pid": active_pid,
            "raw_bytes": raw_bytes,
            "raw_files": raw_files,
            "last_growth_ts": last_growth_ts,
            "restarts": restarts,
            "loss": [],
        }

    stall_seconds = stall_minutes * 60.0
    is_stalled = (now_ts - last_growth_ts) >= stall_seconds

    if not is_stalled:
        state = "running"
        detail = "Process running normally"
        atomic_write_json(
            sidecar_path,
            {
                "signature": signature,
                "last_growth_ts": last_growth_ts,
                "restarts": restarts,
                "updated_ts": now_ts,
            },
        )
        update_status(
            status_file=status_file,
            state=state,
            pid=resolved_pid,
            raw_bytes=raw_bytes,
            raw_files=raw_files,
            last_growth_ts=last_growth_ts,
            restarts=restarts,
            now_ts=now_ts,
            detail=detail,
        )
        return {
            "state": state,
            "pid": resolved_pid,
            "raw_bytes": raw_bytes,
            "raw_files": raw_files,
            "last_growth_ts": last_growth_ts,
            "restarts": restarts,
            "loss": [],
        }

    if dry_run:
        state = "stalled"
        detail = f"Stalled for >= {stall_minutes} minutes (dry-run)"
        atomic_write_json(
            sidecar_path,
            {
                "signature": signature,
                "last_growth_ts": last_growth_ts,
                "restarts": restarts,
                "updated_ts": now_ts,
            },
        )
        update_status(
            status_file=status_file,
            state=state,
            pid=resolved_pid,
            raw_bytes=raw_bytes,
            raw_files=raw_files,
            last_growth_ts=last_growth_ts,
            restarts=restarts,
            now_ts=now_ts,
            detail=detail,
        )
        return {
            "state": state,
            "pid": resolved_pid,
            "raw_bytes": raw_bytes,
            "raw_files": raw_files,
            "last_growth_ts": last_growth_ts,
            "restarts": restarts,
            "loss": [],
        }

    update_status(
        status_file=status_file,
        state="stalled",
        pid=resolved_pid,
        raw_bytes=raw_bytes,
        raw_files=raw_files,
        last_growth_ts=last_growth_ts,
        restarts=restarts,
        now_ts=now_ts,
        detail=f"Stalled for >= {stall_minutes} minutes; restarting",
    )

    before_snap = snapshot_finished_files(raw_dir)
    kill_fn(resolved_pid)
    new_pid = spawn_fn(build_dir, python_bin, fetch_args)
    after_snap = snapshot_finished_files(raw_dir)
    loss = verify_no_loss(before_snap, after_snap)

    restarts += 1
    last_growth_ts = now_ts
    state = "restarted"
    detail = f"Restarted pid {resolved_pid} -> {new_pid}"
    if loss:
        detail += f" (WARNING: data loss detected: {loss})"

    atomic_write_json(
        sidecar_path,
        {
            "signature": signature,
            "last_growth_ts": last_growth_ts,
            "restarts": restarts,
            "updated_ts": now_ts,
        },
    )
    update_status(
        status_file=status_file,
        state=state,
        pid=new_pid,
        raw_bytes=raw_bytes,
        raw_files=raw_files,
        last_growth_ts=last_growth_ts,
        restarts=restarts,
        now_ts=now_ts,
        detail=detail,
    )
    return {
        "state": state,
        "pid": new_pid,
        "raw_bytes": raw_bytes,
        "raw_files": raw_files,
        "last_growth_ts": last_growth_ts,
        "restarts": restarts,
        "loss": loss,
    }


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GAIA fetch watchdog and Drive offloader")
    parser.add_argument("--build-dir", type=Path, default=Path("/workspace/staris-onestore/build"))
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--stall-minutes", type=float, default=30.0)
    parser.add_argument("--poll-seconds", type=float, default=60.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--python", dest="python_bin", default="../.venv/bin/python")
    parser.add_argument("--fetch-args", default="--chunks 768 --parallel 4")
    parser.add_argument("--status-file", type=Path, default=Path("/workspace/status/gaia-watchdog.json"))
    parser.add_argument("--offload-drive", action="store_true", default=False)
    parser.add_argument("--offload-free", action="store_true", default=False)
    parser.add_argument("--approval-file", type=Path, default=Path("/workspace/status/gaia-offload-approved"))
    parser.add_argument("--drive-dir", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.offload_drive:
        return run_offload(
            build_dir=args.build_dir,
            drive_dir=args.drive_dir,
            approval_file=args.approval_file,
            status_file=args.status_file,
            offload_free=args.offload_free,
            dry_run=args.dry_run,
        )

    current_pid = args.pid
    while True:
        res = check_once(
            build_dir=args.build_dir,
            status_file=args.status_file,
            stall_minutes=args.stall_minutes,
            pid=current_pid,
            dry_run=args.dry_run,
            python_bin=args.python_bin,
            fetch_args=args.fetch_args,
        )
        if res["state"] == "restarted" and current_pid is not None:
            current_pid = res["pid"]
        if args.once:
            break
        time.sleep(args.poll_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
