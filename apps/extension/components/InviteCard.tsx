import type { OrgInvite } from "@weftwallet/protocol";

/** What the user is about to join. Shown before they enter any secret. */
export function InviteCard({ invite }: { invite: OrgInvite }) {
  return (
    <section className="card" aria-label="Invite">
      <span className="eyebrow">You're joining</span>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{invite.network}</div>
      <dl className="details">
        <dt>Organisation</dt>
        <dd>{invite.organization}</dd>
        <dt>MSP ID</dt>
        <dd className="mono">{invite.mspId}</dd>
        <dt>Channels</dt>
        <dd className="mono">{invite.channels.join(", ")}</dd>
        <dt>CA</dt>
        <dd className="mono">{new URL(invite.caUrl).host}</dd>
        <dt>Relay</dt>
        <dd className="mono">{new URL(invite.relayUrl).host}</dd>
      </dl>
    </section>
  );
}
