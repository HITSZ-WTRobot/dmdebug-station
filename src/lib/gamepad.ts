import type { BodyVelocity } from './protocol';

export const GAMEPAD_LIMITS = { translation: 1, rotation: 10, wheelRpm: 160 } as const;
export const DEFAULT_DEADZONE = 0.12;
export interface GamepadSample {
  id: string;
  index: number;
  mapping: string;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { value: number; pressed: boolean }[];
}

// 连接代次将同槽位、同型号的重新插入也视为新设备，不沿用旧许可。
export function gamepadIdentity(pad: GamepadSample, generation = 0): string {
  return JSON.stringify([pad.index, pad.id, pad.mapping, pad.axes.length, pad.buttons.length, generation]);
}
export function remapDeadzone(value: number, deadzone: number): number {
  const magnitude = Math.min(1, Math.abs(value));
  if (magnitude <= deadzone) return 0;
  return Math.sign(value) * (magnitude - deadzone) / (1 - deadzone);
}
export function translationTarget(x: number, y: number, deadzone: number): { vx: number; vy: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return { vx: 0, vy: 0 };
  // 径向死区保持斜推方向，幅度线性重映射，合成速度绝不超过 1 m/s。
  const speed = remapDeadzone(magnitude, deadzone) * GAMEPAD_LIMITS.translation;
  let vx = y === 0 ? 0 : -y / magnitude * speed;
  let vy = x === 0 ? 0 : -x / magnitude * speed;
  // 满幅斜推的舍入也不能超过通信层严格上限，否则正常杆位会触发安全退出。
  const actualSpeed = Math.hypot(vx, vy);
  if (actualSpeed > GAMEPAD_LIMITS.translation) {
    const scale = GAMEPAD_LIMITS.translation * (1 - Number.EPSILON) / actualSpeed;
    vx *= scale; vy *= scale;
  }
  return { vx, vy };
}
export type GamepadInput = { valid: false; reason: string } | { valid: true; target: BodyVelocity; neutral: boolean; pressed: boolean };
export function readGamepadInput(pad: GamepadSample): GamepadInput {
  if (!pad.connected) return { valid: false, reason: '手柄已断开' };
  // 只消费已确认的三控制轴与 Start；右杆 Y 和其他按钮完全不参与校验。
  const [x, y, rotation] = pad.axes;
  if (![x, y, rotation].every(Number.isFinite)) return { valid: false, reason: '设备缺少有效的 X / Y / Z 控制轴' };
  const button = pad.buttons[9];
  if (!button || !Number.isFinite(button.value)) return { valid: false, reason: '设备缺少有效的 Start 按钮（按钮 10）' };
  const translation = translationTarget(x, y, DEFAULT_DEADZONE);
  const rotationSpeed = remapDeadzone(rotation, DEFAULT_DEADZONE);
  const wz = rotationSpeed === 0 ? 0 : -rotationSpeed * GAMEPAD_LIMITS.rotation;
  return { valid: true, target: { ...translation, wz }, neutral: Math.hypot(x, y) <= DEFAULT_DEADZONE && Math.abs(rotation) <= DEFAULT_DEADZONE, pressed: button.pressed || button.value >= 0.5 };
}

export interface ToggleState {
  identity: string | null;
  armed: boolean;
  released: boolean;
  pressed: boolean;
  candidatePressed: boolean | null;
  candidateSinceMs: number;
}
export function resetToggle(identity: string | null = null): ToggleState {
  return { identity, armed: false, released: false, pressed: false, candidatePressed: null, candidateSinceMs: 0 };
}
export function stepToggle(previous: ToggleState, input: { identity: string; valid: boolean; neutral: boolean; pressed: boolean; nowMs: number }): { state: ToggleState; action: 'start' | 'stop' | 'invalidated' | null } {
  if (!input.valid || (previous.identity !== null && previous.identity !== input.identity)) return { state: resetToggle(), action: 'invalidated' };
  const state = { ...previous, identity: input.identity };
  if (state.candidatePressed !== input.pressed) {
    state.candidatePressed = input.pressed;
    state.candidateSinceMs = input.nowMs;
  }
  // 按下、释放均须连续稳定 40 ms；初始按住不视为已观察到释放。
  if (input.nowMs - state.candidateSinceMs < 40) return { state, action: null };
  state.pressed = input.pressed;
  if (!state.pressed) state.released = true;
  const rising = state.pressed && !previous.pressed && previous.released;
  if (rising && previous.armed) return { state: resetToggle(input.identity), action: 'stop' };
  if (rising && input.neutral) {
    state.armed = true;
    return { state, action: 'start' };
  }
  return { state, action: null };
}
