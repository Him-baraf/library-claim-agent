# Library Contents Claim Agent

Live browser voice and camera intake for a home-library contents inventory. Recognition, metric measurement, market-source retrieval, review, and packet assembly are separate stages. Unknowns stay empty; rare books and original art require appraisal; totals are computed in TypeScript.

**Status:** application and evaluation tools implemented, with fixture-based automated tests. Live API and browser checks are recorded in [provider-smoke.md](docs/provider-smoke.md). No genuine demo or real-room accuracy result is claimed; the final physical benchmark needs your room. See [submission checklist](docs/submission-checklist.md).

## Run in under 15 minutes

Requirements: Node.js 22+, browser camera/microphone, OpenAI API project with billing and access to the configured vision, web-search, transcription and Realtime models. No database or Google key required.

```bash
npm ci
cp .env.example .env
# Set OPENAI_API_KEY in .env; server-only, never in the UI.
npm run doctor
npm run dev
```

Open **http://localhost:5173** directly in **Chrome or Safari** on this computer, then allow camera and microphone. Embedded app previews can omit device APIs even on localhost; open the same address in a normal browser tab if the app reports that camera access is unavailable. If a model is unavailable to your project, change its environment variable and restart. Defaults: `gpt-6.1-terra` for image recognition `gpt-6.1-sol` for source discovery, and `gpt-realtime-2.1` for voice. See official [models](https://developers.openai.com/api/docs/models), [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [Realtime image input](https://developers.openai.com/api/docs/guides/realtime-conversations) and [web search](https://developers.openai.com/api/docs/guides/tools-web-search).

Without a key, you can test setup, persistence, calibration, room geometry, errors and export. Recognition and valuation remain explicitly unavailable. No fabricated inventory is presented as live output.

### Camera troubleshooting

- **Embedded preview:** open `http://localhost:5173` directly in Chrome or Safari. HTTPS does not add device support to a browser view that omits camera APIs.
- **Permission denied:** allow camera and microphone in the browser's site controls. If still denied, enable that browser in macOS System Settings → Privacy & Security → Camera and Microphone, then retry.
- **No device or device busy:** connect a camera/microphone or close the app using it.
- **Phone over plain HTTP:** follow the HTTPS setup below; `localhost` on a phone refers to the phone itself.

### iPhone testing with trusted HTTPS

`localhost` on your iPhone is the phone, not this laptop. A plain HTTP Wi-Fi address cannot capture camera/microphone. Open the app in **Safari on the iPhone** using a trusted HTTPS route.

For a temporary test link without installing a certificate on the phone:

```bash
# Terminal1: start local app
npm run dev
# Terminal2: build the phone client and start its protected route
npm run build
npm run phone:share
```

