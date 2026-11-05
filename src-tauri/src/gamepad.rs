use crate::native::{BodyVelocity, NativeState};
use gilrs::{EventType, Gilrs, GilrsBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const SAMPLE_INTERVAL: Duration = Duration::from_millis(20);
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(100);
const INPUT_LEASE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub left_x: usize,
    pub left_y: usize,
    pub right_x: usize,
    pub toggle_button: usize,
    pub invert_left_x: bool,
    pub invert_left_y: bool,
    pub invert_right_x: bool,
    pub deadzone: f32,
}

#[derive(Clone, Default, Serialize)]
pub struct PadButton {
    pub value: f32,
    pub pressed: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadView {
    pub key: String,
    pub id: String,
    pub index: usize,
    pub mapping: String,
    pub timestamp: f64,
    pub connected: bool,
    pub axes: Vec<f32>,
    pub buttons: Vec<PadButton>,
    // 编号是实际观测到的物理 Code 排序，不填充不存在的标准轴。
    pub axis_codes: Vec<u32>,
    pub button_codes: Vec<u32>,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    uuid: [u8; 16],
    #[serde(skip)]
    mapping_source: Option<gilrs::MappingSource>,
    #[serde(skip)]
    mapping_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadSnapshot {
    pub supported: bool,
    pub error: String,
    pub pads: Vec<PadView>,
    pub selected_key: String,
    pub binding: Option<Binding>,
    pub armed: bool,
    pub neutral: bool,
    pub released: bool,
    pub target: BodyVelocity,
    pub phase: String,
    pub message: String,
}

impl Default for PadSnapshot {
    fn default() -> Self {
        Self {
            supported: false,
            error: String::new(),
            pads: Vec::new(),
            selected_key: String::new(),
            binding: None,
            armed: false,
            neutral: false,
            released: false,
            target: BodyVelocity::default(),
            phase: "off".into(),
            message: "等待原生手柄驱动；识别和绑定不会自动使能。".into(),
        }
    }
}

#[derive(Default)]
struct Toggle {
    identity: String,
    armed: bool,
    neutral_seen: bool,
    released: bool,
    pressed: bool,
}

#[derive(Debug, PartialEq)]
enum Action {
    None,
    Start,
    Stop,
    Invalidated,
}

impl Toggle {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn step(&mut self, identity: &str, neutral: bool, pressed: bool) -> Action {
        if !self.identity.is_empty() && self.identity != identity {
            self.reset();
            return Action::Invalidated;
        }
        if self.identity.is_empty() {
            self.identity = identity.into();
        }
        self.neutral_seen |= neutral;
        let rising = pressed && !self.pressed && self.released;
        if !pressed {
            self.released = true;
        }
        self.pressed = pressed;
        if rising && self.armed {
            self.reset();
            return Action::Stop;
        }
        if rising && neutral && self.neutral_seen {
            self.armed = true;
            return Action::Start;
        }
        Action::None
    }
}

#[derive(Default)]
struct Shared {
    snapshot: PadSnapshot,
    toggle: Toggle,
    native: Option<NativeState>,
    started: bool,
    visible: bool,
    frontend_focused: bool,
    window_focused: bool,
}

impl Shared {
    fn permitted(&self) -> bool {
        self.visible && self.frontend_focused && self.window_focused
    }

    fn has_control(&self) -> bool {
        self.toggle.armed || self.snapshot.binding.is_some()
    }

    fn revoke(&mut self, reason: &str, request_stop: bool) -> Result<(), String> {
        self.toggle.reset();
        self.snapshot.armed = false;
        self.snapshot.neutral = false;
        self.snapshot.released = false;
        self.snapshot.target = BodyVelocity::default();
        self.snapshot.message = reason.into();
        if request_stop {
            let result = self.native.as_ref().ok_or_else(|| "原生通信服务未启动".to_string())
                .and_then(|native| native.gamepad_stop(reason));
            if let Some(native) = self.native.as_ref() {
                self.snapshot.phase = native.gamepad_state().phase;
            }
            if let Err(error) = result {
                self.snapshot.error = format!("停止请求失败：{error}。不能确认物理停止，请使用硬件急停。");
                return Err(error);
            }
        }
        Ok(())
    }

    fn fail_driver(&mut self, error: String) {
        let stop = self.has_control();
        let _ = self.revoke("原生手柄驱动不可用，遥控已撤销；不会自动恢复。", stop);
        self.snapshot.supported = false;
        self.snapshot.binding = None;
        self.snapshot.selected_key.clear();
        self.snapshot.pads.clear();
        if self.snapshot.error.is_empty() {
            self.snapshot.error = error;
        } else {
            self.snapshot.error = format!("{error}；{}", self.snapshot.error);
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeGamepadState {
    inner: Arc<Mutex<Shared>>,
}

impl NativeGamepadState {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn start(&self, app: AppHandle, native: NativeState) {
        {
            let mut shared = self.lock();
            if shared.started {
                return;
            }
            shared.started = true;
            shared.native = Some(native);
            shared.window_focused = app.get_webview_window("main")
                .and_then(|window| window.is_focused().ok()).unwrap_or(false);
        }
        let state = self.clone();
        let failure = self.clone();
        if let Err(error) = thread::Builder::new().name("native-gamepad".into()).spawn(move || {
            // gilrs/WGI 的创建、事件处理和销毁都只在此线程，不跨线程搬运句柄。
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| state.run(app.clone()))).is_err() {
                let snapshot = {
                    let mut shared = state.lock();
                    shared.fail_driver("原生手柄驱动线程异常退出".into());
                    shared.snapshot.clone()
                };
                let _ = app.emit("native-gamepad", snapshot);
            }
        }) {
            failure.lock().fail_driver(format!("无法启动原生手柄线程：{error}"));
        }
    }

    pub fn set_window_focus(&self, focused: bool) {
        let mut shared = self.lock();
        let lost = shared.window_focused && !focused;
        shared.window_focused = focused;
        if lost || (!focused && shared.toggle.armed) {
            let stop = shared.has_control();
            let _ = shared.revoke("原生窗口失焦或销毁，遥控关闭；恢复焦点不会自动使能。", stop);
        }
    }

    fn configure(&self, device_key: String, binding: Binding) -> Result<(), String> {
        let mut shared = self.lock();
        let validation = if !shared.snapshot.supported {
            Err(if shared.snapshot.error.is_empty() { "原生手柄驱动尚不可用".into() } else { shared.snapshot.error.clone() })
        } else {
            shared.snapshot.pads.iter().find(|pad| pad.key == device_key && pad.connected)
                .ok_or_else(|| "手柄身份已变化或未连接，请重新明确选择".into())
                .and_then(|pad| binding_error(&binding, pad))
        };
        if let Err(error) = validation {
            let stop = shared.has_control();
            let stopped = shared.revoke("绑定无效，本地遥控已关闭。", stop);
            shared.snapshot.binding = None;
            shared.snapshot.error = match stopped {
                Ok(()) => error.clone(),
                Err(_) => format!("{error}；{}", shared.snapshot.error),
            };
            return Err(error);
        }
        // 仅已有遥控许可才需要停止；未连接串口时仍可识别、观察和应用绑定。
        let stop = shared.toggle.armed;
        shared.snapshot.binding = None;
        shared.revoke("绑定已应用；先回中并释放总开关，再重新按下开启。", stop)?;
        shared.snapshot.selected_key = device_key;
        shared.snapshot.binding = Some(binding);
        shared.snapshot.error.clear();
        Ok(())
    }

    fn context(&self, visible: bool, focused: bool) -> Result<(), String> {
        let mut shared = self.lock();
        let permitted = shared.permitted();
        shared.visible = visible;
        shared.frontend_focused = focused;
        // 前端只能收紧许可，不能覆盖真实 WindowEvent 的失焦状态。
        if permitted && !shared.permitted() {
            let stop = shared.has_control();
            shared.revoke("已离页、隐藏或前端失焦，遥控关闭；不会自动恢复。", stop)?;
        }
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        // 显式停止也用于编辑/切换绑定；先清除旧映射，不能在未重新确认草稿时复用它。
        let mut shared = self.lock();
        shared.snapshot.binding = None;
        // 即使本地 off 也必须向唯一通信 actor 请求全设备 FF 失能。
        shared.revoke("操作员请求全设备失能；等待通信应答，不能保证物理停止。", true)
    }

    fn run(&self, app: AppHandle) {
        let mut gilrs = match GilrsBuilder::new().with_default_filters(false)
            .with_force_feedback(false).build() {
            Ok(gilrs) => gilrs,
            Err(error) => {
                let snapshot = {
                    let mut shared = self.lock();
                    shared.fail_driver(format!("原生手柄驱动初始化失败：{error}"));
                    shared.snapshot.clone()
                };
                let _ = app.emit("native-gamepad", snapshot);
                return;
            }
        };
        {
            let mut shared = self.lock();
            shared.snapshot.supported = true;
            shared.snapshot.message = "原生手柄驱动已启动；请明确选择设备、观察物理编号并应用绑定。".into();
        }
        let mut generations = HashMap::<usize, u64>::new();
        let mut last_sample = Instant::now();
        let mut next_sample = last_sample;
        let mut next_snapshot = last_sample;
        loop {
            let now = Instant::now();
            // 及时排空事件以更新 cached state，绝不依赖 JS/RAF 的采样节奏。
            while let Some(event) = gilrs.next_event() {
                if matches!(event.event, EventType::Connected | EventType::Disconnected) {
                    let generation = generations.entry(usize::from(event.id)).or_default();
                    *generation = generation.wrapping_add(1);
                }
            }
            let snapshot = {
                let mut shared = self.lock();
                if now.duration_since(last_sample) > INPUT_LEASE && shared.toggle.armed {
                    let _ = shared.revoke("原生输入采样超过 250 ms 未更新，遥控关闭且旧速度已丢弃。", true);
                }
                update_pads(&gilrs, &generations, &mut shared.snapshot.pads);
                sample_control(&mut shared);
                if now >= next_snapshot {
                    next_snapshot = now + SNAPSHOT_INTERVAL;
                    Some(shared.snapshot.clone())
                } else {
                    None
                }
            };
            if let Some(snapshot) = snapshot {
                let _ = app.emit("native-gamepad", snapshot);
            }
            gilrs.inc();
            last_sample = now;
            next_sample += SAMPLE_INTERVAL;
            let after_work = Instant::now();
            if next_sample > after_work {
                thread::sleep(next_sample - after_work);
            } else {
                // 不追赶积压周期，也不重放旧输入。
                next_sample = after_work;
            }
        }
    }
}

fn identity(pad: &PadView) -> String {
    serde_json::to_string(&(pad.index, &pad.id, &pad.mapping, pad.uuid,
        &pad.axis_codes, &pad.button_codes, pad.generation)).expect("手柄身份只包含可序列化字段")
}

fn milliseconds(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0
}

fn observe_code<T>(codes: &mut Vec<u32>, values: &mut Vec<T>, code: u32, value: T) -> bool {
    match codes.binary_search(&code) {
        Ok(position) => {
            values[position] = value;
            false
        }
        Err(position) => {
            codes.insert(position, code);
            values.insert(position, value);
            true
        }
    }
}

fn update_pads(gilrs: &Gilrs, generations: &HashMap<usize, u64>, pads: &mut Vec<PadView>) {
    for pad in pads.iter_mut() {
        pad.connected = false;
    }
    for (id, gamepad) in gilrs.gamepads() {
        let index = usize::from(id);
        let generation = generations.get(&index).copied().unwrap_or_default();
        let position = pads.iter().position(|pad| pad.index == index).unwrap_or_else(|| {
            pads.push(PadView::default());
            pads.len() - 1
        });
        let pad = &mut pads[position];
        if pad.key.is_empty() || pad.generation != generation || pad.uuid != gamepad.uuid()
            || pad.id != gamepad.os_name() || pad.mapping_source != Some(gamepad.mapping_source())
            || pad.mapping_name != gamepad.map_name().unwrap_or_default() {
            *pad = PadView {
                index,
                id: gamepad.os_name().into(),
                mapping: format!("gilrs/{:?} {}", gamepad.mapping_source(), gamepad.map_name().unwrap_or_default()),
                mapping_source: Some(gamepad.mapping_source()),
                mapping_name: gamepad.map_name().unwrap_or_default().into(),
                uuid: gamepad.uuid(),
                generation,
                ..PadView::default()
            };
        }
        pad.connected = gamepad.is_connected();
        let mut changed = pad.key.is_empty();
        // 缓存保留已观测到的零值轴；未上报的能力不凭空伪造，新增 Code 会使身份失效。
        for (code, data) in gamepad.state().axes() {
            changed |= observe_code(&mut pad.axis_codes, &mut pad.axes, code.into_u32(), data.value());
            pad.timestamp = pad.timestamp.max(milliseconds(data.timestamp()));
        }
        for (code, data) in gamepad.state().buttons() {
            let value = PadButton { value: data.value(), pressed: data.is_pressed() };
            changed |= observe_code(&mut pad.button_codes, &mut pad.buttons, code.into_u32(), value);
            pad.timestamp = pad.timestamp.max(milliseconds(data.timestamp()));
        }
        if changed {
            pad.key = identity(pad);
        }
    }
    pads.retain(|pad| pad.connected);
    pads.sort_unstable_by_key(|pad| pad.index);
}

fn binding_error(binding: &Binding, pad: &PadView) -> Result<(), String> {
    if [binding.left_x, binding.left_y, binding.right_x].iter().any(|axis| *axis >= pad.axes.len()) {
        return Err("轴编号无效或设备尚未上报已绑定的物理轴；请先逐轴拨动观察".into());
    }
    if binding.toggle_button >= pad.buttons.len() {
        return Err("总开关按钮编号无效或设备尚未上报该按钮；请先按键观察".into());
    }
    if !binding.deadzone.is_finite() || !(0.0..=0.4).contains(&binding.deadzone) {
        return Err("死区须为 0～0.40".into());
    }
    Ok(())
}

struct Input {
    target: BodyVelocity,
    neutral: bool,
    pressed: bool,
}

fn remap_deadzone(value: f32, deadzone: f32) -> f32 {
    let magnitude = value.abs().min(1.0);
    if magnitude <= deadzone { 0.0 } else { value.signum() * (magnitude - deadzone) / (1.0 - deadzone) }
}

fn read_input(pad: &PadView, binding: &Binding) -> Result<Input, String> {
    if !pad.connected {
        return Err("手柄已断开".into());
    }
    binding_error(binding, pad)?;
    if pad.axes.iter().any(|value| !value.is_finite() || !(-1.0..=1.0).contains(value)) {
        return Err("手柄轴输入缺失、越界或包含非有限值".into());
    }
    if pad.buttons.iter().any(|button| !button.value.is_finite() || !(0.0..=1.0).contains(&button.value)) {
        return Err("手柄按钮输入缺失、越界或包含非有限值".into());
    }
    let x = pad.axes[binding.left_x] * if binding.invert_left_x { -1.0 } else { 1.0 };
    let y = pad.axes[binding.left_y] * if binding.invert_left_y { -1.0 } else { 1.0 };
    let rotation = pad.axes[binding.right_x] * if binding.invert_right_x { -1.0 } else { 1.0 };
    let magnitude = x.hypot(y);
    let speed = remap_deadzone(magnitude, binding.deadzone);
    let button = &pad.buttons[binding.toggle_button];
    Ok(Input {
        target: BodyVelocity {
            vx: if magnitude <= binding.deadzone { 0.0 } else { -y / magnitude * speed },
            vy: if magnitude <= binding.deadzone { 0.0 } else { -x / magnitude * speed },
            wz: -remap_deadzone(rotation, binding.deadzone) * 10.0,
        },
        neutral: magnitude <= binding.deadzone && rotation.abs() <= binding.deadzone,
        pressed: button.pressed || button.value >= 0.5,
    })
}

fn sample_control(shared: &mut Shared) {
    let Some(native) = shared.native.clone() else { return };
    let control = native.gamepad_state();
    shared.snapshot.phase = control.phase.clone();
    if shared.toggle.armed && control.phase != "active" && control.phase != "enabling" {
        let _ = shared.revoke("通信层已退出遥控；需回中、释放后重新按下，绝不自动恢复。", false);
    }
    if !control.message.is_empty() && !shared.toggle.armed {
        shared.snapshot.message = control.message;
    }
    if shared.snapshot.selected_key.is_empty() || shared.snapshot.binding.is_none() {
        return;
    }
    let Some(pad) = shared.snapshot.pads.iter().find(|pad| pad.key == shared.snapshot.selected_key) else {
        let _ = shared.revoke("手柄断开或物理编号/连接代次改变；请重新选择并应用绑定。", true);
        shared.snapshot.binding = None;
        shared.snapshot.selected_key.clear();
        return;
    };
    let input = match read_input(pad, shared.snapshot.binding.as_ref().expect("已检查绑定")) {
        Ok(input) => input,
        Err(error) => {
            let stopped = shared.revoke("无效手柄输入，本地遥控关闭并请求全设备失能。", true);
            shared.snapshot.binding = None;
            shared.snapshot.error = match stopped {
                Ok(()) => error,
                Err(_) => format!("{error}；{}", shared.snapshot.error),
            };
            return;
        }
    };
    if !shared.permitted() {
        shared.snapshot.neutral = input.neutral;
        return;
    }
    let action = shared.toggle.step(&shared.snapshot.selected_key, input.neutral, input.pressed);
    match action {
        Action::Start => {
            if let Err(error) = native.gamepad_start() {
                let _ = shared.revoke("开启失败，本地遥控已关闭并请求全设备失能。", true);
                shared.snapshot.error = format!("开启失败：{error}；{}", shared.snapshot.error);
            } else {
                shared.snapshot.error.clear();
                shared.snapshot.message = "仅请求使能底盘 0x40，等待新反馈确认。".into();
            }
        }
        Action::Stop | Action::Invalidated => {
            let _ = shared.revoke("总开关关闭，已请求全设备失能；等待真实应答。", true);
        }
        Action::None => {}
    }
    if shared.toggle.armed {
        if let Err(error) = native.gamepad_update(input.target.clone()) {
            let _ = shared.revoke("目标更新失败，已请求全设备失能。", true);
            shared.snapshot.error = format!("目标更新失败：{error}；{}", shared.snapshot.error);
        }
    }
    let control = native.gamepad_state();
    shared.snapshot.phase = control.phase;
    shared.snapshot.armed = shared.toggle.armed;
    shared.snapshot.neutral = input.neutral;
    shared.snapshot.released = shared.toggle.released;
    shared.snapshot.target = if shared.toggle.armed { input.target } else { BodyVelocity::default() };
    if !control.message.is_empty() {
        shared.snapshot.message = control.message;
    }
}

#[tauri::command]
pub fn native_gamepad_snapshot(state: State<'_, NativeGamepadState>) -> PadSnapshot {
    state.lock().snapshot.clone()
}

#[tauri::command]
pub fn native_gamepad_configure(state: State<'_, NativeGamepadState>, device_key: String, binding: Binding) -> Result<(), String> {
    state.configure(device_key, binding)
}

#[tauri::command]
pub fn native_gamepad_context(state: State<'_, NativeGamepadState>, visible: bool, focused: bool) -> Result<(), String> {
    state.context(visible, focused)
}

#[tauri::command]
pub fn native_gamepad_stop(state: State<'_, NativeGamepadState>) -> Result<(), String> {
    state.stop()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> Binding {
        Binding { left_x: 0, left_y: 1, right_x: 2, toggle_button: 0,
            invert_left_x: false, invert_left_y: false, invert_right_x: false, deadzone: 0.12 }
    }

    fn pad() -> PadView {
        let mut pad = PadView { id: "普通 USB 手柄".into(), mapping: "gilrs/None".into(),
            connected: true, axes: vec![0.0; 3], buttons: vec![PadButton::default()],
            axis_codes: vec![2, 5, 17], button_codes: vec![9], ..PadView::default() };
        pad.key = identity(&pad);
        pad
    }

    fn arm(toggle: &mut Toggle) {
        assert_eq!(toggle.step("pad", true, false), Action::None);
        assert_eq!(toggle.step("pad", true, true), Action::Start);
    }

    #[test]
    fn proportional_half_full_and_diagonal_limits() {
        let mut pad = pad();
        pad.axes = vec![0.0, -0.5, 0.5];
        let half = read_input(&pad, &binding()).unwrap();
        assert!((half.target.vx - 0.38 / 0.88).abs() < 0.00001);
        assert!((half.target.wz + 10.0 * 0.38 / 0.88).abs() < 0.00001);
        assert!(half.target.vx < 1.0 && half.target.wz.abs() < 10.0);
        pad.axes = vec![1.0, -1.0, -1.0];
        let full = read_input(&pad, &binding()).unwrap();
        assert!((full.target.vx.hypot(full.target.vy) - 1.0).abs() < 0.00001);
        assert_eq!(full.target.wz, 10.0);
    }

    #[test]
    fn deadzone_and_inversion_match_browser_logic() {
        let mut pad = pad();
        pad.axes = vec![0.08, 0.08, 0.1];
        assert!(read_input(&pad, &binding()).unwrap().neutral);
        let mut binding = binding();
        binding.invert_left_x = true;
        binding.invert_left_y = true;
        binding.invert_right_x = true;
        pad.axes = vec![0.5, -0.5, 0.5];
        let input = read_input(&pad, &binding).unwrap();
        assert!(input.target.vx < 0.0 && input.target.vy > 0.0 && input.target.wz > 0.0);
    }

    #[test]
    fn held_button_and_deflected_stick_cannot_start() {
        let mut toggle = Toggle::default();
        assert_eq!(toggle.step("pad", true, true), Action::None);
        assert_eq!(toggle.step("pad", true, true), Action::None);
        assert_eq!(toggle.step("pad", false, false), Action::None);
        assert_eq!(toggle.step("pad", false, true), Action::None);
        assert_eq!(toggle.step("pad", true, true), Action::None);
        assert_eq!(toggle.step("pad", true, false), Action::None);
        assert_eq!(toggle.step("pad", true, true), Action::Start);
        for _ in 0..20 {
            assert_eq!(toggle.step("pad", false, true), Action::None);
        }
        assert_eq!(toggle.step("pad", false, false), Action::None);
        assert_eq!(toggle.step("pad", false, true), Action::Stop);
        assert!(!toggle.armed);
        assert_eq!(toggle.step("pad", true, true), Action::None);
    }

    #[test]
    fn reconnect_and_layout_changes_invalidate_identity() {
        let mut pad = pad();
        let old = pad.key.clone();
        pad.generation += 1;
        assert_ne!(old, identity(&pad));
        pad.generation = 0;
        pad.axis_codes[2] = 18;
        assert_ne!(old, identity(&pad));
        pad.axis_codes[2] = 17;
        pad.mapping = "gilrs/Driver".into();
        assert_ne!(old, identity(&pad));
        let mut toggle = Toggle::default();
        arm(&mut toggle);
        assert_eq!(toggle.step("replacement", true, true), Action::Invalidated);
        assert!(!toggle.armed && !toggle.released);
    }

    #[test]
    fn physical_codes_sort_stably_and_keep_zero_axes() {
        let mut pad = PadView::default();
        assert!(observe_code(&mut pad.axis_codes, &mut pad.axes, 17, 0.0));
        assert!(observe_code(&mut pad.axis_codes, &mut pad.axes, 5, 0.5));
        pad.key = identity(&pad);
        let key = pad.key.clone();
        assert!(!observe_code(&mut pad.axis_codes, &mut pad.axes, 5, 0.0));
        assert_eq!(pad.axis_codes, vec![5, 17]);
        assert_eq!(pad.axes, vec![0.0, 0.0]);
        assert_eq!(key, identity(&pad));
        assert!(observe_code(&mut pad.axis_codes, &mut pad.axes, 2, 0.0));
        assert_ne!(key, identity(&pad));
        assert_eq!(pad.axis_codes, vec![2, 5, 17]);
    }

    #[test]
    fn missing_and_invalid_input_is_rejected() {
        let mut pad = pad();
        pad.axes.pop();
        assert!(read_input(&pad, &binding()).is_err());
        pad.axes.push(f32::NAN);
        assert!(read_input(&pad, &binding()).is_err());
        pad.axes[2] = 0.0;
        pad.buttons[0].value = f32::INFINITY;
        assert!(read_input(&pad, &binding()).is_err());
        pad.buttons[0].value = 0.0;
        pad.connected = false;
        assert!(read_input(&pad, &binding()).is_err());
        let mut invalid = binding();
        invalid.deadzone = 1.0;
        assert!(binding_error(&invalid, &pad).is_err());
    }

    #[test]
    fn frontend_focus_cannot_override_real_window_focus() {
        let state = NativeGamepadState::default();
        state.context(true, true).unwrap();
        assert!(!state.lock().permitted());
        state.set_window_focus(true);
        assert!(state.lock().permitted());
        state.set_window_focus(false);
        state.context(true, true).unwrap();
        assert!(!state.lock().permitted());
        assert!(!state.lock().toggle.armed);
    }

    #[test]
    fn focus_loss_resets_release_and_edge_without_resuming() {
        let state = NativeGamepadState::default();
        state.context(true, true).unwrap();
        state.set_window_focus(true);
        arm(&mut state.lock().toggle);
        state.set_window_focus(false);
        assert!(!state.lock().toggle.armed);
        state.set_window_focus(true);
        assert_eq!(state.lock().toggle.step("pad", true, true), Action::None);
        state.context(false, true).unwrap();
        assert!(!state.lock().permitted());
    }

    #[test]
    fn configuration_without_serial_and_failures_are_visible() {
        let state = NativeGamepadState::default();
        {
            let mut shared = state.lock();
            shared.snapshot.supported = true;
            shared.snapshot.pads.push(pad());
        }
        let key = state.lock().snapshot.pads[0].key.clone();
        state.configure(key, binding()).unwrap();
        assert!(state.lock().snapshot.binding.is_some());
        assert!(!state.lock().toggle.armed);
        assert!(state.configure("stale".into(), binding()).is_err());
        assert!(!state.lock().snapshot.error.is_empty());
        assert!(state.stop().is_err());
        assert!(state.lock().snapshot.error.contains("不能确认物理停止"));
    }

    #[test]
    fn native_off_revokes_toggle_and_held_button_cannot_revive() {
        let mut shared = Shared::default();
        shared.native = Some(NativeState::default());
        shared.visible = true;
        shared.frontend_focused = true;
        shared.window_focused = true;
        let mut pad = pad();
        pad.buttons[0].pressed = true;
        pad.buttons[0].value = 1.0;
        shared.snapshot.selected_key = pad.key.clone();
        shared.snapshot.binding = Some(binding());
        shared.snapshot.pads.push(pad);
        shared.toggle.armed = true;
        shared.toggle.released = true;
        shared.snapshot.armed = true;
        sample_control(&mut shared);
        assert!(!shared.toggle.armed && !shared.snapshot.armed);
        assert!(!shared.toggle.released);
        sample_control(&mut shared);
        assert!(!shared.toggle.armed);
        assert_eq!(shared.snapshot.target.vx, 0.0);
    }

    #[test]
    fn start_rejection_clears_local_arming_and_reports_stop_failure() {
        let mut shared = Shared::default();
        shared.native = Some(NativeState::default());
        shared.visible = true;
        shared.frontend_focused = true;
        shared.window_focused = true;
        let pad = pad();
        shared.snapshot.selected_key = pad.key.clone();
        shared.snapshot.binding = Some(binding());
        shared.snapshot.pads.push(pad);
        sample_control(&mut shared);
        shared.snapshot.pads[0].buttons[0].pressed = true;
        sample_control(&mut shared);
        assert!(!shared.toggle.armed && !shared.snapshot.armed);
        assert!(shared.snapshot.error.contains("开启失败"));
        assert!(shared.snapshot.error.contains("不能确认物理停止"));
    }

    #[test]
    fn driver_error_preserves_real_error_and_revokes_binding() {
        let mut shared = Shared::default();
        shared.snapshot.supported = true;
        shared.snapshot.pads.push(pad());
        shared.snapshot.binding = Some(binding());
        arm(&mut shared.toggle);
        shared.fail_driver("WGI 初始化错误：access denied".into());
        assert!(!shared.snapshot.supported && !shared.toggle.armed);
        assert!(shared.snapshot.binding.is_none());
        assert!(shared.snapshot.error.contains("access denied"));
        assert!(shared.snapshot.pads.is_empty());
    }

    #[test]
    fn explicit_stop_removes_old_binding_even_when_stop_cannot_be_sent() {
        let state = NativeGamepadState::default();
        {
            let mut shared = state.lock();
            shared.snapshot.supported = true;
            let pad = pad();
            shared.snapshot.selected_key = pad.key.clone();
            shared.snapshot.pads.push(pad);
            shared.snapshot.binding = Some(binding());
            arm(&mut shared.toggle);
        }
        assert!(state.stop().is_err());
        let shared = state.lock();
        assert!(shared.snapshot.binding.is_none());
        assert!(!shared.toggle.armed && !shared.snapshot.armed);
        assert_eq!(shared.snapshot.target.vx, 0.0);
    }
}
