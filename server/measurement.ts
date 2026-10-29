import type {
  Book,
  Calibration,
  Item,
  Point,
  Quad,
  Room,
  RoomInput,
} from "../shared/types.js";
import { emptyRoom } from "./domain.js";

const EPS = 1e-9;
const round = (n: number, places = 4) => Number(n.toFixed(places));
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const polygonArea = (p: Point[]) =>
  Math.abs(
    p.reduce((s, a, i) => {
      const b = p[(i + 1) % p.length]!;
      return s + a.x * b.y - b.x * a.y;
    }, 0),
  ) / 2;
const onSegment = (a: Point, b: Point, c: Point) =>
  Math.abs(cross(a, b, c)) < EPS &&
  c.x >= Math.min(a.x, b.x) - EPS &&
  c.x <= Math.max(a.x, b.x) + EPS &&
  c.y >= Math.min(a.y, b.y) - EPS &&
  c.y <= Math.max(a.y, b.y) + EPS;
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const v = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
  return (
    (v[0]! * v[1]! < -EPS && v[2]! * v[3]! < -EPS) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
export function validatePolygon(p: Point[], normalized = true): void {
  if (p.length < 3 || p.length > 100)
    throw new Error("Polygon requires 3–100 points.");
  if (
    p.some(
      (a) =>
        !Number.isFinite(a.x) ||
        !Number.isFinite(a.y) ||
        (normalized && (a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1)),
    )
  )
    throw new Error(
      "Image coordinates must be finite and normalized to [0,1].",
    );
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++)
      if (distance(p[i]!, p[j]!) < EPS)
        throw new Error("Polygon contains duplicate vertices.");
    const a = p[i]!,
      b = p[(i + 1) % p.length]!;
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || (i === 0 && j === p.length - 1)) continue;
      if (intersects(a, b, p[j]!, p[(j + 1) % p.length]!))
        throw new Error("Polygon crosses itself.");
    }
  }
  if (polygonArea(p) < (normalized ? 1e-6 : EPS))
    throw new Error("Polygon area is too small for a stable measurement.");
}
function validateQuad(quad: Quad): void {
  validatePolygon(quad);
  const turns = quad.map((p, i) =>
    cross(p, quad[(i + 1) % 4]!, quad[(i + 2) % 4]!),
  );
  if (turns.some((v) => v < 1e-6))
    throw new Error(
      "Quad must be a convex TL,TR,BR,BL plane; avoid nearly collinear corners.",
    );
}
function solve(a: number[][], b: number[]): number[] {
  const m = a.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < b.length; c++) {
    let best = c;
    for (let r = c + 1; r < b.length; r++)
      if (Math.abs(m[r]![c]!) > Math.abs(m[best]![c]!)) best = r;
    if (Math.abs(m[best]![c]!) < 1e-9)
      throw new Error(
        "Calibration is numerically unstable; choose a larger, less oblique rectangle.",
      );
    [m[c], m[best]] = [m[best]!, m[c]!];
    const divisor = m[c]![c]!;
    for (let k = c; k <= b.length; k++) m[c]![k] = m[c]![k]! / divisor;
    for (let r = 0; r < b.length; r++)
      if (r !== c) {
        const multiplier = m[r]![c]!;
        for (let k = c; k <= b.length; k++)
          m[r]![k] = m[r]![k]! - multiplier * m[c]![k]!;
      }
  }
  return m.map((r) => r[b.length]!);
}
export function makeProjector(cal: Calibration): (p: Point) => Point {
  validateQuad(cal.quad);
  if (
    ![cal.width_cm, cal.height_cm].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 100_000,
    )
  )
    throw new Error(
      "Calibration dimensions must be positive, finite centimetres.",
    );
  const target: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const a: number[][] = [],
    b: number[] = [];
  cal.quad.forEach((p, i) => {
    const q = target[i]!;
    a.push(
      [p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y],
      [0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y],
    );
    b.push(q.x, q.y);
  });
  const h = solve(a, b);
  return (p) => {
    if (!insidePlane(p, cal.quad))
      throw new Error(
        "Point lies outside calibrated plane; extrapolation is disabled.",
      );
    const d = h[6]! * p.x + h[7]! * p.y + 1;
    if (Math.abs(d) < 1e-8)
      throw new Error(
        "Projective horizon is too close for stable measurement.",
      );
    const result = {
      x: ((h[0]! * p.x + h[1]! * p.y + h[2]!) / d) * cal.width_cm,
      y: ((h[3]! * p.x + h[4]! * p.y + h[5]!) / d) * cal.height_cm,
    };
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y))
      throw new Error("Projection produced non-finite coordinates.");
    return result;
  };
}
export function insidePlane(p: Point, quad: Quad): boolean {
  return quad.every((a, i) => cross(a, quad[(i + 1) % 4]!, p) >= -EPS);
}
function dimensions(
  quad: Quad,
  calibration: Calibration,
): { w: number; h: number } {
  validateQuad(quad);
  const project = makeProjector(calibration),
    p = quad.map(project);
  return {
    w: round((distance(p[0]!, p[1]!) + distance(p[3]!, p[2]!)) / 2, 2),
    h: round((distance(p[0]!, p[3]!) + distance(p[1]!, p[2]!)) / 2, 2),
  };
}
export function measureBook(book: Book, calibrations: Calibration[]): Book {
  const result = {
    ...book,
    spine_height_cm: null as number | null,
    spine_thickness_cm: null as number | null,
    measurement_method: "",
  };
  for (const cal of calibrations.filter(
    (c) =>
      c.plane === "shelf" &&
      c.frame_ref === book.frame_ref &&
      (!c.shelf_id || c.shelf_id === book.shelf),
  )) {
    try {
      const dim = dimensions(book.quad, cal);
      result.spine_height_cm = dim.h;
      result.spine_thickness_cm = dim.w;
      result.measurement_method = `Projective homography from user supplied ${cal.width_cm} × ${cal.height_cm} cm coplanar rectangle; calibration ${cal.id}; intrinsic spine quad`;
      break;
    } catch {
      /* An unsuitable calibration must never lend scale to another plane. */
    }
  }
  return result;
}
export function measureItem(item: Item, calibrations: Calibration[]): Item {
  const result: Item = {
    ...item,
    dimensions_cm: { w: null, h: null, d: null },
  };
  for (const cal of calibrations.filter(
    (c) => c.frame_ref === item.frame_ref && c.plane === "wall",
  )) {
    try {
      const d = dimensions(item.quad, cal);
      result.dimensions_cm = { w: d.w, h: d.h, d: null };
      break;
    } catch {
      /* Unknown is preferable to out-of-plane scale. */
    }
  }
  return result;
}
function calibrated(
  input: { calibration_id: string; frame_ref: string },
  cals: Calibration[],
  plane: Calibration["plane"],
): Calibration {
  const c = cals.find(
    (c) =>
      c.id === input.calibration_id &&
      c.frame_ref === input.frame_ref &&
      c.plane === plane,
  );
  if (!c)
    throw new Error(
      `Missing ${plane} calibration from the same evidence frame.`,
    );
  return c;
}
function projectedPolygon(
  input: { calibration_id: string; frame_ref: string; polygon: Point[] },
  cals: Calibration[],
  plane: Calibration["plane"],
): Point[] {
  validatePolygon(input.polygon);
  const points = input.polygon.map(
    makeProjector(calibrated(input, cals, plane)),
  );
  validatePolygon(points, false);
  return points;
}
function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (onSegment(a, b, p)) return true;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      yes = !yes;
  }
  return yes;
}
function overlaps(a: Point[], b: Point[]): boolean {
  return (
    a.some((p) => pointInPolygon(p, b)) ||
    b.some((p) => pointInPolygon(p, a)) ||
    a.some((p, i) =>
      b.some((q, j) =>
        intersects(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!),
      ),
    )
  );
}
export function measureRoom(
  input: RoomInput,
  calibrations: Calibration[],
): Room {
  const room = emptyRoom();
  let perimeter: number | null = null;
  if (input.known) {
    const k = input.known;
    if (
      ![k.length_m, k.width_m, k.height_m].every(
        (n) => Number.isFinite(n) && n > 0 && n < 1000,
      ) ||
      !k.source.trim()
    )
      room.notes.push(
        "Known room dimensions rejected: positive dimensions and a source are required.",
      );
    else {
      room.length_m = k.length_m;
      room.width_m = k.width_m;
      room.height_m = k.height_m;
      room.floor_area_m2 = round(k.length_m * k.width_m);
      perimeter = 2 * (k.length_m + k.width_m);
      room.shape = "rectangle (user supplied assumption)";
      room.scale_method = `User supplied room dimensions: ${k.source}`;
      room.confidence = 0.7;
      room.notes.push(
        "Room dimensions are user supplied, not independently recovered from video. Rectangular footprint and uniform ceiling height assumed.",
      );
    }
  }
  if (input.floor) {
    try {
      const p = projectedPolygon(input.floor, calibrations, "floor");
      room.floor_area_m2 = round(polygonArea(p) / 10_000);
      perimeter =
        p.reduce((sum, a, i) => sum + distance(a, p[(i + 1) % p.length]!), 0) /
        100;
      const rectangular =
        p.length === 4 &&
        p.every((a, i) => {
          const b = p[(i + 1) % 4]!,
            c = p[(i + 2) % 4]!;
          const dot = (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y);
          return Math.abs(dot) / (distance(a, b) * distance(b, c)) < 0.02;
        });
      room.shape = rectangular
        ? "rectangle from calibrated floor polygon"
        : `simple ${p.length}-vertex polygon; length/width are extents along calibration axes`;
      room.length_m = round(
        (rectangular
          ? distance(p[0]!, p[1]!)
          : Math.max(...p.map((a) => a.x)) - Math.min(...p.map((a) => a.x))) /
          100,
      );
      room.width_m = round(
        (rectangular
          ? distance(p[1]!, p[2]!)
          : Math.max(...p.map((a) => a.y)) - Math.min(...p.map((a) => a.y))) /
          100,
      );
      room.scale_method = `User supplied coplanar metric rectangles and projective homographies; floor calibration ${input.floor.calibration_id}`;
      room.evidence_refs.push(input.floor.frame_ref);
      room.confidence = 0.65;
      room.notes.push(
        "Floor area uses the complete boundary polygon; wall area uses its perimeter × uniform ceiling height. No door/window deductions.",
      );
    } catch (error) {
      room.notes.push(
        `Floor measurement unavailable: ${(error as Error).message}`,
      );
    }
  }
  if (input.height) {
    try {
      const cal = calibrated(input.height, calibrations, "wall"),
        project = makeProjector(cal);
      const [a, b] = input.height.points.map(project);
      const value = distance(a!, b!) / 100;
      if (value < 0.1 || value > 100)
        throw new Error("Ceiling-height segment is outside plausible bounds.");
      room.height_m = round(value);
      room.evidence_refs.push(input.height.frame_ref);
      room.scale_method += `${room.scale_method ? "; " : ""}ceiling height calibration ${cal.id}`;
    } catch (error) {
      room.notes.push(
        `Ceiling height unavailable: ${(error as Error).message}`,
      );
    }
  }
  if (perimeter !== null && room.height_m !== null)
    room.wall_area_m2 = round(perimeter * room.height_m);
  if (input.shelving?.length) {
    try {
      const seen: {
        frame_ref: string;
        calibration_id: string;
        polygon: Point[];
      }[] = [];
      let area = 0;
      for (const s of input.shelving) {
        if (
          seen.some(
            (prev) =>
              prev.frame_ref === s.frame_ref &&
              overlaps(prev.polygon, s.polygon),
          )
        )
          throw new Error(
            "Shelving polygons overlap in a frame; draw disjoint regions to prevent double counting.",
          );
        const p = projectedPolygon(s, calibrations, "wall");
        area += polygonArea(p) / 10_000;
        seen.push(s);
        room.evidence_refs.push(s.frame_ref);
      }
      room.shelved_wall_area_m2 = round(area);
      room.notes.push(
        "Shelving polygons must represent distinct physical regions; repeated views of one wall must not be submitted twice.",
      );
    } catch (error) {
      room.notes.push(
        `Shelved wall area unavailable: ${(error as Error).message}`,
      );
    }
  }
  room.floor_area_sqft =
    room.floor_area_m2 === null
      ? null
      : round(room.floor_area_m2 * 10.7639104167);
  room.wall_area_sqft =
    room.wall_area_m2 === null
      ? null
      : round(room.wall_area_m2 * 10.7639104167);
  room.evidence_refs = [...new Set(room.evidence_refs)];
  if (room.floor_area_m2 === null || room.wall_area_m2 === null)
    room.notes.push(
      "Complete room surface area requires both a measured floor boundary and ceiling height, or explicitly supplied dimensions.",
    );
  return room;
}
