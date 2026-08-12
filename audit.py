#!/usr/bin/env python3
"""Pre-submission checklist sweep for the 9 Chrome extensions.

Checks, per extension:
  MANIFEST  valid JSON, MV3, name/version/description, desc<=132 chars,
            declared icons exist + are real PNGs of the declared size,
            default_popup file exists, no inline <script>/event handlers,
            no eval/new Function in JS, CSP forbids eval, no remote script src.
  ZIP       valid zip, parses, no junk files (.DS_Store/__MACOSX), contents
            == ext/ runtime files (store/ excluded), sane size.
  SHOT      store screenshot exists, is PNG, 1280x800 or 640x400.
  DESC      store/description.md non-empty, no placeholder text.
  MISC      STORE-FORM-ANSWERS.md present, PRIVACY.md present, README present.
"""
import json, os, re, struct, sys, zipfile

# BASE is the extension root — may point at an extraction dir when SMOKE_BASE
# is set (zip-gate.sh).  LIVE_BASE is always the real project root (harness
# parent), used for store/ screenshots and root docs that aren't in the zips.
LIVE_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get('SMOKE_BASE', LIVE_BASE)
EXTS = ['random-fact-generator','image-to-pdf','where-is-iss','wiki-instant',
        'image-resize-compressor','whiteboard','internet-radio-player','hacker-news-reader',
        'pokemon-price-ticker','yugioh-price-ticker','sports-card-ticker']
PLACEHOLDERS = re.compile(r'\b(TODO|TBD|lorem|placeholder|xxx|example\.com)\b', re.I)
INLINE_SCRIPT = re.compile(r'<script(?![^>]*\bsrc=)[^>]*>', re.I)
EVENT_ATTR = re.compile(r'\son\w+\s*=', re.I)
EVAL_CALLS = re.compile(r'\beval\s*\(|\bnew\s+Function\s*\(|setTimeout\s*\(\s*["\']', re.I)

def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    if not head.startswith(b'\x89PNG'):
        return None
    w, h = struct.unpack('>II', head[16:24])
    return (w, h)

