/** A WebCrypto private key as PKCS#8 PEM, for Node's crypto. */
export async function exportPkcs8(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", key));
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
