#!/usr/bin/env python3
"""Stage completed daily assets in one Everest collection; never deploys."""
import argparse
import hashlib
import json
from pathlib import Path
from import_weather import write_atomic
from publish_catalog import complete_days

def publish(inputs,root):
    catalog_path=root/'catalog.json'
    catalog=json.loads(catalog_path.read_text())
    entry=next(c for c in catalog['collections'] if c['id']=='everest-1953')
    manifest=json.loads((root/Path(entry['manifest']).name).read_text())
    days={d['date']:d for d in [*entry['days'],*manifest['days']]}
    added=[]
    for folder in inputs:
        for source in sorted(folder.glob('????-??-??.json')):
            weather=json.loads(source.read_text())
            if weather['event']['id']!='everest-1953':raise ValueError('unexpected event')
            complete=complete_days(weather)
            if len(complete)!=1 or len(weather['times'])!=24:raise ValueError('expected one complete day')
            provenance=weather.get('provenance',{})
            if provenance.get('dataset')!='ERA5 reanalysis' or not provenance.get('source','').startswith('https://storage.googleapis.com/gcp-public-data-arco-era5/') or not provenance.get('license'):raise ValueError('unexpected weather provenance')
            day=complete[0]['date']
            if source.stem!=day:raise ValueError('date filename mismatch')
            encoded=json.dumps(weather,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
            digest=hashlib.sha256(encoded).hexdigest()[:16]
            name=f'everest-1953-{day}-{digest}.json'
            previous=days.get(day)
            if previous:
                if not previous.get('weather'):continue # Preserve the existing multi-day summit asset.
                if previous['weather']!='/history/'+name:raise ValueError(f'conflicting asset for {day}; retain prior version for review')
            write_atomic(weather,root/name)
            days[day]={'date':day,'complete':True,'weather':'/history/'+name};added.append(day)
    manifest['days']=sorted(days.values(),key=lambda d:d['date'])
    digest=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:16]
    name=f'everest-1953-manifest-{digest}.json';write_atomic(manifest,root/name)
    entry.update(manifest='/history/'+name,days=manifest['days'])
    write_atomic(catalog,catalog_path)
    return added

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,action='append',required=True);p.add_argument('--root',type=Path,required=True)
    args=p.parse_args();print(json.dumps({'staged':publish(args.input,args.root)}))
