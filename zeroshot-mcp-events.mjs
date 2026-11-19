#!/usr/bin/env node
/**
 * zeroshot-mcp-events — bridge Zeroshot Platform run events to an ntfy topic.
 *
 * It is not a server and holds no state beyond the current process. It reads
 * run events (from `zsp watch`, from `zsp list` polling, or from stdin) and
 * publishes short human-readable notifications to ntfy. An `ntfy-mcp` server
 * pointed at the same instance/topic then exposes those events to a chat or
 * agent through `ntfy_read` / `ntfy_publish` and the events extension.
 *
 * Zero npm dependencies: node:child_process, node:readline, global fetch.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const VERSION = "0.2.2";

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

const TERMINAL_PHASES = new Set([
  "finished",
  "failed",
  "succeeded",
  "cancelled",
  "canceled",
  "aborted",
  "stopped",
  "timeout",
  "timed_out",
]);

const PHASE_TAGS = {
  running: "arrow_forward",
  succeeded: "white_check_mark",
  success: "white_check_mark",
  finished: "white_check_mark",
  failed: "x",
  failure: "x",
  waiting: "hourglass",
  queued: "hourglass",
  pending: "hourglass",
  cancelled: "no_entry",
  canceled: "no_entry",
  stopped: "no_entry",
};

const PHASE_PRIORITY = {
  failed: 4,
  failure: 4,
  succeeded: 3,
  success: 3,
  finished: 3,
};

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function log(...args) {
  process.stderr.write(`[zs-mcp-events] ${args.join(" ")}\n`);
}

function die(message, code = 2) {
  log(`error: ${message}`);
  log("try --help");
  process.exit(code);
}

function shortRun(runId) {
  if (!runId) return "unknown";
  const s = String(runId);
  return s.length > 8 ? s.slice(0, 8) : s;
}

function oneLine(value, max = 200) {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/* ------------------------------------------------------------------ */
/* argument parsing                                                   */
/* ------------------------------------------------------------------ */

const HELP = `zeroshot-mcp-events ${VERSION} — bridge Zeroshot Platform run events to ntfy

USAGE
  zeroshot-mcp-events --watch <runId>   --topic <topic> [options]
  zeroshot-mcp-events --follow          --topic <topic> [options]
  zeroshot-mcp-events --stdin           --topic <topic> [options]

SOURCE (exactly one)
  --watch <runId>        spawn \`zsp watch --target platform <runId>\` and read its NDJSON
  --follow               poll \`zsp list --target platform\` and watch every live run
  --stdin                read NDJSON events from stdin (fixtures, dry runs, pipes)

DESTINATION
  --ntfy-url <url>       ntfy base URL                  [env NTFY_URL] [default https://ntfy.sh]
  --topic <topic>        ntfy topic, [-_A-Za-z0-9]{1,64}  [env NTFY_TOPIC] [required]
  --token <token>        bearer token for a protected instance [env NTFY_TOKEN]
                         (prefer the env var: argv is world-readable in /proc)

FILTERING
  --kinds <list>         comma list of kinds to publish, default all.
                         Match against kind, phase:<p>, node:<n>, run:<id>; '*' wildcards.
                         Kinds: run-start, phase-change, node-start, node-end,
                         graph-result, heartbeat, terminal, event
  --quiet-phases         drop heartbeats (events where the phase did not change)
  --no-token-only        drop events whose body would carry no detail line
  --raw                  append the raw JSON (truncated) to the message body

BEHAVIOUR
  --poll-secs <n>        --follow polling interval                 [default 30]
  --max-watchers <n>     --follow concurrent watchers              [default 4]
  --zsp <path>           zsp binary                             [env ZSP_BIN] [default zsp]
  --api-url <url>        platform API base           [env ZEROSHOT_API_URL] [default https://api.app.zeroshot.sh]
  --api-key <token>      platform API key; enables the direct API lister
                                                    [env ZEROSHOT_API_KEY] (prefer the env var)
  --target <name>        zsp target                                 [default platform]
  --click-template <u>   Click header; {runId} and {run} are substituted
  --after <cursor>       passed through to \`zsp watch --after\`
  --max-retries <n>      ntfy retry attempts on 429/5xx            [default 8]
  --dry-run              print the ntfy request instead of sending it
  --verbose              log every received and skipped event to stderr
  --version              print version
  --help                 print this help

EXIT STATUS
  0  source exhausted / finished cleanly (a failed run is still a delivered receipt)
  1  bad usage, or the event source could not be started
  2  bad arguments
`;

