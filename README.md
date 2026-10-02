# @connectome/heartbeat-mcpl

Periodic self-wake MCPL server for Connectome agents.

On a configurable interval, sends a `push/event` (featureSet `heartbeat`,
`origin.source: heartbeat`) to wake the agent for a self-check-in. The agent
itself configures its own schedule via three MCP tools:

- `heartbeat_status` — show current interval, paused state, time-to-next, message
- `heartbeat_configure` — set `intervalSeconds | intervalMinutes | intervalHours`, `paused`, `deliveryMode`, `message`; persists across restarts
  - `deliveryMode: "message"` sends the timestamped configured prompt (legacy/default)
  - `deliveryMode: "silent"` emits an empty, authenticated heartbeat wake; a supporting host supplies ephemeral private context and suppresses automatic prose
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

## MCPL 0.5: the host must send initial policy as a Request

This server implements MCPL 0.5 negotiated policy, which **changes the deployment
contract**. It no longer pushes hopefully.

Per SPEC §5.3, until the initial policy exchange completes a server MUST treat every
capability-dependent behavior as unavailable — and per §6.7 a `featureSets/update`
**Notification cannot establish that ready state**. So a host must, after `initialize`:

```jsonc
// Host → server, a Request (note the id), even when nothing is enabled or disabled
{ "jsonrpc": "2.0", "id": 7, "method": "featureSets/update",
  "params": { "effectiveCapabilities": ["tools", "pushEvents"],
              "enabled": ["heartbeat"] } }
```

and read back the degradation receipt (§6.7):

```jsonc
{ "accepted": true, "mode": "full", "unavailableFeatures": [], "notes": [] }
```

`effectiveCapabilities` is the sole allowlist (§5.4) and **absence of a path is denial**.
Omit `pushEvents` and the `heartbeat` feature set is disabled: tools keep answering, but no
wake is ever delivered. The receipt says so explicitly, `heartbeat_status` reports
`delivery=BLOCKED (…)`, and the log carries one line per dropped wake.

**Symptom of a pre-0.5 host** — the server is up, tools work, and no wake ever arrives.
Check the log for:

```
suppressed heartbeat push/event — no featureSets/update Request received yet; …
WARNING: initial policy has still not arrived as a Request. …
```

That means the host is sending policy as a Notification (or not at all) and must be updated
before this server can deliver anything.
