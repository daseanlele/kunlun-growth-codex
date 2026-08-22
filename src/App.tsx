import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { defaultConfig, type ProviderProtocol } from "./domain/enterprise-config";
import { defaultBlockPreferences, featureBlocks, mergeBlockPreferences, moveBlock, updateBlockPreference, visibleBlocks, type BlockPreference } from "./domain/blocks";
import { mergeTimelineEntry, normalizeRuntimeEvent, runtimeCatalog, timelineFromThreadResponse, type AgentModel, type RuntimeEngine, type RuntimeSession, type TimelineEntry } from "./domain/runtime";
import { archiveAgentThread, createAgentThread, getRuntimeStatus, interruptAgentTurn, listAgentModels, listAgentThreads, listMcpServers, listRuntimeSkills, listWorkspaceFiles, loadProviderConfig, onAppServerNotification, onAppServerRequest, onTerminalExit, onTerminalOutput, readAgentThread, readGitDiff, readWorkspaceFile, renameAgentThread, respondToApproval, resumeAgentThread, runTerminalCommand, saveProviderConfig, startAgentTurn, startRuntime, stopRuntime, stopTerminalCommand, type AppServerMessage, type RuntimeSnapshot, type WorkspaceEntry } from "./runtime-client";

type View = "workspace" | "providers" | "security" | "blocks";
type ThemeMode = "system" | "light" | "dark";
const demoSessions: RuntimeSession[] = [{ id: "welcome", engine: "codex", title: "欢迎使用昆仑增长", cwd: "", updatedAt: new Date().toISOString(), status: "idle" }];
const initialRuntime: RuntimeSnapshot = { status: "stopped", pid: null, binary: "codex", engine: "codex", available: true, lastError: null };

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [engine, setEngine] = useState<RuntimeEngine>("codex");
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(initialRuntime);
  const [sessions, setSessions] = useState<RuntimeSession[]>(demoSessions);
  const [activeSession, setActiveSession] = useState("welcome");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState(defaultConfig.provider.model);
  const [baseUrl, setBaseUrl] = useState(defaultConfig.provider.baseUrl);
  const [protocol, setProtocol] = useState<ProviderProtocol>(defaultConfig.provider.protocol);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [blocks, setBlocks] = useState<BlockPreference[]>(() => {
    try { return mergeBlockPreferences(JSON.parse(localStorage.getItem("kunlun-blocks") ?? "null")); } catch { return defaultBlockPreferences(); }
  });
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem("kunlun-theme") as ThemeMode | null) ?? "system");

  useEffect(() => {
    void getRuntimeStatus().then((snapshot) => { setRuntime(snapshot); setEngine(snapshot.engine); }).catch((error: unknown) => setRuntime({ ...initialRuntime, status: "error", lastError: String(error) }));
    void loadProviderConfig().then((config) => { setBaseUrl(config.baseUrl); setModel(config.model); setProtocol(config.protocol); });
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme; if (theme === "system") localStorage.removeItem("kunlun-theme"); else localStorage.setItem("kunlun-theme", theme); };
    apply(); media.addEventListener("change", apply); return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => { localStorage.setItem("kunlun-blocks", JSON.stringify(blocks)); }, [blocks]);

  async function activateEngine(next: RuntimeEngine) {
    if (next === engine) return;
    if (runtime.status === "ready") await stopRuntime();
    setEngine(next); setRuntime({ ...initialRuntime, engine: next, binary: next === "codex" ? "codex" : "dsh-acp" });
    if (next === "deepseek-harness" && baseUrl === "https://api.openai.com/v1") {
      setProtocol("openai-compatible"); setBaseUrl("https://api.deepseek.com"); if (!model) setModel("deepseek-v4-flash");
    } else if (next === "codex" && baseUrl === "https://api.deepseek.com") {
      setProtocol("openai"); setBaseUrl("https://api.openai.com/v1"); if (model === "deepseek-v4-flash") setModel("");
    }
    setSessions(demoSessions.map((session) => ({ ...session, engine: next }))); setActiveSession("welcome");
  }
  async function toggleRuntime() {
    setRuntime((current) => ({ ...current, status: "starting" }));
    try {
      const snapshot = runtime.status === "ready" ? await stopRuntime() : await startRuntime(engine);
      setRuntime(snapshot);
      if (snapshot.status === "ready") { const loaded = await listAgentThreads(engine).catch(() => []); if (loaded.length) setSessions(loaded); }
    } catch (error) { setRuntime((current) => ({ ...current, status: "error", available: false, lastError: String(error) })); }
  }

  const enabledNavigation = new Set(visibleBlocks(blocks, "navigation", engine).map((block) => block.id));
  return <main className="window-shell">
    <header className="titlebar" data-tauri-drag-region><div className="window-controls" aria-hidden="true"><i /><i /><i /></div><strong>昆仑增长</strong><div className="title-actions"><label className="compact-select">◐<select value={theme} onChange={(event) => setTheme(event.target.value as ThemeMode)}><option value="system">跟随系统</option><option value="light">日间</option><option value="dark">夜间</option></select></label><button className={`runtime-status ${runtime.status}`} onClick={() => void toggleRuntime()} title={runtime.lastError ?? runtime.binary}><i />{runtimeCatalog[engine].shortLabel} · {runtime.status}</button></div></header>
    <div className="app-frame">
      <aside className="task-sidebar">
        <div className="brand"><span>昆</span><div><b>昆仑增长</b><small>企业 AI 开发工作台</small></div></div>
        <button className="new-task" onClick={() => { setView("workspace"); setActiveSession("welcome"); }}>＋ 新建任务</button>
        <nav className="main-nav"><button className={view === "workspace" ? "active" : ""} onClick={() => setView("workspace")}><span>⌘</span>任务</button>{enabledNavigation.has("models") && <button className={view === "providers" ? "active" : ""} onClick={() => setView("providers")}><span>⌁</span>模型与内核</button>}{enabledNavigation.has("governance") && <button className={view === "security" ? "active" : ""} onClick={() => setView("security")}><span>◈</span>企业策略</button>}<button className={view === "blocks" ? "active" : ""} onClick={() => setView("blocks")}><span>▦</span>功能积木</button></nav>
        <div className="sidebar-label"><span>最近任务</span><button>•••</button></div>
        <div className="session-list">{sessions.map((session) => <button key={session.id} className={activeSession === session.id ? "active" : ""} onClick={() => { setActiveSession(session.id); if (session.cwd) setCwd(session.cwd); setView("workspace"); }}><i className={session.status} /><span><b>{session.title}</b><small>{session.cwd || runtimeCatalog[session.engine].label}</small></span></button>)}</div>
        <div className="account"><span>本</span><div><b>本地工作区</b><small>数据保留在设备</small></div><button>⚙</button></div>
      </aside>
      {view === "workspace" && <Workspace engine={engine} runtime={runtime} configuredModel={model} cwd={cwd} blocks={blocks} onCwd={setCwd} activeSession={activeSession} onSession={(session) => { setActiveSession(session.id); setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]); }} onSessions={setSessions} onActiveSession={setActiveSession} onRuntime={setRuntime} />}
      {view === "providers" && <ProviderSettings engine={engine} onEngine={(next) => void activateEngine(next)} baseUrl={baseUrl} model={model} protocol={protocol} apiKey={apiKey} saved={saved} onBaseUrl={setBaseUrl} onModel={setModel} onProtocol={setProtocol} onApiKey={setApiKey} onSave={() => void saveProviderConfig({ protocol, baseUrl, model, authMethod: "api-key", credentialRef: null }, apiKey).then(() => { setApiKey(""); setSaved(true); window.setTimeout(() => setSaved(false), 1800); })} />}
      {view === "security" && <SecuritySettings />}
      {view === "blocks" && <BlocksSettings preferences={blocks} engine={engine} onChange={setBlocks} />}
    </div>
  </main>;
}