Install [Cloudflare's official cloudflared utility](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) first, or set `CLOUDFLARED_BIN` to its path. `phone:share` explicitly starts an outbound Cloudflare tunnel. Its temporary HTTPS link contains a random access code in the URL fragment; opening it exchanges the code for a Secure/HttpOnly session cookie. Every app/API/evidence request on this route is gated. The OpenAI API key stays on the laptop. Frames, transcripts, claim files and app requests pass through Cloudflare; use this route only when that relay is acceptable. Keep the link private and stop the launcher with Ctrl+C when finished. This closes the gateway/tunnel and revokes its sessions. The laptop must remain awake. `npm run phone` starts only the loopback gateway for local checks and creates no public tunnel.

Open the printed full link in iPhone Safari, tap **Start camera & sweep**, and allow camera and microphone. Keep Safari in the foreground. If playback is silent, tap **Enable speaker**. A local recording needs a running audio context; check any recording-audio warning rather than assuming sound was captured.

Cloudflare Quick Tunnels [do not support SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations), so the app switches to two-second polling if no valid live state arrives within five seconds. Inventory, capture guidance and packet readiness still update. The frontend is served from the production build, without exposing the Vite development server.

For Wi-Fi-only testing instead, set `DEV_HTTPS=true` and restart Vite, then open its network URL on the phone. iOS may require a properly trusted local CA certificate, not just dismissing a certificate warning. Installing a local CA and explicitly enabling its full trust is a separate device setup; this repo does not change your system trust settings. HTTPS/API transport tests do not replace actual iPhone camera/audio/recording verification.

### Build and verify

```bash
npm run check
npm run build
npm start
# Local production app: http://localhost:8787
```

Single-user local tool; use your machine/trusted network. Hosted deployment and authentication are outside the assignment scope.

## Capture workflow

1. Build ground truth **before tuning**, using [evaluation/README.md](evaluation/README.md). Choose one room, at least 60 books across two units, and eight non-book items. Hand-read every legible title; measure 20 spines; check 15 prices; tape-measure the room.
2. Set country (ISO alpha-2), currency and appraisal threshold in that currency. Select a second market for the same first ten eligible books.
3. Start camera/voice and continuous demo recording, or use your device screen recorder. Check that microphone and agent audio are both audible.
4. Walk once, slowly across every shelf row, including stacked books. Change the shelf label for each distinct physical row/zone; retain the label for overlapping closeups. Include walls, corners, floor, ceiling, furniture, appliances and art. Aim for under three minutes. Do not remove books, scan barcodes or capture one book at a time.
5. Correct the agent by voice or text. State whether art is original or a print, flag rare/signed/first editions, and exclude things you do not own.
6. In **Measurements**, select saved frames from that same pass. Mark four corners of a known coplanar rectangle in TL → TR → BR → BL order, then enter its true width/height in cm. Known shelf-opening dimensions can scale a shelf's spine plane. Each calibration applies only to that frame/plane. Mark calibrated floor boundary, ceiling height and disjoint shelving wall polygons. Geometry outside the reference rectangle is refused. If boundaries cannot be recovered, use known/pre-existing room dimensions with their source or leave areas unknown. Do not disguise a failed capture with a separate measuring pass.
7. Finish. Background pricing began during capture and continues within a bounded finalization budget. You can mark saved measurement planes while it runs. Missing sources/evidence produce an honest partial packet. Wait for the final readback, then stop recording. Keep the genuine demo under six minutes; do not edit, stitch or accelerate it.
8. Download JSON, HTML report and evidence ZIP. Trace lines to frames and price evidence, inspect review flags and the second-market table. After editing an identity or confirming a print, use **Rebuild valuations**.

## Measurement and identification boundaries

Vision detects spine quadrilaterals and reads visible text; it supplies no centimetres or prices. Unreadable titles stay blank. Only complete visible titles above the threshold become identified lines. Open Library corroborates a work, never silently an edition or ISBN.

A projective homography maps a user-marked known rectangle to metric coordinates. Transformed edges yield spine thickness and height, including horizontal orientation. Measured thickness sums to shelf run. This assumes coplanarity and correct reference dimensions. Scale never transfers between frames/planes. Perspective does not establish depth; unknown depths remain empty.

Floor area uses a complete simple polygon and shoelace formula. Gross wall area is perimeter × uniform ceiling height, without door/window deductions. Shelving coverage is separately measured from disjoint wall polygons. Nonrectangular rooms use the complete boundary. Monocular footage alone cannot establish absolute scale. There is no hidden LiDAR, SLAM or depth reconstruction. Missing references/boundaries produce unknowns; user-supplied room dimensions remain explicitly attributed and are not claimed as automatic recovery.

Repeated views use the previous same-shelf frame and physical-copy IDs. Duplicate copies of a title remain separate. Ambiguous tracking enters review. Count and metric targets remain unproven until evaluated on a real room.

## Pricing integrity

A separate model searches the live web for product URLs in the requested market. Its claimed amounts are never accepted. The server independently fetches cited pages, verifies public HTTPS/DNS/redirects, and parses literal product-scoped JSON-LD or microdata offers. Identity, physical format, explicit condition, availability and currency gate acceptance. Ebooks, rentals, bundles, signed/rare listings and unavailable offers are rejected. Unknown-model items require two verified comparable offers for a range. Art defaults to appraisal unless the claimant confirms a print.

Local offers are preferred. Foreign offers are labelled; actual currency conversions use [Frankfurter](https://frankfurter.dev/) and retain dated FX evidence. Seller market is derived from source metadata/domain and remains an assumption; currency alone does not prove locality. Shipping/import duty/tax are excluded unless included by the source. Used values are asking prices, not depreciation guesses or claims of completed sales.

Bot blocks, missing offer metadata and unverifiable variants leave blanks, excluded from the corresponding total. Search snippets and model memory are insufficient. This strict verifier can have low price coverage; the report exposes that failure. Second-market comparison uses the same first ten eligible IDs; fewer than ten is marked incomplete. Appraisal threshold is a numerical setting in the selected currency; choose an appropriate threshold for each market.

## Artifacts, evaluation, cost

Ignored `data/<uuid>/` contains `claim_packet.json`, `report.html`, saved `frames/*.jpg`, fetched `sources/*.json`, independent `stages/*.json`, and recoverable `state.json` with transcripts, corrections and metrics. ZIP references work offline. Required contract fields are retained; unknown numbers are `null`, not false zeros. Interrupted jobs become explicit failures on restart. The default frame limit is 90. Pending same-shelf analysis favors the latest view; skipped views remain saved and reviewed.

```bash
npm run evaluate -- --packet data/<sweep-id>/claim_packet.json \
  --truth evaluation/your-ground-truth.json --out evaluation/results
```

See [ground-truth guide](evaluation/README.md) for schema and complete-run scoring. Outputs: JSON, CSV and Markdown. Missing evidence is **not evaluated**, never a pass. Do not submit fixture results as real accuracy. Fill the actual three worst errors in [failure-log.md](docs/failure-log.md).

Metrics record stage timestamps, latency, model, tokens, search calls and estimated USD cost. Work overlaps, so summed stage durations differ from wall time. Default `FINALIZATION_TIMEOUT_MS=240000` bounds finalization; unfinished lines remain unknown. Actual real-room latency and cost require the live test. Pricing concurrency defaults to ten and is configurable from 1–12 with `PRICING_CONCURRENCY`; lower it if your account rate limits require it. The `.env.example` includes a dated default-model rate snapshot; update rates when changing models. Unset rates mean unknown/partial cost, never free. Realtime records response usage, but audio/text/cached billing reconciliation still requires provider usage/rates. Check [current pricing](https://developers.openai.com/api/docs/pricing) and the account dashboard after a small first test.

## Reference and implementation

The required [Insurance Claim Live Agent Team](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/voice_ai_agents/insurance_claim_live_agent_team) was read, installed and run **before implementation**, pinned to `6c16b23f1bacd0fdf240bb5141ef45e59e82c306`. HTTP health/session checks and 80 reference tests passed. Gemini live voice was not tested without a separate Google key. Exact commands: [reference-review.md](docs/reference-review.md).

Kept: continuous voice/camera, interruption, live notebook, background packet assembly. Changed: OpenAI WebRTC, separate structured identification, deterministic geometry, fetched-source verification, code totals. Discarded: mock policy database, damage narratives, sketches and avatar. Independently implemented; not a fork or prompt swap.

Read [architecture](docs/architecture.md), [failure log](docs/failure-log.md), [submission checklist](docs/submission-checklist.md) and [implementation contract](docs/implementation-contract.md). Codex and delegated coding agents assisted coding/testing. No model was trained or fine-tuned. TypeScript, React, Express, Sharp, Cheerio, Zod, Archiver; native fetch/WebRTC for model calls; dependency versions in lockfile.