function parseArgs(argv) {
  const opts = {
    ntfyUrl: process.env.NTFY_URL || "https://ntfy.sh",
    topic: process.env.NTFY_TOPIC || "",
    token: process.env.NTFY_TOKEN || "",
    zsp: process.env.ZSP_BIN || "zsp",
    target: "platform",
    // The platform list endpoint answers with every run in one document. The
    // CLI refuses a hosted list response over 64 KiB, so once an account has
    // enough runs `zsp list` fails permanently with "hosted run list response
    // is too large" and --follow can never start. Reading the same endpoint
    // directly keeps the bridge working; the CLI stays the fallback.
    apiUrl: process.env.ZEROSHOT_API_URL || "https://api.app.zeroshot.sh",
    apiKey: process.env.ZEROSHOT_API_KEY || "",
    kinds: "",
    quietPhases: false,
    noTokenOnly: false,
    raw: false,
    pollSecs: 30,
    maxWatchers: 4,
    clickTemplate: "",
    after: "",
    maxRetries: 8,
    dryRun: false,
    verbose: false,
    watch: null,
    follow: false,
    stdin: false,
  };

  const valueFlags = new Map([
    ["--watch", "watch"],
    ["--ntfy-url", "ntfyUrl"],
    ["--topic", "topic"],
    ["--token", "token"],
    ["--kinds", "kinds"],
    ["--poll-secs", "pollSecs"],
    ["--max-watchers", "maxWatchers"],
    ["--api-url", "apiUrl"],
    ["--api-key", "apiKey"],
    ["--zsp", "zsp"],
    ["--target", "target"],
    ["--click-template", "clickTemplate"],
    ["--after", "after"],
    ["--max-retries", "maxRetries"],
  ]);
  const boolFlags = new Map([
    ["--follow", "follow"],
    ["--stdin", "stdin"],
    ["--quiet-phases", "quietPhases"],
    ["--no-token-only", "noTokenOnly"],
    ["--raw", "raw"],
    ["--dry-run", "dryRun"],
    ["--verbose", "verbose"],
  ]);

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const at = arg.indexOf("=");
      inline = arg.slice(at + 1);
      arg = arg.slice(0, at);
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`zeroshot-mcp-events ${VERSION}\n`);
      process.exit(0);
    }
    if (boolFlags.has(arg)) {
      if (inline !== null) die(`${arg} takes no value`);
      opts[boolFlags.get(arg)] = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const key = valueFlags.get(arg);
      let value = inline;
      if (value === null) {
        if (i + 1 >= argv.length) die(`${arg} needs a value`);
        value = argv[++i];
      }
      if (key === "pollSecs" || key === "maxWatchers" || key === "maxRetries") {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) die(`${arg} needs a non-negative number`);
        opts[key] = n;
      } else {
        opts[key] = value;
      }
      continue;
    }
    die(`unknown argument: ${arg}`);
  }

  const sources = [opts.watch !== null, opts.follow, opts.stdin].filter(Boolean).length;
  if (sources !== 1) die("pick exactly one source: --watch <runId>, --follow or --stdin");
  if (!opts.topic) die("--topic is required (or set NTFY_TOPIC)");
  if (!TOPIC_RE.test(opts.topic)) {
    die(`invalid ntfy topic ${JSON.stringify(opts.topic)} — allowed: [-_A-Za-z0-9]{1,64}`);
  }
  if (!/^https?:\/\//i.test(opts.ntfyUrl)) die(`--ntfy-url must be http(s): ${opts.ntfyUrl}`);
  opts.ntfyUrl = opts.ntfyUrl.replace(/\/+$/, "");
  opts.kindMatchers = opts.kinds
    ? opts.kinds.split(",").map((k) => k.trim()).filter(Boolean).map(globToRegExp)
    : null;
  return opts;
}

