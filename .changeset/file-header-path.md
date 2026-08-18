---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Clean up the code view header. The floating square over the top-left of every file — actually the collapsed file-tree toggle, universally read as a useless copy button — no longer floats over the code: it sits inline at the left of the toolbar (still labeled "Repository files"). The open file's path now sits on the LEFT of the toolbar, filename-first: the directory clips with an ellipsis, the filename itself never truncates — previously the path was right-aligned with a tail-truncate that ate the filename and kept the least useful half.
