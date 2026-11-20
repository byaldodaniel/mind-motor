//! Bounded Office text extraction. The approved file is opened once and never extracted to disk.
use std::collections::HashMap;
use std::io::{self, BufRead, Cursor, Read, Write};

use roxmltree::{Document, Node, ParsingOptions};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

const FILE_LIMIT: usize = 16 * 1024 * 1024;
const MEMBER_LIMIT: u64 = 32 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 64 * 1024 * 1024;
const MEMBER_COUNT_LIMIT: usize = 4096;
const COMPRESSION_RATIO_LIMIT: u64 = 200;
const XML_NODE_LIMIT: u32 = 1_048_576;
const TEXT_LIMIT: usize = 1024 * 1024;

const INVALID: &str = "DOCUMENT_INVALID";
const COMPLEX: &str = "DOCUMENT_TOO_COMPLEX";
const UNSAFE: &str = "DOCUMENT_UNSAFE";
const ENCRYPTED: &str = "DOCUMENT_ENCRYPTED";
const READ_FAILED: &str = "READ_FAILED";

const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DRAWING: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const RELATION: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ODF_TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const ODF_TABLE: &str = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    root: String,
    relative_path: String,
    format: String,
}

#[derive(Serialize)]
struct Extracted<'a> {
    format: &'a str,
    text: String,
    truncated: bool,
    bytes: usize,
}

pub(crate) fn run(args: &[String]) -> std::result::Result<(), String> {
    read_document(args).map_err(str::to_owned)
}

fn read_document(args: &[String]) -> Result<()> {
    let _guard = crate::native_parent::ParentGuard::from_args(args)?;
    let mut input = io::stdin().lock();
    let mut line = Vec::new();
    (&mut input)
        .take(32_768)
        .read_until(b'\n', &mut line)
        .map_err(|_| READ_FAILED)?;
    if line.last() != Some(&b'\n') {
        return Err(READ_FAILED);
    }
    let request: Request = serde_json::from_slice(&line).map_err(|_| READ_FAILED)?;
    let file = crate::scan::open_reader(&request.root, &request.relative_path)?;
    {
        let mut diagnostic = io::stderr().lock();
        diagnostic.write_all(b"READY\n").map_err(|_| READ_FAILED)?;
        diagnostic.flush().map_err(|_| READ_FAILED)?;
    }
    let mut allow = [0];
    input.read_exact(&mut allow).map_err(|_| READ_FAILED)?;
    if allow != *b"R" {
        return Err(READ_FAILED);
    }
    if file.metadata().map_err(|_| READ_FAILED)?.len() > FILE_LIMIT as u64 {
        return Err("FILE_TOO_LARGE");
    }
    let mut data = Vec::new();
    file.take(FILE_LIMIT as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| READ_FAILED)?;
    if data.len() > FILE_LIMIT {
        return Err("FILE_TOO_LARGE");
    }
    let output = extract(&data, &request.format)?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &output).map_err(|_| READ_FAILED)?;
    stdout.flush().map_err(|_| READ_FAILED)
}

struct Archive<'a> {
    zip: ZipArchive<Cursor<&'a [u8]>>,
    total: u64,
}

impl<'a> Archive<'a> {
    fn new(data: &'a [u8]) -> Result<Self> {
        let zip = ZipArchive::new(Cursor::new(data)).map_err(|_| INVALID)?;
        if zip.len() > MEMBER_COUNT_LIMIT {
            return Err(COMPLEX);
        }
        Ok(Self { zip, total: 0 })
    }

    fn xml(&mut self, name: &str) -> Result<Option<String>> {
        let Some(index) = self.zip.index_for_name(name) else {
            return Ok(None);
        };
        let (size, compressed_size) = {
            let member = self.zip.by_index_raw(index).map_err(|_| INVALID)?;
            if member.encrypted() {
                return Err(ENCRYPTED);
            }
            (member.size(), member.compressed_size())
        };
        let remaining = MEMBER_LIMIT.min(TOTAL_LIMIT - self.total);
        if size > remaining || (compressed_size != 0 && size > compressed_size.saturating_mul(COMPRESSION_RATIO_LIMIT)) {
            return Err(COMPLEX);
        }
        let member = self.zip.by_index(index).map_err(|_| INVALID)?;
        let mut bytes = Vec::new();
        member.take(remaining + 1).read_to_end(&mut bytes).map_err(|_| INVALID)?;
        let actual = bytes.len() as u64;
        if actual > remaining {
            return Err(COMPLEX);
        }
        if actual != size {
            return Err(INVALID);
        }
        self.total += actual;
        let text = decode_xml(bytes)?;
        if text.contains("<!DOCTYPE") || text.contains("<!ENTITY") {
            return Err(UNSAFE);
        }
        Ok(Some(text))
    }
}

