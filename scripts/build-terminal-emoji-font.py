"""Regenerates the terminal's emoji and text fallback coverage fonts.

The GPU terminal shapes text from font files, so emoji, and symbols or
scripts the bundled font lacks, need a font that claims them. This one maps each emoji code point to its own empty glyph (the engine
keys the drawn emoji by glyph); its
"Color Emoji" name makes the engine draw those cells with the browser's own
emoji font (Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji) instead.
The text fallback font does the same for symbol blocks and scripts the
bundled Maple Mono lacks (Claude Code's ⏺ ✻ ⎿, ★ ❤, Hangul, Arabic, ...):
those cells draw with the browser's system fonts, in the cell's color.

Usage (fontTools is a one-off tool, not a project dependency):
  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
  /tmp/ft/bin/python scripts/build-terminal-emoji-font.py \
    /usr/share/fonts/maple-mono-nf-cn/MapleMono-NF-CN-Regular.ttf
"""

import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

# Unicode 16 emoji-data.txt: Emoji_Presentation, plus Extended_Pictographic
# from U+1F000 (beyond the text font). Text-default symbols (check marks,
# hearts, arrows) stay in the text font at their single-cell width.
RANGES = [
    (0x231A, 0x231B), (0x23E9, 0x23EC), (0x23F0, 0x23F0), (0x23F3, 0x23F3),
    (0x25FD, 0x25FE), (0x2614, 0x2615), (0x2648, 0x2653), (0x267F, 0x267F),
    (0x2693, 0x2693), (0x26A1, 0x26A1), (0x26AA, 0x26AB), (0x26BD, 0x26BE),
    (0x26C4, 0x26C5), (0x26CE, 0x26CE), (0x26D4, 0x26D4), (0x26EA, 0x26EA),
    (0x26F2, 0x26F3), (0x26F5, 0x26F5), (0x26FA, 0x26FA), (0x26FD, 0x26FD),
    (0x2705, 0x2705), (0x270A, 0x270B), (0x2728, 0x2728), (0x274C, 0x274C),
    (0x274E, 0x274E), (0x2753, 0x2755), (0x2757, 0x2757), (0x2795, 0x2797),
    (0x27B0, 0x27B0), (0x27BF, 0x27BF), (0x2B1B, 0x2B1C), (0x2B50, 0x2B50),
    (0x2B55, 0x2B55), (0x1F000, 0x1F0FF), (0x1F10D, 0x1F10F),
    (0x1F12F, 0x1F12F), (0x1F16C, 0x1F171), (0x1F17E, 0x1F17F),
    (0x1F18E, 0x1F18E), (0x1F191, 0x1F19A), (0x1F1AD, 0x1F1FF),
    (0x1F201, 0x1F20F), (0x1F21A, 0x1F21A), (0x1F22F, 0x1F22F),
    (0x1F232, 0x1F23A), (0x1F23C, 0x1F23F), (0x1F249, 0x1F53D),
    (0x1F546, 0x1F64F), (0x1F680, 0x1F6FF), (0x1F774, 0x1F77F),
    (0x1F7D5, 0x1F7FF), (0x1F80C, 0x1F80F), (0x1F848, 0x1F84F),
    (0x1F85A, 0x1F85F), (0x1F888, 0x1F88F), (0x1F8AE, 0x1F8FF),
    (0x1F90C, 0x1F93A), (0x1F93C, 0x1F945), (0x1F947, 0x1FAFF),
    (0x1FC00, 0x1FFFD),
]
import hashlib

OUT_DIR = Path(__file__).resolve().parent.parent / "web/public/assets/fonts/emoji"

# Blocks the text fallback considers; whatever the bundled font covers stays
# with it.
TEXT_RANGES = [
    (0x0590, 0x05FF), (0x0600, 0x06FF), (0x0900, 0x097F), (0x0E00, 0x0E7F),
    (0x1100, 0x11FF), (0x2000, 0x2BFF), (0x3130, 0x318F), (0xAC00, 0xD7A3),
    (0x1F100, 0x1F1FF), (0x1F780, 0x1F8FF), (0x1FB00, 0x1FBFF),
]


def build(codepoints, family, prefix, advance):
    names = [f"u{cp:04X}" for cp in codepoints]
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", *names])
    builder.setupCharacterMap(dict(zip(codepoints, names)))
    empty = TTGlyphPen(None).glyph()
    builder.setupGlyf({name: empty for name in [".notdef", *names]})
    builder.setupHorizontalMetrics(
        {".notdef": (600, 0), **{name: (advance, 0) for name in names}}
    )
    builder.setupHorizontalHeader(ascent=1020, descent=-300)
    builder.setupOS2(
        sTypoAscender=1020, sTypoDescender=-300, usWinAscent=1020, usWinDescent=300
    )
    builder.setupNameTable({"familyName": family, "styleName": "Regular"})
    builder.setupPost()
    # A fixed date keeps the output, and so its hashed name, reproducible.
    builder.font["head"].created = builder.font["head"].modified = 3_786_000_000
    builder.font.flavor = "woff2"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob(f"{prefix}-*.woff2"):
        old.unlink()
    tmp = OUT_DIR / f"{prefix}.woff2"
    builder.save(tmp)
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()[:10]
    out = tmp.rename(OUT_DIR / f"{prefix}-{digest}.woff2")
    # Served from /assets, where names are cached immutably: update the URL
    # in web/src/terminalFonts.ts.
    print(f"/assets/fonts/emoji/{out.name}", out.stat().st_size, len(codepoints))


emoji = sorted({cp for low, high in RANGES for cp in range(low, high + 1)})
bundled = set(TTFont(sys.argv[1], lazy=True).getBestCmap())
text = sorted(
    {cp for low, high in TEXT_RANGES for cp in range(low, high + 1)}
    - bundled
    - set(emoji)
)
build(emoji, "Thyra Color Emoji", "emoji-coverage", 1200)
build(text, "Thyra Text Fallback", "text-fallback", 600)
