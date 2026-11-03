"""Structured panel schemas for the WebUI, replacing the old Qt expand cards.

Values are read/written through the existing ConfigArg topic / `set` RPC; this
module only describes which keys belong to which panel, how to render them and
where dynamic option lists come from. `options_from` resolvers may depend on
the config's server_mode, so the provider is per-config (topic `Panels:<dir>`).
"""

import json

from core.config.config_set import ConfigSet

# ---------------------------------------------------------------------------
# option resolvers (per config server_mode)
# ---------------------------------------------------------------------------

_STUDENT_NAME_KEY = {'CN': 'CN_name', 'Global': 'Global_name', 'JP': 'JP_name'}


def _server_mode(config):
    return config.server_mode or 'CN'


def _lesson_region_key(server_mode):
    return f'{server_mode}_en-us' if server_mode == 'Global' else server_mode


def _resolve_options(name, config):
    static = config.static_config
    server = _server_mode(config)
    if name == 'total_assault_difficulties':
        return list(static.total_assault_difficulties[server])
    if name == 'common_shop_items':
        return [row[0] for row in static.common_shop_price_list[server]]
    if name == 'common_shop_rows':
        return [{'name': row[0], 'price': row[1], 'currency': row[2]}
                for row in static.common_shop_price_list[server]]
    if name == 'tactical_shop_items':
        return [row[0] for row in static.tactical_challenge_shop_price_list[server]]
    if name == 'tactical_shop_rows':
        return [{'name': row[0], 'price': row[1]}
                for row in static.tactical_challenge_shop_price_list[server]]
    if name == 'students':
        key = _STUDENT_NAME_KEY.get(server, 'CN_name')
        return [s[key] for s in static.student_names]
    if name == 'hard_student_stages':
        # hard_task_student_material rows: [stage like "1-1", 学生名]
        mapping = {}
        for stage, student in static.hard_task_student_material:
            region = int(stage.split('-')[0])
            if region > static.max_region.get(server, 999):
                continue
            mapping.setdefault(student, []).append(f'{stage}-3')
        return [{'student': k, 'stages': v} for k, v in mapping.items()]
    if name == 'lesson_regions':
        return list(static.lesson_region_name[_lesson_region_key(server)])
    if name == 'create_items':
        order = static.create_item_order[server]['basic']
        items = []
        for entries in order.values():
            items.extend(entries)
        return items
    if name == 'create_priority_items_1':
        return list(static.create_default_priority[server]['phase1'])
    if name == 'create_priority_items_2':
        return list(static.create_default_priority[server]['phase2'])
    if name == 'create_priority_items_3':
        return list(static.create_default_priority[server]['phase3'])
    if name == 'main_story_regions':
        return [str(i) for i in range(1, static.main_story_available_episodes[server] + 1)]
    raise ValueError(f'unknown options source: {name}')


def resolve_schema(config):
    """Return PANELS with every `options_from` materialized into `options`."""
    import copy
    panels = copy.deepcopy(PANELS)
    for panel in panels:
        for group in panel.get('groups', []):
            for field in group['fields']:
                source = field.pop('options_from', None)
                if source:
                    field['options'] = _resolve_options(source, config)
                source = field.pop('student_stages_from', None)
                if source:
                    field['student_stages'] = _resolve_options(source, config)
    return panels


# ---------------------------------------------------------------------------
# labeled option helpers
# ---------------------------------------------------------------------------

def _opts(*pairs):
    return [{'value': v, 'label': l} for v, l in pairs]


INVITE_CRITERION = _opts(
    ('lowest_affection', '邀请最低好感度学生'),
    ('highest_affection', '邀请最高好感度学生'),
    ('starred', '邀请收藏的学生'),
    ('name', '指定姓名邀请'),
)

CHOOSE_TEAM_METHOD = _opts(
    ('preset', '按预设编队'),
    ('side', '按侧栏属性编队'),
    ('order', '按侧栏顺序编队'),
)

CREATE_RULE_PHASE1 = _opts(
    ('default', '默认'),
    ('primary', '白色材料'),
    ('normal', '蓝色材料'),
    ('primary_normal', '白色+蓝色材料'),
    ('advanced', '金色材料'),
    ('superior', '紫色材料'),
    ('advanced_superior', '金色+紫色材料'),
    ('primary_normal_advanced_superior', '白色+蓝色+金色+紫色材料'),
    ('keystone', '制造石'),
)

