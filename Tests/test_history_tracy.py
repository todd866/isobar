import importlib.util,json,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prepare_tracy',ROOT/'tools/history/prepare_tracy.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class TracyCandidateTests(unittest.TestCase):
 def test_retains_source_arrays_and_dated_bom_fixes(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);paths=[]
   for day in (24,25):
    p=root/f'{day}.json';frames=[{'time':f'1974-12-{day}T{h:02d}:00Z','pressure_msl':[1001],'u':[2],'v':[3]} for h in range(24)]
    p.write_text(json.dumps({'grid':{'nx':1},'frames':frames}));paths.append(p)
   original=[p.read_bytes() for p in paths]
   result=module.prepare(paths,ROOT/'tools/history/tracy-track.json',root/'out.json')
   self.assertEqual(result['frames'][0]['pressure_msl'],[1001])
   self.assertEqual([p.read_bytes() for p in paths],original)
   self.assertEqual(result['cyclone']['track'][0]['windKt'],95)
   self.assertEqual(result['cyclone']['track'][-1]['time'],'1974-12-26T00:00:00Z')
   with self.assertRaises(ValueError):module.prepare(paths,ROOT/'tools/history/tracy-track.json',root/'out.json')
if __name__=='__main__':unittest.main()
