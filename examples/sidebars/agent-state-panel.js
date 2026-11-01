// cmux 0.65.2 reactive custom right panel. Standalone: no imports/build step.
// See README.md beside this file for opt-in installation and state semantics.
const STATES = {
  needs_input: { symbol: "!", label: "Attention", color: "#D97706", rank: 0 },
  working: { symbol: "●", label: "Working", color: "#0A84FF", rank: 1 },
  ended: { symbol: "✓", label: "Review", color: "#248A3D", rank: 2 },
  unknown: { symbol: "?", label: "Unknown", color: "#AF52DE", rank: 3 },
  idle: { symbol: "○", label: "Idle", color: "secondary", rank: 4 },
};
const STATE_ORDER = ["needs_input", "working", "ended", "idle", "unknown"];
const MAX_WORKSPACES = 12;
const MAX_AGENTS = 6;
const [query, setQuery] = signal("");
const [scopeAll, setScopeAll] = signal(true);
const [attentionOnly, setAttentionOnly] = signal(false);
const [collapsedWorkspaces, setCollapsedWorkspaces] = signal([]);
const [sessionAliases, setSessionAliases] = signal([]);
const [renameTarget, setRenameTarget] = signal(null);
const [renameDraft, setRenameDraft] = signal("");
const [renameError, setRenameError] = signal("");

function sessionKey(workspaceId, agentId) {
  return JSON.stringify([workspaceId, agentId]);
}

function findAgent(workspaceId, agentId) {
  const w = (data.workspaces() ?? []).find((item) => item.id === workspaceId);
  const a = w && rosterAgents(w).find((item) => item.id === agentId);
  return w && a ? { w, a } : null;
}

function beginSessionName(workspaceId, agentId) {
  const target = findAgent(workspaceId, agentId);
  if (!target) return;
  setRenameDraft(agentTitle(target.w, target.a));
  setRenameError("");
  setRenameTarget({ workspaceId, agentId });
}

function cancelSessionName() {
  setRenameTarget(null);
  setRenameDraft("");
  setRenameError("");
}

function saveSessionName() {
  const target = renameTarget();
  if (!target) return;
  const name = renameDraft().trim();
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
    setRenameError("Use 1–80 characters on one line");
    return;
  }
  if (!findAgent(target.workspaceId, target.agentId)) {
    setRenameError("This session is no longer tracked");
    return;
  }
  const live = new Set((data.workspaces() ?? []).flatMap((w) =>
    rosterAgents(w).map((a) => sessionKey(w.id, a.id))));
  const key = sessionKey(target.workspaceId, target.agentId);
  setSessionAliases([...sessionAliases().filter((item) => live.has(item.key) && item.key !== key), { key, name }]);
  cancelSessionName();
}

function resetSessionName(workspaceId, agentId) {
  if (!findAgent(workspaceId, agentId)) return;
  const key = sessionKey(workspaceId, agentId);
  setSessionAliases(sessionAliases().filter((item) => item.key !== key));
  if (renameTarget() && sessionKey(renameTarget().workspaceId, renameTarget().agentId) === key) cancelSessionName();
}

function sessionNameForm() {
  return VStack({ spacing: 5 }, [
    Text("Name session").font(11).weight("semibold"),
    TextField(renameDraft, { placeholder: "Sidebar session name",
      onEdit: (text) => setRenameDraft(text ?? ""),
      onSubmit: (text) => { setRenameDraft(text ?? ""); saveSessionName(); },
      onCancel: cancelSessionName }),
    Text(() => renameError() || "Sidebar only · resets when the panel reloads")
      .font(10).color("secondary").lineLimit(2),
    HStack({ spacing: 10 }, [
      Text("Save").font(11).weight("semibold").color("accent").onTap(saveSessionName),
      Text("Cancel").font(11).color("secondary").onTap(cancelSessionName),
      Spacer(),
    ]),
  ]).padding(8).background("#7f7f7f18").cornerRadius(6).paddingHorizontal(8);
}

function workspaceCollapsed(id) {
  // Search reveals matching agents without changing remembered fold choices.
  return !query().trim() && collapsedWorkspaces().includes(id);
}

