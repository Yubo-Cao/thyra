"""Regenerates the self-hosted terminal font presets.

The terminal font picker offers a few well-known programming fonts besides
the bundled Thyra Mono (appearance.ts). Each preset ships here as woff2
files (regular, bold, italic and bold italic where upstream has them) under
web/public/assets/fonts/presets/<id>/, which the terminal fetches only once
the preset is selected (terminalFonts.ts). Glyphs a preset lacks (CJK, Nerd
Font icons, emoji) still come from Thyra Mono and the coverage fonts.

Every source is a pinned upstream release archive or license file, checked
against its SHA-256 before use. Fonts without a Reserved Font Name are
subset to the scripts and symbols a terminal draws (Latin, Greek, Cyrillic,
punctuation, arrows, math, box drawing, braille, Powerline), keeping every
OpenType layout feature so the calt/liga ligatures survive; hinting is
dropped because the engine rasterizes unhinted. Fonts whose OFL license
reserves a font name (Cascadia, Source, Plex) may not be modified under that
name, so they are only compressed to woff2, which the OFL FAQ allows when
the font data is otherwise unchanged.

Usage (fontTools is a one-off tool, not a project dependency):
  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
  /tmp/ft/bin/python -I scripts/build-terminal-font-presets.py [download-dir]
The download directory (default /tmp/thyra-font-presets) keeps the
archives, about 330 MB, so later runs skip the downloads.
"""

import hashlib
import io
import json
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
URL_ROOT = "/assets/fonts/presets"
OUT_DIR = ROOT / "web/public" / URL_ROOT.lstrip("/")
MANIFEST = ROOT / "web/src/terminalFontPresetFiles.ts"
LICENSES = ROOT / "LICENSES"

GH = "https://github.com"
RAW = "https://raw.githubusercontent.com"

# Pinned upstream files: url and SHA-256.
SOURCES = {
    "jetbrains-mono": (
        f"{GH}/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip",
        "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf",
    ),
    "fira-code": (
        f"{GH}/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip",
        "0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79",
    ),
    "fira-code-license": (
        f"{RAW}/tonsky/FiraCode/6.2/LICENSE",
        "1d41e10031ab125302780a05ec4c91d218e47db0c7e37cf315cce5e608cdc25c",
    ),
    "cascadia": (
        f"{GH}/microsoft/cascadia-code/releases/download/v2407.24/CascadiaCode-2407.24.zip",
        "e67a68ee3386db63f48b9054bd196ea752bc6a4ebb4df35adce6733da50c8474",
    ),
    "cascadia-license": (
        f"{RAW}/microsoft/cascadia-code/v2407.24/LICENSE",
        "51882cd3cdba4e16f220f44ddb08a635c38c44ea6e0975db2574f4be6f958238",
    ),
    "iosevka": (
        f"{GH}/be5invis/Iosevka/releases/download/v34.9.0/PkgTTF-Unhinted-IosevkaTerm-34.9.0.zip",
        "b11472aab68b01d5936758962af8da5902ebbb7f8311303236f5e1023a4bee45",
    ),
    "iosevka-license": (
        f"{RAW}/be5invis/Iosevka/v34.9.0/LICENSE.md",
        "4ba53c7c1cb39279aae5f8d7d22054c485c71169920e5a36ed098b115e2e3c5d",
    ),
    "source-code-pro": (
        f"{GH}/adobe-fonts/source-code-pro/releases/download/"
        "2.042R-u%2F1.062R-i%2F1.026R-vf/TTF-source-code-pro-2.042R-u_1.062R-i.zip",
        "0c85bac90d15c040b82939aa92bc8404420fccc02e37bbcb9c93a7f21abb52c6",
    ),
    "source-code-pro-license": (
        f"{RAW}/adobe-fonts/source-code-pro/2.042R-u/1.062R-i/1.026R-vf/LICENSE.md",
        "7c940e28a5388e9bba866cf0e408edda45fe0899ba98665b8f6ab31dc5e4b8ff",
    ),
    "ibm-plex-mono": (
        f"{GH}/IBM/plex/releases/download/%40ibm%2Fplex-mono%402.5.0/ibm-plex-mono.zip",
        "6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c",
    ),
    "noto-sans-mono": (
        f"{GH}/notofonts/latin-greek-cyrillic/releases/download/"
        "NotoSansMono-v2.014/NotoSansMono-v2.014.zip",
        "090cf6c5e03f337a755630ca888b1fef463e64ae7b33ee134e9309c05f978732",
    ),
}

