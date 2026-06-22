import io
import os
import uuid
import zipfile
import html
import tempfile
import re
from typing import List

# Try to use PyMuPDF for superior image/layout extraction if available
try:
    import pymupdf as fitz  # type: ignore
    HAS_FITZ = True
except ImportError:
    try:
        import fitz  # type: ignore
        HAS_FITZ = True
    except ImportError:
        HAS_FITZ = False
        fitz = None  # type: ignore

# Fallback to pylib/pypdf
try:
    import pypdf
    HAS_PYPDF = True
except ImportError:
    HAS_PYPDF = False
    pypdf = None  # type: ignore

# List regex rules
BULLET_REGEX = re.compile(r'^([\u2022\u25e6\u2023\u2219\*\-\u2014\u2013\u2022])\s+(.*)')
NUMBER_REGEX = re.compile(r'^(\(?\d+[\.\)]|\[\d+\])\s+(.*)')


def detect_body_font_size(doc) -> float:
    """
    Samples the first few pages of the document to statistically determine 
    the dominant body text font size.
    """
    sizes = {}
    for page_num in range(min(5, len(doc))):
        try:
            page_dict = doc[page_num].get_text("dict")
            if not isinstance(page_dict, dict):
                continue
            for block in page_dict.get("blocks", []):
                if block.get("type") == 0:  # Text block
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            size = round(span.get("size", 10.0), 1)
                            # Ignore headers/footers (too small) and titles (too large)
                            if 7.0 <= size <= 14.0:
                                text_len = len(span.get("text", ""))
                                sizes[size] = sizes.get(size, 0) + text_len
        except Exception:
            pass
    if not sizes:
        return 10.0
    return max(sizes, key=lambda k: sizes[k])


def clean_pdf_text_to_html(text: str) -> str:
    """
    Fallback semantic paragraph reconstruction for plain text extraction.
    """
    paragraphs = []
    current_paragraph = []
    
    for line in text.splitlines():
        line = line.strip()
        if not line:
            if current_paragraph:
                paragraphs.append(" ".join(current_paragraph))
                current_paragraph = []
        else:
            # Check if current_paragraph ends with a hyphenated word
            if current_paragraph and current_paragraph[-1].endswith("-") and not current_paragraph[-1].endswith(" -"):
                # Strip hyphen and merge
                current_paragraph[-1] = current_paragraph[-1][:-1] + line
            else:
                current_paragraph.append(line)
            
            # Heuristic: line ending in sentence-ending punctuation and short is likely paragraph end
            if line.endswith(('.', '!', '?')) and len(line) < 50:
                paragraphs.append(" ".join(current_paragraph))
                current_paragraph = []
                
    if current_paragraph:
        paragraphs.append(" ".join(current_paragraph))
        
    html_elements = []
    for p in paragraphs:
        p_escaped = html.escape(p)
        
        # Check if list item
        bullet_match = BULLET_REGEX.match(p)
        number_match = NUMBER_REGEX.match(p)
        
        if bullet_match:
            clean_item = re.sub(r'^([\u2022\u25e6\u2023\u2219\*\-\u2014\u2013\u2022]|\(?\d+[\.\)]|\[\d+\])\s*', '', p_escaped)
            html_elements.append(f"<ul><li>{clean_item}</li></ul>")
        elif number_match:
            clean_item = re.sub(r'^([\u2022\u25e6\u2023\u2219\*\-\u2014\u2013\u2022]|\(?\d+[\.\)]|\[\d+\])\s*', '', p_escaped)
            html_elements.append(f"<ol><li>{clean_item}</li></ol>")
        # Heading heuristic
        elif len(p) < 60 and p.istitle() and not p.endswith(('.', ',', ';')):
            html_elements.append(f"<h2>{p_escaped}</h2>")
        else:
            html_elements.append(f"<p>{p_escaped}</p>")
            
    # Combine adjacent <ul> and <ol> tags
    combined_html = "\n".join(html_elements)
    combined_html = combined_html.replace("</ul>\n<ul>", "")
    combined_html = combined_html.replace("</ol>\n<ol>", "")
    
    return combined_html


