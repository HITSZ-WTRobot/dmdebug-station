// Byte contract: https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/doc/SERIAL_PROTOCOL.md v2. Logical IDs are not raw CAN IDs.
export const VERSION = 2;
export const FRAME_SIZE = 64;
export const BROADCAST = 0xff;
export const Opcode = {
  Heartbeat: 0x01, Info: 0x02, State: 0x10, Parameters: 0x11, Wheels: 0x12,
  Enable: 0x20, Disable: 0x21, Stop: 0x22, SetZero: 0x23, Move: 0x24,
  SetLimits: 0x25, BodyVelocity: 0x26, MotorVelocity: 0x28,
} as const;
export type DeviceKind = 'linear' | 'joint' | 'm2006' | 'chassis';
export interface DeviceDefinition {
  id: number; name: string; model: string; kind: DeviceKind; bus: 1 | 2 | 3;
  unit: 'mm' | 'deg' | 'rpm' | 'body'; wireKind: number; canLabel: string;
}
export const DEVICES: readonly DeviceDefinition[] = [
  { id: 0x0a, name: '右前伸缩', model: 'DM-S3519', kind: 'linear', bus: 1, unit: 'mm', wireKind: 1, canLabel: 'CAN 0A → 2A' },
  { id: 0x0b, name: '中伸缩', model: 'DM-S3519', kind: 'linear', bus: 1, unit: 'mm', wireKind: 1, canLabel: 'CAN 0B → 2B' },
  { id: 0x0c, name: '后伸缩', model: 'DM-S3519', kind: 'linear', bus: 1, unit: 'mm', wireKind: 1, canLabel: 'CAN 0C → 2C' },
  { id: 0x0d, name: '左前关节', model: 'DM-J4340P', kind: 'joint', bus: 1, unit: 'deg', wireKind: 2, canLabel: 'CAN 0D → 2D' },
  { id: 0x0e, name: '左前伸缩', model: 'DM-S3519', kind: 'linear', bus: 1, unit: 'mm', wireKind: 1, canLabel: 'CAN 0E → 2E' },
  { id: 0x0f, name: '右前关节', model: 'DM-J4340P', kind: 'joint', bus: 1, unit: 'deg', wireKind: 2, canLabel: 'CAN 0F → 2F' },
  { id: 0x21, name: 'M2006 · 1', model: 'M2006 / C610', kind: 'm2006', bus: 3, unit: 'rpm', wireKind: 5, canLabel: 'ID 1 → 201' },
  { id: 0x22, name: 'M2006 · 2', model: 'M2006 / C610', kind: 'm2006', bus: 3, unit: 'rpm', wireKind: 5, canLabel: 'ID 2 → 202' },
  { id: 0x40, name: '全向轮底盘', model: '4 × DM-S3519', kind: 'chassis', bus: 2, unit: 'body', wireKind: 4, canLabel: '0B / 0A / 09 / 0C' },
];
export const DEVICE_MAP = new Map(DEVICES.map(d => [d.id, d]));
export const WHEEL_IDS = [0x41, 0x42, 0x43, 0x44] as const;
export const WHEEL_NAMES = ['右前轮', '左前轮', '左后轮', '右后轮'] as const;
export const RESULT_NAMES: Record<number, string> = {
  0: '已受理', 1: '设备离线', 2: '尚未建立零点', 3: '未使能', 4: '设备忙 / 待确认',
  5: '参数无效', 6: '超出工作或协议边界', 7: '尚未静止稳定', 8: '设备故障',
  9: '轨迹规划失败', 10: '不支持的动作', 11: 'CAN 提交失败', 100: '协议版本不匹配',
  101: '报文方向错误', 102: '负载长度错误', 103: '保留位或填充错误', 104: '未知命令',
  105: '设备编号或命令不匹配', 106: '序号冲突', 107: '串口超时锁存',
};
export const OPCODE_NAMES: Record<number, string> = {
  1: '心跳', 2: '设备发现', 0x10: '状态', 0x11: '参数', 0x12: '四轮反馈',
  0x20: '使能', 0x21: '失能', 0x22: '停止 / 保持', 0x23: '设置软件零点',
  0x24: '绝对位置目标', 0x25: '应用运动约束', 0x26: '车体系速度', 0x28: '输出轴速度目标',
};
export const hexId = (id: number) => `0x${id.toString(16).toUpperCase().padStart(2, '0')}`;
export const resultName = (result: number) => RESULT_NAMES[result] ?? `未知结果 ${result}`;
export const bytesToHex = (data: Uint8Array) => Array.from(data, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export const BODY_LIMITS = { maxVx: 1, maxVy: 1, maxWz: 360, maxWheelRpm: 360, radiusMm: 63.5, distanceXmm: 435, distanceYmm: 435 } as const;
type BodyLimits = { [K in keyof typeof BODY_LIMITS]: number };
export function bodyVelocityWithinLimits(target: BodyVelocity, limits: BodyLimits | null | undefined = BODY_LIMITS): boolean {
  if (!limits || ![limits.maxVx, limits.maxVy, limits.maxWz, limits.maxWheelRpm, limits.radiusMm, limits.distanceXmm, limits.distanceYmm].every(n => Number.isFinite(n) && n > 0) ||
    ![target.vx, target.vy, target.wz].every(Number.isFinite)) return false;
  const speed = Math.hypot(target.vx, target.vy);
  const arm = Math.hypot(limits.distanceXmm, limits.distanceYmm) * 0.0005;
  return Math.abs(target.vx) <= Math.min(1, limits.maxVx) &&
    Math.abs(target.vy) <= Math.min(1, limits.maxVy) &&
    speed <= Math.min(1, limits.maxVx, limits.maxVy) + 1e-6 &&
    Math.abs(target.wz) <= Math.min(360, limits.maxWz) &&
    speed + arm * Math.abs(target.wz) * Math.PI / 180 <=
      Math.min(360, limits.maxWheelRpm) * 2 * Math.PI * limits.radiusMm * 0.001 / 60 + 1e-6;
}
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let value = i << 8;
  for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ ((value & 0x8000) ? 0x1021 : 0)) & 0xffff;
  CRC_TABLE[i] = value;
}
export function calcCrc16(bytes: Uint8Array, length = bytes.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 255]) & 0xffff;
  return crc;
}
export function encodeRequest(sequence: number, opcode: number, id: number, values: readonly number[] = []): Uint8Array {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535) throw new Error('请求序号无效');
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 255 || !Number.isInteger(id) || id < 0 || id > 255) throw new Error('报文编号无效');
  if (values.length > 12 || values.some(v => !Number.isFinite(v))) throw new Error('请求必须包含有限数值');
  const frame = new Uint8Array(64), view = new DataView(frame.buffer);
  frame.set([0xa5, 0x5a, VERSION, 0]); view.setUint16(4, sequence, true); frame[6] = opcode; frame[7] = id;
  view.setUint16(8, values.length * 4, true);
  values.forEach((v, i) => { view.setFloat32(12 + 4 * i, v, true); if (!Number.isFinite(view.getFloat32(12 + 4 * i, true))) throw new Error('数值超出 float32 范围'); });
  view.setUint16(62, calcCrc16(frame, 62), true);
  return frame;
}
export function expectedResponseIds(opcode: number, id: number): number[] {
  if (id === BROADCAST && (opcode === Opcode.State || opcode === Opcode.Disable || opcode === Opcode.Stop)) return DEVICES.map(d => d.id);
  if (opcode === Opcode.Wheels && id === 0x40) return [...WHEEL_IDS];
  return [id];
}
export interface Flags {
  connected: boolean; zeroed: boolean; limitsConfigured: boolean; enabled: boolean;
  enablePending: boolean; busy: boolean; motionComplete: boolean; fault: boolean; hostLinkTimeout: boolean;
}
export function decodeFlags(bits: number): Flags {
  return { connected: !!(bits & 1), zeroed: !!(bits & 2), limitsConfigured: !!(bits & 4), enabled: !!(bits & 8),
    enablePending: !!(bits & 16), busy: !!(bits & 32), motionComplete: !!(bits & 64), fault: !!(bits & 128), hostLinkTimeout: !!(bits & 256) };
}
export interface BaseResponse { sequence: number; opcode: number; id: number; result: number; raw: Uint8Array }
export interface Ack extends BaseResponse { type: 'ack' }
export interface Heartbeat extends BaseResponse { type: 'heartbeat'; uptimeMs: number; linkTimeout: boolean }
export interface Info extends BaseResponse {
  type: 'info'; uptimeMs: number; linkTimeout: boolean; timeoutMs: number; deviceIds: number[]; kinds: number[];
  trajectoryHz: number; positionHz: number; velocityHz: number; chassisHz: number; baudRate: number;
}
export interface MotorState extends BaseResponse {
  type: 'motor-state'; kind: 'linear' | 'joint' | 'm2006'; unit: 'mm' | 'deg' | 'rpm'; bus: number; flags: Flags;
  lastResult: number; motorState: number | null; feedbackCount: number;
  position: number; velocity: number; target: number; reference: number | null; referenceVelocity: number | null;
  torque: number | null; torqueFeedforward: number | null; pendingCommand: number | null;
}
export interface BodyVelocity { vx: number; vy: number; wz: number }
export interface ChassisState extends BaseResponse {
  type: 'chassis-state'; kind: 'chassis'; flags: Flags; lastResult: number;
  velocity: BodyVelocity; target: BodyVelocity; onlineMask: number; enabledMask: number; faultMask: number;
}
export interface WheelState extends BaseResponse {
  type: 'wheel-state'; connected: boolean; canId: number; masterId: number; motorState: number;
  position: number; velocityRpm: number; torque: number;
}
export interface DmParameters extends BaseResponse {
  type: 'dm-parameters'; configured: boolean; bounded: boolean; kind: 'linear' | 'joint'; unit: 'mm' | 'deg';
  min: number | null; max: number | null; maxVelocity: number; maxAcceleration: number; maxJerk: number;
  kp: number; kd: number; torqueFeedforward: number; finish: number; stationaryRpm: number;
}
export interface DjiParameters extends BaseResponse {
  type: 'dji-parameters'; velocityPid: { kp: number; ki: number; kd: number; outputMax: number };
  maxRpm: number; stationaryRpm: number;
}
export interface ChassisParameters extends BaseResponse {
  type: 'chassis-parameters'; maxVx: number; maxVy: number; maxWz: number; maxWheelRpm: number;
  radiusMm: number; distanceXmm: number; distanceYmm: number;
}
export type DeviceState = MotorState | ChassisState;
export type DeviceParameters = DmParameters | DjiParameters | ChassisParameters;
export type Response = Ack | Heartbeat | Info | DeviceState | WheelState | DeviceParameters;
export interface ProtocolIssue { kind: 'crc' | 'version' | 'structure'; message: string }

