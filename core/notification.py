import os

# Check if the current OS is Windows
try:
    from win11toast import notify as _notify
    from win11toast import toast as _toast
except ImportError:
    _notify = None
    _toast = None
app_id = 'YAB'
icon_path = '/assets/logo.png'


def get_root_path():
    root_path = os.path.abspath(os.path.dirname(__file__))
    while True:
        if "main.py" in os.listdir(root_path):
            return root_path
        root_path = os.path.dirname(root_path)


def notify(title=None, body=None):
    if _notify is None:
        return False

    root_path = get_root_path()
    _notify(
        title=title,
        body=body,
        app_id=app_id,
        icon=root_path + icon_path,
    )
    return True


def toast(title=None, body=None, button=None, duration=None):
    root_path = get_root_path()
    return _toast(
        title=title,
        body=body,
        app_id=app_id,
        icon=root_path + icon_path,
        button=button,
        duration=duration
    )