def is_caption_text(text: str) -> bool:
    cleaned = text.strip()
    return bool(re.match(r'^(figure|fig\.|table|graph|chart)\s+\d+', cleaned, re.IGNORECASE))


def extract_raw_text_from_block(block: dict) -> str:
    lines = []
    for line in block.get("lines", []):
        line_text = "".join([span.get("text", "") for span in line.get("spans", [])])
        lines.append(line_text)
    return " ".join(lines)


def format_table_to_html(table_data) -> str:
    html_lines = []
    html_lines.append('<div class="table-container">')
    html_lines.append('<table>')
    for row_idx, row in enumerate(table_data):
        html_lines.append('  <tr>')
        for col in row:
            val = col.strip() if col else ""
            escaped_val = html.escape(val).replace("\n", "<br/>")
            if row_idx == 0:
                html_lines.append(f'    <th>{escaped_val}</th>')
            else:
                html_lines.append(f'    <td>{escaped_val}</td>')
        html_lines.append('  </tr>')
    html_lines.append('</table>')
    html_lines.append('</div>')
    return "\n".join(html_lines)


def format_text_block_to_html(block: dict, body_size: float) -> str:
    lines_formatted = []
    font_names = set()
    max_font_size = 0.0
    
    for line in block.get("lines", []):
        line_spans = []
        for span in line.get("spans", []):
            text = span.get("text", "")
            text_stripped = text.strip()
            if not text_stripped:
                continue
            
            size = span.get("size", 10.0)
            if size > max_font_size:
                max_font_size = size
                
            flags = span.get("flags", 0)
            font = span.get("font", "").lower()
            font_names.add(font)
            
            is_bold = (flags & 16) or "bold" in font or "black" in font or "heavy" in font
            is_italic = (flags & 2) or "italic" in font or "oblique" in font
            is_super = (flags & 1) or "superscript" in font
            is_sub = "subscript" in font
            
            span_html = html.escape(text)
            if is_bold:
                span_html = f"<strong>{span_html}</strong>"
            if is_italic:
                span_html = f"<em>{span_html}</em>"
            if is_super:
                span_html = f"<sup>{span_html}</sup>"
            if is_sub:
                span_html = f"<sub>{span_html}</sub>"
                
            line_spans.append(span_html)
            
        if line_spans:
            lines_formatted.append(" ".join(line_spans))

    if not lines_formatted:
        return ""

    is_monospace = any("mono" in f or "courier" in f or "consolas" in f or "code" in f for f in font_names)
    if is_monospace:
        code_content = "\n".join(lines_formatted)
        return f"<pre><code>{code_content}</code></pre>"

    is_list = True
    list_items = []
    is_numbered = False
    
    for line in lines_formatted:
        plain_line = re.sub(r'<[^>]+>', '', line).strip()
        bullet_match = BULLET_REGEX.match(plain_line)
        number_match = NUMBER_REGEX.match(plain_line)
        
        if bullet_match:
            list_items.append((False, line))
        elif number_match:
            is_numbered = True
            list_items.append((True, line))
        else:
            if list_items:
                last_num, last_text = list_items[-1]
                list_items[-1] = (last_num, last_text + " " + line)
            else:
                is_list = False
                break
                
    if is_list and list_items:
        list_tag = "ol" if is_numbered else "ul"
        html_parts = [f"<{list_tag}>"]
        for _, item_text in list_items:
            clean_item = re.sub(r'^([\u2022\u25e6\u2023\u2219\*\-\u2014\u2013\u2022]|\(?\d+[\.\)]|\[\d+\])\s*', '', item_text)
            html_parts.append(f"  <li>{clean_item}</li>")
        html_parts.append(f"</{list_tag}>")
        return "\n".join(html_parts)

    current_line = ""
    for line in lines_formatted:
        if not current_line:
            current_line = line
        else:
            plain_current = re.sub(r'<[^>]+>', '', current_line).rstrip()
            if plain_current.endswith("-") and not plain_current.endswith(" -"):
                current_line = re.sub(r'-(</[^>]+>)*$', r'\1', current_line)
                current_line += line
            else:
                current_line += " " + line
                
    if max_font_size >= body_size + 4.0:
        return f"<h2>{current_line}</h2>"
    elif max_font_size >= body_size + 2.0:
        return f"<h3>{current_line}</h3>"
    else:
        return f"<p>{current_line}</p>"


