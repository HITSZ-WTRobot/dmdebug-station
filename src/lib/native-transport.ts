import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { decodeFrame, type BodyVelocity, type Response } from './protocol';
import type { ConnectionState, LogLevel, TransportMode } from '../store/atoms';
import type { GamepadBinding } from './gamepad';
import type { GamepadControlState, TransportCallbacks } from './transport';

export interface NativePadView {
  key: string; id: string; index: number; mapping: string; timestamp: number; connected: boolean;
  axisCodes: number[]; buttonCodes: number[];
  axes: number[]; buttons: { value: number; pressed: boolean }[];
}
export interface NativePadSnapshot {
  supported: boolean; error: string; pads: NativePadView[]; selectedKey: string;
  binding: GamepadBinding | null; armed: boolean; neutral: boolean; released: boolean;
  target: BodyVelocity; phase: string; message: string;
}
export interface NativeStatus extends Omit<ConnectionState, 'info' | 'mode'> {
  infoFrame: number[] | null; mode: 'tauri' | 'demo';
}
export interface NativeBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<UnlistenFn>;
}
const bridge: NativeBridge = { invoke, listen };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
let owner: NativeTransportAdapter | null = null;

// 只把操作意图交给 Rust；帧解码仅供显示，绝不在这里重试、排队或写串口。
export class NativeTransportAdapter {
  private generation = 0;
  private unlisten: UnlistenFn[] = [];
  private listening: Promise<void>;
  private accepting = false;
  private negotiating = false;
  private readyAllowed = false;
  private waitingFor: 'opening' | 'handshaking' | null = null;
  private pendingStatus: ConnectionState | null = null;
  private gamepad: GamepadControlState = { phase: 'off', message: '等待 Rust 手柄状态' };
  private status: ConnectionState = { mode: 'tauri', phase: 'disconnected', portOpen: false, portName: '',
    message: '尚未连接；不会自动启动演示', lastRxAt: 0, info: null, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0 };