# id (appearance.ts), family label, license file (LICENSES/), license
# source as (source, archive member or None), whether the license reserves a
# font name, and faces as (weight, italic, source, archive member).
PRESETS = [
    (
        "jetbrains-mono", "JetBrains Mono", "JETBRAINS-MONO.txt",
        ("jetbrains-mono", "OFL.txt"), False,
        [
            (400, False, "jetbrains-mono", "fonts/ttf/JetBrainsMono-Regular.ttf"),
            (700, False, "jetbrains-mono", "fonts/ttf/JetBrainsMono-Bold.ttf"),
            (400, True, "jetbrains-mono", "fonts/ttf/JetBrainsMono-Italic.ttf"),
            (700, True, "jetbrains-mono", "fonts/ttf/JetBrainsMono-BoldItalic.ttf"),
        ],
    ),
    (
        "fira-code", "Fira Code", "FIRA-CODE.txt",
        ("fira-code-license", None), False,
        [
            (400, False, "fira-code", "ttf/FiraCode-Regular.ttf"),
            (700, False, "fira-code", "ttf/FiraCode-Bold.ttf"),
        ],
    ),
    (
        "cascadia-mono", "Cascadia Mono", "CASCADIA.txt",
        ("cascadia-license", None), True,
        [
            (400, False, "cascadia", "ttf/static/CascadiaMono-Regular.ttf"),
            (700, False, "cascadia", "ttf/static/CascadiaMono-Bold.ttf"),
            (400, True, "cascadia", "ttf/static/CascadiaMono-Italic.ttf"),
            (700, True, "cascadia", "ttf/static/CascadiaMono-BoldItalic.ttf"),
        ],
    ),
    (
        "iosevka", "Iosevka Term", "IOSEVKA.txt",
        ("iosevka-license", None), False,
        [
            (400, False, "iosevka", "IosevkaTerm-Regular.ttf"),
            (700, False, "iosevka", "IosevkaTerm-Bold.ttf"),
            (400, True, "iosevka", "IosevkaTerm-Italic.ttf"),
            (700, True, "iosevka", "IosevkaTerm-BoldItalic.ttf"),
        ],
    ),
    (
        "source-code-pro", "Source Code Pro", "SOURCE-CODE-PRO.txt",
        ("source-code-pro-license", None), True,
        [
            (400, False, "source-code-pro", "TTF/SourceCodePro-Regular.ttf"),
            (700, False, "source-code-pro", "TTF/SourceCodePro-Bold.ttf"),
            (400, True, "source-code-pro", "TTF/SourceCodePro-It.ttf"),
            (700, True, "source-code-pro", "TTF/SourceCodePro-BoldIt.ttf"),
        ],
    ),
    (
        "ibm-plex-mono", "IBM Plex Mono", "IBM-PLEX.txt",
        ("ibm-plex-mono", "ibm-plex-mono/LICENSE.txt"), True,
        [
            (400, False, "ibm-plex-mono", "ibm-plex-mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf"),
            (700, False, "ibm-plex-mono", "ibm-plex-mono/fonts/complete/ttf/IBMPlexMono-Bold.ttf"),
            (400, True, "ibm-plex-mono", "ibm-plex-mono/fonts/complete/ttf/IBMPlexMono-Italic.ttf"),
            (700, True, "ibm-plex-mono", "ibm-plex-mono/fonts/complete/ttf/IBMPlexMono-BoldItalic.ttf"),
        ],
    ),
    (
        "noto-sans-mono", "Noto Sans Mono", "NOTO-SANS-MONO.txt",
        ("noto-sans-mono", "OFL.txt"), False,
        [
            (400, False, "noto-sans-mono", "NotoSansMono/unhinted/ttf/NotoSansMono-Regular.ttf"),
            (700, False, "noto-sans-mono", "NotoSansMono/unhinted/ttf/NotoSansMono-Bold.ttf"),
        ],
    ),
]

