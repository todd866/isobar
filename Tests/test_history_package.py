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
