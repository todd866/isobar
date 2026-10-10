#!/usr/bin/env python3
"""Stamp a native bundle from this checkout or a git-archive source export."""
import plistlib
import re
import subprocess
import sys
from pathlib import Path


def source_identity(root):
    # A checkout's own Git identity wins, including reviewed public mirrors.
    # A source export nested in another repository must not adopt its parent.
    try:
        top = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        top = ''
    if top and Path(top).resolve() == root.resolve():
        revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
        if not re.fullmatch(r'[0-9a-f]{40}', revision):
            raise ValueError('Invalid Git source revision')
        dirty = bool(subprocess.check_output(
            ['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=all'], text=True).strip())
        return revision, dirty
    archived = (root / '.git-archive-revision').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', archived):
        raise ValueError('Missing Git or exported source revision')
    return archived, False



def main():
    revision, dirty = source_identity(Path(__file__).resolve().parents[1])
    path = Path(sys.argv[1])
    info = plistlib.loads(path.read_bytes())
    info.update(IsobarSourceRevision=revision, IsobarSourceDirty=dirty)
    path.write_bytes(plistlib.dumps(info))


if __name__ == '__main__':
    main()
