import sys
import tempfile
import shutil
import json
from pathlib import Path
from datetime import datetime
import functools

sys.path.insert(0, str(Path(__file__).parent))
import staris_run
import deep
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
        sys.argv = ['staris_run.py', '--source', 'tap'] + argv
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


def test_full_run_dry(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    orig_anon = getattr(tap, 'ANON_MAX_ROWS', None)
    try:
        tap.ANON_MAX_ROWS = 5000
        code = run_cli(
            ['--out', str(tmp_path), '--coarse', '--deep', '--upload', '--prefix', 'auto',
             '--workers', '2', '--secrets-dir', str(tmp_path)],
            calls,
            object_exists=obj_exists
        )
        assert code == 0
        import re
        assert any(c[0] == 'make_sink' and '/deep/' in str(c[1][1]) for c in calls)
        assert any(c[0] == 'sink' and __import__('re').match(r'o(7|8|9|10|11|12)_p\d+\.pack$', str(c[1])) for c in calls), 'expected deep pack uploads'
        upload_keys = []
        for name, arg in calls:
            if name == 'upload_file':
                key = arg[1] if len(arg) > 1 else arg[0]
                upload_keys.append(key)
        assert any(k.endswith('packs/tiles.json') for k in upload_keys)
        assert upload_keys[-1] == 'v2-dr3/current.json'
        assert (tmp_path / 'current.json').exists()
        prefix = (tmp_path / 'prefix.txt').read_text().strip()
        data = json.loads((tmp_path / 'current.json').read_text())
        assert data['prefix'] == prefix
    finally:
        if orig_anon is not None:
            tap.ANON_MAX_ROWS = orig_anon
        else:
            delattr(tap, 'ANON_MAX_ROWS')


def test_publish_refused_without_deep(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    code = run_cli(
        ['--out', str(tmp_path), '--coarse', '--upload', '--prefix', 'auto',
         '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code == 0
    upload_keys = [c[1][1] if len(c[1]) > 1 else c[1][0] for name, c in calls if name == 'upload_file']
    assert 'v2-dr3/current.json' not in upload_keys


def test_publish_refused_on_deep_verify_fail(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    orig_deep_run = deep.run_deep
    try:
        deep.run_deep = lambda config, progress=print: {'deep_verify': {'ok': False}}
        code = run_cli(
            ['--out', str(tmp_path), '--coarse', '--deep', '--upload', '--prefix', 'auto',
             '--workers', '1', '--secrets-dir', str(tmp_path)],
            calls,
            object_exists=obj_exists
        )
        assert code == 5
        upload_keys = []
        for name, arg in calls:
            if name == 'upload_file':
                key = arg[1] if len(arg) > 1 else arg[0]
                upload_keys.append(key)
        assert not any(k.endswith('tiles.json') for k in upload_keys)
        assert 'v2-dr3/current.json' not in upload_keys
    finally:
        deep.run_deep = orig_deep_run


def test_count_mismatch_exits_3(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    orig_run_pipeline = pyramid.run_pipeline
    try:
        def fake_run_pipeline(config, progress=print):
            real = orig_run_pipeline(config, progress=progress)
            real['coarse_counts'] = {'0': 1}
            return real
        pyramid.run_pipeline = fake_run_pipeline
        code = run_cli(
            ['--out', str(tmp_path), '--coarse', '--deep', '--upload', '--prefix', 'auto',
             '--workers', '1', '--secrets-dir', str(tmp_path)],
            calls,
            object_exists=obj_exists
        )
        assert code == 3
        upload_keys = [c[1][1] if len(c[1]) > 1 else c[1][0] for name, c in calls if name == 'upload_file']
        assert 'v2-dr3/current.json' not in upload_keys
    finally:
        pyramid.run_pipeline = orig_run_pipeline


def test_prefix_reused_on_resume(tmp_path):
    calls = []
    def obj_exists(*a, **k): return False
    code1 = run_cli(
        ['--out', str(tmp_path), '--coarse', '--region', '0:4', '--prefix', 'auto',
         '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code1 == 0
    prefix1 = (tmp_path / 'prefix.txt').read_text().strip()
    assert prefix1.startswith('v2-dr3-')
    calls.clear()
    code2 = run_cli(
        ['--out', str(tmp_path), '--coarse', '--region', '0:4', '--prefix', 'auto',
         '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code2 == 0
    assert (tmp_path / 'prefix.txt').read_text().strip() == prefix1
    calls.clear()
    code3 = run_cli(
        ['--out', str(tmp_path), '--coarse', '--region', '0:4', '--prefix', 'other/',
         '--workers', '1', '--secrets-dir', str(tmp_path)],
        calls,
        object_exists=obj_exists
    )
    assert code3 == 4


def main():
    for fn in [test_deep_without_upload_no_r2, test_existing_tiles_without_overwrite_exits_4,
               test_full_run_refuses_overwrite, test_auto_prefix,
               test_full_run_dry, test_publish_refused_without_deep,
               test_publish_refused_on_deep_verify_fail, test_count_mismatch_exits_3,
               test_prefix_reused_on_resume]:
        with tempfile.TemporaryDirectory() as d:
            fn(Path(d))
    print('ok 9 tests')


if __name__ == "__main__":
    main()
