import { afterEach, beforeEach, describe, mock, test, type Mock } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolDemo } from '../src/lib/demo';
import { BROADCAST, DEVICES, Opcode, decodeFrame, type Response } from '../src/lib/protocol';
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
