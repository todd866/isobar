import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).parents[1]
sys.path.insert(0,str(ROOT/'tools/history'))
from publish_catalog import complete_days,publish
from index_maps import connect,ingest_page


def weather():
    times=[f'1944-06-06T{h:02}:00Z' for h in range(24)]
    return {'schema_version':1,'product':'isobar-historical-weather','event':{'id':'dday','label':'D-Day'},
        'grid':{'nx':2,'ny':2,'latitudes':[51,50],'longitudes':[-1,0]},
        'units':{'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'},
        'times':times,'frames':[dict(time=t,pressure_msl=[1000]*4,u=[0]*4,v=[5]*4,temperature=[15]*4) for t in times]}

class CatalogTests(unittest.TestCase):
    def test_only_complete_days_are_selectable(self):
        w=weather();self.assertEqual(complete_days(w),[{'date':'1944-06-06','complete':True}])
        w['times'].pop();w['frames'].pop();self.assertEqual(complete_days(w),[])
    def test_corrupt_frames_fail_closed(self):
        for kind in ['nan','units','time','grid']:
            w=weather()
            if kind=='nan':w['frames'][0]['u'][0]=float('nan')
            if kind=='units':w['units']['u']='m/s'
            if kind=='time':w['frames'][0]['time']='1944-06-06T01:00Z'
            if kind=='grid':w['grid']['latitudes']=[50,51]
            with self.subTest(kind=kind),self.assertRaises(ValueError):complete_days(w)
    def test_catalog_is_not_changed_by_failed_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);src=root/'source.json';src.write_text(json.dumps(weather()))
            first=publish(src,root/'public');original=(root/'public/catalog.json').read_bytes()
            invalid=weather();invalid['frames'][0]['v']=[];src.write_text(json.dumps(invalid))
            with self.assertRaises(ValueError):publish(src,root/'public')
            self.assertEqual((root/'public/catalog.json').read_bytes(),original)
    def test_map_page_transaction_and_dedup(self):
        with tempfile.TemporaryDirectory() as temp:
            db=connect(Path(temp)/'maps.sqlite')
            try:
                item={'sourceId':'one','title':'Map','boundingBox':{'minX':0}}
                ingest_page(db,{'items':[item],'total':1},0)
                ingest_page(db,{'items':[item],'total':1},0)
                self.assertEqual(db.execute('SELECT count(*) FROM maps').fetchone()[0],1)
                with self.assertRaises(ValueError):ingest_page(db,{'items':[dict(item,sourceId='two'),{}],'total':3},1)
                self.assertEqual(db.execute('SELECT count(*) FROM maps').fetchone()[0],1)
                self.assertEqual(db.execute('SELECT offset FROM progress').fetchone()[0],1)
            finally:db.close()
if __name__=='__main__':unittest.main()
