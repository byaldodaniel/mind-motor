"""Extracción de texto de documentos ficticios creados en la prueba."""
import importlib.util
import io
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

MOTOR = Path(__file__).resolve().parents[1]
DEVELOPMENT = MOTOR.parent
spec = importlib.util.spec_from_file_location('native_extract', MOTOR / 'src' / 'native_extract.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def archive(members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as target:
        for name, data in members.items():
            target.writestr(name, data)
    return buffer.getvalue()


def docx(paragraphs):
    body = ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in paragraphs)
    return archive({'word/document.xml': f'<?xml version="1.0"?><w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'})


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='.mind-native-extract-test-', dir=DEVELOPMENT))

    def tearDown(self):
        self.assertEqual(self.temp.parent, DEVELOPMENT)
        shutil.rmtree(self.temp)

    def code(self, data, kind):
        with self.assertRaises(native.Refusal) as failure:
            native.extract(data, kind)
        return str(failure.exception)

    def test_docx_xlsx_pptx_and_opendocument_text(self):
        self.assertEqual(native.extract(docx(['Acta ficticia', 'Acuerdo: revisar']), 'docx')['text'], 'Acta ficticia\nAcuerdo: revisar')
        xlsx = archive({
            'xl/workbook.xml': f'<workbook xmlns="{S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Gastos" r:id="rId1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/sharedStrings.xml': f'<sst xmlns="{S}"><si><t>Concepto</t></si><si><t>Papel ficticio</t></si></sst>',
            'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{S}"><sheetData><row><c t="s"><v>0</v></c><c><v>Importe</v></c></row><row><c t="s"><v>1</v></c><c><v>12.5</v></c></row></sheetData></worksheet>',
        })
        self.assertEqual(native.extract(xlsx, 'xlsx')['text'], '# Hoja: Gastos\nConcepto\tImporte\nPapel ficticio\t12.5')
        pptx = archive({
            'ppt/slides/slide2.xml': f'<p:sld xmlns:p="x" xmlns:a="{A}"><a:p><a:r><a:t>Segunda</a:t></a:r></a:p></p:sld>',
            'ppt/slides/slide1.xml': f'<p:sld xmlns:p="x" xmlns:a="{A}"><a:p><a:r><a:t>Portada ficticia</a:t></a:r></a:p></p:sld>',
        })
        self.assertEqual(native.extract(pptx, 'pptx')['text'], '# Diapositiva 1\nPortada ficticia\n\n# Diapositiva 2\nSegunda')
        odt = archive({'content.xml': '<office:document-content xmlns:office="o" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><text:p>Nota ficticia</text:p><text:h>Título</text:h></office:body></office:document-content>'})
        self.assertEqual(native.extract(odt, 'odt')['text'], 'Nota ficticia\nTítulo')

    def test_dtd_entities_bombs_encryption_and_garbage_are_refused(self):
        bomb = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaa">]><w:document xmlns:w="%s"><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>' % W
        self.assertEqual(self.code(archive({'word/document.xml': bomb}), 'docx'), 'DOCUMENT_UNSAFE')
        self.assertEqual(self.code(b'no es un zip', 'docx'), 'DOCUMENT_INVALID')
        self.assertEqual(self.code(archive({'otro.xml': '<a/>'}), 'docx'), 'DOCUMENT_INVALID')
        zero = archive({'word/document.xml': '<w:document xmlns:w="%s">' % W + ' ' * (8 * 1024 * 1024) + '</w:document>'})
        self.assertEqual(self.code(zero, 'docx'), 'DOCUMENT_TOO_COMPLEX')
        many = archive({f'x/{number}.xml': '<a/>' for number in range(native.MAX_MEMBERS + 1)})
        self.assertEqual(self.code(many, 'docx'), 'DOCUMENT_TOO_COMPLEX')
        self.assertEqual(self.code(docx(['x']), 'pdf'), 'UNSUPPORTED_FORMAT')

    def test_text_is_truncated_with_a_flag(self):
        # Texto variado y determinista: se comprime como un documento real, no como una bomba.
        import random
        generator = random.Random(7)
        words = ['presupuesto', 'acta', 'reunión', 'ficticia', 'revisar', 'marzo', 'equipo', 'total', 'gasto', 'nota']
        paragraphs = [' '.join(generator.choice(words) + str(generator.randrange(10_000)) for _ in range(120))
                      for _ in range(native.MAX_TEXT_CHARS // 1000 + 200)]
        long = docx(paragraphs)
        result = native.extract(long, 'docx')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['text']), native.MAX_TEXT_CHARS)

    def test_links_are_not_followed(self):
        if os.name == 'nt':
            self.skipTest('enlaces simbólicos sin privilegios no disponibles en todos los equipos Windows')
        folder = self.temp / 'Información ficticia'
        outside = self.temp / 'ajena'
        folder.mkdir()
        outside.mkdir()
        (outside / 'secreto.docx').write_bytes(docx(['ajeno']))
        os.symlink(outside / 'secreto.docx', folder / 'enlace.docx')
        with self.assertRaises((native.Refusal, OSError)) as failure:
            native.reader.safe_open(str(folder), 'enlace.docx')
        self.assertIn(native.error_code(failure.exception), ('UNSAFE_PATH', 'FILE_NOT_FOUND'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
