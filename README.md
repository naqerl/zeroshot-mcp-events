# zeroshot-mcp-events

A bridge, not a server. It turns **Zeroshot Platform run events** into **ntfy
notifications**, so an existing [`ntfy-mcp`](https://github.com/naqerl/ntfy-mcp)
server can hand those events to a chat or an agent with its `ntfy_read` /
`ntfy_publish` tools and the MCP events extension.

```
 zsp watch / zsp list        this bridge              ntfy            ntfy-mcp
┌──────────────────┐   NDJSON   ┌────────────┐   POST   ┌────────┐   GET/SSE   ┌──────────┐
│ Platform run evt │ ─────────► │ filter +   │ ───────► │ topic  │ ──────────► │ chat /   │
│ (cursor, phase,  │            │ summarise  │          │        │             │ agent    │
│  nodes, result)  │            └────────────┘          └────────┘             └──────────┘
```

## Why two layers

* **Layer 1 — this program.** `zsp` speaks NDJSON about runs; ntfy speaks HTTP
  POSTs with a title. This process is the adapter. It is stateless, single-file,
  dependency-free, and dies with the run (or keeps polling with `--follow`).
* **Layer 2 — `ntfy-mcp`.** It already knows how to read a topic, page history
  with a cursor, and stream new messages as MCP events. Subscribing is then
  ordinary MCP, no Zeroshot-specific server needed:

  ```jsonc
  // tools/call
  {"name": "ntfy_read", "arguments": {"topic": "zs-runs", "since": "10m"}}
  // or the events extension
  {"method": "events/stream",
   "params": {"event": "ntfy.message", "filter": {"topic": "zs-runs"}}}
  ```

  A chat that has `ntfy-mcp` attached writes one line — *"watch topic
  `zs-runs` and tell me when the run fails"* — and the agent does the rest with
  `ntfy_read`. Nothing here needs an MCP server of its own.

Because the transport is ntfy, the consumer can be a phone, a shell loop, an
MCP client, or another agent; the bridge does not care.

## Quick start

```bash
# 1. one run, straight to a public throwaway topic (watch first, it is not a secret)
node zeroshot-mcp-events.mjs --watch 01a1ea00-3456-79c1-a256-9334a540c749 \
  --ntfy-url https://ntfy.sh --topic zs-mcp-events-demo

# 2. see what would be sent, without sending it
node zeroshot-mcp-events.mjs --stdin --dry-run --topic zs-demo \
  < fixtures/example-events.ndjson

# 3. follow every live run on the platform (up to 4 at a time)
NTFY_URL=https://ntfy.naqerl.com NTFY_TOKEN=tk_xxx NTFY_TOPIC=zs-runs \
  node zeroshot-mcp-events.mjs --follow

# 4. read them back from any consumer
curl -s "https://ntfy.sh/zs-mcp-events-demo/json?poll=1"
```

Requires **Node.js 22+** (`fetch`, `AbortSignal.timeout`, `String.replaceAll`)
and `zsp` on `PATH` (or `--zsp /path/to/zsp`, or `ZSP_BIN`). No `npm install`.

## Usage

```
zeroshot-mcp-events --watch <runId> --topic <topic> [options]
zeroshot-mcp-events --follow        --topic <topic> [options]
zeroshot-mcp-events --stdin         --topic <topic> [options]
```

Exactly one source is required.

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--watch <runId>` | — | — | spawn `zsp watch --target platform <runId>` and read its NDJSON stdout |
| `--follow` | — | — | poll `zsp list --target platform` and watch every non-terminal run |
| `--stdin` | — | — | read NDJSON from stdin (fixtures, pipes, dry runs) |
| `--ntfy-url <url>` | `NTFY_URL` | `https://ntfy.sh` | ntfy base URL |
| `--topic <topic>` | `NTFY_TOPIC` | **required** | `[-_A-Za-z0-9]{1,64}` |
| `--token <token>` | `NTFY_TOKEN` | empty | sent as `Authorization: Bearer`; prefer the env var |
| `--kinds <list>` | — | all | comma list matched against kind, `phase:<p>`, `node:<n>`, `run:<id>`; `*` wildcards |
| `--quiet-phases` | — | off | drop heartbeats (phase and active set unchanged) |
| `--no-token-only` | — | off | drop events whose body has no detail line |
| `--raw` | — | off | append the raw JSON (truncated) to the body |
| `--poll-secs <n>` | — | `30` | `--follow` polling interval |
| `--max-watchers <n>` | — | `4` | `--follow` concurrent watchers |
| `--zsp <path>` | `ZSP_BIN` | `zsp` | zsp binary |
| `--target <name>` | — | `platform` | zsp target |
| `--after <cursor>` | — | — | passed to `zsp watch --after` (resume) |
| `--click-template <u>` | — | — | `Click` header; `{runId}` / `{run}` substituted |
| `--max-retries <n>` | — | `8` | ntfy retries on 429/5xx and network errors |
| `--dry-run` | — | off | print the HTTP request instead of sending |
| `--verbose` | — | off | log every received, deduped and filtered event |

### Event kinds

Each NDJSON line is classified from the run's `status`:

| Kind | When |
| --- | --- |
| `run-start` | first event seen for a run |
| `phase-change` | `status.phase` differs from the previous event |
| `node-start` / `node-end` | the `activeExecutions` node set gained / lost a node |
| `graph-result` | `graphResult` appeared (graph finished, finalisation pending) |
| `heartbeat` | nothing changed since the previous event |
| `terminal` | phase is `finished`/`failed`/`cancelled`… or `terminalResult` exists |
| `event` / any other | an input that carries its own `kind`/`name`/`type` field |

`--kinds` also matches `phase:<phase>`, `node:<node>` and `run:<runId>`, so
`--kinds terminal,node:acceptance` means "only terminal events and work on the
acceptance node".

### Message shape

Title `zeroshot <run8> <node> <phase>`; tags and priority follow the phase
(`running`→`arrow_forward`/2, `succeeded`/`finished`→`white_check_mark`/3,
`failed`→`x`/4, `waiting`→`hourglass`/2); body is up to ten short lines
(title, repo, kind, cursor, nodes started/stopped, failure reason). Raw JSON is
only included with `--raw`.

### Robustness

* malformed NDJSON → one stderr line, processing continues;
* identical `(runId, cursor)` pairs are published once (replays are free);
* ntfy `429`/`5xx`/network errors retry with exponential backoff
  (500 ms → 60 s cap, ±25 % jitter), other statuses are not retried;
* `SIGINT`/`SIGTERM` flush in-flight publishes and kill child watchers;
* `--follow` reaps watchers whose run reached a terminal phase and never
  exceeds `--max-watchers`.

## systemd

See `deploy/zeroshot-mcp-events.service`. It runs as a dedicated user, reads the
token from `EnvironmentFile=` (mode `0600`) rather than from argv, and restarts
on failure:

```bash
sudo install -o zs-mcp -g zs-mcp -m 0600 deploy/zeroshot-mcp-events.env /etc/zeroshot-mcp-events.env
sudo install -m 0644 deploy/zeroshot-mcp-events.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now zeroshot-mcp-events
journalctl -u zeroshot-mcp-events -f
```

## Docker

The published image is `ghcr.io/naqerl/zeroshot-mcp-events`; every `v*` tag
publishes `:<tag>`, `:<major>.<minor>` and `:latest` for `linux/amd64` and
`linux/arm64` (see `.github/workflows/release.yml`). It ships the upstream
Zeroshot CLI (`npm install -g @the-open-engine-company/zeroshot`), so `--watch`
and `--follow` work with no mounted binary — the CLI authenticates from
`ZEROSHOT_API_KEY`.

The CLI version is pinned in the `Dockerfile` (`ARG ZEROSHOT_VERSION=16.2.0`)
and in CI. Do not go back to `latest`: the platform changes the event wire
format independently, and a CLI that predates a field rejects the whole frame
(16.0.0 looped on `unknown field \`recordedAt\``). 16.1.0+ understands the
current frames; 17.x requires target-discovery protocol `v3`, which the
platform API does not serve yet.

```bash
docker run --rm -e NTFY_URL=https://ntfy.naqerl.com \
  -e NTFY_TOPIC=zs-runs -e NTFY_TOKEN=tk_xxx -e ZEROSHOT_API_KEY=zs_xxx \
  ghcr.io/naqerl/zeroshot-mcp-events:latest --follow --target platform
```

To read events from stdin instead of the platform (dry runs, replaying a saved
stream):

```bash
docker run --rm -i -e NTFY_URL=https://ntfy.naqerl.com -e NTFY_TOPIC=zs-runs \
  ghcr.io/naqerl/zeroshot-mcp-events:latest --stdin < events.ndjson
```

Locally, `docker build -t zeroshot-mcp-events .` builds the same thing; pass
`--build-arg ZEROSHOT_VERSION=16.2.0` to override the pinned CLI.

The image runs as uid 10001, needs only outbound HTTPS (platform API + ntfy) and
writes nothing to disk.

## Security notes

* **On `ntfy.sh` the topic name is the only secret.** Anyone who guesses it can
  read your run titles, repository names and failure reasons. Use a long random
  topic, or self-host (`https://ntfy.naqerl.com`) where access control is
  enforced server-side.
* **Prefer `NTFY_TOKEN` over `--token`.** argv is visible to every user via
  `/proc/<pid>/cmdline` and lands in shell history and `systemd` unit files.
  The token is sent only as an `Authorization: Bearer` header, never in a URL.
* The bridge writes nothing to disk and holds no credentials of its own; the
  GitHub/zsp credentials stay with `zsp`.
* ntfy replay is capped server-side (10 MB per topic), so a long `--follow`
  session should be treated as a live feed, not an archive.

## License

MIT — see `LICENSE`.
