#!/usr/bin/env python3
"""Render a research report as a themed, self-contained HTML page.

The report-writer describes the report as JSON (files/reports/report.json) and
runs this script; the data-analyst's files/data/charts.json supplies the chart
data. Dark theme by default with a light-theme toggle; charts are interactive
SVG with tooltips and a table of their numbers. Standard library only, so any
Python 3 runs it.

    python html_report.py REPORT_JSON OUT_HTML [--charts CHARTS_JSON]

report.json:
    {"title": str, "subtitle": str, "meta": str,
     "summary": [paragraph, ...],
     "verification": {"confirmed": n, "corrected": n, "false": n, "unverified": n},
     "sections": [{"heading": str, "tag": str (optional caution label),
                   "blocks": [{"type": "p", "text": str},
                              {"type": "bullets", "items": [str, ...]},
                              {"type": "table", "header": [str, ...], "rows": [[str, ...], ...]},
                              {"type": "chart", "id": str, "caption": str},
                              {"type": "image", "src": path, "caption": str, "alt": str}]}],
     "sources": [{"title": str, "url": str}, ...],
     "further_reading": [{"title": str, "url": str}, ...]}

Text supports **bold**, [text](url) links and citations [3] or [3, 5], which
link to source 3 and 5.

charts.json, keyed by chart id:
    {"id": {"title": str, "kind": "bar" | "line", "unit": "%" | "$" | str,
            "series": [str, ...], "rows": [[label_or_x, value, ...], ...],
            "x_label": str, "x_unit": str, "decimals": int,
            "marker": {"x": number, "label": str}, "note": str}}

Exits non-zero, listing every problem, if a citation, chart or image is missing.
"""
import argparse
import base64
import html
import json
import re
import sys
from pathlib import Path

MAX_SERIES = 4  # fixed hue order: cyan, magenta, amber, lime
# A column is right-aligned when every cell leads with a number, e.g. "29.23%", "$2,088" or "5 (analyst)".
NUMERIC = re.compile(r"^[~≈<>≤≥+\-−]?[$€£]?\d")
INLINE = re.compile(r"\*\*(.+?)\*\*|\[([^\]]+)\]\((https?://[^)\s]+)\)|\[(\d+(?:\s*[,;]\s*\d+)*)\]")


