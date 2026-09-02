stages {
    stage("准备 CANoe 测试工程") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_test.js", "prepareProject", env.CANOE_PROJECT)
        }
    }
    stage("启动 CANoe") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_test.js", "launchCanoe")
        }
    }
    stage("连接 Automation") {
        timeout(150000)
        steps {
            runjs("scripts/canoe_test.js", "connectAutomation")
        }
    }
    stage("打开 CANoe 配置") {
        timeout(120000)
        steps {
            runjs("scripts/canoe_test.js", "openConfiguration")
        }
    }
    stage("配置测试环境") {
        timeout(120000)
        steps {
            runjs("scripts/canoe_test.js", "configureTestEnvironment")
        }
    }
    stage("执行测试") {
        timeout(1800000)
        steps {
            runjs("scripts/canoe_test.js", "executeTests")
        }
    }
    stage("发布测试产物") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_test.js", "publishArtifacts")
        }
    }
}
post {
    always {
        runjs("scripts/canoe_test.js", "cleanup")
    }
}