def is_running_header_footer(block: dict, bbox: tuple, page_height: float) -> bool:
    if bbox == (0, 0, 0, 0) or page_height <= 0:
        return False
        
    x0, y0, x1, y1 = bbox
    # Only check if type is text (type == 0)
    if block.get("type") != 0:
        return False
        
    text = extract_raw_text_from_block(block).strip()
    if not text:
        return True # Empty text block, can discard
        
    # Header zone: top 8% of page
    if y1 < page_height * 0.08:
        lines = block.get("lines", [])
        if len(lines) <= 1 or text.isdigit() or len(text) < 100:
            return True
            
    # Footer zone: bottom 8% of page
    if y0 > page_height * 0.92:
        lines = block.get("lines", [])
        if len(lines) <= 1 or text.isdigit() or len(text) < 100:
            return True
            
    return False


def sort_and_filter_blocks(blocks: List[dict], page_width: float, page_height: float) -> List[dict]:
    # 1. Filter out headers and footers, and empty blocks
    filtered_blocks = []
    
    # Heuristic: only filter headers/footers if we have enough blocks on the page
    # to avoid false positives on pages with very little text.
    should_filter_header_footer = len(blocks) > 2
    
    for block in blocks:
        bbox = block.get("bbox", (0, 0, 0, 0))
        if should_filter_header_footer and is_running_header_footer(block, bbox, page_height):
            continue
        filtered_blocks.append(block)
        
    if not filtered_blocks:
        filtered_blocks = blocks
        
    if not filtered_blocks:
        return []
        
    # 2. Check if two-column layout
    mid_start = page_width * 0.45
    mid_end = page_width * 0.55
    
    left_count = 0
    right_count = 0
    cross_count = 0
    
    for b in filtered_blocks:
        bbox = b.get("bbox", (0, 0, 0, 0))
        x0, y0, x1, y1 = bbox
        
        # Skip small blocks for column detection
        if (x1 - x0) < 15 or (y1 - y0) < 10:
            continue
            
        if x0 < mid_start and x1 > mid_end:
            cross_count += 1
        elif x1 <= mid_end:
            left_count += 1
        elif x0 >= mid_start:
            right_count += 1
            
    total = left_count + right_count + cross_count
    is_two_column = False
    if total >= 3 and left_count > 0 and right_count > 0:
        if cross_count <= 0.2 * (left_count + right_count):
            is_two_column = True
            
    if is_two_column:
        left_side = []
        right_side = []
        crossing = []
        
        for b in filtered_blocks:
            bbox = b.get("bbox", (0, 0, 0, 0))
            x0, y0, x1, y1 = bbox
            mid_point = (x0 + x1) / 2
            
            if x0 < mid_start and x1 > mid_end:
                crossing.append(b)
            elif mid_point < page_width / 2:
                left_side.append(b)
            else:
                right_side.append(b)
                
        # Sort each group vertically by y0
        left_side.sort(key=lambda x: x.get("bbox", (0, 0, 0, 0))[1])
        right_side.sort(key=lambda x: x.get("bbox", (0, 0, 0, 0))[1])
        crossing.sort(key=lambda x: x.get("bbox", (0, 0, 0, 0))[1])
        
        # Merge crossing blocks: top crossing first, then left col, then right col, then bottom crossing
        top_crossing = [b for b in crossing if b.get("bbox", (0, 0, 0, 0))[1] < page_height * 0.3]
        bottom_crossing = [b for b in crossing if b.get("bbox", (0, 0, 0, 0))[1] >= page_height * 0.3]
        
        merged = []
        merged.extend(top_crossing)
        merged.extend(left_side)
        merged.extend(right_side)
        merged.extend(bottom_crossing)
        return merged
    else:
        # Single column layout: sort by y0, and then by x0 if y0 is very close (within 5px)
        def single_column_sort_key(b):
            bbox = b.get("bbox", (0, 0, 0, 0))
            return (round(bbox[1] / 5) * 5, bbox[0])
            
        filtered_blocks.sort(key=single_column_sort_key)
        return filtered_blocks


