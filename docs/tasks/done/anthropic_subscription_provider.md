# Anthropic (Subscription) provider — route Claude through a local dario proxy

## Problem

Ye has one Anthropic provider (`anthropic`) that authenticates with an API key and bills
per token against the raw `api.anthropic.com` Messages API. A Claude Pro/Max subscriber who
wants to use that flat-fee subscription instead of a separate per-token API bill has no
path today: the subscription pool is only reachable through Claude Code's own OAuth client
shape, not a plain `x-api-key`.

[dario](https://github.com/askalf/dario) solves the client half of that. It is a local,
third-party proxy that speaks the **standard Anthropic Messages API wire format** on
`http://localhost:3456`, then re-auths each request with the subscriber's own OAuth token
and rebuilds it into Claude Code's wire shape before forwarding to `api.anthropic.com`.
This matters because it means the new provider is **not a new protocol** — it is the
existing Anthropic adapter and stream parser pointed at a different base URL, with a
placeholder key. Most of the work is configuration, registry, model/pricing tables, and a
consented install + reachability check for the dario daemon itself.

## Design

Two orthogonal pieces:

1. A new first-class provider id `anthropic-subscription` (user-facing label
   "Anthropic (Subscription)") that reuses the existing Anthropic wire code and differs
   only in base URL, key handling, model namespace, context sizes, capabilities, and
   pricing.
2. A dario install/verify subsystem modelled on the existing LSP installer
   (`src/lsp/install/`): on first selection of the provider, offer to install dario with
   explicit y/n consent, verify the install, then probe whether the local proxy is
   reachable.

The trigger is provider selection, not session-start detection. `/provider` already funnels
every switch through `switchProvider` (`src/components/app.tsx:981`) and
`ProviderCommand.applyChoice` (`src/commands/provider.ts:46`), so the hook point is narrow.

Provider switch flow:

```
/provider → "Anthropic (Subscription)"
  → is dario installed? (dario --version exits 0)
      no  → consent picker: "Install dario?" (shows exact command)
              install → npm install -g @askalf/dario → verify dario --version
              not now → abort switch, tell user to run it later
      yes → continue
  → build anthropic-subscription provider (no key prompt; placeholder key)
  → reachability probe: GET <baseUrl>/health
       200 → switch, note "dario proxy reachable"
       503 → switch, note "proxy running but not logged in — run `dario login`"
      else → switch, note "dario installed — start it with `dario proxy`"
```

Reachability is **advisory, never a blocker**, matching Ollama's "is ollama running?"
pattern (`src/providers/ollama/index.ts:53`). A selected-but-not-running proxy simply
errors on the first request with a network error; the switch itself must not hard-fail
because the daemon isn't up yet. The user still has to run `dario login` once (their
subscription OAuth) and `dario proxy` in a separate terminal — dario is a daemon and Ye
must never start or own a long-running process itself.

## Why reuse, not duplicate

`dario` maps `/v1/messages` → `api.anthropic.com/v1/messages` (`~/dario/src/proxy.ts:586`)
and its client-facing surface is byte-compatible with what `src/providers/anthropic/adapt.ts`
already emits. So `buildRequestBody`, `parseStream`, and `parseBatch` are shared verbatim.
The only change to the existing Anthropic module is parametrizing `createAnthropicProvider`
so the subscription variant can supply a different id, context-size table, and capability
set without forking the stream/adapter code.

## Step 1 — parametrize the existing Anthropic provider

### `src/providers/anthropic/index.ts`

Change `createAnthropicProvider(deps)` to accept an optional shape argument with defaults
that preserve current behavior exactly:

```
interface AnthropicProviderShape {
    readonly id: string;
    readonly contextSizes: Readonly<Record<string, number>>;
    readonly capabilities: ProviderCapabilities;
}
```

Defaults: `id: "anthropic"`, `contextSizes: ANTHROPIC_CONTEXT_SIZES`, and the current
capability set (`promptCache: true`, `toolUse: true`, `vision: true`,
`serverSideWebSearch: true`). `getContextSize` reads from the passed table instead of the
module-level constant. `buildAnthropicFromConfig` keeps its current signature and passes
the defaults; no behavioral change to the existing provider.

Extract the capability constant into a named value so the default and the subscription
override read from the same shape rather than being hand-duplicated.

## Step 2 — new provider module

### `src/providers/anthropic-subscription/index.ts` (new)

