import io
import zipfile
import app.epub_converter
from app.epub_converter import convert_pdf_to_epub

def test_convert_pdf_to_epub_fitz(monkeypatch):
    # Mock fitz (PyMuPDF) structures
    class MockRect:
        def __init__(self, width=600.0, height=800.0):
            self.width = width
            self.height = height

    class MockFitzPage:
        def __init__(self, text):
            self.text = text
            self.rect = MockRect()
            
        def get_text(self, option=None):
            if option == "dict":
                lines = []
                for line_text in self.text.splitlines():
                    lines.append({
                        "spans": [
                            {
                                "text": line_text,
                                "size": 10.0,
                                "flags": 0,
                                "font": "Inter-Regular"
                            }
                        ]
                    })
                return {
                    "blocks": [
                        {
                            "type": 0,  # Text block
                            "lines": lines
                        }
                    ]
                }
            return self.text

        def get_images(self, full=False):
            return []

        def find_tables(self):
            return []

    class MockFitzDoc:
        def __init__(self, pages):
            self.pages = pages
            self._page_count = len(pages)
        def __len__(self):
            return self._page_count
        def __getitem__(self, idx):
            return self.pages[idx]
        def close(self):
            pass

    class MockFitzModule:
        def open(self, stream=None, filetype=None):
            return MockFitzDoc([
                MockFitzPage("Content of page 1 line 1\nContent of page 1 line 2"),
                MockFitzPage("Content of page 2 line 1")
            ])

    # Force fitz branch
    monkeypatch.setattr(app.epub_converter, "HAS_FITZ", True)
    monkeypatch.setattr(app.epub_converter, "fitz", MockFitzModule())

    # Convert to EPUB using dummy bytes
    epub_bytes = convert_pdf_to_epub(b"dummy pdf content", "Test Book Title")
    
    # Verify ZIP archive and EPUB files
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as epub:
        namelist = epub.namelist()
        assert namelist[0] == "mimetype"
        
        info = epub.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED
        assert epub.read("mimetype") == b"application/epub+zip"
        
        assert "META-INF/container.xml" in namelist
        assert "OEBPS/content.opf" in namelist
        assert "OEBPS/nav.xhtml" in namelist
        assert "OEBPS/page_1.xhtml" in namelist
        assert "OEBPS/page_2.xhtml" in namelist
        
        nav_content = epub.read("OEBPS/nav.xhtml").decode("utf-8")
        opf_content = epub.read("OEBPS/content.opf").decode("utf-8")
        assert "Test Book Title" in opf_content
        
        assert 'href="nav.xhtml"' in opf_content
        assert 'properties="nav"' in opf_content
        assert 'idref="nav"' in opf_content
        
        assert 'xmlns:epub="http://www.idpf.org/2007/ops"' in nav_content
        assert 'epub:type="toc"' in nav_content
        
        page1_content = epub.read("OEBPS/page_1.xhtml").decode("utf-8")
        assert "Content of page 1 line 1" in page1_content
        assert "Content of page 1 line 2" in page1_content
        
        page2_content = epub.read("OEBPS/page_2.xhtml").decode("utf-8")
        assert "Content of page 2 line 1" in page2_content


def test_convert_pdf_to_epub_pypdf(monkeypatch):
    # Mock pypdf.PdfReader to return mock pages with actual text
    class MockPage:
        def __init__(self, text):
            self.text = text
        def extract_text(self):
            return self.text

    class MockReader:
        def __init__(self, stream_or_file):
            self.pages = [
                MockPage("Content of page 1 line 1\nContent of page 1 line 2"),
                MockPage("Content of page 2 line 1")
            ]

    # Force pypdf branch
    monkeypatch.setattr(app.epub_converter, "HAS_FITZ", False)
    monkeypatch.setattr(app.epub_converter, "HAS_PYPDF", True)
    monkeypatch.setattr(app.epub_converter, "pypdf", type('MockPyPDFModule', (object,), {'PdfReader': MockReader})())

    # Convert to EPUB using dummy bytes
    epub_bytes = convert_pdf_to_epub(b"dummy pdf content", "Test Book Title")
    
    # Verify ZIP archive and EPUB files
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as epub:
        namelist = epub.namelist()
        assert namelist[0] == "mimetype"
        
        info = epub.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED
        assert epub.read("mimetype") == b"application/epub+zip"
        
        assert "META-INF/container.xml" in namelist
        assert "OEBPS/content.opf" in namelist
        assert "OEBPS/nav.xhtml" in namelist
        assert "OEBPS/page_1.xhtml" in namelist
        assert "OEBPS/page_2.xhtml" in namelist
        
        nav_content = epub.read("OEBPS/nav.xhtml").decode("utf-8")
        opf_content = epub.read("OEBPS/content.opf").decode("utf-8")
        assert "Test Book Title" in opf_content
        
        assert 'href="nav.xhtml"' in opf_content
        assert 'properties="nav"' in opf_content
        assert 'idref="nav"' in opf_content
        
        assert 'xmlns:epub="http://www.idpf.org/2007/ops"' in nav_content
        assert 'epub:type="toc"' in nav_content
        
        page1_content = epub.read("OEBPS/page_1.xhtml").decode("utf-8")
        assert "Content of page 1 line 1" in page1_content
        assert "Content of page 1 line 2" in page1_content
        
        page2_content = epub.read("OEBPS/page_2.xhtml").decode("utf-8")
        assert "Content of page 2 line 1" in page2_content


