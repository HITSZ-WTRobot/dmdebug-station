import { afterEach, beforeEach, describe, mock, test, type Mock } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolDemo } from '../src/lib/demo';
import { BROADCAST, DEVICES, Opcode, calcCrc16, decodeFrame, encodeRequest, type Response } from '../src/lib/protocol';
import { TransportManager } from '../src/lib/transport';
import type { ConnectionState } from '../src/store/atoms';

let now = 0;
let windowTimerCalls = 0;
let requestedPort: SerialBoundary;
const managers: TransportManager[] = [];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let revokeSpy: Mock<typeof URL.revokeObjectURL>;

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static failConstruction = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(readonly url: string) {
    if (ControlledWorker.failConstruction) throw new Error('Worker 创建失败');
    ControlledWorker.instances.push(this);
  }
  terminate() { this.terminated = true; }
  emit() { if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: null })); }
}

interface WriteRecord { bytes: Uint8Array; at: number; replies: Uint8Array[] }
class SerialBoundary {
  private firmware = new ProtocolDemo();
  private input!: ReadableStreamDefaultController<Uint8Array>;
  readonly writes: WriteRecord[] = [];
  filter: (replies: Uint8Array[], request: Uint8Array) => Uint8Array[] = replies => replies;
  readonly readable = new ReadableStream<Uint8Array>({ start: controller => { this.input = controller; } });
  readonly writable = new WritableStream<Uint8Array>({
    write: bytes => {
      // 只模拟串口边界；报文由真实协议演示固件编码，再经真实解包器处理。
      assert.equal(ControlledWorker.instances.filter(worker => !worker.terminated).length, 1);
      const request = bytes.slice(), replies = this.firmware.handle(request);
      this.writes.push({ bytes: request, at: now, replies });
      for (const reply of this.filter(replies, request)) this.reply(reply);
    },
  });
  async open() {}
  async close() {}
  reply(bytes: Uint8Array) { this.input.enqueue(bytes.slice()); }
}

async function flushMessages() {
  // 仅推进 Promise 与流回调，不调用任何 Window 或真实时间计时器。
  for (let i = 0; i < 64; i++) await Promise.resolve();
}
async function tick(worker: ControlledWorker, elapsed = 20) {
  now += elapsed;
  worker.emit();
  await flushMessages();
}
function latestWorker() { return ControlledWorker.instances.at(-1)!; }
function harness() {
  const port = requestedPort = new SerialBoundary();
  const responses: Response[] = [];
  let status: ConnectionState | undefined;
  const manager = new TransportManager({
    onStatus: value => { status = value; },
    onResponse: value => { responses.push(value); },
    onLog: () => {},
  });
  managers.push(manager);
  return { manager, port, responses, get status() { return status!; } };
}
function settle<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: null }), error => ({ value: undefined, error: error as Error }));
}
function editReply(frame: Uint8Array, change: (view: DataView, bytes: Uint8Array) => void) {
  const bytes = frame.slice(), view = new DataView(bytes.buffer);
  change(view, bytes); view.setUint16(62, calcCrc16(bytes, 62), true);
  return bytes;
}
async function startRemote(h: { manager: TransportManager }) {
  await h.manager.connect('web-serial');
  const starting = h.manager.startGamepadControl();
  h.manager.updateGamepadControl({ vx: 0, vy: 0, wz: 0 });
  await starting;
  assert.equal(h.manager.getGamepadState().phase, 'active');
}
function velocityOf(write: WriteRecord) {
  const view = new DataView(write.bytes.buffer, write.bytes.byteOffset);
  return [view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)];
}

beforeEach(() => {
  now = 0; windowTimerCalls = 0;
  ControlledWorker.instances = []; ControlledWorker.failConstruction = false;
  for (const name of ['window', 'navigator', 'Worker']) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: () => { windowTimerCalls++; return windowTimerCalls; },
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: { requestPort: async () => requestedPort } } });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
  mock.method(performance, 'now', () => now);
  revokeSpy = mock.method(URL, 'revokeObjectURL');
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disconnect();
  mock.restoreAll();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

test('浏览器拒绝蓝牙直连不关闭现有串口、不申请新授权，会话时钟继续工作', async () => {
  const h = harness();
  const requestPort = mock.fn(async () => h.port);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: { requestPort } } });
  const close = mock.method(h.port, 'close');
  await h.manager.connect('web-serial');
  const status = h.status, worker = latestWorker(), writes = h.port.writes.length;
  await assert.rejects(h.manager.connect('bluetooth', 'AA:BB:CC:DD:EE:FF'), /浏览器不支持经典蓝牙/);
  assert.equal(requestPort.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 0);
  assert.strictEqual(h.status, status);
  assert.equal(worker.terminated, false);
  await tick(worker, 120);
  assert.equal(h.status.phase, 'ready');
  assert.equal(h.status.mode, 'web-serial');
  assert.ok(h.port.writes.length > writes);
});

