import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gamepadIdentity, readGamepadInput, resetToggle, stepToggle, type GamepadSample } from '../src/lib/gamepad';

function pad(axes = [0, 0, 0, 0], pressed = false): GamepadSample {
  return { id: 'Generic USB 双摇杆', index: 1, mapping: '', connected: true, axes,
    buttons: Array.from({ length: 10 }, (_, index) => ({ value: index === 9 && pressed ? 1 : 0, pressed: index === 9 && pressed })) };
}
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`);
}
function input(sample: GamepadSample) {
  const result = readGamepadInput(sample);
  if (!result.valid) assert.fail(result.reason);
  return result;
}
// 和浏览器消费者一样，以同一份输入同时驱动预览与 Start 门禁，不依赖真实等待。
function controller() {
  let state = resetToggle(gamepadIdentity(pad()));
  return {
    get armed() { return state.armed; },
    get pressed() { return state.pressed; },
    step(nowMs: number, sample = pad(), generation = 0) {
      const result = readGamepadInput(sample);
      const next = stepToggle(state, { identity: gamepadIdentity(sample, generation), nowMs,
        valid: result.valid, neutral: result.valid && result.neutral, pressed: result.valid && result.pressed });
      state = next.state;
      return next.action;
    },
    reset() { state = resetToggle(gamepadIdentity(pad())); },
  };
}
function armedController() {
  const control = controller();
  control.step(0); control.step(40);
  control.step(50, pad(undefined, true));
  assert.equal(control.step(90, pad(undefined, true)), 'start');
  assert.equal(control.armed, true);
  return control;
}

test('三控制轴固定方向、比例与限幅，输入预览不依赖许可', () => {
  const forward = input(pad([0, -1, 0]));
  assert.deepEqual(forward.target, { vx: 0.4, vy: 0, wz: 0 });
  const right = input(pad([1, 0, 0.5]));
  assert.equal(right.target.vy, -0.4);
  close(right.target.wz, -360 * 0.38 / 0.88);
  assert.equal(input(pad([0, 0, 1])).target.wz, -360);
  assert.equal(input(pad([0, 0, -1])).target.wz, 360);
  close(input(pad([0, -0.5, 0])).target.vx, 0.4 * 0.38 / 0.88);
  const diagonal = input(pad([1, -1, 2])).target;
  close(diagonal.vx, 0.4 * Math.SQRT1_2);
  close(diagonal.vy, -0.4 * Math.SQRT1_2);
  assert.equal(diagonal.wz, -360);
  for (const x of [-1, -0.6, -0.5, 0, 0.5, 0.6, 1]) for (const y of [-1, -0.6, -0.5, 0, 0.5, 0.6, 1]) {
    const target = input(pad([x, y, 0])).target;
    assert.ok(Math.hypot(target.vx, target.vy) <= 0.4);
  }
});

test('固定径向死区与三轴回中；右杆 Y、其他轴和其他按钮完全忽略', () => {
  for (const rightY of [-1, 1, NaN, Infinity]) {
    const sample = pad([0.08, 0.08, 0.12, rightY, NaN]);
    sample.buttons[0] = { value: NaN, pressed: true };
    sample.buttons[8] = { value: 1, pressed: true };
    const result = input(sample);
    assert.equal(result.neutral, true);
    assert.equal(result.pressed, false);
    assert.deepEqual(result.target, { vx: 0, vy: 0, wz: 0 });
  }
  assert.equal(input(pad([0.09, 0.09, 0, 1])).neutral, false);
  assert.equal(input(pad([0, 0, 0.121, 0])).neutral, false);
  const analogStart = pad();
  analogStart.buttons[9] = { value: 0.5, pressed: false };
  assert.equal(input(analogStart).pressed, true);
  const digitalStart = pad();
  digitalStart.buttons[9] = { value: 0, pressed: true };
  assert.equal(input(digitalStart).pressed, true);
});

test('只拒绝缺失或非有限控制轴、Start 和断开的真实消费者输入', () => {
  for (const sample of [pad([0, 0]), pad([NaN, 0, 0]), pad([0, Infinity, 0]), pad([0, 0, NaN]),
    { ...pad(), buttons: pad().buttons.slice(0, 9) }, { ...pad(), connected: false }]) {
    assert.equal(readGamepadInput(sample).valid, false);
  }
  const invalidStart = pad();
  invalidStart.buttons[9] = { value: NaN, pressed: false };
  assert.equal(readGamepadInput(invalidStart).valid, false);
});

test('Start 按下与释放分别连续稳定 40 ms，10～20 ms 抖动和长按不会重复切换', () => {
  const control = controller();
  control.step(0);
  assert.equal(control.step(39), null);
  control.step(40);
  control.step(50, pad(undefined, true));
  control.step(60);
  control.step(70, pad(undefined, true));
  control.step(89);
  control.step(100, pad(undefined, true));
  assert.equal(control.step(139, pad(undefined, true)), null);
  assert.equal(control.pressed, false);
  assert.equal(control.step(140, pad(undefined, true)), 'start');
  assert.equal(control.step(2000, pad([1, 0, 0, 0], true)), null);
  assert.equal(control.armed, true);
  control.step(2010); control.step(2030, pad(undefined, true));
  control.step(2050); control.step(2089);
  assert.equal(control.pressed, true);
  assert.equal(control.step(2090, pad(undefined, true)), null);
  control.step(2100); control.step(2140);
  assert.equal(control.pressed, false);
  control.step(2150, pad([1, 0, 0, 0], true));
  assert.equal(control.step(2190, pad([1, 0, 0, 0], true)), 'stop');
  assert.equal(control.armed, false);
});

test('上电先观察稳定释放，新按下时必须三轴回中，持按回中不会开启', () => {
  const control = controller();
  control.step(0, pad(undefined, true));
  assert.equal(control.step(40, pad(undefined, true)), null);
  assert.equal(control.armed, false);
  control.step(50, pad([1, 0, 0, 0])); control.step(90, pad([1, 0, 0, 0]));
  control.step(100, pad([1, 0, 0, 0], true));
  assert.equal(control.step(140, pad([1, 0, 0, 0], true)), null);
  assert.equal(control.step(160, pad(undefined, true)), null);
  assert.equal(control.armed, false);
  control.step(170); control.step(210);
  control.step(220, pad([0, 0, 0, 1], true));
  assert.equal(control.step(260, pad([0, 0, 0, -1], true)), 'start');
});

test('回中仅产生零目标，再按关闭无需回中，停止后保留选择但必须重新稳定释放', () => {
  const control = armedController();
  assert.equal(control.step(100), null);
  assert.equal(control.step(140), null);
  assert.equal(control.armed, true);
  assert.deepEqual(input(pad()).target, { vx: 0, vy: 0, wz: 0 });
  control.step(150, pad([1, 0, 0, 0], true));
  assert.equal(control.step(190, pad([1, 0, 0, 0], true)), 'stop');
  assert.equal(control.step(200, pad(undefined, true)), null);
  assert.equal(control.step(240, pad(undefined, true)), null);
  assert.equal(control.armed, false);
  control.step(250); control.step(290);
  control.step(300, pad(undefined, true));
  assert.equal(control.step(340, pad(undefined, true)), 'start');
});

test('同槽重连和无效输入撤销许可，旧释放与旧按下不能跨身份恢复', () => {
  for (const replacement of [{ sample: pad(undefined, true), generation: 1 },
    { sample: { ...pad(undefined, true), id: '新设备' }, generation: 0 },
    { sample: { ...pad(), connected: false }, generation: 0 }]) {
    const control = armedController();
    assert.equal(control.step(100, replacement.sample, replacement.generation), 'invalidated');
    assert.equal(control.armed, false);
    assert.equal(control.step(110, pad(undefined, true)), null);
    assert.equal(control.step(150, pad(undefined, true)), null);
    assert.equal(control.armed, false);
    control.step(160); control.step(200);
    control.step(210, pad(undefined, true));
    assert.equal(control.step(250, pad(undefined, true)), 'start');
  }
});

test('失焦、离页或超时消费者重置后，恢复时持按不会继承旧许可', () => {
  const control = armedController();
  control.reset();
  assert.equal(control.armed, false);
  assert.equal(control.step(100, pad(undefined, true)), null);
  assert.equal(control.step(140, pad(undefined, true)), null);
  assert.equal(control.armed, false);
  control.step(150); control.step(190);
  control.step(200, pad(undefined, true));
  assert.equal(control.step(240, pad(undefined, true)), 'start');
});
