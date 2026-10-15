#!/usr/bin/env python3
"""Unpacks a design tool's single-file HTML export into readable files.

    python3 -I scripts/unpack-design.py <export.html> <out-dir>

An export packs its pages, scripts and styles into base64 (often gzipped)
entries of a `__bundler/manifest` script, and each page is itself such a
bundle. This writes every page's markup as `<out-dir>/<page title>/page.html`
(the `<x-dc>` template, where the design's inline styles live), with its
scripts and styles beside it, and prints the tree. It only decodes and
writes, every name made safe and kept inside <out-dir>; nothing from the
export runs. Run it with `-I` from outside the
folder the export sits in, as for any downloaded file.
"""

import base64
import gzip
import json
import re
import sys
from pathlib import Path

EXT = {"text/html": ".html", "text/css": ".css", "application/javascript": ".js", "text/javascript": ".js", "image/svg+xml": ".svg"}


def block(html: str, kind: str):
    m = re.search(r'<script type="__bundler/%s">(.*?)</script>' % kind, html, re.S)
    return json.loads(m.group(1)) if m else None


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower() or "page"


def inside(root: Path, path: Path) -> Path:
    """`path`, refused when it would land outside `root` (names come from the file)."""
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f"{path} would be written outside {root}")
    return resolved


def unpack(html: str, out: Path, root: Path, depth: int = 0) -> None:
    out = inside(root, out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = block(html, "manifest") or {}
    template = block(html, "template")
    if isinstance(template, str):
        (out / "page.html").write_text(template, encoding="utf-8")
    for uuid, entry in manifest.items():
        data = base64.b64decode(entry["data"])
        if entry.get("compressed"):
            data = gzip.decompress(data)
        mime = entry.get("mime", "")
        if mime == "text/html" and b"__bundler/manifest" in data:
            page = data.decode("utf-8")
            title = re.search(r"<title>([^<]*)</title>", page)
            name = slug(title.group(1) if title else uuid)
            print("  " * depth + f"{name}/")
            unpack(page, out / name, root, depth + 1)
        elif mime in EXT:
            inside(root, out / f"{slug(uuid)}{EXT[mime]}").write_bytes(data)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    html = src.read_text(encoding="utf-8")
    if "__bundler/manifest" not in html:
        print(f"{src} is not a bundled export (no __bundler/manifest)", file=sys.stderr)
        return 1
    print(f"{out}/")
    out.mkdir(parents=True, exist_ok=True)
    unpack(html, out, out, 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
