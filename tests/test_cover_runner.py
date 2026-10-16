import io
import json
import os
import unittest
from unittest.mock import patch

import cover_runner


class RunnerTests(unittest.TestCase):
    def test_secret_and_worker_url_whitespace_match_existing_scanner_convention(self):
        with patch.dict(os.environ,{'WORKER_URL':' https://worker.test/\n','INGEST_SECRET':' secret\n'}):
            with patch('urllib.request.urlopen',return_value=io.BytesIO(b'{"ok":true,"job":null}')) as opened:
                self.assertIsNone(json.loads(cover_runner.api('/cover-jobs/claim',data=b'{}'))['job'])
                request=opened.call_args.args[0]
                self.assertEqual(request.full_url,'https://worker.test/cover-jobs/claim')
                self.assertEqual(request.get_header('Authorization'),'Bearer secret')
                self.assertEqual(request.get_header('User-agent'),'Mozilla/5.0')

    def test_api_refuses_plain_http(self):
        with patch.dict(os.environ,{'WORKER_URL':'http://worker.test','INGEST_SECRET':'secret'}):
            with self.assertRaises(ValueError):
                cover_runner.api('/cover-jobs/claim',data=b'{}')


if __name__ == '__main__':
    unittest.main()
