# Reference review and execution record

Reviewed and ran the [Insurance Claim Live Agent Team](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/voice_ai_agents/insurance_claim_live_agent_team) before implementation began, on 29 October 2026.

Source commit: `6c16b23f1bacd0fdf240bb5141ef45e59e82c306`. Reference checkout: temporary sparse clone, outside this repository. Read its README, `agent.py`, `live_demo/server.py`, and `live_demo/app.js`. This repository is an independent implementation, not a fork.

## What was actually run

Used Python 3.13.15 (reference recommends 3.12), Node.js 24.9.0, and a temporary virtual environment. Installed the reference's unchanged requirements; resolved Google ADK 2.13.0 and google-genai 2.34.0.

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/Shubhamsaboo/awesome-llm-apps.git /private/tmp/library-claim-reference
cd /private/tmp/library-claim-reference
git sparse-checkout set voice_ai_agents/insurance_claim_live_agent_team
cd voice_ai_agents/insurance_claim_live_agent_team
python3 -m venv /private/tmp/library-claim-reference-venv
/private/tmp/library-claim-reference-venv/bin/pip install -r requirements.txt
/private/tmp/library-claim-reference-venv/bin/python -m uvicorn live_demo.server:app --host 127.0.0.1 --port 4177
```

Server startup succeeded. `GET /api/health` returned HTTP 200 with `has_api_key: false`. `POST /api/sessions` with the expected `Origin: http://127.0.0.1:4177` returned HTTP 200, a new session, the initial notebook, and the deterministic intake packet. A request without Origin was correctly rejected with HTTP 403.

```sh
python -m unittest discover -s tests -p 'test_*.py'  # 55 passed
node tests/client-regressions.cjs                  # 18 passed
node tests/avatar-player.cjs                       # 7 passed
```

The server, initial intake, and reference's mocked tests ran. A live Gemini conversation and actual camera/model evidence capture were **not** exercised: no Google API key was supplied. An OpenAI key cannot authenticate Gemini. Do not interpret the successful startup and tests as an end-to-end Gemini model run.

## Retained interaction patterns

- Conversation and evidence capture continue while background work runs.
- A visible notebook/inventory updates as facts become available.
- Short capture guidance and interruption support let the claimant correct the agent.
- Evidence is saved with references and uncertainty labels.
- Deterministic code applies rules and assembles the downloadable packet.

## Changed for this assignment

- Use OpenAI voice and image APIs rather than Gemini/ADK, so one requested provider credential is sufficient.
- Split identification, metric measurement, source-backed pricing, and review into independently testable stages.
- Replace the narrative notebook with item records and evidence links.
- Persist sweep artifacts to disk, with portable report and JSON output.
- Derive money totals and geometry in code and preserve empty values when evidence is absent.
- Add local market/currency settings, second-country comparison, ground-truth tooling, cost/latency reporting, and a review queue.

## Discarded

Mock policy records, policy eligibility/routing, fraud scoring, incident sketches, optional avatar/video rendering, and insurer submission concepts do not support library contents measurement and were omitted. Generated sketches would not count as measurement evidence.
