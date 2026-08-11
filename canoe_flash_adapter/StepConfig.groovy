stages {
    stage("准备任务工作区") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_flash.js", "prepare", env.CANOE_PROJECT, env.SOFTWARE_PACKAGE)
        }
    }
    stage("启动 CANoe") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_flash.js", "launch")
        }
    }
    stage("连接 Automation") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_flash.js", "connect")
        }
    }
    stage("打开配置并启动测量") {
        timeout(120000)
        steps {
            runjs("scripts/canoe_flash.js", "startMeasurement")
        }
    }
    stage("校验刷写契约") {
        timeout(30000)
        steps {
            runjs("scripts/canoe_flash.js", "validateContract")
        }
    }
    stage("执行刷写并验证") {
        timeout(1800000)
        steps {
            runjs("scripts/canoe_flash.js", "flash")
        }
    }
    stage("收集刷写产物") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_flash.js", "collectArtifacts")
        }
    }
}
post {
    always {
        runjs("scripts/canoe_flash.js", "cleanup")
    }
}
