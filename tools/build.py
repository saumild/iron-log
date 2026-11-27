#!/usr/bin/env python3
"""Build dist/index.html: re-inline every <!--@inline path--> marker in src/index.html.

Usage: python3 tools/build.py [src_dir] [out_file]
"""
import re, sys, pathlib

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src")
dst = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "dist/index.html")
shell = (src / "index.html").read_text(encoding="utf-8")
html = re.sub(r"<!--@inline ([\w./-]+)-->",
              lambda m: (src / m.group(1)).read_text(encoding="utf-8"), shell)
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(html, encoding="utf-8")
print(f"built {dst} ({len(html.encode())} bytes)")
