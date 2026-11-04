"""Extracción de texto de documentos de oficina abiertos por handles.

Reutiliza la apertura segura por componentes de native_reader.py (sin seguir
enlaces) y lee los bytes por el mismo descriptor. Analiza en memoria, con
límites estrictos, los formatos basados en ZIP + XML:

- OOXML: .docx (Word), .xlsx (Excel), .pptx (PowerPoint)
- OpenDocument: .odt, .ods, .odp

No ejecuta macros ni sigue relaciones externas. Rechaza DTD y entidades XML
(DOCTYPE/ENTITY) antes de analizar, y limita el número de miembros, el tamaño
descomprimido y la proporción de compresión contra bombas ZIP. Solo
biblioteca estándar. El original no se modifica ni se copia.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

_spec = importlib.util.spec_from_file_location('native_reader', Path(__file__).with_name('native_reader.py'))
reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reader)

Refusal = reader.Refusal
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_RATIO = 200
MAX_TEXT_CHARS = 1024 * 1024
FORMATS = ('docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp')

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
TEXT = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
TABLE = '{urn:oasis:names:tc:opendocument:xmlns:table:1.0}'
DRAW = '{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}'


class Archive:
    """Acceso acotado a los miembros de un ZIP en memoria."""

    def __init__(self, data):
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
            infos = self.zip.infolist()
        except (zipfile.BadZipFile, ValueError, OSError):
            raise Refusal('DOCUMENT_INVALID') from None
        if len(infos) > MAX_MEMBERS:
            raise Refusal('DOCUMENT_TOO_COMPLEX')
        self.infos = {info.filename: info for info in infos}
        self.total = 0

    def names(self):
        return list(self.infos)

    def read(self, name):
        info = self.infos.get(name)
        if info is None:
            return None
        if info.flag_bits & 0x1:
            raise Refusal('DOCUMENT_ENCRYPTED')
        if info.file_size > MAX_MEMBER_BYTES or (info.compress_size and info.file_size / info.compress_size > MAX_RATIO):
            raise Refusal('DOCUMENT_TOO_COMPLEX')
        try:
            with self.zip.open(info) as member:
                data = member.read(MAX_MEMBER_BYTES + 1)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError):
            raise Refusal('DOCUMENT_INVALID') from None
        self.total += len(data)
        if len(data) > MAX_MEMBER_BYTES or self.total > MAX_TOTAL_BYTES:
            raise Refusal('DOCUMENT_TOO_COMPLEX')
        return data

    def xml(self, name):
        data = self.read(name)
        if data is None:
            return None
        # Sin DTD ni entidades: evita expansiones y referencias externas.
        if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
            raise Refusal('DOCUMENT_UNSAFE')
        try:
            return ET.fromstring(data)
        except ET.ParseError:
            raise Refusal('DOCUMENT_INVALID') from None


def _paragraphs(root, paragraph_tag, text_tags, tab_tag=None, break_tag=None):
    lines = []
    for paragraph in root.iter(paragraph_tag):
        parts = []
        for node in paragraph.iter():
            if node.tag in text_tags and node.text:
                parts.append(node.text)
            elif tab_tag and node.tag == tab_tag:
                parts.append('\t')
            elif break_tag and node.tag == break_tag:
                parts.append('\n')
        lines.append(''.join(parts))
    return lines


def docx(archive):
    root = archive.xml('word/document.xml')
    if root is None:
        raise Refusal('DOCUMENT_INVALID')
    return '\n'.join(_paragraphs(root, f'{W}p', {f'{W}t'}, f'{W}tab', f'{W}br'))


def _sheet_order(archive):
    """Nombres y archivos de las hojas en el orden del libro."""
    workbook = archive.xml('xl/workbook.xml')
    relations = archive.xml('xl/_rels/workbook.xml.rels')
    targets = {}
    if relations is not None:
        for relation in relations:
            target = relation.get('Target', '')
            if relation.get('TargetMode') == 'External' or '..' in target.split('/'):
                continue
            targets[relation.get('Id')] = 'xl/' + target.lstrip('/').removeprefix('xl/')
    sheets = []
    if workbook is not None:
        for sheet in workbook.iter(f'{S}sheet'):
            target = targets.get(sheet.get(f'{R}id'))
            if target:
                sheets.append((sheet.get('name') or target, target))
    if not sheets:
        sheets = [(name, name) for name in sorted(archive.names()) if re.match(r'xl/worksheets/sheet\d+\.xml$', name)]
    return sheets


def xlsx(archive):
    shared = []
    strings = archive.xml('xl/sharedStrings.xml')
    if strings is not None:
        for item in strings.iter(f'{S}si'):
            shared.append(''.join(node.text or '' for node in item.iter(f'{S}t')))
    output = []
    for name, target in _sheet_order(archive):
        sheet = archive.xml(target)
        if sheet is None:
            continue
        output.append(f'# Hoja: {name}')
        for row in sheet.iter(f'{S}row'):
            cells = []
            for cell in row.iter(f'{S}c'):
                kind = cell.get('t')
                value = cell.find(f'{S}v')
                if kind == 's' and value is not None and value.text and value.text.isdigit():
                    index = int(value.text)
                    cells.append(shared[index] if index < len(shared) else '')
                elif kind == 'inlineStr':
                    cells.append(''.join(node.text or '' for node in cell.iter(f'{S}t')))
                else:
                    cells.append(value.text if value is not None and value.text else '')
            output.append('\t'.join(cells))
        output.append('')
    return '\n'.join(output).rstrip('\n')


def pptx(archive):
    slides = sorted((name for name in archive.names() if re.match(r'ppt/slides/slide\d+\.xml$', name)),
                    key=lambda name: int(re.search(r'(\d+)\.xml$', name).group(1)))
    output = []
    for number, name in enumerate(slides, 1):
        root = archive.xml(name)
        output.append(f'# Diapositiva {number}')
        output.extend(line for line in _paragraphs(root, f'{A}p', {f'{A}t'}) if line)
        output.append('')
    return '\n'.join(output).rstrip('\n')


def opendocument(archive):
    root = archive.xml('content.xml')
    if root is None:
        raise Refusal('DOCUMENT_INVALID')
    lines = []
    for node in root.iter():
        if node.tag in (f'{TEXT}p', f'{TEXT}h'):
            lines.append(''.join(node.itertext()))
        elif node.tag == f'{TABLE}table-row':
            cells = [''.join(cell.itertext()) for cell in node if cell.tag == f'{TABLE}table-cell']
            if any(cells):
                lines.append('\t'.join(cells))
    # Las filas de tabla repiten sus párrafos: se conservan ambos niveles de forma legible.
    return '\n'.join(lines)


def extract(data, kind):
    if kind not in FORMATS:
        raise Refusal('UNSUPPORTED_FORMAT')
    archive = Archive(data)
    if kind == 'docx':
        text = docx(archive)
    elif kind == 'xlsx':
        text = xlsx(archive)
    elif kind == 'pptx':
        text = pptx(archive)
    else:
        text = opendocument(archive)
    truncated = len(text) > MAX_TEXT_CHARS
    return {'format': kind, 'text': text[:MAX_TEXT_CHARS], 'truncated': truncated, 'bytes': len(data)}


def error_code(error):
    if isinstance(error, Refusal):
        return str(error)
    return reader.error_code(error)


def run():
    """Protocolo como native_reader: petición, READY, espera R, resultado JSON."""
    try:
        reader.guard_parent()
        request = json.loads(sys.stdin.buffer.readline(32768))
        if not isinstance(request, dict) or set(request) != {'root', 'relativePath', 'format'}:
            raise Refusal('READ_FAILED')
        fd = reader.safe_open(request['root'], request['relativePath'])
        with os.fdopen(fd, 'rb', buffering=0) as source:
            sys.stderr.write('READY\n')
            sys.stderr.flush()
            if sys.stdin.buffer.read(1) != b'R':
                raise Refusal('READ_FAILED')
            if os.fstat(source.fileno()).st_size > MAX_FILE_BYTES:
                raise Refusal('FILE_TOO_LARGE')
            data = source.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise Refusal('FILE_TOO_LARGE')
        sys.stdout.write(json.dumps(extract(data, request['format'])))
        return 0
    except Exception as error:
        sys.stderr.write(error_code(error) + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
