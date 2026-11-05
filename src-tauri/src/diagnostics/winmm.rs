//! 只读 WinMM 诊断：保留 Windows 校准整数，不参与遥控映射或自行校准。
use super::{DiagnosticAxis, DiagnosticButton, DiagnosticDevice, DiagnosticHat};
use std::mem::size_of;
use windows_sys::Win32::Media::{
    Multimedia::{
        joyGetDevCapsW, joyGetNumDevs, joyGetPosEx, JOYCAPSW, JOYINFOEX,
        JOYCAPS_HASPOV, JOYCAPS_HASR, JOYCAPS_HASU, JOYCAPS_HASV, JOYCAPS_HASZ,
        JOYERR_NOCANDO, JOYERR_NOERROR, JOYERR_PARMS, JOYERR_UNPLUGGED,
        JOY_RETURNBUTTONS, JOY_RETURNPOV, JOY_RETURNR, JOY_RETURNU, JOY_RETURNV,
        JOY_RETURNX, JOY_RETURNY, JOY_RETURNZ,
    },
    MMSYSERR_BADDEVICEID, MMSYSERR_INVALPARAM, MMSYSERR_NODRIVER,
};

// 不请求 RAW、死区、强制居中或任何校准模式。
const READ_FLAGS: u32 = (JOY_RETURNX | JOY_RETURNY | JOY_RETURNZ | JOY_RETURNR
    | JOY_RETURNU | JOY_RETURNV | JOY_RETURNPOV | JOY_RETURNBUTTONS) as u32;
const AXIS_NAMES: [&str; 6] = ["X", "Y", "Z", "Z旋转", "X旋转", "Y旋转"];

pub(super) struct Reader {
    slots: Vec<Option<Slot>>,
}

impl Reader {
    pub(super) fn new() -> Result<Self, String> {
        // 返回的是驱动可用槽位上限，不是已连接设备数；零表示没有可用槽位。
        let count = unsafe { joyGetNumDevs() } as usize;
        let mut slots = Vec::with_capacity(count);
        slots.resize_with(count, || None);
        Ok(Self { slots })
    }

    pub(super) fn slot_count(&mut self) -> usize {
        // 每轮只查询一次槽位上限，允许驱动热插拔，不在逐槽读取时重复查询。
        let count = unsafe { joyGetNumDevs() } as usize;
        self.slots.resize_with(count, || None);
        count
    }

    pub(super) fn read(&mut self, index: usize) -> Result<Option<&DiagnosticDevice>, String> {
        let count = self.slots.len();
        if index >= count {
            return Err(format!("WinMM 槽位 {index} 超出当前槽位范围 0..{count}"));
        }

        let mut position = JOYINFOEX {
            dwSize: size_of::<JOYINFOEX>() as u32,
            dwFlags: READ_FLAGS,
            ..Default::default()
        };
        // 先查询连接状态，避免把未连接槽位的能力残留当成在线设备。
        let status = unsafe { joyGetPosEx(index as u32, &mut position) };
        if status != JOYERR_NOERROR {
            self.slots[index] = None;
            return presence(status, "joyGetPosEx", index).map(|_| None);
        }

        let mut caps = JOYCAPSW::default();
        let status = unsafe { joyGetDevCapsW(index, &mut caps, size_of::<JOYCAPSW>() as u32) };
        if status != JOYERR_NOERROR {
            self.slots[index] = None;
            return presence(status, "joyGetDevCapsW", index).map(|_| None);
        }
        let capabilities = Capabilities::from_caps(&caps);
        let cached = &mut self.slots[index];
        if cached.as_ref().map_or(true, |slot| slot.capabilities != capabilities) {
            // 名称、能力、轴范围变化或重新连接时才重建集合；稳定轮询不分配或克隆。
            *cached = None;
            *cached = Some(Slot::new(index, capabilities)?);
        }
        let slot = cached.as_mut().expect("成功读取能力后已建立槽位缓存");
        slot.update(&position);
        Ok(Some(&slot.device))
    }
}

fn presence(status: u32, api: &str, index: usize) -> Result<bool, String> {
    match status {
        JOYERR_NOERROR => Ok(true),
        // 槽位已由 joyGetNumDevs 限定且结构大小固定；实机的空槽返回 JOYERR_PARMS。
        // 仅此枚举上下文将它视为缺席，INVALPARAM、BADDEVICEID 和读取失败仍报错。
        JOYERR_UNPLUGGED | MMSYSERR_NODRIVER | JOYERR_PARMS => Ok(false),
        _ => {
            let name = match status {
                MMSYSERR_BADDEVICEID => "MMSYSERR_BADDEVICEID",
                MMSYSERR_INVALPARAM => "MMSYSERR_INVALPARAM",
                JOYERR_NOCANDO => "JOYERR_NOCANDO",
                _ => "未知 WinMM 错误",
            };
            Err(format!("{api} 槽位 {index}: {name} ({status})"))
        }
    }
}

