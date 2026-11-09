import { PROVIDER_FEATURES, WEFT_RDNS } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import { EXPERIMENTAL, FEATURES, PRODUCT_NAME, PRODUCT_RDNS } from "./experimental";

// Unit tests run the normal build. The e2e tests load both builds (e2e/tests/experimental.spec.ts).
describe("the build switch, in the normal build", () => {
  it("is off", () => {
    expect(EXPERIMENTAL).toBe(false);
    expect(PRODUCT_NAME).toBe("Weft");
    expect(PRODUCT_RDNS).toBe(WEFT_RDNS);
  });

  it("offers exactly the main product's features", () => {
    expect(FEATURES).toEqual(["receipts"]);
    expect(FEATURES).toBe(PROVIDER_FEATURES);
  });
});
