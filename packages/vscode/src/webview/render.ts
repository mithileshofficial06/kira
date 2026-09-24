/** Pure HTML for each Flight Deck section. No DOM access: testable anywhere. */
import type { DeckState } from "../../../daemon/src/daemon/deck.js";

export interface RenderCtx {
  pendingAdrs: { id: number; title: string; body: string; adrId?: string }[];
  connection: { status: string; message?: string };
  now: number;
}

const LEVELS = ["observe", "propose", "step", "run", "trust"];
const STATE_CLASS: Record<string, string> = {
  IDLE: "idle",
  PLANNING: "busy",
  EXECUTING: "busy",
  VERIFYING: "busy",
  REPORTING: "busy",
  AWAITING_APPROVAL: "warn",
  RATE_LIMITED: "warn",
  INTERRUPTED: "bad",
};
const PLAN_ICON: Record<string, string> = { done: "✓", active: "▶", pending: "○", skipped: "⤼", failed: "✗" };

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const esc = escapeHtml;

export function renderSections(d: DeckState, ctx: RenderCtx): Record<string, string> {
  return {
    "s-header": header(d, ctx),
    "s-approvals": approvals(d),
    "s-controls": controls(d, ctx),
    "s-report": report(d),
    "s-plan": plan(d),
    "s-steps": steps(d),
    "s-diff": diff(d),
    "s-verify": verify(d),
    "s-memory": memory(d, ctx),
  };
}

function header(d: DeckState, ctx: RenderCtx): string {
  if (!d.run) {
    const note = ctx.connection.message ? `<p class="muted">${esc(ctx.connection.message)}</p>` : "";
    return `<h1>Kira</h1><p class="muted">No run yet. Give Kira a goal below.</p>${note}`;
  }
  const r = d.run;
  const state = d.report ? d.report.status.toUpperCase() : r.state.replace("_", " ");
  const cls = d.report ? (d.report.status === "done" ? "good" : "bad") : (STATE_CLASS[r.state] ?? "busy");
  const b = d.budget;
  const pct = b ? Math.min(100, Math.round(b.used * 100)) : 0;
  const rate = d.provider.rateLimited && r.state === "RATE_LIMITED"
    ? ` · <span class="warn-text">rate limited, resuming in ${Math.max(0, Math.ceil((d.provider.rateLimited.until - ctx.now) / 1000))}s</span>`
    : "";
  const downgraded = d.autonomyChanges.length ? ` <span class="warn-text" title="${esc(d.autonomyChanges.at(-1)?.reason)}">(lowered)</span>` : "";
  return `
    <div class="title-row"><span class="pill ${cls}">${esc(state)}</span><h1 title="${esc(r.goal)}">${esc(r.goal)}</h1></div>
    ${r.detail && !d.report ? `<p class="muted detail">${esc(r.detail)}</p>` : ""}
    <div class="meta">
      <span>autonomy <b>${r.autonomy} · ${LEVELS[r.autonomy] ?? "?"}</b>${downgraded}</span>
      <span>model <b>${esc(d.provider.model ?? "–")}</b>${d.provider.fallbacks ? ` · ${d.provider.fallbacks} fallback(s)` : ""}${rate}</span>
      ${b ? `<span>step <b>${b.steps}/${b.limits.maxSteps}</b> · <b>$${b.costUsd.toFixed(3)}</b> of $${b.limits.maxCostUsd} · ${b.tokens.toLocaleString()} tokens</span>` : ""}
    </div>
    ${b ? `<div class="bar" title="${pct}% of budget used"><div style="width:${pct}%"></div></div>` : ""}
    <p class="muted small">${esc(r.runId)} · ${esc(r.workspace)}</p>`;
}

function approvals(d: DeckState): string {
  const open = d.approvals.filter((a) => !a.resolved);
  return open
    .map(
      (a) => `
    <div class="approval">
      <div class="approval-head"><span class="badge warn">${esc(a.request.category)}</span> Kira is asking to run:</div>
      <pre>${esc(a.request.summary)}</pre>
      <div class="approval-actions">
        <input data-draft="note-${esc(a.id)}" placeholder="Reason (optional, saved as a decision)" />
        <button data-action="allow" data-id="${esc(a.id)}">Allow</button>
        <button data-action="deny" data-id="${esc(a.id)}" class="secondary">Deny</button>
      </div>
    </div>`,
    )
    .join("");
}

function controls(d: DeckState, ctx: RenderCtx): string {
  const running = !!d.run && !d.report && d.run.state !== "IDLE";
  if (running) return `<button data-action="stop" class="danger">■ Stop (Ctrl+Alt+End)</button><span class="muted"> stops cleanly: processes killed, the current step rewound</span>`;
  const disabled = ctx.connection.status === "starting" ? " disabled" : "";
  return `<div class="start"><input data-draft="goal" placeholder="What should Kira do? e.g. add a login page and verify it in the browser" /><button data-action="start"${disabled}>Start</button></div>`;
}