def test_convert_pdf_to_epub_fitz_with_tables(monkeypatch):
    # Mock fitz (PyMuPDF) structures
    class MockRect:
        def __init__(self, width=600.0, height=800.0):
            self.width = width
            self.height = height

    class MockTable:
        def __init__(self, bbox, data):
            self.bbox = bbox
            self.data = data
        def extract(self):
            return self.data

    class MockFitzPage:
        def __init__(self, text):
            self.text = text
            self.rect = MockRect()
            
        def get_text(self, option=None):
            if option == "dict":
                return {
                    "blocks": [
                        {
                            "type": 0,  # Text block
                            "bbox": (10, 10, 100, 20),
                            "lines": [
                                {
                                    "spans": [
                                        {
                                            "text": "Regular Text Block Outside Tables",
                                            "size": 10.0,
                                            "flags": 0,
                                            "font": "Inter-Regular"
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            return self.text

        def get_images(self, full=False):
            return []

        def find_tables(self):
            return [
                MockTable(bbox=(10, 50, 200, 100), data=[["Header 1", "Header 2"], ["Row 1 Col 1", "Row 1 Col 2"]]),
                MockTable(bbox=(10, 120, 200, 170), data=[["Col A", "Col B"], ["Val A", "Val B"]])
            ]

    class MockFitzDoc:
        def __init__(self, pages):
            self.pages = pages
            self._page_count = len(pages)
        def __len__(self):
            return self._page_count
        def __getitem__(self, idx):
            return self.pages[idx]
        def close(self):
            pass

    class MockFitzModule:
        def open(self, stream=None, filetype=None):
            return MockFitzDoc([
                MockFitzPage("Dummy text page 1"),
            ])

    # Force fitz branch
    monkeypatch.setattr(app.epub_converter, "HAS_FITZ", True)
    monkeypatch.setattr(app.epub_converter, "fitz", MockFitzModule())

    # Convert to EPUB using dummy bytes
    epub_bytes = convert_pdf_to_epub(b"dummy pdf content", "Test Book with Tables")
    
    # Verify ZIP archive and EPUB files
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as epub:
        namelist = epub.namelist()
        assert "OEBPS/page_1.xhtml" in namelist
        page_content = epub.read("OEBPS/page_1.xhtml").decode("utf-8")
        
        # Check that table HTML is generated
        assert "Header 1" in page_content
        assert "Row 1 Col 1" in page_content
        assert "Col A" in page_content
        assert "Val B" in page_content
        # Check text block is also present
        assert "Regular Text Block Outside Tables" in page_content


def test_convert_pdf_to_epub_with_special_characters_in_title(monkeypatch):
    class MockPage:
        def __init__(self, text):
            self.text = text
        def extract_text(self):
            return self.text

    class MockReader:
        def __init__(self, stream_or_file):
            self.pages = [MockPage("Some sample page text")]

    monkeypatch.setattr(app.epub_converter, "HAS_FITZ", False)
    monkeypatch.setattr(app.epub_converter, "HAS_PYPDF", True)
    monkeypatch.setattr(app.epub_converter, "pypdf", type('MockPyPDFModule', (object,), {'PdfReader': MockReader})())

    epub_bytes = convert_pdf_to_epub(b"dummy pdf content", "Manga & Comics <Web>")
    
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as epub:
        opf_content = epub.read("OEBPS/content.opf").decode("utf-8")
        # The title should be properly XML escaped
        assert "<dc:title>Manga &amp; Comics &lt;Web&gt;</dc:title>" in opf_content


