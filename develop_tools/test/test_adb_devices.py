"""Offline regressions for generic Android device discovery and connections."""

from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from core.device import adb_devices
from core.device.connection import Connection
from core.exception import RequestHumanTakeOver
from server.app import _autosearch_adb, _connect_adb


def device(serial, state='device'):
    return SimpleNamespace(serial=serial, state=state)


class AdbDeviceTests(unittest.TestCase):
    def test_discovery_lists_remote_and_usb_devices_without_emulator_processes(self):
        devices = [device('10.0.0.11:5555'), device('R58M123456'),
                   device('offline-device', 'offline'), device('pending', 'unauthorized'),
                   device('10.0.0.11:5555')]
        with patch.object(adb_devices.adb, 'list', return_value=devices):
            self.assertEqual(_autosearch_adb(), ['10.0.0.11:5555', 'R58M123456'])

    def test_manual_remote_address_is_connected_before_checking_device_state(self):
        with patch.object(adb_devices.adb, 'connect') as connect, \
                patch.object(adb_devices.adb, 'list', return_value=[device('10.0.0.11:5555')]):
            result = _connect_adb({'host': '10.0.0.11', 'port': '5555'})
        connect.assert_called_once_with('10.0.0.11:5555', timeout=5)
        self.assertEqual(result, {'serial': '10.0.0.11:5555', 'state': 'device'})

    def test_failed_connection_is_not_reported_as_connected(self):
        with patch.object(adb_devices.adb, 'connect', return_value='failed to connect'), \
                patch.object(adb_devices.adb, 'list', return_value=[]), \
                self.assertRaisesRegex(RuntimeError, '无法连接设备'):
            _connect_adb({'host': '10.0.0.11', 'port': 5555})

    def test_unauthorized_device_reports_authorization_required(self):
        with patch.object(adb_devices.adb, 'connect'), \
                patch.object(adb_devices.adb, 'list', return_value=[device('10.0.0.11:5555', 'unauthorized')]), \
                self.assertRaisesRegex(RuntimeError, '尚未授权'):
            _connect_adb({'host': '10.0.0.11', 'port': 5555})

    def test_usb_serial_is_used_without_network_connect(self):
        with patch.object(adb_devices.adb, 'connect') as connect, \
                patch.object(adb_devices.adb, 'list', return_value=[device('R58M123456')]):
            self.assertEqual(_connect_adb({'host': 'R58M123456'})['serial'], 'R58M123456')
        connect.assert_not_called()

    def test_ipv6_address_and_invalid_ports(self):
        with patch.object(adb_devices.adb, 'connect') as connect, \
                patch.object(adb_devices.adb, 'list', return_value=[device('[::1]:5555')]):
            _connect_adb({'host': '::1', 'port': '5555'})
        connect.assert_called_once_with('[::1]:5555', timeout=5)
        for port in ('0', '65536', 'not-a-port'):
            with self.subTest(port=port), self.assertRaises(ValueError):
                _connect_adb({'host': '10.0.0.11', 'port': port})

    def connection(self, host='10.0.0.11', port='5555'):
        connection = Connection.__new__(Connection)
        connection.logger = Mock()
        connection.config_set = Mock()
        connection.adbIP, connection.adbPort = host, port
        connection.serial = adb_devices.device_serial(host, port) if host != 'auto' else 'auto'
        return connection

    def test_remote_ports_do_not_trigger_local_emulator_detection_or_switch(self):
        for port in ('7555', '16384'):
            with self.subTest(port=port):
                connection = self.connection(port=port)
                connection.adb_getprop = Mock()
                connection.list_devices = Mock(return_value=[device('127.0.0.1:16385')])
                connection.detect_device()
                connection.check_mumu_keep_alive()
                self.assertEqual(connection.serial, f'10.0.0.11:{port}')
                connection.config_set.set.assert_not_called()
                connection.adb_getprop.assert_not_called()

    def test_auto_select_preserves_usb_serial_and_handles_empty_device_list(self):
        connection = self.connection('auto', '')
        connection.list_devices = Mock(return_value=[device('R58M123456')])
        connection.detect_device()
        self.assertEqual(connection.serial, 'R58M123456')
        self.assertEqual(connection.adbPort, '')
        connection = self.connection('auto', '')
        connection.list_devices = Mock(return_value=[])
        with self.assertRaises(RequestHumanTakeOver):
            connection.detect_device()

    def test_task_connection_failure_stops_initialization(self):
        connection = self.connection()
        with patch('core.device.connection.connect_device', side_effect=RuntimeError('offline')), \
                self.assertRaises(RequestHumanTakeOver):
            connection.adb_connect()


if __name__ == '__main__':
    unittest.main()
