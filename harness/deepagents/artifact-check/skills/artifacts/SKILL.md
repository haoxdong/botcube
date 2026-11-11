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

## Email

An email draft is one JSON file named `<name>.email.json`, holding the fields of a Gmail draft. Publish it with `file_path` = that file. The User edits the recipients, the subject and the body in place, and downloads it as an unsent `.eml` that opens as a draft in their mail client. Nothing is sent.

<!-- prettier-ignore-start -->
```json
{"to":["dana@example.com"],"cc":["finance@example.com"],"subject":"Q3 numbers for review","htmlBody":"<p>Hi Dana,</p><p>The Q3 review is attached. Revenue came in <b>4% over plan</b>; the risks are on page 3.</p><p>Best,<br>Sam</p>","body":"Hi Dana,\n\nThe Q3 review is attached. Revenue came in 4% over plan; the risks are on page 3.\n\nBest,\nSam","attachments":[{"file":"/reports/q3-review.pdf","filename":"Q3 review.pdf","mimeType":"application/pdf"}]}
```
<!-- prettier-ignore-end -->

- `to`, `cc`, `bcc`: lists of plain addresses (`dana@example.com`, not `Dana <dana@example.com>`).
- `subject`: the subject line, and the Artifact's title unless you pass `title`.
- `subject`, addresses and `filename`: one line each, with no line break or control character.
- `htmlBody` (required): the body as HTML, holding only what the User's editor holds, with no attribute but a link's `href`: `p`, `h1` to `h3`, `blockquote`, `hr`, `ul` and `ol` of `li`, `br`, `strong` or `b`, `em` or `i`, `u`, `s`, and `a href` to `https://`, `http://`, `mailto:` or `tel:`. No `style`, `class`, `div`, `span`, `table` or `img`: put a table in a list or an attached File, and an image in `attachments`.
- `body`: the plain-text alternative, without Markdown. Leave it out and the download derives it from `htmlBody`.
- `attachments`: files you saved in Files, each `{"file": "/path/in/files"}` with an optional `filename` and `mimeType`. Write the file first: a publish naming a missing file, a link or a folder is refused.

## Doc

A Doc is one Markdown file. Publish it with `file_path` = the `.md` file; its title is its first `# ` heading unless you pass `title`. The panel fills as you write the file; the User edits it in place and downloads it as Word or PDF.

Write headings, paragraphs, **bold** and _italic_, `~~struck~~` text, bullet lists, `1.` lists (sub-points indented 4 spaces), `- [ ]` tasks, pipe tables, `[text](url)` links, `> ` quotes, `---` rules, fenced code and images. An image is held in the file as a data: URI, `![alt](data:image/png;base64,…)` (png, jpeg, gif, webp or svg+xml): a Doc loads nothing, so `![alt](https://…)` is refused. Lead with the point: the first sentence of the Doc and of each section is the answer, with its number or date.

Markdown holds no look. Publishing checks the Doc and refuses raw HTML (a font color, a size or an alignment, `<span style="color:…">`, `<p align="center">`, an HTML comment), naming each line and the nearest Markdown form: the viewer would show only its text, and the User's next save would drop the HTML. Put emphasis in **bold** or _italic_, and structure in headings, lists and tables.

<!-- The examples stay exactly as written: tests load each one in the Doc's viewer. -->
<!-- prettier-ignore-start -->

A section with a list:

```markdown
## Goals

- Ship the connector to every workspace
- 500 weekly active teams by GA
```

A section with a table and a link in a cell:

```markdown
## Staffing

| Workstream | Owner |
| --- | --- |
| Connector | Platform |
| Launch comms | Marketing ([brief](https://example.com/brief)) |
```

A section of tasks:

```markdown
## Open questions

- [ ] Which workspaces go first?
```

A risk under its heading:

```markdown
## Risks

- GA slips if legal review runs long
```

Bullets with a link:

```markdown
- Launch retro on Oct 6
- [Vendor pricing](https://example.com/pricing)
```

<!-- prettier-ignore-end -->

## Sheet

A Sheet is one `<name>.sheet.json` file: `{"edits": [...]}`, a list of edits applied in order, each naming its `sheet` (a sheet is made by the first edit that names it). Publish it with `file_path` = that file. It shows once published, and the User downloads it as Excel with its formulas.

The edit kinds: `writeCells` (`topLeft`, `rows` of values), `formatCells` (`ranges`, `format`), `setBorders` (`range`, `edges`, `border`), `setColumnWidths` (`columns`, `widthInPixels`), `fitColumns` (`columns`), `setSheetSettings` (`settings`: `lastFrozenRow`, `lastFrozenColumn`, `areGridlinesHidden`), `mergeCells` (`ranges`), `setCellTable` (`cellTable`) and `importFile` (`asset`). Any other kind is refused by name. A range is `A1:C4` or one cell; columns are `B:C` or `B`. A sheet's name is 1 to 31 characters with none of `[ ] : * ? / \`, as Excel requires.

