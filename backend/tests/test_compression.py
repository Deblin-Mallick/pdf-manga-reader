import os
import pytest
from app.compression import compress_and_save, decompress_and_stream

def test_compress_and_decompress(tmp_path):
    dest_path = str(tmp_path / "test_book.gz")
    test_data = b"Hello, this is standard book content to compress! " * 100
    
    # Compress
    compress_and_save(test_data, dest_path)
    assert os.path.exists(dest_path)
    assert os.path.getsize(dest_path) > 0
    
    # Decompress
    decompressed_data = b"".join(decompress_and_stream(dest_path))
    assert decompressed_data == test_data

def test_decompress_file_not_found():
    with pytest.raises(FileNotFoundError):
        list(decompress_and_stream("non_existent_file.gz"))
