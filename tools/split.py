#!/usr/bin/env python3
"""One-time: split the single-file Iron Log artifact into src/ files.

Each <style>/<script> block is moved to its own file and replaced in
src/index.html by a marker line:  <!--@inline css/main-0.css-->  etc.
tools/build.py reverses this exactly.
"""
import re, sys, pathlib

src_html = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out = pathlib.Path(sys.argv[2])
(out / "css").mkdir(parents=True, exist_ok=True)
(out / "js").mkdir(parents=True, exist_ok=True)

block = re.compile(r"(<(style|script)>)(.*?)(</\2>)", re.S)
counts = {"style": 0, "script": 0}
used = set()

def name_for(tag, body):
    if tag == "style":
        n = f"css/style-{counts['style']}.css"
        counts["style"] += 1
        return n
    m = re.match(r"\s*/\*\s*js/([\w.-]+?)\.js", body)
    base = m.group(1) if m else f"inline-{counts['script']}"
    counts["script"] += 1
    n = f"js/{base}.js"
    i = 2
    while n in used:
        n = f"js/{base}-{i}.js"; i += 1
    return n

def repl(m):
    open_tag, tag, body, close_tag = m.groups()
    n = name_for(tag, body)
    used.add(n)
    (out / n).write_text(body, encoding="utf-8")
    return f"{open_tag}<!--@inline {n}-->{close_tag}"

shell = block.sub(repl, src_html)
(out / "index.html").write_text(shell, encoding="utf-8")
print("\n".join(sorted(used)))
