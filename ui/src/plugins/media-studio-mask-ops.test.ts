import { describe, expect, it } from "vitest";
import {
  clearMask,
  createMask,
  fillPolygon,
  fillRect,
  hasSelection,
  invertMask,
  maskToBlackWhiteRgba,
  mergeBrightPixels,
  stampCircle,
  strokeLine,
} from "../../../packages/plugins/media-studio/src/ui/mask-ops";

const count = (m: { data: Uint8Array }) => m.data.reduce((a, v) => a + v, 0);

describe("Media Studio selection mask math (DUR-4332)", () => {
  it("starts empty and reports a selection once something is painted", () => {
    const m = createMask(10, 10);
    expect(hasSelection(m)).toBe(false);
    stampCircle(m, 5, 5, 2, 1);
    expect(hasSelection(m)).toBe(true);
  });

  it("brush paints a connected stroke and eraser removes it", () => {
    const m = createMask(40, 10);
    strokeLine(m, 2, 5, 38, 5, 2, 1);
    expect(m.data[5 * 40 + 2]).toBe(1);
    expect(m.data[5 * 40 + 20]).toBe(1);
    expect(m.data[5 * 40 + 37]).toBe(1);
    expect(m.data[0]).toBe(0);
    strokeLine(m, 2, 5, 38, 5, 3, 0);
    expect(hasSelection(m)).toBe(false);
  });

  it("rectangle fills exactly the box, in any corner order", () => {
    const m = createMask(10, 10);
    fillRect(m, 6, 7, 2, 3);
    expect(count(m)).toBe(16);
    expect(m.data[3 * 10 + 2]).toBe(1);
    expect(m.data[6 * 10 + 5]).toBe(1);
    expect(m.data[7 * 10 + 5]).toBe(0);
  });

  it("lasso fills the inside of the outline only", () => {
    const m = createMask(10, 10);
    fillPolygon(m, [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }]);
    expect(m.data[5 * 10 + 5]).toBe(1);
    expect(m.data[1 * 10 + 5]).toBe(0);
    expect(m.data[5 * 10 + 9]).toBe(0);
    expect(count(m)).toBe(36);
  });

  it("invert flips every pixel and clear empties the mask", () => {
    const m = createMask(4, 4);
    fillRect(m, 0, 0, 2, 4);
    invertMask(m);
    expect(count(m)).toBe(8);
    expect(m.data[0]).toBe(0);
    expect(m.data[3]).toBe(1);
    clearMask(m);
    expect(hasSelection(m)).toBe(false);
  });

  it("merges a returned black-and-white picture and exports white for selected", () => {
    const m = createMask(2, 1);
    mergeBrightPixels(m, new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
    expect(Array.from(m.data)).toEqual([1, 0]);
    const rgba = maskToBlackWhiteRgba(m);
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
});
