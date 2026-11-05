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
  responses: Map<number, Response>; retries: number; deadline: number;
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
  private clock: Worker | null = null;
  private clockUrl: string | null = null;
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
    if (!this.clock) return Promise.reject(new Error('通信时钟未启动，请重新握手'));
    const sequence = this.sequence; this.sequence = (this.sequence + 1) & 0xffff;
    let bytes: Uint8Array;
    try { bytes = encodeRequest(sequence, opcode, id, values); } catch (error) { return Promise.reject(error); }
    const { promise, resolve, reject } = Promise.withResolvers<Response[]>();
    this.queue.push({ sequence, opcode, id, bytes, expected: new Set(expectedResponseIds(opcode, id)), responses: new Map(), retries: 1, deadline: 0, resolve, reject });
    this.pump();
    return promise;
  }
  private pump() {
    if (this.active || !this.queue.length || !this.opened) return;
    this.active = this.queue.shift()!; this.send(this.active);
  }
  private send(transaction: Transaction) {
    // 写口前设置截止时间，快速应答不会留下孤立的超时回调。
    transaction.deadline = performance.now() + 150;
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
      const generation = this.generation, session = this.pollGeneration;
      replies.forEach((reply, index) => {
        const timer = window.setTimeout(() => { this.demoTimers.delete(timer); if (generation === this.generation && session === this.pollGeneration) this.incoming(reply); }, 6 * (index + 1));
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
        this.active = null;
        transaction.resolve([...transaction.responses.values()]); this.pump();
      }
    }
  }
  private cancelQueue(reason: Error) {
    const active = this.active; this.active = null; active?.reject(reason);
    this.queue.splice(0).forEach(transaction => transaction.reject(reason));
    this.manualPending = false;
  }
  private fail(message: string, phase: 'unresponsive' | 'incompatible' = 'unresponsive') {
    if (this.status.phase === 'disconnected' || this.status.phase === 'incompatible') return;
    this.stopClock();
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
      if (generation === this.generation && this.status.phase === 'opening') this.fail(error instanceof Error ? error.message : String(error));
      if (generation === this.generation && !this.opened) this.publish({ phase: 'disconnected', portOpen: false });
      throw error;
    }
  }
  async handshake(): Promise<void> {
    if (!this.opened) throw new Error('请先打开串口');
    this.stopClock();
    const session = this.pollGeneration;
    try {
      this.cancelQueue(new Error('重新握手，旧事务已取消')); this.parser.reset();
      this.publish({ phase: 'handshaking', message: '端口已打开，正在确认协议v2和九设备清单', info: null });
      this.startClock();
      // 使用两个不同序号，避免首个心跳命中下位机的旧应答缓存。
      for (let i = 0; i < 2; i++) {
        const replies = await this.request(Opcode.Heartbeat, BROADCAST);
        this.requireSession(session);
        if (replies.some(r => r.result !== 0 && r.result !== 106)) throw new Error(resultName(replies[0].result));
      }
      const infoReplies = await this.request(Opcode.Info, BROADCAST);
      this.requireSession(session);
      const info = infoReplies.find((response): response is Info => response.type === 'info');
      if (!info || info.linkTimeout) throw new Error('未获得有效的v2设备发现应答；需要新的心跳握手');
      this.publish({ info, message: '固件已应答，正在读取每台设备状态' });
      await this.refresh();
      this.requireSession(session);
      this.lastHeartbeat = this.lastStatePoll = this.lastWheelPoll = performance.now();
      this.publish({ phase: 'ready', message: this.status.mode === 'demo' ? '协议演示已就绪，不代表任何真实电机在线' : '固件握手成功，电机在线情况以各设备新反馈为准' });
    } catch (error) {
      if (session === this.pollGeneration && this.status.phase !== 'incompatible') this.fail(error instanceof Error ? error.message : String(error));
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
  private requireSession(session: number) {
    if (session !== this.pollGeneration || !this.opened) throw new Error('通信会话已取消');
  }
  private startClock() {
    // 内联 Worker 仅唤醒主线程；所有写口仍由同一个事务队列串行执行。
    const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(null), 20);'], { type: 'text/javascript' }));
    let clock: Worker;
    try { clock = new Worker(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
    this.clock = clock; this.clockUrl = url;
    const generation = this.generation, session = this.pollGeneration;
    clock.onmessage = () => {
      if (this.clock === clock && generation === this.generation && session === this.pollGeneration) this.tick();
    };
    clock.onerror = event => {
      event.preventDefault();
      if (this.clock === clock && generation === this.generation && session === this.pollGeneration) this.fail('通信时钟已停止，请手动重新握手');
    };
  }
  private stopClock() {
    this.pollGeneration++;
    const clock = this.clock; this.clock = null;
    if (clock) { clock.onmessage = null; clock.onerror = null; clock.terminate(); }
    if (this.clockUrl !== null) { URL.revokeObjectURL(this.clockUrl); this.clockUrl = null; }
    for (const timer of this.demoTimers) clearTimeout(timer); this.demoTimers.clear();
  }
  private tick() {
    const now = performance.now(), transaction = this.active;
    if (transaction) {
      if (now >= transaction.deadline) {
        this.publish({ timeouts: this.status.timeouts + 1 });
        if (transaction.retries-- > 0) {
          this.callbacks.onLog('warn', `#${transaction.sequence} 未收齐 ${transaction.responses.size}/${transaction.expected.size}，重发同一帧`);
          this.send(transaction);
        } else this.fail(`请求 #${transaction.sequence} 无完整应答（${transaction.responses.size}/${transaction.expected.size}）；端口可能打开，但未能确认固件通讯`);
      }
      return;
    }
    // 忙时不排入轮询；空闲后仅选择最早到期的一项，不补发积压节拍。
    if (!this.opened || this.status.phase !== 'ready' || this.queue.length || this.manualPending) return;
    let opcode: number = Opcode.Heartbeat, id = BROADCAST, due = this.lastHeartbeat + 100;
    if (this.lastStatePoll + 200 < due) { opcode = Opcode.State; due = this.lastStatePoll + 200; }
    if (this.selected === 0x40 && this.lastWheelPoll + 400 < due) { opcode = Opcode.Wheels; id = 0x40; due = this.lastWheelPoll + 400; }
    if (now < due) return;
    if (opcode === Opcode.Heartbeat) this.lastHeartbeat = now;
    else if (opcode === Opcode.State) this.lastStatePoll = now;
    else this.lastWheelPoll = now;
    const session = this.pollGeneration;
    void this.request(opcode, id).catch(error => {
      if (session === this.pollGeneration) this.fail(error instanceof Error ? error.message : String(error));
    });
  }
  async refresh(): Promise<void> {
    const session = this.pollGeneration;
    const states = await this.request(Opcode.State, BROADCAST);
    this.requireSession(session);
    if (states.some(response => response.result !== 0)) throw new Error('设备状态查询被拒绝');
    await this.request(Opcode.Parameters, this.selected);
    this.requireSession(session);
    if (this.selected === 0x40) await this.request(Opcode.Wheels, 0x40);
  }
  async queryParameters(id: number): Promise<Response[]> { return this.request(Opcode.Parameters, id); }
  async command(opcode: number, id: number, values: number[] = []): Promise<Response[]> {
    if (this.status.phase !== 'ready') throw new Error('未完成固件握手，禁止发送动作');
    if (this.manualPending) throw new Error('上一条操作仍在等待应答');
    this.manualPending = true;
    const session = this.pollGeneration;
    try {
      const replies = await this.request(opcode, id, values);
      this.requireSession(session);
      if (opcode === Opcode.SetLimits || opcode === Opcode.SetZero) await this.request(Opcode.Parameters, id);
      this.requireSession(session);
      await this.request(Opcode.State, id);
      return replies;
    } finally { if (session === this.pollGeneration) this.manualPending = false; }
  }
  async disconnect(): Promise<void> {
    this.generation++; this.opened = false;
    this.stopClock();
    this.cancelQueue(new Error('连接已关闭')); this.parser.reset(); this.demo = null;
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
