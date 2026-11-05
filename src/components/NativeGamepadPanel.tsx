import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Gamepad2, ShieldAlert, Square } from 'lucide-react';
import type { NativePadSnapshot } from '../lib/native-transport';
import { DEFAULT_DEADZONE, type GamepadBinding } from '../lib/gamepad';

const DEFAULT_BINDING: GamepadBinding = { leftX: 0, leftY: 1, rightX: 2, toggleButton: 0,
  invertLeftX: false, invertLeftY: false, invertRightX: false, deadzone: DEFAULT_DEADZONE };
const INITIAL: NativePadSnapshot = { supported: true, error: '', pads: [], selectedKey: '', binding: null,
  armed: false, neutral: false, released: false, target: { vx: 0, vy: 0, wz: 0 }, phase: 'off', message: '等待 Rust 原生手柄快照；不会自动选择手柄或应用绑定。' };
const PHASE_LABELS: Record<string, string> = { off: '遥控关闭', enabling: '等待底盘新反馈确认 · 尚不可运动', active: '底盘已确认使能', stopping: '正在请求全设备失能' };

export function NativeGamepadPanel({ visible }: { visible: boolean }) {
  const [snapshot, setSnapshot] = React.useState(INITIAL);
  const [selection, setSelection] = React.useState('');
  const [draft, setDraft] = React.useState<GamepadBinding>(DEFAULT_BINDING);
  const [confirmed, setConfirmed] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const mounted = React.useRef(false);
  const visibleRef = React.useRef(visible);
  const epoch = React.useRef(0);
  visibleRef.current = visible;

  React.useEffect(() => {
    mounted.current = true;
    let active = true, inFlight = false, revision = 0;
    let unlisten: UnlistenFn | undefined;
    // 轮询和事件都只更新显示；采样、许可、速度与超时全部由 Rust 线程负责。
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const startedAt = revision;
      try {
        const next = await invoke<NativePadSnapshot>('native_gamepad_snapshot');
        if (active && revision === startedAt) { setSnapshot(next); setError(''); }
      } catch (failure) { if (active) setError(String(failure)); }
      finally { inFlight = false; }
    };
    void listen<NativePadSnapshot>('native-gamepad', event => {
      if (active) { revision++; setSnapshot(event.payload); }
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); }).catch(failure => { if (active) setError(String(failure)); });
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 100);
    return () => {
      active = false; mounted.current = false; epoch.current++;
      clearInterval(timer); unlisten?.();
      void invoke('native_gamepad_context', { visible: false, focused: false }).catch(() => {});
      void invoke('native_gamepad_stop').catch(() => {});
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    const context = () => {
      const shown = visible && document.visibilityState === 'visible';
      const focused = document.hasFocus();
      if (!shown || !focused) { epoch.current++; setConfirmed(false); setPending(false); }
      // 这里只传递页面意图；真正窗口焦点另由 Tauri on_window_event 门禁。
      void invoke('native_gamepad_context', { visible: shown, focused }).catch(failure => { if (active) setError(String(failure)); });
      if (!shown || !focused) void invoke('native_gamepad_stop').catch(failure => { if (active) setError(String(failure)); });
    };
    context();
    window.addEventListener('focus', context); window.addEventListener('blur', context);
    document.addEventListener('visibilitychange', context);
    return () => {
      active = false; epoch.current++;
      window.removeEventListener('focus', context); window.removeEventListener('blur', context);
      document.removeEventListener('visibilitychange', context);
    };
  }, [visible]);

  const stop = async () => {
    const operation = ++epoch.current;
    setConfirmed(false); setPending(true); setError('');
    try { await invoke('native_gamepad_stop'); }
    catch (failure) { if (mounted.current && operation === epoch.current) setError(String(failure)); }
    finally { if (mounted.current && operation === epoch.current) setPending(false); }
  };
  const editDraft = (patch: Partial<GamepadBinding>) => {
    setDraft(previous => ({ ...previous, ...patch }));
    void stop();
  };
  const selected = snapshot.pads.find(pad => pad.key === selection && pad.connected);
  const applyBinding = async () => {
    if (!selected || !visibleRef.current || !document.hasFocus() || document.visibilityState !== 'visible') return;
    const binding = { ...draft }, deviceKey = selected.key;
    const indices = [binding.leftX, binding.leftY, binding.rightX, binding.toggleButton];
    if (indices.some(index => !Number.isInteger(index) || index < 0) || !Number.isFinite(binding.deadzone) || binding.deadzone < 0 || binding.deadzone > 0.4) {
      setError('编号须为非负整数，死区须为 0～0.40；缺失的轴或按钮由 Rust 拒绝绑定。'); return;
    }
    const operation = ++epoch.current;
    setConfirmed(false); setPending(true); setError('');
    try {
      await invoke('native_gamepad_stop');
      // 离页、失焦、换选择或修改草稿后，迟到的 stop 回调不得继续应用配置。
      if (!mounted.current || operation !== epoch.current || !visibleRef.current || !document.hasFocus() || document.visibilityState !== 'visible') return;
      await invoke('native_gamepad_configure', { deviceKey, binding });
      if (mounted.current && operation === epoch.current && visibleRef.current) setConfirmed(true);
    } catch (failure) { if (mounted.current && operation === epoch.current) setError(String(failure)); }
    finally { if (mounted.current && operation === epoch.current) setPending(false); }
  };
  const applied = confirmed && snapshot.selectedKey === selection && snapshot.binding !== null &&
    (Object.keys(draft) as (keyof GamepadBinding)[]).every(key => snapshot.binding![key] === draft[key]);
  const movingAllowed = snapshot.armed && snapshot.phase === 'active';
  const stopping = pending || snapshot.phase === 'stopping';

  return <main className="gamepad-page" hidden={!visible}>
    <div className="selection-heading"><div><div className="selection-meta"><span className="mono">USB GAMEPAD → RUST / GILRS → SPP COM → FDCAN2</span></div><h1><Gamepad2 size={25} />手柄遥控</h1><p>车体系 x 向前 / y 向左 / wz 逆时针为正；Rust 原生采集，网页只显示状态和传递操作意图。</p></div><button className="button danger" onClick={() => { void stop(); }}><ShieldAlert size={16} />紧急退出 / 全体失能</button></div>
    <div className="notice warning"><strong>软件停止不是硬件急停。</strong> 全设备失能覆盖九个控制单元，竖直机构可能下落；软件、蓝牙和总线故障时不能保证物理停止。请准备硬件急停。切页、失焦、隐藏、断柄或输入超时都会退出；恢复不会自动使能。停止请求已排队不等于失能已确认，请查看 Rust 状态。</div>
    {(!snapshot.supported || snapshot.error) && <div className="notice danger" role="alert">{snapshot.error || '此环境无法初始化原生手柄采集；不会生成演示手柄。'}</div>}
    <div className="gamepad-layout">
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">01 / 识别与绑定</h2><p>默认编号只是草稿，必须观察原生原始值并手动确认</p></div><span className="mono subtle-meta">当前会话 · 不持久保存</span></div>
        <div className="gamepad-content"><div className="field"><label htmlFor="native-gamepad-device">明确选择 USB 手柄</label><select id="native-gamepad-device" value={selection} disabled={pending || !snapshot.supported} onChange={event => { setSelection(event.target.value); void stop(); }}><option value="">未选择 · 不会自动连接手柄</option>{snapshot.pads.map(pad => <option key={pad.key} value={pad.key} disabled={!pad.connected}>#{pad.index} · {pad.id}</option>)}</select></div>
          {!snapshot.pads.length && <p className="muted">尚未发现原生手柄。连接设备并操作轴或按钮后观察；发现不会自动选择或使能。</p>}
          <div className="gamepad-bindings">
            {([{ key: 'leftY', invert: 'invertLeftY', title: '前后 / left Y', hint: '默认负向 → vx 正（前进）' }, { key: 'leftX', invert: 'invertLeftX', title: '左右 / left X', hint: '默认正向 → vy 负（右移）' }, { key: 'rightX', invert: 'invertRightX', title: '旋转 / right X', hint: '默认正向 → wz 负（顺时针）' }] as const).map(axis => <div className="gamepad-binding" key={axis.key}><div className="field"><label htmlFor={`native-gamepad-${axis.key}`}>{axis.title} · 原生轴编号</label><input id={`native-gamepad-${axis.key}`} type="number" min="0" step="1" value={Number.isFinite(draft[axis.key]) ? draft[axis.key] : ''} disabled={pending} onChange={event => editDraft({ [axis.key]: event.target.valueAsNumber })} /><small>{axis.hint}</small></div><label className="gamepad-checkbox"><input type="checkbox" checked={draft[axis.invert]} disabled={pending} onChange={event => editDraft({ [axis.invert]: event.target.checked })} />反向</label></div>)}
            <div className="field"><label htmlFor="native-gamepad-toggle">总开关 · 原生按钮编号</label><input id="native-gamepad-toggle" type="number" min="0" step="1" value={Number.isFinite(draft.toggleButton) ? draft.toggleButton : ''} disabled={pending} onChange={event => editDraft({ toggleButton: event.target.valueAsNumber })} /></div>
            <div className="field"><label htmlFor="native-gamepad-deadzone">中心死区 · 0～0.40</label><input id="native-gamepad-deadzone" type="number" min="0" max="0.4" step="0.01" value={Number.isFinite(draft.deadzone) ? draft.deadzone : ''} disabled={pending} onChange={event => editDraft({ deadzone: event.target.valueAsNumber })} /></div>
          </div><p className="muted">编号是 Rust 按真实 gilrs 物理 Code 排序后的索引，不等于浏览器 Gamepad API 编号。未观察到的轴或按钮不会补零伪造；新增能力或重新插入后须重新选择和确认。平移径向限幅与旋转比例全部由 Rust 计算。</p>
          <div className="actions"><button className="button primary" disabled={!selected || stopping || !snapshot.supported || !visible} onClick={() => { void applyBinding(); }}>停止并应用绑定</button><span className={applied ? 'text-success' : 'muted'}>{applied ? '已应用 · 仍需回中 / 释放 / 新按下' : '未应用绑定'}</span></div>
        </div>
      </section>
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">02 / 遥控许可与目标</h2><p>首次按键只使能底盘 0x40；第二次按键全设备失能</p></div><span className={`state-label ${movingAllowed ? 'success' : 'warning'}`}><span className={`status-dot ${movingAllowed ? 'success' : 'warning'}`} />{PHASE_LABELS[snapshot.phase] ?? snapshot.phase}</span></div>
        <div className="gamepad-content"><div className="gamepad-limits mono"><span>平移 ≤ 1 m/s</span><span>旋转 ≤ 10 deg/s</span><span>轮速 ≤ 160 rpm</span></div>
          <div className="gamepad-checks"><span>绑定：{applied ? '已确认' : '未确认'}</span><span>许可：{snapshot.armed ? '已开启' : '已关闭'}</span><span>三轴：{snapshot.neutral ? '回中' : '未回中 / 无有效输入'}</span><span>按钮：{snapshot.released ? '已观察释放' : '等待释放'}</span></div>
          <div className="readout-grid gamepad-targets">{(['vx', 'vy', 'wz'] as const).map(key => <div className="readout" key={key}><span>{key} · {key === 'wz' ? 'deg/s' : 'm/s'}</span><strong className="mono">{Number.isFinite(snapshot.target[key]) ? snapshot.target[key].toFixed(3) : '—'}</strong><small>Rust 最新目标，非实际运动反馈</small></div>)}</div>
          <p className="gamepad-status" role="status">{snapshot.message}</p><p className="muted">原生阶段：{snapshot.phase}。按钮不必持续按住；摇杆回中只发零速，不失能。无失能应答不能宣称已停。</p>
          <button className="button danger" onClick={() => { void stop(); }}><Square size={14} />关闭遥控 / 全设备失能</button>
          {error && <div className="notice danger" role="alert">{error}</div>}
        </div>
      </section>
      <section className="panel gamepad-raw"><div className="panel-heading"><div><h2 className="panel-title">03 / 原始输入观察</h2><p>真实物理 Code 与原生索引；逐个操作，不从外观猜编号</p></div><span className="mono subtle-meta">RUST / GILRS RAW</span></div><div className="gamepad-content">{snapshot.pads.length ? snapshot.pads.map(pad => <article className={`gamepad-device ${pad.key === selection ? 'selected' : ''}`} key={pad.key}>
        <div className="gamepad-device-heading"><strong>#{pad.index} · {pad.id} · {pad.connected ? '已连接' : '已断开'}</strong><span className="mono">mapping: {pad.mapping || '原生 / 非标准'} · timestamp: {pad.timestamp.toFixed(1)} ms</span></div>
        <div className="gamepad-axis-values">{pad.axes.map((value, index) => <div className="gamepad-axis" key={index}><span className="mono" title={`gilrs Code ${pad.axisCodes?.[index] ?? '—'}`}>Axis {index} · {pad.axisCodes?.[index] ?? '—'}</span><meter min="-1" max="1" value={value} aria-label={`原生手柄 ${pad.index} 轴 ${index}`} /><output className="mono">{value.toFixed(3)}</output></div>)}</div>
        <div className="gamepad-button-values">{pad.buttons.map((button, index) => <div className={button.pressed ? 'pressed' : ''} key={index}><span className="mono">B{index}</span><output className="mono">{button.value.toFixed(3)}</output><small>Code {pad.buttonCodes?.[index] ?? '—'} · {button.pressed ? '按下' : '释放'}</small></div>)}</div>
      </article>) : <div className="empty-state">等待原生手柄输入 · 无演示输入</div>}</div></section>
    </div>
  </main>;
}
