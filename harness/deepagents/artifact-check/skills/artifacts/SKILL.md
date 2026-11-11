---
name: artifacts
description: How to write an Artifact's Source, by its type, and publish it with the Artifact tool.
---

# Artifacts

Publish with the `Artifact` tool. Publishing the same `file_path` again makes a new version of the same Artifact. The tool checks the Source first and returns every error, each naming the file, the element and the nearest allowed form; fix them all and publish again in the same turn. Nothing is saved until the Source passes.

## Pages

An untyped Artifact is one self-contained HTML page: publish it with `file_path` = the page. It runs its scripts in a sandbox. Its scripts load libraries only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com, each pinned to an exact version `<package>@<x.y.z>` (`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`, never `chart.js` or `chart.js@4`). Put everything else inline: the page reaches no other host, and fetches nothing.

## Slides

A deck is a folder holding `project/deck.json` and one `project/slides/<id>.html` per slide. Publish it with `file_path` = `<folder>/project/deck.json`. Write `deck.json` first, then the slides in `order`: each slide shows as soon as its file is written.

<!-- The examples and the generated table stay exactly as written: tests run them through the checker. -->
<!-- prettier-ignore-start -->

`project/deck.json`, the index:

```json
{"v":4,"createdOnFiles":{"v":1,"at":"2026-09-14T18:20:00Z"},"lists":"css","title":"Q3","order":["cover","plan"],"sections":{"s1":{"description":"Numbers","start":"cover"}},"faces":{"source-serif-4":{"family":"Source Serif 4","href":"https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@300..700&display=swap"}},"designSystems":[]}
```

`order` = slide ids in deck order, each `[A-Za-z0-9_-]{1,64}` with its file written. `sections` = the outline: any key → one sentence and its first slide's id. `cover` = the cover slide's id. `faces` = one entry per typeface the slides name (at most 4): `family` plus `href`, a `https://fonts.googleapis.com/css2?…` link.

`project/slides/<id>.html` is EXACTLY ONE `<section id="<id>" …>`, nothing before or after it: no `<html>`, `<head>`, `<style>` or `<body>`. A slide is a fixed 1920×1080 px canvas; every style is inline, from the table below. On the section: `background` (always), the text defaults (`font-family`, `color`) and the layout: `display:flex; flex-direction:column` or `display:grid`, `padding:128px` (the margins), `gap`, `align-items`, `justify-content`. Children flow in it; `position:absolute` pins a child to the slide (`left`/`top`/`right`/`bottom`/`width`/`height`). Later children paint over earlier ones. Headings `<h1>` `<h2>` `<h3>`, `<p>` (none under 24px), `<ul>`/`<ol>` of plain `<li>`, inline `<b>` `<i>` `<u>` `<a href>` (shown as its text: a slide has no navigation) `<span style="color:…">`, `<div>` containers, `<img src alt>` (src is the image itself, a `data:image/png;base64,…` URI: a slide loads nothing), `<table>` of `<tr>`/`<th>`/`<td>`, `<hr>`, `<svg aria-label>` for a chart (only the svg elements and attributes listed under the table), and `<aside>` as the LAST child for speaker notes. A pinned `<x-embed>`, a direct child of the section, holds a small live page with scripts and no network.

One content slide's file, `project/slides/plan.html`:

```html
<section id="plan" data-transition="fade" style="background:#fbfbf8;color:#1a1a1a;font-family:Georgia, serif;padding:128px 128px 160px;display:flex;flex-direction:column;justify-content:space-between;gap:48px">
<h2 style="font-family:'Source Serif 4', Georgia, serif;font-size:72px;font-weight:400;line-height:1.1">Changes</h2>
<div style="display:flex;gap:32px">
<div style="flex:1;display:flex;flex-direction:column;gap:12px;background:#ffffff;padding:40px;border:1px solid #e3e6e4;border-radius:16px">
<h3 style="font-size:32px;font-weight:600">One path</h3>
</div>
<img src="data:image/jpeg;base64,/9j/4AAQSkZJRg…" alt="HQ" style="width:480px;height:360px;object-fit:cover;border-radius:16px">
</div>
<p style="position:absolute;left:128px;bottom:64px;font-size:24px;color:#6a7179">Source: poll</p>
<aside>Say hi.</aside>
</section>
```

