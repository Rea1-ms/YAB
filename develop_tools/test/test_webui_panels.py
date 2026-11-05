"""Offline regressions for student selectors in the WebUI panels."""

from copy import deepcopy
import json
from types import SimpleNamespace
import unittest

from core.config.default_config import STATIC_DEFAULT_CONFIG
from core.config.generated_static_config import StaticConfig
from server.panels import resolve_schema


class StudentOptionsTests(unittest.TestCase):
    def test_default_student_options_are_unique_in_each_server_language(self):
        static = StaticConfig(**json.loads(STATIC_DEFAULT_CONFIG))
        original = deepcopy(static.student_names)
        for server, name_key in (('CN', 'CN_name'), ('Global', 'Global_name'),
                                 ('JP', 'JP_name')):
            with self.subTest(server=server):
                config = SimpleNamespace(server_mode=server, static_config=static)
                fields = [field for panel in resolve_schema(config)
                          for group in panel['groups'] for field in group['fields']
                          if field['type'] == 'student_text']
                self.assertEqual({field['key'] for field in fields},
                                 {'favorStudent1', 'favorStudent2', 'lesson_favorStudent'})
                names = [student[name_key] for student in original]
                for field in fields:
                    with self.subTest(field=field['key']):
                        options = field['options']
                        self.assertEqual(len(options), len(set(options)))
                        self.assertEqual(set(options), set(names))
                        positions = [names.index(name) for name in options]
                        self.assertEqual(positions, sorted(positions))
        self.assertEqual(static.student_names, original)

    def test_nonadjacent_duplicate_records_do_not_duplicate_options(self):
        static = StaticConfig(**json.loads(STATIC_DEFAULT_CONFIG))
        static.student_names.extend(deepcopy(static.student_names[:2]))
        original = deepcopy(static.student_names)
        config = SimpleNamespace(server_mode='CN', static_config=static)
        for panel in resolve_schema(config):
            for group in panel['groups']:
                for field in group['fields']:
                    if field['type'] == 'student_text':
                        with self.subTest(field=field['key']):
                            for student in original[:2]:
                                self.assertEqual(field['options'].count(student['CN_name']), 1)
        self.assertEqual(static.student_names, original)


if __name__ == '__main__':
    unittest.main()
