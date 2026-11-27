#!/usr/bin/env python3
"""Build dist/ for GitHub Pages:
  dist/index.html  — src/index.html with every <!--@inline path--> marker replaced by that file
  dist/*           — everything in src/public/ (manifest, icons, sw.js)
  dist/sw.js       — __VERSION__ replaced with a hash of index.html, so each deploy refreshes the offline cache

Usage: python3 tools/build.py [src_dir] [out_dir]
"""
import hashlib, re, shutil, sys, pathlib

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src")
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "dist")
shell = (src / "index.html").read_text(encoding="utf-8")
html = re.sub(r"<!--@inline ([\w./-]+)-->",
              lambda m: (src / m.group(1)).read_text(encoding="utf-8"), shell)
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
(out / "index.html").write_text(html, encoding="utf-8")
pub = src / "public"
if pub.is_dir():
    shutil.copytree(pub, out, dirs_exist_ok=True)
sw = out / "sw.js"
if sw.exists():
    ver = hashlib.sha256(html.encode()).hexdigest()[:12]
    sw.write_text(sw.read_text(encoding="utf-8").replace("__VERSION__", ver), encoding="utf-8")
(out / ".nojekyll").write_text("")   # GitHub Pages: serve files as-is
print(f"built {out}/index.html ({len(html.encode())} bytes) + {sum(1 for p in out.rglob('*') if p.is_file()) - 1} files")
