/**
 * @file transport.ts
 * @brief 三端通信传输引擎与高保真六电机仿真器 (Tauri 2.0 Rust Serial + Web Serial + 仿真机)
 * @details 严格执行 SERIAL_PROTOCOL.md：单请求在途停等调度、心跳看门狗、64B定长CRC校验
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  HEADER_0,
  HEADER_1,
  VERSION,
  FRAME_SIZE,
  TYPE_REQUEST,
  TYPE_RESPONSE,
  BROADCAST_MOTOR_ID,
  Opcode,
  OpcodeNames,
  ResultCode,
  ResultNames,
  MOTORS,
  MOTOR_MAP,
  calcCrc16,
  bytesToHex,
  encodeFrame,
  StreamUnpacker,
  decodeFrame,
  type DecodedResponse,
  type StatePayload,
  type ParametersPayload,
  type LimitsConfig,
} from './protocol';
import type { LogLevel, SerialPortInfo, PlatformInfo } from '../store/atoms';

interface WebSerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

interface NavigatorWithSerial {
  serial?: {
    requestPort(): Promise<WebSerialPort>;
  };
}
type TimerHandle = number;


export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export async function getPlatformInfo(): Promise<PlatformInfo> {
  const isTauri = isTauriEnvironment();
  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

  if (isTauri) {
    try {
      const res = await invoke<{ os: string; arch: string }>('get_platform_info');
      return {
        isTauri: true,
        os: res.os || 'desktop',
        arch: res.arch || 'x64',
        hasWebSerial,
      };
    } catch {
      return { isTauri: true, os: 'desktop', arch: 'unknown', hasWebSerial };
    }
  }

  return {
    isTauri: false,
    os: 'browser',
    arch: 'wasm',
    hasWebSerial,
  };
}

export async function listNativeSerialPorts(): Promise<SerialPortInfo[]> {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke<SerialPortInfo[]>('list_serial_ports');
  } catch (err) {
    console.warn('Failed to list native serial ports:', err);
    return [];
  }
}

// ================= 高保真六电机仿真机 (Mock MCU Simulator) =================

interface MockMotorInternal {
  canId: number;
  masterId: number;
  name: string;
  connected: boolean;
  zeroed: boolean;
  limitsConfigured: boolean;
  enabled: boolean;
  enablePending: boolean;
  busy: boolean;
  motionComplete: boolean;
  fault: boolean;
  motorState: number; // 0=Disabled, 1=Enabled, 8..14=Faults
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
  // Limits & Tuning
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

class MockMcuSimulator {
  private motors: Map<number, MockMotorInternal> = new Map();
  private uptimeMs: number = 0;
  private lastValidReqTime: number = 0;
  private hostLinkTimeout: boolean = false;
  private hasSeenValidRequest: boolean = false;
  private simulationInterval: TimerHandle | null = null;

  // 最近一个有效请求与应答缓存 (SERIAL_PROTOCOL.md Section 4)
  private cachedRequestFrame: Uint8Array | null = null;
  private cachedResponses: Uint8Array[] = [];

  constructor(private onOutputBytes: (bytes: Uint8Array) => void) {
    this.resetMotors();
  }

  private resetMotors() {
    this.motors.clear();
    for (const m of MOTORS) {
      this.motors.set(m.canId, {
        canId: m.canId,
        masterId: m.masterId,
        name: m.name,
        connected: true,
        zeroed: true,
        limitsConfigured: true,
        enabled: false,
        enablePending: false,
        busy: false,
        motionComplete: true,
        fault: false,
        motorState: 0, // Disabled
        feedbackCount: 50,
        positionDeg: 0.0,
        velocityRpm: 0.0,
        torqueNm: 0.0,
        acceptedTargetDeg: 0.0,
        referenceDeg: 0.0,
        referenceVelocityDegS: 0.0,
        commandedTorqueFfNm: 0.0,
        lastDeviceResult: 0,
        pendingOzoneCommand: 0,
        minDeg: m.initialMinDeg,
        maxDeg: m.initialMaxDeg,
        maxVelocityDegS: 10,
        maxAccelerationDegS2: 20,
        maxJerkDegS3: 100,
        kp: 40.0,
        kd: 1.5,
        torqueFfNm: 0.0,
        finishDeg: 0.3,
        stationaryRpm: 1.0,
      });
    }
  }

  public start() {
    this.stop();
    this.lastValidReqTime = performance.now();
    this.simulationInterval = globalThis.setInterval(() => this.tick(), 20); // 50 Hz 物理仿真循环
  }

  public stop() {
    if (this.simulationInterval !== null) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
  }

  private tick() {
    const now = performance.now();
    this.uptimeMs += 20;

    // 1. 检查串口超时 (SERIAL_PROTOCOL.md Section 7: >= 500 ms 触发超时锁存)
    if (this.hasSeenValidRequest && !this.hostLinkTimeout) {
      if (now - this.lastValidReqTime >= 500) {
        this.hostLinkTimeout = true;
        // 超时时自动失能所有电机，锁存故障
        for (const motor of this.motors.values()) {
          motor.enabled = false;
          motor.busy = false;
          motor.motorState = 0;
          motor.fault = true;
          motor.lastDeviceResult = ResultCode.LinkFault;
        }
      }
    }

    // 2. 模拟每个电机的运动轨迹
    for (const motor of this.motors.values()) {
      motor.feedbackCount = (motor.feedbackCount + 1) & 0xffffffff;

      if (!motor.enabled || !motor.busy) {
        motor.velocityRpm = 0.0;
        motor.referenceVelocityDegS = 0.0;
        motor.torqueNm = 0.0;
        continue;
      }

      // S 曲线/匀变速逼近
      const posDiff = motor.acceptedTargetDeg - motor.positionDeg;
      const dist = Math.abs(posDiff);

      if (dist <= motor.finishDeg) {
        // 到位
        motor.positionDeg = motor.acceptedTargetDeg;
        motor.referenceDeg = motor.acceptedTargetDeg;
        motor.referenceVelocityDegS = 0.0;
        motor.velocityRpm = 0.0;
        motor.torqueNm = 0.05;
        motor.busy = false;
        motor.motionComplete = true;
      } else {
        const step = Math.sign(posDiff) * Math.min(dist, motor.maxVelocityDegS * 0.02);
        motor.positionDeg += step;
        motor.referenceDeg = motor.positionDeg;
        const velDegS = (step / 0.02);
        motor.referenceVelocityDegS = velDegS;
        motor.velocityRpm = velDegS / 6.0; // 360 deg/s = 60 rpm -> velDegS / 6
        motor.torqueNm = Math.sin(motor.positionDeg * (Math.PI / 180)) * 0.8 + 0.3;
        motor.motionComplete = false;
      }
    }
  }

  /**
   * 下位机接收并处理 64 字节帧
   */
  public handleInputBytes(chunk: Uint8Array) {
    if (chunk.length !== FRAME_SIZE) return;

    // 1. 验证帧头与 CRC
    if (chunk[0] !== HEADER_0 || chunk[1] !== HEADER_1) return;
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const rxCrc = view.getUint16(62, true);
    if (rxCrc !== calcCrc16(chunk, 62)) return;

    const version = chunk[2];
    const type = chunk[3];
    const sequence = view.getUint16(4, true);
    const opcode = chunk[6];
    const motorId = chunk[7];
    const payloadLength = view.getUint16(8, true);
    const reserved = view.getUint16(10, true);

    // 2. 协议合法性检查
    let errorCode: number = ResultCode.Ok;
    if (version !== VERSION) errorCode = ResultCode.BadVersion;
    else if (type !== TYPE_REQUEST) errorCode = ResultCode.BadType;
    else if (payloadLength > 50) errorCode = ResultCode.BadLength;
    else if (reserved !== 0) errorCode = ResultCode.BadPadding;
    else {
      for (let i = 12 + payloadLength; i < 62; i++) {
        if (chunk[i] !== 0) {
          errorCode = ResultCode.BadPadding;
          break;
        }
      }
    }

    if (errorCode !== ResultCode.Ok) {
      this.sendError(sequence, opcode, motorId, errorCode);
      return;
    }

    // 3. 检查缓存 (单请求缓存防重放与 SequenceConflict)
    if (this.cachedRequestFrame) {
      const cachedSeq = new DataView(
        this.cachedRequestFrame.buffer,
        this.cachedRequestFrame.byteOffset
      ).getUint16(4, true);

      if (cachedSeq === sequence) {
        let isIdentical = true;
        for (let i = 0; i < FRAME_SIZE; i++) {
          if (this.cachedRequestFrame[i] !== chunk[i]) {
            isIdentical = false;
            break;
          }
        }
        if (isIdentical) {
          // 重放原应答
          for (const resp of this.cachedResponses) {
            this.onOutputBytes(resp);
          }
          return;
        } else {
          // 同 sequence 内容不同，返回 106
          this.sendError(sequence, opcode, motorId, ResultCode.SequenceConflict);
          return;
        }
      }
    }

    // 4. 刷新看门狗时间 (非 SequenceConflict 的有效请求)
    this.lastValidReqTime = performance.now();
    this.hasSeenValidRequest = true;

    // 5. 执行具体命令并生成应答
    const generatedResponses: Uint8Array[] = [];

    switch (opcode) {
      case Opcode.Heartbeat: {
        // Heartbeat 只有未命中缓存的新请求才能解除已锁存的串口超时
        if (this.hostLinkTimeout) {
          this.hostLinkTimeout = false;
        }
        const resp = this.buildHeartbeatResponse(sequence);
        generatedResponses.push(resp);
        break;
      }

      case Opcode.Info: {
        const resp = this.buildInfoResponse(sequence);
        generatedResponses.push(resp);
        break;
      }

      case Opcode.State: {
        if (motorId === BROADCAST_MOTOR_ID) {
          for (const m of MOTORS) {
            generatedResponses.push(this.buildStateResponse(sequence, m.canId));
          }
        } else {
          generatedResponses.push(this.buildStateResponse(sequence, motorId));
        }
        break;
      }

      case Opcode.Parameters: {
        generatedResponses.push(this.buildParametersResponse(sequence, motorId));
        break;
      }

      case Opcode.Enable: {
        const result = this.executeEnable(motorId);
        generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, result));
        break;
      }

      case Opcode.Disable: {
        if (motorId === BROADCAST_MOTOR_ID) {
          for (const m of MOTORS) {
            const result = this.executeDisable(m.canId);
            generatedResponses.push(this.buildActionAck(sequence, opcode, m.canId, result));
          }
        } else {
          const result = this.executeDisable(motorId);
          generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, result));
        }
        break;
      }

      case Opcode.Stop: {
        if (motorId === BROADCAST_MOTOR_ID) {
          for (const m of MOTORS) {
            const result = this.executeStop(m.canId);
            generatedResponses.push(this.buildActionAck(sequence, opcode, m.canId, result));
          }
        } else {
          const result = this.executeStop(motorId);
          generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, result));
        }
        break;
      }

      case Opcode.SetZero: {
        const result = this.executeSetZero(motorId);
        generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, result));
        break;
      }

      case Opcode.Move: {
        const targetDeg = view.getFloat32(12, true);
        const result = this.executeMove(motorId, targetDeg);
        generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, result));
        break;
      }

      case Opcode.SetLimits: {
        const minDeg = view.getFloat32(12, true);
        const maxDeg = view.getFloat32(16, true);
        const maxVel = view.getFloat32(20, true);
        const maxAcc = view.getFloat32(24, true);
        const maxJerk = view.getFloat32(28, true);
        const result = this.executeSetLimits(motorId, {
          minDeg,
          maxDeg,
          maxVelocityDegS: maxVel,
          maxAccelerationDegS2: maxAcc,
          maxJerkDegS3: maxJerk,
        });
        generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, result));
        break;
      }

      default: {
        generatedResponses.push(this.buildActionAck(sequence, opcode, motorId, ResultCode.UnknownOpcode));
        break;
      }
    }

    // 缓存本次请求与应答
    this.cachedRequestFrame = new Uint8Array(chunk);
    this.cachedResponses = generatedResponses;

    // 发送应答
    for (const resp of generatedResponses) {
      this.onOutputBytes(resp);
    }
  }

  private executeEnable(motorId: number): number {
    const motor = this.motors.get(motorId);
    if (!motor) return ResultCode.UnknownMotor;
    if (this.hostLinkTimeout) return ResultCode.LinkFault;
    if (motor.busy) return ResultCode.Busy;

    motor.enabled = true;
    motor.motorState = 1; // Enabled
    motor.fault = false;
    motor.acceptedTargetDeg = motor.positionDeg;
    motor.referenceDeg = motor.positionDeg;
    motor.motionComplete = true;
    return ResultCode.Ok;
  }

  private executeDisable(motorId: number): number {
    const motor = this.motors.get(motorId);
    if (!motor) return ResultCode.UnknownMotor;
    motor.enabled = false;
    motor.motorState = 0;
    motor.busy = false;
    motor.velocityRpm = 0;
    motor.referenceVelocityDegS = 0;
    return ResultCode.Ok;
  }

  private executeStop(motorId: number): number {
    const motor = this.motors.get(motorId);
    if (!motor) return ResultCode.UnknownMotor;
    if (!motor.enabled) return ResultCode.NotEnabled;
    motor.busy = false;
    motor.acceptedTargetDeg = motor.positionDeg;
    motor.referenceDeg = motor.positionDeg;
    motor.velocityRpm = 0;
    motor.referenceVelocityDegS = 0;
    motor.motionComplete = true;
    return ResultCode.Ok;
  }

  private executeSetZero(motorId: number): number {
    const motor = this.motors.get(motorId);
    if (!motor) return ResultCode.UnknownMotor;
    if (motor.enabled) return ResultCode.Busy; // 要求失能
    const shift = motor.positionDeg;
    motor.positionDeg = 0.0;
    motor.acceptedTargetDeg = 0.0;
    motor.referenceDeg = 0.0;
    // 物理工作区平移
    motor.minDeg -= shift;
    motor.maxDeg -= shift;
    return ResultCode.Ok;
  }

  private executeMove(motorId: number, targetDeg: number): number {
    const motor = this.motors.get(motorId);
    if (!motor) return ResultCode.UnknownMotor;
    if (this.hostLinkTimeout) return ResultCode.LinkFault;
    if (!motor.enabled) return ResultCode.NotEnabled;
    if (motor.busy) return ResultCode.Busy;
    if (!Number.isFinite(targetDeg)) return ResultCode.OutsideLimits;
    if (targetDeg < motor.minDeg || targetDeg > motor.maxDeg) return ResultCode.OutsideLimits;

    motor.acceptedTargetDeg = targetDeg;
    motor.busy = true;
    motor.motionComplete = false;
    return ResultCode.Ok;
  }

  private executeSetLimits(motorId: number, limits: LimitsConfig): number {
    const motor = this.motors.get(motorId);
    if (!motor) return ResultCode.UnknownMotor;
    if (motor.enabled) return ResultCode.Busy; // 仅失能允许修改
    if (limits.minDeg >= limits.maxDeg) return ResultCode.InvalidParameters;
    if (limits.maxVelocityDegS <= 0 || limits.maxAccelerationDegS2 <= 0 || limits.maxJerkDegS3 <= 0) {
      return ResultCode.InvalidParameters;
    }
    motor.minDeg = limits.minDeg;
    motor.maxDeg = limits.maxDeg;
    motor.maxVelocityDegS = limits.maxVelocityDegS;
    motor.maxAccelerationDegS2 = limits.maxAccelerationDegS2;
    motor.maxJerkDegS3 = limits.maxJerkDegS3;
    motor.limitsConfigured = true;
    return ResultCode.Ok;
  }

  private buildHeartbeatResponse(sequence: number): Uint8Array {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint16(0, ResultCode.Ok, true);
    let linkFlags = 0;
    if (this.hasSeenValidRequest) linkFlags |= 0x01;
    if (this.hostLinkTimeout) linkFlags |= 0x02;
    view.setUint16(2, linkFlags, true);
    view.setUint32(4, this.uptimeMs, true);

    return this.createResponseFrame(sequence, Opcode.Heartbeat, BROADCAST_MOTOR_ID, payload);
  }

  private buildInfoResponse(sequence: number): Uint8Array {
    const payload = new Uint8Array(32);
    const view = new DataView(payload.buffer);
    view.setUint16(0, ResultCode.Ok, true);
    let linkFlags = 0;
    if (this.hasSeenValidRequest) linkFlags |= 0x01;
    if (this.hostLinkTimeout) linkFlags |= 0x02;
    view.setUint16(2, linkFlags, true);
    view.setUint32(4, this.uptimeMs, true);
    view.setUint16(8, 500, true); // host_timeout_ms
    view.setUint16(10, 100, true); // trajectory_hz
    view.setUint16(12, 1000, true); // nominal_per_motor_tx_hz
    view.setUint16(14, 2000, true); // grouped_tx_tick_hz
    view.setUint16(16, 500, true); // feedback_check_hz
    payload[18] = 6; // motor_count
    payload[19] = 1; // CAN FD+BRS
    for (let i = 0; i < MOTORS.length; i++) {
      payload[20 + i] = MOTORS[i].canId;
      payload[26 + i] = MOTORS[i].masterId;
    }

    return this.createResponseFrame(sequence, Opcode.Info, BROADCAST_MOTOR_ID, payload);
  }

  private buildStateResponse(sequence: number, motorId: number): Uint8Array {
    const motor = this.motors.get(motorId);
    if (!motor) {
      return this.buildActionAck(sequence, Opcode.State, motorId, ResultCode.UnknownMotor);
    }

    const payload = new Uint8Array(44);
    const view = new DataView(payload.buffer);
    view.setUint16(0, ResultCode.Ok, true);

    let flags = 0;
    if (motor.connected) flags |= 1 << 0;
    if (motor.zeroed) flags |= 1 << 1;
    if (motor.limitsConfigured) flags |= 1 << 2;
    if (motor.enabled) flags |= 1 << 3;
    if (motor.enablePending) flags |= 1 << 4;
    if (motor.busy) flags |= 1 << 5;
    if (motor.motionComplete) flags |= 1 << 6;
    if (motor.fault) flags |= 1 << 7;
    if (this.hostLinkTimeout) flags |= 1 << 8;

    view.setUint16(2, flags, true);
    view.setUint32(4, motor.motorState, true);
    view.setUint32(8, motor.feedbackCount, true);
    view.setFloat32(12, motor.positionDeg, true);
    view.setFloat32(16, motor.velocityRpm, true);
    view.setFloat32(20, motor.torqueNm, true);
    view.setFloat32(24, motor.acceptedTargetDeg, true);
    view.setFloat32(28, motor.referenceDeg, true);
    view.setFloat32(32, motor.referenceVelocityDegS, true);
    view.setFloat32(36, motor.commandedTorqueFfNm, true);
    view.setUint16(40, motor.lastDeviceResult, true);
    view.setUint16(42, motor.pendingOzoneCommand, true);

    return this.createResponseFrame(sequence, Opcode.State, motorId, payload);
  }

  private buildParametersResponse(sequence: number, motorId: number): Uint8Array {
    const motor = this.motors.get(motorId);
    if (!motor) {
      return this.buildActionAck(sequence, Opcode.Parameters, motorId, ResultCode.UnknownMotor);
    }

    const payload = new Uint8Array(44);
    const view = new DataView(payload.buffer);
    view.setUint16(0, ResultCode.Ok, true);
    view.setUint16(2, motor.limitsConfigured ? 1 : 0, true);
    view.setFloat32(4, motor.minDeg, true);
    view.setFloat32(8, motor.maxDeg, true);
    view.setFloat32(12, motor.maxVelocityDegS, true);
    view.setFloat32(16, motor.maxAccelerationDegS2, true);
    view.setFloat32(20, motor.maxJerkDegS3, true);
    view.setFloat32(24, motor.kp, true);
    view.setFloat32(28, motor.kd, true);
    view.setFloat32(32, motor.torqueFfNm, true);
    view.setFloat32(36, motor.finishDeg, true);
    view.setFloat32(40, motor.stationaryRpm, true);

    return this.createResponseFrame(sequence, Opcode.Parameters, motorId, payload);
  }

  private buildActionAck(sequence: number, opcode: number, motorId: number, result: number): Uint8Array {
    const payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, result, true);
    return this.createResponseFrame(sequence, opcode, motorId, payload);
  }

  private sendError(sequence: number, opcode: number, motorId: number, result: number) {
    const ack = this.buildActionAck(sequence, opcode, motorId, result);
    this.onOutputBytes(ack);
  }

  private createResponseFrame(sequence: number, opcode: number, motorId: number, payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(FRAME_SIZE);
    const view = new DataView(frame.buffer);
    frame[0] = HEADER_0;
    frame[1] = HEADER_1;
    frame[2] = VERSION;
    frame[3] = TYPE_RESPONSE;
    view.setUint16(4, sequence, true);
    frame[6] = opcode;
    frame[7] = motorId;
    view.setUint16(8, payload.length, true);
    view.setUint16(10, 0, true);
    frame.set(payload, 12);
    const crc = calcCrc16(frame, 62);
    view.setUint16(62, crc, true);
    return frame;
  }
}

