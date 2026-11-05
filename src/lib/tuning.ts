import { DEVICE_MAP, type DeviceDefinition } from './protocol';

export interface OzoneMirror { expression: string; address: number; value: number }
export interface OzoneParameter extends OzoneMirror { key: string; label: string; unit: string; mirrors: OzoneMirror[] }
export interface OzoneSnapshot { deviceId: number; parameters: OzoneParameter[] }
export interface TuningField { key: string; label: string; unit: string; note?: string }
const dmControl: readonly TuningField[] = [
  { key: 'kp', label: 'MIT Kp', unit: 'MIT 增益' }, { key: 'kd', label: 'MIT Kd', unit: 'MIT 增益' },
  { key: 'torque_ff_nm', label: '力矩前馈', unit: 'Nm' }, { key: 'finish_deg', label: '完成阈值', unit: 'deg' },
  { key: 'stationary_rpm', label: '静止阈值', unit: '输出轴 rpm' },
];
const dmLimits: readonly TuningField[] = [
  { key: 'min_deg', label: '最小位置', unit: 'deg' }, { key: 'max_deg', label: '最大位置', unit: 'deg' },
  { key: 'max_velocity_deg_s', label: '轨迹最大速度', unit: 'deg/s' },
  { key: 'max_acceleration_deg_s2', label: '轨迹最大加速度', unit: 'deg/s²' },
  { key: 'max_jerk_deg_s3', label: '轨迹最大 jerk', unit: 'deg/s³' },
];
const m2006Fields: readonly TuningField[] = [
  { key: 'velocity_kp', label: '速度 PID Kp', unit: 'PID 增益' }, { key: 'velocity_ki', label: '速度 PID Ki', unit: 'PID 增益' },
  { key: 'velocity_kd', label: '速度 PID Kd', unit: 'PID 增益' }, { key: 'velocity_output_max', label: '速度 PID 输出限幅', unit: 'C610 电流指令' },
  { key: 'position_kp', label: '位置 PD Kp', unit: 'PD 增益' }, { key: 'position_kd', label: '位置 PD Kd', unit: 'PD 增益' },
  { key: 'position_output_max', label: '位置 PD 输出限幅', unit: 'deg/s' },
  { key: 'profile_max_spd', label: '轨迹最大速度', unit: 'deg/s', note: '仅影响下条新轨迹，不重新规划正在执行的曲线。' },
  { key: 'profile_max_acc', label: '轨迹最大加速度', unit: 'deg/s²', note: '仅影响下条新轨迹。' },
  { key: 'profile_max_jerk', label: '轨迹最大 jerk', unit: 'deg/s³', note: '仅影响下条新轨迹。' },
  { key: 'finish_deg', label: '完成阈值', unit: 'deg', note: '同步两个实际到位判据。' },
  { key: 'stationary_rpm', label: '静止阈值', unit: '输出轴 rpm' },
];
export function tuningFields(definition: DeviceDefinition): readonly TuningField[] {
  if (DEVICE_MAP.get(definition.id)?.kind !== definition.kind || definition.kind === 'chassis') throw new Error('Ozone 仅支持固定的八台 DM / M2006 设备');
  return definition.kind === 'm2006' ? m2006Fields : [...dmControl, ...dmLimits.slice(definition.kind === 'linear' ? 2 : 0)];
}
export function finiteF32(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value));
}
export function sameF32(a: number, b: number): boolean {
  return finiteF32(a) && finiteF32(b) && Object.is(Math.fround(a), Math.fround(b));
}
function validateLocation(value: OzoneMirror): void {
  if (!value || typeof value.expression !== 'string' || !value.expression.trim() || !Number.isInteger(value.address) || value.address <= 0 || value.address > 0xffffffff || value.address % 4 !== 0 || !finiteF32(value.value)) throw new Error('Ozone 返回无效表达式、地址或 float32');
}
export function validateParameter(parameter: OzoneParameter, definition: DeviceDefinition): void {
  if (!parameter || !tuningFields(definition).some(field => field.key === parameter.key) || typeof parameter.label !== 'string' || typeof parameter.unit !== 'string' || !Array.isArray(parameter.mirrors)) throw new Error('Ozone 返回未知参数 key 或字段格式错误');
  validateLocation(parameter);
  const mirrored = definition.kind === 'm2006' ? parameter.key !== 'stationary_rpm' : dmLimits.some(field => field.key === parameter.key);
  if (parameter.mirrors.length !== (mirrored ? 1 : 0)) throw new Error('Ozone 返回配置镜像数量不匹配');
  parameter.mirrors.forEach(validateLocation);
}
export function validateSnapshot(snapshot: OzoneSnapshot, definition: DeviceDefinition): void {
  const fields = tuningFields(definition);
  if (!snapshot || snapshot.deviceId !== definition.id || !Array.isArray(snapshot.parameters) || snapshot.parameters.length !== fields.length || new Set(snapshot.parameters.map(parameter => parameter?.key)).size !== fields.length) throw new Error('Ozone 回读设备或参数目录不匹配');
  snapshot.parameters.forEach(parameter => validateParameter(parameter, definition));
}
export function confirmParameter(parameter: OzoneParameter, definition: DeviceDefinition, key: string, value: number): void {
  validateParameter(parameter, definition);
  if (parameter.key !== key || !sameF32(parameter.value, value) || parameter.mirrors.some(mirror => !sameF32(mirror.value, value))) throw new Error('单字段写入返回与本次 key / float32 请求或配置镜像不匹配；可能已部分写入');
}
export interface TuningFile {
  format: 'dmdebug-ozone-tuning'; version: 1; deviceId: number; kind: 'linear' | 'joint' | 'm2006'; values: Record<string, number>;
}
export function updateSnapshotParameter(snapshot: OzoneSnapshot, definition: DeviceDefinition, key: string, value: number, result: OzoneParameter): OzoneSnapshot {
  validateSnapshot(snapshot, definition);
  confirmParameter(result, definition, key, value);
  return { deviceId: snapshot.deviceId, parameters: snapshot.parameters.map(parameter => parameter.key === key ? result : parameter) };
}
export function parseTuningFile(text: string, definition: DeviceDefinition): TuningFile {
  const file: unknown = JSON.parse(text);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('不是调参 JSON 对象');
  const f = file as Record<string, unknown>, keys = ['format', 'version', 'deviceId', 'kind', 'values'];
  const fields = tuningFields(definition);
  if (Object.keys(f).length !== keys.length || Object.keys(f).some(key => !keys.includes(key)) || f.format !== 'dmdebug-ozone-tuning' || f.version !== 1 || f.deviceId !== definition.id || f.kind !== definition.kind || !f.values || typeof f.values !== 'object' || Array.isArray(f.values)) throw new Error('文件格式、版本、设备编号或类型不匹配');
  const raw = f.values as Record<string, unknown>;
  if (Object.keys(raw).length !== fields.length || fields.some(field => !Object.hasOwn(raw, field.key) || !finiteF32(raw[field.key]))) throw new Error('values 必须恰好包含本设备固定 keys，且全部为有限 float32；不接受任意地址或表达式');
  return { format: 'dmdebug-ozone-tuning', version: 1, deviceId: definition.id, kind: definition.kind as TuningFile['kind'], values: Object.fromEntries(fields.map(field => [field.key, Math.fround(raw[field.key] as number)])) };
}
export function exportTuningFile(definition: DeviceDefinition, snapshot: OzoneSnapshot | null): string {
  if (!snapshot) throw new Error('没有本设备实际内存回读可导出');
  validateSnapshot(snapshot, definition);
  const file = { format: 'dmdebug-ozone-tuning', version: 1, deviceId: definition.id, kind: definition.kind, values: Object.fromEntries(snapshot.parameters.map(parameter => [parameter.key, parameter.value])) };
  return JSON.stringify(parseTuningFile(JSON.stringify(file), definition), null, 2);
}