/* ------------------------------------------------------------------ */
/* event classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Normalise one NDJSON line into a shape we can classify.
 * Returns null when the line is not a JSON object.
 */
function normalise(raw, fallbackRunId) {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return null;

  const status = ev.status && typeof ev.status === "object" ? ev.status : null;
  const phase = String((status && status.phase) || ev.phase || "").toLowerCase() || "unknown";
  const runId = String(ev.runId || ev.run_id || fallbackRunId || "unknown");
  const cursor = String(ev.cursor ?? ev.seq ?? ev.id ?? "");
  const active = Array.isArray(status?.activeExecutions)
    ? status.activeExecutions
        .map((e) => (typeof e === "string" ? e : e && (e.node || e.name || e.id)))
        .filter(Boolean)
        .map(String)
    : [];
  const terminalResult = status?.terminalResult || ev.terminalResult || null;
  const graphResult = status?.graphResult || ev.graphResult || null;

  return {
    raw: ev,
    runId,
    cursor,
    phase,
    active,
    terminalResult,
    graphResult,
    explicitKind: ev.kind || ev.name || ev.type || null,
    title: ev.title || ev.runTitle || "",
    repository: ev.source?.repository || "",
    message: ev.message || ev.text || ev.detail || "",
  };
}

function isTerminal(ev) {
  if (TERMINAL_PHASES.has(ev.phase)) return true;
  return Boolean(ev.terminalResult && ev.terminalResult.status);
}

/** Derive a kind plus human-readable fields from a normalised event. */
function classify(ev, state) {
  const prev = state.get(ev.runId);
  const activeKey = [...ev.active].sort().join(",");
  const prevActiveKey = prev ? [...prev.active].sort().join(",") : null;

  let kind;
  if (ev.explicitKind && !ev.raw.status) {
    kind = String(ev.explicitKind);
  } else if (isTerminal(ev)) {
    kind = "terminal";
  } else if (!prev) {
    kind = "run-start";
  } else if (prev.phase !== ev.phase) {
    kind = "phase-change";
  } else if (ev.graphResult && !prev.graphResult) {
    kind = "graph-result";
  } else if (prevActiveKey !== null && prevActiveKey !== activeKey) {
    kind = activeKey.length > prevActiveKey.length ? "node-start" : "node-end";
  } else if (activeKey !== prevActiveKey) {
    kind = activeKey ? "node-start" : "node-end";
  } else {
    kind = "heartbeat";
  }

  const started = ev.active.filter((n) => prev && !prev.active.includes(n));
  const stopped = prev ? prev.active.filter((n) => !ev.active.includes(n)) : [];

  state.set(ev.runId, { phase: ev.phase, active: ev.active, graphResult: ev.graphResult });
  return { kind, started, stopped };
}

/** Which labels does this event answer to, for --kinds matching. */
function labels(ev, cls) {
  const out = new Set([cls.kind, `phase:${ev.phase}`, `run:${ev.runId}`]);
  for (const node of ev.active) out.add(`node:${node}`);
  for (const node of cls.started) out.add(`node:${node}`);
  for (const node of cls.stopped) out.add(`node:${node}`);
  return [...out];
}

/** Best-effort phase used for tags/priority when the event is a terminal one. */
function effectivePhase(ev) {
  if (ev.terminalResult?.status) return String(ev.terminalResult.status).toLowerCase();
  if (ev.graphResult?.status) return String(ev.graphResult.status).toLowerCase();
  return ev.phase;
}

