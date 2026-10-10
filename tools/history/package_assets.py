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


def package(root,destination):
    if destination.exists():raise ValueError('destination already exists; bundles are immutable')
    catalog=json.loads((root/'catalog.json').read_text())
    payloads={}
    collections=[]
    for item in catalog['collections']:
        manifest=json.loads(local_asset(root,item['manifest']).read_text())
        weather=json.loads(local_asset(root,manifest['weather']).read_text())
        days=complete_days(weather)
        if days!=item['days'] or days!=manifest['days'] or weather['event']['id']!=item['id']:
            raise ValueError('catalog, manifest and weather disagree')
        # The local research scan is not cleared for public redistribution.
        manifest['maps']=[]
        raw=encoded(weather)
        name=f"{item['id']}-{hashlib.sha256(raw).hexdigest()[:16]}.json"
        payloads[name]=raw
        manifest['weather']='/history/'+name
        raw=encoded(manifest)
        name=f"{item['id']}-manifest-{hashlib.sha256(raw).hexdigest()[:16]}.json"
        payloads[name]=raw
        collections.append(dict(item,manifest='/history/'+name))
    collections.sort(key=lambda item:(item['id']!='dday',item['days'][0]['date']))
    payloads['catalog.json']=encoded(dict(catalog,collections=collections))
    for name in ('world-coast.bin','themes/wwii-paper.png'):
        payloads[name]=local_asset(root,'/history/'+name).read_bytes()
    files=[{'path':'history/'+name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in sorted(payloads.items())]
    inventory={'schema_version':1,'collections':[{'id':x['id'],'days':len(x['days'])} for x in collections],
        'total_bytes':sum(f['bytes'] for f in files),'files':files,
        'omitted':'Local Omaha facsimile omitted; original source remains linked in the UI.',
        'attribution':{'weather':'Contains modified Copernicus Climate Change Service information. ERA5, via Google ARCO.',
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
