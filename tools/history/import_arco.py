#!/usr/bin/env python3
"""Bounded, resumable global ERA5 import from Google's public ARCO archive.

Reads the source coordinate arrays rather than assuming a time origin. Caches
immutable compressed surface chunks; no bulk pressure-level arrays are read.
The website catalog is published separately after validation.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
import re
from urllib.request import Request, urlopen
import numpy as np
from numcodecs import get_codec
from import_weather import write_atomic

BASE = 'https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3'
VARIABLES = {'pressure_msl': ('mean_sea_level_pressure', 0.01, 0),
             'u': ('10m_u_component_of_wind', 1.9438444924406, 0),
             'v': ('10m_v_component_of_wind', 1.9438444924406, 0),
             'temperature': ('2m_temperature', 1, -273.15)}
GUARD = Path.home() / '.codex/power/battery_guard.py'


def admit():
    if not GUARD.exists():
        raise RuntimeError('battery guard unavailable')
    state = json.loads(subprocess.check_output(['/usr/bin/python3', str(GUARD), 'status']))
    if state.get('source') != 'ac' and (state.get('percent') is None or state['percent'] <= 40):
        raise RuntimeError('new downloads held by battery guard; cached progress is saved')


class Archive:
    def __init__(self, cache: Path, max_bytes: int):
        self.cache, self.max_bytes, self.downloaded = cache, max_bytes, 0
        self.receipts = {}
        self.cache.mkdir(parents=True, exist_ok=True)

    def get(self, path, limit=8*1024*1024):
        # Only program-owned relative array/chunk paths reach the fixed host.
        if path.startswith('/') or '..' in path.split('/'):
            raise ValueError('invalid archive path')
        target = self.cache / path
        if target.is_file():
            raw = target.read_bytes()
            if len(raw) > limit:
                raise ValueError('oversize cached chunk')
        else:
            admit()
            if self.downloaded + limit > self.max_bytes:
                raise RuntimeError('download budget reached; rerun to resume cached work')
            with urlopen(Request(BASE + '/' + path, headers={'User-Agent': 'Isobar-History/1.0'}), timeout=45) as response:
                raw = response.read(limit + 1)
            if len(raw) > limit:
                raise ValueError('archive response exceeds byte cap')
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + '.part')
            temporary.write_bytes(raw)
            temporary.replace(target)
            self.downloaded += len(raw)
        self.receipts[path] = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        return raw

    def meta(self, path):
        return json.loads(self.get(path, 1024*1024))

    def decode(self, path, meta):
        raw = self.get(path)
        decoded = get_codec(meta['compressor']).decode(raw) if meta['compressor'] else raw
        expected = math.prod(meta['chunks']) * np.dtype(meta['dtype']).itemsize
        if len(decoded) != expected:
            raise ValueError(f'incorrect decompressed length: {path}')
        return np.frombuffer(decoded, dtype=meta['dtype']).reshape(meta['chunks'], order=meta['order'])

    def coordinate(self, name):
        meta = self.meta(name + '/.zarray')
        if meta['zarr_format'] != 2 or len(meta['shape']) != 1 or meta['filters']:
            raise ValueError('unsupported coordinate encoding')
        count = math.ceil(meta['shape'][0] / meta['chunks'][0])
        if count > 32:
            raise ValueError('unexpectedly large coordinate axis')
        return np.concatenate([self.decode(f'{name}/{i}', meta) for i in range(count)])[:meta['shape'][0]]


def dates(start, end):
    if not all(re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) for value in (start,end)):
        raise ValueError('dates must be YYYY-MM-DD')
    a, b = datetime.fromisoformat(start), datetime.fromisoformat(end)
    if a.time() != datetime.min.time() or b.time() != datetime.min.time() or not 0 <= (b-a).days < 7:
        raise ValueError('request 1–7 complete calendar days')
    return [a + timedelta(hours=i) for i in range(((b-a).days+1)*24)]


def import_data(args):
    times = dates(args.start_date, args.end_date)
    if args.step not in (1, 2, 2.5, 5):
        raise ValueError('supported global sampling: 1, 2, 2.5, 5 degrees')
    archive = Archive(args.cache, args.max_mb*1024*1024)
    attrs = archive.meta('.zattrs')
    if args.start_date < attrs['valid_time_start'][:10] or args.end_date > attrs['valid_time_stop'][:10]:
        raise ValueError('date outside final ERA5 coverage')
    tattrs = archive.meta('time/.zattrs')
    if tattrs['units'] != 'hours since 1900-01-01 00:00:00' or tattrs['calendar'] != 'proleptic_gregorian':
        raise ValueError('unsupported source time axis')
    source_times = archive.coordinate('time')
    source_lat = archive.coordinate('latitude')
    source_lon = archive.coordinate('longitude')
    if not np.array_equal(source_lat, np.arange(90, -90.01, -.25)) or not np.array_equal(source_lon, np.arange(0, 360, .25)):
        raise ValueError('unexpected source spatial axes')
    lats = np.arange(90, -90.001, -args.step)
    lons = np.arange(-180, 180, args.step)
    ilat = np.rint((90-lats)/.25).astype(int)
    ilon = np.rint((lons % 360)/.25).astype(int)
    metas = {field: archive.meta(name+'/.zarray') for field,(name,_,_) in VARIABLES.items()}
    for field,meta in metas.items():
        varattrs=archive.meta(VARIABLES[field][0]+'/.zattrs')
        expected_unit={'pressure_msl':'Pa','u':'m s**-1','v':'m s**-1','temperature':'K'}[field]
        if varattrs.get('units') != expected_unit or varattrs.get('_ARRAY_DIMENSIONS') != ['time','latitude','longitude']:
            raise ValueError(f'unexpected source units/dimensions for {field}')
        if meta.get('zarr_format')!=2 or meta['shape'] != [len(source_times),721,1440]:
            raise ValueError('unexpected surface array shape')
        if meta['chunks'] != [1,721,1440] or meta['dtype'] != '<f4' or meta['order'] != 'C' or meta['filters']:
            raise ValueError('unexpected surface array encoding')
    frames = []
    origin = datetime(1900,1,1)
    for instant in times:
        hour = int((instant-origin).total_seconds()/3600)
        indexes = np.flatnonzero(source_times == hour)
        if len(indexes) != 1:
            raise ValueError('source time is absent or ambiguous')
        index = int(indexes[0])
        frame = {'time': instant.strftime('%Y-%m-%dT%H:%MZ')}
        # Serial, bounded acquisition deliberately cooperates with shared load.
        for field,(name,scale,offset) in VARIABLES.items():
            grid = archive.decode(f'{name}/{index}.0.0', metas[field])[0]
            values = grid[np.ix_(ilat,ilon)].astype(np.float64)*scale+offset
            if not np.isfinite(values).all():
                raise ValueError(f'missing values in {field} at {instant}')
            lo,hi = {'pressure_msl':(800,1100),'u':(-300,300),'v':(-300,300),'temperature':(-120,70)}[field]
            if values.min() < lo or values.max() > hi:
                raise ValueError(f'implausible values in {field}')
            frame[field] = np.round(values,3).ravel().tolist()
        frames.append(frame)
        print(f'{frame["time"]}: {len(frames)}/{len(times)} hours; {archive.downloaded//1048576} MiB downloaded', flush=True)
    stamps = [f['time'] for f in frames]
    result = {'schema_version':1,'product':'isobar-historical-weather',
        'event':{'id':args.event_id,'label':args.label,'start_date':args.start_date,'end_date':args.end_date},
        'model':'ERA5','grid':{'latitudes':lats.tolist(),'longitudes':lons.tolist(),'nx':len(lons),'ny':len(lats),
            'order':'north-to-south, west-to-east','step_degrees':args.step,'wraps_longitude':True},
        'times':stamps,'frames':frames,'units':{'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'},
        'provenance':{'provider':'ECMWF / Copernicus · Google ARCO-ERA5','dataset':'ERA5 reanalysis','model':'era5',
            'source':BASE,'license':'Copernicus licence; see source registry for terms and attribution',
            'retrieved_at':datetime.now(timezone.utc).isoformat(),'source_metadata':attrs,
            'sampling_limitations':f'Global ERA5 reanalysis sampled every {args.step}°. Interpolation is a visual estimate; period map facsimiles are separate.',
            'attribution':'Contains modified Copernicus Climate Change Service information. ERA5 by ECMWF; public mirror by Google Research.',
            'source_resolution_degrees':.25,'downloaded_bytes':archive.downloaded}}
    write_atomic(result,args.output)
    write_atomic({'source':BASE,'chunks':archive.receipts},args.output.with_suffix('.receipts.json'))
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--start-date',default='1944-06-06');p.add_argument('--end-date',default='1944-06-06')
    p.add_argument('--event-id',default='dday');p.add_argument('--label',default='D-Day · World')
    p.add_argument('--step',type=float,default=2.5);p.add_argument('--max-mb',type=int,default=512)
    p.add_argument('--cache',type=Path,default=Path('build/history/arco-cache'))
    p.add_argument('--output',type=Path,default=Path('build/history/dday-global.json'))
    args=p.parse_args()
    if not 16 <= args.max_mb <= 2048: p.error('byte budget must be 16–2048 MiB')
    import_data(args)
if __name__=='__main__': main()