// ================= 请求单在途调度器 (RequestQueue) =================

interface QueuedTransaction {
  sequence: number;
  opcode: number;
  motorId: number;
  frame: Uint8Array;
  expectedCount: number;
  timeoutMs: number;
  retriesRemaining: number;
  collectedResponses: DecodedResponse[];
  resolve: (resps: DecodedResponse[]) => void;
  reject: (err: Error) => void;
  startTime: number;
}

export class RequestQueue {
  private queue: QueuedTransaction[] = [];
  private inFlight: QueuedTransaction | null = null;
  private timer: TimerHandle | null = null;
  private seqCounter: number = 1;

  constructor(
    private sendFrameRaw: (frame: Uint8Array) => Promise<void>,
    private onLog: (level: LogLevel, msg: string, rawHex?: string) => void,
    private onStatsTx: () => void,
    private onStatsTimeout: () => void
  ) {}

  public getNextSequence(): number {
    const seq = this.seqCounter;
    this.seqCounter = (this.seqCounter + 1) & 0xffff;
    if (this.seqCounter === 0) this.seqCounter = 1;
    return seq;
  }

  /**
   * 提交请求并等待应答
   */
  public enqueue(
    opcode: number,
    motorId: number,
    frameFactory: (seq: number) => Uint8Array,
    timeoutMs: number = 150,
    retries: number = 1
  ): Promise<DecodedResponse[]> {
    const { promise, resolve, reject } = Promise.withResolvers<DecodedResponse[]>();
    const seq = this.getNextSequence();
    const frame = frameFactory(seq);

    // 判断需要收集的帧数 (0xFF 广播 State/Disable/Stop 会返回 6 帧)
    let expectedCount = 1;
    if (motorId === BROADCAST_MOTOR_ID) {
      if (opcode === Opcode.State || opcode === Opcode.Disable || opcode === Opcode.Stop) {
        expectedCount = 6;
      }
    }

    this.queue.push({
      sequence: seq,
      opcode,
      motorId,
      frame,
      expectedCount,
      timeoutMs,
      retriesRemaining: retries,
      collectedResponses: [],
      resolve,
      reject,
      startTime: performance.now(),
    });

    this.scheduleNext();
    return promise;
  }