class Report:
    def __init__(self, content, charts, base_dirs):
        self.c = content
        self.charts = charts
        self.base_dirs = base_dirs
        self.problems = []
        self.cited = set()
        self.n_sources = len(content.get("sources", []))

    # ------------------------------------------------------------ text
    def inline(self, text):
        out, last = [], 0
        for m in INLINE.finditer(text):
            out.append(html.escape(text[last:m.start()]))
            bold, ltext, url, cites = m.groups()
            if bold is not None:
                out.append(f"<strong>{self.inline(bold)}</strong>")
            elif url is not None:
                out.append(f'<a href="{html.escape(url)}">{html.escape(ltext)}</a>')
            else:
                links = []
                for n in (int(x) for x in re.split(r"\s*[,;]\s*", cites)):
                    if not 1 <= n <= self.n_sources:
                        self.problems.append(f"citation [{n}] has no source (there are {self.n_sources})")
                    self.cited.add(n)
                    links.append(f'<a href="#src{n}">{n}</a>')
                out.append(f'<span class="cite">[{", ".join(links)}]</span>')
            last = m.end()
        out.append(html.escape(text[last:]))
        return "".join(out)

    # ------------------------------------------------------------ blocks
    def table(self, b):
        header, rows = b.get("header", []), b.get("rows", [])
        for i, r in enumerate(rows):
            if len(r) != len(header):
                self.problems.append(f"table '{header[:1]}' row {i + 1} has {len(r)} cells, header has {len(header)}")
        numeric = set(b.get("numeric", []))
        for j in range(1, len(header)):
            cells = [str(r[j]).strip() for r in rows if j < len(r)]
            cells = [c for c in cells if c.lower() not in ("", "-", "—", "n/a", "na", "none")]
            if cells and all(NUMERIC.match(c) and len(c) <= 32 for c in cells):
                numeric.add(j)
        th = "".join(f'<th scope="col"{" class=num" if j in numeric else ""}>{html.escape(h)}</th>'
                     for j, h in enumerate(header))
        body = []
        for r in rows:
            cells = []
            for j, cell in enumerate(r):
                s = self.inline(str(cell))
                if j == 0:
                    cells.append(f'<th scope="row">{s}</th>')
                else:
                    cells.append(f'<td{" class=num" if j in numeric else ""}>{s}</td>')
            body.append(f"<tr>{''.join(cells)}</tr>")
        return (f'<div class="table-wrap" tabindex="0"><table><thead><tr>{th}</tr></thead>'
                f'<tbody>{"".join(body)}</tbody></table></div>')

    def chart(self, b):
        cid = b.get("id", "")
        spec = self.charts.get(cid)
        if spec is None:
            self.problems.append(f"chart '{cid}' is not in charts.json")
            return ""
        series = spec.get("series", [])
        if not 1 <= len(series) <= MAX_SERIES:
            self.problems.append(f"chart '{cid}' has {len(series)} series; use 1 to {MAX_SERIES}")
        for i, r in enumerate(spec.get("rows", [])):
            if len(r) != len(series) + 1:
                self.problems.append(f"chart '{cid}' row {i + 1} needs a label and {len(series)} values")
        cap = b.get("caption") or spec.get("note", "")
        return (f'<figure class="chart" data-chart="{html.escape(cid)}">'
                f'<figcaption><span class="chart-title">{html.escape(spec.get("title", cid))}</span>'
                f'<span class="chart-cap">{self.inline(cap)}</span></figcaption>'
                f'<div class="plot" aria-hidden="true"></div>'
                f'<details class="data"><summary>Show the numbers</summary><div class="data-table"></div></details>'
                f"</figure>")

    def image(self, b):
        src = b.get("src", "")
        path = next((d / src for d in self.base_dirs if (d / src).is_file()), None)
        if path is None:
            self.problems.append(f"image not found: {src}")
            return ""
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"}.get(
            path.suffix.lower(), "image/png")
        data = base64.b64encode(path.read_bytes()).decode()
        alt = html.escape(b.get("alt") or b.get("caption") or path.stem)
        return (f'<figure class="image"><img src="data:{mime};base64,{data}" alt="{alt}">'
                f'<figcaption class="chart-cap">{self.inline(b.get("caption", ""))}</figcaption></figure>')

    def blocks(self, blocks):
        out, figs = [], []

        def flush():
            if figs:
                out.append(f'<div class="figs">{"".join(figs)}</div>')
                figs.clear()

        for b in blocks:
            kind = b.get("type")
            if kind in ("chart", "image"):
                figs.append(self.chart(b) if kind == "chart" else self.image(b))
                continue
            flush()
            if kind == "p":
                out.append(f'<p class="prose">{self.inline(b.get("text", ""))}</p>')
            elif kind == "h3":
                out.append(f"<h3>{html.escape(b.get('text', ''))}</h3>")
            elif kind == "bullets":
                out.append('<ul class="bullets">' + "".join(f"<li>{self.inline(i)}</li>" for i in b.get("items", []))
                           + "</ul>")
            elif kind == "table":
                out.append(self.table(b))
            else:
                self.problems.append(f"unknown block type: {kind!r}")
        flush()
        return "".join(out)

    # ------------------------------------------------------------ page parts
    def verification(self):
        v = self.c.get("verification")
        if not v:
            return ""
        parts = [("confirmed", "Confirmed", "good"), ("corrected", "Corrected", "warn"),
                 ("false", "False", "bad"), ("unverified", "Unverified", "none")]
        counts = [(label, cls, int(v.get(key, 0))) for key, label, cls in parts]
        total = sum(n for _, _, n in counts)
        if not total:
            return ""
        segs = "".join(f'<span class="seg {cls}" style="flex-grow:{n}" title="{label}: {n}"></span>'
                       for label, cls, n in counts if n)
        keys = "".join(f'<li><i class="{cls}" aria-hidden="true"></i>{label} <b>{n}</b></li>'
                       for label, cls, n in counts)
        return (f'<div class="checked"><p class="checked-head">{total} claims checked against their sources</p>'
                f'<div class="checked-bar" role="img" aria-label="'
                + html.escape(", ".join(f"{label} {n}" for label, _, n in counts))
                + f'">{segs}</div><ul class="checked-key">{keys}</ul></div>')

    def sources(self):
        items = []
        for n, s in enumerate(self.c.get("sources", []), 1):
            url = s.get("url", "")
            where = (f'<a href="{html.escape(url)}">{html.escape(url)}</a>' if url
                     else f'<span class="path">{html.escape(s.get("path", ""))}</span> '
                          '<span class="local">local file, no URL</span>')
            items.append(f'<li id="src{n}" value="{n}"><span class="src-title">{html.escape(s.get("title", ""))}</span> '
                         f"{where}</li>")
        return f'<ol class="sources">{"".join(items)}</ol>'

    def further(self):
        fr = self.c.get("further_reading", [])
        if not fr:
            return ""
        items = "".join(f'<li><a href="{html.escape(s.get("url", ""))}">{html.escape(s.get("title", ""))}</a></li>'
                        for s in fr)
        return ('<section id="further-reading" aria-labelledby="further-reading-h">'
                '<h2 id="further-reading-h">Further reading</h2>'
                '<p class="prose">Related coverage gathered during research but not independently verified. '
                f'No figure in this report relies on these sources.</p><ul class="further">{items}</ul></section>')

    def render(self):
        c = self.c
        for key in ("title", "sections", "sources"):
            if not c.get(key):
                self.problems.append(f"report.json needs '{key}'")
        sections, toc, used = [], [], set()
        for i, s in enumerate(c.get("sections", [])):
            heading = s.get("heading", f"Section {i + 1}")
            sid = re.sub(r"[^a-z0-9]+", "-", heading.lower()).strip("-") or f"s{i + 1}"
            while sid in used:
                sid += "-x"
            used.add(sid)
            tag = f'<span class="tag">{html.escape(s["tag"])}</span>' if s.get("tag") else ""
            toc.append(f'<a href="#{sid}">{html.escape(heading)}</a>')
            sections.append(f'<section id="{sid}" aria-labelledby="{sid}-h"><h2 id="{sid}-h">{html.escape(heading)}'
                            f'{tag}</h2>{self.blocks(s.get("blocks", []))}</section>')
        toc.append('<a href="#sources">Sources</a>')
        summary = "".join(f"<p>{self.inline(p)}</p>" for p in c.get("summary", []))
        uncited = sorted(set(range(1, self.n_sources + 1)) - self.cited)
        data_json = json.dumps(self.charts).replace("</", "<\\/")
        title = c.get("title", "Research report")
        page = f"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(c.get("subtitle", ""))}">
