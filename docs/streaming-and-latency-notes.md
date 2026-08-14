# Streaming and latency notes (for later)

Captured after hybrid SQL + Bedrock KB routing landed. Policy answers already prefer Markdown bullets where multi-item lists are appropriate. Streaming was deferred.

## Observed latency (example)

Query: `what grants are available to assist with retrofitting?` (~6.7s total)

| Stage | Approx. time | Share |
| --- | --- | --- |
| Reformulate (Qwen) | ~0.6s | ~9% |
| Route (Haiku) | ~1.1s | ~16% |
| **KB RetrieveAndGenerate (Haiku)** | **~5.0s** | **~75%** |

Almost all wait on policy path is RAG (retrieve + generate), not classification.

## Latency advice (not all implemented)

Worth revisiting after more real user traffic; quality may matter more than shaving seconds.

1. **Skip useless reformulation** when there is no multi-turn dependency (or when reformulate would only change capitalisation). Can save ~0.5–1s on some turns; does not fix the ~5s KB stage.
2. **Keep Haiku for policy generation** as quality baseline unless a bake-off proves otherwise.
3. **Do not move the whole pipeline to Qwen-235B** hoping for speed — large model; routing/SQL/RAG quality risk; unlikely to fix KB wall time.
4. **Faster/cheaper models for routing only** (e.g. Amazon Nova Micro) may cut ~1s classify; optional heuristic gate before any LLM route call.
5. **KB knobs** (quality-sensitive — A/B first):
   - Lower `numberOfResults` (e.g. 6 → 3–4)
   - Lower generation `maxTokens` (policy answers often need far less than 2000)
   - Prompt already asks for concise bullets for multi-item answers
6. **Perceived latency**: streaming (below) often beats a 10% model swap.
7. Optional Bedrock `performanceConfig.latency = "optimized"` where supported for the chosen model/region.

Rough target after tuning: ~2–4s for grounded multi-doc policy questions; sub-2s consistently is hard without streaming and aggressive answer limits.

---

## Streaming implementation plan (deferred)

Streaming is cross-cutting: API shape, Bedrock APIs, frontend, proxy buffering, logging. Total wall-clock may only drop a little; **time-to-first-token** is the user-visible win.

### 1. Backend API design

Today: one JSON body `{ response, sources }` after everything finishes.

Options:

| Approach | Pros | Cons |
| --- | --- | --- |
| **SSE** (`text/event-stream`) on `POST /api/query` or `/api/query/stream` | Simple with `fetch` + `ReadableStream`; common pattern | Need Apache/proxy buffering off |
| **NDJSON** line protocol | Easy to parse | Slightly less standard than SSE |

Suggested event sequence:

1. `meta` — `{ route: "policy" | "directory" | "out_of_scope" }` (optional)
2. `token` / `delta` — `{ text: "..." }` repeated
3. `sources` — `{ sources: [...] }` (policy; often only complete at end)
4. `done` — `{ outcome }`
5. `error` — `{ error }` if something fails mid-stream

Keep non-streaming JSON as fallback initially (or feature-detect).

### 2. Bedrock: path-specific streaming

**Policy (main latency / UX win)**  
`RetrieveAndGenerate` is not ideal for token streaming. Prefer:

1. `Retrieve` (wait for chunks)
2. `ConverseStream` (or evaluate `RetrieveAndGenerateStream` if available and suitable) with the same system prompt + retrieved passages
3. Map citations from retrieve results (reuse `display_name` / `url` metadata logic in `sourcesFromKbCitations`)

That split is more code than R&G but enables real token streaming and controlled source metadata.

**Do not** fake streaming by buffering full R&G then chunking locally — that does not improve time-to-first-token.

**Directory**  
Harder end-to-end:

- Route → SQL gen → SQLite → answer gen
- Only the **final answer** (or deterministic wrapper) is worth streaming
- Optional status events: `"Looking up organisations…"`, `"Writing answer…"`

**Reformulate / route**  
Usually not streamed to the user; optional status events only.

### 3. Frontend (`website/js/app.mjs`)

Today: `fetch` → `response.json()` → `appendMessage` once.

Needed:

- Stream body parse (SSE/NDJSON)
- Create AI bubble immediately; append text deltas
- Throttle Markdown re-parse (e.g. every 50–100ms or on newlines) — avoid `marked.parse` on every token
- Attach sources on `sources` event
- `AbortController` on New chat / navigation
- Hide processing overlay on **first token** (or first status), not only on completion
- Mid-stream errors: keep partial answer + error line

### 4. Proxy / ops

Production is Apache → Node (`README` architecture):

- Disable response buffering for the stream location
- Adequate proxy/read timeouts for long generations
- Prefer **POST + fetch stream** (not EventSource) because the API body is a JSON `messages` array
- CORS can stay as today if same origin rules apply

### 5. Usage logging (`usage.mjs`)

- Log full answer + tokens at `done`
- Optionally record **TTFT** and **total** latency separately
- Write request log when stream completes (or on abort)
- Preserve `route`, outcomes (`ok`, `kb_no_hit`, etc.)

### 6. Suggested phases

1. **Policy-only streaming** behind `/api/query/stream` (or `?stream=1`); directory stays blocking JSON
2. Frontend uses stream when available; falls back to JSON
3. Status events for directory
4. Optionally stream directory final-answer stage
5. Retire duplicate non-stream path only when stable

### 7. Effort / risk

- **Medium–large** (focused day or two): Retrieve + ConverseStream, citation parity with current metadata mapping, progressive Markdown UI, Apache buffering, abort/error paths
- Quality risk is mainly from replacing R&G with Retrieve + Converse (prompt/citation parity), not SSE itself — bake off known policy questions before making stream the default

### 8. First milestone (when picked up)

Policy path only: SSE deltas + sources-at-end + frontend progressive Markdown; leave directory on existing JSON `POST /api/query`.

---

## Related code touchpoints

| Area | Location |
| --- | --- |
| Query API, route, KB R&G | `backend/query.mjs` |
| Usage / latency log | `backend/usage.mjs` |
| Chat UI | `website/js/app.mjs` |
| Apache proxy | `/etc/httpd/conf.d/retrofit-directory.conf` (ops) |
| KB id | `WTVA5TOLIX`, region `eu-west-2` |

## Already done (context)

- Hybrid intent router: `directory` | `policy` | `out_of_scope`
- Policy sources from KB metadata `display_name` + http(s) `url` (not `s3://`)
- Policy prompt prefers short bullet lists for multi-item answers