describe('连接专属 Worker 通信时钟', () => {
  test('Window 计时器完全不调度时，Worker 仍驱动心跳、九设备状态与四轮反馈', async () => {
    const h = harness();
    h.manager.selectDevice(0x40);
    await h.manager.connect('web-serial');
    assert.equal(h.status.phase, 'ready');
    assert.equal(h.status.info?.timeoutMs, 500);
    const start = h.port.writes.length;
    const responseStart = h.responses.length;
    const worker = latestWorker();
    for (let i = 0; i < 100; i++) await tick(worker);
    assert.equal(windowTimerCalls, 0);
    assert.equal(h.status.phase, 'ready');
    assert.equal(h.status.timeouts, 0);
    const writes = h.port.writes.slice(start);
    for (const [opcode, maximumGap] of [[Opcode.Heartbeat, 120], [Opcode.State, 240], [Opcode.Wheels, 440]]) {
      const scheduled = writes.filter(write => write.bytes[6] === opcode);
      assert.ok(scheduled.length > 3);
      const times = [0, ...scheduled.map(write => write.at), now];
      for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= maximumGap);
      for (const write of scheduled) {
        const sequence = new DataView(write.bytes.buffer).getUint16(4, true);
        const replies = h.responses.slice(responseStart).filter(response => response.sequence === sequence);
        assert.equal(replies.length, opcode === Opcode.State ? 9 : opcode === Opcode.Wheels ? 4 : 1);
        assert.equal(replies.every(response => response.result === 0), true);
        assert.equal(write.bytes[7], opcode === Opcode.Wheels ? 0x40 : BROADCAST);
      }
    }
    const states = h.responses.slice(responseStart).filter(response => response.type === 'motor-state' || response.type === 'chassis-state');
    assert.equal(states.every(response => !response.flags.hostLinkTimeout), true);
  });

  test('广播缺一帧不能完成，150ms 后重试完全相同的字节且只收齐后继续', async () => {
    const h = harness();
    await h.manager.connect('web-serial');
    const worker = latestWorker(), start = h.port.writes.length, responseStart = h.responses.length;
    h.port.filter = (replies, request) => request[6] === Opcode.State ? replies.slice(0, -1) : replies;
    let completed = false;
    const refresh = h.manager.refresh().then(() => { completed = true; });
    await flushMessages();
    const first = h.port.writes[start];
    assert.equal(first.replies.length, 9);
    assert.equal(completed, false);
    assert.equal(h.responses.slice(responseStart).length, 8);
    await tick(worker, 149);
    assert.equal(h.port.writes.length, start + 1);
    await tick(worker, 1);
    assert.equal(h.port.writes.length, start + 2);
    assert.deepEqual(h.port.writes[start + 1].bytes, first.bytes);
    assert.equal(h.status.timeouts, 1);
    assert.equal(completed, false);
    assert.equal(h.responses.slice(responseStart).length, 8);
    h.port.reply(first.replies.at(-1)!);
    await flushMessages();
    await refresh;
    assert.equal(completed, true);
    const states = h.responses.slice(responseStart).filter(response => response.opcode === Opcode.State);
    assert.deepEqual(states.map(response => response.id), DEVICES.map(device => device.id));
    assert.equal(h.port.writes[start + 2].bytes[6], Opcode.Parameters);
    assert.equal(windowTimerCalls, 0);
  });

  test('四轮缺一帧同样不能完成或插入心跳', async () => {
    const h = harness();
    h.manager.selectDevice(0x40);
    await h.manager.connect('web-serial');
    const worker = latestWorker(), start = h.port.writes.length;
    h.port.filter = (replies, request) => request[6] === Opcode.Wheels ? replies.slice(0, -1) : replies;
    let completed = false;
    const refresh = h.manager.refresh().then(() => { completed = true; });
    await flushMessages();
    const first = h.port.writes.at(-1)!;
    assert.equal(first.bytes[6], Opcode.Wheels);
    assert.deepEqual(first.replies.map(reply => decodeFrame(reply).id), [0x41, 0x42, 0x43, 0x44]);
    await tick(worker, 150);
    assert.equal(completed, false);
    assert.equal(h.port.writes.length, start + 4);
    assert.deepEqual(h.port.writes.at(-1)!.bytes, first.bytes);
    h.port.reply(first.replies.at(-1)!);
    await flushMessages();
    await refresh;
    assert.equal(completed, true);
  });

  test('忙时节拍不积累轮询，单一手动命令排在当前事务之后', async () => {
    const h = harness();
    await h.manager.connect('web-serial');
    const worker = latestWorker(), start = h.port.writes.length;
    h.port.filter = (replies, request) => request[6] === Opcode.Heartbeat ? [] : replies;
    await tick(worker, 100);
    const heartbeat = h.port.writes[start];
    assert.equal(heartbeat.bytes[6], Opcode.Heartbeat);
    const command = h.manager.command(Opcode.Disable, 0x0a);
    const second = await settle(h.manager.command(Opcode.Enable, 0x0a));
    assert.ok(second.error?.message?.includes('上一条操作'));
    for (let i = 0; i < 7; i++) await tick(worker);
    assert.equal(h.port.writes.length, start + 1);
    h.port.reply(heartbeat.replies[0]);
    await flushMessages();
    await command;
    assert.deepEqual(h.port.writes.slice(start).map(write => [write.bytes[6], write.bytes[7]]), [
      [Opcode.Heartbeat, BROADCAST], [Opcode.Disable, 0x0a], [Opcode.State, 0x0a],
    ]);
    h.port.filter = replies => replies;
    await tick(worker);
    assert.equal(h.port.writes.length, start + 4);
    assert.equal(h.port.writes.at(-1)!.bytes[6], Opcode.Heartbeat);
    await tick(worker);
    assert.equal(h.port.writes.length, start + 5);
    assert.equal(h.port.writes.at(-1)!.bytes[6], Opcode.State);
    assert.equal(windowTimerCalls, 0);
  });

  test('重新握手停止旧 Worker，旧握手拒绝与已排队旧 Tick 不污染新会话', async () => {
    const h = harness();
    await h.manager.connect('web-serial');
    const original = latestWorker(), oldTick = original.onmessage!;
    h.port.filter = () => [];
    const cancelled = settle(h.manager.handshake());
    await flushMessages();
    const superseded = latestWorker(), supersededTick = superseded.onmessage!;
    h.port.filter = replies => replies;
    await h.manager.handshake();
    assert.ok((await cancelled).error?.message?.includes('重新握手'));
    assert.equal(h.status.phase, 'ready');
    assert.equal(original.terminated, true);
    assert.equal(superseded.terminated, true);
    assert.equal(original.onmessage, null);
    assert.equal(superseded.onmessage, null);
    const start = h.port.writes.length;
    now += 100;
    oldTick(new MessageEvent('message')); supersededTick(new MessageEvent('message'));
    await flushMessages();
    assert.equal(h.port.writes.length, start);
    await tick(latestWorker(), 0);
    assert.equal(h.port.writes.length, start + 1);
    assert.equal(h.port.writes.at(-1)!.bytes[6], Opcode.Heartbeat);
    assert.equal(ControlledWorker.instances.filter(worker => !worker.terminated).length, 1);
    assert.ok(revokeSpy.mock.calls.some(call => call.arguments[0] === original.url));
    assert.ok(revokeSpy.mock.calls.some(call => call.arguments[0] === superseded.url));
  });

  test('断开取消在途命令；旧 Tick 在断开及重新连接后都不能发包', async () => {
    const h = harness();
    await h.manager.connect('web-serial');
    const worker = latestWorker(), oldTick = worker.onmessage!;
    h.port.filter = () => [];
    const cancelled = settle(h.manager.command(Opcode.Disable, 0x0a));
    await flushMessages();
    await h.manager.disconnect();
    assert.ok((await cancelled).error?.message?.includes('连接已关闭'));
    assert.equal(worker.terminated, true);
    assert.equal(worker.onmessage, null);
    const closedWrites = h.port.writes.length;
    now += 100;
    oldTick(new MessageEvent('message'));
    await flushMessages();
    assert.equal(h.port.writes.length, closedWrites);
    assert.equal(h.status.phase, 'disconnected');
    const replacement = requestedPort = new SerialBoundary();
    await h.manager.connect('web-serial');
    const connectedWrites = replacement.writes.length;
    now += 100;
    oldTick(new MessageEvent('message'));
    await flushMessages();
    assert.equal(replacement.writes.length, connectedWrites);
    await tick(latestWorker(), 0);
    assert.equal(replacement.writes.length, connectedWrites + 1);
    assert.equal(h.port.writes.length, closedWrites);
    assert.ok(revokeSpy.mock.calls.some(call => call.arguments[0] === worker.url));
  });

  test('握手最多重试一次，失败后无孤儿 Worker、后台请求或自动恢复', async () => {
    const h = harness();
    h.port.filter = () => [];
    const connection = settle(h.manager.connect('web-serial'));
    await flushMessages();
    const worker = latestWorker(), oldTick = worker.onmessage!;
    assert.equal(h.port.writes.length, 1);
    await tick(worker, 150);
    assert.equal(h.port.writes.length, 2);
    assert.deepEqual(h.port.writes[1].bytes, h.port.writes[0].bytes);
    await tick(worker, 150);
    assert.ok((await connection).error?.message?.includes('无完整应答'));
    assert.equal(h.status.phase, 'unresponsive');
    assert.equal(h.status.timeouts, 2);
    assert.equal(worker.terminated, true);
    assert.equal(ControlledWorker.instances.filter(item => !item.terminated).length, 0);
    assert.ok(revokeSpy.mock.calls.some(call => call.arguments[0] === worker.url));
    now += 1000;
    oldTick(new MessageEvent('message'));
    await flushMessages();
    assert.equal(h.port.writes.length, 2);
    assert.equal(windowTimerCalls, 0);
  });

  test('Worker 创建失败时释放 Blob URL，握手不发首帧', async () => {
    const h = harness();
    ControlledWorker.failConstruction = true;
    const result = await settle(h.manager.connect('web-serial'));
    assert.ok(result.error?.message?.includes('Worker 创建失败'));
    assert.equal(h.status.phase, 'unresponsive');
    assert.equal(h.port.writes.length, 0);
    assert.equal(revokeSpy.mock.callCount(), 1);
    assert.equal(ControlledWorker.instances.length, 0);
  });
});

