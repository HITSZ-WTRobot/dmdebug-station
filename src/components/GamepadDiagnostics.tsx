import * as React from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Copy, Download, Gamepad2, Pause, Play, ShieldCheck } from 'lucide-react';

export interface DiagnosticDevice {
  key: string;
  index: number;
  name: string;
  uuid: string;
  vendorId: number | null;
  productId: number | null;
  mapping: string;
  connected: boolean;
  axes: { code: number; name: string; value: number }[];
  buttons: { code: number; name: string; value: number; pressed: boolean }[];
}

export interface DiagnosticEvent {
  sequence: number;
  timeMs: number;
  deviceKey: string;
  index: number | null;
  kind: string;
  code: number | null;
  name: string;
  value: number | null;
  stage: string;
  detail: string;
}

export interface DiagnosticSnapshot {
  supported: boolean;
  running: boolean;
  paused: boolean;
  error: string;
  logPath: string;
  stage: string;
  sequence: number;
  devices: DiagnosticDevice[];
  events: DiagnosticEvent[];
}

const STAGES = [
  { label: '普通模式逐项测试', action: '标记：普通模式', instruction: '逐个拨动左右摇杆，操作十字键、1～4、肩键、Select / Start，再按下摇杆。一次只操作一项。' },
  { label: '准备按Analog', action: '标记：准备按Analog', instruction: '先点标记，再按手柄上的物理 Analog 键。观察 LED，把颜色、亮灭等现象写入下方备注。' },
  { label: 'Analog后重复测试', action: '标记：Analog后重复测试', instruction: '再次逐项操作相同的杆、十字键和按钮，对比原始 Code、数值、连接及 mapping 事件。' },
  { label: '准备按Select', action: '标记：准备按Select', instruction: '单独测试 Select：先点标记，再按物理 Select，观察事件和 LED。不要同时按其他键。' },
  { label: 'Select后重复测试', action: '标记：Select后重复测试', instruction: '标记后重复相同输入；如有 LED 变化或没有任何上报，也用自定义标记记录。' },
];