function renderMessage(ev, cls, opts) {
  const phase = effectivePhase(ev);
  const node = ev.active.length ? ev.active.join("+") : cls.started.join("+") || cls.stopped.join("+");
  const severity = PHASE_PRIORITY[phase] ? "ok" : "info";

  const headParts = [];
  headParts.push(`${shortRun(ev.runId)}`);
  if (node) headParts.push(node);
  headParts.push(phase);
  if (cls.kind === "heartbeat") headParts.push("(no change)");

  const title = `zeroshot ${headParts.join(" ")}`.slice(0, 120);

  const detail = [];
  if (ev.title) detail.push(oneLine(ev.title, 160));
  if (ev.repository) detail.push(`repo ${ev.repository}`);
  detail.push(`kind ${cls.kind} · phase ${ev.phase}${ev.cursor ? ` · cursor ${ev.cursor}` : ""}`);
  if (cls.started.length) detail.push(`started ${cls.started.join(", ")}`);
  if (cls.stopped.length) detail.push(`stopped ${cls.stopped.join(", ")}`);
  if (ev.terminalResult?.reason) detail.push(`reason ${oneLine(ev.terminalResult.reason, 120)}`);
  else if (ev.graphResult?.reason) detail.push(`graph ${oneLine(ev.graphResult.reason, 120)}`);
  if (ev.message) detail.push(oneLine(ev.message, 400));
  if (opts.raw) detail.push(oneLine(JSON.stringify(ev.raw), 1200));

  const lines = detail.slice(0, 10);
  if (detail.length > lines.length) lines.push(`… ${detail.length - lines.length} more`);

  const tag = PHASE_TAGS[phase] || "memo";
  const priority = PHASE_PRIORITY[phase] || 2;

  let click = "";
  if (opts.clickTemplate) {
    click = opts.clickTemplate
      .replaceAll("{runId}", encodeURIComponent(ev.runId))
      .replaceAll("{run}", encodeURIComponent(shortRun(ev.runId)));
  }

  return {
    title,
    body: lines.join("\n"),
    tags: `${tag},zeroshot`,
    priority,
    click,
    severity,
  };
}

/* ------------------------------------------------------------------ */
/* ntfy publishing                                                    */
/* ------------------------------------------------------------------ */

function buildRequest(opts, message) {
  const headers = {
    Title: message.title,
    Tags: message.tags,
    Priority: String(message.priority),
  };
  if (message.click) headers.Click = message.click;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return { url: `${opts.ntfyUrl}/${opts.topic}`, headers, body: message.body };
}

async function publish(opts, message) {
  const req = buildRequest(opts, message);

  if (opts.dryRun) {
    process.stdout.write(`DRY-RUN POST ${req.url}\n`);
    for (const [k, v] of Object.entries(req.headers)) {
      const shown = k === "Authorization" ? "Bearer ***" : v;
      process.stdout.write(`  ${k}: ${shown}\n`);
    }
    process.stdout.write("  \n");
    for (const line of req.body.split("\n")) process.stdout.write(`  | ${line}\n`);
    return { status: 0, dryRun: true };
  }

  const attempts = Math.max(1, opts.maxRetries);
  let lastError = "no attempt";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const base = Math.min(60_000, 500 * 2 ** (attempt - 1));
      const jitter = Math.floor(base * 0.25 * Math.random());
      await sleep(base + jitter);
    }
    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        if (opts.verbose) log(`ntfy ${res.status} ${message.title}`);
        return { status: res.status };
      }
      const text = await res.text().catch(() => "");
      lastError = `HTTP ${res.status} ${oneLine(text, 160)}`;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        log(`ntfy rejected (${lastError}); not retrying`);
        return { status: res.status, error: lastError };
      }
      log(`ntfy ${res.status}; retry ${attempt + 1}/${attempts - 1}`);
    } catch (err) {
      lastError = err?.message || String(err);
      log(`ntfy request failed (${lastError}); retry ${attempt + 1}/${attempts - 1}`);
    }
  }
  log(`giving up on ${message.title}: ${lastError}`);
  return { status: 0, error: lastError };
}

