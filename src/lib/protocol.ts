/**
 * @file protocol.ts
 * @brief STM32 六轴达妙电机串口二进制协议 (64字节定长帧, CRC-16/CCITT-FALSE)
 * @details 对应下位机 SERIAL_PROTOCOL.md 规范 (USART1 115200 8N1)
 */

export const HEADER_0 = 0xa5;
export const HEADER_1 = 0x5a;
export const VERSION = 0x01;
export const FRAME_SIZE = 64;
export const TYPE_REQUEST = 0x00;
export const TYPE_RESPONSE = 0x01;
export const BROADCAST_MOTOR_ID = 0xff;

export const Opcode = {
  Heartbeat: 0x01,
  Info: 0x02,
  State: 0x10,
  Parameters: 0x11,
  Enable: 0x20,
  Disable: 0x21,
  Stop: 0x22,
  SetZero: 0x23,
  Move: 0x24,
  SetLimits: 0x25,
} as const;

export type OpcodeType = (typeof Opcode)[keyof typeof Opcode];

export const OpcodeNames: Record<number, string> = {
  0x01: 'Heartbeat (心跳)',
  0x02: 'Info (系统信息)',
  0x10: 'State (状态查询)',
  0x11: 'Parameters (参数查询)',
  0x20: 'Enable (电机使能)',
  0x21: 'Disable (电机失能)',
  0x22: 'Stop (轨迹停止)',
  0x23: 'SetZero (软件归零)',
  0x24: 'Move (位置运动)',
  0x25: 'SetLimits (设置限位与动力学)',
};

export const ResultCode = {
  Ok: 0,
  Offline: 1,
  NotZeroed: 2,
  NotEnabled: 3,
  Busy: 4,
  InvalidParameters: 5,
  OutsideLimits: 6,
  NotStationary: 7,
  MotorFault: 8,
  PlanningFailed: 9,
  InvalidCommand: 10,
  TransmitFailed: 11,
  BadVersion: 100,
  BadType: 101,
  BadLength: 102,
  BadPadding: 103,
  UnknownOpcode: 104,
  UnknownMotor: 105,
  SequenceConflict: 106,
  LinkFault: 107,
} as const;

export type ResultCodeType = (typeof ResultCode)[keyof typeof ResultCode];

export const ResultNames: Record<number, string> = {
  0: 'Ok (受理/成功)',
  1: 'Offline (电机未连接)',
  2: 'NotZeroed (尚未建立软件零点)',
  3: 'NotEnabled (未使能)',
  4: 'Busy (运行忙/待处理命令中)',
  5: 'InvalidParameters (限值或控制参数非法)',
  6: 'OutsideLimits (超出工作限位或编码范围)',
  7: 'NotStationary (未满足静止稳定条件)',
  8: 'MotorFault (电机状态故障/使能确认超时)',
  9: 'PlanningFailed (S曲线轨迹求解失败)',
  10: 'InvalidCommand (设备层无效命令)',
  11: 'TransmitFailed (CAN硬件发送失败)',
  100: 'BadVersion (协议版本错误)',
  101: 'BadType (请求类型错误)',
  102: 'BadLength (Payload长度越界)',
  103: 'BadPadding (保留位或填充非零)',
  104: 'UnknownOpcode (未知Opcode)',
  105: 'UnknownMotor (未知电机CAN ID)',
  106: 'SequenceConflict (同序号请求内容冲突)',
  107: 'LinkFault (串口超时锁存未握手)',
};

export const MotorStateNames: Record<number, string> = {
  0: 'Disabled (已失能)',
  1: 'Enabled (已使能)',
  8: 'OverVoltage (过压)',
  9: 'UnderVoltage (欠压)',
  10: 'OverCurrent (过流)',
  11: 'MosOverheating (驱动MOS过热)',
  12: 'MotorCoilOverheating (电机线圈过热)',
  13: 'Disconnected (失联)',
  14: 'Overload (过载)',
};

export const OzoneCommandNames: Record<number, string> = {
  0: '无待处理',
  1: 'SetZero',
  2: 'Enable',
  3: 'Disable',
  4: 'Move',
  5: 'Stop',
  6: 'ApplyLimits',
};

export interface MotorConfig {
  index: number;
  name: string;
  model: string;
  canId: number;
  masterId: number;
  initialMinDeg: number;
  initialMaxDeg: number;
}

