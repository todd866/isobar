#!/usr/bin/env python3
"""Stage a verified historical collection in the website's local public assets.

Publication here means local catalog visibility, never deployment. Only complete
UTC days with all required fields enter the date selector. Weather asset names
are content-addressed so a cached catalog cannot point at a replaced collection.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import re
from import_weather import write_atomic


def complete_days(weather):
    if weather.get('schema_version') != 1 or weather.get('product') != 'isobar-historical-weather':
        raise ValueError('unsupported weather schema')
    grid=weather['grid']; nx,ny=grid['nx'],grid['ny']
    if type(nx) is not int or type(ny) is not int or nx<2 or ny<2 or nx*ny>300000:
        raise ValueError('invalid grid')
    if len(grid['latitudes'])!=ny or len(grid['longitudes'])!=nx:
        raise ValueError('coordinate lengths do not match grid')
    for axis,lo,hi,descending in [('latitudes',-90,90,True),('longitudes',-180,180,False)]:
        values=grid[axis]
        if any(type(v) not in (int,float) or not math.isfinite(v) or not lo<=v<=hi for v in values):
            raise ValueError('invalid coordinates')
        if any((a<=b if descending else a>=b) for a,b in zip(values,values[1:])):
            raise ValueError('coordinates out of order')
    if weather['units']!={'pressure_msl':'hPa','u':'knots','v':'knots','temperature':'°C'}:
        raise ValueError('unexpected units')
    if len(weather['frames'])!=len(weather['times']): raise ValueError('time length mismatch')
    grouped={}; previous=None
    for stamp,frame in zip(weather['times'],weather['frames']):
        if frame['time']!=stamp or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:00Z',stamp):
            raise ValueError('invalid frame timestamp')
        instant=datetime.strptime(stamp,'%Y-%m-%dT%H:%MZ')
        if previous is not None and instant<=previous: raise ValueError('unordered time axis')
        previous=instant
        for field in ('pressure_msl','u','v','temperature'):
            values=frame[field]
            if len(values)!=nx*ny or any(type(v) not in (int,float) or not math.isfinite(v) for v in values):
                raise ValueError('incomplete frame')
        grouped.setdefault(stamp[:10],[]).append(instant.hour)
    return [{'date':day,'complete':True} for day,hours in grouped.items() if hours==list(range(24))]


def publish(source,root,maps=None):
    weather=json.loads(source.read_text())
    days=complete_days(weather)
    if not days: raise ValueError('no complete day to publish')
    event=weather['event']; identity=event['id']
    if not re.fullmatch('[a-z0-9-]{1,60}',identity): raise ValueError('invalid event id')
    root.mkdir(parents=True,exist_ok=True)
    encoded=json.dumps(weather,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
    digest=hashlib.sha256(encoded).hexdigest()[:16]
    asset=f'{identity}-{digest}.json'
    write_atomic(weather,root/asset)
    manifest={'schema_version':1,'collection':{'id':identity,'title':event['label']},'weather':'/history/'+asset,'maps':maps or [],'days':days}
    manifest_digest=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:16]
    manifest_name=f'{identity}-manifest-{manifest_digest}.json'
    write_atomic(manifest,root/manifest_name)
    catalog_path=root/'catalog.json'
    catalog=json.loads(catalog_path.read_text()) if catalog_path.exists() else {'schema_version':1,'collections':[]}
    entry={'id':identity,'title':event['label'],'manifest':'/history/'+manifest_name,'days':days}
    catalog['collections']=[entry]+[c for c in catalog['collections'] if c['id']!=identity]
    write_atomic(catalog,catalog_path)
    return entry

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('--root',type=Path,default=Path('web/public/history'))
    parser.add_argument('--maps',type=Path)
    args=parser.parse_args()
    result=publish(args.source,args.root,json.loads(args.maps.read_text()) if args.maps else [])
    print(f"Staged {result['title']}: {len(result['days'])} complete days")
