#!/usr/bin/env python3
"""Prepare a new immutable Tracy candidate; never rewrite source weather or publish."""
import argparse, hashlib, json
from pathlib import Path

def prepare(days, track_file, output):
    if output.exists():
        raise ValueError('output must be new')
    inputs = [json.loads(p.read_text()) for p in days]
    track = json.loads(track_file.read_text())
    frames = sorted([f for data in inputs for f in data['frames']], key=lambda f: f['time'])
    times = [f['time'] for f in frames]
    expected = [f'1974-12-{day:02d}T{hour:02d}:00Z' for day in (24,25) for hour in range(24)]
    if times != expected:
        raise ValueError('requires exactly 48 hourly UTC frames for Dec24–25')
    if any(data['grid'] != inputs[0]['grid'] for data in inputs):
        raise ValueError('source grids differ')
    fixes = [{'time':r['time'],'lat':r['lat'],'lon':r['lon'],'windKt':r['bom_wind_kt'],'pressureHpa':r['bom_pressure_hpa']} for r in track['observations']]
    if any(any(v is None for v in f.values()) for f in fixes):
        raise ValueError('BOM series has missing values; review interpolation before use')
    result = dict(inputs[0], times=times, frames=frames)
    result['event'] = {'id':'cyclone-tracy','label':'Cyclone Tracy · World','start_date':'1974-12-24','end_date':'1974-12-25'}
    result['cyclone'] = {'method':'compact-vortex-v1','rmwKm':11,'track':fixes,'source':track['provenance']['record_url']}
    result['reconstruction'] = {
        'kind':'synthetic-local-vortex','method':'compact-vortex-v1',
        'assumptions':'Axisymmetric radius of maximum wind 11 km and shape exponent 2; fits about 34 kt at 50 km for the 95 kt peak. Surface inflow 15 degrees. Linear best-track interpolation. Replaces, rather than adds to, the background wind inside 70 km; smooth transition to untouched ERA5 at 120 km. Pressure radial shape uses local ERA5 as environment. Pressure and wind radial profiles are independently constrained, not a dynamical simulation.',
        'best_track':track['provenance'],
        'inputs':[{'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [*days,track_file]],
        'original_weather':'The archived source arrays remain unchanged. The viewer evaluates the local synthetic field at the selected instant.',
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result,separators=(',',':'))+'\n')
    return result

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--day',type=Path,action='append',required=True)
    p.add_argument('--track',type=Path,default=Path('tools/history/tracy-track.json'))
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args(); prepare(a.day,a.track,a.output)
