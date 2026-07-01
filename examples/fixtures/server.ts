/**
 * Flightplan fixture server
 * =========================
 *
 * A self-contained, ZERO-dependency Bun HTTP server (uses only `Bun.serve`) that
 * serves 9 deterministic HTML fixture pages. Each page is purpose-built to exercise
 * one rung of Flightplan's resolution ladder:
 *
 *   L0  Locked-recipe replay (url_glob + page signature)
 *   L1  Deterministic strategy race (testid -> role/name -> label/placeholder ->
 *       scoped text(interactive-only) -> scoped a11y/structural)
 *   L2  Resolver text model (fuzzy disambiguation by surrounding context)
 *   L3  Vision model (last resort; unlabeled icons)
 *   L4  Advisor classifier (heal | bug | flake | intent_changed)
 *
 * The escalation matrix this server targets (PLAN.md §6):
 *
 *   | Fixture        | Route          | Target tier(s)              |
 *   |----------------|----------------|-----------------------------|
 *   | 01-wizard      | /wizard        | L0/L1                       |
 *   | 02-async       | /async         | L1 + polling                |
 *   | 03-rerender    | /rerender      | L1 (+ stale-ref re-resolve) |
 *   | 04-overlays    | /overlays      | L1 + auto-repair (covered)  |
 *   | 05-contexts    | /contexts      | L1 (iframe + shadow DOM)    |
 *   | 06-gauntlet    | /gauntlet      | L2 (ambiguity)              |
 *   | 07-drift       | /drift         | a:L0/L1 · b:L1 heal · c:L2  |
 *   | 08-signature   | /signature     | L0 sig-mismatch -> L1       |
 *   | 09-vision      | /vision/icons  | L3 (vision only)            |
 *
 * DETERMINISM CONTRACT
 * --------------------
 * - No randomness anywhere. All timing delays are FIXED constants (see DELAYS).
 * - Page content/structure is identical across requests for a given route+query, so
 *   page signatures (text-hash + structural skeleton) are stable run-to-run.
 * - Every assertable action produces a known, observable post-action state — usually
 *   a `[data-testid="result"]` element containing fixed, documented text. This lets
 *   deterministic assertions (visible/hidden/text/url/value/count) pass reliably.
 * - All page-state transitions happen client-side (no server-side session state), so
 *   the server is fully reentrant and reproducible. There is one tiny exception: the
 *   drift/signature *variant* is selected purely from the query string, so it too is
 *   a pure function of the request.
 *
 * Run:  bun run examples/fixtures/server.ts          (PORT env overrides, default 3000)
 *
 * The per-fixture happy-path interactions and expected end-states are documented
 * both in the comment blocks beside each fixture below AND in examples/fixtures/README.md
 * (the canonical contract for flow-authoring agents).
 */

const DEFAULT_PORT = 3000;

/**
 * Fixed timing constants for async fixtures. Deterministic by construction — every
 * run waits exactly these many ms. Kept inside the 500–1500ms window the plan calls for.
 */
const DELAYS = {
  asyncOnLoad: 700, // 02-async: content that renders this long after load
  asyncOnClick: 900, // 02-async: content that renders this long after a click
  rerender: 600, // 03-rerender: node replacement happens this long after click
} as const;

// ---------------------------------------------------------------------------
// Shared markup helpers (kept tiny + dependency-free)
// ---------------------------------------------------------------------------

/** Common <head> styles. Intentionally minimal + stable (no dynamic content). */
const HEAD_STYLE = `
  <style>
    :root { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 32px; max-width: 880px; color: #1a1a1a; line-height: 1.5; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .sub { color: #666; margin: 0 0 24px; font-size: 14px; }
    button { font: inherit; padding: 8px 16px; border: 1px solid #999; border-radius: 6px;
             background: #f5f5f5; cursor: pointer; margin: 4px 4px 4px 0; }
    button:hover { background: #ebebeb; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    input, select { font: inherit; padding: 6px 10px; border: 1px solid #bbb; border-radius: 6px; }
    label { display: block; margin: 12px 0 4px; font-weight: 600; }
    .result { margin-top: 20px; padding: 12px 16px; border-radius: 6px; background: #e8f5e9;
              border: 1px solid #66bb6a; color: #1b5e20; font-weight: 600; }
    .panel { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 12px 0; }
    .muted { color: #888; }
    code { background: #f0f0f0; padding: 1px 5px; border-radius: 4px; }
    nav a { display: block; margin: 6px 0; }
  </style>`;

