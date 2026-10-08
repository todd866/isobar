#!/usr/bin/env python3
"""The hosted native job's artifact assertions, also used by the local gate."""
import plistlib
from pathlib import Path
import re
import subprocess


def main():
    app = Path("build/Isobar.app/Contents")
    info = plistlib.loads((app / "Info.plist").read_bytes())
    binary = str(app / "MacOS/Isobar")
    version = subprocess.check_output([binary, "--version"], text=True).strip()
    if version != "Isobar " + info["CFBundleShortVersionString"]:
        raise RuntimeError(f"Unexpected executable version: {version}")
    help_text = subprocess.check_output([binary, "--help"], text=True)
    if "animated weather maps" not in help_text:
        raise RuntimeError(f"Missing executable help contract: {help_text}")
    loads = subprocess.check_output(["otool", "-l", binary], text=True)
    targets = re.findall(r"^\s*minos\s+(\S+)", loads, re.MULTILINE)
    normalize = lambda value: tuple((list(map(int, value.split("."))) + [0, 0])[:3])
    expected = info["LSMinimumSystemVersion"]
    if not targets or not all(normalize(t) == normalize(expected) for t in targets):
        raise RuntimeError(f"Unexpected deployment targets: expected {expected}, found {targets}")
    print("native artifact: version, help and deployment target passed")


if __name__ == "__main__":
    main()