def convert_pdf_to_epub(pdf_bytes: bytes, title: str) -> bytes:
    """
    Converts PDF bytes into a clean, compliant EPUB 3.0 document.
    Uses PyMuPDF (if available) for precise inline text/image extraction and semantic block styling.
    Falls back to pypdf for clean paragraph-reconstructed text.
    """
    if not pdf_bytes:
        raise ValueError("PDF bytes cannot be empty")

    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = os.path.abspath(tmp_dir)
            content_dir = os.path.join(tmp_path, "OEBPS")
            images_dir = os.path.join(content_dir, "images")
            meta_dir = os.path.join(tmp_path, "META-INF")

            os.makedirs(images_dir, exist_ok=True)
            os.makedirs(meta_dir, exist_ok=True)
            os.makedirs(content_dir, exist_ok=True)

            pdf_stream = io.BytesIO(pdf_bytes)
            book_id = str(uuid.uuid4())
            
            manifest_entries: List[dict] = []
            spine_items: List[str] = []
            nav_links: List[tuple] = [] 

            # Create default style.css for beautiful typography
            style_content = """body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    background-color: #ffffff;
    margin: 1.5em;
}
p {
    margin-bottom: 1.2em;
    text-align: justify;
}
h1, h2, h3, h4 {
    font-family: inherit;
    font-weight: 600;
    color: #111111;
    margin-top: 1.5em;
    margin-bottom: 0.8em;
}
h1 { font-size: 1.8em; }
h2 { font-size: 1.5em; border-bottom: 1px solid rgba(0, 0, 0, 0.1); padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
.img-container {
    text-align: center;
    margin: 1.5em 0;
}
img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
figure {
    margin: 1.5em 0;
    text-align: center;
}
figcaption {
    font-size: 0.85em;
    color: #4b5563;
    margin-top: 0.5em;
    font-style: italic;
}
ul, ol {
    margin-bottom: 1.2em;
    padding-left: 1.5em;
}
li {
    margin-bottom: 0.4em;
}
pre {
    background-color: #f8fafc;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    padding: 1em;
    overflow-x: auto;
    margin: 1.5em 0;
}
code {
    font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.9em;
    color: #0f172a;
}
.table-container {
    overflow-x: auto;
    margin: 1.5em 0;
    background-color: #f8fafc;
    border-radius: 8px;
    border: 1px solid rgba(0, 0, 0, 0.08);
}
table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9em;
    color: #334155;
}
th, td {
    padding: 0.75em 1em;
    text-align: left;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
th {
    background-color: #f1f5f9;
    font-weight: 600;
    color: #0f172a;
}
tr:last-child td {
    border-bottom: none;
}
tr:nth-child(even) {
    background-color: rgba(0, 0, 0, 0.01);
}
blockquote {
    border-left: 4px solid #8b5cf6;
    padding-left: 1em;
    margin-left: 0;
    margin-right: 0;
    color: #4b5563;
    font-style: italic;
}
"""
            with open(os.path.join(content_dir, "style.css"), "w", encoding="utf-8") as f:
                f.write(style_content)

            manifest_entries.append({
                "id": "style",
                "href": "style.css",
                "media_type": "text/css"
            })

            if HAS_FITZ and fitz is not None:
                doc = fitz.open(stream=pdf_stream, filetype="pdf")  # type: ignore
                body_size = detect_body_font_size(doc)

                for page_num in range(len(doc)):
                    page = doc[page_num]
                    idx = page_num + 1
                    xhtml_filename = f"page_{idx}.xhtml"
                    xhtml_path = os.path.join(content_dir, xhtml_filename)
                    
                    page_dict = page.get_text("dict")
                    
                    # Safe fallback in case get_text("dict") is mocked to return text string in tests
                    if not isinstance(page_dict, dict):
                        text = page.get_text() or ""
                        text_str = text if isinstance(text, str) else str(text)
                        text_html = clean_pdf_text_to_html(text_str)
                    else:
                        rect = page.rect
                        page_width = rect.width
                        
                        # 1. Detect tables
                        detected_tables = []
                        try:
                            tables = page.find_tables()
                            if tables:
                                for table in tables:
                                    bbox = table.bbox
                                    table_data = table.extract()
                                    if table_data:
                                        detected_tables.append({
                                            "bbox": bbox,
                                            "data": table_data
                                        })
                        except Exception:
                            pass

                        # Helper to check if a block overlaps with any table
                        def is_inside_any_table(b_box):
                            bx0, by0, bx1, by1 = b_box
                            bcx = (bx0 + bx1) / 2.0
                            bcy = (by0 + by1) / 2.0
                            for t in detected_tables:
                                tx0, ty0, tx1, ty1 = t["bbox"]
                                if tx0 - 2 <= bcx <= tx1 + 2 and ty0 - 2 <= bcy <= ty1 + 2:
                                    return True
                            return False

                        blocks = page_dict.get("blocks", [])
                        
                        # Copy blocks and assign original index
                        blocks_with_idx = []
                        for b_idx, block in enumerate(blocks):
                            block_copy = dict(block)
                            block_copy["_orig_idx"] = b_idx
                            blocks_with_idx.append(block_copy)

                        # Sort and filter blocks using layout-aware reading order
                        page_height = rect.height
                        sorted_page_blocks = sort_and_filter_blocks(blocks_with_idx, page_width, page_height)

                        filtered_blocks_with_index = []
                        for sorted_pos, block in enumerate(sorted_page_blocks):
                            bbox = block.get("bbox", (0, 0, 0, 0))
                            if not is_inside_any_table(bbox):
                                orig_idx = block.get("_orig_idx", 0)
                                filtered_blocks_with_index.append((sorted_pos, orig_idx, block))

                        items = []
                        for sorted_pos, orig_idx, block in filtered_blocks_with_index:
                            items.append({
                                "type": "text" if block.get("type") == 0 else "image",
                                "bbox": block.get("bbox", (0, 0, 0, 0)),
                                "block": block,
                                "block_idx": orig_idx,
                                "sort_index": float(sorted_pos)
                            })

                        for t in detected_tables:
                            ty0 = t["bbox"][1]
                            insert_idx = len(sorted_page_blocks)
                            for sorted_pos, orig_idx, block in filtered_blocks_with_index:
                                by0 = block.get("bbox", (0, 0, 0, 0))[1]
                                if by0 > ty0:
                                    insert_idx = sorted_pos
                                    break
                            
                            items.append({
                                "type": "table",
                                "bbox": t["bbox"],
                                "data": t["data"],
                                "sort_index": insert_idx - 0.5
                            })

                        items.sort(key=lambda x: x["sort_index"])
                        sorted_items = items

                        xhtml_elements = []
                        skip_next = False
                        
                        for i in range(len(sorted_items)):
                            if skip_next:
                                skip_next = False
                                continue
                                
                            item = sorted_items[i]
                            
                            if item["type"] == "table":
                                table_html = format_table_to_html(item["data"])
                                xhtml_elements.append(table_html)
                                
                            elif item["type"] == "image":
                                block = item["block"]
                                block_idx = item["block_idx"]
                                img_data = block.get("image")
                                
                                if img_data:
                                    ext = block.get("ext", "png")
                                    img_name = f"img_{idx}_{block_idx}.{ext}"
                                    img_path = os.path.join(images_dir, img_name)
                                    with open(img_path, "wb") as f:
                                        f.write(img_data)
                                    
                                    manifest_entries.append({
                                        "id": f"img_{idx}_{block_idx}",
                                        "href": f"images/{img_name}",
                                        "media_type": f"image/{ext}"
                                    })
                                    
                                    # Caption grouping
                                    caption_html = ""
                                    if i + 1 < len(sorted_items) and sorted_items[i+1]["type"] == "text":
                                        next_text = extract_raw_text_from_block(sorted_items[i+1]["block"])
                                        if is_caption_text(next_text):
                                            caption_html = f"<figcaption>{html.escape(next_text.strip())}</figcaption>"
                                            skip_next = True
                                            
                                    if caption_html:
                                        xhtml_elements.append(
                                            f'<figure class="img-container">\n  <img src="images/{img_name}" alt="inline image" />\n  {caption_html}\n</figure>'
                                        )
                                    else:
                                        xhtml_elements.append(
                                            f'<div class="img-container"><img src="images/{img_name}" alt="inline image" /></div>'
                                        )
                                        
                            elif item["type"] == "text":
                                block_html = format_text_block_to_html(item["block"], body_size)
                                if block_html:
                                    xhtml_elements.append(block_html)

                        text_html = "\n".join(xhtml_elements)

                    xhtml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Page {idx}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>{text_html}</body>
