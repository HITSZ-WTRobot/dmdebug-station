import * as React from 'react';
import { useAtom } from 'jotai';
import { Activity, ArrowRight, Cable, Check, ChevronDown, CircleHelp, Download, Link2, LoaderCircle, Radio, RefreshCw, ShieldAlert, Square, Terminal, Unplug } from 'lucide-react';
import { connectionAtom, devicesAtom, selectedDeviceAtom, logsAtom, type ConnectionState, type DeviceSnapshot, type LogEntry, type PlatformInfo, type SerialPortInfo, type TransportMode } from './store/atoms';
import { DEVICES, DEVICE_MAP, BROADCAST, Opcode, OPCODE_NAMES, WHEEL_NAMES, hexId, resultName, type Response, type WheelState } from './lib/protocol';
import { TransportManager, getPlatformInfo, listNativeSerialPorts, isTauriEnvironment } from './lib/transport';
import { DeviceControls } from './components/DeviceControls';
import { TelemetryPanel } from './components/TelemetryPanel';
import { CommunicationRow } from './components/CommunicationRow';

function deviceStatus(device: DeviceSnapshot, now: number, sessionReady: boolean) {
  const state = device.state;
  if (!state) return { label: '等待反馈', tone: 'unknown' };
  if (!sessionReady || now - device.updatedAt > 600) return { label: '反馈已过期', tone: 'warning' };
  if (!state.flags.connected) return { label: '电机离线', tone: 'unknown' };
  if (state.flags.hostLinkTimeout) return { label: '通讯超时锁存', tone: 'danger' };
  if (state.flags.fault) return { label: '故障待处理', tone: 'danger' };
  if (state.flags.enablePending) return { label: '等待使能确认', tone: 'warning' };
  if (state.flags.busy) return { label: '运动中', tone: 'active' };
  if (state.flags.enabled) return { label: state.flags.motionComplete ? '已到位 · 使能中' : '已使能', tone: 'success' };
  if (state.type === 'motor-state' && !state.flags.zeroed) return { label: '等待建立零点', tone: 'warning' };
  return { label: '在线 · 已失能', tone: 'success' };
}
function numeric(value: number | null | undefined, decimals = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(decimals);
}
const PHASE_NAMES: Record<ConnectionState['phase'], string> = {
  disconnected: '未连接', opening: '正在打开端口', handshaking: '正在确认固件', ready: '固件通讯正常', unresponsive: '未收到完整应答', incompatible: '协议不兼容',
};

