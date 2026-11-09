/**
 * The wallet's popup and windows for scripts/no-sideways-scroll.mjs. They are
 * served from the built extension (apps/extension/.output/chrome-mv3) as
 * plain pages, with the extension APIs faked in the page (fakeWorker): the
 * background worker answers each UI request from a canned wallet. Each screen
 * is a page and the presses that reach it, with the worker it needs.
 */

const TX = "e41b22d89f3a1c07b25e6d0c4a7f38e19b5c2d74a6e0f18c3b9d5a2e7f04c61d";
const SALT = "7c1e94a0b3d25f86e0a4c9172bd35e6f";
const MSP = "NorthwindFreightHoldingsInternationalMSP";
const LONG = "a-single-argument-with-no-spaces-in-it-at-all-0123456789abcdef0123456789abcdef0123456789abcdef";
const PEM = `-----BEGIN CERTIFICATE-----\n${"MIICmDCCAj+gAwIBAgIUQ0a2".repeat(8)}\n-----END CERTIFICATE-----`;

const network = (id, name, mspId) => ({
  id,
  name,
  organization: "Northwind Freight Holdings International",
  mspId,
  caUrl: "https://ca.org1.northwind-freight-holdings-international.example.com:7054",
  relayUrl: "https://relay.org1.northwind-freight-holdings-international.example.com",
  explorerUrl: "https://explorer.org1.northwind-freight-holdings-international.example.com",
  inviteUrl: "https://relay.org1.northwind-freight-holdings-international.example.com/.well-known/weft-invite.json",
  channels: ["mychannel", "letters-of-credit-and-trade-finance-settlements", "invoices"],
});
const identity = (id, name, net, mspId) => ({
  id,
  name,
  mspId,
  role: "client",
  attributes: { "hf.EnrollmentID": name, "hf.Type": "client", "hf.Affiliation": "org1.department1.northwind-freight-holdings", department: "letters-of-credit" },
  issuer: `CN=ca.org1.northwind-freight-holdings-international.example.com,O=${mspId},L=Doha,C=QA`,
  notAfter: "2027-06-01T00:00:00.000Z",
  fingerprint: "9F:3A:1C:07:B2:5E:6D:0C:4A:7F:38:E1:9B:5C:2D:74:A6:E0:F1:8C:3B:9D:5A:2E:7F:04:C6:1D:E4:1B:22:D8",
  certificate: PEM,
  networkId: net.id,
  networkName: net.name,
  organization: net.organization,
  channels: net.channels,
  enrollmentId: name,
  legacyKey: false,
});
const northwind = network("net1", "Northwind Trade Finance Consortium (Production)", MSP);
const playground = network("net2", "Weft playground", "Org1MSP");
const alice = identity("alice", "alice-with-a-long-enrolment-name-for-letters-of-credit", northwind, MSP);
const bob = identity("bob", "bob", playground, "Org1MSP");
const now = Date.parse("2026-11-09T10:00:00Z");
const call = { channel: "letters-of-credit-and-trade-finance-settlements", chaincode: "trade-finance-letters-of-credit", contract: "LettersOfCreditContract", fn: "IssueLetterOfCreditWithAmendments", args: [LONG, "Org2MSP", '{"amount":"125000.00","currency":"QAR","beneficiary":"Northwind Freight Holdings International"}'] };
const activity = [
  { id: "a1", at: now - 60_000, origin: "https://trade.northwind-freight-holdings-international.example.com", identityId: "alice", kind: "submit", call, privateInputs: ["documentsWithAVeryLongPrivateInputName"], status: "committed", transactionId: TX, blockNumber: "1204512", code: "VALID" },
  { id: "a2", at: now - 3_600_000, origin: "http://localhost:5175", identityId: "bob", kind: "evaluate", call: { channel: "mychannel", chaincode: "basic", fn: "ReadAsset", args: ["asset7"] }, status: "evaluated" },
  {
    id: "a3",
    at: now - 86_400_000,
    origin: "http://localhost:5175",
    identityId: "bob",
    kind: "submit",
    call,
    status: "failed",
    transactionId: TX,
    code: "ENDORSEMENT_POLICY_FAILURE",
    title: "The endorsement policy wasn't met",
    detail: "Not enough organisations endorsed this transaction for the contract's endorsement policy.",
    endorsers: [{ mspId: "Org2MSP", address: "peer0.org2.northwind-freight-holdings-international.example.com:9051", message: `chaincode response 500, ${LONG}` }],
    raw: `rpc error: code = Aborted desc = failed to endorse transaction, see attached details for more info ${LONG}`,
  },
];
const vault = (state) => ({ state, autoLockMinutes: 15, passkeys: [{ id: "pk1", name: "MacBook Pro Touch ID passkey with a long name", createdAt: now }] });
const state = (over = {}) => ({
  identities: [alice, bob],
  networks: [northwind, playground],
  pendingCsrs: [{ id: "csr1", networkId: "net1", networkName: northwind.name, commonName: "carol-the-operator-with-a-long-name", csr: PEM, createdAt: now }],
  sites: [
    { origin: "https://trade.northwind-freight-holdings-international.example.com", connectedAt: now, identityIds: ["alice"] },
    { origin: "http://localhost:5175", connectedAt: now, identityIds: ["bob"] },
  ],
  settings: { activeIdentityId: "alice", activeChannel: "letters-of-credit-and-trade-finance-settlements" },
  vault: vault("unlocked"),
  ...over,
});
const identityView = alice;
const submitView = {
  id: "req",
  origin: "https://trade.northwind-freight-holdings-international.example.com",
  method: "weft_submit",
  call: { ...call, transient: { documentsWithAVeryLongPrivateInputName: JSON.stringify({ option: "Ada", salt: SALT, note: LONG }) }, endorsingOrganizations: [MSP, "Org2MSP", "Org3MSP"] },
  identity: identityView,
};
const receiptRequest = { type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-of-directors-2026-annual-election", option: "Ada", salt: SALT };
const receipt = { ...receiptRequest, txId: TX, blockNumber: 1204512, commitment: "348fb0f843ed08a3fd1a39e9b6c54e2b1392b421768c9a1ccf353540b1d4e333" };
const voteView = {
  ...submitView,
  call: { channel: "mychannel", chaincode: "ballot", fn: "CastVote", args: ["board-of-directors-2026-annual-election"], transient: { ballot: JSON.stringify({ option: "Ada", salt: SALT }) } },
  receipt: { request: receiptRequest, input: "ballot", generated: true },
};
const approved = { status: "approved", activityId: "a1", blockNumber: "1204512", transactionId: TX, explorerUrl: northwind.explorerUrl };
const failed = {
  status: "failed",
  activityId: "a3",
  title: "The endorsement policy wasn't met",
  detail: "Not enough organisations endorsed this transaction for the contract's endorsement policy.",
  code: "ENDORSEMENT_POLICY_FAILURE",
  raw: `rpc error: code = Aborted desc = failed to endorse transaction ${LONG}`,
  retryable: false,
};
const quota = "QuotaExceededError: The quota has been exceeded.";

/**
 * Runs in the page before its scripts: the extension APIs Weft's pages use,
 * with the background worker answering from `canned`.
 */
export function fakeWorker(canned) {
  const listeners = { addListener() {}, removeListener() {}, hasListener: () => false };
  const answers = {
    state: canned.state,
    activity: canned.activity ?? [],
    activityItem: (p) => (canned.activity ?? []).find((a) => a.id === p.id) ?? null,
    approvalGet: canned.view ?? null,
    approvalsPending: [],
    vaultStatus: canned.state?.vault ?? { state: canned.vault ?? "unlocked", autoLockMinutes: 15, passkeys: [] },
    approvalDecide: canned.outcome ?? { status: "rejected" },
    receiptGet: canned.receipt ?? null,
    receiptsOf: { count: 1, elections: ["board-of-directors-2026-annual-election"] },
    keepAlive: null,
    // Unanswered unless a screen asks for it, as a slow worker would: no notice about the build.
    ...(canned.buildInfo ? { buildInfo: canned.buildInfo } : {}),
  };
  window.close = () => {};
  const runtime = {
    id: "weft",
    getURL: (p) => p,
    getManifest: () => ({ version: "0.1.0" }),
    onMessage: listeners,
    sendMessage: async (req) => {
      if (req?.channel !== "weft-ui") return undefined;
      const a = answers[req.method];
      // A request the screen sends but this page doesn't need waits for ever, as a slow worker would.
      if (a === undefined) return new Promise(() => {});
      return { ok: true, value: typeof a === "function" ? a(req.payload ?? {}) : a };
    },
  };
  window.chrome = {
    runtime,
    storage: { onChanged: listeners, session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    permissions: { contains: async () => true, request: async () => true, onAdded: listeners, onRemoved: listeners },
    windows: { create: async () => ({}), getCurrent: async () => ({}), update: async () => ({}) },
    tabs: { create: async () => ({}), query: async () => [] },
  };
}

const press = (name, options = {}) => async (page) => {
  const target = page.getByRole(options.role ?? "button", { name, exact: options.exact }).first();
  await target.waitFor();
  await target.click({ timeout: 10_000 });
  await page.waitForTimeout(450);
};
const steps = (...fns) => async (page, width) => {
  // The popup and the windows are 360 and 380 wide; the audit's own widths still apply.
  await page.waitForTimeout(300);
  for (const fn of fns) await fn(page, width);
  return true;
};
/**
 * The popup's body is 360px wide (app.css): the browser sizes the popup to
 * it, so it is never narrower and isn't checked narrower. The windows fill
 * whatever size they are given, so they are checked at every width.
 */
const popup = (name, worker, ...fns) => ({ name, path: "/popup.html", minWidth: 360, worker: { state: state(), activity, ...worker }, run: steps(...fns) });
/** popup.html opened in a tab (lib/permissions.ts), which fills whatever size the tab is: checked at every width. */
const popupTab = (name, worker, ...fns) => ({ name, path: "/popup.html?tab=1", worker: { state: state(), activity, ...worker }, run: steps(...fns) });
/** A background built before Weft stamped its builds, so the popup says it's older. */
const olderBackground = { buildInfo: { builtAt: null } };
const approve = (name, worker, ...fns) => ({ name, path: "/approve.html?id=req", worker: { state: state(), ...worker }, run: steps(...fns) });

export const wallet = {
  fakeWorker,
  screens: [
    popup("popup: welcome", { state: state({ identities: [], networks: [], pendingCsrs: [], sites: [], vault: vault("none") }) }),
    popup("popup: welcome, more ways", { state: state({ identities: [], networks: [], pendingCsrs: [], sites: [], vault: vault("none") }) }, press("More ways to add an identity")),
    popup("popup: create a password", { state: state({ identities: [], networks: [], pendingCsrs: [], sites: [], vault: vault("none") }) }, press("Join from an invite")),
    popup("popup: locked", { state: state({ vault: vault("locked") }) }),
    popup("popup: home, activity"),
    popup("popup: home, identities", {}, press(/^Identities/, { role: "tab" })),
    popup("popup: home, sites", {}, press(/^Sites/, { role: "tab" })),
    popup("popup: transaction", {}, press(/IssueLetterOfCredit/)),
    popup("popup: failed transaction", {}, async (page) => {
      await page.getByRole("button", { name: /IssueLetterOfCredit/ }).last().click();
      await page.waitForTimeout(450);
      await page.getByText("Details").first().click();
      await page.waitForTimeout(300);
    }),
    popup("popup: identities", {}, press("Manage identities")),
    popup("popup: network settings", {}, press("Manage identities"), press(`Network settings for ${northwind.name}`)),
    popup("popup: complete a CSR", {}, press("Manage identities"), press(/carol-the-operator/)),
    popup("popup: add an identity", {}, press("Manage identities"), press("Add")),
    popup("popup: join from an invite", {}, press("Manage identities"), press("Add"), press("Join from an invite")),
    popup("popup: enrol", {}, press("Manage identities"), press("Add"), press("Enrol with CA")),
    popup("popup: import", {}, press("Manage identities"), press("Add"), press("Import PEM")),
    popup("popup: generate a CSR", {}, press("Manage identities"), press("Add"), press("Generate CSR")),
    popup("popup: security", {}, press("Security")),
    popup("popup: home, background older", olderBackground),
    popup("popup: security, background older", olderBackground, press("Security")),
    popup("popup: welcome, background older", { ...olderBackground, state: state({ identities: [], networks: [], pendingCsrs: [], sites: [], vault: vault("none") }) }),
    popupTab("popup in a tab: home"),
    popupTab("popup in a tab: join from an invite", {}, press("Manage identities"), press("Add"), press("Join from an invite")),
    approve("window: connect", { view: { id: "req", origin: submitView.origin, method: "weft_connect", call: null, identity: identityView } }),
    approve("window: sign in", { view: { id: "req", origin: submitView.origin, method: "weft_signIn", call: null, identity: identityView, statement: "Sign in to Northwind Trade Finance to see your letters of credit and invoices." } }),
    approve("window: add a network", { view: { id: "req", origin: submitView.origin, method: "weft_addNetwork", call: null, identity: identityView, inviteUrl: northwind.inviteUrl } }),
    approve("window: read", { view: { ...submitView, method: "weft_evaluate" } }),
    approve("window: submit, private inputs and raw request shown", { view: submitView }, press("Show"), press("View raw request")),
    approve("window: vote with a receipt", { view: voteView }, press("Keep the receipt in Weft", { role: "switch" })),
    approve("window: committed", { view: submitView, outcome: approved }, press("Sign and submit")),
    approve("window: failed", { view: submitView, outcome: failed }, press("Sign and submit"), async (page) => (await page.getByText("Details").first().click(), page.waitForTimeout(300))),
    approve("window: committed, activity not saved", { view: submitView, outcome: { ...approved, activityId: null, unsaved: { error: quota } } }, press("Sign and submit")),
    approve(
      "window: vote committed, receipt and activity not saved",
      { view: voteView, outcome: { ...approved, activityId: null, receipt: { kept: false, reason: "storage", receipt, error: quota }, unsaved: { error: quota, receipt } } },
      press("Keep the receipt in Weft", { role: "switch" }),
      press("Sign and submit"),
      async (page) => (await page.getByText("Details").first().click(), page.waitForTimeout(300)),
    ),
    approve(
      "window: vote committed, commitment mismatch",
      { view: voteView, outcome: { ...approved, receipt: { kept: false, reason: "mismatch", expected: receipt.commitment, returned: "0".repeat(64) } } },
      press("Keep the receipt in Weft", { role: "switch" }),
      press("Sign and submit"),
      async (page) => (await page.getByText("Details").first().click(), page.waitForTimeout(300)),
    ),
    { name: "receipt page", path: "/receipt.html?id=a1", worker: { state: state(), receipt: { id: "a1", origin: submitView.origin, keptAt: now, receipt, explorerUrl: northwind.explorerUrl } }, run: steps() },
  ],
};
