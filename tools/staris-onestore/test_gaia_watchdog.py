import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gaia_watchdog as gw


def test_no_stall_when_raw_grows(tmp_path: Path):
    build_dir = tmp_path / "build"
    gaia_dir = build_dir / "raw" / "gaia"
    gaia_dir.mkdir(parents=True)
    status_file = tmp_path / "status" / "gaia-watchdog.json"

    f1 = gaia_dir / "r_0_10.csv"
    f1.write_text("id,val\n1,2\n", encoding="utf-8")

    killed = []
    spawned = []

    res1 = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        now_fn=lambda: 1000.0,
        is_alive_fn=lambda p: True,
        kill_fn=lambda p: killed.append(p),
        spawn_fn=lambda b, py, a: spawned.append((b, py, a)) or 5678,
    )
    assert res1["state"] == "running"

    f2 = gaia_dir / "r_10_20.csv"
    f2.write_text("id,val\n3,4\n", encoding="utf-8")

    res2 = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        now_fn=lambda: 1000.0 + 25 * 60,
        is_alive_fn=lambda p: True,
        kill_fn=lambda p: killed.append(p),
        spawn_fn=lambda b, py, a: spawned.append((b, py, a)) or 5678,
    )
    assert res2["state"] == "running"

    res3 = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        now_fn=lambda: 1000.0 + 45 * 60,
        is_alive_fn=lambda p: True,
        kill_fn=lambda p: killed.append(p),
        spawn_fn=lambda b, py, a: spawned.append((b, py, a)) or 5678,
    )
    assert res3["state"] == "running"
    assert killed == []
    assert spawned == []


def test_stall_detected_after_n_minutes(tmp_path: Path):
    build_dir = tmp_path / "build"
    gaia_dir = build_dir / "raw" / "gaia"
    gaia_dir.mkdir(parents=True)
    status_file = tmp_path / "status" / "gaia-watchdog.json"

    (gaia_dir / "r_0_10.csv").write_text("col1,col2\na,b\n", encoding="utf-8")

    killed = []
    spawned = []

    res1 = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        dry_run=True,
        now_fn=lambda: 1000.0,
        is_alive_fn=lambda p: True,
        kill_fn=lambda p: killed.append(p),
        spawn_fn=lambda b, py, a: spawned.append((b, py, a)) or 5678,
    )
    assert res1["state"] == "running"

    res2 = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        dry_run=True,
        now_fn=lambda: 1000.0 + 31 * 60,
        is_alive_fn=lambda p: True,
        kill_fn=lambda p: killed.append(p),
        spawn_fn=lambda b, py, a: spawned.append((b, py, a)) or 5678,
    )
    assert res2["state"] == "stalled"
    assert killed == []
    assert spawned == []
    status_data = json.loads(status_file.read_text(encoding="utf-8"))
    assert status_data["state"] == "stalled"


def test_dead_process_not_running(tmp_path: Path):
    build_dir = tmp_path / "build"
    (build_dir / "raw" / "gaia").mkdir(parents=True)
    status_file = tmp_path / "status" / "gaia-watchdog.json"

    killed = []
    spawned = []

    res = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=9999,
        now_fn=lambda: 5000.0,
        is_alive_fn=lambda p: False,
        kill_fn=lambda p: killed.append(p),
        spawn_fn=lambda b, py, a: spawned.append((b, py, a)) or 5678,
    )
    assert res["state"] == "not_running"
    assert killed == []
    assert spawned == []
    status_data = json.loads(status_file.read_text(encoding="utf-8"))
    assert status_data["state"] == "not_running"


def test_restart_calls_kill_then_spawn_and_preserves_files(tmp_path: Path):
    build_dir = tmp_path / "build"
    gaia_dir = build_dir / "raw" / "gaia"
    gaia_dir.mkdir(parents=True)
    status_file = tmp_path / "status" / "gaia-watchdog.json"

    csv_file = gaia_dir / "r_0_100.csv"
    rows_file = gaia_dir / "r_0_100.rows"
    tmp_file = gaia_dir / "r_100_200.csv.tmp"

    csv_bytes = b"source_id,ra,dec\n1,10.0,20.0\n"
    rows_bytes = b"1\n"
    tmp_bytes = b"source_id,ra,dec\npartial_row"

    csv_file.write_bytes(csv_bytes)
    rows_file.write_bytes(rows_bytes)
    tmp_file.write_bytes(tmp_bytes)

    events = []

    def fake_kill(p: int) -> None:
        events.append(("kill", p))

    def fake_spawn(b_dir: Path, py_bin: str, f_args: str) -> int:
        events.append(("spawn", b_dir, py_bin, f_args))
        return 4321

    gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=15,
        pid=1111,
        python_bin="../.venv/bin/python",
        fetch_args="--chunks 768 --parallel 4",
        now_fn=lambda: 100.0,
        is_alive_fn=lambda p: True,
        kill_fn=fake_kill,
        spawn_fn=fake_spawn,
    )

    res = gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=15,
        pid=1111,
        python_bin="../.venv/bin/python",
        fetch_args="--chunks 768 --parallel 4",
        now_fn=lambda: 100.0 + 16 * 60,
        is_alive_fn=lambda p: True,
        kill_fn=fake_kill,
        spawn_fn=fake_spawn,
    )

    assert res["state"] == "restarted"
    assert res["pid"] == 4321
    assert res["restarts"] == 1
    assert res["loss"] == []
    assert events == [
        ("kill", 1111),
        ("spawn", build_dir, "../.venv/bin/python", "--chunks 768 --parallel 4"),
    ]
    assert csv_file.read_bytes() == csv_bytes
    assert rows_file.read_bytes() == rows_bytes
    assert tmp_file.read_bytes() == tmp_bytes


