import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const env = { WEFT_PEER_ENDPOINT: "localhost:7051" };

describe("relay config, experimental switches (docs/adr/0009)", () => {
  it("is off by default, with no idemix MSPs", () => {
    const config = loadConfig(env);
    expect(config.experimental).toBe(false);
    expect(config.idemixMspIds).toEqual([]);
  });

  it("reads WEFT_IDEMIX_MSP_IDS when started with WEFT_EXPERIMENTAL=1", () => {
    const config = loadConfig({ ...env, WEFT_EXPERIMENTAL: "1", WEFT_IDEMIX_MSP_IDS: "ChairVoters2027MSP, ChairVoters2028MSP" });
    expect(config.experimental).toBe(true);
    expect(config.idemixMspIds).toEqual(["ChairVoters2027MSP", "ChairVoters2028MSP"]);
  });

  it("treats any value other than 1 as off", () => {
    expect(loadConfig({ ...env, WEFT_EXPERIMENTAL: "true" }).experimental).toBe(false);
  });

  it("refuses idemix MSPs without WEFT_EXPERIMENTAL=1", () => {
    expect(() => loadConfig({ ...env, WEFT_IDEMIX_MSP_IDS: "ChairVoters2027MSP" })).toThrow(/WEFT_IDEMIX_MSP_IDS is set, but/);
  });
});
