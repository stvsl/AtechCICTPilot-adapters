# 插件构建版本状态

本文件是插件构建轮次的唯一持久状态，请与插件源码一起审查和保存。
完整版本为 `基础版本_四位轮次`；每个 PackageId + 基础版本从 0001 独立递增，
最大 9999。仅成功打包后追加记录，无变化构建保持版本及本文件字节不变。
不要删除历史或手工重置轮次；损坏状态会使构建明确失败。
以下 JSON 由 `tools/plugin_package_version.py` 在跨进程锁内原子更新。

```json
{
  "schema_version": 1,
  "builds": [
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 1,
      "content_sha256": "e384efab52c43dee08acaf7f758d2e817a0ce84ce88e799e687900312379ef09"
    },
    {
      "package_id": "atech_bootload_adapter",
      "base_version": "1.0.1",
      "build_number": 1,
      "content_sha256": "22837f8defc3ff75321cc71e07bb55f11b248a979c2366d71d62e66ea92e56f3"
    },
    {
      "package_id": "dynamic_stage_test_plugin",
      "base_version": "1.0.0",
      "build_number": 1,
      "content_sha256": "7387426c3024798ac85a06f880246986d45a50abf55ff13c3d0db8b734a3a28e"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 1,
      "content_sha256": "667d83ddb10dfc39022254911def3d3d125967fc5c42dc887af0064cac299ca1"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 1,
      "content_sha256": "3f3661736ccf6c080442555c81178249e2fb4c6bd2e1cda0050d5e2be4c4b6f3"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 1,
      "content_sha256": "0f9dc26ddee3c911c2e27761cec34c4b3e5a86b7980c7866740584abbe7a3a75"
    },
    {
      "package_id": "ExcelModifyTest",
      "base_version": "1.0.0",
      "build_number": 1,
      "content_sha256": "3296f989a954324f548b86d06796e5fa99402df157cf7f44bc0407054249ec7d"
    },
    {
      "package_id": "ExcelModifyTest",
      "base_version": "1.0.0",
      "build_number": 2,
      "content_sha256": "be69a98f74ba5cf7167dc3ba9465ab75eb4d875907f439849ea382297c41b16c"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 2,
      "content_sha256": "18037499a4cb7cc1facf0e438d20bdf8faebd59749a9076cb90b53c11d6bea34"
    },
    {
      "package_id": "dynamic_stage_test_plugin",
      "base_version": "1.0.0",
      "build_number": 2,
      "content_sha256": "1cf9ab53171e6126b0d2503291e1000f2617f37f2c86f2ae500b1744daa2aac9"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 2,
      "content_sha256": "76afd0c498f22e4c0c2eea404246971f86a87e642caccfad31495c1531272491"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 2,
      "content_sha256": "43b1d2f2bb4c9d8ad4d82dbff800bc031bd20db0d62ffd6d1e1358eb7c5e60ef"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 2,
      "content_sha256": "a655f941066455fea5a6e8bcb25a66c7f18b184a1fc9f9a0c4c14d7c6e13868a"
    },
    {
      "package_id": "atech_bootload_adapter",
      "base_version": "1.0.1",
      "build_number": 2,
      "content_sha256": "74da96a4def825a4fd1cd6fd6d24b537a6b8040a990f96840fc4982ca881dc41"
    }
  ]
}
```
