import gzip
import os

def compress_and_save(file_data: bytes, dest_path: str):
    """
    Compresses binary file data using gzip and saves it to the destination path.
    """
    # Ensure destination directory exists
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with gzip.open(dest_path, "wb", compresslevel=6) as f:
        f.write(file_data)

def decompress_and_stream(source_path: str, chunk_size: int = 1024 * 64):
    """
    Generator that reads a gzip compressed file and yields decompressed chunks.
    Allows streaming large books/mangas with minimal memory footprint.
    """
    if not os.path.exists(source_path):
        raise FileNotFoundError(f"File not found: {source_path}")
        
    with gzip.open(source_path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            yield chunk
