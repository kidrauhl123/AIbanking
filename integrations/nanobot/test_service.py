import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from service import CHILD_ENV, authorized, validate_job


class HostedBoundaryTests(unittest.TestCase):
    def test_internal_auth_fail_closed(self):
        with patch.dict(os.environ, {"NANOBOT_SERVICE_TOKEN": "x" * 40}):
            self.assertFalse(authorized(None))
            self.assertFalse(authorized("Bearer wrong"))
            self.assertTrue(authorized("Bearer " + "x" * 40))

    def test_paths_come_only_from_canonical_uuids(self):
        payload = {
            "runId": str(uuid4()),
            "ownerId": str(uuid4()),
            "conversationId": str(uuid4()),
            "bankToken": "bpt_test",
            "message": "hello",
        }
        self.assertEqual(validate_job(payload), payload)
        for key in ("runId", "ownerId", "conversationId"):
            with self.assertRaises(ValueError):
                validate_job({**payload, key: "../../another-user"})

    def test_model_process_has_no_callback_or_database_authority(self):
        self.assertNotIn("NANOBOT_SERVICE_TOKEN", CHILD_ENV)
        self.assertNotIn("DATABASE_URL", CHILD_ENV)
        self.assertNotIn("PASSWORD_PEPPER", CHILD_ENV)


if __name__ == "__main__":
    unittest.main()
