"""Unit tests for DocsService."""
import pytest
from unittest.mock import MagicMock
from services.docs.service import DocsService, DocChunk, IndexResult

@pytest.mark.asyncio
async def test_docs_service_query():
    # Arrange
    service = DocsService(persist_dir="mock_dir")
    service.rag = MagicMock()
    
    mock_results = [
        {
            "text": "Hello world",
            "source": "doc1.txt",
            "score": 0.95,
            "metadata": {"author": "Jane", "source": "meta_source"}
        },
        {
            "content": "Second paragraph",
            "metadata": {"source": "doc2.txt"}
        },
        {
            "text": None,
            "content": "Third paragraph",
            "metadata": None,
            "score": "invalid_score"
        }
    ]
    service.rag.search.return_value = mock_results

    # Act
    chunks = await service.query("hello", top_k=3)

    # Assert
    assert len(chunks) == 3
    
    # First chunk
    assert chunks[0].text == "Hello world"
    assert chunks[0].source == "doc1.txt"
    assert chunks[0].score == 0.95
    assert chunks[0].metadata == {"author": "Jane", "source": "meta_source"}

    # Second chunk (falls back to content, and falls back to metadata source)
    assert chunks[1].text == "Second paragraph"
    assert chunks[1].source == "doc2.txt"
    assert chunks[1].score == 0.0
    assert chunks[1].metadata == {"source": "doc2.txt"}

    # Third chunk (handles None values, invalid score gracefully)
    assert chunks[2].text == "Third paragraph"
    assert chunks[2].source == "unknown"
    assert chunks[2].score == 0.0
    assert chunks[2].metadata is None


@pytest.mark.asyncio
async def test_docs_service_index():
    # Arrange
    service = DocsService(persist_dir="mock_dir")
    service.rag = MagicMock()
    service.rag.index_personal_documents.return_value = {
        "indexed": 5,
        "failed": 1,
        "errors": ["file too large"]
    }

    # Act
    res = await service.index("/dummy/dir")

    # Assert
    assert res.indexed == 5
    assert res.failed == 1
    assert res.errors == ["file too large"]
