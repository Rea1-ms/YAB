import ctypes
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from threading import Lock

import cv2
import numpy as np


class NemuIpcIncompatible(Exception):
    pass


class NemuIpcError(Exception):
    pass


# reference : [ https://github.com/LmeSzinc/AzurLaneAutoScript/blob/master/module/device/method/nemu_ipc.py ]

class CaptureStd:
    """
    Capture stdout and stderr from both python and C library
    https://stackoverflow.com/questions/5081657/how-do-i-prevent-a-c-shared-library-to-print-on-stdout-in-python/17954769

    ```
    with CaptureStd() as capture:
        # String wasn't printed
        print('whatever')
    # But captured in ``capture.stdout``
    print(f'Got stdout: "{capture.stdout}"')
    print(f'Got stderr: "{capture.stderr}"')
    ```
    """

    def __init__(self):
        self.stdout = b''
        self.stderr = b''

    def _redirect_stdout(self, to):
        sys.stdout.close()
        os.dup2(to, self.fdout)
        sys.stdout = os.fdopen(self.fdout, 'w')

    def _redirect_stderr(self, to):
        sys.stderr.close()
        os.dup2(to, self.fderr)
        sys.stderr = os.fdopen(self.fderr, 'w')

    def __enter__(self):
        self.fdout = sys.stdout.fileno()
        self.fderr = sys.stderr.fileno()
        self.reader_out, self.writer_out = os.pipe()
        self.reader_err, self.writer_err = os.pipe()
        self.old_stdout = os.dup(self.fdout)
        self.old_stderr = os.dup(self.fderr)

        file_out = os.fdopen(self.writer_out, 'w')
        file_err = os.fdopen(self.writer_err, 'w')
        self._redirect_stdout(to=file_out.fileno())
        self._redirect_stderr(to=file_err.fileno())
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._redirect_stdout(to=self.old_stdout)
        self._redirect_stderr(to=self.old_stderr)
        os.close(self.old_stdout)
        os.close(self.old_stderr)

        self.stdout = self.recvall(self.reader_out)
        self.stderr = self.recvall(self.reader_err)
        os.close(self.reader_out)
        os.close(self.reader_err)

    @staticmethod
    def recvall(reader, length=1024) -> bytes:
        fragments = []
        while 1:
            chunk = os.read(reader, length)
            if chunk:
                fragments.append(chunk)
            else:
                break
        output = b''.join(fragments)
        return output


class CaptureNemuIpc(CaptureStd):
    instance = None

    def __init__(self, logger):
        super().__init__()
        self.logger = logger

    def is_capturing(self):
        """
        Only capture at the topmost wrapper to avoid nested capturing
        If a capture is ongoing, this instance does nothing
        """
        cls = self.__class__
        return isinstance(cls.instance, cls) and cls.instance != self

    def __enter__(self):
        if self.is_capturing():
            return self
        super().__enter__()
        CaptureNemuIpc.instance = self
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.is_capturing():
            return

        CaptureNemuIpc.instance = None
        super().__exit__(exc_type, exc_val, exc_tb)

        self.check_stdout()
        self.check_stderr()

    def check_stdout(self):
        if not self.stdout:
            return
        self.logger.info(f'NemuIpc stdout: {self.stdout}')

    def check_stderr(self):
        if not self.stderr:
            return
        self.logger.error(f'NemuIpc stderr: {self.stderr}')

        # Calling an old MuMu12 player
        # Tested on 3.4.0
        # b'nemu_capture_display rpc error: 1783\r\n'
        # Tested on 3.7.3
        # b'nemu_capture_display rpc error: 1745\r\n'
        if b'error: 1783' in self.stderr or b'error: 1745' in self.stderr:
            raise NemuIpcIncompatible(
                f'NemuIpc requires MuMu12 version >= 3.8.13, please check your version')
        # contact_id incorrect
        # b'nemu_capture_display cannot find rpc connection\r\n'
        if b'cannot find rpc connection' in self.stderr:
            raise NemuIpcError(self.stderr)
        # Emulator died
        # b'nemu_capture_display rpc error: 1722\r\n'
        # MuMuVMMSVC.exe died
        # b'nemu_capture_display rpc error: 1726\r\n'
        # No idea how to handle yet
        if b'error: 1722' in self.stderr or b'error: 1726' in self.stderr:
            raise NemuIpcError('Emulator instance is probably dead')


