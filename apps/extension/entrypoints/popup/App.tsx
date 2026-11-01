import { useEffect, useRef, useState, type ReactNode } from "react";
import { browser } from "wxt/browser";
import { CompleteCsr, CsrForm, EnrollForm, ImportForm, JoinInvite } from "../../components/popup/AddForms";
import { Home, type HomeMemory } from "../../components/popup/Home";
import { AddIdentity, AddIdentityOptions, Identities } from "../../components/popup/Identities";
import { NetworkSettings } from "../../components/popup/NetworkSettings";
import { Security } from "../../components/popup/Security";
import { CreatePassword, Unlock } from "../../components/lock";
import { TxDetail } from "../../components/popup/TxDetail";
import { usePendingApproval, useUiEvents, useWallet, type Route } from "../../components/popup/state";
import { FeedbackProvider, useFeedback } from "../../components/feedback";
import { Button, ErrorDetails, ReplayMark, Spinner, Splash, StatusScreen, WeaveMark, clockTime, tokenMs, useFocusOnArrival } from "../../components/ui";

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

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function App() {
  return (
    <FeedbackProvider>
      <Screens />
    </FeedbackProvider>
  );
}

/** A screen on its way out: kept over the new one until its leave has ended. */
interface Leaving {
  key: number;
  node: ReactNode;
  dir: "forward" | "back";
}

function Screens() {
  const { state, setState, error, refresh } = useWallet();
  const { toast, dismiss } = useFeedback();
  const [route, setRoute] = useState<Route>({ name: "home" });
  const direction = useRef<"forward" | "back" | "none">("none");
  const visits = useRef(0);
  // Home's tab and scroll position, kept while a deeper screen is open.
  const homeMemory = useRef<HomeMemory>({ tab: "activity", scrollTop: 0, fresh: [] });
  const [retrying, setRetrying] = useState(false);
  // When Try again last ran without Weft opening, for the line under it.
  const [triedAt, setTriedAt] = useState<string | null>(null);
  // The screen being left, drawn over the new one while it goes (SYSTEM.md,
  // Navigation: the old screen leaves in base-out against the direction of
  // travel, then unmounts).
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const current = useRef<{ key: number; node: ReactNode } | null>(null);

  const navigate = (next: Route) => {
    const dir = DEPTH[next.name] >= DEPTH[route.name] ? "forward" : "back";
    direction.current = dir;
    if (current.current && !still()) setLeaving({ ...current.current, dir });
    visits.current += 1;
    setRoute(next);
  };
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), tokenMs("--weft-duration-base-out", 154) + 30);
    return () => clearTimeout(t);
  }, [leaving]);

  // An approval window finishing (a join, a connection) can change what the
  // popup shows, so its state is read again.
  useUiEvents("approvals", () => void refresh());

  // A confirmation open when Weft locks (auto-lock, or locked in another
  // window) is cancelled: the lock screen is in front now, and what it asked
  // about shouldn't go ahead behind it.
  const isLocked = state?.vault.state === "locked";
  useEffect(() => {
    if (isLocked) dismiss();
  }, [isLocked, dismiss]);

  // The lock screen stays up while it holds (its loader showing, then
  // seating after the unlock), even once the state says Weft is unlocked.
  const [unlockHeld, setUnlockHeld] = useState(false);
  const lockUp = isLocked || (unlockHeld && state?.vault.state === "unlocked");
  // After an unlock, focus goes to the heading of the screen that was there
  // all along, once the lock screen has gone.
  const focusAfterUnlock = useRef(false);
  useEffect(() => {
    if (lockUp || !focusAfterUnlock.current || !state) return;
    focusAfterUnlock.current = false;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".screen h1")?.focus({ preventScroll: true }));
  }, [lockUp, state]);

  // Identities that arrive while the popup is open (from a join here, or in
  // an approval window) come in as new rows on the identities tab.
  // Checked as the screen is built, so Home opens on the identities tab when
  // the identity that brought it there has just arrived.
  const knownIds = useRef<Set<string> | null>(null);
  if (state) {
    const ids = state.identities.map((i) => i.id);
    if (knownIds.current) {
      const added = ids.filter((id) => !knownIds.current!.has(id));
      if (added.length) {
        homeMemory.current.fresh = [...homeMemory.current.fresh, ...added];
        homeMemory.current.tab = "identities";
        setTimeout(() => {
          homeMemory.current.fresh = homeMemory.current.fresh.filter((id) => !added.includes(id));
        }, tokenMs("--weft-rule-life", 4000) + 1000);
      }
    }
    knownIds.current = new Set(ids);
  }

  // The worker didn't answer, or not within WORKER_TIMEOUT_MS (the splash
  // gives up then). Try again asks again in place: the button keeps focus,
  // and the line under it says when it last tried.
  if (error) {
    return (
      <StatusScreen
        mark={<WeaveMark size={56} mode="still" />}
        title="Weft couldn't open"
        detail="Its background worker didn't answer. Try again, or close this popup and open it again."
      >
        <div className="status-screen__actions">
          <Button
            className="btn btn--primary"
            busy={retrying}
            onClick={async () => {
              setRetrying(true);
              setTriedAt(null);
              const opened = await refresh();
              setRetrying(false);
              if (!opened) setTriedAt(clockTime());
            }}
          >
            Try again
          </Button>
          {error.message && <ErrorDetails>{[error.message, error.detail].filter(Boolean).join(" ")}</ErrorDetails>}
        </div>
        <p className="status-screen__retry" role="status">
          {triedAt && `Tried again at ${triedAt}. If it still doesn't open, restart your browser. Your identities stay saved in Weft.`}
        </p>
      </StatusScreen>
    );
  }
  if (!state) return <Splash label="Opening Weft" />;

  const onDone = async (added?: string, to: "home" | "identities" = "home") => {
    await refresh();
    navigate({ name: to });
    if (added) toast(added);
  };
  const props = { state, navigate, onDone };

  if (state.vault.state === "none" && (state.identities.length > 0 || state.pendingCsrs.length > 0)) {
    return (
      <div className="screen fade-in">
        <CreatePassword
          heading="Weft needs a password now"
          intro="Weft now encrypts private keys with a password and locks itself when you're not using it. Set one to continue."
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

  const from = "from" in route ? route.from : undefined;
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
      screen = <JoinInvite {...props} from={from} />;
      break;
    case "enroll":
      screen = <EnrollForm {...props} from={from} />;
      break;
    case "import":
      screen = <ImportForm {...props} from={from} />;
      break;
    case "csr":
      screen = <CsrForm {...props} from={from} />;
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
          <Home state={state} onState={setState} navigate={navigate} memory={homeMemory.current} />
        );
  }

  // The lock comes before everything else (docs/adr/0005). A screen that was
  // open when Weft locked stays mounted underneath, hidden, so whatever was
  // typed into it is still there after unlocking.
  const locked = lockUp;
  if (!locked) current.current = { key: visits.current, node: screen };
  return (
    <>
      {locked && (
        <div className="screen fade-in">
          <Unlock
            status={state.vault}
            passkey="window"
            onUnlocked={() => {
              direction.current = "none";
              focusAfterUnlock.current = true;
              void refresh();
            }}
            onHold={setUnlockHeld}
            onReset={() => {
              direction.current = "none";
              setRoute({ name: "home" });
              void refresh();
            }}
          />
        </div>
      )}
      {(!locked || route.name !== "home") && (
        <div key={visits.current} className="screen" data-dir={locked ? undefined : direction.current} hidden={locked}>
          {screen}
        </div>
      )}
      {leaving && !locked && (
        <div key={`leaving-${leaving.key}`} className="screen is-leaving" data-dir={leaving.dir} aria-hidden="true" inert>
          {leaving.node}
        </div>
      )}
    </>
  );
}

