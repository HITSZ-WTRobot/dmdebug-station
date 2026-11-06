import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { hexId, type DeviceDefinition, type DeviceState } from '../lib/protocol';

type SampleBase = { updatedAt: number; demo: boolean };
type MotorSample = SampleBase & {
  type: 'motor'; position: number; velocity: number; target: number;
  reference: number | null; referenceVelocity: number | null; torque: number | null;
  torqueFeedforward: number | null;
  feedbackCount: number;
};
type ChassisSample = SampleBase & {
  type: 'chassis'; vx: number; vy: number; wz: number;
  targetVx: number; targetVy: number; targetWz: number;
};
type Sample = MotorSample | ChassisSample;
type History = { samples: Sample[]; lastUpdatedAt: number | null; coordinateEpoch: number };
type Series = {
  key: string; label: string; color: string; dashed?: boolean;
  value: (sample: Sample) => number | null;
};
type MotorView = 'position' | 'velocity' | 'torque';
type ChassisView = 'translation' | 'rotation';

const MAX_SAMPLES = 1000;
const EMPTY_SAMPLES: Sample[] = [];
const BLUE = '#2866a2';
const TEAL = '#387d78';
const SLATE = '#7b8796';
const WIDTH = 960;
const HEIGHT = 340;
const LEFT = 86;
const RIGHT = 24;
const TOP = 30;
const BOTTOM = 64;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const tickLabel = (value: number) => Number(value.toPrecision(4)).toString();
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

function capture(state: DeviceState, updatedAt: number, demo: boolean): Sample {
  if (state.type === 'chassis-state') {
    return {
      type: 'chassis', updatedAt, demo,
      vx: state.velocity.vx, vy: state.velocity.vy, wz: state.velocity.wz,
      targetVx: state.target.vx, targetVy: state.target.vy, targetWz: state.target.wz,
    };
  }
  return {
    type: 'motor', updatedAt, demo, position: state.position, velocity: state.velocity,
    target: state.target, reference: state.kind === 'm2006' ? null : state.reference,
    referenceVelocity: state.referenceVelocity, torque: state.kind === 'm2006' ? null : state.torque,
    torqueFeedforward: state.torqueFeedforward,
    feedbackCount: state.feedbackCount,
  };
}

function motorSeries(samples: Sample[], view: MotorView, definition: DeviceDefinition): Series[] {
  const result: Series[] = [{
    key: 'actual', label: view === 'position' ? '实际位置' : view === 'torque' ? '反馈力矩' : '实际速度', color: BLUE,
    value: sample => sample.type === 'motor' ? sample[view] : null,
  }];
  if (definition.kind === 'm2006' && view === 'velocity') {
    result.push({
      key: 'target', label: '目标速度', color: TEAL, dashed: true,
      value: sample => sample.type === 'motor' ? sample.target : null,
    });
  }
  const key = view === 'position' ? 'reference' : view === 'torque' ? 'torqueFeedforward' : 'referenceVelocity';
  if (!(view === 'position' && definition.kind === 'm2006') &&
    (definition.kind === 'm2006' && view === 'velocity' || samples.some(sample => sample.type === 'motor' && finite(sample[key])))) {
    result.push({
      key: 'reference', label: view === 'position' ? '参考位置' : view === 'torque' ? 'MIT附加前馈' : '参考速度', color: SLATE, dashed: true,
      value: sample => sample.type === 'motor' ? sample[key] : null,
    });
  }
  return result;
}

function chassisSeries(view: ChassisView): Series[] {
  if (view === 'rotation') {
    return [
      { key: 'wz', label: '实际 wz', color: BLUE, value: sample => sample.type === 'chassis' ? sample.wz : null },
      { key: 'targetWz', label: '目标 wz', color: SLATE, dashed: true, value: sample => sample.type === 'chassis' ? sample.targetWz : null },
    ];
  }
  return [
    { key: 'vx', label: '实际 vx', color: BLUE, value: sample => sample.type === 'chassis' ? sample.vx : null },
    { key: 'vy', label: '实际 vy', color: TEAL, value: sample => sample.type === 'chassis' ? sample.vy : null },
    { key: 'targetVx', label: '目标 vx', color: BLUE, dashed: true, value: sample => sample.type === 'chassis' ? sample.targetVx : null },
    { key: 'targetVy', label: '目标 vy', color: TEAL, dashed: true, value: sample => sample.type === 'chassis' ? sample.targetVy : null },
  ];
}

