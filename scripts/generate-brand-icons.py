#!/usr/bin/env python3
"""
Regenerate the desktop app icons from the brand mark.

    pip install pillow && python3 scripts/generate-brand-icons.py

Writes `apps/desktop/build-resources/{icon.png,icon.icns,icon.ico}`.

## Why this is a script and not three files someone once exported

The icons are DERIVED — mark, ground colour, corner radius and the optical
inset are four numbers, and getting one of them wrong produces an icon that
still looks like an icon. macOS in particular does not centre or inset anything
for you: hand an `.icns` a full-bleed square and it renders as a square, next to
every other app's squircle, looking subtly broken in a way nobody can name.

So the geometry lives here, in one place, with the reasoning attached.

## The three numbers

  GLYPH   0.60   The mark occupies 60% of the tile. Apple's icon grid puts a
                 "circular" glyph at ~0.68 and a square one at ~0.60; this mark
                 is a wide scribble, so it reads as square.
  RADIUS  0.2247 The continuous-corner proportion macOS uses (185.4 / 824).
                 Approximated with a rounded rectangle, supersampled 4x — the
                 difference from a true squircle is invisible below 1024px and
                 the exact curve needs a bezier solver nobody wants to own.
  MARGIN  100    macOS only. The `.icns` art sits in an 824px tile inside a
                 1024px canvas because the SYSTEM draws its shadow into that
                 margin. Full-bleed art gets that shadow clipped to the canvas
                 edge and reads as a sticker. Windows and Linux want no margin.

## Source-asset gotcha

`jingler_social_icon.png` from the brand package LOOKS padded and transparent,
but carries an opaque white plate — compositing it over a coloured ground just
paints the ground white. Use `jingler-icon-color.png`, which is genuinely
transparent. This cost a debugging round; do not "simplify" it back.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - developer tooling
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "packages/ui/src/brand/assets/jingler-icon-color.png"
OUT = ROOT / "apps/desktop/build-resources"

GROUND = (0x21, 0x21, 0x21, 0xFF)  # #212121 — the wordmark's own neutral
GLYPH = 0.60
RADIUS = 0.2247
MAC_MARGIN = 100


def squircle(size: int) -> Image.Image:
    """A rounded-square alpha mask, supersampled so the corners are not stepped."""
    ss = 4
    mask = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * ss - 1, size * ss - 1), radius=int(size * ss * RADIUS), fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def compose(canvas: int, body: int, margin: int) -> Image.Image:
    """A `body`px branded tile centred on a `canvas`px transparent canvas."""
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    tile = Image.new("RGBA", (body, body), GROUND)

    mark = Image.open(SRC).convert("RGBA")
    scale = (body * GLYPH) / max(mark.size)
    mark = mark.resize((round(mark.width * scale), round(mark.height * scale)), Image.LANCZOS)
    tile.alpha_composite(mark, ((body - mark.width) // 2, (body - mark.height) // 2))

    tile.putalpha(squircle(body))
    out.paste(tile, (margin, margin), tile)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    full_bleed = compose(1024, 1024, 0)
    full_bleed.save(OUT / "icon.png")
    full_bleed.save(
        OUT / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    )

    inset = compose(1024, 1024 - MAC_MARGIN * 2, MAC_MARGIN)
    iconset = OUT / "Jingler.iconset"
    iconset.mkdir(exist_ok=True)
    try:
        for px in (16, 32, 128, 256, 512):
            inset.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{px}x{px}.png")
            inset.resize((px * 2, px * 2), Image.LANCZOS).save(
                iconset / f"icon_{px}x{px}@2x.png"
            )
        # `iconutil` is macOS-only. On other platforms the committed .icns stands.
        if shutil.which("iconutil"):
            subprocess.run(
                ["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")],
                check=True,
            )
        else:
            print("iconutil not found (not macOS) — icon.icns left unchanged")
    finally:
        shutil.rmtree(iconset, ignore_errors=True)

    for name in ("icon.png", "icon.ico", "icon.icns"):
        path = OUT / name
        print(f"{name:12} {os.path.getsize(path):>8,} bytes")


if __name__ == "__main__":
    main()
