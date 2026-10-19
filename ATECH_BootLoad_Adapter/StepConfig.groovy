stages {
    stage("刷写") {
        timeout(3000000)
        steps {
            runjs("scripts/entry.js", "run")
        }
    }
}
post {
    always {
        runjs("scripts/entry.js", "cleanup")
    }
}