describe('手柄单槽调度与安全退出', () => {
  test('参数核对后只使能底盘，ACK 不代替四轮实际状态', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    const start = h.port.writes.length;
    h.port.filter = (replies, request) => request[6] === Opcode.State && request[7] === 0x40 ? [] : replies;
    const starting = h.manager.startGamepadControl();
    assert.equal(h.manager.getGamepadState().phase, 'enabling');
    h.manager.updateGamepadControl({ vx: 0, vy: 0, wz: 0 }); await flushMessages();
    const state = h.port.writes.at(-1)!;
    assert.deepEqual(h.port.writes.slice(start).map(write => [write.bytes[6], write.bytes[7]]), [
      [Opcode.Parameters, 0x40], [Opcode.Enable, 0x40], [Opcode.State, 0x40],
    ]);
    h.manager.updateGamepadControl({ vx: .2, vy: 0, wz: 2 }); await tick(latestWorker(), 100);
    assert.equal(h.manager.getGamepadState().phase, 'enabling');
    assert.equal(h.port.writes.some(write => write.bytes[6] === Opcode.BodyVelocity), false);
    h.port.reply(state.replies[0]); await flushMessages(); await starting;
    assert.equal(h.manager.getGamepadState().phase, 'active');
    await tick(latestWorker(), 0);
    assert.deepEqual(velocityOf(h.port.writes.at(-1)!).map(value => Number(value.toFixed(3))), [.2, 0, 2]);
  });

  test('旧固件速度限制禁止 Enable 和满幅速度', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    const start = h.port.writes.length;
    h.port.filter = (replies, request) => request[6] === Opcode.Parameters && request[7] === 0x40
      ? replies.map(reply => editReply(reply, view => { view.setFloat32(14, .1, true); view.setFloat32(18, .1, true); view.setFloat32(26, 30, true); })) : replies;
    const result = await settle(h.manager.startGamepadControl());
    assert.match(result.error!.message, /固件版本或速度限制/);
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.deepEqual(h.port.writes.slice(start).map(write => write.bytes[6]), [Opcode.Parameters]);
  });

  test('pending 状态保持 enabling，持续输入也不能越过 600ms 反馈期限', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    h.port.filter = (replies, request) => request[6] === Opcode.State ? replies.map(reply => reply[7] === 0x40
      ? editReply(reply, (view, bytes) => { view.setUint16(14, 1 | 16, true); bytes[53] = 0; }) : reply) : replies;
    await h.manager.startGamepadControl();
    assert.equal(h.manager.getGamepadState().phase, 'enabling');
    for (let i = 0; i < 6; i++) { h.manager.updateGamepadControl({ vx: 0, vy: 0, wz: 0 }); await tick(latestWorker(), 100); }
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.equal(h.port.writes.some(write => write.bytes[6] === Opcode.BodyVelocity), false);
    assert.ok(h.port.writes.some(write => write.bytes[6] === Opcode.Disable && write.bytes[7] === BROADCAST));
  });

  test('长时间忙时只覆盖最新输入，不积累旧速度且保留比例幅度', async () => {
    const h = harness(); await startRemote(h);
    h.port.filter = (replies, request) => request[6] === Opcode.Parameters ? [] : replies;
    const query = h.manager.queryParameters(0x0a); await flushMessages();
    const held = h.port.writes.at(-1)!, start = h.port.writes.length;
    for (let i = 1; i <= 7; i++) {
      h.manager.updateGamepadControl({ vx: i / 20, vy: 0, wz: -i / 2 }); await tick(latestWorker(), 40);
    }
    assert.equal(h.port.writes.slice(start).some(write => write.bytes[6] === Opcode.BodyVelocity), false);
    h.port.reply(held.replies[0]); await flushMessages(); await query; await tick(latestWorker(), 0);
    const velocities = h.port.writes.slice(start).filter(write => write.bytes[6] === Opcode.BodyVelocity);
    assert.equal(velocities.length, 1);
    assert.deepEqual(velocityOf(velocities[0]).map(value => Number(value.toFixed(3))), [.35, 0, -3.5]);
  });

  test('100ms 速度间隔且回中只发零速，不主动失能', async () => {
    const h = harness(); await startRemote(h); const start = h.port.writes.length;
    for (let i = 0; i < 11; i++) {
      h.manager.updateGamepadControl({ vx: i < 5 ? .5 : 0, vy: 0, wz: 0 }); await tick(latestWorker(), 20);
    }
    const velocities = h.port.writes.slice(start).filter(write => write.bytes[6] === Opcode.BodyVelocity);
    assert.ok(velocities.length >= 2);
    for (let i = 1; i < velocities.length; i++) assert.ok(velocities[i].at - velocities[i - 1].at >= 100);
    assert.deepEqual(velocityOf(velocities.at(-1)!), [0, 0, 0]);
    assert.equal(h.port.writes.slice(start).some(write => write.bytes[6] === Opcode.Disable), false);
    assert.equal(h.manager.getGamepadState().phase, 'active');
  });

  test('250ms 输入过期清排队项，在途之后优先 FF 而非重放旧速度', async () => {
    const h = harness(); await startRemote(h);
    h.manager.updateGamepadControl({ vx: .5, vy: 0, wz: 0 }); await tick(latestWorker(), 0);
    h.port.filter = (replies, request) => request[6] === Opcode.Parameters ? [] : replies;
    const query = h.manager.queryParameters(0x0a); await flushMessages(); const held = h.port.writes.at(-1)!;
    const queued = settle(h.manager.queryParameters(0x21));
    await tick(latestWorker(), 140); await tick(latestWorker(), 110);
    assert.equal(h.manager.getGamepadState().phase, 'stopping');
    assert.match((await queued).error!.message, /已取消/);
    h.port.reply(held.replies[0]); await flushMessages(); await query;
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.deepEqual(h.port.writes.at(-1)!.bytes.slice(6, 8), Uint8Array.of(Opcode.Disable, BROADCAST));
    assert.equal(h.port.writes.filter(write => write.bytes[6] === Opcode.BodyVelocity).length, 1);
  });
});