Thin builder, mirrors `buildAnthropicFromConfig` but keyless like Ollama
(`src/providers/ollama/index.ts:105`):

```
DEFAULT_BASE_URL = "http://localhost:3456"
DEFAULT_PLACEHOLDER_KEY = "dario"

buildAnthropicSubscriptionFromConfig(config):
    provCfg = config.providers["anthropic-subscription"]
    if (!provCfg) throw new Error(...)
    key = resolveApiKey(provCfg) ?? DEFAULT_PLACEHOLDER_KEY
    return createAnthropicProvider({
        apiKey: key,
        baseUrl: provCfg.baseUrl,
        id: "anthropic-subscription",
        contextSizes: SUBSCRIPTION_CONTEXT_SIZES,
        capabilities: {
            promptCache: true,   // dario forwards cache_control + sticky cache locality
            toolUse: true,
            vision: true,
            serverSideWebSearch: false, // no web_search_20250305 on the OAuth path
        },
    })
```

No `Missing*KeyError`. The placeholder is deliberate: dario ignores the client key unless
`DARIO_API_KEY` is set, but its documented pattern is to supply one to satisfy SDK
validation, and dario's own examples use `dario` (`~/dario/README.md:56`).

### `src/providers/anthropic-subscription/models.ts` (new)

dario's model namespace differs from the raw API. Advertised bases
(`~/dario/src/model-catalog.ts:41`): `claude-fable-5`, `claude-opus-5`,
`claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`,
`claude-sonnet-4-6`, `claude-haiku-4-5`, plus generated `[1m]` variants for every family
except haiku.

Context sizes must be confirmed live before hardcoding (see Verification). Working
assumption from dario's README + source: the subscription OAuth path dropped
`context-1m` from the default beta set, so base opus/sonnet default to 200K, `[1m]`
variants are 1M, haiku 200K, fable unknown. Encode exactly what the live `/v1/models`
+ `/health?probe=1` check reports; unknown models fall back to `FALLBACK_CONTEXT_WINDOW`.

## Step 3 — registry, defaults, models, pricing

### `src/config/defaults.ts`

Add a provider block so a fresh config validates and `/provider` lists it:

```
"anthropic-subscription": {
    baseUrl: "http://localhost:3456",
    apiKeyEnv: "ANTHROPIC_SUBSCRIPTION_API_KEY",
},
```

The env var must **not** collide with `ANTHROPIC_API_KEY` — that belongs to the plain
per-token provider and must keep working independently.

### `src/providers/index.ts`

Add `buildAnthropicSubscriptionFromConfig` to the `builders` map and
`"anthropic-subscription"` to `PROVIDER_IDS`. No change to `isMissingKeyError` — the
subscription provider never throws a missing-key error, so it is out of scope there
(same as Ollama).

### `src/providers/models.ts`

Add `provider: "anthropic-subscription"` entries for the models in
`SUBSCRIPTION_CONTEXT_SIZES`, labels matching dario's family names (e.g. "Opus 5
(Subscription)", "Sonnet 5 (Subscription)", "Haiku 4.5 (Subscription)"). This is the
single source of truth for `/model`; `defaultModelFor` picks the first entry, which gives
the switch a sane default model.

### `src/providers/pricing.ts`

`lookupPricing` already returns `undefined` for any provider id it does not name
(`src/providers/pricing.ts:63`), and callers skip `null` cost rather than guessing. So
`anthropic-subscription` is automatically excluded from per-token dollar totals. Confirm
`/cost` and `/usage` render a clean "no cost" rather than `$0.00` for such models; if they
don't, the minimal fix is in those renderers, not the pricing table. Do **not** add
subscription models to `ANTHROPIC_PRICING` — that would invent per-token dollars for a
flat-fee plan and corrupt lifetime totals.

## Step 4 — provider command surface

### `src/commands/provider.ts`

Add to `PROVIDER_LABELS`:

```
"anthropic-subscription": {
    label: "Anthropic (Subscription)",
    description: "Claude via a local dario proxy at http://localhost:3456. Uses your Claude Pro/Max subscription.",
},
```

Update the `usage` string to include `anthropic-subscription`. The picker and the
explicit-arg path both read `PROVIDER_IDS`, so adding the id there is sufficient; the
label map is the only provider-specific text.

## Step 5 — dario install + verify subsystem

