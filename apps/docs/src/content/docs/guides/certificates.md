---
title: Certificates and renewal
description: How Weft tracks certificate expiry, and how to renew before signing stops working.
---

Fabric certificates expire, often after a year. An expired certificate can't sign, and the network rejects it. Weft shows each certificate's expiry on the home screen and warns 30 days ahead.

## The health bar

The identity card on the home screen shows:

| Colour | Meaning |
|---|---|
| Teal | Valid, more than 30 days left. |
| Amber | Expires within 30 days. A **Re-enrol** button appears. |
| Red | Expired. Weft refuses to sign and web apps receive error `4301`. |

## Renewing

Choose **Re-enrol** to ask your organisation's CA for a new certificate:

1. Weft creates a **new** key pair.
2. It signs the request with your **current** key, which proves to the CA that you are the same identity.
3. The CA returns a certificate for the new key, and Weft replaces both.

You don't need your enrolment secret. You do need the CA URL, which comes from your invite or the details you entered when enrolling. Identities imported from PEM files without a CA URL can't be renewed from Weft; import the new certificate and key instead.

Re-enrolment only works while the current certificate is still valid. If it has already expired, ask your administrator for a new enrolment secret and enrol again.

## Fingerprints

The SHA-256 fingerprint on the identity card identifies your exact certificate. Administrators can compare it with their records, for example when revoking or auditing identities.
