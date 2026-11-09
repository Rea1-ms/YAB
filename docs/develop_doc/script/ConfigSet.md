# Class `ConfigSet`
对应文件路径：`core/config/config_set.py`（配置集合实现）。

当前网页和运行任务的配置生效时机，见 [网页与商店维护](../webui_shop_maintenance.md#配置何时生效)。以下接口中的保存、页面推送和任务重读不是同一件事。

**related files**:
- `"develop_tools/generate_dataclass_code.py"`
- `"core/config/default_config.py"`
- `"core/config/generated_user_config.py"`
- `"core/config/generated_static_config.py"`

## 总览
用于管理配置文件, 包括静态配置( static_config )和用户配置 ( self.config )
1. 加载, 初始化所有配置 
    - [`__init__`](#init)
    - [`_init_config`](#init-config)
2. 读取
    - [`get`](#get)
3. 修改
    - [`set`](#set)
    - [`update`](#update)
4. 保存
    - [`save`](#save)

## Members
### static_config
- **type**: `StaticConfig` dataclass ( 见`generated_static_config.py` )
- **note**: 由`core.default_config.py.STATIC_DEFAULT_CONFIG` 生成
  1. `generated_static_config.StaticConfig`
  2. `static.json`
  - 两者再共同构成`static_config`
### config
- **type**: `Config` dataclass ( 见`generated_user_config.py` )
- **note**: 由`core.default_config.py.USER_DEFAULT_CONFIG` 生成
  1. `generated_user_config.Config`
  2. `config.json`
  - 两者再共同构成`config`
### config_dir
- **type**: `str`
- **description**: 配置文件所在**文件夹**的绝对路径
### server_mode 
- **type**: `str`
- **description**: 值与 [`Baas_thread.server`](/develop_doc/script/Baas_thread#server) 相同
### inject_comp_list

### inject_config_list

### window 
  
### main_thread 

### signals 

## Methods:

### `__init__`
- **Args**:
  - `config_dir`: 配置文件目录的**名称**或**绝对路径**

### `_init_static_config`
- **Description**: 加载静态配置文件, 并将其存储在 [`static_config`](#static-config) 中
### `_init_config`
- **Description**: 加载用户配置文件, 并将其存储在 [`config`](#config) 中, 同时会设置 [`server_mode`](#server_mode)  
### `get`
- **Description**: 每次先重新读取用户配置文件，再获取一条配置值；直接访问已有配置对象不会自动刷新
- **Args**:
    - `key`: 配置名
    - `default`: 默认值
### `set`
- **Description**: 先重新读取用户配置，再更新一条配置值并保存
- **Args**:
    - `key`: 配置名
    - `value`: 新值
- **note**: 当前网页由服务在保存后推送配置更新；本方法不会自动同步网页或运行中的任务副本

### `update`
- **Description**: 直接调用 [`set`](#set)，同样会更新配置值并保存文件

### `save`
- **Description**: 保存用户配置到`config.json`文件

### `dynamic_update`

### `__getitem__`

### `add_signal`

### `get_signal`

### `set_window`

### `get_window`

### `set_main_thread`

### `get_main_thread`

### `inject`

### `update_create_quantity_entry(self)`

## 使用示例 (Example Usage)
```python
config_set = ConfigSet(config_dir="default_config")
server_mode = config_set.get("server") # get方法获取值
server_mode = config_set.config.server # 直接访问dataclass的成员
config_set.set("server", "日服")

```