function toggleWorkspace(id) {
  if (query().trim()) return;
  const live = new Set((data.workspaces() ?? []).map((w) => w.id));
  if (!live.has(id)) return;
  const next = collapsedWorkspaces().filter((key) => live.has(key) && key !== id);
  if (!collapsedWorkspaces().includes(id)) next.push(id);
  setCollapsedWorkspaces(next);
}
// Launch helpers remain for repository experiments/tests; the panel has no
// button that opens their form.
// The explicit installer pins local executable/bridge paths; a raw copy remains
// a read-only roster and cannot launch a guessed `pi` from cmux's app PATH.
const launchConfig = typeof PI_PANEL_LAUNCH === "undefined" ? null : PI_PANEL_LAUNCH;
const [launchForm, setLaunchForm] = signal(false);
const [launchDirectory, setLaunchDirectory] = signal("");
const [launchSource, setLaunchSource] = signal("");
const [launchSent, setLaunchSent] = signal(false);
const [launchMessage, setLaunchMessage] = signal("");

function openLaunchForm() {
  if (launchForm()) return; // A double click must not rearm a submitted request.
  const selected = (data.workspaces() ?? []).find((w) => w.selected);
  setLaunchSource(selected?.id ?? "");
  setLaunchDirectory(selected?.remote ? "" : selected?.directory ?? "");
  setLaunchSent(false);
  setLaunchMessage(launchConfig ? "Independent local session · no prompt or copied history"
    : "Install the launch-enabled panel with install-agent-state-panel.mjs first");
  setLaunchForm(true);
}

