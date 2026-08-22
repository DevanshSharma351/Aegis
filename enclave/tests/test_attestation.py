import pytest
import os
import json
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from main import app
from attestation import compute_decision_hash, SAMPLE_DECISION, SAMPLE_DECISION_REORDERED

client = TestClient(app)

# ---------------------------------------------------------------------------
# Decision hash tests
# ---------------------------------------------------------------------------

class TestComputeDecisionHash:
    def test_hash_is_32_bytes(self):
        h = compute_decision_hash(SAMPLE_DECISION)
        assert isinstance(h, bytes)
        assert len(h) == 32

    def test_hash_is_deterministic(self):
        h1 = compute_decision_hash(SAMPLE_DECISION)
        h2 = compute_decision_hash(SAMPLE_DECISION)
        assert h1 == h2

    def test_hash_is_order_independent(self):
        """sorted_keys=True in JSON serialization → order doesn't matter."""
        h1 = compute_decision_hash(SAMPLE_DECISION)
        h2 = compute_decision_hash(SAMPLE_DECISION_REORDERED)
        assert h1 == h2

# ---------------------------------------------------------------------------
# FastAPI Route Tests (E2E Mocked)
# ---------------------------------------------------------------------------

class TestRebalanceAPI:
    @patch('main.fetch_all_assets')
    @patch('main.compute_all_signals')
    @patch('main.query_slm')
    @patch('attestation.TappdClient')
    def test_rebalance_success(self, mock_tappd_class, mock_query, mock_signals, mock_fetch):
        # Setup mocks
        mock_fetch.return_value = {"mock": "data"}
        mock_signals.return_value = {"signal": "bullish"}
        mock_query.return_value = SAMPLE_DECISION

        # Mock the dstack TappdClient
        mock_client_instance = MagicMock()
        mock_client_instance.tdx_quote.return_value = MagicMock(
            quote="mocked_quote_hex",
            replay_rps=MagicMock(return_value="mocked_event_log")
        )
        mock_tappd_class.return_value = mock_client_instance

        # Execute
        response = client.post("/rebalance")

        # Assert
        assert response.status_code == 200
        data = response.json()
        assert data["allocation"] == SAMPLE_DECISION["allocations"]
        assert data["rationale"] == SAMPLE_DECISION["rationale"]
        assert data["attestation"]["quote"] == "mocked_quote_hex"
        assert "report_data_hash" in data["attestation"]

    @patch('main.fetch_all_assets')
    def test_rebalance_failure_500(self, mock_fetch):
        # Simulate an unexpected error
        mock_fetch.side_effect = Exception("Internal explosion")
        
        response = client.post("/rebalance")
        
        assert response.status_code == 500
        assert "Internal explosion" in response.json()["detail"]

    @patch('main.fetch_all_assets')
    @patch('main.compute_all_signals')
    @patch('main.query_slm')
    def test_rebalance_failure_422(self, mock_query, mock_signals, mock_fetch):
        # Simulate SLM validation exhaustion
        mock_fetch.return_value = {}
        mock_signals.return_value = {}
        mock_query.side_effect = ValueError("Failed to get valid JSON from SLM")
        
        response = client.post("/rebalance")
        
        assert response.status_code == 422
        assert "SLM or validation error" in response.json()["detail"]