def test_verify_no_loss_detects_removed_and_shrunk():
    before = {
        "gaia/r_0_10.csv": 500,
        "gaia/r_0_10.rows": 4,
        "gaia/r_10_20.csv": 600,
    }
    after = {
        "gaia/r_0_10.csv": 450,
        "gaia/r_0_10.rows": 4,
        "gaia/r_20_30.csv": 700,
    }
    issues = gw.verify_no_loss(before, after)
    assert "gaia/r_0_10.csv" in issues
    assert "gaia/r_10_20.csv" in issues
    assert "gaia/r_0_10.rows" not in issues
    assert len(issues) == 2


def test_offload_refuses_without_approval_file(tmp_path: Path):
    build_dir = tmp_path / "build"
    gaia_dir = build_dir / "raw" / "gaia"
    gaia_dir.mkdir(parents=True)
    drive_dir = tmp_path / "drive"
    status_file = tmp_path / "status" / "gaia-watchdog.json"
    approval_file = tmp_path / "status" / "gaia-offload-approved"

    (gaia_dir / "r_0_10.csv").write_text("data\n1\n", encoding="utf-8")
    (gaia_dir / "r_0_10.rows").write_text("1\n", encoding="utf-8")

    rc = gw.main([
        "--build-dir", str(build_dir),
        "--status-file", str(status_file),
        "--offload-drive",
        "--drive-dir", str(drive_dir),
        "--approval-file", str(approval_file),
    ])

    assert rc != 0
    assert not drive_dir.exists() or list(drive_dir.iterdir()) == []
    assert (gaia_dir / "r_0_10.csv").exists()
    status_data = json.loads(status_file.read_text(encoding="utf-8"))
    assert status_data["state"] == "offload_refused"


def test_offload_with_approval_copies_verifies_and_keeps_local(tmp_path: Path):
    build_dir = tmp_path / "build"
    gaia_dir = build_dir / "raw" / "gaia"
    gaia_dir.mkdir(parents=True)
    drive_dir = tmp_path / "drive"
    status_file = tmp_path / "status" / "gaia-watchdog.json"
    approval_file = tmp_path / "status" / "gaia-offload-approved"
    approval_file.parent.mkdir(parents=True, exist_ok=True)
    approval_file.write_text("approved\n", encoding="utf-8")

    csv_content = b"id,ra,dec\n100,1.1,2.2\n101,3.3,4.4\n"
    csv_file = gaia_dir / "r_0_10.csv"
    rows_file = gaia_dir / "r_0_10.rows"
    csv_file.write_bytes(csv_content)
    rows_file.write_text("2\n", encoding="utf-8")

    incomplete_csv = gaia_dir / "r_10_20.csv"
    incomplete_tmp = gaia_dir / "r_10_20.csv.tmp"
    incomplete_rows = gaia_dir / "r_10_20.rows"
    incomplete_csv.write_bytes(b"partial")
    incomplete_tmp.write_bytes(b"writing")
    incomplete_rows.write_text("1\n", encoding="utf-8")

    rc = gw.main([
        "--build-dir", str(build_dir),
        "--status-file", str(status_file),
        "--offload-drive",
        "--drive-dir", str(drive_dir),
        "--approval-file", str(approval_file),
    ])

    assert rc == 0
    dest_file = drive_dir / "r_0_10.csv"
    assert dest_file.exists()
    assert dest_file.read_bytes() == csv_content
    assert csv_file.exists()
    assert rows_file.exists()

    marker_file = gaia_dir / "r_0_10.offloaded"
    assert marker_file.exists()
    marker = json.loads(marker_file.read_text(encoding="utf-8"))
    assert marker["size"] == len(csv_content)
    assert marker["sha256"] == hashlib.sha256(csv_content).hexdigest()
    assert marker["dest"] == str(dest_file)

    assert not (drive_dir / "r_10_20.csv").exists()
    status_data = json.loads(status_file.read_text(encoding="utf-8"))
    assert status_data["state"] == "offload_done"


def test_status_file_written_only_on_state_change(tmp_path: Path):
    build_dir = tmp_path / "build"
    gaia_dir = build_dir / "raw" / "gaia"
    gaia_dir.mkdir(parents=True)
    status_file = tmp_path / "status" / "gaia-watchdog.json"

    f1 = gaia_dir / "r_0_10.csv"
    f1.write_text("row1\n", encoding="utf-8")

    gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        now_fn=lambda: 100.0,
        is_alive_fn=lambda p: True,
    )

    content1 = status_file.read_text(encoding="utf-8")
    os.utime(status_file, ns=(1_000_000_000, 1_000_000_000))
    mtime1 = status_file.stat().st_mtime_ns

    f1.write_text("row1\nrow2\n", encoding="utf-8")

    gw.check_once(
        build_dir=build_dir,
        status_file=status_file,
        stall_minutes=30,
        pid=1234,
        now_fn=lambda: 200.0,
        is_alive_fn=lambda p: True,
    )

    content2 = status_file.read_text(encoding="utf-8")
    mtime2 = status_file.stat().st_mtime_ns

    assert content1 == content2
    assert mtime1 == mtime2
