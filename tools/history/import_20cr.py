#!/usr/bin/env python3
"""Import one global 20CRv3 day from NCAR using cached, bounded HTTP ranges.

Annual files are never downloaded wholesale. Original byte ranges, their source
identity and hashes are retained beside the normalized hourly product.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.request import Request, urlopen
import numpy as np
from import_weather import write_atomic

BASE = 'https://tds.gdex.ucar.edu/thredds/fileServer/files/g/d131003/anl'
SPECS = {'pressure_msl': ('PRMSL_MSL', 'prmsl', 'Pa'), 'u': ('UGRD_10m', 'u10', 'm s**-1'),
         'v': ('VGRD_10m', 'v10', 'm s**-1'), 'temperature': ('TMP_2m', 't2m', 'K')}
EPOCH = datetime(1800, 1, 1, tzinfo=timezone.utc)

def admit():
    guard = Path.home()/'.codex/power/battery_guard.py'
    if not guard.exists(): raise RuntimeError('Battery guard unavailable')
    state = json.loads(subprocess.check_output(['/usr/bin/python3', str(guard), 'status']))
    if state.get('source') != 'ac' and (state.get('percent') is None or state['percent'] <= 40):
        raise RuntimeError('New downloads held by battery guard; cached progress is saved')

def atomic_bytes(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def text(value):
    return value.decode() if isinstance(value, bytes) else str(value)

class RangeFile:
    """Seekable range adapter with a shared transfer budget and immutable cache."""
    def __init__(self, url, directory, budget, opener=urlopen, block=1024*1024, read_ahead=1):
        self.url, self.directory, self.budget, self.opener = url, directory, budget, opener
        self.block, self.pos, self.cache, self.receipts = block, 0, {}, {}
        if type(read_ahead) is not int or not 1 <= read_ahead <= 8 or block <= 0: raise ValueError("Invalid range block policy")
        self.read_ahead = read_ahead
        with opener(Request(url, method='HEAD'), timeout=30) as response:
            self.size = int(response.headers.get('Content-Length', 0))
            self.modified = response.headers.get('Last-Modified')
        if self.size <= 0 or not self.modified: raise ValueError('Missing source file identity')
        directory.mkdir(parents=True, exist_ok=True)
        identity = {'url': url, 'bytes': self.size, 'last_modified': self.modified}
        metadata = directory/'source.json'
        if metadata.exists() and json.loads(metadata.read_text()) != identity:
            raise ValueError('Source changed; choose a new cache directory')
        write_atomic(identity, metadata)

    def seek(self, offset, whence=0):
        if whence not in (0, 1, 2): raise ValueError('invalid seek mode')
        position = offset + (0 if whence == 0 else self.pos if whence == 1 else self.size)
        if position < 0: raise ValueError('negative seek')
        self.pos = position
        return position

    def tell(self): return self.pos
    def flush(self): pass
    def close(self): self.cache.clear()

    def read(self, n=-1):
        end = self.size if n < 0 else min(self.size, self.pos+n)
        output = bytearray()
        while self.pos < end:
            base = self.pos//self.block*self.block
            stop = min(self.size, base+self.block)
            if base not in self.cache:
                path = self.directory/f'{base:012d}-{stop-1:012d}.bin'
                hash_path = path.with_suffix('.sha256')
                if path.exists() and hash_path.exists():
                    raw = path.read_bytes()
                    if len(raw) != stop-base or hashlib.sha256(raw).hexdigest() != hash_path.read_text().strip():
                        raise ValueError('Cached range hash mismatch')
                else:
                    fetch_stop = min(self.size, base+self.block*self.read_ahead)
                    for attempt in range(2):
                        if self.budget['bytes']+fetch_stop-base > self.budget['limit']:
                            raise ValueError('Total HTTP range transfer budget exceeded')
                        self.budget['bytes'] += fetch_stop-base
                        request = Request(self.url, headers={'Range': f'bytes={base}-{fetch_stop-1}',
                            'If-Unmodified-Since': self.modified, 'User-Agent': 'Isobar-History/1.0'})
                        print(f'Fetching {self.directory.name} range {base}-{fetch_stop-1}', flush=True)
                        try:
                            with self.opener(request, timeout=45) as response:
                                if response.status != 206 or response.headers.get('Content-Range') != f'bytes {base}-{fetch_stop-1}/{self.size}':
                                    raise ValueError('Server did not honor exact byte range')
                                length = response.headers.get('Content-Length')
                                if length is not None and int(length) != fetch_stop-base: raise ValueError('Incorrect range Content-Length')
                                fetched = response.read(fetch_stop-base)
                            break
                        except TimeoutError:
                            if attempt: raise
                    if len(fetched) != fetch_stop-base: raise ValueError('Incorrect range response length')
                    for offset in range(base, fetch_stop, self.block):
                        piece = fetched[offset-base:offset-base+self.block]
                        piece_path = self.directory/f'{offset:012d}-{offset+len(piece)-1:012d}.bin'
                        if piece_path.exists() and piece_path.read_bytes() != piece:
                            raise ValueError("Cached source bytes differ from response")
                        atomic_bytes(piece_path, piece)
                        atomic_bytes(piece_path.with_suffix('.sha256'), hashlib.sha256(piece).hexdigest().encode())
                    raw = fetched[:stop-base]
                self.cache[base] = raw
                self.receipts[base] = {'path': path.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            raw = self.cache[base]
            take = min(len(raw)-(self.pos-base), end-self.pos)
            output.extend(raw[self.pos-base:self.pos-base+take])
            self.pos += take
        return bytes(output)

def axes(step):
    if not math.isfinite(step) or not 1 <= step <= 90 or not math.isclose(180/step, round(180/step)):
        raise ValueError('Step must divide 180 and be between 1 and 90 degrees')
    return np.arange(90, -90.0001, -step), np.arange(-180, 180, step)

def hourly(planes, logical):
    if planes.shape[0] != 9 or not np.isfinite(planes).all() or np.max(np.abs(planes)) > 1e10:
        raise ValueError('Missing or invalid source field')
    lower = np.arange(24)//3
    fraction = (np.arange(24)%3 / 3)[:, None, None]
    values = planes[lower]*(1-fraction)+planes[lower+1]*fraction
    if logical == 'pressure_msl': values /= 100
    elif logical in ('u', 'v'): values *= 1.9438444924406
    else: values -= 273.15
    lo, hi = {'pressure_msl': (800,1100), 'u': (-300,300), 'v': (-300,300), 'temperature': (-120,70)}[logical]
    if values.min() < lo or values.max() > hi: raise ValueError('Source field outside physical bounds')
    return np.round(values, 3)

def import_data(args):
    import h5py
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.date): raise ValueError('Use YYYY-MM-DD')
    start = datetime.fromisoformat(args.date).replace(tzinfo=timezone.utc)
    if start.month == 12 and start.day == 31: raise ValueError('Year-boundary import requires the following annual file; not yet supported')
    lats, lons = axes(args.step)
    if not math.isfinite(args.max_mb) or args.max_mb <= 0: raise ValueError('max_mb must be positive')
    budget = {'bytes': 0, 'limit': int(args.max_mb*1024*1024)}
    target = (start-EPOCH).total_seconds()/3600
    frames = [{'time': (start+timedelta(hours=h)).strftime('%Y-%m-%dT%H:%MZ')} for h in range(24)]
    receipts = {}
    for logical, (stem, variable, units) in SPECS.items():
        name = f'anl_mean_{start.year}_{stem}.nc'
        directory = args.input_dir/str(start.year)/stem
        admit()
        source = RangeFile(f'{BASE}/{name}', directory, budget, read_ahead=4)
        print(f'{logical}: reading bounded daily planes', flush=True)
        try:
            with h5py.File(source, 'r') as ds:
                var = ds[variable]
                if text(var.attrs.get('units')) != units: raise ValueError(f'Unexpected {logical} units: {var.attrs.get("units")}')
                time = ds['time']
                if not re.fullmatch(r'hours since 1800-0?1-0?1 00:00:0?0(?:\.0+)?', text(time.attrs.get('units'))):
                    raise ValueError(f'Unexpected time units: {time.attrs.get("units")}')
                ts, lat, lon = np.asarray(time[:]), np.asarray(ds['latitude'][:]), np.asarray(ds['longitude'][:])
                if var.shape != (len(ts),256,512) or not np.all(np.diff(ts)==3): raise ValueError('Unexpected time/grid shape')
                if not np.isfinite(lat).all() or not np.all(np.diff(lat)<0) or not np.isclose(lat[0],89.4628,atol=.002) or not np.isclose(lat[-1],-89.4628,atol=.002):
                    raise ValueError('Unexpected Gaussian latitude axis')
                if not np.allclose(lon,np.arange(512)*360/512,atol=1e-4): raise ValueError('Unexpected longitude axis')
                matches = np.flatnonzero(ts == target)
                if len(matches) != 1: raise ValueError('Date not in source')
                index = int(matches[0])
                if not np.array_equal(ts[index:index+9],target+np.arange(9)*3): raise ValueError('Incomplete source day')
                print(f'{logical}: source index {index}, chunks {var.chunks}', flush=True)
                planes = np.asarray(var[index:index+9,:,:],dtype=np.float64)
                for key in ('_FillValue','missing_value'):
                    if key in var.attrs and np.any(planes == var.attrs[key]): raise ValueError('Missing source cells')
                planes = planes*float(var.attrs.get('scale_factor',1))+float(var.attrs.get('add_offset',0))
                li = np.abs(lat[:,None]-lats).argmin(0)
                distance = np.abs((lon[:,None]-lons+180)%360-180)
                lj = distance.argmin(0)
                values = hourly(planes[:,li,:][:,:,lj],logical)
                for frame, value in zip(frames,values): frame[logical] = value.ravel().tolist()
        finally:
            source.close()
        receipts[logical] = {'url': source.url, 'content_length': source.size, 'last_modified': source.modified,
            'cache_directory': f'{start.year}/{stem}', 'ranges': list(source.receipts.values())}
        source.cache.clear()
        print(f'{logical}: complete; {budget["bytes"]/1024/1024:.1f} MiB transferred in total', flush=True)
    provenance = {'provider':'NCAR GDEX / NOAA-CIRES-DOE', 'dataset':'20CRv3 ensemble mean',
        'retrieved_at':datetime.now(timezone.utc).isoformat(), 'license':'CC BY 4.0; NOAA-CIRES-DOE 20CRv3, NCAR GDEX d131003',
        'citation':'https://gdex.ucar.edu/datasets/d131003/', 'source_resolution':'Gaussian T254 512×256, 3-hourly',
        'sampling_limitations':'Three-hourly reanalysis linearly interpolated to hourly; nearest Gaussian source cell sampled to a regular global grid. Not direct observations or local terrain downscaling.',
        'source_files':receipts, 'download_bytes':budget['bytes']}
    result = {'schema_version':1,'product':'isobar-historical-weather',
        'event':{'id':args.event_id,'label':args.label,'start_date':args.date,'end_date':args.date},
        'model':'NOAA-CIRES-DOE 20CRv3',
        'grid':{'latitudes':lats.tolist(),'longitudes':lons.tolist(),'nx':len(lons),'ny':len(lats),
            'order':'north-to-south, west-to-east','step_degrees':args.step,'wraps_longitude':True},
        'times':[f['time'] for f in frames],'frames':frames,
        'units':{'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'},'provenance':provenance}
    write_atomic(result,args.output)
    write_atomic(provenance,args.output.with_suffix('.receipts.json'))
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date',required=True)
    parser.add_argument('--event-id',required=True)
    parser.add_argument('--label',required=True)
    parser.add_argument('--step',type=float,default=2.5)
    parser.add_argument('--input-dir',type=Path,default=Path('build/history/20cr-cache'))
    parser.add_argument('--max-mb',type=float,default=256)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    result=import_data(args)
    print(f'Wrote {len(result["frames"])} complete hourly frames to {args.output}')
if __name__=='__main__': main()
