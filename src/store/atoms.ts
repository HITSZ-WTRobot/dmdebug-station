import { atom } from 'jotai';
import { DEVICES, type DeviceDefinition, type DeviceState, type DeviceParameters, type Info } from '../lib/protocol';
export type TransportMode = 'tauri' | 'bluetooth' | 'web-serial' | 'demo';
export type ConnectionPhase = 'disconnected' | 'opening' | 'handshaking' | 'ready' | 'unresponsive' | 'incompatible';
export type LogLevel = 'tx' | 'rx' | 'info' | 'warn' | 'error';
export interface LogEntry { id: number; time: number; level: LogLevel; message: string; rawHex?: string }
export interface SerialPortInfo { portName: string; label: string; portType: string; manufacturer?: string; product?: string }
export interface BluetoothDeviceInfo { address: string; name: string; connected: boolean }
export interface PlatformInfo { isTauri: boolean; hasWebSerial: boolean; os: string; arch: string }
export interface ConnectionState {
  mode: TransportMode; phase: ConnectionPhase; portOpen: boolean; portName: string; message: string; lastRxAt: number;
  info: Info | null; txFrames: number; rxFrames: number; crcErrors: number; timeouts: number;
}
export interface DeviceSnapshot {
  definition: DeviceDefinition; state: DeviceState | null; parameters: DeviceParameters | null;
  updatedAt: number; parametersAt: number;
}
export const connectionAtom = atom<ConnectionState>({
  mode: 'web-serial', phase: 'disconnected', portOpen: false, portName: '', message: '选择串口后连接，尚未发送任何命令',
  lastRxAt: 0, info: null, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0,
});
export const devicesAtom = atom<Record<number, DeviceSnapshot>>(Object.fromEntries(DEVICES.map(definition => [definition.id,
  { definition, state: null, parameters: null, updatedAt: 0, parametersAt: 0 }])));
export const selectedDeviceAtom = atom(DEVICES[0].id);
export const logsAtom = atom<LogEntry[]>([]);
