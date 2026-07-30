/**
 * Pet Engine
 *
 * Drives the pet: gravity + walking for ground pets, steering + hovering for air
 * pets, cursor chasing, startling, and drag & drop with throw momentum.
 *
 * The simulation lives in a ref and writes the position straight to the DOM node's
 * transform on every animation frame - React only re-renders when the *visual*
 * state changes (idle -> walk -> sleep ...), which happens a few times a second at
 * most instead of 60 times.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PetLocomotion, PetPosition, PetStateId } from "./petTypes";

const GRAVITY = 2100; // px/s^2
const MAX_FALL_SPEED = 2200;
const WALK_SPEED = 46; // px/s at speed = 1
const RUN_SPEED = 165;
const AIR_SPEED = 105;
const BOUNCE_DAMPING = 0.28;
const THROW_SPEED_LIMIT = 2000;
const SLEEP_AFTER_MS = 60_000;
const CURSOR_IDLE_MS = 2500;
const CHASE_DISTANCE = 90;
const STARTLE_DISTANCE = 60;
const STARTLE_CURSOR_SPEED = 900; // px/s
const STARTLE_COOLDOWN_MS = 4000;
const DRAG_CLICK_TOLERANCE = 5; // px of movement that still counts as a click

export type PetActivity = "none" | "work" | "fail";

interface UsePetEngineOptions {
  enabled: boolean;
  size: number;
  speed: number;
  locomotion: PetLocomotion;
  followCursor: boolean;
  /** Space kept free at the bottom of the window (status bar). */
  groundOffset: number;
  initialPosition: PetPosition | null;
  /** Called when the pet comes to rest somewhere new, so the position can be persisted. */
  onRest?: (position: PetPosition) => void;
  /** Called when the pet is clicked (a press that did not turn into a drag). */
  onPoke?: () => void;
}

export interface PetEngine {
  /** Attach to the positioned wrapper element. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Attach to the grabbable sprite element. */
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  state: PetStateId;
  facing: 1 | -1;
  dragging: boolean;
  /** Play a one-shot reaction (wave, jump, fail, ...). */
  react: (state: PetStateId, durationMs?: number) => void;
  /** Set the ongoing mood that shows whenever no reaction is playing. */
  setActivity: (activity: PetActivity) => void;
  /** Put the pet back in the middle of the window. */
  reset: () => void;
}