function plotGeometry(samples: Sample[], series: Series[]) {
  if (samples.length === 0) return null;
  const origin = samples[0].updatedAt;
  let minTime = Infinity;
  let maxTime = -Infinity;
  let minValue = Infinity;
  let maxValue = -Infinity;
  for (const sample of samples) {
    const elapsed = (sample.updatedAt - origin) / 1000;
    minTime = Math.min(minTime, elapsed);
    maxTime = Math.max(maxTime, elapsed);
    for (const item of series) {
      const value = item.value(sample);
      if (finite(value)) {
        minValue = Math.min(minValue, value);
        maxValue = Math.max(maxValue, value);
      }
    }
  }
  if (!Number.isFinite(minValue)) return null;
  const valuePadding = maxValue === minValue ? Math.max(Math.abs(minValue) * 0.05, 0.1) : (maxValue - minValue) * 0.08;
  minValue -= valuePadding;
  maxValue += valuePadding;
  if (minTime === maxTime) {
    minTime -= 0.5;
    maxTime += 0.5;
  }
  const x = (time: number) => LEFT + (((time - origin) / 1000 - minTime) / (maxTime - minTime)) * PLOT_WIDTH;
  const y = (value: number) => TOP + (1 - (value - minValue) / (maxValue - minValue)) * PLOT_HEIGHT;
  const lines = series.map(item => {
    let path = '';
    let connected = false;
    let count = 0;
    let first: { x: number; y: number } | null = null;
    for (const sample of samples) {
      const value = item.value(sample);
      if (!finite(value)) { connected = false; continue; }
      const px = x(sample.updatedAt);
      const py = y(value);
      path += `${connected ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)} `;
      connected = true;
      count++;
      if (!first) first = { x: px, y: py };
    }
    return { ...item, path, singlePoint: count === 1 ? first : null };
  });
  return {
    lines,
    xTicks: Array.from({ length: 5 }, (_, index) => {
      const value = minTime + ((maxTime - minTime) * index) / 4;
      return { value, x: LEFT + (PLOT_WIDTH * index) / 4 };
    }),
    yTicks: Array.from({ length: 5 }, (_, index) => {
      const value = minValue + ((maxValue - minValue) * index) / 4;
      return { value, y: y(value) };
    }),
  };
}

