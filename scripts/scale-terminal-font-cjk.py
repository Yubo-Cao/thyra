"""Enlarges the CJK glyphs of the bundled terminal font to fill their cells.

Maple Mono NF CN gives each CJK character a two-cell advance (1200 units, the
Latin cell is 600) but draws it only about 900 units wide, so on the
terminal grid Chinese text looks letter-spaced next to Latin text. This scales
every two-cell glyph of the East Asian wide blocks (and their GSUB variants)
by SCALE around the middle of its box, writes each changed chunk under a new
content hash, and points the stylesheets at the new names. Run
`bun scripts/build-terminal-font.ts --split` afterwards to rehash the
stylesheets and regenerate web/src/terminalFontStylesheet.ts.

Run it once after scripts/build-terminal-font.ts slices the font; running it
twice scales twice.

Usage (fontTools is a one-off tool, not a project dependency):
  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
  /tmp/ft/bin/python scripts/scale-terminal-font-cjk.py
  bun scripts/build-terminal-font.ts --split
"""

import hashlib
from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

SCALE = 1.12
WIDE_ADVANCE = 1200
# Middle of the CJK design box (x 0..1200, ink y about -90..850).
CENTER = (600, 380)
WIDE_RANGES = [
    (0x1100, 0x115F),
    (0x2E80, 0x303E),
    (0x3041, 0x33FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xA000, 0xA4CF),
    (0xA960, 0xA97F),
    (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF),
    (0xFE30, 0xFE4F),
    (0xFF00, 0xFF60),
    (0xFFE0, 0xFFE6),
    (0x20000, 0x3FFFD),
]

ROOT = Path(__file__).resolve().parent.parent / "web/public/assets/fonts/maple-mono-nf-cn"


def is_wide(code_point: int) -> bool:
    return any(low <= code_point <= high for low, high in WIDE_RANGES)


def substitutes(font: TTFont, names: set[str]) -> set[str]:
    """Glyphs that single or alternate substitutions make from `names`."""
    if "GSUB" not in font:
        return set()
    found: set[str] = set()
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            if sub.LookupType == 7:
                sub = sub.ExtSubTable
            mapping = getattr(sub, "mapping", None)
            if sub.LookupType == 1 and mapping:
                found.update(out for src, out in mapping.items() if src in names)
            alternates = getattr(sub, "alternates", None)
            if sub.LookupType == 3 and alternates:
                for src, outs in alternates.items():
                    if src in names:
                        found.update(outs)
    return found


def scale_chunk(path: Path) -> bool:
    font = TTFont(path)
    if "glyf" not in font:
        return False
    hmtx = font["hmtx"]
    targets = {
        name
        for code_point, name in font.getBestCmap().items()
        if is_wide(code_point)
    }
    targets |= substitutes(font, targets)
    targets = {
        name for name in targets if name in hmtx.metrics and hmtx[name][0] == WIDE_ADVANCE
    }
    if not targets:
        return False
    glyph_set = font.getGlyphSet()
    glyf = font["glyf"]
    cx, cy = CENTER
    transform = (SCALE, 0, 0, SCALE, cx * (1 - SCALE), cy * (1 - SCALE))
    for name in sorted(targets):
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        pen = TTGlyphPen(None)
        recording.replay(TransformPen(pen, transform))
        glyph = pen.glyph()
        glyph.recalcBounds(glyf)
        glyf[name] = glyph
        hmtx[name] = (WIDE_ADVANCE, getattr(glyph, "xMin", 0))
    font.save(path)
    return True


def main() -> None:
    renames: dict[str, str] = {}
    for path in sorted(ROOT.glob("*/*.woff2")):
        if not scale_chunk(path):
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
        target = path.with_name(f"{digest}.woff2")
        path.rename(target)
        renames[f"{path.parent.name}/{path.name}"] = f"{target.parent.name}/{target.name}"
    for css in ROOT.glob("fonts-*.css"):
        text = css.read_text()
        for old, new in renames.items():
            text = text.replace(f"/{old}\"", f"/{new}\"")
        css.write_text(text)
    print(f"scaled {len(renames)} chunks")


if __name__ == "__main__":
    main()
