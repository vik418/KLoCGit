use std::env;
use std::io::{self, Read};
use klocgit_engine::golden::run_golden_suite;
use klocgit_engine::sha256::Sha256;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 && args[1] == "golden" {
        let results = run_golden_suite();
        print!("[");
        for (i, r) in results.iter().enumerate() {
            if i > 0 {
                print!(",");
            }
            print!("{{\"name\":\"{}\",\"digest\":\"{}\"}}", r.name, r.digest);
        }
        println!("]");
    } else if args.len() > 1 && args[1] == "sha256" {
        let mut buffer = Vec::new();
        io::stdin().read_to_end(&mut buffer).unwrap();
        println!("{}", Sha256::digest_hex(&buffer));
    } else {
        println!("klocgit-engine CLI v1.0.0");
    }
}