function csvForDevice(definition: DeviceDefinition, samples: Sample[]): string {
  const headers = ['device_id', 'updated_at_ms', 'elapsed_s', 'source'];
  const origin = samples[0]?.updatedAt ?? 0;
  let values: (sample: Sample) => (number | null)[];
  if (definition.kind === 'chassis') {
    headers.push('actual_vx_m_s', 'actual_vy_m_s', 'actual_wz_deg_s', 'target_vx_m_s', 'target_vy_m_s', 'target_wz_deg_s');
    values = sample => sample.type === 'chassis'
      ? [sample.vx, sample.vy, sample.wz, sample.targetVx, sample.targetVy, sample.targetWz] : [];
  } else if (definition.kind === 'm2006') {
    headers.push('diagnostic_position_deg', 'actual_velocity_rpm', 'target_velocity_rpm', 'reference_velocity_rpm', 'feedback_count');
    values = sample => sample.type === 'motor'
      ? [sample.position, sample.velocity, sample.target, sample.referenceVelocity, sample.feedbackCount] : [];
  } else {
    const referenceAvailable = samples.some(sample => sample.type === 'motor' && finite(sample.reference));
    const velocityReferenceAvailable = samples.some(sample => sample.type === 'motor' && finite(sample.referenceVelocity));
    const torqueAvailable = samples.some(sample => sample.type === 'motor' && finite(sample.torque));
    const feedforwardAvailable = samples.some(sample => sample.type === 'motor' && finite(sample.torqueFeedforward));
    headers.push(`actual_position_${definition.unit}`, `actual_velocity_${definition.unit}_s`, `target_position_${definition.unit}`);
    if (referenceAvailable) headers.push(`reference_position_${definition.unit}`);
    if (velocityReferenceAvailable) headers.push(`reference_velocity_${definition.unit}_s`);
    if (torqueAvailable) headers.push('feedback_torque_Nm');
    if (feedforwardAvailable) headers.push('MIT_torque_feedforward_Nm');
    headers.push('feedback_count');
    values = sample => {
      if (sample.type !== 'motor') return [];
      const row = [sample.position, sample.velocity, sample.target] as (number | null)[];
      if (referenceAvailable) row.push(sample.reference);
      if (velocityReferenceAvailable) row.push(sample.referenceVelocity);
      if (torqueAvailable) row.push(sample.torque);
      if (feedforwardAvailable) row.push(sample.torqueFeedforward);
      row.push(sample.feedbackCount);
      return row;
    };
  }
  return [headers.join(','), ...samples.map(sample => [
    hexId(definition.id), sample.updatedAt, (sample.updatedAt - origin) / 1000, sample.demo ? 'demo' : 'hardware',
    ...values(sample).map(value => finite(value) ? value : ''),
  ].join(','))].join('\r\n');
}