describe('手柄失能屏障与连接代次', () => {
  test('FF 九帧缺一不能宣称关闭，故障逐台保留且同序号重试', async () => {
    const h = harness(); await startRemote(h);
    h.port.filter = (replies, request) => request[6] === Opcode.Disable ? replies.slice(0, -1).map((reply, index) => index === 0
      ? editReply(reply, view => view.setUint16(12, 107, true)) : reply) : replies;
    const stopping = h.manager.stopGamepadControl('测试退出'); await flushMessages();
    const disable = h.port.writes.at(-1)!;
    assert.equal(h.manager.getGamepadState().phase, 'stopping');
    await tick(latestWorker(), 150);
    assert.deepEqual(h.port.writes.at(-1)!.bytes, disable.bytes);
    assert.equal(h.manager.getGamepadState().phase, 'stopping');
    h.port.reply(disable.replies.at(-1)!); await flushMessages();
    const replies = await stopping;
    assert.equal(replies.length, 9); assert.equal(replies[0].result, 107);
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.match(h.manager.getGamepadState().message, /存在故障/);
    assert.equal(h.responses.filter(response => response.opcode === Opcode.Disable && response.result === 107).length, 1);
  });

  test('失能无应答停止整个时钟，不保持旧运动的心跳', async () => {
    const h = harness(); await startRemote(h);
    h.port.filter = (replies, request) => request[6] === Opcode.Disable ? [] : replies;
    const stopping = settle(h.manager.stopGamepadControl()); await flushMessages(); const worker = latestWorker();
    await tick(worker, 150); await tick(worker, 150);
    assert.ok((await stopping).error);
    assert.equal(h.status.phase, 'unresponsive'); assert.equal(worker.terminated, true);
    assert.match(h.manager.getGamepadState().message, /未确认全体失能/);
    const end = h.port.writes.length;
    await tick(worker, 1000); assert.equal(h.port.writes.length, end);
  });

  test('普通手动动作拒绝，顶栏 FF 取消遥控且下一 tick 不复活', async () => {
    const h = harness(); await startRemote(h);
    const refused = await settle(h.manager.command(Opcode.Enable, 0x21));
    assert.match(refused.error!.message, /请先退出遥控/);
    const replies = await h.manager.command(Opcode.Disable, BROADCAST);
    assert.equal(replies.length, 9); assert.equal(h.manager.getGamepadState().phase, 'off');
    const start = h.port.writes.length;
    h.manager.updateGamepadControl({ vx: 1, vy: 0, wz: 0 }); await tick(latestWorker(), 100);
    assert.equal(h.port.writes.slice(start).some(write => write.bytes[6] === Opcode.Enable || write.bytes[6] === Opcode.BodyVelocity), false);
  });

  test('安全失能打断 manualPending 后续链，不被手动互斥拒绝', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    h.port.filter = (replies, request) => request[6] === Opcode.Enable ? [] : replies;
    const old = settle(h.manager.command(Opcode.Enable, 0x0a)); await flushMessages();
    const enable = h.port.writes.at(-1)!;
    const stop = h.manager.command(Opcode.Disable, BROADCAST);
    h.port.reply(enable.replies[0]); await flushMessages();
    assert.match((await old).error!.message, /安全停机取消/);
    assert.equal((await stop).length, 9);
    const tail = h.port.writes.slice(h.port.writes.indexOf(enable) + 1);
    assert.deepEqual(tail.map(write => [write.bytes[6], write.bytes[7]]), [[Opcode.Disable, BROADCAST], [Opcode.State, BROADCAST]]);
  });

  test('enabling/stopping 均可顶栏失能，旧启动不能使新代次 active', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    h.port.filter = (replies, request) => request[6] === Opcode.Enable || request[6] === Opcode.Disable ? [] : replies;
    const starting = settle(h.manager.startGamepadControl()); await flushMessages();
    const enable = h.port.writes.at(-1)!;
    const stopped = h.manager.command(Opcode.Disable, BROADCAST);
    const stoppedAgain = h.manager.command(Opcode.Disable, BROADCAST);
    assert.equal(h.manager.getGamepadState().phase, 'stopping');
    h.port.reply(enable.replies[0]); await flushMessages();
    const disable = h.port.writes.at(-1)!;
    assert.equal(disable.bytes[6], Opcode.Disable);
    assert.ok((await starting).error);
    for (const reply of disable.replies) h.port.reply(reply);
    await flushMessages();
    assert.equal((await stopped).length, 9); assert.equal((await stoppedAgain).length, 9);
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.equal(h.port.writes.filter(write => write.bytes[6] === Opcode.Disable).length, 1);
    h.port.filter = replies => replies;
    await h.manager.startGamepadControl();
    assert.equal(h.manager.getGamepadState().phase, 'active');
  });

  test('断开重连使旧 start 与旧 Worker 失效，不复活新连接遥控', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    h.port.filter = (replies, request) => request[6] === Opcode.Enable ? [] : replies;
    const starting = settle(h.manager.startGamepadControl()); await flushMessages();
    const oldWorker = latestWorker(), oldTick = oldWorker.onmessage!;
    await h.manager.disconnect(); assert.ok((await starting).error);
    const replacement = requestedPort = new SerialBoundary(); await h.manager.connect('web-serial');
    const start = replacement.writes.length;
    oldTick(new MessageEvent('message')); await flushMessages();
    assert.equal(replacement.writes.length, start); assert.equal(h.manager.getGamepadState().phase, 'off');
    await h.manager.startGamepadControl(); assert.equal(h.manager.getGamepadState().phase, 'active');
  });

  test('合成幅度超限拒绝并安全退出，不允许斜推突破 1 m/s', async () => {
    const h = harness(); await startRemote(h);
    assert.throws(() => h.manager.updateGamepadControl({ vx: .8, vy: .8, wz: 0 }), /无效/);
    await flushMessages();
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.equal(h.port.writes.some(write => write.bytes[6] === Opcode.BodyVelocity), false);
  });
});

