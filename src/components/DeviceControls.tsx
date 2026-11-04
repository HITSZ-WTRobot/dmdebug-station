import { memo, useEffect, useId, useRef, useState } from 'react';
import { Opcode, hexId, resultName, type Response } from '../lib/protocol';
import type { DeviceSnapshot } from '../store/atoms';

interface DeviceControlsProps {
  device: DeviceSnapshot;
  ready: boolean;
  busy: boolean;
  fresh: boolean;
  onCommand: (opcode: number, id: number, values?: number[]) => Promise<Response[]>;
  onRefresh: () => void;
}

type Drafts = Partial<Record<'target' | 'min' | 'max' | 'velocity' | 'acceleration' | 'jerk' | 'vx' | 'vy' | 'wz', string>>;
const format = (value: number | null | undefined, digits = 3) =>
  value != null && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const numeric = (value: string) => value.trim() === '' ? NaN : Number(value);
const wireFinite = (value: number) => Number.isFinite(value) && Number.isFinite(Math.fround(value));

export const DeviceControls = memo(function DeviceControls(props: DeviceControlsProps) {
  // A different logical device must never inherit another device's unsent target.
  return <DevicePanel key={props.device.definition.id} {...props} />;
});

function DevicePanel({ device, ready, busy, fresh, onCommand, onRefresh }: DeviceControlsProps) {
  const { definition, state, parameters } = device;
  const { kind, id, unit } = definition;
  const motor = state?.type === 'motor-state' ? state : null;
  const chassis = state?.type === 'chassis-state' ? state : null;
  const dm = parameters?.type === 'dm-parameters' ? parameters : null;
  const dji = parameters?.type === 'dji-parameters' ? parameters : null;
  const body = parameters?.type === 'chassis-parameters' ? parameters : null;
  const flags = state?.flags;
  const [drafts, setDrafts] = useState<Drafts>({});
  const [pending, setPending] = useState(false);
  const transaction = useRef(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [showZero, setShowZero] = useState(false);
  const prefix = useId();
  const locked = busy || pending;
  const available = ready && fresh && !!flags?.connected && !flags.hostLinkTimeout;
  const idle = !flags?.busy && !flags?.enablePending && (motor?.pendingCommand == null || motor.pendingCommand === 0);
  const disabled = !!flags && !flags.enabled && !flags.enablePending &&
    (motor ? motor.motorState === null || motor.motorState === 0 : chassis?.enabledMask === 0);
  // State velocities are device-unit/s. stationaryRpm is always output-shaft rpm.
  const velocityRpm = motor ? Math.abs(motor.velocity) * (motor.unit === 'mm' ? 60 / 226.2 : 1 / 6) : NaN;
  const stationaryRpm = dm?.stationaryRpm ?? dji?.stationaryRpm;
  const stationary = Number.isFinite(velocityRpm) && stationaryRpm != null &&
    Number.isFinite(stationaryRpm) && stationaryRpm > 0 && velocityRpm <= stationaryRpm;
  const canZero = kind !== 'chassis' && available && disabled && idle && stationary && !locked;
  const configured = kind === 'm2006' || kind === 'chassis' || !!flags?.limitsConfigured;
  const zeroReady = kind === 'chassis' || !!flags?.zeroed;
  const canEnable = available && disabled && idle && configured && zeroReady && !locked &&
    (kind !== 'm2006' || !flags?.fault) &&
    (kind === 'chassis' ? chassis?.onlineMask === 15 && chassis.faultMask === 0 : kind === 'm2006' || stationary);
  const confirmedEnabled = !!flags?.enabled && !flags.enablePending &&
    (kind !== 'chassis' || chassis?.onlineMask === 15 && chassis.enabledMask === 15);
  const canMove = available && confirmedEnabled && !flags?.fault && idle && zeroReady && configured && !locked;
  const canLimits = !!dm && available && disabled && idle && !!flags?.zeroed && !locked;
  const canSafetyAction = ready && !locked;
  const lower = kind === 'm2006' ? 0 : kind === 'joint' ? Math.max(-180, dm?.min ?? -180) : undefined;
  const upper = kind === 'm2006' ? 360 : kind === 'joint' ? Math.min(180, dm?.max ?? 180) : undefined;
  const value = (key: keyof Drafts, confirmed?: number | null) => drafts[key] ?? (confirmed != null && Number.isFinite(confirmed) ? String(confirmed) : '');
  const target = numeric(value('target', motor?.target));
  const targetValid = wireFinite(target) && (lower == null || target >= lower) && (upper == null || target <= upper);
  const limits = kind === 'joint'
    ? [numeric(value('min', dm?.min)), numeric(value('max', dm?.max)), numeric(value('velocity', dm?.maxVelocity)), numeric(value('acceleration', dm?.maxAcceleration)), numeric(value('jerk', dm?.maxJerk))]
    : [numeric(value('velocity', dm?.maxVelocity)), numeric(value('acceleration', dm?.maxAcceleration)), numeric(value('jerk', dm?.maxJerk))];
  const dynamics = limits.slice(kind === 'joint' ? 2 : 0);
  const limitsValid = limits.every(wireFinite) && dynamics.every(n => Math.fround(n) > 0) &&
    (kind !== 'joint' || limits[0] >= -180 && limits[1] <= 180 && Math.fround(limits[0]) < Math.fround(limits[1]));
  const caps = { vx: Math.min(0.1, body?.maxVx ?? 0.1), vy: Math.min(0.1, body?.maxVy ?? 0.1), wz: Math.min(10, body?.maxWz ?? 10) };
  const speeds = [numeric(value('vx', chassis?.target.vx)), numeric(value('vy', chassis?.target.vy)), numeric(value('wz', chassis?.target.wz))];
  const speedValid = speeds.every(wireFinite) && Math.abs(speeds[0]) <= caps.vx && Math.abs(speeds[1]) <= caps.vy && Math.abs(speeds[2]) <= caps.wz;
  const gateReason = !ready ? '协议尚未就绪；串口打开不代表电机在线。' : !state ? '等待设备状态反馈。' : !fresh ? '状态已过期，请刷新后操作。' : !flags?.connected ? '设备离线；显示值可能是旧缓存。' : flags.hostLinkTimeout ? '设备仍报告主机链路超时，等待新心跳与反馈。' : null;
  const zeroReason = gateReason ?? (!disabled ? '请先失能并等待真实失能反馈。' : !idle ? '设备仍在运动或有待处理命令。' : stationaryRpm == null ? '需要查询真实参数以确认静止阈值。' : !stationary ? '反馈速度尚未低于静止阈值。' : locked ? '等待当前事务结束。' : '静止稳定样本仍由下位机最终检查。');

  async function send(opcode: number, label: string, values?: number[]) {
    if (transaction.current || busy || !ready) return;
    transaction.current = true;
    setPending(true);
    setNotice(null);
    try {
      const responses = await onCommand(opcode, id, values);
      const response = responses.find(item => item.id === id && item.opcode === opcode);
      if (!response) throw new Error('未收到此设备的动作确认');
      if (response.result !== 0) throw new Error(resultName(response.result));
      setNotice({ error: false, text: `${label}已受理；实际使能、零点与运动结果以新的设备反馈为准。` });
      if (opcode === Opcode.SetZero) {
        setShowZero(false);
        setDrafts(previous => { const { target, min, max, ...dynamics } = previous; return dynamics; });
      }
    } catch (error) {
      setNotice({ error: true, text: `${label}：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      transaction.current = false;
      setPending(false);
    }
  }

  function refresh() {
    try { onRefresh(); } catch (error) {
      setNotice({ error: true, text: `刷新失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  function field(key: keyof Drafts, label: string, confirmed?: number | null, min?: number, max?: number) {
    return <div className="field" key={key}>
      <label htmlFor={`${prefix}-${key}`}>{label}</label>
      <input id={`${prefix}-${key}`} type="number" inputMode="decimal" step="any" min={min} max={max}
        value={value(key, confirmed)} placeholder="等待反馈 / 输入数值" disabled={locked}
        onChange={event => {
          const next = event.target.value;
          setDrafts(previous => ({ ...previous, [key]: next }));
        }} />
    </div>;
  }

  return <section className="panel control-panel" aria-labelledby={`${prefix}-title`} aria-busy={locked}>
    <header className="panel-heading">
      <div><div className="eyebrow">设备操作 · {hexId(id)} · CAN{definition.bus}</div>
        <h2 className="panel-title" id={`${prefix}-title`}>{definition.name}</h2>
        <p className="muted">{definition.model} · {definition.canLabel} · {kind === 'chassis' ? '车体系速度' : `位置单位 ${unit}`}</p>
      </div>
      <button type="button" className="button subtle small" disabled={!ready || locked} onClick={refresh}>刷新状态 / 参数</button>
    </header>

    {gateReason && <p className="notice warning" role="status">{gateReason}</p>}
    {notice && <p className={`notice ${notice.error ? 'danger' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    <div className="readout-grid">
      {motor ? <>
        <div className="readout"><span>实际位置</span><strong className="mono">{format(motor.position)}</strong><small>{unit}</small></div>
        <div className="readout"><span>实际速度</span><strong className="mono">{format(motor.velocity)}</strong><small>{unit}/s</small></div>
        <div className="readout"><span>已受理目标</span><strong className="mono">{format(motor.target)}</strong><small>{unit} · 不是到位确认</small></div>
        <div className="readout"><span>{kind === 'm2006' ? '速度控制总参考' : '轨迹位置参考'}</span><strong className="mono">{format(kind === 'm2006' ? motor.referenceVelocity : motor.reference)}</strong><small>{kind === 'm2006' ? 'deg/s · 含位置 PD' : unit}</small></div>
      </> : chassis ? <>
        <div className="readout"><span>实际 vx / vy</span><strong className="mono">{format(chassis.velocity.vx)} / {format(chassis.velocity.vy)}</strong><small>m/s · 轮速反解，不能校正打滑</small></div>
        <div className="readout"><span>实际 wz</span><strong className="mono">{format(chassis.velocity.wz)}</strong><small>deg/s</small></div>
        <div className="readout"><span>已受理 vx / vy</span><strong className="mono">{format(chassis.target.vx)} / {format(chassis.target.vy)}</strong><small>m/s</small></div>
        <div className="readout"><span>已受理 wz</span><strong className="mono">{format(chassis.target.wz)}</strong><small>deg/s · 速度模式，无位置到位</small></div>
      </> : <div className="empty-state">尚无设备反馈；不显示模拟测量。</div>}
    </div>
    <details className="diagnostic-details"><summary>设备状态详情</summary>
    <dl className="metric-list device-state-list">
      <div><dt>设备连接 / 数据</dt><dd>{!flags ? '未知' : flags.connected ? '在线' : '离线'} / {state ? fresh ? '新鲜' : '过期' : '未收到'}</dd></div>
      <div><dt>{kind === 'm2006' ? '软件运行授权' : '反馈使能'}</dt><dd>{!flags ? '未知' : flags.enablePending ? '待使能反馈确认' : confirmedEnabled ? '已确认' : '未使能 / 未全部确认'}</dd></div>
      {kind !== 'chassis' && <div><dt>软件零点 / 运动约束</dt><dd>{flags ? `${flags.zeroed ? '已建立' : '未建立'} / ${kind === 'm2006' ? '固定范围 0…360 deg' : flags.limitsConfigured ? '已配置' : '未配置'}` : '未知'}</dd></div>}
      <div><dt>设备状态</dt><dd>{!flags ? '未知' : flags.fault ? '故障' : flags.enablePending ? '等待使能确认' : flags.busy ? '运动 / 命令忙' : kind === 'chassis' ? '速度模式' : flags.connected && fresh && flags.motionComplete ? '反馈报告运动完成' : '空闲；未确认到位'}</dd></div>
      {chassis && <div><dt>在线 / 使能 / 故障掩码</dt><dd className="mono">{hexId(chassis.onlineMask)} / {hexId(chassis.enabledMask)} / {hexId(chassis.faultMask)}</dd></div>}
      {motor && motor.motorState != null && <div><dt>原始 DM 状态 / 待处理命令</dt><dd className="mono">{motor.motorState} / {motor.pendingCommand ?? '—'}</dd></div>}
      <div><dt>最近设备结果</dt><dd>{state ? resultName(state.lastResult) : '—'}</dd></div>
    </dl>
    </details>

    <div className="actions">
      <button type="button" className="button primary" disabled={!canEnable} onClick={() => { if (canEnable) void send(Opcode.Enable, '使能'); }}>明确使能</button>
      <button type="button" className="button" disabled={!canSafetyAction} onClick={() => void send(Opcode.Disable, '失能')}>失能</button>
      <button type="button" className="button danger" disabled={!canSafetyAction} onClick={() => void send(Opcode.Stop, kind === 'chassis' ? '零速停止' : '停止 / 保持')}>{kind === 'chassis' ? '零速停止' : '停止 / 保持'}</button>
    </div>
    <p className="muted">{kind === 'chassis' ? '停止将车体系速度设零，保持使能，不锁定位置。使能需四轮新反馈全部确认；下位机检查四轮失能与静止。' : '停止取消轨迹并保持当前位置，仍可能产生力矩；失能 ACK 也不是物理停机证明。'}</p>
    {flags?.fault && <p className="notice danger">{kind === 'm2006' ? 'M2006 故障锁存：先失能、静止稳定，再明确设置软件零点清除故障，之后才能使能。' : '先排除实际故障源并确认失能；允许明确使能重试，不会自动清故障或续跑。'}</p>}
    {!canEnable && available && !flags?.fault && <p className="muted">使能需失能反馈、无待处理命令{kind === 'chassis' ? '、四轮在线且无轮故障。' : kind === 'm2006' ? '、已建立零点；不依赖 DM 的限值标志。' : '、已建立零点、已配置约束及静止反馈。'}</p>}

    {kind === 'chassis' ? <section className="parameter-section" aria-labelledby={`${prefix}-body-title`}>
      <h3 id={`${prefix}-body-title`}>车体系速度目标</h3>
      <p className="muted">x 向前、y 向左、wz 逆时针为正。编辑不会发送命令；点击应用才下发。</p>
      <form onSubmit={event => { event.preventDefault(); if (canMove && speedValid) void send(Opcode.BodyVelocity, '车体系速度', speeds); }}>
        <div className="field-grid3">
          {field('vx', 'vx · m/s', chassis?.target.vx, -caps.vx, caps.vx)}
          {field('vy', 'vy · m/s', chassis?.target.vy, -caps.vy, caps.vy)}
          {field('wz', 'wz · deg/s', chassis?.target.wz, -caps.wz, caps.wz)}
        </div>
        <div className="actions"><button type="submit" className="button primary" disabled={!canMove || !speedValid}>应用速度</button></div>
      </form>
      <p className="notice warning">已确认固件上限：|vx| ≤ 0.1 m/s、|vy| ≤ 0.1 m/s、|wz| ≤ 10 deg/s、轮速 ≤ 30 rpm。超限拒绝，不自动缩放；实际轮向需架空验证。</p>
      <dl className="metric-list">
        <div><dt>查询上限 vx / vy / wz / 轮速</dt><dd className="mono">{format(body?.maxVx)} / {format(body?.maxVy)} / {format(body?.maxWz)} / {format(body?.maxWheelRpm)}</dd></div>
        <div><dt>轮半径 / X / Y 距离 · mm</dt><dd className="mono">{format(body?.radiusMm)} / {format(body?.distanceXmm)} / {format(body?.distanceYmm)}</dd></div>
      </dl>
    </section> : <>
      <section className="parameter-section" aria-labelledby={`${prefix}-move-title`}>
        <h3 id={`${prefix}-move-title`}>绝对位置目标</h3>
        <form onSubmit={event => { event.preventDefault(); if (canMove && targetValid) void send(Opcode.Move, '绝对位置目标', [target]); }}>
          {field('target', `相对当前软件零点的绝对位置 · ${unit}`, motor?.target, lower, upper)}
          <p className="muted">{kind === 'linear' ? '无软件行程上下限；只接受有限且可编码的数值。' : `允许范围 ${format(lower)} … ${format(upper)} deg；不是增量，不取最短角。`}</p>
          <div className="actions"><button type="submit" className="button primary" disabled={!canMove || !targetValid}>发送位置目标</button></div>
        </form>
        {kind === 'linear' && <p className="notice warning">226.2 mm/输出轴圈是换算比例，不是可用行程。当前协议原点附近仅约 ±23.434 mm 可编码；软件设零会移动原点，剩余正负行程未必对称。下位机拒绝不可编码目标，不截断。</p>}
      </section>
      <section className="parameter-section" aria-labelledby={`${prefix}-zero-title`}>
        <h3 id={`${prefix}-zero-title`}>软件零点</h3>
        <p className="muted">当前静止判断：{format(velocityRpm)} rpm / 查询阈值 {format(stationaryRpm)} rpm。稳定样本由下位机检查。</p>
        <button type="button" className="button" disabled={!canZero} onClick={() => setShowZero(true)}>将当前位置设为软件零点…</button>
        {!canZero && <p className="muted">{zeroReason}</p>}
      </section>
    </>}

    {(kind === 'linear' || kind === 'joint') && <details className="parameter-section" aria-labelledby={`${prefix}-limits-title`}>
      <summary id={`${prefix}-limits-title`}>DM 运动约束 · RAM</summary>
      <p className="muted">默认显示设备已应用参数；输入草稿不会被连续轮询覆盖。仅失能时应用，不写入 Flash。</p>
      <form onSubmit={event => { event.preventDefault(); if (canLimits && limitsValid) void send(Opcode.SetLimits, '运动约束', limits); }}>
        {kind === 'joint' && <div className="field-row">{field('min', '最小位置 · deg', dm?.min, -180, 180)}{field('max', '最大位置 · deg', dm?.max, -180, 180)}</div>}
        <div className="field-grid3">
          {field('velocity', `最大速度 · ${unit}/s`, dm?.maxVelocity, 0)}
          {field('acceleration', `最大加速度 · ${unit}/s²`, dm?.maxAcceleration, 0)}
          {field('jerk', `最大 jerk · ${unit}/s³`, dm?.maxJerk, 0)}
        </div>
        {!limitsValid && <p className="muted">需有限正动态参数{kind === 'joint' ? '，且 −180 ≤ min < max ≤ 180 deg' : ''}；最终协议编码边界由下位机检查。</p>}
        <div className="actions"><button type="submit" className="button primary" disabled={!canLimits || !limitsValid}>应用运动约束</button></div>
      </form>
      {kind === 'joint' && <p className="muted">已应用范围：{format(dm?.min)} … {format(dm?.max)} deg。重新设零后，下位机恢复完整 ±180 deg 区间。</p>}
      <dl className="metric-list">
        <div><dt>已应用 v / a / jerk</dt><dd className="mono">{format(dm?.maxVelocity)} / {format(dm?.maxAcceleration)} / {format(dm?.maxJerk)}</dd></div>
        <div><dt>MIT Kp / Kd / 前馈 Nm · 只读</dt><dd className="mono">{format(dm?.kp)} / {format(dm?.kd)} / {format(dm?.torqueFeedforward)}</dd></div>
        <div><dt>完成阈值 · {unit}</dt><dd className="mono">{format(dm?.finish)}</dd></div>
      </dl>
    </details>}

    {kind === 'm2006' && <details className="parameter-section" aria-labelledby={`${prefix}-dji-title`}>
      <summary id={`${prefix}-dji-title`}>M2006 控制参数 · 只读</summary>
      <p className="muted">来自真实参数查询，不提供在线编辑。enabled 仅代表软件运行授权，C610 无物理使能应答。</p>
      <dl className="metric-list">
        <div><dt>速度 PID · Kp / Ki / Kd</dt><dd className="mono">{format(dji?.velocityPid.kp)} / {format(dji?.velocityPid.ki)} / {format(dji?.velocityPid.kd)}</dd></div>
        <div><dt>速度 PID 输出上限 · C610 指令</dt><dd className="mono">{format(dji?.velocityPid.outputMax)}</dd></div>
        <div><dt>位置 PD · Kp / Kd / 输出上限 deg/s</dt><dd className="mono">{format(dji?.positionPd.kp)} / {format(dji?.positionPd.kd)} / {format(dji?.positionPd.outputMax)}</dd></div>
        <div><dt>轨迹速度 · deg/s</dt><dd className="mono">{format(dji?.profile.maxVelocity)}</dd></div>
        <div><dt>轨迹加速度 · deg/s²</dt><dd className="mono">{format(dji?.profile.maxAcceleration)}</dd></div>
        <div><dt>轨迹 jerk · deg/s³</dt><dd className="mono">{format(dji?.profile.maxJerk)}</dd></div>
        <div><dt>完成阈值 · deg</dt><dd className="mono">{format(dji?.finish)}</dd></div>
        <div><dt>静止阈值 · rpm</dt><dd className="mono">{format(dji?.stationaryRpm)}</dd></div>
      </dl>
      <p className="muted">C610 电流指令不是电源输入电流测量，也不是安全保证。不公开的力矩和轨迹位置不伪造显示。</p>
    </details>}

    {showZero && <ZeroConfirmation name={`${definition.name} · ${hexId(id)}`} kind={kind} canConfirm={canZero}
      reason={zeroReason} busy={pending} error={notice?.error ? notice.text : null} onCancel={() => setShowZero(false)}
      onConfirm={() => { if (canZero) void send(Opcode.SetZero, '软件设零'); }} />}
  </section>;
}

function ZeroConfirmation({ name, kind, canConfirm, reason, busy, error, onCancel, onConfirm }: {
  name: string; kind: string; canConfirm: boolean; reason: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current;
    const buttons = () => Array.from(root?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    buttons()[0]?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key !== 'Tab') return;
      const items = buttons();
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); root?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    function focusin(event: FocusEvent) {
      if (event.target instanceof Node && !root?.contains(event.target)) (buttons()[0] ?? root)?.focus();
    }
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="modal-backdrop">
    <div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={description} tabIndex={-1}>
      <h2 id={title}>确认改变软件零点</h2>
      <div id={description}>
        <p><strong>{name}</strong></p>
        <p>这不是移动到原点。当前物理位置将成为新的软件 0，旧目标失效，允许操作的实际物理区域随之改变。</p>
        <p>{kind === 'joint' ? '关节工作区将重新以当前位置为中心建立 −180…+180 deg；此前较小的软件范围会重置。完整范围不可编码时设备拒绝，保留旧零点。' : kind === 'm2006' ? 'M2006 工作区变为从当前位置起 0…360 deg；故障锁存仅在满足条件且明确设零后清除。' : '伸缩只改变毫米原点，不建立软件行程限位；协议可编码区域仍有限，正负剩余行程未必对称。'}</p>
        <p className="notice warning">确认整个新工作区无机械碰撞风险。操作不写电机零点寄存器或 Flash，不会自动运动或使能。</p>
        <p className="muted">{canConfirm ? '当前反馈满足连接、新鲜、失能及低速条件；下位机仍需检查静止稳定样本。' : reason}</p>
        <p className="muted" role="status">{busy ? '请求处理中。关闭窗口不会撤销已发送的命令。' : '只有再次点击确认才会发送 SetZero。'}</p>
        {error && <p className="notice danger" role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onCancel}>取消 / 关闭</button>
        <button type="button" className="button danger" disabled={!canConfirm} onClick={onConfirm}>确认将当前位置设零</button>
      </div>
    </div>
  </div>;
}