fn decode_xml(bytes: Vec<u8>) -> Result<String> {
    let little_endian = match bytes.as_slice() {
        [0xFF, 0xFE, ..] | [b'<', 0, _, 0, ..] => true,
        [0xFE, 0xFF, ..] | [0, b'<', 0, _, ..] => false,
        _ => return String::from_utf8(bytes).map_err(|_| INVALID),
    };
    let bytes = if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        &bytes[2..]
    } else {
        &bytes
    };
    if bytes.len() % 2 != 0 {
        return Err(INVALID);
    }
    let units = bytes.chunks_exact(2).map(|pair| {
        let pair = [pair[0], pair[1]];
        if little_endian { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) }
    });
    char::decode_utf16(units).collect::<std::result::Result<String, _>>().map_err(|_| INVALID)
}

fn parse(xml: &str) -> Result<Document<'_>> {
    let options = ParsingOptions { nodes_limit: XML_NODE_LIMIT, ..Default::default() };
    Document::parse_with_options(xml, options).map_err(|error| match error {
        roxmltree::Error::NodesLimitReached => COMPLEX,
        _ => INVALID,
    })
}

// The output cap also applies when a sheet repeats large shared strings. Hold
// trailing newlines separately so spreadsheet/slides trimming precedes truncation.
struct Text {
    value: String,
    chars: usize,
    truncated: bool,
    trim: bool,
    first_line: bool,
    newlines: usize,
}

impl Text {
    fn new(trim: bool) -> Self {
        Self { value: String::new(), chars: 0, truncated: false, trim, first_line: true, newlines: 0 }
    }

    fn line(&mut self) {
        if !self.first_line {
            self.push("\n");
        }
        self.first_line = false;
    }

    fn push(&mut self, value: &str) {
        if self.truncated {
            return;
        }
        if !self.trim {
            self.append(value);
            return;
        }
        let body = value.trim_end_matches('\n');
        if !body.is_empty() {
            let remaining = TEXT_LIMIT - self.chars;
            let prefix = self.newlines.min(remaining);
            self.value.extend(std::iter::repeat_n('\n', prefix));
            self.chars += prefix;
            self.truncated = self.newlines > prefix;
            self.newlines = 0;
            self.append(body);
        }
        self.newlines = self.newlines.saturating_add(value.len() - body.len());
    }

    fn append(&mut self, value: &str) {
        if self.truncated {
            return;
        }
        let remaining = TEXT_LIMIT - self.chars;
        if value.is_ascii() {
            let accepted = value.len().min(remaining);
            self.value.push_str(&value[..accepted]);
            self.chars += accepted;
            self.truncated = accepted < value.len();
            return;
        }
        for (index, (byte, _)) in value.char_indices().enumerate() {
            if index == remaining {
                self.value.push_str(&value[..byte]);
                self.chars = TEXT_LIMIT;
                self.truncated = true;
                return;
            }
            self.chars += 1;
        }
        self.value.push_str(value);
    }
}

fn named(node: Node<'_, '_>, namespace: &str, name: &str) -> bool {
    node.has_tag_name((namespace, name))
}

fn paragraphs(document: &Document<'_>, namespace: &str, skip_empty: bool, output: &mut Text) {
    for paragraph in document.descendants().filter(|node| named(*node, namespace, "p")) {
        if output.truncated {
            return;
        }
        if skip_empty && !paragraph.descendants().any(|node| named(node, namespace, "t") && node.text().is_some_and(|text| !text.is_empty())) {
            continue;
        }
        output.line();
        for node in paragraph.descendants() {
            if output.truncated {
                break;
            }
            if named(node, namespace, "t") {
                output.push(node.text().unwrap_or_default());
            } else if namespace == WORD {
                if named(node, WORD, "tab") {
                    output.push("\t");
                } else if named(node, WORD, "br") {
                    output.push("\n");
                }
            }
        }
    }
}

fn numbered_member<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    let digits = name.strip_prefix(prefix)?.strip_suffix(".xml")?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some(digits)
}

fn sheet_order(archive: &mut Archive<'_>) -> Result<Vec<(String, String)>> {
    let mut targets = HashMap::new();
    if let Some(xml) = archive.xml("xl/_rels/workbook.xml.rels")? {
        let relations = parse(&xml)?;
        for node in relations.root_element().children().filter(Node::is_element) {
            let target = node.attribute("Target").unwrap_or_default();
            if node.attribute("TargetMode") == Some("External") || target.split('/').any(|part| part == "..") {
                continue;
            }
            let Some(id) = node.attribute("Id") else { continue };
            let target = target.trim_start_matches('/');
            let target = target.strip_prefix("xl/").unwrap_or(target);
            targets.insert(id.to_owned(), format!("xl/{target}"));
        }
    }
    let mut sheets = Vec::new();
    if let Some(xml) = archive.xml("xl/workbook.xml")? {
        let workbook = parse(&xml)?;
        for node in workbook.descendants().filter(|node| named(*node, SHEET, "sheet")) {
            let Some(id) = node.attribute((RELATION, "id")) else { continue };
            if let Some(target) = targets.get(id) {
                let name = node.attribute("name").filter(|name| !name.is_empty()).unwrap_or(target);
                sheets.push((name.to_owned(), target.clone()));
            }
        }
    }
    if sheets.is_empty() {
        sheets = archive.zip.file_names_raw()
            .filter_map(|name| std::str::from_utf8(name).ok())
            .filter(|name| numbered_member(name, "xl/worksheets/sheet").is_some())
            .map(|name| (name.to_owned(), name.to_owned()))
            .collect();
        sheets.sort_unstable();
    }
    Ok(sheets)
}

