import { readFile, writeFile } from "node:fs/promises";
import {
  DEFAULT_JOIN_PAGE,
  inviteFromConnectionProfile,
  inviteLinks,
  parseInvite,
  resolveInviteUrl,
  type ConnectionProfile,
} from "@weftwallet/core";
import type { OrgInvite } from "@weftwallet/protocol";
import QRCode from "qrcode";
import { parse as parseYaml } from "yaml";
import { productUrl } from "@weftwallet/brand/products";

export async function readStructured(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return /\.ya?ml$/i.test(path) ? parseYaml(text) : JSON.parse(text);
}

export interface CreateOptions {
  profile?: string;
  relay?: string;
  organization?: string;
  channels: string[];
  network?: string;
  enrollmentId?: string;
  /** Used when there is no profile. */
  mspId?: string;
  caUrl?: string;
  caName?: string;
  explorerUrl?: string;
}

/** Builds an invite from a connection profile, or from explicit fields. */
export async function createInvite(options: CreateOptions): Promise<OrgInvite> {
  if (!options.relay) throw new Error("--relay is required: the URL of your organisation's Weft relay.");
  if (options.profile) {
    return inviteFromConnectionProfile((await readStructured(options.profile)) as ConnectionProfile, {
      relayUrl: options.relay,
      ...(options.organization ? { organization: options.organization } : {}),
      ...(options.channels.length ? { channels: options.channels } : {}),
      ...(options.network ? { network: options.network } : {}),
      ...(options.enrollmentId ? { enrollmentId: options.enrollmentId } : {}),
      ...(options.explorerUrl ? { explorerUrl: options.explorerUrl } : {}),
    });
  }
  if (!options.mspId || !options.caUrl) {
    throw new Error("Pass --profile <connection profile>, or --msp and --ca to describe the organisation directly.");
  }
  return parseInvite({
    weft: 1,
    network: options.network ?? `${options.organization ?? options.mspId} network`,
    organization: options.organization ?? options.mspId,
    mspId: options.mspId,
    caUrl: options.caUrl,
    ...(options.caName ? { caName: options.caName } : {}),
    relayUrl: options.relay,
    channels: options.channels,
    ...(options.enrollmentId ? { enrollmentId: options.enrollmentId } : {}),
    ...(options.explorerUrl ? { explorerUrl: options.explorerUrl } : {}),
  });
}

export interface ShareResult {
  url: string;
  join: string;
  weft: string;
  qrFile?: string;
  qrTerminal?: string;
}

/**
 * Builds share links for an invite URL and, optionally, a QR code. The QR
 * encodes the join link: phones open it in a browser, and Weft's "scan"
 * understands it too.
 */
export async function shareInvite(
  inviteUrl: string,
  options: { joinPage?: string; qr?: string; terminal?: boolean } = {},
): Promise<ShareResult> {
  const links = inviteLinks(resolveInviteUrl(inviteUrl), options.joinPage ?? DEFAULT_JOIN_PAGE);
  const result: ShareResult = { ...links };
  if (options.qr) {
    if (options.qr.endsWith(".svg")) {
      await writeFile(options.qr, await QRCode.toString(links.join, { type: "svg", margin: 2, errorCorrectionLevel: "M" }));
    } else if (options.qr.endsWith(".png")) {
      await QRCode.toFile(options.qr, links.join, { type: "png", margin: 2, width: 512, errorCorrectionLevel: "M" });
    } else {
      throw new Error("--qr must end in .svg or .png");
    }
    result.qrFile = options.qr;
  }
  if (options.terminal) {
    result.qrTerminal = await QRCode.toString(links.join, { type: "terminal", small: true, errorCorrectionLevel: "M" });
  }
  return result;
}

export interface CheckLine {
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * Loads an invite (from a file, an https URL or a weft:// link), validates it,
 * and checks the relay and CA answer. Uses the operator's own network, so
 * it's a good smoke test after deploying.
 */
export async function checkInvite(input: string, fetchImpl: typeof fetch = fetch): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  let invite: OrgInvite;
  try {
    if (/^(https?|weft):/i.test(input)) {
      const url = resolveInviteUrl(input);
      // Send an Origin so CORS headers come back, as they would for the join page.
      const response = await fetchImpl(url, { headers: { accept: "application/json", origin: productUrl("site")! } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const cors = response.headers.get("access-control-allow-origin");
      invite = parseInvite(await response.json());
      lines.push({ ok: true, label: "Invite", detail: `${invite.network} · ${invite.mspId} · ${url}` });
      lines.push({
        ok: cors !== null,
        label: "Invite CORS",
        detail: cors ? `allows ${cors}` : "no access-control-allow-origin header; the hosted join page can't preview it",
      });
    } else {
      invite = parseInvite(await readStructured(input));
      lines.push({ ok: true, label: "Invite", detail: `${invite.network} · ${invite.mspId} · ${input}` });
    }
  } catch (error) {
    lines.push({ ok: false, label: "Invite", detail: error instanceof Error ? error.message : String(error) });
    return lines;
  }

  const probe = async (label: string, url: string) => {
    try {
      const response = await fetchImpl(url);
      lines.push({ ok: response.ok, label, detail: `${url} → HTTP ${response.status}` });
    } catch (error) {
      lines.push({ ok: false, label, detail: `${url} → ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  await probe("Relay", `${invite.relayUrl}/v1/health`);
  await probe("CA", `${invite.caUrl}/cainfo${invite.caName ? `?ca=${encodeURIComponent(invite.caName)}` : ""}`);
  if (invite.explorerUrl) await probe("Explorer", `${invite.explorerUrl}/api/v1/status`);
  return lines;
}
