#!/usr/bin/env python3
"""Check manifest.json against the latest v* tag.

Skip when the repo has no v* tag. The manifest version must never be lower
than that tag. When a shipped file (the list from scripts/package.sh --list)
differs between the tag and HEAD, the manifest version must be strictly
greater and CHANGELOG.md must contain a "## <version>" heading.
"""

import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent


def run(*args):
    result = subprocess.run(args, cwd=root, check=True, text=True, capture_output=True)
    return result.stdout


def parse_version(value):
    parts = value.split(".")
    if not parts or any(not part.isdigit() for part in parts):
        sys.exit(f"bad version {value}")
    return tuple(int(part) for part in parts)


def compare(left, right):
    width = max(len(left), len(right))
    left = left + (0,) * (width - len(left))
    right = right + (0,) * (width - len(right))
    return (left > right) - (left < right)


def main():
    match_tag = None
    args = sys.argv[1:]
    if args[:1] == ["--match-tag"]:
        if len(args) != 2:
            sys.exit("usage: check-version.py [--match-tag vX.Y.Z]")
        match_tag = args[1]
    elif args:
        sys.exit("usage: check-version.py [--match-tag vX.Y.Z]")

    manifest_version = json.loads((root / "manifest.json").read_text())["version"]
    if match_tag is not None:
        got = match_tag[1:] if match_tag.startswith("v") else match_tag
        if got != manifest_version:
            sys.exit(f"tag {match_tag} is {got}; manifest.json is {manifest_version}")

    tags = [line for line in run("git", "tag", "-l", "v*", "--sort=-version:refname").splitlines() if line]
    if not tags:
        print("no v* tag; skipping version check")
        return
    latest = tags[0]
    latest_version = latest[1:] if latest.startswith("v") else latest

    shipped = [line for line in run("bash", str(root / "scripts" / "package.sh"), "--list").splitlines() if line]
    diff = [
        line
        for line in run("git", "diff", "--name-only", latest, "HEAD", "--", *shipped).splitlines()
        if line
    ]

    relation = compare(parse_version(manifest_version), parse_version(latest_version))
    if relation < 0:
        sys.exit(f"manifest {manifest_version} is lower than {latest}")
    if diff:
        if relation == 0:
            listed = "\n".join(diff)
            sys.exit(
                f"shipped files changed since {latest} but manifest is still {manifest_version}:\n{listed}"
            )
        heading = f"## {manifest_version}"
        if not any(line.strip() == heading for line in (root / "CHANGELOG.md").read_text().splitlines()):
            sys.exit(f"CHANGELOG.md has no {heading} heading")
    changed = f" ({len(diff)} shipped files differ)" if diff else ""
    print(f"version {manifest_version} ok against {latest}{changed}")


if __name__ == "__main__":
    main()
