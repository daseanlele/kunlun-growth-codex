import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { defaultConfig, type ProviderAdapter, type ProviderProtocol } from "./domain/enterprise-config";
import { matchProvider, providerPresets, type ProviderPreset } from "./domain/providers";
import { defaultBlockPreferences, featureBlocks, mergeBlockPreferences, moveBlock, updateBlockPreference, visibleBlocks, type BlockPreference } from "./domain/blocks";
import { mergeTimelineEntry, normalizeRuntimeEvent, runtimeCatalog, timelineFromThreadResponse, type AgentModel, type RuntimeEngine, type RuntimeSession, type TimelineEntry } from "./domain/runtime";
import { activateProviderProfile, archiveAgentThread, createAgentThread, discoverProviderModels, forkAgentThread, getAgentThreadGoal, getRuntimeStatus, interruptAgentTurn, listAgentModels, listAgentThreads, listCollaborationModes, listMcpServers, listProviderProfiles, listRuntimeSkills, listWorkspaceFiles, loadMcpServers, loadProviderConfig, loadRuntimeSkills, onAppServerNotification, onAppServerRequest, onTerminalExit, onTerminalOutput, readAgentThread, readEffectiveConfig, readGitDiff, readRuntimeAccount, readRuntimeUsage, readWorkspaceFile, renameAgentThread, resizeSandboxTerminal, respondToApproval, respondToServerRequest, resumeAgentThread, runSandboxTerminal, runTerminalCommand, saveProviderConfig, setAgentThreadGoal, setAgentThreadPinned, setRuntimeSkillEnabled, startAgentReview, startAgentTurn, startCodexAccountLogin, startRuntime, steerAgentTurn, stopRuntime, stopSandboxTerminal, stopTerminalCommand, writeSandboxTerminal, type AppServerMessage, type ApprovalDecision, type ProviderConfigPayload, type RuntimeMcpServer, type RuntimeSkill, type RuntimeSnapshot, type WorkspaceEntry } from "./runtime-client";

type View = "workspace" | "providers" | "security" | "extensions" | "blocks" | "account";
type ThemeMode = "system" | "light" | "dark";
const demoSessions: RuntimeSession[] = [{ id: "welcome", engine: "codex", title: "欢迎使用昆仑增长", cwd: "", updatedAt: new Date().toISOString(), status: "idle" }];
const initialRuntime: RuntimeSnapshot = { status: "stopped", pid: null, binary: "codex", engine: "codex", available: true, lastError: null };

export function App() {
  const [view, setView] = useState<View>("workspace");
  const engine: RuntimeEngine = "codex";
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(initialRuntime);
  const [sessions, setSessions] = useState<RuntimeSession[]>(demoSessions);
  const [activeSession, setActiveSession] = useState("welcome");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState(defaultConfig.provider.model);
  const [baseUrl, setBaseUrl] = useState(defaultConfig.provider.baseUrl);
  const [protocol, setProtocol] = useState<ProviderProtocol>(defaultConfig.provider.protocol);
  const [adapter, setAdapter] = useState<ProviderAdapter>(defaultConfig.provider.adapter);
  const [profileId, setProfileId] = useState(defaultConfig.provider.id);
  const [providerId, setProviderId] = useState(defaultConfig.provider.providerId);
  const [providerName, setProviderName] = useState(defaultConfig.provider.displayName);
  const [profiles, setProfiles] = useState<ProviderConfigPayload[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [saved, setSaved] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [blocks, setBlocks] = useState<BlockPreference[]>(() => {
    try { return mergeBlockPreferences(JSON.parse(localStorage.getItem("kunlun-blocks") ?? "null")); } catch { return defaultBlockPreferences(); }
  });
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem("kunlun-theme") as ThemeMode | null) ?? "system");

  useEffect(() => {
    void getRuntimeStatus().then((snapshot) => setRuntime(snapshot.engine === "codex" ? snapshot : initialRuntime)).catch((error: unknown) => setRuntime({ ...initialRuntime, status: "error", lastError: String(error) }));
    void Promise.all([loadProviderConfig(), listProviderProfiles()]).then(([config, savedProfiles]) => { applyProvider(config); setProfiles(savedProfiles); });
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme; if (theme === "system") localStorage.removeItem("kunlun-theme"); else localStorage.setItem("kunlun-theme", theme); };
    apply(); media.addEventListener("change", apply); return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => { localStorage.setItem("kunlun-blocks", JSON.stringify(blocks)); }, [blocks]);
  useEffect(() => {
    if (runtime.status !== "ready") return;
    const timer = window.setTimeout(() => { void listAgentThreads(engine, { searchTerm: sessionSearch, archived: showArchived }).then((loaded) => setSessions(loaded.length || sessionSearch || showArchived ? loaded : demoSessions.map((session) => ({ ...session, engine })))).catch(() => undefined); }, 220);
    return () => window.clearTimeout(timer);
  }, [engine, runtime.status, sessionSearch, showArchived]);

  async function toggleSessionPin(session: RuntimeSession) {
    const isPinned = !session.isPinned; setSessions((current) => current.map((item) => item.id === session.id ? { ...item, isPinned } : item).sort((a, b) => Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned))));
    try { await setAgentThreadPinned(session.id, isPinned); } catch { setSessions((current) => current.map((item) => item.id === session.id ? session : item)); }
  }

  async function toggleRuntime() {
    setRuntime((current) => ({ ...current, status: "starting" }));
    try {
      const snapshot = runtime.status === "ready" ? await stopRuntime() : await startRuntime(engine);
      setRuntime(snapshot);
      if (snapshot.status === "ready") { const loaded = await listAgentThreads(engine).catch(() => []); if (loaded.length) setSessions(loaded); }
    } catch (error) { setRuntime((current) => ({ ...current, status: "error", available: false, lastError: String(error) })); }
  }

  async function saveAndActivateProvider() {
    try {
      const savedConfig = await saveProviderConfig({ id: profileId, providerId: providerId || "custom", displayName: providerName || "自定义模型", protocol, adapter, baseUrl, model, authMethod: "api-key", authHeader: authHeader.trim() || null, credentialRef: null }, apiKey);
      applyProvider(savedConfig); setProfiles(await listProviderProfiles());
      setApiKey(""); setSaved(true); window.setTimeout(() => setSaved(false), 1800);
      if (runtime.status === "ready") { await stopRuntime(); setRuntime(await startRuntime(engine)); }
    } catch (error) { setRuntime((current) => ({ ...current, status: "error", lastError: String(error) })); }
  }

  function applyProvider(config: ProviderConfigPayload) { setProfileId(config.id); setBaseUrl(config.baseUrl); setModel(config.model); setProtocol(config.protocol); setAdapter(config.adapter); setProviderId(config.providerId); setProviderName(config.displayName); setAuthHeader(config.authHeader ?? ""); }
  async function activateProfile(id: string) {
    try { applyProvider(await activateProviderProfile(id)); if (runtime.status === "ready") { await stopRuntime(); setRuntime(await startRuntime(engine)); } }
    catch (error) { setRuntime((current) => ({ ...current, status: "error", lastError: String(error) })); }
  }

  const enabledNavigation = new Set(visibleBlocks(blocks, "navigation", engine).map((block) => block.id));
  return <main className="window-shell">
    <header className="titlebar" data-tauri-drag-region><div className="window-controls" aria-hidden="true"><i /><i /><i /></div><strong>昆仑增长</strong><div className="title-actions"><label className="compact-select">◐<select value={theme} onChange={(event) => setTheme(event.target.value as ThemeMode)}><option value="system">跟随系统</option><option value="light">日间</option><option value="dark">夜间</option></select></label><button className={`runtime-status ${runtime.status}`} onClick={() => void toggleRuntime()} title={runtime.lastError ?? runtime.binary}><i />统一智能体 · {runtime.status}</button></div></header>
    <div className="app-frame">
      <aside className="task-sidebar">
        <div className="brand"><span>昆</span><div><b>昆仑增长</b><small>企业 AI 开发工作台</small></div></div>
        <button className="new-task" onClick={() => { setView("workspace"); setActiveSession("welcome"); }}>＋ 新建任务</button>
        <nav className="main-nav"><button className={view === "workspace" ? "active" : ""} onClick={() => setView("workspace")}><span>⌘</span>任务</button>{enabledNavigation.has("models") && <button className={view === "providers" ? "active" : ""} onClick={() => setView("providers")}><span>⌁</span>模型服务</button>}{enabledNavigation.has("governance") && <button className={view === "security" ? "active" : ""} onClick={() => setView("security")}><span>◈</span>企业策略</button>}{enabledNavigation.has("extensions") && <button className={view === "extensions" ? "active" : ""} onClick={() => setView("extensions")}><span>◆</span>扩展能力</button>}<button className={view === "blocks" ? "active" : ""} onClick={() => setView("blocks")}><span>▦</span>功能积木</button></nav>
        <div className="sidebar-label"><span>{showArchived ? "已归档任务" : "最近任务"}</span><button onClick={() => setShowArchived((value) => !value)} title={showArchived ? "返回最近任务" : "查看归档"}>{showArchived ? "↩" : "▣"}</button></div>
        <label className="session-search"><span>⌕</span><input value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} placeholder="搜索任务" /></label>
        <div className="session-list">{sessions.map((session) => <div className="session-entry" key={session.id}><button className={`session-main ${activeSession === session.id ? "active" : ""}`} onClick={() => { setActiveSession(session.id); if (session.cwd) setCwd(session.cwd); setView("workspace"); }}><i className={session.status} /><span><b>{session.title}</b><small>{session.cwd || "统一智能体"}</small></span></button>{session.id !== "welcome" && <button className={`session-pin ${session.isPinned ? "active" : ""}`} onClick={() => void toggleSessionPin(session)} title={session.isPinned ? "取消置顶" : "置顶"}>⌖</button>}</div>)}</div>
        <div className="account"><span>本</span><div><b>本地工作区</b><small>数据保留在设备</small></div><button onClick={() => setView("account")}>⚙</button></div>
      </aside>
      {view === "workspace" && <Workspace engine={engine} adapter={adapter} runtime={runtime} configuredModel={model} cwd={cwd} blocks={blocks} onCwd={setCwd} activeSession={activeSession} onSession={(session) => { setActiveSession(session.id); setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]); }} onSessions={setSessions} onActiveSession={setActiveSession} onRuntime={setRuntime} />}
      {view === "providers" && <ProviderSettings runtime={runtime} baseUrl={baseUrl} model={model} protocol={protocol} adapter={adapter} profileId={profileId} providerId={providerId} providerName={providerName} profiles={profiles} apiKey={apiKey} authHeader={authHeader} saved={saved} onRuntime={setRuntime} onBaseUrl={setBaseUrl} onModel={setModel} onProtocol={setProtocol} onAdapter={setAdapter} onProfileId={setProfileId} onProviderId={setProviderId} onProviderName={setProviderName} onActivate={(id) => void activateProfile(id)} onApiKey={setApiKey} onAuthHeader={setAuthHeader} onSave={() => void saveAndActivateProvider()} />}
      {view === "security" && <SecuritySettings />}
      {view === "extensions" && <ExtensionSettings engine={engine} runtime={runtime} cwd={cwd} />}
      {view === "blocks" && <BlocksSettings preferences={blocks} engine={engine} onChange={setBlocks} />}
      {view === "account" && <AccountSettings engine={engine} runtime={runtime} />}
    </div>
  </main>;
}

