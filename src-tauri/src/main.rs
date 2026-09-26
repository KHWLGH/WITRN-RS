// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must be the first statement: every boot-timing segment is measured from here.
    witrn_rs_lib::boot_timing::record_process_start();
    witrn_rs_lib::run()
}