New `src/dario/` tree, mirroring `src/lsp/install/` but smaller (one package, one probe,
no toolchain variants). KISS: no `InstallPlan` union — dario installs one way, via the
package manager, so the catalogue is a single entry rather than an array.

### `src/dario/install.ts` (new)

Exports:

```
installDario(opts): Promise<InstallResult>
    command: "npm install -g @askalf/dario"   (or bun equivalent)
    verify:  run "<binary> --version", assert exit 0
probeDario(baseUrl, opts): Promise<ProbeResult>
    GET <baseUrl>/health with short timeout (800ms, matching dario's own doctor probe)
    200 → { ok: true, status: "running" }
    503 → { ok: true, status: "unauthenticated" }   // proxy up, not logged in
    refused/timeout → { ok: false, status: "unreachable" }
isDarioInstalled(which): boolean
    which("dario") !== null, or a Ye-owned path check
```

`dario --version` prints the bare package version and exits 0 (`~/dario/src/cli.ts:1919`),
so it is the correct post-install probe — same contract as the LSP installer's `probeArgs`
("exits 0 → installed"; "exit 0 but no runnable binary → failure"). `npm` is the
prerequisite; treat `bun` as an acceptable fallback the way `catalogue.ts` does for node
servers, but the install command itself stays `npm install -g` because dario publishes to
npm and the README's documented path is `npm i -g @askalf/dario`.

**Ownership note:** this installs into the user's global npm, not `~/.ye`, because dario is
a CLI the user must run as a bare `dario proxy` / `dario login` in their own terminal — a
`~/.ye`-private install would not be on PATH for that. Flag this in the consent text so the
user knows the difference from the LSP installs (which are removable via `rm -rf ~/.ye/lsp`).

### `src/dario/state.ts` (new, optional but recommended)

A tiny decline cache under `~/.ye` so a declined install is not re-offered every session.
Mirror `src/lsp/install/state.ts`: read/write a JSON file, corrupt/missing reads as
"not declined", `recordDecline` / `isDeclined` / `clearDecline`. If we skip this, the offer
fires on every first-selection-until-installed, which is acceptable but noisier. Recommend
including it; the offer is per-provider-selection, so it only matters across restarts.

## Step 6 — wire the consent flow into provider switching

### `src/components/app.tsx`

In `switchProvider` (`src/components/app.tsx:981`), before `tryBuildProvider`, add:

```
if (nextId === "anthropic-subscription") {
    if (!isDarioInstalled(which)) {
        const choice = await pick({
            title: "Install dario to use Anthropic (Subscription)?",
            options: [
                { id: "install", label: "Install now", description: "npm install -g @askalf/dario" },
                { id: "later", label: "Not now", description: "switch aborted" },
            ],
            initialId: "later",
        });
        if (choice !== "install") throw new Error("dario not installed; switch cancelled");
        const result = await runDarioInstall({ addSystemMessage, streamOutput });
        if (!result.ok) throw new Error(result.error);
    }
}
```

Then build the provider as today. After a successful build, run `probeDario` and append a
system message describing the outcome (running / unauthenticated / unreachable-with-hint).
Reuse the existing `pick` / `addSystemMessage` / `streamOutput` surfaces already wired for
LSP (`src/components/app.tsx:1105`). Do **not** reuse the `lspOffer` banner state — that
is session-start and Ctrl+L; this is in-band provider switching and must complete inline
so the switch happens in the same turn.

`switchProvider` currently hardcodes the missing-key error message
("API key required for …") for cancellation. The subscription path bypasses that message
with its own dario error, so keep the two branches distinct and do not let a missing dario
fall through to a "key required" message.

## Risks / decisions to surface honestly

dario is unofficial and third-party, and its own README is explicit that using a
subscription across non-Claude-Code tools sits outside what Anthropic's own client does,
with account-action risk only Anthropic can rule on. The consent picker text must say this
plainly — not a scary wall, one sentence — so the user consents to what they are actually
installing and doing. This is the same honesty bar the codebase applies to toolchain-scope
installs (rust-analyzer) and to anything that mutates state Ye does not own.

Open decisions to confirm before/while implementing:
- Provider id — `anthropic-subscription` recommended; alternatives `dario`, `claude-subscription`.
- Exact subscription context sizes — must be read from a live dario `/v1/models` and
  `/health?probe=1`, not from memory; the plan hardcodes nothing until then.