  private async scheduleNext() {
    if (this.inFlight || this.queue.length === 0) return;

    const tx = this.queue.shift()!;
    this.inFlight = tx;

    try {
      await this.sendFrameRaw(tx.frame);
      this.onStatsTx();
      const hex = bytesToHex(tx.frame);
      const name = OpcodeNames[tx.opcode] || `0x${tx.opcode.toString(16)}`;
      this.onLog('tx', `[TX #${tx.sequence}] ${name} (motor: 0x${tx.motorId.toString(16).padStart(2, '0')})`, hex);

      // 启动超时计时器
      this.timer = globalThis.setTimeout(() => {
        this.handleTimeout();
      }, tx.timeoutMs);
    } catch (err) {
      this.inFlight = null;
      tx.reject(err instanceof Error ? err : new Error(String(err)));
      this.scheduleNext();
    }
  }

  private handleTimeout() {
    if (!this.inFlight) return;
    const tx = this.inFlight;
    this.timer = null;
    this.onStatsTimeout();

    const elapsed = Math.round(performance.now() - tx.startTime);
    this.onLog(
      'warn',
      `[超时 #${tx.sequence}] 命令 ${OpcodeNames[tx.opcode] || tx.opcode} 等待 ${elapsed}ms 未收齐 (${tx.collectedResponses.length}/${tx.expectedCount})`
    );

    // 重试机制 (SERIAL_PROTOCOL.md Section 4: 逐字节重发原帧)
    if (tx.retriesRemaining > 0) {
      tx.retriesRemaining -= 1;
      this.onLog('info', `[重试 #${tx.sequence}] 重新发送原帧 (剩余重试: ${tx.retriesRemaining})`);
      this.sendFrameRaw(tx.frame)
        .then(() => {
          this.onStatsTx();
          this.timer = globalThis.setTimeout(() => this.handleTimeout(), tx.timeoutMs);
        })
        .catch((err) => {
          this.inFlight = null;
          tx.reject(err instanceof Error ? err : new Error(String(err)));
          this.scheduleNext();
        });
      return;
    }

    this.inFlight = null;
    tx.reject(new Error(`Timeout waiting for response (seq=${tx.sequence})`));
    this.scheduleNext();
  }

