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


def contained(path: Path, root: Path) -> bool:
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError):
        return False
    try:
        resolved.relative_to(root)
    except ValueError:
        return False
    return True


def is_macho(path: Path) -> bool:
    try:
        with path.open('rb') as stream:
            return stream.read(4) in MAGICS
    except OSError:
        return False


def bundle_machos(app: Path) -> list[Path]:
    """Mach-O files inside the app. A symlink that resolves outside is rejected."""
    root = app.resolve()
    found = []
    seen = set()
    for current, dirnames, filenames in os.walk(app, followlinks=False):
        for name in dirnames + filenames:
            path = Path(current) / name
            if path.is_symlink():
                if not contained(path, root):
                    raise ValueError(f'{path.relative_to(app)}: symlink points outside the app')
                candidate = path.resolve()
                if not candidate.is_file():
                    continue
            elif path.is_file():
                candidate = path
            else:
                continue
            resolved = candidate.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            if is_macho(resolved):
                found.append(resolved)
    return found


def inspect_macho(path: Path, app_arch: set[str], supported: tuple[int, ...], advertised: str) -> None:
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
        if (minimum + (0, 0))[:3] > (supported + (0, 0))[:3]:
            raise ValueError(f'{path.name}: requires macOS {version}, app advertises {advertised}')
    for line in run('/usr/bin/otool', '-L', str(path)).splitlines()[1:]:
        dependency = line.strip().split(' (compatibility')[0]
        if dependency.startswith('/') and not dependency.startswith(('/usr/lib/', '/System/Library/')):
            raise ValueError(f'{path.name}: external dependency {dependency}')


def check(app, unsigned=False):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    supported = tuple(map(int, info['LSMinimumSystemVersion'].split('.')))
    advertised = info['LSMinimumSystemVersion']
    executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
    root = app.resolve()
    if executable.is_symlink() and not contained(executable, root):
        raise ValueError(f'{executable.relative_to(app)}: symlink points outside the app')
    machos = bundle_machos(app)
    resolved_executable = executable.resolve()
    if resolved_executable not in machos:
        raise ValueError(f'{executable.name}: main executable is not a Mach-O')
    app_arch = set(run('/usr/bin/lipo', '-archs', str(resolved_executable)).split())
    for path in machos:
        inspect_macho(path, app_arch, supported, advertised)
    collector = app / 'Contents/Resources/collector'
    helper = collector / 'isobar-data'
    if helper.is_symlink() and not contained(helper, root):
        raise ValueError(f'{helper.relative_to(app)}: symlink points outside the app')
    if not helper.is_file():
        raise ValueError('Bundled collector is missing')
    if not (collector / '_internal/config/isobar.toml').is_file():
        raise ValueError('Default collector config is missing')
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'LANG': 'en_US.UTF-8'}
    with tempfile.TemporaryDirectory(prefix='isobar-bundle-') as temporary:
        run(str(helper.resolve()), '--check-runtime', env=environment, cwd=temporary, timeout=30)
        run(str(helper.resolve()), 'retain', '--data-dir', str(Path(temporary) / 'Weather with spaces'), env=environment, cwd=temporary, timeout=30)
    if not unsigned:
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app))
    print(f'Bundle verified: {len(machos)} native components, {", ".join(sorted(app_arch))}, macOS {advertised}+')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('--unsigned', action='store_true')
    args = parser.parse_args()
    check(args.app, args.unsigned)
