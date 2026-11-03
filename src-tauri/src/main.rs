// Release builds are a Windows GUI application. Keep the console subsystem in
// debug builds so developers can still see startup diagnostics locally.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    life_timeline_lib::run();
}
