stages {
    stage("创建首个动态阶段") {
        timeout(30000)
        steps {
            runjs("scripts/dynamic_stage_test.js", "seedStages")
        }
    }
    stage("验证动态流程结果") {
        timeout(30000)
        steps {
            runjs("scripts/dynamic_stage_test.js", "verifyStages")
        }
    }
}
post {
    always {
        stage("发布动态流程测试报告") {
            timeout(30000)
            steps {
                runjs("scripts/dynamic_stage_test.js", "publishReport")
            }
        }
        stage("清理动态流程测试状态") {
            timeout(30000)
            steps {
                runjs("scripts/dynamic_stage_test.js", "cleanup")
            }
        }
    }
}