interface Sim {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  moving: boolean;
  running: boolean;
  asleep: boolean;
  dragging: boolean;
  dragOffsetX: number;
  dragOffsetY: number;
  dragDistance: number;
  samples: Array<{ x: number; y: number; t: number }>;
  reactionState: PetStateId | null;
  reactionUntil: number;
  activity: PetActivity;
  decideAt: number;
  action: "idle" | "walk";
  dir: 1 | -1;
  targetX: number;
  targetY: number;
  targetUntil: number;
  lastInteractionAt: number;
  nextStartleAt: number;
  bobPhase: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function usePetEngine(options: UsePetEngineOptions): PetEngine {
  const containerRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState<PetStateId>("idle");
  const [facing, setFacing] = useState<1 | -1>(1);
  const [dragging, setDragging] = useState(false);

  // Options are read inside the animation loop; a ref keeps the loop stable while
  // still seeing fresh values when the user changes settings mid-flight.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const simRef = useRef<Sim>({
    x: options.initialPosition?.x ?? 120,
    y: options.initialPosition?.y ?? 200,
    vx: 0,
    vy: 0,
    facing: 1,
    grounded: false,
    moving: false,
    running: false,
    asleep: false,
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragDistance: 0,
    samples: [],
    reactionState: null,
    reactionUntil: 0,
    activity: "none",
    decideAt: 0,
    action: "idle",
    dir: 1,
    targetX: 0,
    targetY: 0,
    targetUntil: 0,
    lastInteractionAt: Date.now(),
    nextStartleAt: 0,
    bobPhase: 0,
  });

  const cursorRef = useRef({ x: -9999, y: -9999, movedAt: 0, speed: 0 });
  const reducedMotionRef = useRef(false);

  // ---------------------------------------------------------------- public api

  const react = useCallback((reactionState: PetStateId, durationMs = 1600) => {
    const sim = simRef.current;
    sim.reactionState = reactionState;
    sim.reactionUntil = performance.now() + durationMs;
    sim.asleep = false;
    sim.lastInteractionAt = Date.now();
  }, []);

  const setActivity = useCallback((activity: PetActivity) => {
    const sim = simRef.current;
    if (sim.activity !== activity) {
      sim.activity = activity;
      if (activity !== "none") sim.asleep = false;
    }
  }, []);

  const reset = useCallback(() => {
    const sim = simRef.current;
    const { size, groundOffset, locomotion } = optionsRef.current;
    sim.x = Math.round(window.innerWidth / 2 - size / 2);
    sim.y =
      locomotion === "air"
        ? Math.round(window.innerHeight / 2 - size / 2)
        : window.innerHeight - size - groundOffset;
    sim.vx = 0;
    sim.vy = 0;
    sim.asleep = false;
    sim.lastInteractionAt = Date.now();
    optionsRef.current.onRest?.({ x: sim.x, y: sim.y });
  }, []);

  // ------------------------------------------------------------------ dragging

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const sim = simRef.current;
    const now = performance.now();

    sim.dragging = true;
    sim.dragDistance = 0;
    sim.dragOffsetX = event.clientX - sim.x;
    sim.dragOffsetY = event.clientY - sim.y;
    sim.vx = 0;
    sim.vy = 0;
    sim.asleep = false;
    sim.lastInteractionAt = Date.now();
    sim.samples = [{ x: sim.x, y: sim.y, t: now }];
    setDragging(true);

    const handleMove = (moveEvent: PointerEvent) => {
      const { size } = optionsRef.current;
      const nextX = clamp(moveEvent.clientX - sim.dragOffsetX, 0, window.innerWidth - size);
      const nextY = clamp(moveEvent.clientY - sim.dragOffsetY, 0, window.innerHeight - size);

      sim.dragDistance += Math.abs(nextX - sim.x) + Math.abs(nextY - sim.y);
      // The pet looks in the direction it is being pulled.
      if (Math.abs(nextX - sim.x) > 1) sim.facing = nextX > sim.x ? 1 : -1;
      sim.x = nextX;
      sim.y = nextY;

      const t = performance.now();
      sim.samples.push({ x: nextX, y: nextY, t });
      // Keep roughly the last 120ms - that window is what the throw velocity uses.
      while (sim.samples.length > 2 && t - (sim.samples[0]?.t ?? t) > 120) sim.samples.shift();
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);

      const first = sim.samples[0];
      const last = sim.samples[sim.samples.length - 1];
      if (first && last && last.t - first.t > 8) {
        const dt = (last.t - first.t) / 1000;
        sim.vx = clamp((last.x - first.x) / dt, -THROW_SPEED_LIMIT, THROW_SPEED_LIMIT);
        sim.vy = clamp((last.y - first.y) / dt, -THROW_SPEED_LIMIT, THROW_SPEED_LIMIT);
      }

      sim.dragging = false;
      sim.grounded = false;
      sim.samples = [];
      sim.lastInteractionAt = Date.now();
      setDragging(false);

      if (sim.dragDistance <= DRAG_CLICK_TOLERANCE) {
        sim.vx = 0;
        sim.vy = 0;
        optionsRef.current.onPoke?.();
      } else {
        optionsRef.current.onRest?.({ x: sim.x, y: sim.y });
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }, []);

  // ------------------------------------------------------------- cursor + prefs

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const cursor = cursorRef.current;
      const now = performance.now();
      const dt = Math.max(1, now - cursor.movedAt);
      const distance = Math.hypot(event.clientX - cursor.x, event.clientY - cursor.y);
      cursor.speed = (distance / dt) * 1000;
      cursor.x = event.clientX;
      cursor.y = event.clientY;
      cursor.movedAt = now;
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = query.matches;
    const listener = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches;
    };
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  // ------------------------------------------------------------------ main loop

  useEffect(() => {
    if (!options.enabled) return;

    const sim = simRef.current;
    let frame = 0;
    let last = performance.now();
    let publishedState: PetStateId | null = null;
    let publishedFacing: 1 | -1 | null = null;

    // Place the pet sensibly on first run (or after the window shrank a lot).
    const { size, groundOffset, locomotion } = optionsRef.current;
    sim.x = clamp(sim.x, 0, Math.max(0, window.innerWidth - size));
    sim.y = clamp(sim.y, 0, Math.max(0, window.innerHeight - size));
    if (locomotion === "ground" && !optionsRef.current.initialPosition) {
      sim.y = window.innerHeight - size - groundOffset;
    }

    const pickGroundAction = (now: number) => {
      if (reducedMotionRef.current) {
        sim.action = "idle";
        sim.decideAt = now + 5000;
        return;
      }
      const roll = Math.random();
      if (roll < 0.4) {
        sim.action = "idle";
        sim.decideAt = now + 1200 + Math.random() * 3000;
      } else {
        sim.action = "walk";
        sim.dir = Math.random() < 0.5 ? -1 : 1;
        sim.decideAt = now + 1500 + Math.random() * 3500;
      }
    };

    const pickAirTarget = (now: number, width: number, height: number, petSize: number) => {
      sim.targetX = Math.random() * Math.max(1, width - petSize);
      // Air pets prefer the upper two thirds of the window.
      sim.targetY = Math.random() * Math.max(1, height * 0.66 - petSize);
      sim.targetUntil = now + 2500 + Math.random() * 4000;
    };

    const resolveState = (): PetStateId => {
      if (sim.dragging) return "drag";

      const opts = optionsRef.current;
      if (opts.locomotion === "ground" && !sim.grounded) {
        return sim.vy < -60 ? "jump" : "fall";
      }
      if (sim.reactionState) return sim.reactionState;
      if (sim.activity === "fail") return "fail";
      if (sim.activity === "work") return "work";
      if (sim.asleep) return "sleep";
      if (opts.locomotion === "air") {
        return Math.hypot(sim.vx, sim.vy) > 620 ? "fall" : "fly";
      }
      if (sim.running) return "run";
      if (sim.moving) return "walk";
      return "idle";
    };

    const step = (now: number) => {
      frame = requestAnimationFrame(step);

      const dt = clamp((now - last) / 1000, 0, 0.05);
      last = now;

      const opts = optionsRef.current;
      const petSize = opts.size;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const maxX = Math.max(0, width - petSize);
      const maxY = Math.max(0, height - petSize);
      const ground = Math.max(0, height - petSize - opts.groundOffset);

      if (sim.reactionState && now > sim.reactionUntil) sim.reactionState = null;

      const cursor = cursorRef.current;
      const cursorActive = performance.now() - cursor.movedAt < CURSOR_IDLE_MS;
      const centerX = sim.x + petSize / 2;
      const centerY = sim.y + petSize / 2;
      const cursorDistance = Math.hypot(cursor.x - centerX, cursor.y - centerY);

      // A fast pointer sweeping past the pet makes it hop in surprise.
      if (
        !sim.dragging &&
        cursorActive &&
        cursorDistance < STARTLE_DISTANCE &&
        cursor.speed > STARTLE_CURSOR_SPEED &&
        now > sim.nextStartleAt
      ) {
        sim.nextStartleAt = now + STARTLE_COOLDOWN_MS;
        sim.asleep = false;
        sim.lastInteractionAt = Date.now();
        react("jump", 700);
        if (opts.locomotion === "ground") {
          sim.vy = -430;
          sim.grounded = false;
        } else {
          sim.vy = -260;
          sim.vx += cursor.x < centerX ? 220 : -220;
        }
      }

      if (sim.dragging) {
        sim.moving = false;
        sim.running = false;
      } else if (opts.locomotion === "ground") {
        // --- gravity -------------------------------------------------------
        sim.vy = Math.min(MAX_FALL_SPEED, sim.vy + GRAVITY * dt);
        sim.y += sim.vy * dt;

        if (sim.y >= ground) {
          sim.y = ground;
          if (sim.vy > 700) {
            sim.vy = -sim.vy * BOUNCE_DAMPING; // a thrown pet bounces once or twice
            sim.grounded = false;
          } else {
            sim.vy = 0;
            if (!sim.grounded) optionsRef.current.onRest?.({ x: sim.x, y: sim.y });
            sim.grounded = true;
          }
        } else {
          sim.grounded = false;
        }

        if (!sim.grounded) {
          // Airborne after a throw: keep the horizontal momentum, bounce off walls.
          sim.x += sim.vx * dt;
          sim.vx *= 1 - Math.min(0.9, dt * 0.6);
          if (sim.x <= 0 || sim.x >= maxX) {
            sim.x = clamp(sim.x, 0, maxX);
            sim.vx = -sim.vx * 0.5;
            sim.facing = sim.vx >= 0 ? 1 : -1;
          }
          sim.moving = false;
          sim.running = false;
        } else {
          sim.vx *= 1 - Math.min(0.9, dt * 8);

          const chasing = opts.followCursor && cursorActive && cursorDistance > CHASE_DISTANCE;
          if (chasing) {
            const dir: 1 | -1 = cursor.x > centerX ? 1 : -1;
            sim.x += dir * RUN_SPEED * opts.speed * dt;
            sim.facing = dir;
            sim.moving = true;
            sim.running = true;
            sim.asleep = false;
            sim.decideAt = now + 800;
          } else {
            if (now > sim.decideAt) pickGroundAction(now);
            if (sim.action === "walk" && !sim.asleep) {
              sim.x += sim.dir * WALK_SPEED * opts.speed * dt;
              sim.facing = sim.dir;
              sim.moving = true;
            } else {
              sim.moving = false;
            }
            sim.running = false;
          }

          if (sim.x <= 0 || sim.x >= maxX) {
            sim.x = clamp(sim.x, 0, maxX);
            sim.dir = (sim.dir * -1) as 1 | -1; // turn around at the window edge
            sim.facing = sim.dir;
          }
        }
      } else {
        // --- flying --------------------------------------------------------
        const chasing = opts.followCursor && cursorActive && cursorDistance > CHASE_DISTANCE;
        if (chasing) {
          sim.targetX = clamp(cursor.x - petSize / 2, 0, maxX);
          sim.targetY = clamp(cursor.y - petSize / 2, 0, maxY);
          sim.asleep = false;
        } else if (now > sim.targetUntil || (sim.targetX === 0 && sim.targetY === 0)) {
          pickAirTarget(now, width, height, petSize);
        }

        const targetSpeed = AIR_SPEED * opts.speed * (chasing ? 1.9 : 1) * (reducedMotionRef.current ? 0 : 1);
        const dx = sim.targetX - sim.x;
        const dy = sim.targetY - sim.y;
        const distance = Math.hypot(dx, dy) || 1;
        const desiredVx = (dx / distance) * targetSpeed;
        const desiredVy = (dy / distance) * targetSpeed;
        const steer = Math.min(1, dt * 2.2);
        sim.vx += (desiredVx - sim.vx) * steer;
        sim.vy += (desiredVy - sim.vy) * steer;

        sim.x += sim.vx * dt;
        sim.y += sim.vy * dt;

        if (sim.x <= 0 || sim.x >= maxX) {
          sim.x = clamp(sim.x, 0, maxX);
          sim.vx = -sim.vx * 0.6;
        }
        if (sim.y <= 0 || sim.y >= maxY) {
          sim.y = clamp(sim.y, 0, maxY);
          sim.vy = -sim.vy * 0.6;
        }

        if (Math.abs(sim.vx) > 10) sim.facing = sim.vx > 0 ? 1 : -1;
        sim.moving = Math.hypot(sim.vx, sim.vy) > 15;
        sim.running = chasing;
        sim.grounded = true; // air pets never "fall" out of the sky
        sim.bobPhase += dt * 2.4;
      }

      sim.x = clamp(sim.x, 0, maxX);
      sim.y = clamp(sim.y, 0, maxY);

      // Nothing happened for a while - take a nap.
      if (
        !sim.dragging &&
        !sim.moving &&
        sim.activity === "none" &&
        !sim.reactionState &&
        Date.now() - sim.lastInteractionAt > SLEEP_AFTER_MS
      ) {
        sim.asleep = true;
      }
      if (cursorActive && cursorDistance < STARTLE_DISTANCE * 2 && sim.asleep) {
        sim.asleep = false;
        sim.lastInteractionAt = Date.now();
        react("wave", 1200);
      }

      // --- render ---------------------------------------------------------
      const element = containerRef.current;
      if (element) {
        const bob = opts.locomotion === "air" ? Math.sin(sim.bobPhase) * 4 : 0;
        element.style.transform = `translate3d(${Math.round(sim.x)}px, ${Math.round(sim.y + bob)}px, 0)`;
      }

      const nextState = resolveState();
      if (nextState !== publishedState) {
        publishedState = nextState;
        setState(nextState);
      }
      if (sim.facing !== publishedFacing) {
        publishedFacing = sim.facing;
        setFacing(sim.facing);
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
      } else {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };

    const handleResize = () => {
      const opts = optionsRef.current;
      sim.x = clamp(sim.x, 0, Math.max(0, window.innerWidth - opts.size));
      sim.y = clamp(sim.y, 0, Math.max(0, window.innerHeight - opts.size));
    };

    frame = requestAnimationFrame(step);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
    };
  }, [options.enabled, react]);

  // Persist the resting spot when the pet goes away (settings change, unmount).
  useEffect(() => {
    return () => {
      const sim = simRef.current;
      optionsRef.current.onRest?.({ x: sim.x, y: sim.y });
    };
  }, []);

  // Memoized so consumers can put the engine in effect dependency lists without
  // re-running them on every frame-driven render.
  return useMemo(
    () => ({ containerRef, onPointerDown, state, facing, dragging, react, setActivity, reset }),
    [onPointerDown, state, facing, dragging, react, setActivity, reset]
  );
}
