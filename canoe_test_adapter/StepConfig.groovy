stages {
    stage("准备 CANoe 工程列表") {
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
    stage("创建 CANoe 工程执行阶段") {
        timeout(60000)
        steps {
            runjs("scripts/canoe_test.js", "beginExecution")
        }
    }
    stage("汇总 CANoe 执行结果") {
        timeout(120000)
        steps {
            runjs("scripts/canoe_test.js", "summarizeExecution")
        }
    }
}
post {
    always {
        stage("补收 CANoe 测试报告") {
            timeout(600000)
            steps {
                runjs("scripts/canoe_test.js", "collectArtifacts")
            }
        }
        runjs("scripts/canoe_test.js", "cleanup")
    }
}
