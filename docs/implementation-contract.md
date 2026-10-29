# Implementation contract

Independent Node 22+ / TypeScript repository. Express server, Vite React browser client, Zod input validation, Vitest. Root owns package/config, server orchestration/model vision/API/store. `shared/types.ts` will hold types. No model invented prices/dimensions. Unknown numerical fields are null.

## Coordinates and measurement

All image points normalized x/y in [0,1]. Quad order TL,TR,BR,BL for calibration; book quad same intrinsic spine order (rotate for horizontal book). A per-frame plane calibration is four user-clicked points plus known width_cm, height_cm; projective homography maps to centimetres. Only polygons entirely within that plane may inherit scale. No transferring a homography between frames. Plane = shelf|floor|wall. Room geometry uses floor polygon + floor calibration and a wall height segment + wall calibration from saved sweep frames; shelved wall areas from wall polygons. Alternate known user room dimensions allowed but explicitly attributed as user supplied, never inferred by model. Room defaults unknown. Arbitrary simple polygon floor uses shoelace and perimeter times ceiling height. Shelf run=sum measured thickness /100; partial sum clearly marked.

## API

- GET /api/health -> {openai_configured,models:{vision,pricing,realtime}, version}
- GET /api/sweeps -> [{id,captured_at,country,currency,status}]
- POST /api/sweeps {country,currency,device,room_name?,appraisal_threshold?,second_country?,second_currency?} -> SweepState
- GET /api/sweeps/:id -> SweepState
- GET /api/sweeps/:id/events -> SSE event `state` JSON SweepState; `guidance` {text}; `error` {message}
- POST /api/sweeps/:id/frames {image: data JPEG URL,width,height,shelf_id,sequence,captured_at?} -> FrameRecord. Saves frame before queued analysis; max one pending analysis per shelf snapshot; bounded queue.
- POST /api/sweeps/:id/realtime body application/sdp -> SDP answer; upstream credentials server only.
- POST /api/sweeps/:id/transcript {role:'user'|'assistant',text} -> {ok:true}
- POST /api/sweeps/:id/corrections {text,book_id?,item_id?,shelf_id?,action?:'exclude'|'appraisal'|'print'|'note',title?,author?} -> SweepState. Free text persisted and passed to extractor; structured corrections applied deterministically. Realtime tool `record_correction` uses this body; `set_shelf` {shelf_id} browser local selection.
- POST /api/sweeps/:id/calibrations {frame_ref,plane,shelf_id?,width_cm,height_cm,quad} -> SweepState
- POST /api/sweeps/:id/room {floor?:{calibration_id,frame_ref,polygon},height?:{calibration_id,frame_ref,points:[Point,Point]},shelving?:[{calibration_id,frame_ref,polygon}],known?:{length_m,width_m,height_m,source}} -> SweepState
- PATCH /api/sweeps/:id/lines/:lineId {title?,author?,excluded?,status?,art_is_print?,notes?} -> SweepState
- POST /api/sweeps/:id/finish -> SweepState; asynchronous bounded finalization, repeat idempotent
- POST /api/sweeps/:id/reprice {country,currency} -> SweepState; same first 10 eligible books comparison; doesn't replace primary totals
- GET /api/sweeps/:id/packet -> claim_packet.json attachment
- GET /api/sweeps/:id/report -> generated report.html
- GET /api/sweeps/:id/bundle -> ZIP packet + report + frames + stage outputs + sources + transcript + metrics
- /evidence/:id/frames/:filename serves local saved JPEG; frame_ref is that absolute URL path (bundle report uses relative rewriting).

## Types (exact property conventions)