/** Where the welcome remembers that its mark has been drawn: once per installation. */
const DRAWN_KEY = "welcomeDrawn";

/**
 * The first screen: the mark, the words, and the invite as the one way in.
 * The mark draws itself the first time Weft opens and is still after that;
 * everything arrives top to bottom, a stagger apart. While a site's approval
 * window is finishing a join, the welcome says so and waits.
 */
function Welcome({ navigate }: { navigate: (r: Route) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading);
  const [mode, setMode] = useState<"draw" | "still" | null>(null);
  useEffect(() => {
    let live = true;
    browser.storage.local
      .get(DRAWN_KEY)
      .then((stored) => {
        if (!live) return;
        if (stored[DRAWN_KEY]) return setMode("still");
        setMode("draw");
        void browser.storage.local.set({ [DRAWN_KEY]: true });
      })
      .catch(() => live && setMode("still"));
    return () => {
      live = false;
    };
  }, []);
  const joining = usePendingApproval("weft_addNetwork");

  return (
    <main className="page welcome stagger">
      <div className="welcome__mark">{mode && <ReplayMark size={72} draw={mode === "draw"} />}</div>
      <div className="welcome__words">
        <h1 ref={heading} tabIndex={-1} className="wordmark">
          weft
        </h1>
        <p className="muted">
          An identity wallet for Hyperledger Fabric. It holds the certificate your organisation's CA issued you and signs only
          the transactions you approve.
        </p>
      </div>
      {joining ? (
        <div className="waiting" role="status">
          <Spinner size={32} />
          <div className="waiting__text">
            <span className="strong">Finishing in the other window</span>
            <span className="muted type-xs">Your new identity appears here when it closes.</span>
          </div>
        </div>
      ) : (
        <AddIdentityOptions navigate={navigate} showHeading={false} from="home" />
      )}
    </main>
  );
}
