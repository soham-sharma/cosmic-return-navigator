# Cosmic Return Navigator — Backend

Orchestration Engine + 7 specialized agents for the Cosmic Return Navigator
(Cosmic Mart returns/retention/sustainability case study). This README is
written for the **frontend team** — what to run, what to call, and what shape
comes back.

See [`docs/architecture.md`](../docs/architecture.md) for the system design and
[`docs/api_contracts.md`](../docs/api_contracts.md) for the full endpoint
reference. This file is the fast path to a working integration.

---

## 1. Run it

```bash
cd backend
npm install
cp .env.example .env      # fill in credentials if you want real agents (see §5)
npm run dev                # http://localhost:4000
```

Sanity check:

```bash
curl http://localhost:4000/ready
```

Everything is mock data — no external services except (optionally) the model
calls in §5. `npm run dev` restarts on file change.

### Try the primary demo scenario in one call

```bash
curl -X POST http://localhost:4000/api/v1/demo/scenarios/SCN-PRIMARY-SMARTWATCH/run \
  -H "content-type: application/json" -d '{}'
```

That runs the PRD's demo verbatim ("I bought a smartwatch 20 days ago...")
against a fixed customer/order and returns the fully completed case.

---

## 2. The one thing to understand: the response envelope

**Every** endpoint returns this shape — build one response handler for the
whole API:

```ts
type ApiEnvelope<T> =
  | { success: true; data: T; meta: { requestId: string; timestamp: string; durationMs: number; pagination?: {...} } }
  | { success: false; error: { code: string; message: string; details?: unknown; retryable: boolean }; meta: {...} };
```

`error.code` is a stable string from a closed set — branch on it, not on
`message`. Full list: `GET /api/v1/meta/error-codes`.

---

## 3. The core workflow, in the order you'll build it

### Step 1 — submit a return

```http
POST /api/v1/returns/intake
{ "text": "I bought a smartwatch 20 days ago. It arrived damaged and I'd like a return.",
  "async": true }
```

`async: true` returns immediately with `{ caseId, streamUrl }` — use this for
the live demo UI. `async: false` (default) blocks until the whole pipeline
finishes and returns the complete case; fine for a quick script, wrong for a
page that should animate.

### Step 2 — watch it run (SSE)

```js
const es = new EventSource(`/api/v1/returns/cases/${caseId}/stream`);
es.addEventListener('status', (e) => {
  const payload = JSON.parse(e.data);
  // payload.agentRuns: [{ agentId, stage, status, implementation, headline, confidence, ... }]
  // status: PENDING | RUNNING | COMPLETED | COMPLETED_WITH_WARNINGS | ESCALATED | SKIPPED | FAILED
  render(payload);
});
es.addEventListener('done', () => es.close());
```

This is what drives the animated pipeline: 7 agent cards, each transitioning
`PENDING → RUNNING → COMPLETED`. Reconnecting mid-run replays buffered events,
so a refresh doesn't lose the timeline.

### Step 3 — read the result

```http
GET /api/v1/returns/cases/:caseId            # everything: intent, context, all 7 agent outputs, trace, conflicts
GET /api/v1/returns/cases/:caseId/outcome    # just the final flattened answer (hero card)
GET /api/v1/returns/cases/:caseId/agents/:agentId   # one agent's full typed output
GET /api/v1/returns/cases/:caseId/timeline   # ordered trace events (audit log UI)
GET /api/v1/returns/cases/:caseId/conflicts  # orchestrator's cost-vs-carbon arbitration log
```

`outcome.customerMessage` is the single string to show as "what happened" —
it's pre-composed (e.g. *"We've approved your replacement, scheduled a pickup
for tomorrow, and added 500 Cosmic Rewards points..."*). `outcome.nextSteps`
is a ready-made checklist.

---

## 4. Screen → endpoint map