#[derive(PartialEq, Eq)]
struct Capabilities {
    name: [u16; 32],
    manufacturer_id: u16,
    product_id: u16,
    flags: u32,
    axis_count: u32,
    button_count: u32,
    ranges: [[u32; 2]; 6],
}

impl Capabilities {
    fn from_caps(caps: &JOYCAPSW) -> Self {
        // SDK 结构是 packed；只按值读取字段，不能创建未对齐字段的引用。
        Self {
            name: caps.szPname,
            manufacturer_id: caps.wMid,
            product_id: caps.wPid,
            flags: caps.wCaps,
            axis_count: caps.wNumAxes,
            button_count: caps.wNumButtons,
            ranges: [
                [caps.wXmin, caps.wXmax], [caps.wYmin, caps.wYmax],
                [caps.wZmin, caps.wZmax], [caps.wRmin, caps.wRmax],
                [caps.wUmin, caps.wUmax], [caps.wVmin, caps.wVmax],
            ],
        }
    }

    fn axes(&self) -> [bool; 6] {
        [
            self.axis_count >= 1,
            self.axis_count >= 2,
            self.flags & JOYCAPS_HASZ != 0,
            self.flags & JOYCAPS_HASR != 0,
            self.flags & JOYCAPS_HASU != 0,
            self.flags & JOYCAPS_HASV != 0,
        ]
    }
}

struct Slot {
    capabilities: Capabilities,
    device: DiagnosticDevice,
}

impl Slot {
    fn new(index: usize, capabilities: Capabilities) -> Result<Self, String> {
        let present = capabilities.axes();
        // 先验证再建立集合，退化范围不能伪装成零值轴。
        for (code, available) in present.iter().enumerate() {
            if *available {
                let [minimum, maximum] = capabilities.ranges[code];
                if maximum <= minimum {
                    return Err(format!("WinMM 槽位 {index} 轴 {} 范围退化: {minimum}..{maximum}", AXIS_NAMES[code]));
                }
            }
        }
        let mut axes = Vec::with_capacity(present.iter().filter(|available| **available).count());
        for (code, available) in present.iter().enumerate() {
            if *available {
                let [minimum, maximum] = capabilities.ranges[code];
                axes.push(DiagnosticAxis {
                    code: code as u32,
                    name: AXIS_NAMES[code].into(),
                    value: 0.0,
                    raw_value: 0,
                    minimum,
                    maximum,
                });
            }
        }
        // WinMM 的物理按钮位图只有 32 位，不把 POV 转成按钮。
        let button_count = capabilities.button_count.min(32);
        let mut buttons = Vec::with_capacity(button_count as usize);
        for code in 0..button_count {
            buttons.push(DiagnosticButton {
                code, name: format!("按钮 {}", code + 1), value: 0.0, pressed: false,
            });
        }
        let hats = if capabilities.flags & JOYCAPS_HASPOV != 0 {
            vec![DiagnosticHat { code: 0, name: "POV".into(), value: None }]
        } else {
            Vec::new()
        };
        let name_end = capabilities.name.iter().position(|unit| *unit == 0)
            .unwrap_or(capabilities.name.len());
        let device = DiagnosticDevice {
            key: format!("winmm:{index}"),
            index,
            name: String::from_utf16_lossy(&capabilities.name[..name_end]),
            uuid: String::new(),
            // wMid/wPid 是 WinMM 厂商/产品标识，不是 USB VID/PID。
            vendor_id: None,
            product_id: None,
            mapping: "WinMM joyGetPosEx / Windows 校准整数 / 无控制映射".into(),
            connected: true,
            axes,
            buttons,
            hats,
        };
        Ok(Self { capabilities, device })
    }

