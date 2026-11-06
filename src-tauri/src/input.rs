//! Windows 校准输入的共享数据模型；不包含遥控许可或电机通信。
#[cfg(windows)]
pub(crate) mod winmm;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputAxis {
    pub code: u32,
    pub name: String,
    pub value: f32,
    pub raw_value: u32,
    pub minimum: u32,
    pub maximum: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputButton {
    pub code: u32,
    pub name: String,
    pub value: f32,
    pub pressed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputHat {
    pub code: u32,
    pub name: String,
    pub value: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputDevice {
    pub key: String,
    pub index: usize,
    pub generation: u64,
    pub name: String,
    pub uuid: String,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub mapping: String,
    pub connected: bool,
    pub axes: Vec<InputAxis>,
    pub buttons: Vec<InputButton>,
    pub hats: Vec<InputHat>,
}
