# Flightplan fixture server

A self-contained, **zero-dependency** Bun HTTP server that serves 9 deterministic HTML
fixture pages. Each page is purpose-built to exercise one resolution scenario in Flightplan's
ladder, so the validation campaign (see [`../../docs/plans/P6_RESULTS.md`](../../docs/plans/P6_RESULTS.md))
can measure lock stability
reproducibly.

This document is the **contract** the flow-authoring agents rely on: route → target tier →
canonical happy-path interaction → expected final assertable state.

## Run

```bash
bun run examples/fixtures/server.ts          # listens on http://localhost:3000
PORT=4000 bun run examples/fixtures/server.ts  # override the port
```

The server logs its listening URL on start. `GET /healthz` returns `200 ok` for liveness.
There is **no server-side state** — every page is a pure function of its route + query
string, and all interactive state lives client-side. The server is fully reentrant and the
markup is byte-identical across requests, so page signatures are stable run-to-run.

It is independent of `src/` and uses only `Bun.serve` (no packages, no network calls).

## The ladder (for reference)

| Tier | What | Cost |
|------|------|------|
| L0 | Locked-recipe replay, gated on `url_glob` + page signature | free |
| L1 | Deterministic strategy race: `testid → role/name → label/placeholder → scoped text (interactive-only) → scoped a11y/structural` | free |
| L2 | Resolver **text** model — fuzzy disambiguation by surrounding context | ~$0.000005 |
| L3 | **Vision** model — last resort (unlabeled icons) | ~$0.0006 |
| L4 | Advisor classifier — `heal \| bug \| flake \| intent_changed` | ~$0.001–0.01 |

## Route table

| # | Fixture | Route | Target tier(s) | Proves |
|---|---------|-------|----------------|--------|
| 01 | wizard | `/wizard` | L0 / L1 | deterministic resolve + assertion polling |
| 02 | async | `/async` | L1 + polling | navigation settling / implicit waits |
| 03 | rerender | `/rerender` | L1 (+ stale-ref re-resolve) | refs ephemeral; own re-resolution |
| 04 | overlays | `/overlays` | L1 + auto-repair (covered) | `coveringElement` dismiss-then-retry |
| 05 | contexts | `/contexts` | L1 | same-origin frame switching + open shadow-DOM traversal |
| 06 | gauntlet | `/gauntlet` | **L2** | model disambiguation of identical controls |
| 07 | drift | `/drift?variant=a\|b\|c` | a:L0/L1 · b:**L1 heal** · c:**L2** | staleness → L1 heal; hard drift → model |
| 08 | signature | `/signature?variant=same\|changed` | **L0 sig-mismatch → L1** | `match.sig` gate forces re-resolve |
| 09 | vision | `/vision/icons` | **L3** | vision-only resolution of unlabeled icons |

> Note on variant params: the task spec (and this server) use `?variant=…` for both drift
> and signature. Earlier design sketches used `/drift/order` and `/signature/page ?layout=grid|list`
> as illustrative routes — the **canonical, implemented** routes are the ones in this table.

## Per-fixture contract

Every assertable action lands an observable, deterministic result. Unless noted, success
renders an element `data-testid="result"` with the exact text below — so `text` / `visible`
assertions are reliable. Step-by-step targets use stable `data-testid`s, with role+name and
label/placeholder also available for L1 strategy coverage.

### 01 · `/wizard` — L0/L1

Multi-step form wizard. Clean targets at every tier.

| Step | Action | Target | Effect |
|------|--------|--------|--------|
| 1 | fill | `data-testid="wizard-name"` (label "Full name", placeholder "Jane Doe") | stores name |
| 2 | click | `data-testid="wizard-next-1"` ("Next") | reveals step 2 |
| 3 | select | `data-testid="wizard-plan"` ("Plan") → e.g. `pro` | stores plan |
| 4 | click | `data-testid="wizard-next-2"` ("Next") | reveals step 3 |
| 5 | click | `data-testid="wizard-submit"` ("Submit") | renders result |