A slide of tiles, flow plus a pinned footer:

```html
<section id="kpis" style="background:#fbfbf8; padding:128px 128px 160px; display:flex; flex-direction:column; gap:40px">
  <p style="font-size:24px; font-weight:600; letter-spacing:2px; color:#2b7a78">Q3 IN NUMBERS</p>
  <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:32px">
    <div style="background:#fff; border:1px solid #e3e6e4; border-radius:16px; padding:40px; display:flex; flex-direction:column; gap:8px">
      <p style="font-size:120px; font-weight:600; line-height:1; color:#0f2a3d">41%</p>
      <p style="font-size:28px; color:#4a5568">faster ramp</p>
    </div>
    <div style="background:#fff; border:1px solid #e3e6e4; border-radius:16px; padding:40px; display:flex; flex-direction:column; gap:8px">
      <p style="font-size:120px; font-weight:600; line-height:1; color:#0f2a3d">6→1</p>
      <p style="font-size:28px; color:#4a5568">onboarding paths</p>
    </div>
    <!-- third tile alike -->
  </div>
  <p style="position:absolute; left:128px; bottom:64px; font-size:24px; color:#6a7179">Source: People Ops, Q3 survey (n=212)</p>
</section>
```

The whole subset; anything else is an error:

<!-- generated:slides-rules -->
| Property | Values | On |
| --- | --- | --- |
| `position` | absolute \| relative | any |
| `left`, `top` | LEN \| PCT \| auto \| calc(PCT ± LEN) | pinned |
| `right`, `bottom` | LEN \| PCT \| auto | pinned |
| `width`, `height` | LEN \| auto \| PCT | any |
| `min-width` | LEN \| min-content \| max-content | div child |
| `min-height`, `max-width`, `max-height` | LEN | div child |
| `display` | flex \| grid \| none (no display = column) | section, div |
| `flex-direction` | row \| column [-reverse] | flex box |
| `flex-wrap` | wrap \| nowrap | div |
| `gap` | LEN [LEN] 0–512 | section, div |
| `align-items` | start \| center \| end \| stretch \| baseline (flex-* forms ok) | section, div |
| `justify-content` | start \| center \| end \| space-between \| space-around \| space-evenly | flex box |
| `justify-items` | start \| center \| end \| stretch | grid box |
| `align-self` | start \| center \| end \| stretch \| baseline \| auto | div child |
| `justify-self` | start \| center \| end \| stretch \| auto | div child |
| `flex` | none \| auto \| N [N] [LEN \| 0% \| auto] | div child |
| `flex-grow`, `flex-shrink` | N | div child |
| `flex-basis` | LEN \| auto | div child |
| `grid-template-columns`, `grid-template-rows` | (LEN \| Nfr \| auto \| repeat(INT, …))+, ≤24 tracks | grid box |
| `grid-column`, `grid-row` | span INT | div child |
| `aspect-ratio` | N \| N / N | div child |
| `padding` | LEN 0–256 ×1–4 | section, div, text, table, td, th |
| `overflow` | hidden \| visible | div |
| `font-family` | 'Declared Face', Basic, generic | text, table |
| `font-size` | LEN 8–400 (Npt converts) | text, table |
| `font-weight` | 100–900 (whole hundreds) \| normal \| bold | text, th, span |
| `font-style` | normal \| italic | text, span |
| `font` | [italic] [weight] LEN[/N] FAMILY | text |
| `line-height` | N \| PCT \| LEN | text |
| `letter-spacing` | LEN \| Nem (−24–32px) \| normal | text |
| `text-align` | left \| center \| right \| justify | text, td, th |
| `text-transform` | none \| uppercase \| lowercase \| capitalize | text |
| `white-space` | normal \| nowrap | text |
| `text-decoration` | none \| underline \| line-through [solid \| double \| dotted \| dashed \| wavy] [COLOR] | text, span |
| `font-variant-numeric` | normal \| tabular-nums | text |
| `-webkit-text-stroke` | LEN 0–8 COLOR | text |
| `-webkit-text-fill-color` | transparent \| currentcolor | text, span |
| `color` | COLOR | text, table, span, td, th, x-icon, x-connector, hr |
| `background` | COLOR \| one gradient[, COLOR under it] | section, div, text, img, table, x-icon, tr, x-shape, hr |
| `background-clip` | text | text |
| `border` | [LEN 0–16] solid \| dashed \| dotted \| double \| none [COLOR] | div, text, img, table, x-icon, x-shape, hr, x-connector |
| `border-top`, `border-right`, `border-bottom`, `border-left` | as border \| none | div, text, img, table, x-icon |
| `border-width` | LEN ≤32 | x-connector |
| `border-style` | solid \| dashed \| dotted | x-connector |
| `border-radius` | LEN \| PCT ×1–4 | div, text, img, table, x-shape |
| `box-shadow` | [inset] LEN LEN [LEN [LEN]] COLOR, … ≤8 | div, text, img, table, x-icon, x-shape |
| `text-shadow` | LEN LEN [LEN] COLOR, … ≤8 | text, table |
| `opacity` | N 0–1 | any |
| `transform` | translate(LEN[, LEN]) \| translateX\|Y(LEN \| -50%), rotate(ANGLE), scale(N 0.5–2), skew[X\|Y](ANGLE) | any |
| `filter`, `backdrop-filter` | blur(LEN ≤20) brightness\|contrast(N) saturate(N) grayscale\|sepia\|invert(N) hue-rotate(ANGLE) | div, text, img, x-shape |
| `mix-blend-mode` | normal \| multiply \| screen \| overlay \| darken \| lighten | div, text, img, x-shape |
| `object-fit` | cover \| contain | img |
| `margin` | 0 (a no-op) | any |
| `box-sizing` | border-box (a no-op) | any |
| `grid-template` | none (a no-op) | any |