class NemuClient:
    connections = dict()

    @staticmethod
    def get_instance(nemu_folder, instance_id, logger):
        for (k, v) in NemuClient.connections.items():
            if v.nemu_folder == nemu_folder and v.instance_id == instance_id:
                return v
        key = nemu_folder + str(instance_id)
        NemuClient.connections[key] = NemuClient(nemu_folder, instance_id, logger)
        return NemuClient.connections[key]

    @staticmethod
    def release_instance(nemu_folder, instance_id):
        for (k, v) in NemuClient.connections.items():
            if v.nemu_folder == nemu_folder and v.instance_id == instance_id:
                v.disconnect()
                del NemuClient.connections[k]
                return

    def __init__(self, nemu_folder, instance_id, logger, display_id=0):
        self.lib = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='nemu-ipc')
        self._call_lock = Lock()
        self._pending_call = None
        self.nemu_folder = nemu_folder
        self.instance_id = instance_id
        self.logger = logger
        self.display_id = display_id
        # try to load dll from various pathAdd commentMore actions
        list_dll = [
            # MuMuPlayer12
            os.path.abspath(os.path.join(nemu_folder, './shell/sdk/external_renderer_ipc.dll')),
            # MuMuPlayer12 5.0
            os.path.abspath(os.path.join(nemu_folder, './nx_device/12.0/shell/sdk/external_renderer_ipc.dll')),
            # MuMuPlayer15 6.0
            os.path.abspath(os.path.join(nemu_folder, './nx_device/15.0/shell/sdk/external_renderer_ipc.dll')),
        ]
        ipc_dll = ''
        for ipc_dll in list_dll:
            if not os.path.exists(ipc_dll):
                continue
            try:
                self.lib = ctypes.CDLL(ipc_dll)
                break
            except OSError as e:
                self.logger.error(e.__str__())
                self.logger.error(f'ipc_dll={ipc_dll} exists, but cannot be loaded')
                continue
        if not self.lib:
            self.logger.error("NemuIpc requires MuMu12 version >= 3.8.13, please check your version.")
            self.logger.error(f'None of the following path exists')
            for path in list_dll:
                self.logger.error(f'{path}')
            raise NemuIpcIncompatible("Please check your MuMu Player 12 version and install path in YAB settings.")

        self.logger.info('NemuIpcImpl init')
        self.logger.info(f'nemu_folder = {nemu_folder}')
        self.logger.info(f'ipc_dll     = {ipc_dll}')
        self.logger.info(f'instance_id = {instance_id}')
        self.logger.info(f'display_id  = {display_id}')

        self.connect_id: int = 0
        self.width = 0
        self.height = 0

    def connect(self):
        if self.connect_id > 0:
            return

        connect_id = self.ev_run_sync(
            self.lib.nemu_connect,
            self.nemu_folder, self.instance_id
        )
        if connect_id == 0:
            raise NemuIpcError(
                'Connection failed, please check if nemu_folder is correct and emulator is running'
            )

        self.connect_id = connect_id

        NemuClient.connections[self.connect_id] = self
        # logger.info(f'NemuIpc connected: {self.connect_id}')

    def disconnect(self):
        if self.connect_id == 0:
            return

        self.ev_run_sync(
            self.lib.nemu_disconnect,
            self.connect_id
        )

        # logger.info(f'NemuIpc disconnected: {self.connect_id}')
        self.connect_id = 0

    def reconnect(self):
        self.disconnect()
        self.connect()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.disconnect()

    def ev_run_sync(self, func, *args, timeout=0.5, **kwargs):
        """Serialize native calls; a timeout cannot cancel a running DLL call."""
        with self._call_lock:
            if self._pending_call is not None and not self._pending_call.done():
                raise NemuIpcError("MuMu 上一次调用尚未结束，已停止继续调用，请检查模拟器状态。")
            future = self._executor.submit(func, *args, **kwargs)
            self._pending_call = future
            try:
                result = future.result(timeout=timeout)
            except FutureTimeoutError as exc:
                # Keep the running operation and its pointer arguments alive. Do
                # not queue retries while native code still uses those buffers.
                raise NemuIpcError("MuMu 调用超时，请检查模拟器状态或切换截图及控制方式。") from exc
            finally:
                if future.done():
                    self._pending_call = None

            failed = result <= 0 if func.__name__ == 'nemu_connect' else result != 0
            if failed:
                # Repeating a failed call just to capture stderr can repeat input
                # events and used to redirect process-wide stdout/stderr.
                raise NemuIpcError(f'MuMu 调用 {func.__name__} 失败，返回码：{result}')
            return result

    def get_resolution(self):
        """
        Get emulator resolution, `self.width` and `self.height` will be set
        """
        if self.connect_id == 0:
            self.connect()

        width_ptr = ctypes.pointer(ctypes.c_int(0))
        height_ptr = ctypes.pointer(ctypes.c_int(0))
        nullptr = ctypes.POINTER(ctypes.c_int)()

        ret = self.ev_run_sync(
            self.lib.nemu_capture_display,
            self.connect_id, self.display_id, 0, width_ptr, height_ptr, nullptr
        )
        if ret > 0:
            raise NemuIpcError('nemu_capture_display failed during get_resolution()')
        width, height = width_ptr.contents.value, height_ptr.contents.value
        if width <= 0 or height <= 0:
            raise NemuIpcError(f'MuMu 返回无效截图尺寸：{width}x{height}')
        self.width, self.height = width, height
        return width, height

    def screenshot(self, timeout=0.5):
        """
        Returns:
            np.ndarray: Upright image in BGR order, matching other screenshot methods.
        """
        if self.connect_id == 0:
            self.connect()

        width, height = self.get_resolution()

        width_ptr = ctypes.pointer(ctypes.c_int(width))
        height_ptr = ctypes.pointer(ctypes.c_int(height))
        length = width * height * 4
        pixels_pointer = ctypes.pointer((ctypes.c_ubyte * length)())

        ret = self.ev_run_sync(
            self.lib.nemu_capture_display,
            self.connect_id, self.display_id, length, width_ptr, height_ptr, pixels_pointer,
            timeout=timeout,
        )
        if ret > 0:
            raise NemuIpcError('nemu_capture_display failed during screenshot()')
        if (width_ptr.contents.value, height_ptr.contents.value) != (width, height):
            raise NemuIpcError('MuMu 截图期间分辨率发生变化，请重新截图。')

        image = np.ctypeslib.as_array(pixels_pointer.contents).reshape((height, width, 4))
        # MuMu's buffer is RGBA; YAB recognition expects BGR. This is equivalent
        # to the upstream COLOR_BGRA2RGB constant, with explicit format names.
        image = cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
        cv2.flip(image, 0, dst=image)
        return image

    def down(self, x, y):
        """
        Contact down, continuous contact down will be considered as swipe
        """
        if self.connect_id == 0:
            self.connect()
        if self.height == 0:
            self.get_resolution()

        ret = self.ev_run_sync(
            self.lib.nemu_input_event_touch_down,
            self.connect_id, self.display_id, x, y
        )
        if ret > 0:
            raise NemuIpcError('nemu_input_event_touch_down failed')

    def up(self):
        """
        Contact up
        """
        if self.connect_id == 0:
            self.connect()

        ret = self.ev_run_sync(
            self.lib.nemu_input_event_touch_up,
            self.connect_id, self.display_id
        )
        if ret > 0:
            raise NemuIpcError('nemu_input_event_touch_up failed')

    @staticmethod
    def serial_to_id(serial: str):
        """
        Predict instance ID from serial
        E.g.
            "127.0.0.1:16384" -> 0
            "127.0.0.1:16416" -> 1
            Port from 16414 to 16418 -> 1

        Returns:
             int: instance_id, or None if failed to predict
        """
        try:
            port = int(serial.split(':')[1])
        except (IndexError, ValueError):
            return None
        if port >= 16384 and port < 16384 + 32 * 32:
            index, offset = divmod(port - 16384 + 16, 32)
            offset -= 16
            if 0 <= index < 32 and offset in [-2, -1, 0, 1, 2]:
                return index
        if port >= 5555 and port < 5555 + 32:
            index, offset = divmod(port - 5555, 2)
            if 0 <= index < 32 and offset in [0, 1]:
                return index

    @staticmethod
    def get_possible_mumu_folder():
        from core.device.emulator_manager import mumu_api_backend
        try:
            path = mumu_api_backend("mumu", 0, operation="get_path")
            return path
        except Exception as e:
            return None

    @staticmethod
    def get_possible_mumu_exe():
        from core.device.emulator_manager import mumu_api_backend
        try:
            path = mumu_api_backend("mumu", 0, operation="get_path")
            return path
        except Exception as e:
            return None


if __name__ == '__main__':
    import cv2
    import logging

    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)

    nemu = NemuClient.get_instance("H:/MuMuPlayer-12.0", 0, logger)
    while True:
        t1 = time.time()
        nemu.down(720, 360)
        time.sleep(0.015)
        nemu.up()
        print(f'{time.time() - t1:.3f}s')
        time.sleep(1)
