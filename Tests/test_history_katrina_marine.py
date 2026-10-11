import hashlib,json,tempfile,unittest
from pathlib import Path
import sys
sys.path.insert(0,'tools/history')
import acquire_katrina_marine
class Response:
 def __init__(self,b): self.b=b
 def __enter__(self): return self
 def __exit__(self,*a): return False
 def read(self,n=-1): return self.b if n<0 else self.b[:n]
class KatrinaMarineTests(unittest.TestCase):
 def test_georeferenced_satellite_and_stations(self):
  o=json.loads(Path('tools/history/katrina-marine-sources.json').read_text());s=o['satellites'][0];self.assertEqual(s['crs'],'EPSG:4326');self.assertEqual(s['bounds'],{'west':-98,'south':20,'east':-78,'north':36});self.assertEqual(len(o['stations']),4);self.assertEqual(len(o['surge']),4)
 def test_metadata_observations_and_missing_values(self):
  o=json.loads(Path('tools/history/katrina-marine-sources.json').read_text());self.assertEqual(len(o['observations']),72);self.assertIsNone(o['observations'][-1]['dewpoint_c']);self.assertEqual(o['satellites'][1]['url'],'/history/katrina-modis-terra-20050829-gulf.png')
 def test_mocked_acquisition_manifest_cache_and_cap(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d); meta={'stations':[{'id':'x','data_url':'https://example.test/x.gz'}]};mp=root/'meta.json';mp.write_text(json.dumps(meta));
   def opener(req,timeout=0): return Response(b'fixture')
   r=acquire_katrina_marine.acquire_all(root/'out',mp,opener,total_limit=100000);self.assertEqual(r['total_bytes'],len(b'fixture')*4);self.assertTrue((root/'out/manifest.json').exists());r2=acquire_katrina_marine.acquire_all(root/'out',mp,opener,total_limit=100000);self.assertEqual(r2['total_bytes'],r['total_bytes']);self.assertTrue(all(x['cached'] for x in r2['sources']))
   (root/'out/katrina-modis-terra-20050828-gulf.png').write_bytes(b'tampered')
   with self.assertRaises(ValueError): acquire_katrina_marine.acquire_all(root/'out',mp,opener,total_limit=100000)
   with self.assertRaises(ValueError): acquire_katrina_marine.acquire_all(root/'small',mp,opener,total_limit=3)
if __name__=='__main__':unittest.main()