fn spreadsheet(archive: &mut Archive<'_>, output: &mut Text) -> Result<()> {
    let shared_xml = archive.xml("xl/sharedStrings.xml")?;
    let shared = if let Some(xml) = &shared_xml {
        let document = parse(xml)?;
        let mut strings = Vec::new();
        let mut bytes = 0u64;
        for item in document.descendants().filter(|node| named(*node, SHEET, "si")) {
            let mut entry = String::new();
            for text in item.descendants()
                .filter(|node| named(*node, SHEET, "t"))
                .filter_map(|node| node.text())
            {
                bytes += text.len() as u64;
                if bytes > MEMBER_LIMIT { return Err(COMPLEX); }
                entry.push_str(text);
            }
            strings.push(entry);
        }
        strings
    } else {
        Vec::new()
    };
    for (name, target) in sheet_order(archive)? {
        let Some(xml) = archive.xml(&target)? else { continue };
        let sheet = parse(&xml)?;
        if output.truncated {
            continue;
        }
        output.line();
        output.push("# Hoja: ");
        output.push(&name);
        for row in sheet.descendants().filter(|node| named(*node, SHEET, "row")) {
            if output.truncated {
                break;
            }
            output.line();
            for (index, cell) in row.descendants().filter(|node| named(*node, SHEET, "c")).enumerate() {
                if output.truncated {
                    break;
                }
                if index != 0 {
                    output.push("\t");
                }
                let raw = cell.children().find(|node| named(*node, SHEET, "v")).and_then(|node| node.text()).unwrap_or_default();
                match cell.attribute("t") {
                    Some("s") if !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()) => {
                        if let Some(text) = raw.parse::<usize>().ok().and_then(|index| shared.get(index)) {
                            output.push(text);
                        }
                    }
                    Some("inlineStr") => {
                        for text in cell.descendants().filter(|node| named(*node, SHEET, "t")).filter_map(|node| node.text()) {
                            output.push(text);
                        }
                    }
                    _ => output.push(raw),
                }
            }
        }
        output.line();
    }
    Ok(())
}

fn slides(archive: &mut Archive<'_>, output: &mut Text) -> Result<()> {
    let mut slides: Vec<_> = archive.zip.file_names_raw()
        .filter_map(|name| {
            let name = std::str::from_utf8(name).ok()?;
            let digits = numbered_member(name, "ppt/slides/slide")?.trim_start_matches('0');
            Some((digits.to_owned(), name.to_owned()))
        })
        .collect();
    slides.sort_by(|left, right| left.0.len().cmp(&right.0.len()).then_with(|| left.0.cmp(&right.0)));
    for (index, (_, name)) in slides.into_iter().enumerate() {
        let xml = archive.xml(&name)?.ok_or(INVALID)?;
        let slide = parse(&xml)?;
        output.line();
        output.push(&format!("# Diapositiva {}", index + 1));
        paragraphs(&slide, DRAWING, true, output);
        output.line();
    }
    Ok(())
}

fn push_descendant_text(node: Node<'_, '_>, output: &mut Text) {
    for text in node.descendants().filter(Node::is_text).filter_map(|child| child.text()) {
        if output.truncated {
            break;
        }
        output.push(text);
    }
}

fn opendocument(document: &Document<'_>, output: &mut Text) {
    for node in document.descendants() {
        if output.truncated {
            break;
        }
        if named(node, ODF_TEXT, "p") || named(node, ODF_TEXT, "h") {
            output.line();
            push_descendant_text(node, output);
        } else if named(node, ODF_TABLE, "table-row") {
            let cells = node.children().filter(|child| named(*child, ODF_TABLE, "table-cell"));
            if cells.clone().any(|cell| cell.descendants().any(|child| child.is_text() && child.text().is_some_and(|text| !text.is_empty()))) {
                output.line();
                for (index, cell) in cells.enumerate() {
                    if index != 0 {
                        output.push("\t");
                    }
                    push_descendant_text(cell, output);
                }
            }
        }
    }
}

fn extract<'a>(data: &[u8], format: &'a str) -> Result<Extracted<'a>> {
    if !matches!(format, "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp") {
        return Err("UNSUPPORTED_FORMAT");
    }
    let mut archive = Archive::new(data)?;
    let mut output = Text::new(matches!(format, "xlsx" | "pptx"));
    match format {
        "xlsx" => spreadsheet(&mut archive, &mut output)?,
        "pptx" => slides(&mut archive, &mut output)?,
        "docx" => {
            let xml = archive.xml("word/document.xml")?.ok_or(INVALID)?;
            paragraphs(&parse(&xml)?, WORD, false, &mut output);
        }
        _ => {
            let xml = archive.xml("content.xml")?.ok_or(INVALID)?;
            opendocument(&parse(&xml)?, &mut output);
        }
    }
    Ok(Extracted { format, text: output.value, truncated: output.truncated, bytes: data.len() })
}