/** Wraps page body in a full HTML document with a stable title. */
function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  ${HEAD_STYLE}
</head>
<body>
${body}
</body>
</html>`;
}

function html(content: string): Response {
  return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ===========================================================================
// FIXTURE 01 — /wizard  (target tier: L0 / L1)
// ===========================================================================
// A 3-step form wizard with clean, deterministic targets at every tier:
//   - data-testid on every control (L0/L1 testid strategy)
//   - role + accessible name (button text / aria) for the role_name strategy
//   - <label for> associations + placeholders for the label strategy
//
// Happy path:
//   1. fill #fullname (data-testid="wizard-name") with a value
//   2. click "Next" (data-testid="wizard-next-1")          -> reveals step 2
//   3. select an option in data-testid="wizard-plan"
//   4. click "Next" (data-testid="wizard-next-2")          -> reveals step 3
//   5. click "Submit" (data-testid="wizard-submit")        -> reveals result
//   (Back buttons data-testid="wizard-back-2"/"wizard-back-3" navigate backwards.)
//
// Expected assertable end-state:
//   - data-testid="result" becomes visible with text:
//       "Welcome, <name>! Plan: <plan>."   (echoes the filled value -> value/text asserts)
//   - Each step container toggles [hidden]; only one step visible at a time (count/visible asserts).
// ---------------------------------------------------------------------------
function wizardPage(): string {
  return page(
    "Wizard — Flightplan fixture 01",
    `
  <h1>01 · Multi-step Wizard</h1>
  <p class="sub">Clean testid / role+name / label targets. Target tier: L0/L1.</p>

  <form id="wizard" onsubmit="return false">
    <section id="step1" data-testid="wizard-step-1" data-step="1">
      <h2>Step 1 — Your name</h2>
      <label for="fullname">Full name</label>
      <input id="fullname" data-testid="wizard-name" name="fullname"
             placeholder="Jane Doe" aria-label="Full name" />
      <div>
        <button type="button" data-testid="wizard-next-1" onclick="goto(2)">Next</button>
      </div>
    </section>

    <section id="step2" data-testid="wizard-step-2" data-step="2" hidden>
      <h2>Step 2 — Choose a plan</h2>
      <label for="plan">Plan</label>
      <select id="plan" data-testid="wizard-plan" name="plan" aria-label="Plan">
        <option value="free">Free</option>
        <option value="pro">Pro</option>
        <option value="enterprise">Enterprise</option>
      </select>
      <div>
        <button type="button" data-testid="wizard-back-2" onclick="goto(1)">Back</button>
        <button type="button" data-testid="wizard-next-2" onclick="goto(3)">Next</button>
      </div>
    </section>

    <section id="step3" data-testid="wizard-step-3" data-step="3" hidden>
      <h2>Step 3 — Confirm</h2>
      <p class="muted">Review and submit your details.</p>
      <div>
        <button type="button" data-testid="wizard-back-3" onclick="goto(2)">Back</button>
        <button type="submit" data-testid="wizard-submit" onclick="submitWizard()">Submit</button>
      </div>
    </section>
  </form>

  <script>
    function goto(step) {
      for (const n of [1, 2, 3]) {
        document.getElementById('step' + n).hidden = (n !== step);
      }
    }
    function submitWizard() {
      const name = document.getElementById('fullname').value || 'friend';
      const plan = document.getElementById('plan').value;
      let r = document.getElementById('result');
      if (!r) {
        r = document.createElement('div');
        r.id = 'result';
        r.className = 'result';
        r.setAttribute('data-testid', 'result');
        document.body.appendChild(r);
      }
      r.textContent = 'Welcome, ' + name + '! Plan: ' + plan + '.';
    }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 02 — /async  (target tier: L1 + polling/wait)
