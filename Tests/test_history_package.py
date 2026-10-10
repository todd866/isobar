import json
from pathlib import Path
import sys
import tempfile
import unittest
import hashlib
sys.path.insert(0,str(Path(__file__).parents[1]/'tools/history'))
from package_assets import package
from publish_catalog import publish
# Discovery imports test files directly; support both the gate and -m unittest.
sys.path.insert(0, str(Path(__file__).parent))
from test_history_catalog import weather

class PackageTests(unittest.TestCase):
    def setup_assets(self,base):
        root=base/'assets';src=base/'weather.json';src.write_text(json.dumps(weather()))
        publish(src,root,[{'url':'/history/private-scan.jpg','source':'https://example.com'}])
        (root/'world-coast.bin').write_bytes(b'coast')
        (root/'themes').mkdir();(root/'themes/wwii-paper.png').write_bytes(b'paper')
        (root/'orphan.json').write_text('unused')
        return root
    def test_exact_closure_compact_and_hashed_without_scan_or_orphans(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);root=self.setup_assets(base);dest=base/'bundle'
            inventory=package(root,dest)
            actual={str(p.relative_to(dest)) for p in (dest/'history').rglob('*') if p.is_file()}
            self.assertEqual(actual,{f['path'] for f in inventory['files']})
            for f in inventory['files']:
                raw=(dest/f['path']).read_bytes();self.assertEqual(f['sha256'],hashlib.sha256(raw).hexdigest());self.assertEqual(f['bytes'],len(raw))
            self.assertFalse(any('orphan' in p or 'scan' in p for p in actual))
            c=json.loads((dest/'history/catalog.json').read_text())['collections'][0]
            m=json.loads((dest/c['manifest'].lstrip('/')).read_text());self.assertEqual(m['maps'],[])
            with self.assertRaises(ValueError):package(root,dest)
    def test_inconsistent_catalog_fails_before_output(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);root=self.setup_assets(base);p=root/'catalog.json';c=json.loads(p.read_text());c['collections'][0]['days']=[];p.write_text(json.dumps(c))
            with self.assertRaises(ValueError):package(root,base/'bundle')
            self.assertFalse((base/'bundle').exists())
    def test_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);root=self.setup_assets(base);p=root/'catalog.json';c=json.loads(p.read_text());c['collections'][0]['manifest']='/history/../weather.json';p.write_text(json.dumps(c))
            with self.assertRaises(ValueError):package(root,base/'bundle')

    def test_daily_assets_are_packaged_deduplicated_and_keep_default(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);root=self.setup_assets(base);catalog=json.loads((root/'catalog.json').read_text())
            entry=catalog['collections'][0]
            manifest_path=root/Path(entry['manifest']).name
            manifest=json.loads(manifest_path.read_text())
            default=json.loads((root/manifest['weather'].replace('/history/','')).read_text())
            second=json.loads(json.dumps(default))
            second['times']=[stamp.replace('1944-06-06','1944-06-07') for stamp in second['times']]
            second['frames']=[dict(frame,time=stamp) for frame,stamp in zip(second['frames'],second['times'])]
            default['times'].extend(second['times']);default['frames'].extend(second['frames'])
            (root/manifest['weather'].replace('/history/','')).write_text(json.dumps(default))
            daily=json.loads(json.dumps(second));daily['times']=[stamp.replace('1944-06-07','1953-03-10') for stamp in daily['times']]
            daily['frames']=[dict(frame,time=stamp) for frame,stamp in zip(daily['frames'],daily['times'])]
            daily_name='daily.json';(root/daily_name).write_text(json.dumps(daily))
            entries=[{'date':'1944-06-06','complete':True},{'date':'1944-06-07','complete':True},
                     {'date':'1953-03-10','complete':True,'weather':'/history/'+daily_name}]
            entry['days']=entries;manifest['days']=entries;manifest_path.write_text(json.dumps(manifest));(root/'catalog.json').write_text(json.dumps(catalog))
            inventory=package(root,base/'bundle')
            bundled=json.loads((base/'bundle/history/catalog.json').read_text())['collections'][0]
            bundled_manifest=json.loads((base/'bundle'/bundled['manifest'].lstrip('/')).read_text())
            self.assertTrue(bundled_manifest['weather'])
            self.assertTrue((base/'bundle'/bundled_manifest['weather'].lstrip('/')).exists())
            self.assertNotEqual(bundled['days'][2]['weather'],bundled_manifest['weather'])
            self.assertTrue((base/'bundle'/bundled['days'][2]['weather'].lstrip('/')).exists())
            self.assertEqual(sum(f['path'].endswith('.json') and 'dday-' in f['path'] for f in inventory['files']),3)

    def test_daily_asset_missing_or_mismatched_fails(self):
        for mutate in ('missing','mismatch'):
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as t:
                base=Path(t);root=self.setup_assets(base);catalog=json.loads((root/'catalog.json').read_text());entry=catalog['collections'][0]
                manifest_path=root/Path(entry['manifest']).name;manifest=json.loads(manifest_path.read_text())
                day=dict(entry['days'][0],weather='/history/daily.json');entry['days']=[day];manifest['days']=[day]
                if mutate=='mismatch':
                    wrong=weather();wrong['event']['id']='other';(root/'daily.json').write_text(json.dumps(wrong))
                manifest_path.write_text(json.dumps(manifest));(root/'catalog.json').write_text(json.dumps(catalog))
                with self.assertRaises(ValueError):package(root,base/'bundle')
