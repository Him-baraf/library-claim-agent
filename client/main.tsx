import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Book, FrameRecord, Price, SweepState } from "../shared/types";
import { api, measurement, money, post, safeLink } from "./api";
import { MeasurementPanel } from "./MeasurementPanel";
import { connectVoice, type VoiceSession } from "./voice";
import { startDemoRecorder, type DemoRecorder } from "./recorder";
import "./styles.css";
import { assessPixels } from "./quality";
import { browserCaptureAccessIssue, mediaRequestError } from "./media-access";

type Health = {
  openai_configured: boolean;
  models: { vision: string; pricing: string; realtime: string };
  version: string;
};
type SweepSummary = Pick<
  SweepState,
  "id" | "captured_at" | "country" | "currency" | "status"
>;
type Tab = "inventory" | "measurements" | "evidence" | "review" | "performance";
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function PriceView({ value }: { value: Price }) {
  return (
    <div className="price">
      <strong>{money(value.amount, value.currency)}</strong>
      {value.amount != null && (
        <>
          <a href={safeLink(value.url)} target="_blank" rel="noreferrer">
            {value.source || "Price source"} ↗
          </a>
          <small>
            {value.condition_assumed || "Condition unspecified"}
            {value.converted ? " · converted" : ""}
          </small>
          <small>
            {value.retrieved_at
              ? new Date(value.retrieved_at).toLocaleDateString()
              : ""}
          </small>
        </>
      )}
    </div>
  );
}

