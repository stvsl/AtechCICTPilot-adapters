stages {
    stage("准备测试工作区") {
        timeout(30000)
        steps {
            runjs("scripts/hello_world.js", "prepareWorkspace")
        }
    }
    stage("校验测试参数") {
        timeout(30000)
        steps {
            runjs("scripts/hello_world.js", "validateInput", env.WAIT_DURATION_SECONDS, env.TEST_CASE_COUNT, env.TEST_CASE_DURATION_MS)
        }
    }
    stage("执行 Hello World") {
        timeout(660000)
        steps {
            runjs("scripts/hello_world.js", "helloWorld")
        }
    }
    stage("验证执行结果") {
        timeout(30000)
        steps {
            runjs("scripts/hello_world.js", "verifyResult")
        }
    }
    stage("发布测试报告") {
        timeout(30000)
        steps {
            runjs("scripts/hello_world.js", "publishReport")
        }
    }
}
post {
    always {
        runjs("scripts/hello_world.js", "cleanup")
    }
}
