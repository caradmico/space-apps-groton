import sys
import tempfile
import shutil
from pathlib import Path
from datetime import datetime
import functools

sys.path.insert(0, str(Path(__file__).parent))
import staris_run
import tap
import pyramid
from test_tap import FakeTap


def run_cli(argv, calls, object_exists=lambda *a, **k: True):
    original_argv = sys.argv[:]
    original_tap_run_async = tap.run_async
    original_fetch_coarse = staris_run.tap.fetch_coarse
    original_make_sink = staris_run.make_sink
    original_upload_file = staris_run.upload_file
    original_object_exists = staris_run.object_exists
    original_tap_CAP = getattr(tap, 'CAP', None)
    original_pyramid_CAP = getattr(pyramid, 'CAP', None)
    original_pyramid_HEAP_M = getattr(pyramid, 'HEAP_M', None)
    original_tap_ANON_MAX_ROWS = getattr(tap, 'ANON_MAX_ROWS', None)

    try:
        sys.argv = ['staris_run.py'] + argv
        fake = FakeTap()

        def fake_runner(adql):
            return fake.runner(adql)

        tap.run_async = fake_runner
        staris_run.tap.fetch_coarse = functools.partial(
            original_fetch_coarse, runner=fake.runner
        )
        staris_run.make_sink = lambda *a, **k: (
            calls.append(('make_sink', a)) or (lambda p, n: calls.append(('sink', n)))
        )
        staris_run.upload_file = lambda *a, **k: calls.append(('upload_file', a))
        staris_run.object_exists = lambda *a, **k: (
            calls.append(('object_exists', a)) or object_exists(*a, **k)
        )

        tap.CAP = 8
        pyramid.CAP = 8
        pyramid.HEAP_M = 56
        tap.ANON_MAX_ROWS = 200

        try:
            staris_run.main()
        except SystemExit as e:
            return e.code
        return 0
    finally:
        sys.argv = original_argv
        tap.run_async = original_tap_run_async
        staris_run.tap.fetch_coarse = original_fetch_coarse
        staris_run.make_sink = original_make_sink
        staris_run.upload_file = original_upload_file
        staris_run.object_exists = original_object_exists

        if original_tap_CAP is not None:
            tap.CAP = original_tap_CAP
        if original_pyramid_CAP is not None:
            pyramid.CAP = original_pyramid_CAP
        if original_pyramid_HEAP_M is not None:
            pyramid.HEAP_M = original_pyramid_HEAP_M
        if original_tap_ANON_MAX_ROWS is not None:
            tap.ANON_MAX_ROWS = original_tap_ANON_MAX_ROWS


def test_deep_without_upload_no_r2(tmp_path):
    calls = []
    def obj_exists(*a, **k): return True
    code = run_cli(
        ['--out', str(tmp_path), '--coarse', '--deep', '--region', '0:4',
         '--prefix', 'test/', '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code == 0
    assert calls == []


def test_existing_tiles_without_overwrite_exits_4(tmp_path):
    calls = []
    def obj_exists(*a, **k): return True
    code = run_cli(
        ['--out', str(tmp_path), '--coarse', '--upload', '--prefix', 'test/',
         '--region', '0:4', '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code == 4
    sink_calls = [c for c in calls if c[0] in ('sink', 'upload_file')]
    assert sink_calls == []
    assert not (tmp_path / "tap_cache").exists()


def test_full_run_refuses_overwrite(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    code = run_cli(
        ['--out', str(tmp_path), '--upload', '--overwrite', '--prefix', 'auto',
         '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code == 4
    upload_calls = [c for c in calls if c[0] == 'upload_file']
    assert len(upload_calls) == 0


def test_auto_prefix(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    today = datetime.now().strftime('%Y%m%d')
    prefix_start = f'v2-dr3-{today}'

    code = run_cli(
        ['--out', str(tmp_path), '--coarse', '--upload', '--region', '0:4',
         '--prefix', 'auto', '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code == 0

    upload_keys = []
    for name, arg in calls:
        if name == 'upload_file':
            key = arg[1] if len(arg) > 1 else arg[0]
            upload_keys.append(key)

    for key in upload_keys:
        assert key.startswith(prefix_start)

    tiles_calls = [c for c in calls if c[0] == 'upload_file' and
                   isinstance(c[1][1] if len(c[1]) > 1 else c[1][0], str) and
                   (c[1][1] if len(c[1]) > 1 else c[1][0]).endswith('packs/tiles.json')]

    assert len(tiles_calls) > 0
    last_upload = [c for c in calls if c[0] == 'upload_file'][-1]
    assert any('packs/tiles.json' in str(x) for x in last_upload[1])

    current_calls = [c for c in calls if c[0] == 'upload_file' and
                     any('current.json' in str(x) for x in c[1])]
    assert len(current_calls) == 0


def main():
    for fn in [test_deep_without_upload_no_r2, test_existing_tiles_without_overwrite_exits_4, test_full_run_refuses_overwrite, test_auto_prefix]:
        with tempfile.TemporaryDirectory() as d:
            fn(Path(d))
    print('ok 4 tests')


if __name__ == "__main__":
    main()