Neither the grid nor the Excel file draws a checkbox or a table yet, so both are refused, naming the edit and the field: a `cellControl` takes only `{"kind":"none"}` (write `true` or `false` in the cells instead), and `setCellTable` takes only `"cellTable":null` (a table's banded rows and `footerRows` are not drawn: bold the header row with `formatCells`, freeze it with `setSheetSettings` `lastFrozenRow`, and write totals as cells).

`writeCells` reads each string as if typed into the cell: `"=SUM(B2:B9)"` is a formula, `"50%"` the number 0.5 shown as a percent, `"$1,200"` money, `"2026-03-15"` a date, and a leading `'` keeps text (`"'02139"`). Numbers, `true`, `false` and `null` (an empty cell) are written as they are. Excel can't read an open-ended range such as `F2:F`: name the last row (`F2:F200`).

For a large or computed table, save it with code as an `.xlsx` or `.csv` File and import it: `{"kind":"importFile","asset":"/data/orders.xlsx"}`, then format it with later edits. An import always makes new sheets: an `.xlsx`'s sheets keep their names, a `.csv` becomes one sheet named after the file (`orders`), and a name already taken gets ` (2)`. An `.xlsx` keeps its formulas, number formats, looks and frozen panes; a `.csv` keeps values only, so a formula in it arrives as text. Publishing keeps a copy of the File with that version, so later changes to the File show only once you publish again; a missing File is refused.

<!-- The example stays exactly as written: tests run it through the checker. -->
<!-- prettier-ignore-start -->

A budget and a task list, `sheets/q4.sheet.json`:

```json
{"edits": [
{"kind":"writeCells","sheet":"Budget","topLeft":"A1","rows":[["Item","Cost"],["Rent",1200],["Zip","'02139"],["Total","=SUM(B2:B3)"]]},
{"kind":"formatCells","sheet":"Budget","ranges":["A1:B1","A4:B4"],"format":{"font":{"bold":true,"italic":false,"underline":"none","strikethrough":false,"size":12,"color":{"kind":"rgb","hex":"#ffffff"}},"fillColor":{"kind":"standard","hue":"blue","shade":600},"alignment":{"horizontal":"center","vertical":"center","wrap":true},"numberFormat":{"pattern":"$#,##0.00"},"border":{"bottom":{"kind":"line","style":"medium","color":{"kind":"none"}}}}},
{"kind":"setBorders","sheet":"Budget","range":"A1:B4","edges":"outer","border":{"kind":"line","style":"thin","color":{"kind":"none"}}},
{"kind":"setColumnWidths","sheet":"Budget","columns":"A:B","widthInPixels":160},
{"kind":"mergeCells","sheet":"Budget","ranges":["A6:B6","A9:B9"]},
{"kind":"setSheetSettings","sheet":"Budget","settings":{"areGridlinesHidden":true}},
{"kind":"writeCells","sheet":"Tasks","topLeft":"A1","rows":[["Task","Owner","Due","Status","Done","Hours","Notes"]]},
{"kind":"formatCells","sheet":"Tasks","ranges":["A1:G1"],"format":{"font":{"bold":true},"fillColor":{"kind":"rgb","hex":"#f3f3f3"}}},
{"kind":"writeCells","sheet":"Tasks","topLeft":"A2","rows":[["Draft the brief","Ana","2026-03-02","Done",true,3,"Sent to legal on Friday. They asked for the vendor list and the renewal dates."],["Book the venue","Raj","2026-03-09","In progress",false,1.5,null],["Send invitations","Ana","2026-03-16","To do",false,2,null]]},
{"kind":"writeCells","sheet":"Tasks","topLeft":"I1","rows":[["Hours left","=SUMIFS(F2:F,E2:E,FALSE)"]]},
{"kind":"formatCells","sheet":"Tasks","ranges":["F2:F200"],"format":{"numberFormat":{"pattern":"0.0"}}},
{"kind":"formatCells","sheet":"Tasks","ranges":["G2:G200"],"format":{"alignment":{"wrap":true}}},
{"kind":"formatCells","sheet":"Tasks","ranges":["I1"],"format":{"font":{"bold":true}}},
{"kind":"setColumnWidths","sheet":"Tasks","columns":"G","widthInPixels":320},
{"kind":"fitColumns","sheet":"Tasks","columns":"A:F"},
{"kind":"fitColumns","sheet":"Tasks","columns":"I:J"},
{"kind":"setBorders","sheet":"Tasks","range":"A9:G9","edges":"top","border":{"kind":"line","style":"thin","color":{"kind":"none"}}},
{"kind":"setSheetSettings","sheet":"Tasks","settings":{"lastFrozenRow":1}}
]}
```

<!-- prettier-ignore-end -->
