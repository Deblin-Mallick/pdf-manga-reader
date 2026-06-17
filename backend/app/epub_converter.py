import io
import uuid
import zipfile
import html
import pypdf

def convert_pdf_to_epub(pdf_bytes: bytes, title: str) -> bytes:
    """
    Converts raw PDF file bytes into standard EPUB v2.0 file bytes.
    Extracts text page-by-page using pypdf and builds the EPUB structure.
    """
    pdf_file = io.BytesIO(pdf_bytes)

    # 1. Parse PDF and extract page contents
    reader = pypdf.PdfReader(pdf_file)
    pages_text = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages_text.append(text)

    # If the PDF is empty or text-free, provide a fallback message
    if not pages_text or all(not t.strip() for t in pages_text):
        pages_text = ["This document contains no readable text, or is a scanned image PDF."]

    book_id = str(uuid.uuid4())

    # 2. Build the EPUB archive in-memory
    epub_io = io.BytesIO()
    with zipfile.ZipFile(epub_io, "w", zipfile.ZIP_DEFLATED) as epub:
        # Write mimetype uncompressed as the first entry (EPUB spec requirement)
        zinfo = zipfile.ZipInfo("mimetype")
        zinfo.compress_type = zipfile.ZIP_STORED
        epub.writestr(zinfo, "application/epub+zip")

        # Write container setup
        container_xml = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""
        epub.writestr("META-INF/container.xml", container_xml)

        manifest_items = []
        spine_items = []
        nav_points = []
        
        # Write XHTML files for each page
        for idx, text in enumerate(pages_text, start=1):
            file_name = f"page_{idx}.xhtml"
            escaped_text = html.escape(text)
            
            # Format text into paragraphs by newline
            paragraphs_html = ""
            for line in escaped_text.split("\n"):
                line_trimmed = line.strip()
                if line_trimmed:
                    paragraphs_html += f"  <p>{line_trimmed}</p>\n"
            
            page_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Page {idx}</title>
  <style type="text/css">
    body {{ font-family: system-ui, sans-serif; padding: 1.5em; line-height: 1.6; font-size: 1em; }}
    p {{ margin-bottom: 1.2em; text-align: justify; }}
    h2 {{ font-size: 1.25em; border-bottom: 1px solid #ccc; padding-bottom: 0.3em; margin-bottom: 1em; }}
  </style>
</head>
<body>
  <h2>Page {idx}</h2>
{paragraphs_html}</body>
</html>"""
            
            epub.writestr(f"OEBPS/{file_name}", page_content)
            
            # Register items in OPF and NCX structures
            manifest_items.append(f'    <item id="page_{idx}" href="{file_name}" media-type="application/xhtml+xml"/>')
            spine_items.append(f'    <itemref idref="page_{idx}"/>')
            nav_points.append(f"""    <navPoint id="navPoint_{idx}" playOrder="{idx}">
      <navLabel>
        <text>Page {idx}</text>
      </navLabel>
      <content src="{file_name}"/>
    </navPoint>""")

        # Write NCX Table of Contents
        toc_ncx = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD NCX 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:{book_id}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>{html.escape(title)}</text>
  </docTitle>
  <navMap>
{"\n".join(nav_points)}
  </navMap>
</ncx>"""
        epub.writestr("OEBPS/toc.ncx", toc_ncx)

        # Write OPF Manifest package schema
        content_opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>{html.escape(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">urn:uuid:{book_id}</dc:identifier>
    <dc:creator>PDF-to-EPUB Converter</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
{"\n".join(manifest_items)}
  </manifest>
  <spine toc="ncx">
{"\n".join(spine_items)}
  </spine>
</package>"""
        epub.writestr("OEBPS/content.opf", content_opf)

    return epub_io.getvalue()
