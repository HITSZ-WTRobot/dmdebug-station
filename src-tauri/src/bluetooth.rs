//! 经典蓝牙SPP传输；打开链路不代表固件握手或电机在线。
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BluetoothDevice {
    pub address: String,
    pub name: String,
    pub connected: bool,
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::{list_devices, BluetoothStream};

#[cfg(not(windows))]
pub(crate) fn list_devices() -> Result<Vec<BluetoothDevice>, String> {
    Err("蓝牙SPP直连仅支持Windows桌面；请在Windows中配对SPP设备".into())
}

#[cfg(not(windows))]
pub(crate) struct BluetoothStream;

#[cfg(not(windows))]
impl BluetoothStream {
    pub(crate) fn connect(
        _address: &str,
        _timeout: std::time::Duration,
        _cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Self, String> {
        Err("蓝牙SPP直连仅支持Windows桌面".into())
    }

    pub(crate) fn read_available(&mut self, _bytes: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "蓝牙SPP直连仅支持Windows桌面",
        ))
    }

    pub(crate) fn write_frame(
        &mut self,
        _bytes: &[u8],
        _timeout: std::time::Duration,
    ) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "蓝牙SPP直连仅支持Windows桌面",
        ))
    }
}

#[cfg(any(windows, test))]
fn parse_address(address: &str) -> Result<u64, String> {
    let bytes = address.as_bytes();
    if bytes.len() != 17 {
        return Err("蓝牙地址必须为AA:BB:CC:DD:EE:FF格式".into());
    }
    let mut result = 0u64;
    for index in 0..6 {
        let offset = index * 3;
        if index != 5 && bytes[offset + 2] != b':' {
            return Err("蓝牙地址必须为AA:BB:CC:DD:EE:FF格式".into());
        }
        let digit = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        };
        let high = digit(bytes[offset]);
        let low = digit(bytes[offset + 1]);
        match (high, low) {
            (Some(high), Some(low)) => result = (result << 8) | u64::from(high * 16 + low),
            _ => return Err("蓝牙地址包含非十六进制字符".into()),
        }
    }
    if result == 0 || result == 0xffff_ffff_ffff {
        return Err("蓝牙地址不能为全零或广播地址".into());
    }
    Ok(result)
}

#[cfg(any(windows, test))]
fn format_address(address: u64) -> String {
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        (address >> 40) & 0xff,
        (address >> 32) & 0xff,
        (address >> 24) & 0xff,
        (address >> 16) & 0xff,
        (address >> 8) & 0xff,
        address & 0xff
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_round_trip_preserves_windows_numeric_order() {
        assert_eq!(parse_address("01:23:45:67:89:aB").unwrap(), 0x0123_4567_89ab);
        assert_eq!(format_address(0x0123_4567_89ab), "01:23:45:67:89:AB");
    }

    #[test]
    fn address_rejects_non_endpoints_and_noncanonical_syntax() {
        for address in [
            "", "COM14", "0123456789AB", "01-23-45-67-89-AB",
            " 01:23:45:67:89:AB", "01:23:45:67:89:AB ", "01:23:45:67:89:AG",
            "01:23:45:67:89:A", "００:23:45:67:89:AB", "00:00:00:00:00:00",
            "FF:FF:FF:FF:FF:FF",
        ] {
            assert!(parse_address(address).is_err(), "accepted {address:?}");
        }
    }
}
