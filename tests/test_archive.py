"""
Tests for archive.py: chat parsing/classification, zip access, and recovery
of entries orphaned by a truncated central directory.

Run from the repo root:  python3 -m unittest discover tests -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from archive import ChatIndex, ZipHandle, get_chat  # noqa: E402
from make_fixtures import (  # noqa: E402
    PNG, NORMAL_CHAT, make_normal, make_trunc, make_zip64)


def index_for(text):
    return ChatIndex(text.replace("\r\n", "\n"), "Testy")


class TestChatIndex(unittest.TestCase):
    def setUp(self):
        self.ci = index_for(NORMAL_CHAT)

    def test_message_count_and_senders(self):
        self.assertEqual(len(self.ci), 13)
        self.assertEqual(set(self.ci.senders), {"Testy", "Alice", "Bob"})

    def test_day_first_dates(self):
        # 20/05/24 must parse as 20 May 2024 (day-first)
        import datetime
        d = datetime.datetime.fromtimestamp(self.ci.ts[0], datetime.timezone.utc)
        self.assertEqual((d.year, d.month, d.day), (2024, 5, 20))

    def test_kinds(self):
        kinds = [self.ci.message(i)["k"] for i in range(len(self.ci))]
        #        sys txt txt att att stk omit call del edit emoji url next-day
        self.assertEqual(kinds, [2, 0, 0, 1, 1, 1, 1, 3, 4, 0, 0, 0, 0])

    def test_multiline(self):
        self.assertIn("second line here", self.ci.message(2)["t"])

    def test_attachment_with_caption(self):
        m = self.ci.message(4)
        self.assertEqual(m["a"], "00000005-PHOTO-2024-05-20-10-03-00.jpg")
        self.assertEqual(m["t"], "Caption here")

    def test_omitted_media_with_caption(self):
        m = self.ci.message(6)
        self.assertEqual(m["mt"], "image omitted")
        self.assertEqual(m["t"], "Check this")
        self.assertNotIn("a", m)

    def test_edited_flag(self):
        m = self.ci.message(9)
        self.assertEqual(m.get("e"), 1)
        self.assertEqual(m["t"], "Edited msg")

    def test_day_index(self):
        self.assertEqual(len(self.ci.days), 2)      # 20 May + 21 May
        self.assertEqual(self.ci.days[1][1], 12)    # next-day msg index

    def test_search(self):
        results, truncated = self.ci.search("hello")
        self.assertFalse(truncated)
        self.assertEqual([r["i"] for r in results], [1])


class TestZips(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.normal = make_normal(d)
        cls.trunc = make_trunc(d)
        cls.zip64 = make_zip64(d)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_normal_zip_no_salvage(self):
        zh = ZipHandle(self.normal)
        self.assertEqual(zh.salvaged, 0)
        self.assertEqual(len(zh.infos), 4)
        self.assertEqual(zh.read_entry("00000004-PHOTO-2024-05-20-10-02-00.jpg"), PNG)

    def test_truncated_zip_recovers_orphans(self):
        zh = ZipHandle(self.trunc)
        # central directory only lists 1 of 3; the other two are salvaged,
        # one of them via a data descriptor (sizes written after the data)
        self.assertEqual(zh.salvaged, 2)
        self.assertEqual(len(zh.infos), 3)
        self.assertEqual(zh.read_entry("00000002-PHOTO-2024-05-20-10-01-00.jpg"), PNG)
        text = zh.read_entry("_chat.txt").decode()
        self.assertIn("photo B", text)

    def test_truncated_zip_chat_parses(self):
        archive = {"id": "t1", "chat": "Trunc", "_path": self.trunc}
        ci = get_chat(archive)
        self.assertEqual(len(ci), 3)
        self.assertEqual(ci.message(1)["a"], "00000002-PHOTO-2024-05-20-10-01-00.jpg")

    def test_zip64_zip(self):
        zh = ZipHandle(self.zip64)
        self.assertEqual(zh.salvaged, 0)
        self.assertIn("_chat.txt", zh.infos)
        self.assertEqual(zh.read_entry("00000001-PHOTO-2024-05-20-10-00-00.jpg"), PNG)


if __name__ == "__main__":
    unittest.main()
