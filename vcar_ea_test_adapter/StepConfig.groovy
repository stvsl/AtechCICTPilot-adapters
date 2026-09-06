stages {
    stage("启动VCAR EA") {
        timeout(30000)
        steps {
            runjs("scripts/test.js", "startVcarEA")
        }
    }
}
post {
    always {
        runjs("scripts/test.js", "cleanup")
    }
}
