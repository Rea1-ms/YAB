"""Verify lightweight bundle contents and dependency reuse without downloading."""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('desktop_bundle', Path(__file__).parents[1] / 'bundle.py')
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


class LightweightBundleTest(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).parents[2] / 'develop_tools/out'
        output.mkdir(parents=True, exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(prefix='bundle-test-', dir=output))
        self.root = self.scratch / 'source'
        for directory in ('desktop', 'core', 'module', 'server', 'src', 'assets', 'webapp/dist',
                          'core/ocr/baas_ocr_client/bin/resource'):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        for file in ('main.py', 'webui.py', 'pyproject.toml', 'uv.lock', 'LICENSE', 'README.md',
                     'server/__main__.py', 'webapp/dist/index.html',
                     'core/ocr/baas_ocr_client/bin/BAAS_ocr_server.exe',
                     'core/ocr/baas_ocr_client/bin/resource/model.onnx'):
            (self.root / file).write_text(file, encoding='utf-8')
        (self.root / 'desktop/package.json').write_text('{"version":"0.0.1"}', encoding='utf-8')
        (self.root / 'desktop/python-version').write_text('3.11.14', encoding='utf-8')
        self.uv = self.scratch / 'uv.exe'
        self.uv.write_bytes(b'test uv')
        self.requirements = 'example==1.0 --hash=sha256:' + 'a' * 64 + '\n'

    def build(self, name, system=False):
        def export(args, **_kwargs):
            self.assertEqual(args[1], 'export')
            self.assertIn('--locked', args)
            self.assertIn('--no-emit-project', args)
            Path(args[args.index('-o') + 1]).write_text(self.requirements, encoding='utf-8')

        destination = self.scratch / name
        with patch.object(BUNDLE, 'ROOT', self.root), patch.object(BUNDLE, 'run', side_effect=export), \
                patch.dict(os.environ, {}, clear=False):
            BUNDLE.build_bundle(destination, self.scratch / 'cache', self.uv, 'online', system)
        return destination, json.loads((destination / 'bundle.json').read_text(encoding='utf-8'))

    def test_lightweight_contents_and_system_tool_variant(self):
        first, bundled = self.build('bundled')
        second, system = self.build('system', system=True)
        self.assertEqual(bundled['format'], 3)
        self.assertEqual(bundled['mode'], 'online')
        self.assertEqual(bundled['uv'], 'bundled')
        self.assertEqual(system['uv'], 'system')
        self.assertIn('toolkit/uv.exe', bundled['files'])
        self.assertNotIn('toolkit/uv.exe', system['files'])
        self.assertEqual(bundled['runtimeKey'], system['runtimeKey'])
        self.assertNotEqual(bundled['id'], system['id'])
        for directory, manifest in ((first, bundled), (second, system)):
            self.assertFalse((directory / 'toolkit/python').exists())
            self.assertFalse((directory / 'wheels').exists())
            self.assertIn('app/core/ocr/baas_ocr_client/bin/resource/model.onnx', manifest['files'])
            self.assertIn('build-constraints.txt', manifest['files'])
            for name, digest in manifest['files'].items():
                self.assertEqual(BUNDLE.sha256(directory / name), digest)

    def test_only_dependency_or_interpreter_changes_invalidate_runtime(self):
        _, first = self.build('first')
        (self.root / 'desktop/package.json').write_text('{"version":"0.0.2"}', encoding='utf-8')
        (self.root / 'uv.lock').write_text('root version changed', encoding='utf-8')
        _, version = self.build('version')
        self.assertEqual(first['runtimeKey'], version['runtimeKey'])
        self.assertNotEqual(first['id'], version['id'])
        self.requirements = self.requirements.replace('==1.0', '==2.0')
        _, dependencies = self.build('dependencies')
        self.assertNotEqual(version['runtimeKey'], dependencies['runtimeKey'])
        (self.root / 'desktop/python-version').write_text('3.11.15', encoding='utf-8')
        _, interpreter = self.build('interpreter')
        self.assertNotEqual(dependencies['runtimeKey'], interpreter['runtimeKey'])


if __name__ == '__main__':
    unittest.main()
