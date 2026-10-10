#!/usr/bin/env python3
"""Validate a staged Everest weather artifact and write its derived-data receipt."""
import argparse
import hashlib
import json
from pathlib import Path
from publish_catalog import complete_days

def validate(path):
    raw=path.read_bytes();weather=json.loads(raw)
    if weather.get('event',{}).get('id')!='everest-1953':raise ValueError('wrong event')
    if complete_days(weather)!=[{'date':'1953-05-28','complete':True},{'date':'1953-05-29','complete':True}]:raise ValueError('requires both complete summit-window days')
    if len(weather['frames'])!=48:raise ValueError('requires 48 hourly frames')
    grid=weather['grid']
    if (grid['nx'],grid['ny'],grid['step_degrees'])!=(144,73,2.5):raise ValueError('unexpected global sampling')
    if grid['longitudes']!=[-180+i*2.5 for i in range(144)] or grid['latitudes']!=[90-i*2.5 for i in range(73)]:raise ValueError('unexpected coordinate axes')
    return {'schema_version':1,'event':'everest-1953','artifact':path.name,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'source':weather['provenance']['source'],'period_utc':['1953-05-28T00:00Z','1953-05-29T23:00Z'],'frame_count':48,'extraction':{'tool':'tools/history/import_arco.py','sampling':'nearest existing 0.25 degree ERA5 grid cells at a 2.5 degree global lattice; no temporal subsampling','variables':{'pressure_msl':'mean_sea_level_pressure / 100 hPa','u':'10m_u_component_of_wind * 1.9438444924406 knots','v':'10m_v_component_of_wind * 1.9438444924406 knots','temperature':'2m_temperature - 273.15 Celsius'},'rounding_decimals':3},'classification':'reanalysis, not direct observations'}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('weather',type=Path);p.add_argument('--receipt',type=Path,required=True);a=p.parse_args();receipt=validate(a.weather);a.receipt.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
