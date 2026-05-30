# @connectome/heartbeat-mcpl

Periodic self-wake MCPL server for Connectome agents.

On a configurable interval, sends a `push/event` (featureSet `heartbeat`,
`origin.source: heartbeat`) to wake the agent for a self-check-in. The agent
itself configures its own schedule via three MCP tools:

- `heartbeat_status` — show current interval, paused state, time-to-next, message
- `heartbeat_configure` — set `intervalSeconds | intervalMinutes | intervalHours`, `paused`, `message`; persists across restarts
- `heartbeat_trigger` — fire one heartbeat now (test/debug)

Schedule is persisted to `${HEARTBEAT_CONFIG_FILE:-./heartbeat-config.json}`.

## Recipe wiring

```jsonc
{
  "mcpServers": {
    "heartbeat": {
      "command": "node",
      "args": ["/path/to/heartbeat-mcpl/dist/src/index.js", "--stdio"],
      "env": { "HEARTBEAT_CONFIG_FILE": "/path/to/install/data/heartbeat-config.json" },
      "enabledFeatureSets": ["heartbeat"]
    }
  },
  "modules": {
    "wake": {
      "policies": [
        { "name": "heartbeat-wake",
          "match": { "scope": ["mcpl:push-event"], "source": "heartbeat" },
          "behavior": "always" }
        // ... your other policies after
      ]
    }
  }
}
```

The wake policy MUST come before any policy that would skip `mcpl:push-event`s
(e.g. a `discord-ambient` skip rule), since the gate is first-match-wins.
