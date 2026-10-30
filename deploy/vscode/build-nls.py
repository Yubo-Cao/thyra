"""Rebuild a VS Code Web build's UI translations from a language pack.

The CDN's per-build translation files can be built for a different message
list, which puts strings in the wrong places. This matches them by key
instead; strings the pack lacks stay English.

    python3 build-nls.py <server-dir> <language-pack.vsix> <locale>

writes <server-dir>/nls/<commit>/<version>/<locale>/nls.messages.js. Point
the server's product.json `nlsCoreBaseUrl` at
`/vscode/stable-<commit>/static/nls/` so every locale loads locally (one
without a file falls back to English). See docs/DEPLOYMENT.md.
"""

import json
import os
import sys
import zipfile

server, vsix, locale = sys.argv[1:4]
product = json.load(open(os.path.join(server, "product.json")))
out = os.path.join(server, "out")
keys = json.load(open(os.path.join(out, "nls.keys.json")))
english = json.load(open(os.path.join(out, "nls.messages.json")))
pack = zipfile.ZipFile(vsix).read("extension/translations/main.i18n.json")
translations = json.loads(pack)["contents"]

messages, translated = [], 0
for module, names in keys:
    table = translations.get(module, {})
    for name in names:
        value = table.get(name)
        if isinstance(value, str):
            translated += 1
        else:
            value = english[len(messages)]
        messages.append(value)
assert len(messages) == len(english), (len(messages), len(english))

target = os.path.join(
    server, "nls", product["commit"], product["version"], locale
)
os.makedirs(target, exist_ok=True)
with open(os.path.join(target, "nls.messages.js"), "w", encoding="utf8") as f:
    f.write("globalThis._VSCODE_NLS_MESSAGES=")
    json.dump(messages, f, ensure_ascii=False)
    f.write(f';\nglobalThis._VSCODE_NLS_LANGUAGE="{locale}";\n')
print(f"{translated}/{len(english)} messages translated")
