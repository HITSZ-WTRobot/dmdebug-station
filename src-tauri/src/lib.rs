mod ozone;
mod native;
mod gamepad;
mod diagnostics;
mod input;
mod bluetooth;

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

#[tauri::command]
async fn list_bluetooth_devices() -> Result<Vec<bluetooth::BluetoothDevice>, String> {
    tauri::async_runtime::spawn_blocking(bluetooth::list_devices).await
        .map_err(|error| format!("蓝牙设备枚举任务异常：{error}"))?
}

fn input_diagnostics_mode() -> bool {
    std::env::args().any(|argument| argument == "--input-diagnostics")
}

#[tauri::command]
fn application_mode() -> &'static str {
    "workbench"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS 每个程序只能嵌入一次 Info.plist；两种入口移动同一份上下文。
    let context = tauri::generate_context!();
    // 诊断程序不注册通信或电机控制命令，也不启动它们的后台线程。
    if input_diagnostics_mode() { diagnostics::run(context); return; }
    tauri::Builder::default()
        .manage(native::NativeState::default())
        .manage(gamepad::NativeGamepadState::default())
        .manage(ozone::OzoneState::default())
        .manage(diagnostics::DiagnosticState::default())
        .setup(|app| {
            let native = app.state::<native::NativeState>().inner().clone();
            native.start(app.handle().clone());
            app.state::<gamepad::NativeGamepadState>().start(app.handle().clone(), native);
            app.state::<diagnostics::DiagnosticState>().start(app.path().app_log_dir()
                .map_err(|error| format!("无法获取应用日志目录：{error}")));
            Ok(())
        })
        .on_window_event(|window, event| {
            // 操作系统焦点变化直接通知后端，不依赖页面定时器或前端事件是否及时执行。
            match event {
                tauri::WindowEvent::Focused(focused) => {
                    window.state::<gamepad::NativeGamepadState>().set_window_focus(*focused);
                    window.state::<diagnostics::DiagnosticState>().record_focus(*focused);
                }
                tauri::WindowEvent::Destroyed => {
                    window.state::<gamepad::NativeGamepadState>().set_window_focus(false);
                    window.state::<diagnostics::DiagnosticState>().stop();
                }
                _ => {},
            }
        })
        .invoke_handler(tauri::generate_handler![
            application_mode,
            list_bluetooth_devices,
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
            gamepad::native_gamepad_select,
            gamepad::native_gamepad_context,
            gamepad::native_gamepad_stop,
            diagnostics::diagnostic_snapshot,
            diagnostics::diagnostic_mark,
            diagnostics::diagnostic_pause,
            ozone::ozone_connect,
            ozone::ozone_disconnect,
            ozone::ozone_read_parameters,
            ozone::ozone_write_parameter,
        ])
        .run(context)
        .expect("error while running DMDebug Station Tauri application");
}
