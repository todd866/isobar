#!/usr/bin/env python3
"""Reject a download that relies on the build machine or a newer macOS."""
import argparse
import os
import plistlib
import re
import subprocess
import tempfile
from pathlib import Path

MAGICS = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}

def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs)

def check(app, unsigned=False):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    supported = tuple(map(int, info['LSMinimumSystemVersion'].split('.')))
    executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
    app_arch = set(run('/usr/bin/lipo', '-archs', str(executable)).split())
    collector = app / 'Contents/Resources/collector'
    helper = collector / 'isobar-data'
    if not helper.is_file():
        raise ValueError('Bundled collector is missing')
    count = 0
    for path in collector.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open('rb') as stream:
            if stream.read(4) not in MAGICS:
                continue
        count += 1
        arch = set(run('/usr/bin/lipo', '-archs', str(path)).split())
        if not app_arch <= arch:
            raise ValueError(f'{path.name}: {arch} does not cover app {app_arch}')
        commands = run('/usr/bin/otool', '-l', str(path))
        versions = re.findall(r'\bminos\s+(\d+(?:\.\d+)+)', commands)
        versions += re.findall(r'LC_VERSION_MIN_MACOSX\s+cmdsize\s+\d+\s+version\s+(\d+(?:\.\d+)+)', commands)
        if not versions:
            raise ValueError(f'{path.name}: missing macOS deployment target')
        for version in versions:
            minimum = tuple(map(int, version.split('.')))
            if (minimum + (0,0))[:3] > (supported + (0,0))[:3]:
                raise ValueError(f'{path.name}: requires macOS {version}, app advertises {info["LSMinimumSystemVersion"]}')
        for line in run('/usr/bin/otool', '-L', str(path)).splitlines()[1:]:
            dependency = line.strip().split(' (compatibility')[0]
            if dependency.startswith('/') and not dependency.startswith(('/usr/lib/', '/System/Library/')):
                raise ValueError(f'{path.name}: external dependency {dependency}')
    if not (collector / '_internal/config/isobar.toml').is_file():
        raise ValueError('Default collector config is missing')
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'LANG': 'en_US.UTF-8'}
    with tempfile.TemporaryDirectory(prefix='isobar-bundle-') as temporary:
        run(str(helper.resolve()), '--check-runtime', env=environment, cwd=temporary, timeout=30)
        run(str(helper.resolve()), 'retain', '--data-dir', str(Path(temporary) / 'Weather with spaces'), env=environment, cwd=temporary, timeout=30)
    if not unsigned:
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app))
    print(f'Bundle verified: {count} native components, {", ".join(sorted(app_arch))}, macOS {info["LSMinimumSystemVersion"]}+')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('--unsigned', action='store_true')
    args = parser.parse_args()
    check(args.app, args.unsigned)
