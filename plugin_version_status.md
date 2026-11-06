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
    },
    {
      "package_id": "atech_bootload_adapter",
      "base_version": "1.0.1",
      "build_number": 3,
      "content_sha256": "69bdda1ea371d26cd5f33f11e03bc918a45b6ae015e6d2140fc6b109f81dc346"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 3,
      "content_sha256": "85dfe07134f52c7d025b4861da1d55ef9f62f6ac6da6f971d76bb1b57219e639"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 3,
      "content_sha256": "1720de3cf001861762acdb80c64925b3fad8b9b2b376e3413e43b2d10ada9c16"
    },
    {
      "package_id": "dynamic_stage_test_plugin",
      "base_version": "1.0.0",
      "build_number": 3,
      "content_sha256": "4b1a51e10516318a796cfd0904da2ac472d91158e2cc7dc24cecabc63f7d0c32"
    },
    {
      "package_id": "ExcelModifyTest",
      "base_version": "1.0.0",
      "build_number": 3,
      "content_sha256": "dc612fe70b265e704a022c4498299c9d718e1616bc00d8bea19e29035e04af3e"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 3,
      "content_sha256": "25a0536e7bad4aadaa4630065c12d9e32adc784e1471422612a2b0f279fe668e"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 3,
      "content_sha256": "ac23d311111273d0816c6f1dd6043e238cc958d6c6a5e68e6f5b305933e5fc40"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 4,
      "content_sha256": "43ada1507923b7b6010c8c666827d6855fdba9a2aafed181a54eff645f92f1e1"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 4,
      "content_sha256": "ce1d8fe4c01232465a4edcec3c749109d430913fd3ad5b2b38241e0b652c0234"
    },
    {
      "package_id": "dynamic_stage_test_plugin",
      "base_version": "1.0.0",
      "build_number": 4,
      "content_sha256": "a72ba695c48691c58434db76fbd1aff67d9f84a893405c643d554ba9f1e5a1f9"
    },
    {
      "package_id": "ExcelModifyTest",
      "base_version": "1.0.0",
      "build_number": 4,
      "content_sha256": "9f66483c067ca7dfdbc960a26c47d06e379fe202d7486e05728310d7331c0d9b"
    },
    {
      "package_id": "atech_bootload_adapter",
      "base_version": "1.0.1",
      "build_number": 4,
      "content_sha256": "dca5bab90d4b87ab01dbd1fa41eaba7a72a6d736b8c7f298bed6eb6e08b8cb10"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 4,
      "content_sha256": "b0853b38abdbd50dd29f15d32871db63c784fd82fd99f2dd461b0ce5391d0cfd"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 4,
      "content_sha256": "546c1ad9016070050a94cfd9a06ba0e67f6ba4786fa6b602ddbd281dc67d895b"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 5,
      "content_sha256": "ad511efe7d7a0332da7339baf24eb21ca2351720bd06296d8ccfcce6416672e8"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 5,
      "content_sha256": "9ae716b39f0e6374ad8b7de7d91f01b5cc7e7369f7974c15cec2e2b9003fa223"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 6,
      "content_sha256": "d1400b4a4b569f4615af17fdd3d54319f8313e52de6b4d42dd34379fbf84f472"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 5,
      "content_sha256": "e714a473e3c8c0540be150d8137460668d7529d3c15e35fe33ccd650ba87d6a6"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 6,
      "content_sha256": "8be2b989c109e107ea39cc141edfc47da46ce4b43031ecc83ee68ce2de3e9bb8"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 5,
      "content_sha256": "ebeb39ed6252f6a6e81673e52eb778e322e73b71a5dbf1760a00c443d5aa34f9"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 7,
      "content_sha256": "9e1a125ded486683c4b95c33f2d1b2e0df066d7fcdacc5c5cdc82d2445997249"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 8,
      "content_sha256": "435d58906db77230ffaf839539e9f08768dd409ce3505e0af11e4bd9456ca0d0"
    },
    {
      "package_id": "atech_bootload_adapter",
      "base_version": "1.0.1",
      "build_number": 5,
      "content_sha256": "3727d672d57a6ff17df09d381ade39e3e3742fec41ef48aa0cc6f4c08ca33a53"
    },
    {
      "package_id": "dynamic_stage_test_plugin",
      "base_version": "1.0.0",
      "build_number": 5,
      "content_sha256": "d4af3242b83c88e86ecb809ba4c09bee95143ecf7c7622742c50a34da9a803e5"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 6,
      "content_sha256": "4c895f409a2d09a5551125a92612bea3459d592ae7c28d10441c819e1128a013"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 6,
      "content_sha256": "0b0e5632289c0f0af5a0ed0bb77e272fb5dfa1c570feebaac77cedc90b0f5cc7"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 7,
      "content_sha256": "933138307ee4721930a79d03cef027be2383fd648ceec4a6007b0753baefd210"
    },
    {
      "package_id": "ExcelModifyTest",
      "base_version": "1.0.0",
      "build_number": 5,
      "content_sha256": "82f3434924bd19541aac462d14d860c19ca0212f0b070f34a071fde51cc4843f"
    },
    {
      "package_id": "atech_bootload_adapter",
      "base_version": "1.0.1",
      "build_number": 6,
      "content_sha256": "708f2a10e868db76b6ccfb6a47526b752273616692e5bc002275edaa675e7e4c"
    },
    {
      "package_id": "ExcelModifyTest",
      "base_version": "1.0.0",
      "build_number": 6,
      "content_sha256": "9f66483c067ca7dfdbc960a26c47d06e379fe202d7486e05728310d7331c0d9b"
    },
    {
      "package_id": "dynamic_stage_test_plugin",
      "base_version": "1.0.0",
      "build_number": 6,
      "content_sha256": "a72ba695c48691c58434db76fbd1aff67d9f84a893405c643d554ba9f1e5a1f9"
    },
    {
      "package_id": "canoe_test_adapter",
      "base_version": "1.0.0",
      "build_number": 9,
      "content_sha256": "9e1a125ded486683c4b95c33f2d1b2e0df066d7fcdacc5c5cdc82d2445997249"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 8,
      "content_sha256": "ad511efe7d7a0332da7339baf24eb21ca2351720bd06296d8ccfcce6416672e8"
    },
    {
      "package_id": "hello_world_adapter",
      "base_version": "1.0.0",
      "build_number": 7,
      "content_sha256": "ebeb39ed6252f6a6e81673e52eb778e322e73b71a5dbf1760a00c443d5aa34f9"
    },
    {
      "package_id": "canoe_flash_adapter",
      "base_version": "1.0.0",
      "build_number": 7,
      "content_sha256": "e714a473e3c8c0540be150d8137460668d7529d3c15e35fe33ccd650ba87d6a6"
    },
    {
      "package_id": "vcarea_test_adapter",
      "base_version": "1.0.0",
      "build_number": 9,
      "content_sha256": "8be2b989c109e107ea39cc141edfc47da46ce4b43031ecc83ee68ce2de3e9bb8"
    }
  ]
}
```