export function App() {
  const [connection, setConnection] = useAtom(connectionAtom);
  const [devices, setDevices] = useAtom(devicesAtom);
  const [selectedId, setSelectedId] = useAtom(selectedDeviceAtom);
  const [logs, setLogs] = useAtom(logsAtom);
  const [mode, setMode] = React.useState<TransportMode>(() => isTauriEnvironment() ? 'tauri' : 'web-serial');
  const [platform, setPlatform] = React.useState<PlatformInfo | null>(null);
  const [ports, setPorts] = React.useState<SerialPortInfo[]>([]);
  const [portName, setPortName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState({ tone: 'info', message: '尚未发送运动命令。先连接固件，再检查设备反馈。' });
  const [wheels, setWheels] = React.useState<Record<number, { state: WheelState; time: number }>>({});
  const [coordinateEpochs, setCoordinateEpochs] = React.useState<Record<number, number>>({});
  const [now, setNow] = React.useState(Date.now());
  const [filter, setFilter] = React.useState('all');
  const [pauseLogs, setPauseLogs] = React.useState(false);
  const [disconnectDialog, setDisconnectDialog] = React.useState(false);
  const logScroll = React.useRef<HTMLDivElement>(null);
  const engineRef = React.useRef<TransportManager | null>(null);
  const connectionRef = React.useRef(connection);
  connectionRef.current = connection;
  const logId = React.useRef(0);
  const disconnectCancel = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    let mounted = true;
    const engine = new TransportManager({
      onStatus: status => { if (mounted) setConnection(status); },
      onResponse: response => {
        if (!mounted) return;
        const receivedAt = Date.now();
        if (response.type === 'motor-state' || response.type === 'chassis-state') {
          setDevices(previous => ({ ...previous, [response.id]: { ...previous[response.id], state: response, updatedAt: receivedAt } }));
        } else if (response.type === 'dm-parameters' || response.type === 'dji-parameters' || response.type === 'chassis-parameters') {
          setDevices(previous => ({ ...previous, [response.id]: { ...previous[response.id], parameters: response, parametersAt: receivedAt } }));
        } else if (response.type === 'wheel-state') setWheels(previous => ({ ...previous, [response.id]: { state: response, time: receivedAt } }));
      },
      onLog: (level, message, rawHex) => {
        if (!mounted) return;
        const entry: LogEntry = { id: ++logId.current, time: Date.now(), level, message, rawHex };
        setLogs(previous => [...previous.slice(-499), entry]);
      },
    });
    engineRef.current = engine;
    getPlatformInfo().then(info => {
      if (!mounted) return; setPlatform(info);
      if (info.isTauri) listNativeSerialPorts().then(found => { if (mounted) { setPorts(found); setPortName(found[0]?.portName ?? ''); } }).catch(error => { if (mounted) setNotice({ tone: 'danger', message: String(error) }); });
    }).catch(error => { if (mounted) setNotice({ tone: 'danger', message: `平台检测失败：${error}` }); });
    const clock = window.setInterval(() => setNow(Date.now()), 250);
    return () => { mounted = false; clearInterval(clock); void engine.disconnect(); engineRef.current = null; };
  }, [setConnection, setDevices, setLogs]);

  React.useEffect(() => {
    const engine = engineRef.current; if (!engine) return;
    engine.selectDevice(selectedId);
    if (connectionRef.current.phase === 'ready') void engine.queryParameters(selectedId).catch(error => setNotice({ tone: 'danger', message: String(error) }));
  }, [selectedId]);
  React.useEffect(() => { if (!pauseLogs && logScroll.current) logScroll.current.scrollTop = logScroll.current.scrollHeight; }, [logs, pauseLogs]);
  React.useEffect(() => {
    if (!disconnectDialog) return;
    const previous = document.activeElement as HTMLElement | null;
    disconnectCancel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDisconnectDialog(false); if (event.key === 'Tab') { const buttons = document.querySelectorAll<HTMLButtonElement>('.disconnect-modal button'); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } };
    window.addEventListener('keydown', onKey); return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [disconnectDialog]);

  const selected = devices[selectedId];
  const definition = DEVICE_MAP.get(selectedId)!;
  const ready = connection.phase === 'ready';
  const fresh = ready && !!selected.state && now - selected.updatedAt <= 600;
  const selectedStatus = deviceStatus(selected, now, ready);
  const onlineMotorCount = ready ? DEVICES.reduce((count, d) => {
    const snapshot = devices[d.id], state = snapshot.state;
    if (!state || now - snapshot.updatedAt > 600) return count;
    if (state.type === 'chassis-state') return count + [1, 2, 4, 8].filter(bit => !!(state.onlineMask & bit)).length;
    return count + (state.flags.connected ? 1 : 0);
  }, 0) : 0;
  const phaseBusy = connection.phase === 'opening' || connection.phase === 'handshaking';
  const filteredLogs = logs.filter(log => filter === 'all' || (filter === 'issues' ? log.level === 'warn' || log.level === 'error' : log.level === filter));

  const connect = async () => {
    if (!engineRef.current) return;
    setBusy(true); setWheels({});
    setCoordinateEpochs(previous => Object.fromEntries(DEVICES.map(d => [d.id, (previous[d.id] ?? 0) + 1])));
    setDevices(previous => Object.fromEntries(Object.entries(previous).map(([id, d]) => [id, { ...d, state: null, parameters: null, updatedAt: 0, parametersAt: 0 }])));
    try { await engineRef.current.connect(mode, portName); setNotice({ tone: mode === 'demo' ? 'warning' : 'success', message: mode === 'demo' ? '正在使用协议演示数据，未连接真实电机。' : '握手成功。请逐台确认连接、零点和故障状态；不会自动使能。' }); }
    catch (error) { setNotice({ tone: 'danger', message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  const refresh = React.useCallback(async () => {
    if (!engineRef.current || !ready || busy) return;
    setBusy(true); try { await engineRef.current.refresh(); setNotice({ tone: 'info', message: '状态与当前设备参数已更新，未发送运动命令。' }); }
    catch (error) { setNotice({ tone: 'danger', message: String(error) }); } finally { setBusy(false); }
  }, [ready, busy]);
  const command = React.useCallback(async (opcode: number, id: number, values?: number[]) => {
    if (!engineRef.current) throw new Error('传输服务尚未初始化');
    setBusy(true);
    try {
      const replies = await engineRef.current.command(opcode, id, values);
      const rejected = replies.filter(r => r.result !== 0);
      if (rejected.length) throw new Error(rejected.map(r => `${DEVICE_MAP.get(r.id)?.name ?? hexId(r.id)}：${resultName(r.result)}`).join('；'));
      if (opcode === Opcode.SetZero) setCoordinateEpochs(previous => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
      setNotice({ tone: 'success', message: `${OPCODE_NAMES[opcode]}已受理，实际使能、运动和到位以新反馈为准。` }); return replies;
    } catch (error) { setNotice({ tone: 'danger', message: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { setBusy(false); }
  }, []);
  const restoreHandshake = async () => {
    setBusy(true); try { await engineRef.current?.handshake(); setNotice({ tone: 'warning', message: '已重新握手，不自动恢复使能或旧目标。故障设备仍需按要求重新设零/使能。' }); }
    catch (error) { setNotice({ tone: 'danger', message: String(error) }); } finally { setBusy(false); }
  };
  const exportLogs = () => {
    if (!logs.length) return;
    const blob = new Blob([logs.map(log => `${new Date(log.time).toISOString()}\t${log.level}\t${log.message}${log.rawHex ? `\n${log.rawHex}` : ''}`).join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'DMDebug-communication.log'; anchor.click(); URL.revokeObjectURL(url);
  };

  return <div className="workbench">
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Activity size={21} strokeWidth={1.6} /></span><div><strong>DMDebug Station</strong><span>三总线设备工作台</span></div><span className="version-tag mono">Protocol v2</span></div>
      <div className="header-actions"><span className="quiet-meta">9 个控制单元 / 12 台电机</span><button className="button danger" disabled={!ready || busy} onClick={() => { void command(Opcode.Disable, BROADCAST).catch(() => {}); }}><Square size={15} />全设备失能</button></div>
    </header>
    <section className="connection-bar" aria-label="连接与通讯状态">
      <div className="connection-settings">
        <div className="connection-field"><label htmlFor="transport-mode">传输方式</label><select id="transport-mode" value={mode} disabled={connection.portOpen || busy} onChange={event => setMode(event.target.value as TransportMode)}>
          {platform?.isTauri && <option value="tauri">桌面原生串口</option>}<option value="web-serial">浏览器串口</option><option value="demo">协议演示 · 无硬件</option>
        </select></div>
        {mode === 'tauri' ? <div className="connection-field port-field"><label htmlFor="serial-port">系统串口</label><div className="inline-field"><select id="serial-port" value={portName} disabled={phaseBusy || ready} onChange={event => setPortName(event.target.value)}>{!ports.length && <option value="">未检测到端口</option>}{ports.map(port => <option key={port.portName} value={port.portName}>{port.label}</option>)}</select><button className="button subtle small" title="重新枚举串口" aria-label="重新枚举串口" disabled={phaseBusy || ready} onClick={() => { void listNativeSerialPorts().then(found => { setPorts(found); if (!found.some(p => p.portName === portName)) setPortName(found[0]?.portName ?? ''); }).catch(error => setNotice({ tone: 'danger', message: String(error) })); }}><RefreshCw size={15} /></button></div></div>
          : <div className="port-hint"><Cable size={17} /><span>{mode === 'demo' ? '独立演示会话，不访问串口' : '连接时由浏览器选择授权端口'}</span></div>}
        <div className="serial-format mono">115200<span>8N1 · 无流控</span></div>
        {connection.portOpen ? <button className="button" disabled={busy} onClick={() => setDisconnectDialog(true)}><Unplug size={15} />断开</button> : <button className="button primary" disabled={busy || phaseBusy || mode === 'tauri' && !portName} onClick={() => { void connect(); }}>{phaseBusy ? <LoaderCircle size={15} className="busy-spin" /> : <Link2 size={15} />}{mode === 'demo' ? '启动演示' : '连接固件'}</button>}
      </div>
      <div className="connection-progress" aria-label="连接确认层级">
        <div className={`connection-step ${connection.portOpen ? 'confirmed' : ''}`}><span className="step-number">1</span><span>{connection.mode === 'demo' && connection.portOpen ? '演示通道' : '端口打开'}</span></div><ArrowRight size={13} />
        <div className={`connection-step ${ready ? 'confirmed' : ''}`}><span className="step-number">2</span><span>固件握手</span></div><ArrowRight size={13} />
        <div className={`connection-step ${ready && onlineMotorCount ? 'confirmed' : ''}`}><span className="step-number">3</span><span>{connection.mode === 'demo' && ready ? '演示反馈' : '电机反馈'} <b className="mono">{ready ? onlineMotorCount : '—'} / 12</b></span></div>
      </div>
    </section>
    <div className={`session-strip ${connection.phase === 'unresponsive' || connection.phase === 'incompatible' ? 'session-error' : ''}`} role="status">
      <span className={`status-dot ${ready ? 'success' : phaseBusy ? 'warning' : 'unknown'}`} /><strong>{connection.mode === 'demo' && ready ? '演示会话' : PHASE_NAMES[connection.phase]}</strong><span>{connection.message}</span>
      {connection.portOpen && (connection.phase === 'unresponsive' || connection.phase === 'ready') && <button className="text-button" disabled={busy} onClick={() => { void restoreHandshake(); }}>重新握手</button>}
      <div className="traffic mono"><span>TX {connection.txFrames}</span><span>RX {connection.rxFrames}</span><span className={connection.crcErrors ? 'text-danger' : ''}>CRC {connection.crcErrors}</span><span className={connection.timeouts ? 'text-warning' : ''}>超时 {connection.timeouts}</span></div>
    </div>
    {connection.mode === 'demo' && ready && <div className="demo-banner"><Radio size={16} /><strong>协议演示</strong>当前数值与曲线不是硬件反馈，也不代表真实S曲线、动力学或带载效果</div>}
    <div className="app-body">
      <aside className="device-sidebar" aria-label="按CAN总线选择设备">
        <div className="sidebar-heading"><span>设备列表</span><span className="mono">9 单元</span></div>
        {([1, 2, 3] as const).map(bus => <section className="bus-group" key={bus}><div className="bus-heading"><span className="mono">FDCAN{bus}</span><span>{bus === 1 ? '位置 / MIT' : bus === 2 ? '底盘 / 速度' : 'M2006 / 外部环'}</span></div>
          {DEVICES.filter(d => d.bus === bus).map(d => { const snapshot = devices[d.id], status = deviceStatus(snapshot, now, ready); const value = snapshot.state?.type === 'motor-state' ? snapshot.state.position : null;
            return <button key={d.id} className={`device-row ${selectedId === d.id ? 'selected' : ''}`} aria-current={selectedId === d.id ? 'true' : undefined} onClick={() => setSelectedId(d.id)}><div className="device-row-main"><span>{d.name}</span><span className="device-value mono">{d.kind === 'chassis' ? '4 轮' : `${numeric(value)} ${d.unit === 'deg' ? '°' : 'mm'}`}</span></div><div className="device-row-meta"><span className={`status-dot ${status.tone}`} /><span>{status.label}</span><span className="mono device-id">{hexId(d.id)}</span></div></button>;
          })}</section>)}
        <div className="sidebar-note"><ShieldAlert size={17} /><p>软件停止不是硬件急停<br />连接或重连不会自动使能</p></div>
      </aside>
      <main className="main-workspace">
        <div className="selection-heading"><div><div className="selection-meta"><span className="mono">FDCAN{definition.bus}</span><span>/</span><span className="mono">{hexId(definition.id)}</span><span>/</span><span>{definition.model}</span></div><h1>{definition.name}<span className={`state-label ${selectedStatus.tone}`}><span className={`status-dot ${selectedStatus.tone}`} />{selectedStatus.label}</span></h1><p>{definition.kind === 'linear' ? '相对软件零点的绝对毫米位置 · 226.2 mm / 输出轴圈' : definition.kind === 'joint' ? '相对软件零点 −180°～+180° · 保留S曲线规划' : definition.kind === 'm2006' ? '输出轴 0°～360° · 1 kHz速度 / 500 Hz位置 / 100 Hz前馈' : '车体系：x向前，y向左，逆时针为正 · 不提供整车位置导航'}</p></div><button className="button" disabled={!ready || busy} onClick={() => { void refresh(); }}><RefreshCw size={15} />刷新状态与参数</button></div>
        <div className={`notice action-notice ${notice.tone === 'danger' ? 'danger' : notice.tone === 'warning' ? 'warning' : notice.tone === 'success' ? 'success' : ''}`} aria-live="polite">{notice.tone === 'danger' ? <ShieldAlert size={16} /> : notice.tone === 'success' ? <Check size={16} /> : <CircleHelp size={16} />}<span>{notice.message}</span></div>
        <div className="workspace-grid"><div className="controls-column"><DeviceControls key={selectedId} device={selected} ready={ready} busy={busy} fresh={fresh} onCommand={command} onRefresh={refresh} /></div>
          <div className="telemetry-column"><TelemetryPanel definition={definition} state={selected.state} updatedAt={selected.updatedAt} demo={connection.mode === 'demo'} coordinateEpoch={coordinateEpochs[selectedId] ?? 0} />
            <section className="panel feedback-panel"><div className="panel-heading"><div><h2 className="panel-title">反馈核对</h2><p className="muted">不是发送成功就代表设备在线</p></div><span className="mono subtle-meta">{selected.updatedAt ? `${Math.max(0, now - selected.updatedAt)} ms前` : '尚无应答'}</span></div>
              {definition.kind === 'chassis' ? <div className="wheel-table"><div className="wheel-table-heading"><span>轮位 / 逻辑标签</span><span>连接状态</span><span>转速 rpm</span><span>电机状态</span></div>{WHEEL_NAMES.map((name, i) => { const wheel = wheels[0x41 + i], valid = ready && wheel && now - wheel.time < 900; return <div className="wheel-table-row" key={name}><span>{name}<small className="mono">{hexId(0x41 + i)}</small></span><span className={valid && wheel.state.connected ? 'text-success' : 'muted'}>{!wheel ? '等待查询' : !valid ? '反馈过期' : wheel.state.connected ? '在线' : '离线'}</span><span className="mono">{numeric(wheel?.state.velocityRpm)}</span><span>{!wheel ? '—' : wheel.state.motorState === 1 ? '已使能' : wheel.state.motorState === 0 ? '已失能' : `故障 ${wheel.state.motorState}`}</span></div>; })}</div>
                : <div className="feedback-grid"><div><span>通讯反馈</span><strong>{!selected.state ? '等待应答' : !fresh ? '反馈过期' : selected.state.flags.connected ? '设备在线' : '设备离线'}</strong></div><div><span>零点状态</span><strong>{!selected.state ? '—' : selected.state.flags.zeroed ? '已建立' : '待设零'}</strong></div><div><span>最近设备结果</span><strong>{selected.state ? resultName(selected.state.lastResult) : '—'}</strong></div><div><span>有效反馈帧</span><strong className="mono">{selected.state?.type === 'motor-state' ? selected.state.feedbackCount.toLocaleString() : '—'}</strong></div></div>}
            </section>
          </div>
        </div>
        <section className="panel log-panel"><div className="panel-heading"><div className="log-title"><Terminal size={16} /><h2 className="panel-title">通讯记录</h2><span className="mono subtle-meta">{logs.length} / 500</span></div><div className="actions"><select aria-label="筛选通讯记录" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部记录</option><option value="issues">仅异常</option><option value="tx">发送 TX</option><option value="rx">应答 RX</option></select><button className="button subtle small" aria-pressed={pauseLogs} onClick={() => setPauseLogs(!pauseLogs)}>{pauseLogs ? '继续滚动' : '暂停滚动'}</button><button className="button subtle small" disabled={!logs.length} onClick={exportLogs}><Download size={14} />导出</button><button className="button subtle small" onClick={() => setLogs([])}>清空</button></div></div>
          <div className="log-lines" ref={logScroll} tabIndex={0} aria-label="收发记录"><div>{filteredLogs.length === 0 ? <p className="log-empty">等待通讯记录。未连接时不会生成虚假收发或硬件在线状态。</p> : filteredLogs.map(log => <CommunicationRow key={log.id} entry={log} />)}</div></div>
        </section>
        <footer className="workspace-footer"><span>64 B 定长帧 · CRC-16/CCITT-FALSE · 单请求停等</span><span>500 ms失联门禁 · 软件保护不替代硬件急停</span></footer>
      </main>
    </div>
    {disconnectDialog && <div className="modal-backdrop" onClick={() => setDisconnectDialog(false)}><section className="modal disconnect-modal" role="dialog" aria-modal="true" aria-labelledby="disconnect-title" onClick={event => event.stopPropagation()}><div className="modal-heading"><ShieldAlert size={20} /><h2 id="disconnect-title">断开通讯不等于电机停止</h2></div><p>建议先发送“全设备失能”并核对新反馈，再隔离动力。失联门禁依赖主控与总线正常运行，不能作为硬件急停。</p><div className="modal-actions"><button ref={disconnectCancel} className="button" onClick={() => setDisconnectDialog(false)}>返回检查</button><button className="button danger" onClick={() => { setDisconnectDialog(false); void engineRef.current?.disconnect(); }}>仍然断开</button></div></section></div>}
  </div>;
}