function TelemetryContent({ definition, state, updatedAt, demo, coordinateEpoch = 0 }: {
  definition: DeviceDefinition; state: DeviceState | null; updatedAt: number; demo: boolean; coordinateEpoch?: number;
}) {
  const histories = useRef(new Map<number, History>());
  const [revision, setRevision] = useState(0);
  const [paused, setPaused] = useState(false);
  const [motorView, setMotorView] = useState<MotorView>('position');
  const [m2006View, setM2006View] = useState<'position' | 'velocity'>('velocity');
  const [chassisView, setChassisView] = useState<ChassisView>('translation');
  const chartId = useId();

  useEffect(() => {
    let history = histories.current.get(definition.id);
    if (!history || history.coordinateEpoch !== coordinateEpoch) {
      history = { samples: [], lastUpdatedAt: null, coordinateEpoch };
      histories.current.set(definition.id, history);
      setRevision(value => value + 1);
    }
    if (!state || !state.flags.connected || state.id !== definition.id || state.kind !== definition.kind || !Number.isFinite(updatedAt) || updatedAt <= 0) return;
    if (history.lastUpdatedAt === updatedAt) return;
    history.lastUpdatedAt = updatedAt;
    if (paused) return;
    history.samples.push(capture(state, updatedAt, demo));
    if (history.samples.length > MAX_SAMPLES) history.samples.shift();
    setRevision(value => value + 1);
  }, [definition.id, definition.kind, state, updatedAt, demo, paused, coordinateEpoch]);

  const samples = histories.current.get(definition.id)?.samples ?? EMPTY_SAMPLES;
  const chassis = definition.kind === 'chassis';
  const m2006 = definition.kind === 'm2006';
  const view = m2006 ? m2006View : motorView;
  const positionUnit = m2006 ? 'deg' : definition.unit;
  const velocityUnit = m2006 ? 'rpm' : `${definition.unit}/s`;
  const unit = chassis ? (chassisView === 'translation' ? 'm/s' : 'deg/s') : (view === 'torque' ? 'Nm' : view === 'position' ? positionUnit : velocityUnit);
  const quantity = chassis ? (chassisView === 'translation' ? '车体平移速度' : '车体角速度') : (view === 'torque' ? '力矩' : view === 'position' ? m2006 ? '诊断位置' : '位置' : '速度');
  const series = useMemo(() => chassis ? chassisSeries(chassisView) : motorSeries(samples, view, definition),
    [chassis, chassisView, view, definition, samples, revision]);
  const geometry = useMemo(() => plotGeometry(samples, series), [samples, series, revision]);
  const demoCount = useMemo(() => samples.reduce((count, sample) => count + Number(sample.demo), 0), [samples, revision]);
  const latest = samples[samples.length - 1];
  const elapsed = samples.length > 1 ? (samples[samples.length - 1].updatedAt - samples[0].updatedAt) / 1000 : 0;

  function clearHistory() {
    const history = histories.current.get(definition.id);
    if (history) history.samples = [];
    setRevision(value => value + 1);
  }

  function exportCsv() {
    const current = histories.current.get(definition.id)?.samples;
    if (!current?.length) return;
    const url = URL.createObjectURL(new Blob([csvForDevice(definition, current)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `telemetry-${hexId(definition.id)}-${current[current.length - 1].updatedAt}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Let the browser consume the download before releasing its object URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="panel scope-panel" aria-labelledby={`${chartId}-heading`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">遥测 · {hexId(definition.id)}</p>
          <h2 className="panel-title" id={`${chartId}-heading`}>实时曲线</h2>
          <p className="muted scope-subtitle">{definition.name} · CAN {definition.bus} · {quantity} ({unit})</p>
        </div>
        <span className={`scope-capture-status${paused ? ' is-paused' : ''}`}>{paused ? '采样已暂停' : '等待 / 接收反馈'}</span>
      </div>

      <div className="scope-toolbar">
        {chassis ? (
          <div className="segmented" role="group" aria-label="Chassis chart series">
            <button className={chassisView === 'translation' ? 'active' : ''} aria-pressed={chassisView === 'translation'} onClick={() => setChassisView('translation')}>vx / vy · m/s</button>
            <button className={chassisView === 'rotation' ? 'active' : ''} aria-pressed={chassisView === 'rotation'} onClick={() => setChassisView('rotation')}>wz · deg/s</button>
          </div>
        ) : (
          <div className="segmented" role="group" aria-label="Motor chart series">
            <button className={view === 'position' ? 'active' : ''} aria-pressed={view === 'position'} onClick={() => m2006 ? setM2006View('position') : setMotorView('position')}>{m2006 ? '诊断位置' : '位置 / 参考'} · {positionUnit}</button>
            <button className={view === 'velocity' ? 'active' : ''} aria-pressed={view === 'velocity'} onClick={() => m2006 ? setM2006View('velocity') : setMotorView('velocity')}>{m2006 ? '速度 / 目标 / 参考' : '速度 / 参考'} · {velocityUnit}</button>
            {definition.kind !== 'm2006' && <button className={motorView === 'torque' ? 'active' : ''} aria-pressed={motorView === 'torque'} onClick={() => setMotorView('torque')}>力矩 · Nm</button>}
          </div>
        )}
        <div className="actions">
          <button className="button small" aria-label={paused ? 'Resume capture' : 'Pause capture'} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? '继续采样' : '暂停采样'}</button>
          <button className="button small subtle" aria-label="Clear current device history" disabled={samples.length === 0} onClick={clearHistory}>清空</button>
          <button className="button small subtle" aria-label="Export current device CSV" disabled={samples.length === 0} onClick={exportCsv}>导出 CSV</button>
        </div>
      </div>

      <div className="legend" aria-label={`Series in ${unit}`}>
        {series.map(item => (
          <span className="scope-legend-item" key={item.key}>
            <svg className="legend-swatch" width="20" height="8" viewBox="0 0 20 8" aria-hidden="true">
              <line x1="0" y1="4" x2="20" y2="4" stroke={item.color} strokeWidth="2" strokeDasharray={item.dashed ? '5 3' : undefined} />
            </svg>
            {item.label} <span className="muted">({unit})</span>
          </span>
        ))}
      </div>

      {demo || demoCount > 0 ? <p className="notice warning scope-source-notice">{demo ? '演示模式：仅绘制传入的模拟反馈，不代表硬件状态。' : '此设备历史包含演示样本。'} 已存 {demoCount} 个演示样本；CSV 逐行标明数据来源。</p> : null}

      <div className="scope-plot">
        {geometry ? (
          <svg className="scope-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-labelledby={`${chartId}-title ${chartId}-description`}>
            <title id={`${chartId}-title`}>{definition.name} — {quantity} ({unit})</title>
            <desc id={`${chartId}-description`}>{samples.length} 个实际接收样本，按反馈更新时间绘制。横轴为距当前历史首个样本的秒数，纵轴单位为 {unit}。{series.map(item => item.label).join('、')}。虚线表示参考或目标，不是实际反馈。{demoCount > 0 ? `其中 ${demoCount} 个样本来自演示模式。` : ''}</desc>
            {geometry.yTicks.map(tick => (
              <g key={tick.y}>
                <line className="scope-grid-line" x1={LEFT} x2={WIDTH - RIGHT} y1={tick.y} y2={tick.y} stroke="#e5e8eb" strokeWidth="1" />
                <text className="scope-tick" x={LEFT - 12} y={tick.y + 4} textAnchor="end" fill="#687381" fontSize="12">{tickLabel(tick.value)}</text>
              </g>
            ))}
            {geometry.xTicks.map(tick => (
              <g key={tick.x}>
                <line className="scope-grid-line" x1={tick.x} x2={tick.x} y1={TOP} y2={HEIGHT - BOTTOM} stroke="#edf0f2" strokeWidth="1" />
                <text className="scope-tick" x={tick.x} y={HEIGHT - BOTTOM + 24} textAnchor="middle" fill="#687381" fontSize="12">{tickLabel(tick.value)}</text>
              </g>
            ))}
            <line x1={LEFT} x2={LEFT} y1={TOP} y2={HEIGHT - BOTTOM} stroke="#aeb7c1" />
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} stroke="#aeb7c1" />
            <text className="scope-axis-label" transform={`translate(20 ${TOP + PLOT_HEIGHT / 2}) rotate(-90)`} textAnchor="middle" fill="#465362" fontSize="12">{quantity} ({unit})</text>
            <text className="scope-axis-label" x={LEFT + PLOT_WIDTH / 2} y={HEIGHT - 12} textAnchor="middle" fill="#465362" fontSize="12">距首个保留样本的时间 (s)</text>
            {geometry.lines.map(line => (
              <g key={line.key}>
                <path d={line.path} fill="none" stroke={line.color} strokeWidth="1.8" strokeDasharray={line.dashed ? '6 4' : undefined} vectorEffect="non-scaling-stroke" />
                {line.singlePoint ? <circle cx={line.singlePoint.x} cy={line.singlePoint.y} r="3" fill={line.color} /> : null}
              </g>
            ))}
          </svg>
        ) : (
          <div className="empty-state scope-waiting" role="status">
            <strong>{paused ? '采样已暂停' : '等待设备反馈'}</strong>
            <p>收到 {hexId(definition.id)} 的有效状态后显示曲线；不生成或补齐数据。</p>
            <span className="muted">{samples.length} / {MAX_SAMPLES} 个样本</span>
          </div>
        )}
      </div>

      <div className="scope-footer">
        <span className="mono">{samples.length} / {MAX_SAMPLES} 个样本 · {tickLabel(elapsed)} s</span>
        {latest?.type === 'motor' ? <span className="muted">设备反馈计数 <span className="mono">{latest.feedbackCount}</span>{finite(latest.torque) ? <> · 反馈力矩 <span className="mono">{tickLabel(latest.torque)} Nm</span></> : null}</span> : null}
        <span className="muted">仅在更新时间变化时采样；暂停期间不补录。CSV 包含当前设备全部保留通道。</span>
      </div>
    </section>
  );
}

export const TelemetryPanel = memo(TelemetryContent);