/* ------------------------------------------------------------------ */
/* the pipeline                                                       */
/* ------------------------------------------------------------------ */

function createPipeline(opts) {
  const state = new Map();
  const seen = new Set();
  let inflight = Promise.resolve();
  let published = 0;
  let skipped = 0;
  let malformed = 0;
  let stopped = false;

  const matchesKinds = (labelsOut) => {
    if (!opts.kindMatchers) return true;
    return labelsOut.some((label) => opts.kindMatchers.some((re) => re.test(label)));
  };

  async function handleLine(line, fallbackRunId) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const ev = normalise(trimmed, fallbackRunId);
    if (!ev) {
      malformed++;
      log(`skipping malformed NDJSON line: ${oneLine(trimmed, 120)}`);
      return;
    }
    if (ev.cursor && seen.has(`${ev.runId}\u0000${ev.cursor}`)) {
      if (opts.verbose) log(`dedupe ${ev.runId} ${ev.cursor}`);
      return;
    }
    if (ev.cursor) seen.add(`${ev.runId}\u0000${ev.cursor}`);

    const cls = classify(ev, state);
    const labelSet = labels(ev, cls);

    if (opts.quietPhases && cls.kind === "heartbeat") {
      skipped++;
      if (opts.verbose) log(`quiet-phases: dropped heartbeat ${ev.runId} ${ev.cursor}`);
      return;
    }
    if (!matchesKinds(labelSet)) {
      skipped++;
      if (opts.verbose) log(`kind filter: dropped ${cls.kind} (${labelSet.join(" ")})`);
      return;
    }

    const message = renderMessage(ev, cls, opts);
    if (opts.noTokenOnly && !message.body.trim()) {
      skipped++;
      if (opts.verbose) log(`no-token-only: dropped ${ev.runId} ${ev.cursor}`);
      return;
    }

    published++;
    inflight = inflight.then(() => publish(opts, message));
    await inflight;
  }

  return {
    handleLine,
    get stats() {
      return { published, skipped, malformed };
    },
    stop() {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    async drain() {
      await inflight;
    },
  };
}

/* ------------------------------------------------------------------ */
/* sources                                                            */
/* ------------------------------------------------------------------ */

function readStreamLines(stream, onLine) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => onLine(line));
    rl.on("close", resolve);
    rl.on("error", (err) => {
      log(`stream error: ${err.message}`);
      resolve();
    });
  });
}

async function runStdin(opts, pipeline) {
  await readStreamLines(process.stdin, (line) => pipeline.handleLine(line, null));
  await pipeline.drain();
}

/** Spawn `zsp watch` and feed its stdout through the pipeline. */
function spawnWatch(opts, pipeline, runId, { onExit } = {}) {
  const args = ["watch", "--target", opts.target];
  if (opts.after) args.push("--after", opts.after);
  args.push(runId);
  if (opts.verbose) log(`spawn ${opts.zsp} ${args.join(" ")}`);

  const child = spawn(opts.zsp, args, { stdio: ["ignore", "pipe", "pipe"] });
  let sawTerminal = false;

  const done = readStreamLines(child.stdout, async (line) => {
    await pipeline.handleLine(line, runId);
  }).then(async () => {
    await pipeline.drain();
    const code = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once("close", (c) => resolve(c));
    });
    if (code !== 0 && code !== null && !sawTerminal) {
      log(`zsp watch ${shortRun(runId)} exited ${code}`);
    }
    if (onExit) onExit(runId, code);
  });

  child.stderr.on("data", (buf) => {
    const text = buf.toString().trim();
    if (text) log(`zsp: ${oneLine(text, 300)}`);
    if (/terminalResult/.test(text)) sawTerminal = true;
  });
  child.on("error", (err) => log(`could not start ${opts.zsp}: ${err.message}`));

  return { child, done };
}

