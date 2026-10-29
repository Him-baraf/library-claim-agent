import { describe, expect, it } from "vitest";
import {
  makeProjector,
  measureBook,
  measureRoom,
  validatePolygon,
} from "../server/measurement.js";
import type { Calibration, Quad } from "../shared/types.js";
import { book, quad } from "./domain-fixtures.js";
const cal = (override: Partial<Calibration> = {}): Calibration => ({
  id: "c1",
  frame_ref: "/evidence/s1/frames/f1.jpg",
  plane: "shelf",
  shelf_id: "shelf-one",
  width_cm: 100,
  height_cm: 100,
  quad,
  ...override,
});

describe("metric scale from bounded same-frame homographies", () => {
  it("measures a spine from a metric plane, including intrinsic orientation for a flat book", () => {
    const q: Quad = [
      { x: 0.1, y: 0.1 },
      { x: 0.13, y: 0.1 },
      { x: 0.13, y: 0.4 },
      { x: 0.1, y: 0.4 },
    ];
    const upright = measureBook(book({ quad: q }), [cal()]);
    expect(upright.spine_height_cm).toBe(30);
    expect(upright.spine_thickness_cm).toBe(3);
    const horizontal: Quad = [
      { x: 0.4, y: 0.1 },
      { x: 0.4, y: 0.13 },
      { x: 0.1, y: 0.13 },
      { x: 0.1, y: 0.1 },
    ];
    const flat = measureBook(book({ quad: horizontal }), [cal()]);
    expect(flat.spine_height_cm).toBe(30);
    expect(flat.spine_thickness_cm).toBe(3);
  });
  it("rectifies a perspective rectangle and maps corners to known metric coordinates", () => {
    const q: Quad = [
      { x: 0.15, y: 0.1 },
      { x: 0.8, y: 0.2 },
      { x: 0.9, y: 0.9 },
      { x: 0.05, y: 0.8 },
    ];
    const p = makeProjector(cal({ quad: q, width_cm: 120, height_cm: 80 }));
    expect(p(q[0]).x).toBeCloseTo(0);
    expect(p(q[2]).x).toBeCloseTo(120);
    expect(p(q[2]).y).toBeCloseTo(80);
  });
  it("never transfers scale between frames, shelves, or beyond calibration boundaries", () => {
    expect(
      measureBook(book(), [cal({ frame_ref: "/other.jpg" })]).spine_height_cm,
    ).toBeNull();
    expect(
      measureBook(book(), [cal({ shelf_id: "other" })]).spine_height_cm,
    ).toBeNull();
    const tiny: Quad = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];
    expect(
      measureBook(book(), [cal({ quad: tiny })]).spine_height_cm,
    ).toBeNull();
    expect(() =>
      makeProjector(cal({ quad: tiny }))({ x: 0.1, y: 0.1 }),
    ).toThrow(/outside/);
  });
  it("rejects crossed, concave, duplicate, nonfinite, and nearly degenerate calibration", () => {
    expect(() =>
      makeProjector(cal({ quad: [quad[0], quad[2], quad[1], quad[3]] })),
    ).toThrow();
    expect(() => makeProjector(cal({ width_cm: NaN }))).toThrow();
    expect(() =>
      validatePolygon([quad[0], quad[1], quad[1], quad[3]]),
    ).toThrow();
    expect(() =>
      makeProjector(
        cal({
          quad: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1e-8 },
            { x: 0, y: 1e-8 },
          ],
        }),
      ),
    ).toThrow();
  });
  it("uses polygon shoelace area and perimeter times independently calibrated ceiling height", () => {
    const floorCal = cal({
      id: "floor",
      plane: "floor",
      width_cm: 400,
      height_cm: 300,
    });
    const wallCal = cal({
      id: "wall",
      plane: "wall",
      width_cm: 400,
      height_cm: 250,
    });
    const room = measureRoom(
      {
        floor: {
          calibration_id: "floor",
          frame_ref: floorCal.frame_ref,
          polygon: quad,
        },
        height: {
          calibration_id: "wall",
          frame_ref: wallCal.frame_ref,
          points: [quad[0], quad[3]],
        },
        shelving: [
          {
            calibration_id: "wall",
            frame_ref: wallCal.frame_ref,
            polygon: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0 },
              { x: 0.5, y: 1 },
              { x: 0, y: 1 },
            ],
          },
        ],
      },
      [floorCal, wallCal],
    );
    expect(room.floor_area_m2).toBe(12);
    expect(room.wall_area_m2).toBe(35);
    expect(room.height_m).toBe(2.5);
    expect(room.shelved_wall_area_m2).toBe(5);
    expect(room.floor_area_sqft).toBeCloseTo(129.1669);
  });
  it("handles an L shape and explicitly records user supplied room assumptions", () => {
    const p = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 1 },
      { x: 0, y: 1 },
    ];
    const floorCal = cal({ plane: "floor", width_cm: 400, height_cm: 400 });
    const room = measureRoom(
      {
        floor: {
          calibration_id: floorCal.id,
          frame_ref: floorCal.frame_ref,
          polygon: p,
        },
        known: {
          length_m: 4,
          width_m: 4,
          height_m: 3,
          source: "Tape measure, user confirmed during sweep",
        },
      },
      [floorCal],
    );
    expect(room.floor_area_m2).toBe(12);
    expect(room.wall_area_m2).toBe(48);
    expect(room.shape).toContain("6-vertex");
    expect(room.notes.join(" ")).toContain("user supplied");
  });
  it("does not invent room measurements without scale or allow overlapping shelving", () => {
    expect(measureRoom({}, []).floor_area_m2).toBeNull();
    const wall = cal({ plane: "wall" });
    const s = {
      calibration_id: wall.id,
      frame_ref: wall.frame_ref,
      polygon: quad,
    };
    const room = measureRoom({ shelving: [s, s] }, [wall]);
    expect(room.shelved_wall_area_m2).toBeNull();
    expect(room.notes.join(" ")).toContain("overlap");
  });
});
