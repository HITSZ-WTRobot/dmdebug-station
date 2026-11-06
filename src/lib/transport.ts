import { invoke } from '@tauri-apps/api/core';
import { NativeTransportAdapter } from './native-transport';
import { BROADCAST, Opcode, OPCODE_NAMES, StreamUnpacker, bytesToHex, encodeRequest, expectedResponseIds, hexId, resultName,
  type Response, type Info, type ProtocolIssue, type BodyVelocity, type ChassisState } from './protocol';
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
export interface GamepadControlState { phase: 'off' | 'enabling' | 'active' | 'stopping'; message: string }
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
  private native: NativeTransportAdapter | null = null;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  // 遥控和普通事务共用写口；遥控速度只保留最新输入，不进入积压队列。
  private gamepadState: GamepadControlState = { phase: 'off', message: '手柄遥控未开启' };
  private gamepadGeneration = 0;
  private actionGeneration = 0;
  private gamepadInput: BodyVelocity | null = null;
  private gamepadInputAt = 0;
  private gamepadStartedAt = 0;
  private lastGamepadVelocity = -Infinity;
  private gamepadEnableAcknowledged = false;
  private lastChassisState: ChassisState | null = null;
  private lastChassisStateAt = -Infinity;
  private gamepadStop: Promise<Response[]> | null = null;
  constructor(private callbacks: TransportCallbacks) {
    this.status = { mode: isTauriEnvironment() ? 'tauri' : 'web-serial', phase: 'disconnected', portOpen: false, portName: '',
      message: '尚未连接；不会自动启动演示', lastRxAt: 0, info: null, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0 };
    this.parser = new StreamUnpacker(issue => this.protocolIssue(issue));
    if (isTauriEnvironment()) this.native = new NativeTransportAdapter({ ...callbacks, onStatus: status => { this.status = status; callbacks.onStatus(status); } });
  }
  private publish(patch: Partial<ConnectionState> = {}) {
    this.status = { ...this.status, ...patch }; this.callbacks.onStatus({ ...this.status });
  }
  private protocolIssue(issue: ProtocolIssue) {
    if (issue.kind === 'crc') { this.publish({ crcErrors: this.status.crcErrors + 1 }); this.callbacks.onLog('warn', issue.message); }
    else if (issue.kind === 'version') this.fail(issue.message, 'incompatible');
    else this.callbacks.onLog('warn', `丢弃无效应答：${issue.message}`);
  }
  selectDevice(id: number) {
    this.selected = id;
    if (this.native) void this.native.selectDevice(id).catch(error => this.callbacks.onLog('error', String(error)));
  }
  getGamepadState(): GamepadControlState { return this.native ? this.native.getGamepadState() : { ...this.gamepadState }; }
  private resetGamepad(message: string) {
    this.gamepadGeneration++; this.actionGeneration++;
    this.gamepadInput = null; this.gamepadEnableAcknowledged = false; this.gamepadStop = null;
    this.lastChassisState = null; this.lastChassisStateAt = -Infinity;
    this.gamepadState = { phase: 'off', message };
  }
  private requireGamepad(generation: number) {
    if (generation !== this.gamepadGeneration || this.gamepadState.phase === 'off' || this.gamepadState.phase === 'stopping') throw new Error('本次手柄遥控已取消');
  }
  private chassisReady(state: ChassisState) {
    return state.result === 0 && state.onlineMask === 15 && state.enabledMask === 15 && state.faultMask === 0 &&
      state.flags.connected && state.flags.enabled && !state.flags.enablePending && !state.flags.fault && !state.flags.hostLinkTimeout;
  }
  private receiveChassisState(state: ChassisState) {
    this.lastChassisState = state; this.lastChassisStateAt = performance.now();
    if (!this.gamepadEnableAcknowledged) return;
    if (this.gamepadState.phase === 'enabling' && this.chassisReady(state)) {
      this.gamepadState = { phase: 'active', message: '底盘四轮新反馈确认使能；摇杆回中只发送零速' };
    } else if ((this.gamepadState.phase === 'active' && !this.chassisReady(state)) ||
      (this.gamepadState.phase === 'enabling' && (state.result !== 0 || state.faultMask !== 0 || state.flags.fault || state.flags.hostLinkTimeout))) {
      void this.stopGamepadControl('底盘反馈异常，退出遥控').catch(() => {});
    }
  }
  async startGamepadControl(): Promise<Response[]> {
    if (this.native) throw new Error('桌面手柄只能由 Rust 原生采集开启，请使用原生手柄面板');
    if (this.status.phase !== 'ready') throw new Error('未完成固件握手，禁止开启遥控');
    if (this.gamepadState.phase !== 'off') throw new Error('手柄遥控尚未退出');
    if (this.manualPending) throw new Error('上一条操作仍在等待应答');
    const generation = ++this.gamepadGeneration;
    this.actionGeneration++;
    this.gamepadInput = null; this.gamepadInputAt = this.gamepadStartedAt = performance.now();
    this.lastGamepadVelocity = -Infinity; this.gamepadEnableAcknowledged = false;
    this.lastChassisState = null; this.lastChassisStateAt = -Infinity;
    this.gamepadState = { phase: 'enabling', message: '正在核对固件速度限制；仅请求底盘 0x40 使能' };
    let enableRequested = false;
    try {
      const parameters = await this.request(Opcode.Parameters, 0x40);
      this.requireGamepad(generation);
      const limits = parameters.find(response => response.type === 'chassis-parameters');
      if (!limits || limits.result !== 0 || !(limits.maxVx >= 1 && limits.maxVy >= 1 && limits.maxWz >= 10 && limits.maxWheelRpm >= 160)) {
        throw new Error('固件版本或速度限制不匹配：手柄遥控需要平移至少 1 m/s、旋转 10°/s、轮速上限至少 160 rpm；请更新下位机固件');
      }
      enableRequested = true;
      const replies = await this.request(Opcode.Enable, 0x40);
      this.requireGamepad(generation);
      if (replies.some(response => response.result !== 0)) throw new Error(`底盘使能失败：${resultName(replies[0].result)}`);
      this.gamepadEnableAcknowledged = true; this.gamepadStartedAt = performance.now();
      this.gamepadState = { phase: 'enabling', message: '使能请求已应答，等待底盘四轮实际反馈确认' };
      await this.request(Opcode.State, 0x40);
      this.requireGamepad(generation);
      return replies;
    } catch (error) {
      if (generation === this.gamepadGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        if (enableRequested) await this.stopGamepadControl(message).catch(() => {});
        else { this.gamepadInput = null; this.gamepadState = { phase: 'off', message }; }
      }
      throw error;
    }
  }
  updateGamepadControl(target: BodyVelocity): void {
    if (this.native) throw new Error('桌面版不接受前端手柄采样输入');
    if (this.gamepadState.phase !== 'enabling' && this.gamepadState.phase !== 'active') return;
    if (![target.vx, target.vy, target.wz].every(Number.isFinite) || Math.hypot(target.vx, target.vy) > 1 || Math.abs(target.wz) > 10) {
      void this.stopGamepadControl('手柄输入超出平移 1 m/s / 旋转 10°/s 安全范围').catch(() => {});
      throw new Error('无效的手柄速度；已请求退出遥控');
    }
    this.gamepadInput = { vx: target.vx, vy: target.vy, wz: target.wz }; this.gamepadInputAt = performance.now();
  }
  stopGamepadControl(reason = '用户退出手柄遥控'): Promise<Response[]> {
    if (this.native) return Promise.reject(new Error('桌面手柄请通过原生手柄面板停止'));
    if (this.gamepadStop) return this.gamepadStop;
    if (this.gamepadState.phase === 'off') return Promise.resolve([]);
    const generation = ++this.gamepadGeneration;
    this.actionGeneration++;
    this.manualPending = false;
    this.gamepadInput = null; this.gamepadEnableAcknowledged = false;
    this.gamepadState = { phase: 'stopping', message: `${reason}；正在等待九设备失能应答，软件停机不保证物理停止` };
    // 不打断在途事务，也不允许旧手动动作的后续查询越过失能屏障。
    this.queue.splice(0).forEach(transaction => transaction.reject(new Error('遥控已退出，排队操作已取消')));
    const operation = this.request(Opcode.Disable, BROADCAST, [], true).then(replies => {
      if (generation === this.gamepadGeneration) {
        const faults = replies.filter(response => response.result !== 0);
        this.gamepadState = { phase: 'off', message: faults.length
          ? `已收齐九设备失能应答，存在故障：${faults.map(response => `${hexId(response.id)} ${resultName(response.result)}`).join('；')}；软件停机不保证物理停止`
          : '已收齐九设备失能应答；软件停机不保证物理停止' };
      }
      return replies;
    }).catch(error => {
      if (generation === this.gamepadGeneration) this.fail(`未确认全体失能：${error instanceof Error ? error.message : error}`);
      throw error;
    }).finally(() => { if (generation === this.gamepadGeneration) this.gamepadStop = null; });
    this.gamepadStop = operation;
    return operation;
  }
  private tickGamepad(now: number) {
    const phase = this.gamepadState.phase;
    if (phase !== 'enabling' && phase !== 'active') return;
    let reason = '';
    if (now - this.gamepadInputAt >= 250) reason = '手柄输入超过 250 ms 未刷新';
    else if (phase === 'active' && (now - this.lastChassisStateAt >= 600 || !this.lastChassisState || !this.chassisReady(this.lastChassisState))) reason = '底盘反馈过期或异常';
    else if (phase === 'enabling' && now - this.gamepadStartedAt >= 600) reason = '底盘未在 600 ms 内确认实际使能';
    if (reason) { void this.stopGamepadControl(reason).catch(() => {}); return; }
    if (phase !== 'active' || !this.gamepadInput || this.active || this.queue.length || now - this.lastGamepadVelocity < 100) return;
    // 不重试速度动作；忙时仅覆盖输入，空闲时读取最新且未过期的值。
    const target = this.gamepadInput, generation = this.gamepadGeneration;
    this.lastGamepadVelocity = now;
    void this.request(Opcode.BodyVelocity, 0x40, [target.vx, target.vy, target.wz]).then(replies => {
      if (generation === this.gamepadGeneration && replies.some(response => response.result !== 0)) return this.stopGamepadControl('底盘拒绝速度指令');
    }).catch(error => {
      if (generation === this.gamepadGeneration) this.fail(`遥控速度未获确认：${error instanceof Error ? error.message : error}`);
    });
  }
  private request(opcode: number, id: number, values: number[] = [], priority = false): Promise<Response[]> {
    if (!this.opened) return Promise.reject(new Error('串口尚未打开'));
    if (!this.clock) return Promise.reject(new Error('通信时钟未启动，请重新握手'));
    const sequence = this.sequence; this.sequence = (this.sequence + 1) & 0xffff;
    let bytes: Uint8Array;
    try { bytes = encodeRequest(sequence, opcode, id, values); } catch (error) { return Promise.reject(error); }
    const { promise, resolve, reject } = Promise.withResolvers<Response[]>();
    const transaction: Transaction = { sequence, opcode, id, bytes, expected: new Set(expectedResponseIds(opcode, id)), responses: new Map(), retries: opcode === Opcode.BodyVelocity || opcode === Opcode.MotorVelocity ? 0 : 1, deadline: 0, resolve, reject };
    if (priority) this.queue.unshift(transaction); else this.queue.push(transaction);
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
    } else { if (!this.writer) throw new Error('串口写入流尚未就绪'); await this.writer.write(new Uint8Array(bytes)); }
  }
  private incoming(chunk: Uint8Array) {
    const frames = this.parser.feed(chunk);
    for (const response of frames) {
      this.publish({ rxFrames: this.status.rxFrames + 1 });
      this.callbacks.onLog(response.result ? 'warn' : 'rx', `#${response.sequence} ${OPCODE_NAMES[response.opcode] ?? response.opcode} · ${hexId(response.id)} · ${resultName(response.result)}`, bytesToHex(response.raw));
      const transaction = this.active;
      if (!transaction || response.sequence !== transaction.sequence || response.opcode !== transaction.opcode) continue;
      const terminalError = response.result !== 0 && response.id === transaction.id && !(transaction.opcode === Opcode.Disable && transaction.id === BROADCAST);
      if (!transaction.expected.has(response.id) && !terminalError) continue;
      if (transaction.responses.has(response.id)) continue;
      transaction.responses.set(response.id, response);
      this.publish({ lastRxAt: Date.now() });
      this.callbacks.onResponse(response);
      if (response.type === 'chassis-state') this.receiveChassisState(response);
      else if (response.opcode === Opcode.State && response.result !== 0 && (response.id === 0x40 || response.id === BROADCAST) &&
        (this.gamepadState.phase === 'active' || this.gamepadState.phase === 'enabling')) {
        void this.stopGamepadControl('底盘状态查询被拒绝，退出遥控').catch(() => {});
      }
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
    this.resetGamepad(`遥控已退出；${message}。未确认全体失能，软件停机不保证物理停止`);
    this.cancelQueue(new Error(message));
    this.publish({ phase, message }); this.callbacks.onLog('error', message);
  }
  async connect(mode: TransportMode, portName = ''): Promise<void> {
    if (this.native) return this.native.connect(mode, portName);
    if (mode === 'tauri') throw new Error('浏览器版无法使用原生串口，请选择 Web Serial');
    await this.disconnect(); const generation = this.generation;
    this.publish({ mode, phase: 'opening', portOpen: false, portName: mode === 'demo' ? '协议演示 · 无硬件连接' : mode === 'web-serial' ? '浏览器串口' : portName,
      message: '正在打开传输端口', info: null, lastRxAt: 0, txFrames: 0, rxFrames: 0, crcErrors: 0, timeouts: 0 });
    try {
      if (mode === 'demo') this.demo = new ProtocolDemo();
      else {
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
    if (this.native) return this.native.handshake();
    if (!this.opened) throw new Error('请先打开串口');
    this.stopClock();
    this.resetGamepad('重新握手，手柄遥控已退出；需重新手动开启');
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
    const now = performance.now();
    this.tickGamepad(now);
    const transaction = this.active;
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
    if (!this.opened || this.status.phase !== 'ready' || this.queue.length || this.manualPending || this.gamepadState.phase === 'stopping') return;
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
    if (this.native) return this.native.refresh();
    const session = this.pollGeneration;
    const states = await this.request(Opcode.State, BROADCAST);
    this.requireSession(session);
    if (states.some(response => response.result !== 0)) throw new Error('设备状态查询被拒绝');
    await this.request(Opcode.Parameters, this.selected);
    this.requireSession(session);
    if (this.selected === 0x40) await this.request(Opcode.Wheels, 0x40);
  }
  async queryParameters(id: number): Promise<Response[]> { return this.native ? this.native.queryParameters(id) : this.request(Opcode.Parameters, id); }
  async command(opcode: number, id: number, values: number[] = []): Promise<Response[]> {
    if (this.native) return this.native.command(opcode, id, values);
    if (this.status.phase !== 'ready') throw new Error('未完成固件握手，禁止发送动作');
    const safe = opcode === Opcode.Disable || opcode === Opcode.Stop;
    if (this.gamepadState.phase !== 'off') {
      if (!safe) throw new Error('请先退出遥控，再执行普通手动操作');
      const stoppingSession = this.pollGeneration;
      const stopped = await this.stopGamepadControl('手动安全操作取消手柄遥控');
      this.requireSession(stoppingSession);
      if (opcode === Opcode.Disable && id === BROADCAST) return stopped;
    }
    if (this.manualPending && !safe) throw new Error('上一条操作仍在等待应答');
    if (safe) {
      this.actionGeneration++;
      this.queue.splice(0).forEach(transaction => transaction.reject(new Error('安全操作已取消排队动作')));
    }
    this.manualPending = true;
    const session = this.pollGeneration, action = this.actionGeneration;
    const requireAction = () => {
      this.requireSession(session);
      if (action !== this.actionGeneration) throw new Error('操作已被安全停机取消');
    };
    try {
      const replies = await this.request(opcode, id, values, safe);
      requireAction();
      if (opcode === Opcode.SetLimits || opcode === Opcode.SetZero) await this.request(Opcode.Parameters, id);
      requireAction();
      await this.request(Opcode.State, id);
      requireAction();
      return replies;
    } finally { if (session === this.pollGeneration && action === this.actionGeneration) this.manualPending = false; }
  }
  async disconnect(): Promise<void> {
    if (this.native) return this.native.disconnect();
    this.generation++; this.opened = false;
    this.resetGamepad('连接已关闭，手柄遥控已退出；断开通讯不保证电机停止');
    this.stopClock();
    this.cancelQueue(new Error('连接已关闭')); this.parser.reset(); this.demo = null;
    const reader = this.reader; this.reader = null;
    if (reader) { try { await reader.cancel(); } catch { /* Already closed by the OS. */ } reader.releaseLock(); }
    const writer = this.writer; this.writer = null;
    if (writer) writer.releaseLock();
    const port = this.port; this.port = null;
    if (port) { try { await port.close(); } catch { this.callbacks.onLog('warn', '端口已由系统关闭'); } }
    this.publish({ phase: 'disconnected', portOpen: false, message: '已断开；断开通讯不等于实际电机已失能', info: null });
  }
}