function report(d: DeckState): string {
  const r = d.report;
  if (!r) return "";
  const ok = r.status === "done";
  const list = (title: string, items: string[]) => (items.length ? `<h3>${title}</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
  return `
    <div class="report ${ok ? "good" : "bad"}">
      <h2>${ok ? "Done" : esc(r.status.toUpperCase())} · ${r.steps} steps · ${Math.round(r.durationMs / 1000)}s · $${r.budget.costUsd.toFixed(3)}</h2>
      <pre class="summary">${esc(r.summary)}</pre>
      ${list("Open questions", r.openQuestions)}
      ${list("Your decisions", r.decisions.map((x) => `${x.allow ? "Allowed" : "Declined"} ${x.category}: ${x.summary}${x.note ? ` — "${x.note}"` : ""}`))}
      ${list("Side effects rewind cannot undo", r.sideEffects)}
      ${list("Autonomy changes", r.autonomy.downgrades.map((x) => `${x.from} → ${x.to}: ${x.reason}`))}
      ${r.rewound ? `<p>Rewound step ${r.rewound.step}: ${r.rewound.restored.length} file(s) restored, ${r.rewound.removed.length} removed. Undo: <code>${esc(r.rewound.undoRef)}</code></p>` : ""}
      <p class="muted small">Models: ${esc(r.models.join(", ") || "–")}${r.fallbacks ? ` · ${r.fallbacks} fallback(s)` : ""}${r.rateLimitPauses ? ` · ${r.rateLimitPauses} rate-limit pause(s)` : ""} · malformed calls: ${r.malformedCalls}</p>
    </div>`;
}

function plan(d: DeckState): string {
  if (!d.plan.length) return `<p class="muted">No plan yet.</p>`;
  const scope = d.scope?.length ? `<p class="muted small">Scope: ${d.scope.map(esc).join(", ")}</p>` : "";
  return `<ol class="plan">${d.plan.map((s) => `<li class="plan-${s.status}"><span class="icon">${PLAN_ICON[s.status] ?? "○"}</span>${esc(s.title)}</li>`).join("")}</ol>${scope}`;
}

function steps(d: DeckState): string {
  if (!d.steps.length) return `<p class="muted">Nothing has run yet.</p>`;
  return [...d.steps]
    .reverse()
    .map(
      (s) => `
    <div class="step">
      <div class="step-head"><b>Step ${s.n}</b>${s.model ? ` <span class="muted small">${esc(s.model)}</span>` : ""}</div>
      ${s.narration.map((n) => `<p class="narration">${esc(n)}</p>`).join("")}
      ${s.calls
        .map(
          (c) => `
        <details class="call ${c.isError ? "error" : ""}${c.result === undefined ? " running" : ""}">
          <summary><code>${esc(c.name)}</code> ${esc(shortArgs(c.args))}${c.result === undefined ? ' <span class="muted">running…</span>' : c.isError ? ' <span class="bad-text">failed</span>' : ""}</summary>
          <pre>${esc(c.result ?? "")}</pre>
        </details>`,
        )
        .join("")}
      ${s.notes.filter((n) => !n.startsWith("checkpoint")).map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    </div>`,
    )
    .join("");
}

function shortArgs(args: string): string {
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const v = a.command ?? a.path ?? a.url ?? a.summary ?? a.id;
    if (typeof v === "string") return v.length > 90 ? `${v.slice(0, 89)}…` : v;
    if (Array.isArray(a.steps)) return `${a.steps.length} steps`;
  } catch {
    /* raw */
  }
  return args.length > 90 ? `${args.slice(0, 89)}…` : args;
}

function diff(d: DeckState): string {
  if (!d.diff || !d.diff.files.length) return `<p class="muted">No file changes yet.</p>`;
  const files = d.diff.files
    .map((f) => `<li><span class="badge st-${esc(f.status)}">${esc(f.status)}</span> <a href="#" data-action="open-file" data-path="${esc(f.path)}">${esc(f.path)}</a></li>`)
    .join("");
  const lines = d.diff.patch
    .split("\n")
    .slice(0, 1_500)
    .map((l) => {
      const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") ? "meta" : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
      return `<span class="${cls}">${esc(l)}</span>`;
    })
    .join("\n");
  return `<ul class="files">${files}</ul><details><summary>Diff since the run started (after step ${d.diff.step})</summary><pre class="diff">${lines}</pre></details>`;
}

function verify(d: DeckState): string {
  const v = d.verification;
  if (!v) return `<p class="muted">Runs when Kira claims it is done.</p>`;
  const rows = v.gates
    .map(
      (g) => `<tr class="gate-${g.status}"><td>${g.level}</td><td>${esc(g.name)}</td><td><span class="badge ${g.status === "pass" ? "good" : g.status === "fail" ? "bad" : ""}">${g.status}</span></td><td>${esc(g.summary)}${
        g.details ? `<details><summary>details</summary><pre>${esc(g.details)}</pre></details>` : ""
      }</td></tr>`,
    )
    .join("");
  const concerns = v.concerns.length ? `<p class="warn-text">${v.concerns.length} open concern(s):</p><ul>${v.concerns.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "";
  return `<p>Round ${v.round}: <b class="${v.passed ? "good-text" : "bad-text"}">${v.passed ? "PASSED" : "FAILED"}</b></p><table class="gates">${rows}</table>${concerns}`;
}

function memory(d: DeckState, ctx: RenderCtx): string {
  const recalled = d.memory.length
    ? `<p class="muted small">Recalled for this run:</p><ul>${d.memory.map((m) => `<li><span class="badge">${esc(m.kind)}</span> ${esc(m.title)}</li>`).join("")}</ul>`
    : `<p class="muted">Nothing recalled for this run.</p>`;
  const review = ctx.pendingAdrs.length
    ? `<p class="muted small">New decisions to review (kept unless you reject them):</p>${ctx.pendingAdrs
        .map(
          (a) => `<div class="adr"><b>${esc(a.adrId ?? "")}</b> ${esc(a.title)}<pre>${esc(a.body)}</pre><button data-action="keep-memory" data-id="${a.id}" class="secondary">Keep</button> <button data-action="reject-memory" data-id="${a.id}" class="secondary">Reject</button></div>`,
        )
        .join("")}`
    : "";
  return recalled + review;
}
