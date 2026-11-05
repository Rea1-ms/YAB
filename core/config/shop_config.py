"""Compatibility for the positional tactical challenge shop checklist."""

# Snapshot of the 16-item layout before Global added Miyu and moved AP first.
# Price distinguishes the two credit entries that share a name in the table.
LEGACY_TACTICAL_SHOP_ROWS = (
    ("宫子神明文字x5", 50), ("静子神明文字x5", 50),
    ("真白神明文字x5", 50), ("纱绫神明文字x5", 50),
    ("风香神明文字x5", 50), ("歌原神明文字x5", 50),
    ("30AP", 15), ("60AP", 30),
    ("初级经验书x5", 5), ("中级经验书x10", 25),
    ("高级经验书x3", 60), ("特级经验书x1", 100),
    ("信用点x5k", 4), ("信用点x5k", 20),
    ("信用点x75k", 60), ("信用点x125k", 100),
)


def _is_flag_list(value):
    return isinstance(value, list) and all(
        type(flag) in (int, bool) and flag in (0, 1) for flag in value
    )


def remap_tactical_shop_list(flags, old_rows, new_rows):
    """Keep selected products rather than their old screen positions."""
    validate_tactical_shop_list(flags, old_rows)
    selected = {tuple(row[:2]): flag for row, flag in zip(old_rows, flags)}
    return [selected.get(tuple(row[:2]), 0) for row in new_rows]


def migrate_tactical_shop_list(flags, server, price_rows):
    """Migrate known layouts only; leave ambiguous data available for editing."""
    if not _is_flag_list(flags):
        return flags
    if len(flags) == len(price_rows):
        return flags
    # No selected products means any old/default length can be resized safely.
    if not any(flags):
        return [0] * len(price_rows)
    if server in ('Global', 'JP') and len(flags) == len(LEGACY_TACTICAL_SHOP_ROWS):
        old_items = set(LEGACY_TACTICAL_SHOP_ROWS)
        new_items = {tuple(row[:2]) for row in price_rows}
        if len(price_rows) == 17 and new_items == old_items | {('美游神明文字x5', 50)}:
            return remap_tactical_shop_list(flags, LEGACY_TACTICAL_SHOP_ROWS, price_rows)
    return flags


def validate_tactical_shop_list(flags, price_rows):
    if not _is_flag_list(flags) or len(flags) != len(price_rows):
        count = len(flags) if isinstance(flags, list) else '未知'
        raise ValueError(
            f'竞技场商店购买配置无效：当前 {count} 项，商品表 {len(price_rows)} 项，'
            '且每项必须为 0 或 1。请在配置页重新勾选购买物品并保存。'
        )
