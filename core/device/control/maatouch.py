import re
import threading
import time

from adbutils import adb

# reference : [ https://github.com/MaaAssistantArknights/MaaTouch ]
# reference : [ https://github.com/LmeSzinc/StarRailCopilot/blob/master/module/device/method/maatouch.py ]
MAATOUCH_FILEPATH_LOCAL = './src/maatouch_bin/maatouch'
MAATOUCH_FILEPATH_REMOTE = '/data/local/tmp/maatouch'
MAATOUCH_START_COMMAND = 'CLASSPATH=/data/local/tmp/maatouch app_process / com.shxyke.MaaTouch.App'

TOUCH_PRESSURE = 5


class MaaTouchNotInstalledError(Exception):
    pass


class MaaTouchControl:
    """
    Control method that implements the same as scrcpy and has an interface
    similar to minitouch. Communicates over the adb shell stream socket
    directly, no port forward needed.
    """

    def __init__(self, conn):
        self.serial = conn.serial
        self.logger = conn.logger
        self.adb = adb.device(self.serial)
        self._stream = None  # AdbConnection from `adb shell`, keep it alive
        self._sock = None  # underlying socket to maatouch server
        self._file = None
        self.max_x = 1280
        self.max_y = 720
        self._screen_size = None
        self._lock = threading.Lock()
        self._init_server()

    # ---------- server lifecycle ----------

    def _close_stream(self):
        if self._stream is not None:
            try:
                self._stream.close()
            except Exception:
                pass
        self._stream = None
        self._sock = None
        self._file = None

    def _install(self):
        self.logger.info('MaaTouch install: push ' + MAATOUCH_FILEPATH_LOCAL)
        self.adb.push(MAATOUCH_FILEPATH_LOCAL, MAATOUCH_FILEPATH_REMOTE)

    def _get_screen_size(self):
        try:
            res = self.adb.shell('wm size')
            override = re.search(r'Override size: (\d+)x(\d+)', res)
            physical = re.search(r'Physical size: (\d+)x(\d+)', res)
            match = override or physical
            if match:
                return int(match.group(1)), int(match.group(2))
        except Exception as e:
            self.logger.warning(f'Get screen size failed: {e}')
        return None

    def _start_and_handshake(self):
        # CLASSPATH=/data/local/tmp/maatouch app_process / com.shxyke.MaaTouch.App
        stream = self.adb.shell(MAATOUCH_START_COMMAND, stream=True)
        self._stream = stream
        sock = stream.conn
        sock.settimeout(10)
        self._sock = sock
        self._file = sock.makefile('r')

        deadline = time.time() + 5
        max_contacts, max_x, max_y, max_pressure = 2, 1280, 720, 50
        while True:
            out = self._file.readline().replace('\n', '').replace('\r', '')
            if out.strip() == 'Aborted':
                raise MaaTouchNotInstalledError(
                    'Received "Aborted" from MaaTouch, probably because MaaTouch is not installed')
            try:
                _, max_contacts, max_x, max_y, max_pressure = out.split(' ')
                break
            except ValueError:
                if time.time() > deadline:
                    raise MaaTouchNotInstalledError(
                        'Received empty data from MaaTouch, probably because MaaTouch is not installed')
                # maatouch may not start that fast
                time.sleep(1)
                continue

        self.max_x = int(max_x)
        self.max_y = int(max_y)
        # $ <pid>
        self._file.readline()
        self.logger.info(
            f'MaaTouch stream connected, max_contact: {max_contacts}; '
            f'max_x: {self.max_x}; max_y: {self.max_y}; max_pressure: {max_pressure}')

    def _init_server(self):
        self._close_stream()
        try:
            self._start_and_handshake()
        except MaaTouchNotInstalledError:
            self._install()
            self._close_stream()
            self._start_and_handshake()
        self._screen_size = self._get_screen_size()
        if self._screen_size:
            self.logger.info(f'Device screen size: {self._screen_size}')

    # ---------- protocol ----------

    def _convert(self, x, y):
        # BAAS input coords are in real screen pixels, convert to
        # maatouch touch panel space reported by the handshake
        if self._screen_size is not None:
            width, height = self._screen_size
            if width > 0 and height > 0 and (width != self.max_x or height != self.max_y):
                x = int(x / width * self.max_x)
                y = int(y / height * self.max_y)
        return int(x), int(y)

    def _send(self, content, duration=0):
        with self._lock:
            if self._sock is None:
                self._init_server()
            try:
                self._sock.sendall(content.encode('utf-8'))
                self._sock.recv(0)  # wait for flush
            except (OSError, ValueError) as e:
                self.logger.warning(f'MaaTouch connection lost ({e}), re-initializing')
                self._init_server()
                self._sock.sendall(content.encode('utf-8'))
                self._sock.recv(0)
            # recv(0) does not acknowledge completion of the device-side waits.
            # Keep the lock until the gesture finishes before accepting another.
            time.sleep(duration + 0.05)

    # ---------- public interface ----------

    def click(self, x, y):
        x, y = self._convert(x, y)
        self._send(f'd 0 {x} {y} {TOUCH_PRESSURE}\nc\nu 0\nc\n')

    def long_click(self, x, y, duration):
        x, y = self._convert(x, y)
        duration = max(0, int(duration * 1000))
        self._send(f'd 0 {x} {y} {TOUCH_PRESSURE}\nc\nw {duration}\nu 0\nc\n', duration / 1000)

    def swipe(self, x1, y1, x2, y2, duration):
        duration = max(duration, 0.1)
        x1, y1 = self._convert(x1, y1)
        x2, y2 = self._convert(x2, y2)
        # one frame per 10ms, ease in-out so starts and ends are slower
        steps = max(int(duration / 0.01), 2)
        frames = [f'd 0 {x1} {y1} {TOUCH_PRESSURE}\nc\nw 10\n']
        for i in range(1, steps + 1):
            t = i / steps
            t = t * t * (3 - 2 * t)
            xi = int(x1 + (x2 - x1) * t)
            yi = int(y1 + (y2 - y1) * t)
            frames.append(f'm 0 {xi} {yi} {TOUCH_PRESSURE}\nc\nw 10\n')
        frames.append('u 0\nc\n')
        self._send(''.join(frames), (steps + 1) * 0.01)
