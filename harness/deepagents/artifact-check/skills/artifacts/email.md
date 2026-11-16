# Email

An Email draft is one JSON file named `<name>.email.json`, holding the fields of a Gmail draft. Publish it with `file_path` = that file. The User edits the recipients, the subject and the body in place, and downloads it as an unsent `.eml` that opens as a draft in their mail client. Nothing is sent.

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