LEN = Npx or a bare N (px); PCT = N%; COLOR = #hex, rgb[a](), hsl[a](), a named color or transparent (no currentcolor, no var()); ANGLE = Ndeg, Nturn or Nrad. `text` = h1, h2, h3, p, ul, ol; a text row set on a section or div inherits down. `pinned` = position:absolute. `div child` = a flow child of a div or the section.

Elements: `<section>` `<h1>` `<h2>` `<h3>` `<p>` `<ul>` `<ol>` `<li>` `<br>` `<b>` `<i>` `<u>` `<a>` `<span>` `<div>` `<img>` `<table>` `<tr>` `<th>` `<td>` `<hr>` `<aside>` `<svg>` `<x-shape>` `<x-icon>` `<x-connector>` `<x-embed>`. `<x-shape kind>`: rect, rounded, ellipse, diamond, arrow-right, arrow-left, arrow-up, arrow-down, line. `<x-icon name>`: Activity, Book, Chart, Chat, Check, CheckCircle, Clock, Cloud, Code, Database, Globe, GraduationCap, Home, Key, Lightbulb, Lightning, Link, Lock, PaperPlane, Play, Search, Settings, Star, ThumbsUp, Tool, Trust, Users, Verified, Warning, Wrench.

Inside an `<svg>`: `<g>` `<path>` `<rect>` `<circle>` `<ellipse>` `<line>` `<polyline>` `<polygon>` `<defs>` `<marker>` `<lineargradient>` `<radialgradient>` `<stop>` `<clippath>` `<mask>` `<pattern>` `<text>` `<tspan>` `<title>` `<desc>`, with `viewbox` `xmlns` `d` `x` `y` `x1` `y1` `x2` `y2` `cx` `cy` `r` `rx` `ry` `width` `height` `points` `fill` `fill-opacity` `fill-rule` `stroke` `stroke-width` `stroke-dasharray` `stroke-linecap` `stroke-linejoin` `stroke-opacity` `opacity` `transform` `offset` `stop-color` `stop-opacity` `gradientunits` `gradienttransform` `markerwidth` `markerheight` `refx` `refy` `orient` `markerunits` `marker-start` `marker-end` `marker-mid` `clip-path` `mask` `font-size` `font-weight` `text-anchor` `dominant-baseline` `preserveaspectratio` `overflow` (and id, class, data-*). No href, style or url() but url(#id).

Limits: 200 elements a slide, 15 nested `<div>`s, 24 pinned children a host, 8 `<x-embed>`s a slide of 16 KB each, `<svg>` 52 KB each, speaker notes 4000 characters, tables 100 rows by 24 columns, 4 faces, 500 slides.
<!-- /generated:slides-rules -->
<!-- prettier-ignore-end -->
