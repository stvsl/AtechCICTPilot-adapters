stages {
    stage("准备 CANoe 测试工程") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_test.js", "prepare", env.CANOE_PROJECT)
        }
    }
    stage("启动 CANoe") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_test.js", "launch")
        }
    }
    stage("连接 Automation") {
        timeout(150000)
        steps {
            runjs("scripts/canoe_test.js", "connect")
        }
    }
    stage("装载测试单元") {
        timeout(120000)
        steps {
            runjs("scripts/canoe_test.js", "configure")
        }
    }
    stage("打开配置并启动测量") {
        timeout(120000)
        steps {
            runjs("scripts/canoe_test.js", "startMeasurement")
        }
    }
    stage("执行测试用例") {
        timeout(1800000)
        steps {
            runjs("scripts/canoe_test.js", "execute")
        }
    }
}
post {
    always {
    }
}
