# Doc

A Doc is one Markdown file. Publish it with `file_path` = the `.md` file; its title is its first `# ` heading unless you pass `title`. The panel fills as you write the file; the User edits it in place and downloads it as Word or PDF.

Write headings, paragraphs, **bold** and _italic_, `~~struck~~` text, bullet lists, `1.` lists (sub-points indented 4 spaces), `- [ ]` tasks, pipe tables, `[text](url)` links, `> ` quotes, `---` rules, fenced code and images. An image is held in the file as a data: URI, `![alt](data:image/png;base64,…)` (png, jpeg, gif, webp or svg+xml): a Doc loads nothing, so `![alt](https://…)` is refused. Lead with the point: the first sentence of the Doc and of each section is the answer, with its number or date.

Markdown holds no look. Publishing checks the Doc and refuses raw HTML (a font color, a size or an alignment, `<span style="color:…">`, `<p align="center">`, an HTML comment), naming each line and the nearest Markdown form: the viewer would show only its text, and the User's next save would drop the HTML. Put emphasis in **bold** or _italic_, and structure in headings, lists and tables.
