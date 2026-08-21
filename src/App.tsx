import { useEffect, useMemo, useState } from "react";
import { defaultConfig, type ProviderProtocol } from "./domain/enterprise-config";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createAgentThread,
  getRuntimeStatus,
  loadProviderConfig,
  onAppServerNotification,
  onAppServerRequest,
  respondToApproval,
  saveProviderConfig,
  startAgentTurn,
  startRuntime,
  stopRuntime,
  type AppServerMessage,
  type RuntimeSnapshot,
} from "./runtime-client";

type View = "workspace" | "providers" | "security";
type ThemeMode = "system" | "light" | "dark";

const projects = [
  { name: "企业门户", path: "~/Code/enterprise-portal", branch: "main" },
  { name: "模型网关", path: "~/Code/ai-gateway", branch: "feat/audit" },
];

const activity = [
  { icon: "✓", title: "运行环境已就绪", detail: "Codex App Server 等待连接", tone: "success" },
  { icon: "⌘", title: "安全策略已加载", detail: "命令执行需要逐次审批", tone: "neutral" },
  { icon: "◇", title: "企业配置", detail: "本地开发模式 · 未托管", tone: "neutral" },
];

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [baseUrl, setBaseUrl] = useState(defaultConfig.provider.baseUrl);
  const [model, setModel] = useState(defaultConfig.provider.model);
  const [protocol, setProtocol] = useState<ProviderProtocol>(defaultConfig.provider.protocol);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>({ status: "stopped", pid: null, binary: "codex", lastError: null });
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("kunlun-theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });

  useEffect(() => {
    void getRuntimeStatus().then(setRuntime).catch((error: unknown) => {
      setRuntime({ status: "error", pid: null, binary: "codex", lastError: String(error) });
    });
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = theme;
      if (theme === "system") localStorage.removeItem("kunlun-theme");
      else localStorage.setItem("kunlun-theme", theme);
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    void loadProviderConfig().then((config) => {
      setBaseUrl(config.baseUrl);
      setModel(config.model);
      setProtocol(config.protocol);
    });
  }, []);

  const canSave = useMemo(
    () => baseUrl.startsWith("https://") && model.trim().length > 0,
    [baseUrl, model],
  );

  return (
    <main className="window-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic red" />
          <span className="traffic yellow" />
          <span className="traffic green" />
        </div>
        <div className="titlebar-name">昆仑增长</div>
        <div className="titlebar-actions">
          <label className="theme-control" title="界面主题">
            <span aria-hidden="true">◐</span>
            <select value={theme} onChange={(event) => setTheme(event.target.value as ThemeMode)} aria-label="界面主题">
              <option value="system">跟随系统</option>
              <option value="light">日间</option>
              <option value="dark">夜间</option>
            </select>
          </label>
          <button
            className={`runtime-pill ${runtime.status}`}
            title={runtime.lastError ?? `Runtime: ${runtime.binary}`}
            onClick={() => {
              const action = runtime.status === "ready" ? stopRuntime : startRuntime;
              setRuntime((current) => ({ ...current, status: "starting" }));
              void action().then(setRuntime).catch((error: unknown) => {
                setRuntime({ status: "error", pid: null, binary: runtime.binary, lastError: String(error) });
              });
            }}
          >
            <span /> Runtime {runtime.status}
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">昆</div>
            <div><strong>昆仑增长</strong><small>企业 AI 工作台</small></div>
          </div>

          <nav aria-label="主导航">
            <button className={view === "workspace" ? "active" : ""} onClick={() => setView("workspace")}>
              <span>⌘</span>工作台
            </button>
            <button className={view === "providers" ? "active" : ""} onClick={() => setView("providers")}>
              <span>⌁</span>模型服务
            </button>
            <button className={view === "security" ? "active" : ""} onClick={() => setView("security")}>
              <span>◈</span>安全策略
            </button>
          </nav>

          <section className="project-list">
            <div className="section-label">最近项目</div>
            {projects.map((project, index) => (
              <button className={index === 0 && view === "workspace" ? "project active-project" : "project"} key={project.name}>
                <span className="folder">▰</span>
                <span><strong>{project.name}</strong><small>{project.branch}</small></span>
              </button>
            ))}
          </section>

          <div className="sidebar-footer">
            <div className="avatar">本</div>
            <div><strong>本地开发者</strong><small>未连接企业账号</small></div>
          </div>
        </aside>

        {view === "workspace" && <Workspace runtime={runtime} model={model} onRuntime={setRuntime} />}
        {view === "providers" && (
          <ProviderSettings
            baseUrl={baseUrl}
            model={model}
            protocol={protocol}
            apiKey={apiKey}
            saved={saved}
            canSave={canSave}
            onBaseUrl={setBaseUrl}
            onModel={setModel}
            onProtocol={setProtocol}
            onApiKey={setApiKey}
            onSave={() => {
              void saveProviderConfig({ protocol, baseUrl, model, authMethod: "api-key", credentialRef: null }, apiKey)
                .then(() => {
                  setApiKey("");
                  setSaved(true);
                  window.setTimeout(() => setSaved(false), 2200);
                });
            }}
          />
        )}
        {view === "security" && <SecuritySettings />}
      </div>
    </main>
  );
}

