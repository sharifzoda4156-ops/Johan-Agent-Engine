import unittest

from notes_app import repo
from notes_app.db import connect, init_db


class RepoTest(unittest.TestCase):
    def setUp(self):
        self.conn = connect(":memory:")
        init_db(self.conn)
        repo.add_user(self.conn, "ann@example.com", "Ann")

    def test_add_and_list(self):
        repo.add_note(self.conn, "ann@example.com", "hello", ["work", "todo"])
        repo.add_note(self.conn, "ann@example.com", "bye")
        notes = repo.list_notes(self.conn, "ann@example.com")
        self.assertEqual([n["body"] for n in notes], ["hello", "bye"])
        self.assertEqual(notes[0]["tags"], ["work", "todo"])

    def test_filter_by_tag(self):
        repo.add_note(self.conn, "ann@example.com", "a", ["work"])
        repo.add_note(self.conn, "ann@example.com", "b", ["home"])
        self.assertEqual([n["body"] for n in repo.list_notes(self.conn, "ann@example.com", tag="work")], ["a"])

    def test_unknown_user(self):
        with self.assertRaises(LookupError):
            repo.add_note(self.conn, "nobody@example.com", "x")
        self.assertEqual(repo.list_notes(self.conn, "nobody@example.com"), [])

    def test_delete_user(self):
        self.assertTrue(repo.delete_user(self.conn, "ann@example.com"))
        self.assertFalse(repo.delete_user(self.conn, "ann@example.com"))


if __name__ == "__main__":
    unittest.main()
