/**
 * @file atoms.ts
 * @brief Jotai 原子化状态管理仓库 (支持六电机状态、参数、遥测曲线与串口事务)
 */

import { atom } from 'jotai';
import {
  MOTORS,
  BROADCAST_MOTOR_ID,
  type StatePayload,
  type ParametersPayload,
  type MotorConfig,
} from '../lib/protocol';

export type TransportMode = 'simulator' | 'tauri' | 'web-serial';
export type LogLevel = 'tx' | 'rx' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  time: string;
  level: LogLevel;
  message: string;
  rawHex?: string;
}

export interface SerialPortInfo {
  portName: string;
  portType: string;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
}

export interface PlatformInfo {
  isTauri: boolean;
  os: string;
  arch: string;
  hasWebSerial: boolean;
}

export interface MotorRuntimeState {
  config: MotorConfig;
  state: StatePayload | null;
  params: ParametersPayload | null;
  lastUpdated: number;
}

export interface TelemetryPoint {
  time: number;
  positionDeg: number;
  referenceDeg: number;
  velocityRpm: number;
  velocityRefDegS: number;
  torqueNm: number;
  torqueFfNm: number;
}

// 1. 系统与连接状态
export const platformInfoAtom = atom<PlatformInfo>({
  isTauri: false,
  os: 'browser',
  arch: 'wasm',
  hasWebSerial: false,
});

export const serialPortsAtom = atom<SerialPortInfo[]>([]);
export const selectedPortAtom = atom<string>('');
export const baudRateAtom = atom<number>(115200);

export const connectionStatusAtom = atom<{
  connected: boolean;
  connecting: boolean;
  mode: TransportMode;
  portName: string;
  baudRate: number;
  lastSeenMs: number;
  hostLinkTimeout: boolean;
}>({
  connected: false,
  connecting: false,
  mode: 'simulator',
  portName: '',
  baudRate: 115200,
  lastSeenMs: 0,
  hostLinkTimeout: false,
});

export const commStatsAtom = atom<{
  txFrames: number;
  rxFrames: number;
  crcErrors: number;
  timeouts: number;
  uptimeMs: number;
  hz: number;
}>({
  txFrames: 0,
  rxFrames: 0,
  crcErrors: 0,
  timeouts: 0,
  uptimeMs: 0,
  hz: 0,
});

// 2. 六电机运行状态存储 (以 CAN ID 0x0A ~ 0x0F 索引)
const initialMotorStates: Record<number, MotorRuntimeState> = {};
for (const m of MOTORS) {
  initialMotorStates[m.canId] = {
    config: m,
    state: null,
    params: null,
    lastUpdated: 0,
  };
}

export const motorStatesAtom = atom<Record<number, MotorRuntimeState>>(initialMotorStates);

// 当前选中的操作电机 (0x0A..0x0F，或者 0xFF 代表全部)
export const selectedMotorCanIdAtom = atom<number>(MOTORS[0].canId);

// 3. 控制面板草稿与输入参数
export const draftTargetDegAtom = atom<number>(0.0);
export const stepDeltaDegAtom = atom<number>(2.0);

export const draftLimitsAtom = atom<{
  minDeg: number;
  maxDeg: number;
  maxVelocityDegS: number;
  maxAccelerationDegS2: number;
  maxJerkDegS3: number;
}>({
  minDeg: -30,
  maxDeg: 30,
  maxVelocityDegS: 10,
  maxAccelerationDegS2: 20,
  maxJerkDegS3: 100,
});

// 4. 遥测与示波器配置
export const telemetryBufferAtom = atom<Record<number, TelemetryPoint[]>>({
  0x0a: [],
  0x0b: [],
  0x0c: [],
  0x0d: [],
  0x0e: [],
  0x0f: [],
});

export const scopeConfigAtom = atom<{
  timeWindowSec: number;
  showPosition: boolean;
  showReference: boolean;
  showVelocity: boolean;
  showTorque: boolean;
  isPaused: boolean;
}>({
  timeWindowSec: 5,
  showPosition: true,
  showReference: true,
  showVelocity: true,
  showTorque: true,
  isPaused: false,
});

// 5. 日志与协议监控
export const logsAtom = atom<LogEntry[]>([]);
export const pauseLogScrollAtom = atom<boolean>(false);
export const logFilterAtom = atom<'all' | 'tx' | 'rx' | 'warn-error'>('all');
