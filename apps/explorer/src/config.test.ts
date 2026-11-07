import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { domain } from "@weftwallet/brand/products";
import { loadConfig, parseProductAddresses, productAddress, PUBLIC_PRODUCTS } from "./config.ts";
import { ExplorerDb } from "./db.ts";
import { parsePolicy, policyFingerprint, publishedChannels } from "./policy.ts";
import { repositoryUrl } from "./pages.ts";
import { buildServer } from "./server.ts";

describe("where the Weft products are", () => {
  it("defaults to products.json's domain", () => {
    expect(parseProductAddresses(undefined)).toEqual({ local: false, domain });
    expect(parseProductAddresses("")).toEqual(PUBLIC_PRODUCTS);
    expect(parseProductAddresses("  ")).toEqual(PUBLIC_PRODUCTS);
    expect(productAddress("docs", PUBLIC_PRODUCTS)).toBe(`https://docs.${domain}/`);
    expect(productAddress("site", PUBLIC_PRODUCTS)).toBe(`https://${domain}/`);
  });

  it("takes dev for the local sites", () => {
    for (const value of ["dev", "DEV", " dev "]) expect(parseProductAddresses(value)).toEqual({ local: true });
    expect(productAddress("playground", { local: true })).toBe("http://localhost:4323/");
    expect(productAddress("network", { local: true }, "/x")).toBe("http://localhost:4324/x");
  });

  it("puts every product under another domain", () => {
    const where = parseProductAddresses("Weft.Example.org.");
    expect(where).toEqual({ local: false, domain: "weft.example.org" });
    expect(productAddress("site", where)).toBe("https://weft.example.org/");
    expect(productAddress("docs", where)).toBe("https://docs.weft.example.org/");
    expect(productAddress("network", where)).toBe("https://network.weft.example.org/");
    // The explorer and the wallet have no site of their own.
    expect(productAddress("explorer", where)).toBeNull();
    expect(productAddress("wallet", where)).toBeNull();
  });

  it("refuses anything that isn't a domain, saying what to give", () => {
    for (const value of ["https://weft.example.org", "weft.example.org/", "localhost", "weft..example.org", "-weft.example.org", "weft_example.org", "weft.example.org:8443", `${"a".repeat(64)}.org`]) {
      expect(() => parseProductAddresses(value), value).toThrow(/WEFT_EXPLORER_PRODUCTS_DOMAIN: .* isn't a domain\. .*such as weft\.example\.org, or dev/);
    }
  });
});

describe("loading the products setting at startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-explorer-config-"));
  writeFileSync(join(dir, "cert.pem"), "cert");
  writeFileSync(join(dir, "key.pem"), "key");
  writeFileSync(join(dir, "explorer.yaml"), "channels:\n  mychannel:\n    level: public\n");
  const env = (extra: Record<string, string> = {}) => ({
    WEFT_PEER_ENDPOINT: "localhost:7051",
    WEFT_EXPLORER_MSP_ID: "Org1MSP",
    WEFT_EXPLORER_CERT: join(dir, "cert.pem"),
    WEFT_EXPLORER_KEY: join(dir, "key.pem"),
    WEFT_EXPLORER_POLICY: join(dir, "explorer.yaml"),
    ...extra,
  });

  it("reads it with the others, and the network page follows it", () => {
    expect(loadConfig(env()).products).toEqual(PUBLIC_PRODUCTS);
    expect(loadConfig(env()).networkPage).toBe(`https://network.${domain}/`);
    const local = loadConfig(env({ WEFT_EXPLORER_PRODUCTS_DOMAIN: "dev" }));
    expect(local.products).toEqual({ local: true });
    expect(local.networkPage).toBe("http://localhost:4324/");
    const elsewhere = loadConfig(env({ WEFT_EXPLORER_PRODUCTS_DOMAIN: "weft.example.org" }));
    expect(elsewhere.networkPage).toBe("https://network.weft.example.org/");
  });

  it("keeps a network page named on its own", () => {
    const config = loadConfig(env({ WEFT_EXPLORER_PRODUCTS_DOMAIN: "dev", WEFT_EXPLORER_NETWORK_PAGE: "https://network.org1.example/" }));
    expect(config.networkPage).toBe("https://network.org1.example/");
    expect(loadConfig(env({ WEFT_EXPLORER_PRODUCTS_DOMAIN: "dev", WEFT_EXPLORER_NETWORK_PAGE: "off" })).networkPage).toBeUndefined();
  });

  it("stops at startup on a value that isn't a domain", () => {
    expect(() => loadConfig(env({ WEFT_EXPLORER_PRODUCTS_DOMAIN: "https://weft.example.org" }))).toThrow(/WEFT_EXPLORER_PRODUCTS_DOMAIN/);
  });
});

