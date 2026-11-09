"""Fork identity remains separate from launcher and upstream revisions."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from core import distribution
from server.app import register_topics
from server.hub import Hub
from server.service import BaasService, get_version


class VersionInfoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        source = distribution.ROOT
        output = source / 'develop_tools/out'
        output.mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix='version-info-', dir=output))
        self.package = scratch / 'app'
        self.package.mkdir()
        (self.package / 'pyproject.toml').write_text(
            '[project]\nversion = "0.0.1"\n'
            '[tool.yab.upstream]\n'
            'repository = "https://github.com/pur1fying/blue_archive_auto_script"\n'
            'version = "1.4.3"\n'
            'commit = "223000d10f3dff73f980cba04ec73fe9755fc75a"\n', encoding='utf-8',
        )
        working = scratch / 'working'
        working.mkdir()
        (working / 'setup.toml').write_text(
            '[General]\ncurrent_BAAS_version = "legacy-launcher-sha"\n', encoding='utf-8',
        )
        previous = Path.cwd()
        os.chdir(working)
        self.addCleanup(os.chdir, previous)
        root_patch = patch.object(distribution, 'ROOT', self.package)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def test_source_version_ignores_legacy_launcher_and_working_directory(self):
        self.assertEqual(get_version(), '0.0.1')
        self.assertFalse((self.package / '.git').exists())

    def test_bundle_version_does_not_change_the_recorded_upstream(self):
        service = BaasService(Mock())
        service._toml_config = Mock(return_value=None)
        source = service.update_get({})
        (self.package / 'distribution.json').write_text('{"version":"0.0.2"}', encoding='utf-8')
        bundled = service.update_get({})
        self.assertEqual(bundled['current_version'], '0.0.2')
        self.assertEqual(bundled['upstream'], source['upstream'])
        self.assertEqual(bundled['upstream']['version'], '1.4.3')
        self.assertEqual(bundled['upstream']['commit'], '223000d10f3dff73f980cba04ec73fe9755fc75a')

    def test_launcher_update_settings_keep_the_fork_identity(self):
        service = BaasService(Mock())
        service._toml_config = Mock(return_value=SimpleNamespace(get=lambda _key, default: default))
        info = service.update_get({})
        self.assertTrue(info['has_setup_toml'])
        self.assertEqual(info['current_version'], '0.0.1')
        self.assertEqual(info['upstream']['version'], '1.4.3')

    async def test_update_rpc_sends_upstream_metadata_without_git(self):
        hub = Hub()
        service = BaasService(hub)
        service._toml_config = Mock(return_value=None)
        register_topics(hub, service)
        messages = []

        async def send_text(message):
            messages.append(json.loads(message))

        await hub.handle(SimpleNamespace(send_text=send_text),
                         {'t': 'Meta', 'o': 'rpc', 'f': 'update_get', 'v': {}, 'i': 7})
        self.assertEqual(len(messages), 1)
        reply = messages[0]
        self.assertEqual(reply['i'], 7)
        self.assertIsNone(reply['e'])
        self.assertEqual(reply['r']['current_version'], '0.0.1')
        self.assertEqual(reply['r']['upstream'], distribution.project_metadata()['tool']['yab']['upstream'])


if __name__ == '__main__':
    unittest.main()
