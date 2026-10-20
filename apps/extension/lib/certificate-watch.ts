/**
 * Tells sites when the certificate they're using is about to expire or has
 * expired, so they can prompt a renewal instead of failing on the next call.
 *
 * The worker isn't always running, so an hourly alarm wakes it to check.
 * Each identity is announced once per state; renewing resets it.
 */

import { certificateHealth, summarizeIdentity } from "@weftwallet/core";
import { browser } from "wxt/browser";
import { originsConnectedTo, sendTo } from "./sites";
import { activeIdentity } from "./wallet";

const ALARM = "weft-certificate-check";
const STORAGE_KEY = "certificateAnnounced";

type Announced = Record<string, { state: "expiring" | "expired"; notAfter: string }>;

async function announced(): Promise<Announced> {
  return ((await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Announced | undefined) ?? {};
}

export async function checkCertificates(now = new Date()): Promise<void> {
  const active = await activeIdentity();
  if (!active) return;
  const summary = await summarizeIdentity(active.record);
  const health = certificateHealth(summary, now);
  if (health.state !== "expiring" && health.state !== "expired") return;

  const seen = await announced();
  const previous = seen[summary.id];
  // Same certificate, same state: already told. A renewal changes notAfter.
  if (previous && previous.state === health.state && previous.notAfter === summary.notAfter) return;

  const origins = await originsConnectedTo(summary.id);
  await sendTo(origins, "certificateStatus", {
    identityId: summary.id,
    state: health.state,
    notAfter: summary.notAfter,
    daysLeft: health.state === "expiring" ? health.daysLeft : 0,
  });
  await browser.storage.local.set({ [STORAGE_KEY]: { ...seen, [summary.id]: { state: health.state, notAfter: summary.notAfter } } });
}

/** Call once at startup. */
export function registerCertificateWatch(): void {
  void browser.alarms.create(ALARM, { periodInMinutes: 60 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void checkCertificates();
  });
  void checkCertificates();
}
