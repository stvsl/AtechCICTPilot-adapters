stages {
    stage("准备 VCarEA 任务") {
        timeout(60000)
        steps {
            runjs("scripts/vcar_ea.js", "prepare")
        }
    }
    stage("连接 EA MQTT 服务") {
        timeout(60000)
        steps {
            runjs("scripts/vcar_ea.js", "connect")
        }
    }
    stage("登记 EA API 客户端") {
        timeout(60000)
        steps {
            runjs("scripts/vcar_ea.js", "registerAccess")
        }
    }
    stage("打开 VCarEA 项目") {
        timeout(180000)
        steps {
            runjs("scripts/vcar_ea.js", "openProject")
        }
    }
    stage("配置测试台") {
        timeout(180000)
        steps {
            runjs("scripts/vcar_ea.js", "configure")
        }
    }
    stage("启动实验环境") {
        timeout(180000)
        steps {
            runjs("scripts/vcar_ea.js", "startEnvironment")
        }
    }
    stage("执行 Case 或 Plan") {
        timeout(1800000)
        steps {
            runjs("scripts/vcar_ea.js", "execute")
        }
    }
    stage("下载执行报告") {
        timeout(600000)
        steps {
            runjs("scripts/vcar_ea.js", "collectReport")
        }
    }
    stage("停止实验环境") {
        timeout(180000)
        steps {
            runjs("scripts/vcar_ea.js", "stopEnvironment")
        }
    }
    stage("关闭 VCarEA 项目") {
        timeout(180000)
        steps {
            runjs("scripts/vcar_ea.js", "closeProject")
        }
    }
}
post {
    always {
        runjs("scripts/vcar_ea.js", "cleanup")
    }
}
