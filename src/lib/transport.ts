import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { BROADCAST, Opcode, OPCODE_NAMES, StreamUnpacker, bytesToHex, encodeRequest, expectedResponseIds, hexId, resultName,
  type Response, type Info, type ProtocolIssue } from './protocol';
import { ProtocolDemo } from './demo';
import type { ConnectionState, TransportMode, PlatformInfo, SerialPortInfo, LogLevel } from '../store/atoms';
interface SerialPort {
  open(options: { baudRate: number; dataBits: number; stopBits: number; parity: string; flowControl: string }): Promise<void>;
  close(): Promise<void>; readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>;
}
interface SerialNavigator { serial?: { requestPort(): Promise<SerialPort> } }
export const isTauriEnvironment = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export async function getPlatformInfo(): Promise<PlatformInfo> {
  const isTauri = isTauriEnvironment(), hasWebSerial = 'serial' in navigator;
  if (isTauri) { const platform = await invoke<{ os: string; arch: string }>('get_platform_info'); return { ...platform, isTauri, hasWebSerial }; }
  return { isTauri, hasWebSerial, os: 'browser', arch: '' };
}
export async function listNativeSerialPorts(): Promise<SerialPortInfo[]> {
  return isTauriEnvironment() ? invoke<SerialPortInfo[]>('list_serial_ports') : [];
}
interface Transaction {
  sequence: number; opcode: number; id: number; bytes: Uint8Array; expected: Set<number>;
  responses: Map<number, Response>; retries: number;
  resolve: (responses: Response[]) => void; reject: (reason: Error) => void;
}
export interface TransportCallbacks {
  onStatus: (status: ConnectionState) => void;
  onResponse: (response: Response) => void;
  onLog: (level: LogLevel, message: string, rawHex?: string) => void;
}
export class TransportManager {
  private status: ConnectionState;
  private parser: StreamUnpacker;
  private queue: Transaction[] = [];
  private active: Transaction | null = null;
  private sequence = 1;
  private timeout: number | undefined;
  private pollTimer: number | undefined;
  private generation = 0;
  private pollGeneration = 0;
  private opened = false;
  private manualPending = false;
  private lastHeartbeat = 0;
  private lastStatePoll = 0;
  private lastWheelPoll = 0;
  private selected = 0x0a;
  private demo: ProtocolDemo | null = null;
  private demoTimers = new Set<number>();
  private unlisten: UnlistenFn[] = [];
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  constructor(private callbacks: TransportCallbacks) {
    this.status = { mode: isTauriEnvironment() ? 'tauri' : 'web-serial', phase: 'disconnected', portOpen: false, portName: '',
      message: '尚未连接；不会自动启动演示', lastRxAt: 0, info: null, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0 };
    this.parser = new StreamUnpacker(issue => this.protocolIssue(issue));
  }
  private publish(patch: Partial<ConnectionState> = {}) {
    this.status = { ...this.status, ...patch }; this.callbacks.onStatus({ ...this.status });
  }
  private protocolIssue(issue: ProtocolIssue) {
    if (issue.kind === 'crc') { this.publish({ crcErrors: this.status.crcErrors + 1 }); this.callbacks.onLog('warn', issue.message); }
    else if (issue.kind === 'version') this.fail(issue.message, 'incompatible');
    else this.callbacks.onLog('warn', `丢弃无效应答：${issue.message}`);
  }
  selectDevice(id: number) { this.selected = id; }
  private request(opcode: number, id: number, values: number[] = []): Promise<Response[]> {
    if (!this.opened) return Promise.reject(new Error('串口尚未打开'));
    const sequence = this.sequence; this.sequence = (this.sequence + 1) & 0xffff;
    let bytes: Uint8Array;
    try { bytes = encodeRequest(sequence, opcode, id, values); } catch (error) { return Promise.reject(error); }
    const { promise, resolve, reject } = Promise.withResolvers<Response[]>();
    this.queue.push({ sequence, opcode, id, bytes, expected: new Set(expectedResponseIds(opcode, id)), responses: new Map(), retries: 1, resolve, reject });
    this.pump();
    return promise;
  }
  private pump() {
    if (this.active || !this.queue.length || !this.opened) return;
    this.active = this.queue.shift()!; this.send(this.active);
  }
  private send(transaction: Transaction) {
    // Install before write: a synchronous/very fast reply must not arm a ghost timeout.
    this.timeout = window.setTimeout(() => {
      if (this.active !== transaction) return;
      this.publish({ timeouts: this.status.timeouts + 1 });
      if (transaction.retries-- > 0) {
        this.callbacks.onLog('warn', `#${transaction.sequence} 未收齐 ${transaction.responses.size}/${transaction.expected.size}，重发同一帧`);
        this.send(transaction);
      } else this.fail(`请求 #${transaction.sequence} 无完整应答（${transaction.responses.size}/${transaction.expected.size}）；端口可能打开，但未能确认固件通讯`);
    }, 150);
    this.publish({ txFrames: this.status.txFrames + 1 });
    this.callbacks.onLog('tx', `#${transaction.sequence} ${OPCODE_NAMES[transaction.opcode] ?? transaction.opcode} · ${hexId(transaction.id)}`, bytesToHex(transaction.bytes));
    this.rawWrite(transaction.bytes).catch(error => {
      if (this.active === transaction) this.fail(`发送失败：${error instanceof Error ? error.message : error}`);
    });
  }
  private async rawWrite(bytes: Uint8Array) {
    if (this.status.mode === 'demo') {
      if (!this.demo) throw new Error('演示会话已关闭');
      const replies = this.demo.handle(bytes);
      const generation = this.generation;
      replies.forEach((reply, index) => {
        const timer = window.setTimeout(() => { this.demoTimers.delete(timer); if (generation === this.generation) this.incoming(reply); }, 6 * (index + 1));
        this.demoTimers.add(timer);
      });
    } else if (this.status.mode === 'tauri') await invoke('write_serial_frame', { data: Array.from(bytes) });
    else { if (!this.writer) throw new Error('串口写入流尚未就绪'); await this.writer.write(new Uint8Array(bytes)); }
  }
  private incoming(chunk: Uint8Array) {
    const frames = this.parser.feed(chunk);
    for (const response of frames) {
      this.publish({ rxFrames: this.status.rxFrames + 1 });
      this.callbacks.onLog(response.result ? 'warn' : 'rx', `#${response.sequence} ${OPCODE_NAMES[response.opcode] ?? response.opcode} · ${hexId(response.id)} · ${resultName(response.result)}`, bytesToHex(response.raw));
      const transaction = this.active;
      if (!transaction || response.sequence !== transaction.sequence || response.opcode !== transaction.opcode) continue;
      const terminalError = response.result !== 0 && response.id === transaction.id;
      if (!transaction.expected.has(response.id) && !terminalError) continue;
      if (transaction.responses.has(response.id)) continue;
      transaction.responses.set(response.id, response);
      this.publish({ lastRxAt: Date.now() });
      this.callbacks.onResponse(response);
      if (terminalError || [...transaction.expected].every(id => transaction.responses.has(id))) {
        clearTimeout(this.timeout); this.timeout = undefined; this.active = null;
        transaction.resolve([...transaction.responses.values()]); this.pump();
      }
    }
  }
  private cancelQueue(reason: Error) {
    clearTimeout(this.timeout); this.timeout = undefined;
    const active = this.active; this.active = null; active?.reject(reason);
    this.queue.splice(0).forEach(transaction => transaction.reject(reason));
  }
  private fail(message: string, phase: 'unresponsive' | 'incompatible' = 'unresponsive') {
    if (this.status.phase === 'disconnected' || this.status.phase === 'incompatible') return;
    this.pollGeneration++;
    clearTimeout(this.pollTimer); this.pollTimer = undefined;
    this.cancelQueue(new Error(message));
    this.publish({ phase, message }); this.callbacks.onLog('error', message);
  }
  async connect(mode: TransportMode, portName = ''): Promise<void> {
    await this.disconnect(); const generation = this.generation;
    this.publish({ mode, phase: 'opening', portOpen: false, portName: mode === 'demo' ? '协议演示 · 无硬件连接' : mode === 'web-serial' ? '浏览器串口' : portName,
      message: '正在打开传输端口', info: null, lastRxAt: 0, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0 });
    try {
      if (mode === 'demo') this.demo = new ProtocolDemo();
      else if (mode === 'tauri') {
        if (!portName) throw new Error('请选择系统串口');
        // Rust emits serial-rx-chunk, not the obsolete serial-data-received event.
        this.unlisten.push(await listen<number[]>('serial-rx-chunk', event => { if (generation === this.generation) this.incoming(Uint8Array.from(event.payload)); }));
        this.unlisten.push(await listen<string>('serial-disconnected', event => { if (generation === this.generation) { this.opened = false; this.publish({ portOpen: false }); this.fail(event.payload); } }));
        await invoke('open_serial_port', { portName, baudRate: 115200 });
      } else {
        const serial = (navigator as unknown as SerialNavigator).serial;
        if (!serial) throw new Error('此浏览器不支持 Web Serial，请使用桌面版或 Chrome/Edge');
        const port = await serial.requestPort();
        if (generation !== this.generation) return;
        await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
        this.port = port; this.reader = port.readable.getReader(); this.writer = port.writable.getWriter();
        void this.readLoop(generation);
      }
      if (generation !== this.generation) return;
      this.opened = true; this.publish({ portOpen: true }); await this.handshake();
    } catch (error) {
      if (generation === this.generation && this.status.phase !== 'incompatible') this.fail(error instanceof Error ? error.message : String(error));
      if (generation === this.generation && !this.opened) this.publish({ phase: 'disconnected', portOpen: false });
      throw error;
    }
  }
  async handshake(): Promise<void> {
    if (!this.opened) throw new Error('请先打开串口');
    this.pollGeneration++;
    clearTimeout(this.pollTimer); this.pollTimer = undefined;
    try {
    this.cancelQueue(new Error('重新握手，旧事务已取消')); this.parser.reset();
    this.publish({ phase: 'handshaking', message: '端口已打开，正在确认协议v2和九设备清单', info: null });
    // Two different sequences guarantee a new heartbeat even if the MCU cached the first.
    for (let i = 0; i < 2; i++) {
      const replies = await this.request(Opcode.Heartbeat, BROADCAST);
      if (replies.some(r => r.result !== 0 && r.result !== 106)) throw new Error(resultName(replies[0].result));
    }
    const infoReplies = await this.request(Opcode.Info, BROADCAST);
    const info = infoReplies.find((response): response is Info => response.type === 'info');
    if (!info || info.linkTimeout) throw new Error('未获得有效的v2设备发现应答；需要新的心跳握手');
    this.publish({ info, message: '固件已应答，正在读取每台设备状态' });
    await this.refresh();
    this.publish({ phase: 'ready', message: this.status.mode === 'demo' ? '协议演示已就绪，不代表任何真实电机在线' : '固件握手成功，电机在线情况以各设备新反馈为准' });
    this.lastHeartbeat = performance.now(); this.lastStatePoll = performance.now(); this.schedulePolling();
    } catch (error) {
      if (this.status.phase !== 'incompatible') this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  private async readLoop(generation: number) {
    try {
      while (generation === this.generation && this.reader) {
        const { value, done } = await this.reader.read();
        if (generation !== this.generation) return;
        if (done) { this.opened = false; this.publish({ portOpen: false }); this.fail('串口读取流已关闭'); return; }
        if (value) this.incoming(value);
      }
    } catch (error) { if (generation === this.generation) { this.opened = false; this.publish({ portOpen: false }); this.fail(`串口读取失败：${error}`); } }
  }
  private schedulePolling() {
    clearTimeout(this.pollTimer);
    const generation = this.generation;
    const pollGeneration = this.pollGeneration;
    this.pollTimer = window.setTimeout(async () => {
      if (generation !== this.generation || pollGeneration !== this.pollGeneration || this.status.phase !== 'ready') return;
      try {
        const now = performance.now();
        if (now - this.lastHeartbeat >= 100) { await this.request(Opcode.Heartbeat, BROADCAST); this.lastHeartbeat = performance.now(); }
        if (now - this.lastStatePoll >= 200) { await this.request(Opcode.State, BROADCAST); this.lastStatePoll = performance.now(); }
        if (this.selected === 0x40 && now - this.lastWheelPoll >= 400) { await this.request(Opcode.Wheels, 0x40); this.lastWheelPoll = performance.now(); }
        if (generation === this.generation && pollGeneration === this.pollGeneration && this.status.phase === 'ready') this.schedulePolling();
      } catch (error) { if (generation === this.generation && pollGeneration === this.pollGeneration) this.fail(error instanceof Error ? error.message : String(error)); }
    }, 20);
  }
  async refresh(): Promise<void> {
    const states = await this.request(Opcode.State, BROADCAST);
    if (states.some(response => response.result !== 0)) throw new Error('设备状态查询被拒绝');
    await this.request(Opcode.Parameters, this.selected);
    if (this.selected === 0x40) await this.request(Opcode.Wheels, 0x40);
  }
  async queryParameters(id: number): Promise<Response[]> { return this.request(Opcode.Parameters, id); }
  async command(opcode: number, id: number, values: number[] = []): Promise<Response[]> {
    if (this.status.phase !== 'ready') throw new Error('未完成固件握手，禁止发送动作');
    if (this.manualPending) throw new Error('上一条操作仍在等待应答');
    this.manualPending = true;
    try {
      const replies = await this.request(opcode, id, values);
      if (opcode === Opcode.SetLimits || opcode === Opcode.SetZero) await this.request(Opcode.Parameters, id);
      await this.request(Opcode.State, id);
      return replies;
    } finally { this.manualPending = false; }
  }
  async disconnect(): Promise<void> {
    this.generation++; this.opened = false;
    this.pollGeneration++;
    clearTimeout(this.pollTimer); this.pollTimer = undefined;
    this.cancelQueue(new Error('连接已关闭')); this.parser.reset(); this.demo = null;
    for (const timer of this.demoTimers) clearTimeout(timer); this.demoTimers.clear();
    for (const unlisten of this.unlisten.splice(0)) unlisten();
    const reader = this.reader; this.reader = null;
    if (reader) { try { await reader.cancel(); } catch { /* Already closed by the OS. */ } reader.releaseLock(); }
    const writer = this.writer; this.writer = null;
    if (writer) writer.releaseLock();
    const port = this.port; this.port = null;
    if (port) { try { await port.close(); } catch { this.callbacks.onLog('warn', '端口已由系统关闭'); } }
    if (this.status.mode === 'tauri') { try { await invoke('close_serial_port'); } catch (error) { this.callbacks.onLog('warn', `关闭原生端口：${error}`); } }
    this.publish({ phase: 'disconnected', portOpen: false, message: '已断开；断开通讯不等于实际电机已失能', info: null });
  }
}
