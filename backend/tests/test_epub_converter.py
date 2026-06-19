import io
import zipfile
from app.epub_converter import convert_pdf_to_epub

def test_convert_pdf_to_epub(monkeypatch):
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
            
    monkeypatch.setattr("pypdf.PdfReader", MockReader)
    
    # Convert to EPUB using dummy bytes (which will be passed to MockReader)
    epub_bytes = convert_pdf_to_epub(b"dummy pdf content", "Test Book Title")
    
    # Verify ZIP archive and EPUB files
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as epub:
        # Check mimetype is the first entry
        namelist = epub.namelist()
        assert namelist[0] == "mimetype"
        
        # Verify uncompressed mimetype
        info = epub.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED
        assert epub.read("mimetype") == b"application/epub+zip"
        
        # Verify required files exist
        assert "META-INF/container.xml" in namelist
        assert "OEBPS/content.opf" in namelist
        assert "OEBPS/toc.ncx" in namelist
        assert "OEBPS/page_1.xhtml" in namelist
        assert "OEBPS/page_2.xhtml" in namelist
        
        # Check title in toc.ncx and content.opf
        toc_content = epub.read("OEBPS/toc.ncx").decode("utf-8")
        assert "Test Book Title" in toc_content
        
        opf_content = epub.read("OEBPS/content.opf").decode("utf-8")
        assert "Test Book Title" in opf_content
        
        # Check page XHTML content contains our mock text
        page1_content = epub.read("OEBPS/page_1.xhtml").decode("utf-8")
        assert "Content of page 1 line 1" in page1_content
        assert "Content of page 1 line 2" in page1_content
        
        page2_content = epub.read("OEBPS/page_2.xhtml").decode("utf-8")
        assert "Content of page 2 line 1" in page2_content
