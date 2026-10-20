import { useState } from "react";
import { ui, type WalletState } from "../../lib/messages";
import { useFeedback } from "../feedback";
import { BackHeader, Empty, Icon } from "../ui";
import { FILTER_FROM, FilterInput, GroupHeading, groupByNetwork, matches } from "./lists";
import { IdentityOption } from "./Home";
import type { Navigate } from "./state";

export function Identities({
  state,
  onState,
  navigate,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  navigate: Navigate;
}) {
  const { confirm, toast } = useFeedback();
  const remove = async (identityId: string, name: string, mspId: string) => {
    const last = state.identities.length === 1;
    const ok = await confirm({
      title: `Remove ${name}?`,
      body: (
        <>
          <p style={{ margin: "0 0 8px" }}>
            The private key for <span className="mono">{name}</span> ({mspId}) is deleted from this browser. It can't be
            recovered, not even by Weft.
          </p>
          <p style={{ margin: 0 }}>
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
    onState(await ui("removeIdentity", { identityId }));
    toast(`Removed ${name}`);
  };

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
      <main className="page" style={{ gap: 18 }}>
        {state.identities.length >= FILTER_FROM && (
          <FilterInput value={query} onChange={setQuery} label="Filter identities and networks" />
        )}

        {groups.map((group) => (
          <section key={group.networkId} style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label={group.network?.name}>
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
              <div key={identity.id} className="manage-row">
                <IdentityOption
                  identity={identity}
                  active={identity.id === activeId}
                  showMsp={false}
                  onSelect={async () => onState(await ui("setActive", { identityId: identity.id }))}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  aria-label={`Remove ${identity.name}`}
                  title={`Remove ${identity.name}`}
                  onClick={() => void remove(identity.id, identity.name, identity.mspId)}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            ))}
          </section>
        ))}

        {empty.map((network) => (
          <section key={network.id} style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label={network.name}>
            <GroupHeading
              title={network.name}
              detail={network.mspId}
              action={{ label: `Network settings for ${network.name}`, onClick: () => navigate({ name: "network", networkId: network.id }) }}
            />
            <p className="subtle" style={{ fontSize: 12, margin: "0 4px" }}>
              No identities on this network.
            </p>
          </section>
        ))}

        {query && groups.length === 0 && <Empty icon="search">Nothing matches "{query}".</Empty>}

        {state.pendingCsrs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="eyebrow">Waiting for a certificate</div>
            {state.pendingCsrs.map((p) => (
              <button
                key={p.id}
                type="button"
                className="identity-option"
                onClick={() => navigate({ name: "complete-csr", pendingId: p.id })}
              >
                <span className="avatar">{p.commonName.charAt(0)}</span>
                <span className="list-item__body">
                  <span className="list-item__title">{p.commonName}</span>
                  <span className="subtle one-line" style={{ fontSize: 12 }}>
                    {p.networkName}. Paste the issued certificate.
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {state.identities.length === 0 && <AddIdentityOptions navigate={navigate} />}

        <div className="row" style={{ marginTop: "auto", fontSize: 12, color: "var(--weft-text-muted)" }}>
          <Icon name="shield" size={18} />
          Private keys are created in this browser and can never be exported, even by Weft.
        </div>
      </main>
    </>
  );
}

/** Its own screen, so adding an identity stays one tap away however long the list gets. */
export function AddIdentity({ state, navigate }: { state: WalletState; navigate: Navigate }) {
  return (
    <>
      <BackHeader
        title="Add an identity"
        onBack={() => navigate({ name: state.identities.length ? "identities" : "home" })}
      />
      <main className="page">
        <AddIdentityOptions navigate={navigate} showHeading={false} />
      </main>
    </>
  );
}

export function AddIdentityOptions({ navigate, showHeading = true }: { navigate: Navigate; showHeading?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {showHeading && <div className="eyebrow">Add an identity</div>}
      <button type="button" className="invite-tile" onClick={() => navigate({ name: "join" })}>
        <Icon name="qr" color="var(--weft-thread)" />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 500 }}>Join from an org invite</span>
          <span className="muted" style={{ fontSize: 12 }}>
            Paste the link from your network admin
          </span>
        </span>
      </button>
      <div className="add-grid">
        <button type="button" className="add-tile" onClick={() => navigate({ name: "enroll" })}>
          <Icon name="key" size={18} />
          Enrol with CA
        </button>
        <button type="button" className="add-tile" onClick={() => navigate({ name: "import" })}>
          <Icon name="file" size={18} />
          Import PEM
        </button>
        <button type="button" className="add-tile" onClick={() => navigate({ name: "csr" })}>
          <Icon name="upload" size={18} />
          Generate CSR
        </button>
      </div>
    </div>
  );
}
