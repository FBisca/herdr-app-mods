// Plans board: the /start-planning plans (docs/plans/*.plan.md) of the shown space's repo,
// with each Status and Tickets table, and the Herdr agents working on them. Follows the active
// space. ↗ opens the plan in the Files panel (the plans-files mod, through shared "plans.reveal").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, exec, readTextFile, watchFolder, theme, run, setShared } from "herdr";

const PLANS_DIR = "docs/plans";
const RESCAN_MS = 20000;

// ---- parsing ---------------------------------------------------------------

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function ticketState(raw) {
  const s = raw.toUpperCase();
  if (/^(COMPLETE|DONE)/.test(s)) return "complete";
  if (/^IN[ -]?PROGRESS/.test(s)) return "progress";
  if (/^BLOCKED/.test(s)) return "blocked";
  return "todo";
}

export function parsePlan(text, file) {
  const lines = text.split("\n");
  const title = (lines.find((l) => /^# /.test(l)) ?? "").replace(/^#\s+(Plan:\s*)?/, "").trim() || file;
  const st = /Status:\s*([A-Z][A-Z -]*[A-Z])\.?(?:\s+(\d{4}-\d{2}-\d{2}))?/.exec(text);
  const tickets = [];
  const start = lines.findIndex((l) => /^##\s+Tickets\b/i.test(l));
  if (start >= 0) {
    let head = null;
    for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
      if (!lines[i].trim().startsWith("|")) { if (head && tickets.length) break; continue; }
      const row = cells(lines[i]);
      if (!head) { head = row.map((c) => c.toLowerCase()); continue; }
      if (row.every((c) => /^:?-+:?$/.test(c))) continue;
      const col = (re) => { const k = head.findIndex((h) => re.test(h)); return k >= 0 ? row[k] ?? "" : ""; };
      const status = col(/^status/);
      const word = /^(COMPLETE|DONE|IN[ -]?PROGRESS|BLOCKED|TO-?DO)\b/i.exec(status)?.[0] ?? status;
      tickets.push({
        id: col(/^#|^id$|^ticket/), what: col(/^what|deliver|title/), satisfies: col(/^satisf/),
        blockedBy: col(/^blocked/), owner: col(/^owner/), paths: col(/^paths?/),
        status, label: word.toUpperCase(), detail: status.slice(word.length).trim().replace(/^\((.*)\)$/s, "$1"),
        state: ticketState(status),
      });
    }
  }
  const done = new Set(tickets.filter((t) => t.state === "complete").map((t) => t.id));
  for (const t of tickets) {
    const blockers = (t.blockedBy.match(/T\d+/g) ?? []).filter((b) => !done.has(b));
    t.waitingOn = blockers;
    if (t.state === "todo") t.state = blockers.length ? "waiting" : "ready";
  }
  return {
    file, title, tickets,
    status: st?.[1] ?? "NO STATUS", statusDate: st?.[2] ?? null,
    date: /^(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? null,
    slug: /Slug:\s*`([^`]+)`/.exec(text)?.[1] ?? file.replace(/^\d{4}-\d{2}-\d{2}-|\.plan\.md$/g, ""),
  };
}

// ---- discovery -------------------------------------------------------------

async function repoRoot(folder, on) {
  // The main checkout, so a plan seen from several worktrees shows once.
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd: folder, on }).catch(() => null);
  if (r?.code !== 0) return null;
  const [common, top] = r.stdout.trim().split("\n");
  return common?.endsWith("/.git") ? common.slice(0, -5) : top || null;
}

async function listPlans(root, on) {
  const r = await exec("sh", ["-c", 'cd "$1/' + PLANS_DIR + '" 2>/dev/null && ls -1 *.plan.md 2>/dev/null', "plans", root], { on }).catch(() => null);
  return r?.stdout.split("\n").map((s) => s.trim()).filter(Boolean) ?? [];
}

// The shown space's folders: its start folder and its panes' live folders.
function candidates(space) {
  const out = new Map();
  if (!space) return [];
  const add = (folder) => { if (folder) out.set(folder, { folder, on: space.machine ?? null }); };
  add(space.folder);
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  for (const p of panes()) if (p.cwd && tabs.has(p.tab)) add(p.cwd);
  return [...out.values()];
}
const activeSpace = () => spaces().find((s) => s.active) ?? null;

// ---- look ------------------------------------------------------------------

const ORDER = { "AWAITING APPROVAL": 0, APPROVED: 1, ARCHIVED: 8, "NO STATUS": 9 };
// Shown by default: everything with a Status line except ARCHIVED.
const inactive = (plan) => plan.status === "ARCHIVED" || plan.status === "NO STATUS";
function planTone(status, t) {
  if (status === "AWAITING APPROVAL") return t.blocked;
  if (status === "APPROVED") return t.working;
  return t.dim;
}
function ticketLook(state, t) {
  switch (state) {
    case "complete": return { glyph: "✓", color: t.ansi2, word: "Complete" };
    case "progress": return { glyph: "◐", color: t.working, word: "In progress", frames: ["◐", "◓", "◑", "◒"] };
    case "blocked": return { glyph: "✕", color: t.blocked, word: "Blocked" };
    case "ready": return { glyph: "○", color: t.foreground, word: "Ready" };
    default: return { glyph: "○", color: t.dim, word: "Waiting" };
  }
}
const TICKET_IN_NAME = /(?:^|[^a-z0-9])t(\d+)[a-z]?(?=$|[^a-z0-9])/i;
const isHuman = (owner) => owner && !/^(agent|agents|claude|codex|ai)$/i.test(owner);

// ---- board -----------------------------------------------------------------

export default class Plans extends View {
  init(p, cx) {
    this.repos = [];            // [{ root, on, name, plans: [...] }]
    this.loading = true;
    this.showArchived = localStorage.getItem("archived") === "1";
    this.open = JSON.parse(localStorage.getItem("open") ?? "{}");   // plan key -> bool
    this.openTicket = null;
    this.rootCache = new Map();
    this.cwdRoot = new Map();     // agent cwd -> repo root (null: not a repo)
    this.watched = new Set();
    this.scan(cx);
    cx.timer.every(RESCAN_MS, (cx) => this.scan(cx));
  }

  scan(cx) {
    if (this.scanning) { this.again = true; return; }
    this.scanning = true;
    const space = activeSpace(), spaceId = space?.id ?? null;
    this.scannedSpace = spaceId;
    cx.spawn(async (cx) => {
      try {
        const roots = new Map();
        for (const { folder, on } of candidates(space)) {
          const k = `${on ?? ""}\u0000${folder}`;
          if (!this.rootCache.has(k)) this.rootCache.set(k, await repoRoot(folder, on));
          const root = this.rootCache.get(k);
          if (root) roots.set(`${on ?? ""}\u0000${root}`, { root, on });
        }
        const repos = [];
        for (const { root, on } of roots.values()) {
          const files = await listPlans(root, on);
          if (!files.length) continue;
          const plans = [];
          for (const f of files) {
            const text = await readTextFile(`${root}/${PLANS_DIR}/${f}`, { on }).catch(() => null);
            if (text != null) plans.push({ ...parsePlan(text, f), path: `${root}/${PLANS_DIR}/${f}`, on, key: `${on ?? ""}:${root}/${f}` });
          }
          plans.sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || (b.date ?? "").localeCompare(a.date ?? "") || a.file.localeCompare(b.file));
          repos.push({ root, on, name: (on ? `${on}:` : "") + root.split("/").pop(), plans });
          if (!on) this.watch(`${root}/${PLANS_DIR}`, cx);
        }
        repos.sort((a, b) => a.name.localeCompare(b.name));
        if (activeSpace()?.id !== spaceId) { this.again = true; return; }
        this.repos = repos; this.error = null; this.spaceName = space?.name ?? null;
      } catch (e) { this.error = String(e); }
      finally {
        this.loading = false; this.scanning = false; cx.notify();
        if (this.again) { this.again = false; this.scan(cx); }
      }
    });
  }

  watch(dir, cx) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(dir); this.scan(cx); } }
      catch { this.watched.delete(dir); }
    });
  }

  toggle(key, def, cx) {
    this.open[key] = !(this.open[key] ?? def);
    localStorage.setItem("open", JSON.stringify(this.open));
    cx.notify();
  }

  openInFiles(plan) {
    setShared("plans.reveal", { path: plan.path, at: Date.now() });
    run("layout.select", { stack: "panel-body", child: "files" });
    run("layout.show", { id: "panel" });
  }

  // -- agents --

  // Live local agents, and the repo each one's folder belongs to (worktrees count as the repo).
  liveAgents(cx) {
    const all = terminals().filter((x) => x.state === "live" && x.cwd && !String(x.address).includes("/") && (x.agent || x.status));
    const missing = [...new Set(all.map((x) => x.cwd).filter((c) => !this.cwdRoot.has(c)))];
    if (missing.length && !this.resolving) {
      this.resolving = true;
      cx.spawn(async (cx) => {
        try { for (const c of missing) this.cwdRoot.set(c, await repoRoot(c, null)); }
        finally { this.resolving = false; cx.notify(); }
      });
    }
    return all;
  }

  // Workers go to the ticket their name carries (t4-mcp, existence-t13b), in the plan where that
  // ticket is in progress; others to the repo's only plan with a ticket in progress. Their lead
  // (the terminal that started them) goes with them.
  attribute(repo, live) {
    if (repo.on) return { byPlan: new Map(), loose: [] };
    const workers = live.filter((x) => x.parent && this.cwdRoot.get(x.cwd) === repo.root);
    const active = repo.plans.filter((p) => !inactive(p));
    const running = active.filter((p) => p.tickets.some((k) => k.state === "progress"));
    const byPlan = new Map(), loose = [];
    const slot = (p) => { if (!byPlan.has(p.key)) byPlan.set(p.key, { leads: new Set(), tickets: new Map(), plan: [] }); return byPlan.get(p.key); };
    for (const w of workers) {
      const m = TICKET_IN_NAME.exec(w.name ?? ""), id = m ? `T${Number(m[1])}` : null;
      const has = id ? active.filter((p) => p.tickets.some((k) => k.id === id)) : [];
      const plan = has.find((p) => p.tickets.find((k) => k.id === id).state === "progress") ?? has[0]
        ?? (running.length === 1 ? running[0] : null);
      if (!plan) { loose.push(w); continue; }
      const s = slot(plan);
      if (has.includes(plan)) { if (!s.tickets.has(id)) s.tickets.set(id, []); s.tickets.get(id).push(w); }
      else s.plan.push(w);
      s.leads.add(w.parent);
    }
    return { byPlan, loose };
  }

  agentChip(term, label, t) {
    const color = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[term.status] ?? t.unknown;
    const dot = div().w(6).h(6).rounded(3).flex_none().bg(color);
    const pane = agents().find((a) => a.address === term.address)?.pane;
    return h_flex().id(`ag-${term.address}`).flex_none().gap(5).px(6).py(1).rounded(5).items_center().text_size(11)
      .bg(t.raised).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); pane ? run("pane.focus", { pane }) : run("terminal.peek", { terminal: term.address }); })
      .child(term.status === "working" ? dot.loop("opacity", { from: 0.3, to: 1, period: 1200 }) : dot)
      .child(label);
  }

  agentName(term) {
    const a = agents().find((x) => x.address === term.address);
    return term.name || a?.tab_name || a?.title || term.agent || term.address;
  }

  agentRow(list, t, prefix) {
    return h_flex().flex_wrap().gap(4).items_center()
      .when(Boolean(prefix), (el) => el.child(div().text_size(11).text_color(t.dim).mr(2).child(prefix)))
      .children(list.map(([term, label]) => this.agentChip(term, label, t)));
  }

  // -- pieces --

  progress(plan, t) {
    if (!plan.tickets.length) return div();
    return h_flex().h(4).gap(2).mt(6).children(plan.tickets.map((tk, i) =>
      div().id(`seg-${plan.key}-${i}`).flex_1().h(4).rounded(2).bg(ticketLook(tk.state, t).color)
        .when(tk.state === "waiting" || tk.state === "ready", (el) => el.opacity(0.35))));
  }

  ticketRow(plan, tk, t, crew) {
    const look = ticketLook(tk.state, t), key = `${plan.key}#${tk.id}`, open = this.openTicket === key;
    const human = isHuman(tk.owner), needsYou = human && tk.state === "ready";
    const glyph = div().w(14).flex_none().text_color(look.color).child(look.glyph);
    return v_flex().id(`tk-${key}`).px(8).py(4).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(open, (el) => el.bg(t.raised))
      .on_click((_e, cx) => { this.openTicket = open ? null : key; cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(look.frames ? glyph.frames(look.frames, 220) : glyph)
        .child(div().w(26).flex_none().text_size(12).text_color(t.muted).child(tk.id))
        .child(div().flex_1().min_w(0).truncate()
          .text_color(tk.state === "complete" || tk.state === "waiting" ? t.muted : t.foreground).child(tk.what.replace(/`/g, "")))
        .when(crew.length > 0 && !open, (el) => el.children(crew.map((w) => this.agentChip(w, this.agentName(w), t))))
        .when(human, (el) => el.child(div().flex_none().px(6).rounded(4).text_size(11)
          .bg(needsYou ? t.blocked : t.raised).text_color(needsYou ? t.background : t.muted).child(tk.owner))))
      .when(open, (el) => el.child(v_flex().pl(48).pt(4).pb(2).gap(3).text_size(12).text_color(t.muted)
        .child(div().whitespace_normal().text_color(t.foreground).child(tk.what.replace(/`/g, "")))
        .child(h_flex().gap(6).child(div().text_color(look.color).font_semibold().child(look.word))
          .when(tk.state === "waiting", (el) => el.child(div().child(`on ${tk.waitingOn.join(", ")}`))))
        .when(Boolean(tk.detail), (el) => el.child(div().whitespace_normal().child(tk.detail)))
        .when(Boolean(tk.satisfies), (el) => el.child(div().child(`Satisfies ${tk.satisfies}`)))
        .when(Boolean(tk.blockedBy) && tk.blockedBy !== "none", (el) => el.child(div().child(`Blocked by ${tk.blockedBy}`)))
        .when(Boolean(tk.owner), (el) => el.child(div().child(`Owner ${tk.owner}`)))
        .when(crew.length > 0, (el) => el.child(this.agentRow(crew.map((w) => [w, this.agentName(w)]), t, "Agents")))));
  }

  planCard(plan, t, crew) {
    const archived = inactive(plan), open = this.open[plan.key] ?? !archived;
    const n = (s) => plan.tickets.filter((x) => x.state === s).length;
    const done = n("complete"), prog = n("progress"), total = plan.tickets.length;
    const tone = planTone(plan.status, t);
    const summary = [plan.date, total ? `${done}/${total} done` : "no tickets",
      prog ? `${prog} in progress` : null, n("blocked") ? `${n("blocked")} blocked` : null].filter(Boolean).join(" · ");
    return v_flex().id(`plan-${plan.key}`).flex_none().p(10).gap(2).rounded(8).border_1().border_color(t.border)
      .bg(archived ? t.background : t.surface)
      .child(h_flex().id(`plan-head-${plan.key}`).gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => this.toggle(plan.key, !archived, cx))
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(archived ? t.muted : t.foreground).child(plan.title))
        .child(div().flex_none().px(6).py(1).rounded(4).text_size(10).font_semibold().border_1().border_color(tone).text_color(tone)
          .child(plan.status))
        .child(div().id(`plan-open-${plan.key}`).flex_none().px(4).rounded(4).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.openInFiles(plan); })
          .child("↗")))
      .child(div().pl(18).text_size(11).text_color(t.dim).truncate().child(summary))
      .child(div().pl(18).child(this.progress(plan, t)))
      .when(Boolean(crew) && (crew.leads.size > 0 || crew.plan.length > 0), (el) => el.child(div().pl(18).pt(6).child(this.agentRow([
        ...[...crew.leads].map((a) => terminals().find((x) => x.address === a)).filter(Boolean).map((l) => [l, `lead · ${this.agentName(l)}`]),
        ...crew.plan.map((w) => [w, this.agentName(w)])], t))))
      .when(open && total > 0, (el) => el.child(v_flex().mt(6).gap(1).children(plan.tickets.map((tk) => this.ticketRow(plan, tk, t, crew?.tickets.get(tk.id) ?? [])))));
  }

  render(cx) {
    const now = activeSpace()?.id ?? null;
    if (now !== this.scannedSpace) { this.repos = []; this.loading = true; this.scan(cx); }
    const t = theme();
    const all = this.repos.flatMap((r) => r.plans);
    const archivedCount = all.filter(inactive).length;
    const awaiting = all.filter((p) => p.status === "AWAITING APPROVAL").length;
    const active = all.filter((p) => !inactive(p)).length;
    const head = [active ? `${active} active` : null, awaiting ? `${awaiting} awaiting approval` : null].filter(Boolean).join(" · ");

    const items = [], live = this.liveAgents(cx);
    for (const repo of this.repos) {
      const { byPlan, loose } = this.attribute(repo, live);
      const shown = repo.plans.filter((p) => this.showArchived || !inactive(p));
      if (!shown.length) continue;
      items.push(h_flex().px(4).pt(4).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().font_semibold().child(repo.name.toUpperCase()))
        .child(div().flex_1().h(1).bg(t.border)));
      for (const plan of shown) items.push(this.planCard(plan, t, byPlan.get(plan.key)));
      if (loose.length) items.push(div().px(4).child(this.agentRow(loose.map((w) => [w, this.agentName(w)]), t, "Other agents")));
    }
    if (!this.repos.some((r) => r.plans.some((p) => this.showArchived || !inactive(p))))
      items.push(div().p(8).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Looking for plans…" : `No active plans in ${PLANS_DIR}/ for ${this.spaceName ?? "this space"}`)));

    return v_flex().id("plans").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Plans"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(head))
        .when(archivedCount > 0, (el) => el.child(div().id("plans-archived").flex_none().px(6).py(2).rounded(5).text_size(11).cursor_pointer()
          .text_color(this.showArchived ? t.foreground : t.dim).when(this.showArchived, (el) => el.bg(t.raised))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.showArchived = !this.showArchived; localStorage.setItem("archived", this.showArchived ? "1" : "0"); cx.notify(); })
          .child(`Archived ${archivedCount}`)))
        .child(div().id("plans-refresh").flex_none().px(5).rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.rootCache.clear(); this.scan(cx); })
          .child(this.scanning ? "…" : "↻")))
      .child(v_flex().id("plans-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8).children(items));
  }
}