def main():
    rows, problems = [], []
    for name in EXTS:
        d = os.path.join(BASE, name)
        ext = os.path.join(d, 'ext')
        live_d = os.path.join(LIVE_BASE, name)
        live_ext = os.path.join(live_d, 'ext')
        r = {'name': name, 'ok': True, 'notes': []}

        # ---------- manifest ----------
        mpath = os.path.join(ext, 'manifest.json')
        try:
            m = json.load(open(mpath))
        except Exception as e:
            r['ok'] = False; r['notes'].append(f'MANIFEST unparseable: {e}'); rows.append(r); continue
        if m.get('manifest_version') != 3:
            r['ok'] = False; r['notes'].append('MANIFEST not MV3')
        for f in ('name', 'version', 'description'):
            if not m.get(f):
                r['ok'] = False; r['notes'].append(f'MANIFEST missing {f}')
        desc = m.get('description', '')
        if len(desc) > 132:
            r['ok'] = False; r['notes'].append(f'MANIFEST description {len(desc)} chars (>132)')
        if PLACEHOLDERS.search(desc):
            r['ok'] = False; r['notes'].append('MANIFEST description has placeholder text')
        ver = m.get('version', '')
        if not re.fullmatch(r'\d+(\.\d+){0,3}', ver):
            r['ok'] = False; r['notes'].append(f'MANIFEST version not semver-ish: {ver!r}')
        # icons
        icons = m.get('icons', {})
        if not icons:
            r['ok'] = False; r['notes'].append('MANIFEST no icons declared')
        for size, rel in icons.items():
            p = os.path.join(ext, rel)
            if not os.path.exists(p):
                r['ok'] = False; r['notes'].append(f'icon {size} missing ({rel})'); continue
            dim = png_size(p)
            if dim != (int(size), int(size)):
                r['ok'] = False; r['notes'].append(f'icon {size} wrong dims {dim} ({rel})')
        # popup
        act = m.get('action', {}) or m.get('browser_action', {})
        pop = act.get('default_popup')
        if pop and not os.path.exists(os.path.join(ext, pop)):
            r['ok'] = False; r['notes'].append(f'default_popup missing: {pop}')
        # CSP
        csp = json.dumps(m.get('content_security_policy', {}))
        if "'unsafe-eval'" in csp:
            r['ok'] = False; r['notes'].append('CSP allows unsafe-eval')
        # host permissions breadth: only flag blanket grants, not a narrow
        # single host with a path wildcard (e.g. firebaseio API access)
        hp = m.get('host_permissions', [])
        BLANKET = ('<all_urls>', '*://*/*', '*://*/*', 'http://*/*', 'https://*/*', '*://*/', '<all_urls>')
        broad = [h for h in hp if h in BLANKET or h.startswith('*') or h.startswith('http://*') or h.startswith('https://*') or h.startswith('file://*')]
        if broad:
            r['ok'] = False; r['notes'].append(f'host_permissions too broad: {broad}')
        perms = m.get('permissions', [])
        # declarativeNetRequestWithHostAccess is the warning-free variant,
        # used by hacker-news-reader to identify itself via the User-Agent
        # header (documented in its STORE-FORM-ANSWERS.md).
        KNOWN_PERMS = ('storage', 'declarativeNetRequestWithHostAccess')
        if any(p not in KNOWN_PERMS for p in perms):
            r['ok'] = False; r['notes'].append(f'unexpected permission: {perms}')

        # ---------- static code scan ----------
        js_files, html_files = [], []
        for root, _, files in os.walk(ext):
            for f in files:
                p = os.path.join(root, f)
                if f.endswith('.js'): js_files.append(p)
                elif f.endswith('.html'): html_files.append(p)
        for p in html_files:
            src = open(p, encoding='utf-8', errors='replace').read()
            pdir = os.path.dirname(p)
            if INLINE_SCRIPT.search(src): r['ok'] = False; r['notes'].append(f'inline <script> in {os.path.relpath(p, ext)}')
            if EVENT_ATTR.search(src): r['ok'] = False; r['notes'].append(f'inline event handler in {os.path.relpath(p, ext)}')
            for m_src in re.finditer(r'<script[^>]*\bsrc="([^"]+)"', src):
                s = m_src.group(1)
                if s.startswith(('http://', 'https://', '//')):
                    r['ok'] = False; r['notes'].append(f'remote script {s} in {os.path.relpath(p, ext)}')
                elif not os.path.exists(os.path.join(pdir, s)):
                    r['ok'] = False; r['notes'].append(f'script src missing: {s} (in {os.path.relpath(p, ext)})')
            # also referenced css (relative to the html file)
            for m_css in re.finditer(r'<link[^>]*\bhref="([^"]+\.css)"', src):
                c = m_css.group(1)
                if not os.path.exists(os.path.join(pdir, c)):
                    r['ok'] = False; r['notes'].append(f'css href missing: {c} (in {os.path.relpath(p, ext)})')
        for p in js_files:
            src = open(p, encoding='utf-8', errors='replace').read()
            if EVAL_CALLS.search(src):
                r['ok'] = False; r['notes'].append(f'eval/new Function in {os.path.relpath(p, ext)}')

        # ---------- zip ----------
        # upload.zip lives in the real project root, not in an extraction dir.
        zpath = os.path.join(live_d, 'upload.zip')
        if not os.path.exists(zpath):
            r['ok'] = False; r['notes'].append('ZIP missing')
        else:
            try:
                z = zipfile.ZipFile(zpath)
                bad = z.testzip()
                if bad: r['ok'] = False; r['notes'].append(f'ZIP corrupt member: {bad}')
                names = z.namelist()
                junk = [n for n in names if '.DS_Store' in n or n.startswith('__MACOSX') or '/.' in n or n.startswith('._')]
                if junk: r['ok'] = False; r['notes'].append(f'ZIP junk entries: {junk[:3]}')
                # directory entries are legal; only compare real files
                # compare to ext runtime (exclude store/)
                ext_files = set()
                for root, _, files in os.walk(ext):
                    for f in files:
                        if '/store' in root or root.endswith('store'): continue
                        ext_files.add(os.path.relpath(os.path.join(root, f), ext))
                zip_files = set(n for n in names if not n.endswith('/'))
                if ext_files != zip_files:
                    only_ext = sorted(ext_files - zip_files)
                    only_zip = sorted(zip_files - ext_files)
                    r['ok'] = False; r['notes'].append(f'ZIP/EXT mismatch: only-ext={only_ext} only-zip={only_zip}')
                if os.path.getsize(zpath) > 5_000_000:
                    r['ok'] = False; r['notes'].append(f'ZIP large ({os.path.getsize(zpath)//1024} KB)')
            except Exception as e:
                r['ok'] = False; r['notes'].append(f'ZIP unreadable: {e}')

        # ---------- screenshot ----------
        shot = os.path.join(live_ext, 'store', 'screenshot.png')
        if not os.path.exists(shot):
            r['ok'] = False; r['notes'].append('SHOT missing')
        else:
            dim = png_size(shot)
            if dim not in ((1280, 800), (640, 400)):
                r['ok'] = False; r['notes'].append(f'SHOT dims {dim} (need 1280x800 or 640x400)')
            if os.path.getsize(shot) < 10_000:
                r['ok'] = False; r['notes'].append(f'SHOT suspiciously small ({os.path.getsize(shot)} bytes)')
        # small promo tile (optional but recommended)
        promo = os.path.join(live_ext, 'store', 'promo.png')
        if not os.path.exists(promo):
            r['notes'].append('promo tile missing (optional, 440x280 recommended)')
        else:
            if png_size(promo) != (440, 280):
                r['ok'] = False; r['notes'].append(f'promo tile dims {png_size(promo)} (need 440x280)')

        # ---------- description / store assets ----------
        descf = os.path.join(live_ext, 'store', 'description.md')
        if not os.path.exists(descf):
            r['ok'] = False; r['notes'].append('DESC file missing')
        else:
            txt = open(descf, encoding='utf-8', errors='replace').read()
            if len(txt.strip()) < 100:
                r['ok'] = False; r['notes'].append('DESC too short')
            if PLACEHOLDERS.search(txt):
                r['ok'] = False; r['notes'].append('DESC has placeholder text')
        for misc, label in (('STORE-FORM-ANSWERS.md', 'STORE_FORM'), ('PRIVACY.md', 'PRIVACY'), ('README.md', 'README')):
            if not os.path.exists(os.path.join(live_d, misc)):
                r['ok'] = False; r['notes'].append(f'{label} missing')
        sf = os.path.join(live_d, 'STORE-FORM-ANSWERS.md')
        if os.path.exists(sf):
            stxt = open(sf, encoding='utf-8', errors='replace').read()
            if PLACEHOLDERS.search(stxt):
                r['ok'] = False; r['notes'].append('STORE_FORM has placeholder text')
            if 'mrfentmen.github.io' not in stxt:
                r['notes'].append('STORE_FORM no privacy URL mention (check field 8)')
        pv = os.path.join(live_d, 'PRIVACY.md')
        if os.path.exists(pv) and 'mrfentmen.github.io/privacy-policies' not in open(pv, encoding='utf-8', errors='replace').read():
            r['notes'].append('PRIVACY.md missing the live privacy-policies URL')

        rows.append(r)

    # ---------- report ----------
    all_ok = True
    for r in rows:
        flag = 'PASS' if r['ok'] else 'FAIL'
        all_ok = all_ok and r['ok']
        print(f"[{flag}] {r['name']}")
        for n in r['notes']:
            print(f"       - {n}")
    print()
    print('=== OVERALL:', f'ALL {len(EXTS)} PASS' if all_ok else f'{sum(1 for r in rows if not r["ok"])} EXTENSIONS NEED ATTENTION', '===')
    sys.exit(0 if all_ok else 1)

if __name__ == '__main__':
    main()
