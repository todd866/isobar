import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import sys
sys.path.insert(0, 'tools/history')
import import_20cr

class Response:
    def __init__(self, status, body=b'', headers=None):
        self.status, self.body, self.headers = status, body, headers or {}
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, n=-1): return self.body if n < 0 else self.body[:n]

class Opener:
    def __init__(self, payload, modified='Wed, 01 Jan 2020 00:00:00 GMT', bad_status=False):
        self.payload, self.modified, self.bad_status, self.requests = payload, modified, bad_status, []
    def __call__(self, request, timeout=0):
        self.requests.append(request)
        if getattr(request, 'method', None) or request.get_method() == 'HEAD':
            return Response(200, headers={'Content-Length': str(len(self.payload)), 'Last-Modified': self.modified})
        start, end = [int(x) for x in request.headers['Range'].split('=')[1].split('-')]
        body = self.payload[start:end + 1]
        headers = {'Content-Range': f'bytes {start}-{end}/{len(self.payload)}'}
        return Response(200 if self.bad_status else 206, body, headers)

class TwentyCRTests(unittest.TestCase):
    def test_range_reads_eof_and_hash_cache(self):
        payload = bytes(range(251)) * 20
        with tempfile.TemporaryDirectory() as d:
            op = Opener(payload)
            rf = import_20cr.RangeFile('https://example.test/a.nc', Path(d), {'bytes': 0, 'limit': 10000}, opener=op, block=64)
            rf.seek(len(payload) - 7)
            self.assertEqual(rf.read(100), payload[-7:])
            self.assertEqual(rf.read(), b'')
            self.assertTrue(list(Path(d).glob('*.sha256')))
            digest = hashlib.sha256(payload[(len(payload)//64)*64:]).hexdigest()
            self.assertIn(digest, {p.read_text() for p in Path(d).glob('*.sha256')})
            # A second reader reuses immutable cached blocks without fetching them.
            op2 = Opener(payload)
            rf2 = import_20cr.RangeFile('https://example.test/a.nc', Path(d), {'bytes': 0, 'limit': 10000}, opener=op2, block=64)
            rf2.seek(len(payload) - 7); self.assertEqual(rf2.read(7), payload[-7:])
            self.assertEqual(len([r for r in op2.requests if r.get_method() != 'HEAD']), 0)

    def test_read_ahead_is_cached_as_verified_independent_blocks(self):
        payload = bytes(range(128))
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); op=Opener(payload); budget={'bytes':0,'limit':128}
            rf=import_20cr.RangeFile('https://example.test/a',root,budget,opener=op,block=16,read_ahead=4)
            self.assertEqual(rf.read(1),payload[:1])
            self.assertEqual(budget['bytes'],64)
            self.assertEqual(len(list(root.glob('*.bin'))),4)
            rf.seek(48);self.assertEqual(rf.read(16),payload[48:64])
            self.assertEqual(budget['bytes'],64)
            self.assertEqual(len([r for r in op.requests if r.get_method()!='HEAD']),1)

    def test_range_requires_exact_206_and_content_range(self):
        payload = b'abcdef' * 30
        with tempfile.TemporaryDirectory() as d:
            op = Opener(payload, bad_status=True)
            rf = import_20cr.RangeFile('https://example.test/a.nc', Path(d), {'bytes': 0, 'limit': 1000}, opener=op, block=16)
            with self.assertRaises(ValueError): rf.read(1)

    def test_budget_is_shared_across_files_and_failed_transfer_reserved(self):
        payload = b'x' * 64
        with tempfile.TemporaryDirectory() as d:
            budget = {'bytes': 0, 'limit': 24}
            rf = import_20cr.RangeFile('https://example.test/a', Path(d)/'a', budget, opener=Opener(payload), block=16)
            rf.read(1); self.assertEqual(budget['bytes'], 16)
            rf2 = import_20cr.RangeFile('https://example.test/b', Path(d)/'b', budget, opener=Opener(payload), block=16)
            with self.assertRaises(ValueError): rf2.read(1)
            self.assertEqual(budget['bytes'], 16)

    def test_timeout_retries_once_and_charges_both_attempts(self):
        with tempfile.TemporaryDirectory() as d:
            calls=0; real=Opener(b'x'*64)
            def flaky(request,timeout=0):
                nonlocal calls
                if request.get_method()!='HEAD':
                    calls+=1
                    if calls==1:raise TimeoutError('fixture timeout')
                return real(request,timeout)
            budget={'bytes':0,'limit':64}
            reader=import_20cr.RangeFile('https://example.test/a',Path(d),budget,opener=flaky,block=16)
            self.assertEqual(reader.read(1),b'x')
            self.assertEqual((calls,budget['bytes']),(2,32))

    def test_source_identity_change_and_cached_hash_are_rejected(self):
        payload = b'0123456789' * 8
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); op = Opener(payload, modified='A')
            rf = import_20cr.RangeFile('https://example.test/a', root, {'bytes': 0, 'limit': 1000}, opener=op, block=16); rf.read(16)
            with self.assertRaises(ValueError): import_20cr.RangeFile('https://example.test/a', root, {'bytes': 0, 'limit': 1000}, opener=Opener(payload, modified='B'), block=16)
            cache = next(root.glob('*.bin')); cache.write_bytes(b'bad')
            with self.assertRaises(ValueError):
                import_20cr.RangeFile('https://example.test/a', root, {'bytes': 0, 'limit': 1000}, opener=Opener(payload, modified='A'), block=16).read(1)

    def test_hourly_interpolation_and_units_are_physical(self):
        planes = np.arange(9, dtype=float)[:, None, None] + 100000
        p = import_20cr.hourly(planes, 'pressure_msl')
        self.assertEqual(p.shape, (24, 1, 1)); self.assertAlmostEqual(float(p[1, 0, 0]), 1000.003, places=3)
        wind = import_20cr.hourly(np.ones((9, 1, 1))*10, 'u')
        self.assertAlmostEqual(float(wind[0, 0, 0]), 19.438, places=3)
        with self.assertRaises(ValueError): import_20cr.hourly(np.full((9, 1, 1), np.nan), 'u')

    def test_target_grid_step_validation(self):
        self.assertEqual(len(import_20cr.axes(2.5)[0]), 73)
        for step in (0.5, 7, float('nan')):
            with self.assertRaises(ValueError): import_20cr.axes(step)

    def test_wrong_content_range_is_rejected(self):
        payload = b'x' * 32
        class Wrong(Opener):
            def __call__(self, request, timeout=0):
                response = super().__call__(request, timeout)
                if request.get_method() != 'HEAD': response.headers['Content-Range'] = 'bytes 0-0/32'
                return response
        with tempfile.TemporaryDirectory() as d:
            rf = import_20cr.RangeFile('https://example.test/a', Path(d), {'bytes': 0, 'limit': 100}, opener=Wrong(payload), block=16)
            with self.assertRaises(ValueError): rf.read(1)

    @unittest.skipUnless(__import__('importlib').util.find_spec('h5py'), 'h5py required for sparse HDF5 pipeline fixture')
    def test_sparse_hdf5_pipeline_interpolates_and_wraps(self):
        import h5py
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); epoch = datetime(1800, 1, 1, tzinfo=timezone.utc)
            target = datetime(1915, 4, 25, tzinfo=timezone.utc)
            start = int((target - epoch).total_seconds() // 3600)
            paths = {}
            specs = {'prmsl': ('pressure_msl', 'Pa', 100000.), 'u10': ('u', 'm s**-1', 10.), 'v10': ('v', 'm s**-1', 2.), 't2m': ('temperature', 'K', 273.15)}
            lat = np.linspace(89.462822, -89.462822, 256); lon = np.arange(512) * 360 / 512
            times = start - 12 + np.arange(2920) * 3
            for var, (logical, units, base) in specs.items():
                path = root / f'{var}.h5'; paths[logical] = path
                with h5py.File(path, 'w') as ds:
                    ds.create_dataset('latitude', data=lat); ds.create_dataset('longitude', data=lon)
                    ds.create_dataset('time', data=times); ds['time'].attrs['units'] = 'hours since 1800-01-01 00:00:00.0'
                    data = ds.create_dataset(var, shape=(2920, 256, 512), dtype='f4', chunks=(365, 32, 64), fillvalue=base)
                    data.attrs['units'] = units; data.attrs['_FillValue'] = 9999.
                    for j in range(9): data[np.searchsorted(times, start) + j, :, :] = base + j
            class LocalRange:
                def __init__(self, url, directory, budget):
                    self.path = paths[next(k for k,v in specs.items() if v[0] in url)] if False else None
                # actual instance is constructed by the closure below
            original = import_20cr.RangeFile
            def fake_range(url, directory, budget, **kwargs):
                key = 'pressure_msl' if 'PRMSL' in url else 'u' if 'UGRD' in url else 'v' if 'VGRD' in url else 'temperature'
                fp = open(paths[key], 'rb')
                fp.url = url; fp.size = fp.seek(0, 2); fp.seek(0); fp.modified = 'fixture'; fp.receipts = {}; fp.cache = {}
                return fp
            import_20cr.RangeFile = fake_range
            try:
                out = root / 'out.json'
                args = type('Args', (), {'date':'1915-04-25','event_id':'fixture','label':'fixture','step':90.,'input_dir':root,'max_mb':20.,'output':out})()
                result = import_20cr.import_data(args)
            finally:
                import_20cr.RangeFile = original
            self.assertEqual(len(result['frames']), 24)
            self.assertNotEqual(result['frames'][0]['u'][0], result['frames'][1]['u'][0])
            self.assertEqual(result['grid']['longitudes'], [-180.0, -90.0, 0.0, 90.0])
            self.assertEqual(result['provenance']['dataset'], '20CRv3 ensemble mean')


if __name__ == '__main__': unittest.main()
