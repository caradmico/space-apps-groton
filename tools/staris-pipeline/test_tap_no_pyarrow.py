import importlib
import sys
import pytest
import tap


def test_tap_no_pyarrow(monkeypatch, tmp_path):
    monkeypatch.delitem(sys.modules, "staris_run", raising=False)
    monkeypatch.setitem(sys.modules, "pyarrow", None)
    monkeypatch.setitem(sys.modules, "hats", None)
    monkeypatch.setitem(sys.modules, "hats_stream", None)

    staris_run = importlib.import_module("staris_run")

    def fake_fetch_coarse(*args, **kwargs):
        raise tap.DiskFull("x")

    monkeypatch.setattr(tap, "fetch_coarse", fake_fetch_coarse)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "staris_run.py",
            "--out",
            str(tmp_path),
            "--prefix",
            "p/",
            "--source",
            "tap",
            "--coarse",
        ],
    )

    with pytest.raises((SystemExit, tap.DiskFull)) as exc_info:
        staris_run.main()

    if isinstance(exc_info.value, SystemExit):
        assert exc_info.value.code == 2
