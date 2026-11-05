import * as React from 'react';
import { Gamepad2, ShieldAlert, Square } from 'lucide-react';
import { isTauriEnvironment, type TransportManager } from '../lib/transport';
import { NativeGamepadPanel } from './NativeGamepadPanel';
import { BROADCAST, DEVICE_MAP, Opcode, hexId, resultName, type BodyVelocity, type Response } from '../lib/protocol';
import { DEFAULT_DEADZONE, GAMEPAD_LIMITS, bindingError, gamepadIdentity, readGamepadInput, resetToggle, stepToggle, type GamepadBinding, type GamepadSample } from '../lib/gamepad';

interface Props { transport: TransportManager | null; visible: boolean }
interface PadView extends GamepadSample { key: string; timestamp: number }
const ZERO: BodyVelocity = { vx: 0, vy: 0, wz: 0 };
const DEFAULT_BINDING: GamepadBinding = { leftX: 0, leftY: 1, rightX: 2, toggleButton: 0, invertLeftX: false, invertLeftY: false, invertRightX: false, deadzone: DEFAULT_DEADZONE };
const PHASE_LABELS = { off: '遥控关闭', enabling: '等待底盘新反馈确认 · 尚不可运动', active: '底盘已确认使能', stopping: '正在请求全设备失能' };
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function rejectedReplies(replies: Response[]) {
  return replies.filter(reply => reply.result !== 0).map(reply => `${DEVICE_MAP.get(reply.id)?.name ?? hexId(reply.id)}：${resultName(reply.result)}`).join('；');
}

export function GamepadPanel(props: Props) {
  return isTauriEnvironment() ? <NativeGamepadPanel visible={props.visible} /> : <BrowserGamepadPanel {...props} />;
}