interface WorkspaceProps { engine: RuntimeEngine; adapter: ProviderAdapter; runtime: RuntimeSnapshot; configuredModel: string; cwd: string; activeSession: string; blocks: BlockPreference[]; onCwd(value: string): void; onSession(value: RuntimeSession): void; onSessions(value: RuntimeSession[] | ((current: RuntimeSession[]) => RuntimeSession[])): void; onActiveSession(value: string): void; onRuntime(value: RuntimeSnapshot): void }
function Workspace({ engine, adapter, runtime, configuredModel, cwd, blocks, onCwd, activeSession, onSession, onSessions, onActiveSession, onRuntime }: WorkspaceProps) {
  const [threadId, setThreadId] = useState<string | null>(activeSession === "welcome" ? null : activeSession);
  const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false); const [timeline, setTimeline] = useState<TimelineEntry[]>([]); const [approvals, setApprovals] = useState<AppServerMessage[]>([]); const [diff, setDiff] = useState("");
  const [turnId, setTurnId] = useState<string | null>(null); const [resumedId, setResumedId] = useState<string | null>(null); const [models, setModels] = useState<AgentModel[]>([]); const [selectedModel, setSelectedModel] = useState(configuredModel); const [effort, setEffort] = useState("medium"); const [historyLoading, setHistoryLoading] = useState(false);
  const [goal, setGoal] = useState("");
  const [images, setImages] = useState<string[]>([]); const [availableSkills, setAvailableSkills] = useState<RuntimeSkill[]>([]); const [selectedSkillPath, setSelectedSkillPath] = useState("");
  const [showFiles, setShowFiles] = useState(false); const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceEntry[]>([]); const [selectedFile, setSelectedFile] = useState<string | null>(null); const [fileContent, setFileContent] = useState(""); const [fileQuery, setFileQuery] = useState("");
  const [showTerminal, setShowTerminal] = useState(false); const [terminalCommand, setTerminalCommand] = useState(""); const [terminalOutput, setTerminalOutput] = useState(""); const [terminalId, setTerminalId] = useState<string | null>(null); const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);
  useEffect(() => {
    setThreadId(activeSession === "welcome" ? null : activeSession); setResumedId(null); setTimeline([]); setDiff(""); setGoal(""); setHistoryLoading(false);
    if (activeSession !== "welcome" && runtime.status === "ready") {
      if (adapter !== "codex-responses") {
        try { setTimeline(JSON.parse(localStorage.getItem(`kunlun-native-timeline:${activeSession}`) ?? "[]") as TimelineEntry[]); } catch { setTimeline([]); }
        return;
      }
      setHistoryLoading(true);
      void readAgentThread(activeSession).then((response) => setTimeline(timelineFromThreadResponse(response as Record<string, unknown>))).finally(() => setHistoryLoading(false));
      if (engine === "codex") void getAgentThreadGoal(activeSession).then((response) => { const root = unwrapResult(response); const value = root.goal && typeof root.goal === "object" ? root.goal as Record<string, unknown> : {}; setGoal(String(value.objective ?? "")); }).catch(() => undefined);
    }
  }, [activeSession, adapter, runtime.status]);
  useEffect(() => {
    if (adapter !== "codex-responses" && threadId) localStorage.setItem(`kunlun-native-timeline:${threadId}`, JSON.stringify(timeline.slice(-200)));
  }, [adapter, threadId, timeline]);
  useEffect(() => {
    if (engine !== "codex" || runtime.status !== "ready") return;
    if (adapter !== "codex-responses") { setModels([]); setSelectedModel(configuredModel); setEffort(""); setAvailableSkills([]); return; }
    void listAgentModels().then((catalog) => { setModels(catalog); const selected = catalog.find((item) => item.model === configuredModel) ?? catalog.find((item) => item.isDefault) ?? catalog[0]; if (selected) { setSelectedModel(selected.model); setEffort(selected.defaultReasoningEffort); } });
    if (cwd) void loadRuntimeSkills(cwd).then((items) => setAvailableSkills(items.filter((item) => item.enabled && item.path))).catch(() => setAvailableSkills([]));
  }, [engine, adapter, runtime.status, configuredModel, cwd]);
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void onAppServerNotification((message) => { const entry = normalizeRuntimeEvent(message); if (entry) setTimeline((current) => mergeTimelineEntry(current, entry).slice(-200)); if (message.method === "command/exec/outputDelta") { const encoded = String(message.params?.deltaBase64 ?? ""); if (encoded) setTerminalOutput((current) => `${current}${decodeBase64Utf8(encoded)}`.slice(-120_000)); } if (message.method === "turn/started") { const id = nestedId(message, "turn"); if (id) setTurnId(id); } if (message.method?.includes("diff")) setDiff(String(message.params?.diff ?? "")); if (message.method === "serverRequest/resolved") { const requestId = message.params?.requestId; if (requestId !== undefined) setApprovals((current) => current.filter((item) => String(item.id) !== String(requestId))); } if (message.method === "turn/completed" || message.method === "turn/end") { setBusy(false); setTurnId(null); if (cwd) void readGitDiff(cwd).then(setDiff).catch(() => undefined); } }).then((cleanup) => cleanups.push(cleanup));
    void onAppServerRequest((message) => setApprovals((current) => current.some((item) => String(item.id) === String(message.id)) ? current : [...current, message])).then((cleanup) => cleanups.push(cleanup)); return () => cleanups.forEach((cleanup) => cleanup());
  }, [cwd]);
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void onTerminalOutput((event) => setTerminalOutput((current) => `${current}${event.chunk}`.slice(-120_000))).then((cleanup) => cleanups.push(cleanup));
    void onTerminalExit((event) => { setTerminalExitCode(event.code); setTerminalId(null); }).then((cleanup) => cleanups.push(cleanup));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);
  async function chooseProject() { try { const selected = await open({ directory: true, multiple: false, title: "选择代码项目" }); if (typeof selected === "string") { onCwd(selected); setThreadId(null); setTimeline([]); } } catch { onCwd("/workspace/kunlun-growth"); setThreadId(null); setTimeline([]); } }
  async function openFiles() { if (!cwd) { await chooseProject(); return; } setShowFiles(true); setWorkspaceFiles(await listWorkspaceFiles(cwd)); }
  async function attachImages() { const selected = await open({ multiple: true, directory: false, title: "添加图片", filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] }); const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : []; setImages((current) => [...new Set([...current, ...paths])].slice(0, 8)); }
  async function previewFile(path: string) { setSelectedFile(path); setFileContent("正在读取…"); try { setFileContent(await readWorkspaceFile(cwd, path)); } catch (error) { setFileContent(String(error)); } }
  function referenceFile(path: string) { setPrompt((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${path} `); setShowFiles(false); }
  async function executeTerminal() {
    const command = terminalCommand.trim(); if (!cwd || !command) return;
    if (terminalId && engine === "codex") { setTerminalCommand(""); await writeSandboxTerminal(terminalId, `${command}\r\n`); return; }
    if (terminalId) return; setTerminalExitCode(null); setTerminalOutput((current) => `${current}${current ? "\n" : ""}> ${command}\n`); setTerminalCommand("");
    if (engine === "codex" && runtime.status === "ready") { const id = `kunlun-terminal-${Date.now()}`; setTerminalId(id); try { const response = await runSandboxTerminal(cwd, command, id); const result = unwrapResult(response); setTerminalExitCode(Number(result.exitCode ?? 0)); } catch (error) { setTerminalOutput((current) => `${current}\n${String(error)}\n`); setTerminalExitCode(-1); } finally { setTerminalId(null); } return; }
    const id = await runTerminalCommand(cwd, command); setTerminalId(id); if (id.startsWith("web-terminal")) { setTerminalOutput((current) => `${current}Web 预览不执行系统命令；桌面版会流式显示真实输出。\n`); setTerminalId(null); setTerminalExitCode(0); }
  }
  async function send() {
    const text = prompt.trim(); if (!text) return; if (!cwd) { await chooseProject(); return; }
    if (busy) {
      if (!threadId || !turnId || engine !== "codex" || adapter !== "codex-responses") return;
      setPrompt(""); setTimeline((current) => [...current, { id: `steer-${Date.now()}`, kind: "message", title: "追加指令", text, status: "completed" }]);
      try { await steerAgentTurn(threadId, turnId, text); } catch (error) { setTimeline((current) => [...current, { id: `steer-error-${Date.now()}`, kind: "error", title: "追加指令失败", text: String(error), status: "failed" }]); }
      return;
    }
    setPrompt(""); setBusy(true); setTimeline((current) => [...current, { id: `user-${Date.now()}`, kind: "message", title: "你", text, status: "completed" }]);
    try {
      if (runtime.status !== "ready") onRuntime(await startRuntime(engine));
      let currentThread = threadId;
      if (!currentThread) { const created = await createAgentThread(cwd, selectedModel || configuredModel, engine); currentThread = nestedId(created, engine === "codex" ? "thread" : "session"); if (!currentThread) throw new Error("运行时没有返回会话 ID"); setThreadId(currentThread); setResumedId(currentThread); onSession({ id: currentThread, engine, title: text.slice(0, 28), cwd, updatedAt: new Date().toISOString(), status: "running" }); }
      else if (resumedId !== currentThread) { await resumeAgentThread(currentThread, cwd, adapter === "codex-responses" ? selectedModel || configuredModel : undefined); setResumedId(currentThread); }
      const selectedSkill = availableSkills.find((skill) => skill.path === selectedSkillPath); const history = adapter === "codex-responses" ? [] : timeline.filter((entry) => entry.kind === "message" && entry.text && (entry.title === "你" || entry.title === "助手回复")).map((entry) => ({ role: entry.title === "你" ? "user" as const : "assistant" as const, content: entry.text! })); const started = await startAgentTurn(currentThread, cwd, text, selectedModel || configuredModel, effort, images, selectedSkill, history); setImages([]); const startedTurn = nestedId(started, "turn"); if (startedTurn) setTurnId(startedTurn);
    } catch (error) { setTimeline((current) => [...current, { id: `error-${Date.now()}`, kind: "error", title: "任务启动失败", text: String(error), status: "failed" }]); setBusy(false); }
  }
  async function renameCurrent() {
    if (!threadId || engine !== "codex") return;
    const name = window.prompt("新的任务名称"); if (!name?.trim()) return;
    await renameAgentThread(threadId, name); onSessions((current) => current.map((session) => session.id === threadId ? { ...session, title: name.trim() } : session));
  }
  async function archiveCurrent() {
    if (!threadId || engine !== "codex") return;
    await archiveAgentThread(threadId); onSessions((current) => current.filter((session) => session.id !== threadId)); onActiveSession("welcome"); setThreadId(null); setTimeline([]);
  }
  async function forkCurrent() {
    if (!threadId || engine !== "codex" || busy) return;
    const response = await forkAgentThread(threadId); const forkedId = nestedId(response, "thread"); if (!forkedId) return;
    onSession({ id: forkedId, engine, title: "分叉任务", cwd, updatedAt: new Date().toISOString(), status: "idle" }); setThreadId(forkedId); setResumedId(forkedId); setTimeline(timelineFromThreadResponse(response as Record<string, unknown>));
  }
  async function reviewCurrent() {
    if (!threadId || engine !== "codex" || busy) return;
    setBusy(true); setTimeline((current) => [...current, { id: `review-${Date.now()}`, kind: "status", title: "正在审查未提交变更", status: "running" }]);
    try { const response = await startAgentReview(threadId); const id = nestedId(response, "turn"); if (id) setTurnId(id); } catch (error) { setBusy(false); setTimeline((current) => [...current, { id: `review-error-${Date.now()}`, kind: "error", title: "代码审查启动失败", text: String(error), status: "failed" }]); }
  }
  async function editGoal() {
    if (!threadId || engine !== "codex") return;
    const objective = window.prompt("为这个任务设置持久目标", goal); if (!objective?.trim()) return;
    await setAgentThreadGoal(threadId, objective.trim()); setGoal(objective.trim());
  }
  async function interruptCurrent() {
    if (!threadId || !turnId) return; await interruptAgentTurn(threadId, turnId); setBusy(false); setTurnId(null);
  }
  async function resolveApproval(message: AppServerMessage, decision: ApprovalDecision) {
    if (message.id === undefined) return;
    const method = message.method ?? ""; const params = message.params ?? {};
    if (method.includes("permissions/requestApproval")) { const requested = (params.permissions ?? params.requestedPermissions ?? {}) as Record<string, unknown>; await respondToServerRequest(message.id, { permissions: decision.startsWith("accept") ? requested : {}, scope: decision === "acceptForSession" ? "session" : "turn" }); }
    else if (method.includes("mcpServer/elicitation")) await respondToServerRequest(message.id, { action: decision === "accept" || decision === "acceptForSession" ? "accept" : decision === "cancel" ? "cancel" : "decline", content: null });
    else await respondToApproval(message.id, decision);
    setApprovals((current) => current.filter((item) => String(item.id) !== String(message.id)));
  }
  const stats = useMemo(() => ({ commands: timeline.filter((item) => item.kind === "command").length, files: timeline.filter((item) => item.kind === "file").length }), [timeline]);
  const selectedCatalogModel = models.find((item) => item.model === selectedModel);
  const composerBlocks = visibleBlocks(blocks, "composer", engine);
  const composerBlockIds = new Set(composerBlocks.map((block) => block.id));
  const visibleTimeline = timeline.filter((entry) => (entry.kind !== "plan" || composerBlockIds.has("plan")) && (entry.kind !== "command" || composerBlockIds.has("terminal")));
  return <section className="workspace-grid">
    <section className="conversation-pane">
      <header className="pane-header"><div><small>{goal ? `目标：${goal}` : cwd ? compactPath(cwd) : "未选择项目"}</small><h1>{threadId ? "开发任务" : "新任务"}</h1></div><div>{threadId && engine === "codex" && <><button className="icon-button" onClick={() => void editGoal()} title="持久目标">◎</button><button className="icon-button" disabled={busy} onClick={() => void reviewCurrent()} title="审查未提交变更">审</button><button className="icon-button" disabled={busy} onClick={() => void forkCurrent()} title="分叉为新任务">⑂</button><button className="icon-button" onClick={() => void renameCurrent()} title="重命名">✎</button><button className="icon-button" onClick={() => void archiveCurrent()} title="归档">▣</button></>}<button className="ghost-button" onClick={() => void chooseProject()}>▰ {cwd ? "更换项目" : "打开项目"}</button><span className="engine-chip">统一智能体</span></div></header>
      <div className={`timeline ${visibleTimeline.length === 0 ? "empty" : ""}`}>{historyLoading && <div className="history-loading">正在恢复完整会话…</div>}{visibleTimeline.length === 0 && !historyLoading && <Welcome onPrompt={setPrompt} />}{visibleTimeline.map((entry, index) => <TimelineCard key={`${entry.id}-${index}`} entry={entry} />)}</div>
      {approvals.length > 0 && <ApprovalCenter approvals={approvals} onResolve={(message, decision) => void resolveApproval(message, decision)} />}
      <div className="composer">
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={cwd ? busy ? "代理运行中，可继续输入追加指令" : "描述任务，@ 引用文件，Shift+Enter 换行" : "先打开一个项目，然后开始任务"} />
        {(images.length > 0 || selectedSkillPath) && <div className="composer-attachments">{images.map((path) => <button key={path} onClick={() => setImages((current) => current.filter((item) => item !== path))}>▧ {compactPath(path)} ×</button>)}{selectedSkillPath && <button onClick={() => setSelectedSkillPath("")}>◆ {availableSkills.find((skill) => skill.path === selectedSkillPath)?.name} ×</button>}</div>}
        <div className="composer-mode-row">{composerBlocks.map((block) => <button key={block.id} onClick={() => { if (block.id === "terminal") setShowTerminal(true); }}>{block.icon} {block.name}</button>)}</div>
        <div className="composer-tools"><span><button onClick={() => void openFiles()}>＋</button><button onClick={() => void openFiles()}>@</button>{adapter === "codex-responses" && <button onClick={() => void attachImages()} title="添加图片">▧</button>}{adapter === "codex-responses" && availableSkills.length > 0 && <select value={selectedSkillPath} onChange={(event) => setSelectedSkillPath(event.target.value)}><option value="">选择 Skill</option>{availableSkills.map((skill) => <option key={skill.path} value={skill.path}>{skill.name}</option>)}</select>}{adapter === "codex-responses" && models.length > 0 ? <select value={selectedModel} onChange={(event) => { const next = models.find((item) => item.model === event.target.value); setSelectedModel(event.target.value); if (next) setEffort(next.defaultReasoningEffort); }}>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select> : <em>{configuredModel || "默认模型"}</em>}{adapter === "codex-responses" && selectedCatalogModel && <select value={effort} onChange={(event) => setEffort(event.target.value)}>{selectedCatalogModel.supportedReasoningEfforts.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortName(item.reasoningEffort)}</option>)}</select>}</span>{busy ? <>{adapter === "codex-responses" && <button className="steer-button" disabled={!prompt.trim()} onClick={() => void send()}>追加</button>}<button className="stop-button" onClick={() => void interruptCurrent()}>■</button></> : <button className="send-button" disabled={!prompt.trim()} onClick={() => void send()}>↑</button>}</div>
      </div>
    </section>
    <Inspector engine={engine} runtime={runtime} cwd={cwd} threadId={threadId} stats={stats} diff={diff} blocks={blocks} onProject={chooseProject} onFiles={openFiles} onDiff={setDiff} />
    {showFiles && <FileBrowser files={workspaceFiles} query={fileQuery} selected={selectedFile} content={fileContent} onQuery={setFileQuery} onSelect={(path) => void previewFile(path)} onReference={referenceFile} onClose={() => setShowFiles(false)} />}
    {showTerminal && <TerminalDrawer cwd={cwd} command={terminalCommand} output={terminalOutput} running={Boolean(terminalId)} exitCode={terminalExitCode} onCommand={setTerminalCommand} onRun={() => void executeTerminal()} onStop={() => { if (terminalId) void (engine === "codex" && runtime.status === "ready" ? stopSandboxTerminal(terminalId) : stopTerminalCommand(terminalId)); }} onResize={(cols, rows) => { if (terminalId && engine === "codex") void resizeSandboxTerminal(terminalId, cols, rows); }} onClear={() => setTerminalOutput("")} onClose={() => setShowTerminal(false)} />}
  </section>;
}

function Welcome({ onPrompt }: { onPrompt(value: string): void }) { return <div className="welcome"><div className="welcome-mark">昆</div><h2>今天想构建什么？</h2><p>选择一个代码项目，然后描述任务。昆仑增长会读取代码、制定计划、执行命令并向你展示每一步。</p><div className="suggestions"><button onClick={() => onPrompt("分析这个项目的架构，并指出最值得优先改进的三个问题")}>分析项目架构<span>→</span></button><button onClick={() => onPrompt("运行测试并修复当前失败项")}>修复测试失败<span>→</span></button><button onClick={() => onPrompt("审查当前未提交的代码变更")}>审查代码变更<span>→</span></button></div></div>; }
function TimelineCard({ entry }: { entry: TimelineEntry }) { if (entry.kind === "message" && entry.title === "你") return <article className="user-message"><b>你</b><p>{entry.text}</p></article>; return <article className={`timeline-card ${entry.kind}`}><span className="timeline-icon">{iconFor(entry.kind)}</span><div><header><b>{entry.title}</b><em className={entry.status}>{entry.status === "running" ? "执行中" : entry.status === "failed" ? "失败" : "完成"}</em></header>{entry.detail && <small>{entry.detail}</small>}{entry.text && <pre>{entry.text}</pre>}{entry.paths?.map((path) => <code key={path}>{path}</code>)}</div></article>; }
function Inspector({ engine, runtime, cwd, threadId, stats, diff, blocks, onProject, onFiles, onDiff }: { engine: RuntimeEngine; runtime: RuntimeSnapshot; cwd: string; threadId: string | null; stats: { commands: number; files: number }; diff: string; blocks: BlockPreference[]; onProject(): Promise<void>; onFiles(): Promise<void>; onDiff(value: string): void }) {
  const visible = visibleBlocks(blocks, "inspector", engine);
  const runtimeBlocks = visibleBlocks(blocks, "runtime", engine);
  const enabledBlockIds = new Set([...visible, ...visibleBlocks(blocks, "composer", engine), ...runtimeBlocks].map((item) => item.id));
  const [skills, setSkills] = useState<string[]>([]); const [mcpServers, setMcpServers] = useState<string[]>([]);
  useEffect(() => {
    if (runtime.status !== "ready" || engine !== "codex" || !cwd) { setSkills([]); setMcpServers([]); return; }
    if (enabledBlockIds.has("skills")) void listRuntimeSkills(cwd).then((response) => setSkills(skillNames(response))).catch(() => setSkills([]));
    if (enabledBlockIds.has("mcp")) void listMcpServers(threadId ?? undefined).then((response) => setMcpServers(mcpNames(response))).catch(() => setMcpServers([]));
  }, [runtime.status, engine, cwd, threadId, blocks]);
  return <aside className="inspector-pane"><header><b>任务上下文</b><span>{visible.length} 块积木</span></header>{visible.map((block) => {
    if (block.id === "runtime") return <section key={block.id}><small>运行环境</small><div className="runtime-card"><span className={runtime.status} /><div><b>昆仑增长统一智能体</b><em>{runtime.status === "ready" ? `Codex + Harness 已连接${runtime.version ? ` · ${runtime.version}` : ""}` : "按发送时自动启动"}</em></div></div></section>;
    if (block.id === "files") return <section key={block.id}><small>文件浏览器</small><button className="context-row" onClick={() => void onFiles()}><span>▤</span><div><b>浏览与引用文件</b><em>预览源码并插入 @路径</em></div></button></section>;
    if (block.id === "workspace") return <section key={block.id}><small>工作区</small><button className="context-row" onClick={() => void onProject()}><span>▰</span><div><b>{cwd ? compactPath(cwd) : "选择项目"}</b><em>{cwd || "尚未授权文件访问"}</em></div></button></section>;
    if (block.id === "metrics") return <section key={block.id}><small>本次任务</small><div className="metric-grid"><div><b>{stats.commands}</b><em>命令</em></div><div><b>{stats.files}</b><em>文件变更</em></div></div></section>;
    if (block.id === "diff") return <section key={block.id} className="changes"><DiffReview cwd={cwd} diff={diff} onDiff={onDiff} /></section>;
    if (block.id === "capabilities") return <section key={block.id}><small>可用能力</small><div className="capability-list">{Object.entries(runtimeCatalog[engine].capabilities).filter(([name, value]) => value && capabilityEnabled(name, enabledBlockIds)).map(([name]) => <span key={name}>✓ {capabilityName(name)}</span>)}{runtimeBlocks.map((item) => <span key={item.id}>✓ {item.name}{item.id === "skills" && skills.length ? ` · ${skills.length}` : item.id === "mcp" && mcpServers.length ? ` · ${mcpServers.length}` : ""}</span>)}</div>{skills.length > 0 && <p className="runtime-detail">Skills：{skills.slice(0, 4).join("、")}</p>}{mcpServers.length > 0 && <p className="runtime-detail">MCP：{mcpServers.slice(0, 4).join("、")}</p>}</section>;
    return null;
  })}</aside>;
}

function ApprovalCenter({ approvals, onResolve }: { approvals: AppServerMessage[]; onResolve(message: AppServerMessage, decision: ApprovalDecision): void }) {
  const request = approvals[0]; const details = approvalDetails(request); const available = Array.isArray(request.params?.availableDecisions) ? request.params!.availableDecisions.map(String) : [];
  const allowSession = available.length === 0 || available.includes("acceptForSession");
  return <section className="approval-center"><header><span>!</span><div><b>{details.title}</b><small>{approvals.length > 1 ? `还有 ${approvals.length - 1} 个审批等待处理` : details.subtitle}</small></div><em>{details.kind}</em></header>{details.command && <pre>{details.command}</pre>}{details.reason && <p>{details.reason}</p>}{details.target && <code>{details.target}</code>}<footer><button onClick={() => onResolve(request, "cancel")}>取消任务</button><button onClick={() => onResolve(request, "decline")}>拒绝</button>{allowSession && <button onClick={() => onResolve(request, "acceptForSession")}>本会话允许</button>}<button className="primary" onClick={() => onResolve(request, "accept")}>允许一次</button></footer></section>;
}

function FileBrowser({ files, query, selected, content, onQuery, onSelect, onReference, onClose }: { files: WorkspaceEntry[]; query: string; selected: string | null; content: string; onQuery(value: string): void; onSelect(path: string): void; onReference(path: string): void; onClose(): void }) {
  const filtered = files.filter((entry) => !entry.isDir && (!query || entry.path.toLowerCase().includes(query.toLowerCase()))).slice(0, 500);
  return <div className="workspace-overlay" role="dialog" aria-label="工作区文件"><section className="file-browser"><header><div><small>工作区</small><h2>浏览与引用文件</h2></div><button onClick={onClose}>×</button></header><div className="file-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="按路径搜索文件" /><em>{filtered.length} 个文件</em></div><div className="file-browser-grid"><nav>{filtered.map((entry) => <button key={entry.path} className={selected === entry.path ? "active" : ""} onClick={() => onSelect(entry.path)}><span>{fileIcon(entry.path)}</span><div><b>{entry.name}</b><small>{entry.path}</small></div><em>{formatBytes(entry.size)}</em></button>)}</nav><article>{selected ? <><header><code>@{selected}</code><button onClick={() => onReference(selected)}>引用到任务</button></header><pre>{content}</pre></> : <div className="file-empty"><span>▤</span><b>选择文件预览</b><p>文件内容只从当前授权工作区读取。</p></div>}</article></div></section></div>;
}

function TerminalDrawer({ cwd, command, output, running, exitCode, onCommand, onRun, onStop, onResize, onClear, onClose }: { cwd: string; command: string; output: string; running: boolean; exitCode: number | null; onCommand(value: string): void; onRun(): void; onStop(): void; onResize(cols: number, rows: number): void; onClear(): void; onClose(): void }) {
  useEffect(() => { const resize = () => onResize(Math.max(40, Math.floor((window.innerWidth - 270) / 8)), 16); if (running) resize(); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, [running]);
  return <div className="terminal-drawer" role="dialog" aria-label="集成终端"><header><div><span>&gt;_</span><b>沙箱 PTY 终端</b><small>{cwd || "未选择工作区"}</small></div><nav><em className={running ? "running" : ""}>{running ? "交互会话" : exitCode === null ? "就绪" : `退出 ${exitCode}`}</em>{running && <button className="terminal-stop" onClick={onStop}>停止</button>}<button onClick={onClear}>清空</button><button onClick={onClose}>×</button></nav></header><pre>{output || "昆仑增长沙箱终端已就绪。命令只在当前工作区执行，网络默认关闭。"}</pre><footer><span>❯</span><input autoFocus value={command} onChange={(event) => onCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onRun(); }} placeholder={running ? "向当前进程发送输入" : "输入命令，例如 npm test"} disabled={!cwd} /><button onClick={onRun} disabled={!command.trim() || !cwd}>{running ? "发送" : "运行"}</button></footer></div>;
}

function DiffReview({ cwd, diff, onDiff }: { cwd: string; diff: string; onDiff(value: string): void }) {
  const files = useMemo(() => parseDiffFiles(diff), [diff]); const [selected, setSelected] = useState("全部");
  useEffect(() => { if (selected !== "全部" && !files.some((file) => file.path === selected)) setSelected("全部"); }, [files, selected]);
  const shown = selected === "全部" ? diff : files.find((file) => file.path === selected)?.content ?? diff;
  return <><header className="diff-header"><small>代码变更</small><button disabled={!cwd} onClick={() => void readGitDiff(cwd).then(onDiff)}>↻</button></header>{files.length > 0 && <select className="diff-select" value={selected} onChange={(event) => setSelected(event.target.value)}><option>全部</option>{files.map((file) => <option key={file.path}>{file.path}</option>)}</select>}{shown ? <pre>{shown}</pre> : <p>当前工作区没有未提交的代码差异。</p>}</>;
}

interface ProviderProps { runtime: RuntimeSnapshot; baseUrl: string; model: string; protocol: ProviderProtocol; adapter: ProviderAdapter; profileId: string; providerId: string; providerName: string; profiles: ProviderConfigPayload[]; apiKey: string; authHeader: string; saved: boolean; onRuntime(value: RuntimeSnapshot): void; onBaseUrl(value: string): void; onModel(value: string): void; onProtocol(value: ProviderProtocol): void; onAdapter(value: ProviderAdapter): void; onProfileId(value: string): void; onProviderId(value: string): void; onProviderName(value: string): void; onActivate(id: string): void; onApiKey(value: string): void; onAuthHeader(value: string): void; onSave(): void }
function ProviderSettings(props: ProviderProps) {
  const [loginUrl, setLoginUrl] = useState(""); const [loginError, setLoginError] = useState(""); const [remoteModels, setRemoteModels] = useState<string[]>([]); const [modelError, setModelError] = useState(""); const [discovering, setDiscovering] = useState(false); const active = matchProvider(props.baseUrl);
  function selectProvider(provider: ProviderPreset) { props.onProfileId(`${provider.id}-${Date.now()}`); props.onProtocol(provider.protocol); props.onAdapter(provider.adapter); props.onProviderId(provider.id); props.onProviderName(provider.name); props.onBaseUrl(provider.baseUrl); props.onModel(provider.suggestedModels[0] ?? ""); setLoginUrl(""); }
  async function connectCodex() {
    setLoginError("");
    try { if (props.runtime.status !== "ready") props.onRuntime(await startRuntime("codex")); const result = unwrapResult(await startCodexAccountLogin()); setLoginUrl(String(result.authUrl ?? "")); }
    catch (error) { setLoginError(String(error)); }
  }
  async function discoverModels() { setDiscovering(true); setModelError(""); try { setRemoteModels(await discoverProviderModels({ id: props.profileId, providerId: props.providerId || "custom", displayName: props.providerName || "自定义模型", protocol: props.protocol, adapter: props.adapter, baseUrl: props.baseUrl, model: props.model, authMethod: "api-key", authHeader: props.authHeader.trim() || null, credentialRef: null }, props.apiKey)); } catch (error) { setModelError(String(error)); } finally { setDiscovering(false); } }
  return <section className="settings-page provider-page"><header><small>设置</small><h1>账号与模型</h1><p>直接连接智能体账号，或从全球模型服务中选择供应商；任务界面始终保持统一。</p></header>
    <div className="settings-section"><h2>账号直连</h2><div className="account-connect-grid"><article><span>⌘</span><div><b>Codex / ChatGPT</b><small>使用官方 App Server OAuth 登录并读取账号模型</small></div><button onClick={() => void connectCodex()}>{props.runtime.status === "ready" ? "连接 Codex" : "启动并连接"}</button></article><article><span>克</span><div><b>Claude API</b><small>使用 Anthropic 原生 Messages API，不做协议伪装</small></div><button onClick={() => selectProvider(providerPresets.find((item) => item.id === "anthropic")!)}>配置 Claude</button></article></div>{loginUrl && <div className="login-result"><span>登录地址已生成</span><a href={loginUrl} target="_blank" rel="noreferrer">在浏览器中完成 Codex 登录 ↗</a></div>}{loginError && <div className="extension-error">{loginError}</div>}</div>
    <div className="settings-section"><div className="config-header"><h2>已保存模型档案</h2><button onClick={() => selectProvider(providerPresets.at(-1)!)}>＋ 新建档案</button></div><div className="saved-profiles">{props.profiles.map((profile) => <button key={profile.id} className={profile.id === props.profileId ? "active" : ""} onClick={() => props.onActivate(profile.id)}><span>{profile.displayName.slice(0, 1)}</span><div><b>{profile.displayName}</b><small>{profile.model || "账号默认模型"} · {profile.adapter === "codex-responses" ? "Codex" : profile.adapter === "anthropic-messages" ? "Claude" : "兼容 API"}</small></div>{profile.id === props.profileId && <i>当前</i>}</button>)}{!props.profiles.length && <p className="profiles-empty">保存后可在这里一键切换，不会要求再次填写密钥。</p>}</div></div>
    <div className="settings-section"><h2>全球模型服务</h2><div className="provider-presets">{providerPresets.map((provider) => <button key={provider.id} className={active.id === provider.id ? "active" : ""} onClick={() => selectProvider(provider)}><span>{provider.name.slice(0, 1)}</span><div><b>{provider.name}</b><small>{provider.region} · {provider.note}</small></div>{active.id === provider.id && <i>✓</i>}</button>)}</div></div>
    <div className="settings-section"><h2>配置档案 · {active.name}</h2><div className="form-grid"><label>协议<select value={props.protocol} onChange={(event) => props.onProtocol(event.target.value as ProviderProtocol)}><option value="openai">OpenAI</option><option value="azure-openai">Azure OpenAI</option><option value="openai-compatible">OpenAI-compatible</option></select></label><label>内部适配器<select value={props.adapter} onChange={(event) => props.onAdapter(event.target.value as ProviderAdapter)}><option value="codex-responses">Codex · Responses</option><option value="openai-chat">Chat Completions</option><option value="anthropic-messages">Claude · Messages</option></select></label><label>模型 ID<span className="field-action"><button type="button" onClick={() => void discoverModels()} disabled={discovering}>{discovering ? "读取中…" : "读取模型"}</button></span><input list="provider-models" value={props.model} onChange={(event) => props.onModel(event.target.value)} placeholder="填写或选择模型" /><datalist id="provider-models">{[...new Set([...active.suggestedModels, ...remoteModels])].map((item) => <option key={item} value={item} />)}</datalist></label><label>档案名称<input value={props.providerName} onChange={(event) => props.onProviderName(event.target.value)} placeholder="例如：公司 Claude" /></label><label className="full">API Base URL<input value={props.baseUrl} onChange={(event) => { props.onBaseUrl(event.target.value); props.onProviderId("custom"); }} /></label><label>认证头名称<input value={props.authHeader} onChange={(event) => props.onAuthHeader(event.target.value)} placeholder={props.adapter === "anthropic-messages" ? "x-api-key（默认）" : "Authorization（默认）"} /><small>仅填写头名称；Key 仍保存在系统凭据库</small></label><label>API Key<input type="password" value={props.apiKey} onChange={(event) => props.onApiKey(event.target.value)} placeholder="安全保存到系统凭据库，不写入项目配置" /></label></div>{modelError && <div className="extension-error">{modelError}</div>}<div className="adapter-notice">{props.adapter === "codex-responses" ? "由 Codex App Server 提供完整代理、审批、Skills 与 MCP 能力。" : props.adapter === "anthropic-messages" ? "将由 Claude 原生 Messages 适配器运行，不经过 Codex 协议转换。" : "将由兼容 Chat Completions 的独立适配器运行，不受 Codex Responses 限制。"}</div><div className="settings-actions"><button className="primary" disabled={!props.baseUrl.startsWith("https://") || !props.model.trim() && props.providerId !== "openai"} onClick={props.onSave}>{props.saved ? "已保存 ✓" : "保存并切换档案"}</button></div></div>
  </section>;
}
function SecuritySettings() { return <section className="settings-page"><header><small>企业治理</small><h1>安全策略</h1><p>策略在桌面核心执行，网页界面无法绕过。</p></header><div className="policy-grid"><Policy title="命令执行" value="风险操作审批" detail="普通读取自动执行，写入、安装与系统命令需要批准。" /><Policy title="文件访问" value="仅当前工作区" detail="默认禁止访问项目目录之外的文件。" /><Policy title="网络访问" value="默认关闭" detail="按域名白名单为单次任务开放网络。" /><Policy title="凭据与审计" value="系统凭据库" detail="密钥不进入模型上下文，日志默认本地保存并脱敏。" /></div></section>; }
function ExtensionSettings({ engine, runtime, cwd }: { engine: RuntimeEngine; runtime: RuntimeSnapshot; cwd: string }) {
  const [skills, setSkills] = useState<RuntimeSkill[]>([]); const [servers, setServers] = useState<RuntimeMcpServer[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  async function refresh() {
    if (runtime.status !== "ready" || !cwd || engine !== "codex") return;
    setLoading(true); setError("");
    try { const [nextSkills, nextServers] = await Promise.all([loadRuntimeSkills(cwd), loadMcpServers()]); setSkills(nextSkills); setServers(nextServers); }
    catch (reason) { setError(String(reason)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [engine, runtime.status, cwd]);
  async function toggleSkill(skill: RuntimeSkill) {
    if (!skill.path) return;
    const enabled = !skill.enabled; setSkills((current) => current.map((item) => item.path === skill.path ? { ...item, enabled } : item));
    try { await setRuntimeSkillEnabled(skill.path, enabled); } catch (reason) { setSkills((current) => current.map((item) => item.path === skill.path ? skill : item)); setError(String(reason)); }
  }
  const unavailable = engine !== "codex" || runtime.status !== "ready" || !cwd;
  return <section className="settings-page extensions-page"><header><small>积木运行时</small><h1>扩展能力</h1><p>Skills、MCP 与 Harness 能力全部进入同一个智能体，由任务上下文自动编排。</p></header>{unavailable && <div className="extension-notice">{runtime.status !== "ready" ? "先启动统一智能体，再读取扩展状态。" : "先在任务页选择一个工作区。"}</div>}{error && <div className="extension-error">{error}</div>}<div className="extension-toolbar"><div><b>{skills.filter((item) => item.enabled).length}</b><span>启用 Skills</span></div><div><b>{servers.length}</b><span>MCP 服务</span></div><button onClick={() => void refresh()} disabled={unavailable || loading}>{loading ? "读取中…" : "刷新状态"}</button></div><section className="extension-section"><header><div><h2>Skills</h2><p>把团队规范和专业流程按需装入代理上下文。</p></div></header><div className="extension-grid">{skills.map((skill) => <article key={`${skill.path}-${skill.name}`}><span>◆</span><div><b>{skill.name}</b><p>{skill.description}</p><small>{skill.scope}</small></div><label className="block-switch"><input type="checkbox" checked={skill.enabled} disabled={!skill.path} onChange={() => void toggleSkill(skill)} /><span /></label></article>)}{!skills.length && <EmptyExtension text={unavailable ? "连接工作区后读取 Skills" : "当前没有发现 Skills"} />}</div></section><section className="extension-section"><header><div><h2>MCP 服务</h2><p>连接企业系统、数据源和外部工具。</p></div></header><div className="extension-grid">{servers.map((server) => <article key={server.name}><span>⌘</span><div><b>{server.name}</b><p>{server.toolCount} 个工具 · 授权 {server.authStatus}</p><small>{server.status}</small></div><em className={`server-state ${server.status}`}>{server.status}</em></article>)}{!servers.length && <EmptyExtension text={unavailable ? "连接工作区后读取 MCP" : "当前没有配置 MCP 服务"} />}</div></section><section className="extension-section"><header><div><h2>Harness 增强</h2><p>能力自动路由，普通用户无需理解或选择底层内核。</p></div></header><div className="extension-grid"><article><span>深</span><div><b>DeepSeek Harness 增强层</b><p>Code Mode、子代理与插件协议通过统一任务入口调用</p><small>内部适配器 · 自动故障隔离</small></div><em className="server-state ready">已融合</em></article></div></section></section>;
}
function EmptyExtension({ text }: { text: string }) { return <div className="extension-empty">{text}</div>; }
function AccountSettings({ engine, runtime }: { engine: RuntimeEngine; runtime: RuntimeSnapshot }) {
  const [account, setAccount] = useState<Record<string, unknown>>({}); const [usage, setUsage] = useState<Record<string, unknown>>({}); const [config, setConfig] = useState<Record<string, unknown>>({}); const [modes, setModes] = useState<Array<Record<string, unknown>>>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  async function refresh() {
    if (engine !== "codex" || runtime.status !== "ready") return;
    setLoading(true); setError("");
    const results = await Promise.allSettled([readRuntimeAccount(), readRuntimeUsage(), listCollaborationModes(), readEffectiveConfig()]);
    const rejected = results.find((item) => item.status === "rejected"); if (rejected?.status === "rejected") setError(String(rejected.reason));
    if (results[0].status === "fulfilled") setAccount(unwrapResult(results[0].value));
    if (results[1].status === "fulfilled") setUsage(unwrapResult(results[1].value));
    if (results[2].status === "fulfilled") { const source = unwrapResult(results[2].value); setModes((Array.isArray(source.data) ? source.data : Array.isArray(source.modes) ? source.modes : []) as Array<Record<string, unknown>>); }
    if (results[3].status === "fulfilled") setConfig(unwrapResult(results[3].value)); setLoading(false);
  }
  useEffect(() => { void refresh(); }, [engine, runtime.status]);
  const accountInfo = (account.account && typeof account.account === "object" ? account.account : account) as Record<string, unknown>; const configInfo = (config.config && typeof config.config === "object" ? config.config : config) as Record<string, unknown>;
  return <section className="settings-page account-page"><header><small>统一智能体</small><h1>账户与运行配置</h1><p>读取主运行时账户、用量窗口、协作模式与最终生效的安全配置。</p></header>{runtime.status !== "ready" && <div className="extension-notice">请先启动统一智能体。</div>}{error && <div className="extension-error">部分状态读取失败：{error}</div>}<div className="account-summary"><article><small>身份</small><b>{String(accountInfo.email ?? accountInfo.name ?? accountInfo.type ?? "未登录 / API Key")}</b><p>{account.requiresOpenaiAuth === false ? "当前配置允许 API 凭据运行" : "使用 Codex 账户授权"}</p></article><article><small>用量窗口</small><b>{usageSummary(usage)}</b><p>数据由 App Server 账户用量接口提供</p></article><article><small>协作模式</small><b>{modes.length || "默认"}</b><p>{modes.slice(0, 3).map((mode) => String(mode.name ?? mode.mode ?? mode.id ?? "")).filter(Boolean).join("、") || "Default"}</p></article><article><small>安全沙箱</small><b>{String(configInfo.sandboxMode ?? configInfo.sandbox_mode ?? "workspaceWrite")}</b><p>审批：{String(configInfo.approvalPolicy ?? configInfo.approval_policy ?? "unlessTrusted")}</p></article></div><div className="settings-section"><div className="config-header"><h2>生效配置</h2><button onClick={() => void refresh()} disabled={loading || runtime.status !== "ready"}>{loading ? "读取中…" : "刷新"}</button></div><pre className="config-preview">{JSON.stringify(configInfo, null, 2)}</pre></div></section>;
}
function BlocksSettings({ preferences, engine, onChange }: { preferences: BlockPreference[]; engine: RuntimeEngine; onChange(value: BlockPreference[]): void }) {
  const preferenceMap = new Map(preferences.map((item) => [item.id, item]));
  return <section className="settings-page blocks-page"><header><small>自由组合</small><h1>功能积木</h1><p>每一项能力都是独立积木。选择展示或隐藏并调整顺序，工作台会立即重组；带锁积木由安全边界或企业策略固定。</p></header><div className="block-toolbar"><div><b>{preferences.filter((item) => item.enabled).length}</b><span>已启用</span></div><div><b>{featureBlocks.length}</b><span>可用积木</span></div><button onClick={() => onChange(defaultBlockPreferences())}>恢复默认布局</button></div>{(["navigation", "inspector", "composer", "runtime"] as const).map((slot) => {
    const slotBlocks = featureBlocks.filter((block) => block.slot === slot).sort((a, b) => (preferenceMap.get(a.id)?.order ?? 0) - (preferenceMap.get(b.id)?.order ?? 0));
    return <section className="block-group" key={slot}><header><div><h2>{slotName(slot)}</h2><p>{slotDescription(slot)}</p></div></header><div className="block-grid">{slotBlocks.map((block, index) => { const preference = preferenceMap.get(block.id)!; const compatible = block.engines.includes(engine); return <article className={`${preference.enabled ? "enabled" : ""} ${compatible ? "" : "incompatible"}`} key={block.id}><span className="block-icon">{block.icon}</span><div><b>{block.name}</b><p>{block.description}</p><small>{compatible ? "统一智能体" : "当前版本暂不可用"}</small></div><div className="block-actions"><button disabled={index === 0} onClick={() => onChange(moveBlock(preferences, block.id, -1))}>↑</button><button disabled={index === slotBlocks.length - 1} onClick={() => onChange(moveBlock(preferences, block.id, 1))}>↓</button><label className="block-switch"><input type="checkbox" checked={preference.enabled} disabled={block.required} onChange={(event) => onChange(updateBlockPreference(preferences, block.id, { enabled: event.target.checked }))} /><span /></label></div>{block.required && <em className="block-lock">锁定</em>}</article>; })}</div></section>;
  })}</section>;
}
function Policy({ title, value, detail }: { title: string; value: string; detail: string }) { return <article className="policy"><span>◈</span><div><small>{title}</small><h2>{value}</h2><p>{detail}</p></div><em>可托管</em></article>; }
function nestedId(message: AppServerMessage, kind: "thread" | "session" | "turn"): string | null { const source = (message.result ?? message.params ?? message) as Record<string, unknown>; const nested = source[kind] as Record<string, unknown> | undefined; return typeof nested?.id === "string" ? nested.id : typeof source.sessionId === "string" ? source.sessionId : null; }
function unwrapResult(message: AppServerMessage) { return (message.result ?? message) as Record<string, unknown>; }
function decodeBase64Utf8(value: string) { try { const binary = atob(value); const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)); return new TextDecoder().decode(bytes); } catch { return ""; } }
function usageSummary(usage: Record<string, unknown>) { const limits = Array.isArray(usage.rateLimits) ? usage.rateLimits as Array<Record<string, unknown>> : []; const first = limits[0]; if (!first) return "暂无数据"; const used = Number(first.usedPercent ?? first.used_percent ?? 0); return Number.isFinite(used) ? `${Math.round(used)}% 已用` : "已连接"; }
function compactPath(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
function approvalDetails(message: AppServerMessage) {
  const method = message.method ?? ""; const params = message.params ?? {};
  const reason = typeof params.reason === "string" ? params.reason : "";
  const rawCommand = params.command;
  const command = Array.isArray(rawCommand) ? rawCommand.map(String).join(" ") : typeof rawCommand === "string" ? rawCommand : "";
  const network = params.networkApprovalContext && typeof params.networkApprovalContext === "object" ? params.networkApprovalContext as Record<string, unknown> : null;
  if (network) {
    const host = String(network.host ?? network.hostname ?? "未知主机"); const port = network.port ? `:${network.port}` : ""; const protocol = network.protocol ? `${network.protocol}://` : "";
    return { title: "请求网络访问", subtitle: "代理希望连接工作区之外的服务", kind: "网络", command, reason, target: `${protocol}${host}${port}` };
  }
  if (method.includes("fileChange")) return { title: "请求修改文件", subtitle: String(params.cwd ?? "请检查变更范围"), kind: "文件", command, reason, target: String(params.grantRoot ?? params.path ?? "") };
  if (method.includes("permissions")) {
    const permissions = params.permissions ?? params.requestedPermissions ?? {};
    return { title: "请求额外权限", subtitle: "可仅为本轮或整个会话授权", kind: "权限", command, reason, target: typeof permissions === "string" ? permissions : JSON.stringify(permissions, null, 2) };
  }
  if (method.includes("mcpServer/elicitation")) return { title: "MCP 服务请求确认", subtitle: String(params.serverName ?? "外部工具需要你的确认"), kind: "MCP", command, reason, target: String(params.message ?? params.url ?? "") };
  return { title: "请求执行命令", subtitle: String(params.cwd ?? "请确认命令内容"), kind: "命令", command, reason, target: "" };
}
function iconFor(kind: TimelineEntry["kind"]) { return ({ message: "◆", reasoning: "◇", command: ">_", file: "±", tool: "⌁", plan: "☷", status: "✓", error: "!" })[kind]; }
function capabilityName(name: string) { return ({ history: "会话恢复", approvals: "安全审批", diff: "Diff 审阅", plan: "任务计划", subagents: "子代理", codeMode: "Code Mode" } as Record<string, string>)[name] ?? name; }
function capabilityEnabled(name: string, enabledBlocks: Set<string>) { if (name === "subagents" || name === "codeMode") return false; if (name === "plan") return enabledBlocks.has("plan"); if (name === "diff") return enabledBlocks.has("diff"); return true; }
function effortName(value: string) { return ({ low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "超强" } as Record<string, string>)[value] ?? value; }
function slotName(value: string) { return ({ navigation: "导航积木", inspector: "上下文面板", composer: "任务输入", runtime: "代理能力" } as Record<string, string>)[value] ?? value; }
function slotDescription(value: string) { return ({ navigation: "决定左侧展示哪些产品入口", inspector: "决定任务右侧展示哪些上下文", composer: "决定任务输入区可使用哪些工具", runtime: "决定代理可以加载哪些扩展能力" } as Record<string, string>)[value] ?? value; }
function fileIcon(path: string) { const extension = path.split(".").pop()?.toLowerCase(); return ({ ts: "TS", tsx: "TS", js: "JS", jsx: "JS", rs: "RS", md: "MD", json: "{}", css: "#", html: "<>" } as Record<string, string>)[extension ?? ""] ?? "·"; }
function formatBytes(size: number) { return size > 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : size > 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`; }
function parseDiffFiles(diff: string) { const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]; return matches.map((match, index) => ({ path: match[2], content: diff.slice(match.index!, matches[index + 1]?.index ?? diff.length) })); }
function skillNames(response: AppServerMessage) { const source = (response.result ?? response) as Record<string, unknown>; const groups = Array.isArray(source.data) ? source.data as Array<Record<string, unknown>> : []; const skills = groups.flatMap((group) => Array.isArray(group.skills) ? group.skills as Array<Record<string, unknown>> : []); return skills.filter((skill) => skill.enabled !== false).map((skill) => String(skill.name ?? "")).filter(Boolean); }
function mcpNames(response: AppServerMessage) { const source = (response.result ?? response) as Record<string, unknown>; const rows = (Array.isArray(source.data) ? source.data : Array.isArray(source.servers) ? source.servers : []) as Array<Record<string, unknown>>; return rows.map((row) => String(row.name ?? row.serverName ?? "")).filter(Boolean); }
