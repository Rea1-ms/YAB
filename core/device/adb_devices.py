"""Discover and connect Android devices without requiring an emulator process."""

from adbutils import adb


def split_serial(serial):
    host, separator, port = serial.rpartition(':')
    if separator and port.isdecimal():
        return host.removeprefix('[').removesuffix(']'), port
    return serial, ''


def device_serial(host, port=''):
    host = str(host or '').strip()
    port = str(port if port is not None else '').strip()
    if not host or not port:
        serial = host or port
        if not serial or serial == 'auto':
            raise ValueError('请填写设备地址和端口，或已连接设备的序列号')
        return serial
    if not port.isdecimal() or not 0 < int(port) < 65536:
        raise ValueError('设备端口需要是 1 到 65535 的整数')
    host = host.removeprefix('[').removesuffix(']')
    return f'[{host}]:{port}' if ':' in host else f'{host}:{port}'


def connected_devices():
    return list(dict.fromkeys(device.serial for device in adb.list() if device.state == 'device'))


def connect_device(host, port=''):
    serial = device_serial(host, port)
    _, network_port = split_serial(serial)
    if network_port:
        message = adb.connect(serial, timeout=5)
    else:
        message = ''
    states = {device.serial: device.state for device in adb.list()}
    state = states.get(serial)
    if state != 'device':
        if state == 'unauthorized':
            raise RuntimeError('设备尚未授权，请在设备端允许安卓调试连接')
        detail = message or state or '未找到设备'
        raise RuntimeError(f'无法连接设备 {serial}：{detail}')
    return {'serial': serial, 'state': state}
