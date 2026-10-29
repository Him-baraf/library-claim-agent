# Collect ground truth before tuning

These files are empty collection templates, not a dataset or measured results. No physical capture or accuracy claim is included in the repository.

1. Choose one enclosed room containing at least 60 books, two shelving units, and eight non-book items. Obtain permission. Exclude people and documents containing personal data.
2. Before running/tuning the model, count **every** book, including unreadable spines and flat stacks. Assign a stable truth ID to each physical copy and shelf. Hand-read every legible title/author. Mark unreadable spines `human_legible: false`; do not omit them.
3. Select and hand-measure 20 spines across the whole room. Record both height and thickness, including flat books. Choose the sample before inspecting model errors.
4. Hand-check 15 book prices. Record replacement/used kind, price, country/currency, full listing URL, source type, retrieval time, and exact condition. Use comparable listings and record a snapshot. For the evaluator's strict like-for-like check, use the exact source URL and condition recorded by the packet; any different source remains explicitly non-comparable and fails the sample rather than disappearing.
5. List all non-book items and their categories. Tape-measure the room before tuning; for a non-rectangle, measure the complete polygon, compute its area and perimeter, and multiply perimeter by uniform height for gross wall area. State any sloped-ceiling/opening assumptions.
6. Capture one unedited sweep. Match every truth book/item to its system ID where present. Leave missed detections unmatched (`null`); never drop a truth row. Keep duplicates and false positives in the system packet.
7. Copy `ground_truth.template.json` to an ignored local file. Set sweep ID and date, and populate the arrays. CSV files are optional hand-entry sheets; the JSON is the evaluator's canonical input.

Book row shape:

```json
{
  "truth_id": "your-stable-id",
  "shelf": "your-shelf",
  "system_id": null,
  "title": "",
  "author": "",
  "human_legible": false,
  "spine_height_cm": null,
  "spine_thickness_cm": null,
  "price_check": null
}
```

For a sampled price replace null with this object and actual observations:

```json
{
  "kind": "replacement",
  "amount": 0,
  "currency": "",
  "source_url": "",
  "source_type": "",
  "retrieved_at": "",
  "condition": ""
}
```

Item shape: `{ "truth_id": "your-stable-id", "system_id": null, "category": "your-hand-checked-category" }`.

```sh
npm run evaluate -- --packet data/YOUR_SWEEP/claim_packet.json --truth evaluation/ground_truth.local.json --out evaluation/results.local
```

The evaluator emits JSON, spreadsheet-friendly CSV, and Markdown. It validates full book enumeration, one-to-one matches, human legibility, dimensions, and price provenance. Missing predictions remain in denominators. Insufficient samples are **NOT MEASURED**, never a pass. Dimension/price errors use mean absolute relative error, show individual errors and within-tolerance counts, and cannot pass with a missing prediction. Confident wrong rate uses predictions at confidence ≥0.85; zero confident predictions are not a pass. Exact author matching applies where ground truth provides an author; punctuation/case is normalized. This conservative matching may need a documented alias correction (for example initials or a translated title); make that correction in the truth data transparently, never hide rows.

Physical deliverables still required: unedited ≤6-minute demo, claim packet/report and saved frames from that demo, full truth sheet and generated results, and three actual run failures. The implementation alone does not demonstrate any pass bar.