</html>"""
                    with open(xhtml_path, "w", encoding="utf-8") as f:
                        f.write(xhtml_content)
                    
                    manifest_entries.append({
                        "id": f"page_{idx}",
                        "href": xhtml_filename,
                        "media_type": "application/xhtml+xml"
                    })
                    spine_items.append(f"page_{idx}")
                    nav_links.append((idx, xhtml_filename))
                doc.close()
            elif HAS_PYPDF and pypdf is not None:
                reader = pypdf.PdfReader(pdf_stream)  # type: ignore
                for page_num in range(len(reader.pages)):
                    page = reader.pages[page_num]
                    idx = page_num + 1
                    text = page.extract_text() or ""
                    text_html = clean_pdf_text_to_html(text)
                    
                    xhtml_filename = f"page_{idx}.xhtml"
                    xhtml_path = os.path.join(content_dir, xhtml_filename)
                    xhtml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Page {idx}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>{text_html}</body>
</html>"""
                    with open(xhtml_path, "w", encoding="utf-8") as f:
                        f.write(xhtml_content)
                    manifest_entries.append({
                        "id": f"page_{idx}",
                        "href": xhtml_filename,
                        "media_type": "application/xhtml+xml"
                    })
                    spine_items.append(f"page_{idx}")
                    nav_links.append((idx, xhtml_filename))
            else:
                raise RuntimeError("No PDF library available.")

            # Create nav.xhtml first so we can include it in the manifest and spine
            nav_links_str = "".join([f'<li><a href="{fn}">Page {pn}</a></li>' for pn, fn in nav_links])
            nav_xhtml = f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h1>Contents</h1>
  <nav epub:type="toc">
    <ul>{nav_links_str}</ul>
  </nav>
