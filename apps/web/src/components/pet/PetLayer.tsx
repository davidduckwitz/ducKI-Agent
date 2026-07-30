/**
 * Pet Layer
 *
 * The always-mounted overlay that puts the pet on top of the app window and wires
 * it to what is happening: agent activity, connection state, mouse interaction and
 * the commands the settings panel sends.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../lib/store";
import { usePetStore } from "../../lib/petStore";
import { useI18n } from "../../lib/i18n";
import { getPetById } from "./petRegistry";
import { usePetEngine, type PetEngine } from "./usePetEngine";
import { PetView } from "./PetView";
import type { PetStateId } from "./petTypes";
import "./pet.css";

const BUBBLE_DURATION_MS = 3200;
const POKE_PHRASE_KEYS = ["pet.bubble.poke1", "pet.bubble.poke2", "pet.bubble.poke3", "pet.bubble.poke4"];

export function PetLayer() {
  const { t } = useI18n();
  const navigate = useNavigate();

  const enabled = usePetStore((s) => s.enabled);
  const petId = usePetStore((s) => s.petId);
  const size = usePetStore((s) => s.size);
  const speed = usePetStore((s) => s.speed);
  const opacity = usePetStore((s) => s.opacity);
  const followCursor = usePetStore((s) => s.followCursor);
  const reactToEvents = usePetStore((s) => s.reactToEvents);
  const showBubbles = usePetStore((s) => s.showBubbles);
  const locomotionMode = usePetStore((s) => s.locomotion);
  const groundOffset = usePetStore((s) => s.groundOffset);
  const customPets = usePetStore((s) => s.customPets);
  const command = usePetStore((s) => s.command);
  const setEnabled = usePetStore((s) => s.setEnabled);

  const isLoading = useAppStore((s) => s.isLoading);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const connected = useAppStore((s) => s.connected);

  const pet = getPetById(petId, customPets);
  const locomotion = locomotionMode === "auto" ? pet.locomotion : locomotionMode;

  const [bubble, setBubble] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const bubbleTimer = useRef<number | undefined>(undefined);

  // Read once: the engine owns the position from here on and writes it back on rest.
  const initialPosition = useRef(usePetStore.getState().position).current;

  const say = useCallback(
    (text: string) => {
      if (!usePetStore.getState().showBubbles) return;
      setBubble(text);
      window.clearTimeout(bubbleTimer.current);
      bubbleTimer.current = window.setTimeout(() => setBubble(null), BUBBLE_DURATION_MS);
    },
    []
  );

  useEffect(() => {
    if (!showBubbles) setBubble(null);
  }, [showBubbles]);

  useEffect(() => () => window.clearTimeout(bubbleTimer.current), []);

  // handlePoke runs inside the engine, which does not exist yet at this point -
  // the ref closes the loop once the hook below has returned.
  const engineRef = useRef<PetEngine | null>(null);

  const handlePoke = useCallback(() => {
    const key = POKE_PHRASE_KEYS[Math.floor(Math.random() * POKE_PHRASE_KEYS.length)] as string;
    say(t(key));
    engineRef.current?.react("wave", 1400);
  }, [say, t]);

  const engine = usePetEngine({
    enabled,
    size,
    speed,
    locomotion,
    followCursor,
    groundOffset,
    initialPosition,
    onRest: (position) => usePetStore.getState().setPosition(position),
    onPoke: handlePoke,
  });
  engineRef.current = engine;

  const { react: petReact, setActivity, reset: resetPet } = engine;

  // ------------------------------------------------------------ agent reactions

  const previousLoading = useRef(isLoading);
  const previousConnected = useRef(connected);
  const previousStatus = useRef(agentStatus);

  useEffect(() => {
    if (!reactToEvents) {
      setActivity("none");
      return;
    }

    if (isLoading && !previousLoading.current) {
      setActivity("work");
      say(t("pet.bubble.working"));
    } else if (!isLoading && previousLoading.current) {
      setActivity(connected ? "none" : "fail");
      petReact("jump", 1800);
      say(t("pet.bubble.done"));
    } else if (isLoading) {
      setActivity("work");
    }

    previousLoading.current = isLoading;
  }, [isLoading, reactToEvents, connected, petReact, setActivity, say, t]);

  useEffect(() => {
    if (!reactToEvents) return;

    if (!connected && previousConnected.current) {
      setActivity("fail");
      say(t("pet.bubble.offline"));
    } else if (connected && !previousConnected.current) {
      setActivity(useAppStore.getState().isLoading ? "work" : "none");
      petReact("wave", 1600);
      say(t("pet.bubble.online"));
    }

    previousConnected.current = connected;
  }, [connected, reactToEvents, petReact, setActivity, say, t]);

  useEffect(() => {
    if (!reactToEvents) return;

    if (agentStatus === "error" && previousStatus.current !== "error") {
      petReact("fail", 2600);
      say(t("pet.bubble.error"));
    }

    previousStatus.current = agentStatus;
  }, [agentStatus, reactToEvents, petReact, say, t]);

  // Greet once when the pet comes out (or after switching to another pet).
  useEffect(() => {
    if (!enabled) return;
    petReact("wave", 1800);
    say(t("pet.bubble.hello"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, petId]);

  // ------------------------------------------------------- commands from settings

  const previousCommandNonce = useRef(command.nonce);
  useEffect(() => {
    if (command.nonce === previousCommandNonce.current) return;
    previousCommandNonce.current = command.nonce;

    if (command.action === "reset") {
      resetPet();
      say(t("pet.bubble.hello"));
      return;
    }
    petReact(command.action as PetStateId, 2200);
  }, [command, petReact, resetPet, say, t]);

  // ------------------------------------------------------------------ menu

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!enabled) return null;

  return (
    <>
      <div
        ref={engine.containerRef}
        className="pet-root"
        style={{ width: size, height: size, opacity }}
        data-pet-id={pet.id}
      >
        {bubble && (
          <div className="pet-bubble rounded-lg border border-border bg-card px-2 py-1 text-[11px] text-foreground shadow-lg">
            {bubble}
          </div>
        )}

        <div
          className="pet-grab"
          data-dragging={engine.dragging}
          onPointerDown={engine.onPointerDown}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          role="img"
          aria-label={t("pet.aria.label").replace("{name}", pet.name)}
          title={pet.name}
        >
          <PetView pet={pet} state={engine.state} facing={engine.facing} size={size} />
        </div>
      </div>

      {menu && (
        <div
          className="fixed z-[60] min-w-[10rem] rounded-lg border border-border bg-popover py-1 text-xs shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 190),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <PetMenuItem
            label={t("pet.menu.wave")}
            onClick={() => {
              engine.react("wave", 1800);
              say(t("pet.bubble.hello"));
              setMenu(null);
            }}
          />
          <PetMenuItem
            label={t("pet.menu.jump")}
            onClick={() => {
              engine.react("jump", 1600);
              setMenu(null);
            }}
          />
          <PetMenuItem
            label={t("pet.menu.sleep")}
            onClick={() => {
              engine.react("sleep", 8000);
              setMenu(null);
            }}
          />
          <PetMenuItem
            label={t("pet.menu.resetPosition")}
            onClick={() => {
              engine.reset();
              setMenu(null);
            }}
          />
          <div className="my-1 border-t border-border" />
          <PetMenuItem
            label={t("pet.menu.settings")}
            onClick={() => {
              setMenu(null);
              navigate("/settings");
            }}
          />
          <PetMenuItem
            label={t("pet.menu.hide")}
            onClick={() => {
              setMenu(null);
              setEnabled(false);
            }}
          />
        </div>
      )}
    </>
  );
}

function PetMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-popover-foreground hover:bg-accent"
    >
      {label}
    </button>
  );
}
