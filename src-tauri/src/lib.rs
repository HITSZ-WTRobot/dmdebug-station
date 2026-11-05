mod ozone;
mod native;
mod gamepad;

use serde::Serialize;
use serialport::SerialPortType;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfoDto {
    pub port_name: String,
    pub label: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfoDto {
    pub os: String,
    pub arch: String,
    pub family: String,
}

#[tauri::command]
fn get_platform_info() -> PlatformInfoDto {
    PlatformInfoDto {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
    }
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortInfoDto>, String> {
    let ports = serialport::available_ports().map_err(|error| format!("枚举系统串口失败: {error}"))?;
    Ok(ports.into_iter().map(|port| {
        let (port_type, manufacturer, product, detail) = match &port.port_type {
            SerialPortType::UsbPort(usb) => (
                format!("USB ({:04X}:{:04X})", usb.vid, usb.pid),
                usb.manufacturer.clone(), usb.product.clone(),
                usb.product.as_deref().or(usb.manufacturer.as_deref()).unwrap_or("USB-UART Adapter").to_string(),
            ),
            SerialPortType::BluetoothPort => ("Bluetooth".into(), None, None, "Bluetooth Serial".into()),
            SerialPortType::PciPort => ("PCI".into(), None, None, "PCI UART".into()),
            SerialPortType::Unknown => ("Native".into(), None, None, "Serial Port".into()),
        };
        SerialPortInfoDto { label: format!("{} · {detail}", port.port_name), port_name: port.port_name, port_type, manufacturer, product }
    }).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(native::NativeState::default())
        .manage(gamepad::NativeGamepadState::default())
        .manage(ozone::OzoneState::default())
        .setup(|app| {
            let native = app.state::<native::NativeState>().inner().clone();
            native.start(app.handle().clone());
            app.state::<gamepad::NativeGamepadState>().start(app.handle().clone(), native);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 操作系统焦点变化直接通知后端，不依赖页面定时器或前端事件是否及时执行。
            match event {
                tauri::WindowEvent::Focused(focused) => window.state::<gamepad::NativeGamepadState>().set_window_focus(*focused),
                tauri::WindowEvent::Destroyed => window.state::<gamepad::NativeGamepadState>().set_window_focus(false),
                _ => {},
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_platform_info,
            list_serial_ports,
            native::native_connect,
            native::native_disconnect,
            native::native_handshake,
            native::native_select_device,
            native::native_refresh,
            native::native_query_parameters,
            native::native_command,
            gamepad::native_gamepad_snapshot,
            gamepad::native_gamepad_configure,
            gamepad::native_gamepad_context,
            gamepad::native_gamepad_stop,
            ozone::ozone_connect,
            ozone::ozone_disconnect,
            ozone::ozone_read_parameters,
            ozone::ozone_write_parameter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DMDebug Station Tauri application");
}
