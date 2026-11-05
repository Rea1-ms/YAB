from core import picture
from core.exception import RequestHumanTakeOver
from core.picture import GAME_ONE_TIME_POP_UPS


STORE_ERRORS = {
    'main_page_login-store': '应用商店未登录，无法执行“收集免费购买体力”。请恢复商店登录后重试，或关闭此任务。',
    'main_page_store-service-unavailable': '应用商店服务不可用，无法执行“收集免费购买体力”。请恢复商店服务后重试，或关闭此任务。',
}


class StoreLoginGuard:
    def __init__(self, claim_stage=False):
        self.claim_stage = claim_stage
        self.claim_started = False
        self.dismissed_features = set()

    def before_reaction(self, feature, click):
        if self.claim_stage and feature in (
                'main_page_purchase-pyroxenes-menu',
                'main_page_purchase-pyroxenes-confirm-purchase-notice'):
            self.claim_started = True
        if feature not in ('main_page_login-store', 'main_page_login-store-session-unchecked'):
            return
        if self.claim_started:
            raise RequestHumanTakeOver(STORE_ERRORS['main_page_login-store'])
        # Allow a delayed startup prompt to be dismissed once in each stage.
        # The hook runs only for actual clicks, after duplicate-click suppression.
        if feature in self.dismissed_features:
            raise RequestHumanTakeOver(
                '应用商店登录提示反复出现，无法继续“收集免费购买体力”。请恢复商店登录后重试，或关闭此任务。')
        self.dismissed_features.add(feature)


def detect_store(self, *args, claim_stage=False, **kwargs):
    if self.server == 'Global':
        kwargs['img_errors'] = {
            'main_page_store-service-unavailable': STORE_ERRORS['main_page_store-service-unavailable'],
        }
        kwargs['before_reaction'] = StoreLoginGuard(claim_stage).before_reaction
    return picture.co_detect(self, *args, **kwargs)


def implement(self):
    self.to_main_page()
    to_purchase_pyroxenes_menu(self)
    if self.server == "JP":
        to_jp_daily_free_product(self)
    else:
        to_purchase_type(self, "package")
    if detect_free_power_availability(self):
        collect_daily_free_power(self)
    else:
        self.logger.info("Daily Free Power Already Collected.")

    return_to_main_page(self)
    return True

def collect_daily_free_power(self):
    self.logger.info("Collect Daily Free Power.")

    free_package_position = (385, 423) if self.server == "JP" else (385, 479)
    img_possibles = {
        "main_page_purchase-pyroxenes-menu": free_package_position,
        "main_page_purchase-pyroxenes-confirm-purchase-notice": (749, 571),
    }
    img_ends = "main_page_full-notice"
    rgb_ends = "reward_acquired"
    detect_store(self, rgb_ends, None, img_ends, img_possibles, skip_first_screenshot=True, claim_stage=True)
    self.logger.info("Get 10 AP")

def return_to_main_page(self):
    back_position = (52, 38) if self.server == "JP" else (1011, 114)
    img_possibles = {
        "main_page_purchase-pyroxenes-menu": back_position,
        "main_page_full-notice": (887, 165)
    }
    rgb_possibles = {
        "reward_acquired": (640, 180)
    }
    rgb_ends = "main_page"
    detect_store(self, rgb_ends, rgb_possibles, None, img_possibles, skip_first_screenshot=True)

def to_purchase_pyroxenes_menu(self):
    img_possibles = GAME_ONE_TIME_POP_UPS[self.server]
    rgb_possibles = {
        "main_page": (982, 28)
    }
    img_ends = "main_page_purchase-pyroxenes-menu"

    detect_store(self, None, rgb_possibles, img_ends, img_possibles, skip_first_screenshot=True)


def to_jp_daily_free_product(self):
    general_selected = [
        "main_page_purchase-pyroxenes-general-selected-1",
        "main_page_purchase-pyroxenes-general-selected-2",
    ]
    detect_store(
        self,
        None,
        None,
        general_selected,
        {"main_page_purchase-pyroxenes-menu": (130, 318)},
        skip_first_screenshot=True,
    )
    detect_store(
        self,
        None,
        None,
        "main_page_purchase-pyroxenes-daily-selected",
        {feature: (885, 100) for feature in general_selected},
        skip_first_screenshot=True,
    )

def to_purchase_type(self, tp):
    # position when " limited " exist
    p_1 = {
        "limited": (488, 186),
        "pyroxenes": (750, 186),
        "package": (1000, 186)
    }
    p_1 = p_1[tp]
    # position when " limited " not exist
    p_2 = {
        "pyroxenes": (590, 186),
        "package": (996, 186)
    }
    p_2 = p_2[tp]
    img_ends = {
        "limited": [
            "main_page_purchase-pyroxenes-limited-selected"
        ],
        "pyroxenes": [
            "main_page_purchase-pyroxenes-pyroxenes-selected-1",
            "main_page_purchase-pyroxenes-pyroxenes-selected-2"
        ],
        "package": [
            "main_page_purchase-pyroxenes-package-selected-1",
            "main_page_purchase-pyroxenes-package-selected-2",
            "main_page_purchase-pyroxenes-package-selected-3"
        ]
    }
    img_ends = img_ends[tp]
    img_possibles = {
        "main_page_purchase-pyroxenes-limited-selected": p_1,
        "main_page_purchase-pyroxenes-pyroxenes-selected-1": p_1,
        "main_page_purchase-pyroxenes-package-selected-1":p_1,
        "main_page_purchase-pyroxenes-pyroxenes-selected-2": p_2,
        "main_page_purchase-pyroxenes-package-selected-2": p_2,
        "main_page_purchase-pyroxenes-guide-selected-2": p_2
    }
    for img_end in img_ends:
        img_possibles.pop(img_end, None)
    detect_store(self, None, None, img_ends, img_possibles, skip_first_screenshot=True)

def detect_free_power_availability(self):
    img_ends = [
        "main_page_purchase-pyroxenes-daily-free-purchasable",
        "main_page_purchase-pyroxenes-daily-free-non-purchasable",
    ]
    ret = detect_store(self, None, None, img_ends, None, skip_first_screenshot=True)
    if ret == "main_page_purchase-pyroxenes-daily-free-purchasable":
        return True
    return False