async function runWatch(opts, pipeline) {
  const { done } = spawnWatch(opts, pipeline, opts.watch);
  const onSignal = () => {
    pipeline.stop();
    log("signal received, flushing");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await done;
}

function phaseOfRun(run) {
  return String(run?.status?.phase || "").toLowerCase();
}

async function listRuns(opts) {
  if (opts.apiKey) {
    const url = `${opts.apiUrl.replace(/\/+$/, "")}/native-v2/runs`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`platform list answered ${res.status}`);
    const parsed = await res.json();
    const runs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.runs) ? parsed.runs : [];
    return runs;
  }
  const args = ["list", "--target", opts.target];
  const child = spawn(opts.zsp, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b.toString()));
  child.stderr.on("data", (b) => (stderr += b.toString()));
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`zsp list exited ${code}: ${oneLine(stderr, 200)}`);
  const parsed = JSON.parse(stdout);
  const runs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.runs) ? parsed.runs : [];
  return runs;
}

async function runFollow(opts, pipeline) {
  const watchers = new Map(); // runId -> { child, done }
  const ended = new Set();

  const reap = (runId, code) => {
    const w = watchers.get(runId);
    if (w && w.done) ended.add(runId);
    watchers.delete(runId);
    if (opts.verbose) log(`watcher ${shortRun(runId)} ended (${code})`);
  };

  const tick = async () => {
    let runs;
    try {
      runs = await listRuns(opts);
    } catch (err) {
      log(`list failed: ${err.message}`);
      return;
    }
    for (const run of runs) {
      const runId = String(run.runId || run.id || "");
      if (!runId) continue;
      const phase = phaseOfRun(run);
      if (TERMINAL_PHASES.has(phase)) {
        if (watchers.has(runId)) {
          if (opts.verbose) log(`run ${shortRun(runId)} terminal, stopping watcher`);
          const w = watchers.get(runId);
          watchers.delete(runId);
          w.child.kill("SIGTERM");
        }
        ended.add(runId);
        continue;
      }
      if (watchers.has(runId) || ended.has(runId)) continue;
      if (watchers.size >= opts.maxWatchers) {
        if (opts.verbose) log(`max-watchers reached (${opts.maxWatchers}), deferring ${shortRun(runId)}`);
        continue;
      }
      const spawned = spawnWatch(opts, pipeline, runId, { onExit: reap });
      watchers.set(runId, spawned);
      log(`watching ${shortRun(runId)} (${phase || "unknown"})`);
    }
  };

  let stopping = false;
  const shutdown = () => {
    stopping = true;
    for (const [, w] of watchers) w.child.kill("SIGTERM");
    watchers.clear();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await tick();
  while (!stopping) {
    await sleep(Math.max(1, opts.pollSecs) * 1000);
    if (stopping) break;
    await tick();
  }
  await pipeline.drain();
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pipeline = createPipeline(opts);

  const summary = () => {
    const s = pipeline.stats;
    log(`done: ${s.published} published, ${s.skipped} filtered, ${s.malformed} malformed`);
  };

  process.once("SIGINT", async () => {
    log("SIGINT — flushing");
    await pipeline.drain();
    summary();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    log("SIGTERM — flushing");
    await pipeline.drain();
    summary();
    process.exit(0);
  });

  try {
    if (opts.stdin) await runStdin(opts, pipeline);
    else if (opts.watch !== null) await runWatch(opts, pipeline);
    else await runFollow(opts, pipeline);
  } catch (err) {
    log(`fatal: ${err?.message || err}`);
    process.exit(1);
  }

  await pipeline.drain();
  summary();
  process.exit(0);
}

main();
