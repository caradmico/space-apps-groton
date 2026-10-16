import os
import sys
import time
import json
import threading
import http.server
import pytest
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_hats import hats_server, RangeHandler
from test_hats_cli import base_argv, run_cli
import hats


class StallHandler(RangeHandler):
    def do_GET(self):
        if (
            "Range" in self.headers
            and self.server.should_stall(self.path)
        ):
            with self.server.lock:
                self.server.stalls += 1
            path = self.path
            full_bytes = self._get_full_bytes(path)
            range_header = self.headers.get("Range")
            start, end = self._parse_range(range_header, len(full_bytes))
            if end is None:
                end = len(full_bytes) - 1
            content = full_bytes[start : end + 1]
            cl = len(content)
            mid = cl // 2

            self.send_response(206)
            self.send_header("Content-Length", str(cl))
            self.send_header(
                "Content-Range",
                f"bytes {start}-{end}/{len(full_bytes)}",
            )
            self.end_headers()

            if self.server.trickle and self.server.should_stall(path):
                with self.server.lock:
                    self.server.trickles += 1
                try:
                    for i in range(cl):
                        self.wfile.write(content[i : i + 1])
                        self.wfile.flush()
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return

            self.wfile.write(content[:mid])
            self.wfile.flush()
            time.sleep(self.server.stall_s)
            return

        super().do_GET()

    def log_message(self, *a):
        pass

    def _get_full_bytes(self, path):
        full_path = os.path.join(self.server.root, path.lstrip("/"))
        with open(full_path, "rb") as f:
            return f.read()

    def _parse_range(self, header, total):
        if not header or not header.startswith("bytes="):
            return 0, total - 1
        r = header[6:].split("-")
        start = int(r[0]) if r[0] else 0
        end = int(r[1]) if r[1] else total - 1
        return start, end


def start_server(root, handler=StallHandler):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    server.root = str(root)
    server.lock = threading.Lock()
    server.stalls = 0
    server.trickles = 0
    server.stall_s = 3.0
    server.trickle = False
    server.should_stall = lambda path: False

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.1)  # let it bind

    url = f"http://{server.server_address[0]}:{server.server_address[1]}"
    return server, url


@pytest.fixture
def fast_knobs(monkeypatch):
    monkeypatch.setattr(hats, "CONNECT_TIMEOUT", 2)
    monkeypatch.setattr(hats, "READ_TIMEOUT", 0.3)
    monkeypatch.setattr(hats, "REQUEST_DEADLINE", 1.5)
    monkeypatch.setattr(hats, "MAX_ATTEMPTS", 3)
    monkeypatch.setattr(hats, "BACKOFF_BASE", 0.01)
    monkeypatch.setattr(hats, "BACKOFF_MAX", 0.05)


def test_stall_mid_read_times_out_retries_and_recovers(hats_server, fast_knobs):
    root = hats_server[1] / "hats"
    stall_server, stall_url = start_server(root)

    counter = {"count": 0}

    def should_stall_first_two(path):
        if "Npix=0.parquet" in path and counter["count"] < 2:
            counter["count"] += 1
            return True
        return False

    stall_server.should_stall = should_stall_first_two

    t0 = time.time()
    arr_stall, _ = hats.read_partition(
        hats.partition_url(2, 0, stall_url + "/"), workers=1
    )
    arr_clean, _ = hats.read_partition(
        hats.partition_url(2, 0, hats_server[0]), workers=1
    )
    elapsed = time.time() - t0

    assert arr_stall.tobytes() == arr_clean.tobytes()
    assert stall_server.stalls == 2
    assert elapsed < 5

    stall_server.shutdown()
    stall_server.server_close()


def test_permanent_stall_raises_cleanly(hats_server, fast_knobs):
    root = hats_server[1] / "hats"
    stall_server, stall_url = start_server(root)
    stall_server.should_stall = lambda p: True

    t0 = time.time()
    with pytest.raises(hats.HatsReadError, match="failed after 3 attempts"):
        hats.read_partition(
            hats.partition_url(2, 0, stall_url + "/"), workers=1
        )
    elapsed = time.time() - t0
    assert elapsed < 10

    stall_server.shutdown()
    stall_server.server_close()


def test_trickle_hits_request_deadline(hats_server, fast_knobs):
    root = hats_server[1] / "hats"
    stall_server, stall_url = start_server(root)
    stall_server.trickle = True
    stall_server.should_stall = lambda p: True

    t0 = time.time()
    with pytest.raises(hats.HatsReadError, match="deadline") as excinfo:
        hats.read_partition(
            hats.partition_url(2, 0, stall_url + "/"), workers=1
        )
    elapsed = time.time() - t0
    assert elapsed < 15
    assert stall_server.trickles >= hats.MAX_ATTEMPTS

    stall_server.shutdown()
    stall_server.server_close()


def test_cli_stall_exits_8_then_rerun_resumes_byte_identical(
    hats_server, monkeypatch, tmp_path, fast_knobs
):
    clean_out = tmp_path / "clean"
    stall_out = tmp_path / "stall"
    base_url = hats_server[0]
    root = hats_server[1] / "hats"

    # Clean run
    argv_clean = base_argv(
        clean_out, base_url + "/", tmp_path, "--coarse", "--prefix", "probe/"
    )
    code, _, _, _ = run_cli(argv_clean, monkeypatch)
    assert code == 0

    # Stall server
    stall_server, stall_url = start_server(root)
    flag = {"on": True}

    def should_stall_npix1(path):
        return flag["on"] and "Npix=1" in path

    stall_server.should_stall = should_stall_npix1

    argv_stall = base_argv(
        stall_out, stall_url + "/", tmp_path, "--coarse", "--prefix", "probe/"
    )

    # First run - should hit stall and exit 8
    code, _, _, _ = run_cli(argv_stall, monkeypatch)
    assert code == 8
    scan_path = stall_out / "hats_stream" / "scan.json"
    assert scan_path.exists()
    with open(scan_path) as f:
        scan = json.load(f)
    assert scan["version"] == 2

    # Disable stall and rerun
    flag["on"] = False
    code, _, _, _ = run_cli(argv_stall, monkeypatch)
    assert code == 0

    # Compare packs byte-for-byte
    clean_packs = clean_out / "pyramid" / "packs"
    stall_packs = stall_out / "pyramid" / "packs"
    clean_files = {p.name: p.read_bytes() for p in clean_packs.glob("**/*") if p.is_file()}
    stall_files = {p.name: p.read_bytes() for p in stall_packs.glob("**/*") if p.is_file()}

    assert set(clean_files.keys()) == set(stall_files.keys())
    for name, data in clean_files.items():
        assert data == stall_files[name], f"Mismatch in {name}"

    stall_server.shutdown()
    stall_server.server_close()
