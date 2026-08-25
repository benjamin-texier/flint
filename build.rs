//! Keeps `frontend/dist` present so a clean checkout compiles before the
//! frontend has ever been built. A real `vite build` overwrites this.
use std::path::Path;

fn main() {
    let dist = Path::new("frontend/dist");
    if !dist.join("index.html").exists() {
        let _ = std::fs::create_dir_all(dist);
        let _ = std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>Flint</title>\
             <p>The frontend has not been built. Run <code>pnpm install && pnpm build</code> \
             in <code>frontend/</code>.</p>",
        );
    }
    println!("cargo:rerun-if-changed=frontend/dist");
}
