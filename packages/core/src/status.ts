/**
 * Plain-English explanations for Fabric validation codes and common
 * endorsement failures. Fabric's own messages are written for peer
 * operators; these are written for the person who pressed "Sign".
 */

export interface StatusExplanation {
  /** Short headline, e.g. "Not enough organisations approved it". */
  title: string;
  /** One or two sentences on what happened and what to do. */
  detail: string;
  /** Whether trying again unchanged has a reasonable chance of working. */
  retryable: boolean;
  /** The raw Fabric code, kept for support tickets. */
  code: string;
  /** The network's own words, when they're worth keeping; shown behind "Details". */
  raw?: string;
}

const EXPLANATIONS: Record<string, Omit<StatusExplanation, "code">> = {
  VALID: {
    title: "Committed",
    detail: "The transaction was approved and written to the ledger.",
    retryable: false,
  },
  MVCC_READ_CONFLICT: {
    title: "Someone else changed the same data first",
    detail:
      "Another transaction updated a value this one read, between approval and commit. Nothing was written. Trying again usually works.",
    retryable: true,
  },
  PHANTOM_READ_CONFLICT: {
    title: "The data changed before this transaction committed",
    detail: "A range of keys this transaction read was modified before it committed. Nothing was written. Try again.",
    retryable: true,
  },
  ENDORSEMENT_POLICY_FAILURE: {
    title: "Not enough organisations approved it",
    detail:
      "The contract's policy needs approval from more organisations than signed. A peer may be offline, or an organisation may have rejected the request.",
    retryable: true,
  },
  DUPLICATE_TXID: {
    title: "This transaction was already submitted",
    detail: "A transaction with the same ID is already on the ledger. Check your activity before sending it again.",
    retryable: false,
  },
  BAD_CREATOR_SIGNATURE: {
    title: "The network did not accept your signature",
    detail: "Your certificate may have been revoked or replaced. Re-enrol with your organisation's CA and try again.",
    retryable: false,
  },
  BAD_PROPOSAL_TXID: {
    title: "The request was malformed",
    detail: "The transaction ID did not match its contents. The app or the relay has a bug.",
    retryable: false,
  },
  EXPIRED_CHAINCODE: {
    title: "The contract version changed",
    detail: "The contract was upgraded before this transaction committed. Try again.",
    retryable: true,
  },
  CHAINCODE_VERSION_CONFLICT: {
    title: "The contract version changed",
    detail: "The contract was upgraded before this transaction committed. Try again.",
    retryable: true,
  },
  INVALID_ENDORSER_TRANSACTION: {
    title: "The approvals did not match",
    detail:
      "Organisations returned different results for the same request, often because the contract reads the clock or random data. Contact the app's developer.",
    retryable: false,
  },
  ILLEGAL_WRITESET: {
    title: "The contract tried to write data it may not",
    detail: "The network rejected the changes this transaction made. Contact the app's developer.",
    retryable: false,
  },
  INVALID_WRITESET: {
    title: "The contract tried to write data it may not",
    detail: "The network rejected the changes this transaction made. Contact the app's developer.",
    retryable: false,
  },
};

/** Explains a validation code name such as "MVCC_READ_CONFLICT". */
export function explainStatus(code: string): StatusExplanation {
  const known = EXPLANATIONS[code];
  if (known) return { ...known, code };
  return {
    title: "The network rejected this transaction",
    detail: "Nothing was written to the ledger. The code below will help your network administrator.",
    retryable: false,
    code,
  };
}

/**
 * Endorsement errors arrive as gRPC text rather than validation codes. These
 * patterns catch the common ones.
 */
export function explainEndorseError(message: string): StatusExplanation {
  const m = message.toLowerCase();
  if (m.includes("access denied") || m.includes("creator org unknown") || m.includes("failed evaluating policy")) {
    return {
      title: "Your identity is not allowed to do this",
      detail: "The channel's access policy rejected this identity. Check you are using the right organisation and role.",
      retryable: false,
      code: "ACCESS_DENIED",
    };
  }
  if (
    m.includes("no peers available") ||
    m.includes("unavailable") ||
    m.includes("failed to connect") ||
    m.includes("deadline exceeded")
  ) {
    return {
      title: "The network could not be reached",
      detail: "No peer answered in time. The network may be down or the relay misconfigured. Try again shortly.",
      retryable: true,
      code: "UNAVAILABLE",
    };
  }
  if (m.includes("chaincode") && (m.includes("not found") || m.includes("could not find"))) {
    return {
      title: "That contract is not on this channel",
      detail: "Check the channel and contract name the app is using.",
      retryable: false,
      code: "CHAINCODE_NOT_FOUND",
    };
  }
  if (m.includes("certificate") && m.includes("expired")) {
    return {
      title: "Your certificate has expired",
      detail: "Re-enrol with your organisation's CA to get a new one.",
      retryable: false,
      code: "CERTIFICATE_EXPIRED",
    };
  }
  return {
    title: "The contract returned an error",
    detail: "The contract refused this request, so nothing was written. The details show what it said.",
    retryable: false,
    code: "ENDORSE_FAILED",
    raw: message,
  };
}

/**
 * The relay itself didn't answer: it's down, the address is wrong, or this
 * computer doesn't trust its HTTPS certificate. Nothing reached the peers.
 */
export function explainRelayUnreachable(host: string, timedOut: boolean): StatusExplanation {
  return timedOut
    ? {
        title: "The relay didn't answer",
        detail: `The relay at ${host} didn't answer in time. Try again shortly. If it keeps happening, check the relay address in the network's settings.`,
        retryable: true,
        code: "RELAY_TIMEOUT",
      }
    : {
        title: "The relay couldn't be reached",
        detail: `Weft couldn't connect to the relay at ${host}. Check it's running and that this computer trusts its HTTPS certificate, then try again.`,
        retryable: true,
        code: "RELAY_UNREACHABLE",
      };
}

/** The relay answered, but with an error of its own rather than the network's. */
export function explainRelayHttp(host: string, status: number): StatusExplanation {
  return {
    title: "The relay returned an error",
    detail: `The relay at ${host} couldn't handle this request. Try again shortly. If it keeps happening, tell your network administrator.`,
    retryable: true,
    code: `RELAY_HTTP_${status}`,
  };
}
