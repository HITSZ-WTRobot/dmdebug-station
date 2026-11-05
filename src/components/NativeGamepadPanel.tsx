import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Gamepad2, ShieldAlert } from 'lucide-react';
import type { NativePadSnapshot } from '../lib/native-transport';
import { GAMEPAD_LIMITS } from '../lib/gamepad';

const ZERO = { vx: 0, vy: 0, wz: 0 };
const INITIAL: NativePadSnapshot = { supported: true, error: '', pads: [], selectedKey: '',
  armed: false, neutral: false, released: false, startPressed: false, inputTarget: ZERO, target: ZERO,
  phase: 'off', message: '请选择手柄；选择后仅预览输入，不会自动使能。' };
const PHASE_LABELS: Record<string, string> = { off: '遥控关闭', enabling: '等待底盘新反馈确认 · 尚不可运动', active: '底盘已确认使能', stopping: '正在请求全设备失能' };
const CHANNELS = [{ key: 'vx', label: '前后', direction: '前进 + / 后退 −', limit: GAMEPAD_LIMITS.translation, unit: 'm/s' },
  { key: 'vy', label: '左右', direction: '左移 + / 右移 −', limit: GAMEPAD_LIMITS.translation, unit: 'm/s' },
  { key: 'wz', label: '旋转', direction: '逆时针 + / 顺时针 −', limit: GAMEPAD_LIMITS.rotation, unit: 'deg/s' }] as const;

