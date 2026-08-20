fn main() {
    if let Err(error) = alethe_lib::server_main::run_standalone() {
        eprintln!("[Alethe Web Server] {error}");
        std::process::exit(1);
    }
}
