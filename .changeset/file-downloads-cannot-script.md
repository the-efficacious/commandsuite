---
'csuite-core': patch
---

Stop serving uploaded files as executable documents on the broker's own origin. `GET /fs/read` reflected the uploader's declared content type with `inline` disposition, so an HTML or SVG upload ran as script — with the opener's session — when the link was opened. Files now download unless they are a type that renders without scripting (raster images, media, PDF), and every response carries `nosniff` plus a restrictive Content-Security-Policy. Image, media and PDF previews in the web UI are unchanged.