CREATE_RULE_PHASE23 = _opts(
    ('default', '默认'),
    ('advanced', '金色材料'),
    ('superior', '紫色材料'),
    ('advanced_superior', '金色+紫色材料'),
    ('keystone', '制造石'),
)

TICKET_TIMES_LONG = ['max', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
TICKET_TIMES_SHORT = ['max', '0', '1', '2', '3', '4']


def _group(title, *fields):
    return {'title': title, 'fields': [f for f in fields if f]}


def _field(key, label, ftype, **extra):
    return {'key': key, 'type': ftype, 'label': label, **extra}


# ---------------------------------------------------------------------------
# panels（顺序参照旧 switch.json 的 sort）
# ---------------------------------------------------------------------------

PANELS = [
    {
        'id': 'cafeInvite', 'name': '咖啡厅', 'page': 'config',
        'tip': '帮助你收集咖啡厅体力和信用点',
        'groups': [
            _group('通用设置',
                   _field('cafe_reward_collect_hour_reward', '是否领取奖励', 'switch'),
                   _field('cafe_reward_use_invitation_ticket', '是否使用邀请券', 'switch'),
                   _field('cafe_reward_allow_exchange_student', '是否允许学生更换服饰', 'switch'),
                   _field('cafe_reward_allow_duplicate_invite', '是否允许重复邀请', 'switch'),
                   _field('cafe_reward_affection_pat_round', '摸头轮数', 'number',
                          help='轮数越高越不会漏摸'),
                   _field('patStyle', '摸头方式', 'select', options=['拖动礼物'],
                          help='当前仅支持「拖动礼物」'),
                   _field('cafe_reward_has_no2_cafe', '是否有二号咖啡厅', 'switch'),
                   ),
            _group('1号咖啡厅',
                   _field('cafe_reward_invite1_criterion', '邀请券选择模式', 'select',
                          options=INVITE_CRITERION),
                   _field('favorStudent1', '指定学生列表', 'student_text',
                          options_from='students', help='逗号分隔，从下拉添加或直接填写'),
                   _field('cafe_reward_invite1_starred_student_position', '收藏学生序号', 'select',
                          options=['1', '2', '3', '4', '5'], coerce='int',
                          help='选择收藏学生在收藏列表中的序号'),
                   ),
            _group('2号咖啡厅',
                   _field('cafe_reward_invite2_criterion', '邀请券选择模式', 'select',
                          options=INVITE_CRITERION),
                   _field('favorStudent2', '指定学生列表', 'student_text',
                          options_from='students'),
                   _field('cafe_reward_invite2_starred_student_position', '收藏学生序号', 'select',
                          options=['1', '2', '3', '4', '5'], coerce='int'),
                   ),
        ],
    },
    {
        'id': 'schedulePriority', 'name': '日程', 'page': 'config',
        'tip': '自动每日日程',
        'groups': [
            _group('',
                   _field('lesson_enableInviteFavorStudent', '优先做指定学生存在的日程', 'switch'),
                   _field('lesson_favorStudent', '指定学生', 'student_text',
                          options_from='students', help='填写指南见 wiki'),
                   _field('lesson_relationship_first', '优先做好感等级多的日程', 'switch'),
                   _field('lesson_times', '各区域日程次数与等级', 'lesson_editor',
                          options_from='lesson_regions',
                          levels=['primary', 'normal', 'advanced', 'superior'],
                          level_labels=['初级', '普通', '高级', '特级']),
                   ),
        ],
    },
    {
        'id': 'shopPriority', 'name': '商店购买', 'page': 'config',
        'tip': '商店里买东西',
        'groups': [
            _group('',
                   _field('CommonShopList', '请勾选购买物品', 'shop_checklist',
                          options_from='common_shop_rows',
                          help='勾选要购买的物品，刷新后仍会按此清单购买'),
                   _field('CommonShopRefreshTime', '购买刷新次数', 'number', max=3,
                          coerce='int'),
                   ),
        ],
    },
    {
        'id': 'arenaShopPriority', 'name': '竞技场商店购买', 'page': 'config',
        'tip': '竞技场商店里买东西',
        'groups': [
            _group('',
                   _field('TacticalChallengeShopList', '请勾选购买物品', 'shop_checklist',
                          options_from='tactical_shop_rows'),
                   _field('TacticalChallengeShopRefreshTime', '购买刷新次数', 'number', max=3,
                          coerce='int'),
                   ),
        ],
    },
    {
        'id': 'mainlinePriority', 'name': '主线清除体力', 'page': 'config',
        'tip': '主线关卡自动清除体力与每日困难',
        'groups': [
            _group('',
                   _field('mainlinePriority', '普通关卡扫荡', 'sweep_editor',
                          sweep_key='mainlinePriority', normal=True,
                          help='格式 关卡-次数，如 "1-1-1,1-2-3" 表示 1-1 打一次、1-2 打三次'),
                   _field('hardPriority', '困难关卡扫荡', 'sweep_editor',
                          sweep_key='hardPriority', normal=False,
                          student_stages_from='hard_student_stages',
                          help='同普通关，次数最多为 3；日服、国际服可填 max'),
                   ),
        ],
    },
    {
        'id': 'arenaPriority', 'name': '竞技场', 'page': 'config',
        'tip': '帮助你自动打竞技场',
        'groups': [
            _group('',
                   _field('ArenaStopFightWhenRank1', '在排名为第一时不进行战斗', 'switch'),
                   _field('ArenaLevelDiff', '对手等级差', 'number',
                          help='需要对手比你低几级，高几级则填负数'),
                   _field('maxArenaRefreshTimes', '最多刷新次数', 'number'),
                   _field('ArenaComponentNumber', '自定义对手的编号', 'select',
                          options=['1', '2', '3'], coerce='int'),
                   ),
        ],
    },
    {
        'id': 'createPriority', 'name': '自动制造', 'page': 'config',
        'tip': '帮助你自动制造',
        'groups': [
            _group('',
                   _field('use_acceleration_ticket', '是否使用加速券', 'switch'),
                   _field('createTime', '制造次数', 'number'),
                   _field('create_phase', '制造级数', 'select', options=['1', '2', '3'],
                          coerce='int'),
                   ),
            _group('一级制造配置',
                   _field('create_phase_1_select_item_rule', '材料选择', 'select',
                          options=CREATE_RULE_PHASE1),
                   _field('createPriority_phase1', '制造优先级', 'ordered_checklist',
                          options_from='create_priority_items_1'),
                   ),
            _group('二级制造配置',
                   _field('create_phase_2_select_item_rule', '材料选择', 'select',
                          options=CREATE_RULE_PHASE23),
                   _field('createPriority_phase2', '制造优先级', 'ordered_checklist',
                          options_from='create_priority_items_2'),
                   ),
            _group('三级制造配置',
                   _field('create_phase_3_select_item_rule', '材料选择', 'select',
                          options=CREATE_RULE_PHASE23),
                   _field('createPriority_phase3', '制造优先级', 'ordered_checklist',
                          options_from='create_priority_items_3'),
                   ),
        ],
    },
    {
        'id': 'totalForceFightPriority', 'name': '总力战', 'page': 'config',
        'tip': '总力战期间自动打总力战',
        'groups': [
            _group('',
                   _field('totalForceFightDifficulty', '最高难度', 'select',
                          options_from='total_assault_difficulties'),
                   ),
        ],
    },
    {
        'id': 'sweepCountConfig', 'name': '扫荡及购买券设置', 'page': 'config',
        'tip': '各种扫荡及购买券次数设置',
        'groups': [
            _group('各区域扫荡次数（英文逗号分隔，可为 max）',
                   _field('rewarded_task_times', '悬赏委托扫荡', 'text'),
                   _field('scrimmage_times', '学园交流会扫荡', 'text'),
                   _field('activity_sweep_task_number', '活动关卡扫荡关卡', 'text'),
                   _field('activity_sweep_times', '活动关卡扫荡次数', 'text'),
                   _field('special_task_times', '特殊委托扫荡', 'text'),
                   ),
            _group('用券数目设置',
                   _field('purchase_rewarded_task_ticket_times', '悬赏委托扫荡券购买次数', 'select',
                          options=TICKET_TIMES_LONG),
                   _field('purchase_lesson_ticket_times', '日程券购买次数', 'select',
                          options=TICKET_TIMES_SHORT),
                   _field('purchase_scrimmage_ticket_times', '学园交流会扫荡券购买次数', 'select',
                          options=TICKET_TIMES_LONG),
                   ),
        ],
    },
    {
        'id': 'friendWhiteList', 'name': '自动清好友白名单', 'page': 'config',
        'tip': '设置在定期好友清理中需要保留的好友码',
        'groups': [
            _group('',
                   _field('clear_friend_white_list', '白名单好友码', 'tag_list',
                          help='输入好友码后回车添加'),
                   ),
        ],
    },
    {
        'id': 'drillConfig', 'name': '战术综合测试', 'page': 'config',
        'tip': '帮助你自动打战术综合测试',
        'groups': [
            _group('',
                   _field('drill_enable_sweep', '是否在出击后扫荡所有测试挑战券', 'switch'),
                   _field('drill_fight_formation_list', '出击队伍编号', 'slots_select',
                          options=['1', '2', '3', '4'], coerce='int[]',
                          help='每个槽位选择一支队伍'),
                   _field('drill_difficulty_list', '出击难度', 'slots_select',
                          options=['1', '2', '3', '4'], coerce='int[]'),
                   ),
        ],
    },
    # ---- 旧设置页的面板 ----
    {
        'id': 'formationConfig', 'name': '编队选择', 'page': 'settings',
        'groups': [
            _group('',
                   _field('choose_team_method', '编队选择方式', 'select',
                          options=CHOOSE_TEAM_METHOD),
                   ),
        ],
    },
    {
        'id': 'exploreConfig', 'name': '推图设置', 'page': 'settings',
        'groups': [
            _group('',
                   _field('manual_boss', '是否手动boss战', 'switch',
                          help='普通图独有配置，进入关卡后暂停等待手操'),
                   _field('explore_task_use_simple_mode', '使用简易模式推图', 'switch',
                          help='简易模式只需要一支成形队伍, 角色较少时建议使用(默认使用第一支队伍)'),
                   _field('explore_normal_task_list', '普通图推图设置', 'text',
                          action={'label': '开始推普通关', 'task': 'explore_normal_task'},
                          help='请填写要推的图, 填写方式见帮助 - 普通图自动推图说明'),
                   _field('explore_hard_task_list', '困难图推图设置', 'text',
                          action={'label': '开始推困难关', 'task': 'explore_hard_task'},
                          help='困难图队伍属性和普通图相同, 请按照帮助说明选择关卡并设置队伍'),
                   ),
        ],
    },
    {
        'id': 'proceedPlot', 'name': '剧情推进', 'page': 'settings',
        'groups': [
            _group('',
                   _field('main_story_regions', '主线剧情需要推的章节数', 'text'),
                   _field('__plot_actions', '开始推进', 'actions',
                          actions=[
                              {'label': '开始推主线剧情', 'task': 'main_story'},
                              {'label': '开始推小组剧情', 'task': 'group_story'},
                              {'label': '开始推支线剧情', 'task': 'mini_story'},
                          ]),
                   ),
        ],
    },
    {
        'id': 'eventMap', 'name': '活动一键执行', 'page': 'settings',
        'groups': [
            _group('',
                   _field('__activity_actions', '当期活动', 'actions',
                          actions=[
                              {'label': '推活动剧情', 'task': 'explore_activity_story'},
                              {'label': '推活动任务', 'task': 'explore_activity_mission'},
                              {'label': '推活动挑战', 'task': 'explore_activity_challenge'},
                          ]),
                   ),
        ],
    },
    {
        'id': 'otherConfig', 'name': '其他设置', 'page': 'settings',
        'groups': [
            _group('',
                   _field('bannerVisibility', '显示首页头图（下次启动时生效）', 'switch'),
                   _field('__de_clothes', '一键反和谐', 'actions',
                          actions=[{'label': '执行反和谐', 'task': 'de_clothes'}]),
                   ),
        ],
    },
]


def switch_cards():
    """Card metadata from the default switch.json template."""
    from core.config import default_config
    return json.loads(default_config.SWITCH_DEFAULT_CONFIG)