// ===========================================================================
// Elements that appear after FIXED delays. Exercises navigation settling and
// assertion polling (the deterministic assertion must poll until the element exists).
//
//   - A "delayed banner" (data-testid="async-banner") renders 700ms AFTER load.
//   - A button (data-testid="async-load") that, when clicked, renders a result
//     900ms LATER (data-testid="result").
//
// Happy path:
//   1. (optionally assert async-banner becomes visible — requires polling ~700ms)
//   2. click data-testid="async-load"
//   3. poll until data-testid="result" is visible
//
// Expected assertable end-state:
//   - data-testid="async-banner" visible, text "Loaded asynchronously"
//   - data-testid="result" visible, text "Async action complete"
// ---------------------------------------------------------------------------
function asyncPage(): string {
  return page(
    "Async — Flightplan fixture 02",
    `
  <h1>02 · Async / late elements</h1>
  <p class="sub">Elements render after fixed ${DELAYS.asyncOnLoad}ms / ${DELAYS.asyncOnClick}ms delays. Target tier: L1 + polling.</p>

  <div id="banner-slot"></div>

  <button type="button" data-testid="async-load" onclick="loadAsync()">Load data</button>

  <script>
    // Banner appears a fixed delay after load (deterministic).
    setTimeout(function () {
      const b = document.createElement('div');
      b.className = 'panel';
      b.setAttribute('data-testid', 'async-banner');
      b.textContent = 'Loaded asynchronously';
      document.getElementById('banner-slot').appendChild(b);
    }, ${DELAYS.asyncOnLoad});

    function loadAsync() {
      const btn = document.querySelector('[data-testid="async-load"]');
      btn.disabled = true;
      btn.textContent = 'Loading…';
      setTimeout(function () {
        const r = document.createElement('div');
        r.className = 'result';
        r.setAttribute('data-testid', 'result');
        r.textContent = 'Async action complete';
        document.body.appendChild(r);
        btn.textContent = 'Load data';
        btn.disabled = false;
      }, ${DELAYS.asyncOnClick});
    }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 03 — /rerender  (target tier: L1 + stale-ref re-resolution)
// ===========================================================================
// A DOM node that is REPLACED (not mutated) after interaction. The original ref
// (eN backendNodeId) goes stale; Flightplan must take a fresh snapshot and
// re-resolve at L1. The replacement keeps the SAME accessible name + testid so
// L1 deterministically re-resolves to the new node.
//
// Happy path:
//   1. click data-testid="rerender-trigger" ("Refresh widget")
//      -> after a fixed 600ms the #widget-host subtree is fully replaced with a
//         brand-new node tree (old refs invalidated).
//   2. click data-testid="rerender-action" ("Confirm")  — this node exists ONLY
//      in the re-rendered tree, forcing a re-resolve against a fresh snapshot.
//
// Expected assertable end-state:
//   - data-testid="result" visible, text "Re-rendered action confirmed"
//   - data-testid="rerender-generation" text "generation: 2" (proves replacement happened)
// ---------------------------------------------------------------------------
function rerenderPage(): string {
  return page(
    "Re-render — Flightplan fixture 03",
    `
  <h1>03 · DOM re-render / node replacement</h1>
  <p class="sub">Subtree is fully replaced after ${DELAYS.rerender}ms; refs go stale. Target tier: L1 (stale-ref re-resolve).</p>

  <button type="button" data-testid="rerender-trigger" onclick="rerender()">Refresh widget</button>

  <div id="widget-host" data-testid="widget-host">
    <div class="panel">
      <span data-testid="rerender-generation">generation: 1</span>
      <p class="muted">Original widget. The "Confirm" button only exists after refresh.</p>
    </div>
  </div>

  <script>
    let generation = 1;
    function rerender() {
      const btn = document.querySelector('[data-testid="rerender-trigger"]');
      btn.disabled = true;
      setTimeout(function () {
        generation = 2;
        const host = document.getElementById('widget-host');
        // Replace the ENTIRE subtree with brand-new nodes (invalidates old refs).
        const fresh = document.createElement('div');
        fresh.className = 'panel';
        fresh.innerHTML =
          '<span data-testid="rerender-generation">generation: ' + generation + '</span>' +
          '<p class="muted">Re-rendered widget.</p>' +
          '<button type="button" data-testid="rerender-action">Confirm</button>';
        host.replaceChildren(fresh);
        // Wire the freshly-created button.
        fresh.querySelector('[data-testid="rerender-action"]')
             .addEventListener('click', confirmAction);
        btn.disabled = false;
      }, ${DELAYS.rerender});
    }
    function confirmAction() {
      const r = document.createElement('div');
      r.className = 'result';
      r.setAttribute('data-testid', 'result');
      r.textContent = 'Re-rendered action confirmed';
      document.body.appendChild(r);
    }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 04 — /overlays  (target tier: L1 + auto-repair "covered")
// ===========================================================================
// A target button is physically COVERED by a cookie banner + modal overlay on load.
// browser-pilot reports failureReason="covered" + coveringElement; Flightplan's
// auto-repair dismisses the overlay, then retries the click (no model needed).
//
//   - A full-viewport overlay (data-testid="cookie-overlay") sits ON TOP of the page.
//   - A dismiss button (data-testid="cookie-accept", text "Accept cookies") removes it.
//   - The real target (data-testid="overlays-cta", "Place order") is underneath.
//
// Happy path:
//   1. click data-testid="cookie-accept"  (dismiss overlay — the auto-repair step)
//   2. click data-testid="overlays-cta"
//
// Expected assertable end-state:
//   - data-testid="cookie-overlay" becomes HIDDEN/removed (hidden assert)
//   - data-testid="result" visible, text "Order placed"
// ---------------------------------------------------------------------------
function overlaysPage(): string {
  return page(
    "Overlays — Flightplan fixture 04",
    `
  <h1>04 · Overlay / cookie banner covering target</h1>
  <p class="sub">Target is covered until the overlay is dismissed. Target tier: L1 + auto-repair (covered→dismiss).</p>

  <button type="button" data-testid="overlays-cta" onclick="placeOrder()">Place order</button>

  <!-- Full-viewport overlay that covers the CTA on load. -->
  <div id="cookie-overlay" data-testid="cookie-overlay" role="dialog" aria-label="Cookie consent"
       style="position: fixed; inset: 0; background: rgba(0,0,0,.55);
              display: flex; align-items: center; justify-content: center; z-index: 1000;">
    <div class="panel" style="background:#fff; max-width:420px;">
      <h2>We use cookies</h2>
      <p>This site uses cookies to make the fixtures deterministic.</p>
      <button type="button" data-testid="cookie-accept" onclick="dismissOverlay()">Accept cookies</button>
    </div>
  </div>

  <script>
    function dismissOverlay() {
      const o = document.getElementById('cookie-overlay');
      if (o) o.remove();
    }
    function placeOrder() {
      const r = document.createElement('div');
      r.className = 'result';
      r.setAttribute('data-testid', 'result');
      r.textContent = 'Order placed';
      document.body.appendChild(r);
    }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 05 — /contexts  (target tier: L1 — context traversal)
// ===========================================================================
// Targets nested inside (a) an iframe and (b) an OPEN shadow root (web component),
// plus a CLOSED shadow root that is intentionally NOT reachable (documents the limit).
// Exercises scoped a11y resolution across context boundaries.
//
//   - An <iframe> (srcdoc) containing a button data-testid="iframe-btn" ("Confirm in frame").
//   - A custom element <open-widget> with an OPEN shadow root containing a button
//     data-testid="shadow-open-btn" ("Confirm in shadow").
//   - A custom element <closed-widget> with a CLOSED shadow root (unreachable — its
//     button cannot be resolved; documents the boundary, NOT part of the happy path).
//
// Happy path (cross-context):
//   1. (in iframe) click data-testid="iframe-btn"      -> iframe shows its own result
//   2. (in open shadow) click data-testid="shadow-open-btn" -> emits a CustomEvent
//      that the host page surfaces as data-testid="result".
//
// Expected assertable end-state:
//   - Inside the iframe: data-testid="iframe-result" text "Frame confirmed"
//   - On the host page: data-testid="result" visible, text "Shadow confirmed"
// ---------------------------------------------------------------------------
function contextsPage(): string {
  // Markup served inside the iframe (via srcdoc). Kept deterministic + minimal.
  const frameDoc = `<!DOCTYPE html><html><head><meta charset='utf-8'>${HEAD_STYLE}</head><body>
    <h2>Inside iframe</h2>
    <button type='button' data-testid='iframe-btn' onclick='confirmFrame()'>Confirm in frame</button>
    <script>
      function confirmFrame() {
        var r = document.createElement('div');
        r.className = 'result';
        r.setAttribute('data-testid', 'iframe-result');
        r.textContent = 'Frame confirmed';
        document.body.appendChild(r);
      }
    <\/script>
  </body></html>`;

  return page(
    "Contexts — Flightplan fixture 05",
    `
  <h1>05 · iframe + shadow DOM context traversal</h1>
  <p class="sub">Targets live inside an iframe and an open shadow root. Target tier: L1 (scoped a11y).</p>

  <div class="panel">
    <h3>iframe context</h3>
    <iframe data-testid="context-frame" title="Embedded frame"
            style="width:100%; height:160px; border:1px solid #ccc; border-radius:6px;"
            srcdoc="${frameDoc.replace(/"/g, "&quot;")}"></iframe>
  </div>

  <div class="panel">
    <h3>open shadow root</h3>
    <open-widget></open-widget>
  </div>

  <div class="panel">
    <h3>closed shadow root (unreachable — documents the boundary)</h3>
    <closed-widget></closed-widget>
  </div>

  <div id="host-result-slot"></div>

  <script>
    // Web component with an OPEN shadow root (reachable for context traversal).
    class OpenWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML =
          '<button type="button" data-testid="shadow-open-btn">Confirm in shadow</button>';
        root.querySelector('button').addEventListener('click', function () {
          // Bubble out so the host page can surface a deterministic result.
          document.dispatchEvent(new CustomEvent('shadow-confirmed'));
        });
      }
    }
    customElements.define('open-widget', OpenWidget);

    // Web component with a CLOSED shadow root (NOT reachable — intentional boundary).
    class ClosedWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML =
          '<button type="button" data-testid="shadow-closed-btn">Unreachable</button>';
      }
    }
    customElements.define('closed-widget', ClosedWidget);

    document.addEventListener('shadow-confirmed', function () {
      const r = document.createElement('div');
      r.className = 'result';
      r.setAttribute('data-testid', 'result');
      r.textContent = 'Shadow confirmed';
      document.getElementById('host-result-slot').appendChild(r);
    });
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 06 — /gauntlet  (target tier: L2 — disambiguation by context)
// ===========================================================================
// Multiple visually/semantically identical "Save" buttons. Deterministic L1 is
// AMBIGUOUS: testid is duplicated/absent, role+name "Save" matches several nodes,
// text:"Save" matches several. Only a text/resolver model (L2) can disambiguate by
// surrounding context ("Save the billing address", not "Save draft" / "Save search").
//
//   - Three "Save" buttons in three differently-labelled panels. None carries a
//     UNIQUE testid (they share class="save-btn"); accessible name is "Save" for all.
//   - The intended target is the one inside the panel headed "Billing address".
//   - Each button writes a DIFFERENT result so an assertion proves the RIGHT one fired.
//
// Happy path (requires L2 to pick by context):
//   1. resolve+click the "Save" inside the "Billing address" panel
//
// Expected assertable end-state:
//   - data-testid="result" visible, text "Saved billing address"
//   (If the wrong Save fires, result text differs -> assertion catches the mis-resolve.)
// ---------------------------------------------------------------------------
function gauntletPage(): string {
  return page(
    "Gauntlet — Flightplan fixture 06",
    `
  <h1>06 · Ambiguous repeated controls</h1>
  <p class="sub">Three identical "Save" buttons; only context disambiguates. Target tier: L2.</p>

  <div class="panel">
    <h3>Search filters</h3>
    <p class="muted">Save your current search filters.</p>
    <button type="button" class="save-btn" onclick="saved('Saved search filters')">Save</button>
  </div>

  <div class="panel">
    <h3>Billing address</h3>
    <p class="muted">Save the billing address you entered above.</p>
    <button type="button" class="save-btn" onclick="saved('Saved billing address')">Save</button>
  </div>

  <div class="panel">
    <h3>Draft message</h3>
    <p class="muted">Save this message as a draft.</p>
    <button type="button" class="save-btn" onclick="saved('Saved draft message')">Save</button>
  </div>

  <script>
    function saved(text) {
      let r = document.getElementById('result');
      if (!r) {
        r = document.createElement('div');
        r.id = 'result';
        r.className = 'result';
        r.setAttribute('data-testid', 'result');
        document.body.appendChild(r);
      }
      r.textContent = text;
    }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 07 — /drift?variant=a|b|c  (tiers: a=L0/L1 · b=L1 heal · c=L2)
// ===========================================================================
// Simulates selector drift across runs for the SAME logical target — a primary CTA
// whose canonical recipe (from variant a) is data-testid="create-order".
//
//   variant=a (default, STABLE):
//     <button data-testid="create-order" ...>Create order</button>
//     -> L0 cache hit / L1 testid resolves immediately. No heal.
//
//   variant=b (TESTID CHANGED — heals at L1):
//     data-testid is renamed to "create-order-v2" BUT the role+accessible name
//     ("button" / "Create order") is UNCHANGED. The old testid recipe misses; L1
//     heals to the role_name strategy (still deterministic, no model).
//
//   variant=c (LARGER CHANGE — needs L2):
//     testid removed AND visible text changed to "Submit order" (a synonym), so
//     neither the old testid nor a literal role/name="Create order" match. Only the
//     resolver model (L2), reading intent + surrounding context, can map
//     "create order" -> the "Submit order" button.
//
// To keep variant c genuinely L2-only, sibling decoys exist ("Cancel order",
// "Save order") so a naive text-contains("order") match is ambiguous.
//
// Happy path (all variants):
//   1. resolve+click the primary create-order CTA (recipe authored against variant a)
//
// Expected assertable end-state (ALL variants):
//   - data-testid="result" visible, text "Order created"   (identical across variants,
//     so the assertion is variant-independent; only the RESOLUTION tier differs.)
// ---------------------------------------------------------------------------
function driftPage(variant: "a" | "b" | "c"): string {
  let cta: string;
  if (variant === "a") {
    cta = `<button type="button" data-testid="create-order" onclick="created()">Create order</button>`;
  } else if (variant === "b") {
    // testid renamed; role + accessible name identical -> L1 role_name heal.
    cta = `<button type="button" data-testid="create-order-v2" onclick="created()">Create order</button>`;
  } else {
    // testid gone + text is a synonym, with decoys -> needs L2 to disambiguate.
    cta = `<button type="button" onclick="created()">Submit order</button>`;
  }

  const decoys =
    variant === "c"
      ? `
    <button type="button" onclick="noop()">Cancel order</button>
    <button type="button" onclick="noop()">Save order</button>`
      : "";

  return page(
    "Drift — Flightplan fixture 07",
    `
  <h1>07 · Selector drift (variant=${variant})</h1>
  <p class="sub">Same logical "create order" CTA; selector drifts by variant. a=L0/L1 · b=L1 heal · c=L2.</p>

  <div class="panel">
    <h3>New order</h3>
    <p class="muted">Create a new order for the current customer.</p>
    ${cta}${decoys}
  </div>

  <script>
    function created() {
      const r = document.createElement('div');
      r.className = 'result';
      r.setAttribute('data-testid', 'result');
      r.textContent = 'Order created';
      document.body.appendChild(r);
    }
    function noop() { /* decoy — must NOT be the resolved target */ }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 08 — /signature?variant=same|changed  (tier: L0 sig-mismatch -> L1)
// ===========================================================================
// Tests the lock's page-signature gate (captureStateSignature text-hash + structural
// skeleton). The TARGET button is identical and stably resolvable in BOTH variants;
// what changes is the surrounding page content + structure so that a cached signature
// recorded against `same` no longer matches `changed`. L0 must DETECT the sig mismatch
// and fall back to re-resolving at L1 (rather than blindly replaying the stale recipe).
//
//   variant=same (baseline — record the signature here):
//     a single-column page with a known heading + paragraph + the target button.
//
//   variant=changed (BREAKS the signature):
//     - different visible text (changes the text-hash component), AND
//     - a different structural skeleton: the content is wrapped in an added 2-column
//       grid with extra sections (changes the role-tree structural hash).
//     The TARGET (data-testid="signature-action", "Continue") is unchanged and still
//     resolves cleanly at L1.
//
// Happy path (both variants):
//   1. resolve+click data-testid="signature-action"
//
// Expected assertable end-state (BOTH variants):
//   - data-testid="result" visible, text "Continued"
//   - For variant=changed, the run should report a sig mismatch -> L1 re-resolution
//     (a heal/observation), while the assertion still passes.
// ---------------------------------------------------------------------------
function signaturePage(variant: "same" | "changed"): string {
  const target = `<button type="button" data-testid="signature-action" onclick="cont()">Continue</button>`;

  if (variant === "same") {
    return page(
      "Signature — Flightplan fixture 08",
      `
  <h1>08 · Page signature (variant=same)</h1>
  <p class="sub">Baseline content + structure. Record the signature here. Target tier: L0 sig gate.</p>

  <div class="panel">
    <p>Your account is ready. Review the summary and continue to the dashboard.</p>
    ${target}
  </div>

  <script>
    function cont() {
      const r = document.createElement('div');
      r.className = 'result';
      r.setAttribute('data-testid', 'result');
      r.textContent = 'Continued';
      document.body.appendChild(r);
    }
  </script>`,
    );
  }

  // variant=changed — different text AND different structure (extra grid + sections).
  return page(
    "Signature — Flightplan fixture 08",
    `
  <h1>08 · Page signature (variant=changed)</h1>
  <p class="sub">Different text + structural skeleton; signature must mismatch. Target tier: L0 mismatch -> L1.</p>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
    <div class="panel">
      <h2>Onboarding checklist</h2>
      <ul>
        <li>Verify your email address</li>
        <li>Invite a teammate to the workspace</li>
        <li>Connect your first integration</li>
      </ul>
    </div>
    <div class="panel">
      <h2>Recent activity</h2>
      <table>
        <thead><tr><th>Event</th><th>When</th></tr></thead>
        <tbody>
          <tr><td>Workspace created</td><td>step one</td></tr>
          <tr><td>Profile updated</td><td>step two</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>Almost done</h2>
    <p>The layout and copy on this screen are completely different from the baseline,
       which deliberately breaks the cached page signature. The target button itself
       is unchanged so it still resolves cleanly once re-resolution kicks in.</p>
    ${target}
  </div>

  <script>
    function cont() {
      const r = document.createElement('div');
      r.className = 'result';
      r.setAttribute('data-testid', 'result');
      r.textContent = 'Continued';
      document.body.appendChild(r);
    }
  </script>`,
  );
}

// ===========================================================================
// FIXTURE 09 — /vision/icons  (target tier: L3 — vision only)
// ===========================================================================
// A toolbar of UNLABELED icon-only buttons. Each is an inline SVG glyph with:
//   - NO visible text
//   - NO aria-label / aria-labelledby / title
//   - NO data-testid
//   - identical generic role ("button") and EMPTY accessible name
// => L0/L1 cannot distinguish them; L2 (text/a11y fuzzy match) has no signal either.
// Only a VISION model (L3) reading the rendered glyph can tell trash vs edit vs share.
//
// To make the post-action state assertable WITHOUT leaking an accessible name, each
// button carries a NON-semantic data-action attribute (data-action="trash|edit|share")
// that the click handler reads to write a known result. Accessibility tooling and the
// a11y snapshot do NOT expose data-action as a name, so L0/L1/L2 still cannot use it —
// it exists purely so the fixture can prove WHICH icon a vision pick clicked.
//
// Happy path (e.g. "delete the item"):
//   1. (vision) resolve+click the trash icon button
//
// Expected assertable end-state:
//   - data-testid="result" visible, text "Clicked: trash"  (or "edit" / "share")
// ---------------------------------------------------------------------------
function visionIconsPage(): string {
  // Visually distinct, label-free SVG glyphs. aria-hidden on the SVG so no
  // accessible name leaks; the <button> has no name of any kind.
  const trashSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`;
  const editSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 5l4 4"/></svg>`;
  const shareSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2" aria-hidden="true"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 11l8-4M8 13l8 4"/></svg>`;

  return page(
    "Vision icons — Flightplan fixture 09",
    `
  <h1>09 · Unlabeled icon buttons</h1>
  <p class="sub">No text, no aria-label, no testid — vision only. Target tier: L3.</p>

  <div class="panel" role="toolbar" aria-label="Item actions">
    <button type="button" data-action="trash" onclick="clicked('trash')">${trashSvg}</button>
    <button type="button" data-action="edit" onclick="clicked('edit')">${editSvg}</button>
    <button type="button" data-action="share" onclick="clicked('share')">${shareSvg}</button>
  </div>
  <p class="muted">These buttons expose no accessible name; only the rendered glyph differs.</p>

  <script>
    function clicked(which) {
      let r = document.getElementById('result');
      if (!r) {
        r = document.createElement('div');
        r.id = 'result';
        r.className = 'result';
        r.setAttribute('data-testid', 'result');
        document.body.appendChild(r);
      }
      r.textContent = 'Clicked: ' + which;
    }
  </script>`,
  );
}

// ===========================================================================
// INDEX — /  (links to every fixture)
// ===========================================================================
function indexPage(): string {
  const rows: Array<[string, string, string]> = [
    ["/wizard", "01 · Wizard", "L0/L1 — multi-step form"],
    ["/async", "02 · Async", "L1 + polling — late elements"],
    ["/rerender", "03 · Re-render", "L1 — stale-ref re-resolve"],
    ["/overlays", "04 · Overlays", "L1 + auto-repair (covered)"],
    ["/contexts", "05 · Contexts", "L1 — iframe + shadow DOM"],
    ["/gauntlet", "06 · Gauntlet", "L2 — ambiguous controls"],
    ["/drift?variant=a", "07 · Drift", "a:L0/L1 · b:L1 heal · c:L2"],
    ["/signature?variant=same", "08 · Signature", "L0 sig-mismatch → L1"],
    ["/vision/icons", "09 · Vision icons", "L3 — vision only"],
  ];
  const links = rows
    .map(
      ([href, name, desc]) =>
        `<li><a href="${href}"><strong>${name}</strong></a> — <span class="muted">${desc}</span></li>`,
    )
    .join("\n      ");
  return page(
    "Flightplan fixtures",
    `
  <h1>Flightplan fixture server</h1>
  <p class="sub">Deterministic pages exercising the L0–L3 resolution ladder. See examples/fixtures/README.md for the full contract.</p>
  <nav>
    <ul>
      ${links}
    </ul>
  </nav>
  <p class="muted">Variants: <code>/drift?variant=a|b|c</code> · <code>/signature?variant=same|changed</code></p>`,
  );
}

// ===========================================================================
// Routing
// ===========================================================================

/** Parse a constrained variant query param with a default. */
function pickVariant<T extends string>(url: URL, allowed: readonly T[], fallback: T): T {
  const v = url.searchParams.get("variant");
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

function handle(req: Request): Response {
  const url = new URL(req.url);
  // Normalize trailing slash (except root).
  const path = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : "/";

  switch (path) {
    case "/":
      return html(indexPage());
    case "/wizard":
      return html(wizardPage());
    case "/async":
      return html(asyncPage());
    case "/rerender":
      return html(rerenderPage());
    case "/overlays":
      return html(overlaysPage());
    case "/contexts":
      return html(contextsPage());
    case "/gauntlet":
      return html(gauntletPage());
    case "/drift":
      return html(driftPage(pickVariant(url, ["a", "b", "c"] as const, "a")));
    case "/signature":
      return html(signaturePage(pickVariant(url, ["same", "changed"] as const, "same")));
    case "/vision/icons":
      return html(visionIconsPage());
    case "/healthz":
      return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    default:
      return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
}

const port = Number.parseInt(process.env["PORT"] ?? String(DEFAULT_PORT), 10);

const server = Bun.serve({ port, fetch: handle });

console.log(`Flightplan fixture server listening at http://localhost:${server.port}`);
console.log("Routes: / /wizard /async /rerender /overlays /contexts /gauntlet");
console.log("        /drift?variant=a|b|c /signature?variant=same|changed /vision/icons");
console.log("Press Ctrl+C to stop.");

export { handle, server };