describe('手柄反馈失效与速度重试边界', () => {
  test('输入持续有效但底盘真实反馈已满 600ms 时仍退出', async () => {
    const h = harness(); await startRemote(h);
    h.port.filter = (replies, request) => request[6] === Opcode.Parameters ? [] : replies;
    const query = h.manager.queryParameters(0x0a); await flushMessages();
    now += 600;
    h.manager.updateGamepadControl({ vx: .2, vy: 0, wz: 1 });
    h.port.filter = replies => replies;
    await tick(latestWorker(), 0); await query;
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.equal(h.port.writes.some(write => write.bytes[6] === Opcode.BodyVelocity), false);
    assert.ok(h.port.writes.some(write => write.bytes[6] === Opcode.Disable && write.bytes[7] === BROADCAST));
  });

  test('新反馈四轮故障立即退出，不因 Enable ACK 成功继续发速度', async () => {
    const h = harness(); await startRemote(h);
    h.port.filter = (replies, request) => request[6] === Opcode.State ? replies.map(reply => reply[7] === 0x40
      ? editReply(reply, (view, bytes) => { view.setUint16(14, 1 | 8 | 128, true); bytes[54] = 1; }) : reply) : replies;
    await h.manager.refresh(); await flushMessages();
    assert.equal(h.manager.getGamepadState().phase, 'off');
    assert.ok(h.port.writes.some(write => write.bytes[6] === Opcode.Disable && write.bytes[7] === BROADCAST));
  });

  test('未应答速度动作绝不重发旧目标，关闭通信时钟等待下位机停用', async () => {
    const h = harness(); await startRemote(h);
    h.port.filter = (replies, request) => request[6] === Opcode.BodyVelocity ? [] : replies;
    h.manager.updateGamepadControl({ vx: .5, vy: 0, wz: 1 });
    await tick(latestWorker(), 0);
    h.manager.updateGamepadControl({ vx: .1, vy: 0, wz: 0 });
    await tick(latestWorker(), 150);
    assert.equal(h.port.writes.filter(write => write.bytes[6] === Opcode.BodyVelocity).length, 1);
    assert.equal(h.status.phase, 'unresponsive');
    assert.equal(latestWorker().terminated, true);
    assert.equal(h.manager.getGamepadState().phase, 'off');
  });
});