function Workspace({ runtime, model, onRuntime }: { runtime: RuntimeSnapshot; model: string; onRuntime(value: RuntimeSnapshot): void }) {
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: "user" | "agent" | "system"; text: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<AppServerMessage | null>(null);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void onAppServerNotification((message) => {
      const method = message.method ?? "事件";
      const params = message.params ?? {};
      const text = extractAgentText(params) ?? `${method} · ${summarizeParams(params)}`;
      setMessages((current) => [...current, { role: "agent" as const, text }].slice(-100));
      if (method === "turn/completed") setBusy(false);
    }).then((unlisten) => cleanups.push(unlisten));
    void onAppServerRequest(setApproval).then((unlisten) => cleanups.push(unlisten));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  async function chooseProject(): Promise<void> {
    const selected = await open({ directory: true, multiple: false, title: "选择企业代码项目" });
    if (typeof selected === "string") {
      setCwd(selected);
      setThreadId(null);
      setMessages([{ role: "system", text: `已打开项目：${selected}` }]);
    }
  }

  async function sendTask(): Promise<void> {
    const text = prompt.trim();
    if (!text || !cwd || busy) return;
    setBusy(true);
    setPrompt("");
    setMessages((current) => [...current, { role: "user", text }]);
    try {
      let activeThread = threadId;
      if (runtime.status !== "ready") onRuntime(await startRuntime());
      if (!activeThread) {
        const created = await createAgentThread(cwd, model);
        activeThread = nestedId(created, "thread") ?? "";
        if (!activeThread) throw new Error("App Server 未返回 thread ID");
        setThreadId(activeThread);
      }
      await startAgentTurn(activeThread, cwd, text, model);
    } catch (error) {
      setMessages((current) => [...current, { role: "system", text: `任务启动失败：${String(error)}` }]);
      setBusy(false);
    }
  }

  return (
    <section className="content workspace-view">
      <div className="content-header">
        <div><span className="eyebrow">工作台</span><h1>准备开始构建</h1><p>选择项目，然后把开发任务交给昆仑增长。</p></div>
        <button className="primary-button" onClick={() => void chooseProject()}>＋ 打开项目</button>
      </div>

      <div className="hero-card">
        <div className="hero-glow" />
        <div className="hero-copy">
          <span className="status-dot"><i /> 本地安全运行</span>
          <h2>代码留在你的设备，<br />能力连接企业 AI。</h2>
          <p>统一管理模型接入、执行审批和企业开发规范。</p>
          <button className="primary-button large" onClick={() => void chooseProject()}>{cwd ? "更换项目" : "打开项目"} <span>→</span></button>
        </div>
        <div className="terminal-card">
          <div className="terminal-top"><span /><span /><span /><em>agent activity</em></div>
          <div className="terminal-body">
            <p><b>›</b> 分析当前项目结构</p>
            <p className="muted">  读取 42 个文件 · 1.8s</p>
            <p><b>›</b> 准备修改认证模块</p>
            <p className="approval">  ◇ 等待你的批准</p>
            <span className="cursor" />
          </div>
        </div>
      </div>

      {cwd && (
        <section className="panel agent-console">
          <div className="panel-heading"><div><span className="eyebrow">当前项目</span><h3>{cwd}</h3></div><span className="badge">{runtime.status}</span></div>
          <div className="message-list">
            {messages.length === 0 && <p className="empty-state">输入一个真实开发任务，昆仑增长会在工作区沙箱中执行。</p>}
            {messages.map((message, index) => <div className={`message ${message.role}`} key={`${index}-${message.text}`}>{message.text}</div>)}
          </div>
          <div className="task-composer">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：检查登录模块并修复现有测试失败" />
            <button className="primary-button" disabled={busy || !prompt.trim()} onClick={() => void sendTask()}>{busy ? "执行中…" : "发送任务"}</button>
          </div>
        </section>
      )}

      {approval?.id !== undefined && (
        <div className="approval-banner">
          <div><strong>需要你的批准</strong><small>{approval.method ?? "敏感操作"}</small></div>
          <button onClick={() => { void respondToApproval(approval.id!, "decline"); setApproval(null); }}>拒绝</button>
          <button className="primary-button" onClick={() => { void respondToApproval(approval.id!, "accept"); setApproval(null); }}>允许一次</button>
        </div>
      )}

      <div className="grid-two">
        <section className="panel">
          <div className="panel-heading"><div><span className="eyebrow">最近项目</span><h3>继续工作</h3></div><button className="text-button">查看全部</button></div>
          {projects.map((project) => (
            <button className="project-row" key={project.name}>
              <span className="project-icon">▰</span>
              <span><strong>{project.name}</strong><small>{project.path}</small></span>
              <em>{project.branch}</em><b>›</b>
            </button>
          ))}
        </section>

        <section className="panel">
          <div className="panel-heading"><div><span className="eyebrow">系统状态</span><h3>安全且就绪</h3></div></div>
          {activity.map((item) => (
            <div className="activity-row" key={item.title}>
              <span className={`activity-icon ${item.tone}`}>{item.icon}</span>
              <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}

interface ProviderSettingsProps {
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  canSave: boolean;
  saved: boolean;
  apiKey: string;
  onBaseUrl(value: string): void;
  onModel(value: string): void;
  onProtocol(value: ProviderProtocol): void;
  onApiKey(value: string): void;
  onSave(): void;
}

function ProviderSettings(props: ProviderSettingsProps) {
  return (
    <section className="content settings-view">
      <div className="content-header"><div><span className="eyebrow">配置</span><h1>模型服务</h1><p>连接 OpenAI、Azure OpenAI 或企业内部兼容网关。</p></div></div>
      <section className="settings-card">
        <div className="settings-title"><div className="settings-icon">⌁</div><div><h3>默认 Provider</h3><p>凭据将保存到系统安全凭据库，配置文件只保存引用。</p></div><span className="badge">本地配置</span></div>
        <div className="form-grid">
          <label>协议<select value={props.protocol} onChange={(event) => props.onProtocol(event.target.value as ProviderProtocol)}><option value="openai">OpenAI</option><option value="azure-openai">Azure OpenAI</option><option value="openai-compatible">OpenAI-compatible</option></select></label>
          <label>模型<input value={props.model} onChange={(event) => props.onModel(event.target.value)} placeholder="例如：企业允许的模型 ID" /></label>
          <label className="full">API Base URL<input value={props.baseUrl} onChange={(event) => props.onBaseUrl(event.target.value)} /><small>{props.baseUrl.startsWith("https://") ? "连接地址格式有效" : "生产环境仅允许 HTTPS"}</small></label>
          <label className="full">API Key<div className="secret-field"><input type="password" value={props.apiKey} onChange={(event) => props.onApiKey(event.target.value)} placeholder="存入系统安全凭据库，不会写入配置文件" /><button type="button" onClick={props.onSave}>安全保存</button></div></label>
        </div>
        <div className="settings-actions"><button className="secondary-button">测试连接</button><button disabled={!props.canSave} className="primary-button" onClick={props.onSave}>{props.saved ? "已保存 ✓" : "保存配置"}</button></div>
      </section>
    </section>
  );
}

function nestedId(message: AppServerMessage, kind: "thread" | "turn"): string | null {
  const source = (message.result ?? message) as Record<string, unknown>;
  const value = source[kind] as Record<string, unknown> | undefined;
  return typeof value?.id === "string" ? value.id : null;
}

function extractAgentText(params: Record<string, unknown>): string | null {
  const item = params.item as Record<string, unknown> | undefined;
  const content = item?.content as Array<Record<string, unknown>> | undefined;
  const text = content?.map((part) => part.text).filter((value): value is string => typeof value === "string").join("\n");
  return text || (typeof item?.text === "string" ? item.text : null);
}

function summarizeParams(params: Record<string, unknown>): string {
  const raw = JSON.stringify(params);
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

function SecuritySettings() {
  return (
    <section className="content settings-view">
      <div className="content-header"><div><span className="eyebrow">企业治理</span><h1>安全策略</h1><p>高风险操作在 Rust 后端强制执行，前端不能绕过。</p></div></div>
      <div className="policy-grid">
        <Policy title="命令执行" value="始终审批" detail="每条 shell 命令执行前均需用户确认。" />
        <Policy title="文件写入" value="仅工作区" detail="工作区外的写入始终阻止或单独审批。" />
        <Policy title="网络访问" value="域名白名单" detail="只允许访问管理员批准的目标。" />
        <Policy title="遥测" value="默认关闭" detail="不上传源码、提示词、Diff 或命令输出。" />
      </div>
    </section>
  );
}

function Policy({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <section className="policy-card"><span className="lock">◈</span><div><small>{title}</small><h3>{value}</h3><p>{detail}</p></div><span className="managed">可托管</span></section>;
}