  /**
   * 接收并匹配应答报文
   */
  public feedResponse(resp: DecodedResponse): boolean {
    if (!this.inFlight) return false;

    const tx = this.inFlight;
    if (resp.sequence !== tx.sequence || resp.opcode !== tx.opcode) {
      return false;
    }

    // 去重检查 (广播可能重复收到同 motor 的应答)
    const exists = tx.collectedResponses.some((r) => r.motor === resp.motor);
    if (!exists) {
      tx.collectedResponses.push(resp);
    }

    // 检查是否已经集齐所需应答
    if (tx.collectedResponses.length >= tx.expectedCount) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.inFlight = null;
      tx.resolve(tx.collectedResponses);
      this.scheduleNext();
    }

    return true;
  }

  public clear() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      this.inFlight.reject(new Error('Queue cleared'));
      this.inFlight = null;
    }
    while (this.queue.length > 0) {
      const tx = this.queue.shift()!;
      tx.reject(new Error('Queue cleared'));
    }
  }
}

// ================= 顶层统一通信管理器 (TransportManager) =================

export class TransportManager {
  private mode: 'simulator' | 'tauri' | 'web-serial' = 'simulator';
  private unpacker: StreamUnpacker = new StreamUnpacker();
  private requestQueue: RequestQueue;
  private mockSimulator: MockMcuSimulator;

