import { Suspense, lazy, useState } from "react";
import { ui, type WalletState } from "../../lib/messages";
import { useFeedback } from "../feedback";
import { BackHeader, Empty, Icon, toErrorInfo } from "../ui";
import { FILTER_FROM, FilterInput, GroupHeading, focusTargetAfter, groupByNetwork, matches, useLeaving } from "./lists";
import { IdentityOption } from "./Home";
import { useAction, voterCredentialsOf, type AddFrom, type Navigate } from "./state";

/** Weft Experimental's voter credentials, in their own group (docs/adr/0008); the normal build never emits it. */
const VoterCredentialGroup =
  import.meta.env.WEFT_EXPERIMENTAL === true ? lazy(() => import("./VoterCredential").then((m) => ({ default: m.VoterCredentialGroup }))) : null;

export function Identities({
  state,
  onState,
  navigate,
  fresh = [],
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  navigate: Navigate;
  /** Identities and voter credentials that arrived since the popup opened. */
  fresh?: string[];
}) {
  const { confirm, toast } = useFeedback();
  const leaving = useLeaving();
  const remove = async (identityId: string, name: string, mspId: string, row: Element | null) => {
    const last = state.identities.length === 1;
    // Its kept receipts go with it, so the sheet says how many, in time to
    // cancel and download them first.
    const kept = await ui("receiptsOf", { identityId }).catch(() => null);
    const ok = await confirm({
      title: `Remove ${name}?`,
      body: (
        <>
          <p className="sheet__para">
            The private key for <span className="mono">{name}</span> ({mspId}) is deleted from this browser. It can't be
            recovered, not even by Weft.
          </p>
          {kept && kept.count > 0 && (
            <p className="sheet__para">
              Weft also deletes the{" "}
              <span className="strong">
                {kept.count === 1 ? "1 ballot receipt" : `${kept.count} ballot receipts`}
              </span>{" "}
              kept with {name}'s activity, for {listOf(kept.elections)}. To keep a copy, cancel and download{" "}
              {kept.count === 1 ? "it" : "them"} from the transaction first.
            </p>
          )}
          <p className="flat">
            {last
              ? "It's your only identity, so connected sites are disconnected too. You can enrol again with your CA."
              : "You can enrol again with your CA, which issues a new certificate."}
          </p>
        </>
      ),
      confirmLabel: "Remove",
      icon: "trash",
    });
    if (!ok) return;
    const heading = row?.closest("section")?.querySelector<HTMLElement>("h2") ?? null;
    const refocus = focusTargetAfter(row, () => (heading?.isConnected ? heading : document.querySelector<HTMLElement>(".screen h1")));
    await leaving.leave(identityId);
    try {
      onState(await ui("removeIdentity", { identityId }));
      toast(`Removed ${name}`);
      refocus();
    } catch (error) {
      leaving.stay(identityId);
      toast(`Couldn't remove ${name}. ${toErrorInfo(error).message}`, "error");
    }
  };

  const select = useAction(async (identityId: string, name: string) => {
    if (identityId === state.settings.activeIdentityId) return;
    try {
      onState(await ui("setActive", { identityId }));
      toast(`Switched to ${name}`);
    } catch (error) {
      toast(`Couldn't switch to ${name}. ${toErrorInfo(error).message}`, "error");
    }
  });

  const [query, setQuery] = useState("");
  const activeId = state.settings.activeIdentityId;
  const shown = state.identities.filter((i) => matches(query, i.name, i.mspId, i.networkName, i.organization, i.role));
  const groups = groupByNetwork(shown, state.networks, activeId);
  // Networks with no identities left (all removed, or a CSR still pending) stay reachable for their settings.
  const empty = query
    ? []
    : state.networks.filter((n) => !state.identities.some((i) => i.networkId === n.id));

  return (
    <>
      <BackHeader
        title="Identities"
        onBack={() => navigate({ name: "home" })}
        action={{ label: "Add", icon: "plus", onClick: () => navigate({ name: "add" }) }}
      />
      <main className="page stack--loose">
        {state.identities.length >= FILTER_FROM && (
          <FilterInput value={query} onChange={setQuery} label="Filter identities and networks" />
        )}

        {groups.map((group) => (
          <section key={group.networkId} className="stagger stack" aria-label={group.network?.name}>
            <GroupHeading
              title={group.network?.name ?? "Unknown network"}
              detail={group.network?.mspId}
              action={
                group.network
                  ? { label: `Network settings for ${group.network.name}`, onClick: () => navigate({ name: "network", networkId: group.networkId }) }
                  : undefined
              }
            />
            {group.identities.map((identity) => (
              <div key={identity.id} className={`manage-row ${leaving.isLeaving(identity.id) ? "is-leaving" : ""}`}>
                <IdentityOption
                  identity={identity}
                  active={identity.id === activeId}
                  showMsp={false}
                  onSelect={() => void select.run(identity.id, identity.name)}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  aria-label={`Remove ${identity.name}`}
                  title={`Remove ${identity.name}`}
                  onClick={(e) => void remove(identity.id, identity.name, identity.mspId, e.currentTarget.closest(".manage-row"))}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            ))}
          </section>
        ))}

        {empty.map((network) => (
          <section key={network.id} className="stack" aria-label={network.name}>
            <GroupHeading
              title={network.name}
              detail={network.mspId}
              action={{ label: `Network settings for ${network.name}`, onClick: () => navigate({ name: "network", networkId: network.id }) }}
            />
            <p className="subtle type-xs flat inset-x">No identities on this network.</p>
          </section>
        ))}

        {query && groups.length === 0 && (
          <Empty icon="search" action={{ label: "Clear filter", onClick: () => setQuery("") }}>
            Nothing matches “{query}”.
          </Empty>
        )}

        {state.pendingCsrs.length > 0 && (
          <div className="stack">
            <h2 className="eyebrow">Waiting for a certificate</h2>
            {state.pendingCsrs.map((p) => (
              <button
                key={p.id}
                type="button"
                className="identity-option"
                onClick={() => navigate({ name: "complete-csr", pendingId: p.id })}
              >
                <span className="avatar" aria-hidden="true">
                  {p.commonName.trim().charAt(0) || "?"}
                </span>
                <span className="list-item__body">
                  <span className="list-item__title">{p.commonName}</span>
                  <span className="subtle one-line type-xs">{p.networkName}. Paste the issued certificate.</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {VoterCredentialGroup && voterCredentialsOf(state).length > 0 && !query && (
          <Suspense fallback={null}>
            <VoterCredentialGroup credentials={voterCredentialsOf(state)} fresh={fresh} navigate={navigate} />
          </Suspense>
        )}

        {state.identities.length === 0 && voterCredentialsOf(state).length === 0 && <AddIdentityOptions navigate={navigate} from="identities" />}

        <div className="row type-xs muted push-down">
          <Icon name="shield" size={18} />
          Private keys are created in this browser, encrypted with your password, and can never be exported, even by Weft.
        </div>
      </main>
    </>
  );
}

/** Its own screen, so adding an identity stays one tap away however long the list gets. */
export function AddIdentity({ state, navigate }: { state: WalletState; navigate: Navigate }) {
  return (
    <>
      <BackHeader title="Add an identity" onBack={() => navigate({ name: state.identities.length ? "identities" : "home" })} />
      <main className="page">
        <AddIdentityOptions navigate={navigate} showHeading={false} expanded from="add" />
      </main>
    </>
  );
}

/**
 * The ways to add an identity. The invite is the one most people take, so it
 * is the one tile, with the sentence that says what an invite looks like; the
 * three expert paths sit behind "More ways to add an identity" (a
 * .reversible, so closing it early turns back from where it is). On the Add
 * screen (`expanded`) all of them are shown.
 */
export function AddIdentityOptions({
  navigate,
  showHeading = true,
  expanded = false,
  from,
}: {
  navigate: Navigate;
  showHeading?: boolean;
  /** Show the expert paths without the disclosure. */
  expanded?: boolean;
  /** The screen these options are on, which the form's Back returns to. */
  from: AddFrom;
}) {
  const [more, setMore] = useState(expanded);
  return (
    <div className="welcome__add">
      {showHeading && <h2 className="eyebrow">Add an identity</h2>}
      <button type="button" className="invite-tile" onClick={() => navigate({ name: "join", from })}>
        <Icon name="qr" color="var(--weft-accent-text)" />
        <span className="invite-tile__text">
          <span className="strong">Join from an invite</span>
          <span className="muted type-xs">Your administrator's invite is a link or a QR code.</span>
        </span>
      </button>
      {!expanded && (
        <button type="button" className="disclosure disclosure--plain" aria-expanded={more} aria-controls="more-ways" onClick={() => setMore(!more)}>
          More ways to add an identity
          <Icon name="chevron" size={16} />
        </button>
      )}
      <div id="more-ways" className={`add-grid${expanded ? "" : ` reversible reversible--down${more ? " is-open" : ""}`}`} hidden={!more}>
        <button type="button" className="add-tile" onClick={() => navigate({ name: "enroll", from })}>
          <Icon name="key" size={18} />
          Enrol with CA
        </button>
        <button type="button" className="add-tile" onClick={() => navigate({ name: "import", from })}>
          <Icon name="file" size={18} />
          Import PEM
        </button>
        <button type="button" className="add-tile" onClick={() => navigate({ name: "csr", from })}>
          <Icon name="upload" size={18} />
          Generate CSR
        </button>
      </div>
    </div>
  );
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