export const MOTORS: MotorConfig[] = [
  { index: 0, name: '右前伸缩', model: 'DM-S3519', canId: 0x0a, masterId: 0x2a, initialMinDeg: -30, initialMaxDeg: 30 },
  { index: 1, name: '中伸缩',   model: 'DM-S3519', canId: 0x0b, masterId: 0x2b, initialMinDeg: -30, initialMaxDeg: 30 },
  { index: 2, name: '后伸缩',   model: 'DM-S3519', canId: 0x0c, masterId: 0x2c, initialMinDeg: -30, initialMaxDeg: 30 },
  { index: 3, name: '左前旋转', model: 'DM-J4340P', canId: 0x0d, masterId: 0x2d, initialMinDeg: -180, initialMaxDeg: 180 },
  { index: 4, name: '左前伸缩', model: 'DM-S3519', canId: 0x0e, masterId: 0x2e, initialMinDeg: -30, initialMaxDeg: 30 },
  { index: 5, name: '右前旋转', model: 'DM-J4340P', canId: 0x0f, masterId: 0x2f, initialMinDeg: -180, initialMaxDeg: 180 },
];

export const MOTOR_MAP = new Map<number, MotorConfig>(
  MOTORS.map((m) => [m.canId, m])
);

// CRC-16/CCITT-FALSE (poly=0x1021, init=0xFFFF, refin=false, refout=false, xorout=0x0000)
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let curr = (i << 8) & 0xffff;
  for (let j = 0; j < 8; j++) {
    if ((curr & 0x8000) !== 0) {
      curr = ((curr << 1) ^ 0x1021) & 0xffff;
    } else {
      curr = (curr << 1) & 0xffff;
    }
  }
  CRC_TABLE[i] = curr;
}