  // Web Serial 句柄
  private webSerialPort: WebSerialPort | null = null;
  private webSerialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private webSerialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private webSerialReading: boolean = false;

  // Tauri 事件监听取消器
  private unlistenTauri: UnlistenFn | null = null;

  // 轮询定时器
  private heartbeatInterval: TimerHandle | null = null;
  private statePollInterval: TimerHandle | null = null;

  constructor(
    private callbacks: {
      onLog: (level: LogLevel, msg: string, rawHex?: string) => void;
      onFrameDecoded: (frame: DecodedResponse) => void;
      onStatsTx: () => void;
      onStatsRx: () => void;
      onStatsCrcError: () => void;
      onStatsTimeout: () => void;
      onConnectionChange: (connected: boolean, mode: 'simulator' | 'tauri' | 'web-serial') => void;
    }
  ) {
    this.requestQueue = new RequestQueue(
      (frame) => this.rawSend(frame),
      (level, msg, rawHex) => callbacks.onLog(level, msg, rawHex),
      () => callbacks.onStatsTx(),
      () => callbacks.onStatsTimeout()
    );

    this.mockSimulator = new MockMcuSimulator((bytes) => {
      this.handleIncomingRawBytes(bytes);
    });
  }

  public getMode() {
    return this.mode;
  }