interface WorkspaceProps { engine: RuntimeEngine; runtime: RuntimeSnapshot; configuredModel: string; cwd: string; activeSession: string; blocks: BlockPreference[]; onCwd(value: string): void; onSession(value: RuntimeSession): void; onSessions(value: RuntimeSession[] | ((current: RuntimeSession[]) => RuntimeSession[])): void; onActiveSession(value: string): void; onRuntime(value: RuntimeSnapshot): void }
function Workspace({ engine, runtime, configuredModel, cwd, blocks, onCwd, activeSession, onSession, onSessions, onActiveSession, onRuntime }: WorkspaceProps) {
  const [threadId, setThreadId] = useState<string | null>(activeSession === "welcome" ? null : activeSession);
  const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false); const [timeline, setTimeline] = useState<TimelineEntry[]>([]); const [approval, setApproval] = useState<AppServerMessage | null>(null); const [diff, setDiff] = useState("");
  const [turnId, setTurnId] = useState<string | null>(null); const [resumedId, setResumedId] = useState<string | null>(null); const [models, setModels] = useState<AgentModel[]>([]); const [selectedModel, setSelectedModel] = useState(configuredModel); const [effort, setEffort] = useState("medium"); const [historyLoading, setHistoryLoading] = useState(false);
  const [showFiles, setShowFiles] = useState(false); const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceEntry[]>([]); const [selectedFile, setSelectedFile] = useState<string | null>(null); const [fileContent, setFileContent] = useState(""); const [fileQuery, setFileQuery] = useState("");
  const [showTerminal, setShowTerminal] = useState(false); const [terminalCommand, setTerminalCommand] = useState(""); const [terminalOutput, setTerminalOutput] = useState(""); const [terminalId, setTerminalId] = useState<string | null>(null); const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);
  useEffect(() => {
    setThreadId(activeSession === "welcome" ? null : activeSession); setResumedId(null); setTimeline([]); setDiff("");
    if (activeSession !== "welcome" && runtime.status === "ready") {
      setHistoryLoading(true);
      void readAgentThread(activeSession).then((response) => setTimeline(timelineFromThreadResponse(response as Record<string, unknown>))).finally(() => setHistoryLoading(false));
    }
  }, [activeSession, runtime.status]);
  useEffect(() => {
    if (engine !== "codex" || runtime.status !== "ready") return;
    void listAgentModels().then((catalog) => { setModels(catalog); const selected = catalog.find((item) => item.model === configuredModel) ?? catalog.find((item) => item.isDefault) ?? catalog[0]; if (selected) { setSelectedModel(selected.model); setEffort(selected.defaultReasoningEffort); } });
  }, [engine, runtime.status, configuredModel]);
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void onAppServerNotification((message) => { const entry = normalizeRuntimeEvent(message); if (entry) setTimeline((current) => mergeTimelineEntry(current, entry).slice(-200)); if (message.method === "turn/started") { const id = nestedId(message, "turn"); if (id) setTurnId(id); } if (message.method?.includes("diff")) setDiff(String(message.params?.diff ?? "")); if (message.method === "turn/completed" || message.method === "turn/end") { setBusy(false); setTurnId(null); if (cwd) void readGitDiff(cwd).then(setDiff).catch(() => undefined); } }).then((cleanup) => cleanups.push(cleanup));
    void onAppServerRequest(setApproval).then((cleanup) => cleanups.push(cleanup)); return () => cleanups.forEach((cleanup) => cleanup());
  }, [cwd]);
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void onTerminalOutput((event) => setTerminalOutput((current) => `${current}${event.chunk}`.slice(-120_000))).then((cleanup) => cleanups.push(cleanup));
    void onTerminalExit((event) => { setTerminalExitCode(event.code); setTerminalId(null); }).then((cleanup) => cleanups.push(cleanup));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);
  async function chooseProject() { try { const selected = await open({ directory: true, multiple: false, title: "选择代码项目" }); if (typeof selected === "string") { onCwd(selected); setThreadId(null); setTimeline([]); } } catch { onCwd("/workspace/kunlun-growth"); setThreadId(null); setTimeline([]); } }
  async function openFiles() { if (!cwd) { await chooseProject(); return; } setShowFiles(true); setWorkspaceFiles(await listWorkspaceFiles(cwd)); }
  async function previewFile(path: string) { setSelectedFile(path); setFileContent("正在读取…"); try { setFileContent(await readWorkspaceFile(cwd, path)); } catch (error) { setFileContent(String(error)); } }
  function referenceFile(path: string) { setPrompt((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${path} `); setShowFiles(false); }
  async function executeTerminal() { const command = terminalCommand.trim(); if (!cwd || !command || terminalId) return; setTerminalExitCode(null); setTerminalOutput((current) => `${current}${current ? "\n" : ""}> ${command}\n`); const id = await runTerminalCommand(cwd, command); setTerminalId(id); setTerminalCommand(""); if (id.startsWith("web-terminal")) { setTerminalOutput((current) => `${current}Web 预览不执行系统命令；桌面版会流式显示真实输出。\n`); setTerminalId(null); setTerminalExitCode(0); } }
  async function send() {
    const text = prompt.trim(); if (!text || busy) return; if (!cwd) { await chooseProject(); return; }
    setPrompt(""); setBusy(true); setTimeline((current) => [...current, { id: `user-${Date.now()}`, kind: "message", title: "你", text, status: "completed" }]);
    try {
      if (runtime.status !== "ready") onRuntime(await startRuntime(engine));
      let currentThread = threadId;
      if (!currentThread) { const created = await createAgentThread(cwd, selectedModel || configuredModel, engine); currentThread = nestedId(created, engine === "codex" ? "thread" : "session"); if (!currentThread) throw new Error("运行时没有返回会话 ID"); setThreadId(currentThread); setResumedId(currentThread); onSession({ id: currentThread, engine, title: text.slice(0, 28), cwd, updatedAt: new Date().toISOString(), status: "running" }); }
      else if (resumedId !== currentThread) { await resumeAgentThread(currentThread, cwd, selectedModel || configuredModel); setResumedId(currentThread); }
      const started = await startAgentTurn(currentThread, cwd, text, selectedModel || configuredModel, effort); const startedTurn = nestedId(started, "turn"); if (startedTurn) setTurnId(startedTurn);
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
  async function interruptCurrent() {
    if (!threadId || !turnId) return; await interruptAgentTurn(threadId, turnId); setBusy(false); setTurnId(null);
  }
  const stats = useMemo(() => ({ commands: timeline.filter((item) => item.kind === "command").length, files: timeline.filter((item) => item.kind === "file").length }), [timeline]);
  const selectedCatalogModel = models.find((item) => item.model === selectedModel);
  const composerBlocks = visibleBlocks(blocks, "composer", engine);
  const composerBlockIds = new Set(composerBlocks.map((block) => block.id));
  const visibleTimeline = timeline.filter((entry) => (entry.kind !== "plan" || composerBlockIds.has("plan")) && (entry.kind !== "command" || composerBlockIds.has("terminal")));
  return <section className="workspace-grid">
    <section className="conversation-pane">
      <header className="pane-header"><div><small>{cwd ? compactPath(cwd) : "未选择项目"}</small><h1>{threadId ? "开发任务" : "新任务"}</h1></div><div>{threadId && engine === "codex" && <><button className="icon-button" onClick={() => void renameCurrent()} title="重命名">✎</button><button className="icon-button" onClick={() => void archiveCurrent()} title="归档">▣</button></>}<button className="ghost-button" onClick={() => void chooseProject()}>▰ {cwd ? "更换项目" : "打开项目"}</button><span className="engine-chip">{runtimeCatalog[engine].label}</span></div></header>
      <div className={`timeline ${visibleTimeline.length === 0 ? "empty" : ""}`}>{historyLoading && <div className="history-loading">正在恢复完整会话…</div>}{visibleTimeline.length === 0 && !historyLoading && <Welcome onPrompt={setPrompt} />}{visibleTimeline.map((entry, index) => <TimelineCard key={`${entry.id}-${index}`} entry={entry} />)}</div>
      {approval?.id !== undefined && <div className="approval-card"><span>!</span><div><b>运行时请求授权</b><small>{approval.method ?? "敏感操作"}</small></div><button onClick={() => { void respondToApproval(approval.id!, "decline"); setApproval(null); }}>拒绝</button><button className="primary" onClick={() => { void respondToApproval(approval.id!, "accept"); setApproval(null); }}>允许一次</button></div>}
      <div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={cwd ? "描述任务，@ 引用文件，Shift+Enter 换行" : "先打开一个项目，然后开始任务"} /><div className="composer-mode-row">{composerBlocks.map((block) => <button key={block.id} onClick={() => { if (block.id === "terminal") setShowTerminal(true); }}>{block.icon} {block.name}</button>)}</div><div className="composer-tools"><span><button onClick={() => void openFiles()}>＋</button><button onClick={() => void openFiles()}>@</button>{engine === "codex" && models.length > 0 ? <select value={selectedModel} onChange={(event) => { const next = models.find((item) => item.model === event.target.value); setSelectedModel(event.target.value); if (next) setEffort(next.defaultReasoningEffort); }}>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select> : <em>{selectedModel || configuredModel || "默认模型"}</em>}{engine === "codex" && selectedCatalogModel && <select value={effort} onChange={(event) => setEffort(event.target.value)}>{selectedCatalogModel.supportedReasoningEfforts.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortName(item.reasoningEffort)}</option>)}</select>}</span>{busy ? <button className="stop-button" onClick={() => void interruptCurrent()}>■</button> : <button className="send-button" disabled={!prompt.trim()} onClick={() => void send()}>↑</button>}</div></div>
    </section>
    <Inspector engine={engine} runtime={runtime} cwd={cwd} threadId={threadId} stats={stats} diff={diff} blocks={blocks} onProject={chooseProject} onFiles={openFiles} onDiff={setDiff} />
    {showFiles && <FileBrowser files={workspaceFiles} query={fileQuery} selected={selectedFile} content={fileContent} onQuery={setFileQuery} onSelect={(path) => void previewFile(path)} onReference={referenceFile} onClose={() => setShowFiles(false)} />}
    {showTerminal && <TerminalDrawer cwd={cwd} command={terminalCommand} output={terminalOutput} running={Boolean(terminalId)} exitCode={terminalExitCode} onCommand={setTerminalCommand} onRun={() => void executeTerminal()} onStop={() => { if (terminalId) void stopTerminalCommand(terminalId); }} onClear={() => setTerminalOutput("")} onClose={() => setShowTerminal(false)} />}
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
    if (block.id === "runtime") return <section key={block.id}><small>运行环境</small><div className="runtime-card"><span className={runtime.status} /><div><b>{runtimeCatalog[engine].label}</b><em>{runtime.status === "ready" ? `已连接${runtime.version ? ` · ${runtime.version}` : ""}` : "按发送时自动启动"}</em></div></div></section>;
    if (block.id === "files") return <section key={block.id}><small>文件浏览器</small><button className="context-row" onClick={() => void onFiles()}><span>▤</span><div><b>浏览与引用文件</b><em>预览源码并插入 @路径</em></div></button></section>;
    if (block.id === "workspace") return <section key={block.id}><small>工作区</small><button className="context-row" onClick={() => void onProject()}><span>▰</span><div><b>{cwd ? compactPath(cwd) : "选择项目"}</b><em>{cwd || "尚未授权文件访问"}</em></div></button></section>;
    if (block.id === "metrics") return <section key={block.id}><small>本次任务</small><div className="metric-grid"><div><b>{stats.commands}</b><em>命令</em></div><div><b>{stats.files}</b><em>文件变更</em></div></div></section>;
    if (block.id === "diff") return <section key={block.id} className="changes"><DiffReview cwd={cwd} diff={diff} onDiff={onDiff} /></section>;
    if (block.id === "capabilities") return <section key={block.id}><small>可用能力</small><div className="capability-list">{Object.entries(runtimeCatalog[engine].capabilities).filter(([name, value]) => value && capabilityEnabled(name, enabledBlockIds)).map(([name]) => <span key={name}>✓ {capabilityName(name)}</span>)}{runtimeBlocks.map((item) => <span key={item.id}>✓ {item.name}{item.id === "skills" && skills.length ? ` · ${skills.length}` : item.id === "mcp" && mcpServers.length ? ` · ${mcpServers.length}` : ""}</span>)}</div>{skills.length > 0 && <p className="runtime-detail">Skills：{skills.slice(0, 4).join("、")}</p>}{mcpServers.length > 0 && <p className="runtime-detail">MCP：{mcpServers.slice(0, 4).join("、")}</p>}</section>;
    return null;
  })}</aside>;
}

function FileBrowser({ files, query, selected, content, onQuery, onSelect, onReference, onClose }: { files: WorkspaceEntry[]; query: string; selected: string | null; content: string; onQuery(value: string): void; onSelect(path: string): void; onReference(path: string): void; onClose(): void }) {
  const filtered = files.filter((entry) => !entry.isDir && (!query || entry.path.toLowerCase().includes(query.toLowerCase()))).slice(0, 500);
  return <div className="workspace-overlay" role="dialog" aria-label="工作区文件"><section className="file-browser"><header><div><small>工作区</small><h2>浏览与引用文件</h2></div><button onClick={onClose}>×</button></header><div className="file-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="按路径搜索文件" /><em>{filtered.length} 个文件</em></div><div className="file-browser-grid"><nav>{filtered.map((entry) => <button key={entry.path} className={selected === entry.path ? "active" : ""} onClick={() => onSelect(entry.path)}><span>{fileIcon(entry.path)}</span><div><b>{entry.name}</b><small>{entry.path}</small></div><em>{formatBytes(entry.size)}</em></button>)}</nav><article>{selected ? <><header><code>@{selected}</code><button onClick={() => onReference(selected)}>引用到任务</button></header><pre>{content}</pre></> : <div className="file-empty"><span>▤</span><b>选择文件预览</b><p>文件内容只从当前授权工作区读取。</p></div>}</article></div></section></div>;
}

function TerminalDrawer({ cwd, command, output, running, exitCode, onCommand, onRun, onStop, onClear, onClose }: { cwd: string; command: string; output: string; running: boolean; exitCode: number | null; onCommand(value: string): void; onRun(): void; onStop(): void; onClear(): void; onClose(): void }) {
  return <div className="terminal-drawer" role="dialog" aria-label="集成终端"><header><div><span>&gt;_</span><b>集成终端</b><small>{cwd || "未选择工作区"}</small></div><nav><em className={running ? "running" : ""}>{running ? "运行中" : exitCode === null ? "就绪" : `退出 ${exitCode}`}</em><button onClick={onClear}>清空</button><button onClick={onClose}>×</button></nav></header><pre>{output || "昆仑增长终端已就绪。命令只在当前工作区执行。"}</pre><footer><span>❯</span><input autoFocus value={command} onChange={(event) => onCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onRun(); }} placeholder="输入命令，例如 npm test" disabled={running || !cwd} />{running ? <button className="terminal-stop" onClick={onStop}>停止</button> : <button onClick={onRun} disabled={!command.trim() || !cwd}>运行</button>}</footer></div>;
}

function DiffReview({ cwd, diff, onDiff }: { cwd: string; diff: string; onDiff(value: string): void }) {
  const files = useMemo(() => parseDiffFiles(diff), [diff]); const [selected, setSelected] = useState("全部");
  useEffect(() => { if (selected !== "全部" && !files.some((file) => file.path === selected)) setSelected("全部"); }, [files, selected]);
  const shown = selected === "全部" ? diff : files.find((file) => file.path === selected)?.content ?? diff;
  return <><header className="diff-header"><small>代码变更</small><button disabled={!cwd} onClick={() => void readGitDiff(cwd).then(onDiff)}>↻</button></header>{files.length > 0 && <select className="diff-select" value={selected} onChange={(event) => setSelected(event.target.value)}><option>全部</option>{files.map((file) => <option key={file.path}>{file.path}</option>)}</select>}{shown ? <pre>{shown}</pre> : <p>当前工作区没有未提交的代码差异。</p>}</>;
}

interface ProviderProps { engine: RuntimeEngine; baseUrl: string; model: string; protocol: ProviderProtocol; apiKey: string; saved: boolean; onEngine(value: RuntimeEngine): void; onBaseUrl(value: string): void; onModel(value: string): void; onProtocol(value: ProviderProtocol): void; onApiKey(value: string): void; onSave(): void }
function ProviderSettings(props: ProviderProps) { return <section className="settings-page"><header><small>设置</small><h1>模型与代理内核</h1><p>每个任务绑定一套代理内核；模型凭据仅保存在系统安全凭据库。</p></header><div className="settings-section"><h2>代理内核</h2><div className="engine-options">{(["codex", "deepseek-harness"] as RuntimeEngine[]).map((item) => <button key={item} className={props.engine === item ? "active" : ""} onClick={() => props.onEngine(item)}><span>{item === "codex" ? "⌘" : "深"}</span><div><b>{runtimeCatalog[item].label}</b><small>{item === "codex" ? "完整 App Server、Diff、审批与 Skills" : "插件化 Agent Loop、Code Mode 与子代理"}</small></div><i>{props.engine === item ? "✓" : ""}</i></button>)}</div></div><div className="settings-section"><h2>模型服务</h2><div className="form-grid"><label>协议<select value={props.protocol} onChange={(event) => props.onProtocol(event.target.value as ProviderProtocol)}><option value="openai">OpenAI</option><option value="azure-openai">Azure OpenAI</option><option value="openai-compatible">OpenAI-compatible / DeepSeek</option></select></label><label>模型 ID<input value={props.model} onChange={(event) => props.onModel(event.target.value)} placeholder={props.engine === "codex" ? "gpt-5.6-terra" : "deepseek-v4-flash"} /></label><label className="full">API Base URL<input value={props.baseUrl} onChange={(event) => props.onBaseUrl(event.target.value)} /></label><label className="full">API Key<input type="password" value={props.apiKey} onChange={(event) => props.onApiKey(event.target.value)} placeholder="安全保存，不写入项目配置" /></label></div><div className="settings-actions"><button className="primary" disabled={!props.baseUrl.startsWith("https://")} onClick={props.onSave}>{props.saved ? "已保存 ✓" : "保存配置"}</button></div></div></section>; }
function SecuritySettings() { return <section className="settings-page"><header><small>企业治理</small><h1>安全策略</h1><p>策略在桌面核心执行，网页界面无法绕过。</p></header><div className="policy-grid"><Policy title="命令执行" value="风险操作审批" detail="普通读取自动执行，写入、安装与系统命令需要批准。" /><Policy title="文件访问" value="仅当前工作区" detail="默认禁止访问项目目录之外的文件。" /><Policy title="网络访问" value="默认关闭" detail="按域名白名单为单次任务开放网络。" /><Policy title="凭据与审计" value="系统凭据库" detail="密钥不进入模型上下文，日志默认本地保存并脱敏。" /></div></section>; }
function BlocksSettings({ preferences, engine, onChange }: { preferences: BlockPreference[]; engine: RuntimeEngine; onChange(value: BlockPreference[]): void }) {
  const preferenceMap = new Map(preferences.map((item) => [item.id, item]));
  return <section className="settings-page blocks-page"><header><small>自由组合</small><h1>功能积木</h1><p>每一项能力都是独立积木。选择展示或隐藏并调整顺序，工作台会立即重组；带锁积木由安全边界或企业策略固定。</p></header><div className="block-toolbar"><div><b>{preferences.filter((item) => item.enabled).length}</b><span>已启用</span></div><div><b>{featureBlocks.length}</b><span>可用积木</span></div><button onClick={() => onChange(defaultBlockPreferences())}>恢复默认布局</button></div>{(["navigation", "inspector", "composer", "runtime"] as const).map((slot) => {
    const slotBlocks = featureBlocks.filter((block) => block.slot === slot).sort((a, b) => (preferenceMap.get(a.id)?.order ?? 0) - (preferenceMap.get(b.id)?.order ?? 0));
    return <section className="block-group" key={slot}><header><div><h2>{slotName(slot)}</h2><p>{slotDescription(slot)}</p></div></header><div className="block-grid">{slotBlocks.map((block, index) => { const preference = preferenceMap.get(block.id)!; const compatible = block.engines.includes(engine); return <article className={`${preference.enabled ? "enabled" : ""} ${compatible ? "" : "incompatible"}`} key={block.id}><span className="block-icon">{block.icon}</span><div><b>{block.name}</b><p>{block.description}</p><small>{compatible ? runtimeCatalog[engine].shortLabel : "当前内核不提供"}</small></div><div className="block-actions"><button disabled={index === 0} onClick={() => onChange(moveBlock(preferences, block.id, -1))}>↑</button><button disabled={index === slotBlocks.length - 1} onClick={() => onChange(moveBlock(preferences, block.id, 1))}>↓</button><label className="block-switch"><input type="checkbox" checked={preference.enabled} disabled={block.required} onChange={(event) => onChange(updateBlockPreference(preferences, block.id, { enabled: event.target.checked }))} /><span /></label></div>{block.required && <em className="block-lock">锁定</em>}</article>; })}</div></section>;
  })}</section>;
}
function Policy({ title, value, detail }: { title: string; value: string; detail: string }) { return <article className="policy"><span>◈</span><div><small>{title}</small><h2>{value}</h2><p>{detail}</p></div><em>可托管</em></article>; }
function nestedId(message: AppServerMessage, kind: "thread" | "session" | "turn"): string | null { const source = (message.result ?? message.params ?? message) as Record<string, unknown>; const nested = source[kind] as Record<string, unknown> | undefined; return typeof nested?.id === "string" ? nested.id : typeof source.sessionId === "string" ? source.sessionId : null; }
function compactPath(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
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