- Cost display — confirm `/cost` / `/usage` render "no cost" cleanly for null-cost models,
  or decide whether an explicit "subscription" tag is wanted.

## Tests

All new tests are Bun `*.test.ts` beside the code they cover. The existing
`adapt.test.ts` and Anthropic stream tests already lock the wire format; the subscription
provider reuses them, so new tests target only the six differences and the install flow.

### Unit — provider construction and tables

- `createAnthropicProvider` with defaults still yields id `anthropic`, current
  capabilities, `ANTHROPIC_CONTEXT_SIZES`, and `api.anthropic.com` default base URL —
  proves the parametrization did not change the existing provider.
- `createAnthropicProvider` with the subscription shape yields id `anthropic-subscription`,
  `serverSideWebSearch: false`, the passed context table, and the passed base URL.
- `buildAnthropicSubscriptionFromConfig` with no key present does **not** throw and uses
  the `dario` placeholder; with `ANTHROPIC_SUBSCRIPTION_API_KEY` set it uses the env value;
  with `providers["anthropic-subscription"].baseUrl` set it overrides the default.
- Subscription context-size table: known ids → expected sizes; unknown id →
  `FALLBACK_CONTEXT_WINDOW`.
- `lookupPricing("anthropic-subscription", "claude-opus-5")` → `undefined`;
  `computeCostUsd` for the same → `undefined`.

### Unit — config and registry

- `validateConfig` accepts a config whose `providers` map contains
  `anthropic-subscription` and round-trips its `baseUrl` / `apiKeyEnv` / `apiKey`.
- `DEFAULT_CONFIG.providers` contains `anthropic-subscription` with base URL
  `http://localhost:3456` and the distinct env var.
- `PROVIDER_IDS` includes `anthropic-subscription`.
- `listModels("anthropic-subscription")` returns the expected entries; `defaultModelFor`
  returns the first.
- `/provider` `buildOptions` includes the new id with label "Anthropic (Subscription)";
  the usage string names it.

### Unit — dario install subsystem (mirror `src/lsp/install/install.test.ts`)

Inject a fake `run` (Runner) and `which`, no real npm invocation:
- install command renders `npm install -g @askalf/dario`.
- prerequisite: npm or bun on PATH passes; neither → error.
- success path: install exits 0 and the `dario --version` probe exits 0 → `ok`.
- install exits 0 but the version probe fails (binary missing or non-zero) → failure, the
  exact "exit 0 but no runnable binary" case the LSP installer already guards.
- install non-zero exit → failure with the exit code; timeout → failure.

### Unit — reachability probe

Inject a fake `fetch`:
- `GET /health` → 200 → `{ ok: true, status: "running" }`.
- 503 → `{ ok: true, status: "unauthenticated" }`.
- connection refused / abort → `{ ok: false, status: "unreachable" }`.

### Integration — the one that proves it talks to dario

Spin up a local HTTP server (Bun `Bun.serve`) that mimics dario's `/v1/messages` surface.
Assert the subscription provider:
- POSTs to `/v1/messages` on the configured base URL.
- sends `x-api-key: dario` and `anthropic-version: 2023-06-01`.
- sends a JSON body with `model`, `messages`, and `stream: true`.
Then feed a streamed SSE fixture (message_start → text delta → tool_use start/input →
message_delta → message_stop, with usage) and assert the parsed `ProviderEvent` sequence:
`tool_call.starting`, `text.delta`, `tool_call`, `usage`, `stop(tool_use)`. This is the test
that would catch any wrong assumption about dario's surface being non-standard — and it
passes against a fake because dario is, by design, a drop-in for the standard API.

## Verification

- `bun run check` clean (typecheck + format + full test suite). Note the known hazard:
  several suites `mock.module` process-globally; a test failing only in the full run is a
  mock-collision, not a real regression.
- Manual, against a real dario install: `npm i -g @askalf/dario`, `dario login`,
  `dario proxy`, then in Ye `/provider` → "Anthropic (Subscription)" and confirm the
  picker offers install only when `dario` is missing; with it installed, confirm the switch
  succeeds, the reachability note appears, and a real turn streams text + tool calls
  through the proxy.
- Confirm `anthropic` (per-token) is untouched: switch back and forth, verify
  `ANTHROPIC_API_KEY` is never read by the subscription provider and vice versa.
- Confirm `/cost` and `/usage` do not show fabricated per-token dollars for subscription
  turns.