  /**
   * 启动仿真机模式
   */
  public async connectSimulator(): Promise<void> {
    await this.disconnect();
    this.mode = 'simulator';
    this.mockSimulator.start();
    this.startPollingLoops();
    this.callbacks.onConnectionChange(true, 'simulator');
    this.callbacks.onLog('info', '已启动内置六电机高保真物理仿真器 (Mock MCU Online)');
  }

  /**
   * 启动 Tauri 原生串口
   */
  public async connectTauri(portName: string, baudRate: number = 115200): Promise<void> {
    await this.disconnect();
    this.mode = 'tauri';

    await invoke('open_serial_port', { portName, baudRate });

    this.unlistenTauri = await listen<number[]>('serial-data-received', (event) => {
      const data = new Uint8Array(event.payload);
      this.handleIncomingRawBytes(data);
    });

    this.startPollingLoops();
    this.callbacks.onConnectionChange(true, 'tauri');
    this.callbacks.onLog('info', `Tauri 原生串口已打开: ${portName} @ ${baudRate} bps`);
  }

  /**
   * 启动 Web Serial 浏览器串口
   */
  public async connectWebSerial(baudRate: number = 115200): Promise<void> {
    await this.disconnect();
    if (!('serial' in navigator)) {
      throw new Error('当前浏览器不支持 Web Serial API');
    }

    const nav = navigator as unknown as NavigatorWithSerial;
    if (!nav.serial) {
      throw new Error('当前浏览器不支持 Web Serial API');
    }
    const port = await nav.serial.requestPort();
    await port.open({ baudRate });

    this.webSerialPort = port;
    this.webSerialWriter = port.writable.getWriter();
    this.webSerialReader = port.readable.getReader();
    this.webSerialReading = true;
    this.mode = 'web-serial';

    this.readWebSerialLoop();
    this.startPollingLoops();
    this.callbacks.onConnectionChange(true, 'web-serial');
    this.callbacks.onLog('info', `Web Serial 串口连接成功 @ ${baudRate} bps`);
  }

