import os.path

import numpy as np

from core.device.nemu_client import NemuClient, NemuIpcError, NemuIpcIncompatible


class NemuScreenshot:
    def __init__(self, conn):
        # C:/Program Files/Netease/MuMu Player 12/shell/MuMuPlayer.exe
        self.config_set = conn.config_set
        self.config = conn.config
        self.logger = conn.logger
        self.serial = conn.serial

        self.nemu_folder = self.config.program_address
        self.nemu_folder = os.path.dirname(self.nemu_folder)
        self.nemu_folder = os.path.dirname(self.nemu_folder)  # C:/Program Files/Netease/MuMu Player 12

        self.instance_id = NemuClient.serial_to_id(self.serial)
        if self.instance_id is not None:
            try:
                self.nemu_client = NemuClient.get_instance(self.nemu_folder, self.instance_id, self.logger)
            except (NemuIpcIncompatible, NemuIpcError) as e:
                self.logger.warning(e.__str__())
                self.logger.info("Emulator info incorrect. Try to auto detect mumu player path.")
                path = NemuClient.get_possible_mumu_folder()
                self.logger.info(f"Auto detect mumu player path: {str(path)}")
                exe_path = NemuClient.get_possible_mumu_exe()
                self.logger.info(f"Auto detect mumu player executable path: {str(exe_path)}")
                if path is not None:
                    self.config_set.set("program_address", exe_path)
                    self.nemu_folder = os.path.dirname(path)
                    try:
                        self.nemu_client = NemuClient.get_instance(self.nemu_folder, self.instance_id, self.logger)
                    except (NemuIpcIncompatible, NemuIpcError) as e:
                        self.logger.error(e.__str__())
                        raise Exception("Unable to init NemuScreenshot with auto detected path.")
                else:
                    self.logger.error("MuMu Player 12 not found.")
                    raise Exception("Unable to use Init NemuScreenshot.")
        else:
            self.logger.error('Can\'t convert serial to instance id.')
            raise Exception("Invalid serial. Unable to use Init NemuScreenshot.")

    def screenshot(self):
        last_error = None
        for i in range(3):
            try:
                if i > 0:
                    self.logger.warning("Retry : " + str(i))
                image = self.nemu_client.screenshot()
                if (not isinstance(image, np.ndarray) or image.ndim != 3
                        or image.shape[2] != 3 or image.size == 0):
                    raise NemuIpcError("MuMu 截图未返回有效画面")
                return image
            except Exception as e:
                last_error = e
                self.logger.warning("Fail to call nemu screenshot.")
                self.logger.warning(e.__str__())
        raise NemuIpcError(
            "MuMu 截图连续 3 次失败，请检查模拟器是否正常运行，或改用 adb（安卓调试截图）后重新启动任务。"
        ) from last_error


