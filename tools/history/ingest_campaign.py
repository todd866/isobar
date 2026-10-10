#!/usr/bin/env python3
"""Run a bounded slice of the curated global-weather queue; resume on rerun."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from publish_catalog import publish,complete_days


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs',type=int,default=1)
    parser.add_argument('--max-mb',type=int,default=512,help='per-job download cap')
    args=parser.parse_args()
    if not 1<=args.jobs<=5:parser.error('1–5 new jobs per invocation')
    root=Path(__file__).resolve().parents[2]
    queue=json.loads((root/'tools/history/campaign.json').read_text())['jobs']
    remaining=args.jobs
    for job in queue:
        output=root/'build/history'/f'{job["id"]}-global.json'
        # Existing files must be valid and match this exact queued identity/range.
        cached=None
        if output.exists():
            cached=json.loads(output.read_text());complete_days(cached)
            if cached['event']['id']!=job['id'] or cached['event']['start_date']!=job['start'] or cached['event']['end_date']!=job['end']:
                raise ValueError('cached job differs from queue; inspect before replacement')
        if cached is None:
            if not remaining: break
            command=[sys.executable,str(root/'tools/history/import_arco.py'),'--start-date',job['start'],'--end-date',job['end'],
                '--event-id',job['id'],'--label',job['label'],'--output',str(output),'--max-mb',str(args.max_mb)]
            subprocess.run(['/usr/bin/python3',str(Path.home()/'.codex/power/battery_guard.py'),'run','--',*command],cwd=root,check=True)
            remaining-=1
        maps=json.loads((root/job['maps']).read_text()) if job.get('maps') else []
        publish(output,root/'web/public/history',maps)
        print(f'{job["label"]}: ready',flush=True)
if __name__=='__main__':main()