</body>
</html>"""
            with open(os.path.join(content_dir, "nav.xhtml"), "w", encoding="utf-8") as f:
                f.write(nav_xhtml)
            manifest_entries.append({
                "id": "nav",
                "href": "nav.xhtml",
                "media_type": "application/xhtml+xml",
                "properties": "nav"
            })
            spine_items.append("nav")

            # Create container.xml
            with open(os.path.join(meta_dir, "container.xml"), "w", encoding="utf-8") as f:
                f.write('<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:openddocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')

            # Create content.opf after appending nav to manifest/spine
            manifest_str = "".join([
                f'<item id="{e["id"]}" href="{e["href"]}" media_type="{e["media_type"]}"' + 
                (f' properties="{e["properties"]}"' if "properties" in e else "") + '/>'
                for e in manifest_entries
            ])
            spine_str = "".join([f'<itemref idref="{s}"/>' for s in spine_items])
            opf_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="{book_id}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="{book_id}">{book_id}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>{manifest_str}</manifest>
  <spine>{spine_str}</spine>
</package>"""
            with open(os.path.join(content_dir, "content.opf"), "w", encoding="utf-8") as f:
                f.write(opf_content)

            # Assemble ZIP
            epub_io = io.BytesIO()
            with zipfile.ZipFile(epub_io, "w", compression=zipfile.ZIP_DEFLATED) as epub:
                epub.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
                for root, _, files in os.walk(tmp_path):
                    for file in files:
                        f_p = os.path.join(root, file)
                        rel_p = os.path.relpath(f_p, tmp_path).replace(os.sep, '/')
                        if rel_p == "mimetype": 
                            continue
                        with open(f_p, "rb") as f:
                            epub.writestr(rel_p, f.read())
            return epub_io.getvalue()
    except Exception as e:
        raise RuntimeError(f"Failed to convert PDF to EPUB: {e}") from e
