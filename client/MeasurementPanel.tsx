import { useEffect, useRef, useState } from "react";
import type {
  Calibration,
  Point,
  Quad,
  RoomInput,
  SweepState,
} from "../shared/types";
import { measurement, post } from "./api";

type Mode = "calibration" | "floor" | "height" | "shelving";
type Props = {
  sweep: SweepState;
  update: (state: SweepState) => void;
  error: (message: string) => void;
};
export function MeasurementPanel({ sweep, update, error }: Props) {
  const [frameRef, setFrameRef] = useState("");
  const [mode, setMode] = useState<Mode>("calibration");
  const [plane, setPlane] = useState<Calibration["plane"]>("shelf");
  const [points, setPoints] = useState<Point[]>([]);
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [calibrationId, setCalibrationId] = useState("");
  const [saving, setSaving] = useState(false);
  const [known, setKnown] = useState({
    length_m: "",
    width_m: "",
    height_m: "",
    source: "",
  });
  const image = useRef<HTMLImageElement>(null);
  const frame = sweep.frames.find((record) => record.frame_ref === frameRef);
  const compatible = sweep.calibrations.filter(
    (calibration) =>
      calibration.frame_ref === frameRef &&
      (mode === "floor"
        ? calibration.plane === "floor"
        : mode === "calibration" || calibration.plane === "wall"),
  );
  const calibration =
    compatible.find((record) => record.id === calibrationId) || compatible[0];
  useEffect(() => {
    if (!frameRef && sweep.frames.length)
      setFrameRef(sweep.frames[0].frame_ref);
  }, [sweep.frames, frameRef]);
  useEffect(() => {
    setPoints([]);
    setCalibrationId("");
  }, [frameRef, mode]);
  const prompt =
    mode === "calibration"
      ? `Click four corners of one known ${plane} rectangle: top-left → top-right → bottom-right → bottom-left.`
      : mode === "floor"
        ? "Click every floor boundary corner in order. The full polygon must be visible within the floor calibration."
        : mode === "height"
          ? "Click the bottom and top of the same vertical wall line, inside its wall calibration."
          : "Click each corner of the shelving coverage on a calibrated wall, in boundary order.";
  function addPoint(event: React.MouseEvent<HTMLDivElement>) {
    if (!image.current || !frame) return;
    const rect = image.current.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    if (
      (mode === "calibration" && points.length >= 4) ||
      (mode === "height" && points.length >= 2)
    )
      return;
    setPoints((previous) => [...previous, point]);
  }
  async function save() {
    if (!frame) return;
    setSaving(true);
    try {
      let state: SweepState;
      if (mode === "calibration") {
        if (
          points.length !== 4 ||
          !Number.isFinite(+width) ||
          +width <= 0 ||
          !Number.isFinite(+height) ||
          +height <= 0
        )
          throw new Error(
            "Enter positive known dimensions and mark exactly four corners.",
          );
        state = await post(`/api/sweeps/${sweep.id}/calibrations`, {
          frame_ref: frameRef,
          plane,
          shelf_id: frame.shelf_id,
          width_cm: +width,
          height_cm: +height,
          quad: points as Quad,
        });
      } else {
        if (!calibration)
          throw new Error(
            `Save a ${mode === "floor" ? "floor" : "wall"} calibration on this exact frame first.`,
          );
        if (points.length < (mode === "height" ? 2 : 3))
          throw new Error(
            mode === "height"
              ? "Mark both endpoints."
              : "Mark at least three polygon corners.",
          );
        const input: RoomInput = { ...sweep.room_input };
        if (mode === "floor")
          input.floor = {
            frame_ref: frameRef,
            calibration_id: calibration.id,
            polygon: points,
          };
        if (mode === "height")
          input.height = {
            frame_ref: frameRef,
            calibration_id: calibration.id,
            points: points as [Point, Point],
          };
        if (mode === "shelving")
          input.shelving = [
            ...(input.shelving || []),
            {
              frame_ref: frameRef,
              calibration_id: calibration.id,
              polygon: points,
            },
          ];
        state = await post(`/api/sweeps/${sweep.id}/room`, input);
      }
      update(state);
      setPoints([]);
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  async function saveKnown(event: React.FormEvent) {
    event.preventDefault();
    if (
      ![known.length_m, known.width_m, known.height_m].every(
        (value) => Number.isFinite(+value) && +value > 0,
      ) ||
      !known.source.trim()
    ) {
      error("Enter all three positive dimensions and their source.");
      return;
    }
    setSaving(true);
    try {
      update(
        await post(`/api/sweeps/${sweep.id}/room`, {
          ...sweep.room_input,
          known: {
            length_m: +known.length_m,
            width_m: +known.width_m,
            height_m: +known.height_m,
            source: known.source.trim(),
          },
        }),
      );
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="measurement-panel">
      <div className="section-heading">
        <div>
          <h2>Measurements from saved evidence</h2>
          <p>
            Reference dimensions come from you. Geometry is computed in code;
            scale never transfers between frames.
          </p>
        </div>
      </div>
      <div className="room-stats">
        <div>
          <span>Floor</span>
          <strong>{measurement(sweep.room.floor_area_m2, "m²")}</strong>
          <small>{measurement(sweep.room.floor_area_sqft, "ft²")}</small>
        </div>
        <div>
          <span>Total walls</span>
          <strong>{measurement(sweep.room.wall_area_m2, "m²")}</strong>
          <small>{measurement(sweep.room.wall_area_sqft, "ft²")}</small>
        </div>
        <div>
          <span>Shelved walls</span>
          <strong>{measurement(sweep.room.shelved_wall_area_m2, "m²")}</strong>
          <small>Reported separately</small>
        </div>
        <div>
          <span>Length × width × height</span>
          <strong className="smaller">
            {[sweep.room.length_m, sweep.room.width_m, sweep.room.height_m]
              .map((value) => (value == null ? "?" : value.toFixed(2)))
              .join(" × ")}{" "}
            m
          </strong>
          <small>{sweep.room.shape || "Shape unknown"}</small>
        </div>
      </div>
      {sweep.room.scale_method && (
        <p className="notice">{sweep.room.scale_method}</p>
      )}
      {sweep.status === "processing" && (
        <p className="notice">
          Mark saved references while pricing finishes. Measurement changes use
          the original sweep frames and update the claim geometry.
        </p>
      )}
      <div className="two-column">
        <div className="panel inset">
          <label>
            Saved sweep frame
            <select
              value={frameRef}
              onChange={(event) => setFrameRef(event.target.value)}
              disabled={!sweep.frames.length}
            >
              <option value="">Choose a frame…</option>
              {sweep.frames.map((record) => (
                <option key={record.id} value={record.frame_ref}>
                  {record.shelf_id} · frame {record.sequence} ·{" "}
                  {record.analysis_status}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row mode-buttons">
            {(["calibration", "floor", "height", "shelving"] as Mode[]).map(
              (value) => (
                <button
                  className={mode === value ? "active" : "secondary"}
                  key={value}
                  onClick={() => setMode(value)}
                >
                  {value === "calibration"
                    ? "1. Reference plane"
                    : value === "floor"
                      ? "2. Floor boundary"
                      : value === "height"
                        ? "3. Ceiling height"
                        : "4. Shelving area"}
                </button>
              ),
            )}
          </div>
          {mode === "calibration" ? (
            <div className="form-grid three">
              <label>
                Plane
                <select
                  value={plane}
                  onChange={(event) =>
                    setPlane(event.target.value as Calibration["plane"])
                  }
                >
                  <option value="shelf">Book spines / shelf</option>
                  <option value="floor">Floor</option>
                  <option value="wall">Wall</option>
                </select>
              </label>
              <label>
                Known width (cm)
                <input
                  type="number"
                  min="0.1"
                  step="any"
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                  placeholder="e.g. measured shelf"
                />
              </label>
              <label>
                Known height (cm)
                <input
                  type="number"
                  min="0.1"
                  step="any"
                  value={height}
                  onChange={(event) => setHeight(event.target.value)}
                />
              </label>
            </div>
          ) : (
            <label>
              Same-frame {mode === "floor" ? "floor" : "wall"} calibration
              <select
                value={calibration?.id || ""}
                onChange={(event) => setCalibrationId(event.target.value)}
              >
                <option value="">Choose a calibration…</option>
                {compatible.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.plane} · {record.width_cm} × {record.height_cm} cm ·{" "}
                    {record.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="hint">{prompt}</p>
          {frame ? (
            <div
              className="frame-marker"
              onClick={addPoint}
              role="group"
              aria-label="Click to mark normalized points in saved frame"
            >
              <img
                ref={image}
                src={frameRef}
                alt={`Saved evidence: ${frame.shelf_id}, frame ${frame.sequence}`}
                draggable={false}
              />
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {sweep.books
                  .filter((book) => book.frame_ref === frameRef)
                  .map((book) => (
                    <polygon
                      key={book.id}
                      points={book.quad
                        .map((point) => `${point.x * 100},${point.y * 100}`)
                        .join(" ")}
                      className="book-outline"
                    />
                  ))}
                {compatible.map((record) => (
                  <polygon
                    key={record.id}
                    points={record.quad
                      .map((point) => `${point.x * 100},${point.y * 100}`)
                      .join(" ")}
                    className="calibration-outline"
                  />
                ))}
                {points.length > 1 &&
                  (mode === "height" ? (
                    <polyline
                      points={points
                        .map((point) => `${point.x * 100},${point.y * 100}`)
                        .join(" ")}
                      className="selected-outline"
                    />
                  ) : (
                    <polygon
                      points={points
                        .map((point) => `${point.x * 100},${point.y * 100}`)
                        .join(" ")}
                      className="selected-outline"
                    />
                  ))}
                {points.map((point, index) => (
                  <g key={index}>
                    <circle cx={point.x * 100} cy={point.y * 100} r="1.1" />
                    <text x={point.x * 100 + 1.5} y={point.y * 100 - 1.5}>
                      {index + 1}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          ) : (
            <div className="empty">
              Saved frames will appear during the sweep.
            </div>
          )}
          <div className="button-row">
            <button
              onClick={save}
              disabled={
                saving || !frame || !points.length
              }
            >
              {saving
                ? "Saving…"
                : mode === "calibration"
                  ? "Save reference plane"
                  : "Save geometry"}
            </button>
            <button
              className="secondary"
              onClick={() => setPoints((previous) => previous.slice(0, -1))}
              disabled={!points.length}
            >
              Undo point
            </button>
            <button
              className="text-button"
              onClick={() => setPoints([])}
              disabled={!points.length}
            >
              Clear points
            </button>
            <span className="hint">{points.length} points</span>
          </div>
        </div>
        <div className="panel inset">
          <h3>How to provide valid scale</h3>
          <ol className="instructions">
            <li>
              During the continuous sweep, hold steady on a shelf front and a
              known rectangular boundary. Keep all measured spines inside it.
            </li>
            <li>
              For the floor, capture the room boundary and a known rectangle on
              the same flat floor plane. A partial room cannot yield a complete
              area.
            </li>
            <li>
              For ceiling height and shelving coverage, use a known wall
              rectangle in that wall’s plane. Repeat for other walls as needed.
            </li>
            <li>
              Mark the saved frames here, without a second camera pass.
              Perspective is corrected with a homography.
            </li>
          </ol>
          <p className="hint">
            References and targets must be coplanar. A book farther forward than
            the calibrated shelf front introduces error. Occluded corners, lens
            distortion, and uncertain reference measurements remain review
            risks.
          </p>
          <details>
            <summary>Use dimensions already known by the claimant</summary>
            <p className="hint">
              Optional fallback for a rectangular room. This is explicitly
              reported as user-supplied, with the source you provide. Do not
              type visual estimates.
            </p>
            <form onSubmit={saveKnown}>
              <div className="form-grid three">
                {(["length_m", "width_m", "height_m"] as const).map((field) => (
                  <label key={field}>
                    {field.replace("_m", "")} (m)
                    <input
                      type="number"
                      min="0.1"
                      step="any"
                      value={known[field]}
                      onChange={(event) =>
                        setKnown((previous) => ({
                          ...previous,
                          [field]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <label>
                Measurement source
                <input
                  value={known.source}
                  onChange={(event) =>
                    setKnown((previous) => ({
                      ...previous,
                      source: event.target.value,
                    }))
                  }
                  placeholder="e.g. existing tape survey, date"
                />
              </label>
              <button disabled={saving}>
                Save known room dimensions
              </button>
            </form>
          </details>
          <h3>Saved references ({sweep.calibrations.length})</h3>
          {!sweep.calibrations.length ? (
            <p className="hint">
              No scale reference yet. Spine and room dimensions will remain
              unknown.
            </p>
          ) : (
            <ul className="compact-list">
              {sweep.calibrations.map((record) => (
                <li key={record.id}>
                  <button
                    className="text-button"
                    onClick={() => {
                      setFrameRef(record.frame_ref);
                      setMode("calibration");
                      setPlane(record.plane);
                    }}
                  >
                    {record.plane} · {record.width_cm} × {record.height_cm} cm
                  </button>
                  <small>
                    {
                      sweep.frames.find(
                        (value) => value.frame_ref === record.frame_ref,
                      )?.shelf_id
                    }
                  </small>
                </li>
              ))}
            </ul>
          )}
          {sweep.room.notes.length > 0 && (
            <ul className="hint">
              {sweep.room.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
