## Superdesign
Project: https://superdesign.dev/teams/39a42d14-af52-4eef-afb5-c20531c92e4f/projects/f4094ddc-9710-4d23-87f6-54c3effccee0

- MCP servers v1: https://p.superdesign.dev/draft/6fb476c4-33b6-4f9a-a3c3-09ff4b4997c6
- MCP servers v2: https://p.superdesign.dev/draft/7f22d763-eb6f-40e4-8b48-1be6a3c0870b
- General v1: https://p.superdesign.dev/draft/188787be-55d5-4a79-ad26-d66900733edc
- General v2: https://p.superdesign.dev/draft/5069aba6-b0ed-4506-8be2-4d678423acb6

No Superdesign command failed. Replica HTML: `.superdesign/replica_html_template/`.

## Screenshots
Before: /tmp/qa-shots/deep-settings-mcp/before-*.png 
After: /tmp/qa-shots/deep-settings-mcp/after-*.png (stories: molecules-overview--settings, settings-mcpsettings--empty/list/add-form/add-form-error/parse-error).

## Cult UI decision
Searched `@cult-ui` (queries: empty, menu). Rejected: organic-card / minimal-card (marketing cards; SettingsCard already covers it), halo-badge (gradient rim + glow break "colour only for state"), gradient-button-group (decorative gradients), poll-widget / feature-poll (not a settings pattern), halo-toast (toast lane, not this surface). No genuine fit, so none adopted; no COMPONENTS.md row added.

## Gaps
- Settings shell already matched §5e (220px, 4 groups, 11px uppercase labels); left unchanged. Notifications split, Context+Plan merge not done.
- MCP: "Add server" now opens the existing McpServerDialog (was inline). Remove is an icon button (`aria-label="Remove <name>"`), Details/Enable toggle kept. No overflow menu.
- Removed expects: none removed; two assertions updated in mcp-settings.test.tsx (Remove now an icon button queried by role/name; target text matched by regex because it is prefixed with transport).
