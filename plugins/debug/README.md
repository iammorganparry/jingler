# Jingler Debug

Official DAP debugger plugin. Agents use the `debug` tool; Jingler’s Files view follows stopped source locations and exposes runtime variables and controls.

Adapters are auto-selected from installed executables. Override or add adapters with `.jingler/dap.json` or `.jingler/dap.yaml`:

```json
{
  "adapters": {
    "custom": {
      "command": "my-debug-adapter",
      "args": ["--stdio"],
      "fileTypes": [".foo"],
      "launchDefaults": { "stopOnEntry": true }
    }
  }
}
```

The implementation is adapted from oh-my-pi’s MIT-licensed DAP debugger.
