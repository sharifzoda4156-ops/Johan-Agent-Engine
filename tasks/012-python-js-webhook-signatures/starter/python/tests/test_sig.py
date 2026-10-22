import unittest

from webhooks import VerifyError, sign, verify


class SigTest(unittest.TestCase):
    def test_roundtrip(self):
        body, header = sign({"event": "paid", "id": 7}, "s3cret", timestamp=1_700_000_000)
        self.assertEqual(verify(body, header, "s3cret", now=1_700_000_010), {"event": "paid", "id": 7})

    def test_tampered(self):
        body, header = sign({"amount": 100}, "s3cret", timestamp=1_700_000_000)
        with self.assertRaises(VerifyError) as ctx:
            verify(body.replace(b"100", b"999"), header, "s3cret", now=1_700_000_000)
        self.assertEqual(ctx.exception.code, "BAD_SIGNATURE")

    def test_old(self):
        body, header = sign({}, "s3cret", timestamp=1_700_000_000)
        with self.assertRaises(VerifyError) as ctx:
            verify(body, header, "s3cret", now=1_700_001_000)
        self.assertEqual(ctx.exception.code, "STALE")


if __name__ == "__main__":
    unittest.main()