export function calcCrc16(buffer: Uint8Array, length = buffer.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ buffer[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

export function bytesToHex(arr: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
  }
  return hex.trim();
}

/**
 * 构造固定 64 字节请求帧 (Little-Endian)
 */
export function encodeFrame(
  sequence: number,
  opcode: number,
  motor: number,
  payload: Uint8Array = new Uint8Array(0)
): Uint8Array {
  if (sequence < 0 || sequence > 0xffff) {
    throw new Error(`Invalid sequence: ${sequence}`);
  }
  if (payload.length > 50) {
    throw new Error(`Payload length ${payload.length} exceeds max 50 bytes`);
  }

  const frame = new Uint8Array(FRAME_SIZE);
  const view = new DataView(frame.buffer);

  frame[0] = HEADER_0;
  frame[1] = HEADER_1;
  frame[2] = VERSION;
  frame[3] = TYPE_REQUEST;
  view.setUint16(4, sequence & 0xffff, true);
  frame[6] = opcode & 0xff;
  frame[7] = motor & 0xff;
  view.setUint16(8, payload.length, true);
  view.setUint16(10, 0, true); // reserved must be 0

  if (payload.length > 0) {
    frame.set(payload, 12);
  }

  // 计算 CRC-16 (覆盖 0..61 字节)
  const crc = calcCrc16(frame, 62);
  view.setUint16(62, crc, true);

  return frame;
}

export function encodeHeartbeat(seq: number): Uint8Array {
  return encodeFrame(seq, Opcode.Heartbeat, BROADCAST_MOTOR_ID);
}

export function encodeInfo(seq: number): Uint8Array {
  return encodeFrame(seq, Opcode.Info, BROADCAST_MOTOR_ID);
}

export function encodeState(seq: number, motor: number = BROADCAST_MOTOR_ID): Uint8Array {
  return encodeFrame(seq, Opcode.State, motor);
}

export function encodeParameters(seq: number, motor: number): Uint8Array {
  return encodeFrame(seq, Opcode.Parameters, motor);
}

export function encodeEnable(seq: number, motor: number): Uint8Array {
  return encodeFrame(seq, Opcode.Enable, motor);
}

export function encodeDisable(seq: number, motor: number = BROADCAST_MOTOR_ID): Uint8Array {
  return encodeFrame(seq, Opcode.Disable, motor);
}

export function encodeStop(seq: number, motor: number = BROADCAST_MOTOR_ID): Uint8Array {
  return encodeFrame(seq, Opcode.Stop, motor);
}

export function encodeSetZero(seq: number, motor: number): Uint8Array {
  return encodeFrame(seq, Opcode.SetZero, motor);
}

export function encodeMove(seq: number, motor: number, targetDeg: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setFloat32(0, targetDeg, true);
  return encodeFrame(seq, Opcode.Move, motor, payload);
}

export interface LimitsConfig {
  minDeg: number;
  maxDeg: number;
  maxVelocityDegS: number;
  maxAccelerationDegS2: number;
  maxJerkDegS3: number;
}

export function encodeSetLimits(seq: number, motor: number, limits: LimitsConfig): Uint8Array {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setFloat32(0, limits.minDeg, true);
  view.setFloat32(4, limits.maxDeg, true);
  view.setFloat32(8, limits.maxVelocityDegS, true);
  view.setFloat32(12, limits.maxAccelerationDegS2, true);
  view.setFloat32(16, limits.maxJerkDegS3, true);
  return encodeFrame(seq, Opcode.SetLimits, motor, payload);
}

// ================= 解码数据结构 =================

export interface BaseDecodedFrame {
  sequence: number;
  opcode: number;
  motor: number;
  payloadLength: number;
  result: number;
  raw: Uint8Array;
}

export interface HeartbeatPayload extends BaseDecodedFrame {
  opcode: typeof Opcode.Heartbeat;
  linkFlags: {
    seenValidRequest: boolean;
    hostLinkTimeout: boolean;
    raw: number;
  };
  uptimeMs: number;
}

export interface InfoPayload extends BaseDecodedFrame {
  opcode: typeof Opcode.Info;
  linkFlags: {
    seenValidRequest: boolean;
    hostLinkTimeout: boolean;
    raw: number;
  };
  uptimeMs: number;
  hostTimeoutMs: number;
  trajectoryHz: number;
  nominalPerMotorTxHz: number;
  groupedTxTickHz: number;
  feedbackCheckHz: number;
  motorCount: number;
  canFormat: number;
  canIds: number[];
  masterIds: number[];
}

export interface StatePayload extends BaseDecodedFrame {
  opcode: typeof Opcode.State;
  flags: {
    connected: boolean;
    zeroed: boolean;
    limitsConfigured: boolean;
    enabled: boolean;
    enablePending: boolean;
    busy: boolean;
    motionComplete: boolean;
    fault: boolean;
    hostLinkTimeout: boolean;
    raw: number;
  };
  motorState: number;
  feedbackCount: number;
  positionDeg: number;
  velocityRpm: number;
  torqueNm: number;
  acceptedTargetDeg: number;
  referenceDeg: number;
  referenceVelocityDegS: number;
  commandedTorqueFfNm: number;
  lastDeviceResult: number;
  pendingOzoneCommand: number;
}

export interface ParametersPayload extends BaseDecodedFrame {
  opcode: typeof Opcode.Parameters;
  flags: {
    limitsConfigured: boolean;
    raw: number;
  };
  minDeg: number;
  maxDeg: number;
  maxVelocityDegS: number;
  maxAccelerationDegS2: number;
  maxJerkDegS3: number;
  kp: number;
  kd: number;
  torqueFfNm: number;
  finishDeg: number;
  stationaryRpm: number;
}

export interface ActionPayload extends BaseDecodedFrame {
  opcode:
    | typeof Opcode.Enable
    | typeof Opcode.Disable
    | typeof Opcode.Stop
    | typeof Opcode.SetZero
    | typeof Opcode.Move
    | typeof Opcode.SetLimits;
}

export type DecodedResponse =
  | HeartbeatPayload
  | InfoPayload
  | StatePayload
  | ParametersPayload
  | ActionPayload
  | BaseDecodedFrame;

/**
 * 解析单帧 64 字节应答报文
 */
export function decodeFrame(frame: Uint8Array): DecodedResponse | null {
  if (frame.length !== FRAME_SIZE) return null;
  if (frame[0] !== HEADER_0 || frame[1] !== HEADER_1) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = frame[2];
  const type = frame[3];
  const sequence = view.getUint16(4, true);
  const opcode = frame[6];
  const motor = frame[7];
  const payloadLength = view.getUint16(8, true);
  const reserved = view.getUint16(10, true);
  const receivedCrc = view.getUint16(62, true);

  // 1. 验证 CRC
  const calculatedCrc = calcCrc16(frame, 62);
  if (receivedCrc !== calculatedCrc) {
    return null;
  }

  // 2. 验证协议结构
  if (version !== VERSION || type !== TYPE_RESPONSE) return null;
  if (payloadLength < 2 || payloadLength > 50) return null;
  if (reserved !== 0) return null;

  // 3. 验证未使用的尾部全部为零
  for (let i = 12 + payloadLength; i < 62; i++) {
    if (frame[i] !== 0) return null;
  }

  // 4. 解析结果码
  const result = view.getUint16(12, true);
  const base: BaseDecodedFrame = {
    sequence,
    opcode,
    motor,
    payloadLength,
    result,
    raw: frame,
  };

  // 如果下位机返回错误码，payload 长度为 2
  if (result !== ResultCode.Ok || payloadLength === 2) {
    return base;
  }

  // 5. 根据 Opcode 解码详细负载
  const pOffset = 12;

  switch (opcode) {
    case Opcode.Heartbeat: {
      if (payloadLength < 8) return base;
      const rawFlags = view.getUint16(pOffset + 2, true);
      const uptimeMs = view.getUint32(pOffset + 4, true);
      const hb: HeartbeatPayload = {
        ...base,
        opcode: Opcode.Heartbeat,
        linkFlags: {
          seenValidRequest: (rawFlags & 0x01) !== 0,
          hostLinkTimeout: (rawFlags & 0x02) !== 0,
          raw: rawFlags,
        },
        uptimeMs,
      };
      return hb;
    }

    case Opcode.Info: {
      if (payloadLength < 32) return base;
      const rawFlags = view.getUint16(pOffset + 2, true);
      const uptimeMs = view.getUint32(pOffset + 4, true);
      const hostTimeoutMs = view.getUint16(pOffset + 8, true);
      const trajectoryHz = view.getUint16(pOffset + 10, true);
      const nominalPerMotorTxHz = view.getUint16(pOffset + 12, true);
      const groupedTxTickHz = view.getUint16(pOffset + 14, true);
      const feedbackCheckHz = view.getUint16(pOffset + 16, true);
      const motorCount = frame[pOffset + 18];
      const canFormat = frame[pOffset + 19];
      const canIds: number[] = [];
      for (let i = 0; i < 6; i++) canIds.push(frame[pOffset + 20 + i]);
      const masterIds: number[] = [];
      for (let i = 0; i < 6; i++) masterIds.push(frame[pOffset + 26 + i]);

      const info: InfoPayload = {
        ...base,
        opcode: Opcode.Info,
        linkFlags: {
          seenValidRequest: (rawFlags & 0x01) !== 0,
          hostLinkTimeout: (rawFlags & 0x02) !== 0,
          raw: rawFlags,
        },
        uptimeMs,
        hostTimeoutMs,
        trajectoryHz,
        nominalPerMotorTxHz,
        groupedTxTickHz,
        feedbackCheckHz,
        motorCount,
        canFormat,
        canIds,
        masterIds,
      };
      return info;
    }

    case Opcode.State: {
      if (payloadLength < 44) return base;
      const rawFlags = view.getUint16(pOffset + 2, true);
      const motorState = view.getUint32(pOffset + 4, true);
      const feedbackCount = view.getUint32(pOffset + 8, true);
      const positionDeg = view.getFloat32(pOffset + 12, true);
      const velocityRpm = view.getFloat32(pOffset + 16, true);
      const torqueNm = view.getFloat32(pOffset + 20, true);
      const acceptedTargetDeg = view.getFloat32(pOffset + 24, true);
      const referenceDeg = view.getFloat32(pOffset + 28, true);
      const referenceVelocityDegS = view.getFloat32(pOffset + 32, true);
      const commandedTorqueFfNm = view.getFloat32(pOffset + 36, true);
      const lastDeviceResult = view.getUint16(pOffset + 40, true);
      const pendingOzoneCommand = view.getUint16(pOffset + 42, true);

      const st: StatePayload = {
        ...base,
        opcode: Opcode.State,
        flags: {
          connected: (rawFlags & (1 << 0)) !== 0,
          zeroed: (rawFlags & (1 << 1)) !== 0,
          limitsConfigured: (rawFlags & (1 << 2)) !== 0,
          enabled: (rawFlags & (1 << 3)) !== 0,
          enablePending: (rawFlags & (1 << 4)) !== 0,
          busy: (rawFlags & (1 << 5)) !== 0,
          motionComplete: (rawFlags & (1 << 6)) !== 0,
          fault: (rawFlags & (1 << 7)) !== 0,
          hostLinkTimeout: (rawFlags & (1 << 8)) !== 0,
          raw: rawFlags,
        },
        motorState,
        feedbackCount,
        positionDeg,
        velocityRpm,
        torqueNm,
        acceptedTargetDeg,
        referenceDeg,
        referenceVelocityDegS,
        commandedTorqueFfNm,
        lastDeviceResult,
        pendingOzoneCommand,
      };
      return st;
    }

    case Opcode.Parameters: {
      if (payloadLength < 44) return base;
      const rawFlags = view.getUint16(pOffset + 2, true);
      const minDeg = view.getFloat32(pOffset + 4, true);
      const maxDeg = view.getFloat32(pOffset + 8, true);
      const maxVelocityDegS = view.getFloat32(pOffset + 12, true);
      const maxAccelerationDegS2 = view.getFloat32(pOffset + 16, true);
      const maxJerkDegS3 = view.getFloat32(pOffset + 20, true);
      const kp = view.getFloat32(pOffset + 24, true);
      const kd = view.getFloat32(pOffset + 28, true);
      const torqueFfNm = view.getFloat32(pOffset + 32, true);
      const finishDeg = view.getFloat32(pOffset + 36, true);
      const stationaryRpm = view.getFloat32(pOffset + 40, true);

      const params: ParametersPayload = {
        ...base,
        opcode: Opcode.Parameters,
        flags: {
          limitsConfigured: (rawFlags & 0x01) !== 0,
          raw: rawFlags,
        },
        minDeg,
        maxDeg,
        maxVelocityDegS,
        maxAccelerationDegS2,
        maxJerkDegS3,
        kp,
        kd,
        torqueFfNm,
        finishDeg,
        stationaryRpm,
      };
      return params;
    }

    default:
      return base;
  }
}

/**
 * 流式解包器 (StreamUnpacker)
 * 严格按照 SERIAL_PROTOCOL.md：
 * 累积字节 -> 寻找 A5 5A -> 凑齐 64B 校验 CRC -> CRC 错误丢一字节继续同步
 */
export class StreamUnpacker {
  private buffer: Uint8Array = new Uint8Array(4096);
  private size: number = 0;

  public feed(chunk: Uint8Array): DecodedResponse[] {
    // 确保缓冲区容量
    if (this.size + chunk.length > this.buffer.length) {
      const newCapacity = Math.max(this.buffer.length * 2, this.size + chunk.length + 1024);
      const nextBuf = new Uint8Array(newCapacity);
      nextBuf.set(this.buffer.subarray(0, this.size), 0);
      this.buffer = nextBuf;
    }

    this.buffer.set(chunk, this.size);
    this.size += chunk.length;

    const frames: DecodedResponse[] = [];

    while (true) {
      // 1. 寻找帧头 A5 5A
      let headIdx = -1;
      for (let i = 0; i < this.size - 1; i++) {
        if (this.buffer[i] === HEADER_0 && this.buffer[i + 1] === HEADER_1) {
          headIdx = i;
          break;
        }
      }

      if (headIdx < 0) {
        // 未找到完整头，保留最后一个字节如果是 A5
        if (this.size > 0 && this.buffer[this.size - 1] === HEADER_0) {
          this.buffer[0] = HEADER_0;
          this.size = 1;
        } else {
          this.size = 0;
        }
        break;
      }

      // 丢弃头之前的垃圾数据
      if (headIdx > 0) {
        this.buffer.copyWithin(0, headIdx, this.size);
        this.size -= headIdx;
      }

      // 凑齐 64B 再验 CRC
      if (this.size < FRAME_SIZE) {
        break;
      }

      // 提取前 64 字节候选帧
      const candidate = this.buffer.subarray(0, FRAME_SIZE);
      const view = new DataView(candidate.buffer, candidate.byteOffset, candidate.byteLength);
      const rxCrc = view.getUint16(62, true);
      const expCrc = calcCrc16(candidate, 62);

      if (rxCrc !== expCrc) {
        // CRC 错误：按协议丢一个字节继续同步，绝不可直接丢弃整帧
        this.buffer.copyWithin(0, 1, this.size);
        this.size -= 1;
        continue;
      }

      // CRC 校验通过，解码帧
      const decoded = decodeFrame(new Uint8Array(candidate));
      if (decoded) {
        frames.push(decoded);
      }

      // 消费 64 字节
      this.buffer.copyWithin(0, FRAME_SIZE, this.size);
      this.size -= FRAME_SIZE;
    }

    return frames;
  }

  public reset() {
    this.size = 0;
  }
}
