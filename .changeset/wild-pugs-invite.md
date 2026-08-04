---
'csuite-cli': patch
---

Fix the `csuite claude` / `csuite codex` status strip wrapping its agent name into the bottom-left corner. The strip's width was tallied by hand and undercounted by two columns at every terminal size, so the tail of the label wrapped back onto column 1 of the same row. Widths are now measured from the rendered text, and a long name is ellipsized on a narrow terminal instead of overflowing.
