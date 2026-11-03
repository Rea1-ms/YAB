"""Extract translation dictionaries from the old Qt Linguist .ts files
(still available on the local `master` branch) into webapp locale modules.

Usage:  python develop_tools/extract_i18n_from_ts.py

Output: webapp/src/lib/i18n/locales/{en_US,ja_JP,ko_KR}.ts
Merge policy: first-seen context wins for UI strings; the ConfigTranslation
context (config value display names) is applied last so value translations
take precedence.
"""

import json
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

LANGS = ['en_US', 'ja_JP', 'ko_KR']
OUT_DIR = Path('webapp/src/lib/i18n/locales')


def git_show(path: str) -> str:
    res = subprocess.run(['git', 'show', f'master:{path}'], capture_output=True)
    if res.returncode != 0:
        raise RuntimeError(f'git show master:{path} failed: {res.stderr.decode("utf-8", "replace")}')
    return res.stdout.decode('utf-8')


def parse_ts(xml_text: str):
    root = ET.fromstring(xml_text)
    flat = {}
    config_translation = {}
    for ctx in root.findall('context'):
        name_el = ctx.find('name')
        name = name_el.text if name_el is not None and name_el.text else ''
        for msg in ctx.findall('message'):
            src = msg.find('source')
            tr = msg.find('translation')
            if src is None or tr is None or not src.text:
                continue
            if tr.get('type') in ('unfinished', 'vanished') or not tr.text:
                continue
            if name == 'ConfigTranslation':
                config_translation[src.text] = tr.text
            else:
                flat.setdefault(src.text, tr.text)
    flat.update(config_translation)
    return flat


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for lang in LANGS:
        ts = git_show(f'gui/i18n/{lang}.ts')
        entries = parse_ts(ts)
        out = OUT_DIR / f'{lang}.ts'
        body = json.dumps(entries, ensure_ascii=False, indent=2)
        out.write_text(
            '// auto-generated from gui/i18n/%s.ts (master branch) by\n'
            '// develop_tools/extract_i18n_from_ts.py -- do not edit by hand\n'
            'export default %s as Record<string, string>;\n' % (lang, body),
            encoding='utf-8')
        print(f'{lang}: {len(entries)} entries -> {out}')


if __name__ == '__main__':
    main()