describe('M2006 输出轴速度契约', () => {
  test('速度持续跨越整圈，可直接反向更新；停止归零但保持使能，失能不恢复旧目标', () => {
    const demo = new ProtocolDemo(); let sequence = 0;
    const send = (opcode: number, values: number[] = []) => decodeFrame(demo.handle(encodeRequest(++sequence, opcode, 0x21, values))[0]);
    const state = () => { const response = send(Opcode.State); if (response.type !== 'motor-state') throw new Error('缺少电机状态'); return response; };
    assert.equal(send(Opcode.Enable).result, 0);
    assert.equal(send(Opcode.MotorVelocity, [300]).result, 0);
    let moving = state();
    for (let i = 0; i < 5; i++) { now += 200; moving = state(); }
    assert.ok(moving.position > 360);
    assert.equal(moving.unit, 'rpm'); assert.equal(moving.target, 300);
    assert.equal(moving.velocity, 300); assert.equal(moving.referenceVelocity, 300); assert.equal(moving.reference, null);
    assert.equal(moving.flags.busy, false); assert.equal(moving.flags.motionComplete, false);
    assert.equal(moving.flags.zeroed, false); assert.equal(moving.flags.limitsConfigured, false);
    assert.equal(send(Opcode.MotorVelocity, [-300]).result, 0);
    now += 200; const reversing = state(); assert.ok(reversing.position < moving.position); assert.equal(reversing.velocity, -300);
    assert.equal(send(Opcode.Stop).result, 0);
    const stopped = state(); assert.equal(stopped.flags.enabled, true); assert.equal(stopped.target, 0); assert.equal(stopped.velocity, 0);
    now += 200; assert.equal(state().position, stopped.position);
    assert.equal(send(Opcode.MotorVelocity, [120]).result, 0);
    assert.equal(send(Opcode.Disable).result, 0);
    assert.equal(state().flags.enabled, false); assert.equal(state().target, 0); assert.equal(state().referenceVelocity, 0);
    assert.equal(send(Opcode.MotorVelocity, [30]).result, 3);
    now += 100; assert.equal(send(Opcode.Enable).result, 0); assert.equal(state().target, 0);
  });

  test('速度范围与非有限请求拒绝且保留有效参考，旧位置命令不能驱动速度设备', () => {
    const demo = new ProtocolDemo(); let sequence = 0;
    const send = (opcode: number, id = 0x21, values: number[] = []) => decodeFrame(demo.handle(encodeRequest(++sequence, opcode, id, values))[0]);
    send(Opcode.Enable); assert.equal(send(Opcode.MotorVelocity, 0x21, [100]).result, 0);
    for (const rpm of [-300.01, 300.01]) assert.equal(send(Opcode.MotorVelocity, 0x21, [rpm]).result, 6);
    for (const rpm of [NaN, Infinity, -Infinity]) {
      assert.throws(() => encodeRequest(++sequence, Opcode.MotorVelocity, 0x21, [rpm]));
      const malformed = editReply(encodeRequest(++sequence, Opcode.MotorVelocity, 0x21, [0]), view => view.setFloat32(12, rpm, true));
      assert.equal(decodeFrame(demo.handle(malformed)[0]).result, 5);
    }
    assert.equal(send(Opcode.Move, 0x21, [90]).result, 105); assert.equal(send(Opcode.SetZero).result, 105);
    for (const id of [0x0a, 0x40]) assert.equal(send(Opcode.MotorVelocity, id, [90]).result, 105);
    const state = send(Opcode.State); if (state.type !== 'motor-state') throw new Error('缺少电机状态');
    assert.equal(state.target, 100); assert.equal(state.referenceVelocity, 100);
  });

  test('新参数六字段，拒绝旧 kind3、角度单位与50字节位置参数', () => {
    const demo = new ProtocolDemo();
    const info = demo.handle(encodeRequest(1, Opcode.Info, BROADCAST))[0];
    assert.throws(() => decodeFrame(editReply(info, (_, bytes) => { bytes[39] = bytes[40] = 3; })));
    const parameters = demo.handle(encodeRequest(2, Opcode.Parameters, 0x21))[0];
    const decoded = decodeFrame(parameters); if (decoded.type !== 'dji-parameters') throw new Error('缺少速度参数');
    assert.equal(decoded.maxRpm, 300); assert.equal(decoded.stationaryRpm, Math.fround(.1));
    assert.equal('positionPd' in decoded, false); assert.equal('profile' in decoded, false); assert.equal('finish' in decoded, false);
    assert.throws(() => decodeFrame(editReply(parameters, view => view.setUint16(8, 50, true))));
    const state = demo.handle(encodeRequest(3, Opcode.State, 0x21))[0];
    for (const change of [(bytes: Uint8Array) => { bytes[16] = 3; }, (bytes: Uint8Array) => { bytes[17] = 1; }]) {
      assert.throws(() => decodeFrame(editReply(state, (_, bytes) => change(bytes))));
    }
  });

  test('失联清目标并锁存；心跳不会自动复活，静止反馈后显式使能恢复零速度', () => {
    const demo = new ProtocolDemo(); let sequence = 0;
    const send = (opcode: number, values: number[] = [], id = 0x21) => decodeFrame(demo.handle(encodeRequest(++sequence, opcode, id, values))[0]);
    const state = () => { const response = send(Opcode.State); if (response.type !== 'motor-state') throw new Error('缺少电机状态'); return response; };
    send(Opcode.Enable); send(Opcode.MotorVelocity, [200]); now += 500;
    const fault = state(); assert.equal(fault.flags.fault, true); assert.equal(fault.flags.enabled, false); assert.equal(fault.target, 0);
    assert.equal(send(Opcode.Enable).result, 107);
    send(Opcode.Heartbeat, [], BROADCAST); assert.equal(state().flags.fault, true);
    assert.equal(send(Opcode.Disable).result, 0); assert.equal(send(Opcode.Enable).result, 7);
    now += 100; assert.equal(state().flags.enabled, false);
    assert.equal(send(Opcode.Enable).result, 0); const recovered = state();
    assert.equal(recovered.flags.fault, false); assert.equal(recovered.target, 0); assert.equal(recovered.velocity, 0);
  });

  test('旧kind3固件握手不可进入ready', async () => {
    const h = harness();
    h.port.filter = (replies, request) => request[6] === Opcode.Info ? replies.map(reply => editReply(reply, (_, bytes) => { bytes[39] = bytes[40] = 3; })) : replies;
    const connection = settle(h.manager.connect('web-serial')); await flushMessages();
    const worker = latestWorker(); await tick(worker, 150); await tick(worker, 150);
    assert.ok((await connection).error); assert.notEqual(h.status.phase, 'ready');
    assert.equal(h.port.writes.some(write => write.bytes[6] === Opcode.MotorVelocity), false);
  });

  test('网页手动速度成功发0x28，未获ACK不重发旧速度', async () => {
    const h = harness(); await h.manager.connect('web-serial');
    await h.manager.command(Opcode.Enable, 0x21);
    const accepted = await h.manager.command(Opcode.MotorVelocity, 0x21, [-120]); assert.equal(accepted[0].result, 0);
    h.port.filter = (replies, request) => request[6] === Opcode.MotorVelocity ? [] : replies;
    const start = h.port.writes.length, pending = settle(h.manager.command(Opcode.MotorVelocity, 0x21, [80]));
    await flushMessages(); await tick(latestWorker(), 150);
    assert.ok((await pending).error); assert.equal(h.port.writes.slice(start).filter(write => write.bytes[6] === Opcode.MotorVelocity).length, 1);
    assert.equal(h.status.phase, 'unresponsive');
  });
});
