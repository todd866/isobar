#!/usr/bin/env python3
"""Inspect Isobar's local feedback inbox (stdlib only)."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def inbox_path(value):
    return Path(value).expanduser() if value else Path.home() / "Library/Application Support/Isobar/feedback"


def records(root):
    if not root.is_dir():
        return []
    found = []
    for directory in root.iterdir():
        path = directory / "feedback.json"
        if not directory.is_dir() or directory.name.startswith(".") or not path.is_file():
            continue
        try:
            with path.open(encoding="utf-8") as stream:
                data = json.load(stream)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        captured = data.get("captured_at")
        try:
            stamp = datetime.fromisoformat(captured.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                raise ValueError("missing timezone")
        except (AttributeError, ValueError):
            stamp = datetime.min.replace(tzinfo=timezone.utc)
        found.append((stamp, directory, data))
    return sorted(found, key=lambda item: item[0], reverse=True)


def command_list(root):
    now = datetime.now(timezone.utc)
    for captured, directory, data in records(root):
        age = now - captured
        seconds = max(0, int(age.total_seconds()))
        if seconds < 60:
            age_text = f"{seconds}s"
        elif seconds < 3600:
            age_text = f"{seconds // 60}m"
        elif seconds < 86400:
            age_text = f"{seconds // 3600}h"
        else:
            age_text = f"{seconds // 86400}d"
        if not isinstance(data, dict):
            continue
        state = data.get("state") if isinstance(data.get("state"), dict) else {}
        note = data.get("note")
        if not isinstance(note, str):
            note = ""
        preview = " ".join(note[:60].splitlines())
        print(f"{directory.name}  {age_text}  {data.get('surface', '—')}  {state.get('lens') or '—'}  {preview}")


def command_show(root, identifier):
    exact = [item for item in records(root) if item[1].name == identifier]
    matches = exact or [item for item in records(root) if item[1].name.startswith(identifier)]
    if not matches:
        raise SystemExit(f"feedback not found: {identifier}")
    if len(matches) > 1:
        raise SystemExit(f"ambiguous feedback id: {identifier}")
    _, directory, data = matches[0]
    print(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False))
    print("\npaths:")
    files = data.get("files")
    for name in files if isinstance(files, list) else []:
        if isinstance(name, str) and Path(name).name == name and name not in {".", ".."}:
            print(directory / name)
    print(directory / "feedback.json")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--inbox", type=Path, help="feedback inbox directory")
    sub = parser.add_subparsers(dest="command", required=True)
    list_parser = sub.add_parser("list")
    list_parser.add_argument("--inbox", type=Path, dest="inbox_sub")
    show = sub.add_parser("show")
    show.add_argument("id")
    show.add_argument("--inbox", type=Path, dest="inbox_sub")
    args = parser.parse_args(argv)
    root = inbox_path(args.inbox_sub or args.inbox)
    if args.command == "list":
        command_list(root)
    else:
        command_show(root, args.id)


if __name__ == "__main__":
    main()
