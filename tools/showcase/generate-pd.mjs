// Optional fixture maintenance. Capturing screenshots uses the committed JSON, without Rust.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = resolve(root, 'output/showcase-pd-generator');
await mkdir(resolve(scratch, 'src'), { recursive: true });
await writeFile(
  resolve(scratch, 'Cargo.toml'),
  `[package]
name = "showcase-pd-generator"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
witrn-hid = { path = ${JSON.stringify(resolve(root, 'crates/witrn-hid'))} }
serde_json = "1"
`,
);
await writeFile(
  resolve(scratch, 'src/main.rs'),
  `
use witrn_hid::{decode_pd_report, Parser};
fn main() {
    let fixed = |v: u32, ma: u32| ((v * 20) << 10) | (ma / 10);
    let pdos = [fixed(5, 3000) | (1 << 26), fixed(9, 3000), fixed(12, 3000), fixed(15, 3000), fixed(20, 3250),
        (3 << 30) | (210 << 17) | (33 << 8) | 60];
    let mut messages: Vec<(u16, Vec<u32>)> = vec![
        (0x61a1, pdos.to_vec()), (0x0081, vec![]),
    ];
    for position in 1..=5 {
        let current = if position == 5 { 325 } else { 300 };
        messages.push((0x1082, vec![(position << 28) | (1 << 25) | (1 << 24) | (current << 10) | current]));
    }
    messages.extend([(0x03a1, vec![]), (0x03a3, vec![]), (0x0281, vec![]), (0x05a6, vec![])]);
    let mut parser = Parser::new();
    let mut result = vec![];
    for (header, objects) in messages {
        let mut bytes = vec![0xfe, (3 + objects.len() * 4) as u8, 0xe0];
        bytes.extend(header.to_le_bytes());
        for object in objects { bytes.extend(object.to_le_bytes()); }
        bytes.resize(64, 0);
        let meta = decode_pd_report(&mut parser, &bytes).expect("valid fixture report");
        result.push(serde_json::json!({"bytes": bytes, "meta": meta}));
    }
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
`,
);
const { stdout } = await promisify(execFile)(
  'cargo',
  [
    'run',
    '--quiet',
    '--manifest-path',
    resolve(scratch, 'Cargo.toml'),
    '--target-dir',
    resolve(root, 'target/showcase-pd-generator'),
  ],
  { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
);
const fixtures = JSON.parse(stdout);
if (fixtures.some((fixture) => JSON.stringify(fixture.meta).includes('Error Data'))) {
  throw new Error('PD fixture failed decoding');
}
await writeFile(resolve(root, 'tools/showcase/pd-fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`Generated ${fixtures.length} PD fixtures with the real witrn-hid parser.`);
