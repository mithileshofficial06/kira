/**
 * Kira's orb: a dark glass sphere with colored light that follows the voice
 * loop. Shared by the VS Code assistant and the phone page. Browser only.
 */

export type OrbMode = "offline" | "muted" | "idle" | "hearing" | "thinking" | "speaking" | "working";

export interface OrbState {
  mode: OrbMode;
  /** Microphone RMS (0..1) while hearing. */
  level: number;
}

const blobs = [
  { hue: 190, speed: 0.7, phase: 0, lobes: 3 },
  { hue: 285, speed: -0.55, phase: 2.1, lobes: 4 },
  { hue: 330, speed: 0.45, phase: 4.2, lobes: 2 },
  { hue: 220, speed: -0.8, phase: 1.3, lobes: 5 },
];

function targetEnergy(m: OrbMode, level: number, t: number): number {
  switch (m) {
    case "offline":
      return 0.02;
    case "muted":
      return 0.05;
    case "idle":
      return 0.1 + 0.04 * Math.sin(t * 1.6);
    case "hearing": {
      // rms 0.003 (quiet) .. 0.15 (loud) on a log scale -> 0.25 .. 1
      const db = Math.log10(Math.max(level, 0.003) / 0.003) / Math.log10(50);
      return 0.25 + 0.75 * Math.min(1, db);
    }
    case "thinking":
      return 0.3 + 0.08 * Math.sin(t * 5);
    case "speaking": {
      // Syllable-like pulses, since Kira's own audio is not metered.
      const s = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1) + 0.4 * Math.sin(t * 11.7));
      return 0.3 + 0.5 * Math.min(1, s);
    }
    case "working":
      return 0.18 + 0.05 * Math.sin(t * 2.2);
  }
}

/** Animates `canvas` (square, sized by CSS) forever. `state` is read every frame; `onFrame` runs after each. */
export function startOrb(canvas: HTMLCanvasElement, state: () => OrbState, onFrame?: (s: OrbState) => void): void {
  const ctx = canvas.getContext("2d")!;
  let energy = 0;
  let spin = 0;
  let t0 = performance.now();

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - t0) / 1000);
    t0 = now;
    const t = now / 1000;
    const s = state();
    const m = s.mode;
    const target = targetEnergy(m, s.level, t);
    energy += (target - energy) * Math.min(1, dt * (target > energy ? 14 : 5));
    spin += dt * (m === "thinking" ? 2.6 : m === "working" ? 1.2 : m === "offline" ? 0.1 : 0.6);

    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2;
    const R = size * 0.34;
    const grey = m === "offline" || m === "muted";

    // Glow behind the sphere.
    const glow = ctx.createRadialGradient(c, c, R * 0.6, c, c, R * (1.35 + energy * 0.35));
    glow.addColorStop(0, `hsla(${grey ? 220 : 250}, ${grey ? 5 : 80}%, 60%, ${0.18 + energy * 0.3})`);
    glow.addColorStop(1, "hsla(250, 80%, 60%, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(c, c, R * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // The sphere: a dark glass ball, so the colors read on light and dark themes alike.
    const ball = ctx.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
    ball.addColorStop(0, "#1d2033");
    ball.addColorStop(1, "#05060c");
    ctx.fillStyle = ball;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R * 0.985, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const a = spin * b.speed + b.phase;
      const off = R * (0.12 + energy * 0.22);
      const bx = c + Math.cos(a) * off;
      const by = c + Math.sin(a * 1.3) * off;
      const r = R * (0.5 + energy * 0.42);
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const th = (i / 64) * Math.PI * 2;
        const wob = 1 + (0.06 + energy * 0.22) * Math.sin(th * b.lobes + t * (1.5 + energy * 4) * Math.sign(b.speed) + b.phase);
        const x = bx + Math.cos(th) * r * wob;
        const y = by + Math.sin(th) * r * wob;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, r * 1.1);
      const sat = grey ? 8 : 90;
      g.addColorStop(0, `hsla(${b.hue}, ${sat}%, 62%, ${0.55 + energy * 0.35})`);
      g.addColorStop(0.6, `hsla(${b.hue}, ${sat}%, 50%, ${0.25 + energy * 0.2})`);
      g.addColorStop(1, `hsla(${b.hue}, ${sat}%, 40%, 0)`);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();

    // Glass highlight and rim.
    const hl = ctx.createRadialGradient(c - R * 0.35, c - R * 0.45, 0, c - R * 0.35, c - R * 0.45, R * 0.6);
    hl.addColorStop(0, "rgba(255,255,255,0.22)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + energy * 0.15})`;
    ctx.stroke();

    // Working or thinking: a slow ring of dots around the sphere.
    if (m === "working" || m === "thinking") {
      ctx.fillStyle = m === "thinking" ? "rgba(190,160,255,0.8)" : "rgba(120,200,255,0.7)";
      for (let i = 0; i < 3; i++) {
        const a = spin * 1.5 + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(c + Math.cos(a) * R * 1.16, c + Math.sin(a) * R * 1.16, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    onFrame?.(s);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
