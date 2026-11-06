import * as React from 'react';
import { Gamepad2, ShieldAlert } from 'lucide-react';
import { isTauriEnvironment, type TransportManager } from '../lib/transport';
import { NativeGamepadPanel } from './NativeGamepadPanel';
import { BROADCAST, DEVICE_MAP, Opcode, hexId, resultName, type BodyVelocity, type Response } from '../lib/protocol';
import { GAMEPAD_LIMITS, gamepadIdentity, readGamepadInput, resetToggle, stepToggle, type GamepadSample } from '../lib/gamepad';

interface Props { transport: TransportManager | null; visible: boolean }
interface PadView extends GamepadSample { key: string; timestamp: number }
const ZERO: BodyVelocity = { vx: 0, vy: 0, wz: 0 };
const PHASE_LABELS = { off: '遥控关闭', enabling: '等待底盘新反馈确认 · 尚不可运动', active: '底盘已确认使能', stopping: '正在请求全设备失能' };
const CHANNELS = [{ key: 'vx', label: '前后', direction: '前进 + / 后退 −', limit: GAMEPAD_LIMITS.translation, unit: 'm/s' },
  { key: 'vy', label: '左右', direction: '左移 + / 右移 −', limit: GAMEPAD_LIMITS.translation, unit: 'm/s' },
  { key: 'wz', label: '旋转', direction: '逆时针 + / 顺时针 −', limit: GAMEPAD_LIMITS.rotation, unit: 'deg/s' }] as const;
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
  const [stopping, setStopping] = React.useState(false);
  const [message, setMessage] = React.useState('请选择手柄以预览输入；连接串口后，回中、释放 Start，再重新按下开启。');
  const [error, setError] = React.useState('');
  const [stopReplies, setStopReplies] = React.useState<Response[]>([]);
  const [telemetry, setTelemetry] = React.useState({ phase: 'off' as 'off' | 'enabling' | 'active' | 'stopping', transportMessage: '', armed: false, neutral: false, released: false, startPressed: false, inputValid: false, inputTarget: ZERO, target: ZERO });
  const selectionRef = React.useRef('');
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
    const clearSelection = (reason: string) => {
      selectionRef.current = '';
      setSelection('');
      void stop(reason);
    };
    const connectionChanged = (event: GamepadEvent) => {
      generations.set(event.gamepad.index, (generations.get(event.gamepad.index) ?? 0) + 1);
      if (selectionRef.current) {
        const selectedIndex = JSON.parse(selectionRef.current)[0] as number;
        if (selectedIndex === event.gamepad.index) clearSelection('手柄连接身份已变化，请重新选择；已请求全设备失能。');
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
          if (lastInvalid !== 'api') { lastInvalid = 'api'; setError(`Gamepad API 读取失败：${errorText(cause)}`); clearSelection('无法读取手柄，遥控关闭；已请求全设备失能。'); }
        }
      }
      const state = transport?.getGamepadState() ?? { phase: 'off' as const, message: '传输服务未初始化' };
      if (selectionRef.current && lastFrame && time - lastFrame > 250) void stop('手柄输入超过 250 ms 未更新，遥控关闭；不会回放旧速度。');
      lastFrame = time;
      // 顶栏失能、串口断开或调度超时都撤销本地 toggle，不自动重新使能。
      if (gate.current.armed && (state.phase === 'stopping' || (state.phase === 'off' && lastPhase !== 'off'))) {
        ++epoch.current;
        gate.current = resetToggle(selectionRef.current || null);
        setMessage('传输层已退出遥控；需回中、释放按钮后重新按下，绝不自动恢复。');
      }
      lastPhase = state.phase;
      const selected = current.find(pad => pad.key === selectionRef.current);
      if (selectionRef.current && !selected) clearSelection('手柄断开或身份变化，请重新选择；已请求全设备失能。');
      let target = ZERO, neutral = false, inputValid = false;
      if (selected) {
        const input = readGamepadInput(selected);
        if (!input.valid) {
          if (lastInvalid !== input.reason) { lastInvalid = input.reason; setError(input.reason); void stop(`${input.reason}，遥控关闭。`); }
        } else {
          target = input.target;
          neutral = input.neutral;
          inputValid = true;
          lastInvalid = '';
          if (visibleRef.current && focused.current && !document.hidden && !stopPending.current) {
            const next = stepToggle(gate.current, { identity: selected.key, valid: true, neutral: input.neutral, pressed: input.pressed, nowMs: time });
            gate.current = next.state;
            if (next.action === 'stop' || next.action === 'invalidated') void stop('Start 关闭遥控，已请求全设备失能。');
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
      }
      if (time - lastPaint >= 100) {
        lastPaint = time;
        setPads(current);
        setTelemetry({ phase: state.phase, transportMessage: state.message, armed: gate.current.armed, neutral, released: gate.current.released, startPressed: gate.current.pressed, inputValid, inputTarget: target, target: gate.current.armed && state.phase === 'active' ? target : ZERO });
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
  const choosePad = async (key: string) => {
    const pending = stop('正在修改手柄选择，先请求全设备失能。');
    const selectionEpoch = epoch.current;
    const stopped = await pending;
    if (selectionEpoch !== epoch.current) return;
    selectionRef.current = key; setSelection(key); gate.current = resetToggle(key || null);
    if (stopped) { setError(''); setMessage('手柄已选择，仅预览输入；回中并稳定释放 Start 后，重新按下开启。'); }
  };
  return <main className="gamepad-page" hidden={!visible}>
    <div className="selection-heading"><div><div className="selection-meta"><span className="mono">USB GAMEPAD → BROWSER GAMEPAD API → SPP COM → FDCAN2</span></div><h1><Gamepad2 size={25} />手柄遥控</h1><p>浏览器固定布局：左杆前后 / 左右、右杆 X 旋转、Start 切换。不是 WinMM；右杆 Y 不参与控制或回中判断。</p></div><button className="button danger" onClick={() => { void stop('操作员关闭遥控，已请求全设备失能。', true); }}><ShieldAlert size={16} />关闭遥控 / 全设备失能</button></div>
    <div className="notice warning"><strong>软件停止不是硬件急停。</strong> 全设备失能覆盖九个控制单元，竖直机构可能下落；请准备硬件急停。切页、失焦、隐藏、断柄或输入超时都会撤销许可，恢复不会自动使能。停止请求不等于物理停止。</div>
    {!supported && <div className="notice danger" role="alert">此浏览器未提供 navigator.getGamepads；可能需要安全上下文和用户操作。本页不生成演示手柄，也不能调用 Windows WinMM。</div>}
    <div className="gamepad-layout">
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">01 / 设备与实时输入</h2><p>输入预览无需串口连接，不代表已发送或实际运动</p></div><span className="mono subtle-meta">GAMEPAD API</span></div>
        <div className="gamepad-content"><div className="field"><label htmlFor="gamepad-device">USB 手柄</label><select id="gamepad-device" value={selection} disabled={stopping || !supported} onChange={event => { void choosePad(event.target.value); }}><option value="">未选择 · 不会自动使能</option>{pads.map(pad => <option key={pad.key} value={pad.key}>#{pad.index} · {pad.id}</option>)}</select></div>
          {!pads.length && <p className="muted">尚未发现手柄。连接 USB 后按一下按钮，允许浏览器暴露设备，再选择手柄。</p>}
          <div className="gamepad-inputs">{CHANNELS.map(channel => <div className="gamepad-input" key={channel.key}><div><strong>{channel.label}</strong><small>{channel.direction}</small></div><meter min={-channel.limit} max={channel.limit} value={telemetry.inputTarget[channel.key]} aria-label={`${channel.label}输入预览`} /><output className="mono">{selected && telemetry.inputValid ? telemetry.inputTarget[channel.key].toFixed(3) : '—'} <small>{channel.unit}</small></output></div>)}</div>
          <div className="gamepad-checks"><span className={`gamepad-start ${telemetry.startPressed ? 'pressed' : ''}`}>Start · {telemetry.startPressed ? '按下' : '释放'}</span><span>三轴：{telemetry.neutral ? '回中' : '未回中 / 无有效输入'}</span><span>{telemetry.released ? '已观察稳定释放' : '等待稳定释放'}</span></div>
          <p className="muted">先回中、释放 Start，再重新按下开启；按下与释放均稳定 40 ms 才确认。长按只切换一次，再按关闭无需回中。固定 axes 0 / 1 / 2、Start button 9。</p>
        </div>
      </section>
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">02 / 遥控阶段</h2><p>仅使能底盘 0x40，等待真实新反馈后才允许运动</p></div><span className={`state-label ${movingAllowed ? 'success' : 'warning'}`}><span className={`status-dot ${movingAllowed ? 'success' : 'warning'}`} />{stopping ? '停止请求中 · 本地已关闭' : PHASE_LABELS[telemetry.phase]}</span></div>
        <div className="gamepad-content"><div className="gamepad-limits mono"><span>平移 ≤ {GAMEPAD_LIMITS.translation} m/s</span><span>旋转 ≤ {GAMEPAD_LIMITS.rotation} deg/s</span><span>轮速 ≤ {GAMEPAD_LIMITS.wheelRpm} rpm</span></div>
          <p className="gamepad-status" role="status">{message}</p><p className="muted">传输层：{telemetry.transportMessage || '等待状态'}</p>
          <div className="gamepad-command mono"><span>调度目标 · 非发送确认</span><strong>vx {telemetry.target.vx.toFixed(3)} / vy {telemetry.target.vy.toFixed(3)} m/s / wz {telemetry.target.wz.toFixed(3)} deg/s</strong></div>
          <p className="muted">输入预览与调度目标不是实际发送记录，更不是电机反馈。实际发送请查看通信日志；电机状态请查看串口工作台的真实反馈。未开启时调度目标为零，回中只置零速、不失能。</p>
          {error && <div className="notice danger" role="alert">{error}</div>}
          {!!stopReplies.length && <div className="gamepad-stop-results"><h3>最近失能应答（{stopReplies.length} / 9）</h3>{stopReplies.map(reply => <div key={reply.id} className={reply.result === 0 ? '' : 'text-danger'}><span>{hexId(reply.id)} · {DEVICE_MAP.get(reply.id)?.name ?? '未知设备'}</span><strong>{resultName(reply.result)}</strong></div>)}<p className="muted">应答不等于物理停止，仍需核对新状态及现场设备。</p></div>}
        </div>
      </section>
    </div>
  </main>;
}
