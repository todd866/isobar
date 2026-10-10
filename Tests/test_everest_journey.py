import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/history'))
from publish_everest_journey import publish
from ingest_everest_journey import run

def weather(day):
    times=[f'{day}T{h:02}:00Z' for h in range(24)]
    return {'schema_version':1,'product':'isobar-historical-weather','event':{'id':'everest-1953'},'provenance':{'dataset':'ERA5 reanalysis','source':'https://storage.googleapis.com/gcp-public-data-arco-era5/test','license':'Copernicus'},'grid':{'nx':2,'ny':2,'latitudes':[29,27],'longitudes':[86,88]},'units':{'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'},'times':times,'frames':[{'time':t,'pressure_msl':[1010]*4,'u':[10]*4,'v':[0]*4,'temperature':[-20]*4} for t in times]}

class Journey(unittest.TestCase):
    def test_daily_assets_share_collection_and_preserve_summit_default(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);data=root/'data';data.mkdir()
            (data/'1953-03-10.json').write_text(json.dumps(weather('1953-03-10')))
            old={'date':'1953-05-29','complete':True}
            (root/'catalog.json').write_text(json.dumps({'collections':[{'id':'everest-1953','manifest':'/history/old.json','days':[old]}]}))
            (root/'old.json').write_text(json.dumps({'weather':'/history/summit.json','days':[old],'maps':[]}))
            self.assertEqual(publish([data],root),['1953-03-10'])
            entry=json.loads((root/'catalog.json').read_text())['collections'][0]
            manifest=json.loads((root/Path(entry['manifest']).name).read_text())
            self.assertEqual(manifest['weather'],'/history/summit.json')
            self.assertEqual(len(entry['days']),2)
            self.assertTrue((root/Path(entry['days'][0]['weather']).name).exists())
            revised=weather('1953-03-10');revised['frames'][0]['u'][0]=20
            (data/'1953-03-10.json').write_text(json.dumps(revised))
            with self.assertRaisesRegex(ValueError,'conflicting'):publish([data],root)
    def test_resume_validates_completed_days_without_downloading(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'weather').mkdir()
            (root/'weather/1953-03-10.json').write_text(json.dumps(weather('1953-03-10')))
            args=SimpleNamespace(start='1953-03-10',end='1953-03-10',root=root,max_total_mb=1024,disk_floor_gb=50,lock_file=None,wait_for_lock=False)
            with patch('ingest_everest_journey.subprocess.run') as command:run(args);command.assert_not_called()
            self.assertEqual(json.loads((root/'checkpoint.json').read_text())['state'],'complete')
            with patch('ingest_everest_journey.subprocess.run'):run(args)
            self.assertEqual(json.loads((root/'checkpoint.json').read_text())['attempts'][-1]['completedCount'],1)
    def test_disk_floor_checkpoints_before_new_download(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);args=SimpleNamespace(start='1953-03-10',end='1953-03-10',root=root,max_total_mb=1024,disk_floor_gb=50,lock_file=None,wait_for_lock=False)
            with patch('ingest_everest_journey.shutil.disk_usage',return_value=SimpleNamespace(free=0)),patch('ingest_everest_journey.subprocess.run') as command:
                with self.assertRaises(RuntimeError):run(args)
                command.assert_not_called()
            self.assertEqual(json.loads((root/'checkpoint.json').read_text())['state'],'stopped')
if __name__=='__main__':unittest.main()
