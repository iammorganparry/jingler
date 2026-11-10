# Provider connect flow — end-to-end wiring (boards 15a–15d)

## Retire setup-token entry points <!-- id: retire-setup-token -->
- [ ] Remove `Provider.connectClaudeToken` RPC (contracts, main rpc, rpc-client, broker, service)
- [ ] Remove the paste form from onboarding, settings, ProviderAuthForms
- [ ] Existing `claude-setup-token` connections show "Reconnect with Claude Code CLI or an API key"; schema literal stays

## Sheet wiring <!-- id: sheet-wiring -->
- [ ] `startLogin` stays in flight → waiting card; success → `connected` → close
- [ ] `useProviderLoginEvents(connectionId)` feeds device code + reopen URL
- [ ] Claude subscription tab = native `claude auth login` hint + Refresh

## Settings 15d <!-- id: settings-15d -->
- [ ] Group connections into `ProviderAccountsCard`; Add another account opens the sheet
- [ ] Entitlement warning on `entitlement-unconfirmed`

## Onboarding on the sheet <!-- id: onboarding-sheet -->
- [ ] Adding an account opens the sheet instead of inline forms

## Tests <!-- id: tests -->
- [ ] Unit tests, typecheck, lint
- [ ] e2e: provider-onboarding, settings-pages, Claude specs → `e2e:affected`