  private async readWebSerialLoop() {
    while (this.webSerialReading && this.webSerialReader) {
      try {
        const { value, done } = await this.webSerialReader.read();
        if (done) break;
        if (value) {
          this.handleIncomingRawBytes(value);
        }
      } catch (err) {
        if (this.webSerialReading) {
          this.callbacks.onLog('error', `Web Serial 读取异常: ${err}`);
        }
        break;
      }
    }
  }

  public async disconnect(): Promise<void> {
    this.stopPollingLoops();
    this.requestQueue.clear();

    if (this.mode === 'simulator') {
      this.mockSimulator.stop();
    } else if (this.mode === 'tauri') {
      if (this.unlistenTauri) {
        this.unlistenTauri();
        this.unlistenTauri = null;
      }
      try {
        await invoke('close_serial_port');
      } catch {}
    } else if (this.mode === 'web-serial') {
      this.webSerialReading = false;
      if (this.webSerialReader) {
        try {
          await this.webSerialReader.cancel();
          this.webSerialReader.releaseLock();
        } catch {}
        this.webSerialReader = null;
      }
      if (this.webSerialWriter) {
        try {
          await this.webSerialWriter.releaseLock();
        } catch {}
        this.webSerialWriter = null;
      }
      if (this.webSerialPort) {
        try {
          await this.webSerialPort.close();
        } catch {}
        this.webSerialPort = null;
      }
    }

    this.callbacks.onConnectionChange(false, this.mode);
  }

  /**
   * 底层字节发送
   */
  private async rawSend(frame: Uint8Array): Promise<void> {
    if (this.mode === 'simulator') {
      // 模拟微小的 UART 传输延迟 (1~3ms)
      setTimeout(() => {
        this.mockSimulator.handleInputBytes(frame);
      }, 2);
    } else if (this.mode === 'tauri') {
      await invoke('write_serial_frame', { data: Array.from(frame) });
    } else if (this.mode === 'web-serial') {
      if (!this.webSerialWriter) throw new Error('Web Serial 写入流未就绪');
      await this.webSerialWriter.write(frame);
    }
  }

  /**
   * 处理底层接收到的字节流
   */
  private handleIncomingRawBytes(chunk: Uint8Array) {
    this.callbacks.onStatsRx();
    const frames = this.unpacker.feed(chunk);

    for (const frame of frames) {
      const hex = bytesToHex(frame.raw);
      const name = OpcodeNames[frame.opcode] || `0x${frame.opcode.toString(16)}`;
      const resultStr = ResultNames[frame.result] || `Result=${frame.result}`;
      this.callbacks.onLog(
        frame.result === ResultCode.Ok ? 'rx' : 'warn',
        `[RX #${frame.sequence}] ${name} (motor: 0x${frame.motor.toString(16).padStart(2, '0')}) -> ${resultStr}`,
        hex
      );

      // 递交请求调度器
      this.requestQueue.feedResponse(frame);

      // 通知上层分发状态
      this.callbacks.onFrameDecoded(frame);
    }
  }

