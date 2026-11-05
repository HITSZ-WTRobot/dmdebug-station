import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeTransportAdapter, type NativeBridge, type NativeStatus } from '../src/lib/native-transport';
import { ProtocolDemo } from '../src/lib/demo';
import { BROADCAST, Opcode, encodeRequest, type Response } from '../src/lib/protocol';
import type { ConnectionState } from '../src/store/atoms';

type Subscription = { name: string; callback: (event: { payload: unknown }) => void; disposed: boolean; complete: () => void };
class NativeBoundary implements NativeBridge {
  readonly subscriptions: Subscription[] = [];
  readonly calls: { command: string; args?: Record<string, unknown> }[] = [];
  readonly pending: { command: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  delayListeners = false;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    if (command === 'native_disconnect' || command === 'native_select_device') return Promise.resolve(undefined as T);
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.push({ command, resolve: value => resolve(value as T), reject });
    return promise;
  }
  listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void> {
    const { promise, resolve } = Promise.withResolvers<() => void>();
    const subscription: Subscription = { name, callback: callback as Subscription['callback'], disposed: false,
      complete: () => resolve(() => { subscription.disposed = true; }) };
    this.subscriptions.push(subscription);
    if (!this.delayListeners) subscription.complete();
    return promise;
  }
  emit(name: string, payload: unknown) {
    for (const subscription of this.subscriptions) if (subscription.name === name && !subscription.disposed) subscription.callback({ payload });
  }
  finish(command: string, value?: unknown) {
    const index = this.pending.findIndex(call => call.command === command);
    assert.notEqual(index, -1, `必须实际调用 ${command}`);
    this.pending.splice(index, 1)[0].resolve(value);
  }
  fail(command: string, message: string) {
    const index = this.pending.findIndex(call => call.command === command);
    assert.notEqual(index, -1);
    this.pending.splice(index, 1)[0].reject(new Error(message));
  }
}
const adapters: NativeTransportAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.disconnect(); });
async function flushMessages() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
interface Harness { adapter: NativeTransportAdapter; api: NativeBoundary; statuses: ConnectionState[]; responses: Response[]; errors: string[] }
function harness(api = new NativeBoundary()): Harness {
  const statuses: ConnectionState[] = [], responses: Response[] = [], errors: string[] = [];
  const adapter = new NativeTransportAdapter({ onStatus: status => statuses.push(status), onResponse: response => responses.push(response),
    onLog: (level, message) => { if (level === 'error') errors.push(message); } }, api);
  adapters.push(adapter);
  return { adapter, api, statuses, responses, errors };
}
const ready: NativeStatus = { mode: 'tauri', phase: 'ready', portOpen: true, portName: 'COM_TEST', message: 'Rust 已完成握手',
  lastRxAt: 123, infoFrame: null, txFrames: 8, rxFrames: 9, crcErrors: 0, timeouts: 0 };
function fixture(opcode: number, id: number) {
  // 固定展示帧来自既有协议模型；mock IPC 不解析、回显或模拟通信调度。
  return Array.from(new ProtocolDemo().handle(encodeRequest(7, opcode, id))[0]);
}
async function connect(h: Harness) {
  const connecting = h.adapter.connect('tauri', 'COM_TEST');
  await flushMessages();
  h.api.emit('native-status', { ...ready, phase: 'opening', infoFrame: null });
  h.api.emit('native-status', ready);
  h.api.finish('native_connect');
  await connecting;
}

test('ready 在 invoke 完成前不展示；Rust 事件帧仅解码展示且不触发新请求', async () => {
  const h = harness();
  const connecting = h.adapter.connect('demo');
  await flushMessages();
  const infoFrame = fixture(Opcode.Info, BROADCAST);
  h.api.emit('native-status', { ...ready, mode: 'demo', phase: 'opening' });
  h.api.emit('native-status', { ...ready, mode: 'demo', infoFrame });
  assert.equal(h.statuses.at(-1)?.phase, 'handshaking');
  assert.equal(h.statuses.at(-1)?.info?.type, 'info');
  h.api.finish('native_connect');
  await connecting;
  assert.equal(h.statuses.at(-1)?.phase, 'ready');
  const calls = h.api.calls.length;
  h.api.emit('native-response', fixture(Opcode.State, 0x40));
  assert.equal(h.responses.length, 1);
  assert.equal(h.responses[0].type, 'chassis-state');
  assert.ok(h.responses[0].raw instanceof Uint8Array);
  assert.equal(h.api.calls.length, calls);
  assert.deepEqual(h.api.calls[0], { command: 'native_connect', args: { mode: 'demo', portName: '' } });
});