Point={x:number,y:number}; Quad=[Point,Point,Point,Point].
FrameRecord={id,frame_ref,captured_at,width,height,shelf_id,sequence,quality?:{blur:number,glare:number},analysis_status:'queued'|'processing'|'done'|'failed'|'skipped',error?:string}.
Calibration={id,frame_ref,plane:'shelf'|'floor'|'wall',shelf_id?:string,width_cm,height_cm,quad}.
Price={amount:number|null,source:string,url:string,retrieved_at:string,converted:boolean,condition_assumed:string,currency:string,original_amount?:number,original_currency?:string,fx_source?:string,fx_rate?:number,evidence_ref?:string,notes?:string}.
Book={id,shelf,position,frame_ref,status:'identified'|'unidentified'|'needs_appraisal',title,author,publisher,edition,isbn,spine_height_cm:number|null,spine_thickness_cm:number|null,id_confidence,replacement_cost:Price,used_value:Price,quad:Quad,visible_text:string,rare_indicators:string[],excluded:boolean,notes:string[],measurement_method:string}.
Item={id,category,description,brand_model,frame_ref,dimensions_cm:{w:number|null,h:number|null,d:number|null},status:'priced'|'range'|'needs_appraisal'|'unpriced',replacement_cost:{low:number|null,high:number|null,source,url,retrieved_at,currency,converted?:boolean,evidence_ref?:string,notes?:string},confidence,quad:Quad,material:string,art_is_print:boolean,excluded:boolean,notes:string[]}.
Room={length_m:number|null,width_m:number|null,height_m:number|null,floor_area_m2:number|null,wall_area_m2:number|null,shelved_wall_area_m2:number|null,floor_area_sqft:number|null,wall_area_sqft:number|null,scale_method:string,confidence:number,shape:string,evidence_refs:string[],notes:string[]}.
ReviewEntry={ref_id,reason}; Totals as brief exact names plus optional partial flags.
ClaimPacket={sweep:{id,captured_at,device,duration_s,country,currency},room,books,items,totals,review_queue,metrics?,locale_comparison?}.
SweepState={id,captured_at,device,country,currency,room_name,status:'capturing'|'processing'|'complete'|'failed',started_at,ended_at:string|null,appraisal_threshold,second_country,second_currency,frames:FrameRecord[],calibrations:Calibration[],room_input:RoomInput,books:Book[],items:Item[],room:Room,review_queue:ReviewEntry[],transcript:{role,text,at}[],corrections:{text,at,book_id?,item_id?,shelf_id?,action?}[],guidance:string[],errors:string[],metrics:StageMetric[],locale_comparison?:LocaleComparison,packet?:ClaimPacket}.
StageMetric={stage,started_at,duration_ms,model?,input_tokens?,output_tokens?,cached_tokens?,web_search_calls?,estimated_cost_usd:number|null,notes?:string}.
LocaleComparison={country,currency,generated_at,books:{id,title,replacement_cost:Price,used_value:Price}[],notes:string[]}.
RoomInput={floor?:{calibration_id,frame_ref,polygon:Point[]},height?:{calibration_id,frame_ref,points:[Point,Point]},shelving?:{calibration_id,frame_ref,polygon:Point[]}[],known?:{length_m,width_m,height_m,source:string}}.

## Module interfaces

Domain owner exports shared/types.ts + server/domain.ts (`emptyPrice(currency)`, `emptyRoom()`, `computeTotals(books,items)`, `buildPacket(state)`, `buildReviewQueue(state)`), server/measurement.ts (`measureBook(book,calibrations) -> Book`, `measureRoom(input,calibrations) -> Room`), server/report.ts (`renderReport(packet)->string`), scripts/evaluate.ts + evaluation templates, tests domain/measurement/report/evaluate. No package edits. Render report escapes untrusted strings, relative frame links supported by root rewriting.
Pricing owner exports server/pricing.ts `priceBook(book,locale,context)->Promise<{replacement_cost:Price,used_value:Price,needs_appraisal?:boolean,notes:string[]}>`, `priceItem(item,locale,context)->Promise<{replacement_cost:Item['replacement_cost'],status:Item['status'],notes:string[]}>`, where Locale={country,currency,appraisal_threshold:number}, context={saveEvidence:(name:string,data:unknown)=>Promise<string>,onMetric:(metric:StageMetric)=>void,signal?:AbortSignal}. May implement helper modules/tests. Read process.env.OPENAI_API_KEY and OPENAI_PRICING_MODEL (default gpt-6.1-sol); native fetch OpenAI REST. No shared types edits. All price facts verified against fetched public HTML/JSON source and saved. Request timeouts; failure returns null.
Frontend owner client/** only, uses these exact types/API. Need mobile camera+mic WebRTC realtime data channel with captions, barge-in, tool calls record_correction and set_shelf, frame loop ~3 seconds one request in flight, shelf naming transitions, evidence frame browser calibration click 4 corners; room geometry polygon/height/shelving selection, known dimensions fallback; live lines/review, finish downloads, locale reprice, resume saved sessions. Browser entry client/main.tsx, client/styles.css, index.html root owned. No external assets/auth. Use fetch + React only. API state refresh SSE. Realtime input images optional current frame every >=6 sec; send pipeline guidance context during idle. Offline manual mode when no key without fabricated inventory. Do not claim recording exists; optional MediaRecorder with audio mix if implemented.