function quoteArgument(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function createPiWorkspace() {
  if (!launchForm() || launchSent()) return;
  if (!launchConfig) return;
  const source = (data.workspaces() ?? []).find((w) => w.id === launchSource());
  if (!source || source.remote || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.id)) {
    setLaunchMessage("Select an ordinary local workspace, close this form and try again");
    return;
  }
  const cwd = launchDirectory().trim();
  if (!(cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/"))
      || cwd.length > 1024 || /[\u0000-\u001f\u007f]/.test(cwd)) {
    setLaunchMessage("Enter an absolute local directory or ~/path (up to 1024 characters)");
    return;
  }
  const request = { version: 1, sourceWorkspaceId: source.id, cwd };
  const command = "exec " + [launchConfig.node, launchConfig.bridge, JSON.stringify(launchConfig), JSON.stringify(request)]
    .map(quoteArgument).join(" ");
  // The action API returns no RPC result. Lock before dispatch, never retry,
  // and do not label the request as a successful or ready Pi session.
  setLaunchSent(true);
  setLaunchMessage("Request sent · inspect the new workspace before retrying");
  cmux("workspace.create", { workspace_id: source.id, title: "Pi", working_directory: cwd,
    initial_command: command, focus: "true" });
}

function launchFormRow() {
  return VStack({ spacing: 5 }, [
    Text("New independent Pi workspace").font(11).weight("semibold"),
    TextField(launchDirectory, { placeholder: "Absolute local directory", autofocus: false,
      onEdit: (text) => { if (!launchSent()) setLaunchDirectory(text ?? ""); } }),
    Text(launchMessage).font(10).color("secondary").lineLimit(3),
    HStack({ spacing: 10 }, [
      Text(() => launchSent() ? "Sent" : "Create").font(11).weight("semibold")
        .color(() => launchSent() || !launchConfig ? "secondary" : "accent")
        .onTap(createPiWorkspace),
      Text(() => launchSent() ? "Close" : "Cancel").font(11).color("secondary")
        .onTap(() => setLaunchForm(false)),
      Spacer(),
    ]),
  ]).padding(8).background("#7f7f7f18").cornerRadius(6).paddingHorizontal(8);
}

function agentState(a) {
  return Object.hasOwn(STATES, a.status) ? a.status : "unknown";
}

function countAgents(agents) {
  const counts = { needs_input: 0, working: 0, ended: 0, idle: 0, unknown: 0 };
  for (const a of agents) counts[agentState(a)] += 1;
  return counts;
}

// Lanes are workspace evidence, never a substitute for an individual state.
// A completed/ended state means "review", not proof of success.
function workspaceState(w) {
  const agents = rosterAgents(w);
  const c = countAgents(agents);
  if (c.needs_input || w.unread > 0 || (w.tabs ?? []).some((t) => t.hasUnread)
      || w.status === "needs-attention") return "needs_input";
  if (c.working || w.status === "working") return "working";
  if (c.ended || w.status === "review" || w.status === "done") return "ended";
  if (c.unknown || !agents.length) return "unknown";
  return "idle";
}

function countsText(counts) {
  return STATE_ORDER.filter((s) => counts[s] > 0)
    .map((s) => STATES[s].symbol + " " + counts[s]).join("  ");
}

function tabFor(w, a) {
  // cmux 0.65.2 agents can carry a Bonsplit surfaceId while tabs expose the
  // RPC surfaceId. Resolve the explicit panel binding through the live tab;
  // never send panelId/tab.id or the legacy Bonsplit ID to surface.focus.
  const matches = (w.tabs ?? []).filter((t) => t.surfaceId
    && (a.panelId ? t.id === a.panelId : a.surfaceId && t.surfaceId === a.surfaceId));
  return matches.length === 1 ? matches[0] : undefined;
}

function rosterAgents(w) {
  // cmux retains prior sessions after /new and supplies them most-recent-first.
  // Keep one session per exactly resolved live terminal BEFORE any filtering
  // or state sorting. Never merge unresolved agents by a guessed binding.
  const seen = new Set();
  return (w.agents ?? []).filter((a) => {
    const surfaceId = tabFor(w, a)?.surfaceId;
    if (!surfaceId) return true;
    if (seen.has(surfaceId)) return false;
    seen.add(surfaceId);
    return true;
  });
}

function scopedAgents(w) {
  return rosterAgents(w).filter((a) => !attentionOnly()
    || a.status === "needs_input" || tabFor(w, a)?.hasUnread === true);
}

function currentAgent(w, a) {
  return w.selected === true && tabFor(w, a)?.focused === true
    && rosterAgents(w).some((item) => item.id === a.id);
}

function agentTitle(w, a) {
  const alias = sessionAliases().find((item) => item.key === sessionKey(w.id, a.id));
  return alias?.name || [a.title, tabFor(w, a)?.latestPrompt]
    .map((text) => String(text ?? "").replace(/\s+/g, " ").trim()).find(Boolean) || "Untitled session";
}

function agentMeta(w, a) {
  const tab = tabFor(w, a);
  const name = String(a.name || a.kind || "").trim();
  const children = (a.children ?? []).filter((c) => c.running).length;
  return [name.toLowerCase() === "pi" ? "" : name, tab?.hasUnread ? "! unread" : "",
    children ? children + " sub working" : "", !tab ? "workspace only" : ""]
    .filter(Boolean).join(" · ");
}

function ageText(a) {
  const epoch = data.clock()?.epoch;
  const since = (a.status === "working" || a.status === "needs_input")
    ? (a.sinceEpoch ?? a.lastActivityAt) : a.lastActivityAt;
  if (!Number.isFinite(epoch) || !Number.isFinite(since)) return "";
  const seconds = Math.max(0, Math.floor(epoch - since));
  const text = seconds < 60 ? seconds + "s"
    : seconds < 3600 ? Math.floor(seconds / 60) + "m" : Math.floor(seconds / 3600) + "h";
  return text + (a.status === "working" || a.status === "needs_input" ? "" : " ago");
}

function workspaceMeta(w) {
  const bits = [];
  if (w.branch) bits.push(w.branch + (w.dirty ? "*" : ""));
  else if (w.dirty) bits.push("dirty");
  if (w.unread > 0) bits.push(w.unread + " unread");
  if (w.pr) bits.push("PR #" + w.pr.number + " " + (w.pr.status ?? ""));
  if (Number.isFinite(w.progress?.value)) {
    bits.push(Math.round(Math.max(0, Math.min(1, w.progress.value)) * 100) + "%");
  }
  return bits.join(" · ") || "No git/activity metadata";
}

const scoped = computed(() => (data.workspaces() ?? [])
  .filter((w) => scopeAll() || w.selected));
const totals = computed(() => countAgents(scoped().flatMap(scopedAgents)));

const groups = computed(() => {
  const q = query().trim().toLowerCase();
  const includes = (...values) => values.some((v) => String(v ?? "").toLowerCase().includes(q));
  // Require matching tracked agents, even when a workspace title matches.
  return scoped().map((w) => {
    const workspaceMatch = includes(w.title, w.directory, w.branch);
    const agents = scopedAgents(w).filter((a) => {
      const tab = tabFor(w, a);
      return workspaceMatch || includes(agentTitle(w, a), a.title, a.name, a.kind, a.directory, a.status, tab?.latestPrompt);
    });
    return { w, agents };
  }).filter(({ agents }) => agents.length > 0);
});

// One bounded keyed list. Rollups include the complete deduplicated roster,
// even when search or the display cap hides some. Preserve cmux workspace order.
const entries = computed(() => {
  const out = [];
  for (const { w, agents } of groups().slice(0, MAX_WORKSPACES)) {
    out.push({ key: "w:" + w.id, kind: "workspace", w });
    if (workspaceCollapsed(w.id)) continue;
    const sorted = [...agents].sort((a, b) => STATES[agentState(a)].rank - STATES[agentState(b)].rank);
    for (const a of sorted.slice(0, MAX_AGENTS)) {
      out.push({ key: "a:" + w.id + ":" + a.id, kind: "agent", w, a });
    }
    const message = agents.length > MAX_AGENTS ? "+" + (agents.length - MAX_AGENTS) + " agents · narrow search" : "";
    if (message) out.push({ key: "n:" + w.id, kind: "note", message });
  }
  return out;
});

function jumpWorkspace(id) {
  if ((data.workspaces() ?? []).some((w) => w.id === id)) {
    cmux("workspace.select", { workspace_id: id });
  }
}

function jumpAgent(workspaceId, agentId) {
  // Resolve again at click time: a retained row must not focus a stale surface.
  const target = findAgent(workspaceId, agentId);
  if (!target) return;
  const { w, a } = target;
  cmux("workspace.select", { workspace_id: w.id });
  const tab = tabFor(w, a);
  if (tab?.surfaceId) {
    cmux("surface.focus", { workspace_id: w.id, surface_id: tab.surfaceId });
  }
}

function glyph(state) {
  return Text(() => STATES[state()].symbol).font(13).weight("semibold").monospaced()
    .color(() => STATES[state()].color).frame({ width: 14 }).fixedSize("horizontal");
}

function workspaceRow(e) {
  const w = () => e().w;
  const state = () => workspaceState(w());
  return HStack({ spacing: 3 }, [
    Text(() => workspaceCollapsed(w().id) ? "›" : "⌄").font(13).color("secondary")
      .frame({ width: 14 }).fixedSize("horizontal").paddingVertical(6)
      .help(() => query().trim() ? "Search reveals agents · clear search to fold"
        : (workspaceCollapsed(w().id) ? "Expand agents" : "Collapse agents") + " · " + w().id)
      .onTap(() => toggleWorkspace(w().id)),
    VStack({ spacing: 2 }, [
      HStack({ spacing: 5 }, [
        glyph(state),
        Text(() => w().title || "Untitled workspace").font(12).weight("semibold").lineLimit(1).truncation("tail"),
        Spacer({ minLength: 0 }),
        Text(() => countsText(countAgents(rosterAgents(w()))) || "0 agents")
          .font(10).monospaced().color("secondary").fixedSize("horizontal"),
      ]),
      Text(() => workspaceMeta(w())).font(10).color("secondary").lineLimit(1).truncation("middle")
        .paddingLeading(19),
    ]).frame({ maxWidth: "infinity" }).onTap(() => jumpWorkspace(w().id)),
  ]).paddingHorizontal(8).paddingVertical(6).cornerRadius(6)
    .background(() => w().selected ? "#7f7f7f24" : null)
    .hoverBackground("#7f7f7f24").frame({ maxWidth: "infinity" })
    .help(() => STATES[state()].label + " · lane: " + (w().status ?? "unknown") + " · " + w().id);
}

function agentRow(e) {
  const a = () => e().a;
  const state = () => agentState(a());
  return VStack({ spacing: 2 }, [
    HStack({ spacing: 5 }, [
      glyph(state),
      Text(() => agentTitle(e().w, a())).font(12)
        .weight(() => currentAgent(e().w, a()) ? "semibold" : "regular").lineLimit(1).truncation("tail"),
      Spacer({ minLength: 0 }),
      Text(() => STATES[state()].label).font(10).color(() => STATES[state()].color).fixedSize("horizontal"),
    ]),
    HStack({ spacing: 4 }, [
      Text(() => agentMeta(e().w, a())).font(10).color(() => tabFor(e().w, a())?.hasUnread ? STATES.needs_input.color : "secondary")
        .lineLimit(1).truncation("tail"),
      Spacer({ minLength: 0 }),
      Text(() => ageText(a())).font(10).monospaced().color("secondary").fixedSize("horizontal"),
    ]).paddingLeading(19),
  ]).paddingLeading(39).paddingTrailing(8).paddingVertical(4).cornerRadius(6)
    .background(() => currentAgent(e().w, a()) ? "#0A84FF20" : null)
    .hoverBackground("#7f7f7f1c").frame({ maxWidth: "infinity" })
    .help(() => {
      const tab = tabFor(e().w, a());
      return [currentAgent(e().w, a()) ? "Current agent surface" : "",
        "State: " + (a().status ?? "unknown"), agentTitle(e().w, a()),
        a().title === agentTitle(e().w, a()) ? "" : a().title,
        tab?.latestPrompt === agentTitle(e().w, a()) ? "" : tab?.latestPrompt, a().directory,
        tab ? "Focus exact agent surface" : "Surface unavailable: select workspace only"].filter(Boolean).join("\n");
    })
    .onTap(() => jumpAgent(e().w.id, a().id))
    .contextMenu([
      Button("Name in sidebar…", () => beginSessionName(e().w.id, a().id)),
      Button("Use automatic name", () => resetSessionName(e().w.id, a().id)),
    ]);
}

function scopeButton(label, all) {
  return Text(label).font(11).weight("medium").paddingHorizontal(8).paddingVertical(3).cornerRadius(5)
    .background(() => scopeAll() === all ? "#7f7f7f30" : null)
    .color(() => scopeAll() === all ? "primary" : "secondary")
    .hoverBackground("#7f7f7f24").onTap(() => setScopeAll(all));
}

sidebar(() => VStack({ spacing: 4 }, [
  HStack({ spacing: 5 }, [
    Text("Agent states").font(13).weight("semibold").lineLimit(1),
    Spacer({ minLength: 0 }),
    Text("Attention").font(11).weight("medium").fixedSize("horizontal")
      .paddingHorizontal(7).paddingVertical(3).cornerRadius(5)
      .background(() => attentionOnly() ? "#D9770620" : null)
      .color(() => attentionOnly() ? STATES.needs_input.color : "secondary")
      .hoverBackground("#7f7f7f24")
      .help("Filter agents needing input or with unread surface notifications")
      .onTap(() => setAttentionOnly(!attentionOnly())),
  ]).paddingHorizontal(8).paddingVertical(4),
  ForEach({ items: () => renameTarget() ? [{ id: "name" }] : [], key: (e) => e.id }, sessionNameForm),
  ForEach({ items: () => launchForm() ? [{ id: "launch" }] : [], key: (e) => e.id }, launchFormRow),
  Text(() => countsText(totals()) || (attentionOnly() ? "No attention items" : "No agents")).font(10).monospaced().color("secondary").paddingHorizontal(8),
  HStack({ spacing: 4 }, [scopeButton("All", true), scopeButton("This workspace", false), Spacer()])
    .paddingHorizontal(8),
  TextField("", { placeholder: "Search workspaces or agents", autofocus: false,
    onEdit: (text) => setQuery(text ?? ""), onSubmit: (text) => setQuery(text ?? "") }).paddingHorizontal(8),
  Divider(),
  ForEach({ items: entries, key: (e) => e.key }, (e) => {
    const kind = e().kind; // Stable per key; all changing props read e() live.
    if (kind === "workspace") return workspaceRow(e);
    if (kind === "agent") return agentRow(e);
    return Text(() => e().message).font(10).color("secondary").paddingLeading(58).paddingVertical(3);
  }),
  Text(() => !groups().length ? (query().trim() ? "No matches" : attentionOnly() ? "No agents need attention" : "No agents in scope")
    : groups().length > MAX_WORKSPACES ? "+" + (groups().length - MAX_WORKSPACES) + " workspaces · narrow search" : "")
    .font(10).color("secondary").paddingHorizontal(8),
  Spacer(),
]).paddingHorizontal(4), { surface: "glass" });