Back navigation: `wizard-back-2`, `wizard-back-3`. Only one `wizard-step-*` section is
visible at a time (others carry `[hidden]`).

**Expected end-state:** `result` visible, text = `Welcome, <name>! Plan: <plan>.`
(echoes the filled value — e.g. `Welcome, Jane Doe! Plan: pro.`). Useful asserts:
`value` on `wizard-name`, `text` on `result`, `count`/`visible` on the step sections.

### 02 · `/async` — L1 + polling

Elements appear after **fixed** delays (700ms after load, 900ms after click). Forces the
assertion engine to poll.

| Step | Action | Target | Effect |
|------|--------|--------|--------|
| (auto) | — | `data-testid="async-banner"` | appears **700ms** after load |
| 1 | click | `data-testid="async-load"` ("Load data") | disables briefly, then after **900ms**… |
| 2 | poll | `data-testid="result"` | …renders |

**Expected end-state:** `async-banner` visible, text `Loaded asynchronously`; `result`
visible, text `Async action complete`.

### 03 · `/rerender` — L1 (+ stale-ref re-resolve)

The widget subtree is **fully replaced** (not mutated) 600ms after the trigger, invalidating
any cached `ref:eN`. The action button exists **only** in the re-rendered tree.

| Step | Action | Target | Effect |
|------|--------|--------|--------|
| 1 | click | `data-testid="rerender-trigger"` ("Refresh widget") | after **600ms** replaces `#widget-host` subtree |
| 2 | click | `data-testid="rerender-action"` ("Confirm") | exists only post-rerender → forces fresh snapshot + re-resolve |

**Expected end-state:** `result` visible, text `Re-rendered action confirmed`;
`rerender-generation` text `generation: 2` (proves the replacement happened — it was
`generation: 1` before).

### 04 · `/overlays` — L1 + auto-repair (covered)

The real CTA is physically covered by a full-viewport cookie/consent overlay on load.
browser-pilot reports `failureReason="covered"` + `coveringElement`; Flightplan's auto-repair
dismisses the overlay then retries — no model needed.

| Step | Action | Target | Effect |
|------|--------|--------|--------|
| 1 | click | `data-testid="cookie-accept"` ("Accept cookies") | removes `data-testid="cookie-overlay"` |
| 2 | click | `data-testid="overlays-cta"` ("Place order") | renders result |

**Expected end-state:** `cookie-overlay` hidden/removed (use `hidden` assert); `result`
visible, text `Order placed`.

### 05 · `/contexts` — L1 (iframe + shadow DOM)

Targets nested in (a) an `<iframe>` (srcdoc) and (b) an **open** shadow root. A **closed**
shadow root is also present and intentionally **unreachable** (documents the boundary — not
part of the happy path).

| Step | Action | Target | Context | Effect |
|------|--------|--------|---------|--------|
| 1 | click | `data-testid="iframe-btn"` ("Confirm in frame") | inside `data-testid="context-frame"` iframe | iframe shows its own result |
| 2 | click | `data-testid="shadow-open-btn"` ("Confirm in shadow") | inside `<open-widget>` open shadow root | host page surfaces a result |

Unreachable (negative documentation): `data-testid="shadow-closed-btn"` inside
`<closed-widget>` (closed shadow root).

**Expected end-state:** inside the iframe, `data-testid="iframe-result"` text
`Frame confirmed`; on the host page, `data-testid="result"` visible, text `Shadow confirmed`.

### 06 · `/gauntlet` — L2 (ambiguity)

Three visually/semantically **identical** "Save" buttons (shared `class="save-btn"`, no
unique testid, identical accessible name "Save"). Deterministic L1 is ambiguous; only a text
resolver can pick by surrounding context. Each button writes a **different** result so a
mis-resolve is caught.

