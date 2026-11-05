import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DEADZONE, bindingError, gamepadIdentity, readGamepadInput, remapDeadzone, resetToggle, stepToggle, translationTarget, type GamepadBinding, type GamepadSample } from '../src/lib/gamepad';

const binding: GamepadBinding = { leftX: 0, leftY: 1, rightX: 2, toggleButton: 0, invertLeftX: false, invertLeftY: false, invertRightX: false, deadzone: DEFAULT_DEADZONE };
function pad(axes = [0, 0, 0], pressed = false): GamepadSample {
  return { id: '非标准 USB 双摇杆', index: 1, mapping: '', connected: true, axes, buttons: [{ value: pressed ? 1 : 0, pressed }] };
}
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`);
}

test('死区内零输出，死区外线性重映射；半程非满速，满程才到上限', () => {
  for (const value of [0, 0.01, -0.1, 0.12, -0.12]) assert.equal(remapDeadzone(value, 0.12), 0);
  close(remapDeadzone(0.5, 0.12), 0.38 / 0.88);
  close(remapDeadzone(-0.5, 0.12), -0.38 / 0.88);
  assert.equal(remapDeadzone(1, 0.12), 1);
  assert.equal(remapDeadzone(-1, 0.12), -1);
  assert.equal(remapDeadzone(2, 0.12), 1);
  assert.equal(remapDeadzone(0.5, 0), 0.5);
});

test('平移径向死区保持方向，斜推合成不超过 1 m/s', () => {
  assert.deepEqual(translationTarget(0.08, 0.08, 0.12), { vx: 0, vy: 0 });
  const withinRadius = translationTarget(0.09, 0.09, 0.12);
  assert.ok(Math.hypot(withinRadius.vx, withinRadius.vy) > 0);
  const angled = translationTarget(0.3, -0.4, 0.12);
  close(Math.hypot(angled.vx, angled.vy), (0.5 - 0.12) / 0.88);
  close(angled.vx / angled.vy, -4 / 3);
  const diagonal = translationTarget(1, -1, 0.12);
  close(Math.hypot(diagonal.vx, diagonal.vy), 1);
  close(diagonal.vx, Math.SQRT1_2);
  close(diagonal.vy, -Math.SQRT1_2);
  for (const x of [-1, -0.5, 0, 0.5, 1]) for (const y of [-1, -0.5, 0, 0.5, 1]) {
    const target = translationTarget(x, y, 0.12);
    assert.ok(Math.hypot(target.vx, target.vy) <= 1 + 1e-12);
  }
});

test('方向为负 leftY 前进、正 leftX 右移、正 rightX 顺时针；旋转也按幅度缩放', () => {
  const forward = readGamepadInput(pad([0, -1, 0]), binding);
  assert.ok(forward.valid);
  if (forward.valid) { assert.equal(forward.target.vx, 1); assert.equal(forward.target.vy, 0); assert.equal(forward.target.wz, 0); }
  const right = readGamepadInput(pad([1, 0, 0.5]), binding);
  assert.ok(right.valid);
  if (right.valid) { assert.equal(right.target.vy, -1); close(right.target.wz, -10 * (0.5 - 0.12) / 0.88); }
  const clockwise = readGamepadInput(pad([0, 0, 1]), binding);
  assert.ok(clockwise.valid);
  if (clockwise.valid) assert.equal(clockwise.target.wz, -10);
  const inverted = readGamepadInput(pad([1, -1, 1]), { ...binding, invertLeftX: true, invertLeftY: true, invertRightX: true });
  assert.ok(inverted.valid);
  if (inverted.valid) { assert.ok(inverted.target.vx < 0); assert.ok(inverted.target.vy > 0); assert.equal(inverted.target.wz, 10); }
});

test('任意 mapping 支持显式轴/按钮绑定，缺轴、NaN、缺按钮或断开均无有效输入', () => {
  const custom = { ...pad([0.6, 0, -1, 1]), buttons: [{ value: 0, pressed: false }, { value: 0.8, pressed: false }] };
  const input = readGamepadInput(custom, { ...binding, leftX: 1, leftY: 2, rightX: 3, toggleButton: 1 });
  assert.ok(input.valid);
  if (input.valid) { assert.equal(input.target.vx, 1); assert.equal(input.target.wz, -10); assert.equal(input.pressed, true); }
  for (const sample of [pad([0, 0]), pad([NaN, 0, 0]), pad([0, Infinity, 0]), { ...pad(), buttons: [] }, { ...pad(), connected: false }, { ...pad(), buttons: [{ value: NaN, pressed: false }] }]) assert.equal(readGamepadInput(sample, binding).valid, false);
  for (const invalid of [{ ...binding, leftX: -1 }, { ...binding, leftY: 1.5 }, { ...binding, toggleButton: NaN }, { ...binding, deadzone: 0.5 }, { ...binding, deadzone: NaN }]) assert.notEqual(bindingError(invalid, pad()), null);
});

test('首次必须回中且释放后新上升沿；长按一次，关闭边沿无需回中', () => {
  let state = resetToggle('device-a');
  const step = (pressed: boolean, neutral: boolean) => {
    const next = stepToggle(state, { identity: 'device-a', valid: true, neutral, pressed });
    state = next.state;
    return next.action;
  };
  assert.equal(step(true, true), null);
  assert.equal(state.armed, false);
  assert.equal(step(true, true), null);
  assert.equal(step(false, false), null);
  assert.equal(step(true, false), null);
  assert.equal(state.armed, false);
  assert.equal(step(true, true), null);
  assert.equal(step(false, true), null);
  assert.equal(step(true, true), 'start');
  for (let index = 0; index < 20; index++) assert.equal(step(true, false), null);
  assert.equal(state.armed, true);
  assert.equal(step(false, false), null);
  assert.equal(step(true, false), 'stop');
  assert.equal(state.armed, false);
  assert.equal(step(true, true), null);
});

test('回中只产生零目标，不撤销已经开启的 toggle', () => {
  let state = stepToggle(resetToggle('a'), { identity: 'a', valid: true, neutral: true, pressed: false }).state;
  state = stepToggle(state, { identity: 'a', valid: true, neutral: true, pressed: true }).state;
  const next = stepToggle(state, { identity: 'a', valid: true, neutral: true, pressed: false });
  assert.equal(next.state.armed, true);
  assert.equal(next.action, null);
  const input = readGamepadInput(pad(), binding);
  assert.ok(input.valid);
  if (input.valid) { assert.ok(input.neutral); close(input.target.vx, 0); close(input.target.vy, 0); close(input.target.wz, 0); }
});

test('身份变化、连接代次、无效输入及显式重置清除许可和旧释放边沿', () => {
  const original = gamepadIdentity(pad());
  for (const sample of [{ ...pad(), id: '另一个手柄' }, { ...pad(), index: 2 }, { ...pad(), mapping: 'standard' }, pad([0, 0, 0, 0]), { ...pad(), buttons: [] }]) assert.notEqual(gamepadIdentity(sample), original);
  assert.notEqual(gamepadIdentity(pad(), 1), original);
  let state = stepToggle(resetToggle(original), { identity: original, valid: true, neutral: true, pressed: false }).state;
  state = stepToggle(state, { identity: original, valid: true, neutral: true, pressed: true }).state;
  assert.equal(state.armed, true);
  for (const input of [{ identity: 'replacement', valid: true, neutral: true, pressed: true }, { identity: original, valid: false, neutral: true, pressed: false }]) {
    const invalidated = stepToggle(state, input);
    assert.equal(invalidated.action, 'invalidated');
    assert.deepEqual(invalidated.state, resetToggle());
    assert.equal(stepToggle(invalidated.state, { identity: original, valid: true, neutral: true, pressed: true }).action, null);
  }
  assert.equal(stepToggle(resetToggle(original), { identity: original, valid: true, neutral: true, pressed: true }).action, null);
});