<script>try{{if(localStorage.getItem('report-theme')==='light')document.documentElement.dataset.theme='light';}}catch(e){{}}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap" rel="stylesheet">
<style>{CSS}</style>
</head>
<body>
<div class="bar"><span class="bar-title">{html.escape(title)}</span>
<button id="theme-toggle" class="theme-toggle" type="button"><span class="dot" aria-hidden="true"></span><span class="txt">Light theme</span></button></div>
<main>
<header class="hero">
<h1>{html.escape(title)}</h1>
{f'<p class="subtitle">{html.escape(c["subtitle"])}</p>' if c.get("subtitle") else ""}
{f'<p class="meta">{html.escape(c["meta"])}</p>' if c.get("meta") else ""}
{f'<div class="verdict">{summary}</div>' if summary else ""}
{self.verification()}
</header>
<nav class="toc" aria-label="Sections">{"".join(toc)}</nav>
{"".join(sections)}
<section id="sources" aria-labelledby="sources-h"><h2 id="sources-h">Sources</h2>{self.sources()}</section>
{self.further()}
<footer>{html.escape(c.get("footer") or c.get("meta") or title)}</footer>
</main>
<script type="application/json" id="chart-data">{data_json}</script>
<script>{JS}</script>
</body>
</html>
"""
        return page, uncited


CSS = r"""
:root{
  color-scheme:dark;
  --bg:#060a17;--surface:#0d1430;--raise:#131c3f;--line:#1f2a52;--line-strong:#2d3a6b;
  --ink:#eaf0ff;--ink2:#a9b3d9;--muted:#76819f;
  --c0:#31e8ff;--c1:#ff4fd8;--c2:#ffbe3d;--c3:#a6ff4d;
  --good:#3dffa8;--warn:#ffbe3d;--bad:#ff5c7a;--none:#4a557f;
  --glow:0 0 6px;--link:#7cf0ff;--accent:#ffbe3d;
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f4f6fc;--surface:#ffffff;--raise:#eef1fa;--line:#dde2f1;--line-strong:#c3cbe3;
  --ink:#0c1330;--ink2:#3d4669;--muted:#6a7395;
  --c0:#0098c7;--c1:#c4169f;--c2:#b06a00;--c3:#4f8a00;
  --good:#0f9d63;--warn:#b06a00;--bad:#cf2541;--none:#b7bfd8;
  --glow:0 0 0;--link:#006f99;--accent:#b06a00;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:17px;line-height:1.55}
a{color:var(--link);text-underline-offset:.18em;text-decoration-thickness:1px}
a:focus-visible,button:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--c0);outline-offset:3px;border-radius:3px}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:16px;justify-content:space-between;
  padding:10px max(16px,calc((100vw - 1120px)/2));background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.bar-title{font-weight:700;font-stretch:112%;font-size:15px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.theme-toggle{flex:none;font:inherit;font-size:14px;font-weight:600;color:var(--ink);background:var(--raise);
  border:1px solid var(--line-strong);border-radius:999px;padding:6px 14px;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
.theme-toggle:hover{border-color:var(--c0)}
.theme-toggle .dot{width:10px;height:10px;border-radius:50%;background:var(--c0);box-shadow:var(--glow) var(--c0)}
main{padding:0 16px 96px}
.prose{max-width:70ch}
header.hero{max-width:1120px;margin:0 auto;padding:56px 0 24px}
h1{font-stretch:125%;font-weight:850;font-size:clamp(34px,6vw,60px);line-height:1.04;letter-spacing:-.02em;margin:0 0 18px;max-width:20ch}
.subtitle{font-size:clamp(18px,2.2vw,22px);color:var(--ink2);max-width:56ch;margin:0 0 14px;line-height:1.4}
.meta{font-size:14px;color:var(--muted);max-width:70ch;margin:0}
.verdict{margin:32px 0 0;padding:20px 22px;border-left:3px solid var(--accent);background:var(--surface);
  border-radius:0 10px 10px 0;max-width:78ch}
.verdict p{margin:0 0 10px}.verdict p:last-child{margin:0}
.checked{margin:28px 0 0;max-width:78ch}
.checked-head{margin:0 0 10px;font-weight:650;color:var(--ink2);font-size:15px}
.checked-bar{display:flex;gap:2px;height:14px}
.checked-bar .seg{flex:1 1 0;min-width:4px;border-radius:2px}
.checked-bar .seg:first-child{border-radius:4px 2px 2px 4px}.checked-bar .seg:last-child{border-radius:2px 4px 4px 2px}
.checked-bar .seg:only-child{border-radius:4px}
.seg.good,.checked-key i.good{background:var(--good);box-shadow:var(--glow) var(--good)}
.seg.warn,.checked-key i.warn{background:var(--warn)}
.seg.bad,.checked-key i.bad{background:var(--bad)}
.seg.none,.checked-key i.none{background:var(--none)}
.checked-key{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px 22px;font-size:14px;color:var(--ink2)}
.checked-key li{display:inline-flex;align-items:center;gap:7px}
.checked-key i{width:10px;height:10px;border-radius:2px;display:inline-block}
.checked-key b{color:var(--ink);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:no-preference){
  .checked-bar{animation:reveal .9s cubic-bezier(.4,0,.2,1) .2s both}
}
@keyframes reveal{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
nav.toc{max-width:1120px;margin:28px auto 0;display:flex;flex-wrap:wrap;gap:8px 18px;font-size:15px;
  padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
nav.toc a{color:var(--ink2);text-decoration:none}
nav.toc a:hover{color:var(--ink);text-decoration:underline}
section{max-width:1120px;margin:0 auto;padding-top:56px}
h2{font-stretch:118%;font-weight:800;font-size:clamp(24px,3.2vw,32px);line-height:1.15;letter-spacing:-.01em;margin:0 0 14px;max-width:34ch}
h3{font-stretch:110%;font-weight:750;font-size:20px;margin:32px 0 10px}
p{margin:0 0 14px}
strong{font-weight:700;color:var(--ink)}
.cite a{text-decoration:none}.cite a:hover{text-decoration:underline}
.tag{display:inline-block;font-size:13px;font-weight:600;padding:2px 10px;border-radius:999px;vertical-align:middle;
  margin-left:10px;border:1px solid currentColor;font-stretch:100%;letter-spacing:0;color:var(--accent)}
.table-wrap{overflow-x:auto;margin:18px 0 8px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:15px}
.table-wrap table{min-width:560px}
thead th{background:var(--raise);color:var(--ink2);font-weight:600;text-align:left;
  padding:10px 14px;border-bottom:1px solid var(--line-strong);font-size:14px}
tbody th,tbody td{padding:12px 14px;border-top:1px solid var(--line);vertical-align:top;text-align:left}
tbody th{font-weight:650;color:var(--ink)}
tbody tr:first-child th,tbody tr:first-child td{border-top:0}
th.num,td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
ul.bullets{padding-left:1.2em;max-width:78ch}ul.bullets li{margin:0 0 10px}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:20px;margin:24px 0}
figure.chart,figure.image{margin:0;padding:18px 18px 12px;background:var(--surface);border:1px solid var(--line);border-radius:12px;position:relative}
figure.image img{display:block;width:100%;height:auto;border-radius:6px;background:#fff}
figure.image figcaption{margin-top:10px}
figure.chart figcaption{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.chart-title{font-weight:700;font-size:16px}
.chart-cap{font-size:13.5px;color:var(--ink2)}
.plot svg{display:block;width:100%;height:auto;overflow:visible}
.plot text{fill:var(--ink2);font-size:15px;font-family:inherit}
.plot .val{fill:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.plot .tick{fill:var(--muted);font-size:14px;font-variant-numeric:tabular-nums}
.plot .grid{stroke:var(--line);stroke-width:1}
.plot .base{stroke:var(--line-strong);stroke-width:1}
.plot .mark{transition:opacity .15s}
.plot .s0{fill:var(--c0);filter:drop-shadow(var(--glow) color-mix(in srgb,var(--c0) 70%,transparent))}
.plot .s1{fill:var(--c1);filter:drop-shadow(var(--glow) color-mix(in srgb,var(--c1) 70%,transparent))}
.plot .s2{fill:var(--c2)}.plot .s3{fill:var(--c3)}
.plot .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.plot .ln.s0{stroke:var(--c0)}.plot .ln.s1{stroke:var(--c1)}.plot .ln.s2{stroke:var(--c2)}.plot .ln.s3{stroke:var(--c3)}
.plot .pt{stroke:var(--surface);stroke-width:2}
.plot .ref{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.plot .cross{stroke:var(--line-strong);stroke-width:1;opacity:0}
.plot .hit{fill:transparent}
.plot .hit:focus{outline:none}
.plot g.row:hover .mark,.plot g.row:focus-within .mark{opacity:.75}
.plot g.col:hover .cross,.plot g.col:focus-within .cross{opacity:1}
.legend{display:flex;gap:16px;font-size:13px;color:var(--ink2);margin:2px 0 8px;flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
.tip{position:absolute;pointer-events:none;background:var(--raise);border:1px solid var(--line-strong);border-radius:8px;
  padding:8px 10px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:0;transition:opacity .1s;z-index:3;min-width:120px}
.tip.show{opacity:1}
.tip .v{display:block;font-weight:700;font-size:15px;color:var(--ink);font-variant-numeric:tabular-nums}
.tip .k{display:flex;align-items:center;gap:6px;color:var(--ink2)}
.tip .k i{width:12px;height:2px;display:inline-block;border-radius:1px}
details.data{margin-top:6px;font-size:14px}
details.data summary{cursor:pointer;color:var(--ink2);width:max-content}
details.data table{font-size:14px;margin-top:8px}
details.data td,details.data th{padding:6px 10px}
.sources{padding-left:2.6em;font-size:14.5px;max-width:100ch}
.sources li{margin:0 0 8px;overflow-wrap:anywhere}
.sources li:target{background:color-mix(in srgb,var(--c0) 14%,transparent);border-radius:4px}
.src-title{color:var(--ink)}
.path{color:var(--ink2)}
.local{color:var(--muted);font-size:13px}
.further{columns:2 320px;column-gap:32px;font-size:14.5px;padding-left:1.1em}
.further li{break-inside:avoid;margin:0 0 6px;overflow-wrap:anywhere}
footer{max-width:1120px;margin:72px auto 0;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
@media (max-width:640px){body{font-size:16px}header.hero{padding-top:32px}}
@media print{.bar{display:none}}
"""

JS = r"""
(function(){
  var root=document.documentElement, btn=document.getElementById('theme-toggle');
  function label(){var dark=root.dataset.theme!=='light';
    btn.querySelector('.txt').textContent=dark?'Light theme':'Dark theme';
    btn.setAttribute('aria-label',dark?'Switch to the light theme':'Switch to the dark theme');}
  btn.addEventListener('click',function(){
    root.dataset.theme=root.dataset.theme==='light'?'dark':'light';
    try{localStorage.setItem('report-theme',root.dataset.theme);}catch(e){}
    label();});
  label();
})();

(function(){
  var DATA=JSON.parse(document.getElementById('chart-data').textContent);
  var NS='http://www.w3.org/2000/svg';
  function el(n,a,p){var e=document.createElementNS(NS,n);for(var k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e;}
  function txt(n,a,s,p){var e=el(n,a,p);e.textContent=s;return e;}
  function places(v){var s=String(v);return s.indexOf('.')<0?0:Math.min(3,s.length-s.indexOf('.')-1);}
  function prep(spec){
    var vals=[];spec.rows.forEach(function(r){for(var j=1;j<r.length;j++)vals.push(r[j]);});
    spec._d=spec.decimals!=null?spec.decimals:Math.max.apply(null,vals.map(places).concat([0]));
    spec._signed=vals.some(function(v){return v<0;});
    spec._min=Math.min.apply(null,vals.concat([0]));spec._max=Math.max.apply(null,vals.concat([0]));
    spec._xnum=spec.kind==='line'&&spec.rows.every(function(r){return typeof r[0]==='number';});}
  function fmt(v,spec,d){
    d=d==null?spec._d:d;var u=spec.unit||'',a=Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
    var sign=v<0?'-':(spec._signed&&v>0?'+':'');
    if(u==='$')return sign+'$'+a; if(u==='%')return sign+a+'%'; return sign+a+(u?' '+u:'');}
  function xfmt(v,spec){return typeof v==='number'?v.toLocaleString('en-US',{maximumFractionDigits:3})+(spec.x_unit||''):String(v);}
  function nice(lo,hi){
    var span=hi-lo||1,step=Math.pow(10,Math.floor(Math.log10(span/5))),m=span/5/step;
    step*=m>5?10:m>2?5:m>1?2:1;var a=Math.floor(lo/step)*step,b=Math.ceil(hi/step)*step,t=[];
    for(var v=a;v<=b+step/2;v+=step)t.push(+v.toFixed(10));return {lo:a,hi:b,ticks:t,step:step};}
  function tickD(spec,sc){return Math.max(0,Math.min(3,-Math.floor(Math.log10(sc.step))));}
  function color(i){return getComputedStyle(document.documentElement).getPropertyValue('--c'+i);}
  function tipFor(fig){var t=document.createElement('div');t.className='tip';t.setAttribute('role','status');fig.appendChild(t);return t;}
  function showTip(tip,fig,anchor,title,rows){
    tip.textContent='';
    rows.forEach(function(r){var v=document.createElement('span');v.className='v';v.textContent=r.v;tip.appendChild(v);
      var k=document.createElement('span');k.className='k';var i=document.createElement('i');i.style.background=r.c;k.appendChild(i);
      k.appendChild(document.createTextNode(r.k));tip.appendChild(k);});
    var h=document.createElement('span');h.className='k';h.style.marginTop='4px';h.textContent=title;tip.appendChild(h);
    var fb=fig.getBoundingClientRect(),eb=anchor.getBoundingClientRect();
    var x=Math.min(eb.left-fb.left+eb.width/2,fb.width-150),y=eb.top-fb.top-8;
    tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y-tip.offsetHeight)+'px';tip.classList.add('show');}
  function bind(hit,on,tip){hit.addEventListener('pointerenter',on);hit.addEventListener('focus',on);
    hit.addEventListener('pointerleave',function(){tip.classList.remove('show');});
    hit.addEventListener('blur',function(){tip.classList.remove('show');});}
  function legend(fig,spec){if(spec.series.length<2)return;var lg=document.createElement('div');lg.className='legend';
    spec.series.forEach(function(s,i){var sp=document.createElement('span'),sw=document.createElement('i');
      sw.style.background='var(--c'+i+')';sp.appendChild(sw);sp.appendChild(document.createTextNode(s));lg.appendChild(sp);});
    fig.querySelector('.plot').before(lg);}
  function dataTable(spec,box){
    var t=document.createElement('table'),th=t.createTHead().insertRow(),tb=t.createTBody();
    var h0=document.createElement('th');h0.textContent=spec.x_label||'';th.appendChild(h0);
    spec.series.forEach(function(s){var h=document.createElement('th');h.className='num';h.textContent=s;th.appendChild(h);});
    spec.rows.forEach(function(r){var tr=tb.insertRow();var c0=document.createElement('th');c0.scope='row';
      c0.textContent=xfmt(r[0],spec);tr.appendChild(c0);
      for(var j=1;j<r.length;j++){var c=tr.insertCell();c.className='num';c.textContent=fmt(r[j],spec);}});
    box.appendChild(t);}

  function bar(fig,spec){
    var plot=fig.querySelector('.plot'),tip=tipFor(fig),n=spec.series.length;
    var longest=Math.max.apply(null,spec.rows.map(function(r){return String(r[0]).length;}));
    var W=560,L=Math.min(230,Math.max(90,longest*8.2+16)),R=78,barH=n>1?14:18,gap=n>1?4:0;
    var group=n*barH+(n-1)*gap,band=group+22,T=8,H=T+spec.rows.length*band+28;
    var sc=nice(spec._min,spec._max),svg=el('svg',{viewBox:'0 0 '+W+' '+H},plot),P=spec._min<0?64:0;
    var x=function(v){return L+P+(W-L-P-R)*(v-sc.lo)/(sc.hi-sc.lo);},x0=x(0),td=tickD(spec,sc);
    sc.ticks.forEach(function(v){var xx=x(v);el('line',{x1:xx,x2:xx,y1:T,y2:H-24,'class':v?'grid':'base'},svg);
      txt('text',{x:xx,y:H-6,'text-anchor':'middle','class':'tick'},fmt(v,spec,td),svg);});
    spec.rows.forEach(function(r){
      var y0=T+spec.rows.indexOf(r)*band+11,g=el('g',{'class':'row'},svg);
      txt('text',{x:L-10,y:y0+group/2+5,'text-anchor':'end'},String(r[0]),g);
      spec.series.forEach(function(s,j){
        var v=r[1+j],y=y0+j*(barH+gap),w=Math.abs(x(v)-x0),rr=Math.min(4,w/2),neg=v<0;
        var d=neg?'M'+x0+' '+y+'h'+(-(w-rr))+'a'+rr+' '+rr+' 0 0 0 '+(-rr)+' '+rr+'v'+(barH-2*rr)+'a'+rr+' '+rr+' 0 0 0 '+rr+' '+rr+'h'+(w-rr)+'z'
                 :'M'+x0+' '+y+'h'+(w-rr)+'a'+rr+' '+rr+' 0 0 1 '+rr+' '+rr+'v'+(barH-2*rr)+'a'+rr+' '+rr+' 0 0 1 '+(-rr)+' '+rr+'h'+(-(w-rr))+'z';
        el('path',{'class':'mark s'+j,d:d},g);
        txt('text',{x:neg?x0-w-8:x0+w+8,y:y+barH/2+5,'text-anchor':neg?'end':'start','class':'val'},fmt(v,spec),g);});
      var hit=el('rect',{x:0,y:y0-8,width:W,height:band-6,'class':'hit',tabindex:0,
        'aria-label':r[0]+': '+spec.series.map(function(s,j){return s+' '+fmt(r[1+j],spec);}).join(', ')},g);
      bind(hit,function(){showTip(tip,fig,hit,String(r[0]),spec.series.map(function(s,j){return {v:fmt(r[1+j],spec),k:s,c:color(j)};}));},tip);});
  }

  function line(fig,spec){
    var plot=fig.querySelector('.plot'),tip=tipFor(fig),rows=spec.rows,n=spec.series.length;
    var W=560,H=300,L=78,R=28,T=28,B=46,svg=el('svg',{viewBox:'0 0 '+W+' '+H},plot);
    var sc=nice(spec._min,spec._max),td=tickD(spec,sc),y=function(v){return T+(H-T-B)*(sc.hi-v)/(sc.hi-sc.lo);};
    var xs=rows.map(function(r){return r[0];}),xlo=spec._xnum?Math.min.apply(null,xs):0,xhi=spec._xnum?Math.max.apply(null,xs):rows.length-1;
    if(spec.marker&&spec._xnum){xlo=Math.min(xlo,spec.marker.x);xhi=Math.max(xhi,spec.marker.x);}
    var x=function(v,i){var t=spec._xnum?(v-xlo)/((xhi-xlo)||1):(rows.length>1?i/(rows.length-1):.5);return L+12+(W-L-R-24)*t;};
    sc.ticks.forEach(function(v){el('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),'class':v?'grid':'base'},svg);
      txt('text',{x:L-10,y:y(v)+5,'text-anchor':'end','class':'tick'},fmt(v,spec,td),svg);});
    var every=Math.ceil(rows.length/8);
    rows.forEach(function(r,i){if(i%every===0||i===rows.length-1)txt('text',{x:x(r[0],i),y:H-B+22,'text-anchor':'middle','class':'tick'},xfmt(r[0],spec),svg);});
    if(spec.x_label)txt('text',{x:(L+W-R)/2,y:H-4,'text-anchor':'middle','class':'tick'},spec.x_label,svg);
    if(spec.marker&&spec._xnum){var mx=x(spec.marker.x);el('line',{x1:mx,x2:mx,y1:T,y2:H-B,'class':'ref'},svg);
      txt('text',{x:mx+(mx>W*0.6?-8:8),y:T-10,'text-anchor':mx>W*0.6?'end':'start'},spec.marker.label||'',svg);}
    spec.series.forEach(function(s,j){
      el('polyline',{'class':'ln s'+j,points:rows.map(function(r,i){return x(r[0],i)+','+y(r[1+j]);}).join(' ')},svg);
      rows.forEach(function(r,i){var labelIt=n===1&&(rows.length<=8||i===rows.length-1);
        el('circle',{cx:x(r[0],i),cy:y(r[1+j]),r:4.5,'class':'pt mark s'+j},svg);
        if(labelIt){var first=i===0,last=i===rows.length-1&&rows.length>1;
          txt('text',{x:x(r[0],i)+(first?10:last?-10:0),y:y(r[1+j])+(first||last?(r[1+j]>=0?-10:18):(r[1+j]>=0?-12:22)),
            'text-anchor':first?'start':last?'end':'middle','class':'val'},fmt(r[1+j],spec),svg);}});});
    rows.forEach(function(r,i){
      var cx=x(r[0],i),half=(W-L-R)/Math.max(1,rows.length-1)/2,g=el('g',{'class':'col'},svg);
      el('line',{x1:cx,x2:cx,y1:T,y2:H-B,'class':'cross'},g);
      var hit=el('rect',{x:cx-half,y:T,width:half*2,height:H-T-B,'class':'hit',tabindex:0,
        'aria-label':xfmt(r[0],spec)+': '+spec.series.map(function(s,j){return s+' '+fmt(r[1+j],spec);}).join(', ')},g);
      bind(hit,function(){showTip(tip,fig,hit,(spec.x_label?spec.x_label+' ':'')+xfmt(r[0],spec),
        spec.series.map(function(s,j){return {v:fmt(r[1+j],spec),k:s,c:color(j)};}));},tip);});
  }

  document.querySelectorAll('figure.chart').forEach(function(fig){
    var spec=DATA[fig.dataset.chart];if(!spec)return;prep(spec);legend(fig,spec);
    (spec.kind==='line'?line:bar)(fig,spec);dataTable(spec,fig.querySelector('.data-table'));});
})();
"""


def load_json(path, what):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"Cannot read {what} {path}: {e}")


def main():
    ap = argparse.ArgumentParser(description="Render report.json as a themed HTML report.")
    ap.add_argument("report_json")
    ap.add_argument("out_html")
    ap.add_argument("--charts", help="charts.json written by the data-analyst")
    args = ap.parse_args()

    content = load_json(args.report_json, "report")
    charts = load_json(args.charts, "charts") if args.charts and Path(args.charts).is_file() else {}
    if args.charts and not charts:
        print(f"Note: no chart data at {args.charts}; chart blocks will fail, image blocks still work.")
    json_dir = Path(args.report_json).resolve().parent
    report = Report(content, charts, [Path.cwd(), json_dir, json_dir.parent])
    page, uncited = report.render()
    if report.problems:
        print("HTML report NOT written. Fix report.json and rerun:")
        for p in dict.fromkeys(report.problems):
            print(f"  - {p}")
        sys.exit(1)
    out = Path(args.out_html)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    n_charts = page.count('<figure class="chart"')
    print(f"HTML saved to: {out}")
    print(f"sections: {len(content['sections'])}, charts: {n_charts}, sources: {report.n_sources}, "
          f"cited: {len(report.cited)}")
    if uncited:
        print(f"Warning: sources never cited in the text: {uncited}")


if __name__ == "__main__":
    main()