# What a terminal draws in a programming font; the rest falls back to Thyra
# Mono. Latin (with extensions and IPA), combining marks, Greek, Cyrillic,
# general punctuation through math operators and technical symbols, box
# drawing, blocks, geometric shapes, braille (TUI graphs), Powerline,
# presentation-form ligatures and the replacement character.
UNICODES = [
    (0x20, 0x7E), (0xA0, 0x36F), (0x370, 0x3FF), (0x400, 0x52F),
    (0x1E00, 0x1EFF), (0x2000, 0x23FF), (0x2500, 0x25FF), (0x2800, 0x28FF),
    (0x2E00, 0x2E7F), (0xE0A0, 0xE0D7), (0xFB00, 0xFB06), (0xFFFD, 0xFFFD),
]


def fetch(cache: Path, key: str) -> bytes:
    url, digest = SOURCES[key]
    path = cache / key / url.rsplit("/", 1)[1]
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {url}", file=sys.stderr)
        with urllib.request.urlopen(url) as response, open(f"{path}.part", "wb") as out:
            shutil.copyfileobj(response, out)
        Path(f"{path}.part").rename(path)
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        sys.exit(f"{path}: SHA-256 {actual}, expected {digest}")
    return data


def member(cache: Path, key: str, name: str | None) -> bytes:
    data = fetch(cache, key)
    if name is None:
        return data
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.read(name)


def woff2(source: bytes, modify: bool) -> bytes:
    font = TTFont(io.BytesIO(source), recalcBBoxes=False, recalcTimestamp=False)
    if modify:
        options = subset.Options()
        # Every registered feature but character variants and stylistic sets,
        # which the terminal never turns on; Iosevka's, and its private
        # upper-case language variants, would more than double its size.
        options.layout_features = sorted(
            {
                record.FeatureTag
                for table in ("GSUB", "GPOS")
                if table in font
                for record in font[table].table.FeatureList.FeatureRecord
                if not re.fullmatch(r"cv\d\d|ss\d\d|[A-Z]{4}", record.FeatureTag)
            }
        )
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.name_legacy = True
        options.notdef_outline = True
        options.glyph_names = False
        options.hinting = False
        options.recalc_bounds = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(
            unicodes=[c for low, high in UNICODES for c in range(low, high + 1)]
        )
        subsetter.subset(font)
    font.flavor = "woff2"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def face_name(weight: int, italic: bool) -> str:
    style = ("Bold" if weight >= 700 else "") + ("Italic" if italic else "")
    return style or "Regular"


def main() -> None:
    cache = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/thyra-font-presets")
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    entries = []
    for preset, family, license_file, (license_key, license_member), reserved, faces in PRESETS:
        license_text = member(cache, license_key, license_member)
        (LICENSES / license_file).write_bytes(license_text.replace(b"\r\n", b"\n"))
        rows = []
        for weight, italic, key, name in faces:
            data = woff2(member(cache, key, name), modify=not reserved)
            digest = hashlib.sha256(data).hexdigest()[:10]
            file = f"{face_name(weight, italic)}-{digest}.woff2"
            (OUT_DIR / preset).mkdir(parents=True, exist_ok=True)
            (OUT_DIR / preset / file).write_bytes(data)
            rows.append(json.dumps(file.removesuffix(".woff2")))
            print(f"{preset}/{file}: {len(data)} bytes", file=sys.stderr)
        key = preset if preset.isidentifier() else json.dumps(preset)
        items = [json.dumps(family), *rows]
        line = f"  {key}: [{', '.join(items)}],"
        # Biome's layout: one line when it fits in 80 columns.
        entries.append(
            line
            if len(line) <= 80
            else f"  {key}: [\n" + "".join(f"    {item},\n" for item in items) + "  ],"
        )
    MANIFEST.write_text(
        "// Generated by scripts/build-terminal-font-presets.py; do not edit by hand.\n"
        "// Self-hosted terminal font presets (OFL-1.1, see THIRD_PARTY_NOTICES.md):\n"
        f"// the family, then the {URL_ROOT}/<preset>/ faces, regular first.\n"
        "export const TERMINAL_FONT_PRESET_FILES: Record<string, string[]> = {\n"
        + "\n".join(entries)
        + "\n};\n"
    )


if __name__ == "__main__":
    main()
