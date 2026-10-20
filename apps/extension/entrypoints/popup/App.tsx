import { useRef, useState } from "react";
import { CompleteCsr, CsrForm, EnrollForm, ImportForm, JoinInvite } from "../../components/popup/AddForms";
import { Home } from "../../components/popup/Home";
import { AddIdentity, AddIdentityOptions, Identities } from "../../components/popup/Identities";
import { NetworkSettings } from "../../components/popup/NetworkSettings";
import { Security } from "../../components/popup/Security";
import { CreatePassword, Unlock } from "../../components/lock";
import { TxDetail } from "../../components/popup/TxDetail";
import { useWallet, type Route } from "../../components/popup/state";
import { FeedbackProvider } from "../../components/feedback";
import { Spinner, WeaveMark } from "../../components/ui";

/** How deep each screen sits, so moving deeper slides one way and back the other. */
const DEPTH: Record<Route["name"], number> = {
  home: 0,
  identities: 1,
  tx: 1,
  add: 2,
  network: 2,
  security: 1,
  "complete-csr": 2,
  join: 3,
  enroll: 3,
  import: 3,
  csr: 3,
};

export function App() {
  return (
    <FeedbackProvider>
      <Screens />
    </FeedbackProvider>
  );
}

function Screens() {
  const { state, setState, error, refresh } = useWallet();
  const [route, setRoute] = useState<Route>({ name: "home" });
  const direction = useRef<"forward" | "back" | "none">("none");
  const visits = useRef(0);

  const navigate = (next: Route) => {
    direction.current = DEPTH[next.name] >= DEPTH[route.name] ? "forward" : "back";
    visits.current += 1;
    setRoute(next);
  };

  if (error) {
    return (
      <div className="status-screen">
        <div className="error-text">{error}</div>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="splash">
        <Spinner />
      </div>
    );
  }

  const onDone = async () => {
    await refresh();
    navigate({ name: "home" });
  };
  const props = { state, navigate, onDone };

  // The lock comes before everything else (docs/adr/0005).
  if (state.vault.state === "locked") {
    return (
      <div className="screen fade-in">
        <Unlock
          status={state.vault}
          passkey="window"
          onUnlocked={() => {
            setRoute({ name: "home" });
            void refresh();
          }}
        />
      </div>
    );
  }
  if (state.vault.state === "none" && (state.identities.length > 0 || state.pendingCsrs.length > 0)) {
    return (
      <div className="screen fade-in">
        <CreatePassword
          heading="Weft needs a password now"
          intro="Weft now encrypts private keys with a password and locks itself when you're not using it. Set one to keep going."
          onDone={() => void refresh()}
        />
      </div>
    );
  }
  const savesKey = route.name === "join" || route.name === "enroll" || route.name === "import" || route.name === "csr";
  if (state.vault.state === "none" && savesKey) {
    return (
      <div className="screen" data-dir="forward">
        <CreatePassword
          intro="Weft encrypts your private keys with this password before it saves them, and asks for it again after it locks."
          onDone={() => void refresh()}
          onCancel={() => navigate({ name: "home" })}
        />
      </div>
    );
  }

  let screen;
  switch (route.name) {
    case "security":
      screen = <Security state={state} onState={setState} navigate={navigate} />;
      break;
    case "identities":
      screen = <Identities state={state} onState={setState} navigate={navigate} />;
      break;
    case "add":
      screen = <AddIdentity state={state} navigate={navigate} />;
      break;
    case "join":
      screen = <JoinInvite {...props} />;
      break;
    case "enroll":
      screen = <EnrollForm {...props} />;
      break;
    case "import":
      screen = <ImportForm {...props} />;
      break;
    case "csr":
      screen = <CsrForm {...props} />;
      break;
    case "complete-csr":
      screen = <CompleteCsr {...props} pendingId={route.pendingId} />;
      break;
    case "tx":
      screen = <TxDetail state={state} activityId={route.activityId} navigate={navigate} />;
      break;
    case "network":
      screen = <NetworkSettings state={state} onState={setState} networkId={route.networkId} navigate={navigate} />;
      break;
    case "home":
      screen =
        state.identities.length === 0 ? (
          <Welcome navigate={navigate} />
        ) : (
          <Home state={state} onState={setState} navigate={navigate} />
        );
  }

  return (
    <div key={visits.current} className="screen" data-dir={direction.current}>
      {screen}
    </div>
  );
}

function Welcome({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <main className="page" style={{ gap: 24, paddingTop: 40 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 16 }}>
        <WeaveMark size={72} mode="draw" />
        {/* The words follow once the mark has drawn itself. */}
        <div className="fade-in" style={{ animationDelay: "420ms", animationFillMode: "both" }}>
          <div className="mono" style={{ fontSize: 40, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1 }}>
            weft
          </div>
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 15 }}>
            An identity wallet for Hyperledger Fabric. It holds the certificate your organisation's CA issued and signs only the transactions you approve.
          </p>
        </div>
      </div>
      <AddIdentityOptions navigate={navigate} />
    </main>
  );
}
