#!/usr/bin/env python3
"""Acquire bounded, source-addressable Katrina satellite and marine assets."""
from pathlib import Path
from urllib.request import Request, urlopen
import argparse, hashlib, json, os, tempfile

MAX_TOTAL_BYTES = 100 * 1024 * 1024
ASSETS = {
 'katrina-modis-terra-20050828-gulf.png': 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE&SRS=EPSG:4326&BBOX=-98,20,-78,36&WIDTH=1280&HEIGHT=1024&TIME=2005-08-28',
 'katrina-modis-terra-20050829-gulf.png': 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE&SRS=EPSG:4326&BBOX=-98,20,-78,36&WIDTH=1280&HEIGHT=1024&TIME=2005-08-29',
 'nah-hs-200508.gif': 'https://polar.ncep.noaa.gov/history/waves/nah.hs.anim.200508.gif',
}

def fetch(url, output, opener=urlopen, expected_sha=None, budget=None, cached_receipt=None):
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raw = output.read_bytes(); digest = hashlib.sha256(raw).hexdigest()
        if expected_sha and digest != expected_sha: raise ValueError(f'existing hash mismatch: {output}')
        if not cached_receipt or cached_receipt.get('url') != url or cached_receipt.get('sha256') != digest:
            raise ValueError(f'cached file lacks matching receipt: {output}')
        if budget is not None:
            if budget['bytes'] + len(raw) > budget['limit']: raise ValueError('aggregate marine acquisition exceeds 100 MiB cap')
            budget['bytes'] += len(raw)
        return {'file': str(output), 'url': url, 'bytes': len(raw), 'sha256': digest, 'cached': True}
    with opener(Request(url, headers={'User-Agent':'Isobar-History/1.0'}), timeout=60) as response:
        body = response.read(MAX_TOTAL_BYTES + 1)
    if len(body) > MAX_TOTAL_BYTES or budget is not None and budget['bytes'] + len(body) > budget['limit']:
        raise ValueError('aggregate marine acquisition exceeds 100 MiB cap')
    if expected_sha and hashlib.sha256(body).hexdigest() != expected_sha: raise ValueError(f'source hash mismatch: {url}')
    fd, tmp = tempfile.mkstemp(dir=output.parent, prefix='.' + output.name)
    try:
        with os.fdopen(fd, 'wb') as stream: stream.write(body); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, output)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    if budget is not None: budget['bytes'] += len(body)
    return {'file': str(output), 'url': url, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'cached': False}

def sources(metadata):
    result = dict(ASSETS)
    for station in metadata['stations']:
        url = station.get('data_url')
        if not url: raise ValueError(f"station {station.get('id')} lacks data_url")
        name = f"ndbc-{station['id']}-2005.gz" if url.endswith('.gz') else f"ndbc-{station['id']}-2005.txt"
        result[name] = url
    return result

def acquire_all(output, metadata_path=Path('tools/history/katrina-marine-sources.json'), opener=urlopen, total_limit=MAX_TOTAL_BYTES):
    metadata = json.loads(metadata_path.read_text()); budget = {'bytes': 0, 'limit': total_limit}; manifest = []
    previous = {}
    prior_path = output / 'manifest.json'
    if prior_path.exists():
        previous = {item['file'].split('/')[-1]: item for item in json.loads(prior_path.read_text()).get('sources', [])}
    expected = {}
    for item in metadata.get('satellites', []) + metadata.get('assets', []):
        if item.get('source_url') and item.get('sha256'): expected[item['source_url']] = item['sha256']
    for name, url in sources(metadata).items():
        manifest.append(fetch(url, output / name, opener=opener, expected_sha=expected.get(url), budget=budget, cached_receipt=previous.get(name)))
    receipt = {'schema_version': 1, 'retrieved_at': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(), 'total_bytes': budget['bytes'], 'limit_bytes': total_limit, 'sources': manifest}
    output.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=output, prefix='.manifest.')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(receipt, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, output / 'manifest.json')
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return receipt

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--output',type=Path,default=Path('build/history/marine')); parser.add_argument('--metadata',type=Path,default=Path('tools/history/katrina-marine-sources.json')); args=parser.parse_args(); print(json.dumps(acquire_all(args.output,args.metadata),indent=2))
if __name__ == '__main__': main()