| Panel | Button | Result text |
|-------|--------|-------------|
| "Search filters" | Save | `Saved search filters` |
| **"Billing address"** (the target) | Save | `Saved billing address` |
| "Draft message" | Save | `Saved draft message` |

**Canonical interaction:** resolve+click the "Save" inside the **"Billing address"** panel
(target intent e.g. "save the billing address").

**Expected end-state:** `result` visible, text `Saved billing address`. Any other text means
the wrong button resolved.

### 07 · `/drift?variant=a|b|c` — a:L0/L1 · b:L1 heal · c:L2

Same logical "create order" CTA; the selector drifts per variant. The canonical recipe is
authored against **variant a** (`data-testid="create-order"`).

| Variant | Markup change | Resolves at |
|---------|---------------|-------------|
| `a` (default) | `data-testid="create-order"`, text "Create order" | L0 cache / L1 testid — no heal |
| `b` | testid renamed → `create-order-v2`; role+name "Create order" **unchanged** | **L1 heals** to role_name (still deterministic) |
| `c` | testid removed; text → synonym "Submit order"; decoys "Cancel order"/"Save order" present | **L2** maps intent → "Submit order" |

**Canonical interaction (all variants):** resolve+click the primary create-order CTA.

**Expected end-state (all variants):** `result` visible, text `Order created`. The assertion
is variant-independent — only the resolving **tier** (and whether a heal is reported) differs.
The decoys in variant c (`noop()`) write nothing, so a wrong pick fails the `result` assert.

### 08 · `/signature?variant=same|changed` — L0 sig-mismatch → L1

Exercises the lock's page-signature gate (text-hash + structural skeleton). The **target is
identical and cleanly resolvable in both variants**; only the surrounding content/structure
changes so a signature recorded against `same` no longer matches `changed`.

| Variant | Page | Signature |
|---------|------|-----------|
| `same` (default) | single-column heading + paragraph + target | **record the baseline sig here** |
| `changed` | different copy **and** a 2-column grid with extra sections/table | text-hash **and** structural hash both differ → mismatch |

| Step | Action | Target | Effect |
|------|--------|--------|--------|
| 1 | click | `data-testid="signature-action"` ("Continue") | renders result (unchanged across variants) |

**Expected end-state (both variants):** `result` visible, text `Continued`. For
`variant=changed`, the run should report an L0 **sig mismatch → L1 re-resolution** while the
assertion still passes.

### 09 · `/vision/icons` — L3 (vision only)

A toolbar of three **unlabeled** icon-only buttons (inline SVG glyphs, `aria-hidden`). Each
button has **no visible text, no aria-label, no title, no data-testid**, and an empty
accessible name with generic role "button" — so L0/L1/L2 cannot tell them apart. Only a vision
model reading the rendered glyph can.

Each button carries a **non-semantic** `data-action="trash|edit|share"` used only by the click
handler to write a known result. This attribute is **not** surfaced as an accessible name, so
it gives no signal to L0/L1/L2 — it exists purely so the fixture can prove which icon a vision
pick actually clicked.

| Button (glyph) | data-action | Result text |
|----------------|-------------|-------------|
| trash can | `trash` | `Clicked: trash` |
| pencil | `edit` | `Clicked: edit` |
| share nodes | `share` | `Clicked: share` |

**Canonical interaction (e.g. "delete the item"):** vision resolve+click the **trash** icon.

**Expected end-state:** `result` visible, text `Clicked: trash` (or `edit` / `share`).

## Determinism guarantees

- **No randomness** anywhere in markup or content.
- **Fixed delays only:** async-on-load `700ms`, async-on-click `900ms`, rerender `600ms`.
- **No server-side state:** variant selection is a pure function of the query string; all
  interactive transitions are client-side. Reloading resets to the initial state.
- **No external network calls** and **no third-party assets** (SVGs are inline) — the pages
  render identically offline, keeping signatures and locks stable.
