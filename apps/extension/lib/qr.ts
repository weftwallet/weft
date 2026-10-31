/**
 * Reads invite QR codes without a camera: from the tab the user is looking at
 * (a slide, a portal, a PDF) or from an image they paste.
 */

import jsQR from "jsqr";
import { browser } from "wxt/browser";

export class QrNotFoundError extends Error {
  constructor(where: string) {
    super(`No QR code found ${where}. Make sure the whole code is visible and not too small.`);
    this.name = "QrNotFoundError";
  }
}

async function decodeBlob(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Weft couldn't read that image. Paste a PNG or JPEG screenshot of the QR code.");
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/**
 * Captures the visible part of the current tab and decodes a QR code in it.
 * Uses the activeTab grant the user gives by opening the popup, so it only
 * works from the popup and only for that tab.
 */
export async function scanActiveTab(): Promise<string> {
  const dataUrl = await browser.tabs.captureVisibleTab({ format: "png" });
  const text = await decodeBlob(await (await fetch(dataUrl)).blob());
  if (!text) throw new QrNotFoundError("on this tab");
  return text;
}

/** Decodes a QR code from a pasted image, or returns null if the paste had no image. */
export async function scanPastedImage(clipboard: DataTransfer | null): Promise<string | null> {
  const file = Array.from(clipboard?.files ?? []).find((f) => f.type.startsWith("image/"));
  if (!file) return null;
  const text = await decodeBlob(file);
  if (!text) throw new QrNotFoundError("in that image");
  return text;
}
