# Failure log — real run required

No real-room run has been collected. These are engineering failure modes, not fabricated demo errors. After the full run, fill the actual worst-three table with frame/line IDs and keep every failed shelf in evaluation.

| Failure mode                                 | Root cause                                                                      | Implemented mitigation                                                                          | Remaining test                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Stale valuation after identification changes | Tracking/user edits mutate identity while old prices remain                     | Revision signatures, price invalidation, asynchronous results applied only to matching targets  | Correct title/author by voice and verify source refresh       |
| Plausible amount for wrong format/condition  | Models/search snippets can mix listings and invent money                        | Retrieved literal product-offer verifier with identity, format and condition gates              | Hand-check 15 live offers; count bot-blocked blanks as misses |
| Metric ambiguity or duplicated books         | Monocular scale ambiguity, occlusion, blur, imperfect physical-copy association | Known-plane homography, shelf IDs, previous-frame matching, explicit unknowns and overlap flags | Compare 20 spines and full room/count against tape/hand truth |

| Rank | Sweep/line/frame | Actual error vs truth | Evidence-supported cause | Attempted fix | Before/after measurement |
| ---- | ---------------- | --------------------- | ------------------------ | ------------- | ------------------------ |
| 1    |                  |                       |                          |               |                          |
| 2    |                  |                       |                          |               |                          |
| 3    |                  |                       |                          |               |                          |

Sweep ID: **not collected**. Cost per sweep: **not measured**. Finalization latency: **not measured**. Populate using `state.json.metrics` and the report. Reconcile partial token/tool estimates with the actual provider dashboard; state missing billing components instead of writing zero.

A live provider smoke test also caught an English-title replacement matched to a translated edition because token overlap ignored the title prefix. Matching now requires the observed full title phrase or an exact supported ISBN, with regression coverage. This is an actual API integration error found and fixed; it is not a measured real-room accuracy result.

With two more weeks: collect diverse consented rooms with complete truth before tuning; compare pretrained spine segmentation and feature tracking to model association; add calibrated depth/LiDAR or visual-inertial reconstruction for whole-room geometry; add verified retailer adapters for test countries; evaluate asking prices separately from completed sales; calibrate confident-wrong identification rates; benchmark latency/cost and mobile audio on Safari/Chrome. No training from scratch is proposed.