| Screen | Endpoint(s) |
|---|---|
| Return intake chat | `POST /returns/intake`, `POST /returns/intake/parse` (preview only) |
| Live agent pipeline | `GET /returns/cases/:id/stream` (SSE), `GET /meta/pipeline` (draw the stage diagram) |
| Agent panel / catalogue | `GET /agents` (name, purpose, which implementation — rules or LLM — is live) |
| Result / hero card | `GET /returns/cases/:id/outcome` |
| "How we decided" drill-down | `GET /returns/cases/:id` → `agentResults.*.rationale`, `.output` |
| Resolution comparison table | `agentResults.resolution.output.decisionMatrix` |
| Carrier/route comparison | `agentResults.logistics.output.candidateOptions` |
| CO2 / sustainability badge | `agentResults.sustainability.output` (`co2PreventedKg`, `grade`, `equivalents`) |
| Customer inbox preview | `GET /notifications?caseId=...` |
| Shipment tracking | `GET /shipments/:id/tracking`, demo control: `POST /shipments/:id/advance` |
| Support queue | `GET /returns/escalations` |
| Support action buttons | `POST /returns/cases/:id/decision` (approve/reject/resume/override) |
| Executive dashboard | `GET /analytics/kpis`, `/analytics/trends`, `/analytics/root-causes` |
| Sustainability dashboard | `GET /sustainability/summary` |
| Insights / product board | `GET /insights`, `PATCH /insights/:id` (acknowledge/action/dismiss) |
| Order picker (skip free-text parsing) | `GET /customers/:id/orders` — pass `orderId`/`orderItemId` straight into intake |
| Policy page | `GET /reference/policy` (the whole policy as data — don't hardcode copy) |
| Dropdowns / badge colors | `GET /reference/enums` |
| Demo controls | `GET /demo/scenarios`, `POST /demo/scenarios/:id/run`, `POST /demo/reset` |

Full machine-readable list: `GET /api/v1/meta/routes`.

---

## 5. Two runtimes — same API, same response shape

Every one of the 7 agents can run as either:

- **`rules`** — deterministic TypeScript. Instant, free, byte-reproducible. This is the default and what CI runs on.
- **`llm`** — a real Claude call (via the Claude Agent SDK) with a forced JSON schema derived from the same contract.

Which one ran is visible on every result: `agentResults.<agent>.implementation`
is `"rules"` or `"llm"`. If an LLM agent fails (no credentials, network,
timeout), it **falls back to rules automatically** and says so in a warning —
the frontend never has to handle a hard failure differently.

Nothing in the frontend needs to change based on which runtime is active — the
schema is identical either way. `GET /agents` shows which implementation is
currently live per agent, if you want to surface it (e.g. a small "AI-assisted"
badge).

To point the backend at a real model, set in `.env`:

```bash
AGENT_RUNTIME=llm            # or "hybrid" to mix — see .env.example
LLM_MODEL=claude-sonnet-5
ANTHROPIC_AUTH_TOKEN=...     # Bearer-style gateways (most third-party proxies)
# or ANTHROPIC_API_KEY=...   # first-party Anthropic API keys
ANTHROPIC_BASE_URL=...       # only if using a gateway/proxy
```

> If you see a `400 This key was not found` error with a valid-looking key,
> you're using the wrong credential variable for that endpoint — swap
> `ANTHROPIC_API_KEY` for `ANTHROPIC_AUTH_TOKEN` (or vice versa). See the
> comment block in `.env.example`.

---

## 6. Demo determinism

The backend clock is **frozen** at `2026-09-08T10:15:00Z` by default
(`DEMO_FREEZE_CLOCK=true`), so "I bought this 20 days ago" always resolves to
the same fixture order, no matter when you run the demo. `POST /api/v1/demo/reset`
wipes all runtime state (cases, notifications, insights) back to the seeded
fixtures, so you can re-run a scenario and get identical output every time —
useful before a rehearsal.

7 named scenarios cover the PRD's edge cases (outside window, VIP low-value
item, EU statutory rights, fraud signal, perishable denial, no-greener-option) —
`GET /api/v1/demo/scenarios` lists them with the expected outcome documented.

---

## 7. Local dev notes

- TypeScript, Express, Zod (schema-first — every request/response shape is a
  Zod schema, so types and validation can never drift apart).
- `npm test` runs the suite fully offline (no model calls, even if `.env` has
  live credentials — see `vitest.config.ts`).
- `npx tsx scripts/showcase.mts [primary]` runs one or all scenarios and prints
  a full narrated trace of every agent, every decision, and every dashboard —
  useful for seeing the whole system's shape before wiring up a screen.
