#!/usr/bin/env python3
"""Finite, serial, resumable Everest journey weather collection (no deployment)."""
import argparse
from datetime import date,timedelta,datetime,timezone
import fcntl
import json
from pathlib import Path
import shutil
import subprocess
import sys
from import_weather import write_atomic
from publish_catalog import complete_days

def run(args):
    start,end=date.fromisoformat(args.start),date.fromisoformat(args.end)
    if not 0 <= (end-start).days < 92: raise ValueError('request1–92days')
    root=args.root;root.mkdir(parents=True,exist_ok=True)
    lock=(args.lock_file or root/'collection.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|(0 if args.wait_for_lock else fcntl.LOCK_NB))
    cache=root/'arco-cache'; output=root/'weather';output.mkdir(exist_ok=True)
    previous=json.loads((root/'checkpoint.json').read_text()) if (root/'checkpoint.json').exists() else {}
    history=previous.get('attempts',[])
    if previous:
        if previous.get('start')!=args.start or previous.get('end')!=args.end:raise ValueError('checkpoint range differs; use another root')
        history=(history+[{'updatedAt':previous.get('updatedAt'),'state':previous.get('state'),'completedCount':len(previous.get('completed',[])),'error':previous.get('error')}])[-20:]
    checkpoint={'start':args.start,'end':args.end,'state':'running','completed':[],'updatedAt':None,'attempts':history,'startedAt':previous.get('startedAt') or datetime.now(timezone.utc).isoformat()}
    # Revalidate files on resume; prior attempts remain in the bounded audit history.
    def save(state):
        checkpoint['state']=state;checkpoint['updatedAt']=datetime.now(timezone.utc).isoformat();write_atomic(checkpoint,root/'checkpoint.json')
    save('running')
    try:
        day=start
        while day<=end:
            stamp=day.isoformat();target=output/f'{stamp}.json'
            if target.exists():
                data=json.loads(target.read_text())
                if [d['date'] for d in complete_days(data)]!=[stamp] or data['event']['id']!='everest-1953':raise ValueError('cached day mismatch')
            else:
                if shutil.disk_usage(root).free<(args.disk_floor_gb+2)*1024**3:raise RuntimeError('disk headroom floor reached')
                cached=sum(p.stat().st_size for p in cache.rglob('*') if p.is_file()) if cache.exists() else 0
                if cached+1024**3>args.max_total_mb*1024**2:raise RuntimeError('collection cache budget reached')
                command=[sys.executable,str(Path(__file__).with_name('import_arco.py')),'--start-date',stamp,'--end-date',stamp,'--event-id','everest-1953','--label','Everest1953','--step','2.5','--cache',str(cache),'--output',str(target),'--max-mb','1024']
                subprocess.run(['/usr/bin/python3',str(Path.home()/'.codex/power/battery_guard.py'),'run','--',*command],check=True)
                if [d['date'] for d in complete_days(json.loads(target.read_text()))]!=[stamp]:raise ValueError('incomplete day')
            checkpoint['completed'].append(stamp);save('running');print(f'{stamp} archived ({len(checkpoint["completed"])}days)',flush=True)
            day+=timedelta(days=1)
        save('complete')
    except BaseException as error:
        checkpoint['error']=str(error);save('stopped');raise
    finally:lock.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--start',default='1953-03-10');p.add_argument('--end',default='1953-05-30')
    p.add_argument('--lock-file',type=Path);p.add_argument('--wait-for-lock',action='store_true')
    p.add_argument('--root',type=Path,required=True);p.add_argument('--max-total-mb',type=int,default=24576);p.add_argument('--disk-floor-gb',type=int,default=50)
    args=p.parse_args()
    if not 1024<=args.max_total_mb<=32768 or args.disk_floor_gb<20:p.error('invalid storage bounds')
    run(args)