export function NativeGamepadPanel({ visible }: { visible: boolean }) {
  const [snapshot, setSnapshot] = React.useState(INITIAL);
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
        if (active && revision === startedAt) setSnapshot(next);
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
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    const context = () => {
      const shown = visible && document.visibilityState === 'visible';
      const focused = document.hasFocus();
      if (!shown || !focused) { epoch.current++; setPending(false); }
      // 这里只传递页面意图；真正窗口焦点另由 Tauri on_window_event 门禁。
      void invoke('native_gamepad_context', { visible: shown, focused }).catch(failure => { if (active) setError(String(failure)); });
    };
    const pageHide = () => {
      epoch.current++; setPending(false);
      void invoke('native_gamepad_context', { visible: false, focused: false }).catch(failure => { if (active) setError(String(failure)); });
    };
    context();
    window.addEventListener('focus', context); window.addEventListener('blur', context);
    window.addEventListener('pagehide', pageHide);
    document.addEventListener('visibilitychange', context);
    return () => {
      active = false; epoch.current++;
      window.removeEventListener('focus', context); window.removeEventListener('blur', context);
      window.removeEventListener('pagehide', pageHide);
      document.removeEventListener('visibilitychange', context);
    };
  }, [visible]);

  const stop = async () => {
    const operation = ++epoch.current;
    setPending(true); setError('');
    try { await invoke('native_gamepad_stop'); }
    catch (failure) { if (mounted.current && operation === epoch.current) setError(String(failure)); }
    finally { if (mounted.current && operation === epoch.current) setPending(false); }
  };
  const choosePad = async (deviceKey: string) => {
    if (!deviceKey || !visibleRef.current || !document.hasFocus() || document.hidden) return;
    const operation = ++epoch.current;
    setPending(true); setError('');
    // 选择立即提交；Rust 负责撤销旧许可并固定映射，绝不在前端排队自动使能。
    try { await invoke('native_gamepad_select', { deviceKey }); }
    catch (failure) { if (mounted.current && operation === epoch.current) setError(String(failure)); }
    finally { if (mounted.current && operation === epoch.current) setPending(false); }
  };
  const selected = snapshot.pads.find(pad => pad.key === snapshot.selectedKey && pad.connected);
  const movingAllowed = snapshot.armed && snapshot.phase === 'active';

  return <main className="gamepad-page" hidden={!visible}>
    <div className="selection-heading"><div><div className="selection-meta"><span className="mono">USB GAMEPAD → WINMM / RUST → SPP COM → FDCAN2</span></div><h1><Gamepad2 size={25} />手柄遥控</h1><p>左杆前后 / 左右，右杆 X 旋转，Start 切换遥控。右杆 Y 不参与控制或回中判断。</p></div><button className="button danger" onClick={() => { void stop(); }}><ShieldAlert size={16} />关闭遥控 / 全设备失能</button></div>
    <div className="notice warning"><strong>软件停止不是硬件急停。</strong> 全设备失能覆盖九个控制单元，竖直机构可能下落；请准备硬件急停。切页、失焦、隐藏、断柄或输入超时都会撤销许可，恢复不会自动使能。停止请求不等于物理停止。</div>
    {(!snapshot.supported || snapshot.error) && <div className="notice danger" role="alert">{snapshot.error || '此环境无法初始化 WinMM 原生手柄采集。'}</div>}
    <div className="gamepad-layout">
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">01 / 设备与实时输入</h2><p>输入预览无需串口连接，不代表已发送或实际运动</p></div><span className="mono subtle-meta">WINMM</span></div>
        <div className="gamepad-content"><div className="field"><label htmlFor="native-gamepad-device">USB 手柄</label><select id="native-gamepad-device" value={snapshot.selectedKey} disabled={pending || !snapshot.supported} onChange={event => { void choosePad(event.target.value); }}><option value="" disabled>请选择设备 · 不会自动使能</option>{snapshot.pads.map(pad => <option key={pad.key} value={pad.key} disabled={!pad.connected}>#{pad.index} · {pad.id}</option>)}</select></div>
          {!snapshot.pads.length && <p className="muted">尚未发现手柄。连接设备后选择即可预览三路输入。</p>}
          <div className="gamepad-inputs">{CHANNELS.map(channel => <div className="gamepad-input" key={channel.key}><div><strong>{channel.label}</strong><small>{channel.direction}</small></div><meter min={-channel.limit} max={channel.limit} value={snapshot.inputTarget[channel.key]} aria-label={`${channel.label}输入预览`} /><output className="mono">{selected ? snapshot.inputTarget[channel.key].toFixed(3) : '—'} <small>{channel.unit}</small></output></div>)}</div>
          <div className="gamepad-checks"><span className={`gamepad-start ${snapshot.startPressed ? 'pressed' : ''}`}>Start · {snapshot.startPressed ? '按下' : '释放'}</span><span>三轴：{snapshot.neutral ? '回中' : '未回中 / 无有效输入'}</span><span>{snapshot.released ? '已观察稳定释放' : '等待稳定释放'}</span></div>
          <p className="muted">先回中、释放 Start，再重新按下开启；按下与释放均稳定 40 ms 才确认。长按只切换一次，再按关闭无需回中。</p>
        </div>
      </section>
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">02 / 遥控阶段</h2><p>仅使能底盘 0x40，等待真实新反馈后才允许运动</p></div><span className={`state-label ${movingAllowed ? 'success' : 'warning'}`}><span className={`status-dot ${movingAllowed ? 'success' : 'warning'}`} />{PHASE_LABELS[snapshot.phase] ?? snapshot.phase}</span></div>
        <div className="gamepad-content"><div className="gamepad-limits mono"><span>平移 ≤ {GAMEPAD_LIMITS.translation} m/s</span><span>旋转 ≤ {GAMEPAD_LIMITS.rotation} deg/s</span><span>轮速 ≤ {GAMEPAD_LIMITS.wheelRpm} rpm</span></div>
          <p className="gamepad-status" role="status">{snapshot.message}</p>
          <div className="gamepad-command mono"><span>调度目标 · 非发送确认</span><strong>vx {snapshot.target.vx.toFixed(3)} / vy {snapshot.target.vy.toFixed(3)} m/s / wz {snapshot.target.wz.toFixed(3)} deg/s</strong></div>
          <p className="muted">输入预览与调度目标不是实际发送记录，更不是电机反馈。实际发送请查看通信日志；电机状态请查看串口工作台的真实反馈。未开启时调度目标为零，回中只置零速、不失能。</p>
          {error && <div className="notice danger" role="alert">{error}</div>}
        </div>
      </section>
    </div>
  </main>;
}
