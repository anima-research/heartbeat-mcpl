# @connectome/heartbeat-mcpl

Periodic self-wake MCPL server for Connectome agents. It needs Node.js
22.12.0 or later.

On a configurable interval, sends a `push/event` (featureSet `heartbeat`,
`origin.source: heartbeat`) to wake the agent for a self-check-in. The agent
itself configures its own schedule via three MCP tools:

- `heartbeat_status` — show current interval, paused state, time to the next wake while one is coming, message, and whether wakes can be delivered
- `heartbeat_configure` — set the interval (`intervalSeconds`, `intervalMinutes` and `intervalHours`, which add up, 60 seconds or more), `paused`, `deliveryMode`, `message`; the schedule is saved so that it persists across restarts, and the reply says if a change can't be or wasn't saved
  - `deliveryMode: "message"` sends the timestamped configured prompt (legacy/default)
  - `deliveryMode: "silent"` emits an empty, authenticated heartbeat wake; a supporting host supplies ephemeral private context and suppresses automatic prose (see [Silent mode](#silent-mode) for what it requires)
- `heartbeat_trigger` — fire one heartbeat now (test/debug)

Schedule is persisted to `${HEARTBEAT_CONFIG_FILE:-./heartbeat-config.json}`.

No save loses this file or the reminders file when the server can't use it.
One that can't be read at all is left as it is, and nothing is saved over
it until a restart reads it again: the server runs on what it holds in
memory meanwhile. One that reads but isn't what the server writes, such as
a file a crash tore during a save, is copied aside first, to
`<file>.unreadable-<hash>`, and the server starts without it. One the
server can use in part is copied aside the same way, and the server starts
with what it can use: a file with bytes that aren't UTF-8, such as one
edited in another encoding, read with replacement characters (U+FFFD) in
their place, and a reminders file with rows the server can't load. The log
names the copy, and when a copy can't be made, the file is left as one that
can't be read is. While a file couldn't be used, or was used only in part,
each reply that shows or counts what its store holds says so, and a call
whose change isn't saved, because its file couldn't be read or copied aside
or writing it failed, says that too.

Every argument a tool call sends is applied, or the call is refused, changes
nothing and names each problem at once: a value of the wrong type or out of
range, two arguments that contradict each other, or a name the tool doesn't
take that is a slip for one it does, or for one another of these tools takes.
A slip is the same name ignoring case, a few edits away, a part of it of three
letters or more, such as `mode` for `deliveryMode`, or, for a name of three
letters or more, a longer name that holds it, sent without it, such as
`heartbeatIntervalMinutes` for `intervalMinutes`. Each name is weighed on its
own: `pausedReason` sent beside `paused` is no slip for it, while
`pausedMessage` sent beside it is a slip for `message`. Any other name a tool
doesn't take is ignored, and the result says so and what the tool takes,
unless the call sends nothing else to a tool that takes arguments, which then
refuses it. Lengths are kept to the millisecond. A `heartbeat_trigger` whose
heartbeat can't be sent, and a `reminder_cancel` whose id no pending reminder
has, are errors too, each saying why and what to do.
"Heartbeat fired" means the heartbeat was sent; a host that then refuses it
says so only in this server's log.

## Reminders

`reminder_add`, `reminder_list` and `reminder_cancel` manage one-shot and
recurring reminders. A delay (`inSeconds`, `inMinutes`, `inHours`) or an
interval (`everySeconds`, `everyMinutes`, `everyHours`) adds up its units. A
recurring reminder's interval is 5 seconds or more, and it first fires one
interval out, or at the delay or `atIso` given with it. Reminders are
persisted to
`${HEARTBEAT_REMINDERS_FILE:-./heartbeat-reminders.json}`. A due reminder is a
`push/event` with `origin.source: "reminder"` and `origin.reminderId`. Its text
starts with a header saying it is a reminder, which reminder, and the current
time, followed by the reminder's own message:

```
[reminder rem_…, set 2026-10-10T08:02:36-07:00 [America/Los_Angeles] · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] <message>
```

A recurring reminder says `repeats every <n>s` where a one-shot says when it was
set. A reminder that fires a minute or more after it was due adds `, due <time>`.
Hosts typically store push content as-is and keep `origin` out of what the
model reads, so without the header the message would arrive unattributed. A
message that opens `Name: …` would then read as a chat line from that person.

A reminder fires only when its wake can be delivered. While no wake can be,
before the host's policy arrives, after a malformed one, or under one that
denies wakes, a reminder that falls due waits, overdue, and fires once when one
can, a recurring one once for the periods it missed. `reminder_list` shows it
`(overdue)` and ends with why it waits. On an MCP-only host, or a pre-0.5 one
that sends its policy only as a Notification, no wake is ever delivered, and
`reminder_add` and `reminder_list` say that no reminder will fire there. While
no wake can be delivered, the log says how many reminders won't fire and why,
at start, at each policy change, add and cancel, and when the host answers a
reminder's push.

A reminder changes only when the host takes its push: a one-shot the host took
is removed, and a recurring one advances. One the host refused, or whose push
failed or got no answer within 30 s, is held: `reminder_list` shows it with
the reason and when, and it is tried once more at the host's next policy
update, the next `reminder_add` or `reminder_cancel`, or a restart. A
recurring one is also tried again an interval after it was refused or failed,
so one such push doesn't stop it. Until the host takes it, the reminders file
holds it as it was, so one whose push is still out when the server stops, or
crashes, fires again at the next start. If the host had in fact taken such a
push, or took one but answered after 30 s, the agent hears that reminder a
second time when it is sent again.

## Filewake (opt-in)

Set `FILEWAKE_DIR` to deliver text files as wakes. The directory is created at
startup if missing. With this variable unset, filewake is entirely off and
its other settings are ignored. Invalid enabled settings fail startup with
the setting named. Startup also rejects an inbox that is the directory of
the config or reminders file (including path/symlink aliases), regardless of
the suffix filter, to protect persisted state and recovery copies. Use a
separate inbox; a dedicated child directory is fine.
Existing directories are also compared by device/inode identity (including
bind-mount aliases). If a protected state path cannot be resolved, startup
warns and falls back to lexical path comparison, still rejecting a collision.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `FILEWAKE_DIR` | unset (off) | Nonblank directory path; relative paths use the process working directory. A symlink directory is not supported. |
| `FILEWAKE_EXT` | empty | Optional case-sensitive suffix such as `.txt` or `.alert`; a dot followed by letters, digits, `_` or `-`. Empty matches all eligible files. |
| `FILEWAKE_INTERVAL_MS` | `5000` | Integer milliseconds, `1000`–`86400000`, between completed polls. |
| `FILEWAKE_MAX_CHARS` | `4000` | Integer Unicode code points of file text, `1`–`1000000`; the prefix is added afterward. |
| `FILEWAKE_PREFIX` | empty | Literal text prepended to each file; every `{name}` is replaced by its basename. For example, `[filewake {name}] `. |

Only regular files directly in the directory are considered, in sorted name
order. Symlinks, subdirectories and dotfiles are ignored; no suffixes are
reserved, so `.tmp` files are eligible too. Use a dedicated, trusted directory
with one server consuming it. Producers should write a
hidden temporary file there, close it, then rename it to a unique final name;
do not modify or reuse published names. Files already present at startup
are also delivered.

The first poll runs after protocol initialization. Files are read and pushed
one at a time, and polls never overlap. Reads are bounded to at most four
bytes per configured character plus three bytes for a possible leading BOM,
even for huge files. Text is decoded as UTF-8 with replacement characters for
invalid bytes; a leading UTF-8 BOM is stripped before truncating without
splitting Unicode code points. No timestamp, truncation marker or other text
is added by default. Empty files are sent too; a host that refuses empty text
will leave them waiting unless a nonempty prefix is configured.

Each wake uses the existing `heartbeat` feature set and push path, with
`origin.source: "filewake"` and `origin.file` containing the basename. The
host must grant wakes as described below; heartbeat pause and silent mode do
not affect filewake. Each file is removed only after the host accepts its
push. Blocked, refused, failed or unanswered pushes keep the file for the
next poll, with at most one attempt per file per poll. While policy blocks
delivery, scans are skipped and a blocked-state message is logged only when
the reason changes. Policy updates request an immediate, coalesced scan,
without overlapping a pending push or waiting for the poll interval. A push
waits at most 30 seconds for an answer. Polling stops on disconnect.

Filewake logs filenames, not file text. Per-file messages start with
`filewake "<name>":` and use these forms:

- `pushed` — accepted and removed.
- `NOT pushed (will retry)` — refused or failed push; logged once per queued
  basename and outcome class (refused, transport failure, timeout) until success
  or a scan sees that basename absent. Retries continue each poll without
  logging host refusal text or host responses. Transport errors and
  timeouts are always logged separately as `push failed (filewake): <error>`,
  including the timeout warning that a retry may deliver the file twice.
- `NOT pushed (will retry): <error>` — could not read a file; this includes
  `not a regular file` if an entry changed type after the directory scan.
- `pushed; file changed, kept for retry` — accepted, but the file changed.
- `pushed; already removed` — accepted, but the file was already gone.
- `pushed, but not removed (will retry): <error>` — accepted, but checking or
  removing the file failed.

A blocked state is logged as `filewake blocked: <reason>`, not once per file.
A directory/poll error is logged as `filewake poll failed: <error>`.

Files detected as replaced or changed while a push is pending are kept;
read, directory and removal errors are logged and retried. Delivery is not
exactly-once: a timeout, crash after acceptance, failed removal or changed
file can result in another delivery. Keep this directory separate from the
server's config and reminders files, and writable only by trusted producers:
its contents become agent input, and accepted files are deleted.

## Silent mode

A silent tick is an empty `push/event` carrying the host's silent-heartbeat
marker: feature set `heartbeat`, `origin.source: "heartbeat"`,
`origin.silent: true`, no content. The host turns it into a private wake with
no stored message only when **both** of these hold:

- the host is agent-framework **0.20.0 or later**, which includes silent heartbeat
  wakes (anima-research/agent-framework#216);
- this server is configured under the id **`heartbeat`**, the `mcpServers` key
  in the recipe below. The host matches the marker on that exact server id. This
  server always sets the feature set and origin fields correctly, but the id
  comes from your configuration.

Otherwise the marker is only an empty push, with nothing in it for the agent to read:

- **Hosts that reject empty pushes** answer with JSON-RPC `-32602`. These are
  agent-framework releases that include anima-research/agent-framework#236.
  This server then re-sends that tick in message mode: the timestamped
  configured prompt, with `origin.silentFallback: true`. It logs one `WARNING`
  per process, and `heartbeat_status` reports
  `mode=silent (the host refused a silent wake, …)`. Every tick tries
  silent first.
- **Older hosts accept the empty push** and wake the agent with nothing new to
  read. The agent then often invents a cause for the wake. Hosts do not
  advertise silent-wake support, so this server cannot detect this case. Check
  both requirements before you switch to silent mode, and use
  `deliveryMode: "message"` on hosts that do not meet them.

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
`delivery=BLOCKED (…)`, and the log says why each heartbeat is dropped and how
many reminders won't fire.

**Symptom of a pre-0.5 host** — the server is up, tools work, and no wake ever arrives.
Check the log for:

```
WARNING: initial policy has still not arrived as a Request. …
suppressed heartbeat push/event — host sent featureSets/update only as a Notification, …
```

or, from a host that sends no policy at all:

```
suppressed heartbeat push/event — no valid featureSets/update Request in force (none yet, or the last was malformed); …
```

That means the host is sending policy as a Notification (or not at all) and must be updated
before this server can deliver anything.