  /**
   * 启动后台周期轮询：心跳 (100ms) 与全电机状态 (100ms/10Hz)
   */
  private startPollingLoops() {
    this.stopPollingLoops();

    // 1. 心跳循环 (100ms 间隔提交 Heartbeat)
    this.heartbeatInterval = globalThis.setInterval(async () => {
      try {
        await this.requestQueue.enqueue(
          Opcode.Heartbeat,
          BROADCAST_MOTOR_ID,
          (seq) => encodeFrame(seq, Opcode.Heartbeat, BROADCAST_MOTOR_ID),
          120,
          0 // 心跳无需重试，下个周期自会重发
        );
      } catch {
        // 心跳由统一统计与看门狗处理
      }
    }, 100);

    // 2. 状态查询循环 (120ms 间隔查询全部六电机)
    this.statePollInterval = globalThis.setInterval(async () => {
      try {
        await this.requestQueue.enqueue(
          Opcode.State,
          BROADCAST_MOTOR_ID,
          (seq) => encodeFrame(seq, Opcode.State, BROADCAST_MOTOR_ID),
          200,
          0
        );
      } catch {}
    }, 120);
  }

  private stopPollingLoops() {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.statePollInterval !== null) {
      clearInterval(this.statePollInterval);
      this.statePollInterval = null;
    }
  }

  // ================= 上位机主动动作 API =================

  public sendHeartbeat(): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.Heartbeat,
      BROADCAST_MOTOR_ID,
      (seq) => encodeFrame(seq, Opcode.Heartbeat, BROADCAST_MOTOR_ID),
      150,
      1
    );
  }

  public sendInfo(): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.Info,
      BROADCAST_MOTOR_ID,
      (seq) => encodeFrame(seq, Opcode.Info, BROADCAST_MOTOR_ID),
      200,
      1
    );
  }

  public queryState(motorId: number = BROADCAST_MOTOR_ID): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.State,
      motorId,
      (seq) => encodeFrame(seq, Opcode.State, motorId),
      motorId === BROADCAST_MOTOR_ID ? 300 : 150,
      1
    );
  }

  public queryParameters(motorId: number): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.Parameters,
      motorId,
      (seq) => encodeFrame(seq, Opcode.Parameters, motorId),
      200,
      1
    );
  }

  public enableMotor(motorId: number): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.Enable,
      motorId,
      (seq) => encodeFrame(seq, Opcode.Enable, motorId),
      200,
      1
    );
  }

  public disableMotor(motorId: number = BROADCAST_MOTOR_ID): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.Disable,
      motorId,
      (seq) => encodeFrame(seq, Opcode.Disable, motorId),
      motorId === BROADCAST_MOTOR_ID ? 300 : 200,
      1
    );
  }

  public stopMotor(motorId: number = BROADCAST_MOTOR_ID): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.Stop,
      motorId,
      (seq) => encodeFrame(seq, Opcode.Stop, motorId),
      motorId === BROADCAST_MOTOR_ID ? 300 : 200,
      1
    );
  }

  public setZero(motorId: number): Promise<DecodedResponse[]> {
    return this.requestQueue.enqueue(
      Opcode.SetZero,
      motorId,
      (seq) => encodeFrame(seq, Opcode.SetZero, motorId),
      200,
      1
    );
  }

  public moveMotor(motorId: number, targetDeg: number): Promise<DecodedResponse[]> {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setFloat32(0, targetDeg, true);
    return this.requestQueue.enqueue(
      Opcode.Move,
      motorId,
      (seq) => encodeFrame(seq, Opcode.Move, motorId, payload),
      200,
      0 // 运动非幂等，超时不自动重发，由操作者裁量
    );
  }

  public setLimits(motorId: number, limits: LimitsConfig): Promise<DecodedResponse[]> {
    const payload = new Uint8Array(20);
    const view = new DataView(payload.buffer);
    view.setFloat32(0, limits.minDeg, true);
    view.setFloat32(4, limits.maxDeg, true);
    view.setFloat32(8, limits.maxVelocityDegS, true);
    view.setFloat32(12, limits.maxAccelerationDegS2, true);
    view.setFloat32(16, limits.maxJerkDegS3, true);

    return this.requestQueue.enqueue(
      Opcode.SetLimits,
      motorId,
      (seq) => encodeFrame(seq, Opcode.SetLimits, motorId, payload),
      250,
      1
    );
  }
}
