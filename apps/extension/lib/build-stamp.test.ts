/**
 * The popup compares its own build stamp with the background's, and says so
 * only when they differ.
 */
import { describe, expect, it } from "vitest";
import { BUILD_DIFFERENCE_MESSAGE, builtLabel, compareBuilds } from "./build-stamp";

const earlier = "2026-11-09T10:00:00.000Z";
const later = "2026-11-09T10:05:30.000Z";

describe("compareBuilds", () => {
  it("is quiet when both run the same build", () => {
    expect(compareBuilds(later, later)).toBeNull();
  });

  it("says the background is older when it was built before the window", () => {
    expect(compareBuilds(later, earlier)).toBe("background-older");
  });

  it("says the window is older when the background was built after it", () => {
    expect(compareBuilds(earlier, later)).toBe("window-older");
  });

  it("counts a background with no stamp as older", () => {
    expect(compareBuilds(later, null)).toBe("background-older");
  });

  it("is quiet when the window has no stamp to compare", () => {
    expect(compareBuilds(null, later)).toBeNull();
    expect(compareBuilds(null, null)).toBeNull();
  });

  it("counts stamps that differ and can't be read as times as an older background", () => {
    expect(compareBuilds("not a time", later)).toBe("background-older");
  });

  it("has the popup's wording for an older background", () => {
    expect(BUILD_DIFFERENCE_MESSAGE["background-older"]).toBe(
      "Weft's background is older than this window, so they run different code. Reload Weft in your browser's extensions page.",
    );
  });
});

describe("builtLabel", () => {
  it("gives the date and time to the second", () => {
    expect(builtLabel(later)).toMatch(/^Built 9 Nov 2026, \d\d:\d\d:30$/);
  });

  it("says when there's no stamp", () => {
    expect(builtLabel(null)).toBe("Built before Weft recorded build times");
  });
});
