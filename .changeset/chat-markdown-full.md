---
'csuite-web-ui': patch
---

Render chat messages with full GFM markdown.

Chat previously used a hand-rolled renderer covering three constructs
(`**bold**`, `*italic*`, `` `code` ``). Everything else agents emit
natively — headings, lists, tables, blockquotes, fenced code, links —
arrived as literal punctuation. The file-preview surface already
rendered full GFM through `marked` + `DOMPurify`, so the same document
looked different depending on which surface you opened it in.

Chat now uses that same pair. Two properties of the old renderer are
kept deliberately, because `marked`'s defaults break both: raw HTML
stays escaped, and `<channel …>` envelopes get syntax colouring rather
than markdown.
