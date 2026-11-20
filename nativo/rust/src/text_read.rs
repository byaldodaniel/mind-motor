use std::{
    fs::File,
    io::{self, BufRead, Read, Write},
};

use serde::Deserialize;

const MAX_REQUEST_BYTES: u64 = 32_768;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const READ_FAILED: &str = "READ_FAILED";
const FILE_TOO_LARGE: &str = "FILE_TOO_LARGE";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    root: String,
    relative_path: String,
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    read_text(args).map_err(str::to_owned)
}

fn read_text(args: &[String]) -> Result<(), &'static str> {
    let _parent = crate::native_parent::ParentGuard::from_args(args)?;

    let mut input = io::stdin().lock();
    let request = request(&mut input)?;
    let file = crate::scan::open_reader(&request.root, &request.relative_path)?;
    {
        let mut diagnostic = io::stderr().lock();
        diagnostic.write_all(b"READY\n").map_err(|_| READ_FAILED)?;
        diagnostic.flush().map_err(|_| READ_FAILED)?;
    }

    // The host checks the grant again while this exact file remains open.
    let mut acknowledge = [0];
    input.read_exact(&mut acknowledge).map_err(|_| READ_FAILED)?;
    if acknowledge != *b"R" {
        return Err(READ_FAILED);
    }
    let bytes = contents(file)?;
    io::stdout().lock().write_all(&bytes).map_err(|_| READ_FAILED)
}

fn request(input: &mut impl BufRead) -> Result<Request, &'static str> {
    let mut line = Vec::new();
    input
        .take(MAX_REQUEST_BYTES)
        .read_until(b'\n', &mut line)
        .map_err(|_| READ_FAILED)?;
    if line.last() != Some(&b'\n') {
        return Err(READ_FAILED);
    }
    serde_json::from_slice(&line).map_err(|_| READ_FAILED)
}

fn contents(file: File) -> Result<Vec<u8>, &'static str> {
    if file.metadata().map_err(|_| READ_FAILED)?.len() > MAX_TEXT_BYTES {
        return Err(FILE_TOO_LARGE);
    }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_FAILED)?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(FILE_TOO_LARGE);
    }
    Ok(bytes)
}