function Inventory({
  sweep,
  update,
  error,
  showEvidence,
}: {
  sweep: SweepState;
  update: (state: SweepState) => void;
  error: (message: string) => void;
  showEvidence: (ref: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "books" | "items">("all");
  const [saving, setSaving] = useState("");
  async function patch(id: string, changes: unknown) {
    setSaving(id);
    try {
      update(
        await api(`/api/sweeps/${sweep.id}/lines/${id}`, {
          method: "PATCH",
          body: JSON.stringify(changes),
        }),
      );
    } catch (cause) {
      error(messageOf(cause));
    } finally {
      setSaving("");
    }
  }
  const books = sweep.books.filter((book) =>
    `${book.title} ${book.author} ${book.shelf} ${book.id}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const items = sweep.items.filter((item) =>
    `${item.category} ${item.description} ${item.id}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <div>
      <div className="section-heading">
        <div>
          <h2>Live inventory</h2>
          <p>
            Unreadable spines stay unidentified. Missing, excluded, and
            appraisal-only values stay out of financial totals. After
            corrections, use Rebuild valuations to refresh sources.
          </p>
        </div>
        <div className="button-row">
          <select
            aria-label="Item type"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="all">All contents</option>
            <option value="books">Books</option>
            <option value="items">Other contents</option>
          </select>
          <input
            aria-label="Search inventory"
            placeholder="Search title, shelf, or item…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>
      {kind !== "items" && (
        <>
          <h3>Books ({sweep.books.length})</h3>
          {!books.length ? (
            <div className="empty">
              <strong>
                {filter
                  ? "No books match this search"
                  : sweep.status === "complete" || sweep.status === "failed"
                    ? "No books detected in the saved evidence"
                    : sweep.frames.length
                      ? "Recognition is running"
                      : "Your inventory will appear here"}
              </strong>
              <p>
                {filter
                  ? "Clear the search to see the full inventory."
                  : sweep.status === "complete" || sweep.status === "failed"
                    ? "Check the saved frames and review queue. A zero count is not proof that the room contains no books."
                    : "Pan slowly across one labelled shelf at a time. Keep the full spines visible, including horizontal stacks."}
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Book & evidence</th>
                    <th>Spine · cm</th>
                    <th>Replacement</th>
                    <th>Used market</th>
                    <th>Review / correction</th>
                  </tr>
                </thead>
                <tbody>
                  {books.map((book) => (
                    <tr
                      key={book.id}
                      className={book.excluded ? "excluded" : ""}
                    >
                      <td>
                        <span className={`badge ${book.status}`}>
                          {book.excluded
                            ? "Excluded"
                            : book.status.replaceAll("_", " ")}
                        </span>
                        <strong className="line-title">
                          {book.title || "Unidentified book"}
                        </strong>
                        <span>{book.author || "Author not legible"}</span>
                        {book.edition && <small>{book.edition}</small>}
                        <small>
                          {book.shelf} · position {book.position} · ID{" "}
                          {Math.round(book.id_confidence * 100)}%
                        </small>
                        <button
                          className="text-button"
                          onClick={() => showEvidence(book.frame_ref)}
                        >
                          Open saved frame ↗
                        </button>
                      </td>
                      <td>
                        <strong>
                          {measurement(book.spine_height_cm, "high")}
                        </strong>
                        <small>
                          {measurement(book.spine_thickness_cm, "thick")}
                        </small>
                        <small>
                          {book.measurement_method || "No valid scale yet"}
                        </small>
                      </td>
                      <td>
                        <PriceView value={book.replacement_cost} />
                      </td>
                      <td>
                        <PriceView value={book.used_value} />
                      </td>
                      <td>
                        <LineEditor
                          line={book}
                          disabled={
                            sweep.status === "processing" || saving === book.id
                          }
                          save={(changes) => patch(book.id, changes)}
                        />
                        <div className="button-row small">
                          <button
                            className="text-button"
                            disabled={
                              sweep.status === "processing" ||
                              saving === book.id
                            }
                            onClick={() =>
                              patch(book.id, { excluded: !book.excluded })
                            }
                          >
                            {book.excluded ? "Include" : "Exclude"}
                          </button>
                          <button
                            className="text-button"
                            disabled={
                              sweep.status === "processing" ||
                              saving === book.id
                            }
                            onClick={() =>
                              patch(book.id, {
                                status: "needs_appraisal",
                                notes: "Claimant requested human appraisal.",
                              })
                            }
                          >
                            Needs appraisal
                          </button>
                        </div>
                        {book.rare_indicators.length > 0 && (
                          <small className="warning">
                            {book.rare_indicators.join(", ")}
                          </small>
                        )}
                        {book.notes.slice(-2).map((note, index) => (
                          <small key={index}>{note}</small>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {kind !== "books" && (
        <>
          <h3>Non-book contents ({sweep.items.length})</h3>
          {!items.length ? (
            <p className="hint">
              Include shelving, furniture, rugs, art, lighting, electronics, and
              small appliances in your camera pass.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Item & evidence</th>
                    <th>Visible details</th>
                    <th>Replacement cost / range</th>
                    <th>Review / correction</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      className={item.excluded ? "excluded" : ""}
                    >
                      <td>
                        <span className={`badge ${item.status}`}>
                          {item.excluded
                            ? "Excluded"
                            : item.status.replaceAll("_", " ")}
                        </span>
                        <strong className="line-title">{item.category}</strong>
                        <span>{item.description}</span>
                        <button
                          className="text-button"
                          onClick={() => showEvidence(item.frame_ref)}
                        >
                          Open saved frame ↗
                        </button>
                      </td>
                      <td>
                        <span>
                          {item.brand_model || "Brand / model unknown"}
                        </span>
                        <small>{item.material || "Material unknown"}</small>
                        <small>
                          W {measurement(item.dimensions_cm.w, "cm")} · H{" "}
                          {measurement(item.dimensions_cm.h, "cm")} · D{" "}
                          {measurement(item.dimensions_cm.d, "cm")}
                        </small>
                        <small>
                          Confidence {Math.round(item.confidence * 100)}%
                        </small>
                      </td>
                      <td>
                        <strong>
                          {item.replacement_cost.low == null
                            ? "Unknown"
                            : item.replacement_cost.low ===
                                item.replacement_cost.high
                              ? money(item.replacement_cost.low, sweep.currency)
                              : `${money(item.replacement_cost.low, sweep.currency)} – ${money(item.replacement_cost.high, sweep.currency)}`}
                        </strong>
                        {item.replacement_cost.url && (
                          <a
                            href={safeLink(item.replacement_cost.url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.replacement_cost.source || "Price source"} ↗
                          </a>
                        )}
                        <small>
                          {item.replacement_cost.retrieved_at
                            ? new Date(
                                item.replacement_cost.retrieved_at,
                              ).toLocaleDateString()
                            : ""}
                          {item.replacement_cost.converted
                            ? " · converted"
                            : ""}
                        </small>
                      </td>
                      <td>
                        <div className="button-row small">
                          <button
                            className="text-button"
                            disabled={
                              sweep.status === "processing" ||
                              saving === item.id
                            }
                            onClick={() =>
                              patch(item.id, { excluded: !item.excluded })
                            }
                          >
                            {item.excluded ? "Include" : "Exclude"}
                          </button>
                          <button
                            className="text-button"
                            disabled={
                              sweep.status === "processing" ||
                              saving === item.id
                            }
                            onClick={() =>
                              patch(item.id, {
                                status: "needs_appraisal",
                                notes: "Claimant requested human appraisal.",
                              })
                            }
                          >
                            Appraisal
                          </button>
                          {!item.art_is_print &&
                            /art|portrait|painting|picture|print/i.test(
                              `${item.category} ${item.description}`,
                            ) && (
                              <button
                                className="text-button"
                                disabled={
                                  sweep.status === "processing" ||
                                  saving === item.id
                                }
                                onClick={() =>
                                  patch(item.id, {
                                    art_is_print: true,
                                    notes: "Claimant confirms this is a print.",
                                  })
                                }
                              >
                                Confirm it is a print
                              </button>
                            )}
                        </div>
                        {item.art_is_print && (
                          <small>Claimant-confirmed print</small>
                        )}
                        {item.notes.slice(-2).map((note, index) => (
                          <small key={index}>{note}</small>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function LineEditor({
  line,
  disabled,
  save,
}: {
  line: Book;
  disabled: boolean;
  save: (changes: unknown) => void;
}) {
  const [title, setTitle] = useState(line.title);
  const [author, setAuthor] = useState(line.author);
  return (
    <details className="line-editor">
      <summary>Correct identification</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save({
            title: title.trim(),
            author: author.trim(),
            notes:
              "Identification corrected by claimant; not independent visual evidence.",
          });
        }}
      >
        <label>
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Author
          <input
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
          />
        </label>
        <button disabled={disabled}>Save correction</button>
      </form>
    </details>
  );
}

function Evidence({
  sweep,
  selected,
  select,
}: {
  sweep: SweepState;
  selected: string;
  select: (ref: string) => void;
}) {
  const frame =
    sweep.frames.find((record) => record.frame_ref === selected) ||
    sweep.frames.at(-1);
  const books = sweep.books.filter(
    (book) => book.frame_ref === frame?.frame_ref,
  );
  const items = sweep.items.filter(
    (item) => item.frame_ref === frame?.frame_ref,
  );
  return (
    <div>
      <div className="section-heading">
        <div>
          <h2>Saved sweep evidence</h2>
          <p>
            Every inventory line opens one of these persisted frames. Overlays
            are the recognition output, before metric calibration.
          </p>
        </div>
        <span className="badge">{sweep.frames.length} frames saved</span>
      </div>
      {frame ? (
        <div className="two-column evidence-layout">
          <div>
            <div className="frame-marker">
              <img
                src={frame.frame_ref}
                alt={`Evidence frame ${frame.sequence} for ${frame.shelf_id}`}
              />
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {[...books, ...items].map((line) => (
                  <polygon
                    key={line.id}
                    points={line.quad
                      .map((point) => `${point.x * 100},${point.y * 100}`)
                      .join(" ")}
                    className={
                      "title" in line ? "book-outline" : "item-outline"
                    }
                  />
                ))}
              </svg>
            </div>
            <div className="button-row">
              <a href={frame.frame_ref} target="_blank" rel="noreferrer">
                Open original frame ↗
              </a>
              <span>
                {frame.shelf_id} · frame {frame.sequence} ·{" "}
                {new Date(frame.captured_at).toLocaleTimeString()}
              </span>
              <span className={`badge ${frame.analysis_status}`}>
                {frame.analysis_status}
              </span>
            </div>
            {frame.error && <p className="warning">{frame.error}</p>}
            <p className="hint">
              Green = books · blue = other contents. Some lines may use a
              sharper frame from the same shelf instead.
            </p>
            <ul className="compact-list">
              {books.map((book) => (
                <li key={book.id}>
                  {book.title || "Unidentified book"}
                  <small>
                    {book.visible_text || "No legible text"} ·{" "}
                    {Math.round(book.id_confidence * 100)}%
                  </small>
                </li>
              ))}
              {items.map((item) => (
                <li key={item.id}>
                  {item.category}
                  <small>{item.description}</small>
                </li>
              ))}
            </ul>
          </div>
          <div className="frame-grid">
            {sweep.frames.map((record) => (
              <button
                className={`frame-thumb ${record.frame_ref === frame.frame_ref ? "selected" : ""}`}
                key={record.id}
                onClick={() => select(record.frame_ref)}
              >
                <img
                  src={record.frame_ref}
                  alt={`${record.shelf_id} frame ${record.sequence}`}
                  loading="lazy"
                />
                <span>
                  {record.shelf_id} · #{record.sequence}
                </span>
                <small>{record.analysis_status}</small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty">
          No frames yet. Start a sweep and keep the camera moving slowly.
        </div>
      )}
    </div>
  );
}

function App() {
  const captureIssue = browserCaptureAccessIssue();
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<SweepSummary[]>([]);
  const [sweep, setSweep] = useState<SweepState | null>(null);
  const sweepRef = useRef<SweepState | null>(null);
  const [setup, setSetup] = useState({
    room_name: "Home library",
    country: "IN",
    currency: "INR",
    appraisal_threshold: "10000",
    second_country: "US",
    second_currency: "USD",
  });
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("inventory");
  const [capturing, setCapturing] = useState(false);
  const [hasMedia, setHasMedia] = useState(false);
  const [shelf, setShelf] = useState("Shelf 1");
  const shelfRef = useRef("Shelf 1");
  const [shelfDraft, setShelfDraft] = useState("Shelf 1");
  const [voiceStatus, setVoiceStatus] = useState("Voice disconnected");
  const [muted, setMuted] = useState(false);
  const [caption, setCaption] = useState("");
  const captionRef = useRef("");
  const [correction, setCorrection] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [streamStatus, setStreamStatus] = useState("");
  const [recordEnabled, setRecordEnabled] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const recordingStarted = useRef<number | null>(null);
  const [recordingFile, setRecordingFile] = useState<{
    url: string;
    filename: string;
  } | null>(null);
  const [compare, setCompare] = useState({ country: "US", currency: "USD" });
  const video = useRef<HTMLVideoElement>(null);
  const media = useRef<MediaStream | null>(null);
  const voice = useRef<VoiceSession | null>(null);
  const recorder = useRef<DemoRecorder | null>(null);
  const upload = useRef<Promise<void> | null>(null);
  const sequence = useRef(0);
  const lastVoiceImage = useRef(0);
  const previousThumbnail = useRef<{
    shelf: string;
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
  } | null>(null);
  const lastQualityCue = useRef(0);
  const [localCue, setLocalCue] = useState<string | null>(null);
  const live = useRef(false);
  const finalReadback = useRef("");
  const inventoryFingerprint = useRef("");
  const addError = useCallback(
    (message: string) =>
      setErrors((previous) =>
        previous.at(-1) === message
          ? previous
          : [...previous.slice(-5), message],
      ),
    [],
  );
  const update = useCallback((state: SweepState | null) => {
    sweepRef.current = state;
    setSweep(state);
  }, []);
  const chooseShelf = useCallback((id: string) => {
    const value = id.trim().slice(0, 80);
    if (!value) return;
    shelfRef.current = value;
    setShelf(value);
    setShelfDraft(value);
    voice.current?.sayContext(
      `The active shelf label is now ${value}. Treat a shelf label as one physical shelf row; avoid counting the same shelf twice.`,
    );
  }, []);
  async function refreshSessions() {
    try {
      setSessions(await api("/api/sweeps"));
    } catch (cause) {
      addError(messageOf(cause));
    }
  }
  useEffect(() => {
    void api<Health>("/api/health")
      .then(setHealth)
      .catch((cause) => addError(`Server unavailable: ${messageOf(cause)}`));
    void refreshSessions();
    return () => {
      live.current = false;
      voice.current?.close();
      media.current?.getTracks().forEach((track) => track.stop());
      recorder.current?.cleanup();
    };
  }, []);
  useEffect(() => {
    if (video.current && media.current) {
      video.current.srcObject = media.current;
      void video.current
        .play()
        .catch((cause) => addError(`Camera playback: ${messageOf(cause)}`));
    }
  }, [hasMedia, sweep?.id]);
  useEffect(() => {
    if (!sweep?.id) return;
    const source = new EventSource(`/api/sweeps/${sweep.id}/events`);
    source.addEventListener("state", (event) => {
      try {
        update(JSON.parse((event as MessageEvent).data));
        setStreamStatus("Live updates connected");
      } catch {
        addError(
          "An inventory update could not be read. Refresh the saved sweep to reconnect.",
        );
      }
    });
    source.addEventListener("guidance", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        const text = typeof data === "string" ? data : data.text;
        if (text) {
          voice.current?.sayContext(text, true);
        }
      } catch {
        /* future guidance schema */
      }
    });
    source.addEventListener("error", (event) => {
      if ("data" in event && (event as MessageEvent).data) {
        try {
          addError(JSON.parse((event as MessageEvent).data).message);
        } catch {
          /* EventSource network error */
        }
      }
      setStreamStatus("Live updates reconnecting…");
    });
    source.onopen = () => setStreamStatus("Live updates connected");
    return () => source.close();
  }, [sweep?.id, update, addError]);
  useEffect(() => {
    if (!sweep) return;
    if (sweep.status !== "capturing") {
      live.current = false;
      setCapturing(false);
    }
    if (
      sweep.status === "complete" &&
      sweep.packet &&
      finalReadback.current !== sweep.id
    ) {
      finalReadback.current = sweep.id;
      const total = sweep.packet.totals;
      voice.current?.sayContext(
        `The final claim packet is ready. ${total.book_count} books, ${total.books_identified} identified, ${sweep.items.filter((item) => !item.excluded).length} non-book items. Sourced book replacement subtotal ${money(total.books_replacement_cost, sweep.currency)} and used subtotal ${money(total.books_used_value, sweep.currency)}. Floor area ${measurement(sweep.room.floor_area_m2, "square metres")}. ${sweep.review_queue.length} review flags. Unknown prices and appraisal items are excluded; these are partial evidence-based totals. Read back this short summary and tell the claimant the JSON, HTML report and evidence ZIP are ready.`,
        true,
      );
      void refreshSessions();
    }
  }, [sweep]);
  useEffect(() => {
    if (!sweep || !voice.current) return;
    const inventory = {
      shelf_id: shelfRef.current,
      books: sweep.books.map((book) => ({
        id: book.id,
        shelf: book.shelf,
        title: book.title,
        status: book.status,
        excluded: book.excluded,
      })),
      items: sweep.items.map((item) => ({
        id: item.id,
        category: item.category,
        description: item.description,
        status: item.status,
        art_is_print: item.art_is_print,
      })),
    };
    const fingerprint = JSON.stringify(inventory);
    if (inventoryFingerprint.current !== fingerprint) {
      inventoryFingerprint.current = fingerprint;
      voice.current.sayContext(
        `Latest verified inventory with target IDs for corrections: ${fingerprint}. Briefly say what is logged only from this inventory, and ask original versus print for art that is not confirmed.`,
        sweep.status === "capturing",
      );
    }
  }, [sweep]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = sweepRef.current;
      if (current)
        setElapsed(
          Math.max(
            0,
            (new Date(current.ended_at || new Date().toISOString()).getTime() -
              new Date(current.started_at).getTime()) /
              1000,
          ),
        );
      if (recordingStarted.current)
        setRecordingElapsed((Date.now() - recordingStarted.current) / 1000);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function startVoice(state: SweepState) {
    if (!media.current?.getAudioTracks().length)
      throw new Error("Start the camera and microphone first.");
    voice.current?.close();
    voice.current = await connectVoice(state.id, media.current, {
      status: setVoiceStatus,
      error: addError,
      caption(role, text) {
        const value = `${role === "user" ? "You" : "Agent"}: ${text}`;
        captionRef.current = value;
        setCaption(value);
      },
      correction: async (args) => {
        const current = sweepRef.current;
        if (!current) return { error: "No active sweep" };
        const result = await post<SweepState>(
          `/api/sweeps/${current.id}/corrections`,
          args,
        );
        update(result);
        return {
          ok: true,
          message: "Correction saved. Uncertain changes remain in review.",
        };
      },
      shelf: chooseShelf,
      remote: (stream) => recorder.current?.addRemote(stream),
      usage: (event) => {
        const response = (
          event as {
            response?: {
              id?: string;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
          }
        ).response;
        if (response?.usage)
          void post(`/api/sweeps/${state.id}/realtime-usage`, {
            input_tokens: response.usage.input_tokens || 0,
            output_tokens: response.usage.output_tokens || 0,
            response_id: response.id || "",
          }).catch((cause) => addError(messageOf(cause)));
      },
    });
  }
  async function openMedia() {
    const issue = browserCaptureAccessIssue();
    if (issue) throw new Error(issue.message);
    media.current?.getTracks().forEach((track) => track.stop());
    try {
      media.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw new Error(mediaRequestError(error));
    }
    setHasMedia(true);
    if (video.current) {
      video.current.srcObject = media.current;
      await video.current.play();
    }
  }
  async function begin(event?: React.FormEvent, manual = false) {
    event?.preventDefault();
    if (
      !/^[A-Z]{2}$/.test(setup.country) ||
      !/^[A-Z]{3}$/.test(setup.currency)
    ) {
      addError(
        "Use a two-letter country and three-letter currency, for example IN / INR.",
      );
      return;
    }
    setBusy("start");
    setErrors([]);
    try {
      voice.current?.close();
      voice.current = null;
      if (!manual) await openMedia();
      const state = await post<SweepState>("/api/sweeps", {
        ...setup,
        appraisal_threshold: +setup.appraisal_threshold,
        device: manual
          ? "Manual test workspace (not a live sweep)"
          : navigator.userAgent,
      });
      sequence.current = 0;
      finalReadback.current = "";
      inventoryFingerprint.current = "";
      update(state);
      chooseShelf("Shelf 1");
      setCompare({
        country: state.second_country,
        currency: state.second_currency,
      });
      if (recordingFile) URL.revokeObjectURL(recordingFile.url);
      setRecordingFile(null);
      setCaption("");
      captionRef.current = "";
      if (!manual && recordEnabled && video.current && media.current) {
        try {
          recorder.current = startDemoRecorder(
            video.current,
            media.current,
            () => ({
              sweep: sweepRef.current,
              caption: captionRef.current,
              shelf: shelfRef.current,
            }),
          );
          recordingStarted.current = Date.now();
          setRecording(true);
          setRecordingElapsed(0);
        } catch (cause) {
          addError(
            `Recording unavailable: ${messageOf(cause)} Live capture can continue.`,
          );
        }
      }
      if (!manual) {
        live.current = true;
        setCapturing(true);
        if (health?.openai_configured) {
          try {
            await startVoice(state);
          } catch (cause) {
            setVoiceStatus("Voice disconnected");
            addError(`Voice: ${messageOf(cause)} Camera capture continues.`);
          }
        } else setVoiceStatus("No API key · evidence capture only");
      }
      void refreshSessions();
    } catch (cause) {
      addError(messageOf(cause));
      if (!sweepRef.current) {
        media.current?.getTracks().forEach((track) => track.stop());
        setHasMedia(false);
      }
    } finally {
      setBusy("");
    }
  }
  const takeFrame = useCallback(async () => {
    if (upload.current) {
      await upload.current.catch(() => undefined);
      return;
    }
    const state = sweepRef.current;
    const element = video.current;
    if (
      !state ||
      state.status !== "capturing" ||
      !element ||
      element.readyState < 2 ||
      !element.videoWidth
    )
      return;
    const work = (async () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(
        1,
        1920 / Math.max(element.videoWidth, element.videoHeight),
      );
      canvas.width = Math.round(element.videoWidth * scale);
      canvas.height = Math.round(element.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Camera frame could not be rendered.");
      ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
      const thumbnail = document.createElement("canvas");
      const thumbRatio = 160 / Math.max(canvas.width, canvas.height);
      thumbnail.width = Math.max(3, Math.round(canvas.width * thumbRatio));
      thumbnail.height = Math.max(3, Math.round(canvas.height * thumbRatio));
      const thumbContext = thumbnail.getContext("2d", {
        willReadFrequently: true,
      });
      if (thumbContext) {
        thumbContext.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
        const pixels = thumbContext.getImageData(
          0,
          0,
          thumbnail.width,
          thumbnail.height,
        ).data;
        const before = previousThumbnail.current;
        const sameView =
          before?.shelf === shelfRef.current &&
          before.width === thumbnail.width &&
          before.height === thumbnail.height;
        const quality = assessPixels(
          pixels,
          thumbnail.width,
          thumbnail.height,
          sameView ? before.pixels : undefined,
        );
        previousThumbnail.current = {
          shelf: shelfRef.current,
          width: thumbnail.width,
          height: thumbnail.height,
          pixels,
        };
        setLocalCue(quality.cue);
        if (
          quality.cue &&
          Date.now() - lastQualityCue.current > 12000 &&
          /shelf|book|row/i.test(shelfRef.current)
        ) {
          lastQualityCue.current = Date.now();
          voice.current?.sayContext(
            `Local capture heuristic, not an OCR result: ${quality.cue}`,
            true,
          );
        }
      }
      const image = canvas.toDataURL("image/jpeg", 0.9);
      const record = await post<FrameRecord>(`/api/sweeps/${state.id}/frames`, {
        image,
        width: canvas.width,
        height: canvas.height,
        shelf_id: shelfRef.current,
        sequence: ++sequence.current,
        captured_at: new Date().toISOString(),
      });
      const current = sweepRef.current;
      if (
        current?.id === state.id &&
        !current.frames.some((frame) => frame.id === record.id)
      )
        update({ ...current, frames: [...current.frames, record] });
      if (Date.now() - lastVoiceImage.current > 8000 && voice.current) {
        lastVoiceImage.current = Date.now();
        const small = document.createElement("canvas");
        const ratio = 512 / Math.max(canvas.width, canvas.height);
        small.width = Math.round(canvas.width * ratio);
        small.height = Math.round(canvas.height * ratio);
        small
          .getContext("2d")
          ?.drawImage(canvas, 0, 0, small.width, small.height);
        voice.current.image(small.toDataURL("image/jpeg", 0.55));
      }
    })();
    upload.current = work;
    try {
      await work;
    } catch (cause) {
      addError(`Frame capture: ${messageOf(cause)}`);
    } finally {
      upload.current = null;
    }
  }, [update, addError]);
  useEffect(() => {
    if (!capturing) return;
    void takeFrame();
    const timer = window.setInterval(() => {
      if (live.current) void takeFrame();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [capturing, takeFrame]);

  async function finish() {
    if (!sweep) return;
    setBusy("finish");
    live.current = false;
    setCapturing(false);
    try {
      if (upload.current) await upload.current;
      await takeFrame();
      update(await post(`/api/sweeps/${sweep.id}/finish`));
      voice.current?.sayContext(
        "The continuous capture has ended. Background identification, sourced pricing and review are now finishing. Explain that the claimant can mark known reference planes on saved frames while pricing finishes, without another camera pass. Do not claim any unknown totals.",
        true,
      );
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function rebuildValuations() {
    if (!sweep || sweep.status === "processing") return;
    setBusy("rebuild");
    finalReadback.current = "";
    try {
      update(await post(`/api/sweeps/${sweep.id}/finish`, { recompute: true }));
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function saveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (!sweep || !correction.trim()) return;
    if (sweep.status === "processing") {
      addError("Wait for finalization before changing evidence.");
      return;
    }
    setBusy("correction");
    try {
      update(
        await post(`/api/sweeps/${sweep.id}/corrections`, {
          text: correction.trim(),
          shelf_id: shelfRef.current,
          action: "note",
        }),
      );
      voice.current?.sayContext(
        `Claimant typed this correction: ${correction}. It is saved to the review record. Ask for clarification if a particular item is ambiguous.`,
      );
      setCorrection("");
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function resume(id: string) {
    if (!id) return;
    setBusy("resume");
    live.current = false;
    setCapturing(false);
    voice.current?.close();
    voice.current = null;
    setVoiceStatus("Voice disconnected");
    try {
      const state = await api<SweepState>(`/api/sweeps/${id}`);
      update(state);
      sequence.current = Math.max(
        0,
        ...state.frames.map((frame) => frame.sequence),
      );
      setCompare({
        country: state.second_country,
        currency: state.second_currency,
      });
      setTab("inventory");
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function continueCapture() {
    if (!sweep || sweep.status !== "capturing") return;
    setBusy("resume-media");
    try {
      await openMedia();
      live.current = true;
      setCapturing(true);
      if (health?.openai_configured) await startVoice(sweep);
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function uploadTestFrame(file: File | undefined) {
    if (!file || !sweep || sweep.status !== "capturing") return;
    if (!file.type.startsWith("image/")) {
      addError("Choose an image for this test frame.");
      return;
    }
    setBusy("test-frame");
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Image canvas unavailable.");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      await post(`/api/sweeps/${sweep.id}/frames`, {
        image: canvas.toDataURL("image/jpeg", 0.9),
        width: canvas.width,
        height: canvas.height,
        shelf_id: shelfRef.current,
        sequence: ++sequence.current,
        captured_at: new Date().toISOString(),
      });
      update(await api(`/api/sweeps/${sweep.id}`));
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function stopRecording() {
    if (!recorder.current) return;
    setBusy("recording");
    try {
      setRecordingFile(await recorder.current.stop());
      recorder.current = null;
      recordingStarted.current = null;
      setRecording(false);
    } catch (cause) {
      addError(messageOf(cause));
      setRecording(false);
      recorder.current = null;
    } finally {
      setBusy("");
    }
  }
  async function reprice(event: React.FormEvent) {
    event.preventDefault();
    if (!sweep) return;
    setBusy("reprice");
    try {
      update(await post(`/api/sweeps/${sweep.id}/reprice`, compare));
    } catch (cause) {
      addError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  function showEvidence(ref: string) {
    setSelectedEvidence(ref);
    setTab("evidence");
    window.setTimeout(
      () =>
        document
          .getElementById("workspace")
          ?.scrollIntoView({ behavior: "smooth" }),
      0,
    );
  }
  const totals = sweep?.packet?.totals;
  const knownCost =
    sweep?.metrics.reduce(
      (total, metric) => total + (metric.estimated_cost_usd || 0),
      0,
    ) || 0;
  const costsPartial =
    sweep?.metrics.some((metric) => metric.estimated_cost_usd == null) ?? true;
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          LC
        </div>
        <div>
          <h1>Library Claim</h1>
          <p>Live evidence. Measured contents. Sourced values.</p>
        </div>
        <div className="header-status">
          <span
            className={`status-dot ${health?.openai_configured ? "online" : ""}`}
          />
          {health
            ? health.openai_configured
              ? "OpenAI ready"
              : "API key required for AI"
            : "Connecting to server…"}
        </div>
      </header>
      <main>
        {!hasMedia && captureIssue && (
          <div className="error-stack" role="status">
            <div>
              <span>
                <strong>Camera setup needed. </strong>
                {captureIssue.message} Open this address directly in your
                browser: <code>{window.location.origin}/</code>
              </span>
            </div>
          </div>
        )}
        {errors.length > 0 && (
          <div className="error-stack" role="alert">
            {errors.map((error, index) => (
              <div key={`${index}-${error}`}>
                <span>{error}</span>
                <button
                  className="text-button"
                  aria-label="Dismiss error"
                  onClick={() =>
                    setErrors((previous) =>
                      previous.filter((_, item) => item !== index),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {!sweep ? (
          <section className="setup-layout">
            <div className="intro">
              <span className="eyebrow">Contents claim intake</span>
              <h2>
                One room.
                <br />
                One continuous sweep.
              </h2>
              <p>
                Walk slowly across every shelf, then include furniture, floor,
                and walls. Speak naturally—the agent will ask for clearer views
                and build an inventory while you move.
              </p>
              <ol className="instructions">
                <li>
                  Use good light. Keep spines in focus and pause briefly on each
                  shelf row.
                </li>
                <li>
                  Label each new shelf. Include the full spine of flat and
                  stacked books.
                </li>
                <li>
                  Keep a known rectangular reference in view for metric
                  measurements, or provide dimensions you already know.
                </li>
                <li>
                  End the sweep, mark scale on saved frames, then download the
                  claim packet.
                </li>
              </ol>
              <p className="hint">
                Do not capture people or personal documents. Capture only a
                space you have permission to document. The assignment’s
                real-room accuracy needs your own ground truth; this app does
                not generate it.
              </p>
              <details>
                <summary>Phone connection and browser requirements</summary>
                <p>
                  On this computer, open the app directly in Chrome or Safari.
                  An embedded preview may not expose camera or microphone
                  access, even at localhost. Open the HTTPS URL from the README
                  on your phone. Camera and microphone work on HTTPS or
                  localhost; a plain HTTP LAN address will not work. Allow
                  camera, microphone, and audio playback. Keep this tab in the
                  foreground.
                </p>
              </details>
            </div>
            <form className="panel setup-form" onSubmit={begin}>
              <h2>Set up your sweep</h2>
              <label>
                Room name
                <input
                  value={setup.room_name}
                  onChange={(event) =>
                    setSetup((previous) => ({
                      ...previous,
                      room_name: event.target.value,
                    }))
                  }
                  required
                  maxLength={100}
                />
              </label>
              <div className="form-grid">
                <label>
                  Country (ISO code)
                  <input
                    value={setup.country}
                    onChange={(event) =>
                      setSetup((previous) => ({
                        ...previous,
                        country: event.target.value.toUpperCase(),
                      }))
                    }
                    maxLength={2}
                    pattern="[A-Z]{2}"
                    required
                  />
                </label>
                <label>
                  Currency
                  <input
                    value={setup.currency}
                    onChange={(event) =>
                      setSetup((previous) => ({
                        ...previous,
                        currency: event.target.value.toUpperCase(),
                      }))
                    }
                    maxLength={3}
                    pattern="[A-Z]{3}"
                    required
                  />
                </label>
              </div>
              <label>
                Human appraisal threshold ({setup.currency})
                <input
                  type="number"
                  min="1"
                  value={setup.appraisal_threshold}
                  onChange={(event) =>
                    setSetup((previous) => ({
                      ...previous,
                      appraisal_threshold: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <details>
                <summary>Second country comparison</summary>
                <p className="hint">
                  The same first ten eligible books will be priced for this
                  setting.
                </p>
                <div className="form-grid">
                  <label>
                    Country
                    <input
                      maxLength={2}
                      value={setup.second_country}
                      onChange={(event) =>
                        setSetup((previous) => ({
                          ...previous,
                          second_country: event.target.value.toUpperCase(),
                        }))
                      }
                    />
                  </label>
                  <label>
                    Currency
                    <input
                      maxLength={3}
                      value={setup.second_currency}
                      onChange={(event) =>
                        setSetup((previous) => ({
                          ...previous,
                          second_currency: event.target.value.toUpperCase(),
                        }))
                      }
                    />
                  </label>
                </div>
              </details>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={recordEnabled}
                  onChange={(event) => setRecordEnabled(event.target.checked)}
                />
                <span>
                  Record a continuous demo locally
                  <small>
                    Camera, live inventory, captions, microphone, and agent
                    audio. Keep recording through the final readback, then
                    download it.
                  </small>
                </span>
              </label>
              {health && !health.openai_configured && (
                <p className="notice">
                  Set OPENAI_API_KEY in the server’s .env and restart for live
                  voice, recognition, and pricing. Capture-only mode saves
                  evidence without inventing an inventory.
                </p>
              )}
              <button className="primary large" disabled={!!busy || !health}>
                {busy === "start" ? "Opening camera…" : "Start camera & sweep"}
              </button>
              {!captureIssue && (
                <p className="hint" role="status">
                  This browser supports camera capture. Starting the sweep will
                  request camera and microphone permission.
                </p>
              )}
              <button
                type="button"
                className="text-button"
                disabled={!!busy || !health}
                onClick={() => void begin(undefined, true)}
              >
                Create a test workspace without camera
              </button>
              {sessions.length > 0 && (
                <label className="resume-label">
                  Open a saved sweep
                  <select
                    value=""
                    onChange={(event) => void resume(event.target.value)}
                    disabled={!!busy}
                  >
                    <option value="">Choose a previous sweep…</option>
                    {sessions.map((item) => (
                      <option value={item.id} key={item.id}>
                        {new Date(item.captured_at).toLocaleString()} ·{" "}
                        {item.country}/{item.currency} · {item.status}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </form>
          </section>
        ) : (
          <>
            <section className="sweep-heading">
              <div>
                <span className="eyebrow">
                  {sweep.country} / {sweep.currency} ·{" "}
                  {new Date(sweep.captured_at).toLocaleString()}
                </span>
                <h2>{sweep.room_name || "Library sweep"}</h2>
                <div className="button-row">
                  <span className={`badge ${sweep.status}`}>
                    {sweep.status}
                  </span>
                  <span>
                    {duration(elapsed)} capture time
                    {elapsed > 180 && sweep.status === "capturing"
                      ? " · aim for under 3 minutes"
                      : ""}
                  </span>
                  <span className="hint">{streamStatus}</span>
                </div>
              </div>
              <div className="button-row">
                {sweep.status === "capturing" && !capturing && (
                  <button onClick={continueCapture} disabled={!!busy}>
                    Resume camera & voice
                  </button>
                )}
                {sweep.status === "capturing" && (
                  <button
                    className="primary"
                    onClick={finish}
                    disabled={!!busy}
                  >
                    {busy === "finish"
                      ? "Ending capture…"
                      : "End sweep & prepare packet"}
                  </button>
                )}
                {sweep.status === "processing" && (
                  <span className="hint">
                    Final downloads appear when the packet is ready.
                  </span>
                )}
                {["complete", "failed"].includes(sweep.status) && (
                  <div className="downloads">
                    <a
                      className="button secondary"
                      href={`/api/sweeps/${sweep.id}/packet`}
                      download="claim_packet.json"
                    >
                      JSON
                    </a>
                    <a
                      className="button secondary"
                      href={`/api/sweeps/${sweep.id}/report`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Readable report ↗
                    </a>
                    <a
                      className="button primary"
                      href={`/api/sweeps/${sweep.id}/bundle`}
                    >
                      Evidence ZIP
                    </a>
                    <button
                      className="secondary"
                      disabled={!!busy}
                      onClick={rebuildValuations}
                    >
                      {busy === "rebuild"
                        ? "Rebuilding…"
                        : "Rebuild valuations"}
                    </button>
                  </div>
                )}
              </div>
            </section>
            <div className="capture-layout">
              <section className="panel capture-panel">
                <div className="camera">
                  <video
                    ref={video}
                    autoPlay
                    playsInline
                    muted
                    aria-label="Live camera preview"
                  />
                  {!hasMedia && (
                    <div className="camera-placeholder">
                      <strong>Camera not connected</strong>
                      <span>
                        {sweep.status === "capturing"
                          ? "Resume capture or inspect the saved evidence below."
                          : "Review the saved sweep evidence below."}
                      </span>
                    </div>
                  )}
                  <div className="camera-top">
                    <span className={`camera-pill ${capturing ? "live" : ""}`}>
                      {capturing
                        ? "● LIVE SWEEP"
                        : sweep.status === "processing"
                          ? "FINISHING PACKET"
                          : "SAVED WORKSPACE"}
                    </span>
                    <span className="camera-pill">{shelf}</span>
                    {recording && (
                      <span className="camera-pill recording">
                        ● REC {duration(recordingElapsed)}
                      </span>
                    )}
                  </div>
                  <div className="camera-caption" aria-live="polite">
                    {caption ||
                      (capturing
                        ? "Speak to the agent or type a correction below."
                        : "Camera frames and claims are saved on your server.")}
                  </div>
                </div>
                <div className="capture-controls">
                  {!hasMedia && sweep.status === "capturing" && (
                    <div className="notice">
                      <label>
                        Upload a test frame (optional engineering check)
                        <input
                          type="file"
                          accept="image/*"
                          disabled={!!busy}
                          onChange={(event) => {
                            void uploadTestFrame(event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                      </label>
                      <span>
                        A file-upload workspace is not a live one-sweep demo.
                        Start or resume camera capture for the assignment.
                      </span>
                    </div>
                  )}
                  <form
                    className="shelf-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      chooseShelf(shelfDraft);
                    }}
                  >
                    <label>
                      Current physical shelf row
                      <input
                        value={shelfDraft}
                        onChange={(event) => setShelfDraft(event.target.value)}
                        maxLength={80}
                      />
                    </label>
                    <button
                      className="secondary"
                      disabled={sweep.status !== "capturing"}
                    >
                      Set label
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={sweep.status !== "capturing"}
                      onClick={() => {
                        const next =
                          (Number(shelf.match(/(\d+)$/)?.[1]) ||
                            new Set(sweep.frames.map((frame) => frame.shelf_id))
                              .size) + 1;
                        chooseShelf(`Shelf ${next}`);
                      }}
                    >
                      Next shelf →
                    </button>
                  </form>
                  <p className="hint">
                    One label per physical shelf row. Change the label before
                    showing a new row; keep it when revisiting the same row. For
                    floor and wall views, use a descriptive label.
                  </p>
                  <div className="button-row">
                    <span className="voice-status">{voiceStatus}</span>
                    {hasMedia && (
                      <>
                        <button
                          className="text-button"
                          onClick={() => {
                            const value = !muted;
                            setMuted(value);
                            voice.current?.mute(value);
                            media.current?.getAudioTracks().forEach((track) => {
                              track.enabled = !value;
                            });
                          }}
                        >
                          {muted ? "Unmute mic" : "Mute mic"}
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void voice.current
                              ?.replay()
                              .catch((cause) => addError(messageOf(cause)))
                          }
                        >
                          Enable speaker
                        </button>
                        {health?.openai_configured && (
                          <button
                            className="text-button"
                            disabled={!!busy}
                            onClick={() => {
                              setBusy("voice");
                              void startVoice(sweep)
                                .catch((cause) => addError(messageOf(cause)))
                                .finally(() => setBusy(""));
                            }}
                          >
                            Reconnect voice
                          </button>
                        )}
                      </>
                    )}
                    {capturing && (
                      <button
                        className="text-button"
                        onClick={() => void takeFrame()}
                      >
                        Save current view
                      </button>
                    )}
                  </div>
                  {recording && (
                    <div className="recording-controls">
                      <span>
                        Continuous demo recording{" "}
                        {recordingElapsed > 360
                          ? "· over the 6-minute submission limit"
                          : "· keep running through summary"}
                      </span>
                      <button
                        className="secondary"
                        disabled={busy === "recording"}
                        onClick={stopRecording}
                      >
                        Stop & save demo
                      </button>
                    </div>
                  )}
                  {recordingFile && (
                    <a
                      className="button secondary"
                      href={recordingFile.url}
                      download={recordingFile.filename}
                    >
                      Download unedited demo video (
                      {recordingFile.filename.endsWith("mp4") ? "MP4" : "WebM"})
                    </a>
                  )}
                  <form className="correction-form" onSubmit={saveCorrection}>
                    <label>
                      Typed correction or capture note
                      <input
                        value={correction}
                        onChange={(event) => setCorrection(event.target.value)}
                        placeholder="e.g. “Shelf 2 is not mine” or “the portrait is a print”"
                        maxLength={2000}
                      />
                    </label>
                    <button
                      disabled={
                        busy === "correction" ||
                        !correction.trim() ||
                        sweep.status === "processing"
                      }
                    >
                      Save note
                    </button>
                  </form>
                  <p className="hint">
                    Typed notes are preserved for review. Apply a specific line
                    change in the inventory, or tell the voice agent which item
                    you mean.
                  </p>
                </div>
              </section>
              <aside className="capture-summary">
                <div className="panel">
                  <h3>Building the claim file</h3>
                  <div className="stat-grid">
                    <div>
                      <strong>
                        {sweep.books.filter((book) => !book.excluded).length}
                      </strong>
                      <span>Books logged</span>
                    </div>
                    <div>
                      <strong>
                        {
                          sweep.books.filter(
                            (book) =>
                              !book.excluded && book.status === "identified",
                          ).length
                        }
                      </strong>
                      <span>Identified</span>
                    </div>
                    <div>
                      <strong>
                        {sweep.items.filter((item) => !item.excluded).length}
                      </strong>
                      <span>Other contents</span>
                    </div>
                    <div>
                      <strong>{sweep.frames.length}</strong>
                      <span>Saved frames</span>
                    </div>
                  </div>
                  <div className="progress-detail">
                    <span>
                      {
                        sweep.frames.filter(
                          (frame) => frame.analysis_status === "done",
                        ).length
                      }{" "}
                      analysed
                    </span>
                    <span>
                      {
                        sweep.frames.filter((frame) =>
                          ["queued", "processing"].includes(
                            frame.analysis_status,
                          ),
                        ).length
                      }{" "}
                      waiting
                    </span>
                    <span>
                      {
                        sweep.frames.filter(
                          (frame) => frame.analysis_status === "failed",
                        ).length
                      }{" "}
                      failed
                    </span>
                  </div>
                  {sweep.status === "processing" && (
                    <p className="notice">
                      <span className="spinner" /> Background agents are
                      finishing identification, source checks, measurement, and
                      review. The packet updates as results arrive.
                    </p>
                  )}
                  {sweep.status === "complete" && (
                    <p className="notice success">
                      Packet ready. Check review flags and the measured accuracy
                      against your ground truth before submission.
                    </p>
                  )}
                </div>
                <div className="panel">
                  <h3>Capture guidance</h3>
                  {localCue && (
                    <p className="notice">
                      <strong>Local frame cue:</strong> {localCue}
                      <small>
                        Fast pixel heuristic; does not assess title correctness.
                      </small>
                    </p>
                  )}
                  {sweep.guidance.length ? (
                    <ul className="guidance-list">
                      {sweep.guidance
                        .slice(-4)
                        .reverse()
                        .map((text, index) => (
                          <li key={`${index}-${text}`}>{text}</li>
                        ))}
                    </ul>
                  ) : (
                    <p>
                      Hold each shelf steady, keep spines large in frame, and
                      pan with overlap. The agent will ask for a closer view
                      when evidence is unclear.
                    </p>
                  )}
                  <p className="hint">
                    Agent feedback is based on sampled frames. Hidden shelves
                    and unreadable items cannot be guaranteed detected.
                  </p>
                </div>
                <div className="panel">
                  <h3>Evidence-based values</h3>
                  {totals ? (
                    <dl className="total-list">
                      <div>
                        <dt>Books replacement</dt>
                        <dd>
                          {money(totals.books_replacement_cost, sweep.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>Books used market</dt>
                        <dd>
                          {money(totals.books_used_value, sweep.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>Other contents</dt>
                        <dd>
                          {money(
                            totals.items_replacement_cost_low,
                            sweep.currency,
                          )}{" "}
                          –{" "}
                          {money(
                            totals.items_replacement_cost_high,
                            sweep.currency,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          Shelf run
                          {totals.shelf_run_partial ? " (partial)" : ""}
                        </dt>
                        <dd>{measurement(totals.shelf_run_m, "m")}</dd>
                      </div>
                      <div>
                        <dt>Excluded lines / missing values</dt>
                        <dd>{totals.excluded_from_totals}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="hint">
                      Line prices appear as their sources are verified. Final
                      totals are computed from eligible lines when the packet is
                      built.
                    </p>
                  )}
                  <button
                    className="text-button"
                    onClick={() => setTab("review")}
                  >
                    {sweep.review_queue.length} review flags →
                  </button>
                </div>
              </aside>
            </div>
            <section className="panel workspace" id="workspace">
              <nav className="tabs" aria-label="Claim workspace">
                {(
                  [
                    ["inventory", "Inventory"],
                    ["measurements", "Measurement"],
                    ["evidence", "Evidence frames"],
                    ["review", `Review (${sweep.review_queue.length})`],
                    ["performance", "Sources & performance"],
                  ] as [Tab, string][]
                ).map(([value, title]) => (
                  <button
                    className={tab === value ? "selected" : ""}
                    onClick={() => setTab(value)}
                    key={value}
                  >
                    {title}
                  </button>
                ))}
              </nav>
              <div className="workspace-content">
                {tab === "inventory" && (
                  <Inventory
                    sweep={sweep}
                    update={update}
                    error={addError}
                    showEvidence={showEvidence}
                  />
                )}
                {tab === "measurements" && (
                  <MeasurementPanel
                    sweep={sweep}
                    update={update}
                    error={addError}
                  />
                )}
                {tab === "evidence" && (
                  <Evidence
                    sweep={sweep}
                    selected={selectedEvidence}
                    select={setSelectedEvidence}
                  />
                )}
                {tab === "review" && (
                  <>
                    <div className="section-heading">
                      <div>
                        <h2>Adjuster review queue</h2>
                        <p>
                          Every unresolved fact stays explicit. A blank field is
                          preferable to an unsupported claim.
                        </p>
                      </div>
                    </div>
                    {!sweep.review_queue.length ? (
                      <p className="hint">
                        No review flags have been produced yet. Capture and
                        source checks may still be running.
                      </p>
                    ) : (
                      <ul className="review-list">
                        {sweep.review_queue.map((entry, index) => {
                          const line =
                            sweep.books.find(
                              (book) => book.id === entry.ref_id,
                            ) ||
                            sweep.items.find(
                              (item) => item.id === entry.ref_id,
                            );
                          return (
                            <li key={`${entry.ref_id}-${index}`}>
                              <div>
                                <code>{entry.ref_id}</code>
                                <strong>
                                  {line &&
                                    ("title" in line
                                      ? line.title || "Unidentified book"
                                      : line.category)}
                                </strong>
                                <p>{entry.reason}</p>
                              </div>
                              {line && (
                                <button
                                  className="secondary"
                                  onClick={() => showEvidence(line.frame_ref)}
                                >
                                  Evidence ↗
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <h3>Claimant corrections ({sweep.corrections.length})</h3>
                    {sweep.corrections.map((entry, index) => (
                      <div className="correction-note" key={index}>
                        <small>
                          {new Date(entry.at).toLocaleTimeString()} ·{" "}
                          {entry.shelf_id ||
                            entry.book_id ||
                            entry.item_id ||
                            "sweep"}
                        </small>
                        <p>{entry.text}</p>
                      </div>
                    ))}
                    {sweep.errors.length > 0 && (
                      <>
                        <h3>Pipeline failures</h3>
                        <ul className="warning">
                          {sweep.errors.map((text, index) => (
                            <li key={index}>{text}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
                {tab === "performance" && (
                  <>
                    <div className="section-heading">
                      <div>
                        <h2>Latency, cost, and locality</h2>
                        <p>
                          Stage outputs, saved price-source evidence, and
                          transcripts are included in the evidence ZIP.
                        </p>
                      </div>
                      <span className="badge">
                        {money(knownCost, "USD")}
                        {costsPartial
                          ? " known estimate · partial"
                          : " estimated"}
                      </span>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Stage</th>
                            <th>Model</th>
                            <th>Latency</th>
                            <th>Tokens in / out</th>
                            <th>Estimated USD</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sweep.metrics.map((metric, index) => (
                            <tr key={index}>
                              <td>
                                {metric.stage}
                                <small>{metric.notes}</small>
                              </td>
                              <td>{metric.model || "Code"}</td>
                              <td>
                                {(metric.duration_ms / 1000).toFixed(2)} s
                              </td>
                              <td>
                                {metric.input_tokens ?? "—"} /{" "}
                                {metric.output_tokens ?? "—"}
                              </td>
                              <td>
                                {metric.estimated_cost_usd == null
                                  ? "Unpriced / unknown"
                                  : money(metric.estimated_cost_usd, "USD")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="hint">
                      Estimates depend on configured model rates and
                      provider-reported usage; unknown charges remain unknown.
                      Check the provider dashboard for billed cost.
                    </p>
                    <h3>Same ten books, another country</h3>
                    <form className="locale-form" onSubmit={reprice}>
                      <label>
                        Country (ISO)
                        <input
                          value={compare.country}
                          maxLength={2}
                          pattern="[A-Z]{2}"
                          required
                          onChange={(event) =>
                            setCompare((previous) => ({
                              ...previous,
                              country: event.target.value.toUpperCase(),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Currency
                        <input
                          value={compare.currency}
                          maxLength={3}
                          pattern="[A-Z]{3}"
                          required
                          onChange={(event) =>
                            setCompare((previous) => ({
                              ...previous,
                              currency: event.target.value.toUpperCase(),
                            }))
                          }
                        />
                      </label>
                      <button
                        disabled={
                          busy === "reprice" || sweep.status === "processing"
                        }
                      >
                        {busy === "reprice"
                          ? "Finding sources…"
                          : "Price comparison"}
                      </button>
                    </form>
                    <p className="hint">
                      Alternate-locale values never replace primary claim
                      totals. Fewer than ten eligible identified books will
                      produce a shorter, explicitly incomplete comparison.
                    </p>
                    {sweep.locale_comparison && (
                      <>
                        <p>
                          {sweep.locale_comparison.country} /{" "}
                          {sweep.locale_comparison.currency} ·{" "}
                          {new Date(
                            sweep.locale_comparison.generated_at,
                          ).toLocaleString()}
                        </p>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Book</th>
                                <th>Replacement</th>
                                <th>Used</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sweep.locale_comparison.books.map((book) => (
                                <tr key={book.id}>
                                  <td>{book.title}</td>
                                  <td>
                                    <PriceView value={book.replacement_cost} />
                                  </td>
                                  <td>
                                    <PriceView value={book.used_value} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <ul className="hint">
                          {sweep.locale_comparison.notes.map((note, index) => (
                            <li key={index}>{note}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    <h3>Conversation transcript</h3>
                    <div className="transcript">
                      {sweep.transcript.map((entry, index) => (
                        <div className={entry.role} key={index}>
                          <strong>
                            {entry.role === "user" ? "Claimant" : "Agent"}
                          </strong>
                          <span>{entry.text}</span>
                          <small>
                            {new Date(entry.at).toLocaleTimeString()}
                          </small>
                        </div>
                      ))}
                      {!sweep.transcript.length && (
                        <p className="hint">
                          Final voice captions appear here once a turn is
                          transcribed.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>
            <div className="session-controls">
              <span className="hint">Sweep {sweep.id}</span>
              <button
                className="text-button"
                disabled={
                  capturing || recording || sweep.status === "processing"
                }
                onClick={() => {
                  voice.current?.close();
                  voice.current = null;
                  media.current?.getTracks().forEach((track) => track.stop());
                  media.current = null;
                  setHasMedia(false);
                  update(null);
                  setCaption("");
                  setVoiceStatus("Voice disconnected");
                }}
              >
                New sweep
              </button>
              {sessions.length > 1 && (
                <select
                  aria-label="Open another saved sweep"
                  value=""
                  disabled={
                    capturing || recording || sweep.status === "processing"
                  }
                  onChange={(event) => void resume(event.target.value)}
                >
                  <option value="">Other saved sweeps…</option>
                  {sessions
                    .filter((item) => item.id !== sweep.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {new Date(item.captured_at).toLocaleString()} ·{" "}
                        {item.country}/{item.currency}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </>
        )}
        <video
          ref={!sweep ? video : undefined}
          className="setup-video"
          autoPlay
          muted
          playsInline
          aria-hidden="true"
        />
      </main>
      <footer>
        Library Claim Agent · model output is evidence to review ·{" "}
        {health?.version || "local workspace"}
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
