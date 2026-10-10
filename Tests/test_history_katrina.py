import json, tempfile, unittest
from pathlib import Path
import sys
sys.path.insert(0, 'tools/history')
import prepare_katrina

class KatrinaTests(unittest.TestCase):
    def weather(self, day, value):
        return {'times':[f'2005-08-{day:02d}T{h:02d}:00Z' for h in range(24)], 'grid': {'nx': 2, 'ny': 1}, 'units': {'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'}, 'frames': [{'time': f'2005-08-{day:02d}T{h:02d}:00Z', 'pressure_msl':[value], 'u':[1], 'v':[2], 'temperature':[20]} for h in range(24)]}
    def test_builds_48_hours_and_profile(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); a=root/'a.json'; b=root/'b.json'; a.write_text(json.dumps(self.weather(28,1000))); b.write_text(json.dumps(self.weather(29,999)))
            out=root/'out.json'; r=prepare_katrina.prepare([a,b],Path('tools/history/katrina-track.json'),out)
            self.assertEqual(len(r['frames']),48); self.assertEqual(r['frames'][0]['pressure_msl'],[1000]); self.assertEqual(r['cyclone']['rmwKm'],55); self.assertEqual(r['cyclone']['profile']['blendStartKm'],370)
            self.assertIn('record_sha256',r['reconstruction']['best_track'])
    def test_rejects_declared_units_or_times_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); a=root/'a.json'; obj=self.weather(28,1000); obj['units']['u']='m/s'; a.write_text(json.dumps(obj)); b=root/'b.json'; b.write_text(json.dumps(self.weather(29,999)))
            with self.assertRaises(ValueError): prepare_katrina.prepare([a,b],Path('tools/history/katrina-track.json'),root/'x.json')

    def test_one_file_and_mismatched_times(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); source=root/'source.json'; a=self.weather(28,1000); b=self.weather(29,999)
            a['times']+=b['times']; a['frames']+=b['frames']; source.write_text(json.dumps(a))
            self.assertEqual(len(prepare_katrina.prepare([source],Path('tools/history/katrina-track.json'),root/'ok.json')['frames']),48)
            a['times'][0]='2005-08-28T00:01Z';source.write_text(json.dumps(a))
            with self.assertRaisesRegex(ValueError,'declared times'): prepare_katrina.prepare([source],Path('tools/history/katrina-track.json'),root/'bad.json')

    def test_keeps_post_interval_bracket(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); a=root/'a.json'; a.write_text(json.dumps(self.weather(28,1000)))
            b=root/'b.json'; b.write_text(json.dumps(self.weather(29,999)))
            r=prepare_katrina.prepare([a,b],Path('tools/history/katrina-track.json'),root/'x.json')
            self.assertEqual(r['cyclone']['track'][-1]['time'],'2005-08-30T00:00Z')

    def test_rejects_duplicate_or_nonphysical_track_before_output(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); a=root/'a.json'; a.write_text(json.dumps(self.weather(28,1000))); b=root/'b.json'; b.write_text(json.dumps(self.weather(29,999)))
            track=json.loads(Path('tools/history/katrina-track.json').read_text()); track['observations'][1]['time']=track['observations'][0]['time']; tf=root/'track.json'; tf.write_text(json.dumps(track)); out=root/'out.json'
            with self.assertRaisesRegex(ValueError, 'track'): prepare_katrina.prepare([a,b],tf,out)
            self.assertFalse(out.exists())
            track['observations'][1]['time']='2005-08-28T06:00Z'; track['observations'][1]['wind_kt']=181; tf.write_text(json.dumps(track))
            with self.assertRaisesRegex(ValueError, 'track'): prepare_katrina.prepare([a,b],tf,out)
            self.assertFalse(out.exists())

    def test_refuses_gap_and_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); a=root/'a.json'; b=root/'b.json'; a.write_text(json.dumps(self.weather(28,1000))); w=self.weather(30,999); b.write_text(json.dumps(w))
            with self.assertRaises(ValueError): prepare_katrina.prepare([a,b],Path('tools/history/katrina-track.json'),root/'x.json')
            out=root/'x.json'; out.write_text('{}')
            with self.assertRaises(ValueError): prepare_katrina.prepare([a,a],Path('tools/history/katrina-track.json'),out)
if __name__=='__main__': unittest.main()
