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
        // TODO: 接口文档未规定 MQTT 连接与接入通知发布超时，暂按 150 秒处理。
        timeout(150000)
        steps {
            runjs("scripts/vcarea_test.js", "connect")
        }
    }
    stage("打开工程并配置测试环境") {
        // TODO: 接口文档未规定项目打开及 TCF/TBF 配置超时，暂按 180 秒处理。
        timeout(180000)
        steps {
            runjs("scripts/vcarea_test.js", "configure")
        }
    }
    stage("启动并等待实验环境就绪") {
        // TODO: 文档没有实验环境状态查询接口，暂以启动应答及执行端口查询成功为就绪。
        timeout(180000)
        steps {
            runjs("scripts/vcarea_test.js", "startMeasurement")
        }
    }
    stage("执行测试用例") {
        // TODO: 接口文档未规定 Case 执行上限，暂按 30 分钟处理。
        timeout(1800000)
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
