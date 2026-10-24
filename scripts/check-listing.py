#!/usr/bin/env python3
"""Checks docs/store-listing.md against the portal's limits: the name,
the tagline, the description, the manifest's values and the icons."""

import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
bad = []


def block(text, title):
    m = re.search(r"\*\*" + re.escape(title) + r"\*\*[^\n]*\n\n```\n(.*?)\n```", text, re.S)
    return m.group(1) if m else None


def png_size(path):
    b = path.read_bytes()
    w, h = struct.unpack(">II", b[16:24])
    return w, h, b[24], b[25]  # width, height, bit depth, colour type


listing = (ROOT / "docs" / "store-listing.md").read_text()
manifest = json.loads((ROOT / "app.json").read_text())
name = manifest["name"]
if len(name) > 20 or "even" in name.lower():
    bad.append(f"name {name!r}: at most 20 characters, without Even")
if not re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]):
    bad.append(f"version {manifest['version']!r}: three-part semver")
if manifest["edition"] != "202601":
    bad.append("edition must be 202601")
if not re.fullmatch(r"[a-z0-9]+(\.[a-z0-9-]+){2,}", manifest["package_id"]):
    bad.append(f"package id {manifest['package_id']!r}")
tagline = block(listing, "Tagline")
if tagline is None or len(tagline) > 50:
    bad.append(f"tagline: {len(tagline or '')} / 50")
description = block(listing, "Description")
if description is None or len(description) > 2000:
    bad.append(f"description: {len(description or '')} / 2000")
if not block(listing, "Changelog"):
    bad.append("no changelog")
for p in manifest["permissions"]:
    if f"**{p['name']}**" not in listing:
        bad.append(f"permission {p['name']} has no justification in the listing")
for f, size, kind in [("public/icon.png", 24, 0), ("store/icon-512-foreground.png", 512, 4),
                      ("store/icon-512-background.png", 512, 0), ("store/icon-512.png", 512, 0)]:
    path = ROOT / f
    if not path.exists():
        bad.append(f"{f} missing")
        continue
    w, h, depth, colour = png_size(path)
    if (w, h) != (size, size) or colour != kind:
        bad.append(f"{f}: {w}x{h} colour type {colour}, want {size}x{size} type {kind}")
for m in re.finditer(r"`store/shots/([^`]+)`", listing):
    path = ROOT / "store" / "shots" / m.group(1)
    if not path.exists():
        bad.append(f"screenshot {m.group(1)} missing")
    elif not m.group(1).endswith("-phone.png") and "phone" not in m.group(1):
        w, h, _, _ = png_size(path)
        if (w, h) != (576, 288):
            bad.append(f"screenshot {m.group(1)}: {w}x{h}")
print(f"name {len(name)}/20, tagline {len(tagline or '')}/50, description {len(description or '')}/2000")
for b in bad:
    print("listing:", b, file=sys.stderr)
sys.exit(1 if bad else 0)