test('失败的握手和随后迟到的 ready 事件不能让消费者显示已就绪', async () => {
  const h = harness();
  const connecting = h.adapter.connect('tauri', 'COM_TEST');
  const rejected = assert.rejects(connecting, /握手未收齐/);
  await flushMessages();
  h.api.emit('native-status', { ...ready, phase: 'opening' });
  h.api.emit('native-status', ready);
  h.api.fail('native_connect', '握手未收齐');
  await rejected;
  h.api.emit('native-status', ready);
  assert.equal(h.statuses.at(-1)?.phase, 'unresponsive');
  assert.equal(h.statuses.some(status => status.phase === 'ready'), false);
});

test('断开使在途 connect 与捕获的旧事件失效，不发布迟到的 ready 或应答', async () => {
  const h = harness();
  const connecting = h.adapter.connect('tauri', 'COM_TEST');
  const rejected = assert.rejects(connecting, /已取消/);
  await flushMessages();
  const oldStatus = h.api.subscriptions.filter(item => item.name === 'native-status').at(-1)!;
  const oldResponse = h.api.subscriptions.filter(item => item.name === 'native-response').at(-1)!;
  await h.adapter.disconnect();
  const count = h.statuses.length;
  oldStatus.callback({ payload: ready });
  oldResponse.callback({ payload: fixture(Opcode.State, 0x40) });
  h.api.finish('native_connect');
  await rejected;
  assert.equal(h.statuses.length, count);
  assert.equal(h.statuses.at(-1)?.phase, 'disconnected');
  assert.equal(h.responses.length, 0);
  assert.ok(h.api.subscriptions.every(item => item.disposed));
});

test('listen 返回晚于断开时释放全部订阅，而且不再打开原生连接', async () => {
  const api = new NativeBoundary(); api.delayListeners = true;
  const h = harness(api);
  const connecting = h.adapter.connect('demo');
  const rejected = assert.rejects(connecting, /已取消/);
  await h.adapter.disconnect();
  for (const subscription of api.subscriptions) subscription.complete();
  await rejected;
  await flushMessages();
  assert.ok(api.subscriptions.every(item => item.disposed));
  assert.equal(api.calls.some(call => call.command === 'native_connect'), false);
});

test('React 重建实例后旧清理和迟到回调不能断开或污染新实例', async () => {
  const api = new NativeBoundary(), old = harness(api);
  await connect(old);
  const oldStatus = api.subscriptions.filter(item => item.name === 'native-status').at(-1)!;
  const current = harness(api);
  await connect(current);
  const count = api.calls.length, statusCount = old.statuses.length;
  await old.adapter.disconnect();
  oldStatus.callback({ payload: { ...ready, phase: 'unresponsive' } });
  assert.equal(api.calls.length, count);
  assert.equal(old.statuses.length, statusCount);
  assert.equal(current.statuses.at(-1)?.phase, 'ready');
});

test('桌面 Web Serial 被明确拒绝，不发送连接 IPC', async () => {
  const h = harness();
  await assert.rejects(h.adapter.connect('web-serial'), /请使用原生串口/);
  assert.equal(h.api.calls.length, 0);
});

test('取消的 command 不返回旧动作结果，动作回读不由前端重新发起', async () => {
  const h = harness();
  await connect(h);
  const command = h.adapter.command(Opcode.Disable, 0x40);
  const rejected = assert.rejects(command, /已取消/);
  await flushMessages();
  assert.deepEqual(h.api.calls.at(-1), { command: 'native_command', args: { opcode: Opcode.Disable, deviceId: 0x40, values: [] } });
  await h.adapter.disconnect();
  h.api.finish('native_command', [fixture(Opcode.Disable, 0x40)]);
  await rejected;
  assert.equal(h.api.calls.some(call => call.command === 'native_query_parameters' || call.command === 'native_refresh'), false);
});

test('新的 opening 边界前忽略旧会话全局应答和 ready，不污染新显示', async () => {
  const h = harness();
  const connecting = h.adapter.connect('tauri', 'COM_TEST');
  await flushMessages();
  h.api.emit('native-status', ready);
  h.api.emit('native-response', fixture(Opcode.State, 0x40));
  assert.equal(h.statuses.at(-1)?.phase, 'opening');
  assert.equal(h.responses.length, 0);
  h.api.emit('native-status', { ...ready, phase: 'opening' });
  h.api.emit('native-response', fixture(Opcode.State, 0x40));
  h.api.emit('native-status', ready);
  h.api.finish('native_connect');
  await connecting;
  assert.equal(h.responses.length, 1);
  assert.equal(h.statuses.at(-1)?.phase, 'ready');
});