export function decodeFrame(frame: Uint8Array): Response {
  if (frame.length !== 64 || frame[0] !== 0xa5 || frame[1] !== 0x5a) throw new Error('不是完整的64字节帧');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint16(62, true) !== calcCrc16(frame, 62)) throw new Error('CRC校验失败');
  if (frame[2] !== VERSION) throw new Error(`固件报文版本 ${frame[2]}，本程序要求 v2`);
  const length = view.getUint16(8, true);
  if (frame[3] !== 1 || length < 2 || length > 50 || view.getUint16(10, true) !== 0 || frame.subarray(12 + length, 62).some(v => v !== 0)) throw new Error('应答方向、长度或填充无效');
  const base: BaseResponse = { sequence: view.getUint16(4, true), opcode: frame[6], id: frame[7], result: view.getUint16(12, true), raw: frame.slice() };
  if (base.result !== 0) { if (length !== 2) throw new Error('错误应答长度必须为2'); return { ...base, type: 'ack' }; }
  const u16 = (p: number) => view.getUint16(12 + p, true);
  const f32 = (p: number) => { const value = view.getFloat32(12 + p, true); if (!Number.isFinite(value)) throw new Error(`P${p}不是有限数值`); return value; };
  const exact = (n: number) => { if (length !== n) throw new Error(`应答长度${length}，要求${n}`); };
  const definition = DEVICE_MAP.get(base.id);
  const flags = () => decodeFlags(u16(2));
  if (base.opcode === Opcode.Heartbeat) { exact(8); if (base.id !== 255) throw new Error('心跳设备编号错误'); return { ...base, type: 'heartbeat', uptimeMs: view.getUint32(16, true), linkTimeout: !!(u16(2) & 2) }; }
  if (base.opcode === Opcode.Info) {
    exact(42); if (base.id !== 255 || frame[22] !== 9 || frame[23] !== 2) throw new Error('固件设备清单或协议版本不兼容');
    const deviceIds = Array.from(frame.subarray(24, 33)), kinds = Array.from(frame.subarray(33, 42));
    if (deviceIds.some((id, i) => id !== DEVICES[i].id || kinds[i] !== DEVICES[i].wireKind)) throw new Error('固件设备映射与v2规范不匹配');
    return { ...base, type: 'info', uptimeMs: view.getUint32(16, true), linkTimeout: !!(u16(2) & 2), timeoutMs: u16(8), deviceIds, kinds,
      trajectoryHz: u16(30), positionHz: u16(32), velocityHz: u16(34), chassisHz: u16(36), baudRate: view.getUint32(50, true) };
  }
  if (base.opcode === Opcode.Wheels) {
    exact(20); if (!(WHEEL_IDS as readonly number[]).includes(base.id)) throw new Error('四轮反馈编号错误');
    return { ...base, type: 'wheel-state', connected: !!(u16(2) & 1), canId: frame[16], masterId: frame[17], motorState: u16(6), position: f32(8), velocityRpm: f32(12), torque: f32(16) };
  }
  if (!definition) throw new Error(`未知逻辑设备${hexId(base.id)}`);
  if (base.opcode === Opcode.State) {
    if (frame[16] !== definition.wireKind || frame[17] !== (definition.unit === 'mm' ? 2 : definition.unit === 'deg' ? 1 : definition.unit === 'rpm' ? 4 : 3) || frame[18] !== definition.bus || frame[19] !== 0) throw new Error('状态类型、单位或总线不匹配');
    if (definition.kind === 'chassis') {
      exact(44); return { ...base, type: 'chassis-state', kind: 'chassis', flags: flags(), lastResult: u16(8),
        velocity: { vx: f32(16), vy: f32(20), wz: f32(24) }, target: { vx: f32(28), vy: f32(32), wz: f32(36) }, onlineMask: frame[52], enabledMask: frame[53], faultMask: frame[54] };
    }
    exact(definition.kind === 'm2006' ? 32 : 48);
    return { ...base, type: 'motor-state', kind: definition.kind, unit: definition.unit as MotorState['unit'], bus: definition.bus, flags: flags(), lastResult: u16(8),
      motorState: definition.kind === 'm2006' ? null : u16(10), feedbackCount: view.getUint32(24, true), position: f32(16), velocity: f32(20), target: f32(24),
      reference: definition.kind === 'm2006' ? null : f32(28), referenceVelocity: definition.kind === 'm2006' ? f32(28) : f32(32),
      torque: definition.kind === 'm2006' ? null : f32(36), torqueFeedforward: definition.kind === 'm2006' ? null : f32(40), pendingCommand: definition.kind === 'm2006' ? null : u16(44) };
  }
  if (base.opcode === Opcode.Parameters) {
    if (definition.kind === 'm2006') {
      exact(26); return { ...base, type: 'dji-parameters', velocityPid: { kp: f32(2), ki: f32(6), kd: f32(10), outputMax: f32(14) },
        maxRpm: f32(18), stationaryRpm: f32(22) };
    }
    if (definition.kind === 'chassis') { exact(30); return { ...base, type: 'chassis-parameters', maxVx: f32(2), maxVy: f32(6), maxWz: f32(10), maxWheelRpm: f32(14), radiusMm: f32(18), distanceXmm: f32(22), distanceYmm: f32(26) }; }
    exact(48); if (frame[16] !== definition.wireKind || frame[17] !== (definition.kind === 'linear' ? 2 : 1) || frame[18] !== 1) throw new Error('DM参数类型或单位错误');
    if (definition.kind === 'linear' && (!Number.isNaN(view.getFloat32(20, true)) || !Number.isNaN(view.getFloat32(24, true)))) throw new Error('伸缩行程区间应标记为未配置');
    return { ...base, type: 'dm-parameters', kind: definition.kind, unit: definition.unit as 'mm' | 'deg', configured: !!(u16(2) & 1), bounded: !!(u16(2) & 2),
      min: definition.kind === 'linear' ? null : f32(8), max: definition.kind === 'linear' ? null : f32(12), maxVelocity: f32(16), maxAcceleration: f32(20), maxJerk: f32(24),
      kp: f32(28), kd: f32(32), torqueFeedforward: f32(36), finish: f32(40), stationaryRpm: f32(44) };
  }
  exact(2); return { ...base, type: 'ack' };
}
export class StreamUnpacker {
  private pending: number[] = [];
  constructor(private onIssue?: (issue: ProtocolIssue) => void) {}
  reset() { this.pending = []; }
  feed(chunk: Uint8Array): Response[] {
    this.pending.push(...chunk); const frames: Response[] = []; let position = 0;
    while (position + 1 < this.pending.length) {
      if (this.pending[position] !== 0xa5 || this.pending[position + 1] !== 0x5a) { position++; continue; }
      if (this.pending.length - position < 64) break;
      const raw = Uint8Array.from(this.pending.slice(position, position + 64));
      if (new DataView(raw.buffer).getUint16(62, true) !== calcCrc16(raw, 62)) { this.onIssue?.({ kind: 'crc', message: 'CRC错误，逐字节重新同步' }); position++; continue; }
      position += 64;
      try { frames.push(decodeFrame(raw)); } catch (error) { this.onIssue?.({ kind: raw[2] !== VERSION ? 'version' : 'structure', message: error instanceof Error ? error.message : String(error) }); }
    }
    this.pending = this.pending.slice(position);
    if (this.pending.length === 1 && this.pending[0] !== 0xa5) this.pending = [];
    return frames;
  }
}
