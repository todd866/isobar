#!/usr/bin/env python3
"""Resume a bounded USGS historical-map metadata harvest (no raster downloads)."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import subprocess
from urllib.parse import urlencode
from urllib.request import urlopen,Request

BASE='https://tnmaccess.nationalmap.gov/api/v1/products'


def ingest_page(db,payload,offset):
    items=payload.get('items')
    if not isinstance(items,list) or not isinstance(payload.get('total'),int):
        raise ValueError('invalid USGS catalog response')
    with db:
        for item in items:
            identity=item.get('sourceId');bounds=item.get('boundingBox')
            if not isinstance(identity,str) or not isinstance(bounds,dict) or not item.get('title'):
                raise ValueError('invalid map metadata')
            db.execute('INSERT OR REPLACE INTO maps VALUES (?,?,?,?,?,?,?)',(
                identity,item['title'],item.get('publicationDate'),json.dumps(bounds),
                item.get('sizeInBytes'),json.dumps(item),'indexed'))
        db.execute('INSERT OR REPLACE INTO progress VALUES (?,?,?)',('usgs-htmc',offset+len(items),datetime.now(timezone.utc).isoformat()))
    return len(items)


def connect(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path)
    db.execute('CREATE TABLE IF NOT EXISTS maps (id TEXT PRIMARY KEY,title TEXT,date TEXT,bounds TEXT,bytes INTEGER,metadata TEXT,state TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS progress (source TEXT PRIMARY KEY,offset INTEGER,updated TEXT)')
    return db


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,default=Path('build/history/map-index.sqlite'))
    parser.add_argument('--pages',type=int,default=2)
    args=parser.parse_args()
    if not 1<=args.pages<=10: parser.error('1–10 pages per invocation')
    db=connect(args.database)
    try:
        row=db.execute('SELECT offset FROM progress WHERE source=?',('usgs-htmc',)).fetchone()
        offset=row[0] if row else 0
        for _ in range(args.pages):
            status=json.loads(subprocess.check_output(['/usr/bin/python3',str(Path.home()/'.codex/power/battery_guard.py'),'status']))
            if status.get('source')!='ac' and (status.get('percent') is None or status['percent']<=40):
                raise RuntimeError('battery hold; catalog checkpoint retained')
            url=BASE+'?'+urlencode({'datasets':'Historical Topographic Maps','max':100,'offset':offset})
            with urlopen(Request(url,headers={'User-Agent':'Isobar-History/1.0'}),timeout=30) as response:
                raw=response.read(4*1024*1024+1)
            if len(raw)>4*1024*1024: raise ValueError('metadata page too large')
            payload=json.loads(raw)
            count=ingest_page(db,payload,offset);offset+=count
            print(f'{offset}/{payload["total"]} map records indexed; rasters not downloaded',flush=True)
            if not count or offset>=payload['total']:break
    finally: db.close()
if __name__=='__main__':main()
