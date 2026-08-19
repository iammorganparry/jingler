# Linear

The official Jingler plugin for Linear issues.

Configure a Linear personal API key in **Settings → Plugins → Linear**. The key
is encrypted by Jingler and is available only to this plugin's host process.
The renderer receives normalized issue data and never receives the credential.

The plugin can create sessions from Linear issues, link or create an issue from
an existing session, show issue metadata and comments, add comments, refresh,
open the issue in Linear, and unlink it.

Enabled Linear accounts also provide native agent tools for workspace metadata,
issue search/read/create/update, and comments. Tools resolve the current
session's repository mapping in the host (not from model-authored input), and
successful issue results are linked back to that session automatically. The Issue tab can also hold multiple
named, encrypted Linear accounts and save a default account/team/project per
repository, with an optional per-session override.

## Development

```bash
pnpm --filter @jingler/plugin-linear test
pnpm --filter @jingler/plugin-linear typecheck
pnpm --filter @jingler/plugin-linear build
```
