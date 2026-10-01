#!/usr/bin/env python3
"""Prepare a versioned Isobar Mac release without publishing it.

This tool only creates local zip/DMG artifacts. It never submits to Apple or
publishes to GitHub. --notarized invokes local macOS validation tools, which
may consult Apple's services, only after the app has been notarized and stapled.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path


class PackageError(RuntimeError):
    """A release candidate is not safe to package."""


def safe_component(value: str, label: str) -> str:
    if not value or value in {".", ".."} or "/" in value or "\\" in value or "\x00" in value:
        raise PackageError(f"unsafe {label} in bundle metadata: {value!r}")
    return value


SPCTL_TIMEOUT = 60


def command(*args: str, check: bool = True, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=timeout)


def bundle_info(app: Path) -> tuple[dict, str]:
    if app.suffix != ".app" or not app.is_dir():
        raise PackageError(f"app bundle not found: {app}")
    plist_path = app / "Contents" / "Info.plist"
    if not plist_path.is_file():
        raise PackageError(f"missing bundle Info.plist: {plist_path}")
    try:
        info = plistlib.loads(plist_path.read_bytes())
    except (OSError, plistlib.InvalidFileException) as error:
        raise PackageError(f"invalid bundle Info.plist: {error}") from error
    version = safe_component(str(info.get("CFBundleShortVersionString", "")).strip(), "version")
    build = str(info.get("CFBundleVersion", "")).strip()
    minimum = str(info.get("LSMinimumSystemVersion", "")).strip()
    executable = safe_component(str(info.get("CFBundleExecutable", "")).strip(), "executable")
    if not version or not build or not minimum or not executable:
        raise PackageError("bundle must declare version, build, minimum macOS and executable")
    executable_path = app / "Contents" / "MacOS" / executable
    if not executable_path.is_file():
        raise PackageError(f"missing bundle executable: {executable_path}")
    result = command("/usr/bin/lipo", "-archs", str(executable_path))
    archs = " ".join(result.stdout.split())
    if not archs:
        raise PackageError("bundle executable declares no architectures")
    architecture_set = set(archs.split())
    if architecture_set == {"arm64"}:
        architecture = "arm64"
    elif architecture_set == {"x86_64"}:
        architecture = "x86_64"
    elif architecture_set == {"arm64", "x86_64"}:
        architecture = "universal"
    else:
        raise PackageError(f"unsupported bundle architecture: {archs}")
    info["_build"] = build
    info["_minimum"] = minimum
    info["_architecture"] = architecture
    return info, architecture


def validate_bundle(app: Path, allow_unsigned: bool = False) -> None:
    checker = Path(__file__).with_name("check-bundle.py")
    args = [sys.executable, str(checker), str(app)]
    if allow_unsigned:
        args.append("--unsigned")
    try:
        command(*args)
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "bundle validation failed").strip()
        raise PackageError(detail) from error


def validate_notarized(app: Path) -> None:
    for args in (("xcrun", "stapler", "validate", str(app)),
                 ("spctl", "--assess", "--type", "execute", "--verbose=4", str(app))):
        try:
            command(*args, timeout=SPCTL_TIMEOUT if args[0] == "spctl" else None)
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            if isinstance(error, subprocess.TimeoutExpired):
                detail = f"{args[0]} timed out"
            elif isinstance(error, subprocess.CalledProcessError):
                detail = (error.stderr or error.stdout or "notarization validation failed").strip()
            else:
                detail = f"required command is unavailable: {args[0]}"
            raise PackageError(detail) from error


def outputs_for(info: dict, output: Path, formats: set[str]) -> dict[str, Path]:
    version = str(info["CFBundleShortVersionString"])
    architecture = str(info["_architecture"])
    stem = f"Isobar-{version}-macOS-{architecture}"
    paths = {kind: output / f"{stem}.{kind}" for kind in formats}
    paths["checksums"] = output / f"{stem}-checksums.txt"
    return paths


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def copy_app(source: Path, destination: Path) -> None:
    command("/usr/bin/ditto", str(source), str(destination))


def write_dmg_root(root: Path, app: Path) -> None:
    root.mkdir(parents=True)
    copy_app(app, root / "Isobar.app")
    (root / "Applications").symlink_to("/Applications")
    (root / "Install.txt").write_text(
        "Drag Isobar to Applications, open it, and look in the menu bar.\n",
        encoding="utf-8",
    )


def package(app: Path, output: Path, formats: set[str], *, allow_unsigned: bool = False,
            notarized: bool = False, dry_run: bool = False) -> dict[str, Path]:
    info, _ = bundle_info(app)
    if notarized and allow_unsigned:
        raise PackageError("--notarized cannot be combined with --allow-unsigned")
    validate_bundle(app, allow_unsigned=allow_unsigned)
    if notarized:
        validate_notarized(app)
    if not output.parent.is_dir():
        raise PackageError(f"output parent does not exist: {output.parent}")
    if os.path.lexists(output):
        raise PackageError(f"refusing to overwrite existing output directory: {output}")
    paths = outputs_for(info, output, formats)
    if dry_run:
        return paths
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-work-", dir=output.parent) as work_temporary, \
         tempfile.TemporaryDirectory(prefix=f".{output.name}-artifacts-", dir=output.parent) as artifacts_temporary:
        root = Path(work_temporary)
        artifact_root = Path(artifacts_temporary)
        staged = outputs_for(info, artifact_root, formats)
        if "zip" in formats:
            zip_root = root / "zip"
            zip_root.mkdir()
            copy_app(app, zip_root / "Isobar.app")
            command("/usr/bin/ditto", "-c", "-k", "--keepParent", str(zip_root / "Isobar.app"), str(staged["zip"]))
        if "dmg" in formats:
            dmg_root = root / "dmg"
            write_dmg_root(dmg_root, app)
            command("/usr/bin/hdiutil", "create", "-volname", "Isobar", "-srcfolder", str(dmg_root),
                    "-format", "UDZO", str(staged["dmg"]))
        lines = [f"{sha256(staged[k])}  {staged[k].name}" for k in ("zip", "dmg") if k in formats]
        staged["checksums"].write_text("\n".join(lines) + "\n", encoding="ascii")
        # The destination did not exist when validation started. Check again
        # immediately before publishing the complete artifact directory.
        if os.path.lexists(output):
            raise PackageError(f"refusing to overwrite existing output directory: {output}")
        os.replace(artifact_root, output)
    return paths


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("app", type=Path, help="built Isobar.app bundle")
    result.add_argument("output", type=Path, help="new release output directory")
    result.add_argument("--format", choices=("zip", "dmg", "both"), default="both")
    result.add_argument("--allow-unsigned", action="store_true",
                        help="skip codesign verification for a local development candidate")
    result.add_argument("--notarized", action="store_true",
                        help="require stapler validate and spctl acceptance before packaging")
    result.add_argument("--dry-run", action="store_true", help="validate and print planned outputs")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    formats = {"zip", "dmg"} if args.format == "both" else {args.format}
    try:
        paths = package(args.app.resolve(), args.output.resolve(), formats,
                        allow_unsigned=args.allow_unsigned, notarized=args.notarized,
                        dry_run=args.dry_run)
    except (PackageError, OSError, subprocess.CalledProcessError) as error:
        print(f"package-release: error: {error}", file=sys.stderr)
        return 1
    for path in paths.values():
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