describe("the experimental switch (docs/adr/0009)", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-explorer-experimental-"));
  writeFileSync(join(dir, "cert.pem"), "cert");
  writeFileSync(join(dir, "key.pem"), "key");
  writeFileSync(join(dir, "plain.yaml"), "channels:\n  mychannel:\n    level: public\n");
  writeFileSync(join(dir, "private.yaml"), "channels:\n  privatevote-chair-2027:\n    level: public\n    privateElections: private-ballot\n");
  const env = (policy: string, extra: Record<string, string> = {}) => ({
    WEFT_PEER_ENDPOINT: "localhost:7051",
    WEFT_EXPLORER_MSP_ID: "Org1MSP",
    WEFT_EXPLORER_CERT: join(dir, "cert.pem"),
    WEFT_EXPLORER_KEY: join(dir, "key.pem"),
    WEFT_EXPLORER_POLICY: join(dir, policy),
    ...extra,
  });

  it("is off by default", () => {
    expect(loadConfig(env("plain.yaml")).experimental).toBe(false);
  });

  it("allows privateElections only with WEFT_EXPERIMENTAL=1", () => {
    expect(() => loadConfig(env("private.yaml"))).toThrow(/channels\.privatevote-chair-2027\.privateElections is set in .*, but the explorer shows private elections only when it's started with WEFT_EXPERIMENTAL=1/);
    const config = loadConfig(env("private.yaml", { WEFT_EXPERIMENTAL: "1" }));
    expect(config.experimental).toBe(true);
    expect(config.policy.channels["privatevote-chair-2027"]?.privateElections).toBe("private-ballot");
  });

  it("refuses a privateElections that isn't a contract name", () => {
    expect(() => parsePolicy({ channels: { "privatevote-chair-2027": { level: "public", privateElections: true } } })).toThrow(/privateElections must be the private-ballot contract's name/);
  });

  it("leaves the fingerprint of a policy without privateElections unchanged", () => {
    const plain = parsePolicy({ channels: { mychannel: { level: "public", elections: "ballot" } } });
    const withPrivate = parsePolicy({ channels: { mychannel: { level: "public", elections: "ballot", privateElections: "private-ballot" } } });
    expect(policyFingerprint(plain)).toBe("07d48a3421ad314dde36ae96237777c73c5c49f1ff65486fd7f68cc8c824f650");
    expect(policyFingerprint(withPrivate)).not.toBe(policyFingerprint(plain));
  });
});

describe("the pages' links to the products", () => {
  const policy = parsePolicy({ organisation: "Org1", channels: { mychannel: { level: "public" } } });
  const page = async (products?: Parameters<typeof buildServer>[0]["products"]) => {
    const app = buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db: new ExplorerDb(":memory:"), status: () => [], ...(products ? { products } : {}) });
    const body = (await app.inject({ url: "/" })).body;
    await app.close();
    return body;
  };

  it("point at the addresses the explorer was started with", async () => {
    const elsewhere = await page({ local: false, domain: "weft.example.org" });
    expect(elsewhere).toContain('href="https://docs.weft.example.org/"');
    expect(elsewhere).toContain('href="https://play.weft.example.org/"');
    expect(elsewhere).not.toContain(domain);
    const local = await page({ local: true });
    expect(local).toContain('href="http://localhost:4322/"');
    expect(await page()).toContain(`href="https://docs.${domain}/"`);
  });

  it("link to the repository named in package.json", async () => {
    expect(await page()).toContain('href="https://github.com/ifeanyi-ugwu/weft">Source on GitHub</a>');
  });
});

describe("the repository's address", () => {
  it("reads the forms package.json allows", () => {
    expect(repositoryUrl({ repository: { url: "git+https://github.com/o/r.git" } })).toBe("https://github.com/o/r");
    expect(repositoryUrl({ repository: "https://github.com/o/r" })).toBe("https://github.com/o/r");
    expect(repositoryUrl({ repository: "github:o/r" })).toBe("https://github.com/o/r");
    expect(repositoryUrl({ repository: "o/r" })).toBe("https://github.com/o/r");
    expect(repositoryUrl({ repository: "git://git.example.org/r.git" })).toBe("https://git.example.org/r");
  });

  it("gives none rather than a broken link", () => {
    expect(repositoryUrl({})).toBeNull();
    expect(repositoryUrl({ repository: { url: "" } })).toBeNull();
    expect(repositoryUrl({ repository: "not a url" })).toBeNull();
    expect(repositoryUrl({ repository: "ssh://git@github.com/o/r.git" })).toBeNull();
  });
});
