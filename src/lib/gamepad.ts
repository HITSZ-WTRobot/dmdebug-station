import type { BodyVelocity } from './protocol';

export const GAMEPAD_LIMITS = { translation: 1, rotation: 10, wheelRpm: 160 } as const;
export const DEFAULT_DEADZONE = 0.12;
export interface GamepadBinding {
  leftX: number;
  leftY: number;
  rightX: number;
  toggleButton: number;
  invertLeftX: boolean;
  invertLeftY: boolean;
  invertRightX: boolean;
  deadzone: number;
}
export interface GamepadSample {
  id: string;
  index: number;
  mapping: string;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { value: number; pressed: boolean }[];
}

// 连接代次将同槽位、同型号的重新插入也视为新设备，不沿用旧绑定。
export function gamepadIdentity(pad: GamepadSample, generation = 0): string {
  return JSON.stringify([pad.index, pad.id, pad.mapping, pad.axes.length, pad.buttons.length, generation]);
}
export function bindingError(binding: GamepadBinding, pad: GamepadSample): string | null {
  for (const axis of [binding.leftX, binding.leftY, binding.rightX]) {
    if (!Number.isInteger(axis) || axis < 0 || axis >= pad.axes.length) return '轴编号无效或设备缺少已绑定的轴';
  }
  if (!Number.isInteger(binding.toggleButton) || binding.toggleButton < 0 || binding.toggleButton >= pad.buttons.length) return '总开关按钮编号无效或设备缺少该按钮';
  if (!Number.isFinite(binding.deadzone) || binding.deadzone < 0 || binding.deadzone > 0.4) return '死区须为 0～0.40';
  return null;
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
  return { vx: y === 0 ? 0 : -y / magnitude * speed, vy: x === 0 ? 0 : -x / magnitude * speed };
}
export type GamepadInput = { valid: false; reason: string } | { valid: true; target: BodyVelocity; neutral: boolean; pressed: boolean };
export function readGamepadInput(pad: GamepadSample, binding: GamepadBinding): GamepadInput {
  if (!pad.connected) return { valid: false, reason: '手柄已断开' };
  const error = bindingError(binding, pad);
  if (error) return { valid: false, reason: error };
  for (const value of pad.axes) if (!Number.isFinite(value)) return { valid: false, reason: '手柄轴输入缺失或包含非有限值' };
  for (const button of pad.buttons) if (!button || !Number.isFinite(button.value)) return { valid: false, reason: '手柄按钮输入缺失或包含非有限值' };
  const x = pad.axes[binding.leftX] * (binding.invertLeftX ? -1 : 1);
  const y = pad.axes[binding.leftY] * (binding.invertLeftY ? -1 : 1);
  const rotation = pad.axes[binding.rightX] * (binding.invertRightX ? -1 : 1);
  const translation = translationTarget(x, y, binding.deadzone);
  const rotationSpeed = remapDeadzone(rotation, binding.deadzone);
  const wz = rotationSpeed === 0 ? 0 : -rotationSpeed * GAMEPAD_LIMITS.rotation;
  const button = pad.buttons[binding.toggleButton];
  return { valid: true, target: { ...translation, wz }, neutral: Math.hypot(x, y) <= binding.deadzone && Math.abs(rotation) <= binding.deadzone, pressed: button.pressed || button.value >= 0.5 };
}

export interface ToggleState {
  identity: string | null;
  armed: boolean;
  neutralSeen: boolean;
  released: boolean;
  pressed: boolean;
}
export function resetToggle(identity: string | null = null): ToggleState {
  return { identity, armed: false, neutralSeen: false, released: false, pressed: false };
}
export function stepToggle(previous: ToggleState, input: { identity: string; valid: boolean; neutral: boolean; pressed: boolean }): { state: ToggleState; action: 'start' | 'stop' | 'invalidated' | null } {
  if (!input.valid || (previous.identity !== null && previous.identity !== input.identity)) return { state: resetToggle(), action: 'invalidated' };
  const state = { ...previous, identity: input.identity };
  state.neutralSeen ||= input.neutral;
  if (!input.pressed) state.released = true;
  const rising = input.pressed && !previous.pressed && previous.released;
  state.pressed = input.pressed;
  if (rising && previous.armed) return { state: resetToggle(input.identity), action: 'stop' };
  if (rising && input.neutral && state.neutralSeen) {
    state.armed = true;
    return { state, action: 'start' };
  }
  return { state, action: null };
}
