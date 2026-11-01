import json
import pathlib
import sqlite3
import tempfile
import unittest
from inventory import inventory, write_catalog


class InventoryTests(unittest.TestCase):
    def test_original_metadata_stays_unchanged_and_titles_cannot_inject_html(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('create table threads(id,title,name,archived,is_pinned,originator,source,thread_source,updated_at)')
            title = '</script><img src=x onerror=alert(1)>'
            db.execute('insert into threads values(?,?,?,?,?,?,?,?,?)', ('original', 'raw prompt', title, 0, 1, 'Codex Desktop', 'vscode', 'user', 1))
            db.commit()
            db.close()
            before = path.read_bytes()
            result = inventory(path, root)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(result['conversations'][0]['title'], title)
            self.assertEqual(result['conversations'][0]['runtimeStatus'], 'unknown')
            output = root / 'catalog.html'
            write_catalog(result, output)
            self.assertNotIn(title, output.read_text())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
