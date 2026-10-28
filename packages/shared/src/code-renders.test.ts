import { describe, expect, it } from "vitest";
import { estimateCompositionSeconds } from "./code-renders.js";

describe("estimateCompositionSeconds", () => {
  it("reads the latest end of any timed element and skips commented-out ones", () => {
    const html =
      '<!-- <div data-duration="900"></div> --><div data-composition-id="main" data-duration="8"></div>' +
      "<div data-start='2' data-duration=6.5s></div>";
    expect(estimateCompositionSeconds(html)).toBe(8.5);
  });

  // Entries are agent-supplied and up to 5,000,000 characters, and the server
  // reads them on its main thread before any cap check.
  it("reads multi-MB hostile entries in linear time", () => {
    const tail = '<div data-composition-id="main" data-duration="7"></div>';
    for (const junk of ["<a ".repeat(1_500_000), "<a b=".repeat(1_000_000), "<!--".repeat(1_200_000)]) {
      const started = Date.now();
      expect(estimateCompositionSeconds(junk + tail)).toBe(7);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });
});
