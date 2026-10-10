#!/usr/bin/env python3
"""Build a 48-hour Katrina scene from immutable ERA5 hourly products."""
import argparse, hashlib, json, math
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROFILE = {'exponent': 1.75, 'blendStartKm': 370.0, 'blendEndKm': 600.0}

def prepare(days, track_file, output):
    if output.exists(): raise ValueError('output must be new')
    if len(days) not in (1, 2): raise ValueError('requires one 48-hour file or two daily weather files')
    data = [json.loads(p.read_text()) for p in days]
    frames = sorted((f for d in data for f in d.get('frames', [])), key=lambda f: f['time'])
    if len(frames) != 48: raise ValueError('requires exactly 48 hourly frames')
    times = [f['time'] for f in frames]
    first = datetime.fromisoformat(times[0].replace('Z', '+00:00'))
    if times[0] != '2005-08-28T00:00Z' or times[-1] != '2005-08-29T23:00Z': raise ValueError('Katrina weather must cover exactly 28–29 August 2005 UTC')
    expected = [(first + timedelta(hours=i)).strftime('%Y-%m-%dT%H:%MZ') for i in range(48)]
    if times != expected: raise ValueError('weather frames must be contiguous hourly UTC')
    if any(d.get('grid') != data[0].get('grid') for d in data): raise ValueError('source grids differ')
    expected_units = {'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'}
    if any(d.get('units') != expected_units for d in data): raise ValueError('source units must match ERA5 schema')
    if any(d.get('times') != [f['time'] for f in d.get('frames', [])] for d in data): raise ValueError('declared times differ from frames')
    track = json.loads(track_file.read_text())
    observations = track.get('observations')
    if not isinstance(observations, list) or len(observations) < 2: raise ValueError('track requires at least two fixes')
    previous = None
    for row in observations:
        try: current = datetime.fromisoformat(row['time'].replace('Z', '+00:00'))
        except Exception as exc: raise ValueError('track times must be ISO UTC') from exc
        if current.tzinfo is None or row['time'] != current.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%MZ') or previous is not None and current <= previous:
            raise ValueError('track fixes must be strictly ordered UTC times')
        previous = current
        for key, low, high in (('lat', -60, 60), ('lon', -180, 180), ('wind_kt', 0, 180), ('pressure_hpa', 870, 1030)):
            value = row.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f'invalid track {key}')
    fixes = [r for r in observations if times[0] <= r['time'] <= times[-1]]
    before = [r for r in observations if r['time'] < times[0]]
    after = [r for r in observations if r['time'] > times[-1]]
    if before: fixes.insert(0, before[-1])
    if after: fixes.append(after[0])
    if len(fixes) < 2 or (not before and fixes[0]['time'] != times[0]) or not after: raise ValueError('track lacks bracketing fixes for weather interval')
    result = dict(data[0], times=times, frames=frames)
    result['event'] = {'id':'katrina-2005', 'label':'Katrina', 'start_date':times[0][:10], 'end_date':times[-1][:10]}
    result['cyclone'] = {'method':'compact-vortex-v1', 'rmwKm':55, 'profile':PROFILE, 'track':[{'time':r['time'],'lat':r['lat'],'lon':r['lon'],'windKt':r['wind_kt'],'pressureHpa':r['pressure_hpa']} for r in fixes], 'source':track['provenance']['record_url']}
    result['reconstruction'] = {'kind':'synthetic-local-vortex','method':'compact-vortex-v1','assumptions':'Axisymmetric radial profile with synthetic 55 km RMW, exponent 1.75, and 370–600 km blend. NHC documented hurricane-force winds extending about 90 nmi and tropical-storm-force winds about 200 nmi late 28 August; the fixed profile is a visualization assumption, not a measured RMW. Linear interpolation between NHC fixes; original ERA5 arrays remain unchanged.','best_track':track['provenance'],'inputs':[{'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [*days,track_file]]}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(result,separators=(',',':'),allow_nan=False)+'\n'); return result

if __name__ == '__main__':
    p=argparse.ArgumentParser(); p.add_argument('--day',type=Path,action='append',required=True); p.add_argument('--track',type=Path,default=Path('tools/history/katrina-track.json')); p.add_argument('--output',type=Path,required=True); a=p.parse_args(); prepare(a.day,a.track,a.output)
