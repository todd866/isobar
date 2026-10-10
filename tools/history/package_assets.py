#!/usr/bin/env python3
"""Build an immutable, checked public/history closure; never deploy or copy raw archives."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from publish_catalog import complete_days


def encoded(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()


def local_asset(root,url):
    if not isinstance(url,str) or not url.startswith('/history/'):
        raise ValueError('only local /history assets can be packaged')
    path=(root/url.removeprefix('/history/')).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('missing or unsafe historical asset')
    return path


def weather_asset(root,url,event_id,expected_days):
    """Read and validate a weather asset advertised by a collection day."""
    weather=json.loads(local_asset(root,url).read_text())
    if weather.get('event',{}).get('id') != event_id:
        raise ValueError('day weather asset has the wrong event')
    days=complete_days(weather)
    if days != [{'date':expected_days,'complete':True}]:
        raise ValueError('day weather asset does not match its advertised day')
    return weather


def package(root,destination,imagery_receipt=None):
    if destination.exists():raise ValueError('destination already exists; bundles are immutable')
    # This receipt is also imported by the terrain renderer, including present-day
    # Everest. Treat its image as a required runtime asset, not a catalog extra.
    if imagery_receipt is None:
        imagery_receipt=json.loads((Path(__file__).resolve().parents[2]/'web/src/lib/terrain/everest-imagery.json').read_text())
    image_name='imagery/'+imagery_receipt['sha256']+'.png'
    image=local_asset(root,'/history/'+image_name).read_bytes()
    if hashlib.sha256(image).hexdigest()!=imagery_receipt['sha256'] or len(image)!=imagery_receipt['bytes']:
        raise ValueError('terrain imagery does not match the renderer receipt')
    catalog=json.loads((root/'catalog.json').read_text())
    payloads={image_name:image}
    collections=[]
    weather_sources={}
    for item in catalog['collections']:
        manifest=json.loads(local_asset(root,item['manifest']).read_text())
        weather=json.loads(local_asset(root,manifest['weather']).read_text())
        provenance=weather.get('provenance',{})
        weather_sources[item['id']]={key:provenance[key] for key in ('provider','source','dataset','license','attribution','citation','source_resolution','source_resolution_degrees','sampling_limitations') if key in provenance}
        default_days=complete_days(weather)
        default_dates={day['date'] for day in default_days}
        advertised_days=[{k:v for k,v in day.items() if k!='weather'} for day in item['days']]
        manifest_days=[{k:v for k,v in day.items() if k!='weather'} for day in manifest['days']]
        if advertised_days!=manifest_days or weather['event']['id']!=item['id']:
            raise ValueError('catalog, manifest and weather disagree')
        if len(item['days']) != len(manifest['days']):
            raise ValueError('catalog, manifest and weather disagree')
        if any(item_day.get('weather') != manifest_day.get('weather')
               for item_day,manifest_day in zip(item['days'],manifest['days'])):
            raise ValueError('catalog and manifest day assets disagree')
        # The local research scan is not cleared for public redistribution.
        manifest['maps']=[]

        def add_weather_asset(asset):
            raw=encoded(asset)
            name=f"{item['id']}-{hashlib.sha256(raw).hexdigest()[:16]}.json"
            payloads.setdefault(name,raw)
            return '/history/'+name

        raw=encoded(weather)
        name=f"{item['id']}-{hashlib.sha256(raw).hexdigest()[:16]}.json"
        payloads.setdefault(name,raw)
        manifest['weather']='/history/'+name

        packaged_days=[]
        for day in item['days']:
            if day.get('weather'):
                daily=weather_asset(root,day['weather'],item['id'],day['date'])
                day=dict(day,weather=add_weather_asset(daily))
            elif day['date'] not in default_dates:
                raise ValueError('default weather does not cover advertised day')
            packaged_days.append(day)
        manifest['days']=packaged_days
        raw=encoded(manifest)
        name=f"{item['id']}-manifest-{hashlib.sha256(raw).hexdigest()[:16]}.json"
        payloads.setdefault(name,raw)
        collections.append(dict(item,manifest='/history/'+name,days=packaged_days))
    collections.sort(key=lambda item:(item['id']!='dday',item['days'][0]['date']))
    payloads['catalog.json']=encoded(dict(catalog,collections=collections))
    for name in ('world-coast.bin','themes/wwii-paper.png'):
        payloads[name]=local_asset(root,'/history/'+name).read_bytes()
    files=[{'path':'history/'+name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in sorted(payloads.items())]
    inventory={'schema_version':1,'collections':[{'id':x['id'],'days':len(x['days'])} for x in collections],
        'total_bytes':sum(f['bytes'] for f in files),'files':files,
        'omitted':'Local Omaha facsimile omitted; original source remains linked in the UI.',
        'attribution':{'weather':weather_sources,
                       'terrain_imagery':{key:imagery_receipt[key] for key in ('source','license','attribution','historical_relevance') if key in imagery_receipt},
                       'geography':'Natural Earth (public domain)','paper':'AI-generated chart-style paper'}}
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary=Path(tempfile.mkdtemp(prefix='.history-package-',dir=destination.parent))
    try:
        for name,raw in payloads.items():
            path=temporary/'history'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        (temporary/'asset-manifest.json').write_bytes(encoded(inventory))
        temporary.rename(destination)
    finally:
        if temporary.exists():shutil.rmtree(temporary)
    return inventory


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path('web/public/history'))
    parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args();result=package(args.root,args.destination)
    print(f"Packaged {len(result['collections'])} collections, {result['total_bytes']} bytes at {args.destination}")
