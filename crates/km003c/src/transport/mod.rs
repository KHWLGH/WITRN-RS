pub mod bulk;
pub mod serial;

pub const VID: u16 = 0x5FC9;
pub const PID_KM003C: u16 = 0x0063;
pub const PID_KM002C: u16 = 0x0061;

pub fn is_powerz_pid(pid: u16) -> bool {
    pid == PID_KM003C || pid == PID_KM002C
}

pub fn model_name(pid: u16) -> &'static str {
    match pid {
        PID_KM003C => "KM003C",
        PID_KM002C => "KM002C",
        _ => "POWER-Z",
    }
}