const rawCode = (code: number) => `${code} / 0x${code.toString(16).toUpperCase()}`;
const usbId = (value: number | null) => value === null ? '未提供' : `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
const rawValue = (value: number | null) => value === null ? '—' : String(value);

function DeviceCard({ device }: { device: DiagnosticDevice }) {
  return <article className={`panel readonly-device${device.connected ? '' : ' readonly-disconnected'}`}>
    <div className="panel-heading">
      <div><h3 className="panel-title">#{device.index} · {device.name || '未命名设备'}</h3><p className="mono">{device.key}</p></div>
      <span className={`readonly-state ${device.connected ? 'text-success' : 'text-warning'}`}><span className={`status-dot ${device.connected ? 'success' : 'warning'}`} />{device.connected ? '已连接' : '已断开 · 保留最后快照'}</span>
    </div>
    <div className="readonly-content">
      <dl className="readonly-identity">
        <div><dt>VID / PID</dt><dd className="mono">{usbId(device.vendorId)} / {usbId(device.productId)}</dd></div>
        <div><dt>UUID</dt><dd className="mono">{device.uuid || '未提供'}</dd></div>
        <div><dt>Mapping</dt><dd className="mono">{device.mapping || '未提供'}</dd></div>
      </dl>
      <div className="readonly-raw-heading"><h4>原始轴</h4><span>{device.axes.length} 个已观察 Code</span></div>
      {device.axes.length === 0 ? <p className="readonly-hint">尚未观察到轴数据；请逐个拨杆或操作十字键，不会补零生成轴。</p> :
        <div className="readonly-axes">{[...device.axes].sort((a, b) => a.code - b.code).map(axis => <div className="readonly-axis" key={axis.code}>
          <div><strong>{axis.name || '未命名轴'}</strong><code>Code {rawCode(axis.code)}</code></div>
          <meter min={-1} max={1} value={Math.max(-1, Math.min(1, axis.value))} aria-label={`${axis.name || '轴'}，Code ${axis.code}`} />
          <output className="mono">{rawValue(axis.value)}</output>
        </div>)}</div>}
      <div className="readonly-raw-heading"><h4>原始按钮</h4><span>{device.buttons.length} 个已观察 Code</span></div>
      {device.buttons.length === 0 ? <p className="readonly-hint">尚未观察到按钮数据；Unknown 名称也会原样显示。</p> :
        <div className="readonly-buttons">{[...device.buttons].sort((a, b) => a.code - b.code).map(button => <div className={`readonly-button${button.pressed ? ' is-pressed' : ''}`} key={button.code}>
          <div><span className={`status-dot ${button.pressed ? 'success' : ''}`} /><strong>{button.name || '未命名按钮'}</strong><span>{button.pressed ? '按下' : '释放'}</span></div>
          <code>Code {rawCode(button.code)}</code><output className="mono">value {rawValue(button.value)}</output>
        </div>)}</div>}
      <p className="readonly-hint">名称为输入 API 报告值，不是物理键位结论。条形仅显示 −1～1 范围，右侧保留原始值；未做死区、反向或控制映射。</p>
    </div>
  </article>;
}

export function GamepadDiagnostics() {
  const [desktop] = React.useState(() => isTauri());
  const [snapshot, setSnapshot] = React.useState<DiagnosticSnapshot | null>(null);
  const [pollError, setPollError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [feedback, setFeedback] = React.useState('');
  const [customStage, setCustomStage] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const busy = React.useRef(false);
  const mounted = React.useRef(false);

  React.useEffect(() => {
    mounted.current = true;
    let active = true;
    let inFlight = false;
    // 仅轮询显示；Rust 独立采集和保存日志，不依赖网页定时器或窗口刷新。
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const next = await invoke<DiagnosticSnapshot>('diagnostic_snapshot');
        if (active) { setSnapshot(next); setPollError(''); }
      } catch (failure) {
        if (active) setPollError(failure instanceof Error ? failure.message : String(failure));
      } finally { inFlight = false; }
    };
    if (desktop) void poll();
    const timer = desktop ? window.setInterval(() => { void poll(); }, 100) : undefined;
    return () => {
      active = false;
      mounted.current = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [desktop]);

  const perform = async (operation: () => Promise<unknown>, message: string) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true); setActionError(''); setFeedback('');
    try {
      await operation();
      if (mounted.current) setFeedback(message);
      return true;
    } catch (failure) {
      if (mounted.current) setActionError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const submitStage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = customStage.trim();
    if (label && await perform(() => invoke('diagnostic_mark', { label }), `已写入阶段标记：${label}`) && mounted.current) setCustomStage('');
  };
  const events = React.useMemo(() => [...(snapshot?.events ?? [])].sort((a, b) => b.sequence - a.sequence).slice(0, 200), [snapshot?.events]);
  const downloadEvents = () => {
    // 只导出当前收到的事件窗口，不冒充完整 JSONL 或硬件测试结果。
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), scope: 'current-events-only', logPath: snapshot?.logPath ?? '', stage: snapshot?.stage ?? '', events: [...events].reverse() }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gamepad-current-events-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback(`已请求下载当前 ${events.length} 条事件；完整记录请查看自动保存路径。`);
  };
  const canRecord = desktop && snapshot !== null && snapshot.supported && snapshot.running && !snapshot.error && !pollError;
  const connectedCount = snapshot?.devices.filter(device => device.connected).length ?? 0;
  const status = !desktop ? '仅桌面可用' : pollError ? '状态不可用' : !snapshot ? '等待 Rust 快照' : snapshot.error ? '诊断异常' : !snapshot.supported ? '输入 API 不可用' : !snapshot.running ? '采集未运行' : snapshot.paused ? '记录已暂停 · 快照继续' : '只读采集中 · 自动记录';

  return <div className="readonly-diagnostics">
    <header className="readonly-banner">
      <ShieldCheck size={24} aria-hidden="true" />
      <div><strong>只读：不会打开串口，不发送电机命令</strong><span>先退出其他遥控软件并隔离机器人动力；其他程序可能同时响应同一手柄。这里仅观察 USB 输入并保存本地日志，不启动遥控、不修改映射、不连接 Ozone。</span></div>
      <span className="readonly-badge">READ ONLY</span>
    </header>
    <main className="readonly-page">
      <div className="selection-heading readonly-title">
        <div><div className="eyebrow mono">USB INPUT / RUST · GILRS / RAW EVENT LOG</div><h1><Gamepad2 size={26} aria-hidden="true" />USB 手柄输入诊断</h1><p>亲自逐个拨杆、按键，对比 Analog / Select 前后的真实输入；界面不生成模拟数据。</p></div>
        <div className="readonly-summary"><strong>{status}</strong><span>连接设备 {connectedCount} · 显示轮询 100 ms</span><span>Rust 采集 / 日志独立运行</span></div>
      </div>

      {!desktop && <div className="notice warning" role="status"><strong>原生诊断仅在桌面独立程序可用。</strong> 请打开 GamepadInputCheck.exe；浏览器不会读取浏览器 Gamepad API，也不会自动启动演示。</div>}
      {pollError && <div className="notice danger" role="alert">无法取得诊断快照：{pollError}。下方若有数据，为最后一次收到的快照；不能据此确认当前采集与保存状态。</div>}
      {snapshot && (!snapshot.supported || snapshot.error) && <div className="notice danger" role="alert">{snapshot.error || '当前环境不支持原生 USB 手柄输入。'} 不会生成演示手柄；存在日志错误时不能确认记录完整保存。</div>}
      {actionError && <div className="notice danger" role="alert">操作未完成：{actionError}</div>}

      <section className="panel readonly-session" aria-labelledby="diagnostic-session-title">
        <div className="panel-heading"><div><h2 id="diagnostic-session-title" className="panel-title">会话记录</h2><p>暂停只停止输入事件记录，设备最新快照继续更新；阶段标记只写日志，不发送任何硬件命令。</p></div>
          <button className="button" disabled={!canRecord || pending} onClick={() => { void perform(() => invoke('diagnostic_pause', { paused: !snapshot!.paused }), snapshot!.paused ? '已请求继续记录。' : '已请求暂停记录；设备快照仍会更新。'); }}>{snapshot?.paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}{snapshot?.paused ? '继续记录' : '暂停记录'}</button>
        </div>
        <div className="readonly-content">
          <div className="readonly-current-stage"><span>当前阶段</span><strong>{snapshot?.stage || '尚无阶段标记'}</strong><span className="mono">sequence {snapshot?.sequence ?? '—'}</span></div>
          <div className="readonly-log-path"><label htmlFor="diagnostic-log-path">完整 JSONL 自动保存路径 · 不受当前表格 200 条上限影响</label>
            <div><input id="diagnostic-log-path" className="mono" readOnly value={snapshot?.logPath ?? ''} placeholder={desktop ? '等待 Rust 创建日志文件…' : '仅桌面程序创建日志'} />
              <button className="button" disabled={!snapshot?.logPath || pending} onClick={() => { void perform(() => navigator.clipboard.writeText(snapshot!.logPath), '已复制完整日志路径。'); }}><Copy size={15} aria-hidden="true" />复制路径</button></div>
            <p className={`readonly-hint${snapshot?.error ? ' text-danger' : ''}`}>{snapshot?.error ? '日志 / 采集存在异常，请查看上方错误；不能确认完整保存。' : pollError ? '快照获取失败，当前保存状态未知。' : !snapshot?.running || !snapshot?.logPath ? '尚未确认日志保存，请等待真实路径和运行状态。' : snapshot.paused ? '输入事件记录已暂停；完整日志仍在上述文件，继续记录前的未记录输入不会补写。' : 'Rust 正在按事件写入 JSONL；关闭窗口前可复制路径，便于随后分析。'}</p>
          </div>
          <div className="readonly-feedback" role="status" aria-live="polite">{feedback || '标记和记录操作的结果将在此显示。'}</div>
        </div>
      </section>

      <div className="readonly-layout">
        <section className="panel readonly-stages" aria-labelledby="diagnostic-stages-title">
          <div className="panel-heading"><div><h2 id="diagnostic-stages-title" className="panel-title">01 / 逐项测试与阶段标记</h2><p>每次先标记，再操作物理按键；步骤由你手动切换。</p></div></div>
          <div className="readonly-content">
            <ol className="readonly-step-list">{STAGES.map((step, index) => <li key={step.label}>
              <span className="readonly-step-number mono">{String(index + 1).padStart(2, '0')}</span>
              <div><button className="button" disabled={!canRecord || pending} onClick={() => { void perform(() => invoke('diagnostic_mark', { label: step.label }), `已写入阶段标记：${step.label}`); }}>{step.action}</button><p>{step.instruction}</p></div>
            </li>)}</ol>
            <div className="notice warning">Analog 不一定改变 USB 模式，Select 也可能不单独上报。请根据真实日志比较，不根据键名、LED 或 mapping 名称直接判定模式。</div>
            <form className="readonly-mark-form" onSubmit={event => { void submitStage(event); }}>
              <label htmlFor="diagnostic-custom-stage">自定义标记 / LED 与操作备注</label>
              <input id="diagnostic-custom-stage" value={customStage} onChange={event => setCustomStage(event.target.value)} placeholder="例如：按 Analog 后红灯亮；Select 无可见事件" disabled={!canRecord || pending} />
              <button className="button primary" type="submit" disabled={!canRecord || pending || !customStage.trim()}>写入自定义标记</button>
            </form>
            <p className="readonly-hint">Windows 原生输入可能依赖窗口焦点：测试时请手动点回本窗口。焦点变化由 Rust 记录；程序不会强制抢占其他窗口。</p>
          </div>
        </section>

        <section className="readonly-devices" aria-labelledby="diagnostic-devices-title">
          <div className="readonly-section-heading"><h2 id="diagnostic-devices-title">02 / 设备与原始输入</h2><span>真实 Code · 不隐藏 Unknown</span></div>
          {!snapshot?.devices.length ? <div className="panel readonly-waiting"><Gamepad2 size={32} aria-hidden="true" /><strong>{!desktop ? '等待桌面原生诊断' : !snapshot ? '等待原生输入快照' : !snapshot.supported ? '原生输入不可用' : '等待连接 USB 手柄'}</strong><p>连接后逐个操作杆和按钮，设备与真实上报值会出现在这里。不会生成占位设备或假数据。</p></div> : snapshot.devices.map(device => <DeviceCard device={device} key={device.key} />)}
        </section>
      </div>

      <section className="panel readonly-events" aria-labelledby="diagnostic-events-title">
        <div className="panel-heading"><div><h2 id="diagnostic-events-title" className="panel-title">03 / 原始事件与连接变化</h2><p>最新在前 · 当前 {events.length} 条 / 最多 200 条 · 包含设备、阶段、焦点与错误事件；完整会话见 JSONL。</p></div>
          <button className="button" disabled={!events.length} onClick={downloadEvents}><Download size={15} aria-hidden="true" />下载当前事件 JSON</button>
        </div>
        <div className="readonly-table-scroll" tabIndex={0} role="region" aria-label="原始事件表，可横向和纵向滚动">
          <table className="readonly-event-table"><thead><tr><th scope="col">序号 / 时间 ms</th><th scope="col">设备</th><th scope="col">事件</th><th scope="col">Code / 名称</th><th scope="col">原始值</th><th scope="col">阶段 / 详情</th></tr></thead>
            <tbody>{events.length === 0 ? <tr><td colSpan={6} className="readonly-table-empty">尚无真实事件。连接手柄或写入阶段标记后观察；这里不会显示模拟输入。</td></tr> : events.map(event => <tr key={event.sequence}>
              <td className="mono">#{event.sequence}<small>{event.timeMs}</small></td>
              <td>{event.index === null ? '会话 / 窗口' : `#${event.index}`}<small className="mono">{event.deviceKey || '—'}</small></td>
              <td className="mono">{event.kind}</td>
              <td><code>{event.code === null ? '—' : rawCode(event.code)}</code><small>{event.name || '—'}</small></td>
              <td className="mono">{rawValue(event.value)}</td>
              <td><strong>{event.stage || '未标记阶段'}</strong><small>{event.detail || '—'}</small></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      <footer className="readonly-footer">只读输入诊断 · 物理操作由你完成，前端只显示 Rust 快照和提交日志标记。当前事件下载不是完整会话日志。</footer>
    </main>
  </div>;
}
