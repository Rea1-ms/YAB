import ipaddress
import random
import socket
import time

import cv2
import numpy as np
from adbutils import adb
from adbutils.errors import AdbError, AdbTimeout

# reference : [ https://github.com/LmeSzinc/StarRailCopilot/blob/master/module/device/method/adb.py ]
# and [ https://github.com/LmeSzinc/StarRailCopilot/blob/master/module/device/connection.py ]
REVERSE_SERVER_PORT = 7903
FORWARD_PORT_RANGE = (20000, 21000)
ACCEPT_TIMEOUT = 5
CHUNK_SIZE = 262144


class ImageTruncated(Exception):
    pass


class AdbNcScreenshot:
    """
    Screenshot by `screencap | nc <host> <port>`: this side listens on a TCP
    server, the android side pipes raw screencap output back through netcat.
    Faster than plain `adb exec-out screencap` because data travels on an
    independent TCP connection instead of the adb pipe.
    Requires a netcat binary on the device (`nc` or `busybox nc`).
    """

    def __init__(self, conn):
        self.serial = conn.serial
        self.logger = conn.logger
        self.adb = adb.device(self.serial)
        self._server = None
        self._listen_host = None
        self._listen_port = None
        self._connect_host = None
        self._connect_port = None
        self._nc_command = None

    # ---------- server setup ----------

    @staticmethod
    def _is_port_using(host, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, port))
            return False
        except OSError:
            return True
        finally:
            s.close()

    def _random_port(self, host):
        for _ in range(50):
            port = random.randint(*FORWARD_PORT_RANGE)
            if not self._is_port_using(host, port):
                return port
        raise AdbError('No available port for adb_nc screenshot')

    def _is_localhost(self):
        ip = self.serial.split(':')[0]
        try:
            return ipaddress.ip_address(ip).is_loopback
        except ValueError:
            # `emulator-5554` style serials are local emulators too
            return self.serial.startswith('emulator-')

    def _get_lan_host(self):
        try:
            host = socket.gethostbyname(socket.gethostname())
            if not ipaddress.ip_address(host).is_loopback:
                return host
        except (socket.gaierror, ValueError):
            pass
        # fall back: enumerate local addresses
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                host = info[4][0]
                if not ipaddress.ip_address(host).is_loopback:
                    return host
        except socket.gaierror:
            pass
        return None

    def _init_server(self):
        self._close_server()
        use_reverse = True
        if self._is_localhost():
            host = self._get_lan_host()
            if host is not None:
                try:
                    port = self._random_port(host)
                    use_reverse = False
                except AdbError:
                    use_reverse = True
        if use_reverse:
            # let the device connect 127.0.0.1:{REVERSE_SERVER_PORT},
            # adb forwards it back to our listening port
            host = '127.0.0.1'
            port = self._random_port(host)
            self.adb.reverse(f'tcp:{REVERSE_SERVER_PORT}', f'tcp:{port}')
            self._connect_host, self._connect_port = '127.0.0.1', REVERSE_SERVER_PORT
        else:
            self._connect_host, self._connect_port = host, port
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind((host, port))
        server.settimeout(ACCEPT_TIMEOUT)
        server.listen(5)
        self._server = server
        self._listen_host, self._listen_port = host, port
        self.logger.info(
            f'adb_nc server listening on {host}:{port}, '
            f'device sends data to {self._connect_host}:{self._connect_port}')

    def _close_server(self):
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
        self._server = None

    def _reset(self):
        self._close_server()
        self._nc_command = None

    # ---------- device side ----------

    def _get_nc_command(self):
        if self._nc_command is not None:
            return self._nc_command
        trial = [['busybox', 'nc'], ['nc']]
        try:
            sdk = int(self.adb.shell('getprop ro.build.version.sdk').strip())
            if sdk >= 28:
                # LD Player 9 does not have `nc`, try `busybox nc`
                # BlueStacks Pie (Android 9) has `nc` but cannot send data
                trial = [['busybox', 'nc'], ['nc']]
            else:
                trial = [['nc'], ['busybox', 'nc']]
        except (AdbError, ValueError):
            pass
        for command in trial:
            result = self.adb.shell(' '.join(command))
            # `/system/bin/sh: nc: not found`
            if 'not found' in result:
                continue
            # `/system/bin/sh: busybox: inaccessible or not found`
            if 'inaccessible' in result:
                continue
            self._nc_command = ' '.join(command)
            self.logger.info(f'nc command: {self._nc_command}')
            return self._nc_command
        raise AdbError(
            'No `netcat` command available on device, '
            'please use screenshot methods without `_nc` suffix')

    def _adb_shell_nc(self, cmd, timeout=ACCEPT_TIMEOUT):
        if self._server is None:
            self._init_server()
        server = self._server
        server.settimeout(timeout)
        nc = self._get_nc_command()
        # screencap | nc <host> <port>, sent as a single string so the pipe
        # is not quoted by adbutils' list2cmdline
        command = f'{cmd} | {nc} {self._connect_host} {self._connect_port}'
        stream = self.adb.shell(command, stream=True)
        try:
            conn, _ = server.accept()
        except socket.timeout:
            raise AdbTimeout('adb_nc reverse server accept timeout')
        try:
            return self._recv_all(conn)
        finally:
            conn.close()
            try:
                stream.close()
            except OSError:
                pass

    @staticmethod
    def _recv_all(conn, chunk_size=CHUNK_SIZE):
        chunks = []
        conn.settimeout(ACCEPT_TIMEOUT)
        while True:
            try:
                chunk = conn.recv(chunk_size)
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
            time.sleep(0.001)
        return b''.join(chunks)

    # ---------- screenshot ----------

    @staticmethod
    def _load_screencap(data):
        if len(data) < 16:
            raise ImageTruncated('Empty image after reading from buffer')
        header = np.frombuffer(data[0:12], dtype='<u4')
        channel = 4  # screencap sends a RGBA image
        width, height, _ = header
        if not (0 < width <= 8192 and 0 < height <= 8192):
            raise ImageTruncated(f'Invalid screencap header: {tuple(header)}')
        image = np.frombuffer(data, dtype=np.uint8)
        try:
            image = image[-int(width * height * channel):].reshape(height, width, channel)
        except ValueError as e:
            raise ImageTruncated(str(e))
        image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
        if image is None:
            raise ImageTruncated('Empty image after cv2.cvtColor')
        return image

    def screenshot(self):
        for attempt in range(2):
            try:
                data = self._adb_shell_nc('screencap')
                if len(data) < 500:
                    self.logger.warning(f'Unexpected screenshot: {data}')
                return self._load_screencap(data)
            except ImageTruncated as e:
                self.logger.warning(f'adb_nc screenshot truncated: {e}, retrying')
            except (AdbError, OSError) as e:
                self.logger.warning(f'adb_nc screenshot failed: {e}, resetting server')
                self._reset()
        raise AdbError('adb_nc screenshot failed after retries')