    fn update(&mut self, position: &JOYINFOEX) {
        let values = [position.dwXpos, position.dwYpos, position.dwZpos,
            position.dwRpos, position.dwUpos, position.dwVpos];
        for axis in &mut self.device.axes {
            let raw = values[axis.code as usize];
            axis.raw_value = raw;
            // 用 f64 做无符号范围减法，允许越界读数原样超出 [-1, 1]。
            axis.value = ((f64::from(raw) - f64::from(axis.minimum)) * 2.0
                / (f64::from(axis.maximum) - f64::from(axis.minimum)) - 1.0) as f32;
        }
        let bitmap = position.dwButtons;
        for button in &mut self.device.buttons {
            button.pressed = bitmap & (1u32 << button.code) != 0;
            button.value = if button.pressed { 1.0 } else { 0.0 };
        }
        if let Some(hat) = self.device.hats.first_mut() {
            let angle = position.dwPOV;
            // JOY_POVCENTERED 是 WORD(-1)；也识别驱动按 DWORD 扩展的 -1。
            hat.value = if angle == u16::MAX as u32 || angle == u32::MAX {
                None
            } else {
                Some(angle)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> JOYCAPSW {
        let mut caps = JOYCAPSW::default();
        let mut name = [0; 32];
        name[0] = '测' as u16;
        name[1] = '试' as u16;
        caps.szPname = name;
        caps.wMid = 123;
        caps.wPid = 456;
        caps.wNumAxes = 4;
        caps.wNumButtons = 32;
        caps.wCaps = JOYCAPS_HASZ | JOYCAPS_HASR | JOYCAPS_HASPOV;
        caps.wXmin = 100;
        caps.wXmax = 1100;
        caps.wYmin = 100;
        caps.wYmax = 1100;
        caps.wZmin = 100;
        caps.wZmax = 1100;
        caps.wRmin = 100;
        caps.wRmax = 1100;
        caps
    }

    #[test]
    fn calibrated_axes_use_caps_without_clamping_or_inverting() {
        let mut slot = Slot::new(3, Capabilities::from_caps(&caps())).unwrap();
        slot.update(&JOYINFOEX {
            dwXpos: 100, dwYpos: 1100, dwZpos: 600, dwRpos: 1600,
            dwPOV: u16::MAX as u32, ..Default::default()
        });
        assert_eq!(slot.device.axes.iter().map(|axis| axis.value).collect::<Vec<_>>(),
            vec![-1.0, 1.0, 0.0, 2.0]);
        assert_eq!(slot.device.axes[3].name, "Z旋转");
        assert_eq!(slot.device.axes[3].raw_value, 1600);
        assert_eq!(slot.device.axes[3].minimum, 100);
        assert_eq!(slot.device.axes[3].maximum, 1100);
        assert_eq!(slot.device.vendor_id, None);
        assert_eq!(slot.device.product_id, None);
        assert!(slot.device.uuid.is_empty());
    }

    #[test]
    fn optional_axes_follow_caps_and_reject_only_present_degenerate_ranges() {
        let mut raw = caps();
        raw.wCaps = JOYCAPS_HASU | JOYCAPS_HASV;
        raw.wNumAxes = 4;
        raw.wUmin = 10;
        raw.wUmax = 20;
        raw.wVmin = 30;
        raw.wVmax = 40;
        raw.wZmax = raw.wZmin;
        let slot = Slot::new(0, Capabilities::from_caps(&raw)).unwrap();
        assert_eq!(slot.device.axes.iter().map(|axis| axis.code).collect::<Vec<_>>(), vec![0, 1, 4, 5]);
        assert_eq!(slot.device.axes[2].name, "X旋转");
        assert_eq!(slot.device.axes[3].name, "Y旋转");
        assert!(slot.device.hats.is_empty());
        raw.wUmax = raw.wUmin;
        assert!(Slot::new(0, Capabilities::from_caps(&raw)).is_err());
        raw.wUmax = 9;
        assert!(Slot::new(0, Capabilities::from_caps(&raw)).is_err());
    }

    #[test]
    fn physical_buttons_and_pov_remain_independent() {
        let mut slot = Slot::new(0, Capabilities::from_caps(&caps())).unwrap();
        slot.update(&JOYINFOEX {
            dwButtons: 0x8000_0001, dwButtonNumber: 2, dwPOV: 9000,
            ..Default::default()
        });
        assert!(slot.device.buttons[0].pressed);
        assert!(slot.device.buttons[31].pressed);
        assert!(!slot.device.buttons[1].pressed);
        assert_eq!(slot.device.hats[0].value, Some(9000));
        slot.update(&JOYINFOEX { dwPOV: u16::MAX as u32, ..Default::default() });
        assert!(slot.device.buttons.iter().all(|button| !button.pressed));
        assert_eq!(slot.device.hats[0].value, None);
    }


    #[test]
    fn missing_devices_are_not_confused_with_sdk_errors() {
        assert_eq!(presence(JOYERR_NOERROR, "test", 0), Ok(true));
        assert_eq!(presence(JOYERR_UNPLUGGED, "test", 0), Ok(false));
        assert_eq!(presence(MMSYSERR_NODRIVER, "test", 0), Ok(false));
        assert_eq!(presence(JOYERR_PARMS, "test", 0), Ok(false));
        for code in [MMSYSERR_BADDEVICEID, MMSYSERR_INVALPARAM, JOYERR_NOCANDO, 999] {
            assert!(presence(code, "joyGetPosEx", 7).is_err());
        }
    }
}
