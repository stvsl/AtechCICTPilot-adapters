stages {
    stage("准备 VCarEA 测试工程") {
        // TODO: 接口文档未规定工程包解压与校验超时，暂按 60 秒处理。
        timeout(60000)
        steps {
            runjs("scripts/vcarea_test.js", "prepare", env.VCAR_EA_PROJECT)
        }
    }
    stage("启动VCarEA") {
        // TODO: 接口文档未规定客户端及 Connector 服务启动超时，暂按 180 秒处理。
        timeout(180000)
        steps {
            runjs("scripts/vcarea_test.js", "launch")
        }
    }
    stage("获取MQTT连接配置") {
        // TODO: Connector SDK 未规定查询超时，暂按 60 秒处理。
        timeout(60000)
        steps {
            runjs("scripts/vcarea_test.js", "readMqttConfig")
        }
    }
    stage("连接 EA MQTT 服务") {
        // TODO: 接口文档未规定 MQTT 连接与 API 接入就绪超时，暂按 150 秒处理。
        timeout(150000)
        steps {
            runjs("scripts/vcarea_test.js", "connect")
        }
    }
    stage("打开工程并配置测试环境") {
        // TODO: 接口文档未规定项目后台初始化及 TCF/TBF 配置超时，暂按 600 秒处理：
        // 就绪探测最长 120 秒；打开工程应答实测 5~35 秒；宿主后台恢复窗口内
        // 业务请求会被“其他接口正在工作”拒绝，按 ConfigureResponseTimeoutMs
        // 自动重发；单次 TCF/TBF 配置实测 16~24 秒（同步加载 XIL 环境），
        // 其余为配置请求瞬态重试的兜底余量。
        timeout(600000)
        steps {
            runjs("scripts/vcarea_test.js", "configure")
        }
    }
    stage("启动并等待实验环境就绪") {
        // 实测：环境启动应答（约 12 秒）即为就绪信号；执行端口查询接口在
        // 1.8.4.0826 无任何应答，仅做一次有界观察，不作为失败判据。
        timeout(120000)
        steps {
            runjs("scripts/vcarea_test.js", "startMeasurement")
        }
    }
    stage("执行测试计划") {
        // Plan 完成以宿主转发的 Plan/Stop 或 Run/Stop 事件判定（主题带 KY/ 前缀）；
        // 单 Plan 执行超时默认 30 分钟（ExecutionTimeoutMs），阶段总上限 24 小时。
        timeout(86400000)
        steps {
            runjs("scripts/vcarea_test.js", "execute")
        }
    }
    stage("收集测试报告") {
        // TODO: 接口文档未规定报告推送上限，暂按 10 分钟处理。
        timeout(600000)
        steps {
            runjs("scripts/vcarea_test.js", "collectArtifacts")
        }
    }
}
post {
    always {
        runjs("scripts/vcarea_test.js", "cleanup")
    }
}