  constructor(private callbacks: TransportCallbacks, private api: NativeBridge = bridge) {
    owner?.retire();
    owner = this;
    this.listening = this.attach();
    // React 清理可能早于异步 listen 返回；attach 会立即释放迟到的订阅。
    void this.listening.catch(() => {});
  }
  private current(generation: number) { return owner === this && generation === this.generation; }
  private requireCurrent(generation: number) {
    if (!this.current(generation)) throw new Error('原生通信操作已取消');
  }
  private clearListeners() { for (const unlisten of this.unlisten.splice(0)) unlisten(); }
  private async attach(): Promise<void> {
    const generation = this.generation;
    let failed = false;
    const bind = async <T>(name: string, receive: (payload: T) => void) => {
      const unlisten = await this.api.listen<T>(name, event => {
        if (!failed && this.current(generation) && this.accepting) receive(event.payload);
      });
      if (!failed && this.current(generation)) this.unlisten.push(unlisten); else unlisten();
    };
    try {
      await Promise.all([
        bind<NativeStatus>('native-status', status => this.receiveStatus(status)),
        bind<number[]>('native-response', raw => {
          if (this.waitingFor !== null) return;
          try { this.callbacks.onResponse(decodeFrame(Uint8Array.from(raw))); }
          catch (error) { this.callbacks.onLog('error', `原生应答无法展示：${errorText(error)}`); }
        }),
        bind<{ level: LogLevel; message: string; rawHex?: string }>('native-log', log => this.callbacks.onLog(log.level, log.message, log.rawHex)),
        bind<NativePadSnapshot>('native-gamepad', snapshot => {
          const phase = snapshot.phase;
          this.gamepad = { phase: phase === 'active' || phase === 'enabling' || phase === 'stopping' ? phase : 'off', message: snapshot.message };
        }),
      ]);
      this.requireCurrent(generation);
    } catch (error) {
      failed = true;
      if (this.current(generation)) this.clearListeners();
      throw error;
    }
  }
  private publish(status: ConnectionState) { this.status = status; this.callbacks.onStatus({ ...status }); }
  private receiveStatus(native: NativeStatus) {
    // 新会话开始前，Rust 仍可能正在结束旧事务；opening / handshaking 是 actor 的切换边界。
    if (this.waitingFor !== null) {
      if (native.phase !== this.waitingFor) return;
      this.waitingFor = null;
    }
    if (native.phase === 'ready' && !this.negotiating && !this.readyAllowed) return;
    let info: ConnectionState['info'] = null;
    if (native.infoFrame) {
      try { const response = decodeFrame(Uint8Array.from(native.infoFrame)); if (response.type === 'info') info = response; }
      catch (error) { this.callbacks.onLog('error', `原生固件信息无法展示：${errorText(error)}`); }
    }
    const { infoFrame: _, ...fields } = native;
    const status: ConnectionState = { ...fields, info };
    this.pendingStatus = status;
    // ready 只能由完成的握手确认，不能被失败或已取消的 invoke 提前发布。
    this.publish(this.negotiating && status.phase === 'ready' ? { ...status, phase: 'handshaking' } : status);
  }
  private retire() {
    const wasAccepting = this.accepting;
    this.accepting = false; this.generation++; this.clearListeners();
    if (wasAccepting) void this.api.invoke('native_disconnect').catch(() => {});
  }
  private async operation<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const generation = this.generation;
    await this.listening; this.requireCurrent(generation);
    const result = await this.api.invoke<T>(command, args);
    this.requireCurrent(generation);
    return result;
  }
  async connect(mode: TransportMode, portName = ''): Promise<void> {
    if (owner !== this) throw new Error('原生通信实例已被替换');
    if (mode === 'web-serial') throw new Error('桌面版不支持 Web Serial，请使用原生串口');
    this.generation++; this.clearListeners(); this.accepting = true; this.negotiating = true; this.readyAllowed = false; this.pendingStatus = null;
    this.waitingFor = 'opening';
    this.listening = this.attach();
    const generation = this.generation;
    this.publish({ ...this.status, mode, phase: 'opening', portOpen: false, portName: mode === 'demo' ? 'Rust 本地协议演示 · 无硬件连接' : portName,
      message: '正在请求 Rust 打开连接并握手', info: null, lastRxAt: 0, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0 });
    await this.negotiate('native_connect', { mode, portName }, generation);
  }
  private async negotiate(command: string, args: Record<string, unknown> | undefined, generation: number) {
    try {
      await this.operation<void>(command, args);
      this.requireCurrent(generation); this.negotiating = false; this.readyAllowed = true;
      if (this.pendingStatus) this.publish(this.pendingStatus);
    } catch (error) {
      if (this.current(generation)) {
        this.negotiating = false; this.readyAllowed = false;
        this.publish({ ...this.status, phase: this.status.phase === 'incompatible' ? 'incompatible' : 'unresponsive', message: errorText(error) });
      }
      throw error;
    }
  }
  async handshake(): Promise<void> {
    if (owner !== this) throw new Error('原生通信实例已被替换');
    this.generation++; this.clearListeners(); this.accepting = true; this.negotiating = true; this.readyAllowed = false; this.pendingStatus = null;
    this.waitingFor = 'handshaking';
    this.listening = this.attach();
    this.publish({ ...this.status, phase: 'handshaking', message: '正在请求 Rust 重新握手', info: null });
    await this.negotiate('native_handshake', undefined, this.generation);
  }
  selectDevice(deviceId: number): Promise<void> { return this.operation('native_select_device', { deviceId }); }
  refresh(): Promise<void> { return this.operation('native_refresh'); }
  async queryParameters(deviceId: number): Promise<Response[]> {
    return (await this.operation<number[][]>('native_query_parameters', { deviceId })).map(raw => decodeFrame(Uint8Array.from(raw)));
  }
  async command(opcode: number, deviceId: number, values: number[] = []): Promise<Response[]> {
    return (await this.operation<number[][]>('native_command', { opcode, deviceId, values })).map(raw => decodeFrame(Uint8Array.from(raw)));
  }
  getGamepadState(): GamepadControlState { return { ...this.gamepad }; }
  async disconnect(): Promise<void> {
    if (owner !== this) { this.retire(); return; }
    this.accepting = false; this.generation++; this.clearListeners(); this.negotiating = false; this.readyAllowed = false;
    this.gamepad = { phase: 'off', message: '连接已关闭；未确认物理停止' };
    const generation = this.generation;
    try { await this.api.invoke('native_disconnect'); }
    finally {
      if (this.current(generation)) this.publish({ ...this.status, phase: 'disconnected', portOpen: false, info: null,
        message: '已断开；断开通讯不等于实际电机已失能' });
    }
  }
}