function BrowserGamepadPanel({ transport, visible }: Props) {
  const [supported, setSupported] = React.useState(true);
  const [pads, setPads] = React.useState<PadView[]>([]);
  const [selection, setSelection] = React.useState('');
  const [draft, setDraft] = React.useState<GamepadBinding>(DEFAULT_BINDING);
  const [applied, setApplied] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [message, setMessage] = React.useState('先在串口工作台连接蓝牙 SPP 对应的 COM 端口，再明确选择手柄并应用绑定。');
  const [error, setError] = React.useState('');
  const [stopReplies, setStopReplies] = React.useState<Response[]>([]);
  const [telemetry, setTelemetry] = React.useState({ phase: 'off' as 'off' | 'enabling' | 'active' | 'stopping', transportMessage: '', armed: false, neutral: false, released: false, target: ZERO });
  const selectionRef = React.useRef('');
  const bindingRef = React.useRef<GamepadBinding | null>(null);
  const gate = React.useRef(resetToggle());
  const visibleRef = React.useRef(visible);
  const previousVisible = React.useRef(visible);
  const focused = React.useRef(true);
  const stopPending = React.useRef<Promise<boolean> | null>(null);
  const epoch = React.useRef(0);
  const mounted = React.useRef(true);
  visibleRef.current = visible;

  const stop = React.useCallback((reason: string, forceAll = false): Promise<boolean> => {
    // 先撤销本地许可和边沿，再等待串口；旧异步回调不能恢复本地许可。
    ++epoch.current;
    gate.current = resetToggle(selectionRef.current || null);
    if (mounted.current) {
      setMessage(reason);
      setTelemetry(previous => ({ ...previous, armed: false, target: ZERO }));
    }
    if (stopPending.current) return stopPending.current;
    if (!transport) return Promise.resolve(true);
    if (mounted.current) { setStopping(true); setStopReplies([]); }
    const request = forceAll && transport.getGamepadState().phase === 'off'
      ? transport.command(Opcode.Disable, BROADCAST)
      : transport.stopGamepadControl(reason);
    const pending = request.then(replies => {
      if (mounted.current) setStopReplies(replies);
      const rejected = rejectedReplies(replies);
      if (rejected) throw new Error(`全设备失能存在拒绝：${rejected}`);
      return true;
    }).catch(cause => {
      if (mounted.current) setError(`停止请求未完整成功：${errorText(cause)}。请核对反馈并使用硬件急停；不能确认物理停止。`);
      return false;
    }).finally(() => {
      stopPending.current = null;
      if (mounted.current) setStopping(false);
    });
    stopPending.current = pending;
    return pending;
  }, [transport]);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  React.useEffect(() => {
    if (!visible && previousVisible.current) void stop('已离开手柄遥控页，遥控关闭；已请求全设备失能。');
    else if (visible) gate.current = resetToggle(selectionRef.current || null);
    previousVisible.current = visible;
  }, [visible, stop]);

  React.useEffect(() => {
    const available = typeof navigator.getGamepads === 'function';
    setSupported(available);
    focused.current = document.hasFocus() && !document.hidden;
    const generations = new Map<number, number>();
    let frame = 0, lastFrame = 0, lastPaint = 0;
    let lastInvalid = '';
    let lastPhase = transport?.getGamepadState().phase ?? 'off';
    const clearBinding = (reason: string) => {
      bindingRef.current = null;
      selectionRef.current = '';
      setSelection(''); setApplied(false);
      void stop(reason);
    };
    const connectionChanged = (event: GamepadEvent) => {
      generations.set(event.gamepad.index, (generations.get(event.gamepad.index) ?? 0) + 1);
      if (selectionRef.current) {
        const selectedIndex = JSON.parse(selectionRef.current)[0] as number;
        if (selectedIndex === event.gamepad.index) clearBinding('手柄连接身份已变化，绑定已清除；请重新选择并应用绑定。');
      }
    };
    const loseFocus = () => {
      focused.current = false;
      if (visibleRef.current || gate.current.armed) void stop(document.hidden ? '页面已隐藏，遥控关闭；已请求全设备失能。' : '窗口已失焦，遥控关闭；已请求全设备失能。');
      else gate.current = resetToggle(selectionRef.current || null);
    };
    const gainFocus = () => { focused.current = !document.hidden && document.hasFocus(); gate.current = resetToggle(selectionRef.current || null); };
    const visibilityChanged = () => { if (document.hidden) loseFocus(); else gainFocus(); };
    const poll = (time: number) => {
      frame = requestAnimationFrame(poll);
      let current: PadView[] = [];
      if (available) {
        try {
          current = Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => !!pad && pad.connected).map(pad => ({
            key: gamepadIdentity(pad, generations.get(pad.index) ?? 0), id: pad.id, index: pad.index, mapping: pad.mapping,
            connected: pad.connected, timestamp: pad.timestamp, axes: Array.from(pad.axes), buttons: pad.buttons.map(button => ({ value: button.value, pressed: button.pressed })),
          }));
        } catch (cause) {
          if (lastInvalid !== 'api') { lastInvalid = 'api'; setError(`Gamepad API 读取失败：${errorText(cause)}`); clearBinding('无法读取手柄，遥控关闭；已请求全设备失能。'); }
        }
      }
      const state = transport?.getGamepadState() ?? { phase: 'off' as const, message: '传输服务未初始化' };
      if (gate.current.armed && lastFrame && time - lastFrame > 250) void stop('手柄输入超过 250 ms 未更新，遥控关闭；不会回放旧速度。');
      lastFrame = time;
      // 顶栏失能、串口断开或调度超时都撤销本地 toggle，不自动重新使能。
      if (gate.current.armed && (state.phase === 'stopping' || (state.phase === 'off' && lastPhase !== 'off'))) {
        ++epoch.current;
        gate.current = resetToggle(selectionRef.current || null);
        setMessage('传输层已退出遥控；需回中、释放按钮后重新按下，绝不自动恢复。');
      }
      lastPhase = state.phase;
      const selected = current.find(pad => pad.key === selectionRef.current);
      if (selectionRef.current && !selected) clearBinding('手柄断开或身份变化，绑定已清除；已请求全设备失能。');
      let target = ZERO, neutral = false;
      if (selected && bindingRef.current) {
        const input = readGamepadInput(selected, bindingRef.current);
        if (!input.valid) {
          if (lastInvalid !== input.reason) { lastInvalid = input.reason; setError(input.reason); bindingRef.current = null; setApplied(false); void stop(`${input.reason}，遥控关闭。`); }
        } else if (visibleRef.current && focused.current && !document.hidden && !stopPending.current) {
          lastInvalid = '';
          neutral = input.neutral;
          target = input.target;
          const next = stepToggle(gate.current, { identity: selected.key, valid: true, neutral: input.neutral, pressed: input.pressed });
          gate.current = next.state;
          if (next.action === 'stop' || next.action === 'invalidated') void stop('总开关关闭，已请求全设备失能。');
          else if (next.action === 'start') {
            if (!transport) { gate.current = resetToggle(selected.key); setError('传输服务未初始化，未使能。'); }
            else {
              const startedAt = ++epoch.current;
              setError(''); setStopReplies([]); setMessage('仅请求使能底盘 0x40；等待真实新反馈确认，其余电机不会自动使能。');
              void transport.startGamepadControl().then(replies => {
                if (startedAt !== epoch.current) return;
                const rejected = rejectedReplies(replies);
                if (rejected) throw new Error(rejected);
              }).catch(cause => {
                if (startedAt !== epoch.current) return;
                setError(`开启失败：${errorText(cause)}`);
                void stop('开启失败，本地遥控已关闭；已请求全设备失能。');
              });
            }
          }
          // 更新的是调度器单槽目标，不在组件内发串口包或建立发送定时器。
          if (gate.current.armed && transport && (state.phase === 'enabling' || state.phase === 'active')) {
            try { transport.updateGamepadControl(input.target); }
            catch (cause) { setError(`目标更新失败：${errorText(cause)}`); void stop('目标更新失败，本地遥控已关闭；已请求全设备失能。'); }
          }
        }
      }
      if (time - lastPaint >= 100) {
        lastPaint = time;
        setPads(current);
        setTelemetry({ phase: state.phase, transportMessage: state.message, armed: gate.current.armed, neutral, released: gate.current.released, target: gate.current.armed && state.phase === 'active' ? target : ZERO });
      }
    };
    frame = requestAnimationFrame(poll);
    window.addEventListener('gamepadconnected', connectionChanged);
    window.addEventListener('gamepaddisconnected', connectionChanged);
    window.addEventListener('blur', loseFocus);
    window.addEventListener('focus', gainFocus);
    window.addEventListener('pagehide', loseFocus);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('gamepadconnected', connectionChanged);
      window.removeEventListener('gamepaddisconnected', connectionChanged);
      window.removeEventListener('blur', loseFocus);
      window.removeEventListener('focus', gainFocus);
      window.removeEventListener('pagehide', loseFocus);
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (gate.current.armed) void stop('手柄输入监听已退出，已请求全设备失能。');
    };
  }, [transport, stop]);

  const selected = pads.find(pad => pad.key === selection);
  const movingAllowed = telemetry.phase === 'active' && telemetry.armed && !stopping;
  const editDraft = (patch: Partial<GamepadBinding>) => {
    bindingRef.current = null; setApplied(false);
    void stop('绑定草稿已修改，遥控关闭；必须重新应用绑定。');
    setDraft(previous => ({ ...previous, ...patch }));
  };
  const choosePad = async (key: string) => {
    bindingRef.current = null; setApplied(false);
    const pending = stop('正在修改手柄选择，先请求全设备失能。');
    const selectionEpoch = epoch.current;
    const stopped = await pending;
    if (selectionEpoch !== epoch.current) return;
    selectionRef.current = key; setSelection(key); gate.current = resetToggle(key || null);
    if (stopped) { setError(''); setMessage('手柄已选择。观察原始输入后填写编号，并明确应用绑定；不会自动使能。'); }
  };
  const applyBinding = async () => {
    bindingRef.current = null; setApplied(false);
    if (!selected) { setError('请先明确选择已连接的手柄。'); return; }
    const invalid = bindingError(draft, selected);
    if (invalid) { setError(invalid); return; }
    const key = selected.key;
    const pending = stop('应用绑定前先请求全设备失能。');
    const bindingEpoch = epoch.current;
    if (!await pending || bindingEpoch !== epoch.current) return;
    if (selectionRef.current !== key || !visibleRef.current || !focused.current) return;
    bindingRef.current = { ...draft };
    gate.current = resetToggle(key);
    setApplied(true); setError('');
    setMessage('绑定已应用。先让三轴回中并释放总开关，再重新按下开启；长按不会重复切换。');
  };
  return <main className="gamepad-page" hidden={!visible}>
    <div className="selection-heading"><div><div className="selection-meta"><span className="mono">USB GAMEPAD → SPP COM → USART1 → FDCAN2</span></div><h1><Gamepad2 size={25} />手柄遥控</h1><p>车体系 x 向前 / y 向左 / wz 逆时针为正；左杆平移、右杆旋转。普通 Gamepad API 可用即可使用，不依赖 standard mapping。</p></div><button className="button danger" onClick={() => { void stop('操作员紧急退出，遥控关闭；已请求全设备失能。', true); }}><ShieldAlert size={16} />紧急退出 / 全体失能</button></div>
    <div className="notice warning"><strong>软件停止不是硬件急停。</strong> 全设备失能覆盖九个控制单元，竖直机构可能下落；软件、蓝牙和总线故障时不能保证物理停止。请先隔离危险区域并准备硬件急停。切页、失焦、隐藏、断柄或输入超时都会退出；恢复不会自动使能。</div>
    {!supported && <div className="notice danger" role="alert">此运行环境未提供 navigator.getGamepads。请使用支持 Gamepad API 的 Tauri WebView / 浏览器；网页环境可能要求安全上下文与用户操作。本页不会生成演示手柄或自动控制。</div>}
    <div className="gamepad-layout">
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">01 / 识别与绑定</h2><p>默认编号只是草稿，必须观察原始值并手动确认</p></div><span className="mono subtle-meta">当前会话 · 不持久保存</span></div>
        <div className="gamepad-content"><div className="field"><label htmlFor="gamepad-device">明确选择 USB 手柄</label><select id="gamepad-device" value={selection} disabled={stopping || !supported} onChange={event => { void choosePad(event.target.value); }}><option value="">未选择 · 不会自动连接手柄</option>{pads.map(pad => <option key={pad.key} value={pad.key}>#{pad.index} · {pad.id}</option>)}</select></div>
          {!pads.length && <p className="muted">尚未发现手柄。连接 USB 后按一下手柄按钮以允许系统暴露设备；发现设备不会自动选择或使能。</p>}
          <div className="gamepad-bindings">
            {([{ key: 'leftY', invert: 'invertLeftY', title: '前后 / left Y', hint: '默认负向 → vx 正（前进）' }, { key: 'leftX', invert: 'invertLeftX', title: '左右 / left X', hint: '默认正向 → vy 负（右移）' }, { key: 'rightX', invert: 'invertRightX', title: '旋转 / right X', hint: '默认正向 → wz 负（顺时针）' }] as const).map(axis => <div className="gamepad-binding" key={axis.key}><div className="field"><label htmlFor={`gamepad-${axis.key}`}>{axis.title} · 轴编号</label><input id={`gamepad-${axis.key}`} type="number" min="0" step="1" value={Number.isFinite(draft[axis.key]) ? draft[axis.key] : ''} disabled={stopping} onChange={event => editDraft({ [axis.key]: event.target.valueAsNumber })} /><small>{axis.hint}</small></div><label className="gamepad-checkbox"><input type="checkbox" checked={draft[axis.invert]} disabled={stopping} onChange={event => editDraft({ [axis.invert]: event.target.checked })} />反向</label></div>)}
            <div className="field"><label htmlFor="gamepad-toggle">总开关 · 按钮编号（toggle）</label><input id="gamepad-toggle" type="number" min="0" step="1" value={Number.isFinite(draft.toggleButton) ? draft.toggleButton : ''} disabled={stopping} onChange={event => editDraft({ toggleButton: event.target.valueAsNumber })} /></div>
            <div className="field"><label htmlFor="gamepad-deadzone">中心死区 · 0～0.40</label><input id="gamepad-deadzone" type="number" min="0" max="0.4" step="0.01" value={Number.isFinite(draft.deadzone) ? draft.deadzone : ''} disabled={stopping} onChange={event => editDraft({ deadzone: event.target.valueAsNumber })} /></div>
          </div><p className="muted">平移采用径向死区，死区外按幅度线性重映射并保持方向，斜推合成限幅；旋转同样按幅度缩放。只有推到底才到最高速。扳机不假定为按钮或轴，请以原始值为准。</p>
          <div className="actions"><button className="button primary" disabled={!selected || stopping || !supported || !transport} onClick={() => { void applyBinding(); }}>停止并应用绑定</button><span className={applied ? 'text-success' : 'muted'}>{applied ? '已应用 · 仍需回中 / 释放 / 新按下' : '未应用绑定'}</span></div>
        </div>
      </section>
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">02 / 遥控许可与目标</h2><p>首次按键只使能底盘 0x40；第二次按键全设备失能</p></div><span className={`state-label ${movingAllowed ? 'success' : 'warning'}`}><span className={`status-dot ${movingAllowed ? 'success' : 'warning'}`} />{movingAllowed ? '真实反馈已确认 · 遥控开启' : stopping ? '停止请求中 · 本地已关闭' : telemetry.armed ? PHASE_LABELS[telemetry.phase] : '本地遥控关闭'}</span></div>
        <div className="gamepad-content"><div className="gamepad-limits mono"><span>平移 ≤ {GAMEPAD_LIMITS.translation} m/s</span><span>旋转 ≤ {GAMEPAD_LIMITS.rotation} deg/s</span><span>轮速 ≤ {GAMEPAD_LIMITS.wheelRpm} rpm</span></div>
          <div className="gamepad-checks"><span>绑定：{applied ? '已确认' : '未确认'}</span><span>三轴：{telemetry.neutral ? '回中' : '未回中 / 无有效输入'}</span><span>按钮：{telemetry.released ? '已观察释放' : '等待释放'}</span></div>
          <div className="readout-grid gamepad-targets">{(['vx', 'vy', 'wz'] as const).map(key => <div className="readout" key={key}><span>{key} · {key === 'wz' ? 'deg/s' : 'm/s'}</span><strong className="mono">{telemetry.target[key].toFixed(3)}</strong><small>最新输入目标，非实际运动反馈</small></div>)}</div>
          <p className="gamepad-status" role="status">{message}</p><p className="muted">传输层：{PHASE_LABELS[telemetry.phase]} · {telemetry.transportMessage || '等待状态'}。按钮不必持续按住；摇杆回中只发零速，不失能。</p>
          <button className="button danger" onClick={() => { void stop('操作员关闭遥控，已请求全设备失能。', true); }}><Square size={14} />关闭遥控 / 全设备失能</button>
          {error && <div className="notice danger" role="alert">{error}</div>}
          {!!stopReplies.length && <div className="gamepad-stop-results"><h3>最近失能应答（{stopReplies.length} / 9）</h3>{stopReplies.map(reply => <div key={reply.id} className={reply.result === 0 ? '' : 'text-danger'}><span>{hexId(reply.id)} · {DEVICE_MAP.get(reply.id)?.name ?? '未知设备'}</span><strong>{resultName(reply.result)}</strong></div>)}<p className="muted">应答不等于物理停止，仍需核对新状态及现场设备。</p></div>}
        </div>
      </section>
      <section className="panel gamepad-raw"><div className="panel-heading"><div><h2 className="panel-title">03 / 原始输入观察</h2><p>所有设备只读展示；请逐个拨动摇杆、按键，不能从外观猜轴号</p></div><span className="mono subtle-meta">Gamepad API / RAW</span></div><div className="gamepad-content">{pads.length ? pads.map(pad => <article className={`gamepad-device ${pad.key === selection ? 'selected' : ''}`} key={pad.key}><div className="gamepad-device-heading"><strong>#{pad.index} · {pad.id}</strong><span className="mono">mapping: {pad.mapping || '（空 / 非标准）'} · timestamp: {pad.timestamp.toFixed(1)} ms</span></div><div className="gamepad-axis-values">{pad.axes.map((value, index) => <div className="gamepad-axis" key={index}><span className="mono">Axis {index}</span><meter min="-1" max="1" value={Number.isFinite(value) ? value : 0} aria-label={`手柄 ${pad.index} 轴 ${index}`} /><output className="mono">{Number.isFinite(value) ? value.toFixed(4) : String(value)}</output></div>)}</div><div className="gamepad-button-values">{pad.buttons.map((button, index) => <div key={index} className={button.pressed ? 'pressed' : ''}><span className="mono">B{index}</span><output className="mono">{Number.isFinite(button.value) ? button.value.toFixed(3) : String(button.value)}</output><small>{button.pressed ? '按下' : '释放'}</small></div>)}</div></article>) : <div className="empty-state">未发现真实手柄 · 无演示输入</div>}</div></section>
    </div>
  </main>;
}
